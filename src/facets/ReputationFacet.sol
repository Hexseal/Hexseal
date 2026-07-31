// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// HEXSEAL — ReputationFacet.sol
//
// On-chain XP система. Пользователи клеймят XP после завершения сделки.
// Anti-gaming: deal >= 10 USDC, cap 3 wins на пару адресов.
// uniqueActiveUsers — счётчик уникальных адресов с XP > 0 (триггер DAO).
//
// Фаза 2 (xp >= PHASE2_XP_THRESHOLD): клиентский XP замораживается, XP
// исполнителя растёт только пока его cleanStreak (подряд идущие чистые
// закрытия) >= CLEAN_STREAK_REQUIRED — иначе капитал в одной крупной сделке
// покупал бы репутацию наравне с годами честной работы.
// ============================================================

import "../RegistryFacet.sol"; // RegistryStorage — для верификации соглашений

interface IAgreementView {
    function status()           external view returns (uint8);
    function amount()           external view returns (uint256);
    function client()           external view returns (address);
    function executor()         external view returns (address);
    function clientWonDispute() external view returns (bool);
}

// ---------- STORAGE ----------

library ReputationStorage {
    /// @custom:storage-location erc7201:hexseal.reputation.storage
    /// keccak256(abi.encode(uint256(keccak256("hexseal.reputation.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 constant POSITION = 0xa32193c5e38bd2de27c8550f156d709eafdc63aaa4290e5e27473f2ffc097400;

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
        mapping(address => uint256) cleanStreak;        // executor → подряд идущие чистые (без спора) закрытия
        mapping(address => bool)    streakEvaluated;    // agreement → cleanStreak уже обновлён по этой сделке
        // ── Споры, закончившиеся без вердикта ──
        // Считается ОБОИМ участникам. Это статистика, а не вердикт: при дележе
        // пополам виноватого не установил никто, а грифёр, который аккуратно
        // откликается, выглядит ровно как честный. Показывать долей от числа
        // сделок — один спор из пятидесяти шум, восемь из десяти портрет.
        mapping(address => uint256) unresolvedDisputes;
    }

    function data() internal pure returns (Data storage d) {
        bytes32 pos = POSITION;
        assembly { d.slot := pos }
    }
}

// ---------- FACET ----------

contract ReputationFacet {

    // -------- CONSTANTS --------

    uint256 private constant WIN_XP               = 100;
    uint256 private constant LOSS_XP_PENALTY       = WIN_XP / 2; // проигравший спор теряет половину XP, что дала бы победа — сигнал реален, но не убийственный
    uint256 private constant MIN_WIN_AMOUNT        = 10_000_000; // 10 USDC (6 decimals)
    uint256 private constant MAX_WINS_PAIR         = 3;
    uint256 private constant MAX_VOLUME_XP         = 300;
    uint256 private constant PHASE2_XP_THRESHOLD   = 1000; // выше этого — XP клиента заморожен, XP исполнителя гейтится серией
    uint256 private constant CLEAN_STREAK_REQUIRED = 10;   // подряд чистых закрытий для роста XP исполнителя после PHASE2_XP_THRESHOLD
    uint256 private constant MIN_COUNTERPARTY_XP   = 50;    // деал считается в cleanStreak/Phase-2 XP только если у контрагента уже есть эта репутация — не с этой же сделки

    // Agreement.sol 7-state enum
    uint8 private constant STATUS_COMPLETED = 3;
    uint8 private constant STATUS_RESOLVED  = 5;

    // -------- EVENTS --------

    event XPClaimed(address indexed agreement, address indexed claimant, uint256 xpGained);
    event XPPenalized(address indexed agreement, address indexed loser, uint256 xpLost);

    // -------- ERRORS --------

    error AgreementNotRegistered();
    error DealNotEligible();
    error NotParty();
    error AlreadyClaimed();
    error NotAgreement();

    // -------- ACTIONS --------

    /// @notice Автоматически начислить XP обеим сторонам при завершении сделки.
    /// Вызывается самим Agreement через Diamond (msg.sender == agreement).
    /// Только для COMPLETED и RESOLVED — не для REFUNDED.
    /// На RESOLVED (спор) XP получает только выигравшая сторона, проигравшая — теряет часть XP:
    /// иначе исполнитель, проваливший сделку и проигравший арбитраж, получал репутацию наравне
    /// с честно закрытой сделкой.
    function autoAwardXP(address agreement) external {
        if (msg.sender != agreement) revert NotAgreement();
        if (RegistryStorage.store().agreements[agreement].agreement != agreement)
            revert AgreementNotRegistered();

        IAgreementView agmt = IAgreementView(agreement);
        address cli = agmt.client();
        address exc = agmt.executor();
        uint256 amt = agmt.amount();
        uint8   st  = agmt.status();

        ReputationStorage.Data storage d = ReputationStorage.data();

        if (d.clientClaimed[agreement] && d.executorClaimed[agreement]) return;

        // Snapshotted once, before either side's XP is touched below — _awardXP runs
        // twice in this same transaction (client then executor), and a live re-read of
        // d.xp[cli] on the second call would see the client's own just-granted Phase-1
        // XP from THIS deal, defeating the "counterparty had PRIOR standing" requirement.
        bool counterpartyQualified = d.xp[cli] >= MIN_COUNTERPARTY_XP;

        _evalPairCap(d, agreement, cli, exc, amt);
        _evalStreakOnce(d, agreement, st, exc, counterpartyQualified, agmt);

        if (st == STATUS_RESOLVED) {
            bool clientWon = agmt.clientWonDispute();
            (address winner, address loser) = clientWon ? (cli, exc) : (exc, cli);
            if (!d.clientClaimed[agreement]) d.clientClaimed[agreement] = true;
            if (!d.executorClaimed[agreement]) d.executorClaimed[agreement] = true;
            _awardXP(d, agreement, winner, exc, counterpartyQualified, amt);
            _penalizeXP(d, agreement, loser);
        } else {
            if (!d.clientClaimed[agreement]) {
                d.clientClaimed[agreement] = true;
                _awardXP(d, agreement, cli, exc, counterpartyQualified, amt);
            }
            if (!d.executorClaimed[agreement]) {
                d.executorClaimed[agreement] = true;
                _awardXP(d, agreement, exc, exc, counterpartyQualified, amt);
            }
        }
    }

    /// @notice Ручной клейм XP за старые сделки (до autoAwardXP). Fallback для legacy deals.
    /// Каждая сторона вызывает отдельно. Pair cap оценивается при первом вызове.
    function claimXP(address agreement) external {
        ReputationStorage.Data storage d = ReputationStorage.data();

        if (RegistryStorage.store().agreements[agreement].agreement != agreement)
            revert AgreementNotRegistered();

        IAgreementView agmt = IAgreementView(agreement);
        uint8   st  = agmt.status();
        uint256 amt = agmt.amount();
        address cli = agmt.client();
        address exc = agmt.executor();

        if (st != STATUS_COMPLETED && st != STATUS_RESOLVED) revert DealNotEligible();

        address caller = msg.sender;
        if (caller != cli && caller != exc) revert NotParty();

        bool isClient = (caller == cli);
        if (isClient) {
            if (d.clientClaimed[agreement]) revert AlreadyClaimed();
            d.clientClaimed[agreement] = true;
        } else {
            if (d.executorClaimed[agreement]) revert AlreadyClaimed();
            d.executorClaimed[agreement] = true;
        }

        bool counterpartyQualified = d.xp[cli] >= MIN_COUNTERPARTY_XP;

        _evalPairCap(d, agreement, cli, exc, amt);
        _evalStreakOnce(d, agreement, st, exc, counterpartyQualified, agmt);

        if (st == STATUS_RESOLVED && agmt.clientWonDispute() != isClient) {
            _penalizeXP(d, agreement, caller);
        } else {
            _awardXP(d, agreement, caller, exc, counterpartyQualified, amt);
        }
    }

    /// @notice Вызывается Agreement при таймауте активации/дедлайна (вина исполнителя) —
    /// обнуляет его чистую серию. Никогда не вызывается при arbiter-таймауте (не его вина).
    function notifyExecutorFault(address agreement) external {
        if (msg.sender != agreement) revert NotAgreement();
        if (RegistryStorage.store().agreements[agreement].agreement != agreement)
            revert AgreementNotRegistered();

        address exc = IAgreementView(agreement).executor();
        ReputationStorage.data().cleanStreak[exc] = 0;
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

    function getCleanStreak(address addr) external view returns (uint256) {
        return ReputationStorage.data().cleanStreak[addr];
    }

    /// @notice Сколько споров у адреса закончилось без вердикта (таймаут — дележ
    /// пополам или 75/25 без ответа). Считается обоим участникам сделки; не
    /// вердикт и не обвинение, см. комментарий у поля unresolvedDisputes.
    function getUnresolvedDisputes(address who) external view returns (uint256) {
        return ReputationStorage.data().unresolvedDisputes[who];
    }

    // -------- INTERNAL --------

    function _evalPairCap(
        ReputationStorage.Data storage d,
        address agreement,
        address cli,
        address exc,
        uint256 amt
    ) private {
        if (d.pairCounted[agreement]) return;
        d.pairCounted[agreement] = true;
        if (amt >= MIN_WIN_AMOUNT) {
            bytes32 pk = _pairKey(cli, exc);
            if (d.pairWins[pk] < MAX_WINS_PAIR) {
                d.pairWins[pk]++;
                d.dealIsWin[agreement] = true;
            }
        }
    }

    /// @notice Обновляет чистую серию исполнителя ровно один раз на сделку, независимо от
    /// того, сколько раз autoAwardXP/claimXP вызваны для неё (claimXP вызывается отдельно
    /// каждой стороной). COMPLETED — сделка вообще не могла уйти в спор, значит чистая:
    /// +1, но только если контрагент этой сделки уже имел xp >= MIN_COUNTERPARTY_XP до неё —
    /// иначе sybil-кольцо свежих кошельков могло бы бесплатно набить серию друг на друге.
    /// Квалификация снимается один раз перед любыми награждениями в этой транзакции (в
    /// autoAwardXP клиент награждается первым, увеличивая d.xp[cli], поэтому второе чтение
    /// executor-ом видело бы уже изменённый баланс). RESOLVED — спор был; исполнитель
    /// проиграл: обнуление; выиграл: без изменений.
    function _evalStreakOnce(
        ReputationStorage.Data storage d,
        address agreement,
        uint8 st,
        address exc,
        bool counterpartyQualified,
        IAgreementView agmt
    ) private {
        if (d.streakEvaluated[agreement]) return;
        d.streakEvaluated[agreement] = true;

        if (st == STATUS_COMPLETED) {
            if (counterpartyQualified) {
                d.cleanStreak[exc]++;
            }
        } else if (st == STATUS_RESOLVED && agmt.clientWonDispute()) {
            d.cleanStreak[exc] = 0;
        }
    }

    /// @notice Начисляет XP по обычной формуле (_addXP), но гейтит начисление выше
    /// PHASE2_XP_THRESHOLD: клиент выше порога больше не получает XP вообще, исполнитель —
    /// только пока его cleanStreak >= CLEAN_STREAK_REQUIRED И контрагент этой конкретной
    /// сделки уже имел xp >= MIN_COUNTERPARTY_XP до неё (не результат этой же сделки) —
    /// без этой второй проверки можно было бы один раз честно набить серию, а затем
    /// фармить оставшийся Phase-2 XP на собственных sybil-кошельках. Квалификация
    /// контрагента снимается один раз перед любыми награждениями в этой транзакции
    /// (в autoAwardXP клиент награждается первым).
    function _awardXP(
        ReputationStorage.Data storage d,
        address agreement,
        address recipient,
        address exc,
        bool counterpartyQualified,
        uint256 amt
    ) private {
        if (d.xp[recipient] >= PHASE2_XP_THRESHOLD) {
            if (recipient != exc) return;
            if (d.cleanStreak[recipient] < CLEAN_STREAK_REQUIRED) return;
            if (!counterpartyQualified) return;
        }
        _addXP(d, agreement, recipient, amt);
    }

    function _addXP(
        ReputationStorage.Data storage d,
        address agreement,
        address recipient,
        uint256 amt
    ) private {
        uint256 xpGain = d.dealIsWin[agreement] ? WIN_XP : 0;

        if (amt >= MIN_WIN_AMOUNT) {
            uint256 accrued = d.volumeXPAccrued[recipient];
            if (accrued < MAX_VOLUME_XP) {
                uint256 volGain = _min(amt / 10_000_000, MAX_VOLUME_XP - accrued);
                xpGain += volGain;
                d.volumeXPAccrued[recipient] = accrued + volGain;
            }
        }

        if (xpGain > 0) {
            if (!d.hasEarnedXP[recipient]) {
                d.hasEarnedXP[recipient] = true;
                d.uniqueActiveUsers++;
            }
            d.xp[recipient] += xpGain;
            emit XPClaimed(agreement, recipient, xpGain);
        }
    }

    /// @notice Списывает XP проигравшей стороне спора. Тот же порог, что и для побед
    /// (>=10 USDC, cap 3 события на пару через dealIsWin) — иначе можно было бы фармить
    /// чужой рейтинг вниз серией мелких проигранных споров. Никогда не уводит xp[loser] в минус.
    function _penalizeXP(
        ReputationStorage.Data storage d,
        address agreement,
        address loser
    ) private {
        if (!d.dealIsWin[agreement]) return;

        uint256 current = d.xp[loser];
        uint256 penalty = _min(LOSS_XP_PENALTY, current);
        if (penalty == 0) return;

        d.xp[loser] = current - penalty;
        emit XPPenalized(agreement, loser, penalty);
    }

    function _pairKey(address a, address b) internal pure returns (bytes32) {
        return a < b
            ? keccak256(abi.encodePacked(a, b))
            : keccak256(abi.encodePacked(b, a));
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
