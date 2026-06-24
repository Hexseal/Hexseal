'use client';

/**
 * useXmtpStatus — tracks XMTP registration for the current user.
 *
 * • isEnabled  — true when user has enabled messaging (persists until explicit disable)
 * • isEnabling — spinner flag while Client.create() is running
 * • enable()   — prompts wallet signature on first use; silent restore if OPFS keys exist
 * • disable()  — clears the flag (OPFS keys stay, so re-enable won't require re-signing)
 */

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { useWalletClient } from 'wagmi';
import { initXmtpClient, clearXmtpSession } from '@/lib/xmtp';

const registeredKey = (addr: string) => `xmtp-registered-${addr.toLowerCase()}`;

// Module-level pub-sub: when any hook instance calls enable(), all others update too.
const _enabledListeners: Set<() => void> = new Set();
export function _notifyEnabled() { _enabledListeners.forEach(fn => fn()); }

function readIsEnabled(addr: string): boolean {
  return localStorage.getItem(registeredKey(addr)) === '1';
}

export function useXmtpStatus() {
  const { data: walletClient } = useWalletClient();

  // Start false (matches SSR) — no hydration mismatch.
  // useLayoutEffect reads localStorage before paint so there's no visible flash.
  const [isEnabled, setIsEnabled] = useState(false);
  useLayoutEffect(() => {
    const hasAny = Object.keys(localStorage).some(
      k => k.startsWith('xmtp-registered-') && localStorage.getItem(k) === '1',
    );
    if (hasAny) setIsEnabled(true);
  }, []);
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

  const disable = useCallback(() => {
    const addr = walletClient?.account?.address;
    if (!addr) return;
    clearXmtpSession(addr);
    // readIsEnabled will return false → setIsEnabled(false) via the 'hexseal:xmtp-session-cleared' event
  }, [walletClient]);

  return { isEnabled, isEnabling, signStep, error, enable, disable };
}
