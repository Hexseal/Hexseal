// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DiamondProxy.sol";
import "../src/facets/ServiceBoardFacet.sol";

/**
 * UpgradeServiceBoardFacet
 *
 * Что меняется:
 *   REMOVE: hireService (старый instant-hire, 1 selector)
 *   REPLACE: mintService, removeService, pauseService, unpauseService,
 *            getService, getExecutorServices, getServiceClients, totalServices (8 selectors)
 *   ADD: requestService, acceptRequest, rejectRequest, cancelRequest,
 *        getRequest, getServiceRequests, getClientRequests, totalRequests,
 *        getRequestFunds, getActiveServices, getPendingRequests (11 selectors)
 */
contract UpgradeServiceBoardFacet is Script {
    address constant DIAMOND = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        ServiceBoardFacet newFacet = new ServiceBoardFacet();
        console.log("New ServiceBoardFacet deployed at:", address(newFacet));

        // --- Selectors to REPLACE (all, including mintServiceWithPermit added last upgrade) ---
        bytes4[] memory replaceSelectors = new bytes4[](20);
        replaceSelectors[0]  = ServiceBoardFacet.mintService.selector;
        replaceSelectors[1]  = ServiceBoardFacet.mintServiceWithPermit.selector;
        replaceSelectors[2]  = ServiceBoardFacet.removeService.selector;
        replaceSelectors[3]  = ServiceBoardFacet.pauseService.selector;
        replaceSelectors[4]  = ServiceBoardFacet.unpauseService.selector;
        replaceSelectors[5]  = ServiceBoardFacet.getService.selector;
        replaceSelectors[6]  = ServiceBoardFacet.getExecutorServices.selector;
        replaceSelectors[7]  = ServiceBoardFacet.getServiceClients.selector;
        replaceSelectors[8]  = ServiceBoardFacet.totalServices.selector;
        replaceSelectors[9]  = ServiceBoardFacet.requestService.selector;
        replaceSelectors[10] = ServiceBoardFacet.acceptRequest.selector;
        replaceSelectors[11] = ServiceBoardFacet.rejectRequest.selector;
        replaceSelectors[12] = ServiceBoardFacet.cancelRequest.selector;
        replaceSelectors[13] = ServiceBoardFacet.getRequest.selector;
        replaceSelectors[14] = ServiceBoardFacet.getServiceRequests.selector;
        replaceSelectors[15] = ServiceBoardFacet.getClientRequests.selector;
        replaceSelectors[16] = ServiceBoardFacet.totalRequests.selector;
        replaceSelectors[17] = ServiceBoardFacet.getRequestFunds.selector;
        replaceSelectors[18] = ServiceBoardFacet.getActiveServices.selector;
        replaceSelectors[19] = ServiceBoardFacet.getPendingRequests.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSelectors
        });

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");
        console.log("ServiceBoardFacet upgraded: 20 replaced (requestService fee removed)");

        vm.stopBroadcast();

        // Verify
        address check = IDiamondLoupe(DIAMOND).facetAddress(ServiceBoardFacet.requestService.selector);
        require(check == address(newFacet), "requestService: wrong facet");
        address check2 = IDiamondLoupe(DIAMOND).facetAddress(ServiceBoardFacet.acceptRequest.selector);
        require(check2 == address(newFacet), "acceptRequest: wrong facet");
        console.log("=== UPGRADE DONE ===");
    }
}
