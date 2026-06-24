// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Extras test suite.
// Covers proposeExtra / acceptExtra / rejectExtra and the settlement
// logic that folds accepted extras into the final payout.
//
// Money invariant: sum(all balances) == INITIAL_TOTAL at every step.
// _settlePending() returns un-accepted extras to client on any finalization.

import "forge-std/Test.sol";
import "../src/DiamondProxy.sol";
import "../src/RegistryFacet.sol";
import "../src/FactoryFacet.sol";
import "../src/AgreementDeployer.sol";
import "../src/Agreement.sol";
import "../src/facets/ArbiterRegistryFacet.sol";

// ---------- MOCK USDC ----------

contract MockUSDCE {
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

contract ExtrasTest is Test {
    DiamondProxy diamond;
    MockUSDCE    usdc;

    address owner;
    address client;
    address executor;
    address arbiter;
    address feeRecipient;

    uint256 constant CLIENT_USDC   = 1_000_000_000;
    uint256 constant EXECUTOR_USDC =   200_000_000;
    uint256 constant INITIAL_TOTAL = CLIENT_USDC + EXECUTOR_USDC;

    uint8   constant REGION     = 0;
    uint256 constant BOARD_FEE  = 2_000_000;
    uint256 constant JOB_AMOUNT = 100_000_000;
    uint256 constant EXTRA_A    =  20_000_000; // first extra
    uint256 constant EXTRA_B    =  10_000_000; // second extra
    uint256 constant DEADLINE   = 7;
    bytes32 constant TERMS      = keccak256("terms");
    bytes32 constant EXTRA_HASH = keccak256("extra-terms");
    bytes32 constant SALT       = bytes32("hexseal-extras-salt");

    // ============================================================
    //  SETUP
    // ============================================================

    function setUp() public {
        owner        = address(this);
        client       = address(0x1);
        executor     = address(0x2);
        arbiter      = address(0x3);
        feeRecipient = address(0x4);

        usdc = new MockUSDCE();
        usdc.mint(client,   CLIENT_USDC);
        usdc.mint(executor, EXECUTOR_USDC);

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

        bytes4[] memory arbSels = new bytes4[](33);
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

        bytes4[] memory cutSels   = new bytes4[](1);
        cutSels[0] = DiamondCutFacet.diamondCut.selector;

        bytes4[] memory loupeSels = new bytes4[](5);
        loupeSels[0] = DiamondLoupeFacet.facets.selector;
        loupeSels[1] = DiamondLoupeFacet.facetFunctionSelectors.selector;
        loupeSels[2] = DiamondLoupeFacet.facetAddresses.selector;
        loupeSels[3] = DiamondLoupeFacet.facetAddress.selector;
        loupeSels[4] = DiamondLoupeFacet.supportsInterface.selector;

        bytes4[] memory ownSels   = new bytes4[](2);
        ownSels[0] = OwnershipFacet.transferOwnership.selector;
        ownSels[1] = OwnershipFacet.owner.selector;

        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](6);
        cut[0] = IDiamondCut.FacetCut(address(registryFacet),        IDiamondCut.FacetCutAction.Add, regSels);
        cut[1] = IDiamondCut.FacetCut(address(factoryFacet),         IDiamondCut.FacetCutAction.Add, facSels);
        cut[2] = IDiamondCut.FacetCut(address(diamondCutFacet),      IDiamondCut.FacetCutAction.Add, cutSels);
        cut[3] = IDiamondCut.FacetCut(address(diamondLoupeFacet),    IDiamondCut.FacetCutAction.Add, loupeSels);
        cut[4] = IDiamondCut.FacetCut(address(ownershipFacet),       IDiamondCut.FacetCutAction.Add, ownSels);
        cut[5] = IDiamondCut.FacetCut(address(arbiterRegistryFacet), IDiamondCut.FacetCutAction.Add, arbSels);

        diamond = new DiamondProxy(owner, cut, address(0), "");

        AgreementDeployer agDeployer = new AgreementDeployer();
        RegistryFacet(address(diamond)).initRegistry(address(diamond));
        FactoryFacet(address(diamond)).initFactory(
            address(usdc), feeRecipient, address(0), address(diamond), address(agDeployer)
        );
        ArbiterRegistryFacet(address(diamond)).addArbiter(arbiter);
    }

    // ============================================================
    //  HELPERS
    // ============================================================

    function _systemBalance(address agr) internal view returns (uint256) {
        return usdc.balanceOf(client)
             + usdc.balanceOf(executor)
             + usdc.balanceOf(feeRecipient)
             + usdc.balanceOf(address(diamond))
             + (agr != address(0) ? usdc.balanceOf(agr) : 0);
    }

    // Deploy agreement directly (client pays fee + funds it).
    function _deployActive() internal returns (address agr) {
        vm.startPrank(client);
        usdc.approve(address(diamond), BOARD_FEE);
        agr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, address(0), JOB_AMOUNT, DEADLINE, TERMS, REGION
        );
        usdc.approve(agr, JOB_AMOUNT);
        Agreement(agr).fund();
        vm.stopPrank();

        vm.prank(executor);
        Agreement(agr).activate();
    }

    function _proposeExtra(address agr, uint256 amount) internal returns (uint256 extraId) {
        vm.startPrank(client);
        usdc.approve(agr, amount);
        Agreement(agr).proposeExtra(amount, EXTRA_HASH);
        vm.stopPrank();
        extraId = Agreement(agr).nextExtraId() - 1;
    }

    function _claimDispute(address agr) internal {
        vm.prank(client);
        Agreement(agr).raiseDispute();
        bytes32 commitment = keccak256(abi.encodePacked(agr, arbiter, SALT));
        vm.prank(arbiter);
        ArbiterRegistryFacet(address(diamond)).commitDisputeClaim(commitment);
        vm.roll(block.number + 1);
        vm.prank(arbiter);
        ArbiterRegistryFacet(address(diamond)).claimDispute(agr, SALT);
    }

    function _resolveDispute(address agr, bool clientWins) internal {
        vm.prank(arbiter);
        ArbiterRegistryFacet(address(diamond)).submitVerdict(agr, clientWins);
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(agr);
    }

    // ============================================================
    //  HAPPY PATH — ACCEPTED EXTRAS
    // ============================================================

    function testExtras_AcceptedPaidOnRelease() public {
        address agr = _deployActive();

        uint256 extraId = _proposeExtra(agr, EXTRA_A);
        assertEq(_systemBalance(agr), INITIAL_TOTAL, "invariant after propose");
        assertEq(usdc.balanceOf(agr), JOB_AMOUNT + EXTRA_A, "extra locked in agreement");
        assertEq(Agreement(agr).pendingExtrasTotal(), EXTRA_A, "pending tracked");

        vm.prank(executor);
        Agreement(agr).acceptExtra(extraId);
        assertEq(Agreement(agr).extrasTotal(),        EXTRA_A, "moved to accepted");
        assertEq(Agreement(agr).pendingExtrasTotal(), 0,       "pending cleared");
        assertEq(_systemBalance(agr), INITIAL_TOTAL, "invariant after accept");

        vm.prank(executor);
        Agreement(agr).markDone();
        vm.prank(client);
        Agreement(agr).release();

        assertEq(_systemBalance(address(0)), INITIAL_TOTAL, "invariant after release");
        assertEq(usdc.balanceOf(executor), EXECUTOR_USDC + JOB_AMOUNT + EXTRA_A, "executor got base + extra");
        assertEq(usdc.balanceOf(agr), 0, "agreement empty");
    }

    function testExtras_MultipleAccepted_AllPaidOnRelease() public {
        address agr = _deployActive();

        uint256 id0 = _proposeExtra(agr, EXTRA_A);
        uint256 id1 = _proposeExtra(agr, EXTRA_B);
        assertEq(_systemBalance(agr), INITIAL_TOTAL, "invariant after two proposals");
        assertEq(Agreement(agr).pendingExtrasTotal(), EXTRA_A + EXTRA_B);

        vm.startPrank(executor);
        Agreement(agr).acceptExtra(id0);
        Agreement(agr).acceptExtra(id1);
        vm.stopPrank();

        assertEq(Agreement(agr).extrasTotal(), EXTRA_A + EXTRA_B, "both accepted");

        vm.prank(executor);
        Agreement(agr).markDone();
        vm.prank(client);
        Agreement(agr).release();

        assertEq(_systemBalance(address(0)), INITIAL_TOTAL, "invariant after release");
        assertEq(
            usdc.balanceOf(executor),
            EXECUTOR_USDC + JOB_AMOUNT + EXTRA_A + EXTRA_B,
            "executor got base + both extras"
        );
    }

    function testExtras_AcceptedPaidOnAutoApprove() public {
        address agr = _deployActive();
        uint256 extraId = _proposeExtra(agr, EXTRA_A);

        vm.prank(executor);
        Agreement(agr).acceptExtra(extraId);
        vm.prank(executor);
        Agreement(agr).markDone();

        vm.warp(block.timestamp + 5 days + 1);
        Agreement(agr).triggerAutoApprove();

        assertEq(_systemBalance(address(0)), INITIAL_TOTAL, "invariant after autoApprove");
        assertEq(usdc.balanceOf(executor), EXECUTOR_USDC + JOB_AMOUNT + EXTRA_A, "executor got base + extra");
        assertEq(usdc.balanceOf(agr), 0, "agreement empty");
    }

    // ============================================================
    //  REJECTED EXTRAS
    // ============================================================

    function testExtras_RejectedRefundedImmediately() public {
        address agr    = _deployActive();
        uint256 clientBefore = usdc.balanceOf(client);

        uint256 extraId = _proposeExtra(agr, EXTRA_A);
        assertEq(_systemBalance(agr), INITIAL_TOTAL, "invariant after propose");

        vm.prank(executor);
        Agreement(agr).rejectExtra(extraId);

        assertEq(_systemBalance(agr), INITIAL_TOTAL, "invariant after reject");
        assertEq(usdc.balanceOf(client), clientBefore, "client fully refunded");
        assertEq(Agreement(agr).pendingExtrasTotal(), 0, "pending cleared");

        // Agreement has only the base amount
        assertEq(usdc.balanceOf(agr), JOB_AMOUNT, "only base in agreement");
    }

    function testExtras_RejectedThenNewProposal() public {
        address agr = _deployActive();

        uint256 id0 = _proposeExtra(agr, EXTRA_A);
        vm.prank(executor);
        Agreement(agr).rejectExtra(id0);

        // Client proposes again with a different amount
        uint256 id1 = _proposeExtra(agr, EXTRA_B);
        vm.prank(executor);
        Agreement(agr).acceptExtra(id1);

        vm.prank(executor);
        Agreement(agr).markDone();
        vm.prank(client);
        Agreement(agr).release();

        assertEq(_systemBalance(address(0)), INITIAL_TOTAL, "invariant after release");
        assertEq(usdc.balanceOf(executor), EXECUTOR_USDC + JOB_AMOUNT + EXTRA_B, "executor got base + accepted extra only");
    }

    // ============================================================
    //  PENDING EXTRAS RETURNED ON FINALIZATION
    // ============================================================

    // Pending extra (not accepted/rejected) must be returned to client
    // by _settlePending() on any finalization path.

    function testExtras_PendingReturnedOnDeadlineTimeout() public {
        address agr = _deployActive();
        uint256 clientBefore = usdc.balanceOf(client);

        _proposeExtra(agr, EXTRA_A); // pending, not accepted
        assertEq(Agreement(agr).pendingExtrasTotal(), EXTRA_A);

        vm.warp(block.timestamp + DEADLINE * 1 days + 1);
        vm.prank(client);
        Agreement(agr).triggerDeadlineTimeout();

        assertEq(_systemBalance(address(0)), INITIAL_TOTAL, "invariant after timeout");
        // clientBefore is measured before proposeExtra, so EXTRA_A nets to zero:
        // client paid EXTRA_A into agreement, _settlePending returned it, payout added JOB_AMOUNT.
        assertEq(usdc.balanceOf(client), clientBefore + JOB_AMOUNT, "client refunded base + pending extra");
        assertEq(usdc.balanceOf(agr), 0, "agreement empty");
    }

    function testExtras_MixedPendingAndAccepted_CorrectSplit() public {
        // EXTRA_A accepted (→ executor), EXTRA_B pending (→ client on refund)
        address agr = _deployActive();

        uint256 id0 = _proposeExtra(agr, EXTRA_A);
        _proposeExtra(agr, EXTRA_B); // id1 stays pending — we only need the effect

        vm.prank(executor);
        Agreement(agr).acceptExtra(id0);

        assertEq(Agreement(agr).extrasTotal(),        EXTRA_A, "accepted");
        assertEq(Agreement(agr).pendingExtrasTotal(), EXTRA_B, "pending");

        // Deadline timeout: executor gets nothing (refund path), client gets base + pending
        vm.warp(block.timestamp + DEADLINE * 1 days + 1);
        vm.prank(client);
        Agreement(agr).triggerDeadlineTimeout();

        assertEq(_systemBalance(address(0)), INITIAL_TOTAL, "invariant final");
        // _settlePending → EXTRA_B back to client
        // _complete(REFUNDED) → JOB_AMOUNT + EXTRA_A (extrasTotal) back to client
        // total refund = JOB_AMOUNT + EXTRA_A + EXTRA_B
        uint256 clientNet = usdc.balanceOf(client);
        // client started with CLIENT_USDC, paid BOARD_FEE + JOB_AMOUNT + EXTRA_A + EXTRA_B
        // gets back JOB_AMOUNT + EXTRA_A + EXTRA_B → net loss = BOARD_FEE only
        assertEq(clientNet, CLIENT_USDC - BOARD_FEE, "client net: fee only");
        assertEq(usdc.balanceOf(agr), 0, "agreement empty");
    }

    function testExtras_PendingReturnedOnDisputeClientWins() public {
        address agr = _deployActive();

        _proposeExtra(agr, EXTRA_A); // pending
        _claimDispute(agr);

        _resolveDispute(agr, true); // client wins

        assertEq(_systemBalance(address(0)), INITIAL_TOTAL, "invariant final");
        // client gets JOB_AMOUNT + EXTRA_A (pending returned by _settlePending)
        assertEq(usdc.balanceOf(agr), 0, "agreement empty");
    }

    // ============================================================
    //  ACCESS CONTROL
    // ============================================================

    function testExtras_OnlyClientCanPropose() public {
        address agr = _deployActive();
        vm.startPrank(executor);
        usdc.approve(agr, EXTRA_A);
        vm.expectRevert(Agreement.NotClient.selector);
        Agreement(agr).proposeExtra(EXTRA_A, EXTRA_HASH);
        vm.stopPrank();
    }

    function testExtras_OnlyExecutorCanAccept() public {
        address agr    = _deployActive();
        uint256 extraId = _proposeExtra(agr, EXTRA_A);
        vm.prank(client);
        vm.expectRevert(Agreement.NotExecutor.selector);
        Agreement(agr).acceptExtra(extraId);
    }

    function testExtras_OnlyExecutorCanReject() public {
        address agr    = _deployActive();
        uint256 extraId = _proposeExtra(agr, EXTRA_A);
        vm.prank(client);
        vm.expectRevert(Agreement.NotExecutor.selector);
        Agreement(agr).rejectExtra(extraId);
    }

    function testExtras_CannotProposeAfterMarkDone() public {
        address agr = _deployActive();
        vm.prank(executor);
        Agreement(agr).markDone();
        vm.startPrank(client);
        usdc.approve(agr, EXTRA_A);
        vm.expectRevert(Agreement.AlreadyMarkedDone.selector);
        Agreement(agr).proposeExtra(EXTRA_A, EXTRA_HASH);
        vm.stopPrank();
    }

    function testExtras_CannotAcceptAlreadyAccepted() public {
        address agr    = _deployActive();
        uint256 extraId = _proposeExtra(agr, EXTRA_A);
        vm.prank(executor);
        Agreement(agr).acceptExtra(extraId);
        vm.prank(executor);
        vm.expectRevert(Agreement.ExtraNotPending.selector);
        Agreement(agr).acceptExtra(extraId);
    }

    function testExtras_CannotRejectAlreadyRejected() public {
        address agr    = _deployActive();
        uint256 extraId = _proposeExtra(agr, EXTRA_A);
        vm.prank(executor);
        Agreement(agr).rejectExtra(extraId);
        vm.prank(executor);
        vm.expectRevert(Agreement.ExtraNotPending.selector);
        Agreement(agr).rejectExtra(extraId);
    }

    function testExtras_ZeroAmountReverts() public {
        address agr = _deployActive();
        vm.startPrank(client);
        usdc.approve(agr, 1);
        vm.expectRevert(Agreement.ZeroAmount.selector);
        Agreement(agr).proposeExtra(0, EXTRA_HASH);
        vm.stopPrank();
    }
}
