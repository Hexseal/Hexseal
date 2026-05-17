'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useReadContract } from 'wagmi';
import { isAddress, zeroAddress } from 'viem';
import type { Abi } from 'viem';
import { DIAMOND_ABI, CONTRACTS, AGREEMENT_STATUS, STATUS_LABELS } from '@/config/contracts';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, ArrowRight, Loader2 } from 'lucide-react';

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmt(amount: bigint) {
  return (Number(amount) / 1e6).toFixed(2);
}

const STATUS_DOT: Record<number, string> = {
  [AGREEMENT_STATUS.ACTIVE]:    'bg-violet-400',
  [AGREEMENT_STATUS.COMPLETED]: 'bg-emerald-400',
  [AGREEMENT_STATUS.REFUNDED]:  'bg-white/30',
  [AGREEMENT_STATUS.DISPUTED]:  'bg-orange-400',
  [AGREEMENT_STATUS.RESOLVED]:  'bg-blue-400',
};

export function DealSearch() {
  const [input, setInput]       = useState('');
  const [query, setQuery]       = useState('');
  const [error, setError]       = useState('');

  const validQuery = isAddress(query);

  const { data: record, isLoading, isFetched } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getRecord',
    args: validQuery ? [query] : undefined,
    query: { enabled: validQuery },
  }) as { data: { agreement: string; client: string; executor: string; amount: bigint; status: number } | undefined; isLoading: boolean; isFetched: boolean };

  const notFound = isFetched && validQuery && (!record || record.agreement === zeroAddress);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const val = input.trim();
    if (!isAddress(val)) {
      setError('Enter a valid agreement address (0x…)');
      return;
    }
    setError('');
    setQuery(val);
  }

  return (
    <div className="rounded-[20px] border border-white/[0.08] bg-[#0d0d0f] px-4 py-3" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
      <form onSubmit={handleSearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/25 pointer-events-none" />
          <Input
            value={input}
            onChange={e => { setInput(e.target.value); setError(''); }}
            placeholder="Find deal by address…"
            className="pl-9 h-9 bg-[#0d0d0f] border-white/[0.08] text-sm placeholder:text-white/20 focus:border-white/25"
          />
        </div>
        <Button type="submit" size="sm" variant="outline" className="h-9 px-3 border-white/15 text-white/60 hover:text-white">
          Search
        </Button>
      </form>

      {error && (
        <p className="mt-2 text-xs text-red-400/80">{error}</p>
      )}

      {isLoading && (
        <div className="mt-3 flex items-center gap-2 text-white/40 text-sm">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>Looking up…</span>
        </div>
      )}

      {notFound && (
        <p className="mt-2 text-xs text-white/35">No deal found at this address.</p>
      )}

      {!isLoading && record && record.agreement !== zeroAddress && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-[14px] bg-[#0d0d0f] border border-white/[0.07] px-3 py-2">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[record.status] ?? 'bg-white/20'}`} />
              <span className="text-xs font-semibold text-white/70">
                {STATUS_LABELS[record.status] ?? `Status ${record.status}`}
              </span>
              <span className="text-xs font-mono text-white/50">{fmt(record.amount)} USDC</span>
            </div>
            <div className="text-xs text-white/35 font-mono truncate">
              {short(record.client)} → {short(record.executor)}
            </div>
          </div>
          <Link href={`/deal/${record.agreement}`}>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-white/50 hover:text-white gap-1 flex-shrink-0">
              Open <ArrowRight className="w-3 h-3" />
            </Button>
          </Link>
        </div>
      )}
    </div>
  );
}
