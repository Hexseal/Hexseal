import { vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  contractMocks,
  resetContractMocks,
  providerMocks,
  resetProviderMocks,
} from './mocks/ethersRegistry.js';

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
//
// Two things make a naive "copy mocked methods onto `this` in the constructor"
// approach insufficient here:
//
// 1. app.js imports the package as `import { ethers } from 'ethers'` — the
//    `ethers` binding is itself a separate module-namespace object (ethers v6
//    re-exports one), not just an alias for the top-level named exports. Only
//    overriding the top-level `Contract` export (as this mock used to) leaves
//    `ethers.Contract` pointing at the real class, so `new ethers.Contract(...)`
//    inside app.js never picked up the fake at all — it opened a real socket to
//    the (unreachable) RPC_URL. Both the top-level export AND the nested
//    `ethers` namespace object's own `Contract` property must be replaced.
// 2. Some contracts (e.g. the module-level `forwarder` singleton in app.js)
//    are constructed once, at import time — before any test's mockContract()
//    call has run. A one-shot `Object.assign` at construction time captures
//    "no mock yet" forever. Resolving methods lazily via a Proxy (on every
//    property access, against the CURRENT contents of the registry) makes
//    mockContract() work no matter when it's called relative to construction.
//
// GET /balance (and the receipt lookup in /relay/notify) calls methods
// directly on the module-level `provider` singleton — not through
// `ethers.Contract` at all — so the Contract-mocking machinery above doesn't
// cover them. Patching these two instance methods in place (rather than
// swapping the whole class) keeps everything else about JsonRpcProvider
// (construction, other methods) real; it just stops these from ever dialing
// the deliberately-unreachable RPC_URL. Delegating to `providerMocks`
// (test/mocks/ethersRegistry.js), reset every beforeEach the same as
// `contractMocks`, gives a future test a place to override either value
// per-test without hand-patching the prototype again.
vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal();
  actual.JsonRpcProvider.prototype.getBalance = async function (...args) {
    return providerMocks.getBalance(...args);
  };
  actual.JsonRpcProvider.prototype.getTransactionReceipt = async function (...args) {
    return providerMocks.getTransactionReceipt(...args);
  };
  class FakeContract {
    constructor(address) {
      const key = String(address).toLowerCase();
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop === 'address') return address;
          const mocked = contractMocks.get(key);
          if (mocked && prop in mocked) return mocked[prop];
          if (prop === 'connect') return () => receiver;
          return Reflect.get(target, prop, receiver);
        },
      });
    }
  }
  return {
    ...actual,
    Contract: FakeContract,
    ethers: { ...actual.ethers, Contract: FakeContract },
  };
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
  resetProviderMocks();
});
