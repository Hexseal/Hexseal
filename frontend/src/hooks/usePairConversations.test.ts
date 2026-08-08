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
import {
  loadPairConversations, createConversationLoader, CONVERSATION_AUTH_FAILURE_LIMIT,
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

  it('ЗАМЕР: на собеседника скачивается РОВНО один мешок — самый свежий, а не вся переписка', async () => {
    // Что красит: «качать всё подряд» вместо «самый свежий». На переписке в
    // тысячу сообщений разница между 1 и 1000 скачиваниями на КАЖДОЕ
    // открытие списка — это и есть вопрос «долбят нарочно», только сами себе.
    const alice = await makeSession(ALICE, 'a1');
    const bob = await makeSession(BOB, 'bb');
    const older = await oneBag(bob, BOB, alice.keypair.publicKey, 'старое', 1_700_000_010_000);
    const newer = await oneBag(bob, BOB, alice.keypair.publicKey, 'новое', 1_700_000_020_000);
    // ⚠️ Порядок НАРОЧНО «новое раньше старого». Склад порядок выдачи не
    // обещает, а первая версия этого замка клала мешки по возрастанию — и
    // мутация «брать не самый свежий, а последний в списке» проходила
    // зелёной чисто по совпадению порядка.
    const bags = [newer, older];

    const downloaded: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname === '/bags') {
        return new Response(JSON.stringify({
          inbox: bags.map(({ key, sender, size, uploadedAt }) => ({ key, sender, size, uploadedAt })),
          sent: [],
          peers: [{ address: BOB.toLowerCase(), lastActivityWithMeAt: 1_700_000_020_000 }],
        }), { status: 200 });
      }
      const key = decodeURIComponent(u.pathname.replace(/^\/bags\//, ''));
      downloaded.push(key);
      const bag = bags.find(b => b.key === key);
      return bag ? new Response(bag.body, { status: 200 }) : new Response('{}', { status: 404 });
    }));

    const rows = await loadPairConversations(alice, 'v1.p');

    expect(downloaded).toEqual([newer.key]);
    expect(rows[0].lastText).toBe('новое');
  }, 20_000);

  it('склад отказал на скачивании превью — строка остаётся, остальные тоже', async () => {
    // Отличается от «битого мешка» ниже: там скачивание УДАЛОСЬ и мусор
    // разобрался в вердикт, здесь оно ПРОВАЛИЛОСЬ. Разные ветки, и вторая
    // (try/catch вокруг скачивания) без этого замка не проверялась ничем.
    const alice = await makeSession(ALICE, 'a1');
    const carol = await makeSession(CAROL, 'cc');
    const good = await oneBag(carol, CAROL, alice.keypair.publicKey, 'кэрол на связи', 1_700_000_030_000);

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname === '/bags') {
        return new Response(JSON.stringify({
          inbox: [
            { key: `${ALICE.toLowerCase()}/broken.bin`, sender: BOB.toLowerCase(), size: 9, uploadedAt: 1_700_000_031_000 },
            { key: good.key, sender: good.sender, size: good.size, uploadedAt: good.uploadedAt },
          ],
          sent: [],
          peers: [
            { address: BOB.toLowerCase(), lastActivityWithMeAt: 1_700_000_031_000 },
            { address: CAROL.toLowerCase(), lastActivityWithMeAt: 1_700_000_030_000 },
          ],
        }), { status: 200 });
      }
      const key = decodeURIComponent(u.pathname.replace(/^\/bags\//, ''));
      if (key === good.key) return new Response(good.body, { status: 200 });
      return new Response(JSON.stringify({ error: 'boom', code: 'internal_error' }), { status: 500 });
    }));

    const rows = await loadPairConversations(alice, 'v1.p');

    expect(rows).toHaveLength(2);
    const bobRow = rows.find(r => r.peerAddress === BOB.toLowerCase());
    const carolRow = rows.find(r => r.peerAddress === CAROL.toLowerCase());
    expect(bobRow?.lastText).toBe('');            // превью не собралось
    expect(carolRow?.lastText).toBe('кэрол на связи'); // а соседняя строка цела
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

/* ───── К-1: свой цикл опроса обязан иметь предел неудач входа ───── */

describe('свой цикл опроса не спрашивает подпись бесконечно', () => {
  // Шапка `chatTransport.ts` запрещает это дословно: «Если вы пишете СВОЙ
  // цикл опроса поверх listBags/getPass вместо pollBags — этот запрет снова
  // в силе, и защиты по числу неудач у вас не будет». Список переписок
  // писал ровно такой цикл: setInterval на 30 секунд плюс слушатель возврата
  // во вкладку, отказ уходил в состояние ошибки, цикл не останавливался
  // НИКОГДА. Десять попыток — десять окон кошелька, и так каждые полминуты.

  it('ЗАМЕР: человек отказывается подписывать 10 раз — окон РОВНО 3, потом стоп', async () => {
    let asks = 0;
    let authFailed = 0;
    const errors: unknown[] = [];
    const loader = createConversationLoader({
      getPass: async () => { asks++; throw new Error('User rejected the request'); },
      loadWithPass: async () => [],
      onRows: () => {},
      onError: (e) => { errors.push(e); },
      onAuthFailed: () => { authFailed++; },
    });

    for (let i = 0; i < 10; i++) await loader.run();

    expect(asks).toBe(CONVERSATION_AUTH_FAILURE_LIMIT);
    expect(asks).toBe(3);            // число записано руками, не взято из модуля
    expect(authFailed).toBe(1);      // ровно один раз, а не на каждый следующий тик
    expect(loader.stopped()).toBe(true);
    expect(errors).toHaveLength(3);
  });

  it('401 от самого списка тоже считается неудачей ВХОДА, а не сбоем запроса', async () => {
    const { BagPassError } = await import('@/lib/chatTransport');
    let asks = 0;
    let authFailed = 0;
    const loader = createConversationLoader({
      getPass: async () => { asks++; return 'v1.p'; },
      loadWithPass: async () => { throw new BagPassError('expired', 'pass_expired', 401); },
      onRows: () => {},
      onError: () => {},
      onAuthFailed: () => { authFailed++; },
    });

    for (let i = 0; i < 10; i++) await loader.run();

    expect(asks).toBe(3);
    expect(authFailed).toBe(1);
  });

  it('сетевой отказ СПИСКА предела входа не трогает — цикл продолжает пытаться', async () => {
    // Тот же разбор, что у `pollBags` (C1-R2): отказал ЗАПРОС, а не вход.
    // Свести оба под один счётчик значит закрывать чат от моргнувшей сети.
    let asks = 0;
    let authFailed = 0;
    const loader = createConversationLoader({
      getPass: async () => { asks++; return 'v1.p'; },
      loadWithPass: async () => { throw new TypeError('fetch failed'); },
      onRows: () => {},
      onError: () => {},
      onAuthFailed: () => { authFailed++; },
    });

    for (let i = 0; i < 10; i++) await loader.run();

    expect(asks).toBe(10);
    expect(authFailed).toBe(0);
    expect(loader.stopped()).toBe(false);
  });

  it('успех обнуляет счётчик — две неудачи подряд не копятся через удачную попытку', async () => {
    let asks = 0;
    let authFailed = 0;
    let failNext = true;
    const loader = createConversationLoader({
      getPass: async () => {
        asks++;
        if (failNext) throw new Error('rejected');
        return 'v1.p';
      },
      loadWithPass: async () => [],
      onRows: () => {},
      onError: () => {},
      onAuthFailed: () => { authFailed++; },
    });

    await loader.run(); await loader.run();   // две неудачи
    failNext = false;
    await loader.run();                        // успех — счётчик обнулён
    failNext = true;
    await loader.run(); await loader.run();   // ещё две

    expect(authFailed).toBe(0);
    expect(loader.stopped()).toBe(false);
    expect(asks).toBe(5);
  });
});
