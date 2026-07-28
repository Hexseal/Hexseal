import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import webpush from 'web-push';
import { app, findDisputeSplit, disputeSplitPushMsg, usdcExact } from '../app.js';
import { mockContract, mockProviderReceipt } from './mocks/ethersRegistry.js';
import { signMessage } from './helpers/signing.js';

/**
 * A dispute nobody claimed pays half the escrow to the executor and reaches the
 * Registry as REFUNDED(2) — the same status a real refund gets, because the enum
 * mirrors the agreement's frozen `enum Status` and cannot grow. Before this, the
 * OS push for status 2 told that executor "the deal was cancelled and refunded",
 * and unlike a toast, a push sits in the tray until it is dismissed.
 *
 * What tells the two apart is the agreement's own DisputeSplitNoVerdict event,
 * present in the SAME receipt the status event came from.
 */

const AGREEMENT = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const SOMEONE_ELSE = '0xbBbBBBBbbBBBbbbBbbBbbbbbBBbBbbbbBbBbbBBb';

const splitIface = new ethers.Interface([
  'event DisputeSplitNoVerdict(uint256 toClient, uint256 toExecutor)',
]);

/** A log shaped like the one an Agreement really emits. */
function splitLog(address, toClient, toExecutor) {
  const { data, topics } = splitIface.encodeEventLog('DisputeSplitNoVerdict', [
    toClient,
    toExecutor,
  ]);
  return { address, data, topics };
}

const unrelatedLog = {
  address: AGREEMENT,
  topics: [ethers.id('Transfer(address,address,uint256)')],
  data: '0x',
};

describe('usdcExact', () => {
  it('never shows fewer than two decimals', () => {
    expect(usdcExact(200_000_000n)).toBe('200.00');
    expect(usdcExact(0n)).toBe('0.00');
  });

  it('never rounds — the number has to match what the contract paid', () => {
    // An odd pot of 33 units splits 16 / 17; .toFixed(2) would print both as 0.00.
    expect(usdcExact(16n)).toBe('0.000016');
    expect(usdcExact(17n)).toBe('0.000017');
    expect(usdcExact(25_000_001n)).toBe('25.000001');
  });
});

describe('findDisputeSplit', () => {
  it('finds the split and both amounts in the receipt', () => {
    const logs = [unrelatedLog, splitLog(AGREEMENT, 100_000_001n, 100_000_000n)];
    expect(findDisputeSplit(logs, AGREEMENT)).toEqual({
      toClient: 100_000_001n,
      toExecutor: 100_000_000n,
    });
  });

  it('matches the agreement address case-insensitively', () => {
    const logs = [splitLog(AGREEMENT.toLowerCase(), 17n, 16n)];
    expect(findDisputeSplit(logs, AGREEMENT.toUpperCase().replace('0X', '0x'))).toEqual({
      toClient: 17n,
      toExecutor: 16n,
    });
  });

  it('ignores a split emitted by a different agreement in the same tx', () => {
    const logs = [splitLog(SOMEONE_ELSE, 17n, 16n)];
    expect(findDisputeSplit(logs, AGREEMENT)).toBeNull();
  });

  it('returns null for a genuine refund — no such event is emitted', () => {
    expect(findDisputeSplit([unrelatedLog], AGREEMENT)).toBeNull();
    expect(findDisputeSplit([], AGREEMENT)).toBeNull();
    expect(findDisputeSplit(undefined, AGREEMENT)).toBeNull();
  });
});

describe('disputeSplitPushMsg', () => {
  it('names both amounts rather than saying "half", and goes to both parties', () => {
    const msg = disputeSplitPushMsg({ toClient: 17n, toExecutor: 16n });
    expect(msg.notify).toBe('both');
    expect(msg.body).toContain('0.000016 USDC to the executor');
    expect(msg.body).toContain('0.000017 USDC to the client');
    expect(msg.body).not.toMatch(/refund/i);
    expect(msg.body).not.toMatch(/cancel/i);
  });

  it('reports the executor half as zero when USDC would not take it', () => {
    // Agreement falls the undeliverable half back to the client rather than
    // freezing the whole pot; the event carries what was actually moved.
    const msg = disputeSplitPushMsg({ toClient: 200_000_000n, toExecutor: 0n });
    expect(msg.body).toContain('0.00 USDC to the executor');
    expect(msg.body).toContain('200.00 USDC to the client');
  });
});

// ─── End to end, through the endpoint that actually sends the pushes ──────────

const ZERO = '0x0000000000000000000000000000000000000000';
const DIAMOND = process.env.DIAMOND_ADDRESS;

const statusIface = new ethers.Interface([
  'event AgreementStatusUpdated(address indexed agreement, uint8 newStatus)',
]);

/** The Diamond's own status log, emitted from inside Agreement._complete(). */
function statusLog(agreement, newStatus) {
  const { data, topics } = statusIface.encodeEventLog('AgreementStatusUpdated', [
    agreement,
    newStatus,
  ]);
  return { address: DIAMOND, data, topics };
}

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

/** Sets up a settled dispute timeout and returns the two bodies that were pushed. */
async function pushedBodiesFor({ withSplitLog }) {
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

  // Nobody claimed the dispute, so `arbiter` never left zero.
  mockContract(agreement, {
    getDetails: async () => ({
      client_: client,
      executor_: executor,
      arbiter_: ZERO,
    }),
  });

  mockProviderReceipt({
    logs: withSplitLog
      ? [statusLog(agreement, 2), splitLog(agreement, 100_000_001n, 100_000_000n)]
      : [statusLog(agreement, 2)],
  });

  webpush.sendNotification.mockClear();

  const res = await request(app)
    .post('/relay/notify')
    .set('X-Push-Secret', 'test-push-secret')
    .send({ txHash: '0x' + '11'.repeat(32), agreement, calldata: '0xdeadbeef' });
  expect(res.status).toBe(200);

  // The endpoint acks first and fans the pushes out in the background.
  await vi.waitFor(() => expect(webpush.sendNotification).toHaveBeenCalledTimes(2));

  return webpush.sendNotification.mock.calls.map(([, payload]) => JSON.parse(payload));
}

describe('POST /relay/notify — REFUNDED(2) is two different outcomes', () => {
  beforeEach(() => {
    webpush.sendNotification.mockClear();
  });

  it('a split tells both sides what each of them got, and never says "refunded"', async () => {
    const payloads = await pushedBodiesFor({ withSplitLog: true });
    for (const payload of payloads) {
      expect(payload.title).toBe('Escrow Split');
      expect(payload.body).toContain('100.00 USDC to the executor');
      expect(payload.body).toContain('100.000001 USDC to the client');
      expect(payload.body).not.toMatch(/refund/i);
      expect(payload.body).not.toMatch(/cancel/i);
    }
  });

  it('a genuine refund on the same status still reads as a refund', async () => {
    const payloads = await pushedBodiesFor({ withSplitLog: false });
    for (const payload of payloads) {
      expect(payload.title).toBe('Deal Refunded');
      expect(payload.body).toBe('The deal was cancelled and refunded.');
    }
  });
});

// ─── The same scoping, one line up ────────────────────────────────────────────
//
// findDisputeSplit() is address-scoped; the AgreementStatusUpdated loop it feeds
// was not. Everything that loop produces — the two recipients, the /deal/ URL, the
// copy — is derived from the agreement the relayed call targeted, so a status
// event about a DIFFERENT agreement would describe a stranger's deal to our two
// parties, and (as here) suppress the push they should have got.
//
// Not reachable today: MinimalForwarder.execute() makes a single inner call, so
// one receipt carries at most one agreement's status event. That is a property of
// the caller, though, not of this loop.
describe('POST /relay/notify — the status loop is scoped to the relayed agreement', () => {
  beforeEach(() => {
    webpush.sendNotification.mockClear();
  });

  it("ignores another agreement's status event and still reads our own calldata", async () => {
    const clientWallet = ethers.Wallet.createRandom();
    const executorWallet = ethers.Wallet.createRandom();
    const agreement = ethers.Wallet.createRandom().address;
    const stranger = ethers.Wallet.createRandom().address;

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

    // Our deal was just funded (no status event of its own — fund() doesn't emit
    // one, which is why FUNC_PUSH_MSG exists). The stranger's REFUNDED(2) rides
    // along in the same receipt.
    mockProviderReceipt({ logs: [statusLog(stranger, 2)] });

    webpush.sendNotification.mockClear();

    const res = await request(app)
      .post('/relay/notify')
      .set('X-Push-Secret', 'test-push-secret')
      .send({ txHash: '0x' + '22'.repeat(32), agreement, calldata: '0xb60d4288' }); // fund()
    expect(res.status).toBe(200);

    // fund() notifies the executor only — one push, not the two a REFUNDED status
    // would have sent, and not the refund copy.
    await vi.waitFor(() => expect(webpush.sendNotification).toHaveBeenCalledTimes(1));
    const [subscription, payload] = webpush.sendNotification.mock.calls[0];
    expect(subscription.endpoint).toContain(executorWallet.address);
    expect(JSON.parse(payload).title).toBe('Deal Funded');
  });
});
