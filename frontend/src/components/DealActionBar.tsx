'use client';

import React, { useMemo, useState, useEffect } from 'react';
import { useAccount, useReadContract, usePublicClient, useWalletClient } from 'wagmi';
import { formatUnits, keccak256, type Abi } from 'viem';
import { toast } from 'react-hot-toast';
import {
  DollarSign, Shield, CheckCircle, AlertTriangle, Loader2,
  ExternalLink, Clock, Timer, Plus, X, ChevronDown, ChevronUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AGREEMENT_ABI, CONTRACTS, DIAMOND_ABI } from '@/config/contracts';
import { ARBITER_REGISTRY_ABI } from '@/config/contracts';
import { ACTIVATION_WINDOW, AUTO_APPROVE_WINDOW } from '@/config/constants';
import { fundAgreementGasless, sendAgreementGasless, proposeExtraGasless } from '@/lib/relay';
import { getXmtpClientIfCached, notifyArbiters } from '@/lib/xmtp';
import { DisputeCostNotice } from '@/components/DisputeCostNotice';
import { useArbiterTimeoutOutcome } from '@/hooks/useArbiterTimeoutOutcome';
import { useTranslations } from 'next-intl';

interface Props {
  agreementAddr: string;
}

// ExtraStatus enum from Agreement.sol: 0=PENDING, 1=ACCEPTED, 2=REJECTED
const EXTRA_STATUS = { PENDING: 0, ACCEPTED: 1, REJECTED: 2 } as const;

interface ExtraItem {
  id: number;
  amount: bigint;
  terms: string;
  status: number;
}

export function DealActionBar({ agreementAddr }: Props) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  // Остальные подписи в этом компоненте — захардкоженный английский (он не
  // локализован целиком, это отдельный долг). Но подпись и тост таймаута
  // арбитра обязаны быть переводимыми: они называют суммы и исход, и врали
  // «Refunded!» там, где котёл делится пополам.
  const t = useTranslations();

  const [busy, setBusy]                   = useState(false);
  const [disputeModal, setDisputeModal]   = useState(false);
  const [disputeReason, setDisputeReason] = useState('');

  // Extras state
  const [extrasList, setExtrasList]     = useState<ExtraItem[]>([]);
  const [extrasOpen, setExtrasOpen]     = useState(false);
  const [extraModal, setExtraModal]     = useState(false);
  const [proposeAmount, setProposeAmount] = useState('');
  const [proposeDesc, setProposeDesc]   = useState('');

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

  const { data: nextExtraId, refetch: refetchExtras } = useReadContract({
    address: agreementAddr as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: 'nextExtraId',
  }) as { data: bigint | undefined; refetch: () => void };

  // Batch-fetch all extras whenever count changes
  useEffect(() => {
    if (!publicClient || !nextExtraId || nextExtraId === 0n) {
      setExtrasList([]);
      return;
    }
    const count = Number(nextExtraId);
    Promise.all(
      Array.from({ length: count }, (_, i) =>
        publicClient.readContract({
          address: agreementAddr as `0x${string}`,
          abi: AGREEMENT_ABI as Abi,
          functionName: 'getExtra',
          args: [BigInt(i)],
        }).then(raw => {
          const e = raw as { amount: bigint; terms: string; status: number };
          return { id: i, amount: e.amount, terms: e.terms, status: Number(e.status) } satisfies ExtraItem;
        }).catch(() => null)
      )
    ).then(results => setExtrasList(results.filter((r): r is ExtraItem => r !== null)));
  }, [nextExtraId, publicClient, agreementAddr]);

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
      disputedAt:   get('disputedAt_',   9) as bigint,
      status:       (statusNum ?? 0) as number,
    };
  }, [details, statusNum]);

  const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
  const isClient   = !!parsed?.client   && parsed.client.toLowerCase()   === address?.toLowerCase();
  const isExecutor = !!parsed?.executor && parsed.executor.toLowerCase() === address?.toLowerCase();
  // claimDispute() sets Agreement.arbiter to the DIAMOND's own address, never
  // the claiming arbiter's EOA — comparing parsed.arbiter here can never match
  // a real wallet once a dispute is claimed, permanently dead-coding the
  // resolveDispute buttons gated on isArbiter below. The real claiming arbiter
  // is only recoverable via getDisputeClaimer() (same getter arbiter/page.tsx
  // already uses for its own dashboard).
  const { data: realArbiter } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: 'getDisputeClaimer',
    args: [agreementAddr as `0x${string}`],
    query: { enabled: statusNum === 4 },
  }) as { data: `0x${string}` | undefined };
  const isArbiter  = !!realArbiter && realArbiter !== ZERO_ADDR && realArbiter.toLowerCase() === address?.toLowerCase();
  const isParty    = isClient || isExecutor;

  // Явка в споре — тот же паттерн, что и getDisputeClaimer выше: читаем только
  // в статусе спора, вне него флаги ничего не значат.
  const { data: clientResponded, refetch: refetchClientResponded } = useReadContract({
    address: agreementAddr as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: 'clientResponded',
    query: { enabled: statusNum === 4 },
  });
  const { data: executorResponded, refetch: refetchExecutorResponded } = useReadContract({
    address: agreementAddr as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: 'executorResponded',
    query: { enabled: statusNum === 4 },
  });
  const { data: disputeWindowSec } = useReadContract({
    address: agreementAddr as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: 'DISPUTE_WINDOW',
    query: { enabled: statusNum === 4 },
  }) as { data: bigint | undefined };

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const activationExpired  = parsed ? parsed.fundedAt > 0n && nowSec > parsed.fundedAt + ACTIVATION_WINDOW : false;
  const autoApproveExpired = parsed ? parsed.markedDoneAt > 0n && nowSec >= parsed.markedDoneAt + AUTO_APPROVE_WINDOW : false;
  const deadlineExpired    = timeLeft !== undefined && timeLeft === 0n;
  const arbiterExpired     = arbiterTimeLeft !== undefined && arbiterTimeLeft === 0n;

  // Дележ (за спор никто не взялся) или возврат клиенту (взялись и не довели) —
  // решает поле `arbiter`, которое здесь уже прочитано выше.
  const arbiterTimeout = useArbiterTimeoutOutcome(
    agreementAddr,
    parsed?.arbiter,
    statusNum === 4 && arbiterExpired && isParty,
  );

  // Та же явка, что и на странице сделки — моя сторона ещё не откликнулась, и
  // окно (DISPUTE_WINDOW, читается с контракта) не закрыто.
  const myResponsePending = !!parsed && parsed.status === 4 && (
    (isClient   && clientResponded   === false) ||
    (isExecutor && executorResponded === false)
  );
  const responseDeadline = parsed && parsed.disputedAt > 0n && disputeWindowSec
    ? new Date(Number(parsed.disputedAt + disputeWindowSec) * 1000)
    : undefined;
  const responseWindowOpen = !!responseDeadline && responseDeadline.getTime() > Date.now();

  const pendingExtras  = extrasList.filter(e => e.status === EXTRA_STATUS.PENDING);
  const acceptedExtras = extrasList.filter(e => e.status === EXTRA_STATUS.ACCEPTED);
  const hasExtras      = extrasList.length > 0;

  // Возвращает true/false по успеху — тот же контракт, что и handleAction на
  // странице сделки, нужен вызывающим, которые дожидаются подтверждения перед
  // своим собственным refetch (кнопка отклика на спор ниже).
  const run = async (fn: string, successMsg: string, args: unknown[] = []): Promise<boolean> => {
    if (!walletClient || !publicClient) { toast.error('Wallet not connected'); return false; }
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
            // Use cached client only — never trigger a new wallet signature here.
            const xmtp = getXmtpClientIfCached(address!);
            if (xmtp) await notifyArbiters(xmtp, agreementAddr, arbiters);
          }
        } catch { /* non-critical */ }
      }
      // Keep `busy` set until this delayed refetch actually lands, instead of
      // clearing it immediately in a blanket finally — the relay call already
      // waits for on-chain confirmation, but the refetch is deliberately
      // delayed to dodge read-after-write lag on the load-balanced RPC, so
      // `parsed` stays stale for that whole window. Clearing busy right away
      // re-enabled every action button gated on that stale state, letting a
      // same/related action re-fire against state that had already moved on
      // (wasting a signature on a guaranteed on-chain revert).
      if (fn === 'acceptExtra' || fn === 'rejectExtra') {
        setTimeout(() => { refetchExtras(); setBusy(false); }, 2000);
      } else if (fn === 'respondToDispute') {
        // Same lag, same fix: an immediate refetch here would race the same
        // load-balanced-RPC read-after-write gap as `refetch()` below — the
        // flag would come back stale `false`, the button would stay visible
        // past its own success, and a second click would burn a signature on
        // a guaranteed AlreadyResponded revert.
        setTimeout(() => { refetch(); refetchClientResponded(); refetchExecutorResponded(); setBusy(false); }, 2000);
      } else {
        setTimeout(() => { refetch(); setBusy(false); }, 2000);
      }
      return true;
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      toast.error(e?.shortMessage || e?.message || 'Transaction failed');
      setBusy(false);
      return false;
    }
  };

  const handleFund = async () => {
    if (!walletClient || !publicClient || !parsed) { toast.error('Wallet not connected'); return; }
    setBusy(true);
    try {
      toast('Sign 1/2: USDC permit in wallet…');
      await fundAgreementGasless(walletClient, publicClient, agreementAddr as `0x${string}`, parsed.amount);
      toast.success('Deal funded!');
      setTimeout(() => { refetch(); setBusy(false); }, 4000);
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      const msg = e?.shortMessage || e?.message || 'Fund failed';
      if (msg.includes('AlreadyFunded')) {
        toast.error('Already funded — refreshing…');
        setTimeout(() => { refetch(); setBusy(false); }, 1000);
      } else {
        toast.error(msg);
        setBusy(false);
      }
    }
  };

  const handleProposeExtra = async () => {
    if (!walletClient || !publicClient) return;
    const parsed_ = parseFloat(proposeAmount);
    if (!proposeAmount || isNaN(parsed_) || parsed_ <= 0) {
      toast.error('Enter a valid amount');
      return;
    }
    const amountParsed = BigInt(Math.round(parsed_ * 1e6));
    setBusy(true);
    try {
      toast('Sign 1/2: USDC permit in wallet…');
      // Agreement.sol stores extraTerms verbatim (never hashed) as Extra.terms —
      // sending a hash here (as this used to) permanently corrupts the
      // description into an unrecoverable hex string every time.
      const extraTerms = proposeDesc.trim() || `${proposeAmount} USDC extra`;
      await proposeExtraGasless(walletClient, publicClient, agreementAddr as `0x${string}`, amountParsed, extraTerms);
      toast.success('Extra proposed!');
      setExtraModal(false);
      setProposeAmount('');
      setProposeDesc('');
      setTimeout(() => { refetchExtras(); setBusy(false); }, 3000);
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      toast.error(e?.shortMessage || e?.message || 'Failed to propose extra');
      setBusy(false);
    }
  };

  const handleRaiseDispute = async () => {
    if (!walletClient || !publicClient || !address) { toast.error('Wallet not connected'); return; }
    setDisputeModal(false);
    // Set busy BEFORE the dispute-reason signature below — otherwise the modal is
    // already closed and the "Dispute" button (gated only on `busy`) stays enabled
    // for the whole signMessage wait, letting it reopen the modal and fire a
    // second, concurrent raiseDispute attempt. run() still clears this — either
    // in its delayed success callback or in its catch block.
    setBusy(true);
    if (disputeReason.trim()) {
      try {
        const ts = Math.floor(Date.now() / 1000);
        const reasonHash = keccak256(new TextEncoder().encode(disputeReason.trim()));
        const msg = `hexseal:dispute-reason:${agreementAddr.toLowerCase()}:${ts}:${reasonHash}`;
        const sig = await walletClient.signMessage({ account: address as `0x${string}`, message: msg });
        fetch('/api/dispute-reason', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agreement: agreementAddr, raiser: address, reason: disputeReason.trim(), ts, sig }),
        }).catch(() => {});
      } catch {
        // non-critical — proceed with raiseDispute even if signing fails
      }
    }
    await run('raiseDispute', 'Dispute raised!');
    setDisputeReason('');
  };

  if (!parsed) return null;

  const s = parsed.status;
  const canProposeExtra = s === 2 && isClient && parsed.markedDoneAt === 0n;
  const hasPendingForExecutor = s === 2 && isExecutor && pendingExtras.length > 0;

  return (
    <>
      {/* ── Main action bar ────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 border-b border-white/8 bg-black/20 px-4 py-2">
        {/* Цена молчания — видимая строка, не title: на тач-устройствах
            (а в чат заходят чаще с телефона, чем с десктопа) наведения нет,
            title там не показывается никогда. Стоит над рядом кнопок, вне
            flex-wrap с ними — то же место, что и баннер на странице сделки,
            просто без рамки, чтобы не раздувать плотный бар. Показывается
            только вместе с самой кнопкой (myResponsePending &&
            responseWindowOpen) — предупреждение нужно ровно тогда, когда
            есть что предупреждать. */}
        {myResponsePending && responseWindowOpen && responseDeadline && (
          <p className="text-[11px] text-amber-400/70 leading-relaxed mb-1.5">
            {t("deal.dispute_respond_prompt", { date: responseDeadline.toLocaleString() })}
          </p>
        )}
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
            {acceptedExtras.length > 0 && (
              <span className="text-emerald-400/60 ml-1">
                +{formatUnits(acceptedExtras.reduce((s, e) => s + e.amount, 0n), 6)}
              </span>
            )}
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
            <Button size="sm" variant="ghost" className="h-7 text-xs px-2.5 text-orange-400/60 hover:text-orange-400" onClick={() => run('triggerArbiterTimeout', arbiterTimeout.successToast)} disabled={busy}>
              {arbiterTimeout.buttonLabel}
            </Button>
          )}
          {myResponsePending && responseWindowOpen && (
            // Сама цена молчания и срок — видимой строкой над рядом кнопок
            // (см. блок перед `flex items-center gap-1.5 flex-wrap` выше),
            // не здесь: title не виден на тач-устройствах вовсе, а с телефона
            // в чат заходят чаще, чем с десктопа. `title` оставлен только как
            // бонус-подсказка для десктопной мыши, не единственный носитель.
            <Button size="sm" variant="secondary" className="h-7 text-xs px-2.5"
              title={responseDeadline ? t("deal.dispute_respond_prompt", { date: responseDeadline.toLocaleString() }) : undefined}
              onClick={() => run('respondToDispute', t("deal.dispute_respond_success"))}
              disabled={busy}>
              {t("deal.dispute_respond_btn")}
            </Button>
          )}
          {s === 2 && parsed.markedDoneAt > 0n && autoApproveExpired && (
            <Button size="sm" variant="ghost" className="h-7 text-xs px-2.5 text-white/40 hover:text-white/70" onClick={() => run('triggerAutoApprove', 'Auto-approved!')} disabled={busy}>
              Auto-approve
            </Button>
          )}

          {/* ── Extra buttons ── */}
          {canProposeExtra && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs gap-1 px-2 text-emerald-400/60 hover:text-emerald-400 hover:bg-emerald-400/10"
              onClick={() => setExtraModal(true)}
              disabled={busy}
            >
              <Plus className="w-3 h-3" />
              Extra
            </Button>
          )}
          {/* Executor: pending extras badge — toggles the inline panel */}
          {hasPendingForExecutor && (
            <button
              onClick={() => setExtrasOpen(v => !v)}
              className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] font-medium text-amber-400/80 bg-amber-400/10 hover:bg-amber-400/15 transition-colors"
            >
              {pendingExtras.length} pending
              {extrasOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          )}
          {/* Client: show extras summary (toggles panel) when there are any */}
          {isClient && hasExtras && s === 2 && (
            <button
              onClick={() => setExtrasOpen(v => !v)}
              className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors"
            >
              {extrasList.length} extra{extrasList.length !== 1 ? 's' : ''}
              {extrasOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          )}

          <a
            href={`/deal/${agreementAddr}`}
            className="ml-auto text-white/20 hover:text-white/50 transition-colors flex-shrink-0"
            title="Open deal page"
          >
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>

        {/* ── Extras inline panel ─────────────────────────────────────────── */}
        {extrasOpen && hasExtras && (
          <div className="mt-2 pt-2 border-t border-white/[0.06] space-y-1.5">
            {extrasList.map(ex => (
              <div key={ex.id} className="flex items-center gap-2">
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                  ex.status === EXTRA_STATUS.PENDING  ? 'bg-amber-400/10 text-amber-400/80' :
                  ex.status === EXTRA_STATUS.ACCEPTED ? 'bg-emerald-400/10 text-emerald-400/80' :
                  'bg-white/5 text-white/25 line-through'
                }`}>
                  {ex.status === EXTRA_STATUS.PENDING ? 'PENDING' : ex.status === EXTRA_STATUS.ACCEPTED ? 'ACCEPTED' : 'REJECTED'}
                </span>
                <span className="text-xs font-mono text-white/60">
                  +{formatUnits(ex.amount, 6)} USDC
                </span>
                {isExecutor && ex.status === EXTRA_STATUS.PENDING && (
                  <>
                    <Button
                      size="sm"
                      className="h-5 px-2 text-[10px] ml-auto"
                      onClick={() => run('acceptExtra', 'Extra accepted!', [BigInt(ex.id)])}
                      disabled={busy}
                    >
                      Accept
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 px-2 text-[10px] text-white/35"
                      onClick={() => run('rejectExtra', 'Extra rejected', [BigInt(ex.id)])}
                      disabled={busy}
                    >
                      Reject
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Propose Extra modal ─────────────────────────────────────────────── */}
      {extraModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[#111113] border border-white/[0.08] rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <Plus className="w-4 h-4 text-emerald-400" />
                <h2 className="text-sm font-semibold text-white">Propose Extra Payment</h2>
              </div>
              <button
                onClick={() => { setExtraModal(false); setProposeAmount(''); setProposeDesc(''); }}
                className="text-white/30 hover:text-white/60 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-white/40 mb-4">
              Agree on additional work in chat, then lock the payment here. Executor must accept before it counts.
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-[11px] text-white/40 mb-1 block">Amount (USDC)</label>
                <input
                  autoFocus
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={proposeAmount}
                  onChange={e => setProposeAmount(e.target.value)}
                  placeholder="e.g. 50"
                  className="w-full bg-[#0d0d0f] border border-white/[0.08] rounded-xl px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-emerald-500/40"
                />
              </div>
              <div>
                <label className="text-[11px] text-white/40 mb-1 block">Description (optional)</label>
                <input
                  type="text"
                  value={proposeDesc}
                  onChange={e => setProposeDesc(e.target.value)}
                  placeholder="e.g. Add dark mode to the dashboard"
                  maxLength={200}
                  className="w-full bg-[#0d0d0f] border border-white/[0.08] rounded-xl px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-emerald-500/40"
                />
              </div>
            </div>
            <div className="flex gap-3 justify-end mt-5">
              <Button size="sm" variant="ghost" onClick={() => { setExtraModal(false); setProposeAmount(''); setProposeDesc(''); }}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white"
                onClick={handleProposeExtra}
                disabled={busy || !proposeAmount}
              >
                {busy
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <DollarSign className="w-3.5 h-3.5" />
                }
                Lock {proposeAmount ? `${proposeAmount} USDC` : 'Payment'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Dispute modal ───────────────────────────────────────────────────── */}
      {disputeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[#111113] border border-white/[0.08] rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="w-4 h-4 text-red-400" />
              <h2 className="text-sm font-semibold text-white">Raise Dispute</h2>
            </div>
            {/* Не «арбитр прочитает это перед решением»: строкой ниже
                DisputeCostNotice честно говорит, что за спор могут и не
                взяться. Обещать арбитра как данность в том же окне, где мы это
                обещание снимаем, — противоречие внутри одного экрана. */}
            <p className="text-xs text-white/40 mb-3">{t('deal.dispute_reason_hint')}</p>
            {/* Тот же диалог, что и на странице сделки, поэтому то же
                предупреждение: спор стоит денег и может закончиться дележом
                пополам. Открыть спор можно из трёх мест — все три обязаны это
                показывать, иначе гарантия зависит от того, откуда нажали. */}
            <div className="mb-3">
              <DisputeCostNotice agreementAddr={agreementAddr} />
            </div>
            <textarea
              autoFocus
              value={disputeReason}
              onChange={e => setDisputeReason(e.target.value)}
              placeholder="e.g. Executor stopped responding after receiving the brief. Deadline passed with no deliverable."
              rows={4}
              maxLength={2000}
              className="w-full bg-[#0d0d0f] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-red-500/40 resize-none"
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
