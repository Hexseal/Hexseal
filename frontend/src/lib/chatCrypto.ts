import { keccak256, concat, stringToBytes, hexToBytes, hashTypedData } from 'viem';

export type ChatKeypair = { publicKey: Uint8Array; privateKey: Uint8Array };

/**
 * EIP-712 доменный сепаратор для входа в чат — НЕ голый `personal_sign`.
 *
 * Голая строка (`personal_sign` над `'hexseal.chat.key.v1'`) не привязана ни
 * к какому домену: любой сайт может попросить подписать ровно эту строку и
 * получить постоянный, неотзываемый ключ ко всей переписке человека. Одно
 * подписанное окно на фишинговом сайте — и всё.
 *
 * EIP-712 не устраняет фишинг полностью (кошелёк не проверяет соответствие
 * `domain` фактическому origin сайта), но кошелёк рендерит структурированный
 * запрос — `domain`/`primaryType`/поля — вместо непрозрачной строки, и это
 * тот минимум, который вообще возможен без смены модели подписи кошельков.
 *
 * Экспортируется ЦЕЛИКОМ (не только имя/строка) и НЕ по частям — `CHAT_KEY_TYPES`
 * и `CHAT_KEY_DOMAIN` ниже намеренно НЕ экспортированы, только собранный из
 * них `CHAT_KEY_TYPED_DATA`. Вызывающая сторона обязана подписывать строго
 * это: `walletClient.signTypedData(CHAT_KEY_TYPED_DATA)`. Если бы `TYPES` и
 * `DOMAIN` были доступны отдельно, ничто не мешало бы собрать структуру
 * заново с другим содержимым и подписать не то, из чего фактически выводится
 * ключ — единственный источник истины обязан быть один объект, без варианта
 * пересборки.
 *
 * Версия зашита и в `domain.version`, и в `message.purpose`: смена
 * любого поля здесь — миграция, меняющая ключ у ВСЕХ существующих
 * пользователей разом и делающая их прежнюю переписку нечитаемой. Это не
 * только описание в комментарии — структура целиком подмешивается в семя
 * ниже (`hashTypedData(CHAT_KEY_TYPED_DATA)`), так что смена ЛЮБОГО поля
 * здесь меняет производный ключ напрямую, а не только по документации.
 * `chainId`/`verifyingContract` намеренно не включены: ключ чата не должен
 * зависеть от того, к какой сети подключён кошелёк в момент подписи, а
 * протокол сегодня существует только в одной, тестовой, сети.
 */
const CHAT_KEY_TYPES = {
  ChatKey: [{ name: 'purpose', type: 'string' }],
} as const;

const CHAT_KEY_DOMAIN = {
  name: 'Hexseal',
  version: '1',
} as const;

export const CHAT_KEY_TYPED_DATA = {
  domain: CHAT_KEY_DOMAIN,
  types: CHAT_KEY_TYPES,
  primaryType: 'ChatKey',
  message: { purpose: 'hexseal.chat.key.v1' },
} as const;

/** EIP-712-дайджест структуры выше, посчитанный один раз при загрузке модуля
 *  (структура фиксирована, пересчитывать на каждый вызов незачем). Подмешивается
 *  в семя ниже — это и делает тест-замок на `CHAT_KEY_TYPED_DATA` несущим:
 *  без этой подмеси структуру можно было бы поменять, а вывод ключа этого бы
 *  не заметил (ровно так был найден дефект N1 в ревью Задачи 2, раунд 2). */
const CHAT_KEY_STRUCT_HASH = hashTypedData(CHAT_KEY_TYPED_DATA);

/** Метка назначения внутри семени — не путать с EIP-712 доменом выше. Это
 *  разводит ключ ЧАТА и любой будущий ключ на ту же подпись (например, для
 *  шифрования вложений отдельным алгоритмом): без метки оба совпали бы,
 *  потому что подпись кошелька для входа в чат одна и та же. */
const CHAT_KEY_SEED_CONTEXT = 'hexseal.chat.key.seed.v1';

/** Ровно 65-байтовая ECDSA-подпись (`r ‖ s ‖ v`), в hex с `0x` — 130 hex-цифр
 *  после префикса. Любая другая строка (пустая, обрезанная, произвольный
 *  текст) НЕ подпись и не должна тихо давать валидную пару: `keccak256` в
 *  viem на невалидном hex не бросает, а молча хеширует как UTF-8-текст —
 *  значит без этой проверки константа вроде `'undefined'` вывела бы ОДНУ И
 *  ТУ ЖЕ пару у всех, кому она когда-либо прилетела по этому пути. */
const SIGNATURE_HEX_RE = /^0x[0-9a-f]{130}$/;

/**
 * Подпись — 65 байт и распределена неравномерно, поэтому ключом быть не
 * может. Хешируем в 32 байта и подаём как семя, смешивая три составляющих:
 * метку назначения (`CHAT_KEY_SEED_CONTEXT`), саму подпись и EIP-712-дайджест
 * структуры, которую эта подпись подписывает (`CHAT_KEY_STRUCT_HASH`).
 * Последнее — не украшение: без него замена содержимого `CHAT_KEY_TYPED_DATA`
 * (домен, версия, поле сообщения) никак не повлияла бы на производный ключ,
 * и тест-замок на структуру был бы декоративным, а не несущим. Регистр
 * подписи приводим к нижнему до проверки формата и до вывода: кошельки
 * отдают hex-цифры по-разному (а `0x`/`0X` — тем более), а ключ обязан
 * получаться один и тот же.
 *
 * `libsodium-wrappers` импортируется только динамически (`await import`) —
 * статический импорт кладёт ~147 КБ gzip в общий чанк сборки Next
 * (docs/superpowers/reports/2026-08-02-chat-crypto-library-choice.md, §6).
 *
 * @throws {Error} если `signature` не 65-байтовая hex-строка — намеренно
 *   громко: молчаливый приём мусора здесь означает молчаливую утечку ключа
 *   (все, кто подал один и тот же мусорный вход, получают одну пару).
 */
export async function deriveChatKeypair(signature: `0x${string}`): Promise<ChatKeypair> {
  const sig = signature.toLowerCase() as `0x${string}`;
  if (!SIGNATURE_HEX_RE.test(sig)) {
    throw new Error('deriveChatKeypair: ожидается 65-байтовая hex-подпись (0x + 130 hex-цифр)');
  }

  const seed = keccak256(
    concat([
      stringToBytes(CHAT_KEY_SEED_CONTEXT),
      hexToBytes(sig),
      hexToBytes(CHAT_KEY_STRUCT_HASH),
    ]),
    'bytes',
  );

  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;

  const { publicKey, privateKey } = sodium.crypto_box_seed_keypair(seed);
  return { publicKey, privateKey };
}

/** Запечатать для получателя. Отправитель анонимен на уровне шифротекста —
 *  библиотека сама заводит одноразовую пару, поэтому одинаковый текст даёт
 *  разные мешки. Кто отправил, устанавливается подписью в цепочке
 *  (lib/chatChain.ts), а не шифрованием.
 *
 *  Сигнатура строго `Uint8Array` (не `Uint8Array | string`, как принимает
 *  сама библиотека) — и это проверяется НА ИСПОЛНЕНИИ, не только типами.
 *  Сама `libsodium-wrappers` принимает `string` и молча кодирует её в UTF-8:
 *  типизированный вызов TS отловит, но строка, прошедшая через `any`
 *  (например, `JSON.parse(...)` при разборе мешка из сети — самый вероятный
 *  вид на проводе в Задачах 4-5), доедет до библиотеки живой и запечатается
 *  без единой ошибки. `deriveChatKeypair` выше по этому же файлу уже
 *  проверяет свой вход на исполнении по той же причине («молчаливый приём
 *  мусора — молчаливая утечка/порча»); здесь та же норма.
 *
 *  @throws {TypeError} если `recipientPublicKey` или `plaintext` не
 *    `Uint8Array` (в т.ч. пришли из `any`/JSON) — или если `recipientPublicKey`
 *    не 32 байта. Это наши негодные данные на входе, не событие протокола,
 *    поэтому не гасится. */
export async function sealForRecipient(
  recipientPublicKey: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  if (!(recipientPublicKey instanceof Uint8Array)) {
    throw new TypeError('sealForRecipient: recipientPublicKey должен быть Uint8Array (не строка/иное)');
  }
  if (!(plaintext instanceof Uint8Array)) {
    throw new TypeError('sealForRecipient: plaintext должен быть Uint8Array (не строка/иное)');
  }

  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  return sodium.crypto_box_seal(plaintext, recipientPublicKey);
}

/** Вскрыть своей парой.
 *
 *  `null` вместо исключения намеренно: мешок не для нас или повреждён —
 *  ожидаемая ситуация, а не сбой. Исключение заставило бы оборачивать каждый
 *  вызов в try/catch, и однажды кто-нибудь напишет пустой.
 *
 *  НО ловим только `Error`. `TypeError` библиотека бросает, когда МЫ передали
 *  негодные данные: обрезанный мешок, ключ не той длины. Схлопнуть оба класса
 *  в `null` значило бы выдать наш собственный баг за «это письмо не для вас» —
 *  сбой под видом штатного исхода. Разница установлена прогоном библиотеки
 *  в Задаче 1 и застёгнута тестами в chatCrypto.test.ts. Порядок проверки
 *  важен: `TypeError` наследует `Error`, поэтому `instanceof TypeError`
 *  проверяется первым и пробрасывается — иначе он тоже схлопнулся бы в
 *  `catch (err) { return null }` как обычный `Error`.
 *
 *  Проверка `sealed instanceof Uint8Array` — ДО `try`, по той же логике, по
 *  которой `sodium.ready` вынесен из `try` выше: замеры на живом модуле
 *  показали, что строка вместо байт (например, base64-мешок из JSON, не
 *  декодированный перед вызовом) не всегда доходит до библиотеки как
 *  ошибка — иногда это тихая пустота без единого исключения, что для
 *  вызывающего неотличимо от «нам ничего не прислали». Если бы проверка
 *  жила внутри `try`, наш собственный бросок TypeError тоже поймался бы
 *  этим же `catch` — сработала бы верно (там уже есть `instanceof
 *  TypeError` → rethrow), но раскладка расползлась бы: гарантия входа
 *  была бы неотличима от гарантий самой криптографии. Вход валидируется
 *  до какой-либо попытки его расшифровать. */
export async function openSealed(
  myKeypair: ChatKeypair,
  sealed: Uint8Array,
): Promise<Uint8Array | null> {
  if (!(sealed instanceof Uint8Array)) {
    throw new TypeError('openSealed: sealed должен быть Uint8Array (не строка/иное)');
  }

  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  try {
    return sodium.crypto_box_seal_open(sealed, myKeypair.publicKey, myKeypair.privateKey);
  } catch (err) {
    if (err instanceof TypeError) throw err; // наш мусор на входе — наружу
    return null;                              // не наш мешок — штатный путь
  }
}
