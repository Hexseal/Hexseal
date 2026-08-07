/**
 * pairConversationsFlood.test.ts — В-1: список переписок под наводнением.
 *
 * ЧТО НАШЛА ВРАЖДЕБНАЯ ПРОВЕРКА. Список собеседников берётся из поля `peers`
 * ответа склада — то есть из тех, с кем есть хоть один мешок в любую сторону.
 * Положить мешок в чужой ящик может кто угодно, кто знает адрес. Значит N
 * посторонних адресов дают N строк в списке и N ПОСЛЕДОВАТЕЛЬНЫХ СКАЧИВАНИЙ —
 * и не один раз, а НА КАЖДЫЙ ЗАХОД: превью нигде не запоминалось, и те же
 * мешки качались заново каждые тридцать секунд, при каждом возврате во вкладку
 * и на каждое новое сообщение в открытом чате.
 *
 * ⚠️ И ЭТО ТОТ ЖЕ АДРЕСНЫЙ БЮДЖЕТ, что у открытого чата: `BAG_READ_RATE_MAX =
 * 120` чтений в минуту на адрес, общих у перечисления и скачивания. Тысяча
 * превью — это не «немного медленнее», это `429` на собственный опрос.
 *
 * ЗАМЕРЫ ЗДЕСЬ ТРИ:
 *  А. СКОЛЬКО СКАЧИВАНИЙ на первый заход при тысяче посторонних.
 *  Б. СКОЛЬКО НА ВТОРОЙ заход — то есть помнит ли что-нибудь список вообще.
 *  В. ДОСТАЁТСЯ ЛИ ПРЕВЬЮ НАСТОЯЩЕЙ ПЕРЕПИСКЕ, когда посторонних тысяча.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveChatKeypair } from '@/lib/chatCrypto';
import type { ChatSession } from '@/lib/chatSession';
import {
  deriveLinkSigningKeypair, encodeFrame, messageBodyHash, linkSignaturePreimage,
} from '@/lib/chatConversation';
import { buildLink } from '@/lib/chatChain';
import { packEnvelope } from '@/lib/chatEnvelope';
import { _resetBagPassCacheForTest } from '@/lib/chatTransport';
import { loadPairConversations } from './usePairConversations';

const ALICE = '0xA1cE00000000000000000000000000000000CAfE' as const;
const BOB   = '0xB0b1000000000000000000000000000000005eEd' as const;

/**
 * Потолок превью за заход записан ЗДЕСЬ РУКАМИ, а не взят из проверяемого
 * модуля (правило проекта). Выведен из чужого, боевого: склад даёт адресу 120
 * чтений в минуту, общих; открытый чат берёт 12 перечислений и до 80
 * скачиваний; списку переписок остаётся около 28, из них 2 — его собственные
 * перечисления.
 */
const PREVIEW_BUDGET = 26;

function sig(fill: string): `0x${string}` {
  return ('0x' + fill.repeat(130).slice(0, 130)) as `0x${string}`;
}
async function makeSession(address: `0x${string}`, seed: string): Promise<ChatSession> {
  return {
    keypair: await deriveChatKeypair(sig(seed)),
    address, origin: 'signature', walletKind: 'eoa', restored: false, persisted: true,
  };
}

interface StoredBag { key: string; sender: string; size: number; uploadedAt: number; body: Uint8Array }

async function oneBag(
  from: ChatSession, sender: `0x${string}`, recipientPub: Uint8Array, text: string, at: number,
): Promise<StoredBag> {
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  const signer = await deriveLinkSigningKeypair(from.keypair);
  const lc = sender.toLowerCase() as `0x${string}`;
  const envelope = await packEnvelope({ text }, recipientPub, from.keypair.publicKey, lc);
  const link = buildLink(null, messageBodyHash(signer.publicKey, envelope), lc, at);
  const signature = sodium.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey);
  const body = encodeFrame({ link, signature, signerPublicKey: signer.publicKey, envelope });
  return { key: `${ALICE.toLowerCase()}/${at}-${lc.slice(2, 8)}.bin`, sender: lc, size: body.length, uploadedAt: at, body };
}

/** Адрес постороннего номер `i` — настоящей формы, не выдуманной. */
function strangerAddress(i: number): `0x${string}` {
  return ('0x' + i.toString(16).padStart(40, '0')) as `0x${string}`;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetBagPassCacheForTest();
});

describe('В-1: тысяча посторонних в списке переписок', () => {
  it('ЗАМЕР: тысяча посторонних — скачиваний не больше бюджета, и второй заход НОЛЬ', async () => {
    // Что красит: снятие потолка превью (первый заход снова тысяча скачиваний)
    // ИЛИ снятие памяти о превью (второй заход снова тысяча).
    const alice = await makeSession(ALICE, 'a1');
    const N = 1_000;

    const bags: StoredBag[] = [];
    const peers: { address: string; lastActivityWithMeAt: number }[] = [];
    // Один общий кошелёк на всех посторонних: разбор превью всё равно
    // отвергнет чужие конверты, а сборка тысячи пар ключей — это минуты, к
    // замеру отношения не имеющие. Важно здесь одно — тысяча РАЗНЫХ адресов.
    const stranger = await makeSession(strangerAddress(1), 'ff');
    for (let i = 1; i <= N; i++) {
      const addr = strangerAddress(i);
      bags.push(await oneBag(stranger, addr, alice.keypair.publicKey, `мусор ${i}`, 1_700_000_000_000 + i));
      peers.push({ address: addr.toLowerCase(), lastActivityWithMeAt: 1_700_000_000_000 + i });
    }

    const downloads: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname === '/bags') {
        return new Response(JSON.stringify({
          inbox: bags.map(({ key, sender, size, uploadedAt }) => ({ key, sender, size, uploadedAt })),
          sent: [], peers,
        }), { status: 200 });
      }
      const key = decodeURIComponent(u.pathname.replace(/^\/bags\//, ''));
      downloads.push(key);
      const bag = bags.find(b => b.key === key);
      return bag ? new Response(bag.body, { status: 200 }) : new Response('{}', { status: 404 });
    }));

    const first = await loadPairConversations(alice, 'v1.p');
    const firstDownloads = downloads.length;
    downloads.length = 0;
    const second = await loadPairConversations(alice, 'v1.p');
    const secondDownloads = downloads.length;

    console.log(
      `[В-1 замер] посторонних: ${N}; строк в списке: ${first.length}; ` +
      `скачиваний на первый заход: ${firstDownloads}; на второй: ${secondDownloads}`,
    );

    expect(second).toHaveLength(first.length);
    expect(firstDownloads).toBeLessThanOrEqual(PREVIEW_BUDGET);
    expect(secondDownloads).toBe(0);
  }, 120_000);

  it('ЗАМЕР: настоящая переписка получает превью, даже когда посторонних тысяча', async () => {
    // Потолок превью сам по себе — половина ответа: если тратить его на тех,
    // кто первым попался, тысяча посторонних просто съест его, и человек
    // увидит пустое превью у ЕДИНСТВЕННОЙ своей настоящей переписки.
    //
    // Что красит: возврат к обходу собеседников в порядке, который дал сервер,
    // без различения «мы ему писали» и «он написал нам».
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const stranger = await makeSession(strangerAddress(1), 'ff');
    const N = 1_000;

    const bags: StoredBag[] = [];
    const peers: { address: string; lastActivityWithMeAt: number }[] = [];
    for (let i = 1; i <= N; i++) {
      const addr = strangerAddress(i);
      // Посторонние СВЕЖЕЕ настоящей переписки — иначе замок держался бы на
      // сортировке по времени, а не на различении «мы ему писали».
      bags.push(await oneBag(stranger, addr, alice.keypair.publicKey, `мусор ${i}`, 1_700_000_100_000 + i));
      peers.push({ address: addr.toLowerCase(), lastActivityWithMeAt: 1_700_000_100_000 + i });
    }
    const fromBob = await oneBag(bob, BOB, alice.keypair.publicKey, 'привет, это Боб', 1_700_000_001_000);
    bags.push(fromBob);
    peers.push({ address: BOB.toLowerCase(), lastActivityWithMeAt: 1_700_000_001_000 });

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname === '/bags') {
        return new Response(JSON.stringify({
          inbox: bags.map(({ key, sender, size, uploadedAt }) => ({ key, sender, size, uploadedAt })),
          // Мы Бобу писали — и это единственное, чем настоящая переписка
          // отличается от навязанной.
          sent: [{ key: `${BOB.toLowerCase()}/1700000000900-a1ce00.bin`, recipient: BOB.toLowerCase(), uploadedAt: 1_700_000_000_900, fetched: true }],
          peers,
        }), { status: 200 });
      }
      const key = decodeURIComponent(u.pathname.replace(/^\/bags\//, ''));
      const bag = bags.find(b => b.key === key);
      return bag ? new Response(bag.body, { status: 200 }) : new Response('{}', { status: 404 });
    }));

    const rows = await loadPairConversations(alice, 'v1.p');
    const bobRow = rows.find(r => r.peerAddress === BOB.toLowerCase());
    console.log(
      `[В-1 замер В] строк: ${rows.length}; превью Боба: «${bobRow?.lastText ?? '—'}»; ` +
      `место Боба в списке: ${rows.findIndex(r => r.peerAddress === BOB.toLowerCase())}`,
    );
    expect(bobRow?.lastText).toBe('привет, это Боб');
  }, 120_000);
});
