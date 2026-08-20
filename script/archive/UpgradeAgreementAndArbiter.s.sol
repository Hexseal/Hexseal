// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

// ============================================================
// UpgradeAgreementAndArbiter.s.sol
//
// Одним diamondCut деплоит и подключает:
//
//  1. FactoryFacet (Replace) — новый Agreement bytecode с setArbiter()
//                               + arbiter = address(0) при деплое
//  2. ArbiterRegistryFacet (Add) — реестр арбитров, claimDispute
//  3. RegistryFacet (Add) — новый селектор getDisputed()
//
// Использование:
//   forge script script/UpgradeAgreementAndArbiter.s.sol \
//     --rpc-url base_sepolia --broadcast --verify -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";

import "../../src/FactoryFacet.sol";
import "../../src/RegistryFacet.sol";
import "../../src/facets/ArbiterRegistryFacet.sol";
import {ArbiterAccountabilityFacet} from "../../src/facets/ArbiterAccountabilityFacet.sol";
import "../../src/DiamondProxy.sol";

contract UpgradeAgreementAndArbiter is Script {
    address constant DIAMOND = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](3);

        // ── Cut 0: Replace FactoryFacet ───────────────────────────────────────
        // FactoryFacet компилируется вместе с Agreement.sol и встраивает его
        // creation bytecode. Новый FactoryFacet = новые Agreement контракты с:
        //   - arbiter не immutable (можно менять через setArbiter)
        //   - arbiter = address(0) при деплое (назначается через claimDispute)
        FactoryFacet newFactory = new FactoryFacet();
        console.log("FactoryFacet (new Agreement bytecode):", address(newFactory));

        bytes4[] memory factorySelectors = new bytes4[](17);
        factorySelectors[0]  = FactoryFacet.initFactory.selector;
        factorySelectors[1]  = FactoryFacet.deployAgreement.selector;
        factorySelectors[2]  = FactoryFacet.deployAndFund.selector;
        factorySelectors[3]  = FactoryFacet.setRegionFee.selector;
        factorySelectors[4]  = FactoryFacet.setFeeRecipient.selector;
        factorySelectors[5]  = FactoryFacet.setTrustedForwarder.selector;
        factorySelectors[6]  = bytes4(0x16c38b3c);
        factorySelectors[7]  = bytes4(0x220f72fc);
        factorySelectors[8]  = bytes4(0x9403d404);
        factorySelectors[9]  = FactoryFacet.getRegionFee.selector;
        factorySelectors[10] = FactoryFacet.getAllFees.selector;
        factorySelectors[11] = FactoryFacet.getFeeRecipient.selector;
        factorySelectors[12] = FactoryFacet.getTrustedForwarder.selector;
        factorySelectors[13] = bytes4(0xb187bd26);
        factorySelectors[14] = FactoryFacet.getUsdc.selector;
        factorySelectors[15] = bytes4(0xeea6f749);
        factorySelectors[16] = bytes4(0x189b468b);

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFactory),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: factorySelectors
        });

        // ── Cut 1: Add ArbiterRegistryFacet ───────────────────────────────────
        // Новый фасет — добавляем (не Replace).
        ArbiterRegistryFacet arbiterFacet = new ArbiterRegistryFacet();
        console.log("ArbiterRegistryFacet:               ", address(arbiterFacet));

        bytes4[] memory arbiterSelectors = new bytes4[](8);
        arbiterSelectors[0] = ArbiterRegistryFacet.addArbiter.selector;
        arbiterSelectors[1] = bytes4(0x3487e08c) /* removeArbiter(address), удалена 15 августа 2026 (задача 6 arbiter-accountability) */;
        arbiterSelectors[2] = bytes4(keccak256("claimDispute(address,bytes32)")) /* frozen: old 2-arg selector, historical cut */;
        arbiterSelectors[3] = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        arbiterSelectors[4] = ArbiterRegistryFacet.isRegisteredArbiter.selector;
        arbiterSelectors[5] = ArbiterRegistryFacet.getArbiters.selector;
        arbiterSelectors[6] = ArbiterRegistryFacet.getDisputeClaimer.selector;
        arbiterSelectors[7] = ArbiterAccountabilityFacet.getArbiterDeals.selector;

        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(arbiterFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: arbiterSelectors
        });

        // ── Cut 2: Add RegistryFacet.getDisputed ──────────────────────────────
        // Только новый селектор — остальные RegistryFacet функции уже в Diamond.
        RegistryFacet newRegistry = new RegistryFacet();
        console.log("RegistryFacet (getDisputed):        ", address(newRegistry));

        bytes4[] memory registrySelectors = new bytes4[](1);
        registrySelectors[0] = RegistryFacet.getDisputed.selector;

        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(newRegistry),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: registrySelectors
        });

        // ── Execute diamondCut ─────────────────────────────────────────────────
        console.log("\nExecuting diamondCut on Diamond:", DIAMOND);
        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        console.log("\n=== Upgrade complete ===");
        console.log("  [Replace] FactoryFacet     17 selectors -> new Agreement bytecode");
        console.log("  [Add]     ArbiterRegistry   8 selectors -> arbiter hub");
        console.log("  [Add]     RegistryFacet     1 selector  -> getDisputed()");

        vm.stopBroadcast();
    }
}
