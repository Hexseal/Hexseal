// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./BoardsFixture.sol";

// ---------- TEST ----------

contract ServiceBoardTest is BoardsFixture {
    // ============================================================
    //  SERVICE BOARD TESTS
    // ============================================================

    function _mintService() internal returns (uint256 serviceId) {
        vm.startPrank(executor);
        usdc.approve(address(diamond), FEE);
        serviceId = ServiceBoardFacet(address(diamond)).mintService(
            "Smart Contract Dev",
            "I write secure Solidity",
            AMOUNT, // рекомендованная цена
            DEADLINE,
            REGION
        );
        vm.stopPrank();
    }

    function testMintService() public {
        // Публикация услуги теперь стоит плоский антиспам-пол (fs.feeFloor),
        // а не региональную комиссию — суммы сделки при постинге ещё нет.
        uint256 floor_ = 1_000_000; // $1
        uint256 executorBefore = usdc.balanceOf(executor);
        uint256 feeBefore = usdc.balanceOf(feeRecipient);

        uint256 serviceId = _mintService();

        assertEq(serviceId, 0);

        ServiceBoardStorage.Service memory svc = ServiceBoardFacet(address(diamond)).getService(serviceId);
        assertEq(svc.executor, executor);
        assertEq(svc.price, AMOUNT);
        assertEq(uint256(svc.status), uint256(ServiceBoardStorage.ServiceStatus.ACTIVE));
        assertEq(svc.hiresCount, 0);

        // Fee сгорела, amount НЕ заблокирован
        assertEq(usdc.balanceOf(executor), executorBefore - floor_);
        assertEq(usdc.balanceOf(feeRecipient), feeBefore + floor_);
        assertEq(usdc.balanceOf(address(diamond)), 0); // Diamond ничего не держит
    }

    function testMintService_ChargesFlatFloor() public {
        uint256 floor_ = 1_000_000; // $1
        uint256 before = usdc.balanceOf(executor);

        vm.startPrank(executor);
        usdc.approve(address(diamond), floor_);
        ServiceBoardFacet(address(diamond)).mintService(
            "Solidity audit", "I audit contracts", 500_000_000, DEADLINE, REGION
        );
        vm.stopPrank();

        assertEq(usdc.balanceOf(executor), before - floor_);
        assertEq(usdc.balanceOf(feeRecipient), floor_);
    }

    function _requestService(uint256 serviceId) internal returns (uint256 requestId) {
        vm.startPrank(client);
        // requestService теперь берёт процент через quote() — численно совпадает
        // с JOB_FEE для того же AMOUNT (5% от $100 = $5, выше пола).
        usdc.approve(address(diamond), AMOUNT + JOB_FEE);
        requestId = ServiceBoardFacet(address(diamond)).requestService(
            serviceId, AMOUNT, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();
    }

    function testRequestService() public {
        uint256 serviceId = _mintService();

        uint256 clientBefore = usdc.balanceOf(client);
        uint256 feeBefore    = usdc.balanceOf(feeRecipient);

        uint256 requestId = _requestService(serviceId);
        assertEq(requestId, 0);

        // Комиссия удержана в Diamond вместе с amount — сделки ещё нет
        assertEq(usdc.balanceOf(feeRecipient), feeBefore);
        assertEq(usdc.balanceOf(address(diamond)), AMOUNT + JOB_FEE);
        assertEq(usdc.balanceOf(client), clientBefore - AMOUNT - JOB_FEE);

        ServiceBoardStorage.HireRequest memory req = ServiceBoardFacet(address(diamond)).getRequest(requestId);
        assertEq(req.client, client);
        assertEq(req.amount, AMOUNT);
        assertEq(uint256(req.status), uint256(ServiceBoardStorage.RequestStatus.PENDING));
        assertEq(req.agreement, address(0));
    }

    function testAcceptRequest() public {
        uint256 serviceId = _mintService();
        uint256 requestId = _requestService(serviceId);

        uint256 diamondBefore = usdc.balanceOf(address(diamond));
        uint256 feeBefore     = usdc.balanceOf(feeRecipient);

        vm.prank(executor);
        address agreementAddr = ServiceBoardFacet(address(diamond)).acceptRequest(requestId);

        assertTrue(agreementAddr != address(0));

        // Amount ушёл из Diamond в Agreement, комиссия — в feeRecipient
        assertEq(usdc.balanceOf(address(diamond)), diamondBefore - AMOUNT - JOB_FEE);
        assertEq(usdc.balanceOf(feeRecipient), feeBefore + JOB_FEE);

        // Pair зарегистрирована
        assertTrue(RegistryFacet(address(diamond)).hasActivePair(client, executor));

        // hiresCount вырос
        ServiceBoardStorage.Service memory svc = ServiceBoardFacet(address(diamond)).getService(serviceId);
        assertEq(svc.hiresCount, 1);

        // Request статус изменился
        ServiceBoardStorage.HireRequest memory req = ServiceBoardFacet(address(diamond)).getRequest(requestId);
        assertEq(uint256(req.status), uint256(ServiceBoardStorage.RequestStatus.ACCEPTED));
        assertEq(req.agreement, agreementAddr);
    }

    function testRejectRequest() public {
        uint256 serviceId = _mintService();
        uint256 requestId = _requestService(serviceId);

        uint256 clientBefore  = usdc.balanceOf(client);
        uint256 diamondBefore = usdc.balanceOf(address(diamond));

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).rejectRequest(requestId);

        // Amount + комиссия сверх пола рефанднуты клиенту, пол сгорает
        assertEq(usdc.balanceOf(client), clientBefore + AMOUNT + (JOB_FEE - JOB_FLOOR));
        assertEq(usdc.balanceOf(address(diamond)), diamondBefore - AMOUNT - JOB_FEE);

        ServiceBoardStorage.HireRequest memory req = ServiceBoardFacet(address(diamond)).getRequest(requestId);
        assertEq(uint256(req.status), uint256(ServiceBoardStorage.RequestStatus.REJECTED));
    }

    function testCancelRequest() public {
        uint256 serviceId = _mintService();
        uint256 requestId = _requestService(serviceId);

        uint256 clientBefore = usdc.balanceOf(client);

        vm.prank(client);
        ServiceBoardFacet(address(diamond)).cancelRequest(requestId);

        // Amount + комиссия сверх пола рефанднуты клиенту, пол сгорает
        assertEq(usdc.balanceOf(client), clientBefore + AMOUNT + (JOB_FEE - JOB_FLOOR));

        ServiceBoardStorage.HireRequest memory req = ServiceBoardFacet(address(diamond)).getRequest(requestId);
        assertEq(uint256(req.status), uint256(ServiceBoardStorage.RequestStatus.CANCELLED));
    }

    function testRequestServiceSelf() public {
        uint256 serviceId = _mintService();

        vm.startPrank(executor);
        usdc.approve(address(diamond), FEE + AMOUNT);
        vm.expectRevert(ServiceBoardFacet.SelfRequest.selector);
        ServiceBoardFacet(address(diamond)).requestService(serviceId, AMOUNT, DEADLINE, TERMS, REGION);
        vm.stopPrank();
    }

    function testAcceptRequestNotExecutor() public {
        uint256 serviceId = _mintService();
        uint256 requestId = _requestService(serviceId);

        vm.prank(client);
        vm.expectRevert(ServiceBoardFacet.NotExecutor.selector);
        ServiceBoardFacet(address(diamond)).acceptRequest(requestId);
    }

    function testRequestServiceRevertsIfActivePairExists() public {
        // Client already has an active deal with this executor (from a prior service).
        uint256 serviceId1 = _mintService();
        uint256 requestId1 = _requestService(serviceId1);

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).acceptRequest(requestId1);

        assertTrue(RegistryFacet(address(diamond)).hasActivePair(client, executor));

        // Same executor posts a second service.
        uint256 serviceId2 = _mintService();

        // Client tries to hire them again while the first deal is still active —
        // must fail fast here, not lock funds only to have acceptRequest() revert later.
        vm.startPrank(client);
        usdc.approve(address(diamond), AMOUNT);
        vm.expectRevert(ServiceBoardFacet.ActiveDealExists.selector);
        ServiceBoardFacet(address(diamond)).requestService(serviceId2, AMOUNT, DEADLINE, TERMS, REGION);
        vm.stopPrank();
    }

    function testAcceptRequestSupersedesSiblingPendingFromSameClient() public {
        uint256 serviceId1 = _mintService();
        uint256 serviceId2 = _mintService();

        uint256 requestId1 = _requestService(serviceId1);

        // Client submits a second pending request to the SAME executor (different
        // service) before either is accepted — hasActivePair doesn't block this since
        // neither is active yet.
        vm.startPrank(client);
        usdc.approve(address(diamond), AMOUNT + JOB_FEE);
        uint256 requestId2 = ServiceBoardFacet(address(diamond)).requestService(
            serviceId2, AMOUNT, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();

        uint256 clientBefore = usdc.balanceOf(client);

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).acceptRequest(requestId1);

        // requestId1: accepted normally
        ServiceBoardStorage.HireRequest memory req1 = ServiceBoardFacet(address(diamond)).getRequest(requestId1);
        assertEq(uint256(req1.status), uint256(ServiceBoardStorage.RequestStatus.ACCEPTED));

        // requestId2: auto-superseded and refunded, even though nobody called cancel/reject —
        // amount + fee above the floor comes back, the floor is forfeited.
        ServiceBoardStorage.HireRequest memory req2 = ServiceBoardFacet(address(diamond)).getRequest(requestId2);
        assertEq(uint256(req2.status), uint256(ServiceBoardStorage.RequestStatus.SUPERSEDED));
        assertEq(usdc.balanceOf(client), clientBefore + AMOUNT + (JOB_FEE - JOB_FLOOR));
    }

    function testAcceptRequestDoesNotReprocessAlreadyResolvedSibling() public {
        uint256 serviceId1 = _mintService();
        uint256 serviceId2 = _mintService();

        uint256 requestId1 = _requestService(serviceId1);

        vm.startPrank(client);
        usdc.approve(address(diamond), AMOUNT + JOB_FEE);
        uint256 requestId2 = ServiceBoardFacet(address(diamond)).requestService(
            serviceId2, AMOUNT, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();

        // Client cancels requestId1 themselves before the executor does anything.
        vm.prank(client);
        ServiceBoardFacet(address(diamond)).cancelRequest(requestId1);

        uint256 clientBefore = usdc.balanceOf(client);

        // Executor accepts requestId2 — requestId1 is already CANCELLED (not PENDING),
        // must not be touched again (no double refund, stays CANCELLED).
        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).acceptRequest(requestId2);

        ServiceBoardStorage.HireRequest memory req1 = ServiceBoardFacet(address(diamond)).getRequest(requestId1);
        assertEq(uint256(req1.status), uint256(ServiceBoardStorage.RequestStatus.CANCELLED));
        assertEq(usdc.balanceOf(client), clientBefore);
    }

    function testRejectAndCancelPruneThePendingPairList() public {
        uint256 serviceId = _mintService();

        uint256 requestId1 = _requestService(serviceId);
        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).rejectRequest(requestId1);

        uint256[] memory afterReject = ServiceBoardFacet(address(diamond)).getPendingRequestIdsByClientAndExecutor(client, executor);
        assertEq(afterReject.length, 0);

        uint256 requestId2 = _requestService(serviceId);
        vm.prank(client);
        ServiceBoardFacet(address(diamond)).cancelRequest(requestId2);

        uint256[] memory afterCancel = ServiceBoardFacet(address(diamond)).getPendingRequestIdsByClientAndExecutor(client, executor);
        assertEq(afterCancel.length, 0);
    }

    function testAcceptRequestDoesNotSupersedeOtherClientsPendingRequests() public {
        uint256 serviceId = _mintService();

        address client2 = address(0x5);
        usdc.mint(client2, 500_000_000);

        uint256 requestId1 = _requestService(serviceId);

        vm.startPrank(client2);
        usdc.approve(address(diamond), AMOUNT + JOB_FEE);
        uint256 requestId2 = ServiceBoardFacet(address(diamond)).requestService(
            serviceId, AMOUNT, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).acceptRequest(requestId1);

        // client2's pending request for the SAME service is untouched — multi-buyer
        // per listing (see testServiceMultipleAccepts) is not affected.
        ServiceBoardStorage.HireRequest memory req2 = ServiceBoardFacet(address(diamond)).getRequest(requestId2);
        assertEq(uint256(req2.status), uint256(ServiceBoardStorage.RequestStatus.PENDING));
    }

    function testRequestServiceRevertsWhenPendingCapReached() public {
        uint256 serviceId = _mintService();

        // Ensure client has enough balance for 20 requests at (AMOUNT + fee) each,
        // plus slack for the 21st after cancelling frees a slot (refund is amount +
        // fee above the floor — one floor's worth less than a fresh request costs).
        usdc.mint(client, 1_200_000_000);

        // Fill the cap with PENDING requests to the same executor (different
        // client so hasActivePair never trips — this is purely exercising the
        // count cap, not the active-pair guard).
        vm.startPrank(client);
        for (uint256 i = 0; i < 20; i++) {
            usdc.approve(address(diamond), AMOUNT + JOB_FEE);
            ServiceBoardFacet(address(diamond)).requestService(serviceId, AMOUNT, DEADLINE, TERMS, REGION);
        }
        usdc.approve(address(diamond), AMOUNT + JOB_FEE);
        vm.expectRevert(ServiceBoardFacet.TooManyPendingRequests.selector);
        ServiceBoardFacet(address(diamond)).requestService(serviceId, AMOUNT, DEADLINE, TERMS, REGION);
        vm.stopPrank();

        // Cancelling one frees a slot.
        uint256[] memory pending = ServiceBoardFacet(address(diamond)).getPendingRequestIdsByClientAndExecutor(client, executor);
        assertEq(pending.length, 20);
        vm.prank(client);
        ServiceBoardFacet(address(diamond)).cancelRequest(pending[0]);

        vm.startPrank(client);
        usdc.approve(address(diamond), AMOUNT + JOB_FEE);
        ServiceBoardFacet(address(diamond)).requestService(serviceId, AMOUNT, DEADLINE, TERMS, REGION);
        vm.stopPrank();
    }

    function testRemoveService() public {
        uint256 serviceId = _mintService();

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).removeService(serviceId);

        ServiceBoardStorage.Service memory svc = ServiceBoardFacet(address(diamond)).getService(serviceId);
        assertEq(uint256(svc.status), uint256(ServiceBoardStorage.ServiceStatus.REMOVED));
    }

    function testRemoveServiceNotExecutor() public {
        uint256 serviceId = _mintService();

        vm.prank(client);
        vm.expectRevert(ServiceBoardFacet.NotExecutor.selector);
        ServiceBoardFacet(address(diamond)).removeService(serviceId);
    }

    function testPauseAndUnpauseService() public {
        uint256 serviceId = _mintService();

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).pauseService(serviceId);

        ServiceBoardStorage.Service memory svc = ServiceBoardFacet(address(diamond)).getService(serviceId);
        assertEq(uint256(svc.status), uint256(ServiceBoardStorage.ServiceStatus.PAUSED));

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).unpauseService(serviceId);

        svc = ServiceBoardFacet(address(diamond)).getService(serviceId);
        assertEq(uint256(svc.status), uint256(ServiceBoardStorage.ServiceStatus.ACTIVE));
    }

    function testRequestPausedService() public {
        uint256 serviceId = _mintService();

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).pauseService(serviceId);

        vm.startPrank(client);
        usdc.approve(address(diamond), FEE + AMOUNT);
        vm.expectRevert(ServiceBoardFacet.ServiceNotActive.selector);
        ServiceBoardFacet(address(diamond)).requestService(serviceId, AMOUNT, DEADLINE, TERMS, REGION);
        vm.stopPrank();
    }

    function testServiceMultipleAccepts() public {
        uint256 serviceId = _mintService();

        address client2 = address(0x5);
        usdc.mint(client2, 500_000_000);

        // Первый запрос
        uint256 requestId1 = _requestService(serviceId);

        // Второй запрос от другого клиента
        uint256 amount2 = 50_000_000;
        uint256 fee2 = 2_500_000; // 5% от $50
        vm.startPrank(client2);
        usdc.approve(address(diamond), amount2 + fee2);
        uint256 requestId2 = ServiceBoardFacet(address(diamond)).requestService(
            serviceId, amount2, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();

        // Executor принимает первый запрос
        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).acceptRequest(requestId1);

        // Executor отклоняет второй
        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).rejectRequest(requestId2);

        ServiceBoardStorage.Service memory svc = ServiceBoardFacet(address(diamond)).getService(serviceId);
        assertEq(svc.hiresCount, 1);
    }

    // ============================================================
    //  SERVICE BOARD EDIT + VIEW TESTS
    // ============================================================

    function testEditService() public {
        uint256 serviceId = _mintService();

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).editService(
            serviceId,
            "Updated Service",
            "New description",
            50_000_000, // new price
            14,         // new deadline
            REGION
        );

        ServiceBoardStorage.Service memory svc = ServiceBoardFacet(address(diamond)).getService(serviceId);
        assertEq(svc.title, "Updated Service");
        assertEq(svc.price, 50_000_000);
        assertEq(svc.deadlineDays, 14);
    }

    function testEditServiceRevertIfNotExecutor() public {
        uint256 serviceId = _mintService();

        vm.prank(client);
        vm.expectRevert(ServiceBoardFacet.NotExecutor.selector);
        ServiceBoardFacet(address(diamond)).editService(
            serviceId, "X", "X", 50_000_000, 14, REGION
        );
    }

    function testTotalRequests() public {
        uint256 serviceId = _mintService();
        assertEq(ServiceBoardFacet(address(diamond)).totalRequests(), 0);

        _requestService(serviceId);
        assertEq(ServiceBoardFacet(address(diamond)).totalRequests(), 1);
    }

    function testGetRequestFunds() public {
        uint256 serviceId = _mintService();
        uint256 requestId = _requestService(serviceId);

        assertEq(ServiceBoardFacet(address(diamond)).getRequestFunds(requestId), AMOUNT);
    }

    function testGetRequestFundsClearedOnAccept() public {
        uint256 serviceId = _mintService();
        uint256 requestId = _requestService(serviceId);

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).acceptRequest(requestId);

        // После accept средства ушли из Diamond в Agreement
        assertEq(ServiceBoardFacet(address(diamond)).getRequestFunds(requestId), 0);
    }

    function testGetActiveServices() public {
        _mintService();

        (uint256[] memory ids, ServiceBoardStorage.Service[] memory svcs) =
            ServiceBoardFacet(address(diamond)).getActiveServices();
        assertEq(ids.length, 1);
        assertEq(svcs[0].executor, executor);
    }

    function testGetExecutorServices() public {
        _mintService();

        uint256[] memory ids = ServiceBoardFacet(address(diamond)).getExecutorServices(executor);
        assertEq(ids.length, 1);
        assertEq(ids[0], 0);
    }

    function testAcceptRequestRevertIfNotPending() public {
        uint256 serviceId = _mintService();
        uint256 requestId = _requestService(serviceId);

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).acceptRequest(requestId);

        // Повторный accept того же requestId
        vm.prank(executor);
        vm.expectRevert(ServiceBoardFacet.RequestNotPending.selector);
        ServiceBoardFacet(address(diamond)).acceptRequest(requestId);
    }

    function testGetClientRequests() public {
        uint256 serviceId = _mintService();
        _requestService(serviceId);

        uint256[] memory reqs = ServiceBoardFacet(address(diamond)).getClientRequests(client);
        assertEq(reqs.length, 1);
        assertEq(reqs[0], 0);
    }

    // ============================================================
    //  SERVICE BOARD REQUEST FEE
    // ============================================================

    function _postService() internal returns (uint256 serviceId) {
        vm.startPrank(executor);
        usdc.approve(address(diamond), 1_000_000);
        serviceId = ServiceBoardFacet(address(diamond)).mintService(
            "Solidity audit", "I audit contracts", 500_000_000, DEADLINE, REGION
        );
        vm.stopPrank();
    }

    function testRequestService_ChargesPercentageAndHolds() public {
        uint256 serviceId = _postService();
        uint256 amount = 200_000_000;  // $200
        uint256 fee = 10_000_000;      // 5%
        uint256 recipientBefore = usdc.balanceOf(feeRecipient);

        vm.startPrank(client);
        usdc.approve(address(diamond), amount + fee);
        ServiceBoardFacet(address(diamond)).requestService(
            serviceId, amount, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();

        // Комиссия удержана, а не переслана — сделки ещё нет
        assertEq(usdc.balanceOf(feeRecipient), recipientBefore);
        assertEq(usdc.balanceOf(address(diamond)), amount + fee);
    }

    function testAcceptRequest_ForwardsHeldFee() public {
        uint256 serviceId = _postService();
        uint256 amount = 200_000_000;
        uint256 fee = 10_000_000;
        uint256 recipientBefore = usdc.balanceOf(feeRecipient);

        vm.startPrank(client);
        usdc.approve(address(diamond), amount + fee);
        uint256 requestId = ServiceBoardFacet(address(diamond)).requestService(
            serviceId, amount, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).acceptRequest(requestId);

        assertEq(usdc.balanceOf(feeRecipient), recipientBefore + fee);
        assertEq(usdc.balanceOf(address(diamond)), 0);
    }

    function testRejectRequest_RefundsFeeAboveFloor() public {
        uint256 serviceId = _postService();
        uint256 amount = 200_000_000;
        uint256 fee = 10_000_000;
        uint256 floor_ = 1_000_000;
        uint256 clientBefore = usdc.balanceOf(client);
        uint256 recipientBefore = usdc.balanceOf(feeRecipient);

        vm.startPrank(client);
        usdc.approve(address(diamond), amount + fee);
        uint256 requestId = ServiceBoardFacet(address(diamond)).requestService(
            serviceId, amount, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).rejectRequest(requestId);

        assertEq(usdc.balanceOf(client), clientBefore - floor_);
        assertEq(usdc.balanceOf(feeRecipient), recipientBefore + floor_);
        assertEq(usdc.balanceOf(address(diamond)), 0);
    }

    function testCancelRequest_RefundsFeeAboveFloor() public {
        uint256 serviceId = _postService();
        uint256 amount = 200_000_000;
        uint256 fee = 10_000_000;
        uint256 floor_ = 1_000_000;
        uint256 clientBefore = usdc.balanceOf(client);

        vm.startPrank(client);
        usdc.approve(address(diamond), amount + fee);
        uint256 requestId = ServiceBoardFacet(address(diamond)).requestService(
            serviceId, amount, DEADLINE, TERMS, REGION
        );
        ServiceBoardFacet(address(diamond)).cancelRequest(requestId);
        vm.stopPrank();

        assertEq(usdc.balanceOf(client), clientBefore - floor_);
    }

    function testTenHires_EachPaysPercentage() public {
        uint256 serviceId = _postService();
        uint256 amount = 200_000_000;
        uint256 fee = 10_000_000;
        uint256 floor_ = 1_000_000;

        // Пол за публикацию уже уплачен исполнителем
        assertEq(usdc.balanceOf(feeRecipient), floor_);

        // Каждый найм — свой клиент (hasActivePair не пускает второй найм той же пары)
        for (uint256 i = 0; i < 10; i++) {
            address hirer = address(uint160(0x1000 + i));
            usdc.mint(hirer, amount + fee);

            vm.startPrank(hirer);
            usdc.approve(address(diamond), amount + fee);
            uint256 requestId = ServiceBoardFacet(address(diamond)).requestService(
                serviceId, amount, DEADLINE, TERMS, REGION
            );
            vm.stopPrank();

            vm.prank(executor);
            ServiceBoardFacet(address(diamond)).acceptRequest(requestId);
        }

        // Пол за объявление + десять процентов, а не один пол
        assertEq(usdc.balanceOf(feeRecipient), floor_ + 10 * fee);
    }
}
