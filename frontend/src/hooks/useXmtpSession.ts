'use client';

/**
 * useXmtpSession — background XMTP session manager.
 *
 * Mounted once globally in client-layout. Handles:
 *  • Silent auto-restore: if localStorage flag set + OPFS DB exists → init without signing
 *  • OPFS gone (browser cleared storage): clear flag, user sees Enable prompt
 *  • Cleanup: clears session when wallet disconnects or address changes
 *
 * No TTL — session lives until user explicitly clicks "Disable Messaging".
 */

import { useEffect, useRef } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import {
  initXmtpClient,
  checkXmtpDbExists,
  clearXmtpSession,
} from '@/lib/xmtp';
import { _notifyEnabled } from './useXmtpStatus';

const registeredKey = (addr: string) => `xmtp-registered-${addr.toLowerCase()}`;

export function useXmtpSession() {
  const { address, isConnected, status } = useAccount();
  const { data: walletClient }           = useWalletClient();
  const prevAddrRef  = useRef<string | undefined>(undefined);
  // Track which addresses were already attempted this page session (in-memory)
  const triedRef = useRef(new Set<string>());

  // Cleanup on wallet disconnect or address switch.
  // IMPORTANT: skip cleanup during 'reconnecting'/'connecting' — wagmi briefly sets
  // isConnected=false while restoring the wallet session (PWA restart, page reload).
  // Clearing the session there would force re-signing on every app open.
  useEffect(() => {
    const prev = prevAddrRef.current;
    const curr = address?.toLowerCase();

    if (prev && prev !== curr) {
      // Address changed — invalidate old address session
      clearXmtpSession(prev);
    }
    if (status === 'disconnected' && curr) {
      clearXmtpSession(curr);
    }

    prevAddrRef.current = curr;
  }, [address, isConnected, status]);

  // Background auto-restore
  useEffect(() => {
    if (!address || !walletClient || !isConnected) return;

    const addr = address.toLowerCase();
    if (triedRef.current.has(addr)) return; // already attempted this session

    // No valid session registered — user hasn't enabled messaging
    if (localStorage.getItem(registeredKey(addr)) !== '1') return;

    triedRef.current.add(addr);

    (async () => {
      try {
        // Only init silently if OPFS DB exists — if it's gone (browser cleared storage),
        // Client.create() would need a wallet signature, which we must not trigger silently.
        const dbExists = await checkXmtpDbExists(addr);
        if (!dbExists) {
          // OPFS gone — clear flag so user sees Enable prompt instead of a phantom session
          clearXmtpSession(addr);
          return;
        }

        // OPFS intact + flag set → restore client without any wallet signature
        await initXmtpClient(walletClient);
        _notifyEnabled(); // update any mounted useXmtpStatus instances
      } catch {
        // Unexpected error — clear session so user can re-enable cleanly
        clearXmtpSession(addr);
      }
    })();
  }, [address, walletClient, isConnected]);
}
