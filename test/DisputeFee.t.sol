// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// DisputeFee test suite.
// Доски (JobBoardFacet, ServiceBoardFacet) отказывают в создании сделки при
// нулевой комиссии региона. У прямых путей фабрики (deployAgreement,
// deployAndFund) такого гейта не было — асимметрия, которая при добавлении
// нового региона или обнулении комиссии владельцем по ошибке позволила бы
// создавать сделки бесплатно в обход досок. Этот файл проверяет, что оба
// прямых пути фабрики (deployAgreement, deployAndFund) теперь симметричны доскам.

import "forge-std/Test.sol";
import "../src/DiamondProxy.sol";
import "../src/RegistryFacet.sol";
import "../src/FactoryFacet.sol";
import "../src/AgreementDeployer.sol";
import "../src/Agreement.sol";
import "../src/facets/ArbiterRegistryFacet.sol";

// ---------- MOCK USDC ----------

contract MockUSDCDF {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
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

contract DisputeFeeTest is Test {
    DiamondProxy diamond;
    MockUSDCDF   usdc;

    address owner;
    address client;
    address executor;
    address feeRecipient;

    uint256 constant CLIENT_USDC = 1_000_000_000;

    // ============================================================
    //  SETUP
    // ============================================================
    // Скопировано из test/Extras.t.sol и вычищено: RegistryFacet и FactoryFacet
    // (deployAgreement/deployAndFund/setRegionFee/getFeeRecipient) нужны для
    // зеро-фи-гейта, ArbiterRegistryFacet (creditDisputeFee/getArbiterReward/
    // getTreasurySlice/withdrawTreasurySlice) — для приёма и разноса сбора со
    // спора. DiamondCut/Loupe и OwnershipFacet сюда не смонтированы, потому что
    // ни один тест их не вызывает.

    function setUp() public {
        owner        = address(this);
        client       = address(0x1);
        executor     = address(0x2);
        feeRecipient = address(0x4);

        usdc = new MockUSDCDF();
        usdc.mint(client, CLIENT_USDC);

        RegistryFacet registryFacet = new RegistryFacet();
        FactoryFacet  factoryFacet  = new FactoryFacet();
        ArbiterRegistryFacet arbiterFacet = new ArbiterRegistryFacet();

        // updateStatus домонтирован ради Agreement.raiseDispute()'s
        // _updateRegistry(): без него звонок молча ловится try/catch внутри
        // Agreement (эмитит RegistrySyncFailed), а activePartyPairs остаётся
        // висеть на ACTIVE — второй агримент между тем же client/executor
        // тогда бы ловил ActiveDealAlreadyExists, хотя первый уже в споре.
        bytes4[] memory regSels = new bytes4[](4);
        regSels[0] = RegistryFacet.initRegistry.selector;
        regSels[1] = RegistryFacet.register.selector;
        regSels[2] = RegistryFacet.hasActivePair.selector;
        regSels[3] = RegistryFacet.updateStatus.selector;

        bytes4[] memory facSels = new bytes4[](5);
        facSels[0] = FactoryFacet.initFactory.selector;
        facSels[1] = FactoryFacet.deployAgreement.selector;
        facSels[2] = FactoryFacet.setRegionFee.selector;
        facSels[3] = FactoryFacet.deployAndFund.selector;
        facSels[4] = FactoryFacet.getFeeRecipient.selector;

        // ArbiterRegistryFacet: сверх приёма/выдачи сбора (creditDisputeFee/
        // getArbiterReward/getTreasurySlice/withdrawTreasurySlice) домонтированы
        // addArbiter/isRegisteredArbiter/commitDisputeClaim/claimDispute/
        // submitVerdict/overturnVerdict/withdrawArbiterReward — ревью потребовало
        // реального клейма спора вместо передачи arbiter_ аргументом (такого
        // аргумента в проде не существует, см. creditDisputeFee), поэтому тесты
        // теперь доводят агримент до DISPUTED и реально клеймят его арбитром.
        bytes4[] memory arbSels = new bytes4[](11);
        arbSels[0]  = ArbiterRegistryFacet.creditDisputeFee.selector;
        arbSels[1]  = ArbiterRegistryFacet.getArbiterReward.selector;
        arbSels[2]  = ArbiterRegistryFacet.getTreasurySlice.selector;
        arbSels[3]  = ArbiterRegistryFacet.withdrawTreasurySlice.selector;
        arbSels[4]  = ArbiterRegistryFacet.addArbiter.selector;
        arbSels[5]  = ArbiterRegistryFacet.isRegisteredArbiter.selector;
        arbSels[6]  = ArbiterRegistryFacet.commitDisputeClaim.selector;
        arbSels[7]  = ArbiterRegistryFacet.claimDispute.selector;
        arbSels[8]  = ArbiterRegistryFacet.submitVerdict.selector;
        arbSels[9]  = ArbiterRegistryFacet.overturnVerdict.selector;
        arbSels[10] = ArbiterRegistryFacet.withdrawArbiterReward.selector;

        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](3);
        cut[0] = IDiamondCut.FacetCut(address(registryFacet), IDiamondCut.FacetCutAction.Add, regSels);
        cut[1] = IDiamondCut.FacetCut(address(factoryFacet),  IDiamondCut.FacetCutAction.Add, facSels);
        cut[2] = IDiamondCut.FacetCut(address(arbiterFacet),  IDiamondCut.FacetCutAction.Add, arbSels);

        diamond = new DiamondProxy(owner, cut, address(0), "");

        Agreement agreementImpl = new Agreement();
        AgreementDeployer agDeployer = new AgreementDeployer(address(diamond), address(agreementImpl));
        RegistryFacet(address(diamond)).initRegistry(address(diamond));
        FactoryFacet(address(diamond)).initFactory(
            address(usdc), feeRecipient, address(0xDEAD), address(diamond), address(agDeployer)
        );
    }

    // ============================================================
    //  ZERO REGION FEE GATE
    // ============================================================

    /// Комиссия региона обнулена владельцем по ошибке — прямой путь фабрики
    /// обязан отказать, а не создавать сделку бесплатно. В досках такой гейт
    /// уже есть (JobBoardFacet:184, ServiceBoardFacet:182), у фабрики не было.
    function testDeployAgreementRejectsZeroRegionFee() public {
        vm.prank(owner);
        FactoryFacet(address(diamond)).setRegionFee(0, 0);

        vm.startPrank(client);
        usdc.approve(address(diamond), type(uint256).max);
        vm.expectRevert(FactoryFacet.ZeroFee.selector);
        FactoryFacet(address(diamond)).deployAgreement(
            client, executor, address(0), 100_000_000, 7, "terms", 0
        );
        vm.stopPrank();
    }

    /// Ненулевая комиссия проходит — гейт не сломал штатный путь.
    function testDeployAgreementWorksWithNonZeroFee() public {
        vm.startPrank(client);
        usdc.approve(address(diamond), type(uint256).max);
        address agreement = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, address(0), 100_000_000, 7, "terms", 0
        );
        vm.stopPrank();
        assertTrue(agreement != address(0), "deal creation broke");
    }

    /// Второй прямой путь фабрики. Гейт там стоял, но его никто не держал:
    /// ревью вырезало проверку, и все 372 теста прошли молча.
    function testDeployAndFundRejectsZeroRegionFee() public {
        vm.prank(owner);
        FactoryFacet(address(diamond)).setRegionFee(0, 0);

        // Без approve тест падал бы с "Factory: fee transfer failed" даже при
        // сломанном гейте — диагностика указывала бы на перевод комиссии, хотя
        // ломался бы несвязанный перевод суммы сделки. approve здесь для
        // симметрии с соседними тестами, а не потому что до ZeroFee revert
        // дело вообще доходит до какого-либо transferFrom.
        vm.prank(client);
        usdc.approve(address(diamond), type(uint256).max);

        vm.prank(client);
        vm.expectRevert(FactoryFacet.ZeroFee.selector);
        FactoryFacet(address(diamond)).deployAndFund(
            client, executor, 100_000_000, 7, "terms", 0
        );
    }

    // ============================================================
    //  DISPUTE FEE: ACCEPT + SPLIT 80/20
    // ============================================================

    /// Только деплоит через фабрику, не фандит. Прежнее имя (_createFundedAgreement)
    /// врало — фандинга внутри никогда не было (ревью поймало).
    function _createAgreement() internal returns (address) {
        vm.startPrank(client);
        usdc.approve(address(diamond), type(uint256).max);
        address a = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, address(0), 100_000_000, 7, "terms", 0
        );
        vm.stopPrank();
        return a;
    }

    /// Доводит агримент до статуса DISPUTED, реально клеймит его арбитром через
    /// commit-reveal И подаёт вердикт — ровно то, что в проде пишет
    /// pendingVerdicts[agreement].arbiter (submitVerdict требует caller ==
    /// disputeClaims[agreement]). creditDisputeFee больше не принимает арбитра
    /// аргументом (см. комментарий над функцией в исходнике: Agreement.arbiter
    /// — всегда 0 либо сам диамонд, никогда не человек), поэтому без реального
    /// клейма+вердикта мутация «подставить address(this) вместо арбитра»
    /// проходила бы этим набором незамеченной. clientWins всегда true — сам
    /// вердикт не участвует ни в одном тесте (finalizeVerdict не вызывается),
    /// важно только что pendingVerdicts[agreement].arbiter == arb.
    function _disputeAndClaim(address agreement, address arb) internal {
        vm.prank(client);
        usdc.approve(agreement, type(uint256).max);
        vm.prank(client);
        Agreement(agreement).fund();

        vm.prank(executor);
        Agreement(agreement).activate();

        vm.prank(client);
        Agreement(agreement).raiseDispute();

        if (!ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arb)) {
            ArbiterRegistryFacet(address(diamond)).addArbiter(arb);
        }

        bytes32 salt       = keccak256(abi.encodePacked("salt", agreement, arb, block.number));
        bytes32 commitment = keccak256(abi.encodePacked(agreement, arb, salt));
        vm.prank(arb);
        ArbiterRegistryFacet(address(diamond)).commitDisputeClaim(commitment);
        vm.roll(block.number + 1);
        vm.prank(arb);
        ArbiterRegistryFacet(address(diamond)).claimDispute(agreement, salt);

        vm.prank(arb);
        ArbiterRegistryFacet(address(diamond)).submitVerdict(agreement, true);
    }

    /// Зачислить сбор может только зарегистрированный агримент. Иначе кто угодно
    /// дописывал бы себе награду вызовом с улицы.
    function testCreditDisputeFeeRejectsStranger() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(ArbiterRegistryFacet.NotRegisteredAgreement.selector);
        ArbiterRegistryFacet(address(diamond)).creditDisputeFee(6_000_000);
    }

    /// Спор никто не довёл до вердикта — зачислять некому, реверт, а не тихая
    /// потеря денег на счётчике address(0).
    function testCreditDisputeFeeRejectsWhenNoVerdictSubmitted() public {
        address agreement = _createAgreement();
        usdc.mint(agreement, 6_000_000);
        vm.startPrank(agreement);
        usdc.transfer(address(diamond), 6_000_000);
        vm.expectRevert(ArbiterRegistryFacet.NoDisputeClaimer.selector);
        ArbiterRegistryFacet(address(diamond)).creditDisputeFee(6_000_000);
        vm.stopPrank();
    }

    /// Нулевая сумма — реверт, а не начисление нулей обеим сторонам. Проверяется
    /// раньше поиска арбитра, так что не требует реального клейма.
    function testCreditDisputeFeeRejectsZeroAmount() public {
        address agreement = _createAgreement();
        vm.prank(agreement);
        vm.expectRevert(ArbiterRegistryFacet.ZeroAmount.selector);
        ArbiterRegistryFacet(address(diamond)).creditDisputeFee(0);
    }

    /// Дележ 80/20 и оба счётчика — арбитр реально клеймил спор, его адрес
    /// нигде не передаётся аргументом.
    function testCreditDisputeFeeSplitsEightyTwenty() public {
        address agreement = _createAgreement();
        address arb = address(0xA1);
        _disputeAndClaim(agreement, arb);

        // Агримент переводит сбор на диамонд, потом просит зачислить — так же,
        // как это будет делать resolveDispute.
        usdc.mint(agreement, 6_000_000);
        vm.startPrank(agreement);
        usdc.transfer(address(diamond), 6_000_000);
        ArbiterRegistryFacet(address(diamond)).creditDisputeFee(6_000_000);
        vm.stopPrank();

        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterReward(arb), 4_800_000, "arbiter 80%");
        assertEq(ArbiterRegistryFacet(address(diamond)).getTreasurySlice(),      1_200_000, "treasury 20%");
    }

    /// Доля казны считается вычитанием, поэтому на некруглой сумме ни один юнит
    /// не теряется. 1_000_003 * 8000 / 10000 = 800_002 (floor), остаток 200_001.
    function testCreditDisputeFeeLosesNoUnitOnOddAmount() public {
        address agreement = _createAgreement();
        address arb = address(0xA1);
        _disputeAndClaim(agreement, arb);

        usdc.mint(agreement, 1_000_003);
        vm.startPrank(agreement);
        usdc.transfer(address(diamond), 1_000_003);
        ArbiterRegistryFacet(address(diamond)).creditDisputeFee(1_000_003);
        vm.stopPrank();

        uint256 toArb = ArbiterRegistryFacet(address(diamond)).getArbiterReward(arb);
        uint256 toTre = ArbiterRegistryFacet(address(diamond)).getTreasurySlice();
        assertEq(toArb, 800_002, "arbiter share floors");
        assertEq(toArb + toTre, 1_000_003, "parts must sum to the whole");
    }

    /// Два зачисления подряд (разные агрименты, один и тот же арбитр, разные
    /// суммы) — оба счётчика должны СЛОЖИТЬСЯ, а не перезаписаться. Ревью
    /// заменило += на = для обеих строк и получило все 380 тестов зелёными —
    /// этот тест обязан ловить именно это.
    function testCreditDisputeFeeAccumulatesAcrossMultipleCredits() public {
        address arb = address(0xA1);

        address agreement1 = _createAgreement();
        _disputeAndClaim(agreement1, arb);
        usdc.mint(agreement1, 6_000_000);
        vm.startPrank(agreement1);
        usdc.transfer(address(diamond), 6_000_000);
        ArbiterRegistryFacet(address(diamond)).creditDisputeFee(6_000_000);
        vm.stopPrank();

        address agreement2 = _createAgreement();
        _disputeAndClaim(agreement2, arb);
        usdc.mint(agreement2, 1_000_003);
        vm.startPrank(agreement2);
        usdc.transfer(address(diamond), 1_000_003);
        ArbiterRegistryFacet(address(diamond)).creditDisputeFee(1_000_003);
        vm.stopPrank();

        // 6_000_000 -> 4_800_000/1_200_000; 1_000_003 -> 800_002/200_001.
        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterReward(arb), 4_800_000 + 800_002, "arbiter reward must accumulate");
        assertEq(ArbiterRegistryFacet(address(diamond)).getTreasurySlice(),      1_200_000 + 200_001, "treasury slice must accumulate");
    }

    /// Вердикт отменён (overturnVerdict) — арбитр ошибся, награды не будет,
    /// весь сбор идёт в казну целиком, а не в дележе 80/20.
    function testCreditDisputeFeeOverturnedSendsEntireFeeToTreasury() public {
        address agreement = _createAgreement();
        address arb = address(0xA1);
        // _disputeAndClaim уже подаёт вердикт (clientWins=true) — здесь просто
        // переворачиваем его владельцем, не подавая второй раз.
        _disputeAndClaim(agreement, arb);
        ArbiterRegistryFacet(address(diamond)).overturnVerdict(agreement, false);

        usdc.mint(agreement, 6_000_000);
        vm.startPrank(agreement);
        usdc.transfer(address(diamond), 6_000_000);
        ArbiterRegistryFacet(address(diamond)).creditDisputeFee(6_000_000);
        vm.stopPrank();

        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterReward(arb), 0, "overturned arbiter gets nothing");
        assertEq(ArbiterRegistryFacet(address(diamond)).getTreasurySlice(),      6_000_000, "treasury gets the whole fee");
    }

    /// Сквозной тест: зачисленную награду настоящий (не диамонд) арбитр реально
    /// может забрать через withdrawArbiterReward(), и USDC приходят ему на
    /// баланс. До этого теста withdrawArbiterReward() в наборе не вызывался ни
    /// разу — именно через эту щель Critical (арбитр == диамонд) прошёл бы
    /// незамеченным: событие и счётчики выглядели бы здоровыми, а забрать
    /// накопленное было бы некому.
    function testWithdrawArbiterRewardActuallyPaysTheRealArbiter() public {
        address agreement = _createAgreement();
        address arb = address(0xA1);
        _disputeAndClaim(agreement, arb);

        usdc.mint(agreement, 6_000_000);
        vm.startPrank(agreement);
        usdc.transfer(address(diamond), 6_000_000);
        ArbiterRegistryFacet(address(diamond)).creditDisputeFee(6_000_000);
        vm.stopPrank();

        uint256 before = usdc.balanceOf(arb);
        vm.prank(arb);
        ArbiterRegistryFacet(address(diamond)).withdrawArbiterReward();

        assertEq(usdc.balanceOf(arb) - before, 4_800_000, "reward must actually reach the arbiter's wallet");
        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterReward(arb), 0, "counter must be cleared");
    }

    /// Выдача доли казны — открытая: деньги всё равно уходят только на
    /// feeRecipient, поэтому право вызова ничего не решает, а открытость
    /// означает, что выплата не зависит от того, помнит ли о ней владелец.
    function testAnyoneCanPushTheTreasurySlice() public {
        address agreement = _createAgreement();
        address arb = address(0xA1);
        _disputeAndClaim(agreement, arb);

        usdc.mint(agreement, 6_000_000);
        vm.startPrank(agreement);
        usdc.transfer(address(diamond), 6_000_000);
        ArbiterRegistryFacet(address(diamond)).creditDisputeFee(6_000_000);
        vm.stopPrank();

        address recipient = FactoryFacet(address(diamond)).getFeeRecipient();
        uint256 before = usdc.balanceOf(recipient);

        vm.prank(address(0xBEEF));
        ArbiterRegistryFacet(address(diamond)).withdrawTreasurySlice();

        assertEq(usdc.balanceOf(recipient) - before, 1_200_000, "slice must reach the fee recipient");
        assertEq(ArbiterRegistryFacet(address(diamond)).getTreasurySlice(), 0, "counter must be cleared");
    }

    /// Нечего толкать — реверт, а не перевод нуля.
    function testPushTreasurySliceRevertsWhenEmpty() public {
        vm.expectRevert(ArbiterRegistryFacet.NothingToPush.selector);
        ArbiterRegistryFacet(address(diamond)).withdrawTreasurySlice();
    }
}
