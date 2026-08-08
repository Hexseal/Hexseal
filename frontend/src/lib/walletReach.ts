/**
 * walletReach.ts — доходят ли до кошелька наши запросы на подпись.
 *
 * ─── ЗАМЕР С ЖИВОГО ТЕЛЕФОНА (Redmi по кабелю, 9 августа) ───────────────────
 *
 * Журнал страницы, дословно:
 *
 *     Error: No matching key. history: 1785667754733574
 *     Error: emitting session_request:1785667434298616 without any listeners
 *     Error: Invalid Id
 *
 * Записи сеанса WalletConnect протухли: запрос на подпись доставить НЕКОМУ.
 * Владелец: «на рэдми вообще все колом стоит, ничего не меняется».
 *
 * Что при этом видел человек: `openSession` падал ошибкой, которую мы не
 * опознаём, наружу шёл общий экран «Переписка не открылась» и кнопка
 * «повторить» — то есть предложение лечить переписку, тогда как сломано
 * ПОДКЛЮЧЕНИЕ. Сколько ни жми, будет то же.
 *
 * ─── ПОЧЕМУ НЕ В ЧАТЕ, А НА ОБЩЕМ МЬЮТЕКСЕ ──────────────────────────────────
 *
 * Беда шире чата: так же сломается любая подпись в приложении, включая сделки.
 * Все семь мест, где приложение открывает окно кошелька, проходят через
 * `withWalletLock` (`lib/walletLock.ts`) — там и стоит наблюдение. Одно место,
 * а не семь, и оно мерится через настоящую функцию (`walletReach.test.ts`).
 *
 * ─── ЧЕГО ЭТОТ ФАЙЛ НЕ ДЕЛАЕТ ───────────────────────────────────────────────
 *
 * Не лезет в библиотеку кошельков и не чинит её сеансы. Наше дело — ОПОЗНАТЬ,
 * СКАЗАТЬ и предложить переподключиться. Корень (устаревшая библиотека
 * подключения) — отдельная задача.
 *
 * И не отменяет подпись. Ни при каком вердикте. Урок 8 августа оплачен: там
 * ожидание кнопки сочли неудачей входа и убили чат за пятнадцать секунд —
 * своя починка вышла хуже дефекта.
 */

/* ──────────────────────────── что видно снаружи ────────────────────────────── */

export type WalletReach =
  /** Ничего сказать нельзя — и не надо. */
  | 'ok'
  /** Кошелёк ответил ошибкой «доставить некому». Знаем точно. */
  | 'broken'
  /** Ответа нет подозрительно долго, а страница всё это время на экране. */
  | 'quiet';

/**
 * Сколько молчания считать подозрительным.
 *
 * ⚠️ ПОРОГ ЩЕДРЫЙ НАРОЧНО, и это не осторожность. На десктопе окно расширения
 * может честно висеть минуту: человек читает, отвлёкся, вернулся. Сказать ему
 * «кошелёк не отвечает» через десять секунд — значит подтолкнуть отключить
 * работающее подключение. Цена ложного «сломано» здесь выше цены запоздавшей
 * правды: правду он всё равно узнает, а отключаться ни за что — нет.
 */
export const WALLET_QUIET_AFTER_MS = 45_000;

/* ─────────────────── опознать ошибку протухшего сеанса ─────────────────────── */

/**
 * Так WalletConnect говорит «этого сеанса больше нет».
 *
 * ⚠️ ТЕКСТЫ НЕ ВЫДУМАНЫ — они с прибора и из кода библиотеки. Разбирать
 * английский текст ошибки в этом проекте вообще-то запрещено, и запрет
 * правильный; здесь исключение названо вслух, потому что кода отказа у этих
 * ошибок НЕТ ВОВСЕ — библиотека кидает `Error` с текстом и ничем больше.
 * Единственная альтернатива — не опознавать их совсем, то есть оставить
 * человека с вечным «повторить».
 */
const UNREACHABLE_PATTERNS: readonly RegExp[] = [
  /no matching key/i,
  /invalid id/i,
  /without any listeners/i,
  /session topic doesn'?t exist/i,
  /record was recently deleted/i,
  /no matching session/i,
];

interface ErrorLike { message?: unknown; shortMessage?: unknown; cause?: unknown }

/** Разворачивает цепочку `cause`: viem и wagmi заворачивают ошибку провайдера в
 *  свою, а WalletConnect — ещё и в свою. Глубина ограничена, чтобы кольцевая
 *  ссылка не увела в бесконечный цикл. */
function texts(err: unknown, maxDepth = 5): string[] {
  const out: string[] = [];
  const seen: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; i < maxDepth && cur; i++) {
    if (typeof cur === 'string') { out.push(cur); break; }
    if (typeof cur !== 'object') break;
    if (seen.includes(cur)) break;
    seen.push(cur);
    const e = cur as ErrorLike;
    if (typeof e.message === 'string') out.push(e.message);
    if (typeof e.shortMessage === 'string') out.push(e.shortMessage);
    cur = e.cause;
  }
  return out;
}

export function isWalletUnreachableError(err: unknown): boolean {
  return texts(err).some(s => UNREACHABLE_PATTERNS.some(re => re.test(s)));
}

/* ──────────────────────────── вердикт, чистой функцией ────────────────────── */

export interface ReachInput {
  /** Когда открылось окно кошелька. `null` — не спрашивали. */
  askedAt: number | null;
  /** Ответ уже пришёл (любой — успех или отказ). */
  answered: boolean;
  /** В этой вкладке уже видели ошибку «доставить некому». */
  brokenSeen: boolean;
  /** Страница скрыта прямо сейчас. */
  hiddenNow: boolean;
  now: number;
}

/**
 * ⚠️ СКРЫТАЯ СТРАНИЦА ОТМЕНЯЕТ ВЕРДИКТ «МОЛЧИТ», и это главная строка правила.
 * Пока страница скрыта, человек как раз в приложении кошелька подтверждает
 * подпись — сказать ему «кошелёк не отвечает» было бы прямым враньём. Заодно
 * читать эту надпись в скрытой странице некому.
 */
export function reachVerdict(input: ReachInput): WalletReach {
  if (input.brokenSeen) return 'broken';
  if (input.askedAt === null || input.answered) return 'ok';
  if (input.hiddenNow) return 'ok';
  return input.now - input.askedAt >= WALLET_QUIET_AFTER_MS ? 'quiet' : 'ok';
}

/* ──────────────────────────── наблюдение ──────────────────────────────────── */

let _askedAt: number | null = null;
let _pending = 0;
let _brokenSeen = false;
const _listeners = new Set<() => void>();

function tell(): void {
  for (const fn of _listeners) {
    try { fn(); } catch { /* один плохой слушатель не ломает остальных */ }
  }
}

export function subscribeWalletReach(fn: () => void): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

/** Открывается окно кошелька. Зовёт `withWalletLock` — единственная дорога. */
export function noteWalletAsk(now: number = Date.now()): void {
  _pending++;
  // Метка — от ПЕРВОГО незакрытого вопроса: очередь у мьютекса общая, и
  // человек ждёт с того момента, как началось ожидание, а не последнего в ней.
  if (_askedAt === null) _askedAt = now;
}

/**
 * Ответ пришёл. `err` — если ответом был отказ.
 *
 * Успешный ответ СНИМАЕТ прежний диагноз: переподключился, подписал — надпись
 * обязана уйти сама, иначе она останется на экране навсегда.
 */
export function noteWalletAnswer(err?: unknown): void {
  _pending = Math.max(0, _pending - 1);
  if (_pending === 0) _askedAt = null;
  const wasBroken = _brokenSeen;
  if (err === undefined) {
    _brokenSeen = false;
  } else if (isWalletUnreachableError(err)) {
    _brokenSeen = true;
  }
  // Говорим всегда, когда что-то изменилось: и о поломке, и о её снятии, и о
  // том, что ожидание кончилось (надпись «молчит» держалась на времени).
  if (wasBroken !== _brokenSeen || _pending === 0) tell();
}

function pageHidden(): boolean {
  const doc = (globalThis as { document?: { visibilityState?: string } }).document;
  return !!doc && doc.visibilityState === 'hidden';
}

export function walletReach(now: number = Date.now()): WalletReach {
  return reachVerdict({
    askedAt: _askedAt, answered: _pending === 0, brokenSeen: _brokenSeen,
    hiddenNow: pageHidden(), now,
  });
}

/** Диагноз снят рукой человека — он нажал «переподключить». */
export function clearWalletReach(): void {
  _brokenSeen = false;
  tell();
}

/** Только для замеров. */
export function _resetWalletReachForTest(): void {
  _askedAt = null;
  _pending = 0;
  _brokenSeen = false;
  _listeners.clear();
}
