// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

import "forge-std/Script.sol";
import "../../src/DiamondProxy.sol";
import "../../src/facets/JobBoardFacet.sol";
import "../../src/facets/ServiceBoardFacet.sol";

contract AddBoardFacets is Script {
    address constant DIAMOND = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        JobBoardFacet jobBoard = new JobBoardFacet();
        ServiceBoardFacet serviceBoard = new ServiceBoardFacet();

        console.log("JobBoardFacet:", address(jobBoard));
        console.log("ServiceBoardFacet:", address(serviceBoard));

        bytes4[] memory jobSelectors = new bytes4[](7);
        jobSelectors[0] = JobBoardFacet.mintJob.selector;
        jobSelectors[1] = JobBoardFacet.applyForJob.selector;
        jobSelectors[2] = JobBoardFacet.acceptApplicant.selector;
        jobSelectors[3] = JobBoardFacet.cancelJob.selector;
        jobSelectors[4] = JobBoardFacet.getJob.selector;
        jobSelectors[5] = JobBoardFacet.getClientJobs.selector;
        jobSelectors[6] = JobBoardFacet.getApplicants.selector;

        bytes4[] memory serviceSelectors = new bytes4[](7);
        serviceSelectors[0] = ServiceBoardFacet.mintService.selector;
        serviceSelectors[1] = ServiceBoardFacet.removeService.selector;
        serviceSelectors[2] = ServiceBoardFacet.pauseService.selector;
        serviceSelectors[3] = ServiceBoardFacet.unpauseService.selector;
        serviceSelectors[4] = ServiceBoardFacet.getService.selector;
        serviceSelectors[5] = ServiceBoardFacet.getExecutorServices.selector;
        serviceSelectors[6] = ServiceBoardFacet.getServiceClients.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(jobBoard),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: jobSelectors
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(serviceBoard),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: serviceSelectors
        });

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");
        vm.stopBroadcast();

        address jobCheck = IDiamondLoupe(DIAMOND).facetAddress(JobBoardFacet.mintJob.selector);
        address svcCheck = IDiamondLoupe(DIAMOND).facetAddress(ServiceBoardFacet.mintService.selector);
        require(jobCheck == address(jobBoard), "JobBoardFacet: cut failed");
        require(svcCheck == address(serviceBoard), "ServiceBoardFacet: cut failed");

        console.log("JobBoardFacet in Diamond:", jobCheck);
        console.log("ServiceBoardFacet in Diamond:", svcCheck);
        console.log("=== DONE ===");
    }
}
