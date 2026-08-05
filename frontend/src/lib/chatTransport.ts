/**
 * chatTransport.ts — тупой транспорт мешков: возит байты и держит пропуск.
 *
 * НЕ ЗНАЕТ: про `chatCrypto.ts` (шифрует содержимое мешка — ключи, вывод
 * пары, запечатывание/распечатывание) и про `chatChain.ts` (строит цепочку
 * сообщений), про React, про кошелёк напрямую — `signMessage` приходит
 * аргументом, не импортом. Единственная связь с подписью — вызывающая
 * сторона передаёт функцию, умеющую подписать строку; что она делает внутри
 * (viem, ethers, встроенный кошелёк), этому модулю не важно и не видно.
 * Проверяется буквально — ни статических, ни динамических импортов этих
 * двух модулей и React в файле нет вовсе (разбор ревью программный, по
 * дереву импортов, не по словам в комментариях).
 *
 * СЕРВЕР: маршруты `/bags/*` (Задача 3 плана «Транспорт и хранение мешков»).
 * Он сам ничего не знает о содержимом мешка — только адреса, размеры, время —
 * и этот модуль честно продолжает ту же слепоту на своей стороне.
 *
 * ─── ПРОПУСК ───────────────────────────────────────────────────────────
 *
 * `requestBagPass(signMessage, address)` кэширует результат в памяти модуля
 * (на вкладку — не переживает перезагрузку и не расшарен между вкладками,
 * см. вопрос №3 в отчёте задачи) и на живом непротухшем пропуске НЕ ходит
 * в сеть и НЕ зовёт `signMessage` — просто отдаёт то, что уже есть. Это не
 * мелочь: именно на этом держится образец повтора ниже — если бы каждый
 * вызов дёргал кошелёк, повторный вызов после ошибки означал бы второе окно
 * подписи на то же самое сообщение, ровно то, чего вся эта конструкция
 * должна избегать.
 *
 * `listBags`/`putBag`/`fetchBag` подписи не видят вовсе — у них нет ни
 * `signMessage`, ни адреса, только опаковый `pass: string`. Значит
 * переподписаться сами они не могут даже теоретически (правильный разбор
 * этого — то, из-за чего пример в исходном брифе задачи не годится буквально:
 * там `listBags(pass)` сама якобы ходит за новым пропуском, не имея под
 * рукой ничего, чем можно подписать челлендж). На протухший или неверный
 * пропуск (`401`) они бросают `BagPassError` с полем `.code`
 * (`'pass_expired' | 'pass_invalid'` — коды сервера, не текст для парсинга).
 *
 * ⚠️ ПЕРЕД тем как бросить — они САМИ забывают кэш этого адреса
 * (`forgetBagPass`, извлекая адрес прямо из тела пропуска, см. ниже). Это не
 * опционально: пропуск живёт 12 часов по КЛИЕНТСКИМ часам, и если сервер
 * начал отвечать `401` РАНЬШЕ (перезапуск с новым секретом, разъехавшиеся в
 * разрешённых ±5 минут часы, урезанный прокси заголовок), а кэш никто не
 * трогает — `requestBagPass` смотрит СВОИ часы, видит «живой» кэш и отдаёт
 * ТОТ ЖЕ мёртвый пропуск навсегда: образец ниже без этого не выходит из
 * отказа, а поллер молотит один и тот же 401 каждый тик до перезагрузки
 * вкладки (найдено ревью, C1 — заявленный «правильный» образец повтора сам
 * содержал ровно ту дыру, ради которой был написан). Обновление пропуска и
 * ПОВТОР — по-прежнему дело вызывающей стороны, а не транспорта; но ЗАБЫТЬ
 * мёртвый пропуск — дело транспорта, потому что только он в момент 401
 * достоверно знает, что пропуск мёртв.
 *
 * ОБРАЗЕЦ ПРАВИЛЬНОГО ПОВТОРА (скопируйте буквально, не сочиняйте свой):
 *
 *   try {
 *     return await listBags(pass);
 *   } catch (e) {
 *     if (e instanceof BagPassError) {
 *       // Кэш уже пуст — listBags выбросила его сама на этом самом 401,
 *       // так что requestBagPass ниже НЕ отдаст тот же мёртвый пропуск:
 *       // она реально попросит у кошелька новую подпись.
 *       const fresh = await requestBagPass(signMessage, address);
 *       return await listBags(fresh.pass);                        // повтор РОВНО один раз
 *     }
 *     throw e;
 *   }
 *
 * ЧЕГО ДЕЛАТЬ НЕЛЬЗЯ: заворачивать это в `while (true)` или в цикл ретраев
 * РУКАМИ. Если пропуск не обновляется (сервер лежит, часы на устройстве
 * сильно разъехались, секрет сменился) — такой цикл будет спрашивать
 * подпись у человека бесконечно, окно за окном, без единого шанса на успех.
 * Один повтор — это «дать второй шанс транзиентной проблеме»; второй повтор
 * — это уже упрямство мимо человека.
 *
 * ⚠️ `pollBags` НИЖЕ — это САМА ФОРМА такого цикла (она зовёт `getPass` на
 * каждый тик, снова и снова, потенциально бесконечно) — и это не
 * противоречие, а единственное место, где так делать можно, ПОТОМУ ЧТО у
 * неё есть то, чего нет у ручного кода: она сама считает подряд идущие
 * `BagPassError` и останавливается на `authFailureLimit`, зовя
 * `onAuthFailed` (C1-R1, отчёт задачи — критическая находка: реализация C1
 * выше сама была ровно тем зацикливанием, которое этот абзац запрещает, до
 * этого фикса). Если вы пишете СВОЙ цикл опроса поверх `listBags`/`getPass`
 * вместо `pollBags` — этот запрет снова в силе безо всякого исключения, и
 * защиты, которую даёт `authFailureLimit`, у вас не будет, пока вы не
 * скопируете и её тоже.
 *
 * В этом проекте это уже ТРЕТИЙ раз, когда ближайший пример для
 * копирования оказывался плохим — включая сам этот образец, до фикса C1, и
 * саму `pollBags`, до фикса C1-R1 — не повторяйте это в четвёртый.
 *
 * ─── ОШИБКИ ─────────────────────────────────────────────────────────────
 *
 * Три класса, и каждый несёт `.code` ОТДЕЛЬНЫМ полем — сравнение текста
 * ошибки ломается молча на первой же правке формулировки на сервере:
 *   - `BagPassError`      — 401, пропуск неверен или истёк.
 *   - `BagRateLimitError` — 429, плюс `.retryAfterSec` (см. «Опрос» ниже).
 *   - `BagTransportError` — всё остальное: сеть жива, сервер ответил, но
 *                            не тем кодом статуса или не той формой тела
 *                            (в том числе — мусор вместо JSON).
 * Сетевой сбой (сам `fetch` бросил — сервер недоступен) НИЧЕМ не
 * оборачивается и летит наружу как есть: недоступность сервера не должна
 * выглядеть как штатный ответ «мешков нет» или «мешка нет» — тот же класс
 * ошибки, что `openSealed` в ядре не должен носить костюм штатного
 * результата.
 *
 * Пустой список (`[]` от `listBags`) и отказ доступа (`401`/`429`/…) —
 * НЕ взаимозаменяемы: первое отдаётся как значение, второе — бросается.
 * Смешать их значило бы, что переписка «исчезает» на глазах у человека,
 * хотя она на месте, просто пропуск истёк.
 *
 * ─── ОПРОС ──────────────────────────────────────────────────────────────
 *
 * `pollBags` — не React-хук, обычная функция с `stop()`. Решение владельца
 * (план «Транспорт и хранение мешков», 4 августа 2026): не чаще раза в 5 с
 * при открытом чате, раза в 30 с в фоне — у релеера один процессор, и опрос
 * раз в секунду тысячей человек означал бы под тысячу запросов в секунду
 * ему одному. Цикл последовательный (`await`, не `setInterval`): следующий
 * тик планируется только после того, как предыдущий запрос завершился
 * (успехом или ошибкой), так что медленный ответ не кладёт второй запрос в
 * полёт поверх первого. На `429` откладывает следующий тик минимум до
 * `Retry-After` сервера, а не бьёт с базовым интервалом в тот же лимитер —
 * тот же принцип, что `lib/rpcProxy.ts` уже применяет к приватному узлу
 * («429 — это ограничение по частоте, повтор в лоб превращается в шторм
 * повторов ровно по тому лимиту, который уже превышен»).
 */

// Хвостовой слэш срезан — та же дисциплина, что уже применена в шести
// других местах проекта, читающих эту же переменную (lib/xmtp.ts:911,
// app/api/ipfs/upload/route.ts, app/api/relay/route.ts,
// app/api/dispute-reason/route.ts): без среза "http://host/" даёт
// "http://host//bags/pass" — двойной слэш, который не всякий сервер
// нормализует сам.
const RELAYER_URL = (process.env.NEXT_PUBLIC_RELAYER_URL ?? 'http://localhost:3001').replace(/\/$/, '');

const BAG_PASS_HEADER = 'x-bag-pass';

export interface BagSummary {
  key: string;
  sender: `0x${string}`;
  size: number;
  uploadedAt: number;
}

/* ───────────────────────────── ошибки ───────────────────────────────── */

export class BagTransportError extends Error {
  readonly code?: string;
  readonly status?: number;
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = 'BagTransportError';
    this.code = code;
    this.status = status;
  }
}

/** 401 — пропуск неверен или истёк. `.code` — `'pass_invalid'` |
 *  `'pass_expired'` | `'missing_credentials'` | … (коды сервера, см.
 *  relayer/bagPass.js и relayer/app.js). */
export class BagPassError extends BagTransportError {
  constructor(message: string, code: string | undefined, status: number) {
    super(message, code, status);
    this.name = 'BagPassError';
  }
}

/** 429 — сервер просит отступить. `retryAfterSec` — минимум, на который
 *  надо отложить следующую попытку (см. `pollBags`). */
export class BagRateLimitError extends BagTransportError {
  readonly retryAfterSec: number;
  constructor(message: string, code: string | undefined, retryAfterSec: number) {
    super(message, code, 429);
    this.name = 'BagRateLimitError';
    this.retryAfterSec = retryAfterSec;
  }
}

/** Сервер сам всегда шлёт `Retry-After: 60` на своём лимитере
 *  (relayer/app.js, `bagRateLimited()`), но заголовок теоретически может не
 *  дойти (прокси, урезающий заголовки) — тогда это не значит «лимита нет»,
 *  это значит «не сказали, сколько ждать», и запасное число берём равным
 *  тому, что сервер шлёт сегодня. */
const DEFAULT_RETRY_AFTER_SEC = 60;

/* ─────────────────────── кэш пропуска и его выброс ──────────────────────
 * Определён здесь, а не ниже (вместе с `requestBagPass`), потому что
 * `throwForFailedResponse` уже здесь на него ссылается — 401 у ЛЮБОГО из
 * трёх потребляющих маршрутов обязан уметь выбросить кэш немедленно. */

const ETH_ADDR_RE = /^0x[0-9a-f]{40}$/;

/** На вкладку, в памяти модуля — НЕ localStorage/sessionStorage. Переживает
 *  переходы внутри вкладки, не переживает перезагрузку; две вкладки держат
 *  каждая свой кэш и не видят друг друга (см. вопрос №3 в отчёте задачи). */
const _passCache = new Map<string, { pass: string; expiresAt: number }>();

/**
 * Выбрасывает кэш конкретного адреса. Публичная — пригодится и потребителю
 * (например, при явном разлогине/смене аккаунта), но в первую очередь её
 * зовут ИЗНУТРИ `listBags`/`putBag`/`fetchBag` на каждый `401` (C1, отчёт
 * задачи): только транспорт в момент 401 достоверно знает, что пропуск
 * мёртв, и не должен ждать, пока кто-то снаружи додумается его выбросить.
 */
export function forgetBagPass(address: string): void {
  _passCache.delete(address.toLowerCase());
}

/**
 * Достаёт адрес прямо из тела пропуска — БЕЗ проверки MAC (это не проверка
 * подлинности, сервер её всё равно сделает сам на следующем запросе; здесь
 * только «чей кэш выбросить»). Формат — `v1.<base64url(adr.expiresAt)>.<mac>`,
 * тот же, что `issueBagPass()` в `relayer/bagPass.js`. Неразбираемый токен —
 * `null`: тогда выбрасывать нечего, это не повод падать самому 401-обработчику.
 */
function base64UrlDecode(s: string): string {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
  if (typeof atob === 'function') {
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  // Node/SSR без atob (тесты, серверный рендер) — тот же байт-порядок через Buffer.
  return Buffer.from(padded, 'base64').toString('utf8');
}

function parseBagPassAddress(pass: string): string | null {
  const parts = pass.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  let body: string;
  try {
    body = base64UrlDecode(parts[1]);
  } catch {
    return null;
  }
  const addr = body.split('.')[0] ?? '';
  return ETH_ADDR_RE.test(addr) ? addr : null;
}

/**
 * Выбрасывает кэш ТОЛЬКО если он всё ещё держит ИМЕННО этот проваленный
 * токен (мелочь ревью). Без сравнения — запоздавший 401 по уже
 * вытесненному (старому) пропуску убивал бы СВЕЖИЙ пропуск того же
 * адреса, который тем временем успел встать в кэш (например, из другого
 * тика опроса): цена — лишний поход в сеть и лишнее окно кошелька там, где
 * кэш был совершенно рабочим. Публичный `forgetBagPass(address)` (для
 * явного разлогина и т.п.) сравнения НЕ делает и выбрасывает безусловно —
 * это намеренно другое поведение для другого вызывающего.
 */
function forgetBagPassByToken(pass: string): void {
  const addr = parseBagPassAddress(pass);
  if (!addr) return;
  if (_passCache.get(addr)?.pass === pass) {
    _passCache.delete(addr);
  }
}

async function parseErrorBody(res: Response): Promise<{ error?: string; code?: string }> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object') return body as { error?: string; code?: string };
  } catch {
    // Тело не JSON (HTML от прокси, оборванный ответ) — само по себе не
    // повод молчать про отказ, просто код сервера мы не узнаем.
  }
  return {};
}

function retryAfterSecOf(res: Response): number {
  const raw = res.headers?.get?.('retry-after');
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETRY_AFTER_SEC;
}

/**
 * `passToForget` — передайте `pass`, если вызывающий код держит опаковый
 * токен, из которого стоит выбросить кэш на 401 (см. `forgetBagPass` ниже и
 * C1 в отчёте задачи). `requestBagPass` сама этот параметр не передаёт: она
 * ещё ничего не закэшировала, выбрасывать нечего.
 */
async function throwForFailedResponse(res: Response, fallback: string, passToForget?: string): Promise<never> {
  const body = await parseErrorBody(res);
  if (res.status === 401) {
    if (passToForget) forgetBagPassByToken(passToForget);
    throw new BagPassError(body.error ?? fallback, body.code, 401);
  }
  if (res.status === 429) throw new BagRateLimitError(body.error ?? fallback, body.code, retryAfterSecOf(res));
  throw new BagTransportError(body.error ?? fallback, body.code, res.status);
}

/* ───────────────────────────── пропуск ──────────────────────────────── */

export interface BagPass {
  pass: string;
  expiresAt: number;
}

/** Запас на дорогу до релеера — тот же приём, что `disputeLogPass.ts`:
 *  пропуск, которому осталось меньше, считаем истёкшим ЗДЕСЬ, вместо
 *  гарантированного 401 с той стороны на следующем же вызове. */
const PASS_EXPIRY_SKEW_SEC = 30;

function cachedPass(addr: string, nowSec: number): BagPass | null {
  const entry = _passCache.get(addr);
  if (!entry) return null;
  if (entry.expiresAt - PASS_EXPIRY_SKEW_SEC <= nowSec) return null;
  return entry;
}

function isBagPassBody(x: unknown): x is BagPass {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.pass === 'string' && o.pass.length > 0 &&
    typeof o.expiresAt === 'number' && Number.isFinite(o.expiresAt);
}

/** Дедуп в полёте (мелочь ревью) — на холодном кэше два ОДНОВРЕМЕННЫХ
 *  вызова `requestBagPass` для ОДНОГО адреса раньше давали два независимых
 *  окна кошелька: кэш заполняется только ПОСЛЕ того, как первый вызов
 *  долетит до сети, а второй к этому моменту уже успел стартовать свой
 *  собственный `signMessage()`. Ключ — адрес: второй одновременный вызов
 *  того же адреса просто ждёт тот же промис, не начиная свой. */
const _inFlight = new Map<string, Promise<BagPass>>();

export async function requestBagPass(
  signMessage: (msg: string) => Promise<string>,
  address: `0x${string}`,
): Promise<BagPass> {
  const addr = address.toLowerCase();
  const nowSec = Math.floor(Date.now() / 1000);

  const cached = cachedPass(addr, nowSec);
  if (cached) return cached;

  const pending = _inFlight.get(addr);
  if (pending) return pending;

  const promise = (async (): Promise<BagPass> => {
    const ts = String(nowSec);
    // Формат фразы совпадает буквально с bagPassChallenge() на сервере
    // (relayer/bagPass.js) — менять что-либо здесь без синхронной правки там
    // означает подписывать фразу, которую сервер не восстановит.
    const message = `hexseal:chat-bags:${addr}:${ts}`;
    const sig = await signMessage(message);

    const res = await fetch(`${RELAYER_URL}/bags/pass`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ts': ts, 'x-sig': sig },
      body: JSON.stringify({ address: addr }),
    });
    if (!res.ok) await throwForFailedResponse(res, 'Failed to obtain bag pass');

    const body: unknown = await res.json();
    if (!isBagPassBody(body)) throw new BagTransportError('Malformed response from POST /bags/pass');

    const fresh: BagPass = { pass: body.pass, expiresAt: body.expiresAt };
    _passCache.set(addr, fresh);
    return fresh;
  })();

  // Снимается и при успехе, и при отказе — застрявшая запись держала бы
  // ВСЕ следующие вызовы этого адреса на уже провалившемся промисе
  // навсегда, вместо того чтобы дать им попробовать заново.
  _inFlight.set(addr, promise);
  promise.finally(() => {
    if (_inFlight.get(addr) === promise) _inFlight.delete(addr);
  }).catch(() => {}); // не создавать необработанное отклонение здесь — оно уже летит из `promise` самого

  return promise;
}

/** Только для тестов: забыть весь кэш пропусков и записи "в полёте" между
 *  кейсами — иначе повисший (например, никогда не разрешённый в тесте)
 *  дедуп-промис одного теста мог бы прилипнуть к следующему. */
export function _resetBagPassCacheForTest(): void {
  _passCache.clear();
  _inFlight.clear();
}

/* ────────────────────────────── putBag ──────────────────────────────── */

function isPutBagBody(x: unknown): x is { key: string } {
  return !!x && typeof x === 'object' && typeof (x as Record<string, unknown>).key === 'string' &&
    (x as { key: string }).key.length > 0;
}

export async function putBag(
  pass: string,
  recipient: `0x${string}`,
  sealed: Uint8Array,
): Promise<{ key: string }> {
  const res = await fetch(`${RELAYER_URL}/bags/${recipient.toLowerCase()}`, {
    method: 'PUT',
    headers: {
      [BAG_PASS_HEADER]: pass,
      // НЕ 'application/json' — сервер съедает такое тело своим общим
      // json()-мидлваром ДО этого маршрута и молча пишет 0 байт (найдено в
      // Задаче 3). Отправитель тоже НЕ идёт сюда никаким полем тела —
      // сервер берёт его из пропуска, и лишнее поле было бы ложью о том,
      // что оно на что-то влияет.
      'content-type': 'application/octet-stream',
    },
    // `as BodyInit` — chatTransport остаётся на ES2020, а `lib.dom.d.ts`
    // текущего TypeScript (5.9) типизирует BodyInit через параметризованный
    // `Uint8Array<ArrayBufferLike>`, с которым обычный `Uint8Array` конфликтует
    // чисто по типам (известная нестыковка версий, не связанная с рантаймом:
    // `fetch` реально принимает `Uint8Array` как тело — это ArrayBufferView).
    body: sealed as BodyInit,
  });
  if (!res.ok) await throwForFailedResponse(res, 'Failed to store bag', pass);

  const body: unknown = await res.json();
  if (!isPutBagBody(body)) throw new BagTransportError('Malformed response from PUT /bags/:recipient');
  return { key: body.key };
}

/* ────────────────────────────── listBags ────────────────────────────── */

const SENDER_RE = /^0x[0-9a-fA-F]{40}$/;

function isBagSummary(x: unknown): x is BagSummary {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.key === 'string' && o.key.length > 0 &&
    typeof o.sender === 'string' && SENDER_RE.test(o.sender) &&
    typeof o.size === 'number' && Number.isFinite(o.size) &&
    typeof o.uploadedAt === 'number' && Number.isFinite(o.uploadedAt)
  );
}

/**
 * `signal` — необязательный, третий параметр (не часть исходного интерфейса
 * задачи `listBags(pass, since?)`, но обратно совместимый: ни один
 * существующий двухаргументный вызов не меняет поведения). Даёт
 * `pollBags` возможность реально ПРЕРВАТЬ запрос в полёте на `stop()`
 * (мелочь ревью), а не просто дождаться и отбросить результат.
 */
export async function listBags(pass: string, since?: number, signal?: AbortSignal): Promise<BagSummary[]> {
  const url = new URL(`${RELAYER_URL}/bags`);
  if (since !== undefined) url.searchParams.set('since', String(since));

  const res = await fetch(url.toString(), { headers: { [BAG_PASS_HEADER]: pass }, signal });
  if (!res.ok) await throwForFailedResponse(res, 'Failed to list bags', pass);

  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new BagTransportError('Malformed response from GET /bags: not an array');
  for (const item of body) {
    if (!isBagSummary(item)) throw new BagTransportError('Malformed bag entry in GET /bags response');
  }
  return body as BagSummary[];
}

/* ────────────────────────────── fetchBag ─────────────────────────────── */

export async function fetchBag(pass: string, key: string): Promise<Uint8Array | null> {
  const res = await fetch(`${RELAYER_URL}/bags/${key}`, { headers: { [BAG_PASS_HEADER]: pass } });

  // Чужой ключ и несуществующий отвечают одинаковым 404 (see relayer/app.js) —
  // намеренно не парсим тело здесь: сервер на эту ветку тела может не дать.
  if (res.status === 404) return null;
  if (!res.ok) await throwForFailedResponse(res, 'Failed to fetch bag', pass);

  const buf = await res.arrayBuffer();
  // Мелочь (ревью): реальный запечатанный мешок — минимум IV + тег
  // аутентификации AES-256-GCM, никогда не ноль байт (сервер применяет
  // РОВНО это же правило на приёме, relayer/app.js PUT /bags/:recipient).
  // 0 байт на скачивании — не легитимный пустой мешок, а шум; ядро
  // шифрования это тоже отловит на расшифровке, но нет смысла доводить
  // очевидный мусор до чужого модуля, когда транспорт уже видит его сам.
  if (buf.byteLength === 0) throw new BagTransportError('Empty bag body');
  return new Uint8Array(buf);
}

/* ───────────────────────────────── опрос ─────────────────────────────── */

export interface BagPollIntervalsMs {
  /** Опрос при открытом/активном чате. */
  activeMs: number;
  /** Опрос, когда вкладка/чат в фоне. */
  backgroundMs: number;
  /**
   * Верхний потолок отступления при отказе — по любой причине: и явный
   * `Retry-After` от 429, и нарастание при повторяющихся ошибках (см.
   * `pollBags`). Без потолка на 429 (I3, ревью-координатор, важная находка):
   * `Retry-After: 3000000` (3 млн секунд — опечатка в секундах вместо
   * миллисекунд, тестовое значение на проде, что угодно) даёт задержку в 3
   * МИЛЛИАРДА миллисекунд — выше предела, который таймер (HTML/Node,
   * 32-битное знаковое число, ~24.8 дня) молча укорачивает почти до нуля.
   * Замерено координатором вживую на настоящем таймере: «отступление»
   * переворачивалось в тесный цикл — три отказа меньше чем за полсекунды, с
   * предупреждением среды выполнения, ровно тогда, когда сервер просил
   * отойти дальше всех.
   */
  maxBackoffMs: number;
}

/** Решение владельца (план «Транспорт и хранение мешков», 4 августа 2026):
 *  не чаще раза в 5 секунд при открытом чате, раза в 30 секунд в фоне.
 *  `maxBackoffMs` — 5 минут, см. докстринг поля выше. */
export const DEFAULT_BAG_POLL_INTERVALS: BagPollIntervalsMs = {
  activeMs: 5_000,
  backgroundMs: 30_000,
  maxBackoffMs: 5 * 60 * 1000,
};

export interface BagPollHandle {
  /** Останавливает опрос. Идемпотентна — повторный вызов ничего не делает. */
  stop(): void;
}

/** Сколько подряд идущих отказов подлинности (401, `BagPassError`) терпеть,
 *  прежде чем остановиться и позвать `onAuthFailed` (C1-R1, отчёт задачи).
 *  Три — по прямому решению координатора: достаточно, чтобы пережить
 *  единичный транзиентный сбой (сервер моргнул между minted-пропуском и
 *  проверкой), и достаточно мало, чтобы не превратиться в те же
 *  бесконечные окна кошелька, которые весь этот механизм и должен
 *  прекращать. */
export const DEFAULT_AUTH_FAILURE_LIMIT = 3;

export interface BagPollOptions {
  /**
   * Свежий пропуск на каждый тик. Обычно — обёртка над `requestBagPass`
   * (`() => requestBagPass(signMessage, address).then(p => p.pass)`): та
   * функция сама кэширует и переспрашивает подпись, так что здесь не нужно
   * знать ни про кошелёк, ни про React.
   *
   * ⚠️ Это ПОДКЛЮЧЕНИЕ, а не образец из шапки модуля выше — `pollBags` сама
   * является тем самым циклом, о котором шапка предупреждает («заворачивать
   * это в while(true)... подпись у человека бесконечно»), и делает его
   * безопасным СВОИМИ средствами: считает подряд идущие `BagPassError` и
   * останавливается на `authFailureLimit`, зовя `onAuthFailed` (C1-R1,
   * отчёт задачи). Собственный ручной цикл ретраев ВОКРУГ `pollBags` поверх
   * этого — снова тот самый запрет из шапки, теперь без единственной
   * защиты, которая у `pollBags` для него и есть.
   */
  getPass: () => string | Promise<string>;
  since?: number;
  /** true — чат/вкладка активны (используется `activeMs`), false — фон. */
  isActive: () => boolean;
  onBags: (bags: BagSummary[]) => void;
  onError?: (err: unknown) => void;
  /**
   * Зовётся, если сам `onBags` бросил (баг колбэка потребителя —
   * например, отрисовки — а НЕ транспорта: намеренно ОТДЕЛЬНЫЙ обработчик
   * от `onError`, не смешивать классы). Опрос в любом случае
   * останавливается — тик, на котором сломался рендер, доверия не
   * заслуживает, а не потому что эта конкретная ошибка «тяжелее» сетевой.
   * Мелочь ревью: без `onBagsError` единственным сигналом было
   * необработанное отклонение промиса (`unhandledrejection`) — в браузере
   * это строка в консоли, а не что-то, что потребитель может поймать
   * программно, чтобы показать человеку «что-то сломалось, обновите
   * страницу». Отклонение по-прежнему происходит (полезно для
   * инструментов вроде Sentry, слушающих `window.onunhandledrejection`) —
   * `onBagsError` это ДОПОЛНЕНИЕ, не замена.
   */
  onBagsError?: (err: unknown) => void;
  /**
   * Зовётся РОВНО один раз, когда подряд идущих `BagPassError` набралось
   * `authFailureLimit` — опрос ОСТАНАВЛИВАЕТСЯ (см. докстринг `getPass`
   * выше и C1-R1 в отчёте задачи). Дать потребителю сигнал «пропуск не
   * восстанавливается, войдите заново» вместо того, чтобы молча продолжать
   * спрашивать у человека подписи, которые не могут сработать.
   */
  onAuthFailed?: () => void;
  /** По умолчанию — `DEFAULT_AUTH_FAILURE_LIMIT` (3). */
  authFailureLimit?: number;
  intervals?: BagPollIntervalsMs;
  /** Только для тестов — не спать по-настоящему. */
  sleep?: (ms: number) => Promise<void>;
}

export function pollBags(opts: BagPollOptions): BagPollHandle {
  let stopped = false;
  const intervals = opts.intervals ?? DEFAULT_BAG_POLL_INTERVALS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const authFailureLimit = opts.authFailureLimit ?? DEFAULT_AUTH_FAILURE_LIMIT;
  // I4 (ревью-координатор, важная находка): раньше отступление срабатывало
  // ТОЛЬКО на явный 429 — сеть лежит, 500, затянувшийся 401 давали ровно
  // базовый интервал бесконечно (замер координатора: [5000,5000,5000,5000]).
  // Сервер или сеть сигналят "мне плохо" любым отказом, не только 429.
  let consecutiveFailures = 0;
  // C1-R1 (ревью-координатор, КРИТИЧЕСКАЯ находка): отдельный счётчик,
  // строго подмножество consecutiveFailures — только BagPassError.
  // Без него `getPass`, подключённый ровно так, как предписывает её же
  // докстринг, спрашивала бы у кошелька новую подпись на КАЖДЫЙ тик
  // бесконечно, если сервер отвечает 401 систематически (расхождение
  // версий, испорченный секрет, съехавшие часы) — C1 из прошлого раунда
  // чинил ЗАСТРЕВАНИЕ на мёртвом пропуске, но не заметил, что лекарство
  // открывает противоположную дыру: пропуск больше не застревает, но и
  // ничто не мешает переподписывать его бесконечно.
  let consecutiveAuthFailures = 0;
  // Мелочь ревью: stop() раньше только ставила флаг — запрос, УЖЕ ушедший в
  // сеть (`listBags`), не прерывался, он просто дожидался ответа и
  // отбрасывался. `currentAbort` — контроллер ТЕКУЩЕГО тика; stop() зовёт
  // `.abort()`, если он есть. `getPass()` сюда не входит: у неё нет
  // AbortSignal-параметра (это функция вызывающей стороны, обычно —
  // `requestBagPass`), и оборвать зависшую подпись кошелька этим
  // механизмом нельзя — честное, документированное ограничение, не тихая
  // недоделка.
  let currentAbort: AbortController | null = null;

  const loop = async () => {
    // Цикл последовательный: следующая итерация начинается только после
    // того, как `await` предыдущей полностью разрешился — структурно
    // невозможно, чтобы второй запрос ушёл в полёт поверх ещё не
    // завершившегося первого, сколько бы времени тот ни занял.
    while (!stopped) {
      let waitMs = intervals.activeMs; // безопасное умолчание на случай, если isActive() бросит ниже
      // `null` — тик закончился ошибкой (транспортной ИЛИ isActive()), нечего
      // отдавать потребителю; не null — успех, вот список для onBags.
      let bags: BagSummary[] | null = null;
      try {
        waitMs = opts.isActive() ? intervals.activeMs : intervals.backgroundMs;
        const pass = await opts.getPass();
        if (stopped) return;
        currentAbort = new AbortController();
        bags = await listBags(pass, opts.since, currentAbort.signal);
        currentAbort = null;
        if (stopped) return;
        consecutiveFailures = 0;
        consecutiveAuthFailures = 0;
      } catch (err) {
        if (stopped) return;
        currentAbort = null; // тик закончился (ошибкой) — контроллер больше ничему не соответствует
        consecutiveFailures++;
        // Экспоненциально от базового интервала этого тика, с потолком
        // (I3): 1-й отказ подряд — база, 2-й — ×2, 3-й — ×4, и т.д., но не
        // длиннее maxBackoffMs. Сбрасывается ЛЮБЫМ успехом (см. выше).
        waitMs = Math.min(waitMs * 2 ** (consecutiveFailures - 1), intervals.maxBackoffMs);
        // Долбят нарочно (429): отдельно ещё и не короче Retry-After
        // сервера (пол — иначе крошечный Retry-After молчаливо бьёт сильнее,
        // чем сервер просил), тем же потолком сверху.
        if (err instanceof BagRateLimitError) {
          waitMs = Math.min(Math.max(waitMs, err.retryAfterSec * 1000), intervals.maxBackoffMs);
        }
        try {
          opts.onError?.(err);
        } catch {
          // Обработчик ошибок сам не должен уметь остановить опрос — его
          // работа сообщить о сбое, а не стать НОВЫМ сбоем, который
          // выбивает while изнутри catch-блока (мелочь ревью).
        }

        if (err instanceof BagPassError) {
          consecutiveAuthFailures++;
          if (consecutiveAuthFailures >= authFailureLimit) {
            // Стоп ДО sleep — не даём человеку ещё одно окно кошелька после
            // того, как решение "хватит" уже принято.
            stopped = true;
            try {
              opts.onAuthFailed?.();
            } catch {
              // Тот же принцип, что у onError выше: свой обработчик не
              // должен ронять то, что он обслуживает.
            }
            return;
          }
        } else {
          // Отказ ДРУГОГО рода прерывает серию отказов подлинности — считаем
          // именно ПОДРЯД ИДУЩИЕ, а не сумму за всё время (C1-R1 дословно).
          consecutiveAuthFailures = 0;
        }
      }
      if (stopped) return;

      if (bags !== null) {
        try {
          opts.onBags(bags);
        } catch (err) {
          // Ошибка ЗДЕСЬ — баг колбэка потребителя (например, отрисовки), а
          // НЕ транспорта: специально ВНЕ try/catch выше, чтобы не копилась
          // как backoff и не шла в onError (иначе выглядела бы как сбой
          // сети — то самое смешение, от которого весь этот файл и
          // отстраивает две вещи разными классами ошибок). Опрос
          // останавливается и отказ всплывает по-настоящему — тихо
          // спрятанный баг в чужом колбэке хуже честного краха (мелочь
          // ревью).
          stopped = true;
          try {
            opts.onBagsError?.(err);
          } catch {
            // Тот же принцип, что у onError/onAuthFailed: свой обработчик
            // не должен ронять то, что он обслуживает — throw ниже и так
            // уже несёт исходную ошибку дальше.
          }
          throw err;
        }
      }

      await sleep(waitMs);
    }
  };

  void loop();
  return {
    stop() {
      stopped = true;
      currentAbort?.abort();
    },
  };
}
