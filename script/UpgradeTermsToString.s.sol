// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeTermsToString.s.sol
// Мигрирует termsHash (bytes32) → terms (string) везде:
//   1. Редеплоит AgreementDeployer (новый Agreement bytecode)
//   2. Апгрейдит JobBoardFacet (новые selectors)
//   3. Апгрейдит ServiceBoardFacet (новые selectors)
//   4. Апгрейдит FactoryFacet (deployAgreement / deployAndFund)
//   5. Обновляет agreementDeployer в Diamond
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
    function run() external {
        address diamond = vm.envAddress("DIAMOND_ADDRESS");
        uint256 pk      = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);

        // 1. Новый AgreementDeployer (держит новый bytecode Agreement со string terms)
        AgreementDeployer newDeployer = new AgreementDeployer();
        console.log("New AgreementDeployer:", address(newDeployer));

        // 2. Новые фасеты
        JobBoardFacet     newJob     = new JobBoardFacet();
        ServiceBoardFacet newService = new ServiceBoardFacet();
        FactoryFacet      newFactory = new FactoryFacet();
        console.log("New JobBoardFacet:    ", address(newJob));
        console.log("New ServiceBoardFacet:", address(newService));
        console.log("New FactoryFacet:     ", address(newFactory));

        // 3. Diamond cut — Replace всех затронутых функций
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](3);

        // JobBoardFacet selectors
        bytes4[] memory jobSelectors = new bytes4[](8);
        jobSelectors[0] = JobBoardFacet.mintJobWithPermit.selector;
        jobSelectors[1] = JobBoardFacet.mintJob.selector;
        jobSelectors[2] = JobBoardFacet.editJob.selector;
        jobSelectors[3] = JobBoardFacet.acceptApplicant.selector;
        jobSelectors[4] = JobBoardFacet.cancelJob.selector;
        jobSelectors[5] = JobBoardFacet.applyForJob.selector;
        jobSelectors[6] = JobBoardFacet.withdrawApplication.selector;
        jobSelectors[7] = JobBoardFacet.getJob.selector;
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress:      address(newJob),
            action:            IDiamondCut.FacetCutAction.Replace,
            functionSelectors: jobSelectors
        });

        // ServiceBoardFacet selectors
        bytes4[] memory svcSelectors = new bytes4[](4);
        svcSelectors[0] = ServiceBoardFacet.requestService.selector;
        svcSelectors[1] = ServiceBoardFacet.requestServiceWithPermit.selector;
        svcSelectors[2] = ServiceBoardFacet.acceptRequest.selector;
        svcSelectors[3] = ServiceBoardFacet.rejectRequest.selector;
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress:      address(newService),
            action:            IDiamondCut.FacetCutAction.Replace,
            functionSelectors: svcSelectors
        });

        // FactoryFacet selectors
        bytes4[] memory factorySelectors = new bytes4[](2);
        factorySelectors[0] = FactoryFacet.deployAgreement.selector;
        factorySelectors[1] = FactoryFacet.deployAndFund.selector;
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress:      address(newFactory),
            action:            IDiamondCut.FacetCutAction.Replace,
            functionSelectors: factorySelectors
        });

        IDiamondCut(diamond).diamondCut(cuts, address(0), "");
        console.log("Diamond cut applied");

        // 4. Обновляем AgreementDeployer в Diamond
        ISetDeployer(diamond).setAgreementDeployer(address(newDeployer));
        console.log("AgreementDeployer updated in Diamond");

        vm.stopBroadcast();
    }
}
