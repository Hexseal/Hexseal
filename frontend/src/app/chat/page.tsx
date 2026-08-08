'use client';

import { useState, useMemo, Suspense, useRef, useEffect, useCallback, memo } from 'react';
import { useAccount, useReadContract, useReadContracts } from 'wagmi';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { Abi } from 'viem';
import { isAddress } from 'viem';
import { usePairConversations, type PreviewState } from '@/hooks/usePairConversations';
import { useChatSession } from '@/hooks/useChatSession';
import { useKeyAnnouncement } from '@/hooks/useKeyAnnouncement';
import { ChatOffScreen } from '@/components/ChatOffScreen';
import { useProfile } from '@/hooks/useProfile';
import { ChatPanel, ChatSignatureWanted, ChatKeyNotAnnounced } from '@/components/ChatPanel';
import { Button } from '@/components/ui/button';
import { DIAMOND_ABI, CONTRACTS, AGREEMENT_ABI } from '@/config/contracts';
import { MessageCircle, Loader2, RefreshCw, Plus, Lock, Briefcase, User, X, ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { cn, shortAddr } from '@/lib/utils';
import { listPhase, listNotice } from '@/lib/chatListPhase';
import { useTranslations } from 'next-intl';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface AgreementRecord {
  agreement: string;
  client: string;
  executor: string;
  amount: bigint;
  status: number;
  createdAt: bigint;
  resolvedAt: bigint;
}

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

interface DealContext {
  agreementAddr: string;
  role: 'client' | 'executor';
  status: number;
  amount: bigint;
  jobTitle?: string;
  jobId?: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────


function formatTime(ts: number) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000)     return 'now';
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ─── Conversation item ─────────────────────────────────────────────────────────

// 0=Created 1=Funded 2=Active 3=Completed 4=Disputed 5=Resolved 6=Refunded
const DEAL_STATUS_CLS: Record<number, string> = {
  0: 'text-white/40',
  1: 'text-sky-400/70',
  2: 'text-green-400/70',
  3: 'text-white/30',
  4: 'text-red-400/70',
  5: 'text-white/30',
  6: 'text-white/30',
};

/**
 * Слова для каждой причины пустого превью — таблицей, а не цепочкой `?:`.
 *
 * ⚠️ ПОЛНОТА ПРОВЕРЯЕТСЯ ТИПОМ (`Record<PreviewState, …>`): добавится новая
 * причина — не соберётся, пока ей не подберут слова. Цепочка условий про такое
 * молчит, и новая причина показалась бы человеку как «Сообщений пока нет», то
 * есть ровно тем враньём, из-за которого таблица и появилась.
 */
const PREVIEW_KEY: Record<PreviewState, 'chat.no_messages_yet' | 'chat.preview_pending' | 'chat.preview_unreadable'> = {
  text:       'chat.no_messages_yet',
  none:       'chat.no_messages_yet',
  pending:    'chat.preview_pending',
  unreadable: 'chat.preview_unreadable',
};

const ConvoItem = memo(function ConvoItem({
  peerAddress, lastText, lastAt, lastFromMe, preview, isSelected, isSeen, onSelect, dealCtx, myAddress,
}: {
  peerAddress: string;
  lastText: string;
  lastAt: number;
  lastFromMe: boolean;
  preview?: PreviewState;
  isSelected: boolean;
  isSeen: boolean;
  onSelect: (addr: string) => void;
  dealCtx?: DealContext;
  myAddress: string;
}) {
  const onClick = useCallback(() => onSelect(peerAddress), [onSelect, peerAddress]);
  const { displayName, avatarUrl } = useProfile(peerAddress);
  const t = useTranslations();

  const seenAt = useMemo(() =>
    typeof window !== 'undefined'
      ? Number(localStorage.getItem(`hexseal_chat_seen_${myAddress.toLowerCase()}:${peerAddress.toLowerCase()}`) ?? 0)
      : 0,
    [myAddress, peerAddress],
  );
  const hasUnread = !lastFromMe && !isSeen && lastAt > seenAt && lastAt > 0;

  const dsLabel = dealCtx ? t(`deal_status.${(['created','funded','active','completed','disputed','resolved','refunded'] as const)[dealCtx.status] ?? 'active'}` as Parameters<typeof t>[0]) : null;
  const dsCls   = dealCtx ? (DEAL_STATUS_CLS[dealCtx.status] ?? 'text-white/30') : null;

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3.5 px-3 py-2.5 text-left transition-all rounded-[16px] border',
        isSelected
          ? 'bg-white/[0.07] border-white/[0.08]'
          : 'bg-white/[0.03] border-white/[0.04] hover:bg-white/[0.05] hover:border-white/[0.07]',
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={avatarUrl ?? `https://effigy.im/a/${peerAddress}.svg`}
        alt=""
        className="w-12 h-12 rounded-full flex-shrink-0 bg-white/10 object-cover"
        onError={(e) => {
          const img = e.target as HTMLImageElement;
          if (avatarUrl && img.src !== `https://effigy.im/a/${peerAddress}.svg`) {
            img.src = `https://effigy.im/a/${peerAddress}.svg`;
          }
        }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <span className={`text-sm truncate block ${hasUnread ? 'font-semibold text-white' : 'font-medium text-white/85'}`}>
              {displayName ?? shortAddr(peerAddress)}
            </span>
            {displayName && (
              <span className="text-[10px] text-white/25 font-mono truncate block mt-0.5">
                {shortAddr(peerAddress)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {lastAt > 0 && (
              <span className={`text-[11px] ${hasUnread ? 'text-primary/70' : 'text-white/25'}`}>{formatTime(lastAt)}</span>
            )}
            {hasUnread && (
              <span className="w-2.5 h-2.5 rounded-full bg-primary flex-shrink-0" />
            )}
          </div>
        </div>

        {dealCtx && (
          <div className="mt-1">
            {dealCtx.jobTitle && (
              <p className="text-[11px] text-white/55 truncate leading-tight mb-0.5 font-medium">
                {dealCtx.jobTitle}
              </p>
            )}
            <div className="flex items-center gap-1.5">
              {/* Show the COUNTERPARTY's role (dealCtx.role is MY role): the badge sits
                  by their name, so it should read as their side. I'm client → they exec. */}
              {dealCtx.role === 'executor'
                ? <Briefcase className="w-2.5 h-2.5 text-sky-400/60 flex-shrink-0" />
                : <User      className="w-2.5 h-2.5 text-emerald-400/60 flex-shrink-0" />
              }
              <span className={`text-[11px] font-medium ${dealCtx.role === 'executor' ? 'text-sky-400/70' : 'text-emerald-400/70'}`}>
                {dealCtx.role === 'executor' ? t("common.role_client") : t("common.role_executor")}
              </span>
              <span className="text-white/20 text-[11px]">·</span>
              <span className="text-[11px] font-mono text-white/30">
                #{dealCtx.agreementAddr.slice(2, 10).toUpperCase()}
              </span>
              {dsLabel && (
                <>
                  <span className="text-white/20 text-[11px]">·</span>
                  <span className={`text-[11px] ${dsCls}`}>{dsLabel}</span>
                </>
              )}
            </div>
          </div>
        )}

        {/* Always reserve this line — an empty conversation with no dealCtx would
            otherwise render one line shorter than every other row in the list. */}
        {lastText ? (
          /* ⚠️ СВОЁ СООБЩЕНИЕ ПОКАЗЫВАЕТСЯ ТЕКСТОМ, с пометкой «Вы», как в любом
             мессенджере. Здесь стояла подпись «вы написали последним» вместо
             самого текста — владелец назвал это прямо: подписывать случай не
             значит его решить. Текст у нас есть (второй слот конверта), список
             просто не шёл за своей половиной. */
          <p className={`text-xs truncate mt-1 ${hasUnread ? 'text-white/70 font-medium' : 'text-white/30'}`}>
            {lastFromMe ? `${t('chat.preview_you')}: ${lastText}` : lastText}
          </p>
        ) : (
          /* ⚠️ ПУСТОТА ОБЪЯСНЕНА, А НЕ ОСТАВЛЕНА ПУСТОЙ. Здесь на все причины
             стояло «Сообщений пока нет» — утверждение, ложное в трёх случаях из
             четырёх: мы написали последними; мешок не скачан; мешок не вскрылся.
             Владелец увидел это как «где-то написано последнее сообщение, а где-то
             нет». Разбор причин — `PreviewState` в `usePairConversations.ts`. */
          <p className="text-xs truncate mt-1 text-white/15 italic">{t(PREVIEW_KEY[preview ?? 'none'])}</p>
        )}
      </div>
    </button>
  );
});

// ─── Empty chat state ─────────────────────────────────────────────────────────

function EmptyState() {
  const t = useTranslations();
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-4">
      <div className="w-16 h-16 rounded-[18px] bg-white/[0.03] border border-white/[0.08] flex items-center justify-center">
        <MessageCircle className="w-7 h-7 text-white/20" />
      </div>
      <div>
        <p className="text-white/50 text-sm font-medium">{t("chat.select_conversation")}</p>
        <p className="text-white/20 text-xs mt-1 max-w-xs leading-relaxed">
          {t("chat.empty_state_hint")}
        </p>
      </div>
    </div>
  );
}

// ─── Inner page (needs Suspense for useSearchParams) ─────────────────────────

function ChatHubPageInner() {
  const { address, isConnected } = useAccount();
  const searchParams = useSearchParams();
  const initialPeer  = searchParams.get('peer')?.toLowerCase() ?? null;

  const {
    status: sessionStatus, retry: retrySession, errorCode: sessionErrorCode,
    keySignaturePending = false,
  } = useChatSession();
  const {
    conversations, isLoading, error, reload, passSignaturePending = false,
  } = usePairConversations(sessionStatus === 'ready');
  // Окно кошелька открыто ПРЯМО СЕЙЧАС — по одной из двух причин, и слова у
  // них разные (см. `ChatSignatureWanted`). Ключ старше пропуска: если ждут
  // обе подписи, человек ждёт первую.
  const signatureReason: 'pass' | 'key' | null =
    keySignaturePending ? 'key' : passSignaturePending ? 'pass' : null;
  // ⚠️ ТА ЖЕ НОВОСТЬ, ЧТО В ПАНЕЛИ, И ТЕМИ ЖЕ СЛОВАМИ. Список — то место, куда
  // попадают чаще всего, и молчать здесь значило бы оставить тихую поломку ровно
  // там, где её встретят первой. Урок оплачен 8 августа: разводка причин отказа
  // доехала до панели и НЕ доехала до списка (находка К-2), и заметили это
  // только рендером.
  const {
    needsPress: keyNotAnnounced, busy: announcing, announce: announceKey,
    standing: keyStandingRaw, restoreFromCode,
  } = useKeyAnnouncement();
  // Экраны у `absent` и `other_key` разные: при чужом ключе нажатие заменяет ключ
  // и ломает переписку на том устройстве (разбор — `ChatKeyNotAnnounced`).
  const keyStanding = keyStandingRaw === 'other_key' ? 'other_key' as const : 'absent' as const;

  // selected is URL-driven: ?peer=addr — router.back() returns to /chat (list view)
  const selected = searchParams.get('peer')?.toLowerCase() ?? null;
  const [showNewChat, setShowNewChat] = useState(false);
  const [newChatAddr, setNewChatAddr] = useState('');
  const [newChatChecking, setNewChatChecking] = useState(false);
  const [newChatError, setNewChatError]       = useState<string | null>(null);
  const newChatInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (showNewChat) newChatInputRef.current?.focus();
  }, [showNewChat]);
  const [seenConvos, setSeenConvos]   = useState<Set<string>>(() =>
    initialPeer ? new Set([initialPeer.toLowerCase()]) : new Set()
  );
  const router = useRouter();

  const [isLeaving, setIsLeaving] = useState(false);
  // Reset leave state when a new conversation is opened
  useEffect(() => { setIsLeaving(false); }, [selected]);

  const handleBack = useCallback(() => {
    setIsLeaving(true);
    setTimeout(() => router.replace('/chat'), 160);
  }, [router]);

  // Pull-to-refresh
  const listRef      = useRef<HTMLDivElement>(null);
  const pullStartY   = useRef(0);
  const [pullDist, setPullDist]       = useState(0);
  const [isPullRefresh, setIsPullRefresh] = useState(false);
  const PULL_THRESHOLD = 52;

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if ((listRef.current?.scrollTop ?? 0) > 2) return;
    pullStartY.current = e.touches[0].clientY;
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!pullStartY.current) return;
    if ((listRef.current?.scrollTop ?? 0) > 2) { pullStartY.current = 0; return; }
    const delta = e.touches[0].clientY - pullStartY.current;
    if (delta > 0) setPullDist(Math.min(delta * 0.42, 68));
    else setPullDist(0);
  }, []);

  const onTouchEnd = useCallback(async () => {
    if (pullDist >= PULL_THRESHOLD) {
      setIsPullRefresh(true);
      setPullDist(0);
      try { await reload(); } finally { setIsPullRefresh(false); }
    } else {
      setPullDist(0);
    }
    pullStartY.current = 0;
  }, [pullDist, reload]);

  // Обновление ПО НАЖАТИЮ — своё состояние, отдельно от фонового захода. Иначе
  // значок крутится сам по себе каждые тридцать секунд (см. кнопку ниже).
  const [manualRefresh, setManualRefresh] = useState(false);
  const handleManualRefresh = useCallback(async () => {
    setManualRefresh(true);
    try { await reload(); } finally { setManualRefresh(false); }
  }, [reload]);

  const handleConvoClick = useCallback((addr: string) => {
    const lc = addr.toLowerCase();
    setSeenConvos(prev => new Set([...prev, lc]));
    localStorage.setItem(`hexseal_chat_seen_${(address ?? '').toLowerCase()}:${lc}`, String(Date.now()));
    router.push(`/chat?peer=${lc}`);
  }, [router, address]);

  // Load agreements to build peer→deal context map
  const { data: clientDeals } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getByClient',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  }) as { data: AgreementRecord[] | undefined };

  const { data: executorDeals } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getByExecutor',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  }) as { data: AgreementRecord[] | undefined };

  const { data: clientJobIds } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getClientJobs',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  }) as { data: bigint[] | undefined };

  const jobContracts = useMemo(() =>
    (clientJobIds ?? []).map(id => ({
      address: CONTRACTS.diamond as `0x${string}`,
      abi: DIAMOND_ABI as Abi,
      functionName: 'getJob' as const,
      args: [id] as const,
    })),
    [clientJobIds]
  );

  const { data: jobResults } = useReadContracts({
    contracts: jobContracts,
    query: { enabled: jobContracts.length > 0 },
  });

  const agreementJobMap = useMemo(() => {
    const map = new Map<string, { title: string; jobId: string }>();
    if (!clientJobIds || !jobResults) return map;
    jobResults.forEach((result, i) => {
      if (result.status !== 'success') return;
      const job = result.result as JobRecord;
      if (job.status === 1 && job.agreement !== '0x0000000000000000000000000000000000000000') {
        map.set(job.agreement.toLowerCase(), {
          title: job.title,
          jobId: clientJobIds[i].toString(),
        });
      }
    });
    return map;
  }, [clientJobIds, jobResults]);

  // Registry (getByClient/getByExecutor) only enumerates WHICH agreements exist —
  // its own `status` field is a stale snapshot (frozen near ACTIVE) and must never
  // be used for display. Every candidate's real status comes from a single batched
  // live read below.
  const candidateAgreements = useMemo(() => {
    const map = new Map<string, { agreement: string; role: 'client' | 'executor'; peerAddress: string }>();
    for (const d of clientDeals ?? []) {
      map.set(d.agreement.toLowerCase(), { agreement: d.agreement, role: 'client', peerAddress: d.executor.toLowerCase() });
    }
    for (const d of executorDeals ?? []) {
      map.set(d.agreement.toLowerCase(), { agreement: d.agreement, role: 'executor', peerAddress: d.client.toLowerCase() });
    }
    return [...map.values()];
  }, [clientDeals, executorDeals]);

  const dealDetailContracts = useMemo(() =>
    candidateAgreements.map(c => ({
      address: c.agreement as `0x${string}`,
      abi: AGREEMENT_ABI as Abi,
      functionName: 'getDetails' as const,
    })),
    [candidateAgreements]
  );

  const { data: dealDetailResults } = useReadContracts({
    contracts: dealDetailContracts,
    query: { enabled: dealDetailContracts.length > 0 },
  });

  // peer address → every non-terminal deal with that counterparty, live status.
  // Array (not a single "preferred" deal) because the product allows genuinely
  // parallel deals between the same pair — ChatPanel shows a selector when 2+.
  const peerDealsMap = useMemo(() => {
    const map = new Map<string, DealContext[]>();
    if (!dealDetailResults) return map;
    // Agreement.Status: 0=Created 1=Funded 2=Active 3=Completed 4=Disputed 5=Resolved 6=Refunded
    const isOpen = (s: number) => s === 0 || s === 1 || s === 2 || s === 4;

    candidateAgreements.forEach((c, i) => {
      const result = dealDetailResults[i];
      if (!result || result.status !== 'success') return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = result.result as any;
      const status = Number(d.status_ ?? d[11] ?? -1);
      if (!isOpen(status)) return;

      const jobCtx = agreementJobMap.get(c.agreement.toLowerCase());
      const ctx: DealContext = {
        agreementAddr: c.agreement,
        role: c.role,
        status,
        amount: (d.amount_ ?? d[3] ?? 0n) as bigint,
        jobTitle: jobCtx?.title,
        jobId: jobCtx?.jobId,
      };

      const list = map.get(c.peerAddress) ?? [];
      list.push(ctx);
      map.set(c.peerAddress, list);
    });

    return map;
  }, [candidateAgreements, dealDetailResults, agreementJobMap]);

  const handleOpenNewChat = async () => {
    const addr = newChatAddr.trim().toLowerCase();
    if (!isAddress(addr) || newChatChecking) return;

    // Проверки достижимости здесь нет. Открыть переписку бесплатно: мешок
    // появляется только на первой отправке. Если собеседник ни разу не
    // заходил, это скажет сама панель («собеседник ещё не заходил» +
    // приглашение), а не запрет на вход сюда.
    setShowNewChat(false);
    setNewChatAddr('');
    setNewChatError(null);
    setSeenConvos(prev => new Set([...prev, addr]));
    localStorage.setItem(`hexseal_chat_seen_${(address ?? '').toLowerCase()}:${addr}`, String(Date.now()));
    router.push(`/chat?peer=${addr}`);
  };

  const t = useTranslations();

  // Merge on-chain deal counterparties into the conversation list.
  // Must be before any conditional return to satisfy Rules of Hooks.
  const allConversations = useMemo(() => {
    const knownPeers = new Set(conversations.map(c => c.peerAddress));
    const extras: typeof conversations = [];
    for (const [peer] of peerDealsMap) {
      if (!knownPeers.has(peer)) {
        // Мешков нет ни в одну сторону — это ЧЕСТНОЕ «сообщений пока нет»:
        // сделка есть, переписка не начата.
        extras.push({ group: null as any, peerAddress: peer, lastText: '', lastAt: 0, lastFromMe: true, preview: 'none' });
      }
    }
    if (extras.length === 0) return conversations;
    return [...conversations, ...extras].sort((a, b) => b.lastAt - a.lastAt);
  }, [conversations, peerDealsMap]);

  if (!isConnected) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-sm px-4">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-6">
            <MessageCircle className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-bold font-syne mb-2">{t("chat.title")}</h1>
          <p className="text-muted-foreground text-sm mb-6">{t("chat.wallet_required")}</p>
          <Link href="/"><Button variant="outline">{t("common.go_home")}</Button></Link>
        </div>
      </div>
    );
  }

  const selectedDealCtxs = selected ? (peerDealsMap.get(selected) ?? []) : [];
  // True while the deal-context read waterfall is still resolving, so ChatPanel can
  // hold back its pre-deal bar (which would otherwise briefly show the peer's board
  // offers before an existing deal's status loads — see ChatPanel dealsLoading).
  const dealsLoading = !!address && (
    clientDeals === undefined ||
    executorDeals === undefined ||
    (dealDetailContracts.length > 0 && dealDetailResults === undefined)
  );

  /**
   * ЧТО ПОКАЗЫВАЕТ КОЛОНКА — одним решением, вынесенным из разметки.
   *
   * ⚠️ ЗДЕСЬ ЖИЛО ШЕСТЬ НЕЗАВИСИМЫХ УСЛОВИЙ, и они пересекались. Замер до
   * правки: заготовки строк рисовались ПОВЕРХ настоящих строк 10 раз из 10
   * тиков, а один отказ склада убирал список целиком. Разбор — шапка
   * `lib/chatListPhase.ts`.
   *
   * ⚠️ `hasRows` СЧИТАЕТ И СТРОКУ ИЗ АДРЕСА, и строки из цепи: показать нечего —
   * это когда в колонке НЕ БУДЕТ НИ ОДНОЙ строки, а не когда пуст ответ склада.
   * Ровно на этой разнице и жило мигание.
   */
  const phaseInput = {
    hasRows: allConversations.length > 0
      || (!!selected && !allConversations.some(c => c.peerAddress === selected)),
    loading: isLoading,
    signatureReason,
    keyNotAnnounced,
    sessionStatus,
    error,
  };
  const phase  = listPhase(phaseInput);
  const notice = listNotice(phaseInput);

  return (
    <div className="flex-1 min-h-0 flex overflow-hidden justify-center">
      <div className="flex w-full max-w-6xl min-h-0 overflow-hidden border-x border-white/[0.04]">

      {/* ── Sidebar ── */}
      <aside
        className={cn(
          'flex-shrink-0 flex flex-col overflow-hidden bg-black',
          'sm:relative sm:flex sm:w-80 sm:border-r sm:border-white/[0.04]',
          !selected ? 'flex w-full' : 'hidden sm:flex',
        )}
      >

        {/* Header — only visible on desktop; on mobile the app header covers this */}
        <div className="hidden sm:flex items-center justify-between px-4 py-3 flex-shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-white/70">{t("chat.title")}</h2>
          </div>
          <div className="flex items-center gap-1">
            {/* ⚠️ КРУТИТСЯ ТОЛЬКО ПО НАЖАТИЮ. Раньше значок вращался и кнопка
                запиралась на КАЖДОМ фоновом заходе — то есть раз в тридцать
                секунд, плюс на каждое новое сообщение. Замер: десять тиков без
                изменений давали 2 разных разметки вместо 1, и обе разницы были
                здесь. Фоновая работа не обязана мелькать; человек попросил
                обновить — вот тогда обязана. */}
            <button onClick={handleManualRefresh} disabled={manualRefresh} title={t("common.refresh")}
              className="p-2 rounded-[12px] text-white/25 hover:text-white/55 hover:bg-white/[0.06] transition-colors disabled:opacity-30">
              <RefreshCw className={`w-3.5 h-3.5 ${manualRefresh ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={() => { setShowNewChat(v => !v); setNewChatAddr(''); setNewChatError(null); }}
              title={t("chat.new_conversation")}
              className={cn(
                'p-2 rounded-[12px] transition-colors',
                showNewChat ? 'bg-white/[0.08] text-white/70' : 'text-white/25 hover:text-white/55 hover:bg-white/[0.06]',
              )}>
              {showNewChat ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* Mobile: minimal action bar — refresh via pull-to-refresh, only + button here */}
        <div className="sm:hidden flex items-center justify-between px-3 pt-2 pb-1 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <Lock className="w-3 h-3 text-white/15" />
            <span className="text-[11px] text-white/20">{t("chat.encrypted")}</span>
          </div>
          <button
            onClick={() => { setShowNewChat(v => !v); setNewChatAddr(''); setNewChatError(null); }}
            className={cn(
              'p-3 rounded-[14px] transition-colors',
              showNewChat
                ? 'bg-white/[0.10] text-white/70'
                : 'text-white/35 hover:text-white/60 hover:bg-white/[0.08]',
            )}>
            {showNewChat ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          </button>
        </div>

        {/* New chat search */}
        <div className={showNewChat ? "px-3 py-2.5 mx-2 mb-2 rounded-[16px] bg-white/[0.03]" : "hidden"}>
            <p className="text-[11px] text-white/30 mb-1.5">{t("chat.paste_address_hint")}</p>
            <div className="flex gap-2">
              <input
                ref={newChatInputRef}
                type="text"
                value={newChatAddr}
                onChange={e => { setNewChatAddr(e.target.value); setNewChatError(null); }}
                onKeyDown={e => { if (e.key === 'Enter') handleOpenNewChat(); }}
                placeholder="0x…"
                tabIndex={showNewChat ? 0 : -1}
                className={`flex-1 min-w-0 bg-[#0d0d0f] border rounded-[12px] px-3 py-1.5 text-xs text-white placeholder:text-white/20 focus:outline-none focus:bg-[#111113] transition-all font-mono ${newChatError ? 'border-red-500/40 focus:border-red-500/60' : 'border-white/[0.08] focus:border-primary/40'}`}
              />
              <button
                onClick={handleOpenNewChat}
                disabled={!isAddress(newChatAddr.trim()) || newChatChecking}
                className="px-3 py-1.5 rounded-[12px] bg-primary text-white text-xs font-medium disabled:opacity-30 hover:bg-primary/80 transition-colors flex items-center gap-1 flex-shrink-0">
                {newChatChecking
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <ArrowRight className="w-3 h-3" />}
              </button>
            </div>
            {newChatError && (
              <p className="text-[11px] text-red-400/70 mt-1.5 leading-snug">{newChatError}</p>
            )}
          </div>

        {/* Conversation list */}
        <div
          ref={listRef}
          className="flex-1 overflow-y-auto px-2 py-2 space-y-2 sm:touch-auto pb-[calc(5.75rem+env(safe-area-inset-bottom,0px))] sm:pb-2"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >

          {/* Pull-to-refresh indicator (mobile only) */}
          {(pullDist > 0 || isPullRefresh) && (
            <div
              className="sm:hidden flex items-center justify-center flex-shrink-0 transition-[height] duration-150"
              style={{ height: isPullRefresh ? 40 : pullDist }}
            >
              <RefreshCw
                className={`w-4 h-4 text-white/25 ${
                  isPullRefresh || pullDist >= PULL_THRESHOLD ? 'animate-spin' : 'transition-transform'
                }`}
                style={isPullRefresh ? undefined : { transform: `rotate(${pullDist * 5}deg)` }}
              />
            </div>
          )}

          {/* ⚠️ ПОЛОСА НАД СПИСКОМ, А НЕ ВМЕСТО НЕГО. Пока эта новость умела
              приходить только целым экраном, она показывалась при пустом
              списке — то есть человеку, у которого есть хоть одна строка
              (собеседник по сделке из цепи), кнопки не доставалось ВОВСЕ, хотя
              состояние у него ровно то же: писать ему не может никто. Разбор —
              `listNotice` в `lib/chatListPhase.ts`. */}
          {notice === 'signature' && signatureReason && (
            <ChatSignatureWanted reason={signatureReason} variant="inline" />
          )}
          {notice === 'announce' && (
            <ChatKeyNotAnnounced
              variant="inline" busy={announcing} standing={keyStanding}
              onConfirm={announceKey} onRestore={restoreFromCode}
            />
          )}
          {/* Отказ ПРИ НЕПУСТОМ списке — одна строка рядом, и список остаётся на
              экране. Раньше строки рисовались под условием `!error`, то есть один
              `rate_limited` убирал ВСЕ переписки и возвращал их через полминуты:
              «ресет до скелетона и обратно» дословно. Тот же класс уже чинили в
              панели («один моргнувший отказ прятал всю переписку»), и до списка
              починка не доехала. */}
          {notice === 'stale' && (
            <button
              onClick={reload}
              className="w-full mx-1 mb-1 px-3 py-2 rounded-[12px] bg-white/[0.03] border border-white/[0.06] text-left"
            >
              <span className="text-[11px] text-white/40 leading-snug">{t("chat.list_stale")}</span>
            </button>
          )}

          {/* ⚠️ ЖДЁМ ПОДПИСЬ — ВМЕСТО ЗАГОТОВОК СТРОК, и это правка, а не оформление.
              Заготовки говорят «сейчас будет», и это правда, только если ждут
              сеть. Когда ждут ЧЕЛОВЕКА, они врут: он смотрит на пульсирующие
              полоски минутами (круг через приложение кошелька) и уходит. Живая
              выкатка 8 августа — дословно так и произошло. */}
          {phase === 'signature' && signatureReason && (
            <ChatSignatureWanted reason={signatureReason} variant="full" />
          )}

          {/* Та же новость и те же слова, что в панели, — см. комментарий у
              `useKeyAnnouncement()` выше. Заготовки строк при этом НЕ рисуются
              (исход один на всю колонку): они говорят «сейчас будет», а
              тут ждут не сеть, а человека. */}
          {phase === 'announce' && (
            <ChatKeyNotAnnounced
              variant="full" busy={announcing} standing={keyStanding}
              onConfirm={announceKey} onRestore={restoreFromCode}
            />
          )}

          {phase === 'skeleton' && (
            <div className="space-y-2">
              {[1, 2, 3].map(i => (
                <div key={i} className="flex items-center gap-3.5 px-3 py-2.5 rounded-[16px] border border-white/[0.04] bg-white/[0.02]">
                  <div className="w-12 h-12 rounded-full bg-white/[0.07] flex-shrink-0 animate-pulse" />
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="h-3 bg-white/[0.07] rounded animate-pulse" style={{ width: `${48 + i * 14}%` }} />
                    <div className="h-2.5 bg-white/[0.04] rounded animate-pulse" style={{ width: `${60 + i * 8}%` }} />
                  </div>
                  <div className="h-2.5 bg-white/[0.04] rounded animate-pulse w-7 mt-1 flex-shrink-0" />
                </div>
              ))}
            </div>
          )}

          {/* Код отказа склада (`write_failed`, `rate_limited`, …) человеку не
              показывается — это слово для журнала. Действие у всех этих
              причин одно: повторить. */}
          {phase === 'error' && (
            <div className="px-4 py-8 text-center space-y-3">
              <p className="text-xs text-red-400/60 leading-relaxed">{t("chat.could_not_connect")}</p>
              <div>
                <Button size="sm" variant="outline" onClick={reload} className="border-white/15 text-white/50 text-xs">{t("chat.retry")}</Button>
              </div>
            </div>
          )}

          {/* Чат выключен или сеанс не открылся.
              Раньше на этом состоянии не рисовалось НИЧЕГО: скелетон требовал
              'loading', пустое состояние — 'ready', а ветка ошибки — текста
              ошибки, которого у молчаливого отказа нет. Человек видел пустую
              колонку без единого объяснения и без единственного действия,
              которое здесь имеет смысл. */}
          {phase === 'off' && (
            /* ⚠️ ОДИН экран на список и на панель. Здесь стояла своя копия,
               рисовавшая «Мессенджер выключен» на ВСЕ семь причин — то есть
               обвиняющий человека экран, который К-2 убирала из панели, жил
               нетронутым там, куда попадают чаще всего. */
            <ChatOffScreen errorCode={sessionErrorCode} onRetry={retrySession} variant="compact" />
          )}

          {phase === 'empty' && (
            <div className="flex flex-col items-center justify-center py-16 text-center px-4">
              <MessageCircle className="w-8 h-8 text-white/[0.12] mb-3" />
              <p className="text-sm text-white/35 mb-1">{t("chat.no_conversations")}</p>
              <p className="text-xs text-white/20 leading-relaxed">
                {t("chat.start_hint")}
              </p>
            </div>
          )}

          {/* If peer from URL is not yet in conversation list, show it at top */}
          {selected && !allConversations.some(c => c.peerAddress === selected) && (
            <ConvoItem
              peerAddress={selected}
              lastText=""
              lastAt={0}
              lastFromMe={true}
              isSelected
              isSeen
              dealCtx={peerDealsMap.get(selected)?.[0]}
              onSelect={handleConvoClick}
              myAddress={address ?? ''}
            />
          )}

          {/* ⚠️ БЕЗ `!error`. Строки рисуются ВСЕГДА, когда они есть: моргнувший
              отказ склада не имеет права уносить с экрана то, что человек уже
              читает. Про отказ говорит полоса выше. */}
          {allConversations.map(({ peerAddress, lastText, lastAt, lastFromMe, preview }) => (
            <ConvoItem
              key={peerAddress}
              peerAddress={peerAddress}
              lastText={lastText}
              lastAt={lastAt}
              lastFromMe={lastFromMe}
              preview={preview}
              isSelected={selected === peerAddress}
              isSeen={seenConvos.has(peerAddress)}
              dealCtx={peerDealsMap.get(peerAddress)?.[0]}
              onSelect={handleConvoClick}
              myAddress={address ?? ''}
            />
          ))}

          {/* Spacer so last items aren't hidden under the bottom nav pill on mobile */}
          <div className="sm:hidden flex-shrink-0" style={{ height: 'calc(98px + env(safe-area-inset-bottom, 0px))' }} />

        </div>
      </aside>

      {/* ── Chat panel ── */}
      <main className={cn(
        'flex-1 min-w-0 min-h-0 flex-col overflow-hidden',
        !selected ? 'hidden sm:flex' : 'flex',
      )}>
        {selected
          ? <div
              key={selected}
              className={`${isLeaving ? 'chat-conv-leave' : 'chat-conv-enter'} flex flex-col flex-1 min-h-0 overflow-hidden`}
            >
              <ChatPanel
                recipientAddress={selected}
                dealContexts={selectedDealCtxs}
                dealsLoading={dealsLoading}
                onBack={handleBack}
              />
            </div>
          : <EmptyState />
        }
      </main>

      </div>
    </div>
  );
}

// ─── Page wrapper (Suspense for useSearchParams) ──────────────────────────────
// This boundary is required, not redundant: Next.js's static-generation check for
// useSearchParams() is per-page, so it doesn't credit the Suspense that
// ClientLayout puts around ChatLayoutInner (which needs one for its own
// useSearchParams() call) — removing this one breaks `next build` on /chat with
// "useSearchParams() should be wrapped in a suspense boundary". Both boundaries
// are independently mandatory; the double-fallback-flash on navigation this
// causes is a real but lower-priority cosmetic cost, not something to "fix" here.

export default function ChatHubPage() {
  return (
    <Suspense fallback={
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-white/30" />
      </div>
    }>
      <ChatHubPageInner />
    </Suspense>
  );
}
