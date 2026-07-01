'use client';

/**
 * useXmtpSession — background XMTP session manager.
 *
 * Mounted once globally in client-layout. Handles:
 *  • Silent auto-restore: OPFS DB is source of truth — if DB exists, init without signing
 *    even if localStorage flag was accidentally cleared (bug or address switch race).
 *  • OPFS gone (browser cleared storage): clear flag, user sees Enable prompt
 *  • Cleanup: clears session only on address change, NOT on wallet disconnect.
 *    Disconnect-on-reload causes wagmi to briefly flash 'disconnected' (MetaMask+Brave
 *    conflict). Clearing on disconnect would wipe the localStorage key and force the
 *    banner to reappear permanently (triedRef prevents the restore from retrying).
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
import { _notifyEnabled, _setAutoRestoring } from './useXmtpStatus';

const registeredKey = (addr: string) => `xmtp-registered-${addr.toLowerCase()}`;

export function useXmtpSession() {
  const { address, isConnected } = useAccount();
  const { data: walletClient }   = useWalletClient();
  const prevAddrRef    = useRef<string | undefined>(undefined);
  const triedRef       = useRef(new Set<string>());
  const opfsCheckedRef = useRef(new Set<string>());

  // Clear session only when the wallet address actually changes (switch wallet / sign out).
  // Do NOT clear on disconnect status — wagmi transiently shows 'disconnected' during
  // page reload with MetaMask+Brave, which would wipe the key and lock the banner open.
  useEffect(() => {
    const prev = prevAddrRef.current;
    const curr = address?.toLowerCase();
    if (prev && prev !== curr) clearXmtpSession(prev);
    prevAddrRef.current = curr;
  }, [address]);

  // Early OPFS check — suppress the "Enable Messaging" banner immediately while the
  // async OPFS check is in flight. Prevents a flash on every reload for existing users.
  // If OPFS is absent (first use or storage cleared), clear the flag so the banner shows.
  useEffect(() => {
    if (!address) return;
    const addr = address.toLowerCase();
    if (opfsCheckedRef.current.has(addr)) return;
    opfsCheckedRef.current.add(addr);

    // Suppress immediately — don't wait for the async result
    if (!triedRef.current.has(addr)) _setAutoRestoring(true);

    checkXmtpDbExists(addr).then(exists => {
      // OPFS absent and restore hasn't started → clear the suppress flag so the banner shows
      if (!exists && !triedRef.current.has(addr)) _setAutoRestoring(false);
    });
  }, [address]);

  // Background auto-restore
  useEffect(() => {
    if (!address || !walletClient || !isConnected) return;

    const addr = address.toLowerCase();
    if (triedRef.current.has(addr)) return; // already attempted this session
    triedRef.current.add(addr);

    // Ensure isAutoRestoring is true (may already be set by early OPFS check above).
    _setAutoRestoring(true);

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
          _setAutoRestoring(false);
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
      } finally {
        _setAutoRestoring(false);
      }
    })();
  }, [address, walletClient, isConnected]);
}
