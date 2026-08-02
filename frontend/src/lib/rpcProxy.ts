/**
 * Разбор отказов RPC-прокси (`app/api/rpc/route.ts`) — отдельно от самого
 * маршрута, чтобы проверяться тестами без сети.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ ПОЯВИЛСЯ. 2 августа 2026 у владельца пропала роль арбитра:
 * вкладка «Арбитр» исчезла из шапки, пункты арбитра — из меню кошелька. На
 * цепи `isRegisteredArbiter` возвращал `true`, ручной `fetch` к `/api/rpc` из
 * того же браузера — тоже `true`, баланс USDC в том же меню показывался верно.
 * В консоли при этом лежал одинокий `POST /api/rpc → 502`. То есть прокси
 * отдавал 502 С ПЕРЕБОЯМИ, и на упавшее чтение попала именно роль.
 *
 * Разобраться, ПОЧЕМУ приходил 502, было нечем: в маршруте стоял пустой
 * `catch {}` — приватный узел мог отвалиться по таймауту или по сети, и в
 * журнале не оставалось ни строчки. Диагностика упёрлась в тишину, и это
 * повторилось бы в следующий раз.
 *
 * ЧТО ЗДЕСЬ. Три вещи, каждая — чистая функция:
 *  • `rpcHostLabel` — как называть узел в журнале, НИКОГДА не целиком;
 *  • `classifyFetchFailure` — что именно случилось с `fetch`, и был ли это
 *    таймаут (от этого зависит, имеет ли смысл повтор);
 *  • `shouldRetryPrivate` — стоит ли дать приватному узлу второй шанс;
 *  • `describeRpcCall` / `formatAttempts` — человекочитаемый след для журнала
 *    и для тела ответа 502.
 *
 * ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ: `fetch`, адресов узлов и чтения окружения. Всё
 * приходит аргументами — иначе модуль не проверить без сети.
 */

/* ────────────────────────── адреса в журнале ────────────────────────── */

/**
 * Как называть узел в журнале.
 *
 * ⚠️ ГЛАВНОЕ ПРАВИЛО ФАЙЛА. `DRPC_URL` содержит ключ доступа прямо в адресе
 * (`…drpc.live/…?dkey=<ключ>`). Журнал контейнера читают, пересылают и
 * вставляют в тикеты — полный адрес в нём равносилен утечке платного ключа.
 * Поэтому наружу отдаётся ТОЛЬКО имя хоста: его достаточно, чтобы отличить
 * «отвалился платный узел» от «отвалился публичный», и в нём нет секрета.
 *
 * Разбор через `URL` намеренно, а не обрезка строки: `dkey` может приехать и
 * в пути, и в фрагменте, и в basic-auth (`https://user:pass@host/`) — во всех
 * этих случаях `hostname` остаётся чистым, а любая ручная резка рано или
 * поздно пропустит форму, которой не ждали.
 */
export function rpcHostLabel(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    // Не разобралось как URL — сказать про этот адрес нечего, и уж точно
    // нельзя выводить его как есть: именно неразобравшаяся строка с наибольшей
    // вероятностью и есть что-то странное с ключом внутри.
    return '<не-URL>';
  }
}

/* ───────────────────────── классификация отказа ─────────────────────── */

export interface FetchFailure {
  /** Отказ по времени: узел не ответил за отведённый срок. */
  timeout: boolean;
  /** Читаемое описание для журнала — вся цепочка `cause`, а не верхушка. */
  message: string;
}

/**
 * Имена и коды, означающие «время вышло».
 *
 * Их несколько, потому что таймаут прилетает из трёх слоёв: `AbortSignal.timeout()`
 * даёт `DOMException` с именем `TimeoutError` (в Node постарше — `AbortError`),
 * а undici (наш `fetch` внутри Node) добавляет свои — на соединение, на
 * заголовки и на тело. Ловить надо все: разница между «узел молчал» и «узел
 * отказал» решает, повторять ли запрос.
 */
const TIMEOUT_NAMES = new Set([
  'TimeoutError',
  'AbortError',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
]);
const TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
]);

/** Насколько глубоко идти по `cause`. Больше трёх звеньев в природе не
 *  встречается, а бесконечный цикл на самоссылающемся `cause` встречается. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Что именно случилось с `fetch`.
 *
 * ПОЧЕМУ НЕ ПРОСТО `String(err)`. Node на любой сетевой сбой отдаёт
 * `TypeError: fetch failed`, и это ровно та строка, из-за которой в журнале
 * нельзя отличить «DNS не разрешился» от «соединение сбросили» от «узел
 * недоступен». Настоящая причина лежит в `err.cause` — и иногда на два звена
 * глубже. Поэтому собираем всю цепочку.
 */
export function classifyFetchFailure(err: unknown): FetchFailure {
  const parts: string[] = [];
  let timeout = false;

  let current: unknown = err;
  const seen = new Set<unknown>();

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth++) {
    if (typeof current === 'object') {
      if (seen.has(current)) break; // самоссылающийся cause — видели, хватит
      seen.add(current);
    }

    const e = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    const name = typeof e.name === 'string' ? e.name : '';
    const code = typeof e.code === 'string' ? e.code : '';
    const message = typeof e.message === 'string' ? e.message : '';

    if (TIMEOUT_NAMES.has(name) || TIMEOUT_CODES.has(code)) timeout = true;

    if (name || message || code) {
      const codeTag = code && code !== name ? ` [${code}]` : '';
      parts.push(`${name || 'Error'}${codeTag}${message ? `: ${message}` : ''}`);
    } else if (depth === 0) {
      // Бросили не-ошибку (строку, число) — так тоже бывает.
      parts.push(String(current));
    }

    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }

  return {
    timeout,
    message: parts.length ? parts.join(' ← ') : 'неизвестный сбой fetch',
  };
}

/* ─────────────────────────── повтор приватного ──────────────────────── */

/**
 * Сколько времени должно было пройти, чтобы повтор приватного узла уже НЕ имел
 * смысла. Смысл порога — сохранить общий бюджет маршрута доказуемо целым:
 * 2 с (быстрый отказ) + 3 с (повтор) + 3 × 4 с (публичные) = 17 с, что меньше
 * прежних 18 с. Без порога отказ на 5.9-й секунде плюс повтор увёл бы за 20 с.
 */
export const PRIVATE_RETRY_MAX_ELAPSED_MS = 2_000;

export interface PrivateOutcome {
  /** HTTP-код, если узел ответил кодом. */
  status?: number;
  /** Отказ по времени (из `classifyFetchFailure`). */
  timeout?: boolean;
}

/**
 * Давать ли приватному узлу второй шанс перед уходом на публичный пул.
 *
 * ЗАЧЕМ ВООБЩЕ ПОВТОР. Одна страница борда с подключённым кошельком отправляет
 * в прокси десятки чтений. Если приватный узел моргает с вероятностью p на
 * запрос, то без повтора доля чтений, свалившихся на публичный пул (а оттуда —
 * в 502), равна p; с одним повтором она падает до p² — при p = 5 % это 5 % → 0.25 %.
 * Ровно этот класс и убил роль арбитра: одно чтение из многих попало на моргание.
 *
 * ТРИ ПРАВИЛА, И ВСЕ ТРИ — ПРОТИВ ВРЕДА ОТ ПОВТОРА:
 *
 *  1. **Таймаут не повторяем.** Шесть секунд уже потрачены, узел заведомо
 *     перегружен или недоступен; ещё один заход в ту же стену отнимает бюджет
 *     у публичных запасных, которые ответили бы. Тут повтор делает хуже.
 *  2. **429 / 4xx не повторяем.** 429 — это ограничение по частоте, и повтор
 *     в лоб превращается в шторм повторов ровно по тому лимиту, который уже
 *     превышен. 401/402/403 — ключ, квота, оплата: завтра то же самое, сегодня
 *     повтор бессмысленен. Повторяем только 5xx — «у узла временно плохо».
 *  3. **Медленный отказ не повторяем.** См. `PRIVATE_RETRY_MAX_ELAPSED_MS`:
 *     бюджет маршрута важнее второго шанса.
 *
 * Быстрый сетевой сбой (сброшенное соединение, отвалившийся DNS) повторяем —
 * это и есть та самая транзиентная рябь, ради которой всё написано.
 */
export function shouldRetryPrivate(outcome: PrivateOutcome, elapsedMs: number): boolean {
  if (elapsedMs >= PRIVATE_RETRY_MAX_ELAPSED_MS) return false; // правило 3
  if (outcome.timeout) return false;                            // правило 1
  if (outcome.status !== undefined) return outcome.status >= 500; // правило 2
  return true; // быстрый сетевой сбой
}

/* ────────────────────────── описание вызова ─────────────────────────── */

/**
 * Как назвать сам JSON-RPC вызов в журнале.
 *
 * ЗАЧЕМ. Без этого строка «приватный узел отказал» не отвечает на главный
 * вопрос расследования — КАКОЕ чтение упало. Именно он и стоял 2 августа:
 * баланс приехал, роль нет, и понять по журналу, что упавшим был `eth_call`
 * роли, было невозможно.
 *
 * ⚠️ Параметры НЕ логируем: в `eth_call` лежит calldata на сотни байт, а в
 * `eth_sendRawTransaction` — подписанная транзакция целиком. Метод и id — всё,
 * что нужно для сопоставления, и ничего сверх.
 */
export function describeRpcCall(body: unknown): string {
  if (Array.isArray(body)) {
    const methods = body.map(item => methodOf(item));
    const counted = new Map<string, number>();
    for (const m of methods) counted.set(m, (counted.get(m) ?? 0) + 1);
    const summary = [...counted.entries()]
      .map(([m, n]) => (n > 1 ? `${m} ×${n}` : m))
      .join(', ');
    return `batch(${body.length}): ${summary || '—'}`;
  }
  const method = methodOf(body);
  const id = (body as { id?: unknown })?.id;
  return id === undefined || id === null ? method : `${method}#${String(id)}`;
}

function methodOf(item: unknown): string {
  const m = (item as { method?: unknown })?.method;
  return typeof m === 'string' && m ? m : '<без метода>';
}

/* ─────────────────────────── след попыток ───────────────────────────── */

export interface RpcAttempt {
  /** Как звать этот узел наружу: `private` или полный публичный URL.
   *  Приватный НИКОГДА не подписывается адресом — см. `rpcHostLabel`. */
  target: string;
  /** Чем ответил. */
  outcome: 'status' | 'timeout' | 'network';
  status?: number;
  error?: string;
  ms: number;
}

/**
 * Свести попытки в одну строку для тела 502.
 *
 * Этот текст читает человек в консоли браузера. Прежний ответ содержал только
 * `lastErr` — сообщение ПОСЛЕДНЕГО публичного запасного, из которого нельзя
 * было узнать ни сколько кандидатов пробовали, ни что ответил приватный, ни
 * упёрлись мы в таймауты или в коды. Теперь — все попытки по порядку.
 */
export function formatAttempts(attempts: RpcAttempt[]): string {
  if (!attempts.length) return 'ни одного кандидата не настроено';
  return attempts
    .map(a => {
      const what =
        a.outcome === 'status' ? `HTTP ${a.status}`
        : a.outcome === 'timeout' ? `таймаут${a.error ? ` (${a.error})` : ''}`
        : `сеть: ${a.error ?? 'без описания'}`;
      return `${a.target} → ${what} за ${a.ms} мс`;
    })
    .join('; ');
}
