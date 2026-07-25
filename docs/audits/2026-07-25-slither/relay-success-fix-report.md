# Relay success-reporting fix + hardcoded-address removal — 2026-07-25

Branch: `fix/relay-success-and-config`
Commits:
- `f7e83e4` — `fix(relayer): stop reporting success when the forwarded call actually failed`
- `3cc8e9b` — `fix(frontend): remove hardcoded contract-address fallbacks in config`

No contracts changed. No deploy, restart, or on-chain transaction was performed as part of this work.

---

## Fix 1 — relayer no longer reports success for a failed inner call

### What changed

`relayer/app.js`:

1. **Added the missing event to `FORWARDER_ABI`** (it previously declared only `getNonce`, `verify`, `execute` — no event at all, so the relayer had no way to see `execute()`'s own success flag):
   ```js
   'event Executed(address indexed from, address indexed to, bool success)',
   ```
   Also added a standalone `FORWARDER_INTERFACE = new ethers.Interface(FORWARDER_ABI)` for log parsing (kept independent of the `forwarder` Contract instance so it works whether that instance is real or, under test, replaced by the test suite's ethers mock — that mock never fakes `.interface`).

2. **Simulate before sending.** `POST /relay` now calls `forwarderAsRelayer.execute.staticCall(forwardReq, signature, gasOverride)` before broadcasting. If the simulated inner call would fail (`success === false`), the route returns `400` with a decoded reason and never sends the transaction — no gas spent on a doomed call.

3. **Re-verify after mining.** Because a passing simulation doesn't guarantee the real broadcast still succeeds (state can change in between), the route now parses `receipt.logs` for the forwarder's own `Executed(from, to, success)` log after `tx.wait()` and treats `success === false` there as a failure too — returning `400` instead of `{success: true}`.

4. **`pushAfterRelay(...)` is now only called on the final success path** — after both the simulation and the mined-receipt check pass. It is never called when either check finds a failure.

5. **Revert-reason decoding**: added `FORWARDER_CUSTOM_ERRORS` (the same selector → name table as `frontend/src/app/api/relay/route.ts`'s `CUSTOM_ERRORS`) plus a standard `Error(string)` decode via `ethers.AbiCoder.defaultAbiCoder().decode(['string'], ...)`, wired through a small `decodeForwarderRevert(retdata)` helper. **This table is duplicated, not shared**, on purpose: `relayer/` is a plain Node ESM service with no build step, and `route.ts` is compiled by Next.js — sharing one module across the two apps would mean standing up a small internal package neither currently has, just to hold one lookup table. A comment in `app.js` points at `route.ts` and says to keep the two in sync.

### The code path (relayer/app.js, `POST /relay`)

```js
const forwarderAsRelayer = forwarder.connect(relayer);
const gasOverride = { gasLimit: BigInt(gas) + 60_000n };

// ── Simulate execute() to catch silent inner-call failures ────────────────
let simSuccess, simRetdata;
try {
  [simSuccess, simRetdata] = await forwarderAsRelayer.execute.staticCall(forwardReq, signature, gasOverride);
} catch (err) {
  return res.status(400).json({ error: `Simulation failed: ${err.message}` });
}
if (!simSuccess) {
  const { reason, selector } = decodeForwarderRevert(simRetdata);
  return res.status(400).json({ error: `Call failed: ${reason}`, errorCode: selector });
}

const tx = await forwarderAsRelayer.execute(forwardReq, signature, gasOverride);
const receipt = await tx.wait();
if (receipt.status === 0) return res.status(400).json({ error: 'Transaction reverted on-chain' });

// ── Re-verify after mining ─────────────────────────────────────────────────
let minedSuccess = true; // no matching log found is unexpected, not a signal — fail open, not closed
for (const log of receipt.logs ?? []) {
  if (log.address?.toLowerCase() !== FORWARDER_ADDR.toLowerCase()) continue;
  try {
    const parsed = FORWARDER_INTERFACE.parseLog(log);
    if (parsed?.name === 'Executed') { minedSuccess = parsed.args.success; break; }
  } catch { /* not a log this ABI recognizes */ }
}
if (!minedSuccess) {
  return res.status(400).json({ error: 'Transaction mined but the inner call failed (state changed after simulation)' });
}

res.json({ success: true, txHash: receipt.hash, blockNumber: receipt.blockNumber });
pushAfterRelay(receipt, forwardReq.to, data);
```

### Same blind spot elsewhere?

- `relayer/notifier.js` — grepped for `forwarder`/`execute`/`Executed`: **no matches at all**. This file never touches `MinimalForwarder.execute()`, so it isn't affected.
- Every other route in `relayer/app.js` — grepped for `.execute(` across `relayer/*.js`: the only call site was the one fixed above.
- **New finding, not fixed (out of scope for this task):** `frontend/src/app/api/relay/route.ts` already does the pre-send `simulateContract` half of this fix (lines ~360-462), but its post-mine check (lines ~497-504) only inspects `receipt.status === 'reverted'` — it never parses the forwarder's `Executed` event on the mined receipt. So it has the same "simulation passed, state changed before the real broadcast" gap that this task's point 2 exists to close in the relayer. The task scoped implementation to `relayer/app.js` only (`route.ts` was reference material for the selector table and simulate-before-send pattern), so I did not change `route.ts` — flagging it here since it's a real, symmetrical gap in the other relay path.

### How verified

- `node --check relayer/app.js` → exits 0 (syntax valid, including the new ABI entry and Interface usage).
- A bare `node -e "require('./relayer/app.js')"` was tried and abandoned: this module is ESM (`"type": "module"`), and — more importantly — importing it directly starts real timers (`setInterval` for rate-limit cleanup) that keep the process alive indefinitely and would load real `.env.relayer` credentials against the real RPC. That's a worse verification path than the actual test suite, which imports and exercises the same module under mocks.
- Ran the relayer's Vitest suite (`npm test` in `relayer/`): **83 tests passed across 10 files**, including 9 in `relayer/test/relay.test.js` (up from 5) covering:
  - simulation rejects a would-fail call without ever broadcasting (asserts the mock `execute` fn was never invoked)
  - simulation itself throwing → 400 `Simulation failed: ...`
  - simulation passes, mined receipt's real `Executed(..., false)` log still causes a 400 (the "state changed in between" case)
  - the original happy-path / outer-revert / invalid-signature cases, updated to the new staticCall-then-mine shape

  Output:
  ```
   ✓ test/harness.test.js (6 tests) 7ms
   ✓ test/helpers.test.js (19 tests) 21ms
   ✓ test/health.test.js (1 test) 21ms
   ✓ test/misc.test.js (3 tests) 28ms
   ✓ test/relay.test.js (9 tests) 101ms
   ✓ test/cleanup.test.js (5 tests) 49ms
   ✓ test/profileUpload.test.js (7 tests) 186ms
   ✓ test/disputeReasonAndLog.test.js (7 tests) 173ms
   ✓ test/fileStorage.test.js (14 tests) 163ms
   ✓ test/push.test.js (12 tests) 236ms

   Test Files  10 passed (10)
        Tests  83 passed (83)
  ```

  Note: the pre-existing test mock harness (`relayer/test/mocks/ethersRegistry.js`) hands back plain functions for mocked contract methods, which don't carry the `.staticCall` sub-function real ethers `Contract` methods have. `relay.test.js` was updated to attach `.staticCall` directly onto each mocked `execute` function (`fn.staticCall = async () => [...]`) — this required editing the test file, not the shared mock harness, so no other test file needed changes.

---

## Fix 2 — removed hardcoded contract-address fallbacks

### What changed

`frontend/src/config/contracts.ts`: `diamond`, `forwarder`, and `usdc` previously did:
```ts
diamond: (process.env.NEXT_PUBLIC_DIAMOND_ADDRESS || '0x760F0736...') as `0x${string}`,
```
Replaced with a `requiredAddress(value, label)` helper that throws at module load if the value is missing:
```ts
function requiredAddress(value: string | undefined, label: string): `0x${string}` {
  if (!value) {
    throw new Error(
      `${label} is not set. This must come from the environment (see .env.vps.example) — ` +
      `there is no hardcoded fallback on purpose, since a stale one previously masked a ` +
      `real contract-address change.`
    );
  }
  return value as `0x${string}`;
}

export const CONTRACTS = {
  diamond:   requiredAddress(process.env.NEXT_PUBLIC_DIAMOND_ADDRESS,   'NEXT_PUBLIC_DIAMOND_ADDRESS'),
  forwarder: requiredAddress(process.env.NEXT_PUBLIC_FORWARDER_ADDRESS, 'NEXT_PUBLIC_FORWARDER_ADDRESS'),
  usdc:      requiredAddress(process.env.NEXT_PUBLIC_USDC_ADDRESS,      'NEXT_PUBLIC_USDC_ADDRESS'),
  jobReceipt: (process.env.NEXT_PUBLIC_JOB_RECEIPT_ADDRESS || '0x0000000000000000000000000000000000000000') as `0x${string}`,
} as const;
```
Each `process.env.NEXT_PUBLIC_*` reference stays as a literal dot-notation expression passed as an argument (not funneled through a dynamic `process.env[key]` lookup inside the helper) — Next.js's build-time inlining only recognizes the literal `process.env.NEXT_PUBLIC_X` form, so the helper only receives the already-resolved value, never the variable name.

There was no pre-existing "required config" pattern anywhere in `frontend/src/config/` or `frontend/src/lib/` to follow (checked `chain.ts`, which uses soft `??` fallbacks for RPC URLs — a materially different case: a fallback public RPC endpoint can't silently point at the wrong *contract*, so a hard requirement there isn't warranted and was left alone). The `requiredAddress` shape mirrors the existing pattern already used in `relayer/app.js` for its own required env vars (e.g. `if (!FORWARDER_ADDR) throw new Error('TRUSTED_FORWARDER is not set')`), which is the closest established convention in this codebase for exactly this situation.

**Judgment call — `jobReceipt` was intentionally NOT converted to `requiredAddress`.** It has the same `||` fallback shape the task asked me to normalize, but:
- `grep -rn "CONTRACTS.jobReceipt\|JOB_RECEIPT_NFT_ABI" frontend/src` → zero matches outside `contracts.ts` itself. Nothing in the app reads this value or the ABI beside it.
- No `.env` file (`frontend/.env.local`, `frontend/.env.example`, `.env.vps.example`) sets `NEXT_PUBLIC_JOB_RECEIPT_ADDRESS` to anything — `.env.vps.example` even lists the key with an empty value.
- Per `CLAUDE.md` and this session's own architecture notes, `JobReceiptFacet` is a Diamond facet reached through `CONTRACTS.diamond`, not a standalone `PlatformReceiptNFT` contract — this field and its ABI comment ("standalone contract, не Diamond facet") describe a superseded design.

Making this one throw would break `next build` for a field nothing depends on and that has no correct value to set it to. I left it as a soft zero-address fallback and added a comment explaining why, rather than silently applying the letter of the instruction over its evident intent (killing address-drift risk for live, meaningful contract addresses). Flagging this explicitly in case the architect wants it removed entirely instead.

### Build verification

`cd frontend && npm run build` (this project's actual build script — `npx next build` failed first with `sh: next: not found` because there's no `node_modules/.bin/next` symlink; `package.json`'s `build` script correctly calls `node node_modules/next/dist/bin/next build` directly, which works):

**Pass, with all three vars set (current `frontend/.env.local`):**
```
 ✓ Compiled successfully in 34.2s
   Skipping linting
   Checking validity of types ...
   Collecting page data ...
 ✓ Generating static pages (28/28)
   Finalizing page optimization ...
   Collecting build traces ...
Route (app) ... [28 routes listed]
```
Exit code 0.

### Negative test — missing env var fails the build immediately

Removed `NEXT_PUBLIC_DIAMOND_ADDRESS` from `frontend/.env.local` (backed up first), cleared `.next/`, reran `npm run build`:

```
Error: NEXT_PUBLIC_DIAMOND_ADDRESS is not set. This must come from the environment (see .env.vps.example) — there is no hardcoded fallback on purpose, since a stale one previously masked a real contract-address change.
    at eH (.next/server/app/api/relay/route.js:24:31910)
    ...
> Build error occurred
[Error: Failed to collect page data for /api/relay] { type: 'Error' }
```
Exit code 1 (`PIPESTATUS[0]` = 1). The failure surfaces during `next build`'s page-data collection — before any user ever hits the app — exactly as required.

Restored `NEXT_PUBLIC_DIAMOND_ADDRESS`, cleared `.next/`, reran `npm run build`: passed again, exit 0, identical route list to the first run.

`frontend/.env.local` and `.next/` are both git-ignored (confirmed via `git check-ignore -v`); no changes to either were left staged or committed.

---

## Summary of what could not be verified (fixes 1 and 2)

- The relayer's `/relay` endpoint was never exercised against a real chain — verification is via the Vitest suite's mocked `ethers.Contract`, not a live Base Sepolia transaction, per the task's "do not send any transaction" constraint. The mocked `Executed` logs are built with a real `ethers.Interface.encodeEventLog`/`.parseLog` round-trip (not hand-written topic strings), so the parsing logic itself is exercised faithfully; what isn't verified is the real `MinimalForwarder` contract's actual on-chain log shape at the new addresses, which I did not query (no RPC calls were made).
- `relayer/index.js`, `relayer/e2e.mjs` were not modified or re-run; `index.js` only re-exports/bootstraps `app.js` per the existing refactor and has no `/relay`-related logic of its own to check. `e2e.mjs` looked like a live-network script (not part of the Vitest suite) and was left untouched.

---

## Fix 3 — closed the same gap in `frontend/src/app/api/relay/route.ts` (follow-up)

Commit: `d739afc` — `fix(frontend): re-verify the forwarder's Executed event after mining in /api/relay`

`route.ts` already did the pre-send `simulateContract()` half of this fix (that's what Fix 1 above was built from as a reference), but its post-mine check only looked at `receipt.status === 'reverted'` — the outer tx status — never the forwarder's own `Executed` log. That is the exact same gap `relayer/app.js` had before Fix 1, in the mirror path, and leaving it open meant the two relay paths could now disagree about whether an identical on-chain outcome was a success.

### What changed

1. Added the same event to this file's `FORWARDER_ABI` (`parseAbi`, viem, not ethers — same fragment, different ABI-building call):
   ```ts
   'event Executed(address indexed from, address indexed to, bool success)',
   ```
2. After `const { receipt, txHash } = relayResult;` (right after `waitForTransactionReceipt()`, before event-log parsing and before the on-chain push-notify call), added a loop over `receipt.logs` filtered by `effectiveForwarder`, decoding each with viem's `decodeEventLog({ abi: FORWARDER_ABI, data, topics })` and reading `Executed`'s `success` field. `success === false` returns `NextResponse.json({ error: ... }, { status: 400 })` instead of the `{success: true}` shape — same verdict-producing condition as `relayer/app.js`'s Fix 1, just expressed in viem instead of ethers (`decodeEventLog` vs. `Interface.parseLog`).
3. **Reason decoding — could not be done, and I said so in the code and here rather than faking it.** The task asked me to decode the reason using the CUSTOM_ERRORS table already in this file. That table decodes `retdata` — the revert bytes `execute()` returns from its pre-send `staticCall`/`simulateContract`. The `Executed` event carries only `(address from, address to, bool success)` — no revert bytes at all — so there is nothing for the table to decode against at this point. I considered re-simulating the same call once the failure is detected to recover `retdata` for cosmetic purposes, but rejected it: the forwarder consumes the request's nonce inside `execute()` regardless of the inner call's outcome (that's the entire premise of this bug), so by the time we're inspecting the mined receipt, that nonce is already spent on-chain. Re-running `execute()` with the identical `forwardReq` would now fail at the forwarder's own nonce/signature check, producing a *different*, misleading revert reason — not the original one. The response is explicit about this instead: `"Transaction mined but the inner call failed (state changed after simulation) — no revert reason available"`. This exact same limitation applies to `relayer/app.js`'s Fix 1 mined-check, which uses an equivalently generic message for the same reason (see the Fix 1 code path above — it never attempted reason decoding for the post-mine case either, for the same underlying cause).
4. **Push suppression**: confirmed via a full read of the route that the only "push notification on success" call is the `fetch(`${relayerInternal}/relay/notify`, ...)` block further down the same function. Because the new failure check `return`s before that block is ever reached (it sits between obtaining the receipt and the event-log-parsing/push section), the push is structurally unreachable on a mined-but-failed inner call — no separate suppression flag was needed.

### How the two paths now agree

Both `relayer/app.js`'s `/relay` and `frontend/src/app/api/relay/route.ts`'s `POST` now: (a) simulate `execute()` before broadcasting and reject with a decoded reason on a predicted failure; (b) after `tx.wait()`/`waitForTransactionReceipt()`, parse the forwarder's own `Executed` log filtered by the forwarder address actually used for that call, and treat `success === false` there as a failure — a 400 with no `success: true` in the body, and no push notification — even though the outer receipt itself reads as mined/non-reverted. Same condition, same verdict, on both paths; the code differs only because one is ethers (`Interface.parseLog`) and the other is viem (`decodeEventLog`).

### Caller impact — checked, no double-handling

Read `frontend/src/lib/relay.ts` in full for every call site of `fetch('/api/relay', ...)`. Every one of them does exactly:
```ts
if (!res.ok) throw new Error(json.error || `Relay error ${res.status}`);
```
and nothing else branches on the response shape beyond that. The only thing that changes caller-visible behavior for an *existing* failure category is `isRelayDown(err)`:
```ts
function isRelayDown(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return msg.toLowerCase().includes('failed to fetch') || /relay error 5\d\d/i.test(msg);
}
```
It only fires on a network-level "failed to fetch" or a `5xx` status. The new failure returns **400** with a specific `error` message — it does not match either `isRelayDown()` condition, so it is thrown and surfaces as a normal error exactly like the pre-existing pre-send-simulation-failure 400 already does. Concretely: it does **not** trigger the direct-wallet-tx fallback path (`walletClient.writeContract` after `isRelayDown()` returns true), so there's no risk of the fallback re-submitting an already-failed, already-nonce-consumed action and charging the user gas for a second doomed attempt. No caller independently re-fetches or re-parses the receipt on the success path either (the only other `waitForTransactionReceipt` calls in `relay.ts` are inside the *fallback* path and in the unrelated `approveUSDC()` direct-tx helper), so nothing double-handles this new failure mode — callers get one clear thrown `Error`, same as before, just now correctly thrown in a case that used to silently report success.

### Build verification

`cd frontend && npm run build` (project's build script) after this change, with `frontend/.env.local` unmodified:
```
 ✓ Compiled successfully in 35.4s
   Skipping linting
   Checking validity of types ...
   Collecting page data ...
 ✓ Generating static pages (28/28)
   Finalizing page optimization ...
   Collecting build traces ...
Route (app) ... [28 routes listed, /api/relay present at 166 B / 105 kB First Load JS]
```
Exit code 0 — type-checks cleanly, including `decodeEventLog`'s discriminated-union narrowing (`decoded.eventName === 'Executed'` before reading `decoded.args.success`).

No automated tests exist for this route or anywhere in `frontend/` (`grep` for `*.test.ts(x)`/`*.spec.ts` under `frontend/` — excluding `node_modules` — returns nothing, and `frontend/package.json` has no `test` script), so the build itself is the only available verification, per the task's own instruction to run "whatever tests cover that route if any exist."

### What could not be verified (fix 3)

- Same constraint as fixes 1-2: no real transaction was sent, so the real `MinimalForwarder`'s `Executed` log shape at the live forwarder address (`0x268dCfa7ab0DC134d01C5cBcAa7d2834d6dD0f0f`) was not observed directly — the ABI fragment is taken from the task's own description and matches `relayer/app.js`'s identical addition byte-for-byte.
- No test exercises the new branch directly (none exist for this route at all); confidence here rests on the build's type-check passing and the logic being structurally identical to the already-tested `relayer/app.js` path, not on a runtime assertion against this specific file.
