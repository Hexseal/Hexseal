// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

// ============================================================
// UpgradeFactoryFacetV5.s.sol
//
// Архитектурный рефактор:
//   - FactoryFacet больше не содержит bytecode Agreement
//   - AgreementDeployer — отдельный внешний контракт (не фасет)
//   - Добавлены селекторы: setAgreementDeployer, getAgreementDeployer
//   - Все 17 существующих селекторов заменяются новой реализацией
//
// После апгрейда: deployAgreement/deployAndFund работают через
// внешний AgreementDeployer — Factory теперь 5.6 KB вместо 26 KB.
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DiamondProxy.sol";
import "../src/FactoryFacet.sol";
import "../src/AgreementDeployer.sol";

contract UpgradeFactoryFacetV5 is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address diamond = vm.envOr("DIAMOND_ADDRESS", address(0xF00CC71878c226E0b64253Fb71dD802aF12165D0));

        vm.startBroadcast(deployerKey);

        // 1. Deploy external AgreementDeployer (holds Agreement creation code)
        AgreementDeployer agDeployer = new AgreementDeployer(diamond);
        console.log("AgreementDeployer deployed at:", address(agDeployer));

        // 2. Deploy new FactoryFacet (now tiny — no Agreement bytecode)
        FactoryFacet newFactory = new FactoryFacet();
        console.log("New FactoryFacet (V5) deployed at:", address(newFactory));

        // 3. Build diamond cuts
        // initFactory changed signature: (address x4) → (address x5)
        // Old selector 0xf74b9ce8 must be Removed; new selector Added.
        // All other 16 existing selectors: Replace.
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](3);

        // [0] REPLACE: 16 existing selectors (all except old initFactory)
        bytes4[] memory replaceSelectors = new bytes4[](16);
        replaceSelectors[0]  = FactoryFacet.deployAgreement.selector;
        replaceSelectors[1]  = FactoryFacet.deployAndFund.selector;
        replaceSelectors[2]  = FactoryFacet.setRegionFee.selector;
        replaceSelectors[3]  = FactoryFacet.setFeeRecipient.selector;
        replaceSelectors[4]  = FactoryFacet.setTrustedForwarder.selector;
        replaceSelectors[5]  = bytes4(0x16c38b3c);
        replaceSelectors[6]  = bytes4(0x220f72fc);
        replaceSelectors[7]  = bytes4(0x9403d404);
        replaceSelectors[8]  = FactoryFacet.getRegionFee.selector;
        replaceSelectors[9]  = FactoryFacet.getAllFees.selector;
        replaceSelectors[10] = FactoryFacet.getFeeRecipient.selector;
        replaceSelectors[11] = FactoryFacet.getTrustedForwarder.selector;
        replaceSelectors[12] = bytes4(0xb187bd26);
        replaceSelectors[13] = FactoryFacet.getUsdc.selector;
        replaceSelectors[14] = bytes4(0xeea6f749);
        replaceSelectors[15] = bytes4(0x189b468b);

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFactory),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSelectors
        });

        // [1] REMOVE: old initFactory(address,address,address,address) = 0xf74b9ce8
        bytes4[] memory removeSelectors = new bytes4[](1);
        removeSelectors[0] = bytes4(0xf74b9ce8);

        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(0),
            action: IDiamondCut.FacetCutAction.Remove,
            functionSelectors: removeSelectors
        });

        // [2] ADD: new initFactory(address x5) + setAgreementDeployer + getAgreementDeployer
        bytes4[] memory addSelectors = new bytes4[](3);
        addSelectors[0] = FactoryFacet.initFactory.selector;
        addSelectors[1] = FactoryFacet.setAgreementDeployer.selector;
        addSelectors[2] = FactoryFacet.getAgreementDeployer.selector;

        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(newFactory),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: addSelectors
        });

        // 4. Apply cut
        console.log("Applying diamond cut (Replace 16 + Remove 1 + Add 3)...");
        IDiamondCut(diamond).diamondCut(cuts, address(0), "");

        // 5. Wire AgreementDeployer into storage — must happen after cut adds the selector
        console.log("Setting AgreementDeployer in Diamond storage...");
        FactoryFacet(diamond).setAgreementDeployer(address(agDeployer));

        console.log("");
        console.log("FactoryFacet V5 upgrade complete!");
        console.log("Diamond:           ", diamond);
        console.log("New FactoryFacet:  ", address(newFactory));
        console.log("AgreementDeployer: ", address(agDeployer));
        console.log("");
        console.log("Replace 16 + Remove old initFactory + Add new initFactory + 2 admin selectors.");
        console.log("deployAgreement() and deployAndFund() now route through AgreementDeployer.");

        vm.stopBroadcast();
    }
}
