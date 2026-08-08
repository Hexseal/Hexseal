/**
 * chatArchive.test.ts — В-3: своя копия переписки на устройстве.
 *
 * ЧТО НАШЛА ВРАЖДЕБНАЯ ПРОВЕРКА И ЧТО ПОКАЗАЛ РАЗБОР КОДА СКЛАДА:
 *
 *  - `relayer/bagStore.js` (`bagExpiryAt`): ПРОЧИТАННЫЙ мешок живёт
 *    `firstFetchedAt + BAG_TTL_MS` = 7 дней; НЕПРОЧИТАННЫЙ —
 *    `uploadedAt + BAG_UNREAD_TTL_MS` = 30 дней.
 *  - `relayer/app.js` (выдача мешка): отметку о прочтении ставит ПОЛУЧАТЕЛЬ
 *    (`marksRead = meta.recipient === address`).
 *
 * Значит собеседник, просто ОТКРЫВ переписку, укорачивает срок жизни НАШЕГО
 * доказательства с тридцати дней до семи. Кнопка у него, цена на нас.
 *
 * ⚠️ САМО ПРАВИЛО СРОКА ОТСЮДА НЕ ЧИНИТСЯ — это код склада. Чинится то, что
 * важнее и что целиком наше: §5 общей спеки стоит на том, что «сторона
 * предъявляет СВОЮ КОПИЮ», а своей копии не существовало вовсе. На устройстве
 * лежала только голова разговора; кадры — единственное, что доказывает
 * что-либо третьему лицу, — жили ТОЛЬКО на складе.
 *
 * ЗАМЕР ЗДЕСЬ ОДИН И ГЛАВНЫЙ: сколько сообщений можно предъявить ПОСЛЕ того,
 * как склад забыл мешки.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deriveChatKeypair } from './chatCrypto';
import {
  sendMessage, receiveBags, forgetConversationHead,
  readConversationArchive, archiveConversationFrames,
  deriveLinkSigningKeypair, encodeFrame, messageBodyHash, linkSignaturePreimage,
  _resetConversationMemoryForTest, _resetParseCacheForTest,
  MAX_ARCHIVE_BYTES_PER_PAIR, ARCHIVE_CHUNK_BYTES,
  type IncomingBag, type ArchivedFrame,
} from './chatConversation';
import { packEnvelope } from './chatEnvelope';
import { buildLink, type ChainLink } from './chatChain';
import type { ChatSession } from './chatSession';
import { installFakeChatDisk, type FakeChatDisk } from './__stand__/fakeChatDisk';

const ALICE = '0xA1cE00000000000000000000000000000000CAfE' as const;
const BOB = '0xB0b1000000000000000000000000000000005eEd' as const;

function sig(fill: string): `0x${string}` {
  return ('0x' + fill.repeat(130).slice(0, 130)) as `0x${string}`;
}
async function makeSession(address: `0x${string}`, seed: string): Promise<ChatSession> {
  return {
    keypair: await deriveChatKeypair(sig(seed)),
    address, origin: 'signature', walletKind: 'eoa', restored: true, persisted: true,
  };
}

async function bobBag(
  bob: ChatSession, alicePub: Uint8Array, text: string, at: number, prev: ChainLink | null,
): Promise<{ bag: IncomingBag; link: ChainLink }> {
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  const signer = await deriveLinkSigningKeypair(bob.keypair);
  const lc = BOB.toLowerCase() as `0x${string}`;
  const envelope = await packEnvelope({ text }, alicePub, bob.keypair.publicKey, lc);
  const link = buildLink(prev, messageBodyHash(signer.publicKey, envelope), lc, at);
  const signature = sodium.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey);
  return {
    bag: {
      key: `${ALICE.toLowerCase()}/${at}-b0b.bin`, sender: lc, uploadedAt: at,
      body: encodeFrame({ link, signature, signerPublicKey: signer.publicKey, envelope }),
    },
    link,
  };
}

let disk: FakeChatDisk;

beforeEach(() => {
  let n = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      n++;
      return new Response(JSON.stringify({ key: `${BOB.toLowerCase()}/${5000 + n}-a1c.bin` }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }));
  _resetConversationMemoryForTest();
  _resetParseCacheForTest();
  disk = installFakeChatDisk();
});
afterEach(() => { disk.restore(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('В-3: склад забыл — предъявить всё равно есть что', () => {
  it('ЗАМЕР: после исчезновения мешков со склада предъявляется 5 сообщений из 5', async () => {
    // Что красит: снятие записи архива (в `sendMessage` или в движке) —
    // предъявить становится нечего, ноль из пяти.
    const alice = await makeSession(ALICE, '1c3d');
    const bob = await makeSession(BOB, '7f2e');
    await forgetConversationHead(ALICE, BOB);

    // Три своих сообщения — архивируются самой отправкой.
    let prev: ChainLink | null = null;
    for (const text of ['раз', 'два', 'три']) {
      const s = await sendMessage(
        alice, BOB, bob.keypair.publicKey, { text }, prev, { pass: 'v1.p', now: () => 10_000 + (prev?.seq ?? -1) + 1 },
      );
      prev = s.link;
    }

    // Два чужих — их архивирует тот, кто их скачал (движок; здесь напрямую).
    let bprev: ChainLink | null = null;
    const incoming: ArchivedFrame[] = [];
    for (const [i, text] of ['ответ-1', 'ответ-2'].entries()) {
      const { bag, link } = await bobBag(bob, alice.keypair.publicKey, text, 20_000 + i, bprev);
      bprev = link;
      incoming.push({
        key: bag.key, from: bag.sender, seq: 0,
        sentAt: bag.uploadedAt, receivedAt: bag.uploadedAt, frame: bag.body,
      });
    }
    await archiveConversationFrames(ALICE, BOB, incoming);

    // ─── СКЛАД ЗАБЫЛ ВСЁ ───────────────────────────────────────────────
    // Ни одного мешка: истёк семидневный срок «прочитанного», который
    // собеседник и запустил, просто открыв переписку.
    const archived = await readConversationArchive(ALICE, BOB);
    const state = await receiveBags(
      alice,
      archived.map(f => ({ key: f.key, sender: f.from, uploadedAt: f.receivedAt, body: f.frame })),
      { peer: BOB },
    );

    const provable = state.messages.filter(m => m.proof !== undefined);
    console.info(
      `[В-3 замер] сообщений в переписке: 5; кадров на устройстве: ${archived.length}; ` +
      `предъявляется со СВОЕЙ копии, без склада: ${provable.length}`,
    );

    expect(archived).toHaveLength(5);
    expect(provable).toHaveLength(5);
    expect(state.messages.map(m => m.payload.text))
      .toEqual(['раз', 'два', 'три', 'ответ-1', 'ответ-2']);
  }, 60_000);

  it('повторная запись тех же кадров не удваивает архив', async () => {
    // Что красит: снятие отсева по ключу мешка. `receiveBags` разбирает ВЕСЬ
    // набор каждый тик, и вызывающий кладёт весь набор — без отсева архив
    // рос бы копиями каждые пять секунд.
    const alice = await makeSession(ALICE, '1c3d');
    const bob = await makeSession(BOB, '7f2e');
    const { bag } = await bobBag(bob, alice.keypair.publicKey, 'один', 20_000, null);
    const f: ArchivedFrame = {
      key: bag.key, from: bag.sender, seq: 0,
      sentAt: bag.uploadedAt, receivedAt: bag.uploadedAt, frame: bag.body,
    };
    const first = await archiveConversationFrames(ALICE, BOB, [f]);
    const second = await archiveConversationFrames(ALICE, BOB, [f]);
    const third = await archiveConversationFrames(ALICE, BOB, [f]);
    expect(first.stored).toBe(1);
    expect(second.stored).toBe(0);
    expect(third.stored).toBe(0);
    expect(await readConversationArchive(ALICE, BOB)).toHaveLength(1);
  }, 60_000);

  it('ЗАМЕР: собеседник шлёт крупные кадры — архив упирается в потолок байтов, а не в диск', async () => {
    // Ответ на «долбят нарочно» числом. Размер кадра задаёт СОБЕСЕДНИК (склад
    // принимает до 256 КБ). Без потолка по байтам заполнение чужого диска
    // становится услугой: пять тысяч кадров это до 1,2 ГБ на одной переписке.
    //
    // Что красит: снятие потолка по БАЙТАМ (потолок по числу кадров этот
    // случай не ловит — кадров тут всего восемьсот).
    const big = 200 * 1024;
    const frames: ArchivedFrame[] = [];
    for (let i = 0; i < 800; i++) {
      frames.push({
        key: `${ALICE.toLowerCase()}/${30_000 + i}-big.bin`,
        from: BOB.toLowerCase() as `0x${string}`, seq: i,
        sentAt: 30_000 + i, receivedAt: 30_000 + i,
        frame: new Uint8Array(big).fill(1),
      });
    }
    const res = await archiveConversationFrames(ALICE, BOB, frames);
    const kept = await readConversationArchive(ALICE, BOB);
    const bytes = kept.reduce((n, f) => n + f.frame.length, 0);
    console.info(
      `[В-3 замер] прислано кадров: ${frames.length} по ${big} Б (${(frames.length * big / 1024 / 1024).toFixed(0)} МБ); ` +
      `на устройстве осталось: ${kept.length} (${(bytes / 1024 / 1024).toFixed(1)} МБ), вытеснено ${res.evicted}`,
    );
    // ⚠️ ПОРОГ — ПОТОЛОК ПЛЮС ОДИН КУСОК, И ЭТО ПРИЗНАНИЕ, А НЕ ЩЕДРОСТЬ.
    // Вытеснение идёт целыми кусками, значит перебрать потолок архив может
    // ровно на размер куска — не больше. Первая версия куска считала только
    // КАДРЫ: двести штук по 200 КБ давали 39 МБ при потолке в 32, то есть
    // потолок пробивался на 22 %. Кусок теперь закрывается и по байтам.
    expect(bytes).toBeLessThanOrEqual(MAX_ARCHIVE_BYTES_PER_PAIR + ARCHIVE_CHUNK_BYTES + big);
    expect(kept.length).toBeGreaterThan(0);
    // Вытесняется САМОЕ СТАРОЕ — свежее доказательство ценнее прошлогоднего.
    expect(kept[kept.length - 1].receivedAt).toBe(30_000 + 799);
  }, 120_000);

  it('диск кончился — отправка проходит, архив честно молчит', async () => {
    // Вопрос «диск кончился»: вернули ошибку или упали целиком? Архив это
    // страховка, а не условие работы переписки.
    disk.restore();
    disk = installFakeChatDisk({ failPut: true });
    const alice = await makeSession(ALICE, '1c3d');
    const bob = await makeSession(BOB, '7f2e');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const sent = await sendMessage(
      alice, BOB, bob.keypair.publicKey, { text: 'уйдёт' }, null, { pass: 'v1.p' },
    );
    expect(sent.key).toBeTruthy();          // сообщение УШЛО
    expect(await readConversationArchive(ALICE, BOB)).toHaveLength(0);
    expect(warn).toHaveBeenCalled();        // и человеку об этом сказали в журнал
    warn.mockRestore();
  }, 60_000);

  it('мусор в записи архива не выдаётся за доказательство', async () => {
    // Данные с устройства доверия не заслуживают ровно как данные из сети:
    // их мог записать прежний выпуск, их мог испортить сбой.
    const alice = await makeSession(ALICE, '1c3d');
    const bob = await makeSession(BOB, '7f2e');
    const { bag } = await bobBag(bob, alice.keypair.publicKey, 'настоящее', 20_000, null);
    await archiveConversationFrames(ALICE, BOB, [{
      key: bag.key, from: bag.sender, seq: 0,
      sentAt: bag.uploadedAt, receivedAt: bag.uploadedAt, frame: bag.body,
    }]);

    // Подкладываем в тот же кусок мусор — так, как его мог бы оставить сбой.
    const chunkKey = `${ALICE.toLowerCase()}|${BOB.toLowerCase()}#0`;
    const chunk = disk.disk.get(chunkKey) as { frames: unknown[] };
    chunk.frames.push({ key: 42 }, null, { key: 'x', from: 'не адрес' }, 'строка');
    disk.disk.set(chunkKey, chunk);

    _resetConversationMemoryForTest();
    const kept = await readConversationArchive(ALICE, BOB);
    expect(kept).toHaveLength(1);
    expect(kept[0].key).toBe(bag.key);
  }, 60_000);
});

/* ─────────── В-3: архив доезжает ДО ЭКРАНА, а не лежит на диске ─────────── */

describe('В-3: своя копия доходит до переписки, а не остаётся возможностью', () => {
  it('ЗАМЕР: склад пуст, а переписка показывает 3 сообщения из архива', async () => {
    // ⚠️ ЭТОТ ЗАМОК СУЩЕСТВУЕТ ПРОТИВ КОНКРЕТНОЙ ОШИБКИ, УЖЕ СДЕЛАННОЙ В ЭТОЙ
    // ВЕТКЕ. `listBurnedSeqs` написали, задокументировали словами «интерфейс
    // ОБЯЗАН сказать» — и не позвали ни разу вне тестов. Архив, который никто
    // не читает, ровно то же самое: кадры на диске, экран пуст.
    //
    // Что красит: снятие подсева архива в движке — ноль сообщений.
    const { startPairChat } = await import('@/hooks/usePairChat');
    const { _resetBagPassCacheForTest } = await import('./chatTransport');
    _resetBagPassCacheForTest();

    const alice = await makeSession(ALICE, '1c3d');
    const bob = await makeSession(BOB, '7f2e');
    const bobSigner = await deriveLinkSigningKeypair(bob.keypair);

    let prev: ChainLink | null = null;
    const frames: ArchivedFrame[] = [];
    for (const [i, text] of ['раз', 'два', 'три'].entries()) {
      const { bag, link } = await bobBag(bob, alice.keypair.publicKey, text, 20_000 + i, prev);
      prev = link;
      frames.push({
        key: bag.key, from: bag.sender, seq: link.seq,
        sentAt: bag.uploadedAt, receivedAt: bag.uploadedAt, frame: bag.body,
      });
    }
    await archiveConversationFrames(ALICE, BOB, frames);
    _resetConversationMemoryForTest(); // как после перезагрузки вкладки

    // Склад ПУСТ: мешки истекли — их забрал получатель, семь дней прошли.
    const hex = (b: Uint8Array) => '0x' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname === '/keys' && init?.method === 'POST') return new Response('{}', { status: 200 });
      if (u.pathname.startsWith('/keys/')) {
        return new Response(JSON.stringify({
          address: BOB.toLowerCase(), boxKey: hex(bob.keypair.publicKey), signKey: hex(bobSigner.publicKey),
        }), { status: 200 });
      }
      if (u.pathname === '/bags') {
        return new Response(JSON.stringify({ inbox: [], sent: [], peers: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'no', code: 'bag_not_found' }), { status: 404 });
    }));

    const states: { messages: { text: string }[] }[] = [];
    const engine = startPairChat({
      session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true,
      onState: (s) => { states.push(s); },
      onError: () => {},
      sleep: async () => { await new Promise(r => setTimeout(r, 1)); },
    });
    const until = Date.now() + 10_000;
    while (states.length === 0 && Date.now() < until) await new Promise(r => setTimeout(r, 5));
    engine.stop();

    const shown = states[states.length - 1]?.messages.map(m => m.text) ?? [];
    console.info(`[В-3 замер] склад отдал 0 мешков; на экране: ${shown.length} — ${shown.join(', ')}`);
    expect(shown).toEqual(['раз', 'два', 'три']);
  }, 60_000);

  it('ЗАМЕР: движок КЛАДЁТ в архив то, что скачал со склада', async () => {
    // Вторая половина того же свойства. Предыдущий замок проверяет, что архив
    // ЧИТАЕТСЯ; этот — что он ПОПОЛНЯЕТСЯ приехавшим. Без него архив содержал
    // бы только свои отправленные, и предъявить чужую половину переписки —
    // ровно то, что нужно в споре, — было бы нечем.
    //
    // Что красит: снятие записи архива в тике движка — ноль кадров на диске.
    const { startPairChat } = await import('@/hooks/usePairChat');
    const { _resetBagPassCacheForTest } = await import('./chatTransport');
    _resetBagPassCacheForTest();

    const alice = await makeSession(ALICE, '1c3d');
    const bob = await makeSession(BOB, '7f2e');
    const bobSigner = await deriveLinkSigningKeypair(bob.keypair);

    let prev: ChainLink | null = null;
    const store: IncomingBag[] = [];
    for (const [i, text] of ['раз', 'два', 'три'].entries()) {
      const { bag, link } = await bobBag(bob, alice.keypair.publicKey, text, 20_000 + i, prev);
      prev = link;
      store.push(bag);
    }

    const hex = (b: Uint8Array) => '0x' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname === '/keys' && init?.method === 'POST') return new Response('{}', { status: 200 });
      if (u.pathname.startsWith('/keys/')) {
        return new Response(JSON.stringify({
          address: BOB.toLowerCase(), boxKey: hex(bob.keypair.publicKey), signKey: hex(bobSigner.publicKey),
        }), { status: 200 });
      }
      if (u.pathname === '/bags') {
        return new Response(JSON.stringify({
          inbox: store.map(b => ({ key: b.key, sender: b.sender, size: b.body.length, uploadedAt: b.uploadedAt })),
          sent: [], peers: [],
        }), { status: 200 });
      }
      const key = decodeURIComponent(u.pathname.replace(/^\/bags\//, ''));
      const bag = store.find(b => b.key === key);
      return bag ? new Response(bag.body, { status: 200 })
        : new Response(JSON.stringify({ error: 'no', code: 'bag_not_found' }), { status: 404 });
    }));

    let states = 0;
    const engine = startPairChat({
      session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true,
      onState: () => { states++; }, onError: () => {},
      sleep: async () => { await new Promise(r => setTimeout(r, 1)); },
    });
    const until = Date.now() + 10_000;
    while (states === 0 && Date.now() < until) await new Promise(r => setTimeout(r, 5));
    // Запись архива идёт до выдачи состояния, но дадим ей долететь наверняка.
    await new Promise(r => setTimeout(r, 50));
    engine.stop();

    _resetConversationMemoryForTest();
    const archived = await readConversationArchive(ALICE, BOB);
    console.info(`[В-3 замер] склад отдал 3 мешка; кадров легло на устройство: ${archived.length}`);
    expect(archived.map(f => f.key).sort()).toEqual(store.map(b => b.key).sort());
  }, 60_000);
});
