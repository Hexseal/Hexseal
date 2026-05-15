"use client";

import React, { use, useState, useEffect } from "react";
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
  DollarSign, Calendar, User, Clock,
  CheckCircle, XCircle, Loader2, ExternalLink, Users, Globe, MessageCircle,
  ChevronRight, AlertCircle, FileText,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
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
  0: "CIS · $2",
  1: "Asia/LATAM · $4",
  2: "Europe · $7",
  3: "US/CA · $10",
};

const JOB_STATUS: Record<number, { label: string; color: string }> = {
  0: { label: "Open",      color: "bg-emerald-400/10 text-emerald-400 border-emerald-400/20" },
  1: { label: "Accepted",  color: "bg-violet-400/10 text-violet-400 border-violet-400/20" },
  2: { label: "Cancelled", color: "bg-gray-400/10 text-gray-400 border-gray-400/20" },
};

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

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

  const { data: job, isLoading: jobLoading, refetch } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: "getJob",
    args: [jobId],
  }) as { data: JobRecord | undefined; isLoading: boolean; refetch: () => void };

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
  const [termsText, setTermsText] = useState<string | null>(null);
  const [termsFetching, setTermsFetching] = useState(false);

  useEffect(() => {
    if (!job) return;
    const ZERO_HASH = "0x" + "0".repeat(64);
    if (!job.termsHash || job.termsHash === ZERO_HASH) return;
    setTermsFetching(true);
    fetch(`/api/job-terms?hash=${job.termsHash}`)
      .then(r => r.json())
      .then(data => setTermsText(data.text ?? ''))
      .catch(() => setTermsText(''))
      .finally(() => setTermsFetching(false));
  }, [job?.termsHash]);

  const handleAccept = async (executor: string) => {
    if (!walletClient || !publicClient) { toast.error('Wallet not connected'); return; }
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
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-white/30" />
      </div>
    );
  }

  if (!job) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-white/40 text-sm">Job not found</p>
      </div>
    );
  }

  const statusInfo = JOB_STATUS[job.status] ?? JOB_STATUS[0];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-white/8 bg-white/[0.02]">
        <div className="container mx-auto px-4 py-5 max-w-3xl">
<div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-xs font-mono text-white/30">#{id}</span>
                <Badge className={`text-xs border font-medium ${statusInfo.color}`}>
                  {statusInfo.label}
                </Badge>
              </div>
              <h1 className="text-xl font-bold font-syne leading-tight">
                {job.title || `Job #${id}`}
              </h1>
            </div>
            {isClient && job.status === 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCancel}
                disabled={isBusy}
                className="text-red-400/60 hover:text-red-400 hover:bg-red-400/10 flex-shrink-0"
              >
                <XCircle className="w-4 h-4 mr-1" />
                Cancel
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-6 max-w-3xl space-y-6">

        {/* ── Status guidance banner ── */}
        {job.status === 0 && isClient && (
          <div className={`rounded-xl border px-4 py-3 flex items-start gap-3 ${
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
          <div className="rounded-xl border border-sky-400/25 bg-sky-400/5 px-4 py-3 flex items-start gap-3">
            <CheckCircle className="w-4 h-4 text-sky-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-sky-300/80">{t("job.application_sent")}</p>
              <p className="text-xs text-white/35 mt-0.5">{t("job.application_pending_hint")}</p>
            </div>
          </div>
        )}

        {job.status === 0 && !isClient && address && !hasApplied && (
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 flex items-start gap-3">
            <ChevronRight className="w-4 h-4 text-white/30 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-white/60">{t("job.apply_title")}</p>
              <p className="text-xs text-white/30 mt-0.5">{t("job.apply_hint")}</p>
            </div>
          </div>
        )}

        {job.status === 1 && wasChosen && job.agreement && job.agreement !== '0x0000000000000000000000000000000000000000' && (
          <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/5 px-4 py-3 flex items-center justify-between gap-3">
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
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 flex items-start gap-3">
            <AlertCircle className="w-4 h-4 text-white/25 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-white/45">{t("job.not_selected")}</p>
              <p className="text-xs text-white/25 mt-0.5">{t("job.not_selected_hint")}</p>
            </div>
          </div>
        )}

        {/* Details */}
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
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

          {job.description && (
            <div className="mb-3">
              <p className="text-xs text-white/30 mb-1.5">{t("job.description_label")}</p>
              <p className="text-sm text-white/70 leading-relaxed whitespace-pre-wrap">
                {job.description}
              </p>
            </div>
          )}

          {job.termsHash && job.termsHash !== "0x" + "0".repeat(64) && (
            <div className="mt-3 pt-3 border-t border-white/8">
              <div className="flex items-center gap-2 mb-2">
                <FileText className="w-3.5 h-3.5 text-white/30 flex-shrink-0" />
                <p className="text-xs text-white/30 uppercase tracking-widest">{t("job.terms_label")}</p>
              </div>
              {termsFetching ? (
                <p className="text-sm text-white/30">Loading…</p>
              ) : termsText ? (
                <p className="text-sm text-white/60 leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto">{termsText}</p>
              ) : (
                <p className="text-sm text-white/30">{t("job.terms_on_chain")} · Hash: {job.termsHash.slice(0, 14)}…</p>
              )}
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
        </div>

        {/* Applicants */}
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
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
            <div className="space-y-2">
              {applicants.map((executor) => {
                const isMe = address?.toLowerCase() === executor.toLowerCase();
                const isChosen = job.chosenExecutor?.toLowerCase() === executor.toLowerCase();
                return (
                  <div
                    key={executor}
                    className={`flex items-center justify-between gap-3 rounded-xl border p-3 ${
                      isChosen
                        ? "border-violet-400/30 bg-violet-400/5"
                        : "border-white/8 bg-white/[0.02]"
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <User className="w-3.5 h-3.5 text-white/30 flex-shrink-0" />
                      <a
                        href={explorerUrl('address', executor)}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="font-mono text-sm text-white/60 hover:text-white/90 transition-colors truncate min-w-0"
                      >
                        {executor}
                      </a>
                      {isMe && <span className="text-xs text-white/30 flex-shrink-0">({t("common.you")})</span>}
                      {isChosen && (
                        <Badge className="text-xs border bg-violet-400/10 text-violet-400 border-violet-400/20 flex-shrink-0">
                          Accepted
                        </Badge>
                      )}
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
      </div>

      {/* Hire Confirmation Modal */}
      {confirmExecutor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={() => !isBusy && setConfirmExecutor(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-white/12 bg-[#111118] p-6 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-5">
              <div className="w-9 h-9 rounded-full bg-amber-400/10 flex items-center justify-center flex-shrink-0">
                <AlertCircle className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h2 className="text-base font-bold font-syne text-white mb-1">{t("job.confirm_hire_title")}</h2>
                <p className="text-sm text-white/50 leading-relaxed">{t("job.confirm_hire_desc")}</p>
              </div>
            </div>

            <div className="rounded-xl border border-white/8 bg-white/[0.03] divide-y divide-white/6 mb-4">
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

            <div className="rounded-xl border border-amber-400/15 bg-amber-400/5 px-4 py-3 mb-5">
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

    </div>
  );
}
