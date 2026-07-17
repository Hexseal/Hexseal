// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeReputationFacetDisputePenalty.s.sol
//
// Заменяет ReputationFacet в Diamond: на RESOLVED (спор) XP теперь
// получает только выигравшая сторона, проигравшая теряет часть XP
// (LOSS_XP_PENALTY = WIN_XP / 2, floor 0). Раньше autoAwardXP/claimXP
// начисляли XP обеим сторонам при любом RESOLVED, не глядя на исход —
// проигравший спор исполнитель получал репутацию наравне с честно
// закрытой сделкой.
//
// Функции те же — сигнатуры не менялись, только тело. Все 6 текущих
// селекторов Replace, ничего не добавляется.
//
// Применять вместе с UpgradeAgreementDeployerV3.s.sol (пишет
// Agreement.clientWonDispute, который читает эта версия фасета).
//
// Usage:
//   forge script script/UpgradeReputationFacetDisputePenalty.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/facets/ReputationFacet.sol";
import "../src/DiamondProxy.sol";

contract UpgradeReputationFacetDisputePenalty is Script {
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

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(facet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSels
        });

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        require(
            IDiamondLoupe(DIAMOND).facetAddress(ReputationFacet.autoAwardXP.selector) == address(facet),
            "autoAwardXP: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(ReputationFacet.claimXP.selector) == address(facet),
            "claimXP: wrong facet"
        );
        console.log("Verification passed.");

        vm.stopBroadcast();
    }
}
