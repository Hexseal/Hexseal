'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Send, Loader2, Lock, Paperclip, FileText, Download } from 'lucide-react';
import { useDealChat } from '@/hooks/useDealChat';
import type { ChatMessage } from '@/lib/xmtp';
import { decryptToObjectUrl, decryptAndSave } from '@/lib/fileCrypto';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isImageMime(mime?: string) {
  return mime?.startsWith('image/') ?? false;
}

// ─── Attachment: encrypted image ─────────────────────────────────────────────

function ImageBubble({ a, isMe }: { a: NonNullable<ChatMessage['attachment']>; isMe: boolean }) {
  const [src,        setSrc]        = useState<string | null>(null);
  const [decrypting, setDecrypting] = useState(false);
  const [decryptErr, setDecryptErr] = useState(false);
  const [lightbox,   setLightbox]   = useState(false);

  useEffect(() => {
    if (!a.key || !a.iv) { setSrc(a.url); return; }
    let active = true;
    setDecrypting(true);
    setDecryptErr(false);
    decryptToObjectUrl(a.url, a.key, a.iv, a.mime)
      .then((url) => { if (active) setSrc(url); })
      .catch(() => { if (active) setDecryptErr(true); })
      .finally(() => { if (active) setDecrypting(false); });
    return () => { active = false; };
  }, [a.url, a.key, a.iv, a.mime]);

  const rounded = isMe ? 'rounded-t-lg rounded-bl-lg rounded-br-sm' : 'rounded-t-lg rounded-br-lg rounded-bl-sm';

  if (decrypting) {
    return (
      <div className={`w-[200px] h-[120px] ${rounded} border border-white/10 bg-white/5 flex items-center justify-center gap-2`}>
        <Loader2 className="w-4 h-4 animate-spin text-white/30" />
        <span className="text-xs text-white/30">Decrypting…</span>
      </div>
    );
  }
  if (decryptErr || !src) {
    return (
      <div className={`w-[200px] h-[60px] ${rounded} border border-red-500/20 bg-red-500/5 flex items-center justify-center`}>
        <span className="text-xs text-red-400/60">Failed to decrypt</span>
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => setLightbox(true)}
        className={`block max-w-[260px] ${rounded} overflow-hidden border border-white/10 hover:border-white/20 transition-colors cursor-zoom-in`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={a.name} className="w-full h-auto object-cover max-h-60" />
      </button>
      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
          onClick={() => setLightbox(false)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={a.name} className="max-w-full max-h-full rounded-lg shadow-2xl" />
        </div>
      )}
    </>
  );
}

// ─── Attachment: encrypted file ───────────────────────────────────────────────

function FileCard({ a, isMe }: { a: NonNullable<ChatMessage['attachment']>; isMe: boolean }) {
  const [saving, setSaving] = useState(false);
  const [err,    setErr]    = useState(false);

  const handleDownload = async () => {
    if (saving) return;
    if (!a.key || !a.iv) { window.open(a.url, '_blank'); return; }
    setSaving(true);
    setErr(false);
    try {
      await decryptAndSave(a.url, a.key, a.iv, a.name, a.mime);
    } catch {
      setErr(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <button
      onClick={handleDownload}
      disabled={saving}
      className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border transition-colors group max-w-[260px] text-left ${
        isMe
          ? 'border-violet-400/30 bg-violet-700/40 hover:bg-violet-700/60 rounded-br-sm'
          : 'border-white/10 bg-white/5 hover:bg-white/10 rounded-bl-sm'
      } disabled:opacity-60`}
    >
      <div className="w-8 h-8 rounded bg-white/10 flex items-center justify-center flex-shrink-0">
        {saving
          ? <Loader2 className="w-4 h-4 animate-spin text-white/50" />
          : <FileText className="w-4 h-4 text-white/50" />
        }
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-white/85 truncate">{a.name}</p>
        <p className="text-[11px] text-white/35 mt-0.5">
          {err
            ? <span className="text-red-400/70">Decryption failed</span>
            : a.size != null
              ? formatBytes(a.size)
              : a.key ? 'Encrypted · click to save' : 'Click to open'
          }
        </p>
      </div>
      {a.key
        ? <Download className="w-3 h-3 text-white/30 group-hover:text-white/60 flex-shrink-0" />
        : <Download className="w-3 h-3 text-white/30 group-hover:text-white/60 flex-shrink-0" />
      }
    </button>
  );
}

// ─── Upload progress ──────────────────────────────────────────────────────────

function UploadProgress({ pct }: { pct: number }) {
  return (
    <div className="flex items-center gap-2 px-1 py-0.5">
      <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
        <div
          className="h-full bg-violet-500 rounded-full transition-all duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[11px] text-white/35 tabular-nums w-7 text-right">{pct}%</span>
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

type DealChatProps = {
  agreementAddress: string;
  client: string;
  executor: string;
  arbiter?: string;
  currentUser: string;
};

// ─── Component ────────────────────────────────────────────────────────────────

export function DealChat({
  agreementAddress,
  client,
  executor,
  arbiter,
  currentUser,
}: DealChatProps) {
  const {
    messages,
    sendMessage,
    sendFile,
    isLoading,
    isInitialized,
    isClosed,
    error,
    uploadProgress,
  } = useDealChat(agreementAddress);

  const [text,       setText]       = useState('');
  const [sending,    setSending]    = useState(false);
  const [uploading,  setUploading]  = useState(false);
  const [uploadErr,  setUploadErr]  = useState<string | null>(null);

  const fileRef   = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const participants = [client, executor, arbiter]
    .filter(Boolean)
    .map((a) => (a as string).toLowerCase());
  const isParticipant = participants.includes(currentUser.toLowerCase());

  if (!isParticipant) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-center text-sm text-red-400">
        Access denied: you are not a participant of this deal.
      </div>
    );
  }

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || isClosed) return;
    setSending(true);
    try {
      await sendMessage(trimmed);
      setText('');
    } catch (err: unknown) {
      console.error('[DealChat] send failed:', err);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || isClosed) return;
    e.target.value = '';
    setUploadErr(null);
    setUploading(true);
    try {
      await sendFile(file);
    } catch (err: unknown) {
      setUploadErr(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex flex-col rounded-xl border border-white/10 bg-[#0d0d0d] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-white/5">
        <span className="text-sm font-semibold text-white/80">Deal Chat</span>
        <div className="flex items-center gap-2">
          <Lock className="w-3 h-3 text-green-400" />
          <span className="text-xs text-green-400">E2E encrypted</span>
        </div>
      </div>

      {isClosed && (
        <div className="px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/20 text-yellow-400 text-xs text-center">
          Deal closed — chat is read-only
        </div>
      )}

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto min-h-[260px] max-h-[400px] p-4 space-y-2">
        {isLoading && (
          <div className="flex items-center justify-center h-full gap-2 text-white/40 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Connecting…
          </div>
        )}

        {!isLoading && error && (
          <div className="flex items-center justify-center h-full text-red-400 text-sm text-center px-4">
            {error}
          </div>
        )}

        {!isLoading && !error && messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-white/30 text-sm">
            No messages yet. Start the conversation.
          </div>
        )}

        {!isLoading && !error && messages.map((msg, i) => {
          const isMe = msg.from.toLowerCase() === currentUser.toLowerCase();
          const prev = messages[i - 1];
          const next = messages[i + 1];
          const isFirst = !prev || prev.from !== msg.from;
          const isLast  = !next || next.from !== msg.from;

          return (
            <div
              key={msg.id}
              className={`flex flex-col gap-0.5 ${isMe ? 'items-end' : 'items-start'} ${isFirst && i > 0 ? 'mt-3' : ''}`}
            >
              {msg.attachment
                ? isImageMime(msg.attachment.mime)
                  ? <ImageBubble a={msg.attachment} isMe={isMe} />
                  : <FileCard a={msg.attachment} isMe={isMe} />
                : (
                  <div
                    className={`max-w-[75%] px-3 py-2 text-sm break-words leading-relaxed ${
                      isMe
                        ? `bg-violet-600 text-white ${isFirst ? 'rounded-t-lg' : 'rounded-tl-lg rounded-tr-sm'} ${isLast ? 'rounded-bl-lg rounded-br-sm' : 'rounded-l-lg rounded-r-sm'}`
                        : `bg-white/10 text-white/90 ${isFirst ? 'rounded-t-lg' : 'rounded-tr-lg rounded-tl-sm'} ${isLast ? 'rounded-br-lg rounded-bl-sm' : 'rounded-r-lg rounded-l-sm'}`
                    }`}
                  >
                    {msg.text}
                  </div>
                )
              }
              {isLast && (
                <div className="flex items-center gap-2 px-0.5">
                  <span className="text-[10px] font-mono text-white/25">{shortAddr(msg.from)}</span>
                  <span className="text-[10px] text-white/20">{formatTime(msg.timestamp)}</span>
                </div>
              )}
            </div>
          );
        })}

        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="border-t border-white/10 p-3 space-y-1.5">
        {uploadProgress !== null && <UploadProgress pct={uploadProgress} />}
        {uploadErr && <p className="text-xs text-red-400 px-1">{uploadErr}</p>}
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" className="hidden" onChange={handleFileChange} />
          <button
            type="button"
            disabled={!isInitialized || uploading || isClosed}
            onClick={() => fileRef.current?.click()}
            title="Attach file (encrypted)"
            className="p-2 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex-shrink-0"
          >
            {uploading
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Paperclip className="w-4 h-4" />
            }
          </button>
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!isInitialized || sending || isClosed}
            placeholder={isClosed ? 'Deal closed' : isInitialized ? 'Type a message…' : 'Initializing…'}
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/25 focus:outline-none focus:ring-1 focus:ring-violet-500/60 disabled:opacity-40"
          />
          <button
            type="button"
            disabled={!isInitialized || !text.trim() || sending || isClosed}
            onClick={handleSend}
            className="p-2 rounded-lg bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex-shrink-0"
          >
            {sending
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Send className="w-4 h-4" />
            }
          </button>
        </div>
      </div>
    </div>
  );
}
