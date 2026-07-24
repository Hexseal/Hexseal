import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import { app } from '../app.js';
import { signProfileUpdate } from './helpers/signing.js';
import { jsonBody } from './helpers/httpBody.js';

function uploadProfile(address, body, sig) {
  const key = `profile-${address}.json`;
  return request(app)
    .put(`/files/public-put/${key}`)
    .set('Content-Type', 'application/octet-stream')
    .set('X-Profile-Signature', sig)
    .send(body);
}

describe('PUT /files/public-put/:key — profile branch', () => {
  it('accepts a validly signed profile with an http(s) website', async () => {
    const wallet = ethers.Wallet.createRandom();
    const nonce  = Date.now();
    const body   = JSON.stringify({ displayName: 'Alice', updatedAt: nonce, links: { website: 'https://alice.example' } });
    const { address, sig } = await signProfileUpdate(wallet, nonce, body);

    const res = await uploadProfile(address, body, sig);
    expect(res.status).toBe(200);
  });

  it('rejects a javascript: URI in links.website even with a valid signature', async () => {
    const wallet = ethers.Wallet.createRandom();
    const nonce  = Date.now();
    const body   = JSON.stringify({ displayName: 'Mallory', updatedAt: nonce, links: { website: 'javascript:alert(1)' } });
    const { address, sig } = await signProfileUpdate(wallet, nonce, body);

    const res = await uploadProfile(address, body, sig);
    expect(res.status).toBe(400);
    expect(jsonBody(res).error).toMatch(/http\(s\)/);
  });

  it('accepts a profile with no website field at all', async () => {
    const wallet = ethers.Wallet.createRandom();
    const nonce  = Date.now();
    const body   = JSON.stringify({ displayName: 'Bob', updatedAt: nonce });
    const { address, sig } = await signProfileUpdate(wallet, nonce, body);

    const res = await uploadProfile(address, body, sig);
    expect(res.status).toBe(200);
  });

  it('rejects a request with no X-Profile-Signature header', async () => {
    const wallet = ethers.Wallet.createRandom();
    const address = (await wallet.getAddress()).toLowerCase();
    const body = JSON.stringify({ displayName: 'Eve', updatedAt: Date.now() });

    const res = await request(app)
      .put(`/files/public-put/profile-${address}.json`)
      .set('Content-Type', 'application/octet-stream')
      .send(body);
    expect(res.status).toBe(401);
  });

  it('rejects a signature from a different wallet than the one in the filename', async () => {
    const realWallet     = ethers.Wallet.createRandom();
    const attackerWallet = ethers.Wallet.createRandom();
    const nonce = Date.now();
    const body  = JSON.stringify({ displayName: 'Impersonated', updatedAt: nonce });
    const bodyHash = ethers.keccak256(ethers.toUtf8Bytes(body));
    const realAddress = (await realWallet.getAddress()).toLowerCase();
    const message = `hexseal:profile:update:${realAddress}:${nonce}:${bodyHash}`;
    const badSig  = await attackerWallet.signMessage(message);

    const res = await uploadProfile(realAddress, body, badSig);
    expect(res.status).toBe(403);
  });

  it('rejects a stale/replayed nonce', async () => {
    const wallet = ethers.Wallet.createRandom();
    const nonce  = Date.now();
    const body1  = JSON.stringify({ displayName: 'First', updatedAt: nonce });
    const first  = await signProfileUpdate(wallet, nonce, body1);
    const ok = await uploadProfile(first.address, body1, first.sig);
    expect(ok.status).toBe(200);

    // Same or earlier nonce, freshly (validly) signed — must still be rejected.
    const body2 = JSON.stringify({ displayName: 'Replayed', updatedAt: nonce });
    const replay = await signProfileUpdate(wallet, nonce, body2);
    const res = await uploadProfile(replay.address, body2, replay.sig);
    expect(res.status).toBe(400);
    expect(jsonBody(res).error).toMatch(/replay/i);
  });

  it('accepts a later nonce for the same address after an earlier one succeeded', async () => {
    const wallet = ethers.Wallet.createRandom();
    const nonce1 = Date.now();
    const body1  = JSON.stringify({ displayName: 'V1', updatedAt: nonce1 });
    const first  = await signProfileUpdate(wallet, nonce1, body1);
    const firstRes = await uploadProfile(first.address, body1, first.sig);
    expect(firstRes.status).toBe(200);

    const nonce2 = nonce1 + 1000;
    const body2  = JSON.stringify({ displayName: 'V2', updatedAt: nonce2 });
    const second = await signProfileUpdate(wallet, nonce2, body2);
    const res = await uploadProfile(second.address, body2, second.sig);
    expect(res.status).toBe(200);
  });
});
