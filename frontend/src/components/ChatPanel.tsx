'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useAccount, useReadContract, usePublicClient, useWalletClient } from 'wagmi';
import { formatUnits, type Abi } from 'viem';
import { AGREEMENT_ABI, DIAMOND_ABI } from '@/config/contracts';
import { sendAgreementGasless, sendGasless, requestServiceGasless } from '@/lib/relay';
import { usePreDealBar } from '@/hooks/usePreDealBar';
import { toast } from 'react-hot-toast';

import { useDirectChat } from '@/hooks/useDirectChat';
import { MessagingSetup } from '@/components/MessagingSetup';
import {
  PanelLeftOpen, Send, Loader2, MessageCircle, AlertCircle,
  Copy, Check, Paperclip, FileText, ExternalLink, Lock,
  ChevronDown, Download, Search, X,
} from 'lucide-react';
import type { ChatMessage } from '@/lib/xmtp';
import { decryptToObjectUrl, decryptAndSave, decryptAndSaveChunked, CHUNK_SIZE } from '@/lib/fileCrypto';
import { MAX_FILE_SIZE } from '@/lib/fileStorage';
import { useProfile } from '@/hooks/useProfile';

const ZERO_HASH = ('0x' + '00'.repeat(32)) as `0x${string}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isImageMime(mime?: string) {
  return mime?.startsWith('image/') ?? false;
}

// ─── Attachment components ────────────────────────────────────────────────────

function ImageBubble({ a, isMe }: { a: NonNullable<ChatMessage['attachment']>; isMe: boolean }) {
  const [src, setSrc]               = useState<string | null>(null);
  const [decrypting, setDecrypting] = useState(false);
  const [decryptErr, setDecryptErr] = useState(false);
  const [lightbox, setLightbox]     = useState(false);

  useEffect(() => {
    if (!a.key || !a.iv) { setSrc(a.url); return; }
    let active = true;
    setDecrypting(true);
    decryptToObjectUrl(a.url, a.key, a.iv, a.mime)
      .then((url) => { if (active) setSrc(url); })
      .catch(() => { if (active) setDecryptErr(true); })
      .finally(() => { if (active) setDecrypting(false); });
    return () => { active = false; };
  }, [a.url, a.key, a.iv, a.mime]);

  const rounded = isMe ? 'rounded-t-2xl rounded-bl-2xl rounded-br-sm' : 'rounded-t-2xl rounded-br-2xl rounded-bl-sm';

  if (decrypting) return (
    <div className={`w-full max-w-[220px] h-[140px] ${rounded} border border-white/10 bg-white/5 flex items-center justify-center gap-2`}>
      <Loader2 className="w-4 h-4 animate-spin text-white/30" />
      <span className="text-xs text-white/30">Decrypting…</span>
    </div>
  );

  if (decryptErr || !src) return (
    <div className={`w-full max-w-[220px] h-[80px] ${rounded} border border-red-500/20 bg-red-500/5 flex items-center justify-center`}>
      <span className="text-xs text-red-400/60">Failed to decrypt image</span>
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

function FileCard({ a, isMe }: { a: NonNullable<ChatMessage['attachment']>; isMe: boolean }) {
  const [saving,     setSaving]     = useState(false);
  const [err,        setErr]        = useState(false);
  const [dlProgress, setDlProgress] = useState<number | null>(null);

  const handleDownload = async () => {
    if (saving) return;
    if (!a.key || !a.iv) { window.open(a.url, '_blank'); return; }
    setSaving(true); setErr(false); setDlProgress(0);
    try {
      if (a.chunked && a.chunkCount && a.size) {
        await decryptAndSaveChunked(a.url, a.key, a.iv, a.name, a.mime, a.chunkCount, a.chunkSize ?? CHUNK_SIZE, a.size, setDlProgress);
      } else {
        await decryptAndSave(a.url, a.key, a.iv, a.name, a.mime);
      }
    }
    catch { setErr(true); }
    finally { setSaving(false); setDlProgress(null); }
  };

  return (
    <button onClick={handleDownload} disabled={saving}
      className={`flex items-center gap-2.5 px-3 py-2.5 rounded-2xl border transition-colors group w-full max-w-[min(260px,80vw)] text-left ${
        isMe ? 'border-primary/30 bg-primary/20 hover:bg-primary/30 rounded-br-sm'
             : 'border-white/10 bg-white/8 hover:bg-white/12 rounded-bl-sm'
      } disabled:opacity-60`}>
      <div className="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center flex-shrink-0">
        {saving ? <Loader2 className="w-4 h-4 animate-spin text-white/50" /> : <FileText className="w-4 h-4 text-white/50" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-white/85 truncate leading-tight">{a.name}</p>
        <p className="text-[11px] text-white/35 mt-0.5">
          {err ? <span className="text-red-400/70">Decryption failed</span>
               : dlProgress !== null ? <span className="text-primary/70">Decrypting… {dlProgress}%</span>
               : a.size != null ? formatBytes(a.size)
               : a.key ? 'Encrypted · click to save' : 'Click to open'}
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
  dealContext?: DealContext;
}

// Agreement.Status enum (7 states) — from getDetails().status_ (uint8 0-6)
const AGR_STATUS: Record<number, { label: string; cls: string }> = {
  0: { label: 'Created',   cls: 'text-sky-400/70' },
  1: { label: 'Funded',    cls: 'text-emerald-400/70' },
  2: { label: 'Active',    cls: 'text-violet-400/70' },
  3: { label: 'Completed', cls: 'text-green-400/70' },
  4: { label: 'Disputed',  cls: 'text-red-400/70' },
  5: { label: 'Resolved',  cls: 'text-purple-400/70' },
  6: { label: 'Refunded',  cls: 'text-white/30' },
};

export function ChatPanel({ recipientAddress, onBack, dealContext }: ChatPanelProps) {
  const { address } = useAccount();
  const { messages, sendMessage, sendFile, isLoading, isInitialized, error, uploadProgress, needsSetup } =
    useDirectChat(recipientAddress);
  const { displayName, avatarUrl } = useProfile(recipientAddress);
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { data: dealDetails } = useReadContract({
    address: (dealContext?.agreementAddr ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
    abi: AGREEMENT_ABI,
    functionName: 'getDetails',
    query: { enabled: !!dealContext?.agreementAddr },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dealMeta = dealDetails ? (() => { const d = dealDetails as any; return {
    deadlineDays:    (d.deadlineDays_ ?? d[5]  ?? 0n) as bigint,
    markedDoneAt:    (d.markedDoneAt_ ?? d[8]  ?? 0n) as bigint,
    agreementStatus: Number(d.status_ ?? d[11] ?? -1),
  }; })() : null;


  const [text, setText]             = useState('');
  const [sending, setSending]       = useState(false);
  const [uploading, setUploading]   = useState(false);
  const [uploadErr, setUploadErr]   = useState<string | null>(null);
  const [copied, setCopied]         = useState(false);
  const [atBottom, setAtBottom]     = useState(true);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [confirmAction, setConfirmAction] = useState<'accept' | 'reject' | 'release' | 'dispute' | 'markDone' | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [preDealConfirm, setPreDealConfirm] = useState<'apply' | 'accept_deploy' | 'request_service' | 'withdraw' | 'reject_app' | null>(null);
  const [preDealBusy, setPreDealBusy] = useState(false);

  const preDealCtx = usePreDealBar(address, recipientAddress, !!dealContext);
  const searchRef = useRef<HTMLInputElement>(null);

  const fileRef    = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef  = useRef<HTMLDivElement>(null);
  const scrollRef  = useRef<HTMLDivElement>(null);

  const chatUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/chat/${address?.toLowerCase()}`
    : '';

  const copyInvite = async () => {
    if (!chatUrl) return;
    await navigator.clipboard.writeText(chatUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    if (atBottom) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
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
    setSending(true);
    try { await sendMessage(trimmed); setAtBottom(true); }
    catch (err) {
      console.error('[ChatPanel] send failed:', err);
      setText(trimmed);
    }
    finally { setSending(false); }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploadErr(null);
    if (file.size > MAX_FILE_SIZE) { setUploadErr('File too large. Maximum is 5 GB.'); return; }
    setUploading(true);
    try { await sendFile(file); setAtBottom(true); }
    catch (err: unknown) { setUploadErr(err instanceof Error ? err.message : 'Upload failed'); }
    finally { setUploading(false); }
  };

  const handleDealAction = async (action: 'accept' | 'reject' | 'release' | 'dispute' | 'markDone') => {
    if (!dealContext || actionBusy) return;
    setActionBusy(true);
    try {
      if (action === 'reject') {
        await sendMessage('I have declined this job request.');
        toast.success('Rejection sent. The deal will expire if not activated.');
        setConfirmAction(null);
        return;
      }
      if (!walletClient || !publicClient) { toast.error('Wallet not connected'); return; }
      const fnMap: Record<string, string> = {
        accept: 'activate',
        release: 'release',
        dispute: 'raiseDispute',
        markDone: 'markDone',
      };
      const msgMap: Record<string, string> = {
        accept: 'Deal activated! Work has started.',
        release: 'Payment released to executor!',
        dispute: 'Dispute raised. Arbiter will be notified.',
        markDone: 'Work submitted! Awaiting client review.',
      };
      toast('Confirm in wallet…');
      await sendAgreementGasless(walletClient, publicClient, dealContext.agreementAddr as `0x${string}`, fnMap[action], AGREEMENT_ABI as Abi, []);
      toast.success(msgMap[action] ?? 'Done!');
      setConfirmAction(null);
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      toast.error(e?.shortMessage || e?.message || 'Transaction failed');
    } finally {
      setActionBusy(false);
    }
  };

  const handlePreDealAction = async (action: typeof preDealConfirm) => {
    if (!action || !preDealCtx || preDealBusy) return;
    setPreDealBusy(true);
    try {
      if (action === 'withdraw') {
        await sendMessage('I have withdrawn my application.');
        setPreDealConfirm(null);
        return;
      }
      if (action === 'reject_app') {
        await sendMessage('Your application has been rejected.');
        setPreDealConfirm(null);
        return;
      }
      if (!walletClient || !publicClient) { toast.error('Wallet not connected'); return; }
      toast('Confirm in wallet…');
      if (action === 'apply') {
        await sendGasless(walletClient, publicClient, 'applyForJob', [preDealCtx.jobId!], DIAMOND_ABI as Abi);
        toast.success('Application submitted!');
      } else if (action === 'accept_deploy') {
        const res = await sendGasless(walletClient, publicClient, 'acceptApplicant', [preDealCtx.jobId!, recipientAddress as `0x${string}`], DIAMOND_ABI as Abi);
        toast.success(res.agreementAddr ? `Agreement deployed: ${res.agreementAddr.slice(0, 10)}…` : 'Accepted!');
      } else if (action === 'request_service') {
        toast('Sign: USDC permit in wallet…');
        await requestServiceGasless(walletClient, publicClient, {
          serviceId:    preDealCtx.serviceId!,
          amount:       preDealCtx.amount,
          deadlineDays: preDealCtx.deadlineDays,
          termsHash:    ZERO_HASH,
          region:       0,
        });
        toast.success('Service request sent!');
      }
      setPreDealConfirm(null);
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      toast.error(e?.shortMessage || e?.message || 'Transaction failed');
    } finally {
      setPreDealBusy(false);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">

      {/* Header */}
      <div className="border-b border-white/8 bg-white/[0.02] flex-shrink-0">
        <div className="flex items-center gap-3 px-4 py-3">
          {onBack && (
            <button onClick={onBack}
              className="sm:hidden w-8 h-8 flex items-center justify-center text-white/40 hover:text-white/75 hover:bg-white/8 rounded-xl transition-colors flex-shrink-0"
              title="Open conversations">
              <PanelLeftOpen className="w-4.5 h-4.5" />
            </button>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={avatarUrl ?? `https://effigy.im/a/${recipientAddress}.svg`}
            alt=""
            className="w-8 h-8 rounded-full flex-shrink-0 bg-white/10 object-cover"
            onError={(e) => {
              const img = e.target as HTMLImageElement;
              if (avatarUrl && img.src !== `https://effigy.im/a/${recipientAddress}.svg`) {
                img.src = `https://effigy.im/a/${recipientAddress}.svg`;
              }
            }}
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-white/90 leading-none">
              {displayName ?? shortAddr(recipientAddress)}
            </p>
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
                <div className="flex items-center gap-1.5">
                  <span className={`text-[11px] font-medium ${
                    dealContext.role === 'client' ? 'text-sky-400/70' : 'text-emerald-400/70'
                  }`}>
                    {dealContext.role === 'client' ? 'Client' : 'Executor'}
                  </span>
                  <span className="text-white/20 text-[11px]">·</span>
                  <a href={`/deal/${dealContext.agreementAddr}`}
                    className="text-[11px] text-white/35 font-mono hover:text-white/60 transition-colors">
                    #{dealContext.agreementAddr.slice(2, 10).toUpperCase()}
                  </a>
                  <span className="text-white/20 text-[11px]">·</span>
                  <span className={`text-[11px] ${AGR_STATUS[dealMeta?.agreementStatus ?? -1]?.cls ?? 'text-white/30'}`}>
                    {AGR_STATUS[dealMeta?.agreementStatus ?? -1]?.label ?? '…'}
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
            {!isLoading && isInitialized && (
              <span className="flex items-center gap-1 text-[11px] text-emerald-400/60">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
                </span>
                live
              </span>
            )}
            {!isLoading && error && <AlertCircle className="w-3.5 h-3.5 text-red-400/60 animate-pulse" />}
            <span className="flex items-center gap-1 text-[11px] text-white/20">
              <Lock className="w-2.5 h-2.5" />E2E
            </span>
            <button onClick={toggleSearch}
              className={`p-1.5 rounded-lg transition-colors ${
                showSearch ? 'bg-white/10 text-white/70' : 'text-white/30 hover:text-white/60 hover:bg-white/5'
              }`}
              title="Search messages">
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
                placeholder="Search messages…"
                className="w-full bg-white/[0.06] border border-white/10 rounded-xl pl-9 pr-4 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-primary/35 focus:bg-white/8 transition-all"
              />
            </div>
            {searchQuery && (
              <span className="text-[11px] text-white/35 flex-shrink-0">
                {visibleMessages.length} / {messages.length}
              </span>
            )}
            <button onClick={() => { setSearchQuery(''); setShowSearch(false); }}
              className="p-1.5 text-white/30 hover:text-white/60 transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Pre-deal bar (before Agreement is deployed) */}
      {!dealContext && preDealCtx && (
        <div className="border-b border-white/8 bg-black/15 flex-shrink-0 px-4 py-2 flex items-center gap-2">
          <div className="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap text-xs">
            {preDealCtx.title && (
              <>
                <span className="text-white/70 font-medium truncate max-w-[130px]">{preDealCtx.title}</span>
                <span className="text-white/20">·</span>
              </>
            )}
            <span className="font-mono text-white/45">{formatUnits(preDealCtx.amount, 6)} USDC</span>
            {preDealCtx.deadlineDays > 0n && (
              <>
                <span className="text-white/20">·</span>
                <span className="text-white/35">{Number(preDealCtx.deadlineDays)}d</span>
              </>
            )}
            <span className="text-white/20">·</span>
            <span className="text-amber-400/60 text-[11px]">
              {preDealCtx.type === 'job_as_client' ? 'Application received' :
               preDealCtx.type === 'job_as_executor' ? (preDealCtx.hasApplied ? 'Applied' : 'Open job') :
               'Active service'}
            </span>
          </div>
          <div className="flex gap-1.5 flex-shrink-0">
            {preDealCtx.type === 'job_as_client' && (
              <>
                <button onClick={() => setPreDealConfirm('reject_app')}
                  className="px-2.5 py-1 rounded-lg text-xs border border-white/15 text-white/50 hover:border-white/25 hover:text-white/70 transition-colors">
                  Reject
                </button>
                <button onClick={() => setPreDealConfirm('accept_deploy')}
                  className="px-2.5 py-1 rounded-lg text-xs bg-primary text-white hover:bg-primary/80 transition-colors font-medium">
                  Accept & Deploy
                </button>
              </>
            )}
            {preDealCtx.type === 'job_as_executor' && preDealCtx.hasApplied && (
              <button onClick={() => setPreDealConfirm('withdraw')}
                className="px-2.5 py-1 rounded-lg text-xs border border-red-500/30 text-red-400/70 hover:bg-red-500/10 transition-colors">
                Withdraw
              </button>
            )}
            {preDealCtx.type === 'job_as_executor' && !preDealCtx.hasApplied && (
              <button onClick={() => setPreDealConfirm('apply')}
                className="px-2.5 py-1 rounded-lg text-xs bg-primary text-white hover:bg-primary/80 transition-colors font-medium">
                Apply
              </button>
            )}
            {preDealCtx.type === 'service_as_client' && (
              <button onClick={() => setPreDealConfirm('request_service')}
                className="px-2.5 py-1 rounded-lg text-xs bg-primary text-white hover:bg-primary/80 transition-colors font-medium">
                Request Service
              </button>
            )}
          </div>
        </div>
      )}

      {/* Deal bar */}
      {dealContext && (
        <div className="border-b border-white/8 bg-black/15 flex-shrink-0 px-4 py-2 flex items-center gap-2">
          <div className="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap text-xs">
            {dealContext.jobTitle && (
              <>
                <span className="text-white/70 font-medium truncate max-w-[130px]">{dealContext.jobTitle}</span>
                <span className="text-white/20">·</span>
              </>
            )}
            <span className="font-mono text-white/45">{formatUnits(dealContext.amount, 6)} USDC</span>
            {dealMeta?.deadlineDays && dealMeta.deadlineDays > 0n && (
              <>
                <span className="text-white/20">·</span>
                <span className="text-white/35">{Number(dealMeta.deadlineDays)}d</span>
              </>
            )}
            <span className="text-white/20">·</span>
            {dealMeta?.agreementStatus === 2 && dealMeta.markedDoneAt > 0n
              ? <span className="text-amber-400/70">Delivered</span>
              : <span className={AGR_STATUS[dealMeta?.agreementStatus ?? -1]?.cls ?? 'text-white/30'}>
                  {AGR_STATUS[dealMeta?.agreementStatus ?? -1]?.label ?? '…'}
                </span>
            }
          </div>

          {/* Status 1 (Funded) — executor: Accept or Reject */}
          {dealMeta?.agreementStatus === 1 && dealContext.role === 'executor' && (
            <div className="flex gap-1.5 flex-shrink-0">
              <button onClick={() => setConfirmAction('reject')}
                className="px-2.5 py-1 rounded-lg text-xs border border-white/15 text-white/50 hover:border-white/25 hover:text-white/70 transition-colors">
                Reject
              </button>
              <button onClick={() => setConfirmAction('accept')}
                className="px-2.5 py-1 rounded-lg text-xs bg-primary text-white hover:bg-primary/80 transition-colors font-medium">
                Accept
              </button>
            </div>
          )}

          {/* Status 2 (Active), work not done — executor: Mark Done */}
          {dealMeta?.agreementStatus === 2 && dealContext.role === 'executor' && dealMeta.markedDoneAt === 0n && (
            <div className="flex gap-1.5 flex-shrink-0">
              <button onClick={() => setConfirmAction('markDone')}
                className="px-2.5 py-1 rounded-lg text-xs bg-emerald-600/80 text-white hover:bg-emerald-600 transition-colors font-medium">
                Mark Done
              </button>
            </div>
          )}

          {/* Status 2 (Active), work submitted — executor: waiting */}
          {dealMeta?.agreementStatus === 2 && dealContext.role === 'executor' && dealMeta.markedDoneAt > 0n && (
            <span className="text-[11px] text-amber-400/60 flex-shrink-0 font-medium">Awaiting review</span>
          )}

          {/* Status 2 (Active), work not done — client: Dispute only */}
          {dealMeta?.agreementStatus === 2 && dealContext.role === 'client' && dealMeta.markedDoneAt === 0n && (
            <div className="flex gap-1.5 flex-shrink-0">
              <button onClick={() => setConfirmAction('dispute')}
                className="px-2.5 py-1 rounded-lg text-xs border border-red-500/30 text-red-400/70 hover:bg-red-500/10 transition-colors">
                Dispute
              </button>
            </div>
          )}

          {/* Status 2 (Active), work submitted — client: Dispute + Release */}
          {dealMeta?.agreementStatus === 2 && dealContext.role === 'client' && dealMeta.markedDoneAt > 0n && (
            <div className="flex gap-1.5 flex-shrink-0">
              <button onClick={() => setConfirmAction('dispute')}
                className="px-2.5 py-1 rounded-lg text-xs border border-red-500/30 text-red-400/70 hover:bg-red-500/10 transition-colors">
                Dispute
              </button>
              <button onClick={() => setConfirmAction('release')}
                className="px-2.5 py-1 rounded-lg text-xs bg-emerald-600/80 text-white hover:bg-emerald-600 transition-colors font-medium">
                Release
              </button>
            </div>
          )}

          {/* Status 4 (Disputed) */}
          {dealMeta?.agreementStatus === 4 && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-red-500/10 border border-red-500/20 text-red-400/70 font-medium flex-shrink-0">
              In Arbitration
            </span>
          )}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto relative flex flex-col">
        <div className="flex-1" />
        <div className="px-4 py-5 space-y-1">

          {!isLoading && needsSetup && (
            <div className="flex flex-col items-center justify-center py-16 gap-4 px-4">
              <div className="w-full max-w-sm">
                <MessagingSetup />
              </div>
            </div>
          )}

          {isLoading && (
            <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
              <Loader2 className="w-5 h-5 animate-spin text-white/25" />
              <p className="text-white/40 text-sm">Loading messages…</p>
            </div>
          )}

          {!isLoading && error && (
            <div className="flex flex-col items-center justify-center py-24 gap-4 text-center px-4">
              <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                <MessageCircle className="w-5 h-5 text-amber-400/60" />
              </div>
              <div>
                <p className="text-white/70 text-sm font-semibold mb-1">
                  {error.includes('not set up') || error.includes('not registered')
                    ? "Recipient hasn't enabled messaging"
                    : 'Could not connect'}
                </p>
                <p className="text-white/35 text-xs max-w-xs leading-relaxed">
                  {error.includes('not set up') || error.includes('not registered')
                    ? 'Share your chat link — when they open it and connect, messaging activates.'
                    : error}
                </p>
              </div>
              {(error.includes('not set up') || error.includes('not registered')) && chatUrl && (
                <button onClick={copyInvite}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/8 transition-colors text-xs text-white/55">
                  {copied ? <><Check className="w-3.5 h-3.5 text-emerald-400" />Copied!</> : <><Copy className="w-3.5 h-3.5" />Copy invite link</>}
                </button>
              )}
            </div>
          )}

          {!isLoading && !error && messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
              <div className="w-12 h-12 rounded-2xl bg-white/[0.04] border border-white/8 flex items-center justify-center">
                <MessageCircle className="w-5 h-5 text-white/20" />
              </div>
              <p className="text-white/25 text-sm">No messages yet</p>
            </div>
          )}

          {!isLoading && !error && searchQuery && visibleMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-white/30 text-sm">No messages match &ldquo;{searchQuery}&rdquo;</p>
            </div>
          )}

          {!isLoading && !error && visibleMessages.map((msg, i) => {
            const isMe  = msg.from === address?.toLowerCase();
            const prev  = visibleMessages[i - 1];
            const next  = visibleMessages[i + 1];
            const isFirst = !prev || prev.from !== msg.from;
            const isLast  = !next || next.from !== msg.from;

            return (
              <div key={msg.id}
                className={`flex ${isMe ? 'justify-end' : 'justify-start'} ${isFirst && i > 0 ? 'mt-3' : ''} animate-in fade-in slide-in-from-bottom-1 duration-200`}>
                <div className={`group max-w-[75%] flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                  {msg.attachment
                    ? !msg.attachment.chunked && isImageMime(msg.attachment.mime)
                      ? <ImageBubble a={msg.attachment} isMe={isMe} />
                      : <FileCard a={msg.attachment} isMe={isMe} />
                    : (
                      <div className={`px-3.5 py-2 text-sm break-words leading-relaxed ${
                        isMe
                          ? `bg-primary text-white ${isFirst ? 'rounded-t-2xl' : 'rounded-tl-2xl rounded-tr-sm'} ${isLast ? 'rounded-bl-2xl rounded-br-sm' : 'rounded-l-2xl rounded-r-sm'}`
                          : `bg-white/10 text-white/90 ${isFirst ? 'rounded-t-2xl' : 'rounded-tr-2xl rounded-tl-sm'} ${isLast ? 'rounded-br-2xl rounded-bl-sm' : 'rounded-r-2xl rounded-l-sm'}`
                      }`}>
                        {msg.text}
                      </div>
                    )
                  }
                  {isLast && (
                    <span className="text-[10px] text-white/20 mt-0.5 px-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      {formatTime(msg.timestamp)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          <div ref={bottomRef} />
        </div>

        {!atBottom && (
          <div className="sticky bottom-4 flex justify-center">
            <button onClick={scrollToBottom}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 backdrop-blur border border-white/15 text-xs text-white/60 hover:bg-white/15 transition-colors shadow-lg">
              <ChevronDown className="w-3 h-3" />scroll down
            </button>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-white/[0.07] bg-[#0a0a0a] flex-shrink-0 px-3 pt-2.5 flex flex-col gap-1.5"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
        {uploadProgress !== null && <UploadProgress pct={uploadProgress} />}
        {uploadErr && <p className="text-xs text-red-400/70 px-1">{uploadErr}</p>}
        <div className="flex items-end gap-2">
          <input ref={fileRef} type="file" className="hidden" onChange={handleFileChange} />
          <button
            onClick={() => {
              if (!isInitialized || uploading) return;
              if (!window.confirm('Files are stored for 18 days, then permanently deleted. Encrypted end-to-end. Max 5 GB. Continue?')) return;
              fileRef.current?.click();
            }}
            disabled={!isInitialized || uploading}
            title="Attach file — available 18 days"
            className="w-9 h-9 rounded-xl flex items-center justify-center text-white/35 hover:text-white/65 hover:bg-white/5 disabled:opacity-25 disabled:cursor-not-allowed transition-colors flex-shrink-0 mb-0.5">
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
          </button>
          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!isInitialized}
            placeholder={
              isLoading     ? 'Connecting…'     :
              error         ? 'Chat unavailable' :
              isInitialized ? 'Message…'         : 'Initializing…'
            }
            className="flex-1 bg-white/[0.06] border border-white/10 rounded-xl px-4 py-2.5 text-base text-white placeholder:text-white/20 focus:outline-none focus:border-primary/35 focus:bg-white/8 disabled:opacity-40 transition-all resize-none overflow-hidden leading-[1.4]"
            style={{ minHeight: '40px', maxHeight: '120px' }}
          />
          <button
            onClick={handleSend}
            disabled={!isInitialized || !text.trim() || sending}
            className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center text-white hover:bg-primary/80 active:scale-95 disabled:opacity-25 disabled:cursor-not-allowed transition-all flex-shrink-0 mb-0.5">
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />}
          </button>
        </div>
      </div>

      {/* Pre-deal confirm modal */}
      {preDealConfirm && preDealCtx && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-zinc-900 border border-white/10 rounded-2xl p-5 w-full max-w-sm shadow-2xl">
            <h3 className="text-sm font-semibold text-white mb-2">
              {preDealConfirm === 'apply'           ? 'Apply for Job' :
               preDealConfirm === 'accept_deploy'   ? 'Accept & Deploy Agreement' :
               preDealConfirm === 'request_service' ? 'Request Service' :
               preDealConfirm === 'withdraw'        ? 'Withdraw Application' :
                                                      'Reject Application'}
            </h3>
            <p className="text-xs text-white/50 mb-5 leading-relaxed">
              {preDealConfirm === 'apply'
                ? 'Your application will be submitted to the client.'
                : preDealConfirm === 'accept_deploy'
                ? 'This will accept the applicant and deploy an escrow Agreement contract. Gas is covered.'
                : preDealConfirm === 'request_service'
                ? `A service request for ${formatUnits(preDealCtx.amount, 6)} USDC will be sent. The executor must accept to start.`
                : preDealConfirm === 'withdraw'
                ? 'Your application will be withdrawn. A message will be sent to the client.'
                : 'The application will be rejected. A message will be sent to the applicant.'}
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setPreDealConfirm(null)} disabled={preDealBusy}
                className="px-3.5 py-1.5 rounded-xl text-xs text-white/50 hover:text-white/70 border border-white/10 hover:bg-white/5 transition-colors disabled:opacity-40">
                Cancel
              </button>
              <button onClick={() => handlePreDealAction(preDealConfirm)} disabled={preDealBusy}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-medium text-white transition-colors disabled:opacity-40 flex items-center gap-1.5 ${
                  preDealConfirm === 'withdraw' || preDealConfirm === 'reject_app'
                    ? 'bg-red-600 hover:bg-red-500'
                    : 'bg-primary hover:bg-primary/80'
                }`}>
                {preDealBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm modal */}
      {confirmAction && dealContext && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-zinc-900 border border-white/10 rounded-2xl p-5 w-full max-w-sm shadow-2xl">
            <h3 className="text-sm font-semibold text-white mb-2">
              {confirmAction === 'accept'   ? 'Accept Deal' :
               confirmAction === 'reject'   ? 'Decline Job' :
               confirmAction === 'release'  ? 'Release Payment' :
               confirmAction === 'markDone' ? 'Submit Work' :
                                             'Raise Dispute'}
            </h3>
            <p className="text-xs text-white/50 mb-5 leading-relaxed">
              {confirmAction === 'accept'   ? 'This will activate the agreement. Funds are locked until you mark it done.' :
               confirmAction === 'reject'   ? 'You will decline this job request. A message will be sent to the client in chat.' :
               confirmAction === 'release'  ? `This will release ${formatUnits(dealContext.amount, 6)} USDC to the executor. This action is irreversible — verify the work before confirming.` :
               confirmAction === 'markDone' ? 'This marks the work as complete. The client will review and release payment.' :
                                             'This will freeze the deal and call an arbiter to review.'}
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmAction(null)} disabled={actionBusy}
                className="px-3.5 py-1.5 rounded-xl text-xs text-white/50 hover:text-white/70 border border-white/10 hover:bg-white/5 transition-colors disabled:opacity-40">
                Cancel
              </button>
              <button onClick={() => handleDealAction(confirmAction!)} disabled={actionBusy}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-medium text-white transition-colors disabled:opacity-40 flex items-center gap-1.5 ${
                  confirmAction === 'dispute' || confirmAction === 'reject'
                    ? 'bg-red-600 hover:bg-red-500'
                    : confirmAction === 'release'
                    ? 'bg-emerald-600 hover:bg-emerald-500'
                    : 'bg-primary hover:bg-primary/80'
                }`}>
                {actionBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
