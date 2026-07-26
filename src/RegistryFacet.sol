// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// HEXSEAL — RegistryFacet.sol
// Хранит все сделки, статусы, пары клиент+исполнитель
// Живёт внутри Diamond — один адрес навсегда
// ============================================================

import "./DiamondProxy.sol";

// ---------- STORAGE ----------

library RegistryStorage {
    /// @custom:storage-location erc7201:hexseal.registry.storage
    /// keccak256(abi.encode(uint256(keccak256("hexseal.registry.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 constant REGISTRY_STORAGE_POSITION = 0xc2046377b613f781ce75bf5776eb70f650372f5239ada8a3238d951cdca15e00;

    enum AgreementStatus {
        ACTIVE,
        COMPLETED,
        REFUNDED,
        DISPUTED,
        RESOLVED
    }

    struct AgreementRecord {
        address agreement;   // адрес Agreement контракта
        address client;      // заказчик
        address executor;    // исполнитель
        uint256 amount;      // сумма сделки в USDC (6 decimals)
        AgreementStatus status;
        uint256 createdAt;
        uint256 resolvedAt;
    }

    struct Layout {
        // agreement address → запись
        mapping(address => AgreementRecord) agreements;

        // все адреса Agreement
        address[] allAgreements;

        // keccak(client, executor) → активный agreement
        // предотвращает дублирование активных сделок между одной парой
        mapping(bytes32 => address) activePartyPairs;

        // кто имеет право вызывать register() — только FactoryFacet
        // хранится как selector авторизованного адреса
        address authorizedFactory;
    }

    function store() internal pure returns (Layout storage rs) {
        bytes32 position = REGISTRY_STORAGE_POSITION;
        assembly {
            rs.slot := position
        }
    }
}

// ---------- FACET ----------

contract RegistryFacet {
    using RegistryStorage for RegistryStorage.Layout;

    // -------- EVENTS --------

    event AgreementRegistered(
        address indexed agreement,
        address indexed client,
        address indexed executor,
        uint256 amount
    );

    event AgreementStatusUpdated(
        address indexed agreement,
        RegistryStorage.AgreementStatus newStatus
    );

    event AuthorizedFactorySet(address indexed factory);

    // -------- ERRORS --------

    error OnlyAuthorizedFactory();
    error OnlyAgreementItself();
    error AgreementNotRegistered();
    error ActiveDealAlreadyExists();
    error RegistryZeroAddress();
    error AlreadyInitialized();
    error NotOwner();

    // -------- MODIFIERS --------

    modifier onlyFactory() {
        if (msg.sender != RegistryStorage.store().authorizedFactory)
            revert OnlyAuthorizedFactory();
        _;
    }

    modifier onlyAgreement(address agreement) {
        // Agreement сам себя регистрирует как msg.sender
        if (msg.sender != agreement) revert OnlyAgreementItself();
        // И должен быть реально зарегистрирован
        if (RegistryStorage.store().agreements[agreement].agreement != agreement)
            revert AgreementNotRegistered();
        _;
    }

    // -------- INIT (вызывается один раз при деплое Diamond) --------

    function initRegistry(address factory_) external {
        RegistryStorage.Layout storage rs = RegistryStorage.store();
        if (rs.authorizedFactory != address(0)) revert AlreadyInitialized();
        if (factory_ == address(0)) revert RegistryZeroAddress();
        // Защита от frontrun: проверяем что вызывающий — owner Diamond
        if (msg.sender != OwnershipLib.contractOwner()) revert NotOwner();
        rs.authorizedFactory = factory_;
        emit AuthorizedFactorySet(factory_);
    }

    // -------- WRITE --------

    /// @notice Регистрация новой сделки. Вызывает только FactoryFacet после деплоя Agreement.
    function register(
        address agreement,
        address client,
        address executor,
        uint256 amount
    ) external onlyFactory {
        if (agreement == address(0)) revert RegistryZeroAddress();
        if (client == address(0)) revert RegistryZeroAddress();
        if (executor == address(0)) revert RegistryZeroAddress();

        RegistryStorage.Layout storage rs = RegistryStorage.store();

        bytes32 pairKey = _pairKey(client, executor);

        // Нельзя иметь две активные сделки между одной парой
        if (rs.activePartyPairs[pairKey] != address(0))
            revert ActiveDealAlreadyExists();

        rs.agreements[agreement] = RegistryStorage.AgreementRecord({
            agreement: agreement,
            client: client,
            executor: executor,
            amount: amount,
            status: RegistryStorage.AgreementStatus.ACTIVE,
            createdAt: block.timestamp,
            resolvedAt: 0
        });

        rs.allAgreements.push(agreement);
        rs.activePartyPairs[pairKey] = agreement;

        emit AgreementRegistered(agreement, client, executor, amount);
    }

    /// @notice Обновление статуса. Вызывает только сам Agreement контракт.
    function updateStatus(
        address agreement,
        RegistryStorage.AgreementStatus newStatus
    ) external onlyAgreement(agreement) {
        RegistryStorage.Layout storage rs = RegistryStorage.store();
        RegistryStorage.AgreementRecord storage record = rs.agreements[agreement];

        record.status = newStatus;

        // Если сделка закрыта — убираем из активных пар
        if (newStatus != RegistryStorage.AgreementStatus.ACTIVE) {
            bytes32 pairKey = _pairKey(record.client, record.executor);
            if (rs.activePartyPairs[pairKey] == agreement) {
                delete rs.activePartyPairs[pairKey];
            }
            record.resolvedAt = block.timestamp;
        }

        emit AgreementStatusUpdated(agreement, newStatus);
    }

    /// @notice Обновление адреса Factory (только owner Diamond)
    /// Нужно если деплоишь новую версию FactoryFacet
    function setAuthorizedFactory(address newFactory) external {
        if (msg.sender != OwnershipLib.contractOwner()) revert NotOwner();
        if (newFactory == address(0)) revert RegistryZeroAddress();
        RegistryStorage.store().authorizedFactory = newFactory;
        emit AuthorizedFactorySet(newFactory);
    }

    // -------- READ --------

    /// @notice Есть ли активная сделка между этой парой
    function hasActivePair(address client, address executor) external view returns (bool) {
        return RegistryStorage.store().activePartyPairs[_pairKey(client, executor)] != address(0);
    }

    /// @notice Адрес активной сделки между парой (address(0) если нет)
    function getActivePair(address client, address executor) external view returns (address) {
        return RegistryStorage.store().activePartyPairs[_pairKey(client, executor)];
    }

    /// @notice Полная запись по адресу Agreement
    function getRecord(address agreement) external view returns (RegistryStorage.AgreementRecord memory) {
        return RegistryStorage.store().agreements[agreement];
    }

    /// @notice Все сделки клиента
    function getByClient(address client) external view returns (RegistryStorage.AgreementRecord[] memory) {
        RegistryStorage.Layout storage rs = RegistryStorage.store();
        return _filter(rs, client, true);
    }

    /// @notice Все сделки исполнителя
    function getByExecutor(address executor) external view returns (RegistryStorage.AgreementRecord[] memory) {
        RegistryStorage.Layout storage rs = RegistryStorage.store();
        return _filter(rs, executor, false);
    }

    /// @notice Все активные сделки (для борды)
    function getActive() external view returns (RegistryStorage.AgreementRecord[] memory) {
        RegistryStorage.Layout storage rs = RegistryStorage.store();
        uint256 count;
        for (uint256 i; i < rs.allAgreements.length; i++) {
            if (rs.agreements[rs.allAgreements[i]].status == RegistryStorage.AgreementStatus.ACTIVE) {
                count++;
            }
        }
        RegistryStorage.AgreementRecord[] memory result = new RegistryStorage.AgreementRecord[](count);
        uint256 idx;
        for (uint256 i; i < rs.allAgreements.length; i++) {
            if (rs.agreements[rs.allAgreements[i]].status == RegistryStorage.AgreementStatus.ACTIVE) {
                result[idx++] = rs.agreements[rs.allAgreements[i]];
            }
        }
        return result;
    }

    /// @notice Все спорные сделки (для борды арбитров)
    function getDisputed() external view returns (RegistryStorage.AgreementRecord[] memory) {
        RegistryStorage.Layout storage rs = RegistryStorage.store();
        uint256 count;
        for (uint256 i; i < rs.allAgreements.length; i++) {
            if (rs.agreements[rs.allAgreements[i]].status == RegistryStorage.AgreementStatus.DISPUTED) {
                count++;
            }
        }
        RegistryStorage.AgreementRecord[] memory result = new RegistryStorage.AgreementRecord[](count);
        uint256 idx;
        for (uint256 i; i < rs.allAgreements.length; i++) {
            if (rs.agreements[rs.allAgreements[i]].status == RegistryStorage.AgreementStatus.DISPUTED) {
                result[idx++] = rs.agreements[rs.allAgreements[i]];
            }
        }
        return result;
    }

    /// @notice Общее количество сделок
    function totalAgreements() external view returns (uint256) {
        return RegistryStorage.store().allAgreements.length;
    }

    /// @notice Адрес авторизованного Factory
    function authorizedFactory() external view returns (address) {
        return RegistryStorage.store().authorizedFactory;
    }

    // -------- INTERNAL --------

    function _pairKey(address client, address executor) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(client, executor));
    }

    function _filter(
        RegistryStorage.Layout storage rs,
        address party,
        bool isClient
    ) internal view returns (RegistryStorage.AgreementRecord[] memory) {
        uint256 count;
        for (uint256 i; i < rs.allAgreements.length; i++) {
            RegistryStorage.AgreementRecord storage rec = rs.agreements[rs.allAgreements[i]];
            if (isClient ? rec.client == party : rec.executor == party) count++;
        }
        RegistryStorage.AgreementRecord[] memory result = new RegistryStorage.AgreementRecord[](count);
        uint256 idx;
        for (uint256 i; i < rs.allAgreements.length; i++) {
            RegistryStorage.AgreementRecord storage rec = rs.agreements[rs.allAgreements[i]];
            if (isClient ? rec.client == party : rec.executor == party) {
                result[idx++] = rec;
            }
        }
        return result;
    }
}
