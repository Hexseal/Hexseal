// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// HEXSEAL — Agreement.sol
//
// Один контракт = одна сделка = один NFT
// Иммутабелен после деплоя — как юридический договор
// ERC-2771 gasless для всех действий сторон
// Soulbound NFT пока сделка активна
// Арбитр = мультисиг протокола (не рандомный человек)
// Если арбитр не резолвит за 7 дней — авторефанд клиенту
// ============================================================

// ---------- MINIMAL ERC721 (без OZ, без зависимостей) ----------
// Почему без OZ: Agreement деплоится тысячами через Factory.
// Каждый байт bytecode = газ при деплое.
// Минимальная реализация достаточна — нам нужен только:
// mint, burn, ownerOf, soulbound transfer block.

abstract contract MinimalERC721 {
    // ---- Storage ----
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    string private _name;
    string private _symbol;

    // ---- Events (ERC721 стандарт) ----
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    // ---- Errors ----
    error ERC721NonexistentToken(uint256 tokenId);
    error ERC721NotOwnerOrApproved();
    error ERC721TransferToZeroAddress();
    error ERC721AlreadyMinted();
    error TokenSoulbound(); // soulbound — нельзя передать пока ACTIVE

    constructor(string memory name_, string memory symbol_) {
        _name = name_;
        _symbol = symbol_;
    }

    function name() external view returns (string memory) { return _name; }
    function symbol() external view returns (string memory) { return _symbol; }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address owner = _owners[tokenId];
        if (owner == address(0)) revert ERC721NonexistentToken(tokenId);
        return owner;
    }

    function balanceOf(address owner) external view returns (uint256) {
        return _balances[owner];
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        return _tokenApprovals[tokenId];
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function approve(address to, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        require(msg.sender == owner || _operatorApprovals[owner][msg.sender], "ERC721: not authorized");
        _tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata) external {
        _transfer(from, to, tokenId);
    }

    // Hook — переопределяется в Agreement для soulbound
    function _beforeTransfer(address from, address to, uint256 tokenId) internal virtual {}

    function _transfer(address from, address to, uint256 tokenId) internal {
        if (to == address(0)) revert ERC721TransferToZeroAddress();
        address owner = ownerOf(tokenId);
        require(owner == from, "ERC721: wrong owner");
        require(
            msg.sender == owner ||
            _tokenApprovals[tokenId] == msg.sender ||
            _operatorApprovals[owner][msg.sender],
            "ERC721: not authorized"
        );
        _beforeTransfer(from, to, tokenId);
        delete _tokenApprovals[tokenId];
        unchecked {
            _balances[from]--;
            _balances[to]++;
        }
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function _mint(address to, uint256 tokenId) internal {
        if (to == address(0)) revert ERC721TransferToZeroAddress();
        if (_owners[tokenId] != address(0)) revert ERC721AlreadyMinted();
        unchecked { _balances[to]++; }
        _owners[tokenId] = to;
        emit Transfer(address(0), to, tokenId);
    }

    function _burn(uint256 tokenId) internal {
        address owner = ownerOf(tokenId);
        delete _tokenApprovals[tokenId];
        unchecked { _balances[owner]--; }
        delete _owners[tokenId];
        emit Transfer(owner, address(0), tokenId);
    }

    function _exists(uint256 tokenId) internal view returns (bool) {
        return _owners[tokenId] != address(0);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == 0x80ac58cd || // ERC721
            interfaceId == 0x5b5e139f || // ERC721Metadata
            interfaceId == 0x01ffc9a7;   // ERC165
    }
}

// ---------- MINIMAL REENTRANCY GUARD ----------

abstract contract ReentrancyGuard {
    uint256 private _status;
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    constructor() { _status = NOT_ENTERED; }

    modifier nonReentrant() {
        require(_status != ENTERED, "ReentrancyGuard: reentrant call");
        _status = ENTERED;
        _;
        _status = NOT_ENTERED;
    }
}

// ---------- ERC-2771 CONTEXT (gasless) ----------
// Trusted forwarder передаёт реальный msg.sender в конце calldata

abstract contract ERC2771Context {
    address private immutable _trustedForwarder;

    constructor(address trustedForwarder_) {
        _trustedForwarder = trustedForwarder_;
    }

    function isTrustedForwarder(address forwarder) public view returns (bool) {
        return forwarder == _trustedForwarder;
    }

    function trustedForwarder() external view returns (address) {
        return _trustedForwarder;
    }

    // Реальный отправитель: если вызов через forwarder — берём из конца calldata
    function _msgSender() internal view returns (address sender) {
        if (isTrustedForwarder(msg.sender) && msg.data.length >= 20) {
            assembly {
                sender := shr(96, calldataload(sub(calldatasize(), 20)))
            }
        } else {
            sender = msg.sender;
        }
    }
}

// ---------- MINIMAL SAFE ERC20 TRANSFER ----------

library SafeUSDC {
    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0xa9059cbb, to, amount) // transfer(address,uint256)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "USDC: transfer failed");
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0x23b872dd, from, to, amount) // transferFrom
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "USDC: transferFrom failed");
    }
}

// ---------- MINIMAL ERC20 INTERFACE ----------

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

interface IReputationFacet {
    function autoAwardXP(address agreement) external;
}

// ---------- REGISTRY INTERFACE ----------
// Agreement вызывает Diamond (Registry фасет) для обновления статуса

interface ISignatureRegistry {
    enum AgreementStatus { ACTIVE, COMPLETED, REFUNDED, DISPUTED, RESOLVED }
    function updateStatus(address agreement, AgreementStatus newStatus) external;
}

interface IArbiterRegistry {
    function clearDisputeClaim(address agreement) external;
}

// ============================================================
// AGREEMENT CONTRACT
// ============================================================

contract Agreement is MinimalERC721, ReentrancyGuard, ERC2771Context {
    using SafeUSDC for address;

    // -------- CONSTANTS --------

    uint256 public constant TOKEN_ID          = 1; // NFT клиента
    uint256 public constant EXECUTOR_TOKEN_ID = 2; // NFT исполнителя

    uint256 public constant ACTIVATION_WINDOW  = 2 days; // executor должен подтвердить старт
    uint256 public constant AUTO_APPROVE_WINDOW = 2 days; // клиент должен ответить после markDone
    uint256 public constant DISPUTE_WINDOW      = 4 days; // арбитр должен резолвить спор
    uint256 public constant DEADLINE_GRACE      = 1 days; // grace-период после дедлайна перед рефандом
    // Если арбитр не резолвит за 4 дня — авторефанд клиенту (защита от неактивного арбитра)

    // -------- IMMUTABLES (задаются при деплое, никогда не меняются) --------

    address public immutable client;        // заказчик
    address public immutable executor;      // исполнитель
    address public arbiter;                 // арбитр (address(0) до клейма; setArbiter вызывает Diamond)
    uint256 public immutable amount;        // сумма сделки USDC (6 decimals)
    uint256 public immutable deadlineDays;  // дней до авторефанда
    string  public terms;                   // условия сделки — задаются при деплое
    address public immutable usdc;          // USDC на Base
    address public immutable diamond;       // Diamond proxy = Registry
    address public immutable factory;       // FactoryFacet address (for fundFromFactory)

    // -------- STATE --------

    uint256 public fundedAt;      // когда клиент задепонировал
    uint256 public activatedAt;   // когда исполнитель подтвердил старт
    uint256 public markedDoneAt;  // когда исполнитель отметил выполнение
    uint256 public disputedAt;    // когда поднят спор
    uint256 public resolvedAt;    // когда арбитр резолвил

    // Флаг финализации — предотвращает двойное завершение при гонке resolveDispute / triggerArbiterTimeout
    bool private _finalized;

    // Extras: доп оплата за переделки/доп работу (клиент предлагает → исполнитель принимает)
    mapping(uint256 => Extra) public extras;
    uint256 public nextExtraId;
    uint256 public extrasTotal;         // сумма принятых extras → исполнителю при release
    uint256 public pendingExtrasTotal;  // сумма ожидающих extras → рефанд клиенту при закрытии

    // -------- STATUS ENUM --------

    enum Status {
        CREATED,   // задеплоен, не профинансирован
        FUNDED,    // клиент задепонировал USDC, NFT заминтен
        ACTIVE,    // исполнитель подтвердил — обе стороны залочены
        COMPLETED, // завершено, USDC ушёл исполнителю, NFT сожжён
        DISPUTED,  // спор поднят
        RESOLVED,  // арбитр вынес решение
        REFUNDED   // рефанд клиенту, NFT сожжён
    }

    // -------- EXTRAS --------

    enum ExtraStatus { PENDING, ACCEPTED, REJECTED }

    struct Extra {
        uint256 amount;
        string  terms;
        ExtraStatus status;
    }

    // -------- EVENTS --------

    event Funded(address indexed client, uint256 amount);
    event Activated(address indexed executor);
    event MarkedDone(address indexed executor);
    event Released(address indexed client, address indexed executor, uint256 amount);
    event AutoApproved(address indexed executor, uint256 amount);
    event DisputeRaised(address indexed by);
    event DisputeResolved(address indexed arbiter, bool clientWins, uint256 amount);
    event TimedOut(address indexed client, uint256 amount);
    event ArbiterTimedOut(address indexed client, uint256 amount);
    event ExtraProposed(uint256 indexed extraId, address indexed client, uint256 amount, string terms);
    event ExtraAccepted(uint256 indexed extraId, uint256 newTotal);
    event ExtraRejected(uint256 indexed extraId);
    // Срабатывает если Registry.updateStatus() упал — сделка завершена, статус в Registry рассинхронизирован.
    // Любой может вызвать syncRegistry() чтобы исправить.
    event RegistrySyncFailed(address indexed agreement, uint8 targetStatus);

    // -------- ERRORS --------

    error NotClient();
    error NotExecutor();
    error NotArbiter();
    error NotParty();
    error AlreadyFunded();
    error NotFunded();
    error NotActive();
    error AlreadyActive();
    error AlreadyMarkedDone();
    error NotMarkedDone();
    error AlreadyDisputed();
    error NotDisputed();
    error AlreadyResolved();
    error AlreadyFinalized();
    error WindowNotPassed();
    error WindowAlreadyPassed();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error ActivationWindowPassed();
    error ArbiterWindowNotPassed();
    error NoArbiterSet();
    error WrongAmount();
    error ExtraNotPending();
    error ZeroAmount();

    // -------- CONSTRUCTOR --------

    constructor(
        address client_,
        address executor_,
        address arbiter_,
        uint256 amount_,
        uint256 deadlineDays_,
        string  memory terms_,
        address diamond_,
        address usdc_,
        address trustedForwarder_,
        address factory_
    )
        MinimalERC721("Hexseal Deal", "HSEAL")
        ERC2771Context(trustedForwarder_)
    {
        require(client_ != address(0), "Agreement: zero client");
        require(executor_ != address(0), "Agreement: zero executor");
        require(diamond_ != address(0), "Agreement: zero diamond");
        require(usdc_ != address(0), "Agreement: zero usdc");
        require(factory_ != address(0), "Agreement: zero factory");
        require(amount_ > 0, "Agreement: zero amount");
        require(deadlineDays_ > 0, "Agreement: zero deadline");
        require(client_ != executor_, "Agreement: client == executor");

        client       = client_;
        executor     = executor_;
        arbiter      = arbiter_;
        amount       = amount_;
        deadlineDays = deadlineDays_;
        terms        = terms_;
        diamond      = diamond_;
        usdc         = usdc_;
        factory      = factory_;
    }

    // -------- ARBITER REGISTRY --------

    /// @notice Diamond (ArbiterRegistryFacet) устанавливает арбитра при клейме спора.
    /// Только Diamond может вызвать — проверяем msg.sender напрямую (не ERC-2771).
    function setArbiter(address newArbiter) external {
        require(msg.sender == diamond, "Agreement: only Diamond");
        // Diamond сам может быть арбитром (Diamond-as-arbiter паттерн) — пропускаем проверку реестра
        if (newArbiter != address(0) && newArbiter != diamond) {
            (bool ok, bytes memory data) = diamond.staticcall(
                abi.encodeWithSignature("isRegisteredArbiter(address)", newArbiter)
            );
            require(ok && abi.decode(data, (bool)), "Agreement: arbiter not registered");
        }
        arbiter = newArbiter;
    }

    // -------- STATUS VIEW --------

    function status() public view returns (Status) {
        if (fundedAt == 0)    return Status.CREATED;
        if (activatedAt == 0) return Status.FUNDED;

        // Спор
        if (disputedAt > 0) {
            if (resolvedAt > 0) return Status.RESOLVED;
            // Арбитр не успел за DISPUTE_WINDOW — будет REFUNDED через triggerArbiterTimeout
            return Status.DISPUTED;
        }

        // Исполнитель отметил выполнение
        if (markedDoneAt > 0) {
            // Клиент не ответил за AUTO_APPROVE_WINDOW → COMPLETED (деньги исполнителю)
            if (block.timestamp >= markedDoneAt + AUTO_APPROVE_WINDOW) {
                return Status.COMPLETED;
            }
            return Status.ACTIVE;
        }

        // После grace-периода и без сдачи → REFUNDED (ожидает triggerDeadlineTimeout)
        if (block.timestamp > activatedAt + (deadlineDays * 1 days) + DEADLINE_GRACE) {
            return Status.REFUNDED;
        }

        return Status.ACTIVE;
    }

    // -------- SOULBOUND --------

    // Блокируем transfer пока сделка ACTIVE или DISPUTED
    function _beforeTransfer(address from, address /*to*/, uint256 /*tokenId*/) internal view override {
        if (from == address(0)) return; // mint разрешён
        Status s = status();
        if (s == Status.ACTIVE || s == Status.DISPUTED || s == Status.FUNDED) {
            revert TokenSoulbound();
        }
    }

    // -------- ДЕЙСТВИЯ --------

    /// @notice Клиент депонирует USDC и минтит NFT
    /// Клиент должен сделать approve(agreement, amount) на USDC перед вызовом
    function fund() external nonReentrant {
        address sender = _msgSender();
        if (sender != client) revert NotClient();
        if (fundedAt != 0) revert AlreadyFunded();

        // CEI: set state before external call
        fundedAt = block.timestamp;

        // Переводим USDC от клиента в контракт
        usdc.safeTransferFrom(sender, address(this), amount);

        // Оба участника получают NFT в одной транзакции
        _mint(client,   TOKEN_ID);
        _mint(executor, EXECUTOR_TOKEN_ID);

        // Обновляем статус в Registry (через Diamond)
        // FUNDED не отдельный статус в Registry — всё ещё ACTIVE пока не завершено
        // Registry.updateStatus вызывать не нужно — регистрация уже была при деплое

        emit Funded(client, amount);
    }

    /// @notice Factory-funded path: USDC already transferred by factory
    /// Only factory can call this — used by deployAndFund()
    function fundFromFactory() external nonReentrant {
        if (msg.sender != factory) revert NotClient();
        if (fundedAt != 0) revert AlreadyFunded();

        // Verify USDC balance is sufficient
        uint256 balance = IERC20(usdc).balanceOf(address(this));
        require(balance >= amount, "Agreement: insufficient balance");

        fundedAt = block.timestamp;
        _mint(client,   TOKEN_ID);
        _mint(executor, EXECUTOR_TOKEN_ID);

        emit Funded(client, amount);
    }

    /// @notice Исполнитель подтверждает начало работы
    /// После этого клиент не может забрать деньги
    function activate() external {
        address sender = _msgSender();
        if (sender != executor) revert NotExecutor();
        if (fundedAt == 0) revert NotFunded();
        if (activatedAt != 0) revert AlreadyActive();

        // Если activation window прошёл — исполнитель облажался, надо triggerActivationTimeout
        if (block.timestamp > fundedAt + ACTIVATION_WINDOW) revert ActivationWindowPassed();

        activatedAt = block.timestamp;

        emit Activated(executor);
    }

    /// @notice Исполнитель сигнализирует о завершении работы
    function markDone() external {
        address sender = _msgSender();
        if (sender != executor) revert NotExecutor();
        if (activatedAt == 0) revert NotActive();
        if (markedDoneAt != 0) revert AlreadyMarkedDone();
        if (disputedAt != 0) revert AlreadyDisputed();

        // Дедлайн + grace период — исполнитель может сдать в течение 1 дня после дедлайна
        if (block.timestamp > activatedAt + (deadlineDays * 1 days) + DEADLINE_GRACE) revert DeadlinePassed();

        markedDoneAt = block.timestamp;

        emit MarkedDone(executor);
    }

    /// @notice Клиент подтверждает выполнение → USDC уходит исполнителю
    function release() external nonReentrant {
        address sender = _msgSender();
        if (sender != client) revert NotClient();
        if (markedDoneAt == 0) revert NotMarkedDone();
        if (disputedAt != 0) revert AlreadyDisputed();

        // AUTO_APPROVE_WINDOW ещё не прошёл (иначе triggerAutoApprove)
        if (block.timestamp >= markedDoneAt + AUTO_APPROVE_WINDOW) revert WindowAlreadyPassed();

        _settlePending();
        uint256 payout = amount + extrasTotal;

        _complete(Status.COMPLETED);
        usdc.safeTransfer(executor, payout);

        emit Released(client, executor, payout);
    }

    /// @notice Любой может вызвать авто-подтверждение после AUTO_APPROVE_WINDOW
    /// Клиент не ответил → исполнитель получает деньги автоматически
    function triggerAutoApprove() external nonReentrant {
        if (markedDoneAt == 0) revert NotMarkedDone();
        if (disputedAt != 0) revert AlreadyDisputed();
        if (block.timestamp < markedDoneAt + AUTO_APPROVE_WINDOW) revert WindowNotPassed();

        _settlePending();
        uint256 payout = amount + extrasTotal;

        _complete(Status.COMPLETED);
        usdc.safeTransfer(executor, payout);

        emit AutoApproved(executor, payout);
    }

    /// @notice Клиент или исполнитель поднимают спор
    /// Можно поднять спор даже после markDone, если AUTO_APPROVE_WINDOW ещё не прошёл
    function raiseDispute() external {
        address sender = _msgSender();
        if (sender != client && sender != executor) revert NotParty();
        if (activatedAt == 0) revert NotActive();
        if (disputedAt != 0) revert AlreadyDisputed();

        // Если markDone уже вызван — спор возможен только в пределах AUTO_APPROVE_WINDOW
        if (markedDoneAt != 0 && block.timestamp >= markedDoneAt + AUTO_APPROVE_WINDOW) {
            revert WindowAlreadyPassed();
        }

        // Дедлайн проверяем только если markDone ещё не вызван:
        // если исполнитель успел markDone до дедлайна, клиент должен иметь право
        // поднять спор в пределах AUTO_APPROVE_WINDOW даже если дедлайн уже прошёл
        if (markedDoneAt == 0 && block.timestamp > activatedAt + (deadlineDays * 1 days) + DEADLINE_GRACE) {
            revert DeadlinePassed();
        }

        disputedAt = block.timestamp;

        _updateRegistry(ISignatureRegistry.AgreementStatus.DISPUTED);

        emit DisputeRaised(sender);
    }

    /// @notice Арбитр резолвит спор
    /// clientWins = true → рефанд клиенту
    /// clientWins = false → оплата исполнителю
    function resolveDispute(bool clientWins) external nonReentrant {
        address sender = _msgSender();
        if (arbiter == address(0)) revert NoArbiterSet();
        // Diamond-as-arbiter: Diamond вызывает напрямую через finalizeVerdict
        if (sender != arbiter && msg.sender != diamond) revert NotArbiter();
        if (disputedAt == 0) revert NotDisputed();
        if (resolvedAt != 0) revert AlreadyResolved();

        // Арбитр должен успеть за DISPUTE_WINDOW
        if (block.timestamp > disputedAt + DISPUTE_WINDOW) revert WindowAlreadyPassed();

        resolvedAt = block.timestamp;

        _settlePending();
        uint256 payout = amount + extrasTotal;

        if (clientWins) {
            _complete(Status.RESOLVED);
            usdc.safeTransfer(client, payout);
        } else {
            _complete(Status.RESOLVED);
            usdc.safeTransfer(executor, payout);
        }

        _clearDisputeClaim();
        emit DisputeResolved(arbiter, clientWins, payout);
    }

    /// @notice Таймаут активации — исполнитель не подтвердил за ACTIVATION_WINDOW
    /// Рефанд клиенту
    function triggerActivationTimeout() external nonReentrant {
        address sender = _msgSender();
        if (sender != client && sender != executor) revert NotParty();
        if (fundedAt == 0) revert NotFunded();
        if (activatedAt != 0) revert AlreadyActive();
        if (block.timestamp <= fundedAt + ACTIVATION_WINDOW) revert WindowNotPassed();

        uint256 payout = amount;

        _complete(Status.REFUNDED);
        usdc.safeTransfer(client, payout);

        emit TimedOut(client, payout);
    }

    /// @notice Таймаут дедлайна — исполнитель не выполнил за deadlineDays
    /// Рефанд клиенту
    function triggerDeadlineTimeout() external nonReentrant {
        address sender = _msgSender();
        if (sender != client && sender != executor) revert NotParty();
        if (activatedAt == 0) revert NotActive();
        if (disputedAt != 0) revert AlreadyDisputed();
        if (markedDoneAt != 0) revert AlreadyMarkedDone();
        // Рефанд доступен только после дедлайна + grace (1 день), чтобы дать исполнителю шанс сдать
        if (block.timestamp <= activatedAt + (deadlineDays * 1 days) + DEADLINE_GRACE) revert DeadlineNotPassed();

        _settlePending();
        uint256 payout = amount + extrasTotal;

        _complete(Status.REFUNDED);
        usdc.safeTransfer(client, payout);

        emit TimedOut(client, payout);
    }

    /// @notice Таймаут арбитра — арбитр не резолвил за DISPUTE_WINDOW
    /// Авторефанд клиенту — защита от неактивного/злонамеренного арбитра
    function triggerArbiterTimeout() external nonReentrant {
        address sender = _msgSender();
        if (sender != client && sender != executor) revert NotParty();
        if (disputedAt == 0) revert NotDisputed();
        if (resolvedAt != 0) revert AlreadyResolved();
        if (block.timestamp <= disputedAt + DISPUTE_WINDOW) revert WindowNotPassed();

        _settlePending();
        uint256 payout = amount + extrasTotal;

        _complete(Status.REFUNDED);
        usdc.safeTransfer(client, payout);

        _clearDisputeClaim();
        emit ArbiterTimedOut(client, payout);
    }

    // -------- EXTRAS --------

    /// @notice Клиент предлагает доп оплату за переделку / новую задачу.
    /// USDC лочится в Agreement. Исполнитель принимает (acceptExtra) или отклоняет (rejectExtra).
    /// Все принятые extras прибавляются к основному amount при release.
    function proposeExtra(uint256 extraAmount, string calldata extraTerms) external nonReentrant {
        address sender = _msgSender();
        if (sender != client) revert NotClient();
        if (extraAmount == 0) revert ZeroAmount();
        if (activatedAt == 0) revert NotActive();
        if (markedDoneAt != 0) revert AlreadyMarkedDone();
        if (disputedAt != 0) revert AlreadyDisputed();
        if (_finalized) revert AlreadyFinalized();
        if (block.timestamp > activatedAt + (deadlineDays * 1 days)) revert DeadlinePassed();

        uint256 extraId = nextExtraId++;
        extras[extraId] = Extra({ amount: extraAmount, terms: extraTerms, status: ExtraStatus.PENDING });
        pendingExtrasTotal += extraAmount;

        usdc.safeTransferFrom(sender, address(this), extraAmount);

        emit ExtraProposed(extraId, sender, extraAmount, extraTerms);
    }

    /// @notice Исполнитель принимает extra → добавляется к итоговому payout.
    function acceptExtra(uint256 extraId) external {
        address sender = _msgSender();
        if (sender != executor) revert NotExecutor();
        if (_finalized) revert AlreadyFinalized();
        Extra storage e = extras[extraId];
        if (e.status != ExtraStatus.PENDING) revert ExtraNotPending();

        e.status = ExtraStatus.ACCEPTED;
        pendingExtrasTotal -= e.amount;
        extrasTotal += e.amount;

        emit ExtraAccepted(extraId, extrasTotal);
    }

    /// @notice Исполнитель отклоняет extra → USDC возвращается клиенту.
    function rejectExtra(uint256 extraId) external nonReentrant {
        address sender = _msgSender();
        if (sender != executor) revert NotExecutor();
        if (_finalized) revert AlreadyFinalized();
        Extra storage e = extras[extraId];
        if (e.status != ExtraStatus.PENDING) revert ExtraNotPending();

        uint256 refund = e.amount;
        e.status = ExtraStatus.REJECTED;
        pendingExtrasTotal -= refund;

        usdc.safeTransfer(client, refund);

        emit ExtraRejected(extraId);
    }

    function getExtra(uint256 extraId) external view returns (Extra memory) {
        return extras[extraId];
    }

    function totalPayout() external view returns (uint256) {
        return amount + extrasTotal;
    }

    // -------- VIEW --------

    function getDetails() external view returns (
        address client_,
        address executor_,
        address arbiter_,
        uint256 amount_,
        string  memory terms_,
        uint256 deadlineDays_,
        uint256 fundedAt_,
        uint256 activatedAt_,
        uint256 markedDoneAt_,
        uint256 disputedAt_,
        uint256 resolvedAt_,
        Status  status_
    ) {
        client_       = client;
        executor_     = executor;
        arbiter_      = arbiter;
        amount_       = amount;
        terms_        = terms;
        deadlineDays_ = deadlineDays;
        fundedAt_     = fundedAt;
        activatedAt_  = activatedAt;
        markedDoneAt_ = markedDoneAt;
        disputedAt_   = disputedAt;
        resolvedAt_   = resolvedAt;
        status_       = status();
    }

    /// @notice Сколько времени осталось до дедлайна (0 если прошёл)
    function timeLeft() external view returns (uint256) {
        if (activatedAt == 0) return 0;
        uint256 deadline = activatedAt + (deadlineDays * 1 days);
        if (block.timestamp >= deadline) return 0;
        return deadline - block.timestamp;
    }

    /// @notice Сколько времени осталось арбитру (0 если не в споре или прошёл)
    function arbiterTimeLeft() external view returns (uint256) {
        if (disputedAt == 0) return 0;
        uint256 deadline = disputedAt + DISPUTE_WINDOW;
        if (block.timestamp >= deadline) return 0;
        return deadline - block.timestamp;
    }

    // -------- NFT METADATA --------

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(
            (tokenId == TOKEN_ID || tokenId == EXECUTOR_TOKEN_ID) && _exists(tokenId),
            "Agreement: token not exists"
        );
        Status s = status();
        string memory img = string(abi.encodePacked(
            "data:image/svg+xml;base64,",
            _base64Encode(bytes(_buildSVG(s)))
        ));
        return string(abi.encodePacked(
            'data:application/json;utf8,{"name":"HSEAL Deal ',
            _shortAddr(address(this)),
            '","description":"Escrow: ',
            _shortAddr(client), ' -> ', _shortAddr(executor),
            '","image":"', img,
            '","attributes":[', _buildAttrs(s), ']}'
        ));
    }

    function _buildAttrs(Status s) private view returns (string memory) {
        return string(abi.encodePacked(
            '{"trait_type":"Status","value":"',       _statusStr(s),           '"},'
            '{"trait_type":"Amount USDC","value":"',   _uint2str(amount / 1e6), '"},'
            '{"trait_type":"Deadline Days","value":"', _uint2str(deadlineDays), '"},'
            '{"trait_type":"Client","value":"',        _toHex(client),          '"},'
            '{"trait_type":"Executor","value":"',      _toHex(executor),        '"},'
            '{"trait_type":"Arbiter","value":"',       _toHex(arbiter),         '"},'
            '{"trait_type":"Terms","value":"',          _truncateStr(terms, 200),     '"}'
        ));
    }

    function _buildSVG(Status s) private view returns (string memory) {
        string memory col = _statusColor(s);
        string memory st  = _statusStr(s);
        return string(abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="520" viewBox="0 0 400 520">',
            '<rect width="400" height="520" fill="#0d0d0d"/>',
            '<rect x="0" y="0" width="400" height="3" fill="', col, '"/>',
            '<text x="32" y="44" font-family="monospace" font-size="11" fill="#555" letter-spacing="2">DEAL AGREEMENT</text>',
            '<text x="368" y="44" font-family="monospace" font-size="11" fill="#333" text-anchor="end">HSEAL</text>',
            '<text x="32" y="66" font-family="monospace" font-size="11" fill="#444">', _shortAddr(address(this)), '</text>',
            _buildSVGStatus(col, st),
            _buildSVGData(),
            _buildSVGFooter()
        ));
    }

    function _buildSVGStatus(string memory col, string memory st) private pure returns (string memory) {
        return string(abi.encodePacked(
            '<line x1="32" y1="82" x2="368" y2="82" stroke="#1e1e1e" stroke-width="1"/>',
            '<rect x="32" y="94" width="336" height="36" rx="4" fill="', col, '" fill-opacity="0.12"/>',
            '<rect x="32" y="94" width="3" height="36" rx="1" fill="', col, '"/>',
            '<text x="46" y="117" font-family="monospace" font-size="14" fill="', col, '" font-weight="bold">', st, '</text>',
            '<line x1="32" y1="144" x2="368" y2="144" stroke="#1e1e1e" stroke-width="1"/>'
        ));
    }

    function _buildSVGData() private view returns (string memory) {
        return string(abi.encodePacked(
            '<text x="32"  y="164" font-family="monospace" font-size="9" fill="#555" letter-spacing="1">AMOUNT</text>',
            '<text x="200" y="164" font-family="monospace" font-size="9" fill="#555" letter-spacing="1">DEADLINE</text>',
            '<text x="32"  y="183" font-family="monospace" font-size="13" fill="#fff">', _formatUSDC(amount), '</text>',
            '<text x="200" y="183" font-family="monospace" font-size="13" fill="#fff">', _uint2str(deadlineDays), ' days</text>',
            '<line x1="32" y1="200" x2="368" y2="200" stroke="#1e1e1e" stroke-width="1"/>',
            '<text x="32" y="222" font-family="monospace" font-size="9" fill="#555" letter-spacing="1">CLIENT</text>',
            '<text x="32" y="240" font-family="monospace" font-size="12" fill="#ccc">', _shortAddr(client), '</text>',
            '<text x="32" y="268" font-family="monospace" font-size="9" fill="#555" letter-spacing="1">EXECUTOR</text>',
            '<text x="32" y="286" font-family="monospace" font-size="12" fill="#ccc">', _shortAddr(executor), '</text>',
            '<line x1="32" y1="304" x2="368" y2="304" stroke="#1e1e1e" stroke-width="1"/>',
            '<text x="32" y="326" font-family="monospace" font-size="9" fill="#555" letter-spacing="1">TERMS</text>',
            '<text x="32" y="344" font-family="monospace" font-size="10" fill="#555">', _truncateStr(terms, 48), '</text>'
        ));
    }

    function _buildSVGFooter() private pure returns (string memory) {
        return string(abi.encodePacked(
            '<line x1="32" y1="396" x2="368" y2="396" stroke="#1a1a1a" stroke-width="1"/>',
            '<text x="200" y="428" font-family="monospace" font-size="9" fill="#333" text-anchor="middle">SOULBOUND  *  Burns on completion</text>',
            '<text x="200" y="448" font-family="monospace" font-size="9" fill="#333" text-anchor="middle">hexseal.com</text>',
            '</svg>'
        ));
    }

    function _statusColor(Status s) private pure returns (string memory) {
        if (s == Status.FUNDED)    return "#3b82f6";
        if (s == Status.ACTIVE)    return "#22c55e";
        if (s == Status.DISPUTED)  return "#ef4444";
        if (s == Status.COMPLETED) return "#6b7280";
        if (s == Status.RESOLVED)  return "#8b5cf6";
        if (s == Status.REFUNDED)  return "#f59e0b";
        return "#6b7280";
    }

    function _shortAddr(address addr) private pure returns (string memory) {
        bytes memory full = bytes(_toHex(addr)); // "0x" + 40 hex chars = 42 total
        bytes memory r = new bytes(13);          // "0xABCD...abcd"
        r[0] = full[0]; r[1] = full[1];
        r[2] = full[2]; r[3] = full[3]; r[4] = full[4]; r[5] = full[5];
        r[6] = '.'; r[7] = '.'; r[8] = '.';
        r[9] = full[38]; r[10] = full[39]; r[11] = full[40]; r[12] = full[41];
        return string(r);
    }

    function _formatUSDC(uint256 raw) private pure returns (string memory) {
        uint256 whole = raw / 1_000_000;
        uint256 frac  = (raw % 1_000_000) / 10_000;
        string memory f = frac == 0 ? "00"
            : frac < 10 ? string(abi.encodePacked("0", _uint2str(frac)))
            : _uint2str(frac);
        return string(abi.encodePacked(_uint2str(whole), ".", f, " USDC"));
    }

    function _truncateStr(string memory s, uint256 maxLen) private pure returns (string memory) {
        bytes memory b = bytes(s);
        if (b.length <= maxLen) return s;
        bytes memory r = new bytes(maxLen + 3);
        for (uint256 i = 0; i < maxLen; i++) r[i] = b[i];
        r[maxLen] = '.'; r[maxLen + 1] = '.'; r[maxLen + 2] = '.';
        return string(r);
    }

    function _base64Encode(bytes memory data) private pure returns (string memory) {
        bytes memory T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        uint256 len = data.length;
        if (len == 0) return "";
        uint256 outLen = 4 * ((len + 2) / 3);
        bytes memory result = new bytes(outLen);
        uint256 ri = 0;
        for (uint256 i = 0; i < len;) {
            uint256 a  = uint8(data[i]); i++;
            uint256 b2 = i < len ? uint8(data[i]) : 0; if (i < len) i++;
            uint256 c  = i < len ? uint8(data[i]) : 0; if (i < len) i++;
            uint256 buf = (a << 16) | (b2 << 8) | c;
            result[ri++] = T[buf >> 18];
            result[ri++] = T[(buf >> 12) & 63];
            result[ri++] = T[(buf >>  6) & 63];
            result[ri++] = T[buf         & 63];
        }
        if (len % 3 == 1) { result[outLen - 1] = '='; result[outLen - 2] = '='; }
        else if (len % 3 == 2) { result[outLen - 1] = '='; }
        return string(result);
    }

    // -------- INTERNAL --------

    /// @notice Рефанд всех ожидающих extras клиенту. Вызывается до финализации сделки.
    function _settlePending() private {
        uint256 pending = pendingExtrasTotal;
        if (pending > 0) {
            pendingExtrasTotal = 0;
            usdc.safeTransfer(client, pending);
        }
    }

    function _complete(Status newStatus) private {
        if (_finalized) revert AlreadyFinalized();
        _finalized = true;

        // Обновляем Registry через Diamond
        ISignatureRegistry.AgreementStatus regStatus;
        if (newStatus == Status.COMPLETED) regStatus = ISignatureRegistry.AgreementStatus.COMPLETED;
        else if (newStatus == Status.RESOLVED) regStatus = ISignatureRegistry.AgreementStatus.RESOLVED;
        else regStatus = ISignatureRegistry.AgreementStatus.REFUNDED;

        _updateRegistry(regStatus);

        // Автоматически начисляем XP обеим сторонам при успешном завершении
        if (newStatus == Status.COMPLETED || newStatus == Status.RESOLVED) {
            try IReputationFacet(diamond).autoAwardXP(address(this)) {} catch {}
        }

        // Сжигаем оба NFT в одной операции
        if (_exists(TOKEN_ID))          _burn(TOKEN_ID);
        if (_exists(EXECUTOR_TOKEN_ID)) _burn(EXECUTOR_TOKEN_ID);
    }

    function _updateRegistry(ISignatureRegistry.AgreementStatus regStatus) private {
        try ISignatureRegistry(diamond).updateStatus(address(this), regStatus) {} catch {
            // Деньги важнее Registry — сделка завершается в любом случае.
            // Событие позволяет мониторить рассинхрон и вызвать syncRegistry() для починки.
            emit RegistrySyncFailed(address(this), uint8(regStatus));
        }
    }

    /// @notice Повторная синхронизация статуса с Registry.
    /// Нужна если _updateRegistry() упал (видно по событию RegistrySyncFailed).
    /// Вычисляет актуальный статус из состояния Agreement — аргументы не нужны.
    /// Может вызвать любой.
    function syncRegistry() external {
        Status s = status();
        ISignatureRegistry.AgreementStatus regStatus;
        if (s == Status.COMPLETED) regStatus = ISignatureRegistry.AgreementStatus.COMPLETED;
        else if (s == Status.RESOLVED)  regStatus = ISignatureRegistry.AgreementStatus.RESOLVED;
        else if (s == Status.REFUNDED)  regStatus = ISignatureRegistry.AgreementStatus.REFUNDED;
        else if (s == Status.DISPUTED)  regStatus = ISignatureRegistry.AgreementStatus.DISPUTED;
        else                            regStatus = ISignatureRegistry.AgreementStatus.ACTIVE;
        ISignatureRegistry(diamond).updateStatus(address(this), regStatus);
    }

    function _clearDisputeClaim() private {
        // Non-blocking: не останавливаем завершение сделки если ArbiterRegistry недоступен
        try IArbiterRegistry(diamond).clearDisputeClaim(address(this)) {} catch {}
    }

    // -------- STRING UTILS --------

    function _statusStr(Status s) private pure returns (string memory) {
        if (s == Status.CREATED)   return "CREATED";
        if (s == Status.FUNDED)    return "FUNDED";
        if (s == Status.ACTIVE)    return "ACTIVE";
        if (s == Status.COMPLETED) return "COMPLETED";
        if (s == Status.DISPUTED)  return "DISPUTED";
        if (s == Status.RESOLVED)  return "RESOLVED";
        return "REFUNDED";
    }

    function _uint2str(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 temp = v;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buf = new bytes(digits);
        while (v != 0) { digits--; buf[digits] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(buf);
    }

    function _toHex(address addr) private pure returns (string memory) {
        bytes memory b = abi.encodePacked(addr);
        bytes memory hex_ = new bytes(42);
        hex_[0] = '0'; hex_[1] = 'x';
        for (uint256 i = 0; i < 20; i++) {
            hex_[2 + i * 2]     = _hexChar(uint8(b[i]) >> 4);
            hex_[3 + i * 2]     = _hexChar(uint8(b[i]) & 0xf);
        }
        return string(hex_);
    }

    function _bytes32Hex(bytes32 b) private pure returns (string memory) {
        bytes memory hex_ = new bytes(64);
        for (uint256 i = 0; i < 32; i++) {
            hex_[i * 2]     = _hexChar(uint8(b[i]) >> 4);
            hex_[i * 2 + 1] = _hexChar(uint8(b[i]) & 0xf);
        }
        return string(hex_);
    }

    function _hexChar(uint8 v) private pure returns (bytes1) {
        return v < 10 ? bytes1(v + 48) : bytes1(v + 87);
    }
}
