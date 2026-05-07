// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeNFTFacets.s.sol
//
// Апгрейд OfferNFTFacet + JobBoardFacet:
//   OfferNFTFacet — убран executor receipt, добавлен mintJobReceipt (job receipt NFT)
//   JobBoardFacet — убраны setReceiptNFT/getReceiptNFT, receipt минтится через Diamond
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/OfferNFTFacet.sol";
import "../src/facets/JobBoardFacet.sol";
import "../src/DiamondProxy.sol";

contract UpgradeNFTFacets is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address diamond = vm.envOr("DIAMOND_ADDRESS", address(0xF00CC71878c226E0b64253Fb71dD802aF12165D0));

        vm.startBroadcast(deployerKey);

        // ── 1. Deploy new facets ───────────────────────────────────────────────

        OfferNFTFacet newOfferNFT = new OfferNFTFacet();
        console.log("New OfferNFTFacet:", address(newOfferNFT));

        JobBoardFacet newJobBoard = new JobBoardFacet();
        console.log("New JobBoardFacet:", address(newJobBoard));

        // ── 2. Build cuts ──────────────────────────────────────────────────────
        // Нам нужно 4 операции:
        //  [0] ADD    mintJobReceipt        → newOfferNFT  (новый селектор)
        //  [1] REPLACE все общие селекторы  → newOfferNFT
        //  [2] REMOVE  старые selectors OfferNFT (setOfferReceiptNFT, getOfferReceiptNFT)
        //  [3] REPLACE JobBoard selectors   → newJobBoard
        //  [4] REMOVE  старые selectors JobBoard (setReceiptNFT, getReceiptNFT)

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](5);

        // [0] ADD: mintJobReceipt (новый)
        bytes4[] memory offerAdd = new bytes4[](1);
        offerAdd[0] = OfferNFTFacet.mintJobReceipt.selector; // 0x3599ef82
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newOfferNFT),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: offerAdd
        });

        // [1] REPLACE: все существующие OfferNFTFacet селекторы
        bytes4[] memory offerReplace = new bytes4[](21);
        offerReplace[0]  = OfferNFTFacet.name.selector;
        offerReplace[1]  = OfferNFTFacet.symbol.selector;
        offerReplace[2]  = OfferNFTFacet.supportsInterface.selector;
        offerReplace[3]  = OfferNFTFacet.balanceOf.selector;
        offerReplace[4]  = OfferNFTFacet.ownerOf.selector;
        offerReplace[5]  = OfferNFTFacet.tokenURI.selector;
        offerReplace[6]  = bytes4(0x23b872dd); // transferFrom(address,address,uint256)
        offerReplace[7]  = bytes4(0x42842e0e); // safeTransferFrom(address,address,uint256)
        offerReplace[8]  = bytes4(0xb88d4fde); // safeTransferFrom(address,address,uint256,bytes)
        offerReplace[9]  = OfferNFTFacet.approve.selector;
        offerReplace[10] = OfferNFTFacet.setApprovalForAll.selector;
        offerReplace[11] = OfferNFTFacet.getApproved.selector;
        offerReplace[12] = OfferNFTFacet.isApprovedForAll.selector;
        offerReplace[13] = OfferNFTFacet.mintOffer.selector;
        offerReplace[14] = OfferNFTFacet.hireAndCreateDeal.selector;
        offerReplace[15] = OfferNFTFacet.deactivateOffer.selector;
        offerReplace[16] = OfferNFTFacet.getOffer.selector;
        offerReplace[17] = OfferNFTFacet.getExecutorOffers.selector;
        offerReplace[18] = OfferNFTFacet.getOfferHires.selector;
        offerReplace[19] = OfferNFTFacet.getTotalSupply.selector;
        offerReplace[20] = OfferNFTFacet.getActiveOffersCount.selector;
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(newOfferNFT),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: offerReplace
        });

        // [2] REMOVE: setOfferReceiptNFT (0x7827b853) + getOfferReceiptNFT (0xa2c8cb08)
        bytes4[] memory offerRemove = new bytes4[](2);
        offerRemove[0] = bytes4(0x7827b853); // setOfferReceiptNFT(address)
        offerRemove[1] = bytes4(0xa2c8cb08); // getOfferReceiptNFT()
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(0),
            action: IDiamondCut.FacetCutAction.Remove,
            functionSelectors: offerRemove
        });

        // [3] REPLACE: все JobBoardFacet селекторы (без удалённых)
        bytes4[] memory jobReplace = new bytes4[](10);
        jobReplace[0] = JobBoardFacet.mintJobWithPermit.selector;
        jobReplace[1] = JobBoardFacet.mintJob.selector;
        jobReplace[2] = JobBoardFacet.applyForJob.selector;
        jobReplace[3] = JobBoardFacet.acceptApplicant.selector;
        jobReplace[4] = JobBoardFacet.cancelJob.selector;
        jobReplace[5] = JobBoardFacet.getJob.selector;
        jobReplace[6] = JobBoardFacet.getClientJobs.selector;
        jobReplace[7] = JobBoardFacet.getApplicants.selector;
        jobReplace[8] = JobBoardFacet.totalJobs.selector;
        jobReplace[9] = JobBoardFacet.getOpenJobs.selector;
        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(newJobBoard),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: jobReplace
        });

        // [4] REMOVE: setReceiptNFT (0xd1f26b3f) + getReceiptNFT (0xbe3cefe3)
        bytes4[] memory jobRemove = new bytes4[](2);
        jobRemove[0] = bytes4(0xd1f26b3f); // setReceiptNFT(address)
        jobRemove[1] = bytes4(0xbe3cefe3); // getReceiptNFT()
        cuts[4] = IDiamondCut.FacetCut({
            facetAddress: address(0),
            action: IDiamondCut.FacetCutAction.Remove,
            functionSelectors: jobRemove
        });

        // ── 3. Execute ────────────────────────────────────────────────────────

        console.log("Applying diamond cut...");
        IDiamondCut(diamond).diamondCut(cuts, address(0), "");

        console.log("Done!");
        console.log("Diamond:          ", diamond);
        console.log("New OfferNFTFacet:", address(newOfferNFT));
        console.log("New JobBoardFacet:", address(newJobBoard));

        vm.stopBroadcast();
    }
}
