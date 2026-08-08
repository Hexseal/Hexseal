/**
 * useChatSession.test.ts — справочник ключей и то, что сеанс обязан донести.
 *
 * Задача 6 плана «Клиент чата», дополнительные пункты А и В:
 *
 *  А. Задача 5 вывела подписную пару (Ed25519) отдельным под-ключом и
 *     подписывает ею звенья, но НИКТО ЕЁ НЕ ПУБЛИКУЕТ. Справочник Задачи 2
 *     держит место (`signKey`, 32 байта), `receiveBags` принимает пин —
 *     проводки нет. Пока её нет, проверка подписи ловит подмену ОДНОГО
 *     звена и НЕ ловит переписанную целиком цепочку чужим ключом. Это
 *     несущая дыра.
 *
 *  В. Сеанс отдаёт `persisted: false` и `storageIssue` (приватный режим,
 *     кончившаяся квота, соседняя вкладка держит базу). Сегодня их никто не
 *     читает — человек получает окно подписи при каждой перезагрузке и не
 *     знает почему.
 *
 * ⚠️ Тесты трогают ТОЛЬКО чистые функции модуля. Хука-обёртки здесь нет и
 * быть не может: у фронта нет ни jsdom, ни @testing-library — `npm test`
 * берёт vitest у релеера, окружение `node` (см. vitest.config.mjs). Значит
 * дисциплина такая: вся логика живёт в чистых функциях, которые тестируются,
 * а React-обёртка сведена к состоянию и одному вызову. Всё, что нельзя
 * проверить, обязано быть тривиальным — а не наоборот.
 *
 * Сеансы здесь собираются ЛИТЕРАЛОМ, а не через `openSession`: тот сейчас
 * идёт пятый круг правок (признак рода кошелька), и привязываться к его
 * внутренностям значило бы красить свои тесты от чужой работы. Ключи при
 * этом настоящие — `deriveChatKeypair` из ядра, не выдуманные байты.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveChatKeypair } from '@/lib/chatCrypto';
import type { ChatSession } from '@/lib/chatSession';
import { sendMessage, receiveBags, deriveLinkSigningKeypair, encodeFrame, messageBodyHash, linkSignaturePreimage } from '@/lib/chatConversation';
import { buildLink } from '@/lib/chatChain';
import { packEnvelope } from '@/lib/chatEnvelope';
import { _resetBagPassCacheForTest } from '@/lib/chatTransport';
import {
  publishChatKeys, fetchPeerChatKeys, sessionStorageNotice,
  getBagPass, signChatKeyLocked,
  ChatDirectoryError,
  type PeerChatKeys,
} from './useChatSession';

const ALICE = '0xA1cE00000000000000000000000000000000CAfE' as const;
const BOB   = '0xB0b1000000000000000000000000000000005eEd' as const;

/** Подписи РОВНО той формы, что отдаёт кошелёк (65 байт, 0x + 130 hex). */
function sig(fill: string): `0x${string}` {
  return ('0x' + fill.repeat(130).slice(0, 130)) as `0x${string}`;
}

async function makeSession(address: `0x${string}`, seed: string): Promise<ChatSession> {
  return {
    keypair: await deriveChatKeypair(sig(seed)),
    address,
    origin: 'signature',
    walletKind: 'eoa',
    restored: false,
    persisted: true,
  };
}

function hexOf(bytes: Uint8Array): string {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetBagPassCacheForTest();
});

/* ───────────── А. проводка подписного ключа в справочник ───────────── */

describe('публикация ключей: справочник получает ОБА, не один', () => {
  it('publishChatKeys кладёт boxKey и signKey — и signKey это настоящая открытая половина Ed25519', async () => {
    // Что красит: сегодня публикации нет вовсе. Когда появится — снятие
    // `signKey` из тела красит именно этот тест: тело поедет с одним полем.
    const session = await makeSession(ALICE, 'a1');
    const signer = await deriveLinkSigningKeypair(session.keypair);

    let body: unknown;
    let headers: Record<string, string> = {};
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      headers = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ address: ALICE.toLowerCase() }), { status: 200 });
    }));

    await publishChatKeys('v1.pass', session);

    expect(body).toEqual({
      boxKey: hexOf(session.keypair.publicKey),
      signKey: hexOf(signer.publicKey),
    });
    // Пропуск обязателен: адрес сервер берёт ИЗ НЕГО, а не из тела.
    expect(headers['x-bag-pass']).toBe('v1.pass');
    // Форма, которую сервер реально принимает (relayer/directory.js): 0x + 64
    // нижнерегистровых hex-цифры. Записана руками, не взята из модуля.
    expect(String((body as { signKey: string }).signKey)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('отказ справочника поднимается кодом, а не английским текстом', async () => {
    const session = await makeSession(ALICE, 'a1');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'Directory unavailable', code: 'directory_unavailable' }),
      { status: 503 },
    )));

    await expect(publishChatKeys('v1.pass', session)).rejects.toMatchObject({
      code: 'directory_unavailable',
      status: 503,
    });
  });

  it('fetchPeerChatKeys отдаёт обе половины разобранными в байты', async () => {
    const boxKey = '0x' + '11'.repeat(32);
    const signKey = '0x' + '22'.repeat(32);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ address: BOB.toLowerCase(), boxKey, signKey, updatedAt: 1, history: [], keyChangeCount: 0 }),
      { status: 200 },
    )));

    const keys: PeerChatKeys = await fetchPeerChatKeys(BOB);
    expect(keys.boxKey).toBeInstanceOf(Uint8Array);
    expect(keys.boxKey).toHaveLength(32);
    expect(keys.signKey).toBeInstanceOf(Uint8Array);
    expect(hexOf(keys.signKey as Uint8Array)).toBe(signKey);
  });

  it('«собеседник ещё не заходил» — отдельный код, не пустой ответ и не падение', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'No key for address', code: 'key_not_found' }), { status: 404 },
    )));
    await expect(fetchPeerChatKeys(BOB)).rejects.toMatchObject({ code: 'peer_unknown' });
  });

  it('справочник отдал ключ НЕ ТОЙ ДЛИНЫ — вердикт, а не падение и не молчаливое использование', async () => {
    // Вопрос «пришёл мусор». 31 байт — на один меньше, чем нужно; libsodium
    // молча принял бы строку ровно в 32 UTF-8 байта, поэтому форма
    // проверяется здесь, а не «как-нибудь потом».
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ boxKey: '0x' + '11'.repeat(31), signKey: '0x' + '22'.repeat(32) }), { status: 200 },
    )));
    await expect(fetchPeerChatKeys(BOB)).rejects.toMatchObject({ code: 'peer_key_malformed' });
  });

  it('справочник отдал запись БЕЗ signKey (старая) — не отказ, а честное «пина нет»', async () => {
    // Поле в справочнике необязательное: запись, сделанная до этой задачи,
    // существует и годна для шифрования. Отказать по ней значило бы закрыть
    // чат тем, кто уже заходил.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ boxKey: '0x' + '11'.repeat(32) }), { status: 200 },
    )));
    const keys = await fetchPeerChatKeys(BOB);
    expect(keys.boxKey).toHaveLength(32);
    expect(keys.signKey).toBeNull();
  });
});

/* ───── А (главный замер): переписанная целиком цепочка отвергается ───── */

describe('переписанная целиком чужим ключом цепочка', () => {
  /** Строит настоящий мешок: конверт → звено → подпись → кадр. */
  async function forgeBag(
    signerSession: ChatSession,
    claimedSender: `0x${string}`,
    recipientPub: Uint8Array,
    texts: string[],
  ) {
    const sodium = (await import('libsodium-wrappers')).default;
    await sodium.ready;
    const signer = await deriveLinkSigningKeypair(signerSession.keypair);
    const bags = [];
    let prev = null as ReturnType<typeof buildLink> | null;
    for (let i = 0; i < texts.length; i++) {
      // Четвёртым аргументом — АВТОР, тот же, кого называет звено и кого
      // засвидетельствует склад. Конверт связан с автором ПО ПОСТРОЕНИЮ
      // (`envelopeAad`, находка В-1): собранный без автора, он у `receiveBags`
      // просто не расшифруется, и подделка стала бы неотличима от «не тот
      // ключ» — то есть замок ниже проверял бы не то, что заявляет.
      const envelope = await packEnvelope(
        { text: texts[i] }, recipientPub, signerSession.keypair.publicKey,
        claimedSender.toLowerCase() as `0x${string}`,
      );
      const bodyHash = messageBodyHash(signer.publicKey, envelope);
      const link = buildLink(prev, bodyHash, claimedSender.toLowerCase() as `0x${string}`, 1_700_000_000_000 + i);
      const signature = sodium.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey);
      bags.push({
        key: `bag/${i}`,
        sender: claimedSender.toLowerCase() as `0x${string}`,
        uploadedAt: 1_700_000_000_000 + i,
        body: encodeFrame({ link, signature, signerPublicKey: signer.publicKey, envelope }),
      });
      prev = link;
    }
    return bags;
  }

  it('ЗАМЕР: без пина цепочка проходит как своя — три сообщения, ноль претензий', async () => {
    // Половина, доказывающая, что дыра настоящая, а не выдуманная: подделка
    // самосогласована, и без внешнего ключа отличить её не от чего.
    const alice = await makeSession(ALICE, 'a1');
    const mallory = await makeSession(BOB, 'ee'); // чужой ключ, но представляется Бобом
    const bags = await forgeBag(mallory, BOB, alice.keypair.publicKey, ['раз', 'два', 'три']);

    const st = await receiveBags(alice, bags, { peer: BOB.toLowerCase() as `0x${string}` });
    expect(st.messages).toHaveLength(3);
    expect(st.troubles).toHaveLength(0);
  });

  it('ЗАМЕР: с пином из справочника та же цепочка отвергается целиком — ноль сообщений, три претензии signer_unexpected', async () => {
    // Что красит: снятие проводки `peerSigningPublicKeys` в хуке (или
    // публикация без `signKey`, из-за которой пину неоткуда взяться) —
    // цепочка снова проходит как своя, и замер даёт 3 сообщения вместо 0.
    const alice = await makeSession(ALICE, 'a1');
    const bobReal = await makeSession(BOB, 'bb');
    const mallory = await makeSession(BOB, 'ee');

    const bobSigner = await deriveLinkSigningKeypair(bobReal.keypair);
    const forged = await forgeBag(mallory, BOB, alice.keypair.publicKey, ['раз', 'два', 'три']);

    const st = await receiveBags(alice, forged, {
      peer: BOB.toLowerCase() as `0x${string}`,
      peerSigningPublicKeys: { [BOB.toLowerCase()]: bobSigner.publicKey },
    });

    expect(st.messages).toHaveLength(0);
    expect(st.troubles.filter(t => t.kind === 'signer_unexpected')).toHaveLength(3);
  });

  it('настоящая цепочка того же собеседника с тем же пином проходит — пин не запирает честного', async () => {
    // Обратная сторона: замок, который запирает всех, не замок, а поломка.
    const alice = await makeSession(ALICE, 'a1');
    const bobReal = await makeSession(BOB, 'bb');
    const bobSigner = await deriveLinkSigningKeypair(bobReal.keypair);
    const honest = await forgeBag(bobReal, BOB, alice.keypair.publicKey, ['раз', 'два']);

    const st = await receiveBags(alice, honest, {
      peer: BOB.toLowerCase() as `0x${string}`,
      peerSigningPublicKeys: { [BOB.toLowerCase()]: bobSigner.publicKey },
    });

    expect(st.messages.map(m => m.payload.text)).toEqual(['раз', 'два']);
    expect(st.troubles).toHaveLength(0);
  });
});

/* ───────────── В. «ключ не сохранился» доносится наверх ───────────── */

describe('сеанс сообщает, что ключ не сохранился', () => {
  it('persisted:false с причиной storage_blocked — наверх едет и признак, и действие', async () => {
    const session = { ...(await makeSession(ALICE, 'a1')), persisted: false, storageIssue: 'storage_blocked' as const };
    const notice = sessionStorageNotice(session);
    expect(notice).toEqual({ persisted: false, code: 'storage_blocked', actionable: true });
  });

  it('persisted:false без названной причины — всё равно наверх, просто без действия', async () => {
    const session = { ...(await makeSession(ALICE, 'a1')), persisted: false };
    expect(sessionStorageNotice(session)).toEqual({ persisted: false, code: null, actionable: false });
  });

  it('всё в порядке — ни признака, ни шума', async () => {
    expect(sessionStorageNotice(await makeSession(ALICE, 'a1'))).toBeNull();
  });

  it('квота кончилась — это НЕ «закройте вторую вкладку», и коды это различают', async () => {
    // Ровно то, ради чего поле `storageIssue` вообще существует: у
    // `storage_blocked` есть действие, у `storage_write_failed` — нет, и
    // предлагать закрыть вкладки человеку в приватном режиме бесполезно.
    const s = { ...(await makeSession(ALICE, 'a1')), persisted: false, storageIssue: 'storage_write_failed' as const };
    expect(sessionStorageNotice(s)).toEqual({ persisted: false, code: 'storage_write_failed', actionable: false });
  });
});

/* ───── Б. слишком длинное сообщение отказывает ДО отправки ───── */

describe('слишком длинное сообщение получает отказ до отправки', () => {
  it('ЗАМЕР: отказ с кодом message_too_large и НОЛЬ запросов к складу', async () => {
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');

    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    // Потолок конверта — 262144 байта (= предел приёма склада). Берём
    // заведомо больше: четверть мегабайта плюс килобайт.
    const tooLong = 'я'.repeat(263_000);

    await expect(sendMessage(
      alice, bob.address, bob.keypair.publicKey, { text: tooLong }, null, { pass: 'v1.p' },
    )).rejects.toMatchObject({ code: 'message_too_large' });

    // Главное в этом замере: склад не тронут ВООБЩЕ. Отказ до сети, а не
    // после того, как четверть мегабайта уехала и вернулась 413-м.
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('сообщение под потолком уходит нормально — отказ не съедает честную отправку', async () => {
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ key: 'b/1' }), { status: 200 })));

    const sent = await sendMessage(
      alice, bob.address, bob.keypair.publicKey, { text: 'коротко' }, null, { pass: 'v1.p' },
    );
    expect(sent.key).toBe('b/1');
  });
});

/* ─────────── В-1/В-2: ОБА пути подписи под общим мьютексом ─────────── */

describe('мьютекс кошелька доказывается удержанием, а не строкой импорта', () => {
  // В-2 независимой проверки: гейт `lib/signaturePaths.test.ts` смотрит на
  // НАЛИЧИЕ строки импорта — «снять замок, импорт оставить» давало 0 красных
  // из 497. Значит поведение обязано проверяться отдельно и именно
  // удержанием: пока чужой держатель не отпустил, подписей должно быть НОЛЬ.

  it('ЗАМЕР: пропуск склада ждёт чужого держателя замка — 0 подписей, после отпускания 1', async () => {
    const { acquireWalletLock } = await import('@/lib/walletLock');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ pass: 'v1.p', expiresAt: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 },
    )));

    let signs = 0;
    const signMessageAsync = vi.fn(async () => { signs++; return sig('11'); });

    const release = await acquireWalletLock(ALICE);
    const pending = getBagPass(ALICE, signMessageAsync);
    await new Promise(r => setTimeout(r, 30));
    expect(signs).toBe(0);          // держатель чужой — окна нет

    release();
    await pending;
    expect(signs).toBe(1);          // отпустили — ровно одно окно
  });

  it('ЗАМЕР: подпись ключа переписки ждёт того же держателя — 0 подписей, после отпускания 1', async () => {
    // В-1: путей к подписи ДВА. Второй — подпись типизированных данных при
    // заведении сеанса; `chatSession.ts` мьютекс кошелька не импортирует
    // вовсе, у него свой замок с другим именем, и с окном от подписки на
    // уведомления или страницы сделки он не пересекается.
    const { acquireWalletLock } = await import('@/lib/walletLock');

    let signs = 0;
    const signTypedDataAsync = vi.fn(async () => { signs++; return sig('22'); });

    const release = await acquireWalletLock(ALICE);
    const pending = signChatKeyLocked(ALICE, signTypedDataAsync);
    await new Promise(r => setTimeout(r, 30));
    expect(signs).toBe(0);

    release();
    await pending;
    expect(signs).toBe(1);
  });

  it('два пути подписи не сталкиваются между собой — второй ждёт первого', async () => {
    // Тот же мьютекс, значит окна не наложатся друг на друга: ровно та гонка,
    // ради которой walletLock существует (-32002 в мобильном MetaMask нечем
    // отменить).
    _resetBagPassCacheForTest();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>(r => { releaseFirst = r; });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ pass: 'v1.p', expiresAt: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 },
    )));

    const a = signChatKeyLocked(ALICE, async () => { order.push('typed:start'); await firstDone; order.push('typed:end'); return sig('22'); });
    await new Promise(r => setTimeout(r, 10));
    const b = getBagPass(ALICE, async () => { order.push('msg:start'); return sig('11'); });
    await new Promise(r => setTimeout(r, 10));

    expect(order).toEqual(['typed:start']); // второй ещё не начинался
    releaseFirst();
    await Promise.all([a, b]);
    expect(order).toEqual(['typed:start', 'typed:end', 'msg:start']);
  });
});
