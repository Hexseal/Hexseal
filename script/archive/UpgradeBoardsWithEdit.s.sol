// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../../src/DiamondProxy.sol";
import "../../src/facets/JobBoardFacet.sol";
import "../../src/facets/ServiceBoardFacet.sol";

/**
 * UpgradeBoardsWithEdit — добавляет editJob() в JobBoard и editService() в ServiceBoard.
 *
 * Стратегия: деплоим оба фасета заново, Replace всех существующих селекторов на новый
 * адрес (фасет = один контракт) + Add нового edit-селектора.
 *
 * Запуск:
 *   forge script script/UpgradeBoardsWithEdit.s.sol \
 *     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast
 */
contract UpgradeBoardsWithEdit is Script {
    address constant DIAMOND = 0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        // ── 1. JobBoardFacet ──────────────────────────────────────────────────
        JobBoardFacet jobFacet = new JobBoardFacet();
        console.log("New JobBoardFacet:", address(jobFacet));

        bytes4[] memory jobReplace = new bytes4[](10);
        jobReplace[0] = JobBoardFacet.mintJobWithPermit.selector;
        jobReplace[1] = JobBoardFacet.mintJob.selector;
        jobReplace[2] = JobBoardFacet.applyForJob.selector;
        jobReplace[3] = JobBoardFacet.acceptApplicant.selector;
        jobReplace[4] = JobBoardFacet.cancelJob.selector;
        jobReplace[5] = JobBoardFacet.getJob.selector;
        jobReplace[6] = JobBoardFacet.getClientJobs.selector;
        jobReplace[7] = JobBoardFacet.getApplicants.selector;
        jobReplace[8] = JobBoardFacet.totalJobs.selector;
        jobReplace[9] = JobBoardFacet.getOpenJobs.selector;

        bytes4[] memory jobAdd = new bytes4[](1);
        jobAdd[0] = JobBoardFacet.editJob.selector;

        // ── 2. ServiceBoardFacet ──────────────────────────────────────────────
        ServiceBoardFacet svcFacet = new ServiceBoardFacet();
        console.log("New ServiceBoardFacet:", address(svcFacet));

        bytes4[] memory svcReplace = new bytes4[](21);
        svcReplace[0]  = ServiceBoardFacet.mintService.selector;
        svcReplace[1]  = ServiceBoardFacet.mintServiceWithPermit.selector;
        svcReplace[2]  = ServiceBoardFacet.removeService.selector;
        svcReplace[3]  = ServiceBoardFacet.pauseService.selector;
        svcReplace[4]  = ServiceBoardFacet.unpauseService.selector;
        svcReplace[5]  = ServiceBoardFacet.requestService.selector;
        svcReplace[6]  = ServiceBoardFacet.requestServiceWithPermit.selector;
        svcReplace[7]  = ServiceBoardFacet.acceptRequest.selector;
        svcReplace[8]  = ServiceBoardFacet.rejectRequest.selector;
        svcReplace[9]  = ServiceBoardFacet.cancelRequest.selector;
        svcReplace[10] = ServiceBoardFacet.getService.selector;
        svcReplace[11] = ServiceBoardFacet.getExecutorServices.selector;
        svcReplace[12] = ServiceBoardFacet.getServiceClients.selector;
        svcReplace[13] = ServiceBoardFacet.totalServices.selector;
        svcReplace[14] = ServiceBoardFacet.getRequest.selector;
        svcReplace[15] = ServiceBoardFacet.getServiceRequests.selector;
        svcReplace[16] = ServiceBoardFacet.getClientRequests.selector;
        svcReplace[17] = ServiceBoardFacet.totalRequests.selector;
        svcReplace[18] = ServiceBoardFacet.getRequestFunds.selector;
        svcReplace[19] = ServiceBoardFacet.getActiveServices.selector;
        svcReplace[20] = ServiceBoardFacet.getPendingRequests.selector;

        bytes4[] memory svcAdd = new bytes4[](1);
        svcAdd[0] = ServiceBoardFacet.editService.selector;

        // ── 3. DiamondCut: 4 операции ─────────────────────────────────────────
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](4);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(jobFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: jobReplace
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(jobFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: jobAdd
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(svcFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: svcReplace
        });
        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(svcFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: svcAdd
        });

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");
        console.log("DiamondCut applied: 4 operations");

        vm.stopBroadcast();

        // ── 4. Verify ─────────────────────────────────────────────────────────
        require(
            IDiamondLoupe(DIAMOND).facetAddress(JobBoardFacet.editJob.selector) == address(jobFacet),
            "editJob: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(ServiceBoardFacet.editService.selector) == address(svcFacet),
            "editService: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(JobBoardFacet.acceptApplicant.selector) == address(jobFacet),
            "acceptApplicant: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(ServiceBoardFacet.acceptRequest.selector) == address(svcFacet),
            "acceptRequest: wrong facet"
        );
        console.log("=== UPGRADE VERIFIED ===");
    }
}
