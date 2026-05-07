// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeOfferNFTSVG.s.sol
//
// Архитектурный рефактор:
//   - OfferNFTFacet больше не содержит SVG/JSON рендеринг
//   - SVGRenderer — отдельный внешний контракт (не фасет)
//   - tokenURI() теперь делегирует в ISVGRenderer
//   - Добавлены селекторы: setSvgRenderer, getSvgRenderer
//   - Все 22 существующих селектора заменяются новой реализацией
//
// После апгрейда: tokenURI работает через внешний SVGRenderer —
// OfferNFTFacet теперь 8.4 KB вместо 24.3 KB.
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DiamondProxy.sol";
import "../src/OfferNFTFacet.sol";
import "../src/SVGRenderer.sol";

contract UpgradeOfferNFTSVG is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address diamond = vm.envOr("DIAMOND_ADDRESS", address(0xF00CC71878c226E0b64253Fb71dD802aF12165D0));

        vm.startBroadcast(deployerKey);

        // 1. Deploy external SVGRenderer (holds all SVG/JSON rendering logic)
        SVGRenderer renderer = new SVGRenderer();
        console.log("SVGRenderer deployed at:", address(renderer));

        // 2. Deploy new OfferNFTFacet (now ~8 KB — no inline SVG)
        OfferNFTFacet newOfferNFT = new OfferNFTFacet();
        console.log("New OfferNFTFacet deployed at:", address(newOfferNFT));

        // 3. Build diamond cuts — Replace existing 22 + Add 2 new
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);

        // [0] REPLACE: all 22 existing OfferNFTFacet selectors → new implementation
        // These were registered by UpgradeNFTFacets.s.sol (21 selectors) +
        // mintJobReceipt (1 selector added separately)
        bytes4[] memory replaceSelectors = new bytes4[](22);
        replaceSelectors[0]  = OfferNFTFacet.name.selector;
        replaceSelectors[1]  = OfferNFTFacet.symbol.selector;
        replaceSelectors[2]  = OfferNFTFacet.supportsInterface.selector;
        replaceSelectors[3]  = OfferNFTFacet.balanceOf.selector;
        replaceSelectors[4]  = OfferNFTFacet.ownerOf.selector;
        replaceSelectors[5]  = OfferNFTFacet.tokenURI.selector;
        replaceSelectors[6]  = bytes4(0x23b872dd); // transferFrom(address,address,uint256)
        replaceSelectors[7]  = bytes4(0x42842e0e); // safeTransferFrom(address,address,uint256)
        replaceSelectors[8]  = bytes4(0xb88d4fde); // safeTransferFrom(address,address,uint256,bytes)
        replaceSelectors[9]  = OfferNFTFacet.approve.selector;
        replaceSelectors[10] = OfferNFTFacet.setApprovalForAll.selector;
        replaceSelectors[11] = OfferNFTFacet.getApproved.selector;
        replaceSelectors[12] = OfferNFTFacet.isApprovedForAll.selector;
        replaceSelectors[13] = OfferNFTFacet.mintOffer.selector;
        replaceSelectors[14] = OfferNFTFacet.hireAndCreateDeal.selector;
        replaceSelectors[15] = OfferNFTFacet.deactivateOffer.selector;
        replaceSelectors[16] = OfferNFTFacet.getOffer.selector;
        replaceSelectors[17] = OfferNFTFacet.getExecutorOffers.selector;
        replaceSelectors[18] = OfferNFTFacet.getOfferHires.selector;
        replaceSelectors[19] = OfferNFTFacet.getTotalSupply.selector;
        replaceSelectors[20] = OfferNFTFacet.getActiveOffersCount.selector;
        replaceSelectors[21] = OfferNFTFacet.mintJobReceipt.selector;

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newOfferNFT),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSelectors
        });

        // [1] ADD: 2 new selectors for SVGRenderer management
        bytes4[] memory addSelectors = new bytes4[](2);
        addSelectors[0] = OfferNFTFacet.setSvgRenderer.selector;
        addSelectors[1] = OfferNFTFacet.getSvgRenderer.selector;

        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(newOfferNFT),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: addSelectors
        });

        // 4. Apply cut
        console.log("Applying diamond cut (Replace 22 + Add 2)...");
        IDiamondCut(diamond).diamondCut(cuts, address(0), "");

        // 5. Wire SVGRenderer into storage — must happen after cut adds the selector
        console.log("Setting SVGRenderer in Diamond storage...");
        OfferNFTFacet(diamond).setSvgRenderer(address(renderer));

        console.log("");
        console.log("OfferNFTFacet SVG upgrade complete!");
        console.log("Diamond:         ", diamond);
        console.log("New OfferNFTFacet:", address(newOfferNFT));
        console.log("SVGRenderer:     ", address(renderer));
        console.log("");
        console.log("tokenURI() now delegates SVG/JSON rendering to external SVGRenderer.");
        console.log("All existing offers remain accessible - storage unchanged.");

        vm.stopBroadcast();
    }
}
