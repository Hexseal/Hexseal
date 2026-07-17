import { useMemo } from 'react';
import { useReadContract } from 'wagmi';
import { REPUTATION_ABI, CONTRACTS } from '@/config/contracts';
import { useMyAgreements, type GraphAgreement } from '@/hooks/useMyAgreements';
import { useAgreementTitles } from '@/hooks/useAgreementTitles';
import type { AgreementRecord } from '@/components/DealCard';

// pct = progress within current tier (0–100). Minimum 3 so bar is always visible once unlocked.
export function xpLevel(xp: number) {
  const p = (v: number) => Math.max(3, Math.min(100, Math.round(v)));
  if (xp >= 1000) return { labelKey: 'xp_level.master',   color: 'text-yellow-400',  bar: 'bg-yellow-400',  pct: 100 };
  if (xp >= 500)  return { labelKey: 'xp_level.expert',   color: 'text-violet-400',  bar: 'bg-violet-400',  pct: p((xp - 500) / 5) };
  if (xp >= 200)  return { labelKey: 'xp_level.trusted',  color: 'text-blue-400',    bar: 'bg-blue-400',    pct: p((xp - 200) / 3) };
  if (xp >= 50)   return { labelKey: 'xp_level.rising',   color: 'text-emerald-400', bar: 'bg-emerald-400', pct: p((xp - 50) / 1.5) };
  return               { labelKey: 'xp_level.newcomer', color: 'text-white/40',    bar: 'bg-white/20',    pct: Math.round(xp / 0.5) };
}

export function fmtVolume(microUsdc: number): string {
  const v = microUsdc / 1e6;
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}K`;
  if (v >= 1)    return `$${Math.round(v)}`;
  if (v > 0)     return `$${v.toFixed(2)}`;
  return '$0';
}

function toAgreementRecord(a: GraphAgreement): AgreementRecord {
  return {
    agreement: a.id,
    client: a.client,
    executor: a.executor,
    amount: BigInt(a.amount),
    status: a.status,
    createdAt: BigInt(a.createdAt),
    resolvedAt: a.resolvedAt ? BigInt(a.resolvedAt) : BigInt(0),
    clientWon: a.clientWon,
  };
}

/**
 * Shared by /dashboard and /profile/[address] — both render the same stats
 * row, XP bar and deal list for a given address. One fetch + derivation path
 * so the two pages can't compute activeDeals/historyDeals/xp differently.
 */
export function useAgreementsSummary(address: string | undefined) {
  const { agreements: rawAgreements, isLoading, refetch } = useMyAgreements(address);
  const titleMap = useAgreementTitles(rawAgreements);
  const allAgreements = useMemo(
    () => rawAgreements.map(a => ({ ...toAgreementRecord(a), title: titleMap.get(a.id.toLowerCase()) })),
    [rawAgreements, titleMap],
  );

  const { data: onchainXP } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: REPUTATION_ABI,
    functionName: 'getXP',
    args: address ? [address as `0x${string}`] : undefined,
    query: { enabled: !!address },
  });
  const xp = Number(onchainXP ?? 0n);
  const level = xpLevel(xp);

  // status: 0=Created 1=Funded 2=Active 3=Completed 4=Disputed 5=Resolved 6=Refunded
  const activeDeals  = allAgreements.filter(d => [0, 1, 2, 4].includes(d.status));
  const historyDeals = allAgreements.filter(d => [3, 5, 6].includes(d.status));
  // "Completed" = deals that went well for *this* viewer. A plain release (status 3) always
  // counts; a RESOLVED dispute (status 5) only counts if the viewer's side won it — otherwise
  // an executor who lost a dispute (client refunded) would see it inflate their success count.
  const addrLower = address?.toLowerCase();
  const completed = allAgreements.filter(d => {
    if (d.status === 3) return true;
    if (d.status === 5 && d.clientWon !== null && d.clientWon !== undefined) {
      const isClient = addrLower === d.client.toLowerCase();
      return isClient ? d.clientWon : !d.clientWon;
    }
    return false;
  }).length;
  const totalVolume  = allAgreements.reduce((s, d) => s + Number(d.amount), 0);

  return { rawAgreements, isLoading, refetch, xp, level, activeDeals, historyDeals, completed, totalVolume };
}
