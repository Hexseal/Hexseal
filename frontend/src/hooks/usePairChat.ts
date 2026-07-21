'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useWalletClient, useAccount } from 'wagmi';
import { useXmtp } from '@/contexts/XmtpContext';
import {
  getXmtpClientIfCached,
  findOrCreatePairGroup,
  loadGroupMessages,
  normalizeGroupMessage,
  buildInboxAddressMap,
  encodeFileMessage,
  encodeDealContextMarker,
  getBotAddress,
  readReceiptTimestampMs,
  xmtpCrumb,
  type ChatMessage,
  type XmtpClient,
  type XmtpGroup,
} from '@/lib/xmtp';
import { uploadFileWithEncryption } from '@/lib/fileStorage';
import { notifyPush } from '@/lib/webpush';

// Module-level cache — survives navigation (same as board/conversation-list pattern).
// Keyed by peerAddress lowercase → last confirmed (non-optimistic) messages.
const _msgCache = new Map<string, ChatMessage[]>();

export function usePairChat(peerAddress: string) {
  const { data: walletClient } = useWalletClient();
  const { address } = useAccount();
  const { status } = useXmtp();

  const peerLc = peerAddress.toLowerCase();

  const [messages, setMessages]             = useState<ChatMessage[]>(() => _msgCache.get(peerLc) ?? []);
  // Skip the loading screen if we already have cached messages — show them
  // instantly (SWR pattern) while the effect quietly re-syncs in the background.
  const [isLoading, setIsLoading]           = useState(() => (_msgCache.get(peerLc) ?? []).length === 0);
  const [isInitialized, setIsInitialized]   = useState(() => (_msgCache.get(peerLc) ?? []).length > 0);
  const [error, setError]                   = useState<string | null>(null);
  const [hasMore, setHasMore]               = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [streamDead, setStreamDead]         = useState(false);
  const [retryKey, setRetryKey]             = useState(0);
  // Latest read-receipt timestamp (ms) the peer has sent us — any of our own
  // messages at or before this time are "read" (2 checks); after it, just "sent".
  // Persisted in localStorage: read status is monotonic ("read" never becomes
  // "unread"), and MLS forward-secrecy can make the peer's read-receipt
  // undecryptable when re-reading history on reload (SecretReuseError / "secret
  // deleted to preserve forward secrecy"). Seeding from the cache and only ever
  // increasing keeps the "read" tick from reverting to a single tick on reload.
  const peerReadKey = `hexseal_peerread_${peerLc}`;
  const [peerLastReadAt, setPeerLastReadAt] = useState<number | null>(() => {
    try { const v = localStorage.getItem(peerReadKey); return v ? Number(v) : null; }
    catch { return null; }
  });
  const bumpPeerRead = (ms: number | null | undefined) => {
    if (ms == null) return;
    setPeerLastReadAt(prev => {
      const next = prev == null ? ms : Math.max(prev, ms);
      try { localStorage.setItem(peerReadKey, String(next)); } catch { /* unavailable */ }
      return next;
    });
  };

  const clientRef         = useRef<XmtpClient | null>(null);
  const groupRef          = useRef<XmtpGroup | null>(null);
  const oldestNsRef       = useRef<bigint | null>(null);
  const peerRef           = useRef(peerAddress);
  const streamRef         = useRef<{ return: () => void } | null>(null);
  const autoReconnectRef  = useRef(false);
  useEffect(() => { peerRef.current = peerAddress; }, [peerAddress]);

  useEffect(() => {
    if (!walletClient || !peerAddress || status !== 'ready') { setIsLoading(false); return; }

    let cancelled = false;
    autoReconnectRef.current = false;
    setStreamDead(false);
    // If we have cached messages, don't show the loading screen — silently re-sync.
    if (!_msgCache.has(peerLc)) setIsLoading(true);
    setError(null);

    (async () => {
      try {
        const myAddress = walletClient!.account?.address?.toLowerCase() ?? '';
        // status === 'ready' guarantees the client is in cache — no need to re-init.
        const xmtp = getXmtpClientIfCached(myAddress);
        if (!xmtp) { setError('Messaging not initialized'); setIsLoading(false); return; }
        if (cancelled) return;
        clientRef.current = xmtp;

        const botAddr = await getBotAddress();
        const group = await findOrCreatePairGroup(xmtp, [myAddress, peerAddress], botAddr);
        if (cancelled) return;
        groupRef.current = group;

        // Sync group state from network before loading messages.
        // Fetches missing identity updates and resolves MLS install diffs.
        try { await group.sync(); } catch { /* non-critical */ }
        if (cancelled) return;

        const loaded = await loadGroupMessages(group, xmtp.inboxId ?? '', myAddress);
        if (cancelled) return;
        _msgCache.set(peerLc, loaded.messages);
        setMessages(loaded.messages);
        setHasMore(loaded.hasMore);
        bumpPeerRead(loaded.peerLastReadAt);
        xmtpCrumb(`rr:load peerLastReadAt=${loaded.peerLastReadAt ?? 'null'}`);
        oldestNsRef.current = loaded.oldestNs;
        setIsInitialized(true);
        setIsLoading(false);

        // Opening the conversation counts as reading whatever the peer already
        // sent — best-effort, never blocks rendering.
        if (loaded.messages.some(m => !m.isFromMe)) {
          group.sendReadReceipt()
            .then(() => xmtpCrumb('rr:send-ok open'))
            .catch(e => xmtpCrumb(`rr:send-FAIL open ${e instanceof Error ? e.message.slice(0, 40) : e}`));
        }

        const stream = await group.stream();
        streamRef.current = stream as unknown as { return: () => void };
        const inboxToAddr = buildInboxAddressMap(await group.members());
        for await (const msg of stream) {
          if (cancelled) break;

          // Read receipts aren't chat messages — they update peerLastReadAt
          // (for our own sent messages' check marks) and never render.
          const readMs = readReceiptTimestampMs(msg, xmtp.inboxId ?? '');
          if (readMs !== null) {
            xmtpCrumb(`rr:recv ${readMs}`);
            bumpPeerRead(readMs);
            continue;
          }

          const norm = normalizeGroupMessage(msg, xmtp.inboxId ?? '', myAddress, inboxToAddr);
          if (!norm) continue;
          setMessages(prev => {
            if (prev.some(m => m.id === norm.id)) return prev;
            let next: ChatMessage[];
            if (norm.isFromMe) {
              let optIdx = -1;
              for (let i = prev.length - 1; i >= 0; i--) {
                if (prev[i].id.startsWith('opt-') && prev[i].text === norm.text) { optIdx = i; break; }
              }
              next = optIdx >= 0 ? prev.map((m, i) => i === optIdx ? norm : m) : [...prev, norm];
            } else {
              // Notify the sidebar to refresh immediately (only for incoming messages)
              window.dispatchEvent(new Event('hexseal-conv-update'));
              // The chat panel is open and just received this — mark it read.
              group.sendReadReceipt()
                .then(() => xmtpCrumb('rr:send-ok inbound'))
                .catch(e => xmtpCrumb(`rr:send-FAIL inbound ${e instanceof Error ? e.message.slice(0, 40) : e}`));
              next = [...prev, norm];
            }
            // Keep module-level cache current (exclude optimistic placeholders)
            _msgCache.set(peerLc, next.filter(m => !m.id.startsWith('opt-')));
            return next;
          });
        }
        // Stream ended (network drop, VPN reconnect, server timeout).
        // Auto-reconnect once after 3s. If it fails again → show manual banner.
        if (!cancelled) {
          if (!autoReconnectRef.current) {
            autoReconnectRef.current = true;
            setTimeout(() => { if (!cancelled) setRetryKey(k => k + 1); }, 3_000);
          } else {
            setStreamDead(true);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Chat error');
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      streamRef.current?.return();
      streamRef.current = null;
    };
  }, [walletClient, peerAddress, status, retryKey]);

  const loadMore = useCallback(async () => {
    const group = groupRef.current;
    const xmtp  = clientRef.current;
    if (!group || !xmtp || !oldestNsRef.current) return;
    const myAddress = xmtp.accountIdentifier?.identifier?.toLowerCase() ?? '';
    const loaded = await loadGroupMessages(group, xmtp.inboxId ?? '', myAddress, oldestNsRef.current);
    oldestNsRef.current = loaded.oldestNs;
    setHasMore(loaded.hasMore);
    setMessages(prev => [...loaded.messages, ...prev]);
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    const group = groupRef.current;
    const xmtp  = clientRef.current;
    if (!group || !text.trim()) return;
    const myAddress = xmtp?.accountIdentifier?.identifier?.toLowerCase() ?? '';
    const optId = `opt-${Date.now()}`;
    setMessages(prev => [...prev, {
      id: optId, from: myAddress, text: text.trim(),
      timestamp: Date.now(), isFromMe: true,
    }]);
    try {
      await group.sendText(text.trim());
      notifyPush(peerRef.current, text.trim(), `/chat?peer=${address?.toLowerCase() ?? ''}`, `/chat?peer=${peerRef.current.toLowerCase()}`);
    } catch (err) {
      // Remove the optimistic message so user knows the send failed
      setMessages(prev => prev.filter(m => m.id !== optId));
      throw err;
    }
  }, [address]);

  const sendFile = useCallback(async (file: File, signal?: AbortSignal) => {
    const group = groupRef.current;
    const xmtp  = clientRef.current;
    if (!group) return;
    const myAddress = xmtp?.accountIdentifier?.identifier?.toLowerCase() ?? '';

    setUploadProgress(0);
    let result: Awaited<ReturnType<typeof uploadFileWithEncryption>>;
    try {
      result = await uploadFileWithEncryption(file, file.name, setUploadProgress, signal, address ? { self: address, peer: peerRef.current } : undefined);
    } finally {
      setUploadProgress(null);
    }
    signal?.throwIfAborted();

    const { url, fileKey, keyHex, ivHex, chunked, chunkCount, chunkSize } = result;
    const chunkedOpts = chunked && chunkCount && chunkSize
      ? { chunked: true as const, chunkCount, chunkSize }
      : undefined;
    const encoded = encodeFileMessage(file.name, url, file.size, file.type || undefined, keyHex, ivHex, chunkedOpts, fileKey);

    setMessages(prev => [...prev, {
      id: `opt-${Date.now()}`, from: myAddress, text: file.name,
      attachment: { name: file.name, url, fileKey, size: file.size, mime: file.type || undefined, key: keyHex, iv: ivHex, ...chunkedOpts },
      timestamp: Date.now(), isFromMe: true,
    }]);

    await group.sendText(encoded);
    notifyPush(peerRef.current, `📎 ${file.name}`, `/chat?peer=${address?.toLowerCase() ?? ''}`, `/chat?peer=${peerRef.current.toLowerCase()}`);
  }, [address]);

  const markDealContext = useCallback(async (dealId: string | null) => {
    const group = groupRef.current;
    if (!group) return;
    try { await group.sendText(encodeDealContextMarker(dealId)); } catch { /* best-effort */ }
  }, []);

  const reconnect = useCallback(() => {
    setStreamDead(false);
    setIsInitialized(false);
    // Keep cached messages visible during reconnect — no jarring blank screen
    if (!_msgCache.has(peerLc)) {
      setIsLoading(true);
      setMessages([]);
    }
    setRetryKey(k => k + 1);
  }, [peerLc]);

  return {
    messages, sendMessage, sendFile, loadMore, markDealContext,
    hasMore, isLoading, isInitialized, error, uploadProgress,
    streamDead, reconnect, needsSetup: status !== 'ready', peerLastReadAt,
  };
}
