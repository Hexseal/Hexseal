# DeployFull.s.sol regeneration report — 2026-07-25

Branch: `deploy/regenerate-deployfull`

## Summary

`script/DeployFull.s.sol` was a June-2026 snapshot, ~40 upgrade scripts stale
relative to the live Base Sepolia diamond. It has been fully regenerated from
current ABIs (`forge inspect <Facet> methodIdentifiers`), and a permanent
drift test (`test/DeployFullSelectors.t.sol`) has been added so this cannot
happen silently again.

All 145 live selectors across 11 facets now mount, with zero phantoms. The
build is clean, all 277 pre-existing tests plus 15 new ones pass (292 total),
and a real `forge script` dry run against Base Sepolia simulates end to end.

**Fix round 1 (same date, below):** an independent review confirmed the
selector work but found six further issues, one deploy-blocking (a fresh
diamond would have had zero arbiters and no way to ever add one) and one in
this report itself (a false claim about the drift test's discrimination
power). All six are fixed; see "Fix round 1 — 2026-07-25" near the end of
this document for the full account, including the correction to this
document's own earlier drift-test claim.

## Per-facet selector counts, before → after

| Facet | Before (mounted) | After (mounted) | Live ABI (ground truth) | Notes |
|---|---:|---:|---:|---|
| DiamondCutFacet | 1 | 1 | 1 | unchanged |
| DiamondLoupeFacet | 5 | 5 | 5 | unchanged (supportsInterface correctly routed here, not JobReceiptFacet — confirmed deliberate divergence from live, left as-is) |
| OwnershipFacet | 4 | 4 | 4 | unchanged |
| RegistryFacet | 13 | 13 | 13 | unchanged |
| FactoryFacet | 18 (12 real + 6 phantom) | 13 | 13 | 6 phantom raw-`bytes4` selectors removed (`setPaused`, `isPaused`, `getProtocolArbiter`, `setProtocolArbiter`, `getArbitrationThreshold`, `setArbitrationThreshold` — all deleted from source in `a95865d`); `deployAndFund` added |
| JobBoardFacet | 10 | 12 | 12 | added `editJob`, `withdrawApplication` |
| ServiceBoardFacet | 21 | 23 | 23 | added `editService`, `getPendingRequestIdsByClientAndExecutor` |
| ArbiterRegistryFacet | 13 | 44 | 44 | added 31 selectors: DAO mode (`activateDAO`, `applyAsArbiter`, `resignAsArbiter`), verdict flow (`submitVerdict`, `finalizeVerdict`, `overturnVerdict`, `notifyArbiterTimeout`, `freezeVerdict`, `unfreezeVerdict`, `clearStuckVerdict`), appeals (`raiseAppeal`, `voteOnAppeal`, `resolveAppeal`), rewards (`withdrawArbiterReward`, `fundVault`, `setRewardPerDispute`, `setDAOAddress`), and 18 views |
| DealMetadataFacet | 1 | 1 | 1 | unchanged |
| JobReceiptFacet | 18 | 21 | 21 | added `burnJobReceipt`, `isJobReceiptBurned`, `getTokenIdByJobId` |
| ReputationFacet | 0 (facet absent entirely) | 8 | 8 | facet added to imports/deploy/cut: `autoAwardXP`, `claimXP`, `getCleanStreak`, `getUniqueActiveUsers`, `getXP`, `hasClaimed`, `isDealWin`, `notifyExecutorFault` |
| **Total** | **104 mounted (98 real + 6 phantom)** | **145** | **145** | **47 real selectors added, 6 phantoms removed** |

Confirmed: all 145 selectors mount, zero phantoms. Proof is the drift test
(`test/DeployFullSelectors.t.sol`), not manual inspection — see below.

## Array length / index audit

Every `<facet>Selectors()` function was checked programmatically: declared
array length vs. number of `sels[i] = ...` assignments, and that assigned
indices are contiguous from 0 with no gaps or duplicates.

```
cutFacetSelectors                declared=  1 assignments=  1 contiguous_from_0=True OK=True
loupeFacetSelectors              declared=  5 assignments=  5 contiguous_from_0=True OK=True
ownershipFacetSelectors          declared=  4 assignments=  4 contiguous_from_0=True OK=True
registryFacetSelectors           declared= 13 assignments= 13 contiguous_from_0=True OK=True
factoryFacetSelectors            declared= 13 assignments= 13 contiguous_from_0=True OK=True
jobBoardFacetSelectors           declared= 12 assignments= 12 contiguous_from_0=True OK=True
serviceBoardFacetSelectors       declared= 23 assignments= 23 contiguous_from_0=True OK=True
arbiterRegistryFacetSelectors    declared= 44 assignments= 44 contiguous_from_0=True OK=True
dealMetadataFacetSelectors       declared=  1 assignments=  1 contiguous_from_0=True OK=True
jobReceiptFacetSelectors         declared= 21 assignments= 21 contiguous_from_0=True OK=True
reputationFacetSelectors         declared=  8 assignments=  8 contiguous_from_0=True OK=True
```

Sum: 1+5+4+13+13+12+23+44+1+21+8 = **145**.

Raw `bytes4(0x...)` literals remain in exactly two places, both required
because the function name is overloaded within `JobReceiptFacet` (Solidity
cannot resolve `.selector` on an ambiguous name):

```
sels[6] = bytes4(0x42842e0e); // safeTransferFrom(address,address,uint256) — overload, .selector ambiguous
sels[7] = bytes4(0xb88d4fde); // safeTransferFrom(address,address,uint256,bytes) — overload, .selector ambiguous
```

`transferFrom` in `JobReceiptFacet` is *not* overloaded (only one signature
exists in that contract), so it was converted from the old raw literal
(`bytes4(0x23b872dd)`) to `JobReceiptFacet.transferFrom.selector` — the
compiler now catches it if that function is ever renamed or removed. Every
other selector in the file uses a `Facet.function.selector` expression.

## Other changes made per the task brief

- **Zero-forwarder fail-fast**: `run()` now `require`s `trustedForwarder !=
  address(0)` immediately after reading env vars, before `vm.startBroadcast`.
  Previously the same zero-forwarder condition was only caught inside
  `initFactory()`, after 11 implementation deploys + the Diamond itself had
  already been broadcast.
- **Region fees 4/5/6**: `initFactory()` only seeds regions 0–3. Added
  `setRegionFee(4, 4_000_000)` (LATAM), `setRegionFee(5, 10_000_000)` (CA),
  `setRegionFee(6, 7_000_000)` (AU) after the cuts, matching the live values
  given in the task brief and confirmed against `UpgradeRegions7.s.sol` /
  `UpgradeRegionAU.s.sol`, which set these same three values on the live
  diamond. All seven fees are now printed in the final deploy summary for
  operator verification.
- **Header comment**: rewritten to describe the ERC-7201 namespaced-slot
  scheme (matching every facet's actual storage library), replacing the
  stale pre-ERC-7201 `keccak256("hexseal.X.storage")` description, and to
  point at the new drift test.
- **`rewardPerDispute` left at 0** (unset) — per the brief, the flat-reward
  model is being replaced per
  `docs/superpowers/specs/2026-07-22-arbiter-economics-design.md` §3; `
  setRewardPerDispute` / `fundVault` are deliberately not called.
- **No changes** to `foundry.toml`, pragmas, or dependencies. Script's overall
  shape (deploy → initCuts → Diamond → AgreementDeployer → initRegistry/
  initFactory → remaining cuts → link SVGRenderer) is unchanged; only the
  selector-array construction was refactored into named `public pure`
  functions (see below) and the region-fee/fail-fast additions were made.

## Drift test design

**File**: `test/DeployFullSelectors.t.sol` (15 tests).

**Approach taken: the "Preferred" shape from the brief.** `DeployFull.s.sol`
was refactored so every facet's selector array is built by its own
`public pure` function (e.g. `factoryFacetSelectors()`,
`arbiterRegistryFacetSelectors()`, ...), and the two `FacetCut[]` arrays
`run()` actually broadcasts are built by `buildInitCuts(...)` and
`buildRemainingCuts(...)`, which call those same per-facet functions — one
source of truth, not a copy the test could drift from independently.

The test:

1. Instantiates `DeployFull` (no env vars needed — the functions under test
   are `pure` and take facet addresses as plain parameters, so no real
   facets need to be deployed; placeholder addresses `0x1001`..`0x100B` are
   used only to prove the `FacetCut.facetAddress` wiring, not to exercise
   real bytecode).
2. For each of the 11 facets, enumerates the expected selector set via
   `<Facet>.<fn>.selector` (compiler-checked — this is the same mechanism
   `forge inspect methodIdentifiers` reports on) and asserts set-equality
   against the script's `<facet>Selectors()` output, via a helper
   (`_assertSameSelectorSet`) that:
   - asserts equal length first (this alone catches a declared-length vs.
     assignment-count mismatch, since an unassigned trailing slot stays
     `bytes4(0)` and either shows up as a bogus extra element or a length
     mismatch against `expected`),
   - asserts every actual selector exists in `expected` (phantom check),
   - asserts every expected selector exists in `actual` (undercut/missing
     check) — this pair together also rejects a duplicate masking a missing
     entry, which a naive "same length + all actual found in expected"
     check alone would miss.
3. ~~`testTotalMountedSelectorCountIs145`~~ — **correction (2026-07-25, fix
   round 1): this paragraph, as originally written, was wrong.** It claimed
   the hardcoded `145` was "the only assertion in the file that is NOT
   derived from the script itself" and was therefore the one thing that
   could catch a facet gaining a function that nobody wires anywhere. That
   claim does not hold: the value compared against `145` was the *sum of
   `deploy.*Selectors()`* — i.e. the script's own output. If a facet gains a
   function and neither the script nor this test file is touched, the
   per-facet arrays don't change, their sum stays 145, and the assertion
   keeps passing. This was verified directly: a real external function was
   added to `ReputationFacet` (ABI 8 → 9) and every one of the 15 tests in
   this file — including `testTotalMountedSelectorCountIs145` — still
   passed. That is exactly the "test that cannot fail" failure mode this
   whole file exists to avoid, and it went undetected until an independent
   review re-derived ground truth from the compiled ABI instead of trusting
   this document. The fix (full detail in "Fix round 1" below) removed both
   the hand-typed `expected` arrays throughout this file and this
   hardcoded-total test, and replaced them with selectors read directly out
   of the compiled artifact (`out/<Facet>.sol/<Facet>.json`'s
   `methodIdentifiers` map) — ground truth that cannot go stale independently
   of the facet it describes, because it is regenerated by every
   `forge build`.
4. `testNoSelectorCollisionsAcrossFacets` — flattens all 11 arrays and
   asserts pairwise selector uniqueness across facets (O(n²) over 145
   elements, cheap). Not required by the brief but genuinely load-bearing:
   a Diamond can only route one selector to one facet address, so a
   collision here is a real deploy-time bug (`Diamond: selector exists`
   revert), not a style nit.
5. `testBuildInitCutsMatchesIndividualSelectors` /
   `testBuildRemainingCutsMatchesIndividualSelectors` — call the actual
   `buildInitCuts` / `buildRemainingCuts` functions `run()` uses, and check
   both that each `FacetCut.facetAddress` matches the address it was passed
   and that its `functionSelectors` matches the corresponding per-facet
   selector function's output, plus that every action is `Add`. This closes
   a gap the per-facet selector tests alone can't see: a mixup where e.g.
   `ArbiterRegistryFacet`'s selectors are accidentally wired to the
   `JobBoardFacet` address in the `FacetCut[]` construction would not change
   any individual selector set, but would break the deploy — this test
   would catch it via the address assertions and the array-length asserts on
   `initCuts`/`cuts2` themselves.

**Why this shape over the shell-script alternative**: the repo already has
`script/check-storage-layout.sh` (slither-based, CI-wired) as a precedent for
external-tool gates, but it requires slither to be installed and its output
format to remain stable — its own comments document two non-zero "couldn't
verify" exit codes for exactly that fragility. A `forge test` gate has no
such external dependency, runs in the same `forge test` invocation as
everything else (so it can't be silently skipped from CI the way a separate
shell script could), and — critically — can directly reuse the compiler's own
name resolution (`Facet.fn.selector`) as its ground truth, rather than
re-parsing `forge inspect` JSON or grepping the script's source text. The
brief's "alternative" shape would still need to parse the deploy script's
`bytes4[]` literals out of source with regex/awk, which is exactly the kind
of parsing that can silently stop matching after a refactor — the same
class of bug this test exists to prevent.

### Proof the test discriminates (both directions) — historical, superseded

> **This subsection describes the original (flawed) design and its proof.**
> The proof below is real and the failure modes it demonstrates (script
> undercuts / phantom-mounts relative to a fixed expected set) are genuine —
> but it only ever exercised the "script drifts, ABI stays put" direction.
> It never tested the direction that actually caused the original 40-upgrade
> drift: a facet's ABI gaining a function that nobody updates the script (or
> the test) to expect. See "Fix round 1" below for the corrected design and
> the proof that covers both directions properly.

Per the brief's requirement ("a test that cannot fail is worse than none"),
one selector was deliberately removed from the script and the test was run
before being restored.

**Break**: `reputationFacetSelectors()` edited to drop
`ReputationFacet.isDealWin.selector` and shrink the declared array length
from 8 to 7:

```
Ran 15 tests for test/DeployFullSelectors.t.sol:DeployFullSelectorsTest
[PASS] testArbiterRegistryFacetSelectors() (gas: 583007)
[PASS] testBuildInitCutsMatchesIndividualSelectors() (gas: 187208)
[PASS] testBuildRemainingCutsMatchesIndividualSelectors() (gas: 1034230)
[PASS] testDealMetadataFacetSelectors() (gas: 8415)
[PASS] testDiamondCutFacetSelectors() (gas: 8797)
[PASS] testDiamondLoupeFacetSelectors() (gas: 20293)
[PASS] testFactoryFacetSelectors() (gas: 69650)
[PASS] testJobBoardFacetSelectors() (gas: 61523)
[PASS] testJobReceiptFacetSelectors() (gas: 153131)
[FAIL: flattened selector count drifted from 145: 144 != 145] testNoSelectorCollisionsAcrossFacets() (gas: 129445)
[PASS] testOwnershipFacetSelectors() (gas: 16563)
[PASS] testRegistryFacetSelectors() (gas: 69474)
[FAIL: ReputationFacet: selector count mismatch: 7 != 8] testReputationFacetSelectors() (gas: 12829)
[PASS] testServiceBoardFacetSelectors() (gas: 179334)
[FAIL: total mounted selector count drifted from 145 - a facet gained/lost a function: 144 != 145] testTotalMountedSelectorCountIs145() (gas: 67627)
Suite result: FAILED. 12 passed; 3 failed; 0 skipped; finished in 14.81ms
```

Three independent tests fail for three independent reasons (per-facet set
mismatch, total-count drift, and flattened-count drift feeding the collision
check) — not a single brittle assertion.

**Restore**: file reverted to the committed version (`diff` against the
pre-edit copy showed zero differences), then re-run:

```
Ran 15 tests for test/DeployFullSelectors.t.sol:DeployFullSelectorsTest
[PASS] testArbiterRegistryFacetSelectors() (gas: 583007)
[PASS] testBuildInitCutsMatchesIndividualSelectors() (gas: 187208)
[PASS] testBuildRemainingCutsMatchesIndividualSelectors() (gas: 1039861)
[PASS] testDealMetadataFacetSelectors() (gas: 8415)
[PASS] testDiamondCutFacetSelectors() (gas: 8797)
[PASS] testDiamondLoupeFacetSelectors() (gas: 20293)
[PASS] testFactoryFacetSelectors() (gas: 69650)
[PASS] testJobBoardFacetSelectors() (gas: 61523)
[PASS] testJobReceiptFacetSelectors() (gas: 153131)
[PASS] testNoSelectorCollisionsAcrossFacets() (gas: 5847870)
[PASS] testOwnershipFacetSelectors() (gas: 16563)
[PASS] testRegistryFacetSelectors() (gas: 69474)
[PASS] testReputationFacetSelectors() (gas: 34746)
[PASS] testServiceBoardFacetSelectors() (gas: 179334)
[PASS] testTotalMountedSelectorCountIs145() (gas: 64844)
Suite result: ok. 15 passed; 0 failed; 0 skipped; finished in 20.23ms
```

## Verification

**`forge build`**: clean (`Compiler run successful!`, lint warnings only,
same pre-existing style/gas-optimization notes unrelated to this change).

**`forge test`** (full suite):

```
Ran 9 test suites in 95.92ms (276.15ms CPU time): 292 tests passed, 0 failed, 0 skipped (292 total tests)
```

277 pre-existing tests + 15 new `DeployFullSelectors.t.sol` tests = 292, all
passing.

**Dry-run simulation** (`forge script script/DeployFull.s.sol --rpc-url
"$BASE_SEPOLIA_RPC_URL"`, no `--broadcast`), against Base Sepolia with the
current (old) `TRUSTED_FORWARDER` from `.env` — used only to prove the
script executes end to end without reverting; not a real deploy target:

```
Script ran successfully.

== Logs ==
  --- Implementations ---
  DiamondCutFacet:       0x268dCfa7ab0DC134d01C5cBcAa7d2834d6dD0f0f
  ...
  ReputationFacet:       0x90A60B4ae40e98f29DC8917493d12b8797319e0C
  SVGRenderer:           0xCe3Bc88F78B1576576A3196Bcaf09faBA709701f
  --- Diamond ---
  DiamondProxy:          0x548a99A89a218DC681e0bF75A7362eE1c3052bAa
  AgreementDeployer:     0x760F07367888C62f7c2Dfb619A5e534132855ce5

======== HEXSEAL DEPLOYMENT COMPLETE ========
  ...
  --- Region fees (USDC, 6 decimals) ---
    0 CIS:    2000000
    1 Asia:   4000000
    2 EU:     7000000
    3 US:     10000000
    4 LATAM:  4000000
    5 CA:     10000000
    6 AU:     7000000
  =============================================

## Setting up 1 EVM.
Chain 84532
Estimated gas price: 0.011 gwei
Estimated total gas used for script: 41270380
Estimated amount required: 0.00045397418 ETH
SIMULATION COMPLETE. To broadcast these transactions, add --broadcast and wallet configuration(s) to the previous command.
```

Simulated end to end, no reverts, and the region-fee printout matches the
seven-region parity target exactly (`2e6, 4e6, 7e6, 1e7, 4e6, 1e7, 7e6`).
No `--broadcast` was used at any point; nothing was sent on-chain.

## What could not be verified

- The dry run used the **old** `TRUSTED_FORWARDER` (`0x41c66b8...`) from the
  current `.env`, as instructed in the task (a fresh forwarder wasn't
  deployed as part of this task — that's `DeployForwarder.s.sol`, out of
  scope here). This proves the script's control flow and gas cost, not that
  the *eventual* real forwarder address will behave identically (it should,
  since `MinimalForwarder` hasn't changed) — flagged for the person who runs
  the real deploy to re-confirm gas estimates with the final forwarder.
  Fresh redeploy of Base Sepolia itself was explicitly out of scope
  (no `--broadcast` used, per instructions).
- ~~`getAllFees()` return values were only checked via the dry-run console
  output..., adding a full integration test of `DeployFull.run()` itself was
  outside this task's scope...~~ — **closed in Fix round 1** (finding 3):
  `test/DeployFullSelectors.t.sol::testDeployFullBuildsCompleteDiamondWithConsistentRouting`
  now deploys all eleven real facets, builds the diamond through
  `buildInitCuts`/`buildRemainingCuts` exactly as `run()` does, and asserts
  the resulting `DiamondProxy` has exactly 11 facets and 145 consistently
  routed selectors. It does not call `initFactory`/`setRegionFee` (those
  require env-var wiring `run()` handles, not `buildInitCuts`/
  `buildRemainingCuts`), so region-fee correctness is still only checked via
  the dry-run console output plus code review — that residual gap is real
  and is noted again in "Fix round 1" below.

---

## Fix round 1 — 2026-07-25

An independent review verified the selector work three ways (ABI cross-check,
a real-diamond routing probe, cross-contract call resolution) and confirmed it
correct — 145 selectors, all array length/index invariants hold, no phantoms,
no cross-facet collisions. That part is unchanged below. The review raised six
findings, one deploy-blocking. This section documents what changed for each,
in the same order they were raised.

### CRITICAL 1 — fresh diamond had zero arbiters and no way to ever get one

**Problem**: `ArbiterRegistryFacet.applyAsArbiter()` requires `isDaoActive()`
(`daoActiveManual || uniqueActiveUsers >= 100_000`), both false on a fresh
diamond. `addArbiter` is `onlyOwnerOrChief`, and the script never called it.
Result: `commitDisputeClaim`/`claimDispute` would revert `NotArbiter()` for
every address, forever, and `Agreement.triggerArbiterTimeout()` — a 100%
refund to the client after the 4-day window — would be the only way any
dispute could ever resolve. Combined with `raiseDispute()`, that is an
unconditional client-side undo on delivered work, and the deploy would look
completely clean (145/145 selectors, all tests green).

**Fix** (`script/DeployFull.s.sol`):
- New env var `INITIAL_ARBITER`, read alongside the other three, with a
  pre-flight `require` (same section as the forwarder/USDC/fee-recipient
  checks, before `vm.startBroadcast`):
  ```solidity
  require(
      initialArbiter != address(0),
      "DeployFull: INITIAL_ARBITER is zero - a diamond with no arbiter resolves every dispute as a client refund"
  );
  ```
- `ArbiterRegistryFacet(address(diamond)).addArbiter(initialArbiter);` called
  after the region-fee calls, before `vm.stopBroadcast()`. `chiefArbiter` is
  deliberately left unset (zero), matching live.
- Final summary now logs `getArbiters()` (count + each address).

**Verification** — negative (guard fires before any deploy, confirmed via
`-vvvv` trace showing only `VM::envOr`/`VM::envUint`/`VM::addr` calls, zero
facet deployments, before the revert):
```
└─ ← [Revert] DeployFull: INITIAL_ARBITER is zero - a diamond with no arbiter resolves every dispute as a client refund
Error: script failed: DeployFull: INITIAL_ARBITER is zero - a diamond with no arbiter resolves every dispute as a client refund
```
Positive (dry run with `INITIAL_ARBITER=<адрес посаженного арбитра>`,
the same address live's `getArbiters()` returns):
```
  --- Arbiters ---
  Count:          1
    Arbiter:      <адрес посаженного арбитра>
```

### IMPORTANT 2 — drift gate missed the exact failure it was built for

**Problem**: the original `test/DeployFullSelectors.t.sol` hand-typed each
facet's `expected` selector array via `<Facet>.<fn>.selector` and additionally
asserted a hardcoded total of `145`. Both were claimed to guard against "a
facet gains a function and nobody updates either file" — but both are
derived from information a human has to remember to update, same as the
script itself. Verified: added a real function to `ReputationFacet` (ABI 8 →
9) and reran — all 15 tests passed, including the total-count test, because
the hand-typed array and the literal `145` are both static and the sum of
`deploy.*Selectors()` didn't change.

**Fix**:
- `foundry.toml`: added `fs_permissions = [{ access = "read", path = "./out" }]`
  (read-only, scoped to the build output directory) so tests can read
  compiled artifacts.
- `test/DeployFullSelectors.t.sol`: replaced every hand-typed `expected` array
  with ground truth read directly from the compiled artifact:
  ```solidity
  function _abiSelectors(string memory sourceFile, string memory contractName) internal view returns (bytes4[] memory out) {
      string memory json = vm.readFile(string.concat("out/", sourceFile, ".sol/", contractName, ".json"));
      string[] memory sigs = vm.parseJsonKeys(json, ".methodIdentifiers");
      out = new bytes4[](sigs.length);
      for (uint256 i; i < sigs.length; i++) out[i] = bytes4(keccak256(bytes(sigs[i])));
  }
  ```
  Each per-facet test is now `_assertSameSelectorSet(deploy.<facet>Selectors(), _abiSelectors("<Facet>"), "<Facet>")`.
  Note: `DiamondCutFacet`, `DiamondLoupeFacet`, and `OwnershipFacet` are
  defined inside `DiamondProxy.sol`, so their artifact path is
  `out/DiamondProxy.sol/<ContractName>.json` — the two-argument overload
  handles that; the other eight facets are self-named (`out/<Facet>.sol/<Facet>.json`).
  The hand-typed arrays and `testTotalMountedSelectorCountIs145` are gone —
  the file is ~150 lines shorter (net, after also adding the new integration
  test from finding 3) despite testing more.
  `testNoSelectorCollisionsAcrossFacets` was kept but no longer sizes its
  flattened array off a hardcoded `145` — it sums `deploy.*Selectors().length`
  at runtime instead, since its purpose (cross-facet uniqueness) doesn't need
  external ground truth.

**Proof, both directions, repeated for the rewritten gate**:

*Addition* (the exact scenario that slipped through before): added
`function debugDriftProofFunction() external pure returns (uint256) { return 1; }`
to `ReputationFacet.sol`, confirmed via `forge inspect ReputationFacet methodIdentifiers`
that the ABI grew to 9 selectors, then ran the suite:
```
[FAIL: ReputationFacet: selector count mismatch: 8 != 9] testReputationFacetSelectors() (gas: 86828)
Suite result: FAILED. 14 passed; 1 failed; 0 skipped
```
Reverted `ReputationFacet.sol` (`git diff --quiet` confirmed byte-identical to
HEAD), rebuilt, reran:
```
Ran 15 tests for test/DeployFullSelectors.t.sol:DeployFullSelectorsTest
...
[PASS] testReputationFacetSelectors() (gas: 108530)
...
Suite result: ok. 15 passed; 0 failed; 0 skipped
```

*Removal* (re-verified under the new design, since the whole file changed):
shrank `reputationFacetSelectors()` in the script back to 7 entries, dropping
`isDealWin`:
```
[FAIL: diamond should route exactly 145 selectors total: 144 != 145] testDeployFullBuildsCompleteDiamondWithConsistentRouting() (gas: 20739009)
[FAIL: ReputationFacet: selector count mismatch: 7 != 8] testReputationFacetSelectors() (gas: 84074)
Suite result: FAILED. 13 passed; 2 failed; 0 skipped
```
Two independent tests fail now (the per-facet ABI check and the new
full-diamond integration check from finding 3) — restored, rebuilt, reran, 15/15 pass.

### IMPORTANT 3 — no test built the diamond this script actually produces

**Problem**: `CriticalInvariant.t.sol`/`Extras.t.sol`/`AdversarialAccess.t.sol`
each hand-build their own partial cuts for feature testing (e.g. 33 of 44
ArbiterRegistry selectors). None of them, nor anything else in the 292-test
suite, ever constructed the actual diamond `DeployFull.buildInitCuts`/
`buildRemainingCuts` produce.

**Fix**: added
`testDeployFullBuildsCompleteDiamondWithConsistentRouting` to
`test/DeployFullSelectors.t.sol`. It deploys all eleven real facets, builds
the diamond exactly the way `run()` does (`buildInitCuts` → `new DiamondProxy(...)`
→ `buildRemainingCuts` → `diamondCut`), then asserts:
- `facets().length == 11`,
- summing every facet's `functionSelectors.length` gives exactly `145`,
- for every routed selector, `facetAddress(sel)` agrees with the facet
  address `facets()` reported it under (forward direction),
- `facetAddresses()` reports exactly the same 11 addresses `facets()` did
  (reverse direction).

This is the only check in the suite that would catch a selector set wired to
the wrong `FacetCut.facetAddress` — `diamondCut()` itself does not validate
that a facet implements what it's handed.

**Verification**: `[PASS] testDeployFullBuildsCompleteDiamondWithConsistentRouting() (gas: 20793944)`.
Also caught the deliberate removal in finding 2's second proof above
(`144 != 145`), confirming it is load-bearing, not decorative.

### IMPORTANT 4 — `FEE_RECIPIENT` fell back silently to the deployer

**Problem**: `if (feeRecipient == address(0)) feeRecipient = owner;` — on
live these are two different addresses (`getFeeRecipient()` =
отдельный кошелёк сбора комиссий, `owner()` =
`0xC2801Ba1A82D26E742045dF5408C8666d36F8567`). An unset env var would have
silently routed all platform fees to the deployer's hot key.

**Fix**: removed the fallback line entirely; added a `require` in the same
pre-flight block as the others:
```solidity
require(
    feeRecipient != address(0),
    "DeployFull: FEE_RECIPIENT is zero - platform fees would silently route to the deployer key"
);
```

**Verification** (explicit `FEE_RECIPIENT=0x00...00` override — see note
below on why an override rather than unset was needed):
```
└─ ← [Revert] DeployFull: FEE_RECIPIENT is zero - platform fees would silently route to the deployer key
Error: script failed: DeployFull: FEE_RECIPIENT is zero - platform fees would silently route to the deployer key
```

### IMPORTANT 5 — pre-flight checks accepted non-zero-but-nonexistent addresses

**Problem**: a stale or mistyped `TRUSTED_FORWARDER` (or a wrong-chain
`USDC_ADDRESS`, which defaults to a hardcoded Base Sepolia address) would
pass the zero-address check and complete the deploy with gasless silently
mis-wired, or every deal reverting at first `transferFrom`.

**Fix**: added, alongside the zero checks:
```solidity
require(trustedForwarder.code.length > 0, "DeployFull: TRUSTED_FORWARDER has no code on this chain");
require(usdc.code.length > 0, "DeployFull: USDC_ADDRESS has no code on this chain");
```

**Verification** (both, with a well-formed but uninhabited address
`0x00000000000000000000000000000000000000aB`):
```
└─ ← [Revert] DeployFull: TRUSTED_FORWARDER has no code on this chain
Error: script failed: DeployFull: TRUSTED_FORWARDER has no code on this chain
```
```
└─ ← [Revert] DeployFull: USDC_ADDRESS has no code on this chain
Error: script failed: DeployFull: USDC_ADDRESS has no code on this chain
```

**Note on how these were tested**: Foundry's `forge` loads `.env` from the
project root automatically, and already-exported process/shell environment
variables take precedence over it — so passing e.g. `TRUSTED_FORWARDER=<addr>`
as a prefix to the `forge script` command does correctly override the value
`.env` has for the real (still-live) forwarder. Trying to test "the var is
absent" via `env -u FEE_RECIPIENT` does **not** work, though — unsetting it
from the shell's exported env just makes Foundry's own dotenv loader fall
back to filling it from the `.env` file again, since from the subprocess's
point of view the var is now "not set" rather than "set to something." All
four negative proofs above therefore use an explicit override value (zero
address, or a valid-format/no-code address) rather than relying on absence.

### IMPORTANT 6 — SVGRenderer modeled four regions, this deploy declares seven

**Problem**: `_regionLabel`/`_regionFeeRaw` in `src/SVGRenderer.sol` branched
on `r == 0/1/2` and fell everything else through to `"US/CA"` @ `10_000_000`.
Regions 4 (LATAM, $4) and 6 (AU, $7) would render on receipt NFTs as "US/CA"
@ $10 — wrong label, wrong fee shown, even though the actual on-chain fee
(`getAllFees()`) was correct.

**Fix**:
- `src/SVGRenderer.sol`: both functions extended to cover regions 0–6 with
  labels `CIS/ASIA/EUROPE/US/LATAM/CA/AU` and fees `2e6/4e6/7e6/1e7/4e6/1e7/7e6`
  — matching `FactoryFacet.getAllFees()` exactly. Change confined to those
  two functions, as requested.
- `src/FactoryFacet.sol`: added `uint8 constant REGION_AU = 6;` to
  `FactoryStorage` (alongside the existing `REGION_CIS`..`REGION_CA`). This is
  a compile-time constant, not a storage variable — zero storage-layout or
  ABI impact, confirmed by the unchanged selector counts in the full test
  suite below.
- `script/DeployFull.s.sol`: the three `setRegionFee` calls now use
  `FactoryStorage.REGION_LATAM` / `FactoryStorage.REGION_CA` /
  `FactoryStorage.REGION_AU` instead of bare literals `4`/`5`/`6`, matching
  `initFactory`'s own style for regions 0–3.

**Verification**: no committed test previously exercised `_regionLabel`/
`_regionFeeRaw` at all (they are `internal`, reachable only through
`renderReceipt`, and no existing test calls `renderReceipt` across regions).
An ephemeral harness (`SVGRendererHarness is SVGRenderer`, not committed) was
used to call both functions directly for all 7 regions and assert against
`FactoryFacet.getAllFees()`'s values:
```
[PASS] testAllSevenRegionsHaveDistinctLabelsAndCorrectFees() (gas: 3708647)
```
All 7 labels distinct, all 7 fees matching `2e6/4e6/7e6/1e7/4e6/1e7/7e6`. This
harness was deleted after verification — it is not part of the committed
suite (finding 6 asked to keep the change confined to the two functions, not
to add new test infrastructure). This remains a real coverage gap for a
future maintainer: `SVGRenderer` region rendering has no permanent automated
test, before or after this fix.

### Report corrections

Per the review's "Also — correct the report" item: the paragraph in the
"Drift test design" section above (previously item 3, describing
`testTotalMountedSelectorCountIs145`) asserted the hardcoded `145` was
"independent" verification. That was false and has been corrected in place
(struck through, replaced with an accurate description of why it was wrong
and what replaced it) rather than only addressed here — see that section
above for the corrected text. The "Proof the test discriminates" subsection
and the "What could not be verified" bullet about the missing integration
test were both annotated in place as superseded/closed, pointing here.

### Final verification (fix round 1)

**`forge build`**: exit code 0, clean (lint notes only, same pre-existing
style/gas-optimization warnings unrelated to this change; `REGION_AU` is a
compile-time constant so it does not appear in any selector/storage diff).

**`forge test`** (full suite, after restoring all deliberately-broken states):
```
Suite result: ok. 131 passed; 0 failed; 0 skipped; finished in 102.87ms (504.16ms CPU time)
Ran 9 test suites in 104.34ms (620.15ms CPU time): 292 tests passed, 0 failed, 0 skipped (292 total tests)
```
Still 292 (277 original + 15 in `DeployFullSelectors.t.sol` — one test
removed, one added, net unchanged count, materially different design).

**Array length/index audit**, re-run against the fix-round-1 script (unchanged
from the original regeneration — findings 1–6 did not touch any selector
array): all 11 arrays still `declared == assignments`, contiguous from 0, sum
= 145.

**Dry run** (`INITIAL_ARBITER=<адрес посаженного арбитра> forge script script/DeployFull.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL"`,
no `--broadcast`, current live `TRUSTED_FORWARDER`/`FEE_RECIPIENT`/`USDC_ADDRESS`
from `.env`):
```
Script ran successfully.
...
  --- Region fees (USDC, 6 decimals) ---
    0 CIS:    2000000
    1 Asia:   4000000
    2 EU:     7000000
    3 US:     10000000
    4 LATAM:  4000000
    5 CA:     10000000
    6 AU:     7000000
  --- Arbiters ---
  Count:          1
    Arbiter:      <адрес посаженного арбитра>
  =============================================
...
Estimated total gas used for script: 41452438
Estimated amount required: 0.000455976818 ETH
SIMULATION COMPLETE. To broadcast these transactions, add --broadcast and wallet configuration(s) to the previous command.
```
No `--broadcast` used; nothing sent on-chain. Two transient `HTTP error 520`
RPC failures were hit during this round's repeated dry runs (Cloudflare edge
error from the `drpc.live`/`base-sepolia.drpc.org` RPC, unrelated to the
script) — both resolved on retry.

### Remaining concerns after fix round 1

- `SVGRenderer` region-label/fee rendering (finding 6) has no permanent
  automated test — verified via an ephemeral, uncommitted harness only. A
  maintainer who wants durable coverage here would need to either make
  `_regionLabel`/`_regionFeeRaw` `internal` functions reachable from a real
  test contract (e.g. a thin test-only harness contract committed under
  `test/`) or add assertions against decoded `renderReceipt()` output.
- The new integration test (finding 3) does not call `initFactory` or
  `setRegionFee` — region-fee correctness end-to-end is still only checked
  via dry-run console output and code review, not a Foundry test that
  instantiates the real Diamond and calls `run()`'s post-cut steps.
- `INITIAL_ARBITER` is not validated for anything beyond non-zero (e.g. not
  checked to be a contract, not checked to differ from `owner`/`feeRecipient`).
  Live's manually-added arbiter (адрес не публикуется — это кошелёк человека)
  was used for the dry run as the coordinator's message indicated it should
  be; whoever runs the real deploy needs to independently decide the actual
  `INITIAL_ARBITER` value (this script only guarantees the set is non-empty,
  not who is in it).
