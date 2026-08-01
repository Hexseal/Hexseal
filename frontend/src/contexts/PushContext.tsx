'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import {
  isPushSupported, getPushSubscription, getSwRegistration,
  enablePush, disablePush, isPushRegistrationStale, isPushRegisteredForAddress,
  isPushSubscriptionUsable,
} from '@/lib/webpush';
import { withWalletLock } from '@/lib/walletLock';

export interface PushContextValue {
  supported: boolean;
  subscribed: boolean;
  /** Подписка числится включённой, но её регистрация на релеере старше суток —
   *  пуши могли перестать доходить. Интерфейс ОБЯЗАН это показать и предложить
   *  включить заново нажатием; сам по себе флаг ничего не переподписывает. */
  stale: boolean;
  permission: NotificationPermission;
  loading: boolean;
  error: string | null;
  enable: () => Promise<void>;
  /** `true` — доставка на это устройство действительно прекращена. `false` —
   *  выключить не вышло (подписка жива), и вызывающая сторона ОБЯЗАНА сказать
   *  об этом человеку: молчаливый `false` неотличим от успеха. */
  disable: () => Promise<boolean>;
}

const PushContext = createContext<PushContextValue>({
  supported: false,
  subscribed: false,
  stale: false,
  permission: 'default',
  loading: false,
  error: null,
  enable: async () => {},
  disable: async () => false,
});

export function usePushCtx(): PushContextValue {
  return useContext(PushContext);
}

export function PushProvider({ children }: { children: ReactNode }) {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();

  const [supported, setSupported]   = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [stale, setStale]           = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);

  // Bumped on every enable()/disable() call so a slow, superseded attempt (still
  // waiting on a wallet signature) can tell it lost the race and skip applying
  // its result — same pattern as XmtpContext.tsx's attemptIdRef/isStale(),
  // needed for the identical race: enablePush() can take a while (signature +
  // network) and nothing previously stopped a stale success from silently
  // overwriting a newer disable(), or a stale disable() from silently
  // overwriting a newer enable() — both enable() and disable() capture their own
  // attempt id and check it before applying their result.
  const attemptIdRef = useRef(0);

  // Register the service worker at app start, regardless of push permission state,
  // so useXmtpNotifications's navigator.serviceWorker.ready await always resolves.
  useEffect(() => { void getSwRegistration(); }, []);

  const refreshSubscribed = useCallback(async (addr: string | undefined) => {
    const sub = await getPushSubscription();
    // Проверка ключа VAPID — не лишняя строгость, а та же проверка, которую
    // `enablePush` делает у себя перед переподпиской. Здесь её не было, и
    // асимметрия стоила ровно того, ради чего проверку заводили: подписка,
    // созданная СТАРЫМ ключом, живёт в браузере как ни в чём не бывало
    // (`getSubscription()` её отдаёт), а каждая отправка отваливается с
    // 403 VapidPkHashMismatch. Меню показывало «уведомления включены» тому,
    // кому не доходит ни одно.
    const on = isPushSubscriptionUsable(sub) && !!addr && isPushRegisteredForAddress(addr);
    setSubscribed(on);
    setStale(on && !!addr && isPushRegistrationStale(addr));
  }, []);

  useEffect(() => {
    const ok = isPushSupported();
    setSupported(ok);
    if (!ok) return;
    setPermission(Notification.permission);
    void refreshSubscribed(address);
  }, [address, refreshSubscribed]);

  // ЗДЕСЬ БЫЛА ФОНОВАЯ ПЕРЕРЕГИСТРАЦИЯ — и её здесь больше нет.
  //
  // Эффект раз в 24 часа сам звал enablePush(), а тот подписывает сообщение
  // `hexseal:push-subscribe:...` кошельком. На мобильном подпись — это уход в
  // приложение кошелька: приложение САМО, без нажатия, выбрасывало человека
  // туда раз в сутки, посреди любого экрана. На Android/Chrome + MetaMask
  // такой автоматический уход и есть вход в незакрываемое
  // 'personal_sign already pending' — снять его можно только полным закрытием
  // кошелька.
  //
  // Взамен протухание больше не чинится молча, а ПОКАЗЫВАЕТСЯ: флаг `stale`
  // выше поднимается, когда регистрация старше суток, и страница уведомлений
  // предлагает включить заново — нажатием.
  //
  // Правильное долгое решение — продлять регистрацию на стороне релеера, без
  // новой подписи (`relayer/app.js` требует доказательства владения адресом).
  // Это отдельная работа и здесь намеренно не сделана.

  const buildSignMsg = useCallback((msg: string) => {
    if (!walletClient || !address) throw new Error('no wallet');
    // Под общим мьютексом кошелька — см. lib/walletLock.ts. Второй
    // одновременный запрос подписи прилетает в кошелёк как -32002 и в мобильном
    // MetaMask залипает намертво.
    return withWalletLock(address, () =>
      walletClient.signMessage({ account: address as `0x${string}`, message: msg }),
    );
  }, [walletClient, address]);

  const enable = useCallback(async () => {
    if (!address || !supported) return;
    const myAttempt = ++attemptIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await enablePush(address, buildSignMsg);
      if (attemptIdRef.current !== myAttempt) return; // a disable() happened while we were signing
      setPermission(Notification.permission);
      if (result === 'ok') {
        setSubscribed(true);
        setStale(false); // enablePush() только что переписал отметку регистрации
      } else if (result === 'denied') {
        setError('notifications_blocked');
      } else {
        setError('enable_failed');
      }
    } catch {
      if (attemptIdRef.current === myAttempt) setError('enable_failed');
    } finally {
      if (attemptIdRef.current === myAttempt) setLoading(false);
    }
  }, [address, supported, buildSignMsg]);

  const disable = useCallback(async (): Promise<boolean> => {
    if (!address) return false;
    const myAttempt = ++attemptIdRef.current; // supersede any enable() (explicit or background) still in flight
    setLoading(true);
    setError(null);
    try {
      const result = await disablePush(address, buildSignMsg);
      // an enable() that started after us and already won must not be reverted
      if (attemptIdRef.current !== myAttempt) return result === 'ok';
      if (result === 'ok') { setSubscribed(false); setStale(false); return true; }
      // Отписаться не удалось — подписка жива и пуши продолжают приходить.
      // Показывать «выключено» здесь значит соврать; перечитываем настоящее
      // состояние, чтобы пункт «Отключить» остался на месте.
      setError('disable_failed');
      await refreshSubscribed(address);
      return false;
    } catch {
      // `disable()` жил вообще без catch: отказ от подписи в кошельке или
      // недоступный service worker улетали необработанным промисом — на экране
      // при этом не менялось ничего, и нажатие выглядело просто «сделанным».
      if (attemptIdRef.current === myAttempt) {
        setError('disable_failed');
        await refreshSubscribed(address);
      }
      return false;
    } finally {
      if (attemptIdRef.current === myAttempt) setLoading(false);
    }
  }, [address, buildSignMsg, refreshSubscribed]);

  return (
    <PushContext.Provider value={{ supported, subscribed, stale, permission, loading, error, enable, disable }}>
      {children}
    </PushContext.Provider>
  );
}
