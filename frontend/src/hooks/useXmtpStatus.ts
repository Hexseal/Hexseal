'use client';

/**
 * useXmtpStatus — tracks XMTP registration for the current user.
 *
 * • isEnabled       — true when user has enabled messaging (persists until explicit disable)
 * • isAutoRestoring — true while background session restore is in progress (hide banner)
 * • isEnabling      — spinner flag while Client.create() is running (user clicked Enable)
 * • enable()        — prompts wallet signature on first use; silent restore if OPFS keys exist
 * • disable()       — clears the flag (OPFS keys stay, so re-enable won't require re-signing)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useWalletClient } from 'wagmi';
import { initXmtpClient, clearXmtpSession, getXmtpClientIfCached } from '@/lib/xmtp';

const registeredKey = (addr: string) => `xmtp-registered-${addr.toLowerCase()}`;

// ── Pub-sub: enabled ──────────────────────────────────────────────────────────
const _enabledListeners: Set<() => void> = new Set();
export function _notifyEnabled() { _enabledListeners.forEach(fn => fn()); }

// ── Pub-sub: auto-restore progress ────────────────────────────────────────────
// useXmtpSession sets this to true when starting background restore so the
// banner is suppressed instead of flashing at the user during init.
let _isRestoringGlobal = false;
const _restoringListeners: Set<(v: boolean) => void> = new Set();
export function _setAutoRestoring(v: boolean) {
  _isRestoringGlobal = v;
  _restoringListeners.forEach(fn => fn(v));
}

function readIsEnabled(addr: string): boolean {
  return localStorage.getItem(registeredKey(addr)) === '1';
}

export function useXmtpStatus() {
  const { data: walletClient } = useWalletClient();

  // Lazy initializer reads localStorage synchronously on first render — no re-render
  // needed, no useLayoutEffect delay, no hydration mismatch (client-only component).
  const [isEnabled, setIsEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return Object.keys(localStorage).some(
      k => k.startsWith('xmtp-registered-') && localStorage.getItem(k) === '1',
    );
  });

  // isAutoRestoring: true while useXmtpSession is doing background OPFS restore.
  // If XMTP appears registered but the client isn't in memory yet, start as true
  // so the chat renders immediately instead of briefly showing the banner.
  const [isAutoRestoring, setIsAutoRestoring] = useState<boolean>(() => {
    if (_isRestoringGlobal) return true;
    if (typeof window === 'undefined') return false;
    return Object.keys(localStorage).some(
      k => k.startsWith('xmtp-registered-') && localStorage.getItem(k) === '1',
    );
  });
  useEffect(() => {
    const update = (v: boolean) => setIsAutoRestoring(v);
    _restoringListeners.add(update);
    return () => { _restoringListeners.delete(update); };
  }, []);

  const [isEnabling, setIsEnabling] = useState(false);
  const [signStep,   setSignStep]   = useState(0);
  const [error,      setError]      = useState<string | null>(null);
  const lockRef = useRef(false);

  useEffect(() => {
    const addr = walletClient?.account?.address;
    // Don't reset while wallet is still loading — useLayoutEffect already read localStorage.
    // Only act once we actually have an address.
    if (!addr) return;

    const lc = addr.toLowerCase();
    if (readIsEnabled(lc)) {
      setIsEnabled(true);
    } else {
      // localStorage key missing — check if the XMTP client is already in memory
      // (initialized earlier this session by useXmtpSession in the layout). If so,
      // restore the key immediately without re-signing. This prevents the banner from
      // appearing when navigating back to /chat after the layout already did the init.
      const cached = getXmtpClientIfCached(lc);
      if (cached) {
        localStorage.setItem(registeredKey(lc), '1');
        setIsEnabled(true);
      } else {
        setIsEnabled(false);
      }
    }

    const refresh = () => setIsEnabled(readIsEnabled(lc));
    _enabledListeners.add(refresh);

    // React to clearXmtpSession() called from useXmtpSession or elsewhere
    const onCleared = (e: Event) => {
      if ((e as CustomEvent).detail === lc) refresh();
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

  return { isEnabled, isAutoRestoring, isEnabling, signStep, error, enable, disable };
}
