// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DiamondProxy.sol";
import "../src/JobReceiptFacet.sol";
import "../src/facets/JobBoardFacet.sol";

/**
 * UpgradeBurnReceipt
 *
 * Добавляет burn-on-cancel: при cancelJob() NFT-чек сжигается.
 *
 * [Replace 19] JobReceiptFacet — все существующие селекторы на новый адрес:
 *   ERC-721: name, symbol, supportsInterface, balanceOf, ownerOf, tokenURI
 *   Soulbound stubs: transferFrom x3, approve, setApprovalForAll, getApproved, isApprovedForAll
 *   Core: mintJobReceipt, setSvgRenderer, getSvgRenderer
 *   Views: getJobReceiptData, isJobReceiptToken, getReceiptTotalSupply
 *
 * [Add 3] JobReceiptFacet — новые функции:
 *   burnJobReceipt, isJobReceiptBurned, getTokenIdByJobId
 *
 * [Replace 11] JobBoardFacet — cancelJob теперь вызывает burnJobReceipt:
 *   mintJobWithPermit, mintJob, applyForJob, acceptApplicant, cancelJob,
 *   editJob, getJob, getClientJobs, getApplicants, totalJobs, getOpenJobs
 *
 * [Add 1] JobBoardFacet — withdrawApplication не была добавлена на текущий Diamond:
 *   withdrawApplication
 */
contract UpgradeBurnReceipt is Script {
    address constant DIAMOND = 0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        // 1. Deploy new facets
        JobReceiptFacet receiptFacet = new JobReceiptFacet();
        console.log("New JobReceiptFacet:", address(receiptFacet));

        JobBoardFacet jobFacet = new JobBoardFacet();
        console.log("New JobBoardFacet:  ", address(jobFacet));

        // 2. Build cuts
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](4);

        // ── [0] REPLACE 19: all existing JobReceiptFacet selectors ───────────
        bytes4[] memory receiptReplace = new bytes4[](19);
        receiptReplace[0]  = JobReceiptFacet.name.selector;
        receiptReplace[1]  = JobReceiptFacet.symbol.selector;
        receiptReplace[2]  = bytes4(0x01ffc9a7); // supportsInterface(bytes4) — историческая замена, функция с тех пор удалена из JobReceiptFacet
        receiptReplace[3]  = JobReceiptFacet.balanceOf.selector;
        receiptReplace[4]  = JobReceiptFacet.ownerOf.selector;
        receiptReplace[5]  = JobReceiptFacet.tokenURI.selector;
        receiptReplace[6]  = bytes4(0x23b872dd); // transferFrom(address,address,uint256)
        receiptReplace[7]  = bytes4(0x42842e0e); // safeTransferFrom(address,address,uint256)
        receiptReplace[8]  = bytes4(0xb88d4fde); // safeTransferFrom(address,address,uint256,bytes)
        receiptReplace[9]  = JobReceiptFacet.approve.selector;
        receiptReplace[10] = JobReceiptFacet.setApprovalForAll.selector;
        receiptReplace[11] = JobReceiptFacet.getApproved.selector;
        receiptReplace[12] = JobReceiptFacet.isApprovedForAll.selector;
        receiptReplace[13] = JobReceiptFacet.mintJobReceipt.selector;
        receiptReplace[14] = JobReceiptFacet.setSvgRenderer.selector;
        receiptReplace[15] = JobReceiptFacet.getSvgRenderer.selector;
        receiptReplace[16] = JobReceiptFacet.getJobReceiptData.selector;
        receiptReplace[17] = JobReceiptFacet.isJobReceiptToken.selector;
        receiptReplace[18] = JobReceiptFacet.getReceiptTotalSupply.selector;

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(receiptFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: receiptReplace
        });

        // ── [1] ADD 3: new burn/query functions ──────────────────────────────
        bytes4[] memory receiptAdd = new bytes4[](3);
        receiptAdd[0] = JobReceiptFacet.burnJobReceipt.selector;
        receiptAdd[1] = JobReceiptFacet.isJobReceiptBurned.selector;
        receiptAdd[2] = JobReceiptFacet.getTokenIdByJobId.selector;

        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(receiptFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: receiptAdd
        });

        // ── [2] REPLACE 11: existing JobBoardFacet selectors ────────────────
        // Note: withdrawApplication was never added to this Diamond (old script
        //       ran against the previous Diamond address) — handled in cut [3].
        bytes4[] memory jobReplace = new bytes4[](11);
        jobReplace[0]  = JobBoardFacet.mintJobWithPermit.selector;
        jobReplace[1]  = JobBoardFacet.mintJob.selector;
        jobReplace[2]  = JobBoardFacet.applyForJob.selector;
        jobReplace[3]  = JobBoardFacet.acceptApplicant.selector;
        jobReplace[4]  = JobBoardFacet.cancelJob.selector;
        jobReplace[5]  = JobBoardFacet.editJob.selector;
        jobReplace[6]  = JobBoardFacet.getJob.selector;
        jobReplace[7]  = JobBoardFacet.getClientJobs.selector;
        jobReplace[8]  = JobBoardFacet.getApplicants.selector;
        jobReplace[9]  = JobBoardFacet.totalJobs.selector;
        jobReplace[10] = JobBoardFacet.getOpenJobs.selector;

        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(jobFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: jobReplace
        });

        // ── [3] ADD 1: withdrawApplication (missing from current Diamond) ────
        bytes4[] memory jobAdd = new bytes4[](1);
        jobAdd[0] = JobBoardFacet.withdrawApplication.selector;

        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(jobFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: jobAdd
        });

        // 3. Apply — atomic: burnJobReceipt добавляется до того как cancelJob его вызывает
        console.log("Applying diamond cut (Replace 19 + Add 3 + Replace 11 + Add 1)...");
        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        vm.stopBroadcast();

        // 4. Verify
        require(
            IDiamondLoupe(DIAMOND).facetAddress(JobReceiptFacet.burnJobReceipt.selector) == address(receiptFacet),
            "burnJobReceipt: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(JobReceiptFacet.isJobReceiptBurned.selector) == address(receiptFacet),
            "isJobReceiptBurned: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(JobReceiptFacet.getTokenIdByJobId.selector) == address(receiptFacet),
            "getTokenIdByJobId: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(JobBoardFacet.cancelJob.selector) == address(jobFacet),
            "cancelJob: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(JobBoardFacet.withdrawApplication.selector) == address(jobFacet),
            "withdrawApplication: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(JobReceiptFacet.mintJobReceipt.selector) == address(receiptFacet),
            "mintJobReceipt: wrong facet"
        );

        console.log("=== UPGRADE VERIFIED ===");
        console.log("Diamond:          ", DIAMOND);
        console.log("JobReceiptFacet:  ", address(receiptFacet));
        console.log("JobBoardFacet:    ", address(jobFacet));
        console.log("burnJobReceipt:   ADD OK");
        console.log("cancelJob:        REPLACE OK (now burns receipt)");
        console.log("withdrawApplication: ADD OK (was missing from Diamond)");
    }
}
