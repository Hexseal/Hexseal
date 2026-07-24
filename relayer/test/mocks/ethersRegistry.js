// Keyed by lowercased contract address → an object of method name → async fn.
// Populated per-test via mockContract(); consumed by the ethers.Contract mock
// installed in test/setup.js.
export const contractMocks = new Map();

/**
 * Registers fake behavior for `new ethers.Contract(address, abi, runner)`.
 * `methods` maps method names to either a plain value (wrapped in an async fn
 * that resolves to it) or a function (called with the same args the route
 * handler passed, for tests that need per-call logic).
 *
 * Passing a `connect` key in `methods` overrides FakeContract's default
 * live-lookup `connect` fallback (test/setup.js) — most callers should NOT,
 * so that a `.connect()` result keeps resolving against the current registry.
 */
export function mockContract(address, methods) {
  const key = String(address).toLowerCase();
  const fns = {};
  for (const [name, value] of Object.entries(methods)) {
    fns[name] = typeof value === 'function' ? value : async () => value;
  }
  // No `fns.connect` here on purpose: leaving it unset lets FakeContract's own
  // Proxy `get` trap (test/setup.js) fall through to its `connect` fallback,
  // which returns the live receiver rather than this frozen `fns` object — so
  // a `.connect()` result obtained before a later mockContract() call for the
  // same address still resolves against whatever is CURRENTLY registered.
  contractMocks.set(key, fns);
  return fns;
}

export function resetContractMocks() {
  contractMocks.clear();
}

const providerMockDefaults = {
  getBalance: async () => 1_000000000000000000n, // 1 ETH — fixed; no test asserts a specific value
  getTransactionReceipt: async () => null,
};

// Backs the JsonRpcProvider.prototype patch in test/setup.js — that patch
// delegates here so a future test can override a value (mockProviderBalance /
// mockProviderReceipt) without touching the patch itself, the same way
// mockContract() lets a test override contract behavior without touching
// FakeContract.
export const providerMocks = { ...providerMockDefaults };

export function mockProviderBalance(value) {
  providerMocks.getBalance = typeof value === 'function' ? value : async () => value;
}

export function mockProviderReceipt(value) {
  providerMocks.getTransactionReceipt = typeof value === 'function' ? value : async () => value;
}

export function resetProviderMocks() {
  Object.assign(providerMocks, providerMockDefaults);
}
