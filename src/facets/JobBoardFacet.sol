// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

// ============================================================
// HEXSEAL — JobBoardFacet.sol
// Маркетплейс заказов: клиент создаёт заказ, исполнитель откликается
// ============================================================
//
// Поток денег (комиссия = max(amount * feeBps / 10_000, feeFloor), см.
// FactoryStorage.quote()):
//   mintJob():         amount + fee → хранятся в Diamond (JobBoardStorage).
//                      Комиссия ещё НЕ доход протокола — сделки нет.
//   acceptApplicant(): вызывает FactoryFacet.deployAgreement() через Diamond;
//                      amount переводится из Diamond → Agreement, а
//                      удержанная комиссия — из Diamond → feeRecipient
//                      (сделка создана, комиссия заработана).
//   cancelJob():       amount и комиссия сверх пола — обратно клиенту; пол
//                      ($1) остаётся протоколу как плата за место в ленте.
// ============================================================

import "../FactoryFacet.sol"; // для FactoryStorage
import "../DiamondProxy.sol"; // для OwnershipLib

import "./IFactory.sol";

// ---------- RECEIPT NFT INTERFACES ----------

interface IJobReceiptBurn {
    function burnJobReceipt(uint256 jobId) external returns (bool);
}

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
    /// @custom:storage-location erc7201:hexseal.jobboard.storage
    /// keccak256(abi.encode(uint256(keccak256("hexseal.jobboard.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 constant POSITION = 0x2dfb8cbdd723e055b4c668e1f7986e659e6340635543242a2d9ff47b878af000;

    enum JobStatus { OPEN, ACCEPTED, CANCELLED }

    struct Job {
        address client;
        string title;           // max 100 chars
        string description;     // max 500 chars
        uint256 amount;         // сумма сделки USDC (6 decimals)
        uint256 deadlineDays;   // для Agreement
        string  terms;          // условия работы (on-chain)
        uint8 region;           // PPP регион (0=CIS,1=Asia,2=EU,3=US,4=LATAM,5=CA,6=AU)
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
        // Удержанная комиссия под каждый заказ. Лежит здесь, пока сделки нет:
        // пересылается в казну при acceptApplicant, возвращается (кроме пола)
        // при cancelJob. Обнуляется на обоих путях.
        mapping(uint256 => uint256) jobFeeHeld;
    }

    function store() internal pure returns (Layout storage s) {
        bytes32 p = POSITION;
        assembly { s.slot := p }
    }
}

// ---------- FACET ----------

contract JobBoardFacet {

    // -------- EVENTS --------

    event JobPosted(uint256 indexed jobId, address indexed client, uint256 amount, uint8 region, string title, string description, uint256 deadlineDays, string terms);
    event JobApplied(uint256 indexed jobId, address indexed executor);
    event JobWithdrawn(uint256 indexed jobId, address indexed executor);
    event JobAccepted(uint256 indexed jobId, address indexed client, address indexed executor, address agreement);
    event JobCancelled(uint256 indexed jobId, address indexed client, uint256 refundAmount);
    event JobEdited(uint256 indexed jobId, address indexed client, string title, string description, uint256 deadlineDays, string terms, uint8 region);
    /// Комиссия, реально ушедшая в казну — единственный полный источник
    /// ДОХОДА протокола. Не путать с `ArbiterRegistryFacet.withdrawTreasurySlice`:
    /// та функция ВЫПЛАЧИВАЕТ уже заработанное из банка арбитров и тоже шлёт
    /// USDC на `feeRecipient`, но не собирает новую комиссию — это отток уже
    /// посчитанного здесь дохода, а не второй источник. AgreementDeployed.fee
    /// несёт пересчёт на момент найма и может разойтись с переведённым.
    ///
    /// kind различает и доску, и природу поступления — без него id означал бы
    /// четыре разных пространства идентификаторов (jobId / serviceId /
    /// requestId / отсутствие идентификатора у прямого найма), а плата за
    /// сделку была бы неотличима от невозвратного пола при отмене:
    ///   0 JOB_DEAL         — id = jobId,     комиссия с состоявшейся работы
    ///   1 JOB_FORFEIT      — id = jobId,     пол, оставшийся при отмене заказа
    ///   2 SERVICE_LISTING  — id = serviceId, плоский пол за публикацию услуги
    ///   3 REQUEST_DEAL     — id = requestId, комиссия с состоявшегося найма
    ///   4 REQUEST_FORFEIT  — id = requestId, пол при отклонении/отзыве/вытеснении
    ///   5 DIRECT_DEAL      — id = 0 (естественного id нет — Agreement на
    ///                        момент перевода ещё не задеплоен), прямой найм
    ///                        через FactoryFacet.deployAgreement/deployAndFund,
    ///                        минуя обе доски; сделка опознаётся по
    ///                        AgreementDeployed той же транзакции — так же,
    ///                        как сабграф уже связывает RequestAccepted с
    ///                        AgreementDeployed по транзакции.
    event FeeCollected(uint256 indexed id, address indexed payer, uint8 indexed kind, uint256 amount);

    uint8 constant FEE_KIND_JOB_DEAL = 0;
    uint8 constant FEE_KIND_JOB_FORFEIT = 1;

    // -------- ERRORS --------

    error TitleInvalid();
    error DescriptionTooLong();
    error ZeroAmount();
    error DeadlineInvalid();
    error InvalidRegion();
    error NotClient();
    error JobNotOpen();
    error NotApplicant();
    error AlreadyApplied();
    error Reentrant();
    error FactoryPaused();
    error SelfApply();
    error JobHasApplicants();
    error JobBoardZeroAddress();

    // -------- REENTRANCY --------

    modifier nonReentrant() {
        if (DiamondGuard.status() == DiamondGuard.ENTERED) revert Reentrant();
        DiamondGuard.setStatus(DiamondGuard.ENTERED);
        _;
        DiamondGuard.setStatus(DiamondGuard.NOT_ENTERED);
    }

    // -------- PAUSE CHECK --------

    modifier whenNotPaused() {
        if (FactoryStorage.store().paused) revert FactoryPaused();
        _;
    }

    // -------- ERC-2771 msgSender --------

    function _msgSender() internal view returns (address sender) {
        if (
            msg.sender == FactoryStorage.store().trustedForwarder &&
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
        string  memory terms,
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
        if (region > 6) revert InvalidRegion();

        FactoryStorage.Layout storage fs = FactoryStorage.store();
        uint256 fee = FactoryStorage.quote(fs, amount);

        uint256 total = amount + fee;

        IJobBoardUSDC(fs.usdc).permit(client, address(this), total, permitDeadline, v, r, s);

        // --- Effects ---
        JobBoardStorage.Layout storage jbs = JobBoardStorage.store();
        jobId = jbs.nextJobId++;

        jbs.jobs[jobId] = JobBoardStorage.Job({
            client:         client,
            title:          title,
            description:    description,
            amount:         amount,
            deadlineDays:   deadlineDays,
            terms:          terms,
            region:         region,
            status:         JobBoardStorage.JobStatus.OPEN,
            createdAt:      block.timestamp,
            chosenExecutor: address(0),
            agreement:      address(0)
        });
        jbs.clientJobs[client].push(jobId);

        // --- Transfers ---
        _safeTransferFrom(fs.usdc, client, address(this), total);
        jbs.jobFunds[jobId]   = amount;
        jbs.jobFeeHeld[jobId] = fee;

        // --- Auto-mint job receipt NFT (non-blocking) ---
        try IJobReceiptMint(address(this)).mintJobReceipt(client, jobId, amount, deadlineDays, region, title) {} catch {}

        emit JobPosted(jobId, client, amount, region, title, description, deadlineDays, terms);
    }

    /// @notice Клиент создаёт заказ — gasless-совместим (ERC-2771).
    /// @dev Для gasless-пути relay вызывает USDC.permit() отдельно перед ForwardRequest.
    ///      Для прямого пути требует approve(diamond, fee + amount) до вызова.
    function mintJob(
        string memory title,
        string memory description,
        uint256 amount,
        uint256 deadlineDays,
        string  memory terms,
        uint8 region
    ) external nonReentrant whenNotPaused returns (uint256 jobId) {
        address client = _msgSender();

        // --- Валидация ---
        uint256 titleLen = bytes(title).length;
        if (titleLen == 0 || titleLen > 100) revert TitleInvalid();
        if (bytes(description).length > 500) revert DescriptionTooLong();
        if (amount == 0) revert ZeroAmount();
        if (deadlineDays == 0 || deadlineDays > 365) revert DeadlineInvalid();
        if (region > 6) revert InvalidRegion();

        FactoryStorage.Layout storage fs = FactoryStorage.store();
        uint256 fee = FactoryStorage.quote(fs, amount);

        // --- Effects ---
        JobBoardStorage.Layout storage s = JobBoardStorage.store();
        jobId = s.nextJobId++;

        s.jobs[jobId] = JobBoardStorage.Job({
            client:         client,
            title:          title,
            description:    description,
            amount:         amount,
            deadlineDays:   deadlineDays,
            terms:          terms,
            region:         region,
            status:         JobBoardStorage.JobStatus.OPEN,
            createdAt:      block.timestamp,
            chosenExecutor: address(0),
            agreement:      address(0)
        });
        s.clientJobs[client].push(jobId);

        // --- Transfers ---
        _safeTransferFrom(fs.usdc, client, address(this), amount + fee);
        s.jobFunds[jobId]   = amount;
        s.jobFeeHeld[jobId] = fee;

        // --- Auto-mint job receipt NFT (non-blocking) ---
        try IJobReceiptMint(address(this)).mintJobReceipt(client, jobId, amount, deadlineDays, region, title) {} catch {}

        emit JobPosted(jobId, client, amount, region, title, description, deadlineDays, terms);
    }

    /// @notice Исполнитель отзывает отклик (пока заказ OPEN, gasless-совместим)
    function withdrawApplication(uint256 jobId) external {
        address sender = _msgSender();
        JobBoardStorage.Layout storage s = JobBoardStorage.store();
        JobBoardStorage.Job storage job = s.jobs[jobId];

        if (job.status != JobBoardStorage.JobStatus.OPEN) revert JobNotOpen();
        if (!s.hasApplied[jobId][sender]) revert NotApplicant();

        s.hasApplied[jobId][sender] = false;

        // Swap-and-pop чтобы не ломать порядок без сдвига массива
        address[] storage appl = s.applicants[jobId];
        uint256 len = appl.length;
        for (uint256 i = 0; i < len; i++) {
            if (appl[i] == sender) {
                appl[i] = appl[len - 1];
                appl.pop();
                break;
            }
        }

        emit JobWithdrawn(jobId, sender);
    }

    /// @notice Исполнитель откликается на заказ (gasless-совместим через ERC-2771)
    function applyForJob(uint256 jobId) external {
        address sender = _msgSender();
        JobBoardStorage.Layout storage s = JobBoardStorage.store();
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
        JobBoardStorage.Layout storage s = JobBoardStorage.store();
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
                job.terms,
                job.region
            )
        );
        require(ok, "JobBoard: deploy failed");
        agreementAddr = abi.decode(ret, (address));
        if (agreementAddr == address(0)) revert JobBoardZeroAddress();

        job.agreement = agreementAddr;

        // --- Перевод amount из Diamond → Agreement ---
        FactoryStorage.Layout storage fs = FactoryStorage.store();
        uint256 held = s.jobFunds[jobId];
        require(held == job.amount, "JobBoard: ledger mismatch");
        s.jobFunds[jobId] = 0;
        _safeTransfer(fs.usdc, agreementAddr, held);

        // Сделка создана — комиссия заработана, уходит в казну
        uint256 feeHeld = s.jobFeeHeld[jobId];
        s.jobFeeHeld[jobId] = 0;
        if (feeHeld > 0) {
            _safeTransfer(fs.usdc, fs.feeRecipient, feeHeld);
            emit FeeCollected(jobId, job.client, FEE_KIND_JOB_DEAL, feeHeld);
        }

        // --- Активируем Agreement ---
        (bool funded, ) = agreementAddr.call(abi.encodeWithSignature("fundFromFactory()"));
        require(funded, "JobBoard: fund failed");

        // Posting-чек устарел — деньги теперь в Agreement, у которого свой
        // NFT-чек на обе стороны. Burn non-blocking, как и в cancelJob.
        try IJobReceiptBurn(address(this)).burnJobReceipt(jobId) {} catch {}

        emit JobAccepted(jobId, job.client, executor, agreementAddr);
    }

    /// @notice Клиент отменяет заказ — gasless-совместим.
    /// @dev amount и комиссия сверх пола ($1) возвращаются клиенту; пол
    ///      остаётся протоколу как плата за место в ленте.
    function cancelJob(uint256 jobId) external nonReentrant {
        address sender = _msgSender();
        JobBoardStorage.Layout storage s = JobBoardStorage.store();
        JobBoardStorage.Job storage job = s.jobs[jobId];

        if (sender != job.client) revert NotClient();
        if (job.status != JobBoardStorage.JobStatus.OPEN) revert JobNotOpen();

        // --- Effects ---
        job.status = JobBoardStorage.JobStatus.CANCELLED;
        uint256 refund = s.jobFunds[jobId];
        require(refund > 0, "JobBoard: no funds recorded");
        s.jobFunds[jobId] = 0;

        // --- Interaction ---
        FactoryStorage.Layout storage fs = FactoryStorage.store();

        // Сделки не было — процент возвращается, пол остаётся протоколу.
        uint256 feeHeld = s.jobFeeHeld[jobId];
        s.jobFeeHeld[jobId] = 0;
        uint256 floor_ = fs.feeFloor;
        uint256 burned = feeHeld < floor_ ? feeHeld : floor_;

        uint256 returned = refund + (feeHeld - burned);
        _safeTransfer(fs.usdc, job.client, returned);
        if (burned > 0) {
            _safeTransfer(fs.usdc, fs.feeRecipient, burned);
            emit FeeCollected(jobId, job.client, FEE_KIND_JOB_FORFEIT, burned);
        }

        // Burn receipt NFT — non-blocking so a failure doesn't block the refund
        try IJobReceiptBurn(address(this)).burnJobReceipt(jobId) {} catch {}

        // refundAmount = сколько реально вернулось клиенту (amount + сверх-пола
        // часть комиссии), а не только сумма заказа — так его читает фронт.
        emit JobCancelled(jobId, job.client, returned);
    }

    /// @notice Клиент редактирует заказ, пока он OPEN и НЕТ откликов (gasless-совместим).
    /// @dev amount неизменяем — деньги уже заблокированы в Diamond по старой сумме.
    ///      Хочешь другую сумму — отмени заказ и создай новый.
    ///      Редактирование запрещено после первого отклика — нечестно менять
    ///      условия под уже откликнувшихся исполнителей.
    function editJob(
        uint256 jobId,
        string memory title,
        string memory description,
        uint256 deadlineDays,
        string  memory terms,
        uint8 region
    ) external whenNotPaused {
        address sender = _msgSender();
        JobBoardStorage.Layout storage s = JobBoardStorage.store();
        JobBoardStorage.Job storage job = s.jobs[jobId];

        if (sender != job.client) revert NotClient();
        if (job.status != JobBoardStorage.JobStatus.OPEN) revert JobNotOpen();
        if (s.applicants[jobId].length > 0) revert JobHasApplicants();

        // --- Валидация (та же что при минте) ---
        uint256 titleLen = bytes(title).length;
        if (titleLen == 0 || titleLen > 100) revert TitleInvalid();
        if (bytes(description).length > 500) revert DescriptionTooLong();
        if (deadlineDays == 0 || deadlineDays > 365) revert DeadlineInvalid();
        if (region > 6) revert InvalidRegion();

        // --- Effects ---
        job.title        = title;
        job.description  = description;
        job.deadlineDays = deadlineDays;
        job.terms        = terms;
        job.region       = region;

        emit JobEdited(jobId, sender, title, description, deadlineDays, terms, region);
    }

    // -------- VIEW --------

    function getJob(uint256 jobId) external view returns (JobBoardStorage.Job memory) {
        return JobBoardStorage.store().jobs[jobId];
    }

    function getClientJobs(address client) external view returns (uint256[] memory) {
        return JobBoardStorage.store().clientJobs[client];
    }

    function getApplicants(uint256 jobId) external view returns (address[] memory) {
        return JobBoardStorage.store().applicants[jobId];
    }

    function totalJobs() external view returns (uint256) {
        return JobBoardStorage.store().nextJobId;
    }

    /// @notice Комиссия, удержанная в Diamond под этот заказ. Обнуляется и при
    ///         acceptApplicant, и при cancelJob. Нужна фронту, чтобы честно
    ///         показать «отмена вернёт $X, $1 останется», не пересчитывая
    ///         формулу у себя — на живом хранилище лежат заказы, удержанные по
    ///         старой ставке, и клиентский пересчёт с ними разойдётся.
    function getJobFeeHeld(uint256 jobId) external view returns (uint256) {
        return JobBoardStorage.store().jobFeeHeld[jobId];
    }

    /// @notice Возвращает все OPEN-заказы с их ID
    function getOpenJobs() external view returns (uint256[] memory ids, JobBoardStorage.Job[] memory openJobs) {
        JobBoardStorage.Layout storage s = JobBoardStorage.store();
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
