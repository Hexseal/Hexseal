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
 * ─── ЗАГОЛОВОК АУТЕНТИФИЦИРОВАН ЦЕЛИКОМ (AAD) ───────────────────────────
 *
 * АES-256-GCM подтверждает подлинность НЕ только шифротекста: весь заголовок
 * (версия + оба запечатанных слота + вектор — все 173 байта до `ciphertext`)
 * передаётся как Additional Authenticated Data и связывается с тегом
 * аутентификации. Без этого GCM защищал бы только `ciphertext` — подмена
 * байта внутри "чужого" слота была бы НЕВИДИМА той стороне, чей слот не
 * задет (получатель никогда не трогает slotB, отправитель никогда не
 * трогает slotA), а другая сторона тихо теряла бы доступ без единого
 * сигнала кому-либо (находка К-1, ревью координатора, критическая — 160 из
 * 237 байт реального конверта были защищены НИКАК). С AAD подмена ЛЮБОГО
 * байта заголовка рвёт проверку тега для ОБЕИХ сторон одинаково — порча
 * становится видимой (`null`), а не тихой.
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
 * `unpackEnvelope` не знает про транспорт и не видит лимит склада — свой
 * независимый потолок, `MAX_ENVELOPE_BYTES` (см. её собственный докстринг
 * ниже — ОБЯЗАТЕЛЬНО читать: правда о том, что этот потолок реально
 * защищает, оказалась скромнее первоначальной формулировки, найдено ревью
 * координатора, К-2). Сравнение длины — до какой-либо попытки вскрыть
 * слоты или расшифровать, O(1), не растёт с размером входа.
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

/**
 * Потолок размера конверта, который `unpackEnvelope` вообще готова
 * пытаться разобрать — см. докстринг файла, раздел «раздутый вход». Своя
 * независимая величина (модуль не знает про транспорт/склад, импорт
 * `MAX_BAG_SIZE` оттуда сломал бы изоляцию), в 4 раза выше настоящего
 * мешка на складе (`MAX_BAG_SIZE` = 256 КиБ, relayer/bagStore.js).
 *
 * ⚠️ ЧЕСТНО О ТОМ, ЧТО ЭТО ЗАЩИЩАЕТ, А ЧТО НЕТ (правка после ревью
 * координатора). Через настоящий сервер конверт больше 256 КиБ сегодня
 * НЕДОСТИЖИМ: приём режет по `MAX_BAG_SIZE`, восстановление описи после
 * потери индекса выбрасывает файлы больше того же предела. Значит на
 * ЖИВОМ трафике этот потолок (1 МиБ) не срабатывает НИКОГДА — это вторая
 * линия обороны для входа, поданного В ОБХОД транспорта (прямой вызов
 * модуля, будущий другой транспорт), а не действующая защита от сегодняшнего
 * сервера. Экспортирован — сравнивается тестами напрямую, не задваивается
 * магическим числом.
 *
 * Этот потолок стоит ПОСЛЕ того, как байты конверта уже скачаны и лежат в
 * памяти целиком (`unpackEnvelope` получает готовый `Uint8Array` —
 * скачивание происходит СНАРУЖИ, в `chatTransport.ts`, до вызова этой
 * функции). Значит памятью НА ЭТАПЕ СКАЧИВАНИЯ он не защищает вовсе —
 * только отсекает следующий шаг (вскрытие слотов и расшифровку) уже
 * ПОСЛЕ того, как байты и так попали в память вызывающего.
 *
 * Известный зазор: `MAX_BAG_SIZE` на сервере читается из окружения. Подними
 * его выше 1 МиБ — сервер примет и сохранит такой мешок, `chatTransport.ts`
 * скачает его (у транспорта НЕТ своего потолка), и только на этом шаге,
 * ЗДЕСЬ, разбор вернёт `null`. Сообщение при этом пропадёт МОЛЧА — ни
 * получатель, ни отправитель не увидят сигнала о том, что что-то вообще
 * было отправлено и потеряно (см. отчёт задачи, находка К-2). Не чинится
 * в этом модуле (он не знает про транспорт) — занесено как открытый пункт.
 */
export const MAX_ENVELOPE_BYTES = 1024 * 1024; // 1 МиБ

/**
 * Замок на собственное предположение о форме `sealForRecipient()` (см.
 * докстринг файла, «формат провода») — выделен в отдельную функцию, чтобы
 * быть проверяемым НАПРЯМУЮ, без подмены `chatCrypto.ts` целиком через
 * `vi.mock` (риск загрязнения состояния остальных тестов файла — тот же
 * класс хрупкости теста, что разобран в отчёте задачи для другой находки).
 * @throws {Error} если `bytes.length !== SEALED_KEY_LEN` — громкий отказ
 *   здесь, а не тихая порча раскладки конверта у случайного получателя.
 */
function assertSealedKeyLength(bytes: Uint8Array, label: string): void {
  if (bytes.length !== SEALED_KEY_LEN) {
    throw new Error(
      `packEnvelope: unexpected ${label} sealed key length (${bytes.length}), expected ${SEALED_KEY_LEN}`,
    );
  }
}

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

  // Порядок вызовов — «сначала получатель, потом себя» — задаёт РАСКЛАДКУ
  // байтов ниже (slotA/slotB), не смысл; см. докстринг файла.
  const sealedSlotA = await sealForRecipient(recipientPub, oneTimeKey);
  const sealedSlotB = await sealForRecipient(ownPub, oneTimeKey);
  assertSealedKeyLength(sealedSlotA, 'recipient');
  assertSealedKeyLength(sealedSlotB, 'own');

  // Заголовок собирается ДО шифрования — он целиком идёт в AAD ниже (К-1,
  // ревью координатора). До этой правки AES-GCM аутентифицировал только
  // ciphertext: подмена байта внутри "чужого" слота была НЕВИДИМА той
  // стороне, чей слот не тронут (получатель не трогает slotB, отправитель
  // не трогает slotA) — склад мог тихо испортить архив одной стороны, не
  // подавая никакого сигнала вообще. Заголовок как AAD связывает ВСЕ его
  // байты с тегом аутентификации — подмена любого из них рвёт проверку
  // ОБЕИМ сторонам одинаково, независимо от того, чей слот задет.
  const header = new Uint8Array(HEADER_LEN);
  header[0] = ENVELOPE_VERSION;
  header.set(sealedSlotA, 1);
  header.set(sealedSlotB, 1 + SEALED_KEY_LEN);
  header.set(iv, 1 + SEALED_KEY_LEN * 2);

  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const cryptoKey = await crypto.subtle.importKey('raw', oneTimeKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: toArrayBuffer(header) },
      cryptoKey,
      plaintext,
    ),
  );

  const out = new Uint8Array(HEADER_LEN + ciphertext.length);
  out.set(header, 0);
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

  const header = envelope.subarray(0, HEADER_LEN);
  const sealedSlotA = envelope.subarray(1, 1 + SEALED_KEY_LEN);
  const sealedSlotB = envelope.subarray(1 + SEALED_KEY_LEN, 1 + SEALED_KEY_LEN * 2);
  const iv = envelope.subarray(1 + SEALED_KEY_LEN * 2, HEADER_LEN);
  const ciphertext = envelope.subarray(HEADER_LEN);

  // Защита в глубину (И-3, ревью координатора): `Uint8Array.subarray` молча
  // КЛИПУЕТ к фактической длине, а не бросает — если бы проверка длины
  // заголовка выше когда-нибудь разошлась с этими смещениями (регресс,
  // будущий рефактор), срезы получились бы КОРОЧЕ ожидаемых, и такой срез,
  // доехав до `openSealed`/libsodium как есть, бросает `TypeError`
  // («ciphertext is too short» и подобные — собственная проверка длины
  // библиотеки). Это НЕ наш мусор на входе — источник обрубка чужой
  // (короткий envelope с сети), но выглядело бы как наш собственный баг,
  // тот же костюм наизнанку, что и с классами исключений openSealed выше.
  // Явная проверка формы здесь не полагается на то, что где-то ВЫШЕ уже
  // отсеяно верно — независимый второй слой.
  if (sealedSlotA.length !== SEALED_KEY_LEN || sealedSlotB.length !== SEALED_KEY_LEN || iv.length !== IV_LEN) {
    return null;
  }

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
    // Заголовок ЦЕЛИКОМ — тот же AAD, что packEnvelope связал с тегом при
    // шифровании (К-1, ревью координатора). Подмена ЛЮБОГО байта заголовка
    // (версия, любой из двух слотов, вектор) рвёт проверку тега здесь —
    // ОДИНАКОВО для обеих сторон, независимо от того, чей слот задет.
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(header) },
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
