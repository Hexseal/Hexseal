// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/FactoryFacet.sol";
import "../src/DiamondProxy.sol";

contract UpgradeFactoryFacet is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address diamond = vm.envOr("DIAMOND_ADDRESS", address(0xF00CC71878c226E0b64253Fb71dD802aF12165D0));

        vm.startBroadcast(deployerKey);

        // 1. Deploy new FactoryFacet
        FactoryFacet newFactoryFacet = new FactoryFacet();
        console.log("New FactoryFacet deployed at:", address(newFactoryFacet));

        // 2. All 17 selectors from FactoryFacet
        bytes4[] memory selectors = new bytes4[](17);
        selectors[0]  = FactoryFacet.initFactory.selector;
        selectors[1]  = FactoryFacet.deployAgreement.selector;
        selectors[2]  = FactoryFacet.deployAndFund.selector;
        selectors[3]  = FactoryFacet.setRegionFee.selector;
        selectors[4]  = FactoryFacet.setFeeRecipient.selector;
        selectors[5]  = FactoryFacet.setTrustedForwarder.selector;
        selectors[6]  = FactoryFacet.setPaused.selector;
        selectors[7]  = FactoryFacet.setProtocolArbiter.selector;
        selectors[8]  = FactoryFacet.setArbitrationThreshold.selector;
        selectors[9]  = FactoryFacet.getRegionFee.selector;
        selectors[10] = FactoryFacet.getAllFees.selector;
        selectors[11] = FactoryFacet.getFeeRecipient.selector;
        selectors[12] = FactoryFacet.getTrustedForwarder.selector;
        selectors[13] = FactoryFacet.isPaused.selector;
        selectors[14] = FactoryFacet.getUsdc.selector;
        selectors[15] = FactoryFacet.getProtocolArbiter.selector;
        selectors[16] = FactoryFacet.getArbitrationThreshold.selector;

        // 3. Replace existing selectors
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFactoryFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: selectors
        });

        console.log("Replacing FactoryFacet selectors in Diamond...");
        IDiamondCut(diamond).diamondCut(cuts, address(0), "");

        console.log("FactoryFacet upgraded successfully!");
        console.log("Diamond:", diamond);
        console.log("New FactoryFacet:", address(newFactoryFacet));

        vm.stopBroadcast();
    }
}
