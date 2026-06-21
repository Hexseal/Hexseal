// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// AddReputationFacet.s.sol
//
// Деплоит ReputationFacet и добавляет его в Diamond.
// Новые селекторы (Add):
//   claimXP(address)
//   getXP(address)
//   getUniqueActiveUsers()
//   hasClaimed(address,address)
//   isDealWin(address)
//
// Usage:
//   forge script script/AddReputationFacet.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/facets/ReputationFacet.sol";
import "../src/DiamondProxy.sol";

contract AddReputationFacet is Script {
    address constant DIAMOND = 0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        ReputationFacet facet = new ReputationFacet();
        console.log("ReputationFacet:", address(facet));

        bytes4[] memory sels = new bytes4[](5);
        sels[0] = ReputationFacet.claimXP.selector;
        sels[1] = ReputationFacet.getXP.selector;
        sels[2] = ReputationFacet.getUniqueActiveUsers.selector;
        sels[3] = ReputationFacet.hasClaimed.selector;
        sels[4] = ReputationFacet.isDealWin.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(facet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sels
        });

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        console.log("=== ReputationFacet deployed ===");
        console.log("  [Add] claimXP(address)");
        console.log("  [Add] getXP(address)");
        console.log("  [Add] getUniqueActiveUsers()");
        console.log("  [Add] hasClaimed(address,address)");
        console.log("  [Add] isDealWin(address)");

        require(
            IDiamondLoupe(DIAMOND).facetAddress(ReputationFacet.claimXP.selector) == address(facet),
            "claimXP: wrong facet"
        );
        console.log("Verification passed.");

        vm.stopBroadcast();
    }
}
