/**
 * pairChatTransientError.test.ts — отказ склада уходит сам, когда связь вернулась.
 *
 * ВТОРАЯ ПОЛОВИНА БЛОКЕРА. Первая (экран показывает имеющееся, а не прячет
 * его) заперта в `components/chatPanelTransientError.test.tsx`. Здесь — то, из
 * чего экран это узнаёт.
 *
 * ЧТО БЫЛО. Признак отказа жил ОТДЕЛЬНЫМ состоянием хука и снимался ровно
 * одним способом — перезаводом движка (сменой аккаунта, собеседника или
 * ручным «повторить»). Успешный тик его не трогал. То есть один моргнувший
 * отказ означал экран ошибки НАВСЕГДА, хотя следующий же опрос через пять
 * секунд проходил успешно.
 *
 * ⚠️ ПОЧЕМУ ПРИЗНАК ПЕРЕЕХАЛ В СНИМОК СОСТОЯНИЯ ДВИЖКА. Ровно по той причине,
 * которая уже записана в `usePairChat.ts` про `engineState`: два состояния про
 * одно и то же расходятся рано или поздно. «Сообщения» и «связь есть» —
 * ОДНО И ТО ЖЕ событие (успешный тик), и разносить их по двум `useState`
 * значило заводить шанс обновить одно и забыть другое. Этот шанс и
 * реализовался.
 *
 * Побочная выгода — проверяемость: React-обёртку в этом окружении отрисовать
 * нечем, а снимок движка проверяется замером.
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

/** Поля, которого на момент написания замера в снимке НЕТ — в этом и красный. */
type StateWithTransport = PairChatState & { transportError?: string | null };

const ALICE = '0xA1cE00000000000000000000000000000000CAfE' as const;
const BOB = '0xB0b1000000000000000000000000000000005eEd' as const;

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
      key: `${recipient.toLowerCase()}/${1_700_000_000_000 + i}-b.bin`,
      sender: lc, size: body.length, uploadedAt: 1_700_000_000_000 + i, body,
    });
    prev = link;
  }
  return out;
}

/** Склад, у которого ПЕРЕЧИСЛЕНИЕ отказывает, пока `failing` истинно. */
function fakeRelayer(opts: {
  store: StoredBag[];
  peerBoxKey: Uint8Array;
  peerSignKey: Uint8Array;
  failing: () => boolean;
}) {
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
      if (opts.failing()) {
        // Обычный моргнувший склад: не отказ входа (тот останавливает опрос
        // намеренно), а «сервер сейчас не может».
        return new Response(JSON.stringify({ error: 'busy', code: 'rate_limited' }), { status: 429 });
      }
      const raw = u.searchParams.get('since');
      const since = raw === null ? null : Number(raw);
      const inbox = (since === null ? opts.store : opts.store.filter(b => b.uploadedAt >= since))
        .map(({ key, sender, size, uploadedAt }) => ({ key, sender, size, uploadedAt }));
      return new Response(JSON.stringify({ inbox, sent: [], peers: [] }), { status: 200 });
    }
    if (init?.method === 'PUT') return new Response(JSON.stringify({ key: 'a/1' }), { status: 200 });
    const key = decodeURIComponent(p.replace(/^\/bags\//, ''));
    const bag = opts.store.find(b => b.key === key);
    return bag ? new Response(bag.body, { status: 200 })
      : new Response(JSON.stringify({ error: 'no', code: 'bag_not_found' }), { status: 404 });
  });
  return { fetchMock };
}

async function waitFor(cond: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) return;
    await new Promise(r => setTimeout(r, 5));
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetBagPassCacheForTest();
});

describe('отказ склада — состояние, а не приговор', () => {
  it('ЗАМЕР: отказ посреди работающей переписки — снимок ВЫДАЁТСЯ, сообщения на месте', async () => {
    // Что красит: возврат к тому, что отказ уходит мимо снимка. Тогда после
    // отказа новых снимков не появляется вовсе, `transportError` не существует
    // — и признаку отказа неоткуда взяться рядом с сообщениями.
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const bobSigner = await deriveLinkSigningKeypair(bob.keypair);
    const store = await buildBags(bob, BOB, ALICE, alice.keypair.publicKey, ['раз', 'два', 'три']);

    let failing = false;
    const { fetchMock } = fakeRelayer({
      store, peerBoxKey: bob.keypair.publicKey, peerSignKey: bobSigner.publicKey,
      failing: () => failing,
    });
    vi.stubGlobal('fetch', fetchMock);

    const states: StateWithTransport[] = [];
    const engine = startPairChat({
      session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true,
      onState: (s) => { states.push(s); }, onError: () => {},
      sleep: async () => { await new Promise(r => setTimeout(r, 1)); },
    });
    try {
      await waitFor(() => states.some(s => s.messages.length === 3));
      const before = states.length;
      failing = true;                       // склад моргнул
      await waitFor(() => states.length > before && states[states.length - 1].transportError != null);

      const last = states[states.length - 1];
      console.log(
        `[блокер замер] при отказе склада: снимков после отказа ${states.length - before}, ` +
        `сообщений в снимке ${last.messages.length}, признак отказа ${JSON.stringify(last.transportError)}`,
      );
      // Снимок выдан, сообщения НЕ потеряны, отказ назван.
      expect(last.messages.map(m => m.text)).toEqual(['раз', 'два', 'три']);
      expect(last.transportError).toBe('rate_limited');
    } finally {
      engine.stop();
    }
  }, 40_000);

  it('ЗАМЕР: связь вернулась — признак отказа снимается САМ, без перезавода', async () => {
    // Что красит: снятие строки, обнуляющей признак на успешном тике. Тогда
    // отказ держится вечно, и единственный выход — ручное «повторить».
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const bobSigner = await deriveLinkSigningKeypair(bob.keypair);
    const store = await buildBags(bob, BOB, ALICE, alice.keypair.publicKey, ['раз']);

    let failing = true;                     // сразу лежит
    const { fetchMock } = fakeRelayer({
      store, peerBoxKey: bob.keypair.publicKey, peerSignKey: bobSigner.publicKey,
      failing: () => failing,
    });
    vi.stubGlobal('fetch', fetchMock);

    const states: StateWithTransport[] = [];
    const engine = startPairChat({
      session: alice, peer: BOB, getPass: async () => 'v1.p', isActive: () => true,
      onState: (s) => { states.push(s); }, onError: () => {},
      sleep: async () => { await new Promise(r => setTimeout(r, 1)); },
    });
    try {
      await waitFor(() => states.some(s => s.transportError != null));
      const failedAt = states.length;
      failing = false;                      // связь вернулась
      await waitFor(() => states.length > failedAt && states[states.length - 1].transportError == null);

      const last = states[states.length - 1];
      console.log(
        `[блокер замер] после возврата связи: признак отказа ${JSON.stringify(last.transportError)}, ` +
        `сообщений ${last.messages.length}`,
      );
      expect(last.transportError).toBeNull();
      expect(last.messages.map(m => m.text)).toEqual(['раз']);
    } finally {
      engine.stop();
    }
  }, 40_000);
});
