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

    // Test-only stub: a real EIP-2612 permit() verifies (v, r, s) against a
    // signed digest and checks `deadline`. No test in this suite exercises
    // signature validity itself (that's real USDC's job on testnet, not this
    // facet's) — only the gasless call path that relies on the allowance
    // being set afterward. This mock skips verification and sets it directly.
    function permit(
        address tokenOwner,
        address spender,
        uint256 value,
        uint256 /*deadline*/,
        uint8 /*v*/,
        bytes32 /*r*/,
        bytes32 /*s*/
    ) external {
        allowance[tokenOwner][spender] = value;
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

    /// Базовые слоты полей модели комиссии внутри FactoryStorage.Layout.
    /// Считаны по правилам упаковки: usdc(0), feeRecipient(1), regionFee(2),
    /// trustedForwarder(3), diamond+paused(4 — bool упаковался в хвост слота),
    /// protocolArbiter(5), arbitrationThreshold(6), agreementDeployer(7),
    /// feeBps(8), feeFloor(9), maxPendingRequests(10). Смещения не берутся на
    /// веру — _unconfigureFeeModel() сначала утверждает, что по ним лежат
    /// именно засеянные initFactory значения, и только потом обнуляет.
    uint256 constant SLOT_FEE_BPS              = 8;
    uint256 constant SLOT_FEE_FLOOR            = 9;
    uint256 constant SLOT_MAX_PENDING_REQUESTS = 10;

    /// Mirror of the FEE_KIND_* constants declared inside JobBoardFacet /
    /// ServiceBoardFacet. Those are plain (non-public) constants — matching the
    /// facets' own style (see MAX_PENDING_PER_PAIR) and keeping the diamond's
    /// mounted selector set untouched — so they aren't reachable as
    /// `JobBoardFacet.FEE_KIND_JOB_DEAL` from outside the contract. Mirrored
    /// here once so tests reference a name, not a bare number.
    uint8 constant FEE_KIND_JOB_DEAL        = 0;
    uint8 constant FEE_KIND_JOB_FORFEIT     = 1;
    uint8 constant FEE_KIND_SERVICE_LISTING = 2;
    uint8 constant FEE_KIND_REQUEST_DEAL    = 3;
    uint8 constant FEE_KIND_REQUEST_FORFEIT = 4;

    function setUp() public {
        owner = address(this);
        client = address(0x1);
        executor = address(0x2);
        feeRecipient = address(0x4);

        usdc = new MockUSDCB();
        usdc.mint(client, 1_000_000_000);   // $1000
        usdc.mint(executor, 100_000_000);   // $100

        (diamond, ) = _deployBoardsDiamond();
    }

    /// Разворачивает диамонд ровно в той конфигурации, в которой его ждут тесты
    /// досок. Вынесено из setUp, потому что тестам окна апгрейда нужен ВТОРОЙ,
    /// независимый диамонд — с тем же набором фасетов, но без засеянной модели
    /// комиссии (см. _deployUnconfiguredDiamond).
    ///
    /// FactoryFacet монтируется БЕЗ initFeeModel: на живом диамонде этого
    /// селектора ещё нет, его добавляет тот самый Add-батч, который тесты здесь
    /// и воспроизводят. Мы не можем смонтировать его заранее — diamondCut
    /// ревертит "Diamond: selector exists" на повторном Add.
    function _deployBoardsDiamond() internal returns (DiamondProxy d, address factoryImpl) {
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
        bytes4[] memory facSels = new bytes4[](21);
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
        facSels[18] = FactoryFacet.getFeeBps.selector;
        facSels[19] = FactoryFacet.getFeeFloor.selector;
        facSels[20] = FactoryFacet.deployAndFund.selector;
        // initFeeModel НЕ монтируется намеренно — тест атомарного засева
        // добавляет его собственным diamondCut'ом, а повторный Add ревертит.

        // --- JobBoardFacet selectors ---
        bytes4[] memory jobSels = new bytes4[](13);
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
        jobSels[11] = JobBoardFacet.getJobFeeHeld.selector;
        jobSels[12] = JobBoardFacet.mintJobWithPermit.selector;

        // --- ServiceBoardFacet selectors ---
        bytes4[] memory svcSels = new bytes4[](25);
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
        svcSels[21] = ServiceBoardFacet.getRequestFeeHeld.selector;
        svcSels[22] = ServiceBoardFacet.getPendingRequestCount.selector;
        svcSels[23] = ServiceBoardFacet.mintServiceWithPermit.selector;
        svcSels[24] = ServiceBoardFacet.requestServiceWithPermit.selector;

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

        d = new DiamondProxy(owner, cut, address(0), "");
        factoryImpl = address(factoryFacet);

        // Init Registry (authorizedFactory = Diamond itself)
        RegistryFacet(address(d)).initRegistry(address(d));

        // Init Factory
        Agreement agreementImpl = new Agreement();
        AgreementDeployer agDeployer = new AgreementDeployer(address(d), address(agreementImpl));
        FactoryFacet(address(d)).initFactory(
            address(usdc),
            feeRecipient,
            address(0xDEAD),
            address(d),
            address(agDeployer)
        );
    }

    /// Диамонд в состоянии живого 0x760F… СРАЗУ ПОСЛЕ diamondCut'а и ДО
    /// конфигурирующей транзакции: фасеты новые, usdc/feeRecipient/деплойер на
    /// месте, а feeBps/feeFloor/maxPendingRequests — нули, потому что на живом
    /// хранилище этих полей никогда не существовало.
    ///
    /// initFactory() свежего фасета засевает их сам (ради деплоя с нуля),
    /// поэтому здесь они обнуляются обратно через vm.store — ровно тот же приём,
    /// которым testLegacyPendingRequestDoesNotUnderflowOnResolve воспроизводит
    /// лежащее на цепи состояние.
    function _deployUnconfiguredDiamond() internal returns (DiamondProxy d, address factoryImpl) {
        (d, factoryImpl) = _deployBoardsDiamond();
        _unconfigureFeeModel(address(d));
    }

    function _unconfigureFeeModel(address d) internal {
        bytes32 base = FactoryStorage.FACTORY_STORAGE_POSITION;
        bytes32 bpsSlot        = bytes32(uint256(base) + SLOT_FEE_BPS);
        bytes32 floorSlot      = bytes32(uint256(base) + SLOT_FEE_FLOOR);
        bytes32 maxPendingSlot = bytes32(uint256(base) + SLOT_MAX_PENDING_REQUESTS);

        // Смещения не на веру: initFactory только что записал сюда 500 / $1 / 5.
        // Если раскладка Layout поедет, тест упадёт здесь, а не молча обнулит
        // чужое поле и продолжит «проверять» что-то другое.
        assertEq(uint256(vm.load(d, bpsSlot)), 500, "feeBps slot offset drifted");
        assertEq(uint256(vm.load(d, floorSlot)), 1_000_000, "feeFloor slot offset drifted");
        assertEq(uint256(vm.load(d, maxPendingSlot)), 5, "maxPendingRequests slot offset drifted");

        vm.store(d, bpsSlot, bytes32(uint256(0)));
        vm.store(d, floorSlot, bytes32(uint256(0)));
        vm.store(d, maxPendingSlot, bytes32(uint256(0)));
    }
}
