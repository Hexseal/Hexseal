"use client";

import React, { useState, useEffect, useMemo, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useAccount, useReadContract } from "wagmi";
import { REPUTATION_ABI, CONTRACTS } from "@/config/contracts";
import { fetchProfile } from "@/lib/profiles-ipfs";
import { resolveMediaUrl } from "@/lib/mediaUrl";
import type { UserProfile } from "@/types/profile";
import { Button } from "@/components/ui/button";
import {
  Activity, CheckCircle, DollarSign, Zap,
  Star, Copy, Edit, ExternalLink,
} from "lucide-react";
import Link from "next/link";
import { toast } from "react-hot-toast";
import { isAddress } from "viem";
import { useTranslations } from "next-intl";
import { useMyAgreements, type GraphAgreement } from "@/hooks/useMyAgreements";
import { useAgreementTitles } from "@/hooks/useAgreementTitles";
import { DealCard, type AgreementRecord } from "@/app/dashboard/components/DealCard";
import { MyJobs, MyServices, MyClientRequests } from "@/app/dashboard/components/MyListings";
import { PageCenter } from "@/components/PageCenter";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtVolume(microUsdc: number): string {
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
  };
}

function xpLevel(xp: number) {
  const p = (v: number) => Math.max(3, Math.min(100, Math.round(v)));
  if (xp >= 1000) return { labelKey: 'xp_level.master',   color: 'text-yellow-400',  bar: 'bg-yellow-400',  pct: 100 };
  if (xp >= 500)  return { labelKey: 'xp_level.expert',   color: 'text-violet-400',  bar: 'bg-violet-400',  pct: p((xp - 500) / 5) };
  if (xp >= 200)  return { labelKey: 'xp_level.trusted',  color: 'text-blue-400',    bar: 'bg-blue-400',    pct: p((xp - 200) / 3) };
  if (xp >= 50)   return { labelKey: 'xp_level.rising',   color: 'text-emerald-400', bar: 'bg-emerald-400', pct: p((xp - 50) / 1.5) };
  return               { labelKey: 'xp_level.newcomer', color: 'text-white/40',    bar: 'bg-white/20',    pct: Math.round(xp / 0.5) };
}

// ─── Address Avatar ───────────────────────────────────────────────────────────

function AddressAvatar({ address, size = 64 }: { address: string; size?: number }) {
  const palettes = [
    ['#6366f1', '#8b5cf6'], ['#06b6d4', '#3b82f6'], ['#10b981', '#06b6d4'],
    ['#f59e0b', '#ef4444'], ['#ec4899', '#8b5cf6'], ['#84cc16', '#10b981'],
  ];
  const hash = address.slice(2).split('').reduce((a, b) => a + b.charCodeAt(0), 0);
  const [c1, c2] = palettes[hash % palettes.length];
  const initial = address.slice(2, 4).toUpperCase();
  return (
    <div
      className="rounded-2xl flex items-center justify-center font-mono font-bold text-white flex-shrink-0"
      style={{
        width: size, height: size,
        background: `linear-gradient(135deg, ${c1}, ${c2})`,
        fontSize: size * 0.32,
        boxShadow: `0 0 ${size * 0.4}px ${c1}33`,
      }}
    >
      {initial}
    </div>
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

export default function ProfilePage() {
  const t = useTranslations();
  const params = useParams();
  const profileAddress = ((params.address as string) || '').toLowerCase();
  const { address: viewerAddress } = useAccount();

  const isOwner = viewerAddress?.toLowerCase() === profileAddress;
  const validAddress = isAddress(profileAddress);

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [tab, setTab] = useState<TabKey>('listings');
  const [listingsSub, setListingsSub] = useState<ListingsSub>('jobs');

  useEffect(() => {
    if (!validAddress) return;
    fetchProfile(profileAddress).then(setProfile).catch(() => {});
  }, [profileAddress, validAddress]);

  const { agreements: rawAgreements, isLoading } = useMyAgreements(validAddress ? profileAddress : undefined);
  const titleMap = useAgreementTitles(validAddress ? profileAddress : undefined);
  const allAgreements = useMemo(
    () => rawAgreements.map(a => ({ ...toAgreementRecord(a), title: titleMap.get(a.id.toLowerCase()) })),
    [rawAgreements, titleMap],
  );

  const { data: onchainXP } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: REPUTATION_ABI,
    functionName: 'getXP',
    args: validAddress ? [profileAddress as `0x${string}`] : undefined,
    query: { enabled: validAddress },
  });
  const xp = Number(onchainXP ?? 0n);
  const level = xpLevel(xp);

  // status: 0=Created 1=Funded 2=Active 3=Completed 4=Disputed 5=Resolved 6=Refunded
  const activeDeals  = allAgreements.filter(d => [0, 1, 2, 4].includes(d.status));
  const historyDeals = allAgreements.filter(d => [3, 5, 6].includes(d.status));
  const completed    = allAgreements.filter(d => d.status === 3 || d.status === 5).length;
  const totalVolume  = allAgreements.reduce((s, d) => s + Number(d.amount), 0);

  const memberSince = rawAgreements.length > 0
    ? new Date(Math.min(...rawAgreements.map(a => Number(a.createdAt))) * 1000)
    : null;

  if (!validAddress) {
    return (
      <PageCenter>
        <p className="text-white/40 text-sm">{t("profile.invalid_address")}</p>
      </PageCenter>
    );
  }

  return (
    <div className="mx-auto px-4 py-5 max-w-4xl space-y-4 overflow-x-hidden w-full">

      {/* ── Profile header ─────────────────────────────────────────────── */}
      <div
        className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-6 py-5"
        style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}
      >
        <div className="flex items-start gap-4">
          {(profile?.avatarUrl || profile?.avatarCid) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={
                resolveMediaUrl(
                  profile.avatarUrl ||
                  `${process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://gateway.lighthouse.storage'}/ipfs/${profile.avatarCid}`
                ) ?? undefined
              }
              alt={profile.displayName || 'Avatar'}
              className="w-[72px] h-[72px] rounded-2xl object-cover flex-shrink-0"
            />
          ) : (
            <AddressAvatar address={profileAddress} size={72} />
          )}

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <h1 className="text-xl font-bold text-white">
                {profile?.displayName || (isOwner ? t("profile.your_profile") : shortAddr(profileAddress))}
              </h1>
              <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs border border-white/10 font-semibold ${level.color}`}>
                <Zap className="w-3 h-3" />{t(level.labelKey)}
              </span>
              {profile?.role && (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs border border-white/10 text-white/40 bg-white/[0.03]">
                  {profile.role === 'client' ? t("profile.client_role_badge") : profile.role === 'executor' ? t("profile.executor_role_badge") : t("profile.role_client_executor")}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-white/30 font-mono">
              <span>{shortAddr(profileAddress)}</span>
              <button
                onClick={() => { navigator.clipboard.writeText(profileAddress); toast.success(t("common.copied")); }}
                className="hover:text-white/60 transition-colors"
              >
                <Copy className="w-3 h-3" />
              </button>
            </div>
            {profile?.bio ? (
              <p className="text-xs text-white/50 mt-2 leading-relaxed">{profile.bio}</p>
            ) : (
              <p className="text-xs text-white/25 mt-1.5">{t("profile.on_chain_info")}</p>
            )}
            {profile?.specializations && profile.specializations.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {profile.specializations.map(s => (
                  <span key={s} className="px-2 py-0.5 rounded-full text-[11px] border border-white/10 text-white/50 bg-white/[0.03]">
                    {s}
                  </span>
                ))}
              </div>
            )}
            {profile?.links && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
                {profile.links.telegram && (
                  <a href={`https://t.me/${profile.links.telegram}`} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-white/35 hover:text-white/70 transition-colors">
                    tg: @{profile.links.telegram}
                  </a>
                )}
                {profile.links.github && (
                  <a href={`https://github.com/${profile.links.github}`} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-white/35 hover:text-white/70 transition-colors">
                    github/{profile.links.github}
                  </a>
                )}
                {profile.links.twitter && (
                  <a href={`https://twitter.com/${profile.links.twitter}`} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-white/35 hover:text-white/70 transition-colors">
                    x.com/{profile.links.twitter}
                  </a>
                )}
                {profile.links.discord && (
                  <span className="text-xs text-white/35">discord: {profile.links.discord}</span>
                )}
                {profile.links.website && (
                  <a href={profile.links.website} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-white/35 hover:text-white/70 transition-colors truncate max-w-[160px]">
                    {profile.links.website.replace(/^https?:\/\//, '')}
                  </a>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-col items-end gap-2 shrink-0">
            {memberSince && (
              <span className="text-[11px] text-white/25">
                {t("profile.member_since", { date: memberSince.toLocaleDateString('en', { month: 'short', year: 'numeric' }) })}
              </span>
            )}
            {isOwner && (
              <Link href="/profile/edit">
                <Button variant="outline" size="sm">
                  <Edit className="w-3.5 h-3.5 mr-1" />{t("common.edit")}
                </Button>
              </Link>
            )}
            {!isOwner && viewerAddress && (
              <Link href={`/chat?peer=${profileAddress}`}>
                <Button variant="outline" size="sm">
                  <ExternalLink className="w-3.5 h-3.5 mr-1" />
                  {t("common.message") ?? "Message"}
                </Button>
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* ── Stats row ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard index={0} icon={<Zap className="w-4 h-4 text-violet-400" />}           label={t("dashboard.stat_level")}     value={t(level.labelKey)} sub={`${xp} XP`} />
        <StatCard index={1} icon={<Activity className="w-4 h-4 text-sky-400" />}         label={t("dashboard.stat_active")}    value={activeDeals.length} sub={activeDeals.length === 1 ? t("dashboard.stat_deal") : t("dashboard.stat_deals")} />
        <StatCard index={2} icon={<CheckCircle className="w-4 h-4 text-emerald-400" />}  label={t("dashboard.stat_completed")} value={completed} sub={completed === 1 ? t("dashboard.stat_deal") : t("dashboard.stat_deals")} />
        <StatCard index={3} icon={<DollarSign className="w-4 h-4 text-amber-400" />}     label={t("dashboard.stat_volume")}   value={fmtVolume(totalVolume)} sub={t("dashboard.stat_usdc_total")} />
      </div>

      {/* ── XP bar ── */}
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
            <span className={`text-xs font-semibold ${level.color}`}>{t(level.labelKey)}</span>
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
                      ...(isOwner ? [['requests', t('dashboard.section_service_requests')]] : []),
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
                      {listingsSub === 'jobs'     && <MyJobs address={profileAddress as `0x${string}`} onDealCreated={() => {}} readOnly={!isOwner} />}
                      {listingsSub === 'services' && <MyServices address={profileAddress as `0x${string}`} onDealCreated={() => {}} readOnly={!isOwner} />}
                      {listingsSub === 'requests' && isOwner && <MyClientRequests address={profileAddress as `0x${string}`} />}
                    </motion.div>
                  </AnimatePresence>
                </div>
              )}

              {tab === 'deals' && (
                activeDeals.length === 0 ? (
                  <div className="text-center py-10">
                    <Activity className="w-8 h-8 text-white/10 mx-auto mb-3" />
                    <p className="text-sm text-white/30">{t("dashboard.empty_active")}</p>
                    {isOwner && <p className="text-xs text-white/20 mt-1">{t("dashboard.empty_active_hint")}</p>}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {activeDeals.map((a, index) => (
                      <div
                        key={a.agreement}
                        className="card-enter active:scale-[0.985] transition-transform duration-100 cursor-pointer"
                        style={{ animationDelay: `${Math.min(index, 5) * 0.06}s` }}
                      >
                        <DealCard agreement={a} address={viewerAddress ?? profileAddress} refetch={() => {}} />
                      </div>
                    ))}
                  </div>
                )
              )}

              {tab === 'history' && (
                historyDeals.length === 0 ? (
                  <div className="text-center py-10">
                    <CheckCircle className="w-8 h-8 text-white/10 mx-auto mb-3" />
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
                        <DealCard agreement={a} address={viewerAddress ?? profileAddress} refetch={() => {}} />
                      </div>
                    ))}
                  </div>
                )
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </div>

      {allAgreements.length === 0 && !isLoading && tab !== 'listings' && (
        <div className="flex flex-col items-center justify-center py-16 text-center rounded-2xl border border-white/6 bg-white/[0.02]">
          <Star className="w-8 h-8 text-white/15 mb-3" />
          <p className="text-white/35 text-sm">{t("profile.no_deals")}</p>
          {isOwner && (
            <Link href="/board">
              <Button size="sm" variant="outline" className="mt-4 border-white/15 text-white/50">
                {t("profile.create_first_deal")}
              </Button>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
