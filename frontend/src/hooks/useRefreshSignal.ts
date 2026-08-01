'use client';

import { useEffect, useRef } from 'react';
import {
  GRAPH_REFRESH_EVENT,
  subscribeRefresh,
  type RefreshTopic,
} from '@/lib/dataRefresh';

/**
 * Подписка на графовый канал шины `lib/dataRefresh`: «сабграф догнал блок
 * события, одна из моих тем протухла — перечитай».
 *
 * Только графовый. Цепной канал слушает ровно один потребитель —
 * `components/QueryRefreshBridge`, и он подписывается напрямую: react-query у
 * приложения один, отдельный хук ради одного вызова только создавал бы
 * впечатление, что где-то есть второй.
 *
 * Обработчик держится в ref'е, поэтому подписка не пересоздаётся на каждом
 * рендере родителя. Иначе каждый `setState` в компоненте снимал бы и ставил
 * слушателя заново, а между этими двумя моментами событие теряется без следа —
 * тот же класс бага, из-за которого в `useNotifications` мемоизированы
 * `args`/`onLogs` всех тринадцати наблюдателей.
 *
 * Набор тем сравнивается по строке, а не по ссылке: вызывающему не нужно
 * заворачивать литерал массива в `useMemo`.
 *
 * Обработчик ОБЯЗАН читать с `x-fresh: 1` (`FRESH_HEADERS` из
 * `lib/subgraphSync`), иначе прокси отдаст свою запись возрастом до 120 секунд
 * и ожидание индексации было напрасным.
 */
export function useGraphRefresh(
  topics: readonly RefreshTopic[],
  onRefresh: () => void,
): void {
  const cb = useRef(onRefresh);
  useEffect(() => { cb.current = onRefresh; }, [onRefresh]);

  const key = topics.join(',');
  useEffect(() => {
    if (!key) return;
    const wanted = new Set(key.split(',') as RefreshTopic[]);
    return subscribeRefresh(GRAPH_REFRESH_EVENT, (incoming) => {
      if (incoming.some((t) => wanted.has(t))) cb.current();
    });
  }, [key]);
}
