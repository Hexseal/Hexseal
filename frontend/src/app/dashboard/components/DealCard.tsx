'use client';

import { useState } from 'react';
import Link from 'next/link';
import { explorerUrl } from '@/config/chain';
import { useReadContract, usePublicClient, useWalletClient } from 'wagmi';
import { isAddress } from 'viem';
import type { Abi } from 'viem';
import { AGREEMENT_ABI, USDC_ABI, CONTRACTS } from '@/config/contracts';
import { ACTIVATION_WINDOW, AUTO_APPROVE_WINDOW } from '@/config/constants';
import { fundAgreementGasless, sendAgreementGasless } from '@/lib/relay';
import { Button } from '@/components/ui/button';
import { toast } from 'react-hot-toast';
import {
  Loader2, Clock, CheckCircle, AlertTriangle, ArrowRight,
  Copy, ExternalLink, Play, Flag, Shield, Timer,
  ChevronDown, ImageIcon, MessageCircle,
} from 'lucide-react';

export interface AgreementRecord {
  agreement: string;
  client: string;
  executor: string;
  amount: bigint;
  status: number;
  createdAt: bigint;
  resolvedAt: bigint;
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
function formatAmount(amount: bigint): string {
  return (Number(amount) / 1e6).toFixed(2);
}
export function formatTimeLeft(seconds: bigint | undefined): string {
  if (!seconds || seconds === BigInt(0)) return 'Expired';
  const s = Number(seconds);
  const days  = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins  = Math.floor((s % 3600) / 60);
  if (days > 0)  return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
export function isUrgent(seconds: bigint | undefined): boolean {
  return !!seconds && Number(seconds) < 86400;
}

export const DEAL_STATUS: Record<number, { label: string; dot: string; badge: string; icon: React.ReactNode }> = {
  0: { label: 'Created',   dot: 'bg-sky-400',     badge: 'bg-sky-400/10 text-sky-400 border-sky-400/20',             icon: <Clock className="w-3 h-3" /> },
  1: { label: 'Funded',    dot: 'bg-emerald-400',  badge: 'bg-emerald-400/10 text-emerald-400 border-emerald-400/20', icon: <Play className="w-3 h-3" /> },
  2: { label: 'Active',    dot: 'bg-violet-400',   badge: 'bg-violet-400/10 text-violet-400 border-violet-400/20',    icon: <Clock className="w-3 h-3" /> },
  3: { label: 'Completed', dot: 'bg-green-400',    badge: 'bg-green-400/10 text-green-400 border-green-400/20',       icon: <CheckCircle className="w-3 h-3" /> },
  4: { label: 'Disputed',  dot: 'bg-red-400',      badge: 'bg-red-400/10 text-red-400 border-red-400/20',             icon: <AlertTriangle className="w-3 h-3" /> },
  5: { label: 'Resolved',  dot: 'bg-purple-400',   badge: 'bg-purple-400/10 text-purple-400 border-purple-400/20',    icon: <CheckCircle className="w-3 h-3" /> },
  6: { label: 'Refunded',  dot: 'bg-gray-400',     badge: 'bg-gray-400/10 text-gray-400 border-gray-400/20',          icon: <ArrowRight className="w-3 h-3" /> },
};

export function DealCard({ agreement, address, refetch }: {
  agreement: AgreementRecord;
  address: string;
  refetch: () => void;
}) {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [busy, setBusy] = useState(false);
  const [showTimeouts, setShowTimeouts] = useState(false);

  const { data: liveStatusData } = useReadContract({
    address: agreement.agreement as `0x${string}`,
    abi: AGREEMENT_ABI, functionName: 'status',
    query: { enabled: isAddress(agreement.agreement) },
  }) as { data: number | undefined };

  const { data: agreementBalance } = useReadContract({
    address: CONTRACTS.usdc as `0x${string}`,
    abi: USDC_ABI, functionName: 'balanceOf',
    args: [agreement.agreement as `0x${string}`],
    query: { enabled: isAddress(agreement.agreement) },
  }) as { data: bigint | undefined };

  const computedLive = liveStatusData !== undefined ? Number(liveStatusData) : agreement.status;
  const balanceOverride =
    agreementBalance !== undefined && agreementBalance === BigInt(0) &&
    computedLive >= 1 && computedLive <= 2 ? 3 : computedLive;
  const liveStatus = Math.max(balanceOverride, agreement.status);

  const { data: timeLeft }       = useReadContract({ address: agreement.agreement as `0x${string}`, abi: AGREEMENT_ABI, functionName: 'timeLeft',       query: { enabled: isAddress(agreement.agreement) } }) as { data: bigint | undefined };
  const { data: arbiterTimeLeft } = useReadContract({ address: agreement.agreement as `0x${string}`, abi: AGREEMENT_ABI, functionName: 'arbiterTimeLeft', query: { enabled: isAddress(agreement.agreement) } }) as { data: bigint | undefined };
  const { data: details }         = useReadContract({ address: agreement.agreement as `0x${string}`, abi: AGREEMENT_ABI, functionName: 'getDetails',      query: { enabled: isAddress(agreement.agreement) } });

  const isClient   = agreement.client.toLowerCase()   === address.toLowerCase();
  const { data: userUsdcBalance } = useReadContract({
    address: CONTRACTS.usdc as `0x${string}`,
    abi: USDC_ABI, functionName: 'balanceOf',
    args: [address as `0x${string}`],
    query: { enabled: isAddress(agreement.agreement) && isClient },
  }) as { data: bigint | undefined };

  const markedDoneAt:  bigint = details ? (details as any)[8] : BigInt(0);
  const fundedAt:      bigint = details ? (details as any)[6] : BigInt(0);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const activationExpired  = fundedAt > 0n && nowSec > fundedAt + ACTIVATION_WINDOW;
  const autoApproveExpired = markedDoneAt > 0n && nowSec >= markedDoneAt + AUTO_APPROVE_WINDOW;
  const deadlineExpired    = timeLeft !== undefined && timeLeft === 0n;
  const arbiterExpired     = arbiterTimeLeft !== undefined && arbiterTimeLeft === 0n;

  const isExecutor = agreement.executor.toLowerCase() === address.toLowerCase();
  const hasEnoughUsdc = userUsdcBalance === undefined || userUsdcBalance >= agreement.amount;
  const s          = DEAL_STATUS[liveStatus] ?? DEAL_STATUS[0];
  const counterparty = isClient ? agreement.executor : agreement.client;

  const run = async (fn: string) => {
    if (!walletClient || !publicClient) { toast.error('Wallet not connected'); return; }
    setBusy(true);
    const successMsg: Record<string, string> = {
      activate:    'Deal activated! Work has started.',
      markDone:    'Work submitted! Awaiting client review.',
      release:     'Payment released to executor!',
      raiseDispute:'Dispute raised. Arbiter will be notified.',
      triggerActivationTimeout: 'Executor timed out — deal refunded.',
      triggerDeadlineTimeout:   'Deadline passed — deal refunded.',
      triggerArbiterTimeout:    'Arbiter timed out — deal refunded.',
      triggerAutoApprove:       'Auto-approved — funds released to executor.',
    };
    try {
      toast('Confirm in wallet…');
      await sendAgreementGasless(walletClient, publicClient, agreement.agreement as `0x${string}`, fn, AGREEMENT_ABI as Abi);
      toast.success(successMsg[fn] ?? 'Done!');
      setTimeout(refetch, 2000);
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || 'Transaction failed');
    } finally { setBusy(false); }
  };

  const primaryActions: React.ReactNode[] = [];
  if (liveStatus === 0 && isClient) primaryActions.push(
    <div key="fund-group" className="flex items-center gap-2 flex-wrap">
      <Button size="sm" disabled={busy || !hasEnoughUsdc} onClick={async () => {
        if (!publicClient || !walletClient) { toast.error('Wallet not connected'); return; }
        setBusy(true);
        try {
          toast('Sign: USDC permit…');
          await fundAgreementGasless(walletClient, publicClient, agreement.agreement as `0x${string}`, agreement.amount);
          toast.success('Deal funded!');
          setTimeout(refetch, 4000);
        } catch (err: unknown) {
          const e = err as { shortMessage?: string; message?: string };
          const msg = e?.shortMessage || e?.message || 'Fund failed';
          if (msg.includes('AlreadyFunded')) { toast.error('Already funded'); refetch(); }
          else toast.error(msg);
        } finally { setBusy(false); }
      }}>
        {busy ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Play className="w-3 h-3 mr-1" />}Fund
      </Button>
      {!hasEnoughUsdc && userUsdcBalance !== undefined && (
        <span className="text-xs text-red-400">
          Insufficient USDC ({formatAmount(userUsdcBalance)} / {formatAmount(agreement.amount)})
        </span>
      )}
    </div>
  );
  if (liveStatus === 1 && isExecutor) primaryActions.push(
    <div key="activate-group" className="flex flex-col gap-1.5 w-full">
      <p className="text-xs text-amber-400/70">Deal is funded — start work to begin the countdown</p>
      <Button size="sm" disabled={busy} onClick={() => run('activate')} className="self-start gap-1">
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}Start Work
      </Button>
    </div>
  );
  if (liveStatus === 2 && isExecutor && markedDoneAt === BigInt(0)) primaryActions.push(
    <Button key="markDone" size="sm" disabled={busy} onClick={() => run('markDone')}>
      {busy ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <CheckCircle className="w-3 h-3 mr-1" />}Mark Done
    </Button>
  );
  if (liveStatus === 2 && isClient && markedDoneAt > BigInt(0)) primaryActions.push(
    <Button key="release" size="sm" disabled={busy} onClick={() => run('release')}>
      {busy ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <CheckCircle className="w-3 h-3 mr-1" />}Release
    </Button>
  );
  if (liveStatus === 2 && (isClient || isExecutor)) primaryActions.push(
    <Button key="dispute" size="sm" variant="destructive" disabled={busy} onClick={() => run('raiseDispute')}>
      <Flag className="w-3 h-3 mr-1" />Raise Dispute
    </Button>
  );

  const timeoutActions: React.ReactNode[] = [];
  if (liveStatus === 1 && (isClient || isExecutor) && activationExpired) timeoutActions.push(
    <Button key="actTimeout" size="sm" variant="outline" className="text-orange-400 border-orange-400/30 hover:bg-orange-400/10" disabled={busy} onClick={() => run('triggerActivationTimeout')}>
      <Timer className="w-3 h-3 mr-1" />Executor didn't start → Refund
    </Button>
  );
  if (liveStatus === 2 && (isClient || isExecutor) && markedDoneAt === BigInt(0) && deadlineExpired) timeoutActions.push(
    <Button key="dlTimeout" size="sm" variant="outline" className="text-orange-400 border-orange-400/30 hover:bg-orange-400/10" disabled={busy} onClick={() => run('triggerDeadlineTimeout')}>
      <Timer className="w-3 h-3 mr-1" />Deadline passed → Refund
    </Button>
  );
  if (liveStatus === 4 && (isClient || isExecutor) && arbiterExpired) timeoutActions.push(
    <Button key="arbTimeout" size="sm" variant="outline" className="text-orange-400 border-orange-400/30 hover:bg-orange-400/10" disabled={busy} onClick={() => run('triggerArbiterTimeout')}>
      <Timer className="w-3 h-3 mr-1" />Arbiter idle → Refund
    </Button>
  );
  if (liveStatus === 2 && markedDoneAt > BigInt(0) && autoApproveExpired) timeoutActions.push(
    <Button key="autoApprove" size="sm" variant="outline" className="text-orange-400 border-orange-400/30 hover:bg-orange-400/10" disabled={busy} onClick={() => run('triggerAutoApprove')}>
      <Shield className="w-3 h-3 mr-1" />Client silent → Release to executor
    </Button>
  );

  const needsAction = primaryActions.length > 0;

  // Stripe color matches the deal status badge when action is required
  const stripeColor =
    liveStatus === 0 ? 'bg-sky-400/70' :      // CREATED — client needs to fund
    liveStatus === 1 ? 'bg-amber-400/70' :    // FUNDED — executor needs to activate
    liveStatus === 2 ? 'bg-violet-400/50' :   // ACTIVE — mark done / release
    liveStatus === 4 ? 'bg-red-400/70' :      // DISPUTED
    'bg-white/20';

  return (
    <div
      className={`rounded-[22px] border transition-colors relative overflow-hidden ${
        needsAction
          ? 'border-white/[0.13] bg-[#0d0d0f] hover:bg-[#111113]'
          : 'border-white/[0.08] bg-[#0d0d0f] hover:bg-[#111113]'
      }`}
      style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}
    >
      {needsAction && (
        <div className={`absolute top-0 left-0 right-0 h-0.5 rounded-t-[22px] ${stripeColor}`} />
      )}
      <div className="px-4 py-4 sm:px-5">
        {/* Status row */}
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${s.dot}`} />
          <span className="font-mono text-sm font-semibold text-white/90">
            #{agreement.agreement.slice(2, 10).toUpperCase()}
          </span>
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border font-medium ${s.badge}`}>
            {s.icon}{s.label}
          </span>
          {liveStatus === 4 && arbiterTimeLeft && (
            <span className={`text-xs px-2 py-0.5 rounded-full border bg-red-400/10 text-red-400 border-red-400/20 ${isUrgent(arbiterTimeLeft) ? 'animate-pulse' : ''}`}>
              arbiter {formatTimeLeft(arbiterTimeLeft)}
            </span>
          )}
          <div className="ml-auto flex items-center gap-0.5 flex-shrink-0">
            <Link href={`/chat?peer=${counterparty.toLowerCase()}`} title="Open chat">
              <Button size="sm" variant="ghost" className="text-white/30 hover:text-white/60 h-7 w-7 p-0">
                <MessageCircle className="w-3.5 h-3.5" />
              </Button>
            </Link>
            <Link href={`/deal/${agreement.agreement}`} title="View deal">
              <Button size="sm" variant="ghost" className="text-white/30 hover:text-white/60 h-7 w-7 p-0">
                <ExternalLink className="w-3.5 h-3.5" />
              </Button>
            </Link>
          </div>
        </div>

        {/* Amount + counterparty row */}
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <p className="text-2xl font-bold font-mono text-white leading-none">
              {formatAmount(agreement.amount)}
              <span className="text-sm font-normal text-white/40 ml-1.5">USDC</span>
            </p>
            <div className="flex items-center gap-1.5 mt-1 text-xs text-white/35">
              <span className="font-mono">{shortAddr(counterparty)}</span>
              <button onClick={() => { navigator.clipboard.writeText(counterparty); toast.success('Copied'); }} className="hover:text-white/60 transition-colors">
                <Copy className="w-3 h-3" />
              </button>
              {timeLeft && liveStatus < 3 && (
                <>
                  <span className="opacity-30">·</span>
                  <span className={isUrgent(timeLeft) ? 'text-orange-400' : ''}>{formatTimeLeft(timeLeft)} left</span>
                </>
              )}
            </div>
          </div>
          {liveStatus >= 1 && liveStatus <= 2 && (
            <a href={explorerUrl('token', agreement.agreement)} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-violet-400/60 hover:text-violet-400 transition-colors flex-shrink-0">
              <ImageIcon className="w-3 h-3" />
              <span className="hidden sm:inline">NFT</span>
            </a>
          )}
        </div>

        {primaryActions.length > 0 && (
          <div className="flex flex-wrap gap-2">{primaryActions}</div>
        )}

        {timeoutActions.length > 0 && (
          <div className={primaryActions.length > 0 ? 'mt-2' : ''}>
            <button onClick={() => setShowTimeouts(v => !v)}
              className="flex items-center gap-1 text-xs text-white/25 hover:text-white/50 transition-colors">
              <ChevronDown className={`w-3 h-3 transition-transform ${showTimeouts ? 'rotate-180' : ''}`} />
              {showTimeouts ? 'hide' : 'timeout actions'}
            </button>
          </div>
        )}
      </div>

      {showTimeouts && timeoutActions.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 sm:px-5 pb-4 border-t border-white/5 pt-3">
          {timeoutActions}
        </div>
      )}
    </div>
  );
}
