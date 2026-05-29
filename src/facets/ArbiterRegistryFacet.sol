// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// HEXSEAL — ArbiterRegistryFacet.sol
//
// Реестр арбитров: мультиарбитражный хаб
// - Овнер добавляет/убирает арбитров
// - Арбитры видят открытые споры и берут их (first-come-first-served)
// - 1 спор = 1 арбитр; все видят кто взял
// - ERC-2771: арбитры могут клеймить без ETH (через relay)
// ============================================================

import "../../src/FactoryFacet.sol"; // для FactoryStorage (trustedForwarder) и OwnershipLib
import "../../src/DiamondProxy.sol";  // для OwnershipLib

// ---------- AGREEMENT INTERFACE ----------

interface IAgreementStatus {
    function status() external view returns (uint8);
    function setArbiter(address newArbiter) external;
    function client() external view returns (address);
    function executor() external view returns (address);
    function amount() external view returns (uint256);
    function disputedAt() external view returns (uint256);
}

// ---------- STORAGE ----------

library ArbiterRegistryStorage {
    bytes32 constant POSITION = keccak256("hexseal.arbiterregistry.storage");

    struct Data {
        mapping(address => bool) isArbiter;
        address[] arbiterList;
        // agreement → arbiter who claimed it
        mapping(address => address) disputeClaims;
        // arbiter → all agreements they worked on (history)
        mapping(address => address[]) arbiterDeals;
        // commit-reveal: keccak256(agreement, arbiter, salt) → block.number of commit
        mapping(bytes32 => uint256) claimCommitments;
        // chief arbiter — trusted role with same add/remove rights as owner
        address chiefArbiter;
    }

    function data() internal pure returns (Data storage d) {
        bytes32 pos = POSITION;
        assembly { d.slot := pos }
    }
}

// ---------- FACET ----------

contract ArbiterRegistryFacet {

    // -------- CONSTANTS --------

    uint256 private constant COMMIT_MAX_BLOCKS = 50; // commitment expires after 50 blocks (~100s on Base)

    // -------- EVENTS --------

    event ArbiterAdded(address indexed arbiter);
    event ArbiterRemoved(address indexed arbiter);
    event ChiefArbiterSet(address indexed prev, address indexed next);
    event DisputeClaimCommitted(address indexed arbiter, bytes32 indexed commitment);
    event DisputeClaimed(address indexed agreement, address indexed arbiter);
    event DisputeReleased(address indexed agreement, address indexed prevArbiter);

    // -------- ERRORS --------

    error NotOwner();
    error NotOwnerOrChief();
    error NotArbiter();
    error AlreadyArbiter();
    error NotAnArbiter();
    error AlreadyClaimed();
    error NotClaimed();
    error NotDisputed();
    error NotAuthorized();
    error CommitmentNotFound();
    error CommitmentTooEarly();
    error CommitmentExpired();

    // -------- MODIFIERS --------

    modifier onlyOwner() {
        if (OwnershipLib.contractOwner() != msg.sender) revert NotOwner();
        _;
    }

    modifier onlyOwnerOrChief() {
        address chief = ArbiterRegistryStorage.data().chiefArbiter;
        if (msg.sender != OwnershipLib.contractOwner() && msg.sender != chief)
            revert NotOwnerOrChief();
        _;
    }

    // -------- ERC-2771 SENDER --------
    // Арбитры могут клеймить через relay (gasless), поэтому поддерживаем ERC-2771

    function _msgSender() internal view returns (address sender) {
        address forwarder = FactoryStorage.layout().trustedForwarder;
        if (msg.sender == forwarder && msg.data.length >= 20) {
            assembly {
                sender := shr(96, calldataload(sub(calldatasize(), 20)))
            }
        } else {
            sender = msg.sender;
        }
    }

    // -------- ADMIN: MANAGE ARBITERS --------

    /// @notice Назначить главного арбитра. Только owner.
    function setChiefArbiter(address arbiter) external onlyOwner {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        emit ChiefArbiterSet(d.chiefArbiter, arbiter);
        d.chiefArbiter = arbiter;
    }

    /// @notice Добавить арбитра в реестр. Owner или chief arbiter.
    function addArbiter(address arbiter) external onlyOwnerOrChief {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        if (d.isArbiter[arbiter]) revert AlreadyArbiter();
        d.isArbiter[arbiter] = true;
        d.arbiterList.push(arbiter);
        emit ArbiterAdded(arbiter);
    }

    /// @notice Убрать арбитра из реестра. Owner или chief arbiter.
    function removeArbiter(address arbiter) external onlyOwnerOrChief {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        if (!d.isArbiter[arbiter]) revert NotAnArbiter();
        d.isArbiter[arbiter] = false;
        // Swap-and-pop
        uint256 len = d.arbiterList.length;
        for (uint256 i = 0; i < len; i++) {
            if (d.arbiterList[i] == arbiter) {
                d.arbiterList[i] = d.arbiterList[len - 1];
                d.arbiterList.pop();
                break;
            }
        }
        emit ArbiterRemoved(arbiter);
    }

    // -------- ARBITER ACTIONS --------

    /// @notice Шаг 1 из 2: арбитр коммитит намерение клеймить спор.
    /// Передаётся хеш = keccak256(abi.encodePacked(agreement, arbiter, salt)).
    /// Раскрывать можно не раньше следующего блока — защита от фронтраннинга.
    function commitDisputeClaim(bytes32 commitment) external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        if (!d.isArbiter[caller]) revert NotArbiter();
        d.claimCommitments[commitment] = block.number;
        emit DisputeClaimCommitted(caller, commitment);
    }

    /// @notice Шаг 2 из 2: арбитр раскрывает коммит и берёт спорное дело.
    /// Должно быть не менее COMMIT_MIN_BLOCKS и не более COMMIT_MAX_BLOCKS после коммита.
    /// Только зарегистрированный арбитр. Сделка должна быть DISPUTED.
    /// Вызывает Agreement.setArbiter(caller) через Diamond delegatecall.
    function claimDispute(address agreement, bytes32 salt) external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        if (!d.isArbiter[caller]) revert NotArbiter();
        if (d.disputeClaims[agreement] != address(0)) revert AlreadyClaimed();

        // Проверка commit-reveal
        bytes32 commitment = keccak256(abi.encodePacked(agreement, caller, salt));
        uint256 committedAt = d.claimCommitments[commitment];
        if (committedAt == 0) revert CommitmentNotFound();
        if (block.number <= committedAt) revert CommitmentTooEarly();
        if (block.number > committedAt + COMMIT_MAX_BLOCKS) revert CommitmentExpired();
        delete d.claimCommitments[commitment];

        // Проверяем что сделка реально DISPUTED (status == 4)
        // Agreement.Status: CREATED=0, FUNDED=1, ACTIVE=2, COMPLETED=3, DISPUTED=4, RESOLVED=5, REFUNDED=6
        (bool statusOk, bytes memory statusData) = agreement.staticcall(
            abi.encodeWithSignature("status()")
        );
        require(statusOk, "ArbiterRegistry: failed to read status");
        uint8 agreementStatus = abi.decode(statusData, (uint8));
        if (agreementStatus != 4) revert NotDisputed();

        // CEI: сначала устанавливаем арбитра на Agreement — если упадёт, клейм не записывается
        // Работает потому что ArbiterRegistryFacet выполняется через Diamond delegatecall,
        // поэтому Agreement видит msg.sender == Diamond address
        (bool setOk,) = agreement.call(
            abi.encodeWithSignature("setArbiter(address)", caller)
        );
        require(setOk, "ArbiterRegistry: setArbiter failed");

        // Записываем клейм только после успешного setArbiter
        d.disputeClaims[agreement] = caller;
        d.arbiterDeals[caller].push(agreement);

        emit DisputeClaimed(agreement, caller);
    }

    /// @notice Снять клейм (арбитр или owner). Освобождает сделку для другого арбитра.
    function releaseDisputeClaim(address agreement) external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        address current = d.disputeClaims[agreement];
        if (current == address(0)) revert NotClaimed();
        if (caller != current && caller != OwnershipLib.contractOwner()) revert NotAuthorized();

        delete d.disputeClaims[agreement];

        // Сбрасываем арбитра до address(0) на Agreement
        (bool ok,) = agreement.call(
            abi.encodeWithSignature("setArbiter(address)", address(0))
        );
        require(ok, "ArbiterRegistry: reset arbiter failed");

        emit DisputeReleased(agreement, current);
    }

    // -------- AGREEMENT CALLBACKS --------

    /// @notice Очистить клейм после завершения спора.
    /// Вызывается самим Agreement-контрактом через Diamond при resolveDispute / triggerArbiterTimeout.
    /// Только Agreement сам может очистить свой клейм — msg.sender == agreement.
    function clearDisputeClaim(address agreement) external {
        require(msg.sender == agreement, "ArbiterRegistry: only agreement");
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        if (d.disputeClaims[agreement] != address(0)) {
            delete d.disputeClaims[agreement];
        }
    }

    // -------- VIEWS --------

    function getChiefArbiter() external view returns (address) {
        return ArbiterRegistryStorage.data().chiefArbiter;
    }

    function isRegisteredArbiter(address addr) external view returns (bool) {
        return ArbiterRegistryStorage.data().isArbiter[addr];
    }

    function getArbiters() external view returns (address[] memory) {
        return ArbiterRegistryStorage.data().arbiterList;
    }

    function getDisputeClaimer(address agreement) external view returns (address) {
        return ArbiterRegistryStorage.data().disputeClaims[agreement];
    }

    /// @notice История сделок арбитра (все когда-либо взятые им)
    function getArbiterDeals(address arbiter) external view returns (address[] memory) {
        return ArbiterRegistryStorage.data().arbiterDeals[arbiter];
    }

    /// @notice Блок в котором был сохранён коммит (0 если не существует или удалён)
    function getClaimCommitment(bytes32 commitment) external view returns (uint256) {
        return ArbiterRegistryStorage.data().claimCommitments[commitment];
    }
}
