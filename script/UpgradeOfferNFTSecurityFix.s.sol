// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeOfferNFTSecurityFix.s.sol
//
// КРИТИЧЕСКИЙ ФИКС БЕЗОПАСНОСТИ:
//   - hireAndCreateDeal: убран параметр `address client` (caller = msg.sender)
//   - Добавлен сбор комиссии (regionFee) перед созданием сделки
//   - Добавлено атомарное финансирование Agreement через fundFromFactory()
//   - Добавлен hireAndCreateDealWithPermit для gasless-флоу
//
// Текущее состояние Diamond (на момент скрипта):
//   OfferNFTFacet @ 0x14997712158734a83CEddDBf07ddBea199316818 — 19 селекторов:
//     16 известных (ERC-721 + mintJobReceipt + setSvgRenderer + getSvgRenderer)
//     3 устаревших (0xbf2a1136, 0x959a8fb5, 0x8492a069 — старые бизнес-функции)
//     бизнес-функции (mintOffer, hireAndCreateDeal, deactivateOffer, get*) НЕ зарегистрированы
//
// Операции:
//   Replace 16 → обновить facetAddress для всех известных селекторов
//   Remove  3  → удалить 3 устаревших неизвестных селектора
//   Add     9  → зарегистрировать бизнес-функции (включая новый hireAndCreateDeal + withPermit)
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

        // ── 1. Deploy new OfferNFTFacet ─────────────────────────────────────
        OfferNFTFacet newFacet = new OfferNFTFacet();
        console.log("New OfferNFTFacet deployed at:", address(newFacet));

        // ── 2. Replace: 16 existing selectors → new facet address ───────────
        bytes4[] memory replaceSelectors = new bytes4[](16);
        replaceSelectors[0]  = OfferNFTFacet.name.selector;            // 0x06fdde03
        replaceSelectors[1]  = OfferNFTFacet.symbol.selector;          // 0x95d89b41
        replaceSelectors[2]  = OfferNFTFacet.supportsInterface.selector; // 0x01ffc9a7
        replaceSelectors[3]  = OfferNFTFacet.balanceOf.selector;       // 0x70a08231
        replaceSelectors[4]  = OfferNFTFacet.ownerOf.selector;         // 0x6352211e
        replaceSelectors[5]  = OfferNFTFacet.tokenURI.selector;        // 0xc87b56dd
        replaceSelectors[6]  = bytes4(0x23b872dd); // transferFrom(address,address,uint256)
        replaceSelectors[7]  = bytes4(0x42842e0e); // safeTransferFrom(address,address,uint256)
        replaceSelectors[8]  = bytes4(0xb88d4fde); // safeTransferFrom(address,address,uint256,bytes)
        replaceSelectors[9]  = OfferNFTFacet.approve.selector;         // 0x095ea7b3
        replaceSelectors[10] = OfferNFTFacet.setApprovalForAll.selector; // 0xa22cb465
        replaceSelectors[11] = OfferNFTFacet.getApproved.selector;     // 0x081812fc
        replaceSelectors[12] = OfferNFTFacet.isApprovedForAll.selector; // 0xe985e9c5
        replaceSelectors[13] = OfferNFTFacet.mintJobReceipt.selector;  // 0x3599ef82
        replaceSelectors[14] = OfferNFTFacet.setSvgRenderer.selector;  // 0xab9f973c
        replaceSelectors[15] = OfferNFTFacet.getSvgRenderer.selector;  // 0xe49a1076

        // ── 3. Remove: 3 stale unknown selectors ───────────────────────────
        bytes4[] memory removeSelectors = new bytes4[](3);
        removeSelectors[0] = bytes4(0xbf2a1136);
        removeSelectors[1] = bytes4(0x959a8fb5);
        removeSelectors[2] = bytes4(0x8492a069);

        // ── 4. Add: 9 business selectors (not currently registered) ────────
        //   - mintOffer: 0x0b569cb4
        //   - hireAndCreateDeal (NEW, no address param): 0x93c65e78
        //   - hireAndCreateDealWithPermit (NEW): 0x1a03a70e
        //   - deactivateOffer: 0x0b5e1f3f
        //   - getOffer: 0x4579268a
        //   - getExecutorOffers: 0xea2991c2
        //   - getOfferHires: 0x18955c6d
        //   - getTotalSupply: 0xc4e41b22
        //   - getActiveOffersCount: 0x87003901
        bytes4[] memory addSelectors = new bytes4[](9);
        addSelectors[0] = OfferNFTFacet.mintOffer.selector;
        addSelectors[1] = OfferNFTFacet.hireAndCreateDeal.selector;
        addSelectors[2] = OfferNFTFacet.hireAndCreateDealWithPermit.selector;
        addSelectors[3] = OfferNFTFacet.deactivateOffer.selector;
        addSelectors[4] = OfferNFTFacet.getOffer.selector;
        addSelectors[5] = OfferNFTFacet.getExecutorOffers.selector;
        addSelectors[6] = OfferNFTFacet.getOfferHires.selector;
        addSelectors[7] = OfferNFTFacet.getTotalSupply.selector;
        addSelectors[8] = OfferNFTFacet.getActiveOffersCount.selector;

        // ── 5. Diamond cut ──────────────────────────────────────────────────
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](3);

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
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress:      address(newFacet),
            action:            IDiamondCut.FacetCutAction.Add,
            functionSelectors: addSelectors
        });

        console.log("Executing diamondCut (Replace 16 / Remove 3 / Add 9)...");
        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        console.log("");
        console.log("=== SECURITY FIX APPLIED ===");
        console.log("Diamond:      ", DIAMOND);
        console.log("New facet:    ", address(newFacet));
        console.log("hireAndCreateDeal now:");
        console.log("  - caller = msg.sender (client) - no spoofing");
        console.log("  - regionFee collected before deal creation");
        console.log("  - Agreement funded atomically via fundFromFactory()");
        console.log("  - hireAndCreateDealWithPermit added (gasless)");

        vm.stopBroadcast();
    }
}
