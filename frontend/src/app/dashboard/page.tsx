'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useAccount, useReadContract } from 'wagmi';
import type { Abi } from 'viem';
import { DIAMOND_ABI, CONTRACTS } from '@/config/contracts';
import {
  Loader2, Activity, CheckCircle,
  DollarSign, Star, Zap,
} from 'lucide-react';
import { MessagingSetup } from '@/components/MessagingSetup';
import { DealSearch } from '@/components/DealSearch';
import { DealCard, type AgreementRecord } from './components/DealCard';
import { MyJobs, MyServices, MyClientRequests } from './components/MyListings';
import { useTranslations } from 'next-intl';
import { calcXP } from '@/lib/xp';
import { motion, AnimatePresence } from 'framer-motion';

function xpLevel(xp: number) {
  if (xp >= 1000) return { label: 'Master',   color: 'text-yellow-400',  bar: 'bg-yellow-400',  pct: 100 };
  if (xp >= 500)  return { label: 'Expert',   color: 'text-violet-400',  bar: 'bg-violet-400',  pct: Math.round((xp - 500) / 5) };
  if (xp >= 200)  return { label: 'Trusted',  color: 'text-blue-400',    bar: 'bg-blue-400',    pct: Math.round((xp - 200) / 3) };
  if (xp >= 50)   return { label: 'Rising',   color: 'text-emerald-400', bar: 'bg-emerald-400', pct: Math.round((xp - 50) / 1.5) };
  return               { label: 'Newcomer', color: 'text-white/40',    bar: 'bg-white/20',    pct: Math.round(xp / 0.5) };
}

// ─── Stat card skeleton ───────────────────────────────────────────────────────

function StatCardSkeleton({ index = 0 }: { index?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: [0.4, 0.7, 0.4] }}
      transition={{ delay: index * 0.05, duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
      className="rounded-[20px] border border-white/[0.08] bg-[#0d0d0f] px-4 py-3 flex items-center gap-3"
    >
      <div className="w-9 h-9 rounded-[12px] bg-white/[0.06] flex-shrink-0" />
      <div className="min-w-0 space-y-2">
        <div className="h-2.5 w-16 rounded bg-white/[0.06]" />
        <div className="h-5 w-10 rounded bg-white/[0.08]" />
        <div className="h-2 w-12 rounded bg-white/[0.04]" />
      </div>
    </motion.div>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({ icon, label, value, sub, index = 0 }: {
  icon: ReactNode; label: string; value: string | number; sub?: string; index?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay: index * 0.07, type: 'spring', stiffness: 280, damping: 22 }}
      whileHover={{ y: -2, transition: { type: 'spring', stiffness: 400, damping: 20 } }}
      className="rounded-[20px] border border-white/[0.08] bg-[#0d0d0f] px-4 py-3 flex items-center gap-3 cursor-default"
      style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}
    >
      <motion.div
        className="w-9 h-9 rounded-[12px] bg-white/[0.06] flex items-center justify-center flex-shrink-0"
        initial={{ rotate: -10, scale: 0.8 }}
        animate={{ rotate: 0, scale: 1 }}
        transition={{ delay: index * 0.07 + 0.08, type: 'spring', stiffness: 300, damping: 18 }}
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
      className={`relative px-4 py-2 text-sm font-medium rounded-[10px] flex items-center gap-1.5 flex-shrink-0 transition-colors ${
        active ? 'text-white' : 'text-white/40 hover:text-white/60'
      }`}
    >
      {/* Sliding pill indicator — animates between tabs via layoutId */}
      {active && (
        <motion.span
          layoutId="tab-pill"
          className="absolute inset-0 rounded-[10px] bg-white/10"
          transition={{ type: 'spring', stiffness: 400, damping: 32 }}
        />
      )}
      <span className="relative z-10 flex items-center gap-1.5">
        {children}
        {count !== undefined && count > 0 && (
          <motion.span
            key={count}
            initial={{ scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 400, damping: 20 }}
            className={`text-[11px] px-1.5 py-0.5 rounded-md font-mono ${
              active ? 'bg-white/15 text-white/80' : 'bg-white/8 text-white/35'
            }`}
          >
            {count}
          </motion.span>
        )}
      </span>
    </button>
  );
}

// ─── Stagger variants for listings sections ────────────────────────────────

const sectionContainer = {
  show: { transition: { staggerChildren: 0.09, delayChildren: 0.04 } },
};
const sectionItem = {
  hidden: { opacity: 0, y: 14 },
  show:   { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 280, damping: 24 } },
};

// ─── Page ─────────────────────────────────────────────────────────────────────

type TabKey = 'listings' | 'deals' | 'history';

export default function DashboardPage() {
  const { address, isConnected, status } = useAccount();
  const [refreshKey, setRefreshKey] = useState(0);
  const [tab, setTab] = useState<TabKey>('listings');
  const t = useTranslations();

  const { data: clientAgreements,   isLoading: isLoadingClient,   refetch: refetchClient   } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`, abi: DIAMOND_ABI as Abi,
    functionName: 'getByClient', args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 60_000 },
  }) as { data: AgreementRecord[] | undefined; isLoading: boolean; refetch: () => void };

  const { data: executorAgreements, isLoading: isLoadingExecutor, refetch: refetchExecutor } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`, abi: DIAMOND_ABI as Abi,
    functionName: 'getByExecutor', args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 60_000 },
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

  // status: 0=Created 1=Funded 2=Active 3=Completed 4=Disputed 5=Resolved 6=Refunded
  const activeDeals  = allAgreements.filter(d => [0, 1, 2, 4].includes(d.status));
  const historyDeals = allAgreements.filter(d => [3, 5, 6].includes(d.status));
  const completed    = allAgreements.filter(d => d.status === 3 || d.status === 5).length;
  const totalVolume  = allAgreements.reduce((s, d) => s + Number(d.amount), 0);
  const xp           = calcXP(allAgreements);
  const level        = xpLevel(xp);

  if (status === 'reconnecting' || status === 'connecting') return null;

  if (!isConnected) {
    return (
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-6">
            <Activity className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-bold font-syne mb-2">{t("dashboard.title")}</h1>
          <p className="text-muted-foreground text-sm mb-6">{t("dashboard.connect_prompt")}</p>
          <Link href="/"><button className="border border-white/15 rounded-lg px-4 py-2 text-sm text-white/60 hover:text-white hover:border-white/30 transition-colors">{t("dashboard.go_home")}</button></Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto px-4 py-5 max-w-6xl space-y-4">

        {/* ── XMTP setup banner ── */}
        <MessagingSetup />

        {/* ── Stats row ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {isLoading ? (
            [0, 1, 2, 3].map(i => <StatCardSkeleton key={i} index={i} />)
          ) : (
            <>
              <StatCard index={0} icon={<Zap className="w-4 h-4 text-violet-400" />} label={t("dashboard.stat_level")} value={level.label} sub={`${xp} XP`} />
              <StatCard index={1} icon={<Activity className="w-4 h-4 text-sky-400" />} label={t("dashboard.stat_active")} value={activeDeals.length} sub={activeDeals.length === 1 ? t("dashboard.stat_deal") : t("dashboard.stat_deals")} />
              <StatCard index={2} icon={<CheckCircle className="w-4 h-4 text-emerald-400" />} label={t("dashboard.stat_completed")} value={completed} sub={completed === 1 ? t("dashboard.stat_deal") : t("dashboard.stat_deals")} />
              <StatCard index={3} icon={<DollarSign className="w-4 h-4 text-amber-400" />} label={t("dashboard.stat_volume")} value={`$${(totalVolume / 1e6).toFixed(0)}`} sub={t("dashboard.stat_usdc_total")} />
            </>
          )}
        </div>

        {/* ── XP progress bar ── */}
        {isLoading ? (
          <motion.div
            animate={{ opacity: [0.4, 0.7, 0.4] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
            className="rounded-[20px] border border-white/[0.08] bg-[#0d0d0f] px-4 py-3"
          >
            <div className="flex items-center justify-between mb-2">
              <div className="h-3 w-16 rounded bg-white/[0.06]" />
              <div className="h-3 w-10 rounded bg-white/[0.06]" />
            </div>
            <div className="h-1.5 rounded-full bg-white/[0.06]" />
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.32, type: 'spring', stiffness: 260, damping: 22 }}
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
                className={`h-full rounded-full ${level.bar}`}
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(100, level.pct)}%` }}
                transition={{ delay: 0.45, type: 'spring', stiffness: 55, damping: 18 }}
              />
            </div>
          </motion.div>
        )}

        {/* ── Deal search ── */}
        <DealSearch />

        {/* ── Tabs ── */}
        <div>
          {/* Tab bar — standalone pills with sliding indicator */}
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

          {/* Tab content */}
          {isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2].map(i => (
                <motion.div
                  key={i}
                  animate={{ opacity: [0.4, 0.7, 0.4] }}
                  transition={{ delay: i * 0.1, duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
                  className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] h-[72px]"
                />
              ))}
            </div>
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              >
                {tab === 'listings' && (
                  <motion.div
                    variants={sectionContainer}
                    initial="hidden"
                    animate="show"
                    className="space-y-6"
                  >
                    <motion.section variants={sectionItem}>
                      <p className="text-xs text-white/30 uppercase tracking-wider font-semibold mb-3">{t("dashboard.section_job_postings")}</p>
                      <MyJobs address={address!} onDealCreated={refetch} />
                    </motion.section>
                    <motion.section variants={sectionItem}>
                      <p className="text-xs text-white/30 uppercase tracking-wider font-semibold mb-3">{t("nav.services")}</p>
                      <MyServices address={address!} onDealCreated={refetch} />
                    </motion.section>
                    <motion.section variants={sectionItem}>
                      <p className="text-xs text-white/30 uppercase tracking-wider font-semibold mb-3">{t("dashboard.section_service_requests")}</p>
                      <MyClientRequests address={address!} />
                    </motion.section>
                  </motion.div>
                )}

                {tab === 'deals' && (
                  activeDeals.length === 0 ? (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.96 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ type: 'spring', stiffness: 280, damping: 22 }}
                      className="text-center py-10"
                    >
                      <motion.div
                        animate={{ y: [0, -5, 0] }}
                        transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
                      >
                        <Activity className="w-8 h-8 text-white/10 mx-auto mb-3" />
                      </motion.div>
                      <p className="text-sm text-white/30">{t("dashboard.empty_active")}</p>
                      <p className="text-xs text-white/20 mt-1">{t("dashboard.empty_active_hint")}</p>
                    </motion.div>
                  ) : (
                    <div className="space-y-3">
                      <AnimatePresence>
                        {activeDeals.map((a, index) => (
                          <motion.div
                            key={`${a.agreement}-${refreshKey}`}
                            initial={{ opacity: 0, y: 18, scale: 0.97 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
                            transition={{ type: 'spring', stiffness: 280, damping: 24, delay: Math.min(index, 5) * 0.06 }}
                            whileHover={{ y: -3, transition: { type: 'spring', stiffness: 400, damping: 22 } }}
                            whileTap={{ scale: 0.985, transition: { type: 'spring', stiffness: 400, damping: 20 } }}
                          >
                            <DealCard
                              agreement={a}
                              address={address!}
                              refetch={refetch}
                            />
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </div>
                  )
                )}

                {tab === 'history' && (
                  historyDeals.length === 0 ? (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.96 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ type: 'spring', stiffness: 280, damping: 22 }}
                      className="text-center py-10"
                    >
                      <motion.div
                        animate={{ y: [0, -5, 0] }}
                        transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
                      >
                        <CheckCircle className="w-8 h-8 text-white/10 mx-auto mb-3" />
                      </motion.div>
                      <p className="text-sm text-white/30">{t("dashboard.empty_history")}</p>
                    </motion.div>
                  ) : (
                    <div className="space-y-2 opacity-80">
                      <AnimatePresence>
                        {historyDeals.map((a, index) => (
                          <motion.div
                            key={`${a.agreement}-hist-${refreshKey}`}
                            initial={{ opacity: 0, y: 18, scale: 0.97 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
                            transition={{ type: 'spring', stiffness: 280, damping: 24, delay: Math.min(index, 5) * 0.06 }}
                            whileHover={{ y: -3, transition: { type: 'spring', stiffness: 400, damping: 22 } }}
                            whileTap={{ scale: 0.985, transition: { type: 'spring', stiffness: 400, damping: 20 } }}
                          >
                            <DealCard
                              agreement={a}
                              address={address!}
                              refetch={refetch}
                            />
                          </motion.div>
                        ))}
                      </AnimatePresence>
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
