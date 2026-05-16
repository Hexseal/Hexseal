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

import { useState, useEffect, useCallback, useRef } from 'react';
import { useWalletClient } from 'wagmi';
import { initXmtpClient } from '@/lib/xmtp';

const flagKey = (addr: string) => `xmtp-registered-${addr.toLowerCase()}`;

// Module-level pub-sub: when any hook instance calls enable(), all others update too.
const _enabledListeners: Set<() => void> = new Set();
function _notifyEnabled() { _enabledListeners.forEach(fn => fn()); }

export function useXmtpStatus() {
  const { data: walletClient } = useWalletClient();

  const [isEnabled,  setIsEnabled]  = useState(false);
  const [isEnabling, setIsEnabling] = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const lockRef = useRef(false); // prevents re-entry across React re-renders

  // On wallet connect, check if already registered
  useEffect(() => {
    const addr = walletClient?.account?.address;
    if (!addr) { setIsEnabled(false); return; }
    setIsEnabled(localStorage.getItem(flagKey(addr)) === '1');

    // Refresh when another hook instance calls enable() in the same tab
    const refresh = () => setIsEnabled(localStorage.getItem(flagKey(addr)) === '1');
    _enabledListeners.add(refresh);
    return () => { _enabledListeners.delete(refresh); };
  }, [walletClient]);

  const enable = useCallback(async () => {
    if (!walletClient?.account?.address) {
      setError('Connect your wallet first');
      return;
    }
    if (lockRef.current) return;
    lockRef.current = true;
    setIsEnabling(true);
    setError(null);
    try {
      await initXmtpClient(walletClient);
      localStorage.setItem(flagKey(walletClient.account.address), '1');
      _notifyEnabled(); // update all other hook instances in this tab
      setIsEnabled(true);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : 'Failed to enable messaging';
      // Trim the verbose XMTP API stats dump that appears after the first sentence.
      const trimmed = raw.split('=====')[0].split('\n')[0].trim();

      const isLimit    = raw.includes('10/10') || raw.includes('registered 10');
      const isPending  = raw.toLowerCase().includes('already pending') ||
                         raw.toLowerCase().includes('pending for origin');
      const isChainId  = raw.toLowerCase().includes('wrong chain id');
      setError(
        isPending  ? 'Your wallet has a pending signature request. Open your wallet app, approve or reject it, then tap Enable again.' :
        isLimit    ? 'Too many active XMTP sessions (10/10). Visit xmtp.chat → Settings → Revoke installations, then retry.' :
        isChainId  ? 'XMTP session mismatch — please clear your browser/app storage and try again.' :
        trimmed,
      );
    } finally {
      lockRef.current = false;
      setIsEnabling(false);
    }
  }, [walletClient]);

  return { isEnabled, isEnabling, error, enable };
}
