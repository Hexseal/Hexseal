// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/FactoryFacet.sol";
import "../src/DiamondProxy.sol";

// Removes pause + dead protocolArbiter/arbitrationThreshold from FactoryFacet.
// Keeps chiefArbiter (in ArbiterRegistryFacet), that is separate and intentional.
contract UpgradeFactoryFacet is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address diamond = vm.envOr("DIAMOND_ADDRESS", address(0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557));

        vm.startBroadcast(deployerKey);

        // 1. Deploy new FactoryFacet (without pause / protocolArbiter / arbitrationThreshold)
        FactoryFacet newFacet = new FactoryFacet();
        console.log("New FactoryFacet deployed at:", address(newFacet));

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](3);

        // ── Cut 1: Remove 6 dead selectors from old facet ──────────────────────
        bytes4[] memory toRemove = new bytes4[](6);
        toRemove[0] = bytes4(0x16c38b3c); // setPaused(bool)
        toRemove[1] = bytes4(0xb187bd26); // isPaused()
        toRemove[2] = bytes4(0x220f72fc); // setProtocolArbiter(address)
        toRemove[3] = bytes4(0xeea6f749); // getProtocolArbiter()
        toRemove[4] = bytes4(0x9403d404); // setArbitrationThreshold(uint256)
        toRemove[5] = bytes4(0x189b468b); // getArbitrationThreshold()

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(0),
            action: IDiamondCut.FacetCutAction.Remove,
            functionSelectors: toRemove
        });

        // ── Cut 2: Replace 12 existing selectors → new facet address ───────────
        bytes4[] memory toReplace = new bytes4[](12);
        toReplace[0]  = FactoryFacet.initFactory.selector;
        toReplace[1]  = FactoryFacet.deployAgreement.selector;
        toReplace[2]  = FactoryFacet.setRegionFee.selector;
        toReplace[3]  = FactoryFacet.setFeeRecipient.selector;
        toReplace[4]  = FactoryFacet.setTrustedForwarder.selector;
        toReplace[5]  = FactoryFacet.setAgreementDeployer.selector;
        toReplace[6]  = FactoryFacet.getRegionFee.selector;
        toReplace[7]  = FactoryFacet.getAllFees.selector;
        toReplace[8]  = FactoryFacet.getFeeRecipient.selector;
        toReplace[9]  = FactoryFacet.getTrustedForwarder.selector;
        toReplace[10] = FactoryFacet.getUsdc.selector;
        toReplace[11] = FactoryFacet.getAgreementDeployer.selector;

        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: toReplace
        });

        // ── Cut 3: Add deployAndFund (was never registered in Diamond) ──────────
        bytes4[] memory toAdd = new bytes4[](1);
        toAdd[0] = FactoryFacet.deployAndFund.selector;

        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: toAdd
        });

        console.log("Cutting Diamond: removing 6, replacing 12, adding 1 selector...");
        IDiamondCut(diamond).diamondCut(cuts, address(0), "");

        console.log("FactoryFacet upgraded. Pause and dead arbiter fields are gone.");
        vm.stopBroadcast();
    }
}
