import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, relayerInfo } from '../app.js';

describe('GET /health', () => {
  it('returns ok with the relayer and diamond addresses', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status:  'ok',
      relayer: relayerInfo.relayerAddress,
      diamond: relayerInfo.diamondAddr,
    });
  });
});
