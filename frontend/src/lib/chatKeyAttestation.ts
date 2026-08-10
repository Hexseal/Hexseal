/**
 * chatKeyAttestation.ts — связка «адрес кошелька ↔ ключи чата», заверенная
 * ПОДПИСЬЮ КОШЕЛЬКА и проверяемая читателем БЕЗ доверия к нашему серверу.
 *
 * ─── ЗАЧЕМ ─────────────────────────────────────────────────────────────────
 *
 * До этого модуля публикация ключей в справочник заверялась только пропуском
 * склада, который выдаёт наш сервер (`publishChatKeys`). Значит все три
 * проверки, которые арбитр может сделать сам — форма кадра, сходимость
 * `bodyHash`, подпись звена — проходят и на цепочке, СОЧИНЁННОЙ предъявителем
 * за собеседника свежей парой Ed25519: подделка согласована сама с собой, и
 * отличить её не от чего (шапка `chatConversation.ts` это признаёт). В обычном
 * приёме от подделки спасает свидетельство склада о загрузившем — у арбитра
 * его нет вовсе.
 *
 * Заверение — единственное, что связывает подписной ключ с адресом на цепи БЕЗ
 * участия сервера. Сервер его хранит и отдаёт; проверяет читатель.
 *
 * ─── ПОЧЕМУ АДРЕС НЕ ЛЕЖИТ В ПОДПИСАННОЙ СТРУКТУРЕ ─────────────────────────
 *
 * Подписант устанавливается ВОССТАНОВЛЕНИЕМ, а `att.address` — это заявление
 * рядом. Одно сравнение `recovered === address` держит сразу два нападения:
 *
 *   - переписали адрес → восстановленный не сойдётся с заявленным;
 *   - переписали ключи → подпись перестала соответствовать структуре →
 *     восстанавливается случайный адрес → не сойдётся.
 *
 * Положи адрес внутрь структуры, и второе нападение пришлось бы ловить
 * отдельной проверкой; убери сравнение — оба становятся `ok`. Замерено
 * мутацией М1 задачи.
 *
 * ─── ЧЕТЫРЕ РОДА КОШЕЛЬКОВ И ЧТО ДЛЯ КАЖДОГО ЗНАЧИТ «ДОКАЗАНО» ─────────────
 *
 * Родов кошельков на Base ЧЕТЫРЕ, и признак «есть ли код на цепи» ошибается на
 * двух — различать надо по ДЛИНЕ ПОДПИСИ (65 байт = обычный).
 *
 *   1. обычный (EOA): 65 байт, адрес восстанавливается местной арифметикой.
 *      Цепь не нужна и НЕ спрашивается — обычный заход не должен зависеть от
 *      узла RPC.
 *   2. Safe с одним владельцем: 65 байт, но восстанавливается ВЛАДЕЛЕЦ, а не
 *      кошелёк. Арифметика не сошлась → спрашиваем цепь; она может СПАСТИ.
 *   3. развёрнутый умный кошелёк: подпись не 65 байт (ERC-1271). Есть код →
 *      `isValidSignature`.
 *   4. счётный (кода на цепи ещё нет): проверить НЕЧЕМ. Честный `absent` с
 *      причиной, а не `malformed` и не тишина.
 *
 * ⚠️ ЦЕПЬ МОЖЕТ ТОЛЬКО СПАСТИ, НО НЕ УТЯЖЕЛИТЬ. В ветке 65 байт вызов на цепь
 * делается ПОСЛЕ неудавшейся арифметики и способен превратить `wrong_address` в
 * `ok`, но не наоборот: узел, ответивший «не годна», не отменяет того, что
 * подпись местно не сошлась. Иначе моргнувший (или враждебный) узел портил бы
 * честные заверения обычных кошельков — то есть проверка перестала бы быть
 * арифметикой ровно там, где она ею была.
 *
 * ⚠️ МАГИЧЕСКОМУ ЗНАЧЕНИЮ ПО АДРЕСУ БЕЗ КОДА НЕ ВЕРИМ. Счётный кошелёк не может
 * проверить ничего; узел, отвечающий на таком адресе `0x1626ba7e`, либо врёт,
 * либо смотрит не в ту сеть. Поэтому `getCode` спрашивается РАНЬШЕ, и при пустом
 * коде вызов подписи не делается вовсе (мутация М24).
 *
 * `publicClient` НЕОБЯЗАТЕЛЕН: без него роды 2-4 получают честное «доказательства
 * нет» (`absent`), а не `ok`. Обязательным его делать нельзя — заверение
 * обычного кошелька обязано проверяться без сети. Но и молчать нельзя: без этой
 * ветки два рода из четырёх предъявить не могли бы ВОВСЕ, и §1 замысла для них
 * был бы ложью (исправление 5 договора v2 — принятое возражение 1).
 *
 * Приём `establishIdentity` (`chatSession.ts:865-928`) здесь не переиспользуется:
 * он различает роды, чтобы выбрать способ ВЫВОДА ключа, а нам нужно ДОКАЗАТЬ
 * принадлежность. Но ступень 2 оттуда повторена сознательно: «ровно 65 байт —
 * спрашиваем не длину, а принадлежность».
 *
 * ─── ЧЕГО ЭТОТ МОДУЛЬ НЕ МОЖЕТ ─────────────────────────────────────────────
 *
 * ⚠️ `absent` — ЭТО НЕ `malformed`. «Заверения нет / проверить нечем» винит
 * порядок выкатки (человек ещё не нажал «заверить», или у него счётный
 * кошелёк); «мусор» винит предъявителя. Слитые в одно слово, они превращают
 * честного человека с новым кошельком в подозреваемого — ровно та ложь, которую
 * проект называет главным классом промаха.
 *
 * ⚠️ `wrong_keys` ОТСЮДА НЕ ВЫХОДИТ. Сказать «подпись верна, но заверены другие
 * ключи» нельзя, глядя только на заверение: нужны ожидаемые ключи. Их знает
 * вызывающий (звенья цепочки, запись справочника, свой сеанс) — и потому
 * единственная дверь к этому вердикту `verifyChatKeyAttestationForKeys`, где
 * ХОТЯ БЫ ОДИН ожидаемый ключ ОБЯЗАН быть назван.
 *
 * ⚠️ `verifyChatKeyAttestationForKeys` СВЕРЯЕТ ТОЛЬКО ПРИЕХАВШИЕ ПОЛЯ.
 * `expected` — это `{ address?, boxKey?, signKey? }`, все поля необязательны
 * (договор об именах v4, исправление 5 «два ключа из трёх арбитр вообще
 * знает»). Причина замерена: арбитр знает подписной ключ, названный кадром, а
 * боксовый — никак; подстановка пустышки вместо незнакомого поля дала бы
 * `wrong_keys` на каждом честном сообщении. Но параметр `expected` при этом
 * ОБЯЗАН остаться единым объектом (не тремя необязательными аргументами) —
 * иначе вызов без ожидаемых ключей вовсе компилировался бы, и «забыть
 * сверить» перестало бы быть ошибкой типов.
 *
 * ⚠️ ДВА СЛЕДСТВИЯ, КАЖДОЕ ОБЯЗАТЕЛЬНО:
 *   1. Тело читает `expected.boxKey`/`expected.signKey` ТОЛЬКО через охрану
 *      `!== undefined` — прямое `.toLowerCase()` без неё бросает `TypeError`
 *      на каждом вызове, где вызывающий назвал только один из двух ключей
 *      (ровно случай арбитра, у которого боксового ключа нет). Мутация М33.
 *   2. Пустой объект (ни `boxKey`, ни `signKey`) компилируется, но обязан
 *      бросить ГРОМКО, а не молча вернуть голый вердикт — иначе `wrong_keys`
 *      тихо становится недостижимым у вызывающего, который забыл оба поля.
 *      Мутация М31.
 *
 * ⚠️ `expected.address` ЭТИМ МОДУЛЕМ НЕ СВЕРЯЕТСЯ. Поле в форме есть (Задачи
 * 5-6 могут его передавать или не передавать — договор не требует ронять его
 * из типа), но сверка «это заверение про ТОТ адрес» здесь не реализована:
 * `att.address` уже проверен восстановлением подписи внутри
 * `verifyChatKeyAttestation`, а «это заверение того человека, которого я
 * ждал» — вопрос другого слоя (реестр сделки/спора), не этого модуля. Оставить
 * здесь непроверяющую сверку значило бы обещать проверку, которой нет.
 * Мутация М32 показывает, что добавление такой сверки — это регрессия, а не
 * улучшение: она ломает честного собеседника, который дал верные ключи, но
 * чей адрес вызывающий не проверял.
 *
 * ⚠️ ОКНО ПОДПИСИ НИКОГДА НЕ ВСПЛЫВАЕТ САМО. `signChatKeyAttestation` зовётся
 * только из `ensureChatKeyAttestation`, и только по человеческому действию.
 * Причина не в вежливости: живая петля на Android 31 июля — два наших
 * автоподписания, столкнувшихся после выгрузки вкладки. Публикация в
 * справочник возит ТОЛЬКО то, что уже лежит в кладовой, и подписи не просит
 * никогда.
 */

import { recoverTypedDataAddress, hashTypedData, type WalletClient, type PublicClient } from 'viem';
import { deriveLinkSigningKeypair } from './chatConversation';
import type { ChatSession } from './chatSession';
import { withWalletLock } from '@/lib/walletLock';

/**
 * ⚠️ Поля ключей КЛЕЙМЁНЫЕ (`` `0x${string}` ``, не `string`). Непроверенная
 * строка из JSON справочника сюда не ляжет — а именно так она и приезжает.
 * Перестановку `boxKey`↔`signKey` тип НЕ ловит (оба одной формы): её держат
 * сверка с сеансом (`cachedChatKeyAttestation`) и сверка на сервере. Сказано
 * вслух, чтобы никто не решил, что тип закрыл больше, чем закрыл. Запреты —
 * `chatKeyAttestationTypeBans.ts`.
 */
export interface ChatKeyAttestation {
  address: `0x${string}`;
  boxKey: `0x${string}`; // 0x + 64 hex, нижний регистр
  signKey: `0x${string}`; // 0x + 64 hex, нижний регистр
  issuedAt: number; // мс
  signature: `0x${string}`; // EIP-712 подпись кошельком
}

/** Семь слов, и каждое означает РАЗНОЕ действие читателя. `absent` —
 *  доказательства нет (поля нет, клиента цепи нет, кода на цепи нет, узел
 *  молчит); `malformed` — пришёл мусор; `wrong_keys` — заверено другое (только
 *  из `verifyChatKeyAttestationForKeys`). */
export type AttestationVerdict =
  | 'ok'
  | 'absent'
  | 'malformed'
  | 'bad_signature'
  | 'wrong_address'
  | 'wrong_keys'
  | 'expired';

/* ─────────────────────────── форма и границы ──────────────────────────── */

/** Та же форма, что принимает сервер (`relayer/directory.js`, `_isValidKeyHex`):
 *  `0x` + 64 НИЖНЕРЕГИСТРОВЫХ hex-цифры. Написана здесь заново, а не взята из
 *  `chatDirectoryTypes.ts`, намеренно: тот файл существует ради разрыва кольца
 *  импортов, и заводить обратную стрелку значений в него — вернуть кольцо. Та
 *  же дисциплина, что у `CHAT_PUBLIC_KEY_LEN` (`chatDirectoryTypes.ts:47-51`):
 *  два места сходятся ЧИСЛОМ, а не ссылкой друг на друга. */
const ATTESTATION_KEY_HEX_RE = /^0x[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SIG_HEX_RE = /^0x[0-9a-f]+$/;

/** Ровно 65 байт — единственная длина, из которой адрес восстанавливается без
 *  цепи (см. «четыре рода кошельков»). */
const PLAIN_SIGNATURE_HEX_LEN = 2 + 130;

/** ERC-1271: `isValidSignature(bytes32,bytes) → bytes4`. Один селектор, одно
 *  магическое значение — вторая реализация этой сверки была бы вторым
 *  источником истины о том, что значит «кошелёк подтвердил». */
const ERC1271_ABI = [{
  type: 'function',
  name: 'isValidSignature',
  stateMutability: 'view',
  inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }],
  outputs: [{ name: 'magicValue', type: 'bytes4' }],
}] as const;

/** `bytes4(keccak256("isValidSignature(bytes32,bytes)"))`. Ровно то же число
 *  стоит в универсальном проверяльщике, который релеер уже носит для пропусков
 *  склада (`relayer/app.js`, `1626ba7e` внутри байткода) — два места сходятся
 *  ЧИСЛОМ, а не ссылкой. */
const ERC1271_MAGIC_VALUE = '0x1626ba7e';

/** Потолок подписи. Ровно тот же, что у сервера — заверение, которое клиент
 *  считает годным, а сервер отвергает, ломает объявление ключа целиком (Л-5
 *  задачи). ERC-1271-подпись Safe с несколькими владельцами сюда влезает. */
export const MAX_ATTESTATION_SIG_BYTES = 512;

/** Год. Дольше — и утекший прежний ключ остаётся годным для подделки навсегда;
 *  короче — и человеку приходится переподписывать заверение чаще, чем он вообще
 *  заходит, то есть окно кошелька становится регулярным. */
export const ATTESTATION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/** Сутки вперёд прощаются: часы на устройстве человека сбиты чаще, чем он
 *  подделывает заверения. Дальше — `expired`, а не `ok`. */
export const ATTESTATION_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/* ────────────────────── подписываемая структура ───────────────────────── */

/**
 * Домен тот же, что у ключа чата (`chatCrypto.ts:41-44`), а РАЗЛИЧАЕТ подписи
 * тип структуры и `purpose`: EIP-712 мешает в дайджест хеш типа, поэтому
 * подпись входа в чат нельзя предъявить как заверение и наоборот. `chainId` и
 * `verifyingContract` не включены по той же причине, что там: заверение не
 * должно зависеть от того, к какой сети подключён кошелёк в момент подписи.
 *
 * ⚠️ Структура собирается ОДНОЙ функцией, которую зовут и подпись, и проверка.
 * Два места, собирающие её отдельно, — это два источника истины о том, что
 * подписано; они разъедутся молча, и проверка начнёт отвергать честные
 * заверения (разбор — шапка `chatCrypto.ts:18-25`).
 */
const ATTESTATION_DOMAIN = { name: 'Hexseal', version: '1' } as const;

const ATTESTATION_TYPES = {
  ChatKeyAttestation: [
    { name: 'purpose', type: 'string' },
    { name: 'boxKey', type: 'bytes32' },
    { name: 'signKey', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
  ],
} as const;

const ATTESTATION_PURPOSE = 'hexseal.chat.key.attestation.v1';

function typedDataFor(boxKey: `0x${string}`, signKey: `0x${string}`, issuedAt: number) {
  return {
    domain: ATTESTATION_DOMAIN,
    types: ATTESTATION_TYPES,
    primaryType: 'ChatKeyAttestation',
    message: {
      purpose: ATTESTATION_PURPOSE,
      boxKey,
      signKey,
      issuedAt: BigInt(issuedAt),
    },
  } as const;
}

function keyHex(bytes: Uint8Array): `0x${string}` {
  let s = '0x';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s as `0x${string}`;
}

/* ──────────────────────────── подписать ───────────────────────────────── */

/**
 * Заверить свои ключи чата подписью кошелька.
 *
 * @throws {TypeError} кошелёк без аккаунта, кошелёк подключён ДРУГИМ адресом,
 *   или ключ сеанса не 32 байта. Все три — наш собственный мусор на входе, и
 *   молчаливое заверение здесь означало бы объект, который выглядит сданным, а
 *   проверяется как чужой (`wrong_address`) — то есть §11 замысла срабатывает
 *   наоборот: человек уверен, что предъявил, арбитр видит непроверенное.
 */
export async function signChatKeyAttestation(
  walletClient: WalletClient,
  session: ChatSession,
): Promise<ChatKeyAttestation> {
  const account = walletClient.account;
  if (!account) {
    throw new TypeError('signChatKeyAttestation: у кошелька нет аккаунта — подписывать нечем');
  }
  if (account.address.toLowerCase() !== session.address.toLowerCase()) {
    throw new TypeError(
      `signChatKeyAttestation: кошелёк подключён адресом ${account.address}, ` +
      `а ключи заверяются для ${session.address} — такое заверение никто не проверит`,
    );
  }
  if (!(session.keypair?.publicKey instanceof Uint8Array) || session.keypair.publicKey.length !== 32) {
    throw new TypeError('signChatKeyAttestation: session.keypair.publicKey должен быть 32 байта');
  }

  const signer = await deriveLinkSigningKeypair(session.keypair);
  const boxKey = keyHex(session.keypair.publicKey);
  const signKey = keyHex(signer.publicKey);
  const issuedAt = Date.now();

  // ⚠️ ОБЩИЙ МЬЮТЕКС КОШЕЛЬКА (та же дисциплина, что `useChatSession.ts` уже
  // применяет через `signChatKeyLocked`): второй одновременный запрос подписи
  // прилетает в кошелёк как -32002 и на мобильном MetaMask не отменяется — это
  // ровно цена промаха, ради которой заведён общий лок на все места в
  // приложении, где всплывает окно кошелька. Лок стоит ЗДЕСЬ, в самой точке
  // вызова, а не у будущего вызывающего (страница арбитра, план 4в-2) — иначе
  // защита существовала бы только пока не забудут её взять на новом экране.
  //
  // ⚠️ ЭТА ОБЁРТКА ДЕРЖИТСЯ СТРУКТУРНЫМ ГЕЙТОМ `lib/signaturePaths.test.ts` —
  // НО ТОЧНО СКАЗАТЬ, ЧТО ИМЕННО ОН ЛОВИТ, ВАЖНЕЕ, ЧЕМ СКАЗАТЬ, ЧТО ОН
  // «СТОИТ». До раунда усиления 10 августа 2026 гейт проверял только ИМПОРТ
  // `@/lib/walletLock` где-то в файле — снятие ровно этой обёртки при
  // оставленном (мёртвом) импорте проходило гейт зелёным, 0 красных из 45.
  // После усиления гейт разбирает вложенность по месту (вызов подписи обязан
  // лежать лексически внутри `withWalletLock(...)`) и эту же мутацию ловит:
  // 1 красный из 45. Он по-прежнему НЕ АСТ-разбор (см. предупреждения в
  // шапке `signaturePaths.test.ts` про строки/скобки в комментариях и про
  // то, что адрес лока не сверяется с адресом подписи) — второй источник
  // защиты здесь текстовый и ограниченный, а не формальное доказательство.
  const signature = await withWalletLock(session.address, () =>
    // Каст — тот же приём, что `relay.ts` применяет к домену USDC: типы viem для
    // `signTypedData` дженерик-выводятся из литерала, а мы подаём собранную
    // структуру. Содержимое от каста не меняется.
    walletClient.signTypedData({
      account,
      ...typedDataFor(boxKey, signKey, issuedAt),
    } as unknown as Parameters<typeof walletClient.signTypedData>[0]));

  return { address: session.address, boxKey, signKey, issuedAt, signature: signature.toLowerCase() as `0x${string}` };
}

/* ──────────────────────────── проверить ───────────────────────────────── */

/**
 * Разобрать форму, ничего не проверяя криптографически. `null` — не заверение.
 *
 * Существует отдельно от `verifyChatKeyAttestation`, потому что чтение
 * справочника обязано уметь разбирать записи ПОЭЛЕМЕНТНО и не терять соседние
 * из-за одной битой (та же дисциплина, что у истории подписных ключей,
 * `useChatSession.ts`), а вердикт там ещё не нужен.
 */
export function parseChatKeyAttestation(value: unknown): ChatKeyAttestation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.address !== 'string' || !ADDRESS_RE.test(r.address)) return null;
  // Проверка ФОРМЫ и есть то место, где непроверенная строка становится
  // клеймёной: `0x${string}` ниже — не украшение каста, а вывод из этих двух
  // строк. Уберёшь проверку — каст начнёт врать.
  if (typeof r.boxKey !== 'string' || !ATTESTATION_KEY_HEX_RE.test(r.boxKey)) return null;
  if (typeof r.signKey !== 'string' || !ATTESTATION_KEY_HEX_RE.test(r.signKey)) return null;
  if (typeof r.issuedAt !== 'number' || !Number.isSafeInteger(r.issuedAt) || r.issuedAt <= 0) return null;
  if (typeof r.signature !== 'string') return null;
  const sig = r.signature.toLowerCase();
  if (!SIG_HEX_RE.test(sig) || sig.length < 4 || (sig.length - 2) % 2 !== 0) return null;
  if ((sig.length - 2) / 2 > MAX_ATTESTATION_SIG_BYTES) return null;
  return {
    address: r.address as `0x${string}`,
    boxKey: r.boxKey as `0x${string}`,
    signKey: r.signKey as `0x${string}`,
    issuedAt: r.issuedAt,
    signature: sig as `0x${string}`,
  };
}

/** Срок — ПОСЛЕДНЯЯ ступень, и это несущее решение (см. `verifyChatKeyAttestation`). */
function withinLifetime(issuedAt: number): AttestationVerdict {
  const now = Date.now();
  if (issuedAt > now + ATTESTATION_FUTURE_SKEW_MS) return 'expired';
  if (issuedAt < now - ATTESTATION_MAX_AGE_MS) return 'expired';
  return 'ok';
}

/**
 * Спросить у цепи, подтверждает ли КОНТРАКТ по адресу эту подпись (ERC-1271).
 *
 *   `'yes'`      — контракт вернул магическое значение;
 *   `'no'`       — контракт посмотрел и отказал (это ОПРЕДЕЛЁННЫЙ ответ);
 *   `'unproven'` — спросить не удалось: клиента цепи не дали, по адресу нет
 *                  кода (счётный кошелёк), либо узел не ответил.
 *
 * ⚠️ КОД СПРАШИВАЕТСЯ РАНЬШЕ ПОДПИСИ. Счётный кошелёк не может проверить
 * ничего; узел, отвечающий магическим значением на адресе без кода, врёт или
 * смотрит не в ту сеть — и верить ему значит выдать «доказано» там, где
 * доказывать было нечем. Мутация М24.
 */
async function askChain(
  att: ChatKeyAttestation,
  publicClient?: PublicClient,
): Promise<'yes' | 'no' | 'unproven'> {
  if (!publicClient) return 'unproven';

  let code: `0x${string}` | undefined;
  try {
    code = await publicClient.getCode({ address: att.address });
  } catch {
    // Узел моргнул — это не «подделка» и не «нет заверения по существу»;
    // это «не доказали». Разница видна арбитру словами (§15.2).
    return 'unproven';
  }
  if (!code || code === '0x') return 'unproven';

  try {
    const magic = await publicClient.readContract({
      address: att.address,
      abi: ERC1271_ABI,
      functionName: 'isValidSignature',
      args: [
        hashTypedData(typedDataFor(att.boxKey, att.signKey, att.issuedAt)),
        att.signature,
      ],
    });
    return typeof magic === 'string' && magic.toLowerCase() === ERC1271_MAGIC_VALUE ? 'yes' : 'no';
  } catch {
    return 'unproven';
  }
}

/**
 * Заверение годно? Вердикт, никогда исключение — читатель обязан различать семь
 * исходов, а не ловить один `catch`.
 *
 * ⚠️ ПОРЯДОК ПРОВЕРОК НЕСУЩИЙ: «поля нет» → форма → подпись → срок. Проверь
 * срок раньше подписи, и подделка, датированная прошлым годом, отвечалась бы
 * «просрочено» — то есть срок ПРЯТАЛ БЫ подделку (мутация М4). Слей «поля нет» с
 * мусором, и человек, ещё не заверявший ключи, станет подозреваемым (М22).
 *
 * `publicClient` необязателен: обычный кошелёк проверяется без сети вовсе. С ним
 * проверяются роды 2-4; без него они получают `absent` — честное «доказательства
 * нет», а не `ok` и не «мусор».
 */
export async function verifyChatKeyAttestation(
  att: unknown,
  publicClient?: PublicClient,
): Promise<AttestationVerdict> {
  // «Поля нет» — не мусор. Первый день работы выглядит ровно так: вторая
  // сторона ключи объявила, а «заверить» не нажимала.
  if (att === undefined || att === null) return 'absent';

  const parsed = parseChatKeyAttestation(att);
  if (!parsed) return 'malformed';

  if (parsed.signature.length === PLAIN_SIGNATURE_HEX_LEN) {
    let recovered: `0x${string}` | null = null;
    try {
      recovered = await recoverTypedDataAddress({
        ...typedDataFor(parsed.boxKey, parsed.signKey, parsed.issuedAt),
        signature: parsed.signature,
      } as unknown as Parameters<typeof recoverTypedDataAddress>[0]);
    } catch {
      // Негодный признак чётности, нулевой `r`, мусор в `s` — «доказать не
      // смогли», а не «подписал не тот».
      recovered = null;
    }

    // ⚠️ ЭТО СРАВНЕНИЕ И ЕСТЬ ВСЯ ЗАЩИТА. Регистр приводится: кошелёк отдаёт
    // адрес с контрольной суммой, справочник хранит нижний.
    if (recovered && recovered.toLowerCase() === parsed.address.toLowerCase()) {
      return withinLifetime(parsed.issuedAt);
    }

    // 65 байт, а восстановился ДРУГОЙ адрес: либо подделка, либо Safe с одним
    // владельцем — владелец подписал за кошелёк. Отличить может только цепь, и
    // она здесь ТОЛЬКО СПАСАЕТ: ответ «не годна» вердикт не меняет, иначе
    // моргнувший узел портил бы заверения обычных кошельков.
    if ((await askChain(parsed, publicClient)) === 'yes') return withinLifetime(parsed.issuedAt);
    return recovered ? 'wrong_address' : 'bad_signature';
  }

  // Не 65 байт — местной арифметикой не проверяется вовсе (ERC-1271).
  const chain = await askChain(parsed, publicClient);
  if (chain === 'yes') return withinLifetime(parsed.issuedAt);
  if (chain === 'no') return 'bad_signature';
  // Клиента цепи не дали / по адресу нет кода / узел молчит — доказательства
  // НЕТ. Причина названа тут же, а вердикт честный: `absent`, не `malformed`.
  return 'absent';
}

/**
 * То же, плюс ответ на второй вопрос: а те ли это ключи?
 *
 * ⚠️ ПОРЯДОК: сначала «настоящее ли оно само», потом «про те ли ключи».
 * Наоборот — и подделка, заверяющая чужие ключи, отвечалась бы `wrong_keys`, то
 * есть звучала бы как чужая честная ошибка вместо подлога (мутация М26).
 * `expired` при несовпадении ключей уступает `wrong_keys`: «не про эти ключи
 * вовсе» сообщает арбитру больше, чем «просрочено», и обе правды честны.
 *
 * ⚠️ `expected` — договор об именах v4 (окончательная форма, замерена на tsc
 * 5.9.2 этого репозитория): ПАРАМЕТР обязателен, поля внутри необязательны.
 * Арбитр знает только подписной ключ, названный кадром цепочки, а боксовый не
 * знает никак — сделать оба поля обязательными означало бы `wrong_keys` на
 * КАЖДОМ честном сообщении арбитра. Сделать необязательным сам параметр
 * нельзя: это сломало бы фикстуру запретов (`chatKeyAttestationTypeBans.ts`,
 * запрет 4) ошибкой TS2578 — «забыть вызвать без аргумента» перестало бы быть
 * ошибкой типов.
 *
 * Сверяются ТОЛЬКО ПРИЕХАВШИЕ поля: `expected.boxKey`/`expected.signKey`
 * читаются через `!== undefined`, не безусловным `.toLowerCase()` — иначе
 * вызов с одним названным ключом (ровно случай арбитра) бросал бы `TypeError`
 * на каждом сообщении (мутация М33). Пустой объект (ни один ключ не назван)
 * компилируется, но проверять было бы нечем — поэтому он ГРОМКО бросает
 * `TypeError`, а не молча возвращает голый вердикт `verifyChatKeyAttestation`
 * (мутация М31): иначе `wrong_keys` тихо становится недостижимым у
 * вызывающего, который забыл оба поля.
 *
 * `expected.address` НЕ СВЕРЯЕТСЯ. Задача 1 отвечает только за связку «ключи ↔
 * заверение», а не за «это тот самый человек, кого я ждал» — то, что читает
 * другое поле, ни разу не прочитанное в этом теле, оставило бы читателя с
 * непроверяющей проверкой (мутация М32 показывает цену добавления такой
 * сверки: она ложно топит честного собеседника).
 */
export async function verifyChatKeyAttestationForKeys(
  att: unknown,
  expected: { address?: `0x${string}`; boxKey?: `0x${string}`; signKey?: `0x${string}` },
  publicClient?: PublicClient,
): Promise<AttestationVerdict> {
  if (expected.boxKey === undefined && expected.signKey === undefined) {
    throw new TypeError(
      'verifyChatKeyAttestationForKeys: expected.boxKey или expected.signKey обязаны быть названы — ' +
      'пустой объект компилируется, но сверять было бы нечем, и вердикт wrong_keys стал бы тихо недостижим',
    );
  }

  const own = await verifyChatKeyAttestation(att, publicClient);
  const parsed = parseChatKeyAttestation(att);
  if (!parsed) return own;

  const namesOtherKeys =
    (expected.boxKey !== undefined && parsed.boxKey.toLowerCase() !== expected.boxKey.toLowerCase())
    || (expected.signKey !== undefined && parsed.signKey.toLowerCase() !== expected.signKey.toLowerCase());

  if (namesOtherKeys && (own === 'ok' || own === 'expired')) return 'wrong_keys';
  return own;
}

/* ───────────────────────────── кладовая ───────────────────────────────── */

/** Заверение — данные ОТКРЫТЫЕ (два открытых ключа, адрес, время, подпись над
 *  ними). Прятать нечего, а переживать перезагрузку и быть общим у вкладок —
 *  обязано, иначе окно подписи вернулось бы на каждый заход. Отсюда
 *  `localStorage`, а не IndexedDB: тайны нет, объём — сотни байт. */
const ATTESTATION_STORAGE_PREFIX = 'hexseal_chat_attestation_';

function storage(): Storage | null {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    return s && typeof s.getItem === 'function' ? s : null;
  } catch {
    // Доступ умеет БРОСАТЬ (сторонний контекст с запрещёнными куками), а не
    // просто отсутствовать — тот же приём, что `storedBagPass.ts` уже
    // применяет.
    return null;
  }
}

/** `false` — не легло (квота, приватный режим). Вызывающий продолжает работать
 *  с заверением в памяти; молчать об этом нельзя, иначе следующий заход
 *  попросит подпись заново без единого объяснения. */
export function rememberChatKeyAttestation(att: ChatKeyAttestation): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(ATTESTATION_STORAGE_PREFIX + att.address.toLowerCase(), JSON.stringify(att));
    return true;
  } catch {
    return false;
  }
}

export function forgetChatKeyAttestation(address: string): void {
  const s = storage();
  if (!s) return;
  try { s.removeItem(ATTESTATION_STORAGE_PREFIX + address.toLowerCase()); } catch { /* нечего убирать */ }
}

/**
 * Заверение ЭТОГО сеанса, если оно есть на устройстве.
 *
 * ⚠️ СВЕРКА КЛЮЧЕЙ С СЕАНСОМ — НЕ ОСТОРОЖНОСТЬ, А ЕДИНСТВЕННОЕ, ЧТО ДЕРЖИТ
 * ОБЪЯВЛЕНИЕ КЛЮЧА ЖИВЫМ. Заверение прежней пары (человек вошёл по коду
 * восстановления, сменил устройство) сервер отвергнет как несогласованное —
 * а `POST /keys` это ЕДИНСТВЕННАЯ дорога объявить ключ. Отдай устаревшее, и
 * человеку не сможет написать никто, при том что чат у него «работает».
 */
export async function cachedChatKeyAttestation(session: ChatSession): Promise<ChatKeyAttestation | null> {
  const s = storage();
  if (!s) return null;
  let raw: string | null;
  try { raw = s.getItem(ATTESTATION_STORAGE_PREFIX + session.address.toLowerCase()); } catch { return null; }
  if (!raw) return null;

  let parsed: ChatKeyAttestation | null;
  try { parsed = parseChatKeyAttestation(JSON.parse(raw)); } catch { return null; }
  if (!parsed) return null;

  if (parsed.address.toLowerCase() !== session.address.toLowerCase()) return null;
  if (parsed.boxKey !== keyHex(session.keypair.publicKey)) return null;
  const signer = await deriveLinkSigningKeypair(session.keypair);
  if (parsed.signKey !== keyHex(signer.publicKey)) return null;

  return parsed;
}

/**
 * Взять годное заверение с устройства, а если его нет — подписать и положить.
 *
 * ⚠️ ЗОВЁТСЯ ТОЛЬКО ПО ЧЕЛОВЕЧЕСКОМУ ДЕЙСТВИЮ (нажатие «предъявить арбитру»,
 * нажатие «заверить ключи»). Из автоматики — никогда: см. шапку файла про
 * петлю на Android.
 */
export async function ensureChatKeyAttestation(
  walletClient: WalletClient,
  session: ChatSession,
  publicClient?: PublicClient,
): Promise<ChatKeyAttestation> {
  const cached = await cachedChatKeyAttestation(session);
  if (cached) {
    const verdict = await verifyChatKeyAttestation(cached, publicClient);
    // `absent` у УЖЕ РАЗОБРАННОГО заверения означает ровно одно: доказать здесь
    // нечем (подпись не 65 байт, а цепи под рукой нет либо кода на адресе нет).
    // Переподписать — получить такую же непроверяемую подпись, заплатив ещё
    // одним окном кошелька; на каждом заходе — то есть вернуть окно в
    // автоматику (Л-3). Годным считается «лучшее, что этот кошелёк здесь
    // умеет». А вот `bad_signature` годным НЕ считается: цепь ответила
    // определённо «не она», и такое заверение надо менять.
    if (verdict === 'ok' || verdict === 'absent') return cached;
  }
  const fresh = await signChatKeyAttestation(walletClient, session);
  rememberChatKeyAttestation(fresh);
  return fresh;
}
