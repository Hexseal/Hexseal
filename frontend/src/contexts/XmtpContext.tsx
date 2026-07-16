'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import { initXmtpClient, clearXmtpSession, getXmtpClientIfCached } from '@/lib/xmtp';

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

  const prevAddrRef = useRef<string | undefined>(undefined);
  const triedRef    = useRef(new Set<string>());
  const disabledRef = useRef(new Set<string>());

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

  // Auto-init XMTP when wallet connects
  useEffect(() => {
    if (!address || !walletClient || !isConnected) {
      // No wallet — stay in loading state silently (not an error)
      return;
    }
    const addr = address.toLowerCase();
    if (triedRef.current.has(addr))    return;
    if (disabledRef.current.has(addr)) return;
    triedRef.current.add(addr);

    (async () => {
      try {
        await initXmtpClient(walletClient);
        if (typeof window !== 'undefined') {
          localStorage.setItem(registeredKey(addr), '1');
        }
        setStatus('ready');
        setError(null);
      } catch (err: unknown) {
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
    const addr = address.toLowerCase();
    disabledRef.current.delete(addr);
    triedRef.current.delete(addr);
    setStatus('loading');
    setError(null);
    setRetryToken(t => t + 1);
  }, [address]);

  const disable = useCallback(() => {
    if (!address) return;
    const addr = address.toLowerCase();
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
