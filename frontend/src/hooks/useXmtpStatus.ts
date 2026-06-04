'use client';

/**
 * useXmtpStatus — tracks XMTP registration for the current user.
 *
 * • isEnabled  — true once the user has signed their XMTP identity
 * • isEnabling — spinner flag while Client.create() is running
 * • enable()   — prompts wallet signature and registers on XMTP network
 *
 * Session TTL: 3 days from last activity. Refreshed on every silent restore
 * by useXmtpSession. Expired sessions clear automatically and show Enable again.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useWalletClient } from 'wagmi';
import { initXmtpClient, SESSION_TTL_MS, clearXmtpSession } from '@/lib/xmtp';

const registeredKey = (addr: string) => `xmtp-registered-${addr.toLowerCase()}`;
const expiryKey     = (addr: string) => `xmtp-expiry-${addr.toLowerCase()}`;

// Module-level pub-sub: when any hook instance calls enable(), all others update too.
const _enabledListeners: Set<() => void> = new Set();
export function _notifyEnabled() { _enabledListeners.forEach(fn => fn()); }

function readIsEnabled(addr: string): boolean {
  if (localStorage.getItem(registeredKey(addr)) !== '1') return false;
  const expiry = parseInt(localStorage.getItem(expiryKey(addr)) ?? '0', 10);
  if (Date.now() > expiry) {
    // Session expired — clean up silently
    clearXmtpSession(addr);
    return false;
  }
  return true;
}

export function useXmtpStatus() {
  const { data: walletClient } = useWalletClient();

  const [isEnabled,  setIsEnabled]  = useState(false);
  const [isEnabling, setIsEnabling] = useState(false);
  const [signStep,   setSignStep]   = useState(0);
  const [error,      setError]      = useState<string | null>(null);
  const lockRef = useRef(false);

  useEffect(() => {
    const addr = walletClient?.account?.address;
    if (!addr) { setIsEnabled(false); return; }

    setIsEnabled(readIsEnabled(addr));

    const refresh = () => setIsEnabled(readIsEnabled(addr));
    _enabledListeners.add(refresh);

    // React to clearXmtpSession() called from useXmtpSession or elsewhere
    const onCleared = (e: Event) => {
      if ((e as CustomEvent).detail === addr.toLowerCase()) refresh();
    };
    window.addEventListener('hexseal:xmtp-session-cleared', onCleared);

    return () => {
      _enabledListeners.delete(refresh);
      window.removeEventListener('hexseal:xmtp-session-cleared', onCleared);
    };
  }, [walletClient]);

  const enable = useCallback(async () => {
    if (!walletClient?.account?.address) {
      setError('Connect your wallet first');
      return;
    }
    if (lockRef.current) return;
    lockRef.current = true;
    setIsEnabling(true);
    setSignStep(0);
    setError(null);
    try {
      await initXmtpClient(walletClient, setSignStep);
      const addr = walletClient.account.address.toLowerCase();
      localStorage.setItem(registeredKey(addr), '1');
      localStorage.setItem(expiryKey(addr), String(Date.now() + SESSION_TTL_MS));
      _notifyEnabled();
      setIsEnabled(true);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : 'Failed to enable messaging';
      const trimmed = raw.split('=====')[0].split('\n')[0].trim();

      const isLimit   = raw.includes('10/10') || raw.includes('registered 10');
      const isPending = raw.toLowerCase().includes('already pending') ||
                        raw.toLowerCase().includes('pending for origin');
      const isChainId = raw.toLowerCase().includes('wrong chain id');
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

  return { isEnabled, isEnabling, signStep, error, enable };
}
