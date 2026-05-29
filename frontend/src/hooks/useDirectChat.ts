'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useWalletClient } from 'wagmi';
import { useXmtpStatus } from './useXmtpStatus';

const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL ?? 'http://localhost:3001';

function pushChatNotif(to: string, body: string, url: string) {
  fetch(`${RELAYER_URL}/push/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, title: 'New Message 💬', body, url }),
  }).catch(() => {});
}
import {
  initXmtpClient,
  toIdentifier,
  loadDmMessages,
  normalizeDmMessage,
  encodeFileMessage,
  type ChatMessage,
  type XmtpClient,
  type XmtpDm,
} from '@/lib/xmtp';
import { uploadFileWithEncryption } from '@/lib/fileStorage';

export type { ChatMessage as DirectMessage };

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useDirectChat(recipientAddress: string) {
  const { data: walletClient } = useWalletClient();
  const { isEnabled }          = useXmtpStatus();

  const [messages,        setMessages]        = useState<ChatMessage[]>([]);
  const [isLoading,       setIsLoading]       = useState(true);
  const [isInitialized,   setIsInitialized]   = useState(false);
  const [error,           setError]           = useState<string | null>(null);
  const [uploadProgress,  setUploadProgress]  = useState<number | null>(null);
  const [streamDead,      setStreamDead]      = useState(false);
  const [retryKey,        setRetryKey]        = useState(0);

  const clientRef       = useRef<XmtpClient | null>(null);
  const dmRef           = useRef<XmtpDm | null>(null);
  const streamRef       = useRef<{ return: () => void } | null>(null);
  const recipientRef    = useRef(recipientAddress);
  const oldestNsRef     = useRef<bigint | null>(null);
  const [hasMore, setHasMore] = useState(false);
  useEffect(() => { recipientRef.current = recipientAddress; }, [recipientAddress]);

  useEffect(() => {
    if (!walletClient || !recipientAddress) return;
    if (!isEnabled) { setIsLoading(false); return; }

    setStreamDead(false);
    let cancelled = false;

    async function init() {
      try {
        setIsLoading(true);
        setError(null);

        const myAddress = walletClient!.account?.address?.toLowerCase() ?? '';

        // 1. Init XMTP
        const xmtp = await initXmtpClient(walletClient!);
        if (cancelled) return;
        clientRef.current = xmtp;

        // 2. Check if recipient has XMTP identity
        const recipientId = toIdentifier(recipientAddress);
        const canMsg = await xmtp.canMessage([recipientId]);
        if (!canMsg.get(recipientId.identifier)) {
          throw new Error('This user has not set up XMTP messaging yet. They need to connect their wallet to a messaging-enabled app first.');
        }

        // 3. Find or create DM conversation
        let convSyncAttempt = 0;
        while (convSyncAttempt < 3) {
          try {
            await xmtp.conversations.sync();
            break;
          } catch (syncErr) {
            convSyncAttempt++;
            if (convSyncAttempt >= 3) throw syncErr;
            await sleep(1000 * convSyncAttempt);
          }
        }
        const dm = await xmtp.conversations.createDmWithIdentifier(recipientId);
        if (cancelled) return;
        dmRef.current = dm;
        let syncAttempt = 0;
        while (syncAttempt < 3) {
          try {
            await dm.sync();
            break;
          } catch (syncErr) {
            syncAttempt++;
            if (syncAttempt >= 3) throw syncErr;
            await sleep(1000 * syncAttempt);
          }
        }

        // 4. Load message history (newest 50)
        const { messages: history, hasMore: more, oldestNs } =
          await loadDmMessages(dm, xmtp.inboxId ?? '', myAddress, recipientAddress);
        if (cancelled) return;
        oldestNsRef.current = oldestNs;
        setHasMore(more);
        setMessages(history);

        // 5. Subscribe to new messages
        const stream = await dm.stream();
        streamRef.current = stream;

        const loop = async () => {
          let streamRetries = 0;
          while (!cancelled && streamRetries < 5) {
            try {
              for await (const msg of stream) {
                if (cancelled) return;
                const chat = normalizeDmMessage(msg, xmtp.inboxId ?? '', myAddress, recipientAddress);
                if (!chat) continue;
                setMessages((prev) => {
                  if (prev.some((m) => m.id === chat.id)) return prev;
                  if (chat.isFromMe) {
                    let optIdx = -1;
                    for (let i = prev.length - 1; i >= 0; i--) {
                      if (prev[i].id.startsWith('opt-') && prev[i].text === chat.text) { optIdx = i; break; }
                    }
                    if (optIdx >= 0) return prev.map((m, i) => i === optIdx ? chat : m);
                  }
                  // Notify conversation list to update immediately (only for incoming)
                  if (!chat.isFromMe) window.dispatchEvent(new Event('hexseal-conv-update'));
                  return [...prev, chat];
                });
              }
              break;
            } catch (streamErr) {
              streamRetries++;
              if (cancelled) return;
              console.warn('[useDirectChat] stream error, retry', streamRetries, streamErr);
              await sleep(2000 * streamRetries);
            }
          }
          // All retries exhausted — notify UI so user can manually reconnect
          if (!cancelled) setStreamDead(true);
        };
        loop();

        if (!cancelled) setIsInitialized(true);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to initialize chat');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    init();

    return () => {
      cancelled = true;
      streamRef.current?.return();
      streamRef.current = null;
    };
  }, [walletClient, recipientAddress, isEnabled, retryKey]);

  // ── Re-sync on window focus (stream may have gone stale in background) ───
  useEffect(() => {
    const onFocus = async () => {
      const xmtp = clientRef.current;
      const dm   = dmRef.current;
      if (!xmtp || !dm || !isInitialized) return;
      try {
        await dm.sync();
        const myAddress = xmtp.accountIdentifier?.identifier?.toLowerCase() ?? '';
        const { messages: fresh } = await loadDmMessages(
          dm, xmtp.inboxId ?? '', myAddress, recipientRef.current,
        );
        setMessages(prev => {
          // Only append genuinely new messages — never rebuild from scratch.
          // Returning the same `prev` reference tells React nothing changed → no re-render,
          // no DOM thrash, no scroll-position jump.
          const knownIds = new Set(prev.map(m => m.id));
          const newMsgs = fresh.filter(m => !knownIds.has(m.id));
          if (newMsgs.length === 0) return prev; // ← same ref, React bails out entirely
          const confirmed = prev.filter(m => !m.id.startsWith('opt-'));
          const optimistic = prev.filter(m => m.id.startsWith('opt-'));
          return [...confirmed, ...newMsgs, ...optimistic];
        });
      } catch { /* silent — stream will self-recover */ }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [isInitialized]);

  // ── Load older messages ───────────────────────────────────────────────────
  const loadMore = useCallback(async () => {
    const xmtp = clientRef.current;
    const dm   = dmRef.current;
    if (!xmtp || !dm || !oldestNsRef.current) return;
    const myAddress = xmtp.accountIdentifier?.identifier?.toLowerCase() ?? '';
    try {
      const { messages: older, hasMore: more, oldestNs } =
        await loadDmMessages(dm, xmtp.inboxId ?? '', myAddress, recipientRef.current, oldestNsRef.current);
      if (older.length > 0) {
        oldestNsRef.current = oldestNs;
        setMessages(prev => [...older, ...prev]);
      }
      setHasMore(more && older.length > 0);
    } catch (err) {
      console.warn('[useDirectChat] loadMore failed:', err);
    }
  }, []);

  // ── Send message ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (text: string) => {
    const xmtp = clientRef.current;
    const dm   = dmRef.current;
    if (!xmtp || !dm) throw new Error('Chat not initialized');

    const myAddress = xmtp.accountIdentifier?.identifier?.toLowerCase() ?? '';
    setMessages((prev) => [...prev, { id: `opt-${Date.now()}`, from: myAddress, text, timestamp: Date.now(), isFromMe: true }]);
    await dm.sendText(text);
    pushChatNotif(recipientRef.current, text.length > 80 ? text.slice(0, 80) + '…' : text, '/chat');
  }, []);

  // ── Send file (encrypt → upload → XMTP) ──────────────────────────────────
  const sendFile = useCallback(async (file: File, signal?: AbortSignal) => {
    const xmtp = clientRef.current;
    const dm   = dmRef.current;
    if (!xmtp || !dm) throw new Error('Chat not initialized');

    const myAddress = xmtp.accountIdentifier?.identifier?.toLowerCase() ?? '';

    setUploadProgress(0);
    let result: Awaited<ReturnType<typeof uploadFileWithEncryption>>;
    try {
      result = await uploadFileWithEncryption(file, file.name, setUploadProgress, signal);
    } finally {
      setUploadProgress(null);
    }

    signal?.throwIfAborted();

    const { url, storjKey, keyHex, ivHex, chunked, chunkCount, chunkSize } = result;
    const chunkedOpts = chunked && chunkCount && chunkSize
      ? { chunked: true as const, chunkCount, chunkSize }
      : undefined;

    const encoded = encodeFileMessage(file.name, url, file.size, file.type || undefined, keyHex, ivHex, chunkedOpts, storjKey);
    setMessages((prev) => [...prev, {
      id: `opt-${Date.now()}`,
      from: myAddress,
      text: file.name,
      attachment: { name: file.name, url, storjKey, size: file.size, mime: file.type || undefined, key: keyHex, iv: ivHex, ...chunkedOpts },
      timestamp: Date.now(),
      isFromMe: true,
    }]);

    await dm.sendText(encoded);
    pushChatNotif(recipientRef.current, `📎 ${file.name}`, '/chat');
  }, []);

  const reconnect = useCallback(() => {
    setIsLoading(true);
    setIsInitialized(false);
    setMessages([]);
    clientRef.current = null;
    dmRef.current = null;
    setRetryKey(k => k + 1);
  }, []);

  return { messages, sendMessage, sendFile, loadMore, hasMore, isLoading, isInitialized, error, uploadProgress, streamDead, reconnect, needsSetup: !isEnabled };
}
