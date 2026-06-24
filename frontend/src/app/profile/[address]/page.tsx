"use client";

import React, { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useAccount, useReadContract } from "wagmi";
import { DIAMOND_ABI, REPUTATION_ABI, CONTRACTS } from "@/config/contracts";
import { fetchProfile } from "@/lib/profiles-ipfs";
import type { UserProfile } from "@/types/profile";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  ExternalLink,
  Edit,
  CheckCircle,
  Clock,
  AlertTriangle,
  TrendingUp,
  Zap,
  Star,
  Activity,
  Wallet,
  ChevronDown,
  Copy,
} from "lucide-react";
import Link from "next/link";
import { toast } from "react-hot-toast";
import { isAddress } from "viem";
import { useTranslations } from "next-intl";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgreementRecord {
  agreement: string;
  client: string;
  executor: string;
  amount: bigint;
  status: number;
  createdAt: bigint;
  resolvedAt: bigint;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatAmount(amount: bigint): string {
  return (Number(amount) / 1e6).toFixed(2);
}

function formatDate(ts: number | bigint): string {
  const d = new Date(Number(ts) * 1000);
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

import { calcCompletionRate } from '@/lib/xp';

type Level = { labelKey: string; color: string; glow: string; next: number | null };

function xpLevel(xp: number): Level {
  if (xp >= 1000) return { labelKey: "xp_level.master",   color: "text-yellow-400", glow: "shadow-yellow-400/20",  next: null };
  if (xp >= 500)  return { labelKey: "xp_level.expert",   color: "text-violet-400", glow: "shadow-violet-400/20",  next: 1000 };
  if (xp >= 200)  return { labelKey: "xp_level.trusted",  color: "text-blue-400",   glow: "shadow-blue-400/20",    next: 500  };
  if (xp >= 50)   return { labelKey: "xp_level.rising",   color: "text-emerald-400",glow: "shadow-emerald-400/20", next: 200  };
  return               { labelKey: "xp_level.newcomer", color: "text-white/40",   glow: "",                      next: 50   };
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

// ─── Status config ────────────────────────────────────────────────────────────

// Registry enum: 0=ACTIVE, 1=COMPLETED, 2=REFUNDED, 3=DISPUTED, 4=RESOLVED
const STATUS_CFG: Record<number, { labelKey: string; dot: string; badge: string }> = {
  0: { labelKey: "deal_status.active",    dot: "bg-violet-400",  badge: "bg-violet-400/10 text-violet-400 border-violet-400/20"    },
  1: { labelKey: "deal_status.completed", dot: "bg-green-400",   badge: "bg-green-400/10 text-green-400 border-green-400/20"       },
  2: { labelKey: "deal_status.refunded",  dot: "bg-gray-400",    badge: "bg-gray-400/10 text-gray-400 border-gray-400/20"          },
  3: { labelKey: "deal_status.disputed",  dot: "bg-red-400",     badge: "bg-red-400/10 text-red-400 border-red-400/20"             },
  4: { labelKey: "deal_status.resolved",  dot: "bg-purple-400",  badge: "bg-purple-400/10 text-purple-400 border-purple-400/20"    },
};

// ─── Deal History Row ─────────────────────────────────────────────────────────

function DealRow({ deal, profileAddress }: { deal: AgreementRecord; profileAddress: string }) {
  const t = useTranslations();
  const cfg = STATUS_CFG[deal.status] ?? STATUS_CFG[0];
  const isClient = deal.client.toLowerCase() === profileAddress.toLowerCase();

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 rounded-[14px] border border-white/[0.07] bg-[#0d0d0f] hover:bg-white/[0.04] transition-colors">
      <div className="flex items-center gap-3 min-w-0">
        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${cfg.dot}`} />
        <div className="min-w-0">
          <p className="font-mono text-xs text-white/70 truncate">#{deal.agreement.slice(2, 10).toUpperCase()}</p>
          <p className="text-[11px] text-white/30 mt-0.5">
            {isClient ? t("profile.client_role_badge") : t("profile.executor_role_badge")} · {formatDate(deal.createdAt)}
          </p>
        </div>
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] border flex-shrink-0 ${cfg.badge}`}>
          {t(cfg.labelKey)}
        </span>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="font-bold font-mono text-sm text-white">{formatAmount(deal.amount)} <span className="text-white/30 font-normal">USDC</span></span>
        <Link href={`/deal/${deal.agreement}`}>
          <button className="w-6 h-6 flex items-center justify-center rounded-lg text-white/25 hover:text-white/60 hover:bg-white/5 transition-colors">
            <ExternalLink className="w-3 h-3" />
          </button>
        </Link>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const t = useTranslations();
  const params = useParams();
  const profileAddress = ((params.address as string) || '').toLowerCase();
  const { address: viewerAddress } = useAccount();
  const [showAllHistory, setShowAllHistory] = useState(false);

  const isOwner = viewerAddress?.toLowerCase() === profileAddress;
  const validAddress = isAddress(profileAddress);
  const [profile, setProfile] = useState<UserProfile | null>(null);

  useEffect(() => {
    if (!validAddress) return;
    fetchProfile(profileAddress).then(setProfile).catch(() => {});
  }, [profileAddress, validAddress]);

  const { data: clientDealsRaw, isLoading: loadingClient } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: "getByClient",
    args: validAddress ? [profileAddress as `0x${string}`] : undefined,
    query: { enabled: validAddress },
  }) as { data: AgreementRecord[] | undefined; isLoading: boolean };

  const { data: executorDealsRaw, isLoading: loadingExecutor } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: "getByExecutor",
    args: validAddress ? [profileAddress as `0x${string}`] : undefined,
    query: { enabled: validAddress },
  }) as { data: AgreementRecord[] | undefined; isLoading: boolean };

  const isLoading = loadingClient || loadingExecutor;

  const allDeals = (() => {
    const map = new Map<string, AgreementRecord>();
    [...(clientDealsRaw || []), ...(executorDealsRaw || [])].forEach(d =>
      map.set(d.agreement.toLowerCase(), d)
    );
    return Array.from(map.values());
  })();

  const { data: onchainXP } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: REPUTATION_ABI,
    functionName: 'getXP',
    args: validAddress ? [profileAddress as `0x${string}`] : undefined,
    query: { enabled: validAddress },
  });
  const xp = Number(onchainXP ?? 0n);

  // Registry 5-state enum: 0=ACTIVE, 1=COMPLETED, 2=REFUNDED, 3=DISPUTED, 4=RESOLVED
  const REG_TO_AGMT = [2, 3, 6, 4, 5] as const;
  const dealsForCompletion = allDeals.map(d => ({
    ...d,
    status:  REG_TO_AGMT[d.status] ?? 2,
    pairKey: [d.client, d.executor].map(s => s.toLowerCase()).sort().join(':'),
  }));

  const completedDeals  = allDeals.filter(d => d.status === 1 || d.status === 4).length;
  const activeDeals     = allDeals.filter(d => d.status === 0 || d.status === 3).length;
  const disputedDeals   = allDeals.filter(d => d.status === 3).length;
  const refundedDeals   = allDeals.filter(d => d.status === 2).length;
  const totalVolume     = allDeals.reduce((s, d) => s + Number(d.amount), 0);
  const completionRate  = calcCompletionRate(dealsForCompletion);
  const level           = xpLevel(xp);
  const closedCount     = completedDeals + refundedDeals;

  // History: COMPLETED(1), REFUNDED(2), RESOLVED(4)
  const historyDeals = allDeals
    .filter(d => [1, 2, 4].includes(d.status))
    .sort((a, b) => Number(b.createdAt) - Number(a.createdAt));

  // Active: ACTIVE(0), DISPUTED(3)
  const activeList = allDeals
    .filter(d => d.status === 0 || d.status === 3)
    .sort((a, b) => Number(b.createdAt) - Number(a.createdAt));

  if (!validAddress) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-white/40 text-sm">{t("profile.invalid_address")}</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl space-y-5">

        {/* ── Profile header ─────────────────────────────────────────────── */}
        <div className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-6 py-5" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
          <div className="flex items-start gap-4">
            {/* Avatar: real image if uploaded, else gradient fallback */}
            {/* Prefer Storj direct URL (fast, permanent); fall back to IPFS gateway */}
            {(profile?.avatarUrl || profile?.avatarCid) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={
                  profile.avatarUrl ||
                  `${process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://gateway.lighthouse.storage'}/ipfs/${profile.avatarCid}`
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
                    <span className="text-xs text-white/35">
                      discord: {profile.links.discord}
                    </span>
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
            {isOwner && (
              <Link href="/profile/edit">
                <Button variant="outline" size="sm" className="flex-shrink-0">
                  <Edit className="w-3.5 h-3.5 mr-1" />{t("common.edit")}
                </Button>
              </Link>
            )}
          </div>
        </div>

        {/* ── XP + stats ─────────────────────────────────────────────────── */}
        {isLoading ? (
          <div className="flex items-center justify-center py-10 gap-2 text-white/30">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">{t("profile.loading_data")}</span>
          </div>
        ) : (
          <>
            {/* XP bar */}
            <div className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-5 py-4" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-yellow-400" />
                  <span className="font-semibold text-sm text-white">{t("profile.xp_title")}</span>
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-2xl font-bold font-mono text-white">{xp}</span>
                  <span className={`text-sm font-semibold ${level.color}`}>{t(level.labelKey)}</span>
                </div>
              </div>
              {level.next !== null && (
                <>
                  <div className="h-1.5 w-full bg-white/8 rounded-full overflow-hidden">
                    <motion.div
                      className="h-full rounded-full bg-gradient-to-r from-violet-500 to-blue-500"
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.min(100, (xp / level.next) * 100)}%` }}
                      transition={{ duration: 0.8, ease: "easeOut", delay: 0.3 }}
                    />
                  </div>
                  <p className="text-[11px] text-white/30 mt-1.5">{t("profile.xp_to_next", { xp, next: level.next })}</p>
                </>
              )}
              {level.next === null && (
                <p className="text-[11px] text-yellow-400/60">{t("profile.max_level")}</p>
              )}
            </div>

            {/* Stats grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { icon: <Activity className="w-3 h-3 text-violet-400" />, label: t("profile.stats_active"),    value: activeDeals },
                { icon: <CheckCircle className="w-3 h-3 text-green-400" />, label: t("profile.stats_completed"), value: completedDeals },
                { icon: <Wallet className="w-3 h-3 text-emerald-400" />, label: t("profile.stats_volume"),    value: `$${(totalVolume / 1e6).toFixed(0)}` },
                { icon: <TrendingUp className="w-3 h-3 text-blue-400" />, label: t("profile.stats_success"),  value: closedCount > 0 ? `${completionRate}%` : "—" },
              ].map(({ icon, label, value }, i) => (
                <motion.div
                  key={label}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.06, duration: 0.2 }}
                  className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-4 py-3"
                  style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}
                >
                  <div className="flex items-center gap-1.5 mb-1.5">
                    {icon}
                    <span className="text-[11px] text-white/40">{label}</span>
                  </div>
                  <span className="text-2xl font-bold font-mono text-white">{value}</span>
                </motion.div>
              ))}
            </div>

            {/* Coefficient + dispute rate row */}
            {allDeals.length > 0 && (
              <div className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-5 py-4" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
                <h3 className="text-sm font-semibold text-white/60 mb-3">{t("profile.reputation_breakdown")}</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div>
                    <p className="text-[11px] text-white/35 mb-1">{t("profile.completion_rate")}</p>
                    <p className="text-lg font-bold font-mono text-white">
                      {closedCount > 0 ? `${completionRate}%` : "N/A"}
                    </p>
                    <p className="text-[10px] text-white/25">{t("profile.closed_count", { completed: completedDeals, closed: closedCount })}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-white/35 mb-1">{t("profile.dispute_rate")}</p>
                    <p className={`text-lg font-bold font-mono ${disputedDeals > 0 ? 'text-orange-400' : 'text-white'}`}>
                      {allDeals.length > 0 ? `${Math.round((disputedDeals / allDeals.length) * 100)}%` : "0%"}
                    </p>
                    <p className="text-[10px] text-white/25">{t("profile.disputed_count", { count: disputedDeals })}</p>
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <p className="text-[11px] text-white/35 mb-1">{t("profile.total_deals")}</p>
                    <p className="text-lg font-bold font-mono text-white">{allDeals.length}</p>
                    <p className="text-[10px] text-white/25">{t("profile.active_count", { count: activeDeals })}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Active deals */}
            {activeList.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-violet-400" />
                  <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">{t("profile.active_section", { count: activeList.length })}</span>
                </div>
                <div className="space-y-3">
                  <AnimatePresence>
                    {activeList.map((d, index) => (
                      <motion.div
                        key={d.agreement}
                        initial={{ opacity: 0, y: 14 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.97 }}
                        transition={{ duration: 0.22, delay: Math.min(index, 6) * 0.04 }}
                      >
                        <DealRow deal={d} profileAddress={profileAddress} />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            )}

            {/* History */}
            {historyDeals.length > 0 && (
              <div>
                <button
                  onClick={() => setShowAllHistory(v => !v)}
                  className="flex items-center gap-2 mb-3 group w-full text-left"
                >
                  <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
                  <span className="text-xs font-semibold text-white/35 uppercase tracking-wider group-hover:text-white/55 transition-colors">
                    {t("profile.history_section", { count: historyDeals.length })}
                  </span>
                  <ChevronDown className={`w-3 h-3 text-white/25 transition-transform group-hover:text-white/50 ${showAllHistory ? 'rotate-180' : ''}`} />
                </button>
                <AnimatePresence>
                  {showAllHistory && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="space-y-3 opacity-75"
                    >
                      {historyDeals.map((d, index) => (
                        <motion.div
                          key={d.agreement}
                          initial={{ opacity: 0, y: 14 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.22, delay: Math.min(index, 6) * 0.04 }}
                        >
                          <DealRow deal={d} profileAddress={profileAddress} />
                        </motion.div>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}

            {allDeals.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-center rounded-2xl border border-white/6 bg-white/[0.02]">
                <Star className="w-8 h-8 text-white/15 mb-3" />
                <p className="text-white/35 text-sm">{t("profile.no_deals")}</p>
                {isOwner && (
                  <Link href="/deal">
                    <Button size="sm" variant="outline" className="mt-4 border-white/15 text-white/50">
                      {t("profile.create_first_deal")}
                    </Button>
                  </Link>
                )}
              </div>
            )}
          </>
        )}
      </div>
  );
}
