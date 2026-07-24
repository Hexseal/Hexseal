import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { mockContract } from './mocks/ethersRegistry.js';

const FORWARDER = process.env.TRUSTED_FORWARDER;
const VALID_BODY = {
  from: '0x1111111111111111111111111111111111111111',
  to:   '0x2222222222222222222222222222222222222222',
  gas:  '100000',
  data: '0xabcdef',
  signature: '0x' + '11'.repeat(65),
};

describe('POST /relay', () => {
  it('rejects a request missing required fields', async () => {
    const res = await request(app).post('/relay').send({ from: VALID_BODY.from });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid "to" address', async () => {
    const res = await request(app).post('/relay').send({ ...VALID_BODY, to: 'not-an-address' });
    expect(res.status).toBe(400);
  });

  it('rejects a gas value over the hard cap', async () => {
    const res = await request(app).post('/relay').send({ ...VALID_BODY, gas: '9000000' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/gas exceeds maximum/);
  });

  it('rejects when the forwarder reports the signature invalid', async () => {
    mockContract(FORWARDER, { getNonce: 0n, verify: false });
    const res = await request(app).post('/relay').send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid signature/);
  });

  it('relays successfully when the forwarder verifies and the tx mines', async () => {
    mockContract(FORWARDER, {
      getNonce: 0n,
      verify: true,
      // logs: [] matters — after responding, the route fires an un-awaited
      // pushAfterRelay(receipt, ...) which does `for (const log of receipt.logs)`
      // (pushBoardEvents); a receipt without `logs` throws synchronously there,
      // producing an unhandled rejection that a real receipt would never trigger.
      execute: async () => ({
        wait: async () => ({ status: 1, hash: '0xdeadbeef', blockNumber: 42, logs: [] }),
      }),
    });
    const res = await request(app).post('/relay').send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.txHash).toBe('0xdeadbeef');
  });

  it('reports a 400 when the relayed transaction reverts on-chain', async () => {
    mockContract(FORWARDER, {
      getNonce: 0n,
      verify: true,
      execute: async () => ({
        wait: async () => ({ status: 0 }),
      }),
    });
    const res = await request(app).post('/relay').send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reverted/);
  });
});
