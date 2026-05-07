// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DiamondProxy.sol";
import "../src/FactoryFacet.sol";

contract UpgradeFactoryFacetV2 is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address diamond = vm.envAddress("DIAMOND_ADDRESS");

        vm.startBroadcast(deployerKey);

        console.log("Deploying new FactoryFacet...");
        FactoryFacet newFactoryFacet = new FactoryFacet();
        console.log("New FactoryFacet:", address(newFactoryFacet));

        // All existing selectors (Replace) — 14 total
        bytes4[] memory existingSelectors = new bytes4[](14);
        existingSelectors[0] = FactoryFacet.initFactory.selector;
        existingSelectors[1] = FactoryFacet.deployAgreement.selector;
        existingSelectors[2] = FactoryFacet.setRegionFee.selector;
        existingSelectors[3] = FactoryFacet.setFeeRecipient.selector;
        existingSelectors[4] = FactoryFacet.setTrustedForwarder.selector;
        existingSelectors[5] = FactoryFacet.setPaused.selector;
        existingSelectors[6] = FactoryFacet.getRegionFee.selector;
        existingSelectors[7] = FactoryFacet.getAllFees.selector;
        existingSelectors[8] = FactoryFacet.getFeeRecipient.selector;
        existingSelectors[9] = FactoryFacet.getTrustedForwarder.selector;
        existingSelectors[10] = FactoryFacet.isPaused.selector;
        existingSelectors[11] = FactoryFacet.getUsdc.selector;
        existingSelectors[12] = FactoryFacet.setProtocolArbiter.selector;
        existingSelectors[13] = FactoryFacet.getProtocolArbiter.selector;

        // New selector (Add) — only deployAndFund
        bytes4[] memory newSelectors = new bytes4[](1);
        newSelectors[0] = FactoryFacet.deployAndFund.selector;

        // diamondCut: Replace existing + Add new
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](2);
        cut[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFactoryFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: existingSelectors
        });
        cut[1] = IDiamondCut.FacetCut({
            facetAddress: address(newFactoryFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: newSelectors
        });

        console.log("Upgrading FactoryFacet in Diamond at:", diamond);
        IDiamondCut(diamond).diamondCut(cut, address(0), "");

        console.log("FactoryFacet upgraded!");

        // Verify
        console.log("Verifying selectors...");
        address forwarder = FactoryFacet(diamond).getTrustedForwarder();
        console.log("Trusted Forwarder:", forwarder);

        address usdc = FactoryFacet(diamond).getUsdc();
        console.log("USDC:", usdc);

        address arbiter = FactoryFacet(diamond).getProtocolArbiter();
        console.log("Protocol Arbiter:", arbiter);

        vm.stopBroadcast();

        console.log("\nUpgrade complete! Diamond address unchanged:", diamond);
    }
}
