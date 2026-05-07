'use client';

/**
 * useXmtpStatus — tracks XMTP registration for the current user.
 *
 * • isEnabled  — true once the user has signed their XMTP identity on this platform
 * • isEnabling — spinner flag while Client.create() is running
 * • enable()   — prompts wallet signature and registers on XMTP network
 *
 * Registration is persisted in localStorage so the sign request only appears once.
 */

import { useState, useEffect, useCallback } from 'react';
import { useWalletClient } from 'wagmi';
import { initXmtpClient } from '@/lib/xmtp';

const flagKey = (addr: string) => `xmtp-registered-${addr.toLowerCase()}`;

export function useXmtpStatus() {
  const { data: walletClient } = useWalletClient();

  const [isEnabled,  setIsEnabled]  = useState(false);
  const [isEnabling, setIsEnabling] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  // On wallet connect, check if already registered
  useEffect(() => {
    const addr = walletClient?.account?.address;
    if (!addr) { setIsEnabled(false); return; }
    const registered = localStorage.getItem(flagKey(addr)) === '1';
    setIsEnabled(registered);
  }, [walletClient]);

  const enable = useCallback(async () => {
    if (!walletClient?.account?.address) {
      setError('Connect your wallet first');
      return;
    }
    setIsEnabling(true);
    setError(null);
    try {
      await initXmtpClient(walletClient);
      localStorage.setItem(flagKey(walletClient.account.address), '1');
      setIsEnabled(true);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : 'Failed to enable messaging';
      const isLimit = raw.includes('10/10') || raw.includes('registered 10');
      setError(isLimit
        ? 'Too many active XMTP sessions (10/10). Visit xmtp.chat with this wallet → Settings → Revoke installations, then retry.'
        : raw);
    } finally {
      setIsEnabling(false);
    }
  }, [walletClient]);

  return { isEnabled, isEnabling, error, enable };
}
