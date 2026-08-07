/**
 * chatConversation.ts — разговор: отправка, приём, порядок, разрывы.
 *
 * Верхний из трёх слоёв между ядром (`chatCrypto.ts`, `chatChain.ts`) и
 * проводом (`chatTransport.ts`). Ниже него — конверт (`chatEnvelope.ts`) и
 * сеанс (`chatSession.ts`). Выше — хуки (Задача 6), React здесь не знают.
 *
 * ─── ЧТО ЕДЕТ В МЕШКЕ ───────────────────────────────────────────────────
 *
 * Мешок — это КАДР: подписанное звено цепочки плюс запечатанный конверт.
 *
 *   [ version:1 ][ signerPub:32 ][ signature:64 ][ seq:u32 ][ sentAt:u64 ]
 *   [ prevHash:32 ][ bodyHash:32 ][ sender:20 ][ envelope:N ]
 *                                                  ↑ ровно одно поле
 *                                                    переменной ширины,
 *                                                    и оно последнее
 *
 * Заголовок — 193 байта. Одно динамическое поле в конце — та же дисциплина,
 * что в `chatChain.ts` (`LINK_ENCODING_TYPES`) и `chatEnvelope.ts`: при двух
 * динамических полях граница между ними плавает, и упаковка перестаёт быть
 * однозначной ещё до всякого хеширования.
 *
 * ⚠️ ЗВЕНО ЕДЕТ ОТКРЫТЫМ, СОДЕРЖИМОЕ — НЕТ. Сервер и так видит отправителя,
 * получателя, размер и время (§2 общей спеки: метаданные не скрываются).
 * Номер и два отпечатка добавляют к этому порядковый счётчик — то, что сервер
 * и так восстановил бы по времени загрузки. ЗАТО открытое звено даёт вещь,
 * которая дороже: мешок, который получатель НЕ СМОГ ВСКРЫТЬ (собеседник
 * запечатал на устаревший ключ из справочника), всё равно занимает своё место
 * в цепочке — и не выглядит вырезанным сообщением. Спрятав звено внутрь
 * конверта, мы бы превращали каждую собственную неудачу расшифровки в
 * обвинение собеседнику в утаивании.
 *
 * ─── ПОДПИСЫВАТЬ ЗВЕНО БЫЛО НЕЧЕМ ───────────────────────────────────────
 *
 * `deriveChatKeypair` (chatCrypto.ts) даёт пару ТОЛЬКО ДЛЯ ШИФРОВАНИЯ
 * (X25519, `crypto_box`). Подписи она не умеет, и это прямо записано в §11
 * общей спеки как то, на что наступит этот план.
 *
 * Скормить то же семя второму алгоритму (Ed25519) НЕЛЬЗЯ — классический
 * способ утечки закрытого ключа: у X25519 и Ed25519 разная обработка семени
 * (клэмпинг), и связанные таким образом ключи перестают быть независимыми.
 * Поэтому подписная пара выводится ОТДЕЛЬНЫМ ПОД-КЛЮЧОМ:
 *
 *   seed = keccak256( "hexseal.chat.link.sig.key.v1" ‖ closedKeyX25519 )
 *   pair = crypto_sign_seed_keypair(seed)               // Ed25519
 *
 * Форма повторяет ту, которой `chatCrypto.ts` уже разводит области
 * применения (`CHAT_KEY_SEED_CONTEXT`) и `chatSession.ts` — код
 * восстановления (`RECOVERY_SEED_CONTEXT`): метка назначения впереди
 * секрета, keccak256 как ключевыводящая функция. Заперто золотыми векторами
 * (посчитаны независимым путём, через ethers, и записаны в тест руками).
 *
 * ⚠️ `linkPreimage` (chatChain.ts) отдаёт СЫРЫЕ БАЙТЫ БЕЗ ДОМЕННОЙ РАЗМЕТКИ —
 * §11 общей спеки. Подписывается не он, а `LINK_SIGNATURE_DOMAIN ‖ preimage`
 * (см. `linkSignaturePreimage`): без метки та же подпись значила бы то же
 * самое в любом другом протоколе, который однажды подпишет байты той же
 * формы этим же ключом.
 *
 * ─── ПОЧЕМУ `ChainLink` НЕ ТРОНУТ ───────────────────────────────────────
 *
 * Напрашивалось добавить `signature` полем в сам `ChainLink`. Не сделано, и
 * причина не в осторожности:
 *
 *  1. Подпись покрывает звено — значит она не может быть ЧАСТЬЮ звена, иначе
 *     подписывать пришлось бы то, что зависит от подписи. `chatChain.ts` это
 *     прямо предвидит в шапке (раунд 6, мутация 1: «подпись, дописанная
 *     СНАРУЖИ константы… ровно вероятная форма плана 3»).
 *  2. Добавление поля в `ChainLink` трогает ТРИ места без механической связи
 *     между ними (тип, `LINK_ENCODING_TYPES`/`linkPreimage`, `isWellFormedLink`
 *     — §11 общей спеки). Не тронув ни одного, мы не можем забыть третье.
 *
 * Подпись и подписной ключ едут РЯДОМ со звеном, в кадре. К цепочке они
 * пришиты через `bodyHash`:
 *
 *   bodyHash = keccak256( "hexseal.chat.body.v1" ‖ signerPub ‖ envelope )
 *
 * То есть подписной ключ и байты конверта ВХОДЯТ в отпечаток звена, а тот —
 * в `prevHash` следующего. Подменить подписной ключ у ОДНОГО звена нельзя:
 * поедет `bodyHash`, за ним `linkHash`, и следующее звено перестанет
 * сходиться. Подменить у ВСЕЙ цепочки разом — можно (это та самая каскадная
 * подделка, от которой защищает только внешний якорь, §5 общей спеки), и
 * ровно от неё существует `peerSigningPublicKeys` — пин ключа снаружи.
 *
 * ⚠️⚠️ ЧЕСТНО О ТОМ, ЧЕГО ЭТА ЦЕПОЧКА НЕ ДЕЛАЕТ. Читать прежде, чем строить
 * поверх неё что-либо про спор (находка К-1 враждебной проверки, замерена
 * девятью способами спрятать сообщение).
 *
 * **Ловится:** не отдали середину; не отдали начало; два звена с одним
 * номером; ссылка в пустоту; подпись ЧУЖИМ ключом при заданном пине.
 *
 * **НЕ ловится, и не будет ловиться этим модулем:**
 *  - не отдали ХВОСТ, начиная с неудобного места — `ok: true`, ни одной тревоги;
 *  - пересобрали всю цепочку своим ключом, вписав другое содержимое, —
 *    `ok: true`;
 *  - перенумеровали остаток (0,1,3,4 → 0,1,2,3), чтобы дыры не осталось, —
 *    `ok: true`;
 *  - всё то же самое ПРИ ЗАДАННОМ пине ключа — `ok: true`.
 *
 * Последнее — главное, и прежняя редакция этой шапки утверждала обратное.
 * `peerSigningPublicKeys` закрывает РОВНО ОДИН класс: подпись ДРУГИМ ключом.
 * Против законного владельца ключа, вычищающего собственное исходящее, пин не
 * даёт НИЧЕГО: он подписывает заново своим же настоящим ключом, и всё сходится.
 *
 * Отсюда правило употребления, нарушать которое нельзя:
 * **`ok: true` без внешнего якоря означает «самопротиворечий не найдено», а НЕ
 * «предъявлено всё».** Именно поэтому `verifyChain` отдаёт
 * `unverifiedContentAtSeq` — без якоря он перечисляет ВСЁ показанное, и это
 * честный ответ, а не формальность. До арбитра как справка о здоровье
 * `ok: true` доходить не должен (§11 общей спеки говорит то же самое).
 *
 * Весь этот класс закрывается ЯКОРЁМ ВЕРХУШКИ, который приходит извне (§5
 * общей спеки: копия контрагента либо счёт мешков на сервере). Якорь — план 4,
 * и так задумано; здесь для него готовы данные (`ChatMessage.proof` у ОБЕИХ
 * половин переписки), но самого якоря нет.
 *
 * ⚠️ И про то, где эта защита ВООБЩЕ проверяется. Стендовый тест ловит
 * вырезание при живой выдаче со склада — но там собеседник ничего вырезать и не
 * может: мешки лежат в чужом ящике. А в том сценарии, ради которого цепочка
 * существует (сторона ПРЕДЪЯВЛЯЕТ СВОЮ КОПИЮ), предъявитель держит все кадры и
 * подписывает заново что угодно. Механизм показан там, где нападения нет, и
 * молчит там, где оно есть. Это не чинится в этом модуле — только якорем.
 *
 * ⚠️ Про сам подписной ключ. Вывести его из ключа ШИФРОВАНИЯ собеседника
 * нельзя (он выводится из ЗАКРЫТОЙ половины), значит он обязан прийти извне.
 * Источник готов: справочник Задачи 2 (`relayer/directory.js`,
 * `GET /keys/:address`) хранит рядом с `boxKey` ещё и `signKey` — 32 байта hex,
 * ровно ширина открытой половины Ed25519, которую производит этот модуль. Поле
 * сегодня никем не заполняется: публикует его тот, кто заводит сеанс, то есть
 * хук Задачи 6. Без пина проверка подписи ловит подмену ОДНОГО звена, порчу
 * байтов по дороге и смену ключа посреди переписки — и, повторим, не ловит
 * ничего из списка выше.
 *
 * ─── КАЖДАЯ СТОРОНА ВЕДЁТ СВОЮ ЦЕПОЧКУ ──────────────────────────────────
 *
 * Не одна общая на двоих. Общая означала бы, что оба участника постоянно
 * строят звено № N+1 от одного и того же предыдущего — то есть гонка на
 * каждом втором сообщении, встроенная в формат. Каждый нумерует СВОИ
 * сообщения (`buildLink` от своего же последнего), и порядок между сторонами
 * восстанавливается слиянием по времени отправки. План говорит ровно это:
 * «номер следующего берётся от последнего СВОЕГО».
 *
 * Следствие: `receiveBags` разбирает столько цепочек, сколько отправителей в
 * ящике, и вердикт у каждой свой (`chains`). Мешок постороннего не портит
 * вердикт собеседнику — и, начиная с находки В-3 враждебной проверки, не
 * портит и ГЛАВНЫЙ ИТОГ: разрывы называют автора (`gaps`). Прежде это
 * обещание было верным только для карты вердиктов, а плоский список разрывов
 * приписывал дыру постороннего переписке с собеседником — при том, что
 * посторонний становится виден в общем ящике, просто положив туда мешок.
 *
 * ─── НОМЕР ЖИВЁТ НА УСТРОЙСТВЕ, А НЕ В ПАМЯТИ ВКЛАДКИ ───────────────────
 *
 * Голова разговора (последнее ОТПРАВЛЕННОЕ звено) лежит в `IndexedDB`, в
 * СВОЕЙ базе (`hexseal-chat-conv`) — не в базе сеанса: там версия схемы
 * своя, и добавление хранилища туда означало бы повышение версии чужого
 * модуля.
 *
 * Две вкладки не выдают один номер дважды за счёт ДВУХ вещей сразу, и ни
 * одна из них по отдельности не работает:
 *  - межвкладочный замок (Web Locks) — сериализует;
 *  - ПЕРЕЧИТЫВАНИЕ головы ПОД ЗАМКОМ — собственно защищает.
 * В этом проекте уже был «замок, который не запирает» — замок, взятый и не
 * перечитавший общее состояние, не делает ничего. `prevLink`, поданный
 * вызывающим, — только НИЖНЯЯ граница: если он ушёл вперёд диска (диск
 * почистили, а вкладка помнит), берётся он; голова всегда побеждает при
 * равенстве и опережении.
 *
 * ─── РЕЗЕРВ НОМЕРА ИДЁТ ДО ОТПРАВКИ, И ЭТО РАЗМЕН ───────────────────────
 *
 * Порядок такой: собрать конверт → взять замок → перечитать голову →
 * построить и подписать звено → ЗАПИСАТЬ голову на диск → положить мешок на
 * склад → отметить, что положен.
 *
 * Обратный порядок («сначала положить, потом записать») на закрытой посреди
 * вкладке даёт ДВА звена с одним номером — вердикт `unordered` у
 * собеседника, то есть обвинение в ПОДДЕЛКЕ за собственный сбой. Выбранный
 * порядок даёт в том же случае ДЫРУ в нумерации — вердикт `gap`, обвинение в
 * УТАИВАНИИ. Обвинение в утаивании легче подделки (§5 общей спеки: это
 * разные санкции), поэтому размен сделан в эту сторону.
 *
 * ⚠️ И это НЕ чинится до конца. У НАС дыра отличима: сгоревшие номера лежат
 * на устройстве (`listBurnedSeqs`), интерфейс может честно сказать «эти наши
 * сообщения не ушли». У СОБЕСЕДНИКА — НЕ отличима ничем: он видит ровно ту же
 * дыру, что от намеренного утаивания. Единственное, что здесь сделано, —
 * дыра не появляется там, где её можно не делать: отказ склада, о котором
 * ТОЧНО известно, что мешок не лёг (400/401/403/413/429 — все эти ветки
 * `relayer/app.js` удаляют файл), откатывает резерв.
 *
 * ─── ЧЕГО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ ─────────────────────────────────────────
 *
 *  - НЕ ходит за пропуском склада: `pass` подаётся снаружи. Ходить за ним
 *    значило бы уметь открывать окно кошелька, а отправка не должна уметь
 *    этого в принципе.
 *  - НЕ проверяет ЯКОРЬ верхушки (`ChainAnchor`). Без него `ok: true`
 *    означает только «самопротиворечий не найдено», и `unverifiedContentAtSeq`
 *    в вердикте называет ВСЁ показанное. Обрезанный хвост здесь не ловится
 *    ничем — это свойство любой такой цепочки (§5 общей спеки), а не
 *    недосмотр. Якорь — план 4.
 *  - НЕ хранит переписку. Мешки живут на складе (7 дней или до конца окна
 *    спора), свои копии — дело слоя выше. Отсюда: цепочка, начинающаяся не с
 *    нуля, честно даёт `gapAfterSeq: [-1]` — «начало не предъявлено», и
 *    отличить «истекло» от «утаено» этому модулю нечем.
 */

import { keccak256, concat, stringToBytes, hexToBytes, isAddress } from 'viem';
import type { ChatKeypair } from './chatCrypto';
import {
  buildLink,
  linkPreimage,
  verifyChain,
  type ChainLink,
  type ChainVerdict,
} from './chatChain';
import { packEnvelope, unpackEnvelope, type ChatPayload } from './chatEnvelope';
import { putBag, BagTransportError } from './chatTransport';
import type { ChatSession } from './chatSession';

/* ─────────────────────────── константы формата ────────────────────────── */

export const FRAME_VERSION = 1;

/** Ed25519: подпись 64 байта, открытый ключ 32 (`crypto_sign_BYTES` /
 *  `crypto_sign_PUBLICKEYBYTES` — измерено на самой библиотеке, не взято на
 *  веру; `encodeFrame` сверяет фактическую длину и отказывает громко). */
export const LINK_SIGNATURE_LEN = 64;
export const LINK_SIGNING_PUBLIC_KEY_LEN = 32;

/** Длина закрытой половины Ed25519 в libsodium — семя ‖ открытый ключ. */
const LINK_SIGNING_PRIVATE_KEY_LEN = 64;

/** Длина обеих половин пары X25519 (`crypto_box`) — та же проверка и по той
 *  же причине, что `KEY_LEN` в `chatSession.ts`: строка ровно в 32 UTF-8
 *  байта приводится libsodium молча. */
const CHAT_KEY_LEN = 32;

const OFF_VERSION    = 0;
const OFF_SIGNER_PUB = 1;
const OFF_SIGNATURE  = OFF_SIGNER_PUB + LINK_SIGNING_PUBLIC_KEY_LEN;   // 33
const OFF_SEQ        = OFF_SIGNATURE + LINK_SIGNATURE_LEN;             // 97
const OFF_SENT_AT    = OFF_SEQ + 4;                                    // 101
const OFF_PREV_HASH  = OFF_SENT_AT + 8;                                // 109
const OFF_BODY_HASH  = OFF_PREV_HASH + 32;                             // 141
const OFF_SENDER     = OFF_BODY_HASH + 32;                             // 173

/** Ширина заголовка кадра. Записана ЯВНЫМ числом, а не только суммой смещений
 *  выше: тест сверяет руками записанное 193 (правило проекта — тест, берущий
 *  величину ИЗ проверяемого модуля, доказывает только «какая-то есть»). */
export const FRAME_HEADER_LEN = OFF_SENDER + 20;                       // 193

/** Номер звена едет четырьмя байтами. Потолок назван явно: `isWellFormedLink`
 *  в `chatChain.ts` принимает любое безопасное целое, а кадр — нет, и разница
 *  обязана быть громкой на СБОРКЕ, а не тихой порчей на разборе. Четыре
 *  миллиарда сообщений в одной переписке — заведомо больше, чем бывает. */
export const MAX_LINK_SEQ = 0xffff_ffff;

/** Метка назначения под-ключа подписи. Меняется — меняются подписи у ВСЕХ
 *  разом, и прежние перестают проверяться. */
export const LINK_SIGNING_KEY_CONTEXT = 'hexseal.chat.link.sig.key.v1';

/** Доменная разметка подписи. `linkPreimage` отдаёт сырые байты (§11 общей
 *  спеки) — подписывается метка ‖ преимидж, не преимидж. */
export const LINK_SIGNATURE_DOMAIN = 'hexseal.chat.link.sig.v1';

/** Метка отпечатка тела. Через него подписной ключ и байты конверта попадают
 *  в звено, а значит и в цепочку. */
export const MESSAGE_BODY_CONTEXT = 'hexseal.chat.body.v1';

/** Потолок ожидания межвкладочного замка. Под ним стоит не окно подписи (как
 *  в `chatSession.ts`, где потолок три минуты — человек имеет право думать), а
 *  сетевая отправка одного мешка: 30 секунд заведомо больше любой честной
 *  загрузки четверти мегабайта и заведомо меньше человеческого терпения.
 *  Держатель, брошенный навсегда (вкладку выгрузили посреди отправки), не
 *  должен запирать переписку до перезагрузки страницы.
 *
 *  ⚠️ ЦЕНА ИСТЕЧЕНИЯ НАЗВАНА (мелочь враждебной проверки, замерена): после
 *  потолка мы едем БЕЗ замка, и если прежний держатель всё-таки жив, обе
 *  вкладки читают одну и ту же голову — получаются ДВА ЗВЕНА С ОДНИМ НОМЕРОМ,
 *  то есть вердикт `unordered` у собеседника. Ровно то обвинение в подделке,
 *  ради ухода от которого сделан весь размен «дыра вместо двойного номера».
 *  Размен здесь другой и осознанный: заклиненная навсегда переписка хуже
 *  редкого столкновения номеров, потому что заклиненную человек не починит
 *  ничем, кроме перезагрузки. */
export const CONVERSATION_LOCK_TIMEOUT_MS = 30_000;

/**
 * Сколько сгоревших номеров помнить. Список ложится на диск при КАЖДОЙ
 * отправке, поэтому расти без предела он не может: триста обрывов — триста
 * записей в каждой последующей транзакции. Вытесняется самое давнее: свежий
 * обрыв человеку интереснее прошлогоднего, а для «сколько всего» этот список
 * и не предназначен.
 *
 * ⚠️ Цена вытеснения названа вслух: обрывов больше потолка — и самые ранние
 * дыры в нашей нумерации перестают быть отличимы от утаивания даже у НАС.
 * Двести — заведомо больше, чем бывает у живого человека между заходами, и
 * заведомо меньше, чем стоит держать в одной записи.
 */
export const MAX_BURNED_SEQS = 200;

const DB_NAME = 'hexseal-chat-conv';
const DB_VERSION = 1;
const STORE_NAME = 'conversations';

/** Версия формата записи головы. Другая (в т.ч. большая — от более новой
 *  сборки) считается ОТСУТСТВИЕМ: лучше начать нумерацию заново, чем
 *  продолжить её от полей, значение которых сегодня другое. */
export const HEAD_RECORD_VERSION = 1;

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/* ──────────────────────────────── ошибки ──────────────────────────────── */

export type ChatConversationErrorCode =
  /** Адрес (свой, собеседника) не похож на адрес. */
  | 'address_malformed'
  /** Открытый ключ собеседника не 32 байта / не байты вовсе. */
  | 'peer_key_malformed'
  /** Сообщение не влезает в конверт (потолок `chatEnvelope.MAX_ENVELOPE_BYTES`
   *  = предел приёма склада). Номер при этом НЕ резервируется. */
  | 'message_too_large'
  /** Номер звена не влезает в кадр. */
  | 'seq_overflow'
  /** Голову с устройства прочитать не удалось. НЕ то же, что «головы нет»:
   *  пустоту мы не установили, а начать нумерацию заново вслепую значит выдать
   *  собеседнику второе звено с тем же номером — вердикт `unordered`, то есть
   *  обвинение в подделке. Тот же разбор, что `storage_read_failed` в
   *  `chatSession.ts`. */
  | 'head_read_failed'
  /** Склад не принял мешок. `.cause` — исходная ошибка транспорта с её `.code`
   *  и `.status`. */
  | 'send_failed';

/** Каждый отказ несёт `.code` ОТДЕЛЬНЫМ полем — та же дисциплина, что в
 *  `chatTransport.ts` и `chatSession.ts`: сравнение текста ошибки ломается от
 *  первой же правки формулировки. */
export class ChatConversationError extends Error {
  readonly code: ChatConversationErrorCode;
  /** Проброшен наверх с ошибки транспорта, чтобы вызывающий отличал «слишком
   *  большой файл» от «негодный адрес» кодом, а не разбором английского
   *  текста (`OPEN-ITEMS` 29.2). */
  readonly status?: number;
  constructor(message: string, code: ChatConversationErrorCode, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = 'ChatConversationError';
    this.code = code;
    this.status = options?.status;
  }
}

function assertAddress(value: unknown, what: string): `0x${string}` {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value.toLowerCase()) || !isAddress(value, { strict: false })) {
    throw new ChatConversationError(
      `chatConversation: ${what} не похож на адрес (${typeof value === 'string' ? `«${value}»` : typeof value})`,
      'address_malformed',
    );
  }
  return value.toLowerCase() as `0x${string}`;
}

/* ─────────────────────── подписная пара для звена ─────────────────────── */

export interface LinkSigningKeypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** Выведенная пара живёт ровно столько, сколько объект ключей сеанса. Ключ
 *  карты — сам объект `ChatKeypair`, не его байты: `WeakMap` не удержит его от
 *  сборки мусора и не сериализуется никуда. */
const _signingKeys = new WeakMap<ChatKeypair, Promise<LinkSigningKeypair>>();

/**
 * Подписная пара Ed25519, выведенная ОТДЕЛЬНЫМ ПОД-КЛЮЧОМ из закрытой
 * половины пары шифрования (см. шапку файла — это главная ловушка задачи).
 *
 * @throws {TypeError} если `keypair.privateKey` не 32-байтный `Uint8Array` —
 *   наш собственный мусор на входе, то же правило, что в ядре
 *   (`chatCrypto.ts`): сбой не должен носить костюм штатного результата.
 *   Молчаливый приём здесь означал бы одну и ту же подписную пару у всех, кому
 *   прилетел один и тот же мусор.
 */
export async function deriveLinkSigningKeypair(keypair: ChatKeypair): Promise<LinkSigningKeypair> {
  if (!keypair || typeof keypair !== 'object') {
    throw new TypeError('deriveLinkSigningKeypair: ожидается пара ключей чата');
  }
  const cached = _signingKeys.get(keypair);
  if (cached) return cached;

  if (!(keypair.privateKey instanceof Uint8Array)) {
    throw new TypeError('deriveLinkSigningKeypair: keypair.privateKey должен быть Uint8Array (не строка/иное)');
  }
  if (keypair.privateKey.length !== CHAT_KEY_LEN) {
    throw new TypeError(
      `deriveLinkSigningKeypair: keypair.privateKey должен быть ${CHAT_KEY_LEN} байт, получено ${keypair.privateKey.length}`,
    );
  }

  const promise = (async (): Promise<LinkSigningKeypair> => {
    const seed = keccak256(
      concat([stringToBytes(LINK_SIGNING_KEY_CONTEXT), keypair.privateKey]),
      'bytes',
    );
    // Динамический импорт — по той же причине, что в `chatCrypto.ts`:
    // статический кладёт ~147 КБ gzip в общий чанк сборки Next.
    const sodium = (await import('libsodium-wrappers')).default;
    await sodium.ready;
    const { publicKey, privateKey } = sodium.crypto_sign_seed_keypair(seed);
    return { publicKey, privateKey };
  })();

  _signingKeys.set(keypair, promise);
  // Неудачную попытку не кэшируем: иначе один сбой библиотеки запер бы
  // подпись для этой пары навсегда.
  promise.catch(() => { if (_signingKeys.get(keypair) === promise) _signingKeys.delete(keypair); });
  return promise;
}

/** Байты, которые реально подписываются: доменная метка ‖ преимидж звена. */
export function linkSignaturePreimage(link: ChainLink): Uint8Array {
  return concat([stringToBytes(LINK_SIGNATURE_DOMAIN), hexToBytes(linkPreimage(link))]);
}

/** Отпечаток тела сообщения — то, что попадает в звено полем `bodyHash`.
 *  Подписной ключ входит СЮДА, а не рядом: так он оказывается пришит к
 *  цепочке (см. шапку файла). */
export function messageBodyHash(signerPublicKey: Uint8Array, envelope: Uint8Array): `0x${string}` {
  if (!(signerPublicKey instanceof Uint8Array) || !(envelope instanceof Uint8Array)) {
    throw new TypeError('messageBodyHash: ожидаются Uint8Array (подписной ключ и конверт)');
  }
  // Ширина ключа ФИКСИРОВАНА, и это не формальность: при плавающей ширине
  // `МЕТКА ‖ ключ ‖ конверт` — два поля переменной ширины подряд, то есть
  // ровно та неоднозначность упаковки, которую запрещает `chatChain.ts`
  // (граница МЕЖДУ ними плавает). Коллизия найдена враждебной проверкой:
  // ключ на байт короче плюс тот же байт в начало конверта дают ТОТ ЖЕ
  // отпечаток. На проводе недостижимо — кадр фиксирует 32 байта, — но эта
  // функция вынесена наружу, значит гейт обязан стоять в ней самой, а не в её
  // единственном сегодняшнем вызывающем.
  if (signerPublicKey.length !== LINK_SIGNING_PUBLIC_KEY_LEN) {
    throw new TypeError(
      `messageBodyHash: подписной ключ должен быть ${LINK_SIGNING_PUBLIC_KEY_LEN} байт, получено ${signerPublicKey.length}`,
    );
  }
  return keccak256(concat([stringToBytes(MESSAGE_BODY_CONTEXT), signerPublicKey, envelope]));
}

/* ──────────────────────────────── кадр ────────────────────────────────── */

export interface SignedLinkFrame {
  link: ChainLink;
  signature: Uint8Array;
  signerPublicKey: Uint8Array;
  envelope: Uint8Array;
}

/**
 * Собирает байты мешка.
 *
 * @throws {ChatConversationError} `seq_overflow` — номер не влезает в четыре
 *   байта. Громко на сборке лучше, чем тихо испорченный номер на разборе.
 * @throws {TypeError} мусор в полях (не байты, не та длина) — наш вход.
 */
export function encodeFrame(frame: SignedLinkFrame): Uint8Array {
  const { link, signature, signerPublicKey, envelope } = frame;
  if (!(signature instanceof Uint8Array) || signature.length !== LINK_SIGNATURE_LEN) {
    throw new TypeError(`encodeFrame: подпись должна быть ${LINK_SIGNATURE_LEN} байт`);
  }
  if (!(signerPublicKey instanceof Uint8Array) || signerPublicKey.length !== LINK_SIGNING_PUBLIC_KEY_LEN) {
    throw new TypeError(`encodeFrame: подписной ключ должен быть ${LINK_SIGNING_PUBLIC_KEY_LEN} байт`);
  }
  if (!(envelope instanceof Uint8Array) || envelope.length === 0) {
    throw new TypeError('encodeFrame: конверт должен быть непустым Uint8Array');
  }
  if (!Number.isSafeInteger(link.seq) || link.seq < 0 || link.seq > MAX_LINK_SEQ) {
    throw new ChatConversationError(
      `encodeFrame: seq ${link.seq} вне кадра (0..${MAX_LINK_SEQ})`,
      'seq_overflow',
    );
  }
  if (!Number.isSafeInteger(link.sentAt) || link.sentAt < 0) {
    throw new TypeError(`encodeFrame: sentAt должен быть безопасным неотрицательным целым, получено ${link.sentAt}`);
  }

  const out = new Uint8Array(FRAME_HEADER_LEN + envelope.length);
  const view = new DataView(out.buffer);
  out[OFF_VERSION] = FRAME_VERSION;
  out.set(signerPublicKey, OFF_SIGNER_PUB);
  out.set(signature, OFF_SIGNATURE);
  view.setUint32(OFF_SEQ, link.seq);
  view.setBigUint64(OFF_SENT_AT, BigInt(link.sentAt));
  out.set(hexToBytes(link.prevHash), OFF_PREV_HASH);
  out.set(hexToBytes(link.bodyHash), OFF_BODY_HASH);
  out.set(hexToBytes(link.sender), OFF_SENDER);
  out.set(envelope, FRAME_HEADER_LEN);
  return out;
}

function hexOf(bytes: Uint8Array): `0x${string}` {
  let s = '0x';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s as `0x${string}`;
}

/**
 * Разбирает байты мешка.
 *
 * `null` — «это не наш кадр или он повреждён»: короче заголовка, без конверта,
 * незнакомая версия, время вне безопасных целых. Это ЧУЖИЕ данные из сети,
 * отказ по ним — штатный исход, а не сбой.
 *
 * @throws {TypeError} если `bytes` не `Uint8Array` — НАШ мусор на входе (то же
 *   правило, что `unpackEnvelope`/`openSealed`).
 */
export function decodeFrame(bytes: Uint8Array): SignedLinkFrame | null {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('decodeFrame: bytes должен быть Uint8Array (не строка/иное)');
  }
  // Строго БОЛЬШЕ заголовка: кадр без конверта — не сообщение. Склад применяет
  // то же правило на приёме (пустое тело отвергается, relayer/app.js).
  if (bytes.length <= FRAME_HEADER_LEN) return null;
  if (bytes[OFF_VERSION] !== FRAME_VERSION) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seq = view.getUint32(OFF_SEQ);
  const sentAtBig = view.getBigUint64(OFF_SENT_AT);
  // Время из сети может быть каким угодно. Больше безопасного целого — это не
  // «далёкое будущее», это число, с которым JS уже врёт (x + 1 === x), а
  // `linkPreimage` на нём бросает. Отказ, а не тихое округление.
  if (sentAtBig > BigInt(Number.MAX_SAFE_INTEGER)) return null;

  return {
    link: {
      seq,
      prevHash: hexOf(bytes.subarray(OFF_PREV_HASH, OFF_PREV_HASH + 32)),
      bodyHash: hexOf(bytes.subarray(OFF_BODY_HASH, OFF_BODY_HASH + 32)),
      sender: hexOf(bytes.subarray(OFF_SENDER, OFF_SENDER + 20)),
      sentAt: Number(sentAtBig),
    },
    signerPublicKey: bytes.slice(OFF_SIGNER_PUB, OFF_SIGNER_PUB + LINK_SIGNING_PUBLIC_KEY_LEN),
    signature: bytes.slice(OFF_SIGNATURE, OFF_SIGNATURE + LINK_SIGNATURE_LEN),
    envelope: bytes.slice(FRAME_HEADER_LEN),
  };
}

/* ─────────────────── голова разговора на устройстве ───────────────────── */

export interface ConversationHead {
  /** Последнее ОТПРАВЛЕННОЕ звено этой стороны. */
  link: ChainLink;
  /** Ключ мешка на складе; `null` — резерв записан, но мешок ещё не положен
   *  (или отправка оборвалась, и судьба мешка неизвестна). */
  key: string | null;
}

interface StoredHead {
  v: number;
  /** Дублирует ключ хранилища НАМЕРЕННО — та же дисциплина, что в
   *  `chatSession.ts`: ключ говорит, где лежит, поле — чья запись. Регресс в
   *  вычислении ключа иначе выдал бы нумерацию одного разговора другому. */
  id: string;
  link: ChainLink;
  key: string | null;
  /** Номера, зарезервированные и не подтверждённые отправкой: мешок мог
   *  доехать, а мог и нет. Не переиспользуются (см. шапку файла). */
  burned: number[];
}

function conversationId(own: string, peer: string): string {
  return `${own}|${peer}`;
}

function idbFactory(): IDBFactory | null {
  const g = globalThis as { indexedDB?: IDBFactory };
  return g.indexedDB ?? null;
}

function openDb(): Promise<IDBDatabase> {
  const factory = idbFactory();
  if (!factory) return Promise.reject(new Error('chatConversation: IndexedDB недоступен'));
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('chatConversation: не удалось открыть хранилище'));
    req.onblocked = () => reject(new Error('chatConversation: хранилище занято другой вкладкой'));
  });
}

async function idbGet(key: string): Promise<unknown> {
  const db = await openDb();
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('chatConversation: чтение не удалось'));
      tx.onabort = () => reject(tx.error ?? new Error('chatConversation: чтение прервано'));
    });
  } finally {
    db.close();
  }
}

/** Ответ даётся на `tx.oncomplete` — на ФИКСАЦИИ транзакции, а не на успехе
 *  запроса: успех запроса ещё не означает, что резерв номера переживёт
 *  закрытие вкладки, а фиксация — означает. Та же причина, что у `idbPut` в
 *  `chatSession.ts`, и здесь она несущая: на этом стоит весь размен «дыра
 *  вместо двойного номера». */
async function idbPut(key: string, value: StoredHead): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('chatConversation: запись прервана'));
      tx.onerror = () => reject(tx.error ?? new Error('chatConversation: запись не удалась'));
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
      tx.onabort = () => reject(tx.error ?? new Error('chatConversation: удаление прервано'));
      tx.onerror = () => reject(tx.error ?? new Error('chatConversation: удаление не удалось'));
      tx.objectStore(STORE_NAME).delete(key);
    });
  } finally {
    db.close();
  }
}

/** Гейт формы записи с устройства. Данные из хранилища доверия не заслуживают
 *  ровно как данные из сети: их мог записать предыдущий выпуск, их мог
 *  испортить сбой. Не сошлось — считаем, что записи нет. */
function isWellFormedHead(value: unknown, expectedId: string): value is StoredHead {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (r.v !== HEAD_RECORD_VERSION) return false;
  if (r.id !== expectedId) return false;
  if (r.key !== null && typeof r.key !== 'string') return false;
  if (!Array.isArray(r.burned) || !r.burned.every(n => Number.isSafeInteger(n) && (n as number) >= 0)) return false;
  const l = r.link as Record<string, unknown> | undefined;
  if (typeof l !== 'object' || l === null) return false;
  return (
    Number.isSafeInteger(l.seq) && (l.seq as number) >= 0 && (l.seq as number) <= MAX_LINK_SEQ &&
    typeof l.prevHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(l.prevHash) &&
    typeof l.bodyHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(l.bodyHash) &&
    typeof l.sender === 'string' && ADDRESS_RE.test(l.sender.toLowerCase()) &&
    Number.isSafeInteger(l.sentAt) && (l.sentAt as number) >= 0
  );
}

/**
 * Читает запись головы.
 *
 * @throws {ChatConversationError} `head_read_failed` — отказ ЧТЕНИЯ, а не
 *   пустота. Разница дорогая: молча решив «головы нет», мы выдали бы
 *   собеседнику второе звено с номером 0.
 */
async function readHeadRecord(id: string): Promise<StoredHead | null> {
  if (!idbFactory()) return null; // хранилища нет — вывод «пусто» обоснован
  let raw: unknown;
  try {
    raw = await idbGet(id);
  } catch (err) {
    throw new ChatConversationError(
      'chatConversation: не удалось прочитать нумерацию разговора с устройства — повторите позже',
      'head_read_failed',
      { cause: err },
    );
  }
  if (raw === undefined || raw === null) return null;
  if (!isWellFormedHead(raw, id)) {
    console.warn('[chatConversation] запись нумерации не той формы — считаем, что её нет');
    return null;
  }
  return raw;
}

/** `true` — запись действительно зафиксирована. Никогда не бросает: неудачная
 *  запись не повод отказать человеку в отправке прямо сейчас — но и не повод
 *  промолчать (тот же принцип, что `writeRecord` в `chatSession.ts`). */
async function writeHeadRecord(id: string, record: StoredHead): Promise<boolean> {
  if (!idbFactory()) {
    console.warn(
      '[chatConversation] хранилища IndexedDB нет — нумерация разговора живёт только в памяти вкладки; ' +
      'вторая вкладка и перезагрузка начнут её заново',
    );
    return false;
  }
  try {
    await idbPut(id, record);
    return true;
  } catch (err) {
    console.warn(
      '[chatConversation] не удалось сохранить нумерацию разговора на устройстве (квота/приватный режим): ' +
      'сообщение уйдёт, но номер может повториться после перезагрузки',
      err,
    );
    return false;
  }
}

/** Голова этого разговора, как она лежит на устройстве. `null` — своих
 *  сообщений в нём ещё не было (или запись не той формы). */
export async function readConversationHead(
  own: `0x${string}`, peer: `0x${string}`,
): Promise<ConversationHead | null> {
  const id = conversationId(assertAddress(own, 'свой адрес'), assertAddress(peer, 'адрес собеседника'));
  const rec = await readHeadRecord(id);
  return rec ? { link: rec.link, key: rec.key } : null;
}

/**
 * Номера, которые мы зарезервировали и не смогли подтвердить отправкой.
 *
 * Задумано ради одного различия: у СОБЕСЕДНИКА дыра в нашей нумерации
 * неотличима от утаивания, а у НАС — отличима (см. шапку файла).
 *
 * ⚠️ ЧЕСТНО О ТОМ, ЧТО ИЗ ЭТОГО СБЫЛОСЬ (финальная проверка ветки). Здесь было
 * написано «интерфейс ОБЯЗАН сказать: эти сообщения не ушли». Замер:
 * вызывающих у этой функции вне тестов — НОЛЬ. Значит на вопрос «перезапустили
 * посреди отправки» честный ответ сегодня такой: номер сгорает, собеседник
 * видит дыру, а человеку не говорят НИЧЕГО.
 *
 * Различие, ради которого функция написана, существует и доступно — но пока
 * только тому, кто её позовёт. Довести до панели — работа слоя интерфейса, и
 * она названа отдельным пунктом исполнителю хуков; до тех пор эта строка
 * описывает возможность, а не поведение.
 */
export async function listBurnedSeqs(own: `0x${string}`, peer: `0x${string}`): Promise<number[]> {
  const id = conversationId(assertAddress(own, 'свой адрес'), assertAddress(peer, 'адрес собеседника'));
  const rec = await readHeadRecord(id);
  return rec ? [...rec.burned] : [];
}

/** Снимает нумерацию разговора. Следующая отправка начнёт с нуля — то есть у
 *  собеседника появится ВТОРОЕ звено с номером 0 (вердикт `unordered`). Явное
 *  действие с явной ценой, не служебная уборка. */
export async function forgetConversationHead(own: `0x${string}`, peer: `0x${string}`): Promise<void> {
  const id = conversationId(assertAddress(own, 'свой адрес'), assertAddress(peer, 'адрес собеседника'));
  // Память вкладки чистится ТОЖЕ и ПЕРВОЙ. Забыть только диск значило бы, что
  // «забыто» — неправда: запасная голова пережила бы снятие и продолжила
  // нумерацию с прежнего места, а функция при этом отчиталась бы об успехе.
  _memoryHeads.delete(id);
  if (!idbFactory()) return;
  await idbDelete(id);
}

/** Голова в памяти вкладки — запасной путь на случай, когда хранилища нет
 *  вовсе ИЛИ запись в него не проходит (квота, приватный режим). Ровно то, что
 *  обещает предупреждение выше: одна вкладка, до перезагрузки. Диск всегда
 *  побеждает: сюда заглядывают, только если он ничего не дал. */
const _memoryHeads = new Map<string, StoredHead>();

/** Только для тестов: забыть запасные головы между кейсами. Тот же приём и та
 *  же причина, что `_resetBagPassCacheForTest` в `chatTransport.ts` — состояние
 *  уровня модуля переживает подмену хранилища и протекает в соседний тест. */
export function _resetConversationMemoryForTest(): void {
  _memoryHeads.clear();
}

/* ────────────────────────── замок между вкладками ─────────────────────── */

/** Тот же приём и по той же причине, что `withCrossTabLock` в
 *  `chatSession.ts`: Web Locks, где есть; мягкая деградация, где нет; потолок
 *  ожидания обязателен, иначе брошенный держатель заклинит переписку до
 *  перезагрузки страницы. */
async function withCrossTabLock<T>(name: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: Navigator }).navigator?.locks;
  if (!locks) return fn();

  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;

  const acquired = new Promise<void>(resolve => {
    locks.request(name, () => { resolve(); return held; }).catch(() => { resolve(); });
  });

  try {
    await Promise.race([
      acquired,
      new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    return await fn();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    release?.();
  }
}

/* ──────────────────────────────── отправка ────────────────────────────── */

export interface SendMessageOptions {
  /** Пропуск склада (`chatTransport.requestBagPass`). Подаётся снаружи
   *  НАМЕРЕННО: умей отправка сходить за ним сама — она умела бы открывать
   *  окно кошелька, а по замыслу не должна уметь этого вовсе. */
  pass: string;
  /** Часы. Существует ради тестов и ради того, чтобы `sentAt` был одним
   *  числом на всё звено, а не двумя разными вызовами `Date.now()`. */
  now?: () => number;
  /** Потолок ожидания межвкладочного замка; умолчание —
   *  `CONVERSATION_LOCK_TIMEOUT_MS`. */
  lockTimeoutMs?: number;
}

export interface SentMessage {
  link: ChainLink;
  signature: Uint8Array;
  signerPublicKey: Uint8Array;
  /** Байты, реально ушедшие на склад. Слой выше хранит их своей копией
   *  переписки — предъявлять арбитру (план 4) придётся именно их. */
  frame: Uint8Array;
  /** Ключ мешка на складе — по нему сверяется галочка «дошло» (`sent[]` из
   *  `listBags`). */
  key: string;
  payload: ChatPayload;
  /** Кому отправлено, приведённым адресом. Без этого поля `receiveBags` не
   *  могла бы отсеять из `own` чужой разговор, и переписка с одним человеком
   *  показывала бы сообщения, написанные другому. */
  peer: `0x${string}`;
  /** `false` — нумерация не легла на устройство (квоты нет, приватный режим,
   *  хранилища нет). Сообщение ушло, но номер может повториться после
   *  перезагрузки. Флаг существует, чтобы вызывающий мог об этом сказать. */
  persisted: boolean;
}

/**
 * Коды отказа склада, после которых ТОЧНО известно, что мешок не лёг: все эти
 * ветки `relayer/app.js` либо не доходят до записи, либо удаляют файл
 * (`unlinkQuietSync`). Только на них резерв номера откатывается.
 *
 * 5xx и любой сетевой обрыв сюда НЕ входят намеренно: за 5xx может стоять
 * прокси, а за обрывом — успешно доехавший запрос, чей ответ потерялся.
 * Переиспользовать номер в таком случае значит выдать собеседнику два звена с
 * одним номером — вердикт `unordered`, обвинение в ПОДДЕЛКЕ. Дыра (`gap`,
 * обвинение в утаивании) — меньшее зло, см. шапку файла.
 */
export const NOT_STORED_STATUSES: readonly number[] = [400, 401, 403, 413, 429];

/**
 * МАШИННЫЕ КОДЫ склада, каждый из которых — точное утверждение сервера «этот
 * мешок не сохранён». Смотреть на них НАДО РАНЬШЕ статуса.
 *
 * Найдено при проверке хуков, настоящий дефект: у склада кончается место, он
 * ТОЧНО это знает — удаляет недописанный файл и отвечает `write_failed`
 * (`relayer/app.js`, `ws.on('error')`), — но статус при этом `500`, а `500` в
 * списке статусов нет и быть не должно (при обычной пятисотке мешок мог и
 * лечь). Итог был: номер сгорал, у собеседника оставалась дыра, а дыру
 * отличить от намеренного утаивания нечем (`docs/OPEN-ITEMS.md`, пункт 34) —
 * человек получал тяжёлое обвинение за чужой кончившийся диск.
 *
 * ⚠️ `internal_error` сюда НЕ входит, хотя сегодня все три ветки `PUT /bags`,
 * отвечающие им, тоже удаляют файл. Причина: это КАТЧ-ОЛЛ — тем же кодом
 * отвечают `GET /bags` и `GET /keys`. Читать общий код как точное обещание
 * про ЭТОТ мешок значит вешать гарантию на имя, которое её не давало: первая
 * же будущая ветка, которая успеет сохранить и упасть после, вернула бы нам
 * переиспользованный номер, то есть `unordered` — обвинение в ПОДДЕЛКЕ, а оно
 * тяжелее дыры. Цена решения — лишняя дыра в редком случае; чтобы её убрать,
 * этой ветке склада нужен свой код, как у `write_failed`.
 */
export const NOT_STORED_CODES: readonly string[] = [
  'write_failed',        // ENOSPC на записи: файл удалён
  'empty_bag',           // ноль байт: файл удалён
  'invalid_recipient',   // адрес не адрес: до записи не дошло
  'payload_too_large',   // сверх MAX_BAG_SIZE: файл удалён
];

const DEFINITELY_NOT_STORED = new Set(NOT_STORED_STATUSES);
const DEFINITELY_NOT_STORED_CODES = new Set(NOT_STORED_CODES);

/**
 * Отправляет сообщение: конверт → звено → подпись → мешок на склад.
 *
 * Кошелёк не участвует НИ РАЗУ. Звено подписывается ключом сеанса
 * (`deriveLinkSigningKeypair`), пропуск склада приходит готовым.
 *
 * `prevLink` — НИЖНЯЯ граница нумерации, а не источник истины: истина лежит на
 * устройстве и перечитывается под межвкладочным замком (см. шапку файла).
 * `null` допустим — это либо первое сообщение, либо «вызывающий не помнит».
 */
export async function sendMessage(
  session: ChatSession,
  peer: `0x${string}`,
  peerPub: Uint8Array,
  payload: ChatPayload,
  prevLink: ChainLink | null,
  opts: SendMessageOptions,
): Promise<SentMessage> {
  const own = assertAddress(session?.address, 'свой адрес');
  const peerAddr = assertAddress(peer, 'адрес собеседника');
  if (!(peerPub instanceof Uint8Array) || peerPub.length !== CHAT_KEY_LEN) {
    throw new ChatConversationError(
      `chatConversation: открытый ключ собеседника должен быть ${CHAT_KEY_LEN} байт`,
      'peer_key_malformed',
    );
  }

  const signer = await deriveLinkSigningKeypair(session.keypair);

  // Конверт собирается ДО замка и ДО резерва номера. Порядок несущий:
  // сообщение, которое не влезает в конверт, обязано отказать, НЕ СЖИГАЯ
  // номер — иначе слишком длинный текст дырявил бы собственную нумерацию, и
  // собеседник видел бы утаивание там, где человеку просто не дали отправить.
  let envelope: Uint8Array;
  try {
    // Четвёртым аргументом — АВТОР (В-1 враждебной проверки). Он входит в
    // аутентифицируемые данные конверта, поэтому переложить этот конверт в
    // чужой кадр нельзя: у другого автора тег не сойдётся. Отдельной сверки
    // «автор тот?» нигде нет и быть не должно — забыть её было бы негде,
    // потому что это не проверка, а невозможность.
    envelope = await packEnvelope(payload, peerPub, session.keypair.publicKey, own);
  } catch (err) {
    throw new ChatConversationError(
      'Сообщение слишком длинное — склад такое не примет. Сократите текст или отправьте вложением.',
      'message_too_large',
      { cause: err },
    );
  }

  const bodyHash = messageBodyHash(signer.publicKey, envelope);
  const now = opts.now ?? Date.now;
  const id = conversationId(own, peerAddr);
  const lockTimeoutMs = opts.lockTimeoutMs ?? CONVERSATION_LOCK_TIMEOUT_MS;

  return withCrossTabLock(`hexseal-chat-conv-${own}-${peerAddr}`, lockTimeoutMs, async () => {
    // ПЕРЕЧИТАТЬ под замком — единственное, ради чего замок здесь берётся.
    // Без этой строки вторая вкладка, дождавшись очереди, спокойно выдаст тот
    // же номер: замок будет взят и ничего не запрёт.
    //
    // Диск — источник истины; память вкладки подхватывает случай, когда запись
    // на диск НЕ ПРОХОДИТ (квота кончилась, приватный режим). Раньше память
    // ЗАПИСЫВАЛАСЬ при неудачной записи, но ЧИТАЛАСЬ только когда хранилища
    // нет ВОВСЕ — и при кончившейся квоте каждое сообщение получало номер 0
    // заново, а у собеседника это вердикт `unordered`, то есть обвинение в
    // ПОДДЕЛКЕ за кончившееся место. Собственная починка была хуже дефекта,
    // который чинила.
    const stored = (idbFactory() ? await readHeadRecord(id) : null) ?? _memoryHeads.get(id) ?? null;

    // `prevLink` побеждает только если он СТРОГО впереди записи — то есть
    // диск отстал (его почистили, а вкладка помнит). При равенстве и отставании
    // истина за диском.
    let prev: ChainLink | null = stored?.link ?? null;
    if (prevLink && (!prev || prevLink.seq > prev.seq)) prev = prevLink;

    const link = buildLink(prev, bodyHash, own, now());
    if (link.seq > MAX_LINK_SEQ) {
      throw new ChatConversationError(
        `chatConversation: номер ${link.seq} не влезает в кадр`,
        'seq_overflow',
      );
    }

    const sodium = (await import('libsodium-wrappers')).default;
    await sodium.ready;
    const signature = sodium.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey);
    const frame = encodeFrame({ link, signature, signerPublicKey: signer.publicKey, envelope });

    // РЕЗЕРВ. Ложится на диск ДО похода на склад: закрытая посреди вкладка
    // должна оставить дыру, а не второй номер (разбор — в шапке файла).
    const burned = stored ? [...stored.burned] : [];
    const reserved: StoredHead = { v: HEAD_RECORD_VERSION, id, link, key: null, burned };
    let persisted = await writeHeadRecord(id, reserved);
    if (!persisted) _memoryHeads.set(id, reserved);

    let key: string;
    try {
      ({ key } = await putBag(opts.pass, peerAddr, frame));
    } catch (err) {
      const status = err instanceof BagTransportError ? err.status : undefined;
      const code = err instanceof BagTransportError ? err.code : undefined;
      // КОД РАНЬШЕ СТАТУСА: код — точное утверждение сервера про ЭТОТ мешок,
      // статус — догадка по классу ответа. Там, где сервер знает наверняка, мы
      // обязаны верить ему, а не гадать (см. `NOT_STORED_CODES`).
      const notStored =
        (code !== undefined && DEFINITELY_NOT_STORED_CODES.has(code)) ||
        (status !== undefined && DEFINITELY_NOT_STORED.has(status));
      if (notStored) {
        // Мешок ТОЧНО не лёг — возвращаем номер, дыры быть не должно.
        const rolledBack: StoredHead | null = stored ?? null;
        if (rolledBack) {
          if (persisted) await writeHeadRecord(id, rolledBack); else _memoryHeads.set(id, rolledBack);
        } else {
          if (persisted) { try { await idbDelete(id); } catch { /* уборка не важнее самого отказа */ } }
          _memoryHeads.delete(id);
        }
      } else {
        // Судьба мешка неизвестна — номер сгорает и записывается НАШЕЙ бедой.
        const withBurn: StoredHead = {
          ...reserved,
          burned: [...burned, link.seq].slice(-MAX_BURNED_SEQS),
        };
        if (persisted) await writeHeadRecord(id, withBurn); else _memoryHeads.set(id, withBurn);
      }
      throw new ChatConversationError(
        'Сообщение не удалось положить на склад',
        'send_failed',
        { cause: err, status },
      );
    }

    // `persisted` остаётся ответом про РЕЗЕРВ (на нём стоит нумерация), а не
    // про эту подтверждающую запись: если резерв лёг, номер в безопасности
    // даже когда подтверждение не долетело — теряется только `key`, то есть
    // галочка «дошло», а не порядок сообщений.
    const confirmed: StoredHead = { ...reserved, key };
    if (persisted) await writeHeadRecord(id, confirmed); else _memoryHeads.set(id, confirmed);

    return { link, signature, signerPublicKey: signer.publicKey, frame, key, payload, peer: peerAddr, persisted };
  });
}

/* ──────────────────────────────── приём ───────────────────────────────── */

/** Мешок в том виде, в каком его отдаёт склад: `sender` засвидетельствован
 *  СЕРВЕРОМ (он взял его из пропуска, а не из тела), `body` — сырые байты. */
export interface IncomingBag {
  key: string;
  sender: `0x${string}`;
  uploadedAt: number;
  body: Uint8Array;
}

export interface ChatMessage {
  seq: number;
  from: `0x${string}`;
  sentAt: number;
  payload: ChatPayload;
  /** «Дошло до устройства» — не «прочитано глазами» (§3.3 спеки плана). Для
   *  ЧУЖИХ сообщений всегда `true`: они уже у нас. Для СВОИХ — по ответу
   *  склада (`deliveredKeys`). */
  delivered: boolean;
  /**
   * Всё, чем это сообщение доказывается третьему лицу: звено, подпись,
   * подписной ключ и байты кадра, как они лежали на складе.
   *
   * Есть у ОБЕИХ половин разговора — и у своих отправленных, и у принятых
   * (находка В-4 враждебной проверки: раньше доказательства были только у
   * своих, а «копия контрагента», на которой стоит §5 общей спеки и весь план
   * 4, этим наружным видом не собиралась вовсе).
   *
   * Необязательное — потому что сообщение может прийти путём, где кадра нет
   * (сегодня такого пути нет; поле необязательно, чтобы будущий такой путь не
   * пришлось выдавать за доказанный).
   */
  proof?: MessageProof;
}

/** Самодостаточное доказательство одного сообщения: по нему подпись
 *  проверяется заново, ничего не спрашивая у отправителя. */
export interface MessageProof {
  link: ChainLink;
  signature: Uint8Array;
  signerPublicKey: Uint8Array;
  /** Байты мешка целиком, как они лежали на складе. */
  frame: Uint8Array;
}

export type ConversationTrouble =
  /** Мешок не разбирается в кадр вовсе (или сам мешок не той формы). */
  | { kind: 'malformed'; key: string }
  /** Звено называет одного отправителя, а склад засвидетельствовал другого. */
  | { kind: 'sender_mismatch'; key: string; claimed: `0x${string}`; attested: `0x${string}` }
  /** Отпечаток тела не сходится с содержимым кадра: тронут конверт или
   *  подписной ключ. */
  | { kind: 'body_mismatch'; key: string; seq: number; from: `0x${string}` }
  /** Подпись не сходится: тронуто что-то внутри самого звена. */
  | { kind: 'bad_signature'; key: string; seq: number; from: `0x${string}` }
  /** Подписной ключ не тот, который назвали снаружи (пин из справочника). */
  | { kind: 'signer_unexpected'; key: string; seq: number; from: `0x${string}` }
  /** Подписной ключ сменился посреди переписки одного отправителя. */
  | { kind: 'signer_changed'; key: string; seq: number; from: `0x${string}` }
  /** Два звена с одним номером от одного отправителя. */
  | { kind: 'duplicate_seq'; key: string; seq: number; from: `0x${string}` }
  /**
   * То же самое, но номер повторили МЫ САМИ (К-5).
   *
   * Отдельный род, а не `duplicate_seq`, потому что читается он совершенно
   * иначе. У собеседника повтор номера — признак подделки: кто-то предъявил
   * два разных звена под одним номером. У себя это своя же беда и с известной
   * причиной: вкладка потеряла голову разговора (браузер очистил хранилище,
   * приватный режим) и начала счёт заново. Обвинять тут некого.
   *
   * ⚠️ «Показать человеку надо» — это ЗАМЫСЕЛ, а не поведение (финальная
   * проверка ветки). Замер: панель об этом молчит, и молчание заперто тестом.
   * То есть собеседник увидит эти сообщения как непроверенные, а мы не узнаем
   * даже того, что у нас сбилась нумерация. Род различается и доступен
   * потребителю — довести его до экрана работа слоя интерфейса, названная
   * отдельным пунктом исполнителю хуков.
   */
  | { kind: 'own_numbering_reset'; key: string; seq: number; from: `0x${string}` }
  /** Звено честное, а конверт нашей парой не вскрывается: собеседник
   *  запечатал на устаревший ключ. НЕ разрыв — звено остаётся в цепочке. */
  | { kind: 'undecryptable'; key: string; seq: number; from: `0x${string}` };

/** Разрыв С УКАЗАНИЕМ АВТОРА. `afterSeq: -1` — не предъявлено начало
 *  переписки этого отправителя. */
export interface ConversationGap {
  from: `0x${string}`;
  afterSeq: number;
}

export interface ConversationState {
  messages: ChatMessage[];
  /** Разрывы с автором — ЕДИНСТВЕННОЕ, по чему можно кого-то в чём-то
   *  заподозрить. Отсортированы по автору, затем по номеру. */
  gaps: ConversationGap[];
  /** То же самое, но ПЛОСКО и БЕЗ автора — только для потребителя, который уже
   *  ограничил разбор одним собеседником (`opts.peer`).
   *
   *  ⚠️ НЕ ДЛЯ ОБВИНЕНИЯ, когда собеседник не задан (В-3 враждебной проверки):
   *  ящик общий, посторонний становится в нём виден, просто положив мешок, и
   *  его дыра в этом списке неотличима от дыры собеседника. Для чего угодно,
   *  кроме «показать значок разрыва в открытой переписке», берите `gaps`. */
  gapAfterSeq: number[];
  /** Вердикт цепочки НА КАЖДОГО отправителя отдельно: мешок постороннего не
   *  должен портить вердикт собеседнику. */
  chains: Record<string, ChainVerdict>;
  troubles: ConversationTrouble[];
}

export interface ReceiveBagsOptions {
  /** Разбирать только этого собеседника; остальные мешки не трогать вовсе. */
  peer?: `0x${string}`;
  /** Пин подписного ключа по адресу (когда справочник научится его отдавать —
   *  план 6). Без пина проверка подписи ловит подмену ОДНОГО звена и смену
   *  ключа, но не переписанную целиком цепочку (см. шапку файла). */
  peerSigningPublicKeys?: Record<string, Uint8Array | readonly Uint8Array[]>;
  /** Свои отправленные — чтобы разговор был разговором, а не половиной. Можно
   *  подавать вперемешку по всем собеседникам: при заданном `peer` лишние
   *  отсеиваются по полю `SentMessage.peer`. */
  own?: SentMessage[];
  /** Ключи мешков, которые склад отдал забранными (`sent[].fetched`). Всё, чего
   *  тут нет, считается недошедшим: «неизвестно» и «дошло» смешивать нельзя. */
  deliveredKeys?: string[];
}

/** Мешок в том виде, который вообще имеет смысл разбирать. */
function isIncomingBag(x: unknown): x is IncomingBag {
  if (!x || typeof x !== 'object') return false;
  const b = x as Record<string, unknown>;
  return (
    typeof b.key === 'string' &&
    typeof b.sender === 'string' && ADDRESS_RE.test(b.sender.toLowerCase()) &&
    typeof b.uploadedAt === 'number' && Number.isFinite(b.uploadedAt) &&
    b.body instanceof Uint8Array
  );
}

interface AcceptedLink {
  key: string;
  link: ChainLink;
  envelope: Uint8Array;
  signerPublicKey: Uint8Array;
  /** Подпись и байты кадра переносятся ЦЕЛИКОМ, а не пересобираются: то, что
   *  предъявляется третьему лицу, обязано быть тем же самым, что пришло со
   *  склада, а не нашей копией с точностью до нашего же кодирования (В-4). */
  signature: Uint8Array;
  frame: Uint8Array;
  uploadedAt: number;
}

/**
 * Слияние сторон разговора в один показанный порядок.
 *
 * ⚠️ НЕ `Array.prototype.sort` со сравнением «свои по номеру, чужие по
 * времени» — оно НЕТРАНЗИТИВНО (находка К-2 враждебной проверки, замер: 126
 * перестановок из 200 давали номера ОДНОЙ СТОРОНЫ вспять). Достаточно, чтобы
 * время спорило с номером — а время ставит сам отправитель, оно приходит из
 * сети и врать может как угодно. Нетранзитивное сравнение делает результат
 * `sort` зависящим от порядка ПРИХОДА, то есть от того, в каком порядке склад
 * отдал мешки; переставлялась при этом та самая расшифровка, которую увидит
 * арбитр.
 *
 * Здесь — обычное слияние отсортированных списков: каждая сторона уже идёт
 * строго по своему номеру, и берётся всегда голова той стороны, чьё время
 * отправки меньше (при равенстве — по адресу). Порядок ВНУТРИ стороны не может
 * быть нарушен ни при каком времени: список стороны просматривается только с
 * головы. Время отправки остаётся ПОДСКАЗКОЙ о том, как перемежать стороны, а
 * не основанием порядка.
 */
function mergeSides(messages: ChatMessage[]): ChatMessage[] {
  const sides = new Map<string, ChatMessage[]>();
  for (const m of messages) {
    const list = sides.get(m.from) ?? [];
    list.push(m);
    sides.set(m.from, list);
  }
  // Внутри стороны — строго по номеру. Это единственная сортировка, и она
  // сравнивает ОДНОРОДНЫЕ величины (номера одного отправителя), поэтому
  // транзитивна по построению.
  const queues = [...sides.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : 1))
    .map(([, list]) => list.sort((a, b) => a.seq - b.seq));

  const at = queues.map(() => 0);
  const out: ChatMessage[] = [];
  for (let taken = 0; taken < messages.length; taken++) {
    let best = -1;
    for (let i = 0; i < queues.length; i++) {
      if (at[i] >= queues[i].length) continue;
      if (best === -1) { best = i; continue; }
      const cand = queues[i][at[i]];
      const cur = queues[best][at[best]];
      if (cand.sentAt < cur.sentAt || (cand.sentAt === cur.sentAt && cand.from < cur.from)) best = i;
    }
    if (best === -1) break; // недостижимо: taken < messages.length ⇒ очередь есть
    out.push(queues[best][at[best]++]);
  }
  return out;
}

/* ───────────────── К-2: повторный разбор того же мешка ────────────────── */
//
// ⚠️ К-2: ПОВТОРНЫЙ РАЗБОР. `receiveBags` вызывается на КАЖДОМ тике опроса и
// разбирает ВЕСЬ накопленный набор — цепочка проверяется целиком, вердикт по
// половине переписки не вердикт. Замер: 1000 мешков — 503 мс, каждые пять
// секунд, пока чат открыт; на среднем телефоне это половина ядра в основном
// потоке. Дорогого в мешке ровно два места: проверка подписи звена и
// расшифровка конверта — оба зависят ТОЛЬКО от байтов мешка (и второе ещё от
// нашей пары ключей).
//
// ОПОРА КЭША — ТОЖДЕСТВО ОБЪЕКТА ТЕЛА, а не ключ мешка. Ключ выдаёт СЕРВЕР, и
// верить ему как отпечатку нельзя: под тем же ключом могут приехать другие
// байты. Движок держит скачанные мешки в карте и подаёт те же объекты каждый
// тик, поэтому попадание — обычный случай, а не удача, и стоит оно одно
// сравнение ссылок.
//
// ⚠️ ЧЕСТНО О ТОМ, ЧТО ЭТА ОПОРА ДАЁТ, А ЧЕГО НЕТ (финальная проверка ветки).
// Здесь было написано «тождество означает буквально „это тот самый массив,
// который мы уже проверили“ — сильнее любого отпечатка». Это НЕПРАВДА, и вот
// замер:
//
//     тот же объект, испорченный НА МЕСТЕ → подделка ПРИНЯТА из кэша
//
// Отпечаток такое поймал бы, тождество — нет: ссылка та же, содержимое другое.
// Тождество сильнее ключа (ключ не связан с байтами вовсе) и СЛАБЕЕ отпечатка,
// а не сильнее.
//
// На чём всё держится на самом деле: на инварианте «тело мешка неизменяемо
// после скачивания». Сегодня он соблюдается — байты мешка не правит никто, —
// но НИГДЕ НЕ ЗАПИСАН требованием и ничем не сторожится. Тот, кто однажды
// решит поправить тело на месте (дешёвая «нормализация», подмена в отладке),
// сломает проверку подписи, не тронув ни строки в этом файле. Если инвариант
// станет неудобно держать — опору надо менять на отпечаток тела, а не
// уговаривать себя, что тождество и есть отпечаток.
//
// Цена ошибки, если опору ослабить до ключа: подделанный мешок прошёл бы по
// вердикту предыдущего. Заперто отдельно (`chatParseCache.test.ts`).

/** Потолок записей. Кэш живёт на модуле, то есть на вкладку; без потолка
 *  длинная переписка держала бы в памяти всё, что когда-либо разбиралось. */
const PARSE_CACHE_MAX = 5_000;

function cachePut<V>(cache: Map<string, V>, key: string, value: V): V {
  if (cache.size >= PARSE_CACHE_MAX) {
    // Map хранит порядок вставки — выбывает самое старое.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
  return value;
}

const _signatureCache = new Map<string, { body: Uint8Array; ok: boolean }>();
const _payloadCache = new Map<string, { body: Uint8Array; ownPub: Uint8Array; payload: ChatPayload | null }>();

/** Только тесты: разбор обязан быть проверяем с холодного кэша. */
export function _resetParseCacheForTest(): void {
  _signatureCache.clear();
  _payloadCache.clear();
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Разбирает мешки: вскрывает, проверяет подписи и цепочки, восстанавливает
 * порядок и называет разрывы.
 *
 * Порядок проверок внутри одного мешка ФИКСИРОВАН и значим — он решает, какой
 * именно вердикт получит человек:
 *   форма мешка → форма кадра → свидетельство сервера против поля звена →
 *   отпечаток тела → подпись → подписной ключ (пин/постоянство) → двойной
 *   номер → цепочка → расшифровка.
 * Расшифровка ПОСЛЕДНЯЯ намеренно: она самое дорогое, что здесь есть, и
 * присланный нарочно мусор не должен её оплачивать (вопрос «долбят нарочно»).
 *
 * @throws {TypeError} если `bags` не массив — НАШ мусор на входе. Тихий пустой
 *   разговор здесь означал бы «переписка исчезла» на глазах у человека.
 */
export async function receiveBags(
  session: ChatSession,
  bags: IncomingBag[],
  opts: ReceiveBagsOptions = {},
): Promise<ConversationState> {
  if (!Array.isArray(bags)) {
    throw new TypeError('receiveBags: bags должен быть массивом (не null/объект/иное)');
  }
  const troubles: ConversationTrouble[] = [];
  const onlyPeer = opts.peer ? assertAddress(opts.peer, 'адрес собеседника') : null;
  const ownAddress = assertAddress(session.address, 'свой адрес');

  /**
   * Получатель мешка — из его КЛЮЧА (`<получатель>/<файл>.bin`, см.
   * `relayer/bagStore.js` `bagKeyFor`). Нужен ровно для одного: отобрать СВОИ
   * отправленные, относящиеся к ЭТОЙ переписке.
   *
   * Почему из ключа, а не из содержимого: содержимое ещё не прочитано, а имя
   * получателя присвоил СЕРВЕР при записи (`PUT /bags/:recipient`) — это то
   * же свидетельство, что и `sender`, только с другой стороны. `null` —
   * ключ не той формы; такой мешок в свою половину не попадёт.
   */
  const recipientOfKey = (key: string): `0x${string}` | null => {
    const slash = key.indexOf('/');
    if (slash <= 0) return null;
    const addr = key.slice(0, slash).toLowerCase();
    return ADDRESS_RE.test(addr) ? (addr as `0x${string}`) : null;
  };

  /** Ключи своих мешков, про которые ЭТА вкладка помнит, что они ушли
   *  выбранному собеседнику. Второй источник привязки, см. ниже. */
  const ownKeysForPeer = new Set<string>(
    onlyPeer
      ? (opts.own ?? []).filter(s2 => s2.peer?.toLowerCase() === onlyPeer).map(s2 => s2.key)
      : [],
  );

  // ─── шаг 1: кадр, свидетельство сервера, отпечаток тела, подпись ───
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;

  // Ключ — приведённый адрес отправителя, ЗАСВИДЕТЕЛЬСТВОВАННЫЙ СЕРВЕРОМ (тип
  // сохраняется, а не сплющивается в `string`: ниже он уезжает и в `troubles`,
  // и в `messages[].from`, где форма адреса — часть контракта).
  const bySender = new Map<`0x${string}`, AcceptedLink[]>();
  // От кого мешки ВООБЩЕ приходили — отдельно от того, у кого хоть что-то
  // прошло проверки (В-2). Отсутствие записи в карте вердиктов читается как
  // «претензий нет», и именно в самом тяжёлом случае — когда отвергнуто ВСЁ —
  // потребитель не увидел бы ничего. Номера отвергнутых звеньев нужны, чтобы
  // вердикт «не в порядке» мог указать МЕСТО, а не только факт.
  const rejectedSeqs = new Map<`0x${string}`, number[]>();
  const noteRejected = (from: `0x${string}`, seq: number): void => {
    const list = rejectedSeqs.get(from) ?? [];
    list.push(seq);
    rejectedSeqs.set(from, list);
  };

  for (let i = 0; i < bags.length; i++) {
    const bag = bags[i];
    if (!isIncomingBag(bag)) {
      troubles.push({ kind: 'malformed', key: typeof (bag as { key?: unknown })?.key === 'string' ? (bag as IncomingBag).key : `#${i}` });
      continue;
    }
    const attested = bag.sender.toLowerCase() as `0x${string}`;
    // К-1: свой отправленный мешок — вторая половина ЭТОЙ ЖЕ переписки, а не
    // чужой шум. Склад теперь отдаёт его владельцу пропуска (мешок один,
    // копий не появилось), и без этой ветки собственные сообщения пропадали
    // при любой перезагрузке вкладки: в памяти их нет, а с диска мы их
    // выбрасывали здесь же, первой строкой разбора.
    //
    // Отбор по ПОЛУЧАТЕЛЮ, не по отправителю: отправитель у всех своих
    // мешков один и тот же (мы сами), и сравнение с `onlyPeer` не отсеивало
    // бы ничего — переписка с Бобом показывала бы написанное Кэрол.
    const isOwnOutgoing = attested === ownAddress;
    if (onlyPeer) {
      // У своего мешка ДВА независимых источника «кому это было»:
      //  1. наша собственная память об отправке (`opts.own` — там записан
      //     собеседник) — она главная, пока вкладка жива;
      //  2. получатель из ключа мешка, который присвоил сервер, — она
      //     единственная после перезагрузки, когда память пуста, и ради неё
      //     весь К-1 и делался.
      // Достаточно любого: совпали — мешок наш, этой переписки.
      const belongs = isOwnOutgoing
        ? (onlyPeer === ownAddress                    // переписка с самим собой
          || ownKeysForPeer.has(bag.key)              // помним, что слали ему
          || recipientOfKey(bag.key) === onlyPeer)    // сервер назвал получателя
        : attested === onlyPeer;
      if (!belongs) continue;
    }

    let frame: SignedLinkFrame | null;
    try {
      frame = decodeFrame(bag.body);
    } catch {
      // decodeFrame бросает только на НАШЕМ мусоре (не Uint8Array), а форму
      // `body` мы уже проверили выше — сюда попасть нечем. Ловим на случай
      // будущего расширения гейта: чужой мешок не должен ронять весь разбор.
      frame = null;
    }
    if (!frame) {
      troubles.push({ kind: 'malformed', key: bag.key });
      continue;
    }

    if (frame.link.sender !== attested) {
      troubles.push({ kind: 'sender_mismatch', key: bag.key, claimed: frame.link.sender, attested });
      noteRejected(attested, frame.link.seq);
      continue;
    }

    if (messageBodyHash(frame.signerPublicKey, frame.envelope).toLowerCase() !== frame.link.bodyHash.toLowerCase()) {
      troubles.push({ kind: 'body_mismatch', key: bag.key, seq: frame.link.seq, from: attested });
      noteRejected(attested, frame.link.seq);
      continue;
    }

    let signatureOk: boolean;
    const sigHit = _signatureCache.get(bag.key);
    if (sigHit && sigHit.body === bag.body) {
      // К-2: те же байты уже проверялись — самая дорогая половина разбора.
      signatureOk = sigHit.ok;
    } else try {
      signatureOk = cachePut(_signatureCache, bag.key, {
        body: bag.body,
        ok: sodium.crypto_sign_verify_detached(
          frame.signature, linkSignaturePreimage(frame.link), frame.signerPublicKey,
        ),
      }).ok;
    } catch {
      // libsodium бросает TypeError на негодной длине — форма уже проверена
      // разбором кадра, но чужие данные не повод падать целиком.
      signatureOk = false;
    }
    if (!signatureOk) {
      troubles.push({ kind: 'bad_signature', key: bag.key, seq: frame.link.seq, from: attested });
      noteRejected(attested, frame.link.seq);
      continue;
    }

    const list = bySender.get(attested) ?? [];
    list.push({
      key: bag.key, link: frame.link, envelope: frame.envelope,
      signerPublicKey: frame.signerPublicKey, signature: frame.signature,
      frame: bag.body, uploadedAt: bag.uploadedAt,
    });
    bySender.set(attested, list);
  }

  // ─── шаг 2: по каждому отправителю — ключ, дубли, цепочка, расшифровка ───
  const chains: Record<string, ChainVerdict> = {};
  const gaps: ConversationGap[] = [];
  const messages: ChatMessage[] = [];
  /** Номера разрывов СВОЕЙ цепочки — вычитаются из плоского `gapAfterSeq`. */
  const ownGapSeqs: number[] = [];
  /** Ключи мешков, уже превращённых в сообщения на шаге 2. Шаг 3 по ним
   *  отсеивает свои из памяти вкладки: один и тот же мешок теперь приезжает
   *  ДВУМЯ путями (память и склад), и без этого одно сообщение показалось бы
   *  дважды. */
  const shownKeys = new Set<string>();

  for (const [from, listRaw] of bySender) {
    // Порядок по номеру, при равенстве — по времени загрузки: разбор дублей и
    // пин ключа обязаны быть детерминированными, а не зависеть от того, в
    // каком порядке склад отдал список.
    const list = [...listRaw].sort((a, b) => a.link.seq - b.link.seq || a.uploadedAt - b.uploadedAt);

    // Пин — СПИСОК, а не один ключ (Б-2 финальной проверки): собеседник имеет
    // право сменить ключ, справочник хранит историю ровно ради этого, и
    // честная смена не должна читаться как подделка. Одиночный ключ по-прежнему
    // принимается — вызывающих, знающих ровно один ключ, ломать незачем.
    const pinnedRaw = opts.peerSigningPublicKeys?.[from];
    const pinned = pinnedRaw === undefined
      ? undefined
      : (Array.isArray(pinnedRaw) ? pinnedRaw : [pinnedRaw as Uint8Array]);
    // Без пина ключ прибивается к САМОМУ РАННЕМУ звену: смена ключа посреди
    // переписки становится видимой, а не молча принятой.
    const expected: readonly Uint8Array[] | undefined = pinned ?? (list[0] ? [list[0].signerPublicKey] : undefined);

    const accepted: AcceptedLink[] = [];
    let lastSeq: number | null = null;
    for (const item of list) {
      if (expected && !expected.some(k => sameBytes(item.signerPublicKey, k))) {
        troubles.push({
          kind: pinned ? 'signer_unexpected' : 'signer_changed',
          key: item.key, seq: item.link.seq, from,
        });
        noteRejected(from, item.link.seq);
        continue;
      }
      if (lastSeq !== null && item.link.seq === lastSeq) {
        // К-5: свой повтор — не подделка, а потерянная голова разговора.
        troubles.push({
          kind: from === ownAddress ? 'own_numbering_reset' : 'duplicate_seq',
          key: item.key, seq: item.link.seq, from,
        });
        noteRejected(from, item.link.seq);
        continue;
      }
      lastSeq = item.link.seq;
      accepted.push(item);
    }

    if (accepted.length === 0) continue;

    const verdict = verifyChain(accepted.map(a => a.link));
    chains[from] = verdict;
    if (!verdict.ok && verdict.reason === 'gap') {
      // Разрыв НАЗЫВАЕТ АВТОРА (В-3). Плоское объединение приписывало дыру
      // постороннего переписке с собеседником — а посторонний становится
      // виден в ящике, просто положив туда мешок.
      for (const n of verdict.missingAfterSeq) gaps.push({ from, afterSeq: n });
    }
    // К-1: дыра в СВОЕЙ цепочке (мешок истёк на складе, отправка оборвалась)
    // в плоский `gapAfterSeq` не идёт. Он читается интерфейсом как «здесь
    // собеседник чего-то не предъявил», и своя же пропажа выглядела бы
    // обвинением невиновного. В `gaps` она есть — с автором, то есть с нами.
    if (from === ownAddress) ownGapSeqs.push(...(
      !verdict.ok && verdict.reason === 'gap' ? verdict.missingAfterSeq : []
    ));

    for (const item of accepted) {
      // Автор — тот, кого ЗАСВИДЕТЕЛЬСТВОВАЛ СЕРВЕР (`from`), а не тот, кого
      // назвало содержимое: содержимое ещё не прочитано, и верить ему нечем.
      // Конверт, собранный другим автором, здесь просто не расшифруется (В-1).
      // К-2: расшифровка — вторая дорогая половина. Опора та же (тождество
      // тела), плюс наша открытая половина: содержимое зависит от пары
      // ключей, и кэш без неё отдал бы расшифрованное чужому сеансу.
      const decHit = _payloadCache.get(item.key);
      const payload = (decHit && decHit.body === item.frame && sameBytes(decHit.ownPub, session.keypair.publicKey))
        ? decHit.payload
        : cachePut(_payloadCache, item.key, {
          body: item.frame,
          ownPub: session.keypair.publicKey,
          payload: await unpackEnvelope(item.envelope, session.keypair, from),
        }).payload;
      if (!payload) {
        // Звено остаётся в цепочке — оно честное и подписанное. Не вскрылось у
        // НАС; выкинув его, мы превратили бы собственную неудачу в дыру, то
        // есть в обвинение собеседнику.
        troubles.push({ kind: 'undecryptable', key: item.key, seq: item.link.seq, from });
        continue;
      }
      messages.push({
        seq: item.link.seq, from, sentAt: item.link.sentAt, payload, delivered: true,
        proof: {
          link: item.link, signature: item.signature,
          signerPublicKey: item.signerPublicKey, frame: item.frame,
        },
      });
    }
  }

  // ─── шаг 3: свои сообщения ───
  if (opts.own && opts.own.length > 0) {
    const own = assertAddress(session.address, 'свой адрес');
    const delivered = new Set(opts.deliveredKeys ?? []);
    for (const s of opts.own) {
      // Отсев по СОБЕСЕДНИКУ, не по отправителю: отправитель у всех своих
      // сообщений один и тот же (мы сами), и сравнение с ним не отсеивало
      // ничего — переписка с Бобом показывала бы написанное Кэрол.
      if (onlyPeer && s.peer?.toLowerCase() !== onlyPeer) continue;
      const mine: ChatMessage = {
        seq: s.link.seq, from: own, sentAt: s.link.sentAt,
        payload: s.payload, delivered: delivered.has(s.key),
        proof: {
          link: s.link, signature: s.signature,
          signerPublicKey: s.signerPublicKey, frame: s.frame,
        },
      };
      // ⚠️ Своя половина переписки приезжает ДВАЖДЫ с тех пор, как задача 7
      // сделала её достижимой с сервера (поле отправителя в описи): мешком из
      // ящика и этим списком из памяти вкладки. Показать оба — значит удвоить
      // человеку его же сообщения, а заодно посчитать по удвоенному ряду
      // разрывы и вердикты.
      //
      // Побеждает ЭТОТ экземпляр, а не тот, что со склада: только здесь
      // известно `delivered` (склад про свои мешки отвечает отдельным списком,
      // а не признаком в мешке). Звено при этом уже прошло разбор наравне с
      // чужими и участвовало в проверке цепочки — то есть перекрёстная сверка
      // «что у сервера против того, что помню я» не теряется, теряется только
      // лишняя строка на экране.
      const already = messages.findIndex(m => m.from === own && m.seq === mine.seq);
      if (already === -1) messages.push(mine);
      else messages[already] = mine;
    }
  }

  // В-2: отправитель, от которого мешки БЫЛИ, но не прошло НИ ОДНО звено,
  // получает явный вердикт «не в порядке», а не отсутствие записи. Отсутствие
  // записи читается потребителем как «претензий нет» — ровно наоборот смыслу.
  // `broken`, а не `gap`: отвергнуть звено могли только проверки подлинности
  // (свидетельство сервера, отпечаток тела, подпись, подписной ключ), то есть
  // предъявленное не заслуживает доверия, а не «чего-то не показали».
  for (const [from, seqs] of rejectedSeqs) {
    if (chains[from] !== undefined) continue;
    chains[from] = { ok: false, reason: 'broken', atSeq: Math.min(...seqs) };
  }

  return {
    messages: mergeSides(messages),
    gaps: [...gaps].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.afterSeq - b.afterSeq)),
    // К-1: дыры СВОЕЙ цепочки сюда НЕ идут. Плоский список читается
    // интерфейсом как «здесь собеседник чего-то не предъявил» и рисуется
    // значком разрыва; с тех пор как своя половина тоже проверяется цепочкой,
    // собственная пропажа (мешок истёк на складе, отправка оборвалась на
    // сгоревшем номере) обвиняла бы невиновного. В `gaps` она есть — с
    // автором, то есть с нами.
    gapAfterSeq: [...new Set(
      gaps.filter(g => g.from !== ownAddress).map(g => g.afterSeq),
    )].sort((a, b) => a - b),
    chains,
    troubles,
  };
}
