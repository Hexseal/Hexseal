'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAccount } from 'wagmi';
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
// Keyed by `${myAddressLc}:${peerAddressLc}` — NOT peer-only. A bare peer key let one
// wallet account's real, decrypted message content (and its isFromMe bit, computed
// for the WRONG account) render under a different account after a same-device wallet
// switch, until the reload effect below finished — a genuine cross-account leak.
const _msgCache = new Map<string, ChatMessage[]>();

export function usePairChat(peerAddress: string) {
  const { address } = useAccount();
  const { status } = useXmtp();

  const peerLc = peerAddress.toLowerCase();
  const myLc = address?.toLowerCase() ?? '';
  const pairKey = `${myLc}:${peerLc}`;

  const [messages, setMessages]             = useState<ChatMessage[]>(() => _msgCache.get(pairKey) ?? []);
  // Skip the loading screen if we already have cached messages — show them
  // instantly (SWR pattern) while the effect quietly re-syncs in the background.
  const [isLoading, setIsLoading]           = useState(() => (_msgCache.get(pairKey) ?? []).length === 0);
  const [isInitialized, setIsInitialized]   = useState(() => (_msgCache.get(pairKey) ?? []).length > 0);
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
  // Scoped by `${myLc}:${peerLc}` for the same reason as _msgCache above.
  const peerReadKey = `hexseal_peerread_${pairKey}`;
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
  const pairKeyRef        = useRef(pairKey);
  useEffect(() => { peerRef.current = peerAddress; }, [peerAddress]);

  useEffect(() => {
    if (!address || !peerAddress || status !== 'ready') { setIsLoading(false); return; }

    let cancelled = false;
    autoReconnectRef.current = false;
    setStreamDead(false);

    // Reset synchronously (before any async work) whenever the (my address, peer)
    // pair actually changed — e.g. a same-device wallet-account switch while this
    // chat stayed open (chat/page.tsx keys its wrapper by peer only, not by
    // address, so this hook instance survives the switch). Without this, the
    // PREVIOUS pair's messages/read-state keep rendering — under the NEW
    // account's identity — until the reload below resolves.
    if (pairKeyRef.current !== pairKey) {
      pairKeyRef.current = pairKey;
      const cached = _msgCache.get(pairKey) ?? [];
      setMessages(cached);
      setIsInitialized(cached.length > 0);
      try {
        const v = localStorage.getItem(peerReadKey);
        setPeerLastReadAt(v ? Number(v) : null);
      } catch { setPeerLastReadAt(null); }
      // Also drop the OLD pair's group/client refs so a send() that somehow fires
      // in the brief window before the reload below resolves can't go out through
      // the previous account's XMTP client/group — sendMessage/sendFile's `if
      // (!group)` path rebuilds a fresh one for the new pair.
      groupRef.current = null;
      clientRef.current = null;
      oldestNsRef.current = null;
    }

    // If we have cached messages, don't show the loading screen — silently re-sync.
    if (!_msgCache.has(pairKey)) setIsLoading(true);
    setError(null);

    (async () => {
      try {
        const myAddress = address.toLowerCase();
        // status === 'ready' guarantees the client is in cache — no need to re-init.
        const xmtp = getXmtpClientIfCached(myAddress);
        if (!xmtp) { setError('Messaging not initialized'); setIsLoading(false); return; }
        if (cancelled) return;
        clientRef.current = xmtp;

        const botAddr = await getBotAddress();
        // Look up only — the group is created on the first send (see sendMessage).
        const group = await findOrCreatePairGroup(xmtp, [myAddress, peerAddress], botAddr, false);
        if (cancelled) return;
        groupRef.current = group;

        if (!group) {
          // No conversation exists yet. Render an empty but fully usable thread so
          // the user can type; sending is what actually creates the group.
          _msgCache.set(pairKey, []);
          setMessages([]);
          setHasMore(false);
          setIsInitialized(true);
          setIsLoading(false);
          return;
        }

        // Sync group state from network before loading messages.
        // Fetches missing identity updates and resolves MLS install diffs.
        try { await group.sync(); } catch { /* non-critical */ }
        if (cancelled) return;

        const loaded = await loadGroupMessages(group, xmtp.inboxId ?? '', myAddress);
        if (cancelled) return;
        _msgCache.set(pairKey, loaded.messages);
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
            _msgCache.set(pairKey, next.filter(m => !m.id.startsWith('opt-')));
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
  // address (not walletClient): walletClient's object reference can change mid-session
  // for reasons unrelated to any user action (wallet reconnect, chain re-sync, etc — the
  // same reference-churn class fixed in providers.tsx's PushAutoMount and guarded against
  // in XmtpContext's triedRef) — keying on it here tore down and rebuilt the whole open
  // chat (killed the live stream, reloaded the full message history, sent a duplicate
  // read receipt) whenever that happened, even though status stayed 'ready' throughout.
  // address is the only thing this effect actually derives from walletClient, and it's
  // a stable string that only changes when the connected account itself changes.
  }, [address, peerAddress, status, retryKey]);

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
    const xmtp = clientRef.current;
    if (!text.trim()) return;
    const myAddress = xmtp?.accountIdentifier?.identifier?.toLowerCase() ?? '';
    const optId = `opt-${Date.now()}`;
    setMessages(prev => [...prev, {
      id: optId, from: myAddress, text: text.trim(),
      timestamp: Date.now(), isFromMe: true,
    }]);
    try {
      let group = groupRef.current;
      let created = false;
      // Lazy creation: the MLS group is made on the FIRST send, not on open. If the
      // peer never enabled XMTP, that surfaces here (ChatPanel matches the message to
      // show the "share an invite" UI) instead of blocking the chat from opening.
      if (!group) {
        if (!xmtp) throw new Error('Messaging not initialized');
        const botAddr = await getBotAddress();
        group = await findOrCreatePairGroup(xmtp, [myAddress, peerRef.current], botAddr, true);
        if (!group) throw new Error('Could not start the conversation');
        groupRef.current = group;
        created = true;
      }
      await group.sendText(text.trim());
      notifyPush(peerRef.current, text.trim(), `/chat?peer=${address?.toLowerCase() ?? ''}`, `/chat?peer=${peerRef.current.toLowerCase()}`);
      // Re-run the open effect so the brand-new group gets its message stream.
      if (created) setRetryKey(k => k + 1);
    } catch (err) {
      // Remove the optimistic message so user knows the send failed
      setMessages(prev => prev.filter(m => m.id !== optId));
      throw err;
    }
  }, [address]);

  const sendFile = useCallback(async (file: File, signal?: AbortSignal) => {
    const xmtp = clientRef.current;
    const myAddress = xmtp?.accountIdentifier?.identifier?.toLowerCase() ?? '';

    // Lazy creation, same as sendMessage — done BEFORE the upload so an unreachable
    // peer fails fast instead of after a pointless multi-MB upload.
    let group = groupRef.current;
    let created = false;
    if (!group) {
      if (!xmtp) throw new Error('Messaging not initialized');
      const botAddr = await getBotAddress();
      group = await findOrCreatePairGroup(xmtp, [myAddress, peerRef.current], botAddr, true);
      if (!group) throw new Error('Could not start the conversation');
      groupRef.current = group;
      created = true;
    }

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
    // Re-run the open effect so the brand-new group gets its message stream.
    if (created) setRetryKey(k => k + 1);
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
    if (!_msgCache.has(pairKey)) {
      setIsLoading(true);
      setMessages([]);
    }
    setRetryKey(k => k + 1);
  }, [pairKey]);

  return {
    messages, sendMessage, sendFile, loadMore, markDealContext,
    hasMore, isLoading, isInitialized, error, uploadProgress,
    streamDead, reconnect, needsSetup: status !== 'ready', peerLastReadAt,
  };
}
