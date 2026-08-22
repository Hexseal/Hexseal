// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
//  DIAMOND-DEATH ESCROW LOCK
// ============================================================
//
// The promise under test: "money in escrow is safe". Every deal is an
// EIP-1167 clone of Agreement that holds the USDC itself; the diamond is
// only used as a registry / reputation / arbitration sidecar. If that
// promise is true, the money must leave the clone even when the diamond
// stops answering.
//
// HISTORY. On 2026-08-22 this file was written to MEASURE the promise, and
// it found the promise false for disputed deals: triggerArbiterTimeout, the
// only exit from DISPUTED, stood behind a bare
// `IArbiterRegistryFacet(diamond).hasSubmittedVerdict(...)`. A silent diamond
// meant a stranded pot, for ever, with no rescue function anywhere. The same
// day the guard was rewritten (Agreement._verdictInFlight / _diamondHasCode)
// and this file was turned from a description of the hole into the lock on
// it: every row that used to assert "money stuck" now asserts "money out".
//
// The diamond stops answering in three DIFFERENT ways, and they are not
// interchangeable:
//
//   A. SELECTORS_REMOVED — a bad diamondCut removed a selector Agreement
//      calls. The proxy fallback hits `require(facet != address(0))` and
//      reverts. Real: a Replace/Add mix-up already broke whole cuts here.
//   B. FACET_REVERTS     — the selector is mounted but the facet behind it
//      reverts on every call. Real: a broken upgrade.
//   C. NO_CODE           — nothing at the diamond address at all. This is
//      NOT the same as A or B: solc emits an `extcodesize` guard for calls
//      that expect no return data, and that guard reverts in the CALLER's
//      own frame — outside the try/catch region. See
//      testTryCatchDoesNotCatchExtcodesizeGuard below. try/catch therefore
//      cannot cover this mode at all, which is why Agreement now checks
//      `diamond.code.length` itself before every tolerated diamond call.
//
// Method notes (project rule "the expected value must not be derived from
// the thing under test"):
//
//   * Expected payouts are hand-written literals computed from DEAL, the
//     deal size this test picks. They are never read back out of Agreement.
//   * "Money out" is measured as a USDC balance delta on the mock token,
//     which is a contract the diamond does not touch.
//   * Every kill is proved to have actually killed something: the ALIVE
//     baseline asserts the registry status really did move to COMPLETED and
//     that RegistrySyncFailed did NOT fire. Without that baseline a removed
//     selector could be a no-op and the whole suite would be an empty
//     mutation.

import "forge-std/Test.sol";
import "../src/DiamondProxy.sol";
import "../src/RegistryFacet.sol";
import "../src/FactoryFacet.sol";
import "../src/AgreementDeployer.sol";
import "../src/Agreement.sol";
import "../src/facets/ArbiterRegistryFacet.sol";
import {ArbiterAccountabilityFacet} from "../src/facets/ArbiterAccountabilityFacet.sol";
import "../src/facets/ReputationFacet.sol";

// ---------- MOCK USDC ----------

contract MockUSDCDeath {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

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

// ---------- FAILURE-MODE FACETS ----------

/// Mode B: mounted, answers nothing. Reverts on every selector routed here.
contract AlwaysRevertFacet {
    error FacetIsDead();
    fallback() external payable { revert FacetIsDead(); }
}

/// The gas trap: try/catch survives a revert but not a callee that eats the
/// gas. EIP-150 leaves the caller 1/64 of what it had; two such calls in a
/// row (Agreement._complete makes exactly two) leave 1/4096.
contract GasBurnerFacet {
    fallback() external payable {
        uint256 i = 1;
        // Unbounded SSTORE loop: guaranteed to consume whatever it is given
        // and to be immune to the optimizer (real state writes).
        while (true) {
            assembly { sstore(i, i) }
            unchecked { i++; }
        }
    }
}

// ---------- EXTCODESIZE PROBE ----------
//
// Deliberately standalone and minimal. It reproduces the two call shapes
// Agreement uses, so the conclusion about extcodesize does not depend on
// reading Agreement's own bytecode.

interface IProbeNoReturn { function ping(address a) external; }
interface IProbeWithReturn { function ask(address a) external view returns (bool); }

contract ExtcodesizeProbe {
    address public target;
    constructor(address t) { target = t; }

    /// Same shape as Agreement._updateRegistry / notifyExecutorFault:
    /// external call inside try/catch, NO return data expected.
    function protectedNoReturn() external returns (bool caught) {
        try IProbeNoReturn(target).ping(address(this)) { return false; } catch { return true; }
    }

    /// Same shape as Agreement.sol:875: bare call, return data expected.
    function bareWithReturn() external view returns (bool) {
        return IProbeWithReturn(target).ask(address(this));
    }

    /// Same shape as Agreement.setArbiter: low-level staticcall + abi.decode.
    function lowLevelStatic() external view returns (bool ok, uint256 len) {
        bytes memory data;
        (ok, data) = target.staticcall(
            abi.encodeWithSignature("isRegisteredArbiter(address)", address(this))
        );
        len = data.length;
    }
}

// ---------- VERDICT-VIEW COST PROBE ----------
//
// Measures what one `hasSubmittedVerdict` read through the diamond actually
// costs, from inside a contract frame, the way Agreement makes it. Standalone
// so the number does not come out of Agreement's own code.

contract VerdictViewProbe {
    address public diamond;
    constructor(address d) { diamond = d; }

    function measure(address subject) external view returns (uint256 used, bool ok, uint256 word) {
        bytes memory cd = abi.encodeWithSignature("hasSubmittedVerdict(address)", subject);
        address to = diamond;
        bytes memory ret;
        uint256 before = gasleft();
        (ok, ret) = to.staticcall(cd);
        used = before - gasleft();
        if (ret.length >= 32) word = abi.decode(ret, (uint256));
    }
}

// ============================================================
//  TEST
// ============================================================

contract DiamondDeathEscrowTest is Test {
    enum Kill { ALIVE, SELECTORS_REMOVED, FACET_REVERTS, NO_CODE }

    DiamondProxy  diamond;
    MockUSDCDeath usdc;

    address owner;
    address client;
    address executor;
    address arbiterAddr;
    address feeRecipient;
    address stranger;

    /// Deal size and every expected payout below are literals fixed by hand.
    /// Nothing here is read back out of Agreement.
    uint256 constant DEAL       = 1_000_000_000;  // 1000 USDC (6 decimals)
    uint256 constant EXTRA      =   200_000_000;  // 200 USDC
    uint256 constant DEAL_HALF  =   500_000_000;  // DEAL / 2
    uint256 constant CLIENT_BAG = 1_000_000_000_000;

    // Windows, restated as literals so the test does not import its
    // expectations from the contract it is measuring.
    uint256 constant ACTIVATION_WINDOW   = 2 days;
    uint256 constant AUTO_APPROVE_WINDOW = 2 days;
    uint256 constant DISPUTE_WINDOW      = 4 days;
    uint256 constant DEADLINE_GRACE      = 1 days;
    uint256 constant DEADLINE_DAYS       = 7;

    // ============================================================
    //  SETUP  (full real diamond, shape copied from DisputeSettlement.t.sol)
    // ============================================================

    function setUp() public {
        owner        = address(this);
        client       = address(0x1);
        executor     = address(0x2);
        arbiterAddr  = address(0x3);
        feeRecipient = address(0x4);
        stranger     = address(0x5);

        usdc = new MockUSDCDeath();
        usdc.mint(client, CLIENT_BAG);

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

        bytes4[] memory arbSels = new bytes4[](42);
        arbSels[0]  = ArbiterRegistryFacet.setChiefArbiter.selector;
        arbSels[1]  = ArbiterRegistryFacet.addArbiter.selector;
        arbSels[2]  = ArbiterRegistryFacet.commitDisputeClaim.selector;
        arbSels[3]  = ArbiterRegistryFacet.claimDispute.selector;
        arbSels[4]  = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        arbSels[5]  = ArbiterRegistryFacet.clearDisputeClaim.selector;
        arbSels[6]  = ArbiterRegistryFacet.getChiefArbiter.selector;
        arbSels[7]  = ArbiterRegistryFacet.isRegisteredArbiter.selector;
        arbSels[8]  = ArbiterRegistryFacet.getArbiters.selector;
        arbSels[9]  = ArbiterRegistryFacet.getDisputeClaimer.selector;
        arbSels[10] = ArbiterRegistryFacet.getClaimCommitment.selector;
        arbSels[11] = ArbiterRegistryFacet.activateDAO.selector;
        arbSels[12] = ArbiterRegistryFacet.applyAsArbiter.selector;
        arbSels[13] = ArbiterRegistryFacet.isDaoActive.selector;
        arbSels[14] = ArbiterRegistryFacet.getMinXPToRegister.selector;
        arbSels[15] = ArbiterRegistryFacet.getDaoThreshold.selector;
        arbSels[16] = ArbiterRegistryFacet.submitVerdict.selector;
        arbSels[17] = ArbiterRegistryFacet.finalizeVerdict.selector;
        arbSels[18] = ArbiterRegistryFacet.overturnVerdict.selector;
        arbSels[19] = ArbiterRegistryFacet.freezeVerdict.selector;
        arbSels[20] = ArbiterRegistryFacet.unfreezeVerdict.selector;
        arbSels[21] = ArbiterRegistryFacet.withdrawArbiterReward.selector;
        arbSels[22] = ArbiterRegistryFacet.fundVault.selector;
        arbSels[23] = ArbiterRegistryFacet.setRewardPerDispute.selector;
        arbSels[24] = ArbiterRegistryFacet.setDAOAddress.selector;
        arbSels[25] = ArbiterRegistryFacet.getPendingVerdict.selector;
        arbSels[26] = ArbiterRegistryFacet.getVaultBalance.selector;
        arbSels[27] = ArbiterRegistryFacet.getRewardPerDispute.selector;
        arbSels[28] = ArbiterRegistryFacet.getDAOAddress.selector;
        arbSels[29] = ArbiterRegistryFacet.clearStuckVerdict.selector;
        arbSels[30] = ArbiterRegistryFacet.creditDisputeFee.selector;
        arbSels[31] = ArbiterRegistryFacet.getTreasurySlice.selector;
        arbSels[32] = ArbiterRegistryFacet.withdrawTreasurySlice.selector;
        arbSels[33] = ArbiterRegistryFacet.hasSubmittedVerdict.selector;
        arbSels[34] = ArbiterRegistryFacet.notifyArbiterTimeout.selector;
        arbSels[35] = ArbiterRegistryFacet.setArbiterFloor.selector;
        arbSels[36] = ArbiterRegistryFacet.getArbiterFloor.selector;
        arbSels[37] = ArbiterRegistryFacet.quoteDisputeTopUp.selector;
        arbSels[38] = ArbiterRegistryFacet.fundDispute.selector;
        arbSels[39] = ArbiterRegistryFacet.getDisputeBounty.selector;
        arbSels[40] = ArbiterRegistryFacet.withdrawDisputeBounty.selector;
        arbSels[41] = ArbiterRegistryFacet.getRefundableBounty.selector;

        bytes4[] memory accSels = new bytes4[](3);
        accSels[0] = ArbiterAccountabilityFacet.getArbiterDeals.selector;
        accSels[1] = ArbiterAccountabilityFacet.getArbiterReward.selector;
        accSels[2] = ArbiterAccountabilityFacet.getArbiterMistakeStreak.selector;

        // autoAwardXP and notifyExecutorFault are mounted ON PURPOSE. Every
        // other suite here leaves them off, which would make "remove the
        // selector" a no-op and every measurement below meaningless.
        bytes4[] memory repSels = new bytes4[](4);
        repSels[0] = ReputationFacet.getUnresolvedDisputes.selector;
        repSels[1] = ReputationFacet.autoAwardXP.selector;
        repSels[2] = ReputationFacet.notifyExecutorFault.selector;
        repSels[3] = ReputationFacet.getXP.selector;

        bytes4[] memory cutSels = new bytes4[](1);
        cutSels[0] = DiamondCutFacet.diamondCut.selector;

        bytes4[] memory loupeSels = new bytes4[](5);
        loupeSels[0] = DiamondLoupeFacet.facets.selector;
        loupeSels[1] = DiamondLoupeFacet.facetFunctionSelectors.selector;
        loupeSels[2] = DiamondLoupeFacet.facetAddresses.selector;
        loupeSels[3] = DiamondLoupeFacet.facetAddress.selector;
        loupeSels[4] = DiamondLoupeFacet.supportsInterface.selector;

        bytes4[] memory ownSels = new bytes4[](4);
        ownSels[0] = OwnershipFacet.transferOwnership.selector;
        ownSels[1] = OwnershipFacet.owner.selector;
        ownSels[2] = OwnershipFacet.acceptOwnership.selector;
        ownSels[3] = OwnershipFacet.pendingOwner.selector;

        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](8);
        cut[0] = IDiamondCut.FacetCut(address(registryFacet),        IDiamondCut.FacetCutAction.Add, regSels);
        cut[1] = IDiamondCut.FacetCut(address(factoryFacet),         IDiamondCut.FacetCutAction.Add, facSels);
        cut[2] = IDiamondCut.FacetCut(address(diamondCutFacet),      IDiamondCut.FacetCutAction.Add, cutSels);
        cut[3] = IDiamondCut.FacetCut(address(diamondLoupeFacet),    IDiamondCut.FacetCutAction.Add, loupeSels);
        cut[4] = IDiamondCut.FacetCut(address(ownershipFacet),       IDiamondCut.FacetCutAction.Add, ownSels);
        cut[5] = IDiamondCut.FacetCut(address(arbiterRegistryFacet), IDiamondCut.FacetCutAction.Add, arbSels);
        cut[6] = IDiamondCut.FacetCut(address(reputationFacet),      IDiamondCut.FacetCutAction.Add, repSels);
        cut[7] = IDiamondCut.FacetCut(
            address(new ArbiterAccountabilityFacet()), IDiamondCut.FacetCutAction.Add, accSels
        );

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
    //  KILL SWITCHES
    // ============================================================

    /// Every selector Agreement calls on the diamond. Hand-collected from
    /// src/Agreement.sol lines 495, 795, 827, 849, 875, 964, 1253, 1262,
    /// 1281, 1286 — not derived from anything the test also checks.
    function _agreementCallSelectors() internal pure returns (bytes4[] memory sels) {
        sels = new bytes4[](7);
        sels[0] = bytes4(keccak256("updateStatus(address,uint8)"));
        sels[1] = bytes4(keccak256("autoAwardXP(address)"));
        sels[2] = bytes4(keccak256("notifyExecutorFault(address)"));
        sels[3] = bytes4(keccak256("notifyArbiterTimeout(address)"));
        sels[4] = bytes4(keccak256("hasSubmittedVerdict(address)"));
        sels[5] = bytes4(keccak256("creditDisputeFee(uint256)"));
        sels[6] = bytes4(keccak256("clearDisputeClaim(address)"));
    }

    function _kill(Kill mode) internal {
        if (mode == Kill.ALIVE) return;

        if (mode == Kill.NO_CODE) {
            vm.etch(address(diamond), "");
            return;
        }

        bytes4[] memory sels = _agreementCallSelectors();
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);

        if (mode == Kill.SELECTORS_REMOVED) {
            cut[0] = IDiamondCut.FacetCut({
                facetAddress:      address(0),
                action:            IDiamondCut.FacetCutAction.Remove,
                functionSelectors: sels
            });
        } else {
            cut[0] = IDiamondCut.FacetCut({
                facetAddress:      address(new AlwaysRevertFacet()),
                action:            IDiamondCut.FacetCutAction.Replace,
                functionSelectors: sels
            });
        }
        DiamondCutFacet(address(diamond)).diamondCut(cut, address(0), "");
    }

    /// Proof that the kill is not an empty mutation: after SELECTORS_REMOVED
    /// / FACET_REVERTS the selector must genuinely stop answering. NO_CODE is
    /// self-evident (address has no code) and checked separately.
    function _assertDiamondReallyDeaf(Kill mode) internal view {
        if (mode == Kill.ALIVE) {
            (bool ok, ) = address(diamond).staticcall(
                abi.encodeWithSignature("hasSubmittedVerdict(address)", address(0x1234))
            );
            assertTrue(ok, "baseline must answer, otherwise every kill below is a no-op");
            return;
        }
        if (mode == Kill.NO_CODE) {
            assertEq(address(diamond).code.length, 0, "NO_CODE must leave no code");
            return;
        }
        (bool ok2, ) = address(diamond).staticcall(
            abi.encodeWithSignature("hasSubmittedVerdict(address)", address(0x1234))
        );
        assertFalse(ok2, "kill did not actually silence the diamond");
    }

    // ============================================================
    //  DEAL BUILDERS
    // ============================================================

    function _createFundedAgreement() internal returns (Agreement) {
        vm.startPrank(client);
        usdc.approve(address(diamond), type(uint256).max);
        address a = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, address(0), DEAL, DEADLINE_DAYS, "terms", 0
        );
        vm.stopPrank();

        usdc.mint(client, DEAL);
        vm.startPrank(client);
        usdc.approve(a, DEAL);
        Agreement(a).fund();
        vm.stopPrank();
        return Agreement(a);
    }

    function _activated() internal returns (Agreement a) {
        a = _createFundedAgreement();
        vm.prank(executor);
        a.activate();
    }

    function _markedDone() internal returns (Agreement a) {
        a = _activated();
        vm.prank(executor);
        a.markDone();
    }

    function _claimByArbiter(Agreement a) internal {
        bytes32 salt       = keccak256(abi.encodePacked("death-salt", address(a), block.number));
        bytes32 commitment = keccak256(abi.encodePacked(address(a), arbiterAddr, salt));
        vm.prank(arbiterAddr);
        ArbiterRegistryFacet(address(diamond)).commitDisputeClaim(commitment);
        vm.roll(block.number + 1);
        vm.prank(arbiterAddr);
        ArbiterRegistryFacet(address(diamond)).claimDispute(
            address(a), salt, bytes32(uint256(0xB0)), bytes32(uint256(0x51))
        );
    }

    // ============================================================
    //  MEASUREMENT
    // ============================================================

    struct Snap { uint256 clientBal; uint256 executorBal; uint256 escrowBal; }

    function _snap(Agreement a) internal view returns (Snap memory s) {
        s.clientBal   = usdc.balanceOf(client);
        s.executorBal = usdc.balanceOf(executor);
        s.escrowBal   = usdc.balanceOf(address(a));
    }

    function _call(Agreement a, string memory sig) internal returns (bool ok) {
        (ok, ) = address(a).call(abi.encodeWithSignature(sig));
    }

    function _callAs(address who, Agreement a, string memory sig) internal returns (bool ok) {
        vm.prank(who);
        (ok, ) = address(a).call(abi.encodeWithSignature(sig));
    }

    /// Not `view` on purpose: vm.getRecordedLogs() drains the buffer, so it
    /// must run as a real call.
    function _registrySyncFailedFired() internal returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == Agreement.RegistrySyncFailed.selector) {
                return true;
            }
        }
        return false;
    }

    function _registryStatus(Agreement a) internal view returns (uint8) {
        RegistryStorage.AgreementRecord memory r =
            RegistryFacet(address(diamond)).getRecord(address(a));
        return uint8(r.status);
    }

    // ============================================================
    //  1. THE EXTCODESIZE FINDING  (mode C is not mode A/B)
    // ============================================================
    //
    // This is the load-bearing fact for every NO_CODE row below, and it is
    // measured on a standalone probe so the conclusion does not depend on
    // Agreement's own code.

    function testTryCatchDoesNotCatchExtcodesizeGuard() public {
        address dead = address(0xDEAD01);
        assertEq(dead.code.length, 0, "probe target must have no code");
        ExtcodesizeProbe p = new ExtcodesizeProbe(dead);

        // A protected call (try/catch, no return data expected) does NOT
        // reach its catch block. The extcodesize guard solc emits reverts in
        // the caller's frame, outside the protected region.
        (bool ok, ) = address(p).call(abi.encodeWithSignature("protectedNoReturn()"));
        assertFalse(ok, "try/catch is expected NOT to survive a codeless target");

        // A bare call expecting return data reverts too, but for a different
        // reason: solc skips extcodesize when return data is expected, the
        // CALL succeeds with empty returndata, and the ABI decoder reverts.
        (bool ok2, ) = address(p).staticcall(abi.encodeWithSignature("bareWithReturn()"));
        assertFalse(ok2, "bare call with return value must revert on codeless target");

        // And the low-level shape used by Agreement.setArbiter succeeds with
        // empty data — so `if (!ok || ...)` never sees a failure; the revert
        // comes later, out of abi.decode.
        (bool okStatic, uint256 len) = p.lowLevelStatic();
        assertTrue(okStatic, "low-level staticcall to codeless address returns success");
        assertEq(len, 0, "...with empty return data");
    }

    // ============================================================
    //  2. BASELINE — the diamond calls really are live
    // ============================================================
    //
    // Anti-mirror guard. If this fails, every "money still got out" result
    // below is worthless, because the call that was supposedly killed was
    // never working in the first place.

    function testBaselineDiamondCallsAreLive() public {
        _assertDiamondReallyDeaf(Kill.ALIVE);

        Agreement a = _markedDone();
        vm.recordLogs();
        vm.prank(client);
        a.release();

        assertEq(_registryStatus(a), 1, "registry must move to COMPLETED while alive");
        assertFalse(_registrySyncFailedFired(), "RegistrySyncFailed must not fire while alive");
        assertGt(ReputationFacet(address(diamond)).getXP(executor), 0, "autoAwardXP must land while alive");
        assertEq(usdc.balanceOf(executor), DEAL, "executor paid in full");
    }

    // ============================================================
    //  3. release()  — client approves
    // ============================================================

    function _runRelease(Kill mode) internal returns (bool ok) {
        Agreement a = _markedDone();
        _kill(mode);
        _assertDiamondReallyDeaf(mode);

        Snap memory before = _snap(a);
        ok = _callAs(client, a, "release()");

        if (ok) {
            assertEq(usdc.balanceOf(executor) - before.executorBal, DEAL, "executor must receive DEAL");
            assertEq(usdc.balanceOf(address(a)), 0, "escrow must be empty");
        } else {
            assertEq(usdc.balanceOf(address(a)), before.escrowBal, "escrow untouched on revert");
        }
    }

    function testRelease_SelectorsRemoved_MoneyOut() public {
        assertTrue(_runRelease(Kill.SELECTORS_REMOVED), "release must survive a removed selector");
    }

    function testRelease_FacetReverts_MoneyOut() public {
        assertTrue(_runRelease(Kill.FACET_REVERTS), "release must survive a reverting facet");
    }

    function testRelease_NoCode_MoneyOut() public {
        assertTrue(_runRelease(Kill.NO_CODE), "release must survive a codeless diamond");
    }

    // ============================================================
    //  4. triggerAutoApprove()  — the "everybody is silent" path
    // ============================================================

    function _runAutoApprove(Kill mode) internal returns (bool ok) {
        Agreement a = _markedDone();
        vm.warp(block.timestamp + AUTO_APPROVE_WINDOW + 1);
        _kill(mode);
        _assertDiamondReallyDeaf(mode);

        Snap memory before = _snap(a);
        ok = _callAs(stranger, a, "triggerAutoApprove()");

        if (ok) {
            assertEq(usdc.balanceOf(executor) - before.executorBal, DEAL, "executor must receive DEAL");
            assertEq(usdc.balanceOf(address(a)), 0, "escrow must be empty");
        } else {
            assertEq(usdc.balanceOf(address(a)), before.escrowBal, "escrow untouched on revert");
        }
    }

    function testAutoApprove_SelectorsRemoved_MoneyOut() public {
        assertTrue(_runAutoApprove(Kill.SELECTORS_REMOVED), "auto-approve must survive a removed selector");
    }

    function testAutoApprove_FacetReverts_MoneyOut() public {
        assertTrue(_runAutoApprove(Kill.FACET_REVERTS), "auto-approve must survive a reverting facet");
    }

    function testAutoApprove_NoCode_MoneyOut() public {
        assertTrue(_runAutoApprove(Kill.NO_CODE), "auto-approve must survive a codeless diamond");
    }

    // ============================================================
    //  5. triggerActivationTimeout()  — executor never showed up
    // ============================================================

    function _runActivationTimeout(Kill mode) internal returns (bool ok) {
        Agreement a = _createFundedAgreement();
        vm.warp(block.timestamp + ACTIVATION_WINDOW + 1);
        _kill(mode);
        _assertDiamondReallyDeaf(mode);

        Snap memory before = _snap(a);
        ok = _callAs(client, a, "triggerActivationTimeout()");

        if (ok) {
            assertEq(usdc.balanceOf(client) - before.clientBal, DEAL, "client must be refunded DEAL");
            assertEq(usdc.balanceOf(address(a)), 0, "escrow must be empty");
        } else {
            assertEq(usdc.balanceOf(address(a)), before.escrowBal, "escrow untouched on revert");
        }
    }

    function testActivationTimeout_SelectorsRemoved_MoneyOut() public {
        assertTrue(_runActivationTimeout(Kill.SELECTORS_REMOVED), "refund must survive a removed selector");
    }

    function testActivationTimeout_FacetReverts_MoneyOut() public {
        assertTrue(_runActivationTimeout(Kill.FACET_REVERTS), "refund must survive a reverting facet");
    }

    function testActivationTimeout_NoCode_MoneyOut() public {
        assertTrue(_runActivationTimeout(Kill.NO_CODE), "refund must survive a codeless diamond");
    }

    // ============================================================
    //  6. triggerDeadlineTimeout()  — work never delivered
    // ============================================================

    function _runDeadlineTimeout(Kill mode) internal returns (bool ok) {
        Agreement a = _activated();
        vm.warp(block.timestamp + DEADLINE_DAYS * 1 days + DEADLINE_GRACE + 1);
        _kill(mode);
        _assertDiamondReallyDeaf(mode);

        Snap memory before = _snap(a);
        ok = _callAs(client, a, "triggerDeadlineTimeout()");

        if (ok) {
            assertEq(usdc.balanceOf(client) - before.clientBal, DEAL, "client must be refunded DEAL");
            assertEq(usdc.balanceOf(address(a)), 0, "escrow must be empty");
        } else {
            assertEq(usdc.balanceOf(address(a)), before.escrowBal, "escrow untouched on revert");
        }
    }

    function testDeadlineTimeout_SelectorsRemoved_MoneyOut() public {
        assertTrue(_runDeadlineTimeout(Kill.SELECTORS_REMOVED), "refund must survive a removed selector");
    }

    function testDeadlineTimeout_FacetReverts_MoneyOut() public {
        assertTrue(_runDeadlineTimeout(Kill.FACET_REVERTS), "refund must survive a reverting facet");
    }

    function testDeadlineTimeout_NoCode_MoneyOut() public {
        assertTrue(_runDeadlineTimeout(Kill.NO_CODE), "refund must survive a codeless diamond");
    }

    // ============================================================
    //  7. rejectExtra()  — the only money path that never calls the diamond
    // ============================================================

    function _runRejectExtra(Kill mode) internal returns (bool ok) {
        Agreement a = _activated();
        usdc.mint(client, EXTRA);
        vm.startPrank(client);
        usdc.approve(address(a), EXTRA);
        a.proposeExtra(EXTRA, "extra terms");
        vm.stopPrank();

        _kill(mode);
        _assertDiamondReallyDeaf(mode);

        Snap memory before = _snap(a);
        vm.prank(executor);
        (ok, ) = address(a).call(abi.encodeWithSignature("rejectExtra(uint256)", uint256(0)));

        if (ok) {
            assertEq(usdc.balanceOf(client) - before.clientBal, EXTRA, "client must get the extra back");
        }
    }

    function testRejectExtra_SelectorsRemoved_MoneyOut() public {
        assertTrue(_runRejectExtra(Kill.SELECTORS_REMOVED), "rejectExtra never touches the diamond");
    }

    function testRejectExtra_FacetReverts_MoneyOut() public {
        assertTrue(_runRejectExtra(Kill.FACET_REVERTS), "rejectExtra never touches the diamond");
    }

    function testRejectExtra_NoCode_MoneyOut() public {
        assertTrue(_runRejectExtra(Kill.NO_CODE), "rejectExtra never touches the diamond");
    }

    // ============================================================
    //  8. triggerArbiterTimeout() — THE ESCAPE HATCH
    // ============================================================
    //
    // The only exit from a disputed deal, and the guard in front of it runs
    // BEFORE any money moves. It used to be a bare
    // `IArbiterRegistryFacet(diamond).hasSubmittedVerdict(...)`, which made an
    // unreachable diamond mean "a verdict exists" and stranded the pot for
    // ever. It now reads through Agreement._verdictInFlight: a gas-capped
    // low-level staticcall whose failure means "no verdict", so the money
    // leaves in all three modes. Section 13 holds the other half of that
    // bargain — a LIVE diamond still blocks the hatch.

    function _runArbiterTimeoutUnclaimed(Kill mode) internal returns (bool ok) {
        Agreement a = _activated();
        vm.prank(client);
        a.raiseDispute();
        vm.prank(executor);
        a.respondToDispute();

        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);
        _kill(mode);
        _assertDiamondReallyDeaf(mode);

        Snap memory before = _snap(a);
        ok = _callAs(client, a, "triggerArbiterTimeout()");

        if (ok) {
            // both sides showed up -> pot split in half
            assertEq(usdc.balanceOf(client)   - before.clientBal,   DEAL_HALF, "client half");
            assertEq(usdc.balanceOf(executor) - before.executorBal, DEAL_HALF, "executor half");
            assertEq(usdc.balanceOf(address(a)), 0, "escrow must be empty");
        } else {
            assertEq(usdc.balanceOf(address(a)), before.escrowBal, "escrow untouched on revert");
        }
    }

    function testArbiterTimeoutUnclaimed_Alive_MoneyOut() public {
        assertTrue(_runArbiterTimeoutUnclaimed(Kill.ALIVE), "baseline: the escape hatch works while alive");
    }

    function testArbiterTimeoutUnclaimed_SelectorsRemoved_MoneyOut() public {
        assertTrue(
            _runArbiterTimeoutUnclaimed(Kill.SELECTORS_REMOVED),
            "the only escape must survive a removed selector"
        );
    }

    function testArbiterTimeoutUnclaimed_FacetReverts_MoneyOut() public {
        assertTrue(
            _runArbiterTimeoutUnclaimed(Kill.FACET_REVERTS),
            "the only escape must survive a reverting facet"
        );
    }

    function testArbiterTimeoutUnclaimed_NoCode_MoneyOut() public {
        assertTrue(
            _runArbiterTimeoutUnclaimed(Kill.NO_CODE),
            "the only escape must survive a codeless diamond"
        );
    }

    /// Same hatch, but an arbiter did claim the dispute (Agreement.arbiter is
    /// the diamond itself). Claiming needs a live diamond, so the kill lands
    /// after the claim.
    function _runArbiterTimeoutClaimed(Kill mode) internal returns (bool ok) {
        Agreement a = _activated();
        vm.prank(client);
        a.raiseDispute();
        _claimByArbiter(a);

        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);
        _kill(mode);
        _assertDiamondReallyDeaf(mode);

        Snap memory before = _snap(a);
        ok = _callAs(client, a, "triggerArbiterTimeout()");

        if (ok) {
            assertEq(usdc.balanceOf(client) - before.clientBal, DEAL, "arbiter at fault -> all to client");
            assertEq(usdc.balanceOf(address(a)), 0, "escrow must be empty");
        } else {
            assertEq(usdc.balanceOf(address(a)), before.escrowBal, "escrow untouched on revert");
        }
    }

    function testArbiterTimeoutClaimed_Alive_MoneyOut() public {
        assertTrue(_runArbiterTimeoutClaimed(Kill.ALIVE), "baseline: works while alive");
    }

    function testArbiterTimeoutClaimed_SelectorsRemoved_MoneyOut() public {
        assertTrue(_runArbiterTimeoutClaimed(Kill.SELECTORS_REMOVED), "money must come home");
    }

    function testArbiterTimeoutClaimed_FacetReverts_MoneyOut() public {
        assertTrue(_runArbiterTimeoutClaimed(Kill.FACET_REVERTS), "money must come home");
    }

    function testArbiterTimeoutClaimed_NoCode_MoneyOut() public {
        assertTrue(_runArbiterTimeoutClaimed(Kill.NO_CODE), "money must come home");
    }

    // ============================================================
    //  9. THE HATCH IS THE ONLY DOOR — AND IT OPENS
    // ============================================================
    //
    // Two halves of one statement, measured together because each is
    // worthless without the other. First: once disputedAt != 0 every other
    // door really is shut, so the hatch carries the whole promise. Second:
    // with the diamond silent, the hatch opens and the pot leaves.
    //
    // Before the fix the second half read assertFalse — that was the hole.

    function _assertHatchIsTheOnlyDoorAndItOpens(Kill mode) internal {
        Agreement a = _activated();
        vm.prank(client);
        a.raiseDispute();
        vm.prank(executor);
        a.respondToDispute();
        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);

        _kill(mode);
        uint256 escrowBefore = usdc.balanceOf(address(a));
        assertEq(escrowBefore, DEAL, "precondition: the pot is in the clone");

        assertFalse(_callAs(client,   a, "release()"),                 "release must not open a disputed deal");
        assertFalse(_callAs(stranger, a, "triggerAutoApprove()"),      "auto-approve is closed once disputed");
        assertFalse(_callAs(client,   a, "triggerDeadlineTimeout()"),  "deadline timeout is closed once disputed");
        assertFalse(_callAs(client,   a, "triggerActivationTimeout()"),"activation timeout needs !activated");
        assertFalse(_callAs(executor, a, "triggerAutoApprove()"),      "auto-approve is closed once disputed");

        // resolveDispute is reachable only through the diamond
        // (claimDispute makes the DIAMOND the arbiter), so a dead diamond
        // closes it by construction.
        assertFalse(_callAs(arbiterAddr, a, "resolveDispute(bool)"), "arbiter cannot resolve directly");
        (bool okRes, ) = address(a).call(abi.encodeWithSignature("resolveDispute(bool)", true));
        assertFalse(okRes, "nobody can resolve without the diamond");

        assertEq(usdc.balanceOf(address(a)), escrowBefore, "no other door moved the pot");

        // ...and the one door that is left does open.
        Snap memory before = _snap(a);
        assertTrue(_callAs(client, a, "triggerArbiterTimeout()"), "the only hatch must open");
        assertEq(usdc.balanceOf(client)   - before.clientBal,   DEAL_HALF, "client half");
        assertEq(usdc.balanceOf(executor) - before.executorBal, DEAL_HALF, "executor half");
        assertEq(usdc.balanceOf(address(a)), 0, "escrow must be empty");
    }

    function testHatchIsTheOnlyDoorAndItOpens_SelectorsRemoved() public {
        _assertHatchIsTheOnlyDoorAndItOpens(Kill.SELECTORS_REMOVED);
    }

    function testHatchIsTheOnlyDoorAndItOpens_FacetReverts() public {
        _assertHatchIsTheOnlyDoorAndItOpens(Kill.FACET_REVERTS);
    }

    function testHatchIsTheOnlyDoorAndItOpens_NoCode() public {
        _assertHatchIsTheOnlyDoorAndItOpens(Kill.NO_CODE);
    }

    /// A party can still raise a dispute while the diamond is down —
    /// raiseDispute reaches the diamond only through _updateRegistry, which is
    /// tolerated. That used to be a trap: entering DISPUTED during an outage
    /// meant entering a state with no exit, and nothing warned anyone. It is
    /// no longer a trap, and this measures exactly that: raise it mid-outage,
    /// then walk back out with the money.
    function _assertDisputeRaisedMidOutageStillHasAWayOut(Kill mode) internal {
        Agreement a = _activated();
        _kill(mode);
        _assertDiamondReallyDeaf(mode);

        assertTrue(_callAs(client, a, "raiseDispute()"), "a party can still enter a dispute during an outage");

        vm.prank(executor);
        a.respondToDispute();
        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);

        Snap memory before = _snap(a);
        assertTrue(_callAs(client, a, "triggerArbiterTimeout()"), "and can get back out again");
        assertEq(usdc.balanceOf(client)   - before.clientBal,   DEAL_HALF, "client half");
        assertEq(usdc.balanceOf(executor) - before.executorBal, DEAL_HALF, "executor half");
        assertEq(usdc.balanceOf(address(a)), 0, "pot released");
    }

    function testDisputeRaisedMidOutageStillHasAWayOut_SelectorsRemoved() public {
        _assertDisputeRaisedMidOutageStillHasAWayOut(Kill.SELECTORS_REMOVED);
    }

    function testDisputeRaisedMidOutageStillHasAWayOut_FacetReverts() public {
        _assertDisputeRaisedMidOutageStillHasAWayOut(Kill.FACET_REVERTS);
    }

    function testDisputeRaisedMidOutageStillHasAWayOut_NoCode() public {
        _assertDisputeRaisedMidOutageStillHasAWayOut(Kill.NO_CODE);
    }

    // ============================================================
    //  10. THE CATCH BRANCH REALLY RAN
    // ============================================================
    //
    // "Money got out" alone would also be true if the diamond call never
    // happened. These assert the fallback was exercised: the registry did
    // NOT advance, and RegistrySyncFailed fired.

    function testReleaseUnderDeadDiamondLeavesRegistryStaleAndSaysSo() public {
        Agreement a = _markedDone();
        uint8 statusBefore = _registryStatus(a);
        assertEq(statusBefore, 0, "precondition: registry says ACTIVE");

        _kill(Kill.FACET_REVERTS);
        vm.recordLogs();
        vm.prank(client);
        a.release();

        assertTrue(_registrySyncFailedFired(), "the catch branch must announce itself");
        assertEq(_registryStatus(a), 0, "registry must be left stale, proving the call failed");
        assertEq(usdc.balanceOf(executor), DEAL, "and the money still left the clone");
    }

    /// The NO_CODE twin of the test above, and the proof that the new
    /// `diamond.code.length` branch is what carries mode C. If Agreement had
    /// instead started calling a codeless address low-level and calling that
    /// success, the money would still be out — and the registry would be
    /// silently wrong. RegistrySyncFailed is what tells the two apart.
    function testCodelessDiamondPaysOutAndStillAnnouncesTheStaleRegistry() public {
        Agreement a = _markedDone();
        assertEq(_registryStatus(a), 0, "precondition: registry says ACTIVE");

        _kill(Kill.NO_CODE);
        vm.recordLogs();
        vm.prank(client);
        a.release();

        assertTrue(_registrySyncFailedFired(), "the codeless branch must announce itself");
        assertEq(usdc.balanceOf(executor), DEAL, "and the money still left the clone");
    }

    function testXpIsSilentlySkippedWhenDiamondIsDead() public {
        Agreement a = _markedDone();
        _kill(Kill.SELECTORS_REMOVED);

        vm.prank(client);
        a.release();

        // The XP selector is gone, so we cannot read through the diamond;
        // remount just the getter to observe the storage the facet writes.
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = ReputationFacet.autoAwardXP.selector;
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = IDiamondCut.FacetCut(address(new ReputationFacet()), IDiamondCut.FacetCutAction.Add, sels);
        DiamondCutFacet(address(diamond)).diamondCut(cut, address(0), "");

        assertEq(ReputationFacet(address(diamond)).getXP(executor), 0, "no XP was awarded");
        assertEq(usdc.balanceOf(executor), DEAL, "but the money still left the clone");
    }

    // ============================================================
    //  11. syncRegistry() — bare ON PURPOSE
    // ============================================================
    //
    // Same registry call as the one inside _complete, which IS tolerated —
    // and this one is deliberately not. syncRegistry moves no money; it is the
    // repair tool a monitor reaches for after a RegistrySyncFailed. A tolerant
    // version would answer "done" while the registry stayed wrong, which is
    // the one answer a repair tool must never give. So it keeps failing loudly
    // when the diamond is down, and this test pins that decision in place.

    function testSyncRegistryIsBareAndDiesWithTheDiamond() public {
        Agreement a = _markedDone();
        vm.prank(client);
        a.release();

        assertTrue(_call(a, "syncRegistry()"), "baseline: syncRegistry works while alive");

        Agreement b = _markedDone();
        _kill(Kill.FACET_REVERTS);
        vm.prank(client);
        b.release();
        assertFalse(_call(b, "syncRegistry()"), "MEASURED: Agreement.sol:1281 is bare");
    }

    // ============================================================
    //  12. THE GAS TRAP - try/catch does not survive a gas eater
    // ============================================================
    //
    // try/catch converts a revert into a caught failure, but it cannot give
    // back gas the callee already burned. EIP-150 hands the callee 63/64 of
    // what is left; the diamond adds a second frame (proxy -> delegatecall),
    // so each logical diamond call costs the Agreement about 1/32 of its
    // remaining gas when the facet eats everything.
    //
    // Agreement._complete makes TWO such calls in a row BEFORE the transfer
    // (_updateRegistry at Agreement.sol:1262, then autoAwardXP at
    // Agreement.sol:1253). Measured leftovers from a 30M budget:
    // 29_999_784 -> 929_412 -> 28_067.
    //
    // A facet that consumes all the gas is not exotic: any unbounded loop
    // over data that keeps growing gets there on its own.

    uint256 constant REALISTIC_GAS = 1_000_000; // generous wallet budget, hand-picked
    uint256 constant HUGE_GAS      = 30_000_000;

    function _mountGasBurner() internal {
        bytes4[] memory sels = new bytes4[](2);
        sels[0] = bytes4(keccak256("updateStatus(address,uint8)"));
        sels[1] = bytes4(keccak256("autoAwardXP(address)"));
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = IDiamondCut.FacetCut(
            address(new GasBurnerFacet()), IDiamondCut.FacetCutAction.Replace, sels
        );
        DiamondCutFacet(address(diamond)).diamondCut(cut, address(0), "");
    }

    function _autoApproveWithGas(uint256 gasBudget, bool burner) internal returns (bool ok) {
        Agreement a = _markedDone();
        vm.warp(block.timestamp + AUTO_APPROVE_WINDOW + 1);
        if (burner) _mountGasBurner();
        vm.prank(stranger);
        (ok, ) = address(a).call{gas: gasBudget}(abi.encodeWithSignature("triggerAutoApprove()"));
        if (ok) assertEq(usdc.balanceOf(executor), DEAL, "executor paid");
        else    assertEq(usdc.balanceOf(address(a)), DEAL, "pot stayed in the clone");
    }

    /// The independent half of the comparison: REALISTIC_GAS is NOT an
    /// artificially small number. With a healthy diamond the very same call
    /// completes inside it (measured cost ~419_481 gas).
    function testAutoApproveFitsInARealisticGasBudgetWhenDiamondIsHealthy() public {
        assertTrue(
            _autoApproveWithGas(REALISTIC_GAS, false),
            "baseline: 1M gas is plenty for auto-approve on a healthy diamond"
        );
    }

    function testGasBurningFacetBlocksAutoApproveAtARealisticGasBudget() public {
        assertFalse(
            _autoApproveWithGas(REALISTIC_GAS, true),
            "MEASURED: a gas-eating facet defeats try/catch at a realistic gas budget"
        );
    }

    /// Absurd budget, same setup. Proves the blocker is gas arithmetic and
    /// not some other revert. Measured crossover: ~29_791_258 gas, i.e. about
    /// 71x the healthy cost.
    function testGasBurningFacetIsBeatenOnlyByAnAbsurdGasBudget() public {
        assertTrue(
            _autoApproveWithGas(HUGE_GAS, true),
            "with 30M gas the leftover finally covers the transfer"
        );
    }

    /// A refund path makes only ONE diamond call before the transfer
    /// (notifyExecutorFault comes AFTER the money), so it loses ~1/32 once
    /// and survives. Recorded because it shows the damage scales with how
    /// many diamond calls sit in front of the payout.
    function testGasBurningFacetDoesNotBlockActivationTimeout() public {
        Agreement a = _createFundedAgreement();
        vm.warp(block.timestamp + ACTIVATION_WINDOW + 1);
        _mountGasBurner();

        vm.prank(client);
        (bool ok, ) = address(a).call{gas: REALISTIC_GAS}(
            abi.encodeWithSignature("triggerActivationTimeout()")
        );

        assertTrue(ok, "one burn only costs ~1/32 - enough left to pay out");
        assertEq(usdc.balanceOf(address(a)), 0, "escrow emptied");
    }

    // ============================================================
    //  13. THE OTHER HALF OF THE BARGAIN — A LIVE DIAMOND STILL BLOCKS
    // ============================================================
    //
    // Everything above says "a silent diamond must not lock the money in".
    // The check being fixed has a real job as well: while an arbiter's verdict
    // is in flight (FINALIZE_DELAY, appeal voting) a party must NOT be able to
    // force a refund and wipe the other arbiters' vote out. Section 13 is the
    // set of locks on that job, so the cure cannot quietly become "the check
    // never fires".
    //
    // Where the expectation comes from: a verdict is put in flight by actually
    // calling submitVerdict through the diamond — an action, not a reading of
    // the same slot the contract reads. The expected outcomes are hand-written
    // custom-error selectors.

    /// Deal in dispute, claimed by the arbiter, verdict SUBMITTED but not yet
    /// finalized. submitVerdict must land inside DISPUTE_WINDOW, so the warp
    /// past the window happens after it, in the callers.
    function _disputedWithVerdictSubmitted() internal returns (Agreement a) {
        a = _activated();
        vm.prank(client);
        a.raiseDispute();
        _claimByArbiter(a);
        vm.prank(arbiterAddr);
        ArbiterRegistryFacet(address(diamond)).submitVerdict(address(a), true);
    }

    function _revertSelector(bytes memory ret) internal pure returns (bytes4 sel) {
        if (ret.length < 4) return bytes4(0);
        assembly { sel := mload(add(ret, 0x20)) }
    }

    /// The behaviour that must NOT have changed: healthy diamond, live
    /// verdict, window elapsed — the hatch stays shut, and shuts with the same
    /// error as before.
    function testLiveVerdictStillBlocksTheHatch() public {
        Agreement a = _disputedWithVerdictSubmitted();
        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);

        vm.prank(client);
        (bool ok, bytes memory ret) = address(a).call(
            abi.encodeWithSignature("triggerArbiterTimeout()")
        );

        assertFalse(ok, "a live verdict must still block the timeout");
        assertEq(
            _revertSelector(ret),
            Agreement.VerdictInFlight.selector,
            "and it must be VerdictInFlight that blocks it"
        );
        assertEq(usdc.balanceOf(address(a)), DEAL, "the pot stayed in the clone");
    }

    /// The attack the gas cap invites and the gas floor closes.
    ///
    /// A failed read means "no verdict", so a party who could make the read
    /// run out of gas — while leaving enough for the payout — would force a
    /// refund straight through a live verdict on a perfectly healthy diamond.
    /// Agreement refuses to read at all unless it can hand over the full cap.
    ///
    /// Two things are asserted, and they are not the same thing: (1) NO gas
    /// budget at all lets the money out, and (2) the budgets below the floor
    /// are refused BY THE FLOOR — NotEnoughGasForVerdictCheck — rather than
    /// answered by a guess. Drop the floor and (2) goes red.
    function testGasStarvationCannotForceTheHatchPastALiveVerdict() public {
        Agreement a = _disputedWithVerdictSubmitted();
        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);
        assertEq(usdc.balanceOf(address(a)), DEAL, "precondition: the pot is in the clone");

        bool sawFloorRefusal;
        for (uint256 g = 40_000; g <= 400_000; g += 4_000) {
            vm.prank(client);
            (bool ok, bytes memory ret) = address(a).call{gas: g}(
                abi.encodeWithSignature("triggerArbiterTimeout()")
            );
            assertFalse(ok, "no gas budget may open the hatch past a live verdict");
            assertEq(usdc.balanceOf(address(a)), DEAL, "and the pot never moves");
            if (_revertSelector(ret) == Agreement.NotEnoughGasForVerdictCheck.selector) {
                sawFloorRefusal = true;
            }
        }
        assertTrue(sawFloorRefusal, "below the floor the contract must refuse to read, not guess");
    }

    /// What the cap is measured against. The number is the real cost of the
    /// read through the proxy with EVERYTHING cold — diamond account, the
    /// facet-address slot, the facet account, the verdict slot — because
    /// nothing in this test body touches the diamond before the probe runs.
    ///
    /// The cap literal below is hand-copied from Agreement.VERDICT_VIEW_GAS on
    /// purpose: reading it back out of the contract under test would make this
    /// assertion look at itself. A cap set too LOW is caught by behaviour, not
    /// by this test — testLiveVerdictStillBlocksTheHatch goes red the moment
    /// the read stops fitting in its budget.
    uint256 constant VERDICT_VIEW_GAS_CAP = 100_000; // = Agreement.VERDICT_VIEW_GAS

    function testVerdictViewCostSitsFarUnderTheCap() public {
        VerdictViewProbe probe = new VerdictViewProbe(address(diamond));
        (uint256 used, bool ok, uint256 word) = probe.measure(address(0xCAFE01));

        assertTrue(ok, "the read must actually answer, otherwise this measures nothing");
        assertEq(word, 0, "an address with no dispute must read as no verdict");
        emit log_named_uint("hasSubmittedVerdict through the diamond, all cold", used);
        assertLt(used * 4, VERDICT_VIEW_GAS_CAP, "the cap must keep at least 4x headroom over the real cost");
    }

    /// The gas cap earns its keep here: a facet that eats gas on the verdict
    /// selector cannot drag the hatch down with it. Without the cap the read
    /// would be handed 63/64 of the transaction and nothing would be left to
    /// pay anyone.
    function testGasBurningVerdictFacetCannotBlockTheHatch() public {
        Agreement a = _activated();
        vm.prank(client);
        a.raiseDispute();
        vm.prank(executor);
        a.respondToDispute();
        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);

        bytes4[] memory sels = new bytes4[](1);
        sels[0] = bytes4(keccak256("hasSubmittedVerdict(address)"));
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = IDiamondCut.FacetCut(
            address(new GasBurnerFacet()), IDiamondCut.FacetCutAction.Replace, sels
        );
        DiamondCutFacet(address(diamond)).diamondCut(cut, address(0), "");

        Snap memory before = _snap(a);
        vm.prank(client);
        (bool ok, ) = address(a).call{gas: REALISTIC_GAS}(
            abi.encodeWithSignature("triggerArbiterTimeout()")
        );

        assertTrue(ok, "a capped read cannot be starved into taking the whole transaction");
        assertEq(usdc.balanceOf(client)   - before.clientBal,   DEAL_HALF, "client half");
        assertEq(usdc.balanceOf(executor) - before.executorBal, DEAL_HALF, "executor half");
        assertEq(usdc.balanceOf(address(a)), 0, "escrow emptied");
    }
}
