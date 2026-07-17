// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeReputationFacetCleanStreak.s.sol
//
// Заменяет ReputationFacet в Diamond: XP выше 1000 теперь гейтится cleanStreak
// исполнителя (>=10 подряд чистых закрытий), клиентский XP выше 1000 заморожен.
// Добавляет notifyExecutorFault() и getCleanStreak() — новые функции.
//
// Replace: claimXP, getXP, getUniqueActiveUsers, hasClaimed, isDealWin, autoAwardXP
// Add:     notifyExecutorFault, getCleanStreak
//
// Применять вместе с UpgradeAgreementDeployerV4.s.sol (вызывает notifyExecutorFault)
// и UpgradeArbiterRegistryFacetDemotion.s.sol (читает cleanStreak).
//
// Usage:
//   forge script script/UpgradeReputationFacetCleanStreak.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/facets/ReputationFacet.sol";
import "../src/DiamondProxy.sol";

contract UpgradeReputationFacetCleanStreak is Script {
    address constant DIAMOND = 0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        ReputationFacet facet = new ReputationFacet();
        console.log("New ReputationFacet:", address(facet));

        bytes4[] memory replaceSels = new bytes4[](6);
        replaceSels[0] = ReputationFacet.claimXP.selector;
        replaceSels[1] = ReputationFacet.getXP.selector;
        replaceSels[2] = ReputationFacet.getUniqueActiveUsers.selector;
        replaceSels[3] = ReputationFacet.hasClaimed.selector;
        replaceSels[4] = ReputationFacet.isDealWin.selector;
        replaceSels[5] = ReputationFacet.autoAwardXP.selector;

        bytes4[] memory addSels = new bytes4[](2);
        addSels[0] = ReputationFacet.notifyExecutorFault.selector;
        addSels[1] = ReputationFacet.getCleanStreak.selector;

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
            IDiamondLoupe(DIAMOND).facetAddress(ReputationFacet.notifyExecutorFault.selector) == address(facet),
            "notifyExecutorFault: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(ReputationFacet.autoAwardXP.selector) == address(facet),
            "autoAwardXP: wrong facet"
        );
        console.log("Verification passed.");

        vm.stopBroadcast();
    }
}
