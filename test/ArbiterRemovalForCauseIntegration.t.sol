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
}
