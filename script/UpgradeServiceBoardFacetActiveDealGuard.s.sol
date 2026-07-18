// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeServiceBoardFacetActiveDealGuard.s.sol
//
// Заменяет ServiceBoardFacet в Diamond: requestService() и
// requestServiceWithPermit() теперь проверяют hasActivePair(client,
// executor) ДО того как деньги клиента уходят в Diamond. Раньше запрос
// проходил даже если у клиента с этим исполнителем уже была активная
// сделка, а acceptRequest() потом всегда падал на deployAgreement()'s
// собственной ActiveDealExists() проверке — единственный выход был
// cancelRequest() на рефанд. Теперь requestService() сам ревертит
// ServiceBoardFacet.ActiveDealExists() сразу, деньги не блокируются.
//
// Replace: все существующие 22 селектора (whole-facet redeploy — заодно
//   консолидирует фрагментацию: на live Diamond mintService/requestService
//   и вся остальная часть фасета сейчас на РАЗНЫХ адресах из-за прошлых
//   частичных апгрейдов; этот cut сводит всё к одному новому адресу).
//
// Usage:
//   forge script script/UpgradeServiceBoardFacetActiveDealGuard.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/facets/ServiceBoardFacet.sol";
import "../src/DiamondProxy.sol";

contract UpgradeServiceBoardFacetActiveDealGuard is Script {
    address constant DIAMOND = 0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        ServiceBoardFacet facet = new ServiceBoardFacet();
        console.log("New ServiceBoardFacet:", address(facet));

        bytes4[] memory replaceSels = new bytes4[](22);
        replaceSels[0]  = ServiceBoardFacet.mintService.selector;
        replaceSels[1]  = ServiceBoardFacet.mintServiceWithPermit.selector;
        replaceSels[2]  = ServiceBoardFacet.requestService.selector;
        replaceSels[3]  = ServiceBoardFacet.requestServiceWithPermit.selector;
        replaceSels[4]  = ServiceBoardFacet.acceptRequest.selector;
        replaceSels[5]  = ServiceBoardFacet.rejectRequest.selector;
        replaceSels[6]  = ServiceBoardFacet.cancelRequest.selector;
        replaceSels[7]  = ServiceBoardFacet.removeService.selector;
        replaceSels[8]  = ServiceBoardFacet.pauseService.selector;
        replaceSels[9]  = ServiceBoardFacet.unpauseService.selector;
        replaceSels[10] = ServiceBoardFacet.getService.selector;
        replaceSels[11] = ServiceBoardFacet.getExecutorServices.selector;
        replaceSels[12] = ServiceBoardFacet.getServiceClients.selector;
        replaceSels[13] = ServiceBoardFacet.getRequest.selector;
        replaceSels[14] = ServiceBoardFacet.getServiceRequests.selector;
        replaceSels[15] = ServiceBoardFacet.getClientRequests.selector;
        replaceSels[16] = ServiceBoardFacet.totalServices.selector;
        replaceSels[17] = ServiceBoardFacet.editService.selector;
        replaceSels[18] = ServiceBoardFacet.totalRequests.selector;
        replaceSels[19] = ServiceBoardFacet.getRequestFunds.selector;
        replaceSels[20] = ServiceBoardFacet.getActiveServices.selector;
        replaceSels[21] = ServiceBoardFacet.getPendingRequests.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(facet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSels
        });

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        require(
            IDiamondLoupe(DIAMOND).facetAddress(ServiceBoardFacet.requestService.selector) == address(facet),
            "requestService: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(ServiceBoardFacet.requestServiceWithPermit.selector) == address(facet),
            "requestServiceWithPermit: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(ServiceBoardFacet.mintService.selector) == address(facet),
            "mintService: wrong facet"
        );
        console.log("Verification passed.");

        vm.stopBroadcast();
    }
}
