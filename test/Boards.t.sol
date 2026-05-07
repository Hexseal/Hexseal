// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/DiamondProxy.sol";
import "../src/RegistryFacet.sol";
import "../src/FactoryFacet.sol";
import "../src/AgreementDeployer.sol";
import "../src/facets/JobBoardFacet.sol";
import "../src/facets/ServiceBoardFacet.sol";

// ---------- MOCK USDC ----------

contract MockUSDCB {
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

contract BoardsTest is Test {
    DiamondProxy diamond;
    MockUSDCB usdc;

    address owner;
    address client;
    address executor;
    address feeRecipient;

    uint8 constant REGION = 0; // CIS — $2 fee
    uint256 constant FEE = 2_000_000; // $2 USDC
    uint256 constant AMOUNT = 100_000_000; // $100 USDC
    uint256 constant DEADLINE = 7;
    bytes32 constant TERMS = keccak256("terms");

    function setUp() public {
        owner = address(this);
        client = address(0x1);
        executor = address(0x2);
        feeRecipient = address(0x4);

        usdc = new MockUSDCB();
        usdc.mint(client, 1_000_000_000);   // $1000
        usdc.mint(executor, 100_000_000);   // $100

        // --- Deploy facets ---
        RegistryFacet registryFacet = new RegistryFacet();
        FactoryFacet factoryFacet = new FactoryFacet();
        DiamondCutFacet diamondCutFacet = new DiamondCutFacet();
        DiamondLoupeFacet diamondLoupeFacet = new DiamondLoupeFacet();
        OwnershipFacet ownershipFacet = new OwnershipFacet();
        JobBoardFacet jobBoardFacet = new JobBoardFacet();
        ServiceBoardFacet serviceBoardFacet = new ServiceBoardFacet();

        // --- Registry selectors ---
        bytes4[] memory regSels = new bytes4[](12);
        regSels[0] = RegistryFacet.initRegistry.selector;
        regSels[1] = RegistryFacet.register.selector;
        regSels[2] = RegistryFacet.updateStatus.selector;
        regSels[3] = RegistryFacet.setAuthorizedFactory.selector;
        regSels[4] = RegistryFacet.hasActivePair.selector;
        regSels[5] = RegistryFacet.getActivePair.selector;
        regSels[6] = RegistryFacet.getRecord.selector;
        regSels[7] = RegistryFacet.getByClient.selector;
        regSels[8] = RegistryFacet.getByExecutor.selector;
        regSels[9] = RegistryFacet.getActive.selector;
        regSels[10] = RegistryFacet.totalAgreements.selector;
        regSels[11] = RegistryFacet.authorizedFactory.selector;

        // --- Factory selectors ---
        bytes4[] memory facSels = new bytes4[](13);
        facSels[0] = FactoryFacet.initFactory.selector;
        facSels[1] = FactoryFacet.deployAgreement.selector;
        facSels[2] = FactoryFacet.setRegionFee.selector;
        facSels[3] = FactoryFacet.setFeeRecipient.selector;
        facSels[4] = FactoryFacet.setTrustedForwarder.selector;
        facSels[5] = FactoryFacet.setPaused.selector;
        facSels[6] = FactoryFacet.getRegionFee.selector;
        facSels[7] = FactoryFacet.getAllFees.selector;
        facSels[8] = FactoryFacet.getFeeRecipient.selector;
        facSels[9] = FactoryFacet.getTrustedForwarder.selector;
        facSels[10] = FactoryFacet.isPaused.selector;
        facSels[11] = FactoryFacet.getUsdc.selector;
        facSels[12] = FactoryFacet.setProtocolArbiter.selector;

        // --- JobBoardFacet selectors ---
        bytes4[] memory jobSels = new bytes4[](7);
        jobSels[0] = JobBoardFacet.mintJob.selector;
        jobSels[1] = JobBoardFacet.applyForJob.selector;
        jobSels[2] = JobBoardFacet.acceptApplicant.selector;
        jobSels[3] = JobBoardFacet.cancelJob.selector;
        jobSels[4] = JobBoardFacet.getJob.selector;
        jobSels[5] = JobBoardFacet.getClientJobs.selector;
        jobSels[6] = JobBoardFacet.getApplicants.selector;

        // --- ServiceBoardFacet selectors ---
        bytes4[] memory svcSels = new bytes4[](15);
        svcSels[0]  = ServiceBoardFacet.mintService.selector;
        svcSels[1]  = ServiceBoardFacet.requestService.selector;
        svcSels[2]  = ServiceBoardFacet.acceptRequest.selector;
        svcSels[3]  = ServiceBoardFacet.rejectRequest.selector;
        svcSels[4]  = ServiceBoardFacet.cancelRequest.selector;
        svcSels[5]  = ServiceBoardFacet.removeService.selector;
        svcSels[6]  = ServiceBoardFacet.pauseService.selector;
        svcSels[7]  = ServiceBoardFacet.unpauseService.selector;
        svcSels[8]  = ServiceBoardFacet.getService.selector;
        svcSels[9]  = ServiceBoardFacet.getExecutorServices.selector;
        svcSels[10] = ServiceBoardFacet.getServiceClients.selector;
        svcSels[11] = ServiceBoardFacet.getRequest.selector;
        svcSels[12] = ServiceBoardFacet.getServiceRequests.selector;
        svcSels[13] = ServiceBoardFacet.getClientRequests.selector;
        svcSels[14] = ServiceBoardFacet.totalServices.selector;

        // --- Infrastructure selectors ---
        bytes4[] memory cutSels = new bytes4[](1);
        cutSels[0] = DiamondCutFacet.diamondCut.selector;

        bytes4[] memory loupeSels = new bytes4[](5);
        loupeSels[0] = DiamondLoupeFacet.facets.selector;
        loupeSels[1] = DiamondLoupeFacet.facetFunctionSelectors.selector;
        loupeSels[2] = DiamondLoupeFacet.facetAddresses.selector;
        loupeSels[3] = DiamondLoupeFacet.facetAddress.selector;
        loupeSels[4] = DiamondLoupeFacet.supportsInterface.selector;

        bytes4[] memory ownSels = new bytes4[](2);
        ownSels[0] = OwnershipFacet.transferOwnership.selector;
        ownSels[1] = OwnershipFacet.owner.selector;

        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](7);
        cut[0] = IDiamondCut.FacetCut(address(registryFacet),   IDiamondCut.FacetCutAction.Add, regSels);
        cut[1] = IDiamondCut.FacetCut(address(factoryFacet),    IDiamondCut.FacetCutAction.Add, facSels);
        cut[2] = IDiamondCut.FacetCut(address(diamondCutFacet), IDiamondCut.FacetCutAction.Add, cutSels);
        cut[3] = IDiamondCut.FacetCut(address(diamondLoupeFacet),IDiamondCut.FacetCutAction.Add, loupeSels);
        cut[4] = IDiamondCut.FacetCut(address(ownershipFacet),  IDiamondCut.FacetCutAction.Add, ownSels);
        cut[5] = IDiamondCut.FacetCut(address(jobBoardFacet),   IDiamondCut.FacetCutAction.Add, jobSels);
        cut[6] = IDiamondCut.FacetCut(address(serviceBoardFacet),IDiamondCut.FacetCutAction.Add, svcSels);

        diamond = new DiamondProxy(owner, cut, address(0), "");

        // Init Registry (authorizedFactory = Diamond itself)
        RegistryFacet(address(diamond)).initRegistry(address(diamond));

        // Init Factory
        AgreementDeployer agDeployer = new AgreementDeployer();
        FactoryFacet(address(diamond)).initFactory(
            address(usdc),
            feeRecipient,
            address(0), // no forwarder
            address(diamond),
            address(agDeployer)
        );
    }

    // ============================================================
    //  HELPERS
    // ============================================================

    function _approveAndMintJob() internal returns (uint256 jobId) {
        vm.startPrank(client);
        usdc.approve(address(diamond), FEE + AMOUNT);
        jobId = JobBoardFacet(address(diamond)).mintJob(
            "Build a dApp",
            "Need a Solidity dev",
            AMOUNT,
            DEADLINE,
            TERMS,
            REGION
        );
        vm.stopPrank();
    }

    // ============================================================
    //  JOB BOARD TESTS
    // ============================================================

    function testMintJob() public {
        uint256 clientBefore = usdc.balanceOf(client);
        uint256 feeBefore = usdc.balanceOf(feeRecipient);

        uint256 jobId = _approveAndMintJob();

        assertEq(jobId, 0);

        JobBoardStorage.Job memory job = JobBoardFacet(address(diamond)).getJob(jobId);
        assertEq(job.client, client);
        assertEq(job.amount, AMOUNT);
        assertEq(uint256(job.status), uint256(JobBoardStorage.JobStatus.OPEN));

        // Fee sгорела, amount в Diamond
        assertEq(usdc.balanceOf(client), clientBefore - FEE - AMOUNT);
        assertEq(usdc.balanceOf(feeRecipient), feeBefore + FEE);
        assertEq(usdc.balanceOf(address(diamond)), AMOUNT);
    }

    function testMintJobInvalidTitle() public {
        vm.startPrank(client);
        usdc.approve(address(diamond), FEE + AMOUNT);

        vm.expectRevert(JobBoardFacet.TitleInvalid.selector);
        JobBoardFacet(address(diamond)).mintJob("", "desc", AMOUNT, DEADLINE, TERMS, REGION);
        vm.stopPrank();
    }

    function testMintJobZeroAmount() public {
        vm.startPrank(client);
        usdc.approve(address(diamond), FEE + AMOUNT);

        vm.expectRevert(JobBoardFacet.ZeroAmount.selector);
        JobBoardFacet(address(diamond)).mintJob("title", "desc", 0, DEADLINE, TERMS, REGION);
        vm.stopPrank();
    }

    function testApplyForJob() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);

        address[] memory applicants = JobBoardFacet(address(diamond)).getApplicants(jobId);
        assertEq(applicants.length, 1);
        assertEq(applicants[0], executor);
    }

    function testApplyForJobDuplicate() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);

        vm.prank(executor);
        vm.expectRevert(JobBoardFacet.AlreadyApplied.selector);
        JobBoardFacet(address(diamond)).applyForJob(jobId);
    }

    function testApplyForJobSelf() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(client);
        vm.expectRevert(JobBoardFacet.SelfApply.selector);
        JobBoardFacet(address(diamond)).applyForJob(jobId);
    }

    function testAcceptApplicant() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);

        uint256 diamondBefore = usdc.balanceOf(address(diamond));

        vm.prank(client);
        address agreementAddr = JobBoardFacet(address(diamond)).acceptApplicant(jobId, executor);

        // Job обновилась
        JobBoardStorage.Job memory job = JobBoardFacet(address(diamond)).getJob(jobId);
        assertEq(uint256(job.status), uint256(JobBoardStorage.JobStatus.ACCEPTED));
        assertEq(job.chosenExecutor, executor);
        assertEq(job.agreement, agreementAddr);

        // Diamond отдал amount в Agreement
        assertEq(usdc.balanceOf(address(diamond)), diamondBefore - AMOUNT);

        // Agreement зарегистрирован в Registry
        assertTrue(RegistryFacet(address(diamond)).hasActivePair(client, executor));

        // Agreement адрес ненулевой
        assertTrue(agreementAddr != address(0));
    }

    function testAcceptApplicantNotClient() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);

        vm.prank(executor); // не клиент
        vm.expectRevert(JobBoardFacet.NotClient.selector);
        JobBoardFacet(address(diamond)).acceptApplicant(jobId, executor);
    }

    function testAcceptApplicantNotApplied() public {
        uint256 jobId = _approveAndMintJob();
        // executor не откликался

        vm.prank(client);
        vm.expectRevert(JobBoardFacet.NotApplicant.selector);
        JobBoardFacet(address(diamond)).acceptApplicant(jobId, executor);
    }

    function testCancelJob() public {
        uint256 jobId = _approveAndMintJob();
        uint256 clientBefore = usdc.balanceOf(client);

        vm.prank(client);
        JobBoardFacet(address(diamond)).cancelJob(jobId);

        // Refund
        assertEq(usdc.balanceOf(client), clientBefore + AMOUNT);
        assertEq(usdc.balanceOf(address(diamond)), 0);

        // Статус
        JobBoardStorage.Job memory job = JobBoardFacet(address(diamond)).getJob(jobId);
        assertEq(uint256(job.status), uint256(JobBoardStorage.JobStatus.CANCELLED));
    }

    function testCancelJobNotClient() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        vm.expectRevert(JobBoardFacet.NotClient.selector);
        JobBoardFacet(address(diamond)).cancelJob(jobId);
    }

    function testCancelJobAlreadyCancelled() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(client);
        JobBoardFacet(address(diamond)).cancelJob(jobId);

        vm.prank(client);
        vm.expectRevert(JobBoardFacet.JobNotOpen.selector);
        JobBoardFacet(address(diamond)).cancelJob(jobId);
    }

    function testCancelAfterAccept() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);

        vm.prank(client);
        JobBoardFacet(address(diamond)).acceptApplicant(jobId, executor);

        vm.prank(client);
        vm.expectRevert(JobBoardFacet.JobNotOpen.selector);
        JobBoardFacet(address(diamond)).cancelJob(jobId);
    }

    // ============================================================
    //  SERVICE BOARD TESTS
    // ============================================================

    function _mintService() internal returns (uint256 serviceId) {
        vm.startPrank(executor);
        usdc.approve(address(diamond), FEE);
        serviceId = ServiceBoardFacet(address(diamond)).mintService(
            "Smart Contract Dev",
            "I write secure Solidity",
            AMOUNT, // рекомендованная цена
            DEADLINE,
            REGION
        );
        vm.stopPrank();
    }

    function testMintService() public {
        uint256 executorBefore = usdc.balanceOf(executor);
        uint256 feeBefore = usdc.balanceOf(feeRecipient);

        uint256 serviceId = _mintService();

        assertEq(serviceId, 0);

        ServiceBoardStorage.Service memory svc = ServiceBoardFacet(address(diamond)).getService(serviceId);
        assertEq(svc.executor, executor);
        assertEq(svc.price, AMOUNT);
        assertEq(uint256(svc.status), uint256(ServiceBoardStorage.ServiceStatus.ACTIVE));
        assertEq(svc.hiresCount, 0);

        // Fee сгорела, amount НЕ заблокирован
        assertEq(usdc.balanceOf(executor), executorBefore - FEE);
        assertEq(usdc.balanceOf(feeRecipient), feeBefore + FEE);
        assertEq(usdc.balanceOf(address(diamond)), 0); // Diamond ничего не держит
    }

    function _requestService(uint256 serviceId) internal returns (uint256 requestId) {
        vm.startPrank(client);
        usdc.approve(address(diamond), FEE + AMOUNT);
        requestId = ServiceBoardFacet(address(diamond)).requestService(
            serviceId, AMOUNT, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();
    }

    function testRequestService() public {
        uint256 serviceId = _mintService();

        uint256 clientBefore = usdc.balanceOf(client);
        uint256 feeBefore    = usdc.balanceOf(feeRecipient);

        uint256 requestId = _requestService(serviceId);
        assertEq(requestId, 0);

        // Fee сгорела
        assertEq(usdc.balanceOf(feeRecipient), feeBefore + FEE);
        // Amount заблокирован в Diamond
        assertEq(usdc.balanceOf(address(diamond)), AMOUNT);
        assertEq(usdc.balanceOf(client), clientBefore - FEE - AMOUNT);

        ServiceBoardStorage.HireRequest memory req = ServiceBoardFacet(address(diamond)).getRequest(requestId);
        assertEq(req.client, client);
        assertEq(req.amount, AMOUNT);
        assertEq(uint256(req.status), uint256(ServiceBoardStorage.RequestStatus.PENDING));
        assertEq(req.agreement, address(0));
    }

    function testAcceptRequest() public {
        uint256 serviceId = _mintService();
        uint256 requestId = _requestService(serviceId);

        uint256 diamondBefore = usdc.balanceOf(address(diamond));

        vm.prank(executor);
        address agreementAddr = ServiceBoardFacet(address(diamond)).acceptRequest(requestId);

        assertTrue(agreementAddr != address(0));

        // Amount ушёл из Diamond в Agreement
        assertEq(usdc.balanceOf(address(diamond)), diamondBefore - AMOUNT);

        // Pair зарегистрирована
        assertTrue(RegistryFacet(address(diamond)).hasActivePair(client, executor));

        // hiresCount вырос
        ServiceBoardStorage.Service memory svc = ServiceBoardFacet(address(diamond)).getService(serviceId);
        assertEq(svc.hiresCount, 1);

        // Request статус изменился
        ServiceBoardStorage.HireRequest memory req = ServiceBoardFacet(address(diamond)).getRequest(requestId);
        assertEq(uint256(req.status), uint256(ServiceBoardStorage.RequestStatus.ACCEPTED));
        assertEq(req.agreement, agreementAddr);
    }

    function testRejectRequest() public {
        uint256 serviceId = _mintService();
        uint256 requestId = _requestService(serviceId);

        uint256 clientBefore  = usdc.balanceOf(client);
        uint256 diamondBefore = usdc.balanceOf(address(diamond));

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).rejectRequest(requestId);

        // Amount рефанднут клиенту
        assertEq(usdc.balanceOf(client), clientBefore + AMOUNT);
        assertEq(usdc.balanceOf(address(diamond)), diamondBefore - AMOUNT);

        ServiceBoardStorage.HireRequest memory req = ServiceBoardFacet(address(diamond)).getRequest(requestId);
        assertEq(uint256(req.status), uint256(ServiceBoardStorage.RequestStatus.REJECTED));
    }

    function testCancelRequest() public {
        uint256 serviceId = _mintService();
        uint256 requestId = _requestService(serviceId);

        uint256 clientBefore = usdc.balanceOf(client);

        vm.prank(client);
        ServiceBoardFacet(address(diamond)).cancelRequest(requestId);

        assertEq(usdc.balanceOf(client), clientBefore + AMOUNT);

        ServiceBoardStorage.HireRequest memory req = ServiceBoardFacet(address(diamond)).getRequest(requestId);
        assertEq(uint256(req.status), uint256(ServiceBoardStorage.RequestStatus.CANCELLED));
    }

    function testRequestServiceSelf() public {
        uint256 serviceId = _mintService();

        vm.startPrank(executor);
        usdc.approve(address(diamond), FEE + AMOUNT);
        vm.expectRevert(ServiceBoardFacet.SelfRequest.selector);
        ServiceBoardFacet(address(diamond)).requestService(serviceId, AMOUNT, DEADLINE, TERMS, REGION);
        vm.stopPrank();
    }

    function testAcceptRequestNotExecutor() public {
        uint256 serviceId = _mintService();
        uint256 requestId = _requestService(serviceId);

        vm.prank(client);
        vm.expectRevert(ServiceBoardFacet.NotExecutor.selector);
        ServiceBoardFacet(address(diamond)).acceptRequest(requestId);
    }

    function testRemoveService() public {
        uint256 serviceId = _mintService();

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).removeService(serviceId);

        ServiceBoardStorage.Service memory svc = ServiceBoardFacet(address(diamond)).getService(serviceId);
        assertEq(uint256(svc.status), uint256(ServiceBoardStorage.ServiceStatus.REMOVED));
    }

    function testRemoveServiceNotExecutor() public {
        uint256 serviceId = _mintService();

        vm.prank(client);
        vm.expectRevert(ServiceBoardFacet.NotExecutor.selector);
        ServiceBoardFacet(address(diamond)).removeService(serviceId);
    }

    function testPauseAndUnpauseService() public {
        uint256 serviceId = _mintService();

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).pauseService(serviceId);

        ServiceBoardStorage.Service memory svc = ServiceBoardFacet(address(diamond)).getService(serviceId);
        assertEq(uint256(svc.status), uint256(ServiceBoardStorage.ServiceStatus.PAUSED));

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).unpauseService(serviceId);

        svc = ServiceBoardFacet(address(diamond)).getService(serviceId);
        assertEq(uint256(svc.status), uint256(ServiceBoardStorage.ServiceStatus.ACTIVE));
    }

    function testRequestPausedService() public {
        uint256 serviceId = _mintService();

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).pauseService(serviceId);

        vm.startPrank(client);
        usdc.approve(address(diamond), FEE + AMOUNT);
        vm.expectRevert(ServiceBoardFacet.ServiceNotActive.selector);
        ServiceBoardFacet(address(diamond)).requestService(serviceId, AMOUNT, DEADLINE, TERMS, REGION);
        vm.stopPrank();
    }

    function testServiceMultipleAccepts() public {
        uint256 serviceId = _mintService();

        address client2 = address(0x5);
        usdc.mint(client2, 500_000_000);

        // Первый запрос
        uint256 requestId1 = _requestService(serviceId);

        // Второй запрос от другого клиента
        uint256 amount2 = 50_000_000;
        vm.startPrank(client2);
        usdc.approve(address(diamond), FEE + amount2);
        uint256 requestId2 = ServiceBoardFacet(address(diamond)).requestService(
            serviceId, amount2, DEADLINE, TERMS, REGION
        );
        vm.stopPrank();

        // Executor принимает первый запрос
        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).acceptRequest(requestId1);

        // Executor отклоняет второй
        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).rejectRequest(requestId2);

        ServiceBoardStorage.Service memory svc = ServiceBoardFacet(address(diamond)).getService(serviceId);
        assertEq(svc.hiresCount, 1);
    }
}
