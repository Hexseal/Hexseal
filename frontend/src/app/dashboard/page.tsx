'use client';

import { useState, useMemo, type ReactNode } from 'react';
import Link from 'next/link';
import { useAccount, useReadContract } from 'wagmi';
import { DIAMOND_ABI, REPUTATION_ABI, CONTRACTS } from '@/config/contracts';
import { useMyAgreements, type GraphAgreement } from '@/hooks/useMyAgreements';
import { useAgreementTitles } from '@/hooks/useAgreementTitles';
import {
  Loader2, Activity, CheckCircle,
  DollarSign, Star, Zap,
} from 'lucide-react';
import { DashboardSearch } from '@/components/DashboardSearch';
import { DealCard, type AgreementRecord } from './components/DealCard';
import { MyJobs, MyServices, MyClientRequests } from './components/MyListings';
import { useTranslations } from 'next-intl';
import { useMyJobs } from '@/hooks/useMyJobs';
import { useMyServices } from '@/hooks/useMyServices';
import { motion, AnimatePresence } from 'framer-motion';
import { PageCenter } from "@/components/PageCenter";

function xpLevel(xp: number) {
  // pct = progress within current tier (0–100). Minimum 3 so bar is always visible once unlocked.
  const p = (v: number) => Math.max(3, Math.min(100, Math.round(v)));
  if (xp >= 1000) return { label: 'Master',   color: 'text-yellow-400',  bar: 'bg-yellow-400',  pct: 100 };
  if (xp >= 500)  return { label: 'Expert',   color: 'text-violet-400',  bar: 'bg-violet-400',  pct: p((xp - 500) / 5) };
  if (xp >= 200)  return { label: 'Trusted',  color: 'text-blue-400',    bar: 'bg-blue-400',    pct: p((xp - 200) / 3) };
  if (xp >= 50)   return { label: 'Rising',   color: 'text-emerald-400', bar: 'bg-emerald-400', pct: p((xp - 50) / 1.5) };
  return               { label: 'Newcomer', color: 'text-white/40',    bar: 'bg-white/20',    pct: Math.round(xp / 0.5) };
}

function fmtVolume(microUsdc: number): string {
  const v = microUsdc / 1e6;
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}K`;
  if (v >= 1)    return `$${Math.round(v)}`;
  if (v > 0)     return `$${v.toFixed(2)}`;
  return '$0';
}

// ─── Stat card skeleton — CSS animate-pulse, zero JS ─────────────────────────

function StatCardSkeleton({ index = 0 }: { index?: number }) {
  return (
    <div
      className="animate-pulse rounded-[20px] border border-white/[0.08] bg-[#0d0d0f] px-4 py-3 flex items-center gap-3"
      style={{ animationDelay: `${index * 0.05}s` }}
    >
      <div className="w-9 h-9 rounded-[12px] bg-white/[0.06] flex-shrink-0" />
      <div className="min-w-0 space-y-2">
        <div className="h-2.5 w-16 rounded bg-white/[0.06]" />
        <div className="h-5 w-10 rounded bg-white/[0.08]" />
        <div className="h-2 w-12 rounded bg-white/[0.04]" />
      </div>
    </div>
  );
}

// ─── Stat card — tween entrance, no hover/tap springs ────────────────────────

function StatCard({ icon, label, value, sub, index = 0 }: {
  icon: ReactNode; label: string; value: string | number; sub?: string; index?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay: index * 0.07, type: 'tween', duration: 0.25, ease: 'easeOut' }}
      className="rounded-[20px] border border-white/[0.08] bg-[#0d0d0f] px-4 py-3 flex items-center gap-3 cursor-default"
      style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}
    >
      <motion.div
        className="w-9 h-9 rounded-[12px] bg-white/[0.06] flex items-center justify-center flex-shrink-0"
        initial={{ rotate: -10, scale: 0.8 }}
        animate={{ rotate: 0, scale: 1 }}
        transition={{ delay: index * 0.07 + 0.08, type: 'tween', duration: 0.2, ease: 'easeOut' }}
      >
        {icon}
      </motion.div>
      <div className="min-w-0">
        <p className="text-xs text-white/35 leading-none mb-1">{label}</p>
        <p className="text-lg font-bold text-white leading-none">{value}</p>
        {sub && <p className="text-[11px] text-white/30 mt-0.5">{sub}</p>}
      </div>
    </motion.div>
  );
}

// ─── Tab button ───────────────────────────────────────────────────────────────

function Tab({ active, onClick, children, count }: {
  active: boolean; onClick: () => void; children: ReactNode; count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative px-4 py-2 text-sm font-medium rounded-[10px] flex items-center gap-1.5 flex-shrink-0 transition-all duration-200 ${
        active ? 'text-white bg-white/10' : 'text-white/40 hover:text-white/60 hover:bg-white/[0.05]'
      }`}
    >
      {count !== undefined && count > 0 && (
        <span className={`text-[11px] px-1.5 py-0.5 rounded-md font-mono transition-colors duration-200 ${
          active ? 'bg-white/15 text-white/80' : 'bg-white/[0.06] text-white/35'
        }`}>
          {count}
        </span>
      )}
      {children}
    </button>
  );
}


// ─── Page ─────────────────────────────────────────────────────────────────────

type TabKey = 'listings' | 'deals' | 'history';
type ListingsSub = 'jobs' | 'services' | 'requests';

function toAgreementRecord(a: GraphAgreement): AgreementRecord {
  return {
    agreement: a.id,
    client: a.client,
    executor: a.executor,
    amount: BigInt(a.amount),
    status: a.status,
    createdAt: BigInt(a.createdAt),
    resolvedAt: a.resolvedAt ? BigInt(a.resolvedAt) : BigInt(0),
  };
}

export default function DashboardPage() {
  const { address, isConnected, status } = useAccount();
  const [tab, setTab] = useState<TabKey>('listings');
  const [listingsSub, setListingsSub] = useState<ListingsSub>('jobs');
  const t = useTranslations();

  const { agreements: rawAgreements, isLoading } = useMyAgreements(address);
  const { jobs: mySearchJobs }     = useMyJobs(address);
  const { services: mySearchSvcs } = useMyServices(address);
  const titleMap = useAgreementTitles(address);
  const allAgreements = useMemo(
    () => rawAgreements.map(a => ({ ...toAgreementRecord(a), title: titleMap.get(a.id.toLowerCase()) })),
    [rawAgreements, titleMap],
  );
  const refetch = () => {};

  const { data: onchainXP } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: REPUTATION_ABI,
    functionName: 'getXP',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });
  const xp = Number(onchainXP ?? 0n);

  // status: 0=Created 1=Funded 2=Active 3=Completed 4=Disputed 5=Resolved 6=Refunded
  const activeDeals  = allAgreements.filter(d => [0, 1, 2, 4].includes(d.status));
  const historyDeals = allAgreements.filter(d => [3, 5, 6].includes(d.status));
  const completed    = allAgreements.filter(d => d.status === 3 || d.status === 5).length;
  const totalVolume  = allAgreements.reduce((s, d) => s + Number(d.amount), 0);
  const level        = xpLevel(xp);

  if (status === 'reconnecting' || status === 'connecting') {
    return (
      <div className="mx-auto px-4 py-5 max-w-6xl space-y-4 overflow-x-hidden w-full">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map(i => <StatCardSkeleton key={i} index={i} />)}
        </div>
        <div className="animate-pulse rounded-[20px] border border-white/[0.08] bg-[#0d0d0f] px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <div className="h-3 w-16 rounded bg-white/[0.06]" />
            <div className="h-3 w-10 rounded bg-white/[0.06]" />
          </div>
          <div className="h-1.5 rounded-full bg-white/[0.06]" />
        </div>
        <div className="animate-pulse h-9 rounded-[12px] bg-white/[0.04] w-full" />
        <div className="flex gap-1">
          {[0, 1, 2].map(i => <div key={i} className="animate-pulse h-9 w-24 rounded-[10px] bg-white/[0.04]" />)}
        </div>
        <div className="space-y-3">
          {[0, 1, 2].map(i => (
            <div key={i} className="animate-pulse rounded-[20px] border border-white/[0.06] bg-[#0d0d0f] h-[72px]" style={{ animationDelay: `${i * 0.05}s` }} />
          ))}
        </div>
      </div>
    );
  }

  if (!isConnected) {
    return (
      <PageCenter>
        <div className="text-center max-w-sm">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-6">
            <Activity className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-bold font-syne mb-2">{t("dashboard.title")}</h1>
          <p className="text-muted-foreground text-sm mb-6">{t("dashboard.connect_prompt")}</p>
          <Link href="/"><button className="border border-white/15 rounded-lg px-4 py-2 text-sm text-white/60 hover:text-white hover:border-white/30 transition-colors">{t("dashboard.go_home")}</button></Link>
        </div>
      </PageCenter>
    );
  }

  return (
    <div className="mx-auto px-4 py-5 max-w-6xl space-y-4 overflow-x-hidden w-full">

        {/* ── Stats row ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {isLoading ? (
            [0, 1, 2, 3].map(i => <StatCardSkeleton key={i} index={i} />)
          ) : (
            <>
              <StatCard index={0} icon={<Zap className="w-4 h-4 text-violet-400" />} label={t("dashboard.stat_level")} value={level.label} sub={`${xp} XP`} />
              <StatCard index={1} icon={<Activity className="w-4 h-4 text-sky-400" />} label={t("dashboard.stat_active")} value={activeDeals.length} sub={activeDeals.length === 1 ? t("dashboard.stat_deal") : t("dashboard.stat_deals")} />
              <StatCard index={2} icon={<CheckCircle className="w-4 h-4 text-emerald-400" />} label={t("dashboard.stat_completed")} value={completed} sub={completed === 1 ? t("dashboard.stat_deal") : t("dashboard.stat_deals")} />
              <StatCard index={3} icon={<DollarSign className="w-4 h-4 text-amber-400" />} label={t("dashboard.stat_volume")} value={fmtVolume(totalVolume)} sub={t("dashboard.stat_usdc_total")} />
            </>
          )}
        </div>

        {/* ── XP progress bar ── */}
        {isLoading ? (
          <div className="animate-pulse rounded-[20px] border border-white/[0.08] bg-[#0d0d0f] px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <div className="h-3 w-16 rounded bg-white/[0.06]" />
              <div className="h-3 w-10 rounded bg-white/[0.06]" />
            </div>
            <div className="h-1.5 rounded-full bg-white/[0.06]" />
          </div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, type: 'tween', duration: 0.25, ease: 'easeOut' }}
            className="rounded-[20px] border border-white/[0.08] bg-[#0d0d0f] px-4 py-3"
            style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Star className="w-3.5 h-3.5 text-white/30" />
                <span className={`text-xs font-semibold ${level.color}`}>{level.label}</span>
              </div>
              <span className="text-xs font-mono text-white/30">{xp} XP</span>
            </div>
            <div className="h-1.5 rounded-full bg-white/8 overflow-hidden">
              <motion.div
                className={`h-full rounded-full origin-left ${level.bar}`}
                initial={{ scaleX: 0 }}
                animate={{ scaleX: Math.min(100, level.pct) / 100 }}
                transition={{ delay: 0.4, type: 'tween', duration: 0.6, ease: [0.25, 1, 0.5, 1] }}
              />
            </div>
          </motion.div>
        )}

        {/* ── Unified search ── */}
        <DashboardSearch
          agreements={rawAgreements}
          jobs={mySearchJobs}
          services={mySearchSvcs}
        />

        {/* ── Tabs ── */}
        <div>
          <div className="flex gap-1 overflow-x-auto scrollbar-none mb-4">
            <Tab active={tab === 'listings'} onClick={() => setTab('listings')}>
              {t("dashboard.tabs.listings")}
            </Tab>
            <Tab active={tab === 'deals'} onClick={() => setTab('deals')} count={activeDeals.length}>
              {t("dashboard.tabs.deals")}
            </Tab>
            <Tab active={tab === 'history'} onClick={() => setTab('history')} count={historyDeals.length}>
              {t("dashboard.tabs.history")}
            </Tab>
          </div>

          {isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2].map(i => (
                <div
                  key={i}
                  className="animate-pulse rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] h-[72px]"
                  style={{ animationDelay: `${i * 0.1}s` }}
                />
              ))}
            </div>
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={{ type: 'tween', duration: 0.15, ease: 'easeOut' }}
              >
                {tab === 'listings' && (
                  <div>
                    <div className="flex border-b border-white/[0.07] mb-5 -mx-0.5">
                      {([
                        ['jobs',     t('dashboard.section_job_postings')],
                        ['services', t('nav.services')],
                        ['requests', t('dashboard.section_service_requests')],
                      ] as [ListingsSub, string][]).map(([key, label]) => (
                        <button
                          key={key}
                          onClick={() => setListingsSub(key)}
                          className={`px-3 pb-2.5 text-[11px] font-semibold tracking-widest uppercase border-b-2 -mb-px transition-colors ${
                            listingsSub === key
                              ? 'border-white/40 text-white/70'
                              : 'border-transparent text-white/25 hover:text-white/45'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.div
                        key={listingsSub}
                        initial={{ opacity: 0, y: 5 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -3 }}
                        transition={{ type: 'tween', duration: 0.13 }}
                      >
                        {listingsSub === 'jobs'     && <MyJobs address={address!} onDealCreated={refetch} />}
                        {listingsSub === 'services' && <MyServices address={address!} onDealCreated={refetch} />}
                        {listingsSub === 'requests' && <MyClientRequests address={address!} />}
                      </motion.div>
                    </AnimatePresence>
                  </div>
                )}

                {tab === 'deals' && (
                  <>
                    {activeDeals.length === 0 ? (
                      <div className="text-center py-10">
                        <div className="float-icon">
                          <Activity className="w-8 h-8 text-white/10 mx-auto mb-3" />
                        </div>
                        <p className="text-sm text-white/30">{t("dashboard.empty_active")}</p>
                        <p className="text-xs text-white/20 mt-1">{t("dashboard.empty_active_hint")}</p>
                      </div>
                    ) : (
                    <div className="space-y-3">
                      {activeDeals.map((a, index) => (
                        <div
                          key={a.agreement}
                          className="card-enter active:scale-[0.985] transition-transform duration-100 cursor-pointer"
                          style={{ animationDelay: `${Math.min(index, 5) * 0.06}s` }}
                        >
                          <DealCard agreement={a} address={address!} refetch={refetch} />
                        </div>
                      ))}
                    </div>
                    )}
                  </>
                )}

                {tab === 'history' && (
                  historyDeals.length === 0 ? (
                    <div className="text-center py-10">
                      <div className="float-icon">
                        <CheckCircle className="w-8 h-8 text-white/10 mx-auto mb-3" />
                      </div>
                      <p className="text-sm text-white/30">{t("dashboard.empty_history")}</p>
                    </div>
                  ) : (
                    <div className="space-y-2 opacity-80">
                      {historyDeals.map((a, index) => (
                        <div
                          key={`${a.agreement}-hist`}
                          className="card-enter active:scale-[0.985] transition-transform duration-100 cursor-pointer"
                          style={{ animationDelay: `${Math.min(index, 5) * 0.06}s` }}
                        >
                          <DealCard agreement={a} address={address!} refetch={refetch} />
                        </div>
                      ))}
                    </div>
                  )
                )}
              </motion.div>
            </AnimatePresence>
          )}
        </div>
      </div>
  );
}
