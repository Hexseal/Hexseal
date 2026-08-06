/**
 * chatSession.ts — сеанс чата: ключ переписки, его жизнь на устройстве и код
 * восстановления для кошельков-контрактов.
 *
 * НЕ ЗНАЕТ: про сеть чата (`chatTransport.ts`), про React, про wagmi/viem-
 * клиент. Кошелёк и цепь входят сюда ДВУМЯ колбэками (`signTypedData`,
 * `getBytecode`), а не импортом — модуль проверяется целиком без браузера и
 * без узла RPC. Потребляет из ядра ровно `deriveChatKeypair`,
 * `CHAT_KEY_TYPED_DATA` и тип `ChatKeypair` (`chatCrypto.ts`).
 *
 * ─── ДВА ПРОИСХОЖДЕНИЯ КЛЮЧА, И ОНИ НЕ СИММЕТРИЧНЫ ──────────────────────
 *
 * `origin: 'signature'` — ОБЫЧНЫЙ кошелёк. Подпись фиксированных
 * типизированных данных (`CHAT_KEY_TYPED_DATA`) всегда одна и та же, значит
 * `deriveChatKeypair` всегда даёт один и тот же ключ. Восстановление такому
 * человеку не нужно и не выдаётся: **восстановление обычного кошелька — это
 * сам кошелёк**. Он заходит с нового устройства, подписывает то же самое и
 * получает тот же ключ (спека, §4).
 *
 * `origin: 'recovery'` — КОШЕЛЁК-КОНТРАКТ (Coinbase Smart Wallet, Safe). Его
 * подпись переменной длины и, что важнее, НЕ обязана оставаться прежней при
 * смене состава владельцев — обещание «та же фраза даёт тот же ключ» для него
 * ложно. Поэтому ключ генерируется случайно, а человеку выдаётся код
 * восстановления, который он хранит сам.
 *
 * ⚠️ ПОЧЕМУ КОДА НЕТ У ОБЫЧНОГО КОШЕЛЬКА, ЕСЛИ «ТАК УДОБНЕЕ». Семя ключа из
 * подписи — 256-битное (`keccak256`). Двенадцать слов BIP-39 несут 128 бит.
 * Выдать обычному кошельку двенадцатисловный код означало бы ВТИХУЮ срезать
 * стойкость его ключа вчетверо ради удобства, которого у него и так нет
 * (см. абзац выше). Поэтому `exportRecoveryCode` для `origin: 'signature'`
 * ОТКАЗЫВАЕТ с кодом `recovery_not_applicable`, а не отдаёт пустую строку и
 * не выдаёт что попало.
 *
 * Код восстановления — 128 бит энтропии → 12 слов BIP-39 → растяжка
 * PBKDF2-HMAC-SHA512 (2048 итераций, `mnemonicToSeed`) → 32-байтное семя →
 * та же пара X25519, что даёт `deriveChatKeypair`. Двенадцать слов, 128 бит
 * — размен принят намеренно: длиннее человек не перепишет с бумажки, а 128
 * бит для этой задачи достаточно.
 *
 * ─── ХРАНИЛИЩЕ — IndexedDB, И ЭТО НЕ ВКУСОВЩИНА ────────────────────────
 *
 * Ключ кладётся в `IndexedDB`, НЕ в `localStorage`, по трём причинам, и все
 * три проверены тестами, а не заявлены:
 *
 *  1. `localStorage` хранит только строки — сырые байты ключа пришлось бы
 *     кодировать в hex/base64, то есть держать ключ в виде, который любой
 *     дамп хранилища покажет читаемым текстом.
 *  2. `localStorage` синхронен и не имеет транзакций: закрытая посреди записи
 *     вкладка может оставить половину. У `IndexedDB` транзакция атомарна —
 *     либо запись целиком, либо ничего (см. `writeRecord` ниже: ответ даётся
 *     на `tx.oncomplete`, то есть на ФИКСАЦИИ, а не на успехе запроса).
 *  3. `localStorage` — самое обшариваемое место в браузере; расширения и
 *     отладочные снимки лезут туда в первую очередь.
 *
 * Никакой ПРИНЦИПИАЛЬНОЙ защиты это не даёт: `IndexedDB` того же origin
 * читается тем же JavaScript. Обещание здесь ровно одно и оно скромное —
 * ключ не лежит в самом людном месте в виде строки. Спека §3.2 честно
 * называет цену: доступ к разблокированному устройству равен доступу ко всей
 * переписке.
 *
 * ─── ЗАПИСЬ МОГЛА НЕ ПРОЙТИ, И ЭТО ВИДНО ───────────────────────────────
 *
 * Квота кончилась, приватный режим, хранилище отключено — `IndexedDB` умеет
 * отказать. Сеанс в этом случае ВСЁ РАВНО отдаётся (переписка в этой вкладке
 * работает), но с `persisted: false` и громкой записью в журнал. Молчаливый
 * отказ здесь означал бы окно подписи при каждой перезагрузке без единого
 * объяснения — а для кошелька-контракта ещё и потерю личности навсегда, если
 * человек не переписал код. Флаг существует, чтобы вызывающий мог об этом
 * сказать, а не чтобы о нём знал только этот файл.
 *
 * ─── ОДНО ОКНО ПОДПИСИ НА ВСЕ ВКЛАДКИ ──────────────────────────────────
 *
 * Две вкладки, открытые разом, обязаны показать ОДНО окно подписи, не два
 * (второй запрос кошелёк отклоняет как `-32002` и в мобильном MetaMask его
 * нечем снять — та же боль, ради которой существует `walletLock.ts`).
 * Держится двумя независимыми замками:
 *
 *  - внутри вкладки — карта незавершённых вызовов (`_inFlight`): второй
 *    вызов на тот же адрес ПРИСОЕДИНЯЕТСЯ к первому, а не заводит свой;
 *  - между вкладками — Web Locks (`navigator.locks`), тот же приём и тот же
 *    таймаут, что в `walletLock.ts`.
 *
 * ⚠️ Замок сам по себе НИЧЕГО не даёт: вторая вкладка, дождавшись своей
 * очереди, спокойно откроет второе окно подписи, если не ПЕРЕЧИТАЕТ
 * хранилище под замком. Перечитывание (`readRecord` внутри `withCrossTabLock`)
 * — не осторожность, а единственное, ради чего замок здесь берётся. В этом
 * проекте уже был «замок, который не запирает»; тест меряет число вызовов
 * `signTypedData` из ДВУХ экземпляров модуля, а не факт взятия замка.
 *
 * ─── ЧЕГО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ ────────────────────────────────────────
 *
 *  - НЕ сверяет восстановленный ключ со справочником открытых ключей на
 *    сервере. Код восстановления не связан с адресом (см. `RECOVERY_SEED_
 *    CONTEXT`), поэтому чужой код, введённый под своим адресом, даст ЧУЖОЙ
 *    ключ молча. Поймать это можно только сравнением с опубликованным
 *    открытым ключом — а это сеть, то есть слой хука (Задача 6).
 *  - НЕ проверяет, что `openSessionFromRecoveryCode` зовут для кошелька-
 *    контракта. Обычному кошельку код не нужен и вреден (перебьёт его
 *    восстановимый ключ ключом из кода); показывать этот путь только
 *    контрактным — обязанность интерфейса.
 *  - НЕ показывает предупреждение про код восстановления. Смысл, который
 *    интерфейс ОБЯЗАН донести рядом с кодом: это доступ ко всей переписке
 *    навсегда; кто его получил, читает всё; восстановить или отозвать
 *    нельзя. Точный текст утверждается владельцем (план, Задача 4).
 */

import { keccak256, concat, stringToBytes } from 'viem';
import { deriveChatKeypair, CHAT_KEY_TYPED_DATA, type ChatKeypair } from './chatCrypto';

export type SessionOrigin = 'signature' | 'recovery';

/** Род кошелька по коду на цепи. `eoa` включает и адреса с делегацией
 *  EIP-7702 — см. `DELEGATION_INDICATOR_RE`. */
export type WalletKind = 'eoa' | 'contract';

export interface ChatSession {
  keypair: ChatKeypair;
  /** Адрес В ТОМ ВИДЕ, В КАКОМ ЕГО ПОДАЛИ (с контрольной суммой, как отдаёт
   *  `useAccount()`) — интерфейсу показывать именно его. Ключом хранилища
   *  служит приведённый к нижнему регистру (`storageKey`), иначе один и тот
   *  же кошелёк в разной записи выглядел бы двумя разными людьми. */
  address: `0x${string}`;
  origin: SessionOrigin;
  /** Род кошелька, выясненный ПО ЦЕПИ и записанный рядом с ключом.
   *
   *  Отдельно от `origin` намеренно (находка К-3 независимой проверки):
   *  `origin` говорит, ОТКУДА взялся ключ, а `walletKind` — КОМУ он
   *  принадлежит. Раньше существовал обход: обычный кошелёк один раз вводил
   *  код восстановления, происхождение на диске становилось `recovery`, и на
   *  этом устройстве он НАВСЕГДА терял свой выводимый ключ. «Защита в
   *  интерфейсе» такого не ловит: интерфейс может не показать кнопку, но не
   *  может отменить уже переписанную запись. Поэтому род кошелька выясняет
   *  сам модуль и сверяется с ним при выдаче кода. */
  walletKind: WalletKind;
  /** `true` — ключ взят с устройства (окна подписи НЕ было). `false` — ключ
   *  только что заведён. Для кошелька-контракта это ровно тот признак, по
   *  которому интерфейс обязан показать код восстановления немедленно:
   *  второго случая его показать может не быть. */
  restored: boolean;
  /** `false` — ключ НЕ лёг на устройство (квота, приватный режим, хранилища
   *  нет). Сеанс работает, но до перезагрузки вкладки. См. раздел «запись
   *  могла не пройти» в шапке файла. */
  persisted: boolean;
}

export type ChatSessionErrorCode =
  /** У обычного кошелька кода восстановления нет по устройству, а не по
   *  недоделке (см. шапку файла). */
  | 'recovery_not_applicable'
  /** Сеанс есть, но кода к нему в памяти этой вкладки нет — защитный случай:
   *  объект сеанса пришёл не от этого экземпляра модуля. */
  | 'recovery_code_unavailable'
  | 'recovery_code_empty'
  | 'recovery_code_word_count'
  | 'recovery_code_unknown_word'
  | 'recovery_code_checksum'
  /** По этому адресу на устройстве УЖЕ есть сеанс. Код восстановления его не
   *  затирает: снятие делается явно, через `forgetSession`. */
  | 'session_already_present'
  /** Кошелёк вернул не 65-байтовую подпись (пусто, обрезок, ERC-1271). */
  | 'signature_malformed'
  /** Не удалось выяснить, обычный это кошелёк или контрактный. Гадать нельзя
   *  — см. `walletKind`. */
  | 'wallet_kind_unknown'
  /** `forgetSession` не смогла удалить запись. Молча вернуть «забыто» —
   *  соврать про то, что ключ всё ещё на устройстве. */
  | 'forget_failed'
  /** Прочитать хранилище не удалось. НЕ то же, что «записи нет»: пустоту мы
   *  не установили, а завести новый ключ вслепую значит для кошелька-
   *  контракта уничтожить прежнюю личность (К-4). */
  | 'storage_read_failed'
  /** Открытие базы упёрлось в соседнюю вкладку, держащую прежнюю версию.
   *  Человеку надо закрыть другие вкладки сайта, а не «повторить». */
  | 'storage_blocked'
  /** Открытие базы не ответило ничем за отведённое время. */
  | 'storage_open_timeout'
  /** Адрес не похож на адрес. Без этой проверки пустая строка заводила
   *  РАБОЧИЙ сеанс под ключом `''` — не «голое системное сообщение», а
   *  молчаливый мусорный сеанс. */
  | 'address_malformed';

/** Каждый отказ несёт `.code` ОТДЕЛЬНЫМ полем — та же дисциплина, что в
 *  `chatTransport.ts`: сравнение текста ошибки ломается от первой же правки
 *  формулировки, а к одному коду часто ведёт несколько дорог. */
export class ChatSessionError extends Error {
  readonly code: ChatSessionErrorCode;
  constructor(message: string, code: ChatSessionErrorCode, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ChatSessionError';
    this.code = code;
  }
}

/** Сколько слов в коде восстановления. Ровно двенадцать — не «12-24, как
 *  разрешает BIP-39»: 24-словная мнемоника это чей-то СИДФРАЗА КОШЕЛЬКА, и
 *  принять её здесь значило бы молча завести чат на ключе, выведенном из
 *  денег человека. Экспортировано — тест сверяет напрямую, а не задваивает
 *  число. */
export const RECOVERY_WORD_COUNT = 12;

/** 128 бит энтропии = 12 слов. См. шапку файла про размен. */
const RECOVERY_ENTROPY_BITS = 128;

/** Метка назначения внутри семени — та же дисциплина, что
 *  `CHAT_KEY_SEED_CONTEXT` в `chatCrypto.ts`: разводит ключ ЧАТА и любой
 *  будущий ключ, выведенный из того же кода восстановления.
 *
 *  Адреса здесь НЕТ намеренно. Подмешать адрес — значит сделать так, что код,
 *  введённый под ЧУЖИМ адресом, даст ДРУГОЙ ключ: человек, ошибившийся
 *  кошельком, потерял бы историю навсегда и без сигнала. Без подмеси тот же
 *  промах кладёт правильный ключ не под тем адресом — сам ключ при этом цел
 *  и история по нему читается.
 *
 *  ⚠️ Честная поправка (находка К-2 независимой проверки). Раньше здесь было
 *  написано «ошибка обратима» — и это было неправдой: ввод кода ЗАТИРАЛ уже
 *  лежащий по адресу сеанс, и для кошелька-контракта, чей код не переписан,
 *  затёртое пропадало навсегда. Обратимость не следует из отсутствия адреса
 *  в семени; её обеспечивает отказ `session_already_present` в
 *  `openSessionFromRecoveryCode` — то есть то, что чужой код физически не
 *  может встать поверх живого сеанса. Обещание и механизм теперь совпадают. */
const RECOVERY_SEED_CONTEXT = 'hexseal.chat.recovery.seed.v1';

/** Длина обеих половин пары X25519 (`crypto_box`) — 32 байта. Проверяется на
 *  чтении записи с устройства: строка ровно в 32 UTF-8 байта приводится
 *  libsodium молча (разобрано в `openSealed`, chatCrypto.ts), поэтому форма
 *  сверяется здесь, а не «как-нибудь потом». */
const KEY_LEN = 32;

/** Потолок ожидания межвкладочного замка. То же значение и та же причина, что
 *  `WALLET_LOCK_TIMEOUT_MS` в `walletLock.ts`: под замком стоит ЖИВОЕ окно
 *  подписи, человек имеет право думать минуты. Держатель, брошенный навсегда
 *  (вкладку выгрузили посреди подписи), не должен заклинить чат до
 *  перезагрузки — по истечении срока едем без межвкладочной защиты, ценой
 *  возможного второго окна. */
export const SESSION_LOCK_TIMEOUT_MS = 3 * 60_000;

/**
 * Указатель делегации EIP-7702: `0xef0100` ‖ 20 байт адреса реализации,
 * РОВНО 23 байта. По коду на цепи такой адрес неотличим от контракта
 * простой проверкой «код непустой» — а по существу это ОБЫЧНЫЙ кошелёк:
 * подпись у него даёт обычный секретный ключ, она обычной длины и
 * стабильна, значит ключ чата обязан выводиться из неё, как у всех.
 *
 * Цена ошибки замерена (находка К-1 независимой проверки): человек с
 * «умным аккаунтом» MetaMask на Base получал случайный ключ вместо
 * выведенного — без окна подписи и без объяснения; включил делегацию —
 * один ключ, снял — другой, переписка распадалась на куски. Устройство
 * спасало только потому, что диск читается ДО обращения к цепи, то есть
 * спасало случай, который и так работал, и не спасало самый частый —
 * заход с нового устройства.
 *
 * Длина в шаблоне жёсткая (`{40}` и `$`) НАМЕРЕННО: признак «начинается с
 * ef0100» отдал бы этой ветке настоящий контракт, чей код случайно
 * начинается так же.
 */
const DELEGATION_INDICATOR_RE = /^0xef0100[0-9a-f]{40}$/;

/**
 * Потолок ожидания ОТКРЫТИЯ базы. `indexedDB.open` умеет не ответить вовсе:
 * ни `success`, ни `error` — например, пока жива соседняя вкладка с прежней
 * версией базы (тогда приходит `blocked`, а за ним может не прийти ничего)
 * или когда браузер придерживает хранилище. Без потолка это не отказ, а
 * ТИШИНА: чат просто не заводится, и никто не узнает почему (находка В-4).
 *
 * Десять секунд — заведомо больше любого нормального открытия локальной
 * базы (миллисекунды) и заведомо меньше человеческого терпения.
 */
export const STORAGE_OPEN_TIMEOUT_MS = 10_000;

const DB_NAME = 'hexseal-chat';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';

/** Версия ФОРМАТА ЗАПИСИ, не версия базы. Запись с другой (в т.ч. без поля
 *  `v` вовсе, и в т.ч. с БОЛЬШЕЙ — от более новой сборки) считается
 *  ОТСУТСТВУЮЩЕЙ: лучше одно лишнее окно подписи, чем ключ, собранный из
 *  полей, значение которых сегодня другое.
 *
 *  Версия 2 добавила `walletKind` (находка К-3). Экспортирована — тесты
 *  сверяются с ней напрямую, а не задваивают число литералом. */
export const RECORD_VERSION = 2;

interface StoredSession {
  v: number;
  /** Приведённый адрес — дублирует ключ хранилища НАМЕРЕННО. Ключ говорит,
   *  где запись лежит; поле — чья она. Совпадение проверяется на чтении: без
   *  этого регресс в вычислении ключа выдал бы ключ одного человека другому
   *  (класс «заперто на одном пути, открыто на соседнем»). */
  address: string;
  origin: SessionOrigin;
  /** Род кошелька по цепи — см. `ChatSession.walletKind`. Лежит в записи,
   *  чтобы выдача кода сверялась с ним и на восстановленном сеансе, а не
   *  только в момент заведения. */
  walletKind: WalletKind;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  /** Только для `origin: 'recovery'`. Хранится, чтобы код можно было показать
   *  повторно (человек не переписал сразу) — по чувствительности это ровно то
   *  же, что лежащий рядом закрытый ключ, отдельной тайны не добавляет. */
  recoveryCode?: string;
}

/** Код восстановления живёт ЗДЕСЬ, а не полем в `ChatSession`. Причина
 *  практическая: объект сеанса уедет в состояние React, в отладочные снимки,
 *  в `JSON.stringify` журнала — и код уехал бы вместе с ним. `WeakMap` не
 *  сериализуется никак, отдаётся только через `exportRecoveryCode` и умирает
 *  вместе с самим объектом сеанса. */
const _codes = new WeakMap<ChatSession, string>();

/** Незавершённые открытия сеанса, по приведённому адресу. Второй вызов на тот
 *  же адрес присоединяется к первому — одно окно подписи внутри вкладки. */
const _inFlight = new Map<string, Promise<ChatSession>>();

/** Форма адреса — двадцать байт в hex. Проверяется НА ИСПОЛНЕНИИ, а не
 *  только типом: `` `0x${string}` `` пропускает и `'0x'`, и пустую строку
 *  через любое `as`, а адрес сюда приходит из хука, то есть в конечном счёте
 *  от кошелька. */
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

function storageKey(address: string): string {
  if (typeof address !== 'string' || !ADDRESS_RE.test(address.toLowerCase())) {
    throw new ChatSessionError(
      `chatSession: адрес не похож на адрес (${typeof address === 'string' ? `«${address}»` : typeof address})`,
      'address_malformed',
    );
  }
  return address.toLowerCase();
}

// ─── IndexedDB: тонкий слой, ничего своего ────────────────────────────────

function idbFactory(): IDBFactory | null {
  const g = globalThis as { indexedDB?: IDBFactory };
  return g.indexedDB ?? null;
}

function openDb(): Promise<IDBDatabase> {
  const factory = idbFactory();
  if (!factory) return Promise.reject(new Error('chatSession: IndexedDB недоступен'));
  return new Promise((resolve, reject) => {
    let settled = false;
    // Ровно один исход, что бы ни пришло первым, и таймер снимается всегда.
    const finish = (act: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      act();
    };
    const timer = setTimeout(() => finish(() => reject(new ChatSessionError(
      'chatSession: хранилище не открылось за отведённое время',
      'storage_open_timeout',
    ))), STORAGE_OPEN_TIMEOUT_MS);

    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => finish(() => resolve(req.result));
    req.onerror = () => finish(() => reject(
      req.error ?? new Error('chatSession: не удалось открыть хранилище'),
    ));
    // `blocked` приходит, когда соседняя вкладка держит прежнюю версию базы.
    // Сегодня версия одна и этого не бывает; первое же её повышение делает
    // это обычным делом, и без обработчика тут была бы вечная тишина.
    req.onblocked = () => finish(() => reject(new ChatSessionError(
      'chatSession: хранилище занято другой вкладкой этого сайта — закройте её и повторите',
      'storage_blocked',
    )));
  });
}

async function idbGet(key: string): Promise<unknown> {
  const db = await openDb();
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('chatSession: чтение не удалось'));
      tx.onabort = () => reject(tx.error ?? new Error('chatSession: чтение прервано'));
    });
  } finally {
    db.close();
  }
}

/** Ответ даётся на `tx.oncomplete` — на ФИКСАЦИИ транзакции, а не на успехе
 *  запроса. Разница ровно в том вопросе, ради которого выбран IndexedDB:
 *  успех запроса ещё не означает, что данные переживут закрытие вкладки, а
 *  фиксация — означает. Ответить раньше значило бы пообещать сохранность,
 *  которой нет. */
async function idbPut(key: string, value: StoredSession): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('chatSession: запись прервана'));
      tx.onerror = () => reject(tx.error ?? new Error('chatSession: запись не удалась'));
      tx.objectStore(STORE_NAME).put(value, key);
    });
  } finally {
    db.close();
  }
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('chatSession: удаление прервано'));
      tx.onerror = () => reject(tx.error ?? new Error('chatSession: удаление не удалось'));
      tx.objectStore(STORE_NAME).delete(key);
    });
  } finally {
    db.close();
  }
}

/** Гейт формы записи с устройства. Данные из хранилища доверия не заслуживают
 *  ровно как данные из сети: их мог записать предыдущий выпуск, их мог
 *  испортить сбой, их мог подменить кто-то с доступом к вкладке. Всё, что не
 *  сходится, считается ОТСУТСТВИЕМ записи — путь тогда обычный (подпись),
 *  видимый человеку, а не тихая выдача мусора под видом ключа. */
function isWellFormedRecord(value: unknown, expectedKey: string): value is StoredSession {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;

  if (r.v !== RECORD_VERSION) return false;
  if (r.address !== expectedKey) return false;
  if (r.origin !== 'signature' && r.origin !== 'recovery') return false;
  if (r.walletKind !== 'eoa' && r.walletKind !== 'contract') return false;
  if (!(r.publicKey instanceof Uint8Array) || r.publicKey.length !== KEY_LEN) return false;
  if (!(r.privateKey instanceof Uint8Array) || r.privateKey.length !== KEY_LEN) return false;

  // Код восстановления, если он есть, обязан быть строкой. ГОДНОСТЬ его тут
  // не проверяется: это делает `validRecoveryCode` ниже, контрольной суммой
  // BIP-39, а не счётом пробелов (находка В-3 независимой проверки — раньше
  // проверялось именно число пробелов, и человеку выдавались двенадцать
  // несуществующих слов, которые он переписывал на бумажку как страховку).
  //
  // Негодный или отсутствующий код НЕ делает запись негодной: ключ в ней
  // настоящий, и отвергать её целиком значило бы завести новую личность
  // поверх живой — та же беда, что К-4, только помельче. Ключ отдаётся,
  // код не выдаётся.
  if (r.recoveryCode !== undefined && typeof r.recoveryCode !== 'string') return false;

  return true;
}

/** Годен ли код восстановления НА САМОМ ДЕЛЕ — по контрольной сумме BIP-39,
 *  а не по форме. Используется на чтении записи с устройства: то, что
 *  человек однажды перепишет на бумажку, обязано быть проверено ровно так
 *  же, как то, что он потом введёт обратно. */
async function validRecoveryCode(code: string): Promise<boolean> {
  const normalized = normalizeRecoveryCode(code);
  if (normalized.split(' ').length !== RECOVERY_WORD_COUNT) return false;
  const { validateMnemonic } = await import('@scure/bip39');
  const { wordlist } = await import('@scure/bip39/wordlists/english');
  return validateMnemonic(normalized, wordlist);
}

/**
 * Читает запись сеанса. `null` — записи ТОЧНО нет (или она негодной формы).
 *
 * ⚠️ Отказ чтения — это ОТКАЗ, а не пустота (находка К-4 независимой
 * проверки). Раньше сбой чтения трактовался как «записи нет»; для подписи
 * это безобидно (ключ выведется тот же), но для кошелька-контракта означало
 * НОВУЮ СЛУЧАЙНУЮ личность поверх старой — причём сеанс рапортовал себя
 * полностью здоровым (`persisted: true`). Два пути были разведены по
 * последствиям и не разведены по обработке.
 *
 * Цена решения названа вслух и РАЗВЕДЕНА ПО РОДУ КОШЕЛЬКА (см.
 * `openWithoutStorage`): там, где `IndexedDB` не читается вовсе (приватный
 * режим некоторых браузеров), кошелёк-контракт чат не заводит, а обычный
 * работает без сохранения — с окном подписи на каждый заход. Отказывать
 * обоим одинаково значило бы наказывать первого за беду второго: у него
 * ключ выводится из подписи и получается тот же самый.
 *
 * Отсутствие самого API `IndexedDB` — ДРУГОЙ случай и остаётся пустотой:
 * там, где хранилища нет вовсе, в нём ничего и не могло лежать, то есть
 * вывод «пусто» здесь обоснован, а не предположен.
 *
 * @throws {ChatSessionError} `storage_read_failed`
 */
/** Исход попытки прочитать запись. `failed` — ОТДЕЛЬНЫЙ исход, а не
 *  разновидность пустоты: что делать дальше, зависит от рода кошелька
 *  (см. `openWithoutStorage`). */
type ReadOutcome =
  | { status: 'found'; record: StoredSession }
  | { status: 'empty' }
  | { status: 'failed'; error: ChatSessionError };

async function tryReadRecord(key: string): Promise<ReadOutcome> {
  try {
    const record = await readRecord(key);
    return record ? { status: 'found', record } : { status: 'empty' };
  } catch (err) {
    if (err instanceof ChatSessionError) return { status: 'failed', error: err };
    throw err;
  }
}

async function readRecord(key: string): Promise<StoredSession | null> {
  if (!idbFactory()) return null; // хранилища нет — вывод «пусто» обоснован
  let raw: unknown;
  try {
    raw = await idbGet(key);
  } catch (err) {
    // Уже внятный отказ (занято соседней вкладкой, не открылось за срок)
    // проходит КАК ЕСТЬ: «закройте другую вкладку» и «повторите позже» —
    // разные советы человеку, и схлопывать их в один код значило бы стереть
    // единственное, что отличает одно от другого.
    if (err instanceof ChatSessionError) throw err;
    throw new ChatSessionError(
      'chatSession: не удалось прочитать ключ чата с устройства — повторите позже',
      'storage_read_failed',
      { cause: err },
    );
  }
  if (raw === undefined || raw === null) return null;
  if (!isWellFormedRecord(raw, key)) {
    console.warn('[chatSession] запись на устройстве не той формы — считаем, что ключа нет');
    return null;
  }

  // Код проверяется контрольной суммой, а не формой (В-3). Не сошлось —
  // ключ остаётся, код снимается: лучше честное «кода нет», чем двенадцать
  // слов, которые ничего не восстановят.
  if (raw.origin === 'recovery' && raw.recoveryCode !== undefined) {
    if (!(await validRecoveryCode(raw.recoveryCode))) {
      console.warn(
        '[chatSession] код восстановления на устройстве не проходит контрольную сумму BIP-39 — ' +
        'ключ цел, но кода у этого сеанса нет',
      );
      delete raw.recoveryCode;
    }
  }
  return raw;
}

/** Возвращает `true`, если запись действительно зафиксирована. Никогда не
 *  бросает: неудачная запись не повод отказать человеку в переписке прямо
 *  сейчас — но и не повод промолчать. */
async function writeRecord(key: string, record: StoredSession): Promise<boolean> {
  if (!idbFactory()) {
    console.warn(
      '[chatSession] хранилища IndexedDB нет — ключ чата останется только в памяти вкладки; ' +
      'после перезагрузки кошелёк спросит подпись заново',
    );
    return false;
  }
  try {
    await idbPut(key, record);
    return true;
  } catch (err) {
    console.warn(
      '[chatSession] не удалось сохранить ключ чата на устройстве (квота/приватный режим): ' +
      'сеанс работает, но до перезагрузки вкладки',
      err,
    );
    return false;
  }
}

// ─── Замок между вкладками ────────────────────────────────────────────────

/** Тот же приём, что в `walletLock.ts`: Web Locks, где есть; мягкая
 *  деградация, где нет (защита остаётся в пределах вкладки — карта
 *  `_inFlight`). Потолок ожидания обязателен: держатель, брошенный навсегда,
 *  иначе заклинил бы чат до перезагрузки страницы. */
async function withCrossTabLock<T>(name: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: Navigator }).navigator?.locks;
  if (!locks) return fn();

  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;

  const acquired = new Promise<void>(resolve => {
    locks
      .request(name, () => { resolve(); return held; })
      .catch(() => { resolve(); }); // не поддержано/отказ — едем без замка
  });

  try {
    await Promise.race([
      acquired,
      new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    return await fn();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Безусловно: если замок достанется нам ПОСЛЕ таймаута, `held` уже
    // разрешён и очередь поедет дальше сразу, а не встанет на нас.
    release?.();
  }
}

// ─── Вывод ключа ──────────────────────────────────────────────────────────

async function keypairFromSignature(signature: unknown): Promise<ChatKeypair> {
  if (typeof signature !== 'string') {
    throw new ChatSessionError(
      'chatSession: кошелёк вернул не строку вместо подписи',
      'signature_malformed',
    );
  }
  try {
    return await deriveChatKeypair(signature as `0x${string}`);
  } catch (err) {
    // `deriveChatKeypair` бросает `TypeError` ровно на «это не 65-байтовая
    // подпись»: пусто, обрезок, ERC-1271 переменной длины. Наружу это должно
    // выйти вердиктом с кодом, а не голым TypeError, который вызывающему
    // неотличим от нашего собственного бага.
    if (err instanceof TypeError) {
      throw new ChatSessionError(
        'chatSession: кошелёк вернул не 65-байтовую подпись — для кошелька-контракта нужен код восстановления',
        'signature_malformed',
        { cause: err },
      );
    }
    throw err;
  }
}

async function keypairFromRecoveryCode(normalizedCode: string): Promise<ChatKeypair> {
  const { mnemonicToSeed } = await import('@scure/bip39');
  // Растяжка BIP-39: PBKDF2-HMAC-SHA512, 2048 итераций, 64 байта.
  const stretched = await mnemonicToSeed(normalizedCode);
  const seed = keccak256(
    concat([stringToBytes(RECOVERY_SEED_CONTEXT), stretched]),
    'bytes',
  );

  // Тот же алгоритм и тот же вход, что у `deriveChatKeypair` (chatCrypto.ts):
  // 32-байтное семя → `crypto_box_seed_keypair`. Динамический импорт — по той
  // же причине, что там: статический кладёт ~147 КБ gzip в общий чанк Next.
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  const { publicKey, privateKey } = sodium.crypto_box_seed_keypair(seed);
  return { publicKey, privateKey };
}

/** Приводит код к тому виду, в каком он проверяется и хранится.
 *
 *  Регистр и лишние пробелы прощаются НАМЕРЕННО: человек перепечатывает
 *  двенадцать слов с бумажки, и «ALPHA  BRAVO» от «alpha bravo» отличается
 *  только его почерком. `@scure/bip39` сам этого не прощает — он делит строку
 *  ровно по одному пробелу и сверяет слова побайтово, так что без этой
 *  нормализации законный код отвергался бы с той же ошибкой, что настоящая
 *  опечатка, и человек искал бы несуществующую ошибку в словах.
 *
 *  NFKD — до всего остального: тот же порядок, что внутри BIP-39. */
function normalizeRecoveryCode(code: string): string {
  return code.normalize('NFKD').toLowerCase().trim().replace(/\s+/g, ' ');
}

// ─── Открытие сеанса ──────────────────────────────────────────────────────

export interface OpenSessionOptions {
  /** Чтение кода по адресу с цепи — обычно `publicClient.getBytecode`.
   *  Обязателен: без него выяснить тип кошелька нечем, а гадать нельзя
   *  (см. `walletKind`). */
  getBytecode?: (address: `0x${string}`) => Promise<`0x${string}` | undefined | null>;
  /** Потолок ожидания межвкладочного замка. Умолчание —
   *  `SESSION_LOCK_TIMEOUT_MS`; параметр существует ради тестов. */
  lockTimeoutMs?: number;
}

/** Подписать РОВНО те типизированные данные, которые дал этот модуль. Тип
 *  аргумента прибит к `CHAT_KEY_TYPED_DATA` намеренно: вызывающий forward'ит
 *  их в кошелёк, а не собирает структуру заново — иначе появился бы второй
 *  источник истины о том, из чего выводится ключ (разобрано в шапке
 *  `chatCrypto.ts`). */
export type SignChatKey = (typedData: typeof CHAT_KEY_TYPED_DATA) => Promise<`0x${string}`>;

/**
 * Выясняет, обычный это кошелёк или контрактный.
 *
 * ⚠️ Отказ сети — ОТДЕЛЬНЫЙ исход, а не повод предположить. Обе догадки
 * дорогие и молчаливые:
 *  - решить «обычный» для контрактного — кошелёк вернёт подпись переменной
 *    длины, и человек упрётся в `signature_malformed` без объяснения;
 *  - решить «контрактный» для обычного — человек получит СЛУЧАЙНЫЙ ключ
 *    вместо восстановимого, и на другом устройстве его переписка не сойдётся
 *    никогда, причём узнает он об этом много позже.
 * Поэтому — внятный отказ, который человек может повторить.
 *
 * Сеть спрашивается ТОЛЬКО когда ключа на устройстве ещё нет: при обычном
 * заходе (`restored`) этой функции не существует для потребителя вовсе.
 */
async function walletKind(
  address: `0x${string}`,
  opts: OpenSessionOptions,
): Promise<WalletKind> {
  if (!opts.getBytecode) {
    throw new ChatSessionError(
      'chatSession: без getBytecode нельзя отличить обычный кошелёк от контрактного',
      'wallet_kind_unknown',
    );
  }
  let code: `0x${string}` | undefined | null;
  try {
    code = await opts.getBytecode(address);
  } catch (err) {
    throw new ChatSessionError(
      'chatSession: не удалось прочитать код кошелька с цепи — повторите позже',
      'wallet_kind_unknown',
      { cause: err },
    );
  }
  // `undefined` и `'0x'` оба означают «кода нет»: разные узлы и разные версии
  // viem отдают по-разному, и полагаться на одну форму нельзя. Сравнение идёт
  // по приведённой строке, а не по литералу типа: сюда приходит ответ узла,
  // а он не обязан совпадать с тем, что обещает тип на границе.
  const normalized = typeof code === 'string' ? code.trim().toLowerCase() : '';
  if (normalized === '' || normalized === '0x') return 'eoa';
  if (DELEGATION_INDICATOR_RE.test(normalized)) return 'eoa';
  return 'contract';
}

function buildSession(
  record: StoredSession,
  address: `0x${string}`,
  flags: { restored: boolean; persisted: boolean },
): ChatSession {
  const session: ChatSession = {
    keypair: { publicKey: record.publicKey, privateKey: record.privateKey },
    address,
    origin: record.origin,
    walletKind: record.walletKind,
    restored: flags.restored,
    persisted: flags.persisted,
  };
  if (record.origin === 'recovery' && record.recoveryCode) {
    _codes.set(session, record.recoveryCode);
  }
  return session;
}

/**
 * Открывает сеанс чата: берёт ключ с устройства, а если его там нет — заводит.
 *
 * Обычный кошелёк — одно окно подписи ЗА ВСЁ ВРЕМЯ на этом устройстве.
 * Кошелёк-контракт — ни одного окна вовсе, вместо него код восстановления
 * (`exportRecoveryCode`).
 */
export async function openSession(
  address: `0x${string}`,
  signTypedData: SignChatKey,
  opts: OpenSessionOptions = {},
): Promise<ChatSession> {
  const key = storageKey(address);

  const joined = _inFlight.get(key);
  if (joined) return joined; // второй вызов в этой вкладке — к первому

  const started = doOpenSession(address, key, signTypedData, opts);
  _inFlight.set(key, started);
  try {
    return await started;
  } finally {
    if (_inFlight.get(key) === started) _inFlight.delete(key);
  }
}

async function doOpenSession(
  address: `0x${string}`,
  key: string,
  signTypedData: SignChatKey,
  opts: OpenSessionOptions,
): Promise<ChatSession> {
  // Чтение с устройства — ПЕРВЫМ, до сети и до замка. Обычный заход не должен
  // зависеть ни от узла RPC, ни от соседней вкладки. Отказ чтения здесь НЕ
  // решает ничего: решение принимается под замком, на повторном чтении —
  // моргнувший диск не должен стоить окна подписи.
  const first = await tryReadRecord(key);
  if (first.status === 'found') {
    return buildSession(first.record, address, { restored: true, persisted: true });
  }

  const timeoutMs = opts.lockTimeoutMs ?? SESSION_LOCK_TIMEOUT_MS;
  return withCrossTabLock(`hexseal-chat-session-${key}`, timeoutMs, async () => {
    // ПЕРЕЧИТАТЬ под замком. Единственное, ради чего замок здесь берётся:
    // без этой строки вторая вкладка, дождавшись очереди, откроет второе
    // окно подписи — замок будет вызван и ничего не запрёт.
    const again = await tryReadRecord(key);
    if (again.status === 'found') {
      return buildSession(again.record, address, { restored: true, persisted: true });
    }
    if (again.status === 'failed') {
      return openWithoutStorage(address, signTypedData, opts, again.error);
    }

    const kind = await walletKind(address, opts);

    let record: StoredSession;
    if (kind === 'contract') {
      const { generateMnemonic } = await import('@scure/bip39');
      const { wordlist } = await import('@scure/bip39/wordlists/english');
      const code = generateMnemonic(wordlist, RECOVERY_ENTROPY_BITS);
      const keypair = await keypairFromRecoveryCode(code);
      record = {
        v: RECORD_VERSION,
        address: key,
        origin: 'recovery',
        walletKind: kind,
        publicKey: keypair.publicKey,
        privateKey: keypair.privateKey,
        recoveryCode: code,
      };
    } else {
      const signature = await signTypedData(CHAT_KEY_TYPED_DATA);
      const keypair = await keypairFromSignature(signature);
      record = {
        v: RECORD_VERSION,
        address: key,
        origin: 'signature',
        walletKind: kind,
        publicKey: keypair.publicKey,
        privateKey: keypair.privateKey,
      };
    }

    const persisted = await writeRecord(key, record);
    return buildSession(record, address, { restored: false, persisted });
  });
}

/**
 * Диск прочитать не удалось. Что делать — зависит от РОДА КОШЕЛЬКА, и
 * разводка возможна только потому, что род берётся ИЗ ЦЕПИ, а не с диска:
 * даже при непрочитанном хранилище мы знаем, с кем имеем дело.
 *
 * Размен несимметричен, и это замерено:
 *
 *  - **обычный кошелёк** (включая делегированный EIP-7702): ключ выводится
 *    из подписи и при повторном выводе получается ПОБАЙТОВО ТОТ ЖЕ.
 *    Непрочитанный диск не стоит ему ничего, кроме лишнего окна подписи —
 *    отказывать такому человеку в переписке не за что.
 *  - **кошелёк-контракт**: ключ случайный, диск — его единственный источник.
 *    Работа вслепую означала бы новую личность поверх старой. Отказ.
 *  - **род не выяснен** (сеть отказала, `getBytecode` не передали): отказ.
 *    Догадка здесь дороже отказа — ошибка в сторону «обычный» упрёт
 *    контрактного в невнятную подпись, ошибка в сторону «контрактный»
 *    молча разведёт его переписку по двум ключам.
 *
 * ⚠️ НИЧЕГО НЕ ПИШЕТ. Под непрочитанной записью может лежать чужой сеанс
 * (соседний адрес, прежняя версия формата, запись другой вкладки) —
 * работать в памяти можно, писать вслепую нельзя. Поэтому `persisted:
 * false` здесь не «не получилось сохранить», а «сохранять и не пробовали».
 */
async function openWithoutStorage(
  address: `0x${string}`,
  signTypedData: SignChatKey,
  opts: OpenSessionOptions,
  readError: ChatSessionError,
): Promise<ChatSession> {
  let kind: WalletKind;
  try {
    kind = await walletKind(address, opts);
  } catch {
    // Проба рода — попытка СМЯГЧИТЬ исходную беду, и её собственный провал
    // диагноз не подменяет: сломалось чтение хранилища, о нём и сообщаем.
    throw readError;
  }

  if (kind === 'contract') throw readError;

  const signature = await signTypedData(CHAT_KEY_TYPED_DATA);
  const keypair = await keypairFromSignature(signature);
  console.warn(
    '[chatSession] хранилище не читается — ключ чата выведен из подписи и живёт только в памяти вкладки; ' +
    'на диск ничего не писали (под непрочитанной записью может лежать чужой сеанс), ' +
    'поэтому подпись будет спрошена снова',
    readError,
  );
  return {
    keypair,
    address,
    origin: 'signature',
    walletKind: kind,
    restored: false,
    persisted: false,
  };
}

/**
 * Восстанавливает сеанс кошелька-контракта из кода восстановления.
 *
 * Каждый отказ — `ChatSessionError` со СВОИМ кодом, а не общий «код не
 * подошёл»: молчаливо другой ключ читается человеком как «переписка
 * пропала», и он не поймёт, что ошибся в одном слове. Различаются: пусто,
 * не то число слов, слово не из списка, контрольная сумма не сошлась.
 *
 * @throws {TypeError} если `code` не строка — это НАШ мусор на входе, то же
 *   правило, что в ядре (`chatCrypto.ts`): сбой не должен носить костюм
 *   штатного результата.
 */
export async function openSessionFromRecoveryCode(
  address: `0x${string}`,
  code: string,
  opts: OpenSessionOptions = {},
): Promise<ChatSession> {
  if (typeof code !== 'string') {
    throw new TypeError('openSessionFromRecoveryCode: code должен быть строкой');
  }

  const key = storageKey(address);

  // ПЕРЕД записью — прочитать. Без этой проверки код восстановления сносил
  // уже лежащий по адресу сеанс, и следующий обычный заход молча отдавал
  // чужой ключ, без окна подписи (находка К-2 независимой проверки). Для
  // кошелька-контракта, чей код не переписан, это потеря навсегда — то есть
  // ровно та необратимость, отсутствие которой обещала шапка этого файла.
  // Снятие сеанса обязано быть отдельным явным действием (`forgetSession`),
  // а не побочным следствием ввода кода.
  const existing = await readRecord(key);
  if (existing) {
    throw new ChatSessionError(
      'По этому адресу на устройстве уже есть сеанс чата: чтобы заменить его кодом восстановления, сначала забудьте текущий',
      'session_already_present',
    );
  }

  const normalized = normalizeRecoveryCode(code);
  if (normalized === '') {
    throw new ChatSessionError('Код восстановления пуст', 'recovery_code_empty');
  }

  const words = normalized.split(' ');
  if (words.length !== RECOVERY_WORD_COUNT) {
    throw new ChatSessionError(
      `Код восстановления — ${RECOVERY_WORD_COUNT} слов, введено ${words.length}`,
      'recovery_code_word_count',
    );
  }

  const { validateMnemonic } = await import('@scure/bip39');
  const { wordlist } = await import('@scure/bip39/wordlists/english');

  // Слово не из списка — отдельный ответ: человеку надо показать НОМЕР слова,
  // а не «код не подошёл» на всю строку. Само слово в сообщение не идёт —
  // сообщение может уехать в журнал.
  const unknownAt = words.findIndex(word => !wordlist.includes(word));
  if (unknownAt !== -1) {
    throw new ChatSessionError(
      `Слово №${unknownAt + 1} не из списка BIP-39`,
      'recovery_code_unknown_word',
    );
  }

  // Контрольная сумма BIP-39 ловит и переставленные слова, и опечатку,
  // случайно давшую другое существующее слово.
  if (!validateMnemonic(normalized, wordlist)) {
    throw new ChatSessionError(
      'Контрольная сумма кода не сходится — проверьте слова и их порядок',
      'recovery_code_checksum',
    );
  }

  // Род кошелька выясняет САМ МОДУЛЬ, а не вызывающий (находка К-3). Гейт
  // стоит ПОСЛЕ дешёвых местных проверок кода (опечатку незачем оплачивать
  // обращением к цепи) и ДО вывода ключа и записи — обычный кошелёк не
  // должен уметь загнать себя в ветку восстановления ни одним способом.
  const kind = await walletKind(address, opts);
  if (kind !== 'contract') {
    throw new ChatSessionError(
      'У этого кошелька ключ чата выводится из подписи: код восстановления ему не нужен и не принимается',
      'recovery_not_applicable',
    );
  }

  const keypair = await keypairFromRecoveryCode(normalized);
  const record: StoredSession = {
    v: RECORD_VERSION,
    address: key,
    origin: 'recovery',
    walletKind: kind,
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    recoveryCode: normalized,
  };
  const persisted = await writeRecord(key, record);
  return buildSession(record, address, { restored: false, persisted });
}

/**
 * Отдаёт код восстановления сеанса.
 *
 * Интерфейс ОБЯЗАН показать рядом предупреждение (см. шапку файла): код —
 * доступ ко всей переписке навсегда, отозвать его нельзя.
 *
 * @throws {ChatSessionError} `recovery_not_applicable` — у обычного кошелька
 *   кода нет и не должно быть; его восстановление — сам кошелёк.
 */
export function exportRecoveryCode(session: ChatSession): string {
  // Два независимых условия, а не одно с запасом: `origin` говорит, откуда
  // ключ, `walletKind` — кому он принадлежит. Сверка с родом кошелька ловит
  // запись, у которой происхождение подменено (находка К-3): интерфейс может
  // не показать кнопку, но не может отменить уже переписанную запись.
  if (session.origin === 'signature' || session.walletKind !== 'contract') {
    throw new ChatSessionError(
      'У обычного кошелька кода восстановления нет: подпишите те же данные тем же кошельком на новом устройстве',
      'recovery_not_applicable',
    );
  }
  const code = _codes.get(session);
  if (!code) {
    throw new ChatSessionError(
      'Код восстановления недоступен для этого объекта сеанса',
      'recovery_code_unavailable',
    );
  }
  return code;
}

/**
 * Убирает ключ с устройства. Следующее открытие сеанса заведёт его заново —
 * обычному кошельку через новое окно подписи (тот же ключ), кошельку-
 * контракту через новый случайный ключ (прежняя переписка станет нечитаемой,
 * если код восстановления не сохранён).
 *
 * @throws {ChatSessionError} `forget_failed` — удалить не удалось. Молча
 *   вернуть «забыто» значило бы соврать: ключ остался на устройстве.
 */
export async function forgetSession(address: `0x${string}`): Promise<void> {
  const key = storageKey(address); // форма адреса — до всего остального
  if (!idbFactory()) return; // хранилища нет — забывать нечего
  try {
    await idbDelete(key);
  } catch (err) {
    throw new ChatSessionError(
      'chatSession: не удалось убрать ключ с устройства',
      'forget_failed',
      { cause: err },
    );
  }
}
