// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// FixOfferNFTTruncate.s.sol
//
// Фикс: _truncate теперь режет по Unicode code points,
// а не по байтам. Кириллические заголовки больше не ломают SVG.
//
// Операция: REPLACE всех 22 OfferNFTFacet-селекторов.
// Нет Add/Remove — только замена facetAddress.
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/OfferNFTFacet.sol";
import "../src/DiamondProxy.sol";

contract FixOfferNFTTruncate is Script {
    address constant DIAMOND = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        OfferNFTFacet newFacet = new OfferNFTFacet();
        console.log("New OfferNFTFacet:", address(newFacet));

        bytes4[] memory sels = new bytes4[](22);
        sels[0]  = OfferNFTFacet.name.selector;
        sels[1]  = OfferNFTFacet.symbol.selector;
        sels[2]  = OfferNFTFacet.supportsInterface.selector;
        sels[3]  = OfferNFTFacet.balanceOf.selector;
        sels[4]  = OfferNFTFacet.ownerOf.selector;
        sels[5]  = OfferNFTFacet.tokenURI.selector;
        sels[6]  = bytes4(0x23b872dd); // transferFrom(address,address,uint256)
        sels[7]  = bytes4(0x42842e0e); // safeTransferFrom(address,address,uint256)
        sels[8]  = bytes4(0xb88d4fde); // safeTransferFrom(address,address,uint256,bytes)
        sels[9]  = OfferNFTFacet.approve.selector;
        sels[10] = OfferNFTFacet.setApprovalForAll.selector;
        sels[11] = OfferNFTFacet.getApproved.selector;
        sels[12] = OfferNFTFacet.isApprovedForAll.selector;
        sels[13] = OfferNFTFacet.mintOffer.selector;
        sels[14] = OfferNFTFacet.mintJobReceipt.selector;
        sels[15] = OfferNFTFacet.hireAndCreateDeal.selector;
        sels[16] = OfferNFTFacet.deactivateOffer.selector;
        sels[17] = OfferNFTFacet.getOffer.selector;
        sels[18] = OfferNFTFacet.getExecutorOffers.selector;
        sels[19] = OfferNFTFacet.getOfferHires.selector;
        sels[20] = OfferNFTFacet.getTotalSupply.selector;
        sels[21] = OfferNFTFacet.getActiveOffersCount.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress:      address(newFacet),
            action:            IDiamondCut.FacetCutAction.Replace,
            functionSelectors: sels
        });

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        console.log("Done! _truncate fixed: SVG now cuts at Unicode boundaries.");
        vm.stopBroadcast();
    }
}
