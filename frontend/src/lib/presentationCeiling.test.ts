/**
 * presentationCeiling.test.ts — отказ по потолку 256 КиБ ДО криптоработы.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ЗАМОК, А НЕ ПРОВЕРКА «ОТКАЗАЛ ЛИ». Отказ по размеру можно
 * получить и в конце — уже перешифровав всё и запечатав ключи. Снаружи это
 * выглядит одинаково, а стоит по-разному: у человека посреди спора это секунды
 * работы телефона впустую, а в замысле требование звучит дословно — «отказ по
 * потолку ДО криптоработы». Поэтому мерится НЕ отказ, а ЧИСЛО ПЕЧАТЕЙ: ноль.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWalletClient, http, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

/** Счётчик печатей живёт в `globalThis` НАМЕРЕННО: `vi.mock` поднимается наверх
 *  файла, и обычная переменная модуля в него не видна. */
declare global {
  // eslint-disable-next-line no-var
  var __sealCalls: number | undefined;
}
vi.mock('./chatCrypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('./chatCrypto')>();
  return {
    ...real,
    sealForRecipient: async (pub: Uint8Array, plain: Uint8Array) => {
      globalThis.__sealCalls = (globalThis.__sealCalls ?? 0) + 1;
      return real.sealForRecipient(pub, plain);
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
import { buildLink, type ChainLink } from './chatChain';
import { signChatKeyAttestation, type ChatKeyAttestation } from './chatKeyAttestation';
import {
  buildPresentation, PRESENTATION_MAX_BYTES, PRESENTATION_SEAL_OVERHEAD,
  toArbiterBoxKeyBytes, toPeerBoxKeyBytes,
} from './presentation';
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

/** Пять крупных чужих сообщений: каждое около 80 КБ в base64, все пять втрое
 *  больше потолка мешка. Ровно тот случай, ради которого потолок и есть. */
async function fiveBigOnes(): Promise<void> {
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  const signer = await deriveLinkSigningKeypair(bob.keypair);
  const sender = BOB.toLowerCase() as `0x${string}`;
  let prev: ChainLink | null = null;
  const rows = [];
  for (let i = 0; i < 5; i++) {
    const envelope = await packEnvelope(
      { text: 'т'.repeat(30_000) }, alice.keypair.publicKey, bob.keypair.publicKey, sender,
    );
    const link = buildLink(prev, messageBodyHash(signer.publicKey, envelope), sender, 20_000 + i);
    prev = link;
    rows.push({
      key: `${ALICE.toLowerCase()}/${20_000 + i}-big.bin`,
      from: sender,
      seq: 0,                                  // ⚠️ как пишет движок
      sentAt: 20_000 + i, receivedAt: 20_000 + i,
      frame: encodeFrame({
        link,
        signature: sodium.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey),
        signerPublicKey: signer.publicKey,
        envelope,
      }),
    });
  }
  await archiveConversationFrames(ALICE, BOB, rows);
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
});
afterEach(() => { disk.restore(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const pick = (n: number) => Array.from({ length: n }, (_, i) => ({ seq: i, sender: BOB }));

async function build(selected: { seq: number; sender: `0x${string}` }[]) {
  return buildPresentation({
    dealId: DEAL, presenter: ALICE,
    arbiterBoxKey: toArbiterBoxKeyBytes(arbiter.keypair.publicKey),
    peerBoxKey: toPeerBoxKeyBytes(bob.keypair.publicKey),
    selected, session: alice, ownAttestation: aliceAtt,
    peer: BOB.toLowerCase() as `0x${string}`,
    now: () => 1_754_500_000_000,
  });
}

describe('4в-5: потолок 256 КиБ', () => {
  it('ЗАМЕР: отказ до криптоработы — ноль печатей, и названному числу можно верить', async () => {
    // Что красит: перенос проверки после крипто-цикла (печати становятся не
    // нулём) и снятие проверки вовсе (отказа нет вообще).
    await fiveBigOnes();
    // ⚠️ ОЖИДАЕМОЕ ЧИСЛО ЗАПИСАНО РУКАМИ (исправление 12 договора). Прежний
    // черновик писал `const limit = PRESENTATION_MAX_BYTES - PRESENTATION_SEAL_OVERHEAD`
    // и сравнивал с ним же отказ — тождество по построению: подмени боевой потолок
    // на 64 КиБ, и замер остался бы зелёным, ничего не заметив. Теперь боевые
    // константы сверяются с числами отдельными строками, а из модуля берётся
    // только измеряемое.
    const LIMIT = 262_096;                       // 262144 − 48, посчитано здесь и руками
    expect(PRESENTATION_MAX_BYTES).toBe(262_144);
    expect(PRESENTATION_SEAL_OVERHEAD).toBe(48);

    globalThis.__sealCalls = 0;      // сборка тестовых конвертов тоже печатала
    const refused = await build(pick(5));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // ⚠️ ДОРАБОТКА РЕВЬЮ: `PresentationRefusal` — размеченный союз (не плоский
    // интерфейс с необязательными полями). Сужение по `reason` ниже — не
    // формальность: без него `fits`/`estimatedBytes`/`limitBytes` типизированы
    // как `number | undefined` (второй член союза их не несёт вовсе), и
    // компилятор потребовал бы восклицательный знак на каждом обращении. ПОСЛЕ
    // сужения `refused.fits` — уже `number`, без `!` (строка ниже раньше была
    // `refused.fits!`).
    if (refused.reason !== 'too_large') return;
    expect(refused.reason).toBe('too_large');
    expect(refused.limitBytes).toBe(LIMIT);
    expect(refused.estimatedBytes).toBeGreaterThan(LIMIT);
    expect(refused.fits).toBeGreaterThanOrEqual(1);
    expect(refused.fits).toBeLessThan(5);
    // ГЛАВНОЕ ЧИСЛО ЭТОГО ЗАМКА.
    expect(globalThis.__sealCalls).toBe(0);
    console.info(
      `[4в-5 замер] выбрано 5 крупных, оценка ${refused.estimatedBytes} Б при потолке ${LIMIT} Б; ` +
      `влезает ${refused.fits}; печатей сделано ${globalThis.__sealCalls}`,
    );

    // Названному числу можно верить: ровно столько собирается и влезает…
    // `fits` — уже `number` после сужения выше, никакого `!`.
    const fits = refused.fits;
    globalThis.__sealCalls = 0;
    const ok = await build(pick(fits));
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.container.frames).toHaveLength(fits);
    const real = new TextEncoder().encode(JSON.stringify(ok.container)).length;
    expect(real).toBeLessThanOrEqual(LIMIT);
    expect(globalThis.__sealCalls).toBe(fits * 2);   // на двоих, по §15.6

    // …а на одно больше — снова отказ, и снова без единой печати.
    globalThis.__sealCalls = 0;
    const again = await build(pick(fits + 1));
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe('too_large');
    expect(globalThis.__sealCalls).toBe(0);
  }, 120_000);
});
