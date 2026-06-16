// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DiamondProxy.sol";
import "../src/facets/JobBoardFacet.sol";

/// @notice Upgrades JobBoardFacet to emit title/description/deadlineDays/termsHash in events.
///         Eliminates try_getJob() RPC calls from the subgraph indexer.
contract UpgradeJobBoardFacetV2 is Script {
    function run() external {
        address diamond = vm.envAddress("DIAMOND_ADDRESS");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        JobBoardFacet newFacet = new JobBoardFacet();
        console.log("New JobBoardFacet deployed at:", address(newFacet));

        bytes4[] memory selectors = new bytes4[](12);
        selectors[0]  = JobBoardFacet.mintJobWithPermit.selector;
        selectors[1]  = JobBoardFacet.mintJob.selector;
        selectors[2]  = JobBoardFacet.withdrawApplication.selector;
        selectors[3]  = JobBoardFacet.applyForJob.selector;
        selectors[4]  = JobBoardFacet.acceptApplicant.selector;
        selectors[5]  = JobBoardFacet.cancelJob.selector;
        selectors[6]  = JobBoardFacet.editJob.selector;
        selectors[7]  = JobBoardFacet.getJob.selector;
        selectors[8]  = JobBoardFacet.getClientJobs.selector;
        selectors[9]  = JobBoardFacet.getApplicants.selector;
        selectors[10] = JobBoardFacet.totalJobs.selector;
        selectors[11] = JobBoardFacet.getOpenJobs.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: selectors
        });

        IDiamondCut(diamond).diamondCut(cuts, address(0), "");
        console.log("JobBoardFacet v2 upgraded at diamond:", diamond);

        vm.stopBroadcast();

        address check = IDiamondLoupe(diamond).facetAddress(JobBoardFacet.mintJob.selector);
        require(check == address(newFacet), "mintJob: wrong facet after upgrade");
        console.log("=== JobBoardFacet V2 DONE ===");
    }
}
