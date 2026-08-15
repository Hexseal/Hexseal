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
            ArbiterRegistryFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 2,
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
}
