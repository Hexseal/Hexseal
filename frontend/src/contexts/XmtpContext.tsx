'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import { initXmtpClient, buildXmtpClient, clearXmtpSession, getXmtpClientIfCached, abandonXmtpInit, xmtpCrumb, isXmtpInitPending } from '@/lib/xmtp';

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
  // Addresses whose auto-init effect body is currently executing — covers the
  // localStorage preamble too, not just the buildXmtpClient()/initXmtpClient()
  // phase that isXmtpInitPending() (lib/xmtp.ts) tracks. Without it, a
  // resume-rearm firing before the client call has been made (isXmtpInitPending
  // would say "not pending") could kick off a second, redundant run.
  const inFlightRef  = useRef(new Set<string>());
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
  // Brave silently blocks XMTP's network/OPFS, so Client.create() there just spins
  // to the 90s timeout with a generic message. Detect it once so we can tell the
  // user WHY instead of leaving them on an endless spinner.
  const isBraveRef   = useRef(false);
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = (navigator as any).brave;
    if (b?.isBrave) b.isBrave().then((v: boolean) => { isBraveRef.current = v; }).catch(() => {});
  }, []);

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

    inFlightRef.current.add(addr);
    (async () => {
      try {
        // Автоматический путь СТРУКТУРНО не умеет просить подпись.
        //
        // Раньше здесь всё равно вызывался Client.create() — просто под
        // охраной эвристики, гадавшей по содержимому OPFS, понадобится ли ему
        // подпись. Промах эвристики означал молчаливое окно подписи, которого
        // человек не просил. На Android/Chrome + MetaMask это ровно тот вход,
        // где запрос залипает в кошельке насовсем: подключение уже увело в
        // приложение кошелька, вкладка ушла в фон, второй запрос прилетает
        // как 'already pending for origin' и отменить его нечем.
        //
        // Теперь автоматика строит клиента через Client.build() — штатный
        // конструктор SDK, который сайнера не принимает вовсе. Получилось —
        // мессенджер живой, подписи не было в принципе. Не получилось (первый
        // вход, хранилище вычистили, WASM/OPFS не поднялись) — уходим в
        // состояние ошибки, которое интерфейс уже рисует как предложение
        // включить мессенджер вручную. Подпись — только оттуда, по нажатию.
        if (!manual) {
          // Дешёвая отсечка до подъёма WASM: адрес, который здесь мессенджер
          // ни разу не включал, заведомо не имеет локальной личности, и
          // тратить на него воркер в хрупком окне подключения незачем.
          const enabledBefore = typeof window !== 'undefined'
            && localStorage.getItem(registeredKey(addr)) === '1';
          if (!enabledBefore) {
            xmtpCrumb(`ctx:autoinit ${addr.slice(0, 6)} skip flag=0`);
            setStatus('error');   // WalletMenu renders this as "Enable messaging"
            setError(null);
            return;
          }
          xmtpCrumb(`ctx:autoinit ${addr.slice(0, 6)} auto-build`);
          await buildXmtpClient(addr);
          if (isStale()) return;
          setStatus('ready');
          setError(null);
          return;
        }
        xmtpCrumb(`ctx:autoinit ${addr.slice(0, 6)} manual`);
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
        if (!manual) {
          // Провал авто-сборки — не ошибка, которую человеку надо читать: он
          // ничего не запрашивал. Молча предлагаем включить вручную (error:
          // null — WalletMenu рисует это как «Enable messaging»), а причину
          // оставляем в отладочном следе.
          xmtpCrumb(`ctx:autobuild-fail ${addr.slice(0, 6)} ${raw.slice(0, 30)}`);
          setError(null);
          setStatus('error');
          return;
        }
        setError(
          isBraveRef.current && raw === 'XMTP_TIMEOUT'
            ? 'Похоже, ты в Brave — его Shields блокируют мессенджер, поэтому он не подключается. Нажми на иконку льва в адресной строке, отключи Shields для этого сайта и попробуй снова. Либо открой сайт в Chrome.'
            : trimXmtpError(raw),
        );
        setStatus('error');
      } finally {
        inFlightRef.current.delete(addr);
      }
    })();
  // retryToken forces a re-run when retry() is called
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, walletClient, isConnected, retryToken]);

  // Cold-open / resume rescue for XMTP.
  //
  // A suspended PWA (iOS especially) returns in a FRESH JS context: the in-memory
  // client cache is gone and the wallet is still reconnecting, so status starts at
  // 'loading'. The auto-init effect above runs once when walletClient arrives, but
  // nothing re-arms it if that single pass is too early (OPFS not yet queryable →
  // dbExists briefly false → 'error') or transiently fails. Result: a chat opened
  // from a notification sits on an empty thread forever, since usePairChat only
  // loads history once status === 'ready'.
  //
  // On return-to-foreground, if this address previously enabled messaging here
  // (a persisted identity exists) and we're not already ready/disabled, clear the
  // tried-flag and re-fire auto-init. Безопасно по построению: авто-путь идёт
  // через Client.build(), у которого сайнера нет вовсе — сколько бы раз этот
  // rearm ни сработал, окна подписи он показать не может. First-time setups are
  // untouched: their registered flag isn't set until init actually succeeds.
  //
  // Must NOT fire while an attempt for this address is already in flight — on
  // Android, signing anything (push enable, profile save, this very init's own
  // wallet signature) backgrounds the tab via a wallet-app deep link, and coming
  // back fires visibilitychange/focus just like a real suspend/resume would. Without
  // this guard that re-fires auto-init on top of the attempt still running, re-doing
  // its OPFS checks over and over for as long as the original attempt is pending
  // (observed as a repeating dbcheck/autoinit loop until the 90s XMTP_TIMEOUT) —
  // instead of leaving it alone to actually finish.
  useEffect(() => {
    const rearm = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (!address) return;
      const addr = address.toLowerCase();
      if (statusRef.current === 'ready') return;
      if (disabledRef.current.has(addr)) return;
      if (isXmtpInitPending(addr)) return;
      if (inFlightRef.current.has(addr)) return;
      const enabledBefore = typeof window !== 'undefined'
        && localStorage.getItem(registeredKey(addr)) === '1';
      if (!enabledBefore) return;
      xmtpCrumb(`ctx:resume-rearm ${addr.slice(0, 6)} st=${statusRef.current}`);
      triedRef.current.delete(addr);
      setRetryToken(t => t + 1);
    };
    document.addEventListener('visibilitychange', rearm);
    window.addEventListener('focus', rearm);
    return () => {
      document.removeEventListener('visibilitychange', rearm);
      window.removeEventListener('focus', rearm);
    };
  }, [address]);

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
