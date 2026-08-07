/**
 * pairChatFlood.test.ts — К-1: наводнение чужого ящика.
 *
 * ЧТО НАШЛА ВРАЖДЕБНАЯ ПРОВЕРКА. Мешок в чужой ящик кладёт КТО УГОДНО, кто
 * знает адрес, — а адреса в цепи публичны. Движок переписки скачивал КАЖДЫЙ
 * мешок из `inbox`, последовательно и без предела, и только ПОСЛЕ скачивания
 * разбор решал, чей он. То есть посторонний оплачивал жертве трафик, время и
 * бюджет чтения склада, ничего о ней не зная.
 *
 * ⚠️ БЮДЖЕТ ЧТЕНИЯ — ЭТО НЕ АБСТРАКЦИЯ. `relayer/app.js` даёт адресу
 * `BAG_READ_RATE_MAX = 120` чтений в минуту, И ЭТОТ БЮДЖЕТ ОБЩИЙ у перечисления
 * (`GET /bags`) и скачивания (`GET /bags/:key`). Опрос при открытом чате — 12
 * перечислений в минуту. Значит тысяча скачиваний одним тиком не просто медленна
 * — она выжигает бюджет и приносит `429` на СОБСТВЕННЫЙ следующий опрос: чат
 * жертвы встаёт целиком, а нападающему это стоило одного мешка.
 *
 * ЗАМЕРЫ ЗДЕСЬ ДВА, и они разные по смыслу:
 *  А. СКОЛЬКО СКАЧИВАЕМ. Детерминированный счёт: сколько мешков постороннего
 *     ушло в сеть и через сколько скачиваний показалось сообщение собеседника.
 *  Б. ТЕМП. Сколько мешков в секунду кладёт нападающий против того, сколько
 *     жертва успевает вычерпать при честной задержке сети.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveChatKeypair } from '@/lib/chatCrypto';
import type { ChatSession } from '@/lib/chatSession';
import {
  deriveLinkSigningKeypair, encodeFrame, messageBodyHash, linkSignaturePreimage,
} from '@/lib/chatConversation';
import { buildLink, type ChainLink } from '@/lib/chatChain';
import { packEnvelope } from '@/lib/chatEnvelope';
import { _resetBagPassCacheForTest } from '@/lib/chatTransport';
import { startPairChat, type PairChatState } from './usePairChat';

/**
 * Потолок записан ЗДЕСЬ РУКАМИ, а не взят из проверяемого модуля.
 *
 * Правило проекта (см. `FRAME_HEADER_LEN` в `chatConversation.ts`): тест,
 * берущий величину из того, что он проверяет, доказывает только «какая-то
 * есть». Число выведено из чужого, боевого: `relayer/app.js` даёт адресу
 * `BAG_READ_RATE_MAX = 120` чтений в минуту, общих у перечисления и
 * скачивания; опрос при открытом чате — 12 перечислений в минуту; остаётся
 * 108, и 100 оставляет запас на список переписок, который ест тот же бюджет.
 */
const SERVER_READ_BUDGET_PER_MIN = 100;

const ALICE  = '0xA1cE00000000000000000000000000000000CAfE' as const;
const BOB    = '0xB0b1000000000000000000000000000000005eEd' as const;
/** Посторонний. Ни одной сделки с Алисой, ни одного её согласия — просто знает
 *  её адрес, как знает его любой, кто открыл обозреватель цепи. */
const CAROL  = '0xCa401000000000000000000000000000000FeeD1' as const;

function sig(fill: string): `0x${string}` {
  return ('0x' + fill.repeat(130).slice(0, 130)) as `0x${string}`;
}

async function makeSession(address: `0x${string}`, seed: string): Promise<ChatSession> {
  return {
    keypair: await deriveChatKeypair(sig(seed)),
    address, origin: 'signature', walletKind: 'eoa', restored: false, persisted: true,
  };
}

function hexOf(bytes: Uint8Array): string {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

interface StoredBag { key: string; sender: string; size: number; uploadedAt: number; body: Uint8Array }

/**
 * Настоящие мешки: конверт → звено → подпись → кадр. Мешки постороннего —
 * ТОЖЕ настоящие: он умеет всё то же, что собеседник, и «отбросим мусор» его
 * не остановит. Единственное, чего у него нет, — согласия жертвы.
 */
async function buildBags(
  from: ChatSession, sender: `0x${string}`, recipient: `0x${string}`,
  recipientPub: Uint8Array, texts: string[], firstAt: number,
): Promise<StoredBag[]> {
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  const signer = await deriveLinkSigningKeypair(from.keypair);
  const out: StoredBag[] = [];
  let prev: ChainLink | null = null;
  const lc = sender.toLowerCase() as `0x${string}`;
  for (let i = 0; i < texts.length; i++) {
    const envelope = await packEnvelope({ text: texts[i] }, recipientPub, from.keypair.publicKey, lc);
    const link = buildLink(prev, messageBodyHash(signer.publicKey, envelope), lc, firstAt + i);
    const signature = sodium.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey);
    const body = encodeFrame({ link, signature, signerPublicKey: signer.publicKey, envelope });
    out.push({
      key: `${recipient.toLowerCase()}/${firstAt + i}-${lc.slice(2, 8)}.bin`,
      sender: lc, size: body.length, uploadedAt: firstAt + i, body,
    });
    prev = link;
  }
  return out;
}

/**
 * Склад с ЖИВЫМ ящиком и честной задержкой скачивания.
 *
 * `downloadMs` — не украшение: без задержки «последовательное скачивание без
 * предела» неотличимо от мгновенного, и замер темпа выродился бы в замер
 * скорости интерпретатора. 5 мс — заведомо оптимистичная сеть.
 */
function fakeRelayer(opts: {
  store: StoredBag[];
  peerBoxKey: Uint8Array;
  peerSignKey: Uint8Array;
  downloadMs?: number;
}) {
  const downloads: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const p = u.pathname;

    if (p === '/keys' && init?.method === 'POST') {
      return new Response(JSON.stringify({ address: ALICE.toLowerCase() }), { status: 200 });
    }
    if (p.startsWith('/keys/')) {
      return new Response(JSON.stringify({
        address: BOB.toLowerCase(), boxKey: hexOf(opts.peerBoxKey), signKey: hexOf(opts.peerSignKey),
      }), { status: 200 });
    }
    if (p === '/bags' && (init?.method ?? 'GET') === 'GET') {
      const raw = u.searchParams.get('since');
      const since = raw === null ? null : Number(raw);
      // Снимок ящика на момент запроса — ящик живой, нападающий пополняет его
      // параллельно.
      const inbox = (since === null ? opts.store : opts.store.filter(b => b.uploadedAt >= since))
        .map(({ key, sender, size, uploadedAt }) => ({ key, sender, size, uploadedAt }));
      return new Response(JSON.stringify({ inbox, sent: [], peers: [] }), { status: 200 });
    }
    if (init?.method === 'PUT') {
      return new Response(JSON.stringify({ key: 'a/1' }), { status: 200 });
    }
    const key = decodeURIComponent(p.replace(/^\/bags\//, ''));
    downloads.push(key);
    if (opts.downloadMs) await new Promise(r => setTimeout(r, opts.downloadMs));
    const bag = opts.store.find(b => b.key === key);
    if (!bag) return new Response(JSON.stringify({ error: 'no', code: 'bag_not_found' }), { status: 404 });
    return new Response(bag.body, { status: 200 });
  });
  return { fetchMock, downloads };
}

async function waitFor(cond: () => boolean, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('waitFor: условие не наступило за отведённое время');
    await new Promise(r => setTimeout(r, 5));
  }
}

function drive(engineOpts: Parameters<typeof startPairChat>[0]) {
  const states: PairChatState[] = [];
  const errors: unknown[] = [];
  const engine = startPairChat({
    ...engineOpts,
    onState: (s) => { states.push(s); },
    onError: (e) => { errors.push(e); },
    // Настоящая, пусть и крошечная, пауза — мгновенный `sleep` держит цикл в
    // микрозадачах и убивает исполнителя тестов (разбор — в usePairChat.test.ts).
    sleep: async () => { await new Promise(r => setTimeout(r, 1)); },
  });
  return { engine, states, errors };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetBagPassCacheForTest();
});

/* ────────────────────── замер А: сколько скачиваем ────────────────────── */

describe('К-1: посторонний наполняет ящик', () => {
  it('ЗАМЕР: 300 мешков постороннего — НОЛЬ скачиваний, сообщение собеседника доезжает', async () => {
    // Что красит этот тест: снятие отбора по отправителю ДО скачивания. Тогда
    // `strangerDownloads` становится 300, а сообщение Боба показывается только
    // после них — ровно то поведение, которое нашла проверка.
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const carol = await makeSession(CAROL, 'cc');
    const bobSigner = await deriveLinkSigningKeypair(bob.keypair);

    const flood = await buildBags(
      carol, CAROL, ALICE, alice.keypair.publicKey,
      Array.from({ length: 300 }, (_, i) => `мусор ${i}`), 1_700_000_000_000,
    );
    const real = await buildBags(
      bob, BOB, ALICE, alice.keypair.publicKey, ['привет, это Боб'], 1_700_000_001_000,
    );
    const store = [...flood, ...real];

    const { fetchMock, downloads } = fakeRelayer({
      store, peerBoxKey: bob.keypair.publicKey, peerSignKey: bobSigner.publicKey,
    });
    vi.stubGlobal('fetch', fetchMock);

    const run = drive({ session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true });
    try {
      await waitFor(() => run.states.some(s => s.messages.some(m => m.text === 'привет, это Боб')));
    } finally {
      run.engine.stop();
    }

    const strangerKeys = new Set(flood.map(b => b.key));
    const strangerDownloads = downloads.filter(k => strangerKeys.has(k));
    console.log(
      `[К-1 замер А] мешков постороннего в ящике: ${flood.length}; ` +
      `скачано постороннего: ${strangerDownloads.length}; всего скачиваний до показа: ${downloads.length}`,
    );

    expect(strangerDownloads).toHaveLength(0);
    // Ровно один мешок — тот, что от собеседника.
    expect(downloads).toHaveLength(1);
  }, 60_000);

  it('ЗАМЕР: 300 мешков собеседника за один тик — не больше бюджета чтения', async () => {
    // Отбор по отправителю не спасает от САМОГО собеседника: он вправе писать,
    // и тысяча его мешков — законный вход. Потолок нужен отдельно, и он взят не
    // с потолка: `BAG_READ_RATE_MAX = 120` чтений в минуту на адрес, ОБЩИЙ у
    // перечисления и скачивания.
    //
    // Что красит: снятие потолка. Тогда за первый же тик уходит 300 скачиваний
    // — вдвое больше минутного бюджета склада.
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const bobSigner = await deriveLinkSigningKeypair(bob.keypair);

    const store = await buildBags(
      bob, BOB, ALICE, alice.keypair.publicKey,
      Array.from({ length: 300 }, (_, i) => `сообщение ${i}`), 1_700_000_000_000,
    );
    const { fetchMock, downloads } = fakeRelayer({
      store, peerBoxKey: bob.keypair.publicKey, peerSignKey: bobSigner.publicKey,
    });
    vi.stubGlobal('fetch', fetchMock);

    const run = drive({ session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true });
    try {
      await waitFor(() => run.states.length >= 1);
    } finally {
      run.engine.stop();
    }
    // Дать возможным лишним скачиваниям первого тика долететь.
    await new Promise(r => setTimeout(r, 50));

    console.log(
      `[К-1 замер А2] мешков собеседника: ${store.length}; скачано за первый тик: ${downloads.length}; ` +
      `бюджет склада на минуту: ${SERVER_READ_BUDGET_PER_MIN}`,
    );
    expect(downloads.length).toBeLessThanOrEqual(SERVER_READ_BUDGET_PER_MIN);
    // И потолок не должен выродиться в «не качаем вовсе».
    expect(downloads.length).toBeGreaterThan(0);
  }, 60_000);
});

/* ──────────────────────────── замер Б: темп ───────────────────────────── */

describe('К-1: темп наполнения против темпа вычерпывания', () => {
  it('ЗАМЕР: нападающий кладёт быстрее, чем жертва качает, — и это не мешает переписке', async () => {
    // Замер честный: задержка скачивания 5 мс (оптимистичная сеть), нападающий
    // кладёт мешок каждые 2 мс. Считаем ОБА темпа и смотрим, догоняет ли
    // жертва. Смысл замера не в том, чтобы догнать, — догнать нельзя в
    // принципе, класть всегда дешевле, чем качать. Смысл в том, что после
    // отбора по отправителю жертва НЕ ПЫТАЕТСЯ догонять вовсе.
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const carol = await makeSession(CAROL, 'cc');
    const bobSigner = await deriveLinkSigningKeypair(bob.keypair);

    // Мешки нападающего заготовлены заранее (сборка кадра — не то, что мы
    // меряем), кладутся в ящик по одному, по часам.
    const ammo = await buildBags(
      carol, CAROL, ALICE, alice.keypair.publicKey,
      Array.from({ length: 600 }, (_, i) => `мусор ${i}`), 1_700_000_000_000,
    );
    const store: StoredBag[] = [];
    const { fetchMock, downloads } = fakeRelayer({
      store, peerBoxKey: bob.keypair.publicKey, peerSignKey: bobSigner.publicKey, downloadMs: 5,
    });
    vi.stubGlobal('fetch', fetchMock);

    const run = drive({ session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true });
    const startedAt = Date.now();
    let placed = 0;
    const filler = setInterval(() => {
      if (placed < ammo.length) store.push(ammo[placed++]);
    }, 2);
    try {
      await new Promise(r => setTimeout(r, 1_500));
    } finally {
      clearInterval(filler);
      run.engine.stop();
    }
    const elapsedSec = (Date.now() - startedAt) / 1000;

    const strangerKeys = new Set(ammo.map(b => b.key));
    const drained = downloads.filter(k => strangerKeys.has(k)).length;
    console.log(
      `[К-1 замер Б] за ${elapsedSec.toFixed(2)} с: нападающий положил ${placed} ` +
      `(${(placed / elapsedSec).toFixed(0)}/с), жертва скачала ${drained} ` +
      `(${(drained / elapsedSec).toFixed(0)}/с)`,
    );

    expect(placed).toBeGreaterThan(100);
    expect(drained).toBe(0);
  }, 60_000);
});
