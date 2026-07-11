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
  type ChatMessage,
  type XmtpClient,
  type XmtpGroup,
} from '@/lib/xmtp';
import { uploadFileWithEncryption } from '@/lib/fileStorage';

function pushChatNotif(to: string, body: string, url: string) {
  // Routed through Next.js API so the relayer secret never reaches the browser.
  // `from` is not forwarded — the server drops it to prevent notification impersonation.
  fetch('/api/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, body, url, tag: `/chat?peer=${to.toLowerCase()}` }),
  }).catch(() => {});
}

export function usePairChat(peerAddress: string) {
  const { data: walletClient } = useWalletClient();
  const { address } = useAccount();
  const { status } = useXmtp();

  const [messages, setMessages]             = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading]           = useState(true);
  const [isInitialized, setIsInitialized]   = useState(false);
  const [error, setError]                   = useState<string | null>(null);
  const [hasMore, setHasMore]               = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [streamDead, setStreamDead]         = useState(false);
  const [retryKey, setRetryKey]             = useState(0);

  const clientRef    = useRef<XmtpClient | null>(null);
  const groupRef      = useRef<XmtpGroup | null>(null);
  const oldestNsRef   = useRef<bigint | null>(null);
  const peerRef       = useRef(peerAddress);
  useEffect(() => { peerRef.current = peerAddress; }, [peerAddress]);

  useEffect(() => {
    if (!walletClient || !peerAddress || status !== 'ready') { setIsLoading(false); return; }

    let cancelled = false;
    setStreamDead(false);
    setIsLoading(true);
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

        const loaded = await loadGroupMessages(group, xmtp.inboxId ?? '', myAddress);
        if (cancelled) return;
        setMessages(loaded.messages);
        setHasMore(loaded.hasMore);
        oldestNsRef.current = loaded.oldestNs;
        setIsInitialized(true);
        setIsLoading(false);

        const stream = await group.stream();
        const inboxToAddr = buildInboxAddressMap(await group.members());
        for await (const msg of stream) {
          if (cancelled) break;
          const norm = normalizeGroupMessage(msg, xmtp.inboxId ?? '', myAddress, inboxToAddr);
          if (!norm) continue;
          setMessages(prev => {
            if (prev.some(m => m.id === norm.id)) return prev;
            if (norm.isFromMe) {
              let optIdx = -1;
              for (let i = prev.length - 1; i >= 0; i--) {
                if (prev[i].id.startsWith('opt-') && prev[i].text === norm.text) { optIdx = i; break; }
              }
              if (optIdx >= 0) return prev.map((m, i) => i === optIdx ? norm : m);
            } else {
              // Notify the sidebar to refresh immediately (only for incoming messages)
              window.dispatchEvent(new Event('hexseal-conv-update'));
            }
            return [...prev, norm];
          });
        }
        if (!cancelled) setStreamDead(true);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Chat error');
          setIsLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
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
    setMessages(prev => [...prev, {
      id: `opt-${Date.now()}`, from: myAddress, text: text.trim(),
      timestamp: Date.now(), isFromMe: true,
    }]);
    await group.sendText(text.trim());
    pushChatNotif(peerRef.current, text.trim(), `/chat?peer=${address?.toLowerCase() ?? ''}`);
  }, [address]);

  const sendFile = useCallback(async (file: File, signal?: AbortSignal) => {
    const group = groupRef.current;
    const xmtp  = clientRef.current;
    if (!group) return;
    const myAddress = xmtp?.accountIdentifier?.identifier?.toLowerCase() ?? '';

    setUploadProgress(0);
    let result: Awaited<ReturnType<typeof uploadFileWithEncryption>>;
    try {
      result = await uploadFileWithEncryption(file, file.name, setUploadProgress, signal);
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
    pushChatNotif(peerRef.current, `📎 ${file.name}`, `/chat?peer=${address?.toLowerCase() ?? ''}`);
  }, [address]);

  const markDealContext = useCallback(async (dealId: string | null) => {
    const group = groupRef.current;
    if (!group) return;
    try { await group.sendText(encodeDealContextMarker(dealId)); } catch { /* best-effort */ }
  }, []);

  const reconnect = useCallback(() => {
    setStreamDead(false);
    setIsInitialized(false);
    setIsLoading(true);
    setMessages([]);
    setRetryKey(k => k + 1);
  }, []);

  return {
    messages, sendMessage, sendFile, loadMore, markDealContext,
    hasMore, isLoading, isInitialized, error, uploadProgress,
    streamDead, reconnect, needsSetup: status !== 'ready',
  };
}
