// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// MigrateToJobReceiptFacet.s.sol
//
// Выпиливает OfferNFTFacet из Diamond, заменяет на JobReceiptFacet.
//
// [Replace] 16 селекторов → новый JobReceiptFacet:
//   ERC-721 base: name, symbol, supportsInterface, balanceOf, ownerOf, tokenURI
//   Soulbound stubs: transferFrom (x3), approve, setApprovalForAll, getApproved, isApprovedForAll
//   Core: mintJobReceipt
//   Admin: setSvgRenderer, getSvgRenderer
//
// [Remove] 8 мёртвых Offer-селекторов:
//   mintOffer, hireAndCreateDeal, deactivateOffer,
//   getOffer, getExecutorOffers, getOfferHires,
//   getTotalSupply, getActiveOffersCount
//
// [Add] 3 новых view-функции:
//   getJobReceiptData, isJobReceiptToken, getReceiptTotalSupply
//
// Storage slot не меняется — все существующие квитанции сохраняются.
// SVGRenderer уже задан в storage (UpgradeOfferNFTSVG.s.sol), не трогаем.
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DiamondProxy.sol";
import "../src/JobReceiptFacet.sol";

contract MigrateToJobReceiptFacet is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address diamond = vm.envOr("DIAMOND_ADDRESS", address(0xF00CC71878c226E0b64253Fb71dD802aF12165D0));

        vm.startBroadcast(deployerKey);

        // 1. Deploy new JobReceiptFacet
        JobReceiptFacet receiptFacet = new JobReceiptFacet();
        console.log("JobReceiptFacet deployed at:", address(receiptFacet));

        // 2. Build cuts
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](3);

        // [0] REPLACE: 16 selectors that exist in Diamond (from OfferNFTFacet)
        bytes4[] memory replaceSelectors = new bytes4[](16);
        replaceSelectors[0]  = JobReceiptFacet.name.selector;
        replaceSelectors[1]  = JobReceiptFacet.symbol.selector;
        replaceSelectors[2]  = bytes4(0x01ffc9a7); // supportsInterface(bytes4) — историческая замена, функция с тех пор удалена из JobReceiptFacet
        replaceSelectors[3]  = JobReceiptFacet.balanceOf.selector;
        replaceSelectors[4]  = JobReceiptFacet.ownerOf.selector;
        replaceSelectors[5]  = JobReceiptFacet.tokenURI.selector;
        replaceSelectors[6]  = bytes4(0x23b872dd); // transferFrom(address,address,uint256)
        replaceSelectors[7]  = bytes4(0x42842e0e); // safeTransferFrom(address,address,uint256)
        replaceSelectors[8]  = bytes4(0xb88d4fde); // safeTransferFrom(address,address,uint256,bytes)
        replaceSelectors[9]  = JobReceiptFacet.approve.selector;
        replaceSelectors[10] = JobReceiptFacet.setApprovalForAll.selector;
        replaceSelectors[11] = JobReceiptFacet.getApproved.selector;
        replaceSelectors[12] = JobReceiptFacet.isApprovedForAll.selector;
        replaceSelectors[13] = JobReceiptFacet.mintJobReceipt.selector;
        replaceSelectors[14] = JobReceiptFacet.setSvgRenderer.selector;
        replaceSelectors[15] = JobReceiptFacet.getSvgRenderer.selector;

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(receiptFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSelectors
        });

        // [1] REMOVE: 8 dead Offer-specific selectors
        bytes4[] memory removeSelectors = new bytes4[](8);
        removeSelectors[0] = bytes4(keccak256("mintOffer(string,string,uint256,uint256,string)"));
        removeSelectors[1] = bytes4(keccak256("hireAndCreateDeal(uint256,address,bytes32,uint8)"));
        removeSelectors[2] = bytes4(keccak256("deactivateOffer(uint256)"));
        removeSelectors[3] = bytes4(keccak256("getOffer(uint256)"));
        removeSelectors[4] = bytes4(keccak256("getExecutorOffers(address)"));
        removeSelectors[5] = bytes4(keccak256("getOfferHires(uint256)"));
        removeSelectors[6] = bytes4(keccak256("getTotalSupply()"));
        removeSelectors[7] = bytes4(keccak256("getActiveOffersCount()"));

        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(0),
            action: IDiamondCut.FacetCutAction.Remove,
            functionSelectors: removeSelectors
        });

        // [2] ADD: 3 new receipt view functions
        bytes4[] memory addSelectors = new bytes4[](3);
        addSelectors[0] = JobReceiptFacet.getJobReceiptData.selector;
        addSelectors[1] = JobReceiptFacet.isJobReceiptToken.selector;
        addSelectors[2] = JobReceiptFacet.getReceiptTotalSupply.selector;

        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(receiptFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: addSelectors
        });

        // 3. Apply
        console.log("Applying diamond cut (Replace 16 + Remove 8 + Add 3)...");
        IDiamondCut(diamond).diamondCut(cuts, address(0), "");

        console.log("");
        console.log("Migration complete!");
        console.log("Diamond:          ", diamond);
        console.log("JobReceiptFacet:  ", address(receiptFacet));
        console.log("");
        console.log("OfferNFTFacet removed. JobReceiptFacet active.");
        console.log("SVGRenderer wiring preserved (same storage slot).");

        vm.stopBroadcast();
    }
}
