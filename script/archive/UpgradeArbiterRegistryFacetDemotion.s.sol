// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

// ============================================================
// UpgradeArbiterRegistryFacetDemotion.s.sol
//
// Заменяет ArbiterRegistryFacet в Diamond: арбитр теряет статус после 3 подряд
// судейских ошибок (overturnVerdict или таймаут резолва) — фиксированный сброс XP
// до 2500, cleanStreak исполнителя не трогается. applyAsArbiter() теперь требует
// и xp>=3000, и cleanStreak>=10.
//
// Replace: все существующие 33 селектора (whole-facet redeploy — устоявшийся
//   паттерн в этом репо, см. UpgradeReputationFacetDisputePenalty.s.sol).
// Add:     notifyArbiterTimeout, getArbiterMistakeStreak
//
// Применять вместе с UpgradeAgreementDeployerV4.s.sol (вызывает notifyArbiterTimeout)
// и UpgradeReputationFacetCleanStreak.s.sol (источник cleanStreak).
//
// Usage:
//   forge script script/UpgradeArbiterRegistryFacetDemotion.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../../src/facets/ArbiterRegistryFacet.sol";
import "../../src/DiamondProxy.sol";

contract UpgradeArbiterRegistryFacetDemotion is Script {
    address constant DIAMOND = 0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        ArbiterRegistryFacet facet = new ArbiterRegistryFacet();
        console.log("New ArbiterRegistryFacet:", address(facet));

        bytes4[] memory replaceSels = new bytes4[](33);
        replaceSels[0]  = ArbiterRegistryFacet.setChiefArbiter.selector;
        replaceSels[1]  = ArbiterRegistryFacet.addArbiter.selector;
        replaceSels[2]  = ArbiterRegistryFacet.removeArbiter.selector;
        replaceSels[3]  = ArbiterRegistryFacet.commitDisputeClaim.selector;
        replaceSels[4]  = bytes4(keccak256("claimDispute(address,bytes32)")) /* frozen: old 2-arg selector, historical cut */;
        replaceSels[5]  = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        replaceSels[6]  = ArbiterRegistryFacet.clearDisputeClaim.selector;
        replaceSels[7]  = ArbiterRegistryFacet.getChiefArbiter.selector;
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
        replaceSels[31] = ArbiterRegistryFacet.getDAOAddress.selector;
        replaceSels[32] = ArbiterRegistryFacet.clearStuckVerdict.selector;

        bytes4[] memory addSels = new bytes4[](2);
        addSels[0] = ArbiterRegistryFacet.notifyArbiterTimeout.selector;
        addSels[1] = ArbiterRegistryFacet.getArbiterMistakeStreak.selector;

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
            IDiamondLoupe(DIAMOND).facetAddress(ArbiterRegistryFacet.notifyArbiterTimeout.selector) == address(facet),
            "notifyArbiterTimeout: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(ArbiterRegistryFacet.applyAsArbiter.selector) == address(facet),
            "applyAsArbiter: wrong facet"
        );
        console.log("Verification passed.");

        vm.stopBroadcast();
    }
}
