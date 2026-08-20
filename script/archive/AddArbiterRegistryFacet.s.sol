// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../../src/facets/ArbiterRegistryFacet.sol";
import {ArbiterAccountabilityFacet} from "../../src/facets/ArbiterAccountabilityFacet.sol";
import "../../src/RegistryFacet.sol";
import "../../src/DiamondProxy.sol";

/// @notice Deploys ArbiterRegistryFacet (new) + upgrades RegistryFacet (adds getDisputed)
/// Usage:
///   forge script script/AddArbiterRegistryFacet.s.sol \
///     --rpc-url base_sepolia --broadcast --verify
contract AddArbiterRegistryFacet is Script {
    address constant DIAMOND = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);

        // ── 1. Deploy & register ArbiterRegistryFacet (Add) ─────────────────
        ArbiterRegistryFacet arbiterFacet = new ArbiterRegistryFacet();
        console.log("ArbiterRegistryFacet deployed:", address(arbiterFacet));

        bytes4[] memory arbiterSelectors = new bytes4[](8);
        arbiterSelectors[0] = ArbiterRegistryFacet.addArbiter.selector;
        arbiterSelectors[1] = bytes4(0x3487e08c) /* removeArbiter(address), удалена 15 августа 2026 (задача 6 arbiter-accountability) */;
        arbiterSelectors[2] = bytes4(keccak256("claimDispute(address,bytes32)")) /* frozen: old 2-arg selector, historical cut */;
        arbiterSelectors[3] = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        arbiterSelectors[4] = ArbiterRegistryFacet.isRegisteredArbiter.selector;
        arbiterSelectors[5] = ArbiterRegistryFacet.getArbiters.selector;
        arbiterSelectors[6] = ArbiterRegistryFacet.getDisputeClaimer.selector;
        arbiterSelectors[7] = ArbiterAccountabilityFacet.getArbiterDeals.selector;

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(arbiterFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: arbiterSelectors
        });

        // ── 2. Upgrade RegistryFacet (Add new getDisputed selector) ─────────
        RegistryFacet registryFacet = new RegistryFacet();
        console.log("RegistryFacet (new) deployed:", address(registryFacet));

        bytes4[] memory registryNewSelectors = new bytes4[](1);
        registryNewSelectors[0] = RegistryFacet.getDisputed.selector;

        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(registryFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: registryNewSelectors
        });

        // ── 3. DiamondCut ────────────────────────────────────────────────────
        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        console.log("Done. Diamond:", DIAMOND);
        console.log("  + ArbiterRegistryFacet (8 selectors)");
        console.log("  + RegistryFacet.getDisputed (1 selector)");

        vm.stopBroadcast();
    }
}
