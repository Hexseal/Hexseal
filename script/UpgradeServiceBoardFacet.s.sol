// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DiamondProxy.sol";
import "../src/facets/ServiceBoardFacet.sol";

/**
 * UpgradeServiceBoardFacet — ERC-2771 fix
 *
 * Исправление: removeService, pauseService, unpauseService, acceptRequest,
 * rejectRequest, cancelRequest теперь используют _msgSender() вместо msg.sender,
 * что позволяет вызывать их gaslessly через MinimalForwarder.
 *
 * REPLACE все 21 селектор (включая requestServiceWithPermit из отдельного апгрейда).
 */
contract UpgradeServiceBoardFacet is Script {
    address constant DIAMOND = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        ServiceBoardFacet newFacet = new ServiceBoardFacet();
        console.log("New ServiceBoardFacet deployed at:", address(newFacet));

        bytes4[] memory replaceSelectors = new bytes4[](21);
        replaceSelectors[0]  = ServiceBoardFacet.mintService.selector;
        replaceSelectors[1]  = ServiceBoardFacet.mintServiceWithPermit.selector;
        replaceSelectors[2]  = ServiceBoardFacet.removeService.selector;
        replaceSelectors[3]  = ServiceBoardFacet.pauseService.selector;
        replaceSelectors[4]  = ServiceBoardFacet.unpauseService.selector;
        replaceSelectors[5]  = ServiceBoardFacet.requestService.selector;
        replaceSelectors[6]  = ServiceBoardFacet.requestServiceWithPermit.selector;
        replaceSelectors[7]  = ServiceBoardFacet.acceptRequest.selector;
        replaceSelectors[8]  = ServiceBoardFacet.rejectRequest.selector;
        replaceSelectors[9]  = ServiceBoardFacet.cancelRequest.selector;
        replaceSelectors[10] = ServiceBoardFacet.getService.selector;
        replaceSelectors[11] = ServiceBoardFacet.getExecutorServices.selector;
        replaceSelectors[12] = ServiceBoardFacet.getServiceClients.selector;
        replaceSelectors[13] = ServiceBoardFacet.totalServices.selector;
        replaceSelectors[14] = ServiceBoardFacet.getRequest.selector;
        replaceSelectors[15] = ServiceBoardFacet.getServiceRequests.selector;
        replaceSelectors[16] = ServiceBoardFacet.getClientRequests.selector;
        replaceSelectors[17] = ServiceBoardFacet.totalRequests.selector;
        replaceSelectors[18] = ServiceBoardFacet.getRequestFunds.selector;
        replaceSelectors[19] = ServiceBoardFacet.getActiveServices.selector;
        replaceSelectors[20] = ServiceBoardFacet.getPendingRequests.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSelectors
        });

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");
        console.log("ServiceBoardFacet upgraded: 21 selectors (ERC-2771 fix)");

        vm.stopBroadcast();

        address check = IDiamondLoupe(DIAMOND).facetAddress(ServiceBoardFacet.removeService.selector);
        require(check == address(newFacet), "removeService: wrong facet");
        address check2 = IDiamondLoupe(DIAMOND).facetAddress(ServiceBoardFacet.cancelRequest.selector);
        require(check2 == address(newFacet), "cancelRequest: wrong facet");
        console.log("=== UPGRADE DONE ===");
    }
}
