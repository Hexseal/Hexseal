/**
 * chatMessageTime.test.ts — В-2: чьи часы решают, где встанет сообщение.
 *
 * ЧТО НАШЛА ВРАЖДЕБНАЯ ПРОВЕРКА. Время отправки (`sentAt`) ставит САМ
 * ОТПРАВИТЕЛЬ: оно едет внутри звена, подписано его же ключом и может быть
 * любым. По нему же переписка и перемежалась — а засвидетельствованное складом
 * время загрузки (`uploadedAt`) выбрасывалось на первом же шаге разбора.
 *
 * Отсюда две вещи сразу:
 *  - собеседник решает, МЕЖДУ КАКИМИ нашими сообщениями встанет его. Для
 *    арбитра, читающего расшифровку, это возможность переставить ответ перед
 *    вопросом;
 *  - показанное человеку время — это то, что написал собеседник, а не то,
 *    когда сообщение пришло.
 *
 * Нетранзитивность сравнения тут уже чинили (К-2 прошлого круга, слияние
 * вместо `sort`), но источник остался тот же: часы в руках заинтересованного.
 *
 * ⚠️ ЧТО ЗДЕСЬ НЕ ЧИНИТСЯ И ПОЧЕМУ. Время склада — слово СЕРВЕРА. Оно не
 * подписано никем, и сервер, солгав, подставит сторону. Размен назван в шапке
 * `chatConversation.ts`: у сервера нет своего интереса в споре двоих, а у
 * собеседника он есть всегда.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deriveChatKeypair } from './chatCrypto';
import {
  deriveLinkSigningKeypair, encodeFrame, messageBodyHash, linkSignaturePreimage,
  sendMessage, receiveBags, forgetConversationHead, _resetParseCacheForTest,
  type IncomingBag,
} from './chatConversation';
import { packEnvelope } from './chatEnvelope';
import { buildLink, type ChainLink } from './chatChain';
import type { ChatSession } from './chatSession';

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

/** Мешок с ПРОИЗВОЛЬНЫМ временем отправки и отдельно заданным временем
 *  загрузки: ровно то разделение, которое и проверяется. */
async function bagFrom(
  from: ChatSession, sender: `0x${string}`, recipientPub: Uint8Array,
  text: string, claimedSentAt: number, uploadedAt: number, prev: ChainLink | null,
): Promise<{ bag: IncomingBag; link: ChainLink }> {
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  const signer = await deriveLinkSigningKeypair(from.keypair);
  const lc = sender.toLowerCase() as `0x${string}`;
  const envelope = await packEnvelope({ text }, recipientPub, from.keypair.publicKey, lc);
  const link = buildLink(prev, messageBodyHash(signer.publicKey, envelope), lc, claimedSentAt);
  const signature = sodium.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey);
  const body = encodeFrame({ link, signature, signerPublicKey: signer.publicKey, envelope });
  return {
    bag: { key: `${ALICE.toLowerCase()}/${uploadedAt}-b.bin`, sender: lc, uploadedAt, body },
    link,
  };
}

function installPutStub(): void {
  let n = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      n++;
      return new Response(JSON.stringify({ key: `${BOB.toLowerCase()}/${2000 + n}-k.bin` }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }));
}

beforeEach(() => { installPutStub(); _resetParseCacheForTest(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('В-2: часы отправителя не решают порядок', () => {
  it('ЗАМЕР: собеседник ставит время в прошлое — его ответ НЕ уезжает перед нашим вопросом', async () => {
    // Что красит: возврат слияния по `sentAt`. Тогда ответ Боба, помеченный
    // единицей, встаёт ПЕРЕД вопросом Алисы, хотя склад принял его позже.
    const alice = await makeSession(ALICE, '1c3d');
    const bob = await makeSession(BOB, '7f2e');
    await forgetConversationHead(ALICE, BOB);

    // Алиса спрашивает — её собственные часы, 10 000.
    const question = await sendMessage(
      alice, BOB, bob.keypair.publicKey, { text: 'ты сделал работу?' }, null,
      { pass: 'v1.p', now: () => 10_000 },
    );
    // Боб отвечает ПОЗЖЕ (склад принял в 20 000), но пишет на звене единицу.
    const { bag } = await bagFrom(bob, BOB, alice.keypair.publicKey, 'да, ещё вчера', 1, 20_000, null);

    const state = await receiveBags(alice, [bag], {
      peer: BOB, own: [question], deliveredKeys: [],
    });

    const order = state.messages.map(m => m.payload.text);
    console.info(
      `[В-2 замер] Боб пишет sentAt=1, склад принял в 20000; порядок на экране: ${order.join(' → ')}`,
    );
    expect(order).toEqual(['ты сделал работу?', 'да, ещё вчера']);
  }, 60_000);

  it('ЗАМЕР: показанное время — засвидетельствованное складом, написанное сохранено отдельно', async () => {
    // Что красит: убрать `receivedAt` (или подставить в него `sentAt`). Тогда
    // на экране стоит время, которое назначил собеседник.
    const alice = await makeSession(ALICE, '1c3d');
    const bob = await makeSession(BOB, '7f2e');
    const far = 4_000_000_000_000; // 2096 год
    const { bag } = await bagFrom(bob, BOB, alice.keypair.publicKey, 'из будущего', far, 20_000, null);

    const state = await receiveBags(alice, [bag], { peer: BOB });
    const m = state.messages[0];
    console.info(
      `[В-2 замер] написано отправителем: ${m.sentAt}; засвидетельствовано складом: ${m.receivedAt}`,
    );
    // Показываем и упорядочиваем по свидетельству склада…
    expect(m.receivedAt).toBe(20_000);
    // …а утверждение отправителя не теряем: оно подписано и нужно арбитру.
    expect(m.sentAt).toBe(far);
  }, 60_000);

  it('ЗАМЕР: своё только что отправленное — по своим часам, склад его ещё не видел', async () => {
    // Граница правки: у своего сообщения, живущего пока только в памяти
    // вкладки, свидетельства склада НЕТ. Подставить сюда ноль значило бы
    // отправить собственное сообщение в начало переписки.
    const alice = await makeSession(ALICE, '1c3d');
    const bob = await makeSession(BOB, '7f2e');
    await forgetConversationHead(ALICE, BOB);
    const mine = await sendMessage(
      alice, BOB, bob.keypair.publicKey, { text: 'только что' }, null,
      { pass: 'v1.p', now: () => 30_000 },
    );
    const state = await receiveBags(alice, [], { peer: BOB, own: [mine] });
    expect(state.messages[0].receivedAt).toBe(30_000);
  }, 60_000);

  it('ЗАМЕР: свой мешок, доехавший СО СКЛАДА, берёт время склада, а не памяти', async () => {
    // Своя половина переписки приезжает двумя путями (память вкладки и склад).
    // Побеждает экземпляр из памяти — там известно `delivered`. Свидетельство
    // склада при этом теряться не должно: после перезагрузки вкладки память
    // пуста, и порядок обязан остаться тем же.
    const alice = await makeSession(ALICE, '1c3d');
    const bob = await makeSession(BOB, '7f2e');
    await forgetConversationHead(ALICE, BOB);
    const mine = await sendMessage(
      alice, BOB, bob.keypair.publicKey, { text: 'своё' }, null,
      { pass: 'v1.p', now: () => 30_000 },
    );
    const own: IncomingBag = {
      key: `${BOB.toLowerCase()}/50000-a.bin`,
      sender: ALICE.toLowerCase() as `0x${string}`,
      uploadedAt: 50_000, body: mine.frame,
    };
    const state = await receiveBags(alice, [own], { peer: BOB, own: [mine] });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].receivedAt).toBe(50_000);
  }, 60_000);
});
