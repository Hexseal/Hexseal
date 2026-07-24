import { vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { contractMocks, resetContractMocks } from './mocks/ethersRegistry.js';

// Fresh, disposable storage dir per test process — never the real relayer/storage.
const TEST_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-relayer-test-'));

process.env.SERVER_SECRET       = 'test-server-secret';
process.env.RELAYER_PRIVATE_KEY = '0x' + '11'.repeat(32);
process.env.TRUSTED_FORWARDER   = '0x1111111111111111111111111111111111111111';
process.env.DIAMOND_ADDRESS     = '0x2222222222222222222222222222222222222222';
process.env.STORAGE_DIR         = TEST_STORAGE_DIR;
process.env.PUSH_SECRET         = 'test-push-secret';
process.env.RPC_URL             = 'http://127.0.0.1:9999'; // never dialed — Contract is mocked below
process.env.ALLOWED_ORIGINS     = 'http://localhost:3000';

// Every ethers.Contract instance the app constructs looks itself up in the
// shared registry by address; tests populate that registry via mockContract()
// (test/mocks/ethersRegistry.js) before making a request.
vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal();
  class FakeContract {
    constructor(address) {
      const mocked = contractMocks.get(String(address).toLowerCase());
      if (mocked) Object.assign(this, mocked);
      this.address = address;
      if (typeof this.connect !== 'function') this.connect = () => this;
    }
  }
  return { ...actual, Contract: FakeContract };
});

// sendPush() calls webpush.sendNotification() — the only network-reaching call
// in that path. setVapidDetails/generateVAPIDKeys are pure, local, offline
// crypto and are left real.
vi.mock('web-push', async (importOriginal) => {
  const actual = await importOriginal();
  const actualDefault = actual.default ?? actual;
  return {
    ...actual,
    default: { ...actualDefault, sendNotification: vi.fn().mockResolvedValue({}) },
  };
});

beforeEach(() => {
  resetContractMocks();
});
