// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

// ============================================================
// UpgradeServiceBoardFacetSupersede.s.sol
//
// Заменяет ServiceBoardFacet в Diamond: acceptRequest() теперь авто-
// рефандит и помечает SUPERSEDED любые другие PENDING-запросы того же
// клиента к тому же исполнителю (они всё равно никогда не будут приняты
// — hasActivePair блокирует их навсегда). Новый getPendingRequestIdsBy-
// ClientAndExecutor() — view-геттер для этого списка.
//
// Replace: все существующие 22 селектора (whole-facet redeploy).
// Add:     getPendingRequestIdsByClientAndExecutor
//
// Usage:
//   forge script script/UpgradeServiceBoardFacetSupersede.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/facets/ServiceBoardFacet.sol";
import "../src/DiamondProxy.sol";

contract UpgradeServiceBoardFacetSupersede is Script {
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

        bytes4[] memory addSels = new bytes4[](1);
        addSels[0] = ServiceBoardFacet.getPendingRequestIdsByClientAndExecutor.selector;

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
            IDiamondLoupe(DIAMOND).facetAddress(ServiceBoardFacet.acceptRequest.selector) == address(facet),
            "acceptRequest: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(ServiceBoardFacet.getPendingRequestIdsByClientAndExecutor.selector) == address(facet),
            "getPendingRequestIdsByClientAndExecutor: wrong facet"
        );
        console.log("Verification passed.");

        vm.stopBroadcast();
    }
}
