/**
 * presentationAnchor.ts — отпечаток предъявления в цепи: ЧТЕНИЕ и СВЕРКА.
 *
 * ⚠️ ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ ДВЕ ПОЛОВИНЫ ПО МЕСТУ УПОТРЕБЛЕНИЯ. Цепь про
 * отпечатки спрашивают ДВОЕ: арбитр («сходится ли то, что лежит у меня в
 * ящике») и предъявлявшая сторона («отмечено ли моё предъявление» — после
 * перезагрузки вкладки она это забывает, состояние жило в памяти). Сделай два
 * места, читающих цепь, — они разойдутся: одно возьмёт геттер, другое ленту,
 * одно сравнит с учётом регистра, другое без, и разойдутся МОЛЧА, потому что
 * оба будут отвечать правдоподобно. Здесь у чтения и у сверки один хозяин.
 *
 * ⚠️ ДВА ИСТОЧНИКА, И У КАЖДОГО СВОЙ ВОПРОС — это не дубль (так же сказано и в
 * самом фасете, `src/facets/ArbiterRegistryFacet.sol:1567`):
 *   — «КАКИЕ отпечатки лежат по сделке» — только ГЕТТЕР. Он полон, дёшев и не
 *     зависит от того, как далеко назад провайдер пускает по логам. Вердикт
 *     «сходится / не сходится / не отмечено» считается ТОЛЬКО по нему;
 *   — «на каком БЛОКЕ лёг» — только ЛЕНТА. Геттеры номера блока не отдают ни
 *     одного, а порядок («отпечаток на блоке N, запись арбитра о молчании на
 *     блоке M») и есть весь смысл затеи. Окно ленты ограничено провайдером,
 *     поэтому блока может не быть — и тогда мы говорим «блок неизвестен», а не
 *     «не отмечено».
 *
 * ⚠️ ПРЕ-ОБРАЗ ОТПЕЧАТКА ЗДЕСЬ НЕ СЧИТАЕТСЯ. Переход «контейнер → 32 байта»
 * ровно один — `presentationDigest` (Задача 6), и он импортируется. Заведи
 * второй — он взял бы другой пре-образ или другую функцию хэша, в цепи лежали
 * бы такие же законные 32 байта, «сходится» не сошлось бы НИКОГДА, и узнали бы
 * мы об этом от человека со сломанным экраном.
 */
import type { Abi, Address, Hex, PublicClient } from 'viem';
import { ARBITER_REGISTRY_ABI, CONTRACTS } from '@/config/contracts';
import { CATCHUP_CHUNK_BLOCKS, CATCHUP_MAX_BLOCKS, planCatchUp } from '@/lib/chainWatchGate';
import { lastSentDraft, presentationDigest, type AnchorState } from '@/lib/presentToArbiter';
import type { UnsignedPresentation } from '@/lib/presentation';
import { readPresentationDrafts, type PresentationDraft } from '@/lib/presentationDraft';

/* ────────────────────────────── числа ──────────────────────────────────── */

/**
 * Сколько отпечатков берётся ОДНОЙ страницей геттера.
 *
 * ⚠️ Список берётся страницами, а не целиком, намеренно: полный
 * `getPresentationDigests` при раздутом списке упирается в потолок газа на
 * `eth_call`, и ломается чтение У АРБИТРА, а не у того, кто список раздул
 * (сказано в самом фасете). Страничный геттер на честном запросе не ревертит
 * никогда и отвечает пустым массивом «здесь больше ничего нет» — это и есть
 * условие остановки.
 */
export const ANCHOR_DIGEST_PAGE = 200;

/**
 * Потолок страниц. Пять тысяч отпечатков по одной сделке — это уже не спор, а
 * нарочная нагрузка; листать её бесконечно значит повесить экран арбитра.
 * Упёрлись — список НЕПОЛОН, и это доезжает до вердикта: несовпадение при
 * неполном списке честно становится «не знаем», а не «не сходится».
 */
export const ANCHOR_DIGEST_MAX_PAGES = 25;

/**
 * Окно ленты и размер куска берутся у `chainWatchGate` — там у этих двух чисел
 * уже есть хозяин, замеры и объяснение, почему провайдер длиннее не отдаёт.
 * Своих копий здесь нет намеренно: разойдясь, они дали бы отказ узла на одном
 * экране и молчаливую пустоту на другом.
 *
 * Сутки назад — это НЕ «отпечатков старше суток не бывает»: они найдутся
 * геттером и получат «сходится». Не найдётся только номер блока, и про это
 * есть отдельная надпись, а не молчание.
 */
export const ANCHOR_LOG_WINDOW_BLOCKS = CATCHUP_MAX_BLOCKS;
export const ANCHOR_LOG_CHUNK_BLOCKS = CATCHUP_CHUNK_BLOCKS;

/* ──────────────────────────── что приезжает ────────────────────────────── */

/** Одна запись отпечатка из ленты. Номер блока есть ТОЛЬКО здесь. */
export interface DigestRecord {
  digest: Hex;
  /** Кто положил — сторона спора, доказано контрактом (`NotDisputeParty`). */
  submitter: Address;
  /** Место в списке сделки. Дублирует `index` события нарочно. */
  index: bigint;
  block: bigint;
  txHash: Hex | null;
}

/** Запись арбитра «просил переписку, ответа нет» из ленты. */
export interface NoResponseRecord {
  arbiter: Address;
  /** Время по часам цепи (секунды), как записал контракт. */
  at: bigint;
  block: bigint;
  txHash: Hex | null;
}

export interface ChainAnchors {
  /**
   * ВСЕ отпечатки сделки, в порядке появления — из геттера. Хозяин ответа
   * «какие»; вердикт считается только по нему.
   */
  digests: Hex[];
  /** `false` — список уперся в потолок страниц и НЕПОЛОН. Несовпадение при
   *  неполном списке не имеет права звучать как «не сходится». */
  digestsComplete: boolean;
  /** Из ленты. Может быть короче `digests`: окно ленты ограничено. */
  records: DigestRecord[];
  noResponse: NoResponseRecord[];
  /**
   * Лента накрыла все ОТПЕЧАТКИ геттера — у каждого есть номер блока.
   *
   * ⚠️ ЭТО НЕ ГОВОРИТ НИЧЕГО ПРО ЗАПИСИ АРБИТРА, и на этом уже был промах
   * (ревью, круг 2). Отпечаток лёг двадцать тысяч блоков назад, запись арбитра
   * — сто тридцать тысяч; все отпечатки накрыты, `logsComplete === true`, а
   * записи в ленте нет — и «записи нет» прозвучало бы как знание. Свежий
   * отпечаток при старой записи — самая обычная форма спора к разбору:
   * сторона предъявила недавно, арбитр просил давно.
   */
  logsComplete: boolean;
  /**
   * Доказано ли, что окно ленты достаёт до НАЧАЛА спора. Только при `true`
   * отсутствие записи о молчании — знание, а не пробел.
   *
   * ⚠️ СЕГОДНЯ ЭТО ДОКАЗЫВАЕТСЯ РОВНО ОДНИМ СПОСОБОМ: окно упёрлось в начало
   * цепи (`head <= windowBlocks`), то есть раньше ничего быть не может. На
   * живой сети этого не бывает, и флаг честно `false` — значит «записи нет»
   * не утверждается никогда, пока не приедет сабграф. Дешёвого доказательства
   * нет и придумывать его нельзя: `getDisputeClaimedAt` отвечает про ТЕКУЩЕЕ
   * взятие спора, а запись мог оставить прежний арбитр — до него.
   */
  windowCoversDispute: boolean;
  /** Какое окно ленты спрашивали. `null` — лента не спрашивалась вовсе
   *  (отпечатков по сделке нет, упорядочивать нечего). */
  window: { fromBlock: bigint; toBlock: bigint } | null;
}

/* ─────────────────────────── чистая сверка ─────────────────────────────── */

/**
 * Два отпечатка — один и тот же?
 *
 * ⚠️ БЕЗ ОГЛЯДКИ НА РЕГИСТР, И ЭТО ВОПРОС ПРО ШОВ, А НЕ ПРИДИРКА. `keccak256`
 * из viem отдаёт строчные буквы, лента отдаёт строчные, а вот отпечаток,
 * приехавший через чужой узел, руками из обозревателя или из будущего кода —
 * законно бывает в верхнем регистре. Сравнение строк «как есть» дало бы
 * «не сходится» на честном совпадении, и разошлось бы это молча.
 */
export function sameDigest(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Отпечаток контейнера или `null`, если канонический вид не считается вовсе
 * (негодное число в счётчиках — `canonicalPresentationBytes` бросает).
 *
 * ⚠️ ПАМЯТЬ НА КОНТЕЙНЕР, И ЭТО НЕ УКРАШЕНИЕ. Благодаря ей сверка со списком
 * цепи может идти ЧЕРЕЗ `verifyDigest` — то есть через ту самую функцию,
 * которую запирают F1/F2, — не платя одним хэшем четвертьмегабайтного
 * контейнера за каждую строку списка. Без памяти пришлось бы завести на
 * боевом пути ВТОРУЮ сверку «по уже посчитанному числу», и запертая тестами
 * `verifyDigest` осталась бы украшением ровно того рода, против которого вся
 * задача.
 */
const digestMemo = new WeakMap<object, Hex | null>();

export function digestOfContainer(container: UnsignedPresentation): Hex | null {
  if (!container || typeof container !== 'object') return null;
  const hit = digestMemo.get(container as object);
  if (hit !== undefined) return hit;
  let value: Hex | null;
  try {
    value = presentationDigest(container);
  } catch {
    value = null;
  }
  digestMemo.set(container as object, value);
  return value;
}

/**
 * Сходится ли отпечаток мешка с тем, что записано в цепи. ⚠️ НЕ БРОСАЕТ.
 *
 * Подмена байтов мешка при живом отпечатке обязана дать `false`: 32 байта в
 * цепи легли на своём блоке и не меняются, а пересчитанный пре-образ уже
 * другой. Контейнер, у которого канонический вид вовсе не считается, сойтись
 * не может ни с чем — это тоже `false`, а не падение экрана арбитра на одном
 * кривом мешке из ящика.
 *
 * ⚠️ ЭТО НЕ ТОЛЬКО ПРИМИТИВ ДЛЯ ТЕСТОВ: через него идёт БОЕВАЯ сверка ящика
 * (`containerAnchor` ниже). Отдельная «настоящая» сверка рядом с этой была бы
 * вторым хозяином одного вопроса — и разошлась бы молча.
 */
export function verifyDigest(container: UnsignedPresentation, onChain: Hex): boolean {
  const mine = digestOfContainer(container);
  return mine !== null && sameDigest(mine, onChain);
}

/**
 * ⚠️ ЧЕТЫРЕ ИСХОДА, И ТРЕТИЙ — НЕ ОШИБКА.
 *  - `match`    — отпечаток лежит в цепи;
 *  - `mismatch` — отпечатки по сделке ЕСТЬ, но ни один не тот: байты мешка не
 *                 те, что предъявлялись;
 *  - `absent`   — по сделке не записано ни одного. Законно: отпечаток мог не
 *                 лечь (второй шаг Задачи 6), а предъявление всё равно
 *                 действительно;
 *  - `unread`   — цепь не ответила ИЛИ список отпечатков неполон. Молчать об
 *                 этом нельзя: «не знаем» и «не сходится» — разные новости, и
 *                 вторая, сказанная вместо первой, обвиняет сторону.
 */
export type DigestVerdict = 'match' | 'mismatch' | 'absent' | 'unread';

export interface BagAnchor {
  verdict: DigestVerdict;
  /** Блок ПЕРВОЙ записи этого отпечатка. `null` — не совпало, либо лента до
   *  него не дотянулась (тогда `verdict === 'match'`, а блока нет). */
  block: bigint | null;
  /** Кто записал первым. `null` — по той же причине, что и `block`. */
  submitter: Address | null;
  /**
   * Сколько раз этот отпечаток записан в цепь. ⚠️ Дубль — честное поведение
   * (обрыв ответа и повтор «отметить»), и скрывать его нельзя: показ
   * схлопывается до одной строки, а число остаётся числом.
   */
  records: number;
  /** Сколько отпечатков записано по сделке ВСЕГО. Без него «не сходится»
   *  звучит голословно: с числом видно, что сверять было с чем. */
  total: number;
}

/** Самая ранняя подходящая запись в ленте. Именно ранняя: спор решает то, что
 *  легло РАНЬШЕ, а повтор после обрыва лёг позже и ничего не добавляет. */
function firstRecord(anchors: ChainAnchors, is: (d: Hex) => boolean): DigestRecord | null {
  let best: DigestRecord | null = null;
  for (const r of anchors.records) {
    if (!is(r.digest)) continue;
    if (!best || r.block < best.block || (r.block === best.block && r.index < best.index)) best = r;
  }
  return best;
}

/**
 * Вердикт по одному мешку. `is` — чем именно проверяется «этот ли отпечаток»;
 * список и его полнота решаются ЗДЕСЬ и только здесь, чтобы у правила
 * «сходится / не сходится / не отмечено / не знаем» был один хозяин на оба
 * входа (по контейнеру и по готовому числу).
 */
function anchorBy(is: (d: Hex) => boolean, anchors: ChainAnchors | null): BagAnchor {
  if (!anchors) return { verdict: 'unread', block: null, submitter: null, records: 0, total: 0 };
  const total = anchors.digests.length;
  // Считается по ГЕТТЕРУ: он полон и не зависит от окна ленты.
  const records = anchors.digests.filter(is).length;
  if (records > 0) {
    const first = firstRecord(anchors, is);
    return {
      verdict: 'match',
      block: first ? first.block : null,
      submitter: first ? first.submitter : null,
      records, total,
    };
  }
  // Список неполон — «не сходится» было бы обвинением, выведенным из того,
  // чего мы не дочитали.
  if (!anchors.digestsComplete) return { verdict: 'unread', block: null, submitter: null, records: 0, total };
  if (total === 0) return { verdict: 'absent', block: null, submitter: null, records: 0, total };
  return { verdict: 'mismatch', block: null, submitter: null, records: 0, total };
}

/** Вердикт по готовому отпечатку. `anchors === null` — цепь не читана. */
export function bagAnchor(digest: Hex, anchors: ChainAnchors | null): BagAnchor {
  return anchorBy(d => sameDigest(d, digest), anchors);
}

/**
 * ⚠️ БОЕВОЙ ВХОД ЯЩИКА, И ОН ИДЁТ ЧЕРЕЗ `verifyDigest`. Сверять по числу,
 * посчитанному строкой выше в том же файле, значило бы спрашивать модуль о нём
 * самом: подменённый переход «контейнер → 32 байта» ответил бы «сходится» на
 * любой мутации. Здесь сравниваются КОНТЕЙНЕР и то, что лежит в цепи.
 */
export function containerAnchor(
  container: UnsignedPresentation, anchors: ChainAnchors | null,
): BagAnchor {
  return anchorBy(d => verifyDigest(container, d), anchors);
}

/**
 * Порядок двух фактов цепи. ⚠️ РАДИ ЭТОГО ВСЁ И ЗАТЕВАЛОСЬ: доверия к нашему
 * серверу для такого сравнения не нужно.
 *
 * ⚠️ «НЕ ЗНАЮ» И «НЕ СМОТРЕЛ ТАК ДАЛЕКО» — РАЗНЫЕ ВЕЩИ, И ЭТО ПРАВКА КРУГА 1.
 * Прежде оба схлопывались в `unknown`, строка порядка просто не рисовалась, и
 * потеря была НЕОТЛИЧИМА от «отпечатка нет». Между тем второе человек может
 * обойти сам, попросив разбор: окно ленты — сутки, окно спора — четверо, а с
 * апелляцией восемь, то есть к разбору апелляции отпечаток почти всегда старше
 * окна. Настоящее лечение — сабграф, он отдельной работой; до него потеря
 * обязана быть ГРОМКОЙ.
 *
 *  - `digest_first` / `record_first` / `same_block` — знаем и говорим;
 *  - `not_anchored`  — отпечаток в цепи не найден: упорядочивать нечего, и об
 *    этом уже сказано своей строкой (`absent`/`mismatch`);
 *  - `chain_unread`  — цепь не отвечала вовсе;
 *  - `no_record`     — записи «просил, ответа нет» в цепи НЕТ, и лента накрыла
 *    всё: это ЗНАНИЕ, а не пробел, и молчать про него законно;
 *  - `out_of_window` — ⚠️ ГРОМКАЯ ПОТЕРЯ. Отметка есть, но номер блока (свой
 *    или чужой) остался за границей окна поиска. Сказать надо словами.
 */
export type AnchorOrder =
  | 'digest_first' | 'record_first' | 'same_block'
  | 'not_anchored' | 'chain_unread' | 'no_record' | 'out_of_window';

export function anchorOrder(anchor: BagAnchor, anchors: ChainAnchors | null): AnchorOrder {
  if (!anchors) return 'chain_unread';
  if (anchor.verdict !== 'match') return 'not_anchored';
  // Отпечаток отмечен, а на каком блоке — не видно: лента до него не достала.
  if (typeof anchor.block !== 'bigint') return 'out_of_window';
  const rec = firstNoResponse(anchors);
  // ⚠️ «ЗАПИСИ НЕТ» — ЗНАНИЕ ТОЛЬКО ПРИ ДОКАЗАННОМ ПОКРЫТИИ НАЧАЛА СПОРА, И
  // ЭТО ПРАВКА КРУГА 2. Прежде здесь стоял `logsComplete` — покрытие
  // ОТПЕЧАТКОВ, которое про записи арбитра не говорит ничего. Живая проба
  // ревьюера: отпечаток 20 000 блоков назад (внутри окна), запись арбитра
  // 130 000 (трое суток, снаружи) — `logsComplete === true`, записи в ленте
  // нет, и выходило `no_record` при правде `record_first`. Это ровно та ложь,
  // против которой правка круга 1 и вводилась, только зашедшая с другой
  // стороны, и форма спора это самая обычная: предъявили недавно, просили
  // давно.
  if (!rec) return anchors.windowCoversDispute ? 'no_record' : 'out_of_window';
  if (anchor.block < rec.block) return 'digest_first';
  if (anchor.block > rec.block) return 'record_first';
  return 'same_block';
}

/** Самая ранняя запись о молчании — с ней и сравнивается предъявление: если
 *  предъявили раньше ПЕРВОЙ такой записи, поздние записи ничего не добавляют. */
export function firstNoResponse(anchors: ChainAnchors | null): NoResponseRecord | null {
  if (!anchors) return null;
  let best: NoResponseRecord | null = null;
  for (const r of anchors.noResponse) if (!best || r.block < best.block) best = r;
  return best;
}

/* ───────────────────────────── чтение цепи ─────────────────────────────── */

const DIGEST_EVENT = (ARBITER_REGISTRY_ABI as readonly unknown[]).find(
  (e): e is { type: 'event'; name: string } =>
    !!e && typeof e === 'object'
    && (e as { type?: unknown }).type === 'event'
    && (e as { name?: unknown }).name === 'PresentationDigestRecorded',
);

const NO_RESPONSE_EVENT = (ARBITER_REGISTRY_ABI as readonly unknown[]).find(
  (e): e is { type: 'event'; name: string } =>
    !!e && typeof e === 'object'
    && (e as { type?: unknown }).type === 'event'
    && (e as { name?: unknown }).name === 'DisputeNoResponseRecorded',
);

/**
 * ⚠️ ОПИСАНИЯ СОБЫТИЙ БЕРУТСЯ ИЗ `ARBITER_REGISTRY_ABI`, А НЕ ОБЪЯВЛЯЮТСЯ ЗДЕСЬ
 * СВОЕЙ СТРОКОЙ. У подписи события один хозяин, и он уже сверяется с исходником
 * фасета замком `lib/presentationDigestAbi.test.ts` — включая флаги `indexed`,
 * которые решают, что уедет в topics. Своя копия разошлась бы молча: фильтр по
 * сделке просто перестал бы находить что-либо.
 */
export const ANCHOR_EVENTS = [DIGEST_EVENT, NO_RESPONSE_EVENT].filter(Boolean) as unknown[];

export interface ReadAnchorsOptions {
  /** Глубина ленты в блоках. Умолчание — сутки (`ANCHOR_LOG_WINDOW_BLOCKS`). */
  windowBlocks?: bigint;
  chunkBlocks?: bigint;
  /** Куда жаловаться на неудачу ленты. Умолчание — `console.warn`. */
  onLogFailure?: (err: unknown) => void;
}

function isSameAddress(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** Все отпечатки сделки — страницами, до короткой страницы или до потолка. */
async function readDigestPages(
  client: PublicClient, agreement: Address,
): Promise<{ digests: Hex[]; complete: boolean }> {
  const digests: Hex[] = [];
  for (let page = 0; page < ANCHOR_DIGEST_MAX_PAGES; page++) {
    const got = (await client.readContract({
      address: CONTRACTS.diamond as Address,
      abi: ARBITER_REGISTRY_ABI as Abi,
      functionName: 'getPresentationDigestsPage',
      args: [agreement, BigInt(page * ANCHOR_DIGEST_PAGE), BigInt(ANCHOR_DIGEST_PAGE)],
    })) as readonly Hex[];
    const list = Array.isArray(got) ? got : [];
    for (const d of list) digests.push(d);
    // Короткая страница — условие остановки, объявленное самим контрактом.
    if (list.length < ANCHOR_DIGEST_PAGE) return { digests, complete: true };
  }
  return { digests, complete: false };
}

/**
 * Прочитать всё, что цепь знает про отпечатки этой сделки.
 *
 * ⚠️ БРОСАЕТ ТОЛЬКО НА ГЕТТЕРЕ. Не ответил геттер — мы не знаем НИЧЕГО, и
 * вызывающий обязан сказать «не знаем» (`unread`), а не «не отмечено». А вот
 * неудача ЛЕНТЫ вердикта не отменяет: «какие» мы уже знаем, теряется только
 * номер блока — и это отдельная надпись, а не отказ.
 *
 * ⚠️ ЛЕНТА НЕ СПРАШИВАЕТСЯ ВОВСЕ, КОГДА ОТПЕЧАТКОВ НЕТ. Двенадцать запросов
 * `eth_getLogs` ради пустого ответа — это цена, которую платил бы каждый
 * открывший ящик по обычной сделке.
 */
export async function readChainAnchors(
  client: PublicClient, agreement: Address, opts: ReadAnchorsOptions = {},
): Promise<ChainAnchors> {
  const { digests, complete } = await readDigestPages(client, agreement);
  const base: ChainAnchors = {
    digests, digestsComplete: complete,
    records: [], noResponse: [], logsComplete: false,
    // Ленту ещё не спрашивали — доказывать покрытие нечем.
    windowCoversDispute: false, window: null,
  };
  if (digests.length === 0) {
    // Упорядочивать нечего: ни одного отпечатка. `logsComplete` честно `true` —
    // лента накрыла все ноль штук.
    return { ...base, logsComplete: true };
  }
  if (ANCHOR_EVENTS.length === 0) {
    // ABI разъехался с разводкой: фильтр, который ничего не поймает, взводить
    // незачем, но и молчать нельзя — блока не будет, и это видно по флагу.
    return base;
  }

  const windowBlocks = opts.windowBlocks ?? ANCHOR_LOG_WINDOW_BLOCKS;
  const chunkBlocks = opts.chunkBlocks ?? ANCHOR_LOG_CHUNK_BLOCKS;
  const records: DigestRecord[] = [];
  const noResponse: NoResponseRecord[] = [];
  let window: ChainAnchors['window'] = null;
  /**
   * ⚠️ ЕДИНСТВЕННОЕ ДОКАЗАТЕЛЬСТВО ПОКРЫТИЯ, КОТОРОЕ У НАС ЕСТЬ: окно упёрлось
   * в начало цепи, значит раньше ничего быть не может — ни отпечатка, ни
   * записи арбитра. На живой сети этого не бывает, и флаг честно `false`;
   * тогда «записи о молчании нет» не утверждается вовсе. Дешёвого второго
   * доказательства НЕТ и придумывать его нельзя: `getDisputeClaimedAt`
   * отвечает про ТЕКУЩЕЕ взятие спора, а запись мог оставить прежний арбитр —
   * до него. Настоящее лечение — сабграф, отдельной работой.
   */
  let coversAll = false;

  try {
    const head = await client.getBlockNumber();
    const from = head > windowBlocks ? head - windowBlocks : BigInt(0);
    coversAll = head <= windowBlocks;
    // Резка на куски — у `planCatchUp`: у правила «сколько блоков берёт один
    // eth_getLogs» один хозяин, свой второй разошёлся бы с ним молча.
    const plan = planCatchUp(from, head, windowBlocks, chunkBlocks);
    if (!plan) return base;
    window = { fromBlock: plan.chunks[0].fromBlock, toBlock: plan.chunks[plan.chunks.length - 1].toBlock };

    const chunks = await Promise.all(plan.chunks.map(c =>
      (client.getLogs as unknown as (a: unknown) => Promise<unknown[]>)({
        address: CONTRACTS.diamond as Address,
        events: ANCHOR_EVENTS,
        fromBlock: c.fromBlock,
        toBlock: c.toBlock,
      })));

    for (const log of chunks.flat()) {
      const l = log as {
        eventName?: string; blockNumber?: bigint; transactionHash?: Hex;
        args?: Record<string, unknown>;
      };
      const args = l.args ?? {};
      // ⚠️ ФИЛЬТР ПО СДЕЛКЕ ЗДЕСЬ, А НЕ В ЗАПРОСЕ, ОСОЗНАННО: одним запросом
      // берутся ОБА события (порядок между ними и есть предмет), а на списке
      // событий viem фильтра по аргументам не принимает. Двумя запросами
      // вместо одного окно стоило бы вдвое дороже.
      if (!isSameAddress(args.agreement, agreement)) continue;
      if (typeof l.blockNumber !== 'bigint') continue;
      const txHash = typeof l.transactionHash === 'string' ? l.transactionHash : null;
      if (l.eventName === 'PresentationDigestRecorded') {
        if (typeof args.digest !== 'string' || typeof args.submitter !== 'string') continue;
        records.push({
          digest: args.digest as Hex,
          submitter: args.submitter as Address,
          index: typeof args.index === 'bigint' ? args.index : BigInt(0),
          block: l.blockNumber,
          txHash,
        });
      } else if (l.eventName === 'DisputeNoResponseRecorded') {
        if (typeof args.arbiter !== 'string') continue;
        noResponse.push({
          arbiter: args.arbiter as Address,
          at: typeof args.at === 'bigint' ? args.at : BigInt(0),
          block: l.blockNumber,
          txHash,
        });
      }
    }
  } catch (err) {
    // Лента не далась — вердикт от этого не страдает, страдает только номер
    // блока. Молча это не проходит: жалоба в консоль плюс `logsComplete`.
    (opts.onLogFailure ?? ((e: unknown) => {
      console.warn('[hexseal] лента отпечатков не прочиталась:', e);
    }))(err);
    return base;
  }

  // Полнота меряется ЧИСЛОМ, а не отсутствием отказа: окно могло удаться
  // целиком и всё равно не накрыть отпечаток недельной давности.
  const covered = digests.filter(d => records.some(r => sameDigest(r.digest, d))).length;
  return {
    ...base, records, noResponse, window,
    logsComplete: covered >= digests.length,
    windowCoversDispute: coversAll,
  };
}

/* ─────────────── сторона, вернувшаяся на перезагруженную вкладку ─────────── */

/**
 * ⚠️ ЭТО ТРЕБОВАНИЕ, ПЕРЕНЕСЁННОЕ ИЗ ЗАДАЧИ 6, И ОНО ПРО ОБСТОЯТЕЛЬСТВА, А НЕ
 * ПРО ЛОГИКУ. `AnchorState` жил в памяти вкладки: человек, положивший мешок и
 * не отметивший его в цепи, закрывал вкладку — и возвращался к экрану, на
 * котором нет ни строки «не отмечено», ни кнопки «отметить». Мешок у арбитра,
 * страховки нет, и узнать об этом неоткуда. Четвёртый вопрос про
 * обстоятельства («если сломается — узнает ли?») отвечался «нет».
 *
 * Путь ТОТ ЖЕ, что у арбитра: `readChainAnchors` одна на обоих.
 */
export function anchorFromChain(digest: Hex, anchors: ChainAnchors | null): AnchorState {
  const a = bagAnchor(digest, anchors);
  if (a.verdict === 'match') {
    // Номер транзакции берётся из ленты, когда она дотянулась. Не дотянулась —
    // отметка всё равно есть, и говорить «не отмечено» было бы враньём.
    const rec = anchors ? firstRecord(anchors, d => sameDigest(d, digest)) : null;
    return { kind: 'anchored', txHash: rec?.txHash ?? null };
  }
  if (a.verdict === 'absent' || a.verdict === 'mismatch') return { kind: 'missing', digest };
  // `unread` — молчим. Ни «отмечено», ни «не отмечено» сказать честно нельзя.
  return { kind: 'none' };
}

/**
 * ⚠️ ВОССТАНОВЛЕННОЕ НЕ ЗАТИРАЕТ ИЗВЕСТНОЕ — то же правило, что у
 * `keepFirstSent`/`keepKnownBox` (Задача 6). Чтение цепи асинхронное: успел
 * человек предъявить заново раньше, чем оно вернулось, — свежий ответ кнопки
 * старше по знанию, чем ответ цепи, снятый до отправки.
 */
export function keepKnownAnchor(prev: AnchorState, next: AnchorState): AnchorState {
  return prev.kind === 'none' ? next : prev;
}

export interface AnchorRestoreIO {
  presenter: `0x${string}`;
  agreement: `0x${string}`;
  /** Жив ли ещё вызывающий (вкладку закрыли, чат переключили). */
  alive: () => boolean;
  applyAnchor: (fn: (prev: AnchorState) => AnchorState) => void;
  readAnchors: () => Promise<ChainAnchors>;
  readDrafts?: (p: `0x${string}`) => Promise<PresentationDraft[]>;
}

/**
 * Тело эффекта монтирования на стороне предъявителя. ⚠️ НЕ БРОСАЕТ: ни диск,
 * ни цепь не имеют права уронить чат при открытии.
 *
 * ⚠️ БЕРЁТСЯ ПОСЛЕДНИЙ ОТПРАВЛЕННЫЙ ЧЕРНОВИК, А НЕ ЛЮБОЙ. Собранный, но не
 * отправленный мешок у арбитра НЕ лежит — сказать про него «в цепи не
 * отмечено» значило бы пугать человека тем, что он ничего и не отправлял.
 */
export async function restoreAnchorImpl(io: AnchorRestoreIO): Promise<void> {
  let drafts: PresentationDraft[];
  try {
    drafts = await (io.readDrafts ?? readPresentationDrafts)(io.presenter);
  } catch {
    return;   // черновики не прочитались — восстанавливать нечего
  }
  if (!io.alive()) return;
  const draft = lastSentDraft(drafts, io.agreement);
  if (!draft) return;

  let digest: Hex;
  try {
    digest = presentationDigest(draft.container);
  } catch {
    return;   // канонический вид не считается — сверять нечем
  }

  let anchors: ChainAnchors;
  try {
    anchors = await io.readAnchors();
  } catch {
    return;   // цепь молчит — молчим и мы, «не отмечено» было бы догадкой
  }
  if (!io.alive()) return;
  io.applyAnchor(prev => keepKnownAnchor(prev, anchorFromChain(digest, anchors)));
}
