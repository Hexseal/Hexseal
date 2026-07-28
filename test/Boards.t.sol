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
