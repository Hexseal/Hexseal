'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import {
  isPushSupported, getPushSubscription, getSwRegistration,
  enablePush, disablePush, shouldAutoRegisterPush, isPushRegisteredForAddress,
} from '@/lib/webpush';

export interface PushContextValue {
  supported: boolean;
  subscribed: boolean;
  permission: NotificationPermission;
  loading: boolean;
  error: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
}

const PushContext = createContext<PushContextValue>({
  supported: false,
  subscribed: false,
  permission: 'default',
  loading: false,
  error: null,
  enable: async () => {},
  disable: async () => {},
});

export function usePushCtx(): PushContextValue {
  return useContext(PushContext);
}

export function PushProvider({ children }: { children: ReactNode }) {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();

  const [supported, setSupported]   = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);

  // Bumped on every enable()/disable() call so a slow, superseded attempt (e.g. the
  // background auto-registration below, still waiting on a wallet signature) can
  // tell it lost the race and skip applying its result — same pattern as
  // XmtpContext.tsx's attemptIdRef/isStale(), needed for the identical race:
  // enablePush() can take a while (signature + network) and nothing previously
  // stopped a stale success from silently overwriting a newer disable(), or a
  // stale disable() from silently overwriting a newer enable() — both enable()
  // and disable() capture their own attempt id and check it before applying
  // their result.
  const attemptIdRef = useRef(0);
  // Addresses the background auto-registration has already tried THIS page load —
  // ported as-is from providers.tsx's former PushAutoMount.
  const attemptedRef = useRef<Set<string>>(new Set());

  // Register the service worker at app start, regardless of push permission state,
  // so useXmtpNotifications's navigator.serviceWorker.ready await always resolves.
  useEffect(() => { void getSwRegistration(); }, []);

  const refreshSubscribed = useCallback(async (addr: string | undefined) => {
    const sub = await getPushSubscription();
    setSubscribed(!!sub && !!addr && isPushRegisteredForAddress(addr));
  }, []);

  useEffect(() => {
    const ok = isPushSupported();
    setSupported(ok);
    if (!ok) return;
    setPermission(Notification.permission);
    void refreshSubscribed(address);
  }, [address, refreshSubscribed]);

  // Re-registers push with the relayer at most once per 24h (shouldAutoRegisterPush)
  // per address, so the relayer's subscription list stays fresh after restarts
  // without prompting a wallet signature on every page load. Ported from
  // providers.tsx's PushAutoMount so it shares attemptIdRef with enable()/disable()
  // below and can no longer race them.
  useEffect(() => {
    if (!address || !isPushSupported() || !walletClient) return;
    if (Notification.permission !== 'granted') return;
    const addr = address.toLowerCase();
    if (attemptedRef.current.has(addr)) return;
    if (!shouldAutoRegisterPush(address)) return;
    attemptedRef.current.add(addr);
    const myAttempt = ++attemptIdRef.current;
    const signMsg = (msg: string) =>
      walletClient.signMessage({ account: address as `0x${string}`, message: msg });
    enablePush(address, signMsg)
      .then(result => {
        if (attemptIdRef.current !== myAttempt) return; // superseded by a later enable()/disable()
        if (result === 'ok') void refreshSubscribed(address);
      })
      .catch(() => { attemptedRef.current.delete(addr); }); // let a future mount/reload retry
  }, [address, walletClient, refreshSubscribed]);

  const buildSignMsg = useCallback((msg: string) => {
    if (!walletClient || !address) throw new Error('no wallet');
    return walletClient.signMessage({ account: address as `0x${string}`, message: msg });
  }, [walletClient, address]);

  const enable = useCallback(async () => {
    if (!address || !supported) return;
    const myAttempt = ++attemptIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await enablePush(address, buildSignMsg);
      if (attemptIdRef.current !== myAttempt) return; // a disable() happened while we were signing
      setPermission(Notification.permission);
      if (result === 'ok') {
        setSubscribed(true);
      } else if (result === 'denied') {
        setError('notifications_blocked');
      } else {
        setError('enable_failed');
      }
    } catch {
      if (attemptIdRef.current === myAttempt) setError('enable_failed');
    } finally {
      if (attemptIdRef.current === myAttempt) setLoading(false);
    }
  }, [address, supported, buildSignMsg]);

  const disable = useCallback(async () => {
    if (!address) return;
    const myAttempt = ++attemptIdRef.current; // supersede any enable() (explicit or background) still in flight
    setLoading(true);
    try {
      await disablePush(address, buildSignMsg);
      if (attemptIdRef.current === myAttempt) setSubscribed(false); // an enable() that started after us and already won must not be reverted
    } finally {
      if (attemptIdRef.current === myAttempt) setLoading(false);
    }
  }, [address, buildSignMsg]);

  return (
    <PushContext.Provider value={{ supported, subscribed, permission, loading, error, enable, disable }}>
      {children}
    </PushContext.Provider>
  );
}
