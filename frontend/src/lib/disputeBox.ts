/**
 * disputeBox.ts — клиент ЯЩИКА СПОРА (план 4в-2, Задача 6).
 *
 * Ящик опознаётся адресом Agreement-контракта, нижним регистром. Не
 * идентификатором пары, не хэшем dealId, не адресом арбитра: арбитра можно
 * сменить, и ящик, привязанный к человеку, умирает вместе с его заменой —
 * новый пришёл бы к пустому ящику, а сторона считала бы, что предъявила
 * (§2.1 замысла).
 *
 * ⚠️ ЧТО ЗДЕСЬ НЕ ЗАВОДИТСЯ ЗАНОВО. Пропуск — тот же складской `x-bag-pass`,
 * бюджет чтения — тот же адресный, разбор отказа — тот же
 * `throwForFailedResponse`. Все эти имена импортируются из
 * `chatTransport.ts`; вторая копия любого из них расходится молча. Отсюда же
 * их берёт Задача 7 (экран арбитра) — второго клиента ящика в этом плане нет.
 *
 * ⚠️ `sealedFor` — СЛОВО КЛАДУЩЕГО. Сервер мешок не читает и проверить не
 * может; он хранит заголовок как есть и отдаёт с пометкой источника. Выдавать
 * его за проверенное запрещено везде — и в типе, и в тексте на экране.
 */
import {
  BAG_PASS_HEADER, RELAYER_URL, BagTransportError,
  encodePathSegment, reserveReadForPass, throwForFailedResponse,
} from './chatTransport';

/** Один вид на весь план: нижний регистр, ровно 40 hex. */
const AGREEMENT_RE = /^0x[0-9a-f]{40}$/;
const ADDR_ANY_RE = /^0x[0-9a-fA-F]{40}$/;

export interface DisputeBoxBag {
  /** Ключ мешка на складе: "<agreement>/<uploadedAt>-<uuid>.bin". */
  key: string;
  /** Кто положил — взят из пропуска, доказан подписью кошелька. */
  sender: `0x${string}`;
  /** ЗАЯВЛЕНО кладущим (`x-sealed-for`). Сервером НЕ проверено. `null` — не заявлено. */
  sealedFor: `0x${string}` | null;
  size: number;
  /** Время приёмки по часам СЕРВЕРА. Печатаем именно его, не свои часы. */
  uploadedAt: number;
  /**
   * Когда мешок забрали, по часам сервера. `null` — не забирали.
   *
   * ⚠️ ИМЕНИ ЗАБРАВШЕГО ОПИСЬ НЕ ХРАНИТ. После смены арбитра непустое
   * значение означает «забрал КТО-ТО из ведших спор», а не «забрал
   * нынешний». Так и говорить человеку.
   * ⚠️ И это правда ПРО БАЙТЫ, а не про доставку: отметка ставится
   * ненадёжно (`relayer/app.js:3526-3541`) — для мешка в 256 КиБ ядро
   * принимает ответ целиком раньше, чем клиент успеет оборвать.
   */
  fetchedAt: number | null;
}

export interface DisputeBoxList {
  bags: DisputeBoxBag[];
  /**
   * Кто ведёт спор — прочитано СЕРВЕРОМ из цепи (`disputeArbiterOf`).
   *
   * ⚠️ ЭТО НЕ МГНОВЕННЫЙ СНИМОК, и выдавать его за таковой нельзя. Значение
   * приходит из кэша фактов релеера со сроком `DISPUTE_BOX_TTL_MS` (15 с,
   * Задача 1) плюс придержка после неудачного чтения цепи. Значит арбитр,
   * только что взявший спор, до истечения кэша увидит здесь **предшественника**
   * — и текст на экране (Задача 7) обязан это допускать, а не утверждать про
   * цепь. Сторона на это поле не смотрит вовсе: ей ящик открыт по её же
   * пропуску.
   */
  arbiter: `0x${string}` | null;
  /** Сколько мешков заявлены на ДРУГИХ арбитров. Слово сервера, не цепи. */
  sealedForOthers: number;
  /**
   * Доверяет ли СЕРВЕР собственной описи мешков (ревью Задачи 1, круг 2).
   *
   * ⚠️ `false` — опись терялась и восстанавливалась с диска: у
   * восстановленных записей НЕТ полей `deal`/`sealedFor` (их неоткуда
   * взять из одного имени файла), они выпадают из ящика насовсем — значит
   * `bags` ВЫШЕ может быть пуст НЕ потому, что сторона ничего не
   * предъявляла, а потому что опись перестраивалась. Задача 7 обязана
   * сказать это человеку при `false`, а не подать пустой ящик как факт.
   */
  indexTrusted: boolean;
}

/** Наш мусор — громко. Чужие данные — вердикт; см. `listDisputeBox`. */
function assertAgreement(agreement: string): string {
  const lower = String(agreement).toLowerCase();
  if (!AGREEMENT_RE.test(lower)) {
    throw new TypeError(`disputeBox: ожидался адрес агримента 0x + 40 hex (получено «${agreement}»)`);
  }
  return lower;
}

/** ⚠️ Лоукейс ЗДЕСЬ, а не у вызывающего. `useAccount()` и `dealContexts`
 *  отдают адреса с контрольной суммой; пусти их в путь как есть — ящик
 *  раздвоится по регистру, и сторона положит мешок туда, куда арбитр не
 *  придёт. Один вид, и он делается в одном месте. */
function boxUrl(agreement: string): string {
  return `${RELAYER_URL}/disputes/${encodePathSegment(assertAgreement(agreement))}/bags`;
}

function isBag(x: unknown): x is DisputeBoxBag {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.key !== 'string' || o.key.length === 0) return false;
  if (typeof o.sender !== 'string' || !ADDR_ANY_RE.test(o.sender)) return false;
  if (!(o.sealedFor === null || (typeof o.sealedFor === 'string' && ADDR_ANY_RE.test(o.sealedFor)))) return false;
  if (typeof o.size !== 'number' || !Number.isFinite(o.size)) return false;
  if (typeof o.uploadedAt !== 'number' || !Number.isFinite(o.uploadedAt)) return false;
  // ⚠️ Ровно два законных вида: число или `null`. `undefined` — не «не
  // забирали», а «сервер отдал другую форму», и это не мелочь: на этом поле
  // держится единственное свидетельство стороны, что предъявление взяли.
  return o.fetchedAt === null || (typeof o.fetchedAt === 'number' && Number.isFinite(o.fetchedAt));
}

/**
 * Положить мешок в ящик спора.
 *
 * ⚠️ Тело — СЫРЫЕ БАЙТЫ, `application/octet-stream`. Ни base64, ни hex на
 * этом стыке. И `application/json` тут — не «другой заголовок», а
 * съеденное общим json-мидлваром тело: склад уже ловил этот случай и отвечает
 * на него отдельным кодом (`relayer/app.js:3162-3165`).
 */
export async function putDisputeBag(
  pass: string,
  agreement: `0x${string}`,
  sealed: Uint8Array,
  sealedFor: `0x${string}` | null,
  signal?: AbortSignal,
): Promise<{ key: string; uploadedAt: number }> {
  if (!(sealed instanceof Uint8Array) || sealed.byteLength === 0) {
    throw new TypeError('putDisputeBag: мешок должен быть непустым Uint8Array');
  }
  // ⚠️ `null` ЗАКОНЕН (договор шапки): заголовок необязателен, и мешок без
  // него — не ошибка. А вот мусор вместо адреса — наш мусор, и он громкий:
  // сервер отвечает на него `invalid_sealed_for`, то есть отказом там, где
  // человек ничего исправить не может.
  if (sealedFor !== null && (typeof sealedFor !== 'string' || !ADDR_ANY_RE.test(sealedFor))) {
    throw new TypeError(`putDisputeBag: ожидался адрес арбитра или null (получено «${String(sealedFor)}»)`);
  }
  const res = await fetch(boxUrl(agreement), {
    method: 'PUT',
    headers: {
      [BAG_PASS_HEADER]: pass,
      'content-type': 'application/octet-stream',
      // Слово кладущего, не факт. Сервер его не проверяет и не может.
      ...(sealedFor === null ? {} : { 'x-sealed-for': sealedFor.toLowerCase() }),
    },
    body: sealed as BodyInit,
    signal,
  });
  if (!res.ok) await throwForFailedResponse(res, 'Failed to store dispute bag', pass);
  const body = (await res.json()) as { key?: unknown; uploadedAt?: unknown } | null;
  // ⚠️ ВРЕМЯ ПРИЁМКИ ОБЯЗАТЕЛЬНО, и разбирается оно ЗДЕСЬ. Человеку
  // показывается серверное «положено в 14:02»; возьми клиент свои часы — на
  // телефоне со сбитым временем оно разошлось бы с описью у арбитра, а спор
  // ровно то место, где порядок событий имеет цену.
  if (!body || typeof body !== 'object'
    || typeof body.key !== 'string' || body.key.length === 0
    || typeof body.uploadedAt !== 'number' || !Number.isFinite(body.uploadedAt)) {
    throw new BagTransportError('Malformed response from PUT /disputes/:agreement/bags');
  }
  return { key: body.key, uploadedAt: body.uploadedAt };
}

/** Опись ящика. Съедает одно чтение адресного бюджета — тот же, что у склада. */
export async function listDisputeBox(
  pass: string, agreement: `0x${string}`, signal?: AbortSignal,
): Promise<DisputeBoxList> {
  await reserveReadForPass(pass);
  const res = await fetch(boxUrl(agreement), { headers: { [BAG_PASS_HEADER]: pass }, signal });
  if (!res.ok) await throwForFailedResponse(res, 'Failed to list dispute box', pass);

  const body: unknown = await res.json();
  if (!body || typeof body !== 'object') {
    throw new BagTransportError('Malformed response from GET /disputes/:agreement/bags: not an object');
  }
  const { bags, arbiter, sealedForOthers, indexTrusted } = body as Record<string, unknown>;
  if (!Array.isArray(bags)) {
    throw new BagTransportError('Malformed dispute box: bags is not an array');
  }
  for (const b of bags) {
    if (!isBag(b)) throw new BagTransportError('Malformed bag entry in dispute box listing');
  }
  if (!(arbiter === null || (typeof arbiter === 'string' && ADDR_ANY_RE.test(arbiter)))) {
    throw new BagTransportError('Malformed dispute box: arbiter is neither null nor an address');
  }
  if (typeof sealedForOthers !== 'number' || !Number.isFinite(sealedForOthers)) {
    throw new BagTransportError('Malformed dispute box: sealedForOthers is not a number');
  }
  // ⚠️ Ревью, круг 2: `boolean` строго — не «истинность», а именно тип.
  // Пропусти сюда `undefined` (старый релеер, поле ещё не выкачено) и
  // клиент молча решит «опись доверенная» на сервере, который об этом
  // ничего не говорил, — то есть подменит осторожную неизвестность
  // оптимизмом ровно там, где цена ошибки — пустой ящик, принятый за факт.
  if (typeof indexTrusted !== 'boolean') {
    throw new BagTransportError('Malformed dispute box: indexTrusted is not a boolean');
  }
  return {
    bags: bags as DisputeBoxBag[],
    arbiter: (arbiter as `0x${string}` | null),
    sealedForOthers,
    indexTrusted,
  };
}

/**
 * Забрать один мешок.
 *
 * ⚠️ КЛЮЧ ОПИСИ — ДВА СЕГМЕНТА, МАРШРУТ ЗАБОРА — ОДИН. Опись отдаёт
 * `"<agreement>/<uploadedAt>-<uuid>.bin"`, а `GET /disputes/:agreement/bags/:name`
 * принимает только вторую половину. Режем по ПЕРВОМУ `/` и сверяем префикс с
 * тем ящиком, который просили: не сойдётся — это НАШ мусор, а не состояние
 * спора, и молча ходить не в тот ящик мы не будем.
 */
export async function fetchDisputeBag(
  pass: string, agreement: `0x${string}`, key: string, signal?: AbortSignal,
): Promise<Uint8Array | null> {
  const lower = assertAgreement(agreement);
  const slash = String(key).indexOf('/');
  if (slash === -1) throw new TypeError(`fetchDisputeBag: ключ без ящика («${key}»)`);
  const prefix = key.slice(0, slash).toLowerCase();
  if (prefix !== lower) {
    throw new TypeError(`fetchDisputeBag: ключ из ящика «${prefix}», а просили «${lower}»`);
  }
  await reserveReadForPass(pass);
  const url = `${boxUrl(agreement)}/${encodePathSegment(key.slice(slash + 1))}`;
  const res = await fetch(url, { headers: { [BAG_PASS_HEADER]: pass }, signal });
  if (res.status === 404) return null;
  if (!res.ok) await throwForFailedResponse(res, 'Failed to fetch dispute bag', pass);
  const buf = await res.arrayBuffer();
  // Настоящий запечатанный мешок — минимум ключ + тег: ноль байт это шум, а
  // не пустой мешок (та же развилка, что в `fetchBag`).
  if (buf.byteLength === 0) throw new BagTransportError('Empty dispute bag body');
  return new Uint8Array(buf);
}
