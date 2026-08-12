/**
 * presentationStand.ts — оснастка сквозного стенда 4в:
 * «сторона предъявила переписку → арбитр прочитал».
 *
 * ЧЕМ ЭТОТ СТЕНД ОТЛИЧАЕТСЯ ОТ ОБЫЧНОГО ТЕСТА (таблица — справочник оснастки §7):
 *   ключи        — настоящие: пара чата выводится настоящим `deriveChatKeypair`
 *                  из НАСТОЯЩЕЙ подписи кошелька над `CHAT_KEY_TYPED_DATA`;
 *   отправка     — настоящая `sendMessage`: голова разговора, архив, замок
 *                  между вкладками (`navigator.locks` в node 24 настоящий);
 *   вложение     — настоящий `encryptFile` (AES-GCM, настоящий ключ) И НАСТОЯЩИЙ
 *                  ПУТЬ ЗАМКА: payload собирается ДОСЛОВНО как в `sendFile`
 *                  (`usePairChat.ts:1266-1279`) — `keyHex`/`ivHex`, `fileKey`,
 *                  `chunked` — и НИКАКОГО `sealedKey` стенд не кладёт. Замок
 *                  ставит боевой путь отправки; где именно — дело Задачи 3
 *                  (естественное место — `packEnvelope`: только он знает оба
 *                  ключа, `chatEnvelope.ts`, `sealAttachmentKeyForWire`). Стенд
 *                  мерит ПРОВОД: распечатывает свой же кадр и смотрит, что там
 *                  `sealedKey` есть, а `keyHex`/`ivHex` НЕТ. Положи стенд замок
 *                  сам — он измерял бы свою собственную работу;
 *   склад        — единственная подделка на пути наружу, и она ГРОМКАЯ:
 *                  любой запрос, кроме `PUT /bags/:recipient`, БРОСАЕТ;
 *   диск         — общая подделка `installFakeChatDisk` (не своя копия: две
 *                  подделки одного хранилища расходятся молча, см. её шапку).
 *
 * ⚠️ `vitest` ЗДЕСЬ НЕ ИМПОРТИРУЕТСЯ. Пакет лежит в `../relayer/node_modules` и
 * из `frontend/` не резолвится: `npm run type-check` покраснел бы на импорте.
 * Та же причина и тот же обход, что в `chatStand.ts` и `fakeChatDisk.ts`.
 *
 * ⚠️ И ЗАМКИ ФОРМЫ (`formLocks` в конце файла) ЛЕЖАТ ИМЕННО ЗДЕСЬ. Замер:
 * `frontend/tsconfig.json` в `exclude` выбрасывает файлы вида `*.test.ts`
 * (маска с двумя звёздочками и слэшем перед именем — не пишу её здесь одним
 * куском: та самая последовательность «звёздочка, слэш» закрыла бы этот
 * блочный комментарий на середине фразы, находка 11 августа на
 * `chatPayloadForm.ts`) из программы tsc целиком — `@ts-expect-error` в
 * тестовом файле не читает никто, а `npm test` типы стирает. Файл без
 * суффикса `.test` в программе есть.
 *
 * ⚠️ РАСХОЖДЕНИЕ С ЗАДАНИЕМ, НАЗВАНО ВСЛУХ (проверено чтением `presentation.ts`
 * на HEAD этой ветки, 11 августа). Задание описывало `buildPresentation`'s
 * `arbiterBoxKey`/`peerBoxKey` как голый `Uint8Array`. На деле это фирменные
 * (nominal) типы `ArbiterBoxKeyBytes`/`PeerBoxKeyBytes` — клеймо завели ПОСЛЕ
 * того, как задание было написано (коммит `23ea3cc`, «клеймо ключей печати»,
 * доработка ревью: перестановка `arbiterBoxKey`↔`peerBoxKey` в реальном вызове
 * давала 0 ошибок компилятора и ловилась только прогоном). Этот файл голых
 * байт печати наружу не передаёт (только `StandActors.arbiter.boxKey:
 * Uint8Array`, как и было задумано — стенд границу hex↔байты не переходит), а
 * клеймение на месте вызова `buildPresentation` делает `presentationStand.test.ts`
 * через `toArbiterBoxKeyBytes`/`toPeerBoxKeyBytes` из `presentation.ts`.
 */
import { createWalletClient, http, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import {
  // ⚠️ `sealForRecipient` здесь НЕ импортируется намеренно: стенд ничего не
  // запечатывает сам — ни разовый ключ, ни ключ вложения. Всё запечатывает
  // боевой путь, стенд только вскрывает и сверяет.
  CHAT_KEY_TYPED_DATA, deriveChatKeypair, openSealed,
  type ChatKeypair,
} from '../chatCrypto';
import type { ChatSession } from '../chatSession';
import type { ChainLink } from '../chatChain';
import { SEALED_ATTACHMENT_KEY_HEX_LEN, type ChatPayload } from '../chatPayloadForm';
import { encryptFile } from '../fileCrypto';
import {
  archiveConversationFrames, decodeFrame, readConversationArchive, sendMessage,
  _resetConversationMemoryForTest, _resetParseCacheForTest,
  type ArchivedFrame,
} from '../chatConversation';
import { openEnvelopeWithOneTimeKey, recoverOneTimeKey } from '../chatEnvelope';
import type { DeclaredCounts, MeasuredCounts } from '../presentation';
import type { PresentationView, PresentedMessage } from '../presentationRead';
import { installFakeChatDisk, type FakeChatDisk } from './fakeChatDisk';

/** Базис времени — тот же, что у общей заготовки цепочки в проекте
 *  (`chatConversation.test.ts`, `forgeChain`). Фиксированное число вместо
 *  `Date.now()`: `sentAt` подписан, а порядок в архиве считается по нему —
 *  плавающие часы дали бы стенд, мигающий по причине стенда. */
export const T0 = 1_754_400_000_000;

/** Пропуск склада. Настоящий не нужен: склада нет, приёмник его не читает. Но
 *  подать обязаны — `sendMessage` берёт его из `opts` и передаёт в `putBag`.
 *  Форма — как в `chatConversation.test.ts`. */
const PASS = 'v1.dGVzdC5wYXNz.mac';

/** Адрес агримента, он же метка сделки. Форма — `0x` + 40 hex
 *  (`DEAL_ID_RE`, `chatPayloadForm.ts`), НЕ bytes32. */
export const DEAL_ID = '0x000000000000000000000000000000000000dea1' as `0x${string}`;

/** Слова переписки. ⚠️ В `a2` нарочно живут длинное тире, кавычки-ёлочки,
 *  неразрывные пробелы и знак рубля: «от „я ему говорил" до „да ты фигню
 *  намутил" разница колоссальная» (§3 замысла) — значит текст обязан доехать до
 *  арбитра ПОБАЙТОВО, а не «примерно». Управляющих и нулевой ширины символов
 *  здесь нарочно НЕТ: их однажды может законно вычистить гейт формы, и запирать
 *  их выживание значило бы запирать не то. */
export const TEXTS = {
  a0: 'смета на тридцать, срок — пятница',
  a1: 'файл жду до восьми вечера, не позже',
  a2: 'принял, но правки нужны — «шапка» и цена 30 000 ₽',
  b0: 'ключ я тогда ещё не менял',
  b1: 'вот работа, как договаривались',
  b2: 'правки — это ещё десять сверху',
} as const;

/** Сколько всего сообщений в переписке. Золотое число: сумма трёх и трёх. */
export const TOTAL_MESSAGES = 6;

/* ─────────────────────────── hex без 0x ─────────────────────────── */
/* Единственные hex-поля на всём пути (исправление 2 договора): `keyHex`/`ivHex`
 * из `fileCrypto` (он пишет БЕЗ префикса — `bytesToHex`, fileCrypto.ts:5-7,
 * поэтому viem-овские `hexToBytes`/`toHex` тут не годятся) и `file.sealedKey`
 * (368 строчных hex-цифр). Всё остальное — base64, и его разбирает
 * `bytesFromB64` из `presentation.ts`, а не этот файл. */

function hexBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`стенд: ожидался hex без 0x чётной длины, получено «${hex.slice(0, 24)}…»`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ──────────────────── снятие замка с ключа вложения ──────────────────── */

/**
 * Снять замок с ключа вложения своей парой. `null` — «не мой ни один из двух».
 *
 * ⚠️ ЗАПЕЧАТЫВАНИЯ ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО. Замок ставит боевой путь
 * отправки (Задача 3), стенд подаёт `keyHex`/`ivHex` ровно как `sendFile` и
 * потом ПРОВЕРЯЕТ провод. Своя укладка в стенде означала бы, что T2 мерит
 * работу стенда, а не работу кода: замер, зелёный независимо от того, ставит ли
 * боевой путь замок вообще, — ровно тот класс промаха, который здесь запрещён.
 *
 * ⚠️ Функции вскрытия договор v2 так и не назвал (см. «Возражения»): названы
 * только вид и длина — 368 строчных hex-цифр, два слота по 92 байта
 * (`SEALED_ATTACHMENT_KEY_HEX_LEN`, исправление 2). Поэтому вскрытие здесь
 * своё, и оно НЕ ЗНАЕТ ПОРЯДКА слотов: пробуются оба, как это делает читатель
 * самого конверта (`chatEnvelope.ts`, `openAttachmentKey`, проба «A, потом
 * B»). Разойдись Задача 3 с этой укладкой — красным станет T2 в одном
 * названном месте.
 */
export async function openAttachmentKey(
  sealedKey: string, own: ChatKeypair,
): Promise<{ keyHex: string; ivHex: string } | null> {
  if (sealedKey.length !== SEALED_ATTACHMENT_KEY_HEX_LEN) {
    throw new Error(
      `стенд: замок вложения должен быть ${SEALED_ATTACHMENT_KEY_HEX_LEN} hex-цифр, ` +
      `получено ${sealedKey.length} («${sealedKey.slice(0, 16)}…»)`,
    );
  }
  const bytes = hexBytes(sealedKey);           // 184 байта = два слота по 92
  const half = bytes.length / 2;
  for (const slot of [bytes.subarray(0, half), bytes.subarray(half)]) {
    const raw = await openSealed(own, slot);
    // 44 = ключ 32 ‖ iv 12. Число записано руками: возьми его из `fileCrypto`,
    // и замер стал бы тождеством по построению (исправление 12 договора).
    if (raw && raw.length === 44) {
      return { keyHex: toHex(raw.subarray(0, 32)), ivHex: toHex(raw.subarray(32)) };
    }
  }
  return null;
}

/* ──────────────────────────── актёры ──────────────────────────── */

export interface StandActor {
  account: PrivateKeyAccount;
  /** Адрес С КОНТРОЛЬНОЙ СУММОЙ — ровно как отдаёт `useAccount()`. */
  address: `0x${string}`;
  session: ChatSession;
  wallet: WalletClient;
}

export interface StandActors {
  /** Предъявитель. */
  presenter: StandActor;
  /** Собеседник. Заверения кошельком в предъявлении НЕ будет — так и задумано. */
  peer: StandActor;
  /**
   * Арбитр: только пара чата. Кошелёк ему здесь ни к чему — читает он ключом.
   *
   * ⚠️ `boxKey` ЗДЕСЬ — **байты** (`Uint8Array`), ровно как их ждёт вход
   * `buildPresentation` ПО СМЫСЛУ (Задача 5). На проводе типа сегодня это
   * фирменный `ArbiterBoxKeyBytes`/`PeerBoxKeyBytes` (см. предупреждение в
   * шапке файла) — клеймение на границе вызова делает `present()` в
   * `presentationStand.test.ts`, а не этот файл: стенд границу hex↔байты не
   * переходит ни разу, он берёт `keypair.publicKey`, то есть уже байты.
   */
  arbiter: { keypair: ChatKeypair; boxKey: Uint8Array };
  /** Прежний ключ арбитра — «он сменил ключ посреди спора» (§9 замысла).
   *  `boxKey` — байты, по той же причине, что выше. */
  arbiterStale: { keypair: ChatKeypair; boxKey: Uint8Array };
  /** Прежняя пара предъявителя — «кадр пришёл до смены ключа» (§15.5).
   *  Пара настоящая; синтетическая только подпись, потому что прежняя подпись
   *  кошелька в жизни не хранится нигде. Форма подписи настоящая: 65 байт,
   *  иначе `deriveChatKeypair` не доедет (chatCrypto.ts). */
  presenterStale: ChatKeypair;
}

function signatureOf(marker: string): `0x${string}` {
  const body = marker.repeat(130).slice(0, 130).replace(/[^0-9a-f]/g, 'a');
  return `0x${body}` as `0x${string}`;
}

async function actorFrom(pk: `0x${string}`): Promise<StandActor> {
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({
    account,
    chain: baseSepolia,
    // ⚠️ Транспорт заведомо мёртвый, и это НАМЕРЕННО: подпись локального
    // аккаунта viem делает на месте, к узлу не ходя вовсе. Любой поход в сеть
    // на этом стенде обязан упасть, а не тихо сработать.
    transport: http('http://127.0.0.1:1'),
  });
  const signature = await account.signTypedData(CHAT_KEY_TYPED_DATA as never);
  return {
    account,
    address: account.address,
    wallet,
    session: {
      keypair: await deriveChatKeypair(signature),
      address: account.address,
      origin: 'signature',
      walletKind: 'eoa',
      restored: true,
      persisted: true,
    },
  };
}

async function chatPairOf(pk: `0x${string}`): Promise<{ keypair: ChatKeypair; boxKey: Uint8Array }> {
  const keypair = await deriveChatKeypair(
    await privateKeyToAccount(pk).signTypedData(CHAT_KEY_TYPED_DATA as never),
  );
  return { keypair, boxKey: keypair.publicKey };
}

export async function makeActors(): Promise<StandActors> {
  const [presenter, peer, arbiter, arbiterStale, presenterStale] = await Promise.all([
    actorFrom(`0x${'a1'.repeat(32)}`),
    actorFrom(`0x${'b0'.repeat(32)}`),
    chatPairOf(`0x${'c3'.repeat(32)}`),
    chatPairOf(`0x${'c4'.repeat(32)}`),
    deriveChatKeypair(signatureOf('01d5')),
  ]);
  // Замок на саму заготовку: три пары обязаны быть РАЗНЫМИ. Совпади любые две
  // — стенд перестал бы мерить «третье лицо» и остался бы зелёным.
  const seen = new Set([
    toHex(presenter.session.keypair.publicKey), toHex(peer.session.keypair.publicKey),
    toHex(arbiter.boxKey), toHex(arbiterStale.boxKey), toHex(presenterStale.publicKey),
  ]);
  if (seen.size !== 5) throw new Error('стенд: пары ключей совпали — актёры собраны неверно');
  return { presenter, peer, arbiter, arbiterStale, presenterStale };
}

/* ───────────────────── приёмник мешков вместо склада ───────────────────── */

export interface BagSink {
  /** Ключ мешка → байты, реально ушедшие «на склад». */
  stored: Map<string, Uint8Array>;
  restore: () => void;
}

/**
 * Подделка ровно одного маршрута — `PUT /bags/:recipient`. Всё остальное
 * БРОСАЕТ: молчаливый 200 на неизвестный запрос — это стенд, мерящий не то.
 *
 * ⚠️ Ответ — настоящий `Response`, не литерал: `putBag` читает `res.ok`,
 * `res.json()` и `res.headers.get('retry-after')` (`chatTransport.ts`), и на
 * объекте-заглушке проверял бы нашу заглушку, а не боевой разбор. Ставится
 * прямым присваиванием в `globalThis`, без `vi.stubGlobal` — по той же
 * причине, по которой здесь нет импорта `vitest`.
 */
export function installBagSink(): BagSink {
  const stored = new Map<string, Uint8Array>();
  const host = globalThis as { fetch?: typeof fetch };
  const had = Object.prototype.hasOwnProperty.call(host, 'fetch');
  const previous = host.fetch;
  let n = 0;

  host.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.href : String((input as { url?: string }).url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const m = /\/bags\/(0x[0-9a-fA-F]{40})$/.exec(url);
    if (method !== 'PUT' || !m) {
      throw new Error(`стенд: неожидаемый запрос ${method} ${url} — этот стенд без сети`);
    }
    const body = init?.body as Uint8Array;
    if (!(body instanceof Uint8Array) || body.length === 0) {
      throw new Error('стенд: в PUT /bags пришло не тело мешка');
    }
    // Ключ мешка — `<получатель>/<файл>.bin`: получателя из него разбирает
    // боевой `recipientOfKey` (chatConversation.ts), и без этой формы отбор
    // «мешок этой переписки» работал бы не так, как в бою.
    const key = `${m[1].toLowerCase()}/${String(++n).padStart(4, '0')}-stand.bin`;
    stored.set(key, new Uint8Array(body));
    return new Response(JSON.stringify({ key }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return {
    stored,
    restore: () => {
      if (had) host.fetch = previous;
      else delete host.fetch;
    },
  };
}

/* ──────────────────────────── переписка ──────────────────────────── */

export interface StandFile {
  /** Открытые байты — для сверки «расшифровалось байт в байт». */
  bytes: Uint8Array;
  /** Зашифрованные байты, как они лежали бы на файловом сервере. */
  encrypted: Uint8Array;
  /** ⚠️ ОТКРЫТЫЙ ключ вложения от настоящего `encryptFile`. Стенд подаёт его в
   *  payload ровно как `sendFile`, и он ОБЯЗАН исчезнуть с провода. */
  keyHex: string;
  ivHex: string;
  name: string;
  size: number;
  mime: string;
  url: string;
  /** Как у `uploadFileWithEncryption`: единственный способ обновить `url`. */
  fileKey: string;
}

export interface StandConversation {
  /** Всё, что лежит на устройстве предъявителя. Ровно 6 кадров. */
  frames: ArchivedFrame[];
  /** Звенья предъявителя, seq 0..2. */
  own: ChainLink[];
  /** Звенья собеседника, seq 0..2. */
  peer: ChainLink[];
  file: StandFile;
  /**
   * ⚠️ ПРОВОД. Вложение, каким оно ДОЕХАЛО до предъявителя: `file` из payload'а
   * кадра B#1, распечатанного боевой парой Задачи 2 (`recoverOneTimeKey` →
   * `openEnvelopeWithOneTimeKey`) его собственным ключом. Здесь и только здесь
   * видно, поставил ли боевой путь замок на ключ вложения: стенд его не ставил.
   */
  wireFile: NonNullable<ChatPayload['file']>;
  /** Тот же распечатанный payload строкой — для сверки БАЙТАМИ, а не полями. */
  wirePayloadJson: string;
}

/**
 * Шесть сообщений вперемешку, настоящей отправкой. Раскладка:
 *
 *   A#0  t+1000  текст                                    — НЕ предъявляется
 *   B#0  t+2000  текст, запечатанный на ПРЕЖНЮЮ пару А     — предъявляется, но
 *                                                            подготовить нельзя
 *   A#1  t+3000  текст                                    — предъявляется
 *   B#1  t+4000  ВЛОЖЕНИЕ + текст                         — предъявляется
 *   A#2  t+5000  текст (тире, ёлочки, ₽)                  — предъявляется
 *   B#2  t+6000  текст                                    — НЕ предъявляется
 *
 * ⚠️ ЗДЕСЬ НЕТ ПОДДЕЛКИ КАДРА, И ЭТО НАХОДКА, А НЕ УПУЩЕНИЕ. Черновик задачи
 * портил байт кадра ДО архивирования на устройстве предъявителя (`FrameTamper`,
 * снят отсюда 11 августа). Замерено: `buildPresentation` (Задача 5) вызывает
 * ТОТ ЖЕ `verifyFrameEvidence` над своей копией переписки ДО сборки контейнера
 * (`presentation.ts`, «то, что арбитр гарантированно назовёт подделкой,
 * предъявителю предъявлять незачем») — испорченный здесь кадр уезжает в
 * `notPrepared` и до `container.frames` не доезжает вовсе, то есть до арбитра
 * ему дойти неоткуда. Это ровно третье требование из «Возражения» задания
 * (пункт 6, третья точка — «кадр, не прошедший проверку предъявителя, всё
 * равно предъявляется»), которое договор v2/v3 НЕ принял, и задание само
 * предупреждало: «разойдись Задача 5 — красным станет мой файл, а не её».
 * Единственная точка на пути «предъявитель подписал → арбитр читает» без
 * склада, где корректный по подписи контейнера кадр всё ещё может быть
 * испорчен байтово, — это ПОСЛЕ `buildPresentation`, на самом контейнере (тем
 * же приёмом, каким T5 портит `dealId`). Поэтому подделку кадра для T4 делает
 * `presentationStand.test.ts` над уже собранным контейнером, а не эта
 * функция — подробности в отчёте задачи 7, таблица «расхождения с заданием».
 */
export async function buildConversation(actors: StandActors): Promise<StandConversation> {
  const A = actors.presenter.address;
  const B = actors.peer.address;
  const ownPub = actors.presenter.session.keypair.publicKey;
  const peerPub = actors.peer.session.keypair.publicKey;

  // ─── Вложение: настоящий AES-GCM настоящего боевого шифровальщика ───
  const bytes = new Uint8Array(3 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff; // детерминированно
  const name = 'смета-v3.pdf';
  const mime = 'application/pdf';
  const enc = await encryptFile(new File([bytes], name, { type: mime }));
  const fileKey = '1754400000000-stand.bin';
  const file: StandFile = {
    bytes,
    encrypted: new Uint8Array(await enc.encryptedBlob.arrayBuffer()),
    // ⚠️ Открытые ключ и iv — как их отдаёт боевой шифровальщик. Замка стенд
    // НЕ СТАВИТ: его обязан поставить путь отправки (Задача 3), и именно это
    // проверяет T2 по проводу.
    keyHex: enc.keyHex,
    ivHex: enc.ivHex,
    name,
    size: bytes.length,
    mime,
    url: `http://127.0.0.1:1/files/${fileKey}`,
    fileKey,
  };
  if (file.encrypted.length !== bytes.length + 16) {
    throw new Error(`стенд: шифротекст вложения ${file.encrypted.length} байт, ожидалось ${bytes.length + 16}`);
  }

  const own: ChainLink[] = [];
  const peerLinks: ChainLink[] = [];
  const peerFrames: ArchivedFrame[] = [];

  const sendOwn = async (payload: ChatPayload, at: number): Promise<void> => {
    const sent = await sendMessage(
      actors.presenter.session, B, peerPub, payload,
      own.length ? own[own.length - 1] : null, { pass: PASS, now: () => at },
    );
    own.push(sent.link);
  };

  const sendPeer = async (payload: ChatPayload, at: number, toPub: Uint8Array): Promise<void> => {
    const sent = await sendMessage(
      actors.peer.session, A, toPub, payload,
      peerLinks.length ? peerLinks[peerLinks.length - 1] : null, { pass: PASS, now: () => at },
    );
    peerLinks.push(sent.link);

    const frame = new Uint8Array(sent.frame);

    // ⚠️ ТОЧНО КАК В БОЮ: чужой кадр ложится на устройство с `seq: 0` и
    // `sentAt` = временем склада (`usePairChat.ts`, кадр не разбирается —
    // «подлинность проверяет receiveBags на каждом чтении заново»). Значит
    // предъявление ОБЯЗАНО читать номер из БАЙТОВ кадра, а не из поля записи
    // (evidence §7, ⚠️). Стенд врёт ровно так же, как врёт бой.
    peerFrames.push({
      key: sent.key, from: B.toLowerCase() as `0x${string}`,
      seq: 0, sentAt: at, receivedAt: at, frame,
    });
  };

  await sendOwn({ text: TEXTS.a0, dealId: DEAL_ID }, T0 + 1000);
  await sendPeer({ text: TEXTS.b0, dealId: DEAL_ID }, T0 + 2000, actors.presenterStale.publicKey);
  await sendOwn({ text: TEXTS.a1, dealId: DEAL_ID }, T0 + 3000);
  await sendPeer(
    {
      text: TEXTS.b1,
      // ⚠️ ДОСЛОВНО КАК `sendFile` (`usePairChat.ts:1266-1279`): открытые
      // `keyHex`/`ivHex`, `fileKey`, `chunked`, `mime` — и НИ СЛОВА про
      // `sealedKey`. Единственное расхождение: `dealId` здесь ставится руками,
      // а в бою его дописывает движок (`usePairChat`, опции `dealId`).
      file: {
        url: file.url, name: file.name, size: file.size, mime: file.mime,
        keyHex: file.keyHex, ivHex: file.ivHex, fileKey: file.fileKey,
        chunked: false,
      },
      dealId: DEAL_ID,
    },
    T0 + 4000, ownPub,
  );
  await sendOwn({ text: TEXTS.a2, dealId: DEAL_ID }, T0 + 5000);
  await sendPeer({ text: TEXTS.b2, dealId: DEAL_ID }, T0 + 6000, ownPub);

  await archiveConversationFrames(A, B, peerFrames);

  const frames = await readConversationArchive(A, B);
  // Замки на саму заготовку. Числа врал стенд, а не код — в этой же области
  // такое уже было (см. шапку `fakeChatDisk.ts`), и второй раз незачем.
  if (frames.length !== TOTAL_MESSAGES) {
    throw new Error(`стенд собрал не то: на устройстве ${frames.length} кадров вместо ${TOTAL_MESSAGES}`);
  }
  if (own.map(l => l.seq).join() !== '0,1,2' || peerLinks.map(l => l.seq).join() !== '0,1,2') {
    throw new Error(`стенд собрал не то: номера ${own.map(l => l.seq)} / ${peerLinks.map(l => l.seq)}`);
  }

  /* ─── ПРОВОД: распечатать свой же кадр вложения боевым путём ───
   *
   * Номер берётся ИЗ БАЙТОВ (`decodeFrame`), а не из поля записи: у чужих
   * кадров `seq` в архиве равен нулю всегда (ловушка 4). Ключ добывается
   * настоящим `recoverOneTimeKey` — АСИНХРОННЫМ (исправление 1 договора: без
   * `await` проверка «не null» не могла бы упасть вовсе).
   *
   * Отказ на любом шаге — ошибка ЗАГОТОВКИ, поэтому бросок: если стенд не
   * может распечатать сообщение, которое сам же и отправил, все шесть замеров
   * ниже мерили бы неизвестно что. */
  const attachmentFrame = frames
    .map(f => ({ f, d: decodeFrame(f.frame) }))
    .find(({ d }) => d && d.link.seq === 1 && d.link.sender === B.toLowerCase());
  if (!attachmentFrame?.d) {
    throw new Error('стенд: кадр вложения (B#1) не нашёлся в архиве или не разобрался');
  }
  const oneTime = await recoverOneTimeKey(attachmentFrame.d.envelope, actors.presenter.session.keypair);
  if (!oneTime) {
    throw new Error('стенд: разовый ключ кадра вложения не добылся ключом получателя');
  }
  const opened = await openEnvelopeWithOneTimeKey(
    attachmentFrame.d.envelope, oneTime, B.toLowerCase() as `0x${string}`,
  );
  if (!opened.ok) {
    throw new Error(`стенд: кадр вложения не распечатался своим же ключом: ${opened.reason}`);
  }
  const wireFile = opened.payload.file;
  if (!wireFile) {
    throw new Error('стенд: в распечатанном кадре B#1 вложения нет вовсе');
  }

  return {
    frames, own, peer: peerLinks, file,
    wireFile, wirePayloadJson: JSON.stringify(opened.payload),
  };
}

/* ──────────────────────────── стенд целиком ──────────────────────────── */

export interface PresentationStand {
  actors: StandActors;
  conversation: StandConversation;
  disk: FakeChatDisk;
  sink: BagSink;
  stop(): void;
}

/** Один стенд на процесс. Два разом подменяли бы один и тот же `globalThis`
 *  и мешали бы склады молча — тот же гейт и по той же причине, что в
 *  `chatStand.ts`. Нарушение БРОСАЕТ. */
let activeStand = false;

export async function startPresentationStand(): Promise<PresentationStand> {
  if (activeStand) throw new Error('стенд предъявления уже поднят: два разом мешают диски молча');
  activeStand = true;
  const disk = installFakeChatDisk();
  const sink = installBagSink();
  try {
    _resetConversationMemoryForTest();
    _resetParseCacheForTest();
    const actors = await makeActors();
    const conversation = await buildConversation(actors);
    return {
      actors, conversation, disk, sink,
      stop: () => {
        try {
          sink.restore();
          disk.restore();
          _resetConversationMemoryForTest();
          _resetParseCacheForTest();
        } finally {
          activeStand = false;
        }
      },
    };
  } catch (err) {
    sink.restore();
    disk.restore();
    activeStand = false;
    throw err;
  }
}

/* ──────────────────────────── замки формы ──────────────────────────── */

/**
 * ЗАМКИ ФОРМЫ. Эта функция НЕ ВЫЗЫВАЕТСЯ НИКОГДА и не должна: вся её работа
 * происходит в `npm run type-check`. Экспортирована нарочно — чтобы её
 * невызванность не выглядела мусором и не была вычищена «уборкой».
 *
 * Что каждая директива сторожит: пока поля НЕТ, строка не компилируется и
 * `@ts-expect-error` её погашает. Стоит полю появиться — директива становится
 * «неиспользованной», и `npm run type-check` краснеет. То есть форма проверяет
 * себя сама, без единого теста; `npm test` тут не мерит НИЧЕГО (замер — мутация 17б).
 *
 * Восемь замков: три про числа и обязательное поле выдачи (исправления 7 и 9),
 * четыре про то, что ключа вложения и адреса файла арбитру не отдают вовсе, и
 * один про фирменный `OneTimeKey`.
 */
export async function formLocks(
  view: PresentationView, declared: DeclaredCounts,
  envelope: Uint8Array, author: `0x${string}`,
): Promise<void> {
  /* ─── числа предъявителя ≠ числа арбитра (исправление 7 договора) ───
   * Это тот самый замок, которого не было: раньше оба набора имели ОДИН тип, и
   * «вернуть чужие числа как свои» (мутация 1) СПОКОЙНО КОМПИЛИРОВАЛОСЬ. */
  // @ts-expect-error — у `DeclaredCounts` поля `unopened` нет вовсе: предъявитель
  //   не арбитр и знать, что у арбитра не открылось, не может.
  void declared.unopened;
  // @ts-expect-error — и целиком подставить чужие числа на место посчитанных
  //   тоже нельзя: `MeasuredCounts` требует `unopened`, которого там нет.
  const measured: MeasuredCounts = declared;
  void measured;

  /* ─── «показал ли арбитру легаси-ключ» забыть нельзя (исправление 9) ─── */
  // @ts-expect-error — `legacyAttachmentExposed` ОБЯЗАТЕЛЬНОЕ, не `?`: поле,
  //   про которое можно забыть, молча читается как «нет, не показывали».
  const forgotten: PresentedMessage = {
    seq: 0, sender: author, state: 'unopened', attestation: 'absent', frame: { ok: true },
  };
  void forgotten;

  const file = view.messages[0]?.payload?.file;
  if (file) {
    // @ts-expect-error — у арбитра нет ключа вложения: `RedactedFilePayload`
    //   поля `keyHex` не объявляет вовсе (§5 замысла, Задача 3).
    void file.keyHex;
    // @ts-expect-error — и `ivHex` тоже нет.
    void file.ivHex;
    // @ts-expect-error — и запечатанного замка ему не отдают: иначе смена
    //   ключей у сторон делала бы вложение читаемым задним числом.
    void file.sealedKey;
    // @ts-expect-error — и адреса скачивания: без него арбитр не тянет и байты
    //   (а `GET /files/:key` открыт всем — attachments §4.2).
    void file.url;
  }
  // @ts-expect-error — `OneTimeKey` фирменный (unique symbol, Задача 2): просто
  //   32 байта в читалку не подставить, и ключ вложения с разовым не перепутать.
  await openEnvelopeWithOneTimeKey(envelope, new Uint8Array(32), author);
}
