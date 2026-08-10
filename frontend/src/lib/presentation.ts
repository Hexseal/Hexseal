/**
 * presentation.ts — сборщик предъявления переписки арбитру (работа 4в, §15).
 *
 * ЧТО ЗДЕСЬ ПРОИСХОДИТ И ПОЧЕМУ ИМЕННО ТАК
 *
 * Арбитр получает ИСХОДНЫЕ БАЙТЫ кадров и разовый ключ каждого сообщения,
 * запечатанный на его открытый ключ из цепи. Перешифровка невозможна в принципе:
 * подпись звена накрывает зашифрованные байты
 * (`bodyHash = keccak256("hexseal.chat.body.v1" ‖ signerPub ‖ envelope)`,
 * `chatConversation.ts:456-477`), и перешифрованный текст с подписью не связан
 * ничем. Третий слот в конверт добавить тоже нельзя — это меняет байты, а значит
 * рвёт уже поставленную подпись. Поэтому ключ живёт РЯДОМ с доказательством.
 *
 * ТРИ ОБЪЯВЛЕННЫХ ЧИСЛА, И ПОЧЕМУ ИХ ТРИ (§15.4, §15.5 замысла; исправления 7-8):
 *   read        — предъявитель вскрыл это сообщение ТЕМ САМЫМ ключом, который
 *                 запечатан в контейнере. Не «выбрал», а именно вскрыл.
 *   hidden      — сколько сообщений человек решил не показывать. Считается как
 *                 «ожидалось − звенья цепочки» по каждой цепочке, БЕЗ второго
 *                 вычета: звенья неподготовленных кадров в цепочке остаются
 *                 (§15.5), поэтому они уже вычтены один раз. Вычесть их снова —
 *                 занизить «скрыто» на их число.
 *   notPrepared — кадры, которые не читает сам предъявитель, с причиной. Кадр в
 *                 предъявление не кладётся, ЗВЕНО остаётся: без него цепочка
 *                 рвётся, и арбитр видит лишний `gap` — обвинение в утаивании
 *                 того, что предъявитель назвал вслух.
 *
 * А ГДЕ ЧЕТВЁРТОЕ. `unopened` — место арбитра, и в объявленных числах такого поля
 * НЕТ ВОВСЕ (`DeclaredCounts`, исправление 7). Не «мы ставим 0», а нечем поставить:
 * ноль на этом месте выглядит как измеренное число и подменяет счёт арбитра словом
 * заинтересованной стороны. Сторожит это тип-замок ниже, а не договорённость.
 * Проверка сумм: «прочитано + скрыто + не подготовлено» равно числу сообщений в
 * переписке (стенд: 3 + 2 + 1 = 6), и то же самое у арбитра — 0 + 3 + 2 + 1 = 6.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО:
 *   - открытого текста. Содержимое вскрывается ТОЛЬКО ради проверки «а вскрывается
 *     ли», и результат выбрасывается. Через сервер едет только нечитаемый мешок
 *     (§10 замысла): расшифровывает браузер арбитра.
 *   - вердикта цепочки. `verifyChain` зовёт ЧИТАТЕЛЬ (Задача 6), потому что
 *     вердикт, посчитанный предъявителем, — это его слово, а не проверка.
 */
import { type ChainLink, type ChainAnchor, linkHash } from './chatChain';
import {
  readConversationArchive, readConversationHead, decodeFrame,
  deriveLinkSigningKeypair, verifyFrameEvidence,
  type ConversationHead, type SignedLinkFrame,
} from './chatConversation';
import { recoverOneTimeKey, openEnvelopeWithOneTimeKey, MAX_ENVELOPE_BYTES } from './chatEnvelope';
import { sealForRecipient } from './chatCrypto';
import { verifyChatKeyAttestation, type ChatKeyAttestation } from './chatKeyAttestation';
import type { BoxKey } from './arbiterChatKey';
import type { ChatSession } from './chatSession';
import type { PublicClient } from 'viem';

/* ─────────────────────────── род и метки ─────────────────────────── */

/** Род мешка. Без него арбитр не отличит предъявление от своих же переписок с
 *  теми же людьми: опись мешков рода не несёт (§15.7). */
export const PRESENTATION_KIND = 'hexseal.presentation.v1' as const;

/** Доменная метка подписи контейнера. Меняется — значит меняется формат, и
 *  прежние предъявления перестают проверяться: это МИГРАЦИЯ, не правка. */
export const PRESENTATION_SIG_DOMAIN = 'hexseal.presentation.sig.v1';

/** Потолок одного мешка на складе (`relayer/bagStore.js:244`, `MAX_BAG_SIZE`), он
 *  же потолок конверта. Берётся из `chatEnvelope`, а не переписывается числом:
 *  два независимых числа расходятся молча. */
export const PRESENTATION_MAX_BYTES = MAX_ENVELOPE_BYTES;

/** `crypto_box_SEALBYTES`: 32 байта одноразового ключа + 16 байт MAC. Контейнер
 *  уедет запечатанным, и эти байты платит он.
 *
 *  ⚠️ Все три константы выше объявлены ЗДЕСЬ И ТОЛЬКО ЗДЕСЬ (исправление 11
 *  договора). Задачи 6-8 их импортируют или реэкспортируют; своё
 *  `MAX_PRESENTATION_BAG_BYTES = 262144` рядом — это два числа, которые разойдутся
 *  молча и разойдутся в сторону отказа склада 413 у человека посреди спора. */
export const PRESENTATION_SEAL_OVERHEAD = 48;

/* ─────────────────────────── типы договора ─────────────────────────── */

export interface PerSenderChain {
  sender: `0x${string}`;
  links: ChainLink[];
  anchor: ChainAnchor;
  /** ⚠️ ЧЕСТНОСТЬ ЯКОРЯ, §15.3. `own_head` — якорь взят из головы разговора на
   *  устройстве и покрывает всё, что у предъявителя есть. `as_received_by_presenter`
   *  — это НЕ истина, а «столько, сколько дошло до предъявителя»: величина,
   *  которую ему выгодно уменьшить. Полная честность приходит в 4г, где якорь
   *  даёт вторая сторона. */
  anchorSource: 'own_head' | 'as_received_by_presenter';
}

export interface SealedOneTimeKey {
  seq: number;
  sender: `0x${string}`;
  /** base64 печати разового ключа на открытый ключ арбитра. */
  forArbiter: string;
  /** base64 печати того же ключа на открытый ключ второй стороны. Без неё §7
   *  замысла («вторая сторона видит, ЧТО именно предъявили») к уже доставленным
   *  предъявлениям не достроить никогда — только переделать (§15.6). */
  forPeer: string;
}

/**
 * Числа, КОТОРЫЕ ОБЪЯВЛЯЕТ ПРЕДЪЯВИТЕЛЬ. Ровно три (исправление 7 договора).
 * `unopened` здесь нет и быть не может: предъявитель не арбитр и не знает, что не
 * открылось у арбитра. Четвёртое число живёт в выдаче читалки под другим именем
 * (`MeasuredCounts`, Задача 6) — так у смотрящего на числа не остаётся вопроса,
 * чьё это слово.
 */
export interface DeclaredCounts {
  read: number;
  hidden: number;
  notPrepared: number;
}

/**
 * Числа, КОТОРЫЕ СЧИТАЕТ АРБИТР при чтении (Задача 6). Объявлены здесь же
 * (договор v4): один источник имён для «слова предъявителя» и «счёта арбитра»
 * не заводится нигде — типы разные, и перепутать их присвоением компилятор не
 * даст (структурно они и правда различаются полем `unopened`).
 */
export interface MeasuredCounts {
  read: number;
  unopened: number;
  hidden: number;
  notPrepared: number;
}

/**
 * ⚠️ ЗАМОК КОМПИЛЯТОРА, а не договорённости. Допишет кто-нибудь `unopened` в
 * `DeclaredCounts` — и вот эта строка перестанет собираться: `npm run type-check`
 * отдаёт отказ, а не зелёный. В тестовом файле такой замок был бы бесполезен —
 * `frontend/tsconfig.json:exclude` вычёркивает файлы вида `*.test.ts`, и проверка
 * типов тестов НЕ ВИДИТ (замерено 10 августа: файл с `const x: number = "строка"`
 * даёт выход 0 без единой диагностики). Поэтому форма живёт в боевом файле.
 *
 * ⚠️ Форма — кортеж `[Extract<keyof T, K>] extends [never]`, а не голое
 * `Extract<...> extends never`: без кортежа объединение распределяется по
 * членам и вычисляется в `never` при пустом пересечении, из которого «условие
 * верно» истинно ВСЕГДА — шестнадцатый случай этого класса в проекте.
 */
export type DeclaredCountsHaveNoUnopened =
  [Extract<keyof DeclaredCounts, 'unopened'>] extends [never] ? true : never;
export const DECLARED_COUNTS_CARRY_NO_UNOPENED: DeclaredCountsHaveNoUnopened = true;

export interface PresentationContainer {
  kind: typeof PRESENTATION_KIND;
  dealId: `0x${string}`;
  presenter: `0x${string}`;
  attestations: ChatKeyAttestation[];
  chains: PerSenderChain[];
  frames: { seq: number; sender: `0x${string}`; frame: string }[];
  keys: SealedOneTimeKey[];
  counts: DeclaredCounts;
  notPrepared: { seq: number; sender: `0x${string}`; reason: string }[];
  issuedAt: number;
  /** base64 Ed25519-подписи над `canonicalPresentationBytes`. */
  signature: string;
}

export type UnsignedPresentation = Omit<PresentationContainer, 'signature'>;

/**
 * Имена отказов. `peer_has_no_key` — исправление 6 договора: `SealedOneTimeKey.forPeer`
 * обязателен по типу, а ключа второй стороны может не быть вовсе. Бросок `TypeError`
 * на этом месте показывал бы человеку посреди спора поломку вместо причины.
 */
export type BuildFailure =
  | 'arbiter_has_no_key' | 'peer_has_no_key' | 'nothing_selected' | 'too_large' | 'no_session';

/** Отказ. Поля `fits`/`estimatedBytes`/`limitBytes` — расширение договора: без
 *  числа влезающих кадров отказ по потолку нельзя выполнить человеку (§15.7 и
 *  требование «с числом влезающих кадров»). Присвоение в договорный тип
 *  `{ ok: false; reason: BuildFailure }` от этого не ломается.
 *
 *  ⚠️ `fits` — ЕДИНСТВЕННЫЙ источник этого числа на весь план (исправление 11):
 *  `fittingMessageCount` (Задача 8) берёт его отсюда и не считает своей моделью
 *  размера. Две модели разойдутся, и человек увидит «влезает 4» там, где склад
 *  ответит 413 на четырёх. */
export interface PresentationRefusal {
  ok: false;
  reason: BuildFailure;
  fits?: number;
  estimatedBytes?: number;
  limitBytes?: number;
}

export type NotPreparedReason =
  | 'not_in_archive' | 'not_in_conversation' | 'undecryptable' | 'seal_failed'
  | 'malformed' | 'body_mismatch' | 'bad_signature'
  | 'bad_key' | 'aad_mismatch' | 'bad_form';

export interface BuildPresentationInput {
  dealId: `0x${string}`;
  presenter: `0x${string}`;
  /** ⚠️ ОБЯЗАТЕЛЬНОЕ (исправление 6 договора). Вторая сторона переписки: архив и
   *  голова лежат под ПАРОЙ адресов (`conversationId`, `chatConversation.ts:600-602`),
   *  и без второго свою же копию переписки нечем адресовать. Вывод «из заверения
   *  собеседника или из выбора» не закрывал случай «показываю только своё,
   *  заверения собеседника нет» вовсе — теперь дыры не существует, а не обходится. */
  peer: `0x${string}`;
  arbiterBoxKey: Uint8Array;
  peerBoxKey: Uint8Array;
  selected: { seq: number; sender: `0x${string}` }[];
  session: ChatSession;
  ownAttestation: ChatKeyAttestation;
  peerAttestation?: ChatKeyAttestation;
  /** Клиент цепи для проверки ERC-1271 (исправление 5 договора). Без него
   *  заверение развёрнутого умного кошелька — Safe и подобные, два рода из четырёх
   *  (`project_wallet_kinds_four`) — не проверяется НИКАК, и предъявить такой
   *  человек не может вовсе: сборщик откажет `no_session`. Со клиентом проверяется
   *  вызовом `isValidSignature`. Счётный кошелёк без кода на цепи не проверяется
   *  ничем и получает честный отказ, а не тишину. */
  publicClient?: PublicClient;
  /** Расширение договора: часы, ради повторяемости замеров (как
   *  `SendMessageOptions.now`). */
  now?: () => number;
}

/* ─────────────────────────── мелкая утварь ─────────────────────────── */

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const KEY_HEX_RE = /^0x[0-9a-fA-F]{64}$/;
const BOX_KEY_LEN = 32;

function lowerAddr(value: unknown, what: string): `0x${string}` {
  if (typeof value !== 'string' || !ADDR_RE.test(value)) {
    throw new TypeError(
      `buildPresentation: ${what} должен быть адресом 0x + 40 hex (получено ` +
      `${typeof value === 'string' ? `«${value}»` : typeof value})`,
    );
  }
  return value.toLowerCase() as `0x${string}`;
}

/** Ключ печати: ровно 32 байта. Не 32 — это НАШ мусор, а не состояние спора,
 *  поэтому громко (та же развилка, что в `openSealed`, `chatCrypto.ts:197-205`). */
function assertBoxKeyBytes(bytes: unknown, what: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== BOX_KEY_LEN) {
    throw new TypeError(
      `buildPresentation: ${what} должен быть Uint8Array ровно ${BOX_KEY_LEN} байт ` +
      `(получено ${bytes instanceof Uint8Array ? `${bytes.length} байт` : typeof bytes})`,
    );
  }
  return bytes;
}

function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (const b of bytes) acc |= b;
  return acc === 0;
}

function hex32(bytes: Uint8Array): string {
  return '0x' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Единственная законная точка перехода «ключ арбитра из цепи → байты печати».
 * `sealForRecipient` принимает любой `Uint8Array`, то есть теряет клеймо типа,
 * ради которого `BoxKey`/`SignKey` и заведены (перестановка box/sign в реальном
 * вызове дала 0 красных из 1826 — `arbiterChatKey.ts:28-42`). Через эту функцию
 * подставить ключ ПОДПИСИ вместо ключа печати уже не скомпилируется.
 *
 * Нулевой ключ здесь НЕ отвергается: «в цепи ключа нет» — законное состояние,
 * и решает его `buildPresentation` отказом `arbiter_has_no_key`, а не броском.
 */
export function arbiterBoxKeyBytes(key: BoxKey): Uint8Array {
  if (typeof key !== 'string' || !KEY_HEX_RE.test(key)) {
    throw new TypeError(`arbiterBoxKeyBytes: ожидался 0x + 64 hex (получено ${String(key)})`);
  }
  const out = new Uint8Array(BOX_KEY_LEN);
  for (let i = 0; i < BOX_KEY_LEN; i++) out[i] = parseInt(key.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

/* ─────────────────────────── base64 ─────────────────────────── */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Своя реализация НАМЕРЕННО: `Buffer` в браузере нет, а `btoa` требует
 * посимвольной строки — на кадре в 200 КБ `String.fromCharCode(...bytes)`
 * упирается в предел числа аргументов. Плюс разбор ниже обязан быть придирчивым:
 * контейнер приходит от недруга.
 */
export function b64FromBytes(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('b64FromBytes: ожидается Uint8Array');
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

/** `null` — «это не base64». Ни одного снисхождения: мусор не должен
 *  превращаться в полупустой массив, который потом выдадут за доказательство. */
export function bytesFromB64(text: string): Uint8Array | null {
  if (typeof text !== 'string' || text.length % 4 !== 0) return null;
  const clean = text.replace(/=+$/, '');
  if (clean.length % 4 === 1) return null;
  if (/[^A-Za-z0-9+/]/.test(clean)) return null;
  const out = new Uint8Array((clean.length * 3) >> 2);
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | B64.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return o === out.length ? out : null;
}

/* ─────────────────────── канонический вид ─────────────────────── */

function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Байты, которые подписывает предъявитель.
 *
 * ФОРМА: доменная метка, затем поля СТРОГО В ЭТОМ ПОРЯДКЕ, каждое —
 * `<длина в байтах>:<байты UTF-8>` (нетстринг). Разделителя нет вовсе, поэтому
 * подставить в поле его подобие невозможно: длина названа впереди. Порядок полей
 * задан кодом этой функции, а НЕ порядком ключей объекта — `JSON.stringify`
 * зависит от порядка вставки, и два честных клиента дали бы разные байты.
 *
 * ЧТО ВХОДИТ: род, dealId, предъявитель, время выдачи, все заверения целиком,
 * все цепочки с якорями и пометкой источника якоря, все кадры (base64), все
 * печати ключей, ТРИ ОБЪЯВЛЕННЫХ ЧИСЛА и весь список «подготовить не удалось».
 * Байтовые поля входят в том же base64, в каком уезжают: перекодировать их здесь
 * значило бы завести вторую кодировку и разойтись с Задачей 6 молча (исправление 2).
 *
 * ЧТО НЕ ВХОДИТ: только сама подпись. Числа входят намеренно: без них посредник
 * перепишет «скрыто: 0», и подпись сойдётся.
 *
 * Отсутствующий `expectedLastHash` кодируется пустой строкой — отпечаток никогда
 * не бывает пустым, поэтому это однозначно.
 */
export function canonicalPresentationBytes(c: UnsignedPresentation): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const put = (text: string): void => {
    const body = enc.encode(text);
    parts.push(enc.encode(`${body.length}:`), body);
  };
  const putNum = (n: number): void => {
    if (!Number.isSafeInteger(n)) {
      throw new TypeError(`canonicalPresentationBytes: ожидалось безопасное целое, получено ${String(n)}`);
    }
    put(String(n));
  };

  put(PRESENTATION_SIG_DOMAIN);
  put(c.kind);
  put(c.dealId);
  put(c.presenter);
  putNum(c.issuedAt);

  putNum(c.attestations.length);
  for (const a of c.attestations) {
    put(a.address); put(a.boxKey); put(a.signKey); putNum(a.issuedAt); put(a.signature);
  }

  putNum(c.chains.length);
  for (const ch of c.chains) {
    put(ch.sender);
    put(ch.anchorSource);
    putNum(ch.anchor.expectedMessageCount);
    put(ch.anchor.expectedLastHash ?? '');
    putNum(ch.links.length);
    for (const l of ch.links) {
      putNum(l.seq); put(l.prevHash); put(l.bodyHash); put(l.sender); putNum(l.sentAt);
    }
  }

  putNum(c.frames.length);
  for (const f of c.frames) { putNum(f.seq); put(f.sender); put(f.frame); }

  putNum(c.keys.length);
  for (const k of c.keys) { putNum(k.seq); put(k.sender); put(k.forArbiter); put(k.forPeer); }

  putNum(c.counts.read); putNum(c.counts.hidden); putNum(c.counts.notPrepared);

  putNum(c.notPrepared.length);
  for (const n of c.notPrepared) { putNum(n.seq); put(n.sender); put(n.reason); }

  return joinBytes(parts);
}

/* ───────────────────── оценка размера ДО крипто ───────────────────── */

/** Верхние границы разметки JSON на одну запись. Считаны по самым длинным
 *  возможным значениям (номер 4294967295, адрес 42, отпечаток 66, печать 108
 *  знаков base64) и округлены вверх; точные значения — 83 / 316 / 259. */
const PER_FRAME_JSON = 96;
const PER_KEY_JSON = 340;
const PER_LINK_JSON = 300;
const PER_MESSAGE_JSON = PER_FRAME_JSON + PER_KEY_JSON + PER_LINK_JSON;   // 736
const PER_ATTESTATION_JSON = 420;
const PER_CHAIN_JSON = 256;
const PER_NOT_PREPARED_JSON = 96;
const FIXED_JSON = 1024;

/** Длина base64 без округлений: ровно `ceil(n/3)*4`. */
function b64Len(n: number): number {
  return Math.ceil(n / 3) * 4;
}

/* ─────────────────────────── сборка ─────────────────────────── */

interface Candidate {
  seq: number;
  sender: `0x${string}`;
  link: ChainLink;
  signature: Uint8Array;
  signerPublicKey: Uint8Array;
  envelope: Uint8Array;
  /** Байты кадра С УСТРОЙСТВА, не пересобранные. Подпись накрывает именно их. */
  frame: Uint8Array;
}

export async function buildPresentation(
  input: BuildPresentationInput,
): Promise<{ ok: true; container: PresentationContainer } | PresentationRefusal> {
  const dealId = lowerAddr(input?.dealId, 'dealId (адрес агримента)');
  const presenter = lowerAddr(input?.presenter, 'адрес предъявителя');
  // `peer` — ОБЯЗАТЕЛЬНОЕ поле договора (исправление 6). Никакого вывода второй
  // стороны «из заверения или из выбора» больше нет: он молча не работал ровно в
  // случае «показываю только своё».
  const peer = lowerAddr(input?.peer, 'адрес второй стороны');
  if (peer === presenter) {
    throw new TypeError('buildPresentation: вторая сторона совпала с предъявителем');
  }
  const arbiterBoxKey = assertBoxKeyBytes(input?.arbiterBoxKey, 'ключ печати арбитра');
  const peerBoxKey = assertBoxKeyBytes(input?.peerBoxKey, 'ключ печати второй стороны');

  // ⚠️ СНАЧАЛА ПРО МИР, потом про действия человека. Оба ключа могут отсутствовать
  // законно, и оба случая — ОТКАЗ С ИМЕНЕМ, а не бросок и не печать на нули:
  //  • нет ключа арбитра (§15.7) — контейнер не откроет никто; предъявитель увидит
  //    «сдано», арбитр — пустоту, и молчание истолкуют против предъявителя;
  //  • нет ключа второй стороны (исправление 6) — `forPeer` обязателен по типу, и
  //    печать на нулевой ключ выглядит как ключ, не открываясь ничем: §7 замысла
  //    («вторая сторона видит, ЧТО предъявили») тогда молча не достроить никогда.
  // Раньше выбора — потому что советовать «выберите сообщения» тут бесполезно.
  if (isAllZero(arbiterBoxKey)) return { ok: false, reason: 'arbiter_has_no_key' };
  if (isAllZero(peerBoxKey)) return { ok: false, reason: 'peer_has_no_key' };

  // Сеанс. Сюда же — согласие заверения с сеансом: контейнер подписывается ключом
  // подписи предъявителя, и если заверение накрывает ДРУГИЕ ключи или другой
  // адрес, арбитр обязан будет пометить всё непроверенным (§15.2). Отказать
  // раньше честнее, чем отдать предъявление, которое ничего не доказывает.
  const session = input?.session;
  const signer = (session && typeof session === 'object'
    && session.keypair?.privateKey instanceof Uint8Array
    && session.keypair.privateKey.length === 32
    && session.keypair.publicKey instanceof Uint8Array
    && session.keypair.publicKey.length === 32
    && typeof session.address === 'string'
    && ADDR_RE.test(session.address)
    && session.address.toLowerCase() === presenter)
    ? await deriveLinkSigningKeypair(session.keypair)
    : null;
  if (!signer) return { ok: false, reason: 'no_session' };

  const att = input?.ownAttestation;
  if (!att || typeof att !== 'object'
    || typeof att.address !== 'string' || att.address.toLowerCase() !== presenter
    || typeof att.boxKey !== 'string' || att.boxKey.toLowerCase() !== hex32(session.keypair.publicKey)
    || typeof att.signKey !== 'string' || att.signKey.toLowerCase() !== hex32(signer.publicKey)
    // ⚠️ Клиент цепи ПРОБРАСЫВАЕТСЯ (исправление 5). Без него заверение
    // развёрнутого умного кошелька получает `malformed` всегда, то есть Safe-хозяин
    // не может предъявить переписку вовсе. Отдельный вердикт `absent` — «заверения
    // нет» — тоже не годен: контейнер, подписанный ключом, который не связан с
    // адресом, ничего не доказывает (§15.2), и отдавать его человеку как «сдано»
    // хуже, чем отказать сразу.
    || await verifyChatKeyAttestation(att, input.publicClient) !== 'ok') {
    return { ok: false, reason: 'no_session' };
  }

  // Выбор. Мусор в записи выбора — наш баг (её собирает наш же интерфейс), и
  // проглотить его значило бы предъявить не то, что человек отметил.
  if (!Array.isArray(input?.selected)) return { ok: false, reason: 'nothing_selected' };
  const wanted = new Map<string, { seq: number; sender: `0x${string}` }>();
  for (const s of input.selected) {
    if (!s || typeof s !== 'object' || !Number.isSafeInteger(s.seq) || s.seq < 0) {
      throw new TypeError(`buildPresentation: в выборе негодный номер (${JSON.stringify(s)})`);
    }
    const sender = lowerAddr(s.sender, 'отправитель в выборе');
    wanted.set(`${sender}#${s.seq}`, { seq: s.seq, sender });
  }
  if (wanted.size === 0) return { ok: false, reason: 'nothing_selected' };

  const rank = (sender: `0x${string}`): number => (sender === presenter ? 0 : sender === peer ? 1 : 2);
  const inOrder = <T extends { seq: number; sender: `0x${string}` }>(rows: T[]): T[] =>
    [...rows].sort((a, b) => rank(a.sender) - rank(b.sender) || a.seq - b.seq);

  /* ── своя копия переписки: РАЗБИРАЕМ БАЙТЫ, полям записи не верим ── */

  const archived = await readConversationArchive(presenter, peer);
  const byId = new Map<string, Candidate>();
  for (const row of archived) {
    let d: SignedLinkFrame | null;
    try { d = decodeFrame(row.frame); } catch { d = null; }
    if (!d) continue;
    // ⚠️ НОМЕР И ВРЕМЯ БЕРУТСЯ ИЗ БАЙТОВ. У чужих кадров запись архива несёт
    // `seq: 0` и `sentAt = uploadedAt` (`usePairChat.ts:930-937`): кадр
    // архивируется не разбираясь. Отбор по полю записи нашёл бы одно чужое
    // сообщение из сорока, и половина предъявления пропала бы молча.
    const sender = d.link.sender.toLowerCase() as `0x${string}`;
    const id = `${sender}#${d.link.seq}`;
    if (byId.has(id)) continue;      // два экземпляра одного номера: берём первый
    byId.set(id, {
      seq: d.link.seq, sender,
      link: { ...d.link, sender },
      signature: d.signature, signerPublicKey: d.signerPublicKey,
      envelope: d.envelope,
      frame: row.frame,
    });
  }

  const notPrepared: { seq: number; sender: `0x${string}`; reason: NotPreparedReason }[] = [];
  const candidates: Candidate[] = [];
  for (const w of inOrder([...wanted.values()])) {
    if (w.sender !== presenter && w.sender !== peer) {
      notPrepared.push({ ...w, reason: 'not_in_conversation' });
      continue;
    }
    const hit = byId.get(`${w.sender}#${w.seq}`);
    if (!hit) { notPrepared.push({ ...w, reason: 'not_in_archive' }); continue; }
    candidates.push(hit);
  }

  /* ── потолок: ДО единой крипто-операции ── */

  const limitBytes = PRESENTATION_MAX_BYTES - PRESENTATION_SEAL_OVERHEAD;
  const fixed = FIXED_JSON
    + PER_ATTESTATION_JSON * (1 + (input.peerAttestation ? 1 : 0))
    + PER_CHAIN_JSON * 2
    + PER_NOT_PREPARED_JSON * notPrepared.length;
  let acc = fixed;
  let fits = 0;
  let estimated = fixed;
  for (const c of candidates) {
    const cost = b64Len(c.frame.length) + PER_MESSAGE_JSON;
    estimated += cost;
    if (acc + cost <= limitBytes) { acc += cost; fits++; }
  }
  if (fits < candidates.length) {
    // Число влезающих кадров — единственное, что делает этот отказ выполнимым:
    // «слишком много» без числа человек может только угадывать.
    return { ok: false, reason: 'too_large', fits, estimatedBytes: estimated, limitBytes };
  }

  /* ── крипто ── */

  // libsodium в проекте только динамический (`chatCrypto.ts:86-88`, ~147 КБ gzip
  // мимо общего чанка). Будим его ЗДЕСЬ И РАДИ СВОЕГО — ниже мы сами зовём
  // `crypto_sign_detached` для подписи контейнера. Договорным `recoverOneTimeKey`
  // и `verifyFrameEvidence` этот прогрев больше не нужен: они асинхронны и ждут
  // готовности сами (исправления 1 и 4). Прогрев `readyFrameVerifier()` не зовём
  // ни разу — он остался для `receiveBags` и условием работы не является.
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;

  const frames: PresentationContainer['frames'] = [];
  const keys: SealedOneTimeKey[] = [];
  for (const c of candidates) {
    // 1. То, что арбитр гарантированно назовёт подделкой, предъявителю
    //    предъявлять незачем: архив хранит кадры НЕ РАЗБИРАЯ (движок
    //    архивирует до проверки), и чужой мусор попал бы в предъявление как
    //    его собственная ложь.
    // ⚠️ `await` НЕСУЩИЙ: у обещания `.ok` — `undefined`, то есть без него всё
    //    подряд уезжало бы в «не подготовлено» с причиной `undefined`.
    const evidence = await verifyFrameEvidence(c.frame, c.link, c.signature, c.signerPublicKey);
    if (!evidence.ok) {
      notPrepared.push({ seq: c.seq, sender: c.sender, reason: evidence.reason });
      continue;
    }
    // 2. Разовый ключ. `null` — кадр до смены ключа или беда `undecryptable`:
    //    §15.5, отдельным списком, НЕ в «скрыто». ⚠️ И здесь `await` несущий:
    //    обещание правдиво всегда, `if (!key)` не сработает никогда, и негодный
    //    ключ уехал бы дальше как годный.
    const key = await recoverOneTimeKey(c.envelope, session.keypair);
    if (!key) {
      notPrepared.push({ seq: c.seq, sender: c.sender, reason: 'undecryptable' });
      continue;
    }
    // 3. ДЕЙСТВИЕ, А НЕ ОБЕЩАНИЕ: сообщение вскрывается ТЕМ САМЫМ ключом,
    //    который сейчас будет запечатан. Содержимое немедленно выбрасывается —
    //    в контейнер не попадает ни байта открытого текста. Без этого шага в
    //    «прочитано» уехал бы кадр, который у арбитра не откроется, и §15.4
    //    сработал бы наоборот: его поломкой сочли бы наше упущение.
    const opened = await openEnvelopeWithOneTimeKey(c.envelope, key, c.sender);
    if (!opened.ok) {
      notPrepared.push({ seq: c.seq, sender: c.sender, reason: opened.reason });
      continue;
    }
    // 4. Печать на ДВОИХ (§15.6).
    let forArbiter: string;
    let forPeer: string;
    try {
      forArbiter = b64FromBytes(await sealForRecipient(arbiterBoxKey, key));
      forPeer = b64FromBytes(await sealForRecipient(peerBoxKey, key));
    } catch {
      notPrepared.push({ seq: c.seq, sender: c.sender, reason: 'seal_failed' });
      continue;
    }
    frames.push({ seq: c.seq, sender: c.sender, frame: b64FromBytes(c.frame) });
    keys.push({ seq: c.seq, sender: c.sender, forArbiter, forPeer });
  }

  /* ── якоря ПО ОТПРАВИТЕЛЮ (§15.3) ── */

  const maxSeqOf = (sender: `0x${string}`): number => {
    let max = -1;
    for (const c of byId.values()) if (c.sender === sender && c.seq > max) max = c.seq;
    return max;
  };
  const maxOwnSeq = maxSeqOf(presenter);

  let head: ConversationHead | null = null;
  try {
    head = await readConversationHead(presenter, peer);
  } catch {
    // `head_read_failed` — хранилище отказало. Это НЕ «своих сообщений не было»:
    // объявить 0 значило бы обвинить себя в подделке первым же показанным номером.
    head = null;
  }

  // `own_head` только когда голова ПОКРЫВАЕТ то, что на руках. Мешок мог уйти, а
  // номер не лечь на диск (`SentMessage.persisted: false`) — тогда голова
  // отстала, и якорь из неё даёт `broken`, то есть обвинение в ПОДДЕЛКЕ.
  const headCovers = head !== null
    && head.link.sender.toLowerCase() === presenter
    && head.link.seq >= maxOwnSeq;
  // ⚠️ ПОРЯДОК ЗВЕНЬЕВ ПРИХОДИТ ИЗ ОДНОГО МЕСТА — `inOrder` выше, до крипто.
  // Второй сортировки здесь НЕТ НАМЕРЕННО: она замаскировала бы пропажу первой,
  // и замок на «несортированный вход даёт `unordered`, то есть обвинение в
  // подделке за порядок кнопок» перестал бы что-либо мерить.
  //
  // ⚠️ ЗВЕНЬЯ БЕРУТСЯ ИЗ `candidates`, А НЕ ИЗ ПОКАЗАННЫХ (раскладка §15.5,
  // исправление 8). Звено кадра, который сам предъявитель не читает, В ЦЕПОЧКЕ
  // ОСТАЁТСЯ — не кладётся только сам кадр. Причины две, обе несущие: цепочка
  // остаётся сплошной (иначе `verifyChain` отдаст лишний `gap`, то есть обвинит в
  // утаивании того, что человек назвал вслух отдельным списком), и «скрыто»
  // вычитает такое сообщение ровно один раз, отчего суммы сходятся.
  const linksOf = (sender: `0x${string}`): ChainLink[] =>
    candidates.filter(c => c.sender === sender).map(c => c.link);

  const ownChain: PerSenderChain = headCovers
    ? {
      sender: presenter,
      links: linksOf(presenter),
      // ⚠️ «последний номер + 1», а НЕ число сообщений: сгоревшие номера
      // (`listBurnedSeqs`) разводят эти величины, и «честные 39» дали бы
      // `broken, atSeq: 39` — обвинение себя же (`chatChain.ts:365`, `:456`).
      anchor: { expectedMessageCount: head!.link.seq + 1, expectedLastHash: linkHash(head!.link) },
      anchorSource: 'own_head',
    }
    : {
      sender: presenter,
      links: linksOf(presenter),
      anchor: { expectedMessageCount: maxOwnSeq + 1 },
      anchorSource: 'as_received_by_presenter',
    };

  const peerChain: PerSenderChain = {
    sender: peer,
    links: linksOf(peer),
    // ⚠️ ОТПЕЧАТКА ХВОСТА ЗДЕСЬ НЕТ НАМЕРЕННО. Единственное, что он делает, —
    // позволяет `unverifiedContentAtSeq` схлопнуться в `[]`, то есть сказать
    // «проверено». Схлопывать его отпечатком, который принёс тот же, кто принёс
    // звенья, — та самая молчаливая ложь из §15.2 (`chatChain.ts:153-159`).
    // Настоящий якорь чужой цепочки приносит 4г, от второй стороны.
    anchor: { expectedMessageCount: maxSeqOf(peer) + 1 },
    anchorSource: 'as_received_by_presenter',
  };

  /* ── три объявленных числа ── */

  // ⚠️ ВЫЧЕТ РОВНО ОДИН. Звенья неподготовленных кадров уже лежат в `links`
  // (раскладка §15.5), поэтому вычитать их ещё раз — занизить «скрыто» на их
  // число: на стенде вместо 3 + 2 + 1 = 6 вышло бы 5, то есть арбитру объявили бы
  // переписку короче, чем она была.
  const hiddenIn = (chain: PerSenderChain): number =>
    Math.max(0, chain.anchor.expectedMessageCount - chain.links.length);
  const counts: DeclaredCounts = {
    read: frames.length,
    hidden: hiddenIn(ownChain) + hiddenIn(peerChain),
    notPrepared: notPrepared.length,
  };
  // ⚠️ Поля `unopened` здесь нет, и дописать его нельзя: `DeclaredCounts` его не
  // знает, а тип-замок `DECLARED_COUNTS_CARRY_NO_UNOPENED` краснеет у компилятора.
  // Что не открылось у арбитра — считает арбитр (§15.4).
  //
  // ⚠️ Названное вслух исключение: у неподготовленных с причинами `not_in_archive`
  // и `not_in_conversation` звена НЕТ ФИЗИЧЕСКИ (кадра нет на устройстве), поэтому
  // такое сообщение попадает и в «скрыто», и в список «не подготовлено», и сумма
  // превышает переписку ровно на их число. Это честнее обратного: человек заявил
  // показать, показывать нечего, и оба факта арбитру видны.

  /* ── подпись над каноническим видом (§15.1) ── */

  const now = typeof input.now === 'function' ? input.now : () => Date.now();
  const unsigned: UnsignedPresentation = {
    kind: PRESENTATION_KIND,
    dealId,
    presenter,
    // Заверения кладутся ДОСЛОВНО, ни одно поле не приводится и не правится:
    // любая правка рвёт подпись кошелька, а её проверяет арбитр сам.
    attestations: input.peerAttestation ? [att, input.peerAttestation] : [att],
    chains: [ownChain, peerChain],
    frames,
    keys,
    counts,
    notPrepared: inOrder(notPrepared),
    issuedAt: now(),
  };
  const signature = b64FromBytes(
    sodium.crypto_sign_detached(canonicalPresentationBytes(unsigned), signer.privateKey),
  );
  const container: PresentationContainer = { ...unsigned, signature };

  // Последняя сверка ПО БАЙТАМ ТОГО, ЧТО УЙДЁТ НАРУЖУ. Оценка выше — верхняя
  // граница, и сработать это не должно никогда; если сработало — граница
  // перестала быть верхней, и увидеть это надо отказом здесь, а не отказом
  // склада 413 у человека посреди спора.
  const realBytes = new TextEncoder().encode(JSON.stringify(container)).length;
  if (realBytes > limitBytes) {
    return { ok: false, reason: 'too_large', fits: Math.max(0, fits - 1), estimatedBytes: realBytes, limitBytes };
  }

  return { ok: true, container };
}
