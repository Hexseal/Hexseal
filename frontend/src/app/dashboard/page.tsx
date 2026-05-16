'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useAccount, useReadContract } from 'wagmi';
import type { Abi } from 'viem';
import { DIAMOND_ABI, CONTRACTS } from '@/config/contracts';
import {
  Loader2, Activity, Briefcase, Zap, CheckCircle,
  DollarSign, Plus, ArrowRight, Star,
} from 'lucide-react';
import { MessagingSetup } from '@/components/MessagingSetup';
import { DealSearch } from '@/components/DealSearch';
import { DealCard, type AgreementRecord } from './components/DealCard';
import { MyJobs, MyServices, MyClientRequests, MyJobReceipts } from './components/MyListings';
import { useTranslations } from 'next-intl';

function calcXP(deals: AgreementRecord[]): number {
  const completed = deals.filter(d => d.status === 1 || d.status === 4).length;
  const refunded  = deals.filter(d => d.status === 2).length;
  const volume    = deals.reduce((s, d) => s + Number(d.amount), 0);
  return Math.max(0, completed * 100 + Math.floor(volume / 10_000_000) - refunded * 25);
}
function xpLevel(xp: number) {
  if (xp >= 1000) return { label: 'Master',   color: 'text-yellow-400',  bar: 'bg-yellow-400',  pct: 100 };
  if (xp >= 500)  return { label: 'Expert',   color: 'text-violet-400',  bar: 'bg-violet-400',  pct: Math.round((xp - 500) / 5) };
  if (xp >= 200)  return { label: 'Trusted',  color: 'text-blue-400',    bar: 'bg-blue-400',    pct: Math.round((xp - 200) / 3) };
  if (xp >= 50)   return { label: 'Rising',   color: 'text-emerald-400', bar: 'bg-emerald-400', pct: Math.round((xp - 50) / 1.5) };
  return               { label: 'Newcomer', color: 'text-white/40',    bar: 'bg-white/20',    pct: Math.round(xp / 0.5) };
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({ icon, label, value, sub }: {
  icon: ReactNode; label: string; value: string | number; sub?: string;
}) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3 flex items-center gap-3">
      <div className="w-9 h-9 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs text-white/35 leading-none mb-1">{label}</p>
        <p className="text-lg font-bold text-white leading-none">{value}</p>
        {sub && <p className="text-[11px] text-white/30 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ─── Tab button ───────────────────────────────────────────────────────────────

function Tab({ active, onClick, children, count }: {
  active: boolean; onClick: () => void; children: ReactNode; count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors flex items-center gap-1.5 flex-shrink-0 ${
        active
          ? 'bg-white/10 text-white'
          : 'text-white/40 hover:text-white/70 hover:bg-white/5'
      }`}
    >
      {children}
      {count !== undefined && count > 0 && (
        <span className={`text-[11px] px-1.5 py-0.5 rounded-md font-mono ${
          active ? 'bg-white/15 text-white/80' : 'bg-white/8 text-white/35'
        }`}>
          {count}
        </span>
      )}
    </button>
  );
}

// ─── Quick action button ───────────────────────────────────────────────────────

function QuickAction({ href, icon, label, sub, accent }: {
  href: string; icon: ReactNode; label: string; sub: string; accent?: boolean;
}) {
  return (
    <Link href={href} className="block">
      <div className={`rounded-xl border px-4 py-3.5 flex items-center gap-3 transition-colors group cursor-pointer ${
        accent
          ? 'border-violet-500/30 bg-violet-500/8 hover:bg-violet-500/15 hover:border-violet-500/50'
          : 'border-white/8 bg-white/[0.03] hover:bg-white/[0.07] hover:border-white/15'
      }`}>
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
          accent ? 'bg-violet-500/20' : 'bg-white/5'
        }`}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-semibold leading-none mb-0.5 ${accent ? 'text-violet-300' : 'text-white/80'} group-hover:text-white transition-colors`}>{label}</p>
          <p className="text-xs text-white/30">{sub}</p>
        </div>
        <ArrowRight className={`w-4 h-4 flex-shrink-0 transition-colors ${accent ? 'text-violet-500/50 group-hover:text-violet-400' : 'text-white/15 group-hover:text-white/40'}`} />
      </div>
    </Link>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type TabKey = 'active' | 'jobs' | 'services' | 'history';

export default function DashboardPage() {
  const { address, isConnected } = useAccount();
  const [refreshKey, setRefreshKey] = useState(0);
  const [tab, setTab] = useState<TabKey>('active');
  const t = useTranslations();

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

  const activeDeals  = allAgreements.filter(d => d.status === 0 || d.status === 3);
  const historyDeals = allAgreements.filter(d => d.status !== 0 && d.status !== 3);
  const completed    = allAgreements.filter(d => d.status === 1 || d.status === 4).length;
  const totalVolume  = allAgreements.reduce((s, d) => s + Number(d.amount), 0);
  const xp           = calcXP(allAgreements);
  const level        = xpLevel(xp);

  if (!isConnected) {
    return (
      <div className="flex items-center justify-center min-h-screen px-4">
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
    <div className="min-h-screen bg-background">
      <div className="mx-auto px-4 py-5 max-w-4xl space-y-4">

        {/* ── XMTP setup banner (only shows when needed) ── */}
        <MessagingSetup />

        {/* ── Stats row ── */}
        {!isLoading && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <StatCard
              icon={<Zap className="w-4 h-4 text-violet-400" />}
              label={t("dashboard.stat_level")}
              value={level.label}
              sub={`${xp} XP`}
            />
            <StatCard
              icon={<Activity className="w-4 h-4 text-sky-400" />}
              label={t("dashboard.stat_active")}
              value={activeDeals.length}
              sub={activeDeals.length === 1 ? t("dashboard.stat_deal") : t("dashboard.stat_deals")}
            />
            <StatCard
              icon={<CheckCircle className="w-4 h-4 text-emerald-400" />}
              label={t("dashboard.stat_completed")}
              value={completed}
              sub={completed === 1 ? t("dashboard.stat_deal") : t("dashboard.stat_deals")}
            />
            <StatCard
              icon={<DollarSign className="w-4 h-4 text-amber-400" />}
              label={t("dashboard.stat_volume")}
              value={`$${(totalVolume / 1e6).toFixed(0)}`}
              sub={t("dashboard.stat_usdc_total")}
            />
          </div>
        )}

        {/* XP progress bar */}
        {!isLoading && (
          <div className="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Star className="w-3.5 h-3.5 text-white/30" />
                <span className={`text-xs font-semibold ${level.color}`}>{level.label}</span>
              </div>
              <span className="text-xs font-mono text-white/30">{xp} XP</span>
            </div>
            <div className="h-1.5 rounded-full bg-white/8 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 ${level.bar}`}
                style={{ width: `${Math.min(100, level.pct)}%` }}
              />
            </div>
          </div>
        )}

        {/* ── Quick actions ── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <QuickAction
            href="/board/client/post"
            icon={<Briefcase className="w-4 h-4 text-white/50" />}
            label={t("dashboard.action_post_job")}
            sub={t("dashboard.action_post_job_sub")}
            accent={false}
          />
          <QuickAction
            href="/board/executor"
            icon={<Zap className="w-4 h-4 text-violet-400" />}
            label={t("dashboard.action_find_work")}
            sub={t("dashboard.action_find_work_sub")}
            accent={true}
          />
          <QuickAction
            href="/board/executor/post"
            icon={<Plus className="w-4 h-4 text-white/50" />}
            label={t("dashboard.action_offer_service")}
            sub={t("dashboard.action_offer_service_sub")}
            accent={false}
          />
        </div>

        {/* ── Deal search ── */}
        <DealSearch />

        {/* ── Tabs ── */}
        <div className="rounded-xl border border-white/8 bg-white/[0.02] overflow-hidden">
          {/* Tab bar */}
          <div className="flex gap-1 p-2 border-b border-white/8 overflow-x-auto scrollbar-none">
            <Tab active={tab === 'active'}   onClick={() => setTab('active')}   count={activeDeals.length}>
              {t("dashboard.tabs.active")}
            </Tab>
            <Tab active={tab === 'jobs'}     onClick={() => setTab('jobs')}>
              {t("nav.jobs")}
            </Tab>
            <Tab active={tab === 'services'} onClick={() => setTab('services')}>
              {t("nav.services")}
            </Tab>
            <Tab active={tab === 'history'}  onClick={() => setTab('history')}  count={historyDeals.length}>
              {t("dashboard.tabs.history")}
            </Tab>
          </div>

          {/* Tab content */}
          <div className="p-3 sm:p-4">
            {isLoading ? (
              <div className="flex items-center justify-center py-12 gap-2 text-white/30">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">{t("dashboard.loading")}</span>
              </div>
            ) : (
              <>
                {tab === 'active' && (
                  activeDeals.length === 0 ? (
                    <div className="text-center py-10">
                      <Activity className="w-8 h-8 text-white/10 mx-auto mb-3" />
                      <p className="text-sm text-white/30">{t("dashboard.empty_active")}</p>
                      <p className="text-xs text-white/20 mt-1">{t("dashboard.empty_active_hint")}</p>
                    </div>
                  ) : (
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
                  )
                )}

                {tab === 'jobs' && (
                  <div className="space-y-4">
                    <div>
                      <p className="text-xs text-white/30 uppercase tracking-wider font-semibold mb-2">{t("dashboard.section_job_postings")}</p>
                      <MyJobs address={address!} onDealCreated={refetch} />
                    </div>
                    <div>
                      <p className="text-xs text-white/30 uppercase tracking-wider font-semibold mb-2">{t("dashboard.section_job_receipts")}</p>
                      <MyJobReceipts address={address!} />
                    </div>
                    <div>
                      <p className="text-xs text-white/30 uppercase tracking-wider font-semibold mb-2">{t("dashboard.section_service_requests")}</p>
                      <MyClientRequests address={address!} />
                    </div>
                  </div>
                )}

                {tab === 'services' && (
                  <MyServices address={address!} onDealCreated={refetch} />
                )}

                {tab === 'history' && (
                  historyDeals.length === 0 ? (
                    <div className="text-center py-10">
                      <CheckCircle className="w-8 h-8 text-white/10 mx-auto mb-3" />
                      <p className="text-sm text-white/30">{t("dashboard.empty_history")}</p>
                    </div>
                  ) : (
                    <div className="space-y-2 opacity-80">
                      {historyDeals.map(a => (
                        <DealCard
                          key={`${a.agreement}-hist-${refreshKey}`}
                          agreement={a}
                          address={address!}
                          refetch={refetch}
                        />
                      ))}
                    </div>
                  )
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
