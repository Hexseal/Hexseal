// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/OfferNFTFacet.sol";
import "../src/DiamondProxy.sol";

/**
 * @notice Обновить OfferNFTFacet в Diamond:
 *   - Заменить 8 существующих селекторов (Replace)
 *   - Удалить 3 устаревших селектора (Remove): mintOfferWithPermit, hireAndCreateDealWithPermit, initialize
 *   - Добавить 13 новых ERC-721 селекторов (Add)
 *
 * ВНИМАНИЕ: новая версия использует namespaced storage (keccak256("signature404.offernft.storage")).
 * Данные из старого raw-slot хранилища не мигрируются — testnet, 2 тестовых оффера.
 * После апгрейда нужно заново заминтить объявления.
 */
contract UpgradeOfferNFTFacet is Script {
    address constant DIAMOND = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerKey);

        // ── 1. Деплой нового фасета ────────────────────────────────────────────
        OfferNFTFacet newFacet = new OfferNFTFacet();
        console.log("New OfferNFTFacet deployed at:", address(newFacet));

        // ── 2. Селекторы для Replace (есть в старом и в новом фасете) ─────────
        bytes4[] memory replaceSelectors = new bytes4[](8);
        replaceSelectors[0] = OfferNFTFacet.mintOffer.selector;
        replaceSelectors[1] = OfferNFTFacet.hireAndCreateDeal.selector;
        replaceSelectors[2] = OfferNFTFacet.deactivateOffer.selector;
        replaceSelectors[3] = OfferNFTFacet.getOffer.selector;
        replaceSelectors[4] = OfferNFTFacet.getExecutorOffers.selector;
        replaceSelectors[5] = OfferNFTFacet.getOfferHires.selector;
        replaceSelectors[6] = OfferNFTFacet.getTotalSupply.selector;
        replaceSelectors[7] = OfferNFTFacet.getActiveOffersCount.selector;

        // ── 3. Устаревшие селекторы для Remove ────────────────────────────────
        // mintOfferWithPermit(string,string,uint256,uint256,string,uint256,uint8,bytes32,bytes32)
        // hireAndCreateDealWithPermit(uint256,address,bytes32,uint8,uint256,uint8,bytes32,bytes32)
        // initialize(address)
        // NOTE: factory() НЕ включён — он не был зарегистрирован в Diamond
        // NOTE: supportsInterface НЕ в Add — уже зарегистрирован в DiamondLoupeFacet
        bytes4[] memory removeSelectors = new bytes4[](3);
        removeSelectors[0] = bytes4(keccak256("mintOfferWithPermit(string,string,uint256,uint256,string,uint256,uint8,bytes32,bytes32)"));
        removeSelectors[1] = bytes4(keccak256("hireAndCreateDealWithPermit(uint256,address,bytes32,uint8,uint256,uint8,bytes32,bytes32)"));
        removeSelectors[2] = bytes4(keccak256("initialize(address)"));

        // ── 4. Новые ERC-721 селекторы для Add ────────────────────────────────
        bytes4[] memory addSelectors = new bytes4[](12);
        addSelectors[0]  = OfferNFTFacet.name.selector;
        addSelectors[1]  = OfferNFTFacet.symbol.selector;
        addSelectors[2]  = OfferNFTFacet.balanceOf.selector;
        addSelectors[3]  = OfferNFTFacet.ownerOf.selector;
        addSelectors[4]  = OfferNFTFacet.tokenURI.selector;
        addSelectors[5]  = bytes4(keccak256("transferFrom(address,address,uint256)"));
        addSelectors[6]  = bytes4(keccak256("safeTransferFrom(address,address,uint256)"));
        addSelectors[7]  = bytes4(keccak256("safeTransferFrom(address,address,uint256,bytes)"));
        addSelectors[8]  = bytes4(keccak256("approve(address,uint256)"));
        addSelectors[9]  = bytes4(keccak256("setApprovalForAll(address,bool)"));
        addSelectors[10] = bytes4(keccak256("getApproved(uint256)"));
        addSelectors[11] = bytes4(keccak256("isApprovedForAll(address,address)"));

        // ── 5. Сборка diamondCut ───────────────────────────────────────────────
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](3);

        // Replace
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress:      address(newFacet),
            action:            IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSelectors
        });

        // Remove (facetAddress must be address(0) for Remove)
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress:      address(0),
            action:            IDiamondCut.FacetCutAction.Remove,
            functionSelectors: removeSelectors
        });

        // Add
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress:      address(newFacet),
            action:            IDiamondCut.FacetCutAction.Add,
            functionSelectors: addSelectors
        });

        console.log("Executing diamondCut (Replace/Remove/Add)...");
        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        console.log("OfferNFTFacet upgraded successfully!");
        console.log("Diamond:       ", DIAMOND);
        console.log("New facet:     ", address(newFacet));
        console.log("Replace:       8 selectors");
        console.log("Remove:        3 old selectors");
        console.log("Add:           12 ERC-721 selectors");
        console.log("");
        console.log("NOTE: Storage migrated to namespaced slot.");
        console.log("      Old test offers (tokenId 0,1) are no longer accessible.");
        console.log("      Please re-mint offers on /board/executor/post");

        vm.stopBroadcast();
    }
}
