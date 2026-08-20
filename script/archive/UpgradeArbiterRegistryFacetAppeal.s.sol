// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

// ============================================================
// UpgradeArbiterRegistryFacetAppeal.s.sol
//
// 1. Deploys a new AgreementDeployer (new Agreement.sol bytecode: moved
//    DISPUTE_WINDOW check from resolveDispute/triggerArbiterTimeout
//    execution-time to submitVerdict submission-time) and points
//    FactoryFacet at it via setAgreementDeployer(). Only affects deals
//    created after this runs — already-deployed Agreement instances keep
//    their original (already-correct-for-their-time) bytecode.
// 2. Replaces ArbiterRegistryFacet (44 selectors total after this upgrade):
//    - 38 pre-existing selectors (already live on the diamond) go through
//      FacetCutAction.Replace: FINALIZE_DELAY 1h -> 24h, submitVerdict
//      DISPUTE_WINDOW check, etc.
//    - 6 brand-new selectors introduced by THIS plan (Tasks 2-5; never
//      deployed before) go through FacetCutAction.Add instead:
//      hasSubmittedVerdict, raiseAppeal, voteOnAppeal, resolveAppeal,
//      getAppealVotes, hasVotedOnAppeal. Diamond's Replace path calls
//      removeFunction() on whatever facet is CURRENTLY registered for a
//      selector and reverts with "Diamond: selector not found" if none is
//      — so any of these 6 must go in addSels, never replaceSels, or the
//      real diamondCut() reverts entirely.
//
// Usage:
//   forge script script/UpgradeArbiterRegistryFacetAppeal.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL -vvv
//   (dry run — add --private-key $PRIVATE_KEY --broadcast only when
//   actually deploying)
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../../src/facets/ArbiterRegistryFacet.sol";
import {ArbiterAccountabilityFacet} from "../../src/facets/ArbiterAccountabilityFacet.sol";
import "../../src/FactoryFacet.sol";
import "../../src/AgreementDeployer.sol";
import "../../src/DiamondProxy.sol";

contract UpgradeArbiterRegistryFacetAppeal is Script {
    address constant DIAMOND = 0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        // ── 1. New AgreementDeployer (new Agreement.sol bytecode) ─────────────
        Agreement agreementImpl = new Agreement();
        AgreementDeployer newAgreementDeployer = new AgreementDeployer(DIAMOND, address(agreementImpl));
        console.log("New AgreementDeployer:", address(newAgreementDeployer));

        FactoryFacet(DIAMOND).setAgreementDeployer(address(newAgreementDeployer));
        require(
            FactoryFacet(DIAMOND).getAgreementDeployer() == address(newAgreementDeployer),
            "setAgreementDeployer did not take effect"
        );
        console.log("FactoryFacet now points at the new AgreementDeployer.");

        // ── 2. Replace ArbiterRegistryFacet (whole-facet redeploy) ────────────
        ArbiterRegistryFacet facet = new ArbiterRegistryFacet();
        console.log("New ArbiterRegistryFacet:", address(facet));

        bytes4[] memory replaceSels = new bytes4[](38);
        replaceSels[0]  = ArbiterRegistryFacet.setChiefArbiter.selector;
        replaceSels[1]  = ArbiterRegistryFacet.addArbiter.selector;
        replaceSels[2]  = bytes4(0x3487e08c) /* removeArbiter(address), удалена 15 августа 2026 (задача 6 arbiter-accountability) */;
        replaceSels[3]  = ArbiterRegistryFacet.commitDisputeClaim.selector;
        replaceSels[4]  = bytes4(keccak256("claimDispute(address,bytes32)")) /* frozen: old 2-arg selector, historical cut */;
        replaceSels[5]  = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        replaceSels[6]  = ArbiterRegistryFacet.clearDisputeClaim.selector;
        replaceSels[7]  = ArbiterRegistryFacet.getChiefArbiter.selector;
        replaceSels[8]  = ArbiterRegistryFacet.isRegisteredArbiter.selector;
        replaceSels[9]  = ArbiterRegistryFacet.getArbiters.selector;
        replaceSels[10] = ArbiterRegistryFacet.getDisputeClaimer.selector;
        replaceSels[11] = ArbiterAccountabilityFacet.getArbiterDeals.selector;
        replaceSels[12] = ArbiterRegistryFacet.getClaimCommitment.selector;
        replaceSels[13] = ArbiterRegistryFacet.activateDAO.selector;
        replaceSels[14] = ArbiterRegistryFacet.applyAsArbiter.selector;
        replaceSels[15] = ArbiterRegistryFacet.isDaoActive.selector;
        replaceSels[16] = ArbiterRegistryFacet.getMinXPToRegister.selector;
        replaceSels[17] = ArbiterRegistryFacet.getDaoThreshold.selector;
        replaceSels[18] = ArbiterRegistryFacet.submitVerdict.selector;
        replaceSels[19] = ArbiterRegistryFacet.finalizeVerdict.selector;
        replaceSels[20] = ArbiterRegistryFacet.overturnVerdict.selector;
        replaceSels[21] = ArbiterRegistryFacet.freezeVerdict.selector;
        replaceSels[22] = ArbiterRegistryFacet.unfreezeVerdict.selector;
        replaceSels[23] = ArbiterRegistryFacet.withdrawArbiterReward.selector;
        replaceSels[24] = ArbiterRegistryFacet.fundVault.selector;
        replaceSels[25] = ArbiterRegistryFacet.setRewardPerDispute.selector;
        replaceSels[26] = ArbiterRegistryFacet.setDAOAddress.selector;
        replaceSels[27] = ArbiterRegistryFacet.getPendingVerdict.selector;
        replaceSels[28] = ArbiterAccountabilityFacet.getArbiterReward.selector;
        replaceSels[29] = ArbiterRegistryFacet.getVaultBalance.selector;
        replaceSels[30] = ArbiterRegistryFacet.getRewardPerDispute.selector;
        replaceSels[31] = ArbiterRegistryFacet.getDAOAddress.selector;
        replaceSels[32] = ArbiterRegistryFacet.clearStuckVerdict.selector;
        replaceSels[33] = ArbiterRegistryFacet.notifyArbiterTimeout.selector;
        replaceSels[34] = ArbiterAccountabilityFacet.getArbiterMistakeStreak.selector;
        replaceSels[35] = ArbiterRegistryFacet.resignAsArbiter.selector;
        replaceSels[36] = ArbiterAccountabilityFacet.getArbiterBond.selector;
        replaceSels[37] = ArbiterAccountabilityFacet.getOpenClaimCount.selector;

        bytes4[] memory addSels = new bytes4[](6);
        addSels[0] = ArbiterRegistryFacet.raiseAppeal.selector;
        addSels[1] = ArbiterRegistryFacet.voteOnAppeal.selector;
        addSels[2] = ArbiterRegistryFacet.resolveAppeal.selector;
        addSels[3] = ArbiterRegistryFacet.getAppealVotes.selector;
        addSels[4] = ArbiterRegistryFacet.hasVotedOnAppeal.selector;
        addSels[5] = ArbiterRegistryFacet.hasSubmittedVerdict.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(facet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSels
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(facet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: addSels
        });

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        require(
            IDiamondLoupe(DIAMOND).facetAddress(ArbiterRegistryFacet.raiseAppeal.selector) == address(facet),
            "raiseAppeal: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(ArbiterRegistryFacet.submitVerdict.selector) == address(facet),
            "submitVerdict: wrong facet"
        );
        console.log("Verification passed.");

        vm.stopBroadcast();
    }
}
