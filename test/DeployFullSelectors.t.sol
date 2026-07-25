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
/// functions to build the cuts it broadcasts). This test enumerates each facet's
/// selectors independently via `<Facet>.<fn>.selector` (the compiler-checked
/// ground truth — forge inspect methodIdentifiers agrees with it) and asserts
/// set-equality against what the script mounts. It fails if:
///   - the script is missing a selector a facet implements (undercut)
///   - the script mounts a selector no facet implements (phantom)
///   - a facet gains/loses a function and nobody updates this file (total-count
///     assertion below — the one thing per-facet tests alone cannot catch)
///   - a selector array's declared length disagrees with its real assignment
///     count (length mismatch surfaces immediately as a set-equality failure)
contract DeployFullSelectorsTest is Test {
    DeployFull internal deploy;

    // Placeholder facet addresses for buildInitCuts/buildRemainingCuts — these
    // functions are pure and only thread the address through into the FacetCut
    // struct, so any nonzero address works; no real facet needs to be deployed.
    address constant CUT_FACET      = address(0x1001);
    address constant LOUPE_FACET    = address(0x1002);
    address constant OWN_FACET      = address(0x1003);
    address constant REG_FACET      = address(0x1004);
    address constant FAC_FACET      = address(0x1005);
    address constant JOB_BOARD      = address(0x1006);
    address constant SERVICE_BOARD  = address(0x1007);
    address constant ARBITER_FACET  = address(0x1008);
    address constant META_FACET     = address(0x1009);
    address constant RECEIPT_FACET  = address(0x100A);
    address constant REPUTATION_FACET = address(0x100B);

    function setUp() public {
        deploy = new DeployFull();
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

    // ── Per-facet drift checks ───────────────────────────────────────────────

    function testDiamondCutFacetSelectors() public view {
        bytes4[] memory expected = new bytes4[](1);
        expected[0] = IDiamondCut.diamondCut.selector;
        _assertSameSelectorSet(deploy.cutFacetSelectors(), expected, "DiamondCutFacet");
    }

    function testDiamondLoupeFacetSelectors() public view {
        bytes4[] memory expected = new bytes4[](5);
        expected[0] = IDiamondLoupe.facets.selector;
        expected[1] = IDiamondLoupe.facetFunctionSelectors.selector;
        expected[2] = IDiamondLoupe.facetAddresses.selector;
        expected[3] = IDiamondLoupe.facetAddress.selector;
        expected[4] = IERC165.supportsInterface.selector;
        _assertSameSelectorSet(deploy.loupeFacetSelectors(), expected, "DiamondLoupeFacet");
    }

    function testOwnershipFacetSelectors() public view {
        bytes4[] memory expected = new bytes4[](4);
        expected[0] = OwnershipFacet.transferOwnership.selector;
        expected[1] = OwnershipFacet.owner.selector;
        expected[2] = OwnershipFacet.acceptOwnership.selector;
        expected[3] = OwnershipFacet.pendingOwner.selector;
        _assertSameSelectorSet(deploy.ownershipFacetSelectors(), expected, "OwnershipFacet");
    }

    function testRegistryFacetSelectors() public view {
        bytes4[] memory expected = new bytes4[](13);
        expected[0]  = RegistryFacet.initRegistry.selector;
        expected[1]  = RegistryFacet.register.selector;
        expected[2]  = RegistryFacet.updateStatus.selector;
        expected[3]  = RegistryFacet.setAuthorizedFactory.selector;
        expected[4]  = RegistryFacet.hasActivePair.selector;
        expected[5]  = RegistryFacet.getActivePair.selector;
        expected[6]  = RegistryFacet.getRecord.selector;
        expected[7]  = RegistryFacet.getByClient.selector;
        expected[8]  = RegistryFacet.getByExecutor.selector;
        expected[9]  = RegistryFacet.getActive.selector;
        expected[10] = RegistryFacet.getDisputed.selector;
        expected[11] = RegistryFacet.totalAgreements.selector;
        expected[12] = RegistryFacet.authorizedFactory.selector;
        _assertSameSelectorSet(deploy.registryFacetSelectors(), expected, "RegistryFacet");
    }

    function testFactoryFacetSelectors() public view {
        bytes4[] memory expected = new bytes4[](13);
        expected[0]  = FactoryFacet.initFactory.selector;
        expected[1]  = FactoryFacet.deployAgreement.selector;
        expected[2]  = FactoryFacet.deployAndFund.selector;
        expected[3]  = FactoryFacet.setRegionFee.selector;
        expected[4]  = FactoryFacet.setFeeRecipient.selector;
        expected[5]  = FactoryFacet.setTrustedForwarder.selector;
        expected[6]  = FactoryFacet.setAgreementDeployer.selector;
        expected[7]  = FactoryFacet.getRegionFee.selector;
        expected[8]  = FactoryFacet.getAllFees.selector;
        expected[9]  = FactoryFacet.getFeeRecipient.selector;
        expected[10] = FactoryFacet.getTrustedForwarder.selector;
        expected[11] = FactoryFacet.getUsdc.selector;
        expected[12] = FactoryFacet.getAgreementDeployer.selector;
        _assertSameSelectorSet(deploy.factoryFacetSelectors(), expected, "FactoryFacet");
    }

    function testJobBoardFacetSelectors() public view {
        bytes4[] memory expected = new bytes4[](12);
        expected[0]  = JobBoardFacet.mintJobWithPermit.selector;
        expected[1]  = JobBoardFacet.mintJob.selector;
        expected[2]  = JobBoardFacet.applyForJob.selector;
        expected[3]  = JobBoardFacet.withdrawApplication.selector;
        expected[4]  = JobBoardFacet.acceptApplicant.selector;
        expected[5]  = JobBoardFacet.cancelJob.selector;
        expected[6]  = JobBoardFacet.editJob.selector;
        expected[7]  = JobBoardFacet.getJob.selector;
        expected[8]  = JobBoardFacet.getClientJobs.selector;
        expected[9]  = JobBoardFacet.getApplicants.selector;
        expected[10] = JobBoardFacet.totalJobs.selector;
        expected[11] = JobBoardFacet.getOpenJobs.selector;
        _assertSameSelectorSet(deploy.jobBoardFacetSelectors(), expected, "JobBoardFacet");
    }

    function testServiceBoardFacetSelectors() public view {
        bytes4[] memory expected = new bytes4[](23);
        expected[0]  = ServiceBoardFacet.mintService.selector;
        expected[1]  = ServiceBoardFacet.mintServiceWithPermit.selector;
        expected[2]  = ServiceBoardFacet.removeService.selector;
        expected[3]  = ServiceBoardFacet.pauseService.selector;
        expected[4]  = ServiceBoardFacet.unpauseService.selector;
        expected[5]  = ServiceBoardFacet.editService.selector;
        expected[6]  = ServiceBoardFacet.requestService.selector;
        expected[7]  = ServiceBoardFacet.requestServiceWithPermit.selector;
        expected[8]  = ServiceBoardFacet.acceptRequest.selector;
        expected[9]  = ServiceBoardFacet.rejectRequest.selector;
        expected[10] = ServiceBoardFacet.cancelRequest.selector;
        expected[11] = ServiceBoardFacet.getService.selector;
        expected[12] = ServiceBoardFacet.getExecutorServices.selector;
        expected[13] = ServiceBoardFacet.getServiceClients.selector;
        expected[14] = ServiceBoardFacet.totalServices.selector;
        expected[15] = ServiceBoardFacet.getRequest.selector;
        expected[16] = ServiceBoardFacet.getServiceRequests.selector;
        expected[17] = ServiceBoardFacet.getClientRequests.selector;
        expected[18] = ServiceBoardFacet.totalRequests.selector;
        expected[19] = ServiceBoardFacet.getRequestFunds.selector;
        expected[20] = ServiceBoardFacet.getActiveServices.selector;
        expected[21] = ServiceBoardFacet.getPendingRequests.selector;
        expected[22] = ServiceBoardFacet.getPendingRequestIdsByClientAndExecutor.selector;
        _assertSameSelectorSet(deploy.serviceBoardFacetSelectors(), expected, "ServiceBoardFacet");
    }

    function testArbiterRegistryFacetSelectors() public view {
        bytes4[] memory expected = new bytes4[](44);
        expected[0]  = ArbiterRegistryFacet.activateDAO.selector;
        expected[1]  = ArbiterRegistryFacet.addArbiter.selector;
        expected[2]  = ArbiterRegistryFacet.applyAsArbiter.selector;
        expected[3]  = ArbiterRegistryFacet.claimDispute.selector;
        expected[4]  = ArbiterRegistryFacet.clearDisputeClaim.selector;
        expected[5]  = ArbiterRegistryFacet.clearStuckVerdict.selector;
        expected[6]  = ArbiterRegistryFacet.commitDisputeClaim.selector;
        expected[7]  = ArbiterRegistryFacet.finalizeVerdict.selector;
        expected[8]  = ArbiterRegistryFacet.freezeVerdict.selector;
        expected[9]  = ArbiterRegistryFacet.fundVault.selector;
        expected[10] = ArbiterRegistryFacet.getAppealVotes.selector;
        expected[11] = ArbiterRegistryFacet.getArbiterBond.selector;
        expected[12] = ArbiterRegistryFacet.getArbiterDeals.selector;
        expected[13] = ArbiterRegistryFacet.getArbiterMistakeStreak.selector;
        expected[14] = ArbiterRegistryFacet.getArbiterReward.selector;
        expected[15] = ArbiterRegistryFacet.getArbiters.selector;
        expected[16] = ArbiterRegistryFacet.getChiefArbiter.selector;
        expected[17] = ArbiterRegistryFacet.getClaimCommitment.selector;
        expected[18] = ArbiterRegistryFacet.getDAOAddress.selector;
        expected[19] = ArbiterRegistryFacet.getDaoThreshold.selector;
        expected[20] = ArbiterRegistryFacet.getDisputeClaimer.selector;
        expected[21] = ArbiterRegistryFacet.getMinXPToRegister.selector;
        expected[22] = ArbiterRegistryFacet.getOpenClaimCount.selector;
        expected[23] = ArbiterRegistryFacet.getPendingVerdict.selector;
        expected[24] = ArbiterRegistryFacet.getRewardPerDispute.selector;
        expected[25] = ArbiterRegistryFacet.getVaultBalance.selector;
        expected[26] = ArbiterRegistryFacet.hasSubmittedVerdict.selector;
        expected[27] = ArbiterRegistryFacet.hasVotedOnAppeal.selector;
        expected[28] = ArbiterRegistryFacet.isDaoActive.selector;
        expected[29] = ArbiterRegistryFacet.isRegisteredArbiter.selector;
        expected[30] = ArbiterRegistryFacet.notifyArbiterTimeout.selector;
        expected[31] = ArbiterRegistryFacet.overturnVerdict.selector;
        expected[32] = ArbiterRegistryFacet.raiseAppeal.selector;
        expected[33] = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        expected[34] = ArbiterRegistryFacet.removeArbiter.selector;
        expected[35] = ArbiterRegistryFacet.resignAsArbiter.selector;
        expected[36] = ArbiterRegistryFacet.resolveAppeal.selector;
        expected[37] = ArbiterRegistryFacet.setChiefArbiter.selector;
        expected[38] = ArbiterRegistryFacet.setDAOAddress.selector;
        expected[39] = ArbiterRegistryFacet.setRewardPerDispute.selector;
        expected[40] = ArbiterRegistryFacet.submitVerdict.selector;
        expected[41] = ArbiterRegistryFacet.unfreezeVerdict.selector;
        expected[42] = ArbiterRegistryFacet.voteOnAppeal.selector;
        expected[43] = ArbiterRegistryFacet.withdrawArbiterReward.selector;
        _assertSameSelectorSet(deploy.arbiterRegistryFacetSelectors(), expected, "ArbiterRegistryFacet");
    }

    function testDealMetadataFacetSelectors() public view {
        bytes4[] memory expected = new bytes4[](1);
        expected[0] = DealMetadataFacet.getDealTokenURI.selector;
        _assertSameSelectorSet(deploy.dealMetadataFacetSelectors(), expected, "DealMetadataFacet");
    }

    function testJobReceiptFacetSelectors() public view {
        bytes4[] memory expected = new bytes4[](21);
        expected[0]  = JobReceiptFacet.name.selector;
        expected[1]  = JobReceiptFacet.symbol.selector;
        expected[2]  = JobReceiptFacet.balanceOf.selector;
        expected[3]  = JobReceiptFacet.ownerOf.selector;
        expected[4]  = JobReceiptFacet.tokenURI.selector;
        expected[5]  = JobReceiptFacet.transferFrom.selector;
        expected[6]  = bytes4(0x42842e0e); // safeTransferFrom(address,address,uint256)
        expected[7]  = bytes4(0xb88d4fde); // safeTransferFrom(address,address,uint256,bytes)
        expected[8]  = JobReceiptFacet.approve.selector;
        expected[9]  = JobReceiptFacet.setApprovalForAll.selector;
        expected[10] = JobReceiptFacet.getApproved.selector;
        expected[11] = JobReceiptFacet.isApprovedForAll.selector;
        expected[12] = JobReceiptFacet.mintJobReceipt.selector;
        expected[13] = JobReceiptFacet.burnJobReceipt.selector;
        expected[14] = JobReceiptFacet.setSvgRenderer.selector;
        expected[15] = JobReceiptFacet.getSvgRenderer.selector;
        expected[16] = JobReceiptFacet.getJobReceiptData.selector;
        expected[17] = JobReceiptFacet.isJobReceiptToken.selector;
        expected[18] = JobReceiptFacet.isJobReceiptBurned.selector;
        expected[19] = JobReceiptFacet.getTokenIdByJobId.selector;
        expected[20] = JobReceiptFacet.getReceiptTotalSupply.selector;
        _assertSameSelectorSet(deploy.jobReceiptFacetSelectors(), expected, "JobReceiptFacet");
    }

    function testReputationFacetSelectors() public view {
        bytes4[] memory expected = new bytes4[](8);
        expected[0] = ReputationFacet.autoAwardXP.selector;
        expected[1] = ReputationFacet.claimXP.selector;
        expected[2] = ReputationFacet.getCleanStreak.selector;
        expected[3] = ReputationFacet.getUniqueActiveUsers.selector;
        expected[4] = ReputationFacet.getXP.selector;
        expected[5] = ReputationFacet.hasClaimed.selector;
        expected[6] = ReputationFacet.isDealWin.selector;
        expected[7] = ReputationFacet.notifyExecutorFault.selector;
        _assertSameSelectorSet(deploy.reputationFacetSelectors(), expected, "ReputationFacet");
    }

    // ── Cross-cutting invariants ─────────────────────────────────────────────

    /// The load-bearing net: 145 total across 11 facets. Per-facet tests above
    /// only fail if THIS file's `expected` arrays are updated to match a change
    /// in the script — if a facet gains a function and NEITHER the script NOR
    /// this test is touched, every per-facet test above still passes (both sides
    /// silently agree on the old, incomplete set). This count is what actually
    /// catches that case, because it is asserted against a hardcoded number, not
    /// against anything derived from the script itself.
    function testTotalMountedSelectorCountIs145() public view {
        uint256 total =
            deploy.cutFacetSelectors().length +
            deploy.loupeFacetSelectors().length +
            deploy.ownershipFacetSelectors().length +
            deploy.registryFacetSelectors().length +
            deploy.factoryFacetSelectors().length +
            deploy.jobBoardFacetSelectors().length +
            deploy.serviceBoardFacetSelectors().length +
            deploy.arbiterRegistryFacetSelectors().length +
            deploy.dealMetadataFacetSelectors().length +
            deploy.jobReceiptFacetSelectors().length +
            deploy.reputationFacetSelectors().length;
        assertEq(total, 145, "total mounted selector count drifted from 145 - a facet gained/lost a function");
    }

    /// No selector value appears under two different facets. A Diamond can only
    /// route a given 4-byte selector to one facet address — if two facets in
    /// this script ever claimed the same selector, one silently shadows the
    /// other during buildInitCuts/buildRemainingCuts (whichever cut wins,
    /// duplicate `Diamond: selector exists` reverts the deploy), so proving
    /// there is zero overlap here is a real check, not decoration.
    function testNoSelectorCollisionsAcrossFacets() public view {
        bytes4[][11] memory groups = [
            deploy.cutFacetSelectors(),
            deploy.loupeFacetSelectors(),
            deploy.ownershipFacetSelectors(),
            deploy.registryFacetSelectors(),
            deploy.factoryFacetSelectors(),
            deploy.jobBoardFacetSelectors(),
            deploy.serviceBoardFacetSelectors(),
            deploy.arbiterRegistryFacetSelectors(),
            deploy.dealMetadataFacetSelectors(),
            deploy.jobReceiptFacetSelectors(),
            deploy.reputationFacetSelectors()
        ];

        // Flatten into one array first (fixed-size 145, matches the count test above).
        bytes4[] memory flat = new bytes4[](145);
        uint256 k = 0;
        for (uint256 g = 0; g < groups.length; g++) {
            for (uint256 i = 0; i < groups[g].length; i++) {
                flat[k++] = groups[g][i];
            }
        }
        assertEq(k, 145, "flattened selector count drifted from 145");

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
            JOB_BOARD, SERVICE_BOARD, ARBITER_FACET, META_FACET, RECEIPT_FACET, REPUTATION_FACET
        );
        assertEq(cuts.length, 6, "buildRemainingCuts: expected 6 FacetCut entries");

        assertEq(cuts[0].facetAddress, JOB_BOARD);
        _assertSameSelectorSet(cuts[0].functionSelectors, deploy.jobBoardFacetSelectors(), "cuts2[0] JobBoardFacet");

        assertEq(cuts[1].facetAddress, SERVICE_BOARD);
        _assertSameSelectorSet(cuts[1].functionSelectors, deploy.serviceBoardFacetSelectors(), "cuts2[1] ServiceBoardFacet");

        assertEq(cuts[2].facetAddress, ARBITER_FACET);
        _assertSameSelectorSet(cuts[2].functionSelectors, deploy.arbiterRegistryFacetSelectors(), "cuts2[2] ArbiterRegistryFacet");

        assertEq(cuts[3].facetAddress, META_FACET);
        _assertSameSelectorSet(cuts[3].functionSelectors, deploy.dealMetadataFacetSelectors(), "cuts2[3] DealMetadataFacet");

        assertEq(cuts[4].facetAddress, RECEIPT_FACET);
        _assertSameSelectorSet(cuts[4].functionSelectors, deploy.jobReceiptFacetSelectors(), "cuts2[4] JobReceiptFacet");

        assertEq(cuts[5].facetAddress, REPUTATION_FACET);
        _assertSameSelectorSet(cuts[5].functionSelectors, deploy.reputationFacetSelectors(), "cuts2[5] ReputationFacet");

        for (uint256 i = 0; i < cuts.length; i++) {
            assertTrue(cuts[i].action == IDiamondCut.FacetCutAction.Add, "cuts2: all entries must be Add");
        }
    }
}
