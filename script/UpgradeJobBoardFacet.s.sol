// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DiamondProxy.sol";
import "../src/facets/JobBoardFacet.sol";

/**
 * UpgradeJobBoardFacet — заменяет существующие селекторы и добавляет withdrawApplication.
 * REPLACE: 11 существующих функций
 * ADD:     withdrawApplication (новая)
 */
contract UpgradeJobBoardFacet is Script {
    address constant DIAMOND = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        JobBoardFacet newFacet = new JobBoardFacet();
        console.log("New JobBoardFacet deployed at:", address(newFacet));

        // Existing selectors — Replace with new implementation
        bytes4[] memory replaceSelectors = new bytes4[](11);
        replaceSelectors[0]  = JobBoardFacet.mintJobWithPermit.selector;
        replaceSelectors[1]  = JobBoardFacet.mintJob.selector;
        replaceSelectors[2]  = JobBoardFacet.applyForJob.selector;
        replaceSelectors[3]  = JobBoardFacet.acceptApplicant.selector;
        replaceSelectors[4]  = JobBoardFacet.cancelJob.selector;
        replaceSelectors[5]  = JobBoardFacet.editJob.selector;
        replaceSelectors[6]  = JobBoardFacet.getJob.selector;
        replaceSelectors[7]  = JobBoardFacet.getClientJobs.selector;
        replaceSelectors[8]  = JobBoardFacet.getApplicants.selector;
        replaceSelectors[9]  = JobBoardFacet.totalJobs.selector;
        replaceSelectors[10] = JobBoardFacet.getOpenJobs.selector;

        // New selector
        bytes4[] memory addSelectors = new bytes4[](1);
        addSelectors[0] = JobBoardFacet.withdrawApplication.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSelectors
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: addSelectors
        });

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");
        console.log("JobBoardFacet upgraded: 11 replaced + withdrawApplication added");

        vm.stopBroadcast();

        address check = IDiamondLoupe(DIAMOND).facetAddress(JobBoardFacet.withdrawApplication.selector);
        require(check == address(newFacet), "withdrawApplication: wrong facet");
        console.log("=== UPGRADE DONE ===");
    }
}
