// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

// ============================================================
// PatchArbiterClearStuck.s.sol
//
// Добавляет clearStuckVerdict(address) — аварийная очистка
// зависшего pendingVerdict после triggerArbiterTimeout.
//
// Usage:
//   forge script script/PatchArbiterClearStuck.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/facets/ArbiterRegistryFacet.sol";
import "../src/DiamondProxy.sol";

contract PatchArbiterClearStuck is Script {
    address constant DIAMOND = 0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        ArbiterRegistryFacet newFacet = new ArbiterRegistryFacet();
        console.log("New ArbiterRegistryFacet:", address(newFacet));

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);

        // Replace all existing selectors with new facet (contains clearStuckVerdict)
        bytes4[] memory replaceSels = new bytes4[](31);
        replaceSels[0]  = ArbiterRegistryFacet.addArbiter.selector;
        replaceSels[1]  = ArbiterRegistryFacet.removeArbiter.selector;
        replaceSels[2]  = ArbiterRegistryFacet.setChiefArbiter.selector;
        replaceSels[3]  = ArbiterRegistryFacet.getChiefArbiter.selector;
        replaceSels[4]  = ArbiterRegistryFacet.commitDisputeClaim.selector;
        replaceSels[5]  = ArbiterRegistryFacet.claimDispute.selector;
        replaceSels[6]  = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        replaceSels[7]  = ArbiterRegistryFacet.clearDisputeClaim.selector;
        replaceSels[8]  = ArbiterRegistryFacet.isRegisteredArbiter.selector;
        replaceSels[9]  = ArbiterRegistryFacet.getArbiters.selector;
        replaceSels[10] = ArbiterRegistryFacet.getDisputeClaimer.selector;
        replaceSels[11] = ArbiterRegistryFacet.getArbiterDeals.selector;
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
        replaceSels[28] = ArbiterRegistryFacet.getArbiterReward.selector;
        replaceSels[29] = ArbiterRegistryFacet.getVaultBalance.selector;
        replaceSels[30] = ArbiterRegistryFacet.getRewardPerDispute.selector;

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSels
        });

        // Add new selector: clearStuckVerdict + getDAOAddress (was missed in V3 replace list)
        bytes4[] memory addSels = new bytes4[](1);
        addSels[0] = ArbiterRegistryFacet.clearStuckVerdict.selector;

        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: addSels
        });

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        require(
            IDiamondLoupe(DIAMOND).facetAddress(ArbiterRegistryFacet.clearStuckVerdict.selector) == address(newFacet),
            "clearStuckVerdict: wrong facet"
        );
        console.log("Patch applied. clearStuckVerdict added.");

        vm.stopBroadcast();
    }
}
