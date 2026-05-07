// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeServiceBoardPermit.s.sol
//
// Добавляет requestServiceWithPermit в Diamond:
//   - Деплоит новый ServiceBoardFacet (с новой функцией)
//   - ADD action: только новый селектор requestServiceWithPermit
//
// Существующие ServiceBoardFacet селекторы продолжают работать
// со старым деплоем — Diamond storage общая, всё совместимо.
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/facets/ServiceBoardFacet.sol";
import "../src/DiamondProxy.sol";

contract UpgradeServiceBoardPermit is Script {
    address constant DIAMOND = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        // 1. Deploy new ServiceBoardFacet (contains requestServiceWithPermit)
        ServiceBoardFacet newFacet = new ServiceBoardFacet();
        console.log("New ServiceBoardFacet:", address(newFacet));

        // 2. ADD only the new selector
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);

        bytes4[] memory sels = new bytes4[](1);
        sels[0] = ServiceBoardFacet.requestServiceWithPermit.selector;

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sels
        });

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        console.log("Done! requestServiceWithPermit added to Diamond.");
        vm.stopBroadcast();
    }
}
