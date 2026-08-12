import { isSignatureDeferred } from '@/lib/chatSignatureGate';

/**
 * chatTransport.ts — тупой транспорт мешков: возит байты и держит пропуск.
 *
 * ⚠️ ЕДИНСТВЕННЫЙ ИМПОРТ, и он намеренный. `chatSignatureGate.ts` сам не зависит
 * ни от чего (ни React, ни сети, ни крипты) и отвечает на один вопрос: можно ли
 * СЕЙЧАС открывать окно кошелька. Транспорт обязан это знать, потому что именно
 * он крутит цикл опроса и именно он решает, считать отказ `getPass()` неудачей
 * входа. Запрет из абзаца ниже касается содержимого мешка (`chatCrypto`),
 * цепочки (`chatChain`) и React — тут ни того, ни другого.
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
 * `requestBagPass(signMessage, address)` кэширует результат ДВУМЯ слоями —
 * память модуля плюс кладовая браузера (`localStorage`, см. «ГДЕ ЖИВЁТ
 * ПРОПУСК» ниже): пропуск переживает перезагрузку страницы и общий у всех
 * вкладок, то есть окно подписи приходит раз в срок годности пропуска, а не
 * на каждую загрузку страницы. На живом непротухшем пропуске НЕ ходит
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
 *
 * ─── КУРСОР (Задача 6 плана «Клиент чата») ──────────────────────────────
 *
 * `pollBags` ДВИГАЕТ точку отсчёта сама, за последним полученным мешком.
 * До этой задачи в каждый запрос уезжал неподвижный `opts.since`, и на
 * каждом тике приезжал весь ящик: разговор на тысячу сообщений означал
 * тысячу сводок каждые пять секунд, каждому участнику, вечно. `opts.since`
 * теперь — только НАЧАЛЬНОЕ значение.
 *
 * Курсор ВКЛЮЧАЮЩИЙ: сервер фильтрует нестрого (`uploadedAt >= since`),
 * потому что два мешка в одну миллисекунду — замеренная гонка, а не
 * теоретическая. Клиент просит с `max` включительно и сам выбрасывает то,
 * что уже отдал наверх (ключи РОВНО последней миллисекунды — множество не
 * растёт с длиной переписки). Повтор мешка стоит ничего; строгий курсор
 * стоил бы соседа по миллисекунде НАВСЕГДА.
 *
 * ⚠️ Курсор живёт в памяти вызова `pollBags` и НЕ переживает уход со
 * страницы. Это намеренно и это же — страховка: следующий заход начинает
 * без `since`, то есть за всей перепиской. Значит любой мешок, который
 * курсор проскочил бы (сервер перевёл часы назад), всё равно приедет на
 * следующем открытии чата.
 */

// Хвостовой слэш срезан — та же дисциплина, что уже применена в шести
// других местах проекта, читающих эту же переменную (lib/xmtp.ts:911,
// app/api/ipfs/upload/route.ts, app/api/relay/route.ts,
// app/api/dispute-reason/route.ts): без среза "http://host/" даёт
// "http://host//bags/pass" — двойной слэш, который не всякий сервер
// нормализует сам.
// Экспортирована (Задача 6): справочник ключей (`hooks/useChatSession.ts`)
// ходит на тот же релеер, и второй экземпляр этой же строки означал бы два
// источника истины об адресе сервера — расхождение вылезло бы не сразу и
// молча (у одного модуля хвостовой слэш срезан, у другого нет).
export const RELAYER_URL = (process.env.NEXT_PUBLIC_RELAYER_URL ?? 'http://localhost:3001').replace(/\/$/, '');

/** Заголовок пропуска. Экспортирован ради `disputeBox.ts` (ящик спора ходит
 *  ТЕМ ЖЕ пропуском, договор шапки плана 4в-2): вторая копия имени означала бы
 *  пропуск в другом заголовке и 401 на живом маршруте. */
export const BAG_PASS_HEADER = 'x-bag-pass';

/**
 * `encodeURIComponent` для одного URL-сегмента — с одним отказом вместо
 * попытки закодировать то, что кодированием не лечится (мелочь ревью,
 * найдено при попытке зачинить именно кодированием — не сработало).
 *
 * Голый `encodeURIComponent(value)` защищает от ЧУЖОГО `/`/`?` ВНУТРИ
 * значения (не даёт ему создать лишний сегмент пути или query-строку) —
 * этой части достаточно для любого значения, которое не равно буквально
 * `.` или `..`. Но сегмент, равный РОВНО `..` (или `.`), — отдельный
 * случай: WHATWG URL Standard ЯВНО трактует `%2E` как эквивалент буквальной
 * точки при разборе dot-сегментов пути ("подняться на уровень"), то есть
 * процентное экранирование точек НЕ защищает от этого в принципе — ни один
 * добросовестный разборщик URL (браузерный `fetch`, `undici` в Node,
 * промежуточный прокси) не обязан видеть разницу между `..` и `%2E%2E`.
 * Проверено вживую: `new URL('.../bags/%2E%2E/x').pathname` совпадает с
 * `new URL('.../bags/../x').pathname` — оба теряют `/bags/` из пути.
 * Единственная рабочая защита — не пускать такой сегмент в путь ВООБЩЕ.
 */
/** Экспортирована ради `disputeBox.ts`: у ящика спора в пути ДВА чужих
 *  сегмента (агримент и имя мешка), и защита от `..` обязана быть той же
 *  самой — разбор выше объясняет, почему `%2E%2E` её не заменяет. */
export function encodePathSegment(segment: string): string {
  if (segment === '.' || segment === '..') {
    throw new BagTransportError(`Refusing to build a request with a "${segment}" path segment`);
  }
  return encodeURIComponent(segment);
}

export interface BagSummary {
  key: string;
  sender: `0x${string}`;
  size: number;
  uploadedAt: number;
}

/**
 * Задача 1 плана «Клиент чата» (docs/superpowers/plans/2026-08-06-chat-
 * client.md): взгляд отправителя на СОБСТВЕННЫЕ мешки — только те, что
 * отправил владелец пропуска. `fetched` — булево ("дошло ли до устройства
 * собеседника"), НЕ отметка времени: точное время забора — метаданные
 * собеседника, отправителю знать незачем (relayer/app.js, GET /bags).
 */
export interface SentBagSummary {
  key: string;
  recipient: `0x${string}`;
  uploadedAt: number;
  fetched: boolean;
}

/**
 * Собеседник, с которым есть переписка (хоть один мешок в любую сторону —
 * посторонний по публичному адресу сюда не попадает).
 *
 * ⚠️ `lastActivityWithMeAt` — НЕ «онлайн-статус». Переименовано 6 августа
 * (ревью Задачи 1): поле называлось `lastSeenAt`, а спека обещала «когда
 * адрес последний раз обращался к серверу» — реализовано и осталось иначе:
 * «когда собеседник последний раз тронул что-то МОЁ» (забрал мой мешок или
 * прислал свой). Это не то же самое, что присутствие: человек может час
 * сидеть в открытом чате, ничего из вашего не трогать — поле честно покажет
 * «час назад», а не «прямо сейчас». Округлено сервером до минуты. `null` —
 * переписка есть, но ни одного такого сигнала ещё не было (никто ничего не
 * забирал и не присылал заново).
 */
export interface PeerSummary {
  address: `0x${string}`;
  lastActivityWithMeAt: number | null;
}

/** Форма ответа `GET /bags` целиком — см. `listBags()` ниже. */
export interface ListBagsResult {
  inbox: BagSummary[];
  sent: SentBagSummary[];
  peers: PeerSummary[];
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

/** Быстрый слой: память модуля. Медленный — кладовая браузера, см. ниже. */
const _passCache = new Map<string, { pass: string; expiresAt: number }>();

/**
 * ─── ГДЕ ЖИВЁТ ПРОПУСК И ПОЧЕМУ ИМЕННО ТАМ ───────────────────────────────
 *
 * Пропуск переживает перезагрузку страницы и виден всем вкладкам одного
 * происхождения. До этой правки он жил ТОЛЬКО в памяти модуля — и докстринг
 * честно это описывал, а вот обещание уровнем выше («окно подписи максимум
 * дважды в сутки») было неправдой: замерено независимой проверкой (В-6) —
 * одно окно на КАЖДУЮ загрузку страницы и на КАЖДУЮ вкладку. Двенадцать
 * часов — срок годности самого пропуска, а не кэша.
 *
 * ⚠️ ЧТО ИМЕННО МЫ КЛАДЁМ НА ДИСК И ЧЕМ ЭТО РИСКУЕТ. Пропуск — предъявительский
 * токен: кто его получил, тот 12 часов читает и пишет мешки этого адреса.
 * Скрипт, дорвавшийся до `localStorage` нашего происхождения, его прочтёт.
 *
 * Почему это всё равно правильный размен, и это НЕ «наверное, обойдётся»:
 * закрытый ключ переписки уже лежит на этом же устройстве, в `IndexedDB`
 * того же происхождения (`chatSession.ts`), и он строго ценнее — им читается
 * ВСЯ история, навсегда, а пропуском — мешки, которые и так зашифрованы этим
 * ключом, и только 12 часов. Нападающий, добравшийся до хранилищ браузера,
 * забирает ключ и не нуждается в пропуске вовсе. То есть новой двери мы не
 * открываем; мы кладём рядом с сейфом ключ от подъезда.
 *
 * Чего мы НЕ кладём сюда никогда: ни самого ключа переписки, ни кода
 * восстановления, ни расшифрованного содержимого.
 *
 * Кладовая может отсутствовать (серверный рендер) или отказать (приватный
 * режим, кончившаяся квота) — тогда всё работает ровно как раньше, на памяти
 * модуля. Отказ кладовой не должен стоить человеку отправки.
 */
const PASS_STORAGE_PREFIX = 'hexseal_bagpass_';

function passStorage(): Storage | null {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    return s && typeof s.getItem === 'function' ? s : null;
  } catch {
    // Доступ к `localStorage` умеет БРОСАТЬ (сторонний контекст с
    // запрещёнными куками), а не просто отсутствовать.
    return null;
  }
}

/* ─────────────── адресный бюджет чтения, ОБЩИЙ У ВКЛАДОК ──────────────── */

/**
 * Сколько чтений склада разрешаем себе за минуту на ОДИН АДРЕС.
 *
 * ⚠️ ЧИСЛО ВЫВЕДЕНО ИЗ ЧУЖОГО, БОЕВОГО, и оно не «наше усмотрение». Склад
 * даёт адресу `BAG_READ_RATE_MAX = 120` чтений в минуту (`relayer/app.js`), и
 * бюджет ОБЩИЙ у перечисления (`GET /bags`) и скачивания (`GET /bags/:key`).
 * Сто оставляет запас на расхождение часов между вкладками и на то, что
 * сервер считает своё окно от своего же момента, а не от нашего.
 *
 * ⚠️ ПОЧЕМУ СЧЁТ ЗДЕСЬ, А НЕ В ХУКАХ. Замерено: открытая переписка отмеряла
 * себе 80 скачиваний, список переписок — 24 превью, и КАЖДАЯ ВКЛАДКА считала
 * это заново. Две вкладки одного человека (чат открыт и рядом сделка — обычное
 * дело) просили вдвое больше, чем склад разрешает: 200 попыток, 80 отбитых
 * сервером, отступление `pollBags` до пяти минут. Чат заморожен у того, кто не
 * сделал ничего.
 *
 * Счётчик в хуке — это счётчик на хук на вкладку, то есть заведомо не тот,
 * который считает сервер. Общая память у вкладок одного источника ровно одна —
 * `localStorage`; согласованность чтения-записи даёт `navigator.locks`.
 */
export const BAG_READ_BUDGET_PER_MIN = 100;

const READ_WINDOW_MS = 60_000;
const READS_STORAGE_PREFIX = 'hexseal_bagreads_';

/**
 * Отказ СВОЕГО бюджета, а не сервера.
 *
 * Отдельный род намеренно: это не поломка и не «сервер сказал нет», это «мы
 * сами решили подождать». Вызывающий, принявший его за сетевой отказ, ушёл бы
 * в отступление — то есть заменил бы одну заморозку другой.
 */
export class BagBudgetError extends BagTransportError {
  constructor(message = 'Local read budget exhausted') {
    super(message, 'local_read_budget');
    this.name = 'BagBudgetError';
  }
}

/**
 * Отметки чтений ЭТОЙ вкладки, в памяти.
 *
 * ⚠️ ДВА СЛОЯ, А НЕ ОДИН, И ВТОРОЙ ПОЯВИЛСЯ ПОСЛЕ СОБСТВЕННОГО ПРОМАХА.
 * Первая версия считала только через `localStorage` — и на устройстве БЕЗ него
 * (приватный режим, сторонний контекст с запрещёнными куками) не считала
 * НИЧЕГО: замер К-1 тут же показал 300 скачиваний за один тик вместо ста, то
 * есть правка вернула ровно тот дефект, который до неё закрывал счётчик в
 * хуке. Своя починка оказалась хуже того, что чинила.
 *
 * Поэтому слоя два, и они про разное:
 *  - память вкладки — работает ВСЕГДА, держит потолок для одной вкладки;
 *  - общая память вкладок — согласует НЕСКОЛЬКО вкладок одного адреса.
 * Пропустить чтение должны оба; отсутствие второго не отменяет первый.
 */
const _readStamps = new Map<string, number[]>();

function takeFromMemory(addr: string, nowMs: number): boolean {
  const cutoff = nowMs - READ_WINDOW_MS;
  const stamps = (_readStamps.get(addr) ?? []).filter(t => t > cutoff && t <= nowMs);
  if (stamps.length >= BAG_READ_BUDGET_PER_MIN) {
    _readStamps.set(addr, stamps);
    return false;
  }
  stamps.push(nowMs);
  _readStamps.set(addr, stamps);
  return true;
}

/** Отметки чтений последней минуты, как они лежат в общей памяти вкладок. */
function readStamps(s: Storage, key: string, nowMs: number): number[] {
  let raw: string | null;
  try { raw = s.getItem(key); } catch { return []; }
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const cutoff = nowMs - READ_WINDOW_MS;
  // Отметки ИЗ БУДУЩЕГО отбрасываются вместе со старыми: часы на устройстве
  // умеют прыгать вперёд, и одна такая отметка иначе держала бы бюджет
  // занятым до тех пор, пока время её не догонит.
  return parsed.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > cutoff && n <= nowMs);
}

/**
 * Занять одно чтение из адресного бюджета. `false` — бюджет исчерпан.
 *
 * НЕ запирает, когда считать нечем: нет `localStorage` (приватный режим,
 * сторонний контекст с запрещёнными куками) или запись не проходит. Отказать
 * всем чтениям там, где чат работал, значило бы выключить его ради счётчика.
 */
async function reserveBagRead(addr: string, nowMs = Date.now()): Promise<boolean> {
  // Слой, который работает всегда. Проверяется ПЕРВЫМ: если своя же вкладка
  // уже выбрала минуту, ходить за замком и в хранилище незачем.
  if (!takeFromMemory(addr, nowMs)) return false;
  const s = passStorage();
  if (!s) return true;
  const key = READS_STORAGE_PREFIX + addr;
  const take = (): boolean => {
    const stamps = readStamps(s, key, nowMs);
    if (stamps.length >= BAG_READ_BUDGET_PER_MIN) return false;
    stamps.push(nowMs);
    try { s.setItem(key, JSON.stringify(stamps)); } catch { return true; }
    return true;
  };
  const locks = (globalThis as { navigator?: Navigator }).navigator?.locks;
  if (!locks) return take();
  // ⚠️ Замок обязателен: без него две вкладки читают одно и то же значение,
  // каждая прибавляет единицу и записывает — то есть два чтения списываются
  // как одно, и весь счёт врёт ровно в ту сторону, ради которой заведён.
  let allowed = true;
  try {
    await locks.request(key, () => { allowed = take(); });
  } catch {
    allowed = take(); // замок недоступен — считаем без него, это лучше, чем не считать
  }
  return allowed;
}

/** Только тесты: начать минуту заново. */
export function _resetReadBudgetForTest(): void {
  _readStamps.clear();
  const s = passStorage();
  if (!s) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(READS_STORAGE_PREFIX)) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  } catch { /* нечего чистить */ }
}

/**
 * Занять чтение по пропуску.
 *
 * ⚠️ ЧЕГО ЭТОТ СЧЁТ НЕ ДЕЛАЕТ, СКАЗАНО ПРЯМО. Пропуск, из которого адрес не
 * достаётся, НЕ СЧИТАЕТСЯ: считать некому и не за кого. На боевом пути такого
 * пропуска не бывает — его выдаёт `requestBagPass` в форме `v1.<тело>.<подпись>`
 * (заперто `chatReadBudget.test.ts` на пропуске настоящей формы), — но если
 * форма когда-нибудь сменится, счёт тихо перестанет работать, и заметит это
 * только сервер своим `429`.
 *
 * Считать негодный пропуск «в общую корзину» пробовалось и отвергнуто: это
 * душит одного человека за чужие чтения, а замеры движка (которые гоняют
 * опрос в сотни раз быстрее боевого) начинают упираться в минутный бюджет и
 * мерить не то, что обещают. Потолок ПРОТИВ НАГРУЗКИ стоит отдельно и не
 * зависит ни от пропуска, ни от хранилища — см. `MAX_BAG_DOWNLOADS_PER_TICK`
 * в `usePairChat.ts`.
 */
/** ⚠️ Экспортирована ради `disputeBox.ts`, и это несущее: бюджет чтения —
 *  АДРЕСНЫЙ и ОБЩИЙ на все роды чтения, как на складе. Свой счёт у ящика
 *  спора означал бы два независимых счётчика против одного серверного, то
 *  есть бюджет перестал бы значить что-либо ровно там, где он и заводился
 *  (замер потопа: ящик арбитра кончается на 99-м мешке из 122). */
export async function reserveReadForPass(pass: string): Promise<void> {
  const addr = parseBagPassAddress(pass);
  if (!addr) return;
  if (!(await reserveBagRead(addr))) throw new BagBudgetError();
}

function readStoredPass(addr: string): { pass: string; expiresAt: number } | null {
  const s = passStorage();
  if (!s) return null;
  let raw: string | null;
  try { raw = s.getItem(PASS_STORAGE_PREFIX + addr); } catch { return null; }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // Данные с диска доверия не заслуживают ровно как данные из сети: их мог
    // записать предыдущий выпуск, их мог испортить сбой.
    if (isBagPassBody(parsed)) return { pass: parsed.pass, expiresAt: parsed.expiresAt };
  } catch { /* мусор в кладовой — считаем, что записи нет */ }
  return null;
}

function writeStoredPass(addr: string, value: { pass: string; expiresAt: number }): void {
  const s = passStorage();
  if (!s) return;
  try { s.setItem(PASS_STORAGE_PREFIX + addr, JSON.stringify(value)); } catch { /* квота/приватный режим */ }
}

function deleteStoredPass(addr: string): void {
  const s = passStorage();
  if (!s) return;
  try { s.removeItem(PASS_STORAGE_PREFIX + addr); } catch { /* нечего убирать */ }
}

/**
 * Выбрасывает кэш конкретного адреса. Публичная — пригодится и потребителю
 * (например, при явном разлогине/смене аккаунта), но в первую очередь её
 * зовут ИЗНУТРИ `listBags`/`putBag`/`fetchBag` на каждый `401` (C1, отчёт
 * задачи): только транспорт в момент 401 достоверно знает, что пропуск
 * мёртв, и не должен ждать, пока кто-то снаружи додумается его выбросить.
 */
export function forgetBagPass(address: string): void {
  const addr = address.toLowerCase();
  _passCache.delete(addr);
  // ⚠️ И из кладовой ТОЖЕ. Забыть только память значило бы, что мёртвый
  // пропуск переживает перезагрузку — та же дыра C1 («транспорт отдаёт тот
  // же мёртвый пропуск навсегда»), только теперь вечная.
  deleteStoredPass(addr);
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
  // Сравнение — с тем, что реально в силе СЕЙЧАС (память, а если её нет —
  // кладовая): запоздавший 401 по уже вытесненному токену не должен убивать
  // свежий пропуск того же адреса.
  const current = _passCache.get(addr) ?? readStoredPass(addr);
  if (current?.pass === pass) {
    _passCache.delete(addr);
    deleteStoredPass(addr);
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
/** Экспортирована ради `disputeBox.ts`: 401 обязан выбрасывать протухший
 *  пропуск из кэша на ЛЮБОМ маршруте, иначе человек получает отказ до конца
 *  жизни вкладки. */
export async function throwForFailedResponse(res: Response, fallback: string, passToForget?: string): Promise<never> {
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
  // Память модуля — первой (дешевле), кладовая — вторым слоем: она и есть то,
  // что переживает перезагрузку страницы и роднит две вкладки.
  const entry = _passCache.get(addr) ?? readStoredPass(addr);
  if (!entry) return null;
  if (entry.expiresAt - PASS_EXPIRY_SKEW_SEC <= nowSec) {
    // Протух — убираем из ОБОИХ слоёв, иначе следующий заход снова его
    // прочитает с диска и снова отбросит, каждый раз.
    _passCache.delete(addr);
    deleteStoredPass(addr);
    return null;
  }
  _passCache.set(addr, entry);
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
    writeStoredPass(addr, fresh);
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

/**
 * Пропуск, КОТОРЫЙ УЖЕ ЕСТЬ, — без единого окна кошелька.
 *
 * ⚠️ ЗАЧЕМ ОТДЕЛЬНОЕ ИМЯ. `requestBagPass` на холодном кэше подписывает
 * фразу, то есть будит кошелёк. Опрос описи ящика («забрал ли арбитр»,
 * 4в-2, Задача 6) идёт по такту, и требовать за него подпись каждые
 * тридцать секунд нельзя. Здесь читается ровно тот же двухслойный кэш
 * (память модуля + кладовая), что и внутри `requestBagPass`, с той же
 * проверкой истечения: `null` означает «спросить придётся у человека», и
 * тогда опрос просто не идёт.
 */
export function peekBagPass(address: `0x${string}`): string | null {
  return cachedPass(address.toLowerCase(), Math.floor(Date.now() / 1000))?.pass ?? null;
}

/** Только для тестов: забыть весь кэш пропусков и записи "в полёте" между
 *  кейсами — иначе повисший (например, никогда не разрешённый в тесте)
 *  дедуп-промис одного теста мог бы прилипнуть к следующему. */
export function _resetBagPassCacheForTest(): void {
  _passCache.clear();
  _inFlight.clear();
  // Кладовую тоже — иначе пропуск одного теста прилипал бы к следующему
  // ровно так же, как раньше прилипал повисший дедуп-промис.
  const s = passStorage();
  if (!s) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(PASS_STORAGE_PREFIX)) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  } catch { /* кладовой нет или она отказала — чистить нечего */ }
}

/* ────────────────────────────── putBag ──────────────────────────────── */

function isPutBagBody(x: unknown): x is { key: string } {
  return !!x && typeof x === 'object' && typeof (x as Record<string, unknown>).key === 'string' &&
    (x as { key: string }).key.length > 0;
}

/**
 * `signal` — необязательный, четвёртый параметр (Задача 6 плана «Клиент
 * чата», место 2 из четырёх: отмена касалась только списка). Обратно
 * совместим: ни один существующий трёхаргументный вызов не меняет поведения.
 *
 * ⚠️ ЧЕСТНО О ТОМ, КОМУ ЭТО НУЖНО. Хук чата этот сигнал на отправке
 * НАМЕРЕННО не использует: `chatConversation.sendMessage` резервирует номер
 * звена на диске ДО похода на склад, и оборванная посреди отправка оставляет
 * сгоревший номер — то есть дыру в нумерации, которую собеседник видит как
 * утаивание. Обрывать её из-за перехода на другую страницу значило бы менять
 * «сообщение ушло» на «сообщение не ушло и в переписке теперь дыра» ради
 * экономии одного запроса. Параметр существует для вызывающих, у которых
 * такой цены нет (загрузка, которую человек отменил кнопкой).
 */
export async function putBag(
  pass: string,
  recipient: `0x${string}`,
  sealed: Uint8Array,
  signal?: AbortSignal,
): Promise<{ key: string }> {
  // Мелочь ревью: recipient уезжал в URL БЕЗ кодирования — сервер проверяет
  // его форму сам (ETH_ADDR_RE), но кодировать надо и на нашей стороне
  // (defense in depth, не расчёт на единственный слой защиты).
  const res = await fetch(`${RELAYER_URL}/bags/${encodePathSegment(recipient.toLowerCase())}`, {
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
    signal,
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

/** Тот же уровень паранойи, что у `isBagSummary` выше — сервер обещает
 *  булево `fetched` (не отметку времени), но клиент не обязан верить
 *  обещанию молча: `typeof o.fetched === 'boolean'`, а не «поле есть». */
function isSentBagSummary(x: unknown): x is SentBagSummary {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.key === 'string' && o.key.length > 0 &&
    typeof o.recipient === 'string' && SENDER_RE.test(o.recipient) &&
    typeof o.uploadedAt === 'number' && Number.isFinite(o.uploadedAt) &&
    typeof o.fetched === 'boolean'
  );
}

/** `lastActivityWithMeAt` — `null` («неизвестно») ИЛИ конечное число, ничего третьего. */
function isPeerSummary(x: unknown): x is PeerSummary {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.address !== 'string' || !SENDER_RE.test(o.address)) return false;
  return o.lastActivityWithMeAt === null ||
    (typeof o.lastActivityWithMeAt === 'number' && Number.isFinite(o.lastActivityWithMeAt));
}

/**
 * `signal` — необязательный, третий параметр (не часть исходного интерфейса
 * задачи `listBags(pass, since?)`, но обратно совместимый: ни один
 * существующий двухаргументный вызов не меняет поведения). Даёт
 * `pollBags` возможность реально ПРЕРВАТЬ запрос в полёте на `stop()`
 * (мелочь ревью), а не просто дождаться и отбросить результат.
 *
 * Задача 1 (chat-client): `GET /bags` теперь отдаёт объект
 * `{inbox, sent, peers}`, не голый массив (решение координатора при сверке
 * плана — тот же самый опрос раз в 5с несёт и то, что нужно отправителю про
 * исходящие, и список собеседников, без отдельного запроса). Старая форма
 * (голый массив — доездоровившийся сервер, версия до этой задачи) отвергается
 * так же громко, как и любой другой мусор: рассинхрон версий обязан быть
 * виден, а не молча прочитан как «пустой список».
 */
export async function listBags(pass: string, since?: number, signal?: AbortSignal): Promise<ListBagsResult> {
  // Адресный бюджет, ОБЩИЙ у вкладок и у обоих родов чтения — как на складе.
  // Стоит ЗДЕСЬ, а не у вызывающего: через эти две функции проходит каждое
  // чтение любой вкладки, и обойти их нечем.
  await reserveReadForPass(pass);
  const url = new URL(`${RELAYER_URL}/bags`);
  if (since !== undefined) url.searchParams.set('since', String(since));

  const res = await fetch(url.toString(), { headers: { [BAG_PASS_HEADER]: pass }, signal });
  if (!res.ok) await throwForFailedResponse(res, 'Failed to list bags', pass);

  const body: unknown = await res.json();
  if (!body || typeof body !== 'object') {
    throw new BagTransportError('Malformed response from GET /bags: not an object');
  }
  const { inbox, sent, peers } = body as Record<string, unknown>;

  if (!Array.isArray(inbox)) throw new BagTransportError('Malformed response from GET /bags: inbox is not an array');
  for (const item of inbox) {
    if (!isBagSummary(item)) throw new BagTransportError('Malformed bag entry in GET /bags response');
  }

  if (!Array.isArray(sent)) throw new BagTransportError('Malformed response from GET /bags: sent is not an array');
  for (const item of sent) {
    if (!isSentBagSummary(item)) throw new BagTransportError('Malformed sent entry in GET /bags response');
  }

  if (!Array.isArray(peers)) throw new BagTransportError('Malformed response from GET /bags: peers is not an array');
  for (const item of peers) {
    if (!isPeerSummary(item)) throw new BagTransportError('Malformed peer entry in GET /bags response');
  }

  return { inbox: inbox as BagSummary[], sent: sent as SentBagSummary[], peers: peers as PeerSummary[] };
}

/* ────────────────────────────── fetchBag ─────────────────────────────── */

/**
 * `signal` — необязательный, третий параметр (Задача 6, место 2 из четырёх).
 * В отличие от `putBag`, здесь хук его РЕАЛЬНО использует: скачивание ничего
 * не резервирует и не меняет состояния ни у нас, ни у собеседника —
 * оборванное на середине, оно просто не состоялось, и следующий тик заберёт
 * тот же мешок заново (сервер отмечает «забрали» только на успешно
 * дочитанном ответе, relayer/app.js `res.on('finish')`).
 */
export async function fetchBag(pass: string, key: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  // Тот же адресный бюджет, что у перечисления, — см. `listBags`.
  await reserveReadForPass(pass);
  // Мелочь ревью: key уезжал в URL БЕЗ кодирования — сервер сам проверяет
  // его форму, но кодировать надо и на нашей стороне. Ключ — ВСЕГДА два
  // сегмента (recipient/filename, см. bagKeyFor() на сервере), поэтому
  // кодируем по отдельности вокруг ПЕРВОГО "/" — иначе "/" внутри второго
  // сегмента открыл бы дополнительный путь обхода уже после кодирования.
  const slashIdx = key.indexOf('/');
  const urlKey = slashIdx === -1
    ? encodePathSegment(key)
    : `${encodePathSegment(key.slice(0, slashIdx))}/${encodePathSegment(key.slice(slashIdx + 1))}`;
  const res = await fetch(`${RELAYER_URL}/bags/${urlKey}`, { headers: { [BAG_PASS_HEADER]: pass }, signal });

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

/** Сколько подряд идущих НЕУДАЧ ВХОДА терпеть (любой отказ `getPass()`, каким
 *  бы ни был — включая отказ человека подписать, — плюс `BagPassError` от
 *  `listBags`; см. докстринг `getPass` в `BagPollOptions` ниже), прежде чем
 *  остановиться и позвать `onAuthFailed` (C1-R1/C1-R2, отчёт задачи). Три —
 *  по прямому решению координатора: достаточно, чтобы пережить единичный
 *  транзиентный сбой (сервер моргнул между minted-пропуском и проверкой), и
 *  достаточно мало, чтобы не превратиться в те же бесконечные окна
 *  кошелька, которые весь этот механизм и должен прекращать. */
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
   * безопасным СВОИМИ средствами: считает подряд идущие НЕУДАЧИ ВХОДА —
   * любой отказ самого `getPass()` (отказ человека подписать, обрыв сети
   * внутри неё, её собственный `BagPassError`) плюс `BagPassError` от
   * `listBags` (пропуск получен, но сервер его не принял) — и
   * останавливается на `authFailureLimit`, зовя `onAuthFailed` (C1-R1/
   * C1-R2, отчёт задачи: первая версия считала ТОЛЬКО `BagPassError`, и
   * отказ человека подписывать — чужое исключение, не наше — обнулял
   * счётчик, так и не давая пределу сработать). Отказ `listBags` ДРУГОГО
   * рода (сеть, `500`, `429`, мусорный ответ) на этот счётчик не влияет —
   * у него свой отдельный, намеренно безграничный откат (I3/I4). Собственный
   * ручной цикл ретраев ВОКРУГ `pollBags` поверх этого — снова тот самый
   * запрет из шапки, теперь без единственной защиты, которая у `pollBags`
   * для него и есть.
   */
  getPass: () => string | Promise<string>;
  /**
   * НАЧАЛЬНАЯ точка отсчёта, и только она. Дальше курсор ведёт себя сам —
   * см. «КУРСОР» в шапке модуля. До Задачи 6 это значение уезжало в КАЖДЫЙ
   * запрос неизменным, то есть на каждом тике приезжал весь ящик.
   *
   * `undefined` (обычный случай для хука) — первый тик идёт без `since`,
   * то есть за всей перепиской: сообщения, пришедшие до открытия вкладки,
   * обязаны показаться, а не «начаться с этого момента».
   */
  since?: number;
  /** true — чат/вкладка активны (используется `activeMs`), false — фон. */
  isActive: () => boolean;
  /**
   * Успешный тик. Отдаётся ВЕСЬ ответ склада, а не одна треть: `inbox` —
   * только НОВОЕ с прошлого тика (курсор плюс дедуп на границе), `sent` и
   * `peers` — как их отдал сервер.
   *
   * ⚠️ Форма сверена с настоящим потребителем (Задача 6, место 3 из четырёх
   * — «`BagPollOptions` за три раунда обросла тремя обработчиками, свести к
   * тому, что хуку нужно»). Результат сверки, по полю:
   *   - `onBags` — раньше отдавала голый `BagSummary[]`, а `sent`/`peers` из
   *     ТОГО ЖЕ ответа молча выбрасывала. Хуку нужны все три: `inbox` —
   *     сообщения, `sent[].fetched` — галочка «дошло», `peers` — список
   *     переписок. Второго запроса за ними не существует, и заводить его
   *     ради уже полученных данных было бы платой на ровном месте.
   *   - `onError` — нужен: «нет сети» в интерфейсе.
   *   - `onBagsError` — нужен: опрос ПОСЛЕ него останавливается, и человеку
   *     надо сказать «обновите страницу». Отдельно от `onError` намеренно,
   *     это другой класс (баг отрисовки, не транспорта).
   *   - `onAuthFailed` — нужен: «войдите заново», опрос остановлен.
   *   - `intervals` — нужен: активный чат против фона.
   *   - `authFailureLimit`, `sleep` — только тесты; хук их не передаёт и не
   *     должен, умолчания и есть боевое поведение.
   * Ни одно поле не осталось «на всякий случай»: каждое названо здесь с
   * именем потребителя.
   */
  onBags: (result: ListBagsResult) => void;
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
   * Зовётся РОВНО один раз, когда подряд идущих НЕУДАЧ ВХОДА набралось
   * `authFailureLimit` — опрос ОСТАНАВЛИВАЕТСЯ (см. докстринг `getPass`
   * выше и C1-R1/C1-R2 в отчёте задачи). Дать потребителю сигнал «пропуск
   * не восстанавливается, войдите заново» вместо того, чтобы молча
   * продолжать спрашивать у человека подписи, которые не могут сработать.
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
  // C1-R1/C1-R2 (ревью-координатор, КРИТИЧЕСКАЯ находка, дважды): без
  // предела `getPass`, подключённый ровно так, как предписывает её же
  // докстринг, спрашивала бы у кошелька новую подпись на КАЖДЫЙ тик
  // бесконечно, если сервер отвечает 401 систематически (расхождение
  // версий, испорченный секрет, съехавшие часы) — C1 (раунд 2) чинил
  // ЗАСТРЕВАНИЕ на мёртвом пропуске, но открыл противоположную дыру:
  // пропуск больше не застревает, но и ничто не мешает переподписывать его
  // бесконечно.
  //
  // C1-R1 (первая попытка) считала ТОЛЬКО `BagPassError` — и петля
  // вернулась через соседнюю дверь: человек может ОТКАЗАТЬСЯ подписывать
  // (кошелёк бросает СВОЁ исключение, не `BagPassError`), и это трактовалось
  // как "отказ другого рода", ОБНУЛЯЯ счётчик — отказ подписывать раз за
  // разом никогда не достигал предела, отступление упиралось в потолок
  // (5 минут) и застревало там: 12 окон кошелька в час, бесконечно.
  // Тот же класс мышления по частям, что и остальные три находки этой
  // задачи ("выброс пропуска на двух маршрутах из трёх" и т.п.) — свойство
  // закрывалось на одном пути и оставалось дырой на соседнем.
  //
  // C1-R2 (эта правка): считается ЛЮБАЯ неудача ПОЛУЧЕНИЯ РАБОЧЕГО пропуска
  // — отказ человека подписать, обрыв сети ВНУТРИ `getPass`, малформенный
  // ответ `POST /bags/pass`, `BagPassError` от `listBags` (пропуск получен,
  // но сервер его не принял — то же самое "вход не работает", просто узнали
  // на шаг позже) — что угодно из этого списка. НЕ считается: `listBags`
  // упала по СЕТИ, `500`, `429` или мусорным ответом — это отказал ЗАПРОС
  // СПИСКА, а не сам вход, и для него уже есть свой бесконечный
  // экспоненциальный откат с потолком (I4/I3) — умышленно НЕ ограниченный
  // предельным числом попыток, замер того раунда явно этого и хотел. Свести
  // оба под один счётчик проверено вживую: тесты I4/T1 (десятки подряд
  // сетевых отказов, откат продолжается) ломаются, если это сделать —
  // значит счётчики обязаны остаться разными, просто auth-счётчик больше
  // не завязан на ОДИН класс ошибки.
  //
  // Сбрасывается ТОЛЬКО успехом (полным — дошли до реального списка мешков);
  // НЕ считающийся отказ (сеть/500/429/мусор на `listBags`) счётчик не
  // трогает вовсе — ни не увеличивает, ни не обнуляет, серия просто ждёт
  // следующего события, которое действительно о ней говорит.
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

  // ─── КУРСОР (Задача 6, место 1 из четырёх) ───────────────────────────────
  //
  // Раньше в каждый запрос уезжал неподвижный `opts.since`, поэтому КАЖДЫЙ
  // тик приносил весь ящик заново. При активной переписке это и есть модель
  // нагрузки: разговор на тысячу сообщений — тысяча сводок каждые пять
  // секунд, каждому участнику, вечно.
  //
  // ⚠️ КУРСОР ВКЛЮЧАЮЩИЙ, А НЕ ИСКЛЮЧАЮЩИЙ, и это не описка. Сервер
  // фильтрует НЕСТРОГО (`uploadedAt >= since`, relayer/app.js, И-3) именно
  // потому, что два мешка в одну миллисекунду — настоящая гонка, замеренная
  // вживую. Клиент, решивший «попрошу с max+1», потерял бы соседа по
  // миллисекунде НАВСЕГДА: его `uploadedAt` уже никогда не станет больше
  // того `since`, который клиент будет слать с этого момента. Поэтому
  // просим с `max` включительно и сами выбрасываем то, что уже отдали, —
  // повтор мешка это ничего, потеря мешка это молча пропавшее сообщение.
  //
  // Помнить достаточно ключи РОВНО последней миллисекунды: всё, что старше,
  // сервер уже не пришлёт. Множество не растёт с длиной переписки — иначе
  // разговор на тысячу сообщений держал бы тысячу ключей до конца сеанса.
  let cursor: number | undefined = opts.since;
  let boundaryKeys = new Set<string>();

  /** Что из этого ответа ДЕЙСТВИТЕЛЬНО новое, и куда после этого встаёт
   *  курсор. Чистая функция состояния — вся арифметика границы здесь, а не
   *  размазана по циклу. */
  const takeFresh = (inbox: BagSummary[]): BagSummary[] => {
    const fresh = inbox.filter(b => !boundaryKeys.has(b.key));
    // Тихий тик курсор НЕ двигает и НЕ откатывает: `Math.max()` на пустом
    // массиве это `-Infinity`, и присвоив его, мы бы просили весь ящик
    // заново после каждой паузы в разговоре.
    if (inbox.length === 0) return fresh;
    let maxUploadedAt = inbox[0].uploadedAt;
    for (const b of inbox) if (b.uploadedAt > maxUploadedAt) maxUploadedAt = b.uploadedAt;
    if (cursor === undefined || maxUploadedAt > cursor) {
      cursor = maxUploadedAt;
      boundaryKeys = new Set(inbox.filter(b => b.uploadedAt === maxUploadedAt).map(b => b.key));
    } else if (maxUploadedAt === cursor) {
      // Та же миллисекунда, что и в прошлый раз — граница ПОПОЛНЯЕТСЯ.
      //
      // ⚠️ Честно: под нынешним сервером замена дала бы то же самое — он
      // отдаёт ВСЁ, что `>= since`, значит в этом ответе уже лежат и прежние
      // жильцы границы. Отдельным тестом это не заперто, потому что запирать
      // нечего: разницы на настоящем сервере нет. Слияние выбрано на случай,
      // если выдача когда-нибудь станет постраничной — лишний ключ в памяти
      // стоит ничего, потерянный жилец границы стоит пропавшего сообщения.
      for (const b of inbox) if (b.uploadedAt === maxUploadedAt) boundaryKeys.add(b.key);
    }
    return fresh;
  };

  const loop = async () => {
    // Цикл последовательный: следующая итерация начинается только после
    // того, как `await` предыдущей полностью разрешился — структурно
    // невозможно, чтобы второй запрос ушёл в полёт поверх ещё не
    // завершившегося первого, сколько бы времени тот ни занял.
    while (!stopped) {
      let waitMs = intervals.activeMs; // безопасное умолчание на случай, если isActive() бросит ниже
      // `null` — тик закончился ошибкой (транспортной ИЛИ isActive()), нечего
      // отдавать потребителю; не null — успех, вот список для onBags.
      let tick: ListBagsResult | null = null;
      // Где именно случился отказ — решает, считается ли он за отказ ВХОДА
      // (C1-R2, см. докстринг consecutiveAuthFailures выше): любой отказ
      // самого `getPass()`, либо `BagPassError` от `listBags` (пропуск
      // получен, но не принят). Отказ `listBags` любого другого рода —
      // это отказ ЗАПРОСА СПИСКА, не входа, и на этот счётчик не влияет.
      let stage: 'isActive' | 'getPass' | 'listBags' = 'isActive';
      try {
        waitMs = opts.isActive() ? intervals.activeMs : intervals.backgroundMs;
        stage = 'getPass';
        const pass = await opts.getPass();
        if (stopped) return;
        stage = 'listBags';
        currentAbort = new AbortController();
        // Задача 6 (chat-client): в запрос уезжает ДВИЖУЩИЙСЯ курсор, а не
        // неподвижный `opts.since`; наверх уходит весь ответ, а не одна
        // треть (`sent`/`peers` до этой задачи молча выбрасывались здесь).
        const result = await listBags(pass, cursor, currentAbort.signal);
        currentAbort = null;
        if (stopped) return;
        // Курсор двигается ТОЛЬКО после `stopped`-проверки: тик, результат
        // которого никому не отдадут, не имеет права съесть мешки — иначе
        // остановка посреди ответа означала бы, что при следующем запуске
        // опроса эти сообщения уже «пройдены».
        tick = { inbox: takeFresh(result.inbox), sent: result.sent, peers: result.peers };
        consecutiveFailures = 0;
        consecutiveAuthFailures = 0;
      } catch (err) {
        if (stopped) return;
        currentAbort = null; // тик закончился (ошибкой) — контроллер больше ничему не соответствует
        // ⚠️ СВОЙ БЮДЖЕТ — НЕ ОТКАЗ. Мы сами решили подождать: ни счётчик
        // неудач, ни счётчик неудач ВХОДА это трогать не должны, и отступать
        // не за чем. Иначе бюджет, заведённый ПРОТИВ заморозки чата, сам бы её
        // и устраивал — своя починка хуже дефекта, ровно тот случай.
        if (err instanceof BagBudgetError) {
          await sleep(waitMs);
          continue;
        }
        // ⚠️ ЖДЁМ НАЖАТИЯ — ЭТО ТОЖЕ НАШЕ СОБСТВЕННОЕ РЕШЕНИЕ, не отказ склада.
        //
        // Отсечка подписи (`chatSignatureGate.ts`) отказывает `getPass()`, когда
        // страница скрыта или когда кошелёк только что уводил её из глаз: на
        // телефоне вторую подпись обязан запустить человек. По форме это отказ
        // `getPass()`, то есть НЕУДАЧА ВХОДА, а три подряд останавливают опрос
        // навсегда. Опрос активен раз в 5 секунд — значит без этой строки чат
        // умирал бы за 15 секунд ожидания кнопки, и починка, заведённая против
        // мёртвого чата на телефоне, убивала бы его быстрее самого дефекта.
        //
        // Ни счётчиков, ни отступления, ни `onError`: человеку про это говорит
        // не транспорт, а состояние объявления ключа (`useKeyAnnouncement`),
        // и говорит словами про дело, а не «сбой связи». Разогнав здесь
        // отступление, мы получили бы чат, оживающий через пять минут после
        // нажатия, — то есть по-прежнему сломанный на вид.
        if (isSignatureDeferred(err)) {
          await sleep(waitMs);
          continue;
        }
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

        // C1-R2: любой отказ getPass() (отказ подписи, обрыв сети, свой
        // BagPassError — что угодно) ИЛИ BagPassError от listBags (пропуск
        // получен, но сервер его не принял) — отказ ВХОДА. Отказ listBags
        // любого другого рода счётчик не трогает вовсе — у него уже есть
        // свой бесконечный откат (I4), и предел на ЧИСЛО попыток входа не
        // должен его перебивать.
        const isAuthFailure = stage === 'getPass' || (stage === 'listBags' && err instanceof BagPassError);
        if (isAuthFailure) {
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
        }
      }
      if (stopped) return;

      if (tick !== null) {
        try {
          opts.onBags(tick);
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
