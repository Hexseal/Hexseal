// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// HEXSEAL — ReputationFacet.sol
//
// On-chain XP система. Пользователи клеймят XP после завершения сделки.
// Anti-gaming: deal >= 10 USDC, cap 3 wins на пару адресов.
// uniqueActiveUsers — счётчик уникальных адресов с XP > 0 (триггер DAO).
// ============================================================

import "../RegistryFacet.sol"; // RegistryStorage — для верификации соглашений

interface IAgreementView {
    function status()   external view returns (uint8);
    function amount()   external view returns (uint256);
    function client()   external view returns (address);
    function executor() external view returns (address);
}

// ---------- STORAGE ----------

library ReputationStorage {
    bytes32 constant POSITION = keccak256("hexseal.reputation.storage");

    struct Data {
        mapping(address => uint256) xp;
        mapping(address => uint256) volumeXPAccrued;   // для cap MAX_VOLUME_XP на адрес
        mapping(address => bool)    clientClaimed;     // agreement → клиент уже заклеймил XP
        mapping(address => bool)    executorClaimed;   // agreement → исполнитель уже заклеймил XP
        mapping(address => bool)    pairCounted;       // agreement → пара уже оценена (первый claimer)
        mapping(address => bool)    dealIsWin;         // agreement → сделка засчитана как победа
        mapping(bytes32 => uint256) pairWins;          // keccak(sortedPair) → кол-во побед
        mapping(address => bool)    hasEarnedXP;       // для uniqueActiveUsers
        uint256                     uniqueActiveUsers;
    }

    function data() internal pure returns (Data storage d) {
        bytes32 pos = POSITION;
        assembly { d.slot := pos }
    }
}

// ---------- FACET ----------

contract ReputationFacet {

    // -------- CONSTANTS --------

    uint256 private constant WIN_XP         = 100;
    uint256 private constant MIN_WIN_AMOUNT = 10_000_000; // 10 USDC (6 decimals)
    uint256 private constant MAX_WINS_PAIR  = 3;
    uint256 private constant MAX_VOLUME_XP  = 300;

    // Agreement.sol 7-state enum
    uint8 private constant STATUS_COMPLETED = 3;
    uint8 private constant STATUS_RESOLVED  = 5;

    // -------- EVENTS --------

    event XPClaimed(address indexed agreement, address indexed claimant, uint256 xpGained);

    // -------- ERRORS --------

    error AgreementNotRegistered();
    error DealNotEligible();
    error NotParty();
    error AlreadyClaimed();

    // -------- ACTIONS --------

    /// @notice Заклеймить XP за завершённую сделку. Вызывать может только клиент или исполнитель.
    /// Каждая сторона вызывает отдельно. Pair cap оценивается при первом вызове.
    function claimXP(address agreement) external {
        ReputationStorage.Data storage d = ReputationStorage.data();

        // Verify: agreement должен быть в реестре Hexseal
        if (RegistryStorage.layout().agreements[agreement].agreement != agreement)
            revert AgreementNotRegistered();

        IAgreementView agmt = IAgreementView(agreement);
        uint8   st  = agmt.status();
        uint256 amt = agmt.amount();
        address cli = agmt.client();
        address exc = agmt.executor();

        // Только COMPLETED(3) или RESOLVED(5)
        if (st != STATUS_COMPLETED && st != STATUS_RESOLVED) revert DealNotEligible();

        // Только участник сделки
        address caller = msg.sender;
        if (caller != cli && caller != exc) revert NotParty();

        // Проверка и запись клейма
        bool isClient = (caller == cli);
        if (isClient) {
            if (d.clientClaimed[agreement]) revert AlreadyClaimed();
            d.clientClaimed[agreement] = true;
        } else {
            if (d.executorClaimed[agreement]) revert AlreadyClaimed();
            d.executorClaimed[agreement] = true;
        }

        // Первый claimer оценивает pair cap (один раз на сделку)
        if (!d.pairCounted[agreement]) {
            d.pairCounted[agreement] = true;
            if (amt >= MIN_WIN_AMOUNT) {
                bytes32 pk = _pairKey(cli, exc);
                if (d.pairWins[pk] < MAX_WINS_PAIR) {
                    d.pairWins[pk]++;
                    d.dealIsWin[agreement] = true;
                }
            }
        }

        uint256 xpGain = d.dealIsWin[agreement] ? WIN_XP : 0;

        // Volume XP: +1 за каждые $10 USDC, cap MAX_VOLUME_XP на адрес
        if (amt >= MIN_WIN_AMOUNT) {
            uint256 accrued = d.volumeXPAccrued[caller];
            if (accrued < MAX_VOLUME_XP) {
                uint256 volGain = _min(amt / 10_000_000, MAX_VOLUME_XP - accrued);
                xpGain += volGain;
                d.volumeXPAccrued[caller] = accrued + volGain;
            }
        }

        if (xpGain > 0) {
            if (!d.hasEarnedXP[caller]) {
                d.hasEarnedXP[caller] = true;
                d.uniqueActiveUsers++;
            }
            d.xp[caller] += xpGain;
        }

        emit XPClaimed(agreement, caller, xpGain);
    }

    // -------- VIEWS --------

    function getXP(address addr) external view returns (uint256) {
        return ReputationStorage.data().xp[addr];
    }

    function getUniqueActiveUsers() external view returns (uint256) {
        return ReputationStorage.data().uniqueActiveUsers;
    }

    /// @notice Проверить заклеймил ли claimant XP за конкретную сделку
    function hasClaimed(address agreement, address claimant) external view returns (bool) {
        ReputationStorage.Data storage d = ReputationStorage.data();
        try IAgreementView(agreement).client() returns (address cli) {
            return claimant == cli
                ? d.clientClaimed[agreement]
                : d.executorClaimed[agreement];
        } catch {
            return false;
        }
    }

    function isDealWin(address agreement) external view returns (bool) {
        return ReputationStorage.data().dealIsWin[agreement];
    }

    // -------- INTERNAL --------

    function _pairKey(address a, address b) internal pure returns (bytes32) {
        return a < b
            ? keccak256(abi.encodePacked(a, b))
            : keccak256(abi.encodePacked(b, a));
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
