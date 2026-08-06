/**
 * chatEnvelope.ts — конверт одного сообщения чата.
 *
 * НЕ ЗНАЕТ: про сеть (`chatTransport.ts`), про React, про кошелёк. Только
 * шифрование и разбор байтов — потребляет РОВНО `sealForRecipient`/
 * `openSealed`/`ChatKeypair` из `chatCrypto.ts` (Задача 3 плана «Клиент
 * чата», docs/superpowers/plans/2026-08-06-chat-client.md), больше ничего.
 * Проверяется буквально: ни импортов транспорта, ни хуков, ни React в файле
 * нет — тем же способом, каким это проверено в `chatTransport.ts`.
 *
 * ─── УСТРОЙСТВО ────────────────────────────────────────────────────────
 *
 * Содержимое (`ChatPayload`, сериализованное в JSON) шифруется РАЗОВЫМ
 * симметричным ключом (AES-256-GCM, `crypto.subtle`) — свежим на каждый
 * вызов `packEnvelope`. Разовый ключ кладётся в мешок ДВАЖДЫ, запечатанный
 * `sealForRecipient` (chatCrypto.ts) — один раз на получателя, один раз на
 * себя. Не два мешка на сообщение: запечатав только на собеседника,
 * отправитель не смог бы прочитать собственную переписку на втором
 * устройстве, а два мешка на каждое сообщение удвоили бы всё хранилище —
 * два маленьких конверта внутри одного мешка стоят дёшево (160 байт).
 *
 * ─── ФОРМАТ ПРОВОДА ─────────────────────────────────────────────────────
 *
 *   [ version:1 ][ sealedSlotA:80 ][ sealedSlotB:80 ][ iv:12 ][ ciphertext:N ]
 *
 * Ровно ОДНО поле переменной ширины (`ciphertext`), и оно последнее — та же
 * дисциплина, что в `chatChain.ts` (`LINK_ENCODING_TYPES`, «не более одного
 * динамического поля, иначе граница между двумя плавает»). Здесь даже проще:
 * единственное переменное поле стоит в конце, поэтому граница вообще не
 * может съехать — что угодно после фиксированного заголовка целиком
 * принадлежит шифротексту.
 *
 * `sealedSlotA`/`sealedSlotB` — ОБА содержат печать одного и того же
 * 32-байтного разового ключа, просто на разные открытые ключи (получателя и
 * своего собственного). Порядок записи («сначала слот получателя, потом
 * слот себя») задаёт РАСКЛАДКУ БАЙТОВ, а не то, КЕМ является читающий:
 * при разборе `unpackEnvelope` пробует слот A, затем слот B — какой из двух
 * откроется вашей парой, для результата не важно, потому что оба открывают
 * ОДИН И ТОТ ЖЕ ключ. Получатель откроет обычно слот A, отправитель на
 * другом устройстве — слот B; но конечный результат (сам разовый ключ и,
 * значит, содержимое) от этого не отличается. Это намеренное свойство —
 * подмена местами двух слотов при записи не меняет результат разбора ни для
 * кого (отчёт задачи проверяет это явно, а не оставляет предположением).
 *
 * `sealedSlotA`/`sealedSlotB` — ФИКСИРОВАННОЙ ширины (80 байт), не
 * length-prefixed: `sealForRecipient` (libsodium `crypto_box_seal`) даёт
 * ДЕТЕРМИНИРОВАННУЮ длину `len(plaintext) + 48` (32-байтный одноразовый
 * публичный ключ + 16-байтный MAC, `crypto_box_SEALBYTES` — НЕ зависит от
 * содержимого, только от длины открытого текста). Плейнтекст здесь всегда
 * ровно 32 байта (сырой ключ AES-256), поэтому 80 байт — не допущение, а
 * измеренный факт: пять независимых запечатываний одного и того же
 * 32-байтного ключа дали 80 байт каждый раз (см. отчёт задачи, «пять
 * вопросов»/зафиксировано в `SEALED_KEY_LEN` ниже с этим обоснованием).
 * Если это когда-нибудь перестанет быть так (смена библиотеки, смена
 * алгоритма запечатывания) — `packEnvelope` проверяет фактическую длину
 * результата `sealForRecipient` и бросает ГРОМКО, а не молча портит
 * раскладку конверта для случайного получателя месяцы спустя.
 *
 * ─── НЕЗНАКОМЫЙ/ПОВРЕЖДЁННЫЙ ВХОД ───────────────────────────────────────
 *
 * `packEnvelope` не проверяет форму `payload` глубоко (это НАШИ собственные
 * исходящие данные — TS-типы на границе UI достаточно) и не гасит исключения
 * `sealForRecipient` на негодных ключах (chatCrypto.ts сама бросает
 * `TypeError` — эта функция ничего не оборачивает, мусор долетает как есть).
 *
 * `unpackEnvelope` разбирает данные ИЗ СЕТИ — от них веры нет:
 *  - `envelope` не `Uint8Array`, `ownKeypair.publicKey`/`privateKey` не
 *    `Uint8Array` — это НАШ мусор на входе (не то, что послал собеседник, а
 *    то, что подал наш же вызывающий код), и он ГРОМКО пробрасывается как
 *    `TypeError` — то самое правило ядра из `openSealed` (chatCrypto.ts):
 *    сбой не должен носить костюм штатного результата. Все три проверки —
 *    ДО какой-либо попытки истолковать содержимое, в фиксированном порядке,
 *    той же дисциплиной, что и в `openSealed`.
 *  - ЛЮБАЯ другая порча — короче заголовка, незнакомая версия, не тот
 *    получатель, испорченные байты, невалидный JSON после расшифровки,
 *    форма содержимого не сходится с `ChatPayload` — это НЕ наш мусор, а
 *    честный отказ о чужих или повреждённых данных: `null`, не исключение.
 *  - Незнакомые ДОПОЛНИТЕЛЬНЫЕ поля внутри `payload` (будущая версия
 *    формата добавила поле, которого эта сборка ещё не знает) НЕ стираются
 *    молча — разобранный объект возвращается как есть, лишние поля целы.
 *    Тот же урок, что в Задаче 2 (справочник ключей стирал незнакомые поля
 *    при перезаписи, что незаметно ломало бы будущее расширение).
 *
 * ─── РАЗДУТЫЙ ВХОД (вопрос 5 отчёта) ────────────────────────────────────
 *
 * `unpackEnvelope` не знает про транспорт и не видит лимит склада
 * (`MAX_BAG_SIZE`, relayer/bagStore.js — импорт оттуда сюда сломал бы
 * изоляцию модуля). У неё свой независимый потолок (`MAX_ENVELOPE_BYTES`),
 * проверяемый сравнением длины ДО какой-либо попытки вскрыть слоты или
 * расшифровать — O(1), не растёт с размером входа. Единственная операция,
 * чья стоимость реально зависит от размера входа, — `crypto.subtle.decrypt`
 * над шифротекстом (оба `openSealed` работают над ФИКСИРОВАННЫМИ 80-байтными
 * срезами независимо от общей длины конверта); потолок стоит раньше и её,
 * и обоих `openSealed`.
 */

import { sealForRecipient, openSealed, type ChatKeypair } from './chatCrypto';

/** Приводит вид `Uint8Array` (в т.ч. срез со смещением через `subarray()`) к
 *  самостоятельному `ArrayBuffer`. Web Crypto API в этой версии TypeScript
 *  типизирован через `ArrayBufferView<ArrayBuffer>`, с которым обычный
 *  `Uint8Array<ArrayBufferLike>` конфликтует чисто по типам — та же
 *  нестыковка версий, что уже обойдена в `fileCrypto.ts` (рантайм принимает
 *  любой `ArrayBufferView`, конфликт только в типах, не в поведении). */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

export interface ChatPayload {
  text?: string;
  file?: { url: string; name: string; size: number; keyHex: string; ivHex: string };
  /** Метка сделки — ВНУТРИ запечатанного, не снаружи (см. докстринг файла и
   *  тест «метка сделки не встречается в байтах конверта»). Форма — адрес
   *  Agreement-контракта (`0x` + 40 hex-символов), как везде в проекте
   *  (`dealCtx.agreementAddr`, `DisputeLog dealId=agreement` в
   *  `app/arbiter/page.tsx`) — НЕ bytes32. */
  dealId?: `0x${string}`;
}

const ENVELOPE_VERSION = 1;

/** Сырой ключ AES-256 — 32 байта, разовый на каждый вызов `packEnvelope`. */
const ONE_TIME_KEY_LEN = 32;

/** Ширина результата `sealForRecipient()` над РОВНО 32-байтным сообщением —
 *  измерено, не взято на веру (см. докстринг файла, раздел «формат провода»). */
const SEALED_KEY_LEN = 80;

/** Стандартная длина nonce для AES-GCM (NIST SP 800-38D §8.2 — 96 бит), тот
 *  же выбор, что уже сделан в `fileCrypto.ts` для вложений. */
const IV_LEN = 12;

const HEADER_LEN = 1 + SEALED_KEY_LEN * 2 + IV_LEN; // 173

/** Потолок размера конверта, который `unpackEnvelope` вообще готова
 *  пытаться разобрать — см. докстринг файла, раздел «раздутый вход». Своя
 *  независимая величина, в разы щедрее настоящего мешка на складе
 *  (`MAX_BAG_SIZE` = 256 КиБ, relayer/bagStore.js) — сообщение это текст
 *  плюс УКАЗАТЕЛЬ на вложение (`ChatPayload.file` несёт `url`/`keyHex`, не
 *  байты файла), поэтому даже щедрый потолок здесь не про легитимный
 *  трафик, а про защиту от входа, поданного в обход транспорта. */
const MAX_ENVELOPE_BYTES = 1024 * 1024; // 1 МиБ

/** Форма `dealId` — адрес Agreement-контракта (см. JSDoc у `ChatPayload.dealId`). */
const DEAL_ID_RE = /^0x[0-9a-fA-F]{40}$/;

/** Гейт формы разобранного payload — та же дисциплина, что `isBagSummary`/
 *  `isWellFormedLink` в соседних модулях: данные из сети, вере не подлежат.
 *  Проверяет ТОЛЬКО известные поля; любые лишние — не повод отказывать (см.
 *  докстринг файла про незнакомые поля). Намеренно НЕ реконструирует объект
 *  (не «выбирает» поля по одному) — то, что уже прошло эту проверку,
 *  возвращается вызывающим кодом как есть, вместе с любыми лишними полями. */
function isWellFormedPayload(value: unknown): value is ChatPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;

  if (v.text !== undefined && typeof v.text !== 'string') return false;
  if (v.dealId !== undefined && (typeof v.dealId !== 'string' || !DEAL_ID_RE.test(v.dealId))) return false;

  if (v.file !== undefined) {
    if (typeof v.file !== 'object' || v.file === null || Array.isArray(v.file)) return false;
    const f = v.file as Record<string, unknown>;
    if (
      typeof f.url !== 'string' ||
      typeof f.name !== 'string' ||
      typeof f.size !== 'number' || !Number.isFinite(f.size) ||
      typeof f.keyHex !== 'string' ||
      typeof f.ivHex !== 'string'
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Собирает конверт: шифрует `payload` разовым ключом AES-256-GCM, кладёт
 * ключ дважды (на `recipientPub` и на `ownPub`) через `sealForRecipient`.
 *
 * Ничего не гасит: негодные `recipientPub`/`ownPub` (не `Uint8Array`, не та
 * длина) пробрасываются как есть — `sealForRecipient` (chatCrypto.ts) уже
 * бросает `TypeError` на таком входе, оборачивать нечего.
 */
export async function packEnvelope(
  payload: ChatPayload,
  recipientPub: Uint8Array,
  ownPub: Uint8Array,
): Promise<Uint8Array> {
  const oneTimeKey = crypto.getRandomValues(new Uint8Array(ONE_TIME_KEY_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));

  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const cryptoKey = await crypto.subtle.importKey('raw', oneTimeKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plaintext),
  );

  // Порядок вызовов — «сначала получатель, потом себя» — задаёт РАСКЛАДКУ
  // байтов ниже (slotA/slotB), не смысл; см. докстринг файла.
  const sealedSlotA = await sealForRecipient(recipientPub, oneTimeKey);
  const sealedSlotB = await sealForRecipient(ownPub, oneTimeKey);

  // Замок на собственное предположение о форме (см. докстринг файла) —
  // громкий отказ здесь, а не тихая порча раскладки у случайного получателя.
  if (sealedSlotA.length !== SEALED_KEY_LEN || sealedSlotB.length !== SEALED_KEY_LEN) {
    throw new Error(
      `packEnvelope: unexpected sealed key length (${sealedSlotA.length}/${sealedSlotB.length}), expected ${SEALED_KEY_LEN}`,
    );
  }

  const out = new Uint8Array(HEADER_LEN + ciphertext.length);
  out[0] = ENVELOPE_VERSION;
  out.set(sealedSlotA, 1);
  out.set(sealedSlotB, 1 + SEALED_KEY_LEN);
  out.set(iv, 1 + SEALED_KEY_LEN * 2);
  out.set(ciphertext, HEADER_LEN);
  return out;
}

/**
 * Разбирает конверт своей парой ключей. `null` — не наш мешок, повреждён,
 * незнакомая версия или содержимое не сходится с `ChatPayload`; `TypeError`
 * — наш собственный мусор на входе (см. докстринг файла).
 */
export async function unpackEnvelope(
  envelope: Uint8Array,
  ownKeypair: ChatKeypair,
): Promise<ChatPayload | null> {
  // Проверки типа — ПЕРВЫМИ, безусловно, в фиксированном порядке, той же
  // дисциплиной, что openSealed в chatCrypto.ts: наш мусор на входе не
  // должен зависеть от того, насколько «похож на конверт» второй аргумент.
  if (!(envelope instanceof Uint8Array)) {
    throw new TypeError('unpackEnvelope: envelope должен быть Uint8Array (не строка/иное)');
  }
  if (!(ownKeypair.publicKey instanceof Uint8Array)) {
    throw new TypeError('unpackEnvelope: ownKeypair.publicKey должен быть Uint8Array (не строка/иное)');
  }
  if (!(ownKeypair.privateKey instanceof Uint8Array)) {
    throw new TypeError('unpackEnvelope: ownKeypair.privateKey должен быть Uint8Array (не строка/иное)');
  }

  // Раздутый вход — см. докстринг файла, раздел «раздутый вход». Сравнение
  // длины, до какой-либо попытки вскрыть слоты или расшифровать.
  if (envelope.length > MAX_ENVELOPE_BYTES) return null;
  if (envelope.length < HEADER_LEN) return null;
  if (envelope[0] !== ENVELOPE_VERSION) return null;

  const sealedSlotA = envelope.subarray(1, 1 + SEALED_KEY_LEN);
  const sealedSlotB = envelope.subarray(1 + SEALED_KEY_LEN, 1 + SEALED_KEY_LEN * 2);
  const iv = envelope.subarray(1 + SEALED_KEY_LEN * 2, HEADER_LEN);
  const ciphertext = envelope.subarray(HEADER_LEN);

  // Оба слота запечатывают ОДИН И ТОТ ЖЕ разовый ключ на разные открытые
  // ключи — какой откроется нашей парой, для результата не важно (см.
  // докстринг файла). openSealed сама отдаёт null на чужом/повреждённом
  // слоте, ничего здесь не перехватывается специально.
  let oneTimeKey = await openSealed(ownKeypair, sealedSlotA);
  if (!oneTimeKey) {
    oneTimeKey = await openSealed(ownKeypair, sealedSlotB);
  }
  if (!oneTimeKey) return null;

  try {
    const cryptoKey = await crypto.subtle.importKey('raw', toArrayBuffer(oneTimeKey), { name: 'AES-GCM' }, false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      cryptoKey,
      toArrayBuffer(ciphertext),
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
    return isWellFormedPayload(parsed) ? parsed : null;
  } catch {
    // Провал аутентификации AES-GCM (подмена байта, чужой разовый ключ),
    // невалидный JSON, либо ключ неожиданной длины (защита на случай, если
    // openSealed когда-нибудь начнёт отдавать не 32 байта) — всё это «мешок
    // испорчен/не наш», а не наша ошибка типов. Тот же принцип, что catch в
    // openSealed (chatCrypto.ts): сбой не должен выглядеть как исключение.
    return null;
  }
}
