/**
 * chatKeyAttestation.test.ts — 4в-1, §15.2: связка «адрес ↔ ключи чата»,
 * заверенная КОШЕЛЬКОМ и проверяемая БЕЗ доверия к серверу.
 *
 * ⚠️ Подписи здесь НАСТОЯЩИЕ (viem-аккаунт из фиксированного ключа), а не
 * строки нужной длины — ровно по той причине, что названа в шапке
 * `chatSession.test.ts`: проверка спрашивает «эта подпись от ЭТОГО адреса?»,
 * и заготовка из повторяющихся hex-цифр такой проверки не переживёт, то есть
 * файл остался бы зелёным, проверяя не то.
 *
 * Кошелёк подделан минимально: объект с `account` и `signTypedData`, которые
 * зовут настоящий локальный аккаунт. Настоящий `WalletClient` в узле поднять
 * нечем, а нам нужен ровно этот кусок его поведения.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { WalletClient, PublicClient } from 'viem';
import { deriveChatKeypair } from './chatCrypto';
import { deriveLinkSigningKeypair } from './chatConversation';
import type { ChatSession } from './chatSession';
import {
  signChatKeyAttestation, verifyChatKeyAttestation, verifyChatKeyAttestationForKeys,
  parseChatKeyAttestation,
  ensureChatKeyAttestation, cachedChatKeyAttestation, rememberChatKeyAttestation,
  forgetChatKeyAttestation,
  ATTESTATION_MAX_AGE_MS, ATTESTATION_FUTURE_SKEW_MS, MAX_ATTESTATION_SIG_BYTES,
  type ChatKeyAttestation, type AttestationVerdict,
} from './chatKeyAttestation';
// Фикстура запретов формы. Импортируется НЕ ради красоты: type-check от её
// удаления молчит, а `npm test` — нет (мутация М30).
import {
  FORBIDDEN_SUBSTITUTIONS, EVERY_VERDICT, verdictsAreExhaustive,
} from './chatKeyAttestationTypeBans';
import { publishChatKeys, fetchPeerChatKeys } from '@/hooks/useChatSession';

const ALICE_ACCOUNT = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const BOB_ACCOUNT = privateKeyToAccount(`0x${'b0'.repeat(32)}`);
const ALICE = ALICE_ACCOUNT.address;
const BOB = BOB_ACCOUNT.address;

/** `0x${string}`, а не `string`: поля заверения теперь клеймёные (Л-10), и
 *  заготовка, отдающая `string`, не легла бы в `ChatKeyAttestation` (A5). */
function hexOf(bytes: Uint8Array): `0x${string}` {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s as `0x${string}`;
}

/** Подпись формы кошелька: 0x + 130 hex (65 байт r‖s‖v). */
function sigOf(marker: string): `0x${string}` {
  return ('0x' + marker.repeat(130).slice(0, 130).replace(/[^0-9a-f]/g, 'a')) as `0x${string}`;
}

async function sessionOf(address: `0x${string}`, marker: string): Promise<ChatSession> {
  return {
    keypair: await deriveChatKeypair(sigOf(marker)),
    address,
    origin: 'signature',
    walletKind: 'eoa',
    restored: true,
    persisted: true,
  };
}

interface FakeWallet {
  client: WalletClient;
  prompts: number;
  captured: unknown;
}

/** Кошелёк, подписывающий настоящим локальным аккаунтом. `override` —
 *  «кошелёк-контракт»: подпись переменной длины вместо 65 байт. */
function walletOf(
  account: typeof ALICE_ACCOUNT,
  override?: (args: unknown) => Promise<`0x${string}`>,
): FakeWallet {
  const w: FakeWallet = { client: null as unknown as WalletClient, prompts: 0, captured: null };
  w.client = {
    account: { address: account.address },
    async signTypedData(args: unknown) {
      w.prompts++;
      w.captured = args;
      if (override) return override(args);
      return account.signTypedData(args as never);
    },
  } as unknown as WalletClient;
  return w;
}

interface FakeChain {
  client: PublicClient;
  codeAsked: string[];
  sigAsked: number;
}

/**
 * Подставная цепь. `code` — что лежит по адресу (`undefined`/`'0x'` — кода нет,
 * счётный кошелёк). `answer` — что отвечает `isValidSignature`: магическое
 * значение, любое другое, или `'throw'` (узел не ответил).
 *
 * ⚠️ Заметь: подставной узел умеет ВРАТЬ — отвечать магическим значением на
 * адресе без кода. Так и надо: доказательство обязано опираться на код, а не на
 * слово узла (D3).
 */
function chainOf(opts: { code?: `0x${string}`; answer?: `0x${string}` | 'throw' }): FakeChain {
  const f: FakeChain = { client: null as unknown as PublicClient, codeAsked: [], sigAsked: 0 };
  f.client = {
    async getCode({ address }: { address: string }) {
      f.codeAsked.push(address.toLowerCase());
      return opts.code;
    },
    async readContract() {
      f.sigAsked++;
      if (opts.answer === undefined || opts.answer === 'throw') {
        throw new Error('узел не ответил (simulated)');
      }
      return opts.answer;
    },
  } as unknown as PublicClient;
  return f;
}

/** Общая для вкладок кладовая — обычная карта, как настоящий `localStorage`. */
function installStorage(): Map<string, string> {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    clear: () => map.clear(),
  };
  return map;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  installStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

/* ═══════════ A. заверение проверяется без сервера ═══════════ */

describe('заверение кошельком: связка адрес↔ключи', () => {
  it('A1 настоящая подпись над настоящими ключами — ok, и адрес сверяется без учёта регистра', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const wallet = walletOf(ALICE_ACCOUNT);

    const att = await signChatKeyAttestation(wallet.client, session);
    const signer = await deriveLinkSigningKeypair(session.keypair);

    expect(att.address).toBe(ALICE);
    expect(att.boxKey).toBe(hexOf(session.keypair.publicKey));
    expect(att.signKey).toBe(hexOf(signer.publicKey));
    expect(att.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(await verifyChatKeyAttestation(att)).toBe('ok');

    // Кошелёк отдаёт адрес с контрольной суммой, справочник хранит нижний
    // регистр. Регистрозависимое сравнение назвало бы одно и то же двумя
    // людьми — и заверение стало бы `wrong_address` у каждого второго.
    expect(await verifyChatKeyAttestation({
      ...att, address: ALICE.toLowerCase() as `0x${string}`,
    })).toBe('ok');
  });

  it('A2 сервер подменил boxKey — wrong_address, никогда ok', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const att = await signChatKeyAttestation(walletOf(ALICE_ACCOUNT).client, session);

    const tampered = { ...att, boxKey: '0x' + 'cc'.repeat(32) };
    const verdict = await verifyChatKeyAttestation(tampered);
    expect(verdict).not.toBe('ok');
    expect(verdict).toBe('wrong_address');
  });

  it('A3 сервер подменил signKey — wrong_address, никогда ok', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const att = await signChatKeyAttestation(walletOf(ALICE_ACCOUNT).client, session);

    const tampered = { ...att, signKey: '0x' + 'dd'.repeat(32) };
    const verdict = await verifyChatKeyAttestation(tampered);
    expect(verdict).not.toBe('ok');
    expect(verdict).toBe('wrong_address');
  });

  it('A4 сервер переписал адрес на чужой — wrong_address', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const att = await signChatKeyAttestation(walletOf(ALICE_ACCOUNT).client, session);
    expect(await verifyChatKeyAttestation({ ...att, address: BOB })).toBe('wrong_address');
  });

  it('A5 подписал ДРУГОЙ адрес той же длиной — wrong_address', async () => {
    // Ровно то нападение, ради которого §15.2 и написан: заверение, сочинённое
    // за собеседника. Подпись настоящая, форма безупречная, адрес чужой.
    const session = await sessionOf(ALICE, 'a1');
    const signer = await deriveLinkSigningKeypair(session.keypair);
    const forged: ChatKeyAttestation = {
      address: ALICE,
      boxKey: hexOf(session.keypair.publicKey),
      signKey: hexOf(signer.publicKey),
      issuedAt: Date.now(),
      signature: '0x00' as `0x${string}`, // перезапишем настоящей подписью Боба ниже
    };
    const bobsAtt = await signChatKeyAttestation(
      walletOf(BOB_ACCOUNT).client, { ...session, address: BOB },
    );
    expect(await verifyChatKeyAttestation({ ...forged, signature: bobsAtt.signature }))
      .toBe('wrong_address');
  });

  it('A6 подпись-мусор ровно 65 байт — не ok (доказать не смогли)', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const att = await signChatKeyAttestation(walletOf(ALICE_ACCOUNT).client, session);
    const verdict = await verifyChatKeyAttestation({
      ...att, signature: ('0x' + '00'.repeat(65)) as `0x${string}`,
    });
    // Оба исхода означают «не доказано» и оба честны: r=0 восстановление
    // отвергает (bad_signature), а признак чётности, который viem примет,
    // даёт чужой адрес (wrong_address). Запрещён ровно один ответ.
    expect(verdict).not.toBe('ok');
    expect(['bad_signature', 'wrong_address']).toContain(verdict);
  });

  it('A7 мусор на входе — вердикт malformed, а не падение', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const good = await signChatKeyAttestation(walletOf(ALICE_ACCOUNT).client, session);

    // ⚠️ `undefined`/`null` тут НЕТ намеренно: «поля нет» — это `absent`, и
    // проверяется отдельно (A13). Слить их с мусором значит назвать честного
    // человека, который ещё не заверял ключи, предъявителем подделки.
    const junk: unknown[] = [
      0, 'строка', [], {},
      { ...good, address: 'не адрес' },
      { ...good, boxKey: '0x' + '11'.repeat(31) }, // 31 байт
      { ...good, boxKey: '0X' + '11'.repeat(32) }, // верхний регистр
      { ...good, signKey: 42 },
      { ...good, issuedAt: 1.5 },
      { ...good, issuedAt: 0 },
      { ...good, issuedAt: '1700000000000' },
      { ...good, signature: 'нет' },
      { ...good, signature: '0x' },
      { ...good, signature: '0x' + 'ab'.repeat(513) }, // сверх потолка (512 руками)
    ];
    for (const value of junk) {
      expect(await verifyChatKeyAttestation(value), JSON.stringify(value)).toBe('malformed');
      expect(parseChatKeyAttestation(value)).toBeNull();
    }
  });

  it('A8 кошелёк-контракт без клиента цепи — absent, а не malformed и не ok', async () => {
    // Честная деградация Л-2: подпись не 65 байт проверяется только вызовом на
    // цепь, а клиент цепи необязателен. Ответ — «доказательства нет» (`absent`),
    // и это ДРУГОЕ слово, чем «мусор»: человек ничего плохого не сделал.
    // Молчаливое `ok` здесь было бы той самой ложью, которую проект называет
    // главным классом промаха.
    const session = await sessionOf(ALICE, 'a1');
    const wallet = walletOf(ALICE_ACCOUNT, async () => ('0x' + 'ab'.repeat(130)) as `0x${string}`);
    const att = await signChatKeyAttestation(wallet.client, session);
    expect(att.signature).toHaveLength(2 + 260);
    expect(await verifyChatKeyAttestation(att)).toBe('absent');
    // Форма при этом безупречна — разбор проходит, вердикт про доказательство.
    expect(parseChatKeyAttestation(att)).not.toBeNull();
  });

  it('A9 старое заверение — expired; старое И с подменёнными ключами — wrong_address', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const wallet = walletOf(ALICE_ACCOUNT);
    const att = await signChatKeyAttestation(wallet.client, session);

    const old = Date.now() - ATTESTATION_MAX_AGE_MS - 60_000;
    const reissued = await (async () => {
      // Пересобрать заверение с прежней датой можно только заново подписав:
      // дата входит в подписанную структуру, и правка поля рвёт подпись.
      const s = { ...session };
      vi.spyOn(Date, 'now').mockReturnValue(old);
      try { return await signChatKeyAttestation(wallet.client, s); }
      finally { vi.restoreAllMocks(); }
    })();

    expect(await verifyChatKeyAttestation(reissued)).toBe('expired');

    // ⚠️ ПОРЯДОК: срок проверяется ПОСЛЕ подписи. Иначе подделка на старую
    // дату отвечалась бы «просрочено» — то есть подделку прятал бы срок.
    expect(await verifyChatKeyAttestation({ ...reissued, boxKey: '0x' + 'ee'.repeat(32) }))
      .toBe('wrong_address');

    expect(await verifyChatKeyAttestation(att)).toBe('ok'); // свежее по-прежнему годно
  });

  it('A10 заверение из будущего дальше допуска — expired', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const wallet = walletOf(ALICE_ACCOUNT);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ATTESTATION_FUTURE_SKEW_MS + 600_000);
    const att = await signChatKeyAttestation(wallet.client, session);
    vi.restoreAllMocks();
    expect(await verifyChatKeyAttestation(att)).toBe('expired');
  });

  it('A11 кошелёк подписывает РОВНО одну структуру — записана здесь руками', async () => {
    // ⚠️ ЗАМОК ТЕКСТОВЫЙ, И ЭТО СКАЗАНО ВСЛУХ. Он сторожит не поведение, а
    // обещание совместимости: смена домена/типа/purpose делает все прежние
    // заверения непроверяемыми, а подпись и проверка внутри модуля сойдутся
    // между собой при любом содержимом. Поведенческого замка на это нет и быть
    // не может — потому структура и записана здесь дословно.
    const session = await sessionOf(ALICE, 'a1');
    const wallet = walletOf(ALICE_ACCOUNT);
    const att = await signChatKeyAttestation(wallet.client, session);
    const captured = wallet.captured as {
      domain: unknown; types: unknown; primaryType: string; message: Record<string, unknown>;
    };

    expect(captured.domain).toEqual({ name: 'Hexseal', version: '1' });
    expect(captured.types).toEqual({
      ChatKeyAttestation: [
        { name: 'purpose', type: 'string' },
        { name: 'boxKey', type: 'bytes32' },
        { name: 'signKey', type: 'bytes32' },
        { name: 'issuedAt', type: 'uint64' },
      ],
    });
    expect(captured.primaryType).toBe('ChatKeyAttestation');
    expect(captured.primaryType).not.toBe('ChatKey'); // не путать с ключом чата
    expect(captured.message.purpose).toBe('hexseal.chat.key.attestation.v1');
    expect(captured.message.boxKey).toBe(att.boxKey);
    expect(captured.message.signKey).toBe(att.signKey);
    expect(captured.message.issuedAt).toBe(BigInt(att.issuedAt));
    // chainId/verifyingContract не включены — по той же причине, что у
    // CHAT_KEY_TYPED_DATA (chatCrypto.ts).
    expect(captured.domain).not.toHaveProperty('chainId');
  });

  it('A12 кошелёк подключён другим адресом — отказ, а не заверение, которое никто не проверит', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const wallet = walletOf(BOB_ACCOUNT); // подписывать будет Боб
    await expect(signChatKeyAttestation(wallet.client, session)).rejects.toThrow(TypeError);
    expect(wallet.prompts, 'окно кошелька всё-таки открыли').toBe(0);
  });

  it('A13 заверения НЕТ вовсе — absent, и это не мусор', async () => {
    // Ровно тот случай первого дня: вторая сторона ключи объявила, а «заверить»
    // не нажимала — поля в записи справочника просто нет. Ответ обязан звучать
    // «заверения нет», а не «пришёл мусор»: одно винит порядок выкатки, другое
    // винит человека (Л-2б).
    expect(await verifyChatKeyAttestation(undefined)).toBe('absent');
    expect(await verifyChatKeyAttestation(null)).toBe('absent');
    // Форма — по-прежнему «не заверение»: `absent` живёт в вердикте, а не в разборе.
    expect(parseChatKeyAttestation(undefined)).toBeNull();
    expect(parseChatKeyAttestation(null)).toBeNull();
  });

  it('A14 потолок подписи — 512, число записано РУКАМИ', () => {
    // ⚠️ Исправление 12 договора. Ожидаемое число здесь записано руками, а из
    // модуля берётся только измеряемое — иначе замер сверял бы значение с самим
    // собой и поехал бы за боевой константой молча. Вторая половина того же
    // числа заперта на сервере (R17): два места обязаны сходиться ЧИСЛОМ, и
    // расхождение стоит человеку объявления ключа целиком (Л-5).
    expect(MAX_ATTESTATION_SIG_BYTES, 'потолок разошёлся с сервером').toBe(512);
  });

  it('A15 словарь вердиктов — семь слов, и фикстура запретов на месте', () => {
    // Замок против выпотрошенной фикстуры: type-check от её удаления МОЛЧИТ
    // (файла нет — проверять нечего), а этот тест краснеет ошибкой загрузки.
    expect(FORBIDDEN_SUBSTITUTIONS).toBe(4);
    expect(EVERY_VERDICT).toEqual([
      'ok', 'absent', 'malformed', 'bad_signature', 'wrong_address', 'wrong_keys', 'expired',
    ]);
    // Разбор по вердиктам исчерпывающий: новый вердикт без обработки не
    // компилируется (`never` в фикстуре), а здесь видно, что каждый доезжает.
    for (const v of EVERY_VERDICT) expect(verdictsAreExhaustive(v)).toBe(v);
  });
});

/* ═══════ D. кошельки-контракты и «не те ключи» (исправление 5, договор v4) ═══════ */

describe('заверение кошелька-контракта проверяется цепью', () => {
  const MAGIC = '0x1626ba7e' as `0x${string}`;

  /** Заверение с подписью «не 65 байт» — так подписывает умный кошелёк. */
  async function contractAtt(): Promise<ChatKeyAttestation> {
    const session = await sessionOf(ALICE, 'a1');
    const wallet = walletOf(ALICE_ACCOUNT, async () => ('0x' + 'ab'.repeat(130)) as `0x${string}`);
    return signChatKeyAttestation(wallet.client, session);
  }

  it('D1 развёрнутый кошелёк-контракт: цепь сказала «годна» — ok', async () => {
    // Без этой ветки два рода кошельков из четырёх предъявить не могут ВОВСЕ, и
    // §1 замысла для них — ложь (исправление 5 договора v2).
    const att = await contractAtt();
    const chain = chainOf({ code: '0x60806040', answer: MAGIC });
    expect(await verifyChatKeyAttestation(att, chain.client)).toBe('ok');
    expect(chain.codeAsked, 'код по адресу не спросили').toEqual([ALICE.toLowerCase()]);
    expect(chain.sigAsked).toBe(1);
  });

  it('D2 цепь сказала «не годна» — bad_signature, не absent', async () => {
    // Здесь ответ определённый: контракт посмотрел на подпись и отказал. Выдать
    // это за «доказательства нет» значило бы прятать подделку под деградацию.
    const att = await contractAtt();
    const chain = chainOf({ code: '0x60806040', answer: '0xffffffff' as `0x${string}` });
    expect(await verifyChatKeyAttestation(att, chain.client)).toBe('bad_signature');
  });

  it('D3 счётный кошелёк (кода нет), а узел ВРЁТ магическим значением — absent', async () => {
    // Счётный кошелёк не может проверить ничего: у него нет кода. Узел,
    // отвечающий тут `0x1626ba7e`, либо врёт, либо смотрит не в ту сеть.
    // Поэтому код спрашивается ПЕРВЫМ, и вызова подписи не происходит вовсе.
    const att = await contractAtt();
    for (const code of [undefined, '0x' as `0x${string}`]) {
      const chain = chainOf({ code, answer: MAGIC });
      expect(await verifyChatKeyAttestation(att, chain.client)).toBe('absent');
      expect(chain.sigAsked, 'спросили подпись у адреса без кода').toBe(0);
    }
  });

  it('D4 цепь не ответила — absent, а не ok и не падение', async () => {
    const att = await contractAtt();
    const chain = chainOf({ code: '0x60806040', answer: 'throw' });
    expect(await verifyChatKeyAttestation(att, chain.client)).toBe('absent');
  });

  it('D5 Safe с одним владельцем: 65 байт, а адрес чужой — цепь спасает, но не топит', async () => {
    // Подписал ВЛАДЕЛЕЦ (Боб), заверение про кошелёк (тут его роль играет
    // адрес Алисы). Арифметика не сходится — и это законно для рода 2.
    const session = await sessionOf(ALICE, 'a1');
    const ownerAtt = await signChatKeyAttestation(
      walletOf(BOB_ACCOUNT).client, { ...session, address: BOB },
    );
    const att: ChatKeyAttestation = { ...ownerAtt, address: ALICE };

    // Без цепи — честное «подписал не тот».
    expect(await verifyChatKeyAttestation(att)).toBe('wrong_address');
    // С цепью, подтвердившей принадлежность, — ok.
    expect(await verifyChatKeyAttestation(att, chainOf({ code: '0x6080', answer: MAGIC }).client))
      .toBe('ok');
    // ⚠️ А вот УТЯЖЕЛИТЬ цепь не может: узел, сказавший «не годна», не отменяет
    // того, что местная арифметика не сошлась — вердикт прежний. Иначе
    // моргнувший узел портил бы заверения обычных кошельков.
    expect(await verifyChatKeyAttestation(att, chainOf({ code: '0x6080', answer: 'throw' }).client))
      .toBe('wrong_address');
    // И обычное заверение Алисы цепь не портит и не спрашивает вовсе.
    const own = await signChatKeyAttestation(walletOf(ALICE_ACCOUNT).client, session);
    const idle = chainOf({ code: '0x6080', answer: '0xffffffff' as `0x${string}` });
    expect(await verifyChatKeyAttestation(own, idle.client)).toBe('ok');
    expect(idle.codeAsked, 'обычный кошелёк потащили в сеть').toEqual([]);
  });

  it('D6 заверены ДРУГИЕ ключи — wrong_keys, а не ok', async () => {
    // Тот случай, который голая проверка увидеть не может: заверение
    // настоящее, подписант тот, но заверены ключи ДРУГОЙ пары — например,
    // прежней, оставленной на записи по ошибке. Для арбитра это не «годно».
    const session = await sessionOf(ALICE, 'a1');
    const att = await signChatKeyAttestation(walletOf(ALICE_ACCOUNT).client, session);
    const otherSigner = await deriveLinkSigningKeypair((await sessionOf(ALICE, 'b2')).keypair);

    expect(await verifyChatKeyAttestationForKeys(att, {
      boxKey: att.boxKey, signKey: att.signKey,
    })).toBe('ok');

    const verdict: AttestationVerdict = await verifyChatKeyAttestationForKeys(att, {
      boxKey: att.boxKey, signKey: hexOf(otherSigner.publicKey),
    });
    expect(verdict).toBe('wrong_keys');
    // ⚠️ И голая проверка на тех же данных даёт `ok` — именно поэтому сверка
    // ключей обязана быть отдельной дверью, а не «не забыть сравнить».
    expect(await verifyChatKeyAttestation(att)).toBe('ok');
  });

  it('D7 порядок: сначала «настоящее ли», потом «про те ли ключи»', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const signer = await deriveLinkSigningKeypair(session.keypair);
    const other = hexOf((await deriveLinkSigningKeypair((await sessionOf(ALICE, 'b2')).keypair)).publicKey);

    // (а) ПОДДЕЛКА, заверяющая чужие ключи, — это подделка, а не «не те ключи».
    // Наоборот — и сочинённое за собеседника заверение звучало бы как чужая
    // честная ошибка.
    const bobsAtt = await signChatKeyAttestation(
      walletOf(BOB_ACCOUNT).client, { ...session, address: BOB },
    );
    const forged: ChatKeyAttestation = { ...bobsAtt, address: ALICE };
    expect(await verifyChatKeyAttestationForKeys(forged, {
      boxKey: hexOf(session.keypair.publicKey), signKey: other,
    })).toBe('wrong_address');

    // (б) ПРОСРОЧЕННОЕ и про другие ключи — `wrong_keys`: «не про эти ключи
    // вовсе» сообщает арбитру больше, чем «просрочено», и обе правды честны.
    const wallet = walletOf(ALICE_ACCOUNT);
    const old = Date.now() - ATTESTATION_MAX_AGE_MS - 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(old);
    const stale = await signChatKeyAttestation(wallet.client, session);
    vi.restoreAllMocks();

    expect(await verifyChatKeyAttestation(stale)).toBe('expired');
    expect(await verifyChatKeyAttestationForKeys(stale, {
      boxKey: hexOf(session.keypair.publicKey), signKey: other,
    })).toBe('wrong_keys');
    expect(await verifyChatKeyAttestationForKeys(stale, {
      boxKey: hexOf(session.keypair.publicKey), signKey: hexOf(signer.publicKey),
    })).toBe('expired');
  });

  /*
   * ⚠️ D8-D12: договор об именах v4 сделал `expected` полями НЕОБЯЗАТЕЛЬНЫМИ
   * (`{ address?, boxKey?, signKey? }`) — арбитр знает только подписной ключ,
   * названный кадром, а боксовый не знает никак. Черновик задачи, из которого
   * списаны D6/D7 выше, требовал оба поля обязательными; этих пяти тестов там
   * не было вовсе, и они добавлены здесь, потому что план главнее кода задачи,
   * а три следствия перехода на optional-поля («сверяет только приехавшее»,
   * «хотя бы один ключ назван, иначе громкий отказ», «address не сверяется»)
   * были явно названы как обязательные к замеру.
   */

  it('D8 пустой объект ожидаемых ключей — громкий отказ, а не тихий голый вердикт', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const att = await signChatKeyAttestation(walletOf(ALICE_ACCOUNT).client, session);
    // Компилируется (все поля `expected` необязательны), но сверять нечем —
    // должно бросить, а не молча вернуть `verifyChatKeyAttestation(att)`.
    await expect(verifyChatKeyAttestationForKeys(att, {})).rejects.toThrow(TypeError);
  });

  it('D9 назван только address, ни одного ключа — тот же громкий отказ', async () => {
    // `address` — не ключ. Названный один он не удовлетворяет «хотя бы один
    // ключ назван»: иначе вызывающий, забывший boxKey/signKey, но случайно
    // передавший адрес, получил бы тихий голый вердикт вместо отказа.
    const session = await sessionOf(ALICE, 'a1');
    const att = await signChatKeyAttestation(walletOf(ALICE_ACCOUNT).client, session);
    await expect(verifyChatKeyAttestationForKeys(att, { address: BOB })).rejects.toThrow(TypeError);
  });

  it('D10 назван только boxKey — сверяется только он, signKey не читается вовсе', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const att = await signChatKeyAttestation(walletOf(ALICE_ACCOUNT).client, session);

    // Совпадает — ok, хотя signKey вообще не назван.
    expect(await verifyChatKeyAttestationForKeys(att, { boxKey: att.boxKey })).toBe('ok');
    // Не совпадает — wrong_keys, опять же без единого слова про signKey.
    expect(await verifyChatKeyAttestationForKeys(att, { boxKey: '0x' + 'ff'.repeat(32) as `0x${string}` }))
      .toBe('wrong_keys');
  });

  it('D11 назван только signKey — сверяется только он, boxKey не читается вовсе', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const att = await signChatKeyAttestation(walletOf(ALICE_ACCOUNT).client, session);

    expect(await verifyChatKeyAttestationForKeys(att, { signKey: att.signKey })).toBe('ok');
    expect(await verifyChatKeyAttestationForKeys(att, { signKey: '0x' + 'ff'.repeat(32) as `0x${string}` }))
      .toBe('wrong_keys');
  });

  it('D12 expected.address назван и НЕВЕРЕН, но ключи верны — всё равно ok: адрес этим модулем не сверяется', async () => {
    // Задача 1 отвечает за связку «ключи ↔ заверение», а не за «это тот самый
    // человек, кого я ждал» — то, что читает поле `address`, ни разу не
    // прочитанное в её теле, оставило бы читателя с непроверяющей проверкой.
    const session = await sessionOf(ALICE, 'a1');
    const att = await signChatKeyAttestation(walletOf(ALICE_ACCOUNT).client, session);
    expect(await verifyChatKeyAttestationForKeys(att, {
      address: BOB, boxKey: att.boxKey, signKey: att.signKey,
    })).toBe('ok');
  });
});

/* ═══════════ B. кладовая и одно окно подписи ═══════════ */

describe('кладовая заверения', () => {
  it('B1 положили — читается; ключи сеанса другие — НЕ читается', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const att = await signChatKeyAttestation(walletOf(ALICE_ACCOUNT).client, session);
    expect(rememberChatKeyAttestation(att)).toBe(true);
    expect(await cachedChatKeyAttestation(session)).toEqual(att);

    // Тот же адрес, ДРУГОЙ ключ переписки (вошёл по коду восстановления, сменил
    // устройство). Заверение прежней пары к этим ключам не относится — и уехав
    // на сервер, оно отменило бы объявление ключа целиком (Л-5).
    const other = await sessionOf(ALICE, 'b2');
    expect(await cachedChatKeyAttestation(other)).toBeNull();
  });

  it('B2 кладовой нет (приватный режим) — null и false, без падения', async () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    const session = await sessionOf(ALICE, 'a1');
    const att = await signChatKeyAttestation(walletOf(ALICE_ACCOUNT).client, session);
    expect(rememberChatKeyAttestation(att)).toBe(false);
    expect(await cachedChatKeyAttestation(session)).toBeNull();
  });

  it('B3 мусор в кладовой — null, а не падение', async () => {
    const map = installStorage();
    const session = await sessionOf(ALICE, 'a1');
    for (const junk of ['{', 'null', '[]', '{"address":"нет"}']) {
      map.set(`hexseal_chat_attestation_${ALICE.toLowerCase()}`, junk);
      expect(await cachedChatKeyAttestation(session)).toBeNull();
    }
  });

  it('B4 ensure не просит кошелёк второй раз', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const wallet = walletOf(ALICE_ACCOUNT);
    const first = await ensureChatKeyAttestation(wallet.client, session);
    const second = await ensureChatKeyAttestation(wallet.client, session);
    expect(second).toEqual(first);
    expect(wallet.prompts, 'одно окно подписи на устройство — обещание нарушено').toBe(1);
  });

  it('B5 кошелёк-контракт без цепи: ensure ТОЖЕ просит один раз, хотя вердикт absent', async () => {
    // Л-4: считать `absent` негодным значит просить подпись при каждом заходе —
    // то есть вернуть окно кошелька в автоматику (Л-3). Переподпись даст ровно
    // такую же непроверяемую здесь подпись, заплатив ещё одним окном.
    const session = await sessionOf(ALICE, 'a1');
    const wallet = walletOf(ALICE_ACCOUNT, async () => ('0x' + 'ab'.repeat(130)) as `0x${string}`);
    await ensureChatKeyAttestation(wallet.client, session);
    await ensureChatKeyAttestation(wallet.client, session);
    expect(wallet.prompts).toBe(1);
  });

  it('B6 forget убирает — следующий ensure подписывает заново', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const wallet = walletOf(ALICE_ACCOUNT);
    await ensureChatKeyAttestation(wallet.client, session);
    forgetChatKeyAttestation(ALICE);
    expect(await cachedChatKeyAttestation(session)).toBeNull();
    await ensureChatKeyAttestation(wallet.client, session);
    expect(wallet.prompts).toBe(2);
  });

  it('B7 цепь сказала «не она» — ensure переподписывает, а absent не трогает', async () => {
    // `bad_signature` — единственный вердикт, при котором переподпись имеет
    // смысл: цепь ответила определённо. Считать негодным ещё и `absent` значит
    // вернуть окно в автоматику (B5); не считать негодным `bad_signature` —
    // возить негодное заверение вечно.
    const session = await sessionOf(ALICE, 'a1');
    const wallet = walletOf(ALICE_ACCOUNT, async () => ('0x' + 'ab'.repeat(130)) as `0x${string}`);
    const chain = chainOf({ code: '0x60806040', answer: '0xffffffff' as `0x${string}` });
    await ensureChatKeyAttestation(wallet.client, session, chain.client);
    await ensureChatKeyAttestation(wallet.client, session, chain.client);
    expect(wallet.prompts).toBe(2);
  });
});

/* ═══════════ C. публикация и чтение справочника ═══════════ */

describe('справочник возит заверение', () => {
  /** Сервер, который запоминает тела и отвечает по заданному правилу. */
  function stubServer(reply: (body: Record<string, unknown>) => Response) {
    const bodies: Record<string, unknown>[] = [];
    const fn = vi.fn(async (_u: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return reply(body);
    });
    vi.stubGlobal('fetch', fn);
    return { bodies, fn };
  }

  it('C1 публикация возит заверение из кладовой', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const signer = await deriveLinkSigningKeypair(session.keypair);
    const att = await signChatKeyAttestation(walletOf(ALICE_ACCOUNT).client, session);
    rememberChatKeyAttestation(att);

    const srv = stubServer(() => new Response('{}', { status: 200 }));
    await publishChatKeys('v1.pass', session);

    expect(srv.bodies).toHaveLength(1);
    expect(srv.bodies[0]).toEqual({
      boxKey: hexOf(session.keypair.publicKey),
      signKey: hexOf(signer.publicKey),
      attestation: att,
    });
  });

  it('C2 заверения нет — тело РОВНО как раньше, поля вовсе нет', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const signer = await deriveLinkSigningKeypair(session.keypair);
    const srv = stubServer(() => new Response('{}', { status: 200 }));
    await publishChatKeys('v1.pass', session);
    expect(srv.bodies[0]).toEqual({
      boxKey: hexOf(session.keypair.publicKey),
      signKey: hexOf(signer.publicKey),
    });
    expect(Object.keys(srv.bodies[0])).not.toContain('attestation');
  });

  it('C3 устаревшее заверение НЕ уезжает, а публикация всё равно проходит', async () => {
    const stale = await signChatKeyAttestation(
      walletOf(ALICE_ACCOUNT).client, await sessionOf(ALICE, 'b2'),
    );
    rememberChatKeyAttestation(stale);

    const session = await sessionOf(ALICE, 'a1'); // ключи ДРУГИЕ
    const srv = stubServer(() => new Response('{}', { status: 200 }));
    await publishChatKeys('v1.pass', session);

    expect(Object.keys(srv.bodies[0])).not.toContain('attestation');
  });

  it('C4a справочник отверг заверение — ключи объявлены вторым запросом без него', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const att = await signChatKeyAttestation(walletOf(ALICE_ACCOUNT).client, session);
    rememberChatKeyAttestation(att);

    const srv = stubServer((body) => body.attestation
      ? new Response(JSON.stringify({ error: 'nope', code: 'invalid_attestation' }), { status: 400 })
      : new Response('{}', { status: 200 }));

    await expect(publishChatKeys('v1.pass', session)).resolves.toBeUndefined();
    expect(srv.bodies).toHaveLength(2);
    expect(Object.keys(srv.bodies[1])).not.toContain('attestation');
  });

  it('C4b негодное заверение снимается с устройства', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const att = await signChatKeyAttestation(walletOf(ALICE_ACCOUNT).client, session);
    rememberChatKeyAttestation(att);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    stubServer((body) => body.attestation
      ? new Response(JSON.stringify({ code: 'invalid_attestation' }), { status: 400 })
      : new Response('{}', { status: 200 }));
    await publishChatKeys('v1.pass', session);

    expect(await cachedChatKeyAttestation(session), 'негодное осталось и поедет снова').toBeNull();
    expect(warn, 'сломалось молча — человек решит, что всё прошло хорошо').toHaveBeenCalled();
  });

  it('C5 отказ НЕ про заверение — как раньше: код, статус, один запрос', async () => {
    const session = await sessionOf(ALICE, 'a1');
    const att = await signChatKeyAttestation(walletOf(ALICE_ACCOUNT).client, session);
    rememberChatKeyAttestation(att);

    const srv = stubServer(() => new Response(
      JSON.stringify({ error: 'Directory unavailable', code: 'directory_unavailable' }),
      { status: 503 },
    ));
    await expect(publishChatKeys('v1.pass', session)).rejects.toMatchObject({
      code: 'directory_unavailable', status: 503,
    });
    expect(srv.bodies).toHaveLength(1);
  });

  it('C6 чтение отдаёт заверение собеседника и историю заверений, мусор не роняет остальное', async () => {
    const peer = await sessionOf(BOB, 'b0');
    const att = await signChatKeyAttestation(walletOf(BOB_ACCOUNT).client, peer);
    const older = { ...att, boxKey: '0x' + '11'.repeat(32) };

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      address: BOB.toLowerCase(),
      boxKey: att.boxKey, signKey: att.signKey,
      updatedAt: 1, keyChangeCount: 2,
      attestation: att,
      history: [
        { boxKey: '0x' + '11'.repeat(32), signKey: '0x' + '22'.repeat(32), replacedAt: 2, attestation: older },
        { boxKey: '0x' + '33'.repeat(32), replacedAt: 1, attestation: { сломано: true } },
      ],
    }), { status: 200 })));

    const keys = await fetchPeerChatKeys(BOB);
    expect(keys.attestation).toEqual(att);
    expect(keys.attestationHistory).toEqual([older]); // битое звено выброшено поодиночке
    expect(keys.boxKey).toHaveLength(32); // остальное цело
  });
});
