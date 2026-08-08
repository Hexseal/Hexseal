/**
 * chatAnnounceStore.ts — общая память о том, объявлен ли наш ключ.
 *
 * ─── ПОЧЕМУ ОТДЕЛЬНО ОТ ХУКА, И ПОЧЕМУ БЕЗ REACT ────────────────────────────
 *
 * Две причины, и обе выяснились замером, а не рассуждением.
 *
 * 1. **Порог пропуска обязан быть ОДИН.** Первая версия проверяла «наш ключ
 *    объявлен?» в двух хуках сразу — в открытой переписке и в списке переписок.
 *    Мутации «снять проверку из `usePairChat`» и «снять из
 *    `usePairConversations`» проходили ЗЕЛЁНЫМИ на 73 замерах: у фронта нет
 *    jsdom, отрисовать хук нечем, и проводка внутри него не сторожится ничем.
 *    Проверка переехала в `getBagPass` — единственное место в чате, где вообще
 *    берётся пропуск, — и стала проверяемой напрямую.
 *
 * 2. **`getBagPass` живёт в `hooks/useChatSession.ts`.** Если склад держать в
 *    хуке, получается кольцо импортов: хук → склад → хук. Склад без React
 *    кольцо разрывает, а зависимости он получает аргументами.
 *
 * ─── ПОЧЕМУ СКЛАД ОБЩИЙ, А НЕ СВОЙ У КАЖДОГО ЭКЗЕМПЛЯРА ─────────────────────
 *
 * `useKeyAnnouncement()` живёт в нескольких местах страницы сразу: панель
 * переписки, список переписок, внутри `usePairChat`. Свой склад у каждого — это
 * три чтения справочника на одно открытие чата и, хуже, три одновременных
 * попытки объявить ключ. Второе одновременное окно кошелька прилетает как
 * `-32002`, и в мобильном MetaMask его нечем отменить.
 */

import {
  readOwnStanding, announceOwnKey, attemptAfterFailure, mailboxWorthPolling,
  type KeyStanding, type AnnounceAttempt,
} from '@/lib/chatAnnounce';
import type { ChatSession } from '@/lib/chatSession';
import type { PeerChatKeys } from '@/lib/chatDirectoryTypes';

interface Entry {
  standing: KeyStanding;
  attempt: AnnounceAttempt;
  errorCode: string | null;
  /** Чтение справочника в полёте — три экземпляра дают один запрос. */
  reading: Promise<void> | null;
  /** Объявление в полёте — три экземпляра дают ОДНУ запись в справочник. */
  announcing: Promise<void> | null;
  /**
   * Чем спрашивать справочник ПОВТОРНО, когда человек вернётся на страницу.
   * Запоминается от первого вопроса: перечитывание живёт здесь, а не в хуке,
   * потому что хук к этому моменту может быть уже перемонтирован.
   */
  ask: { session: ChatSession; fetchKeys: FetchKeys } | null;
  /**
   * Когда справочник ПЕРЕЧИТЫВАЛИ на возврате страницы. Отдельно от первого
   * вопроса, и это не мелочь: первый вопрос как раз и задаётся в тот момент,
   * когда страница заморожена походом к кошельку. Считая его «недавним
   * запросом», порог запирал бы ровно тот возврат, ради которого заведён —
   * замерено: 0 перечитываний из 10 возвратов.
   */
  recheckedAt: number;
}

type FetchKeys = (address: `0x${string}`, signal?: AbortSignal) => Promise<PeerChatKeys>;

const _store = new Map<string, Entry>();
const _listeners = new Set<() => void>();

function entry(address: string): Entry {
  let e = _store.get(address);
  if (!e) {
    e = {
      standing: 'unknown', attempt: 'none', errorCode: null,
      reading: null, announcing: null, ask: null, recheckedAt: 0,
    };
    _store.set(address, e);
  }
  return e;
}

function tell(): void {
  for (const fn of _listeners) {
    try { fn(); } catch { /* один плохой слушатель не ломает остальных */ }
  }
}

/** Подписка на изменения: любое обновление перерисовывает всех, кто спрашивал. */
export function subscribeKeyAnnouncement(fn: () => void): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

export function ownKeyStanding(address: string | undefined): KeyStanding {
  if (!address) return 'unknown';
  return _store.get(address.toLowerCase())?.standing ?? 'unknown';
}

/**
 * Стоит ли брать пропуск ради ящика.
 *
 * ⚠️ ЭТО И ЕСТЬ ЕДИНСТВЕННЫЙ ПОРОГ, и зовёт его `getBagPass`. Разбор правила — в
 * `mailboxWorthPolling` (`lib/chatAnnounce.ts`): опрос блокируется только когда
 * мы ПОЛОЖИТЕЛЬНО знаем, что написать нам нельзя.
 */
export function mailboxWorthPollingFor(address: string | undefined): boolean {
  return mailboxWorthPolling(ownKeyStanding(address));
}

/**
 * Состояние объявления целиком.
 *
 * ⚠️ ОТКРЫТО НАРУЖУ ПОСЛЕ НАХОДКИ МУТАЦИИ. Мутация «писать `failed` всегда,
 * классификатор не звать» проходила ЗЕЛЁНОЙ на 58 замерах: чистая функция была
 * заперта, а её УПОТРЕБЛЕНИЕ — нет. Ровно тот класс, который в этом проекте
 * зовут «замок, который ищет имя, а не употребление». Теперь переход состояния
 * можно прочитать и замерить (`hooks/chatAnnounceStore.test.ts`).
 */
export function keyAnnouncementState(address: string | undefined): {
  standing: KeyStanding; attempt: AnnounceAttempt; errorCode: string | null;
} {
  const e = address ? _store.get(address.toLowerCase()) : undefined;
  return {
    standing: e?.standing ?? 'unknown',
    attempt: e?.attempt ?? 'none',
    errorCode: e?.errorCode ?? null,
  };
}

/** Только для замеров: забыть всё, что склад запомнил. */
export function _resetKeyAnnouncementForTest(): void {
  _store.clear();
  _listeners.clear();
}

/* ═══════════ ЧЕЛОВЕК ВЕРНУЛСЯ НА СТРАНИЦУ — СПРОСИТЬ СПРАВОЧНИК СНОВА ══════ */

/**
 * ─── ЧТО БЫЛО СЛОМАНО ───────────────────────────────────────────────────────
 *
 * Владелец, дословно: «кнопка появилась, но поздно… сходу как я возвращаюсь я
 * должен видеть кнопку, а сейчас она как будто на таймере или че, пока со
 * страницы не перешелкнешь, ниче не появляется».
 *
 * Справочник спрашивался РОВНО ОДИН РАЗ за жизнь вкладки — эффект хука стоял под
 * условием «стояние ещё не известно», и второго случая спросить не было ни
 * одного. А спрашивали мы его в худший возможный момент: сразу после того, как
 * ключ появился на устройстве, то есть пока страница ЗАМОРОЖЕНА походом к
 * кошельку. Сеть в фоне не идёт → отказ → `unreachable` → «мы не знаем» →
 * кнопки нет по построению (`announceNeedsPress`). И перечитать нечем: переход
 * на другую страницу и обратно перемонтирует хук — вот почему «перешелкнёшь, и
 * появляется».
 *
 * ─── ПОЧЕМУ ЭТО ЖИВЁТ В СКЛАДЕ, А НЕ В ХУКЕ ─────────────────────────────────
 *
 * Потому что иначе это нечем замерить. У фронта нет jsdom: проводка внутри хука
 * не сторожится НИЧЕМ — в этом файле уже записаны две мутации (58 и 73 зелёных
 * замера), прошедшие именно так. Наблюдение за возвратом стоит здесь, взводится
 * само из `readStandingInto` и мерится напрямую подделанной страницей
 * (`lib/chatAnnounceReturn.test.ts`).
 *
 * ─── ЧЕГО ЭТО НЕ ДЕЛАЕТ ─────────────────────────────────────────────────────
 *
 * Не спрашивает справочник, когда ответ НИЧЕГО НЕ ИЗМЕНИТ на экране: при `mine`
 * (всё в порядке) и при `absent`/`other_key` (кнопка уже показана). Спрашиваем
 * только тогда, когда мы не знаем, — `unknown` и `unreachable`. Отсюда «десять
 * переключений — ноль запросов» в здоровом случае: не бережность, а следствие
 * правила.
 */

/** Не чаще раза в тридцать секунд на адрес. Переключение на кошелёк и обратно
 *  бывает частым — и каждое не должно стоить запроса. */
export const STANDING_RECHECK_MIN_GAP_MS = 30_000;

/**
 * Стояния, при которых ответ справочника МОЖЕТ изменить то, что на экране.
 *
 * ⚠️ Множеством, а не сравнением по месту: правило «когда спрашивать» обязано
 * жить рядом со своим смыслом, иначе оно разъедется с `announceNeedsPress` — а
 * разъехавшись, начнёт либо молчать, либо долбить справочник.
 */
const WORTH_RE_ASKING: ReadonlySet<KeyStanding> = new Set<KeyStanding>(['unknown', 'unreachable']);

/**
 * То же правило наружу — для хука, который спрашивает справочник на
 * монтировании.
 *
 * ⚠️ ОДНО ПРАВИЛО НА ДВА МЕСТА, И ЭТО НАРОЧНО. У хука раньше стояло своё
 * условие («стояние ещё не известно»), и оно было СТРОЖЕ: отказ справочника
 * (`unreachable`) не перечитывался ни на возврате, ни даже на новом
 * монтировании. То есть один моргнувший справочник запирал кнопку до
 * перезагрузки страницы.
 */
export function standingWorthReAsking(standing: KeyStanding): boolean {
  return WORTH_RE_ASKING.has(standing);
}

/**
 * Спросить справочник, ЕСЛИ в этом есть смысл. Единственное, что зовёт хук на
 * монтировании.
 *
 * ⚠️ РЕШЕНИЕ ЖИВЁТ ЗДЕСЬ, А НЕ В ХУКЕ, И ЭТО ГЛАВНОЕ В ЭТОЙ ФУНКЦИИ. Такое же
 * условие стояло в хуке обычным `if` — и мутация «вернуть прежнее правило»
 * прошла ЗЕЛЁНОЙ на 37 замерах: отрисовать хук нечем, проводка внутри него не
 * сторожится ничем (в этом файле записаны ещё две такие мутации — 58 и 73
 * замера). Здесь то же правило мерится напрямую, числом запросов.
 *
 * @returns ушёл ли запрос. Число, а не молчание: «повторные заходы не множат
 *   запросы» — требование с замером.
 */
export function askStandingIfWorth(
  address: `0x${string}`,
  session: ChatSession,
  fetchKeys: FetchKeys,
): boolean {
  const e = entry(address.toLowerCase());
  // Ответ ничего не изменит (`mine` — всё в порядке; `absent`/`other_key` —
  // кнопка уже показана): спрашивать незачем.
  if (!WORTH_RE_ASKING.has(e.standing)) return false;
  // Уже спрашиваем — три экземпляра хука дают один запрос, а не три.
  if (e.reading) return false;
  void readStandingInto(address, session, fetchKeys);
  return true;
}

interface PageLike {
  visibilityState?: string;
  addEventListener?: (type: string, fn: () => void) => void;
  removeEventListener?: (type: string, fn: () => void) => void;
}

/** Читается КАЖДЫЙ РАЗ, а не запоминается при загрузке модуля: подделанная в
 *  замере страница появляется позже самого модуля. */
function page(): PageLike | null {
  const doc = (globalThis as { document?: PageLike }).document;
  return doc && typeof doc === 'object' ? doc : null;
}

let _watching = false;
let _onReturn: (() => void) | null = null;

/**
 * Взвести наблюдение за возвратом страницы. Зовётся из `readStandingInto`, то
 * есть из того самого вопроса, ради которого всё и делается: отдельной строки
 * проводки, которую можно потерять, здесь нет НАРОЧНО.
 *
 * ⚠️ ТРИ СОБЫТИЯ, А НЕ ОДНО. `visibilitychange` — главное, но в установленном
 * приложении на iOS оно ненадёжно, и это в проекте уже записано
 * (`app/providers.tsx`, `VisibilityRefresher` заведён ровно из-за этого).
 * `focus` и `pageshow` — второй и третий шанс узнать, что человек смотрит на
 * экран. Лишние срабатывания дешевы: порог и правило «есть ли смысл спрашивать»
 * стоят дальше, а не здесь.
 */
function watchReturn(): void {
  if (_watching) return;
  const doc = page();
  if (!doc?.addEventListener) return;
  _onReturn = () => {
    // Скрыта — значит это уход, а не возврат. Спрашивать из свёрнутого
    // приложения незачем: показывать некому, и сеть там всё равно не идёт.
    if (doc.visibilityState === 'hidden') return;
    recheckStandingOnReturn();
  };
  doc.addEventListener('visibilitychange', _onReturn);
  doc.addEventListener('focus', _onReturn);
  doc.addEventListener('pageshow', _onReturn);
  _watching = true;
}

/** Только для замеров: снять наблюдение вместе с подделанной страницей. */
export function _resetStandingWatchForTest(): void {
  const doc = page();
  if (_onReturn && doc?.removeEventListener) {
    doc.removeEventListener('visibilitychange', _onReturn);
    doc.removeEventListener('focus', _onReturn);
    doc.removeEventListener('pageshow', _onReturn);
  }
  _watching = false;
  _onReturn = null;
}

/**
 * Перечитать стояние у всех адресов, где ответ что-то изменит.
 *
 * Наружу открыто, чтобы это можно было позвать напрямую (и замерить), но в
 * приложении зовёт её наблюдение выше — само.
 *
 * @returns сколько запросов ушло. Число, а не молчание: «возвраты не множат
 *   запросы» — это требование с замером, и мерить его надо тем же, чем работает.
 */
export function recheckStandingOnReturn(now: number = Date.now()): number {
  let asked = 0;
  for (const [key, e] of _store) {
    if (!e.ask) continue;
    if (!WORTH_RE_ASKING.has(e.standing)) continue;
    if (e.reading) continue;
    // `recheckedAt === 0` — «на возврате ещё не спрашивали», и это ДА: первый
    // возврат обязан спросить сразу, иначе кнопка приезжает через полминуты
    // после того, как человек на неё смотрит.
    if (e.recheckedAt !== 0 && now - e.recheckedAt < STANDING_RECHECK_MIN_GAP_MS) continue;
    e.recheckedAt = now;
    asked++;
    void readStandingInto(key as `0x${string}`, e.ask.session, e.ask.fetchKeys);
  }
  // Даже когда спрашивать нечего, тем, кто спрашивал, надо перерисоваться:
  // ВЕРДИКТ ПОРОГА ПОДПИСИ зависит от того, видна ли страница, и на возврате он
  // меняется сам. Без этого кнопка «есть», но её никто не рисует — ровно то
  // «пока со страницы не перешелкнёшь», с чего всё началось.
  tell();
  return asked;
}

/**
 * Спросить справочник про свой адрес — один раз на адрес, с дедупом в полёте.
 *
 * ⚠️ ЛЮБОЙ неудачный исход даёт `unreachable`, а НЕ `unknown`, и это отказ в
 * сторону работы: `unknown` не пускает опрос ящика, и застряв в нём, чат молчал
 * бы навсегда — перечитать по своей воле здесь нечем.
 */
export function readStandingInto(
  address: `0x${string}`,
  session: ChatSession,
  fetchKeys: FetchKeys,
): Promise<void> {
  const key = address.toLowerCase();
  const e = entry(key);
  // Чем спросить снова — запоминается ДО дедупа: даже присоединившийся к чужому
  // запросу вызов обязан оставить эту возможность после себя.
  e.ask = { session, fetchKeys };
  // ⚠️ ВЗВОДИТСЯ ЗДЕСЬ, В САМОМ ВОПРОСЕ. Отдельной строки проводки в хуке нет
  // нарочно: её можно потерять, и потерю нечем заметить (у фронта нет jsdom).
  watchReturn();
  if (e.reading) return e.reading;
  const run = (async () => {
    const standing = await readOwnStanding(address, session.keypair.publicKey, fetchKeys)
      .catch(() => 'unreachable' as KeyStanding);
    const cur = entry(key);
    cur.standing = standing;
    cur.reading = null;
    tell();
  })();
  e.reading = run;
  return run;
}

export interface AnnounceIntoDeps {
  /** Пропуск РАДИ ОБЪЯВЛЕНИЯ — не ради ящика: порог ящика тут не применяется,
   *  иначе получилось бы кольцо (объявиться нельзя без пропуска, пропуск нельзя
   *  без объявления). */
  getPass: (opts: { humanAsked: boolean }) => Promise<string>;
  publish: (pass: string, session: ChatSession, signal?: AbortSignal) => Promise<void>;
}

/**
 * Объявить ключ и записать исход. Дедуп в полёте: три экземпляра хука на одной
 * странице дают ОДНУ запись в справочник, а не три.
 */
export function announceInto(
  address: `0x${string}`,
  session: ChatSession,
  humanAsked: boolean,
  deps: AnnounceIntoDeps,
): Promise<void> {
  const key = address.toLowerCase();
  const e = entry(key);
  if (e.announcing) return e.announcing;

  const run = (async () => {
    const cur = entry(key);
    cur.attempt = 'busy';
    cur.errorCode = null;
    tell();
    try {
      await announceOwnKey({ address, session, humanAsked, ...deps });
      // Объявили, и это подтвердил сервер (`POST /keys` вернул 2xx). Перечитывать
      // справочник ради подтверждения незачем: тот же сервер только что записал.
      cur.standing = 'mine';
      cur.attempt = 'none';
    } catch (err) {
      // «Ещё не время» — не «не удалось». Разбор и цена промаха — в докстринге
      // `attemptAfterFailure`; там же сказано, что различие вынесено в чистую
      // функцию ПОСЛЕ того, как мутация нашла его без охраны.
      cur.attempt = attemptAfterFailure(err);
      cur.errorCode = cur.attempt === 'failed'
        ? (err instanceof Error ? err.message : 'announce_failed')
        : null;
    } finally {
      const fin = entry(key);
      fin.announcing = null;
      tell();
    }
  })();
  e.announcing = run;
  return run;
}
