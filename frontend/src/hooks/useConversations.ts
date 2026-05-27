'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import { initXmtpClient, listDmConversations, type DmConversation } from '@/lib/xmtp';

export function useConversations() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const [conversations, setConversations] = useState<DmConversation[]>([]);
  const [isLoading, setIsLoading]         = useState(false);
  const [error, setError]                 = useState<string | null>(null);

  // Keep the latest walletClient in a ref — avoids recreating `load` (and
  // re-triggering the effect) every time wagmi returns a new object reference.
  const walletClientRef = useRef(walletClient);
  useEffect(() => { walletClientRef.current = walletClient; });

  const load = useCallback(async () => {
    const wc = walletClientRef.current;
    if (!wc) return;
    setIsLoading(true);
    setError(null);
    try {
      const xmtp   = await initXmtpClient(wc);
      const convos = await listDmConversations(xmtp);
      setConversations(convos);
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Failed to load conversations';
      const isLimit = raw.includes('10/10') || raw.includes('registered 10');
      setError(isLimit
        ? 'Too many active XMTP sessions (10/10). Visit xmtp.chat → Settings → Revoke installations, then reload.'
        : raw);
    } finally {
      setIsLoading(false);
    }
  }, []); // stable — reads walletClient via ref

  // Reload when wallet address changes (connect / switch wallet)
  useEffect(() => {
    if (address) load();
  }, [address, load]);

  // Auto-poll every 30 s to pick up new messages in the sidebar
  useEffect(() => {
    if (!address) return;
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [address, load]);

  // Re-sync immediately when the tab regains focus (stream may have gone stale)
  useEffect(() => {
    if (!address) return;
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [address, load]);

  return { conversations, isLoading, error, reload: load };
}
