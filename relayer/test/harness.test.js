import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  mockContract, resetContractMocks,
  mockProviderBalance, resetProviderMocks, providerMocks,
} from './mocks/ethersRegistry.js';

// Direct regression coverage for the shared ethers/provider mock harness itself
// (test/mocks/ethersRegistry.js + test/setup.js). This machinery had a real,
// silent bug once — the mock never touched the `ethers` namespace object's own
// .Contract, so every mockContract() call was a no-op — and the fix for that
// introduced the live-lookup .connect() and provider-reset behaviors asserted
// below. Until now their correctness rested only on manual review; these pin it.

const ADDR = '0x1234567890123456789012345678901234567890';

describe('ethers Contract mock registry', () => {
  it('resolves a registered method through new ethers.Contract()', async () => {
    mockContract(ADDR, { foo: 42 });
    const c = new ethers.Contract(ADDR, [], null);
    expect(await c.foo()).toBe(42);
  });

  it('lets a later mockContract() override an earlier one for the same address', async () => {
    mockContract(ADDR, { foo: async () => 1 });
    mockContract(ADDR, { foo: async () => 2 });
    const c = new ethers.Contract(ADDR, [], null);
    expect(await c.foo()).toBe(2);
  });

  it('resetContractMocks() clears the registry (the mechanism beforeEach auto-reset uses)', async () => {
    mockContract(ADDR, { foo: 7 });
    expect(await new ethers.Contract(ADDR, [], null).foo()).toBe(7);
    resetContractMocks();
    expect(new ethers.Contract(ADDR, [], null).foo).toBeUndefined();
  });

  it('keeps a .connect() result live against a later re-registration of the same address', async () => {
    mockContract(ADDR, { foo: async () => 1 });
    const connected = new ethers.Contract(ADDR, [], null).connect({}); // signer-bound instance
    expect(await connected.foo()).toBe(1);

    mockContract(ADDR, { foo: async () => 2 }); // re-register the same address after connecting
    expect(await connected.foo()).toBe(2);      // resolves against the CURRENT registry, not a stale snapshot
  });

  it('lets a caller override the live-lookup connect fallback with a custom connect key', () => {
    const marker = { bound: true };
    mockContract(ADDR, { connect: () => marker });
    const c = new ethers.Contract(ADDR, [], null);
    expect(c.connect({})).toBe(marker);
  });
});

describe('JsonRpcProvider mock', () => {
  it('overrides then resets getBalance around the default', async () => {
    expect(await providerMocks.getBalance()).toBe(1_000000000000000000n); // 1 ETH default
    mockProviderBalance(async () => 5n);
    expect(await providerMocks.getBalance()).toBe(5n);
    resetProviderMocks();
    expect(await providerMocks.getBalance()).toBe(1_000000000000000000n);
  });
});
