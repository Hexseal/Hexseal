// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

// ============================================================
// HEXSEAL — Agreement.sol
//
// Один контракт = одна сделка = один NFT
// Иммутабелен после деплоя — как юридический договор
// ERC-2771 gasless для всех действий сторон
// Soulbound NFT пока сделка активна
// Арбитр = мультисиг протокола (не рандомный человек)
// Если вердикта нет за DISPUTE_WINDOW: спор, за который никто не брался,
// делится пополам; спор, который забрали и не довели, возвращается клиенту
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

    // Одинаковы у каждой сделки — держим константами, а не в хранилище
    // каждого клона: две строки в storage стоили бы по холодному SSTORE
    // на инициализацию и ничего не давали бы взамен.
    string private constant _NAME   = "Hexseal Deal";
    string private constant _SYMBOL = "HSEAL";

    // ---- Events (ERC721 стандарт) ----
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    // ---- Errors ----
    error ERC721NonexistentToken(uint256 tokenId);
    error ERC721NotOwnerOrApproved();
    error ERC721NotAuthorized();
    error ERC721WrongOwner();
    error ERC721TransferToZeroAddress();
    error ERC721AlreadyMinted();
    error TokenSoulbound(); // soulbound — нельзя передать пока ACTIVE

    function name() external pure returns (string memory) { return _NAME; }
    function symbol() external pure returns (string memory) { return _SYMBOL; }

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
        if (msg.sender != owner && !_operatorApprovals[owner][msg.sender]) revert ERC721NotAuthorized();
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
        if (owner != from) revert ERC721WrongOwner();
        if (msg.sender != owner && _tokenApprovals[tokenId] != msg.sender && !_operatorApprovals[owner][msg.sender])
            revert ERC721NotAuthorized();
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

    error Reentrancy();

    // Вызывается из Agreement.initialize(). Корректности ради это не нужно:
    // модификатор сравнивает только с ENTERED, поэтому свежий клон со
    // _status == 0 ведёт себя правильно, а инициализация даже добавляет
    // ~2 900 газа. Ставим ради устойчивости: без неё корректность зависит
    // от точной формы сравнения, и переписывание модификатора в стиль
    // `if (_status != NOT_ENTERED) revert` тихо сломало бы каждый клон.
    function _initReentrancyGuard() internal {
        _status = NOT_ENTERED;
    }

    modifier nonReentrant() {
        if (_status == ENTERED) revert Reentrancy();
        _status = ENTERED;
        _;
        _status = NOT_ENTERED;
    }
}

// ---------- ERC-2771 CONTEXT (gasless) ----------
// Trusted forwarder передаёт реальный msg.sender в конце calldata

abstract contract ERC2771Context {
    // Не immutable: у каждого клона свой форвардер приходит из initialize(),
    // а immutable живёт в коде реализации, общем для всех клонов.
    address private _trustedForwarder;

    function _initTrustedForwarder(address trustedForwarder_) internal {
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
    error TransferFailed();

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0xa9059cbb, to, amount) // transfer(address,uint256)
        );
        if (!(success && (data.length == 0 || abi.decode(data, (bool))))) revert TransferFailed();
    }

    /// То же, что safeTransfer, но возвращает признак вместо реверта. Нужен
    /// там, где провал одного перевода не должен ронять всю выплату.
    ///
    /// Длину ответа проверяем явно: abi.decode на 1..31 байте сам ревертит, и
    /// тогда «мягкий» перевод оказался бы таким же жёстким, как обычный.
    function trySafeTransfer(address token, address to, uint256 amount) internal returns (bool) {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0xa9059cbb, to, amount) // transfer(address,uint256)
        );
        if (!success) return false;
        if (data.length == 0) return true;
        if (data.length < 32) return false;
        return abi.decode(data, (bool));
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0x23b872dd, from, to, amount) // transferFrom
        );
        if (!(success && (data.length == 0 || abi.decode(data, (bool))))) revert TransferFailed();
    }
}

// ---------- MINIMAL ERC20 INTERFACE ----------

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

interface IReputationFacet {
    function autoAwardXP(address agreement) external;
    function notifyExecutorFault(address agreement) external;
}

interface IArbiterRegistryFacet {
    function notifyArbiterTimeout(address agreement) external;
    function hasSubmittedVerdict(address agreement) external view returns (bool);
    function creditDisputeFee(uint256 total) external;
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

    // Сбор арбитра со спора. Границы НЕТ намеренно: граница в $5 кусалась бы до
    // сделки в $167, то есть на всей мелкой и средней работе, а на $10 съедала
    // бы половину котла. Обоснование — спека расчёта по спору §2.
    uint256 public constant DISPUTE_FEE_BPS = 300;          // 3% от котла
    uint256 public constant DISPUTE_FEE_CAP = 500_000_000;  // $500 (6 decimals)

    // -------- DIAMOND VIEW BUDGET --------
    //
    // Gas handed to the one diamond view that stands in FRONT of the money
    // (hasSubmittedVerdict, read by triggerArbiterTimeout). Measured cost of
    // that read through the proxy with every slot cold -- diamond account,
    // facet-address slot, facet account, verdict slot -- is 11_064 gas
    // (test/DiamondDeathEscrow.t.sol::testVerdictViewCostSitsFarUnderTheCap).
    // The cap is ~9x that, and it is the same number Treasury already uses for
    // the same class of read (Treasury.DIAMOND_VIEW_GAS).
    //
    // Why a cap at all: try/catch turns a revert into a caught failure, but it
    // cannot give back gas the callee already burned. A facet stuck in an
    // unbounded loop eats 63/64 of whatever it is offered, and an uncapped
    // read in front of a payout hands it almost the whole transaction. The cap
    // bounds that loss to a fixed, known amount.
    uint256 private constant VERDICT_VIEW_GAS = 100_000;

    // Floor on gasleft() before that read is attempted.
    //
    // EIP-150 forwards min(cap, gasleft - gasleft/64), so a caller who hand-
    // picks a small gas limit could make the read run out of gas while the
    // rest of the call still fits. Since a failed read is read as "no verdict
    // was submitted" (see _verdictInFlight), that would turn deliberate gas
    // starvation into a way to force a refund past a live verdict on a
    // perfectly healthy diamond -- the exact thing the check exists to stop.
    //
    // So: unless gasleft() is enough to hand over the FULL cap, the whole
    // transaction reverts. Failure of the read then means a genuinely broken
    // diamond, never a starved one.
    //
    // cap * 64/63 is the smallest gasleft that still forwards the full cap
    // (x - x/64 >= cap); the 8_000 on top covers what is spent between the
    // check and the CALL opcode itself (cold account access, memory, the
    // surrounding opcodes).
    uint256 private constant VERDICT_VIEW_GAS_FLOOR =
        VERDICT_VIEW_GAS + VERDICT_VIEW_GAS / 63 + 8_000;

    // -------- DIAMOND WRITE BUDGETS --------
    //
    // The cap above covers the one diamond VIEW that stands in front of the
    // money. Everything below covers the diamond WRITES, and they are the
    // expensive half: _complete() makes two of them in a row before every
    // payout, which is what let a gas-eating facet inflate auto-approve from
    // ~419_481 gas to ~29_791_258 -- 71x -- with try/catch powerless to stop
    // it (docs/audits/2026-08-22-diamond-death-escrow.md, section 4).
    //
    // Each number was MEASURED against the real facets through the real proxy
    // with every slot cold, and is re-measured on every run by
    // test/DiamondDeathGasCaps.t.sol section 14. The multiplier is the headroom
    // over that measurement:
    //
    //   updateStatus          58_521 -> 150_000  (2.5x)
    //   autoAwardXP          332_268 -> 500_000  (1.5x)
    //   creditDisputeFee      56_696 -> 150_000  (2.6x)
    //   notifyExecutorFault   14_298 -> 100_000  (6.9x)
    //   notifyArbiterTimeout  31_814 -> 150_000  (4.7x)
    //   clearDisputeClaim     74_746 -> 200_000  (2.6x)
    //
    // autoAwardXP gets the thinnest headroom on purpose. Its floor (below) is
    // what a caller must be able to hand over, so the cap sets the minimum gas
    // limit for release/triggerAutoApprove -- the two most ordinary actions in
    // the product. 500_000 is the largest cap that still fits under the gas
    // ceilings the frontend already ships (frontend/src/lib/relay.ts,
    // GAS_DEFAULTS: release and triggerAutoApprove are 660_000 each). The
    // function is O(1) with no loop anywhere in its call tree, so 167_732 gas
    // of slack is about seven more cold SSTOREs than it has ever needed.
    uint256 private constant REGISTRY_UPDATE_GAS = 150_000;
    uint256 private constant XP_AWARD_GAS        = 500_000;
    uint256 private constant DISPUTE_FEE_GAS     = 150_000;
    uint256 private constant FAULT_NOTIFY_GAS    = 100_000;
    uint256 private constant ARBITER_TIMEOUT_GAS = 150_000;
    uint256 private constant CLAIM_CLEAR_GAS     = 200_000;

    // Spent between the gasleft() check and the CALL opcode itself: cold
    // account access, memory for the calldata, the surrounding opcodes. Same
    // 8_000 the verdict floor above uses, for the same reason.
    uint256 private constant DIAMOND_CALL_GAS_SLACK = 8_000;

    // -------- DEAL PARAMS (пишутся один раз в initialize) --------
    //
    // Не immutable: значения различны у каждого клона, а immutable живёт
    // в коде реализации, одном на всех. Порядок объявления — это раскладка
    // хранилища прокси, и после первого живого клона она заморожена:
    // менять можно только дописыванием в конец (см. script/check-agreement-layout.sh).

    address public client;          // заказчик
    bool    private _initialized;   // делит слот с client — отдельного SSTORE не стоит
    address public executor;        // исполнитель
    /// address(0) — штатное значение: арбитр не назначен, пока нет спора.
    /// Поэтому initialize намеренно не проверяет arbiter_ на ноль,
    /// хотя Slither и помечает это как missing-zero-check.
    address public arbiter;         // арбитр (address(0) до клейма; setArbiter вызывает Diamond)
    uint256 public amount;          // сумма сделки USDC (6 decimals)
    uint256 public deadlineDays;    // дней до авторефанда
    string  public terms;           // условия сделки
    address public usdc;            // USDC на Base
    address public diamond;         // Diamond proxy = Registry
    address public factory;         // FactoryFacet address (for fundFromFactory)

    // -------- STATE --------

    uint256 public fundedAt;      // когда клиент задепонировал
    uint256 public activatedAt;   // когда исполнитель подтвердил старт
    uint256 public markedDoneAt;  // когда исполнитель отметил выполнение
    uint256 public disputedAt;    // когда поднят спор
    uint256 public resolvedAt;    // когда арбитр резолвил
    bool    public clientWonDispute; // итог арбитража — читается ReputationFacet при начислении/списании XP (валидно только когда resolvedAt > 0)

    // Флаг финализации — предотвращает двойное завершение при гонке resolveDispute / triggerArbiterTimeout
    bool    private _finalized;
    Status  private _finalStatus;

    // Extras: доп оплата за переделки/доп работу (клиент предлагает → исполнитель принимает)
    mapping(uint256 => Extra) public extras;
    uint256 public nextExtraId;
    uint256 public extrasTotal;         // сумма принятых extras → исполнителю при release
    uint256 public pendingExtrasTotal;  // сумма ожидающих extras → рефанд клиенту при закрытии

    // -------- ЯВКА В СПОРЕ --------

    /// Кто из сторон отметился в споре. Ставятся один раз и не снимаются.
    /// `raiseDispute` ставит флаг поднявшему — поднял, значит явился;
    /// `respondToDispute` ставит флаг второму.
    ///
    /// Читаются ровно в одном месте: ветка `triggerArbiterTimeout`, где спор
    /// никто не заклеймил. Молчавший получает четверть котла вместо половины.
    ///
    /// Дописаны В КОНЕЦ раскладки (слот 25) осознанно: клоны EIP-1167
    /// разделяют раскладку реализации, поэтому порядок и типы существующих
    /// полей менять нельзя — см. script/check-agreement-layout.sh.
    bool public clientResponded;
    bool public executorResponded;

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
    event DisputeFeePaid(uint256 amount);
    /// Зачисление сбора провалилось — спор всё равно закрыт, сбор не взят.
    event DisputeFeeSkipped(uint256 amount);
    event TimedOut(address indexed client, uint256 amount);
    event ArbiterTimedOut(address indexed client, uint256 amount);
    /// Спор закрыт без вердикта, потому что за него никто не брался.
    /// toExecutor равен нулю, если его половину доставить не удалось.
    event DisputeSplitNoVerdict(uint256 toClient, uint256 toExecutor);
    event DisputeResponded(address indexed party);
    /// Таймаут при незаклеймленном споре, когда одна сторона молчала.
    /// Форма отличается от DisputeSplitNoVerdict осознанно: явившимся может
    /// быть любая из сторон, поэтому получатель указан адресом, а не позицией.
    event DisputeUnanswered(address indexed responder, uint256 toResponder, uint256 toSilent);
    event ExtraProposed(uint256 indexed extraId, address indexed client, uint256 amount, string terms);
    event ExtraAccepted(uint256 indexed extraId, uint256 newTotal);
    event ExtraRejected(uint256 indexed extraId);
    // Срабатывает если Registry.updateStatus() упал — сделка завершена, статус в Registry рассинхронизирован.
    // Любой может вызвать syncRegistry() чтобы исправить.
    event RegistrySyncFailed(address indexed agreement, uint8 targetStatus);
    // Fires when autoAwardXP() did not land -- unreachable diamond, reverting
    // facet, or a facet that ate its whole gas cap. Before this event the XP
    // simply went missing with nothing on-chain to say so. claimXP() on the
    // diamond is the manual way back for both parties.
    event XpAwardFailed(address indexed agreement);

    // -------- ERRORS --------

    error ZeroAddress();
    error ClientEqualsExecutor();
    error NotDiamond();
    error ArbiterIsParty();
    error ArbiterNotRegistered();
    error InsufficientBalance();
    error NotClient();
    error NotFactory();
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
    error VerdictInFlight();
    /// Raised when triggerArbiterTimeout is called with too little gas to hand
    /// the verdict read its full budget. See VERDICT_VIEW_GAS_FLOOR.
    error NotEnoughGasForVerdictCheck();
    /// Raised when a diamond call whose failure would quietly cost someone
    /// something is reached with too little gas to hand over its full cap.
    /// Only the calls that CAN be starved for profit carry this; see
    /// _requireDiamondGas.
    ///
    /// The argument is the selector of the call that was refused. Two
    /// different calls are floored, they sit on the same path, and without
    /// this argument a refusal from one is indistinguishable from a refusal
    /// from the other -- both to whoever is reading the failure and to the
    /// test that is supposed to notice if one of the floors disappears.
    error NotEnoughGasForDiamondCall(bytes4 diamondCall);
    error NoArbiterSet();
    error WrongAmount();
    error ExtraNotPending();
    error AlreadyResponded();
    error ZeroAmount();
    error AlreadyInitialized();

    // -------- CONSTRUCTOR (только для контракта-реализации) --------

    /// Запирает саму реализацию: у неё собственное хранилище, и без этого
    /// посторонний вызвал бы на ней initialize() и стал бы её «клиентом».
    /// Клонов это не касается — у каждого хранилище своё и пустое.
    constructor() {
        _initialized = true;
    }

    // -------- INITIALIZER (вызывается на клоне) --------

    /// @notice Инициализация клона. Вызывается ровно один раз.
    ///
    /// Отдельной проверки вызывающего нет намеренно: AgreementDeployer
    /// делает Clones.clone() и initialize() в ОДНОЙ транзакции, поэтому
    /// неинициализированный клон не существует ни в одном блоке и
    /// перехватывать нечего. Страж ниже закрывает повторный вызов.
    function initialize(
        address client_,
        address executor_,
        address arbiter_,
        uint256 amount_,
        uint256 deadlineDays_,
        string  calldata terms_,
        address diamond_,
        address usdc_,
        address trustedForwarder_,
        address factory_
    ) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;

        if (client_   == address(0)) revert ZeroAddress();
        if (executor_ == address(0)) revert ZeroAddress();
        if (diamond_  == address(0)) revert ZeroAddress();
        if (usdc_     == address(0)) revert ZeroAddress();
        if (factory_  == address(0)) revert ZeroAddress();
        if (amount_      == 0) revert ZeroAmount();
        if (deadlineDays_ == 0) revert ZeroAmount();
        if (client_ == executor_) revert ClientEqualsExecutor();

        client       = client_;
        executor     = executor_;
        arbiter      = arbiter_;
        amount       = amount_;
        deadlineDays = deadlineDays_;
        terms        = terms_;
        diamond      = diamond_;
        usdc         = usdc_;
        factory      = factory_;

        _initTrustedForwarder(trustedForwarder_);
        _initReentrancyGuard();
    }

    // -------- ARBITER REGISTRY --------

    /// @notice Diamond (ArbiterRegistryFacet) устанавливает арбитра при клейме спора.
    /// Только Diamond может вызвать — проверяем msg.sender напрямую (не ERC-2771).
    function setArbiter(address newArbiter) external {
        if (msg.sender != diamond) revert NotDiamond();
        // Diamond сам может быть арбитром (Diamond-as-arbiter паттерн) — пропускаем проверку реестра
        if (newArbiter != address(0) && newArbiter != diamond) {
            if (newArbiter == client || newArbiter == executor) revert ArbiterIsParty();
            (bool ok, bytes memory data) = diamond.staticcall(
                abi.encodeWithSignature("isRegisteredArbiter(address)", newArbiter)
            );
            if (!ok || !abi.decode(data, (bool))) revert ArbiterNotRegistered();
        }
        arbiter = newArbiter;
    }

    // -------- STATUS VIEW --------

    function status() public view returns (Status) {
        if (_finalized)       return _finalStatus;
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

    /// @notice Сколько возьмёт разбирательство спора. Публичная, потому что фронт
    /// показывает эту сумму ДО открытия спора: сегодня пользователь узнаёт про
    /// сбор только когда деньги пришли меньше ожидаемого.
    function disputeFee() public view returns (uint256) {
        uint256 pot = amount + extrasTotal;
        uint256 fee = (pot * DISPUTE_FEE_BPS) / 10_000;
        return fee > DISPUTE_FEE_CAP ? DISPUTE_FEE_CAP : fee;
    }

    // -------- SOULBOUND --------

    // Полностью non-transferable: NFT больше не сжигается по завершении и
    // остаётся постоянным сертификатом сделки — передавать/продавать его нельзя
    // ни во время сделки, ни после.
    function _beforeTransfer(address from, address /*to*/, uint256 /*tokenId*/) internal pure override {
        if (from == address(0)) return; // mint разрешён
        revert TokenSoulbound();
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
        if (msg.sender != factory) revert NotFactory();
        if (fundedAt != 0) revert AlreadyFunded();

        // Verify USDC balance is sufficient
        uint256 balance = IERC20(usdc).balanceOf(address(this));
        if (balance < amount) revert InsufficientBalance();

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
        if (_finalized) revert AlreadyFinalized();
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

        // Поднял — значит явился. Второй стороне остаётся respondToDispute;
        // если она промолчит всё окно, таймаут отдаст ей четверть вместо
        // половины.
        if (sender == client) {
            clientResponded = true;
        } else {
            executorResponded = true;
        }

        _updateRegistry(ISignatureRegistry.AgreementStatus.DISPUTED);

        emit DisputeRaised(sender);
    }

    /// @notice Сторона отмечается, что явилась в спор.
    ///
    /// Явка ничего не утверждает по существу — доказательства живут в чате,
    /// контракту нужен только факт присутствия. Читается ровно одной веткой
    /// таймаута: если спор никто не заклеймил, молчавший получает четверть
    /// котла вместо половины.
    ///
    /// Бесплатно и гейслесс намеренно. Плата за право защищаться перевернула бы
    /// стимулы: грифер поднимает спор бесплатно, а тот, кого он грабит, должен
    /// был бы доплатить за возможность возразить. Спам режется структурой —
    /// звать может только сторона конкретного спорного агримента, флаг ставится
    /// один раз, повторный вызов ревертит.
    function respondToDispute() external {
        address sender = _msgSender();
        if (sender != client && sender != executor) revert NotParty();
        if (disputedAt == 0) revert NotDisputed();
        // _finalized проверяется отдельно от resolvedAt: после таймаута сделка
        // финализирована, а resolvedAt остаётся нулём — его ставит только
        // resolveDispute. Без этой проверки можно было бы «явиться» в закрытую.
        if (_finalized) revert AlreadyFinalized();
        if (resolvedAt != 0) revert AlreadyResolved();
        // Гейт по окну — не формальность. Без него молчавшая сторона видит
        // транзакцию таймаута в мемпуле, успевает откликнуться перед ней и
        // отменяет наказание уже после того, как оно наступило.
        if (block.timestamp > disputedAt + DISPUTE_WINDOW) revert WindowAlreadyPassed();

        if (sender == client) {
            if (clientResponded) revert AlreadyResponded();
            clientResponded = true;
        } else {
            if (executorResponded) revert AlreadyResponded();
            executorResponded = true;
        }

        emit DisputeResponded(sender);
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

        // Тайминг DISPUTE_WINDOW теперь проверяется один раз, в момент подачи вердикта
        // (ArbiterRegistryFacet.submitVerdict) — не здесь. Исполнение (через finalizeVerdict
        // или после апелляции) легитимно происходит позже, чем сама подача.
        resolvedAt = block.timestamp;
        clientWonDispute = clientWins;

        _settlePending();
        uint256 pot = amount + extrasTotal;

        // Провал зачисления ТЕРПИМ: иначе сломанный или снятый на диамонде
        // селектор сделал бы спор незакрываемым, а деньги встали бы в эскроу
        // навсегда. Ровно этот отказ уже наблюдался на живом диамонде, когда
        // казна не могла позвать fundVault.
        //
        // Разрешения (approve) в этой схеме не выдаётся вообще, поэтому
        // висящего разрешения при провале не остаётся — в казне такой дефект
        // приходилось чинить отдельно.
        uint256 fee = disputeFee();
        uint256 taken = 0;
        // При DISPUTE_FEE_BPS = 300 (3%) сбор ВСЕГДА строго меньше котла:
        // floor(pot * 300 / 10_000) < pot для любого pot >= 1, а DISPUTE_FEE_CAP
        // только уменьшает fee, никогда не увеличивает. Раньше здесь стояла
        // вторая половина условия (`&& fee < pot`) — непомеченная недостижимая
        // ветка на денежном пути: ни один из 391 теста не ловил её ни в одну
        // сторону (мутационная проверка нашла это). Инвариант закреплён
        // статически — testDisputeFeeBpsIsBelowOneHundredPercent в
        // test/DisputeSettlement.t.sol — вместо рантайм-ветки, которую
        // невозможно протестировать: срабатывание означало бы BPS >= 10_000,
        // то есть катастрофу конфигурации, а не смену ставки, и молчаливый
        // пропуск сбора эту ошибку замаскировал бы, а не смягчил.
        if (fee > 0 && !_diamondHasCode()) {
            // No code at the diamond address: the credit cannot happen, and
            // trying would revert in this frame (see _diamondHasCode), taking
            // the payout below with it. Treated exactly like a failed credit.
            emit DisputeFeeSkipped(fee);
        } else if (fee > 0) {
            // Зачисляем ПЕРВЫМ, переводим только при успехе.
            //
            // Обратный порядок выглядит естественнее и был в первой редакции
            // плана: «зачисление требует, чтобы деньги уже пришли». Это
            // неправда — creditDisputeFee не проверяет баланс ни одной
            // строкой, а в пределах одной транзакции порядок и не важен.
            //
            // Зато цена ошибки была бы вечной: при провале зачисления деньги
            // остались бы на диамонде, откуда выхода НЕТ. Функции спасения
            // там не существует, withdrawTreasurySlice двигает только свой
            // счётчик, withdrawArbiterReward — только начисленное. Так сбор
            // сгорал бы при каждом провале.
            //
            // Провал означает «сбор не взят», а не «сбор сожжён»: перевод
            // стоит ВНУТРИ try, поэтому при неудаче creditDisputeFee ни цента
            // не покидает Agreement — вся сумма остаётся в payout ниже.
            // Floored, not merely capped. A failed credit means the fee is
            // never taken and the whole pot goes to the winner instead -- so a
            // winner who calls finalizeVerdict with a hand-picked gas limit
            // could starve this one call and keep the arbiter's 3%. The event
            // says it happened, but nothing can take it back afterwards.
            _requireDiamondGas(DISPUTE_FEE_GAS, IArbiterRegistryFacet.creditDisputeFee.selector);
            try IArbiterRegistryFacet(diamond).creditDisputeFee{gas: DISPUTE_FEE_GAS}(fee) {
                usdc.safeTransfer(diamond, fee);
                taken = fee;
                emit DisputeFeePaid(fee);
            } catch {
                emit DisputeFeeSkipped(fee);
            }
        }

        uint256 payout = pot - taken;

        _complete(Status.RESOLVED);
        usdc.safeTransfer(clientWins ? client : executor, payout);

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

        if (_diamondHasCode()) {
            try IReputationFacet(diamond).notifyExecutorFault{gas: FAULT_NOTIFY_GAS}(address(this)) {} catch {}
        }

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

        if (_diamondHasCode()) {
            try IReputationFacet(diamond).notifyExecutorFault{gas: FAULT_NOTIFY_GAS}(address(this)) {} catch {}
        }

        emit TimedOut(client, payout);
    }

    /// @notice Таймаут спора — вердикта нет за DISPUTE_WINDOW.
    /// Исход зависит от того, брался ли кто-нибудь за спор:
    ///  • никто не брался (arbiter == 0) — исход решает явка
    ///    (clientResponded/executorResponded): оба явились — котёл пополам,
    ///    DisputeSplitNoVerdict; один молчал — четверть молчавшему, остаток
    ///    явившемуся, DisputeUnanswered. Полный возврат клиенту при пустом
    ///    споре сделал бы его бесплатным способом забрать и деньги, и работу;
    ///  • брался и не довёл — всё клиенту, арбитра наказать, ArbiterTimedOut.
    ///    Пополам здесь нельзя: затягивание стало бы стратегией исполнителя.
    /// Статус в обоих случаях REFUNDED — enum расширять нельзя (раскладка
    /// заморожена, фронт и сабграф разбирают существующие значения), случаи
    /// различает событие.
    function triggerArbiterTimeout() external nonReentrant {
        address sender = _msgSender();
        if (sender != client && sender != executor) revert NotParty();
        if (disputedAt == 0) revert NotDisputed();
        if (resolvedAt != 0) revert AlreadyResolved();
        if (block.timestamp <= disputedAt + DISPUTE_WINDOW) revert WindowNotPassed();
        // Арбитр уже подал вердикт (в срок — submitVerdict это гарантирует) — таймаут не
        // для этого случая. Иначе сторона могла бы форсировать рефанд прямо во время
        // FINALIZE_DELAY/апелляции, обнуляя голосование других арбитров.
        //
        // Read through _verdictInFlight, never bare: this is the ONLY way out
        // of DISPUTED, and a bare read made an unreachable diamond mean
        // "locked forever". See that function for the whole argument.
        if (_verdictInFlight()) revert VerdictInFlight();

        _settlePending();
        uint256 pot = amount + extrasTotal;

        // Различаем два разных события, и признак бесплатный: поле arbiter
        // равно нулю, пока спор не взяли. Оно принимает ровно два значения —
        // ноль и адрес диамонда: claimDispute ставит арбитром сам диамонд, а
        // не человека, поэтому как получателя денег его использовать нельзя.
        //
        // Никто не взялся — исход решает явка, не пополам безусловно: оба
        // явились — DisputeSplitNoVerdict пополам, буквальный перевод «мы не
        // смогли решить» в деньги; один молчал — DisputeUnanswered, четверть
        // молчавшему и остаток явившемуся (подробности ниже, внутри ветки).
        // Это убирает стимул затевать пустой спор с обеих сторон.
        //
        // Взялся и не довёл — вина арбитра, а не сторон. Здесь пополам нельзя:
        // затягивание стало бы стратегией, и жулику-исполнителю на крупной
        // сделке хватило бы ничего не делать, чтобы забрать половину. При
        // возврате клиенту затягивание приносит ему ноль.
        if (arbiter == address(0)) {
            // Как делить — решает явка. Хотя бы один флаг выставлен всегда:
            // raiseDispute ставит его поднявшему, а без raiseDispute сюда не
            // попасть (disputedAt проверен выше).
            //
            // Оба явились — судить было некому, делим пополам. Это и есть
            // настоящий смысл дележа, и единственное правило, не дающее рычага
            // ни одной стороне: markDone и raiseDispute обе стороны дёргают
            // одинаково свободно и бесплатно, поэтому ни одно из этих действий
            // не может быть доказательством.
            //
            // Один молчал — четверть ему. Молчание перестаёт быть бесплатным,
            // но четыре дня вне сети не разоряют: отсутствие дело обычное,
            // наказывать его надо, разорять — нет. Заодно это снижает цену
            // атаки «подними спор и надейся, что он спит» — приз падает со
            // всего котла до трёх четвертей.
            bool both = clientResponded && executorResponded;

            uint256 toClient;
            uint256 toExecutor;
            if (both) {
                toExecutor = pot / 2;
                toClient   = pot - toExecutor;  // вычитанием: остаток тому, чьи деньги
            } else if (clientResponded) {
                toExecutor = pot / 4;           // молчал исполнитель
                toClient   = pot - toExecutor;  // вычитанием: остаток явившемуся
            } else {
                toClient   = pot / 4;           // молчал клиент
                toExecutor = pot - toClient;    // вычитанием: остаток явившемуся
            }

            _complete(Status.REFUNDED);

            // Мягкий перевод исполнителю. Это последний путь у сделки: после
            // таймаута не остаётся ни рескью-функции, ни второй попытки. Если
            // исполнитель в чёрном списке USDC, жёсткий перевод заморозил бы
            // весь котёл вместе с долей клиента — поэтому недоставленная доля
            // уходит клиенту, а транзакция доводится до конца.
            //
            // Клиентскую долю намеренно НЕ страхуем тем же приёмом: этот риск
            // одинаков на всех путях выплат и был здесь до дележа. Латать его
            // надо разом и отдельно, а не одной веткой.
            //
            // executorPaid отделён от toExecutor, чтобы события несли
            // ПЕРЕВЕДЁННЫЕ суммы, а не задуманные: интерфейс печатает их
            // дословно, и цифра, которой не пришло на кошелёк, — это ложь.
            uint256 executorPaid = toExecutor;
            if (toExecutor > 0 && !usdc.trySafeTransfer(executor, toExecutor)) {
                toClient    += toExecutor;
                executorPaid = 0;
            }
            usdc.safeTransfer(client, toClient);

            // notifyArbiterTimeout не зовём намеренно: наказывать некого.
            _clearDisputeClaim();

            if (both) {
                emit DisputeSplitNoVerdict(toClient, executorPaid);
            } else if (clientResponded) {
                emit DisputeUnanswered(client, toClient, executorPaid);
            } else {
                emit DisputeUnanswered(executor, executorPaid, toClient);
            }
            return;
        }

        _complete(Status.REFUNDED);
        usdc.safeTransfer(client, pot);

        if (_diamondHasCode()) {
            try IArbiterRegistryFacet(diamond).notifyArbiterTimeout{gas: ARBITER_TIMEOUT_GAS}(address(this)) {} catch {}
        }

        _clearDisputeClaim();
        emit ArbiterTimedOut(client, pot);
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
            '<style>text{font-family:monospace}.lb{font-size:9px;fill:#555;letter-spacing:1}.v{font-size:12px;fill:#ccc}.vl{font-size:13px;fill:#fff}.hd{font-size:11px}.c{text-anchor:middle}line{stroke:#1e1e1e;stroke-width:1}</style>',
            '<rect width="400" height="520" fill="#0d0d0d"/>',
            '<rect x="0" y="0" width="400" height="3" fill="', col, '"/>',
            '<text x="32" y="44" class="hd" fill="#555">DEAL AGREEMENT</text>',
            '<text x="368" y="44" class="hd" fill="#333" text-anchor="end">HSEAL</text>',
            '<text x="32" y="66" class="hd" fill="#444">', _shortAddr(address(this)), '</text>',
            _buildSVGStatus(col, st),
            _buildSVGData(),
            _buildSVGFooter()
        ));
    }

    function _buildSVGStatus(string memory col, string memory st) private pure returns (string memory) {
        return string(abi.encodePacked(
            '<line x1="32" y1="82" x2="368" y2="82"/>',
            '<rect x="32" y="94" width="336" height="36" rx="4" fill="', col, '" fill-opacity="0.12"/>',
            '<rect x="32" y="94" width="3" height="36" rx="1" fill="', col, '"/>',
            '<text x="46" y="117" font-size="14" fill="', col, '" font-weight="bold">', st, '</text>',
            '<line x1="32" y1="144" x2="368" y2="144"/>'
        ));
    }

    function _buildSVGData() private view returns (string memory) {
        return string(abi.encodePacked(
            '<text x="32"  y="164" class="lb">AMOUNT</text>',
            '<text x="200" y="164" class="lb">DEADLINE</text>',
            '<text x="32"  y="183" class="vl">', _formatUSDC(amount), '</text>',
            '<text x="200" y="183" class="vl">', _uint2str(deadlineDays), ' days</text>',
            '<line x1="32" y1="200" x2="368" y2="200"/>',
            '<text x="32" y="222" class="lb">CLIENT</text>',
            '<text x="32" y="240" class="v">', _shortAddr(client), '</text>',
            '<text x="32" y="268" class="lb">EXECUTOR</text>',
            '<text x="32" y="286" class="v">', _shortAddr(executor), '</text>',
            '<line x1="32" y1="304" x2="368" y2="304"/>',
            '<text x="32" y="326" class="lb">TERMS</text>',
            '<text x="32" y="344" font-size="10" fill="#555">', _truncateStr(terms, 48), '</text>'
        ));
    }

    function _buildSVGFooter() private pure returns (string memory) {
        return string(abi.encodePacked(
            '<line x1="32" y1="396" x2="368" y2="396"/>',
            '<text x="200" y="428" class="lb c" fill="#333">SOULBOUND</text>',
            '<text x="200" y="448" class="lb c" fill="#333">hexseal.net</text>',
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
        _finalized   = true;
        _finalStatus = newStatus;

        // Обновляем Registry через Diamond
        ISignatureRegistry.AgreementStatus regStatus;
        if (newStatus == Status.COMPLETED) regStatus = ISignatureRegistry.AgreementStatus.COMPLETED;
        else if (newStatus == Status.RESOLVED) regStatus = ISignatureRegistry.AgreementStatus.RESOLVED;
        else regStatus = ISignatureRegistry.AgreementStatus.REFUNDED;

        _updateRegistry(regStatus);

        // Автоматически начисляем XP обеим сторонам при успешном завершении
        if (newStatus == Status.COMPLETED || newStatus == Status.RESOLVED) {
            if (_diamondHasCode()) {
                // Floored as well as capped, and this is the reason the floor
                // exists at all. XP gates entry to the arbiter roster
                // (MIN_XP_TO_REGISTER), so a client who calls release() with a
                // gas limit tuned to make this one call fall short would close
                // the deal, take delivery, and quietly hold back the
                // executor's standing -- with nothing visibly broken. Out of
                // gas here reverts the whole transaction instead: call it
                // again with more.
                _requireDiamondGas(XP_AWARD_GAS, IReputationFacet.autoAwardXP.selector);
                try IReputationFacet(diamond).autoAwardXP{gas: XP_AWARD_GAS}(address(this)) {}
                catch { emit XpAwardFailed(address(this)); }
            } else {
                emit XpAwardFailed(address(this));
            }
        }

        // NFT больше не сжигаются при финализации — они остаются как
        // постоянный сертификат сделки, tokenURI() уже отражает финальный
        // статус (COMPLETED/RESOLVED/REFUNDED) через живой status().
    }

    /// @dev Is a verdict currently in flight on the diamond?
    ///
    /// Reads ArbiterRegistryFacet.hasSubmittedVerdict(address(this)) through
    /// the diamond, but an UNREACHABLE diamond reads as "no verdict" instead
    /// of reverting. That single difference decides whether escrowed money can
    /// ever leave a disputed deal.
    ///
    /// WHY FAILURE MUST OPEN THE DOOR RATHER THAN CLOSE IT.
    /// triggerArbiterTimeout is the only exit from DISPUTED: release,
    /// triggerAutoApprove and both other timeouts all refuse a disputed deal,
    /// and resolveDispute is reachable only through the diamond, because
    /// claimDispute makes the DIAMOND the arbiter. So when the diamond stops
    /// answering, this one read decides between "the pot goes home" and "the
    /// pot stays in the clone forever": there is no rescue function here, and
    /// none on the diamond either, because the money is not on the diamond.
    /// The deadlock is mutual -- a verdict cannot be finalized while the
    /// diamond is down either, since finalizeVerdict lives on it. Paying the
    /// parties out by the attendance rule is the smaller evil. And silencing
    /// the diamond on purpose takes the upgrade key, whose holder can already
    /// do worse than this.
    ///
    /// Three ways the diamond fails to answer, all three handled here:
    ///   * a removed selector -- the proxy fallback reverts -> ok = false;
    ///   * a reverting facet  -- ok = false;
    ///   * no code at all     -- ok = TRUE with zero bytes of returndata,
    ///     which is why the returndatasize check is not decoration. The raw
    ///     staticcall is chosen for exactly this case: it carries no
    ///     extcodesize guard, and solc's guard would revert in OUR frame,
    ///     where try/catch cannot see it.
    ///
    /// Shape borrowed from Treasury._readDiamondWord, plus one thing the
    /// treasury does not need: the gasleft() floor. There a failed read costs
    /// the party who wrecked it; here a failed read OPENS a door, so gas
    /// starvation has to be impossible, not merely unprofitable.
    function _verdictInFlight() private view returns (bool) {
        // Refuse to read at all unless the full budget can be handed over.
        // "Did not answer" must mean a broken diamond, never a starved call.
        if (gasleft() < VERDICT_VIEW_GAS_FLOOR) revert NotEnoughGasForVerdictCheck();

        address to      = diamond;
        address self    = address(this);
        uint256 gasCap  = VERDICT_VIEW_GAS;
        bytes4  selector = IArbiterRegistryFacet.hasSubmittedVerdict.selector;

        bool ok;
        uint256 word;
        assembly ("memory-safe") {
            // Scratch behind the free-memory pointer: the pointer itself is
            // not moved and nothing long-lived is left here. A bytes4 sits in
            // the high bytes of a Yul word, so mstore + length 4 lays down
            // exactly the selector, then one word of argument after it. The
            // output buffer is the same address: the EVM reads the input
            // before it writes the answer.
            let ptr := mload(0x40)
            mstore(ptr, selector)
            mstore(add(ptr, 4), self)
            ok := staticcall(gasCap, to, ptr, 36, ptr, 0x20)
            // A short answer is a failure: success with empty returndata (a
            // codeless address) would otherwise pass uninitialised memory off
            // as the value that was read.
            if lt(returndatasize(), 0x20) { ok := 0 }
            word := mload(ptr)
        }
        return ok && word != 0;
    }

    /// @dev Does the diamond still have code at its address?
    ///
    /// Every tolerated diamond call below is gated on this, and try/catch
    /// cannot stand in for it. For an external call that expects NO return
    /// data solc emits an extcodesize guard in the CALLER's own frame, ahead
    /// of the CALL opcode; a revert raised there flies straight past `catch`
    /// and takes the whole transaction down -- the payout with it. Measured on
    /// a standalone probe:
    /// test/DiamondDeathEscrow.t.sol::testTryCatchDoesNotCatchExtcodesizeGuard.
    ///
    /// So a codeless diamond has to read exactly like a removed selector or a
    /// reverting facet: the call did not happen, the deal closes anyway.
    /// AgreementDeployer already applies this rule to the implementation it
    /// clones; the diamond had no such check anywhere.
    function _diamondHasCode() private view returns (bool) {
        return diamond.code.length > 0;
    }

    /// @dev Refuse to make a capped diamond call unless the FULL cap can be
    /// handed over.
    ///
    /// EIP-150 forwards min(cap, gasleft - gasleft/64), so without this a
    /// caller who hand-picks a small gas limit can make a capped call run out
    /// of gas while the rest of the function still fits. Every capped call
    /// below is tolerated -- failure is caught and the deal closes anyway --
    /// so a starved call is indistinguishable from a broken diamond, and the
    /// caller keeps whatever the failure was worth to him.
    ///
    /// This guard is on the two calls where that is worth something:
    /// autoAwardXP (the counterparty's XP silently goes missing) and
    /// creditDisputeFee (the arbiter's 3% stays in the pot the caller is
    /// about to win). It is deliberately NOT on _updateRegistry,
    /// notifyExecutorFault, notifyArbiterTimeout or clearDisputeClaim: those
    /// announce their own failure, cost the starver as much as anyone, and
    /// syncRegistry() repairs the registry for anyone who cares. Putting a
    /// floor on _updateRegistry would also raise the minimum gas limit of
    /// raiseDispute past the ceiling the frontend already ships for it
    /// (160_000), which is a live regression traded for nothing.
    ///
    /// cap * 64/63 is the smallest gasleft that still forwards the full cap
    /// (x - x/64 >= cap).
    function _requireDiamondGas(uint256 cap, bytes4 diamondCall) private view {
        if (gasleft() < cap + cap / 63 + DIAMOND_CALL_GAS_SLACK) {
            revert NotEnoughGasForDiamondCall(diamondCall);
        }
    }

    function _updateRegistry(ISignatureRegistry.AgreementStatus regStatus) private {
        if (_diamondHasCode()) {
            try ISignatureRegistry(diamond).updateStatus{gas: REGISTRY_UPDATE_GAS}(address(this), regStatus) { return; } catch {}
        }
        // Деньги важнее Registry — сделка завершается в любом случае.
        // Событие позволяет мониторить рассинхрон и вызвать syncRegistry() для починки.
        // A codeless diamond lands here too, and says so through the same event.
        emit RegistrySyncFailed(address(this), uint8(regStatus));
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
        // Non-blocking: не останавливаем завершение сделки если ArbiterRegistry недоступен.
        // The code check is part of that tolerance, not an optimisation: this
        // call runs AFTER the money has been transferred, and a revert here
        // would roll the transfer back with it.
        if (_diamondHasCode()) {
            try IArbiterRegistry(diamond).clearDisputeClaim{gas: CLAIM_CLEAR_GAS}(address(this)) {} catch {}
        }
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

    function _hexChar(uint8 v) private pure returns (bytes1) {
        return v < 10 ? bytes1(v + 48) : bytes1(v + 87);
    }
}
