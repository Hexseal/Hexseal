'use client';

import React, { useMemo, useState } from 'react';
import { useAccount, useReadContract, usePublicClient, useWalletClient } from 'wagmi';
import { formatUnits, type Abi } from 'viem';
import { toast } from 'react-hot-toast';
import { DollarSign, Shield, CheckCircle, AlertTriangle, Loader2, ExternalLink, Clock, Timer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AGREEMENT_ABI, CONTRACTS, DIAMOND_ABI } from '@/config/contracts';
import { ARBITER_REGISTRY_ABI } from '@/config/contracts';
import { ACTIVATION_WINDOW, AUTO_APPROVE_WINDOW } from '@/config/constants';
import { fundAgreementGasless, sendAgreementGasless } from '@/lib/relay';
import { initXmtpClient, notifyArbiters } from '@/lib/xmtp';

interface Props {
  agreementAddr: string;
}

export function DealActionBar({ agreementAddr }: Props) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [busy, setBusy] = useState(false);
  const [disputeModal, setDisputeModal] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');

  const { data: details, refetch } = useReadContract({
    address: agreementAddr as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: 'getDetails',
  });

  const { data: statusNum } = useReadContract({
    address: agreementAddr as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: 'status',
  }) as { data: number | undefined };

  const { data: timeLeft } = useReadContract({
    address: agreementAddr as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: 'timeLeft',
  }) as { data: bigint | undefined };

  const { data: arbiterTimeLeft } = useReadContract({
    address: agreementAddr as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: 'arbiterTimeLeft',
  }) as { data: bigint | undefined };

  const parsed = useMemo(() => {
    if (!details) return null;
    const obj = details as unknown as Record<string, unknown>;
    const arr = details as unknown as readonly unknown[];
    const get = (name: string, idx: number): unknown => obj[name] ?? arr[idx];
    const amount = get('amount_', 3) as bigint | undefined;
    if (amount === undefined) return null;
    return {
      client:       get('client_',       0) as string,
      executor:     get('executor_',     1) as string,
      arbiter:      get('arbiter_',      2) as string,
      amount,
      fundedAt:     get('fundedAt_',     6) as bigint,
      markedDoneAt: get('markedDoneAt_', 8) as bigint,
      status:       (statusNum ?? 0) as number,
    };
  }, [details, statusNum]);

  const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
  const isClient   = !!parsed?.client   && parsed.client.toLowerCase()   === address?.toLowerCase();
  const isExecutor = !!parsed?.executor && parsed.executor.toLowerCase() === address?.toLowerCase();
  const isArbiter  = !!parsed?.arbiter  && parsed.arbiter !== ZERO_ADDR  && parsed.arbiter.toLowerCase() === address?.toLowerCase();
  const isParty    = isClient || isExecutor;

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const activationExpired  = parsed ? parsed.fundedAt > 0n && nowSec > parsed.fundedAt + ACTIVATION_WINDOW : false;
  const autoApproveExpired = parsed ? parsed.markedDoneAt > 0n && nowSec >= parsed.markedDoneAt + AUTO_APPROVE_WINDOW : false;
  const deadlineExpired    = timeLeft !== undefined && timeLeft === 0n;
  const arbiterExpired     = arbiterTimeLeft !== undefined && arbiterTimeLeft === 0n;

  const run = async (fn: string, successMsg: string, args: unknown[] = []) => {
    if (!walletClient || !publicClient) { toast.error('Wallet not connected'); return; }
    setBusy(true);
    try {
      toast('Signing transaction…');
      await sendAgreementGasless(walletClient, publicClient, agreementAddr as `0x${string}`, fn, AGREEMENT_ABI as Abi, args);
      toast.success(successMsg);
      if (fn === 'raiseDispute') {
        try {
          const arbiters = await publicClient.readContract({
            address: CONTRACTS.diamond,
            abi: ARBITER_REGISTRY_ABI as Abi,
            functionName: 'getArbiters',
          }) as string[];
          if (arbiters.length > 0) {
            const xmtp = await initXmtpClient(walletClient);
            await notifyArbiters(xmtp, agreementAddr, arbiters);
          }
        } catch { /* non-critical */ }
      }
      setTimeout(() => refetch(), 2000);
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      toast.error(e?.shortMessage || e?.message || 'Transaction failed');
    } finally {
      setBusy(false);
    }
  };

  const handleFund = async () => {
    if (!walletClient || !publicClient || !parsed) { toast.error('Wallet not connected'); return; }
    setBusy(true);
    try {
      toast('Sign 1/2: USDC permit in wallet…');
      await fundAgreementGasless(walletClient, publicClient, agreementAddr as `0x${string}`, parsed.amount);
      toast.success('Deal funded!');
      setTimeout(() => refetch(), 4000);
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      const msg = e?.shortMessage || e?.message || 'Fund failed';
      if (msg.includes('AlreadyFunded')) {
        toast.error('Already funded — refreshing…');
        setTimeout(() => refetch(), 1000);
      } else {
        toast.error(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRaiseDispute = async () => {
    if (!walletClient || !publicClient || !address) { toast.error('Wallet not connected'); return; }
    setDisputeModal(false);
    if (disputeReason.trim()) {
      fetch('/api/dispute-reason', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agreement: agreementAddr, raiser: address, reason: disputeReason.trim() }),
      }).catch(() => {});
    }
    await run('raiseDispute', 'Dispute raised!');
    setDisputeReason('');
  };

  if (!parsed) return null;

  const s = parsed.status;

  return (
    <>
      <div className="flex-shrink-0 border-b border-white/8 bg-black/20 px-4 py-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Status badge */}
          {[
            [0, 'Created',   'text-sky-400/70',     <Clock key="i" className="w-2.5 h-2.5" />],
            [1, 'Funded',    'text-emerald-400/70',  <DollarSign key="i" className="w-2.5 h-2.5" />],
            [2, 'Active',    'text-violet-400/70',   <Timer key="i" className="w-2.5 h-2.5" />],
            [3, 'Completed', 'text-green-400/70',    <CheckCircle key="i" className="w-2.5 h-2.5" />],
            [4, 'Disputed',  'text-red-400/70',      <AlertTriangle key="i" className="w-2.5 h-2.5" />],
            [5, 'Resolved',  'text-purple-400/70',   <Shield key="i" className="w-2.5 h-2.5" />],
            [6, 'Refunded',  'text-white/30',        <ExternalLink key="i" className="w-2.5 h-2.5" />],
          ].filter(([code]) => code === s).map(([, label, cls, icon]) => (
            <span key="status" className={`inline-flex items-center gap-1 text-[11px] font-medium ${cls}`}>
              {icon}{label as string}
            </span>
          ))}
          <span className="text-[11px] text-white/20">·</span>
          <span className="text-[11px] text-white/30 font-mono">
            {formatUnits(parsed.amount, 6)} USDC
          </span>
          <span className="text-[11px] text-white/20">·</span>

          {s === 0 && isClient && (
            <Button size="sm" className="h-7 text-xs gap-1 px-2.5" onClick={handleFund} disabled={busy}>
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <DollarSign className="w-3 h-3" />}
              Fund
            </Button>
          )}
          {s === 1 && isExecutor && (
            <Button size="sm" className="h-7 text-xs gap-1 px-2.5" onClick={() => run('activate', 'Activated!')} disabled={busy}>
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Shield className="w-3 h-3" />}
              Activate
            </Button>
          )}
          {s === 2 && isExecutor && parsed.markedDoneAt === 0n && (
            <Button size="sm" className="h-7 text-xs gap-1 px-2.5" onClick={() => run('markDone', 'Marked as done!')} disabled={busy}>
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
              Mark Done
            </Button>
          )}
          {s === 2 && isClient && parsed.markedDoneAt > 0n && (
            <Button size="sm" className="h-7 text-xs gap-1 px-2.5" onClick={() => run('release', 'Funds released!')} disabled={busy}>
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
              Release
            </Button>
          )}
          {s === 2 && (isClient || isExecutor) && (
            <Button size="sm" variant="destructive" className="h-7 text-xs gap-1 px-2.5" onClick={() => setDisputeModal(true)} disabled={busy}>
              <AlertTriangle className="w-3 h-3" />
              Dispute
            </Button>
          )}
          {s === 4 && isArbiter && (
            <>
              <Button size="sm" variant="destructive" className="h-7 text-xs px-2.5" onClick={() => run('resolveDispute', 'Refunded!', [true])} disabled={busy}>
                Refund Client
              </Button>
              <Button size="sm" className="h-7 text-xs px-2.5" onClick={() => run('resolveDispute', 'Paid executor!', [false])} disabled={busy}>
                Pay Executor
              </Button>
            </>
          )}
          {s === 1 && isParty && activationExpired && (
            <Button size="sm" variant="ghost" className="h-7 text-xs px-2.5 text-orange-400/60 hover:text-orange-400" onClick={() => run('triggerActivationTimeout', 'Refunded!')} disabled={busy}>
              Timeout → Refund
            </Button>
          )}
          {s === 2 && isParty && parsed.markedDoneAt === 0n && deadlineExpired && (
            <Button size="sm" variant="ghost" className="h-7 text-xs px-2.5 text-orange-400/60 hover:text-orange-400" onClick={() => run('triggerDeadlineTimeout', 'Refunded!')} disabled={busy}>
              Deadline → Refund
            </Button>
          )}
          {s === 4 && isParty && arbiterExpired && (
            <Button size="sm" variant="ghost" className="h-7 text-xs px-2.5 text-orange-400/60 hover:text-orange-400" onClick={() => run('triggerArbiterTimeout', 'Refunded!')} disabled={busy}>
              Arbiter idle → Refund
            </Button>
          )}
          {s === 2 && parsed.markedDoneAt > 0n && autoApproveExpired && (
            <Button size="sm" variant="ghost" className="h-7 text-xs px-2.5 text-white/40 hover:text-white/70" onClick={() => run('triggerAutoApprove', 'Auto-approved!')} disabled={busy}>
              Auto-approve
            </Button>
          )}

          <a
            href={`/deal/${agreementAddr}`}
            className="ml-auto text-white/20 hover:text-white/50 transition-colors flex-shrink-0"
            title="Open deal page"
          >
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>

      {/* Dispute modal */}
      {disputeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-zinc-900 border border-white/10 rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="w-4 h-4 text-red-400" />
              <h2 className="text-sm font-semibold text-white">Raise Dispute</h2>
            </div>
            <p className="text-xs text-white/40 mb-4">
              Describe the issue — the arbiter will read this before deciding.
            </p>
            <textarea
              autoFocus
              value={disputeReason}
              onChange={e => setDisputeReason(e.target.value)}
              placeholder="e.g. Executor stopped responding after receiving the brief. Deadline passed with no deliverable."
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
                Confirm
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
