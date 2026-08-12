// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../../src/DiamondProxy.sol";
import "../../src/facets/ServiceBoardFacet.sol";

/// @notice Upgrades ServiceBoardFacet to emit title/description/price/deadlineDays in events.
///         Eliminates try_getService() RPC calls from the subgraph indexer.
contract UpgradeServiceBoardFacetV2 is Script {
    function run() external {
        address diamond = vm.envAddress("DIAMOND_ADDRESS");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        ServiceBoardFacet newFacet = new ServiceBoardFacet();
        console.log("New ServiceBoardFacet deployed at:", address(newFacet));

        bytes4[] memory selectors = new bytes4[](22);
        selectors[0]  = ServiceBoardFacet.mintService.selector;
        selectors[1]  = ServiceBoardFacet.mintServiceWithPermit.selector;
        selectors[2]  = ServiceBoardFacet.removeService.selector;
        selectors[3]  = ServiceBoardFacet.pauseService.selector;
        selectors[4]  = ServiceBoardFacet.unpauseService.selector;
        selectors[5]  = ServiceBoardFacet.editService.selector;
        selectors[6]  = ServiceBoardFacet.requestService.selector;
        selectors[7]  = ServiceBoardFacet.requestServiceWithPermit.selector;
        selectors[8]  = ServiceBoardFacet.acceptRequest.selector;
        selectors[9]  = ServiceBoardFacet.rejectRequest.selector;
        selectors[10] = ServiceBoardFacet.cancelRequest.selector;
        selectors[11] = ServiceBoardFacet.getService.selector;
        selectors[12] = ServiceBoardFacet.getExecutorServices.selector;
        selectors[13] = ServiceBoardFacet.getServiceClients.selector;
        selectors[14] = ServiceBoardFacet.totalServices.selector;
        selectors[15] = ServiceBoardFacet.getRequest.selector;
        selectors[16] = ServiceBoardFacet.getServiceRequests.selector;
        selectors[17] = ServiceBoardFacet.getClientRequests.selector;
        selectors[18] = ServiceBoardFacet.totalRequests.selector;
        selectors[19] = ServiceBoardFacet.getRequestFunds.selector;
        selectors[20] = ServiceBoardFacet.getActiveServices.selector;
        selectors[21] = ServiceBoardFacet.getPendingRequests.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: selectors
        });

        IDiamondCut(diamond).diamondCut(cuts, address(0), "");
        console.log("ServiceBoardFacet v2 upgraded at diamond:", diamond);

        vm.stopBroadcast();

        address check = IDiamondLoupe(diamond).facetAddress(ServiceBoardFacet.mintService.selector);
        require(check == address(newFacet), "mintService: wrong facet after upgrade");
        console.log("=== ServiceBoardFacet V2 DONE ===");
    }
}
