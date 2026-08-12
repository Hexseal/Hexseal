// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

// ============================================================
// UpgradeDealReceipts.s.sol
//
// Меняет lifecycle двух NFT-чеков:
//   1. AgreementDeployer — новый Agreement.sol больше не сжигает
//      TOKEN_ID/EXECUTOR_TOKEN_ID при финализации (COMPLETED/RESOLVED/
//      REFUNDED). Токен остаётся постоянным сертификатом сделки и
//      навсегда non-transferable (было: soulbound только пока
//      FUNDED/ACTIVE/DISPUTED).
//   2. JobBoardFacet — acceptApplicant() теперь сжигает posting-чек
//      (JobReceiptFacet) в момент деплоя Agreement: как только деньги
//      уходят из листинга в Agreement, старый чек устаревает и его
//      заменяет Agreement-NFT (обеим сторонам).
//
// Затрагивает только НОВЫЕ сделки/объявления. Существующие Agreement
// (уже задеплоенные) продолжают работать по старой логике — они не
// апгрейдятся, у них уже зашит старый байткод.
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../../src/DiamondProxy.sol";
import "../../src/FactoryFacet.sol";
import "../../src/AgreementDeployer.sol";
import "../../src/facets/JobBoardFacet.sol";

contract UpgradeDealReceipts is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address diamond = vm.envOr("DIAMOND_ADDRESS", address(0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557));

        vm.startBroadcast(deployerKey);

        // --- 1. Новый AgreementDeployer (новый Agreement.sol bytecode) ---
        Agreement agreementImpl = new Agreement();
        AgreementDeployer newDeployer = new AgreementDeployer(diamond, address(agreementImpl));
        console.log("New AgreementDeployer deployed at:", address(newDeployer));

        FactoryFacet(diamond).setAgreementDeployer(address(newDeployer));
        console.log("FactoryFacet.agreementDeployer updated.");

        // --- 2. Новый JobBoardFacet (burn чека при acceptApplicant) ---
        JobBoardFacet newJobBoard = new JobBoardFacet();
        console.log("New JobBoardFacet deployed at:", address(newJobBoard));

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
        // withdrawApplication уже добавлен в прошлом апгрейде — просто реплейсим все 11.

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newJobBoard),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSelectors
        });

        IDiamondCut(diamond).diamondCut(cuts, address(0), "");
        console.log("JobBoardFacet upgraded: 11 selectors replaced.");

        vm.stopBroadcast();

        address check = IDiamondLoupe(diamond).facetAddress(JobBoardFacet.acceptApplicant.selector);
        require(check == address(newJobBoard), "acceptApplicant: wrong facet");
        console.log("=== UPGRADE DONE ===");
    }
}
