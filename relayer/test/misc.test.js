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

// GET /bot-address удалён вместе с ботом XMTP (6 августа 2026): маршрут
// отдавал фронту адрес, который тот добавлял в парную группу. Замок
// перевёрнут — теперь запирает ОТСУТСТВИЕ маршрута, а не его форму.
describe('GET /bot-address', () => {
  it('маршрута больше нет — бота, чей адрес он отдавал, не существует', async () => {
    const res = await request(app).get('/bot-address');
    expect(res.status).toBe(404);
  });
});
