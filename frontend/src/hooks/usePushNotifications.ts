'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { isPushSupported, getPushSubscription, enablePush, disablePush } from '@/lib/webpush';

export function usePushNotifications() {
  const { address } = useAccount();
  const [supported,   setSupported]   = useState(false);
  const [subscribed,  setSubscribed]  = useState(false);
  const [permission,  setPermission]  = useState<NotificationPermission>('default');
  const [loading,     setLoading]     = useState(false);

  useEffect(() => {
    const ok = isPushSupported();
    setSupported(ok);
    if (!ok) return;
    setPermission(Notification.permission);
    getPushSubscription().then(sub => setSubscribed(!!sub));
  }, []);

  // Auto-resubscribe silently when wallet connects and permission was already granted.
  // This re-registers the subscription with the relayer after restarts, without prompting.
  useEffect(() => {
    if (!address || !supported) return;
    if (Notification.permission !== 'granted') return;
    enablePush(address).catch(() => {});
  }, [address, supported]);

  const enable = useCallback(async () => {
    if (!address || !supported) return;
    setLoading(true);
    try {
      const result = await enablePush(address);
      setPermission(Notification.permission);
      if (result === 'ok') setSubscribed(true);
    } finally {
      setLoading(false);
    }
  }, [address, supported]);

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

  return { supported, subscribed, permission, loading, enable, disable };
}
