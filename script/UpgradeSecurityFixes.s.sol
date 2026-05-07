// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeSecurityFixes.s.sol
//
// Атомарный апгрейд — security fixes из аудита:
//
//  1. JobBoardFacet
//       + jobFunds ledger: явный учёт USDC по каждой работе
//       + глобальный DiamondGuard вместо per-facet guard
//
//  2. ServiceBoardFacet
//       + глобальный DiamondGuard вместо per-facet guard
//
//  3. OfferNFTFacet
//       + глобальный DiamondGuard вместо per-facet guard
//
//  4. ArbiterRegistryFacet (все 11 селекторов)
//       + claimDispute: CEI — setArbiter() до записи в storage
//       + claimDispute: commit-reveal защита от фронтраннинга
//           Новая сигнатура: claimDispute(address, bytes32 salt)
//           Шаг 1: commitDisputeClaim(keccak256(agreement, caller, salt))
//           Шаг 2: claimDispute(agreement, salt) — минимум через 1 блок
//       + clearDisputeClaim(address): Agreement очищает клейм при завершении
//       + getClaimCommitment(bytes32): view для фронта
//
//  5. FactoryFacet
//       + новый Agreement bytecode:
//           - setArbiter() проверяет isRegisteredArbiter()
//           - syncRegistry(): публичная ресинхронизация Registry
//           - RegistrySyncFailed event при сбое updateStatus()
//           - _clearDisputeClaim() вызывается из resolveDispute / triggerArbiterTimeout
//           - _finalized guard: атомарная защита от race condition resolveDispute/triggerArbiterTimeout
//
// Стратегия апгрейда: Remove(старые селекторы) + Add(новые) — безопасно при
// любом состоянии Diamond, не требует знать какие селекторы там сейчас.
//
// Использование:
//   forge script script/UpgradeSecurityFixes.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL \
//     --private-key $PRIVATE_KEY \
//     --broadcast -vvv
//
// NOTE: существующие Agreement-контракты НЕ обновляются (они immutable).
//       Фиксы Agreement (setArbiter + syncRegistry + _finalized) работают только для новых сделок.
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";

import "../src/facets/JobBoardFacet.sol";
import "../src/facets/ServiceBoardFacet.sol";
import "../src/facets/ArbiterRegistryFacet.sol";
import "../src/OfferNFTFacet.sol";
import "../src/FactoryFacet.sol";
import "../src/DiamondProxy.sol";

contract UpgradeSecurityFixes is Script {
    address constant DIAMOND  = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;
    uint256 constant MAX_CUTS = 15; // 5 facets × max 2 cuts each (Remove + Add)

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        // ── Deploy new facets ─────────────────────────────────────────────────

        JobBoardFacet        newJobBoard     = new JobBoardFacet();
        ServiceBoardFacet    newServiceBoard = new ServiceBoardFacet();
        OfferNFTFacet        newOfferNFT     = new OfferNFTFacet();
        ArbiterRegistryFacet newArbiter      = new ArbiterRegistryFacet();
        FactoryFacet         newFactory      = new FactoryFacet();

        console.log("JobBoardFacet:        ", address(newJobBoard));
        console.log("ServiceBoardFacet:    ", address(newServiceBoard));
        console.log("OfferNFTFacet:        ", address(newOfferNFT));
        console.log("ArbiterRegistryFacet: ", address(newArbiter));
        console.log("FactoryFacet:         ", address(newFactory));

        // ── Build cuts (Remove old + Add new per facet) ───────────────────────

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](MAX_CUTS);
        uint256 n;

        // JobBoardFacet — anchor: applyForJob (stable since initial deploy)
        {
            bytes4[] memory sels = new bytes4[](10);
            sels[0] = JobBoardFacet.mintJobWithPermit.selector;
            sels[1] = JobBoardFacet.mintJob.selector;
            sels[2] = JobBoardFacet.applyForJob.selector;
            sels[3] = JobBoardFacet.acceptApplicant.selector;
            sels[4] = JobBoardFacet.cancelJob.selector;
            sels[5] = JobBoardFacet.getJob.selector;
            sels[6] = JobBoardFacet.getClientJobs.selector;
            sels[7] = JobBoardFacet.getApplicants.selector;
            sels[8] = JobBoardFacet.totalJobs.selector;
            sels[9] = JobBoardFacet.getOpenJobs.selector;
            n = _replaceFacet(cuts, n, JobBoardFacet.applyForJob.selector, address(newJobBoard), sels);
        }

        // ServiceBoardFacet — anchor: totalServices
        {
            bytes4[] memory sels = new bytes4[](8);
            sels[0] = ServiceBoardFacet.mintService.selector;
            sels[1] = ServiceBoardFacet.removeService.selector;
            sels[2] = ServiceBoardFacet.pauseService.selector;
            sels[3] = ServiceBoardFacet.unpauseService.selector;
            sels[4] = ServiceBoardFacet.getService.selector;
            sels[5] = ServiceBoardFacet.getExecutorServices.selector;
            sels[6] = ServiceBoardFacet.getServiceClients.selector;
            sels[7] = ServiceBoardFacet.totalServices.selector;
            n = _replaceFacet(cuts, n, ServiceBoardFacet.totalServices.selector, address(newServiceBoard), sels);
        }

        // OfferNFTFacet — anchor: mintOffer
        {
            bytes4[] memory sels = new bytes4[](22);
            sels[0]  = OfferNFTFacet.name.selector;
            sels[1]  = OfferNFTFacet.symbol.selector;
            sels[2]  = OfferNFTFacet.supportsInterface.selector;
            sels[3]  = OfferNFTFacet.balanceOf.selector;
            sels[4]  = OfferNFTFacet.ownerOf.selector;
            sels[5]  = OfferNFTFacet.tokenURI.selector;
            sels[6]  = bytes4(0x23b872dd); // transferFrom(address,address,uint256)
            sels[7]  = bytes4(0x42842e0e); // safeTransferFrom(address,address,uint256)
            sels[8]  = bytes4(0xb88d4fde); // safeTransferFrom(address,address,uint256,bytes)
            sels[9]  = OfferNFTFacet.approve.selector;
            sels[10] = OfferNFTFacet.setApprovalForAll.selector;
            sels[11] = OfferNFTFacet.getApproved.selector;
            sels[12] = OfferNFTFacet.isApprovedForAll.selector;
            sels[13] = OfferNFTFacet.mintOffer.selector;
            sels[14] = OfferNFTFacet.mintJobReceipt.selector;
            sels[15] = OfferNFTFacet.hireAndCreateDeal.selector;
            sels[16] = OfferNFTFacet.deactivateOffer.selector;
            sels[17] = OfferNFTFacet.getOffer.selector;
            sels[18] = OfferNFTFacet.getExecutorOffers.selector;
            sels[19] = OfferNFTFacet.getOfferHires.selector;
            sels[20] = OfferNFTFacet.getTotalSupply.selector;
            sels[21] = OfferNFTFacet.getActiveOffersCount.selector;
            n = _replaceFacet(cuts, n, OfferNFTFacet.mintOffer.selector, address(newOfferNFT), sels);
        }

        // ArbiterRegistryFacet — 11 selectors (incl. new commit-reveal funcs)
        // anchor: addArbiter (present since initial deployment)
        {
            bytes4[] memory sels = new bytes4[](11);
            sels[0]  = ArbiterRegistryFacet.addArbiter.selector;
            sels[1]  = ArbiterRegistryFacet.removeArbiter.selector;
            sels[2]  = ArbiterRegistryFacet.commitDisputeClaim.selector;   // NEW
            sels[3]  = ArbiterRegistryFacet.claimDispute.selector;         // (address,bytes32) — new sig
            sels[4]  = ArbiterRegistryFacet.releaseDisputeClaim.selector;
            sels[5]  = ArbiterRegistryFacet.clearDisputeClaim.selector;    // NEW
            sels[6]  = ArbiterRegistryFacet.isRegisteredArbiter.selector;
            sels[7]  = ArbiterRegistryFacet.getArbiters.selector;
            sels[8]  = ArbiterRegistryFacet.getDisputeClaimer.selector;
            sels[9]  = ArbiterRegistryFacet.getArbiterDeals.selector;
            sels[10] = ArbiterRegistryFacet.getClaimCommitment.selector;   // NEW
            n = _replaceFacet(cuts, n, ArbiterRegistryFacet.addArbiter.selector, address(newArbiter), sels);
        }

        // FactoryFacet — anchor: deployAgreement
        {
            bytes4[] memory sels = new bytes4[](17);
            sels[0]  = FactoryFacet.initFactory.selector;
            sels[1]  = FactoryFacet.deployAgreement.selector;
            sels[2]  = FactoryFacet.deployAndFund.selector;
            sels[3]  = FactoryFacet.setRegionFee.selector;
            sels[4]  = FactoryFacet.setFeeRecipient.selector;
            sels[5]  = FactoryFacet.setTrustedForwarder.selector;
            sels[6]  = FactoryFacet.setPaused.selector;
            sels[7]  = FactoryFacet.setProtocolArbiter.selector;
            sels[8]  = FactoryFacet.setArbitrationThreshold.selector;
            sels[9]  = FactoryFacet.getRegionFee.selector;
            sels[10] = FactoryFacet.getAllFees.selector;
            sels[11] = FactoryFacet.getFeeRecipient.selector;
            sels[12] = FactoryFacet.getTrustedForwarder.selector;
            sels[13] = FactoryFacet.isPaused.selector;
            sels[14] = FactoryFacet.getUsdc.selector;
            sels[15] = FactoryFacet.getProtocolArbiter.selector;
            sels[16] = FactoryFacet.getArbitrationThreshold.selector;
            n = _replaceFacet(cuts, n, FactoryFacet.deployAgreement.selector, address(newFactory), sels);
        }

        // Trim cuts array to actual count
        assembly { mstore(cuts, n) }

        // ── Execute ───────────────────────────────────────────────────────────
        console.log("\nExecuting diamondCut with", n, "cuts on Diamond:", DIAMOND);
        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        vm.stopBroadcast();

        // ── Verify ────────────────────────────────────────────────────────────
        require(
            IDiamondLoupe(DIAMOND).facetAddress(JobBoardFacet.acceptApplicant.selector) == address(newJobBoard),
            "JobBoardFacet: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(ServiceBoardFacet.mintService.selector) == address(newServiceBoard),
            "ServiceBoardFacet: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(OfferNFTFacet.mintOffer.selector) == address(newOfferNFT),
            "OfferNFTFacet: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(ArbiterRegistryFacet.claimDispute.selector) == address(newArbiter),
            "ArbiterRegistry claimDispute: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(ArbiterRegistryFacet.commitDisputeClaim.selector) == address(newArbiter),
            "commitDisputeClaim: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(ArbiterRegistryFacet.clearDisputeClaim.selector) == address(newArbiter),
            "clearDisputeClaim: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(FactoryFacet.deployAgreement.selector) == address(newFactory),
            "FactoryFacet: wrong facet"
        );

        console.log("\n=== UpgradeSecurityFixes DONE ===");
        console.log("  JobBoardFacet        10 sel  jobFunds ledger + global guard");
        console.log("  ServiceBoardFacet     9 sel  global guard");
        console.log("  OfferNFTFacet        22 sel  global guard");
        console.log("  ArbiterRegistryFacet 11 sel  CEI + commit-reveal + clear + getCommitment");
        console.log("  FactoryFacet         17 sel  new Agreement bytecode (_finalized + syncRegistry)");
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /**
     * Remove all current selectors of the old facet (found via anchorSel),
     * then Add all newSelectors to newFacet.
     *
     * Safe when:
     *   - Some newSelectors didn't exist before (new functions)   → just Added
     *   - All newSelectors existed before (pure implementation upgrade)  → Remove+Add
     *   - Facet was never deployed (anchorSel not found)          → just Add
     *
     * @param anchorSel  A selector that was in the old facet. Used to find its address.
     */
    function _replaceFacet(
        IDiamondCut.FacetCut[] memory cuts,
        uint256 n,
        bytes4 anchorSel,
        address newFacet,
        bytes4[] memory newSelectors
    ) internal view returns (uint256) {
        address oldFacet = IDiamondLoupe(DIAMOND).facetAddress(anchorSel);
        if (oldFacet != address(0) && oldFacet != newFacet) {
            bytes4[] memory oldSels = IDiamondLoupe(DIAMOND).facetFunctionSelectors(oldFacet);
            if (oldSels.length > 0) {
                cuts[n++] = IDiamondCut.FacetCut({
                    facetAddress: address(0),
                    action: IDiamondCut.FacetCutAction.Remove,
                    functionSelectors: oldSels
                });
            }
        }
        cuts[n++] = IDiamondCut.FacetCut({
            facetAddress: newFacet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: newSelectors
        });
        return n;
    }
}
