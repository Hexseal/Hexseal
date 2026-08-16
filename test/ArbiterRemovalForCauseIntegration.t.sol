// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Снос по поводу — БОЕВЫМ ПУТЁМ, на настоящем даймонде.
//
// test/ArbiterRemovalForCause.t.sol разворачивает ArbiterAccountabilityFacet
// ОТДЕЛЬНО и доводит состояние до порога через vm.store — быстро, но не
// доказывает, что боевой контракт способен произвести это состояние сам.
// Круг правок 1 (ревью задачи 6, C-1) нашёл ровно такой случай: тесты со
// streak, выставленным напрямую, оставались зелёными для порога, которого
// _recordArbiterMistake никогда не оставляет позади себя — сцена жила в
// тесте и не существовала в проде.
//
// Этот файл строит ПОЛНЫЙ даймонд (все 12 боевых фасетов, билдерами самого
// DeployFull.s.sol — тем же способом, что test/DeployFullSelectors.t.sol
// использует для собственной сквозной проверки) и доводит счётчик судейских
// ошибок до порога РЕАЛЬНЫМИ overturnVerdict, через настоящий цикл
// deployAgreement → fund → activate → raiseDispute → claimDispute →
// submitVerdict → overturnVerdict (приём — test/Diamond.t.sol::_disputeAndOverturn).
//
// I-4 (круг правок 1) сюда же: выпиливание из arbiterList читается только
// через ArbiterRegistryFacet.getArbiters(), которого в лёгком стенде
// ArbiterAccountabilityFacet нет — здесь он есть, потому что это настоящий
// даймонд.
//
// Круг правок 2 (переревью, 15 августа 2026, стык C-3×M-9): test_WholeChain...
// ниже — тест 3 из требования контроллера, «связка целиком». Он и только он
// доказывает, что выход из ловушки «заработанное ДАО при нулевом преемнике»
// существует НА ДЕЛЕ: setDAOAddress называет первого преемника ПОСЛЕ того,
// как ДАО уже активна заработанным путём (не через activateDAO()), и тот же
// преемник затем реально проводит снос по поводу через removeArbiterForCause.
// Живёт здесь, а не в лёгком стенде test/ArbiterSeatingHandover.t.sol: ему
// нужны ОБА фасета на одном хранилище — setDAOAddress (ArbiterRegistryFacet)
// и removeArbiterForCause (ArbiterAccountabilityFacet).

import "forge-std/Test.sol";
import {MinimalForwarder} from "../src/MinimalForwarder.sol";
import "../src/DiamondProxy.sol";
import "../src/RegistryFacet.sol";
import "../src/FactoryFacet.sol";
import "../src/AgreementDeployer.sol";
import "../src/Agreement.sol";
import "../src/facets/JobBoardFacet.sol";
import "../src/facets/ServiceBoardFacet.sol";
import "../src/facets/ArbiterRegistryFacet.sol";
import "../src/facets/ArbiterAccountabilityFacet.sol";
import "../src/facets/DealMetadataFacet.sol";
import "../src/facets/ReputationFacet.sol";
import "../src/JobReceiptFacet.sol";
import "../script/DeployFull.s.sol";

contract MockUSDCIntegration {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "Allowance exceeded");
        require(balanceOf[from] >= amount, "Insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        allowance[from][msg.sender] -= amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

contract ArbiterRemovalForCauseIntegrationTest is Test {
    DiamondProxy diamond;
    DeployFull deploy;
    MockUSDCIntegration usdc;

    address owner;
    address feeRecipient;
    address arbiter;

    uint256 constant AMOUNT = 100 * 10 ** 6;
    uint256 constant DEADLINE = 7;
    string constant TERMS = "test terms";
    bytes32 constant DISPUTE_SALT = bytes32("removal-integration-salt");

    /// ReputationStorage.POSITION — см. src/facets/ReputationFacet.sol.
    /// uniqueActiveUsers — слот 8, добыт перебором в
    /// test/ArbiterRemovalForCause.t.sol (круг правок 1, M-9); тот же слот, тот
    /// же метод, здесь не переоткрывается.
    bytes32 constant REP_BASE = 0xa32193c5e38bd2de27c8550f156d709eafdc63aaa4290e5e27473f2ffc097400;
    uint256 constant SLOT_UNIQUE_ACTIVE_USERS = 8;

    function setUp() public {
        owner = address(this);
        feeRecipient = address(0x4);
        arbiter = address(0x3);

        usdc = new MockUSDCIntegration();
        deploy = new DeployFull();

        DiamondCutFacet cutFacet     = new DiamondCutFacet();
        DiamondLoupeFacet loupeFacet = new DiamondLoupeFacet();
        OwnershipFacet ownFacet      = new OwnershipFacet();
        RegistryFacet regFacet       = new RegistryFacet();
        FactoryFacet facFacet        = new FactoryFacet();
        JobBoardFacet jobBoard       = new JobBoardFacet();
        ServiceBoardFacet serviceBoard = new ServiceBoardFacet();
        ArbiterRegistryFacet arbiterFacet = new ArbiterRegistryFacet();
        ArbiterAccountabilityFacet accFacet = new ArbiterAccountabilityFacet();
        DealMetadataFacet metaFacet  = new DealMetadataFacet();
        JobReceiptFacet receiptFacet = new JobReceiptFacet();
        ReputationFacet repFacet     = new ReputationFacet();

        IDiamondCut.FacetCut[] memory initCuts = deploy.buildInitCuts(
            address(cutFacet), address(loupeFacet), address(ownFacet), address(regFacet), address(facFacet)
        );
        diamond = new DiamondProxy(owner, initCuts, address(0), "");

        IDiamondCut.FacetCut[] memory remainingCuts = deploy.buildRemainingCuts(
            address(jobBoard), address(serviceBoard), address(arbiterFacet), address(accFacet),
            address(metaFacet), address(receiptFacet), address(repFacet)
        );
        IDiamondCut(address(diamond)).diamondCut(remainingCuts, address(0), "");

        RegistryFacet(address(diamond)).initRegistry(address(diamond));

        Agreement agreementImpl = new Agreement();
        AgreementDeployer agDeployer = new AgreementDeployer(address(diamond), address(agreementImpl));
        FactoryFacet(address(diamond)).initFactory(
            address(usdc), feeRecipient, address(0xDEAD), address(diamond), address(agDeployer)
        );

        ArbiterRegistryFacet(address(diamond)).addArbiter(arbiter);
    }

    // ── Хелперы (перенесены из test/Diamond.t.sol с минимальными правками) ──

    function _claimDisputeAs(address agreementAddr, address arbiterAddr) internal {
        bytes32 commitment = keccak256(abi.encodePacked(agreementAddr, arbiterAddr, DISPUTE_SALT));
        vm.prank(arbiterAddr);
        ArbiterRegistryFacet(address(diamond)).commitDisputeClaim(commitment);
        vm.roll(block.number + 1);
        vm.prank(arbiterAddr);
        ArbiterRegistryFacet(address(diamond)).claimDispute(
            agreementAddr, DISPUTE_SALT, bytes32(uint256(0xB0)), bytes32(uint256(0x51))
        );
    }

    /// Один полный цикл: новая пара клиент/исполнитель (чтобы не упереться в
    /// ActiveDealExists), спор, клейм, вердикт, переворот владельцем. После
    /// каждого вызова arbiterMistakeStreak[arbiter] растёт на единицу — ЖИВЫМ
    /// путём, не vm.store.
    function _disputeAndOverturn(address cli, address exec) internal returns (address agreementAddr) {
        usdc.mint(cli, 1_000_000 * 10 ** 6);
        vm.prank(cli);
        usdc.approve(address(diamond), 10 * 10 ** 6);
        vm.prank(cli);
        agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            cli, exec, arbiter, AMOUNT, DEADLINE, TERMS, 0
        );
        vm.prank(cli);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(cli);
        Agreement(agreementAddr).fund();
        vm.prank(exec);
        Agreement(agreementAddr).activate();
        vm.prank(cli);
        Agreement(agreementAddr).raiseDispute();

        _claimDisputeAs(agreementAddr, arbiter);

        vm.prank(arbiter);
        ArbiterRegistryFacet(address(diamond)).submitVerdict(agreementAddr, true);

        ArbiterRegistryFacet(address(diamond)).overturnVerdict(agreementAddr, false);
    }

    function _setUniqueActiveUsers(uint256 n) internal {
        vm.store(address(diamond), bytes32(uint256(REP_BASE) + SLOT_UNIQUE_ACTIVE_USERS), bytes32(n));
    }

    // ── C-1: достижимость боевым путём ──

    /// MISTAKE_THRESHOLD = 2 (MAX_ARBITER_MISTAKES − 1, см. ArbiterAccountabilityFacet).
    /// Два РЕАЛЬНЫХ overturnVerdict доводят arbiterMistakeStreak до 2, arbiter
    /// остаётся зарегистрированным (демоушен срабатывает только на третьей,
    /// _recordArbiterMistake), и removeArbiterForCause(OverturnedVerdicts)
    /// обязан пройти — состояние произведено боевым контрактом, не тестовым
    /// vm.store.
    function test_OverturnedVerdictsIsReachableThroughRealPath() public {
        _disputeAndOverturn(address(0x101), address(0x102));
        _disputeAndOverturn(address(0x103), address(0x104));

        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 2,
            unicode"два реальных переворота обязаны довести счётчик до порога"
        );
        assertTrue(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"на пороге демоушен ещё не сработал — арбитр жив"
        );

        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0)
        );

        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"снос по достигнутому боевым путём поводу обязан пройти"
        );
    }

    // ── I-4: выпиливание из arbiterList ──

    function test_RemovalForCausePrunesArbiterList() public {
        address second = address(0x33);
        ArbiterRegistryFacet(address(diamond)).addArbiter(second);
        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiters().length, 2);

        _disputeAndOverturn(address(0x201), address(0x202));
        _disputeAndOverturn(address(0x203), address(0x204));

        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0)
        );

        address[] memory list = ArbiterRegistryFacet(address(diamond)).getArbiters();
        assertEq(list.length, 1, unicode"снятый обязан исчезнуть из arbiterList, не только из isArbiter");
        assertEq(list[0], second, unicode"оставшийся арбитр — тот, кого не снимали");
    }

    // ── Круг правок 2: связка целиком ──

    /// Заработанное ДАО (не через activateDAO()), нулевой преемник → владелец
    /// НАЗНАЧАЕТ преемника → тот же преемник реально проводит снос по поводу.
    /// Доказывает, что выход из ловушки «осиротевший корпус» существует на
    /// деле, а не только по тексту условия в коде: без него (мутация круга 2)
    /// setDAOAddress отказал бы владельцу тоже, и назначить было бы некому.
    function test_WholeChainEarnedDaoZeroSuccessorThenRealRemoval() public {
        _setUniqueActiveUsers(ArbiterRegistryFacet(address(diamond)).getDaoThreshold());
        assertTrue(
            ArbiterRegistryFacet(address(diamond)).isDaoActive(),
            unicode"ДАО активна заработанным путём"
        );
        assertEq(
            ArbiterRegistryFacet(address(diamond)).getDAOAddress(), address(0),
            unicode"сетап: преемника ещё нет"
        );

        address dao = address(0xDA0);
        ArbiterRegistryFacet(address(diamond)).setDAOAddress(dao);
        assertEq(ArbiterRegistryFacet(address(diamond)).getDAOAddress(), dao);

        _disputeAndOverturn(address(0x301), address(0x302));
        _disputeAndOverturn(address(0x303), address(0x304));
        assertTrue(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter));

        vm.prank(dao);
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0)
        );

        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"назначенный из осиротевшего состояния преемник реально снёс арбитра"
        );
    }

    // ── Круг правок 1 ревью задачи 7 (15 августа 2026) ──
    //
    // Important 1: предложение обязано пропадать во ВСЕХ ТРЁХ дверях выхода
    // из корпуса, не только в removeArbiterForCause. Проверяется здесь, не в
    // лёгком стенде — оба фасета обязаны делить ОДНО настоящее хранилище, и
    // resignAsArbiter/автодемоушен обязаны реально исполниться, не быть
    // симулированы vm.store.
    //
    // Important 2: resignAsArbiter обязан отказывать, пока против звонящего
    // висит живое предложение — иначе предупреждённый читает публичную
    // запись и уходит сам за одну транзакцию, унося залог целиком.

    /// Свежий арбитр без открытых претензий — чтобы resignAsArbiter не упёрся
    /// ни во что постороннее (openClaimCount, приостановку), и единственная
    /// переменная в тесте — предложение.
    function _addFreshArbiter(address who) internal {
        ArbiterRegistryFacet(address(diamond)).addArbiter(who);
    }

    function test_ResignRevertsWhileProposalLive() public {
        address who = address(0x55);
        _addFreshArbiter(who);
        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(
            who, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x")
        );

        vm.prank(who);
        vm.expectRevert(ArbiterRegistryFacet.HasLiveRemovalProposal.selector);
        ArbiterRegistryFacet(address(diamond)).resignAsArbiter();
    }

    /// Граница снизу: секунда до конца TTL — предложение ещё живо, дверь ещё
    /// заперта. Симметрично suspension'овскому test_SuspensionHoldsUntilTheLastSecond.
    function test_ResignHoldsUntilTheLastSecondOfProposal() public {
        address who = address(0x56);
        _addFreshArbiter(who);
        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(
            who, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x")
        );

        uint256 ttl = ArbiterAccountabilityFacet(address(diamond)).getProposalTTL();
        vm.warp(vm.getBlockTimestamp() + ttl - 1);

        vm.prank(who);
        vm.expectRevert(ArbiterRegistryFacet.HasLiveRemovalProposal.selector);
        ArbiterRegistryFacet(address(diamond)).resignAsArbiter();
    }

    /// Граница сверху: ровно TTL — протухло, дверь открыта. Доказывает
    /// равенство PROPOSAL_TTL_MIRROR настоящему PROPOSAL_TTL ПОВЕДЕНЧЕСКИ —
    /// вместе с предыдущим тестом это пара «за секунду до / ровно на границе»,
    /// и рассинхрон констант хотя бы на секунду уронил бы один из двух.
    function test_ResignSucceedsAfterProposalExpires() public {
        address who = address(0x57);
        _addFreshArbiter(who);
        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(
            who, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x")
        );

        uint256 ttl = ArbiterAccountabilityFacet(address(diamond)).getProposalTTL();
        vm.warp(vm.getBlockTimestamp() + ttl);

        vm.prank(who);
        ArbiterRegistryFacet(address(diamond)).resignAsArbiter();
        assertFalse(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(who));
    }

    function test_ResignSucceedsAfterProposalWithdrawn() public {
        address who = address(0x58);
        _addFreshArbiter(who);
        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(
            who, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x")
        );
        ArbiterAccountabilityFacet(address(diamond)).withdrawProposal(who);

        vm.prank(who);
        ArbiterRegistryFacet(address(diamond)).resignAsArbiter();
        assertFalse(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(who));
    }

    /// Important 1, дверь №2 (resignAsArbiter): предложение обязано исчезнуть
    /// СОВСЕМ, не просто протухнуть. Протухшую-но-не-стёртую запись отличает
    /// от стёртой только сырое чтение getRemovalProposal (hasLiveProposal
    /// отвечает false в обоих случаях) — до правки clearSeat запись пережила
    /// бы уход и висела бы `proposedAt != 0` вечно против уже отсутствующего
    /// человека, который снять её сам не может.
    function test_ResignClearsStaleProposalRecord() public {
        address who = address(0x59);
        _addFreshArbiter(who);
        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(
            who, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x")
        );

        uint256 ttl = ArbiterAccountabilityFacet(address(diamond)).getProposalTTL();
        vm.warp(vm.getBlockTimestamp() + ttl); // протухло, но пока не стёрто

        (, , uint256 proposedAtBefore, , ) =
            ArbiterAccountabilityFacet(address(diamond)).getRemovalProposal(who);
        assertTrue(proposedAtBefore != 0, unicode"сетап: протухшая запись всё ещё физически на месте");

        vm.prank(who);
        ArbiterRegistryFacet(address(diamond)).resignAsArbiter();

        (, , uint256 proposedAtAfter, , ) =
            ArbiterAccountabilityFacet(address(diamond)).getRemovalProposal(who);
        assertEq(proposedAtAfter, 0, unicode"resignAsArbiter обязан стереть запись, не только пережить протухание");
    }

    /// Important 1, дверь №3 (автодемоушен): три РЕАЛЬНЫХ переворота сносят
    /// арбитра автоматикой _recordArbiterMistake, минуя removeArbiterForCause
    /// целиком — и предложение обязано пропасть тем же путём, через clearSeat.
    function test_AutoDemotionClearsTheProposal() public {
        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(
            arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x")
        );
        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter),
            unicode"сетап: предложение живо"
        );

        _disputeAndOverturn(address(0x401), address(0x402));
        _disputeAndOverturn(address(0x403), address(0x404));
        _disputeAndOverturn(address(0x405), address(0x406)); // третий — демоушен

        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"сетап: автодемоушен сработал"
        );

        (, , uint256 proposedAtAfter, , ) =
            ArbiterAccountabilityFacet(address(diamond)).getRemovalProposal(arbiter);
        assertEq(proposedAtAfter, 0, unicode"автодемоушен обязан стереть предложение той же дорогой, что и снос");
    }

    // ============================================================
    //  КРУГ ПРАВОК 1 РЕВЬЮ ЗАДАЧИ 8 (15 августа 2026)
    //
    //  Important 1: addArbiter не смотрит историю (только !isDaoActive() и
    //  !d.isArbiter[arbiter]) — владелец возвращает снятого одной командой,
    //  это боевой путь починки ошибочного сноса, не гипотетический. Без
    //  очистки removedAt/removalReply второе обвинение против того же адреса
    //  либо навсегда остаётся без ответа (AlreadyAnswered на пустом месте),
    //  либо действующий, ещё не снятый арбитр может ответить на давно
    //  закрытое обвинение. Живёт здесь, не в лёгком стенде: addArbiter —
    //  функция ArbiterRegistryFacet, respondToRemoval — ArbiterAccountabilityFacet,
    //  обоим нужно ОДНО настоящее хранилище за одним даймондом.
    // ============================================================

    /// Cause.Collusion, не OverturnedVerdicts — снимает зависимость от
    /// streak-порога и цикла спора, единственная переменная в тесте —
    /// посадка/снос сами по себе.
    function test_ReseatingClearsRemovedAtPreventingPhantomAnswer() public {
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), address(0)
        );
        assertFalse(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter));

        // Владелец чинит ошибочный снос — реальный путь, не гипотетический.
        ArbiterRegistryFacet(address(diamond)).addArbiter(arbiter);
        assertTrue(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter));

        vm.prank(arbiter);
        vm.expectRevert(ArbiterAccountabilityFacet.NothingToAnswer.selector);
        ArbiterAccountabilityFacet(address(diamond)).respondToRemoval(keccak256("late"));
    }

    /// Симметричная половина: ответил на первый снос, вернули, сняли СНОВА —
    /// второй ответ обязан пройти, а не упереться в AlreadyAnswered от
    /// первого. Изолирует removalReply-половину clearRemovalRecord от
    /// removedAt-половины (предыдущий тест).
    function test_ReseatingAndReremovalAllowsAnsweringAgain() public {
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("first evidence"), address(0)
        );
        vm.prank(arbiter);
        ArbiterAccountabilityFacet(address(diamond)).respondToRemoval(keccak256("first answer"));
        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getRemovalReply(arbiter),
            keccak256("first answer"),
            unicode"сетап: первый ответ лёг"
        );

        ArbiterRegistryFacet(address(diamond)).addArbiter(arbiter);

        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("second evidence"), address(0)
        );

        vm.prank(arbiter);
        ArbiterAccountabilityFacet(address(diamond)).respondToRemoval(keccak256("second answer"));
        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getRemovalReply(arbiter),
            keccak256("second answer"),
            unicode"второй ответ обязан лечь поверх стёртого первого, не отревертить AlreadyAnswered"
        );
    }

    // ============================================================
    //  Minor 2 круга правок 1: автодемоушен тоже даёт право ответа
    //
    //  Решение владельца: правило звучит одной фразой — «сняли, значит
    //  можешь ответить» — вне зависимости от того, человек нажал кнопку или
    //  сработала автоматика _recordArbiterMistake. Публичная запись
    //  ArbiterDemoted вечна ровно так же, как ArbiterRemovedForCause.
    // ============================================================

    function test_AutoDemotedArbiterCanAnswer() public {
        _disputeAndOverturn(address(0x501), address(0x502));
        _disputeAndOverturn(address(0x503), address(0x504));
        _disputeAndOverturn(address(0x505), address(0x506)); // третий — демоушен

        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"сетап: автодемоушен сработал"
        );

        bytes32 reply = keccak256(unicode"меня разжаловали автоматом, вот моя версия");
        vm.prank(arbiter);
        ArbiterAccountabilityFacet(address(diamond)).respondToRemoval(reply);

        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getRemovalReply(arbiter),
            reply,
            unicode"автодемоушен тоже даёт право ответа — та же публичная запись, тот же ответ"
        );
    }

    /// п. 66, следствие второе: тем же вызовом глушился АВТОМАТ.
    ///
    /// Автодемоушен ставит ту же приостановку из того же объявления
    /// (ArbiterRegistryStorage.SUSPENSION_WINDOW) и ту же отметку removedAt,
    /// что ручной снос, — и делает это БЕЗ ЧЕЛОВЕКА. Директор, снимавший
    /// приостановку без единой проверки, выключал механизм, который специально
    /// сделали работающим сам по себе; стоило это ноль газа сверх вызова и не
    /// оставляло в записи никакого «почему».
    function test_ChiefCannotLiftAutoDemotionSuspension() public {
        address chief = address(0xC4);
        ArbiterRegistryFacet(address(diamond)).setChiefArbiter(chief);

        // Три РЕАЛЬНЫХ переворота по трём разным сделкам — автодемоушен
        // срабатывает на третьем (MAX_ARBITER_MISTAKES = 3).
        _disputeAndOverturn(address(0x661), address(0x662));
        _disputeAndOverturn(address(0x663), address(0x664));
        _disputeAndOverturn(address(0x665), address(0x666));

        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"сетап: автомат снял арбитра"
        );
        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter),
            unicode"сетап: автомат выставил то же окно, что ручной снос"
        );

        vm.prank(chief);
        vm.expectRevert(ArbiterAccountabilityFacet.RemovalSuspensionIsOwnerOnly.selector);
        ArbiterAccountabilityFacet(address(diamond)).liftSuspension(arbiter);

        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter),
            unicode"окно автомата директору не по зубам"
        );
    }

    // ============================================================
    //  КРУГ ПРАВОК 1 ревью задачи 2 (16 августа 2026)
    //
    //  Б-1: МЫ ЗАПЕРЛИ ОДНУ ДВЕРЬ, А СОСЕДНЯЯ ВЕЛА ТУДА ЖЕ.
    //
    //  liftSuspension директору отказала — а addArbiter под тем же
    //  onlyOwnerOrChief звала clearRemovalRecord(d, arbiter, true), которая
    //  стирает removedAt И suspendedUntil разом. Один вызов через дорогу давал
    //  ровно тот результат, который запретили, да вдобавок возвращал
    //  снесённого в реестр с нетронутыми клеймами.
    //
    //  Правило: отмена сноса есть зеркало сноса, а сносить директору нельзя.
    // ============================================================

    /// Прямая сторона: возврат СНЕСЁННОГО директору закрыт, и обход не
    /// состоялся — проверяется не только ярлык ошибки, но и то, что за ней
    /// ничего не произошло.
    function test_ChiefCannotReseatRemovedArbiter() public {
        address chief = address(0xC4);
        ArbiterRegistryFacet(address(diamond)).setChiefArbiter(chief);

        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256(unicode"переписка"), address(0)
        );
        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter),
            unicode"сетап: снос выставил окно C-1"
        );

        vm.prank(chief);
        vm.expectRevert(ArbiterRegistryFacet.ReseatingRemovedIsOwnerOnly.selector);
        ArbiterRegistryFacet(address(diamond)).addArbiter(arbiter);

        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter),
            unicode"окно на месте — обходной дверью его тоже не сняли"
        );
        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"и в корпус снесённый не вернулся"
        );
    }

    /// Обратная сторона, и без неё замок был бы слишком широким: посадка
    /// вообще — по-прежнему работа директора. Взят ушедший ДОБРОВОЛЬНО, а не
    /// новичок, потому что это ближайший к запрету случай: человека в корпусе
    /// нет, но и сноса на нём нет — resignAsArbiter `removedAt` не пишет.
    /// Проверка доказывает, что различитель читает СНОС, а не «отсутствие в
    /// реестре».
    function test_ChiefStillSeatsSomeoneWhoResigned() public {
        address chief = address(0xC4);
        ArbiterRegistryFacet(address(diamond)).setChiefArbiter(chief);

        address who = address(0x5C);
        _addFreshArbiter(who);
        vm.prank(who);
        ArbiterRegistryFacet(address(diamond)).resignAsArbiter();
        assertFalse(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(who));

        vm.prank(chief);
        ArbiterRegistryFacet(address(diamond)).addArbiter(who);

        assertTrue(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(who),
            unicode"ушёл сам — вернуть его директор вправе, снос тут ни при чём"
        );
    }

    /// В-1: ЗАМОК ШВА С ЗАДАЧЕЙ 5. Возврат в корпус ОБЯЗАН отпускать гейт
    /// п. 66. Гейт читает СТИРАЕМЫЙ removedAt; если задача 5 (п. 72) перевесит
    /// его на вечную историю сносов (removalCount/lastRemovalAt), этот тест
    /// покраснеет — а без него не покраснеет ничто: ревью симулировало этот
    /// промах буквально и получило 0 красных из 831. Докстринг объясняет
    /// ПОЧЕМУ, но объяснение и проверка — разные вещи.
    ///
    /// Возвращает ВЛАДЕЛЕЦ, не директор: после Б-1 выше возврат снесённого —
    /// владельческое действие. Свойство от смены роли не меняется, эффект
    /// (addArbiter стирает removedAt) тот же.
    function test_ChiefStillLiftsOrdinarySuspensionAfterReseat() public {
        address chief = address(0xC4);
        ArbiterRegistryFacet(address(diamond)).setChiefArbiter(chief);

        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("x"), address(0)
        );
        ArbiterRegistryFacet(address(diamond)).addArbiter(arbiter);   // стирает removedAt

        ArbiterAccountabilityFacet(address(diamond)).suspendArbiter(arbiter);
        assertTrue(ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter));

        vm.prank(chief);
        ArbiterAccountabilityFacet(address(diamond)).liftSuspension(arbiter);

        assertFalse(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter),
            unicode"вернули в корпус — директор снова снимает обычную приостановку"
        );
    }

    // ── В-2: право снять окно едет за правом сносить ──
    //
    // removeArbiterForCause намеренно выпихивает владельца после назначения
    // преемника: «дороги назад нет — иначе сговор и слив переписки стали бы
    // неснимаемыми вовсе». Но liftSuspension сравнивала с владельцем ВСЕГДА, и
    // выходило обратное: преемник своё же окно снять не мог (модификатор его
    // не видел), а владелец снимал ЧУЖОЕ — и вернуть приостановку после этого
    // нельзя ничем, suspendArbiter требует isArbiter.

    /// Общий сетап обеих проверок: ДАО включена заработанным путём, преемник
    /// назван, он же и сносит. Владельцу сноса на этой сцене уже нет.
    function _handOverRemovalAndRemove(address dao) internal {
        _setUniqueActiveUsers(ArbiterRegistryFacet(address(diamond)).getDaoThreshold());
        ArbiterRegistryFacet(address(diamond)).setDAOAddress(dao);

        vm.prank(dao);
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256(unicode"переписка"), address(0)
        );
        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter),
            unicode"сетап: преемник снёс, окно выставлено"
        );
    }

    /// Прямая сторона: тот, кто снёс, вправе своё окно и открыть. До правки он
    /// не проходил даже модификатор — то есть после передачи окно не открывал
    /// бы НИКТО, а дверь без открывающего хуже двери у владельца.
    function test_DaoLiftsTheRemovalWindowAfterHandover() public {
        address dao = address(0xDA0);
        _handOverRemovalAndRemove(dao);

        vm.prank(dao);
        ArbiterAccountabilityFacet(address(diamond)).liftSuspension(arbiter);

        assertFalse(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter),
            unicode"у кого право сносить, у того и право отменять свой снос"
        );
    }

    /// Обратная сторона: бывший хозяин двери в неё больше не входит. Без этой
    /// проверки «право едет за правом» осталось бы наполовину — владелец
    /// продолжал бы открывать ЧУЖОЕ окно, ровно против довода, записанного в
    /// removeArbiterForCause.
    function test_OwnerCannotLiftTheRemovalWindowAfterHandover() public {
        address dao = address(0xDA0);
        _handOverRemovalAndRemove(dao);

        vm.expectRevert(ArbiterAccountabilityFacet.RemovalSuspensionIsOwnerOnly.selector);
        ArbiterAccountabilityFacet(address(diamond)).liftSuspension(arbiter);

        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter),
            unicode"окно преемника владельцу не по зубам — снос он передал целиком"
        );
    }

    // ============================================================
    //  ФИНАЛЬНЫЙ ОБЗОР ВЕТКИ, C-1 (16 августа 2026)
    //
    //  СНОС БЫЛ СЛАБЕЕ ПРИОСТАНОВКИ И ВДОБАВОК ЗАКРЫВАЛ ДВЕРЬ, КОТОРАЯ СПАСАЛА.
    //
    //  Связка ТРЁХ задач, и ни одна поодиночке её не показывает — поэтому
    //  тесты живут здесь, на настоящем даймонде, а не в лёгком стенде:
    //
    //    задача 6 — removeArbiterForCause снимает статус, но не трогает ни
    //               disputeClaims, ни openClaimCount, ни suspendedUntil;
    //    исходный
    //    код     — submitVerdict гейтится КЛЕЙМОМ (`disputeClaims[agreement]
    //               != caller`), а не статусом: снятый по-прежнему подаёт
    //               вердикты по всем взятым спорам;
    //    задача 4 — suspendArbiter ревертит NotAnArbiter на уже снятом, то
    //               есть после сноса приостановить его уже НЕЛЬЗЯ.
    //
    //  Итог до правки: владелец находит сговор, жмёт «снести по поводу» — и
    //  тем самым отпирает подкупленному арбитру последнюю дверь. Тот подаёт
    //  вердикты, через сутки любой прохожий их финализирует, котлы уходят
    //  подкупившей стороне. Инверсия замысла: слабая мера деньги держала,
    //  сильная — нет.
    //
    //  Починка: снос ПОДРАЗУМЕВАЕТ приостановку. `_requireNotSuspended` в
    //  finalizeVerdict читает АРБИТРА ВЕРДИКТА (v.arbiter), а не вызывающего —
    //  проверено по коду, — значит одна строка в removeArbiterForCause реально
    //  морозит вердикты снятого на те же 72 часа, за которые владелец успевает
    //  пройтись overturnVerdict/freezeVerdict.
    // ============================================================

    /// Тот же цикл, что _disputeAndOverturn, но останавливается на ПОДАННОМ
    /// вердикте: именно это состояние — «вердикт подан, финализация ждёт
    /// FINALIZE_DELAY» — и есть окно, в которое снос обязан успеть.
    function _disputeAndSubmit(address cli, address exec) internal returns (address agreementAddr) {
        usdc.mint(cli, 1_000_000 * 10 ** 6);
        vm.prank(cli);
        usdc.approve(address(diamond), 10 * 10 ** 6);
        vm.prank(cli);
        agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            cli, exec, arbiter, AMOUNT, DEADLINE, TERMS, 0
        );
        vm.prank(cli);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(cli);
        Agreement(agreementAddr).fund();
        vm.prank(exec);
        Agreement(agreementAddr).activate();
        vm.prank(cli);
        Agreement(agreementAddr).raiseDispute();

        _claimDisputeAs(agreementAddr, arbiter);

        vm.prank(arbiter);
        ArbiterRegistryFacet(address(diamond)).submitVerdict(agreementAddr, true);
    }

    /// Сценарий целиком. Cause.Collusion — сговор: ровно тот повод, ради
    /// которого сильная мера и существует, и он не требует счётчика ошибок
    /// (единственная переменная теста — сам снос).
    function test_RemovedForCauseCannotFinalizeHisVerdictWithinTheWindow() public {
        address agreementAddr = _disputeAndSubmit(address(0x601), address(0x602));

        uint256 removedAtTs = vm.getBlockTimestamp();
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("chat log"), address(0)
        );
        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"сетап: снос состоялся"
        );

        uint256 until = removedAtTs + ArbiterAccountabilityFacet(address(diamond)).getSuspensionWindow();

        // FINALIZE_DELAY = 24 часа прошло, окно приостановки (72 часа) — нет.
        // Ровно тот момент, в который до правки котёл уходил подкупившей
        // стороне.
        vm.warp(removedAtTs + 24 hours);
        vm.expectRevert(
            abi.encodeWithSelector(ArbiterRegistryFacet.ArbiterSuspendedError.selector, until)
        );
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(agreementAddr);
    }

    /// Вторая половина: приостановка от сноса протухает сама. Снятый навсегда
    /// остаётся снятым, но вердикт, который никто не отменил и не заморозил за
    /// 72 часа, исполняется обычным порядком — иначе один снос морозил бы
    /// деньги честных сторон навечно, и это было бы новым оружием.
    function test_RemovedForCauseCanFinalizeAfterTheWindow() public {
        address agreementAddr = _disputeAndSubmit(address(0x603), address(0x604));

        uint256 removedAtTs = vm.getBlockTimestamp();
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("chat log"), address(0)
        );

        vm.warp(
            removedAtTs + ArbiterAccountabilityFacet(address(diamond)).getSuspensionWindow()
        );
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(agreementAddr);

        assertTrue(
            ArbiterRegistryFacet(address(diamond)).getPendingVerdict(agreementAddr).finalized,
            unicode"после окна вердикт исполняется — приостановка временная и здесь тоже"
        );
    }

    /// Контроль, что тест выше различает причины отказа: тот же спор, тот же
    /// момент — но БЕЗ сноса финализация проходит. Без этого «ревертит на
    /// 24 часах» могло бы означать что угодно (не прошёл FINALIZE_DELAY,
    /// сломался мок), а не «держит приостановка».
    function test_WithoutRemovalTheSameVerdictFinalizesAtTwentyFourHours() public {
        address agreementAddr = _disputeAndSubmit(address(0x605), address(0x606));

        vm.warp(vm.getBlockTimestamp() + 24 hours);
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(agreementAddr);

        assertTrue(
            ArbiterRegistryFacet(address(diamond)).getPendingVerdict(agreementAddr).finalized,
            unicode"без сноса тот же вердикт на тех же 24 часах исполняется"
        );
    }

    // ============================================================
    //  ФИНАЛЬНЫЙ ОБЗОР ВЕТКИ, M-4 (16 августа 2026)
    //
    //  Приостановка не стиралась НИ ОДНОЙ дверью выхода и не стиралась при
    //  повторной посадке. С появлением C-1 (снос выставляет приостановку) это
    //  стало прямым противоречием собственному правилу ветки: «признаки
    //  прошлого сноса не переживают повторную посадку». Владелец, чинящий
    //  ошибочный снос одной командой addArbiter, возвращал бы человека с
    //  недожитой приостановкой — тот молча не может ни клеймить, ни
    //  финализировать, ни уволиться.
    // ============================================================

    /// Доказывается ПОВЕДЕНИЕМ, а не чтением поля: возвращённый арбитр обязан
    /// смочь уволиться, а resignAsArbiter — одна из трёх дверей, которые
    /// приостановка запирает (_requireNotSuspended). Читать getSuspendedUntil
    /// было бы слабее: ноль там мог бы значить и «стёрли», и «никогда не
    /// писали».
    function test_ReseatingByOwnerClearsTheSuspensionLeftByRemoval() public {
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), address(0)
        );
        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter),
            unicode"сетап: снос оставил приостановку (C-1)"
        );

        // Владелец разобрался и чинит ошибочный снос — боевой путь.
        ArbiterRegistryFacet(address(diamond)).addArbiter(arbiter);
        assertFalse(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter),
            unicode"повторная посадка обязана снять недожитую приостановку"
        );

        vm.prank(arbiter);
        ArbiterRegistryFacet(address(diamond)).resignAsArbiter();
        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"возвращённый человек работает как обычный арбитр, а не как немой"
        );
    }

    // ============================================================
    //  ОТЛОЖЕННЫЙ ПУНКТ 3 (16 августа 2026)
    //
    //  Вызов clearRemovalRecord из applyAsArbiter не был покрыт ничем —
    //  мутация давала 0 красных. Покрыта была только вторая дверь входа,
    //  addArbiter. Это ровно та половина, которая ПЕРЕЖИВЁТ первую: после
    //  активации ДАО addArbiter мертва (SeatingHandedOver), и самозапись
    //  остаётся ЕДИНСТВЕННЫМ входом в корпус — то есть без замка была оставлена
    //  дверь, которая будет работать дальше всего.
    // ============================================================

    uint256 constant SLOT_XP           = 0;
    uint256 constant SLOT_CLEAN_STREAK = 9;
    uint256 constant ARBITER_BOND      = 50 * 10 ** 6;

    function _grantSelfRegistrationGate(address who) internal {
        vm.store(
            address(diamond),
            keccak256(abi.encode(who, uint256(REP_BASE) + SLOT_XP)),
            bytes32(uint256(10_000))
        );
        vm.store(
            address(diamond),
            keccak256(abi.encode(who, uint256(REP_BASE) + SLOT_CLEAN_STREAK)),
            bytes32(uint256(50))
        );
        usdc.mint(who, ARBITER_BOND);
        vm.prank(who);
        usdc.approve(address(diamond), ARBITER_BOND);
    }

    /// ДАО включается ЗАРАБОТАННЫМ путём (uniqueActiveUsers >= порога), не
    /// через activateDAO(): именно это состояние делает самозапись
    /// единственной дверью, и именно оно наступает само, без единой
    /// человеческой транзакции.
    function test_SelfRegistrationClearsTheRemovalRecord() public {
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), address(0)
        );
        vm.prank(arbiter);
        ArbiterAccountabilityFacet(address(diamond)).respondToRemoval(keccak256("my side"));

        _setUniqueActiveUsers(ArbiterRegistryFacet(address(diamond)).getDaoThreshold());
        assertTrue(ArbiterRegistryFacet(address(diamond)).isDaoActive(), unicode"сетап: ДАО активна заработанным путём");

        _grantSelfRegistrationGate(arbiter);
        vm.prank(arbiter);
        ArbiterRegistryFacet(address(diamond)).applyAsArbiter();
        assertTrue(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter), unicode"сетап: самозапись прошла");

        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getRemovalReply(arbiter),
            bytes32(0),
            unicode"ответ на ПРОШЛЫЙ снос не переживает повторную посадку — иначе второе обвинение осталось бы без ответа навсегда"
        );

        // Вторая половина той же уборки: removedAt. Читается поведением —
        // действующий, ещё не снятый арбитр не должен уметь «отвечать» на
        // давно закрытое обвинение.
        vm.prank(arbiter);
        vm.expectRevert(ArbiterAccountabilityFacet.NothingToAnswer.selector);
        ArbiterAccountabilityFacet(address(diamond)).respondToRemoval(keccak256("phantom"));
    }

    // ============================================================
    //  ШОВ M-4 × САМОЗАПИСЬ — ЗАКРЫТ ПАРАМЕТРОМ (решение владельца, 16 августа)
    //
    //  Первая редакция M-4 стирала suspendedUntil в БИБЛИОТЕЧНОЙ уборке, общей
    //  на обе двери входа, — и тем открывала дыру ровно в C-1: снятый по поводу
    //  платил свежие 50 USDC залога, возвращался самозаписью и финализировал
    //  вердикты, взятые ДО сноса, не дожидаясь 72 часов.
    //
    //  Закрыто не второй копией функции, а явным параметром liftSuspension:
    //  addArbiter передаёт true, applyAsArbiter — false. Довод в одну фразу:
    //  приостановку накладывает не арбитр, значит и снимать её не ему.
    //
    //  Два теста ниже сторожат РАЗНЫЕ стороны параметра, и нужны оба: один
    //  ловит `true` там, где должно быть `false`, другой — наоборот.
    // ============================================================

    /// Сторона `false`. Самозапись возвращает в корпус, но приостановку НЕ
    /// гасит — и доказывается это поведением, а не чтением поля: вернувшийся
    /// человек по-прежнему не может увести свой вердикт через финализацию.
    function test_SelfRegistrationDoesNotLiftSuspension() public {
        address agreementAddr = _disputeAndSubmit(address(0x607), address(0x608));

        uint256 removedAtTs = vm.getBlockTimestamp();
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), address(0)
        );
        assertTrue(ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter), unicode"сетап: снос приостановил");

        _setUniqueActiveUsers(ArbiterRegistryFacet(address(diamond)).getDaoThreshold());
        _grantSelfRegistrationGate(arbiter);
        vm.prank(arbiter);
        ArbiterRegistryFacet(address(diamond)).applyAsArbiter();
        assertTrue(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"сетап: самозапись прошла — в корпус он вернулся"
        );

        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter),
            unicode"самозапись НЕ снимает приостановку: накладывал её не он"
        );

        // Главное последствие, ради которого параметр и заведён: окно C-1
        // держит, несмотря на возврат. Купить разморозку за свежий залог
        // нельзя.
        uint256 until = removedAtTs + ArbiterAccountabilityFacet(address(diamond)).getSuspensionWindow();
        vm.warp(removedAtTs + 24 hours);
        vm.expectRevert(
            abi.encodeWithSelector(ArbiterRegistryFacet.ArbiterSuspendedError.selector, until)
        );
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(agreementAddr);
    }

    /// Сторона `true`. Ту же приостановку снимает ПОСАДКА ВЛАДЕЛЬЦЕМ — он
    /// отменяет собственное решение, и вернуть человека немым было бы ровно той
    /// дырой, ради которой M-4 заводилась. Тот же спор, тот же момент, что и в
    /// тесте выше: единственная разница — какая дверь входа сработала.
    function test_OwnerReseatingLiftsTheSuspensionSelfRegistrationKeeps() public {
        address agreementAddr = _disputeAndSubmit(address(0x609), address(0x60A));

        uint256 removedAtTs = vm.getBlockTimestamp();
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), address(0)
        );

        ArbiterRegistryFacet(address(diamond)).addArbiter(arbiter);
        assertFalse(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter),
            unicode"владелец отменяет своё же решение — приостановка уходит с ним"
        );

        vm.warp(removedAtTs + 24 hours);
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(agreementAddr);
        assertTrue(
            ArbiterRegistryFacet(address(diamond)).getPendingVerdict(agreementAddr).finalized,
            unicode"снос отменён владельцем — вердикт возвращённого арбитра исполняется обычным порядком"
        );
    }

    // ============================================================
    //  ФИНАЛЬНЫЙ ОБЗОР ВЕТКИ, M-3 (16 августа 2026)
    //
    //  КОНТРОЛЬ СТЫКА ДВУХ КОПИЙ _msgSender() — не замок, и это важно.
    //
    //  Докстринг ArbiterAccountabilityFacet обещал, что тело «обязано совпадать
    //  побайтно — сверяется test_MsgSenderMatchesRegistry». Обещание было
    //  ложным: побайтной сверки нет вовсе, а названный тест гоняет через
    //  форвардер только respondToRemoval, то есть говорит про ОДНУ копию. Сам
    //  тот тест правкой C (16 августа 2026) переименован в
    //  test_RespondToRemovalThroughForwarderCreditsHuman — имя приведено к тому,
    //  что он делает.
    //
    //  Здесь — ОДИН настоящий MinimalForwarder, ОДИН даймонд, ОДНО хранилище,
    //  ОДИН подписант, и ответы ОБЕИХ реализаций сверяются друг с другом.
    //
    //  ⚠️ ЧЕСТНЫЙ ЗАМЕР, чтобы этот тест не выглядел сильнее, чем он есть:
    //  единственным красным он не бывает никогда. Порча оригинала — 6 красных,
    //  пять из них гейслесс-пути самого реестра; порча копии — 2 красных, из них
    //  один test_RespondToRemovalThroughForwarderCreditsHuman. Каждая копия и
    //  без него доказана
    //  против ВНЕШНЕЙ правды — адреса подписанта. Он ловит другое: разъезд
    //  именно ПАРЫ на общем хранилище (замер: копия читает чужое поле
    //  FactoryStorage — 2 красных, оба про эту пару).
    // ============================================================

    bytes32 constant FWD_TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data)"
    );

    function _signFwd(MinimalForwarder fwd, uint256 pk, MinimalForwarder.ForwardRequest memory req)
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
                address(fwd)
            )),
            structHash
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _forward(MinimalForwarder fwd, uint256 pk, address from, bytes memory data) internal {
        MinimalForwarder.ForwardRequest memory req = MinimalForwarder.ForwardRequest({
            from:  from,
            to:    address(diamond),
            value: 0,
            gas:   1_000_000,
            nonce: fwd.getNonce(from),
            data:  data
        });
        vm.prank(address(0x9999)); // релеер: третий адрес, не арбитр и не форвардер
        (bool ok, bytes memory ret) = fwd.execute(req, _signFwd(fwd, pk, req));
        assertTrue(ok, string.concat("forwarded call failed: ", vm.toString(ret)));
    }

    function test_MsgSenderAgreesAcrossBothFacetsOnOneForwarder() public {
        uint256 pk = 0xCA11;
        address human = vm.addr(pk);

        MinimalForwarder fwd = new MinimalForwarder();
        FactoryFacet(address(diamond)).setTrustedForwarder(address(fwd));
        ArbiterRegistryFacet(address(diamond)).addArbiter(human);

        // ── Реализация №1: ArbiterRegistryFacet._msgSender ──
        // setArbiterChatKey пишет ключи ПО ОТПРАВИТЕЛЮ, и наружу они читаются
        // по адресу. Значит промах атрибуции виден напрямую, а не только по
        // факту реверта: ключи ушли бы форвардеру, и getArbiterChatKeys(human)
        // вернул бы нули.
        bytes32 boxKey  = keccak256("box");
        bytes32 signKey = keccak256("sign");
        _forward(
            fwd, pk, human,
            abi.encodeWithSelector(ArbiterRegistryFacet.setArbiterChatKey.selector, boxKey, signKey)
        );
        (bytes32 gotBox, bytes32 gotSign) =
            ArbiterAccountabilityFacet(address(diamond)).getArbiterChatKeys(human);

        // ── Реализация №2: ArbiterAccountabilityFacet._msgSender ──
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            human, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), address(0)
        );
        bytes32 reply = keccak256("my side");
        _forward(
            fwd, pk, human,
            abi.encodeWithSelector(ArbiterAccountabilityFacet.respondToRemoval.selector, reply)
        );
        bytes32 gotReply = ArbiterAccountabilityFacet(address(diamond)).getRemovalReply(human);

        // ── Сверка пары ──
        assertEq(gotBox,  boxKey,  unicode"реализация ArbiterRegistryFacet обязана записать ЧЕЛОВЕКУ");
        assertEq(gotSign, signKey, unicode"реализация ArbiterRegistryFacet обязана записать ЧЕЛОВЕКУ");
        assertEq(gotReply, reply,  unicode"реализация ArbiterAccountabilityFacet обязана записать ТОМУ ЖЕ человеку");

        // Контроль: ни одна из двух не приписала работу форвардеру. Без этой
        // половины «обе записали человеку» ещё могло бы уживаться с тем, что
        // одна из копий пишет ОБОИМ.
        (bytes32 fwdBox, bytes32 fwdSign) =
            ArbiterAccountabilityFacet(address(diamond)).getArbiterChatKeys(address(fwd));
        assertEq(fwdBox,  bytes32(0), unicode"форвардеру ключи не принадлежат");
        assertEq(fwdSign, bytes32(0), unicode"форвардеру ключи не принадлежат");
        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getRemovalReply(address(fwd)),
            bytes32(0),
            unicode"форвардеру ответ не принадлежит"
        );
    }

    // ============================================================
    //  ЗАПИСЬ ОБ АВТОСНЯТИИ НАЗЫВАЕТ ПРОИСХОЖДЕНИЕ (п. 65, 16 августа 2026)
    //
    //  Одного поданного вердикта хватает, чтобы владелец тремя вызовами
    //  overturnVerdict по ОДНОМУ агрименту снял арбитра, минуя дверь с
    //  поводом. Прежнее событие из одного поля читалось как автоматика — то
    //  есть валило вину на снятого. Путей у автоснятия ровно три, и каждый
    //  обязан быть назван своим.
    // ============================================================

    /// Путь первый: владелец переворачивает вердикт. Нажавший есть, и он
    /// назван. Три переворота ОДНОГО агримента — ровно тот сценарий, ради
    /// которого правка делалась.
    function test_ArbiterDemotedNamesOwnerOnTheOverturnPath() public {
        address agr = _disputeAndSubmit(address(0x651), address(0x652));

        ArbiterRegistryFacet(address(diamond)).overturnVerdict(agr, false);
        ArbiterRegistryFacet(address(diamond)).overturnVerdict(agr, true);

        vm.expectEmit(true, true, true, true, address(diamond));
        emit ArbiterRegistryFacet.ArbiterDemoted(
            arbiter, owner, ArbiterRegistryFacet.DemotionPath.OwnerOverturn, agr
        );
        ArbiterRegistryFacet(address(diamond)).overturnVerdict(agr, false);

        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"третий переворот снял арбитра"
        );
    }

    /// Тот же путь первый, но НАЖИМАЕТ НЕ ВЛАДЕЛЕЦ (круг правок 1, 16 августа
    /// 2026). Без этой сцены центральное свойство задачи не сторожилось ничем:
    /// во всём наборе owner == address(this), overturnVerdict нигде не звалась
    /// под vm.prank, и подмена `by` на OwnershipLib.contractOwner() давала НОЛЬ
    /// красных из 840 — тесты доказывали «запись называет владельца», а не
    /// «запись называет нажавшего».
    ///
    /// Сцена боевая, а не выдуманная: onlyOwnerOrDAO пускает и адрес
    /// управления, а сажает его туда setDAOAddress. Дверь открывается уже одним
    /// адресом — activateDAO() здесь для полноты картины передачи, модификатор
    /// его не спрашивает.
    function test_ArbiterDemotedNamesTheDaoNotTheOwner() public {
        address dao = address(0x6D40);
        ArbiterRegistryFacet(address(diamond)).setDAOAddress(dao);
        ArbiterRegistryFacet(address(diamond)).activateDAO();
        assertTrue(dao != owner, unicode"сетап: нажимающий и владелец — РАЗНЫЕ адреса");

        address agr = _disputeAndSubmit(address(0x65F), address(0x660));

        // Первые две ошибки нажимает владелец, третью — управление. Именно
        // третья попадает в запись, и она обязана назвать управление.
        ArbiterRegistryFacet(address(diamond)).overturnVerdict(agr, false);
        ArbiterRegistryFacet(address(diamond)).overturnVerdict(agr, true);

        vm.expectEmit(true, true, true, true, address(diamond));
        emit ArbiterRegistryFacet.ArbiterDemoted(
            arbiter, dao, ArbiterRegistryFacet.DemotionPath.OwnerOverturn, agr
        );
        vm.prank(dao);
        ArbiterRegistryFacet(address(diamond)).overturnVerdict(agr, false);

        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"третий переворот снял арбитра"
        );
    }

    /// Нулевое значение перечисления — не путь и не обвинение (круг правок 1).
    /// Забытый или новый путь получит в Solidity ноль по умолчанию; проверяем,
    /// что на нуле стоит Unspecified, а не OwnerOverturn — иначе забывчивость
    /// молча обвиняла бы владельца. Проверка сравнивает ЧИСЛА, а не имена:
    /// имена совпадали бы сами с собой при любом порядке.
    function test_ZeroDemotionPathIsNotAnAccusation() public pure {
        assertEq(
            uint8(ArbiterRegistryFacet.DemotionPath.Unspecified), 0,
            unicode"нулевое значение обязано быть «путь не назван»"
        );
        assertTrue(
            uint8(ArbiterRegistryFacet.DemotionPath.OwnerOverturn) != 0,
            unicode"ни один настоящий путь не смеет стоять на нуле — иначе умолчание обвиняет"
        );
        assertTrue(uint8(ArbiterRegistryFacet.DemotionPath.AgreementTimeout) != 0, unicode"то же для таймаута");
        assertTrue(uint8(ArbiterRegistryFacet.DemotionPath.AppealVote) != 0, unicode"то же для голосов");
    }

    /// Путь второй: спор не доведён, агримент сам сообщает о таймауте.
    /// Нажавшего нет вовсе — msg.sender здесь это САМ АГРИМЕНТ, и записывать
    /// его как «кто нажал» значило бы врать. Поэтому `by` нулевой, а сделка
    /// названа отдельным полем.
    function test_ArbiterDemotedNamesNobodyOnTheTimeoutPath() public {
        _disputeAndOverturn(address(0x653), address(0x654));
        _disputeAndOverturn(address(0x655), address(0x656));

        // Третья сделка: спор взят и НЕ доведён до вердикта.
        address cli = address(0x657);
        address exec = address(0x658);
        usdc.mint(cli, 1_000_000 * 10 ** 6);
        vm.prank(cli);
        usdc.approve(address(diamond), 10 * 10 ** 6);
        vm.prank(cli);
        address agr = FactoryFacet(address(diamond)).deployAgreement(
            cli, exec, arbiter, AMOUNT, DEADLINE, TERMS, 0
        );
        vm.prank(cli);
        usdc.approve(agr, AMOUNT);
        vm.prank(cli);
        Agreement(agr).fund();
        vm.prank(exec);
        Agreement(agr).activate();
        vm.prank(cli);
        Agreement(agr).raiseDispute();
        _claimDisputeAs(agr, arbiter);

        // DISPUTE_WINDOW = 4 days (src/Agreement.sol:278); строго БОЛЬШЕ.
        vm.warp(vm.getBlockTimestamp() + 4 days + 1);

        vm.expectEmit(true, true, true, true, address(diamond));
        emit ArbiterRegistryFacet.ArbiterDemoted(
            arbiter, address(0), ArbiterRegistryFacet.DemotionPath.AgreementTimeout, agr
        );
        vm.prank(cli);
        Agreement(agr).triggerArbiterTimeout();

        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"третья ошибка подряд — таймаутом, и она тоже снимает"
        );
    }

    /// Путь третий: апелляция. Нажавшего тоже нет — resolveAppeal звать может
    /// кто угодно, и записать его как виновника было бы худшей из трёх
    /// возможных неправд: решают ГОЛОСА, а не тот, кто нажал «подвести итог».
    /// `by` нулевой, голосовавшие читаются из AppealVoteCast по тому же
    /// агрименту.
    function test_ArbiterDemotedNamesNobodyOnTheAppealPath() public {
        _disputeAndOverturn(address(0x659), address(0x65A));
        _disputeAndOverturn(address(0x65B), address(0x65C));

        address v1 = address(0x6A1);
        address v2 = address(0x6A2);
        address v3 = address(0x6A3);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v1);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v2);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v3);

        address cli = address(0x65D);
        address exec = address(0x65E);
        address agr = _disputeAndSubmit(cli, exec);
        // submitVerdict(agr, true) — выиграл клиент, значит апеллирует
        // исполнитель. APPEAL_DEPOSIT — 20 USDC.
        usdc.mint(exec, 100 * 10 ** 6);
        vm.prank(exec);
        usdc.approve(address(diamond), 20 * 10 ** 6);
        vm.prank(exec);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);

        vm.prank(v1);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);   // перевернуть
        vm.prank(v2);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);   // перевернуть
        vm.prank(v3);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, false);  // оставить

        vm.expectEmit(true, true, true, true, address(diamond));
        emit ArbiterRegistryFacet.ArbiterDemoted(
            arbiter, address(0), ArbiterRegistryFacet.DemotionPath.AppealVote, agr
        );
        ArbiterRegistryFacet(address(diamond)).resolveAppeal(agr);

        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"голоса перевернули вердикт — и это третья ошибка подряд"
        );
    }
}
