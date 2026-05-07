// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DiamondProxy.sol";
import "../src/FactoryFacet.sol";

contract AddMissingSelectors is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address diamond = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;
        address factoryFacet = 0x5cE6d663a9C3cf846CB5D883e002eb6721F3BBAB;
        
        vm.startBroadcast(deployerKey);
        
        // Add missing selectors only
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = FactoryFacet.getProtocolArbiter.selector;
        selectors[1] = FactoryFacet.setProtocolArbiter.selector;
        selectors[2] = FactoryFacet.getArbitrationThreshold.selector;
        selectors[3] = FactoryFacet.setArbitrationThreshold.selector;
        selectors[4] = FactoryFacet.deployAndFund.selector;
        
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: factoryFacet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });
        
        console.log("Adding missing selectors to Diamond...");
        IDiamondCut(diamond).diamondCut(cuts, address(0), "");
        
        console.log("Missing selectors added to Diamond");
        
        vm.stopBroadcast();
    }
}
