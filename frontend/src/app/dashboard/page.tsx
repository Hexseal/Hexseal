'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useAccount, useReadContract } from 'wagmi';
import type { Abi } from 'viem';
import { DIAMOND_ABI, CONTRACTS } from '@/config/contracts';
import { Button } from '@/components/ui/button';
import {
  Loader2, Activity, RefreshCw, ChevronDown, Briefcase, User, Plus,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { MessagingSetup } from '@/components/MessagingSetup';
import { DealSearch } from '@/components/DealSearch';
import { DealCard, type AgreementRecord } from './components/DealCard';
import { MyJobs, MyServices, MyClientRequests, MyJobReceipts } from './components/MyListings';

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
function calcXP(deals: AgreementRecord[]): number {
  const completed = deals.filter(d => d.status === 1 || d.status === 4).length;
  const refunded  = deals.filter(d => d.status === 2).length;
  const volume    = deals.reduce((s, d) => s + Number(d.amount), 0);
  return Math.max(0, completed * 100 + Math.floor(volume / 10_000_000) - refunded * 25);
}
function xpLevel(xp: number): { label: string; badge: string } {
  if (xp >= 1000) return { label: 'Master',   badge: 'bg-yellow-400/10 border-yellow-400/20 text-yellow-400' };
  if (xp >= 500)  return { label: 'Expert',   badge: 'bg-violet-400/10 border-violet-400/20 text-violet-400' };
  if (xp >= 200)  return { label: 'Trusted',  badge: 'bg-blue-400/10 border-blue-400/20 text-blue-400'       };
  if (xp >= 50)   return { label: 'Rising',   badge: 'bg-emerald-400/10 border-emerald-400/20 text-emerald-400' };
  return               { label: 'Newcomer', badge: 'bg-white/5 border-white/10 text-white/40'               };
}

function DashSection({ dot, label, count, children }: {
  dot: string; label: string; count?: number; children: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} />
        <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">
          {label}{count !== undefined ? ` · ${count}` : ''}
        </span>
      </div>
      {children}
    </div>
  );
}

export default function DashboardPage() {
  const { address, isConnected } = useAccount();
  const [refreshKey, setRefreshKey] = useState(0);
  const [showHistory, setShowHistory] = useState(false);

  const { data: clientAgreements,   isLoading: isLoadingClient,   refetch: refetchClient   } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`, abi: DIAMOND_ABI as Abi,
    functionName: 'getByClient', args: address ? [address] : undefined,
    query: { enabled: !!address },
  }) as { data: AgreementRecord[] | undefined; isLoading: boolean; refetch: () => void };

  const { data: executorAgreements, isLoading: isLoadingExecutor, refetch: refetchExecutor } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`, abi: DIAMOND_ABI as Abi,
    functionName: 'getByExecutor', args: address ? [address] : undefined,
    query: { enabled: !!address },
  }) as { data: AgreementRecord[] | undefined; isLoading: boolean; refetch: () => void };

  const allAgreements = (() => {
    const map = new Map<string, AgreementRecord>();
    [...(clientAgreements || []), ...(executorAgreements || [])].forEach(a =>
      map.set(a.agreement.toLowerCase(), a)
    );
    return Array.from(map.values());
  })();

  const isLoading = isLoadingClient || isLoadingExecutor;

  const refetch = () => {
    refetchClient();
    refetchExecutor();
    setRefreshKey(k => k + 1);
  };

  // Registry enum: 0=ACTIVE 1=COMPLETED 2=REFUNDED 3=DISPUTED 4=RESOLVED
  const activeDeals  = allAgreements.filter(d => d.status === 0 || d.status === 3);
  const historyDeals = allAgreements.filter(d => d.status !== 0 && d.status !== 3);
  const completed    = allAgreements.filter(d => d.status === 1 || d.status === 4).length;
  const totalVolume  = allAgreements.reduce((s, d) => s + Number(d.amount), 0);
  const xp           = calcXP(allAgreements);
  const level        = xpLevel(xp);

  if (!isConnected) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center max-w-sm px-4">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-6">
            <Activity className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-bold font-syne mb-2">Dashboard</h1>
          <p className="text-muted-foreground text-sm mb-6">Connect your wallet to view your deals</p>
          <Link href="/"><Button variant="outline">Go Home</Button></Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">

      {/* ── Profile bar ── */}
      <div className="border-b border-white/8 bg-white/[0.02]">
        <div className="container mx-auto px-4 py-4 max-w-4xl">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center flex-shrink-0">
              <User className="w-5 h-5 text-white/25" />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold font-mono text-white">{shortAddr(address!)}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${level.badge}`}>
                  {level.label}
                </span>
                <span className="text-xs text-white/30 font-mono">{xp} XP</span>
              </div>
              {!isLoading && allAgreements.length > 0 && (
                <div className="flex items-center gap-3 mt-1 text-xs text-white/35">
                  <span><span className="text-white/60 font-mono">{activeDeals.length}</span> active</span>
                  <span><span className="text-white/60 font-mono">{completed}</span> completed</span>
                  <span><span className="text-white/60 font-mono">${(totalVolume / 1e6).toFixed(0)}</span> USDC</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              <Button
                variant="ghost" size="sm" onClick={refetch} disabled={isLoading}
                className="text-white/40 hover:text-white/70 h-8 w-8 p-0"
              >
                <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" className="gap-1.5">
                    <Plus className="w-3.5 h-3.5" />Post
                    <ChevronDown className="w-3 h-3 opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[180px]">
                  <DropdownMenuItem asChild>
                    <Link href="/board/client/post" className="flex items-center gap-2">
                      <Briefcase className="w-3.5 h-3.5" />Post a Job
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link href="/board/executor/post" className="flex items-center gap-2">
                      <User className="w-3.5 h-3.5" />Offer a Service
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div className="container mx-auto px-4 py-5 max-w-4xl space-y-6">

        <MessagingSetup />

        <DealSearch />

        {isLoading ? (
          <div className="flex items-center justify-center py-16 gap-2 text-white/30">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : (
          <>
            {/* Active & Disputed Deals */}
            {activeDeals.length > 0 && (
              <DashSection dot="bg-violet-400" label="Active Deals" count={activeDeals.length}>
                <div className="space-y-2">
                  {activeDeals.map(a => (
                    <DealCard
                      key={`${a.agreement}-${refreshKey}`}
                      agreement={a}
                      address={address!}
                      refetch={refetch}
                    />
                  ))}
                </div>
              </DashSection>
            )}

            {/* Job Postings (as client) */}
            <DashSection dot="bg-sky-400" label="Job Postings">
              <MyJobs address={address!} onDealCreated={refetch} />
            </DashSection>

            {/* Job Receipt NFTs (soulbound proof of posted jobs) */}
            <DashSection dot="bg-sky-400/40" label="Job Receipts">
              <MyJobReceipts address={address!} />
            </DashSection>

            {/* Outgoing service requests (as client) */}
            <DashSection dot="bg-indigo-400" label="Service Requests">
              <MyClientRequests address={address!} />
            </DashSection>

            {/* My service listings (as executor) */}
            <DashSection dot="bg-emerald-400" label="My Services">
              <MyServices address={address!} onDealCreated={refetch} />
            </DashSection>

            {/* History */}
            {historyDeals.length > 0 && (
              <div>
                <button
                  onClick={() => setShowHistory(v => !v)}
                  className="flex items-center gap-2 group w-full text-left py-1"
                >
                  <div className="w-1.5 h-1.5 rounded-full bg-white/20 flex-shrink-0" />
                  <span className="text-xs font-semibold text-white/35 uppercase tracking-wider group-hover:text-white/55 transition-colors">
                    History · {historyDeals.length}
                  </span>
                  <ChevronDown className={`w-3 h-3 text-white/25 ml-0.5 transition-transform group-hover:text-white/50 ${showHistory ? 'rotate-180' : ''}`} />
                </button>
                {showHistory && (
                  <div className="space-y-2 mt-3 opacity-70">
                    {historyDeals.map(a => (
                      <DealCard
                        key={`${a.agreement}-hist-${refreshKey}`}
                        agreement={a}
                        address={address!}
                        refetch={refetch}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
