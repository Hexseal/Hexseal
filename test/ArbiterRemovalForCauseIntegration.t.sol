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

    /// Коды автоснятия в карточке getArbiterStanding.
    ///
    /// ⚠️ ЛИТЕРАЛЫ НАРОЧНО, а не `AUTO_REMOVAL_BASE + uint8(DemotionPath.X)`
    /// (четвёртое правило, docs/PROCESS.md): выражение через константу
    /// библиотеки и значение перечисления выводит ожидаемое из проверяемого —
    /// сдвиньте базу или переставьте перечисление, и обе стороны сравнения
    /// уедут вместе, а замок промолчит. Здесь ожидаемое взято извне кода:
    /// 252 — путь не назван, 253 — переворот, 254 — таймаут, 255 — голоса.
    uint8 constant AUTO_OVERTURN = 253;
    uint8 constant AUTO_TIMEOUT  = 254;
    uint8 constant AUTO_APPEAL   = 255;

    /// ArbiterRegistryStorage.POSITION — тот же неймспейс, что читает
    /// test/ArbiterSuspension.t.sol (ARB_BASE там же), и слот залога 12 добыт
    /// там же перебором. Здесь нужен ровно для того, чтобы «залог сгорает НА
    /// СНОСЕ, а не на обвинении» проверялось на ненулевом залоге: базового
    /// арбитра стенд сажает рукой (addArbiter), а ручная посадка залога не
    /// берёт вовсе — см. test_HandSeatedArbiterHasNoBondToBurn.
    bytes32 constant ARB_BASE = 0xaae71de0594cbcb5434f0ab7f7501c1be178552bf788b418a1c2624ba9718d00;
    uint256 constant SLOT_ARBITER_BOND = 12;

    /// Посторонний: никакой роли, ни арбитр, ни директор, ни владелец.
    address constant STRANGER = address(0x5A);
    /// Директор. Тот же адрес, что уже используют сцены ниже.
    address constant CHIEF = address(0xC4);
    bytes32 constant DIGEST = keccak256("the evidence, attested not verified");

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
    /// Words the stand puts on a proposal. The causes used here are the ones
    /// the chain does not check, and those demand both a digest and words.
    string constant PROPOSAL_WORDS = "the accusation, stated once, on the proposal";

    /// Since 17 August 2026 a removal only runs through a proposal that has
    /// sat for REMOVAL_DELAY, and the cause at execution must match the one
    /// proposed. The helper lays the proposal down and winds time to the far
    /// side of the pause — the diamond twin of _proposeAndWait in
    /// test/ArbiterRemovalForCause.t.sol.
    ///
    /// ⚠️ vm.getBlockTimestamp(), not block.timestamp: under via_ir solc treats
    /// TIMESTAMP as constant within a call (docs/OPEN-ITEMS.md, item 57).
    ///
    /// ⚠️ LAID DOWN BY THE OWNER, AND THAT WORKS ONLY BEFORE THE HANDOVER.
    /// This paragraph used to say the opposite of what the branch is for: "the
    /// owner goes through whether or not governance is active — only the
    /// EXECUTION moves to daoAddress". Both halves are wrong since review round
    /// 2 of the pause (17 August 2026): the accusation door travelled with the
    /// right to act on it, and proposeRemoval answers the former owner with
    /// RemovalHandedOver.
    ///
    /// So this helper is a BEFORE-HANDOVER helper and nothing else. Past the
    /// handover use `_proposeAndWaitAs(successor, ...)`, which exists for
    /// exactly that and is what every scene past a handover already calls.
    function _proposeAndWait(address who, ArbiterAccountabilityFacet.Cause cause, bytes32 digest)
        internal
    {
        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(who, cause, digest, PROPOSAL_WORDS);
        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getRemovalDelay());
    }

    /// Same, laid down by a named caller. Needed past handover: since review
    /// round 2 (17 August 2026) the accusation door travels with the right to
    /// act on it, so the OWNER cannot propose once a successor is named — the
    /// successor lays his own, which is what a handover is for.
    function _proposeAndWaitAs(
        address caller,
        address who,
        ArbiterAccountabilityFacet.Cause cause,
        bytes32 digest
    ) internal {
        vm.prank(caller);
        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(who, cause, digest, PROPOSAL_WORDS);
        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getRemovalDelay());
    }

    /// ТРИ РАЗНЫХ СПОРА, не один трижды. Задача 11 (`AlreadyOverturned`)
    /// запретила бить один и тот же вердикт повторно, и это ровно та цена,
    /// ради которой она делалась: до неё автоматический путь стоил ОДНОГО
    /// поданного вердикта и трёх вызовов в одном блоке.
    function _threeOverturnsOnDistinctDisputes(address judged) internal {
        require(judged == arbiter, "stand builds disputes for the seated arbiter only");
        _disputeAndOverturn(address(0x9A1), address(0x9A2));
        _disputeAndOverturn(address(0x9A3), address(0x9A4));
        _disputeAndOverturn(address(0x9A5), address(0x9A6));
    }

    /// Право сноса уезжает названному преемнику — заработанным порогом, как в
    /// жизни, а не ручным activateDAO(). После этого владелец не предлагает и
    /// не сносит: храповик, ради которого вся ветка.
    function _handOverRemovalRight(address dao) internal {
        _setUniqueActiveUsers(ArbiterRegistryFacet(address(diamond)).getDaoThreshold());
        ArbiterRegistryFacet(address(diamond)).setDAOAddress(dao);
    }

    /// Кладёт арбитру залог прямо в хранилище. Через applyAsArbiter не выйдет:
    /// та требует активной ДАО, а активная ДАО закрывает половину сцен ниже.
    function _giveBond(address who, uint256 amount) internal {
        vm.store(
            address(diamond),
            keccak256(abi.encode(who, uint256(ARB_BASE) + SLOT_ARBITER_BOND)),
            bytes32(amount)
        );
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

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0));
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0),
            ""
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

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0));
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0),
            ""
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

        // The successor lays his own accusation: past handover the owner
        // cannot (review round 2, 17 August 2026).
        _proposeAndWaitAs(dao, arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0));
        vm.prank(dao);
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0),
            ""
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
            who, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"),
            unicode"выложил переписку по спору третьей стороне"
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
            who, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"),
            unicode"выложил переписку по спору третьей стороне"
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
            who, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"),
            unicode"выложил переписку по спору третьей стороне"
        );

        uint256 ttl = ArbiterAccountabilityFacet(address(diamond)).getProposalTTL();
        vm.warp(vm.getBlockTimestamp() + ttl);

        vm.prank(who);
        ArbiterRegistryFacet(address(diamond)).resignAsArbiter();
        assertFalse(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(who));
    }

    /// Задача 10 на боевом даймонде: обвинение больше не продлевается НА МЕСТЕ,
    /// и потому окно, в котором арбитр уходит со своим залогом, наступает.
    /// Сцена стоит здесь, а не на лёгком стенде, потому что она — про ШОВ
    /// между двумя фасетами на одном хранилище: гейт живёт в
    /// ArbiterAccountabilityFacet.proposeRemoval, а запертая им дверь —
    /// ArbiterRegistryFacet.resignAsArbiter. Лёгкий стенд разворачивает только
    /// один фасет и второй половины не видит вовсе.
    ///
    /// До правки обвинитель клал второе предложение за секунду до протухания,
    /// одной транзакцией и без следа, — и это окно не наступало никогда.
    ///
    /// ⚠️ ЧЕГО ЭТА СЦЕНА НЕ ДОКАЗЫВАЕТ (круг правок 1, 18 августа 2026):
    /// продление как таковое живо. Держатель права может отозвать и положить
    /// заново, и тогда резигнация снова заперта — из четырёх замеренных вредов
    /// перезаписи снято три, а четвёртый стал ГРОМКИМ, а не невозможным:
    /// каждое продление теперь стоит отдельной транзакции и оставляет в ленте
    /// RemovalProposalWithdrawn. Ограничителя «не чаще чем раз в N» нет и не
    /// задумано (замысел, раздел 12).
    function test_ProposalCannotBeRenewedInPlaceAndTheBondGoesFreeAtTTL() public {
        address who = address(0x5A);
        _addFreshArbiter(who);
        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(
            who, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"), PROPOSAL_WORDS
        );
        (, , uint256 proposedAt, , ) =
            ArbiterAccountabilityFacet(address(diamond)).getRemovalProposal(who);

        uint256 ttl = ArbiterAccountabilityFacet(address(diamond)).getProposalTTL();
        vm.warp(proposedAt + ttl - 1); // последняя секунда, когда продление ещё имело бы смысл

        vm.expectRevert(
            abi.encodeWithSelector(
                ArbiterAccountabilityFacet.ProposalAlreadyLive.selector, address(this), proposedAt
            )
        );
        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(
            who, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"), PROPOSAL_WORDS
        );

        // И ровно на границе залог перестаёт быть заложником — при условии, что
        // обвинитель не отозвал и не положил заново: этот путь жив, просто он
        // больше не бесшумен (см. ⚠️ в докстринге).
        vm.warp(proposedAt + ttl);
        vm.prank(who);
        ArbiterRegistryFacet(address(diamond)).resignAsArbiter();
        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(who),
            unicode"обвинение протухло и не было продлено — человек ушёл сам"
        );
    }

    function test_ResignSucceedsAfterProposalWithdrawn() public {
        address who = address(0x58);
        _addFreshArbiter(who);
        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(
            who, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"),
            unicode"выложил переписку по спору третьей стороне"
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
            who, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"),
            unicode"выложил переписку по спору третьей стороне"
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

    /// Important 1, дверь №3: автоматический путь обязан стереть предложение
    /// той же дорогой, что и ручной снос, — через clearSeat.
    ///
    /// ⚠️ СЦЕНА ПЕРЕСТРОЕНА ЗАДАЧЕЙ 12 (18 августа 2026). Прежняя клала
    /// человеческое предложение и ждала, что три переворота сотрут его вместе с
    /// креслом. Теперь так НЕ БЫВАЕТ: живое человеческое обвинение — занятая
    /// дверь, цепь молча уступает ей (иначе ревёрт был бы проглочен пустым
    /// try/catch в Agreement), и тот случай проверяет отдельная сцена
    /// test_ChainYieldsToALiveHumanProposalWithoutReverting.
    ///
    /// Проверяемое свойство осталось прежним и переехало на дверь, которая
    /// теперь и есть третья: обвинение цепи гасится СНОСОМ, а не висит после
    /// него — иначе hasLiveProposal отвечал бы true до двух недель против
    /// человека, которого в реестре уже нет и который снять запись о себе не
    /// может.
    function test_ChainRemovalClearsTheProposal() public {
        _threeOverturnsOnDistinctDisputes(arbiter);
        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter),
            unicode"сетап: обвинение цепи живо"
        );

        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getRemovalDelay());
        vm.prank(STRANGER);
        ArbiterAccountabilityFacet(address(diamond)).executeChainRemoval(arbiter);

        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"сетап: снос состоялся"
        );

        (, , uint256 proposedAtAfter, , ) =
            ArbiterAccountabilityFacet(address(diamond)).getRemovalProposal(arbiter);
        assertEq(proposedAtAfter, 0, unicode"снос обязан стереть предложение той же дорогой, что и ручной");
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
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"));
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), address(0),
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
        );
        assertFalse(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter));

        // Владелец чинит ошибочный снос — реальный путь, не гипотетический.
        ArbiterRegistryFacet(address(diamond)).addArbiter(arbiter);
        assertTrue(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter));

        vm.prank(arbiter);
        vm.expectRevert(ArbiterAccountabilityFacet.NothingToAnswer.selector);
        ArbiterAccountabilityFacet(address(diamond)).respondToRemoval(keccak256("late"), "");
    }

    /// Симметричная половина: ответил на первый снос, вернули, сняли СНОВА —
    /// второй ответ обязан пройти, а не упереться в AlreadyAnswered от
    /// первого. Изолирует removalReply-половину clearRemovalRecord от
    /// removedAt-половины (предыдущий тест).
    function test_ReseatingAndReremovalAllowsAnsweringAgain() public {
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("first evidence"));
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("first evidence"), address(0),
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
        );
        vm.prank(arbiter);
        ArbiterAccountabilityFacet(address(diamond)).respondToRemoval(keccak256("first answer"), "");
        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getRemovalReply(arbiter),
            keccak256("first answer"),
            unicode"сетап: первый ответ лёг"
        );

        ArbiterRegistryFacet(address(diamond)).addArbiter(arbiter);

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("second evidence"));
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("second evidence"), address(0),
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
        );

        vm.prank(arbiter);
        ArbiterAccountabilityFacet(address(diamond)).respondToRemoval(keccak256("second answer"), "");
        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getRemovalReply(arbiter),
            keccak256("second answer"),
            unicode"второй ответ обязан лечь поверх стёртого первого, не отревертить AlreadyAnswered"
        );
    }

    // ============================================================
    //  Minor 2 круга правок 1: автоматический путь тоже даёт право ответа
    //
    //  Решение владельца: правило звучит одной фразой — «сняли, значит
    //  можешь ответить» — вне зависимости от того, кто нажал. Публичная запись
    //  ArbiterDemoted вечна ровно так же, как ArbiterRemovedForCause.
    //
    //  ⚠️ ЗАДАЧА 12 увела снятие в общую дверь, и `removedAt` ставит теперь
    //  только снос. ЗАДАЧА 3 (19 августа 2026) дописала вторую дверь ответа:
    //  живое предложение. Значит право ответа открывает УЖЕ ТРЕТЬЯ ОШИБКА —
    //  вместе с приостановкой и обвинением, — а этот тест играет вторую
    //  половину: снос открывает его тоже, и молчавший в паузу не теряет слова.
    //  Первую половину играет test_TheChainAccusedAnswersDuringThePause ниже.
    // ============================================================

    function test_AutoDemotedArbiterCanAnswer() public {
        _threeOverturnsOnDistinctDisputes(arbiter);

        // Здесь проверяется дверь `removedAt`, поэтому кнопку жмём: до неё
        // отметки сноса нет. Что обвинённый мог ответить и РАНЬШЕ, начиная с
        // третьей ошибки, — отдельная сцена
        // (test_TheChainAccusedAnswersDuringThePause), и специально другая: эта
        // обязана краснеть от поломки половины `removedAt`, а не от поломки
        // половины «живое предложение».
        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getRemovalDelay());
        vm.prank(STRANGER);
        ArbiterAccountabilityFacet(address(diamond)).executeChainRemoval(arbiter);

        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"сетап: обвинение цепи дошло до сноса"
        );

        bytes32 reply = keccak256(unicode"меня разжаловали автоматом, вот моя версия");
        vm.prank(arbiter);
        ArbiterAccountabilityFacet(address(diamond)).respondToRemoval(reply, "");

        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getRemovalReply(arbiter),
            reply,
            unicode"автоматический путь тоже даёт право ответа — та же публичная запись, тот же ответ"
        );
    }

    // ============================================================
    //  СЛОВО ДО ПРИГОВОРА, ОБВИНЯЕМЫЙ ЦЕПЬЮ (задача 3, 19 августа 2026)
    //
    //  Задача 12 увела автоснятие в общую дверь: третья судейская ошибка
    //  приостанавливает и ОБВИНЯЕТ, а не снимает. Значит на этом пути
    //  removedAt не ставится вовсе — и до задачи 3 обвинённый цепью не мог
    //  ответить никак, ни во время паузы, ни после неё, пока кто-нибудь не
    //  нажмёт кнопку.
    //
    //  Он же — единственный обвиняемый, у которого обвинитель безымянен: `by`
    //  нулевой, слов в обвинении нет, поводом идут сами перевороты. И он же
    //  единственный, кого обвинение вдобавок ПРИОСТАНАВЛИВАЕТ: человеческое
    //  предложение работать не мешает, а это мешает. За двое суток паузы ответ
    //  — буквально единственное, что он может сделать в цепи.
    //
    //  Сцены живут здесь, а не в лёгком стенде: обвинение цепи кладёт
    //  ArbiterRegistryFacet._recordArbiterMistake, а отвечают через
    //  ArbiterAccountabilityFacet — обоим нужно одно настоящее хранилище за
    //  одним даймондом.
    // ============================================================

    /// Главный случай задачи: обвинённый ЦЕПЬЮ отвечает во время паузы, ещё
    /// сидя в корпусе и не будучи снесённым.
    function test_TheChainAccusedAnswersDuringThePause() public {
        _threeOverturnsOnDistinctDisputes(arbiter);

        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter),
            unicode"сетап: цепь обвинила"
        );
        assertTrue(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"сетап: он ещё в корпусе — обвинён, а не снят"
        );

        bytes32 reply = keccak256(unicode"все три спора вёл по инструкции, вот логи");
        vm.prank(arbiter);
        ArbiterAccountabilityFacet(address(diamond)).respondToRemoval(
            reply, unicode"перевороты были, вины моей в них нет"
        );

        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getRemovalReply(arbiter), reply,
            unicode"возражение легло в цепь до приговора, которого может и не быть"
        );
    }

    /// ⚠️ ВТОРОЕ ОБВИНЕНИЕ ЦЕПИ ОТКРЫВАЕТ ПРАВО ЗАНОВО, и без очистки в
    /// _recordArbiterMistake оно бы НЕ открылось. Это дыра, которой задание
    /// задачи 3 не знало: оно перечислило места, где предложение ИСЧЕЗАЕТ, и
    /// закрыло очисткой только человеческую дверь его ПОЯВЛЕНИЯ
    /// (proposeRemoval). Цепь кладёт своё обвинение мимо неё — прямой записью
    /// в хранилище.
    ///
    /// Сцена без единого искусственного шага: обвинение цепи протухает
    /// неисполненным (кнопка ничья, нажать её никто не обязан), человек
    /// остаётся сидеть, счётчик остаётся стоять — и следующий переворот кладёт
    /// новое обвинение. Ответ на прежнее превратил бы его в AlreadyAnswered
    /// навсегда.
    function test_ANewChainAccusationReopensTheRightToAnswer() public {
        _threeOverturnsOnDistinctDisputes(arbiter);

        vm.prank(arbiter);
        ArbiterAccountabilityFacet(address(diamond)).respondToRemoval(keccak256("a1"), "");

        // Никто не нажал: обвинение протухает само. Отзыва нет, оправдания
        // нет — ничто не стирает ответ по дороге.
        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getProposalTTL());
        assertFalse(
            ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter),
            unicode"сетап: прежнее обвинение протухло неисполненным"
        );

        // Четвёртый переворот — цепь обвиняет снова.
        _disputeAndOverturn(address(0x9E1), address(0x9E2));
        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter),
            unicode"сетап: цепь положила новое обвинение"
        );

        vm.prank(arbiter);
        ArbiterAccountabilityFacet(address(diamond)).respondToRemoval(keccak256("a2"), "");
        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getRemovalReply(arbiter), keccak256("a2"),
            unicode"на новое обвинение цепи он ответил заново, а не упёрся в AlreadyAnswered"
        );
    }

    /// Оправдание коллегией — четвёртое место, где обвинение исчезает, и
    /// задание задачи 3 его не знало (оно появилось задачей 12). Цепь забирает
    /// своё слово целиком: предложения нет, счётчик ноль, приостановка снята —
    /// и ответа тоже нет, потому что отвечать больше не на что.
    function test_VindicationClosesTheAnswerToTheChainsAccusation() public {
        address v1 = address(0x7E1);
        address v2 = address(0x7E2);
        address v3 = address(0x7E3);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v1);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v2);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v3);

        _disputeAndOverturn(address(0x9F1), address(0x9F2));
        _disputeAndOverturn(address(0x9F3), address(0x9F4));
        address agr = _disputeAndOverturn(address(0x9F5), address(0x9F6));

        vm.prank(arbiter);
        ArbiterAccountabilityFacet(address(diamond)).respondToRemoval(keccak256("my side"), "");
        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getRemovalReply(arbiter), keccak256("my side"),
            unicode"сетап: ответ на обвинение цепи лёг"
        );

        usdc.mint(address(0x9F5), 100 * 10 ** 6);
        vm.prank(address(0x9F5));
        usdc.approve(address(diamond), 20 * 10 ** 6);
        vm.prank(address(0x9F5));
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);
        vm.prank(v1);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);
        vm.prank(v2);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);
        vm.prank(v3);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, false);
        ArbiterRegistryFacet(address(diamond)).resolveAppeal(agr);

        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getRemovalReply(arbiter), bytes32(0),
            unicode"ответ снят вместе с обвинением, которое коллегия забрала"
        );
        vm.prank(arbiter);
        vm.expectRevert(ArbiterAccountabilityFacet.NothingToAnswer.selector);
        ArbiterAccountabilityFacet(address(diamond)).respondToRemoval(keccak256("again"), "");
    }

    /// п. 66, следствие второе: тем же вызовом глушился АВТОМАТ.
    ///
    /// Автоматический путь ставит ту же приостановку из того же объявления
    /// (ArbiterRegistryStorage.SUSPENSION_WINDOW) и — задачей 12, уже на самом
    /// сносе — ту же отметку removedAt, что ручной снос, и делает это БЕЗ
    /// ЧЕЛОВЕКА на всём протяжении. Директор, снимавший
    /// приостановку без единой проверки, выключал механизм, который специально
    /// сделали работающим сам по себе; стоило это ноль газа сверх вызова и не
    /// оставляло в записи никакого «почему».
    function test_ChiefCannotLiftAutoDemotionSuspension() public {
        address chief = address(0xC4);
        ArbiterRegistryFacet(address(diamond)).setChiefArbiter(chief);

        // Три РЕАЛЬНЫХ переворота по трём разным сделкам, а затем кнопка.
        //
        // ⚠️ ЗАДАЧА 12: снос уехал на двое суток вперёд, и сцена ждёт его.
        // Проверяемое свойство прежнее и лежит на прежней половине
        // различителя — `removedAt != 0`. Вторую половину, «висит обвинение
        // ЦЕПИ, снос ещё не состоялся», сторожит отдельная сцена
        // test_ChiefCannotLiftTheChainSuspensionWhileTheAccusationStands: без
        // неё директор глушил бы быстрый рычаг одной транзакцией — ровно тот
        // обход, который закрывал п. 66.
        _threeOverturnsOnDistinctDisputes(arbiter);
        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getRemovalDelay());
        vm.prank(STRANGER);
        ArbiterAccountabilityFacet(address(diamond)).executeChainRemoval(arbiter);

        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"сетап: автомат снял арбитра"
        );
        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter),
            unicode"сетап: автомат выставил то же окно, что ручной снос"
        );

        vm.prank(chief);
        vm.expectRevert(ArbiterAccountabilityFacet.RemovalSuspensionIsRemovalAuthorityOnly.selector);
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

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256(unicode"переписка"));
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256(unicode"переписка"), address(0),
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
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

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("x"));
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("x"), address(0),
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
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
    ///
    /// ⚠️ And no proposal from him either, since review round 2 (17 August
    /// 2026): the accusation door moved with the right to act on it, so the
    /// successor lays his own record here — the owner's last action on this
    /// stand is naming him.
    function _handOverRemovalAndRemove(address dao) internal {
        _setUniqueActiveUsers(ArbiterRegistryFacet(address(diamond)).getDaoThreshold());
        ArbiterRegistryFacet(address(diamond)).setDAOAddress(dao);

        _proposeAndWaitAs(dao, arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256(unicode"переписка"));
        vm.prank(dao);
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256(unicode"переписка"), address(0),
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
        );
        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter),
            unicode"сетап: преемник снёс, окно выставлено"
        );
    }

    // ── Review round 2 of the pause (17 August 2026): the handover end to end ──

    /// THE WHOLE ROAD, WALKED BY THE SUCCESSOR ALONE. Not the pieces — the
    /// property. After the owner names him, every remaining action is the
    /// successor's: he proposes, he waits out the 48 hours, he removes. The
    /// former owner does nothing, and this test proves he does not have to.
    ///
    /// This is exactly what the pause broke and what review round 2 repaired.
    /// Before the fix the successor could not lay a proposal at all
    /// (onlyOwnerOrChief admits neither the owner-that-was nor him), and since
    /// the pause made a proposal mandatory, the handover was cancelled by our
    /// own work: the right had moved, and using it still required a transaction
    /// from the man it had moved away from.
    ///
    /// Lives here, not on the light stand, because the property spans three
    /// facets and one storage: setDAOAddress and isRegisteredArbiter are the
    /// registry's, proposeRemoval and removeArbiterForCause the accountability
    /// facet's, and the DAO threshold is read out of the reputation namespace.
    function test_SuccessorRunsTheWholeRemovalAloneAfterHandover() public {
        address dao = address(0xDA0);

        // The owner's LAST act on this stand: earning governance is not his
        // doing at all (the threshold is reached by strangers), and naming the
        // successor IS the handover rather than a step of the removal.
        _setUniqueActiveUsers(ArbiterRegistryFacet(address(diamond)).getDaoThreshold());
        ArbiterRegistryFacet(address(diamond)).setDAOAddress(dao);

        // And from here he is shut out — checked, not assumed. Without this the
        // test would still pass if the owner had kept the accusation door, and
        // "the successor can" would say nothing about "the owner need not".
        vm.expectRevert(ArbiterAccountabilityFacet.RemovalHandedOver.selector);
        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), PROPOSAL_WORDS
        );

        // Everything below is the successor's own hand, and nothing else runs.
        vm.prank(dao);
        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), PROPOSAL_WORDS
        );
        vm.warp(
            vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getRemovalDelay()
        );
        vm.prank(dao);
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), address(0),
            PROPOSAL_WORDS
        );

        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"преемник прошёл весь путь сам — предложил, выждал, снёс"
        );
        assertFalse(
            ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter),
            unicode"и его собственное предложение исполнилось, а не повисло"
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

        vm.expectRevert(ArbiterAccountabilityFacet.RemovalSuspensionIsRemovalAuthorityOnly.selector);
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

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("chat log"));
        uint256 removedAtTs = vm.getBlockTimestamp();
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("chat log"), address(0),
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
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

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("chat log"));
        uint256 removedAtTs = vm.getBlockTimestamp();
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("chat log"), address(0),
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
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
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"));
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), address(0),
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
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
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"));
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), address(0),
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
        );
        vm.prank(arbiter);
        ArbiterAccountabilityFacet(address(diamond)).respondToRemoval(keccak256("my side"), "");

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
        ArbiterAccountabilityFacet(address(diamond)).respondToRemoval(keccak256("phantom"), "");
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

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"));
        uint256 removedAtTs = vm.getBlockTimestamp();
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), address(0),
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
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

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"));
        uint256 removedAtTs = vm.getBlockTimestamp();
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), address(0),
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
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
        _proposeAndWait(human, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"));
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            human, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), address(0),
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
        );
        bytes32 reply = keccak256("my side");
        _forward(
            fwd, pk, human,
            // ⚠️ Аргументов два с 17 августа 2026 (слова ответа). Селектор
            // берётся от типа — смену подписи подхватывает компилятор, а не
            // человек, читающий этот файл.
            abi.encodeWithSelector(ArbiterAccountabilityFacet.respondToRemoval.selector, reply, "")
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
    //  ONE VERDICT, AT MOST ONE JUDICIAL MISTAKE (task 11, 18 August 2026)
    //
    //  overturnVerdict wrote v.overturned and never read it back as a
    //  refusal. Three calls against the SAME agreement, inside one block,
    //  reached MAX_ARBITER_MISTAKES — so the price of unseating an arbiter
    //  was one submitted verdict, not three disputes.
    //
    //  The gate closes that. Where it sits among the three older checks is a
    //  property of its own, and the two scenes below pin it: both states are
    //  reachable with `overturned` already true, and in both the older reason
    //  is the more final of the two and must survive.
    //
    //  ⚠️ THE GATE WAS ONLY HALF OF IT (review round 1, same day). Hand first
    //  and panel second stayed open — deliberately, the appeal is the only
    //  check on that door — and booked the second mistake there instead, so
    //  unseating an arbiter still cost two disputes rather than three. That
    //  half is closed inside resolveAppeal; the scenes for it live in
    //  test/Diamond.t.sol, where the appeal machinery is.
    // ============================================================

    /// The price of unseating an arbiter must not equal one submitted verdict.
    ///
    /// `_disputeAndOverturn` is the file's own way in: it builds the dispute,
    /// submits the verdict AND performs the first overturn. No second way of
    /// building one is written here.
    function test_OneVerdictCannotBeOverturnedThreeTimes() public {
        address agreement = _disputeAndOverturn(address(0x661), address(0x662));

        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 1,
            "first overturn counts once"
        );

        vm.expectRevert(ArbiterRegistryFacet.AlreadyOverturned.selector);
        ArbiterRegistryFacet(address(diamond)).overturnVerdict(agreement, false);

        vm.expectRevert(ArbiterRegistryFacet.AlreadyOverturned.selector);
        ArbiterRegistryFacet(address(diamond)).overturnVerdict(agreement, true);

        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 1,
            "one verdict, one mistake"
        );
        assertTrue(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            "still seated after one bad verdict"
        );
    }

    /// Placement, half one: overturned AND finalized is a reachable state —
    /// finalizeVerdict leaves `overturned` standing, it only adds `finalized`.
    /// The refusal a person reads there must stay AlreadyFinalized: the verdict
    /// is over, which is the larger fact. Lifting the new gate above the
    /// finalized check swaps the reason and says the smaller one instead.
    ///
    /// ⚠️ vm.getBlockTimestamp(), not block.timestamp: under via_ir solc treats
    /// TIMESTAMP as constant within a call (docs/OPEN-ITEMS.md, item 57).
    function test_OverturnedThenFinalizedStillRefusesAsFinalized() public {
        address agreement = _disputeAndOverturn(address(0x663), address(0x664));

        vm.warp(vm.getBlockTimestamp() + 24 hours + 1); // FINALIZE_DELAY
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(agreement);

        vm.expectRevert(ArbiterRegistryFacet.AlreadyFinalized.selector);
        ArbiterRegistryFacet(address(diamond)).overturnVerdict(agreement, true);
    }

    // ============================================================
    //  ЗАПИСЬ ОБ АВТОСНЯТИИ НАЗЫВАЕТ ПРОИСХОЖДЕНИЕ (п. 65, 16 августа 2026)
    //
    //  Тремя перевёрнутыми вердиктами владелец снимает арбитра, минуя дверь с
    //  поводом. Прежнее событие из одного поля читалось как автоматика — то
    //  есть валило вину на снятого. Путей у автоснятия ровно три, и каждый
    //  обязан быть назван своим.
    //
    //  ⚠️ Три вердикта, а не три нажатия по одному: с задачи 11 (18 августа
    //  2026) перевёрнутый вердикт отказывает AlreadyOverturned. Обе сцены
    //  ниже строят по ТРИ РАЗНЫХ спора — свойство сцены от этого не изменилось,
    //  изменилась только цена.
    // ============================================================

    /// Путь первый: владелец переворачивает вердикт.
    ///
    /// ⚠️ СЦЕНА ПЕРЕСТРОЕНА ЗАДАЧЕЙ 12 (18 августа 2026), и вместе с ней
    /// перевернулось проверяемое свойство. Раньше третий переворот СНИМАЛ
    /// арбитра и `ArbiterDemoted` обязано было НАЗВАТЬ нажавшего — тест
    /// сторожил, что запись не свалит вину на владельца, когда нажал не он.
    /// Теперь третий переворот не снимает: он приостанавливает и открывает
    /// обвинение ОТ ИМЕНИ ЦЕПИ, и обвинителя у него нет вовсе — поле `by` в
    /// записи нулевое, а в событии такого поля нет по устройству.
    ///
    /// Свойство стало сильнее, а не слабее: прежнее держалось на том, что в
    /// событие кладут правильный адрес (подмена давала 0 красных из 840, пока
    /// не написали сцену с ДАО ниже), нынешнее — на том, что класть некуда.
    ///
    /// ⚠️ Три РАЗНЫХ спора (задача 11): перевёрнутый вердикт отказывает
    /// AlreadyOverturned.
    function test_TheChainsAccusationNamesNobodyOnTheOverturnPath() public {
        _disputeAndOverturn(address(0x651), address(0x652));
        _disputeAndOverturn(address(0x653), address(0x654));

        address agr = _disputeAndSubmit(address(0x655), address(0x656));

        vm.expectEmit(true, true, true, true, address(diamond));
        emit ArbiterRegistryFacet.RemovalProposedByChain(
            arbiter,
            uint8(ArbiterRegistryFacet.DemotionPath.OwnerOverturn),
            agr,
            vm.getBlockTimestamp()
        );
        ArbiterRegistryFacet(address(diamond)).overturnVerdict(agr, false);

        assertTrue(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"третий переворот больше НЕ снимает — он обвиняет"
        );
        (, , , address by, bool live) =
            ArbiterAccountabilityFacet(address(diamond)).getRemovalProposal(arbiter);
        assertTrue(live, unicode"обвинение живо");
        assertEq(by, address(0), unicode"и ничьё: нажал человек, а обвиняет цепь");
    }

    /// Тот же путь первый, но НАЖИМАЕТ НЕ ВЛАДЕЛЕЦ (круг правок 1, 16 августа
    /// 2026). Без этой сцены центральное свойство задачи не сторожилось ничем:
    /// во всём наборе owner == address(this), overturnVerdict нигде не звалась
    /// под vm.prank, и подмена `by` на OwnershipLib.contractOwner() давала НОЛЬ
    /// красных из 840 — тесты доказывали «запись называет владельца», а не
    /// «запись называет нажавшего».
    ///
    /// Сцена боевая, а не выдуманная: onlyOwnerOrDAO пускает и адрес
    /// управления, а сажает его туда setDAOAddress.
    ///
    /// ⚠️ `activateDAO()` ЗДЕСЬ НЕТ НАМЕРЕННО (Ruling 24, 16 августа 2026), и
    /// это не забывчивость. Совместное право начинается с НАЗНАЧЕНИЯ адреса, а
    /// не с активации управления — модификатор `onlyOwnerOrDAO` активацию не
    /// спрашивает вовсе. Со строкой активации сцена перестала бы это проверять:
    /// замер «загейтить ДАО-ветку модификатора через isDaoActive()» давал
    /// 0 красных из 855, потому что в единственной сцене с ДАО управление было
    /// заодно и активным. Без строки свойство прибито тестом (тот же замер —
    /// 1 красный, этот тест, причина подтверждена трассой: `NotOwnerOrDAO()`),
    /// и всякая будущая попытка загейтить ветку потребует ОСОЗНАННОГО решения,
    /// а не пройдёт молча.
    ///
    /// Ту сторону вопроса, стоит ли гейтить, тест не решает — он лишь не даёт
    /// поменять поведение незаметно. Сам разбор храповика (владелец
    /// переназначает адрес свободно до isDaoActive(), а после — уже нет) лежит
    /// в OPEN-ITEMS.
    function test_TheChainsAccusationNamesNobodyEvenWhenTheDaoPressed() public {
        address dao = address(0x6D40);
        ArbiterRegistryFacet(address(diamond)).setDAOAddress(dao);
        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isDaoActive(),
            unicode"сетап: управление НАЗНАЧЕНО, но не активировано — права уже есть"
        );
        assertTrue(dao != owner, unicode"сетап: нажимающий и владелец — РАЗНЫЕ адреса");

        // Первые две ошибки нажимает владелец, третью — управление.
        //
        // ⚠️ Задача 12 перестроила сцену вместе с соседней: раньше здесь
        // сторожилось «запись называет НАЖАВШЕГО, а не владельца по умолчанию»
        // (замер: 0 красных из 840 без этой сцены). Теперь запись не называет
        // НИКОГО, и эта сцена сторожит, что «никого» означает именно никого —
        // а не «того, чей адрес случайно оказался под рукой». Нажимает адрес,
        // ОТЛИЧНЫЙ от владельца; появись в обвинении чьё-нибудь имя, оно было
        // бы видно здесь.
        //
        // ⚠️ Три РАЗНЫХ спора (задача 11), см. сцену выше.
        _disputeAndOverturn(address(0x65B), address(0x65C));
        _disputeAndOverturn(address(0x65D), address(0x65E));

        address agr = _disputeAndSubmit(address(0x65F), address(0x660));

        vm.expectEmit(true, true, true, true, address(diamond));
        emit ArbiterRegistryFacet.RemovalProposedByChain(
            arbiter,
            uint8(ArbiterRegistryFacet.DemotionPath.OwnerOverturn),
            agr,
            vm.getBlockTimestamp()
        );
        vm.prank(dao);
        ArbiterRegistryFacet(address(diamond)).overturnVerdict(agr, false);

        (, , , address by, ) =
            ArbiterAccountabilityFacet(address(diamond)).getRemovalProposal(arbiter);
        assertEq(by, address(0), unicode"нажало управление — а обвинения ничьи");
        assertTrue(by != dao, unicode"и уж точно не его имя");
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
    function test_TheChainsAccusationNamesNobodyOnTheTimeoutPath() public {
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
        emit ArbiterRegistryFacet.RemovalProposedByChain(
            arbiter,
            uint8(ArbiterRegistryFacet.DemotionPath.AgreementTimeout),
            agr,
            vm.getBlockTimestamp()
        );
        vm.prank(cli);
        Agreement(agr).triggerArbiterTimeout();

        // ⚠️ И ГЛАВНОЕ ЗДЕСЬ — ЧТО ОНО ВООБЩЕ СЛУЧИЛОСЬ. Этот путь Agreement
        // исполняет внутри ПУСТОГО try/catch: ревёрт был бы проглочен молча, и
        // «не наказали вовсе» выглядело бы снаружи точно так же, как
        // «наказали». Задача 12 добавила в эту ветку запись предложения —
        // безревёртную по построению, и вот доказательство, что она доехала.
        assertTrue(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"третья ошибка таймаутом больше не снимает — она обвиняет"
        );
        assertTrue(ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter));
    }

    /// Путь третий: апелляция. Нажавшего тоже нет — resolveAppeal звать может
    /// кто угодно, и записать его как виновника было бы худшей из трёх
    /// возможных неправд: решают ГОЛОСА, а не тот, кто нажал «подвести итог».
    /// `by` нулевой, голосовавшие читаются из AppealVoteCast по тому же
    /// агрименту.
    function test_TheChainsAccusationNamesNobodyOnTheAppealPath() public {
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
        emit ArbiterRegistryFacet.RemovalProposedByChain(
            arbiter,
            uint8(ArbiterRegistryFacet.DemotionPath.AppealVote),
            agr,
            vm.getBlockTimestamp()
        );
        ArbiterRegistryFacet(address(diamond)).resolveAppeal(agr);

        assertTrue(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"голоса перевернули вердикт — третья ошибка подряд, и она обвиняет, а не снимает"
        );
        (, , , address by, bool live) =
            ArbiterAccountabilityFacet(address(diamond)).getRemovalProposal(arbiter);
        assertTrue(live);
        assertEq(by, address(0), unicode"решали ГОЛОСА — назвать нажавшего «подвести итог» было бы худшей неправдой");
    }

    // ============================================================
    //  ВЕЧНАЯ ЗАПИСЬ О СНОСАХ (п. 72, 16 августа 2026)
    //
    //  removedAt и removalReply стираются любой повторной посадкой, и это
    //  верно: они отвечают на вопрос «отвечал ли он на ТЕКУЩЕЕ обвинение».
    //  Но тогда карточка показывает чистого человека тому, кого сносили
    //  трижды, — а стирающая дверь принадлежит обвинителю (addArbiter) и,
    //  после включения ДАО, самому обвиняемому (applyAsArbiter).
    // ============================================================

    /// Снос по поводу → посадка обратно → снос по ДРУГОМУ поводу.
    /// Стираемая половина обнуляется, вечная растёт.
    function test_StandingRemembersRemovalsAcrossReseating() public {
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"));
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), address(0),
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
        );

        (, , , , , , , , , uint256 removedAt1, , uint256 count1, uint256 lastAt1, uint8 cause1)
            = ArbiterAccountabilityFacet(address(diamond)).getArbiterStanding(arbiter);
        assertGt(removedAt1, 0, unicode"текущий снос отмечен");
        assertEq(count1, 1, unicode"сносов один");
        assertEq(lastAt1, vm.getBlockTimestamp(), unicode"момент последнего сноса записан");
        assertEq(cause1, uint8(ArbiterAccountabilityFacet.Cause.Collusion) + 1,
            unicode"повод записан со сдвигом: ноль обязан значить «не снимали»");

        ArbiterRegistryFacet(address(diamond)).addArbiter(arbiter);

        (, , , , , , , , , uint256 removedAt2, , uint256 count2, uint256 lastAt2, uint8 cause2)
            = ArbiterAccountabilityFacet(address(diamond)).getArbiterStanding(arbiter);
        assertEq(removedAt2, 0, unicode"текущего сноса нет — его отменили посадкой");
        assertEq(count2, 1, unicode"а прошлый снос посадка не стирает");
        assertEq(lastAt2, lastAt1, unicode"момент прошлого сноса остался");
        assertEq(cause2, cause1, unicode"повод прошлого сноса остался");

        vm.warp(vm.getBlockTimestamp() + 1 days);
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("leak"));
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("leak"), address(0),
            unicode"выложил переписку по спору третьей стороне"
        );

        (, , , , , , , , , , , uint256 count3, uint256 lastAt3, uint8 cause3)
            = ArbiterAccountabilityFacet(address(diamond)).getArbiterStanding(arbiter);
        assertEq(count3, 2, unicode"второй снос — счётчик два");
        assertEq(lastAt3, vm.getBlockTimestamp(), unicode"момент обновился на последний");
        assertEq(cause3, uint8(ArbiterAccountabilityFacet.Cause.Leak) + 1, unicode"повод обновился");
    }

    /// Автодемоушен — тоже снос, и он тоже помнится. Повода у него нет:
    /// цепь сняла арбитра по серии ошибок, а не по чьему-то обвинению, и
    /// код это говорит прямо, а не притворяется поводом номер ноль.
    ///
    /// Но «повода нет» ещё не значит «сказать нечего». Путь первый:
    /// переворот владельцем. Код обязан отличаться от кодов двух других
    /// путей — иначе различие, ради которого задача 4 потратила отдельное
    /// поле события, теряется в ЕДИНСТВЕННОМ читаемом месте (п. 72: логи не
    /// читает никто).
    function test_AutoDemotionByOverturnRecordsItsOwnPath() public {
        _disputeAndOverturn(address(0x721), address(0x722));
        _disputeAndOverturn(address(0x723), address(0x724));
        _disputeAndOverturn(address(0x725), address(0x726));

        // ⚠️ ЗАДАЧА 12 (18 августа 2026): третья ошибка обвиняет, а снимает
        // общая дверь через двое суток. Карточка обязана назвать путь
        // по-прежнему — ради этого и заведено chainProposalPath: путь известен
        // в момент ошибки, а записывается в момент сноса.
        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getRemovalDelay());
        vm.prank(STRANGER);
        ArbiterAccountabilityFacet(address(diamond)).executeChainRemoval(arbiter);

        assertFalse(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter));

        (, , , , , , , , , , , uint256 count, uint256 lastAt, uint8 cause)
            = ArbiterAccountabilityFacet(address(diamond)).getArbiterStanding(arbiter);
        assertEq(count, 1, unicode"автомат снял — счётчик вырос так же, как от руки");
        assertEq(lastAt, vm.getBlockTimestamp(), unicode"момент автоснятия записан — момент СНОСА, не момент ошибки");
        assertEq(cause, AUTO_OVERTURN,
            unicode"карточка называет путь: снял ПЕРЕВОРОТ, а не таймаут и не голоса");
        assertTrue(cause != AUTO_TIMEOUT,
            unicode"и он обязан отличаться от таймаута");
        assertTrue(cause != AUTO_APPEAL,
            unicode"и от голосов по апелляции");
    }

    /// Путь второй в карточке: агримент сообщил о таймауте. Сцена та же, что
    /// у test_ArbiterDemotedNamesNobodyOnTheTimeoutPath, но проверяется
    /// ДРУГОЕ место — не лента, а карточка. Разделять пришлось потому, что
    /// именно карточку и читают.
    function test_AutoDemotionByTimeoutRecordsItsOwnPath() public {
        _disputeAndOverturn(address(0x727), address(0x728));
        _disputeAndOverturn(address(0x729), address(0x72A));

        address cli = address(0x72B);
        address exec = address(0x72C);
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

        // DISPUTE_WINDOW = 4 days; строго БОЛЬШЕ.
        vm.warp(vm.getBlockTimestamp() + 4 days + 1);
        vm.prank(cli);
        Agreement(agr).triggerArbiterTimeout();

        // ⚠️ ЗАДАЧА 12 (18 августа 2026): третья ошибка обвиняет, а снимает
        // общая дверь через двое суток. Карточка обязана назвать путь
        // по-прежнему — ради этого и заведено chainProposalPath: путь известен
        // в момент ошибки, а записывается в момент сноса.
        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getRemovalDelay());
        vm.prank(STRANGER);
        ArbiterAccountabilityFacet(address(diamond)).executeChainRemoval(arbiter);

        assertFalse(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter));

        (, , , , , , , , , , , uint256 count, , uint8 cause)
            = ArbiterAccountabilityFacet(address(diamond)).getArbiterStanding(arbiter);
        assertEq(count, 1, unicode"таймаут снял — счётчик вырос");
        assertEq(cause, AUTO_TIMEOUT,
            unicode"карточка называет путь: снял ТАЙМАУТ");
        assertTrue(cause != AUTO_OVERTURN,
            unicode"и он обязан отличаться от переворота владельцем");
    }

    /// Путь третий в карточке: перевернули ГОЛОСА по апелляции. Самый
    /// нагруженный смыслом из трёх: «снят автоматом» и «снят решением
    /// коллегии» — разные вещи для того, кто читает карточку арбитра.
    function test_AutoDemotionByAppealRecordsItsOwnPath() public {
        _disputeAndOverturn(address(0x72D), address(0x72E));
        _disputeAndOverturn(address(0x72F), address(0x730));

        address v1 = address(0x7A1);
        address v2 = address(0x7A2);
        address v3 = address(0x7A3);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v1);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v2);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v3);

        address cli = address(0x731);
        address exec = address(0x732);
        address agr = _disputeAndSubmit(cli, exec);
        usdc.mint(exec, 100 * 10 ** 6);
        vm.prank(exec);
        usdc.approve(address(diamond), 20 * 10 ** 6);
        vm.prank(exec);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);

        vm.prank(v1);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);
        vm.prank(v2);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);
        vm.prank(v3);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, false);

        ArbiterRegistryFacet(address(diamond)).resolveAppeal(agr);

        // ⚠️ ЗАДАЧА 12 (18 августа 2026): третья ошибка обвиняет, а снимает
        // общая дверь через двое суток. Карточка обязана назвать путь
        // по-прежнему — ради этого и заведено chainProposalPath: путь известен
        // в момент ошибки, а записывается в момент сноса.
        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getRemovalDelay());
        vm.prank(STRANGER);
        ArbiterAccountabilityFacet(address(diamond)).executeChainRemoval(arbiter);

        assertFalse(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter));

        (, , , , , , , , , , , uint256 count, , uint8 cause)
            = ArbiterAccountabilityFacet(address(diamond)).getArbiterStanding(arbiter);
        assertEq(count, 1, unicode"голоса сняли — счётчик вырос");
        assertEq(cause, AUTO_APPEAL,
            unicode"карточка называет путь: сняли ГОЛОСА");
        assertTrue(cause != AUTO_OVERTURN,
            unicode"и он обязан отличаться от переворота владельцем");
    }

    /// Самая острая половина: после включения ДАО стирающая дверь достаётся
    /// САМОМУ обвиняемому. applyAsArbiter зовёт тот же clearRemovalRecord —
    /// и не должен уносить с собой историю.
    function test_SelfRegistrationCannotEraseTheRemovalHistory() public {
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"));
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), address(0),
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
        );

        _setUniqueActiveUsers(ArbiterRegistryFacet(address(diamond)).getDaoThreshold());
        _grantSelfRegistrationGate(arbiter);
        vm.prank(arbiter);
        ArbiterRegistryFacet(address(diamond)).applyAsArbiter();
        assertTrue(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"сетап: самозапись прошла"
        );

        (, , , , , , , , , uint256 removedAt, , uint256 count, , uint8 cause)
            = ArbiterAccountabilityFacet(address(diamond)).getArbiterStanding(arbiter);
        assertEq(removedAt, 0, unicode"текущий снос самозапись снимает — это её право");
        assertEq(count, 1, unicode"а историю обвиняемый обнулить не может");
        assertEq(cause, uint8(ArbiterAccountabilityFacet.Cause.Collusion) + 1,
            unicode"и повод прошлого сноса остаётся читаемым");
    }

    // ============================================================
    //  ФАКТ, НА КОТОРЫЙ ОПИРАЕТСЯ ПУБЛИЧНЫЙ ТЕКСТ (п. 64, 16 августа 2026)
    // ============================================================

    /// Факт, который утверждает docs/DECENTRALIZATION.md после правки
    /// 16 августа 2026: снос форфейтит ТОТ залог, который есть, — а у арбитра
    /// ручной посадки его нет вовсе.
    ///
    /// Ненулевой `arbiterBond` пишет ровно одна строка во всём `src/` —
    /// `ArbiterRegistryFacet.applyAsArbiter`, а она первой же строкой ревертит
    /// `DAONotActive`, пока ДАО выключена (решение владельца 1 августа 2026:
    /// арбитры на старте ручные и свои). Значит у всякого, кого сегодня
    /// физически можно снести, `bondForfeited` доказуемо ноль — и публичный
    /// документ обязан говорить именно это, а не пугать полусотней долларов,
    /// которой не существует.
    ///
    /// ⚠️ Этот тест НЕ сторожит ТЕКСТ документа. Сторожить текст значило бы
    /// сторожить не работу — тот самый класс «замок ищет имя, а не
    /// употребление», давший в этом проекте 0 красных из 497 и 0 из 568
    /// (docs/PROCESS.md). Он сторожит ФАКТ, на который текст опирается:
    /// испорти факт — покраснеет здесь. Обратную порчу (кто-то вернёт враньё
    /// в документ) не ловит ничто, и это записано честно, а не закрыто
    /// видимостью проверки.
    function test_HandSeatedArbiterHasNoBondToBurn() public {
        address seat = address(0x6401);
        ArbiterRegistryFacet(address(diamond)).addArbiter(seat);

        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getArbiterBond(seat), 0,
            unicode"ручная посадка залога не берёт — README.md говорит правду"
        );

        uint256 vaultBefore = ArbiterRegistryFacet(address(diamond)).getVaultBalance();

        // Шестое поле события — bondForfeited. Ноль здесь и есть то, что
        // читатель цепи увидит на любом сегодняшнем сносе.
        _proposeAndWait(seat, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("chat log"));
        vm.expectEmit(true, true, true, true, address(diamond));
        emit ArbiterAccountabilityFacet.ArbiterRemovedForCause(
            seat, owner, ArbiterAccountabilityFacet.Cause.Collusion, false, keccak256("chat log"), 0
        );
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            seat, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("chat log"), address(0),
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
        );

        assertEq(
            ArbiterRegistryFacet(address(diamond)).getVaultBalance(), vaultBefore,
            unicode"сжигать нечего — банк арбитров не вырос ни на цент"
        );
    }

    // ============================================================
    //  ЗАДАЧА 12 (18 августа 2026): ТИХАЯ ДВЕРЬ ЗАВОДИТСЯ В ОБЩУЮ
    //
    //  Третья судейская ошибка снимала арбитра на месте: ни предложения, ни
    //  паузы, ни слов, ни совпадения повода. Задача 2 сделала честную дверь
    //  дорогой (48 часов и объяснение), а эта осталась бесплатной — и, что
    //  решило дело, ПЕРЕЖИВАЛА ПЕРЕДАЧУ ПРАВА: overturnVerdict стоит под
    //  onlyOwnerOrDAO, а тот пускает владельца всегда.
    //
    //  Стало: третья ошибка приостанавливает и открывает предложение ОТ ИМЕНИ
    //  ЦЕПИ. Снос идёт общей дверью, и через 48 часов нажать может кто угодно.
    // ============================================================

    /// Ядро задачи: кресло переживает автоматический путь, а человек
    /// останавливается немедленно и оказывается обвинён.
    function test_ThirdMistakeSuspendsAndAccuses_ButDoesNotUnseat() public {
        address judged = arbiter;
        _giveBond(judged, ARBITER_BOND);
        _threeOverturnsOnDistinctDisputes(judged);

        assertTrue(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(judged),
            unicode"кресло переживает автоматический путь"
        );
        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(judged),
            unicode"но остановлен он прямо сейчас — приостановка и есть быстрый путь"
        );
        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(judged),
            unicode"и цепь его обвинила"
        );

        (uint8 cause, bytes32 digest, uint256 proposedAt, address by, ) =
            ArbiterAccountabilityFacet(address(diamond)).getRemovalProposal(judged);
        assertEq(by, address(0), unicode"обвинитель — цепь, ничьё имя не названо");
        assertEq(digest, bytes32(0), unicode"отпечатка нет: улика — состояние самой цепи");
        assertEq(proposedAt, vm.getBlockTimestamp(), unicode"часы пошли с этой секунды");
        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getArbiterBond(judged), ARBITER_BOND,
            unicode"залог ещё не сгорел — обвинение не снос"
        );
        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getArbiterMistakeStreak(judged), 3,
            unicode"счётчик СТОИТ: серия не кончилась оттого, что цепь её заметила"
        );

        // ⚠️ Ожидаемое взято из ЧУЖОГО файла — перечисления
        // ArbiterAccountabilityFacet.Cause, — а фактическое прочитано с цепи.
        // Это и есть сторож зеркала CAUSE_*_MIRROR в реестре: переставьте
        // перечисление, и сравнение разойдётся (docs/PROCESS.md, четвёртый
        // способ — ожидаемое не должно выводиться из проверяемого).
        assertEq(
            cause, uint8(ArbiterAccountabilityFacet.Cause.OverturnedVerdicts),
            unicode"путь переворота обязан лечь поводом OverturnedVerdicts"
        );
    }

    /// Через 48 часов жмёт кто угодно. Права РЕШАТЬ он не получает — всё
    /// решено до него; он получает право нажать.
    function test_AnyoneMayPressAfterThePause() public {
        address judged = arbiter;
        _giveBond(judged, ARBITER_BOND);
        _threeOverturnsOnDistinctDisputes(judged);
        uint256 vaultBefore = ArbiterRegistryFacet(address(diamond)).getVaultBalance();

        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getRemovalDelay());

        vm.prank(STRANGER);
        ArbiterAccountabilityFacet(address(diamond)).executeChainRemoval(judged);

        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(judged),
            unicode"кресла нет"
        );
        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getArbiterBond(judged), 0,
            unicode"залог сгорает НА СНОСЕ, а не на обвинении"
        );
        assertEq(
            ArbiterRegistryFacet(address(diamond)).getVaultBalance(), vaultBefore + ARBITER_BOND,
            unicode"и уходит в банк арбитров, как у ручной двери"
        );
        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getArbiterMistakeStreak(judged), 0,
            unicode"счётчик обнуляется НА СНОСЕ: улика потрачена тем сносом, который на ней построен"
        );
        // Момент сноса отмечен — иначе отвечать было бы не на что. Читается
        // через карточку: отдельного геттера removedAt в фасете нет.
        (, , , , , , , , , uint256 removedAt, , , , ) =
            ArbiterAccountabilityFacet(address(diamond)).getArbiterStanding(judged);
        assertGt(removedAt, 0, unicode"момент сноса отмечен");
        assertFalse(
            ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(judged),
            unicode"предложение потрачено"
        );
    }

    /// ⚠️ ЧТО ДЕЛАЕТ ВЕТКА ПОРОГА СО СЧЁТЧИКОМ — И ПОЧЕМУ ЭТО ВАЖНО ПОСЛЕ C-1.
    ///
    /// Имя и тело этой сцены переписаны кругом правок 2. Она называлась
    /// «обвинение цепи всё ещё доказуемо, когда нажимают кнопку» и нажимала
    /// кнопку — но с решения C-1 кнопка повод не перепроверяет вовсе и
    /// срабатывает при счётчике 0, так что имя обещало неправду, а нажатие
    /// ничего про счётчик не доказывало. Замер ревью показал это числом:
    /// обнулить счётчик на пороге — пять красных, и НИ ОДНОЙ про нажатие.
    ///
    /// Что охраняется теперь — настоящее последствие сохранения счётчика:
    /// серия судейских ошибок не кончилась оттого, что цепь её заметила, и
    /// РУЧНАЯ дверь обязана суметь ею воспользоваться. Сцена проходит этот
    /// путь целиком: обвинение цепи никто не нажал, оно протухло за
    /// PROPOSAL_TTL — и держатель права сносит по той же, никуда не девшейся
    /// улике.
    function test_TheThresholdKeepsTheStreakForTheManualDoor() public {
        _threeOverturnsOnDistinctDisputes(arbiter);
        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 3,
            unicode"серия не кончилась оттого, что цепь её заметила"
        );

        // Кнопку не нажал никто, обвинение цепи протухло само.
        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getProposalTTL());
        assertFalse(
            ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter),
            unicode"сетап: дверь снова свободна"
        );
        assertTrue(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter));

        // И улика по-прежнему годится: держатель права доказывает ею повод.
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0));
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), ""
        );

        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"счётчик, переживший обвинение, доказал повод человеку"
        );
    }

    function test_TheButtonRefusesBeforeThePause() public {
        _threeOverturnsOnDistinctDisputes(arbiter);
        (, , uint256 proposedAt, , ) =
            ArbiterAccountabilityFacet(address(diamond)).getRemovalProposal(arbiter);

        vm.prank(STRANGER);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArbiterAccountabilityFacet.RemovalTooEarly.selector,
                proposedAt + ArbiterAccountabilityFacet(address(diamond)).getRemovalDelay()
            )
        );
        ArbiterAccountabilityFacet(address(diamond)).executeChainRemoval(arbiter);

        assertTrue(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"и за отказом ничего не произошло"
        );
    }

    /// Верхняя граница окна — та же, что у общей двери: протухшее предложение
    /// не исполняет никто, включая кнопку.
    function test_TheButtonRefusesAfterTheProposalGoesStale() public {
        _threeOverturnsOnDistinctDisputes(arbiter);
        (, , uint256 proposedAt, , ) =
            ArbiterAccountabilityFacet(address(diamond)).getRemovalProposal(arbiter);

        vm.warp(proposedAt + ArbiterAccountabilityFacet(address(diamond)).getProposalTTL());
        vm.prank(STRANGER);
        vm.expectRevert(
            abi.encodeWithSelector(ArbiterAccountabilityFacet.ProposalStale.selector, proposedAt)
        );
        ArbiterAccountabilityFacet(address(diamond)).executeChainRemoval(arbiter);
    }

    /// Перебить нечем: посторонний не исполняет ЧЕЛОВЕЧЕСКОЕ обвинение.
    /// Условие владельца «главное чтобы её перебить не канало».
    function test_StrangerCannotPressAHumanAccusation() public {
        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, DIGEST,
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
        );
        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getRemovalDelay());

        vm.prank(STRANGER);
        vm.expectRevert(ArbiterAccountabilityFacet.NotAChainProposal.selector);
        ArbiterAccountabilityFacet(address(diamond)).executeChainRemoval(arbiter);

        assertTrue(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"человеческое обвинение исполняет держатель права, и только он"
        );
    }

    /// ⚠️ ПОРЯДОК ДВУХ ПЕРВЫХ ОТКАЗОВ — НЕСУЩЕЕ СВОЙСТВО, а не оформление.
    /// Предложение СВЕЖЕЕ и человеческое: если бы проверка «чья дверь» стояла
    /// НИЖЕ часов, посторонний получил бы RemovalTooEarly(момент) — то есть
    /// узнал бы, что против арбитра висит обвинение и когда оно созреет.
    /// Ровно эту утечку задача 10 сторожила на proposeRemoval
    /// (test_StrangerLearnsNothingAboutALiveProposal); переставьте две строки
    /// в executeChainRemoval — и покраснеет здесь.
    function test_TheButtonRefusesTheWrongDoorBeforeItMentionsTheClock() public {
        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, DIGEST,
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
        );

        // Часы ещё идут: до конца паузы далеко.
        vm.prank(STRANGER);
        vm.expectRevert(ArbiterAccountabilityFacet.NotAChainProposal.selector);
        ArbiterAccountabilityFacet(address(diamond)).executeChainRemoval(arbiter);
    }

    /// Пустая запись отвечает «обвинения нет», а не «дверь не та»: посторонний
    /// не должен по ярлыку ошибки отличать «против него ничего» от «против
    /// него человеческое».
    function test_TheButtonSaysNothingStandsWhenNothingStands() public {
        vm.prank(STRANGER);
        vm.expectRevert(ArbiterAccountabilityFacet.NoLiveProposal.selector);
        ArbiterAccountabilityFacet(address(diamond)).executeChainRemoval(arbiter);
    }

    /// ⚠️ ЦЕПЬ МОЛЧА УСТУПАЕТ. `_recordArbiterMistake` приходит из
    /// notifyArbiterTimeout, а ту Agreement исполняет внутри ПУСТОГО
    /// try/catch: ревёрт был бы проглочен молча, и арбитр остался бы
    /// ненаказанным без единого следа. Значит чужие часы не сбрасываются,
    /// чужой обвинитель не затирается, и ничего не ревертит.
    function test_ChainYieldsToALiveHumanProposalWithoutReverting() public {
        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, DIGEST,
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
        );
        (uint8 cause0, bytes32 digest0, uint256 before, address by0, ) =
            ArbiterAccountabilityFacet(address(diamond)).getRemovalProposal(arbiter);

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _threeOverturnsOnDistinctDisputes(arbiter); // обязано не ревертить

        (uint8 cause1, bytes32 digest1, uint256 afterTs, address by1, ) =
            ArbiterAccountabilityFacet(address(diamond)).getRemovalProposal(arbiter);
        assertEq(afterTs, before, unicode"человеческие часы не тронуты");
        assertEq(by1, by0, unicode"человеческий обвинитель не тронут");
        assertEq(cause1, cause0, unicode"и повод его же");
        assertEq(digest1, digest0, unicode"и отпечаток его же");
        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter),
            unicode"а приостановка всё равно легла: быстрый рычаг безусловен"
        );
        assertGe(
            ArbiterAccountabilityFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 3,
            unicode"улика сохранена для следующей попытки — счётчик не обнулён"
        );
    }

    /// Отзыв предложения цепи возвращает человека в строй ПОЛНОСТЬЮ: иначе
    /// оправданный остаётся навсегда в одном перевороте от нового обвинения.
    function test_WithdrawingTheChainAccusationClearsTheStreak() public {
        ArbiterRegistryFacet(address(diamond)).setChiefArbiter(CHIEF);
        _threeOverturnsOnDistinctDisputes(arbiter);

        vm.prank(CHIEF);
        ArbiterAccountabilityFacet(address(diamond)).withdrawProposal(arbiter);

        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 0,
            unicode"один переворот не должен снова обвинять"
        );
        assertFalse(ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter));
        assertTrue(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"он и не переставал быть арбитром"
        );
    }

    /// Обратная сторона: отзыв ЧЕЛОВЕЧЕСКОГО обвинения счётчик НЕ трогает —
    /// иначе пара «предложил-отозвал» отмывала бы настоящую серию ошибок.
    function test_WithdrawingAHumanProposalLeavesTheStreakAlone() public {
        _disputeAndOverturn(address(0x9B1), address(0x9B2));
        _disputeAndOverturn(address(0x9B3), address(0x9B4));
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 2);

        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, DIGEST,
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
        );
        ArbiterAccountabilityFacet(address(diamond)).withdrawProposal(arbiter);

        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 2,
            unicode"ошибки арбитра никуда не делись оттого, что обвинитель передумал"
        );
    }

    /// Директор отзывает обвинение цепи — названо вслух и принято: он получает
    /// возможность прикрыть своего, но только с именем в цепи. Ключевое здесь
    /// то, что `by == address(0)` не отказывает ему по NotYourProposal.
    function test_ChiefMayWithdrawTheChainAccusationHeDidNotLay() public {
        ArbiterRegistryFacet(address(diamond)).setChiefArbiter(CHIEF);
        _threeOverturnsOnDistinctDisputes(arbiter);

        vm.expectEmit(true, true, false, false, address(diamond));
        emit ArbiterAccountabilityFacet.RemovalProposalWithdrawn(arbiter, CHIEF);
        vm.prank(CHIEF);
        ArbiterAccountabilityFacet(address(diamond)).withdrawProposal(arbiter);
    }

    /// А посторонний — не отзывает. Ноль в `by` не означает «отзывай кто
    /// хочет»: ветка требует владельца или директора.
    function test_StrangerCannotWithdrawTheChainAccusation() public {
        _threeOverturnsOnDistinctDisputes(arbiter);

        vm.prank(STRANGER);
        vm.expectRevert(ArbiterAccountabilityFacet.NotOwnerOrChief.selector);
        ArbiterAccountabilityFacet(address(diamond)).withdrawProposal(arbiter);

        assertTrue(ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter));
    }

    /// ⚠️ ХРАПОВИК: ПОСЛЕ ПЕРЕДАЧИ ПРАВА ТИХАЯ ДВЕРЬ ТОЖЕ ЗАКРЫТА.
    /// Это довод, который решил дело: overturnVerdict стоит под onlyOwnerOrDAO,
    /// а тот пускает владельца ВСЕГДА — значит до задачи 12 бывший владелец
    /// снимал того же арбитра тремя переворотами, и храповик передачи,
    /// ради которого строилась вся ветка, обходился за одну транзакцию.
    function test_QuietDoorDoesNotSurviveHandover() public {
        _handOverRemovalRight(address(0xDA0));
        _threeOverturnsOnDistinctDisputes(arbiter);

        assertTrue(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"без двери сноса нет"
        );
        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter),
            unicode"обвинение цепи легло — оно ничьё и передачи не знает"
        );
    }

    /// ...и оно исполняется — тем же посторонним, после паузы. Дверь не
    /// заперта передачей: цепь предъявила сама, решать некому и нечего.
    function test_AfterHandoverTheChainsAccusationStillRipens() public {
        _handOverRemovalRight(address(0xDA0));
        _threeOverturnsOnDistinctDisputes(arbiter);

        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getRemovalDelay());
        vm.prank(STRANGER);
        ArbiterAccountabilityFacet(address(diamond)).executeChainRemoval(arbiter);

        assertFalse(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter));
    }

    /// Путь таймаута кладёт ДРУГОЙ повод — Timeouts, не OverturnedVerdicts.
    /// Второй сторож зеркала кодов: ожидаемое снова из чужого перечисления.
    function test_TheTimeoutPathAccusesWithTimeouts() public {
        _disputeAndOverturn(address(0x9C1), address(0x9C2));
        _disputeAndOverturn(address(0x9C3), address(0x9C4));

        address agr = _fundedDisputeClaimedBy(address(0x9C5), address(0x9C6));
        vm.warp(vm.getBlockTimestamp() + 4 days + 1);
        vm.prank(address(0x9C5));
        Agreement(agr).triggerArbiterTimeout();

        (uint8 cause, , , address by, bool live) =
            ArbiterAccountabilityFacet(address(diamond)).getRemovalProposal(arbiter);
        assertTrue(live, unicode"таймаут тоже обвиняет");
        assertEq(by, address(0), unicode"и тоже ничьим именем");
        assertEq(
            cause, uint8(ArbiterAccountabilityFacet.Cause.Timeouts),
            unicode"путь таймаута обязан лечь поводом Timeouts, а не переворотами"
        );
        assertTrue(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"и кресло тоже переживает — путь тут ни при чём"
        );
    }

    /// ⚠️ A TIMEOUT MUST LEAVE A RECORD NAMING THE ARBITER (round of edits 1,
    /// 21 August 2026).
    ///
    /// Before this, the FIRST and SECOND timeouts left nothing on chain that a
    /// reader could address by arbiter: notifyArbiterTimeout emitted nothing at
    /// all, and Agreement.ArbiterTimedOut(address indexed client, uint256)
    /// lives on the deal and names the CLIENT. The counter grew in silence.
    ///
    /// Why that mattered: the chain's accusation stands on three disputes and
    /// only two could be recovered from the logs. The accused was shown two of
    /// the three, and the third was not "marked missing" — it was invisible.
    ///
    /// The scene takes the FIRST timeout, where no accusation exists yet and
    /// nothing else is emitted. That is the one that was mute.
    function test_TheTimeoutLeavesARecordNamingTheArbiter() public {
        address agr = _fundedDisputeClaimedBy(address(0x9E1), address(0x9E2));
        vm.warp(vm.getBlockTimestamp() + 4 days + 1);

        // Both fields are indexed and the event carries no data, so both topics
        // and the empty body are checked.
        vm.expectEmit(true, true, false, true, address(diamond));
        emit ArbiterRegistryFacet.ArbiterTimeoutRecorded(arbiter, agr);

        vm.prank(address(0x9E1));
        Agreement(agr).triggerArbiterTimeout();

        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getArbiterMistakeStreak(arbiter),
            1,
            "the mistake was booked - otherwise there is nothing for the event to be about"
        );
        assertFalse(
            ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter),
            "and it is the FIRST mistake: no accusation yet, one log in the receipt"
        );
    }

    /// A run of three with a timeout in the middle is recoverable FROM THE LOGS
    /// in full — owner decision 15a, checked against the chain rather than
    /// against the indexer.
    ///
    /// The scene builds three disputes: an overturn, a timeout, an overturn.
    /// The chain's accusation will name the last; the first two have to be
    /// findable in the logs by the arbiter's address. Before the fix the middle
    /// one was findable by nothing.
    function test_TheWholeRunIsRecoverableFromLogsWithATimeoutInIt() public {
        vm.recordLogs();

        _disputeAndOverturn(address(0x9F1), address(0x9F2));

        address timedOut = _fundedDisputeClaimedBy(address(0x9F3), address(0x9F4));
        vm.warp(vm.getBlockTimestamp() + 4 days + 1);
        vm.prank(address(0x9F3));
        Agreement(timedOut).triggerArbiterTimeout();

        _disputeAndOverturn(address(0x9F5), address(0x9F6));

        (, , , , bool live) = ArbiterAccountabilityFacet(address(diamond)).getRemovalProposal(arbiter);
        assertTrue(live, "three mistakes - the chain has accused");

        // Collect the disputes off the logs the way a reader does: two kinds of
        // event, and the arbiter is a topic in both.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        bool sawTimedOut;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length < 3) continue;
            bytes32 sig = logs[i].topics[0];
            bool overturn = sig == ArbiterRegistryFacet.VerdictOverturned.selector;
            bool timeout  = sig == ArbiterRegistryFacet.ArbiterTimeoutRecorded.selector;
            if (!overturn && !timeout) continue;

            // VerdictOverturned(agreement, arbiter, ...) puts the arbiter
            // second; ArbiterTimeoutRecorded(arbiter, agreement) puts him first.
            address who = address(uint160(uint256(overturn ? logs[i].topics[2] : logs[i].topics[1])));
            if (who != arbiter) continue;

            found++;
            if (timeout && address(uint160(uint256(logs[i].topics[2]))) == timedOut) sawTimedOut = true;
        }

        assertEq(found, 3, "all three disputes of the run must be readable from the logs");
        assertTrue(sawTimedOut, "and the middle one is the timeout");
    }

    /// Общий кусок для сцен таймаута: сделка доведена до забранного спора.
    function _fundedDisputeClaimedBy(address cli, address exec) internal returns (address agr) {
        usdc.mint(cli, 1_000_000 * 10 ** 6);
        vm.prank(cli);
        usdc.approve(address(diamond), 10 * 10 ** 6);
        vm.prank(cli);
        agr = FactoryFacet(address(diamond)).deployAgreement(cli, exec, arbiter, AMOUNT, DEADLINE, TERMS, 0);
        vm.prank(cli);
        usdc.approve(agr, AMOUNT);
        vm.prank(cli);
        Agreement(agr).fund();
        vm.prank(exec);
        Agreement(agr).activate();
        vm.prank(cli);
        Agreement(agr).raiseDispute();
        _claimDisputeAs(agr, arbiter);
    }

    /// ⚠️ ЛОВУШКА 5: ОПРАВДАНИЕ КОЛЛЕГИЕЙ ГАСИТ ОБВИНЕНИЕ ЦЕПИ.
    ///
    /// Разобрано ревью, не предположение. Три ошибки → приостановка и
    /// обвинение, счётчик 3. Коллегия оправдывает арбитра по одному из споров
    /// (resolveAppeal поверх РУЧНОГО переворота переворачивает обратно к
    /// вердикту самого арбитра) → задача 11 снимает единицу, 3 → 2. А
    /// MISTAKE_THRESHOLD равен ДВУМ — значит обвинение осталось бы исполнимым,
    /// и через 48 часов посторонний снял бы человека, которого коллегия
    /// признала правым. Дверь при этом ничья: спросить не с кого.
    function test_PanelVindicationQuenchesTheChainAccusation() public {
        address v1 = address(0x7B1);
        address v2 = address(0x7B2);
        address v3 = address(0x7B3);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v1);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v2);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v3);

        // Две ошибки по двум спорам, третья — по спору, который и обжалуют.
        _disputeAndOverturn(address(0x9D1), address(0x9D2));
        _disputeAndOverturn(address(0x9D3), address(0x9D4));
        address agr = _disputeAndOverturn(address(0x9D5), address(0x9D6));

        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter),
            unicode"сетап: цепь обвинила"
        );
        assertTrue(ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter));

        // Проигравшая сторона обжалует РУЧНОЙ переворот. Коллегия голосует за
        // переворот — и возвращает вердикт самого арбитра.
        // Апеллирует ПРОИГРАВШАЯ сторона. _disputeAndOverturn подаёт вердикт
        // в пользу клиента и переворачивает рукой в пользу исполнителя —
        // значит проиграл клиент, и апелляция его.
        usdc.mint(address(0x9D5), 100 * 10 ** 6);
        vm.prank(address(0x9D5));
        usdc.approve(address(diamond), 20 * 10 ** 6);
        vm.prank(address(0x9D5));
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);
        vm.prank(v1);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);
        vm.prank(v2);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);
        vm.prank(v3);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, false);

        vm.expectEmit(true, true, false, false, address(diamond));
        emit ArbiterRegistryFacet.ChainAccusationCleared(arbiter, agr);
        ArbiterRegistryFacet(address(diamond)).resolveAppeal(agr);

        assertFalse(
            ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter),
            unicode"обвинение цепи погашено — цепь забрала своё же слово"
        );
        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 0,
            unicode"и счётчик обнулён: иначе один переворот снова обвинял бы"
        );
        assertFalse(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter),
            unicode"и приостановка снята — оправданный не сидит взаперти"
        );
        assertTrue(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter));

        // И кнопку нажать больше нечем.
        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getRemovalDelay());
        vm.prank(STRANGER);
        vm.expectRevert(ArbiterAccountabilityFacet.NoLiveProposal.selector);
        ArbiterAccountabilityFacet(address(diamond)).executeChainRemoval(arbiter);
    }

    /// Обратная половина той же ловушки: ЧЕЛОВЕЧЕСКОЕ обвинение коллегия не
    /// гасит. Она сказала своё слово про один спор, а не про сговор, который
    /// предъявил кто-то другой; иначе всякий обвинённый чистил бы запись
    /// апелляцией по постороннему вердикту.
    function test_PanelVindicationLeavesAHumanAccusationStanding() public {
        address v1 = address(0x7C1);
        address v2 = address(0x7C2);
        address v3 = address(0x7C3);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v1);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v2);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v3);

        address agr = _disputeAndOverturn(address(0x9E1), address(0x9E2));

        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, DIGEST,
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
        );
        (, , uint256 before, address by0, ) =
            ArbiterAccountabilityFacet(address(diamond)).getRemovalProposal(arbiter);

        usdc.mint(address(0x9E1), 100 * 10 ** 6);
        vm.prank(address(0x9E1));
        usdc.approve(address(diamond), 20 * 10 ** 6);
        vm.prank(address(0x9E1));
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);
        vm.prank(v1);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);
        vm.prank(v2);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);
        vm.prank(v3);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, false);
        ArbiterRegistryFacet(address(diamond)).resolveAppeal(agr);

        (, , uint256 afterTs, address by1, bool live) =
            ArbiterAccountabilityFacet(address(diamond)).getRemovalProposal(arbiter);
        assertTrue(live, unicode"обвинение человека живо");
        assertEq(afterTs, before, unicode"часы его не тронуты");
        assertEq(by1, by0, unicode"и обвинитель его");
        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 0,
            unicode"единственная ошибка снята вычитанием задачи 11 — но это ВСЁ, что сделано"
        );
    }

    /// Директор не глушит быстрый рычаг автоматического пути ОДНОЙ
    /// транзакцией. До задачи 12 это держалось на `removedAt != 0`; снятие
    /// уехало на двое суток вперёд, и различитель получил вторую половину —
    /// «против него висит обвинение ЦЕПИ».
    function test_ChiefCannotLiftTheChainSuspensionWhileTheAccusationStands() public {
        ArbiterRegistryFacet(address(diamond)).setChiefArbiter(CHIEF);
        _threeOverturnsOnDistinctDisputes(arbiter);

        vm.prank(CHIEF);
        vm.expectRevert(ArbiterAccountabilityFacet.RemovalSuspensionIsRemovalAuthorityOnly.selector);
        ArbiterAccountabilityFacet(address(diamond)).liftSuspension(arbiter);

        assertTrue(ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter));
    }

    /// ...но и не заперт: отозвав обвинение своим именем, он снимает
    /// приостановку обычным порядком. Две транзакции вместо одной молчаливой.
    function test_ChiefLiftsTheSuspensionAfterWithdrawingTheAccusation() public {
        ArbiterRegistryFacet(address(diamond)).setChiefArbiter(CHIEF);
        _threeOverturnsOnDistinctDisputes(arbiter);

        vm.prank(CHIEF);
        ArbiterAccountabilityFacet(address(diamond)).withdrawProposal(arbiter);
        vm.prank(CHIEF);
        ArbiterAccountabilityFacet(address(diamond)).liftSuspension(arbiter);

        assertFalse(ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter));
    }

    /// ⚠️ РУЧНАЯ ДВЕРЬ ТОЖЕ ТРАТИТ УЛИКУ — новое поведение задачи 12, и без
    /// этой сцены оно было бы изменено МОЛЧА (замер: снятие обнуления в
    /// `_performRemoval` давало три красных, и все три на пути ЦЕПИ).
    ///
    /// Что чинится. `_requireProven` доказывает OverturnedVerdicts чтением
    /// `arbiterMistakeStreak`, а прежде счётчик переживал ручной снос — это
    /// стояло записанным в его же докстринге как известный дефект: владелец,
    /// вернувший ошибочно снятого через addArbiter, возвращал его ВМЕСТЕ со
    /// счётчиком на пороге, и тот же самый признак оправдывал снос повторно,
    /// без единой новой ошибки. Теперь обе двери обнуляют его одной строкой
    /// общего тела сноса.
    function test_RemovalForCauseSpendsTheEvidenceItWasBuiltOn() public {
        _disputeAndOverturn(address(0x9F1), address(0x9F2));
        _disputeAndOverturn(address(0x9F3), address(0x9F4));
        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 2,
            unicode"сетап: два реальных переворота — ровно порог РУЧНОГО сноса"
        );

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0));
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), ""
        );

        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 0,
            unicode"улика потрачена тем сносом, который на ней построен"
        );

        // И вторая половина, ради которой всё: возвращённый владельцем больше
        // НЕ стоит в одном шаге от повторного сноса по ТОЙ ЖЕ улике. Отказ
        // приходит на исполнении, а не на предложении: доказывает повод
        // `_requireProven`, и зовут её из removeArbiterForCause — предложение
        // проверяет только форму (отпечаток и слова для незаверяемых кодов).
        ArbiterRegistryFacet(address(diamond)).addArbiter(arbiter);
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0));
        vm.expectRevert(
            abi.encodeWithSelector(
                ArbiterAccountabilityFacet.CauseNotProven.selector,
                uint8(ArbiterAccountabilityFacet.Cause.OverturnedVerdicts)
            )
        );
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), ""
        );
    }

    // ============================================================
    //  КРУГ ПРАВОК 1 РЕВЬЮ ЗАДАЧИ 12 (18 августа 2026)
    //
    //  Четыре находки, и все четыре — про то, что построенное НЕ СТОРОЖИЛОСЬ:
    //  событие сноса (снять emit — 0 красных из 924), молчаливое снятие
    //  приостановки, протухшее обвинение, запирающее навсегда, и ошибка в
    //  предложенном коде отзыва, которую никто бы не заметил.
    // ============================================================

    /// ⚠️ СОБЫТИЕ СНОСА НА НОВОМ МЕСТЕ И С НОВЫМИ ПОЛЯМИ. Замер ревью: снять
    /// `emit ArbiterDemoted` из `executeChainRemoval` целиком — НОЛЬ красных из
    /// 924. Событие переехало на другой момент и сменило все три поля, и ни
    /// одна сцена этого не видела.
    ///
    /// Проверяются все три:
    ///   • `by == address(0)` — нажавшего не называем, обвинитель здесь цепь;
    ///   • `path` — СОХРАНЁННЫЙ `chainProposalPath`, ради которого заведено
    ///     поле хранилища (в момент сноса путь взять больше неоткуда);
    ///   • `agreement == address(0)` — сделки, «на которой сняли», к этому
    ///     моменту нет: повод — серия. Ту, что перевесила, назвал
    ///     `RemovalProposedByChain` двумя сутками раньше.
    function test_ChainRemovalAnnouncesTheDemotionNamingNobody() public {
        _threeOverturnsOnDistinctDisputes(arbiter);
        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getRemovalDelay());

        vm.expectEmit(true, true, true, true, address(diamond));
        emit ArbiterRegistryFacet.ArbiterDemoted(
            arbiter,
            address(0),
            ArbiterRegistryFacet.DemotionPath.OwnerOverturn,
            address(0)
        );
        vm.prank(STRANGER);
        ArbiterAccountabilityFacet(address(diamond)).executeChainRemoval(arbiter);
    }

    /// Вторая половина того же замка, и она про ОДНО поле: `path` обязан
    /// приезжать из хранилища, а не быть прибитым к одному значению. Сцена
    /// отличается от соседней ровно путём — таймаут вместо переворота, — и
    /// прибитый `OwnerOverturn` покраснеет здесь, оставаясь зелёным там.
    function test_TheSavedPathSurvivesTheTwoDaysToTheRemoval() public {
        _disputeAndOverturn(address(0xAB1), address(0xAB2));
        _disputeAndOverturn(address(0xAB3), address(0xAB4));

        address agr = _fundedDisputeClaimedBy(address(0xAB5), address(0xAB6));
        vm.warp(vm.getBlockTimestamp() + 4 days + 1);
        vm.prank(address(0xAB5));
        Agreement(agr).triggerArbiterTimeout();

        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getRemovalDelay());

        vm.expectEmit(true, true, true, true, address(diamond));
        emit ArbiterRegistryFacet.ArbiterDemoted(
            arbiter,
            address(0),
            ArbiterRegistryFacet.DemotionPath.AgreementTimeout,
            address(0)
        );
        vm.prank(STRANGER);
        ArbiterAccountabilityFacet(address(diamond)).executeChainRemoval(arbiter);
    }

    /// ⚠️ СНЯТИЕ ПРИОСТАНОВКИ ОБЪЯВЛЯЕТСЯ. Ветка оправдания стирала
    /// `suspendedUntil` молча, и в ленте приостановка выглядела никогда не
    /// кончившейся: все остальные её концы видны — `liftSuspension` шлёт
    /// событие, а истечение 72 часов читается по сроку, который лежал в логе с
    /// момента наложения.
    ///
    /// `by` нулевой: решила КОЛЛЕГИЯ, руки здесь нет.
    function test_VindicationAnnouncesTheLiftedSuspension() public {
        address v1 = address(0xAC1);
        address v2 = address(0xAC2);
        address v3 = address(0xAC3);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v1);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v2);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v3);

        _disputeAndOverturn(address(0xAD1), address(0xAD2));
        _disputeAndOverturn(address(0xAD3), address(0xAD4));
        address agr = _disputeAndOverturn(address(0xAD5), address(0xAD6));
        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter),
            unicode"сетап: приостановка стоит"
        );

        usdc.mint(address(0xAD5), 100 * 10 ** 6);
        vm.prank(address(0xAD5));
        usdc.approve(address(diamond), 20 * 10 ** 6);
        vm.prank(address(0xAD5));
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);
        vm.prank(v1);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);
        vm.prank(v2);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);
        vm.prank(v3);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, false);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit ArbiterAccountabilityFacet.ArbiterSuspensionLifted(arbiter, address(0));
        ArbiterRegistryFacet(address(diamond)).resolveAppeal(agr);

        assertFalse(ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter));
    }

    /// ⚠️ C-2: ПРОТУХШЕЕ ОБВИНЕНИЕ НЕ ЗАПИРАЕТ НИЧЕГО.
    ///
    /// Предикат «против него висит обвинение цепи» был единственным из четырёх
    /// в фасете, который не смотрел на `PROPOSAL_TTL`. Цена: обвинение, которое
    /// никто не исполнил, протухает за 14 суток и висеть перестаёт — но
    /// директор навсегда терял право снять с этого человека ОБЫЧНУЮ
    /// приостановку, наложенную им же и по совершенно другому поводу.
    function test_AStaleChainAccusationLocksNothing() public {
        ArbiterRegistryFacet(address(diamond)).setChiefArbiter(CHIEF);
        _threeOverturnsOnDistinctDisputes(arbiter);

        // Обвинение протухло само, кнопку никто не нажал.
        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getProposalTTL());
        assertFalse(
            ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter),
            unicode"сетап: обвинение больше не живо"
        );
        assertFalse(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter),
            unicode"сетап: и приостановка автоматики давно истекла сама"
        );

        // Обычная приостановка, по своему поводу, рукой директора.
        vm.prank(CHIEF);
        ArbiterAccountabilityFacet(address(diamond)).suspendArbiter(arbiter);
        assertTrue(ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter));

        // И он же обязан суметь её снять: это его работа, лёгкая мера.
        vm.prank(CHIEF);
        ArbiterAccountabilityFacet(address(diamond)).liftSuspension(arbiter);
        assertFalse(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter),
            unicode"мёртвая запись не вправе отнимать у директора его обычную дверь"
        );
    }

    /// ⚠️ ЗАМОК НА ОШИБКУ, КОТОРУЮ ЧУТЬ НЕ ВЗЯЛИ ИЗ ЗАДАНИЯ. Предложенное
    /// условие отзыва было `p.by != address(0) && msg.sender != p.by` — и у
    /// ПУСТОЙ записи `by` тоже нулевой, так что директор против человека, на
    /// которого никто ничего не клал, ПРОШЁЛ бы вместо отказа. Замер ревью:
    /// подставить ту строку дословно — НОЛЬ красных из 924.
    ///
    /// Отказ здесь не про роль (её директор прошёл), а про то, что отзывать
    /// нечего и запись не его. Ветка отзыва обвинения цепи требует
    /// `proposedAt != 0` именно поэтому.
    function test_ChiefCannotWithdrawAgainstAnEmptyRecord() public {
        ArbiterRegistryFacet(address(diamond)).setChiefArbiter(CHIEF);
        assertFalse(
            ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter),
            unicode"сетап: против него ничего не лежит"
        );

        vm.prank(CHIEF);
        vm.expectRevert(ArbiterAccountabilityFacet.NotYourProposal.selector);
        ArbiterAccountabilityFacet(address(diamond)).withdrawProposal(arbiter);
    }

    /// Обратная половина: пустая запись не отказывает ДЕРЖАТЕЛЮ ПРАВА — он
    /// проходит выше по ветке и тихо ничего не делает, без события в ленте
    /// (Minor 3 круга правок 1 задачи 7: пустой отзыв читался бы как «против
    /// него что-то было»).
    function test_AuthorityWithdrawingNothingIsSilentNotRefused() public {
        vm.recordLogs();
        ArbiterAccountabilityFacet(address(diamond)).withdrawProposal(arbiter);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(
                logs[i].topics[0] != ArbiterAccountabilityFacet.RemovalProposalWithdrawn.selector,
                unicode"пустой отзыв не смеет оставлять в ленте след"
            );
        }
    }

    // ============================================================
    //  C-1: ОБВИНЕНИЕ ОТМЕНЯЕТСЯ ДОКАЗАТЕЛЬСТВОМ ОШИБКИ, А НЕ ХОРОШЕЙ
    //  РАБОТОЙ ПОСЛЕ (решение владельца, 18 августа 2026)
    //
    //  Кнопка спрашивала счётчик ЗАНОВО, а `finalizeVerdict` его обнуляет на
    //  чистом вердикте. Значит арбитр, против которого цепь уже завела дело,
    //  отсиживал приостановку, брал любой спор, доводил его чисто — и кнопка
    //  отвечала CauseNotProven. Дело при этом не гасло: висело 14 суток, запирая
    //  резигнацию. Не снят и не свободен — худшее из двух.
    //
    //  Стало: запись, которую цепь положила, И ЕСТЬ доказательство. Она сделана
    //  в момент, когда факты случились. Отменяют её ровно четыре вещи, и обе
    //  сцены ниже — про границу между ними.
    // ============================================================

    /// Первая: хорошая работа ПОСЛЕ обвинения его не отменяет.
    function test_CleanWorkAfterTheChargeDoesNotCancelIt() public {
        _threeOverturnsOnDistinctDisputes(arbiter);
        assertTrue(ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter));

        // Приостановка истекает сама — 72 часа. Обвинение живо: у него 14 суток.
        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getSuspensionWindow());
        assertFalse(ArbiterAccountabilityFacet(address(diamond)).isSuspended(arbiter));

        // И он берёт спор и доводит его ЧИСТО. finalizeVerdict обнуляет счётчик
        // судейских ошибок — тот самый, которым доказывался повод.
        address agr = _disputeAndSubmit(address(0xB01), address(0xB02));
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(agr);
        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 0,
            unicode"сетап: чистый вердикт обнулил счётчик — прежняя улика больше не читается"
        );

        // Кнопка обязана сработать всё равно: доказательством было ПРЕДЛОЖЕНИЕ,
        // записанное цепью тогда, а не состояние счётчика сегодня.
        vm.prank(STRANGER);
        ArbiterAccountabilityFacet(address(diamond)).executeChainRemoval(arbiter);

        assertFalse(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"сделал — отвечай: хорошая работа после не отменяет обвинения"
        );
    }

    /// Вторая, и она важнее первой: правка не должна была превратить «дело не
    /// истекает само» в «дело не отменить ничем». Оправдание коллегией гасит
    /// обвинение целиком, и нажимать после этого нечего.
    ///
    /// Отличается от test_PanelVindicationQuenchesTheChainAccusation тем, что
    /// проверяет не состояние, а ПОСЛЕДСТВИЕ для кнопки после того, как
    /// перепроверка повода из неё убрана: если бы гашение сломалось, кнопка
    /// теперь сработала бы на оправданном человеке молча.
    function test_ThePanelStillDisarmsTheButtonAfterTheProofCheckIsGone() public {
        address v1 = address(0xB11);
        address v2 = address(0xB12);
        address v3 = address(0xB13);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v1);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v2);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v3);

        _disputeAndOverturn(address(0xB21), address(0xB22));
        _disputeAndOverturn(address(0xB23), address(0xB24));
        address agr = _disputeAndOverturn(address(0xB25), address(0xB26));
        assertTrue(ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter));

        usdc.mint(address(0xB25), 100 * 10 ** 6);
        vm.prank(address(0xB25));
        usdc.approve(address(diamond), 20 * 10 ** 6);
        vm.prank(address(0xB25));
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);
        vm.prank(v1);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);
        vm.prank(v2);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);
        vm.prank(v3);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, false);
        ArbiterRegistryFacet(address(diamond)).resolveAppeal(agr);

        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getRemovalDelay());
        vm.prank(STRANGER);
        vm.expectRevert(ArbiterAccountabilityFacet.NoLiveProposal.selector);
        ArbiterAccountabilityFacet(address(diamond)).executeChainRemoval(arbiter);

        assertTrue(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"коллегия сказала «прав» — и кнопки против него больше нет"
        );
    }

    /// И третья граница того же решения: отзыв владельцем/директором тоже
    /// обезоруживает кнопку. Вместе с протуханием и исполнением это все четыре
    /// способа погасить обвинение, перечисленные в докстринге кнопки.
    function test_WithdrawalDisarmsTheButtonToo() public {
        ArbiterRegistryFacet(address(diamond)).setChiefArbiter(CHIEF);
        _threeOverturnsOnDistinctDisputes(arbiter);

        vm.prank(CHIEF);
        ArbiterAccountabilityFacet(address(diamond)).withdrawProposal(arbiter);

        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getRemovalDelay());
        vm.prank(STRANGER);
        vm.expectRevert(ArbiterAccountabilityFacet.NoLiveProposal.selector);
        ArbiterAccountabilityFacet(address(diamond)).executeChainRemoval(arbiter);
    }

    // ============================================================
    //  КРУГ ПРАВОК 2 (18 августа 2026)
    //
    //  Пятый выход и мёртвое обвинение. Оба найдены пробой на живом даймонде,
    //  оба стирали то, ради чего в задаче потрачены поля хранилища.
    // ============================================================

    /// ⚠️ ПЯТЫЙ ВЫХОД: держатель права исполнял обвинение ЦЕПИ своей дверью.
    /// `removeArbiterForCause` читала запись и на `by` не смотрела вовсе —
    /// обратной защиты к `NotAChainProposal` не было. Снос проходил, и вечная
    /// запись МЕНЯЛА ПРОИСХОЖДЕНИЕ: `lastRemovalCause` 253 («цепь, по
    /// переворотам») превращался в 1 («человек, по поводу»), а в ленте вместо
    /// `ArbiterDemoted(by = 0)` вставал `ArbiterRemovedForCause(by = владелец)`.
    ///
    /// Два поля хранилища — `chainProposalPath` и `lastRemovalCause` — заведены
    /// ровно ради этого различия, и один вызов его стирал.
    function test_TheAuthorityCannotExecuteTheChainsAccusationHimself() public {
        _threeOverturnsOnDistinctDisputes(arbiter);
        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getRemovalDelay());

        vm.expectRevert(ArbiterAccountabilityFacet.ChainProposalNeedsTheChainDoor.selector);
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), ""
        );

        assertTrue(
            ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter),
            unicode"и за отказом ничего не произошло"
        );

        // Ничего не потеряно: кнопку цепи он может нажать сам, как и любой
        // другой, — и тогда запись скажет правду о происхождении.
        ArbiterAccountabilityFacet(address(diamond)).executeChainRemoval(arbiter);
        (, , , , , , , , , , , , , uint8 cause) =
            ArbiterAccountabilityFacet(address(diamond)).getArbiterStanding(arbiter);
        assertEq(cause, AUTO_OVERTURN, unicode"происхождение сохранено: сняла ЦЕПЬ, а не он");
    }

    /// Обратная сторона той же пары: ЧЕЛОВЕЧЕСКОЕ обвинение по-прежнему идёт
    /// своей дверью и никакой новой проверкой не задето.
    function test_TheAuthorityStillExecutesAHumanAccusation() public {
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, DIGEST);
        ArbiterAccountabilityFacet(address(diamond)).removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, DIGEST, address(0),
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
        );
        assertFalse(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(arbiter));
    }

    /// ⚠️ МЁРТВОЕ ОБВИНЕНИЕ НИЧЕГО НЕ ГАСИТ. Ветка оправдания смотрела на
    /// `proposedAt != 0` без `PROPOSAL_TTL` — тот же дефект, что C-2, одной
    /// строкой ниже. Цена: обвинение, протухшее две недели назад и исполнимое
    /// никем, стирало счётчик ЦЕЛИКОМ вопреки правилу «снимается ровно одна
    /// ошибка» семью строками выше, сносило саму запись и слало
    /// `ChainAccusationCleared` про давно умершее.
    ///
    /// Сцена строится так, чтобы мёртвая запись ОСТАЛАСЬ мёртвой и её никто не
    /// перекрыл живой: после протухания счётчик сбрасывается чистым вердиктом,
    /// и следующие две ошибки до порога автоматики не доходят.
    function test_ADeadChainAccusationDoesNotSwallowTheWholeStreak() public {
        address v1 = address(0xC01);
        address v2 = address(0xC02);
        address v3 = address(0xC03);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v1);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v2);
        ArbiterRegistryFacet(address(diamond)).addArbiter(v3);

        _threeOverturnsOnDistinctDisputes(arbiter);
        (, , uint256 deadAt, , ) =
            ArbiterAccountabilityFacet(address(diamond)).getRemovalProposal(arbiter);
        assertGt(deadAt, 0, unicode"сетап: обвинение цепи положено");

        // Никто не нажал — обвинение умерло от старости, но ЗАПИСЬ ОСТАЛАСЬ:
        // протухшее не стирает само себя.
        vm.warp(vm.getBlockTimestamp() + ArbiterAccountabilityFacet(address(diamond)).getProposalTTL());
        assertFalse(ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter));

        // Чистый вердикт обнуляет серию — теперь до порога автоматики далеко,
        // и новое обвинение цепи не ляжет поверх мёртвого.
        address clean = _disputeAndSubmit(address(0xC21), address(0xC22));
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(clean);
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 0);

        // Две ручные ошибки: серия равна двум, порог автоматики не достигнут.
        _disputeAndOverturn(address(0xC31), address(0xC32));
        address agr = _disputeAndOverturn(address(0xC33), address(0xC34));
        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 2,
            unicode"сетап: две ошибки, обвинения цепи нового нет"
        );
        assertFalse(ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter));

        // Коллегия оправдывает по второй — снимается РОВНО ОДНА.
        usdc.mint(address(0xC33), 100 * 10 ** 6);
        vm.prank(address(0xC33));
        usdc.approve(address(diamond), 20 * 10 ** 6);
        vm.prank(address(0xC33));
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);
        vm.prank(v1);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);
        vm.prank(v2);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);
        vm.prank(v3);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, false);
        ArbiterRegistryFacet(address(diamond)).resolveAppeal(agr);

        assertEq(
            ArbiterAccountabilityFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 1,
            unicode"снимается РОВНО ОДНА ошибка: мёртвая запись гасить ничего не вправе"
        );

        (, , uint256 stillDeadAt, , ) =
            ArbiterAccountabilityFacet(address(diamond)).getRemovalProposal(arbiter);
        assertEq(
            stillDeadAt, deadAt,
            unicode"и самой мёртвой записи оправдание не касается — гасить нечего"
        );
    }

    // ============================================================
    //  КРУГ ПРАВОК 4 (19 августа 2026): ХРАПОВИК ДОХОДИТ ДО ДВЕРИ ОТЗЫВА
    //
    //  Круг 3 написал в докстринге, что после передачи отзывать может только
    //  преемник. Кодом это не держалось: `_requireOwnerOrChief` гейтит
    //  ДИРЕКТОРА, а владельца пропускает ВСЕГДА, и ветка `chainLaid` до
    //  `NotYourProposal` не доходит. То есть бывший владелец бесконечно гасил
    //  автоматические обвинения против любого арбитра — ровно тот остаток
    //  власти, ради устранения которого строился храповик, да ещё и
    //  несимметрично: директор эту дверь при активном ДАО уже терял.
    //
    //  Решение владельца — чинить кодом. Форма взята у proposeRemoval.
    // ============================================================

    /// ⚠️ ПРЯМАЯ: после передачи бывший владелец обвинение цепи НЕ гасит.
    function test_OwnerCannotWithdrawTheChainAccusationAfterHandover() public {
        address dao = address(0xDA0);
        ArbiterRegistryFacet(address(diamond)).setChiefArbiter(CHIEF);
        _threeOverturnsOnDistinctDisputes(arbiter);
        _handOverRemovalRight(dao);

        vm.expectRevert(ArbiterAccountabilityFacet.RemovalHandedOver.selector);
        ArbiterAccountabilityFacet(address(diamond)).withdrawProposal(arbiter);

        // И директор — тоже нет: после передачи дверь принадлежит одному.
        vm.prank(CHIEF);
        vm.expectRevert(ArbiterAccountabilityFacet.RemovalHandedOver.selector);
        ArbiterAccountabilityFacet(address(diamond)).withdrawProposal(arbiter);

        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter),
            unicode"обвинение цепи на месте — гасить его больше некому, кроме преемника"
        );

        // А преемник — да, и это не дверь без открывающего.
        vm.prank(dao);
        ArbiterAccountabilityFacet(address(diamond)).withdrawProposal(arbiter);
        assertFalse(ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter));
    }

    /// ⚠️ ВСТРЕЧНАЯ: ДО передачи ничего не изменилось. Без неё правка могла бы
    /// чинить храповик, ломая сегодняшний день, — а сегодня передачи нет, и
    /// гасить подтасованные перевороты обязаны мочь оба.
    function test_BeforeHandoverOwnerAndChiefWithdrawAsBefore() public {
        ArbiterRegistryFacet(address(diamond)).setChiefArbiter(CHIEF);

        // Владелец.
        _threeOverturnsOnDistinctDisputes(arbiter);
        ArbiterAccountabilityFacet(address(diamond)).withdrawProposal(arbiter);
        assertFalse(
            ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter),
            unicode"владелец до передачи гасит, как и гасил"
        );

        // Директор, на свежем обвинении против ТОГО ЖЕ арбитра. Повод
        // Collusion — цепь его не проверяет, счётчик судейских ошибок к нему
        // отношения не имеет, и второй арбитр сцене не нужен.
        vm.prank(CHIEF);
        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, DIGEST,
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
        );
        vm.prank(CHIEF);
        ArbiterAccountabilityFacet(address(diamond)).withdrawProposal(arbiter);
        assertFalse(
            ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arbiter),
            unicode"директор до передачи отзывает своё, как и отзывал"
        );
    }

    /// ⚠️ ЧТО ОСТАЁТСЯ У ВЛАДЕЛЬЦА ПОСЛЕ ПЕРЕДАЧИ — сцена заведена кругом
    /// правок 5, потому что докстринг `_requireOwnerOrChief` это ЧИСЛОМ
    /// утверждает, а сторожа у числа не было ни одного. Счёт менялся уже
    /// дважды (четыре → три уборкой 7а, три → два кругом правок 4), и оба раза
    /// молча.
    ///
    /// Сегодня из четырёх дверей, ходивших под `onlyOwnerOrChief`, владелец
    /// после передачи сохраняет ДВЕ, и обе лёгкие:
    ///   • `suspendArbiter` — обратима, протухает сама;
    ///   • ЛЁГКАЯ ветка `liftSuspension` — снять обычную приостановку.
    /// И теряет две тяжёлые: `proposeRemoval` и `withdrawProposal`, обе через
    /// `RemovalHandedOver`.
    function test_AfterHandoverTheOwnerKeepsExactlyTheTwoLightDoors() public {
        address dao = address(0xDA1);
        address subject = address(0xD21);
        ArbiterRegistryFacet(address(diamond)).addArbiter(subject);
        _handOverRemovalRight(dao);

        // ── Сохраняет: приостановить ──
        ArbiterAccountabilityFacet(address(diamond)).suspendArbiter(subject);
        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(subject),
            unicode"лёгкая мера остаётся у владельца и после передачи"
        );

        // ── Сохраняет: снять ОБЫЧНУЮ приостановку (сноса на человеке нет,
        //    обвинения цепи тоже) ──
        ArbiterAccountabilityFacet(address(diamond)).liftSuspension(subject);
        assertFalse(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(subject),
            unicode"и снять её тоже — это его работа, она не про снос"
        );

        // ── Теряет: предложить снос ──
        vm.expectRevert(ArbiterAccountabilityFacet.RemovalHandedOver.selector);
        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(
            subject, ArbiterAccountabilityFacet.Cause.Collusion, DIGEST,
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
        );

        // ── Теряет: отозвать (круг правок 4) ──
        vm.prank(dao);
        ArbiterAccountabilityFacet(address(diamond)).proposeRemoval(
            subject, ArbiterAccountabilityFacet.Cause.Collusion, DIGEST,
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
        );
        vm.expectRevert(ArbiterAccountabilityFacet.RemovalHandedOver.selector);
        ArbiterAccountabilityFacet(address(diamond)).withdrawProposal(subject);

        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(subject),
            unicode"и запись преемника его переживает"
        );

        // ── А ЧТО У ПРЕЕМНИКА: он отзывает своё и чужое ──
        vm.prank(dao);
        ArbiterAccountabilityFacet(address(diamond)).withdrawProposal(subject);
        assertFalse(ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(subject));

        // ── ⚠️ И ЧЕГО У НЕГО НЕТ, ради пункта 70 списка долгов: снять
        //    ОБЫЧНУЮ приостановку он не может. Лёгкая ветка liftSuspension
        //    ходит под _requireOwnerOrChief, а тот при активной ДАО не видит
        //    ни директора, ни самого управления — только владельца.
        ArbiterAccountabilityFacet(address(diamond)).suspendArbiter(subject);
        vm.prank(dao);
        vm.expectRevert(ArbiterAccountabilityFacet.NotOwnerOrChief.selector);
        ArbiterAccountabilityFacet(address(diamond)).liftSuspension(subject);
        assertTrue(
            ArbiterAccountabilityFacet(address(diamond)).isSuspended(subject),
            unicode"остаток пункта 70: владелец морозит, управление не размораживает"
        );
    }
}
