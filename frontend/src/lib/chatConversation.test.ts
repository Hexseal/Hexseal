import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { keccak256, concat, stringToBytes, hexToBytes, toHex } from 'viem';
import { deriveChatKeypair } from './chatCrypto';
import { GENESIS_HASH, buildLink, linkPreimage, verifyChain, type ChainLink } from './chatChain';
import { packEnvelope, type ChatPayload } from './chatEnvelope';
import type { ChatSession } from './chatSession';
import {
  FRAME_VERSION,
  FRAME_HEADER_LEN,
  LINK_SIGNATURE_LEN,
  LINK_SIGNING_PUBLIC_KEY_LEN,
  MAX_LINK_SEQ,
  MAX_BURNED_SEQS,
  NOT_STORED_STATUSES,
  NOT_STORED_CODES,
  CONVERSATION_LOCK_TIMEOUT_MS,
  LINK_SIGNING_KEY_CONTEXT,
  LINK_SIGNATURE_DOMAIN,
  MESSAGE_BODY_CONTEXT,
  deriveLinkSigningKeypair,
  linkSignaturePreimage,
  messageBodyHash,
  encodeFrame,
  decodeFrame,
  sendMessage,
  receiveBags,
  readConversationHead,
  listBurnedSeqs,
  forgetConversationHead,
  _resetConversationMemoryForTest,
  type SentMessage,
  type IncomingBag,
} from './chatConversation';

// ─── Заготовки берут данные в том виде, в каком они приходят из жизни ──────
//
// Адреса — С КОНТРОЛЬНОЙ СУММОЙ (заглавные внутри), ровно как отдаёт
// `useAccount()`. Правило куплено находкой, где 650 зелёных тестов означали
// полностью нерабочий вход: заготовка была строчными, а кошелёк отдаёт
// смешанным регистром. Здесь это несёт: звено лоукейсит `sender` (buildLink),
// а сервер свидетельствует отправителя строчными — сверка «звено против
// свидетельства сервера» на регистре и ломалась бы.

const ALICE = '0x760F07367888C62f7c2Dfb619A5e534132855ce5' as const;
const BOB   = '0x268dCfa7ab0DC134d01C5cBcAa7d2834d6dD0f0f' as const;
const CAROL = '0x2e7a7A0515bfDC0006A812EBb3E55d32800Bc660' as const;

/** Настоящая по форме ECDSA-подпись: 0x + 130 hex-цифр (65 байт r‖s‖v).
 *  `deriveChatKeypair` проверяет форму на исполнении, '0xdeadbeef' не доедет. */
function signatureOf(marker: string): `0x${string}` {
  const body = marker.repeat(130).slice(0, 130).replace(/[^0-9a-f]/g, 'a');
  return `0x${body}` as `0x${string}`;
}

const hex = (b: Uint8Array) => toHex(b);

/** Сеанс — обычный объект (`ChatSession` — простая структура). Ключ выводится
 *  НАСТОЯЩИМ `deriveChatKeypair`, а не набивается байтами: подписная пара
 *  выводится ИЗ него, и подставной ключ спрятал бы ошибку вывода. */
async function makeSession(marker: string, address: `0x${string}`): Promise<ChatSession> {
  const keypair = await deriveChatKeypair(signatureOf(marker));
  return {
    keypair,
    address,
    origin: 'signature',
    walletKind: 'eoa',
    restored: true,
    persisted: true,
  };
}

// ─── Поддельный IndexedDB ─────────────────────────────────────────────────
//
// Среда тестов — node, настоящего IndexedDB здесь нет. Подделка моделирует то,
// ради чего он выбран: транзакция атомарна (записи копятся и применяются одним
// куском на `oncomplete`, откат не оставляет половины) и отказ включается явным
// флагом, а не «успех по умолчанию». `_disk` открыт тесту напрямую — смотрим,
// что реально осело, а не верим возвращённому значению.

interface FakeControl { failPut?: boolean; failGet?: boolean; failOpen?: boolean }

type Handler = ((ev: unknown) => void) | null;

class FakeRequest {
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
  result: unknown = undefined;
  error: unknown = null;
}

function makeFakeIndexedDB(control: FakeControl = {}) {
  const disk = new Map<string, Map<string, unknown>>();
  let dbVersion = 0;

  class FakeTransaction {
    oncomplete: Handler = null;
    onerror: Handler = null;
    onabort: Handler = null;
    private pending = 0;
    private settled = false;
    private staged: Array<() => void> = [];

    objectStore(name: string) { return new FakeObjectStore(name, this); }

    run(op: () => unknown, forcedError?: Error): FakeRequest {
      const req = new FakeRequest();
      this.pending += 1;
      setTimeout(() => {
        if (this.settled) return;
        this.pending -= 1;
        if (forcedError) {
          req.error = forcedError;
          req.onerror?.({ target: req });
          this.abortWith(forcedError);
          return;
        }
        try { req.result = op(); } catch (err) {
          req.error = err;
          req.onerror?.({ target: req });
          this.abortWith(err as Error);
          return;
        }
        req.onsuccess?.({ target: req });
        this.maybeComplete();
      }, 0);
      return req;
    }

    stage(apply: () => void): void { this.staged.push(apply); }

    private maybeComplete(): void {
      if (this.settled || this.pending > 0) return;
      setTimeout(() => {
        if (this.settled || this.pending > 0) return;
        this.settled = true;
        for (const apply of this.staged) apply();
        this.oncomplete?.({ target: this });
      }, 0);
    }

    private abortWith(err: Error): void {
      if (this.settled) return;
      this.settled = true;
      this.staged.length = 0; // откат: ничего из транзакции не осело
      this.onerror?.({ target: { error: err } });
      this.onabort?.({ target: { error: err } });
    }

    abort(): void { this.abortWith(new Error('AbortError')); }
  }

  class FakeObjectStore {
    constructor(private name: string, private tx: FakeTransaction) {}
    get(key: string): FakeRequest {
      return this.tx.run(() => {
        const found = disk.get(this.name)?.get(key);
        return found === undefined ? undefined : structuredClone(found);
      }, control.failGet ? new Error('read failed') : undefined);
    }
    put(value: unknown, key: string): FakeRequest {
      const cloned = structuredClone(value);
      return this.tx.run(() => {
        this.tx.stage(() => {
          let store = disk.get(this.name);
          if (!store) { store = new Map(); disk.set(this.name, store); }
          store.set(key, cloned);
        });
        return key;
      }, control.failPut ? Object.assign(new Error('quota'), { name: 'QuotaExceededError' }) : undefined);
    }
    delete(key: string): FakeRequest {
      return this.tx.run(() => { this.tx.stage(() => { disk.get(this.name)?.delete(key); }); return undefined; });
    }
  }

  class FakeDatabase {
    objectStoreNames = { contains: (name: string) => disk.has(name) };
    createObjectStore(name: string) { if (!disk.has(name)) disk.set(name, new Map()); return {}; }
    transaction(_names: string[] | string, _mode?: string) { return new FakeTransaction(); }
    close() {}
  }

  return {
    _disk: disk,
    open(_name: string, version: number): FakeRequest {
      const req = new FakeRequest();
      setTimeout(() => {
        if (control.failOpen) {
          req.error = new Error('open failed');
          req.onerror?.({ target: req });
          return;
        }
        const db = new FakeDatabase();
        req.result = db;
        if (dbVersion < version) { dbVersion = version; req.onupgradeneeded?.({ target: req }); }
        req.onsuccess?.({ target: req });
      }, 0);
      return req;
    },
  };
}

const g = globalThis as { indexedDB?: unknown; localStorage?: unknown };

let fakeIdb: ReturnType<typeof makeFakeIndexedDB>;
let warn: ReturnType<typeof vi.spyOn>;

// ─── Поддельный склад: НАСТОЯЩИЕ `Response`, не объекты-обманки ───────────
//
// Правило плана: ответы сервера — настоящие `Response`. `chatTransport.putBag`
// читает `res.ok`, `res.json()`, `res.headers.get('retry-after')` — заглушка
// в виде литерала прошла бы мимо половины из этого.

interface FetchStub {
  calls: Array<{ url: string; method: string; body: Uint8Array | null }>;
  /** Что отвечать на следующий PUT: по умолчанию 200 + ключ. */
  next: () => Response | Promise<Response>;
}

function installFetchStub(): FetchStub {
  let counter = 0;
  const stub: FetchStub = {
    calls: [],
    next: () => new Response(JSON.stringify({ key: `0x00/bag-${++counter}.bin` }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  };
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body instanceof Uint8Array ? init.body : null;
    stub.calls.push({ url, method: init?.method ?? 'GET', body });
    return stub.next();
  });
  return stub;
}

const PASS = 'v1.dGVzdC5wYXNz.mac';

beforeEach(() => {
  fakeIdb = makeFakeIndexedDB();
  g.indexedDB = fakeIdb;
  // Запасная голова живёт в памяти МОДУЛЯ и переживает подмену хранилища:
  // без этой уборки нумерация одного кейса протекала в соседний (поймано
  // после правки «память читается, а не только пишется»).
  _resetConversationMemoryForTest();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete g.indexedDB;
  warn.mockRestore();
  vi.unstubAllGlobals();
});

// ═══════════════════════════════════════════════════════════════════════════
// Подписная пара: отдельный под-ключ, а не то же семя второму алгоритму
// ═══════════════════════════════════════════════════════════════════════════

describe('подписная пара звена', () => {
  /** Закрытый ключ шифрования, записанный руками: байты 1..32. Не берётся из
   *  проверяемого модуля — иначе золотой вектор проверял бы сам себя. */
  const PRIV = new Uint8Array(32).map((_, i) => i + 1);
  const PUB_STUB = new Uint8Array(32).map((_, i) => 200 - i);

  // Золотые векторы посчитаны НЕЗАВИСИМЫМ путём (ethers.keccak256 +
  // libsodium напрямую, вне этого модуля) и записаны сюда РУКАМИ. Тот же
  // приём, что у золотых векторов `linkHash` в chatChain.
  const GOLD_SIGN_SEED = '0x444293b4cb6e213596434b1b73c3037037b7facc4fb7068ba4efa883ad575696';
  const GOLD_SIGN_PUB  = '0x497e1c2ee81a6bd15ab93ec8ad2b601f9e08c4941f49ccb93fd80da7d89643de';

  it('золотой вектор: тот же закрытый ключ даёт ту же подписную пару', async () => {
    const kp = await deriveLinkSigningKeypair({ publicKey: PUB_STUB, privateKey: PRIV });
    expect(hex(kp.publicKey)).toBe(GOLD_SIGN_PUB);
    expect(kp.publicKey).toHaveLength(LINK_SIGNING_PUBLIC_KEY_LEN);
    expect(kp.privateKey).toHaveLength(64); // Ed25519 secret = seed ‖ pub
  });

  it('семя подписи — отдельный под-ключ: не сам ключ и не производная без метки', async () => {
    // Главная ловушка задачи: скормить то же семя второму алгоритму.
    //
    // ⚠️ Первая версия этого теста считала три семени ЗДЕСЬ и сравнивала их
    // МЕЖДУ СОБОЙ — то есть не звала модуль вообще и покраснеть не могла ни от
    // какой правки в нём (мутация «то же семя второму алгоритму» давала 2
    // красных, и ни одна из них не была этой). Классическая слепая заготовка.
    // Теперь тест проводит ключ ЧЕРЕЗ модуль и сверяет с тремя кандидатами,
    // посчитанными независимо.
    const fromModule = await deriveLinkSigningKeypair({ publicKey: PUB_STUB, privateKey: PRIV });
    const sodium = (await import('libsodium-wrappers')).default;
    await sodium.ready;

    const withContext = hexToBytes(keccak256(concat([stringToBytes(LINK_SIGNING_KEY_CONTEXT), PRIV])));
    const withoutContext = hexToBytes(keccak256(PRIV));

    expect(hex(withContext)).toBe(GOLD_SIGN_SEED); // золотой вектор сходится с формулой
    expect(hex(fromModule.publicKey))
      .toBe(hex(sodium.crypto_sign_seed_keypair(withContext).publicKey));
    expect(hex(fromModule.publicKey))
      .not.toBe(hex(sodium.crypto_sign_seed_keypair(withoutContext).publicKey));
    // И, главное, — НЕ то, что дал бы закрытый ключ шифрования, скормленный
    // Ed25519 напрямую.
    expect(hex(fromModule.publicKey))
      .not.toBe(hex(sodium.crypto_sign_seed_keypair(PRIV).publicKey));
  });

  it('метки назначения — записанные руками строки, а не «какие-нибудь»', () => {
    // Смена любой из них — миграция: подписи перестают проверяться у всех
    // разом. Сравнение модуля с самим собой этого не поймало бы.
    expect(LINK_SIGNING_KEY_CONTEXT).toBe('hexseal.chat.link.sig.key.v1');
    expect(LINK_SIGNATURE_DOMAIN).toBe('hexseal.chat.link.sig.v1');
  });

  it('подписная пара выведена ИЗ ключа шифрования и не совпадает с ним', async () => {
    // ⚠️ Прежняя версия сравнивала два разных 32-байтовых значения на
    // неравенство — различающая способность около нуля (находка В-8). Здесь
    // проверяется ПОЛОЖИТЕЛЬНОЕ утверждение: подписной ключ — это ровно то,
    // что даёт независимо посчитанное семя, и заодно он не равен ключу
    // шифрования.
    const session = await makeSession('1c3d', ALICE);
    const sign = await deriveLinkSigningKeypair(session.keypair);
    const sodium = (await import('libsodium-wrappers')).default;
    await sodium.ready;
    const seed = hexToBytes(keccak256(concat([
      stringToBytes(LINK_SIGNING_KEY_CONTEXT), session.keypair.privateKey,
    ])));
    expect(hex(sign.publicKey)).toBe(hex(sodium.crypto_sign_seed_keypair(seed).publicKey));
    expect(hex(sign.publicKey)).not.toBe(hex(session.keypair.publicKey));
    // Закрытая половина Ed25519 — это семя ‖ открытый ключ; первые 32 байта
    // обязаны быть ИМЕННО семенем, а не ключом шифрования.
    expect(hex(sign.privateKey.slice(0, 32))).toBe(hex(seed));
  });

  it('разные ключи шифрования — разные подписные пары, и каждая своя', async () => {
    const alice = (await makeSession('1c3d', ALICE)).keypair;
    const bob = (await makeSession('7f2e', BOB)).keypair;
    const a = await deriveLinkSigningKeypair(alice);
    const b = await deriveLinkSigningKeypair(bob);
    const sodium = (await import('libsodium-wrappers')).default;
    await sodium.ready;
    const seedOf = (priv: Uint8Array) => hexToBytes(keccak256(concat([
      stringToBytes(LINK_SIGNING_KEY_CONTEXT), priv,
    ])));
    // Не «они разные» (это верно у любых двух случайных байт), а «каждая —
    // ровно та, что следует из СВОЕГО ключа шифрования».
    expect(hex(a.publicKey)).toBe(hex(sodium.crypto_sign_seed_keypair(seedOf(alice.privateKey)).publicKey));
    expect(hex(b.publicKey)).toBe(hex(sodium.crypto_sign_seed_keypair(seedOf(bob.privateKey)).publicKey));
    expect(hex(a.publicKey)).not.toBe(hex(b.publicKey));
  });

  it('наш мусор на входе — TypeError, а не молчаливая пара', async () => {
    await expect(
      deriveLinkSigningKeypair({ publicKey: PUB_STUB, privateKey: 'не байты' as unknown as Uint8Array }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      deriveLinkSigningKeypair({ publicKey: PUB_STUB, privateKey: new Uint8Array(31) }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('преимидж подписи несёт доменную метку — сырые байты звена не подписываются', () => {
    const link: ChainLink = {
      seq: 0, prevHash: GENESIS_HASH,
      bodyHash: keccak256(stringToBytes('тело')),
      sender: ALICE.toLowerCase() as `0x${string}`, sentAt: 1_754_400_000_000,
    };
    const pre = linkSignaturePreimage(link);
    const raw = hexToBytes(linkPreimage(link));
    const domain = stringToBytes(LINK_SIGNATURE_DOMAIN);
    // Ровно метка спереди, дальше — байты звена как есть. §11 общей спеки:
    // `linkPreimage` отдаёт сырые байты БЕЗ доменной разметки, подписывать их
    // без префикса нельзя.
    expect(pre.length).toBe(domain.length + raw.length);
    expect(hex(pre.slice(0, domain.length))).toBe(hex(domain));
    expect(hex(pre.slice(domain.length))).toBe(hex(raw));
    expect(hex(pre)).not.toBe(hex(raw));
  });

  it('отпечаток тела требует ключ РОВНО той ширины — иначе граница плавает', () => {
    // Мелочь враждебной проверки, найденная коллизией: `keccak(МЕТКА ‖ ключ ‖
    // конверт)` при НЕФИКСИРОВАННОЙ ширине ключа — это два поля переменной
    // ширины подряд, то есть ровно та неоднозначность упаковки, которую
    // chatChain.ts запрещает своим списком типов. Ключ на байт короче плюс
    // байт в начало конверта дают ТОТ ЖЕ отпечаток. На проводе недостижимо
    // (кадр фиксирует 32 байта), но функция вынесена наружу — значит гейт
    // обязан стоять в ней самой, а не в её единственном сегодняшнем вызове.
    const key = new Uint8Array(32).fill(7);
    expect(() => messageBodyHash(key.slice(0, 31), new Uint8Array([7, 1, 2]))).toThrow(TypeError);
    expect(() => messageBodyHash(new Uint8Array(33), new Uint8Array([1]))).toThrow(TypeError);
    expect(() => messageBodyHash('не байты' as unknown as Uint8Array, new Uint8Array([1]))).toThrow(TypeError);
  });

  it('золотой вектор отпечатка тела: метка ‖ подписной ключ ‖ конверт', () => {
    const signerPub = hexToBytes(GOLD_SIGN_PUB as `0x${string}`);
    const envelope = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(messageBodyHash(signerPub, envelope)).toBe(
      '0xee9b68fc9cb3404746e3bb255c9ac8d55029eee03f28370edcf2c45b57056a23',
    );
    // Подписной ключ ВХОДИТ в отпечаток тела — значит он пришит к цепочке, а
    // не болтается рядом с ней: подмена ключа меняет bodyHash, а тот меняет
    // отпечаток звена и рвёт связь со следующим.
    expect(messageBodyHash(new Uint8Array(32), envelope)).not.toBe(
      messageBodyHash(signerPub, envelope),
    );
    expect(MESSAGE_BODY_CONTEXT).toBe('hexseal.chat.body.v1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Формат кадра
// ═══════════════════════════════════════════════════════════════════════════

describe('кадр мешка', () => {
  const link: ChainLink = {
    seq: 7, prevHash: keccak256(stringToBytes('prev')),
    bodyHash: keccak256(stringToBytes('body')),
    sender: BOB.toLowerCase() as `0x${string}`, sentAt: 1_754_400_000_123,
  };
  const frame = () => ({
    link,
    signature: new Uint8Array(LINK_SIGNATURE_LEN).fill(0x5a),
    signerPublicKey: new Uint8Array(LINK_SIGNING_PUBLIC_KEY_LEN).fill(0x0b),
    envelope: new Uint8Array([1, 2, 3, 4, 5]),
  });

  it('ширина заголовка — записанное руками число, не производное от модуля', () => {
    // 1 версия + 32 подписной ключ + 64 подпись + 4 номер + 8 время +
    // 32 отпечаток предыдущего + 32 отпечаток тела + 20 адрес = 193.
    expect(FRAME_HEADER_LEN).toBe(193);
    expect(LINK_SIGNATURE_LEN).toBe(64);
    expect(LINK_SIGNING_PUBLIC_KEY_LEN).toBe(32);
    expect(FRAME_VERSION).toBe(1);
  });

  it('разбор возвращает ровно то, что собрано (побайтово)', () => {
    const f = frame();
    const bytes = encodeFrame(f);
    expect(bytes.length).toBe(FRAME_HEADER_LEN + f.envelope.length);
    const back = decodeFrame(bytes);
    expect(back).not.toBeNull();
    expect(back!.link).toEqual(f.link);
    expect(hex(back!.signature)).toBe(hex(f.signature));
    expect(hex(back!.signerPublicKey)).toBe(hex(f.signerPublicKey));
    expect(hex(back!.envelope)).toBe(hex(f.envelope));
  });

  it('ровно одно поле переменной ширины, и оно последнее', () => {
    // Не более одного динамического поля — правило §11 общей спеки. Здесь
    // заперто поведением: длина заголовка не зависит от длины конверта.
    const short = encodeFrame({ ...frame(), envelope: new Uint8Array(1) });
    const long = encodeFrame({ ...frame(), envelope: new Uint8Array(5000) });
    expect(short.length - 1).toBe(FRAME_HEADER_LEN);
    expect(long.length - 5000).toBe(FRAME_HEADER_LEN);
    expect(hex(short.slice(0, FRAME_HEADER_LEN))).toBe(hex(long.slice(0, FRAME_HEADER_LEN)));
  });

  it('граница длины: ровно заголовок+1 разбирается, ровно заголовок — нет', () => {
    const ok = new Uint8Array(FRAME_HEADER_LEN + 1);
    ok[0] = FRAME_VERSION;
    expect(decodeFrame(ok)).not.toBeNull();
    const empty = new Uint8Array(FRAME_HEADER_LEN);
    empty[0] = FRAME_VERSION;
    expect(decodeFrame(empty)).toBeNull(); // мешок без конверта — не мешок
    const short = new Uint8Array(FRAME_HEADER_LEN - 1);
    short[0] = FRAME_VERSION;
    expect(decodeFrame(short)).toBeNull();
  });

  it('номер на границе: 2^32−1 кодируется, 2^32 — громкий отказ', () => {
    expect(MAX_LINK_SEQ).toBe(4_294_967_295);
    const at = encodeFrame({ ...frame(), link: { ...link, seq: MAX_LINK_SEQ } });
    expect(decodeFrame(at)!.link.seq).toBe(MAX_LINK_SEQ);
    expect(() => encodeFrame({ ...frame(), link: { ...link, seq: MAX_LINK_SEQ + 1 } }))
      .toThrow(/seq/i);
  });

  it('время на границе: 2^53−1 разбирается, 2^53 — null (не тихое округление)', () => {
    const bytes = encodeFrame({ ...frame(), link: { ...link, sentAt: Number.MAX_SAFE_INTEGER } });
    expect(decodeFrame(bytes)!.link.sentAt).toBe(Number.MAX_SAFE_INTEGER);
    // 2^53 руками, через DataView — модуль его закодировать не даст.
    const over = encodeFrame(frame());
    new DataView(over.buffer, over.byteOffset).setBigUint64(101, 2n ** 53n);
    expect(decodeFrame(over)).toBeNull();
  });

  it('чужая версия кадра — null, а не догадка', () => {
    const bytes = encodeFrame(frame());
    bytes[0] = 2;
    expect(decodeFrame(bytes)).toBeNull();
  });

  it('наш мусор на входе — TypeError, чужой мусор — null', () => {
    expect(() => decodeFrame('не байты' as unknown as Uint8Array)).toThrow(TypeError);
    expect(decodeFrame(new Uint8Array(0))).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Свойство 1: отправка не открывает кошелёк
// ═══════════════════════════════════════════════════════════════════════════

describe('отправка не открывает кошелёк', () => {
  it('сто сообщений — НОЛЬ вызовов подписи кошелька', async () => {
    const stub = installFetchStub();
    // Сеанс открывается настоящим `openSession` — то есть окно подписи в
    // жизни бывает ровно одно, при заходе. Замер снимается ПОСЛЕ него:
    // считаем окна, открытые ОТПРАВКОЙ, а не входом.
    const { openSession } = await import('./chatSession');
    const signTypedData = vi.fn(async () => signatureOf('1c3d'));
    // `lockTimeoutMs` подставлен НЕ ради проверяемого свойства, а чтобы этот
    // тест не мог зависнуть на три минуты (боевой потолок замка сеанса), если
    // межвкладочный замок кто-то держит: тест, который вешает исполнителя
    // тестов вместо честного провала, прячет причину.
    const session = await openSession(ALICE, signTypedData, {
      getBytecode: async () => undefined, lockTimeoutMs: 1_000,
    });
    expect(signTypedData).toHaveBeenCalledTimes(1); // вход — одно окно

    signTypedData.mockClear();
    stub.calls.length = 0;
    const bob = await makeSession('7f2e', BOB);

    let prev: ChainLink | null = null;
    for (let i = 0; i < 100; i++) {
      const sent = await sendMessage(
        session, BOB, bob.keypair.publicKey, { text: `сообщение ${i}` }, prev, { pass: PASS },
      );
      prev = sent.link;
    }

    expect(signTypedData).toHaveBeenCalledTimes(0);
    // Второй замер, независимый от первого: отправка не ходит и за ПРОПУСКОМ
    // (`POST /bags/pass`) — а именно этот поход и есть подпись кошелька в
    // транспорте. Сто PUT-ов и ни одного обращения к пропуску.
    expect(stub.calls.filter(c => c.url.endsWith('/bags/pass'))).toHaveLength(0);
    expect(stub.calls.filter(c => c.method === 'PUT')).toHaveLength(100);
    expect(prev!.seq).toBe(99);
  }, 120_000);

  it('номера идут подряд от нуля, каждое звено пришито к предыдущему', async () => {
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);

    const sent: SentMessage[] = [];
    let prev: ChainLink | null = null;
    for (let i = 0; i < 5; i++) {
      const s = await sendMessage(alice, BOB, bob.keypair.publicKey, { text: `${i}` }, prev, { pass: PASS });
      sent.push(s); prev = s.link;
    }
    expect(sent.map(s => s.link.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(sent[0].link.prevHash).toBe(GENESIS_HASH);
    expect(verifyChain(sent.map(s => s.link))).toEqual({ ok: true, unverifiedContentAtSeq: [0, 1, 2, 3, 4] });
  });

  it('слишком длинное сообщение — внятный отказ, и номер НЕ сгорает', async () => {
    // packEnvelope отказывает громко на потолке 256 КиБ (= предел приёма
    // склада). Отказ обязан дойти до человека кодом, а не пропасть; и он
    // обязан случиться ДО того, как номер зарезервирован — иначе неудачная
    // отправка дырявила бы собственную нумерацию.
    const stub = installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);

    await sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'первое' }, null, { pass: PASS });
    const before = await readConversationHead(ALICE, BOB);

    await expect(
      sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'я'.repeat(300_000) }, null, { pass: PASS }),
    ).rejects.toMatchObject({ code: 'message_too_large' });

    const after = await readConversationHead(ALICE, BOB);
    expect(after!.link.seq).toBe(before!.link.seq); // ни одного сгоревшего номера
    expect(await listBurnedSeqs(ALICE, BOB)).toEqual([]);
    expect(stub.calls.filter(c => c.method === 'PUT')).toHaveLength(1); // второе даже не поехало
  });

  it('негодный ключ вложения — НЕ выдаётся за «слишком длинное»', async () => {
    // ⚠️ Прежний глухой перехват называл ЛЮБУЮ ошибку сборки «слишком
    // длинным». Человек по такому совету режет текст, а причина в другом.
    const stub = installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);

    await expect(
      sendMessage(alice, BOB, bob.keypair.publicKey, {
        file: { url: 'https://x', name: 'f.bin', size: 1, keyHex: 'zz'.repeat(32), ivHex: 'cd'.repeat(12) },
      }, null, { pass: PASS }),
    ).rejects.toThrow(/attachment key/);

    // И номер не сгорел, и на склад ничего не поехало.
    expect(stub.calls.filter(c => c.method === 'PUT')).toHaveLength(0);
    expect(await listBurnedSeqs(ALICE, BOB)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Свойство 2: порядок по номерам, а не по времени прихода
// ═══════════════════════════════════════════════════════════════════════════

/** Мешок в том виде, в каком его отдаёт склад: отправитель засвидетельствован
 *  СЕРВЕРОМ (строчными), содержимое — сырые байты кадра. */
function bagOf(sent: SentMessage, from: `0x${string}`, uploadedAt: number): IncomingBag {
  return { key: sent.key, sender: from.toLowerCase() as `0x${string}`, uploadedAt, body: sent.frame };
}

/**
 * Собирает цепочку кадров РУКАМИ, ключом самого отправителя — так, как её
 * пересобрал бы он сам, задним числом. Ничего «не того» здесь нет: каждое
 * звено подписано законным владельцем ключа и сцеплено с предыдущим, поэтому
 * результат неотличим от честной переписки без внешнего якоря.
 */
async function forgeChain(
  from: ChatSession, to: ChatSession, texts: string[],
): Promise<Uint8Array[]> {
  const signer = await deriveLinkSigningKeypair(from.keypair);
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  const out: Uint8Array[] = [];
  let prev: ChainLink | null = null;
  for (const [i, text] of texts.entries()) {
    const envelope = await packEnvelope(
      { text }, to.keypair.publicKey, from.keypair.publicKey,
      from.address.toLowerCase() as `0x${string}`,
    );
    const link = buildLink(
      prev, messageBodyHash(signer.publicKey, envelope),
      from.address, 1_754_400_000_000 + i * 1000,
    );
    out.push(encodeFrame({
      link,
      signature: sodium.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey),
      signerPublicKey: signer.publicKey,
      envelope,
    }));
    prev = link;
  }
  return out;
}

async function conversationFrom(
  from: ChatSession, to: ChatSession, texts: string[],
): Promise<SentMessage[]> {
  const out: SentMessage[] = [];
  let prev: ChainLink | null = null;
  for (const text of texts) {
    const s = await sendMessage(from, to.address, to.keypair.publicKey, { text }, prev, { pass: PASS });
    out.push(s); prev = s.link;
  }
  return out;
}

describe('порядок восстанавливается по номерам', () => {
  it('мешки приехали вразнобой — порядок всё равно по номеру', async () => {
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const sent = await conversationFrom(bob, alice, ['ноль', 'один', 'два', 'три', 'четыре']);

    // Перемешанная ДОСТАВКА, а не последовательная: время прихода нарочно
    // спорит с номером (последнее приехало первым).
    const shuffled = [4, 1, 3, 0, 2].map((i, pos) => bagOf(sent[i], BOB, 1_000 + pos));
    const state = await receiveBags(alice, shuffled);

    expect(state.messages.map(m => m.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(state.messages.map(m => (m.payload as ChatPayload).text))
      .toEqual(['ноль', 'один', 'два', 'три', 'четыре']);
    expect(state.gapAfterSeq).toEqual([]);
  });

  it('время отправки врёт (часы съехали) — порядок СВОЕГО отправителя всё равно по номеру', async () => {
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    let prev: ChainLink | null = null;
    const sent: SentMessage[] = [];
    // sentAt идёт ВСПЯТЬ: 3-е сообщение «отправлено» раньше 1-го.
    for (const [i, at] of [5_000, 3_000, 1_000].entries()) {
      const s = await sendMessage(bob, ALICE, alice.keypair.publicKey, { text: `#${i}` }, prev,
        { pass: PASS, now: () => at });
      sent.push(s); prev = s.link;
    }
    const state = await receiveBags(alice, sent.map((s, i) => bagOf(s, BOB, 9_000 - i)));
    expect(state.messages.map(m => m.seq)).toEqual([0, 1, 2]);
    expect(state.messages.map(m => (m.payload as ChatPayload).text)).toEqual(['#0', '#1', '#2']);
  });

  it('двести перестановок доставки: порядок ОДИН И ТОТ ЖЕ, и номера внутри стороны не идут вспять', async () => {
    // Находка К-2 враждебной проверки. Сравнение «внутри стороны по номеру,
    // между сторонами по времени» НЕТРАНЗИТИВНО: достаточно, чтобы время
    // спорило с номером — а его ставит сам отправитель, и оно может врать.
    // Замер проверяющего: 126 перестановок из 200 давали номера вспять.
    //
    // Прежний тест этого не видел, потому что в нём ОДИН отправитель: без
    // межстороннего сравнения нетранзитивности не возникает вовсе.
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);

    // Время идёт ВСПЯТЬ у обеих сторон, и промежутки нарочно перекрываются.
    const mine: SentMessage[] = [];
    let prevA: ChainLink | null = null;
    for (let i = 0; i < 8; i++) {
      const s = await sendMessage(alice, BOB, bob.keypair.publicKey, { text: `A${i}` }, prevA,
        { pass: PASS, now: () => 9_000 - i * 100 });
      mine.push(s); prevA = s.link;
    }
    const theirs: SentMessage[] = [];
    let prevB: ChainLink | null = null;
    for (let i = 0; i < 8; i++) {
      const s = await sendMessage(bob, ALICE, alice.keypair.publicKey, { text: `B${i}` }, prevB,
        { pass: PASS, now: () => 8_950 - i * 100 });
      theirs.push(s); prevB = s.link;
    }

    /** Детерминированная перестановка — тест обязан повторяться в точности. */
    function shuffled<T>(list: T[], salt: number): T[] {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = (i * 7919 + salt * 104729) % (i + 1);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    }

    let reference: string[] | null = null;
    for (let round = 0; round < 200; round++) {
      const bags = shuffled(theirs.map((s, i) => bagOf(s, BOB, 1_000 + i)), round);
      const own = shuffled(mine, round * 3 + 1);
      const state = await receiveBags(alice, bags, { own, peer: BOB });
      const order = state.messages.map(
        m => `${m.from === ALICE.toLowerCase() ? 'A' : 'B'}${m.seq}`,
      );
      expect(order).toHaveLength(16);

      // 1. Внутри стороны номера СТРОГО по возрастанию — при любом времени.
      for (const side of ['A', 'B']) {
        const seqs = order.filter(t => t.startsWith(side)).map(t => Number(t.slice(1)));
        expect({ round, side, seqs }).toEqual({ round, side, seqs: [...seqs].sort((x, y) => x - y) });
      }
      // 2. Порядок показа не зависит от порядка прихода — ни в одной из 200.
      if (reference === null) reference = order;
      else expect({ round, order }).toEqual({ round, order: reference });
    }
  }, 120_000);

  it('свои и чужие сообщения сливаются по времени отправки, номера внутри стороны не путаются', async () => {
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const mine = await conversationFrom(alice, bob, ['мой-0', 'мой-1']);
    const theirs = await conversationFrom(bob, alice, ['их-0', 'их-1']);

    // ⚠️ ВРЕМЯ ЗАГРУЗКИ ЗАДАНО ПРАВДОПОДОБНО, И ЭТО ЧАСТЬ ПРАВКИ В-2. Раньше
    // здесь стояло `100 + i` — заведомо ложное время склада (1970 год) при
    // настоящих часах у своей половины. Пока порядок держался на `sentAt`,
    // разницы не было; теперь порядок держится на СВИДЕТЕЛЬСТВЕ СКЛАДА, и
    // фикстура, утверждающая, что ответ Боба загружен на полвека раньше
    // вопроса, проверяла бы не то, что обещает её имя. Мешки Боба приняты
    // складом ПОСЛЕ отправки Алисы — как оно и бывает.
    const afterMine = mine[mine.length - 1].link.sentAt + 1;
    const state = await receiveBags(alice, theirs.map((s, i) => bagOf(s, BOB, afterMine + i)), { own: mine });
    // ⚠️ Прежняя версия проверяла ТОЛЬКО порядок внутри каждой стороны —
    // межсторонний, ради которого тест назван, не проверялся вовсе, и это
    // скрыло находку К-2. Здесь заперт ВЕСЬ показанный ряд целиком.
    expect(state.messages.map(m => (m.payload as ChatPayload).text))
      .toEqual(['мой-0', 'мой-1', 'их-0', 'их-1']);
    expect(state.messages.map(m => m.from))
      .toEqual([ALICE.toLowerCase(), ALICE.toLowerCase(), BOB.toLowerCase(), BOB.toLowerCase()]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Свойство 4: подделка даёт «сломано», а не тихий приём
// ═══════════════════════════════════════════════════════════════════════════

describe('подделка звена видна', () => {
  async function pair() {
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const sent = await conversationFrom(bob, alice, ['раз', 'два', 'три']);
    return { alice, bob, sent };
  }

  it('подделанная подпись — bad_signature, сообщение не показано', async () => {
    const { alice, sent } = await pair();
    const bags = sent.map((s, i) => bagOf(s, BOB, 100 + i));
    bags[1].body = new Uint8Array(bags[1].body);
    bags[1].body[33] ^= 0xff; // первый байт подписи

    const state = await receiveBags(alice, bags);
    expect(state.troubles).toContainEqual(expect.objectContaining({ kind: 'bad_signature', seq: 1 }));
    expect(state.messages.map(m => m.seq)).toEqual([0, 2]);
    expect(state.gapAfterSeq).toContain(0); // звено 1 выпало из цепочки — разрыв назван
  });

  it('подделанный отпечаток предыдущего — bad_signature (подпись покрывает его)', async () => {
    const { alice, sent } = await pair();
    const bags = sent.map((s, i) => bagOf(s, BOB, 100 + i));
    bags[2].body = new Uint8Array(bags[2].body);
    bags[2].body[109] ^= 0x01; // первый байт prevHash
    const state = await receiveBags(alice, bags);
    expect(state.troubles).toContainEqual(expect.objectContaining({ kind: 'bad_signature' }));
    expect(state.messages.map(m => m.seq)).toEqual([0, 1]);
  });

  it('подделанный номер — bad_signature (подпись покрывает и его)', async () => {
    const { alice, sent } = await pair();
    const bags = sent.map((s, i) => bagOf(s, BOB, 100 + i));
    bags[1].body = new Uint8Array(bags[1].body);
    new DataView(bags[1].body.buffer, bags[1].body.byteOffset).setUint32(97, 42);
    const state = await receiveBags(alice, bags);
    expect(state.troubles).toContainEqual(expect.objectContaining({ kind: 'bad_signature', seq: 42 }));
    expect(state.messages.map(m => m.seq)).toEqual([0, 2]);
  });

  it('подделанный конверт — body_mismatch, а не тихо искажённое содержимое', async () => {
    const { alice, sent } = await pair();
    const bags = sent.map((s, i) => bagOf(s, BOB, 100 + i));
    bags[0].body = new Uint8Array(bags[0].body);
    bags[0].body[FRAME_HEADER_LEN + 5] ^= 0xff;
    const state = await receiveBags(alice, bags);
    expect(state.troubles).toContainEqual(expect.objectContaining({ kind: 'body_mismatch', seq: 0 }));
    expect(state.messages.map(m => m.seq)).toEqual([1, 2]);
  });

  it('подменённый подписной ключ — body_mismatch (ключ пришит к цепочке отпечатком тела)', async () => {
    const { alice, sent } = await pair();
    const bags = sent.map((s, i) => bagOf(s, BOB, 100 + i));
    bags[1].body = new Uint8Array(bags[1].body);
    bags[1].body[1] ^= 0xff; // первый байт signerPublicKey
    const state = await receiveBags(alice, bags);
    expect(state.troubles).toContainEqual(expect.objectContaining({ kind: 'body_mismatch', seq: 1 }));
    expect(state.messages.map(m => m.seq)).toEqual([0, 2]);
  });

  it('чужой конверт, переложенный в свой кадр, НЕ читается как своё сообщение (В-1)', async () => {
    // Находка В-1 враждебной проверки. Запечатывание анонимно, `bodyHash`
    // связывает конверт со ЗВЕНОМ — но ничто не связывало конверт с АВТОРОМ.
    // Боб брал конверт Алисы, клал в свой кадр, подписывал своим ключом — и
    // Алиса видела СВОИ слова как сказанные Бобом, при вердикте ok:true и без
    // единой тревоги.
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);

    // Алиса пишет Бобу. Конверт запечатан на Боба И на саму Алису (второй
    // слот) — значит Алиса свой же конверт вскроет, кто бы его ни принёс.
    const fromAlice = await sendMessage(
      alice, BOB, bob.keypair.publicKey, { text: 'я согласна доплатить 500 USDC' }, null, { pass: PASS },
    );
    const stolen = decodeFrame(fromAlice.frame)!.envelope;

    // Боб перекладывает ЕЁ конверт в СВОЙ кадр и честно подписывает своим
    // ключом: звено безупречно, отпечаток тела сходится, подпись сходится.
    const bobSigner = await deriveLinkSigningKeypair(bob.keypair);
    const sodium = (await import('libsodium-wrappers')).default;
    await sodium.ready;
    const link: ChainLink = {
      seq: 0, prevHash: GENESIS_HASH,
      bodyHash: messageBodyHash(bobSigner.publicKey, stolen),
      sender: BOB.toLowerCase() as `0x${string}`, sentAt: 1_754_400_000_000,
    };
    const body = encodeFrame({
      link,
      signature: sodium.crypto_sign_detached(linkSignaturePreimage(link), bobSigner.privateKey),
      signerPublicKey: bobSigner.publicKey,
      envelope: stolen,
    });

    const state = await receiveBags(alice, [
      { key: 'подлог', sender: BOB.toLowerCase() as `0x${string}`, uploadedAt: 1, body },
    ]);

    // Закрыто ПО ПОСТРОЕНИЮ: адрес автора аутентифицирован вместе с конвертом,
    // поэтому переложенный конверт просто не расшифровывается. Забыть проверку
    // негде — её нет, есть невозможность.
    expect(state.messages).toHaveLength(0);
    expect(state.troubles).toContainEqual(expect.objectContaining({ kind: 'undecryptable', seq: 0 }));
  });

  it('подставленное чужое звено (кадр Кэрол в мешке от Боба) — sender_mismatch', async () => {
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const carol = await makeSession('9b4a', CAROL);
    const carolSent = await conversationFrom(carol, alice, ['я не Боб']);

    // Сервер свидетельствует: мешок положил БОБ. Внутри — честное, подписанное
    // звено КЭРОЛ. Без сверки свидетельства сервера с полем звена это
    // выглядело бы как сообщение Боба.
    const state = await receiveBags(alice, [bagOf(carolSent[0], BOB, 100)]);
    expect(state.troubles).toContainEqual(expect.objectContaining({ kind: 'sender_mismatch' }));
    expect(state.messages).toHaveLength(0);
  });

  it('ВСЁ отвергнуто — вердикт «не в порядке», а НЕ отсутствие записи (В-2)', async () => {
    // Находка В-2: при полном отвержении карта цепочек оставалась пустой, и
    // потребитель, написавший естественное «цепочка собеседника не в порядке?»,
    // не видел НИЧЕГО именно в самом тяжёлом случае — отсутствие записи
    // читается как «претензий нет».
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const sent = await conversationFrom(bob, alice, ['раз', 'два', 'три']);
    const bags = sent.map((s, i) => {
      const bag = bagOf(s, BOB, 100 + i);
      bag.body = new Uint8Array(bag.body);
      bag.body[33] ^= 0xff; // подпись каждого испорчена
      return bag;
    });

    const state = await receiveBags(alice, bags);
    expect(state.chains[BOB.toLowerCase()]).toBeDefined();
    expect(state.chains[BOB.toLowerCase()]).toMatchObject({ ok: false });
    expect(state.messages).toHaveLength(0);
  });

  it('разрыв назван С АВТОРОМ: дыра постороннего не приписывается собеседнику (В-3)', async () => {
    // Находка В-3: список разрывов был объединением по всем отправителям без
    // указания автора. Посторонний, положивший мешок в ящик, добавлял свой
    // разрыв — и общий итог показывал его как разрыв переписки с собеседником.
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const carol = await makeSession('9b4a', CAROL);

    const fromBob = await conversationFrom(bob, alice, ['б0', 'б1']);     // честно, без дыр
    const fromCarol = await conversationFrom(carol, alice, ['к0', 'к1', 'к2']);

    // У ПОСТОРОННЕЙ дыра: второе её сообщение не показано.
    const state = await receiveBags(alice, [
      bagOf(fromBob[0], BOB, 1), bagOf(fromBob[1], BOB, 2),
      bagOf(fromCarol[0], CAROL, 3), bagOf(fromCarol[2], CAROL, 4),
    ]);

    expect(state.gaps).toEqual([{ from: CAROL.toLowerCase(), afterSeq: 0 }]);
    expect(state.gaps.filter(g => g.from === BOB.toLowerCase())).toEqual([]);
    expect(state.chains[BOB.toLowerCase()]).toMatchObject({ ok: true });
    expect(state.chains[CAROL.toLowerCase()]).toMatchObject({ ok: false, reason: 'gap' });
  });

  it('чужая цепочка НЕ смешивается со своей: у каждого отправителя свой вердикт', async () => {
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const carol = await makeSession('9b4a', CAROL);
    const fromBob = await conversationFrom(bob, alice, ['б0', 'б1']);
    const fromCarol = await conversationFrom(carol, alice, ['к0', 'к1']);

    const state = await receiveBags(alice, [
      bagOf(fromBob[0], BOB, 1), bagOf(fromCarol[1], CAROL, 2),
      bagOf(fromBob[1], BOB, 3), bagOf(fromCarol[0], CAROL, 4),
    ]);
    expect(state.chains[BOB.toLowerCase()]).toEqual({ ok: true, unverifiedContentAtSeq: [0, 1] });
    expect(state.chains[CAROL.toLowerCase()]).toEqual({ ok: true, unverifiedContentAtSeq: [0, 1] });
    expect(state.messages).toHaveLength(4);
  });

  it('НАСТОЯЩАЯ каскадная подделка проходит как целая — и вердикт этого не скрывает', async () => {
    // ⚠️ Прежняя версия этого теста НЕ СТРОИЛА никакой подделки: в теле была
    // честная переписка из трёх сообщений (находка В-8 враждебной проверки —
    // при полностью выключенной проверке подписи краснели четыре теста, и
    // этого среди них не было). Тест назывался главным свойством и не строил
    // того, что называет.
    //
    // Здесь подделка настоящая: Боб переписывает СВОЁ ЖЕ второе сообщение и
    // пересчитывает весь хвост своим ключом. Он законный владелец ключа, так
    // что каждое звено безупречно и каждая смежная пара сходится.
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const forged = await forgeChain(bob, alice, ['а', 'НЕ ТО, ЧТО БЫЛО', 'в']);

    const state = await receiveBags(alice, forged.map((f, i) => ({
      key: `подделка-${i}`, sender: BOB.toLowerCase() as `0x${string}`, uploadedAt: i, body: f,
    })));

    // Не ловится. И это не наш недосмотр, а свойство любой такой цепочки
    // (§5 общей спеки): подделка согласована сама с собой, потому что
    // пересчитана вперёд тем же ключом.
    expect(state.chains[BOB.toLowerCase()]).toMatchObject({ ok: true });
    expect(state.messages.map(m => (m.payload as ChatPayload).text))
      .toEqual(['а', 'НЕ ТО, ЧТО БЫЛО', 'в']);
    // Единственное, что вердикт обязан сказать честно: не заверено НИЧЕГО из
    // показанного. Пустой этот список означал бы «всё проверено», и вот это
    // было бы враньём.
    expect((state.chains[BOB.toLowerCase()] as { unverifiedContentAtSeq: number[] })
      .unverifiedContentAtSeq).toEqual([0, 1, 2]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Свойство 5: чужое сообщение, которое не вскрывается
// ═══════════════════════════════════════════════════════════════════════════

describe('невскрываемое сообщение не ломает разговор', () => {
  it('мешок запечатан на третьего — пропущен, остальные показаны, ЦЕПОЧКА ЦЕЛА', async () => {
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const carol = await makeSession('9b4a', CAROL);

    // Боб шлёт три сообщения, но среднее по ошибке запечатывает на ключ Кэрол
    // (устаревший справочник — самый вероятный способ так промахнуться).
    const s0 = await sendMessage(bob, ALICE, alice.keypair.publicKey, { text: 'вижу' }, null, { pass: PASS });
    const s1 = await sendMessage(bob, ALICE, carol.keypair.publicKey, { text: 'не вижу' }, s0.link, { pass: PASS });
    const s2 = await sendMessage(bob, ALICE, alice.keypair.publicKey, { text: 'снова вижу' }, s1.link, { pass: PASS });

    const state = await receiveBags(alice, [s0, s1, s2].map((s, i) => bagOf(s, BOB, i)));

    expect(state.messages.map(m => (m.payload as ChatPayload).text)).toEqual(['вижу', 'снова вижу']);
    expect(state.troubles).toContainEqual(expect.objectContaining({ kind: 'undecryptable', seq: 1 }));
    // Главное: это НЕ разрыв. Звено на месте, подписано, цепочка сходится —
    // невскрытое сообщение не должно выглядеть обвинением в утаивании.
    expect(state.gapAfterSeq).toEqual([]);
    expect(state.chains[BOB.toLowerCase()]).toMatchObject({ ok: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Свойство 6: номер следующего — от последнего своего; две вкладки
// ═══════════════════════════════════════════════════════════════════════════

describe('нумерация и две вкладки', () => {
  it('номер берётся с устройства, даже если вызывающий подал устаревшее звено', async () => {
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);

    const first = await sendMessage(alice, BOB, bob.keypair.publicKey, { text: '0' }, null, { pass: PASS });
    await sendMessage(alice, BOB, bob.keypair.publicKey, { text: '1' }, first.link, { pass: PASS });
    // Вызывающий «забыл» про второе и подаёт первое как предыдущее.
    const third = await sendMessage(alice, BOB, bob.keypair.publicKey, { text: '2' }, first.link, { pass: PASS });
    expect(third.link.seq).toBe(2); // не 1 — устройство помнит дальше вызывающего
  });

  it('нумерация у каждого собеседника своя', async () => {
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const carol = await makeSession('9b4a', CAROL);
    await sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'б' }, null, { pass: PASS });
    await sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'б' }, null, { pass: PASS });
    const toCarol = await sendMessage(alice, CAROL, carol.keypair.publicKey, { text: 'к' }, null, { pass: PASS });
    expect(toCarol.link.seq).toBe(0);
  });

  it('ДВЕ ВКЛАДКИ (два экземпляра модуля, общий диск) — номера не столкнулись', async () => {
    installFetchStub();
    vi.resetModules();
    const tabOne = await import('./chatConversation');
    vi.resetModules();
    const tabTwo = await import('./chatConversation');
    expect(tabOne.sendMessage).not.toBe(tabTwo.sendMessage); // это правда два экземпляра

    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);

    const [a, b] = await Promise.all([
      tabOne.sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'вкладка 1' }, null, { pass: PASS }),
      tabTwo.sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'вкладка 2' }, null, { pass: PASS }),
    ]);
    expect(new Set([a.link.seq, b.link.seq]).size).toBe(2);
    expect([a.link.seq, b.link.seq].sort()).toEqual([0, 1]);
    // И второе звено пришито к первому — не две параллельные ветки.
    const second = a.link.seq === 1 ? a.link : b.link;
    const first = a.link.seq === 0 ? a.link : b.link;
    expect(verifyChain([first, second])).toMatchObject({ ok: true });
  }, 30_000);

  it('замок ДЕРЖИТ: пока чужая вкладка его не отпустила, отправка ждёт', async () => {
    // Не «замок вызван», а «замок запер»: в этом проекте уже был замок,
    // который не запирает. Держим тот же самый замок снаружи и смотрим, что
    // отправка не проехала мимо него.
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);

    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    let taken!: () => void;
    const takenP = new Promise<void>(r => { taken = r; });
    void navigator.locks.request(
      `hexseal-chat-conv-${ALICE.toLowerCase()}-${BOB.toLowerCase()}`,
      () => { taken(); return held; },
    );
    await takenP;

    let finished = false;
    const sending = sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'жду' }, null,
      { pass: PASS, lockTimeoutMs: 5_000 }).then(v => { finished = true; return v; });

    await new Promise(r => setTimeout(r, 60));
    expect(finished).toBe(false); // замок реально держит

    release();
    const sent = await sending;
    expect(sent.link.seq).toBe(0);
  });

  it('чужая вкладка держит замок вечно — не виснем навсегда', async () => {
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    let taken!: () => void;
    const takenP = new Promise<void>(r => { taken = r; });
    void navigator.locks.request(
      `hexseal-chat-conv-${ALICE.toLowerCase()}-${BOB.toLowerCase()}`,
      () => { taken(); return held; },
    );
    await takenP;

    const started = Date.now();
    const sent = await sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'всё равно поеду' }, null,
      { pass: PASS, lockTimeoutMs: 40 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(sent.link.seq).toBe(0);
    release();
  });

  it('боевой потолок ожидания замка реально ПРОВОДИТСЯ, а не только объявлен', async () => {
    // Правило проекта: правка, проверенная только на подставленных значениях,
    // может не изменить ничего. Здесь sendMessage зовётся БЕЗ lockTimeoutMs, а
    // таймер боевой длины подменяется на немедленный — длина наблюдаема.
    installFetchStub();
    const realSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    vi.stubGlobal('setTimeout', ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, ms === CONVERSATION_LOCK_TIMEOUT_MS ? 0 : ms, ...rest);
    }));
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    let taken!: () => void;
    const takenP = new Promise<void>(r => { taken = r; });
    void navigator.locks.request(
      `hexseal-chat-conv-${ALICE.toLowerCase()}-${BOB.toLowerCase()}`,
      () => { taken(); return held; },
    );
    await takenP;

    await sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'умолчание' }, null, { pass: PASS });
    expect(delays).toContain(CONVERSATION_LOCK_TIMEOUT_MS);
    release();
  });

  it('боевой потолок — не тестовое значение', () => {
    expect(CONVERSATION_LOCK_TIMEOUT_MS).toBe(30_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Обстоятельство 1: перезапустили посреди
// ═══════════════════════════════════════════════════════════════════════════

describe('перезапустили посреди отправки', () => {
  it('вкладку закрыли МЕЖДУ «положил мешок» и «записал, что положен» — номер уже занят', async () => {
    // Мутация «резерв не ложится на диск ДО отправки» выжила на 66 зелёных
    // (0 красных): все прежние тесты доходили до `catch` внутри sendMessage, а
    // он и без резерва дописывал сгоревший номер. Настоящий случай другой —
    // вкладка исчезает ПОСРЕДИ похода на склад, никакого catch не будет
    // вовсе. Здесь это воспроизведено буквально: ответ склада не придёт
    // никогда, промис отправки бросается недождавшимся, и «перезагрузка» —
    // новый экземпляр модуля на том же диске.
    const stub = installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    await sendMessage(alice, BOB, bob.keypair.publicKey, { text: '0' }, null, { pass: PASS });

    // ⚠️ Обрыв обязан быть УПРАВЛЯЕМЫМ. Первая версия этого теста оставляла
    // запрос висеть навсегда — вместе с ним навсегда оставался взят
    // межвкладочный замок, и СЛЕДУЮЩИЕ 14 тестов файла падали по таймауту,
    // пряча настоящую причину. Ровно тот класс, о котором предупреждает
    // задание: тест, убивающий исполнителя тестов вместо честного провала.
    let dropConnection: (() => void) | undefined;
    stub.next = () => new Promise<Response>((_, reject) => {
      dropConnection = () => reject(new TypeError('fetch failed'));
    });
    const hanging = sendMessage(alice, BOB, bob.keypair.publicKey, { text: '1' }, null,
      { pass: PASS, lockTimeoutMs: 500 });
    void hanging.catch(() => {}); // вкладки уже нет — результат никого не ждёт

    // finally обязателен: если ЛЮБАЯ проверка ниже упадёт, обрыв всё равно
    // должен произойти, иначе замок останется взят и следующие пятнадцать
    // тестов файла упадут по таймауту, скрыв единственный настоящий провал.
    // Проверено мутацией: без finally мутация M8 давала 16 красных вместо 1.
    try {
      await new Promise(r => setTimeout(r, 80)); // дать дойти до склада
      expect(stub.calls.filter(c => c.method === 'PUT')).toHaveLength(2); // мешок реально ушёл в сеть

      // «Перезагрузка»: новый экземпляр модуля, тот же диск. Голова читается
      // БЕЗ замка — то есть именно в тот момент, когда мешок ещё в полёте.
      vi.resetModules();
      const afterReload = await import('./chatConversation');
      const head = await afterReload.readConversationHead(ALICE, BOB);
      expect(head!.link.seq).toBe(1);   // резерв УЖЕ на диске
      expect(head!.key).toBeNull();     // и он именно резерв: мешок не подтверждён

      dropConnection?.();
      dropConnection = undefined;
      await hanging.catch(() => {});    // замок отпущен, файл больше никого не держит
      stub.next = () => new Response(JSON.stringify({ key: '0x00/после.bin' }),
        { status: 200, headers: { 'content-type': 'application/json' } });

      const next = await afterReload.sendMessage(
        alice, BOB, bob.keypair.publicKey, { text: '2' }, null, { pass: PASS, lockTimeoutMs: 500 },
      );
      expect(next.link.seq).toBe(2);    // номер 1 не выдан второй раз
    } finally {
      dropConnection?.();
      await hanging.catch(() => {});
    }
  }, 30_000);

  it('после перезагрузки вкладки нумерация продолжается с диска, а не с нуля', async () => {
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);

    await sendMessage(alice, BOB, bob.keypair.publicKey, { text: '0' }, null, { pass: PASS });

    // «Вкладку закрыли»: новый экземпляр модуля, тот же диск, вызывающий
    // ничего не помнит (prevLink = null).
    vi.resetModules();
    const afterReload = await import('./chatConversation');
    const next = await afterReload.sendMessage(
      alice, BOB, bob.keypair.publicKey, { text: '1' }, null, { pass: PASS },
    );
    expect(next.link.seq).toBe(1);
  }, 30_000);

  it('отказ склада, о котором мы ЗНАЕМ, что мешок не лёг — номер возвращается, дырки нет', async () => {
    const stub = installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);

    stub.next = () => new Response(JSON.stringify({ error: 'File too large (max 256 KB)', code: 'bag_too_large' }),
      { status: 413, headers: { 'content-type': 'application/json' } });
    await expect(
      sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'не доедет' }, null, { pass: PASS }),
    ).rejects.toBeTruthy();

    // 413 — сервер отверг явно, файл на складе удалён (relayer/app.js,
    // streamWithSizeLimit). Значит номер можно вернуть, дырки быть не должно.
    expect(await listBurnedSeqs(ALICE, BOB)).toEqual([]);
    stub.next = () => new Response(JSON.stringify({ key: '0x00/ok.bin' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    const ok = await sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'доедет' }, null, { pass: PASS });
    expect(ok.link.seq).toBe(0); // номер не сгорел
  });

  it('обрыв сети — судьба мешка НЕИЗВЕСТНА: номер сгорает и назван НАШЕЙ бедой', async () => {
    // Это ответ на вопрос «отличима ли наша неудача от вырезанного
    // сообщения». У НАС — да, список сгоревших номеров лежит на устройстве.
    // У СОБЕСЕДНИКА — нет: он видит ту же дыру, что и от утаивания.
    const stub = installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);

    await sendMessage(alice, BOB, bob.keypair.publicKey, { text: '0' }, null, { pass: PASS });
    stub.next = () => { throw new TypeError('fetch failed'); };
    await expect(
      sendMessage(alice, BOB, bob.keypair.publicKey, { text: '1' }, null, { pass: PASS }),
    ).rejects.toBeTruthy();

    expect(await listBurnedSeqs(ALICE, BOB)).toEqual([1]);
    stub.next = () => new Response(JSON.stringify({ key: '0x00/ok.bin' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    const next = await sendMessage(alice, BOB, bob.keypair.publicKey, { text: '2' }, null, { pass: PASS });
    expect(next.link.seq).toBe(2); // 1 не переиспользуется — он мог доехать

    // И это переживает перезагрузку вкладки: резерв лёг на диск ДО похода на
    // склад, значит новый экземпляр модуля не выдаст номер 1 второй раз.
    vi.resetModules();
    const afterReload = await import('./chatConversation');
    expect(await afterReload.listBurnedSeqs(ALICE, BOB)).toEqual([1]);
    const third = await afterReload.sendMessage(alice, BOB, bob.keypair.publicKey, { text: '3' }, null, { pass: PASS });
    expect(third.link.seq).toBe(3);
  }, 30_000);

  it('список «мешок точно не лёг» заперт числами И поведением (В-6)', async () => {
    // Находка В-6: список кодов не был заперт ничем — добавление постороннего
    // кода давало 0 красных из 71. А на этом списке стоит весь размен «дыра
    // вместо двойного номера»: прежний тест проверял, что код ДОШЁЛ до
    // вызывающего, но не что номер СГОРЕЛ или НЕ сгорел.
    expect([...NOT_STORED_STATUSES].sort((a, b) => a - b)).toEqual([400, 401, 403, 413, 429]);

    const stub = installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);

    // Каждый код из списка: номер возвращается, дырки нет.
    for (const status of [400, 401, 403, 413, 429]) {
      await forgetConversationHead(ALICE, BOB);
      stub.next = () => new Response(JSON.stringify({ error: 'nope', code: `c${status}` }),
        { status, headers: { 'content-type': 'application/json' } });
      await expect(
        sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'нет' }, null, { pass: PASS }),
      ).rejects.toBeTruthy();
      expect({ status, burned: await listBurnedSeqs(ALICE, BOB) }).toEqual({ status, burned: [] });

      stub.next = () => new Response(JSON.stringify({ key: '0x00/ok.bin' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
      const ok = await sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'да' }, null, { pass: PASS });
      expect({ status, seq: ok.link.seq }).toEqual({ status, seq: 0 }); // номер переиспользован
    }

    // 500 в списке НЕТ и быть не должно: за ним может стоять прокси, и мешок
    // мог доехать. Номер обязан сгореть.
    await forgetConversationHead(ALICE, BOB);
    stub.next = () => new Response(JSON.stringify({ error: 'Write error' }),
      { status: 500, headers: { 'content-type': 'application/json' } });
    await expect(
      sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'неизвестно' }, null, { pass: PASS }),
    ).rejects.toBeTruthy();
    expect(await listBurnedSeqs(ALICE, BOB)).toEqual([0]);
  }, 60_000);

  it('кончившееся у СКЛАДА место не превращается в обвинение человеку', async () => {
    // Настоящий дефект, найденный при проверке хуков. У склада кончилось
    // место — он ТОЧНО знает, что мешок не лёг: отвечает `write_failed` и
    // УДАЛЯЕТ недописанный файл (relayer/app.js, `ws.on('error')`). Сомнений
    // нет никаких.
    //
    // А решение «сгорел номер или нет» смотрело на СТАТУС. Статус там 500, а
    // 500 в списке нет — и правильно, что нет: при обычной пятисотке мешок мог
    // и лечь. Итог: номер сгорал, у собеседника оставалась дыра, а дыру
    // отличить от намеренного утаивания нечем (docs/OPEN-ITEMS.md, пункт 34).
    // Человек получал тяжёлое обвинение за чужой кончившийся диск.
    const stub = installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);

    stub.next = () => new Response(
      JSON.stringify({ error: 'Write error', code: 'write_failed' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
    await expect(
      sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'место кончилось' }, null, { pass: PASS }),
    ).rejects.toMatchObject({ code: 'send_failed', status: 500 });

    expect(await listBurnedSeqs(ALICE, BOB)).toEqual([]);  // ни одной дыры
    stub.next = () => new Response(JSON.stringify({ key: '0x00/ok.bin' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    const again = await sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'повтор' }, null, { pass: PASS });
    expect(again.link.seq).toBe(0);                        // номер переиспользован
  });

  it('пятисотка БЕЗ машинного кода — номер всё-таки сгорает: мешок мог лечь', async () => {
    // Обратная сторона той же правки. Код есть — верим коду; кода нет — гадать
    // нельзя, и гадаем в сторону дыры (обвинение в утаивании), а не двойного
    // номера (обвинение в подделке). Тот же размен, что во всём файле.
    const stub = installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    stub.next = () => new Response('<html>502 from proxy</html>',
      { status: 500, headers: { 'content-type': 'text/html' } });
    await expect(
      sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'неизвестно' }, null, { pass: PASS }),
    ).rejects.toBeTruthy();
    expect(await listBurnedSeqs(ALICE, BOB)).toEqual([0]);
  });

  it('общий код (internal_error) НЕ считается точным «не лёг» — и это осознанно', async () => {
    // На сегодняшнем складе все три ветки PUT с `internal_error` тоже удаляют
    // файл, то есть по факту мешок не лёг. Но `internal_error` — КАТЧ-ОЛЛ,
    // тот же код отвечают GET /bags и GET /keys. Читать общий код как точное
    // обещание про ЭТОТ мешок значит вешать гарантию на имя, которое её не
    // давало: первая же будущая ветка, которая успеет сохранить и упасть
    // после, вернёт нам переиспользованный номер — то есть `unordered`,
    // обвинение в ПОДДЕЛКЕ, а оно тяжелее дыры. Цена решения — лишняя дыра в
    // редком случае, и она названа в отчёте.
    const stub = installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    stub.next = () => new Response(JSON.stringify({ error: 'Failed to record bag', code: 'internal_error' }),
      { status: 500, headers: { 'content-type': 'application/json' } });
    await expect(
      sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'общий код' }, null, { pass: PASS }),
    ).rejects.toBeTruthy();
    expect(await listBurnedSeqs(ALICE, BOB)).toEqual([0]);
  });

  it('точные коды склада заперты руками записанным списком', () => {
    // Список кодов заперт числами так же, как список статусов, — но главное
    // про него проверяется ПОВЕДЕНИЕМ выше (сгорел номер или нет), а не
    // составом: состав можно поменять и не заметить.
    expect([...NOT_STORED_CODES].sort()).toEqual(
      ['empty_bag', 'invalid_recipient', 'payload_too_large', 'write_failed'],
    );
  });

  it('список сгоревших номеров не растёт без предела', async () => {
    // Мелочь враждебной проверки: 300 обрывов — 300 записей, и всё это ложится
    // на диск при каждой отправке. Верхняя граница обязана быть, и старое
    // должно вытесняться новым: свежий обрыв человеку интереснее давнего.
    const stub = installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    stub.next = () => { throw new TypeError('fetch failed'); };
    for (let i = 0; i < MAX_BURNED_SEQS + 5; i++) {
      await sendMessage(alice, BOB, bob.keypair.publicKey, { text: `${i}` }, null, { pass: PASS })
        .catch(() => {});
    }
    const burned = await listBurnedSeqs(ALICE, BOB);
    expect(burned).toHaveLength(MAX_BURNED_SEQS);
    expect(burned[burned.length - 1]).toBe(MAX_BURNED_SEQS + 4); // последний обрыв на месте
    expect(burned[0]).toBe(5);                                    // самые давние вытеснены
  }, 120_000);

  it('хранилища нет вовсе — отправка работает, но об этом сказано вслух', async () => {
    installFetchStub();
    delete g.indexedDB;
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const s = await sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'без диска' }, null, { pass: PASS });
    expect(s.link.seq).toBe(0);
    expect(s.persisted).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('чтение головы отказало — отказ, а не молчаливый откат нумерации к нулю', async () => {
    // Молчаливый ноль здесь означал бы второе звено с номером 0 у
    // собеседника: вердикт `unordered`, то есть обвинение в подделке.
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    await sendMessage(alice, BOB, bob.keypair.publicKey, { text: '0' }, null, { pass: PASS });

    g.indexedDB = makeFakeIndexedDB({ failGet: true });
    await expect(
      sendMessage(alice, BOB, bob.keypair.publicKey, { text: '1' }, null, { pass: PASS }),
    ).rejects.toMatchObject({ code: 'head_read_failed' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Обстоятельство 2: диск кончился
// ═══════════════════════════════════════════════════════════════════════════

describe('склад отказал', () => {
  it('500 «Write error» (ENOSPC на релеере) — человек узнаёт, а не «отправлено»', async () => {
    const stub = installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    stub.next = () => new Response(JSON.stringify({ error: 'Write error' }),
      { status: 500, headers: { 'content-type': 'application/json' } });

    let thrown: unknown;
    try {
      await sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'место кончилось' }, null, { pass: PASS });
    } catch (e) { thrown = e; }
    expect(thrown).toBeTruthy();
    expect((thrown as { status?: number }).status ?? (thrown as { cause?: { status?: number } }).cause?.status).toBe(500);
  });

  it('запись головы на устройство не удалась — сообщение всё равно ушло, но сказано вслух', async () => {
    installFetchStub();
    g.indexedDB = makeFakeIndexedDB({ failPut: true });
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const s = await sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'квота' }, null, { pass: PASS });
    expect(s.link.seq).toBe(0);
    expect(s.persisted).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('квота кончилась — нумерация НЕ откатывается к нулю на каждом сообщении', async () => {
    // Дыра в первой реализации: запасная голова в памяти вкладки ЗАПИСЫВАЛАСЬ
    // при неудачной записи на диск, но ЧИТАЛАСЬ только когда хранилища нет
    // ВОВСЕ. То есть при кончившейся квоте каждое сообщение получало номер 0
    // заново — а у собеседника это вердикт `unordered`, обвинение в ПОДДЕЛКЕ
    // за кончившееся место. Собственная починка оказалась бы хуже дефекта.
    installFetchStub();
    g.indexedDB = makeFakeIndexedDB({ failPut: true });
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const a = await sendMessage(alice, BOB, bob.keypair.publicKey, { text: '0' }, null, { pass: PASS });
    const b = await sendMessage(alice, BOB, bob.keypair.publicKey, { text: '1' }, null, { pass: PASS });
    const c = await sendMessage(alice, BOB, bob.keypair.publicKey, { text: '2' }, null, { pass: PASS });
    expect([a.link.seq, b.link.seq, c.link.seq]).toEqual([0, 1, 2]);
    expect(a.persisted).toBe(false);
    expect(verifyChain([a.link, b.link, c.link])).toMatchObject({ ok: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Обстоятельство 4: пришёл мусор
// ═══════════════════════════════════════════════════════════════════════════

describe('мусор на приёме — вердикт, а не падение', () => {
  let alice: ChatSession;
  let bob: ChatSession;
  let good: SentMessage[];

  beforeEach(async () => {
    installFetchStub();
    alice = await makeSession('1c3d', ALICE);
    bob = await makeSession('7f2e', BOB);
    good = await conversationFrom(bob, alice, ['честное']);
  });

  it('мешок вообще не кадр (случайные байты)', async () => {
    const state = await receiveBags(alice, [
      { key: 'k1', sender: BOB.toLowerCase() as `0x${string}`, uploadedAt: 1, body: new Uint8Array(300).fill(0xab) },
      bagOf(good[0], BOB, 2),
    ]);
    expect(state.troubles).toContainEqual(expect.objectContaining({ kind: 'malformed', key: 'k1' }));
    expect(state.messages).toHaveLength(1);
  });

  it('кадр верной формы, но внутри не конверт', async () => {
    const signer = await deriveLinkSigningKeypair(bob.keypair);
    const envelope = new Uint8Array(200).fill(0x11);
    const link: ChainLink = {
      seq: 0, prevHash: GENESIS_HASH,
      bodyHash: messageBodyHash(signer.publicKey, envelope),
      sender: BOB.toLowerCase() as `0x${string}`, sentAt: 1_754_400_000_000,
    };
    const sodium = (await import('libsodium-wrappers')).default;
    await sodium.ready;
    const signature = sodium.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey);
    const body = encodeFrame({ link, signature, signerPublicKey: signer.publicKey, envelope });

    const state = await receiveBags(alice, [{ key: 'k2', sender: BOB.toLowerCase() as `0x${string}`, uploadedAt: 1, body }]);
    // Звено честное и подписанное — цепочка цела; вскрыть нечего.
    expect(state.troubles).toContainEqual(expect.objectContaining({ kind: 'undecryptable', seq: 0 }));
    expect(state.chains[BOB.toLowerCase()]).toMatchObject({ ok: true });
  });

  it('два звена с одним номером — duplicate_seq, а не развал всей цепочки', async () => {
    // Голова снимается, чтобы отправка честно выдала номер 0 второй раз —
    // ровно то, что увидит жертва от собеседника, у которого почистилось
    // хранилище (или который делает это нарочно).
    await forgetConversationHead(BOB, ALICE);
    const twin = await conversationFrom(bob, alice, ['двойник']);
    const state = await receiveBags(alice, [bagOf(good[0], BOB, 1), bagOf(twin[0], BOB, 2)]);
    expect(state.troubles).toContainEqual(expect.objectContaining({ kind: 'duplicate_seq', seq: 0 }));
    expect(state.messages).toHaveLength(1);
    expect(state.chains[BOB.toLowerCase()]).toMatchObject({ ok: true });
  });

  it('номера с дырой в тысячу — назван разрыв, а не тысяча пустых мест', async () => {
    const signer = await deriveLinkSigningKeypair(bob.keypair);
    const sodium = (await import('libsodium-wrappers')).default;
    await sodium.ready;
    // Автор передаётся четвёртым аргументом — как это делает настоящая
    // отправка (В-1). Без него конверт не расшифруется у получателя, и тест
    // мерил бы не дыру в номерах, а невозможность прочитать.
    const envelope = await packEnvelope(
      { text: 'далеко' }, alice.keypair.publicKey, bob.keypair.publicKey, BOB.toLowerCase() as `0x${string}`,
    );
    const link: ChainLink = {
      seq: 1000, prevHash: keccak256(stringToBytes('чужое')),
      bodyHash: messageBodyHash(signer.publicKey, envelope),
      sender: BOB.toLowerCase() as `0x${string}`, sentAt: 1_754_400_000_000,
    };
    const body = encodeFrame({
      link, signature: sodium.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey),
      signerPublicKey: signer.publicKey, envelope,
    });
    const state = await receiveBags(alice, [
      bagOf(good[0], BOB, 1),
      { key: 'k3', sender: BOB.toLowerCase() as `0x${string}`, uploadedAt: 2, body },
    ]);
    expect(state.gapAfterSeq).toEqual([0]);
    expect(state.messages).toHaveLength(2);
  });

  it('звено, ссылающееся само на себя — вердикт, не зацикливание', async () => {
    const signer = await deriveLinkSigningKeypair(bob.keypair);
    const sodium = (await import('libsodium-wrappers')).default;
    await sodium.ready;
    const envelope = await packEnvelope({ text: 'сам себе' }, alice.keypair.publicKey, bob.keypair.publicKey);
    const bodyHash = messageBodyHash(signer.publicKey, envelope);
    // prevHash = отпечаток самого себя посчитать нельзя (он зависит от
    // prevHash) — берём отпечаток звена с теми же полями и нулевым prevHash:
    // ближайшее к «ссылается на себя», что вообще может существовать.
    const selfish: ChainLink = {
      seq: 0, prevHash: bodyHash, bodyHash,
      sender: BOB.toLowerCase() as `0x${string}`, sentAt: 1_754_400_000_000,
    };
    const body = encodeFrame({
      link: selfish, signature: sodium.crypto_sign_detached(linkSignaturePreimage(selfish), signer.privateKey),
      signerPublicKey: signer.publicKey, envelope,
    });
    const state = await receiveBags(alice, [
      { key: 'k4', sender: BOB.toLowerCase() as `0x${string}`, uploadedAt: 1, body },
    ]);
    // Первое звено обязано ссылаться на генезис — не на что попало.
    expect(state.chains[BOB.toLowerCase()]).toMatchObject({ ok: false, reason: 'broken' });
  });

  it('отрицательный номер закодировать нельзя, а пришедший — не разбирается', async () => {
    const f = {
      link: { seq: 0, prevHash: GENESIS_HASH, bodyHash: GENESIS_HASH, sender: BOB.toLowerCase() as `0x${string}`, sentAt: 1 },
      signature: new Uint8Array(LINK_SIGNATURE_LEN), signerPublicKey: new Uint8Array(32),
      envelope: new Uint8Array([1]),
    };
    expect(() => encodeFrame({ ...f, link: { ...f.link, seq: -1 } })).toThrow(/seq/i);
    // Пришедшее «отрицательное» — это старший бит uint32; разбор обязан дать
    // неотрицательное число, а не −1.
    const bytes = encodeFrame(f);
    new DataView(bytes.buffer, bytes.byteOffset).setInt32(97, -1);
    expect(decodeFrame(bytes)!.link.seq).toBe(4_294_967_295);
  });

  it('bags вообще не массив — TypeError (наш мусор), а не тихий пустой разговор', async () => {
    await expect(receiveBags(alice, null as unknown as IncomingBag[])).rejects.toBeInstanceOf(TypeError);
    await expect(receiveBags(alice, {} as unknown as IncomingBag[])).rejects.toBeInstanceOf(TypeError);
  });

  it('элемент списка мешков — не мешок', async () => {
    const state = await receiveBags(alice, [
      null as unknown as IncomingBag,
      { key: 'k5', sender: 'не адрес' as `0x${string}`, uploadedAt: 1, body: new Uint8Array(300) },
      bagOf(good[0], BOB, 2),
    ]);
    expect(state.messages).toHaveLength(1);
    expect(state.troubles.filter(t => t.kind === 'malformed')).toHaveLength(2);
  });

  it('пустой список мешков — пустой разговор, без вердиктов и без разрывов', async () => {
    const state = await receiveBags(alice, []);
    // Сравнение ЦЕЛИКОМ, а не по полям: новое поле в наружном виде обязано
    // проехать через этот тест и быть замечено, а не тихо появиться.
    expect(state).toEqual({ messages: [], gaps: [], gapAfterSeq: [], chains: {}, troubles: [] });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Обстоятельство 5: долбят нарочно
// ═══════════════════════════════════════════════════════════════════════════

describe('тысяча мешков', () => {
  it('тысяча честных мешков разбирается за разумное время, порядок цел', async () => {
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const sent = await conversationFrom(bob, alice, Array.from({ length: 1000 }, (_, i) => `${i}`));

    const bags = sent.map((s, i) => bagOf(s, BOB, 1_000 + i));
    for (let i = bags.length - 1; i > 0; i--) { // перемешать доставку
      const j = (i * 7919) % (i + 1);
      [bags[i], bags[j]] = [bags[j], bags[i]];
    }
    const started = Date.now();
    const state = await receiveBags(alice, bags);
    const elapsed = Date.now() - started;

    expect(state.messages).toHaveLength(1000);
    expect(state.messages.map(m => m.seq)).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    expect(state.gapAfterSeq).toEqual([]);
    // Замер печатается в отчёт задачи; порог заведомо щедрый, чтобы тест не
    // мигал на медленной машине — он ловит алгоритм, а не микросекунды.
    console.info(`[замер] приём 1000 мешков: ${elapsed} мс`);
    expect(elapsed).toBeLessThan(120_000);
  }, 300_000);

  it('тысяча невскрываемых мешков разбирается без сообщений и без падения (цена — в отчёте)', async () => {
    // ⚠️ Прежнее название обещало «не дороже честных» и НИЧЕГО НИ С ЧЕМ НЕ
    // СРАВНИВАЛО, а само утверждение оказалось ложным (замер проверяющего:
    // 624 мс против 520, дороже на пятую часть — невскрытый мешок платит за
    // ДВЕ неудачные попытки открыть слот, честный за одну удачную). Название
    // приведено к тому, что тест делает; цена честно названа замером ниже.
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const carol = await makeSession('9b4a', CAROL);
    // Боб честно подписывает 1000 звеньев, но запечатывает всё на Кэрол:
    // Алиса не вскроет ни одного. Это самый дешёвый для нападающего способ
    // заставить жертву работать.
    const sent: SentMessage[] = [];
    let prev: ChainLink | null = null;
    for (let i = 0; i < 1000; i++) {
      const s = await sendMessage(bob, ALICE, carol.keypair.publicKey, { text: `${i}` }, prev, { pass: PASS });
      sent.push(s); prev = s.link;
    }
    const started = Date.now();
    const state = await receiveBags(alice, sent.map((s, i) => bagOf(s, BOB, i)));
    const elapsed = Date.now() - started;
    console.info(`[замер] приём 1000 невскрываемых мешков: ${elapsed} мс`);
    expect(state.messages).toHaveLength(0);
    expect(state.troubles.filter(t => t.kind === 'undecryptable')).toHaveLength(1000);
    expect(elapsed).toBeLessThan(120_000);
  }, 300_000);

  it('двести мешков с мусорной подписью — НОЛЬ обращений к расшифровке', async () => {
    // ⚠️ Прежняя версия печатала время и НЕ НАБЛЮДАЛА главного: что расшифровка
    // не звалась (находка В-8). Свойство было верным, но запирал его шпион
    // проверяющего, а не этот тест. Плюс в названии стояла тысяча, а мешков
    // было двести — число приведено к правде.
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const sent = await conversationFrom(bob, alice, Array.from({ length: 200 }, (_, i) => `${i}`));
    const bags = sent.map((s, i) => {
      const bag = bagOf(s, BOB, i);
      bag.body = new Uint8Array(bag.body);
      bag.body[33] ^= 0xff;
      return bag;
    });

    // Расшифровка — единственное по-настоящему дорогое место разбора. Считаем
    // её вызовы напрямую: замер времени сказал бы «быстро», а не «не звалось».
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    try {
      const started = Date.now();
      const state = await receiveBags(alice, bags);
      console.info(`[замер] приём 200 мешков с мусорной подписью: ${Date.now() - started} мс`);
      expect(state.troubles.filter(t => t.kind === 'bad_signature')).toHaveLength(200);
      expect(state.messages).toHaveLength(0);
      expect(decrypt).toHaveBeenCalledTimes(0);
    } finally {
      decrypt.mockRestore();
    }
  }, 300_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Свойство 3 (главная проверка плана): вырезанное сообщение видно.
// НА СКВОЗНОМ СТЕНДЕ — настоящий релеер, настоящие кошельки, настоящий
// транспорт. План требует этого прямо: «свойство 3 — обязательно на стенде
// из задачи 1, а не на заглушках».
// ═══════════════════════════════════════════════════════════════════════════

describe('вырезанное сообщение видно (сквозной стенд)', () => {
  it('мешок из СЕРЕДИНЫ убран со склада — разрыв назван по номеру', async () => {
    const { startChatStand } = await import('./__stand__/chatStand');
    const stand = await startChatStand();
    try {
      process.env.NEXT_PUBLIC_RELAYER_URL = stand.url;
      vi.resetModules();
      const transport = await import('./chatTransport');
      const conv = await import('./chatConversation');

      const [aliceWallet, bobWallet] = stand.wallets;
      const aliceAddr = aliceWallet.address as `0x${string}`;
      const bobAddr = bobWallet.address as `0x${string}`;
      const aliceSession = await makeSession('1c3d', aliceAddr);
      const bobSession = await makeSession('7f2e', bobAddr);

      const bobPass = await transport.requestBagPass(m => bobWallet.signMessage(m), bobAddr);
      const alicePass = await transport.requestBagPass(m => aliceWallet.signMessage(m), aliceAddr);

      // Боб пишет пять сообщений НАСТОЯЩИМ проводом.
      let prev: ChainLink | null = null;
      const sentKeys: string[] = [];
      for (let i = 0; i < 5; i++) {
        const s: SentMessage = await conv.sendMessage(
          bobSession, aliceAddr, aliceSession.keypair.publicKey, { text: `сообщение ${i}` }, prev,
          { pass: bobPass.pass },
        );
        sentKeys.push(s.key);
        prev = s.link;
      }

      // Алиса забирает всё, что реально лежит на складе.
      async function fetchAll(skipKeys: string[] = []) {
        const list = await transport.listBags(alicePass.pass);
        const bags: IncomingBag[] = [];
        for (const b of list.inbox) {
          if (skipKeys.includes(b.key)) continue; // «мешок вырезали»
          const body = await transport.fetchBag(alicePass.pass, b.key);
          if (body) bags.push({ key: b.key, sender: b.sender, uploadedAt: b.uploadedAt, body });
        }
        return bags;
      }

      const whole = await conv.receiveBags(aliceSession, await fetchAll());
      expect(whole.messages).toHaveLength(5);
      expect(whole.gapAfterSeq).toEqual([]);

      // ─── вырезано из СЕРЕДИНЫ ───
      const cutMiddle = await conv.receiveBags(aliceSession, await fetchAll([sentKeys[2]]));
      expect(cutMiddle.gapAfterSeq).toEqual([1]);          // пропало то, что после 1-го
      expect(cutMiddle.messages.map(m => m.seq)).toEqual([0, 1, 3, 4]);
      expect(cutMiddle.chains[bobAddr.toLowerCase()]).toMatchObject({ ok: false, reason: 'gap' });

      // ─── вырезано ПЕРВОЕ ───
      const cutFirst = await conv.receiveBags(aliceSession, await fetchAll([sentKeys[0]]));
      expect(cutFirst.gapAfterSeq).toEqual([-1]);          // −1 = «начало не предъявлено»
      expect(cutFirst.chains[bobAddr.toLowerCase()]).toMatchObject({ ok: false, reason: 'gap' });

      // ─── вырезано ПОСЛЕДНЕЕ ───
      // Правда, а не обещание (§5 общей спеки): обрезанный ХВОСТ цепочкой не
      // ловится — содержимое последнего звена не покрыто ничьим отпечатком.
      // Ловится только якорем, а якорь — план 4. Тест запирает это ЯВНО,
      // чтобы никто не прочитал зелёный вердикт как «предъявлено всё».
      const cutLast = await conv.receiveBags(aliceSession, await fetchAll([sentKeys[4]]));
      expect(cutLast.gapAfterSeq).toEqual([]);
      expect(cutLast.chains[bobAddr.toLowerCase()]).toMatchObject({ ok: true });
      expect((cutLast.chains[bobAddr.toLowerCase()] as { unverifiedContentAtSeq: number[] })
        .unverifiedContentAtSeq).toEqual([0, 1, 2, 3]); // «не заверено НИЧЕГО из показанного»
    } finally {
      await stand.stop();
      delete process.env.NEXT_PUBLIC_RELAYER_URL;
    }
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Служебное: снятие головы
// ═══════════════════════════════════════════════════════════════════════════

describe('голова разговора на устройстве', () => {
  it('forgetConversationHead действительно убирает — следующая отправка начинает с нуля', async () => {
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    await sendMessage(alice, BOB, bob.keypair.publicKey, { text: '0' }, null, { pass: PASS });
    await sendMessage(alice, BOB, bob.keypair.publicKey, { text: '1' }, null, { pass: PASS });
    expect((await readConversationHead(ALICE, BOB))!.link.seq).toBe(1);

    await forgetConversationHead(ALICE, BOB);
    expect(await readConversationHead(ALICE, BOB)).toBeNull();
    const again = await sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'заново' }, null, { pass: PASS });
    expect(again.link.seq).toBe(0);
  });

  it('forgetConversationHead убирает и ЗАПАСНУЮ голову, а не только диск', async () => {
    // Иначе «забыто» — неправда: при кончившейся квоте нумерация живёт в
    // памяти вкладки, и снятие отчиталось бы об успехе, ничего не сняв.
    installFetchStub();
    g.indexedDB = makeFakeIndexedDB({ failPut: true });
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    await sendMessage(alice, BOB, bob.keypair.publicKey, { text: '0' }, null, { pass: PASS });
    const second = await sendMessage(alice, BOB, bob.keypair.publicKey, { text: '1' }, null, { pass: PASS });
    expect(second.link.seq).toBe(1);

    await forgetConversationHead(ALICE, BOB);
    const again = await sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'заново' }, null, { pass: PASS });
    expect(again.link.seq).toBe(0);
  });

  it('кривой адрес получает вердикт, а не мусорную запись', async () => {
    await expect(readConversationHead('0x' as `0x${string}`, BOB)).rejects.toMatchObject({ code: 'address_malformed' });
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    await expect(
      sendMessage(alice, 'не адрес' as `0x${string}`, bob.keypair.publicKey, { text: 'x' }, null, { pass: PASS }),
    ).rejects.toMatchObject({ code: 'address_malformed' });
  });

  it('открытый ключ собеседника не той формы — вердикт, а не запечатывание в никуда', async () => {
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    await expect(
      sendMessage(alice, BOB, new Uint8Array(31), { text: 'x' }, null, { pass: PASS }),
    ).rejects.toMatchObject({ code: 'peer_key_malformed' });
    await expect(
      sendMessage(alice, BOB, 'ключ' as unknown as Uint8Array, { text: 'x' }, null, { pass: PASS }),
    ).rejects.toMatchObject({ code: 'peer_key_malformed' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Пин подписного ключа
// ═══════════════════════════════════════════════════════════════════════════

describe('подписной ключ собеседника', () => {
  it('пин снаружи (из справочника) — чужой подписной ключ отвергается', async () => {
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const carol = await makeSession('9b4a', CAROL);
    const sent = await conversationFrom(bob, alice, ['от Боба']);
    const carolSigner = await deriveLinkSigningKeypair(carol.keypair);

    const state = await receiveBags(alice, [bagOf(sent[0], BOB, 1)], {
      peerSigningPublicKeys: { [BOB.toLowerCase()]: carolSigner.publicKey },
    });
    expect(state.troubles).toContainEqual(expect.objectContaining({ kind: 'signer_unexpected' }));
    expect(state.messages).toHaveLength(0);
  });

  it('пин НЕ той длины отвергается — в ОБЕ стороны, включая ДЛИННЕЕ настоящего (В-7)', async () => {
    // Находка В-7: сравнение байт без проверки длины не было заперто ничем.
    //
    // ⚠️ И первая моя попытка запереть его тоже была слепой: я подал пин на
    // байт КОРОЧЕ, а цикл сравнения идёт по длине ПЕРВОГО аргумента (32 байта
    // настоящего ключа) — `b[31]` оказывается `undefined`, `a[31] ^ undefined`
    // даёт `a[31]`, то есть неравенство находится и БЕЗ проверки длины.
    // Мутация «снять проверку длины» так и осталась 0 красных из 138.
    //
    // Опасна ДРУГАЯ сторона: пин ДЛИННЕЕ настоящего, чьи первые 32 байта
    // совпадают. Тогда цикл проходит ровно 32 сравнения, все сходятся, и без
    // проверки длины чужой ключ с приписанным хвостом принимается как свой.
    // Именно это и придёт из справочника задачи 6: значение там строковое, и
    // лишние hex-цифры — самая естественная порча.
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const sent = await conversationFrom(bob, alice, ['от Боба', 'и ещё']);
    const real = (await deriveLinkSigningKeypair(bob.keypair)).publicKey;

    const longer = new Uint8Array(33);
    longer.set(real, 0);
    longer[32] = 0xff; // те же 32 байта плюс приписанный хвост
    const withLonger = await receiveBags(alice, sent.map((s, i) => bagOf(s, BOB, i)), {
      peerSigningPublicKeys: { [BOB.toLowerCase()]: longer },
    });
    expect(withLonger.troubles.filter(t => t.kind === 'signer_unexpected')).toHaveLength(2);
    expect(withLonger.messages).toHaveLength(0);

    // Короче — тоже отвергается (эта сторона держалась бы и без проверки, но
    // обе стороны границы обязаны быть заперты).
    const withShorter = await receiveBags(alice, sent.map((s, i) => bagOf(s, BOB, i)), {
      peerSigningPublicKeys: { [BOB.toLowerCase()]: real.slice(0, 31) },
    });
    expect(withShorter.messages).toHaveLength(0);

    // И контроль: настоящий ключ той же длины по-прежнему ПРИНИМАЕТСЯ —
    // иначе тест краснел бы на чём угодно, включая «пин не работает вовсе».
    const withReal = await receiveBags(alice, sent.map((s, i) => bagOf(s, BOB, i)), {
      peerSigningPublicKeys: { [BOB.toLowerCase()]: real },
    });
    expect(withReal.messages).toHaveLength(2);
    expect(withReal.troubles).toEqual([]);
  });

  it('без пина ключ прибивается к первому звену — смена ключа посреди переписки видна', async () => {
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const bobNewKey = await makeSession('3d51', BOB); // тот же адрес, ДРУГОЙ ключ чата
    const first = await conversationFrom(bob, alice, ['я Боб']);
    const second = await sendMessage(
      bobNewKey, ALICE, alice.keypair.publicKey, { text: 'я тоже Боб?' }, first[0].link, { pass: PASS },
    );

    const state = await receiveBags(alice, [bagOf(first[0], BOB, 1), bagOf(second, BOB, 2)]);
    expect(state.troubles).toContainEqual(expect.objectContaining({ kind: 'signer_changed' }));
    expect(state.messages.map(m => (m.payload as ChatPayload).text)).toEqual(['я Боб']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Галочка «дошло до устройства»
// ═══════════════════════════════════════════════════════════════════════════

describe('галочка дошло/не дошло', () => {
  it('свои сообщения несут delivered из ответа склада; чужие — всегда true', async () => {
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const mine = await conversationFrom(alice, bob, ['ушло', 'ещё ушло']);
    const theirs = await conversationFrom(bob, alice, ['пришло']);

    const state = await receiveBags(alice, [bagOf(theirs[0], BOB, 1)], {
      own: mine,
      deliveredKeys: [mine[0].key], // склад сказал: первое забрали, второе — нет
    });
    const byText = Object.fromEntries(state.messages.map(m => [(m.payload as ChatPayload).text, m.delivered]));
    expect(byText['ушло']).toBe(true);
    expect(byText['ещё ушло']).toBe(false);
    expect(byText['пришло']).toBe(true);
  });

  it('свои сообщения ДРУГОМУ собеседнику не попадают в этот разговор', async () => {
    // `own` приходит списком; без собственного поля «кому» модуль не мог бы
    // отсеять чужой разговор, и переписка с Бобом показала бы сообщения,
    // отправленные Кэрол. Собеседник в `SentMessage` — не украшение.
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const carol = await makeSession('9b4a', CAROL);
    const toBob = await conversationFrom(alice, bob, ['Бобу']);
    const toCarol = await conversationFrom(alice, carol, ['Кэрол']);

    const state = await receiveBags(alice, [], { peer: BOB, own: [...toBob, ...toCarol] });
    expect(state.messages.map(m => (m.payload as ChatPayload).text)).toEqual(['Бобу']);
    expect(toBob[0].peer).toBe(BOB.toLowerCase());
    expect(toCarol[0].peer).toBe(CAROL.toLowerCase());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Доказательства собеседника (В-4): без них не собрать «копию контрагента»
// ═══════════════════════════════════════════════════════════════════════════

describe('доказательства на принятых сообщениях', () => {
  it('принятое сообщение несёт звено, подпись, подписной ключ и байты кадра', async () => {
    // Находка В-4: наружу отдавались только номер, автор, время, содержимое и
    // признак доставки. Значит предъявить арбитру можно было ТОЛЬКО СВОЁ, а
    // «копию контрагента», на которой стоит весь §5 общей спеки и весь план 4,
    // этим видом не собрать вовсе.
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const sent = await conversationFrom(bob, alice, ['доказуемое']);

    const state = await receiveBags(alice, [bagOf(sent[0], BOB, 1)]);
    const proof = state.messages[0].proof!;
    expect(proof).toBeDefined();
    expect(proof.link).toEqual(sent[0].link);
    expect(hex(proof.signature)).toBe(hex(sent[0].signature));
    expect(hex(proof.signerPublicKey)).toBe(hex(sent[0].signerPublicKey));
    expect(hex(proof.frame)).toBe(hex(sent[0].frame));

    // И этого достаточно, чтобы проверить подпись заново, ничего не спрашивая
    // у отправителя — то есть предъявленное самодостаточно.
    const sodium = (await import('libsodium-wrappers')).default;
    await sodium.ready;
    expect(sodium.crypto_sign_verify_detached(
      proof.signature, linkSignaturePreimage(proof.link), proof.signerPublicKey,
    )).toBe(true);
  });

  it('своя половина, приехавшая СО СКЛАДА, не двоится с той, что помнит вкладка', async () => {
    // Задача 7 сделала свою половину переписки достижимой с сервера (поле
    // отправителя в описи). Значит те же самые сообщения теперь приезжают
    // ДВАЖДЫ: мешком из ящика и списком `own` из памяти вкладки. Без сверки
    // человек увидел бы каждое своё сообщение в двух экземплярах — и это не
    // косметика: `gaps` и вердикты считаются по тому же ряду.
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const mine = await conversationFrom(alice, bob, ['моё-0', 'моё-1']);

    // Склад отдаёт наши же мешки: отправитель засвидетельствован как МЫ САМИ.
    const state = await receiveBags(
      alice, mine.map((s, i) => bagOf(s, ALICE, 100 + i)), { own: mine, peer: BOB },
    );

    expect(state.messages.map(m => (m.payload as ChatPayload).text)).toEqual(['моё-0', 'моё-1']);
    expect(state.messages).toHaveLength(2);
    // И ни одного разрыва: одна и та же пара звеньев, посчитанная дважды, не
    // должна выглядеть ни дырой, ни двойным номером.
    expect(state.gaps).toEqual([]);
    expect(state.troubles).toEqual([]);

    // ⚠️ И БЕЗ `peer` тоже. С заданным собеседником свои мешки отсеиваются
    // фильтром ящика — то есть тот случай держится сам собой и ничего не
    // доказывает. Опасен разбор ВСЕГО ящика, где свои мешки доходят до
    // разбора наравне с чужими.
    const whole = await receiveBags(alice, mine.map((s, i) => bagOf(s, ALICE, 100 + i)), { own: mine });
    expect(whole.messages.map(m => (m.payload as ChatPayload).text)).toEqual(['моё-0', 'моё-1']);
    expect(whole.gaps).toEqual([]);
  });

  it('своё отправленное несёт то же самое — обе половины предъявляются одинаково', async () => {
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const mine = await conversationFrom(alice, bob, ['моё']);
    const state = await receiveBags(alice, [], { own: mine, peer: BOB });
    expect(hex(state.messages[0].proof!.frame)).toBe(hex(mine[0].frame));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Метка сделки доезжает внутри запечатанного (готовим план 4)
// ═══════════════════════════════════════════════════════════════════════════

describe('метка сделки', () => {
  it('доезжает до получателя и НЕ встречается в байтах мешка', async () => {
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const DEAL = '0x760F07367888C62f7c2Dfb619A5e534132855ce5' as const;
    const sent = await sendMessage(
      bob, ALICE, alice.keypair.publicKey, { text: 'по сделке', dealId: DEAL }, null, { pass: PASS },
    );
    const hay = Buffer.from(sent.frame).toString('hex');
    expect(hay).not.toContain(DEAL.slice(2).toLowerCase());

    const state = await receiveBags(alice, [bagOf(sent, BOB, 1)]);
    expect((state.messages[0].payload as ChatPayload).dealId?.toLowerCase()).toBe(DEAL.toLowerCase());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Замок на то, что мешок — это РОВНО кадр, а не «что-то похожее»
// ═══════════════════════════════════════════════════════════════════════════

describe('что уходит на склад', () => {
  it('на склад уходят РОВНО байты кадра, тем же получателем', async () => {
    const stub = installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const sent = await sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'на провод' }, null, { pass: PASS });
    const put = stub.calls.find(c => c.method === 'PUT')!;
    expect(put.url).toContain(`/bags/${BOB.toLowerCase()}`);
    expect(hex(put.body!)).toBe(hex(sent.frame));
    expect(decodeFrame(put.body!)!.link).toEqual(sent.link);
  });

  it('sealForRecipient реально позван на ключ СОБЕСЕДНИКА, а не на свой дважды', async () => {
    // Мутация «оба конверта на себя» иначе прошла бы: отправитель читает
    // собственную копию и не замечает, что собеседник не прочтёт ничего.
    installFetchStub();
    const alice = await makeSession('1c3d', ALICE);
    const bob = await makeSession('7f2e', BOB);
    const sent = await sendMessage(alice, BOB, bob.keypair.publicKey, { text: 'проверка' }, null, { pass: PASS });
    const state = await receiveBags(bob, [bagOf(sent, ALICE, 1)]);
    expect((state.messages[0].payload as ChatPayload).text).toBe('проверка');
  });
});
