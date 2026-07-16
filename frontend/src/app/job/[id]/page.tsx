"use client";

import React, { use, useState, useEffect } from "react";
import { motion } from "framer-motion";
import { useAccount, useReadContract, usePublicClient, useWalletClient } from "wagmi";
import { useRouter } from "next/navigation";
import { DIAMOND_ABI, CONTRACTS } from "@/config/contracts";
import { explorerUrl } from "@/config/chain";
import { sendGasless } from "@/lib/relay";
import type { Abi } from "viem";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "react-hot-toast";
import {
  DollarSign, Calendar, Clock,
  CheckCircle, XCircle, Loader2, ExternalLink, Users, Globe, MessageCircle,
  ChevronRight, AlertCircle, FileText, Receipt,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { CATEGORY_BADGE, extractCategory, stripCategory, extractCustomTag, stripCustomTag } from "@/config/categories";
import { UserName, UserAvatar } from "@/components/UserName";
import { PageCenter } from "@/components/PageCenter";
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

const REGION_LABELS: Record<number, string> = {
  0: "CIS · $2",
  1: "Asia · $4",
  2: "Europe · $7",
  3: "US · $10",
  4: "LATAM · $4",
  5: "CA · $10",
  6: "AU · $7",
};

const JOB_STATUS: Record<number, { label: string; color: string }> = {
  0: { label: "Open",      color: "bg-emerald-400/10 text-emerald-400 border-emerald-400/20" },
  1: { label: "Accepted",  color: "bg-violet-400/10 text-violet-400 border-violet-400/20" },
  2: { label: "Cancelled", color: "bg-gray-400/10 text-gray-400 border-gray-400/20" },
};


function timeAgo(ts: bigint): string {
  const diff = Math.floor(Date.now() / 1000) - Number(ts);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { address } = useAccount();
  const jobId = BigInt(id);
  const t = useTranslations();

  const { data: job, isLoading: jobLoading, isError: jobError, refetch } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: "getJob",
    args: [jobId],
  }) as { data: JobRecord | undefined; isLoading: boolean; isError: boolean; refetch: () => void };

  const { data: applicants, isLoading: applicantsLoading } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: "getApplicants",
    args: [jobId],
  }) as { data: string[] | undefined; isLoading: boolean };

  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const [acceptingExecutor, setAcceptingExecutor] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [confirmExecutor, setConfirmExecutor] = useState<string | null>(null);

  const handleAccept = async (executor: string) => {
    if (!walletClient || !publicClient) { toast.error('Wallet not connected'); return; }
    if (job?.status !== 0) { toast.error('This job is no longer open.'); return; }
    setAcceptingExecutor(executor);
    setIsBusy(true);

    // Pre-check: if there's already an active deal, show a helpful error
    try {
      const hasDeal = await publicClient.readContract({
        address: CONTRACTS.diamond as `0x${string}`,
        abi: DIAMOND_ABI,
        functionName: "hasActivePair",
        args: [job!.client as `0x${string}`, executor as `0x${string}`],
      });
      if (hasDeal) {
        const existingDeal = await publicClient.readContract({
          address: CONTRACTS.diamond as `0x${string}`,
          abi: DIAMOND_ABI,
          functionName: "getActivePair",
          args: [job!.client as `0x${string}`, executor as `0x${string}`],
        }) as string;
        toast.error(
          existingDeal && existingDeal !== "0x0000000000000000000000000000000000000000"
            ? `Active deal already exists: ${existingDeal.slice(0, 10)}… — complete or cancel it first`
            : "Already has an active deal with this executor. Complete or cancel it first."
        );
        setAcceptingExecutor(null);
        setIsBusy(false);
        return;
      }
    } catch {
      // Non-fatal
    }

    try {
      // Gasless: relay pays gas, client signs EIP-712 ForwardRequest (1 signature)
      const result = await sendGasless(
        walletClient,
        publicClient,
        "acceptApplicant",
        [jobId, executor as `0x${string}`],
        DIAMOND_ABI as Abi,
      );
      toast.success(t("job.accept_success"));
      // Relay returns agreementAddr from AgreementDeployed event
      if (result.agreementAddr && result.agreementAddr !== "0x0000000000000000000000000000000000000000") {
        router.push(`/deal/${result.agreementAddr}`);
      } else {
        // Fallback: refetch job and navigate to agreement address
        await refetch();
        setTimeout(() => {
          if (job?.agreement && job.agreement !== "0x0000000000000000000000000000000000000000") {
            router.push(`/deal/${job.agreement}`);
          }
        }, 2000);
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      toast.error(msg.slice(0, 160) || "Accept failed — check console");
      console.error("[Hire] gasless failed:", err);
    } finally {
      setAcceptingExecutor(null);
      setIsBusy(false);
    }
  };

  const handleCancel = async () => {
    if (!walletClient || !publicClient) { toast.error('Wallet not connected'); return; }
    setIsBusy(true);
    try {
      await sendGasless(
        walletClient,
        publicClient,
        "cancelJob",
        [jobId],
        DIAMOND_ABI as Abi,
      );
      toast.success(t("job.cancel_success"));
      refetch();
      setTimeout(() => router.push("/board"), 1500);
    } catch (err: any) {
      toast.error(err?.message?.slice(0, 80) || "Cancel failed");
    } finally {
      setIsBusy(false);
    }
  };

  const isClient   = address?.toLowerCase() === job?.client?.toLowerCase();
  const hasApplied = !!address && (applicants ?? []).some(a => a.toLowerCase() === address.toLowerCase());
  const wasChosen  = !!address && job?.chosenExecutor?.toLowerCase() === address.toLowerCase();

  if (jobLoading) {
    return (
      <div className="container mx-auto px-4 pt-4 pb-6 max-w-4xl space-y-4 animate-pulse">
        <div className="space-y-2">
          <div className="h-3 w-24 rounded bg-white/[0.06]" />
          <div className="h-7 w-3/4 rounded-lg bg-white/[0.06]" />
        </div>
        <div className="rounded-[22px] border border-white/[0.06] bg-[#0d0d0f] p-5 space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="h-2.5 w-12 rounded bg-white/[0.05]" />
                <div className="h-4 w-20 rounded bg-white/[0.06]" />
              </div>
            ))}
          </div>
          <div className="space-y-2 pt-3 border-t border-white/[0.05]">
            <div className="h-2.5 w-10 rounded bg-white/[0.05]" />
            <div className="h-3 w-full rounded bg-white/[0.06]" />
            <div className="h-3 w-5/6 rounded bg-white/[0.06]" />
            <div className="h-3 w-4/6 rounded bg-white/[0.06]" />
          </div>
        </div>
        <div className="rounded-[22px] border border-white/[0.06] bg-[#0d0d0f] p-5">
          <div className="h-3 w-16 rounded bg-white/[0.06] mb-4" />
          <div className="h-3 w-32 rounded bg-white/[0.05]" />
        </div>
      </div>
    );
  }

  if (jobError) {
    return (
      <PageCenter>
        <div className="text-center space-y-4">
          <p className="text-white/40 text-sm">{t("common.error")}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>{t("common.retry")}</Button>
        </div>
      </PageCenter>
    );
  }

  if (!job) {
    return (
      <PageCenter>
        <p className="text-white/40 text-sm">Job not found</p>
      </PageCenter>
    );
  }

  const statusInfo = JOB_STATUS[job.status] ?? JOB_STATUS[0];
  const catKey = extractCategory(job.description);
  const strippedDesc = stripCategory(job.description);
  const customTagLabel = catKey === 'other' ? extractCustomTag(strippedDesc) : null;
  const displayDesc = catKey === 'other' ? stripCustomTag(strippedDesc) : strippedDesc;

  return (
    <>
      {/* Header */}
      <div>
        <div className="container mx-auto px-4 pt-4 pb-3 max-w-4xl">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="text-xs font-mono text-white/30">#{id}</span>
              <Badge className={`text-xs border font-medium ${statusInfo.color}`}>
                {statusInfo.label}
              </Badge>
              {catKey && (
                <span className={`px-1.5 py-0.5 rounded-md border text-[10px] font-medium ${CATEGORY_BADGE[catKey]}`}>
                  {customTagLabel ? `#${customTagLabel}` : t(`categories.${catKey}`)}
                </span>
              )}
            </div>
            <h1 className="text-2xl font-bold font-syne leading-tight">
              {job.title || `Job #${id}`}
            </h1>
          </div>
        </div>
      </div>

      <motion.div
        className="container mx-auto px-4 pt-0 pb-6 max-w-4xl space-y-6"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22 }}
      >

        {/* ── Status guidance banner ── */}
        {/* Gated on !applicantsLoading too: applicants is undefined until it resolves,
            so rendering this before then would flash "waiting for applicants" even
            when applicants already exist, then flip once the count comes in. */}
        {job.status === 0 && isClient && !applicantsLoading && (
          <div className={`rounded-[22px] border px-4 py-3 flex items-start gap-3 ${
            (applicants?.length ?? 0) > 0
              ? 'border-violet-400/30 bg-violet-400/5'
              : 'border-white/10 bg-white/[0.03]'
          }`}>
            {(applicants?.length ?? 0) > 0
              ? <Users className="w-4 h-4 text-violet-400 flex-shrink-0 mt-0.5" />
              : <Clock className="w-4 h-4 text-white/30 flex-shrink-0 mt-0.5" />
            }
            <div>
              <p className="text-sm font-medium text-white/80">
                {(applicants?.length ?? 0) > 0
                  ? t("job.applicants_applied", {count: applicants!.length})
                  : t("job.waiting_applicants")}
              </p>
              <p className="text-xs text-white/35 mt-0.5">
                {(applicants?.length ?? 0) > 0
                  ? t("job.hire_hint")
                  : t("job.waiting_hint")}
              </p>
            </div>
          </div>
        )}

        {job.status === 0 && !isClient && address && hasApplied && (
          <div className="rounded-[22px] border border-sky-400/25 bg-sky-400/5 px-4 py-3 flex items-start gap-3">
            <CheckCircle className="w-4 h-4 text-sky-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-sky-300/80">{t("job.application_sent")}</p>
              <p className="text-xs text-white/35 mt-0.5">{t("job.application_pending_hint")}</p>
            </div>
          </div>
        )}

        {job.status === 0 && !isClient && address && !hasApplied && (
          <p className="text-xs text-white/30 px-1">{t("job.apply_hint")}</p>
        )}

        {job.status === 1 && wasChosen && job.agreement && job.agreement !== '0x0000000000000000000000000000000000000000' && (
          <div className="rounded-[22px] border border-emerald-400/30 bg-emerald-400/5 px-4 py-3 flex items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-emerald-300/90">{t("job.hired_title")}</p>
                <p className="text-xs text-white/35 mt-0.5">{t("job.hired_hint")}</p>
              </div>
            </div>
            <Link href={`/deal/${job.agreement}`}>
              <Button size="sm" className="flex-shrink-0 gap-1">
                {t("job.go_to_deal")}<ChevronRight className="w-3.5 h-3.5" />
              </Button>
            </Link>
          </div>
        )}

        {job.status === 1 && !isClient && !wasChosen && hasApplied && (
          <div className="rounded-[22px] border border-white/[0.08] bg-white/[0.03] px-4 py-3 flex items-start gap-3">
            <AlertCircle className="w-4 h-4 text-white/25 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-white/45">{t("job.not_selected")}</p>
              <p className="text-xs text-white/25 mt-0.5">{t("job.not_selected_hint")}</p>
            </div>
          </div>
        )}

        {/* Details */}
        <div className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] p-5" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
            <div>
              <p className="text-xs text-white/30 mb-1">{t("job.budget_label")}</p>
              <div className="flex items-center gap-1">
                <DollarSign className="w-3.5 h-3.5 text-emerald-400" />
                <span className="font-mono font-semibold text-white">
                  {(Number(job.amount) / 1e6).toFixed(2)} USDC
                </span>
              </div>
            </div>
            <div>
              <p className="text-xs text-white/30 mb-1">{t("job.deadline_label")}</p>
              <div className="flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5 text-white/40" />
                <span className="text-white/80">{job.deadlineDays.toString()} days</span>
              </div>
            </div>
            <div>
              <p className="text-xs text-white/30 mb-1">{t("job.posted_label")}</p>
              <div className="flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-white/40" />
                <span className="text-white/80">{timeAgo(job.createdAt)}</span>
              </div>
            </div>
            <div>
              <p className="text-xs text-white/30 mb-1">{t("job.region_label")}</p>
              <div className="flex items-center gap-1">
                <Globe className="w-3.5 h-3.5 text-white/40" />
                <span className="text-white/80">{REGION_LABELS[job.region] ?? "—"}</span>
              </div>
            </div>
          </div>

          <div className="mb-3">
            <p className="text-xs text-white/30 mb-1">{t("common.role_client")}</p>
            <a
              href={explorerUrl('address', job.client)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm font-mono text-white/60 hover:text-white/90 transition-colors max-w-full"
            >
              <span className="truncate">{job.client}</span>
              <ExternalLink className="w-3 h-3 flex-shrink-0" />
            </a>
          </div>

          {displayDesc && (
            <div className="mb-3">
              <p className="text-xs text-white/30 mb-1.5">{t("job.description_label")}</p>
              <p className="text-sm text-white/70 leading-relaxed whitespace-pre-wrap">
                {displayDesc}
              </p>
            </div>
          )}

          {job.terms?.trim() && (
            <div className="mt-3 pt-3 border-t border-white/8">
              <div className="flex items-center gap-2 mb-2">
                <FileText className="w-3.5 h-3.5 text-white/30 flex-shrink-0" />
                <p className="text-xs text-white/30 uppercase tracking-widest">{t("job.terms_label")}</p>
              </div>
              <p className="text-sm text-white/60 leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto">{job.terms}</p>
            </div>
          )}

          {job.status === 1 && job.agreement && job.agreement !== "0x0000000000000000000000000000000000000000" && (
            <div className="mt-4 pt-4 border-t border-white/8">
              <p className="text-xs text-white/30 mb-1">{t("job.agreement_label")}</p>
              <Link
                href={`/deal/${job.agreement}`}
                className="inline-flex items-center gap-1 text-sm font-mono text-primary hover:underline max-w-full"
              >
                <span className="truncate">{job.agreement}</span>
                <ExternalLink className="w-3 h-3 flex-shrink-0" />
              </Link>
            </div>
          )}

          {isClient && (
            <div className="flex items-center gap-2 mt-4 pt-4 border-t border-white/8">
              <Link href={`/job/${id}/receipt`}>
                <Button variant="ghost" size="sm" className="gap-1.5 text-white/40 hover:text-white/70 hover:bg-white/5">
                  <Receipt className="w-3.5 h-3.5" />
                  Receipt
                </Button>
              </Link>
              {job.status === 0 && (
                <Button variant="ghost" size="sm" onClick={handleCancel} disabled={isBusy}
                  className="gap-1.5 text-red-400/60 hover:text-red-400 hover:bg-red-400/10">
                  {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                  Cancel Job
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Applicants */}
        <div className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] p-5" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
          <div className="flex items-center gap-2 mb-4">
            <Users className="w-4 h-4 text-white/40" />
            <h2 className="text-sm font-semibold text-white/80">
              {t("job.applicants_title")}
              {!applicantsLoading && applicants && (
                <span className="ml-2 text-white/30 font-normal">{applicants.length}</span>
              )}
            </h2>
          </div>

          {applicantsLoading ? (
            <div className="flex items-center gap-2 text-white/30 text-sm py-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading…
            </div>
          ) : !applicants || applicants.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-white/30">{t("job.no_applicants")}</p>
              {!isClient && address && job.status === 0 && (
                <p className="text-xs text-white/20 mt-1">{t("job.be_first_applicant")}</p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {applicants.map((executor) => {
                const isMe = address?.toLowerCase() === executor.toLowerCase();
                const isChosen = job.chosenExecutor?.toLowerCase() === executor.toLowerCase();
                return (
                  <div
                    key={executor}
                    className={`flex items-center justify-between gap-3 rounded-[14px] border p-3 ${
                      isChosen
                        ? "border-violet-400/30 bg-violet-400/5"
                        : "border-white/[0.07] bg-[#0d0d0f]"
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <UserAvatar address={executor} size={32} link />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <UserName address={executor} link className="text-sm font-medium text-white/80 hover:text-white truncate" />
                          {isMe && <span className="text-xs text-white/30 flex-shrink-0">({t("common.you")})</span>}
                          {isChosen && (
                            <Badge className="text-xs border bg-violet-400/10 text-violet-400 border-violet-400/20 flex-shrink-0">
                              Accepted
                            </Badge>
                          )}
                        </div>
                        <a
                          href={explorerUrl('address', executor)}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="font-mono text-[11px] text-white/30 hover:text-white/50 transition-colors truncate block"
                        >
                          {executor.slice(0, 10)}…{executor.slice(-8)}
                        </a>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {/* Chat button — client or any logged-in party */}
                      {address && address.toLowerCase() !== executor.toLowerCase() && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => router.push(`/chat/${executor}`)}
                          className="h-7 w-7 p-0 text-white/40 hover:text-primary"
                          title="Message"
                        >
                          <MessageCircle className="w-3.5 h-3.5" />
                        </Button>
                      )}
                      {isClient && job.status === 0 && (
                        <Button
                          size="sm"
                          onClick={() => setConfirmExecutor(executor)}
                          disabled={isBusy}
                          className="gap-1"
                        >
                          {isBusy && acceptingExecutor === executor ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <CheckCircle className="w-3.5 h-3.5" />
                          )}
                          {t("job.hire_btn")}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </motion.div>

      {/* Hire Confirmation Modal */}
      {confirmExecutor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-black/70 backdrop-blur-sm"
          onClick={() => !isBusy && setConfirmExecutor(null)}
        >
          <div
            className="w-full max-w-md rounded-[22px] border border-white/[0.08] bg-[#111113] p-5"
            style={{ boxShadow: '0 8px 40px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.04)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-5">
              <div className="w-9 h-9 rounded-[12px] bg-amber-400/10 flex items-center justify-center flex-shrink-0">
                <AlertCircle className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h2 className="text-base font-bold font-syne text-white mb-1">{t("job.confirm_hire_title")}</h2>
                <p className="text-sm text-white/50 leading-relaxed">{t("job.confirm_hire_desc")}</p>
              </div>
            </div>

            <div className="rounded-[14px] border border-white/[0.07] bg-[#0d0d0f] divide-y divide-white/6 mb-4">
              <div className="flex justify-between items-center px-4 py-2.5 text-sm">
                <span className="text-white/40">{t("job.executor_label")}</span>
                <span className="font-mono text-white/60 text-xs">{shortAddr(confirmExecutor)}</span>
              </div>
              <div className="flex justify-between items-center px-4 py-2.5 text-sm">
                <span className="text-white/40">{t("job.budget_locked")}</span>
                <span className="font-mono font-semibold text-white">{(Number(job!.amount) / 1e6).toFixed(2)} USDC</span>
              </div>
              <div className="flex justify-between items-center px-4 py-2.5 text-sm">
                <span className="text-white/40">{t("job.deadline_label")}</span>
                <span className="text-white/70">{t("job.deadline_days", { days: job!.deadlineDays.toString() })}</span>
              </div>
              <div className="flex justify-between items-center px-4 py-2.5 text-sm">
                <span className="text-white/40">{t("job.region_fee_label")}</span>
                <span className="text-white/60">{REGION_LABELS[job!.region] ?? '—'}</span>
              </div>
            </div>

            <div className="rounded-[14px] border border-amber-400/15 bg-amber-400/5 px-4 py-3 mb-5">
              <p className="text-xs text-amber-400/80 leading-relaxed">
                {t("job.escrow_warning")}
              </p>
            </div>

            <div className="flex gap-2.5">
              <Button
                variant="ghost"
                className="flex-1 border border-white/10 text-white/50 hover:text-white/80 hover:bg-white/5"
                onClick={() => setConfirmExecutor(null)}
                disabled={isBusy}
              >
                {t("common.cancel")}
              </Button>
              <Button
                className="flex-1 gap-1.5"
                onClick={() => {
                  const exec = confirmExecutor;
                  setConfirmExecutor(null);
                  handleAccept(exec);
                }}
                disabled={isBusy}
              >
                <CheckCircle className="w-3.5 h-3.5" />
                {t("job.confirm_hire_title")}
              </Button>
            </div>
          </div>
        </div>
      )}

    </>
  );
}
