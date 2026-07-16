"use client";

import React, { useState, useMemo, useEffect, useRef } from "react";
import { useAccount, usePublicClient, useWalletClient, useReadContract } from "wagmi";
import { useJobs, type GraphJob } from "@/hooks/useJobs";
import { DIAMOND_ABI, CONTRACTS } from "@/config/contracts";
import { sendGasless } from "@/lib/relay";
import type { Abi } from "viem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "react-hot-toast";
import {
  Search, Loader2, Briefcase, Plus, MessageCircle,
  ChevronDown, UserCheck, ExternalLink, FileText, RefreshCw,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { UserName, UserAvatar } from "@/components/UserName";
import { useTranslations } from "next-intl";
import { BoardRegionFilter, REGION_LABELS, getStoredBoardRegion, storeBoardRegion } from "@/components/BoardRegionFilter";
import { CATEGORIES, CATEGORY_BADGE, type CategoryKey, extractCategory, stripCategory, extractCustomTag, stripCustomTag } from "@/config/categories";
import { useProfile } from "@/hooks/useProfile";
import { Sparkles } from "lucide-react";
import { ContextHint } from "@/components/ContextHint";
import { shortAddr } from "@/lib/utils";

interface JobRecord {
  client: string;
  title: string;
  description: string;
  amount: bigint;
  deadlineDays: bigint;
  terms: string;
  region: number;
  status: number;
  createdAt: bigint;
  chosenExecutor: string;
  agreement: string;
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
    <div className="animate-pulse rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] min-h-[80px]">
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
    </div>
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
  onJobFilled,
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
  onJobFilled?: (id: string) => void;
  expanded: boolean;
  onToggle: () => void;
  index: number;
}) {
  const [isApplying, setIsApplying] = useState(false);
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [isAccepting, setIsAccepting] = useState<string | null>(null);
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const t = useTranslations();
  const timeAgo = useTimeAgo();
  const router = useRouter();

  // On-chain status re-check when card is expanded — catches subgraph lag
  const { data: onChainJob } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getJob',
    args: [jobId],
    query: { enabled: expanded },
  }) as { data: JobRecord | undefined };
  const onChainStatus = onChainJob ? Number((onChainJob as any).status ?? 0) : job.status;
  const isFilled = onChainStatus !== 0;

  const hasTerms = !!job.terms?.trim();
  const applicantCount = applicants?.length ?? 0;
  const catKey = extractCategory(job.description);
  const strippedDesc = stripCategory(job.description);
  const customTagLabel = catKey === 'other' ? extractCustomTag(strippedDesc) : null;
  const displayDesc = catKey === 'other' ? stripCustomTag(strippedDesc) : strippedDesc;

  const handleApply = async () => {
    if (!walletClient || !publicClient || isApplying) return;
    if (isFilled) { toast.error(t("board.jobs.no_longer_open")); return; }
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
    if (isFilled) { toast.error(t("board.jobs.no_longer_open")); return; }
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
    if (isFilled) { toast.error(t("board.jobs.no_longer_open")); return; }
    setIsAccepting(executorAddr);
    try {
      toast(t("board.jobs.accepting"));
      const result = await sendGasless(walletClient, publicClient, "acceptApplicant", [jobId, executorAddr], DIAMOND_ABI as Abi);
      toast.success(t("board.jobs.accepted_deal"));
      onJobFilled?.(jobId.toString());
      const ZERO = "0x0000000000000000000000000000000000000000";
      if (result.agreementAddr && result.agreementAddr !== ZERO) {
        setTimeout(() => router.push(`/deal/${result.agreementAddr}`), 1500);
      } else {
        setTimeout(() => router.push(`/job/${jobId.toString()}`), 2000);
      }
    } catch (err: any) {
      toast.error(err?.message?.slice(0, 80) || "Accept failed");
    } finally {
      setIsAccepting(null);
    }
  };

  const cappedDelay = Math.min(index, 6) * 0.05;

  return (
    <div className="active:scale-[0.993] transition-transform duration-100">
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
        <div className="flex items-center gap-3 px-4 py-3">
          <UserAvatar address={job.client} size={24} link />

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5">
              <p className="text-[13px] font-semibold text-white/90 truncate leading-snug">
                {job.title || `Job #${jobId.toString()}`}
              </p>
              {catKey && (
                <span className={`flex-shrink-0 px-1.5 py-0.5 rounded-md border text-[10px] font-medium ${CATEGORY_BADGE[catKey]}`}>
                  {customTagLabel ? `#${customTagLabel}` : t(`categories.${catKey}`)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${hasApplied ? 'bg-emerald-400' : 'bg-sky-400/60'}`} />
              <span className="text-[11px] font-mono text-white/55">{formatBudget(job.amount)} USDC</span>
              <span className="text-[11px] text-white/15">·</span>
              <span className="text-[11px] text-white/35">{job.deadlineDays.toString()}d deadline</span>
              <span className="text-[11px] text-white/15">·</span>
              <span className="text-[11px] text-white/25">{timeAgo(job.createdAt)}</span>
              {isClient && applicantCount > 0 && (
                <>
                  <span className="text-[11px] text-white/15">·</span>
                  <span className="text-[11px] font-medium text-violet-400/70">{applicantCount}</span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
            {!isClient && address && (
              <button className="w-7 h-7 flex items-center justify-center text-white/25 hover:text-white/60 transition-colors"
                onClick={() => router.push(`/chat?peer=${job.client}`)}>
                <MessageCircle className="w-3.5 h-3.5" />
              </button>
            )}
            {!isClient && address && !hasApplied && (
              <Button size="sm" onClick={handleApply} disabled={isApplying || isFilled} className="h-7 px-2.5 text-xs">
                {isApplying ? <Loader2 className="w-3 h-3 animate-spin" /> : t("board.jobs.apply_btn")}
              </Button>
            )}
            {!isClient && address && hasApplied && !isFilled && (
              <Button size="sm" variant="ghost" onClick={handleWithdraw} disabled={isWithdrawing}
                className="h-7 px-2 text-xs text-white/25 hover:text-red-400 hover:bg-red-400/10">
                {isWithdrawing ? <Loader2 className="w-3 h-3 animate-spin" /> : t("board.jobs.withdraw_btn")}
              </Button>
            )}
            <ChevronDown className={`w-3.5 h-3.5 text-white/20 transition-transform ml-0.5 ${expanded ? "rotate-180" : ""}`} />
          </div>
        </div>

        {/* ── Expanded ── */}
        {expanded && (
          <div className="border-t border-white/8 px-4 pb-4 pt-3" onClick={e => e.stopPropagation()}>
            {/* Filled / cancelled notice */}
            {isFilled && (
              <div className="rounded-[12px] border border-orange-400/20 bg-orange-400/5 px-3 py-2 mb-3">
                <p className="text-xs text-orange-300/80 font-medium">{t("board.jobs.job_filled_notice")}</p>
              </div>
            )}
            {/* Full title (collapsed row truncates it) */}
            {job.title && (
              <p className="font-semibold text-white/90 text-sm mb-2 leading-snug">{job.title}</p>
            )}

            <div className="flex items-center gap-2 text-xs text-white/30 mb-2">
              <span>{t("common.by")}</span>
              <UserName address={job.client} link className="font-mono hover:text-white/60 transition-colors" />
            </div>

            {/* Meta: category · deadline · region · time · applicants */}
            <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-white/30 mb-3">
              {catKey && (
                <span className={`px-1.5 py-0.5 rounded-md border text-[10px] font-medium flex-shrink-0 ${CATEGORY_BADGE[catKey]}`}>
                  {customTagLabel ? `#${customTagLabel}` : t(`categories.${catKey}`)}
                </span>
              )}
              <span className="whitespace-nowrap">{job.deadlineDays.toString()}d</span>
              <span className="text-white/15">·</span>
              <span className="whitespace-nowrap">{REGION_LABELS[job.region] ?? "—"}</span>
              <span className="text-white/15">·</span>
              <span className="whitespace-nowrap text-white/20">{timeAgo(job.createdAt)}</span>
              {isClient && applicantCount > 0 && (
                <span className="text-violet-400/70 font-mono ml-1">{t("board.jobs.applicants_count", { count: applicantCount })}</span>
              )}
            </div>

            {displayDesc && (
              <p className="text-sm text-white/60 leading-relaxed mb-3 whitespace-pre-wrap">{displayDesc}</p>
            )}

            {hasTerms && (
              <div className="mb-3">
                <p className="text-[10px] text-white/25 uppercase tracking-widest mb-1.5 flex items-center gap-1.5">
                  <FileText className="w-3 h-3" /> {t("board.jobs.terms")}
                </p>
                <p className="text-xs text-white/55 leading-relaxed whitespace-pre-wrap max-h-36 overflow-y-auto">{job.terms}</p>
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
                        <Button size="sm" variant="ghost" className="h-8 px-2.5 text-xs text-white/35 hover:text-primary" onClick={() => router.push(`/chat?peer=${addr}`)}>{t("board.jobs.chat_tab")}</Button>
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

            {/* Footer: full-page link only — actions stay in the header row */}
            <div className="pt-2.5 border-t border-white/6">
              <Button size="sm" variant="ghost" className="text-xs text-white/30 hover:text-white/60 h-8 px-2 gap-1.5"
                onClick={e => { e.stopPropagation(); router.push(`/job/${jobId.toString()}`); }}>
                <ExternalLink className="w-3 h-3" /> {t("board.jobs.full_page")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function BoardPage() {
  const { address, isConnected, status } = useAccount();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const { profile: userProfile } = useProfile(address);
  const t = useTranslations();

  const [page, setPage] = useState(0);
  const [allJobs, setAllJobs] = useState<GraphJob[]>([]);
  const [filledJobIds, setFilledJobIds] = useState<Set<string>>(new Set());

  const handleJobFilled = (id: string) => {
    setFilledJobIds(prev => new Set([...prev, id]));
  };
  type SortKey = 'newest' | 'oldest' | 'highest' | 'lowest';
  const [sortBy, setSortBy] = useState<SortKey>('newest');

  // Region filter — persisted in localStorage, auto-detected from IP on first visit
  const [regionFilter, setRegionFilter] = useState<number | null>(null);
  const [userRegion, setUserRegion] = useState<number | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<CategoryKey | null>(null);
  const [customTagFilter, setCustomTagFilter] = useState<string | null>(null);
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
        // Use stored preference if user explicitly set one; otherwise default to Global (null)
        if (localStorage.getItem("hexseal_board_region") !== null) {
          setRegionFilter(stored);
        }
        // If no stored preference: leave regionFilter as null (show all jobs)
      })
      .catch(() => {
        if (stored !== null) setRegionFilter(stored);
      });
  }, []);

  const handleRegionChange = (v: number | null) => {
    setRegionFilter(v);
    storeBoardRegion(v);
  };

  const { jobs: pageJobs, isLoading, isFetching, hasMore, error: jobsError, refetch: refetchJobs } = useJobs({
    region: regionFilter ?? undefined,
    page,
  });

  useEffect(() => {
    if (jobsError) console.error('[Board] subgraph error:', jobsError);
  }, [jobsError]);

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

  // page=0: use pageJobs directly so urql cache renders immediately on mount/remount.
  // page>0: use the accumulated array (Load More appends to allJobs via effect).
  const displayJobs = page === 0 ? pageJobs : allJobs;

  const JOB_STATUS: Record<string, number> = { open: 0, accepted: 1, cancelled: 2 };

  const popularCustomTags = useMemo(() => {
    const counts = new Map<string, number>();
    displayJobs.forEach(gj => {
      if (extractCategory(gj.description) !== 'other') return;
      const tag = extractCustomTag(stripCategory(gj.description));
      if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    });
    return Array.from(counts.entries())
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([tag]) => tag);
  }, [displayJobs]);

  const jobs = useMemo(() => {
    const q = searchQuery.toLowerCase();
    const filtered = displayJobs
      .filter(gj => !filledJobIds.has(gj.id))
      .filter(gj => categoryFilter === null || extractCategory(gj.description) === categoryFilter)
      .filter(gj => {
        if (!customTagFilter) return true;
        if (extractCategory(gj.description) !== 'other') return false;
        return stripCategory(gj.description).startsWith(`[${customTagFilter}] `);
      })
      .filter(gj => {
        if (!q) return true;
        const catKey = extractCategory(gj.description) ?? '';
        const stripped = stripCategory(gj.description);
        const tag = catKey === 'other' ? (extractCustomTag(stripped) ?? '') : '';
        const cleanDesc = catKey === 'other' ? stripCustomTag(stripped) : stripped;
        const hay = `${gj.title} ${cleanDesc} ${catKey} ${tag}`.toLowerCase();
        return hay.includes(q);
      })
      .map(gj => ({
        id: BigInt(gj.id),
        job: {
          client: gj.client,
          title: gj.title,
          description: gj.description,
          amount: BigInt(gj.amount),
          deadlineDays: BigInt(gj.deadlineDays),
          terms: gj.terms,
          region: gj.region,
          status: JOB_STATUS[gj.status] ?? 0,
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
  }, [displayJobs, filledJobIds, searchQuery, categoryFilter, customTagFilter, sortBy]);

  // Skill-based matching — only when no filters/search active and user has specializations
  const matchedJobs = useMemo(() => {
    const specs = userProfile?.specializations;
    if (!specs || specs.length === 0) return [];
    if (searchQuery || categoryFilter) return [];
    const keywords = specs.map(s => s.toLowerCase());
    return displayJobs
      .filter(gj => gj.client.toLowerCase() !== address?.toLowerCase())
      .filter(gj => {
        const haystack = `${gj.title} ${gj.description}`.toLowerCase();
        return keywords.some(kw => haystack.includes(kw));
      })
      .slice(0, 5);
  }, [displayJobs, userProfile, searchQuery, categoryFilter]);

  const { appliedSet, applicantsMap } = useMemo(() => {
    const appliedSet = new Set<string>();
    const applicantsMap = new Map<string, string[]>();
    displayJobs.forEach(gj => {
      applicantsMap.set(gj.id, gj.applicants);
      if (address && gj.applicants.some(a => a.toLowerCase() === address.toLowerCase())) {
        appliedSet.add(gj.id);
      }
    });
    return { appliedSet, applicantsMap };
  }, [displayJobs, address]);

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
      <div className="page-enter">
        <div className="container mx-auto px-4 pt-4 pb-6 max-w-6xl">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold font-syne mb-0.5">{t("board.jobs.title")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("board.jobs.subtitle")}{" "}
                <button type="button" onClick={() => router.push("/board/client/post")} className="text-primary hover:underline">
                  {t("board.jobs.post_own_link")}
                </button>
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 self-start">
              <Button variant="ghost" size="sm" onClick={() => { setAllJobs([]); setPage(0); refetchJobs(); }} disabled={isFetching} className="text-white/40 hover:text-white/70">
                <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
              </Button>
              <Button size="sm" onClick={() => router.push("/board/client/post")}>
                <Plus className="w-4 h-4 mr-1" />
                {t("board.jobs.post_btn")}
              </Button>
            </div>
          </div>
        </div>
      </div>

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
          <button
            onClick={() => { setCategoryFilter(null); setCustomTagFilter(null); }}
            className={`flex-shrink-0 px-3 py-1 rounded-full text-xs border transition-colors active:scale-[0.975] ${
              categoryFilter === null
                ? "bg-white/10 border-white/20 text-white/80"
                : "border-white/[0.07] text-white/30 hover:border-white/15 hover:text-white/50"
            }`}
          >
            {t("common.all")}
          </button>
          {CATEGORIES.map(({ key, badge }) => (
            <button
              key={key}
              onClick={() => { setCategoryFilter(categoryFilter === key ? null : key); setCustomTagFilter(null); }}
              className={`flex-shrink-0 px-3 py-1 rounded-full text-xs border transition-colors active:scale-[0.975] ${
                categoryFilter === key && !customTagFilter ? badge : "border-white/[0.07] text-white/30 hover:border-white/15 hover:text-white/50"
              }`}
            >
              {t(`categories.${key}`)}
            </button>
          ))}
          {popularCustomTags.map(tag => (
            <button
              key={`ctag-${tag}`}
              onClick={() => {
                if (customTagFilter === tag) { setCustomTagFilter(null); setCategoryFilter(null); }
                else { setCategoryFilter('other'); setCustomTagFilter(tag); }
              }}
              className={`flex-shrink-0 px-3 py-1 rounded-full text-xs border transition-colors active:scale-[0.975] ${
                customTagFilter === tag
                  ? CATEGORY_BADGE['other']
                  : "border-white/[0.07] text-white/30 hover:border-white/15 hover:text-white/50"
              }`}
            >
              #{tag}
            </button>
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


        {/* "For you" matched jobs section */}
        {!isLoading && matchedJobs.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-3.5 h-3.5 text-primary/60" />
              <span className="text-xs font-semibold text-white/40 uppercase tracking-wider">
                {t("board.matching_title")}
              </span>
              <span className="text-xs text-white/20">· {t("board.matching_sub")}</span>
            </div>
            <div className="space-y-3">
              {matchedJobs.map((gj, index) => {
                const id = BigInt(gj.id);
                const job: JobRecord = {
                  client: gj.client,
                  title: gj.title,
                  description: gj.description,
                  amount: BigInt(gj.amount),
                  deadlineDays: BigInt(gj.deadlineDays),
                  terms: gj.terms,
                  region: gj.region,
                  status: 0,
                  createdAt: BigInt(gj.createdAt),
                  chosenExecutor: '0x0000000000000000000000000000000000000000',
                  agreement: '0x0000000000000000000000000000000000000000',
                };
                return (
                  <JobCard
                    key={gj.id}
                    jobId={id}
                    job={job}
                    isClient={address?.toLowerCase() === gj.client?.toLowerCase()}
                    address={address}
                    hasApplied={appliedSet.has(gj.id)}
                    applicants={applicantsMap.get(gj.id)}
                    onApplied={() => {}}
                    onJobFilled={handleJobFilled}
                    expanded={expandedJobId === gj.id}
                    onToggle={() => setExpandedJobId(prev => prev === gj.id ? null : gj.id)}
                    index={index}
                  />
                );
              })}
            </div>
            <div className="mt-3 mb-2 border-t border-white/[0.05]" />
          </div>
        )}

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
          </div>
        )}

        {!isLoading && jobs.length > 0 && (
          <div className="mb-4">
            <ContextHint hintKey="board_apply">{t("hints.board_apply")}</ContextHint>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <JobCardSkeleton key={i} />
            ))}
          </div>
        ) : jobsError ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 rounded-[14px] border border-red-400/20 bg-red-400/5 px-4 py-3 text-xs text-red-400/80">
              {t("common.error")}
            </div>
            <Button size="sm" variant="outline" className="border-white/15 text-white/60" onClick={() => refetchJobs()}>
              {t("common.retry")}
            </Button>
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-14 h-14 rounded-[18px] bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mb-4">
              <Briefcase className="w-6 h-6 text-white/20" />
            </div>
            <p className="text-white/40 text-sm mb-1">
              {searchQuery
                ? t("board.jobs.no_results")
                : regionFilter !== null
                  ? t("board.jobs.no_region_results", { region: REGION_LABELS[regionFilter] ?? '' })
                  : t("board.jobs.empty")}
            </p>
            {!searchQuery && regionFilter !== null ? (
              <Button size="sm" variant="outline" className="mt-4 border-white/15 text-white/60" onClick={() => handleRegionChange(null)}>
                {t("board.jobs.show_global")}
              </Button>
            ) : !searchQuery && (
              <Button size="sm" variant="outline" className="mt-4 border-white/15 text-white/60" onClick={() => router.push("/board/client/post")}>
                <Plus className="w-3.5 h-3.5 mr-1" />
                {t("board.jobs.post_first")}
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="space-y-4">
              {jobs.map(({ id, job }, index) => (
                <div key={id.toString()} className="card-enter" style={{ animationDelay: `${Math.min(index, 8) * 0.04}s` }}>
                  <JobCard
                    jobId={id}
                    job={job}
                    isClient={address?.toLowerCase() === job.client?.toLowerCase()}
                    address={address}
                    hasApplied={appliedSet.has(id.toString())}
                    applicants={applicantsMap.get(id.toString())}
                    onApplied={() => {}}
                    onJobFilled={handleJobFilled}
                    expanded={expandedJobId === id.toString()}
                    onToggle={() => setExpandedJobId(prev => prev === id.toString() ? null : id.toString())}
                    index={index}
                  />
                </div>
              ))}
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
