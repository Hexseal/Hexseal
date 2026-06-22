// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeReputationFacet.s.sol
//
// Заменяет ReputationFacet в Diamond — добавляет autoAwardXP().
// Replace: claimXP, getXP, getUniqueActiveUsers, hasClaimed, isDealWin
// Add:     autoAwardXP
//
// Usage:
//   forge script script/UpgradeReputationFacet.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/facets/ReputationFacet.sol";
import "../src/DiamondProxy.sol";

contract UpgradeReputationFacet is Script {
    address constant DIAMOND = 0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        ReputationFacet facet = new ReputationFacet();
        console.log("New ReputationFacet:", address(facet));

        // Replace existing 5 selectors with new implementation
        bytes4[] memory replaceSels = new bytes4[](5);
        replaceSels[0] = ReputationFacet.claimXP.selector;
        replaceSels[1] = ReputationFacet.getXP.selector;
        replaceSels[2] = ReputationFacet.getUniqueActiveUsers.selector;
        replaceSels[3] = ReputationFacet.hasClaimed.selector;
        replaceSels[4] = ReputationFacet.isDealWin.selector;

        // Add new autoAwardXP selector
        bytes4[] memory addSels = new bytes4[](1);
        addSels[0] = ReputationFacet.autoAwardXP.selector;

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
