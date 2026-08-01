/**
 * Согласование момента: сначала сабграф догоняет блок, ПОТОМ сбрасывается кэш.
 *
 * ЗАЧЕМ. У прокси `app/api/subgraph/route.ts` запись живёт 120 секунд и отдаётся
 * по stale-while-revalidate: когда срок вышел, первая перезагрузка всё равно
 * получает старое и лишь запускает обновление в фоне, новое видит вторая. Это и
 * есть «надо всё релоадить и релоадить». Механизм сброса (`?invalidate=1`) уже
 * был, но звался В МОМЕНТ МАЙНИНГА — то есть до того, как сабграф проиндексирует
 * блок. Итог был обратен задуманному: сброс снимал старую запись, следующий
 * заход промахивался мимо кэша, шёл в сабграф, получал ВСЁ ЕЩЁ
 * непроиндексированный снимок и клал его в кэш ещё на 120 секунд. Инвалидация
 * цементировала ровно ту протухшесть, которую должна была снять.
 *
 * ЗАМЕР. Сабграф отстаёт от головы цепи на 1-3 блока (в среднем 2.13), блок
 * Base Sepolia — 2 секунды, то есть отставание 2-6 секунд. Проверка дешёвая:
 * `{ _meta { block { number } } }` против номера блока из квитанции. Прокси
 * отвечает на неё через `?meta=1` мимо основного кэша (у неё свой микрокэш на
 * секунду — меньше времени блока, так что задержки не добавляет).
 *
 * ИНВАЛИДАЦИЯ — НЕ ЕДИНСТВЕННАЯ НАДЕЖДА. У прокси глобальный кулдаун 5 секунд,
 * который молча роняет второго зовущего, а `Map` живёт в одном процессе. Поэтому
 * сброс кэша здесь — забота о ЧУЖИХ вкладках, а свою собственную свежесть
 * обеспечивает канал `graph` шины `lib/dataRefresh.ts`: подписчики перечитывают
 * с заголовком `x-fresh: 1`, который кэш прокси обходит независимо от того,
 * долетел сброс или нет.
 */

import {
  emitChainRefresh,
  emitGraphRefresh,
  type RefreshTopic,
} from '@/lib/dataRefresh';

export const SUBGRAPH_PROXY = '/api/subgraph';

/** Заголовок, которым подписчики канала `graph` обходят кэш прокси. */
export const FRESH_HEADERS = { 'x-fresh': '1' } as const;

// Опрос головы. Держится СТРОГО МЕНЬШЕ микрокэша пробы на прокси (META_TTL,
// `app/api/subgraph/route.ts`), иначе последовательные пробы одного клиента
// всегда мимо кэша и весь цикл ожидания превращается в два десятка настоящих
// запросов к сабграфу. С 900 мс против 1000 примерно половина попадает в кэш, а
// потеря свежести головы ограничена секундой — при блоке в 2 секунды это
// невидимо.
const POLL_MS = 900;
// Потолок ожидания. Замеренное отставание — 2-6 секунд; 25 секунд это
// четырёхкратный запас, после которого сабграф считается отставшим всерьёз.
const TIMEOUT_MS = 25_000;
// Потолок на ОДИН запрос. Без него зависший fetch (мёртвый туннель, потерянная
// мобильная сеть) не даёт циклу опроса дойти до проверки срока — тот стоит
// МЕЖДУ пробами, а не внутри, — и разделяемый `_headInFlight` никогда не
// снимается: одна зависшая проба выключала бы графовый канал на всю вкладку до
// таймаута сокета браузера (в Chrome это порядка пяти минут). Внешний
// AbortController обязателен: 12-секундный предохранитель в самом прокси
// защищает ЕГО исходящий запрос, а не наш запрос к нему.
const REQUEST_TIMEOUT_MS = 8_000;

export interface SyncOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  timeoutMs?: number;
}

interface ResolvedOptions {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollMs: number;
  timeoutMs: number;
}

function resolve(opts: SyncOptions = {}): ResolvedOptions {
  return {
    fetchImpl: opts.fetchImpl ?? ((...args) => fetch(...args)),
    sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: opts.now ?? Date.now,
    pollMs: opts.pollMs ?? POLL_MS,
    timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
  };
}

async function postWithDeadline(fetchImpl: typeof fetch, url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { method: 'POST', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Одновременных ожидающих может быть несколько (несколько событий в одном
// блоке, несколько компонентов на странице). Общий in-flight на пробу головы
// не даёт им превратиться в N запросов вместо одного.
let _headInFlight: Promise<number | null> | null = null;

// Незавершённые ожидания индексации, ключ — «блок × темы». См. refreshAfterBlock.
const _pendingGraph = new Map<string, Promise<void>>();

/** Номер блока, до которого сабграф доиндексировал. `null` — узнать не удалось. */
export async function readSubgraphHead(opts: SyncOptions = {}): Promise<number | null> {
  if (_headInFlight) return _headInFlight;
  const { fetchImpl } = resolve(opts);

  const probe = (async (): Promise<number | null> => {
    try {
      const res = await postWithDeadline(fetchImpl, `${SUBGRAPH_PROXY}?meta=1`);
      if (!res.ok) return null;
      const json = (await res.json()) as { block?: unknown };
      const n = Number(json?.block);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  })();

  _headInFlight = probe;
  try {
    // Ждём здесь, а не в отдельной цепочке `.finally`: тогда флаг снимается
    // ДО возврата значения вызывающему. Иначе цикл опроса в
    // `waitForSubgraphBlock` успевал зайти на второй круг раньше очистки и
    // получал ту же самую уже разрешённую пробу — то есть вечно старую голову.
    return await probe;
  } finally {
    if (_headInFlight === probe) _headInFlight = null;
  }
}

/**
 * Дождаться, что сабграф проиндексировал `target`.
 * `true` — догнал, `false` — вышло время или голову узнать не удалось.
 */
export async function waitForSubgraphBlock(
  target: bigint | number,
  opts: SyncOptions = {},
): Promise<boolean> {
  const { sleep, now, pollMs, timeoutMs } = resolve(opts);
  const want = Number(target);
  if (!Number.isFinite(want) || want <= 0) return false;

  const deadline = now() + timeoutMs;
  // Первая проба — до всякого сна: у сабграфа могло не быть отставания вовсе.
  for (;;) {
    const head = await readSubgraphHead(opts);
    if (head !== null && head >= want) return true;
    if (now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/**
 * Сбросить кэш прокси. Ответ всегда ok — у прокси кулдаун 5 секунд, и он молча
 * роняет второго зовущего, так что `true` здесь значит «запрос дошёл», а не
 * «кэш действительно очищен». Именно поэтому сброс не единственная мера.
 */
export async function invalidateSubgraphCache(opts: SyncOptions = {}): Promise<boolean> {
  const { fetchImpl } = resolve(opts);
  try {
    const res = await postWithDeadline(fetchImpl, `${SUBGRAPH_PROXY}?invalidate=1`);
    return res.ok;
  } catch {
    return false;
  }
}

export interface RefreshTopics {
  /** Читается прямо из цепи — обновляется немедленно. */
  chain?: readonly RefreshTopic[];
  /** Читается из сабграфа — обновляется после того, как он догонит блок. */
  graph?: readonly RefreshTopic[];
}

/**
 * Главная точка входа: событие произошло в блоке `blockNumber`.
 *
 * Цепные темы уходят сразу, графовые — после того как сабграф догонит.
 *
 * Если догнать не удалось (потолок ожидания), графовые темы отправляются ВСЁ
 * РАВНО: подписчики читают с `x-fresh`, то есть получают самое свежее, что
 * сабграф вообще может отдать. Альтернатива — не обновлять ничего и оставить
 * человека наедине с записью, которой гарантированно до 120 секунд, — строго
 * хуже. Сброс кэша при этом всё же делается: не сбросить его означает оставить
 * заведомо старую запись жить полный срок.
 */
export async function refreshAfterBlock(
  blockNumber: bigint | number | undefined,
  topics: RefreshTopics,
  opts: SyncOptions = {},
): Promise<void> {
  const chain = topics.chain ?? [];
  const graph = topics.graph ?? [];

  if (chain.length > 0) emitChainRefresh(chain);
  if (graph.length === 0) return;

  // Одна транзакция часто эмитит несколько интересных событий сразу
  // (acceptApplicant — это и JobAccepted, и AgreementRegistered), а слушатели
  // в useNotifications независимы и каждый попросит своё обновление. Работа с
  // одинаковым (блок × темы) склеивается: иначе на каждую такую транзакцию
  // приходилось бы по два прохода опроса головы и по два сброса кэша, из
  // которых второй прокси всё равно молча роняет по кулдауну.
  const key = `${blockNumber ?? '-'}|${[...new Set(graph)].sort().join(',')}`;
  const pending = _pendingGraph.get(key);
  if (pending) return pending;

  const run = (async () => {
    if (blockNumber !== undefined) {
      await waitForSubgraphBlock(blockNumber, opts);
    }
    await invalidateSubgraphCache(opts);
    emitGraphRefresh(graph);
  })();

  _pendingGraph.set(key, run);
  try {
    return await run;
  } finally {
    if (_pendingGraph.get(key) === run) _pendingGraph.delete(key);
  }
}

/**
 * То же самое, но от пачки логов наблюдателя событий.
 *
 * Одно обновление на пачку, а не на каждый лог: `onLogs` часто приносит
 * несколько логов одной транзакции, и это одна и та же несвежесть. Блок берётся
 * самый поздний из пачки — дождавшись его, сабграф заведомо проиндексировал и
 * остальные.
 *
 * ВАЖНО: звать строго ПОСЛЕ фильтра по адресу пользователя. Часть наблюдателей
 * подписана на диамонд без `args` и получает логи всей биржи; обновляться на
 * чужую активность значит держать постоянную нагрузку на RPC и сабграф ради
 * данных, которые на этом экране никому не нужны.
 */
export function refreshFromLogs(
  logs: readonly unknown[],
  topics: RefreshTopics,
  opts: SyncOptions = {},
): void {
  if (logs.length === 0) return;
  let block: bigint | undefined;
  for (const log of logs) {
    const n = (log as { blockNumber?: bigint }).blockNumber;
    if (typeof n === 'bigint' && (block === undefined || n > block)) block = n;
  }
  void refreshAfterBlock(block, topics, opts);
}

/** Минимум от `PublicClient`, который нужен здесь, — чтобы модуль оставался тестируемым. */
export interface ReceiptSource {
  waitForTransactionReceipt(args: {
    hash: `0x${string}`;
    timeout?: number;
  }): Promise<{ blockNumber: bigint }>;
}

/**
 * То же самое, но от хэша транзакции: сначала квитанция (её блок и есть тот,
 * которого надо дождаться от сабграфа), потом `refreshAfterBlock`.
 *
 * Звать без `await` — функция сама ничего не бросает и живёт дольше нажатия.
 */
export async function refreshAfterTx(
  client: ReceiptSource | undefined | null,
  txHash: string | undefined,
  topics: RefreshTopics,
  opts: SyncOptions = {},
): Promise<void> {
  let blockNumber: bigint | undefined;
  if (client && txHash) {
    try {
      const receipt = await client.waitForTransactionReceipt({
        hash: txHash as `0x${string}`,
        timeout: 60_000,
      });
      blockNumber = receipt?.blockNumber;
    } catch {
      // Квитанции нет — обновляемся вслепую, без ожидания индексации.
      blockNumber = undefined;
    }
  }
  await refreshAfterBlock(blockNumber, topics, opts);
}

/** Только для тестов: сбросить разделяемое состояние (in-flight пробы и ожидания). */
export function __resetSubgraphSyncState(): void {
  _headInFlight = null;
  _pendingGraph.clear();
}
