import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import webpush from 'web-push';
import { app, findDisputeResponded } from '../app.js';
import { mockContract, mockProviderReceipt } from './mocks/ethersRegistry.js';
import { signMessage } from './helpers/signing.js';

/**
 * respondToDispute() does not move the agreement's status in the Registry, so the
 * status-driven AGR_PUSH_MSG table never sees it, and the party who did NOT
 * respond gets no signal that the clock on their own silence is running — it
 * currently costs them a quarter of the escrow with nobody telling them so.
 *
 * The fix reads the agreement's own DisputeResponded event out of the receipt
 * (same trick as DisputeSplitNoVerdict — the Diamond never emits it) and pushes
 * the OTHER party, chosen the same way AppealRaised chooses its recipient.
 */

const AGREEMENT = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
// A random wallet rather than a hand-typed literal: this constant is used both as
// a bare log.address (no validation) AND ABI-encoded as an indexed `address` event
// arg below, which DOES checksum-validate — a hand-typed mixed-case string that
// fails the checksum throws INVALID_ARGUMENT from encodeEventLog.
const SOMEONE_ELSE = ethers.Wallet.createRandom().address;

const respondedIface = new ethers.Interface([
  'event DisputeResponded(address indexed party)',
]);

/** A log shaped like the one an Agreement really emits. */
function respondedLog(address, party) {
  const { data, topics } = respondedIface.encodeEventLog('DisputeResponded', [party]);
  return { address, data, topics };
}

const unrelatedLog = {
  address: AGREEMENT,
  topics: [ethers.id('Transfer(address,address,uint256)')],
  data: '0x',
};

describe('findDisputeResponded', () => {
  it('finds who responded in the receipt', () => {
    const logs = [unrelatedLog, respondedLog(AGREEMENT, SOMEONE_ELSE)];
    expect(findDisputeResponded(logs, AGREEMENT)).toEqual({ party: SOMEONE_ELSE });
  });

  it('matches the agreement address case-insensitively', () => {
    const logs = [respondedLog(AGREEMENT.toLowerCase(), SOMEONE_ELSE)];
    expect(findDisputeResponded(logs, AGREEMENT.toUpperCase().replace('0X', '0x'))).toEqual({
      party: SOMEONE_ELSE,
    });
  });

  it('ignores a DisputeResponded emitted by a different agreement in the same tx', () => {
    const logs = [respondedLog(SOMEONE_ELSE, SOMEONE_ELSE)];
    expect(findDisputeResponded(logs, AGREEMENT)).toBeNull();
  });

  it('returns null when nobody responded in this receipt', () => {
    expect(findDisputeResponded([unrelatedLog], AGREEMENT)).toBeNull();
    expect(findDisputeResponded([], AGREEMENT)).toBeNull();
    expect(findDisputeResponded(undefined, AGREEMENT)).toBeNull();
  });
});

// ─── End to end, through the endpoint that actually sends the pushes ──────────

const ZERO = '0x0000000000000000000000000000000000000000';

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

/** Registers a fresh client/executor pair and their push subscriptions for one test. */
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

  return { clientWallet, executorWallet, client, executor, agreement };
}

describe('POST /relay/notify — the silent side gets told the other side answered', () => {
  beforeEach(() => {
    webpush.sendNotification.mockClear();
  });

  it('client responds — only the executor is pushed, not the client', async () => {
    const { client, executor, agreement } = await makePair();

    mockProviderReceipt({ logs: [respondedLog(agreement, client)] });
    webpush.sendNotification.mockClear();

    const res = await request(app)
      .post('/relay/notify')
      .set('X-Push-Secret', 'test-push-secret')
      .send({ txHash: '0x' + '33'.repeat(32), agreement, calldata: '0xdeadbeef' });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(webpush.sendNotification).toHaveBeenCalledTimes(1));
    const [subscription, payload] = webpush.sendNotification.mock.calls[0];
    // Assert on the address the push actually reached, not just the call count —
    // sending to the wrong party would be silent otherwise.
    expect(subscription.endpoint.toLowerCase()).toContain(executor);
    expect(subscription.endpoint.toLowerCase()).not.toContain(client);
    const body = JSON.parse(payload);
    expect(body.title).toBe('Dispute Answered');
    expect(body.body.toLowerCase()).toMatch(/quarter/);
    expect(body.url).toBe(`/deal/${agreement}`);
  });

  it('executor responds — only the client is pushed, not the executor (symmetry)', async () => {
    const { client, executor, agreement } = await makePair();

    mockProviderReceipt({ logs: [respondedLog(agreement, executor)] });
    webpush.sendNotification.mockClear();

    const res = await request(app)
      .post('/relay/notify')
      .set('X-Push-Secret', 'test-push-secret')
      .send({ txHash: '0x' + '44'.repeat(32), agreement, calldata: '0xdeadbeef' });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(webpush.sendNotification).toHaveBeenCalledTimes(1));
    const [subscription] = webpush.sendNotification.mock.calls[0];
    expect(subscription.endpoint.toLowerCase()).toContain(client);
    expect(subscription.endpoint.toLowerCase()).not.toContain(executor);
  });

  it("ignores a DisputeResponded emitted by a DIFFERENT agreement riding in the same receipt", async () => {
    const { agreement } = await makePair();
    const strangerAgreement = ethers.Wallet.createRandom().address;
    const strangerParty = ethers.Wallet.createRandom().address;

    // The relayed call targeted our agreement, but the receipt also carries a
    // DisputeResponded from someone else's deal — it must not trigger a push
    // describing our two parties' deal to anyone.
    mockProviderReceipt({ logs: [respondedLog(strangerAgreement, strangerParty)] });
    webpush.sendNotification.mockClear();

    const res = await request(app)
      .post('/relay/notify')
      .set('X-Push-Secret', 'test-push-secret')
      .send({ txHash: '0x' + '55'.repeat(32), agreement, calldata: '0xdeadbeef' });
    expect(res.status).toBe(200);

    // Give the background fan-out a beat to run, then confirm nothing fired.
    await new Promise((r) => setTimeout(r, 50));
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
});
