// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// RemoveServiceBoardFacet.s.sol
//
// Удаляет ServiceBoardFacet из Diamond.
// ServiceBoardFacet дублирует логику OfferNFTFacet без NFT.
//
// Использование:
//   forge script script/RemoveServiceBoardFacet.s.sol \
//     --rpc-url base_sepolia --broadcast -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DiamondProxy.sol";
import "../src/facets/ServiceBoardFacet.sol";

contract RemoveServiceBoardFacet is Script {
    address constant DIAMOND = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        // Проверяем что селектор вообще есть в Diamond перед удалением
        address before = IDiamondLoupe(DIAMOND).facetAddress(ServiceBoardFacet.mintService.selector);
        console.log("ServiceBoardFacet (before):", before);
        if (before == address(0)) {
            console.log("ServiceBoardFacet already not in Diamond, nothing to do.");
            return;
        }

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = ServiceBoardFacet.mintService.selector;
        selectors[1] = ServiceBoardFacet.removeService.selector;
        selectors[2] = ServiceBoardFacet.pauseService.selector;
        selectors[3] = ServiceBoardFacet.unpauseService.selector;
        selectors[4] = ServiceBoardFacet.getService.selector;
        selectors[5] = ServiceBoardFacet.getExecutorServices.selector;
        selectors[6] = ServiceBoardFacet.getServiceClients.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(0),
            action: IDiamondCut.FacetCutAction.Remove,
            functionSelectors: selectors
        });

        vm.startBroadcast(deployerKey);
        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");
        vm.stopBroadcast();

        address after_ = IDiamondLoupe(DIAMOND).facetAddress(ServiceBoardFacet.mintService.selector);
        require(after_ == address(0), "ServiceBoardFacet not removed");
        console.log("ServiceBoardFacet removed from Diamond.");
    }
}
