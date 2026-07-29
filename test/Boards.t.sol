// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./BoardsFixture.sol";
import "../src/SVGRenderer.sol";

// ---------- TEST ----------

contract BoardsTest is BoardsFixture {
    // ============================================================
    //  HELPERS
    // ============================================================

    function _approveAndMintJob() internal returns (uint256 jobId) {
        vm.startPrank(client);
        // JobBoard теперь prices через quote() (percentage), не по региону —
        // approve на весь баланс вместо точной старой суммы FEE + AMOUNT.
        usdc.approve(address(diamond), type(uint256).max);
        jobId = JobBoardFacet(address(diamond)).mintJob(
            "Build a dApp",
            "Need a Solidity dev",
            AMOUNT,
            DEADLINE,
            TERMS,
            REGION
        );
        vm.stopPrank();
    }

    // ============================================================
    //  JOB BOARD TESTS
    // ============================================================

    function testMintJob() public {
        uint256 clientBefore = usdc.balanceOf(client);
        uint256 feeBefore = usdc.balanceOf(feeRecipient);

        uint256 jobId = _approveAndMintJob();

        assertEq(jobId, 0);

        JobBoardStorage.Job memory job = JobBoardFacet(address(diamond)).getJob(jobId);
        assertEq(job.client, client);
        assertEq(job.amount, AMOUNT);
        assertEq(uint256(job.status), uint256(JobBoardStorage.JobStatus.OPEN));

        // Комиссия удержана в Diamond — сделки ещё нет, получателю ничего не ушло
        assertEq(usdc.balanceOf(client), clientBefore - JOB_FEE - AMOUNT);
        assertEq(usdc.balanceOf(feeRecipient), feeBefore);
        assertEq(usdc.balanceOf(address(diamond)), AMOUNT + JOB_FEE);
    }

    function testMintJobInvalidTitle() public {
        vm.startPrank(client);
        usdc.approve(address(diamond), FEE + AMOUNT);

        vm.expectRevert(JobBoardFacet.TitleInvalid.selector);
        JobBoardFacet(address(diamond)).mintJob("", "desc", AMOUNT, DEADLINE, TERMS, REGION);
        vm.stopPrank();
    }

    function testMintJobZeroAmount() public {
        vm.startPrank(client);
        usdc.approve(address(diamond), FEE + AMOUNT);

        vm.expectRevert(JobBoardFacet.ZeroAmount.selector);
        JobBoardFacet(address(diamond)).mintJob("title", "desc", 0, DEADLINE, TERMS, REGION);
        vm.stopPrank();
    }

    function testApplyForJob() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);

        address[] memory applicants = JobBoardFacet(address(diamond)).getApplicants(jobId);
        assertEq(applicants.length, 1);
        assertEq(applicants[0], executor);
    }

    function testApplyForJobDuplicate() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);

        vm.prank(executor);
        vm.expectRevert(JobBoardFacet.AlreadyApplied.selector);
        JobBoardFacet(address(diamond)).applyForJob(jobId);
    }

    function testApplyForJobSelf() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(client);
        vm.expectRevert(JobBoardFacet.SelfApply.selector);
        JobBoardFacet(address(diamond)).applyForJob(jobId);
    }

    function testAcceptApplicant() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);

        uint256 feeBefore = usdc.balanceOf(feeRecipient);

        vm.prank(client);
        address agreementAddr = JobBoardFacet(address(diamond)).acceptApplicant(jobId, executor);

        // Job обновилась
        JobBoardStorage.Job memory job = JobBoardFacet(address(diamond)).getJob(jobId);
        assertEq(uint256(job.status), uint256(JobBoardStorage.JobStatus.ACCEPTED));
        assertEq(job.chosenExecutor, executor);
        assertEq(job.agreement, agreementAddr);

        // Diamond отдал amount в Agreement, а удержанную комиссию — в feeRecipient
        assertEq(usdc.balanceOf(address(diamond)), 0);
        assertEq(usdc.balanceOf(feeRecipient), feeBefore + JOB_FEE);

        // Agreement зарегистрирован в Registry
        assertTrue(RegistryFacet(address(diamond)).hasActivePair(client, executor));

        // Agreement адрес ненулевой
        assertTrue(agreementAddr != address(0));
    }

    function testAcceptApplicantNotClient() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);

        vm.prank(executor); // не клиент
        vm.expectRevert(JobBoardFacet.NotClient.selector);
        JobBoardFacet(address(diamond)).acceptApplicant(jobId, executor);
    }

    function testAcceptApplicantNotApplied() public {
        uint256 jobId = _approveAndMintJob();
        // executor не откликался

        vm.prank(client);
        vm.expectRevert(JobBoardFacet.NotApplicant.selector);
        JobBoardFacet(address(diamond)).acceptApplicant(jobId, executor);
    }

    function testCancelJob() public {
        uint256 jobId = _approveAndMintJob();
        uint256 clientBefore = usdc.balanceOf(client);

        vm.prank(client);
        JobBoardFacet(address(diamond)).cancelJob(jobId);

        // Refund: amount + комиссия сверх пола, пол остаётся протоколу
        assertEq(usdc.balanceOf(client), clientBefore + AMOUNT + (JOB_FEE - JOB_FLOOR));
        assertEq(usdc.balanceOf(feeRecipient), JOB_FLOOR);
        assertEq(usdc.balanceOf(address(diamond)), 0);

        // Статус
        JobBoardStorage.Job memory job = JobBoardFacet(address(diamond)).getJob(jobId);
        assertEq(uint256(job.status), uint256(JobBoardStorage.JobStatus.CANCELLED));
    }

    function testCancelJobNotClient() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        vm.expectRevert(JobBoardFacet.NotClient.selector);
        JobBoardFacet(address(diamond)).cancelJob(jobId);
    }

    function testCancelJobAlreadyCancelled() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(client);
        JobBoardFacet(address(diamond)).cancelJob(jobId);

        vm.prank(client);
        vm.expectRevert(JobBoardFacet.JobNotOpen.selector);
        JobBoardFacet(address(diamond)).cancelJob(jobId);
    }

    function testCancelAfterAccept() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);

        vm.prank(client);
        JobBoardFacet(address(diamond)).acceptApplicant(jobId, executor);

        vm.prank(client);
        vm.expectRevert(JobBoardFacet.JobNotOpen.selector);
        JobBoardFacet(address(diamond)).cancelJob(jobId);
    }

    // ============================================================
    //  JOB BOARD FEE HOLDING
    // ============================================================

    function testMintJob_FeeHeldNotForwarded() public {
        uint256 amount = 200_000_000;      // $200
        uint256 fee = 10_000_000;          // 5%

        vm.startPrank(client);
        usdc.approve(address(diamond), amount + fee);
        JobBoardFacet(address(diamond)).mintJob(
            "Build a dApp", "Need a Solidity dev", amount, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();

        // Комиссия ещё НЕ у получателя — сделки нет
        assertEq(usdc.balanceOf(feeRecipient), 0);
        assertEq(usdc.balanceOf(address(diamond)), amount + fee);
    }

    function testAcceptApplicant_ForwardsHeldFee() public {
        uint256 amount = 200_000_000;
        uint256 fee = 10_000_000;

        vm.startPrank(client);
        usdc.approve(address(diamond), amount + fee);
        uint256 jobId = JobBoardFacet(address(diamond)).mintJob(
            "Build a dApp", "Need a Solidity dev", amount, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();

        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);
        vm.prank(client);
        JobBoardFacet(address(diamond)).acceptApplicant(jobId, executor);

        assertEq(usdc.balanceOf(feeRecipient), fee);
        assertEq(usdc.balanceOf(address(diamond)), 0);
    }

    function testCancelJob_RefundsFeeAboveFloor() public {
        uint256 amount = 200_000_000;      // $200
        uint256 fee = 10_000_000;          // 5%
        uint256 floor_ = 1_000_000;        // $1
        uint256 before = usdc.balanceOf(client);

        vm.startPrank(client);
        usdc.approve(address(diamond), amount + fee);
        uint256 jobId = JobBoardFacet(address(diamond)).mintJob(
            "Build a dApp", "Need a Solidity dev", amount, DEADLINE, TERMS, REGION
        );
        JobBoardFacet(address(diamond)).cancelJob(jobId);
        vm.stopPrank();

        // Клиент потерял ровно пол, всё остальное вернулось
        assertEq(usdc.balanceOf(client), before - floor_);
        assertEq(usdc.balanceOf(feeRecipient), floor_);
        assertEq(usdc.balanceOf(address(diamond)), 0);
    }

    function testCancelJob_SmallDealBurnsWholeFee() public {
        uint256 amount = 20_000_000;       // $20 — комиссия равна полу
        uint256 fee = 1_000_000;
        uint256 before = usdc.balanceOf(client);

        vm.startPrank(client);
        usdc.approve(address(diamond), amount + fee);
        uint256 jobId = JobBoardFacet(address(diamond)).mintJob(
            "Small task", "Tiny", amount, DEADLINE, TERMS, REGION
        );
        JobBoardFacet(address(diamond)).cancelJob(jobId);
        vm.stopPrank();

        assertEq(usdc.balanceOf(client), before - fee);
        assertEq(usdc.balanceOf(feeRecipient), fee);
    }

    function testCancelJob_EmitsActualReturnedAmount() public {
        uint256 amount = 200_000_000;      // $200
        uint256 fee = 10_000_000;          // 5%
        uint256 floor_ = 1_000_000;        // $1

        vm.startPrank(client);
        usdc.approve(address(diamond), amount + fee);
        uint256 jobId = JobBoardFacet(address(diamond)).mintJob(
            "Build a dApp", "Need a Solidity dev", amount, DEADLINE, TERMS, REGION
        );

        // JobCancelled обязано нести реально вернувшуюся клиенту сумму
        // (amount + комиссия сверх пола), а не только сумму заказа — фронт
        // печатает это поле дословно в уведомлении.
        vm.expectEmit(true, true, false, true, address(diamond));
        emit JobBoardFacet.JobCancelled(jobId, client, amount + (fee - floor_));
        JobBoardFacet(address(diamond)).cancelJob(jobId);
        vm.stopPrank();
    }

    function testCancelJob_FloorRaisedAfterMint_BurnsOnlyWhatWasHeld() public {
        uint256 amount = 20_000_000;       // $20 — held fee = $1 (floor at mint time)
        uint256 heldFee = 1_000_000;
        uint256 before = usdc.balanceOf(client);

        vm.startPrank(client);
        usdc.approve(address(diamond), amount + heldFee);
        uint256 jobId = JobBoardFacet(address(diamond)).mintJob(
            "Small task", "Tiny", amount, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();

        // Владелец поднимает пол ПОСЛЕ минта — выше уже удержанной комиссии.
        // Тот же случай на живом хранилище: заказы, созданные до апгрейда,
        // у которых feeFloor на момент минта был другим (или нулевым).
        FactoryFacet(address(diamond)).setFeeFloor(2_000_000);

        vm.prank(client);
        JobBoardFacet(address(diamond)).cancelJob(jobId);

        // Пол (2_000_000) теперь больше удержанной комиссии (1_000_000) —
        // сгорает ровно то, что было удержано, клиенту сверх суммы заказа
        // ничего не возвращается, и вычитание не underflow'ит.
        assertEq(usdc.balanceOf(client), before - heldFee);
        assertEq(usdc.balanceOf(feeRecipient), heldFee);
        assertEq(usdc.balanceOf(address(diamond)), 0);
    }

    // ============================================================
    //  JOB RECEIPT NFT TESTS
    // ============================================================

    function testJobReceiptMintedOnJobPost() public {
        assertEq(JobReceiptFacet(address(diamond)).getReceiptTotalSupply(), 0);

        _approveAndMintJob();

        assertEq(JobReceiptFacet(address(diamond)).getReceiptTotalSupply(), 1);
        assertEq(JobReceiptFacet(address(diamond)).balanceOf(client), 1);
        assertEq(JobReceiptFacet(address(diamond)).ownerOf(0), client);
        assertTrue(JobReceiptFacet(address(diamond)).isJobReceiptToken(0));
    }

    function testJobReceiptData() public {
        _approveAndMintJob();

        ReceiptStorage.JobReceiptData memory data = JobReceiptFacet(address(diamond)).getJobReceiptData(0);
        assertEq(data.client, client);
        assertEq(data.amount, AMOUNT);
        assertEq(data.deadlineDays, DEADLINE);
        assertEq(data.region, REGION);
        assertEq(data.title, "Build a dApp");
    }

    function testJobReceiptSoulbound() public {
        _approveAndMintJob();

        vm.prank(client);
        vm.expectRevert();
        JobReceiptFacet(address(diamond)).transferFrom(client, address(0x5), 0);
    }

    function testJobReceiptDirectMintReverts() public {
        vm.expectRevert("Only Diamond");
        JobReceiptFacet(address(diamond)).mintJobReceipt(client, 0, AMOUNT, DEADLINE, REGION, "title");
    }

    function testJobReceiptIdempotent() public {
        // Two jobs — each gets its own receipt
        _approveAndMintJob();

        vm.startPrank(client);
        usdc.approve(address(diamond), type(uint256).max);
        JobBoardFacet(address(diamond)).mintJob(
            "Second Job",
            "Another task",
            AMOUNT,
            DEADLINE,
            TERMS,
            REGION
        );
        vm.stopPrank();

        assertEq(JobReceiptFacet(address(diamond)).getReceiptTotalSupply(), 2);
        assertEq(JobReceiptFacet(address(diamond)).balanceOf(client), 2);
    }

    function testJobReceiptNotReceiptToken() public view {
        assertFalse(JobReceiptFacet(address(diamond)).isJobReceiptToken(99));
    }

    function testJobReceiptSetSvgRenderer() public {
        address renderer = address(0xABC);
        JobReceiptFacet(address(diamond)).setSvgRenderer(renderer);
        assertEq(JobReceiptFacet(address(diamond)).getSvgRenderer(), renderer);
    }

    function testJobReceiptTokenURIRevertsWithoutRenderer() public {
        _approveAndMintJob();
        // Без SVGRenderer tokenURI ревертит
        vm.expectRevert("SVGRenderer not set");
        JobReceiptFacet(address(diamond)).tokenURI(0);
    }

    function testCancelJobBurnsReceipt() public {
        uint256 jobId = _approveAndMintJob();

        // Receipt смминтилась при создании заказа
        assertEq(JobReceiptFacet(address(diamond)).ownerOf(0), client);
        assertFalse(JobReceiptFacet(address(diamond)).isJobReceiptBurned(0));

        (uint256 tokenId, bool exists) = JobReceiptFacet(address(diamond)).getTokenIdByJobId(jobId);
        assertEq(tokenId, 0);
        assertTrue(exists);

        // Отменяем заказ
        vm.prank(client);
        JobBoardFacet(address(diamond)).cancelJob(jobId);

        // Receipt должна быть сожжена
        assertTrue(JobReceiptFacet(address(diamond)).isJobReceiptBurned(0));
        assertEq(JobReceiptFacet(address(diamond)).balanceOf(client), 0);

        // ownerOf ревертит для сожжённого токена
        vm.expectRevert("ERC721: nonexistent token");
        JobReceiptFacet(address(diamond)).ownerOf(0);

        // getJobReceiptData всё ещё работает — данные сохранены для истории
        ReceiptStorage.JobReceiptData memory data = JobReceiptFacet(address(diamond)).getJobReceiptData(0);
        assertEq(data.client, client);
        assertEq(data.amount, AMOUNT);
    }

    function testBurnJobReceiptDirectReverts() public {
        _approveAndMintJob();

        vm.prank(address(0x99));
        vm.expectRevert("Only Diamond");
        JobReceiptFacet(address(diamond)).burnJobReceipt(0);
    }

    function testGetTokenIdByJobIdBeforeMint() public view {
        (, bool exists) = JobReceiptFacet(address(diamond)).getTokenIdByJobId(99);
        assertFalse(exists);
    }

    function testJobReceiptFacetSupportsInterface() public view {
        // В этом харнессе JobReceiptFacet реально подключён (в отличие от
        // test/Diamond.t.sol) — поэтому здесь ERC-721/ERC721Metadata
        // проверяются не только по маппингу, но и по факту рабочего фасета.
        assertTrue(DiamondLoupeFacet(address(diamond)).supportsInterface(type(IERC165).interfaceId));
        assertTrue(DiamondLoupeFacet(address(diamond)).supportsInterface(type(IDiamondCut).interfaceId));
        assertTrue(DiamondLoupeFacet(address(diamond)).supportsInterface(type(IDiamondLoupe).interfaceId));
        assertTrue(DiamondLoupeFacet(address(diamond)).supportsInterface(0x80ac58cd), "ERC721");
        assertTrue(DiamondLoupeFacet(address(diamond)).supportsInterface(0x5b5e139f), "ERC721Metadata");
        // Неизвестный интерфейс — false
        assertFalse(DiamondLoupeFacet(address(diamond)).supportsInterface(0xdeadbeef));

        // Не просто заявляет ERC-721 — реально отвечает на его вызовы
        assertEq(JobReceiptFacet(address(diamond)).balanceOf(client), 0);
        assertEq(JobReceiptFacet(address(diamond)).name(), "Hexseal Receipt");
        assertEq(JobReceiptFacet(address(diamond)).symbol(), "HSEALR");
    }

    // ============================================================
    //  JOB BOARD EDIT + WITHDRAW TESTS
    // ============================================================

    function testWithdrawApplication() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);

        assertEq(JobBoardFacet(address(diamond)).getApplicants(jobId).length, 1);

        vm.prank(executor);
        JobBoardFacet(address(diamond)).withdrawApplication(jobId);

        assertEq(JobBoardFacet(address(diamond)).getApplicants(jobId).length, 0);
    }

    function testWithdrawApplicationRevertIfNotApplied() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        vm.expectRevert(JobBoardFacet.NotApplicant.selector);
        JobBoardFacet(address(diamond)).withdrawApplication(jobId);
    }

    function testWithdrawApplicationRevertIfJobClosed() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);

        vm.prank(client);
        JobBoardFacet(address(diamond)).cancelJob(jobId);

        vm.prank(executor);
        vm.expectRevert(JobBoardFacet.JobNotOpen.selector);
        JobBoardFacet(address(diamond)).withdrawApplication(jobId);
    }

    function testEditJob() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(client);
        JobBoardFacet(address(diamond)).editJob(
            jobId,
            "Updated Title",
            "Updated description",
            14,
            TERMS,
            REGION
        );

        JobBoardStorage.Job memory job = JobBoardFacet(address(diamond)).getJob(jobId);
        assertEq(job.title, "Updated Title");
        assertEq(job.deadlineDays, 14);
    }

    function testEditJobRevertIfNotClient() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        vm.expectRevert(JobBoardFacet.NotClient.selector);
        JobBoardFacet(address(diamond)).editJob(jobId, "X", "X", 14, TERMS, REGION);
    }

    function testEditJobRevertIfHasApplicants() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);

        vm.prank(client);
        vm.expectRevert(JobBoardFacet.JobHasApplicants.selector);
        JobBoardFacet(address(diamond)).editJob(jobId, "X", "X", 14, TERMS, REGION);
    }

    function testTotalJobsAndGetOpenJobs() public {
        assertEq(JobBoardFacet(address(diamond)).totalJobs(), 0);

        _approveAndMintJob();
        assertEq(JobBoardFacet(address(diamond)).totalJobs(), 1);

        (uint256[] memory ids, JobBoardStorage.Job[] memory jobs) =
            JobBoardFacet(address(diamond)).getOpenJobs();
        assertEq(ids.length, 1);
        assertEq(jobs[0].client, client);
    }

    function testGetClientJobs() public {
        _approveAndMintJob();

        uint256[] memory clientJobs = JobBoardFacet(address(diamond)).getClientJobs(client);
        assertEq(clientJobs.length, 1);
        assertEq(clientJobs[0], 0);
    }

    // ============================================================
    //  FEE FORMULA
    // ============================================================

    function testQuoteFee_PercentageAboveFloor() public view {
        // 5% от $200 = $10, пол не срабатывает
        assertEq(FactoryFacet(address(diamond)).quoteFee(200_000_000), 10_000_000);
    }

    function testQuoteFee_FloorBelowCrossover() public view {
        // 5% от $5 = $0.25, пол $1 срабатывает
        assertEq(FactoryFacet(address(diamond)).quoteFee(5_000_000), 1_000_000);
    }

    function testQuoteFee_ExactCrossover() public view {
        // $20 — ровно стык: 5% = $1 = пол
        assertEq(FactoryFacet(address(diamond)).quoteFee(20_000_000), 1_000_000);
    }

    function testQuoteFee_LargeDeal() public view {
        // 5% от $1000 = $50
        assertEq(FactoryFacet(address(diamond)).quoteFee(1_000_000_000), 50_000_000);
    }

    function testQuoteFee_ZeroAmountReturnsFloor() public view {
        // amount=0 -> 5% от 0 = 0, пол $1 срабатывает. На практике недостижимо
        // (выше по стеку ZeroAmount гейтит нулевую сумму раньше), но поведение
        // формулы закреплено явно — чтобы будущий рефакторинг не перевернул
        // его молча.
        assertEq(FactoryFacet(address(diamond)).quoteFee(0), 1_000_000);
    }

    function testSetFeeBps_OnlyOwner() public {
        vm.prank(client);
        vm.expectRevert(FactoryFacet.NotOwner.selector);
        FactoryFacet(address(diamond)).setFeeBps(300);
    }

    function testSetFeeBps_ChangesQuote() public {
        FactoryFacet(address(diamond)).setFeeBps(300); // 3%
        assertEq(FactoryFacet(address(diamond)).quoteFee(1_000_000_000), 30_000_000);
    }

    function testSetFeeBps_RevertsAboveCap() public {
        vm.expectRevert(FactoryFacet.FeeBpsTooHigh.selector);
        FactoryFacet(address(diamond)).setFeeBps(2_001);
    }

    function testSetFeeBps_AllowsExactCap() public {
        FactoryFacet(address(diamond)).setFeeBps(2_000); // ровно 20% — потолок, не должен ревертить
        assertEq(FactoryFacet(address(diamond)).quoteFee(100_000_000), 20_000_000);
    }

    function testSetFeeFloor_OnlyOwner() public {
        vm.prank(client);
        vm.expectRevert(FactoryFacet.NotOwner.selector);
        FactoryFacet(address(diamond)).setFeeFloor(2_000_000);
    }

    function testSetFeeFloor_RevertsOnZero() public {
        vm.expectRevert(FeeNotConfigured.selector);
        FactoryFacet(address(diamond)).setFeeFloor(0);
    }

    function testSetFeeFloor_ChangesQuote() public {
        FactoryFacet(address(diamond)).setFeeFloor(2_000_000); // пол $2
        // 5% от $5 = $0.25, ниже нового пола $2 — пол побеждает
        assertEq(FactoryFacet(address(diamond)).quoteFee(5_000_000), 2_000_000);
    }

    function testGetMaxPendingRequests_DefaultIsFive() public view {
        assertEq(FactoryFacet(address(diamond)).getMaxPendingRequests(), 5);
    }

    function testSetMaxPendingRequests_OnlyOwner() public {
        vm.prank(client);
        vm.expectRevert(FactoryFacet.NotOwner.selector);
        FactoryFacet(address(diamond)).setMaxPendingRequests(3);
    }

    function testSetMaxPendingRequests_ZeroAllowed() public {
        // 0 = без ограничения — сеттер обязан пропускать ноль, не ревертить
        FactoryFacet(address(diamond)).setMaxPendingRequests(0);
        assertEq(FactoryFacet(address(diamond)).getMaxPendingRequests(), 0);
    }

    function testGetRegionFee_NowReverts() public {
        vm.expectRevert(FeeNotRegional.selector);
        FactoryFacet(address(diamond)).getRegionFee(0);
    }

    function testGetAllFees_NowReverts() public {
        vm.expectRevert(FeeNotRegional.selector);
        FactoryFacet(address(diamond)).getAllFees();
    }

    function testSetRegionFee_NowReverts() public {
        // Симметрично геттерам: рабочая запись рядом с ревертящим чтением
        // означала бы, что админка «выставляет» комиссии, которые ничего не
        // делают. Ревертит для владельца — то есть для всех.
        vm.expectRevert(FeeNotRegional.selector);
        FactoryFacet(address(diamond)).setRegionFee(0, 5_000_000);
    }

    function testSetRegionFee_RevertsForNonOwnerToo() public {
        vm.prank(client);
        vm.expectRevert(FeeNotRegional.selector);
        FactoryFacet(address(diamond)).setRegionFee(0, 5_000_000);
    }

    function testDeployAgreement_ChargesPercentage() public {
        uint256 amount = 200_000_000;      // $200
        uint256 expectedFee = 10_000_000;  // 5%

        vm.startPrank(client);
        usdc.approve(address(diamond), expectedFee);
        FactoryFacet(address(diamond)).deployAgreement(
            client, executor, address(0), amount, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();

        assertEq(usdc.balanceOf(feeRecipient), expectedFee);
    }

    // ============================================================
    //  FEE LEDGER READ PATH
    // ============================================================

    function testGetJobFeeHeld_ReportsWhatIsHeld() public {
        uint256 jobId = _approveAndMintJob();
        assertEq(JobBoardFacet(address(diamond)).getJobFeeHeld(jobId), JOB_FEE);
    }

    function testGetJobFeeHeld_ZeroBeforeAndAfterAccept() public {
        assertEq(JobBoardFacet(address(diamond)).getJobFeeHeld(0), 0);

        uint256 jobId = _approveAndMintJob();
        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);
        vm.prank(client);
        JobBoardFacet(address(diamond)).acceptApplicant(jobId, executor);

        assertEq(JobBoardFacet(address(diamond)).getJobFeeHeld(jobId), 0);
    }

    function testGetJobFeeHeld_ClearedOnCancel() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(client);
        JobBoardFacet(address(diamond)).cancelJob(jobId);

        assertEq(JobBoardFacet(address(diamond)).getJobFeeHeld(jobId), 0);
    }

    // ============================================================
    //  FEE COLLECTED EVENT
    // ============================================================

    function testAcceptApplicant_EmitsFeeCollected() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);

        // _assertLedgerBalanced proves both that the right event fired AND
        // that nothing else moved into feeRecipient unannounced during this
        // call — vm.expectEmit alone only proves the former.
        (, Vm.Log[] memory logs) = _assertLedgerBalanced(
            client,
            abi.encodeWithSelector(JobBoardFacet.acceptApplicant.selector, jobId, executor)
        );
        _assertFeeCollected(logs, jobId, client, FEE_KIND_JOB_DEAL, JOB_FEE);
    }

    /// Пол, оставшийся протоколу при отмене, — экономически другое событие,
    /// чем комиссия с состоявшейся сделки (тест выше): forfeit, не deal.
    /// kind обязан их различать, иначе индексатор не сможет отделить одно от
    /// другого по логу.
    function testCancelJob_EmitsFeeCollected() public {
        uint256 jobId = _approveAndMintJob();

        (, Vm.Log[] memory logs) = _assertLedgerBalanced(
            client,
            abi.encodeWithSelector(JobBoardFacet.cancelJob.selector, jobId)
        );
        _assertFeeCollected(logs, jobId, client, FEE_KIND_JOB_FORFEIT, JOB_FLOOR);
    }

    /// Прямой найм в обход обеих досок: FactoryFacet.deployAgreement() сама
    /// списывает комиссию, когда msg.sender == client. Естественного id нет —
    /// Agreement на момент перевода ещё не задеплоен — поэтому id = 0, а
    /// сделка опознаётся по AgreementDeployed той же транзакции.
    function testDeployAgreement_EmitsFeeCollected() public {
        uint256 amount = 200_000_000;      // $200
        uint256 expectedFee = 10_000_000;  // 5%

        vm.prank(client);
        usdc.approve(address(diamond), expectedFee);

        (, Vm.Log[] memory logs) = _assertLedgerBalanced(
            client,
            abi.encodeWithSelector(
                FactoryFacet.deployAgreement.selector,
                client, executor, address(0), amount, DEADLINE, TERMS, REGION
            )
        );
        _assertFeeCollected(logs, 0, client, FEE_KIND_DIRECT_DEAL, expectedFee);
    }

    /// Тот же прямой путь, но deployAndFund() ещё и переводит amount в
    /// Agreement в той же транзакции — комиссия и здесь DIRECT_DEAL, id = 0.
    function testDeployAndFund_EmitsFeeCollected() public {
        uint256 amount = 200_000_000;      // $200
        uint256 expectedFee = 10_000_000;  // 5%

        vm.prank(client);
        usdc.approve(address(diamond), amount + expectedFee);

        (, Vm.Log[] memory logs) = _assertLedgerBalanced(
            client,
            abi.encodeWithSelector(
                FactoryFacet.deployAndFund.selector,
                client, executor, amount, DEADLINE, TERMS, REGION
            )
        );
        _assertFeeCollected(logs, 0, client, FEE_KIND_DIRECT_DEAL, expectedFee);
    }

    /// AgreementDeployed.fee считается заново на момент найма, а переводится
    /// удержанное при постинге. Сигнатура события заморожена ради сабграфа, так
    /// что расхождение никуда не денется — этот тест ФИКСИРУЕТ его исполняемо
    /// (и потому проходит), чтобы индексатор не читался как источник правды о
    /// заработанной комиссии.
    function testAcceptApplicant_AgreementDeployedFeeDivergesFromWhatWasCollected() public {
        uint256 jobId = _approveAndMintJob();   // удержано 5% от $100 = $5

        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);

        // Ставка меняется между постингом и наймом.
        FactoryFacet(address(diamond)).setFeeBps(1_000); // 10%

        vm.recordLogs();
        vm.prank(client);
        JobBoardFacet(address(diamond)).acceptApplicant(jobId, executor);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 announced;  // AgreementDeployed.fee — пересчитан на момент найма
        uint256 collected;  // FeeCollected.amount   — реально переведено
        bool sawAnnounced;
        bool sawCollected;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == FactoryFacet.AgreementDeployed.selector) {
                (, , announced) = abi.decode(logs[i].data, (uint256, uint8, uint256));
                sawAnnounced = true;
            } else if (logs[i].topics[0] == JobBoardFacet.FeeCollected.selector) {
                collected = abi.decode(logs[i].data, (uint256));
                sawCollected = true;
            }
        }
        assertTrue(sawAnnounced, "AgreementDeployed not emitted");
        assertTrue(sawCollected, "FeeCollected not emitted");

        assertEq(collected, JOB_FEE);         // $5 — удержано при постинге
        assertEq(announced, 10_000_000);      // $10 — 10% на момент найма
        assertTrue(announced != collected, "AgreementDeployed.fee must be read as a quote, not a receipt");

        // Проверка не на слово: в казну ушло ровно collected, не announced.
        assertEq(usdc.balanceOf(feeRecipient), JOB_FEE);
    }

    // ============================================================
    //  LEGACY JOBS (posted before the fee-holding upgrade)
    // ============================================================

    /// На живом диамонде лежит OPEN-заказ, созданный старым кодом: jobFunds
    /// заполнен, jobFeeHeld — нулевой (поля тогда не существовало), а комиссия
    /// ушла в казну ещё при постинге. Симметрично
    /// testLegacyPendingRequestDoesNotUnderflowOnResolve в ServiceBoard.t.sol.
    /// Приём и отмена такого заказа обязаны отрабатывать без реверта.
    function _makeLegacyJob() internal returns (uint256 jobId) {
        jobId = _approveAndMintJob();

        // jobFeeHeld — поле с индексом 7 в JobBoardStorage.Layout: nextJobId(0),
        // jobs(1), clientJobs(2), applicants(3), hasApplied(4),
        // _deprecated_receiptNFT(5), jobFunds(6), jobFeeHeld(7).
        bytes32 mappingSlot = bytes32(uint256(JobBoardStorage.POSITION) + 7);
        bytes32 feeSlot = keccak256(abi.encode(jobId, mappingSlot));

        // Sanity: mintJob только что записал сюда удержанную комиссию.
        assertEq(uint256(vm.load(address(diamond), feeSlot)), JOB_FEE);

        vm.store(address(diamond), feeSlot, bytes32(uint256(0)));

        // Старый код пересылал комиссию в казну прямо при постинге, поэтому в
        // диамонде этих денег нет. Двигаем и токены, а не только леджер — иначе
        // «легаси»-состояние было бы наполовину выдуманным.
        vm.prank(address(diamond));
        usdc.transfer(feeRecipient, JOB_FEE);
    }

    function testLegacyJobWithNoHeldFeeCanBeAccepted() public {
        uint256 jobId = _makeLegacyJob();

        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);

        vm.prank(client);
        address agreementAddr = JobBoardFacet(address(diamond)).acceptApplicant(jobId, executor);

        assertTrue(agreementAddr != address(0));
        assertEq(usdc.balanceOf(agreementAddr), AMOUNT);
        // Комиссия уже была уплачена при постинге — второй раз не берётся.
        assertEq(usdc.balanceOf(feeRecipient), JOB_FEE);
        assertEq(usdc.balanceOf(address(diamond)), 0);
    }

    function testLegacyJobWithNoHeldFeeCanBeCancelled() public {
        uint256 jobId = _makeLegacyJob();
        uint256 clientBefore = usdc.balanceOf(client);

        vm.prank(client);
        JobBoardFacet(address(diamond)).cancelJob(jobId);

        // Сгорать нечему — удержано было ноль, вычитание пола не underflow'ит.
        assertEq(usdc.balanceOf(client), clientBefore + AMOUNT);
        assertEq(usdc.balanceOf(feeRecipient), JOB_FEE);
        assertEq(usdc.balanceOf(address(diamond)), 0);

        JobBoardStorage.Job memory job = JobBoardFacet(address(diamond)).getJob(jobId);
        assertEq(uint256(job.status), uint256(JobBoardStorage.JobStatus.CANCELLED));
    }

    // ============================================================
    //  UPGRADE WINDOW: diamondCut landed, config transaction has not
    // ============================================================

    /// Спека требует засевать feeBps/feeFloor ТОЙ ЖЕ транзакцией, что и
    /// diamondCut. Единственный доступный механизм — `_init`/`_calldata`:
    /// DiamondCutLib.initializeDiamondCut() делает `_init.delegatecall(_calldata)`
    /// уже находясь в контексте диамонда, поэтому
    ///   _init      = адрес ИМПЛЕМЕНТАЦИИ фасета (не диамонда),
    ///   хранилище  = диамондовское (delegatecall),
    ///   msg.sender = владелец, вызвавший diamondCut (delegatecall его сохраняет),
    /// а значит onlyOwner внутри initFeeModel — настоящий гейт.
    ///
    /// Адрес самого диамонда в `_init` тоже сработал бы (лишний хоп через его
    /// fallback), но адрес имплементации не зависит от того, смонтирован ли уже
    /// селектор — поэтому в апгрейд-скрипт пойдёт именно он.
    function testInitFeeModel_SeedsConfigInTheSameTransactionAsTheCut() public {
        (DiamondProxy fresh, address factoryImpl) = _deployUnconfiguredDiamond();

        // Окно до засева: брать комиссию не с чего.
        vm.expectRevert(FeeNotConfigured.selector);
        FactoryFacet(address(fresh)).quoteFee(AMOUNT);

        bytes4[] memory added = new bytes4[](1);
        added[0] = FactoryFacet.initFeeModel.selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut(factoryImpl, IDiamondCut.FacetCutAction.Add, added);

        IDiamondCut(address(fresh)).diamondCut(
            cuts,
            factoryImpl,
            abi.encodeCall(FactoryFacet.initFeeModel, (500, 1_000_000, 5))
        );

        // Одна транзакция — и конфиг на месте.
        assertEq(FactoryFacet(address(fresh)).getFeeBps(), 500);
        assertEq(FactoryFacet(address(fresh)).getFeeFloor(), 1_000_000);
        assertEq(FactoryFacet(address(fresh)).getMaxPendingRequests(), 5);
        assertEq(FactoryFacet(address(fresh)).quoteFee(AMOUNT), JOB_FEE);

        // И сделка создаётся — второй транзакции не потребовалось.
        vm.startPrank(client);
        usdc.approve(address(fresh), type(uint256).max);
        uint256 jobId = JobBoardFacet(address(fresh)).mintJob(
            "Build a dApp", "Need a Solidity dev", AMOUNT, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();
        assertEq(JobBoardFacet(address(fresh)).getJobFeeHeld(jobId), JOB_FEE);
    }

    function testInitFeeModel_RevertsOnAnAlreadyConfiguredDiamond() public {
        (DiamondProxy fresh, address factoryImpl) = _deployUnconfiguredDiamond();

        bytes4[] memory added = new bytes4[](1);
        added[0] = FactoryFacet.initFeeModel.selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut(factoryImpl, IDiamondCut.FacetCutAction.Add, added);

        IDiamondCut(address(fresh)).diamondCut(
            cuts,
            factoryImpl,
            abi.encodeCall(FactoryFacet.initFeeModel, (500, 1_000_000, 5))
        );

        // Второй прогон по тому же диамонду — уже настроен.
        vm.expectRevert(FactoryFacet.AlreadyInitialized.selector);
        FactoryFacet(address(fresh)).initFeeModel(300, 2_000_000, 3);
    }

    function testInitFeeModel_RejectsZeroFloorAndTooHighBps() public {
        (DiamondProxy fresh, address factoryImpl) = _deployUnconfiguredDiamond();

        bytes4[] memory added = new bytes4[](1);
        added[0] = FactoryFacet.initFeeModel.selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut(factoryImpl, IDiamondCut.FacetCutAction.Add, added);
        IDiamondCut(address(fresh)).diamondCut(cuts, address(0), "");

        // Одноразовый путь не слабее обычных сеттеров.
        vm.expectRevert(FeeNotConfigured.selector);
        FactoryFacet(address(fresh)).initFeeModel(500, 0, 5);

        vm.expectRevert(FactoryFacet.FeeBpsTooHigh.selector);
        FactoryFacet(address(fresh)).initFeeModel(2_001, 1_000_000, 5);

        // Ноль отвергается тоже: иначе одна опечатка атомарно возвращает
        // протокол к плоской комиссии, и правится это только новым cut'ом.
        vm.expectRevert(FactoryFacet.FeeBpsTooHigh.selector);
        FactoryFacet(address(fresh)).initFeeModel(0, 1_000_000, 5);

        vm.prank(client);
        vm.expectRevert(FactoryFacet.NotOwner.selector);
        FactoryFacet(address(fresh)).initFeeModel(500, 1_000_000, 5);
    }

    function testInitFeeModel_ZeroBpsCannotSlipThroughAndFlattenTheFee() public {
        (DiamondProxy fresh, address factoryImpl) = _deployUnconfiguredDiamond();

        bytes4[] memory added = new bytes4[](1);
        added[0] = FactoryFacet.initFeeModel.selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut(factoryImpl, IDiamondCut.FacetCutAction.Add, added);

        // Нулевая ставка не проходит даже атомарным путём — cut целиком ревертит,
        // а не оставляет диамонд с тихой плоской комиссией.
        vm.expectRevert(FactoryFacet.FeeBpsTooHigh.selector);
        IDiamondCut(address(fresh)).diamondCut(
            cuts,
            factoryImpl,
            abi.encodeCall(FactoryFacet.initFeeModel, (0, 1_000_000, 5))
        );
    }

    // ── Все денежные входы неконфигурированного диамонда ревертят ──────────

    function testUnconfigured_MintJobReverts() public {
        (DiamondProxy fresh, ) = _deployUnconfiguredDiamond();

        vm.startPrank(client);
        usdc.approve(address(fresh), type(uint256).max);
        vm.expectRevert(FeeNotConfigured.selector);
        JobBoardFacet(address(fresh)).mintJob(
            "Build a dApp", "Need a Solidity dev", AMOUNT, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();
    }

    function testUnconfigured_MintJobWithPermitReverts() public {
        (DiamondProxy fresh, ) = _deployUnconfiguredDiamond();

        // quote() стоит ДО permit(), поэтому путь падает на комиссии, а не на
        // подписи — что и требуется проверить.
        vm.expectRevert(FeeNotConfigured.selector);
        JobBoardFacet(address(fresh)).mintJobWithPermit(
            client, "Build a dApp", "Need a Solidity dev", AMOUNT, DEADLINE, TERMS, REGION,
            block.timestamp + 1 days, 0, bytes32(0), bytes32(0)
        );
    }

    function testUnconfigured_DeployAgreementReverts() public {
        (DiamondProxy fresh, ) = _deployUnconfiguredDiamond();

        vm.startPrank(client);
        usdc.approve(address(fresh), type(uint256).max);
        vm.expectRevert(FeeNotConfigured.selector);
        FactoryFacet(address(fresh)).deployAgreement(
            client, executor, address(0), AMOUNT, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();
    }

    function testUnconfigured_DeployAndFundReverts() public {
        (DiamondProxy fresh, ) = _deployUnconfiguredDiamond();

        vm.startPrank(client);
        usdc.approve(address(fresh), type(uint256).max);
        vm.expectRevert(FeeNotConfigured.selector);
        FactoryFacet(address(fresh)).deployAndFund(
            client, executor, AMOUNT, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();
    }

    function testUnconfigured_QuoteFeeReverts() public {
        (DiamondProxy fresh, ) = _deployUnconfiguredDiamond();

        vm.expectRevert(FeeNotConfigured.selector);
        FactoryFacet(address(fresh)).quoteFee(AMOUNT);
    }

    /// Деньги обязаны выходить даже из неконфигурированного протокола: заказ
    /// опубликован ДО cut'а, окно засева ещё не закрыто, клиент отменяет.
    function testUnconfigured_CancelJobStillReturnsEverything() public {
        (DiamondProxy fresh, ) = _deployBoardsDiamond();

        vm.startPrank(client);
        usdc.approve(address(fresh), type(uint256).max);
        uint256 jobId = JobBoardFacet(address(fresh)).mintJob(
            "Build a dApp", "Need a Solidity dev", AMOUNT, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();

        uint256 clientBefore = usdc.balanceOf(client);
        uint256 feeBefore = usdc.balanceOf(feeRecipient);

        _unconfigureFeeModel(address(fresh));

        vm.prank(client);
        JobBoardFacet(address(fresh)).cancelJob(jobId);

        // Пола нет — сгорать нечему, возвращается всё: и сумма, и комиссия.
        assertEq(usdc.balanceOf(client), clientBefore + AMOUNT + JOB_FEE);
        assertEq(usdc.balanceOf(feeRecipient), feeBefore);
        assertEq(usdc.balanceOf(address(fresh)), 0);
    }

    // ============================================================
    //  RECEIPT SVG RENDER
    // ============================================================

    function testRenderReceipt_StillRenders() public {
        SVGRenderer renderer = new SVGRenderer();

        string memory uri = renderer.renderReceipt(ISVGRenderer.ReceiptParams({
            tokenId:      1,
            client:       client,
            title:        "Build a dApp",
            amount:       200_000_000,
            deadlineDays: DEADLINE,
            region:       REGION,
            createdAt:    block.timestamp
        }));

        assertGt(bytes(uri).length, 100);

        // Префикс data-URI на месте — рендер не выродился в пустую строку
        bytes memory prefix = bytes("data:application/json;base64,");
        bytes memory uriBytes = bytes(uri);
        for (uint256 i = 0; i < prefix.length; i++) {
            assertEq(uriBytes[i], prefix[i]);
        }
    }
}
