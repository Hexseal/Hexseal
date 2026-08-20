// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

// ============================================================
// UpgradeArbiterRegistry.s.sol
//
// Adds chief arbiter role to ArbiterRegistryFacet:
//   - chiefArbiter in storage
//   - setChiefArbiter(address) — onlyOwner
//   - getChiefArbiter() — view
//   - addArbiter / removeArbiter now accept owner OR chiefArbiter
//
// Strategy:
//   Replace — 11 existing selectors (same sigs, new facet address)
//   Add     — 2 new selectors: setChiefArbiter, getChiefArbiter
//
// Usage:
//   forge script script/UpgradeArbiterRegistry.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../../src/facets/ArbiterRegistryFacet.sol";
import {ArbiterAccountabilityFacet} from "../../src/facets/ArbiterAccountabilityFacet.sol";
import "../../src/DiamondProxy.sol";

contract UpgradeArbiterRegistry is Script {
    address constant DIAMOND = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        ArbiterRegistryFacet newFacet = new ArbiterRegistryFacet();
        console.log("New ArbiterRegistryFacet:", address(newFacet));

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);

        // ── Replace: all 11 existing selectors ────────────────────────────────
        bytes4[] memory replaceSels = new bytes4[](11);
        replaceSels[0]  = ArbiterRegistryFacet.addArbiter.selector;
        replaceSels[1]  = bytes4(0x3487e08c) /* removeArbiter(address), удалена 15 августа 2026 (задача 6 arbiter-accountability) */;
        replaceSels[2]  = ArbiterRegistryFacet.commitDisputeClaim.selector;
        replaceSels[3]  = bytes4(keccak256("claimDispute(address,bytes32)")) /* frozen: old 2-arg selector, historical cut */;
        replaceSels[4]  = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        replaceSels[5]  = ArbiterRegistryFacet.clearDisputeClaim.selector;
        replaceSels[6]  = ArbiterRegistryFacet.isRegisteredArbiter.selector;
        replaceSels[7]  = ArbiterRegistryFacet.getArbiters.selector;
        replaceSels[8]  = ArbiterRegistryFacet.getDisputeClaimer.selector;
        replaceSels[9]  = ArbiterAccountabilityFacet.getArbiterDeals.selector;
        replaceSels[10] = ArbiterRegistryFacet.getClaimCommitment.selector;

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSels
        });

        // ── Add: 2 new selectors ───────────────────────────────────────────────
        bytes4[] memory addSels = new bytes4[](2);
        addSels[0] = ArbiterRegistryFacet.setChiefArbiter.selector;
        addSels[1] = ArbiterRegistryFacet.getChiefArbiter.selector;

        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: addSels
        });

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        console.log("=== Upgrade complete ===");
        console.log("  [Replace] 11 existing ArbiterRegistry selectors");
        console.log("  [Add]     setChiefArbiter(address)");
        console.log("  [Add]     getChiefArbiter()");

        // Verify
        require(
            IDiamondLoupe(DIAMOND).facetAddress(ArbiterRegistryFacet.setChiefArbiter.selector) == address(newFacet),
            "setChiefArbiter: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(ArbiterRegistryFacet.addArbiter.selector) == address(newFacet),
            "addArbiter: wrong facet"
        );
        console.log("Verification passed.");

        vm.stopBroadcast();
    }
}
