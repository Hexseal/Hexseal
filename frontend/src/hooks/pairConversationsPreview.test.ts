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

/**
 * НАШ ОТПРАВЛЕННЫЙ мешок: получатель — собеседник, ключ файла — на его адрес
 * (`<получатель>/<файл>.bin`, как пишет склад), автор — мы.
 *
 * Читается он НАШЕЙ ЖЕ парой: конверт запечатан двумя слотами — получателю и
 * себе (разбор — шапка `lib/chatEnvelope.ts`), второй слот заведён ровно
 * затем, чтобы отправитель читал свою половину переписки.
 */
async function ownBag(me: ChatSession, peer: `0x${string}`, peerPub: Uint8Array, text: string, at: number) {
  const bag = await oneBag(me, me.address as `0x${string}`, peerPub, text, at);
  return { ...bag, key: `${peer.toLowerCase()}/${at}.bin` };
}

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

  it('последнее слово НАШЕ — превью показывает ЕГО ТЕКСТ', async () => {
    // ⚠️ ВЛАДЕЛЕЦ НАЗВАЛ ЭТО ДОСЛОВНО: «он не отображает сообщение
    // отправляющего, не видит или шо». Из четырёх причин пустого превью на
    // живом устройстве работала именно эта.
    //
    // Подписывать этот случай («вы написали последним») — не починка: текст у
    // нас ЕСТЬ. Конверт запечатан двумя слотами, второй наш; склад отдаёт мешок
    // и отправителю (`meta.sender === address` в `relayer/app.js`). Список
    // просто не шёл за своей половиной.
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const mine = await ownBag(alice, BOB, bob.keypair.publicKey, 'наше последнее слово', 1_700_000_005_000);
    stubStore({
      sent: [{ key: mine.key, recipient: BOB.toLowerCase(), uploadedAt: mine.uploadedAt, fetched: false }],
      peers: [{ address: BOB.toLowerCase(), lastActivityWithMeAt: mine.uploadedAt }],
      bodies: new Map([[mine.key, mine.body]]),
    });
    const rows = await loadPairConversations(alice, 'v1.p');
    expect(rows[0].lastText, 'своё последнее сообщение в превью не доехало').toBe('наше последнее слово');
    expect(rows[0].lastFromMe).toBe(true);
    expect(rows[0].preview).toBe('text');
  }, 20_000);

  it('наше слово СВЕЖЕЕ чужого — показывается наше', async () => {
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const theirs = await oneBag(bob, BOB, alice.keypair.publicKey, 'их слово', 1_700_000_001_000);
    const mine = await ownBag(alice, BOB, bob.keypair.publicKey, 'наш ответ', 1_700_000_009_000);
    stubStore({
      inbox: [theirs],
      sent: [{ key: mine.key, recipient: BOB.toLowerCase(), uploadedAt: mine.uploadedAt, fetched: false }],
      peers: [{ address: BOB.toLowerCase(), lastActivityWithMeAt: mine.uploadedAt }],
      bodies: new Map([[theirs.key, theirs.body], [mine.key, mine.body]]),
    });
    const rows = await loadPairConversations(alice, 'v1.p');
    expect(rows[0].lastText).toBe('наш ответ');
    expect(rows[0].lastFromMe).toBe(true);
  }, 20_000);

  it('чужое слово свежее нашего — показывается чужое, и признак стороны верен', async () => {
    // Замок, который горит всегда, — не замок: обратный случай обязан остаться
    // прежним.
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const mine = await ownBag(alice, BOB, bob.keypair.publicKey, 'наш вопрос', 1_700_000_001_000);
    const theirs = await oneBag(bob, BOB, alice.keypair.publicKey, 'их ответ', 1_700_000_009_000);
    stubStore({
      inbox: [theirs],
      sent: [{ key: mine.key, recipient: BOB.toLowerCase(), uploadedAt: mine.uploadedAt, fetched: false }],
      peers: [{ address: BOB.toLowerCase(), lastActivityWithMeAt: theirs.uploadedAt }],
      bodies: new Map([[theirs.key, theirs.body], [mine.key, mine.body]]),
    });
    const rows = await loadPairConversations(alice, 'v1.p');
    expect(rows[0].lastText).toBe('их ответ');
    expect(rows[0].lastFromMe).toBe(false);
  }, 20_000);

  it('своё последнее сообщение НЕ СКАЧАНО — «ещё не загрузилось», а не «нет»', async () => {
    // Единственный случай, когда про своё слово нечего показать: мешок есть в
    // описи, а тела нет (истёк срок хранения, отказ склада). Признак стороны
    // при этом верен — значит строка не врёт.
    const alice = await makeSession(ALICE, 'a1');
    stubStore({
      sent: [{ key: `${BOB.toLowerCase()}/1.bin`, recipient: BOB.toLowerCase(), uploadedAt: 1_700_000_005_000, fetched: false }],
      peers: [{ address: BOB.toLowerCase(), lastActivityWithMeAt: 1_700_000_005_000 }],
      budgetOut: true,
    });
    const rows = await loadPairConversations(alice, 'v1.p');
    expect(rows[0].lastText).toBe('');
    expect(rows[0].lastFromMe).toBe(true);
    expect(rows[0].preview).toBe('pending');
  }, 20_000);

  it('двадцать переписок в обе стороны — РОВНО двадцать скачиваний', async () => {
    // ⚠️ Своя половина уже приезжает тем же ответом склада (поле `sent`), и
    // качаем мы по-прежнему ОДИН мешок на собеседника — самый свежий в любую
    // сторону. Значит запросов не прибавилось ни одного: было двадцать (по
    // одному на собеседника), стало двадцать.
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const inbox: Bag[] = [];
    const sent: { key: string; recipient: string; uploadedAt: number; fetched: boolean }[] = [];
    const peers: { address: string; lastActivityWithMeAt: number }[] = [];
    const bodies = new Map<string, Uint8Array>();
    for (let i = 0; i < 20; i++) {
      const addr = ('0x' + (i + 32).toString(16).padStart(40, '0')) as `0x${string}`;
      const theirs = await oneBag(bob, addr, alice.keypair.publicKey, `их ${i}`, 1_700_000_000_000 + i * 10);
      theirs.key = `${ALICE.toLowerCase()}/in-${i}.bin`;
      const mine = await ownBag(alice, addr, bob.keypair.publicKey, `наше ${i}`, 1_700_000_000_000 + i * 10 + 5);
      inbox.push(theirs);
      sent.push({ key: mine.key, recipient: addr.toLowerCase(), uploadedAt: mine.uploadedAt, fetched: false });
      peers.push({ address: addr.toLowerCase(), lastActivityWithMeAt: mine.uploadedAt });
      bodies.set(theirs.key, theirs.body);
      bodies.set(mine.key, mine.body);
    }
    const { downloads } = stubStore({ inbox, sent, peers, bodies });
    const rows = await loadPairConversations(alice, 'v1.p');
    expect(rows.length).toBe(20);
    expect(downloads.length, 'запросов к складу прибавилось').toBe(20);
    // И у всех двадцати превью — наше слово, потому что оно свежее.
    expect(rows.filter(r => r.lastFromMe && r.lastText.startsWith('наше')).length).toBe(20);
  }, 60_000);

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
