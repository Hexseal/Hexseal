'use client';

/**
 * useXmtpSession — background XMTP session manager.
 *
 * Mounted once globally in client-layout. Handles:
 *  • Silent auto-restore: OPFS DB is source of truth — if DB exists, init without signing
 *    even if localStorage flag was accidentally cleared (bug or address switch race).
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
    triedRef.current.add(addr);

    (async () => {
      try {
        // OPFS is the source of truth — if the DB exists, Client.create() restores without
        // a wallet signature, regardless of the localStorage flag state.
        // This handles the case where the flag was accidentally cleared (old bug, address
        // switch race, etc.) while the user's OPFS keys are still intact.
        const dbExists = await checkXmtpDbExists(addr);
        if (!dbExists) {
          // No OPFS DB — user never enabled or browser cleared storage.
          // If localStorage flag is set somehow, clean it up (phantom session).
          if (localStorage.getItem(registeredKey(addr)) === '1') {
            clearXmtpSession(addr);
          }
          return;
        }

        // OPFS intact → restore client without any wallet signature
        await initXmtpClient(walletClient);
        // Restore localStorage flag in case it was cleared — next reload skips OPFS check
        localStorage.setItem(registeredKey(addr), '1');
        _notifyEnabled(); // update any mounted useXmtpStatus instances
      } catch {
        // Transient init error — do NOT clear session or remove localStorage flag.
        // Clearing would force the user to re-sign on every transient network hiccup.
        // The chat hooks will show an error state; user can retry by reloading.
      }
    })();
  }, [address, walletClient, isConnected]);
}
