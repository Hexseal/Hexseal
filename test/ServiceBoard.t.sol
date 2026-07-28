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

        // This test isolates the per-PAIR cap (MAX_PENDING_PER_PAIR = 20). The
        // per-CLIENT cap (Task 6, seeded to 5 by initFactory) is a separate,
        // stricter gate that would otherwise trip first — disable it here
        // (0 = unlimited) so this test still exercises the pair cap alone.
        FactoryFacet(address(diamond)).setMaxPendingRequests(0);

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

    function testPendingRequestCap_BlocksSixth() public {
        uint256 amount = 20_000_000;
        uint256 fee = 1_000_000;

        // Пять разных исполнителей, у каждого своя услуга
        uint256[] memory serviceIds = new uint256[](6);
        for (uint256 i = 0; i < 6; i++) {
            address exec = address(uint160(0x2000 + i));
            usdc.mint(exec, fee);
            vm.startPrank(exec);
            usdc.approve(address(diamond), fee);
            serviceIds[i] = ServiceBoardFacet(address(diamond)).mintService(
                "Service", "Desc", 100_000_000, DEADLINE, REGION
            );
            vm.stopPrank();
        }

        usdc.mint(client, 6 * (amount + fee));
        vm.startPrank(client);
        usdc.approve(address(diamond), 6 * (amount + fee));

        for (uint256 i = 0; i < 5; i++) {
            ServiceBoardFacet(address(diamond)).requestService(
                serviceIds[i], amount, DEADLINE, TERMS, REGION
            );
        }

        // Шестая — сверх потолка
        vm.expectRevert(ServiceBoardFacet.TooManyPendingRequests.selector);
        ServiceBoardFacet(address(diamond)).requestService(
            serviceIds[5], amount, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();
    }

    function testPendingRequestCap_FreesSlotOnCancel() public {
        uint256 amount = 20_000_000;
        uint256 fee = 1_000_000;

        uint256[] memory serviceIds = new uint256[](6);
        for (uint256 i = 0; i < 6; i++) {
            address exec = address(uint160(0x3000 + i));
            usdc.mint(exec, fee);
            vm.startPrank(exec);
            usdc.approve(address(diamond), fee);
            serviceIds[i] = ServiceBoardFacet(address(diamond)).mintService(
                "Service", "Desc", 100_000_000, DEADLINE, REGION
            );
            vm.stopPrank();
        }

        usdc.mint(client, 6 * (amount + fee));
        vm.startPrank(client);
        usdc.approve(address(diamond), 6 * (amount + fee));

        uint256 firstId = ServiceBoardFacet(address(diamond)).requestService(
            serviceIds[0], amount, DEADLINE, TERMS, REGION
        );
        for (uint256 i = 1; i < 5; i++) {
            ServiceBoardFacet(address(diamond)).requestService(
                serviceIds[i], amount, DEADLINE, TERMS, REGION
            );
        }

        // Освобождаем слот — шестая проходит
        ServiceBoardFacet(address(diamond)).cancelRequest(firstId);
        uint256 sixthId = ServiceBoardFacet(address(diamond)).requestService(
            serviceIds[5], amount, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();

        // Не просто "не ревертнуло" — заявка реально создана и висит PENDING
        // (без гейта вообще этот тест был бы зелёным точно так же).
        ServiceBoardStorage.HireRequest memory sixth = ServiceBoardFacet(address(diamond)).getRequest(sixthId);
        assertEq(uint256(sixth.status), uint256(ServiceBoardStorage.RequestStatus.PENDING));
    }

    function testPendingRequestCap_FreesSlotOnAccept() public {
        uint256 amount = 20_000_000;
        uint256 fee = 1_000_000;

        uint256[] memory serviceIds = new uint256[](6);
        address[] memory execs = new address[](6);
        for (uint256 i = 0; i < 6; i++) {
            execs[i] = address(uint160(0x6000 + i));
            usdc.mint(execs[i], fee);
            vm.startPrank(execs[i]);
            usdc.approve(address(diamond), fee);
            serviceIds[i] = ServiceBoardFacet(address(diamond)).mintService(
                "Service", "Desc", 100_000_000, DEADLINE, REGION
            );
            vm.stopPrank();
        }

        usdc.mint(client, 6 * (amount + fee));
        vm.startPrank(client);
        usdc.approve(address(diamond), 6 * (amount + fee));

        uint256 firstId = ServiceBoardFacet(address(diamond)).requestService(
            serviceIds[0], amount, DEADLINE, TERMS, REGION
        );
        for (uint256 i = 1; i < 5; i++) {
            ServiceBoardFacet(address(diamond)).requestService(
                serviceIds[i], amount, DEADLINE, TERMS, REGION
            );
        }
        vm.stopPrank();

        // Resolve one via acceptRequest (path 1's decrement), not cancel —
        // that decrement site is the one testPendingRequestCap_FreesSlotOnCancel
        // does not exercise.
        vm.prank(execs[0]);
        ServiceBoardFacet(address(diamond)).acceptRequest(firstId);

        vm.startPrank(client);
        uint256 sixthId = ServiceBoardFacet(address(diamond)).requestService(
            serviceIds[5], amount, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();

        ServiceBoardStorage.HireRequest memory sixth = ServiceBoardFacet(address(diamond)).getRequest(sixthId);
        assertEq(uint256(sixth.status), uint256(ServiceBoardStorage.RequestStatus.PENDING));
    }

    function testPendingRequestCap_FreesSlotOnReject() public {
        uint256 amount = 20_000_000;
        uint256 fee = 1_000_000;

        uint256[] memory serviceIds = new uint256[](6);
        address[] memory execs = new address[](6);
        for (uint256 i = 0; i < 6; i++) {
            execs[i] = address(uint160(0x7000 + i));
            usdc.mint(execs[i], fee);
            vm.startPrank(execs[i]);
            usdc.approve(address(diamond), fee);
            serviceIds[i] = ServiceBoardFacet(address(diamond)).mintService(
                "Service", "Desc", 100_000_000, DEADLINE, REGION
            );
            vm.stopPrank();
        }

        usdc.mint(client, 6 * (amount + fee));
        vm.startPrank(client);
        usdc.approve(address(diamond), 6 * (amount + fee));

        uint256 firstId = ServiceBoardFacet(address(diamond)).requestService(
            serviceIds[0], amount, DEADLINE, TERMS, REGION
        );
        for (uint256 i = 1; i < 5; i++) {
            ServiceBoardFacet(address(diamond)).requestService(
                serviceIds[i], amount, DEADLINE, TERMS, REGION
            );
        }
        vm.stopPrank();

        // Resolve one via rejectRequest (path 3's decrement).
        vm.prank(execs[0]);
        ServiceBoardFacet(address(diamond)).rejectRequest(firstId);

        vm.startPrank(client);
        uint256 sixthId = ServiceBoardFacet(address(diamond)).requestService(
            serviceIds[5], amount, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();

        ServiceBoardStorage.HireRequest memory sixth = ServiceBoardFacet(address(diamond)).getRequest(sixthId);
        assertEq(uint256(sixth.status), uint256(ServiceBoardStorage.RequestStatus.PENDING));
    }

    function testPendingRequestCap_FreesTwoSlotsOnSupersede() public {
        uint256 amount = 20_000_000;
        uint256 fee = 1_000_000;

        // exec0 hosts TWO services -- the client requests both, so accepting
        // one auto-supersedes the sibling request to the same executor via
        // the loop inside acceptRequest. Three more distinct executors fill
        // the cap to 5 pending total; two more distinct executors serve as
        // post-resolution probes.
        //
        // This isolates the sibling-loop decrement from acceptRequest's own
        // (path 1) decrement: accepting always frees exactly one slot via
        // path 1 alone, so a single post-resolution probe can't tell the two
        // decrements apart. Two probes can -- if the sibling-loop decrement
        // were missing, only one slot would actually be free (path 1's),
        // and the second probe would revert TooManyPendingRequests.
        address exec0 = address(uint160(0x8000));
        usdc.mint(exec0, 2 * fee);
        vm.startPrank(exec0);
        usdc.approve(address(diamond), 2 * fee);
        uint256 serviceA = ServiceBoardFacet(address(diamond)).mintService(
            "Service", "Desc", 100_000_000, DEADLINE, REGION
        );
        uint256 serviceB = ServiceBoardFacet(address(diamond)).mintService(
            "Service", "Desc", 100_000_000, DEADLINE, REGION
        );
        vm.stopPrank();

        uint256[] memory fillerServiceIds = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) {
            address exec = address(uint160(0x8100 + i));
            usdc.mint(exec, fee);
            vm.startPrank(exec);
            usdc.approve(address(diamond), fee);
            fillerServiceIds[i] = ServiceBoardFacet(address(diamond)).mintService(
                "Service", "Desc", 100_000_000, DEADLINE, REGION
            );
            vm.stopPrank();
        }

        uint256[] memory probeServiceIds = new uint256[](2);
        for (uint256 i = 0; i < 2; i++) {
            address exec = address(uint160(0x8200 + i));
            usdc.mint(exec, fee);
            vm.startPrank(exec);
            usdc.approve(address(diamond), fee);
            probeServiceIds[i] = ServiceBoardFacet(address(diamond)).mintService(
                "Service", "Desc", 100_000_000, DEADLINE, REGION
            );
            vm.stopPrank();
        }

        usdc.mint(client, 7 * (amount + fee));
        vm.startPrank(client);
        usdc.approve(address(diamond), 7 * (amount + fee));

        uint256 requestA = ServiceBoardFacet(address(diamond)).requestService(
            serviceA, amount, DEADLINE, TERMS, REGION
        );
        uint256 requestB = ServiceBoardFacet(address(diamond)).requestService(
            serviceB, amount, DEADLINE, TERMS, REGION
        );
        for (uint256 i = 0; i < 3; i++) {
            ServiceBoardFacet(address(diamond)).requestService(
                fillerServiceIds[i], amount, DEADLINE, TERMS, REGION
            );
        }
        vm.stopPrank();

        // exec0 accepts requestA -- requestB (same client, same executor,
        // still PENDING) is auto-superseded by the sibling loop.
        vm.prank(exec0);
        ServiceBoardFacet(address(diamond)).acceptRequest(requestA);

        ServiceBoardStorage.HireRequest memory reqB = ServiceBoardFacet(address(diamond)).getRequest(requestB);
        assertEq(uint256(reqB.status), uint256(ServiceBoardStorage.RequestStatus.SUPERSEDED));

        vm.startPrank(client);
        uint256 probe1 = ServiceBoardFacet(address(diamond)).requestService(
            probeServiceIds[0], amount, DEADLINE, TERMS, REGION
        );
        uint256 probe2 = ServiceBoardFacet(address(diamond)).requestService(
            probeServiceIds[1], amount, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();

        ServiceBoardStorage.HireRequest memory p1 = ServiceBoardFacet(address(diamond)).getRequest(probe1);
        ServiceBoardStorage.HireRequest memory p2 = ServiceBoardFacet(address(diamond)).getRequest(probe2);
        assertEq(uint256(p1.status), uint256(ServiceBoardStorage.RequestStatus.PENDING));
        assertEq(uint256(p2.status), uint256(ServiceBoardStorage.RequestStatus.PENDING));
    }

    function testMaxPendingRequestsZeroMeansUnlimited() public {
        // Standalone assertion of the zero-means-unlimited semantics, so it
        // doesn't depend on testRequestServiceRevertsWhenPendingCapReached's
        // unrelated setMaxPendingRequests(0) call for coverage -- if that
        // test's cap value is ever changed away from 0, this one still pins
        // the behavior.
        FactoryFacet(address(diamond)).setMaxPendingRequests(0);

        uint256 amount = 20_000_000;
        uint256 fee = 1_000_000;

        uint256[] memory serviceIds = new uint256[](7);
        for (uint256 i = 0; i < 7; i++) {
            address exec = address(uint160(0x9000 + i));
            usdc.mint(exec, fee);
            vm.startPrank(exec);
            usdc.approve(address(diamond), fee);
            serviceIds[i] = ServiceBoardFacet(address(diamond)).mintService(
                "Service", "Desc", 100_000_000, DEADLINE, REGION
            );
            vm.stopPrank();
        }

        usdc.mint(client, 7 * (amount + fee));
        vm.startPrank(client);
        usdc.approve(address(diamond), 7 * (amount + fee));
        for (uint256 i = 0; i < 7; i++) {
            ServiceBoardFacet(address(diamond)).requestService(
                serviceIds[i], amount, DEADLINE, TERMS, REGION
            );
        }
        vm.stopPrank();

        assertEq(ServiceBoardFacet(address(diamond)).getClientRequests(client).length, 7);
    }

    function testLegacyPendingRequestDoesNotUnderflowOnResolve() public {
        // Simulates a request created by the PRE-Task-6 facet: PENDING in
        // storage, but pendingRequestCount was never incremented for this
        // client, because the field (and the increment) didn't exist yet at
        // the time it was created. A plain `--` on any of the four
        // PENDING-exit paths would underflow (Panic 0x11) on the very first
        // resolve, permanently stranding requestFunds in the Diamond.
        uint256 serviceId = _mintService();
        uint256 requestId = _requestService(serviceId);

        // pendingRequestCount is field index 11 (the 12th field) of
        // ServiceBoardStorage.Layout -- every field before it (mappings,
        // dynamic arrays, uint256) occupies exactly one slot in the struct's
        // own layout, so the mapping's base slot is POSITION + 11.
        bytes32 mappingSlot = bytes32(uint256(ServiceBoardStorage.POSITION) + 11);
        bytes32 countSlot = keccak256(abi.encode(client, mappingSlot));

        // Sanity check: _requestService() just incremented it to 1.
        assertEq(uint256(vm.load(address(diamond), countSlot)), 1);

        // Force it back to 0 -- the actual legacy state this request would
        // have had if the facet had never known about this counter.
        vm.store(address(diamond), countSlot, bytes32(uint256(0)));

        vm.prank(client);
        ServiceBoardFacet(address(diamond)).cancelRequest(requestId);

        ServiceBoardStorage.HireRequest memory req = ServiceBoardFacet(address(diamond)).getRequest(requestId);
        assertEq(uint256(req.status), uint256(ServiceBoardStorage.RequestStatus.CANCELLED));

        // Clamped at 0, not wrapped to type(uint256).max.
        assertEq(uint256(vm.load(address(diamond), countSlot)), 0);
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

    // ============================================================
    //  FEE LEDGER READ PATH
    // ============================================================

    function testGetRequestFeeHeld_ReportsWhatIsHeld() public {
        uint256 serviceId = _mintService();
        uint256 requestId = _requestService(serviceId);

        assertEq(ServiceBoardFacet(address(diamond)).getRequestFeeHeld(requestId), JOB_FEE);
    }

    function testGetRequestFeeHeld_ClearedOnAccept() public {
        uint256 serviceId = _mintService();
        uint256 requestId = _requestService(serviceId);

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).acceptRequest(requestId);

        assertEq(ServiceBoardFacet(address(diamond)).getRequestFeeHeld(requestId), 0);
    }

    function testGetRequestFeeHeld_ClearedOnCancelAndReject() public {
        uint256 serviceId = _mintService();

        uint256 cancelled = _requestService(serviceId);
        vm.prank(client);
        ServiceBoardFacet(address(diamond)).cancelRequest(cancelled);
        assertEq(ServiceBoardFacet(address(diamond)).getRequestFeeHeld(cancelled), 0);

        uint256 rejected = _requestService(serviceId);
        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).rejectRequest(rejected);
        assertEq(ServiceBoardFacet(address(diamond)).getRequestFeeHeld(rejected), 0);
    }

    function testGetPendingRequestCount_TracksPendingAndFreesOnExit() public {
        uint256 serviceId = _mintService();
        assertEq(ServiceBoardFacet(address(diamond)).getPendingRequestCount(client), 0);

        uint256 requestId = _requestService(serviceId);
        assertEq(ServiceBoardFacet(address(diamond)).getPendingRequestCount(client), 1);

        vm.prank(client);
        ServiceBoardFacet(address(diamond)).cancelRequest(requestId);
        assertEq(ServiceBoardFacet(address(diamond)).getPendingRequestCount(client), 0);
    }

    // ============================================================
    //  FEE COLLECTED EVENT
    // ============================================================

    function testAcceptRequest_EmitsFeeCollected() public {
        uint256 serviceId = _mintService();
        uint256 requestId = _requestService(serviceId);

        // Событие эмитится из того места, где реально идёт перевод, поэтому
        // несёт удержанную при заявке сумму, а не пересчитанную на момент найма.
        vm.expectEmit(true, true, false, true, address(diamond));
        emit ServiceBoardFacet.FeeCollected(requestId, client, JOB_FEE);

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).acceptRequest(requestId);
    }

    // ============================================================
    //  UPGRADE WINDOW: diamondCut landed, config transaction has not
    // ============================================================

    function testUnconfigured_MintServiceReverts() public {
        (DiamondProxy fresh, ) = _deployUnconfiguredDiamond();

        vm.startPrank(executor);
        usdc.approve(address(fresh), type(uint256).max);
        vm.expectRevert(FeeNotConfigured.selector);
        ServiceBoardFacet(address(fresh)).mintService(
            "Smart Contract Dev", "I write secure Solidity", AMOUNT, DEADLINE, REGION
        );
        vm.stopPrank();
    }

    function testUnconfigured_MintServiceWithPermitReverts() public {
        (DiamondProxy fresh, ) = _deployUnconfiguredDiamond();

        // Пол читается ДО permit(), поэтому путь падает на комиссии, а не на подписи.
        vm.expectRevert(FeeNotConfigured.selector);
        ServiceBoardFacet(address(fresh)).mintServiceWithPermit(
            executor, "Smart Contract Dev", "I write secure Solidity", AMOUNT, DEADLINE, REGION,
            block.timestamp + 1 days, 0, bytes32(0), bytes32(0)
        );
    }

    function testUnconfigured_RequestServiceReverts() public {
        (DiamondProxy fresh, ) = _deployUnconfiguredDiamond();

        vm.startPrank(client);
        usdc.approve(address(fresh), type(uint256).max);
        vm.expectRevert(FeeNotConfigured.selector);
        ServiceBoardFacet(address(fresh)).requestService(0, AMOUNT, DEADLINE, TERMS, REGION);
        vm.stopPrank();
    }

    function testUnconfigured_RequestServiceWithPermitReverts() public {
        (DiamondProxy fresh, ) = _deployUnconfiguredDiamond();

        vm.expectRevert(FeeNotConfigured.selector);
        ServiceBoardFacet(address(fresh)).requestServiceWithPermit(
            client, 0, AMOUNT, DEADLINE, TERMS, REGION,
            block.timestamp + 1 days, 0, bytes32(0), bytes32(0)
        );
    }

    /// Деньги обязаны выходить даже из неконфигурированного протокола: заявка
    /// подана ДО cut'а, окно засева ещё не закрыто, клиент отменяет.
    function testUnconfigured_CancelRequestStillReturnsEverything() public {
        (DiamondProxy fresh, ) = _deployBoardsDiamond();

        vm.startPrank(executor);
        usdc.approve(address(fresh), type(uint256).max);
        uint256 serviceId = ServiceBoardFacet(address(fresh)).mintService(
            "Smart Contract Dev", "I write secure Solidity", AMOUNT, DEADLINE, REGION
        );
        vm.stopPrank();

        vm.startPrank(client);
        usdc.approve(address(fresh), type(uint256).max);
        uint256 requestId = ServiceBoardFacet(address(fresh)).requestService(
            serviceId, AMOUNT, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();

        uint256 clientBefore = usdc.balanceOf(client);
        uint256 feeBefore = usdc.balanceOf(feeRecipient);

        _unconfigureFeeModel(address(fresh));

        vm.prank(client);
        ServiceBoardFacet(address(fresh)).cancelRequest(requestId);

        // Пола нет — сгорать нечему, возвращается всё: и сумма, и комиссия.
        assertEq(usdc.balanceOf(client), clientBefore + AMOUNT + JOB_FEE);
        assertEq(usdc.balanceOf(feeRecipient), feeBefore);
        assertEq(usdc.balanceOf(address(fresh)), 0);
    }
}
