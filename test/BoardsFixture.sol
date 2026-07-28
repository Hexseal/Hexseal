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

// ---------- FIXTURE ----------

abstract contract BoardsFixture is Test {
    DiamondProxy diamond;
    MockUSDCB usdc;

    address owner;
    address client;
    address executor;
    address feeRecipient;

    uint8 constant REGION = 0; // CIS — $2 fee (ServiceBoard: ещё region-priced)
    uint256 constant FEE = 2_000_000; // $2 USDC — ServiceBoard fee (fs.regionFee)
    uint256 constant AMOUNT = 100_000_000; // $100 USDC
    // JobBoard теперь prices через quote(): max(AMOUNT * 500 / 10_000, 1_000_000).
    uint256 constant JOB_FEE = 5_000_000;   // 5% от AMOUNT
    uint256 constant JOB_FLOOR = 1_000_000; // fs.feeFloor — несгораемый пол при cancelJob
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
        bytes4[] memory facSels = new bytes4[](18);
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
        facSels[13] = FactoryFacet.setFeeBps.selector;
        facSels[14] = FactoryFacet.setFeeFloor.selector;
        facSels[15] = FactoryFacet.setMaxPendingRequests.selector;
        facSels[16] = FactoryFacet.quoteFee.selector;
        facSels[17] = FactoryFacet.getMaxPendingRequests.selector;

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
        bytes4[] memory svcSels = new bytes4[](21);
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
        svcSels[20] = ServiceBoardFacet.getPendingRequestIdsByClientAndExecutor.selector;

        // --- Infrastructure selectors ---
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
        Agreement agreementImpl = new Agreement();
        AgreementDeployer agDeployer = new AgreementDeployer(address(diamond), address(agreementImpl));
        FactoryFacet(address(diamond)).initFactory(
            address(usdc),
            feeRecipient,
            address(0xDEAD),
            address(diamond),
            address(agDeployer)
        );
    }
}
