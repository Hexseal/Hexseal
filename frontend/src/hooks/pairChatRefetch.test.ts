/**
 * pairChatRefetch.test.ts — К-2: один отказ скачивания уносит остаток пачки.
 *
 * ЧТО НАШЛА ВРАЖДЕБНАЯ ПРОВЕРКА. Курсор опроса (`pollBags`, `chatTransport.ts`)
 * двигается на ВЕСЬ ответ склада сразу, ещё до того, как движок хоть один мешок
 * скачал. Поэтому сеть, моргнувшая на третьем мешке из десяти, стоит семи
 * оставшихся: следующий тик попросит список «начиная с самого свежего», и этих
 * семи в нём уже не будет НИКОГДА.
 *
 * И это тяжелее, чем звучит. Пропавшее у нас выглядит у собеседника как НАША
 * дыра в цепочке — а дыру от утаивания отличить нечем (`docs/OPEN-ITEMS.md`).
 * То есть моргнувшая сеть превращается в обвинение.
 *
 * ⚠️ КУРСОР ЖИВЁТ В ЧУЖОМ ФАЙЛЕ, И ЭТО НЕ ПОВОД ЖДАТЬ. Двигать `pollBags`
 * назад значило бы править `chatTransport.ts`; вместо этого движок ведёт СВОЮ
 * опись «показано складом, но нами не взято». Свойство то же самое —
 * невзятое повторяется, — и держится оно в том же файле, где живёт скачивание.
 *
 * ЗАМЕР ЗДЕСЬ ДВА:
 *  А. СКОЛЬКО ДОЕХАЛО. Десять мешков, один отказ на третьем — сколько
 *     сообщений в итоге показано.
 *  Б. СКАЗАЛИ ЛИ ЧЕЛОВЕКУ. Пока невзятое висит, состояние обязано это
 *     называть, а не молчать.
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

/** Поля, которых на момент написания теста в состоянии НЕТ — в этом и красный.
 *  Пересечением, а не подменой: когда они появятся, тип сойдётся сам. */
type StateWithBacklog = PairChatState & { pendingBags?: number; bagsFailed?: boolean };

const ALICE = '0xA1cE00000000000000000000000000000000CAfE' as const;
const BOB   = '0xB0b1000000000000000000000000000000005eEd' as const;

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

async function buildBags(
  from: ChatSession, sender: `0x${string}`, recipient: `0x${string}`,
  recipientPub: Uint8Array, texts: string[],
): Promise<StoredBag[]> {
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  const signer = await deriveLinkSigningKeypair(from.keypair);
  const out: StoredBag[] = [];
  let prev: ChainLink | null = null;
  const lc = sender.toLowerCase() as `0x${string}`;
  for (let i = 0; i < texts.length; i++) {
    const envelope = await packEnvelope({ text: texts[i] }, recipientPub, from.keypair.publicKey, lc);
    const link = buildLink(prev, messageBodyHash(signer.publicKey, envelope), lc, 1_700_000_000_000 + i);
    const signature = sodium.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey);
    const body = encodeFrame({ link, signature, signerPublicKey: signer.publicKey, envelope });
    out.push({
      key: `${recipient.toLowerCase()}/${1_700_000_000_000 + i}-b0b100.bin`,
      sender: lc, size: body.length, uploadedAt: 1_700_000_000_000 + i, body,
    });
    prev = link;
  }
  return out;
}

/** Склад, у которого скачивание названного мешка отказывает `failTimes` раз
 *  подряд, а потом чинится — ровно как моргнувшая сеть, а не как вечная
 *  поломка: вечная поломка не отличила бы «повторяем» от «повезло». */
function fakeRelayer(opts: {
  store: StoredBag[];
  peerBoxKey: Uint8Array;
  peerSignKey: Uint8Array;
  failKey?: string;
  failTimes?: number;
}) {
  const downloads: string[] = [];
  let failsLeft = opts.failTimes ?? 0;
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
      const inbox = (since === null ? opts.store : opts.store.filter(b => b.uploadedAt >= since))
        .map(({ key, sender, size, uploadedAt }) => ({ key, sender, size, uploadedAt }));
      return new Response(JSON.stringify({ inbox, sent: [], peers: [] }), { status: 200 });
    }
    if (init?.method === 'PUT') return new Response(JSON.stringify({ key: 'a/1' }), { status: 200 });

    const key = decodeURIComponent(p.replace(/^\/bags\//, ''));
    downloads.push(key);
    if (opts.failKey && key === opts.failKey && failsLeft > 0) {
      failsLeft--;
      // Сеть моргнула. Не 404 («мешка нет») и не 403 — именно обрыв, про
      // который НИЧЕГО не известно, кроме того, что байтов мы не получили.
      throw new TypeError('Failed to fetch');
    }
    const bag = opts.store.find(b => b.key === key);
    if (!bag) return new Response(JSON.stringify({ error: 'no', code: 'bag_not_found' }), { status: 404 });
    return new Response(bag.body, { status: 200 });
  });
  return { fetchMock, downloads };
}

async function waitFor(cond: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) return; // не бросаем: замер важнее, чем «условие не наступило»
    await new Promise(r => setTimeout(r, 5));
  }
}

function drive(engineOpts: Parameters<typeof startPairChat>[0]) {
  const states: StateWithBacklog[] = [];
  const errors: unknown[] = [];
  const engine = startPairChat({
    ...engineOpts,
    onState: (s) => { states.push(s); },
    onError: (e) => { errors.push(e); },
    sleep: async () => { await new Promise(r => setTimeout(r, 1)); },
  });
  return { engine, states, errors };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetBagPassCacheForTest();
});

describe('К-2: сеть моргнула посреди пачки', () => {
  it('ЗАМЕР: десять мешков, один отказ на третьем — доезжают ВСЕ десять', async () => {
    // Что красит: возврат к «скачал — и забыл, что не скачал». Тогда после
    // отказа на третьем показываются два сообщения из десяти, и больше
    // никогда ничего: курсор ушёл вперёд всей пачки.
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const bobSigner = await deriveLinkSigningKeypair(bob.keypair);
    const store = await buildBags(
      bob, BOB, ALICE, alice.keypair.publicKey,
      Array.from({ length: 10 }, (_, i) => `сообщение ${i}`),
    );

    const { fetchMock, downloads } = fakeRelayer({
      store, peerBoxKey: bob.keypair.publicKey, peerSignKey: bobSigner.publicKey,
      failKey: store[2].key, failTimes: 1,
    });
    vi.stubGlobal('fetch', fetchMock);

    const run = drive({ session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true });
    try {
      await waitFor(() => run.states.some(s => s.messages.length === 10), 12_000);
    } finally {
      run.engine.stop();
    }

    const best = run.states.reduce((a, b) => (b.messages.length > a.messages.length ? b : a), run.states[0]);
    console.log(
      `[К-2 замер А] мешков у склада: ${store.length}; показано сообщений: ${best.messages.length}; ` +
      `скачиваний: ${downloads.length}`,
    );
    expect(best.messages.map(m => m.text)).toEqual(store.map((_, i) => `сообщение ${i}`));
  }, 40_000);

  it('ЗАМЕР: пока невзятое висит — состояние ГОВОРИТ об этом, а не молчит', async () => {
    // Что красит: снятие подсчёта невзятого. Тогда `pendingBags` — undefined
    // (или ноль), и человек, у которого пропали семь сообщений, видит ровно
    // то же, что человек, у которого не пропало ничего.
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const bobSigner = await deriveLinkSigningKeypair(bob.keypair);
    const store = await buildBags(
      bob, BOB, ALICE, alice.keypair.publicKey,
      Array.from({ length: 10 }, (_, i) => `сообщение ${i}`),
    );

    // Отказ ДОЛГИЙ — иначе состояние «висит невзятое» промелькнёт быстрее,
    // чем его успеет увидеть кто угодно, включая человека.
    const { fetchMock } = fakeRelayer({
      store, peerBoxKey: bob.keypair.publicKey, peerSignKey: bobSigner.publicKey,
      failKey: store[2].key, failTimes: 1000,
    });
    vi.stubGlobal('fetch', fetchMock);

    const run = drive({ session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true });
    try {
      await waitFor(() => run.states.some(s => (s.pendingBags ?? 0) > 0 && s.bagsFailed === true), 12_000);
    } finally {
      run.engine.stop();
    }

    const said = run.states.filter(s => (s.pendingBags ?? 0) > 0);
    const admitted = run.states.filter(s => s.bagsFailed === true);
    console.log(
      `[К-2 замер Б] выдач состояния: ${run.states.length}; из них назвали невзятое: ${said.length}; ` +
      `признались в отказе: ${admitted.length}; невзятых в последней: ` +
      `${run.states[run.states.length - 1]?.pendingBags ?? 'поля нет'}`,
    );
    expect(said.length).toBeGreaterThan(0);
    expect(admitted.length).toBeGreaterThan(0);
  }, 40_000);
});
