/**
 * presentationRead.ts — ЧИТАЛКА ПРЕДЪЯВЛЕНИЯ на стороне арбитра.
 *
 * Принимает контейнер (что угодно, `unknown` — он приехал с нашего же склада, а
 * складу мы не верим) и отдаёт выдачу, в которой НИЧТО не молчит: у каждого
 * сообщения стоит вердикт заверения, вердикт кадра и, если открыть не удалось,
 * названная причина. Это прямое требование замысла §15.2: молчаливое
 * «проверено» — ровно та ложь, которую проект называет главным классом промаха.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И НЕ ДОЛЖНО БЫТЬ:
 *
 * 1. Своей копии проверки кадра. Она вынесена из `receiveBags` Задачей 4
 *    (`verifyFrameEvidence`) — две проверки одного и того же расходятся молча.
 *    Прогрев (`readyFrameVerifier`) здесь не зовётся: проверка ждёт готовности
 *    внутри себя, и требование «сначала прогрей» держит ФОРМА, а не памятка.
 * 2. Своей расшифровки. `openEnvelopeWithOneTimeKey` (Задача 2) живёт внутри
 *    `chatEnvelope.ts`, потому что смещения слотов (1, 81, 161, 173) закрыты в
 *    модуле, и дублировать их снаружи — тот самый класс дефекта, против которого
 *    в проекте стоят гейты раскладки.
 * 3. Чтения `container.counts`. Форма проверяется, ЗНАЧЕНИЯ — никогда (§15.4).
 * 4. Второй пары ключей. Арбитр вскрывает только `forArbiter` и только своей
 *    парой; `forPeer` лежит в контейнере для §7 (Задача 4в-2) и здесь не
 *    трогается вовсе.
 * 5. Своей редактуры содержимого И своего вычисления признака «ключ вложения
 *    лежал открытым». `redactPayload` (Задача 3) отдаёт `Redaction` — ОБА
 *    значения сразу: две редактуры одного и того же расходятся молча, и
 *    расходятся ровно в ту сторону, где ключ вложения уезжает арбитру. Свой
 *    подсчёт признака был пятнадцатым случаем класса: черновик считал его сам, а
 *    возврат объявлял неверным типом — то есть не собирался вовсе.
 * 6. Своего разбора base64. `bytesFromB64` берётся из Задачи 5 — чужая кодировка
 *    не падает, а тихо даёт другие байты (четырнадцатый случай класса: одна
 *    задача писала base64, другая читала hex, обе зелёные).
 * 7. Своих потолков предъявления. `PRESENTATION_KIND`, `PRESENTATION_MAX_BYTES`,
 *    `PRESENTATION_SEAL_OVERHEAD` объявлены только в `presentation.ts`; здесь их
 *    импортируют. `fittingMessageCount` не пересчитывается вовсе.
 * 8. Своей сверки заверенных ключей. «Заверены ли ИМЕННО те ключи, которыми
 *    назван кадр» спрашивается у `verifyChatKeyAttestationForKeys` (Задача 1) —
 *    единственного источника вердикта `wrong_keys`. Сверять байты руками договор
 *    запрещает, и запрет не декоративен: без этого вызова одно из семи значений
 *    вердикта недостижимо ни одним путём, а цепочка, сочинённая предъявителем за
 *    собеседника свежей парой, приезжает с `attestation: 'ok'`.
 *
 * ⚠️ ПОЧЕМУ НЕГОДНАЯ ПОДПИСЬ КОНТЕЙНЕРА НЕ СТИРАЕТ ВЕРДИКТЫ. Подпись не сошлась
 * — значит неизвестно, КТО предъявил, и содержимое могло быть сочинено целиком:
 * ни одного слова наружу. Но вердикты кадров и заверений САМОПРОВЕРЯЕМЫ и от
 * подписи контейнера не зависят вовсе — прятать их значило бы прятать улику
 * против самого подделывателя. Поэтому `bad_signature` отдаёт заполненные
 * `messages` без содержимого, а вскрытие управляется отдельным `mayOpen`.
 *
 * ⚠️ ПОЧЕМУ КЛЮЧ ПОДПИСИ БЕРЁТСЯ ИЗ ЗАВЕРЕНИЯ, А НЕ ИЗ КАДРА. Шапка
 * `chatConversation.ts:905-909` признаёт дословно: «пересобрали всю цепочку своим
 * ключом, вписав другое содержимое, — ok: true». Проверка кадра его собственным
 * подписным ключом проверяет кадр самим собой. Единственное, что связывает
 * подписной ключ с адресом человека, — заверение кошельком (Задача 1). Поэтому
 * четвёртым аргументом `verifyFrameEvidence` идёт ЗАВЕРЕННЫЙ ключ. Если годного
 * заверения нет — ключ берётся из кадра, но сообщение НЕСЁТ `attestation !== 'ok'`,
 * и арбитр видит это прямым текстом.
 */
import type { PublicClient } from 'viem';
import { openSealed, type ChatKeypair } from './chatCrypto';
import {
  openEnvelopeWithOneTimeKey,
  toOneTimeKey,
  MAX_ENVELOPE_BYTES,
  type OpenFailure,
} from './chatEnvelope';
import {
  verifyChatKeyAttestation,
  verifyChatKeyAttestationForKeys,
  type AttestationVerdict,
  type ChatKeyAttestation,
} from './chatKeyAttestation';
import {
  decodeFrame,
  verifyFrameEvidence,
  FRAME_HEADER_LEN,
  MAX_ARCHIVED_FRAMES_PER_PAIR,
  type FrameVerdict,
} from './chatConversation';
import { verifyChain, type ChainLink, type ChainVerdict } from './chatChain';
import {
  canonicalPresentationBytes,
  bytesFromB64,
  PRESENTATION_KIND,
  PRESENTATION_MAX_BYTES,
  PRESENTATION_SEAL_OVERHEAD,
  type MeasuredCounts,
  type PerSenderChain,
  type PresentationContainer,
  type SealedOneTimeKey,
} from './presentation';
// ⚠️ `redactPayload` отдаёт `Redaction` — содержимое И признак старой формы.
// Своего `ChatPayload` этому файлу больше не нужно: он не считает по содержимому
// ничего (см. «чего здесь нет», п.5).
import { redactPayload, type RedactedFilePayload, type RedactedPayload } from './chatPayloadForm';

export interface PresentedMessage {
  seq: number;
  sender: `0x${string}`;
  state: 'read' | 'unopened';
  /** Почему не открылось. ОТСУТСТВУЕТ, когда беда в кадре, а не в ключе, и когда
   *  вскрывать не пробовали вовсе (негодная подпись контейнера): подставить сюда
   *  правдоподобную причину значило бы соврать о месте отказа. */
  reason?: OpenFailure;
  payload?: RedactedPayload;
  /** §15.2: никогда не молчит. `absent` — «этой стороны в заверениях нет вовсе»,
   *  и это НЕ то же, что `malformed` (мусор на месте заверения): арбитр решает по
   *  этим двум по-разному.
   *
   *  ⚠️ ВЕРДИКТ У СООБЩЕНИЯ, А НЕ У СТОРОНЫ. До разбора кадра здесь стоит вердикт
   *  стороны; после — ответ на более узкий вопрос: «заверены ли ИМЕННО те ключи,
   *  которыми назван ЭТОТ кадр». Отвечает `verifyChatKeyAttestationForKeys`
   *  (Задача 1), и `wrong_keys` приходит только оттуда — своей сверки ключей здесь
   *  нет ни строки. Без этого вопроса цепочка, сочинённая предъявителем за
   *  собеседника свежей парой Ed25519, доезжала бы до арбитра с `ok`. */
  attestation: AttestationVerdict;
  frame: FrameVerdict;
  /** «У этого вложения ключ лежал в содержимом ОТКРЫТЫМ» (старая форма
   *  `keyHex`/`ivHex`). Поле ОБЯЗАТЕЛЬНОЕ, а не `?`, ровно потому, что забыть его
   *  нельзя: оговорка §5 («защита только у сообщений после правки формы») иначе
   *  остаётся в документации и до арбитра не доходит. У непрочитанного — `false`:
   *  не открыли, значит не знаем, и врать «защищено» нельзя.
   *
   *  ⚠️ СЧИТАЕТСЯ НЕ ЗДЕСЬ: приезжает вторым полем `Redaction` из `redactPayload`
   *  (Задача 3) — тем же вызовом, что редактирует содержимое. Свой подсчёт
   *  расходился бы с редактурой молча. */
  legacyAttachmentExposed: boolean;
}

export interface PresentationView {
  container: 'ok' | 'bad_signature' | 'malformed';
  /** ЗАЯВЛЕНО контейнером, ничем здесь не подтверждается (см. «НЕ делает»).
   *  Есть, когда форма прошла; при `malformed` заявлять нечему. */
  dealId?: `0x${string}`;
  presenter?: `0x${string}`;
  issuedAt?: number;
  messages: PresentedMessage[];
  counts: MeasuredCounts;
  /** §15.5 требует список С ПРИЧИНОЙ, а не число: иначе предъявитель наказан
   *  молчанием за поломку склада (против §11). При негодной подписи контейнера
   *  список пуст — свободный текст неизвестного автора наружу не идёт, — а число
   *  в `counts.notPrepared` остаётся, чтобы суммы сходились. */
  notPrepared: { seq: number; sender: `0x${string}`; reason: string }[];
  perSender: {
    sender: `0x${string}`;
    verdict: ChainVerdict;
    /** §15.3: якорь чужой цепочки — это «столько, сколько дошло до
     *  предъявителя», и никогда не истина. Признак доезжает до арбитра как есть. */
    anchorSource: PerSenderChain['anchorSource'];
  }[];
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * ⚠️ ВСЕ байтовые поля контейнера — base64 БЕЗ `0x` (договор v2). Проверяется
 * ДЛИНА строки, а не алфавит: hex-строка тех же байтов — годный base64 (все её
 * знаки в алфавите), она не падает на разборе, а тихо даёт другие байты. Гейт
 * длины превращает чужую кодировку в названный `malformed` вместо правдоподобного
 * «ключ не подошёл».
 *
 * 32 — длина разового ключа; здесь она нужна только чтобы посчитать длину МЕШКА.
 * Настоящий гейт длины ключа — `toOneTimeKey` (Задача 2), число не переписывается.
 */
const ONE_TIME_KEY_BYTES = 32;
const SEALED_KEY_BYTES = ONE_TIME_KEY_BYTES + PRESENTATION_SEAL_OVERHEAD;   // 32 + 48 = 80
const ED25519_SIG_BYTES = 64;
const b64Len = (bytes: number): number => Math.ceil(bytes / 3) * 4;
const SEALED_KEY_B64_LEN = b64Len(SEALED_KEY_BYTES);     // 108
const CONTAINER_SIG_B64_LEN = b64Len(ED25519_SIG_BYTES); // 88

/**
 * Потолок звеньев на отправителя. ВЫВЕДЕН из настоящего потолка своей копии
 * переписки (`MAX_ARCHIVED_FRAMES_PER_PAIR`), а не выдуман: больше, чем лежит на
 * устройстве, предъявить нельзя. Держит стоимость разбора враждебного контейнера
 * ограниченной сверху.
 */
export const MAX_PRESENTED_LINKS = MAX_ARCHIVED_FRAMES_PER_PAIR;

/**
 * Цепочек ровно столько, сколько сторон в переписке по сделке, — две
 * (`conversationId` = `own|peer`, `chatConversation.ts:600-602`). Названо вслух:
 * если в чате когда-нибудь появятся группы, этот потолок обязан переехать вместе
 * с ними, а не тихо отвергать законный контейнер.
 */
export const MAX_PRESENTED_CHAINS = 2;

/**
 * Кадр = заголовок 193 + конверт, конверт не толще потолка склада. Плюс: ни один
 * кадр не может быть толще всего предъявления, в котором он лежит, — а потолок
 * предъявления объявлен Задачей 5 и здесь не переобъявляется.
 */
const MAX_FRAME_BYTES = Math.min(FRAME_HEADER_LEN + MAX_ENVELOPE_BYTES, PRESENTATION_MAX_BYTES); // 262 144
const MAX_REASON_LEN = 200;

/**
 * ⚠️ ЗАМОК КОМПИЛЯТОРА, А НЕ ПОВЕДЕНИЯ. Краснеет `npm run type-check`, если в
 * `RedactedFilePayload` (Задача 3) появится хоть одно поле ключа или адреса
 * файла: тогда `Extract<...>` перестанет быть `never`, и присваивание не
 * скомпилируется.
 *
 * Живёт в БОЕВОМ файле намеренно: тестовые файлы исключены из программы tsc
 * (`frontend/tsconfig.json:exclude`), замерено — заведомая ошибка типов в
 * `*.test.ts` даёт `npm run type-check` → выход 0 и ни одной диагностики. Такой
 * же замок в тесте сторожил бы ровно ничего.
 */
type ForbiddenInRedacted = 'keyHex' | 'ivHex' | 'sealedKey' | 'url' | 'fileKey' | 'chunkCount' | 'chunkSize';
type RedactedCarriesNoKey = Extract<keyof RedactedFilePayload, ForbiddenInRedacted> extends never ? true : never;
export const REDACTED_CARRIES_NO_KEY: RedactedCarriesNoKey = true;

const NOTHING: MeasuredCounts = { read: 0, unopened: 0, hidden: 0, notPrepared: 0 };

/**
 * Отказ бывает только ОДИН — «это не контейнер предъявления». `bad_signature`
 * отказом больше не является: у него есть заполненные `messages` с настоящими
 * вердиктами и без содержимого (см. шапку файла). Поэтому и функция здесь одна:
 * второй вход для `bad_signature` был бы приглашением случайно вернуть пустоту.
 */
function malformed(): PresentationView {
  return { container: 'malformed', messages: [], counts: { ...NOTHING }, notPrepared: [], perSender: [] };
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function lower(v: string): `0x${string}` {
  return v.toLowerCase() as `0x${string}`;
}

/**
 * Только для строк, уже прошедших один из hex-гейтов выше. Hex в этом файле
 * остаётся РОВНО в одном месте — поля заверения (`boxKey`/`signKey`, форма
 * Задачи 1, `0x` + 64 hex). Всё, что приходит от Задачи 5, — base64.
 */
function hexToBytes(value: string): Uint8Array {
  const body = value.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Обратное `hexToBytes`: ключ, НАЗВАННЫЙ кадром, — в ту же форму, в какой ключи
 * стоят в заверении (`0x` + 64 строчных hex, форма Задачи 1).
 *
 * Нужна ровно затем, чтобы подать ожидаемый ключ в
 * `verifyChatKeyAttestationForKeys`. Сравнивать байты здесь самим запрещено
 * договором: местная сверка разошлась бы с проверкой подписи молча, и разошлась
 * бы в ту сторону, где сочинённая цепочка получает `ok`.
 */
function hexFromBytes(bytes: Uint8Array): `0x${string}` {
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out as `0x${string}`;
}

/**
 * Разбор base64 — ЧУЖОЙ (`bytesFromB64`, Задача 5), свой запрещён: одна задача
 * писала base64, другая читала hex, обе были зелёные, стык мёртв.
 *
 * Здесь остаётся только то, чего разбор не знает: ПОТОЛОК. Оценка `length / 4 * 3`
 * считается ДО разбора, чтобы враждебная строка на сотни тысяч знаков не
 * оплачивалась выделением памяти вовсе.
 */
function frameBytes(value: string, maxBytes: number): Uint8Array | null {
  if (Math.floor(value.length / 4) * 3 > maxBytes) return null;
  return bytesFromB64(value);
}

const seqKey = (sender: string, seq: number): string => `${sender.toLowerCase()}|${seq}`;

/**
 * Гейт формы контейнера. `null` — «это не контейнер предъявления», и дальше не
 * идём ни на шаг.
 *
 * ⚠️ ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ, А ЧТО НАРОЧНО НЕТ:
 *  - вид `forArbiter`/`forPeer` НЕ проверяется: негодный ключ ОДНОГО сообщения
 *    обязан дать «не открылось» этому сообщению, а не отказ всему предъявлению;
 *  - содержимое якоря НЕ проверяется: негодный якорь — дело `verifyChain`, она
 *    отвечает `bad_anchor`, и это отказ судить, а не заключение о цепочке;
 *  - значения `counts` НЕ читаются (§15.4), проверяется только их форма.
 */
function asContainer(value: unknown): PresentationContainer | null {
  if (!isPlainObject(value)) return null;
  const c = value;

  if (c.kind !== PRESENTATION_KIND) return null;
  if (typeof c.dealId !== 'string' || !ADDRESS_RE.test(c.dealId)) return null;
  if (typeof c.presenter !== 'string' || !ADDRESS_RE.test(c.presenter)) return null;
  // base64 БЕЗ `0x`, ровно 88 знаков (64 байта Ed25519). Сами байты разбираются
  // один раз, при проверке подписи; негодные там дают `bad_signature`, а не
  // `malformed`, — «подпись не сошлась» точнее, чем «это не контейнер».
  if (typeof c.signature !== 'string' || c.signature.length !== CONTAINER_SIG_B64_LEN) return null;
  if (!isCount(c.issuedAt)) return null;

  // `DeclaredCounts` — ТРИ числа. Четвёртое, `unopened`, может посчитать только
  // тот, кто пробовал вскрывать, то есть арбитр; контейнер, объявляющий его,
  // выдаёт чужую работу за свою. Значения не читаются нигде (§15.4) — только форма.
  if (!isPlainObject(c.counts)) return null;
  const ct = c.counts;
  if (!isCount(ct.read) || !isCount(ct.hidden) || !isCount(ct.notPrepared)) return null;
  if ('unopened' in ct) return null;

  if (!Array.isArray(c.attestations) || !Array.isArray(c.chains) || !Array.isArray(c.frames)
    || !Array.isArray(c.keys) || !Array.isArray(c.notPrepared)) return null;

  // Заверения: форма. Подпись проверяет Задача 1, и только она.
  const seenAtt = new Set<string>();
  for (const a of c.attestations) {
    if (!isPlainObject(a)) return null;
    if (typeof a.address !== 'string' || !ADDRESS_RE.test(a.address)) return null;
    if (typeof a.boxKey !== 'string' || !BYTES32_RE.test(a.boxKey)) return null;
    if (typeof a.signKey !== 'string' || !BYTES32_RE.test(a.signKey)) return null;
    if (!isCount(a.issuedAt)) return null;
    if (typeof a.signature !== 'string') return null;
    // Два заверения на один адрес И ОДНУ ПАРУ КЛЮЧЕЙ — возможность «купить»
    // удобный вердикт: читалка взяла бы первое, экран показал бы второе.
    // ⚠️ КЛЮЧ УНИКАЛЬНОСТИ — ПАРА (адрес, подписной ключ), а не адрес (пункт 48).
    // У собеседника, честно сменившего ключ, заверений на один адрес ДВА, и
    // отвергать такой контейнер значит объявлять его прежние слова подделкой.
    // «Купить вердикт» это по-прежнему не даёт: под каждый НАЗВАННЫЙ КАДРОМ ключ
    // заверение ровно одно, и выбирать читалке не из чего.
    const pairId = `${a.address.toLowerCase()}|${a.signKey.toLowerCase()}`;
    if (seenAtt.has(pairId)) return null;
    seenAtt.add(pairId);
  }

  if (c.chains.length > MAX_PRESENTED_CHAINS) return null;
  const linkKeys = new Set<string>();
  const seenChain = new Set<string>();
  for (const pc of c.chains) {
    if (!isPlainObject(pc)) return null;
    if (typeof pc.sender !== 'string' || !ADDRESS_RE.test(pc.sender)) return null;
    if (pc.anchorSource !== 'own_head' && pc.anchorSource !== 'as_received_by_presenter') return null;
    if (!isPlainObject(pc.anchor)) return null;
    if (!Array.isArray(pc.links) || pc.links.length > MAX_PRESENTED_LINKS) return null;

    const sender = pc.sender.toLowerCase();
    if (seenChain.has(sender)) return null;
    seenChain.add(sender);

    for (const l of pc.links) {
      if (!isPlainObject(l)) return null;
      if (!isCount(l.seq) || !isCount(l.sentAt)) return null;
      if (typeof l.prevHash !== 'string' || !BYTES32_RE.test(l.prevHash)) return null;
      if (typeof l.bodyHash !== 'string' || !BYTES32_RE.test(l.bodyHash)) return null;
      if (typeof l.sender !== 'string' || !ADDRESS_RE.test(l.sender)) return null;
      // ⚠️ ВСЕ звенья цепочки — одного отправителя. `verifyChain` этого не
      // проверяет НИ РАЗУ (справочник цепочки §4: «sender между звеньями не
      // сравнивается ни разу»), а в приёме со склада это давала группировка по
      // свидетельству сервера, которого у арбитра нет вовсе.
      if (l.sender.toLowerCase() !== sender) return null;
      const key = seqKey(sender, l.seq);
      if (linkKeys.has(key)) return null;
      linkKeys.add(key);
    }
  }

  if (c.frames.length > MAX_PRESENTED_CHAINS * MAX_PRESENTED_LINKS) return null;
  const seenFrame = new Set<string>();
  for (const f of c.frames) {
    if (!isPlainObject(f)) return null;
    if (!isCount(f.seq)) return null;
    if (typeof f.sender !== 'string' || !ADDRESS_RE.test(f.sender)) return null;
    if (typeof f.frame !== 'string') return null;
    const key = seqKey(f.sender, f.seq);
    if (seenFrame.has(key)) return null;
    seenFrame.add(key);
    // Кадр, которого нет ни в одной цепочке, — содержимое ВНЕ проверенного
    // набора: показать его значило бы дать провезти незаякоренное молча.
    if (!linkKeys.has(key)) return null;
  }

  if (c.keys.length > MAX_PRESENTED_CHAINS * MAX_PRESENTED_LINKS) return null;
  const seenKey = new Set<string>();
  for (const k of c.keys) {
    if (!isPlainObject(k)) return null;
    if (!isCount(k.seq)) return null;
    if (typeof k.sender !== 'string' || !ADDRESS_RE.test(k.sender)) return null;
    if (typeof k.forArbiter !== 'string' || typeof k.forPeer !== 'string') return null;
    const key = seqKey(k.sender, k.seq);
    if (seenKey.has(key)) return null;
    seenKey.add(key);
    if (!linkKeys.has(key)) return null;
  }

  if (c.notPrepared.length > MAX_PRESENTED_CHAINS * MAX_PRESENTED_LINKS) return null;
  const seenNotPrepared = new Set<string>();
  for (const n of c.notPrepared) {
    if (!isPlainObject(n)) return null;
    if (!isCount(n.seq)) return null;
    if (typeof n.sender !== 'string' || !ADDRESS_RE.test(n.sender)) return null;
    if (typeof n.reason !== 'string' || n.reason.length > MAX_REASON_LEN) return null;
    const key = seqKey(n.sender, n.seq);
    // ⚠️ ТРИ СВЕРКИ, без которых числа §15.5 перестают сходиться (Л-9):
    //  1. звено неподготовленного кадра ОСТАЁТСЯ в цепочке — иначе «скрыто»
    //     получит честно названную поломку склада вторым числом, а цепочка ещё и
    //     `gap` за неё же;
    //  2. кадра у него быть НЕ ДОЛЖНО — «подготовить не удалось» и кадр рядом это
    //     взаимоисключающие заявления, и они дают ДВА способа посчитать одно
    //     сообщение;
    //  3. дважды одно звено — раздутое число без единого нового сообщения.
    if (!linkKeys.has(key)) return null;
    if (seenFrame.has(key)) return null;
    if (seenNotPrepared.has(key)) return null;
    seenNotPrepared.add(key);
  }

  // Приводим тот САМЫЙ объект, а не свою пересборку: канонический вид считается
  // над ним же, и лишнее копирование — лишний способ разойтись с подписью.
  return value as unknown as PresentationContainer;
}

async function readOne(input: {
  link: ChainLink;
  sender: `0x${string}`;
  /** Вердикт заверения САМОЙ СТОРОНЫ — самого свежего её заверения. Нужен ровно
   *  для кадра, который не разобрался вовсе: названного ключа тогда нет, и
   *  спрашивать про пару нечего. */
  attestation: AttestationVerdict;
  /** Заверение ПОД КЛЮЧ, НАЗВАННЫЙ КАДРОМ (пункт 48): вердикт этой пары и ключ,
   *  которым проверять кадр (`null` — годного заверения у стороны нет, ключ
   *  берётся из кадра). Приходит уже замкнутым на сторону, на клиент цепи и на
   *  памятку вердиктов.
   *
   *  ⚠️ ВЫБОР ЗАВЕРЕНИЯ НЕ ЗДЕСЬ. Решение «под какой ключ» принято один раз, в
   *  `readPresentation`; тут только вопрос и ответ — иначе выбор оказался бы в
   *  двух местах и разошёлся бы молча. */
  signerFor: (claimed: Uint8Array) => Promise<{ verdict: AttestationVerdict; signKey: Uint8Array | null }>;
  frameB64: string | undefined;
  sealed: SealedOneTimeKey | undefined;
  arbiterKeypair: ChatKeypair;
  /** `false` — подпись контейнера не сошлась: вердикты считаем, содержимое НЕ
   *  вскрываем вовсе (см. шапку файла). Ни ключа, ни расшифровки, ни причины
   *  открытия — потому что не пробовали. */
  mayOpen: boolean;
}): Promise<PresentedMessage> {
  const base = {
    seq: input.link.seq,
    sender: input.sender,
    legacyAttachmentExposed: false,
  };
  // ⚠️ ВЕРДИКТА ЗАВЕРЕНИЯ В `base` НЕТ НАРОЧНО, и он `let`: до разбора кадра
  // известен только вердикт стороны, после — вердикт про названный кадром ключ
  // (`wrong_keys`). Замороженный в начале `base` унёс бы устаревшее значение в
  // половину возвратов, и разница была бы невидимой.
  let attestation = input.attestation;
  const malformedFrame: FrameVerdict = { ok: false, reason: 'malformed' };

  // Кадра нет вовсе — доказательства нет. Причины ОТКРЫТИЯ не ставим: беда не в
  // ключе, и выдумывать ей род значило бы соврать о месте отказа.
  if (input.frameB64 === undefined) return { ...base, attestation, state: 'unopened', frame: malformedFrame };
  const bytes = frameBytes(input.frameB64, MAX_FRAME_BYTES);
  if (!bytes) return { ...base, attestation, state: 'unopened', frame: malformedFrame };

  const decoded = decodeFrame(bytes);
  if (!decoded) return { ...base, attestation, state: 'unopened', frame: malformedFrame };

  // ⚠️ ВОПРОС ЗАДАЧЕ 1, А НЕ СВОЯ СВЕРКА: «те ли ключи заверены, которыми назван
  // кадр». Единственный источник `wrong_keys` — и единственная дорога к этому
  // значению вообще.
  //
  // ⚠️ МЕСТО ВЫБРАНО НЕ ЗА ДЕШЕВИЗНУ, а по необходимости: после проверки подписи
  // негодный кадр уходит возвратом ниже, и до вопроса дело не дошло бы НИКОГДА.
  // Цена честно названа: это восстановление адреса по подписи, и мусор его
  // оплачивает; поэтому вопрос задаётся не на сообщение, а на РАЗЛИЧНЫЙ
  // названный ключ (памятка — в `readPresentation`, замки — T33 и R12).
  const picked = await input.signerFor(decoded.signerPublicKey);
  attestation = picked.verdict;

  // ⚠️ Ключ подписи — ИЗ ЗАВЕРЕНИЯ ТОЙ ПАРЫ, КОТОРУЮ НАЗВАЛ КАДР (пункт 48).
  // ⚠️ `await` НЕСУЩИЙ: проверка асинхронна. Без него здесь лежал бы `Promise`,
  // `frame.ok` был бы `undefined`, и КАЖДЫЙ кадр молча оказался бы негодным —
  // этот класс ловит `npm run type-check`, а не тест.
  const signerKey = picked.signKey ?? decoded.signerPublicKey;
  const frame = await verifyFrameEvidence(bytes, input.link, decoded.signature, signerKey);
  if (!frame.ok) return { ...base, attestation, state: 'unopened', frame };

  // Расшифровка ПОСЛЕДНЯЯ — тот же порядок, что в `receiveBags`
  // (`chatConversation.ts:1675-1681`): присланный нарочно мусор её не оплачивает,
  // а содержимое негодного кадра не является доказательством.
  if (!input.mayOpen) return { ...base, attestation, state: 'unopened', frame };
  if (!input.sealed) return { ...base, attestation, state: 'unopened', reason: 'bad_key', frame };

  // ⚠️ base64, и проверяется ДЛИНА (108 знаков = 80 байт). Hex тех же байтов —
  // годный base64, и без гейта длины он дал бы правдоподобный `bad_key` вместо
  // «предъявление написано не той кодировкой». Длина строки мало: 108 знаков с
  // выравниванием `==` дают 79 байт, поэтому байты сверяются ещё раз.
  if (input.sealed.forArbiter.length !== SEALED_KEY_B64_LEN) {
    return { ...base, attestation, state: 'unopened', reason: 'malformed', frame };
  }
  const sealedBytes = bytesFromB64(input.sealed.forArbiter);
  if (!sealedBytes || sealedBytes.length !== SEALED_KEY_BYTES) {
    return { ...base, attestation, state: 'unopened', reason: 'malformed', frame };
  }

  // ⚠️ Только `forArbiter` и только своей парой. Фолбэка на `forPeer` нет и быть
  // не должно: арбитр вскрывает то, что запечатано ЕМУ.
  const raw = await openSealed(input.arbiterKeypair, sealedBytes);
  if (!raw) return { ...base, attestation, state: 'unopened', reason: 'bad_key', frame };

  // Клеймо ставит Задача 2 и только она — приведения здесь нет ни одного. Мешок
  // ровно на 80 байт при успешном вскрытии даёт ровно 32, поэтому `null` тут
  // означал бы, что длина ключа в Задаче 2 поменялась: тогда сообщение получает
  // названный `malformed`, а не тихо другое поведение.
  const key = toOneTimeKey(raw);
  if (!key) return { ...base, attestation, state: 'unopened', reason: 'malformed', frame };

  const opened = await openEnvelopeWithOneTimeKey(decoded.envelope, key, input.link.sender);
  if (!opened.ok) return { ...base, attestation, state: 'unopened', reason: opened.reason, frame };

  // ⚠️ ОДИН ИСТОЧНИК НА ДВА ЗНАЧЕНИЯ. `redactPayload` (Задача 3) отдаёт
  // `Redaction`: отредактированное содержимое И признак «ключ вложения лежал в
  // содержимом открытым». Своего подсчёта признака здесь нет — он расходился бы с
  // редактурой молча, и расходился бы ровно в ту сторону, где ключ уезжает
  // арбитру. Мутация 40 меняет ЭТУ функцию в чужом файле и краснит замки здесь —
  // это и есть доказательство, что копии нет.
  const redacted = redactPayload(opened.payload);
  return {
    ...base,
    attestation,
    state: 'read',
    payload: redacted.payload,
    legacyAttachmentExposed: redacted.legacyAttachmentExposed,
    frame,
  };
}

export async function readPresentation(
  container: unknown,
  arbiterKeypair: ChatKeypair,
  publicClient?: PublicClient,
): Promise<PresentationView> {
  const c = asContainer(container);
  if (!c) return malformed();

  // 1. Заверения — проверяем САМИ, каждое (§15.2). `verifyChatKeyAttestation`
  //    принимает `unknown`, значит бросок оттуда — НАШ баг, и он обязан быть
  //    виден, а не слиться с «заверение негодное» (тот же принцип, по которому
  //    `sanitizePayload` стоит ВНЕ try в `unpackEnvelope`).
  //
  //    ⚠️ `publicClient` ПРОКИДЫВАЕТСЯ, и в ОБЕ двери (вторая — ниже). Без него
  //    ветка ERC-1271 в Задаче 1 неработоспособна, и два рода кошельков из
  //    четырёх не могут предъявить вовсе.
  //
  //    ⚠️ КАРТА ВЕДЁТСЯ ПО СТОРОНЕ, НО ХРАНИТ СПИСОК (пункт 48). Собеседник,
  //    честно сменивший ключ чата, приезжает ДВУМЯ заверениями на один адрес.
  //    Выбирать между ними по свежести нельзя: половина его сообщений подписана
  //    прежним ключом, и «нынешнее» заверение превращает их в `wrong_keys` +
  //    `malformed` — ровно то, что арбитр видит на сочинённой цепочке.
  interface AttRecord {
    att: ChatKeyAttestation;
    verdict: AttestationVerdict;
    signKey: Uint8Array;
    signKeyHex: string;
  }
  const bySide = new Map<string, AttRecord[]>();
  for (const att of c.attestations) {
    const rec: AttRecord = {
      att,
      verdict: await verifyChatKeyAttestation(att, publicClient),
      signKey: hexToBytes(att.signKey),
      signKeyHex: att.signKey.toLowerCase(),
    };
    const side = lower(att.address);
    const rows = bySide.get(side);
    if (rows) rows.push(rec); else bySide.set(side, [rec]);
  }

  /** Самое свежее из поданных заверений. ⚠️ Порядок массива сюда НЕ входит: он
   *  пришёл от предъявителя, а `issuedAt` подписан кошельком. При равном
   *  времени — большее hex подписного ключа, чтобы выбор был функцией данных, а
   *  не того, как предъявитель разложил массив.
   *
   *  ⚠️ ЭТО НАБЛЮДАЕМО, И ЗАМОК ЕСТЬ — R13. Наблюдаемо ровно там, где у стороны
   *  НЕТ ни одного годного заверения: тогда вердикт сообщений берётся отсюда, и
   *  «просрочено» против «проверить нечем» — разные упрёки. Возьми `rows[0]` —
   *  и предъявитель выбирал бы раскладкой массива, какой из них прочитает
   *  арбитр. Там, где годные есть, выбор действительно ненаблюдаем: вердикт у
   *  всех кандидатов один и тот же `ok`. */
  const newest = (rows: readonly AttRecord[]): AttRecord | undefined => {
    let best: AttRecord | undefined;
    for (const r of rows) {
      if (!best
        || r.att.issuedAt > best.att.issuedAt
        || (r.att.issuedAt === best.att.issuedAt && r.signKeyHex > best.signKeyHex)) best = r;
    }
    return best;
  };

  // Вердикт по ключу, НАЗВАННОМУ КАДРОМ, — вторая дверь к тому же заверению и
  // единственная дорога к `wrong_keys`. Сверяет Задача 1; здесь только памятка,
  // чтобы один и тот же ответ не покупался дважды: у честного контейнера ключей
  // на сторону один-два (замок T33 и R12 — ровно на эти числа), у враждебного
  // различных ключей столько, сколько кадров, и это верхняя граница цены.
  const claimedVerdicts = new Map<string, AttestationVerdict>();
  const askForKeys = async (
    att: ChatKeyAttestation, claimedHex: `0x${string}`,
  ): Promise<AttestationVerdict> => {
    const memo = `${lower(att.address)}|${claimedHex}`;
    const seen = claimedVerdicts.get(memo);
    if (seen !== undefined) return seen;
    const verdict = await verifyChatKeyAttestationForKeys(att, { signKey: claimedHex }, publicClient);
    claimedVerdicts.set(memo, verdict);
    return verdict;
  };

  /**
   * Заверение ПОД КЛЮЧ, НАЗВАННЫЙ КАДРОМ (пункт 48). Отдаёт вердикт этой пары и
   * ключ, которым проверять кадр; `signKey: null` — «годного заверения у стороны
   * нет вовсе», и тогда кадр проверяется ключом из себя самого, а сообщение
   * уносит `attestation !== 'ok'`.
   *
   * ⚠️ ТРИ ВЕТКИ ИЗ ЧЕТЫРЁХ ПОВТОРЯЮТ СЕГОДНЯШНЕЕ ПОВЕДЕНИЕ ДОСЛОВНО, и это
   * несущее требование, а не осторожность: у стороны есть годное заверение, а
   * кадр называет ДРУГОЙ ключ — кадр обязан проверяться ЗАВЕРЕННЫМ ключом и
   * уходить `malformed` (T17, T18). Иначе сочинённая цепочка становится читаемой
   * с бейджем, то есть защита меняется на украшение.
   *
   * ⚠️ HEX-РАВЕНСТВО ЗДЕСЬ ТОЛЬКО ВЫБИРАЕТ КАНДИДАТА. Вердикт по-прежнему выносит
   * `verifyChatKeyAttestationForKeys` (Задача 1), и сверку той же пары она делает
   * сама. Значит расхождение этого сравнения с ней может лишь ПОТЕРЯТЬ совпадение
   * — тогда путь ровно тот же, что у сочинённой цепочки, — но НЕ выдать `ok` там,
   * где его нет. Своей сверки ключей, решающей вердикт, здесь нет ни строки.
   */
  const signerFor = (side: string) =>
    async (claimed: Uint8Array): Promise<{ verdict: AttestationVerdict; signKey: Uint8Array | null }> => {
      const claimedHex = hexFromBytes(claimed);
      const rows = bySide.get(side) ?? [];
      const okRows = rows.filter(r => r.verdict === 'ok');
      if (okRows.length === 0) {
        // Годного заверения у стороны нет вовсе: вердикт уже назван точнее
        // (`expired`, `bad_signature`, `absent`), уточнять его ключом нечем.
        const current = newest(rows);
        return { verdict: current ? current.verdict : 'absent', signKey: null };
      }
      const pick = okRows.find(r => r.signKeyHex === claimedHex) ?? newest(okRows)!;
      return { verdict: await askForKeys(pick.att, claimedHex), signKey: pick.signKey };
    };

  // 2. Подпись контейнера (§15.1). `crypto_box_seal` анонимен, поэтому личность
  //    предъявителя не приходит из контейнера сама — она приходит из ЕГО
  //    заверения, и подпись проверяется заверенным ключом. Не подтвердили
  //    заверение — контейнер не приписан никому.
  const presenter = lower(c.presenter);
  // Личность предъявителя приходит из ЕГО заверения, и подпись проверяется
  // заверенным ключом. Из нескольких годных берётся самое свежее: контейнер
  // подписывается нынешним ключом сеанса, а сборщик кладёт нынешнее заверение
  // первым и обязан требовать их совпадения.
  const presenterAtt = newest((bySide.get(presenter) ?? []).filter(r => r.verdict === 'ok'));
  const { signature, ...unsigned } = c;

  let signatureOk = false;
  if (presenterAtt) {
    const sodium = (await import('libsodium-wrappers')).default;
    await sodium.ready;
    const sig = bytesFromB64(signature);
    try {
      signatureOk = sig !== null && sig.length === ED25519_SIG_BYTES && sodium.crypto_sign_verify_detached(
        sig, canonicalPresentationBytes(unsigned), presenterAtt.signKey,
      );
    } catch {
      // libsodium бросает TypeError на негодной длине — формы уже проверены
      // гейтами выше, но чужие данные не повод падать целиком (тот же приём, что
      // в `receiveBags`, `chatConversation.ts:1355-1359`).
      signatureOk = false;
    }
  }

  // ⚠️ НЕ ВОЗВРАТ. Подпись не сошлась — содержимое наружу не идёт, но вердикты
  // кадров и заверений самопроверяемы и от неё не зависят: их считаем и
  // показываем (см. шапку файла). Разница держится ОДНИМ флагом, который
  // проходит в `readOne`, — двух путей разбора нет, иначе они разойдутся.
  const mayOpen = signatureOk;

  const frameAt = new Map<string, string>();
  for (const f of c.frames) frameAt.set(seqKey(f.sender, f.seq), f.frame);
  const keyAt = new Map<string, SealedOneTimeKey>();
  for (const k of c.keys) keyAt.set(seqKey(k.sender, k.seq), k);
  // Звенья, про которые предъявитель сам сказал «кадр подготовить не удалось».
  // Гейт формы уже проверил, что каждое такое звено ЕСТЬ в цепочке и кадра у него
  // НЕТ (Л-9), — здесь остаётся только не считать его сообщением.
  const notPreparedAt = new Set<string>();
  for (const n of c.notPrepared) notPreparedAt.add(seqKey(n.sender, n.seq));

  // Цепочки (то есть отправителей) упорядочиваем — это порядок ВЫДАЧИ.
  // ⚠️ Звенья внутри цепочки НЕ упорядочиваем: переставленный контейнер обязан
  // дать `unordered`, а не тихо починенный вердикт.
  const chains = [...c.chains].sort((x, y) => (lower(x.sender) < lower(y.sender) ? -1 : 1));

  const perSender: PresentationView['perSender'] = [];
  const messages: PresentedMessage[] = [];
  let hidden = 0;

  for (const pc of chains) {
    const sender = lower(pc.sender);

    // ⚠️ ЯКОРЬ ПЕРЕДАЁТСЯ. Без него вердикт значит «самопротиворечий не найдено»
    // (`chatConversation.ts:104-109`), и число скрытых не считается ничем —
    // именно тот включённый-но-неиспользуемый механизм из замысла §4.
    const verdict = verifyChain(pc.links, pc.anchor);
    perSender.push({ sender, verdict, anchorSource: pc.anchorSource });

    // Скрытые считаются ТОЛЬКО по вердикту, который о полноте что-то говорит.
    // `broken`/`unordered`/`not_array`/`bad_anchor` — не «скрыто нуль», а
    // «считать нечем»; арбитр видит вердикт в `perSender` и делает вывод сам.
    //
    // ⚠️ ЗВЕНЬЯ, А НЕ СООБЩЕНИЯ. Неподготовленные звенья остаются в `links` и
    // потому в «скрыто» не попадают: они уже посчитаны своим числом. Отсюда
    // сходимость §15.5 — `3+0+2+1 = 6` и `0+3+2+1 = 6`.
    if (verdict.ok || verdict.reason === 'gap') {
      const gap = pc.anchor.expectedMessageCount - pc.links.length;
      if (gap > 0) hidden += gap;
    }

    const rows = bySide.get(sender) ?? [];
    // ⚠️ ГОДНЫЕ ИМЕЮТ ПРЕИМУЩЕСТВО, И ЭТО НЕ ВКУСОВЩИНА (ревью, круг 1).
    // `issuedAt` у заверения с НЕСОШЕДШЕЙСЯ подписью — поле свободное: оно
    // подписано только само собой. Простое `newest(rows)` давало предъявителю
    // ручку: приложи мусорное заверение с огромным `issuedAt` — оно станет
    // «нынешним» для стороны, и сообщения, у которых кадр не разобрался вовсе,
    // получат `bad_signature`/`wrong_address` вместо честного `ok`. Прежнее
    // правило «одно заверение на адрес» эту ручку отрицало по построению, и
    // терять её на переходе к списку нельзя. Замок — R14.
    const current = newest(rows.filter(r => r.verdict === 'ok')) ?? newest(rows);
    const ask = signerFor(sender);
    for (const link of pc.links) {
      const key = seqKey(sender, link.seq);
      if (notPreparedAt.has(key)) continue;   // считается отдельно, сообщением не является
      messages.push(await readOne({
        link,
        sender,
        // ⚠️ `absent`, а не `malformed`: «этой стороны в заверениях нет вовсе» и
        // «на месте заверения мусор» — разные обвинения (договор v2 4в-1).
        attestation: current ? current.verdict : 'absent',
        signerFor: ask,
        frameB64: frameAt.get(key),
        sealed: keyAt.get(key),
        arbiterKeypair,
        mayOpen,
      }));
    }
  }

  const read = messages.filter(m => m.state === 'read').length;
  return {
    container: signatureOk ? 'ok' : 'bad_signature',
    // ЗАЯВЛЕНО контейнером, и заявление доезжает как есть: без него арбитр не
    // знает даже, о какой сделке речь. Утверждать о нём читалка ничего не
    // утверждает — рядом стоит вердикт контейнера.
    dealId: c.dealId,
    presenter,
    issuedAt: c.issuedAt,
    messages,
    // ⚠️ ЧЕТЫРЕ РАЗДЕЛЬНЫХ ЧИСЛА (§15.4), и все посчитаны здесь. «Не открылось»
    // НЕ уменьшает «скрыто»: скрытое считается из якоря против числа
    // предъявленных ЗВЕНЬЕВ. `container.counts` не читается ни здесь, ни где-либо.
    counts: { read, unopened: messages.length - read, hidden, notPrepared: c.notPrepared.length },
    // СЛОВА причины — только у приписанного контейнера: это единственное место,
    // куда подделыватель мог бы вписать арбитру свободный текст. Число выше
    // остаётся в любом случае, чтобы суммы сходились.
    notPrepared: signatureOk
      ? c.notPrepared.map(n => ({ seq: n.seq, sender: lower(n.sender), reason: n.reason }))
      : [],
    perSender,
  };
}
