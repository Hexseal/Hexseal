// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeSecurityAudit.s.sol
//
// Применяет все security fixes из аудита:
//   H1  — AgreementDeployer.authorizedCaller (только Diamond может деплоить)
//   M5  — deployAndFund без permit params + _msgSender() == client check
//   M6  — two-step transferOwnership (pendingOwner + acceptOwnership)
//   L3  — (на-чейне уже сработает через новый initFactory; валидация в коде)
//
// Действия:
//   1. Deploy новый AgreementDeployer(diamond) — с authorizedCaller
//   2. Deploy новый FactoryFacet — новая сигнатура deployAndFund
//   3. Deploy новый OwnershipFacet — + acceptOwnership + pendingOwner
//   4. diamondCut:
//        FactoryFacet: Replace 12 + Remove 1 (старый deployAndFund) + Add 1 (новый)
//        OwnershipFacet: Replace 2 + Add 2
//   5. setAgreementDeployer(новый адрес)
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DiamondProxy.sol";
import "../src/FactoryFacet.sol";
import "../src/AgreementDeployer.sol";

contract UpgradeSecurityAudit is Script {
    address constant DIAMOND = 0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerKey);

        // ── 1. New AgreementDeployer (H1: authorizedCaller = diamond) ─────────
        AgreementDeployer newDeployer = new AgreementDeployer(DIAMOND);
        console.log("AgreementDeployer:", address(newDeployer));

        // ── 2. New FactoryFacet (M5: deployAndFund без permit params) ─────────
        FactoryFacet newFactory = new FactoryFacet();
        console.log("FactoryFacet:     ", address(newFactory));

        // ── 3. New OwnershipFacet (M6: acceptOwnership + pendingOwner) ────────
        OwnershipFacet newOwnership = new OwnershipFacet();
        console.log("OwnershipFacet:   ", address(newOwnership));

        // ── 4. Build cuts ──────────────────────────────────────────────────────
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](5);

        // [0] REPLACE FactoryFacet — 12 селекторов (всё кроме старого deployAndFund)
        bytes4[] memory factoryReplace = new bytes4[](12);
        factoryReplace[0]  = FactoryFacet.initFactory.selector;           // 0x81d09ceb
        factoryReplace[1]  = FactoryFacet.deployAgreement.selector;       // 0x7ba33dab
        factoryReplace[2]  = FactoryFacet.setRegionFee.selector;          // 0xdc6039c9
        factoryReplace[3]  = FactoryFacet.setFeeRecipient.selector;       // 0xe74b981b
        factoryReplace[4]  = FactoryFacet.setTrustedForwarder.selector;   // 0xda742228
        factoryReplace[5]  = FactoryFacet.setAgreementDeployer.selector;  // 0x841501c5
        factoryReplace[6]  = FactoryFacet.getRegionFee.selector;          // 0xf7f6c5fa
        factoryReplace[7]  = FactoryFacet.getAllFees.selector;             // 0xb20feaaf
        factoryReplace[8]  = FactoryFacet.getFeeRecipient.selector;       // 0x4ccb20c0
        factoryReplace[9]  = FactoryFacet.getTrustedForwarder.selector;   // 0xce1b815f
        factoryReplace[10] = FactoryFacet.getUsdc.selector;               // 0x12f3fe76
        factoryReplace[11] = FactoryFacet.getAgreementDeployer.selector;  // 0xc8e6e68d

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFactory),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: factoryReplace
        });

        // [1] REMOVE FactoryFacet — старый deployAndFund (с permit params)
        bytes4[] memory factoryRemove = new bytes4[](1);
        factoryRemove[0] = bytes4(0x74946abf); // deployAndFund(addr,addr,uint256,uint256,string,uint8,uint256,uint8,bytes32,bytes32)

        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(0),
            action: IDiamondCut.FacetCutAction.Remove,
            functionSelectors: factoryRemove
        });

        // [2] ADD FactoryFacet — новый deployAndFund (без permit params)
        bytes4[] memory factoryAdd = new bytes4[](1);
        factoryAdd[0] = FactoryFacet.deployAndFund.selector; // 0x5ef7b2a5

        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(newFactory),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: factoryAdd
        });

        // [3] REPLACE OwnershipFacet — 2 существующих селектора
        bytes4[] memory ownerReplace = new bytes4[](2);
        ownerReplace[0] = OwnershipFacet.transferOwnership.selector; // 0xf2fde38b
        ownerReplace[1] = OwnershipFacet.owner.selector;             // 0x8da5cb5b

        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(newOwnership),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: ownerReplace
        });

        // [4] ADD OwnershipFacet — 2 новых селектора
        bytes4[] memory ownerAdd = new bytes4[](2);
        ownerAdd[0] = OwnershipFacet.acceptOwnership.selector; // 0x79ba5097
        ownerAdd[1] = OwnershipFacet.pendingOwner.selector;    // 0xe30c3978

        cuts[4] = IDiamondCut.FacetCut({
            facetAddress: address(newOwnership),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: ownerAdd
        });

        // ── 5. Apply cut ───────────────────────────────────────────────────────
        console.log("Applying diamond cut (5 operations)...");
        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        // ── 6. Wire new AgreementDeployer ──────────────────────────────────────
        console.log("Setting new AgreementDeployer...");
        FactoryFacet(DIAMOND).setAgreementDeployer(address(newDeployer));

        vm.stopBroadcast();

        console.log("");
        console.log("=== Security Audit Upgrade Complete ===");
        console.log("Diamond:           ", DIAMOND);
        console.log("AgreementDeployer: ", address(newDeployer));
        console.log("FactoryFacet:      ", address(newFactory));
        console.log("OwnershipFacet:    ", address(newOwnership));
        console.log("");
        console.log("Fixed:");
        console.log("  H1  AgreementDeployer.authorizedCaller = Diamond");
        console.log("  M5  deployAndFund: permit removed, _msgSender==client enforced");
        console.log("  M6  transferOwnership: two-step via pendingOwner/acceptOwnership");
        console.log("  L3  trustedForwarder zero-check in initFactory (code-level)");
    }
}
