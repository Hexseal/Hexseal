"use client";

import React, { useMemo, useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAccount, useReadContract, usePublicClient, useWalletClient } from "wagmi";
import { AGREEMENT_ABI, CONTRACTS, USDC_ABI } from "@/config/contracts";
import { ACTIVATION_WINDOW, AUTO_APPROVE_WINDOW } from "@/config/constants";
import { Button } from "@/components/ui/button";
import { toast } from "react-hot-toast";
import { formatUnits, parseUnits, isAddress, keccak256, type Abi } from "viem";
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
  Plus,
  ChevronDown,
  RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { fundAgreementGasless, sendAgreementGasless, proposeExtraGasless, fundDisputeGasless } from "@/lib/relay";
import { useProfile } from "@/hooks/useProfile";
import { ARBITER_REGISTRY_ABI } from "@/config/contracts";
import { explorerUrl } from "@/config/chain";
import { getXmtpClientIfCached, notifyArbiters } from "@/lib/xmtp";
import { useTranslations } from "next-intl";
import { ContextHint } from "@/components/ContextHint";
import { DisputeCostNotice } from "@/components/DisputeCostNotice";
import { RefundableBounty } from "@/components/RefundableBounty";
import { useArbiterTimeoutOutcome } from "@/hooks/useArbiterTimeoutOutcome";
import { shortAddr } from "@/lib/utils";
import { usdcExact } from "@/lib/splitPot";
import { canFundDispute } from "@/lib/disputeBounty";
import { PageCenter } from "@/components/PageCenter";
import { withWalletLock } from "@/lib/walletLock";

// Agreement status enum matches Solidity:
// 0=CREATED, 1=FUNDED, 2=ACTIVE, 3=COMPLETED, 4=DISPUTED, 5=RESOLVED, 6=REFUNDED


// ─── Party row with profile name + avatar ─────────────────────────────────────

function PartyRow({
  role, addr, isMe, showChat, fixedLabel,
}: {
  role: string; addr: string; isMe: boolean; showChat: boolean; fixedLabel?: string;
}) {
  const { displayName, avatarUrl } = useProfile(addr);
  const t = useTranslations();
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
          {t("common.you")}
        </span>
      )}
      {!isMe && showChat && (
        <Link href={`/chat?peer=${addr}`}>
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

function formatTimeLeft(seconds: bigint | number | undefined, expiredLabel = "Expired"): string {
  if (!seconds || BigInt(seconds) === BigInt(0)) return expiredLabel;
  const s = Number(BigInt(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export default function DealDetailPage() {
  const params = useParams();
  const dealAddress = params?.address as string | undefined;
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  // Какое ИМЕННО действие сейчас летит, а не «летит хоть какое-то». Раньше это
  // был один булев флаг на всю страницу, и спиннер садился не на нажатую
  // кнопку, а на первую попавшуюся: нажатие «Откликнуться на спор»
  // (respondToDispute) зажигало крутилку на «Оплатить N USDC за арбитра»
  // (fundDispute) — снято владельцем с живого экрана. Блокировка при этом
  // остаётся общей: все кнопки здесь ходят в один кошелёк по одной и той же
  // сделке, и параллельная подпись — это гарантированный реверт одной из двух.
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [pendingTxHash, setPendingTxHash] = useState<string | null>(null);
  const [disputeModal, setDisputeModal] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');
  const [proposeModal, setProposeModal] = useState(false);
  const [proposeAmount, setProposeAmount] = useState('');
  const [proposeDesc, setProposeDesc] = useState('');
  const [extrasList, setExtrasList] = useState<Array<{ id: number; amount: bigint; terms: string; status: number }>>([]);
  const [extrasLoading, setExtrasLoading] = useState(false);
  const [extrasVersion, setExtrasVersion] = useState(0);
  const t = useTranslations();

  const AGREEMENT_STATUS: Record<number, { label: string; color: string; dot: string; icon: React.ReactNode }> = {
    0: { label: t("deal_status.created"),   dot: "bg-sky-400",     color: "bg-sky-400/10 text-sky-400 border border-sky-400/20",             icon: <Clock className="w-3.5 h-3.5" /> },
    1: { label: t("deal_status.funded"),    dot: "bg-emerald-400", color: "bg-emerald-400/10 text-emerald-400 border border-emerald-400/20", icon: <DollarSign className="w-3.5 h-3.5" /> },
    2: { label: t("deal_status.active"),    dot: "bg-violet-400",  color: "bg-violet-400/10 text-violet-400 border border-violet-400/20",   icon: <Timer className="w-3.5 h-3.5" /> },
    3: { label: t("deal_status.completed"), dot: "bg-green-400",   color: "bg-green-400/10 text-green-400 border border-green-400/20",      icon: <CheckCircle className="w-3.5 h-3.5" /> },
    4: { label: t("deal_status.disputed"),  dot: "bg-red-400",     color: "bg-red-400/10 text-red-400 border border-red-400/20",            icon: <AlertTriangle className="w-3.5 h-3.5" /> },
    5: { label: t("deal_status.resolved"),  dot: "bg-purple-400",  color: "bg-purple-400/10 text-purple-400 border border-purple-400/20",   icon: <Shield className="w-3.5 h-3.5" /> },
    6: { label: t("deal_status.refunded"),  dot: "bg-gray-400",    color: "bg-gray-400/10 text-gray-400 border border-gray-400/20",         icon: <ArrowRight className="w-3.5 h-3.5" /> },
  };

  const isValidDeal = useMemo(() => dealAddress && isAddress(dealAddress), [dealAddress]);

  // Read agreement details
  const { data: details, isLoading: isLoadingDetails, isError: isErrorDetails, refetch: refetchDetails } = useReadContract({
    address: dealAddress as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: "getDetails",
    query: {
      enabled: !!isValidDeal,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      refetchInterval: (query: any) => {
        const s = query.state.data as unknown[] | undefined;
        const status = s ? (s[11] as number) : undefined;
        return status !== undefined && [3, 5, 6].includes(status) ? false : 15_000;
      },
    },
  }) as { data: [string, string, string, bigint, string, bigint, bigint, bigint, bigint, bigint, bigint, number] | undefined; isLoading: boolean; isError: boolean; refetch: () => void };

  // Read timeLeft — no refetchInterval/watch of its own (unlike `details`), so
  // it only ever updates via an explicit refetch() call (wired into the manual
  // Refresh button below) or a tab visibility-change triggering the app-wide
  // invalidateQueries(). Without that wiring, the Refresh button visibly
  // refreshed status/timestamps while silently leaving this (and the trigger-
  // timeout buttons gated on it) stale.
  const { data: timeLeft, refetch: refetchTimeLeft } = useReadContract({
    address: dealAddress as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: "timeLeft",
    query: { enabled: !!isValidDeal },
  }) as { data: bigint | undefined; refetch: () => void };

  // Read arbiterTimeLeft — same staleness gap as timeLeft above.
  const { data: arbiterTimeLeft, refetch: refetchArbiterTimeLeft } = useReadContract({
    address: dealAddress as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: "arbiterTimeLeft",
    query: { enabled: !!isValidDeal },
  }) as { data: bigint | undefined; refetch: () => void };

  // Read deal receipt NFT (TOKEN_ID=1 client, EXECUTOR_TOKEN_ID=2 executor —
  // mirrors the constants in Agreement.sol, minted at fund(), never burned).
  const myReceiptTokenId = useMemo(() => {
    if (!details || !address) return undefined;
    const obj = details as unknown as Record<string, unknown>;
    const arr = details as unknown as readonly unknown[];
    const client = (obj['client_'] ?? arr[0]) as string | undefined;
    const executor = (obj['executor_'] ?? arr[1]) as string | undefined;
    if (client?.toLowerCase() === address.toLowerCase()) return 1n;
    if (executor?.toLowerCase() === address.toLowerCase()) return 2n;
    return undefined;
  }, [details, address]);

  const { data: receiptTokenUri } = useReadContract({
    address: dealAddress as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: "tokenURI",
    args: myReceiptTokenId !== undefined ? [myReceiptTokenId] : undefined,
    query: { enabled: !!isValidDeal && myReceiptTokenId !== undefined },
  }) as { data: string | undefined };

  const receiptImage = useMemo(() => {
    if (!receiptTokenUri) return null;
    try {
      const json = receiptTokenUri.slice(receiptTokenUri.indexOf(',') + 1);
      const meta = JSON.parse(json) as { image?: string };
      return meta.image ?? null;
    } catch {
      return null;
    }
  }, [receiptTokenUri]);

  // Read extras count
  const { data: nextExtraId, refetch: refetchNextExtraId } = useReadContract({
    address: dealAddress as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: "nextExtraId",
    query: { enabled: !!isValidDeal },
  }) as { data: bigint | undefined; refetch: () => void };

  // Fetch all extras when count changes
  useEffect(() => {
    if (!publicClient || !isValidDeal || !nextExtraId || nextExtraId === 0n) {
      setExtrasList([]);
      return;
    }
    const count = Number(nextExtraId);
    setExtrasLoading(true);
    Promise.all(
      Array.from({ length: count }, (_, i) =>
        publicClient.readContract({
          address: dealAddress as `0x${string}`,
          abi: AGREEMENT_ABI,
          functionName: 'getExtra',
          args: [BigInt(i)],
        }).then(e => {
          const ex = e as { amount: bigint; terms: string; status: number };
          return { id: i, amount: ex.amount, terms: ex.terms, status: Number(ex.status) };
        }).catch(() => null)
      )
    ).then(results => {
      setExtrasList(results.filter(Boolean) as typeof extrasList);
    }).finally(() => setExtrasLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextExtraId, extrasVersion, publicClient, dealAddress, isValidDeal]);

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
      terms:        get('terms_',         4) as string,
      deadlineDays: get('deadlineDays_', 5) as bigint,
      fundedAt:     get('fundedAt_',     6) as bigint,
      activatedAt:  get('activatedAt_',  7) as bigint,
      markedDoneAt: get('markedDoneAt_', 8) as bigint,
      disputedAt:   get('disputedAt_',   9) as bigint,
      resolvedAt:   get('resolvedAt_',  10) as bigint,
      status:       get('status_',      11) as number,
    };
  }, [details]);

  // USDC balance for the connected wallet — used to gate Fund button
  const { data: usdcBalance } = useReadContract({
    address: CONTRACTS.usdc as `0x${string}`,
    abi: USDC_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  }) as { data: bigint | undefined };

  const hasEnoughUsdc = !parsed || usdcBalance === undefined
    ? true // unknown — don't block, let the tx fail with a proper message
    : usdcBalance >= parsed.amount;

  const usdcShortfall = parsed && usdcBalance !== undefined && !hasEnoughUsdc
    ? parsed.amount - usdcBalance
    : undefined;

  const isClient = parsed?.client
    ? parsed.client.toLowerCase() === address?.toLowerCase()
    : false;

  const isExecutor = parsed?.executor
    ? parsed.executor.toLowerCase() === address?.toLowerCase()
    : false;

  // claimDispute() sets Agreement.arbiter to the DIAMOND's own address, never
  // the claiming arbiter's EOA (Diamond-as-arbiter by design — resolution goes
  // through ArbiterRegistryFacet on the Diamond, not a direct Agreement call
  // from the arbiter's own wallet). Comparing parsed.arbiter to the connected
  // wallet here can therefore never match a real arbiter once a dispute is
  // claimed — isArbiter was permanently false past that point (dead-code
  // resolveDispute buttons gated on it) and the "chat with arbiter" link below
  // pointed at the Diamond contract instead of the real person. The real
  // claiming arbiter is only recoverable via getDisputeClaimer() — the same
  // getter arbiter/page.tsx already uses for its own dashboard.
  const isDisputedStatus = parsed?.status === 4;
  const { data: realArbiter } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: ARBITER_REGISTRY_ABI,
    functionName: 'getDisputeClaimer',
    args: [dealAddress as `0x${string}`],
    query: { enabled: !!isValidDeal && isDisputedStatus },
  }) as { data: `0x${string}` | undefined };

  // Платный вызов арбитра — сколько надо доплатить, чтобы дело стало стоящим
  // внимания, и сколько уже внесено. Обе цифры ТОЛЬКО с контракта:
  // quoteDisputeTopUp уже учитывает порог, потолок сбора disputeFee() и всё
  // остальное — вторая копия этой арифметики во фронте разошлась бы с
  // контрактом молча, это уже дважды ловили на этой ветке.
  const { data: disputeTopUp, refetch: refetchDisputeTopUp } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: ARBITER_REGISTRY_ABI,
    functionName: 'quoteDisputeTopUp',
    args: [dealAddress as `0x${string}`],
    query: { enabled: !!isValidDeal && isDisputedStatus },
  }) as { data: bigint | undefined; refetch: () => void };

  const { data: disputeBountyAmount, refetch: refetchDisputeBounty } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: ARBITER_REGISTRY_ABI,
    functionName: 'getDisputeBounty',
    args: [dealAddress as `0x${string}`],
    query: { enabled: !!isValidDeal && isDisputedStatus },
  }) as { data: bigint | undefined; refetch: () => void };

  // Явка в споре. Читается только в состоянии спора: вне него флаги ничего не
  // значат, а лишнее чтение на каждой сделке ни к чему.
  const { data: clientResponded, refetch: refetchClientResponded } = useReadContract({
    address: dealAddress as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: 'clientResponded',
    query: { enabled: isDisputedStatus },
  });
  const { data: executorResponded, refetch: refetchExecutorResponded } = useReadContract({
    address: dealAddress as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: 'executorResponded',
    query: { enabled: isDisputedStatus },
  });
  // Срок отклика. DISPUTE_WINDOW уже менялась однажды с 7 дней на 4 — фронт
  // читает её с контракта тем же способом, что и три других места в файле.
  const { data: disputeWindowSec } = useReadContract({
    address: dealAddress as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: 'DISPUTE_WINDOW',
    query: { enabled: isDisputedStatus },
  }) as { data: bigint | undefined };

  const isArbiter = !!realArbiter &&
    realArbiter !== "0x0000000000000000000000000000000000000000"
    ? realArbiter.toLowerCase() === address?.toLowerCase()
    : false;

  const isParty = isClient || isExecutor;

  // Спор ещё не заклеймлен — то же значение realArbiter, что и isArbiter выше,
  // просто без сравнения с конкретным кошельком.
  const disputeClaimed = !!realArbiter && realArbiter !== "0x0000000000000000000000000000000000000000";

  // Доплата уже внесена кем-то из сторон. quoteDisputeTopUp — чистая функция
  // disputeFee() и порога, она НЕ вычитает уже внесённую доплату, поэтому
  // после успешного fundDispute() она продолжает возвращать то же
  // положительное число. Без этой отдельной проверки кнопка осталась бы
  // видна и после оплаты, а повторный клик гарантированно отревертил бы
  // BountyAlreadyFunded — ровно то, чего условия показа обязаны избегать.
  const disputeAlreadyFunded = !!disputeBountyAmount && disputeBountyAmount > 0n;

  // Единственный дедлайн спора: disputedAt + DISPUTE_WINDOW. Один и тот же миг
  // закрывает и окно явки сторон, и приём доплаты за арбитра, и возможность
  // клейма — поэтому он считается здесь один раз, а не дважды под двумя
  // именами. DISPUTE_WINDOW читается с контракта (уже менялась с 7 дней на 4),
  // в constants.ts её намеренно нет.
  const disputeDeadline = parsed && parsed.disputedAt > 0n && disputeWindowSec
    ? new Date(Number(parsed.disputedAt + disputeWindowSec) * 1000)
    : undefined;

  // Окно спора ещё открыто. Контракт: fundDispute ревертит DisputeWindowPassed
  // при block.timestamp > disputedAt + DISPUTE_WINDOW, и статус при этом
  // остаётся DISPUTED, пока таймаут никто не дёрнул, — то есть по статусу это
  // состояние неотличимо от живого спора.
  //
  // Требуем согласия ДВУХ источников про (почти) один и тот же миг:
  //   • arbiterTimeLeft() — счёт самого контракта, без перекоса часов, но это
  //     снимок: страница, открытая до истечения окна, так и держала бы
  //     положительное значение сколько угодно долго после;
  //   • disputedAt + DISPUTE_WINDOW против локальных часов — свежо на каждом
  //     рендере, но зависит от часов пользователя.
  // Каждый закрывает слепое пятно другого, а требование согласия делает
  // ошибку в любую сторону скрывающей кнопку, а не показывающей лишнюю.
  //
  // «Почти» — про ровную границу, и это осознанное расхождение, а не описка.
  // arbiterTimeLeft() отдаёт 0 уже при block.timestamp >= deadline
  // (Agreement.sol:1076), а fundDispute отвергает только при строгом >
  // (ArbiterRegistryFacet.sol:1059). То есть ровно на секунде deadline контракт
  // деньги ещё примет, а кнопки здесь уже не будет.
  // Выравнивать не стали намеренно: расхождение fail-closed (прячем то, что
  // контракт бы принял, — не наоборот), длится одну секунду из четырёх суток,
  // и оплата на ней бесполезна по существу. Купить на неё нечего: claimDispute
  // и submitVerdict бьются о тот же строгий > (:432, :498), так что арбитру
  // пришлось бы и заклеймить спор, и вынести вердикт в этом же блоке. Цена
  // выравнивания — либо повторить `>=`/`>` контракта в двух местах фронта и
  // держать их синхронными при каждой правке окна, либо ослабить предикат до
  // «показывать, пока контракт принимает», что убрало бы fail-closed.
  const disputeWindowOpen = arbiterTimeLeft === undefined
    ? undefined
    : arbiterTimeLeft > 0n && (!disputeDeadline || disputeDeadline.getTime() > Date.now());

  // Шесть условий показа кнопки доплаты — одной чистой функцией из
  // lib/disputeBounty.ts, покрытой тестами (по одному случаю на каждое
  // условие + fail-closed на непрочитанные данные). Разметка сама больше не
  // решает, показывать кнопку или нет.
  const showFundDisputeButton = canFundDispute({
    isDisputedStatus,
    isParty,
    disputeClaimed,
    disputeBounty: disputeBountyAmount,
    disputeTopUp,
    disputeWindowOpen,
  });

  // Что таймаут арбитра на самом деле сделает с деньгами — дележ (за спор никто
  // не взялся) или возврат клиенту (взялись и не довели). Решает поле `arbiter`,
  // а не только статус со сроком, как было раньше: подпись кнопки, тост и
  // баннер ниже берут текст отсюда, чтобы все три не расходились между собой.
  const arbiterTimeout = useArbiterTimeoutOutcome(
    dealAddress as string | undefined,
    parsed?.arbiter,
    parsed?.status === 4 && arbiterTimeLeft === BigInt(0),
  );

  // Моя сторона ещё не откликнулась, и окно не закрыто — значит кнопка нужна.
  // Дедлайн — тот же disputeDeadline, что гейтит доплату за арбитра выше.
  const myResponsePending = !!parsed && parsed.status === 4 && (
    (isClient   && clientResponded   === false) ||
    (isExecutor && executorResponded === false)
  );
  const responseWindowOpen = !!disputeDeadline && disputeDeadline.getTime() > Date.now();

  // Terminal states — deal is fully closed, no further actions possible
  const isTerminal = parsed ? [3, 5, 6].includes(parsed.status) : false;

  // Arbiter registry — used to show trust signal before dispute
  const { data: arbiterList } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: ARBITER_REGISTRY_ABI,
    functionName: 'getArbiters',
    query: { enabled: !!isValidDeal && !isTerminal && parsed?.status !== undefined && parsed.status < 4 },
  }) as { data: `0x${string}`[] | undefined };

  // The person this user should chat with
  const chatPeer = useMemo(() => {
    if (!parsed || !address) return null;
    if (isClient)   return parsed.executor;
    if (isExecutor) return parsed.client;
    return null;
  }, [parsed, address, isClient, isExecutor]);

  const now = Date.now() / 1000;
  const activationWindowPassed = !!parsed && parsed.fundedAt > 0n
    && now > Number(parsed.fundedAt) + Number(ACTIVATION_WINDOW);
  const autoApproveWindowPassed = !!parsed && parsed.markedDoneAt > 0n
    && now >= Number(parsed.markedDoneAt) + Number(AUTO_APPROVE_WINDOW);
  const autoApproveSecondsLeft = parsed && parsed.markedDoneAt > 0n && !autoApproveWindowPassed
    ? BigInt(Math.max(0, Math.round(Number(parsed.markedDoneAt) + Number(AUTO_APPROVE_WINDOW) - now)))
    : undefined;

  // `busyKey` отделён от `fn` только там, где одна и та же функция контракта
  // стоит за двумя разными кнопками (resolveDispute: «вернуть клиенту» и
  // «заплатить исполнителю») — иначе крутилка снова зажглась бы на обеих.
  const handleAction = async (
    fn: string, successMsg: string, args: unknown[] = [], busyKey: string = fn,
  ): Promise<boolean> => {
    if (!isValidDeal || !walletClient || !publicClient) return false;
    setBusyAction(busyKey);
    try {
      toast(t("common.confirm_in_wallet"));
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
            // Use cached client only — never trigger a new wallet signature here.
            // initXmtpClient() used to be called instead, which can itself demand a
            // fresh signature (up to a 90s wait) — since this whole notify step runs
            // before the outer finally clears `busy`, every action button on the page
            // stayed disabled for that entire window right after a dispute had
            // already succeeded on-chain. DealActionBar's equivalent path already
            // uses getXmtpClientIfCached for this exact reason; this wasn't updated
            // to match.
            const xmtp = getXmtpClientIfCached(address!);
            if (xmtp) await notifyArbiters(xmtp, dealAddress as string, arbiters);
          }
        } catch {
          // Non-critical — arbiter notification is best-effort
        }
      }

      // Keep `busy` set until this delayed refetch actually lands, instead of
      // clearing it immediately in a blanket finally — the relay call already
      // waits for on-chain confirmation, but the refetch is deliberately
      // delayed to dodge read-after-write lag on the load-balanced RPC, so
      // parsed.status stays stale for that whole window. Clearing busy right
      // away re-enabled every action button gated on that stale status,
      // letting a same/related action re-fire against state that had already
      // moved on (wasting a signature on a guaranteed on-chain revert). The
      // respondToDispute flags ride the same delayed call for the same
      // reason — an immediate refetch here would race the same lag, come
      // back stale `false`, and leave the button clickable past its own
      // success.
      setTimeout(() => {
        refetchDetails();
        if (fn === 'respondToDispute') { refetchClientResponded(); refetchExecutorResponded(); }
        setBusyAction(null);
      }, 2000);
      return true;
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || t("common.transaction_failed"));
      setBusyAction(null);
      return false;
    }
  };

  const handleFund = async () => {
    if (!isValidDeal || !address || !publicClient || !walletClient || !parsed) return;
    if (usdcShortfall !== undefined) {
      toast.error(t("deal.insufficient_usdc_need", { amount: formatUnits(usdcShortfall, 6) }));
      return;
    }
    setBusyAction('fund');
    setPendingTxHash(null);
    try {
      const dealAddr = dealAddress as `0x${string}`;
      toast(t("deal.fund_sign_permit"));
      const { txHash } = await fundAgreementGasless(walletClient, publicClient, dealAddr, parsed.amount);
      setPendingTxHash(txHash);
      toast.success(t("deal.fund_success"));
      // See handleAction's comment above — keep busy set until the delayed
      // refetch lands, not cleared immediately.
      setTimeout(() => { refetchDetails(); setPendingTxHash(null); setBusyAction(null); }, 4000);
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      const msg = e?.shortMessage || e?.message || "Fund failed";
      if (msg.includes('AlreadyFunded')) {
        toast.error(t("deal.already_funded"));
        setTimeout(() => { refetchDetails(); setBusyAction(null); }, 1000);
      } else {
        toast.error(msg);
        setBusyAction(null);
      }
    }
  };

  const handleFundDispute = async () => {
    if (!isValidDeal || !address || !publicClient || !walletClient) return;
    if (disputeTopUp === undefined || disputeTopUp === 0n) return;
    setBusyAction('fundDispute');
    try {
      const dealAddr = dealAddress as `0x${string}`;
      toast(t("deal.fund_sign_permit"));
      await fundDisputeGasless(walletClient, publicClient, dealAddr, disputeTopUp);
      toast.success(t("deal.fund_dispute_success"));
      // See handleAction's comment above — keep busy set until the delayed
      // refetch lands, not cleared immediately.
      setTimeout(() => {
        refetchDisputeTopUp();
        refetchDisputeBounty();
        setBusyAction(null);
      }, 2000);
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      toast.error(e?.shortMessage || e?.message || t("common.transaction_failed"));
      setBusyAction(null);
    }
  };

  const handleRaiseDispute = async () => {
    if (!isValidDeal || !address || !walletClient || !publicClient) return;
    setDisputeModal(false);
    // Set busy BEFORE the dispute-reason signature below, not just inside
    // handleAction() afterward — otherwise the modal is already closed and the
    // trigger button (gated only on `busy`) stays enabled for the whole
    // signMessage wait, letting a second click reopen the modal and fire a
    // second, concurrent raiseDispute attempt (duplicate signatures, a
    // guaranteed on-chain revert for the loser, and a duplicate
    // /api/dispute-reason POST). handleAction's own finally still clears this.
    setBusyAction('raiseDispute');
    if (disputeReason.trim()) {
      try {
        const ts = Math.floor(Date.now() / 1000);
        const reasonHash = keccak256(new TextEncoder().encode(disputeReason.trim()));
        const msg = `hexseal:dispute-reason:${dealAddress!.toLowerCase()}:${ts}:${reasonHash}`;
        // Под общим мьютексом кошелька (lib/walletLock.ts): следом за этой
        // подписью идёт raiseDispute со своей — два запроса подряд в мобильном
        // кошельке дают незакрываемый -32002 'already pending'.
        const sig = await withWalletLock(address, () =>
          walletClient.signMessage({ account: address as `0x${string}`, message: msg }));
        fetch('/api/dispute-reason', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agreement: dealAddress,
            raiser: address,
            reason: disputeReason.trim(),
            ts,
            sig,
          }),
        }).catch(() => {});
      } catch {
        // non-critical
      }
    }
    const ok = await handleAction('raiseDispute', 'Dispute raised!');
    if (ok) setDisputeReason('');
  };

  const handleProposeExtra = async () => {
    if (!isValidDeal || !walletClient || !publicClient || !proposeAmount) return;
    const amountParsed = parseUnits(proposeAmount, 6);
    if (amountParsed === 0n) { toast.error('Amount must be > 0'); return; }
    const extraTerms = proposeDesc.trim() || proposeAmount + ' USDC extra';
    setProposeModal(false);
    setBusyAction('proposeExtra');
    try {
      toast(t("common.confirm_in_wallet"));
      await proposeExtraGasless(walletClient, publicClient, dealAddress as `0x${string}`, amountParsed, extraTerms);
      toast.success('Extra proposed');
      setProposeAmount('');
      setProposeDesc('');
      // See handleAction's comment above — keep busy set until the delayed
      // refetch lands, not cleared immediately.
      setTimeout(() => { refetchNextExtraId(); setBusyAction(null); }, 3000);
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || t("common.transaction_failed"));
      setBusyAction(null);
    }
  };

  const handleExtraAction = async (fn: 'acceptExtra' | 'rejectExtra', extraId: number) => {
    if (!isValidDeal || !walletClient || !publicClient) return;
    // Ключ включает id доплаты: строк с «Принять/Отклонить» на экране столько
    // же, сколько доплат, и общий флаг зажигал бы крутилку на всех разом.
    setBusyAction(`${fn}:${extraId}`);
    try {
      toast(t("common.confirm_in_wallet"));
      await sendAgreementGasless(walletClient, publicClient, dealAddress as `0x${string}`, fn, AGREEMENT_ABI as Abi, [BigInt(extraId)]);
      toast.success(fn === 'acceptExtra' ? 'Extra accepted' : 'Extra rejected');
      setTimeout(() => { refetchNextExtraId(); setExtrasVersion(v => v + 1); setBusyAction(null); }, 3000);
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || t("common.transaction_failed"));
      setBusyAction(null);
    }
  };

  if (!isValidDeal) {
    return (
      <PageCenter>
        <div className="flex flex-col items-center gap-4">
          <p className="text-white/50 text-sm">{t("deal.invalid_address")}</p>
          <Link href="/dashboard"><Button variant="outline" size="sm">← Dashboard</Button></Link>
        </div>
      </PageCenter>
    );
  }

  if (isLoadingDetails) {
    return (
      <PageCenter>
        <Loader2 className="w-8 h-8 animate-spin text-white/30" />
      </PageCenter>
    );
  }

  if (!parsed) {
    return (
      <PageCenter>
        <div className="flex flex-col items-center gap-4">
          <p className="text-white/40 text-sm">
            {isErrorDetails ? t("common.error") : t("deal.invalid_address")}
          </p>
          {isErrorDetails ? (
            <Button variant="outline" size="sm" onClick={() => refetchDetails()}>{t("common.retry")}</Button>
          ) : (
            <Link href="/dashboard"><Button variant="outline" size="sm">← Dashboard</Button></Link>
          )}
        </div>
      </PageCenter>
    );
  }

  const statusInfo = AGREEMENT_STATUS[parsed.status] || AGREEMENT_STATUS[0];
  const amountFormatted = formatUnits(parsed.amount, 6);
  // Блокировка — общая (одна сделка, один кошелёк), крутилка — адресная.
  const busy = busyAction !== null;
  const spinning = (key: string) => busyAction === key;
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

  // Условия показа каждой кнопки — по одному разу, здесь, а не только в
  // разметке. Карточка «Действия» раньше рисовалась по одному лишь признаку
  // «я сторона и сделка не закрыта» и в половине состояний (спор с живым
  // сроком, на который уже откликнулись, — снято владельцем) оставалась
  // пустой рамкой с заголовком и ничем внутри.
  const canFund            = parsed.status === 0 && isClient;
  const canActivate        = parsed.status === 1 && isExecutor;
  const canMarkDone        = parsed.status === 2 && isExecutor && parsed.markedDoneAt === BigInt(0);
  const canRelease         = parsed.status === 2 && isClient && parsed.markedDoneAt > BigInt(0) && !autoApproveWindowPassed;
  const canRaiseDispute    = parsed.status === 2 && (isClient || isExecutor);
  const canResolveDispute  = parsed.status === 4 && isArbiter;
  const canTimeoutActivate = parsed.status === 1 && isParty && activationWindowPassed;
  const canTimeoutDeadline = parsed.status === 2 && isParty && parsed.markedDoneAt === BigInt(0) && timeLeft === BigInt(0);
  const canTimeoutArbiter  = parsed.status === 4 && isParty && arbiterTimeLeft === BigInt(0);
  const canRespond         = myResponsePending && responseWindowOpen;
  const canTimeoutApprove  = parsed.status === 2 && isParty && autoApproveWindowPassed;
  const hasAnyAction =
    canFund || canActivate || canMarkDone || canRelease || canRaiseDispute ||
    canResolveDispute || canTimeoutActivate || canTimeoutDeadline ||
    canTimeoutArbiter || canRespond || canTimeoutApprove;

  return (
    <>
      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div>
        <div className="container mx-auto px-4 py-4 max-w-4xl flex items-center justify-between gap-4">
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
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              onClick={() => {
                refetchDetails();
                refetchTimeLeft();
                refetchArbiterTimeLeft();
                refetchNextExtraId();
                setExtrasVersion(v => v + 1);
              }}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors"
              title={t("common.refresh")}
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <Link href="/dashboard">
              <Button variant="ghost" size="sm" className="text-white/40 hover:text-white/70 text-xs">
                ← Dashboard
              </Button>
            </Link>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-5 max-w-4xl space-y-4 page-enter">

        {/* ── Hero: amount + parties ──────────────────────────────────────────── */}
        <div
          className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-5 py-4"
          style={{ boxShadow: "0 4px 24px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.05)" }}
        >
          <div className="flex items-start justify-between gap-4 flex-wrap">
            {/* Amount */}
            <div>
              <p className="text-xs text-white/35 mb-0.5">{t("deal.amount_label")}</p>
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
                    <span>{formatTimeLeft(timeLeft, t("deal_status.expired"))} left</span>
                  </>
                )}
              </div>
            </div>

            {/* Parties */}
            <div className="flex flex-col gap-2 text-right">
              <PartyRow role={t("common.role_client")}   addr={parsed.client}   isMe={isClient}            showChat={!!address} />
              <PartyRow role={t("common.role_executor")} addr={parsed.executor} isMe={isExecutor}           showChat={!!address} />
              {parsed.arbiter !== ZERO_ADDR && realArbiter && (
                // realArbiter (getDisputeClaimer), not parsed.arbiter — claimDispute()
                // sets Agreement.arbiter to the Diamond's own address, never the
                // claiming arbiter's EOA, so parsed.arbiter would show/link to the
                // contract itself here instead of the real person.
                <PartyRow
                  role={t("common.role_arbiter")}
                  addr={realArbiter}
                  isMe={isArbiter as boolean}
                  showChat={!!address}
                  fixedLabel={`#${realArbiter.slice(-6).toUpperCase()}`}
                />
              )}
            </div>
          </div>
        </div>

        {/* ── Deal receipt NFT — permanent certificate, minted at fund() ──────── */}
        {receiptImage && (
          <div
            className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-5 py-4 flex items-center gap-4"
            style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={receiptImage} alt="" className="w-20 rounded-lg flex-shrink-0 border border-white/[0.06]" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white/80">{t("deal.receipt_title")}</p>
              <p className="text-xs text-white/35 leading-relaxed">{t("deal.receipt_hint")}</p>
            </div>
          </div>
        )}

        {/* ── Arbiter trust signal — visible before dispute ───────────────────── */}
        {parsed.status < 4 && parsed.arbiter === ZERO_ADDR && arbiterList !== undefined && (
          <div className="flex items-center gap-2 px-1">
            <Shield className="w-3.5 h-3.5 text-white/20 shrink-0" />
            <p className="text-xs text-white/25">
              {arbiterList.length > 0
                ? t("deal.arbiter_trust", { count: arbiterList.length })
                : t("deal.arbiter_trust_generic")}
            </p>
          </div>
        )}

        {/* ── FUNDED state guidance banners ──────────────────────────────────── */}
        {parsed.status === 1 && isExecutor && (
          <div className="rounded-[22px] border border-amber-400/30 bg-amber-400/5 px-5 py-4"
            style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03)" }}>
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-amber-400/15 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Shield className="w-4 h-4 text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-amber-300/90 mb-0.5">{t("deal.funded_executor_title")}</p>
                {/* Actual Activate button lives in Primary actions below, under the
                    identical parsed.status===1 && isExecutor condition — this was a
                    second, independent copy of the same button wired to the same
                    handleAction call, rendered simultaneously. */}
                <p className="text-xs text-white/40 leading-relaxed">{t("deal.funded_executor_hint")}</p>
              </div>
            </div>
          </div>
        )}

        {parsed.status === 1 && isClient && (
          <div className="rounded-[22px] border border-sky-400/20 bg-sky-400/5 px-5 py-4"
            style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03)" }}>
            <div className="flex items-start gap-3">
              <Clock className="w-4 h-4 text-sky-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-sky-300/80 mb-0.5">{t("deal.funded_client_title")}</p>
                <p className="text-xs text-white/35 leading-relaxed">{t("deal.funded_client_hint")}</p>
              </div>
            </div>
          </div>
        )}

        {/* ── ACTIVE guidance for executor: mark done ─────────────────────────── */}
        {parsed.status === 2 && isExecutor && parsed.markedDoneAt === BigInt(0) && (
          <div className="rounded-[22px] border border-violet-400/20 bg-violet-400/5 px-5 py-3 flex items-start gap-3"
            style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03)" }}>
            <Timer className="w-4 h-4 text-violet-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-violet-300/80 mb-0.5">{t("deal.active_executor_title")}</p>
              <p className="text-xs text-white/35">{t("deal.active_executor_hint")}</p>
            </div>
          </div>
        )}

        {/* ── ACTIVE guidance for client: waiting for delivery ────────────────── */}
        {parsed.status === 2 && isClient && parsed.markedDoneAt === BigInt(0) && (
          <div className="rounded-[22px] border border-white/[0.07] bg-white/[0.02] px-5 py-3 flex items-start gap-3"
            style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03)" }}>
            <Clock className="w-4 h-4 text-white/30 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-white/55 mb-0.5">{t("deal.active_client_title")}</p>
              <p className="text-xs text-white/25">{t("deal.active_client_hint")}</p>
            </div>
          </div>
        )}

        {/* ── Terminal state banner ───────────────────────────────────────────── */}
        {isTerminal && (
          <div className={`rounded-[22px] border px-5 py-4 flex items-center gap-3 ${
            parsed!.status === 3 ? 'border-green-500/20 bg-green-500/5' :
            parsed!.status === 5 ? 'border-purple-500/20 bg-purple-500/5' :
                                   'border-white/[0.07] bg-white/[0.02]'
          }`}>
            {parsed!.status === 6
              ? <ArrowRight className="w-4 h-4 flex-shrink-0 text-white/30" />
              : <CheckCircle className={`w-4 h-4 flex-shrink-0 ${parsed!.status === 3 ? 'text-green-400' : 'text-purple-400'}`} />
            }
            <div>
              <p className="text-sm font-medium text-white/70">
                {parsed!.status === 3 ? t("deal_status.completed") :
                 parsed!.status === 5 ? t("deal_status.resolved") :
                                        t("deal_status.refunded")}
              </p>
              <p className="text-xs text-white/30">{t("deal.closed_hint")}</p>
            </div>
          </div>
        )}

        {/* ── Stale deal banners — explain auto-resolution to non-crypto users ── */}
        {parsed.status === 1 && activationWindowPassed && (
          <div className="rounded-[16px] border border-orange-400/20 bg-orange-400/5 px-4 py-3">
            <p className="text-xs font-semibold text-orange-300/90 mb-1">{t("deal.stale_activation_title")}</p>
            <p className="text-xs text-white/35 leading-relaxed">{t("deal.stale_activation_body")}</p>
          </div>
        )}
        {parsed.status === 2 && parsed.markedDoneAt === 0n && timeLeft === 0n && (
          <div className="rounded-[16px] border border-orange-400/20 bg-orange-400/5 px-4 py-3">
            <p className="text-xs font-semibold text-orange-300/90 mb-1">{t("deal.stale_deadline_title")}</p>
            <p className="text-xs text-white/35 leading-relaxed">{t("deal.stale_deadline_body")}</p>
          </div>
        )}
        {parsed.status === 2 && autoApproveWindowPassed && parsed.markedDoneAt > 0n && (
          <div className="rounded-[16px] border border-emerald-400/20 bg-emerald-400/5 px-4 py-3">
            <p className="text-xs font-semibold text-emerald-300/90 mb-1">{t("deal.stale_autorelease_title")}</p>
            <p className="text-xs text-white/35 leading-relaxed">{t("deal.stale_autorelease_body")}</p>
          </div>
        )}
        {parsed.status === 4 && arbiterTimeLeft === 0n && (
          <div className="rounded-[16px] border border-purple-400/20 bg-purple-400/5 px-4 py-3">
            <p className="text-xs font-semibold text-purple-300/90 mb-1">{t("deal.stale_arbiter_title")}</p>
            {/* «Автоматический возврат клиенту» — правда только когда за спор
                брались. Если не брался никто, контракт делит котёл, и обе
                половины показываются числами: на нечётном котле они разные. */}
            <p className="text-xs text-white/35 leading-relaxed">{arbiterTimeout.bannerBody}</p>
          </div>
        )}
        {myResponsePending && responseWindowOpen && disputeDeadline && (
          <div className="rounded-[16px] border border-amber-400/20 bg-amber-400/5 px-4 py-3">
            <p className="text-xs text-white/35 leading-relaxed">
              {t("deal.dispute_respond_prompt", { date: disputeDeadline.toLocaleString() })}
            </p>
          </div>
        )}
        {/* «Вы откликнулись» — и что из этого следует. Два условия здесь
            обязательны, и оба были пропущены.

            Оба флага должны быть ПРОЧИТАНЫ. `!myResponsePending` истинно и
            когда флаг равен undefined — старый клон (там clientResponded()
            ревертит вовсе) или обычный лаг RPC. Тогда строка печаталась про
            дележ на сделке, где таймаут отдаст весь котёл клиенту, а баннер
            рядом это же и скажет: два взаимоисключающих утверждения на одном
            экране. Вся конструкция `decideArbiterTimeout` существует ровно
            чтобы не называть исход без признака новой реализации.

            И флаг КОНТРАГЕНТА решает, что сказать. Пополам — только когда
            откликнулись оба. Поднявший спор, пока вторая сторона молчит, —
            основной случай правила явки, и ему причитаются три четверти, а не
            половина; обещать половину значило бы спорить с
            `stale_arbiter_unanswered_body` на том же экране. */}
        {parsed?.status === 4 && !myResponsePending && (isClient || isExecutor)
          && clientResponded !== undefined && executorResponded !== undefined && (
          <p className="text-xs text-white/25 leading-relaxed">
            {clientResponded && executorResponded
              ? t("deal.dispute_respond_done")
              : t("deal.dispute_respond_done_waiting")}
          </p>
        )}

        {/* ── Pending tx banner ───────────────────────────────────────────────── */}
        {pendingTxHash && (
          <div className="rounded-[16px] border border-violet-500/20 bg-violet-500/5 px-4 py-3 flex items-center gap-3">
            <Loader2 className="w-4 h-4 animate-spin text-violet-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-violet-300">{t("deal.tx_pending_title")}</p>
              <p className="font-mono text-[10px] text-white/30 truncate">{pendingTxHash}</p>
            </div>
            <a
              href={explorerUrl('tx', pendingTxHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 text-white/30 hover:text-white/70 transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        )}

        {/* ── Primary actions ─────────────────────────────────────────────────── */}
        {!isTerminal && isConnected && (isParty || isArbiter) && hasAnyAction && (
          <div
            className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-5 py-4"
            style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}
          >
            <p className="text-xs text-white/35 mb-3">{t("deal.actions_title")}</p>

            {/* Contextual one-time hints per role + status */}
            {parsed.status === 0 && isClient && (
              <div className="mb-3">
                <ContextHint hintKey="deal_fund_client">{t("hints.deal_fund_client")}</ContextHint>
              </div>
            )}
            {parsed.status === 1 && isExecutor && (
              <div className="mb-3">
                <ContextHint hintKey="deal_activate_executor">{t("hints.deal_activate_executor")}</ContextHint>
              </div>
            )}
            {parsed.status === 2 && isExecutor && parsed.markedDoneAt === 0n && (
              <div className="mb-3">
                <ContextHint hintKey="deal_markdone_executor">{t("hints.deal_markdone_executor")}</ContextHint>
              </div>
            )}
            {parsed.status === 2 && isClient && parsed.markedDoneAt > 0n && (
              <div className="mb-3">
                <ContextHint hintKey="deal_release_client">{t("hints.deal_release_client")}</ContextHint>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {canFund && (
                <div className="flex flex-col gap-1.5 w-full">
                  <Button size="sm" onClick={handleFund} disabled={busy || !!usdcShortfall}>
                    {spinning('fund') ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <DollarSign className="w-3.5 h-3.5 mr-1.5" />}
                    {t("deal.fund_btn")}
                  </Button>
                  {usdcShortfall !== undefined && (
                    <p className="text-xs text-red-400/80">
                      {t("deal.insufficient_usdc_need", { amount: formatUnits(usdcShortfall, 6) })}
                    </p>
                  )}
                </div>
              )}
              {canActivate && (
                <Button size="sm" onClick={() => handleAction('activate', t("deal.activate_success"))} disabled={busy}>
                  {spinning('activate') ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Shield className="w-3.5 h-3.5 mr-1.5" />}
                  {t("deal.activate_btn")}
                </Button>
              )}
              {canMarkDone && (
                <Button size="sm" onClick={() => handleAction('markDone', t("deal.mark_done_success"))} disabled={busy}>
                  {spinning('markDone') ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <CheckCircle className="w-3.5 h-3.5 mr-1.5" />}
                  {t("deal.mark_done_btn")}
                </Button>
              )}
              {canRelease && (
                <div className="flex flex-col gap-1.5">
                  {autoApproveSecondsLeft !== undefined && (
                    <p className="text-xs text-white/35">
                      {t("deal.auto_approve_in", { time: formatTimeLeft(autoApproveSecondsLeft) })}
                    </p>
                  )}
                  <Button size="sm" onClick={() => handleAction('release', t("deal.release_success"))} disabled={busy}>
                    {spinning('release') ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <CheckCircle className="w-3.5 h-3.5 mr-1.5" />}
                    {t("deal.release_funds_btn")}
                  </Button>
                </div>
              )}
              {canRaiseDispute && (
                <Button size="sm" variant="destructive" onClick={() => setDisputeModal(true)} disabled={busy}>
                  {spinning('raiseDispute')
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                    : <AlertTriangle className="w-3.5 h-3.5 mr-1.5" />}
                  {t("deal.dispute_btn")}
                </Button>
              )}
              {canResolveDispute && (
                <>
                  <Button size="sm" variant="destructive" disabled={busy}
                    onClick={() => handleAction('resolveDispute', t("deal.refund_success"), [true], 'resolveDispute:client')}>
                    {spinning('resolveDispute:client') && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
                    {t("deal.refund_client_btn")}
                  </Button>
                  <Button size="sm" disabled={busy}
                    onClick={() => handleAction('resolveDispute', t("deal.pay_executor_success"), [false], 'resolveDispute:executor')}>
                    {spinning('resolveDispute:executor') && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
                    {t("deal.pay_executor_btn")}
                  </Button>
                </>
              )}
              {/* Timeout actions — only shown when window has actually expired */}
              {canTimeoutActivate && (
                <Button size="sm" variant="ghost" className="text-orange-400/60 hover:text-orange-400"
                  onClick={() => handleAction('triggerActivationTimeout', t("deal.timeout_activation_success"))}
                  disabled={busy}>
                  {spinning('triggerActivationTimeout') && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
                  {t("deal.timeout_activation")}
                </Button>
              )}
              {canTimeoutDeadline && (
                <Button size="sm" variant="ghost" className="text-orange-400/60 hover:text-orange-400"
                  onClick={() => handleAction('triggerDeadlineTimeout', t("deal.timeout_deadline_success"))}
                  disabled={busy}>
                  {spinning('triggerDeadlineTimeout') && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
                  {t("deal.timeout_deadline")}
                </Button>
              )}
              {canTimeoutArbiter && (
                <Button size="sm" variant="ghost" className="text-orange-400/60 hover:text-orange-400"
                  onClick={() => handleAction('triggerArbiterTimeout', arbiterTimeout.successToast)}
                  disabled={busy}>
                  {spinning('triggerArbiterTimeout') && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
                  {arbiterTimeout.buttonLabel}
                </Button>
              )}
              {canRespond && (
                <Button size="sm" variant="secondary"
                  onClick={() => handleAction('respondToDispute', t("deal.dispute_respond_success"))}
                  disabled={busy}>
                  {spinning('respondToDispute') && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
                  {t("deal.dispute_respond_btn")}
                </Button>
              )}
              {canTimeoutApprove && (
                <Button size="sm" variant="ghost" className="text-white/40"
                  onClick={() => handleAction('triggerAutoApprove', t("deal.timeout_auto_approve_success"))}
                  disabled={busy}>
                  {spinning('triggerAutoApprove') && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
                  {t("deal.timeout_auto_approve")}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* ── Extras (revisions / add-ons) ────────────────────────────────────── */}
        {isConnected && isParty && (extrasList.length > 0 || (isClient && parsed.status === 2 && parsed.markedDoneAt === 0n)) && (
          <div
            className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-5 py-4"
            style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}
          >
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-white/35">Extras</p>
              {isClient && parsed.status === 2 && parsed.markedDoneAt === 0n && (
                <Button size="sm" variant="ghost" className="text-xs text-white/40 hover:text-white/70 h-6 px-2"
                  onClick={() => setProposeModal(true)} disabled={busy}>
                  <Plus className="w-3 h-3 mr-1" /> Propose
                </Button>
              )}
            </div>

            {/* Propose modal (inline) */}
            {proposeModal && (
              <div className="mb-3 rounded-xl border border-white/[0.1] bg-white/[0.03] p-3 space-y-2">
                <p className="text-xs text-white/50">New extra payment</p>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Amount (USDC)"
                  value={proposeAmount}
                  onChange={e => setProposeAmount(e.target.value)}
                  className="w-full bg-transparent border border-white/[0.12] rounded-lg px-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-white/30"
                />
                <input
                  type="text"
                  placeholder="Description (e.g. Fix button styles, add dark mode)"
                  value={proposeDesc}
                  onChange={e => setProposeDesc(e.target.value)}
                  className="w-full bg-transparent border border-white/[0.12] rounded-lg px-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-white/30"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleProposeExtra} disabled={!proposeAmount || busy}>
                    {spinning('proposeExtra') ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
                    Confirm & Lock USDC
                  </Button>
                  <Button size="sm" variant="ghost" className="text-white/40" onClick={() => { setProposeModal(false); setProposeAmount(''); setProposeDesc(''); }}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {extrasLoading && <p className="text-xs text-white/25 text-center py-2">Loading…</p>}

            {!extrasLoading && extrasList.length === 0 && (
              <p className="text-xs text-white/20 text-center py-1">No extras yet</p>
            )}

            {!extrasLoading && extrasList.length > 0 && (
              <div className="space-y-2">
                {extrasList.map(ex => {
                  const statusLabel = ex.status === 0 ? 'Pending' : ex.status === 1 ? 'Accepted' : 'Rejected';
                  const statusColor = ex.status === 0 ? 'text-amber-400' : ex.status === 1 ? 'text-green-400' : 'text-white/30';
                  return (
                    <div key={ex.id} className="flex items-center gap-3 rounded-lg bg-white/[0.03] border border-white/[0.06] px-3 py-2.5">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-mono text-white/80">{formatUnits(ex.amount, 6)} USDC</p>
                        <p className="text-[11px] text-white/25 truncate">{ex.terms.slice(0, 20) || '—'}{ex.terms.length > 20 ? '…' : ''}</p>
                      </div>
                      <span className={`text-xs font-medium ${statusColor} flex-shrink-0`}>{statusLabel}</span>
                      {ex.status === 0 && isExecutor && (
                        <div className="flex gap-1.5 flex-shrink-0">
                          <Button size="sm" className="h-6 px-2 text-xs" onClick={() => handleExtraAction('acceptExtra', ex.id)} disabled={busy}>
                            {spinning(`acceptExtra:${ex.id}`) && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                            Accept
                          </Button>
                          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-white/40" onClick={() => handleExtraAction('rejectExtra', ex.id)} disabled={busy}>
                            {spinning(`rejectExtra:${ex.id}`) && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                            Reject
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Chat with counterparty ──────────────────────────────────────────── */}
        {isConnected && isParty && chatPeer && (
          <Link href={`/chat?peer=${chatPeer.toLowerCase()}`} className="block">
            <div
              className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-5 py-4 flex items-center gap-3 hover:bg-[#111113] hover:border-white/[0.13] transition-colors group cursor-pointer"
              style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}
            >
              <div className="w-9 h-9 rounded-lg bg-violet-500/15 flex items-center justify-center flex-shrink-0">
                <MessageCircle className="w-4 h-4 text-violet-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white/80 group-hover:text-white transition-colors">{t("deal.chat_title")}</p>
                <p className="text-xs text-white/35">
                  {isClient ? t("common.role_executor") : t("common.role_client")}
                  {" · "}{chatPeer.slice(0, 6)}…{chatPeer.slice(-4)}
                </p>
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
              <span className="text-sm font-semibold text-red-400">{t("deal.dispute_active")}</span>
              {arbiterTimeLeft && (
                <span className="ml-auto text-xs text-red-400/70">{formatTimeLeft(arbiterTimeLeft, t("deal_status.expired"))} left</span>
              )}
            </div>
            <p className="text-xs text-white/40 mb-3">{t("deal.dispute_active_hint")}</p>

            {/* ── Fund dispute (pay an arbiter to take a small case) ──────────
                Показывается только когда все пять условий разом (см.
                showFundDisputeButton / lib/disputeBounty.ts::canFundDispute
                выше). Рядом с ценой обязано быть названо, что деньги
                вернутся, если арбитр так и не возьмётся: без этого
                предложение читается как ставка, а не как оплата услуги. */}
            {showFundDisputeButton && disputeTopUp !== undefined && (
              <div className="mb-3 rounded-lg border border-violet-400/20 bg-violet-400/[0.06] px-3 py-2.5">
                <p className="text-xs text-white/50 leading-relaxed mb-2">
                  {t("deal.fund_dispute_hint", { amount: usdcExact(disputeTopUp) })}
                </p>
                <Button size="sm" onClick={handleFundDispute} disabled={busy}
                  className="bg-violet-500/90 hover:bg-violet-500 text-white">
                  {spinning('fundDispute')
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                    : <DollarSign className="w-3.5 h-3.5 mr-1.5" />}
                  {t("deal.fund_dispute_btn", { amount: usdcExact(disputeTopUp) })}
                </Button>
              </div>
            )}
            {/* «Арбитр оплачен, и если никто не возьмётся — деньги вернутся»
                перестаёт быть правдой ровно в тот миг, когда арбитр взялся:
                после клейма фраза читается как ошибка интерфейса, а обещание
                возврата в ней — как обещание, которого больше нет. */}
            {disputeAlreadyFunded && !disputeClaimed && (
              <p className="text-xs text-white/35 mb-3">{t("deal.fund_dispute_funded")}</p>
            )}

            {/* Осталась одна кнопка чата, и она ведёт к арбитру — то есть к
                собеседнику, которого больше нигде на странице нет. Вторая,
                «Чат сделки», убрана: чат по самой сделке уже стоит отдельной
                карточкой выше («Открыть чат», тот же контрагент), а вела она
                не в чат сделки, а в личку владельцу диамонда — адресату,
                которого в протоколе без администраторов не существует.
                Подпись — своя (`deal.chat_arbiter_btn`): раньше здесь стоял
                ключ со страницы арбитра, и стороне спора писало «Чат с
                клиентом», даже когда она сама и была клиентом. */}
            {parsed.arbiter !== ZERO_ADDR && realArbiter && (
              // realArbiter, not parsed.arbiter — see the PartyRow comment above.
              // Without this the link went straight to the Diamond contract's own
              // address, never reaching the person actually deciding the case.
              <div className="flex gap-2">
                <Link href={`/chat?peer=${realArbiter}`}>
                  <Button size="sm" variant="outline" className="border-red-500/30 text-red-400 hover:bg-red-500/10 text-xs">
                    <MessageCircle className="w-3.5 h-3.5 mr-1.5" /> {t("deal.chat_arbiter_btn")}
                  </Button>
                </Link>
              </div>
            )}
          </div>
        )}

        {/* ── Возврат доплаты за арбитра ───────────────────────────────────────
            СНАРУЖИ баннера спора намеренно. Возврат появляется ровно тогда,
            когда спор кончился — на таймауте (мягкий толчок не дошёл) и при
            отменённом вердикте (там он claimable ВСЕГДА). К этому мигу сделка
            уже вышла из статуса DISPUTED, и всё нарисованное внутри баннера
            `status === 4` с экрана исчезло: кнопка, живущая там, была бы видна
            только когда забирать нечего. Сам блок сам себя прячет при нулевом
            остатке — условие здесь только про то, чьи это вообще деньги. */}
        {isConnected && isParty && <RefundableBounty />}

        {/* ── Work delivered banner ───────────────────────────────────────────── */}
        {parsed.markedDoneAt > BigInt(0) && parsed.status === 2 && (
          <div className="rounded-xl border border-green-500/20 bg-green-500/5 px-5 py-3 flex items-center gap-3">
            <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-green-400">{t("deal.work_delivered")}</p>
              <p className="text-xs text-white/35">{t("deal.delivered_label")} {formatTimestamp(parsed.markedDoneAt)}</p>
            </div>
          </div>
        )}

        {/* ── Timeline ────────────────────────────────────────────────────────── */}
        <div
          className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-5 py-4"
          style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}
        >
          <p className="text-xs text-white/35 mb-3">{t("deal.timeline_title")}</p>
          <div className="relative pl-4">
            {[
              { label: t("deal_status.created"),   ts: null,                  done: true },
              { label: t("deal_status.funded"),    ts: parsed.fundedAt,       done: parsed.fundedAt > 0n },
              { label: t("deal_status.active"),    ts: parsed.activatedAt,    done: parsed.activatedAt > 0n },
              { label: t("deal.delivered_label"),  ts: parsed.markedDoneAt,   done: parsed.markedDoneAt > 0n },
              { label: t("deal_status.disputed"),  ts: parsed.disputedAt,     done: parsed.disputedAt > 0n },
              { label: t("deal_status.resolved"),  ts: parsed.resolvedAt,     done: parsed.resolvedAt > 0n },
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
                {/* `step.ts && …` вместо явного сравнения печатало голый ноль:
                    при `0n` выражение схлопывается в сам `0n`, а React с 18-й
                    версии рисует BigInt текстом — на экране выходило «Сдано 0»
                    и «Решена 0» вместо «событие не наступило». Ноль отдаётся
                    formatTimestamp, который для него и написан («—»); у шага
                    «Создана» метки нет вовсе (ts === null), там по-прежнему
                    пусто. */}
                <div className="flex items-baseline gap-2 flex-1">
                  <span className={`text-xs ${step.done ? 'text-white/70' : 'text-white/25'}`}>{step.label}</span>
                  {step.ts !== null && (
                    <span className="text-[11px] text-white/25 ml-auto">{formatTimestamp(step.ts)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>

      {/* ── Raise Dispute Modal ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {disputeModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-4"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.15 }}
              className="bg-[#111113] border border-white/[0.08] rounded-[22px] p-5 w-full max-w-md"
              style={{ boxShadow: '0 8px 40px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.04)' }}
            >
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="w-4 h-4 text-red-400" />
                <h2 className="text-sm font-semibold text-white">{t("deal.dispute_btn")}</h2>
              </div>
              <p className="text-xs text-white/40 mb-3">{t("deal.dispute_reason_hint")}</p>
              {/* Сколько возьмёт разбирательство и что будет, если за спор никто
                  не возьмётся — до нажатия кнопки, а не после. */}
              <div className="mb-3">
                <DisputeCostNotice agreementAddr={dealAddress as string} />
              </div>
              <textarea
                autoFocus
                value={disputeReason}
                onChange={e => setDisputeReason(e.target.value)}
                placeholder={t("deal.dispute_reason_placeholder")}
                rows={4}
                maxLength={2000}
                className="w-full bg-white/[0.05] border border-white/[0.08] rounded-[14px] px-3 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-red-500/40 resize-none"
              />
              <div className="flex justify-between items-center mt-1 mb-4">
                <span className="text-[11px] text-white/25">{disputeReason.length}/2000</span>
              </div>
              <div className="flex gap-3 justify-end">
                <Button size="sm" variant="ghost" onClick={() => { setDisputeModal(false); setDisputeReason(''); }}>
                  {t("common.cancel")}
                </Button>
                <Button size="sm" variant="destructive" onClick={handleRaiseDispute} disabled={busy || !disputeReason.trim()}>
                  {spinning('raiseDispute') ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <AlertTriangle className="w-3.5 h-3.5 mr-1.5" />}
                  {t("deal.confirm_dispute_btn")}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
