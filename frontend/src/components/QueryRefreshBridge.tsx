'use client';

import { useEffect } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import {
  CHAIN_REFRESH_EVENT,
  matcherForTopics,
  queryKeyTouches,
  subscribeRefresh,
} from '@/lib/dataRefresh';

/**
 * Мост между шиной `lib/dataRefresh` и react-query, на котором сидят все чтения
 * wagmi. Одна точка на приложение: слушатели событий шлют тему, здесь она
 * разворачивается в имена контрактных функций и инвалидируется ТОЛЬКО то, чей
 * ключ эти имена упоминает.
 *
 * Предикат, а не `invalidateQueries()` без аргументов, — принципиально. Три
 * наблюдателя в `useNotifications` (`AgreementStatusUpdated`, `JobApplied`,
 * `ServiceRequested`) подписаны на диамонд без фильтра по адресу и получают
 * логи всей биржи; отправитель отсеивает чужое сам, но цена ошибки при широкой
 * инвалидации — перечитывание вообще всего на каждое чужое действие.
 * Предикат ограничивает ущерб даже если такая ошибка просочится.
 *
 * Про `VisibilityRefresher` рядом в `providers.tsx`: он делает ровно
 * противоположное — тотальный `invalidateQueries()` по возвращению во вкладку.
 * Это осталось намеренно. Он ловит не события, а истечение времени (таймауты
 * сделки, окно спора), которое не эмитит ничего и никогда.
 */
export function QueryRefreshBridge({ queryClient }: { queryClient: QueryClient }) {
  useEffect(() => {
    return subscribeRefresh(CHAIN_REFRESH_EVENT, (topics) => {
      const matcher = matcherForTopics(topics);
      if (matcher.reads.size === 0 && matcher.roots.size === 0) return;
      queryClient.invalidateQueries({
        predicate: (query) => queryKeyTouches(query.queryKey, matcher),
      });
    });
  }, [queryClient]);

  return null;
}

export default QueryRefreshBridge;
