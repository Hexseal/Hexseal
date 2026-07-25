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
3. `testTotalMountedSelectorCountIs145` — asserts the sum of all 11 arrays'
   lengths equals the hardcoded number **145**. This is the piece the brief
   specifically calls out as necessary: the per-facet tests above only fail
   if a new function is added to a facet **and** this test file is not
   updated to expect it — if both the script and the test are left
   unchanged when a facet gains a function, every per-facet test still
   passes (both sides silently agree on the same incomplete set). The
   hardcoded `145` is the only assertion in the file that is NOT derived
   from the script itself, so it is the one thing that can catch "nobody
   touched either file."
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

### Proof the test discriminates (both directions)

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
- `getAllFees()` return values were only checked via the dry-run console
  output (matches expected), not via a dedicated Foundry test that
  instantiates the real Diamond and calls `initFactory` + the three
  `setRegionFee` calls end-to-end. `test/Diamond.t.sol` already exercises
  `initFactory`'s 0–3 seeding elsewhere in the suite; adding a full
  integration test of `DeployFull.run()` itself was outside this task's
  scope (the task's test requirement was specifically the selector drift
  gate, not an end-to-end deploy-script integration test), but would be a
  reasonable follow-up if a maintainer wants belt-and-suspenders coverage of
  the region-fee wiring specifically.
