'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { useXmtp } from '@/contexts/XmtpContext';
import { getXmtpClientIfCached, listPairConversations, listPairConversationsLocal, type PairConversation } from '@/lib/xmtp';

function mergeWithLocalPeers(convos: PairConversation[], addr: string): PairConversation[] {
  const knownPeers = new Set(convos.map(c => c.peerAddress));
  const myLc = addr.toLowerCase();
  const merged = [...convos];
  const localKeys = Object.keys(localStorage).filter(k => k.startsWith('hexseal_chat_seen_'));
  for (const key of localKeys) {
    const peer = key.replace('hexseal_chat_seen_', '');
    if (peer !== myLc && !knownPeers.has(peer)) {
      merged.push({ group: null as any, peerAddress: peer, lastText: '', lastAt: 0, lastFromMe: true });
    }
  }
  return merged.sort((a, b) => b.lastAt - a.lastAt);
}

export function usePairConversations(isEnabled = false) {
  const { address } = useAccount();
  const { status } = useXmtp();
  const [conversations, setConversations] = useState<PairConversation[]>([]);
  const [isLoading, setIsLoading]         = useState(false);
  const [error, setError]                 = useState<string | null>(null);

  const addressRef = useRef(address);
  useEffect(() => { addressRef.current = address; });

  const load = useCallback(async () => {
    const addr = addressRef.current;
    if (!addr) return;
    // Use the already-initialized client — never trigger a new init here.
    // If status isn't 'ready', XmtpContext is still loading or disabled.
    const xmtp = getXmtpClientIfCached(addr);
    if (!xmtp) return;
    setIsLoading(true);
    setError(null);
    try {
      // Phase 1: read from local SQLite cache — no network, near-instant.
      // Shows conversations immediately so the UI never stares at a spinner.
      const local = await listPairConversationsLocal(xmtp, addr);
      setConversations(mergeWithLocalPeers(local, addr));
      setIsLoading(false);

      // Phase 2: full network sync in background — updates previews silently.
      const fresh = await listPairConversations(xmtp, addr);
      setConversations(mergeWithLocalPeers(fresh, addr));
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Failed to load conversations';
      const isLimit = raw.includes('10/10') || raw.includes('registered 10');
      setError(isLimit
        ? 'Too many active XMTP sessions (10/10). Visit xmtp.chat → Settings → Revoke installations, then reload.'
        : raw);
      setIsLoading(false);
    }
  }, []); // stable — reads address via ref

  // Load when client becomes ready or address changes.
  // status dep ensures we trigger when XmtpContext transitions loading → ready.
  useEffect(() => {
    if (address && isEnabled && status === 'ready') load();
  }, [address, isEnabled, status, load]);

  const ready = isEnabled && status === 'ready';

  // Auto-poll every 30s as fallback
  useEffect(() => {
    if (!address || !ready) return;
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [address, ready, load]);

  // Instant update when usePairChat notifies of a new incoming message
  useEffect(() => {
    if (!address || !ready) return;
    window.addEventListener('hexseal-conv-update', load);
    return () => window.removeEventListener('hexseal-conv-update', load);
  }, [address, ready, load]);

  // Re-sync immediately when the tab regains focus (stream may have gone stale)
  useEffect(() => {
    if (!address || !ready) return;
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [address, ready, load]);

  return { conversations, isLoading, error, reload: load };
}
