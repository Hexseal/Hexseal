'use client';

/**
 * useXmtpSession — background XMTP session manager.
 *
 * Mounted once globally in client-layout. Handles:
 *  • Silent auto-restore: if OPFS DB exists + session not expired → init without signing
 *  • OPFS gone: clear session, user sees Enable prompt (no unexpected wallet popup)
 *  • TTL refresh: bumps expiry 3 days forward on every successful silent restore
 *  • Cleanup: clears session when wallet disconnects or address changes
 */

import { useEffect, useRef } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import {
  initXmtpClient,
  checkXmtpDbExists,
  clearXmtpSession,
  SESSION_TTL_MS,
} from '@/lib/xmtp';
import { _notifyEnabled } from './useXmtpStatus';

const registeredKey = (addr: string) => `xmtp-registered-${addr.toLowerCase()}`;
const expiryKey     = (addr: string) => `xmtp-expiry-${addr.toLowerCase()}`;

export function useXmtpSession() {
  const { address, isConnected } = useAccount();
  const { data: walletClient }   = useWalletClient();
  const prevAddrRef  = useRef<string | undefined>(undefined);
  // Track which addresses were already attempted this page session (in-memory)
  const triedRef = useRef(new Set<string>());

  // Cleanup on wallet disconnect or address switch
  useEffect(() => {
    const prev = prevAddrRef.current;
    const curr = address?.toLowerCase();

    if (prev && prev !== curr) {
      // Address changed — invalidate old address session
      clearXmtpSession(prev);
    }
    if (!isConnected && curr) {
      clearXmtpSession(curr);
    }

    prevAddrRef.current = curr;
  }, [address, isConnected]);

  // Background auto-restore
  useEffect(() => {
    if (!address || !walletClient || !isConnected) return;

    const addr = address.toLowerCase();
    if (triedRef.current.has(addr)) return; // already attempted this session

    const flag   = localStorage.getItem(registeredKey(addr));
    const expiry = parseInt(localStorage.getItem(expiryKey(addr)) ?? '0', 10);

    // No valid session registered
    if (flag !== '1') return;

    // TTL expired — clear and let user re-enable
    if (Date.now() > expiry) {
      clearXmtpSession(addr);
      return;
    }

    triedRef.current.add(addr);

    (async () => {
      try {
        // Only init silently if OPFS DB exists — if it's gone, Client.create()
        // would need a wallet signature, which we must not trigger silently.
        const dbExists = await checkXmtpDbExists(addr);
        if (!dbExists) {
          clearXmtpSession(addr);
          return;
        }

        // OPFS intact + session valid → restore without signing
        await initXmtpClient(walletClient);

        // Extend TTL on every successful silent restore
        localStorage.setItem(expiryKey(addr), String(Date.now() + SESSION_TTL_MS));
        _notifyEnabled(); // update any mounted useXmtpStatus instances
      } catch {
        // Unexpected error (shouldn't sign since OPFS existed, but handle gracefully)
        clearXmtpSession(addr);
      }
    })();
  }, [address, walletClient, isConnected]);
}
