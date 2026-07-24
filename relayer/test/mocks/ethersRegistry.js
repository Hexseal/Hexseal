// Keyed by lowercased contract address → an object of method name → async fn.
// Populated per-test via mockContract(); consumed by the ethers.Contract mock
// installed in test/setup.js.
export const contractMocks = new Map();

/**
 * Registers fake behavior for `new ethers.Contract(address, abi, runner)`.
 * `methods` maps method names to either a plain value (wrapped in an async fn
 * that resolves to it) or a function (called with the same args the route
 * handler passed, for tests that need per-call logic).
 */
export function mockContract(address, methods) {
  const key = String(address).toLowerCase();
  const fns = {};
  for (const [name, value] of Object.entries(methods)) {
    fns[name] = typeof value === 'function' ? value : async () => value;
  }
  // Agreement.sol's `Extra`-adjacent calls aside, every route that reconnects a
  // contract to a signer (e.g. `forwarder.connect(relayer)`) just needs the same
  // mocked methods available afterward — no separate signer-bound instance.
  fns.connect = () => fns;
  contractMocks.set(key, fns);
  return fns;
}

export function resetContractMocks() {
  contractMocks.clear();
}
