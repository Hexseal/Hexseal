// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/DiamondProxy.sol";
import "../src/RegistryFacet.sol";
import "../src/FactoryFacet.sol";
import "../src/AgreementDeployer.sol";
import "../src/facets/ArbiterRegistryFacet.sol";
import "../src/facets/ReputationFacet.sol";

contract MockUSDC {
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

contract DiamondTest is Test {
    DiamondProxy diamond;
    MockUSDC usdc;
    
    address owner;
    address client;
    address executor;
    address arbiter;
    address feeRecipient;
    
    uint256 constant AMOUNT = 100 * 10**6;
    uint256 constant DEADLINE = 7;
    string constant TERMS_HASH = "test terms";
    bytes32 constant DISPUTE_SALT = bytes32("hexseal-test-salt");
    uint256 constant ARBITER_BOND = 50 * 10**6; // must match ArbiterRegistryFacet.ARBITER_BOND
    
    function setUp() public {
        owner = address(this);
        client = address(0x1);
        executor = address(0x2);
        arbiter = address(0x3);
        feeRecipient = address(0x4);
        
        usdc = new MockUSDC();
        usdc.mint(client, 10000 * 10**6);
        usdc.mint(feeRecipient, 10000 * 10**6);
        
        RegistryFacet registryFacet = new RegistryFacet();
        FactoryFacet factoryFacet = new FactoryFacet();
        DiamondCutFacet diamondCutFacet = new DiamondCutFacet();
        DiamondLoupeFacet diamondLoupeFacet = new DiamondLoupeFacet();
        OwnershipFacet ownershipFacet = new OwnershipFacet();
        ArbiterRegistryFacet arbiterRegistryFacet = new ArbiterRegistryFacet();
        ReputationFacet reputationFacet = new ReputationFacet();
        
        // RegistryFacet selectors
        bytes4[] memory registrySelectors = new bytes4[](12);
        registrySelectors[0] = RegistryFacet.initRegistry.selector;
        registrySelectors[1] = RegistryFacet.register.selector;
        registrySelectors[2] = RegistryFacet.updateStatus.selector;
        registrySelectors[3] = RegistryFacet.setAuthorizedFactory.selector;
        registrySelectors[4] = RegistryFacet.hasActivePair.selector;
        registrySelectors[5] = RegistryFacet.getActivePair.selector;
        registrySelectors[6] = RegistryFacet.getRecord.selector;
        registrySelectors[7] = RegistryFacet.getByClient.selector;
        registrySelectors[8] = RegistryFacet.getByExecutor.selector;
        registrySelectors[9] = RegistryFacet.getActive.selector;
        registrySelectors[10] = RegistryFacet.totalAgreements.selector;
        registrySelectors[11] = RegistryFacet.authorizedFactory.selector;
        
        // FactoryFacet selectors
        bytes4[] memory factorySelectors = new bytes4[](12);
        factorySelectors[0] = FactoryFacet.initFactory.selector;
        factorySelectors[1] = FactoryFacet.deployAgreement.selector;
        factorySelectors[2] = FactoryFacet.setRegionFee.selector;
        factorySelectors[3] = FactoryFacet.setFeeRecipient.selector;
        factorySelectors[4] = FactoryFacet.setTrustedForwarder.selector;
        factorySelectors[5] = bytes4(0x16c38b3c);
        factorySelectors[6] = FactoryFacet.getRegionFee.selector;
        factorySelectors[7] = FactoryFacet.getAllFees.selector;
        factorySelectors[8] = FactoryFacet.getFeeRecipient.selector;
        factorySelectors[9] = FactoryFacet.getTrustedForwarder.selector;
        factorySelectors[10] = bytes4(0xb187bd26);
        factorySelectors[11] = FactoryFacet.getUsdc.selector;
        
        // DiamondCutFacet selectors
        bytes4[] memory cutSelectors = new bytes4[](1);
        cutSelectors[0] = DiamondCutFacet.diamondCut.selector;
        
        // DiamondLoupeFacet selectors
        bytes4[] memory loupeSelectors = new bytes4[](5);
        loupeSelectors[0] = DiamondLoupeFacet.facets.selector;
        loupeSelectors[1] = DiamondLoupeFacet.facetFunctionSelectors.selector;
        loupeSelectors[2] = DiamondLoupeFacet.facetAddresses.selector;
        loupeSelectors[3] = DiamondLoupeFacet.facetAddress.selector;
        loupeSelectors[4] = DiamondLoupeFacet.supportsInterface.selector;
        
        // OwnershipFacet selectors
        bytes4[] memory ownerSelectors = new bytes4[](4);
        ownerSelectors[0] = OwnershipFacet.transferOwnership.selector;
        ownerSelectors[1] = OwnershipFacet.owner.selector;
        ownerSelectors[2] = OwnershipFacet.acceptOwnership.selector;
        ownerSelectors[3] = OwnershipFacet.pendingOwner.selector;

        // ArbiterRegistryFacet selectors
        bytes4[] memory arbiterSelectors = new bytes4[](43);
        arbiterSelectors[0]  = ArbiterRegistryFacet.setChiefArbiter.selector;
        arbiterSelectors[1]  = ArbiterRegistryFacet.addArbiter.selector;
        arbiterSelectors[2]  = ArbiterRegistryFacet.commitDisputeClaim.selector;
        arbiterSelectors[3]  = ArbiterRegistryFacet.claimDispute.selector;
        arbiterSelectors[4]  = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        arbiterSelectors[5]  = ArbiterRegistryFacet.clearDisputeClaim.selector;
        arbiterSelectors[6]  = ArbiterRegistryFacet.getChiefArbiter.selector;
        arbiterSelectors[7]  = ArbiterRegistryFacet.isRegisteredArbiter.selector;
        arbiterSelectors[8]  = ArbiterRegistryFacet.getArbiters.selector;
        arbiterSelectors[9] = ArbiterRegistryFacet.getDisputeClaimer.selector;
        arbiterSelectors[10] = ArbiterRegistryFacet.getArbiterDeals.selector;
        arbiterSelectors[11] = ArbiterRegistryFacet.getClaimCommitment.selector;
        // DAO + verdict + rewards (V2/V3)
        arbiterSelectors[12] = ArbiterRegistryFacet.activateDAO.selector;
        arbiterSelectors[13] = ArbiterRegistryFacet.applyAsArbiter.selector;
        arbiterSelectors[14] = ArbiterRegistryFacet.isDaoActive.selector;
        arbiterSelectors[15] = ArbiterRegistryFacet.getMinXPToRegister.selector;
        arbiterSelectors[16] = ArbiterRegistryFacet.getDaoThreshold.selector;
        arbiterSelectors[17] = ArbiterRegistryFacet.submitVerdict.selector;
        arbiterSelectors[18] = ArbiterRegistryFacet.finalizeVerdict.selector;
        arbiterSelectors[19] = ArbiterRegistryFacet.overturnVerdict.selector;
        arbiterSelectors[20] = ArbiterRegistryFacet.freezeVerdict.selector;
        arbiterSelectors[21] = ArbiterRegistryFacet.unfreezeVerdict.selector;
        arbiterSelectors[22] = ArbiterRegistryFacet.withdrawArbiterReward.selector;
        arbiterSelectors[23] = ArbiterRegistryFacet.fundVault.selector;
        arbiterSelectors[24] = ArbiterRegistryFacet.setRewardPerDispute.selector;
        arbiterSelectors[25] = ArbiterRegistryFacet.setDAOAddress.selector;
        arbiterSelectors[26] = ArbiterRegistryFacet.getPendingVerdict.selector;
        arbiterSelectors[27] = ArbiterRegistryFacet.getArbiterReward.selector;
        arbiterSelectors[28] = ArbiterRegistryFacet.getVaultBalance.selector;
        arbiterSelectors[29] = ArbiterRegistryFacet.getRewardPerDispute.selector;
        arbiterSelectors[30] = ArbiterRegistryFacet.getDAOAddress.selector;
        arbiterSelectors[31] = ArbiterRegistryFacet.clearStuckVerdict.selector;
        arbiterSelectors[32] = ArbiterRegistryFacet.notifyArbiterTimeout.selector;
        arbiterSelectors[33] = ArbiterRegistryFacet.getArbiterMistakeStreak.selector;
        arbiterSelectors[34] = ArbiterRegistryFacet.resignAsArbiter.selector;
        arbiterSelectors[35] = ArbiterRegistryFacet.getArbiterBond.selector;
        arbiterSelectors[36] = ArbiterRegistryFacet.getOpenClaimCount.selector;
        arbiterSelectors[37] = ArbiterRegistryFacet.hasSubmittedVerdict.selector;
        arbiterSelectors[38] = ArbiterRegistryFacet.raiseAppeal.selector;
        arbiterSelectors[39] = ArbiterRegistryFacet.voteOnAppeal.selector;
        arbiterSelectors[40] = ArbiterRegistryFacet.resolveAppeal.selector;
        arbiterSelectors[41] = ArbiterRegistryFacet.getAppealVotes.selector;
        arbiterSelectors[42] = ArbiterRegistryFacet.hasVotedOnAppeal.selector;

        // ReputationFacet selectors
        bytes4[] memory reputationSelectors = new bytes4[](8);
        reputationSelectors[0] = ReputationFacet.claimXP.selector;
        reputationSelectors[1] = ReputationFacet.getXP.selector;
        reputationSelectors[2] = ReputationFacet.getUniqueActiveUsers.selector;
        reputationSelectors[3] = ReputationFacet.hasClaimed.selector;
        reputationSelectors[4] = ReputationFacet.isDealWin.selector;
        reputationSelectors[5] = ReputationFacet.autoAwardXP.selector;
        reputationSelectors[6] = ReputationFacet.notifyExecutorFault.selector;
        reputationSelectors[7] = ReputationFacet.getCleanStreak.selector;

        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](7);
        cut[0] = IDiamondCut.FacetCut(address(registryFacet), IDiamondCut.FacetCutAction.Add, registrySelectors);
        cut[1] = IDiamondCut.FacetCut(address(factoryFacet), IDiamondCut.FacetCutAction.Add, factorySelectors);
        cut[2] = IDiamondCut.FacetCut(address(diamondCutFacet), IDiamondCut.FacetCutAction.Add, cutSelectors);
        cut[3] = IDiamondCut.FacetCut(address(diamondLoupeFacet), IDiamondCut.FacetCutAction.Add, loupeSelectors);
        cut[4] = IDiamondCut.FacetCut(address(ownershipFacet), IDiamondCut.FacetCutAction.Add, ownerSelectors);
        cut[5] = IDiamondCut.FacetCut(address(arbiterRegistryFacet), IDiamondCut.FacetCutAction.Add, arbiterSelectors);
        cut[6] = IDiamondCut.FacetCut(address(reputationFacet), IDiamondCut.FacetCutAction.Add, reputationSelectors);

        diamond = new DiamondProxy(owner, cut, address(0), "");
        Agreement agreementImpl = new Agreement();
        AgreementDeployer agDeployer = new AgreementDeployer(address(diamond), address(agreementImpl));

        RegistryFacet(address(diamond)).initRegistry(address(diamond));
        FactoryFacet(address(diamond)).initFactory(address(usdc), feeRecipient, address(0xDEAD), address(diamond), address(agDeployer));
        ArbiterRegistryFacet(address(diamond)).addArbiter(arbiter);
    }
    
    
    // ============ HELPERS ============

    function _claimDispute(address agreementAddr) internal {
        _claimDisputeAs(agreementAddr, arbiter);
    }

    // Parametrized version of _claimDispute for tests using a non-default arbiter address.
    // Isolated in its own function (not inlined at each call site) — inlining this sequence
    // more than once directly inside one large test function was observed to make the second
    // vm.roll(block.number + 1) not take effect, even though the same pattern works fine via
    // a helper call.
    function _claimDisputeAs(address agreementAddr, address arbiterAddr) internal {
        bytes32 commitment = keccak256(abi.encodePacked(agreementAddr, arbiterAddr, DISPUTE_SALT));
        vm.prank(arbiterAddr);
        ArbiterRegistryFacet(address(diamond)).commitDisputeClaim(commitment);
        uint256 nextBlock = block.number + 1;
        vm.roll(nextBlock);
        vm.prank(arbiterAddr);
        ArbiterRegistryFacet(address(diamond)).claimDispute(
            agreementAddr, DISPUTE_SALT, bytes32(uint256(0xB0)), bytes32(uint256(0x51))
        );
    }

    // Full deploy -> fund -> activate -> dispute -> claim -> submit -> overturn cycle against a
    // single fresh counterparty pair, for arbiter-mistake-streak tests. Kept as its own
    // function (called explicitly per-mistake rather than from a `for` loop) — looping this
    // sequence directly inside one test function was observed to make later vm.roll calls not
    // take effect under this repo's via_ir compilation; calling a helper repeatedly does not
    // have that problem.
    function _disputeAndOverturn(address cli, address exec, address arbiterAddr) internal returns (address agreementAddr) {
        usdc.mint(cli, 1_000_000 * 10**6);
        vm.prank(cli);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(cli);
        agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            cli, exec, arbiterAddr, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(cli);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(cli);
        Agreement(agreementAddr).fund();
        vm.prank(exec);
        Agreement(agreementAddr).activate();
        vm.prank(cli);
        Agreement(agreementAddr).raiseDispute();

        _claimDisputeAs(agreementAddr, arbiterAddr);

        vm.prank(arbiterAddr);
        ArbiterRegistryFacet(address(diamond)).submitVerdict(agreementAddr, true);

        ArbiterRegistryFacet(address(diamond)).overturnVerdict(agreementAddr, false);
    }

    // Fresh deploy -> fund -> activate -> dispute -> claim -> submitVerdict cycle, stopping
    // right before finalization — the starting state every appeal test needs. `clientWins`
    // is the arbiter's ruling (true = client wins, executor loses and can appeal, and vice
    // versa).
    function _disputeToVerdict(address cli, address exc, bool clientWins) internal returns (address agreementAddr) {
        usdc.mint(cli, 1_000_000 * 10**6);
        vm.prank(cli);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(cli);
        agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            cli, exc, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(cli);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(cli);
        Agreement(agreementAddr).fund();
        vm.prank(exc);
        Agreement(agreementAddr).activate();
        vm.prank(cli);
        Agreement(agreementAddr).raiseDispute();

        _claimDispute(agreementAddr);

        vm.prank(arbiter);
        ArbiterRegistryFacet(address(diamond)).submitVerdict(agreementAddr, clientWins);
    }

    // Registers 3 extra arbiters (beyond the default `arbiter`) so appeal quorum
    // (APPEAL_MIN_VOTES = 3 others) is always reachable in appeal tests.
    function _addAppealQuorumArbiters() internal returns (address a2, address a3, address a4) {
        a2 = address(0x30);
        a3 = address(0x31);
        a4 = address(0x32);
        ArbiterRegistryFacet(address(diamond)).addArbiter(a2);
        ArbiterRegistryFacet(address(diamond)).addArbiter(a3);
        ArbiterRegistryFacet(address(diamond)).addArbiter(a4);
    }

    // Новый флоу: арбитр через Diamond (submitVerdict → finalizeVerdict)
    function _resolveDispute(address agreementAddr, bool clientWins) internal {
        vm.prank(arbiter);
        ArbiterRegistryFacet(address(diamond)).submitVerdict(agreementAddr, clientWins);
        vm.warp(block.timestamp + 24 hours + 1);
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(agreementAddr);
    }

    // Completes a full deal (fund -> activate -> markDone -> release) between the given
    // client/executor pair. Assumes cli already holds enough USDC (setUp mints 10000 USDC
    // to the shared `client` constant; fresh addresses need minting by the caller first).
    function _completeDeal(address cli, address exc) internal returns (address agreementAddr) {
        vm.prank(cli);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(cli);
        agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            cli, exc, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(cli);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(cli);
        Agreement(agreementAddr).fund();
        vm.prank(exc);
        Agreement(agreementAddr).activate();
        vm.prank(exc);
        Agreement(agreementAddr).markDone();
        vm.prank(cli);
        Agreement(agreementAddr).release();
    }

    // Grows `party`'s XP to >= targetXP via clean, fully-released deals, cycling to a fresh
    // counterparty every 3 deals so the per-pair win cap (MAX_WINS_PAIR) never stalls
    // progress. `asExecutor` selects which role `party` plays; the counterparty always takes
    // the other role and gets freshly minted USDC. `baseAddr` seeds the counterparty address
    // range so parallel calls in different tests never collide.
    //
    // NOTE: Under Mechanism 1 (Reputation gate), each counterparty's *first* deal doesn't
    // count toward `party`'s cleanStreak (counterparty starts at 0 XP, so the client-XP
    // check fails). Without a warm-up, 1 in every 3 deals silently stops counting, and
    // by the time XP crosses targetXP, the streak is well behind what callers expect.
    // A one-deal warm-up per counterparty (pushing its XP past MIN_COUNTERPARTY_XP)
    // restores the invariant: every counted deal moves the streak.
    function _growXP(address party, bool asExecutor, uint256 targetXP, uint256 baseAddr) internal {
        usdc.mint(party, 1_000_000 * 10**6);
        uint256 dealIndex = 0;
        address lastCounterparty = address(0);
        while (ReputationFacet(address(diamond)).getXP(party) < targetXP) {
            address counterparty = address(uint160(baseAddr + dealIndex / 3));
            if (counterparty != lastCounterparty) {
                usdc.mint(counterparty, 1_000_000 * 10**6);
                // Warm up: Mechanism 1 requires a deal's client to already have
                // >= MIN_COUNTERPARTY_XP (50) for it to count toward cleanStreak.
                // A single throwaway deal pushes counterparty past that threshold
                // before it's used for real below — otherwise 1 in every 3 deals
                // in this loop would silently not count toward party's streak.
                address throwaway = address(uint160(uint256(keccak256(abi.encodePacked("growxp-warmup", counterparty)))));
                usdc.mint(throwaway, 1_000_000 * 10**6);
                _completeDeal(counterparty, throwaway);
                lastCounterparty = counterparty;
            }
            if (asExecutor) {
                _completeDeal(counterparty, party);
            } else {
                _completeDeal(party, counterparty);
            }
            dealIndex++;
        }
    }

    // Gives `cli` a single throwaway completed deal so its own XP crosses
    // MIN_COUNTERPARTY_XP (50) before it's used as the client in a deal whose
    // cleanStreak effect on the executor is under test. `cli` itself starts at
    // 0 XP in every fresh test, and Mechanism 1 requires prior standing, not
    // standing gained from the deal being measured. Caller must ensure `cli`
    // already holds USDC (setUp's shared `client` does; fresh addresses need
    // `usdc.mint(cli, ...)` first).
    function _warmUpClientXP(address cli) internal {
        address throwaway = address(uint160(uint256(keccak256(abi.encodePacked("warmup", cli)))));
        _completeDeal(cli, throwaway);
    }

    // ============ DIAMOND PROXY TESTS ============
    
    function testDiamondOwner() public view {
        assertEq(OwnershipFacet(address(diamond)).owner(), owner);
    }
    
    function testDiamondLoupe() public view {
        IDiamondLoupe.Facet[] memory facets = DiamondLoupeFacet(address(diamond)).facets();
        assertGe(facets.length, 5);
    }
    
    function testDiamondSupportsInterface() public view {
        assertTrue(DiamondLoupeFacet(address(diamond)).supportsInterface(type(IERC165).interfaceId));
        assertTrue(DiamondLoupeFacet(address(diamond)).supportsInterface(type(IDiamondCut).interfaceId));
        assertTrue(DiamondLoupeFacet(address(diamond)).supportsInterface(type(IDiamondLoupe).interfaceId));
        // Неизвестный интерфейс — false
        assertFalse(DiamondLoupeFacet(address(diamond)).supportsInterface(0xdeadbeef));
        // ERC-721 / ERC721Metadata здесь не проверяем — этот харнесс не монтирует
        // JobReceiptFacet, поэтому true был бы верным только для маппинга,
        // а не для реально работающего ERC-721. См. testJobReceiptFacetSupportsInterface
        // в test/Boards.t.sol, где фасет реально подключён.
    }
    
    // ============ REGISTRY FACET TESTS ============
    
    function testRegistryInit() public view {
        assertEq(RegistryFacet(address(diamond)).authorizedFactory(), address(diamond));
    }
    
    function testRegistryInitRevertIfAlreadyInitialized() public {
        vm.expectRevert(RegistryFacet.AlreadyInitialized.selector);
        RegistryFacet(address(diamond)).initRegistry(address(0x5));
    }
    
    function testRegistryTotalAgreements() public view {
        assertEq(RegistryFacet(address(diamond)).totalAgreements(), 0);
    }
    
    function testRegistryRegister() public {
        vm.prank(address(diamond));
        RegistryFacet(address(diamond)).register(address(0x100), client, executor, AMOUNT);
        
        assertTrue(RegistryFacet(address(diamond)).hasActivePair(client, executor));
        assertEq(RegistryFacet(address(diamond)).getActivePair(client, executor), address(0x100));
        assertEq(RegistryFacet(address(diamond)).totalAgreements(), 1);
    }
    
    function testRegistryRegisterRevertIfNotFactory() public {
        vm.prank(client);
        vm.expectRevert(RegistryFacet.OnlyAuthorizedFactory.selector);
        RegistryFacet(address(diamond)).register(address(0x100), client, executor, AMOUNT);
    }
    
    function testRegistryRegisterRevertIfActiveDealExists() public {
        vm.prank(address(diamond));
        RegistryFacet(address(diamond)).register(address(0x100), client, executor, AMOUNT);
        
        vm.prank(address(diamond));
        vm.expectRevert(RegistryFacet.ActiveDealAlreadyExists.selector);
        RegistryFacet(address(diamond)).register(address(0x101), client, executor, AMOUNT);
    }
    
    function testRegistryUpdateStatus() public {
        vm.prank(address(diamond));
        RegistryFacet(address(diamond)).register(address(0x100), client, executor, AMOUNT);
        
        vm.prank(address(0x100));
        RegistryFacet(address(diamond)).updateStatus(address(0x100), RegistryStorage.AgreementStatus.COMPLETED);
        
        RegistryStorage.AgreementRecord memory record = RegistryFacet(address(diamond)).getRecord(address(0x100));
        assertEq(uint256(record.status), uint256(RegistryStorage.AgreementStatus.COMPLETED));
        assertFalse(RegistryFacet(address(diamond)).hasActivePair(client, executor));
    }
    
    function testRegistryUpdateStatusRevertIfNotAgreement() public {
        vm.prank(address(diamond));
        RegistryFacet(address(diamond)).register(address(0x100), client, executor, AMOUNT);
        
        vm.prank(client);
        vm.expectRevert(RegistryFacet.OnlyAgreementItself.selector);
        RegistryFacet(address(diamond)).updateStatus(address(0x100), RegistryStorage.AgreementStatus.COMPLETED);
    }
    
    function testRegistryGetByClient() public {
        vm.prank(address(diamond));
        RegistryFacet(address(diamond)).register(address(0x100), client, executor, AMOUNT);
        
        RegistryStorage.AgreementRecord[] memory records = RegistryFacet(address(diamond)).getByClient(client);
        assertEq(records.length, 1);
        assertEq(records[0].agreement, address(0x100));
    }
    
    function testRegistryGetByExecutor() public {
        vm.prank(address(diamond));
        RegistryFacet(address(diamond)).register(address(0x100), client, executor, AMOUNT);
        
        RegistryStorage.AgreementRecord[] memory records = RegistryFacet(address(diamond)).getByExecutor(executor);
        assertEq(records.length, 1);
    }
    
    function testRegistryGetActive() public {
        vm.prank(address(diamond));
        RegistryFacet(address(diamond)).register(address(0x100), client, executor, AMOUNT);
        
        RegistryStorage.AgreementRecord[] memory active = RegistryFacet(address(diamond)).getActive();
        assertEq(active.length, 1);
    }
    
    // ============ FACTORY FACET TESTS ============
    
    function testFactoryInit() public view {
        assertEq(FactoryFacet(address(diamond)).getUsdc(), address(usdc));
        assertEq(FactoryFacet(address(diamond)).getFeeRecipient(), feeRecipient);
        assertFalse(false);
    }
    
    function testFactoryDeployAgreement() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        
        vm.prank(client);
        address agreement = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        
        assertTrue(agreement != address(0));
        assertTrue(RegistryFacet(address(diamond)).hasActivePair(client, executor));
    }
    
    // testFactoryDeployRevertIfPaused removed — pause mechanism was removed from FactoryFacet
    
    function testFactoryDeployRevertIfZeroAddress() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        vm.expectRevert(FactoryFacet.FactoryZeroAddress.selector);
        FactoryFacet(address(diamond)).deployAgreement(
            address(0), executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
    }
    
    function testFactoryDeployRevertIfClientEqualsExecutor() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        vm.expectRevert(FactoryFacet.ClientEqualsExecutor.selector);
        FactoryFacet(address(diamond)).deployAgreement(
            client, client, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
    }
    
    function testFactoryDeployRevertIfZeroAmount() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        vm.expectRevert(FactoryFacet.ZeroAmount.selector);
        FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, 0, DEADLINE, TERMS_HASH, 0
        );
    }
    
    function testFactoryDeployRevertIfZeroDeadline() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        vm.expectRevert(FactoryFacet.ZeroDeadline.selector);
        FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, 0, TERMS_HASH, 0
        );
    }
    
    function testFactoryDeployRevertIfInvalidRegion() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        vm.expectRevert(FactoryFacet.InvalidRegion.selector);
        FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 7
        );
    }
    
    function testFactoryDeployRevertIfActiveDealExists() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        vm.expectRevert(FactoryFacet.ActiveDealExists.selector);
        FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
    }
    
    function testFactoryAdminFunctions() public {
        FactoryFacet(address(diamond)).setFeeRecipient(address(0x5));
        assertEq(FactoryFacet(address(diamond)).getFeeRecipient(), address(0x5));

        FactoryFacet(address(diamond)).setTrustedForwarder(address(0x6));
        assertEq(FactoryFacet(address(diamond)).getTrustedForwarder(), address(0x6));
    }

    function testFactoryAdminRevertIfNotOwner() public {
        // Гейт onlyOwner проверяется через setFeeRecipient: setRegionFee, на
        // котором эта проверка стояла раньше, теперь безусловно ревертит
        // FeeNotRegional и про владельца больше ничего не доказывает.
        vm.prank(client);
        vm.expectRevert(FactoryFacet.NotOwner.selector);
        FactoryFacet(address(diamond)).setFeeRecipient(address(0x5));
    }
    
    // ============ AGREEMENT TESTS ============
    
    function testFullLifecycle() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        
        Agreement agreement = Agreement(agreementAddr);
        
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        agreement.fund();
        
        assertEq(uint256(agreement.status()), uint256(Agreement.Status.FUNDED));
        assertEq(usdc.balanceOf(agreementAddr), AMOUNT);
        
        vm.prank(executor);
        agreement.activate();
        
        assertEq(uint256(agreement.status()), uint256(Agreement.Status.ACTIVE));
        
        vm.prank(executor);
        agreement.markDone();
        
        uint256 executorBalanceBefore = usdc.balanceOf(executor);
        vm.prank(client);
        agreement.release();
        
        // Status is COMPLETED (3) but status() view returns based on timers
        // After release, NFT is burned and status should be COMPLETED
        assertEq(usdc.balanceOf(executor), executorBalanceBefore + AMOUNT);
        assertEq(usdc.balanceOf(executor), executorBalanceBefore + AMOUNT);
    }

    // ============ CLEAN STREAK / PHASE-2 XP GATING ============

    function testCleanStreakIncrementsOnCompleted() public {
        _warmUpClientXP(client);
        address freshExecutor = address(uint160(30001));
        _completeDeal(client, freshExecutor);
        assertEq(ReputationFacet(address(diamond)).getCleanStreak(freshExecutor), 1);
    }

    function testCleanStreakUnchangedOnExecutorWonDispute() public {
        _warmUpClientXP(client);
        address freshExecutor = address(uint160(30002));
        _completeDeal(client, freshExecutor);
        assertEq(ReputationFacet(address(diamond)).getCleanStreak(freshExecutor), 1);

        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, freshExecutor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();
        vm.prank(freshExecutor);
        Agreement(agreementAddr).activate();
        vm.prank(freshExecutor);
        Agreement(agreementAddr).raiseDispute();
        _claimDispute(agreementAddr);
        _resolveDispute(agreementAddr, false); // executor wins

        assertEq(ReputationFacet(address(diamond)).getCleanStreak(freshExecutor), 1);
    }

    function testCleanStreakResetsOnExecutorLostDispute() public {
        _warmUpClientXP(client);
        address freshExecutor = address(uint160(30003));
        _completeDeal(client, freshExecutor);
        assertEq(ReputationFacet(address(diamond)).getCleanStreak(freshExecutor), 1);

        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, freshExecutor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();
        vm.prank(freshExecutor);
        Agreement(agreementAddr).activate();
        vm.prank(client);
        Agreement(agreementAddr).raiseDispute();
        _claimDispute(agreementAddr);
        _resolveDispute(agreementAddr, true); // client wins — executor loses

        assertEq(ReputationFacet(address(diamond)).getCleanStreak(freshExecutor), 0);
    }

    function testNotifyExecutorFaultResetsStreak() public {
        _warmUpClientXP(client);
        address freshExecutor = address(uint160(34001));
        _completeDeal(client, freshExecutor);
        assertEq(ReputationFacet(address(diamond)).getCleanStreak(freshExecutor), 1);

        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, freshExecutor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );

        vm.prank(agreementAddr);
        ReputationFacet(address(diamond)).notifyExecutorFault(agreementAddr);

        assertEq(ReputationFacet(address(diamond)).getCleanStreak(freshExecutor), 0);
    }

    function testNotifyExecutorFaultRevertsIfNotAgreement() public {
        vm.expectRevert(ReputationFacet.NotAgreement.selector);
        ReputationFacet(address(diamond)).notifyExecutorFault(address(0xBAD));
    }

    function testClientXPFrozenAbove1000() public {
        address bigClient = address(uint160(31000));
        _growXP(bigClient, false, 1000, 31500);
        uint256 xpAtThreshold = ReputationFacet(address(diamond)).getXP(bigClient);
        assertGe(xpAtThreshold, 1000);

        address freshExecutor = address(uint160(31999));
        _completeDeal(bigClient, freshExecutor);

        assertEq(ReputationFacet(address(diamond)).getXP(bigClient), xpAtThreshold);
    }

    function testExecutorXPGatedByStreakAbove1000() public {
        address bigExecutor = address(uint160(32000));
        _growXP(bigExecutor, true, 1000, 32500);
        uint256 xpAtThreshold = ReputationFacet(address(diamond)).getXP(bigExecutor);
        assertGe(xpAtThreshold, 1000);
        // _growXP only ever uses fresh counterparties with clean releases, so by construction
        // the streak that carried this address past 1000 XP is already >= CLEAN_STREAK_REQUIRED (10).
        assertGe(ReputationFacet(address(diamond)).getCleanStreak(bigExecutor), 10);

        // Break the streak with a lost dispute.
        address disputeClient = address(uint160(32900));
        usdc.mint(disputeClient, 1_000_000 * 10**6);
        vm.prank(disputeClient);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(disputeClient);
        address disputedAgreement = FactoryFacet(address(diamond)).deployAgreement(
            disputeClient, bigExecutor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(disputeClient);
        usdc.approve(disputedAgreement, AMOUNT);
        vm.prank(disputeClient);
        Agreement(disputedAgreement).fund();
        vm.prank(bigExecutor);
        Agreement(disputedAgreement).activate();
        vm.prank(disputeClient);
        Agreement(disputedAgreement).raiseDispute();
        _claimDispute(disputedAgreement);
        _resolveDispute(disputedAgreement, true); // client wins — executor loses, streak resets to 0

        assertEq(ReputationFacet(address(diamond)).getCleanStreak(bigExecutor), 0);

        // One clean deal right after the reset: streak stays below 10 either way (this
        // counterparty is also fresh, so it doesn't even count toward the streak under
        // Mechanism 1) — no XP granted regardless.
        uint256 xpAfterLoss = ReputationFacet(address(diamond)).getXP(bigExecutor);
        address freshClient1 = address(uint160(32901));
        usdc.mint(freshClient1, 1_000_000 * 10**6);
        _completeDeal(freshClient1, bigExecutor);
        assertEq(ReputationFacet(address(diamond)).getXP(bigExecutor), xpAfterLoss);

        // Rebuild the streak to 10. Mechanism 1 requires each deal's client to already
        // have >= MIN_COUNTERPARTY_XP (50) — a single warmed-up counterparty, reused
        // across all 11 deals (warmup + 10 counted), satisfies this without hitting MAX_WINS_PAIR
        // (that cap only gates the win/volume XP bonus, not cleanStreak accounting). The warmup
        // deal gives the counterparty initial XP; the next 10 deals all count toward the streak.
        address streakClient = address(uint160(33000));
        usdc.mint(streakClient, 1_000_000 * 10**6);
        _warmUpClientXP(streakClient);
        for (uint256 i = 0; i < 10; i++) {
            _completeDeal(streakClient, bigExecutor);
        }
        assertEq(ReputationFacet(address(diamond)).getCleanStreak(bigExecutor), 10);

        // The deal that brought the streak to exactly 10 already counts under the new rule.
        uint256 xpAtStreak10 = ReputationFacet(address(diamond)).getXP(bigExecutor);
        assertGt(xpAtStreak10, xpAfterLoss);
    }

    function testCleanStreakDoesNotIncrementWhenClientBelowMinCounterpartyXP() public {
        address freshClient = address(uint160(35001));
        address freshExecutor = address(uint160(35002));
        usdc.mint(freshClient, 1_000_000 * 10**6);
        _completeDeal(freshClient, freshExecutor);
        assertEq(ReputationFacet(address(diamond)).getCleanStreak(freshExecutor), 0);
    }

    function testCleanStreakIncrementsOnceClientAboveMinCounterpartyXP() public {
        address warmClient = address(uint160(35003));
        address freshExecutor = address(uint160(35004));
        usdc.mint(warmClient, 1_000_000 * 10**6);
        _warmUpClientXP(warmClient);
        assertGe(ReputationFacet(address(diamond)).getXP(warmClient), 50);

        _completeDeal(warmClient, freshExecutor);
        assertEq(ReputationFacet(address(diamond)).getCleanStreak(freshExecutor), 1);
    }

    function testPhase2XPBlockedWhenDealCounterpartyBelowMinXP() public {
        address bigExecutor = address(uint160(35100));
        _growXP(bigExecutor, true, 1000, 35500);
        assertGe(ReputationFacet(address(diamond)).getXP(bigExecutor), 1000);
        assertGe(ReputationFacet(address(diamond)).getCleanStreak(bigExecutor), 10);

        uint256 xpBefore = ReputationFacet(address(diamond)).getXP(bigExecutor);
        address freshClient = address(uint160(35999));
        usdc.mint(freshClient, 1_000_000 * 10**6);
        _completeDeal(freshClient, bigExecutor);

        assertEq(ReputationFacet(address(diamond)).getXP(bigExecutor), xpBefore);
    }

    // ============ ARBITER DEMOTION ============

    function testApplyAsArbiterRevertsIfStreakTooLow() public {
        ArbiterRegistryFacet(address(diamond)).setDAOAddress(address(0xDA0));
        ArbiterRegistryFacet(address(diamond)).activateDAO();

        address candidate = address(uint160(40000));
        _growXP(candidate, true, 3000, 40500);
        // Break the streak right before applying, without dropping XP below 3000: one lost
        // dispute costs LOSS_XP_PENALTY (50), which candidate's balance easily absorbs.
        address disputeClient = address(uint160(40900));
        usdc.mint(disputeClient, 1_000_000 * 10**6);
        vm.prank(disputeClient);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(disputeClient);
        address disputedAgreement = FactoryFacet(address(diamond)).deployAgreement(
            disputeClient, candidate, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(disputeClient);
        usdc.approve(disputedAgreement, AMOUNT);
        vm.prank(disputeClient);
        Agreement(disputedAgreement).fund();
        vm.prank(candidate);
        Agreement(disputedAgreement).activate();
        vm.prank(disputeClient);
        Agreement(disputedAgreement).raiseDispute();
        _claimDispute(disputedAgreement);
        _resolveDispute(disputedAgreement, true); // candidate loses — streak resets to 0

        assertGe(ReputationFacet(address(diamond)).getXP(candidate), 3000);
        assertEq(ReputationFacet(address(diamond)).getCleanStreak(candidate), 0);

        vm.prank(candidate);
        vm.expectRevert(abi.encodeWithSelector(ArbiterRegistryFacet.InsufficientCleanStreak.selector, 0, 10));
        ArbiterRegistryFacet(address(diamond)).applyAsArbiter();
    }

    function testApplyAsArbiterSucceedsWithBothConditions() public {
        ArbiterRegistryFacet(address(diamond)).setDAOAddress(address(0xDA0));
        ArbiterRegistryFacet(address(diamond)).activateDAO();

        address candidate = address(uint160(41000));
        _growXP(candidate, true, 3000, 41500);
        assertGe(ReputationFacet(address(diamond)).getXP(candidate), 3000);
        assertGe(ReputationFacet(address(diamond)).getCleanStreak(candidate), 10);

        vm.prank(candidate);
        usdc.approve(address(diamond), ARBITER_BOND);
        vm.prank(candidate);
        ArbiterRegistryFacet(address(diamond)).applyAsArbiter();

        assertTrue(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(candidate));
        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterBond(candidate), ARBITER_BOND);
    }

    function testArbiterDemotedAfterThreeOverturns() public {
        address flakyArbiter = address(uint160(42000));
        ArbiterRegistryFacet(address(diamond)).addArbiter(flakyArbiter);

        _disputeAndOverturn(address(uint160(42100)), address(uint160(42200)), flakyArbiter);
        assertTrue(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(flakyArbiter));

        _disputeAndOverturn(address(uint160(42101)), address(uint160(42201)), flakyArbiter);
        assertTrue(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(flakyArbiter));

        _disputeAndOverturn(address(uint160(42102)), address(uint160(42202)), flakyArbiter);

        assertFalse(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(flakyArbiter));
        assertEq(ReputationFacet(address(diamond)).getXP(flakyArbiter), 2500);
        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterMistakeStreak(flakyArbiter), 0);
    }

    function testArbiterDemotionResetIsFlatNotSubtractive() public {
        // An arbiter with a large pre-existing XP balance must still land at exactly 2500,
        // not 2500-minus-something or their-balance-minus-a-fixed-amount.
        address veteranArbiter = address(uint160(43000));
        _growXP(veteranArbiter, true, 10_000, 43500);
        uint256 xpBeforeDemotion = ReputationFacet(address(diamond)).getXP(veteranArbiter);
        assertGe(xpBeforeDemotion, 10_000);
        ArbiterRegistryFacet(address(diamond)).addArbiter(veteranArbiter);

        _disputeAndOverturn(address(uint160(43100)), address(uint160(43200)), veteranArbiter);
        _disputeAndOverturn(address(uint160(43101)), address(uint160(43201)), veteranArbiter);
        _disputeAndOverturn(address(uint160(43102)), address(uint160(43202)), veteranArbiter);

        assertEq(ReputationFacet(address(diamond)).getXP(veteranArbiter), 2500);
    }

    function testApplyAsArbiterPullsBond() public {
        ArbiterRegistryFacet(address(diamond)).setDAOAddress(address(0xDA0));
        ArbiterRegistryFacet(address(diamond)).activateDAO();
        address candidate = address(uint160(45000));
        _growXP(candidate, true, 3000, 45500);

        uint256 balanceBefore = usdc.balanceOf(candidate);
        vm.prank(candidate);
        usdc.approve(address(diamond), ARBITER_BOND);
        vm.prank(candidate);
        ArbiterRegistryFacet(address(diamond)).applyAsArbiter();

        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterBond(candidate), ARBITER_BOND);
        assertEq(usdc.balanceOf(candidate), balanceBefore - ARBITER_BOND);
    }

    function testApplyAsArbiterRevertsWithoutBondApproval() public {
        ArbiterRegistryFacet(address(diamond)).setDAOAddress(address(0xDA0));
        ArbiterRegistryFacet(address(diamond)).activateDAO();
        address candidate = address(uint160(45100));
        _growXP(candidate, true, 3000, 45600);

        vm.prank(candidate);
        vm.expectRevert("Allowance exceeded");
        ArbiterRegistryFacet(address(diamond)).applyAsArbiter();
    }

    function testArbiterBondForfeitedOnDemotion() public {
        ArbiterRegistryFacet(address(diamond)).setDAOAddress(address(0xDA0));
        ArbiterRegistryFacet(address(diamond)).activateDAO();
        address candidate = address(uint160(45200));
        _growXP(candidate, true, 3000, 45700);
        vm.prank(candidate);
        usdc.approve(address(diamond), ARBITER_BOND);
        vm.prank(candidate);
        ArbiterRegistryFacet(address(diamond)).applyAsArbiter();

        uint256 vaultBefore = ArbiterRegistryFacet(address(diamond)).getVaultBalance();

        _disputeAndOverturn(address(uint160(45800)), address(uint160(45900)), candidate);
        _disputeAndOverturn(address(uint160(45801)), address(uint160(45901)), candidate);
        _disputeAndOverturn(address(uint160(45802)), address(uint160(45902)), candidate);

        assertFalse(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(candidate));
        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterBond(candidate), 0);
        assertEq(ArbiterRegistryFacet(address(diamond)).getVaultBalance(), vaultBefore + ARBITER_BOND);
    }

    function testResignAsArbiterRefundsBondAndClearsStatus() public {
        ArbiterRegistryFacet(address(diamond)).setDAOAddress(address(0xDA0));
        ArbiterRegistryFacet(address(diamond)).activateDAO();
        address candidate = address(uint160(45300));
        _growXP(candidate, true, 3000, 45400);
        vm.prank(candidate);
        usdc.approve(address(diamond), ARBITER_BOND);
        vm.prank(candidate);
        ArbiterRegistryFacet(address(diamond)).applyAsArbiter();

        uint256 balanceAfterApply = usdc.balanceOf(candidate);

        vm.prank(candidate);
        ArbiterRegistryFacet(address(diamond)).resignAsArbiter();

        assertFalse(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(candidate));
        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterBond(candidate), 0);
        assertEq(usdc.balanceOf(candidate), balanceAfterApply + ARBITER_BOND);
    }

    function testResignAsArbiterRevertsIfNotArbiter() public {
        vm.prank(address(uint160(45999)));
        vm.expectRevert(ArbiterRegistryFacet.NotAnArbiter.selector);
        ArbiterRegistryFacet(address(diamond)).resignAsArbiter();
    }

    // testRemoveArbiterRefundsBond / testRemoveArbiterNoOpsOnZeroBond удалены
    // (arbiter-accountability, задача 6, 15 августа 2026): removeArbiter
    // снята с фасета целиком. Возврат бонда по-прежнему покрыт
    // testResignAsArbiterRefundsBondAndClearsStatus выше — resignAsArbiter
    // переживает эту задачу и зовёт тот же хелпер очистки места. Форфейт
    // бонда при сносе по поводу (обратное поведение: не возврат, а изъятие
    // в банк арбитров) — новое поведение removeArbiterForCause. ⚠️ При
    // первом проходе задачи 6 здесь стояла та же фраза «покрыто», а покрытия
    // не было ни строчки (ревью, C-2, круг правок 1) — теперь действительно
    // покрыто именованным test_RemovalForCauseForfeitsTheBond в
    // test/ArbiterRemovalForCause.t.sol (проверяет getArbiterBond → 0,
    // getVaultBalance выросший ровно на форфейт, bondForfeited в событии).

    function testClaimDisputeIncrementsOpenClaimCount() public {
        address cli = address(uint160(46000));
        usdc.mint(cli, 1_000_000 * 10**6);
        vm.prank(cli);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(cli);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            cli, address(uint160(46001)), arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(cli);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(cli);
        Agreement(agreementAddr).fund();
        vm.prank(address(uint160(46001)));
        Agreement(agreementAddr).activate();
        vm.prank(cli);
        Agreement(agreementAddr).raiseDispute();

        _claimDispute(agreementAddr);

        assertEq(ArbiterRegistryFacet(address(diamond)).getOpenClaimCount(arbiter), 1);
    }

    function testReleaseDisputeClaimDecrementsOpenClaimCount() public {
        address cli = address(uint160(46100));
        usdc.mint(cli, 1_000_000 * 10**6);
        vm.prank(cli);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(cli);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            cli, address(uint160(46101)), arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(cli);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(cli);
        Agreement(agreementAddr).fund();
        vm.prank(address(uint160(46101)));
        Agreement(agreementAddr).activate();
        vm.prank(cli);
        Agreement(agreementAddr).raiseDispute();

        _claimDispute(agreementAddr);
        assertEq(ArbiterRegistryFacet(address(diamond)).getOpenClaimCount(arbiter), 1);

        vm.prank(arbiter);
        ArbiterRegistryFacet(address(diamond)).releaseDisputeClaim(agreementAddr);

        assertEq(ArbiterRegistryFacet(address(diamond)).getOpenClaimCount(arbiter), 0);
    }

    function testFinalizeVerdictDecrementsOpenClaimCount() public {
        address cli = address(uint160(46200));
        usdc.mint(cli, 1_000_000 * 10**6);
        vm.prank(cli);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(cli);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            cli, address(uint160(46201)), arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(cli);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(cli);
        Agreement(agreementAddr).fund();
        vm.prank(address(uint160(46201)));
        Agreement(agreementAddr).activate();
        vm.prank(cli);
        Agreement(agreementAddr).raiseDispute();

        _claimDispute(agreementAddr);
        assertEq(ArbiterRegistryFacet(address(diamond)).getOpenClaimCount(arbiter), 1);

        _resolveDispute(agreementAddr, true);

        assertEq(ArbiterRegistryFacet(address(diamond)).getOpenClaimCount(arbiter), 0);
    }

    function testArbiterTimeoutDecrementsOpenClaimCount() public {
        address flakyArbiter = address(uint160(46300));
        ArbiterRegistryFacet(address(diamond)).addArbiter(flakyArbiter);

        _disputeAndArbiterTimeout(address(uint160(46400)), address(uint160(46500)), flakyArbiter, 10_000_000);

        assertEq(ArbiterRegistryFacet(address(diamond)).getOpenClaimCount(flakyArbiter), 0);
    }

    function testResignAsArbiterRevertsWithOpenClaim() public {
        ArbiterRegistryFacet(address(diamond)).setDAOAddress(address(0xDA0));
        ArbiterRegistryFacet(address(diamond)).activateDAO();
        address candidate = address(uint160(46600));
        _growXP(candidate, true, 3000, 46700);
        vm.prank(candidate);
        usdc.approve(address(diamond), ARBITER_BOND);
        vm.prank(candidate);
        ArbiterRegistryFacet(address(diamond)).applyAsArbiter();

        address cli = address(uint160(46800));
        usdc.mint(cli, 1_000_000 * 10**6);
        vm.prank(cli);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(cli);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            cli, address(uint160(46801)), candidate, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(cli);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(cli);
        Agreement(agreementAddr).fund();
        vm.prank(address(uint160(46801)));
        Agreement(agreementAddr).activate();
        vm.prank(cli);
        Agreement(agreementAddr).raiseDispute();

        _claimDisputeAs(agreementAddr, candidate);

        vm.prank(candidate);
        vm.expectRevert(ArbiterRegistryFacet.HasOpenDisputeClaims.selector);
        ArbiterRegistryFacet(address(diamond)).resignAsArbiter();
    }

    function testResignAsArbiterSucceedsAfterClaimResolved() public {
        ArbiterRegistryFacet(address(diamond)).setDAOAddress(address(0xDA0));
        ArbiterRegistryFacet(address(diamond)).activateDAO();
        address candidate = address(uint160(46900));
        _growXP(candidate, true, 3000, 47000);
        vm.prank(candidate);
        usdc.approve(address(diamond), ARBITER_BOND);
        vm.prank(candidate);
        ArbiterRegistryFacet(address(diamond)).applyAsArbiter();

        address cli = address(uint160(47100));
        usdc.mint(cli, 1_000_000 * 10**6);
        vm.prank(cli);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(cli);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            cli, address(uint160(47101)), candidate, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(cli);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(cli);
        Agreement(agreementAddr).fund();
        vm.prank(address(uint160(47101)));
        Agreement(agreementAddr).activate();
        vm.prank(cli);
        Agreement(agreementAddr).raiseDispute();

        _claimDisputeAs(agreementAddr, candidate);
        vm.prank(candidate);
        ArbiterRegistryFacet(address(diamond)).submitVerdict(agreementAddr, true);
        vm.warp(block.timestamp + 24 hours + 1);
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(agreementAddr);

        assertEq(ArbiterRegistryFacet(address(diamond)).getOpenClaimCount(candidate), 0);

        vm.prank(candidate);
        ArbiterRegistryFacet(address(diamond)).resignAsArbiter();

        assertFalse(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(candidate));
    }

    function testFinalizedVerdictResetsMistakeStreak() public {
        address recoveringArbiter = address(uint160(44000));
        ArbiterRegistryFacet(address(diamond)).addArbiter(recoveringArbiter);

        // One overturn — mistake streak becomes 1.
        address cli1 = address(uint160(44100));
        usdc.mint(cli1, 1_000_000 * 10**6);
        vm.prank(cli1);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(cli1);
        address exec1 = address(uint160(44200));
        address agreement1 = FactoryFacet(address(diamond)).deployAgreement(
            cli1, exec1, recoveringArbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(cli1);
        usdc.approve(agreement1, AMOUNT);
        vm.prank(cli1);
        Agreement(agreement1).fund();
        vm.prank(exec1);
        Agreement(agreement1).activate();
        vm.prank(cli1);
        Agreement(agreement1).raiseDispute();
        _claimDisputeAs(agreement1, recoveringArbiter);
        vm.prank(recoveringArbiter);
        ArbiterRegistryFacet(address(diamond)).submitVerdict(agreement1, true);
        ArbiterRegistryFacet(address(diamond)).overturnVerdict(agreement1, false);
        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterMistakeStreak(recoveringArbiter), 1);

        // A correctly finalized verdict resets the streak back to 0.
        address cli2 = address(uint160(44300));
        usdc.mint(cli2, 1_000_000 * 10**6);
        vm.prank(cli2);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(cli2);
        address exec2 = address(uint160(44400));
        address agreement2 = FactoryFacet(address(diamond)).deployAgreement(
            cli2, exec2, recoveringArbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(cli2);
        usdc.approve(agreement2, AMOUNT);
        vm.prank(cli2);
        Agreement(agreement2).fund();
        vm.prank(exec2);
        Agreement(agreement2).activate();
        vm.prank(cli2);
        Agreement(agreement2).raiseDispute();
        _claimDisputeAs(agreement2, recoveringArbiter);
        vm.prank(recoveringArbiter);
        ArbiterRegistryFacet(address(diamond)).submitVerdict(agreement2, true);
        vm.warp(block.timestamp + 24 hours + 1);
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(agreement2);

        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterMistakeStreak(recoveringArbiter), 0);
        assertTrue(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(recoveringArbiter));
    }

    // ============ AGREEMENT TIMEOUT INTEGRATION ============

    function testActivationTimeoutResetsExecutorStreak() public {
        _warmUpClientXP(client);
        address freshExecutor = address(uint160(50001));
        _completeDeal(client, freshExecutor);
        assertEq(ReputationFacet(address(diamond)).getCleanStreak(freshExecutor), 1);

        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, freshExecutor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();

        vm.warp(block.timestamp + 6 days); // > ACTIVATION_WINDOW, executor never activated
        vm.prank(client);
        Agreement(agreementAddr).triggerActivationTimeout();

        assertEq(ReputationFacet(address(diamond)).getCleanStreak(freshExecutor), 0);
    }

    function testDeadlineTimeoutResetsExecutorStreak() public {
        _warmUpClientXP(client);
        address freshExecutor = address(uint160(50002));
        _completeDeal(client, freshExecutor);
        assertEq(ReputationFacet(address(diamond)).getCleanStreak(freshExecutor), 1);

        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, freshExecutor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();
        vm.prank(freshExecutor);
        Agreement(agreementAddr).activate();

        vm.warp(block.timestamp + (DEADLINE * 1 days) + 2 days); // past deadline + grace, never marked done
        vm.prank(client);
        Agreement(agreementAddr).triggerDeadlineTimeout();

        assertEq(ReputationFacet(address(diamond)).getCleanStreak(freshExecutor), 0);
    }

    function testArbiterTimeoutDoesNotTouchExecutorStreakButCountsAgainstArbiter() public {
        _warmUpClientXP(client);
        address freshExecutor = address(uint160(50003));
        _completeDeal(client, freshExecutor);
        assertEq(ReputationFacet(address(diamond)).getCleanStreak(freshExecutor), 1);

        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, freshExecutor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();
        vm.prank(freshExecutor);
        Agreement(agreementAddr).activate();
        vm.prank(client);
        Agreement(agreementAddr).raiseDispute();
        _claimDispute(agreementAddr);

        vm.warp(block.timestamp + 8 days); // > DISPUTE_WINDOW, arbiter never submitted a verdict
        vm.prank(client);
        Agreement(agreementAddr).triggerArbiterTimeout();

        // Executor's streak is untouched — the arbiter, not the executor, failed here.
        assertEq(ReputationFacet(address(diamond)).getCleanStreak(freshExecutor), 1);
        // The arbiter's mistake streak did register the failure.
        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 1);
    }

    // Full deploy -> fund -> activate -> dispute -> claim -> (arbiter never responds) ->
    // triggerArbiterTimeout cycle against a single fresh counterparty pair. Kept as its own
    // function for the same reason as _disputeAndOverturn (see its comment) — no `for` loop.
    function _disputeAndArbiterTimeout(address cli, address exec, address arbiterAddr, uint256 warpTo) internal {
        usdc.mint(cli, 1_000_000 * 10**6);
        vm.prank(cli);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(cli);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            cli, exec, arbiterAddr, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(cli);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(cli);
        Agreement(agreementAddr).fund();
        vm.prank(exec);
        Agreement(agreementAddr).activate();
        vm.prank(cli);
        Agreement(agreementAddr).raiseDispute();

        _claimDisputeAs(agreementAddr, arbiterAddr);

        // Absolute target, not block.timestamp + N: computing the warp target from a live
        // block.timestamp read was observed to silently no-op on the second+ call to this
        // helper within one test (same class of issue noted on _claimDisputeAs's vm.roll).
        // warpTo is always well past disputedAt + DISPUTE_WINDOW (4 days) as long as callers
        // space their warpTo values generously (see call sites).
        vm.warp(warpTo);
        vm.prank(cli);
        Agreement(agreementAddr).triggerArbiterTimeout();
    }

    function testThreeArbiterTimeoutsDemoteTheArbiter() public {
        address flakyArbiter = address(uint160(51000));
        ArbiterRegistryFacet(address(diamond)).addArbiter(flakyArbiter);

        _disputeAndArbiterTimeout(address(uint160(51100)), address(uint160(51200)), flakyArbiter, 10_000_000);
        _disputeAndArbiterTimeout(address(uint160(51101)), address(uint160(51201)), flakyArbiter, 20_000_000);
        _disputeAndArbiterTimeout(address(uint160(51102)), address(uint160(51202)), flakyArbiter, 30_000_000);

        assertFalse(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(flakyArbiter));
        assertEq(ReputationFacet(address(diamond)).getXP(flakyArbiter), 2500);
    }

    function testAgreementRevertIfNotClientFund() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(executor);
        vm.expectRevert(Agreement.NotClient.selector);
        Agreement(agreementAddr).fund();
    }
    
    function testAgreementRevertIfAlreadyFunded() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();
        
        vm.prank(client);
        vm.expectRevert(Agreement.AlreadyFunded.selector);
        Agreement(agreementAddr).fund();
    }
    
    function testAgreementRevertIfNotExecutorActivate() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();
        
        vm.prank(client);
        vm.expectRevert(Agreement.NotExecutor.selector);
        Agreement(agreementAddr).activate();
    }
    
    function testAgreementRevertIfActivationWindowPassed() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();
        
        vm.warp(block.timestamp + 4 days);
        
        vm.prank(executor);
        vm.expectRevert(Agreement.ActivationWindowPassed.selector);
        Agreement(agreementAddr).activate();
    }
    
    function testAgreementRevertIfNotActiveMarkDone() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();
        
        vm.prank(executor);
        vm.expectRevert(Agreement.NotActive.selector);
        Agreement(agreementAddr).markDone();
    }
    
    function testAgreementRevertIfAlreadyMarkedDone() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();
        
        vm.prank(executor);
        Agreement(agreementAddr).activate();
        vm.prank(executor);
        Agreement(agreementAddr).markDone();
        
        vm.prank(executor);
        vm.expectRevert(Agreement.AlreadyMarkedDone.selector);
        Agreement(agreementAddr).markDone();
    }
    
    function testAgreementRevertIfNotMarkedDoneRelease() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();
        
        vm.prank(executor);
        Agreement(agreementAddr).activate();
        
        vm.prank(client);
        vm.expectRevert(Agreement.NotMarkedDone.selector);
        Agreement(agreementAddr).release();
    }
    
    function testAgreementRevertIfDisputedRelease() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();
        
        vm.prank(executor);
        Agreement(agreementAddr).activate();
        
        // Raise dispute BEFORE markDone (can't dispute after markDone per contract)
        vm.prank(client);
        Agreement(agreementAddr).raiseDispute();
        
        // Now try to release - should revert because not marked done
        vm.prank(client);
        vm.expectRevert(Agreement.NotMarkedDone.selector);
        Agreement(agreementAddr).release();
    }
    
    function testAgreementAutoApprove() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();
        
        vm.prank(executor);
        Agreement(agreementAddr).activate();
        vm.prank(executor);
        Agreement(agreementAddr).markDone();
        
        vm.warp(block.timestamp + 6 days);
        
        uint256 executorBalanceBefore = usdc.balanceOf(executor);
        vm.prank(executor);
        Agreement(agreementAddr).triggerAutoApprove();
        
        assertEq(usdc.balanceOf(executor), executorBalanceBefore + AMOUNT);
    }
    
    function testAgreementDisputeAndResolve() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );

        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();

        vm.prank(executor);
        Agreement(agreementAddr).activate();

        vm.prank(client);
        Agreement(agreementAddr).raiseDispute();

        assertEq(uint256(Agreement(agreementAddr).status()), uint256(Agreement.Status.DISPUTED));

        _claimDispute(agreementAddr);

        uint256 clientBalanceBefore = usdc.balanceOf(client);
        _resolveDispute(agreementAddr, true);

        assertEq(uint256(Agreement(agreementAddr).status()), uint256(Agreement.Status.RESOLVED));
        assertEq(usdc.balanceOf(client), clientBalanceBefore + AMOUNT);
    }
    
    function testAgreementDisputeResolveExecutorWins() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );

        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();

        vm.prank(executor);
        Agreement(agreementAddr).activate();

        vm.prank(executor);
        Agreement(agreementAddr).raiseDispute();

        _claimDispute(agreementAddr);

        uint256 executorBalanceBefore = usdc.balanceOf(executor);
        _resolveDispute(agreementAddr, false);

        assertEq(usdc.balanceOf(executor), executorBalanceBefore + AMOUNT);
    }

    // Winner of a resolved dispute earns XP; loser earns none (baseline, no prior XP).
    function testAutoAwardXPWinnerOnlyOnResolved() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );

        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();

        vm.prank(executor);
        Agreement(agreementAddr).activate();

        vm.prank(client);
        Agreement(agreementAddr).raiseDispute();

        _claimDispute(agreementAddr);
        _resolveDispute(agreementAddr, true); // client wins — executor loses

        assertTrue(ReputationFacet(address(diamond)).getXP(client) > 0);
        assertEq(ReputationFacet(address(diamond)).getXP(executor), 0);
    }

    // A dispute loss must actually subtract XP the loser already earned from a prior
    // completed deal — not just withhold new XP. Regression guard for the exploit where
    // losing a dispute cost nothing, letting a bad-faith executor farm reputation for free.
    function testAutoAwardXPPenalizesDisputeLoser() public {
        // Deal 1: honest completion — both sides earn XP (100 win + 10 volume = 110).
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address deal1 = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client);
        usdc.approve(deal1, AMOUNT);
        vm.prank(client);
        Agreement(deal1).fund();
        vm.prank(executor);
        Agreement(deal1).activate();
        vm.prank(executor);
        Agreement(deal1).markDone();
        vm.prank(client);
        Agreement(deal1).release();

        uint256 executorXPAfterDeal1 = ReputationFacet(address(diamond)).getXP(executor);
        assertEq(executorXPAfterDeal1, 110);

        // Deal 2: same pair, disputed — client wins, executor loses.
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address deal2 = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client);
        usdc.approve(deal2, AMOUNT);
        vm.prank(client);
        Agreement(deal2).fund();
        vm.prank(executor);
        Agreement(deal2).activate();
        vm.prank(client);
        Agreement(deal2).raiseDispute();
        _claimDispute(deal2);
        _resolveDispute(deal2, true); // client wins — executor loses

        // Executor loses 50 XP (half of WIN_XP) off their deal-1 balance.
        assertEq(ReputationFacet(address(diamond)).getXP(executor), executorXPAfterDeal1 - 50);
    }

    function testAgreementRevertIfNotArbiterResolve() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );

        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();

        vm.prank(executor);
        Agreement(agreementAddr).activate();

        vm.prank(client);
        Agreement(agreementAddr).raiseDispute();

        _claimDispute(agreementAddr);

        vm.prank(client);
        vm.expectRevert(Agreement.NotArbiter.selector);
        Agreement(agreementAddr).resolveDispute(true);
    }
    
    function testAgreementRevertIfNoArbiterSet() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, address(0), AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();
        
        vm.prank(executor);
        Agreement(agreementAddr).activate();
        
        vm.prank(client);
        Agreement(agreementAddr).raiseDispute();
        
        vm.prank(arbiter);
        vm.expectRevert(Agreement.NoArbiterSet.selector);
        Agreement(agreementAddr).resolveDispute(true);
    }
    
    function testAgreementActivationTimeout() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();
        
        vm.warp(block.timestamp + 4 days);
        
        uint256 clientBalanceBefore = usdc.balanceOf(client);
        vm.prank(client);
        Agreement(agreementAddr).triggerActivationTimeout();
        
        // After triggerActivationTimeout, NFT is burned so status() returns based on timers
        assertEq(usdc.balanceOf(client), clientBalanceBefore + AMOUNT);
    }
    
    function testAgreementDeadlineTimeout() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, 1, TERMS_HASH, 0
        );
        
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();
        
        vm.prank(executor);
        Agreement(agreementAddr).activate();
        
        vm.warp(block.timestamp + 2 days + 1); // DEADLINE(1d) + DEADLINE_GRACE(1d) + 1sec

        uint256 clientBalanceBefore = usdc.balanceOf(client);
        vm.prank(client);
        Agreement(agreementAddr).triggerDeadlineTimeout();
        
        assertEq(uint256(Agreement(agreementAddr).status()), uint256(Agreement.Status.REFUNDED));
        assertEq(usdc.balanceOf(client), clientBalanceBefore + AMOUNT);
    }
    
    function testAgreementArbiterTimeout() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();
        
        vm.prank(executor);
        Agreement(agreementAddr).activate();
        
        vm.prank(client);
        Agreement(agreementAddr).raiseDispute();
        // Отклик второй стороны: пополам теперь означает «оба явились».
        vm.prank(executor);
        Agreement(agreementAddr).respondToDispute();

        vm.warp(block.timestamp + 8 days);

        uint256 clientBalanceBefore   = usdc.balanceOf(client);
        uint256 executorBalanceBefore = usdc.balanceOf(executor);
        vm.prank(client);
        Agreement(agreementAddr).triggerArbiterTimeout();

        // За этот спор никто не брался (claimDispute здесь не зовётся, поле
        // arbiter агримента осталось нулём), поэтому котёл делится пополам, а
        // не возвращается клиенту целиком: полный возврат сделал бы пустой спор
        // бесплатным способом забрать и деньги, и работу. Ветку «арбитр взялся
        // и не довёл» — там клиенту по-прежнему всё — держит
        // test/DisputeSettlement.t.sol:testTimeoutAfterClaimStillRefundsTheClient.
        assertEq(usdc.balanceOf(client),   clientBalanceBefore   + AMOUNT / 2, "half back to the client");
        assertEq(usdc.balanceOf(executor), executorBalanceBefore + AMOUNT / 2, "half to the executor");
        assertEq(usdc.balanceOf(agreementAddr), 0, "the agreement must be emptied");
    }
    
    function testAgreementSoulbound() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();
        
        vm.prank(client);
        vm.expectRevert(bytes4(keccak256("TokenSoulbound()")));
        Agreement(agreementAddr).transferFrom(client, address(0x5), 1);
    }
    
    // ============ FUZZ TESTS ============
    
    function testFuzzDeployAgreement(uint64 amount, uint64 deadline) public {
        amount = uint64(bound(amount, 1 * 10**6, 100000 * 10**6));
        deadline = uint64(bound(deadline, 1, 365));

        // Fee is a percentage of the fuzzed amount now, not a flat regional
        // cap — a fixed 10 USDC approval no longer covers every fuzzed value.
        uint256 fee = (uint256(amount) * 500) / 10_000;
        if (fee < 1_000_000) fee = 1_000_000;

        vm.prank(client);
        usdc.approve(address(diamond), fee);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, amount, deadline, TERMS_HASH, 0
        );
        
        assertTrue(agreementAddr != address(0));
        assertEq(Agreement(agreementAddr).amount(), amount);
        assertEq(Agreement(agreementAddr).deadlineDays(), deadline);
    }
    
    function testFuzzAgreementStatus(uint64 timeJump) public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        
        vm.prank(client);
        usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client);
        Agreement(agreementAddr).fund();
        
        vm.prank(executor);
        Agreement(agreementAddr).activate();
        
        timeJump = uint64(bound(timeJump, 0, 30 days));
        vm.warp(block.timestamp + timeJump);
        
        uint256 s = uint256(Agreement(agreementAddr).status());
        assertLe(s, 6);
    }

    // ============ ARBITER REGISTRY TESTS ============

    function testArbiterRegistryAddArbiter() public {
        address newArbiter = address(0x10);
        ArbiterRegistryFacet(address(diamond)).addArbiter(newArbiter);
        assertTrue(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(newArbiter));
        address[] memory list = ArbiterRegistryFacet(address(diamond)).getArbiters();
        assertEq(list.length, 2); // arbiter from setUp + new
    }

    function testArbiterRegistryAddRevertIfAlreadyArbiter() public {
        vm.expectRevert(ArbiterRegistryFacet.AlreadyArbiter.selector);
        ArbiterRegistryFacet(address(diamond)).addArbiter(arbiter);
    }

    function testArbiterRegistryAddRevertIfNotOwner() public {
        vm.prank(client);
        vm.expectRevert(ArbiterRegistryFacet.NotOwnerOrChief.selector);
        ArbiterRegistryFacet(address(diamond)).addArbiter(address(0x10));
    }

    // testArbiterRegistryRemoveArbiter / testArbiterRegistryRemoveRevertIfNotArbiter
    // удалены (arbiter-accountability, задача 6, 15 августа 2026): removeArbiter
    // снята с фасета целиком, замена — ArbiterAccountabilityFacet.removeArbiterForCause
    // (test/ArbiterRemovalForCause.t.sol).

    function testArbiterRegistryChiefCanAdd() public {
        address chief = address(0x20);
        ArbiterRegistryFacet(address(diamond)).setChiefArbiter(chief);
        assertEq(ArbiterRegistryFacet(address(diamond)).getChiefArbiter(), chief);

        vm.prank(chief);
        ArbiterRegistryFacet(address(diamond)).addArbiter(address(0x21));
        assertTrue(ArbiterRegistryFacet(address(diamond)).isRegisteredArbiter(address(0x21)));
    }

    function testArbiterCommitRevertIfNotRegistered() public {
        bytes32 commitment = keccak256(abi.encodePacked(address(0x100), client, DISPUTE_SALT));
        vm.prank(client); // not a registered arbiter
        vm.expectRevert(ArbiterRegistryFacet.NotArbiter.selector);
        ArbiterRegistryFacet(address(diamond)).commitDisputeClaim(commitment);
    }

    function testArbiterClaimRevertIfCommitTooEarly() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client); usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client); Agreement(agreementAddr).fund();
        vm.prank(executor); Agreement(agreementAddr).activate();
        vm.prank(client); Agreement(agreementAddr).raiseDispute();

        bytes32 commitment = keccak256(abi.encodePacked(agreementAddr, arbiter, DISPUTE_SALT));
        vm.prank(arbiter);
        ArbiterRegistryFacet(address(diamond)).commitDisputeClaim(commitment);

        // Reveal in the same block — should fail
        vm.prank(arbiter);
        vm.expectRevert(ArbiterRegistryFacet.CommitmentTooEarly.selector);
        ArbiterRegistryFacet(address(diamond)).claimDispute(
            agreementAddr, DISPUTE_SALT, bytes32(uint256(0xB0)), bytes32(uint256(0x51))
        );
    }

    function testArbiterClaimRevertIfCommitmentExpired() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client); usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client); Agreement(agreementAddr).fund();
        vm.prank(executor); Agreement(agreementAddr).activate();
        vm.prank(client); Agreement(agreementAddr).raiseDispute();

        bytes32 commitment = keccak256(abi.encodePacked(agreementAddr, arbiter, DISPUTE_SALT));
        vm.prank(arbiter);
        ArbiterRegistryFacet(address(diamond)).commitDisputeClaim(commitment);

        vm.roll(block.number + 51); // past COMMIT_MAX_BLOCKS (50)

        vm.prank(arbiter);
        vm.expectRevert(ArbiterRegistryFacet.CommitmentExpired.selector);
        ArbiterRegistryFacet(address(diamond)).claimDispute(
            agreementAddr, DISPUTE_SALT, bytes32(uint256(0xB0)), bytes32(uint256(0x51))
        );
    }

    function testArbiterClaimRevertIfNotDisputed() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client); usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client); Agreement(agreementAddr).fund();
        vm.prank(executor); Agreement(agreementAddr).activate();
        // No raiseDispute — agreement is ACTIVE, not DISPUTED

        bytes32 commitment = keccak256(abi.encodePacked(agreementAddr, arbiter, DISPUTE_SALT));
        vm.prank(arbiter);
        ArbiterRegistryFacet(address(diamond)).commitDisputeClaim(commitment);
        vm.roll(block.number + 1);

        vm.prank(arbiter);
        vm.expectRevert(ArbiterRegistryFacet.NotDisputed.selector);
        ArbiterRegistryFacet(address(diamond)).claimDispute(
            agreementAddr, DISPUTE_SALT, bytes32(uint256(0xB0)), bytes32(uint256(0x51))
        );
    }

    function testArbiterClaimRevertIfAlreadyClaimed() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client); usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client); Agreement(agreementAddr).fund();
        vm.prank(executor); Agreement(agreementAddr).activate();
        vm.prank(client); Agreement(agreementAddr).raiseDispute();

        _claimDispute(agreementAddr);

        // Second arbiter tries to claim the same dispute
        address arbiter2 = address(0x30);
        ArbiterRegistryFacet(address(diamond)).addArbiter(arbiter2);
        bytes32 commitment2 = keccak256(abi.encodePacked(agreementAddr, arbiter2, DISPUTE_SALT));
        vm.prank(arbiter2);
        ArbiterRegistryFacet(address(diamond)).commitDisputeClaim(commitment2);
        vm.roll(block.number + 1);

        vm.prank(arbiter2);
        vm.expectRevert(ArbiterRegistryFacet.AlreadyClaimed.selector);
        ArbiterRegistryFacet(address(diamond)).claimDispute(
            agreementAddr, DISPUTE_SALT, bytes32(uint256(0xB0)), bytes32(uint256(0x51))
        );
    }

    function testArbiterReleaseDisputeClaim() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client); usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client); Agreement(agreementAddr).fund();
        vm.prank(executor); Agreement(agreementAddr).activate();
        vm.prank(client); Agreement(agreementAddr).raiseDispute();

        _claimDispute(agreementAddr);

        assertEq(ArbiterRegistryFacet(address(diamond)).getDisputeClaimer(agreementAddr), arbiter);
        // После claimDispute Diamond (не individual arbiter) становится арбитром Agreement
        assertEq(Agreement(agreementAddr).arbiter(), address(diamond));

        vm.prank(arbiter);
        ArbiterRegistryFacet(address(diamond)).releaseDisputeClaim(agreementAddr);

        assertEq(ArbiterRegistryFacet(address(diamond)).getDisputeClaimer(agreementAddr), address(0));
        assertEq(Agreement(agreementAddr).arbiter(), address(0));
    }

    function testArbiterOwnerCanReleaseClaim() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client); usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client); Agreement(agreementAddr).fund();
        vm.prank(executor); Agreement(agreementAddr).activate();
        vm.prank(client); Agreement(agreementAddr).raiseDispute();

        _claimDispute(agreementAddr);

        // Owner (address(this)) releases — not the arbiter
        ArbiterRegistryFacet(address(diamond)).releaseDisputeClaim(agreementAddr);
        assertEq(ArbiterRegistryFacet(address(diamond)).getDisputeClaimer(agreementAddr), address(0));
    }

    function testArbiterDealsHistoryTracked() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client); usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client); Agreement(agreementAddr).fund();
        vm.prank(executor); Agreement(agreementAddr).activate();
        vm.prank(client); Agreement(agreementAddr).raiseDispute();

        _claimDispute(agreementAddr);

        address[] memory deals = ArbiterRegistryFacet(address(diamond)).getArbiterDeals(arbiter);
        assertEq(deals.length, 1);
        assertEq(deals[0], agreementAddr);
    }

    // ============ AGREEMENT EDGE CASES ============

    function testAgreementRaiseDisputeByExecutor() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client); usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client); Agreement(agreementAddr).fund();
        vm.prank(executor); Agreement(agreementAddr).activate();

        // Исполнитель тоже может поднять спор
        vm.prank(executor);
        Agreement(agreementAddr).raiseDispute();

        assertEq(uint256(Agreement(agreementAddr).status()), uint256(Agreement.Status.DISPUTED));
    }

    function testAgreementRevertIfAlreadyDisputed() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client); usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client); Agreement(agreementAddr).fund();
        vm.prank(executor); Agreement(agreementAddr).activate();
        vm.prank(client); Agreement(agreementAddr).raiseDispute();

        vm.prank(executor);
        vm.expectRevert(Agreement.AlreadyDisputed.selector);
        Agreement(agreementAddr).raiseDispute();
    }

    function testAgreementRaiseDisputeAfterMarkDone() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client); usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client); Agreement(agreementAddr).fund();
        vm.prank(executor); Agreement(agreementAddr).activate();
        vm.prank(executor); Agreement(agreementAddr).markDone();

        // Клиент может поднять спор после markDone, если AUTO_APPROVE_WINDOW не прошёл
        vm.prank(client);
        Agreement(agreementAddr).raiseDispute();

        assertEq(uint256(Agreement(agreementAddr).status()), uint256(Agreement.Status.DISPUTED));
    }

    function testAgreementRaiseDisputeRevertAfterDeadline() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, 1, TERMS_HASH, 0
        );
        vm.prank(client); usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client); Agreement(agreementAddr).fund();
        vm.prank(executor); Agreement(agreementAddr).activate();

        vm.warp(block.timestamp + 2 days + 1); // DEADLINE(1d) + DEADLINE_GRACE(1d) + 1sec

        vm.prank(client);
        vm.expectRevert(Agreement.DeadlinePassed.selector);
        Agreement(agreementAddr).raiseDispute();
    }

    function testAgreementReleaseRevertIfWindowPassed() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client); usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client); Agreement(agreementAddr).fund();
        vm.prank(executor); Agreement(agreementAddr).activate();
        vm.prank(executor); Agreement(agreementAddr).markDone();

        vm.warp(block.timestamp + 6 days); // AUTO_APPROVE_WINDOW = 5 days

        vm.prank(client);
        vm.expectRevert(Agreement.WindowAlreadyPassed.selector);
        Agreement(agreementAddr).release();
    }

    function testAgreementAutoApproveRevertIfWindowNotPassed() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client); usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client); Agreement(agreementAddr).fund();
        vm.prank(executor); Agreement(agreementAddr).activate();
        vm.prank(executor); Agreement(agreementAddr).markDone();

        // Слишком рано — окно ещё не прошло
        vm.prank(address(0x99));
        vm.expectRevert(Agreement.WindowNotPassed.selector);
        Agreement(agreementAddr).triggerAutoApprove();
    }

    function testAgreementAutoApproveByAnyone() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client); usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client); Agreement(agreementAddr).fund();
        vm.prank(executor); Agreement(agreementAddr).activate();
        vm.prank(executor); Agreement(agreementAddr).markDone();

        vm.warp(block.timestamp + 6 days);

        uint256 executorBefore = usdc.balanceOf(executor);
        address stranger = address(0xBEEF);
        vm.prank(stranger); // не client и не executor
        Agreement(agreementAddr).triggerAutoApprove();

        assertEq(usdc.balanceOf(executor), executorBefore + AMOUNT);
    }

    function testAgreementActivationTimeoutTooEarly() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client); usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client); Agreement(agreementAddr).fund();

        // ACTIVATION_WINDOW = 3 days, 2 дня прошло — рано
        vm.warp(block.timestamp + 2 days);

        vm.prank(client);
        vm.expectRevert(Agreement.WindowNotPassed.selector);
        Agreement(agreementAddr).triggerActivationTimeout();
    }

    function testAgreementDeadlineTimeoutTooEarly() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, 7, TERMS_HASH, 0
        );
        vm.prank(client); usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client); Agreement(agreementAddr).fund();
        vm.prank(executor); Agreement(agreementAddr).activate();

        // Дедлайн = 7 дней, 5 дней прошло — рано
        vm.warp(block.timestamp + 5 days);

        vm.prank(client);
        vm.expectRevert(Agreement.DeadlineNotPassed.selector);
        Agreement(agreementAddr).triggerDeadlineTimeout();
    }

    function testAgreementArbiterTimeoutTooEarly() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client); usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client); Agreement(agreementAddr).fund();
        vm.prank(executor); Agreement(agreementAddr).activate();
        vm.prank(client); Agreement(agreementAddr).raiseDispute();

        // DISPUTE_WINDOW = 4 days, 3 дня прошло — рано
        vm.warp(block.timestamp + 3 days);

        vm.prank(client);
        vm.expectRevert(Agreement.WindowNotPassed.selector);
        Agreement(agreementAddr).triggerArbiterTimeout();
    }

    function testSubmitVerdict_RevertsAfterDisputeWindow() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client);
        usdc.approve(agr, AMOUNT);
        vm.prank(client);
        Agreement(agr).fund();
        vm.prank(executor);
        Agreement(agr).activate();
        vm.prank(client);
        Agreement(agr).raiseDispute();

        _claimDispute(agr);

        // DISPUTE_WINDOW is 4 days — warp past it before the arbiter ever submits.
        vm.warp(block.timestamp + 4 days + 1);

        vm.prank(arbiter);
        vm.expectRevert(ArbiterRegistryFacet.DisputeWindowPassed.selector);
        ArbiterRegistryFacet(address(diamond)).submitVerdict(agr, true);
    }

    function testTriggerArbiterTimeout_RevertsIfVerdictAlreadySubmitted() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client);
        usdc.approve(agr, AMOUNT);
        vm.prank(client);
        Agreement(agr).fund();
        vm.prank(executor);
        Agreement(agr).activate();
        vm.prank(client);
        Agreement(agr).raiseDispute();

        _claimDispute(agr);

        // Arbiter submits promptly (well within DISPUTE_WINDOW).
        vm.prank(arbiter);
        ArbiterRegistryFacet(address(diamond)).submitVerdict(agr, true);

        // Time still passes disputedAt + DISPUTE_WINDOW while FINALIZE_DELAY/appeal run.
        vm.warp(block.timestamp + 4 days + 1);

        vm.prank(client);
        vm.expectRevert(Agreement.VerdictInFlight.selector);
        Agreement(agr).triggerArbiterTimeout();

        // And finalization still succeeds — the removed execution-time check isn't missed.
        vm.warp(block.timestamp + 24 hours + 1);
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(agr);
        assertEq(uint8(Agreement(agr).status()), uint8(Agreement.Status.RESOLVED));
    }

    function testAgreementMarkDoneRevertAfterDeadline() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, 1, TERMS_HASH, 0 // deadline = 1 day
        );
        vm.prank(client); usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client); Agreement(agreementAddr).fund();
        vm.prank(executor); Agreement(agreementAddr).activate();

        vm.warp(block.timestamp + 2 days + 1); // DEADLINE(1d) + DEADLINE_GRACE(1d) + 1sec

        vm.prank(executor);
        vm.expectRevert(Agreement.DeadlinePassed.selector);
        Agreement(agreementAddr).markDone();
    }

    function testAgreementRevertIfAlreadyResolved() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client); usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client); Agreement(agreementAddr).fund();
        vm.prank(executor); Agreement(agreementAddr).activate();
        vm.prank(client); Agreement(agreementAddr).raiseDispute();
        _claimDispute(agreementAddr);
        _resolveDispute(agreementAddr, true);

        // Повторный вызов finalizeVerdict должен ревертить AlreadyFinalized
        vm.expectRevert(ArbiterRegistryFacet.AlreadyFinalized.selector);
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(agreementAddr);
    }

    function testRegistrySetAuthorizedFactory() public {
        address newFactory = address(0x50);
        // owner = address(this) в тестах
        RegistryFacet(address(diamond)).setAuthorizedFactory(newFactory);
        assertEq(RegistryFacet(address(diamond)).authorizedFactory(), newFactory);
    }

    function testRegistrySetAuthorizedFactoryRevertIfNotOwner() public {
        vm.prank(client);
        vm.expectRevert(RegistryFacet.NotOwner.selector);
        RegistryFacet(address(diamond)).setAuthorizedFactory(address(0x50));
    }

    function testArbiterClaimClearedAfterResolve() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
        vm.prank(client); usdc.approve(agreementAddr, AMOUNT);
        vm.prank(client); Agreement(agreementAddr).fund();
        vm.prank(executor); Agreement(agreementAddr).activate();
        vm.prank(client); Agreement(agreementAddr).raiseDispute();

        _claimDispute(agreementAddr);

        _resolveDispute(agreementAddr, true);

        // After resolution, the claim should be cleared by Agreement's callback
        assertEq(ArbiterRegistryFacet(address(diamond)).getDisputeClaimer(agreementAddr), address(0));
    }

    function testRaiseAppeal_LosingExecutorCanAppeal() public {
        _addAppealQuorumArbiters();
        address agr = _disputeToVerdict(client, executor, true); // client wins, executor loses

        usdc.mint(executor, 100 * 10**6);
        vm.prank(executor);
        usdc.approve(address(diamond), 20 * 10**6);

        uint256 diamondBalBefore = usdc.balanceOf(address(diamond));
        vm.prank(executor);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);
        assertEq(usdc.balanceOf(address(diamond)), diamondBalBefore + 20 * 10**6);

        // Frozen — finalizeVerdict can't proceed until the appeal resolves.
        vm.warp(block.timestamp + 24 hours + 1);
        vm.expectRevert(ArbiterRegistryFacet.VerdictFrozenError.selector);
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(agr);
    }

    function testRaiseAppeal_RevertsForWinningParty() public {
        _addAppealQuorumArbiters();
        address agr = _disputeToVerdict(client, executor, true); // client wins

        usdc.mint(client, 100 * 10**6);
        vm.prank(client);
        usdc.approve(address(diamond), 20 * 10**6);

        vm.prank(client); // client already won — not the losing party
        vm.expectRevert(ArbiterRegistryFacet.NotLosingParty.selector);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);
    }

    function testRaiseAppeal_RevertsIfAlreadyAppealed() public {
        _addAppealQuorumArbiters();
        address agr = _disputeToVerdict(client, executor, true);

        usdc.mint(executor, 100 * 10**6);
        vm.prank(executor);
        usdc.approve(address(diamond), 40 * 10**6);
        vm.prank(executor);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);

        vm.prank(executor);
        vm.expectRevert(ArbiterRegistryFacet.AlreadyAppealed.selector);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);
    }

    function testRaiseAppeal_RevertsAfterWindowCloses() public {
        _addAppealQuorumArbiters();
        address agr = _disputeToVerdict(client, executor, true);

        usdc.mint(executor, 100 * 10**6);
        vm.prank(executor);
        usdc.approve(address(diamond), 20 * 10**6);

        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(executor);
        vm.expectRevert(ArbiterRegistryFacet.AppealWindowClosed.selector);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);
    }

    function testRaiseAppeal_RevertsWithTooFewArbiters() public {
        // No extra arbiters registered — only the default `arbiter` exists.
        address agr = _disputeToVerdict(client, executor, true);

        usdc.mint(executor, 100 * 10**6);
        vm.prank(executor);
        usdc.approve(address(diamond), 20 * 10**6);

        vm.prank(executor);
        vm.expectRevert(ArbiterRegistryFacet.InsufficientArbitersForAppeal.selector);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);
    }

    function testRaiseAppeal_RevertsIfOwnerFrozeBeforeAnyAppeal() public {
        _addAppealQuorumArbiters();
        address agr = _disputeToVerdict(client, executor, true); // client wins, executor loses

        // Owner/DAO freezes the verdict (e.g. pending investigation) before anyone appeals.
        ArbiterRegistryFacet(address(diamond)).freezeVerdict(agr);

        usdc.mint(executor, 100 * 10**6);
        vm.prank(executor);
        usdc.approve(address(diamond), 20 * 10**6);

        vm.prank(executor);
        vm.expectRevert(ArbiterRegistryFacet.VerdictFrozenError.selector);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);

        ArbiterRegistryStorage.PendingVerdict memory v = ArbiterRegistryFacet(address(diamond)).getPendingVerdict(agr);
        assertFalse(v.appealed);
    }

    function testVoteOnAppeal_ArbiterCanVoteOnce() public {
        (address a2,,) = _addAppealQuorumArbiters();
        address agr = _disputeToVerdict(client, executor, true);

        usdc.mint(executor, 100 * 10**6);
        vm.prank(executor);
        usdc.approve(address(diamond), 20 * 10**6);
        vm.prank(executor);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);

        ArbiterRegistryStorage.PendingVerdict memory before = ArbiterRegistryFacet(address(diamond)).getPendingVerdict(agr);
        assertEq(before.votesOverturn, 0);
        assertEq(before.votesUphold, 0);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit ArbiterRegistryFacet.AppealVoteCast(agr, a2, true);
        vm.prank(a2);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);

        // Successful vote incremented the right tally (overturn) and left the other untouched.
        ArbiterRegistryStorage.PendingVerdict memory afterVote = ArbiterRegistryFacet(address(diamond)).getPendingVerdict(agr);
        assertEq(afterVote.votesOverturn, 1);
        assertEq(afterVote.votesUphold, 0);

        vm.prank(a2);
        vm.expectRevert(ArbiterRegistryFacet.AlreadyVoted.selector);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);

        // Repeat-vote revert must not have double-counted.
        ArbiterRegistryStorage.PendingVerdict memory afterRevert = ArbiterRegistryFacet(address(diamond)).getPendingVerdict(agr);
        assertEq(afterRevert.votesOverturn, 1);
        assertEq(afterRevert.votesUphold, 0);
    }

    function testVoteOnAppeal_DifferentArbitersCanEachVoteOnce() public {
        (address a2, address a3,) = _addAppealQuorumArbiters();
        address agr = _disputeToVerdict(client, executor, true);

        usdc.mint(executor, 100 * 10**6);
        vm.prank(executor);
        usdc.approve(address(diamond), 20 * 10**6);
        vm.prank(executor);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit ArbiterRegistryFacet.AppealVoteCast(agr, a2, true);
        vm.prank(a2);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true); // a2 votes to overturn

        vm.expectEmit(true, true, false, true, address(diamond));
        emit ArbiterRegistryFacet.AppealVoteCast(agr, a3, false);
        vm.prank(a3);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, false); // a3 votes to uphold — different arbiter, no revert

        // Both votes recorded distinctly in the tally.
        ArbiterRegistryStorage.PendingVerdict memory v = ArbiterRegistryFacet(address(diamond)).getPendingVerdict(agr);
        assertEq(v.votesOverturn, 1);
        assertEq(v.votesUphold, 1);

        // a3 can't vote again either, but a2's earlier vote didn't block a3 in the first place.
        vm.prank(a3);
        vm.expectRevert(ArbiterRegistryFacet.AlreadyVoted.selector);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, false);
    }

    function testVoteOnAppeal_RulingArbiterCannotVoteOnOwnVerdict() public {
        _addAppealQuorumArbiters();
        address agr = _disputeToVerdict(client, executor, true);

        usdc.mint(executor, 100 * 10**6);
        vm.prank(executor);
        usdc.approve(address(diamond), 20 * 10**6);
        vm.prank(executor);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);

        vm.prank(arbiter); // the one who ruled
        vm.expectRevert(ArbiterRegistryFacet.CannotVoteOnOwnVerdict.selector);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);
    }

    function testVoteOnAppeal_RevertsWithoutAppeal() public {
        _addAppealQuorumArbiters();
        address agr = _disputeToVerdict(client, executor, true);

        vm.prank(address(0x30));
        vm.expectRevert(ArbiterRegistryFacet.NoAppeal.selector);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);
    }

    function testVoteOnAppeal_RevertsAfterWindowCloses() public {
        (address a2,,) = _addAppealQuorumArbiters();
        address agr = _disputeToVerdict(client, executor, true);

        usdc.mint(executor, 100 * 10**6);
        vm.prank(executor);
        usdc.approve(address(diamond), 20 * 10**6);
        vm.prank(executor);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);

        vm.warp(block.timestamp + 4 days + 1); // APPEAL_REVIEW_WINDOW

        vm.prank(a2);
        vm.expectRevert(ArbiterRegistryFacet.AppealWindowClosed.selector);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);
    }

    function testResolveAppeal_OverturnFlipsVerdictAndPenalizesArbiter() public {
        (address a2, address a3, address a4) = _addAppealQuorumArbiters();
        address agr = _disputeToVerdict(client, executor, true); // client wins, executor loses

        usdc.mint(executor, 100 * 10**6);
        vm.prank(executor);
        usdc.approve(address(diamond), 20 * 10**6);
        uint256 executorBalBefore = usdc.balanceOf(executor);
        vm.prank(executor);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);

        vm.prank(a2);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true); // overturn
        vm.prank(a3);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true); // overturn
        vm.prank(a4);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, false); // uphold

        ArbiterRegistryFacet(address(diamond)).resolveAppeal(agr);

        // Deposit refunded to the appellant (executor).
        assertEq(usdc.balanceOf(executor), executorBalBefore - 20 * 10**6 + 20 * 10**6);
        // Ruling arbiter penalized exactly like today's overturnVerdict.
        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 1);

        // Verdict flipped — finalizing now pays the executor, not the client.
        vm.warp(block.timestamp + 24 hours + 1);
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(agr);
        assertEq(usdc.balanceOf(executor), executorBalBefore - 20 * 10**6 + 20 * 10**6 + AMOUNT);
    }

    function testResolveAppeal_UpholdForfeitsDepositNoPenalty() public {
        (address a2, address a3, address a4) = _addAppealQuorumArbiters();
        address agr = _disputeToVerdict(client, executor, true);

        usdc.mint(executor, 100 * 10**6);
        vm.prank(executor);
        usdc.approve(address(diamond), 20 * 10**6);
        vm.prank(executor);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);

        uint256 vaultBefore = ArbiterRegistryFacet(address(diamond)).getVaultBalance();

        vm.prank(a2);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, false); // uphold
        vm.prank(a3);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, false); // uphold
        vm.prank(a4);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true); // overturn

        ArbiterRegistryFacet(address(diamond)).resolveAppeal(agr);

        assertEq(ArbiterRegistryFacet(address(diamond)).getVaultBalance(), vaultBefore + 20 * 10**6);
        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 0);

        // Original verdict stands — client (winner) gets paid at finalization.
        vm.warp(block.timestamp + 24 hours + 1);
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(agr);
        assertEq(uint8(Agreement(agr).status()), uint8(Agreement.Status.RESOLVED));
    }

    // Tie vote (2 overturn vs. 2 uphold) at/above quorum must resolve to UPHOLD, not overturn,
    // since resolveAppeal() uses strict `>` (votesOverturn > votesUphold) to decide overturn.
    // Requires a 4th eligible voter beyond the 3 from _addAppealQuorumArbiters(), since the
    // ruling arbiter can't vote on its own verdict and 3 eligible voters can never tie.
    function testResolveAppeal_TiedVoteUpholdsNotOverturn() public {
        (address a2, address a3, address a4) = _addAppealQuorumArbiters();
        address a5 = address(0x33);
        ArbiterRegistryFacet(address(diamond)).addArbiter(a5);

        address agr = _disputeToVerdict(client, executor, true); // client wins, executor loses

        usdc.mint(executor, 100 * 10**6);
        vm.prank(executor);
        usdc.approve(address(diamond), 20 * 10**6);
        vm.prank(executor);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);

        uint256 vaultBefore = ArbiterRegistryFacet(address(diamond)).getVaultBalance();

        vm.prank(a2);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true); // overturn
        vm.prank(a3);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true); // overturn
        vm.prank(a4);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, false); // uphold
        vm.prank(a5);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, false); // uphold

        // Confirm the tally really is a 2-vs-2 tie before resolving.
        (uint256 uphold, uint256 overturnVotes) = ArbiterRegistryFacet(address(diamond)).getAppealVotes(agr);
        assertEq(uphold, 2);
        assertEq(overturnVotes, 2);

        ArbiterRegistryFacet(address(diamond)).resolveAppeal(agr);

        // Tie at quorum -> uphold path taken: deposit forfeited to the vault, ruling arbiter
        // not penalized.
        assertEq(ArbiterRegistryFacet(address(diamond)).getVaultBalance(), vaultBefore + 20 * 10**6);
        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 0);

        // Original verdict stands — client (winner) gets paid at finalization, not the executor.
        vm.warp(block.timestamp + 24 hours + 1);
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(agr);
        assertEq(uint8(Agreement(agr).status()), uint8(Agreement.Status.RESOLVED));
    }

    function testResolveAppeal_NoQuorumUpholdsByDefaultAtWindowClose() public {
        (address a2,,) = _addAppealQuorumArbiters();
        address agr = _disputeToVerdict(client, executor, true);

        usdc.mint(executor, 100 * 10**6);
        vm.prank(executor);
        usdc.approve(address(diamond), 20 * 10**6);
        vm.prank(executor);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);

        uint256 vaultBefore = ArbiterRegistryFacet(address(diamond)).getVaultBalance();

        // Only 1 of 3 needed votes cast — quorum never reached.
        vm.prank(a2);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true);

        vm.warp(block.timestamp + 4 days + 1); // APPEAL_REVIEW_WINDOW closes

        ArbiterRegistryFacet(address(diamond)).resolveAppeal(agr);

        assertEq(ArbiterRegistryFacet(address(diamond)).getVaultBalance(), vaultBefore + 20 * 10**6);
        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 0);
    }

    function testResolveAppeal_RevertsBeforeQuorumOrWindowClose() public {
        (address a2,,) = _addAppealQuorumArbiters();
        address agr = _disputeToVerdict(client, executor, true);

        usdc.mint(executor, 100 * 10**6);
        vm.prank(executor);
        usdc.approve(address(diamond), 20 * 10**6);
        vm.prank(executor);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);

        vm.prank(a2);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, true); // only 1 of 3

        vm.expectRevert(ArbiterRegistryFacet.AppealWindowNotClosed.selector);
        ArbiterRegistryFacet(address(diamond)).resolveAppeal(agr);
    }

    // Brief's Step 5 only exercises the AppealWindowNotClosed guard. resolveAppeal() has two
    // other guards (NoAppeal, AppealAlreadyResolved) that the task's own guard-trace
    // requirement calls for — neither was covered by the brief's own test list. Regression
    // test added during self-review, same pattern as Task 3/4's fix rounds.
    function testResolveAppeal_RevertsIfNoAppealOrAlreadyResolved() public {
        // NoAppeal: nobody ever called raiseAppeal on this verdict.
        address agrNoAppeal = _disputeToVerdict(client, executor, true);
        vm.expectRevert(ArbiterRegistryFacet.NoAppeal.selector);
        ArbiterRegistryFacet(address(diamond)).resolveAppeal(agrNoAppeal);

        // AppealAlreadyResolved: resolve once successfully via quorum, then try again.
        (address a2, address a3, address a4) = _addAppealQuorumArbiters();
        address agr = _disputeToVerdict(client, executor, true);

        usdc.mint(executor, 100 * 10**6);
        vm.prank(executor);
        usdc.approve(address(diamond), 20 * 10**6);
        vm.prank(executor);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);

        vm.prank(a2);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, false); // uphold
        vm.prank(a3);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, false); // uphold
        vm.prank(a4);
        ArbiterRegistryFacet(address(diamond)).voteOnAppeal(agr, false); // uphold

        ArbiterRegistryFacet(address(diamond)).resolveAppeal(agr); // resolves fine

        vm.expectRevert(ArbiterRegistryFacet.AppealAlreadyResolved.selector);
        ArbiterRegistryFacet(address(diamond)).resolveAppeal(agr); // second call must revert
    }

    function testAppealUnavailableBelowQuorum_OverturnVerdictStillWorks() public {
        // setUp() registers only the default `arbiter` — no extra arbiters here.
        address agr = _disputeToVerdict(client, executor, true);

        usdc.mint(executor, 100 * 10**6);
        vm.prank(executor);
        usdc.approve(address(diamond), 20 * 10**6);

        vm.prank(executor);
        vm.expectRevert(ArbiterRegistryFacet.InsufficientArbitersForAppeal.selector);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);

        // The pre-existing owner/DAO safety valve is untouched.
        ArbiterRegistryFacet(address(diamond)).overturnVerdict(agr, false);
        assertEq(ArbiterRegistryFacet(address(diamond)).getArbiterMistakeStreak(arbiter), 1);

        vm.warp(block.timestamp + 24 hours + 1);
        ArbiterRegistryFacet(address(diamond)).finalizeVerdict(agr);
        // raiseAppeal reverted before ever pulling the deposit (the quorum check runs
        // before transferFrom) — executor keeps the full 100 USDC mint, plus the payout.
        assertEq(usdc.balanceOf(executor), 100 * 10**6 + AMOUNT);
    }

    // Final-review Finding A: owner's overturnVerdict() and unfreezeVerdict() must not be
    // usable while an appeal is actively in progress (appealed=true, appealResolved=false) —
    // otherwise overturnVerdict could double-slash the same arbiter on top of resolveAppeal,
    // and unfreezeVerdict could let finalizeVerdict bypass the in-flight vote entirely.
    function testOverturnVerdict_RevertsDuringActiveAppeal() public {
        _addAppealQuorumArbiters();
        address agr = _disputeToVerdict(client, executor, true); // client wins, executor loses

        usdc.mint(executor, 100 * 10**6);
        vm.prank(executor);
        usdc.approve(address(diamond), 20 * 10**6);
        vm.prank(executor);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);

        vm.expectRevert(ArbiterRegistryFacet.AppealInProgress.selector);
        ArbiterRegistryFacet(address(diamond)).overturnVerdict(agr, false);
    }

    function testUnfreezeVerdict_RevertsDuringActiveAppeal() public {
        _addAppealQuorumArbiters();
        address agr = _disputeToVerdict(client, executor, true); // client wins, executor loses

        usdc.mint(executor, 100 * 10**6);
        vm.prank(executor);
        usdc.approve(address(diamond), 20 * 10**6);
        vm.prank(executor);
        ArbiterRegistryFacet(address(diamond)).raiseAppeal(agr);

        // Owner (test contract) attempts to unfreeze mid-appeal — must revert, not bypass
        // the in-progress vote.
        vm.expectRevert(ArbiterRegistryFacet.AppealInProgress.selector);
        ArbiterRegistryFacet(address(diamond)).unfreezeVerdict(agr);
    }

    // Sanity check: unfreezeVerdict() still works fine outside of any appeal (the guard only
    // fires when appealed && !appealResolved — freezeVerdict()'s own standalone use, with no
    // appeal ever raised, must be unaffected).
    function testUnfreezeVerdict_WorksWithNoAppealInProgress() public {
        address agr = _disputeToVerdict(client, executor, true);

        ArbiterRegistryFacet(address(diamond)).freezeVerdict(agr);
        ArbiterRegistryStorage.PendingVerdict memory frozen = ArbiterRegistryFacet(address(diamond)).getPendingVerdict(agr);
        assertTrue(frozen.frozen);

        ArbiterRegistryFacet(address(diamond)).unfreezeVerdict(agr);
        ArbiterRegistryStorage.PendingVerdict memory unfrozen = ArbiterRegistryFacet(address(diamond)).getPendingVerdict(agr);
        assertFalse(unfrozen.frozen);
    }
}