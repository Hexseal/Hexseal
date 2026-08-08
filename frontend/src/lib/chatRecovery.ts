/**
 * chatRecovery.ts — всё, что можно ошибиться в показе кода восстановления.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. У фронта нет ни jsdom, ни @testing-library
 * (см. шапку `vitest.config.mjs`): отрисовать окно и понажимать в нём нечем.
 * Дисциплина та же, что в `useChatSession.ts` — всё, что может быть неверным,
 * живёт здесь чистыми функциями и заперто `chatRecovery.test.ts`, а компонент
 * сведён к разметке и вызовам. Всё, что нельзя проверить, обязано быть
 * тривиальным.
 *
 * ЧТО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ:
 *  - НЕ хранит код. Код живёт в `WeakMap` внутри `chatSession.ts` и в записи
 *    IndexedDB рядом с закрытым ключом. Сюда он приезжает вызовом и наружу
 *    возвращается значением — ни одной переменной модуля с кодом здесь нет.
 *  - НЕ пишет код никуда. В `localStorage` кладётся ЕДИНИЦА — отметка «этот
 *    адрес свой код записал», и ничего больше (заперто тестом, который
 *    обходит весь склад целиком).
 *  - НЕ логирует. Ни одного `console.` — гейт `chatRecoveryHygiene.test.ts`.
 */

import {
  RECOVERY_WORD_COUNT,
  normalizeRecoveryCode,
  exportRecoveryCode,
  type ChatSession,
} from './chatSession';

/**
 * Сколько слов из двенадцати спрашиваем, чтобы поверить, что код записан.
 *
 * Три — решение владельца, и у обеих границ есть причина. Меньше — можно
 * угадать, глядя на только что показанный экран. Все двенадцать раздражают,
 * и человек начинает не записывать, а копировать в буфер и вставлять обратно
 * — то есть проверка перестаёт проверять то, ради чего заведена.
 */
export const RECOVERY_CHECK_WORDS = 3;

/** Приставка ключа отметки «записал». Экспортирована, чтобы тест сверялся с
 *  ней напрямую, а не задваивал строку литералом. */
export const RECOVERY_CONFIRMED_PREFIX = 'hexseal-chat-recovery-written';

/* ────────────────────────── разбор кода ───────────────────────────────── */

export type RecoveryShape =
  | { ok: true; words: string[] }
  /** `empty` — показывать нечего вовсе; `word_count` — слов не двенадцать. */
  | { ok: false; reason: 'empty' | 'word_count' };

/**
 * Вердикт о годности кода к показу — ВЕРДИКТ, а не исключение.
 *
 * Вход сюда приходит из хука, то есть в конечном счёте из записи на
 * устройстве, которую мог испортить кто угодно (правка через отладчик,
 * недописанная запись, чужая версия формата). Падение на этом пути стоило бы
 * человеку всего экрана; отказ показать окно — только окна.
 */
export function inspectRecoveryCode(code: unknown): RecoveryShape {
  if (typeof code !== 'string' || code.trim().length === 0) {
    return { ok: false, reason: 'empty' };
  }
  const words = normalizeRecoveryCode(code).split(' ');
  if (words.length !== RECOVERY_WORD_COUNT) return { ok: false, reason: 'word_count' };
  return { ok: true, words };
}

/* ─────────────────────── номера слов для проверки ─────────────────────── */

export interface PickOptions {
  /** Источник случайности. Параметр существует ради тестов: показ берёт
   *  `Math.random`. */
  random?: () => number;
  total?: number;
  count?: number;
}

/**
 * Три РАЗНЫХ номера слова, по возрастанию, 1-based.
 *
 * Разные — через отбрасывание повторов, а не через «взять три раза»: на
 * повторяющейся случайности наивный вариант спросил бы одно и то же слово
 * трижды, и проверка доказывала бы втрое меньше, чем обещает.
 *
 * По возрастанию — чтобы человек шёл по бумажке сверху вниз, а не прыгал.
 */
export function pickCheckPositions(opts: PickOptions = {}): number[] {
  const random = opts.random ?? Math.random;
  const total = opts.total ?? RECOVERY_WORD_COUNT;
  const count = Math.min(opts.count ?? RECOVERY_CHECK_WORDS, total);

  // Частичное перемешивание Фишера — Йетса: `count` разных номеров за
  // `count` шагов, без цикла «тяни, пока не попадётся новый» (тот на
  // вырожденной случайности не заканчивается вовсе).
  const pool = Array.from({ length: total }, (_, i) => i + 1);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (total - i));
    // `random()` ровно 1 (или больше — источник чужой) вывел бы индекс за
    // край; зажимаем, а не верим.
    const safe = Math.min(j, total - 1);
    [pool[i], pool[safe]] = [pool[safe], pool[i]];
  }
  return pool.slice(0, count).sort((a, b) => a - b);
}

/* ──────────────────────────── сверка ──────────────────────────────────── */

export type RecoveryCheck =
  | { ok: true }
  /** Номер ПЕРВОГО несошедшегося слова, 1-based. Человеку говорится именно
   *  он: «слово 7 не совпало», а не «неверно» — иначе он перебирает вслепую
   *  три поля вместо одного. */
  | { ok: false; failed: number };

/**
 * Сверяет вписанные слова с настоящими.
 *
 * Нормализация — ТА ЖЕ, что у ввода кода целиком (`chatSession.ts`): регистр,
 * лишние пробелы и полноширинные буквы восточных раскладок прощаются. Своя
 * копия правил здесь означала бы, что код, принятый при восстановлении,
 * отвергается при проверке — и наоборот.
 *
 * Сверяется СЛОВО НА СВОЁМ МЕСТЕ, а не наличие слова в коде: `includes`
 * пропустил бы человека, который переписал двенадцать слов в другом порядке
 * — то есть переписал не тот код.
 */
export function checkRecoveryAnswers(
  words: readonly string[],
  positions: readonly number[],
  answers: Readonly<Record<number, string>>,
): RecoveryCheck {
  for (const position of [...positions].sort((a, b) => a - b)) {
    const expected = words[position - 1];
    // Номер за пределами кода — отказ, а не совпадение двух `undefined`.
    if (typeof expected !== 'string') return { ok: false, failed: position };
    const given = answers[position];
    if (typeof given !== 'string') return { ok: false, failed: position };
    if (normalizeRecoveryCode(given) !== normalizeRecoveryCode(expected)) {
      return { ok: false, failed: position };
    }
  }
  return { ok: true };
}

/* ────────────────────── кому положен код ──────────────────────────────── */

/**
 * Есть ли у этого сеанса код, который вообще можно показать.
 *
 * Обычный кошелёк (в том числе делегированный EIP-7702 — он опознан по
 * подписи как `eoa`) сюда не проходит НИКОГДА: его восстановление — сам
 * кошелёк, а двенадцатисловный код срезал бы стойкость его ключа вчетверо
 * (разбор — в шапке `chatSession.ts`).
 *
 * Оба условия, а не одно: тот же приём защиты в глубину, что в
 * `exportRecoveryCode`, и сказано это прямо — несущее здесь `walletKind`.
 */
export function hasRecoveryCode(session: ChatSession | null | undefined): boolean {
  return !!session && session.origin === 'recovery' && session.walletKind === 'contract';
}

/**
 * Код сеанса или `null`. Наружу НЕ бросает: `exportRecoveryCode` отказывает
 * `recovery_code_unavailable`, если объект сеанса собран не самим
 * `chatSession.ts` (пережил перезагрузку модуля, приехал из чужого места).
 * Окна в этом случае не будет — но и падения экрана тоже.
 */
export function readRecoveryCode(session: ChatSession | null | undefined): string | null {
  if (!hasRecoveryCode(session)) return null;
  try {
    return exportRecoveryCode(session as ChatSession);
  } catch {
    return null;
  }
}

/* ──────────────── отметка «записал» и напоминание ─────────────────────── */

export function recoveryConfirmedKey(address: string): string {
  return `${RECOVERY_CONFIRMED_PREFIX}-${address.toLowerCase()}`;
}

/**
 * Отмечал ли этот адрес, что код записан.
 *
 * ⚠️ В `localStorage` кладётся ТОЛЬКО единица. Сам код туда не попадает
 * никогда — это самое обшариваемое место в браузере (разбор — в шапке
 * `chatSession.ts`), и класть туда двенадцать слов значило бы отменить всю
 * причину, по которой ключ лежит в IndexedDB.
 *
 * Отказ хранилища читается как «не подтверждал»: напоминание лишний раз —
 * дешевле, чем молчание.
 */
export function isRecoveryConfirmed(address: string | null | undefined): boolean {
  if (!address) return false;
  try {
    return localStorage.getItem(recoveryConfirmedKey(address)) === '1';
  } catch {
    return false;
  }
}

export function markRecoveryConfirmed(address: string | null | undefined): void {
  if (!address) return;
  try {
    localStorage.setItem(recoveryConfirmedKey(address), '1');
  } catch {
    // Приватный режим, кончившаяся квота. Человек своё дело сделал —
    // ронять его на записи флага нельзя. Цена: напоминание вернётся.
  }
}

/**
 * Снимает отметку — зовётся, когда сеанс выдал НОВЫЙ код.
 *
 * ⚠️ Без этого возвращается ровно тот дефект, ради которого задача заведена.
 * Отметка живёт в `localStorage`, а ключ — в `IndexedDB`, и они переживают
 * разное: чистка хранилища, приватный режим, вкладка на чужом устройстве. Как
 * только запись ключа потеряна, открытие сеанса заводит новый ключ и новый
 * код — а отметка всё ещё говорит «записал», и новый код не показался бы
 * НИКОГДА.
 */
export function forgetRecoveryConfirmed(address: string | null | undefined): void {
  if (!address) return;
  try {
    localStorage.removeItem(recoveryConfirmedKey(address));
  } catch {
    // То же, что выше: цена — лишнее напоминание, а не потерянный код.
  }
}

/* ──────────────────────── подготовка показа ───────────────────────────── */

export interface RecoveryPrompt {
  words: string[];
  /** Три номера, выбранные ДЛЯ ЭТОГО показа. Новый показ — новые номера:
   *  иначе человек, ошибшийся и открывший окно снова, получал бы те же три
   *  слова, и вторая попытка не была бы попыткой. */
  positions: number[];
}

/**
 * Всё, что нужно окну, за один вызов — или `null`, если показывать нечего.
 *
 * `null` вместо исключения намеренно: вход приезжает из записи на устройстве,
 * которую мог испортить кто угодно. Отказ показать окно стоит окна; падение
 * стоило бы всего экрана.
 */
export function openRecoveryPrompt(code: unknown, random?: () => number): RecoveryPrompt | null {
  const seen = inspectRecoveryCode(code);
  if (!seen.ok) return null;
  return { words: seen.words, positions: pickCheckPositions({ random }) };
}

/* ─────────────── восстановление по коду: надписи отказов ──────────────── */

/**
 * Причина отказа → ключ надписи. КАЖДАЯ причина своя, и это требование, а не
 * аккуратность.
 *
 * ⚠️ ПОЧЕМУ НЕ «код не подошёл» НА ВСЁ. Человек вводит двенадцать слов с
 * бумажки. «Не подошёл» он читает как «переписка пропала» — и перестаёт
 * пробовать. А на деле он чаще всего ошибся в ОДНОМ слове, и ему надо
 * сказать, в каком. Два случая из списка вообще не ошибки: занятый адрес —
 * защита соседа от затирания, обычный кошелёк — устройство протокола.
 *
 * Общая надпись остаётся только для того, чего мы не предвидели: молчание
 * читается хуже любой надписи.
 */
export const RESTORE_ERROR_KEYS: Readonly<Record<string, string>> = {
  recovery_code_empty:        'chat.restore_err_empty',
  recovery_code_word_count:   'chat.restore_err_word_count',
  recovery_code_unknown_word: 'chat.restore_err_unknown_word',
  recovery_code_checksum:     'chat.restore_err_checksum',
  session_already_present:    'chat.restore_err_busy',
  recovery_not_applicable:    'chat.restore_err_not_applicable',
  storage_write_failed:       'chat.key_not_saved',
  storage_read_failed:        'chat.restore_err_storage_read',
  storage_blocked:            'chat.key_not_saved_blocked',
  storage_open_timeout:       'chat.restore_err_storage_slow',
  address_malformed:          'chat.restore_err_address',
  signature_malformed:        'chat.restore_err_signature',
};

/** Надпись для того, чего мы не предвидели. */
export const RESTORE_ERROR_FALLBACK = 'chat.restore_err_other';

export function restoreErrorKey(code: string | null | undefined): string {
  return (code && RESTORE_ERROR_KEYS[code]) || RESTORE_ERROR_FALLBACK;
}

/**
 * Номер первого слова не из списка BIP-39, 1-based, или `null`.
 *
 * ⚠️ ЭТО НЕ ВТОРАЯ ПРОВЕРКА, А ПОДПИСЬ К ЧУЖОМУ ВЕРДИКТУ. Решает,
 * восстанавливать или нет, только `chatSession.ts`; сюда обращаются ПОСЛЕ
 * того, как он уже отказал с `recovery_code_unknown_word`, и только чтобы
 * назвать человеку номер. Само слово наружу не идёт и в надпись не
 * подставляется: надпись может уехать в журнал, номер — безобиден, слово —
 * нет.
 *
 * ⚠️ ПОЧЕМУ АСИНХРОННАЯ. Список BIP-39 — это 2048 слов, и статический импорт
 * положил бы их в общий чанк: `chatRecovery.ts` тянет меню кошелька, которое
 * стоит в шапке КАЖДОЙ страницы. `chatSession.ts` грузит тот же список
 * динамически по той же причине; сделать здесь иначе значило бы вернуть в
 * общий чанк ровно то, что там уже один раз отказались держать. Цена —
 * `await` в одном месте показа, и он там всё равно есть.
 */
export async function unknownWordPosition(code: unknown): Promise<number | null> {
  if (typeof code !== 'string') return null;
  const normalized = normalizeRecoveryCode(code);
  if (normalized === '') return null;
  const { wordlist } = await import('@scure/bip39/wordlists/english');
  const known = new Set(wordlist);
  const at = normalized.split(' ').findIndex(word => !known.has(word));
  return at === -1 ? null : at + 1;
}

/**
 * Показывать ли вход «восстановить по коду».
 *
 * ⚠️ СЕАНСА НЕТ — ЗНАЧИТ ПОКАЗЫВАТЬ. Прежнее условие было `hasRecoveryCode
 * (session)`, то есть вход виднелся ТОЛЬКО там, где рабочий сеанс уже
 * есть, — ровно там, где он не нужен. А приходят с двенадцатью словами в
 * противоположном состоянии: сменил устройство, почистил хранилище, потерял
 * ключ. Мы показали код, заставили доказать, что он записан, и спрятали
 * дверь (находка сквозной проверки).
 *
 * Обычному кошельку с РАБОЧИМ сеансом вход по-прежнему не предлагается: у
 * него кода нет и не должно быть. Когда сеанса нет, род кошелька неизвестен
 * (его определяет сам сеанс), и промолчать дороже: владелец
 * кошелька-контракта не нашёл бы входа вовсе, а обычному `chatSession`
 * ответит `recovery_not_applicable` понятными словами.
 */
export function restoreEntryVisible(session: ChatSession | null | undefined): boolean {
  if (!session) return true;
  return hasRecoveryCode(session);
}

/** Показывать ли неброскую плашку «код не подтверждён». */
export function recoveryReminderVisible(
  session: ChatSession | null | undefined,
  confirmed: boolean,
): boolean {
  return hasRecoveryCode(session) && !confirmed;
}
