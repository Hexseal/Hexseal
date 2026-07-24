import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import { app } from '../app.js';
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

describe('GET /dispute-log/:dealId', () => {
  it('rejects a request with no x-ts/x-sig headers', async () => {
    const res = await request(app).get('/dispute-log/0x9999999999999999999999999999999999999999');
    expect(res.status).toBe(401);
  });

  it('rejects a signer who is not the on-chain arbiter', async () => {
    const strangerWallet = ethers.Wallet.createRandom();
    const dealId = '0xaaaa111111111111111111111111111111111111';
    mockContract(dealId, { getDetails: { arbiter_: '0xbbbb222222222222222222222222222222222222' } });

    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signMessage(strangerWallet, `hexseal:dispute-log:${dealId.toLowerCase()}:${ts}`);

    const res = await request(app).get(`/dispute-log/${dealId}`).set('x-ts', ts).set('x-sig', sig);
    expect(res.status).toBe(403);
  });

  it('accepts a signature from the real on-chain arbiter', async () => {
    const arbiterWallet = ethers.Wallet.createRandom();
    const dealId = '0xcccc333333333333333333333333333333333333';
    const arbiterAddr = (await arbiterWallet.getAddress()).toLowerCase();
    mockContract(dealId, {
      getDetails: {
        client_: '0xdddd444444444444444444444444444444444444',
        executor_: '0xeeee555555555555555555555555555555555555',
        arbiter_: arbiterAddr,
      },
    });

    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signMessage(arbiterWallet, `hexseal:dispute-log:${dealId.toLowerCase()}:${ts}`);

    const res = await request(app).get(`/dispute-log/${dealId}`).set('x-ts', ts).set('x-sig', sig);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('entries');
  });
});
