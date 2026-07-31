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
import "../src/facets/ReputationFacet.sol";
import "../src/MinimalForwarder.sol";

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
    using stdStorage for StdStorage;

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
        ReputationFacet      reputationFacet      = new ReputationFacet();

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

        bytes4[] memory arbSels = new bytes4[](46);
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
        // Оба нужны пути таймаута (Задача 4): hasSubmittedVerdict вызывается
        // ЖЁСТКО (не в try/catch), без него triggerArbiterTimeout ревертит
        // «Diamond: function not found» ещё до расчёта котла;
        // notifyArbiterTimeout под try/catch, но без него ветка «арбитр взялся
        // и не довёл» молча не наказывала бы арбитра, и тест шёл бы по пути,
        // которого в проде нет.
        arbSels[36] = ArbiterRegistryFacet.hasSubmittedVerdict.selector;
        arbSels[37] = ArbiterRegistryFacet.notifyArbiterTimeout.selector;
        // Задача 4b: наказание за неявку читается только отсюда — без этого
        // селектора testLateReleaseCannotDodgeTheArbiterPenalty не смог бы
        // отличить «ошибка записана» от «функции нет на диамонде».
        arbSels[38] = ArbiterRegistryFacet.getArbiterMistakeStreak.selector;
        // Задача 1 (платный вызов арбитра): порог и котировка доплаты.
        arbSels[39] = ArbiterRegistryFacet.setArbiterFloor.selector;
        arbSels[40] = ArbiterRegistryFacet.getArbiterFloor.selector;
        arbSels[41] = ArbiterRegistryFacet.quoteDisputeTopUp.selector;
        // Задача 2 (платный вызов арбитра): оплата и мягкий возврат доплаты.
        arbSels[42] = ArbiterRegistryFacet.fundDispute.selector;
        arbSels[43] = ArbiterRegistryFacet.getDisputeBounty.selector;
        arbSels[44] = ArbiterRegistryFacet.withdrawDisputeBounty.selector;
        arbSels[45] = ArbiterRegistryFacet.getRefundableBounty.selector;

        // Задача 4: счётчик споров без вердикта. Только геттер — запись идёт
        // напрямую из ArbiterRegistryFacet в общее namespaced-хранилище, этот
        // селектор нужен лишь чтобы тест мог его прочитать через диамонд.
        bytes4[] memory repSels  = new bytes4[](1);
        repSels[0] = ReputationFacet.getUnresolvedDisputes.selector;

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

        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](7);
        cut[0] = IDiamondCut.FacetCut(address(registryFacet),        IDiamondCut.FacetCutAction.Add, regSels);
        cut[1] = IDiamondCut.FacetCut(address(factoryFacet),         IDiamondCut.FacetCutAction.Add, facSels);
        cut[2] = IDiamondCut.FacetCut(address(diamondCutFacet),      IDiamondCut.FacetCutAction.Add, cutSels);
        cut[3] = IDiamondCut.FacetCut(address(diamondLoupeFacet),    IDiamondCut.FacetCutAction.Add, loupeSels);
        cut[4] = IDiamondCut.FacetCut(address(ownershipFacet),       IDiamondCut.FacetCutAction.Add, ownSels);
        cut[5] = IDiamondCut.FacetCut(address(arbiterRegistryFacet), IDiamondCut.FacetCutAction.Add, arbSels);
        cut[6] = IDiamondCut.FacetCut(address(reputationFacet),      IDiamondCut.FacetCutAction.Add, repSels);

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

        _claimByArbiter(a);
    }

    /// Клейм спора арбитром через настоящий commit-reveal. Вынесен из
    /// _activateAndDispute, потому что тестам платного вызова нужно поднять
    /// спор, доплатить и только потом заклеймить.
    function _claimByArbiter(Agreement a) internal {
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

    /// Ни FeePaid, ни FeeSkipped не должны сработать — для случая fee == 0,
    /// где блок `if (fee > 0)` пропускается целиком: не пытались зачислить,
    /// значит нечего и пропускать. FeeSkipped здесь была бы ЛОЖНОЙ: она
    /// означает «зачисление провалилось», а не «зачисления не было вовсе».
    function _assertNoDisputeFeeEventEmitted() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 paidSig    = Agreement.DisputeFeePaid.selector;
        bytes32 skippedSig = Agreement.DisputeFeeSkipped.selector;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 0) continue;
            assertTrue(logs[i].topics[0] != paidSig, "DisputeFeePaid must not fire when there is nothing to take");
            assertTrue(logs[i].topics[0] != skippedSig, "DisputeFeeSkipped must not fire when nothing was ever attempted");
        }
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

    /// Инвариант, на который опирается снятая рантайм-ветка `fee < pot`
    /// (Agreement.sol, комментарий над `if (fee > 0)` в resolveDispute):
    /// при BPS < 10_000 (100%) floor(pot * BPS / 10_000) < pot для любого
    /// pot >= 1, а DISPUTE_FEE_CAP только уменьшает fee. Закреплено здесь
    /// статически вместо недостижимой рантайм-проверки, которую нельзя
    /// протестировать никаким входом.
    function testDisputeFeeBpsIsBelowOneHundredPercent() public {
        Agreement impl = new Agreement();
        assertLt(impl.DISPUTE_FEE_BPS(), 10_000, "BPS must stay under 100% or the removed fee<pot branch becomes reachable");
    }

    /// Котёл настолько мал (33 юнита), что 3% округляются в ноль по floor —
    /// не минимум, а честный ноль: floor(33 * 300 / 10_000) = 0. Без гейта
    /// `fee > 0` это позвало бы creditDisputeFee(0), поймало бы ZeroAmount()
    /// в try/catch и эмитило бы ЛОЖНОЕ DisputeFeeSkipped(0) там, где на самом
    /// деле ничего не пропускалось — попытки зачислить не было вовсе.
    function testDisputeFeeFloorsToZeroSkipsBothEvents() public {
        Agreement a = Agreement(_createFundedAgreement(33));
        assertEq(a.disputeFee(), 0, "3% of 33 units floors to zero");
        _activateAndDispute(a);

        uint256 clientBefore = usdc.balanceOf(client);

        vm.recordLogs();
        _submitAndFinalize(a, true);
        _assertNoDisputeFeeEventEmitted();

        assertEq(uint8(a.status()), uint8(Agreement.Status.RESOLVED), "the dispute must still close");
        assertEq(usdc.balanceOf(client) - clientBefore, 33, "no fee taken, winner gets the whole (tiny) pot");
        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterReward(arbiterAddr), 0, "nothing credited");
        assertEq(ArbiterRegistryFacet(address(diamond)).getTreasurySlice(), 0, "nothing credited");
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

    // ============================================================
    //  triggerArbiterTimeout() — котёл пополам, если за спор никто не брался
    // ============================================================

    /// Никто не взялся за спор — котёл пополам. Иначе мелкая сделка была бы
    /// бесплатной лотереей для клиента: арбитр за $1.20 не возьмётся, таймаут
    /// вернул бы клиенту всё, и работа доставалась бы даром.
    function testTimeoutWithoutClaimSplitsThePot() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();
        // Отклик второй стороны: пополам теперь означает «оба явились».
        vm.prank(executor);
        a.respondToDispute();
        assertEq(a.arbiter(), address(0), "setup: nobody claimed");

        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        uint256 cBefore = usdc.balanceOf(client);
        uint256 eBefore = usdc.balanceOf(executor);

        vm.prank(client);
        a.triggerArbiterTimeout();

        assertEq(usdc.balanceOf(client) - cBefore,   100_000_000, "half to client");
        assertEq(usdc.balanceOf(executor) - eBefore, 100_000_000, "half to executor");
        assertEq(usdc.balanceOf(address(a)), 0, "the agreement must be emptied");
    }

    /// Арбитр взялся и не довёл — прежнее поведение: клиенту целиком, арбитра
    /// наказать. Пополам здесь нельзя: затягивание стало бы стратегией, и
    /// жулику на крупной сделке хватило бы просто ничего не делать.
    function testTimeoutAfterClaimStillRefundsTheClient() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        _activateAndDispute(a);
        assertTrue(a.arbiter() != address(0), "setup: somebody claimed");

        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        uint256 cBefore = usdc.balanceOf(client);
        uint256 eBefore = usdc.balanceOf(executor);

        vm.prank(client);
        a.triggerArbiterTimeout();

        assertEq(usdc.balanceOf(client) - cBefore,   200_000_000, "whole pot to client");
        assertEq(usdc.balanceOf(executor) - eBefore, 0,           "executor gets nothing");
    }

    /// Сбор на путях таймаута не берётся ни в одном случае: вердикта нет,
    /// работа не сделана, платить некому.
    function testTimeoutTakesNoFee() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();
        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        vm.prank(client);
        a.triggerArbiterTimeout();

        assertEq(ArbiterRegistryFacet(address(diamond)).getTreasurySlice(), 0, "no treasury slice");
        assertEq(usdc.balanceOf(address(a)), 0, "the agreement must be emptied");
    }

    /// Нечётный котёл: ни один юнит не должен осесть в контракте. 33 юнита →
    /// 16 исполнителю, 17 клиенту (остаток тому, чьи это были деньги).
    function testTimeoutSplitLosesNoUnitOnAnOddPot() public {
        Agreement a = Agreement(_createFundedAgreement(33));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();
        // Отклик второй стороны: пополам теперь означает «оба явились».
        vm.prank(executor);
        a.respondToDispute();
        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        uint256 cBefore = usdc.balanceOf(client);
        uint256 eBefore = usdc.balanceOf(executor);

        vm.prank(client);
        a.triggerArbiterTimeout();

        assertEq(usdc.balanceOf(executor) - eBefore, 16, "floor half to executor");
        assertEq(usdc.balanceOf(client)   - cBefore, 17, "remainder to the client");
        assertEq(usdc.balanceOf(address(a)), 0, "not one unit may be stranded");
    }

    /// Непринятые extras — не часть спорной суммы: исполнитель на них не
    /// соглашался. Они возвращаются клиенту ЦЕЛИКОМ и делению не подлежат.
    function testPendingExtrasReturnWholeAndAreNotSplit() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();

        usdc.mint(client, 50_000_000);
        vm.startPrank(client);
        usdc.approve(address(a), 50_000_000);
        a.proposeExtra(50_000_000, "extra work");
        a.raiseDispute();
        vm.stopPrank();
        // Отклик второй стороны: пополам теперь означает «оба явились».
        vm.prank(executor);
        a.respondToDispute();

        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        uint256 cBefore = usdc.balanceOf(client);
        uint256 eBefore = usdc.balanceOf(executor);

        vm.prank(client);
        a.triggerArbiterTimeout();

        // 50 назад целиком + половина от 200.
        assertEq(usdc.balanceOf(client) - cBefore,   150_000_000, "pending back whole plus half the pot");
        assertEq(usdc.balanceOf(executor) - eBefore, 100_000_000, "half of the pot only");
        assertEq(usdc.balanceOf(address(a)), 0, "the agreement must be emptied");
    }

    /// Л6. Исполнитель в чёрном списке USDC не должен замораживать сделку:
    /// таймаут — последний путь, после него у агримента нет ни рескью, ни
    /// второй попытки. Недоставленная половина уходит клиенту.
    function testBlockedExecutorCannotFreezeTheTimeout() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();
        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        usdc.setBlocked(executor, true);

        uint256 cBefore = usdc.balanceOf(client);

        vm.prank(client);
        a.triggerArbiterTimeout();

        assertEq(usdc.balanceOf(client) - cBefore, 200_000_000, "the undeliverable half falls back to the client");
        assertEq(usdc.balanceOf(address(a)), 0, "nothing may stay locked");
    }

    /// Л2. Поздний клейм запрещён. Вердикт после окна всё равно невозможен
    /// (submitVerdict откажет), значит такой клейм не несёт законной функции —
    /// он нужен только чтобы отменить дележ котла пополам.
    function testCannotClaimAfterTheVerdictWindow() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        bytes32 salt       = keccak256(abi.encodePacked("late-claim", address(a), block.number));
        bytes32 commitment = keccak256(abi.encodePacked(address(a), arbiterAddr, salt));
        vm.prank(arbiterAddr);
        ArbiterRegistryFacet(address(diamond)).commitDisputeClaim(commitment);
        vm.roll(block.number + 1);

        vm.prank(arbiterAddr);
        vm.expectRevert(ArbiterRegistryFacet.DisputeWindowPassed.selector);
        ArbiterRegistryFacet(address(diamond)).claimDispute(address(a), salt);
    }

    /// Тот же гейт, но проверяем деньги: попытка позднего клейма не должна
    /// превращать дележ в полный возврат клиенту.
    function testLateClaimCannotCancelTheSplit() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();
        // Отклик второй стороны: пополам теперь означает «оба явились».
        vm.prank(executor);
        a.respondToDispute();

        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        bytes32 salt       = keccak256(abi.encodePacked("late-claim-money", address(a), block.number));
        bytes32 commitment = keccak256(abi.encodePacked(address(a), arbiterAddr, salt));
        vm.prank(arbiterAddr);
        ArbiterRegistryFacet(address(diamond)).commitDisputeClaim(commitment);
        vm.roll(block.number + 1);
        vm.prank(arbiterAddr);
        try ArbiterRegistryFacet(address(diamond)).claimDispute(address(a), salt) {} catch {}

        assertEq(a.arbiter(), address(0), "a late claim must not stick");

        uint256 eBefore = usdc.balanceOf(executor);
        vm.prank(client);
        a.triggerArbiterTimeout();
        assertEq(usdc.balanceOf(executor) - eBefore, 100_000_000, "the split must survive");
    }

    // ============================================================
    //  releaseDisputeClaim() — после закрытия окна отпускать нельзя
    // ============================================================

    /// После закрытия окна отпустить спор нельзя. Вердикт там уже невозможен и
    /// перезаклеймить спор тоже нельзя — значит поздний отпуск не возвращает
    /// спор в оборот, он только решает, кому достанутся деньги.
    function testCannotReleaseAfterTheVerdictWindow() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        _activateAndDispute(a);

        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        vm.prank(arbiterAddr);
        vm.expectRevert(ArbiterRegistryFacet.DisputeWindowPassed.selector);
        ArbiterRegistryFacet(address(diamond)).releaseDisputeClaim(address(a));
    }

    /// Тот же гейт, но проверяем деньги: поздний отпуск не должен превращать
    /// полный возврат клиенту в дележ пополам.
    function testLateReleaseCannotFlipTheTimeoutToASplit() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        _activateAndDispute(a);

        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        vm.prank(arbiterAddr);
        try ArbiterRegistryFacet(address(diamond)).releaseDisputeClaim(address(a)) {} catch {}
        assertTrue(a.arbiter() != address(0), "a late release must not stick");

        uint256 cBefore = usdc.balanceOf(client);
        uint256 eBefore = usdc.balanceOf(executor);

        vm.prank(client);
        a.triggerArbiterTimeout();

        assertEq(usdc.balanceOf(client) - cBefore,   200_000_000, "whole pot still to the client");
        assertEq(usdc.balanceOf(executor) - eBefore, 0,           "the executor must gain nothing");
    }

    /// Вторая половина дыры: отпуск обнулял disputeClaims, а
    /// notifyArbiterTimeout по пустому ключу выходит молча — неявившийся арбитр
    /// уходил вообще без судейской ошибки.
    function testLateReleaseCannotDodgeTheArbiterPenalty() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        _activateAndDispute(a);

        uint256 before = ArbiterRegistryFacet(address(diamond)).getArbiterMistakeStreak(arbiterAddr);

        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);
        vm.prank(arbiterAddr);
        try ArbiterRegistryFacet(address(diamond)).releaseDisputeClaim(address(a)) {} catch {}

        vm.prank(client);
        a.triggerArbiterTimeout();

        assertEq(
            ArbiterRegistryFacet(address(diamond)).getArbiterMistakeStreak(arbiterAddr),
            before + 1,
            "the no-show must be recorded"
        );
    }

    /// Отпуск ВНУТРИ окна законен и должен работать: арбитр понял, что не
    /// потянет, и вернул спор другим. Гейт не должен этого ломать.
    function testReleaseInsideTheWindowStillWorks() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        _activateAndDispute(a);

        vm.prank(arbiterAddr);
        ArbiterRegistryFacet(address(diamond)).releaseDisputeClaim(address(a));

        assertEq(a.arbiter(), address(0), "the dispute goes back on the market");
    }

    /// Ровно последняя секунда окна — отпуск ещё законен. Граница здесь та же,
    /// что у submitVerdict и claimDispute: окно закрывается СТРОГО после
    /// disputedAt + DISPUTE_WINDOW, не в эту секунду. Без этого теста гейт из
    /// Задачи 4b можно было бы сузить на секунду (`>` → `>=`) и не заметить:
    /// мутация проходила незамеченной, пока тест не появился.
    function testReleaseOnTheLastSecondOfTheWindowStillWorks() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        _activateAndDispute(a);

        vm.warp(a.disputedAt() + a.DISPUTE_WINDOW());

        vm.prank(arbiterAddr);
        ArbiterRegistryFacet(address(diamond)).releaseDisputeClaim(address(a));

        assertEq(a.arbiter(), address(0), "the window is open through its last second");
    }

    /// Ревью Задачи 4: проверку длины ответа в trySafeTransfer не держал ни один
    /// тест — её можно было выбросить, и весь набор всё равно проходил. Токен,
    /// вернувший меньше 32 байт, без неё уронил бы abi.decode и заморозил бы
    /// весь котёл на последнем пути сделки.
    function testShortTokenReplyDoesNotFreezeTheTimeout() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();
        // Отклик второй стороны: пополам теперь означает «оба явились».
        vm.prank(executor);
        a.respondToDispute();
        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        // 1 байт вместо 32 — abi.decode на таком ревертит.
        vm.mockCall(
            address(usdc),
            abi.encodeWithSelector(bytes4(0xa9059cbb), executor, uint256(100_000_000)),
            hex"01"
        );

        uint256 cBefore = usdc.balanceOf(client);

        vm.prank(client);
        a.triggerArbiterTimeout();

        vm.clearMockedCalls();

        assertEq(usdc.balanceOf(client) - cBefore, 200_000_000, "the undeliverable half falls back to the client");
        assertEq(usdc.balanceOf(address(a)), 0, "nothing may stay locked");
    }

    // -------- ЯВКА В СПОРЕ --------

    /// Поднял спор — значит явился. Второй флаг остаётся пустым: именно он и
    /// отличает «оба изложили позицию» от «один молчал».
    function testRaiseDisputeMarksTheRaiserAsPresent() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        assertTrue(a.clientResponded(), "raiser must be marked present");
        assertFalse(a.executorResponded(), "counterparty must start silent");
    }

    /// Симметрия: спор поднимает исполнитель — флаг у него.
    function testRaiseDisputeByExecutorMarksExecutor() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(executor);
        a.raiseDispute();

        assertTrue(a.executorResponded(), "raiser must be marked present");
        assertFalse(a.clientResponded(), "counterparty must start silent");
    }

    function testRespondToDisputeMarksTheCounterparty() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        vm.prank(executor);
        a.respondToDispute();

        assertTrue(a.executorResponded(), "counterparty must be marked present");
    }

    /// Повторный отклик ревертит — иначе релеер платил бы за бесконечные вызовы.
    function testRespondToDisputeTwiceReverts() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        vm.prank(executor);
        a.respondToDispute();

        vm.prank(executor);
        vm.expectRevert(Agreement.AlreadyResponded.selector);
        a.respondToDispute();
    }

    /// Поднявший уже отмечен, поэтому его отклик тоже ревертит.
    function testRaiserCannotRespondAgain() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        vm.prank(client);
        vm.expectRevert(Agreement.AlreadyResponded.selector);
        a.respondToDispute();
    }

    function testRespondToDisputeFromStrangerReverts() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        vm.prank(address(0xBEEF));
        vm.expectRevert(Agreement.NotParty.selector);
        a.respondToDispute();
    }

    function testRespondToDisputeWithoutDisputeReverts() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();

        vm.prank(executor);
        vm.expectRevert(Agreement.NotDisputed.selector);
        a.respondToDispute();
    }

    /// Ключевой тест против фронт-раннинга. Без гейта по окну молчавшая сторона
    /// видит транзакцию таймаута в мемпуле, успевает откликнуться перед ней и
    /// превращает 25/75 обратно в 50/50 — то есть отменяет наказание уже после
    /// того, как оно наступило.
    function testRespondToDisputeAfterWindowReverts() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        vm.prank(executor);
        vm.expectRevert(Agreement.WindowAlreadyPassed.selector);
        a.respondToDispute();
    }

    /// На последней секунде окна отклик ещё принимается — граница включающая,
    /// как и у claimDispute.
    function testRespondToDisputeOnTheLastSecondWorks() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        vm.warp(block.timestamp + a.DISPUTE_WINDOW());

        vm.prank(executor);
        a.respondToDispute();
        assertTrue(a.executorResponded(), "last second of the window must still count");
    }

    /// После таймаута сделка финализирована, но resolvedAt остаётся нулём —
    /// его ставит только resolveDispute. Без проверки _finalized можно было бы
    /// «явиться» в закрытую сделку.
    function testRespondToDisputeAfterFinalizationReverts() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);
        vm.prank(client);
        a.triggerArbiterTimeout();

        vm.prank(executor);
        vm.expectRevert(Agreement.AlreadyFinalized.selector);
        a.respondToDispute();
    }

    /// Отклик разрешён и когда спор уже заклеймён: это полезный сигнал
    /// вовлечённости, а вреда нет — та ветка таймаута флаги не читает.
    function testRespondToDisputeWorksWhileClaimed() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        _activateAndDispute(a);

        vm.prank(executor);
        a.respondToDispute();
        assertTrue(a.executorResponded(), "responding must work on a claimed dispute");
    }

    function testRespondToDisputeEmitsEvent() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        vm.expectEmit(true, false, false, false, address(a));
        emit Agreement.DisputeResponded(executor);
        vm.prank(executor);
        a.respondToDispute();
    }

    // -------- ТАЙМАУТ: 25/75 ПО ЯВКЕ --------

    /// Оба явились — судить было некому, делим пополам. Это и есть настоящий
    /// смысл дележа: не «никто не заметил», а «оба изложили позицию».
    function testTimeoutSplitsInHalfWhenBothResponded() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();
        vm.prank(executor);
        a.respondToDispute();

        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        uint256 cBefore = usdc.balanceOf(client);
        uint256 eBefore = usdc.balanceOf(executor);

        vm.prank(client);
        a.triggerArbiterTimeout();

        assertEq(usdc.balanceOf(client) - cBefore,   100_000_000, "half to client");
        assertEq(usdc.balanceOf(executor) - eBefore, 100_000_000, "half to executor");
        assertEq(usdc.balanceOf(address(a)), 0, "the agreement must be emptied");
    }

    /// Молчал исполнитель — четверть ему, три четверти клиенту.
    function testTimeoutGivesQuarterToTheSilentExecutor() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        uint256 cBefore = usdc.balanceOf(client);
        uint256 eBefore = usdc.balanceOf(executor);

        vm.prank(client);
        a.triggerArbiterTimeout();

        assertEq(usdc.balanceOf(executor) - eBefore, 50_000_000,  "quarter to the silent executor");
        assertEq(usdc.balanceOf(client)   - cBefore, 150_000_000, "three quarters to the client");
        assertEq(usdc.balanceOf(address(a)), 0, "the agreement must be emptied");
    }

    /// Симметрия: молчал клиент — четверть ему, три четверти исполнителю.
    /// Без этого теста правило легко написать однобоким.
    function testTimeoutGivesQuarterToTheSilentClient() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(executor);
        a.raiseDispute();

        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        uint256 cBefore = usdc.balanceOf(client);
        uint256 eBefore = usdc.balanceOf(executor);

        vm.prank(executor);
        a.triggerArbiterTimeout();

        assertEq(usdc.balanceOf(client)   - cBefore, 50_000_000,  "quarter to the silent client");
        assertEq(usdc.balanceOf(executor) - eBefore, 150_000_000, "three quarters to the executor");
        assertEq(usdc.balanceOf(address(a)), 0, "the agreement must be emptied");
    }

    /// Остаток от деления не теряется: считаем вычитанием, и он уходит
    /// явившемуся. На котле 7 это 1 молчавшему и 6 явившемуся, а не 1 и 5.
    function testTimeoutUnansweredLosesNoUnitOnAnOddPot() public {
        Agreement a = Agreement(_createFundedAgreement(7));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        uint256 cBefore = usdc.balanceOf(client);
        uint256 eBefore = usdc.balanceOf(executor);

        vm.prank(client);
        a.triggerArbiterTimeout();

        uint256 toExecutor = usdc.balanceOf(executor) - eBefore;
        uint256 toClient   = usdc.balanceOf(client)   - cBefore;

        assertEq(toExecutor, 1, "floor(7/4) to the silent executor");
        assertEq(toClient,   6, "remainder to the responder");
        assertEq(toExecutor + toClient, 7, "not a single unit may vanish");
        assertEq(usdc.balanceOf(address(a)), 0, "the agreement must be emptied");
    }

    /// Исполнитель в чёрном списке USDC и он же молчал: его четверть не
    /// доставлена, уходит клиенту, транзакция доводится до конца. Иначе таймаут
    /// заморозил бы весь котёл — а после него у сделки нет ни второй попытки,
    /// ни рескью-функции.
    function testBlockedSilentExecutorDoesNotFreezeTheTimeout() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        usdc.setBlocked(executor, true);
        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        uint256 cBefore = usdc.balanceOf(client);

        // Событие несёт executorPaid, а не toExecutor: причитались 50 USDC,
        // дошёл ноль. Без этой проверки подмена одной переменной на другую
        // прошла бы мимо балансовых утверждений выше — они смотрят только на
        // клиента, которому недоставленное и так упало.
        vm.expectEmit(true, false, false, true, address(a));
        emit Agreement.DisputeUnanswered(client, 200_000_000, 0);
        vm.prank(client);
        a.triggerArbiterTimeout();

        assertEq(usdc.balanceOf(client) - cBefore, 200_000_000, "undelivered share falls to the client");
        assertEq(usdc.balanceOf(address(a)), 0, "the agreement must be emptied");
    }

    /// Тот же чёрный список, но исполнитель явился и ему причитались три
    /// четверти: недоставленное всё равно уходит клиенту целиком.
    function testBlockedRespondingExecutorDoesNotFreezeTheTimeout() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(executor);
        a.raiseDispute();

        usdc.setBlocked(executor, true);
        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        uint256 cBefore = usdc.balanceOf(client);

        // Та же проверка на второй ветке (молчал клиент, аргументы выписаны в
        // ДРУГОМ порядке): явившийся исполнитель заблокирован, ему причитались
        // 150 USDC, дошёл ноль — и в событии обязан стоять ноль.
        vm.expectEmit(true, false, false, true, address(a));
        emit Agreement.DisputeUnanswered(executor, 0, 200_000_000);
        vm.prank(executor);
        a.triggerArbiterTimeout();

        assertEq(usdc.balanceOf(client) - cBefore, 200_000_000, "undelivered share falls to the client");
        assertEq(usdc.balanceOf(address(a)), 0, "the agreement must be emptied");
    }

    /// Событие несёт переведённые суммы, а не задуманные — иначе интерфейс
    /// напечатает цифру, которой на кошелёк не пришло.
    function testTimeoutUnansweredEmitsTransferredAmounts() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        vm.expectEmit(true, false, false, true, address(a));
        emit Agreement.DisputeUnanswered(client, 150_000_000, 50_000_000);
        vm.prank(client);
        a.triggerArbiterTimeout();
    }

    /// Та же полезная нагрузка на ЗЕРКАЛЬНОЙ ветке — молчал клиент. Аргументы
    /// там выписаны руками во второй раз и в другом порядке: единственное место
    /// в контракте, где одно событие собирается дважды. Балансовые тесты
    /// перестановку `toResponder`/`toSilent` не заметят вовсе (деньги уходят
    /// теми же переводами), а декодируется событие позиционно — в поля
    /// сабграфа и в суммы уведомления. Перестановка напечатала бы четверть
    /// молчавшего как долю явившегося.
    function testTimeoutUnansweredEmitsResponderFirstWhenTheClientWasSilent() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(executor);
        a.raiseDispute();

        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        // responder = исполнитель, ему 150 (три четверти), молчавшему клиенту 50.
        vm.expectEmit(true, false, false, true, address(a));
        emit Agreement.DisputeUnanswered(executor, 150_000_000, 50_000_000);
        vm.prank(executor);
        a.triggerArbiterTimeout();
    }

    /// Дележ пополам: событие тоже несёт переведённые суммы, и до сих пор его не
    /// проверял ни один тест — только балансы. Порядок аргументов здесь
    /// обратный аргументам `DisputeUnanswered` (toClient первым), так что
    /// перепутать их между двумя ветками ничто не мешало.
    function testTimeoutSplitEmitsTransferredAmounts() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_001));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();
        vm.prank(executor);
        a.respondToDispute();

        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        // Нечётный котёл намеренно: floor(pot/2) исполнителю, остаток клиенту —
        // на равных суммах перестановка аргументов была бы невидима.
        vm.expectEmit(false, false, false, true, address(a));
        emit Agreement.DisputeSplitNoVerdict(100_000_001, 100_000_000);
        vm.prank(client);
        a.triggerArbiterTimeout();
    }

    /// Заклеймленный спор флаги явки не читает: там вина арбитра, и весь котёл
    /// уходит клиенту независимо от того, кто отзывался.
    function testTimeoutAfterClaimIgnoresResponseFlags() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        _activateAndDispute(a);
        vm.prank(executor);
        a.respondToDispute();

        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        uint256 cBefore = usdc.balanceOf(client);
        uint256 eBefore = usdc.balanceOf(executor);

        vm.prank(client);
        a.triggerArbiterTimeout();

        assertEq(usdc.balanceOf(client) - cBefore, 200_000_000, "whole pot to the client");
        assertEq(usdc.balanceOf(executor) - eBefore, 0, "executor gets nothing on arbiter fault");
    }

    // -------- ПЛАТНЫЙ ВЫЗОВ: ПОРОГ И КОТИРОВКА --------

    /// Порог по умолчанию — 10 USDC. Он и определяет, с какой суммы сделки
    /// услуга вообще имеет смысл.
    function testArbiterFloorDefaultsToTen() public view {
        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterFloor(), 10_000_000, "default floor is $10");
    }

    function testSetArbiterFloorOnlyOwner() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(ArbiterRegistryFacet.NotOwner.selector);
        ArbiterRegistryFacet(address(diamond)).setArbiterFloor(15_000_000);
    }

    function testSetArbiterFloorChangesQuote() public {
        Agreement a = Agreement(_createFundedAgreement(100_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        uint256 before_ = ArbiterRegistryFacet(address(diamond)).quoteDisputeTopUp(address(a));
        ArbiterRegistryFacet(address(diamond)).setArbiterFloor(20_000_000);
        uint256 after_ = ArbiterRegistryFacet(address(diamond)).quoteDisputeTopUp(address(a));

        assertEq(after_ - before_, 10_000_000, "raising the floor by $10 raises the top-up by $10");
    }

    /// Котёл $100: сбор 3% = $3, арбитру 80% = $2.40, до $10 не хватает $7.60.
    function testQuoteTopUpOnSmallPot() public {
        Agreement a = Agreement(_createFundedAgreement(100_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        assertEq(ArbiterRegistryFacet(address(diamond)).quoteDisputeTopUp(address(a)), 7_600_000, "top-up to reach $10");
    }

    /// Котёл достаточно велик — арбитр получает $10 своими силами, доплата ноль.
    /// $10 / 0.024 = $416.67, поэтому на $420 доплата уже не нужна.
    function testQuoteTopUpIsZeroOnLargePot() public {
        Agreement a = Agreement(_createFundedAgreement(420_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        assertEq(ArbiterRegistryFacet(address(diamond)).quoteDisputeTopUp(address(a)), 0, "big pot pays the arbiter by itself");
    }

    /// Котировка берёт сбор У СДЕЛКИ, а не пересчитывает его. Числа подобраны
    /// так, чтобы потолок сбора был решающим: на котле $30 000 верная
    /// реализация видит capped fee $500 → арбитру $400 → до порога $450 не
    /// хватает $50. Реализация, которая посчитала бы 3% сама и забыла потолок,
    /// увидела бы $900 → арбитру $720 → порог перекрыт → доплата ноль.
    /// Разница 50_000_000 против 0 и есть то, что этот тест стережёт.
    function testQuoteUsesAgreementFeeIncludingCap() public {
        Agreement a = Agreement(_createFundedAgreement(30_000_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        ArbiterRegistryFacet(address(diamond)).setArbiterFloor(450_000_000);

        assertEq(a.disputeFee(), 500_000_000, "setup: fee is capped at $500");
        assertEq(
            ArbiterRegistryFacet(address(diamond)).quoteDisputeTopUp(address(a)),
            50_000_000,
            "top-up must be computed from the CAPPED fee, not from raw 3%"
        );
    }

    function testQuoteRevertsIfNotDisputed() public {
        Agreement a = Agreement(_createFundedAgreement(100_000_000));
        vm.prank(executor);
        a.activate();

        vm.expectRevert(ArbiterRegistryFacet.NotDisputed.selector);
        ArbiterRegistryFacet(address(diamond)).quoteDisputeTopUp(address(a));
    }

    // -------- ПЛАТНЫЙ ВЫЗОВ: ОПЛАТА И ВОЗВРАТ --------

    function _disputedAgreement(uint256 dealAmount) internal returns (Agreement a) {
        a = Agreement(_createFundedAgreement(dealAmount));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();
    }

    function testFundDisputePullsExactQuote() public {
        Agreement a = _disputedAgreement(100_000_000);
        uint256 need = ArbiterRegistryFacet(address(diamond)).quoteDisputeTopUp(address(a));

        usdc.mint(client, need);
        vm.startPrank(client);
        usdc.approve(address(diamond), need);
        uint256 before_ = usdc.balanceOf(client);
        ArbiterRegistryFacet(address(diamond)).fundDispute(address(a));
        vm.stopPrank();

        assertEq(before_ - usdc.balanceOf(client), need, "exactly the quoted amount is pulled");
        assertEq(ArbiterRegistryFacet(address(diamond)).getDisputeBounty(address(a)), need, "bounty recorded");
    }

    function testFundDisputeFromStrangerReverts() public {
        Agreement a = _disputedAgreement(100_000_000);
        vm.prank(address(0xBEEF));
        vm.expectRevert(ArbiterRegistryFacet.NotParty.selector);
        ArbiterRegistryFacet(address(diamond)).fundDispute(address(a));
    }

    function testFundDisputeTwiceReverts() public {
        Agreement a = _disputedAgreement(100_000_000);
        uint256 need = ArbiterRegistryFacet(address(diamond)).quoteDisputeTopUp(address(a));
        usdc.mint(client, need * 2);
        vm.startPrank(client);
        usdc.approve(address(diamond), need * 2);
        ArbiterRegistryFacet(address(diamond)).fundDispute(address(a));
        vm.expectRevert(ArbiterRegistryFacet.BountyAlreadyFunded.selector);
        ArbiterRegistryFacet(address(diamond)).fundDispute(address(a));
        vm.stopPrank();
    }

    /// На крупном котле доплата не нужна — платить нечего, и функция это говорит,
    /// а не принимает деньги молча.
    function testFundDisputeRevertsWhenTopUpIsZero() public {
        Agreement a = _disputedAgreement(420_000_000);
        vm.prank(client);
        vm.expectRevert(ArbiterRegistryFacet.TopUpNotNeeded.selector);
        ArbiterRegistryFacet(address(diamond)).fundDispute(address(a));
    }

    /// После клейма приманка уже отработала: арбитр взялся, платить незачем.
    function testFundDisputeAfterClaimReverts() public {
        Agreement a = Agreement(_createFundedAgreement(100_000_000));
        _activateAndDispute(a);

        vm.prank(client);
        vm.expectRevert(ArbiterRegistryFacet.DisputeAlreadyClaimed.selector);
        ArbiterRegistryFacet(address(diamond)).fundDispute(address(a));
    }

    /// Вердикта не случилось — деньги возвращаются целиком тому, кто внёс.
    function testBountyRefundedOnTimeoutWithoutVerdict() public {
        Agreement a = _disputedAgreement(100_000_000);
        uint256 need = ArbiterRegistryFacet(address(diamond)).quoteDisputeTopUp(address(a));
        usdc.mint(client, need);
        vm.startPrank(client);
        usdc.approve(address(diamond), need);
        ArbiterRegistryFacet(address(diamond)).fundDispute(address(a));
        vm.stopPrank();

        vm.prank(executor);
        a.respondToDispute();
        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        uint256 before_ = usdc.balanceOf(client);
        vm.prank(client);
        a.triggerArbiterTimeout();

        assertEq(usdc.balanceOf(client) - before_ - 50_000_000, need, "bounty came back on top of the split half");
        assertEq(ArbiterRegistryFacet(address(diamond)).getDisputeBounty(address(a)), 0, "bounty cleared");
    }

    /// Возврат ровно один раз: повторный clearDisputeClaim не платит второй раз.
    function testBountyRefundHappensOnlyOnce() public {
        Agreement a = _disputedAgreement(100_000_000);
        uint256 need = ArbiterRegistryFacet(address(diamond)).quoteDisputeTopUp(address(a));
        usdc.mint(client, need);
        vm.startPrank(client);
        usdc.approve(address(diamond), need);
        ArbiterRegistryFacet(address(diamond)).fundDispute(address(a));
        vm.stopPrank();

        vm.prank(executor);
        a.respondToDispute();
        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);
        vm.prank(client);
        a.triggerArbiterTimeout();

        uint256 after1 = usdc.balanceOf(client);
        vm.prank(address(a));
        ArbiterRegistryFacet(address(diamond)).clearDisputeClaim(address(a));
        assertEq(usdc.balanceOf(client), after1, "second clear pays nothing");
    }

    /// Плательщик в чёрном списке USDC не должен ломать снятие клейма.
    /// Agreement зовёт clearDisputeClaim внутри проглатывающего catch, поэтому
    /// жёсткий возврат утащил бы за собой openClaimCount и запер бы арбитра.
    ///
    /// Блокируем ИСПОЛНИТЕЛЯ, не клиента, и он же вносит доплату. На каждой
    /// ветке triggerArbiterTimeout доля клиента уходит жёстким
    /// usdc.safeTransfer (Agreement.sol:917/920/923/946/962) — заблокированный
    /// клиент ронял бы саму триггер-транзакцию раньше, чем дело дошло бы до
    /// clearDisputeClaim, и тест проверял бы не то. Доля исполнителя, наоборот,
    /// идёт мягким trySafeTransfer (Agreement.sol:942) — единственный путь
    /// добраться до clearDisputeClaim с заблокированным адресом на кону.
    function testBlacklistedPayerDoesNotBreakClaimClearing() public {
        Agreement a = _disputedAgreement(100_000_000);
        uint256 need = ArbiterRegistryFacet(address(diamond)).quoteDisputeTopUp(address(a));
        usdc.mint(executor, need);
        vm.startPrank(executor);
        usdc.approve(address(diamond), need);
        ArbiterRegistryFacet(address(diamond)).fundDispute(address(a));
        a.respondToDispute();
        vm.stopPrank();

        usdc.setBlocked(executor, true);
        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        vm.prank(client);
        a.triggerArbiterTimeout();

        assertEq(ArbiterRegistryFacet(address(diamond)).getDisputeBounty(address(a)), 0, "bounty left the dispute");
        assertEq(ArbiterRegistryFacet(address(diamond)).getRefundableBounty(executor), need, "and became claimable instead");

        usdc.setBlocked(executor, false);
        uint256 before_ = usdc.balanceOf(executor);
        vm.prank(executor);
        ArbiterRegistryFacet(address(diamond)).withdrawDisputeBounty();
        assertEq(usdc.balanceOf(executor) - before_, need, "payer got it once unblocked");
    }

    /// Нечего выводить — не молчаливый no-op, а явный откат.
    function testWithdrawDisputeBountyRevertsIfNothingOwed() public {
        vm.prank(executor);
        vm.expectRevert(ArbiterRegistryFacet.NothingToPush.selector);
        ArbiterRegistryFacet(address(diamond)).withdrawDisputeBounty();
    }

    /// Короткий (1..31 байт) ответ токена не должен превращать мягкий возврат
    /// в жёсткий: abi.decode без проверки длины паникует сам на таком ответе,
    /// и тогда откат утащил бы за собой снятие клейма — та же ловушка, что и
    /// с чёрным списком выше, только с другим триггером на стороне токена.
    ///
    /// Мок вызова, а не адреса — тот же приём, что и
    /// testShortTokenReplyDoesNotFreezeTheTimeout (mockCall на конкретный
    /// вызов transfer, не смена всего контракта usdc).
    function testShortTokenReplyDoesNotBreakClaimClearing() public {
        Agreement a = _disputedAgreement(100_000_000);
        uint256 need = ArbiterRegistryFacet(address(diamond)).quoteDisputeTopUp(address(a));
        usdc.mint(executor, need);
        vm.startPrank(executor);
        usdc.approve(address(diamond), need);
        ArbiterRegistryFacet(address(diamond)).fundDispute(address(a));
        a.respondToDispute();
        vm.stopPrank();

        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        // 1 байт вместо 32 — abi.decode на таком ревертит без проверки длины.
        vm.mockCall(
            address(usdc),
            abi.encodeWithSelector(bytes4(0xa9059cbb), executor, need),
            hex"01"
        );

        vm.prank(client);
        a.triggerArbiterTimeout();

        vm.clearMockedCalls();

        assertEq(ArbiterRegistryFacet(address(diamond)).getDisputeBounty(address(a)), 0, "bounty left the dispute");
        assertEq(ArbiterRegistryFacet(address(diamond)).getRefundableBounty(executor), need, "and became claimable instead");
    }

    // -------- ПЛАТНЫЙ ВЫЗОВ: ВЫПЛАТА --------

    /// Вердикт состоялся — доплата достаётся арбитру, а не возвращается
    /// плательщику. clearDisputeClaim (вызванный из resolveDispute внутри
    /// той же finalizeVerdict) видит disputeBounty уже обнулённым и молчит.
    function testBountyGoesToArbiterOnVerdict() public {
        Agreement a = Agreement(_createFundedAgreement(100_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        uint256 need = ArbiterRegistryFacet(address(diamond)).quoteDisputeTopUp(address(a));
        usdc.mint(client, need);
        vm.startPrank(client);
        usdc.approve(address(diamond), need);
        ArbiterRegistryFacet(address(diamond)).fundDispute(address(a));
        vm.stopPrank();

        _claimByArbiter(a);
        _submitAndFinalize(a, true);

        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterReward(arbiterAddr) >= need, true, "arbiter got at least the bounty");
        assertEq(ArbiterRegistryFacet(address(diamond)).getDisputeBounty(address(a)), 0, "bounty cleared after payout");
    }

    /// Вердикт отменён owner'ом до финализации — доплата не должна достаться
    /// арбитру: 80% сбора при overturn и так целиком уходят в казну
    /// (creditDisputeFee), и доплата не может быть исключением. Деньги
    /// возвращаются плательщику через claimable (refundableBounty), а не
    /// прямым переводом — жёсткий transfer здесь мог бы уронить всю
    /// финализацию.
    function testOverturnedVerdictRefundsBountyToPayer() public {
        Agreement a = Agreement(_createFundedAgreement(100_000_000));
        vm.prank(executor);
        a.activate();
        vm.prank(client);
        a.raiseDispute();

        uint256 need = ArbiterRegistryFacet(address(diamond)).quoteDisputeTopUp(address(a));
        usdc.mint(client, need);
        vm.startPrank(client);
        usdc.approve(address(diamond), need);
        ArbiterRegistryFacet(address(diamond)).fundDispute(address(a));
        vm.stopPrank();

        _claimByArbiter(a);

        vm.prank(arbiterAddr);
        ArbiterRegistryFacet(address(diamond)).submitVerdict(address(a), true);

        // owner (== address(this) в этом сетапе) отменяет вердикт до финализации.
        ArbiterRegistryFacet(address(diamond)).overturnVerdict(address(a), false);

        vm.warp(block.timestamp + 24 hours + 1); // FINALIZE_DELAY
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(address(a));

        assertEq(ArbiterRegistryFacet(address(diamond)).getRefundableBounty(client), need, "bounty went to the payer as claimable");
        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterReward(arbiterAddr), 0, "overturned arbiter got nothing, including the bounty");
        assertEq(ArbiterRegistryFacet(address(diamond)).getDisputeBounty(address(a)), 0, "bounty left the dispute either way");
    }

    /// Плоская выплата из банка больше не начисляется: банк после финализации
    /// не изменился. Раньше она складывалась с 80% сбора, а с доплатой было бы
    /// три источника разом.
    ///
    /// rewardPerDispute — мёртвое поле (ArbiterRegistryFacet.sol), и
    /// setRewardPerDispute теперь безусловно ревертит (RewardPathRetired) —
    /// штатно поднять поле выше нуля больше нельзя. Без обхода этот тест
    /// проходил бы и на старом, неисправленном коде: дефолт поля и так 0, а
    /// снятый блок был заперт условием `rewardPerDispute > 0`. Пишем в поле
    /// напрямую через stdstore (в обход ревертящего сеттера — имитируем
    /// значение, которое могло остаться от деплоя до 31 июля, поле
    /// append-only и никогда не обнулялось) и наполняем банк fundVault на ту
    /// же сумму, чтобы у старого условия (`vaultBalance >= rewardPerDispute`)
    /// была возможность сработать. Так тест ловит именно регрессию, а не
    /// проходит по умолчанию.
    function testVaultNoLongerPaysPerDispute() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        _activateAndDispute(a);

        stdstore
            .target(address(diamond))
            .sig(ArbiterRegistryFacet.getRewardPerDispute.selector)
            .checked_write(5_000_000);

        usdc.mint(owner, 5_000_000);
        vm.startPrank(owner);
        usdc.approve(address(diamond), 5_000_000);
        ArbiterRegistryFacet(address(diamond)).fundVault(5_000_000);
        vm.stopPrank();

        uint256 vaultBefore = ArbiterRegistryFacet(address(diamond)).getVaultBalance();
        _submitAndFinalize(a, true);
        assertEq(ArbiterRegistryFacet(address(diamond)).getVaultBalance(), vaultBefore, "vault untouched by a resolved dispute");
    }

    /// setRewardPerDispute больше не пишет ничего — она безусловно ревертит,
    /// каким бы ни был вызывающий. onlyOwner больше не защищает вход, потому
    /// что входа для защиты не осталось: заменён на error RewardPathRetired,
    /// pure-функция.
    function testSetRewardPerDisputeAlwaysReverts() public {
        vm.expectRevert(ArbiterRegistryFacet.RewardPathRetired.selector);
        ArbiterRegistryFacet(address(diamond)).setRewardPerDispute(5_000_000);

        vm.prank(address(0xBEEF));
        vm.expectRevert(ArbiterRegistryFacet.RewardPathRetired.selector);
        ArbiterRegistryFacet(address(diamond)).setRewardPerDispute(1);
    }

    // -------- СЧЁТЧИК СПОРОВ БЕЗ ВЕРДИКТА --------

    function testUnresolvedCounterIncrementsBothOnSplit() public {
        Agreement a = _disputedAgreement(100_000_000);
        vm.prank(executor);
        a.respondToDispute();
        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);
        vm.prank(client);
        a.triggerArbiterTimeout();

        assertEq(ReputationFacet(address(diamond)).getUnresolvedDisputes(client), 1, "client counted");
        assertEq(ReputationFacet(address(diamond)).getUnresolvedDisputes(executor), 1, "executor counted");
    }

    /// 75/25 тоже считается обоим: виноватый там очевиден, но счётчик ничего не
    /// утверждает о вине — он про то, кто систематически оказывается в спорах.
    function testUnresolvedCounterIncrementsBothOnUnanswered() public {
        Agreement a = _disputedAgreement(100_000_000);
        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);
        vm.prank(client);
        a.triggerArbiterTimeout();

        assertEq(ReputationFacet(address(diamond)).getUnresolvedDisputes(client), 1, "client counted");
        assertEq(ReputationFacet(address(diamond)).getUnresolvedDisputes(executor), 1, "executor counted");
    }

    /// Вердикт состоялся — счётчик не трогается ни у кого.
    function testUnresolvedCounterNotIncrementedAfterVerdict() public {
        Agreement a = Agreement(_createFundedAgreement(200_000_000));
        _activateAndDispute(a);
        _submitAndFinalize(a, true);

        assertEq(ReputationFacet(address(diamond)).getUnresolvedDisputes(client), 0, "verdict is not an unresolved dispute");
        assertEq(ReputationFacet(address(diamond)).getUnresolvedDisputes(executor), 0, "verdict is not an unresolved dispute");
    }

    // ============================================================
    //  ПЛАТНЫЙ ВЫЗОВ ЧЕРЕЗ НАСТОЯЩИЙ ФОРВАРДЕР (ERC-2771)
    // ============================================================
    //
    // Единственный путь, которым фронт вообще зовёт fundDispute
    // (frontend/src/lib/relay.ts → MinimalForwarder.execute → диамонд).
    // На нём msg.sender — адрес форвардера, а не человек, поэтому все
    // денежные тесты выше, гоняющие функцию прямыми вызовами под vm.prank,
    // пропустили бы проверку стороны, читающую msg.sender напрямую.
    // Образец сетапа — test/AgreementClone.t.sol:230-296.

    uint256 constant PAYER_PK    = 0xA11CE;
    uint256 constant PEER_PK     = 0xB0BB1E;
    uint256 constant OUTSIDER_PK = 0xDECAFB;

    MinimalForwarder relayForwarder;

    bytes32 constant FWD_TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data)"
    );

    /// Поднимает спор между двумя АДРЕСАМИ С КЛЮЧАМИ (глобальные client/executor
    /// сетапа — литералы 0x1/0x2, ими нельзя подписать EIP-712) и подставляет
    /// диамонду настоящий форвардер вместо заглушки 0xDEAD.
    function _forwardedDispute(uint256 dealAmount)
        internal returns (Agreement a, address payer, address peer)
    {
        payer = vm.addr(PAYER_PK);
        peer  = vm.addr(PEER_PK);

        relayForwarder = new MinimalForwarder();
        FactoryFacet(address(diamond)).setTrustedForwarder(address(relayForwarder));

        usdc.mint(payer, dealAmount * 4);
        vm.startPrank(payer);
        usdc.approve(address(diamond), type(uint256).max);
        address addr = FactoryFacet(address(diamond)).deployAgreement(
            payer, peer, address(0), dealAmount, 7, "terms", 0
        );
        usdc.approve(addr, dealAmount);
        Agreement(addr).fund();
        vm.stopPrank();

        a = Agreement(addr);
        vm.prank(peer);
        a.activate();
        vm.prank(payer);
        a.raiseDispute();
    }

    function _signFwd(uint256 pk, MinimalForwarder.ForwardRequest memory req)
        internal view returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(
            FWD_TYPEHASH, req.from, req.to, req.value, req.gas, req.nonce, keccak256(req.data)
        ));
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",
            keccak256(abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("MinimalForwarder")),
                keccak256(bytes("0.0.1")),
                block.chainid,
                address(relayForwarder)
            )),
            structHash
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// execute() не ревертит на провале внутреннего вызова — она возвращает
    /// (false, revertData), поэтому успех читается возвратом.
    function _relayToDiamond(uint256 pk, bytes memory data)
        internal returns (bool success, bytes memory retdata)
    {
        address from = vm.addr(pk);
        MinimalForwarder.ForwardRequest memory req = MinimalForwarder.ForwardRequest({
            from:  from,
            to:    address(diamond),
            value: 0,
            gas:   3_000_000,
            nonce: relayForwarder.getNonce(from),
            data:  data
        });
        return relayForwarder.execute(req, _signFwd(pk, req));
    }

    /// Главный путь фичи целиком. Проверяет три вещи, которые ломались вместе:
    /// вызов вообще проходит проверку стороны; USDC тянется с ЧЕЛОВЕКА, а не с
    /// форвардера; плательщиком записан человек — и это видно по тому, что
    /// возврат на таймауте приходит ему, а не форвардеру.
    function testFundDisputeThroughForwarderIsPaidByTheHuman() public {
        (Agreement a, address payer, address peer) = _forwardedDispute(100_000_000);

        uint256 need = ArbiterRegistryFacet(address(diamond)).quoteDisputeTopUp(address(a));
        assertGt(need, 0, "setup: the pot must need a top-up");
        usdc.mint(payer, need);
        vm.prank(payer);
        usdc.approve(address(diamond), need);

        uint256 payerBefore = usdc.balanceOf(payer);

        (bool ok, bytes memory retdata) = _relayToDiamond(
            PAYER_PK,
            abi.encodeWithSelector(ArbiterRegistryFacet.fundDispute.selector, address(a))
        );
        assertTrue(ok, string.concat("forwarded fundDispute() failed: ", vm.toString(retdata)));

        assertEq(ArbiterRegistryFacet(address(diamond)).getDisputeBounty(address(a)), need, "bounty recorded");
        assertEq(payerBefore - usdc.balanceOf(payer), need, "USDC pulled from the human, not the forwarder");
        assertEq(usdc.balanceOf(address(relayForwarder)), 0, "the forwarder must never hold the deal's money");

        // Плательщик записан человеком: возврат на таймауте приходит ему.
        // Если бы в хранилище лёг адрес форвардера, эти деньги ушли бы туда.
        vm.prank(peer);
        a.respondToDispute();
        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        uint256 beforeTimeout = usdc.balanceOf(payer);
        vm.prank(payer);
        a.triggerArbiterTimeout();

        assertEq(
            usdc.balanceOf(payer) - beforeTimeout - 50_000_000,
            need,
            "the refund went to the human payer on top of his split half"
        );
        assertEq(usdc.balanceOf(address(relayForwarder)), 0, "the forwarder got nothing back either");
    }

    /// Негативный контроль: без него тест выше прошёл бы и в мире, где
    /// _msgSender() возвращает что угодно, лишь бы совпало со стороной.
    /// Посторонний подписант через тот же форвардер должен получить NotParty.
    function testFundDisputeThroughForwarderFromStrangerIsRejected() public {
        (Agreement a, , ) = _forwardedDispute(100_000_000);

        address outsider = vm.addr(OUTSIDER_PK);
        uint256 need = ArbiterRegistryFacet(address(diamond)).quoteDisputeTopUp(address(a));
        usdc.mint(outsider, need);
        vm.prank(outsider);
        usdc.approve(address(diamond), need);

        (bool ok, bytes memory retdata) = _relayToDiamond(
            OUTSIDER_PK,
            abi.encodeWithSelector(ArbiterRegistryFacet.fundDispute.selector, address(a))
        );

        assertFalse(ok, "the diamond accepted a forwarded top-up from a non-party");
        assertEq(bytes4(retdata), ArbiterRegistryFacet.NotParty.selector, "wrong revert reason");
        assertEq(ArbiterRegistryFacet(address(diamond)).getDisputeBounty(address(a)), 0, "nothing was taken");
    }

    /// Вторая функция того же пути. Возврат через claimable случается, когда
    /// толчок не прошёл (чёрный список USDC), и забирает его человек — тоже
    /// через форвардер.
    ///
    /// Платит здесь ИСПОЛНИТЕЛЬ (peer), не клиент, и по той же причине, что и
    /// в testBlacklistedPayerDoesNotBreakClaimClearing: доля клиента уходит
    /// жёстким safeTransfer, и заблокированный клиент уронил бы саму
    /// триггер-транзакцию раньше, чем дело дошло бы до возврата доплаты.
    function testWithdrawDisputeBountyThroughForwarderPaysTheHuman() public {
        (Agreement a, address payer, address peer) = _forwardedDispute(100_000_000);

        uint256 need = ArbiterRegistryFacet(address(diamond)).quoteDisputeTopUp(address(a));
        usdc.mint(peer, need);
        vm.startPrank(peer);
        usdc.approve(address(diamond), need);
        a.respondToDispute();
        vm.stopPrank();

        (bool funded, bytes memory fundRet) = _relayToDiamond(
            PEER_PK,
            abi.encodeWithSelector(ArbiterRegistryFacet.fundDispute.selector, address(a))
        );
        assertTrue(funded, string.concat("setup: forwarded fundDispute failed: ", vm.toString(fundRet)));

        // Блокируем плательщика в USDC — мягкий возврат внутри
        // clearDisputeClaim не пройдёт и осядет в refundableBounty.
        usdc.setBlocked(peer, true);
        vm.warp(block.timestamp + a.DISPUTE_WINDOW() + 1);

        vm.prank(payer);
        a.triggerArbiterTimeout();
        usdc.setBlocked(peer, false);

        uint256 owed = ArbiterRegistryFacet(address(diamond)).getRefundableBounty(peer);
        assertEq(owed, need, "the failed push must land on the human's claimable balance");

        uint256 before_ = usdc.balanceOf(peer);
        (bool ok, bytes memory retdata) = _relayToDiamond(
            PEER_PK,
            abi.encodeWithSelector(ArbiterRegistryFacet.withdrawDisputeBounty.selector)
        );
        assertTrue(ok, string.concat("forwarded withdrawDisputeBounty() failed: ", vm.toString(retdata)));

        assertEq(usdc.balanceOf(peer) - before_, owed, "the human got his top-up back");
        assertEq(ArbiterRegistryFacet(address(diamond)).getRefundableBounty(peer), 0, "claimable cleared");
        assertEq(usdc.balanceOf(address(relayForwarder)), 0, "the forwarder must never receive the refund");
    }
}
