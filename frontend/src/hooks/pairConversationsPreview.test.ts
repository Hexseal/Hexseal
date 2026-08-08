/**
 * pairConversationsPreview.test.ts — почему у строки нет последнего сообщения.
 *
 * ─── ЧТО СКАЗАЛ ВЛАДЕЛЕЦ ────────────────────────────────────────────────────
 *
 * Дословно: «и сообщения, какие-то нормально в списке отображаюсься, какие-то
 * нет. гдето написано последнее сообщение а гдето нет».
 *
 * ─── ПОЧЕМУ ЭТО НЕ КОСМЕТИКА ────────────────────────────────────────────────
 *
 * Пустое превью рисуется словами «Сообщений пока нет». Это УТВЕРЖДЕНИЕ, и в
 * трёх случаях из четырёх оно ЛОЖНОЕ:
 *
 *   1. последнее слово — НАШЕ. Свой мешок запечатан на ключ собеседника, у нас
 *      его не расшифровать; текста нет, но сообщение есть, и оно наше;
 *   2. мешок ещё не скачан (кончился бюджет чтения на этот заход, или
 *      собеседнику не досталось места среди претендентов). Сообщение есть,
 *      просто мы его пока не забрали;
 *   3. мешок скачан и НЕ ВСКРЫЛСЯ — запечатан на прежний ключ этого устройства
 *      или испорчен. Сообщение есть, и здесь его не прочесть никогда.
 *
 * И только четвёртый случай — «мешков нет вовсе» — та самая пустота, про
 * которую написано. Все четыре выглядели на экране одинаково, поэтому «где-то
 * есть, где-то нет» и читалось как случайность.
 *
 * Здесь мерится ПРИЧИНА в строке — поле `preview`. Слова к причинам подбирает
 * разметка (`app/chat/page.tsx`), и это отдельный замок.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveChatKeypair } from '@/lib/chatCrypto';
import type { ChatSession } from '@/lib/chatSession';
import { deriveLinkSigningKeypair, encodeFrame, messageBodyHash, linkSignaturePreimage } from '@/lib/chatConversation';
import { buildLink } from '@/lib/chatChain';
import { packEnvelope } from '@/lib/chatEnvelope';
import { _resetBagPassCacheForTest } from '@/lib/chatTransport';
import {
  loadPairConversations, _resetPreviewCacheForTest, UNKNOWN_PREVIEW_SLOTS,
} from './usePairConversations';

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

async function oneBag(
  from: ChatSession, sender: `0x${string}`, recipientPub: Uint8Array, text: string, at: number,
) {
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

interface Bag { key: string; sender: string; size: number; uploadedAt: number; body: Uint8Array }

/** Склад: перечисление плюс выдача тел. `deny` — ключи, которые не отдаются. */
function stubStore(opts: {
  inbox?: Bag[];
  sent?: { key: string; recipient: string; uploadedAt: number; fetched: boolean }[];
  peers: { address: string; lastActivityWithMeAt: number | null }[];
  bodies?: Map<string, Uint8Array>;
  budgetOut?: boolean;
}): { downloads: string[] } {
  const downloads: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.pathname === '/bags') {
      return new Response(JSON.stringify({
        inbox: (opts.inbox ?? []).map(({ key, sender, size, uploadedAt }) => ({ key, sender, size, uploadedAt })),
        sent: opts.sent ?? [],
        peers: opts.peers,
      }), { status: 200 });
    }
    const key = decodeURIComponent(u.pathname.replace(/^\/bags\//, ''));
    downloads.push(key);
    if (opts.budgetOut) {
      return new Response(JSON.stringify({ code: 'read_budget_exceeded' }), { status: 429 });
    }
    const body = opts.bodies?.get(key);
    if (!body) return new Response('{}', { status: 404 });
    return new Response(body, { status: 200 });
  }));
  return { downloads };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetBagPassCacheForTest();
  _resetPreviewCacheForTest();
});

describe('причина пустого превью названа в строке', () => {
  it('мешок вскрылся — превью текстом', async () => {
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const bag = await oneBag(bob, BOB, alice.keypair.publicKey, 'последнее слово', 1_700_000_003_000);
    stubStore({
      inbox: [bag], peers: [{ address: BOB.toLowerCase(), lastActivityWithMeAt: bag.uploadedAt }],
      bodies: new Map([[bag.key, bag.body]]),
    });
    const rows = await loadPairConversations(alice, 'v1.p');
    expect(rows[0].lastText).toBe('последнее слово');
    expect(rows[0].preview).toBe('text');
  }, 20_000);

  it('мешков нет ни в одну сторону — «сообщений нет», и это правда', async () => {
    const alice = await makeSession(ALICE, 'a1');
    stubStore({ peers: [{ address: BOB.toLowerCase(), lastActivityWithMeAt: 1_700_000_000_000 }] });
    const rows = await loadPairConversations(alice, 'v1.p');
    expect(rows[0].lastText).toBe('');
    expect(rows[0].preview).toBe('none');
  }, 20_000);

  it('последнее слово НАШЕ — так и сказано, а не «сообщений нет»', async () => {
    // Свой мешок запечатан на ключ собеседника: расшифровать его нам нечем.
    // Но «сообщений пока нет» — вранье: мы только что написали.
    const alice = await makeSession(ALICE, 'a1');
    stubStore({
      sent: [{ key: 'out/1.bin', recipient: BOB.toLowerCase(), uploadedAt: 1_700_000_005_000, fetched: false }],
      peers: [{ address: BOB.toLowerCase(), lastActivityWithMeAt: 1_700_000_005_000 }],
    });
    const rows = await loadPairConversations(alice, 'v1.p');
    expect(rows[0].lastFromMe).toBe(true);
    expect(rows[0].preview).toBe('from_me');
  }, 20_000);

  it('мешок не скачан (склад отбил чтение) — «ещё не загружено», а не «нет»', async () => {
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const bag = await oneBag(bob, BOB, alice.keypair.publicKey, 'не доедет', 1_700_000_006_000);
    stubStore({
      inbox: [bag], peers: [{ address: BOB.toLowerCase(), lastActivityWithMeAt: bag.uploadedAt }],
      budgetOut: true,
    });
    const rows = await loadPairConversations(alice, 'v1.p');
    expect(rows[0].lastText).toBe('');
    expect(rows[0].preview, 'нескачанный мешок выдан за «сообщений нет»').toBe('pending');
  }, 20_000);

  it('мешок скачан и НЕ вскрылся — «не читается здесь», а не «нет»', async () => {
    // Запечатано на прежний ключ этого устройства (или испорчено по дороге).
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const other = await makeSession(ALICE, 'ff'); // ДРУГОЙ ключ того же адреса
    const bag = await oneBag(bob, BOB, other.keypair.publicKey, 'не для этого ключа', 1_700_000_007_000);
    stubStore({
      inbox: [bag], peers: [{ address: BOB.toLowerCase(), lastActivityWithMeAt: bag.uploadedAt }],
      bodies: new Map([[bag.key, bag.body]]),
    });
    const rows = await loadPairConversations(alice, 'v1.p');
    expect(rows[0].lastText).toBe('');
    expect(rows[0].preview, 'нечитаемый мешок выдан за «сообщений нет»').toBe('unreadable');
  }, 20_000);

  it('мешку не досталось места среди претендентов — «ещё не загружено»', async () => {
    // Наводнение: посторонних больше, чем мест. Тем, кому места не хватило,
    // превью не скачивается вовсе — и это НЕ «сообщений нет».
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const inbox: Bag[] = [];
    const peers: { address: string; lastActivityWithMeAt: number }[] = [];
    const bodies = new Map<string, Uint8Array>();
    const count = UNKNOWN_PREVIEW_SLOTS + 3;
    for (let i = 0; i < count; i++) {
      const addr = ('0x' + (i + 16).toString(16).padStart(2, '0').repeat(20)) as `0x${string}`;
      const bag = await oneBag(bob, addr, alice.keypair.publicKey, `от ${i}`, 1_700_000_000_000 + (count - i) * 1000);
      bag.key = `${addr.toLowerCase()}/${i}.bin`;
      inbox.push(bag);
      bodies.set(bag.key, bag.body);
      peers.push({ address: addr.toLowerCase(), lastActivityWithMeAt: bag.uploadedAt });
    }
    stubStore({ inbox, peers, bodies });
    const rows = await loadPairConversations(alice, 'v1.p');
    const pending = rows.filter(r => r.preview === 'pending').length;
    const текст = rows.filter(r => r.preview === 'text').length;
    expect(текст, 'превью досталось не тем, кому положено по местам').toBe(UNKNOWN_PREVIEW_SLOTS);
    expect(pending, 'обделённые строки говорят «сообщений нет»').toBe(3);
    expect(rows.every(r => r.preview !== 'none'), 'у кого-то есть мешок и «сообщений нет»').toBe(true);
  }, 40_000);
});
