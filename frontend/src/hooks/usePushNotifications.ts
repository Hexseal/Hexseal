'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import { isPushSupported, getPushSubscription, enablePush, disablePush } from '@/lib/webpush';

export function usePushNotifications() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const [supported,   setSupported]   = useState(false);
  const [subscribed,  setSubscribed]  = useState(false);
  const [permission,  setPermission]  = useState<NotificationPermission>('default');
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  useEffect(() => {
    const ok = isPushSupported();
    setSupported(ok);
    if (!ok) return;
    setPermission(Notification.permission);
    getPushSubscription().then(sub => setSubscribed(!!sub));
  }, []);

  const buildSignMsg = useCallback((msg: string) => {
    if (!walletClient || !address) throw new Error('no wallet');
    return walletClient.signMessage({ account: address as `0x${string}`, message: msg });
  }, [walletClient, address]);

  // Note: auto-resubscribe is handled globally by PushAutoMount in providers.tsx (rate-limited).
  // This hook only exposes enable/disable for explicit user actions.

  const enable = useCallback(async () => {
    if (!address || !supported) return;
    setLoading(true);
    setError(null);
    try {
      const result = await enablePush(address, buildSignMsg);
      setPermission(Notification.permission);
      if (result === 'ok') {
        setSubscribed(true);
      } else if (result === 'denied') {
        setError('notifications_blocked');
      } else {
        setError('enable_failed');
      }
    } catch {
      setError('enable_failed');
    } finally {
      setLoading(false);
    }
  }, [address, supported, buildSignMsg]);

  const disable = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      await disablePush(address);
      setSubscribed(false);
    } finally {
      setLoading(false);
    }
  }, [address]);

  return { supported, subscribed, permission, loading, error, enable, disable };
}
