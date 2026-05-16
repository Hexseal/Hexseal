'use client';

/**
 * XP system — computed from Registry AgreementStatus enum:
 *   0 = ACTIVE (in progress)
 *   1 = COMPLETED (success, payment released)
 *   2 = REFUNDED (failed / refunded to client)
 *   3 = DISPUTED (under arbitration)
 *   4 = RESOLVED (arbiter closed the dispute)
 *
 * NOTE: This is NOT the same as Agreement.sol's internal Status enum.
 * The RegistryFacet stores a compressed 5-state enum in AgreementRecord.
 */

export const REG_STATUS = {
  ACTIVE:    0,
  COMPLETED: 1,
  REFUNDED:  2,
  DISPUTED:  3,
  RESOLVED:  4,
} as const;

type DealRecord = { amount: bigint; status: number };

/**
 * Computes XP from a user's deal history.
 *
 * +100 per completed deal (COMPLETED or RESOLVED — both are successful outcomes)
 * +1 per $10 USDC total volume, capped at 300 XP (prevents a single whale deal
 *   from instantly reaching Master — you still need to close real deals)
 * -30 per refunded deal (penalty for deals that fell through)
 */
export function calcXP(deals: DealRecord[]): number {
  const wins     = deals.filter(d => d.status === REG_STATUS.COMPLETED || d.status === REG_STATUS.RESOLVED).length;
  const refunded = deals.filter(d => d.status === REG_STATUS.REFUNDED).length;
  const volume   = deals.reduce((s, d) => s + Number(d.amount), 0);
  const volumeXP = Math.min(Math.floor(volume / 10_000_000), 300); // $10 USDC = 1 XP, max 300
  return Math.max(0, wins * 100 + volumeXP - refunded * 30);
}

/**
 * Completion rate — what % of closed deals were successful (not refunded).
 */
export function calcCompletionRate(deals: DealRecord[]): number {
  const closed    = deals.filter(d => d.status !== REG_STATUS.ACTIVE && d.status !== REG_STATUS.DISPUTED).length;
  const completed = deals.filter(d => d.status === REG_STATUS.COMPLETED || d.status === REG_STATUS.RESOLVED).length;
  return closed > 0 ? Math.round((completed / closed) * 100) : 100;
}
