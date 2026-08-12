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
import {
  verifyChatKeyAttestation,
  type AttestationVerdict,
  type ChatKeyAttestation,
} from './chatKeyAttestation';
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
 * Имена отказов. `peer_has_no_key` — исправление 6 договора 4в-1:
 * `SealedOneTimeKey.forPeer` обязателен по типу, а ключа второй стороны может не
 * быть вовсе.
 *
 * ⚠️ ТРИ ИМЕНИ ПРО ЗАВЕРЕНИЕ (пункт 49 открытых находок). До 4в-2 отказом
 * `no_session` отвечали ЧЕТЫРЕ разные беды, и три из них сеанса не касались:
 * заверение про другой адрес или другие ключи, ПРОСРОЧЕННОЕ заверение
 * (`ATTESTATION_MAX_AGE_MS` — год) и «проверить нечем» (счётный кошелёк,
 * ERC-1271 без клиента цепи). Человек посреди спора получал «нет сеанса чата»,
 * переподключал кошелёк, перезаводил сеанс — и получал то же самое, потому что
 * лечение было ДРУГИМ и ему его не назвали.
 */
export type BuildFailure =
  | 'arbiter_has_no_key' | 'peer_has_no_key' | 'nothing_selected' | 'too_large'
  | 'no_session'
  | 'attestation_missing' | 'attestation_expired' | 'attestation_unproven';

/**
 * Все имена отказа — значением, а не только типом.
 *
 * ⚠️ ЗАМОК ИСЧЕРПАЕМОСТИ. `Record<BuildFailure, true>` требует ВСЕ члены союза:
 * добавить имя в тип и забыть про него здесь нельзя — `npm run type-check`
 * краснеет. Задача 6 строит по этому объекту список ключей локали, поэтому
 * забытое имя видит компилятор, а не человек со сломанной кнопкой.
 */
export const BUILD_FAILURE_NAMES: Record<BuildFailure, true> = {
  arbiter_has_no_key: true,
  peer_has_no_key: true,
  nothing_selected: true,
  too_large: true,
  no_session: true,
  attestation_missing: true,
  attestation_expired: true,
  attestation_unproven: true,
};

/**
 * Отказ. РАЗМЕЧЕННЫЙ СОЮЗ, а не плоский интерфейс с необязательными полями
 * (доработка ревью — прежняя форма держалась присваиваемостью, а не тем, что
 * иначе не собралось бы: сужение по `reason === 'too_large'` над плоским типом
 * оставляло `fits` типом `number | undefined`, и обязательность приходилось
 * подавлять восклицательным знаком).
 *
 * ⚠️ ЭТО НЕ ФОРМАЛЬНОСТЬ. Ровно из плоской формы вырос случай, где выборка
 * варианта по литералу (`Extract<T, {reason:'too_large'}>` без кортежной
 * обёртки) давала пустой тип, а утверждение о пустом типе истинно ВСЕГДА —
 * тип-замок проходил не потому, что форма верна, а потому, что он ничего не
 * проверял. Союз с двумя явными членами такому не подвержен: `Extract` на нём
 * даёт ровно один настоящий член, а не пустое пересечение.
 *
 * `fits`/`estimatedBytes`/`limitBytes` — расширение договора (без числа
 * влезающих кадров отказ по потолку нельзя выполнить человеку, §15.7), но
 * ТОЛЬКО у `reason: 'too_large'` — остальные причины отказа этих чисел не
 * несут и не притворяются, что несут.
 *
 * ⚠️ `fits` — ЕДИНСТВЕННЫЙ источник этого числа на весь план (исправление 11):
 * `fittingMessageCount` (Задача 8) берёт его отсюда и не считает своей моделью
 * размера. Две модели разойдутся, и человек увидит «влезает 4» там, где склад
 * ответит 413 на четырёх.
 */
export type PresentationRefusal =
  | { ok: false; reason: 'too_large'; fits: number; estimatedBytes: number; limitBytes: number }
  | { ok: false; reason: Exclude<BuildFailure, 'too_large'> };

/**
 * ⚠️ ЗАМОК КОМПИЛЯТОРА (тот же приём, что `DECLARED_COUNTS_CARRY_NO_UNOPENED`
 * выше): доказывает, что `fits` под `reason: 'too_large'` — это `number`, а не
 * `number | undefined`. Если кто-нибудь снова сделает `fits` необязательным
 * (вернёт плоскую форму), присвоение `true` этому типу перестанет собираться —
 * `npm run type-check` отдаёт отказ. Живёт здесь, а не в тесте: `*.test.ts`
 * исключены из программы tsc (`tsconfig.json:34`), проверка формы там ничего
 * не поймает.
 */
type TooLargeRefusal = Extract<PresentationRefusal, { reason: 'too_large' }>;
export type PresentationRefusalFitsIsRequired =
  undefined extends TooLargeRefusal['fits'] ? never : true;
export const PRESENTATION_REFUSAL_FITS_IS_REQUIRED: PresentationRefusalFitsIsRequired = true;

export type NotPreparedReason =
  | 'not_in_archive' | 'not_in_conversation' | 'undecryptable' | 'seal_failed'
  | 'malformed' | 'body_mismatch' | 'bad_signature'
  | 'bad_key' | 'aad_mismatch' | 'bad_form';

declare const ARBITER_BOX_KEY_BYTES: unique symbol;
declare const PEER_BOX_KEY_BYTES: unique symbol;

/**
 * Клеймо на 32 байта печати АРБИТРА — фирменный (nominal) тип, тот же приём,
 * что `BoxKey`/`SignKey` в `arbiterChatKey.ts`. Structurally оба ключа входа —
 * одинаковые `Uint8Array` длиной 32, ничем не различимые: ревью переставило их
 * в двух местах вызова, компилятор смолчал (0 ошибок), и перестановку поймал
 * только прогон (1 красный из всей мутационной серии) — то есть сегодня это
 * держится поведением, а не формой. Рядом с этими двумя — третий 32-байтовый
 * ключ (`session.keypair.publicKey`), и следующая правка легко добавит
 * четвёртый. Клеймо переносит защиту с прогона на компилятор: перестановка
 * `arbiterBoxKey`/`peerBoxKey` в вызове `buildPresentation` перестаёт
 * собираться. */
export type ArbiterBoxKeyBytes = Uint8Array & { readonly [ARBITER_BOX_KEY_BYTES]: true };
/** Симметричное клеймо для ключа печати ВТОРОЙ СТОРОНЫ. См. `ArbiterBoxKeyBytes`. */
export type PeerBoxKeyBytes = Uint8Array & { readonly [PEER_BOX_KEY_BYTES]: true };

/** Единственная законная точка клеймения сырых байт ключом печати арбитра —
 *  для вызывающих, которые уже добыли байты не через `arbiterBoxKeyBytes()`
 *  ниже (тесты; локальный кэш байт по адресу). Рантайм ничего не проверяет —
 *  клеймо только для тип-чекера, сюда приходят СТРОГО со стороны, которая уже
 *  знает происхождение байт. */
export function toArbiterBoxKeyBytes(bytes: Uint8Array): ArbiterBoxKeyBytes {
  return bytes as ArbiterBoxKeyBytes;
}
/** Симметрично `toArbiterBoxKeyBytes` — для ключа второй стороны. */
export function toPeerBoxKeyBytes(bytes: Uint8Array): PeerBoxKeyBytes {
  return bytes as PeerBoxKeyBytes;
}

export interface BuildPresentationInput {
  dealId: `0x${string}`;
  presenter: `0x${string}`;
  /** ⚠️ ОБЯЗАТЕЛЬНОЕ (исправление 6 договора). Вторая сторона переписки: архив и
   *  голова лежат под ПАРОЙ адресов (`conversationId`, `chatConversation.ts:600-602`),
   *  и без второго свою же копию переписки нечем адресовать. Вывод «из заверения
   *  собеседника или из выбора» не закрывал случай «показываю только своё,
   *  заверения собеседника нет» вовсе — теперь дыры не существует, а не обходится. */
  peer: `0x${string}`;
  arbiterBoxKey: ArbiterBoxKeyBytes;
  peerBoxKey: PeerBoxKeyBytes;
  selected: { seq: number; sender: `0x${string}` }[];
  session: ChatSession;
  ownAttestation: ChatKeyAttestation;
  /**
   * Заверения ДРУГИХ пар ключей: нынешняя пара собеседника и ПРЕЖНИЕ пары обеих
   * сторон. Источник — справочник (`PeerChatKeys.attestation` +
   * `PeerChatKeys.attestationHistory`, `useChatSession.ts:236-250`; поле
   * собиралось с 4в-1 и не читалось никем). Порядок не важен — сборщик
   * упорядочивает сам.
   *
   * ⚠️ ЗАМЕНИЛО `peerAttestation?: ChatKeyAttestation` (пункт 48). Одного было
   * мало: собеседник, вошедший по коду восстановления, подписывает часть
   * сообщений ПРЕЖНИМ ключом, и заверение нынешней пары превращает его честные
   * слова в `wrong_keys` + `malformed` — арбитр видит ровно то же, что видел бы
   * на сочинённой цепочке.
   *
   * ⚠️ Едут не все: в контейнер кладутся только те, чей подписной ключ НАЗВАН
   * хотя бы одним положенным кадром (и только про предъявителя или собеседника).
   * Заверение, не накрывающее ни одного показанного кадра, не доказывает ничего
   * и стоит 420 байт бюджета плюс одно восстановление адреса у арбитра.
   *
   * ⚠️ ЦЕНА ЭТОГО ПОЛЯ ДЛЯ ЧЕЛОВЕКА, И ЕЁ ОБЯЗАНА ЗНАТЬ ЗАДАЧА 6. Оценка
   * размера считается по ВСЕЙ поданной истории (`PER_ATTESTATION_JSON` = 420
   * байт за запись), потому что «какие заверения пригодятся» известно только
   * после крипто. У `attestationHistory` потолка нет ВООБЩЕ — сервер хранит до
   * двухсот записей. Значит длинная история напрямую уменьшает число «влезает N
   * сообщений», которое видит человек в отказе `too_large`: двести заверений —
   * это 84 000 байт из 262 096, то есть примерно треть мешка ещё до первого
   * кадра. Обрезать историю здесь я не стал (это потолок, а он — открытая
   * находка 50.2), но молча это оставлять нельзя.
   *
   * ⚠️ ОБРАТНАЯ СТОРОНА, НАЗВАННАЯ ВСЛУХ: СМЕНА КЛЮЧА БОЛЬШЕ НЕ ОТЗЫВ.
   * Пока заверение на сторону было ОДНО, предъявитель мог благословить ровно
   * одну пару, и смена ключа работала отзывом де-факто. Теперь все
   * исторически заверённые пары дают `ok` ОДНОВРЕМЕННО, а отзыва в
   * `ChatKeyAttestation` нет вовсе — единственная граница это год
   * (`ATTESTATION_MAX_AGE_MS`). Сцена: у собеседника УКРАЛИ устройство с
   * сохранённым сеансом; вор подписывает кадры прежним ключом, и они приезжают
   * арбитру с `ok` вперемешку с настоящими словами. Размен сделан осознанно —
   * обратное обвиняет честного человека в каждом случае восстановления по коду,
   * — но остаток открыт: **находка 51 в `docs/OPEN-ITEMS.md`**.
   * ⚠️ ОТСЮДА ТРЕБОВАНИЕ К ЗАДАЧЕ 7: текст арбитру обязан говорить «подписано
   * ключом, заверённым тогда-то», а не «автор подтверждён». Время заверения
   * здесь несёт смысл — оно единственное, чем арбитр разведёт две половины
   * переписки. Сегодня `PresentedMessage` его не несёт: нужно новое поле в
   * выдаче читалки, и это решение Задачи 7.
   */
  otherAttestations?: readonly ChatKeyAttestation[];
  /** Клиент цепи для проверки ERC-1271 (исправление 5 договора). Без него
   *  заверение развёрнутого умного кошелька — Safe и подобные, два рода из четырёх
   *  (`project_wallet_kinds_four`) — не проверяется НИКАК, и предъявить такой
   *  человек не может вовсе: сборщик откажет `attestation_unproven`. Со клиентом
   *  проверяется вызовом `isValidSignature`. Счётный кошелёк без кода на цепи не
   *  проверяется ничем и получает честный отказ, а не тишину. */
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

/** Имена отказа, относящиеся к заверению. Выделены типом, а не соглашением:
 *  вернуть отсюда `no_session` не скомпилируется. */
type AttestationFailure = Extract<BuildFailure, `attestation_${string}`>;

/**
 * Вердикт Задачи 1 → имя отказа. У каждого имени СВОЁ лечение, и в этом весь
 * смысл разбора (пункт 49):
 *   `expired`      — заверению больше года: переподписать;
 *   `absent`       — доказательства нет (нет клиента цепи, нет кода на цепи у
 *                    счётного кошелька, узел молчит): подключить сеть;
 *   `wrong_address`— 65 байт, восстановился ДРУГОЙ адрес, а цепь не подтвердила.
 *                    Это либо владелец Safe без клиента цепи, либо подделка, и
 *                    отличить их здесь НЕЧЕМ — «подтвердить не смогли» честнее
 *                    обоих обвинений;
 *   остальные      — то, что лежит на устройстве, заверением ЭТИХ ключей не
 *                    является: заверить заново.
 *
 * ⚠️ `wrong_keys` сюда не приходит НИКОГДА (он рождается только в
 * `verifyChatKeyAttestationForKeys`), но ветка обязана быть: без неё `switch`
 * не исчерпывает союз и `never` ниже краснеет у компилятора. Это форма, а не
 * мёртвый код — появится восьмой вердикт, и сборка встанет здесь.
 */
function attestationRefusal(verdict: Exclude<AttestationVerdict, 'ok'>): AttestationFailure {
  switch (verdict) {
    case 'expired': return 'attestation_expired';
    case 'absent': case 'wrong_address': return 'attestation_unproven';
    case 'malformed': case 'bad_signature': case 'wrong_keys': return 'attestation_missing';
    default: {
      const unreachable: never = verdict;
      return unreachable;
    }
  }
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
 *
 * Возвращает `ArbiterBoxKeyBytes` (не голый `Uint8Array`) — единственный путь
 * к этому клейму из хексовых байт с цепи, симметрично `toArbiterBoxKeyBytes`.
 */
export function arbiterBoxKeyBytes(key: BoxKey): ArbiterBoxKeyBytes {
  if (typeof key !== 'string' || !KEY_HEX_RE.test(key)) {
    throw new TypeError(`arbiterBoxKeyBytes: ожидался 0x + 64 hex (получено ${String(key)})`);
  }
  const out = new Uint8Array(BOX_KEY_LEN);
  for (let i = 0; i < BOX_KEY_LEN; i++) out[i] = parseInt(key.slice(2 + i * 2, 4 + i * 2), 16);
  return toArbiterBoxKeyBytes(out);
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
  // ⚠️ ГРОМКО ПРО ПРЕЖНЕЕ ИМЯ, и это не украшение. Тестовые файлы `tsc` не
  // видит вовсе (`tsconfig.json:exclude`), а вход сборщика в двух местах
  // собирается ПЕРЕМЕННОЙ, где лишнее поле не ловит и проверка свежего литерала.
  // Забытая правка означала бы тихо исчезнувшее заверение собеседника и
  // `absent` вместо `ok` у арбитра — ровно ту беду, которую чинит пункт 48.
  // Проверяется НАЛИЧИЕ поля, а не значение: `{ peerAttestation: undefined }`
  // — тоже незавершённая правка.
  if (input !== null && typeof input === 'object' && 'peerAttestation' in input) {
    throw new TypeError(
      'buildPresentation: поле peerAttestation заменено на otherAttestations (пункт 48) — ' +
      'одно заверение на сторону делает прежние слова собеседника непроверяемыми',
    );
  }
  if (input?.otherAttestations !== undefined && !Array.isArray(input.otherAttestations)) {
    throw new TypeError('buildPresentation: otherAttestations должен быть массивом заверений');
  }

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

  // Своё заверение. Сначала то, что видно без сети: оно про ЭТОГО человека и про
  // ЭТИ ключи? Контейнер подписывается ключом подписи предъявителя, и заверение
  // про другие ключи означало бы предъявление, которое ничего не доказывает.
  const att = input?.ownAttestation;
  if (!att || typeof att !== 'object'
    || typeof att.address !== 'string' || att.address.toLowerCase() !== presenter
    || typeof att.boxKey !== 'string' || att.boxKey.toLowerCase() !== hex32(session.keypair.publicKey)
    || typeof att.signKey !== 'string' || att.signKey.toLowerCase() !== hex32(signer.publicKey)) {
    // ⚠️ НЕ `no_session` (пункт 49): сеанс тут может быть безупречен. Лечение —
    // «заверить ключи», и оно другое, чем «перезайти в чат».
    return { ok: false, reason: 'attestation_missing' };
  }
  // ⚠️ Клиент цепи ПРОБРАСЫВАЕТСЯ (исправление 5 договора 4в-1). Без него
  // заверение владельца Safe с 65-байтовой подписью получает `wrong_address`, а
  // ERC-1271-подпись не той длины — `absent` (`chatKeyAttestation.ts:441-462`);
  // в обоих случаях предъявить он не может, и причину надо НАЗВАТЬ, а не свести
  // к «нет сеанса чата».
  const ownVerdict = await verifyChatKeyAttestation(att, input.publicClient);
  if (ownVerdict !== 'ok') return { ok: false, reason: attestationRefusal(ownVerdict) };

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
    + PER_ATTESTATION_JSON * (1 + (input.otherAttestations?.length ?? 0))
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
  /** Подписные ключи, НАЗВАННЫЕ положенными кадрами. По ним ниже отбираются
   *  заверения: заверение, не накрывающее ни одного показанного кадра, арбитру
   *  не доказывает ничего. */
  const usedSignKeys = new Set<string>();
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
    usedSignKeys.add(hex32(c.signerPublicKey));
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

  /* ── заверения: ПО ПАРЕ КЛЮЧЕЙ, а не по стороне (пункт 48) ── */

  // Едет своё нынешнее (им подписан контейнер) плюс те чужие, чей подписной ключ
  // НАЗВАН положенным кадром. Про третий адрес — не едет: карта читалки ведётся
  // по адресу, такое заверение не читает никто, а восстановление адреса по его
  // подписи арбитр оплачивает.
  const attPairId = (a: ChatKeyAttestation): string =>
    `${a.address.toLowerCase()}|${a.signKey.toLowerCase()}`;
  const seenPairs = new Set<string>([attPairId(att)]);
  const otherAttestations: ChatKeyAttestation[] = [];
  for (const a of input.otherAttestations ?? []) {
    if (!a || typeof a !== 'object') continue;
    if (typeof a.address !== 'string' || typeof a.signKey !== 'string') continue;
    const addr = a.address.toLowerCase();
    if (addr !== presenter && addr !== peer) continue;
    if (!usedSignKeys.has(a.signKey.toLowerCase())) continue;
    const id = attPairId(a);
    if (seenPairs.has(id)) continue;      // дубль пары — гейт читалки отвергнет контейнер целиком
    seenPairs.add(id);
    otherAttestations.push(a);
  }
  // ⚠️ ПОРЯДОК ОДНОЗНАЧЕН, И ЭТО НЕ КОСМЕТИКА. `canonicalPresentationBytes`
  // печатает заверения В ПОРЯДКЕ МАССИВА, а справочник отдаёт историю в порядке
  // сервера. Без сортировки раздел заверений в ПОДПИСЫВАЕМЫХ БАЙТАХ зависел бы
  // от того, в каком порядке ответил сервер справочника, а не от того, какие
  // заверения приложены. Сортировка покупает ровно это: раздел заверений есть
  // функция НАБОРА. Первым — своё нынешнее (им подписан контейнер), дальше по
  // адресу, при равенстве — по подписному ключу. Замок — R5
  // (`presentationKeyRotation.test.ts`), мутация 5 → 1 красный.
  //
  // ⚠️ ЧЕГО ЭТО НЕ ПОКУПАЕТ, И ЭТО ВАЖНЕЕ. КОНТЕЙНЕР ЦЕЛИКОМ ФУНКЦИЕЙ
  // СОДЕРЖИМОГО НЕ ЯВЛЯЕТСЯ — ни с сортировкой, ни без неё, и починить это
  // сортировкой нельзя в принципе. Две сборки ОДНОГО И ТОГО ЖЕ выбора дают
  // разные байты по трём независимым причинам:
  //   1. `keys[].forArbiter`/`forPeer` — это `crypto_box_seal` (`sealForRecipient`,
  //      `chatCrypto.ts:153`), который берёт СВЕЖУЮ эфемерную пару на каждый
  //      вызов (замерено зондом 11 августа: расхождение двух сборок сидело
  //      ровно на первом `forArbiter`);
  //   2. `issuedAt` — часы в момент сборки;
  //   3. сам мешок наружу (`sealPresentation`) — снова `crypto_box_seal`.
  // Отсюда следствие для Выкатки 2, которое нельзя проглядеть: отпечаток в цепи
  // может утверждать «предъявлен ВОТ ЭТОТ мешок», но НЕ «предъявлена вот эта
  // переписка». Два отпечатка одного и того же выбора не сравнимы между собой
  // ничем, и «предъявить заново» новому арбитру даёт новый отпечаток. Прежняя
  // редакция этого комментария утверждала обратное — она была неверна.
  otherAttestations.sort((x, y) => {
    const xa = x.address.toLowerCase(); const ya = y.address.toLowerCase();
    if (xa !== ya) return xa < ya ? -1 : 1;
    const xk = x.signKey.toLowerCase(); const yk = y.signKey.toLowerCase();
    return xk === yk ? 0 : xk < yk ? -1 : 1;
  });

  const now = typeof input.now === 'function' ? input.now : () => Date.now();
  const unsigned: UnsignedPresentation = {
    kind: PRESENTATION_KIND,
    dealId,
    presenter,
    // Заверения кладутся ДОСЛОВНО, ни одно поле не приводится и не правится:
    // любая правка рвёт подпись кошелька, а её проверяет арбитр сам.
    attestations: [att, ...otherAttestations],
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
