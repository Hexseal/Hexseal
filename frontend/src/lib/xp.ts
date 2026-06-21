'use client';

// Subgraph indexes Agreement.sol's internal 7-state enum (set by on-chain events).
// These must match subgraph/src/agreement.ts handler assignments.
export const AGMT = {
  CREATED:   0,
  FUNDED:    1,
  ACTIVE:    2,
  COMPLETED: 3, // Released or AutoApproved
  DISPUTED:  4,
  RESOLVED:  5, // DisputeResolved
  REFUNDED:  6, // TimedOut or ArbiterTimedOut
} as const;

// Anti-gaming: win XP requires deal >= $10 USDC, capped at 3 wins per unique counterparty pair
const MIN_WIN_AMOUNT    = 10_000_000n; // 10 USDC (6 decimals)
const MAX_WINS_PER_PAIR = 3;

type DealRecord = { amount: bigint; status: number; pairKey?: string };

// +100 per qualifying win, +1 per $10 USDC volume (capped 300), -30 per refund
export function calcXP(deals: DealRecord[]): number {
  const pairWins = new Map<string, number>();
  let wins = 0;

  for (const d of deals) {
    if (d.status !== AGMT.COMPLETED && d.status !== AGMT.RESOLVED) continue;
    if (BigInt(d.amount) < MIN_WIN_AMOUNT) continue;
    if (d.pairKey !== undefined) {
      const count = pairWins.get(d.pairKey) ?? 0;
      if (count >= MAX_WINS_PER_PAIR) continue;
      pairWins.set(d.pairKey, count + 1);
    }
    wins++;
  }

  const refunded = deals.filter(d => d.status === AGMT.REFUNDED).length;
  const volume   = deals.reduce((s, d) => s + Number(d.amount), 0);
  const volumeXP = Math.min(Math.floor(volume / 10_000_000), 300);
  return Math.max(0, wins * 100 + volumeXP - refunded * 30);
}

export function calcCompletionRate(deals: DealRecord[]): number {
  const closed    = deals.filter(d => d.status === AGMT.COMPLETED || d.status === AGMT.RESOLVED || d.status === AGMT.REFUNDED).length;
  const completed = deals.filter(d => d.status === AGMT.COMPLETED || d.status === AGMT.RESOLVED).length;
  return closed > 0 ? Math.round((completed / closed) * 100) : 100;
}
