// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeReceiptSVGs.s.sol
//
// Апгрейд SVG-стилей двух NFT:
//   OfferNFTFacet  — Job Receipt: белый → тёмный, эффект чека сохранён
//   DealMetadataFacet — Deal NFT: добавлен tearline, унифицирован хедер
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/OfferNFTFacet.sol";
import "../src/facets/DealMetadataFacet.sol";
import "../src/DiamondProxy.sol";

contract UpgradeReceiptSVGs is Script {
    address constant DIAMOND = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        // ── 1. Deploy new facets ──────────────────────────────────────────────

        OfferNFTFacet newOfferNFT = new OfferNFTFacet();
        console.log("New OfferNFTFacet:", address(newOfferNFT));

        DealMetadataFacet newMeta = new DealMetadataFacet();
        console.log("New DealMetadataFacet:", address(newMeta));

        // ── 2. Build cuts ─────────────────────────────────────────────────────

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);

        // [0] REPLACE: все OfferNFTFacet селекторы (SVG изменился, ABI не менялся)
        bytes4[] memory offerSels = new bytes4[](22);
        offerSels[0]  = OfferNFTFacet.name.selector;
        offerSels[1]  = OfferNFTFacet.symbol.selector;
        offerSels[2]  = OfferNFTFacet.supportsInterface.selector;
        offerSels[3]  = OfferNFTFacet.balanceOf.selector;
        offerSels[4]  = OfferNFTFacet.ownerOf.selector;
        offerSels[5]  = OfferNFTFacet.tokenURI.selector;
        offerSels[6]  = bytes4(0x23b872dd); // transferFrom(address,address,uint256)
        offerSels[7]  = bytes4(0x42842e0e); // safeTransferFrom(address,address,uint256)
        offerSels[8]  = bytes4(0xb88d4fde); // safeTransferFrom(address,address,uint256,bytes)
        offerSels[9]  = OfferNFTFacet.approve.selector;
        offerSels[10] = OfferNFTFacet.setApprovalForAll.selector;
        offerSels[11] = OfferNFTFacet.getApproved.selector;
        offerSels[12] = OfferNFTFacet.isApprovedForAll.selector;
        offerSels[13] = OfferNFTFacet.mintOffer.selector;
        offerSels[14] = OfferNFTFacet.mintJobReceipt.selector;
        offerSels[15] = OfferNFTFacet.hireAndCreateDeal.selector;
        offerSels[16] = OfferNFTFacet.deactivateOffer.selector;
        offerSels[17] = OfferNFTFacet.getOffer.selector;
        offerSels[18] = OfferNFTFacet.getExecutorOffers.selector;
        offerSels[19] = OfferNFTFacet.getOfferHires.selector;
        offerSels[20] = OfferNFTFacet.getTotalSupply.selector;
        offerSels[21] = OfferNFTFacet.getActiveOffersCount.selector;
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newOfferNFT),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: offerSels
        });

        // [1] REPLACE: DealMetadataFacet.getDealTokenURI (SVG изменился)
        bytes4[] memory metaSels = new bytes4[](1);
        metaSels[0] = DealMetadataFacet.getDealTokenURI.selector;
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(newMeta),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: metaSels
        });

        // ── 3. Execute ────────────────────────────────────────────────────────

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        console.log("Done! Both NFT SVGs updated to unified dark receipt style.");
        vm.stopBroadcast();
    }
}
