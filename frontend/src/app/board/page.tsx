"use client";

import React, { useState, useMemo, useEffect, useRef } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { useJobs, type GraphJob } from "@/hooks/useJobs";
import { DIAMOND_ABI, CONTRACTS } from "@/config/contracts";
import { sendGasless } from "@/lib/relay";
import type { Abi } from "viem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "react-hot-toast";
import {
  Search, Loader2, Briefcase, Plus, MessageCircle,
  ChevronDown, UserCheck, ExternalLink, FileText,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { UserName, UserAvatar } from "@/components/UserName";
import { useTranslations } from "next-intl";
import { BoardRegionFilter, REGION_LABELS, getStoredBoardRegion, storeBoardRegion } from "@/components/BoardRegionFilter";
import { CATEGORIES, CATEGORY_BADGE, type CategoryKey, extractCategory, stripCategory } from "@/config/categories";
import { motion, AnimatePresence } from "framer-motion";

interface JobRecord {
  client: string;
  title: string;
  description: string;
  amount: bigint;
  deadlineDays: bigint;
  termsHash: string;
  region: number;
  status: number;
  createdAt: bigint;
  chosenExecutor: string;
  agreement: string;
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatBudget(budget: bigint): string {
  return (Number(budget) / 1e6).toFixed(2);
}

function useTimeAgo() {
  const t = useTranslations();
  return (ts: bigint): string => {
    const diff = Math.floor(Date.now() / 1000) - Number(ts);
    if (diff < 60) return t("common.just_now");
    if (diff < 3600) return t("common.minutes_ago", { count: Math.floor(diff / 60) });
    if (diff < 86400) return t("common.hours_ago", { count: Math.floor(diff / 3600) });
    return t("common.days_ago", { count: Math.floor(diff / 86400) });
  };
}

function JobCardSkeleton() {
  return (
    <motion.div
      className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] min-h-[80px]"
      animate={{ opacity: [0.4, 0.8, 0.4] }}
      transition={{ repeat: Infinity, duration: 1.5 }}
    >
      <div className="flex items-center gap-3 px-4 py-4">
        <div className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-white/[0.06] mt-0.5" />
        <div className="flex-1 min-w-0 space-y-2">
          <div className="h-3.5 w-48 rounded-md bg-white/[0.06]" />
          <div className="flex gap-2">
            <div className="h-2.5 w-16 rounded-md bg-white/[0.06]" />
            <div className="h-2.5 w-20 rounded-md bg-white/[0.06]" />
            <div className="h-2.5 w-12 rounded-md bg-white/[0.06]" />
          </div>
        </div>
        <div className="h-8 w-16 rounded-[10px] bg-white/[0.06] flex-shrink-0" />
      </div>
    </motion.div>
  );
}

function JobCard({
  jobId,
  job,
  isClient,
  address,
  hasApplied,
  applicants,
  onApplied,
  expanded,
  onToggle,
  index,
}: {
  jobId: bigint;
  job: JobRecord;
  isClient: boolean;
  address?: string;
  hasApplied?: boolean;
  applicants?: string[];
  onApplied?: () => void;
  expanded: boolean;
  onToggle: () => void;
  index: number;
}) {
  const [isApplying, setIsApplying] = useState(false);
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [isAccepting, setIsAccepting] = useState<string | null>(null);
  const [termsText, setTermsText] = useState<string | null>(null);
  const [termsFetching, setTermsFetching] = useState(false);
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const t = useTranslations();
  const timeAgo = useTimeAgo();
  const router = useRouter();

  const ZERO_HASH = "0x" + "0".repeat(64);
  const hasTerms = job.termsHash && job.termsHash !== ZERO_HASH;
  const applicantCount = applicants?.length ?? 0;
  const catKey = extractCategory(job.description);
  const displayDesc = stripCategory(job.description);

  useEffect(() => {
    if (!hasTerms || !expanded || termsFetching || termsText !== null) return;
    setTermsFetching(true);
    fetch(`/api/job-terms?hash=${job.termsHash}`)
      .then(r => r.json())
      .then(data => setTermsText(data.text ?? ''))
      .catch(() => setTermsText(''))
      .finally(() => setTermsFetching(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, hasTerms, job.termsHash]);

  const handleApply = async () => {
    if (!walletClient || !publicClient || isApplying) return;
    if (job.status !== 0) { toast.error('This job is no longer open.'); return; }
    setIsApplying(true);
    try {
      await sendGasless(walletClient, publicClient, "applyForJob", [jobId], DIAMOND_ABI as Abi);
      toast.success(t("board.jobs.applied_waiting"));
      onApplied?.();
    } catch (err: any) {
      toast.error(err?.message?.slice(0, 80) || "Apply failed");
    } finally {
      setIsApplying(false);
    }
  };

  const handleWithdraw = async () => {
    if (!walletClient || !publicClient || isWithdrawing) return;
    if (job.status !== 0) { toast.error('This job is no longer open.'); return; }
    setIsWithdrawing(true);
    try {
      await sendGasless(walletClient, publicClient, "withdrawApplication", [jobId], DIAMOND_ABI as Abi);
      toast.success(t("board.jobs.withdrawn"));
      onApplied?.();
    } catch (err: any) {
      toast.error(err?.message?.slice(0, 80) || "Withdraw failed");
    } finally {
      setIsWithdrawing(false);
    }
  };

  const handleAccept = async (executorAddr: string) => {
    if (!walletClient || !publicClient) return;
    if (job.status !== 0) { toast.error('This job is no longer open.'); return; }
    setIsAccepting(executorAddr);
    try {
      toast(t("board.jobs.accepting"));
      await sendGasless(walletClient, publicClient, "acceptApplicant", [jobId, executorAddr], DIAMOND_ABI as Abi);
      toast.success(t("board.jobs.accepted_deal"));
      // Navigate to the job page where the freshly created deal is shown
      setTimeout(() => { onApplied?.(); router.push(`/job/${jobId.toString()}`); }, 2000);
    } catch (err: any) {
      toast.error(err?.message?.slice(0, 80) || "Accept failed");
    } finally {
      setIsAccepting(null);
    }
  };

  const cappedDelay = Math.min(index, 6) * 0.05;

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.28, delay: cappedDelay, ease: [0.25, 0.46, 0.45, 0.94] }}
      whileHover={{ scale: 1.004 }}
      whileTap={{ scale: 0.993 }}
      style={{ transformOrigin: "center" }}
    >
      <div
        className={`rounded-[22px] border cursor-pointer transition-all duration-200 ${
          expanded
            ? "border-white/[0.12] bg-[#111113]"
            : "border-white/[0.08] bg-[#0d0d0f] hover:bg-[#111113] hover:border-white/[0.13]"
        }`}
        style={{
          boxShadow: expanded
            ? "0 8px 32px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.05)"
            : "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)",
        }}
        onClick={onToggle}
      >
        {/* ── Collapsed row ── */}
        <div className="flex items-center gap-3 px-4 py-3.5">
          <UserAvatar address={job.client} size={28} link />

          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 mb-0.5">
              <span className="font-semibold text-white/90 text-sm truncate leading-snug">
                {job.title || `Job #${jobId.toString()}`}
              </span>
              {isClient && <span className="text-[10px] text-white/25 font-mono flex-shrink-0">{t("board.jobs.yours")}</span>}
            </div>
            <div className="flex items-center gap-2 text-xs flex-wrap">
              {catKey && (
                <span className={`px-1.5 py-0.5 rounded-md border text-[10px] font-medium ${CATEGORY_BADGE[catKey]}`}>
                  {t(`categories.${catKey}`)}
                </span>
              )}
              <span className="font-bold text-white/75 font-mono">{formatBudget(job.amount)} USDC</span>
              <span className="text-white/20">·</span>
              <span className="text-white/35">{job.deadlineDays.toString()}d</span>
              <span className="text-white/20">·</span>
              <span className="text-white/25">{REGION_LABELS[job.region] ?? "—"}</span>
              <span className="text-white/20">·</span>
              <span className="text-white/20">{timeAgo(job.createdAt)}</span>
              {isClient && applicantCount > 0 && (
                <span className="text-violet-400/80 font-mono text-[11px]">{t("board.jobs.applicants_count", { count: applicantCount })}</span>
              )}
              {!isClient && hasApplied && (
                <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400/80 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/70 flex-shrink-0" />
                  {t("board.jobs.applied_tag")}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5 flex-shrink-0" onClick={e => e.stopPropagation()}>
            {!isClient && address && (
              <Button size="sm" variant="ghost" className="h-9 w-9 p-0 text-white/30 hover:text-primary" onClick={() => router.push(`/chat/${job.client}`)}>
                <MessageCircle className="w-3.5 h-3.5" />
              </Button>
            )}
            {!isClient && address && !hasApplied && (
              <Button size="sm" onClick={handleApply} disabled={isApplying} className="h-9 px-3 text-xs gap-1">
                {isApplying ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                {t("board.jobs.apply_btn")}
              </Button>
            )}
            {!isClient && address && hasApplied && job.status === 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleWithdraw}
                disabled={isWithdrawing}
                className="h-9 px-3 text-xs text-white/30 hover:text-red-400 hover:bg-red-400/10 gap-1"
              >
                {isWithdrawing ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                {t("board.jobs.withdraw_btn")}
              </Button>
            )}
          </div>
          <ChevronDown className={`w-3.5 h-3.5 text-white/20 transition-transform flex-shrink-0 ${expanded ? "rotate-180" : ""}`} />
        </div>

        {/* ── Expanded ── */}
        {expanded && (
          <div className="border-t border-white/8 px-4 pb-4 pt-3" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 text-xs text-white/30 mb-3">
              <span>{t("common.by")}</span>
              <UserName address={job.client} link className="font-mono hover:text-white/60 transition-colors" />
            </div>

            {displayDesc && (
              <p className="text-sm text-white/60 leading-relaxed mb-3 whitespace-pre-wrap">{displayDesc}</p>
            )}

            {expanded && hasTerms && (
              <div className="mb-3">
                <p className="text-[10px] text-white/25 uppercase tracking-widest mb-1.5 flex items-center gap-1.5">
                  <FileText className="w-3 h-3" /> {t("board.jobs.terms")}
                </p>
                {termsFetching || !termsText ? (
                  <p className="text-xs text-white/25">{t("common.loading_short")}</p>
                ) : (
                  <p className="text-xs text-white/55 leading-relaxed whitespace-pre-wrap max-h-36 overflow-y-auto">{termsText}</p>
                )}
              </div>
            )}

            {isClient && applicantCount > 0 && (
              <div className="mb-3">
                <p className="text-[10px] text-white/25 uppercase tracking-widest mb-2">
                  {t("board.jobs.applicants_tab")} · {applicantCount}
                </p>
                <div className="space-y-1.5">
                  {applicants!.map(addr => (
                    <div key={addr} className="flex items-center justify-between gap-3 rounded-[14px] bg-white/[0.04] border border-white/[0.07] px-3 py-2.5">
                      <span className="text-xs font-mono text-white/50 truncate min-w-0">{addr}</span>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <Button size="sm" variant="ghost" className="h-8 px-2.5 text-xs text-white/35 hover:text-primary" onClick={() => router.push(`/chat/${addr}`)}>{t("board.jobs.chat_tab")}</Button>
                        <Button size="sm" onClick={() => handleAccept(addr)} disabled={!!isAccepting} className="h-8 px-2.5 text-xs gap-1">
                          {isAccepting === addr ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserCheck className="w-3 h-3" />}
                          {t("board.jobs.accept_btn")}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {isClient && applicantCount === 0 && (
              <p className="text-xs text-white/20 mb-3">{t("board.jobs.no_applicants")}</p>
            )}

            <div className="pt-2 border-t border-white/6">
              <Button size="sm" variant="ghost" className="text-xs text-white/30 hover:text-white/60 h-9 px-2 gap-1.5" onClick={e => { e.stopPropagation(); router.push(`/job/${jobId.toString()}`); }}>
                <ExternalLink className="w-3 h-3" /> {t("board.jobs.full_page")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

export default function BoardPage() {
  const { address, isConnected, status } = useAccount();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const t = useTranslations();

  // DEBUG: trace click events and router.push calls
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const el = e.target as Element;
      console.log('[hexdebug] click captured:', el.tagName, el.textContent?.trim().slice(0, 25));
    };
    document.addEventListener('click', handler, true);
    return () => document.removeEventListener('click', handler, true);
  }, []);

  const [page, setPage] = useState(0);
  const [allJobs, setAllJobs] = useState<GraphJob[]>([]);
  type SortKey = 'newest' | 'oldest' | 'highest' | 'lowest';
  const [sortBy, setSortBy] = useState<SortKey>('newest');

  // Region filter — persisted in localStorage, auto-detected from IP on first visit
  const [regionFilter, setRegionFilter] = useState<number | null>(null);
  const [userRegion, setUserRegion] = useState<number | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<CategoryKey | null>(null);
  const catScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = catScrollRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => { e.preventDefault(); el.scrollLeft += e.deltaY; };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  useEffect(() => {
    const stored = getStoredBoardRegion();
    fetch("/api/region")
      .then(r => r.json())
      .then(data => {
        const detected = data.region as number;
        setUserRegion(detected);
        // Use stored preference if exists, otherwise default to detected region
        if (stored !== null || localStorage.getItem("sig404_board_region") !== null) {
          setRegionFilter(stored);
        } else {
          setRegionFilter(detected);
          storeBoardRegion(detected);
        }
      })
      .catch(() => {
        if (stored !== null) setRegionFilter(stored);
      });
  }, []);

  const handleRegionChange = (v: number | null) => {
    setRegionFilter(v);
    storeBoardRegion(v);
  };

  const { jobs: pageJobs, isLoading, isFetching, hasMore } = useJobs({
    region: regionFilter ?? undefined,
    page,
  });

  // Accumulate pages; reset when region changes
  useEffect(() => {
    if (page === 0) {
      setAllJobs(pageJobs);
    } else if (pageJobs.length > 0) {
      setAllJobs(prev => [...prev, ...pageJobs]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageJobs]);

  useEffect(() => {
    setPage(0);
    setAllJobs([]);
  }, [regionFilter]);

  const jobs = useMemo(() => {
    const q = searchQuery.toLowerCase();
    const filtered = allJobs
      .filter(gj => categoryFilter === null || extractCategory(gj.description) === categoryFilter)
      .filter(gj => {
        if (!q) return true;
        return (
          gj.title.toLowerCase().includes(q) ||
          gj.description.toLowerCase().includes(q) ||
          gj.client.toLowerCase().includes(q) ||
          gj.id.includes(q)
        );
      })
      .map(gj => ({
        id: BigInt(gj.id),
        job: {
          client: gj.client,
          title: gj.title,
          description: gj.description,
          amount: BigInt(gj.amount),
          deadlineDays: BigInt(gj.deadlineDays),
          termsHash: gj.termsHash,
          region: gj.region,
          status: 0,
          createdAt: BigInt(gj.createdAt),
          chosenExecutor: '0x0000000000000000000000000000000000000000',
          agreement: '0x0000000000000000000000000000000000000000',
        } as JobRecord,
      }));
    switch (sortBy) {
      case 'oldest':  return [...filtered].sort((a, b) => Number(a.job.createdAt) - Number(b.job.createdAt));
      case 'highest': return [...filtered].sort((a, b) => Number(b.job.amount) - Number(a.job.amount));
      case 'lowest':  return [...filtered].sort((a, b) => Number(a.job.amount) - Number(b.job.amount));
      default:        return [...filtered].sort((a, b) => Number(b.job.createdAt) - Number(a.job.createdAt));
    }
  }, [allJobs, searchQuery, categoryFilter, sortBy]);

  const { appliedSet, applicantsMap } = useMemo(() => {
    const appliedSet = new Set<string>();
    const applicantsMap = new Map<string, string[]>();
    allJobs.forEach(gj => {
      applicantsMap.set(gj.id, gj.applicants);
      if (address && gj.applicants.some(a => a.toLowerCase() === address.toLowerCase())) {
        appliedSet.add(gj.id);
      }
    });
    return { appliedSet, applicantsMap };
  }, [allJobs, address]);

  // Wallet reconnecting on page reload — show skeleton to avoid flash of "connect" screen
  if (status === 'reconnecting' || status === 'connecting') {
    return (
      <div className="container mx-auto px-4 pt-4 pb-6 max-w-4xl space-y-3">
        {[...Array(5)].map((_, i) => <JobCardSkeleton key={i} />)}
      </div>
    );
  }

  if (!isConnected) {
    return (
      <div
        className="flex items-center justify-center"
        style={{ minHeight: 'calc(100dvh - var(--content-top-offset))' }}
      >
        <div className="text-center max-w-sm px-6">
          <h1 className="text-2xl font-bold font-syne mb-2">{t("board.jobs.title")}</h1>
          <p className="text-muted-foreground mb-6 text-sm">
            {t("board.jobs.connect_prompt")}
          </p>
          <Button onClick={() => router.push("/")}>{t("common.go_home")}</Button>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Page header */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: [0.25, 0.46, 0.45, 0.94] }}
      >
        <div className="container mx-auto px-4 pt-4 pb-6 max-w-6xl">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold font-syne mb-0.5">{t("board.jobs.title")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("board.jobs.subtitle")}{" "}
                <button type="button" onClick={() => { console.log('[hexdebug] router.push /board/client/post'); router.push("/board/client/post"); }} className="text-primary hover:underline">
                  {t("board.jobs.post_own_link")}
                </button>
              </p>
            </div>
            {/* Mobile: Post Job button */}
            <div className="flex items-center gap-2 flex-shrink-0 self-start">
              <Button size="sm" onClick={() => { console.log('[hexdebug] router.push /board/client/post (header btn)'); router.push("/board/client/post"); }}>
                <Plus className="w-4 h-4 mr-1" />
                {t("board.jobs.post_btn")}
              </Button>
            </div>
          </div>
        </div>
      </motion.div>

      <div className="container mx-auto px-4 pt-0 pb-6 max-w-6xl">
        {/* Region filter */}
        <div className="mb-4">
          <BoardRegionFilter
            value={regionFilter}
            onChange={handleRegionChange}
            userRegion={userRegion}
          />
        </div>

        {/* Category filter — horizontal scroll strip */}
        <div
          ref={catScrollRef}
          className="flex overflow-x-auto gap-1.5 mb-5 pb-0.5 -mx-4 px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <motion.button
            whileTap={{ scale: 0.975 }}
            onClick={() => setCategoryFilter(null)}
            className={`flex-shrink-0 px-3 py-1 rounded-full text-xs border transition-colors ${
              categoryFilter === null
                ? "bg-white/10 border-white/20 text-white/80"
                : "border-white/[0.07] text-white/30 hover:border-white/15 hover:text-white/50"
            }`}
          >
            {t("common.all")}
          </motion.button>
          {CATEGORIES.map(({ key, badge }) => (
            <motion.button
              key={key}
              whileTap={{ scale: 0.975 }}
              onClick={() => setCategoryFilter(categoryFilter === key ? null : key)}
              className={`flex-shrink-0 px-3 py-1 rounded-full text-xs border transition-colors ${
                categoryFilter === key ? badge : "border-white/[0.07] text-white/30 hover:border-white/15 hover:text-white/50"
              }`}
            >
              {t(`categories.${key}`)}
            </motion.button>
          ))}
        </div>

        {/* Search */}
        <div className="relative mb-5">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" />
          <Input
            placeholder={t("board.jobs.search_placeholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 bg-[#0d0d0f] border-white/[0.08] placeholder:text-white/20 focus:border-primary/40 rounded-[14px]"
          />
        </div>


        {/* Sort controls */}
        {!isLoading && jobs.length > 0 && (
          <div className="flex items-center gap-1.5 mb-3 flex-wrap">
            <span className="text-xs text-white/25 mr-1">{t("common.sort")}:</span>
            {(['newest','oldest','highest','lowest'] as const).map(key => (
              <button key={key} onClick={() => setSortBy(key)}
                className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                  sortBy === key ? 'bg-white/10 border-white/20 text-white/80' : 'border-white/[0.07] text-white/30 hover:border-white/15 hover:text-white/50'
                }`}>
                {key === 'newest' ? t("board.sort.newest") : key === 'oldest' ? t("board.sort.oldest") : key === 'highest' ? t("board.sort.highest") : t("board.sort.lowest")}
              </button>
            ))}
            <span className="ml-auto text-xs text-white/20">{jobs.length}{hasMore ? '+' : ''}</span>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <JobCardSkeleton key={i} />
            ))}
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-14 h-14 rounded-[18px] bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mb-4">
              <Briefcase className="w-6 h-6 text-white/20" />
            </div>
            <p className="text-white/40 text-sm mb-1">
              {searchQuery ? t("board.jobs.no_results") : t("board.jobs.empty")}
            </p>
            {!searchQuery && (
              <Button size="sm" variant="outline" className="mt-4 border-white/15 text-white/60" onClick={() => { console.log('[hexdebug] router.push /board/client/post (empty state btn)'); router.push("/board/client/post"); }}>
                <Plus className="w-3.5 h-3.5 mr-1" />
                {t("board.jobs.post_first")}
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <AnimatePresence>
                {jobs.map(({ id, job }, index) => (
                  <JobCard
                    key={id.toString()}
                    jobId={id}
                    job={job}
                    isClient={address?.toLowerCase() === job.client?.toLowerCase()}
                    address={address}
                    hasApplied={appliedSet.has(id.toString())}
                    applicants={applicantsMap.get(id.toString())}
                    onApplied={() => {}}
                    expanded={expandedJobId === id.toString()}
                    onToggle={() => setExpandedJobId(prev => prev === id.toString() ? null : id.toString())}
                    index={index}
                  />
                ))}
              </AnimatePresence>
            </div>
            {hasMore && (
              <button
                onClick={() => setPage(p => p + 1)}
                disabled={isFetching}
                className="w-full mt-4 py-2.5 rounded-[14px] border border-white/[0.08] text-sm text-white/40 hover:text-white/70 hover:border-white/15 hover:bg-white/[0.03] transition-colors disabled:opacity-50"
              >
                {isFetching ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : t("common.load_more")}
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}
