import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, relayerInfo } from '../app.js';
import { mockContract } from './mocks/ethersRegistry.js';

describe('GET /nonce/:address', () => {
  it('returns the forwarder-reported nonce for an address', async () => {
    mockContract(relayerInfo.forwarderAddr, { getNonce: 7n });
    const res = await request(app).get('/nonce/0x1234567890123456789012345678901234567890');
    expect(res.status).toBe(200);
    expect(res.body.nonce).toBe('7');
  });
});

describe('GET /balance', () => {
  it("returns the relayer wallet's balance in ETH", async () => {
    const res = await request(app).get('/balance');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('address', relayerInfo.relayerAddress);
    expect(res.body).toHaveProperty('balance');
  });
});

describe('GET /bot-address', () => {
  it('returns a lowercased Ethereum address', async () => {
    const res = await request(app).get('/bot-address');
    expect(res.status).toBe(200);
    expect(res.body.address).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
