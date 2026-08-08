'use client';

/**
 * useWalletReach — доходят ли до кошелька запросы на подпись, и выход одним
 * нажатием, если не доходят.
 *
 * Всё, что может быть неверным, живёт вне React и замерено:
 *  • опознание протухшего сеанса и вердикт — `lib/walletReach.ts`;
 *  • какие записи сносить и каких не касаться — `lib/staleStorage.ts`.
 * Здесь только подписка и три вызова по нажатию.
 *
 * ⚠️ ЧЕГО ЗДЕСЬ НЕТ. Мы НЕ лезем в библиотеку кошельков и не чиним её сеансы
 * своими руками: сначала штатный `disconnect()` — пусть она разберёт сеанс сама,
 * — и только потом уборка ПРОТУХШИХ записей, которые она за собой оставила.
 * Записи самой wagmi не трогаются вовсе.
 */

import { useCallback, useEffect, useState } from 'react';
import { useDisconnect } from 'wagmi';
import { walletReach, subscribeWalletReach, clearWalletReach, type WalletReach } from '@/lib/walletReach';
import { dropWalletSession } from '@/lib/staleStorage';
import { useConnectWallet } from '@/hooks/useConnectWallet';

export interface WalletReachHandle {
  reach: WalletReach;
  /** Переподключить кошелёк: отключить, убрать протухшие записи, подключить. */
  reconnect: () => Promise<void>;
  reconnecting: boolean;
}

/** Порог «кошелёк молчит» держится на времени, а не на событии, — значит его
 *  надо переспрашивать. Раз в пять секунд: надпись появляется на сорок пятой,
 *  и точность до секунды здесь никому не нужна. */
const REACH_TICK_MS = 5_000;

export function useWalletReach(): WalletReachHandle {
  const { disconnectAsync } = useDisconnect();
  const { connect } = useConnectWallet();
  const [reach, setReach] = useState<WalletReach>(() => walletReach());
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    const read = () => setReach(prev => {
      const next = walletReach();
      return prev === next ? prev : next;
    });
    read();
    const stop = subscribeWalletReach(read);
    const id = setInterval(read, REACH_TICK_MS);
    return () => { stop(); clearInterval(id); };
  }, []);

  const reconnect = useCallback(async () => {
    setReconnecting(true);
    try {
      // 1. Штатное отключение — библиотека разбирает сеанс сама.
      try { await disconnectAsync(); } catch { /* уже отключён — не беда */ }
      // 2. Протухшие записи сеанса. ТОЛЬКО по этому нажатию и только их:
      //    отбор и замок «наши ключи не трогать» — в `lib/staleStorage.ts`.
      try {
        dropWalletSession(typeof window !== 'undefined' ? window.localStorage : null);
      } catch { /* хранилище заперто — переподключение всё равно попробуем */ }
      // 3. Диагноз снят рукой человека: дальше судить будет новая подпись.
      clearWalletReach();
      // 4. И сразу предложить подключиться — иначе человек остаётся с пустой
      //    шапкой и без единой подсказки, что делать дальше.
      connect();
    } finally {
      setReconnecting(false);
    }
  }, [disconnectAsync, connect]);

  return { reach, reconnect, reconnecting };
}

/**
 * Только признак «кошелёк не отвечает» — без действия.
 *
 * Отдельным хуком, потому что показывать это надо там, где ДЕЙСТВИЯ нет:
 * `ChatSignatureWanted` живёт и в панели, и в списке, и тащить туда `disconnect`
 * с подключением значило бы завести второй маршрут подключения (структурный
 * гейт `lib/connectWallet.test.ts` держит, что он один). Выход — пункт меню
 * кошелька, там же, где отключение: это про кошелёк, а не про чат.
 */
export function useWalletReachState(): boolean {
  const [bad, setBad] = useState(() => walletReach() !== 'ok');
  useEffect(() => {
    const read = () => setBad(prev => {
      const next = walletReach() !== 'ok';
      return prev === next ? prev : next;
    });
    read();
    const stop = subscribeWalletReach(read);
    const id = setInterval(read, REACH_TICK_MS);
    return () => { stop(); clearInterval(id); };
  }, []);
  return bad;
}
