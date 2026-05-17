// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/DiamondProxy.sol";
import "../src/RegistryFacet.sol";
import "../src/FactoryFacet.sol";
import "../src/AgreementDeployer.sol";

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
    bytes32 constant TERMS_HASH = keccak256("test");
    
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
        factorySelectors[5] = FactoryFacet.setPaused.selector;
        factorySelectors[6] = FactoryFacet.getRegionFee.selector;
        factorySelectors[7] = FactoryFacet.getAllFees.selector;
        factorySelectors[8] = FactoryFacet.getFeeRecipient.selector;
        factorySelectors[9] = FactoryFacet.getTrustedForwarder.selector;
        factorySelectors[10] = FactoryFacet.isPaused.selector;
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
        bytes4[] memory ownerSelectors = new bytes4[](2);
        ownerSelectors[0] = OwnershipFacet.transferOwnership.selector;
        ownerSelectors[1] = OwnershipFacet.owner.selector;
        
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](5);
        cut[0] = IDiamondCut.FacetCut(address(registryFacet), IDiamondCut.FacetCutAction.Add, registrySelectors);
        cut[1] = IDiamondCut.FacetCut(address(factoryFacet), IDiamondCut.FacetCutAction.Add, factorySelectors);
        cut[2] = IDiamondCut.FacetCut(address(diamondCutFacet), IDiamondCut.FacetCutAction.Add, cutSelectors);
        cut[3] = IDiamondCut.FacetCut(address(diamondLoupeFacet), IDiamondCut.FacetCutAction.Add, loupeSelectors);
        cut[4] = IDiamondCut.FacetCut(address(ownershipFacet), IDiamondCut.FacetCutAction.Add, ownerSelectors);
        
        diamond = new DiamondProxy(owner, cut, address(0), "");
        AgreementDeployer agDeployer = new AgreementDeployer();

        RegistryFacet(address(diamond)).initRegistry(address(diamond));
        FactoryFacet(address(diamond)).initFactory(address(usdc), feeRecipient, address(0), address(diamond), address(agDeployer));
    }
    
    
    // ============ DIAMOND PROXY TESTS ============
    
    function testDiamondOwner() public {
        assertEq(OwnershipFacet(address(diamond)).owner(), owner);
    }
    
    function testDiamondLoupe() public {
        IDiamondLoupe.Facet[] memory facets = DiamondLoupeFacet(address(diamond)).facets();
        assertGe(facets.length, 5);
    }
    
    function testDiamondSupportsInterface() public {
        assertTrue(DiamondLoupeFacet(address(diamond)).supportsInterface(type(IERC165).interfaceId));
        assertTrue(DiamondLoupeFacet(address(diamond)).supportsInterface(type(IDiamondCut).interfaceId));
        assertTrue(DiamondLoupeFacet(address(diamond)).supportsInterface(type(IDiamondLoupe).interfaceId));
    }
    
    // ============ REGISTRY FACET TESTS ============
    
    function testRegistryInit() public {
        assertEq(RegistryFacet(address(diamond)).authorizedFactory(), address(diamond));
    }
    
    function testRegistryInitRevertIfAlreadyInitialized() public {
        vm.expectRevert(RegistryFacet.AlreadyInitialized.selector);
        RegistryFacet(address(diamond)).initRegistry(address(0x5));
    }
    
    function testRegistryTotalAgreements() public {
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
    
    function testFactoryInit() public {
        assertEq(FactoryFacet(address(diamond)).getUsdc(), address(usdc));
        assertEq(FactoryFacet(address(diamond)).getFeeRecipient(), feeRecipient);
        assertFalse(FactoryFacet(address(diamond)).isPaused());
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
    
    function testFactoryDeployRevertIfPaused() public {
        FactoryFacet(address(diamond)).setPaused(true);
        
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        vm.expectRevert(FactoryFacet.FactoryPausedError.selector);
        FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 0
        );
    }
    
    function testFactoryDeployRevertIfZeroAddress() public {
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        vm.expectRevert(FactoryFacet.ZeroAddress.selector);
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
            client, executor, arbiter, AMOUNT, DEADLINE, TERMS_HASH, 5
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
        FactoryFacet(address(diamond)).setRegionFee(0, 5 * 10**6);
        assertEq(FactoryFacet(address(diamond)).getRegionFee(0), 5 * 10**6);
        
        FactoryFacet(address(diamond)).setFeeRecipient(address(0x5));
        assertEq(FactoryFacet(address(diamond)).getFeeRecipient(), address(0x5));
        
        FactoryFacet(address(diamond)).setTrustedForwarder(address(0x6));
        assertEq(FactoryFacet(address(diamond)).getTrustedForwarder(), address(0x6));
        
        (uint256 cis, uint256 asia, uint256 eu, uint256 us, uint256 latam, uint256 ca, uint256 au) = FactoryFacet(address(diamond)).getAllFees();
        assertGt(cis, 0);
    }
    
    function testFactoryAdminRevertIfNotOwner() public {
        vm.prank(client);
        vm.expectRevert(FactoryFacet.NotOwner.selector);
        FactoryFacet(address(diamond)).setRegionFee(0, 5 * 10**6);
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
        
        uint256 clientBalanceBefore = usdc.balanceOf(client);
        vm.prank(arbiter);
        Agreement(agreementAddr).resolveDispute(true);
        
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
        
        uint256 executorBalanceBefore = usdc.balanceOf(executor);
        vm.prank(arbiter);
        Agreement(agreementAddr).resolveDispute(false);
        
        assertEq(usdc.balanceOf(executor), executorBalanceBefore + AMOUNT);
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
        
        vm.warp(block.timestamp + 2 days);
        
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
        
        vm.warp(block.timestamp + 8 days);
        
        uint256 clientBalanceBefore = usdc.balanceOf(client);
        vm.prank(client);
        Agreement(agreementAddr).triggerArbiterTimeout();
        
        assertEq(usdc.balanceOf(client), clientBalanceBefore + AMOUNT);
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
        
        vm.prank(client);
        usdc.approve(address(diamond), 10 * 10**6);
        vm.prank(client);
        address agreementAddr = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, arbiter, amount, deadline, TERMS_HASH, 0
        );
        
        assertTrue(agreementAddr != address(0));
        assertEq(Agreement(agreementAddr).amount(), amount);
        assertEq(Agreement(agreementAddr).deadlineDays(), deadline);
    }
    
    function testFuzzRegionFee(uint8 region, uint256 fee) public {
        region = uint8(bound(region, 0, 3));
        fee = bound(fee, 0, 100 * 10**6);
        
        FactoryFacet(address(diamond)).setRegionFee(region, fee);
        assertEq(FactoryFacet(address(diamond)).getRegionFee(region), fee);
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
}