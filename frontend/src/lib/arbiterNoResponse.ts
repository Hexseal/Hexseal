/**
 * arbiterNoResponse.ts — РЕШЕНИЕ про кнопку «просил переписку, ответа не было».
 *
 * ⚠️ ПОРЯДОК ВЕТОК СЛЕДУЕТ ПОРЯДКУ ПРОВЕРОК В КОНТРАКТЕ, И ЭТО ПРЕДМЕТ ЗАДАЧИ,
 * А НЕ ПЕДАНТИЗМ — но следует НЕ ДОСЛОВНО, и расхождение названо ниже поимённо.
 * `recordNoResponse` (src/facets/ArbiterRegistryFacet.sol, ~760-783) отвергает
 * по очереди:
 *
 *      не тот арбитр  →  время взятия неизвестно  →  уже записано  →  рано
 *      (NotClaimingArbiter) (ClaimTimeUnknown) (…AlreadyRecorded) (…TooEarly)
 *
 * Здесь же ветки идут так:
 *
 *      не тот арбитр  →  уже записано  →  время взятия неизвестно  →  рано
 *      (not_claimed / not_mine) (recorded)  (claim_unknown)     (too_early)
 *
 * ГЛАВНОЕ СОВПАДАЕТ: однократность стоит РАНЬШЕ пола — и в цепи, и здесь. Якорь
 * пола переставляется при каждом взятии спора, а запись о молчании — нет; без
 * этого порядка арбитр, уже сделавший запись и перевзявший спор, упёрся бы
 * сперва в пол, и интерфейс пообещал бы «можно будет через сутки». Через сутки
 * цепь ответила бы `NoResponseAlreadyRecorded`. Ровно эту ложь Задача 2 убрала
 * из контракта, и возвращать её в интерфейс нельзя.
 *
 * ⚠️ РАСХОДИТСЯ ОДНА ПАРА: «уже записано» стоит ЗДЕСЬ раньше, чем «время взятия
 * неизвестно», а в цепи — позже. Говорю вслух, потому что читатель поверит
 * комментарию, а не коду.
 *
 *  — ПОЧЕМУ БЕЗВРЕДНО. Пара «записано, но время взятия неизвестно»
 *    НЕДОСТИЖИМА, и это свойство самого контракта, а не соглашение: записать
 *    молчание при `claimedAt == 0` он не даёт (`ClaimTimeUnknown` стоит раньше
 *    записи), а оба следа лежат в мапах по паре «сделка + арбитр»
 *    (`disputeClaimedAtBy`, `disputeNoResponseAtBy`) и не стираются НИ ОДНОЙ
 *    строкой — `delete` для них нет во всём фасете. Значит `recordedAt > 0`
 *    влечёт `claimedAt > 0` по той же паре, и на достижимых состояниях два
 *    порядка неотличимы.
 *  — ПОЧЕМУ ВСЁ-ТАКИ ТАК. «Уже записано» — факт окончательный и ни от чего
 *    больше не зависящий; сказать его можно всегда, как только он известен. А
 *    `claim_unknown` несёт СОВЕТ («отпустите спор и возьмите заново»), то есть
 *    зовёт на лишнюю транзакцию. Стань эта пара однажды достижимой — совет
 *    «сделайте ещё раз» тому, кто уже сделал, был бы хуже, чем факт.
 *  — ЧТО СДЕЛАЕТ ЕЁ ДОСТИЖИМОЙ: правка, которая начнёт СТИРАТЬ
 *    `disputeClaimedAtBy` (скажем, при `releaseDisputeClaim`), не тронув
 *    `disputeNoResponseAtBy`. Тогда расхождение станет видимым — и порядок
 *    выше останется верным ответом, менять его не придётся.
 *
 * ⚠️ ПОЛА ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО. Число объявлено в контракте
 * (`NO_RESPONSE_FLOOR`) и приезжает сюда входом — `floorSeconds`. Класс бага
 * назван: значение, объявленное трижды, сверяется само с собой, и замок, который
 * вроде бы его стережёт, зелен всегда. Здесь пол ВСЕГДА чужой: подменили его в
 * цепи — состояния поедут за ним без единой правки в этом файле.
 *
 * ⚠️ ЗАПИСЬ НЕ ВЛЕЧЁТ НИЧЕГО (замысел 2.6): ни XP, ни репутации, ни сдвига
 * вердикта. Поэтому здесь нет и не будет ни одной ветки, которая что-нибудь
 * «включает» после записи, — только факт и время.
 */
import { ZERO_ADDRESS } from '@/lib/disputeArbiter';

/* ─────────────────────────── что мы знаем ──────────────────────────────── */

/**
 * Можно ли отпустить спор и взять его заново. Нужен РОВНО ОДНОМУ состоянию —
 * спору, взятому до разреза, — и только затем, чтобы совет не обещал выхода,
 * которого нет: `releaseDisputeClaim` ревертит `DisputeWindowPassed` после
 * закрытия окна спора и `"verdict pending"` — когда вердикт уже подан.
 */
export type ReleaseAdvice = 'open' | 'window_passed' | 'verdict_pending' | 'unknown';

export interface NoResponseFacts {
  /** Часы БРАУЗЕРА, секунды. Цепь считает по `block.timestamp`, и сойтись эти
   *  двое обязаны не до секунды: перекос вперёд даст отказ `NoResponseTooEarly`
   *  с названной причиной, а не молчание. Своей поправки на перекос здесь нет
   *  намеренно — это было бы второе, никем не проверяемое число. */
  nowSec: number;
  /** Мой адрес. `null` — кошелёк не подключён; тогда кнопка не моя. */
  me: string | null | undefined;
  /** Кто ведёт спор ПО ЦЕПИ (`getDisputeClaimer`). `null` — не прочитано.
   *
   *  ⚠️ Именно `disputeClaims`, а не `disputeArbiterOf` из `lib/disputeArbiter`:
   *  тот отвечает на вопрос СТОРОНЫ «кому предъявлять» и падает на арбитра
   *  поданного вердикта, когда клеймо уже снято. `recordNoResponse` сверяет
   *  ровно `disputeClaims`, и второй источник здесь показал бы кнопку тому, кого
   *  контракт отвергнет. */
  claimer: string | null;
  /** Когда текущий клеймер взял спор (`getDisputeClaimedAt`). `null` — не
   *  прочитано, `0` — спор взят ДО разреза 4в-2 и считать пол не от чего. */
  claimedAt: number | null;
  /** Когда он же записал молчание (`getNoResponseAt`). `null` — не прочитано,
   *  `0` — не записывал. */
  recordedAt: number | null;
  /** Пол ИЗ ЦЕПИ (`getNoResponseFloor`). `null` — не прочитан. */
  floorSeconds: number | null;
  release: ReleaseAdvice;
}

/**
 * ⚠️ СЕМЬ ИСХОДОВ, И НИ ОДИН НЕ МОЛЧИТ. Четыре — из задания (уже записано,
 * время взятия неизвестно, рано, готово); три добавлены по тому же правилу, по
 * которому у ключа устройства четыре вердикта, а не один говорящий и три немых:
 * «спор ведёт другой», «спор не ведёт никто» и «цепь не ответила» — разные
 * новости, и молчание вместо любой из них читается как «кнопки здесь не
 * бывает».
 */
export type NoResponseState =
  | { kind: 'chain_unread' }
  | { kind: 'not_claimed' }
  | { kind: 'not_mine'; arbiter: string }
  | { kind: 'recorded'; at: number }
  | { kind: 'claim_unknown'; release: ReleaseAdvice }
  | { kind: 'too_early'; leftSeconds: number }
  | { kind: 'ready' };

/**
 * ⚠️ ЗАМОК КОМПИЛЯТОРА: состояние «готово» не несёт ни времени записи, ни
 * остатка. Тот же приём, что `ARBITER_TURN_UNKNOWN_CARRIES_NO_NUMBER`
 * (`lib/arbiterTurn.ts`), и живёт он в боевом файле, а не в тесте: `*.test.ts`
 * исключены из программы `tsc`.
 *
 * Что исчезнет из поведения, если снять: возможность нарисовать «записано в
 * 00:00» над активной кнопкой, то есть показать факт, которого в цепи нет.
 */
type Ready = Extract<NoResponseState, { kind: 'ready' }>;
export type ReadyCarriesNoTime =
  [Extract<keyof Ready, 'at' | 'leftSeconds'>] extends [never] ? true : never;
export const READY_CARRIES_NO_TIME: ReadyCarriesNoTime = true;

/* ───────────────────────────── решение ─────────────────────────────────── */

function known(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/**
 * Состояние кнопки. ⚠️ НЕ БРОСАЕТ и не имеет умолчаний: чего не знаем, о том
 * говорим «не знаем», а не «ноль». Ноль вместо незнания обещал бы кнопку
 * раньше, чем она заработает, и виноватым за отказ цепи оказался бы интерфейс.
 */
export function noResponseState(f: NoResponseFacts): NoResponseState {
  // Часы браузера — такой же вход, как ответ цепи. Мусор в них (NaN даёт
  // `false` в любом сравнении) провалился бы прямиком в «готово».
  if (!known(f.nowSec)) return { kind: 'chain_unread' };
  // ⚠️ ПОРОГА ЗДЕСЬ НЕТ НАМЕРЕННО (ревью, круг 1). Он нужен ровно двум последним
  // веткам — «рано» и «можно», — а требование его наверху гасило бы в «цепь не
  // ответила» то, что в этот момент ИЗВЕСТНО: и «уже записано», и «спор ведёт
  // другой». Один сорвавшийся `getNoResponseFloor` прятал бы факт цепи.
  if (f.claimer === null || !known(f.claimedAt) || !known(f.recordedAt)) {
    return { kind: 'chain_unread' };
  }

  // 1. Не тот арбитр — первая проверка контракта (`NotClaimingArbiter`).
  //    Клеймо снято (`releaseDisputeClaim`, `_clearDisputeClaim` после
  //    вердикта) — это НЕ «ведёт другой», и советы у этих двух разные.
  if (sameAddress(f.claimer, ZERO_ADDRESS)) return { kind: 'not_claimed' };
  if (!sameAddress(f.claimer, f.me)) return { kind: 'not_mine', arbiter: f.claimer };

  // 2. Уже записано. ⚠️ РАНЬШЕ ПОЛА — см. шапку файла: иначе после перевзятия
  //    спора экран обещает срок, по истечении которого получит отказ.
  //    ⚠️ И раньше «время взятия неизвестно» — ЕДИНСТВЕННОЕ место, где порядок
  //    расходится с контрактом. Пара недостижима, разбор — в шапке файла.
  if (f.recordedAt > 0) return { kind: 'recorded', at: f.recordedAt };

  // 3. Время взятия неизвестно: спор взят до разреза. Кода переноса нет вовсе.
  if (f.claimedAt === 0) return { kind: 'claim_unknown', release: f.release };

  // 4. Пол — и только здесь он и требуется. Не прочитан — сказать «рано» или
  //    «можно» нечем, и это честное «не знаем», а не готовность.
  if (!known(f.floorSeconds)) return { kind: 'chain_unread' };

  //    Сравнение то же, что в контракте: `block.timestamp < claimedAt +
  //    NO_RESPONSE_FLOOR` — на ровной границе цепь уже принимает.
  const readyAt = f.claimedAt + f.floorSeconds;
  if (f.nowSec < readyAt) return { kind: 'too_early', leftSeconds: readyAt - f.nowSec };

  return { kind: 'ready' };
}

/**
 * Годится ли совет «отпустите спор и возьмите заново».
 *
 * ⚠️ ЗАЧЕМ ОТДЕЛЬНО. Совет неисполним после закрытия окна спора — тогда честнее
 * сказать, что записать молчание по этому спору уже не выйдет, чем послать
 * человека нажимать кнопку, которая гарантированно отревертит. Порядок причин —
 * контрактный (`releaseDisputeClaim`): сперва поданный вердикт, потом окно.
 */
export function releaseAdvice(f: {
  nowSec: number;
  /** `disputedAt()` самой сделки. `null` — не прочитано. */
  disputedAt: number | null;
  /** `DISPUTE_WINDOW()` самой сделки, а не константа фронта: клоны EIP-1167
   *  прибиты к своей реализации, и у старого клона окно может быть прежним
   *  (оно уже менялось с 7 суток на 4). */
  disputeWindow: number | null;
  /** Подан ли вердикт (`getPendingVerdict().submittedAt != 0`). `null` — не
   *  прочитано, и это НЕ «не подан». */
  verdictPending: boolean | null;
}): ReleaseAdvice {
  if (f.verdictPending === true) return 'verdict_pending';
  if (f.verdictPending === null || f.verdictPending === undefined) return 'unknown';
  if (!known(f.nowSec) || !known(f.disputedAt) || !known(f.disputeWindow)) return 'unknown';
  // Нули — это «спора не было» или «не прочитали», а не «окно длиной ноль».
  if (f.disputedAt <= 0 || f.disputeWindow <= 0) return 'unknown';
  // Контракт: revert при block.timestamp > disputedAt + DISPUTE_WINDOW.
  return f.nowSec > f.disputedAt + f.disputeWindow ? 'window_passed' : 'open';
}

/* ───────────────────────── надписи про время ───────────────────────────── */

/**
 * Сколько ещё ждать — ключ локали и подстановки к нему.
 *
 * ⚠️ ЧИСЛА СУТОК ЗДЕСЬ НЕТ (`86400`), и это не стилистика: замок «своей копии
 * пола во фронте нет» читает исходники, а секунды в сутках и пол — числа
 * разные, но одинаковые на вид. Раскладка идёт от минут вверх, поэтому спутать
 * их негде.
 *
 * Наименьшая единица округляется ВВЕРХ: «через 0 минут» читается как «уже
 * можно», человек нажимает и получает отказ.
 */
export function noResponseWait(leftSeconds: number): {
  key: string; params: Record<string, number>;
} {
  const s = known(leftSeconds) && leftSeconds > 0 ? leftSeconds : 1;
  const totalMinutes = Math.ceil(s / 60);
  const totalHours = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const h = totalHours % 24;
  const d = Math.floor(totalHours / 24);
  if (d > 0) return { key: 'arbiter.no_response_wait_dh', params: { d, h } };
  if (totalHours > 0) return { key: 'arbiter.no_response_wait_hm', params: { h, m } };
  return { key: 'arbiter.no_response_wait_m', params: { m: Math.max(1, m) } };
}

/**
 * Время записи — `ГГГГ-ММ-ДД ЧЧ:ММ UTC`, либо `null`, если датировать нечем.
 *
 * ⚠️ ПОЯС НЕ МЕСТНЫЙ, И ЭТО ТА ЖЕ ПРИЧИНА, ЧТО У ДАТЫ ЗАВЕРЕНИЯ КЛЮЧА
 * (`attestationDateLabel`): запись работает уликой, её сравнивают с блоком
 * отпечатка и со словами сторон, а расхождение поясов между арбитром и стороной
 * здесь стоило бы разбора. Выдуманное время хуже отсутствующего, поэтому ноль и
 * мусор дают `null`, а не «01.01.1970».
 */
export function noResponseAtLabel(seconds: number | null): string | null {
  if (!known(seconds) || seconds <= 0) return null;
  const iso = new Date(seconds * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
