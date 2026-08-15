// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../script/DeployFull.s.sol";
import "../src/DiamondProxy.sol";
import "../src/RegistryFacet.sol";
import "../src/FactoryFacet.sol";
import "../src/facets/JobBoardFacet.sol";
import "../src/facets/ServiceBoardFacet.sol";
import "../src/facets/ArbiterRegistryFacet.sol";
import "../src/facets/ArbiterAccountabilityFacet.sol";
import "../src/facets/DealMetadataFacet.sol";
import "../src/facets/ReputationFacet.sol";
import "../src/JobReceiptFacet.sol";

/// Anti-drift gate for script/DeployFull.s.sol.
///
/// DeployFull.s.sol was broadcast exactly once (3 June 2026) and then went ~40
/// upgrades stale while the live diamond kept moving — nothing caught it because
/// nothing compared the script's mounted selectors against the facets' real ABIs.
/// This test is that comparison, made permanent.
///
/// Design: DeployFull exposes its selector arrays and FacetCut[] builders as
/// `public pure` functions (single source of truth — run() calls the very same
/// functions to build the cuts it broadcasts). Ground truth is read directly out
/// of the compiled artifact (`out/<Facet>.sol/<Facet>.json`'s `methodIdentifiers`
/// map) rather than hand-typed here.
///
/// Fix round 1 note: an earlier version of this file hand-typed each facet's
/// `expected` selector array via `<Facet>.<fn>.selector` and additionally asserted
/// a hardcoded total of 145. That was proven NOT to discriminate against the
/// specific failure mode that caused the original drift (a facet gaining a
/// function that nobody wires anywhere): adding one real function to a facet
/// changes nothing about either the hand-typed array or the hardcoded total, so
/// both sides silently agree on the same incomplete set and every test still
/// passes. Reading the artifact's `methodIdentifiers` instead means the expected
/// set updates itself the moment the facet is recompiled — there is nothing left
/// to remember to update by hand. See the fix-round-1 section of
/// docs/audits/2026-07-25-slither/deployfull-regen-report.md for the concrete
/// before/after proof.
///
/// This test fails if:
///   - the script is missing a selector a facet implements (undercut)
///   - the script mounts a selector no facet implements (phantom)
///   - a facet gains or loses a function between now and the next `forge build`
///     (ground truth is re-derived from the artifact every run, not pinned)
///   - a selector array's declared length disagrees with its real assignment
///     count (length mismatch surfaces immediately as a set-equality failure)
///   - `buildInitCuts`/`buildRemainingCuts` wire a correct selector set to the
///     wrong `FacetCut.facetAddress`
///   - the actual `DiamondProxy` this script would produce does not end up with
///     exactly 12 facets, exactly 187 routed selectors, and consistent
///     `facetAddress(sel)` <-> `facets()` routing in both directions
///     (177 -> 179, 15 Aug 2026: arbiter-accountability task 1 added
///     getSeatedBy/getSeatedCountBy to ArbiterRegistryFacet; 179 -> 180,
///     same day: arbiter-accountability task 2 added getChiefBloc to cap
///     the chief's bloc below the appeal quorum; 180 -> 181, same day:
///     arbiter-accountability task 3 added getMaxClaimsPerArbiter to cap
///     how many disputes an arbiter can hold open at once; 181 -> 187, same
///     day: arbiter-accountability task 4 — ArbiterRegistryFacet sat at 86.4%
///     of the EIP-170 deployed-bytecode limit, so arbiter suspension shipped
///     as a twelfth facet, ArbiterAccountabilityFacet, sharing the same
///     ArbiterRegistryStorage namespace — 11 facets -> 12, six new selectors)
contract DeployFullSelectorsTest is Test {
    DeployFull internal deploy;

    // Placeholder facet addresses for buildInitCuts/buildRemainingCuts — these
    // functions are pure and only thread the address through into the FacetCut
    // struct, so any nonzero address works; no real facet needs to be deployed
    // for THESE tests specifically (the real-facet integration test further down
    // deploys actual bytecode instead).
    address constant CUT_FACET      = address(0x1001);
    address constant LOUPE_FACET    = address(0x1002);
    address constant OWN_FACET      = address(0x1003);
    address constant REG_FACET      = address(0x1004);
    address constant FAC_FACET      = address(0x1005);
    address constant JOB_BOARD      = address(0x1006);
    address constant SERVICE_BOARD  = address(0x1007);
    address constant ARBITER_FACET  = address(0x1008);
    address constant ACCOUNTABILITY_FACET = address(0x100C);
    address constant META_FACET     = address(0x1009);
    address constant RECEIPT_FACET  = address(0x100A);
    address constant REPUTATION_FACET = address(0x100B);

    function setUp() public {
        deploy = new DeployFull();
    }

    // ── Ground truth: read straight out of the compiled artifact ────────────
    // `forge inspect <Facet> methodIdentifiers` is itself just a formatted dump
    // of this same `methodIdentifiers` map from the artifact JSON — reading it
    // directly means the expected set is regenerated by every `forge build`,
    // with nothing left for a human to keep in sync by hand.
    function _abiSelectors(string memory sourceFile, string memory contractName) internal view returns (bytes4[] memory out) {
        string memory json = vm.readFile(string.concat("out/", sourceFile, ".sol/", contractName, ".json"));
        string[] memory sigs = vm.parseJsonKeys(json, ".methodIdentifiers");
        out = new bytes4[](sigs.length);
        for (uint256 i; i < sigs.length; i++) out[i] = bytes4(keccak256(bytes(sigs[i])));
    }

    // Convenience overload for the common case where the contract's source file
    // shares its name (true for every facet except the three defined inside
    // DiamondProxy.sol).
    function _abiSelectors(string memory contractName) internal view returns (bytes4[] memory) {
        return _abiSelectors(contractName, contractName);
    }

    // ── Set-equality helper ──────────────────────────────────────────────────
    // Order-independent. Requires equal lengths (catches declared-length vs.
    // assignment-count drift immediately), then requires every element of
    // `actual` to appear in `expected` (phantom check) and every element of
    // `expected` to appear in `actual` (missing-selector check). Combined with
    // the length check this rejects duplicates masking a missing entry too.
    function _assertSameSelectorSet(bytes4[] memory actual, bytes4[] memory expected, string memory label) internal pure {
        assertEq(actual.length, expected.length, string.concat(label, ": selector count mismatch"));

        for (uint256 i = 0; i < actual.length; i++) {
            bool found = false;
            for (uint256 j = 0; j < expected.length; j++) {
                if (actual[i] == expected[j]) { found = true; break; }
            }
            assertTrue(found, string.concat(label, ": script mounts a selector no facet implements (phantom)"));
        }

        for (uint256 i = 0; i < expected.length; i++) {
            bool found = false;
            for (uint256 j = 0; j < actual.length; j++) {
                if (expected[i] == actual[j]) { found = true; break; }
            }
            assertTrue(found, string.concat(label, ": facet has a selector the script does not mount (undercut)"));
        }
    }

    // ── Per-facet drift checks — expected sets come from the compiled ABI, not
    //    from hand-typed literals in this file ──────────────────────────────

    function testDiamondCutFacetSelectors() public view {
        _assertSameSelectorSet(deploy.cutFacetSelectors(), _abiSelectors("DiamondProxy", "DiamondCutFacet"), "DiamondCutFacet");
    }

    function testDiamondLoupeFacetSelectors() public view {
        _assertSameSelectorSet(deploy.loupeFacetSelectors(), _abiSelectors("DiamondProxy", "DiamondLoupeFacet"), "DiamondLoupeFacet");
    }

    function testOwnershipFacetSelectors() public view {
        _assertSameSelectorSet(deploy.ownershipFacetSelectors(), _abiSelectors("DiamondProxy", "OwnershipFacet"), "OwnershipFacet");
    }

    function testRegistryFacetSelectors() public view {
        _assertSameSelectorSet(deploy.registryFacetSelectors(), _abiSelectors("RegistryFacet"), "RegistryFacet");
    }

    function testFactoryFacetSelectors() public view {
        _assertSameSelectorSet(deploy.factoryFacetSelectors(), _abiSelectors("FactoryFacet"), "FactoryFacet");
    }

    function testJobBoardFacetSelectors() public view {
        _assertSameSelectorSet(deploy.jobBoardFacetSelectors(), _abiSelectors("JobBoardFacet"), "JobBoardFacet");
    }

    function testServiceBoardFacetSelectors() public view {
        _assertSameSelectorSet(deploy.serviceBoardFacetSelectors(), _abiSelectors("ServiceBoardFacet"), "ServiceBoardFacet");
    }

    function testArbiterRegistryFacetSelectors() public view {
        _assertSameSelectorSet(deploy.arbiterRegistryFacetSelectors(), _abiSelectors("ArbiterRegistryFacet"), "ArbiterRegistryFacet");
    }

    function testArbiterAccountabilityFacetSelectors() public view {
        _assertSameSelectorSet(deploy.arbiterAccountabilityFacetSelectors(), _abiSelectors("ArbiterAccountabilityFacet"), "ArbiterAccountabilityFacet");
    }

    function testDealMetadataFacetSelectors() public view {
        _assertSameSelectorSet(deploy.dealMetadataFacetSelectors(), _abiSelectors("DealMetadataFacet"), "DealMetadataFacet");
    }

    function testJobReceiptFacetSelectors() public view {
        _assertSameSelectorSet(deploy.jobReceiptFacetSelectors(), _abiSelectors("JobReceiptFacet"), "JobReceiptFacet");
    }

    function testReputationFacetSelectors() public view {
        _assertSameSelectorSet(deploy.reputationFacetSelectors(), _abiSelectors("ReputationFacet"), "ReputationFacet");
    }

    // ── Cross-cutting invariant ──────────────────────────────────────────────

    /// No selector value appears under two different facets. A Diamond can only
    /// route a given 4-byte selector to one facet address — if two facets in
    /// this script ever claimed the same selector, one silently shadows the
    /// other during buildInitCuts/buildRemainingCuts (whichever cut wins,
    /// diamondCut itself would revert with `Diamond: selector exists` on the
    /// duplicate), so proving there is zero overlap here is a real check, not
    /// decoration. The total selector count is summed from the script's own
    /// output here (not hardcoded) — per-facet tests above are what pin each
    /// count against ground truth; this test only cares about cross-facet
    /// uniqueness.
    function testNoSelectorCollisionsAcrossFacets() public view {
        bytes4[][12] memory groups = [
            deploy.cutFacetSelectors(),
            deploy.loupeFacetSelectors(),
            deploy.ownershipFacetSelectors(),
            deploy.registryFacetSelectors(),
            deploy.factoryFacetSelectors(),
            deploy.jobBoardFacetSelectors(),
            deploy.serviceBoardFacetSelectors(),
            deploy.arbiterRegistryFacetSelectors(),
            deploy.arbiterAccountabilityFacetSelectors(),
            deploy.dealMetadataFacetSelectors(),
            deploy.jobReceiptFacetSelectors(),
            deploy.reputationFacetSelectors()
        ];

        uint256 total;
        for (uint256 g = 0; g < groups.length; g++) total += groups[g].length;

        bytes4[] memory flat = new bytes4[](total);
        uint256 k = 0;
        for (uint256 g = 0; g < groups.length; g++) {
            for (uint256 i = 0; i < groups[g].length; i++) {
                flat[k++] = groups[g][i];
            }
        }

        for (uint256 i = 0; i < flat.length; i++) {
            for (uint256 j = i + 1; j < flat.length; j++) {
                assertTrue(flat[i] != flat[j], "duplicate selector across facets");
            }
        }
    }

    // ── FacetCut[] builder checks ────────────────────────────────────────────
    // These exercise the exact functions run() calls to build what it actually
    // broadcasts to diamondCut() — catching a facetAddress/selector-set mixup
    // (e.g. ArbiterRegistry's selectors wired to JobBoard's address) that the
    // per-facet selector tests above cannot see, since they never look at which
    // address a selector set is paired with.

    function testBuildInitCutsMatchesIndividualSelectors() public view {
        IDiamondCut.FacetCut[] memory cuts = deploy.buildInitCuts(
            CUT_FACET, LOUPE_FACET, OWN_FACET, REG_FACET, FAC_FACET
        );
        assertEq(cuts.length, 5, "buildInitCuts: expected 5 FacetCut entries");

        assertEq(cuts[0].facetAddress, CUT_FACET);
        _assertSameSelectorSet(cuts[0].functionSelectors, deploy.cutFacetSelectors(), "initCuts[0] DiamondCutFacet");

        assertEq(cuts[1].facetAddress, LOUPE_FACET);
        _assertSameSelectorSet(cuts[1].functionSelectors, deploy.loupeFacetSelectors(), "initCuts[1] DiamondLoupeFacet");

        assertEq(cuts[2].facetAddress, OWN_FACET);
        _assertSameSelectorSet(cuts[2].functionSelectors, deploy.ownershipFacetSelectors(), "initCuts[2] OwnershipFacet");

        assertEq(cuts[3].facetAddress, REG_FACET);
        _assertSameSelectorSet(cuts[3].functionSelectors, deploy.registryFacetSelectors(), "initCuts[3] RegistryFacet");

        assertEq(cuts[4].facetAddress, FAC_FACET);
        _assertSameSelectorSet(cuts[4].functionSelectors, deploy.factoryFacetSelectors(), "initCuts[4] FactoryFacet");

        for (uint256 i = 0; i < cuts.length; i++) {
            assertTrue(cuts[i].action == IDiamondCut.FacetCutAction.Add, "initCuts: all entries must be Add");
        }
    }

    function testBuildRemainingCutsMatchesIndividualSelectors() public view {
        IDiamondCut.FacetCut[] memory cuts = deploy.buildRemainingCuts(
            JOB_BOARD, SERVICE_BOARD, ARBITER_FACET, ACCOUNTABILITY_FACET, META_FACET, RECEIPT_FACET, REPUTATION_FACET
        );
        assertEq(cuts.length, 7, "buildRemainingCuts: expected 7 FacetCut entries");

        assertEq(cuts[0].facetAddress, JOB_BOARD);
        _assertSameSelectorSet(cuts[0].functionSelectors, deploy.jobBoardFacetSelectors(), "cuts2[0] JobBoardFacet");

        assertEq(cuts[1].facetAddress, SERVICE_BOARD);
        _assertSameSelectorSet(cuts[1].functionSelectors, deploy.serviceBoardFacetSelectors(), "cuts2[1] ServiceBoardFacet");

        assertEq(cuts[2].facetAddress, ARBITER_FACET);
        _assertSameSelectorSet(cuts[2].functionSelectors, deploy.arbiterRegistryFacetSelectors(), "cuts2[2] ArbiterRegistryFacet");

        assertEq(cuts[3].facetAddress, ACCOUNTABILITY_FACET);
        _assertSameSelectorSet(cuts[3].functionSelectors, deploy.arbiterAccountabilityFacetSelectors(), "cuts2[3] ArbiterAccountabilityFacet");

        assertEq(cuts[4].facetAddress, META_FACET);
        _assertSameSelectorSet(cuts[4].functionSelectors, deploy.dealMetadataFacetSelectors(), "cuts2[4] DealMetadataFacet");

        assertEq(cuts[5].facetAddress, RECEIPT_FACET);
        _assertSameSelectorSet(cuts[5].functionSelectors, deploy.jobReceiptFacetSelectors(), "cuts2[5] JobReceiptFacet");

        assertEq(cuts[6].facetAddress, REPUTATION_FACET);
        _assertSameSelectorSet(cuts[6].functionSelectors, deploy.reputationFacetSelectors(), "cuts2[6] ReputationFacet");

        for (uint256 i = 0; i < cuts.length; i++) {
            assertTrue(cuts[i].action == IDiamondCut.FacetCutAction.Add, "cuts2: all entries must be Add");
        }
    }

    // ── Full-diamond integration check ───────────────────────────────────────
    // Every other test above works on the selector level. None of them ever
    // constructs the actual DiamondProxy this script produces — which is
    // exactly why the 40-upgrade drift this whole file exists to prevent was
    // possible in the first place: CriticalInvariant.t.sol / Extras.t.sol /
    // AdversarialAccess.t.sol each hand-build their own PARTIAL cuts for
    // feature testing (e.g. 33 of 47 ArbiterRegistry selectors, 20 of 23
    // ServiceBoard selectors) and none of them exercises DeployFull's actual
    // buildInitCuts/buildRemainingCuts output end to end.
    //
    // This deploys all twelve real facets, builds the diamond exactly the way
    // run() does, and asserts the diamond that comes out the other end has
    // exactly 12 facets, exactly 187 routed selectors, and that
    // facetAddress(sel) and facets() agree with each other in both directions.
    // This is the only check in the suite that would catch a selector set
    // wired to the wrong facet address — diamondCut() itself does not validate
    // that a facet actually implements what it's handed.
    function testDeployFullBuildsCompleteDiamondWithConsistentRouting() public {
        DiamondCutFacet        cutFacet     = new DiamondCutFacet();
        DiamondLoupeFacet      loupeFacet   = new DiamondLoupeFacet();
        OwnershipFacet         ownFacet     = new OwnershipFacet();
        RegistryFacet          regFacet     = new RegistryFacet();
        FactoryFacet           facFacet     = new FactoryFacet();
        JobBoardFacet          jobBoard     = new JobBoardFacet();
        ServiceBoardFacet      serviceBoard = new ServiceBoardFacet();
        ArbiterRegistryFacet   arbiterFacet = new ArbiterRegistryFacet();
        ArbiterAccountabilityFacet accFacet = new ArbiterAccountabilityFacet();
        DealMetadataFacet      metaFacet    = new DealMetadataFacet();
        JobReceiptFacet        receiptFacet = new JobReceiptFacet();
        ReputationFacet        repFacet     = new ReputationFacet();

        IDiamondCut.FacetCut[] memory initCuts = deploy.buildInitCuts(
            address(cutFacet), address(loupeFacet), address(ownFacet), address(regFacet), address(facFacet)
        );
        DiamondProxy diamond = new DiamondProxy(address(this), initCuts, address(0), "");

        IDiamondCut.FacetCut[] memory cuts2 = deploy.buildRemainingCuts(
            address(jobBoard), address(serviceBoard), address(arbiterFacet), address(accFacet),
            address(metaFacet), address(receiptFacet), address(repFacet)
        );
        IDiamondCut(address(diamond)).diamondCut(cuts2, address(0), "");

        IDiamondLoupe.Facet[] memory facetsList = IDiamondLoupe(address(diamond)).facets();
        assertEq(facetsList.length, 12, "diamond should end up with exactly 12 distinct facet addresses");

        uint256 totalRouted;
        for (uint256 i = 0; i < facetsList.length; i++) {
            bytes4[] memory sels = facetsList[i].functionSelectors;
            totalRouted += sels.length;
            for (uint256 j = 0; j < sels.length; j++) {
                assertEq(
                    IDiamondLoupe(address(diamond)).facetAddress(sels[j]),
                    facetsList[i].facetAddress,
                    "facetAddress(sel) disagrees with facets() for a routed selector"
                );
            }
        }
        assertEq(totalRouted, 187, "diamond should route exactly 187 selectors total");

        // Reverse direction: facetAddresses() must report exactly the same set
        // of addresses facets() reported them under.
        address[] memory addrs = IDiamondLoupe(address(diamond)).facetAddresses();
        assertEq(addrs.length, 12, "facetAddresses() should also report exactly 12 facets");
        for (uint256 i = 0; i < addrs.length; i++) {
            bool found = false;
            for (uint256 j = 0; j < facetsList.length; j++) {
                if (facetsList[j].facetAddress == addrs[i]) { found = true; break; }
            }
            assertTrue(found, "facetAddresses() reported an address facets() does not know about");
        }
    }
}
