/**
 * arbiterPresentations.ts — ящик спора глазами арбитра.
 *
 * ЧТО ЗДЕСЬ РЕШАЕТСЯ И ПОЧЕМУ НЕ В СТРАНИЦЕ. У страницы арбитра нет ни одного
 * теста и негде его завести: окружения отрисовки у фронта нет вовсе. Значит
 * всё, что РЕШАЕТ (что забрать, в каком порядке, чьи это числа, чего мы не
 * знаем), живёт здесь, куда можно приехать вызовом. В странице остаётся
 * склейка и разметка.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И НЕ ДОЛЖНО БЫТЬ:
 *  1. Своей расшифровки и своей проверки подписи. Оба ответа даёт
 *     `readPresentation` (4в-1), и второй копии этих проверок в проекте нет:
 *     разойдясь, они дали бы разные вердикты об одном мешке.
 *  2. Своего поиска предъявлений в ящике. `findPresentations` перебирает мешки
 *     попыткой вскрытия — признака рода на проводе нет вовсе.
 *  3. Своего счёта сообщений. Числа читалки пересказываются как есть; числа
 *     стороны берутся из контейнера и НИКОГДА не смешиваются с ними.
 *  4. Ни одного слова про то, что видел ПРЕЖНИЙ арбитр. Мы этого не знаем:
 *     его мешки для нас нечитаемы, а числа внутри — заявление стороны ЕМУ.
 */
import type { PublicClient } from 'viem';
import type { ChatKeypair } from '@/lib/chatCrypto';
import type { IncomingBag } from '@/lib/chatConversation';
import { openSession, type ChatSession } from '@/lib/chatSession';
import type { GatedSignChatKey } from '@/lib/arbiterClaimKeys';
import type { ChainChatKeys } from '@/lib/arbiterChatKey';
import type { OpenFailure } from '@/lib/chatEnvelope';
import type { AttestationVerdict } from '@/lib/chatKeyAttestation';
import type { RedactedFilePayload } from '@/lib/chatPayloadForm';
import type { DeclaredCounts, MeasuredCounts } from '@/lib/presentation';
import { findPresentations, PRESENTATION_MAX_BYTES, type SkipReason } from '@/lib/presentationBag';
import { readPresentation, type PresentationView } from '@/lib/presentationRead';
import type { DisputeBoxBag, DisputeBoxList } from '@/lib/disputeBox';
import type { ArbiterTurn } from '@/lib/arbiterTurn';

export type CountField = 'read' | 'hidden' | 'notPrepared';
export type BoxStop = 'read_all' | 'read_budget' | 'transport' | 'not_mine';
export type BagSkip = SkipReason | 'too_big' | 'gone' | 'foreign_key';
export type DeviceKeyVerdict = 'agree' | 'differs' | 'chain_missing' | 'chain_unread';

const same = (a: unknown, b: unknown): boolean =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/* ─────────────────────────── тип-замки формы ──────────────────────────── */

type Lacks<T, K extends string> = [Extract<keyof T, K>] extends [never] ? true : never;

/** Вид вложения у арбитра — без ключа и без адреса, как у `RedactedFilePayload`. */
export interface PresentedFileFact {
  name: string; size: number; mime: string | null; chunked: boolean;
}
export const FILE_FACT_CARRIES_NO_KEY:
  Lacks<PresentedFileFact, 'keyHex' | 'ivHex' | 'sealedKey' | 'url' | 'fileKey'> = true;

/**
 * ⚠️ ЗАМОК НА ЧУЖУЮ СТОРОНУ ШВА, И ОН ГЛАВНЫЙ В ЭТОМ ФАЙЛЕ. Опись ящика НЕ
 * несёт ни одного счётчика — и не должна: числа внутри мешка, помеченного на
 * прежнего арбитра, это заявление стороны ЕМУ, а не нам, и показать их
 * значило бы соврать с уверенным лицом (§4 замысла). Появится в
 * `DisputeBoxBag` счётчик — `npm run type-check` покраснеет ЗДЕСЬ, и решение
 * придётся принять осознанно, а не заметить на экране.
 *
 * ⚠️ Замок такого рода НЕЛЬЗЯ запереть его снятием: у снятого замка нет
 * наблюдаемого следствия. Запирается он порчей ТОЙ СТОРОНЫ, которую сторожит
 * (мутация 12: дописать `messages: number` в `DisputeBoxBag`).
 */
export const BOX_LIST_CARRIES_NO_COUNTS:
  Lacks<DisputeBoxBag, 'counts' | 'messages' | 'read' | 'hidden' | 'notPrepared'> = true;

/** `never`, если из посчитанного пропало «не открылось». */
export const MEASURED_KEEPS_UNOPENED:
  [Extract<keyof MeasuredCounts, 'unopened'>] extends [never] ? never : true = true;

/**
 * `never`, если слово стороны стало годиться там, где ждут счёт читалки.
 *
 * ⚠️ ЧЕСТНО О ГРАНИЦЕ: обратное направление структурно ПРОХОДИТ —
 * `MeasuredCounts` подставляется туда, где ждут `DeclaredCounts` (лишнее поле
 * присваиванию не мешает). Значит эти два набора разводятся не
 * присваиваемостью, а ДВУМЯ РАЗНЫМИ ПОЛЯМИ модели (`declared`/`measured`) и
 * строками разметки, у каждой из которых своя подпись. Это сказано, а не
 * выдано за проверенное типом.
 */
export const DECLARED_IS_NOT_MEASURED:
  DeclaredCounts extends MeasuredCounts ? never : true = true;

/* ───────────────────────────── чистые решения ─────────────────────────── */

/**
 * Порядок, в котором забираются мешки.
 *
 * ⚠️ `sealedFor` — СЛОВО КЛАДУЩЕГО, сервер его не проверял и проверить не
 * может. Употребляется РОВНО НА ОДНО: очерёдность. Выбросить по нему нельзя
 * (мешок, запечатанный на меня, могли пометить чужим адресом — и тогда
 * решать, что увидит арбитр, стала бы сторона), а вот прочитать сперва то,
 * что заявлено МНЕ, — можно и нужно: при потопе бюджет чтения кончается на
 * 99-м мешке из 122, и честное предъявление, положенное последним, иначе не
 * доедет до глаз вовсе.
 */
export function readingOrder(bags: readonly DisputeBoxBag[], me: `0x${string}`): DisputeBoxBag[] {
  const rank = (b: DisputeBoxBag): number => (same(b.sealedFor, me) ? 0 : b.sealedFor === null ? 1 : 2);
  return [...bags].sort((a, b) =>
    rank(a) - rank(b) || b.uploadedAt - a.uploadedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Имя мешка ВНУТРИ ящика: `"<agreement>/<name>"` → `"<name>"`.
 * `null` — ключ не из этого ящика: чужой префикс, второй слэш, пустое имя,
 * выход наверх. Такой ключ не запрашивается вовсе — ни байта бюджета.
 */
export function bagNameFromKey(key: string, agreement: `0x${string}`): string | null {
  if (typeof key !== 'string') return null;
  const prefix = `${agreement.toLowerCase()}/`;
  if (!key.toLowerCase().startsWith(prefix)) return null;
  const name = key.slice(prefix.length);
  if (name.length === 0 || name.includes('/') || name === '.' || name === '..') return null;
  return name;
}

/**
 * Сколько арбитров вело спор ДО нынешнего. `null` — не знаем.
 *
 * ⚠️ `null` и `0` — РАЗНЫЕ вещи, и слить их нельзя: «до вас никого не было» —
 * утверждение, «узел не ответил» — признание. Сторона решает по этому числу,
 * показывать ли переписку.
 */
export function arbitersBefore(turn: ArbiterTurn): number | null {
  if (!turn.known) return null;
  return Math.max(0, turn.turn - 1);
}

/**
 * Тем ли ключом мы вскрываем. Предъявления запечатаны на ключ ИЗ ЦЕПИ; если
 * на этом устройстве ключ другой (кошелёк-контракт на втором устройстве,
 * вычищенная кладовая), не откроется ничего — и «ящик пуст» было бы ложью.
 */
export function deviceKeyVerdict(deviceBoxKey: string, chain: ChainChatKeys | null): DeviceKeyVerdict {
  if (!chain) return 'chain_unread';
  if (!chain.present) return 'chain_missing';
  return same(chain.boxKey, deviceBoxKey) ? 'agree' : 'differs';
}

export interface PresentedMessageView {
  seq: number;
  sender: `0x${string}`;
  read: boolean;
  text: string | null;
  file: PresentedFileFact | null;
  openFailure: OpenFailure | null;
  attestation: AttestationVerdict;
  frameFailure: 'malformed' | 'body_mismatch' | 'bad_signature' | null;
  /** Заверение сошлось И кадр сошёлся. Одного мало: заверение связывает ключ
   *  с адресом, кадр — байты с ключом.
   *
   *  ⚠️ И ОДНОГО ЭТОГО СЛОВА МАЛО ЧЕЛОВЕКУ — см. `attestedAt` ниже. */
  authorConfirmed: boolean;
  /**
   * КОГДА заверена та пара ключей, которой подписан этот кадр (мс, из
   * `PresentedMessage.attestedAt`). `null` — заверение под кадр не выбиралось.
   *
   * ⚠️ НАХОДКА 51: ЗАВЕРЕНИЕ ОТОЗВАТЬ НЕЧЕМ. У человека украли устройство с
   * сохранённым сеансом; он восстановился по коду и заверил новую пару, а
   * прежнее заверение осталось годным — отзыва в нём нет, а срок ему год.
   * Вор подписывает прежним ключом, и арбитр видит `ok` и на словах человека,
   * и на словах вора. Развести их можно ТОЛЬКО по дате заверения. Поэтому
   * «автор подтверждён» одно, без даты, показывать нельзя — и не
   * показывается: разметка печатает «подписано ключом, заверённым тогда-то».
   */
  attestedAt: number | null;
  legacyAttachmentExposed: boolean;
}

/**
 * Дата заверения для глаз — `ГГГГ-ММ-ДД` по UTC, `null` для «нечего датировать».
 *
 * ⚠️ UTC И ISO НАМЕРЕННО, А НЕ МЕСТНЫЙ ФОРМАТ. Эту дату арбитр сверяет со
 * словами человека в споре («устройство украли третьего числа»), то есть она
 * работает уликой. Местный формат разошёлся бы у арбитра и у стороны на
 * часовой пояс и на порядок «день/месяц» — то есть ровно там, где цена ошибки
 * равна вердикту. Ещё это делает надпись проверяемой замером: результат не
 * зависит ни от машины, ни от времени года.
 */
export function attestationDateLabel(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function fileFact(f: RedactedFilePayload): PresentedFileFact {
  return { name: f.name, size: f.size, mime: f.mime ?? null, chunked: f.chunked === true };
}

export function presentedMessages(view: PresentationView): PresentedMessageView[] {
  return view.messages.map((m) => ({
    seq: m.seq,
    sender: m.sender,
    read: m.state === 'read',
    // Слова показываются ТОЛЬКО прочитанному. Читалка и так не кладёт
    // содержимое непрочитанному, но подстраховка здесь стоит нуля.
    text: m.state === 'read' ? (m.payload?.text ?? null) : null,
    file: m.state === 'read' && m.payload?.file ? fileFact(m.payload.file) : null,
    openFailure: m.reason ?? null,
    attestation: m.attestation,
    frameFailure: m.frame.ok ? null : m.frame.reason,
    authorConfirmed: m.attestation === 'ok' && m.frame.ok,
    // Дата пересказывается как есть, СВОЕГО выбора заверения здесь нет: его
    // сделала читалка под ключ, названный кадром (находка 51).
    attestedAt: m.attestedAt ?? null,
    legacyAttachmentExposed: m.legacyAttachmentExposed,
  }));
}

/**
 * Где слово стороны разошлось с посчитанным.
 *
 * ⚠️ `read` СВЕРЯЕТСЯ С СУММОЙ. Заявленное `read` — сколько кадров сторона
 * положила; посчитанное `read` — сколько открылось У НАС. Меньше открылось —
 * это не враньё, это сломанная печать, и кадр честно ушёл в `unopened`.
 * Сверка «read с read» обвиняла бы честную сторону за нашу же неудачу.
 */
export function countsDisagreement(
  declared: DeclaredCounts | null, measured: MeasuredCounts,
): CountField[] {
  if (!declared) return [];
  const out: CountField[] = [];
  if (declared.read !== measured.read + measured.unopened) out.push('read');
  if (declared.hidden !== measured.hidden) out.push('hidden');
  if (declared.notPrepared !== measured.notPrepared) out.push('notPrepared');
  return out;
}

/* ────────────────────────────── чтение ящика ──────────────────────────── */

export interface PresentedBag {
  bagKey: string;
  /** Кто ПОЛОЖИЛ — из пропуска, доказан подписью кошелька. */
  uploadedBy: `0x${string}`;
  uploadedAt: number;
  /** Слово стороны. `null` — подпись контейнера не сошлась: кто это собрал,
   *  неизвестно, и приписывать числа «стороне» нельзя. */
  declared: DeclaredCounts | null;
  measured: MeasuredCounts;
  countsDisagree: readonly CountField[];
  /** `null` — сравнивать не с чем (подпись не сошлась). */
  uploaderIsPresenter: boolean | null;
  view: PresentationView;
  messages: PresentedMessageView[];
}

export interface DisputeBoxReading {
  /**
   * Кто ведёт спор — как это видит СЕРВЕР. ⚠️ Не мгновенный снимок цепи:
   * значение из кэша фактов релеера (`DISPUTE_BOX_TTL_MS` = 15 с) плюс
   * придержка после неудачного чтения. Отсюда следствие, которое обязано
   * дойти до надписи: `mine: false` у арбитра, ТОЛЬКО ЧТО взявшего спор, —
   * законный исход первых секунд, а не отказ в правах.
   */
  arbiterNow: `0x${string}` | null;
  /** Совпал ли `arbiterNow` со мной. Свежесть — та же, что у `arbiterNow`:
   *  это ответ сервера пятнадцатисекундной давности, а не проверка цепи. */
  mine: boolean;
  listed: number;
  /** Сколько мешков успели забрать. Меньше `listed` — ящик прочитан НЕ ЦЕЛИКОМ. */
  tried: number;
  stop: BoxStop;
  /** Слово сервера, не цепи. */
  sealedForOthersDeclared: number;
  /** Не открылось нашей парой. Это НЕ «чужие»: заявление о получателе
   *  непроверяемо, а признака рода на проводе нет вовсе. ПОСЧИТАНО нами —
   *  в отличие от `sealedForOthersDeclared`, которое заявлено. */
  notOurs: number;
  /** Из `notOurs` — те, у кого в описи стоял `fetchedAt` ДО этого чтения:
   *  их уже кто-то забирал. КТО — опись не хранит (прежний арбитр или я сам
   *  в прошлый раз), и выдавать это за «прежний арбитр прочитал» нельзя:
   *  отметка ставится ненадёжно и говорит про байты, а не про глаза. */
  notOursFetched: number;
  /** Проброшено из `DisputeBoxList.indexTrusted` без изменений (ревью
   *  Задачи 1, круг 2). `false` обязано подавлять «вам ничего не
   *  предъявили» ДАЖЕ когда `notOurs` и `sealedForOthersDeclared` оба нули. */
  indexTrusted: boolean;
  skipped: { bagKey: string; why: BagSkip }[];
  presentations: PresentedBag[];
}

export interface DisputeBoxSource {
  list(): Promise<DisputeBoxList>;
  /** Ключ описи ЦЕЛИКОМ — два сегмента, как в `DisputeBoxBag.key`. Резать его
   *  на имя здесь НЕ надо: `fetchDisputeBag` (Задача 6) сама сверяет префикс
   *  и на голом имени бросает TypeError. */
  fetch(bagKey: string): Promise<Uint8Array | null>;
}

/**
 * ⚠️ ПО КОДУ, А НЕ `instanceof`. Стенды зовут `vi.resetModules()`, и второй
 * экземпляр `chatTransport` несёт ДРУГОЙ класс с тем же именем: сверка по
 * классу промахнулась бы молча, и свой бюджет приехал бы как «поломка сети».
 */
function isReadBudget(err: unknown): boolean {
  return !!err && typeof err === 'object'
    && (err as { code?: unknown }).code === 'local_read_budget';
}

/** Ключа чата на устройстве нет — названная причина, а не поломка. */
export function isSessionAbsent(err: unknown): boolean {
  return !!err && typeof err === 'object'
    && (err as { code?: unknown }).code === 'session_absent';
}

/**
 * Почему ящик не прочитался — РАЗБОР ПО `code`, а не по классу статуса.
 *
 * ⚠️ Задача 1 завела различимые коды именно затем, чтобы экран сказал человеку,
 * что не так; схлопнуть их в одно «ящик прочитать не удалось» значит выбросить
 * всю её работу на подходе к глазам. Советы здесь разные и несовместимые:
 * «спор у вас забрали» — повторять бесполезно, «узел молчит» — повторить через
 * минуту, «пропуск протух» — нажать ещё раз и подписать.
 *
 * ⚠️ Разбор по СТАТУСУ был бы неправдой уже сегодня: у маршрутов ящика два
 * разных 403 (`not_a_party` на записи, `not_the_arbiter` на чтении), два 404,
 * два 401 и два 500. На чтении из них встречаются свои, и только их мы и
 * называем; всё незнакомое честно уходит в `unknown` с общей надписью, а не
 * угадывается.
 */
export type BoxReadRefusal =
  | 'not_mine_now'      // 403 not_the_arbiter — спор ведёт уже не я
  | 'no_such_deal'      // 404 no_such_deal — сервер такого дела не знает
  | 'chain_unavailable' // 503 — цепь не ответила, про содержимое ящика не сказано ничего
  | 'too_often'         // 429 rate_limited_* и свой local_read_budget
  | 'pass_stale'        // 401 pass_invalid / pass_expired — пропуск склада протух
  | 'unknown';          // всё остальное, включая обрыв сети

/**
 * ⚠️ ТИП-ЗАМОК: новый член `BoxReadRefusal` без ключа локали не соберётся
 * (`npm run type-check`). Ключ `unknown` намеренно тот же, что у общей надписи:
 * это не отдельная беда, а честное «не знаем, что это было».
 */
export const BOX_READ_REFUSAL_KEYS: Record<BoxReadRefusal, string> = {
  not_mine_now: 'arbiter.presentations_err_not_mine_now',
  no_such_deal: 'arbiter.presentations_err_no_such_deal',
  chain_unavailable: 'arbiter.presentations_err_chain_unavailable',
  too_often: 'arbiter.presentations_err_too_often',
  pass_stale: 'arbiter.presentations_err_pass_stale',
  unknown: 'arbiter.presentations_box_unreadable',
};

export function boxReadRefusal(err: unknown): BoxReadRefusal {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  if (typeof code !== 'string') return 'unknown';
  if (code === 'not_the_arbiter') return 'not_mine_now';
  if (code === 'no_such_deal') return 'no_such_deal';
  if (code === 'chain_unavailable') return 'chain_unavailable';
  if (code === 'pass_invalid' || code === 'pass_expired') return 'pass_stale';
  if (code === 'local_read_budget' || code.startsWith('rate_limited')) return 'too_often';
  return 'unknown';
}

/**
 * Прочитать ящик спора.
 *
 * ⚠️ ОТКАЗ ОПИСИ НЕ ЛОВИТСЯ ЗДЕСЬ И НЕ ПРЕВРАЩАЕТСЯ В ПУСТОЙ ЯЩИК. «Ящик
 * пуст» и «мы не смогли прочитать ящик» — разные новости, и первая, сказанная
 * вместо второй, — это «сторона молчала» вместо «наш сервер молчал».
 *
 * ⚠️ КОРМИТ ЧИТАЛКУ ТОЛЬКО МЕШКОМ ИЗ ЯЩИКА. У `readPresentation` нет своего
 * потолка на весь контейнер (открытый пункт 50.2), поэтому объём здесь режется
 * дважды: по числу из описи (до траты бюджета) и по фактической длине тела
 * (опись — слово сервера).
 */
export async function readDisputeBox(input: {
  source: DisputeBoxSource;
  own: ChatKeypair;
  agreement: `0x${string}`;
  me: `0x${string}`;
  publicClient?: PublicClient;
}): Promise<DisputeBoxReading> {
  const { source, own, agreement, me, publicClient } = input;
  const list = await source.list();
  const bags = Array.isArray(list.bags) ? list.bags : [];
  // Опись снята ДО единого забора — значит непустой `fetchedAt` в ней это
  // чужой (или мой прошлый) заход, а не то, что я делаю прямо сейчас.
  const fetchedAtOf = new Map<string, number | null>(bags.map(b => [b.key, b.fetchedAt ?? null]));
  const head = {
    arbiterNow: list.arbiter ?? null,
    listed: bags.length,
    sealedForOthersDeclared:
      Number.isSafeInteger(list.sealedForOthers) && list.sealedForOthers >= 0 ? list.sealedForOthers : 0,
    // ⚠️ Ревью Задачи 1, круг 2: НЕ `!!list.indexTrusted` (истинность
    // ПРОИЗВОЛЬНОГО значения) — если клиент когда-нибудь ослабят и это
    // поле пропадёт из ответа, `undefined` не имеет права молча стать
    // «доверяем». `listDisputeBox` (Задача 6) уже бросает на
    // `typeof indexTrusted !== 'boolean'`, так что здесь `list.indexTrusted`
    // — гарантированно boolean; переприсваивание дословным значением, а не
    // приведением типа, фиксирует это как инвариант, а не совпадение.
    indexTrusted: list.indexTrusted,
  };

  // Спор ведёт не я — ни одного обращения за мешком. Ящик закрыт цепью, а не
  // нашей вежливостью, но тратить чужой бюджет и своё время незачем.
  //
  // ⚠️ СРАВНИВАЕМСЯ С ТЕМ, ЧТО ВИДИТ СЕРВЕР, А ЭТО КЭШ (15 с). В первые
  // секунды после перехвата дела здесь честно получится «не мой» о моём же
  // ящике. Это не ошибка прав: настоящий отказ пришёл бы от сервера кодом
  // `not_the_arbiter`, а тут мы просто не тратим чтений на заведомо чужое.
  // Отсюда требование к надписи (`presentations_not_mine`): она обязана
  // допускать «спор только что взяли — вернитесь через полминуты», а не
  // утверждать про цепь.
  if (!same(list.arbiter, me)) {
    return {
      ...head, mine: false, tried: 0, stop: 'not_mine',
      notOurs: 0, notOursFetched: 0, skipped: [], presentations: [],
    };
  }

  const skipped: { bagKey: string; why: BagSkip }[] = [];
  const fetched: IncomingBag[] = [];
  let stop: BoxStop = 'read_all';
  let tried = 0;

  for (const bag of readingOrder(bags, me)) {
    if (bagNameFromKey(bag.key, agreement) === null) {
      skipped.push({ bagKey: bag.key, why: 'foreign_key' });
      continue;
    }
    if (bag.size > PRESENTATION_MAX_BYTES) {
      skipped.push({ bagKey: bag.key, why: 'too_big' });
      continue;
    }
    let body: Uint8Array | null;
    try {
      body = await source.fetch(bag.key);
    } catch (err) {
      // Свой бюджет и чужая беда — разные новости для человека: первое
      // проходит через минуту само, второе может не пройти никогда.
      stop = isReadBudget(err) ? 'read_budget' : 'transport';
      break;
    }
    tried++;
    if (!body) { skipped.push({ bagKey: bag.key, why: 'gone' }); continue; }
    if (body.byteLength > PRESENTATION_MAX_BYTES) {
      skipped.push({ bagKey: bag.key, why: 'too_big' });
      continue;
    }
    fetched.push({ key: bag.key, sender: bag.sender, uploadedAt: bag.uploadedAt, body });
  }

  const triage = await findPresentations(fetched, own, agreement);
  for (const s of triage.skipped) skipped.push({ bagKey: s.bagKey, why: s.why });
  // Нечитаемые нашей парой — ПОСЧИТАНЫ, а не заявлены. Именно этим числом
  // подавляется «вам ничего не предъявили»: непроверяемого `x-sealed-for` для
  // такого решения мало (мешок могли положить вовсе без заголовка).
  const notOursKeys = triage.skipped.filter(s => s.why === 'sealed_for_other').map(s => s.bagKey);
  const notOurs = notOursKeys.length;
  const notOursFetched = notOursKeys.filter(k => (fetchedAtOf.get(k) ?? null) !== null).length;

  const presentations: PresentedBag[] = [];
  for (const found of triage.presentations) {
    const view = await readPresentation(found.container, own, publicClient);
    // Числа приписываются стороне ТОЛЬКО при сошедшейся подписи: иначе автор
    // неизвестен, и «заявлено стороной» назвало бы автором того, кого мы не
    // установили.
    const declared = view.container === 'ok' ? found.container.counts : null;
    presentations.push({
      bagKey: found.bagKey,
      uploadedBy: found.uploadedBy,
      uploadedAt: found.uploadedAt,
      declared,
      measured: view.counts,
      countsDisagree: countsDisagreement(declared, view.counts),
      uploaderIsPresenter:
        view.container === 'ok' && view.presenter ? same(view.presenter, found.uploadedBy) : null,
      view,
      messages: presentedMessages(view),
    });
  }

  return { ...head, mine: true, tried, stop, notOurs, notOursFetched, skipped, presentations };
}

/* ─────────────────────── сеанс арбитра, и почём он ────────────────────── */

/**
 * Пара ключей арбитра для вскрытия ящика.
 *
 * ⚠️ ЦЕНА НАЗВАНА ЧИСЛОМ (замер E1): `mayCreate: false` — НОЛЬ окон подписи,
 * ключ читается с устройства молча; арбитр, бравший спор с этого устройства,
 * уже завёл его тем же `openSession`. Нет на устройстве — отказ с кодом
 * `session_absent` (это НЕ поломка), и одно окно платится только по второму,
 * отдельному нажатию человека, с `mayCreate: true`.
 *
 * ⚠️ ПРИНИМАЕТ ТОЛЬКО `GatedSignChatKey`. Голый подписчик сюда не подставить:
 * клеймо ставит `createGatedSignChatKey`, и оно же гарантирует отметку ухода
 * к кошельку перед каждым вызовом (`arbiterClaimKeys.ts`).
 */
export async function openArbiterBoxSession(
  address: `0x${string}`,
  sign: GatedSignChatKey,
  opts: { mayCreate?: boolean; open?: typeof openSession } = {},
): Promise<{ session: ChatSession; prompted: boolean }> {
  const open = opts.open ?? openSession;
  const session = await open(address, sign, { createIfMissing: opts.mayCreate === true });
  // `restored: true` — ключ взят с устройства, окна подписи НЕ было.
  return { session, prompted: !session.restored };
}
