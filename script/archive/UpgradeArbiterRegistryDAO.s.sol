// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

// ============================================================
// UpgradeArbiterRegistryDAO.s.sol
//
// Апгрейд ArbiterRegistryFacet: добавляет DAO-режим.
//
// Replace (13 существующих селекторов):
//   addArbiter, removeArbiter, setChiefArbiter, getChiefArbiter,
//   commitDisputeClaim, claimDispute, releaseDisputeClaim, clearDisputeClaim,
//   isRegisteredArbiter, getArbiters, getDisputeClaimer,
//   getArbiterDeals, getClaimCommitment
//
// Add (5 новых селекторов):
//   activateDAO()
//   applyAsArbiter()
//   isDaoActive()
//   getMinXPToRegister()
//   getDaoThreshold()
//
// Usage:
//   forge script script/UpgradeArbiterRegistryDAO.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../../src/facets/ArbiterRegistryFacet.sol";
import "../../src/DiamondProxy.sol";

contract UpgradeArbiterRegistryDAO is Script {
    address constant DIAMOND = 0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        ArbiterRegistryFacet newFacet = new ArbiterRegistryFacet();
        console.log("New ArbiterRegistryFacet:", address(newFacet));

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);

        // ── Replace: все 13 существующих селекторов ──────────────────────────
        bytes4[] memory replaceSels = new bytes4[](13);
        replaceSels[0]  = ArbiterRegistryFacet.addArbiter.selector;
        replaceSels[1]  = bytes4(0x3487e08c) /* removeArbiter(address), удалена 15 августа 2026 (задача 6 arbiter-accountability) */;
        replaceSels[2]  = ArbiterRegistryFacet.setChiefArbiter.selector;
        replaceSels[3]  = ArbiterRegistryFacet.getChiefArbiter.selector;
        replaceSels[4]  = ArbiterRegistryFacet.commitDisputeClaim.selector;
        replaceSels[5]  = bytes4(keccak256("claimDispute(address,bytes32)")) /* frozen: old 2-arg selector, historical cut */;
        replaceSels[6]  = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        replaceSels[7]  = ArbiterRegistryFacet.clearDisputeClaim.selector;
        replaceSels[8]  = ArbiterRegistryFacet.isRegisteredArbiter.selector;
        replaceSels[9]  = ArbiterRegistryFacet.getArbiters.selector;
        replaceSels[10] = ArbiterRegistryFacet.getDisputeClaimer.selector;
        replaceSels[11] = ArbiterRegistryFacet.getArbiterDeals.selector;
        replaceSels[12] = ArbiterRegistryFacet.getClaimCommitment.selector;

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSels
        });

        // ── Add: 5 новых DAO-селекторов ───────────────────────────────────────
        bytes4[] memory addSels = new bytes4[](5);
        addSels[0] = ArbiterRegistryFacet.activateDAO.selector;
        addSels[1] = ArbiterRegistryFacet.applyAsArbiter.selector;
        addSels[2] = ArbiterRegistryFacet.isDaoActive.selector;
        addSels[3] = ArbiterRegistryFacet.getMinXPToRegister.selector;
        addSels[4] = ArbiterRegistryFacet.getDaoThreshold.selector;

        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: addSels
        });

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        console.log("=== ArbiterRegistry DAO upgrade complete ===");
        console.log("  [Replace] 13 existing selectors");
        console.log("  [Add]     activateDAO()");
        console.log("  [Add]     applyAsArbiter()");
        console.log("  [Add]     isDaoActive()");
        console.log("  [Add]     getMinXPToRegister()");
        console.log("  [Add]     getDaoThreshold()");

        require(
            IDiamondLoupe(DIAMOND).facetAddress(ArbiterRegistryFacet.isDaoActive.selector) == address(newFacet),
            "isDaoActive: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(ArbiterRegistryFacet.addArbiter.selector) == address(newFacet),
            "addArbiter: wrong facet"
        );
        console.log("Verification passed.");

        vm.stopBroadcast();
    }
}
