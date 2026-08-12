/**
 * presentationAttestationGate.test.ts — заверение предъявителя: клиент цепи
 * доходит до проверки, а «заверения нет» контейнер наружу не выпускает.
 *
 * ЗАЧЕМ. Родов кошельков на Base ЧЕТЫРЕ, и два из них — Safe и развёрнутый умный
 * кошелёк — проверяются только вызовом `isValidSignature` по цепи (исправление 5).
 * Не пробросить клиент цепи значит: заверение такого хозяина негодно ВСЕГДА, и
 * предъявить переписку арбитру он не может вовсе. Поэтому мерится УПОТРЕБЛЕНИЕ
 * второго аргумента, а не его наличие в строке: подмена возвращает `ok` только
 * тогда, когда клиент до неё дошёл.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWalletClient, http, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

declare global {
  // eslint-disable-next-line no-var
  var __attSawClient: boolean[] | undefined;
  // eslint-disable-next-line no-var
  var __attVerdict: string | undefined;
}

/** Подмена стоит на месте Задачи 1: настоящая проверка ERC-1271 требует цепи, а
 *  предмет замера — дошёл ли клиент цепи до неё. `signChatKeyAttestation` остаётся
 *  настоящей (`...real`): подписывает по-настоящему локальный аккаунт viem. */
vi.mock('./chatKeyAttestation', async (importOriginal) => {
  const real = await importOriginal<typeof import('./chatKeyAttestation')>();
  return {
    ...real,
    verifyChatKeyAttestation: async (_att: unknown, publicClient?: unknown) => {
      globalThis.__attSawClient = [...(globalThis.__attSawClient ?? []), publicClient !== undefined];
      if (globalThis.__attVerdict) return globalThis.__attVerdict;
      // ⚠️ `wrong_address`, а не `malformed`: по коду Задачи 1
      // (`chatKeyAttestation.ts:441-455`) владелец Safe с 65-байтовой подписью без
      // клиента цепи получает именно его. Прежнее `malformed` было удобной
      // выдумкой и уводило имя отказа не туда.
      return publicClient === undefined ? 'wrong_address' : 'ok';
    },
  };
});

import { deriveChatKeypair } from './chatCrypto';
import { packEnvelope } from './chatEnvelope';
import {
  archiveConversationFrames, deriveLinkSigningKeypair, encodeFrame,
  messageBodyHash, linkSignaturePreimage,
  _resetConversationMemoryForTest, _resetParseCacheForTest,
} from './chatConversation';
import { buildLink } from './chatChain';
import { signChatKeyAttestation, type ChatKeyAttestation } from './chatKeyAttestation';
import { buildPresentation, toArbiterBoxKeyBytes, toPeerBoxKeyBytes } from './presentation';
import type { ChatSession } from './chatSession';
import { installFakeChatDisk, type FakeChatDisk } from './__stand__/fakeChatDisk';

const ALICE_PK = ('0x' + '11'.repeat(32)) as `0x${string}`;
const BOB_PK = ('0x' + '22'.repeat(32)) as `0x${string}`;
const ALICE = privateKeyToAccount(ALICE_PK).address;
const BOB = privateKeyToAccount(BOB_PK).address;
const DEAL = '0xdeadDEAD00000000000000000000000000c0ffee' as `0x${string}`;

function sig(fill: string): `0x${string}` {
  return ('0x' + fill.repeat(130).slice(0, 130)) as `0x${string}`;
}
async function makeSession(address: `0x${string}`, seed: string): Promise<ChatSession> {
  return {
    keypair: await deriveChatKeypair(sig(seed)),
    address, origin: 'signature', walletKind: 'eoa', restored: true, persisted: true,
  };
}
function walletOf(pk: `0x${string}`): WalletClient {
  return createWalletClient({
    account: privateKeyToAccount(pk), chain: baseSepolia, transport: http('http://127.0.0.1:1'),
  }) as unknown as WalletClient;
}

let disk: FakeChatDisk;
let alice: ChatSession;
let bob: ChatSession;
let arbiter: ChatSession;
let aliceAtt: ChatKeyAttestation;

/** Одно настоящее чужое сообщение в архиве — чтобы годная ветка была годной
 *  по-настоящему, а не «контейнером ни о чём». */
async function oneFrameFromBob(): Promise<void> {
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  const signer = await deriveLinkSigningKeypair(bob.keypair);
  const sender = BOB.toLowerCase() as `0x${string}`;
  const envelope = await packEnvelope({ text: 'чужое-0' }, alice.keypair.publicKey, bob.keypair.publicKey, sender);
  const link = buildLink(null, messageBodyHash(signer.publicKey, envelope), sender, 20_000);
  await archiveConversationFrames(ALICE, BOB, [{
    key: `${ALICE.toLowerCase()}/20000-att.bin`,
    from: sender,
    seq: 0,                                   // ⚠️ как пишет движок
    sentAt: 20_000, receivedAt: 20_000,
    frame: encodeFrame({
      link,
      signature: sodium.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey),
      signerPublicKey: signer.publicKey,
      envelope,
    }),
  }]);
}

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  _resetConversationMemoryForTest();
  _resetParseCacheForTest();
  disk = installFakeChatDisk();
  alice = await makeSession(ALICE, '1c3d');
  bob = await makeSession(BOB, '7f2e');
  arbiter = await makeSession('0xA4b1000000000000000000000000000000000001', 'a4b1');
  aliceAtt = await signChatKeyAttestation(walletOf(ALICE_PK), alice);
  globalThis.__attSawClient = [];
  globalThis.__attVerdict = undefined;
});
afterEach(() => {
  disk.restore(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  globalThis.__attSawClient = undefined;
  globalThis.__attVerdict = undefined;
});

/** Клиент цепи, умеющий ровно то, чего требует ERC-1271, и ничего больше. */
const chainClient = (): PublicClient =>
  ({ readContract: async () => '0x1626ba7e' } as unknown as PublicClient);

async function build(over: Partial<Parameters<typeof buildPresentation>[0]> = {}) {
  return buildPresentation({
    dealId: DEAL, presenter: ALICE, peer: BOB.toLowerCase() as `0x${string}`,
    arbiterBoxKey: toArbiterBoxKeyBytes(arbiter.keypair.publicKey),
    peerBoxKey: toPeerBoxKeyBytes(bob.keypair.publicKey),
    selected: [{ seq: 0, sender: BOB }],
    session: alice, ownAttestation: aliceAtt,
    now: () => 1_754_500_000_000,
    ...over,
  });
}

describe('4в-5: заверение предъявителя (§15.2, исправление 5)', () => {
  it('ЗАМЕР: клиент цепи доходит до проверки — иначе владелец Safe не предъявит ничего', async () => {
    // Что красит: потерянный второй аргумент. Тогда `sawClient` — `false`, вердикт
    // `wrong_address`, и сборщик отказывает `attestation_unproven` — «подтвердить
    // не смогли», что для владельца Safe и есть правда. Прежде здесь стояло
    // `no_session`, и человек лечил сеанс вместо сети (пункт 49).
    await oneFrameFromBob();

    const withChain = await build({ publicClient: chainClient() });
    expect(withChain.ok).toBe(true);
    if (!withChain.ok) return;
    expect(withChain.container.frames).toHaveLength(1);
    expect(globalThis.__attSawClient).toEqual([true]);
    console.info(
      `[4в-5 замер] проверок заверения ${globalThis.__attSawClient!.length}, ` +
      `из них с клиентом цепи ${globalThis.__attSawClient!.filter(Boolean).length}`,
    );

    // Без клиента цепи — честный отказ, а не молчаливо собранный контейнер.
    globalThis.__attSawClient = [];
    expect(await build()).toEqual({ ok: false, reason: 'attestation_unproven' });
    expect(globalThis.__attSawClient).toEqual([false]);
  }, 60_000);

  it('заверения нет вовсе (absent) — отказ, а не контейнер, который ничего не доказывает', async () => {
    // `absent` — отдельный вердикт, и он НЕ то же, что мусор: счётный кошелёк без
    // кода на цепи проверить нечем ничем, и это надо назвать, а не молчать.
    // Что красит: «принимать всё, кроме bad_signature» — тогда наружу уедет
    // предъявление, подписанное ключом, не связанным с адресом ничем (§15.2), а
    // человек увидит «сдано».
    // ⚠️ И имя у этого отказа СВОЁ (пункт 49): счётный кошелёк проверить нечем, и
    // это НЕ «нет сеанса чата». Лечение — подключить сеть / развернуть кошелёк;
    // переподпись не поможет, а прежнее `no_session` гнало человека именно туда.
    await oneFrameFromBob();
    globalThis.__attVerdict = 'absent';
    expect(await build({ publicClient: chainClient() }))
      .toEqual({ ok: false, reason: 'attestation_unproven' });
  }, 60_000);
});
