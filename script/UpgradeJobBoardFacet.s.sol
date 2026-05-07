// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DiamondProxy.sol";
import "../src/facets/JobBoardFacet.sol";

/**
 * UpgradeJobBoardFacet — заменяет все 10 старых + добавляет 2 новых селектора.
 * Используй когда receiptNFT УЖЕ задеплоен и нужно только обновить фасет.
 * Для первого деплоя с JobReceiptNFT используй DeployJobReceiptNFT.s.sol.
 */
contract UpgradeJobBoardFacet is Script {
    address constant DIAMOND = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        JobBoardFacet newFacet = new JobBoardFacet();
        console.log("New JobBoardFacet deployed at:", address(newFacet));

        bytes4[] memory replaceSelectors = new bytes4[](10);
        replaceSelectors[0] = JobBoardFacet.mintJobWithPermit.selector;
        replaceSelectors[1] = JobBoardFacet.mintJob.selector;
        replaceSelectors[2] = JobBoardFacet.applyForJob.selector;
        replaceSelectors[3] = JobBoardFacet.acceptApplicant.selector;
        replaceSelectors[4] = JobBoardFacet.cancelJob.selector;
        replaceSelectors[5] = JobBoardFacet.getJob.selector;
        replaceSelectors[6] = JobBoardFacet.getClientJobs.selector;
        replaceSelectors[7] = JobBoardFacet.getApplicants.selector;
        replaceSelectors[8] = JobBoardFacet.totalJobs.selector;
        replaceSelectors[9] = JobBoardFacet.getOpenJobs.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSelectors
        });

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");
        console.log("JobBoardFacet upgraded (10 selectors)");

        vm.stopBroadcast();

        address check = IDiamondLoupe(DIAMOND).facetAddress(JobBoardFacet.acceptApplicant.selector);
        require(check == address(newFacet), "acceptApplicant: wrong facet");
        console.log("=== UPGRADE DONE ===");
    }
}
