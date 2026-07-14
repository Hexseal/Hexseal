// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/DiamondProxy.sol";
import "../src/RegistryFacet.sol";
import "../src/FactoryFacet.sol";
import "../src/AgreementDeployer.sol";
import "../src/facets/JobBoardFacet.sol";
import "../src/facets/ServiceBoardFacet.sol";
import "../src/JobReceiptFacet.sol";

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
    string constant TERMS = "Standard work terms";

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
        JobReceiptFacet jobReceiptFacet = new JobReceiptFacet();

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
        facSels[5] = bytes4(0x16c38b3c);
        facSels[6] = FactoryFacet.getRegionFee.selector;
        facSels[7] = FactoryFacet.getAllFees.selector;
        facSels[8] = FactoryFacet.getFeeRecipient.selector;
        facSels[9] = FactoryFacet.getTrustedForwarder.selector;
        facSels[10] = bytes4(0xb187bd26);
        facSels[11] = FactoryFacet.getUsdc.selector;
        facSels[12] = bytes4(0x220f72fc);

        // --- JobBoardFacet selectors ---
        bytes4[] memory jobSels = new bytes4[](11);
        jobSels[0]  = JobBoardFacet.mintJob.selector;
        jobSels[1]  = JobBoardFacet.applyForJob.selector;
        jobSels[2]  = JobBoardFacet.acceptApplicant.selector;
        jobSels[3]  = JobBoardFacet.cancelJob.selector;
        jobSels[4]  = JobBoardFacet.getJob.selector;
        jobSels[5]  = JobBoardFacet.getClientJobs.selector;
        jobSels[6]  = JobBoardFacet.getApplicants.selector;
        jobSels[7]  = JobBoardFacet.withdrawApplication.selector;
        jobSels[8]  = JobBoardFacet.editJob.selector;
        jobSels[9]  = JobBoardFacet.totalJobs.selector;
        jobSels[10] = JobBoardFacet.getOpenJobs.selector;

        // --- ServiceBoardFacet selectors ---
        bytes4[] memory svcSels = new bytes4[](20);
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
        svcSels[15] = ServiceBoardFacet.editService.selector;
        svcSels[16] = ServiceBoardFacet.totalRequests.selector;
        svcSels[17] = ServiceBoardFacet.getRequestFunds.selector;
        svcSels[18] = ServiceBoardFacet.getActiveServices.selector;
        svcSels[19] = ServiceBoardFacet.getPendingRequests.selector;

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

        // --- JobReceiptFacet selectors (supportsInterface excluded — already in DiamondLoupe) ---
        bytes4[] memory receiptSels = new bytes4[](21);
        receiptSels[0]  = JobReceiptFacet.name.selector;
        receiptSels[1]  = JobReceiptFacet.symbol.selector;
        receiptSels[2]  = JobReceiptFacet.balanceOf.selector;
        receiptSels[3]  = JobReceiptFacet.ownerOf.selector;
        receiptSels[4]  = JobReceiptFacet.tokenURI.selector;
        receiptSels[5]  = bytes4(keccak256("transferFrom(address,address,uint256)"));
        receiptSels[6]  = bytes4(keccak256("safeTransferFrom(address,address,uint256)"));
        receiptSels[7]  = bytes4(keccak256("safeTransferFrom(address,address,uint256,bytes)"));
        receiptSels[8]  = bytes4(keccak256("approve(address,uint256)"));
        receiptSels[9]  = bytes4(keccak256("setApprovalForAll(address,bool)"));
        receiptSels[10] = JobReceiptFacet.getApproved.selector;
        receiptSels[11] = JobReceiptFacet.isApprovedForAll.selector;
        receiptSels[12] = JobReceiptFacet.setSvgRenderer.selector;
        receiptSels[13] = JobReceiptFacet.getSvgRenderer.selector;
        receiptSels[14] = JobReceiptFacet.mintJobReceipt.selector;
        receiptSels[15] = JobReceiptFacet.getJobReceiptData.selector;
        receiptSels[16] = JobReceiptFacet.isJobReceiptToken.selector;
        receiptSels[17] = JobReceiptFacet.getReceiptTotalSupply.selector;
        receiptSels[18] = JobReceiptFacet.burnJobReceipt.selector;
        receiptSels[19] = JobReceiptFacet.isJobReceiptBurned.selector;
        receiptSels[20] = JobReceiptFacet.getTokenIdByJobId.selector;

        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](8);
        cut[0] = IDiamondCut.FacetCut(address(registryFacet),    IDiamondCut.FacetCutAction.Add, regSels);
        cut[1] = IDiamondCut.FacetCut(address(factoryFacet),     IDiamondCut.FacetCutAction.Add, facSels);
        cut[2] = IDiamondCut.FacetCut(address(diamondCutFacet),  IDiamondCut.FacetCutAction.Add, cutSels);
        cut[3] = IDiamondCut.FacetCut(address(diamondLoupeFacet),IDiamondCut.FacetCutAction.Add, loupeSels);
        cut[4] = IDiamondCut.FacetCut(address(ownershipFacet),   IDiamondCut.FacetCutAction.Add, ownSels);
        cut[5] = IDiamondCut.FacetCut(address(jobBoardFacet),    IDiamondCut.FacetCutAction.Add, jobSels);
        cut[6] = IDiamondCut.FacetCut(address(serviceBoardFacet),IDiamondCut.FacetCutAction.Add, svcSels);
        cut[7] = IDiamondCut.FacetCut(address(jobReceiptFacet),  IDiamondCut.FacetCutAction.Add, receiptSels);

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
        usdc.approve(address(diamond), AMOUNT);
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

        // requestService не берёт fee — только amount блокируется в Diamond
        assertEq(usdc.balanceOf(feeRecipient), feeBefore);
        assertEq(usdc.balanceOf(address(diamond)), AMOUNT);
        assertEq(usdc.balanceOf(client), clientBefore - AMOUNT);

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

    // ============================================================
    //  JOB RECEIPT NFT TESTS
    // ============================================================

    function testJobReceiptMintedOnJobPost() public {
        assertEq(JobReceiptFacet(address(diamond)).getReceiptTotalSupply(), 0);

        _approveAndMintJob();

        assertEq(JobReceiptFacet(address(diamond)).getReceiptTotalSupply(), 1);
        assertEq(JobReceiptFacet(address(diamond)).balanceOf(client), 1);
        assertEq(JobReceiptFacet(address(diamond)).ownerOf(0), client);
        assertTrue(JobReceiptFacet(address(diamond)).isJobReceiptToken(0));
    }

    function testJobReceiptData() public {
        _approveAndMintJob();

        ReceiptStorage.JobReceiptData memory data = JobReceiptFacet(address(diamond)).getJobReceiptData(0);
        assertEq(data.client, client);
        assertEq(data.amount, AMOUNT);
        assertEq(data.deadlineDays, DEADLINE);
        assertEq(data.region, REGION);
        assertEq(data.title, "Build a dApp");
    }

    function testJobReceiptSoulbound() public {
        _approveAndMintJob();

        vm.prank(client);
        vm.expectRevert();
        JobReceiptFacet(address(diamond)).transferFrom(client, address(0x5), 0);
    }

    function testJobReceiptDirectMintReverts() public {
        vm.expectRevert("Only Diamond");
        JobReceiptFacet(address(diamond)).mintJobReceipt(client, 0, AMOUNT, DEADLINE, REGION, "title");
    }

    function testJobReceiptIdempotent() public {
        // Two jobs — each gets its own receipt
        _approveAndMintJob();

        vm.startPrank(client);
        usdc.approve(address(diamond), FEE + AMOUNT);
        JobBoardFacet(address(diamond)).mintJob(
            "Second Job",
            "Another task",
            AMOUNT,
            DEADLINE,
            TERMS,
            REGION
        );
        vm.stopPrank();

        assertEq(JobReceiptFacet(address(diamond)).getReceiptTotalSupply(), 2);
        assertEq(JobReceiptFacet(address(diamond)).balanceOf(client), 2);
    }

    function testJobReceiptNotReceiptToken() public {
        assertFalse(JobReceiptFacet(address(diamond)).isJobReceiptToken(99));
    }

    function testJobReceiptSetSvgRenderer() public {
        address renderer = address(0xABC);
        JobReceiptFacet(address(diamond)).setSvgRenderer(renderer);
        assertEq(JobReceiptFacet(address(diamond)).getSvgRenderer(), renderer);
    }

    function testJobReceiptTokenURIRevertsWithoutRenderer() public {
        _approveAndMintJob();
        // Без SVGRenderer tokenURI ревертит
        vm.expectRevert("SVGRenderer not set");
        JobReceiptFacet(address(diamond)).tokenURI(0);
    }

    function testCancelJobBurnsReceipt() public {
        uint256 jobId = _approveAndMintJob();

        // Receipt смминтилась при создании заказа
        assertEq(JobReceiptFacet(address(diamond)).ownerOf(0), client);
        assertFalse(JobReceiptFacet(address(diamond)).isJobReceiptBurned(0));

        (uint256 tokenId, bool exists) = JobReceiptFacet(address(diamond)).getTokenIdByJobId(jobId);
        assertEq(tokenId, 0);
        assertTrue(exists);

        // Отменяем заказ
        vm.prank(client);
        JobBoardFacet(address(diamond)).cancelJob(jobId);

        // Receipt должна быть сожжена
        assertTrue(JobReceiptFacet(address(diamond)).isJobReceiptBurned(0));
        assertEq(JobReceiptFacet(address(diamond)).balanceOf(client), 0);

        // ownerOf ревертит для сожжённого токена
        vm.expectRevert("ERC721: nonexistent token");
        JobReceiptFacet(address(diamond)).ownerOf(0);

        // getJobReceiptData всё ещё работает — данные сохранены для истории
        ReceiptStorage.JobReceiptData memory data = JobReceiptFacet(address(diamond)).getJobReceiptData(0);
        assertEq(data.client, client);
        assertEq(data.amount, AMOUNT);
    }

    function testBurnJobReceiptDirectReverts() public {
        _approveAndMintJob();

        vm.prank(address(0x99));
        vm.expectRevert("Only Diamond");
        JobReceiptFacet(address(diamond)).burnJobReceipt(0);
    }

    function testGetTokenIdByJobIdBeforeMint() public {
        (, bool exists) = JobReceiptFacet(address(diamond)).getTokenIdByJobId(99);
        assertFalse(exists);
    }

    // ============================================================
    //  JOB BOARD EDIT + WITHDRAW TESTS
    // ============================================================

    function testWithdrawApplication() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);

        assertEq(JobBoardFacet(address(diamond)).getApplicants(jobId).length, 1);

        vm.prank(executor);
        JobBoardFacet(address(diamond)).withdrawApplication(jobId);

        assertEq(JobBoardFacet(address(diamond)).getApplicants(jobId).length, 0);
    }

    function testWithdrawApplicationRevertIfNotApplied() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        vm.expectRevert(JobBoardFacet.NotApplicant.selector);
        JobBoardFacet(address(diamond)).withdrawApplication(jobId);
    }

    function testWithdrawApplicationRevertIfJobClosed() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);

        vm.prank(client);
        JobBoardFacet(address(diamond)).cancelJob(jobId);

        vm.prank(executor);
        vm.expectRevert(JobBoardFacet.JobNotOpen.selector);
        JobBoardFacet(address(diamond)).withdrawApplication(jobId);
    }

    function testEditJob() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(client);
        JobBoardFacet(address(diamond)).editJob(
            jobId,
            "Updated Title",
            "Updated description",
            14,
            TERMS,
            REGION
        );

        JobBoardStorage.Job memory job = JobBoardFacet(address(diamond)).getJob(jobId);
        assertEq(job.title, "Updated Title");
        assertEq(job.deadlineDays, 14);
    }

    function testEditJobRevertIfNotClient() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        vm.expectRevert(JobBoardFacet.NotClient.selector);
        JobBoardFacet(address(diamond)).editJob(jobId, "X", "X", 14, TERMS, REGION);
    }

    function testEditJobRevertIfHasApplicants() public {
        uint256 jobId = _approveAndMintJob();

        vm.prank(executor);
        JobBoardFacet(address(diamond)).applyForJob(jobId);

        vm.prank(client);
        vm.expectRevert(JobBoardFacet.JobHasApplicants.selector);
        JobBoardFacet(address(diamond)).editJob(jobId, "X", "X", 14, TERMS, REGION);
    }

    function testTotalJobsAndGetOpenJobs() public {
        assertEq(JobBoardFacet(address(diamond)).totalJobs(), 0);

        _approveAndMintJob();
        assertEq(JobBoardFacet(address(diamond)).totalJobs(), 1);

        (uint256[] memory ids, JobBoardStorage.Job[] memory jobs) =
            JobBoardFacet(address(diamond)).getOpenJobs();
        assertEq(ids.length, 1);
        assertEq(jobs[0].client, client);
    }

    function testGetClientJobs() public {
        _approveAndMintJob();

        uint256[] memory clientJobs = JobBoardFacet(address(diamond)).getClientJobs(client);
        assertEq(clientJobs.length, 1);
        assertEq(clientJobs[0], 0);
    }

    // ============================================================
    //  SERVICE BOARD EDIT + VIEW TESTS
    // ============================================================

    function testEditService() public {
        uint256 serviceId = _mintService();

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).editService(
            serviceId,
            "Updated Service",
            "New description",
            50_000_000, // new price
            14,         // new deadline
            REGION
        );

        ServiceBoardStorage.Service memory svc = ServiceBoardFacet(address(diamond)).getService(serviceId);
        assertEq(svc.title, "Updated Service");
        assertEq(svc.price, 50_000_000);
        assertEq(svc.deadlineDays, 14);
    }

    function testEditServiceRevertIfNotExecutor() public {
        uint256 serviceId = _mintService();

        vm.prank(client);
        vm.expectRevert(ServiceBoardFacet.NotExecutor.selector);
        ServiceBoardFacet(address(diamond)).editService(
            serviceId, "X", "X", 50_000_000, 14, REGION
        );
    }

    function testTotalRequests() public {
        uint256 serviceId = _mintService();
        assertEq(ServiceBoardFacet(address(diamond)).totalRequests(), 0);

        _requestService(serviceId);
        assertEq(ServiceBoardFacet(address(diamond)).totalRequests(), 1);
    }

    function testGetRequestFunds() public {
        uint256 serviceId = _mintService();
        uint256 requestId = _requestService(serviceId);

        assertEq(ServiceBoardFacet(address(diamond)).getRequestFunds(requestId), AMOUNT);
    }

    function testGetRequestFundsClearedOnAccept() public {
        uint256 serviceId = _mintService();
        uint256 requestId = _requestService(serviceId);

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).acceptRequest(requestId);

        // После accept средства ушли из Diamond в Agreement
        assertEq(ServiceBoardFacet(address(diamond)).getRequestFunds(requestId), 0);
    }

    function testGetActiveServices() public {
        _mintService();

        (uint256[] memory ids, ServiceBoardStorage.Service[] memory svcs) =
            ServiceBoardFacet(address(diamond)).getActiveServices();
        assertEq(ids.length, 1);
        assertEq(svcs[0].executor, executor);
    }

    function testGetExecutorServices() public {
        _mintService();

        uint256[] memory ids = ServiceBoardFacet(address(diamond)).getExecutorServices(executor);
        assertEq(ids.length, 1);
        assertEq(ids[0], 0);
    }

    function testAcceptRequestRevertIfNotPending() public {
        uint256 serviceId = _mintService();
        uint256 requestId = _requestService(serviceId);

        vm.prank(executor);
        ServiceBoardFacet(address(diamond)).acceptRequest(requestId);

        // Повторный accept того же requestId
        vm.prank(executor);
        vm.expectRevert(ServiceBoardFacet.RequestNotPending.selector);
        ServiceBoardFacet(address(diamond)).acceptRequest(requestId);
    }

    function testGetClientRequests() public {
        uint256 serviceId = _mintService();
        _requestService(serviceId);

        uint256[] memory reqs = ServiceBoardFacet(address(diamond)).getClientRequests(client);
        assertEq(reqs.length, 1);
        assertEq(reqs[0], 0);
    }
}
