// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// HEXSEAL — DeployFull.s.sol
// Полный деплой с нуля: Diamond + все фасеты + SVGRenderer + init.
// Использует новые storage slots (keccak256("hexseal.X.storage")).

import "forge-std/Script.sol";
import "forge-std/console.sol";

import "../src/DiamondProxy.sol";
import "../src/RegistryFacet.sol";
import "../src/FactoryFacet.sol";
import "../src/AgreementDeployer.sol";
import "../src/facets/JobBoardFacet.sol";
import "../src/facets/ServiceBoardFacet.sol";
import "../src/facets/ArbiterRegistryFacet.sol";
import "../src/facets/DealMetadataFacet.sol";
import "../src/JobReceiptFacet.sol";
import "../src/SVGRenderer.sol";

contract DeployFull is Script {

    function run() external {
        address usdc             = vm.envOr("USDC_ADDRESS",      address(0x036CbD53842c5426634e7929541eC2318f3dCF7e));
        address feeRecipient     = vm.envOr("FEE_RECIPIENT",     address(0));
        address trustedForwarder = vm.envOr("TRUSTED_FORWARDER", address(0));
        uint256 deployerKey      = vm.envUint("PRIVATE_KEY");
        address owner            = vm.addr(deployerKey);
        if (feeRecipient == address(0)) feeRecipient = owner;

        vm.startBroadcast(deployerKey);

        // ── 1. Деплой всех имплементаций ─────────────────────────────────────
        DiamondCutFacet        cutFacet     = new DiamondCutFacet();
        DiamondLoupeFacet      loupeFacet   = new DiamondLoupeFacet();
        OwnershipFacet         ownFacet     = new OwnershipFacet();
        RegistryFacet          regFacet     = new RegistryFacet();
        FactoryFacet           facFacet     = new FactoryFacet();
        AgreementDeployer      agDeployer   = new AgreementDeployer();
        JobBoardFacet          jobBoard     = new JobBoardFacet();
        ServiceBoardFacet      serviceBoard = new ServiceBoardFacet();
        ArbiterRegistryFacet   arbiterFacet = new ArbiterRegistryFacet();
        DealMetadataFacet      metaFacet    = new DealMetadataFacet();
        JobReceiptFacet        receiptFacet = new JobReceiptFacet();
        SVGRenderer            svgRenderer  = new SVGRenderer();

        console.log("--- Implementations ---");
        console.log("DiamondCutFacet:      ", address(cutFacet));
        console.log("DiamondLoupeFacet:    ", address(loupeFacet));
        console.log("OwnershipFacet:       ", address(ownFacet));
        console.log("RegistryFacet:        ", address(regFacet));
        console.log("FactoryFacet:         ", address(facFacet));
        console.log("AgreementDeployer:    ", address(agDeployer));
        console.log("JobBoardFacet:        ", address(jobBoard));
        console.log("ServiceBoardFacet:    ", address(serviceBoard));
        console.log("ArbiterRegistryFacet: ", address(arbiterFacet));
        console.log("DealMetadataFacet:    ", address(metaFacet));
        console.log("JobReceiptFacet:      ", address(receiptFacet));
        console.log("SVGRenderer:          ", address(svgRenderer));

        // ── 2. Базовые фасеты для конструктора Diamond ────────────────────────
        // (DiamondCut, DiamondLoupe, Ownership, Registry, Factory)
        // supportsInterface здесь от DiamondLoupeFacet — позже заменим на JobReceiptFacet
        IDiamondCut.FacetCut[] memory initCuts = new IDiamondCut.FacetCut[](5);

        // DiamondCutFacet — 1 селектор
        bytes4[] memory cutSels = new bytes4[](1);
        cutSels[0] = IDiamondCut.diamondCut.selector;
        initCuts[0] = _cut(address(cutFacet), IDiamondCut.FacetCutAction.Add, cutSels);

        // DiamondLoupeFacet — 5 селекторов
        bytes4[] memory loupeSels = new bytes4[](5);
        loupeSels[0] = IDiamondLoupe.facets.selector;
        loupeSels[1] = IDiamondLoupe.facetFunctionSelectors.selector;
        loupeSels[2] = IDiamondLoupe.facetAddresses.selector;
        loupeSels[3] = IDiamondLoupe.facetAddress.selector;
        loupeSels[4] = IERC165.supportsInterface.selector;
        initCuts[1] = _cut(address(loupeFacet), IDiamondCut.FacetCutAction.Add, loupeSels);

        // OwnershipFacet — 2 селектора
        bytes4[] memory ownSels = new bytes4[](2);
        ownSels[0] = OwnershipFacet.transferOwnership.selector;
        ownSels[1] = OwnershipFacet.owner.selector;
        initCuts[2] = _cut(address(ownFacet), IDiamondCut.FacetCutAction.Add, ownSels);

        // RegistryFacet — 13 селекторов
        bytes4[] memory regSels = new bytes4[](13);
        regSels[0]  = RegistryFacet.initRegistry.selector;
        regSels[1]  = RegistryFacet.register.selector;
        regSels[2]  = RegistryFacet.updateStatus.selector;
        regSels[3]  = RegistryFacet.setAuthorizedFactory.selector;
        regSels[4]  = RegistryFacet.hasActivePair.selector;
        regSels[5]  = RegistryFacet.getActivePair.selector;
        regSels[6]  = RegistryFacet.getRecord.selector;
        regSels[7]  = RegistryFacet.getByClient.selector;
        regSels[8]  = RegistryFacet.getByExecutor.selector;
        regSels[9]  = RegistryFacet.getActive.selector;
        regSels[10] = RegistryFacet.getDisputed.selector;
        regSels[11] = RegistryFacet.totalAgreements.selector;
        regSels[12] = RegistryFacet.authorizedFactory.selector;
        initCuts[3] = _cut(address(regFacet), IDiamondCut.FacetCutAction.Add, regSels);

        // FactoryFacet — 18 селекторов
        bytes4[] memory facSels = new bytes4[](18);
        facSels[0]  = FactoryFacet.initFactory.selector;
        facSels[1]  = FactoryFacet.deployAgreement.selector;
        facSels[2]  = FactoryFacet.setRegionFee.selector;
        facSels[3]  = FactoryFacet.setFeeRecipient.selector;
        facSels[4]  = FactoryFacet.setTrustedForwarder.selector;
        facSels[5]  = FactoryFacet.setPaused.selector;
        facSels[6]  = FactoryFacet.setProtocolArbiter.selector;
        facSels[7]  = FactoryFacet.setArbitrationThreshold.selector;
        facSels[8]  = FactoryFacet.setAgreementDeployer.selector;
        facSels[9]  = FactoryFacet.getRegionFee.selector;
        facSels[10] = FactoryFacet.getAllFees.selector;
        facSels[11] = FactoryFacet.getFeeRecipient.selector;
        facSels[12] = FactoryFacet.getTrustedForwarder.selector;
        facSels[13] = FactoryFacet.isPaused.selector;
        facSels[14] = FactoryFacet.getUsdc.selector;
        facSels[15] = FactoryFacet.getProtocolArbiter.selector;
        facSels[16] = FactoryFacet.getArbitrationThreshold.selector;
        facSels[17] = FactoryFacet.getAgreementDeployer.selector;
        initCuts[4] = _cut(address(facFacet), IDiamondCut.FacetCutAction.Add, facSels);

        // ── 3. Деплой Diamond ─────────────────────────────────────────────────
        DiamondProxy diamond = new DiamondProxy(owner, initCuts, address(0), "");
        console.log("--- Diamond ---");
        console.log("DiamondProxy:         ", address(diamond));

        // ── 4. Инициализация Registry + Factory ──────────────────────────────
        RegistryFacet(address(diamond)).initRegistry(address(diamond));
        FactoryFacet(address(diamond)).initFactory(
            usdc,
            feeRecipient,
            trustedForwarder,
            address(diamond),
            address(agDeployer)
        );

        // ── 5. Добавляем остальные фасеты одним diamondCut ───────────────────
        // Порядок: JobBoard, ServiceBoard, ArbiterRegistry, DealMetadata,
        //          JobReceiptFacet×2 (Replace supportsInterface + Add остальное)
        IDiamondCut.FacetCut[] memory cuts2 = new IDiamondCut.FacetCut[](6);

        // JobBoardFacet — 10 селекторов
        bytes4[] memory jobSels = new bytes4[](10);
        jobSels[0] = JobBoardFacet.mintJobWithPermit.selector;
        jobSels[1] = JobBoardFacet.mintJob.selector;
        jobSels[2] = JobBoardFacet.applyForJob.selector;
        jobSels[3] = JobBoardFacet.acceptApplicant.selector;
        jobSels[4] = JobBoardFacet.cancelJob.selector;
        jobSels[5] = JobBoardFacet.getJob.selector;
        jobSels[6] = JobBoardFacet.getClientJobs.selector;
        jobSels[7] = JobBoardFacet.getApplicants.selector;
        jobSels[8] = JobBoardFacet.totalJobs.selector;
        jobSels[9] = JobBoardFacet.getOpenJobs.selector;
        cuts2[0] = _cut(address(jobBoard), IDiamondCut.FacetCutAction.Add, jobSels);

        // ServiceBoardFacet — 21 селектор
        bytes4[] memory svcSels = new bytes4[](21);
        svcSels[0]  = ServiceBoardFacet.mintService.selector;
        svcSels[1]  = ServiceBoardFacet.mintServiceWithPermit.selector;
        svcSels[2]  = ServiceBoardFacet.removeService.selector;
        svcSels[3]  = ServiceBoardFacet.pauseService.selector;
        svcSels[4]  = ServiceBoardFacet.unpauseService.selector;
        svcSels[5]  = ServiceBoardFacet.requestService.selector;
        svcSels[6]  = ServiceBoardFacet.requestServiceWithPermit.selector;
        svcSels[7]  = ServiceBoardFacet.acceptRequest.selector;
        svcSels[8]  = ServiceBoardFacet.rejectRequest.selector;
        svcSels[9]  = ServiceBoardFacet.cancelRequest.selector;
        svcSels[10] = ServiceBoardFacet.getService.selector;
        svcSels[11] = ServiceBoardFacet.getExecutorServices.selector;
        svcSels[12] = ServiceBoardFacet.getServiceClients.selector;
        svcSels[13] = ServiceBoardFacet.totalServices.selector;
        svcSels[14] = ServiceBoardFacet.getRequest.selector;
        svcSels[15] = ServiceBoardFacet.getServiceRequests.selector;
        svcSels[16] = ServiceBoardFacet.getClientRequests.selector;
        svcSels[17] = ServiceBoardFacet.totalRequests.selector;
        svcSels[18] = ServiceBoardFacet.getRequestFunds.selector;
        svcSels[19] = ServiceBoardFacet.getActiveServices.selector;
        svcSels[20] = ServiceBoardFacet.getPendingRequests.selector;
        cuts2[1] = _cut(address(serviceBoard), IDiamondCut.FacetCutAction.Add, svcSels);

        // ArbiterRegistryFacet — 13 селекторов
        bytes4[] memory arbSels = new bytes4[](13);
        arbSels[0]  = ArbiterRegistryFacet.setChiefArbiter.selector;
        arbSels[1]  = ArbiterRegistryFacet.addArbiter.selector;
        arbSels[2]  = ArbiterRegistryFacet.removeArbiter.selector;
        arbSels[3]  = ArbiterRegistryFacet.commitDisputeClaim.selector;
        arbSels[4]  = ArbiterRegistryFacet.claimDispute.selector;
        arbSels[5]  = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        arbSels[6]  = ArbiterRegistryFacet.clearDisputeClaim.selector;
        arbSels[7]  = ArbiterRegistryFacet.getChiefArbiter.selector;
        arbSels[8]  = ArbiterRegistryFacet.isRegisteredArbiter.selector;
        arbSels[9]  = ArbiterRegistryFacet.getArbiters.selector;
        arbSels[10] = ArbiterRegistryFacet.getDisputeClaimer.selector;
        arbSels[11] = ArbiterRegistryFacet.getArbiterDeals.selector;
        arbSels[12] = ArbiterRegistryFacet.getClaimCommitment.selector;
        cuts2[2] = _cut(address(arbiterFacet), IDiamondCut.FacetCutAction.Add, arbSels);

        // DealMetadataFacet — 1 селектор
        bytes4[] memory metaSels = new bytes4[](1);
        metaSels[0] = DealMetadataFacet.getDealTokenURI.selector;
        cuts2[3] = _cut(address(metaFacet), IDiamondCut.FacetCutAction.Add, metaSels);

        // JobReceiptFacet ч.1 — REPLACE supportsInterface (заменяем DiamondLoupe's)
        bytes4[] memory receiptReplaceSels = new bytes4[](1);
        receiptReplaceSels[0] = IERC165.supportsInterface.selector;
        cuts2[4] = _cut(address(receiptFacet), IDiamondCut.FacetCutAction.Replace, receiptReplaceSels);

        // JobReceiptFacet ч.2 — ADD 18 новых селекторов ERC-721 + receipt
        bytes4[] memory receiptAddSels = new bytes4[](18);
        receiptAddSels[0]  = JobReceiptFacet.name.selector;
        receiptAddSels[1]  = JobReceiptFacet.symbol.selector;
        receiptAddSels[2]  = JobReceiptFacet.balanceOf.selector;
        receiptAddSels[3]  = JobReceiptFacet.ownerOf.selector;
        receiptAddSels[4]  = JobReceiptFacet.tokenURI.selector;
        receiptAddSels[5]  = bytes4(0x23b872dd); // transferFrom(address,address,uint256)
        receiptAddSels[6]  = bytes4(0x42842e0e); // safeTransferFrom(address,address,uint256)
        receiptAddSels[7]  = bytes4(0xb88d4fde); // safeTransferFrom(address,address,uint256,bytes)
        receiptAddSels[8]  = JobReceiptFacet.approve.selector;
        receiptAddSels[9]  = JobReceiptFacet.setApprovalForAll.selector;
        receiptAddSels[10] = JobReceiptFacet.getApproved.selector;
        receiptAddSels[11] = JobReceiptFacet.isApprovedForAll.selector;
        receiptAddSels[12] = JobReceiptFacet.mintJobReceipt.selector;
        receiptAddSels[13] = JobReceiptFacet.setSvgRenderer.selector;
        receiptAddSels[14] = JobReceiptFacet.getSvgRenderer.selector;
        receiptAddSels[15] = JobReceiptFacet.getJobReceiptData.selector;
        receiptAddSels[16] = JobReceiptFacet.isJobReceiptToken.selector;
        receiptAddSels[17] = JobReceiptFacet.getReceiptTotalSupply.selector;
        cuts2[5] = _cut(address(receiptFacet), IDiamondCut.FacetCutAction.Add, receiptAddSels);

        IDiamondCut(address(diamond)).diamondCut(cuts2, address(0), "");

        // ── 6. Линкуем SVGRenderer ────────────────────────────────────────────
        JobReceiptFacet(address(diamond)).setSvgRenderer(address(svgRenderer));

        vm.stopBroadcast();

        // ── 7. Итог ───────────────────────────────────────────────────────────
        console.log("\n======== HEXSEAL DEPLOYMENT COMPLETE ========");
        console.log("DiamondProxy:  ", address(diamond));
        console.log("SVGRenderer:   ", address(svgRenderer));
        console.log("USDC:          ", usdc);
        console.log("FeeRecipient:  ", feeRecipient);
        console.log("Forwarder:     ", trustedForwarder);
        console.log("Owner:         ", owner);
        console.log("=============================================");
        console.log("Update your .env:");
        console.log("DIAMOND_ADDRESS=", address(diamond));
    }

    function _cut(address facet, IDiamondCut.FacetCutAction action, bytes4[] memory sels)
        internal pure returns (IDiamondCut.FacetCut memory)
    {
        return IDiamondCut.FacetCut({ facetAddress: facet, action: action, functionSelectors: sels });
    }
}
