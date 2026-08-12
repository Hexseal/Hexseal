// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../../src/DiamondProxy.sol";
import "../../src/FactoryFacet.sol";

// Picks up Agreement.sol changes:
//   - raiseDispute(): skip deadline check when markDone already called
//   - constructor: factory_ zero-address check
contract UpgradeFactoryFacetV4 is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address diamond = vm.envAddress("DIAMOND_ADDRESS");

        vm.startBroadcast(deployerKey);

        console.log("Deploying new FactoryFacet (V4)...");
        FactoryFacet newFactoryFacet = new FactoryFacet();
        console.log("New FactoryFacet:", address(newFactoryFacet));

        bytes4[] memory existingSelectors = new bytes4[](17);
        existingSelectors[0]  = FactoryFacet.initFactory.selector;
        existingSelectors[1]  = FactoryFacet.deployAgreement.selector;
        existingSelectors[2]  = FactoryFacet.setRegionFee.selector;
        existingSelectors[3]  = FactoryFacet.setFeeRecipient.selector;
        existingSelectors[4]  = FactoryFacet.setTrustedForwarder.selector;
        existingSelectors[5]  = bytes4(0x16c38b3c);
        existingSelectors[6]  = FactoryFacet.getRegionFee.selector;
        existingSelectors[7]  = FactoryFacet.getAllFees.selector;
        existingSelectors[8]  = FactoryFacet.getFeeRecipient.selector;
        existingSelectors[9]  = FactoryFacet.getTrustedForwarder.selector;
        existingSelectors[10] = bytes4(0xb187bd26);
        existingSelectors[11] = FactoryFacet.getUsdc.selector;
        existingSelectors[12] = bytes4(0x220f72fc);
        existingSelectors[13] = bytes4(0xeea6f749);
        existingSelectors[14] = FactoryFacet.deployAndFund.selector;
        existingSelectors[15] = bytes4(0x9403d404);
        existingSelectors[16] = bytes4(0x189b468b);

        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFactoryFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: existingSelectors
        });

        console.log("Upgrading FactoryFacet in Diamond at:", diamond);
        IDiamondCut(diamond).diamondCut(cut, address(0), "");

        console.log("FactoryFacet V4 upgraded!");

        address forwarder = FactoryFacet(diamond).getTrustedForwarder();
        console.log("Trusted Forwarder:", forwarder);

        address usdc = FactoryFacet(diamond).getUsdc();
        console.log("USDC:", usdc);

        vm.stopBroadcast();

        console.log("\nUpgrade complete! Diamond address unchanged:", diamond);
    }
}
