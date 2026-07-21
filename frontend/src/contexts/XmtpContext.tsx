'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import { initXmtpClient, clearXmtpSession, getXmtpClientIfCached, abandonXmtpInit, xmtpCrumb, checkXmtpDbExists } from '@/lib/xmtp';

export type XmtpStatus = 'loading' | 'ready' | 'error';

export interface XmtpContextValue {
  status:  XmtpStatus;
  error:   string | null;
  retry:   () => void;
  disable: () => void;
}

const XmtpContext = createContext<XmtpContextValue>({
  status:  'loading',
  error:   null,
  retry:   () => {},
  disable: () => {},
});

export function useXmtp(): XmtpContextValue {
  return useContext(XmtpContext);
}

const registeredKey = (addr: string) => `xmtp-registered-${addr.toLowerCase()}`;

function trimXmtpError(raw: string): string {
  const msg = raw.split('=====')[0].split('\n')[0].trim();
  if (raw === 'XMTP_TIMEOUT')
    return 'Мессенджер не смог подключиться (90 сек). Проверь интернет и попробуй снова. Если ты в стране с блокировками — включи VPN.';
  if (raw.toLowerCase().includes('already pending') || raw.toLowerCase().includes('pending for origin'))
    return 'Есть незакрытый запрос в кошельке. Открой его, прими или отклони, затем повтори.';
  if (raw.includes('10/10') || raw.includes('registered 10'))
    return 'Слишком много сессий XMTP (10/10). Зайди xmtp.chat → Settings → Revoke installations.';
  if (raw.toLowerCase().includes('wrong chain id'))
    return 'Несоответствие сети — очисти хранилище браузера и попробуй снова.';
  return msg;
}

export function XmtpProvider({ children }: { children: ReactNode }) {
  const { address, isConnected } = useAccount();
  const { data: walletClient }   = useWalletClient();

  const [status,     setStatus]     = useState<XmtpStatus>('loading');
  const [error,      setError]      = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const prevAddrRef  = useRef<string | undefined>(undefined);
  const triedRef     = useRef(new Set<string>());
  const disabledRef  = useRef(new Set<string>());
  // Bumped on every connect attempt (auto-init or retry()) so a late-resolving
  // attempt can tell it's been superseded and skip applying its result — see
  // the comment above the auto-init effect below for the race this closes.
  const attemptIdRef = useRef(0);
  // true for one run when the user explicitly tapped "Enable messaging" (retry()),
  // so that run is allowed to prompt a wallet signature; auto-on-connect runs aren't.
  const manualRef    = useRef(false);
  // Mirror of `status` so retry() (an event handler) can read the latest value
  // without re-subscribing / going stale in its useCallback closure.
  const statusRef    = useRef<XmtpStatus>(status);
  useEffect(() => { statusRef.current = status; }, [status]);

  // Clear session when wallet address switches
  useEffect(() => {
    const prev = prevAddrRef.current;
    const curr = address?.toLowerCase();
    if (prev && curr && prev !== curr) {
      clearXmtpSession(prev);
      triedRef.current.delete(prev);
      disabledRef.current.delete(prev);
      setStatus('loading');
      setError(null);
    }
    prevAddrRef.current = curr;
  }, [address]);

  // Auto-init XMTP when wallet connects.
  //
  // initXmtpClient() can take a while (wallet signature + up to 90s network
  // timeout), and neither disable() nor a fresh retry() cancels an attempt
  // already in flight. Without the attemptIdRef/disabledRef checks below, a
  // stale attempt resolving *after* the user clicked disable (or after a
  // newer retry() already started) would silently overwrite whatever status
  // the user's later action set — e.g. clicking "Disable messaging" would
  // flip the menu to "Enable messaging" for a moment, then flip back to
  // "Disable messaging" on its own once the old in-flight connect finally
  // resolved, with no action from the user. Each attempt now tags itself
  // with an id and only applies its result if it's still the latest one.
  useEffect(() => {
    if (!address || !walletClient || !isConnected) {
      // No wallet — stay in loading state silently (not an error)
      return;
    }
    const addr = address.toLowerCase();
    if (triedRef.current.has(addr))    return;
    if (disabledRef.current.has(addr)) return;
    triedRef.current.add(addr);

    const myAttempt = ++attemptIdRef.current;
    const isStale = () => attemptIdRef.current !== myAttempt || disabledRef.current.has(addr);

    // Was this run triggered by an explicit Enable-messaging tap (retry()) or is it
    // the automatic on-connect run? Consume the flag so the next auto-run is auto.
    const manual = manualRef.current;
    manualRef.current = false;

    (async () => {
      try {
        // Never pop a wallet signature during the connect handshake. On mobile,
        // connecting already deep-links out to the wallet app; if XMTP auto-fires
        // Client.create()'s signature the instant walletClient is ready, that second
        // request collides with the WalletConnect return and bounces the user back to
        // the wallet picker (and piles WASM memory onto the fragile connect window).
        // So auto-resume messaging only when the OPFS keys already exist (no signature
        // needed); for a first-time setup wait for an explicit Enable-messaging tap.
        if (!manual) {
          const dbExists = await checkXmtpDbExists(addr);
          if (isStale()) return;
          if (!dbExists) {
            xmtpCrumb(`ctx:autoinit ${addr.slice(0, 6)} skip-nodb`);
            setStatus('error');   // WalletMenu renders this as "Enable messaging"
            setError(null);
            return;
          }
        }
        xmtpCrumb(`ctx:autoinit ${addr.slice(0, 6)} ${manual ? 'manual' : 'auto'}`);
        await initXmtpClient(walletClient);
        if (isStale()) return;
        if (typeof window !== 'undefined') {
          localStorage.setItem(registeredKey(addr), '1');
        }
        setStatus('ready');
        setError(null);
      } catch (err: unknown) {
        if (isStale()) return;
        const raw = err instanceof Error ? err.message : 'Failed to enable messaging';
        setError(trimXmtpError(raw));
        setStatus('error');
      }
    })();
  // retryToken forces a re-run when retry() is called
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, walletClient, isConnected, retryToken]);

  // Background conversations stream — registers a listener for incoming MLS
  // session_request events so the WASM layer never fires "without any listeners".
  // Also dispatches hexseal-conv-update so the sidebar refreshes in real-time
  // when someone starts a new conversation with us.
  const convStreamRef = useRef<AsyncIterable<unknown> & { return?: () => void } | null>(null);
  useEffect(() => {
    if (status !== 'ready' || !address) return;
    const xmtp = getXmtpClientIfCached(address.toLowerCase());
    if (!xmtp) return;

    let cancelled = false;
    (async () => {
      try {
        xmtpCrumb('ctx:convstream-start');
        const stream = await xmtp.conversations.stream();
        convStreamRef.current = stream as typeof convStreamRef.current;
        for await (const _ of stream) {
          if (cancelled) break;
          window.dispatchEvent(new Event('hexseal-conv-update'));
        }
      } catch {
        // Stream ended or failed — non-critical
      }
    })();

    return () => {
      cancelled = true;
      convStreamRef.current?.return?.();
      convStreamRef.current = null;
    };
  }, [status, address]);

  const retry = useCallback(() => {
    if (!address) return;
    // Ignore Enable taps unless a previous attempt actually failed. The first-time
    // Client.create() can take ~a minute; while it's in flight (status 'loading') a
    // second tap — e.g. from the chat page's Enable bar while the menu one is still
    // running — would abandon that healthy attempt and start a fresh one, forcing a
    // needless SECOND wallet signature (the "two signatures to enable chat" bug).
    // When it's already 'ready' there's nothing to retry.
    if (statusRef.current !== 'error') return;
    const addr = address.toLowerCase();
    // Explicit user action — this run is allowed to prompt a wallet signature.
    manualRef.current = true;
    // Evict any stuck in-flight attempt first — otherwise the auto-init effect's
    // initXmtpClient() call below would just re-attach to the same zombie promise
    // (its own dedup) instead of actually starting over.
    abandonXmtpInit(addr);
    disabledRef.current.delete(addr);
    triedRef.current.delete(addr);
    setStatus('loading');
    setError(null);
    setRetryToken(t => t + 1);
  }, [address]);

  const disable = useCallback(() => {
    if (!address) return;
    const addr = address.toLowerCase();
    abandonXmtpInit(addr);
    disabledRef.current.add(addr);
    clearXmtpSession(addr);
    setStatus('error');
    setError(null);
  }, [address]);

  return (
    <XmtpContext.Provider value={{ status, error, retry, disable }}>
      {children}
    </XmtpContext.Provider>
  );
}
