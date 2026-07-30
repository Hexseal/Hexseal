import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import webpush from 'web-push';
import { app, findDisputeResponded } from '../app.js';
import { mockContract, mockProviderReceipt } from './mocks/ethersRegistry.js';
import { signMessage } from './helpers/signing.js';

/**
 * respondToDispute() does not move the agreement's status in the Registry, so the
 * status-driven AGR_PUSH_MSG table never sees it. This file covers the push that
 * fills that gap: the agreement's own DisputeResponded event is read out of the
 * receipt (same trick as DisputeSplitNoVerdict — the Diamond never emits it) and
 * the OTHER party is pushed, chosen by comparison the same way AppealRaised
 * chooses its recipient.
 *
 * WHO THAT OTHER PARTY IS, AND WHY IT IS NEVER THE ONE AT RISK.
 *
 * `raiseDispute` marks the raiser as present on the spot (`src/Agreement.sol`),
 * so `respondToDispute()` reverts AlreadyResponded for him and only the second
 * party can ever call it. Therefore whoever responded is always the NON-raiser,
 * and the party opposite the responder — this push's recipient — is always the
 * raiser: someone who already responded and risks nothing.
 *
 * So this message is purely INFORMATIONAL, and it must stay that way. An earlier
 * version read "Answer it too — staying silent costs a quarter of the escrow",
 * which demanded of its only possible recipient an action that reverts, costing
 * him a signature and the relayer gas for nothing. What he does need to know is
 * that the arithmetic moved: with both sides present a timeout now splits the
 * escrow in half, where a moment ago three quarters of it were his.
 *
 * The side that actually has a clock running is warned when the dispute is
 * RAISED, not here — see `disputeRaisedWarningPush.test.js`. By the time this
 * event fires, the deadline is no longer news to anyone who can act on it.
 *
 * ⚠️ Asserting /quarter/ on this body is NOT enough and was actively misleading:
 * it matches "three quarters" in the current text just as happily as it matched
 * "a quarter" in the old one, so the whole reversal of meaning slipped through a
 * green test. The assertions below pin the informational reading explicitly.
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

describe('POST /relay/notify — the raiser is told the other side answered too', () => {
  beforeEach(() => {
    webpush.sendNotification.mockClear();
  });

  it('client responds — only the executor (the raiser) is pushed, not the client', async () => {
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
    // sending to the wrong party would be silent otherwise. The client responded,
    // so the executor is the raiser: the one who already answered.
    expect(subscription.endpoint.toLowerCase()).toContain(executor);
    expect(subscription.endpoint.toLowerCase()).not.toContain(client);
    const body = JSON.parse(payload);
    expect(body.title).toBe('Dispute Answered');
    expect(body.url).toBe(`/deal/${agreement}`);

    // ── The meaning, pinned so it cannot silently reverse again ──────────────
    //
    // Both halves of the arithmetic, and in this order: the outcome is now a
    // half, and it used to be three quarters. /quarter/ alone would match either
    // reading — the old "staying silent costs a quarter" scored exactly the same
    // green as this text does, which is how the reversal got through untouched.
    expect(body.body).toMatch(/split in half/i);
    expect(body.body).toMatch(/three quarters/i);

    // And nothing is demanded of him: respondToDispute() reverts
    // AlreadyResponded for the raiser, so any imperative here is a request for a
    // signature spent on a guaranteed revert. "answered" (past, about the other
    // side) is fine; "answer it" (imperative, at the reader) is not.
    expect(body.body).not.toMatch(/\banswer (it|this|the dispute)\b/i);
    expect(body.body).not.toMatch(/staying silent|stay silent|costs you/i);
  });

  it('executor responds — only the client (the raiser) is pushed, not the executor (symmetry)', async () => {
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
