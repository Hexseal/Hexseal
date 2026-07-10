'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import { initXmtpClient, listPairConversations, type PairConversation } from '@/lib/xmtp';

export function usePairConversations(isEnabled = false) {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const [conversations, setConversations] = useState<PairConversation[]>([]);
  const [isLoading, setIsLoading]         = useState(false);
  const [error, setError]                 = useState<string | null>(null);

  // Keep the latest values in refs — avoids recreating `load` (and re-triggering
  // the effect) every time wagmi returns a new object reference.
  const walletClientRef = useRef(walletClient);
  useEffect(() => { walletClientRef.current = walletClient; });
  const addressRef = useRef(address);
  useEffect(() => { addressRef.current = address; });

  const load = useCallback(async () => {
    const wc = walletClientRef.current;
    const addr = addressRef.current;
    if (!wc || !addr) return;
    setIsLoading(true);
    setError(null);
    try {
      const xmtp   = await initXmtpClient(wc);
      const convos = await listPairConversations(xmtp, addr);

      // Merge with locally-persisted peers so chats that dropped from XMTP
      // sync (rare race, stale cache, new install) remain accessible.
      const knownPeers = new Set(convos.map(c => c.peerAddress));
      const myLc = addr.toLowerCase();
      const localKeys = Object.keys(localStorage).filter(k => k.startsWith('hexseal_chat_seen_'));
      for (const key of localKeys) {
        const peer = key.replace('hexseal_chat_seen_', '');
        if (peer !== myLc && !knownPeers.has(peer)) {
          convos.push({ group: null as any, peerAddress: peer, lastText: '', lastAt: 0, lastFromMe: true });
        }
      }

      setConversations(convos.sort((a, b) => b.lastAt - a.lastAt));
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Failed to load conversations';
      const isLimit = raw.includes('10/10') || raw.includes('registered 10');
      setError(isLimit
        ? 'Too many active XMTP sessions (10/10). Visit xmtp.chat → Settings → Revoke installations, then reload.'
        : raw);
    } finally {
      setIsLoading(false);
    }
  }, []); // stable — reads wallet/address via refs

  // Reload when wallet address changes (connect / switch wallet).
  useEffect(() => {
    if (address && isEnabled) load();
  }, [address, isEnabled, load]);

  // Auto-poll every 30s as fallback
  useEffect(() => {
    if (!address || !isEnabled) return;
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [address, isEnabled, load]);

  // Instant update when usePairChat notifies of a new incoming message
  useEffect(() => {
    if (!address || !isEnabled) return;
    window.addEventListener('hexseal-conv-update', load);
    return () => window.removeEventListener('hexseal-conv-update', load);
  }, [address, isEnabled, load]);

  // Re-sync immediately when the tab regains focus (stream may have gone stale)
  useEffect(() => {
    if (!address || !isEnabled) return;
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [address, isEnabled, load]);

  return { conversations, isLoading, error, reload: load };
}
