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

type DealRecord = { amount: bigint; status: number; pairKey?: string };

export function calcCompletionRate(deals: DealRecord[]): number {
  const closed    = deals.filter(d => d.status === AGMT.COMPLETED || d.status === AGMT.RESOLVED || d.status === AGMT.REFUNDED).length;
  const completed = deals.filter(d => d.status === AGMT.COMPLETED || d.status === AGMT.RESOLVED).length;
  return closed > 0 ? Math.round((completed / closed) * 100) : 100;
}
