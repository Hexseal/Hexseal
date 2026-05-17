"use client";

import React, { useState, useMemo, useEffect } from "react";
import { useAccount, useReadContract, useReadContracts, usePublicClient, useWalletClient } from "wagmi";
import { DIAMOND_ABI, CONTRACTS } from "@/config/contracts";
import { sendGasless } from "@/lib/relay";
import type { Abi } from "viem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "react-hot-toast";
import {
  Search, Loader2, Briefcase, Plus, RefreshCw, MessageCircle,
  ChevronDown, UserCheck, ExternalLink, FileText,
} from "lucide-react";
import Link from "next/link";
import { UserName } from "@/components/UserName";
import { useTranslations } from "next-intl";
import { BoardRegionFilter, getStoredBoardRegion, storeBoardRegion } from "@/components/BoardRegionFilter";

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

const REGION_LABELS: Record<number, string> = {
  0: "CIS",
  1: "Asia/LATAM",
  2: "Europe",
  3: "US/CA",
};

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatBudget(budget: bigint): string {
  return (Number(budget) / 1e6).toFixed(2);
}

function timeAgo(ts: bigint): string {
  const diff = Math.floor(Date.now() / 1000) - Number(ts);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function JobCard({
  jobId,
  job,
  isClient,
  address,
  hasApplied,
  applicants,
  onApplied,
}: {
  jobId: bigint;
  job: JobRecord;
  isClient: boolean;
  address?: string;
  hasApplied?: boolean;
  applicants?: string[];
  onApplied?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [isAccepting, setIsAccepting] = useState<string | null>(null);
  const [termsText, setTermsText] = useState<string | null>(null);
  const [termsFetching, setTermsFetching] = useState(false);
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const t = useTranslations();

  const ZERO_HASH = "0x" + "0".repeat(64);
  const hasTerms = job.termsHash && job.termsHash !== ZERO_HASH;
  const applicantCount = applicants?.length ?? 0;

  useEffect(() => {
    if (!hasTerms || !expanded || termsFetching || termsText !== null) return;
    setTermsFetching(true);
    fetch(`/api/job-terms?hash=${job.termsHash}`)
      .then(r => r.json())
      .then(data => setTermsText(data.text ?? ''))
      .catch(() => setTermsText(''))
      .finally(() => setTermsFetching(false));
  }, [expanded, hasTerms, job.termsHash]);

  const handleApply = async () => {
    if (!walletClient || !publicClient || isApplying) return;
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

  const handleAccept = async (executorAddr: string) => {
    if (!walletClient || !publicClient) return;
    setIsAccepting(executorAddr);
    try {
      toast(t("board.jobs.accepting"));
      await sendGasless(walletClient, publicClient, "acceptApplicant", [jobId, executorAddr], DIAMOND_ABI as Abi);
      toast.success(t("board.jobs.accepted_deal"));
      setTimeout(() => onApplied?.(), 2500);
    } catch (err: any) {
      toast.error(err?.message?.slice(0, 80) || "Accept failed");
    } finally {
      setIsAccepting(null);
    }
  };

  return (
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
      onClick={() => setExpanded(v => !v)}
    >
      {/* ── Collapsed row ── */}
      <div className="flex items-center gap-3 px-4 py-4">
        <div className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-emerald-400/80 mt-0.5" />

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 mb-0.5">
            <span className="font-semibold text-white/90 text-sm truncate leading-snug">
              {job.title || `Job #${jobId.toString()}`}
            </span>
            {isClient && <span className="text-[10px] text-white/25 font-mono flex-shrink-0">{t("board.jobs.yours")}</span>}
          </div>
          <div className="flex items-center gap-2.5 text-xs flex-wrap">
            <span className="font-bold text-white/75 font-mono">{formatBudget(job.amount)} USDC</span>
            <span className="text-white/25">·</span>
            <span className="text-white/35">{job.deadlineDays.toString()}d</span>
            <span className="text-white/25">·</span>
            <span className="text-white/25">{REGION_LABELS[job.region] ?? "—"}</span>
            <span className="text-white/25">·</span>
            <span className="text-white/25">{timeAgo(job.createdAt)}</span>
            {isClient && applicantCount > 0 && (
              <span className="text-violet-400/80 font-mono text-[11px]">{applicantCount} applied</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0" onClick={e => e.stopPropagation()}>
          {!isClient && address && (
            <Link href={`/chat/${job.client}`}>
              <Button size="sm" variant="ghost" className="h-9 w-9 p-0 text-white/30 hover:text-primary">
                <MessageCircle className="w-3.5 h-3.5" />
              </Button>
            </Link>
          )}
          {!isClient && address && (
            hasApplied ? (
              <span className="text-[11px] text-white/30 font-mono px-1">{t("board.jobs.applied_tag")}</span>
            ) : (
              <Button size="sm" onClick={handleApply} disabled={isApplying} className="h-9 px-3 text-xs gap-1">
                {isApplying ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                {t("board.jobs.apply_btn")}
              </Button>
            )
          )}
        </div>
        <ChevronDown className={`w-3.5 h-3.5 text-white/20 transition-transform flex-shrink-0 ${expanded ? "rotate-180" : ""}`} />
      </div>

      {/* ── Expanded ── */}
      {expanded && (
        <div className="border-t border-white/8 px-4 pb-4 pt-3" onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-2 text-xs text-white/30 mb-3">
            <span>by</span>
            <UserName address={job.client} link className="font-mono hover:text-white/60 transition-colors" />
          </div>

          {job.description && (
            <p className="text-sm text-white/60 leading-relaxed mb-3 whitespace-pre-wrap">{job.description}</p>
          )}

          {hasTerms && (termsFetching || termsText) && (
            <div className="mb-3">
              <p className="text-[10px] text-white/25 uppercase tracking-widest mb-1.5 flex items-center gap-1.5">
                <FileText className="w-3 h-3" /> {t("board.jobs.terms")}
              </p>
              {termsFetching ? (
                <p className="text-xs text-white/25">{t("common.loading")}</p>
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
                      <Link href={`/chat/${addr}`}>
                        <Button size="sm" variant="ghost" className="h-8 px-2.5 text-xs text-white/35 hover:text-primary">{t("board.jobs.chat_tab")}</Button>
                      </Link>
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
            <Link href={`/job/${jobId.toString()}`} onClick={e => e.stopPropagation()}>
              <Button size="sm" variant="ghost" className="text-xs text-white/30 hover:text-white/60 h-9 px-2 gap-1.5">
                <ExternalLink className="w-3 h-3" /> {t("board.jobs.full_page")}
              </Button>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

export default function BoardPage() {
  const { address, isConnected } = useAccount();
  const [searchQuery, setSearchQuery] = useState("");
  const t = useTranslations();

  // Region filter — persisted in localStorage, auto-detected from IP on first visit
  const [regionFilter, setRegionFilter] = useState<number | null>(null);
  const [userRegion, setUserRegion] = useState<number | null>(null);

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

  const { data: openJobsData, isLoading, refetch } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: "getOpenJobs",
  }) as {
    data: [bigint[], JobRecord[]] | undefined;
    isLoading: boolean;
    refetch: () => void;
  };

  const { data: totalJobsData } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: "totalJobs",
  }) as { data: bigint | undefined };

  const jobs = useMemo(() => {
    if (!openJobsData) return [];
    const [ids, records] = openJobsData;
    const q = searchQuery.toLowerCase();
    return ids
      .map((id, i) => ({ id, job: records[i] }))
      .filter(({ job }) => job.status === 0)
      .filter(({ job }) => regionFilter === null || job.region === regionFilter)
      .filter(({ id, job }) => {
        if (!q) return true;
        return (
          job.title?.toLowerCase().includes(q) ||
          job.client?.toLowerCase().includes(q) ||
          id.toString().includes(q)
        );
      });
  }, [openJobsData, searchQuery, regionFilter]);

  // Batch load applicants for all visible jobs
  const applicantContracts = useMemo(() =>
    jobs.map(({ id }) => ({
      address: CONTRACTS.diamond as `0x${string}`,
      abi: DIAMOND_ABI as Abi,
      functionName: 'getApplicants' as const,
      args: [id] as const,
    })),
    [jobs]
  );

  const { data: applicantsResults } = useReadContracts({
    contracts: applicantContracts,
    query: { enabled: jobs.length > 0 },
  });

  const { appliedSet, applicantsMap } = useMemo(() => {
    const appliedSet = new Set<string>();
    const applicantsMap = new Map<string, string[]>();
    jobs.forEach(({ id }, i) => {
      const result = applicantsResults?.[i];
      if (result?.status === 'success') {
        const list = result.result as string[];
        applicantsMap.set(id.toString(), list);
        if (address && list.some(a => a.toLowerCase() === address.toLowerCase())) {
          appliedSet.add(id.toString());
        }
      }
    });
    return { appliedSet, applicantsMap };
  }, [applicantsResults, jobs, address]);

  if (!isConnected) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center max-w-sm">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-6">
            <Briefcase className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-bold font-syne mb-2">{t("board.jobs.title")}</h1>
          <p className="text-muted-foreground mb-6 text-sm">
            {t("board.jobs.connect_prompt")}
          </p>
          <Link href="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Page header */}
      <div className="border-b border-white/[0.06]">
        <div className="container mx-auto px-4 py-6 max-w-4xl">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold font-syne mb-0.5">{t("board.jobs.title")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("board.jobs.subtitle")}{" "}
                <Link href="/board/client/post" className="text-primary hover:underline">
                  {t("board.jobs.post_own_link")}
                </Link>
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 self-start">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => refetch()}
                disabled={isLoading}
                className="text-white/40 hover:text-white/70"
              >
                <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
              </Button>
              <Link href="/board/client/post">
                <Button size="sm">
                  <Plus className="w-4 h-4 mr-1" />
                  {t("board.jobs.post_btn")}
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-6 max-w-4xl">
        {/* Region filter */}
        <div className="mb-4">
          <BoardRegionFilter
            value={regionFilter}
            onChange={handleRegionChange}
            userRegion={userRegion}
          />
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

        {/* Count */}
        <div className="flex items-center gap-2 mb-4">
          <span className="text-xs text-white/30 font-mono">
            {isLoading ? t("board.jobs.loading_short") : `${jobs.length} open job${jobs.length !== 1 ? "s" : ""}`}
          </span>
          {totalJobsData !== undefined && (
            <span className="text-xs text-white/15 font-mono">/ {totalJobsData.toString()} total</span>
          )}
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-24 gap-2 text-white/30">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">{t("board.jobs.loading_long")}</span>
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-14 h-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center mb-4">
              <Briefcase className="w-6 h-6 text-white/25" />
            </div>
            <p className="text-white/40 text-sm mb-1">
              {searchQuery ? t("board.jobs.no_results") : t("board.jobs.empty")}
            </p>
            {!searchQuery && (
              <Link href="/board/client/post">
                <Button size="sm" variant="outline" className="mt-4 border-white/15 text-white/60">
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  {t("board.jobs.post_first")}
                </Button>
              </Link>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {jobs.map(({ id, job }) => (
              <JobCard
                key={id.toString()}
                jobId={id}
                job={job}
                isClient={address?.toLowerCase() === job.client?.toLowerCase()}
                address={address}
                hasApplied={appliedSet.has(id.toString())}
                applicants={applicantsMap.get(id.toString())}
                onApplied={refetch}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
