"use client";

import React, { use, useState } from "react";
import { useAccount, useReadContract, usePublicClient, useWalletClient } from "wagmi";
import { useRouter } from "next/navigation";
import { DIAMOND_ABI, CONTRACTS } from "@/config/contracts";
import { explorerUrl } from "@/config/chain";
import { sendGasless, sendAgreementGasless } from "@/lib/relay";
import { AGREEMENT_ABI } from "@/config/contracts";
import type { Abi } from "viem";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "react-hot-toast";
import {
  DollarSign, Calendar, Clock, Globe, ExternalLink,
  CheckCircle, XCircle, Loader2, ChevronRight, AlertCircle,
  Briefcase, User, ArrowLeft,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { CATEGORY_BADGE, extractCategory, stripCategory } from "@/config/categories";

interface HireRequestRecord {
  client: string;
  serviceId: bigint;
  amount: bigint;
  deadlineDays: bigint;
  termsHash: string;
  region: number;
  status: number; // 0=PENDING 1=ACCEPTED 2=REJECTED 3=CANCELLED
  createdAt: bigint;
  agreement: string;
}

interface ServiceRecord {
  executor: string;
  title: string;
  description: string;
  price: bigint;
  deadlineDays: bigint;
  region: number;
  status: number;
  createdAt: bigint;
  hiresCount: bigint;
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

const REQUEST_STATUS: Record<number, { label: string; color: string }> = {
  0: { label: "Pending",   color: "bg-sky-400/10 text-sky-400 border-sky-400/20" },
  1: { label: "Accepted",  color: "bg-emerald-400/10 text-emerald-400 border-emerald-400/20" },
  2: { label: "Rejected",  color: "bg-red-400/10 text-red-400 border-red-400/20" },
  3: { label: "Cancelled", color: "bg-white/5 text-white/40 border-white/10" },
};

function fmt(amount: bigint) {
  return (Number(amount) / 1e6).toFixed(2);
}

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

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export default function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const requestId = BigInt(id);
  const [isBusy, setIsBusy] = useState<"accept" | "reject" | "cancel" | null>(null);

  const { data: req, isLoading: reqLoading, refetch } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: "getRequest",
    args: [requestId],
  }) as { data: HireRequestRecord | undefined; isLoading: boolean; refetch: () => void };

  const { data: service, isLoading: serviceLoading } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: "getService",
    args: [req?.serviceId ?? 0n],
    query: { enabled: !!req },
  }) as { data: ServiceRecord | undefined; isLoading: boolean };

  const isLoading = reqLoading || (!!req && serviceLoading);

  const isClient   = !!address && req?.client?.toLowerCase() === address.toLowerCase();
  const isExecutor = !!address && service?.executor?.toLowerCase() === address.toLowerCase();
  const hasDeal    = req?.agreement && req.agreement !== ZERO_ADDR;

  const handleAction = async (action: "accept" | "reject" | "cancel") => {
    if (!walletClient || !publicClient) { toast.error("Wallet not connected"); return; }
    if (action === "accept" && service?.status !== 0) {
      toast.error("This service is no longer active.");
      return;
    }
    setIsBusy(action);
    const labels = { accept: "Accepting…", reject: "Rejecting…", cancel: "Cancelling…" };
    const ok     = { accept: "Request accepted — deal created!", reject: "Request rejected.", cancel: "Request cancelled." };
    toast(labels[action]);
    try {
      const fnName = action === "accept" ? "acceptRequest" : action === "reject" ? "rejectRequest" : "cancelRequest";
      const result = await sendGasless(walletClient, publicClient, fnName, [requestId], DIAMOND_ABI as Abi);

      if (action === "accept") {
        await refetch();
        const agreementAddr = result?.agreementAddr;
        if (agreementAddr && agreementAddr !== ZERO_ADDR) {
          // Auto-activate: executor already confirmed by accepting — no second step needed
          try {
            toast("Starting work…");
            await sendAgreementGasless(
              walletClient,
              publicClient,
              agreementAddr as `0x${string}`,
              "activate",
              AGREEMENT_ABI as Abi,
            );
            toast.success("Request accepted — work started!");
          } catch {
            toast.success("Request accepted — deal created. Open the deal to start work.");
          }
          router.push(`/deal/${agreementAddr}`);
        } else {
          toast.success(ok[action]);
          setTimeout(() => refetch(), 2000);
        }
      } else {
        toast.success(ok[action]);
        setTimeout(() => refetch(), 2000);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg.slice(0, 120) || `${action} failed`);
    } finally {
      setIsBusy(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-white/30" />
      </div>
    );
  }

  if (!req) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-white/40 text-sm">Request not found</p>
      </div>
    );
  }

  const statusInfo = REQUEST_STATUS[req.status] ?? REQUEST_STATUS[0];
  const t = useTranslations();
  const catKey = service ? extractCategory(service.description) : null;
  const displayDesc = service ? stripCategory(service.description) : null;

  return (
    <>
      {/* Header */}
      <div className="border-b border-white/[0.06]">
        <div className="container mx-auto px-4 py-5 max-w-3xl">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <Link href="/dashboard" className="text-white/30 hover:text-white/60 transition-colors">
                  <ArrowLeft className="w-3.5 h-3.5" />
                </Link>
                <span className="text-xs font-mono text-white/30">Request #{id}</span>
                <Badge className={`text-xs border font-medium ${statusInfo.color}`}>
                  {statusInfo.label}
                </Badge>
                {catKey && (
                  <span className={`px-1.5 py-0.5 rounded-md border text-[10px] font-medium ${CATEGORY_BADGE[catKey]}`}>
                    {t(`categories.${catKey}`)}
                  </span>
                )}
              </div>
              <h1 className="text-xl font-bold font-syne leading-tight">
                {service?.title ?? `Service #${req.serviceId.toString()}`}
              </h1>
            </div>
            {/* Inline action buttons for pending requests */}
            {req.status === 0 && (
              <div className="flex items-center gap-2 flex-shrink-0">
                {isClient && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleAction("cancel")}
                    disabled={!!isBusy}
                    className="text-red-400/60 hover:text-red-400 hover:bg-red-400/10"
                  >
                    {isBusy === "cancel" ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4 mr-1" />}
                    Cancel
                  </Button>
                )}
                {isExecutor && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleAction("reject")}
                      disabled={!!isBusy}
                      className="text-red-400/60 hover:text-red-400 hover:bg-red-400/10"
                    >
                      {isBusy === "reject" ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4 mr-1" />}
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => handleAction("accept")}
                      disabled={!!isBusy || service?.status !== 0}
                      title={service?.status !== 0 ? "Service is no longer active" : undefined}
                      className="gap-1"
                    >
                      {isBusy === "accept" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                      Accept
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-6 max-w-3xl space-y-5">

        {/* ── Status banners ── */}

        {req.status === 0 && isClient && (
          <div className="rounded-[22px] border border-sky-400/25 bg-sky-400/5 px-4 py-3 flex items-start gap-3">
            <Clock className="w-4 h-4 text-sky-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-sky-300/90">Waiting for executor to respond</p>
              <p className="text-xs text-white/35 mt-0.5">
                The executor will review your request and either accept or reject it. You can cancel while it's pending.
              </p>
            </div>
          </div>
        )}

        {req.status === 0 && isExecutor && (
          <div className="rounded-[22px] border border-amber-400/25 bg-amber-400/5 px-4 py-3 flex items-start gap-3">
            <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-300/90">New hire request — action required</p>
              <p className="text-xs text-white/35 mt-0.5">
                A client wants to hire you. Accept to create an escrow deal, or reject to decline.
              </p>
            </div>
          </div>
        )}

        {req.status === 1 && hasDeal && (
          <div className="rounded-[22px] border border-emerald-400/30 bg-emerald-400/5 px-4 py-3 flex items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-emerald-300/90">Request accepted · Deal created</p>
                <p className="text-xs text-white/35 mt-0.5">The escrow is live. Go to the deal page to proceed.</p>
              </div>
            </div>
            <Link href={`/deal/${req.agreement}`}>
              <Button size="sm" className="flex-shrink-0 gap-1">
                Go to Deal <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            </Link>
          </div>
        )}

        {req.status === 2 && (
          <div className="rounded-[22px] border border-red-400/20 bg-red-400/5 px-4 py-3 flex items-start gap-3">
            <XCircle className="w-4 h-4 text-red-400/70 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-300/70">Request rejected</p>
              <p className="text-xs text-white/35 mt-0.5">
                The executor declined this request. You can send a new request from the service board.
              </p>
            </div>
          </div>
        )}

        {req.status === 3 && (
          <div className="rounded-[22px] border border-white/[0.07] bg-[#0d0d0f] px-4 py-3 flex items-start gap-3">
            <XCircle className="w-4 h-4 text-white/25 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-white/45">Request cancelled</p>
              <p className="text-xs text-white/25 mt-0.5">You cancelled this request.</p>
            </div>
          </div>
        )}

        {/* ── Request details ── */}
        <div className="rounded-[22px] border border-white/[0.08] bg-white/[0.03] p-5"
          style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}
        >
          <h2 className="text-xs font-semibold text-white/30 uppercase tracking-widest mb-4">Request Details</h2>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
            <div>
              <p className="text-xs text-white/30 mb-1">Amount</p>
              <div className="flex items-center gap-1">
                <DollarSign className="w-3.5 h-3.5 text-emerald-400" />
                <span className="font-mono font-semibold text-white">{fmt(req.amount)} USDC</span>
              </div>
            </div>
            <div>
              <p className="text-xs text-white/30 mb-1">Deadline</p>
              <div className="flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5 text-white/40" />
                <span className="text-white/80">{Number(req.deadlineDays)} days</span>
              </div>
            </div>
            <div>
              <p className="text-xs text-white/30 mb-1">Submitted</p>
              <div className="flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-white/40" />
                <span className="text-white/80">{timeAgo(req.createdAt)}</span>
              </div>
            </div>
            <div>
              <p className="text-xs text-white/30 mb-1">Region</p>
              <div className="flex items-center gap-1">
                <Globe className="w-3.5 h-3.5 text-white/40" />
                <span className="text-white/80">{REGION_LABELS[req.region] ?? "—"}</span>
              </div>
            </div>
          </div>

          <div>
            <p className="text-xs text-white/30 mb-1">Client</p>
            <a
              href={explorerUrl("address", req.client)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm font-mono text-white/60 hover:text-white/90 transition-colors"
            >
              <span>{req.client}</span>
              <ExternalLink className="w-3 h-3 flex-shrink-0" />
            </a>
          </div>

          {hasDeal && (
            <div className="mt-4 pt-4 border-t border-white/8">
              <p className="text-xs text-white/30 mb-1">Agreement</p>
              <Link
                href={`/deal/${req.agreement}`}
                className="inline-flex items-center gap-1 text-sm font-mono text-primary hover:underline"
              >
                <span>{req.agreement}</span>
                <ExternalLink className="w-3 h-3 flex-shrink-0" />
              </Link>
            </div>
          )}
        </div>

        {/* ── Service info ── */}
        {service && (
          <div className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] p-5" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
            <div className="flex items-center gap-2 mb-3">
              <Briefcase className="w-4 h-4 text-white/40" />
              <h2 className="text-sm font-semibold text-white/80">Service</h2>
              <span className="text-xs text-white/30 font-mono">#{req.serviceId.toString()}</span>
            </div>

            <p className="text-base font-semibold text-white/90 mb-1">{service.title}</p>

            {displayDesc && (
              <p className="text-sm text-white/55 leading-relaxed whitespace-pre-wrap mb-4">
                {displayDesc}
              </p>
            )}

            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <p className="text-xs text-white/30 mb-1">Listed price</p>
                <span className="font-mono text-sm text-white/70">{fmt(service.price)} USDC</span>
              </div>
              <div>
                <p className="text-xs text-white/30 mb-1">Typical deadline</p>
                <span className="text-sm text-white/70">{Number(service.deadlineDays)} days</span>
              </div>
            </div>

            <div>
              <p className="text-xs text-white/30 mb-1">Executor</p>
              <div className="flex items-center gap-2">
                <User className="w-3.5 h-3.5 text-white/30 flex-shrink-0" />
                <a
                  href={explorerUrl("address", service.executor)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm font-mono text-white/60 hover:text-white/90 transition-colors"
                >
                  <span>{shortAddr(service.executor)}</span>
                  <ExternalLink className="w-3 h-3 flex-shrink-0" />
                </a>
                {isExecutor && <span className="text-xs text-white/30">(you)</span>}
              </div>
            </div>
          </div>
        )}

        {/* ── Bottom action panel (mobile-friendly alternative to header buttons) ── */}
        {req.status === 0 && (isClient || isExecutor) && (
          <div className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] p-4" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
            {isClient && (
              <Button
                variant="ghost"
                className="w-full border border-red-400/20 text-red-400/70 hover:text-red-400 hover:bg-red-400/10 gap-2"
                onClick={() => handleAction("cancel")}
                disabled={!!isBusy}
              >
                {isBusy === "cancel" ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                Cancel Request
              </Button>
            )}
            {isExecutor && (
              <div className="flex gap-3">
                <Button
                  variant="ghost"
                  className="flex-1 border border-red-400/20 text-red-400/70 hover:text-red-400 hover:bg-red-400/10 gap-2"
                  onClick={() => handleAction("reject")}
                  disabled={!!isBusy}
                >
                  {isBusy === "reject" ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                  Reject
                </Button>
                <Button
                  className="flex-1 gap-2"
                  onClick={() => handleAction("accept")}
                  disabled={!!isBusy}
                >
                  {isBusy === "accept" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                  Accept & Create Deal
                </Button>
              </div>
            )}
          </div>
        )}

      </div>
    </>
  );
}
