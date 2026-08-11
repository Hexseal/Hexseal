/**
 * presentationDraft.ts — незаконченное предъявление, ВИДИМОЕ СВОЕМУ ХОЗЯИНУ.
 *
 * Замысел 4в §11, дословно: «Собрал предъявление, не отправил: ключи раскрыты
 * локально, на складе ничего нет, спор идёт как будто он молчит — и молчание
 * против него. ⚠️ Значит незаконченное предъявление обязано быть видимым ему
 * самому, а не тихо потерянным.»
 *
 * ⚠️ ЧТО ЗДЕСЬ ХРАНИТСЯ И ЧТО НЕТ. Хранится контейнер целиком — то есть кадры
 * (те же зашифрованные байты, что и в архиве переписки) и разовые ключи,
 * ЗАПЕЧАТАННЫЕ на арбитра и на собеседника. Открытых разовых ключей здесь нет
 * ни одного, и это заперто замером байтов диска, а не обещанием.
 *
 * ⚠️ ПОЧЕМУ ЧИТАТЬ-МЕНЯТЬ-ПИСАТЬ ПОД ЗАМКОМ. Запись у нас одна на человека
 * (список его черновиков), а вкладок у человека две — обычное дело: чат открыт
 * и рядом сделка. Без замка обе читают одно и то же, каждая дописывает своё и
 * пишет — то есть один черновик исчезает молча. `navigator.locks` в браузере
 * общий на происхождение, а в node 24 — настоящий и общий на процесс
 * (`__stand__/fakeChatDisk.ts:17-21`), тот же приём, что в
 * `chatTransport.ts:443-454`.
 *
 * ⚠️ ПОДПИСЕЙ ЗДЕСЬ НЕ ПРОВЕРЯЕТСЯ. Это своё, на своём устройстве; проверка
 * своей же подписи мерила бы задачу 5, а не диск. Форма записи проверяется
 * строго — иначе мусор с диска стал бы «вот ваше предъявление».
 *
 * ⚠️ КРУГ ДОРАБОТКИ 2 (11 августа 2026): У ЗАМКА ЕСТЬ ПРЕДЕЛЬНЫЙ СРОК. Ревью
 * подтвердило по коду и по мутации 7 (задача 8, отчёт): `navigator.locks.request`
 * без `signal` и без потолка держит лок РОВНО столько, сколько не разрешается и
 * не отклоняется колбэк — а колбэк здесь асинхронная работа с IndexedDB, которая
 * умеет не ответить вовсе (см. `STORAGE_OPEN_TIMEOUT_MS`, `chatSession.ts:265-275`,
 * тот же класс беды: `blocked`, придержанное хранилище). Без потолка это не
 * отказ, а ВЕЧНАЯ КРУТИЛКА — и не только у того, чья запись повисла: лок один на
 * процесс (`LOCK_NAME`), и следующая вкладка, которая тоже пойдёт писать
 * черновик, встанет в очередь за тем же именем и повиснет следом, молча.
 * `LOCK_TIMEOUT_MS` ограничивает ОБА участка одним и тем же сроком — и ожидание
 * своей очереди (через `AbortSignal` у `locks.request`), и саму работу под
 * замком (через `Promise.race` внутри колбэка) — так что зависший держатель не
 * блокирует следующего дольше этого же срока: самолечение без перезагрузки
 * вкладки. Отказ по сроку называется `'lock_timeout'` — отдельно от
 * `'disk_unavailable'`, потому что это разные новости: «диск отказал» и «диск
 * не ответил за отведённое время» требуют разного объяснения человеку.
 */
// ⚠️ Род берётся ИЗ ЗАДАЧИ 5 напрямую (договор v2, исправление 11): один источник
// на весь план, без цепочки реэкспортов через мой же `presentationBag`.
import { PRESENTATION_KIND, type PresentationContainer } from '@/lib/presentation';

const DB_NAME = 'hexseal-presentation';
const DB_VERSION = 1;
const STORE_NAME = 'drafts';
const RECORD_VERSION = 1;
const LOCK_NAME = 'hexseal.presentation.drafts';
/** Больше двадцати незакрытых предъявлений на человека — не жизнь, а протечка. */
const MAX_DRAFTS_PER_PRESENTER = 20;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Потолок ожидания-и-работы под межвкладочным замком черновиков (круг
 * доработки 2). Тот же класс задачи и то же обоснование, что у
 * `STORAGE_OPEN_TIMEOUT_MS` (`chatSession.ts:265-275`) — не сеть и не ЖИВОЕ
 * окно кошелька (там счёт на минуты, человек имеет право думать —
 * `SESSION_LOCK_TIMEOUT_MS`/`WALLET_LOCK_TIMEOUT_MS`), а МЕСТНАЯ работа с
 * IndexedDB: прочитать список черновиков, потом записать. Десять секунд —
 * заведомо больше двух обычных локальных операций (миллисекунды на каждую) и
 * заведомо меньше терпения человека у крутилки «сохраняю».
 *
 * ⚠️ ЦЕНА ИСТЕЧЕНИЯ НАЗВАНА. Если работа честно ещё идёт (медленный диск, не
 * повисший), после срока мы её БРОСАЕМ — она может доработать в фоне и лечь на
 * диск сама, а вызывающий уже получил `'lock_timeout'` и не узнает об этом.
 * Тот же самый размен, каким `CONVERSATION_LOCK_TIMEOUT_MS`
 * (`chatConversation.ts:302-317`) жертвует редким столкновением номеров ради
 * того же самого — не заклинить навсегда.
 */
export const LOCK_TIMEOUT_MS = 10_000;

export type DraftState = 'built' | 'sent';
/** `'lock_timeout'` — замок (своя очередь ИЛИ работа под ним) не уложился в
 *  `LOCK_TIMEOUT_MS`. Отдельно от `'disk_unavailable'`: там диск ОТВЕТИЛ отказом,
 *  здесь диск НЕ ОТВЕТИЛ вовсе — разные новости человеку. */
export type DraftSaveVerdict = 'saved' | 'disk_unavailable' | 'lock_timeout';
export type DraftMarkVerdict = DraftSaveVerdict | 'not_found';

export interface PresentationDraft {
  dealId: `0x${string}`;
  presenter: `0x${string}`;
  /** Момент сборки — он же тождество черновика внутри дела. */
  issuedAt: number;
  messageCount: number;
  /** Сколько байт уйдёт на склад (`presentationWireBytes`). */
  wireBytes: number;
  state: DraftState;
  sentAt?: number;
  bagKey?: string;
  container: PresentationContainer;
}

interface DraftsRecord {
  v: number;
  drafts: PresentationDraft[];
}

const draftsKey = (presenter: string): string => `drafts|${presenter.toLowerCase()}`;

export function draftFromContainer(
  container: PresentationContainer, wireBytes: number,
): PresentationDraft {
  return {
    dealId: container.dealId,
    presenter: container.presenter,
    issuedAt: container.issuedAt,
    // ⚠️ Число берётся из ПОЛОЖЕННЫХ кадров, а не из `counts` контейнера.
    // `DeclaredCounts` (исправление 7) — заявление предъявителя; здесь и так своё,
    // но пересказывать заявленное вместо посчитанного — привычка, которая на
    // экране арбитра стоит дорого. Считаем то, что видим.
    messageCount: container.frames.length,
    wireBytes,
    state: 'built',
    container,
  };
}

function isDraft(x: unknown): x is PresentationDraft {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.dealId !== 'string' || !ADDRESS_RE.test(o.dealId)) return false;
  if (typeof o.presenter !== 'string' || !ADDRESS_RE.test(o.presenter)) return false;
  if (!Number.isSafeInteger(o.issuedAt) || (o.issuedAt as number) <= 0) return false;
  if (!Number.isSafeInteger(o.messageCount) || (o.messageCount as number) < 0) return false;
  if (!Number.isSafeInteger(o.wireBytes) || (o.wireBytes as number) < 0) return false;
  if (o.state !== 'built' && o.state !== 'sent') return false;
  if (o.state === 'sent' && typeof o.bagKey !== 'string') return false;
  const c = o.container;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  const cc = c as Record<string, unknown>;
  if (cc.kind !== PRESENTATION_KIND) return false;
  if (!Array.isArray(cc.frames)) return false;
  return true;
}

function readList(raw: unknown): PresentationDraft[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const rec = raw as Record<string, unknown>;
  if (rec.v !== RECORD_VERSION || !Array.isArray(rec.drafts)) return [];
  return (rec.drafts as unknown[]).filter(isDraft);
}

function idbFactory(): IDBFactory | null {
  const g = globalThis as { indexedDB?: IDBFactory };
  return g.indexedDB ?? null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const factory = idbFactory();
    if (!factory) {
      reject(new Error('presentationDraft: indexedDB недоступен'));
      return;
    }
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('presentationDraft: open отказал'));
    req.onblocked = () => reject(new Error('presentationDraft: open заблокирован'));
  });
}

async function idbGet(key: string): Promise<unknown> {
  const db = await openDb();
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('get отказал'));
      tx.onabort = () => reject(tx.error ?? new Error('транзакция отменена'));
    });
  } finally {
    db.close();
  }
}

async function idbPut(key: string, value: DraftsRecord): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      tx.oncomplete = () => resolve();
      // ⚠️ Ждём именно ТРАНЗАКЦИЮ, а не запрос: непогашенная ошибка запроса
      // отменяет транзакцию целиком, и «успех запроса» при отменённой
      // транзакции — ровно то, на чём подделка диска однажды оказалась
      // снисходительнее браузера (`fakeChatDisk.ts:76-91`).
      tx.onabort = () => reject(tx.error ?? new Error('транзакция отменена'));
      tx.onerror = () => reject(tx.error ?? new Error('транзакция отказала'));
      tx.objectStore(STORE_NAME).put(value, key);
    });
  } finally {
    db.close();
  }
}

/** Сентинел «не уложились в срок» — отличим от любого настоящего `T` (в
 *  отличие от `null`/строки, которые сама работа могла бы вернуть законно). */
const LOCK_TIMED_OUT = Symbol('presentationDraft.lockTimedOut');

function afterMs(ms: number): Promise<typeof LOCK_TIMED_OUT> {
  return new Promise((resolve) => setTimeout(() => resolve(LOCK_TIMED_OUT), ms));
}

/**
 * Замок с потолком (круг доработки 2). Один и тот же срок (`LOCK_TIMEOUT_MS`)
 * ограничивает ОБА участка одним и тем же дедлайном, а не двумя независимыми
 * окнами: сколько мы стоим в очереди за замком (через `AbortSignal` —
 * `locks.request` роняет запрос из очереди, если он ещё не выдан) и сколько
 * длится сама работа под уже выданным замком (через `Promise.race` внутри
 * колбэка — `locks.request` отпускает лок ровно тогда, когда СЕТТЛИТСЯ промис
 * колбэка, и гонка settle'ится по таймауту, даже если настоящая работа так и
 * не ответила). Общий дедлайн, а не два по `LOCK_TIMEOUT_MS` подряд: держатель,
 * которому дали замок в последний момент, не получает вторые полные десять
 * секунд поверх уже потраченных на ожидание.
 */
async function withLock<T>(fn: () => Promise<T>): Promise<T | typeof LOCK_TIMED_OUT> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const remainingMs = (): number => Math.max(0, deadline - Date.now());
  const bounded = (): Promise<T | typeof LOCK_TIMED_OUT> => Promise.race([fn(), afterMs(remainingMs())]);

  const locks = (globalThis as { navigator?: Navigator }).navigator?.locks;
  if (!locks || typeof locks.request !== 'function') return bounded();

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), remainingMs());
  try {
    return (await locks.request(LOCK_NAME, { signal: controller.signal }, bounded)) as T | typeof LOCK_TIMED_OUT;
  } catch (err) {
    // Оторвались от очереди по сроку — своя, названная причина, а не то же
    // самое, что «замок вообще не поддержан».
    if (err instanceof Error && err.name === 'AbortError') return LOCK_TIMED_OUT;
    // Замок может отсутствовать/отказать иначе; считать это отказом записи
    // было бы хуже, чем записать без него.
    if (err instanceof Error && /lock/i.test(err.name)) return bounded();
    throw err;
  } finally {
    clearTimeout(abortTimer);
  }
}

const sameDraft = (a: PresentationDraft, b: PresentationDraft): boolean =>
  a.dealId.toLowerCase() === b.dealId.toLowerCase() && a.issuedAt === b.issuedAt;

function mergeInto(list: PresentationDraft[], next: PresentationDraft): PresentationDraft[] {
  const previous = list.find((d) => sameDraft(d, next));
  // ⚠️ Отправленное НИКОГДА не понижается до неотправленного: опоздавшая
  // вкладка со своим «собрано» иначе стёрла бы факт отправки, и человек пошёл
  // бы предъявлять второй раз.
  const merged = previous && previous.state === 'sent' && next.state === 'built' ? previous : next;
  const rest = list.filter((d) => !sameDraft(d, next));
  const all = [...rest, merged].sort((a, b) => b.issuedAt - a.issuedAt);
  if (all.length <= MAX_DRAFTS_PER_PRESENTER) return all;
  // Тесно — выбрасываем сначала самые старые ОТПРАВЛЕННЫЕ: неотправленное
  // ценнее, оно единственное, чего человек ещё не сделал.
  const unsent = all.filter((d) => d.state === 'built');
  const sent = all.filter((d) => d.state === 'sent');
  const keepUnsent = unsent.slice(0, MAX_DRAFTS_PER_PRESENTER);
  const room = MAX_DRAFTS_PER_PRESENTER - keepUnsent.length;
  return [...keepUnsent, ...sent.slice(0, Math.max(0, room))].sort((a, b) => b.issuedAt - a.issuedAt);
}

export async function savePresentationDraft(draft: PresentationDraft): Promise<DraftSaveVerdict> {
  if (!isDraft(draft)) {
    // Наш собственный мусор — наружу громко, это баг вызывающего, не диска.
    throw new TypeError('savePresentationDraft: ожидается черновик предъявления');
  }
  const result = await withLock(async (): Promise<DraftSaveVerdict> => {
    try {
      const key = draftsKey(draft.presenter);
      const list = readList(await idbGet(key));
      await idbPut(key, { v: RECORD_VERSION, drafts: mergeInto(list, draft) });
      return 'saved';
    } catch {
      return 'disk_unavailable';
    }
  });
  // ⚠️ Сентинел таймаута переводится в СВОЁ имя здесь, на границе — внутрь
  // `withLock` он не течёт как строка, чтобы не спутать его случайно со
  // значением, которое вернула бы настоящая работа.
  return result === LOCK_TIMED_OUT ? 'lock_timeout' : result;
}

export async function readPresentationDrafts(
  presenter: `0x${string}`,
): Promise<PresentationDraft[]> {
  try {
    const list = readList(await idbGet(draftsKey(presenter)));
    return [...list].sort((a, b) => b.issuedAt - a.issuedAt);
  } catch {
    return [];
  }
}

export async function unsentPresentationDrafts(
  presenter: `0x${string}`,
): Promise<PresentationDraft[]> {
  return (await readPresentationDrafts(presenter)).filter((d) => d.state === 'built');
}

export async function markPresentationSent(
  presenter: `0x${string}`,
  dealId: `0x${string}`,
  issuedAt: number,
  bagKey: string,
  sentAt: number = Date.now(),
): Promise<DraftMarkVerdict> {
  const result = await withLock(async (): Promise<DraftMarkVerdict> => {
    const key = draftsKey(presenter);
    let list: PresentationDraft[];
    try {
      list = readList(await idbGet(key));
    } catch {
      return 'disk_unavailable';
    }
    const found = list.find(
      (d) => d.dealId.toLowerCase() === dealId.toLowerCase() && d.issuedAt === issuedAt,
    );
    if (!found) return 'not_found';
    const next = list.map((d) => (d === found ? { ...d, state: 'sent' as const, bagKey, sentAt } : d));
    try {
      await idbPut(key, { v: RECORD_VERSION, drafts: next });
    } catch {
      return 'disk_unavailable';
    }
    return 'saved';
  });
  return result === LOCK_TIMED_OUT ? 'lock_timeout' : result;
}
