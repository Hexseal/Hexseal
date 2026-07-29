// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// HEXSEAL — FactoryFacet.sol
// Деплоит Agreement контракты через внешний AgreementDeployer.
// Берёт PPP fee в USDC, регистрирует в RegistryFacet.
// ============================================================

import "./RegistryFacet.sol";
import "./AgreementDeployer.sol"; // только интерфейс IAgreementDeployer

// ---------- INTERFACES ----------

interface IRegistry {
    function register(address agreement, address client, address executor, uint256 amount) external;
    function hasActivePair(address client, address executor) external view returns (bool);
}


/// Пол комиссии не настроен — брать нечего. Отдельная ошибка, а не ZeroFee:
/// ZeroFee означал «регион не настроен», а регионов в цене больше нет.
error FeeNotConfigured();

/// Комиссия больше не зависит от региона. Геттеры оставлены в ABI, но ревертят:
/// тихо вернуть стухшее число хуже, чем упасть.
error FeeNotRegional();

// ---------- STORAGE ----------

library FactoryStorage {
    /// @custom:storage-location erc7201:hexseal.factory.storage
    /// keccak256(abi.encode(uint256(keccak256("hexseal.factory.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 constant FACTORY_STORAGE_POSITION = 0x6e1a7c9e564b098cf0d979de1ae0cacf8bfb22a7e8f2c8f4c244a2031b744700;

    uint8 constant REGION_CIS   = 0;
    uint8 constant REGION_ASIA  = 1;
    uint8 constant REGION_EU    = 2;
    uint8 constant REGION_US    = 3;
    uint8 constant REGION_LATAM = 4;
    uint8 constant REGION_CA    = 5;
    uint8 constant REGION_AU    = 6;

    struct Layout {
        address usdc;
        address feeRecipient;
        mapping(uint8 => uint256) regionFee;
        address trustedForwarder;
        address diamond;
        bool paused;
        address protocolArbiter;
        uint256 arbitrationThreshold;
        // Деплойер Agreement: держит адрес развёрнутой реализации и клонирует
        // её через EIP-1167. Creationcode он больше не носит (945 байт против
        // прежних 23 849) — но остаётся отдельным контрактом, чтобы фабрика
        // не зависела от кода Agreement и её можно было переключить на новую
        // реализацию через setAgreementDeployer, не трогая фасет.
        address agreementDeployer;
        // --- Модель комиссии (28.07.2026) ---
        // Комиссия = max(amount * feeBps / 10_000, feeFloor). Региональной
        // больше не является: regionFee выше остаётся мёртвым полем, потому
        // что раскладка append-only. Подробности — docs/superpowers/specs/
        // 2026-07-28-fee-economics-design.md
        uint256 feeBps;
        uint256 feeFloor;
        // Потолок одновременно висящих заявок на КЛИЕНТА (поверх всех
        // исполнителей). 0 = без ограничения — так апгрейд живого диамонда
        // с ещё нулевым полем не блокирует заявки.
        uint256 maxPendingRequests;
    }

    function store() internal pure returns (Layout storage fs) {
        bytes32 position = FACTORY_STORAGE_POSITION;
        assembly {
            fs.slot := position
        }
    }

    /// @notice Единственная реализация формулы комиссии. Зовут FactoryFacet,
    ///         JobBoardFacet и ServiceBoardFacet — второй копии быть не должно.
    /// @dev Пол применяется ПОСЛЕ процента: берётся что больше, не сумма.
    function quote(Layout storage fs, uint256 amount) internal view returns (uint256 fee) {
        uint256 floor_ = fs.feeFloor;
        if (floor_ == 0) revert FeeNotConfigured();
        fee = (amount * fs.feeBps) / 10_000;
        if (fee < floor_) fee = floor_;
    }
}

// ---------- FACET ----------

contract FactoryFacet {

    // -------- EVENTS --------

    event AgreementDeployed(
        address indexed agreement,
        address indexed client,
        address indexed executor,
        uint256 amount,
        uint8 region,
        uint256 fee
    );

    event RegionFeeUpdated(uint8 indexed region, uint256 newFee);
    event FeeRecipientUpdated(address indexed newRecipient);
    event TrustedForwarderUpdated(address indexed newForwarder);
    event DealFunded(address indexed agreement, address indexed client, uint256 amount);
    event AgreementDeployerUpdated(address indexed deployer);
    event FeeBpsUpdated(uint256 newBps);
    event FeeFloorUpdated(uint256 newFloor);
    event MaxPendingRequestsUpdated(uint256 newMax);

    // -------- ERRORS --------

    error FactoryZeroAddress();
    error ZeroAmount();
    error ZeroDeadline();
    error InvalidRegion();
    error ActiveDealExists();
    error ClientEqualsExecutor();
    error NotOwner();
    error AlreadyInitialized();
    error NotClient();
    error DeployerNotSet();
    error FeeBpsTooHigh();

    // -------- OWNER CHECK --------

    function _owner() internal view returns (address) {
        return OwnershipLib.contractOwner();
    }

    modifier onlyOwner() {
        if (msg.sender != _owner()) revert NotOwner();
        _;
    }

    // -------- INIT --------

    function initFactory(
        address usdc_,
        address feeRecipient_,
        address trustedForwarder_,
        address diamond_,
        address agreementDeployer_
    ) external {
        FactoryStorage.Layout storage fs = FactoryStorage.store();
        if (fs.usdc != address(0)) revert AlreadyInitialized();
        if (msg.sender != _owner()) revert NotOwner();

        if (usdc_ == address(0)) revert FactoryZeroAddress();
        if (feeRecipient_ == address(0)) revert FactoryZeroAddress();
        if (trustedForwarder_ == address(0)) revert FactoryZeroAddress();
        if (diamond_ == address(0)) revert FactoryZeroAddress();
        if (agreementDeployer_ == address(0)) revert FactoryZeroAddress();

        fs.usdc              = usdc_;
        fs.feeRecipient      = feeRecipient_;
        fs.trustedForwarder  = trustedForwarder_;
        fs.diamond           = diamond_;
        fs.agreementDeployer = agreementDeployer_;

        fs.feeBps             = 500;        // 5%
        fs.feeFloor           = 1_000_000;  // $1
        fs.maxPendingRequests = 5;
    }

    /// @notice Одноразовый засев модели комиссии для УЖЕ проинициализированного
    ///         диамонда. Существует только ради апгрейда живого 0x760F…: там
    ///         initFactory отработал давно и ревертит AlreadyInitialized, а
    ///         feeBps/feeFloor/maxPendingRequests — новые поля, которых в
    ///         хранилище ещё нет.
    /// @dev Зовётся через `_init`/`_calldata` того же diamondCut, что монтирует
    ///      фасет: DiamondCutLib.initializeDiamondCut() делает
    ///      `_init.delegatecall(_calldata)` уже внутри контекста диамонда, так
    ///      что `_init` — адрес ИМПЛЕМЕНТАЦИИ фасета (не диамонда), хранилище
    ///      резолвится диамондовское, а msg.sender сквозь delegatecall остаётся
    ///      владельцем, вызвавшим diamondCut — onlyOwner здесь настоящий гейт,
    ///      а не декорация. Без этого между cut'ом и конфигурирующей
    ///      транзакцией существует окно, в котором quote() ревертит
    ///      FeeNotConfigured, то есть ревертят ВСЕ денежные пути, включая
    ///      acceptApplicant/acceptRequest по уже опубликованным заказам.
    ///      Проверки — те же, что в setFeeBps/setFeeFloor: одноразовый путь не
    ///      должен быть слабее обычного.
    function initFeeModel(uint256 bps, uint256 floor, uint256 maxPending) external onlyOwner {
        FactoryStorage.Layout storage fs = FactoryStorage.store();
        if (fs.feeFloor != 0) revert AlreadyInitialized();
        if (floor == 0) revert FeeNotConfigured();
        // Ноль здесь строже, чем в setFeeBps: путь одноразовый и необратимый,
        // а нулевая ставка тихо возвращает протокол к плоской комиссии —
        // quote() отдаёт пол на любой сумме, без реверта и без события.
        // Опечатку в одном аргументе после этого правит только новый diamondCut.
        if (bps == 0 || bps > 2_000) revert FeeBpsTooHigh();
        fs.feeBps = bps;
        fs.feeFloor = floor;
        fs.maxPendingRequests = maxPending;
        emit FeeBpsUpdated(bps);
        emit FeeFloorUpdated(floor);
        emit MaxPendingRequestsUpdated(maxPending);
    }

    // -------- DEPLOY AGREEMENT --------

    function deployAgreement(
        address client,
        address executor,
        address, // arbiter — ignored, assigned at dispute claim time
        uint256 amount,
        uint256 deadlineDays,
        string calldata terms,
        uint8 region
    ) external returns (address agreementAddress) {
        if (client == address(0)) revert FactoryZeroAddress();
        if (executor == address(0)) revert FactoryZeroAddress();
        if (client == executor) revert ClientEqualsExecutor();
        if (amount == 0) revert ZeroAmount();
        if (deadlineDays == 0) revert ZeroDeadline();
        if (region > 6) revert InvalidRegion();
        if (msg.sender != client && msg.sender != address(this)) revert NotClient();

        FactoryStorage.Layout storage fs = FactoryStorage.store();
        if (fs.agreementDeployer == address(0)) revert DeployerNotSet();

        if (IRegistry(fs.diamond).hasActivePair(client, executor)) revert ActiveDealExists();

        uint256 fee = FactoryStorage.quote(fs, amount);
        if (msg.sender == client) {
            _safeTransferFrom(fs.usdc, msg.sender, fs.feeRecipient, fee);
        }

        agreementAddress = IAgreementDeployer(fs.agreementDeployer).deploy(
            client, executor, address(0),
            amount, deadlineDays, terms,
            fs.diamond, fs.usdc, fs.trustedForwarder, address(this)
        );
        // Симметрично deployAndFund: agreementDeployer подключается через
        // onlyOwner setAgreementDeployer и уже менялся несколько раз
        // (UpgradeAgreementDeployerV2/V3/V4) — будущий деплойер без
        // собственной проверки на ноль не должен молча пройти дальше в register().
        if (agreementAddress == address(0)) revert FactoryZeroAddress();

        IRegistry(fs.diamond).register(agreementAddress, client, executor, amount);

        emit AgreementDeployed(agreementAddress, client, executor, amount, region, fee);
    }

    // -------- DEPLOY AND FUND --------

    function _msgSender() internal view returns (address sender) {
        address forwarder = FactoryStorage.store().trustedForwarder;
        if (msg.sender == forwarder && msg.data.length >= 20) {
            assembly { sender := shr(96, calldataload(sub(calldatasize(), 20))) }
        } else {
            sender = msg.sender;
        }
    }

    function deployAndFund(
        address client,
        address executor,
        uint256 amount,
        uint256 deadlineDays,
        string calldata terms,
        uint8 region
    ) external returns (address agreementAddress) {
        if (client == address(0)) revert FactoryZeroAddress();
        if (executor == address(0)) revert FactoryZeroAddress();
        if (client == executor) revert ClientEqualsExecutor();
        if (amount == 0) revert ZeroAmount();
        if (deadlineDays == 0) revert ZeroDeadline();
        if (region > 6) revert InvalidRegion();
        if (_msgSender() != client) revert NotClient();

        FactoryStorage.Layout storage fs = FactoryStorage.store();
        if (fs.agreementDeployer == address(0)) revert DeployerNotSet();

        if (IRegistry(fs.diamond).hasActivePair(client, executor)) revert ActiveDealExists();

        uint256 fee = FactoryStorage.quote(fs, amount);

        _safeTransferFrom(fs.usdc, client, fs.feeRecipient, fee);

        agreementAddress = IAgreementDeployer(fs.agreementDeployer).deploy(
            client, executor, address(0),
            amount, deadlineDays, terms,
            fs.diamond, fs.usdc, fs.trustedForwarder, address(this)
        );
        if (agreementAddress == address(0)) revert FactoryZeroAddress();

        IRegistry(fs.diamond).register(agreementAddress, client, executor, amount);

        _safeTransferFrom(fs.usdc, client, agreementAddress, amount);

        (bool success, ) = agreementAddress.call(abi.encodeWithSignature("fundFromFactory()"));
        require(success, "Factory: fundFromFactory failed");

        emit AgreementDeployed(agreementAddress, client, executor, amount, region, fee);
        emit DealFunded(agreementAddress, client, amount);
    }

    // -------- SAFE TRANSFER --------

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0x23b872dd, from, to, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "Factory: fee transfer failed");
    }

    // -------- ADMIN --------

    /// @dev DEPRECATED 28.07.2026 — симметрично getRegionFee/getAllFees. Селектор
    ///      остаётся смонтированным (Remove — это отдельный diamondCut, а он не
    ///      нужен: тело заменяется тем же Replace, что и остальной фасет), но
    ///      запись ревертит. Рабочий сеттер рядом с ревертящим геттером означал
    ///      бы, что админка «выставляет» комиссии, которые ничего не делают —
    ///      правило «тихо принять стухшее число хуже, чем упасть» одинаково для
    ///      чтений и записей.
    function setRegionFee(uint8, uint256) external pure {
        revert FeeNotRegional();
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert FactoryZeroAddress();
        FactoryStorage.store().feeRecipient = newRecipient;
        emit FeeRecipientUpdated(newRecipient);
    }

    function setTrustedForwarder(address newForwarder) external onlyOwner {
        FactoryStorage.store().trustedForwarder = newForwarder;
        emit TrustedForwarderUpdated(newForwarder);
    }

    function setAgreementDeployer(address deployer) external onlyOwner {
        if (deployer == address(0)) revert FactoryZeroAddress();
        FactoryStorage.store().agreementDeployer = deployer;
        emit AgreementDeployerUpdated(deployer);
    }

    /// @notice Ставка в базисных пунктах. 500 = 5%.
    function setFeeBps(uint256 newBps) external onlyOwner {
        if (newBps > 2_000) revert FeeBpsTooHigh(); // потолок 20% — защита от опечатки в нуле
        FactoryStorage.store().feeBps = newBps;
        emit FeeBpsUpdated(newBps);
    }

    /// @notice Пол комиссии в USDC (6 decimals). Ноль запрещён — это выключило бы антиспам.
    function setFeeFloor(uint256 newFloor) external onlyOwner {
        if (newFloor == 0) revert FeeNotConfigured();
        FactoryStorage.store().feeFloor = newFloor;
        emit FeeFloorUpdated(newFloor);
    }

    /// @notice Потолок висящих заявок на клиента. 0 = без ограничения.
    function setMaxPendingRequests(uint256 newMax) external onlyOwner {
        FactoryStorage.store().maxPendingRequests = newMax;
        emit MaxPendingRequestsUpdated(newMax);
    }

    // -------- READ --------

    /// @dev DEPRECATED 28.07.2026 — комиссия больше не региональная. Селектор оставлен
    ///      в ABI, чтобы не требовать Remove в diamondCut, но чтение ревертит:
    ///      regionFee в хранилище содержит стухшие значения.
    function getRegionFee(uint8) external pure returns (uint256) {
        revert FeeNotRegional();
    }

    /// @dev DEPRECATED 28.07.2026 — см. getRegionFee.
    function getAllFees() external pure returns (
        uint256, uint256, uint256, uint256, uint256, uint256, uint256
    ) {
        revert FeeNotRegional();
    }

    /// @notice Сколько будет стоить сделка на такую сумму. Источник правды для фронта —
    ///         считать формулу на клиенте нельзя, разойдётся с permit.
    function quoteFee(uint256 amount) external view returns (uint256) {
        return FactoryStorage.quote(FactoryStorage.store(), amount);
    }

    function getFeeBps() external view returns (uint256) {
        return FactoryStorage.store().feeBps;
    }

    function getFeeFloor() external view returns (uint256) {
        return FactoryStorage.store().feeFloor;
    }

    function getMaxPendingRequests() external view returns (uint256) {
        return FactoryStorage.store().maxPendingRequests;
    }

    function getFeeRecipient() external view returns (address) {
        return FactoryStorage.store().feeRecipient;
    }

    function getTrustedForwarder() external view returns (address) {
        return FactoryStorage.store().trustedForwarder;
    }

    function getUsdc() external view returns (address) {
        return FactoryStorage.store().usdc;
    }

    function getAgreementDeployer() external view returns (address) {
        return FactoryStorage.store().agreementDeployer;
    }
}
