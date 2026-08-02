import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import { app, issueDisputeLogPass, verifyDisputeLogPass, DISPUTE_PASS_TTL_SEC } from '../app.js';
import { mockContract } from './mocks/ethersRegistry.js';
import { signMessage } from './helpers/signing.js';

describe('POST /dispute-reason then GET /dispute-reason', () => {
  it('accepts a reason signed by the on-chain client, then returns it', async () => {
    const clientWallet = ethers.Wallet.createRandom();
    const executorWallet = ethers.Wallet.createRandom();
    const agreement = '0x3333333333333333333333333333333333333333';
    const clientAddr = (await clientWallet.getAddress()).toLowerCase();
    const executorAddr = (await executorWallet.getAddress()).toLowerCase();
    mockContract(agreement, { getDetails: { client_: clientAddr, executor_: executorAddr } });

    const reason = 'Executor never delivered.';
    const ts = Math.floor(Date.now() / 1000);
    const reasonHash = ethers.keccak256(ethers.toUtf8Bytes(reason));
    const sig = await signMessage(clientWallet, `hexseal:dispute-reason:${agreement.toLowerCase()}:${ts}:${reasonHash}`);

    const postRes = await request(app).post('/dispute-reason').send({ agreement, reason, ts, sig });
    expect(postRes.status).toBe(200);

    const getRes = await request(app).get('/dispute-reason').query({ agreement });
    expect(getRes.status).toBe(200);
    expect(getRes.body.reason).toBe(reason);
  });

  it('rejects a reason signed by someone who is neither the client nor the executor', async () => {
    const strangerWallet = ethers.Wallet.createRandom();
    const agreement = '0x4444444444444444444444444444444444444444';
    mockContract(agreement, {
      getDetails: {
        client_:   '0x5555555555555555555555555555555555555555',
        executor_: '0x6666666666666666666666666666666666666666',
      },
    });

    const reason = 'Not actually a party to this deal.';
    const ts = Math.floor(Date.now() / 1000);
    const reasonHash = ethers.keccak256(ethers.toUtf8Bytes(reason));
    const sig = await signMessage(strangerWallet, `hexseal:dispute-reason:${agreement.toLowerCase()}:${ts}:${reasonHash}`);

    const res = await request(app).post('/dispute-reason').send({ agreement, reason, ts, sig });
    expect(res.status).toBe(403);
  });

  it('rejects a timestamp outside the ±5 minute replay window', async () => {
    const wallet = ethers.Wallet.createRandom();
    const agreement = '0x7777777777777777777777777777777777777777';
    const reason = 'Too late.';
    const ts = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const reasonHash = ethers.keccak256(ethers.toUtf8Bytes(reason));
    const sig = await signMessage(wallet, `hexseal:dispute-reason:${agreement.toLowerCase()}:${ts}:${reasonHash}`);

    const res = await request(app).post('/dispute-reason').send({ agreement, reason, ts, sig });
    expect(res.status).toBe(401);
  });

  it('GET returns { reason: null } for an agreement with no stored reason', async () => {
    const res = await request(app).get('/dispute-reason').query({ agreement: '0x8888888888888888888888888888888888888888' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reason: null });
  });
});

// The diamond address the app reads from the environment (test/setup.js).
const DIAMOND = '0x2222222222222222222222222222222222222222';
const ZERO = '0x0000000000000000000000000000000000000000';

const NO_VERDICT = { arbiter: ZERO, submittedAt: 0n };
const verdictBy = (arbiter, submittedAt = 1n) => ({ arbiter, submittedAt });

/** Both parties of every deal in these tests — the log is stored per pair. */
const PARTIES = {
  client_:   '0xdddd444444444444444444444444444444444444',
  executor_: '0xeeee555555555555555555555555555555555555',
  // Deliberately the DIAMOND, which is what claimDispute() really writes into
  // the agreement (Diamond-as-arbiter). Every test below passes with this here:
  // that is the point — the gate must never look at this field again.
  arbiter_:  DIAMOND,
};

describe('GET /dispute-log/:dealId', () => {
  it('rejects a request with no x-ts/x-sig headers', async () => {
    const res = await request(app).get('/dispute-log/0x9999999999999999999999999999999999999999');
    expect(res.status).toBe(401);
  });

  it('rejects a signer who does not hold the dispute claim', async () => {
    const strangerWallet = ethers.Wallet.createRandom();
    const dealId = '0xaaaa111111111111111111111111111111111111';
    mockContract(dealId, { getDetails: PARTIES });
    mockContract(DIAMOND, {
      getDisputeClaimer: '0xbbbb222222222222222222222222222222222222',
      getPendingVerdict: NO_VERDICT,
    });

    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signMessage(strangerWallet, `hexseal:dispute-log:${dealId.toLowerCase()}:${ts}`);

    const res = await request(app).get(`/dispute-log/${dealId}`).set('x-ts', ts).set('x-sig', sig);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_arbiter');
  });

  it('accepts the holder of the dispute claim, even though Agreement.arbiter is the diamond', async () => {
    const arbiterWallet = ethers.Wallet.createRandom();
    const dealId = '0xcccc333333333333333333333333333333333333';
    const arbiterAddr = (await arbiterWallet.getAddress()).toLowerCase();
    mockContract(dealId, { getDetails: PARTIES });
    mockContract(DIAMOND, {
      getDisputeClaimer: arbiterAddr,
      // Not submitted yet — the arbiter reads the log in order to decide.
      getPendingVerdict: NO_VERDICT,
    });

    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signMessage(arbiterWallet, `hexseal:dispute-log:${dealId.toLowerCase()}:${ts}`);

    const res = await request(app).get(`/dispute-log/${dealId}`).set('x-ts', ts).set('x-sig', sig);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('entries');
  });

  it('accepts the arbiter of a finalized verdict, whose claim is already cleared', async () => {
    const arbiterWallet = ethers.Wallet.createRandom();
    const dealId = '0xcccc333333333333333333333333333333333334';
    const arbiterAddr = (await arbiterWallet.getAddress()).toLowerCase();
    mockContract(dealId, { getDetails: PARTIES });
    mockContract(DIAMOND, {
      getDisputeClaimer: ZERO,               // clearDisputeClaim() wiped it
      getPendingVerdict: verdictBy(arbiterAddr),
    });

    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signMessage(arbiterWallet, `hexseal:dispute-log:${dealId.toLowerCase()}:${ts}`);

    const res = await request(app).get(`/dispute-log/${dealId}`).set('x-ts', ts).set('x-sig', sig);
    expect(res.status).toBe(200);
  });

  it('refuses everyone when nobody claimed the dispute and no verdict exists', async () => {
    const wallet = ethers.Wallet.createRandom();
    const dealId = '0xcccc333333333333333333333333333333333335';
    mockContract(dealId, { getDetails: PARTIES });
    mockContract(DIAMOND, { getDisputeClaimer: ZERO, getPendingVerdict: NO_VERDICT });

    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signMessage(wallet, `hexseal:dispute-log:${dealId.toLowerCase()}:${ts}`);

    const res = await request(app).get(`/dispute-log/${dealId}`).set('x-ts', ts).set('x-sig', sig);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('no_arbiter');
  });

  it('never reads Agreement.getDetails() to decide access', async () => {
    const strangerWallet = ethers.Wallet.createRandom();
    const strangerAddr = (await strangerWallet.getAddress()).toLowerCase();
    const dealId = '0xcccc333333333333333333333333333333333336';
    // The agreement names the stranger as its arbiter — the exact shape the old
    // gate trusted. The diamond says otherwise, and the diamond wins.
    mockContract(dealId, { getDetails: { ...PARTIES, arbiter_: strangerAddr } });
    mockContract(DIAMOND, {
      getDisputeClaimer: '0xbbbb222222222222222222222222222222222222',
      getPendingVerdict: NO_VERDICT,
    });

    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signMessage(strangerWallet, `hexseal:dispute-log:${dealId.toLowerCase()}:${ts}`);

    const res = await request(app).get(`/dispute-log/${dealId}`).set('x-ts', ts).set('x-sig', sig);
    expect(res.status).toBe(403);
  });
});

describe('GET /dispute-log/:dealId — session pass', () => {
  const dealId = '0xf1f1000000000000000000000000000000000001';

  /** First read with a signature; returns the issued pass. */
  async function firstRead(wallet, deal = dealId) {
    const addr = (await wallet.getAddress()).toLowerCase();
    mockContract(deal, { getDetails: PARTIES });
    mockContract(DIAMOND, { getDisputeClaimer: addr, getPendingVerdict: NO_VERDICT });

    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signMessage(wallet, `hexseal:dispute-log:${deal.toLowerCase()}:${ts}`);
    const res = await request(app).get(`/dispute-log/${deal}`).set('x-ts', ts).set('x-sig', sig);
    expect(res.status).toBe(200);
    return res.body.pass;
  }

  it('hands out a pass on the signed read, and accepts it without any signature', async () => {
    const wallet = ethers.Wallet.createRandom();
    const pass = await firstRead(wallet);
    expect(pass?.token).toBeTruthy();
    expect(pass.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const res = await request(app).get(`/dispute-log/${dealId}`).set('x-dispute-pass', pass.token);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('entries');
    // Repeat reads don't mint new passes — the first one keeps its own expiry.
    expect(res.body.pass).toBeUndefined();
  });

  it('rejects a pass minted for a different deal', async () => {
    const wallet = ethers.Wallet.createRandom();
    const otherDeal = '0xf1f1000000000000000000000000000000000002';
    const pass = await firstRead(wallet, otherDeal);

    mockContract(dealId, { getDetails: PARTIES });
    const res = await request(app).get(`/dispute-log/${dealId}`).set('x-dispute-pass', pass.token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('pass_invalid');
  });

  it('rejects a tampered pass (address swapped, MAC left alone)', async () => {
    const wallet = ethers.Wallet.createRandom();
    const pass = await firstRead(wallet);

    const [v, body, mac] = pass.token.split('.');
    const decoded = Buffer.from(body, 'base64url').toString('utf8');
    const forgedBody = decoded.replace(
      /0x[a-f0-9]{40}\.(\d+)$/,
      '0xbbbb222222222222222222222222222222222222.$1',
    );
    const forged = `${v}.${Buffer.from(forgedBody, 'utf8').toString('base64url')}.${mac}`;

    const res = await request(app).get(`/dispute-log/${dealId}`).set('x-dispute-pass', forged);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('pass_invalid');
  });

  it('answers an expired pass with a distinct code, not a bare 403', async () => {
    const arbiter = '0xaaaa000000000000000000000000000000000001';
    const longAgo = Math.floor(Date.now() / 1000) - DISPUTE_PASS_TTL_SEC - 60;
    const { token } = issueDisputeLogPass(dealId, arbiter, longAgo);

    const res = await request(app).get(`/dispute-log/${dealId}`).set('x-dispute-pass', token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('pass_expired');
    expect(res.body.error).toMatch(/expired/i);
  });

  it('stops working the moment the arbiter releases the claim — the pass is not a capability', async () => {
    const wallet = ethers.Wallet.createRandom();
    const pass = await firstRead(wallet);

    // releaseDisputeClaim(): the claim is gone, no verdict was ever submitted.
    mockContract(DIAMOND, { getDisputeClaimer: ZERO, getPendingVerdict: NO_VERDICT });

    const res = await request(app).get(`/dispute-log/${dealId}`).set('x-dispute-pass', pass.token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('no_arbiter');
  });

  it('gives a pass holder nothing once a different arbiter holds the case', async () => {
    const wallet = ethers.Wallet.createRandom();
    const pass = await firstRead(wallet);

    mockContract(DIAMOND, {
      getDisputeClaimer: '0xbbbb222222222222222222222222222222222222',
      getPendingVerdict: NO_VERDICT,
    });

    const res = await request(app).get(`/dispute-log/${dealId}`).set('x-dispute-pass', pass.token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_arbiter');
  });

  it('verifyDisputeLogPass round-trips deal and address', () => {
    const deal = '0xF1F1000000000000000000000000000000000003';
    const arbiter = '0xAAAA000000000000000000000000000000000009';
    const { token, expiresAt } = issueDisputeLogPass(deal, arbiter);
    expect(verifyDisputeLogPass(token, deal)).toEqual({ address: arbiter.toLowerCase() });
    expect(verifyDisputeLogPass(token, deal, expiresAt).code).toBe('pass_expired');
    expect(verifyDisputeLogPass('garbage', deal).code).toBe('pass_invalid');
  });
});
