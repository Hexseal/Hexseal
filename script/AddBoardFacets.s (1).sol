// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/DiamondProxy.sol";
import "../src/facets/JobBoardFacet.sol";
import "../src/facets/ServiceBoardFacet.sol";

contract AddBoardFacets is Script {
    address constant DIAMOND   = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;
    address constant JOB_BOARD = 0x6D99d7C745DB7f9070523Ce3c1ed8b19BB56E9B0;
    address constant SVC_BOARD = 0xEDA0f04296e8783623284BE6d266Cc6206B9Da87;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        bytes4[] memory jobSels = new bytes4[](7);
        jobSels[0] = JobBoardFacet.mintJob.selector;
        jobSels[1] = JobBoardFacet.applyForJob.selector;
        jobSels[2] = JobBoardFacet.acceptApplicant.selector;
        jobSels[3] = JobBoardFacet.cancelJob.selector;
        jobSels[4] = JobBoardFacet.getJob.selector;
        jobSels[5] = JobBoardFacet.getClientJobs.selector;
        jobSels[6] = JobBoardFacet.getApplicants.selector;

        bytes4[] memory svcSels = new bytes4[](7);
        svcSels[0] = ServiceBoardFacet.mintService.selector;
        svcSels[1] = ServiceBoardFacet.pauseService.selector;
        svcSels[2] = ServiceBoardFacet.unpauseService.selector;
        svcSels[3] = ServiceBoardFacet.removeService.selector;
        svcSels[4] = ServiceBoardFacet.getService.selector;
        svcSels[5] = ServiceBoardFacet.getExecutorServices.selector;
        svcSels[6] = ServiceBoardFacet.getServiceClients.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: JOB_BOARD,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: jobSels
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: SVC_BOARD,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: svcSels
        });

        console.log("Adding JobBoardFacet:", JOB_BOARD);
        console.log("Adding ServiceBoardFacet:", SVC_BOARD);

        vm.startBroadcast(pk);
        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");
        vm.stopBroadcast();

        address j = IDiamondLoupe(DIAMOND).facetAddress(JobBoardFacet.mintJob.selector);
        address s = IDiamondLoupe(DIAMOND).facetAddress(ServiceBoardFacet.mintService.selector);
        require(j == JOB_BOARD, "JobBoardFacet not added");
        require(s == SVC_BOARD, "ServiceBoardFacet not added");

        console.log("JobBoardFacet OK:", j);
        console.log("ServiceBoardFacet OK:", s);
        console.log("=== DONE ===");

        console.log("-- JobBoard selectors --");
        for (uint256 i = 0; i < jobSels.length; i++) { console.logBytes4(jobSels[i]); }
        console.log("-- ServiceBoard selectors --");
        for (uint256 i = 0; i < svcSels.length; i++) { console.logBytes4(svcSels[i]); }
    }
}
