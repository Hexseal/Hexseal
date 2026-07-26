// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

// ============================================================
// UpgradeAgreementMetadata.s.sol
//
// Что делает (один diamondCut):
//   1. REPLACE FactoryFacet — деплоит новый Agreement, который
//      вызывает Diamond для on-chain SVG вместо IPFS-картинки.
//      Agreement теперь минтит NFT ОБЕИМ сторонам (client + executor).
//   2. ADD DealMetadataFacet — getDealTokenURI() генерирует SVG
//      с динамическим статусом (FUNDED/ACTIVE/DISPUTED/COMPLETED).
//
// Новые Agreement-ы (из новых сделок):
//   - TOKEN_ID=1 → client
//   - EXECUTOR_TOKEN_ID=2 → executor
//   - tokenURI динамически отражает текущий статус сделки
//   - Burns при завершении/рефанде
//
// Старые сделки: не затронуты (у них другой Diamond call target).
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DiamondProxy.sol";
import "../src/FactoryFacet.sol";
import "../src/facets/DealMetadataFacet.sol";

contract UpgradeAgreementMetadata is Script {
    address constant DIAMOND = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        // --- Deploy new contracts ---
        DealMetadataFacet metaFacet = new DealMetadataFacet();
        console.log("DealMetadataFacet:", address(metaFacet));

        FactoryFacet newFactory = new FactoryFacet();
        console.log("FactoryFacet (V5):", address(newFactory));

        // --- Cut 1: Replace FactoryFacet ---
        bytes4[] memory factorySels = new bytes4[](17);
        factorySels[0]  = FactoryFacet.initFactory.selector;
        factorySels[1]  = FactoryFacet.deployAgreement.selector;
        factorySels[2]  = FactoryFacet.setRegionFee.selector;
        factorySels[3]  = FactoryFacet.setFeeRecipient.selector;
        factorySels[4]  = FactoryFacet.setTrustedForwarder.selector;
        factorySels[5]  = bytes4(0x16c38b3c);
        factorySels[6]  = FactoryFacet.getRegionFee.selector;
        factorySels[7]  = FactoryFacet.getAllFees.selector;
        factorySels[8]  = FactoryFacet.getFeeRecipient.selector;
        factorySels[9]  = FactoryFacet.getTrustedForwarder.selector;
        factorySels[10] = bytes4(0xb187bd26);
        factorySels[11] = FactoryFacet.getUsdc.selector;
        factorySels[12] = bytes4(0x220f72fc);
        factorySels[13] = bytes4(0xeea6f749);
        factorySels[14] = FactoryFacet.deployAndFund.selector;
        factorySels[15] = bytes4(0x9403d404);
        factorySels[16] = bytes4(0x189b468b);

        // --- Cut 2: Add DealMetadataFacet ---
        bytes4[] memory metaSels = new bytes4[](1);
        metaSels[0] = DealMetadataFacet.getDealTokenURI.selector;

        // --- Single diamondCut with both cuts ---
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress:      address(newFactory),
            action:            IDiamondCut.FacetCutAction.Replace,
            functionSelectors: factorySels
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress:      address(metaFacet),
            action:            IDiamondCut.FacetCutAction.Add,
            functionSelectors: metaSels
        });

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        console.log("Done!");
        console.log("  - New agreements: both parties get NFT in one tx");
        console.log("  - tokenURI: on-chain SVG with live status");
        vm.stopBroadcast();
    }
}
