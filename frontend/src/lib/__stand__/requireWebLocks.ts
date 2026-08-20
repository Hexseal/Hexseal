/**
 * requireWebLocks.ts — a loud refusal when the runtime has no Web Locks.
 *
 * WHY THIS FILE EXISTS. A handful of stands in this suite measure the one thing
 * a single-process test normally cannot: two browser tabs contending for one
 * lock. They do it with the REAL `navigator.locks` — process-wide, which is
 * exactly what it is for two tabs of one origin — and deliberately NOT with a
 * fake. A fake lock would make those stands tautological: they would measure
 * the fake's own behaviour instead of the production code's.
 *
 * Node ships `navigator.locks` from v24 on. Node 22 has a `navigator`, but no
 * `.locks` on it at all. Measured, both on this machine:
 *
 *     node v22.23.2 -> typeof globalThis.navigator.locks === 'undefined'
 *     node v24.12.0 -> typeof globalThis.navigator.locks === 'object'
 *
 * On node 22 the production code degrades gracefully on purpose (see
 * `presentationDraft.ts`: `if (!locks) return bounded()`), so nothing throws.
 * The stands simply stop measuring a lock and start measuring its absence, and
 * they say so with a scatter of `expected 1 to be 2` diffs that name no cause.
 * That is precisely what happened in CI between 15 and 20 August 2026:
 * eighteen red runs, thirteen meaningless assertion diffs, and a whole separate
 * work item spent finding out why. The runtime gap was invisible because
 * nothing in the repository stated which node these stands need.
 *
 * So: no fake, and no silent degradation either. A stand that needs Web Locks
 * says so by name, once, and names the runtime it actually got.
 *
 * The version itself is pinned in `frontend/.nvmrc` (24) and read straight from
 * that file by the `Frontend tests` step in `.github/workflows/ci.yml`, so the
 * local runtime and CI cannot drift apart again without the file changing.
 *
 * ⚠️ `vitest` IS NOT IMPORTED HERE, for the same reason and by the same
 * workaround as in `chatStand.ts`, `fakeChatDisk.ts` and `presentationStand.ts`:
 * the package lives in `../relayer/node_modules` and `npm run type-check`
 * cannot resolve it from `frontend/`. This module only throws — it needs no
 * runner, and stays out of the runner's way.
 */

/** How the runtime names itself, for the message. Node in tests — but this
 *  must not be assumed: a browser has no `process` at all. */
function runtimeName(): string {
  const proc = (globalThis as { process?: { version?: unknown } }).process;
  return typeof proc?.version === 'string' ? `node ${proc.version}` : 'this runtime';
}

/**
 * Throw unless the runtime provides a usable `navigator.locks`.
 *
 * Call it at MODULE level in a stand that needs it, not inside a test: the
 * throw then lands during collection, so the file fails once, before any test
 * has had the chance to report a misleading assertion instead.
 *
 * @param standName what to blame in the message — the stand's own name.
 */
export function requireWebLocks(standName: string): void {
  const nav = (globalThis as { navigator?: { locks?: { request?: unknown } } }).navigator;

  // Checked by USE, not by presence: `navigator.locks` could exist as some
  // half-shim without a callable `request`, and this stand would then fail
  // later and vaguely again — the exact outcome this guard exists to prevent.
  if (typeof nav?.locks?.request === 'function') return;

  const found =
    nav === undefined ? 'no `navigator` on globalThis'
    : nav.locks === undefined ? '`navigator` exists, but `navigator.locks` is undefined'
    : '`navigator.locks` exists, but `.request` is not callable';

  throw new Error(
    `${standName} needs the Web Locks API, and ${runtimeName()} does not provide it.\n` +
    `\n` +
    `  found     ${found}\n` +
    `  required  node >= 24 (pinned in frontend/.nvmrc; node 22 has no navigator.locks)\n` +
    `\n` +
    `This stand measures two browser tabs contending for one lock, using the real\n` +
    `process-wide navigator.locks. No fake is installed instead, on purpose: a fake\n` +
    `lock would measure itself rather than the production code.\n` +
    `\n` +
    `Without Web Locks the production code degrades gracefully and this stand would\n` +
    `report a handful of unrelated-looking assertion diffs instead of this message.\n` +
    `\n` +
    `Fix: run \`nvm use\` inside frontend/ (installing it first if needed: \`nvm install 24\`),\n` +
    `then re-run \`npm test\`.`,
  );
}
