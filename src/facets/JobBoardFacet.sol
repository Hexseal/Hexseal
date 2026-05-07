// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// SIGNATURE404 — JobBoardFacet.sol
// Маркетплейс заказов: клиент создаёт заказ, исполнитель откликается
// ============================================================
//
// Поток денег:
//   mintJob():         fee → feeRecipient (сгорает)
//                      amount → хранится в Diamond (JobBoardStorage)
//   acceptApplicant(): вызывает FactoryFacet.deployAgreement() через Diamond
//                      amount переводится из Diamond → Agreement
//   cancelJob():       amount → обратно клиенту, fee не возвращается
// ============================================================

import "../FactoryFacet.sol"; // для FactoryStorage
import "../DiamondProxy.sol"; // для OwnershipLib

import "./IFactory.sol";

// ---------- RECEIPT NFT INTERFACE ----------

interface IJobReceiptMint {
    function mintJobReceipt(
        address to,
        uint256 jobId,
        uint256 amount,
        uint256 deadlineDays,
        uint8   region,
        string  calldata title
    ) external returns (uint256);
}

// USDC permit interface (EIP-2612)
interface IJobBoardUSDC {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

// per-facet guard удалён — используем глобальный DiamondGuard из DiamondProxy.sol

// ---------- STORAGE ----------

library JobBoardStorage {
    bytes32 constant POSITION = keccak256("signature404.jobboard.storage");

    enum JobStatus { OPEN, ACCEPTED, CANCELLED }

    struct Job {
        address client;
        string title;           // max 100 chars
        string description;     // max 500 chars
        uint256 amount;         // сумма сделки USDC (6 decimals)
        uint256 deadlineDays;   // для Agreement
        bytes32 termsHash;      // IPFS CID условий
        uint8 region;           // PPP регион (0=CIS,1=Asia,2=EU,3=US)
        JobStatus status;
        uint256 createdAt;
        address chosenExecutor; // address(0) пока не принят
        address agreement;      // address(0) пока не создан
    }

    struct Layout {
        uint256 nextJobId;
        mapping(uint256 => Job) jobs;
        mapping(address => uint256[]) clientJobs;
        mapping(uint256 => address[]) applicants;
        mapping(uint256 => mapping(address => bool)) hasApplied;
        address _deprecated_receiptNFT; // слот сохранён для совместимости хранилища
        // Явный учёт USDC, хранящихся в Diamond под каждую работу.
        // Обнуляется при acceptApplicant / cancelJob.
        mapping(uint256 => uint256) jobFunds;
    }

    function layout() internal pure returns (Layout storage s) {
        bytes32 p = POSITION;
        assembly { s.slot := p }
    }
}

// ---------- FACET ----------

contract JobBoardFacet {

    // -------- EVENTS --------

    event JobPosted(uint256 indexed jobId, address indexed client, uint256 amount, uint8 region);
    event JobApplied(uint256 indexed jobId, address indexed executor);
    event JobAccepted(uint256 indexed jobId, address indexed client, address indexed executor, address agreement);
    event JobCancelled(uint256 indexed jobId, address indexed client, uint256 refundAmount);

    // -------- ERRORS --------

    error TitleInvalid();
    error DescriptionTooLong();
    error ZeroAmount();
    error DeadlineInvalid();
    error InvalidRegion();
    error ZeroFee();
    error NotClient();
    error JobNotOpen();
    error NotApplicant();
    error AlreadyApplied();
    error Reentrant();
    error FactoryPaused();
    error SelfApply();

    // -------- REENTRANCY --------

    modifier nonReentrant() {
        if (DiamondGuard.status() == DiamondGuard.ENTERED) revert Reentrant();
        DiamondGuard.setStatus(DiamondGuard.ENTERED);
        _;
        DiamondGuard.setStatus(DiamondGuard.NOT_ENTERED);
    }

    // -------- PAUSE CHECK --------

    modifier whenNotPaused() {
        if (FactoryStorage.layout().paused) revert FactoryPaused();
        _;
    }

    // -------- ERC-2771 msgSender --------

    function _msgSender() internal view returns (address sender) {
        if (
            msg.sender == FactoryStorage.layout().trustedForwarder &&
            msg.data.length >= 20
        ) {
            assembly {
                sender := shr(96, calldataload(sub(calldatasize(), 20)))
            }
        } else {
            sender = msg.sender;
        }
    }

    // -------- WRITE --------

    /// @notice Клиент создаёт заказ — gasless via off-chain USDC permit
    function mintJobWithPermit(
        address client,
        string memory title,
        string memory description,
        uint256 amount,
        uint256 deadlineDays,
        bytes32 termsHash,
        uint8 region,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused returns (uint256 jobId) {
        // --- Валидация ---
        uint256 titleLen = bytes(title).length;
        if (titleLen == 0 || titleLen > 100) revert TitleInvalid();
        if (bytes(description).length > 500) revert DescriptionTooLong();
        if (amount == 0) revert ZeroAmount();
        if (deadlineDays == 0 || deadlineDays > 365) revert DeadlineInvalid();
        if (region > 3) revert InvalidRegion();

        FactoryStorage.Layout storage fs = FactoryStorage.layout();
        uint256 fee = fs.regionFee[region];
        if (fee == 0) revert ZeroFee();

        uint256 total = amount + fee;

        IJobBoardUSDC(fs.usdc).permit(client, address(this), total, permitDeadline, v, r, s);

        // --- Effects ---
        JobBoardStorage.Layout storage jbs = JobBoardStorage.layout();
        jobId = jbs.nextJobId++;

        jbs.jobs[jobId] = JobBoardStorage.Job({
            client:         client,
            title:          title,
            description:    description,
            amount:         amount,
            deadlineDays:   deadlineDays,
            termsHash:      termsHash,
            region:         region,
            status:         JobBoardStorage.JobStatus.OPEN,
            createdAt:      block.timestamp,
            chosenExecutor: address(0),
            agreement:      address(0)
        });
        jbs.clientJobs[client].push(jobId);

        // --- Transfers ---
        _safeTransferFrom(fs.usdc, client, fs.feeRecipient, fee);
        _safeTransferFrom(fs.usdc, client, address(this), amount);
        jbs.jobFunds[jobId] = amount;

        // --- Auto-mint job receipt NFT (non-blocking) ---
        try IJobReceiptMint(address(this)).mintJobReceipt(client, jobId, amount, deadlineDays, region, title) {} catch {}

        emit JobPosted(jobId, client, amount, region);
    }

    /// @notice Клиент создаёт заказ
    /// @dev Требует approve(diamond, fee + amount) до вызова
    function mintJob(
        string memory title,
        string memory description,
        uint256 amount,
        uint256 deadlineDays,
        bytes32 termsHash,
        uint8 region
    ) external nonReentrant whenNotPaused returns (uint256 jobId) {
        // --- Валидация ---
        uint256 titleLen = bytes(title).length;
        if (titleLen == 0 || titleLen > 100) revert TitleInvalid();
        if (bytes(description).length > 500) revert DescriptionTooLong();
        if (amount == 0) revert ZeroAmount();
        if (deadlineDays == 0 || deadlineDays > 365) revert DeadlineInvalid();
        if (region > 3) revert InvalidRegion();

        FactoryStorage.Layout storage fs = FactoryStorage.layout();
        uint256 fee = fs.regionFee[region];
        if (fee == 0) revert ZeroFee();

        // --- Effects ---
        JobBoardStorage.Layout storage s = JobBoardStorage.layout();
        jobId = s.nextJobId++;

        s.jobs[jobId] = JobBoardStorage.Job({
            client:         msg.sender,
            title:          title,
            description:    description,
            amount:         amount,
            deadlineDays:   deadlineDays,
            termsHash:      termsHash,
            region:         region,
            status:         JobBoardStorage.JobStatus.OPEN,
            createdAt:      block.timestamp,
            chosenExecutor: address(0),
            agreement:      address(0)
        });
        s.clientJobs[msg.sender].push(jobId);

        // --- Transfers ---
        // Fee → feeRecipient (сгорает, не возвращается)
        _safeTransferFrom(fs.usdc, msg.sender, fs.feeRecipient, fee);
        // Amount → Diamond (хранится до acceptApplicant/cancelJob)
        _safeTransferFrom(fs.usdc, msg.sender, address(this), amount);
        s.jobFunds[jobId] = amount;

        // --- Auto-mint job receipt NFT (non-blocking) ---
        try IJobReceiptMint(address(this)).mintJobReceipt(msg.sender, jobId, amount, deadlineDays, region, title) {} catch {}

        emit JobPosted(jobId, msg.sender, amount, region);
    }

    /// @notice Исполнитель откликается на заказ (gasless-совместим через ERC-2771)
    function applyForJob(uint256 jobId) external {
        address sender = _msgSender();
        JobBoardStorage.Layout storage s = JobBoardStorage.layout();
        JobBoardStorage.Job storage job = s.jobs[jobId];

        if (job.status != JobBoardStorage.JobStatus.OPEN) revert JobNotOpen();
        if (sender == job.client) revert SelfApply();
        if (s.hasApplied[jobId][sender]) revert AlreadyApplied();

        s.hasApplied[jobId][sender] = true;
        s.applicants[jobId].push(sender);

        emit JobApplied(jobId, sender);
    }

    /// @notice Клиент принимает исполнителя → Factory деплоит Agreement (gasless-совместим)
    function acceptApplicant(
        uint256 jobId,
        address executor
    ) external nonReentrant whenNotPaused returns (address agreementAddr) {
        address sender = _msgSender();
        JobBoardStorage.Layout storage s = JobBoardStorage.layout();
        JobBoardStorage.Job storage job = s.jobs[jobId];

        if (sender != job.client) revert NotClient();
        if (job.status != JobBoardStorage.JobStatus.OPEN) revert JobNotOpen();
        if (!s.hasApplied[jobId][executor]) revert NotApplicant();

        // --- Effects ---
        job.status = JobBoardStorage.JobStatus.ACCEPTED;
        job.chosenExecutor = executor;

        // --- Deploy через Factory ---
        (bool ok, bytes memory ret) = address(this).call(
            abi.encodeWithSelector(
                IFactory.deployAgreement.selector,
                job.client,
                executor,
                address(0),
                job.amount,
                job.deadlineDays,
                job.termsHash,
                job.region
            )
        );
        require(ok, "JobBoard: deploy failed");
        agreementAddr = abi.decode(ret, (address));

        job.agreement = agreementAddr;

        // --- Перевод amount из Diamond → Agreement ---
        FactoryStorage.Layout storage fs = FactoryStorage.layout();
        uint256 held = s.jobFunds[jobId];
        require(held == job.amount, "JobBoard: ledger mismatch");
        s.jobFunds[jobId] = 0;
        _safeTransfer(fs.usdc, agreementAddr, held);

        // --- Активируем Agreement ---
        (bool funded, ) = agreementAddr.call(abi.encodeWithSignature("fundFromFactory()"));
        require(funded, "JobBoard: fund failed");

        emit JobAccepted(jobId, job.client, executor, agreementAddr);
    }

    /// @notice Клиент отменяет заказ (amount рефандится, fee нет) — gasless-совместим
    function cancelJob(uint256 jobId) external nonReentrant {
        address sender = _msgSender();
        JobBoardStorage.Layout storage s = JobBoardStorage.layout();
        JobBoardStorage.Job storage job = s.jobs[jobId];

        if (sender != job.client) revert NotClient();
        if (job.status != JobBoardStorage.JobStatus.OPEN) revert JobNotOpen();

        // --- Effects ---
        job.status = JobBoardStorage.JobStatus.CANCELLED;
        uint256 refund = s.jobFunds[jobId];
        require(refund > 0, "JobBoard: no funds recorded");
        s.jobFunds[jobId] = 0;

        // --- Interaction ---
        FactoryStorage.Layout storage fs = FactoryStorage.layout();
        _safeTransfer(fs.usdc, job.client, refund);

        emit JobCancelled(jobId, job.client, refund);
    }

    // -------- VIEW --------

    function getJob(uint256 jobId) external view returns (JobBoardStorage.Job memory) {
        return JobBoardStorage.layout().jobs[jobId];
    }

    function getClientJobs(address client) external view returns (uint256[] memory) {
        return JobBoardStorage.layout().clientJobs[client];
    }

    function getApplicants(uint256 jobId) external view returns (address[] memory) {
        return JobBoardStorage.layout().applicants[jobId];
    }

    function totalJobs() external view returns (uint256) {
        return JobBoardStorage.layout().nextJobId;
    }

    /// @notice Возвращает все OPEN-заказы с их ID
    function getOpenJobs() external view returns (uint256[] memory ids, JobBoardStorage.Job[] memory openJobs) {
        JobBoardStorage.Layout storage s = JobBoardStorage.layout();
        uint256 total = s.nextJobId;

        uint256 count = 0;
        for (uint256 i = 0; i < total; i++) {
            if (s.jobs[i].status == JobBoardStorage.JobStatus.OPEN) count++;
        }

        ids = new uint256[](count);
        openJobs = new JobBoardStorage.Job[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < total; i++) {
            if (s.jobs[i].status == JobBoardStorage.JobStatus.OPEN) {
                ids[idx] = i;
                openJobs[idx] = s.jobs[i];
                idx++;
            }
        }
    }

    // -------- INTERNAL --------

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0x23b872dd, from, to, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "JobBoard: transferFrom failed");
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0xa9059cbb, to, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "JobBoard: transfer failed");
    }
}
