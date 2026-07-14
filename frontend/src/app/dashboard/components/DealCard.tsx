'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useReadContract, usePublicClient, useWalletClient } from 'wagmi';
import { isAddress } from 'viem';
import type { Abi } from 'viem';
import { AGREEMENT_ABI, USDC_ABI, CONTRACTS } from '@/config/contracts';
import { ACTIVATION_WINDOW, AUTO_APPROVE_WINDOW } from '@/config/constants';
import { fundAgreementGasless, sendAgreementGasless, proposeExtraGasless } from '@/lib/relay';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'react-hot-toast';
import {
  Loader2, CheckCircle,
  Copy, ExternalLink, Play, Flag, Shield, Timer,
  ChevronDown, MessageCircle, Plus, X,
} from 'lucide-react';
import { shortAddr } from '@/lib/utils';

const EXTRA_STATUS = { PENDING: 0, ACCEPTED: 1, REJECTED: 2 } as const;
interface ExtraItem { id: number; amount: bigint; terms: string; status: number; }

export interface AgreementRecord {
  agreement: string;
  client: string;
  executor: string;
  amount: bigint;
  status: number;
  createdAt: bigint;
  resolvedAt: bigint;
  title?: string;
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

export const DEAL_STATUS: Record<number, { label: string; dot: string; textCls: string }> = {
  0: { label: 'Created',   dot: 'bg-sky-400',     textCls: 'text-sky-400' },
  1: { label: 'Funded',    dot: 'bg-emerald-400', textCls: 'text-emerald-400' },
  2: { label: 'Active',    dot: 'bg-violet-400',  textCls: 'text-violet-400' },
  3: { label: 'Completed', dot: 'bg-green-400',   textCls: 'text-green-400' },
  4: { label: 'Disputed',  dot: 'bg-red-400',     textCls: 'text-red-400' },
  5: { label: 'Resolved',  dot: 'bg-purple-400',  textCls: 'text-purple-400' },
  6: { label: 'Refunded',  dot: 'bg-gray-400',    textCls: 'text-white/35' },
};

export function DealCard({ agreement, address, refetch }: {
  agreement: AgreementRecord;
  address: string;
  refetch: () => void;
}) {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const t  = useTranslations();
  const tc = useTranslations('dashboard.card');
  const [busy, setBusy] = useState(false);
  const [showTimeouts, setShowTimeouts] = useState(false);
  const [disputeOpen, setDisputeOpen]     = useState(false);
  const [disputeReason, setDisputeReason] = useState('');

  // Extras
  const [extrasList, setExtrasList]   = useState<ExtraItem[]>([]);
  const [showExtras, setShowExtras]   = useState(false);
  const [proposeOpen, setProposeOpen] = useState(false);
  const [proposeAmount, setProposeAmount] = useState('');
  const [proposeDesc, setProposeDesc]     = useState('');

  const { data: nextExtraId, refetch: refetchExtras } = useReadContract({
    address: agreement.agreement as `0x${string}`,
    abi: AGREEMENT_ABI, functionName: 'nextExtraId',
    query: { enabled: isAddress(agreement.agreement) },
  }) as { data: bigint | undefined; refetch: () => void };

  useEffect(() => {
    if (!publicClient || !nextExtraId || nextExtraId === 0n) { setExtrasList([]); return; }
    const count = Number(nextExtraId);
    Promise.all(
      Array.from({ length: count }, (_, i) =>
        publicClient.readContract({
          address: agreement.agreement as `0x${string}`,
          abi: AGREEMENT_ABI as Abi,
          functionName: 'getExtra',
          args: [BigInt(i)],
        }).then((e: any) => ({ id: i, amount: e.amount, terms: e.terms, status: Number(e.status) } satisfies ExtraItem))
          .catch(() => null)
      )
    ).then(results => setExtrasList(results.filter((r): r is ExtraItem => r !== null)));
  }, [nextExtraId, publicClient, agreement.agreement]);

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

  const statusLabels: Record<number, string> = {
    0: t('deal_status.created'),
    1: t('deal_status.funded'),
    2: t('deal_status.active'),
    3: t('deal_status.completed'),
    4: t('deal_status.disputed'),
    5: t('deal_status.resolved'),
    6: t('deal_status.refunded'),
  };

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
  const autoApproveRemaining =
    markedDoneAt > 0n && !autoApproveExpired
      ? markedDoneAt + AUTO_APPROVE_WINDOW - nowSec
      : 0n;
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
      activate:    tc('activate_success'),
      markDone:    t('deal.mark_done_success'),
      release:     tc('release_success'),
      raiseDispute: tc('dispute_success'),
      triggerActivationTimeout: t('deal.timeout_activation_success'),
      triggerDeadlineTimeout:   t('deal.timeout_deadline_success'),
      triggerArbiterTimeout:    t('deal.timeout_arbiter_success'),
      triggerAutoApprove:       t('deal.timeout_auto_approve_success'),
    };
    try {
      toast(tc('sign_wallet'));
      await sendAgreementGasless(walletClient, publicClient, agreement.agreement as `0x${string}`, fn, AGREEMENT_ABI as Abi);
      toast.success(successMsg[fn] ?? 'Done!');
      setTimeout(refetch, 2000);
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || 'Transaction failed');
    } finally { setBusy(false); }
  };

  const handleProposeExtra = async () => {
    if (!walletClient || !publicClient) return;
    const parsed_ = parseFloat(proposeAmount);
    if (!proposeAmount || isNaN(parsed_) || parsed_ <= 0) { toast.error('Enter a valid amount'); return; }
    setBusy(true);
    try {
      toast(tc('sign_wallet'));
      const amountParsed = BigInt(Math.round(parsed_ * 1e6));
      const extraTerms = proposeDesc.trim() || `${proposeAmount} USDC extra`;
      await proposeExtraGasless(walletClient, publicClient, agreement.agreement as `0x${string}`, amountParsed, extraTerms);
      toast.success('Extra proposed!');
      setProposeOpen(false);
      setProposeAmount('');
      setProposeDesc('');
      setTimeout(() => refetchExtras(), 3000);
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      toast.error(e?.shortMessage || e?.message || 'Failed');
    } finally { setBusy(false); }
  };

  const handleExtraAction = async (fn: 'acceptExtra' | 'rejectExtra', extraId: number) => {
    if (!walletClient || !publicClient) return;
    setBusy(true);
    try {
      await sendAgreementGasless(walletClient, publicClient, agreement.agreement as `0x${string}`, fn, AGREEMENT_ABI as Abi, [BigInt(extraId)]);
      toast.success(fn === 'acceptExtra' ? 'Extra accepted' : 'Extra rejected');
      setTimeout(() => refetchExtras(), 2000);
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      toast.error(e?.shortMessage || e?.message || 'Failed');
    } finally { setBusy(false); }
  };

  const pendingExtras = extrasList.filter(e => e.status === EXTRA_STATUS.PENDING);

  const handleRaiseDispute = async () => {
    if (!walletClient || !publicClient) return;
    setDisputeOpen(false);
    setBusy(true);
    try {
      if (disputeReason.trim()) {
        fetch('/api/dispute-reason', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agreement: agreement.agreement, raiser: address, reason: disputeReason.trim() }),
        }).catch(() => {});
      }
      toast(tc('sign_wallet'));
      await sendAgreementGasless(walletClient, publicClient, agreement.agreement as `0x${string}`, 'raiseDispute', AGREEMENT_ABI as Abi);
      toast.success(tc('dispute_success'));
      setDisputeReason('');
      setTimeout(refetch, 2000);
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      toast.error(e?.shortMessage || e?.message || 'Failed');
    } finally { setBusy(false); }
  };

  const primaryActions: React.ReactNode[] = [];
  if (liveStatus === 0 && isClient) primaryActions.push(
    <div key="fund-group" className="flex items-center gap-2 flex-wrap">
      <Button size="sm" disabled={busy || !hasEnoughUsdc} onClick={async () => {
        if (!publicClient || !walletClient) { toast.error('Wallet not connected'); return; }
        setBusy(true);
        try {
          toast(tc('sign_wallet'));
          await fundAgreementGasless(walletClient, publicClient, agreement.agreement as `0x${string}`, agreement.amount);
          toast.success(t('deal.fund_success'));
          setTimeout(refetch, 4000);
        } catch (err: unknown) {
          const e = err as { shortMessage?: string; message?: string };
          const msg = e?.shortMessage || e?.message || t('deal.fund_failed');
          if (msg.includes('AlreadyFunded')) { toast.error(t('deal.already_funded')); refetch(); }
          else toast.error(msg);
        } finally { setBusy(false); }
      }}>
        {busy ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Play className="w-3 h-3 mr-1" />}{tc('fund_btn')}
      </Button>
      {!hasEnoughUsdc && userUsdcBalance !== undefined && (
        <span className="text-xs text-red-400">
          {tc('insufficient_usdc')} ({formatAmount(userUsdcBalance)} / {formatAmount(agreement.amount)})
        </span>
      )}
    </div>
  );
  if (liveStatus === 1 && isExecutor) primaryActions.push(
    <div key="activate-group" className="flex flex-col gap-1.5 w-full">
      <p className="text-xs text-amber-400/70">{tc('activate_hint')}</p>
      <Button size="sm" disabled={busy} onClick={() => run('activate')} className="self-start gap-1">
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}{tc('activate_btn')}
      </Button>
    </div>
  );
  if (liveStatus === 2 && isExecutor && markedDoneAt === BigInt(0)) primaryActions.push(
    <Button key="markDone" size="sm" disabled={busy} onClick={() => run('markDone')}>
      {busy ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <CheckCircle className="w-3 h-3 mr-1" />}{tc('mark_done_btn')}
    </Button>
  );
  if (liveStatus === 2 && isClient && markedDoneAt > BigInt(0)) primaryActions.push(
    <div key="release-group" className="flex flex-col gap-1">
      {autoApproveRemaining > 0n && (
        <span className="text-[11px] text-white/30">
          {tc('auto_approve_in', { time: formatTimeLeft(autoApproveRemaining) })}
        </span>
      )}
      <Button size="sm" disabled={busy} onClick={() => run('release')}>
        {busy ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <CheckCircle className="w-3 h-3 mr-1" />}{tc('release_btn')}
      </Button>
    </div>
  );
  if (liveStatus === 2 && (isClient || isExecutor)) primaryActions.push(
    <Button key="dispute" size="sm" variant="destructive" disabled={busy} onClick={() => setDisputeOpen(v => !v)}>
      <Flag className="w-3 h-3 mr-1" />{tc('dispute_btn')}
    </Button>
  );

  const timeoutActions: React.ReactNode[] = [];
  if (liveStatus === 1 && (isClient || isExecutor) && activationExpired) timeoutActions.push(
    <Button key="actTimeout" size="sm" variant="outline" className="text-orange-400 border-orange-400/30 hover:bg-orange-400/10" disabled={busy} onClick={() => run('triggerActivationTimeout')}>
      <Timer className="w-3 h-3 mr-1" />{t('deal.timeout_activation')}
    </Button>
  );
  if (liveStatus === 2 && (isClient || isExecutor) && markedDoneAt === BigInt(0) && deadlineExpired) timeoutActions.push(
    <Button key="dlTimeout" size="sm" variant="outline" className="text-orange-400 border-orange-400/30 hover:bg-orange-400/10" disabled={busy} onClick={() => run('triggerDeadlineTimeout')}>
      <Timer className="w-3 h-3 mr-1" />{t('deal.timeout_deadline')}
    </Button>
  );
  if (liveStatus === 4 && (isClient || isExecutor) && arbiterExpired) timeoutActions.push(
    <Button key="arbTimeout" size="sm" variant="outline" className="text-orange-400 border-orange-400/30 hover:bg-orange-400/10" disabled={busy} onClick={() => run('triggerArbiterTimeout')}>
      <Timer className="w-3 h-3 mr-1" />{t('deal.timeout_arbiter')}
    </Button>
  );
  if (liveStatus === 2 && markedDoneAt > BigInt(0) && autoApproveExpired) timeoutActions.push(
    <Button key="autoApprove" size="sm" variant="outline" className="text-orange-400 border-orange-400/30 hover:bg-orange-400/10" disabled={busy} onClick={() => run('triggerAutoApprove')}>
      <Shield className="w-3 h-3 mr-1" />{t('deal.timeout_auto_approve')}
    </Button>
  );

  const needsAction = primaryActions.length > 0;

  return (
    <div
      className={`rounded-[22px] border transition-colors ${
        needsAction ? 'border-white/[0.13] bg-[#0d0d0f]' : 'border-white/[0.08] bg-[#0d0d0f]'
      }`}
      style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}
    >
      <div className="px-4 py-3.5 sm:px-5">

        {/* Title row */}
        <div className="flex items-start justify-between gap-2 mb-1">
          <div className="min-w-0">
            {agreement.title ? (
              <>
                <p className="text-[13px] font-semibold text-white/90 truncate leading-snug">
                  {agreement.title}
                </p>
                <p className="text-[10px] font-mono text-white/25 leading-none mt-0.5">
                  #{agreement.agreement.slice(2, 10).toUpperCase()}
                </p>
              </>
            ) : (
              <p className="text-[13px] font-semibold text-white/90 font-mono truncate leading-snug">
                #{agreement.agreement.slice(2, 10).toUpperCase()}
              </p>
            )}
          </div>
          <div className="flex items-center gap-0.5 flex-shrink-0">
            <Link href={`/chat?peer=${counterparty.toLowerCase()}`}>
              <Button size="sm" variant="ghost" className="text-white/25 hover:text-white/60 h-6 w-6 p-0">
                <MessageCircle className="w-3.5 h-3.5" />
              </Button>
            </Link>
            <Link href={`/deal/${agreement.agreement}`}>
              <Button size="sm" variant="ghost" className="text-white/25 hover:text-white/60 h-6 w-6 p-0">
                <ExternalLink className="w-3.5 h-3.5" />
              </Button>
            </Link>
          </div>
        </div>

        {/* Meta line */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.dot}`} />
          <span className={`text-[11px] font-medium ${s.textCls}`}>{statusLabels[liveStatus] ?? s.label}</span>
          <span className="text-[11px] text-white/15 select-none">·</span>
          <span className="text-[11px] font-mono text-white/55">{formatAmount(agreement.amount)} USDC</span>
          <span className="text-[11px] text-white/15 select-none">·</span>
          <button
            onClick={() => { navigator.clipboard.writeText(counterparty); toast.success('Copied'); }}
            className="flex items-center gap-1 text-[11px] text-white/35 hover:text-white/55 transition-colors"
          >
            {shortAddr(counterparty)}
            <Copy className="w-2.5 h-2.5 opacity-40" />
          </button>
          {timeLeft !== undefined && liveStatus < 3 && timeLeft > 0n && (
            <>
              <span className="text-[11px] text-white/15 select-none">·</span>
              <span className={`text-[11px] ${isUrgent(timeLeft) ? 'text-orange-400' : 'text-white/35'}`}>
                {formatTimeLeft(timeLeft)}
              </span>
            </>
          )}
          {liveStatus === 4 && arbiterTimeLeft && arbiterTimeLeft > 0n && (
            <>
              <span className="text-[11px] text-white/15 select-none">·</span>
              <span className={`text-[11px] ${isUrgent(arbiterTimeLeft) ? 'text-orange-400' : 'text-white/35'}`}>
                arbiter {formatTimeLeft(arbiterTimeLeft)}
              </span>
            </>
          )}
        </div>

        {/* Primary actions */}
        {primaryActions.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3">{primaryActions}</div>
        )}

        {/* Dispute reason panel */}
        {disputeOpen && (
          <div className="mt-2 rounded-[12px] border border-red-400/20 bg-red-400/[0.03] p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-red-400/60 font-semibold uppercase tracking-wider">{tc('dispute_title')}</span>
              <button onClick={() => { setDisputeOpen(false); setDisputeReason(''); }}>
                <X className="w-3 h-3 text-white/25 hover:text-white/60" />
              </button>
            </div>
            <Textarea
              placeholder={tc('dispute_placeholder')}
              value={disputeReason}
              onChange={e => setDisputeReason(e.target.value)}
              maxLength={2000}
              rows={3}
              className="text-xs bg-white/[0.04] border-white/10 resize-none"
            />
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-white/20">{disputeReason.length}/2000</span>
              <Button size="sm" variant="destructive" className="h-6 text-[11px]" disabled={busy || !disputeReason.trim()} onClick={handleRaiseDispute}>
                {busy ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Flag className="w-3 h-3 mr-1" />}{tc('dispute_confirm')}
              </Button>
            </div>
          </div>
        )}

        {/* Timeout toggle */}
        {timeoutActions.length > 0 && (
          <div className="mt-2">
            <button onClick={() => setShowTimeouts(v => !v)}
              className="flex items-center gap-1 text-xs text-white/25 hover:text-white/50 transition-colors">
              <ChevronDown className={`w-3 h-3 transition-transform ${showTimeouts ? 'rotate-180' : ''}`} />
              {showTimeouts ? tc('timeouts_hide') : tc('timeouts_show')}
            </button>
          </div>
        )}
      </div>

      {showTimeouts && timeoutActions.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 sm:px-5 pb-4 border-t border-white/5 pt-3">
          {timeoutActions}
        </div>
      )}

      {/* Extras — visible only in ACTIVE status */}
      {liveStatus === 2 && (isClient || isExecutor) && (
        <div className="border-t border-white/[0.06]">
          <div className="px-4 sm:px-5 py-2.5 flex items-center justify-between">
            <button
              onClick={() => setShowExtras(v => !v)}
              className="flex items-center gap-1.5 text-xs text-white/30 hover:text-white/55 transition-colors"
            >
              <ChevronDown className={`w-3 h-3 transition-transform ${showExtras ? 'rotate-180' : ''}`} />
              {tc('extras_label')}
              {pendingExtras.length > 0 && (
                <span className="ml-1 bg-amber-400/20 text-amber-400 text-[10px] font-mono px-1.5 py-0.5 rounded-full">
                  {pendingExtras.length}
                </span>
              )}
            </button>
            {showExtras && isClient && !proposeOpen && (
              <button
                onClick={() => setProposeOpen(true)}
                className="flex items-center gap-1 text-[11px] text-white/30 hover:text-white/60 transition-colors"
              >
                <Plus className="w-3 h-3" />{tc('extras_propose')}
              </button>
            )}
          </div>

          {showExtras && (
            <div className="px-4 sm:px-5 pb-3 space-y-2">
              {/* Propose form */}
              {proposeOpen && isClient && (
                <div className="rounded-[12px] border border-white/[0.08] bg-white/[0.02] p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-white/40">{tc('extras_propose_title')}</span>
                    <button onClick={() => { setProposeOpen(false); setProposeAmount(''); setProposeDesc(''); }}>
                      <X className="w-3 h-3 text-white/25 hover:text-white/60" />
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="number" placeholder={tc('extras_amount')} value={proposeAmount}
                      onChange={e => setProposeAmount(e.target.value)}
                      className="h-7 text-xs bg-white/[0.04] border-white/10 flex-1"
                    />
                    <Input
                      placeholder={tc('extras_note')} value={proposeDesc}
                      onChange={e => setProposeDesc(e.target.value)}
                      className="h-7 text-xs bg-white/[0.04] border-white/10 flex-[2]"
                    />
                  </div>
                  <Button size="sm" className="h-6 text-[11px]" disabled={busy || !proposeAmount} onClick={handleProposeExtra}>
                    {busy ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}{tc('extras_propose_btn')}
                  </Button>
                </div>
              )}

              {/* Pending extras */}
              {pendingExtras.map(extra => (
                <div key={extra.id} className="rounded-[10px] border border-amber-400/15 bg-amber-400/[0.03] px-3 py-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-mono text-amber-300/80">+{(Number(extra.amount) / 1e6).toFixed(2)} USDC</span>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => handleExtraAction('acceptExtra', extra.id)}
                      disabled={busy}
                      className="text-[11px] text-emerald-400 hover:text-emerald-300 transition-colors disabled:opacity-40"
                    >{tc('extras_accept')}</button>
                    <span className="text-white/15">·</span>
                    <button
                      onClick={() => handleExtraAction('rejectExtra', extra.id)}
                      disabled={busy}
                      className="text-[11px] text-red-400/60 hover:text-red-400 transition-colors disabled:opacity-40"
                    >{tc('extras_reject')}</button>
                  </div>
                </div>
              ))}

              {extrasList.length === 0 && !proposeOpen && (
                <p className="text-[11px] text-white/20 text-center py-1">{tc('extras_empty')}</p>
              )}

              {/* Accepted extras summary */}
              {extrasList.filter(e => e.status === EXTRA_STATUS.ACCEPTED).length > 0 && (
                <p className="text-[11px] text-white/25 text-center">
                  {tc('extras_accepted', { count: extrasList.filter(e => e.status === EXTRA_STATUS.ACCEPTED).length })}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
