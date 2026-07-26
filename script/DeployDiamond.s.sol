// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/DiamondProxy.sol";
import "../src/RegistryFacet.sol";
import "../src/FactoryFacet.sol";
import "../src/AgreementDeployer.sol";

contract DeployDiamond is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        address usdc = vm.envOr("USDC_ADDRESS", address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)); // Base mainnet
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);
        address trustedForwarder = vm.envOr("TRUSTED_FORWARDER", address(0)); // Gelato или свой
        
        vm.startBroadcast(deployerPrivateKey);
        
        // 1. Деплоим фасеты
        RegistryFacet registryFacet = new RegistryFacet();
        FactoryFacet factoryFacet = new FactoryFacet();
        DiamondCutFacet diamondCutFacet = new DiamondCutFacet();
        DiamondLoupeFacet diamondLoupeFacet = new DiamondLoupeFacet();
        OwnershipFacet ownershipFacet = new OwnershipFacet();
        
        // 2. Собираем diamondCut
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](5);
        
        // RegistryFacet
        cut[0] = IDiamondCut.FacetCut({
            facetAddress: address(registryFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: generateSelectors("RegistryFacet")
        });
        
        // FactoryFacet
        cut[1] = IDiamondCut.FacetCut({
            facetAddress: address(factoryFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: generateSelectors("FactoryFacet")
        });
        
        // DiamondCutFacet
        cut[2] = IDiamondCut.FacetCut({
            facetAddress: address(diamondCutFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: generateSelectors("DiamondCutFacet")
        });
        
        // DiamondLoupeFacet
        cut[3] = IDiamondCut.FacetCut({
            facetAddress: address(diamondLoupeFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: generateSelectors("DiamondLoupeFacet")
        });
        
        // OwnershipFacet
        cut[4] = IDiamondCut.FacetCut({
            facetAddress: address(ownershipFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: generateSelectors("OwnershipFacet")
        });
        
        // 3. Деплоим DiamondProxy
        DiamondProxy diamond = new DiamondProxy(deployer, cut, address(0), "");
        
        // AgreementDeployer needs Diamond as authorizedCaller — deploy after Diamond is known
        Agreement agreementImpl = new Agreement();
        AgreementDeployer agreementDeployer = new AgreementDeployer(address(diamond), address(agreementImpl));

        // 4. Инициализируем фасеты
        RegistryFacet(address(diamond)).initRegistry(address(diamond)); // FactoryFacet = Diamond address
        FactoryFacet(address(diamond)).initFactory(usdc, feeRecipient, trustedForwarder, address(diamond), address(agreementDeployer));
        
        vm.stopBroadcast();
        
        console.log("Diamond deployed at:", address(diamond));
        console.log("RegistryFacet:", address(registryFacet));
        console.log("FactoryFacet:", address(factoryFacet));
        console.log("DiamondCutFacet:", address(diamondCutFacet));
        console.log("DiamondLoupeFacet:", address(diamondLoupeFacet));
        console.log("OwnershipFacet:", address(ownershipFacet));
    }
    
    function generateSelectors(string memory facetName) internal pure returns (bytes4[] memory) {
        if (keccak256(bytes(facetName)) == keccak256(bytes("RegistryFacet"))) {
            bytes4[] memory selectors = new bytes4[](8);
            selectors[0] = RegistryFacet.initRegistry.selector;
            selectors[1] = RegistryFacet.register.selector;
            selectors[2] = RegistryFacet.updateStatus.selector;
            selectors[3] = RegistryFacet.setAuthorizedFactory.selector;
            selectors[4] = RegistryFacet.hasActivePair.selector;
            selectors[5] = RegistryFacet.getActivePair.selector;
            selectors[6] = RegistryFacet.getRecord.selector;
            selectors[7] = RegistryFacet.getByClient.selector;
            // Можно добавить getByExecutor, getActive, totalAgreements, authorizedFactory
            return selectors;
        } else if (keccak256(bytes(facetName)) == keccak256(bytes("FactoryFacet"))) {
            bytes4[] memory selectors = new bytes4[](10);
            selectors[0] = FactoryFacet.initFactory.selector;
            selectors[1] = FactoryFacet.deployAgreement.selector;
            selectors[2] = FactoryFacet.setRegionFee.selector;
            selectors[3] = FactoryFacet.setFeeRecipient.selector;
            selectors[4] = FactoryFacet.setTrustedForwarder.selector;
            selectors[5] = bytes4(0x16c38b3c);
            selectors[6] = FactoryFacet.getRegionFee.selector;
            selectors[7] = FactoryFacet.getAllFees.selector;
            selectors[8] = FactoryFacet.getFeeRecipient.selector;
            selectors[9] = FactoryFacet.getTrustedForwarder.selector;
            return selectors;
        } else if (keccak256(bytes(facetName)) == keccak256(bytes("DiamondCutFacet"))) {
            bytes4[] memory selectors = new bytes4[](1);
            selectors[0] = DiamondCutFacet.diamondCut.selector;
            return selectors;
        } else if (keccak256(bytes(facetName)) == keccak256(bytes("DiamondLoupeFacet"))) {
            bytes4[] memory selectors = new bytes4[](5);
            selectors[0] = DiamondLoupeFacet.facets.selector;
            selectors[1] = DiamondLoupeFacet.facetFunctionSelectors.selector;
            selectors[2] = DiamondLoupeFacet.facetAddresses.selector;
            selectors[3] = DiamondLoupeFacet.facetAddress.selector;
            selectors[4] = DiamondLoupeFacet.supportsInterface.selector;
            return selectors;
        } else if (keccak256(bytes(facetName)) == keccak256(bytes("OwnershipFacet"))) {
            bytes4[] memory selectors = new bytes4[](4);
            selectors[0] = OwnershipFacet.transferOwnership.selector;
            selectors[1] = OwnershipFacet.owner.selector;
            selectors[2] = OwnershipFacet.acceptOwnership.selector;
            selectors[3] = OwnershipFacet.pendingOwner.selector;
            return selectors;
        }
        revert("Unknown facet");
    }
}