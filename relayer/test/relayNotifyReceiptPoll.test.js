import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import webpush from 'web-push';
import { app, waitForReceipt, RECEIPT_POLL } from '../app.js';
import { mockContract, mockProviderReceipt, providerMocks } from './mocks/ethersRegistry.js';
import { signMessage } from './helpers/signing.js';

/**
 * /relay/notify used to read the receipt EXACTLY ONCE:
 *
 *   const receipt = await provider.getTransactionReceipt(txHash);
 *   if (receipt) await pushAfterRelay(receipt, agreement, calldata);
 *
 * No `else`, no log, no retry. `null` is not an exception, so the surrounding
 * catch never fired either — the deal-lifecycle OS push simply did not happen
 * and nothing anywhere recorded that it had not happened.
 *
 * And `null` is the NORMAL case, not a freak one. The caller
 * (frontend/src/app/api/relay/route.ts) has already waited for this very
 * receipt on ITS RPC connection before calling us; we then ask OURS, which is a
 * different URL — and, behind a load balancer like drpc.live, a different node
 * on every call. The frontend can be a block or three ahead of whatever replica
 * answers the relayer. Measured lag on this stack: 2–6 s.
 *
 * These tests pin the two halves of the fix:
 *   1. an empty answer is RETRIED, not accepted as final;
 *   2. running out of attempts WRITES A LINE naming the txHash.
 */

const ZERO = '0x0000000000000000000000000000000000000000';
const PUSH_SECRET = 'test-push-secret';

async function subscribePush(wallet, endpoint) {
  const address = (await wallet.getAddress()).toLowerCase();
  const sig = await signMessage(wallet, `hexseal:push-subscribe:${address}:${endpoint}`);
  const res = await request(app).post('/push/subscribe').send({
    address,
    subscription: { endpoint, keys: { p256dh: 'test-p256dh', auth: 'test-auth' } },
    sig,
  });
  expect(res.status).toBe(200);
  return address;
}

/** A client/executor pair with live push subscriptions and a mocked agreement. */
async function makePair() {
  const clientWallet = ethers.Wallet.createRandom();
  const executorWallet = ethers.Wallet.createRandom();
  const agreement = ethers.Wallet.createRandom().address;

  const client = await subscribePush(
    clientWallet,
    `https://fcm.googleapis.com/fcm/send/${clientWallet.address}`,
  );
  const executor = await subscribePush(
    executorWallet,
    `https://fcm.googleapis.com/fcm/send/${executorWallet.address}`,
  );

  mockContract(agreement, {
    getDetails: async () => ({ client_: client, executor_: executor, arbiter_: ZERO }),
  });

  return { client, executor, agreement };
}

const respondedIface = new ethers.Interface([
  'event DisputeResponded(address indexed party)',
]);

/** Any log that provably makes pushAfterRelay send something. */
function respondedLog(address, party) {
  const { data, topics } = respondedIface.encodeEventLog('DisputeResponded', [party]);
  return { address, data, topics };
}

// ─── The ceiling itself ───────────────────────────────────────────────────────
//
// Asserted on the module defaults BEFORE any test shrinks them, so a future
// "let's make this snappier" edit that drops the window below the replica lag we
// actually measured fails here instead of silently going back to dropping
// pushes.

describe('RECEIPT_POLL — the window has to outlast the lag it exists for', () => {
  it('covers at least 10 s, i.e. comfortably past the measured 2–6 s replica lag', () => {
    const windowMs = (RECEIPT_POLL.attempts - 1) * RECEIPT_POLL.stepMs;
    expect(windowMs).toBeGreaterThanOrEqual(10_000);
  });

  it('steps in well under one Base Sepolia block (2 s), so a caught-up replica is noticed at once', () => {
    expect(RECEIPT_POLL.stepMs).toBeLessThanOrEqual(1_000);
  });

  it('spends its window on tens of calls, not hundreds', () => {
    expect(RECEIPT_POLL.attempts).toBeLessThanOrEqual(50);
  });
});

// ─── The retry ────────────────────────────────────────────────────────────────

describe('waitForReceipt', () => {
  const defaults = { ...RECEIPT_POLL };

  beforeEach(() => {
    // Real production step is 500 ms; exhausting 24 of those would put eleven
    // seconds of wall clock into the suite for no extra coverage. The attempt
    // COUNT is left untouched — that is the part under test.
    RECEIPT_POLL.stepMs = 1;
  });
  afterEach(() => {
    Object.assign(RECEIPT_POLL, defaults);
  });

  it('retries an empty answer instead of giving up on the first one', async () => {
    const receipt = { logs: [] };
    let calls = 0;
    mockProviderReceipt(async () => (++calls < 3 ? null : receipt));

    await expect(waitForReceipt('0x' + 'ab'.repeat(32))).resolves.toBe(receipt);
    expect(calls).toBe(3);
  });

  it('does not sleep at all when the replica already has the block', async () => {
    const receipt = { logs: [] };
    let calls = 0;
    mockProviderReceipt(async () => { calls++; return receipt; });

    const started = Date.now();
    await expect(waitForReceipt('0x' + 'cd'.repeat(32))).resolves.toBe(receipt);
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('spends every attempt before returning null', async () => {
    let calls = 0;
    mockProviderReceipt(async () => { calls++; return null; });

    await expect(waitForReceipt('0x' + 'ef'.repeat(32))).resolves.toBeNull();
    expect(calls).toBe(RECEIPT_POLL.attempts);
  });
});

// ─── End to end, through the endpoint that actually drops or sends the push ───

describe('POST /relay/notify — a lagging replica no longer eats the notification', () => {
  const defaults = { ...RECEIPT_POLL };

  beforeEach(() => {
    RECEIPT_POLL.stepMs = 1;
    webpush.sendNotification.mockClear();
  });
  afterEach(() => {
    Object.assign(RECEIPT_POLL, defaults);
  });

  it('the push still goes out when the receipt only shows up on a later read', async () => {
    const { client, executor, agreement } = await makePair();

    // Two empty answers — the replica is a block or two behind — then the block
    // lands. The old single-shot read stopped at the first `null` and the
    // executor was never told anything.
    let calls = 0;
    mockProviderReceipt(async () =>
      ++calls < 3 ? null : { logs: [respondedLog(agreement, client)] },
    );

    const res = await request(app)
      .post('/relay/notify')
      .set('X-Push-Secret', PUSH_SECRET)
      .send({ txHash: '0x' + '77'.repeat(32), agreement, calldata: '0xdeadbeef' });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(webpush.sendNotification).toHaveBeenCalledTimes(1));
    const [subscription] = webpush.sendNotification.mock.calls[0];
    expect(subscription.endpoint.toLowerCase()).toContain(executor);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('writes a line naming the txHash when the attempts run out', async () => {
    const { agreement } = await makePair();
    const txHash = '0x' + '88'.repeat(32);

    mockProviderReceipt(async () => null);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await request(app)
        .post('/relay/notify')
        .set('X-Push-Secret', PUSH_SECRET)
        .send({ txHash, agreement, calldata: '0xdeadbeef' });
      expect(res.status).toBe(200);

      // The whole point: this path is no longer allowed to be silent.
      await vi.waitFor(() => expect(errSpy).toHaveBeenCalled());

      const line = errSpy.mock.calls.map(c => c.join(' ')).join('\n');
      // The hash has to be IN the message — a bare "push failed" is not
      // actionable; with the hash the tx can be pulled up on the explorer and
      // the missing notifications reconstructed.
      expect(line).toContain(txHash);
      expect(line).toContain(agreement);

      expect(webpush.sendNotification).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('a receipt available on the very first read costs exactly one RPC call', async () => {
    const { client, agreement } = await makePair();

    let calls = 0;
    mockProviderReceipt(async () => {
      calls++;
      return { logs: [respondedLog(agreement, client)] };
    });

    const res = await request(app)
      .post('/relay/notify')
      .set('X-Push-Secret', PUSH_SECRET)
      .send({ txHash: '0x' + '99'.repeat(32), agreement, calldata: '0xdeadbeef' });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(webpush.sendNotification).toHaveBeenCalledTimes(1));
    expect(calls).toBe(1);
    expect(providerMocks.getTransactionReceipt).toBeTypeOf('function');
  });
});
