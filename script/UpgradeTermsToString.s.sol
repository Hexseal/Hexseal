// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeTermsToString.s.sol
// Мигрирует termsHash (bytes32) → terms (string) везде:
//   1. Редеплоит AgreementDeployer (новый Agreement bytecode)
//   2. Апгрейдит JobBoardFacet, ServiceBoardFacet, FactoryFacet
//   3. Обновляет agreementDeployer в Diamond
//
// Strategy: Remove ALL old selectors for each facet (fetched via Loupe),
// then Add ALL new selectors. Handles changed + unchanged selectors uniformly.
// ============================================================

import "forge-std/Script.sol";
import "../src/facets/JobBoardFacet.sol";
import "../src/facets/ServiceBoardFacet.sol";
import "../src/FactoryFacet.sol";
import "../src/AgreementDeployer.sol";
import "../src/DiamondProxy.sol";

interface ISetDeployer {
    function setAgreementDeployer(address deployer) external;
}

contract UpgradeTermsToString is Script {
    // Old facet addresses currently registered in Diamond (verified via cast)
    address constant OLD_JOB_BOARD = 0x7A96A4812a977D71fDCB4843aF068e13a6B3510f;
    address constant OLD_SVC_BOARD = 0xB8D23C2d42783207d7483e50fA07AC16D4034A5B;
    address constant OLD_FACTORY   = 0x0760211F2726F37B52c078a204E95fAb09f0E975;

    function run() external {
        address diamond = vm.envAddress("DIAMOND_ADDRESS");
        uint256 pk      = vm.envUint("PRIVATE_KEY");

        // ── Fetch old selectors via Loupe (before broadcast) ──────────────────
        bytes4[] memory oldJobSels = IDiamondLoupe(diamond).facetFunctionSelectors(OLD_JOB_BOARD);
        bytes4[] memory oldSvcSels = IDiamondLoupe(diamond).facetFunctionSelectors(OLD_SVC_BOARD);
        bytes4[] memory oldFctSels = IDiamondLoupe(diamond).facetFunctionSelectors(OLD_FACTORY);

        console.log("Old JobBoard selectors:    ", oldJobSels.length);
        console.log("Old ServiceBoard selectors:", oldSvcSels.length);
        console.log("Old Factory selectors:     ", oldFctSels.length);

        vm.startBroadcast(pk);

        // 1. New AgreementDeployer (holds new Agreement bytecode with string terms)
        AgreementDeployer newDeployer = new AgreementDeployer();
        console.log("New AgreementDeployer:", address(newDeployer));

        // 2. New facets
        JobBoardFacet     newJob     = new JobBoardFacet();
        ServiceBoardFacet newService = new ServiceBoardFacet();
        FactoryFacet      newFactory = new FactoryFacet();
        console.log("New JobBoardFacet:    ", address(newJob));
        console.log("New ServiceBoardFacet:", address(newService));
        console.log("New FactoryFacet:     ", address(newFactory));

        // 3. Enumerate all new selectors
        // JobBoardFacet: 12 functions
        bytes4[] memory newJobSels = new bytes4[](12);
        newJobSels[0]  = JobBoardFacet.mintJobWithPermit.selector;
        newJobSels[1]  = JobBoardFacet.mintJob.selector;
        newJobSels[2]  = JobBoardFacet.withdrawApplication.selector;
        newJobSels[3]  = JobBoardFacet.applyForJob.selector;
        newJobSels[4]  = JobBoardFacet.acceptApplicant.selector;
        newJobSels[5]  = JobBoardFacet.cancelJob.selector;
        newJobSels[6]  = JobBoardFacet.editJob.selector;
        newJobSels[7]  = JobBoardFacet.getJob.selector;
        newJobSels[8]  = JobBoardFacet.getClientJobs.selector;
        newJobSels[9]  = JobBoardFacet.getApplicants.selector;
        newJobSels[10] = JobBoardFacet.totalJobs.selector;
        newJobSels[11] = JobBoardFacet.getOpenJobs.selector;

        // ServiceBoardFacet: 22 functions
        bytes4[] memory newSvcSels = new bytes4[](22);
        newSvcSels[0]  = ServiceBoardFacet.mintService.selector;
        newSvcSels[1]  = ServiceBoardFacet.mintServiceWithPermit.selector;
        newSvcSels[2]  = ServiceBoardFacet.removeService.selector;
        newSvcSels[3]  = ServiceBoardFacet.pauseService.selector;
        newSvcSels[4]  = ServiceBoardFacet.unpauseService.selector;
        newSvcSels[5]  = ServiceBoardFacet.editService.selector;
        newSvcSels[6]  = ServiceBoardFacet.requestService.selector;
        newSvcSels[7]  = ServiceBoardFacet.requestServiceWithPermit.selector;
        newSvcSels[8]  = ServiceBoardFacet.acceptRequest.selector;
        newSvcSels[9]  = ServiceBoardFacet.rejectRequest.selector;
        newSvcSels[10] = ServiceBoardFacet.cancelRequest.selector;
        newSvcSels[11] = ServiceBoardFacet.getService.selector;
        newSvcSels[12] = ServiceBoardFacet.getExecutorServices.selector;
        newSvcSels[13] = ServiceBoardFacet.getServiceClients.selector;
        newSvcSels[14] = ServiceBoardFacet.totalServices.selector;
        newSvcSels[15] = ServiceBoardFacet.getRequest.selector;
        newSvcSels[16] = ServiceBoardFacet.getServiceRequests.selector;
        newSvcSels[17] = ServiceBoardFacet.getClientRequests.selector;
        newSvcSels[18] = ServiceBoardFacet.totalRequests.selector;
        newSvcSels[19] = ServiceBoardFacet.getRequestFunds.selector;
        newSvcSels[20] = ServiceBoardFacet.getActiveServices.selector;
        newSvcSels[21] = ServiceBoardFacet.getPendingRequests.selector;

        // FactoryFacet: 13 functions
        bytes4[] memory newFctSels = new bytes4[](13);
        newFctSels[0]  = FactoryFacet.initFactory.selector;
        newFctSels[1]  = FactoryFacet.deployAgreement.selector;
        newFctSels[2]  = FactoryFacet.deployAndFund.selector;
        newFctSels[3]  = FactoryFacet.setRegionFee.selector;
        newFctSels[4]  = FactoryFacet.setFeeRecipient.selector;
        newFctSels[5]  = FactoryFacet.setTrustedForwarder.selector;
        newFctSels[6]  = FactoryFacet.setAgreementDeployer.selector;
        newFctSels[7]  = FactoryFacet.getRegionFee.selector;
        newFctSels[8]  = FactoryFacet.getAllFees.selector;
        newFctSels[9]  = FactoryFacet.getFeeRecipient.selector;
        newFctSels[10] = FactoryFacet.getTrustedForwarder.selector;
        newFctSels[11] = FactoryFacet.getUsdc.selector;
        newFctSels[12] = FactoryFacet.getAgreementDeployer.selector;

        // 4. Diamond cut: Remove all old, then Add all new
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](6);
        cuts[0] = IDiamondCut.FacetCut({ facetAddress: address(0),          action: IDiamondCut.FacetCutAction.Remove, functionSelectors: oldJobSels });
        cuts[1] = IDiamondCut.FacetCut({ facetAddress: address(0),          action: IDiamondCut.FacetCutAction.Remove, functionSelectors: oldSvcSels });
        cuts[2] = IDiamondCut.FacetCut({ facetAddress: address(0),          action: IDiamondCut.FacetCutAction.Remove, functionSelectors: oldFctSels });
        cuts[3] = IDiamondCut.FacetCut({ facetAddress: address(newJob),     action: IDiamondCut.FacetCutAction.Add,    functionSelectors: newJobSels });
        cuts[4] = IDiamondCut.FacetCut({ facetAddress: address(newService), action: IDiamondCut.FacetCutAction.Add,    functionSelectors: newSvcSels });
        cuts[5] = IDiamondCut.FacetCut({ facetAddress: address(newFactory), action: IDiamondCut.FacetCutAction.Add,    functionSelectors: newFctSels });

        IDiamondCut(diamond).diamondCut(cuts, address(0), "");
        console.log("Diamond cut applied");

        // 5. Update AgreementDeployer in Diamond
        ISetDeployer(diamond).setAgreementDeployer(address(newDeployer));
        console.log("AgreementDeployer updated in Diamond");

        vm.stopBroadcast();
    }
}
