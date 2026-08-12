// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../../src/facets/DealMetadataFacet.sol";
import "../../src/DiamondProxy.sol";

contract AddDealMetadataFacet is Script {
    address constant DIAMOND = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        DealMetadataFacet facet = new DealMetadataFacet();
        console.log("DealMetadataFacet:", address(facet));

        bytes4[] memory sels = new bytes4[](1);
        sels[0] = DealMetadataFacet.getDealTokenURI.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress:      address(facet),
            action:            IDiamondCut.FacetCutAction.Add,
            functionSelectors: sels
        });

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");
        console.log("Done. Agreement NFTs will now show on-chain SVG with dynamic status.");

        vm.stopBroadcast();
    }
}
