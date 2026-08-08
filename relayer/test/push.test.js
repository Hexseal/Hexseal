import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import { app } from '../app.js';
import { issueBagPass } from '../bagPass.js';
import { signMessage } from './helpers/signing.js';

const FCM_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/test-endpoint-123';

async function subscribe(wallet, endpoint = FCM_ENDPOINT) {
  const address = (await wallet.getAddress()).toLowerCase();
  const sig = await signMessage(wallet, `hexseal:push-subscribe:${address}:${endpoint}`);
  const res = await request(app).post('/push/subscribe').send({
    address,
    subscription: { endpoint, keys: { p256dh: 'test-p256dh', auth: 'test-auth' } },
    sig,
  });
  return { address, endpoint, res };
}

describe('POST /push/subscribe', () => {
  it('accepts a validly signed subscription to a known push service', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { res } = await subscribe(wallet);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects an unrecognized push-service endpoint even with a valid signature', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { res } = await subscribe(wallet, 'https://evil.example/steal');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unrecognized/);
  });

  it('rejects a missing signature', async () => {
    const wallet = ethers.Wallet.createRandom();
    const address = (await wallet.getAddress()).toLowerCase();
    const res = await request(app).post('/push/subscribe').send({
      address,
      subscription: { endpoint: FCM_ENDPOINT, keys: { p256dh: 'test-p256dh', auth: 'test-auth' } },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a signature from a different wallet than the address field', async () => {
    const realWallet = ethers.Wallet.createRandom();
    const attackerWallet = ethers.Wallet.createRandom();
    const address = (await realWallet.getAddress()).toLowerCase();
    const badSig = await signMessage(attackerWallet, `hexseal:push-subscribe:${address}:${FCM_ENDPOINT}`);
    const res = await request(app).post('/push/subscribe').send({
      address,
      subscription: { endpoint: FCM_ENDPOINT, keys: { p256dh: 'test-p256dh', auth: 'test-auth' } },
      sig: badSig,
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /push/unsubscribe', () => {
  it('rejects a request with no signature', async () => {
    const wallet = ethers.Wallet.createRandom();
    const address = (await wallet.getAddress()).toLowerCase();
    const res = await request(app).post('/push/unsubscribe').send({ address, endpoint: FCM_ENDPOINT });
    expect(res.status).toBe(401);
  });

  it('rejects a signature from a different wallet than the address field', async () => {
    const realWallet = ethers.Wallet.createRandom();
    const attackerWallet = ethers.Wallet.createRandom();
    const address = (await realWallet.getAddress()).toLowerCase();
    const badSig = await signMessage(attackerWallet, `hexseal:push-unsubscribe:${address}:${FCM_ENDPOINT}`);
    const res = await request(app).post('/push/unsubscribe').send({ address, endpoint: FCM_ENDPOINT, sig: badSig });
    expect(res.status).toBe(403);
  });

  it('accepts a validly signed unsubscribe after a real subscribe', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { address, endpoint } = await subscribe(wallet);
    const sig = await signMessage(wallet, `hexseal:push-unsubscribe:${address}:${endpoint}`);
    const res = await request(app).post('/push/unsubscribe').send({ address, endpoint, sig });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('POST /push/send', () => {
  it('rejects a request with no X-Push-Secret header', async () => {
    const res = await request(app).post('/push/send').send({
      to: '0x1234567890123456789012345678901234567890',
      body: 'hello',
    });
    expect(res.status).toBe(403);
  });

  it('rejects a request with the wrong secret', async () => {
    const res = await request(app)
      .post('/push/send')
      .set('X-Push-Secret', 'wrong-secret')
      .send({ to: '0x1234567890123456789012345678901234567890', body: 'hello' });
    expect(res.status).toBe(403);
  });

  // К-2: секрета БОЛЬШЕ НЕ ДОСТАТОЧНО. Он отвечает на вопрос «изнутри или из
  // интернета», а не «кто человек» — и наш собственный /api/push подставлял
  // его сам, так что посторонний слал уведомление кому угодно и уводил
  // открытую вкладку куда угодно. Право слать теперь доказывается тем же
  // пропуском, что и склад мешков. Полный разбор и замеры — в
  // test/pushSenderProof.test.js; здесь заперты только два прежних
  // утверждения, приведённых к новому договору.
  it('правильного секрета мало: без пропуска — 401 (К-2)', async () => {
    const res = await request(app)
      .post('/push/send')
      .set('X-Push-Secret', 'test-push-secret')
      .send({ to: '0x1234567890123456789012345678901234567890', body: 'hello' });
    expect(res.status).toBe(401);
  });

  it('accepts a request with the correct secret AND a live pass', async () => {
    const { token } = issueBagPass('0x00000000000000000000000000000000000000aa');
    const res = await request(app)
      .post('/push/send')
      .set('X-Push-Secret', 'test-push-secret')
      .set('x-bag-pass', token)
      .send({ to: '0x1234567890123456789012345678901234567890' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects a request missing "to"', async () => {
    const { token } = issueBagPass('0x00000000000000000000000000000000000000aa');
    const res = await request(app)
      .post('/push/send')
      .set('X-Push-Secret', 'test-push-secret')
      .set('x-bag-pass', token)
      .send({ body: 'hello' });
    expect(res.status).toBe(400);
  });
});

describe('GET /push/vapid-key', () => {
  it('returns a public key string', async () => {
    const res = await request(app).get('/push/vapid-key');
    expect(res.status).toBe(200);
    expect(typeof res.body.publicKey).toBe('string');
    expect(res.body.publicKey.length).toBeGreaterThan(0);
  });
});
