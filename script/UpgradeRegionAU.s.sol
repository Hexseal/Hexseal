// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

// ============================================================
// UpgradeRegionAU.s.sol
//
// Добавляет регион 6 (AU) — расширяет с 0-5 до 0-6:
//   5: CA  $10  — без изменений
//   6: AU  $10  — новый (AU + NZ)
//
// Что меняется:
//   - region > 5 → region > 6  (FactoryFacet, JobBoardFacet, ServiceBoardFacet)
//   - getAllFees() теперь возвращает 7 значений (добавлен au)
//   - setRegionFee(6, 10_000_000) устанавливает fee для AU
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DiamondProxy.sol";
import "../src/FactoryFacet.sol";
import "../src/facets/JobBoardFacet.sol";
import "../src/facets/ServiceBoardFacet.sol";

contract UpgradeRegionAU is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address diamond = vm.envOr("DIAMOND_ADDRESS", address(0xF00CC71878c226E0b64253Fb71dD802aF12165D0));

        vm.startBroadcast(deployerKey);

        // ── 1. Deploy new facets ──────────────────────────────────────────────
        FactoryFacet      newFactory     = new FactoryFacet();
        JobBoardFacet     newJobBoard    = new JobBoardFacet();
        ServiceBoardFacet newServiceBoard = new ServiceBoardFacet();

        console.log("New FactoryFacet:      ", address(newFactory));
        console.log("New JobBoardFacet:     ", address(newJobBoard));
        console.log("New ServiceBoardFacet: ", address(newServiceBoard));

        // ── 2. Build cuts ─────────────────────────────────────────────────────
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](3);

        // ── FactoryFacet: REPLACE 19 existing selectors ──
        bytes4[] memory factorySelectors = new bytes4[](19);
        factorySelectors[0]  = FactoryFacet.deployAgreement.selector;
        factorySelectors[1]  = FactoryFacet.deployAndFund.selector;
        factorySelectors[2]  = FactoryFacet.setRegionFee.selector;
        factorySelectors[3]  = FactoryFacet.setFeeRecipient.selector;
        factorySelectors[4]  = FactoryFacet.setTrustedForwarder.selector;
        factorySelectors[5]  = bytes4(0x16c38b3c);
        factorySelectors[6]  = bytes4(0x220f72fc);
        factorySelectors[7]  = bytes4(0x9403d404);
        factorySelectors[8]  = FactoryFacet.setAgreementDeployer.selector;
        factorySelectors[9]  = FactoryFacet.getRegionFee.selector;
        factorySelectors[10] = FactoryFacet.getAllFees.selector;
        factorySelectors[11] = FactoryFacet.getFeeRecipient.selector;
        factorySelectors[12] = FactoryFacet.getTrustedForwarder.selector;
        factorySelectors[13] = bytes4(0xb187bd26);
        factorySelectors[14] = FactoryFacet.getUsdc.selector;
        factorySelectors[15] = bytes4(0xeea6f749);
        factorySelectors[16] = bytes4(0x189b468b);
        factorySelectors[17] = FactoryFacet.getAgreementDeployer.selector;
        factorySelectors[18] = FactoryFacet.initFactory.selector;

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFactory),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: factorySelectors
        });

        // ── JobBoardFacet: REPLACE 10 existing selectors ──
        bytes4[] memory jobSelectors = new bytes4[](10);
        jobSelectors[0] = JobBoardFacet.mintJobWithPermit.selector;
        jobSelectors[1] = JobBoardFacet.mintJob.selector;
        jobSelectors[2] = JobBoardFacet.applyForJob.selector;
        jobSelectors[3] = JobBoardFacet.acceptApplicant.selector;
        jobSelectors[4] = JobBoardFacet.cancelJob.selector;
        jobSelectors[5] = JobBoardFacet.getJob.selector;
        jobSelectors[6] = JobBoardFacet.getClientJobs.selector;
        jobSelectors[7] = JobBoardFacet.getApplicants.selector;
        jobSelectors[8] = JobBoardFacet.totalJobs.selector;
        jobSelectors[9] = JobBoardFacet.getOpenJobs.selector;

        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(newJobBoard),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: jobSelectors
        });

        // ── ServiceBoardFacet: REPLACE 21 existing selectors ──
        bytes4[] memory svcSelectors = new bytes4[](21);
        svcSelectors[0]  = ServiceBoardFacet.mintService.selector;
        svcSelectors[1]  = ServiceBoardFacet.mintServiceWithPermit.selector;
        svcSelectors[2]  = ServiceBoardFacet.removeService.selector;
        svcSelectors[3]  = ServiceBoardFacet.pauseService.selector;
        svcSelectors[4]  = ServiceBoardFacet.unpauseService.selector;
        svcSelectors[5]  = ServiceBoardFacet.requestService.selector;
        svcSelectors[6]  = ServiceBoardFacet.requestServiceWithPermit.selector;
        svcSelectors[7]  = ServiceBoardFacet.acceptRequest.selector;
        svcSelectors[8]  = ServiceBoardFacet.rejectRequest.selector;
        svcSelectors[9]  = ServiceBoardFacet.cancelRequest.selector;
        svcSelectors[10] = ServiceBoardFacet.getService.selector;
        svcSelectors[11] = ServiceBoardFacet.getExecutorServices.selector;
        svcSelectors[12] = ServiceBoardFacet.getServiceClients.selector;
        svcSelectors[13] = ServiceBoardFacet.totalServices.selector;
        svcSelectors[14] = ServiceBoardFacet.getRequest.selector;
        svcSelectors[15] = ServiceBoardFacet.getServiceRequests.selector;
        svcSelectors[16] = ServiceBoardFacet.getClientRequests.selector;
        svcSelectors[17] = ServiceBoardFacet.totalRequests.selector;
        svcSelectors[18] = ServiceBoardFacet.getRequestFunds.selector;
        svcSelectors[19] = ServiceBoardFacet.getActiveServices.selector;
        svcSelectors[20] = ServiceBoardFacet.getPendingRequests.selector;

        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(newServiceBoard),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: svcSelectors
        });

        // ── 3. Apply all cuts in one tx ───────────────────────────────────────
        console.log("Applying diamond cut (3 facets, all Replace)...");
        IDiamondCut(diamond).diamondCut(cuts, address(0), "");

        // ── 4. Set AU fee ─────────────────────────────────────────────────────
        console.log("Setting region fee for AU (6) = $7...");
        FactoryFacet(diamond).setRegionFee(6, 7_000_000);

        // ── 5. Verify ─────────────────────────────────────────────────────────
        (
            uint256 cis,
            uint256 asia,
            uint256 eu,
            uint256 us,
            uint256 latam,
            uint256 ca,
            uint256 au
        ) = FactoryFacet(diamond).getAllFees();

        console.log("");
        console.log("Region fees after upgrade:");
        console.log("  0 CIS:   ", cis);
        console.log("  1 Asia:  ", asia);
        console.log("  2 EU:    ", eu);
        console.log("  3 US:    ", us);
        console.log("  4 LATAM: ", latam);
        console.log("  5 CA:    ", ca);
        console.log("  6 AU:    ", au);
        console.log("");
        console.log("UpgradeRegionAU complete!");

        vm.stopBroadcast();
    }
}
