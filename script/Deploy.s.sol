// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";

import "../src/DiamondProxy.sol";
import "../src/RegistryFacet.sol";
import "../src/FactoryFacet.sol";
import "../src/AgreementDeployer.sol";

contract DeployHexseal is Script {

    // ----------------------------------------------------------------
    // Адреса из .env
    // ----------------------------------------------------------------
    address usdc;
    address feeRecipient;
    address trustedForwarder;
    address deployerOwner;

    // ----------------------------------------------------------------
    // Задеплоенные контракты
    // ----------------------------------------------------------------
    address diamond;
    address registryFacet;
    address factoryFacet;
    address diamondCutFacet;
    address diamondLoupeFacet;
    address ownershipFacet;

    function run() external {
        // Читаем .env
        usdc             = vm.envOr("USDC_ADDRESS", address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913));
        feeRecipient     = vm.envOr("FEE_RECIPIENT", address(0));
        trustedForwarder = vm.envOr("TRUSTED_FORWARDER", address(0));
        deployerOwner    = vm.envOr("OWNER_ADDRESS", address(0));

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        if (deployerOwner == address(0)) {
            deployerOwner = vm.addr(deployerKey);
        }
        if (feeRecipient == address(0)) {
            feeRecipient = deployerOwner;
        }

        vm.startBroadcast(deployerKey);

        // ----------------------------------------------------------------
        // 1. Деплой фасетов
        // ----------------------------------------------------------------
        console.log("Deploying facets...");

        DiamondCutFacet   cutFacet    = new DiamondCutFacet();
        DiamondLoupeFacet loupeFacet  = new DiamondLoupeFacet();
        OwnershipFacet    ownFacet    = new OwnershipFacet();
        RegistryFacet     regFacet    = new RegistryFacet();
        FactoryFacet      facFacet    = new FactoryFacet();
        AgreementDeployer agDeployer  = new AgreementDeployer();

        diamondCutFacet   = address(cutFacet);
        diamondLoupeFacet = address(loupeFacet);
        ownershipFacet    = address(ownFacet);
        registryFacet     = address(regFacet);
        factoryFacet      = address(facFacet);

        console.log("DiamondCutFacet:   ", diamondCutFacet);
        console.log("DiamondLoupeFacet: ", diamondLoupeFacet);
        console.log("OwnershipFacet:    ", ownershipFacet);
        console.log("RegistryFacet:     ", registryFacet);
        console.log("FactoryFacet:      ", factoryFacet);
        console.log("AgreementDeployer: ", address(agDeployer));

        // ----------------------------------------------------------------
        // 2. Собираем FacetCut[] для Diamond
        // ----------------------------------------------------------------
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](5);

        // DiamondCutFacet
        bytes4[] memory cutSelectors = new bytes4[](1);
        cutSelectors[0] = IDiamondCut.diamondCut.selector;
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: diamondCutFacet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: cutSelectors
        });

        // DiamondLoupeFacet
        bytes4[] memory loupeSelectors = new bytes4[](5);
        loupeSelectors[0] = IDiamondLoupe.facets.selector;
        loupeSelectors[1] = IDiamondLoupe.facetFunctionSelectors.selector;
        loupeSelectors[2] = IDiamondLoupe.facetAddresses.selector;
        loupeSelectors[3] = IDiamondLoupe.facetAddress.selector;
        loupeSelectors[4] = IERC165.supportsInterface.selector;
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: diamondLoupeFacet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: loupeSelectors
        });

        // OwnershipFacet
        bytes4[] memory ownSelectors = new bytes4[](2);
        ownSelectors[0] = OwnershipFacet.transferOwnership.selector;
        ownSelectors[1] = OwnershipFacet.owner.selector;
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: ownershipFacet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: ownSelectors
        });

        // RegistryFacet — все селекторы
        bytes4[] memory regSelectors = new bytes4[](12);
        regSelectors[0] = RegistryFacet.initRegistry.selector;
        regSelectors[1] = RegistryFacet.register.selector;
        regSelectors[2] = RegistryFacet.updateStatus.selector;
        regSelectors[3] = RegistryFacet.setAuthorizedFactory.selector;
        regSelectors[4] = RegistryFacet.hasActivePair.selector;
        regSelectors[5] = RegistryFacet.getActivePair.selector;
        regSelectors[6] = RegistryFacet.getRecord.selector;
        regSelectors[7] = RegistryFacet.getByClient.selector;
        regSelectors[8] = RegistryFacet.getByExecutor.selector;
        regSelectors[9] = RegistryFacet.getActive.selector;
        regSelectors[10] = RegistryFacet.totalAgreements.selector;
        regSelectors[11] = RegistryFacet.authorizedFactory.selector;
        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: registryFacet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: regSelectors
        });

        // FactoryFacet — все селекторы
        bytes4[] memory facSelectors = new bytes4[](10);
        facSelectors[0] = FactoryFacet.initFactory.selector;
        facSelectors[1] = FactoryFacet.deployAgreement.selector;
        facSelectors[2] = FactoryFacet.setRegionFee.selector;
        facSelectors[3] = FactoryFacet.setFeeRecipient.selector;
        facSelectors[4] = FactoryFacet.setTrustedForwarder.selector;
        facSelectors[5] = FactoryFacet.getRegionFee.selector;
        facSelectors[6] = FactoryFacet.getAllFees.selector;
        facSelectors[7] = FactoryFacet.getFeeRecipient.selector;
        facSelectors[8] = FactoryFacet.getTrustedForwarder.selector;
        facSelectors[9] = FactoryFacet.getUsdc.selector;
        cuts[4] = IDiamondCut.FacetCut({
            facetAddress: factoryFacet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: facSelectors
        });

        // ----------------------------------------------------------------
        // 3. Деплой Diamond
        // ----------------------------------------------------------------
        console.log("Deploying Diamond...");

        DiamondProxy dp = new DiamondProxy(
            deployerOwner,
            cuts,
            address(0),
            ""
        );
        diamond = address(dp);
        console.log("Diamond:           ", diamond);

        // ----------------------------------------------------------------
        // 4. Инициализация фасетов через Diamond
        // ----------------------------------------------------------------
        console.log("Initializing facets...");

        RegistryFacet(diamond).initRegistry(diamond);
        FactoryFacet(diamond).initFactory(
            usdc,
            feeRecipient,
            trustedForwarder,
            diamond,
            address(agDeployer)
        );

        console.log("Initialized.");

        vm.stopBroadcast();

        // ----------------------------------------------------------------
        // 5. Итог
        // ----------------------------------------------------------------
        console.log("\n========== DEPLOYMENT COMPLETE ==========");
        console.log("Diamond (main address): ", diamond);
        console.log("USDC:                   ", usdc);
        console.log("Fee Recipient:          ", feeRecipient);
        console.log("Trusted Forwarder:      ", trustedForwarder);
        console.log("Owner:                  ", deployerOwner);
        console.log("=========================================");
        console.log("Add to .env:");
        console.log("DIAMOND_ADDRESS=", diamond);
        
        // ----------------------------------------------------------------
        // 6. Генерация ABI через forge inspect
        // ----------------------------------------------------------------
        console.log("\nTo generate ABI, run:");
        console.log("forge inspect DiamondProxy abi > out/Diamond.json");
        console.log("Or use individual facets:");
        console.log("forge inspect RegistryFacet abi > out/RegistryFacet.json");
        console.log("forge inspect FactoryFacet abi > out/FactoryFacet.json");
        console.log("forge inspect Agreement abi > out/Agreement.json");
    }
}
