// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeOfferNFTSecurityFix.s.sol
//
// Replaces OfferNFTFacet with a clean version that:
//   - Removes all offer-posting/hire functions (dead product code)
//   - Keeps only job receipt NFT logic (ERC-721 + mintJobReceipt)
//
// Current on-chain state (0x14997712...): 19 selectors
//   16 known: ERC-721 base + mintJobReceipt + setSvgRenderer + getSvgRenderer
//    3 stale:  0xbf2a1136, 0x959a8fb5, 0x8492a069 (old offer functions)
//   missing:  mintOffer, hireAndCreateDeal, deactivateOffer, get*Offer*
//             (never registered — confirmed via facetAddress queries)
//
// Operations:
//   Replace 16  — update facetAddress for all currently-live selectors
//   Remove   3  — delete 3 stale unknown selectors
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/OfferNFTFacet.sol";
import "../src/DiamondProxy.sol";

contract UpgradeOfferNFTSecurityFix is Script {
    address constant DIAMOND = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        // 1. Deploy clean OfferNFTFacet
        OfferNFTFacet newFacet = new OfferNFTFacet();
        console.log("New OfferNFTFacet deployed at:", address(newFacet));

        // 2. Replace 16 currently-live selectors
        bytes4[] memory replaceSelectors = new bytes4[](16);
        replaceSelectors[0]  = OfferNFTFacet.name.selector;
        replaceSelectors[1]  = OfferNFTFacet.symbol.selector;
        replaceSelectors[2]  = OfferNFTFacet.supportsInterface.selector;
        replaceSelectors[3]  = OfferNFTFacet.balanceOf.selector;
        replaceSelectors[4]  = OfferNFTFacet.ownerOf.selector;
        replaceSelectors[5]  = OfferNFTFacet.tokenURI.selector;
        replaceSelectors[6]  = bytes4(0x23b872dd); // transferFrom
        replaceSelectors[7]  = bytes4(0x42842e0e); // safeTransferFrom(addr,addr,uint)
        replaceSelectors[8]  = bytes4(0xb88d4fde); // safeTransferFrom(addr,addr,uint,bytes)
        replaceSelectors[9]  = OfferNFTFacet.approve.selector;
        replaceSelectors[10] = OfferNFTFacet.setApprovalForAll.selector;
        replaceSelectors[11] = OfferNFTFacet.getApproved.selector;
        replaceSelectors[12] = OfferNFTFacet.isApprovedForAll.selector;
        replaceSelectors[13] = OfferNFTFacet.mintJobReceipt.selector;
        replaceSelectors[14] = OfferNFTFacet.setSvgRenderer.selector;
        replaceSelectors[15] = OfferNFTFacet.getSvgRenderer.selector;

        // 3. Remove 3 stale selectors (old offer functions, unknown by name)
        bytes4[] memory removeSelectors = new bytes4[](3);
        removeSelectors[0] = bytes4(0xbf2a1136);
        removeSelectors[1] = bytes4(0x959a8fb5);
        removeSelectors[2] = bytes4(0x8492a069);

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress:      address(newFacet),
            action:            IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSelectors
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress:      address(0),
            action:            IDiamondCut.FacetCutAction.Remove,
            functionSelectors: removeSelectors
        });

        console.log("Executing diamondCut (Replace 16 / Remove 3)...");
        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        console.log("=== UPGRADE COMPLETE ===");
        console.log("Diamond:   ", DIAMOND);
        console.log("New facet: ", address(newFacet));
        console.log("Offer-posting/hire functions removed. Receipt NFT only.");

        vm.stopBroadcast();
    }
}
