import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import webpush from 'web-push';
import { app, RECEIPT_POLL } from '../app.js';
import { mockContract, mockProviderReceipt } from './mocks/ethersRegistry.js';
import { signMessage } from './helpers/signing.js';

/**
 * Companion to relayNotifyReceiptPoll.test.js. Polling the receipt only fixed the
 * FIRST place on this path that could get nothing and say nothing; pushAfterRelay
 * had two more, one frame further in, reachable immediately after the polling
 * succeeds.
 *
 *   1. Its outer catch was `catch {}` with a comment claiming it only caught "not
 *      an agreement target (e.g. a board action)". The try wraps everything —
 *      getDetails(), every dispute read, every sendCfg() — so a transient RPC
 *      failure on a REAL agreement was indistinguishable from a board action and
 *      took Deal Complete / Refunded / Dispute Raised / Funded / Activated / Work
 *      Submitted down with it, writing nothing anywhere.
 *
 *   2. `calldata` is optional in /relay/notify's own validation, and the selector
 *      derived from it is the ONLY notification path for fund/activate/markDone —
 *      they emit no AgreementStatusUpdated. Omitting it lost all three, silently.
 *
 * The board action must still stay quiet, or the log becomes noise and stops being
 * read: a board action targets the Diamond itself, so the two are distinguishable.
 */

const ZERO = '0x0000000000000000000000000000000000000000';
const PUSH_SECRET = 'test-push-secret';
// Same value test/setup.js puts in DIAMOND_ADDRESS.
const DIAMOND = '0x2222222222222222222222222222222222222222';

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

/** Drives one /relay/notify request and waits for the background fan-out to settle. */
async function notify(body) {
  const res = await request(app)
    .post('/relay/notify')
    .set('X-Push-Secret', PUSH_SECRET)
    .send(body);
  expect(res.status).toBe(200);
  await new Promise(r => setTimeout(r, 60));
}

describe('pushAfterRelay — a failed lifecycle read is reported, not swallowed', () => {
  const defaults = { ...RECEIPT_POLL };
  let errSpy, warnSpy;

  beforeEach(() => {
    RECEIPT_POLL.stepMs = 1;
    webpush.sendNotification.mockClear();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    Object.assign(RECEIPT_POLL, defaults);
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('names the agreement when getDetails() fails on a real one', async () => {
    const agreement = ethers.Wallet.createRandom().address;
    mockContract(agreement, {
      getDetails: async () => { throw new Error('missing revert data'); },
    });
    mockProviderReceipt({ logs: [] });

    await notify({ txHash: '0x' + 'a1'.repeat(32), agreement, calldata: '0xb60d4288' });

    const line = errSpy.mock.calls.map(c => c.map(String).join(' ')).join('\n');
    expect(line).toContain(agreement);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('stays quiet for a board action — the Diamond has no getDetails() by design', async () => {
    mockContract(DIAMOND, {
      getDetails: async () => { throw new Error('function does not exist'); },
    });
    mockProviderReceipt({ logs: [] });

    await notify({ txHash: '0x' + 'a2'.repeat(32), agreement: DIAMOND, calldata: '0xdeadbeef' });

    // Noise here would be one line per job post / application / service request,
    // which is how a log stops being read at all.
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('says so when calldata is missing — fund/activate/markDone have no other path', async () => {
    const { agreement } = await makePair();
    mockProviderReceipt({ logs: [] });

    // /relay/notify itself only requires txHash + agreement, so this request is
    // accepted; the three pushes that depend on the selector simply cannot be
    // resolved, and that used to be invisible.
    await notify({ txHash: '0x' + 'a3'.repeat(32), agreement });

    const line = warnSpy.mock.calls.map(c => c.map(String).join(' ')).join('\n');
    expect(line).toContain(agreement);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('a known selector still pushes normally — the guard did not break the happy path', async () => {
    const { executor, agreement } = await makePair();
    mockProviderReceipt({ logs: [] });

    // 0xb60d4288 = fund() → "Deal Funded", executor only.
    await notify({ txHash: '0x' + 'a4'.repeat(32), agreement, calldata: '0xb60d4288' });

    await vi.waitFor(() => expect(webpush.sendNotification).toHaveBeenCalledTimes(1));
    const [subscription, payload] = webpush.sendNotification.mock.calls[0];
    expect(subscription.endpoint.toLowerCase()).toContain(executor);
    expect(JSON.parse(payload).title).toBe('Deal Funded');
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe('pushAfterRelay — DisputeResponded from a stranger no longer eats two pushes', () => {
  const defaults = { ...RECEIPT_POLL };
  let errSpy;

  const respondedIface = new ethers.Interface([
    'event DisputeResponded(address indexed party)',
  ]);
  function respondedLog(address, party) {
    const { data, topics } = respondedIface.encodeEventLog('DisputeResponded', [party]);
    return { address, data, topics };
  }

  beforeEach(() => {
    RECEIPT_POLL.stepMs = 1;
    webpush.sendNotification.mockClear();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    Object.assign(RECEIPT_POLL, defaults);
    errSpy.mockRestore();
  });

  it('logs the mismatch and falls through instead of returning empty-handed', async () => {
    const { executor, agreement } = await makePair();
    const stranger = ethers.Wallet.createRandom().address;

    // The event says the responder is somebody this agreement does not report as a
    // party: the log and getDetails() disagree. The old code hit an UNCONDITIONAL
    // `return` here, dropping the "Dispute Answered" push AND short-circuiting the
    // status loop and selector fallback that come after it.
    mockProviderReceipt({ logs: [respondedLog(agreement, stranger)] });

    await notify({ txHash: '0x' + 'b1'.repeat(32), agreement, calldata: '0xb60d4288' });

    const line = errSpy.mock.calls.map(c => c.map(String).join(' ')).join('\n');
    expect(line).toContain(stranger);
    expect(line).toContain(agreement);

    // Fell through to the selector fallback rather than returning: fund() still
    // notifies the executor.
    await vi.waitFor(() => expect(webpush.sendNotification).toHaveBeenCalledTimes(1));
    const [subscription] = webpush.sendNotification.mock.calls[0];
    expect(subscription.endpoint.toLowerCase()).toContain(executor);
  });

  it('a genuine responder is unaffected — still one push, still no log', async () => {
    const { client, executor, agreement } = await makePair();

    mockProviderReceipt({ logs: [respondedLog(agreement, client)] });

    await notify({ txHash: '0x' + 'b2'.repeat(32), agreement, calldata: '0xb60d4288' });

    // Exactly one: the "Dispute Answered" push, and it still returns straight after
    // rather than also firing the fund() fallback.
    await vi.waitFor(() => expect(webpush.sendNotification).toHaveBeenCalledTimes(1));
    const [subscription, payload] = webpush.sendNotification.mock.calls[0];
    expect(subscription.endpoint.toLowerCase()).toContain(executor);
    expect(JSON.parse(payload).title).toBe('Dispute Answered');
    expect(errSpy).not.toHaveBeenCalled();
  });
});
