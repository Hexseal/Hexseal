"use client";

import React, { useMemo, useState } from "react";
import { useAccount, useReadContract, usePublicClient, useWalletClient } from "wagmi";
import { AGREEMENT_ABI, CONTRACTS, STATUS_LABELS, DIAMOND_ABI } from "@/config/contracts";
import { Button } from "@/components/ui/button";
import { toast } from "react-hot-toast";
import { formatUnits, isAddress, type Abi } from "viem";
import {
  Loader2,
  CheckCircle,
  AlertTriangle,
  Clock,
  ExternalLink,
  ArrowRight,
  DollarSign,
  Timer,
  Shield,
  MessageCircle,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { fundAgreementGasless, sendAgreementGasless } from "@/lib/relay";
import { useProfile } from "@/hooks/useProfile";
import { ARBITER_REGISTRY_ABI } from "@/config/contracts";
import { explorerUrl } from "@/config/chain";
import { initXmtpClient, notifyArbiters } from "@/lib/xmtp";

// Agreement status enum matches Solidity:
// 0=CREATED, 1=FUNDED, 2=ACTIVE, 3=COMPLETED, 4=DISPUTED, 5=RESOLVED, 6=REFUNDED
const AGREEMENT_STATUS: Record<number, { label: string; color: string; dot: string; icon: React.ReactNode }> = {
  0: { label: "Created",   dot: "bg-sky-400",    color: "bg-sky-400/10 text-sky-400 border border-sky-400/20",           icon: <Clock className="w-3.5 h-3.5" /> },
  1: { label: "Funded",    dot: "bg-emerald-400", color: "bg-emerald-400/10 text-emerald-400 border border-emerald-400/20", icon: <DollarSign className="w-3.5 h-3.5" /> },
  2: { label: "Active",    dot: "bg-violet-400",  color: "bg-violet-400/10 text-violet-400 border border-violet-400/20",   icon: <Timer className="w-3.5 h-3.5" /> },
  3: { label: "Completed", dot: "bg-green-400",   color: "bg-green-400/10 text-green-400 border border-green-400/20",     icon: <CheckCircle className="w-3.5 h-3.5" /> },
  4: { label: "Disputed",  dot: "bg-red-400",     color: "bg-red-400/10 text-red-400 border border-red-400/20",           icon: <AlertTriangle className="w-3.5 h-3.5" /> },
  5: { label: "Resolved",  dot: "bg-purple-400",  color: "bg-purple-400/10 text-purple-400 border border-purple-400/20",  icon: <Shield className="w-3.5 h-3.5" /> },
  6: { label: "Refunded",  dot: "bg-gray-400",    color: "bg-gray-400/10 text-gray-400 border border-gray-400/20",        icon: <ArrowRight className="w-3.5 h-3.5" /> },
};

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// ─── Party row with profile name + avatar ─────────────────────────────────────

function PartyRow({
  role, addr, isMe, showChat, fixedLabel,
}: {
  role: string; addr: string; isMe: boolean; showChat: boolean; fixedLabel?: string;
}) {
  const { displayName, avatarUrl } = useProfile(addr);
  const primaryName = fixedLabel ?? displayName ?? shortAddr(addr);
  const showAddrBelow = !!(fixedLabel || displayName);

  return (
    <div className="flex items-center gap-2 justify-end">
      <span className="text-xs text-white/30">{role}</span>
      <Link href={`/profile/${addr}`} className="flex items-center gap-1.5 group hover:opacity-80 transition-opacity">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={avatarUrl ?? `https://effigy.im/a/${addr}.svg`}
          alt=""
          className="w-5 h-5 rounded-full bg-white/10 flex-shrink-0 object-cover"
          onError={(e) => {
            const img = e.target as HTMLImageElement;
            if (avatarUrl && img.src !== `https://effigy.im/a/${addr}.svg`) {
              img.src = `https://effigy.im/a/${addr}.svg`;
            }
          }}
        />
        <div className="text-right">
          <span className="block text-xs font-medium text-white/70 group-hover:text-white transition-colors">
            {primaryName}
          </span>
          {showAddrBelow && (
            <span className="block font-mono text-[10px] text-white/25 leading-none">
              {shortAddr(addr)}
            </span>
          )}
        </div>
      </Link>
      {isMe && (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-400 font-medium">
          you
        </span>
      )}
      {!isMe && showChat && (
        <Link href={`/chat/${addr}`}>
          <button className="text-white/25 hover:text-primary transition-colors">
            <MessageCircle className="w-3.5 h-3.5" />
          </button>
        </Link>
      )}
    </div>
  );
}

function formatTimestamp(ts: bigint | number | undefined): string {
  if (!ts || BigInt(ts) === BigInt(0)) return "—";
  return new Date(Number(BigInt(ts)) * 1000).toLocaleString();
}

function formatTimeLeft(seconds: bigint | number | undefined): string {
  if (!seconds || BigInt(seconds) === BigInt(0)) return "Expired";
  const s = Number(BigInt(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h`;
}

export default function DealDetailPage() {
  const params = useParams();
  const dealAddress = params?.address as string | undefined;
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [isFunding, setIsFunding] = useState(false);
  const [disputeModal, setDisputeModal] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');

  // Read Diamond owner as the platform admin / arbiter address
  const { data: adminAddress } = useReadContract({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI,
    functionName: 'owner',
  }) as { data: string | undefined };

  const isValidDeal = useMemo(() => dealAddress && isAddress(dealAddress), [dealAddress]);

  // Read agreement details
  const { data: details, isLoading: isLoadingDetails, refetch: refetchDetails } = useReadContract({
    address: dealAddress as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: "getDetails",
    query: { enabled: !!isValidDeal },
  }) as { data: [string, string, string, bigint, string, bigint, bigint, bigint, bigint, bigint, bigint, number] | undefined; isLoading: boolean; refetch: () => void };

  // Read status separately for reactivity
  const { data: statusNum } = useReadContract({
    address: dealAddress as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: "status",
    query: { enabled: !!isValidDeal },
  }) as { data: number | undefined };

  // Read timeLeft
  const { data: timeLeft } = useReadContract({
    address: dealAddress as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: "timeLeft",
    query: { enabled: !!isValidDeal },
  }) as { data: bigint | undefined };

  // Read arbiterTimeLeft
  const { data: arbiterTimeLeft } = useReadContract({
    address: dealAddress as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: "arbiterTimeLeft",
    query: { enabled: !!isValidDeal },
  }) as { data: bigint | undefined };

  // Parse details
  // viem v2 returns named-output results as an object { field_: value }
  // but may also be array-like in some versions — read both with fallback.
  const parsed = useMemo(() => {
    if (!details) return null;
    const obj = details as unknown as Record<string, unknown>;
    const arr = details as unknown as readonly unknown[];
    const get = (name: string, idx: number): unknown => obj[name] ?? arr[idx];
    const amount = get('amount_', 3) as bigint | undefined;
    if (amount === undefined) return null; // data not fully loaded yet
    return {
      client:       get('client_',       0) as string,
      executor:     get('executor_',     1) as string,
      arbiter:      get('arbiter_',      2) as string,
      amount,
      termsHash:    get('termsHash_',    4) as string,
      deadlineDays: get('deadlineDays_', 5) as bigint,
      fundedAt:     get('fundedAt_',     6) as bigint,
      activatedAt:  get('activatedAt_',  7) as bigint,
      markedDoneAt: get('markedDoneAt_', 8) as bigint,
      disputedAt:   get('disputedAt_',   9) as bigint,
      resolvedAt:   get('resolvedAt_',  10) as bigint,
      status:       (statusNum ?? 0) as number,
    };
  }, [details, statusNum]);

  const isClient = parsed?.client
    ? parsed.client.toLowerCase() === address?.toLowerCase()
    : false;

  const isExecutor = parsed?.executor
    ? parsed.executor.toLowerCase() === address?.toLowerCase()
    : false;

  const isArbiter = parsed?.arbiter &&
    parsed.arbiter !== "0x0000000000000000000000000000000000000000"
    ? parsed.arbiter.toLowerCase() === address?.toLowerCase()
    : false;

  const isParty = isClient || isExecutor;

  const now = Date.now() / 1000;
  const activationWindowPassed = !!parsed && parsed.fundedAt > 0n
    && now > Number(parsed.fundedAt) + 3 * 24 * 3600;
  const autoApproveWindowPassed = !!parsed && parsed.markedDoneAt > 0n
    && now >= Number(parsed.markedDoneAt) + 5 * 24 * 3600;

  const handleAction = async (fn: string, successMsg: string, args: unknown[] = []) => {
    if (!isValidDeal || !walletClient || !publicClient) return;
    setIsFunding(true);
    try {
      toast('Confirm in wallet…');
      await sendAgreementGasless(walletClient, publicClient, dealAddress as `0x${string}`, fn, AGREEMENT_ABI as Abi, args);
      toast.success(successMsg);

      // After raiseDispute — notify all registered arbiters via XMTP DM
      if (fn === 'raiseDispute') {
        try {
          const arbiters = await publicClient.readContract({
            address: CONTRACTS.diamond,
            abi: ARBITER_REGISTRY_ABI as Abi,
            functionName: 'getArbiters',
          }) as string[];
          if (arbiters.length > 0) {
            const xmtp = await initXmtpClient(walletClient);
            await notifyArbiters(xmtp, dealAddress as string, arbiters);
          }
        } catch {
          // Non-critical — arbiter notification is best-effort
        }
      }

      setTimeout(() => refetchDetails(), 2000);
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || 'Transaction failed');
    } finally {
      setIsFunding(false);
    }
  };

  const handleFund = async () => {
    if (!isValidDeal || !address || !publicClient || !walletClient || !parsed) return;
    setIsFunding(true);
    try {
      const dealAddr = dealAddress as `0x${string}`;
      toast('Sign 1/2: USDC permit in wallet…');
      const { txHash } = await fundAgreementGasless(walletClient, publicClient, dealAddr, parsed.amount);
      toast.success(`Deal funded! Tx: ${txHash.slice(0, 10)}…`);
      setTimeout(() => refetchDetails(), 4000);
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      const msg = e?.shortMessage || e?.message || "Fund failed";
      if (msg.includes('AlreadyFunded')) {
        toast.error('Deal is already funded — refreshing…');
        setTimeout(() => refetchDetails(), 1000);
      } else {
        toast.error(msg);
      }
    } finally {
      setIsFunding(false);
    }
  };

  const handleRaiseDispute = async () => {
    if (!isValidDeal || !address || !walletClient || !publicClient) return;
    setDisputeModal(false);
    try {
      // Save reason to storage (best-effort, non-blocking)
      if (disputeReason.trim()) {
        fetch('/api/dispute-reason', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agreement: dealAddress,
            raiser: address,
            reason: disputeReason.trim(),
          }),
        }).catch(() => {});
      }
      await handleAction('raiseDispute', 'Dispute raised!');
    } finally {
      setDisputeReason('');
    }
  };

  if (!isValidDeal) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <p className="text-white/50 text-sm">Invalid deal address</p>
        <Link href="/dashboard"><Button variant="outline" size="sm">← Dashboard</Button></Link>
      </div>
    );
  }

  if (isLoadingDetails || !parsed) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-white/30" />
      </div>
    );
  }

  const statusInfo = AGREEMENT_STATUS[parsed.status] || AGREEMENT_STATUS[0];
  const amountFormatted = formatUnits(parsed.amount, 6);
  const busy = isFunding;
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

  return (
    <div className="min-h-screen bg-background">
      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div className="border-b border-white/8 bg-white/[0.02]">
        <div className="container mx-auto px-4 py-4 max-w-3xl flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${statusInfo.dot}`} />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-sm font-semibold text-white/80">
                  #{dealAddress!.slice(2, 10).toUpperCase()}
                </span>
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${statusInfo.color}`}>
                  {statusInfo.icon}{statusInfo.label}
                </span>
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="font-mono text-[11px] text-white/25 truncate">{dealAddress}</span>
                <a href={explorerUrl('address', dealAddress as string)} target="_blank" rel="noopener noreferrer"
                  className="text-white/20 hover:text-primary transition-colors flex-shrink-0">
                  <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </div>
            </div>
          </div>
          <Link href="/dashboard">
            <Button variant="ghost" size="sm" className="text-white/40 hover:text-white/70 flex-shrink-0 text-xs">
              ← Dashboard
            </Button>
          </Link>
        </div>
      </div>

      <div className="container mx-auto px-4 py-5 max-w-3xl space-y-4">

        {/* ── Hero: amount + parties ──────────────────────────────────────────── */}
        <div className="rounded-xl border border-white/8 bg-white/[0.03] px-5 py-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            {/* Amount */}
            <div>
              <p className="text-xs text-white/35 mb-0.5">Deal amount</p>
              <p className="text-3xl font-bold font-mono text-white">
                {amountFormatted}
                <span className="text-base font-normal text-white/40 ml-1.5">USDC</span>
              </p>
              <div className="flex items-center gap-2 mt-1 text-xs text-white/35">
                <Timer className="w-3 h-3" />
                <span>{Number(parsed.deadlineDays)}d deadline</span>
                {timeLeft && parsed.status < 3 && (
                  <>
                    <span className="opacity-30">·</span>
                    <span>{formatTimeLeft(timeLeft)} left</span>
                  </>
                )}
              </div>
            </div>

            {/* Parties */}
            <div className="flex flex-col gap-2 text-right">
              <PartyRow role="Client"   addr={parsed.client}   isMe={isClient}            showChat={!!address} />
              <PartyRow role="Executor" addr={parsed.executor} isMe={isExecutor}           showChat={!!address} />
              {parsed.arbiter !== ZERO_ADDR && (
                <PartyRow
                  role="Arbiter"
                  addr={parsed.arbiter}
                  isMe={isArbiter as boolean}
                  showChat={!!address}
                  fixedLabel={`#${parsed.arbiter.slice(-6).toUpperCase()}`}
                />
              )}
            </div>
          </div>
        </div>

        {/* ── Primary actions ─────────────────────────────────────────────────── */}
        {isConnected && (isParty || isArbiter) && (
          <div className="rounded-xl border border-white/8 bg-white/[0.03] px-5 py-4">
            <p className="text-xs text-white/35 mb-3">Actions</p>
            <div className="flex flex-wrap gap-2">
              {parsed.status === 0 && isClient && (
                <Button size="sm" onClick={handleFund} disabled={busy}>
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <DollarSign className="w-3.5 h-3.5 mr-1.5" />}
                  Fund Deal
                </Button>
              )}
              {parsed.status === 1 && isExecutor && (
                <Button size="sm" onClick={() => handleAction('activate', 'Deal activated! Work has started.')} disabled={busy}>
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Shield className="w-3.5 h-3.5 mr-1.5" />}
                  Activate
                </Button>
              )}
              {parsed.status === 2 && isExecutor && parsed.markedDoneAt === BigInt(0) && (
                <Button size="sm" onClick={() => handleAction('markDone', 'Work submitted! Awaiting client review.')} disabled={busy}>
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <CheckCircle className="w-3.5 h-3.5 mr-1.5" />}
                  Mark Done
                </Button>
              )}
              {parsed.status === 2 && isClient && parsed.markedDoneAt > BigInt(0) && !autoApproveWindowPassed && (
                <Button size="sm" onClick={() => handleAction('release', 'Payment released to executor!')} disabled={busy}>
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <CheckCircle className="w-3.5 h-3.5 mr-1.5" />}
                  Release Funds
                </Button>
              )}
              {parsed.status === 2 && (isClient || isExecutor) && (
                <Button size="sm" variant="destructive" onClick={() => setDisputeModal(true)} disabled={busy}>
                  <AlertTriangle className="w-3.5 h-3.5 mr-1.5" />
                  Raise Dispute
                </Button>
              )}
              {parsed.status === 4 && isArbiter && (
                <>
                  <Button size="sm" variant="destructive" disabled={busy}
                    onClick={() => handleAction('resolveDispute', 'Dispute resolved · Budget refunded to client.', [true])}>
                    Refund Client
                  </Button>
                  <Button size="sm" disabled={busy}
                    onClick={() => handleAction('resolveDispute', 'Dispute resolved · Funds paid to executor.', [false])}>
                    Pay Executor
                  </Button>
                </>
              )}
              {/* Timeout actions — only shown when window has actually expired */}
              {parsed.status === 1 && isParty && activationWindowPassed && (
                <Button size="sm" variant="ghost" className="text-orange-400/60 hover:text-orange-400"
                  onClick={() => handleAction('triggerActivationTimeout', 'Executor timed out · Budget refunded to you.')}
                  disabled={busy}>
                  Executor didn't activate → Refund
                </Button>
              )}
              {parsed.status === 2 && isParty && parsed.markedDoneAt === BigInt(0) && timeLeft === BigInt(0) && (
                <Button size="sm" variant="ghost" className="text-orange-400/60 hover:text-orange-400"
                  onClick={() => handleAction('triggerDeadlineTimeout', 'Deadline passed · Budget refunded to you.')}
                  disabled={busy}>
                  Deadline passed → Refund
                </Button>
              )}
              {parsed.status === 4 && isParty && arbiterTimeLeft === BigInt(0) && (
                <Button size="sm" variant="ghost" className="text-orange-400/60 hover:text-orange-400"
                  onClick={() => handleAction('triggerArbiterTimeout', 'Arbiter timed out · Budget refunded to client.')}
                  disabled={busy}>
                  Arbiter idle → Refund
                </Button>
              )}
              {parsed.status === 2 && isParty && autoApproveWindowPassed && (
                <Button size="sm" variant="ghost" className="text-white/40"
                  onClick={() => handleAction('triggerAutoApprove', 'Auto-approved · Funds released to executor.')}
                  disabled={busy}>
                  Client silent → Release to executor
                </Button>
              )}
            </div>
          </div>
        )}

        {/* ── Deal Chat button ────────────────────────────────────────────────── */}
        {isConnected && (isParty || isArbiter) && (
          <Link href={`/deal/${dealAddress}/chat`} className="block">
            <div className="rounded-xl border border-white/8 bg-white/[0.03] px-5 py-4 flex items-center gap-3 hover:bg-white/[0.06] hover:border-white/15 transition-colors group cursor-pointer">
              <div className="w-9 h-9 rounded-lg bg-violet-500/15 flex items-center justify-center flex-shrink-0">
                <MessageCircle className="w-4 h-4 text-violet-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white/80 group-hover:text-white transition-colors">Deal Chat</p>
                <p className="text-xs text-white/35">Encrypted group chat between client, executor{parsed?.arbiter !== ZERO_ADDR ? ' & arbiter' : ''}</p>
              </div>
              <ArrowRight className="w-4 h-4 text-white/20 group-hover:text-white/50 transition-colors flex-shrink-0" />
            </div>
          </Link>
        )}

        {/* ── Dispute banner ──────────────────────────────────────────────────── */}
        {parsed.status === 4 && isParty && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-5 py-4">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-red-400" />
              <span className="text-sm font-semibold text-red-400">Dispute Active</span>
              {arbiterTimeLeft && (
                <span className="ml-auto text-xs text-red-400/70">{formatTimeLeft(arbiterTimeLeft)} left</span>
              )}
            </div>
            <p className="text-xs text-white/40 mb-3">Arbitrator has been notified. Chat with them to resolve.</p>
            <div className="flex gap-2">
              {parsed.arbiter !== ZERO_ADDR && (
                <Link href={`/chat/${parsed.arbiter}`}>
                  <Button size="sm" variant="outline" className="border-red-500/30 text-red-400 hover:bg-red-500/10 text-xs">
                    <MessageCircle className="w-3.5 h-3.5 mr-1.5" /> Chat with Arbitrator
                  </Button>
                </Link>
              )}
              {adminAddress && adminAddress !== ZERO_ADDR && (
                <Link href={`/chat/${adminAddress.toLowerCase()}`}>
                  <Button size="sm" variant="ghost" className="text-white/40 text-xs">
                    <MessageCircle className="w-3.5 h-3.5 mr-1.5" /> Chat with Admin
                  </Button>
                </Link>
              )}
            </div>
          </div>
        )}

        {/* ── Work delivered banner ───────────────────────────────────────────── */}
        {parsed.markedDoneAt > BigInt(0) && parsed.status === 2 && (
          <div className="rounded-xl border border-green-500/20 bg-green-500/5 px-5 py-3 flex items-center gap-3">
            <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-green-400">Work delivered</p>
              <p className="text-xs text-white/35">Delivered {formatTimestamp(parsed.markedDoneAt)}</p>
            </div>
          </div>
        )}

        {/* ── Timeline ────────────────────────────────────────────────────────── */}
        <div className="rounded-xl border border-white/8 bg-white/[0.03] px-5 py-4">
          <p className="text-xs text-white/35 mb-3">Timeline</p>
          <div className="relative pl-4">
            {[
              { label: 'Created',    ts: null,                  done: true },
              { label: 'Funded',     ts: parsed.fundedAt,       done: parsed.fundedAt > 0n },
              { label: 'Active',     ts: parsed.activatedAt,    done: parsed.activatedAt > 0n },
              { label: 'Delivered',  ts: parsed.markedDoneAt,   done: parsed.markedDoneAt > 0n },
              { label: 'Disputed',   ts: parsed.disputedAt,     done: parsed.disputedAt > 0n },
              { label: 'Resolved',   ts: parsed.resolvedAt,     done: parsed.resolvedAt > 0n },
            ].map((step, i, arr) => (
              <div key={step.label} className="relative flex items-start gap-3 pb-3 last:pb-0">
                {/* Connector line */}
                {i < arr.length - 1 && (
                  <div className={`absolute left-[-10px] top-3 w-px h-full ${step.done ? 'bg-white/20' : 'bg-white/8'}`} />
                )}
                {/* Dot */}
                <div className={`absolute left-[-14px] top-1 w-2 h-2 rounded-full border flex-shrink-0 ${
                  step.done ? 'bg-green-500 border-green-500' : 'bg-transparent border-white/20'
                }`} />
                {/* Content */}
                <div className="flex items-baseline gap-2 flex-1">
                  <span className={`text-xs ${step.done ? 'text-white/70' : 'text-white/25'}`}>{step.label}</span>
                  {step.ts && BigInt(step.ts) > 0n && (
                    <span className="text-[11px] text-white/25 ml-auto">{formatTimestamp(step.ts)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>

      {/* ── Raise Dispute Modal ─────────────────────────────────────────────── */}
      {disputeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-zinc-900 border border-white/10 rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="w-4 h-4 text-red-400" />
              <h2 className="text-sm font-semibold text-white">Raise Dispute</h2>
            </div>
            <p className="text-xs text-white/40 mb-4">
              Describe the issue clearly — the arbiter will read this before making a decision.
            </p>
            <textarea
              autoFocus
              value={disputeReason}
              onChange={e => setDisputeReason(e.target.value)}
              placeholder="e.g. Executor stopped responding after receiving the brief. Deadline passed with no deliverable submitted."
              rows={4}
              maxLength={2000}
              className="w-full bg-white/[0.05] border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-red-500/40 resize-none"
            />
            <div className="flex justify-between items-center mt-1 mb-4">
              <span className="text-[11px] text-white/25">{disputeReason.length}/2000</span>
            </div>
            <div className="flex gap-3 justify-end">
              <Button size="sm" variant="ghost" onClick={() => { setDisputeModal(false); setDisputeReason(''); }}>
                Cancel
              </Button>
              <Button size="sm" variant="destructive" onClick={handleRaiseDispute} disabled={busy || !disputeReason.trim()}>
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <AlertTriangle className="w-3.5 h-3.5 mr-1.5" />}
                Confirm Dispute
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
