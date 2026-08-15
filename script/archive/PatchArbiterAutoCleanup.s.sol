// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

// ============================================================
// PatchArbiterAutoCleanup.s.sol
//
// Автоматическая очистка застрявшего pendingVerdict.
// Добавляет флаг `executing` в PendingVerdict и патчит
// clearDisputeClaim — теперь автоматически удаляет зависший
// вердикт когда Agreement выходит через таймаут (без onlyOwner).
//
// Usage:
//   forge script script/PatchArbiterAutoCleanup.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY \
//     --broadcast --skip-simulation -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../../src/facets/ArbiterRegistryFacet.sol";
import "../../src/DiamondProxy.sol";

contract PatchArbiterAutoCleanup is Script {
    address constant DIAMOND = 0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        ArbiterRegistryFacet newFacet = new ArbiterRegistryFacet();
        console.log("New ArbiterRegistryFacet:", address(newFacet));

        // Replace all 32 registered selectors with new implementation
        // (31 from V3 + clearStuckVerdict added via PatchArbiterClearStuck)
        bytes4[] memory replaceSels = new bytes4[](32);
        replaceSels[0]  = ArbiterRegistryFacet.addArbiter.selector;
        replaceSels[1]  = bytes4(0x3487e08c) /* removeArbiter(address), удалена 15 августа 2026 (задача 6 arbiter-accountability) */;
        replaceSels[2]  = ArbiterRegistryFacet.setChiefArbiter.selector;
        replaceSels[3]  = ArbiterRegistryFacet.getChiefArbiter.selector;
        replaceSels[4]  = ArbiterRegistryFacet.commitDisputeClaim.selector;
        replaceSels[5]  = bytes4(keccak256("claimDispute(address,bytes32)")) /* frozen: old 2-arg selector, historical cut */;
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
        replaceSels[31] = ArbiterRegistryFacet.clearStuckVerdict.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSels
        });

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        // Verify key selectors point to new facet
        require(
            IDiamondLoupe(DIAMOND).facetAddress(ArbiterRegistryFacet.clearDisputeClaim.selector) == address(newFacet),
            "clearDisputeClaim: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(ArbiterRegistryFacet.finalizeVerdict.selector) == address(newFacet),
            "finalizeVerdict: wrong facet"
        );
        console.log("Patch applied. Auto-cleanup on clearDisputeClaim active.");

        vm.stopBroadcast();
    }
}
