/**
 * usePairConversations.test.ts — список переписок из наших же данных.
 *
 * Задача 6 плана «Клиент чата». Тот же приём, что в `usePairChat.test.ts`:
 * проверяется ЧИСТАЯ функция (`loadPairConversations`), не React-обёртка —
 * отрисовать хук в этом окружении нечем.
 *
 * Главное свойство здесь — список собеседников берётся из ОДНОГО ответа
 * `GET /bags`, который и так приходит на каждом тике опроса. Отдельного
 * запроса за списком переписок нет и не должно появиться.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveChatKeypair } from '@/lib/chatCrypto';
import type { ChatSession } from '@/lib/chatSession';
import { deriveLinkSigningKeypair, encodeFrame, messageBodyHash, linkSignaturePreimage } from '@/lib/chatConversation';
import { buildLink } from '@/lib/chatChain';
import { packEnvelope } from '@/lib/chatEnvelope';
import { _resetBagPassCacheForTest } from '@/lib/chatTransport';
import { loadPairConversations } from './usePairConversations';

const ALICE = '0xA1cE00000000000000000000000000000000CAfE' as const;
const BOB   = '0xB0b1000000000000000000000000000000005eEd' as const;
const CAROL = '0xCa401000000000000000000000000000000f00d5' as const;

function sig(fill: string): `0x${string}` {
  return ('0x' + fill.repeat(130).slice(0, 130)) as `0x${string}`;
}

async function makeSession(address: `0x${string}`, seed: string): Promise<ChatSession> {
  return {
    keypair: await deriveChatKeypair(sig(seed)),
    address, origin: 'signature', walletKind: 'eoa', restored: false, persisted: true,
  };
}

async function oneBag(from: ChatSession, sender: `0x${string}`, recipientPub: Uint8Array, text: string, at: number) {
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  const signer = await deriveLinkSigningKeypair(from.keypair);
  const envelope = await packEnvelope({ text }, recipientPub, from.keypair.publicKey, sender.toLowerCase() as `0x${string}`);
  const bodyHash = messageBodyHash(signer.publicKey, envelope);
  const link = buildLink(null, bodyHash, sender.toLowerCase() as `0x${string}`, at);
  const signature = sodium.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey);
  const body = encodeFrame({ link, signature, signerPublicKey: signer.publicKey, envelope });
  return { key: `${ALICE.toLowerCase()}/${at}.bin`, sender: sender.toLowerCase(), size: body.length, uploadedAt: at, body };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetBagPassCacheForTest();
});

describe('список переписок', () => {
  it('ЗАМЕР: один запрос списка на всю загрузку, а не запрос на собеседника', async () => {
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const carol = await makeSession(CAROL, 'cc');

    const fromBob = await oneBag(bob, BOB, alice.keypair.publicKey, 'привет от Боба', 1_700_000_001_000);
    const fromCarol = await oneBag(carol, CAROL, alice.keypair.publicKey, 'привет от Кэрол', 1_700_000_002_000);
    const bags = [fromBob, fromCarol];

    const listCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname === '/bags') {
        listCalls.push(u.toString());
        return new Response(JSON.stringify({
          inbox: bags.map(({ key, sender, size, uploadedAt }) => ({ key, sender, size, uploadedAt })),
          sent: [],
          peers: [
            { address: BOB.toLowerCase(), lastActivityWithMeAt: 1_700_000_001_000 },
            { address: CAROL.toLowerCase(), lastActivityWithMeAt: 1_700_000_002_000 },
          ],
        }), { status: 200 });
      }
      const key = decodeURIComponent(u.pathname.replace(/^\/bags\//, ''));
      const bag = bags.find(b => b.key === key);
      if (!bag) return new Response('{}', { status: 404 });
      return new Response(bag.body, { status: 200 });
    }));

    const rows = await loadPairConversations(alice, 'v1.p');

    expect(listCalls).toHaveLength(1);
    expect(rows.map(r => r.peerAddress)).toEqual([CAROL.toLowerCase(), BOB.toLowerCase()]);
    // Свежая переписка первой — та же сортировка, что была у XMTP-версии.
    expect(rows[0].lastAt).toBe(1_700_000_002_000);
  }, 20_000);

  it('превью — расшифрованный текст последнего сообщения, а не «зашифровано»', async () => {
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const bag = await oneBag(bob, BOB, alice.keypair.publicKey, 'последнее слово', 1_700_000_003_000);

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname === '/bags') {
        return new Response(JSON.stringify({
          inbox: [{ key: bag.key, sender: bag.sender, size: bag.size, uploadedAt: bag.uploadedAt }],
          sent: [],
          peers: [{ address: BOB.toLowerCase(), lastActivityWithMeAt: 1_700_000_003_000 }],
        }), { status: 200 });
      }
      return new Response(bag.body, { status: 200 });
    }));

    const rows = await loadPairConversations(alice, 'v1.p');
    expect(rows[0].lastText).toBe('последнее слово');
    expect(rows[0].lastFromMe).toBe(false);
  }, 20_000);

  it('собеседник есть, а мешков в его сторону нет — строка всё равно показывается, просто без превью', async () => {
    // Иначе переписка, чьи мешки истекли по сроку хранения, ПРОПАДАЛА бы из
    // списка — «переписка исчезла» на глазах у человека вместо честного
    // пустого превью.
    const alice = await makeSession(ALICE, 'a1');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      inbox: [], sent: [],
      peers: [{ address: BOB.toLowerCase(), lastActivityWithMeAt: null }],
    }), { status: 200 })));

    const rows = await loadPairConversations(alice, 'v1.p');
    expect(rows).toHaveLength(1);
    expect(rows[0].peerAddress).toBe(BOB.toLowerCase());
    expect(rows[0].lastText).toBe('');
    expect(rows[0].lastAt).toBe(0);
  }, 20_000);

  it('нечитаемый мешок собеседника не роняет весь список', async () => {
    // Вопрос «пришёл мусор»: один битый мешок не должен стоить человеку
    // ВСЕХ его переписок.
    const alice = await makeSession(ALICE, 'a1');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname === '/bags') {
        return new Response(JSON.stringify({
          inbox: [{ key: `${ALICE.toLowerCase()}/1.bin`, sender: BOB.toLowerCase(), size: 10, uploadedAt: 5 }],
          sent: [],
          peers: [{ address: BOB.toLowerCase(), lastActivityWithMeAt: 5 }],
        }), { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); // не кадр вовсе
    }));

    const rows = await loadPairConversations(alice, 'v1.p');
    expect(rows).toHaveLength(1);
    expect(rows[0].lastText).toBe('');
  }, 20_000);
});
