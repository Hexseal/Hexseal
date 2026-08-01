'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import { initXmtpClient, buildXmtpClient, clearXmtpSession, releaseXmtpClient, releaseXmtpTabLockIfIdle, getXmtpClientIfCached, abandonXmtpInit, xmtpCrumb, isXmtpInitPending } from '@/lib/xmtp';
import { classifyXmtpError, trimXmtpError, type XmtpErrorCode } from '@/lib/xmtpErrors';
import { waitForXmtpTabLock } from '@/lib/xmtpTabLock';

export type XmtpStatus = 'loading' | 'ready' | 'error';

export interface XmtpContextValue {
  status:  XmtpStatus;
  /** Сырой текст отказа — ТОЛЬКО для случаев, которые не удалось разобрать в
   *  код. Всё разобранное показывается через `errorCode` и i18n. */
  error:   string | null;
  /** Класс отказа. Интерфейс переводит его как `t('xmtp_error.<код>')`.
   *
   *  Раньше формулировку выбирал сам контекст и отдавал готовую русскую строку:
   *  в двенадцати нерусских локалях человек читал русский текст, а на таймаут
   *  ему уверенно называли ОДНУ причину — «проверь интернет, включи VPN», —
   *  хотя чаще всего причина была другая (незакрытый клиент держал хранилище). */
  errorCode: XmtpErrorCode | null;
  retry:   () => void;
  /** Настоящая отмена начатой попытки: бросает её и возвращает интерфейс к
   *  «включить». В отличие от `disable()` не отменяет решение человека
   *  пользоваться мессенджером и не трогает флаг «включён здесь». */
  cancel:  () => void;
  disable: () => void;
}

const XmtpContext = createContext<XmtpContextValue>({
  status:  'loading',
  error:   null,
  errorCode: null,
  retry:   () => {},
  cancel:  () => {},
  disable: () => {},
});

export function useXmtp(): XmtpContextValue {
  return useContext(XmtpContext);
}

const registeredKey = (addr: string) => `xmtp-registered-${addr.toLowerCase()}`;

export function XmtpProvider({ children }: { children: ReactNode }) {
  const { address, isConnected } = useAccount();
  const { data: walletClient }   = useWalletClient();

  const [status,     setStatus]     = useState<XmtpStatus>('loading');
  const [error,      setError]      = useState<string | null>(null);
  const [errorCode,  setErrorCode]  = useState<XmtpErrorCode | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  /** Сбрасывает оба поля отказа разом. Порознь их держать нельзя: оставшийся от
   *  прошлой попытки код нарисовал бы поверх новой чужую формулировку. */
  const clearFailure = useCallback(() => { setError(null); setErrorCode(null); }, []);

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

  // Смена аккаунта в кошельке: клиента прежнего адреса надо ЗАКРЫТЬ (иначе он
  // навсегда останется держать OPFS, и мессенджер нового адреса не поднимется
  // никогда), но решение человека «мессенджер здесь включён» отменять нельзя.
  //
  // Раньше здесь звался clearXmtpSession(), который заодно стирал флаг
  // `xmtp-registered-<адрес>`. Из-за этого аккаунт, с которого ушли, при
  // возврате показывал мессенджер выключенным — хотя его никто не выключал, — а
  // вместе с флагом глохли и внутренние уведомления о сообщениях
  // (hooks/useXmtpNotifications.ts гейтится тем же флагом).
  useEffect(() => {
    const prev = prevAddrRef.current;
    const curr = address?.toLowerCase();
    if (prev && curr && prev !== curr) {
      releaseXmtpClient(prev);
      triedRef.current.delete(prev);
      disabledRef.current.delete(prev);
      setStatus('loading');
      clearFailure();
    } else if (prev && !curr) {
      // Кошелёк отключили. Живого клиента здесь НЕ закрываем намеренно: адрес
      // умеет пропадать на секунду сам по себе (переподключение провайдера,
      // смена сети), и закрытие означало бы полную пересборку WASM/OPFS на
      // ровном месте. А вот лок вкладки, если он висит БЕЗ клиента (достался
      // ожиданием и не пригодился), отпустить обязаны — иначе соседние вкладки
      // заперты вкладкой, у которой даже кошелька нет.
      releaseXmtpTabLockIfIdle(prev);
    }
    prevAddrRef.current = curr;
  }, [address, clearFailure]);

  // Мессенджер занят соседней вкладкой: встаём в очередь Web Locks и, как
  // только та вкладка закроется (браузер отпускает лок сам, когда её контекст
  // исчезает), перезапускаем инициализацию.
  //
  // Без этого «занято» превратилось бы в новый тупик вместо старого: человек
  // закрыл первую вкладку, а вторая продолжает уверять, что мессенджер занят, и
  // ничего не делает. Кнопка «Повторить» остаётся вторым, ручным путём.
  const armTabWait = useCallback((addr: string) => {
    waitForXmtpTabLock(addr, () => {
      xmtpCrumb(`ctx:tab-lock-free ${addr.slice(0, 6)}`);
      triedRef.current.delete(addr);
      setRetryToken(t => t + 1);
    });
  }, []);

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
            // Лок вкладки мог достаться нам ожиданием: человек нажал «включить»
            // во второй вкладке, получил «занято», встал в очередь, первая
            // вкладка закрылась — и очередь разбудила нас. Но разбуженный прогон
            // всегда автоматический (флаг ручного нажатия израсходован
            // предыдущей попыткой), а на этом адресе мессенджер здесь ни разу не
            // включали, поэтому подниматься мы не будем. Не отпустив лок, вкладка
            // держала бы хранилище без единого клиента и врала бы всем остальным
            // вкладкам «мессенджер уже открыт в другой вкладке».
            releaseXmtpTabLockIfIdle(addr);
            setStatus('error');   // WalletMenu renders this as "Enable messaging"
            clearFailure();
            return;
          }
          xmtpCrumb(`ctx:autoinit ${addr.slice(0, 6)} auto-build`);
          await buildXmtpClient(addr);
          if (isStale()) return;
          setStatus('ready');
          clearFailure();
          return;
        }
        xmtpCrumb(`ctx:autoinit ${addr.slice(0, 6)} manual`);
        await initXmtpClient(walletClient);
        if (isStale()) return;
        if (typeof window !== 'undefined') {
          localStorage.setItem(registeredKey(addr), '1');
        }
        setStatus('ready');
        clearFailure();
      } catch (err: unknown) {
        if (isStale()) return;
        const raw = err instanceof Error ? err.message : 'Failed to enable messaging';
        const code = classifyXmtpError(raw);

        // Занятое соседней вкладкой хранилище — единственный отказ, о котором
        // человеку говорят даже на автоматическом пути. Молчать здесь значит
        // оставить его с пустым чатом и кнопкой «включить», которая не сработает
        // ни разу, сколько ни жми.
        if (code === 'tab_busy') {
          xmtpCrumb(`ctx:tab-busy ${addr.slice(0, 6)}`);
          setError(null);
          setErrorCode('tab_busy');
          setStatus('error');
          armTabWait(addr);
          return;
        }

        if (!manual) {
          // Провал авто-сборки — не ошибка, которую человеку надо читать: он
          // ничего не запрашивал. Молча предлагаем включить вручную (error:
          // null — WalletMenu рисует это как «Enable messaging»), а причину
          // оставляем в отладочном следе.
          xmtpCrumb(`ctx:autobuild-fail ${addr.slice(0, 6)} ${raw.slice(0, 30)}`);
          clearFailure();
          setStatus('error');
          return;
        }

        // Brave режет XMTP своими Shields, и наружу это выходит обычным
        // таймаутом — подменяем класс, чтобы человек прочитал про Shields, а не
        // про «попробуй ещё раз».
        const shown = isBraveRef.current && code === 'timeout' ? 'brave' : code;
        setErrorCode(shown);
        // Разобранный класс переводится интерфейсом; сырой текст остаётся
        // только там, где класс неизвестен, — иначе показать было бы нечего.
        setError(shown ? null : trimXmtpError(raw));
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
    clearFailure();
    setRetryToken(t => t + 1);
  }, [address, clearFailure]);

  /** Бросить идущую попытку подключения — и только её.
   *
   *  Под надписью «Подключение мессенджера…» раньше стояла кнопка «Отмена»,
   *  которая звала `disable()`. Это не отмена: `disable()` — отказ от
   *  мессенджера на всю сессию плюс стирание флага `xmtp-registered-*`, а вместе
   *  с флагом навсегда глохнут внутренние уведомления о сообщениях
   *  (`hooks/useXmtpNotifications.ts` гейтится тем же флагом). Человек нажимал
   *  «отменить ожидание», а получал «выключить мессенджер».
   *
   *  Здесь честно: попытка помечается устаревшей (её результат уже не будет
   *  применён, а сама она закроет себя, когда доедет), интерфейс возвращается к
   *  «включить», решение человека и флаг остаются нетронутыми. */
  const cancel = useCallback(() => {
    if (!address) return;
    const addr = address.toLowerCase();
    xmtpCrumb(`ctx:cancel ${addr.slice(0, 6)}`);
    // Обе половины: abandonXmtpInit — для попытки внутри lib/xmtp,
    // attemptIdRef — для эффекта здесь (его isStale() смотрит именно на него).
    abandonXmtpInit(addr);
    attemptIdRef.current++;
    setStatus('error');
    clearFailure();
  }, [address, clearFailure]);

  const disable = useCallback(() => {
    if (!address) return;
    const addr = address.toLowerCase();
    abandonXmtpInit(addr);
    disabledRef.current.add(addr);
    clearXmtpSession(addr);
    setStatus('error');
    clearFailure();
  }, [address, clearFailure]);

  return (
    <XmtpContext.Provider value={{ status, error, errorCode, retry, cancel, disable }}>
      {children}
    </XmtpContext.Provider>
  );
}
