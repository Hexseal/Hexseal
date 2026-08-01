/**
 * Шина «что-то произошло — перечитай именно это».
 *
 * ЗАЧЕМ. Экран обновлялся по таймингу: сабграф-прокси держит запись 120 секунд
 * (`app/api/subgraph/route.ts`), у react-query `staleTime` 8 секунд, у страницы
 * сделки свой `refetchInterval`. Чужое действие (контрагент активировал сделку)
 * до экрана не доезжало вовсе — приходило только уведомление, а данные под ним
 * оставались прежними до возвращения во вкладку. Слушатели событий в
 * `hooks/useNotifications.ts` уже ловили ровно эти переходы и кормили только
 * колокольчик; здесь они получают вторую точку выхода — в данные.
 *
 * ДВА КАНАЛА, А НЕ ОДИН. Цепь и сабграф свежеют в разное время:
 *
 *  - `chain` — читается напрямую с ноды (wagmi/react-query). Событие уже в
 *    блоке, значит читать можно НЕМЕДЛЕННО.
 *  - `graph` — читается из сабграфа через кэширующий прокси. Сабграф отстаёт
 *    от головы цепи на 1-3 блока (замер: в среднем 2.13, блок Base Sepolia —
 *    2 с). Перечитать сразу — значит положить в кэш прокси ещё не
 *    проиндексированный снимок и зацементировать его на 120 секунд. Ждать
 *    индексации умеет `lib/subgraphSync.ts`, он же и шлёт этот канал.
 *
 * Отправитель обязан выбирать канал осознанно: `emitChainRefresh` — сразу,
 * `refreshAfterBlock`/`refreshAfterTx` из `subgraphSync` — когда затронут
 * сабграф.
 *
 * ТОЧЕЧНОСТЬ. Тема (`RefreshTopic`) разворачивается в список имён контрактных
 * функций; в react-query инвалидируется только то, чей ключ эти имена
 * упоминает. Широкий `queryClient.invalidateQueries()` без предиката здесь
 * недопустим: три из тринадцати слушателей в `useNotifications` не
 * отфильтрованы по адресу на уровне RPC (`AgreementStatusUpdated`,
 * `JobApplied`, `ServiceRequested` приходят от всей биржи), и глобальная
 * инвалидация превратила бы чужую активность в постоянный поток перечитываний.
 * Фильтр по адресу отправитель применяет сам, ДО вызова emit.
 */

export type RefreshTopic =
  | 'deals'     // сделки: список, детали, репутация/XP (меняется при завершении)
  | 'jobs'      // доска заказов: карточки, отклики, чеки
  | 'services'  // доска услуг
  | 'requests'  // запросы на услугу (executor-flow)
  | 'arbiter'   // реестр арбитров, очередь споров
  | 'wallet';   // баланс/allowance USDC

export const CHAIN_REFRESH_EVENT = 'hexseal-refresh-chain';
export const GRAPH_REFRESH_EVENT = 'hexseal-refresh-graph';

/**
 * Тема → имена контрактных функций, которые она делает несвежими.
 *
 * Ключ react-query у wagmi — `['readContract', { address, functionName, args }]`
 * либо `['readContracts', { contracts: [{ functionName, ... }] }]` (abi из ключа
 * вырезан, см. `@wagmi/core/query/readContract.js`). Поэтому сопоставление идёт
 * по `functionName`, а не по адресу: одно и то же имя на одном диамонде — это
 * всегда одни и те же данные.
 *
 * Список намеренно ведётся руками, а не выводится из ABI: половина имён в ABI
 * — записи, их инвалидировать нечего, а лишнее имя здесь стоит целого лишнего
 * RPC-запроса на каждое событие.
 */
export const TOPIC_READS: Record<RefreshTopic, readonly string[]> = {
  deals: [
    // Реестр сделок
    'getByClient', 'getByExecutor', 'totalAgreements',
    // Клон сделки
    'getDetails', 'timeLeft', 'arbiterTimeLeft', 'status', 'totalPayout',
    'nextExtraId', 'getExtra', 'clientResponded', 'executorResponded',
    'disputedAt', 'resolvedAt', 'amount', 'client', 'executor', 'tokenURI',
    // Экономика спора по конкретной сделке
    'getDisputeBounty', 'getRefundableBounty', 'getDisputeClaimer',
    // Репутация — начисляется в _complete, то есть ровно на терминальном переходе
    'getXP', 'getCleanStreak', 'getUnresolvedDisputes',
  ],
  jobs: [
    'getJob', 'getClientJobs', 'getApplicants',
    'getTokenIdByJobId', 'getJobReceiptData',
  ],
  services: [
    'getService', 'getExecutorServices', 'totalServices',
  ],
  requests: [
    'getRequest', 'getClientRequests', 'getServiceRequests', 'getPendingRequests',
    'totalRequests', 'getMaxPendingRequests', 'hasActivePair', 'getActivePair',
  ],
  arbiter: [
    'getArbiters', 'getDisputed', 'getArbiterDeals', 'getPendingVerdict',
    'getDisputeClaimer', 'isRegisteredArbiter', 'getArbiterReward',
    'getChiefArbiter', 'arbiterTimeLeft',
  ],
  wallet: [
    'balanceOf', 'allowance',
  ],
};

/** Развернуть набор тем в множество имён функций. */
export function readsForTopics(topics: Iterable<RefreshTopic>): Set<string> {
  const out = new Set<string>();
  for (const topic of topics) {
    const names = TOPIC_READS[topic];
    if (!names) continue;
    for (const n of names) out.add(n);
  }
  return out;
}

// Ключ react-query — произвольная структура, и в ней лежат bigint'ы (args), из-за
// которых JSON.stringify бросает. Поэтому обход рекурсивный и ручной, с
// ограничением глубины и защитой от циклов.
const MAX_KEY_DEPTH = 6;

/** Собрать все значения поля `functionName`, встречающиеся в ключе запроса. */
export function collectFunctionNames(queryKey: unknown): Set<string> {
  const out = new Set<string>();
  const seen = new Set<object>();

  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_KEY_DEPTH || node === null || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'functionName' && typeof v === 'string') out.add(v);
      else walk(v, depth + 1);
    }
  };

  walk(queryKey, 0);
  return out;
}

/** Затрагивает ли этот ключ запроса хоть одно из перечисленных чтений. */
export function queryKeyTouches(queryKey: unknown, reads: Set<string>): boolean {
  if (reads.size === 0) return false;
  for (const name of collectFunctionNames(queryKey)) {
    if (reads.has(name)) return true;
  }
  return false;
}

// ─── Отправка ────────────────────────────────────────────────────────────────

function emit(eventName: string, topics: readonly RefreshTopic[]): void {
  if (typeof window === 'undefined') return;
  const unique = Array.from(new Set(topics));
  if (unique.length === 0) return;
  window.dispatchEvent(new CustomEvent(eventName, { detail: { topics: unique } }));
}

/**
 * Данные в цепи уже новые — перечитать чтения этих тем прямо сейчас.
 * Для тем, которые читаются из сабграфа, звать НЕЛЬЗЯ: см. шапку файла,
 * используйте `refreshAfterBlock`/`refreshAfterTx`.
 */
export function emitChainRefresh(topics: readonly RefreshTopic[]): void {
  emit(CHAIN_REFRESH_EVENT, topics);
}

/**
 * Сабграф догнал нужный блок — можно перечитывать графовые запросы.
 * Прямых вызовов быть не должно, кроме как из `lib/subgraphSync.ts`.
 */
export function emitGraphRefresh(topics: readonly RefreshTopic[]): void {
  emit(GRAPH_REFRESH_EVENT, topics);
}

// ─── Подписка ────────────────────────────────────────────────────────────────

export function subscribeRefresh(
  eventName: string,
  handler: (topics: RefreshTopic[]) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent).detail as { topics?: RefreshTopic[] } | undefined;
    const topics = detail?.topics;
    if (Array.isArray(topics) && topics.length > 0) handler(topics);
  };
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
}
