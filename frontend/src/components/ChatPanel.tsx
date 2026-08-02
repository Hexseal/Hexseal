'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { formatUnits, type Abi } from 'viem';
import { DIAMOND_ABI } from '@/config/contracts';
import { sendGasless, requestServiceGasless } from '@/lib/relay';
import { refreshAfterTx } from '@/lib/subgraphSync';
import { DealActionBar } from '@/components/DealActionBar';
import { usePreDealBar } from '@/hooks/usePreDealBar';
import { toast } from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';

import { usePairChat } from '@/hooks/usePairChat';
import { useXmtp } from '@/contexts/XmtpContext';
import { useFeeConfig } from '@/hooks/useFeeConfig';
import { quoteFeeLocal } from '@/lib/fee';
import {
  PanelLeftOpen, Send, Loader2, MessageCircle, AlertCircle,
  Copy, Check, CheckCheck, Paperclip, FileText, ExternalLink, Lock,
  ChevronDown, Download, Search, X, Clock, Archive, RotateCw,
} from 'lucide-react';
import type { ChatMessage } from '@/lib/xmtp';
import { useXmtpFailureText } from '@/hooks/useXmtpFailureText';
import { classifyAttachmentFailure, type AttachmentFailure } from '@/lib/attachmentFailure';
import { decryptToObjectUrl, decryptAndSave, decryptAndSaveChunked, CHUNK_SIZE, isTrustedAttachmentUrl } from '@/lib/fileCrypto';
import { MAX_FILE_SIZE, refreshDownloadUrl } from '@/lib/fileStorage';
import { useProfile } from '@/hooks/useProfile';
import { shortAddr } from "@/lib/utils";


// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}


function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Same-sender bubble group breaks after this gap (like iMessage / Telegram)
const TIME_BREAK = 10 * 60 * 1000;

function isImageMime(mime?: string) {
  return mime?.startsWith('image/') ?? false;
}

// ─── Attachment components ────────────────────────────────────────────────────

function ImageBubble({ a, isMe, sentAt }: { a: NonNullable<ChatMessage['attachment']>; isMe: boolean; sentAt: number }) {
  const [src, setSrc]               = useState<string | null>(null);
  const [decrypting, setDecrypting] = useState(false);
  // Не булево «не вышло», а ЧТО именно не вышло: истёкший срок хранения и
  // сломанная расшифровка — разные события, и лечатся они по-разному (первое —
  // «попроси прислать заново», второе — настоящая поломка). Разбор —
  // `lib/attachmentFailure.ts`.
  const [failure, setFailure]       = useState<AttachmentFailure | null>(null);
  const [lightbox, setLightbox]     = useState(false);
  const t = useTranslations();

  useEffect(() => {
    if (!a.key || !a.iv) {
      // Unencrypted attachments have no decrypt step to gate the fetch — an
      // untrusted url must never even be handed to <img src>, since that loads
      // with zero user interaction the instant this renders.
      if (!isTrustedAttachmentUrl(a.url)) { setFailure('decrypt_failed'); return; }
      setSrc(a.url);
      return;
    }
    let active = true;
    setDecrypting(true);
    const tryDecrypt = (url: string) => decryptToObjectUrl(url, a.key!, a.iv!, a.mime);
    tryDecrypt(a.url)
      .then((url) => { if (active) setSrc(url); })
      .catch(async (err: unknown) => {
        if (a.fileKey) {
          try {
            const fresh = await refreshDownloadUrl(a.fileKey);
            const url = await tryDecrypt(fresh);
            if (active) setSrc(url);
            return;
          } catch (retryErr) {
            if (active) setFailure(classifyAttachmentFailure(retryErr, { sentAt }));
            return;
          }
        }
        if (active) setFailure(classifyAttachmentFailure(err, { sentAt }));
      })
      .finally(() => { if (active) setDecrypting(false); });
    return () => { active = false; };
  }, [a.url, a.key, a.iv, a.mime, a.fileKey, sentAt]);

  const rounded = isMe ? 'rounded-t-2xl rounded-bl-2xl rounded-br-sm' : 'rounded-t-2xl rounded-br-2xl rounded-bl-sm';

  if (decrypting) return (
    <div className={`w-full max-w-[220px] h-[140px] ${rounded} border border-white/[0.08] bg-white/[0.03] flex items-center justify-center gap-2`}>
      <Loader2 className="w-4 h-4 animate-spin text-white/25" />
      <span className="text-xs text-white/25">{t("chat.decrypting")}</span>
    </div>
  );

  if (failure === 'expired') return (
    <div className={`w-full max-w-[220px] h-[80px] ${rounded} border border-white/[0.08] bg-white/[0.02] flex items-center justify-center px-3 text-center`}>
      <span className="text-xs text-white/30">{t("chat.file_expired_image")}</span>
    </div>
  );

  if (failure || !src) return (
    <div className={`w-full max-w-[220px] h-[80px] ${rounded} border border-red-500/20 bg-red-500/5 flex items-center justify-center`}>
      <span className="text-xs text-red-400/50">{t("chat.decrypt_failed_image")}</span>
    </div>
  );

  return (
    <>
      <button onClick={() => setLightbox(true)}
        className={`block w-full max-w-[min(280px,80vw)] ${rounded} overflow-hidden border border-white/10 hover:border-white/20 transition-colors cursor-zoom-in`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={a.name} className="w-full h-auto object-cover max-h-72" />
      </button>
      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" onClick={() => setLightbox(false)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={a.name} className="max-w-full max-h-full rounded-lg shadow-2xl" />
        </div>
      )}
    </>
  );
}

function FileCard({ a, isMe, sentAt }: { a: NonNullable<ChatMessage['attachment']>; isMe: boolean; sentAt: number }) {
  const [saving,     setSaving]     = useState(false);
  // См. тот же комментарий в ImageBubble: «истёк срок хранения» и «не удалось
  // расшифровать» больше не выглядят одинаково.
  const [failure,    setFailure]    = useState<AttachmentFailure | null>(null);
  const [dlProgress, setDlProgress] = useState<number | null>(null);
  const t = useTranslations();

  const handleDownload = async () => {
    if (saving) return;
    if (!a.key || !a.iv) {
      if (!isTrustedAttachmentUrl(a.url)) { setFailure('decrypt_failed'); return; }
      window.open(a.url, '_blank', 'noopener');
      return;
    }
    setSaving(true); setFailure(null); setDlProgress(0);

    const doDownload = async (url: string) => {
      if (a.chunked && a.chunkCount && a.size) {
        await decryptAndSaveChunked(url, a.key!, a.iv!, a.name, a.mime, a.chunkCount, a.chunkSize ?? CHUNK_SIZE, a.size, setDlProgress);
      } else {
        await decryptAndSave(url, a.key!, a.iv!, a.name, a.mime);
      }
    };

    try {
      await doDownload(a.url);
    } catch (err: unknown) {
      // URL might be stale — reconstruct from fileKey if available
      if (a.fileKey) {
        try {
          const fresh = await refreshDownloadUrl(a.fileKey);
          await doDownload(fresh);
        } catch (retryErr) { setFailure(classifyAttachmentFailure(retryErr, { sentAt })); }
      } else {
        setFailure(classifyAttachmentFailure(err, { sentAt }));
      }
    } finally {
      setSaving(false); setDlProgress(null);
    }
  };

  return (
    <button onClick={handleDownload} disabled={saving}
      className={`flex items-center gap-2.5 px-3 py-2.5 rounded-2xl border transition-colors group w-full max-w-[min(260px,80vw)] text-left ${
        isMe ? 'border-primary/30 bg-primary/20 hover:bg-primary/30 rounded-br-sm'
             : 'border-white/[0.08] bg-[#0d0d0f] hover:bg-[#111113] rounded-bl-sm'
      } disabled:opacity-60`}>
      <div className="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center flex-shrink-0">
        {saving ? <Loader2 className="w-4 h-4 animate-spin text-white/50" /> : <FileText className="w-4 h-4 text-white/50" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-white/85 truncate leading-tight">{a.name}</p>
        <p className="text-[11px] text-white/35 mt-0.5">
          {failure === 'expired' ? <span className="text-white/40">{t("chat.file_expired")}</span>
               : failure ? <span className="text-red-400/70">{t("chat.decrypt_failed")}</span>
               : dlProgress !== null ? <span className="text-primary/70">{t("chat.decrypting")} {dlProgress}%</span>
               : a.size != null ? formatBytes(a.size)
               : a.key ? t("chat.click_to_save") : t("chat.click_to_open")}
        </p>
      </div>
      {a.key
        ? <Download className="w-3.5 h-3.5 text-white/25 group-hover:text-white/60 flex-shrink-0 transition-colors" />
        : <ExternalLink className="w-3.5 h-3.5 text-white/25 group-hover:text-white/60 flex-shrink-0 transition-colors" />
      }
    </button>
  );
}

function UploadProgress({ pct }: { pct: number }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
        <div className="h-full bg-primary rounded-full transition-all duration-200" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] text-white/35 tabular-nums w-7 text-right">{pct}%</span>
    </div>
  );
}

// ─── Clickable URL renderer ───────────────────────────────────────────────────

// Split pattern (with capture group so URLs land at odd indices)
const URL_SPLIT = /(https?:\/\/[^\s<>"']+)/g;
// Non-global for safe .test() calls
const URL_TEST  = /^https?:\/\/[^\s<>"']+$/;

function MessageText({ text }: { text: string }) {
  const parts = text.split(URL_SPLIT);
  return (
    <>
      {parts.map((part, i) =>
        URL_TEST.test(part) ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 opacity-80 hover:opacity-100 break-all"
            onClick={e => e.stopPropagation()}
          >
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function DateDivider({ ts }: { ts: number }) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  let label: string;
  if (d.toDateString() === today.toDateString()) label = 'Today';
  else if (d.toDateString() === yesterday.toDateString()) label = 'Yesterday';
  else label = d.toLocaleDateString([], { month: 'long', day: 'numeric' });
  return (
    <div className="flex items-center gap-3 my-4">
      <div className="flex-1 h-px bg-white/[0.06]" />
      <span className="text-[10px] text-white/25 font-medium tracking-wide uppercase">{label}</span>
      <div className="flex-1 h-px bg-white/[0.06]" />
    </div>
  );
}

/** Полоса на месте поля ввода, пока мессенджер не готов.
 *
 *  `explained` = «то же самое уже написано крупно в центре панели». Тогда
 *  полоса оставляет только ДЕЙСТВИЕ (отмена/включить) и молчит: иначе один и тот
 *  же текст с одной и той же кнопкой стоял бы на экране дважды — в центре и
 *  внизу. Текст полосы остаётся, когда центр занят историей переписки и
 *  объяснить состояние больше негде. */
function XmtpStatusBar({ explained = false }: { explained?: boolean }) {
  const { status, retry, cancel } = useXmtp();
  const failureText = useXmtpFailureText();
  const t = useTranslations();

  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center gap-2 px-4 py-3 border-t border-white/[0.06]">
        {!explained && (
          <>
            <div className="w-4 h-4 border-2 border-white/20 border-t-white/50 rounded-full animate-spin flex-shrink-0" />
            <span className="text-xs text-white/30">{t("chat.connecting_messenger")}</span>
          </>
        )}
        {/* Именно cancel(), а не disable(): кнопка обещает отменить ожидание, а
            disable() отказывался от мессенджера на всю сессию и стирал флаг
            `xmtp-registered-*`, вместе с которым навсегда глохли внутренние
            уведомления о сообщениях. Разбор — в шапке cancel() в XmtpContext. */}
        <button
          onClick={cancel}
          className="flex-shrink-0 text-xs text-white/40 hover:text-white/70 underline underline-offset-2 transition-colors"
        >
          {t("common.cancel")}
        </button>
      </div>
    );
  }
  return (
    <div className={`flex items-center gap-3 px-4 py-3 border-t border-white/[0.06] bg-white/[0.02] ${
      explained ? 'justify-center' : 'justify-between'
    }`}>
      {!explained && (
        <p className="text-xs text-white/40 min-w-0 line-clamp-2">
          {failureText ?? t("chat.messaging_off")}
        </p>
      )}
      <button
        onClick={retry}
        className="flex-shrink-0 text-xs text-white/50 hover:text-white/80 underline underline-offset-2 transition-colors"
      >
        {failureText ? t("chat.retry") : t("chat.enable_messaging")}
      </button>
    </div>
  );
}

function XmtpConnecting() {
  const t = useTranslations();
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-4">
      <div className="relative w-12 h-12">
        <div className="absolute inset-0 rounded-full border-2 border-white/[0.06]" />
        <div className="absolute inset-0 rounded-full border-2 border-t-primary/60 animate-spin" />
        <div className="absolute inset-2 flex items-center justify-center">
          <Lock className="w-4 h-4 text-white/25" />
        </div>
      </div>
      <div>
        <p className="text-white/60 text-sm font-medium mb-1">{t("chat.connecting")}</p>
        <p className="text-white/25 text-xs max-w-[200px] leading-relaxed">
          {t("chat.connecting_desc")}
        </p>
      </div>
    </div>
  );
}

// ─── ChatPanel ────────────────────────────────────────────────────────────────

interface DealContext {
  agreementAddr: string;
  role: 'client' | 'executor';
  status: number;
  amount: bigint;
  jobTitle?: string;
  jobId?: string;
}

interface ChatPanelProps {
  recipientAddress: string;
  onBack?: () => void;
  // Every non-terminal deal between the current user and this counterparty.
  // 0 = plain chat, 1 = normal single-deal bar, 2+ = a selector is shown.
  dealContexts?: DealContext[];
  /** True while the parent's deal-context reads are still resolving. Holds back the
   *  pre-deal bar so it doesn't briefly show the peer's ServiceBoard offers before an
   *  existing deal's status finishes loading (and never offers a second parallel deal). */
  dealsLoading?: boolean;
}

// Agreement.Status enum (7 states) — from getDetails().status_ (uint8 0-6)
// Labels are resolved via i18n keys at render time
const AGR_STATUS_CLS: Record<number, string> = {
  0: 'text-sky-400/70',
  1: 'text-emerald-400/70',
  2: 'text-violet-400/70',
  3: 'text-green-400/70',
  4: 'text-red-400/70',
  5: 'text-purple-400/70',
  6: 'text-white/30',
};
const AGR_STATUS_KEY: Record<number, string> = {
  0: 'deal_status.created',
  1: 'deal_status.funded',
  2: 'deal_status.active',
  3: 'deal_status.completed',
  4: 'deal_status.disputed',
  5: 'deal_status.resolved',
  6: 'deal_status.refunded',
};

export function ChatPanel({ recipientAddress, onBack, dealContexts, dealsLoading }: ChatPanelProps) {
  const { address } = useAccount();
  const t = useTranslations();
  const queryClient = useQueryClient();
  const { messages, sendMessage, sendFile, loadMore, hasMore, isLoading, isInitialized, error, uploadProgress, streamDead, reconnect, needsSetup, markDealContext, peerLastReadAt, logIncomplete } =
    usePairChat(recipientAddress);
  const { displayName, avatarUrl } = useProfile(recipientAddress);
  // Состояние САМОГО мессенджера — отдельно от состояния этой переписки.
  // Раньше панель их не различала и на выключенном мессенджере крутила спиннер
  // «Инициализация мессенджера…» рядом с надписью «Сообщений пока нет», хотя
  // ничего не инициализировалось и инициализироваться не собиралось.
  const { status: xmtpStatus, retry: retryXmtp } = useXmtp();
  const xmtpFailureText = useXmtpFailureText();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  // 0 or 1 active deal: nothing to pick. 2+: user picks which one the action
  // bar / attach-file gating / header refer to via the selector rendered below.
  const [selectedDealId, setSelectedDealId] = useState<string | null>(null);
  const dealContext = useMemo(() => {
    if (!dealContexts || dealContexts.length === 0) return undefined;
    if (dealContexts.length === 1) return dealContexts[0];
    return dealContexts.find(d => d.agreementAddr === selectedDealId) ?? dealContexts[dealContexts.length - 1];
  }, [dealContexts, selectedDealId]);

  // Tell the shared thread which deal is "current" so the relayer's arbiter
  // dispute-log bot can tag entries by deal instead of one undifferentiated
  // stream. Fires once per resolved value (including null, for "just chatting"),
  // never resent for the same value — see usePairChat.markDealContext.
  const lastMarkedDealRef = useRef<string | null | undefined>(null);
  useEffect(() => {
    if (!isInitialized) return;
    const current = dealContext?.agreementAddr?.toLowerCase() ?? null;
    if (lastMarkedDealRef.current === current) return;
    lastMarkedDealRef.current = current;
    markDealContext(current);
  }, [dealContext?.agreementAddr, isInitialized, markDealContext]);


  const [text, setText]             = useState('');
  const [sending, setSending]       = useState(false);
  const [uploading, setUploading]   = useState(false);
  const [uploadErr, setUploadErr]   = useState<string | null>(null);
  const [pendingFile, setPendingFile]         = useState<File | null>(null);
  const [pendingPreview, setPendingPreview]   = useState<string | null>(null);
  const uploadAbortRef                        = useRef<AbortController | null>(null);
  const [copied, setCopied]         = useState(false);
  const [atBottom, setAtBottom]     = useState(true);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [preDealConfirm, setPreDealConfirm] = useState<'apply' | 'accept_deploy' | 'request_service' | 'withdraw' | 'reject_app' | null>(null);
  const [preDealBusy, setPreDealBusy] = useState(false);
  // Занятость по отзыву заявки снимается ОТЛОЖЕННО (см. handlePreDealAction), а
  // чат легко закрыть раньше — панель размонтируется на любом переключении
  // собеседника. Без этой отметки отложенное снятие било бы setState по
  // размонтированному компоненту.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Skip pre-deal reads while a deal is already resolved OR while the parent's deal
  // reads are still loading — otherwise, during the initial read waterfall, this
  // would fall through to the peer's ServiceBoard offers instead of the real deal.
  const preDealCtx = usePreDealBar(address, recipientAddress, !!dealContext || !!dealsLoading);
  const searchRef = useRef<HTMLInputElement>(null);

  // Fee preview for the 'request_service' pre-deal confirm dialog only — the
  // actual amount+fee that gets signed is read fresh in relay.ts, this is
  // display-only so the confirm text doesn't quote a stale trade-only number.
  const { feeBps, feeFloor, isLoading: feeConfigLoading } = useFeeConfig();
  // feeFloor === 0n means "not configured yet" (FactoryStorage.quote() reverts
  // FeeNotConfigured() in that case), not "no fee" — excluded here for the
  // same reason as the other three feeConfigReady sites in this branch.
  const feeConfigReady = !feeConfigLoading && feeBps !== undefined && feeFloor !== undefined && feeFloor > 0n;
  const preDealFeeRaw = preDealCtx && feeBps !== undefined && feeFloor !== undefined
    ? quoteFeeLocal(preDealCtx.amount, feeBps, feeFloor)
    : 0n;

  const fileRef       = useRef<HTMLInputElement>(null);
  const textareaRef   = useRef<HTMLTextAreaElement>(null);
  const bottomRef     = useRef<HTMLDivElement>(null);
  const scrollRef     = useRef<HTMLDivElement>(null);
  const prevMsgCount  = useRef(0);

  const chatUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/chat/${address?.toLowerCase()}`
    : '';

  const copyInvite = async () => {
    if (!chatUrl) return;
    await navigator.clipboard.writeText(chatUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Scroll to bottom when keyboard opens/closes (visual viewport resize)
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      if (atBottom) bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, [atBottom]);

  // Prevent scroll chaining on iOS: when the messages list is at its top or bottom
  // boundary, block the touch event from bubbling up to the page/body.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    let startY = 0;

    const onTouchStart = (e: TouchEvent) => {
      startY = e.touches[0].clientY;
    };

    const onTouchMove = (e: TouchEvent) => {
      const el = scrollRef.current;
      if (!el) return;

      const deltaY = e.touches[0].clientY - startY;
      const atTop = el.scrollTop === 0;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;

      if ((atTop && deltaY > 0) || (atBottom && deltaY < 0)) {
        e.preventDefault();
      }
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
    };
  }, []);

  // Mark conversation as seen whenever this chat is open
  useEffect(() => {
    if (!recipientAddress || !address) return;
    const key = `hexseal_chat_seen_${address.toLowerCase()}:${recipientAddress.toLowerCase()}`;
    const mark = () => localStorage.setItem(key, String(Date.now()));
    mark();
    window.addEventListener('focus', mark);
    return () => window.removeEventListener('focus', mark);
  }, [recipientAddress, address]);

  useEffect(() => {
    const newCount = messages.length;
    // Only act when the list actually grew (new message arrived or loaded).
    // Skips firing when `messages` reference changed but count is the same
    // (e.g., optimistic → confirmed replacement) — avoids spurious scroll jumps.
    if (newCount > prevMsgCount.current) {
      prevMsgCount.current = newCount;
      if (atBottom) bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [messages, atBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setAtBottom(true);
  };

  const visibleMessages = searchQuery.trim()
    ? messages.filter(m => m.text?.toLowerCase().includes(searchQuery.toLowerCase()))
    : messages;

  const toggleSearch = () => {
    setShowSearch(v => {
      if (!v) setTimeout(() => searchRef.current?.focus(), 50);
      else setSearchQuery('');
      return !v;
    });
  };

  // auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [text]);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || !isInitialized) return;
    setText('');
    setTimeout(() => textareaRef.current?.focus(), 0);
    setSending(true);
    try { await sendMessage(trimmed); setAtBottom(true); }
    catch (err) {
      console.error('[ChatPanel] send failed:', err);
      setText(trimmed);
      // The conversation is only created on the first send, so "this peer has no XMTP
      // identity yet" surfaces HERE rather than when opening the chat. Without a toast
      // the message just vanished from the thread with nothing on screen explaining why.
      const msg = err instanceof Error ? err.message : '';
      toast.error(
        msg.includes('not registered') || msg.includes('not set up')
          ? t("chat.recipient_no_messaging")
          : (msg ? msg.slice(0, 120) : t("common.error")),
        { duration: 6000 },
      );
    }
    finally { setSending(false); }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploadErr(null);
    if (file.size > MAX_FILE_SIZE) { setUploadErr('File too large. Maximum is 5 GB.'); return; }
    // Show preview — don't upload yet
    if (file.type.startsWith('image/')) {
      setPendingPreview(URL.createObjectURL(file));
    } else {
      setPendingPreview(null);
    }
    setPendingFile(file);
  };

  const handleFileSend = async () => {
    if (!pendingFile) return;
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setUploading(true);
    setUploadErr(null);
    try {
      await sendFile(pendingFile, controller.signal);
      setAtBottom(true);
      if (pendingPreview) URL.revokeObjectURL(pendingPreview);
      setPendingFile(null);
      setPendingPreview(null);
    } catch (err: unknown) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      if (!isAbort) {
        // Тот же разбор, что у текстовой отправки: «до этого адреса не дойдёт»
        // — это не «загрузка не удалась», и человеку надо сказать именно это,
        // на его языке, а не показать английскую строку из lib/xmtp.
        const msg = err instanceof Error ? err.message : '';
        setUploadErr(
          msg.includes('not registered') || msg.includes('not set up')
            ? t("chat.recipient_no_messaging")
            : (msg || 'Upload failed'),
        );
      }
    } finally {
      uploadAbortRef.current = null;
      setUploading(false);
    }
  };

  const handleFileCancel = () => {
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
    if (pendingPreview) URL.revokeObjectURL(pendingPreview);
    setPendingFile(null);
    setPendingPreview(null);
    setUploadErr(null);
  };

  const handlePreDealAction = async (action: typeof preDealConfirm) => {
    if (!action || !preDealCtx || preDealBusy) return;
    // Same gate as RequestServiceModal's hasEnough: while the fee config is
    // still loading, or has permanently failed to load (isLoading false,
    // values still undefined — no retry after that), the dialog above still
    // quotes the amount-only fallback text. Letting the confirm through here
    // would sign a permit for amount + fee while the user was only shown
    // amount, the same "signed one thing, chain wants another" gap fixed
    // everywhere else in this plan.
    if (action === 'request_service' && !feeConfigReady) return;
    setPreDealBusy(true);
    // Отзыв заявки держит блокировку ДОЛЬШЕ своего try — до отложенного
    // перечитывания. Общий finally это учитывает.
    let holdBusy = false;
    try {
      if (action === 'withdraw') {
        // Кнопка отзывала заявку ровно в одном месте — в тексте сообщения.
        // Она слала в чат «I have withdrawn my application.», на цепи не
        // происходило НИЧЕГО: заявка оставалась, адрес оставался в
        // getApplicants, клиент мог принять отозвавшегося. При этом диалог
        // обещает дословно «Your application will be withdrawn» — то есть
        // единственным следом отзыва была фраза, которой человек сам себе
        // соврал. On-chain путь существует и зовётся с доски
        // (app/board/page.tsx, handleWithdraw) — здесь тот же вызов.
        if (!walletClient || !publicClient) { toast.error(t("common.error")); return; }
        if (preDealCtx.jobId === undefined) { toast.error(t("common.error")); return; }
        toast('Confirm in wallet…');
        const { txHash } = await sendGasless(
          walletClient, publicClient, 'withdrawApplication', [preDealCtx.jobId], DIAMOND_ABI as Abi,
        );
        toast.success(t("board.jobs.withdrawn"));
        setPreDealConfirm(null);
        // Сообщение в чат — ПОСЛЕ отзыва и лучшим усилием: раньше оно было
        // вместо отзыва, а теперь не должно превращать удавшийся отзыв в
        // красный тост (собеседник мог, например, вообще не иметь XMTP).
        try { await sendMessage('I have withdrawn my application.'); }
        catch (err) { console.error('[ChatPanel] withdraw notice failed:', err); }
        // Полоса над чатом («Applied» + кнопка «Отозвать») читается прямо с
        // цепи через getApplicants — её и обновляем.
        void refreshAfterTx(publicClient, txHash, { chain: ['jobs'], graph: ['jobs'] });
        // Блокировка снимается ВНУТРИ отложенного обновления, как в MyListings
        // и на досках: релеер дождался квитанции, но следующее чтение может
        // попасть на отставшую реплику, и всё это окно полоса показывает
        // прежнее «вы откликнулись». Раннее снятие возвращало бы кнопку в
        // рабочий вид поверх устаревших данных — второй отзыв ревертит.
        holdBusy = true;
        setTimeout(() => { if (mountedRef.current) setPreDealBusy(false); }, 2000);
        return;
      }
      if (action === 'reject_app') {
        await sendMessage('Your application has been rejected.');
        setPreDealConfirm(null);
        return;
      }
      if (!walletClient || !publicClient) { toast.error('Wallet not connected'); return; }
      toast('Confirm in wallet…');
      let txHash: `0x${string}` | undefined;
      if (action === 'apply') {
        const res = await sendGasless(walletClient, publicClient, 'applyForJob', [preDealCtx.jobId!], DIAMOND_ABI as Abi);
        txHash = res.txHash as `0x${string}`;
        toast.success('Application submitted!');
      } else if (action === 'accept_deploy') {
        const res = await sendGasless(walletClient, publicClient, 'acceptApplicant', [preDealCtx.jobId!, recipientAddress as `0x${string}`], DIAMOND_ABI as Abi);
        txHash = res.txHash as `0x${string}`;
        toast.success(res.agreementAddr ? `Agreement deployed: ${res.agreementAddr.slice(0, 10)}…` : 'Accepted!');
      } else if (action === 'request_service') {
        toast('Sign: USDC permit in wallet…');
        const res = await requestServiceGasless(walletClient, publicClient, {
          serviceId:    preDealCtx.serviceId!,
          amount:       preDealCtx.amount,
          deadlineDays: preDealCtx.deadlineDays,
          terms:        '',
          // Not a rate pick: region no longer affects the fee at all (flat
          // bps/floor from FactoryStorage, same for every region) — this used
          // to matter because CIS was the cheapest fixed-fee region, that
          // path is gone. 0 is just a placeholder value; requestService still
          // takes a region argument but nothing downstream keys pricing off it.
          region:       0,
        });
        txHash = res.txHash as `0x${string}`;
        toast.success('Service request sent!');
      }
      setPreDealConfirm(null);

      // Refresh deal state so the panel switches from the pre-deal bar to the live
      // DealActionBar on its own — no manual reload. Wait for the receipt first: the
      // relay returns after submit, not mining, so refetching earlier would read
      // stale pre-confirmation escrow state. Best-effort — the 30s poll / focus
      // refetch is the fallback if the receipt wait fails.
      if (txHash) {
        try {
          await publicClient.waitForTransactionReceipt({ hash: txHash });
          await queryClient.invalidateQueries();
        } catch { /* receipt check failed — background refetch will catch up */ }
      }
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      toast.error(e?.shortMessage || e?.message || 'Transaction failed');
    } finally {
      if (!holdBusy && mountedRef.current) setPreDealBusy(false);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-black">

      {/* Header */}
      <div className="flex-shrink-0 bg-black">
        <div className="flex items-center gap-3 px-4 py-3">
          {onBack && (
            <button onClick={onBack}
              className="sm:hidden w-8 h-8 flex items-center justify-center text-white/40 hover:text-white/75 hover:bg-white/8 rounded-xl transition-colors flex-shrink-0"
              title={t("chat.open_conversations")}>
              <PanelLeftOpen className="w-4.5 h-4.5" />
            </button>
          )}
          {/* Avatar + name link to the counterparty's profile. */}
          <a href={`/profile/${recipientAddress}`} className="flex-shrink-0" title={t("wallet.my_profile")}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={avatarUrl ?? `https://effigy.im/a/${recipientAddress}.svg`}
              alt=""
              className="w-8 h-8 rounded-full bg-white/10 object-cover hover:opacity-80 transition-opacity"
              onError={(e) => {
                const img = e.target as HTMLImageElement;
                if (avatarUrl && img.src !== `https://effigy.im/a/${recipientAddress}.svg`) {
                  img.src = `https://effigy.im/a/${recipientAddress}.svg`;
                }
              }}
            />
          </a>
          <div className="min-w-0 flex-1">
            <a href={`/profile/${recipientAddress}`} className="inline-block hover:text-white transition-colors">
              <p className="text-sm font-semibold text-white/90 leading-none">
                {displayName ?? shortAddr(recipientAddress)}
              </p>
            </a>
            {dealContext ? (
              <div className="mt-0.5">
                {displayName && (
                  <p className="text-[11px] text-white/25 font-mono truncate leading-tight mb-0.5">
                    {shortAddr(recipientAddress)}
                  </p>
                )}
                {dealContext.jobTitle && (
                  <p className="text-[11px] text-white/55 truncate leading-tight font-medium mb-0.5">
                    {dealContext.jobTitle}
                  </p>
                )}
                <div className="flex items-center gap-1.5 flex-wrap">
                  {/* dealContext.role is MY role in the deal; show the COUNTERPARTY's
                      role here, since this badge sits next to their name (a badge by a
                      name reads as that person's role). I'm client → they're executor. */}
                  <span className={`text-[11px] font-medium whitespace-nowrap ${
                    dealContext.role === 'executor' ? 'text-sky-400/70' : 'text-emerald-400/70'
                  }`}>
                    {dealContext.role === 'executor' ? t("common.role_client") : t("common.role_executor")}
                  </span>
                  <span className="text-white/20 text-[11px]">·</span>
                  <a href={`/deal/${dealContext.agreementAddr}`}
                    className="text-[11px] text-white/35 font-mono hover:text-white/60 transition-colors">
                    #{dealContext.agreementAddr.slice(2, 10).toUpperCase()}
                  </a>
                  <span className="text-white/20 text-[11px]">·</span>
                  <span className={`text-[11px] whitespace-nowrap ${AGR_STATUS_CLS[dealContext?.status ?? -1] ?? 'text-white/30'}`}>
                    {dealContext?.status !== undefined && AGR_STATUS_KEY[dealContext.status]
                      ? t(AGR_STATUS_KEY[dealContext.status] as Parameters<typeof t>[0])
                      : '…'}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-white/30 font-mono truncate mt-0.5">
                {displayName ? shortAddr(recipientAddress) : recipientAddress}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {isLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-white/30" />}
            {/* No "live" badge here: a green dot next to someone's name reads as
                "this person is online", and XMTP has no presence concept at all — it
                only ever meant "my own stream is attached". The signal that actually
                matters (a dead stream) is already surfaced by the streamDead banner. */}
            {!isLoading && error && <AlertCircle className="w-3.5 h-3.5 text-red-400/60" />}
            {/* Раньше здесь стоял замок с подписью «E2E». Транспорт и правда
                зашифрован, но замок читается как «кроме нас двоих никто не
                прочтёт», а это неправда: бот релеера состоит в каждой парной
                группе и весь тред ложится на диск открытым текстом — намеренно,
                это доказательная база для арбитража. Значок не должен обещать
                больше, чем есть (docs/OPEN-ITEMS.md, п. 25). */}
            <span className="flex items-center gap-1 text-[11px] text-white/20"
              title={t("chat.dispute_log_hint")}>
              <Archive className="w-2.5 h-2.5" />
              <span className="hidden sm:inline">{t("chat.dispute_log_badge")}</span>
            </span>
            <button onClick={toggleSearch}
              className={`p-1.5 rounded-[10px] transition-colors ${
                showSearch ? 'bg-white/[0.08] text-white/70' : 'text-white/30 hover:text-white/60 hover:bg-white/[0.06]'
              }`}
              title={t("chat.search_messages")}>
              <Search className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Search bar */}
        {showSearch && (
          <div className="px-4 pb-3 flex items-center gap-2">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30" />
              <input
                ref={searchRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("chat.search_placeholder")}
                tabIndex={showSearch ? 0 : -1}
                className="w-full bg-white/[0.05] border border-white/[0.07] rounded-[14px] pl-9 pr-4 py-2 text-sm text-white placeholder:text-white/22 focus:outline-none focus:border-white/[0.14] focus:bg-white/[0.07] transition-all"
              />
            </div>
            {searchQuery && (
              <span
                className="text-[11px] text-white/35 flex-shrink-0"
                title={hasMore ? t("chat.search_history_hint") : undefined}
              >
                {visibleMessages.length} / {messages.length}{hasMore ? '…' : ''}
              </span>
            )}
            <button onClick={() => { setSearchQuery(''); setShowSearch(false); }}
              className="p-1.5 rounded-[10px] text-white/30 hover:text-white/60 hover:bg-white/[0.05] transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Pre-deal bar — suppressed while deals are still loading (see dealsLoading) */}
      {!dealContext && !dealsLoading && preDealCtx && (
        <div className="flex-shrink-0 bg-white/[0.03] border-b border-white/[0.05]">
          <div className="px-4 py-2.5 flex items-center gap-3 flex-wrap">
            <div className="flex-1 min-w-0">
              {preDealCtx.title && (
                <p className="text-xs font-semibold text-white/80 truncate mb-0.5">{preDealCtx.title}</p>
              )}
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-mono text-[11px] text-white/50">{formatUnits(preDealCtx.amount, 6)} USDC</span>
                {preDealCtx.deadlineDays > 0n && (
                  <><span className="text-white/20 text-[11px]">·</span>
                  <span className="text-[11px] text-white/35">{Number(preDealCtx.deadlineDays)}d</span></>
                )}
                <span className="text-white/20 text-[11px]">·</span>
                <span className="text-[11px] text-amber-400/70 font-medium">
                  {preDealCtx.type === 'job_as_client' ? t("deal_bar.application_received") :
                   preDealCtx.type === 'job_as_executor' ? (preDealCtx.hasApplied ? t("deal_bar.applied") : t("deal_bar.open_job")) :
                   t("deal_bar.active_service")}
                </span>
              </div>
            </div>
            {/* Кнопки гаснут на время действия: полоса пересчитывается из
                getApplicants, а тот отстаёт от квитанции — без этого второе
                нажатие уходило бы на цепь поверх уже отправленного первого. */}
            <div className="flex gap-1.5 flex-shrink-0">
              {preDealCtx.type === 'job_as_client' && (
                <>
                  <button onClick={() => setPreDealConfirm('reject_app')} disabled={preDealBusy}
                    className="px-3 py-2.5 rounded-[10px] text-xs border border-white/[0.10] text-white/40 hover:border-white/20 hover:text-white/65 transition-colors whitespace-nowrap disabled:opacity-40">
                    {t("deal_bar.reject_btn")}
                  </button>
                  <button onClick={() => setPreDealConfirm('accept_deploy')} disabled={preDealBusy}
                    className="px-3 py-2.5 rounded-[10px] text-xs bg-primary text-white hover:bg-primary/80 transition-colors font-semibold whitespace-nowrap disabled:opacity-40">
                    {t("deal_bar.accept_btn")}
                  </button>
                </>
              )}
              {preDealCtx.type === 'job_as_executor' && preDealCtx.hasApplied && (
                <button onClick={() => setPreDealConfirm('withdraw')} disabled={preDealBusy}
                  className="px-3 py-2.5 rounded-[10px] text-xs border border-red-500/25 text-red-400/60 hover:bg-red-500/10 transition-colors whitespace-nowrap disabled:opacity-40 inline-flex items-center gap-1.5">
                  {preDealBusy && <Loader2 className="w-3 h-3 animate-spin" />}
                  {t("deal_bar.withdraw_btn")}
                </button>
              )}
              {preDealCtx.type === 'job_as_executor' && !preDealCtx.hasApplied && (
                <button onClick={() => setPreDealConfirm('apply')} disabled={preDealBusy}
                  className="px-3 py-2.5 rounded-[10px] text-xs bg-primary text-white hover:bg-primary/80 transition-colors font-semibold whitespace-nowrap disabled:opacity-40">
                  {t("deal_bar.apply_btn")}
                </button>
              )}
              {preDealCtx.type === 'service_as_client' && (
                <button onClick={() => setPreDealConfirm('request_service')} disabled={preDealBusy}
                  className="px-3 py-2.5 rounded-[10px] text-xs bg-primary text-white hover:bg-primary/80 transition-colors font-semibold whitespace-nowrap disabled:opacity-40">
                  {t("deal_bar.request_btn")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Multi-deal selector — only rendered when 2+ concurrent deals exist with this peer */}
      {dealContexts && dealContexts.length > 1 && (
        <div className="flex-shrink-0 bg-white/[0.03] border-b border-white/[0.05] px-4 py-2 flex items-center gap-2">
          <span className="text-[11px] text-white/35">{t("chat.deal_selector_label")}</span>
          <select
            value={dealContext?.agreementAddr ?? ''}
            onChange={(e) => setSelectedDealId(e.target.value)}
            className="flex-1 bg-[#111113] border border-white/[0.08] rounded-[10px] px-2 py-1 text-xs text-white/80 focus:outline-none focus:border-white/[0.15]"
          >
            {dealContexts.map(d => (
              <option key={d.agreementAddr} value={d.agreementAddr}>
                #{d.agreementAddr.slice(2, 10).toUpperCase()} · {t(AGR_STATUS_KEY[d.status] as Parameters<typeof t>[0])}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Deal bar — full action bar for active agreements */}
      {dealContext && (
        <DealActionBar agreementAddr={dealContext.agreementAddr} />
      )}

      {/* Messages */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto relative flex flex-col bg-black px-3" style={{ overscrollBehavior: 'none', overflowAnchor: 'none' }}>
        {isLoading && <XmtpConnecting />}
        {!isLoading && !needsSetup && !error && messages.length > 0 && <div className="flex-1" />}
        <div className="py-4">

          {/* Оба блока ниже — состояния ПУСТОГО экрана: если история уже
              подгружена из кэша, её и надо показывать, а про мессенджер скажет
              полоса под полем ввода (XmtpStatusBar). Иначе большой центральный
              блок висел бы поверх нормальной переписки. */}

          {/* Мессенджер действительно поднимается — вот здесь спиннер уместен. */}
          {!isLoading && needsSetup && messages.length === 0 && xmtpStatus === 'loading' && (
            <div className="flex flex-col items-center justify-center py-16 gap-3 px-4 text-center">
              <div className="w-8 h-8 border-2 border-white/10 border-t-white/30 rounded-full animate-spin" />
              <p className="text-sm text-white/25">{t("chat.connecting_messenger")}</p>
            </div>
          )}

          {/* Мессенджер выключен или не поднялся. Крутить спиннер здесь значило
              бы обещать работу, которой никто не делает; человеку нужно честное
              состояние и кнопка. */}
          {!isLoading && needsSetup && messages.length === 0 && xmtpStatus !== 'loading' && (
            <div className="flex flex-col items-center justify-center py-16 gap-3 px-4 text-center">
              <div className="w-12 h-12 rounded-[16px] bg-white/[0.03] border border-white/[0.06] flex items-center justify-center">
                <MessageCircle className="w-5 h-5 text-white/[0.15]" />
              </div>
              <div>
                <p className="text-sm text-white/45 mb-1">{xmtpFailureText ?? t("chat.messaging_off")}</p>
                {!xmtpFailureText && (
                  <p className="text-white/25 text-xs max-w-[240px] leading-relaxed">
                    {t("chat.messaging_off_hint")}
                  </p>
                )}
              </div>
              <button onClick={retryXmtp}
                className="flex items-center gap-2 px-4 py-2 rounded-[12px] border border-white/[0.08] bg-[#0d0d0f] hover:bg-[#111113] transition-colors text-xs text-white/50">
                {xmtpFailureText ? <RotateCw className="w-3.5 h-3.5" /> : <MessageCircle className="w-3.5 h-3.5" />}
                {xmtpFailureText ? t("chat.retry") : t("chat.enable_messaging")}
              </button>
            </div>
          )}

          {!isLoading && error && (
            <div className="flex flex-col items-center justify-center py-24 gap-4 text-center px-4">
              <div className="w-12 h-12 rounded-[16px] bg-amber-500/8 border border-amber-500/20 flex items-center justify-center">
                <MessageCircle className="w-5 h-5 text-amber-400/55" />
              </div>
              <div>
                <p className="text-white/70 text-sm font-semibold mb-1">
                  {error.includes('not set up') || error.includes('not registered')
                    ? t("chat.recipient_no_messaging")
                    : t("chat.could_not_connect")}
                </p>
                <p className="text-white/35 text-xs max-w-xs leading-relaxed">
                  {error.includes('not set up') || error.includes('not registered')
                    ? t("chat.share_invite_hint")
                    : error}
                </p>
              </div>
              {(error.includes('not set up') || error.includes('not registered')) ? (
                chatUrl && (
                  <button onClick={copyInvite}
                    className="flex items-center gap-2 px-4 py-2 rounded-[12px] border border-white/[0.08] bg-[#0d0d0f] hover:bg-[#111113] transition-colors text-xs text-white/50">
                    {copied ? <><Check className="w-3.5 h-3.5 text-emerald-400" />{t("chat.copied")}</> : <><Copy className="w-3.5 h-3.5" />{t("chat.copy_invite")}</>}
                  </button>
                )
              ) : (
                // Кнопка была только у «собеседник не зарегистрирован». На любой
                // другой ошибке единственным выходом оставалось уйти со страницы
                // и вернуться — то есть перезагрузка вместо повтора.
                <button onClick={reconnect}
                  className="flex items-center gap-2 px-4 py-2 rounded-[12px] border border-white/[0.08] bg-[#0d0d0f] hover:bg-[#111113] transition-colors text-xs text-white/50">
                  <RotateCw className="w-3.5 h-3.5" />{t("chat.retry")}
                </button>
              )}
            </div>
          )}

          {/* «Сообщений пока нет» — только когда мессенджер РАБОТАЕТ и в
              переписке действительно пусто. При выключенном мессенджере эта
              надпись утверждала бы то, чего никто не проверял. */}
          {!isLoading && !error && !needsSetup && messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
              <div className="w-12 h-12 rounded-[16px] bg-white/[0.03] border border-white/[0.06] flex items-center justify-center">
                <MessageCircle className="w-5 h-5 text-white/[0.15]" />
              </div>
              <p className="text-white/20 text-sm">{t("chat.no_messages_yet")}</p>
            </div>
          )}

          {!isLoading && !error && searchQuery && visibleMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center gap-1.5">
              <p className="text-white/30 text-sm">{t("chat.no_match")} &ldquo;{searchQuery}&rdquo;</p>
              {hasMore && (
                <p className="text-white/20 text-xs max-w-[220px] leading-relaxed">
                  {t("chat.search_history_hint")}
                </p>
              )}
            </div>
          )}

          {/* Load older messages */}
          {!isLoading && !error && hasMore && messages.length > 0 && (
            <div className="flex justify-center py-3">
              <button
                onClick={loadMore}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-[20px] bg-white/[0.05] border border-white/[0.08] text-xs text-white/40 hover:bg-white/[0.09] hover:text-white/65 transition-colors whitespace-nowrap"
              >
                <ChevronDown className="w-3 h-3 rotate-180" />
                {t("chat.load_older")}
              </button>
            </div>
          )}

          {!isLoading && !error && (() => {
            const items: React.ReactNode[] = [];
            let lastDay = '';
            let lastGroupEnd = -1;

            visibleMessages.forEach((msg, i) => {
              const isMe    = msg.from === address?.toLowerCase();
              const prev    = visibleMessages[i - 1];
              const next    = visibleMessages[i + 1];
              // Break the bubble group if sender changes OR the gap exceeds TIME_BREAK
              const isFirst = !prev || prev.from !== msg.from || (msg.timestamp  - prev.timestamp) > TIME_BREAK;
              const isLast  = !next || next.from !== msg.from || (next.timestamp - msg.timestamp)  > TIME_BREAK;

              // Date divider
              const day = new Date(msg.timestamp).toDateString();
              if (day !== lastDay) {
                lastDay = day;
                items.push(<DateDivider key={`d-${msg.id}`} ts={msg.timestamp} />);
              }

              // Gap between different senders
              if (isFirst && i > 0 && lastGroupEnd === i - 1) {
                items.push(<div key={`gap-${msg.id}`} className="h-3" />);
              }
              if (isLast) lastGroupEnd = i;

              items.push(
                <div key={msg.id}
                  className={`flex items-end gap-2 ${isMe ? 'justify-end' : 'justify-start'} ${!isLast ? 'mb-0.5' : ''}`}>

                  {/* Avatar placeholder (incoming only, last of group) */}
                  {!isMe && (
                    isLast
                      ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={avatarUrl ?? `https://effigy.im/a/${msg.from}.svg`}
                          alt=""
                          className="w-7 h-7 rounded-full flex-shrink-0 mb-0.5 bg-white/10 object-cover"
                          onError={(e) => {
                            const img = e.target as HTMLImageElement;
                            const fallback = `https://effigy.im/a/${msg.from}.svg`;
                            if (img.src !== fallback) img.src = fallback;
                          }}
                        />
                      )
                      : <div className="w-7 flex-shrink-0" />
                  )}

                  <div className={`group max-w-[72%] flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                    {msg.attachment
                      ? !msg.attachment.chunked && isImageMime(msg.attachment.mime)
                        ? <ImageBubble a={msg.attachment} isMe={isMe} sentAt={msg.timestamp} />
                        : <FileCard a={msg.attachment} isMe={isMe} sentAt={msg.timestamp} />
                      : (
                        <div className={`px-4 py-2.5 text-[15px] break-words leading-relaxed ${
                          isMe
                            ? `bg-primary text-white ${
                                isFirst && isLast ? 'rounded-[22px]' :
                                isFirst ? 'rounded-t-[22px] rounded-bl-[22px] rounded-br-[6px]' :
                                isLast  ? 'rounded-tl-[22px] rounded-tr-[6px] rounded-b-[22px]' :
                                          'rounded-l-[22px] rounded-r-[6px]'
                              }`
                            : `bg-[#1e1e21] text-white/90 ${
                                isFirst && isLast ? 'rounded-[22px]' :
                                isFirst ? 'rounded-t-[22px] rounded-br-[22px] rounded-bl-[6px]' :
                                isLast  ? 'rounded-tr-[22px] rounded-tl-[6px] rounded-b-[22px]' :
                                          'rounded-r-[22px] rounded-l-[6px]'
                              }`
                        }`}>
                          <MessageText text={msg.text} />
                          {isLast && (
                            <div className="flex items-center justify-end gap-1 mt-1 -mb-0.5 text-[10px] text-white/50">
                              <span>{formatTime(msg.timestamp)}</span>
                              {isMe && (
                                msg.id.startsWith('opt-')
                                  ? <Clock className="w-2.5 h-2.5 flex-shrink-0" />
                                  : msg.timestamp <= (peerLastReadAt ?? -Infinity)
                                    ? <CheckCheck className="w-3 h-3 text-white flex-shrink-0" />
                                    : <Check className="w-3 h-3 flex-shrink-0" />
                              )}
                            </div>
                          )}
                        </div>
                      )
                    }
                    {isLast && msg.attachment && (
                      <span className="text-[10px] text-white/20 mt-1 px-1 flex items-center gap-1">
                        {formatTime(msg.timestamp)}
                        {isMe && msg.id.startsWith('opt-') && (
                          <Clock className="w-2.5 h-2.5 opacity-60" />
                        )}
                      </span>
                    )}
                  </div>
                </div>
              );
            });
            return items;
          })()}

          <div ref={bottomRef} style={{ overflowAnchor: 'auto' }} />
        </div>

        {!atBottom && (
          <div className="sticky bottom-4 flex justify-center">
            <button onClick={scrollToBottom}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-[20px] bg-[#111113]/95 backdrop-blur-xl border border-white/[0.10] text-xs text-white/50 hover:bg-[#161618]/95 hover:text-white/70 transition-colors whitespace-nowrap"
              style={{ boxShadow: '0 4px 16px rgba(0,0,0,0.5)' }}>
              <ChevronDown className="w-3 h-3" />{t("chat.scroll_down")}
            </button>
          </div>
        )}
      </div>

      {/* Input */}
      {/* explained: центральные блоки выше рисуются ровно при пустой переписке
          и уже всё объясняют — полосе остаётся только действие. */}
      {needsSetup ? <XmtpStatusBar explained={messages.length === 0} /> : <div
        className="flex-shrink-0 px-2 pt-1 flex flex-col gap-1 bg-black"
        style={{
          paddingBottom: '4px',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
          position: 'relative',
          zIndex: 10,
        }}
      >
        {/* Pending file preview + disclaimer (visible before AND during upload) */}
        {pendingFile && (
          <div className="mx-1 mb-1 rounded-[16px] border border-white/[0.10] bg-[#111113] overflow-hidden">
            {pendingPreview && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={pendingPreview} alt={pendingFile.name} className="w-full max-h-48 object-cover" />
            )}
            <div className="px-3 py-2.5 flex items-start gap-2.5">
              {!pendingPreview && (
                <div className="w-9 h-9 rounded-xl bg-white/8 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <FileText className="w-4 h-4 text-white/40" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white/80 font-medium truncate">{pendingFile.name}</p>
                <p className="text-xs text-white/35 mt-0.5">
                  {pendingFile.size < 1024 * 1024
                    ? `${(pendingFile.size / 1024).toFixed(1)} KB`
                    : `${(pendingFile.size / (1024 * 1024)).toFixed(1)} MB`}
                </p>
                {uploading ? (
                  /* Progress bar replaces disclaimer during upload */
                  <div className="flex items-center gap-2 mt-2">
                    <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all duration-200"
                        style={{ width: `${uploadProgress ?? 0}%` }}
                      />
                    </div>
                    <span className="text-[11px] text-white/35 tabular-nums w-7 text-right flex-shrink-0">
                      {uploadProgress ?? 0}%
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1 mt-1.5">
                    <Lock className="w-2.5 h-2.5 text-white/25 flex-shrink-0" />
                    <p className="text-[11px] text-white/25 leading-tight">
                      {t("chat.e2e_notice")}
                    </p>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0 ml-1 mt-0.5">
                <button
                  onClick={handleFileCancel}
                  title={uploading ? t("chat.cancel_upload") : t("chat.remove_file")}
                  className="w-7 h-7 rounded-full flex items-center justify-center text-white/30 hover:text-white/60 hover:bg-white/8 transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
                {!uploading && (
                  <button
                    onClick={handleFileSend}
                    className="flex items-center gap-1.5 h-7 px-3 rounded-full bg-primary text-white text-xs font-medium hover:bg-primary/85 active:scale-95 transition-all"
                  >
                    <Send className="w-3 h-3" />
                    {t("chat.send")}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        {/* Журнал спора для этой пары не ведётся: бота релеера в группе нет и
            добавить его не вышло. Ничего не блокирует — невозможность вести
            протокол не повод запрещать людям общаться, — но и не молчит:
            узнать об этом при споре, когда эскроу уже делят, было бы поздно.
            Разбор — в шапке `lib/xmtpBotMembership.ts`. */}
        {logIncomplete && (
          <div className="px-3 py-2 mx-1 mb-1 rounded-[12px] bg-amber-500/[0.07] border border-amber-500/15">
            <p className="text-xs text-amber-400/70">{t("chat.log_incomplete")}</p>
          </div>
        )}
        {/* Stream dead banner */}
        {streamDead && (
          <div className="flex items-center justify-between gap-2 px-3 py-2 mx-1 mb-1 rounded-[12px] bg-yellow-500/10 border border-yellow-500/20">
            <p className="text-xs text-yellow-400/80">{t("chat.stream_dead")}</p>
            <button
              onClick={reconnect}
              className="flex-shrink-0 text-xs font-medium text-yellow-400 hover:text-yellow-300 transition-colors"
            >
              {t("chat.reconnect")}
            </button>
          </div>
        )}
        {uploadErr && <p className="text-xs text-red-400/60 px-1">{uploadErr}</p>}
        <div className="flex items-end gap-2">
          <input ref={fileRef} type="file" className="hidden" tabIndex={-1} onChange={handleFileChange} />
          <button
            onClick={() => { if (!isInitialized || uploading || pendingFile || !dealContext) return; fileRef.current?.click(); }}
            disabled={!isInitialized || uploading || !!pendingFile || !dealContext}
            title={dealContext ? t("chat.attach_file_title") : t("chat.files_deal_only")}
            className="w-9 h-9 rounded-full flex items-center justify-center text-white/30 hover:text-white/65 hover:bg-white/[0.07] disabled:opacity-10 disabled:cursor-not-allowed transition-colors flex-shrink-0 mb-0.5">
            <Paperclip className="w-4 h-4" />
          </button>
          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            enterKeyHint="send"
            autoComplete="off"
            placeholder={
              isLoading     ? ''                          :
              error         ? t("chat.chat_unavailable") :
              isInitialized ? t("chat.message_placeholder") : t("chat.initializing")
            }
            className="flex-1 bg-[#111113] border border-white/[0.08] rounded-[22px] px-4 py-2.5 text-[15px] text-white placeholder:text-white/22 focus:outline-none focus:border-white/[0.15] focus:bg-[#141416] transition-all resize-none overflow-hidden leading-[1.45]"
            style={{ minHeight: '44px', maxHeight: '120px' }}
          />
          <button
            onClick={handleSend}
            disabled={!isInitialized || !text.trim() || sending}
            className="w-9 h-9 rounded-full bg-primary flex items-center justify-center text-white hover:bg-primary/85 active:scale-95 disabled:opacity-25 disabled:cursor-not-allowed transition-all flex-shrink-0 mb-0.5">
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>}

      {/* Pre-deal confirm modal */}
      {preDealConfirm && preDealCtx && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
          <div className="border border-white/[0.08] rounded-[22px] p-5 w-full max-w-sm"
            style={{ background: '#0d0d0f', boxShadow: '0 8px 40px rgba(0,0,0,0.7), 0 2px 8px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)' }}>
            <h3 className="text-sm font-semibold text-white mb-2">
              {preDealConfirm === 'apply'           ? t("chat_modal.apply_title") :
               preDealConfirm === 'accept_deploy'   ? t("chat_modal.accept_deploy_title") :
               preDealConfirm === 'request_service' ? t("chat_modal.request_service_title") :
               preDealConfirm === 'withdraw'        ? t("chat_modal.withdraw_title") :
                                                      t("chat_modal.reject_app_title")}
            </h3>
            <p className="text-xs text-white/45 mb-5 leading-relaxed">
              {preDealConfirm === 'apply'
                ? t("chat_modal.apply_desc")
                : preDealConfirm === 'accept_deploy'
                ? t("chat_modal.accept_deploy_desc")
                : preDealConfirm === 'request_service'
                ? (feeConfigReady
                    ? t("chat_modal.request_service_desc", {
                        total: formatUnits(preDealCtx.amount + preDealFeeRaw, 6),
                        amount: formatUnits(preDealCtx.amount, 6),
                        fee: formatUnits(preDealFeeRaw, 6),
                      })
                    : t("chat_modal.request_service_desc_no_fee", {
                        amount: formatUnits(preDealCtx.amount, 6),
                      }))
                : preDealConfirm === 'withdraw'
                ? t("chat_modal.withdraw_desc")
                : t("chat_modal.reject_app_desc")}
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setPreDealConfirm(null)} disabled={preDealBusy}
                className="px-3.5 py-1.5 rounded-[10px] text-xs text-white/45 hover:text-white/70 border border-white/[0.08] hover:bg-white/[0.05] transition-colors disabled:opacity-40">
                {t("chat_modal.cancel_btn")}
              </button>
              <button
                onClick={() => handlePreDealAction(preDealConfirm)}
                disabled={preDealBusy || (preDealConfirm === 'request_service' && !feeConfigReady)}
                className={`px-3.5 py-1.5 rounded-[10px] text-xs font-medium text-white transition-colors disabled:opacity-40 flex items-center gap-1.5 ${
                  preDealConfirm === 'withdraw' || preDealConfirm === 'reject_app'
                    ? 'bg-red-600 hover:bg-red-500'
                    : 'bg-primary hover:bg-primary/80'
                }`}>
                {preDealBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : t("chat_modal.confirm_btn")}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
