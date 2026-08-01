'use client';

import { useEffect, useRef } from 'react';
import {
  CHAIN_REFRESH_EVENT,
  GRAPH_REFRESH_EVENT,
  subscribeRefresh,
  type RefreshTopic,
} from '@/lib/dataRefresh';

/**
 * Подписка на шину `lib/dataRefresh`: «одна из моих тем протухла — перечитай».
 *
 * Обработчик держится в ref'е, поэтому подписка не пересоздаётся на каждом
 * рендере родителя — в противном случае каждый вызов `setState` в компоненте
 * снимал бы и ставил слушателя заново, а между этими двумя моментами событие
 * теряется без следа (тот же класс бага, из-за которого в `useNotifications`
 * мемоизированы `args`/`onLogs` всех тринадцати наблюдателей).
 *
 * Набор тем сравнивается по строке, а не по ссылке: вызывающему не нужно
 * заворачивать литерал массива в `useMemo`.
 */
function useRefreshSignal(
  eventName: string,
  topics: readonly RefreshTopic[],
  onRefresh: () => void,
): void {
  const cb = useRef(onRefresh);
  useEffect(() => { cb.current = onRefresh; }, [onRefresh]);

  const key = topics.join(',');
  useEffect(() => {
    if (!key) return;
    const wanted = new Set(key.split(',') as RefreshTopic[]);
    return subscribeRefresh(eventName, (incoming) => {
      if (incoming.some((t) => wanted.has(t))) cb.current();
    });
  }, [eventName, key]);
}

/** Данные из цепи (wagmi/react-query) — событие уже в блоке, читать можно сразу. */
export function useChainRefresh(topics: readonly RefreshTopic[], onRefresh: () => void): void {
  useRefreshSignal(CHAIN_REFRESH_EVENT, topics, onRefresh);
}

/**
 * Данные из сабграфа — сигнал приходит только после того, как сабграф догнал
 * блок события (см. `lib/subgraphSync`). Обработчик обязан читать с
 * `x-fresh: 1`, иначе прокси отдаст свою запись и ожидание было напрасным.
 */
export function useGraphRefresh(topics: readonly RefreshTopic[], onRefresh: () => void): void {
  useRefreshSignal(GRAPH_REFRESH_EVENT, topics, onRefresh);
}
