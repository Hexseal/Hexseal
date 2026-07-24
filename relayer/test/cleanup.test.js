import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { runFileCleanup, relayerInfo } from '../app.js';
import { mockContract } from './mocks/ethersRegistry.js';

function touch(filePath, mtimeMs) {
  fs.writeFileSync(filePath, 'x');
  const t = new Date(mtimeMs);
  fs.utimesSync(filePath, t, t);
}

// The /files prefix middleware in app.js unconditionally sets Content-Type:
// application/octet-stream on every response under /files (including this
// presign call, which is otherwise a plain JSON endpoint), before res.json()
// gets a chance to set it — Express's res.json() only sets Content-Type when
// it isn't already set. supertest therefore can't auto-parse the response:
// res.body comes back as a raw Buffer and res.text is left undefined. Same
// workaround as test/fileStorage.test.js's jsonBody().
function jsonBody(res) {
  return JSON.parse(Buffer.isBuffer(res.body) ? res.body.toString('utf8') : res.text);
}

describe('runFileCleanup', () => {
  it('deletes an untagged file older than the 7-day TTL', async () => {
    mockContract(process.env.DIAMOND_ADDRESS, { getDisputed: [] });
    const fp = path.join(relayerInfo.dirFiles, `old-untagged-${Date.now()}.bin`);
    touch(fp, Date.now() - 8 * 24 * 60 * 60 * 1000);

    await runFileCleanup();
    expect(fs.existsSync(fp)).toBe(false);
  });

  it('keeps a fresh untagged file (younger than the TTL)', async () => {
    mockContract(process.env.DIAMOND_ADDRESS, { getDisputed: [] });
    const fp = path.join(relayerInfo.dirFiles, `fresh-${Date.now()}.bin`);
    touch(fp, Date.now());

    await runFileCleanup();
    expect(fs.existsSync(fp)).toBe(true);
  });

  it('protects a tagged file whose pair is currently disputed and younger than the 90-day ceiling', async () => {
    const client = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const executor = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    mockContract(process.env.DIAMOND_ADDRESS, { getDisputed: [{ client, executor }] });

    // Tag the file via a real presign call so _filePairs is populated the same
    // way production traffic populates it, then age the file past the TTL.
    const request = (await import('supertest')).default;
    const { app } = await import('../app.js');
    const presign = await request(app).post('/files/presign').send({ peerA: client, peerB: executor });
    const fp = path.join(relayerInfo.dirFiles, jsonBody(presign).key);
    touch(fp, Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days — past TTL, well within the 90-day ceiling

    await runFileCleanup();
    expect(fs.existsSync(fp)).toBe(true);
  });

  it('deletes a tagged-and-disputed file once it exceeds the 90-day protection ceiling', async () => {
    const client = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    const executor = '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
    mockContract(process.env.DIAMOND_ADDRESS, { getDisputed: [{ client, executor }] });

    const request = (await import('supertest')).default;
    const { app } = await import('../app.js');
    const presign = await request(app).post('/files/presign').send({ peerA: client, peerB: executor });
    const fp = path.join(relayerInfo.dirFiles, jsonBody(presign).key);
    touch(fp, Date.now() - 120 * 24 * 60 * 60 * 1000); // 120 days — past the 90-day ceiling

    await runFileCleanup();
    expect(fs.existsSync(fp)).toBe(false);
  });

  it('removes an orphaned temp upload dir older than 1 day', async () => {
    mockContract(process.env.DIAMOND_ADDRESS, { getDisputed: [] });
    const dir = path.join(relayerInfo.storageDir, 'temp', `orphan-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(dir, old, old);

    await runFileCleanup();
    expect(fs.existsSync(dir)).toBe(false);
  });
});
