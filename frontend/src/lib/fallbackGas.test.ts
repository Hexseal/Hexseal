/**
 * fallbackGas.test.ts — газ на ЗАПАСНОМ пути «релеер лежит».
 *
 * ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ СОСЕДНЕГО ЗАМКА. `claimGasCeiling.test.ts` читает
 * ТЕКСТ `relay.ts` регуляркой: он сторожит строку `claimDispute: 260_000n` в
 * таблице и ничего не знает о том, доезжает ли это число до какого-нибудь
 * вызова. Замерено: если выкинуть отсечку из боевого пути целиком, он
 * остаётся ЗЕЛЁНЫМ (мутация E задачи 8).
 *
 * Здесь замеряется УПОТРЕБЛЕНИЕ: обе функции зовутся целиком, релеер уронен
 * настоящим отказом `Failed to fetch` (ровно тем, который ловит
 * `isRelayDown`), и проверяется поле `gas` того объекта, который ушёл в
 * кошелёк. На чистом `main` его там нет вовсе.
 *
 * ⚠️ АДРЕСА КОШЕЛЬКОВ У ТЕСТОВ РАЗНЫЕ, И ЭТО НЕ КОСМЕТИКА. `relay.ts`
 * запоминает израсходованный nonce форвардера (`rememberSpentForwarderNonce`),
 * и второй вызов тем же адресом с тем же прочитанным nonce уходит ждать
 * свежести — 9 проб по 750 мс, шесть секунд без единого красного.
 * Поддельное чтение вдобавок отдаёт РАСТУЩИЙ счётчик: два слоя, потому что
 * забыть один из них — тихая потеря шести секунд на каждый новый тест.
 *
 * ⚠️ Ожидаемые числа записаны В ЭТОМ ФАЙЛЕ РУКАМИ (260 000 / 120 000 /
 * 500 000) и сверяются отдельной строкой — они НЕ импортируются из
 * проверяемого модуля.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { claimDisputeGasless, setArbiterChatKeyGasless, callGasLimit } from './relay';
import { toBoxKey, toSignKey } from './arbiterChatKey';
import { CONTRACTS } from '@/config/contracts';

const BOX  = toBoxKey(('0x' + '11'.repeat(32)) as `0x${string}`);
const SIGN = toSignKey(('0x' + '22'.repeat(32)) as `0x${string}`);
const AGREEMENT = '0x00000000000000000000000000000000000000aa' as `0x${string}`;
const SALT = ('0x' + '33'.repeat(32)) as `0x${string}`;

/** Ожидаемое — руками, не из GAS_DEFAULTS. */
const CLAIM_CEILING   = 260_000n;
const SET_KEY_CEILING = 120_000n;
const DEFAULT_CEILING = 500_000n;

type Call = Record<string, unknown>;

/** Счётчик нонсов растёт — см. шапку про шесть секунд. */
let nonceSeq = 0n;

function stand(who: string, estimate: bigint | 'throw') {
  const sent: Call[] = [];
  const signed: Call[] = [];
  const walletClient = {
    account: { address: who as `0x${string}` },
    chain: { id: 84532 },
    async signTypedData(args: Call) { signed.push(args); return ('0x' + 'ab'.repeat(65)) as `0x${string}`; },
    async sendTransaction(args: Call) { sent.push(args); return ('0x' + 'cd'.repeat(32)) as `0x${string}`; },
    async writeContract(args: Call) { sent.push(args); return ('0x' + 'ef'.repeat(32)) as `0x${string}`; },
  };
  const publicClient = {
    async readContract() { return nonceSeq++; },
    async estimateGas() {
      if (estimate === 'throw') throw new Error('execution reverted');
      return estimate;
    },
    async waitForTransactionReceipt() { return { status: 'success' as const }; },
  };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return { wallet: walletClient as any, node: publicClient as any, sent, signed };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

const realFetch = globalThis.fetch;
/** Ровно тот отказ, который ловит isRelayDown: 'failed to fetch'. */
function relayDown(): void {
  globalThis.fetch = (async () => { throw new Error('Failed to fetch'); }) as typeof fetch;
}
function relayUp(): void {
  globalThis.fetch = (async () => ({
    ok: true, status: 200, json: async () => ({ txHash: '0x' + '99'.repeat(32) }),
  })) as unknown as typeof fetch;
}
beforeEach(() => { globalThis.fetch = realFetch; });
afterAll(() => { globalThis.fetch = realFetch; });

describe('запасной путь «релеер лежит» задаёт газ сам', () => {
  it('T1 заявка на спор: узел оценить не смог — уходит потолок таблицы', async () => {
    const { wallet, node, sent } = stand('0x0000000000000000000000000000000000000001', 'throw');
    relayDown();
    const out = await claimDisputeGasless(wallet, node, AGREEMENT, SALT, BOX, SIGN);
    expect(out.fallbackUsed).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe(CONTRACTS.diamond);
    expect(sent[0].gas).toBe(CLAIM_CEILING);
    expect(CLAIM_CEILING).toBe(260_000n);
  });

  it('T2 заявка на спор: узел оценил — уходит оценка с запасом 30%, а не потолок', async () => {
    const { wallet, node, sent } = stand('0x0000000000000000000000000000000000000002', 100_000n);
    relayDown();
    await claimDisputeGasless(wallet, node, AGREEMENT, SALT, BOX, SIGN);
    expect(sent[0].gas).toBe(130_000n);
  });

  it('T3 публикация ключа: узел оценить не смог — потолок таблицы', async () => {
    const { wallet, node, sent } = stand('0x0000000000000000000000000000000000000003', 'throw');
    relayDown();
    await setArbiterChatKeyGasless(wallet, node, BOX, SIGN);
    expect(sent.length).toBe(1);
    expect(sent[0].gas).toBe(SET_KEY_CEILING);
    expect(SET_KEY_CEILING).toBe(120_000n);
  });

  it('T4 публикация ключа: узел оценил — оценка с запасом 30%', async () => {
    const { wallet, node, sent } = stand('0x0000000000000000000000000000000000000004', 60_000n);
    relayDown();
    await setArbiterChatKeyGasless(wallet, node, BOX, SIGN);
    expect(sent[0].gas).toBe(78_000n);
  });
});

describe('путь через релеер потолок не потерял', () => {
  it('T5 узел молчит — подписанный ForwardRequest несёт 260 000, прямой отправки нет', async () => {
    const { wallet, node, sent, signed } = stand('0x0000000000000000000000000000000000000005', 'throw');
    relayUp();
    await claimDisputeGasless(wallet, node, AGREEMENT, SALT, BOX, SIGN);
    expect(sent.length).toBe(0);
    expect((signed[0] as { message: { gas: bigint } }).message.gas).toBe(CLAIM_CEILING);
  });

  it('T6 узел оценил — подписанный ForwardRequest несёт оценку, а не потолок', async () => {
    const { wallet, node, signed } = stand('0x0000000000000000000000000000000000000006', 100_000n);
    relayUp();
    await claimDisputeGasless(wallet, node, AGREEMENT, SALT, BOX, SIGN);
    expect((signed[0] as { message: { gas: bigint } }).message.gas).toBe(130_000n);
  });
});

describe('умолчание', () => {
  it('T7 имени нет в таблице — общий предел, а не undefined', async () => {
    const { node } = stand('0x0000000000000000000000000000000000000007', 'throw');
    const gas = await callGasLimit(
      node,
      '0x0000000000000000000000000000000000000007' as `0x${string}`,
      CONTRACTS.diamond as `0x${string}`,
      '0xdeadbeef' as `0x${string}`,
      'такойФункцииНет',
    );
    expect(gas).toBe(DEFAULT_CEILING);
    expect(DEFAULT_CEILING).toBe(500_000n);
  });
});
