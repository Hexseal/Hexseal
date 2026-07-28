// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// DisputeSettlement test suite.
//
// Считает и списывает 3% сбора со спорной суммы (Agreement.disputeFee() /
// Agreement.resolveDispute()) и проверяет, что провал зачисления на диамонде
// не блокирует закрытие спора.
//
// ЛОВУШКА (см. бриф): Agreement.arbiter — это не человек. claimDispute()
// всегда ставит арбитром сам диамонд (Diamond-as-arbiter), поэтому
// resolveDispute() достижим только через настоящую цепочку
// commitDisputeClaim → claimDispute → submitVerdict → finalizeVerdict.
// Прямой vm.prank(arbiterAddr); a.resolveDispute(true) ревертит NotArbiter.

import "forge-std/Test.sol";
import "../src/DiamondProxy.sol";
import "../src/RegistryFacet.sol";
import "../src/FactoryFacet.sol";
import "../src/AgreementDeployer.sol";
import "../src/Agreement.sol";
import "../src/facets/ArbiterRegistryFacet.sol";

// ---------- MOCK USDC ----------
// Скопирован из test/Extras.t.sol, расширен переключателем блокировки адреса
// (имитирует Circle-style чёрный список) для testBlacklistedArbiterCannotBlockResolution.

contract MockUSDCDST {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool)    public blocked;

    error Blocked();

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setBlocked(address who, bool state) external {
        blocked[who] = state;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (blocked[to]) revert Blocked();
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (blocked[to]) revert Blocked();
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

// ---------- TEST ----------

contract DisputeSettlementTest is Test {
    DiamondProxy   diamond;
    MockUSDCDST    usdc;

    address owner;
    address client;
    address executor;
    address arbiterAddr;
    address feeRecipient;

    uint256 constant CLIENT_USDC = 1_000_000_000_000; // с запасом на тест с потолком (50k USDC сделка)

    // ============================================================
    //  SETUP
    // ============================================================
    // Скопировано из test/Extras.t.sol (полный настоящий диамонд, не урезанный
    // сетап). Сверх исходного набора селекторов ArbiterRegistryFacet добавлены
    // creditDisputeFee/getTreasurySlice (Задача 2) — Extras.t.sol писался до
    // них. DiamondCutFacet нужен для _removeSelectorFromDiamond.

    function setUp() public {
        owner        = address(this);
        client       = address(0x1);
        executor     = address(0x2);
        arbiterAddr  = address(0x3);
        feeRecipient = address(0x4);

        usdc = new MockUSDCDST();
        usdc.mint(client, CLIENT_USDC);

        RegistryFacet        registryFacet        = new RegistryFacet();
        FactoryFacet         factoryFacet         = new FactoryFacet();
        DiamondCutFacet      diamondCutFacet      = new DiamondCutFacet();
        DiamondLoupeFacet    diamondLoupeFacet    = new DiamondLoupeFacet();
        OwnershipFacet       ownershipFacet       = new OwnershipFacet();
        ArbiterRegistryFacet arbiterRegistryFacet = new ArbiterRegistryFacet();

        bytes4[] memory regSels = new bytes4[](12);
        regSels[0]  = RegistryFacet.initRegistry.selector;
        regSels[1]  = RegistryFacet.register.selector;
        regSels[2]  = RegistryFacet.updateStatus.selector;
        regSels[3]  = RegistryFacet.setAuthorizedFactory.selector;
        regSels[4]  = RegistryFacet.hasActivePair.selector;
        regSels[5]  = RegistryFacet.getActivePair.selector;
        regSels[6]  = RegistryFacet.getRecord.selector;
        regSels[7]  = RegistryFacet.getByClient.selector;
        regSels[8]  = RegistryFacet.getByExecutor.selector;
        regSels[9]  = RegistryFacet.getActive.selector;
        regSels[10] = RegistryFacet.totalAgreements.selector;
        regSels[11] = RegistryFacet.authorizedFactory.selector;

        bytes4[] memory facSels = new bytes4[](13);
        facSels[0]  = FactoryFacet.initFactory.selector;
        facSels[1]  = FactoryFacet.deployAgreement.selector;
        facSels[2]  = FactoryFacet.setRegionFee.selector;
        facSels[3]  = FactoryFacet.setFeeRecipient.selector;
        facSels[4]  = FactoryFacet.setTrustedForwarder.selector;
        facSels[5]  = bytes4(0x16c38b3c);
        facSels[6]  = FactoryFacet.getRegionFee.selector;
        facSels[7]  = FactoryFacet.getAllFees.selector;
        facSels[8]  = FactoryFacet.getFeeRecipient.selector;
        facSels[9]  = FactoryFacet.getTrustedForwarder.selector;
        facSels[10] = bytes4(0xb187bd26);
        facSels[11] = FactoryFacet.getUsdc.selector;
        facSels[12] = bytes4(0x220f72fc);

        bytes4[] memory arbSels = new bytes4[](36);
        arbSels[0]  = ArbiterRegistryFacet.setChiefArbiter.selector;
        arbSels[1]  = ArbiterRegistryFacet.addArbiter.selector;
        arbSels[2]  = ArbiterRegistryFacet.removeArbiter.selector;
        arbSels[3]  = ArbiterRegistryFacet.commitDisputeClaim.selector;
        arbSels[4]  = ArbiterRegistryFacet.claimDispute.selector;
        arbSels[5]  = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        arbSels[6]  = ArbiterRegistryFacet.clearDisputeClaim.selector;
        arbSels[7]  = ArbiterRegistryFacet.getChiefArbiter.selector;
        arbSels[8]  = ArbiterRegistryFacet.isRegisteredArbiter.selector;
        arbSels[9]  = ArbiterRegistryFacet.getArbiters.selector;
        arbSels[10] = ArbiterRegistryFacet.getDisputeClaimer.selector;
        arbSels[11] = ArbiterRegistryFacet.getArbiterDeals.selector;
        arbSels[12] = ArbiterRegistryFacet.getClaimCommitment.selector;
        arbSels[13] = ArbiterRegistryFacet.activateDAO.selector;
        arbSels[14] = ArbiterRegistryFacet.applyAsArbiter.selector;
        arbSels[15] = ArbiterRegistryFacet.isDaoActive.selector;
        arbSels[16] = ArbiterRegistryFacet.getMinXPToRegister.selector;
        arbSels[17] = ArbiterRegistryFacet.getDaoThreshold.selector;
        arbSels[18] = ArbiterRegistryFacet.submitVerdict.selector;
        arbSels[19] = ArbiterRegistryFacet.finalizeVerdict.selector;
        arbSels[20] = ArbiterRegistryFacet.overturnVerdict.selector;
        arbSels[21] = ArbiterRegistryFacet.freezeVerdict.selector;
        arbSels[22] = ArbiterRegistryFacet.unfreezeVerdict.selector;
        arbSels[23] = ArbiterRegistryFacet.withdrawArbiterReward.selector;
        arbSels[24] = ArbiterRegistryFacet.fundVault.selector;
        arbSels[25] = ArbiterRegistryFacet.setRewardPerDispute.selector;
        arbSels[26] = ArbiterRegistryFacet.setDAOAddress.selector;
        arbSels[27] = ArbiterRegistryFacet.getPendingVerdict.selector;
        arbSels[28] = ArbiterRegistryFacet.getArbiterReward.selector;
        arbSels[29] = ArbiterRegistryFacet.getVaultBalance.selector;
        arbSels[30] = ArbiterRegistryFacet.getRewardPerDispute.selector;
        arbSels[31] = ArbiterRegistryFacet.getDAOAddress.selector;
        arbSels[32] = ArbiterRegistryFacet.clearStuckVerdict.selector;
        arbSels[33] = ArbiterRegistryFacet.creditDisputeFee.selector;
        arbSels[34] = ArbiterRegistryFacet.getTreasurySlice.selector;
        arbSels[35] = ArbiterRegistryFacet.withdrawTreasurySlice.selector;

        bytes4[] memory cutSels   = new bytes4[](1);
        cutSels[0] = DiamondCutFacet.diamondCut.selector;

        bytes4[] memory loupeSels = new bytes4[](5);
        loupeSels[0] = DiamondLoupeFacet.facets.selector;
        loupeSels[1] = DiamondLoupeFacet.facetFunctionSelectors.selector;
        loupeSels[2] = DiamondLoupeFacet.facetAddresses.selector;
        loupeSels[3] = DiamondLoupeFacet.facetAddress.selector;
        loupeSels[4] = DiamondLoupeFacet.supportsInterface.selector;

        bytes4[] memory ownSels   = new bytes4[](4);
        ownSels[0] = OwnershipFacet.transferOwnership.selector;
        ownSels[1] = OwnershipFacet.owner.selector;
        ownSels[2] = OwnershipFacet.acceptOwnership.selector;
        ownSels[3] = OwnershipFacet.pendingOwner.selector;

        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](6);
        cut[0] = IDiamondCut.FacetCut(address(registryFacet),        IDiamondCut.FacetCutAction.Add, regSels);
        cut[1] = IDiamondCut.FacetCut(address(factoryFacet),         IDiamondCut.FacetCutAction.Add, facSels);
        cut[2] = IDiamondCut.FacetCut(address(diamondCutFacet),      IDiamondCut.FacetCutAction.Add, cutSels);
        cut[3] = IDiamondCut.FacetCut(address(diamondLoupeFacet),    IDiamondCut.FacetCutAction.Add, loupeSels);
        cut[4] = IDiamondCut.FacetCut(address(ownershipFacet),       IDiamondCut.FacetCutAction.Add, ownSels);
        cut[5] = IDiamondCut.FacetCut(address(arbiterRegistryFacet), IDiamondCut.FacetCutAction.Add, arbSels);

        diamond = new DiamondProxy(owner, cut, address(0), "");

        Agreement agreementImpl = new Agreement();
        AgreementDeployer agDeployer = new AgreementDeployer(address(diamond), address(agreementImpl));
        RegistryFacet(address(diamond)).initRegistry(address(diamond));
        FactoryFacet(address(diamond)).initFactory(
            address(usdc), feeRecipient, address(0xDEAD), address(diamond), address(agDeployer)
        );
        ArbiterRegistryFacet(address(diamond)).addArbiter(arbiterAddr);
    }

    // ============================================================
    //  HELPERS
    // ============================================================

    function _createFundedAgreement(uint256 dealAmount) internal returns (address) {
        vm.startPrank(client);
        usdc.approve(address(diamond), type(uint256).max);
        address a = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, address(0), dealAmount, 7, "terms", 0
        );
        vm.stopPrank();

        usdc.mint(client, dealAmount);
        vm.startPrank(client);
        usdc.approve(a, dealAmount);
        Agreement(a).fund();
        vm.stopPrank();
        return a;
    }

    /// Доводит агримент до DISPUTED и реально клеймит его арбитром через
    /// commit-reveal — claimDispute() требует предварительный
    /// commitDisputeClaim() и хотя бы один блок между коммитом и клеймом
    /// (CommitmentTooEarly иначе). raiseDispute() аргументов не принимает.
    function _activateAndDispute(Agreement a) internal {
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        bytes32 salt       = keccak256(abi.encodePacked("settlement-salt", address(a), block.number));
        bytes32 commitment = keccak256(abi.encodePacked(address(a), arbiterAddr, salt));
        vm.prank(arbiterAddr);
        ArbiterRegistryFacet(address(diamond)).commitDisputeClaim(commitment);
        vm.roll(block.number + 1);
        vm.prank(arbiterAddr);
        ArbiterRegistryFacet(address(diamond)).claimDispute(address(a), salt);
    }

    /// Настоящая цепочка исполнения вердикта. resolveDispute() в проде
    /// достижим ТОЛЬКО так — Agreement.arbiter после claimDispute это сам
    /// диамонд, а finalizeVerdict вызывает resolveDispute от его имени.
    /// Прямой a.resolveDispute(...) от человека-арбитра ревертит NotArbiter.
    function _submitAndFinalize(Agreement a, bool clientWins) internal {
        vm.prank(arbiterAddr);
        ArbiterRegistryFacet(address(diamond)).submitVerdict(address(a), clientWins);
        vm.warp(block.timestamp + 24 hours + 1); // FINALIZE_DELAY (приватная константа фасета)
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(address(a));
    }

    function _removeSelectorFromDiamond(bytes4 selector) internal {
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = selector;
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = IDiamondCut.FacetCut({
            facetAddress:      address(0),
            action:            IDiamondCut.FacetCutAction.Remove,
            functionSelectors: sels
        });
        DiamondCutFacet(address(diamond)).diamondCut(cut, address(0), "");
    }

    /// Требует вызов vm.recordLogs() до операции, которую проверяем. Пустая
    /// проверка молчаливого провала: без неё try/catch в resolveDispute
    /// прячет провалившееся зачисление, и все ассерты кроме счётчиков всё
    /// равно проходят.
    function _assertDisputeFeeSkippedNotEmitted() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 skippedSig = Agreement.DisputeFeeSkipped.selector;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == skippedSig) {
                fail("DisputeFeeSkipped must not fire on the happy path");
            }
        }
    }

    function _assertDisputeFeeSkippedEmitted(uint256 expectedAmount) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 skippedSig = Agreement.DisputeFeeSkipped.selector;
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == skippedSig) {
                found = true;
                assertEq(abi.decode(logs[i].data, (uint256)), expectedAmount, "skipped amount must match the computed fee");
            }
        }
        assertTrue(found, "DisputeFeeSkipped must fire when the credit call fails");
    }

    // ============================================================
    //  disputeFee() — 3%, без границы, с потолком
    // ============================================================

    /// 3% от котла, ни границы, ни округления вверх.
    function testDisputeFeeIsThreePercent() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        assertEq(a.disputeFee(), 6_000_000, "3% of 200 USDC");
    }

    /// Границы нет: на мелкой сделке сбор мелкий, а не $5.
    function testDisputeFeeHasNoFloor() public {
        Agreement a = Agreement(_createFundedAgreement(10_000_000));
        assertEq(a.disputeFee(), 300_000, "3% of 10 USDC, not a 5 USDC floor");
    }

    /// Потолок применяется к сбору целиком.
    function testDisputeFeeIsCapped() public {
        Agreement a = Agreement(_createFundedAgreement(50_000_000_000));
        assertEq(a.disputeFee(), 500_000_000, "capped at 500 USDC");
    }

    // ============================================================
    //  resolveDispute() — счастливый путь: сбор реально взят
    // ============================================================

    /// Победитель получает котёл минус сбор, арбитру и казне зачислено.
    /// Идёт настоящей цепочкой finalizeVerdict — иначе Agreement.arbiter это
    /// диамонд, а не arbiterAddr, и resolveDispute() ревертнул бы NotArbiter.
    function testResolveDisputeDeductsTheFee() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        _activateAndDispute(a);

        uint256 clientBefore = usdc.balanceOf(client);

        vm.recordLogs();
        _submitAndFinalize(a, true);
        _assertDisputeFeeSkippedNotEmitted();

        assertEq(usdc.balanceOf(client) - clientBefore, 194_000_000, "client gets 97%");
        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterReward(arbiterAddr), 4_800_000, "arbiter 80% of the fee");
        assertEq(ArbiterRegistryFacet(address(diamond)).getTreasurySlice(), 1_200_000, "treasury 20% of the fee");
    }

    /// Тот же счастливый путь, но исполнитель выигрывает — payout идёт ему,
    /// а не клиенту. Проверяет ветку clientWins == false, которую
    /// testResolveDisputeDeductsTheFee не касается.
    function testResolveDisputeDeductsTheFeeWhenExecutorWins() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        _activateAndDispute(a);

        uint256 executorBefore = usdc.balanceOf(executor);

        vm.recordLogs();
        _submitAndFinalize(a, false);
        _assertDisputeFeeSkippedNotEmitted();

        assertEq(usdc.balanceOf(executor) - executorBefore, 194_000_000, "executor gets 97%");
        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterReward(arbiterAddr), 4_800_000, "arbiter 80% of the fee");
        assertEq(ArbiterRegistryFacet(address(diamond)).getTreasurySlice(), 1_200_000, "treasury 20% of the fee");
    }

    /// Сквозной: счётчики ничего не значат, если за ними не стоят настоящие
    /// USDC на диамонде. Не проверять это — значит не заметить, если сбор
    /// зачислится (счётчики вырастут), но реально переведётся не туда
    /// (например, останется на самом Agreement, а не уйдёт на диамонд):
    /// счётчики выглядели бы здоровыми, а withdraw был бы нечем платить.
    function testDisputeFeeActuallyReachesArbiterAndTreasuryWallets() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        _activateAndDispute(a);
        _submitAndFinalize(a, true);

        uint256 arbBefore = usdc.balanceOf(arbiterAddr);
        vm.prank(arbiterAddr);
        ArbiterRegistryFacet(address(diamond)).withdrawArbiterReward();
        assertEq(usdc.balanceOf(arbiterAddr) - arbBefore, 4_800_000, "reward must actually reach the arbiter's wallet");

        uint256 recipientBefore = usdc.balanceOf(feeRecipient);
        ArbiterRegistryFacet(address(diamond)).withdrawTreasurySlice();
        assertEq(usdc.balanceOf(feeRecipient) - recipientBefore, 1_200_000, "treasury slice must actually reach the fee recipient");
    }

    // ============================================================
    //  resolveDispute() — провал зачисления терпим, но виден
    // ============================================================

    /// Сбор не должен уметь заблокировать закрытие спора. Если зачисление
    /// провалилось, спор всё равно закрывается, а сбор не берётся — деньги
    /// целиком уходят победителю, и это видно событием.
    function testResolveDisputeSurvivesAFailingCredit() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        _activateAndDispute(a);

        // Снимаем creditDisputeFee с диамонда — имитируем апгрейд фасета,
        // который сломал приём сбора.
        _removeSelectorFromDiamond(ArbiterRegistryFacet.creditDisputeFee.selector);

        uint256 clientBefore  = usdc.balanceOf(client);
        uint256 diamondBefore = usdc.balanceOf(address(diamond));

        vm.recordLogs();
        _submitAndFinalize(a, true);
        _assertDisputeFeeSkippedEmitted(6_000_000);

        // Зачисление провалилось — значит сбор НЕ взят вовсе. Победитель
        // получает весь котёл, на диамонде не оседает ни цента: оттуда их
        // было бы не достать никогда, функции спасения там нет.
        assertEq(uint8(a.status()), uint8(Agreement.Status.RESOLVED), "the dispute must still close");
        assertEq(usdc.balanceOf(client) - clientBefore, 200_000_000, "no fee taken, winner gets the whole pot");
        assertEq(usdc.balanceOf(address(diamond)) - diamondBefore, 0, "not a cent may be stranded on the diamond");
        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterReward(arbiterAddr), 0, "nothing credited");
        assertEq(ArbiterRegistryFacet(address(diamond)).getTreasurySlice(), 0, "nothing credited");
    }

    // ============================================================
    //  resolveDispute() — заблокированный арбитр не блокирует закрытие
    // ============================================================

    /// Адрес арбитра в чёрном списке USDC не должен мешать закрыть спор.
    /// Награда просто остаётся начисленной, а стороны получают своё.
    /// Начисление (а не прямой перевод) снимает этот риск по конструкции —
    /// арбитр забирает сам, когда захочет.
    function testBlacklistedArbiterCannotBlockResolution() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        _activateAndDispute(a);

        usdc.setBlocked(arbiterAddr, true);

        vm.recordLogs();
        _submitAndFinalize(a, true);
        _assertDisputeFeeSkippedNotEmitted();

        assertEq(uint8(a.status()), uint8(Agreement.Status.RESOLVED), "the dispute must still close");
        assertEq(
            ArbiterRegistryFacet(address(diamond)).getArbiterReward(arbiterAddr),
            4_800_000,
            "the reward stays credited and withdrawable later"
        );

        // И забрать её пока нельзя — но это отказ выплаты, а не отказ закрытия.
        vm.prank(arbiterAddr);
        vm.expectRevert();
        ArbiterRegistryFacet(address(diamond)).withdrawArbiterReward();
    }
}
