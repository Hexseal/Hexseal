// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// HEXSEAL — ArbiterRegistryFacet.sol
//
// Реестр арбитров + DAO-режим + Diamond-as-arbiter + вознаграждения
//
// Архитектура:
//   1. Арбитр клеймит спор через commit-reveal → Diamond становится арбитром в Agreement
//   2. Арбитр вызывает submitVerdict(agreement, clientWins) → вердикт в очереди
//   3. Любой вызывает finalizeVerdict(agreement) → Diamond исполняет resolveDispute
//   4. Owner/DAO может overturnVerdict до финализации → slash XP арбитра, выплата не идёт
//
// FeeVault: owner пополняет вручную, при каждой финализации арбитру начисляется
//   rewardPerDispute USDC, арбитр забирает через withdrawArbiterReward().
//
// DAO-режим: когда uniqueActiveUsers >= 100,000 ИЛИ owner.activateDAO() —
//   пользователи с XP >= 3000 могут сами вступить через applyAsArbiter().
// ============================================================

import "../../src/FactoryFacet.sol";         // FactoryStorage (trustedForwarder, usdc)
import "../../src/DiamondProxy.sol";          // OwnershipLib
import "../../src/facets/ReputationFacet.sol"; // ReputationStorage (XP + cleanStreak + uniqueActiveUsers)
import "../RegistryFacet.sol";                // RegistryStorage — verifying notifyArbiterTimeout's caller

// ---------- INTERFACES ----------

interface IAgreementStatus {
    function status()    external view returns (uint8);
    function setArbiter(address newArbiter) external;
    function client()    external view returns (address);
    function executor()  external view returns (address);
    function amount()    external view returns (uint256);
    function disputedAt() external view returns (uint256);
}

interface IUSDCFull {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

// ---------- STORAGE ----------

library ArbiterRegistryStorage {
    bytes32 constant POSITION = keccak256("hexseal.arbiterregistry.storage");

    struct PendingVerdict {
        address arbiter;        // кто подал вердикт
        bool    clientWins;     // результат
        uint256 submittedAt;    // timestamp подачи
        bool    frozen;         // заморожен owner/DAO (нельзя финализировать)
        bool    finalized;      // исполнен на Agreement
        bool    overturned;     // отменён owner/DAO (выплата не идёт, XP срезан)
        bool    executing;      // идёт finalizeVerdict — не удалять через clearDisputeClaim
    }

    struct Data {
        mapping(address => bool)     isArbiter;
        address[]                    arbiterList;
        mapping(address => address)  disputeClaims;      // agreement → arbiter
        mapping(address => address[]) arbiterDeals;
        mapping(bytes32 => uint256)  claimCommitments;
        address                      chiefArbiter;
        bool                         daoActiveManual;
        // ── Diamond-as-arbiter + rewards ──
        mapping(address => PendingVerdict) pendingVerdicts;  // agreement → verdict
        mapping(address => uint256)        arbiterRewards;   // arbiter → USDC claimable
        uint256                            rewardPerDispute; // USDC per resolved dispute (default 5 USDC)
        uint256                            vaultBalance;     // USDC held by Diamond for rewards
        address                            daoAddress;       // future DAO governance contract
        // ── Provisional status ──
        mapping(address => uint256)        arbiterMistakeStreak; // arbiter → подряд идущие судейские ошибки
        // ── Sybil-resistance: forfeitable bond ──
        mapping(address => uint256)        arbiterBond;           // arbiter → залоченный USDC-бонд
        mapping(address => uint256)        openClaimCount;        // arbiter → сколько споров сейчас забрано и не закрыто
    }

    function data() internal pure returns (Data storage d) {
        bytes32 pos = POSITION;
        assembly { d.slot := pos }
    }
}

// ---------- FACET ----------

contract ArbiterRegistryFacet {

    // -------- CONSTANTS --------

    uint256 private constant COMMIT_MAX_BLOCKS  = 50;         // ~100s на Base
    uint256 private constant DAO_THRESHOLD      = 100_000;   // uniqueActiveUsers для авто-DAO
    uint256 private constant MIN_XP_TO_REGISTER = 3_000;     // ~30 сделок с разными людьми
    uint256 private constant OVERTURN_XP_SLASH  = 200;       // XP штраф при overturn
    uint256 private constant DEFAULT_REWARD      = 5_000_000; // 5 USDC (6 decimals)
    uint256 private constant FINALIZE_DELAY      = 1 hours;   // окно для owner/DAO чтобы overturn до финализации

    uint256 private constant MIN_CLEAN_STREAK_TO_REGISTER = 10;   // та же серия, что держит XP исполнителя выше 1000
    uint256 private constant MAX_ARBITER_MISTAKES         = 3;    // подряд ошибок до снятия статуса
    uint256 private constant DEMOTION_XP_RESET            = 2500; // фиксированный сброс при снятии — не вычитание
    uint256 private constant ARBITER_BOND                 = 50_000_000; // 50 USDC (6 decimals) — форфейтится при демоушене, возвращается при resignAsArbiter()

    // -------- EVENTS --------

    event ArbiterAdded(address indexed arbiter);
    event ArbiterRemoved(address indexed arbiter);
    event ChiefArbiterSet(address indexed prev, address indexed next);
    event DisputeClaimCommitted(address indexed arbiter, bytes32 indexed commitment);
    event DisputeClaimed(address indexed agreement, address indexed arbiter);
    event DisputeReleased(address indexed agreement, address indexed prevArbiter);
    event DAOActivated(address indexed by);
    event ArbiterApplied(address indexed arbiter);
    event VerdictSubmitted(address indexed agreement, address indexed arbiter, bool clientWins);
    event VerdictFinalized(address indexed agreement, address indexed arbiter, bool clientWins);
    event VerdictFrozen(address indexed agreement);
    event VerdictUnfrozen(address indexed agreement);
    event VerdictOverturned(address indexed agreement, address indexed arbiter, bool newClientWins);
    event ArbiterRewarded(address indexed arbiter, uint256 amount);
    event ArbiterRewardWithdrawn(address indexed arbiter, uint256 amount);
    event VaultFunded(address indexed by, uint256 amount);
    event RewardPerDisputeUpdated(uint256 newReward);
    event DAOAddressSet(address indexed daoAddress);
    event StuckVerdictAutoCleared(address indexed agreement);
    event ArbiterDemoted(address indexed arbiter);
    event ArbiterResigned(address indexed arbiter, uint256 bondRefunded);

    // -------- ERRORS --------

    error NotOwner();
    error NotOwnerOrChief();
    error NotOwnerOrDAO();
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
    error DAONotActive();
    error InsufficientXP(uint256 have, uint256 need);
    error NoVerdict();
    error AlreadyFinalized();
    error VerdictFrozenError();
    error VerdictAlreadySubmitted();
    error NotTheClaimer();
    error VaultInsufficient();
    error NoRewardToClaim();
    error ZeroAddress();
    error InsufficientCleanStreak(uint256 have, uint256 need);
    error HasOpenDisputeClaims();

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

    modifier onlyOwnerOrDAO() {
        address dao = ArbiterRegistryStorage.data().daoAddress;
        if (msg.sender != OwnershipLib.contractOwner() && msg.sender != dao)
            revert NotOwnerOrDAO();
        _;
    }

    // -------- ERC-2771 SENDER --------

    function _msgSender() internal view returns (address sender) {
        address forwarder = FactoryStorage.store().trustedForwarder;
        if (msg.sender == forwarder && msg.data.length >= 20) {
            assembly { sender := shr(96, calldataload(sub(calldatasize(), 20))) }
        } else {
            sender = msg.sender;
        }
    }

    // -------- DAO MODE --------

    function activateDAO() external onlyOwner {
        ArbiterRegistryStorage.data().daoActiveManual = true;
        emit DAOActivated(msg.sender);
    }

    function applyAsArbiter() external {
        if (!isDaoActive()) revert DAONotActive();

        address caller = _msgSender();
        ReputationStorage.Data storage rep = ReputationStorage.data();
        uint256 xp = rep.xp[caller];
        if (xp < MIN_XP_TO_REGISTER) revert InsufficientXP(xp, MIN_XP_TO_REGISTER);
        uint256 streak = rep.cleanStreak[caller];
        if (streak < MIN_CLEAN_STREAK_TO_REGISTER) revert InsufficientCleanStreak(streak, MIN_CLEAN_STREAK_TO_REGISTER);

        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        if (d.isArbiter[caller]) revert AlreadyArbiter();

        address usdc = FactoryStorage.store().usdc;
        bool bondOk = IUSDCFull(usdc).transferFrom(caller, address(this), ARBITER_BOND);
        require(bondOk, "ArbiterRegistry: bond transfer failed");
        d.arbiterBond[caller] = ARBITER_BOND;

        d.isArbiter[caller] = true;
        d.arbiterList.push(caller);

        emit ArbiterAdded(caller);
        emit ArbiterApplied(caller);
    }

    /// @notice Самостоятельный выход из статуса арбитра, без штрафа. Возвращает бонд
    /// полностью. Без этого статус арбитра был бы дорогой в один конец для тех, кого
    /// никогда не демоушенили — бонд лочился бы навечно в момент, когда человек просто
    /// хочет остановиться.
    function resignAsArbiter() external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        if (!d.isArbiter[caller]) revert NotAnArbiter();
        if (d.openClaimCount[caller] > 0) revert HasOpenDisputeClaims();

        d.isArbiter[caller] = false;

        uint256 len = d.arbiterList.length;
        for (uint256 i = 0; i < len; i++) {
            if (d.arbiterList[i] == caller) {
                d.arbiterList[i] = d.arbiterList[len - 1];
                d.arbiterList.pop();
                break;
            }
        }

        uint256 bond = d.arbiterBond[caller];
        d.arbiterBond[caller] = 0;
        if (bond > 0) {
            address usdc = FactoryStorage.store().usdc;
            bool ok = IUSDCFull(usdc).transfer(caller, bond);
            require(ok, "ArbiterRegistry: bond refund failed");
        }

        emit ArbiterResigned(caller, bond);
    }

    // -------- ADMIN: MANAGE ARBITERS --------

    function setChiefArbiter(address arbiter) external onlyOwner {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        emit ChiefArbiterSet(d.chiefArbiter, arbiter);
        d.chiefArbiter = arbiter;
    }

    function addArbiter(address arbiter) external onlyOwnerOrChief {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        if (d.isArbiter[arbiter]) revert AlreadyArbiter();
        d.isArbiter[arbiter] = true;
        d.arbiterList.push(arbiter);
        emit ArbiterAdded(arbiter);
    }

    function removeArbiter(address arbiter) external onlyOwnerOrChief {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        if (!d.isArbiter[arbiter]) revert NotAnArbiter();
        d.isArbiter[arbiter] = false;
        uint256 len = d.arbiterList.length;
        for (uint256 i = 0; i < len; i++) {
            if (d.arbiterList[i] == arbiter) {
                d.arbiterList[i] = d.arbiterList[len - 1];
                d.arbiterList.pop();
                break;
            }
        }

        uint256 bond = d.arbiterBond[arbiter];
        if (bond > 0) {
            d.arbiterBond[arbiter] = 0;
            address usdc = FactoryStorage.store().usdc;
            bool ok = IUSDCFull(usdc).transfer(arbiter, bond);
            require(ok, "ArbiterRegistry: bond refund failed");
        }

        emit ArbiterRemoved(arbiter);
    }

    // -------- ARBITER: CLAIM DISPUTE --------

    function commitDisputeClaim(bytes32 commitment) external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        if (!d.isArbiter[caller]) revert NotArbiter();
        d.claimCommitments[commitment] = block.number;
        emit DisputeClaimCommitted(caller, commitment);
    }

    /// @notice Клейм спора. Diamond устанавливается арбитром в Agreement (не сам арбитр).
    /// Это позволяет Diamond контролировать исполнение вердикта (задержка, overturn).
    function claimDispute(address agreement, bytes32 salt) external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        if (!d.isArbiter[caller]) revert NotArbiter();
        if (d.disputeClaims[agreement] != address(0)) revert AlreadyClaimed();

        bytes32 commitment = keccak256(abi.encodePacked(agreement, caller, salt));
        uint256 committedAt = d.claimCommitments[commitment];
        if (committedAt == 0) revert CommitmentNotFound();
        if (block.number <= committedAt) revert CommitmentTooEarly();
        if (block.number > committedAt + COMMIT_MAX_BLOCKS) revert CommitmentExpired();
        delete d.claimCommitments[commitment];

        (bool statusOk, bytes memory statusData) = agreement.staticcall(
            abi.encodeWithSignature("status()")
        );
        require(statusOk, "ArbiterRegistry: failed to read status");
        uint8 agreementStatus = abi.decode(statusData, (uint8));
        if (agreementStatus != 4) revert NotDisputed();

        // Арбитр не может быть стороной спора
        (bool clientOk, bytes memory clientData) = agreement.staticcall(abi.encodeWithSignature("client()"));
        (bool execOk,   bytes memory execData)   = agreement.staticcall(abi.encodeWithSignature("executor()"));
        require(clientOk && execOk, "ArbiterRegistry: failed to read parties");
        address agreementClient   = abi.decode(clientData,  (address));
        address agreementExecutor = abi.decode(execData,    (address));
        require(caller != agreementClient && caller != agreementExecutor, "ArbiterRegistry: arbiter is party");

        // Diamond становится арбитром в Agreement — это позволяет контролировать вердикт
        (bool setOk,) = agreement.call(
            abi.encodeWithSignature("setArbiter(address)", address(this))
        );
        require(setOk, "ArbiterRegistry: setArbiter failed");

        d.disputeClaims[agreement] = caller;
        d.arbiterDeals[caller].push(agreement);
        d.openClaimCount[caller]++;

        emit DisputeClaimed(agreement, caller);
    }

    function releaseDisputeClaim(address agreement) external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        address current = d.disputeClaims[agreement];
        if (current == address(0)) revert NotClaimed();
        if (caller != current && caller != OwnershipLib.contractOwner()) revert NotAuthorized();

        // Нельзя освободить клейм если вердикт уже подан (ждёт финализации)
        require(d.pendingVerdicts[agreement].submittedAt == 0, "ArbiterRegistry: verdict pending");

        delete d.disputeClaims[agreement];
        if (d.openClaimCount[current] > 0) d.openClaimCount[current]--;

        (bool ok,) = agreement.call(
            abi.encodeWithSignature("setArbiter(address)", address(0))
        );
        require(ok, "ArbiterRegistry: reset arbiter failed");

        emit DisputeReleased(agreement, current);
    }

    // -------- VERDICT FLOW --------

    /// @notice Арбитр подаёт вердикт. Ещё не исполняется — ждёт finalizeVerdict.
    function submitVerdict(address agreement, bool clientWins) external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        if (d.disputeClaims[agreement] != caller) revert NotTheClaimer();
        if (d.pendingVerdicts[agreement].submittedAt != 0) revert VerdictAlreadySubmitted();

        // Проверяем что соглашение ещё в споре
        (bool ok, bytes memory st) = agreement.staticcall(abi.encodeWithSignature("status()"));
        require(ok, "ArbiterRegistry: status read failed");
        require(abi.decode(st, (uint8)) == 4, "ArbiterRegistry: not disputed");

        d.pendingVerdicts[agreement] = ArbiterRegistryStorage.PendingVerdict({
            arbiter:     caller,
            clientWins:  clientWins,
            submittedAt: block.timestamp,
            frozen:      false,
            finalized:   false,
            overturned:  false,
            executing:   false
        });

        emit VerdictSubmitted(agreement, caller, clientWins);
    }

    /// @notice Исполнить вердикт. Любой может вызвать. Diamond вызывает resolveDispute на Agreement.
    /// Если вердикт заморожен (frozen) — ждём пока owner/DAO разморозит или отменит.
    function finalizeVerdict(address agreement) external {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        ArbiterRegistryStorage.PendingVerdict storage v = d.pendingVerdicts[agreement];

        if (v.submittedAt == 0) revert NoVerdict();
        if (v.finalized) revert AlreadyFinalized();
        if (v.frozen) revert VerdictFrozenError();
        require(block.timestamp >= v.submittedAt + FINALIZE_DELAY, "ArbiterRegistry: finalize delay not passed");

        // Защита от авто-удаления в clearDisputeClaim во время этого вызова
        v.executing = true;

        // Diamond (address(this)) вызывает resolveDispute — работает т.к. Diamond = arbiter
        (bool ok, bytes memory ret) = agreement.call(
            abi.encodeWithSignature("resolveDispute(bool)", v.clientWins)
        );

        v.executing = false; // всегда сбрасываем, даже при ревёрте

        if (!ok) {
            // пробросить причину ревёрта из Agreement
            assembly { revert(add(ret, 32), mload(ret)) }
        }

        v.finalized = true;

        // Вердикт дошёл до финализации без overturn — судейская ошибка не подтвердилась,
        // серия ошибок сбрасывается.
        if (!v.overturned) {
            d.arbiterMistakeStreak[v.arbiter] = 0;
        }

        // Начислить награду только если вердикт не отменён и в vault достаточно средств
        if (!v.overturned && d.vaultBalance >= d.rewardPerDispute && d.rewardPerDispute > 0) {
            d.arbiterRewards[v.arbiter] += d.rewardPerDispute;
            d.vaultBalance -= d.rewardPerDispute;
            emit ArbiterRewarded(v.arbiter, d.rewardPerDispute);
        }

        emit VerdictFinalized(agreement, v.arbiter, v.clientWins);
    }

    /// @notice Owner или DAO отменяют вердикт до финализации.
    /// Арбитр теряет XP и награду. Новый вердикт исполняется вместо старого.
    function overturnVerdict(address agreement, bool newClientWins) external onlyOwnerOrDAO {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        ArbiterRegistryStorage.PendingVerdict storage v = d.pendingVerdicts[agreement];

        if (v.submittedAt == 0) revert NoVerdict();
        if (v.finalized) revert AlreadyFinalized();

        address slashedArbiter = v.arbiter;
        v.clientWins = newClientWins;
        v.overturned = true;
        v.frozen     = false; // размораживаем чтобы можно было финализировать

        // Slash XP арбитра
        ReputationStorage.Data storage rep = ReputationStorage.data();
        if (rep.xp[slashedArbiter] >= OVERTURN_XP_SLASH) {
            rep.xp[slashedArbiter] -= OVERTURN_XP_SLASH;
        } else {
            rep.xp[slashedArbiter] = 0;
        }

        _recordArbiterMistake(d, rep, slashedArbiter);

        emit VerdictOverturned(agreement, slashedArbiter, newClientWins);
    }

    /// @notice Вызывается Agreement, когда арбитр не успел вынести вердикт за DISPUTE_WINDOW
    /// (triggerArbiterTimeout). Считается судейской ошибкой для демоушена (в отличие от
    /// overturnVerdict — XP при этом не режется, вердикт ведь не был неверным, его просто
    /// не было). Реальный арбитр читается из disputeClaims, а НЕ из Agreement.arbiter() —
    /// после claimDispute() тот указывает на сам Diamond (паттерн Diamond-as-arbiter для
    /// контроля вердикта), а не на человека, который забрал спор. Вызывается ДО
    /// _clearDisputeClaim() внутри triggerArbiterTimeout, так что запись ещё на месте.
    function notifyArbiterTimeout(address agreement) external {
        if (msg.sender != agreement) revert NotAuthorized();
        if (RegistryStorage.store().agreements[agreement].agreement != agreement) revert NotAuthorized();

        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        address arbiterAddr = d.disputeClaims[agreement];
        if (arbiterAddr == address(0)) return; // никто не забирал спор — не на кого списывать

        ReputationStorage.Data storage rep = ReputationStorage.data();
        _recordArbiterMistake(d, rep, arbiterAddr);
    }

    /// @notice Общий счётчик судейских ошибок для overturnVerdict и notifyArbiterTimeout.
    /// На 3-й подряд ошибке: статус снят, XP жёстко сброшен на DEMOTION_XP_RESET (не
    /// вычитание — одна и та же точка приземления вне зависимости от прежнего баланса),
    /// счётчик ошибок обнулён. cleanStreak (исполнительская серия) не трогается — судейство
    /// и исполнение заказов разные навыки.
    function _recordArbiterMistake(
        ArbiterRegistryStorage.Data storage d,
        ReputationStorage.Data storage rep,
        address arbiterAddr
    ) private {
        uint256 mistakes = d.arbiterMistakeStreak[arbiterAddr] + 1;
        d.arbiterMistakeStreak[arbiterAddr] = mistakes;

        if (mistakes >= MAX_ARBITER_MISTAKES) {
            d.isArbiter[arbiterAddr] = false;
            rep.xp[arbiterAddr] = DEMOTION_XP_RESET;
            d.arbiterMistakeStreak[arbiterAddr] = 0;

            uint256 forfeited = d.arbiterBond[arbiterAddr];
            if (forfeited > 0) {
                d.arbiterBond[arbiterAddr] = 0;
                d.vaultBalance += forfeited;
            }

            uint256 len = d.arbiterList.length;
            for (uint256 i = 0; i < len; i++) {
                if (d.arbiterList[i] == arbiterAddr) {
                    d.arbiterList[i] = d.arbiterList[len - 1];
                    d.arbiterList.pop();
                    break;
                }
            }

            emit ArbiterDemoted(arbiterAddr);
        }
    }

    /// @notice Заморозить вердикт (например пока идёт расследование).
    function freezeVerdict(address agreement) external onlyOwnerOrDAO {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        ArbiterRegistryStorage.PendingVerdict storage v = d.pendingVerdicts[agreement];
        if (v.submittedAt == 0) revert NoVerdict();
        if (v.finalized) revert AlreadyFinalized();
        v.frozen = true;
        emit VerdictFrozen(agreement);
    }

    /// @notice Разморозить вердикт.
    function unfreezeVerdict(address agreement) external onlyOwnerOrDAO {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        d.pendingVerdicts[agreement].frozen = false;
        emit VerdictUnfrozen(agreement);
    }

    // -------- REWARDS --------

    /// @notice Арбитр забирает накопленное вознаграждение.
    function withdrawArbiterReward() external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        uint256 amount = d.arbiterRewards[caller];
        if (amount == 0) revert NoRewardToClaim();

        d.arbiterRewards[caller] = 0;

        address usdc = FactoryStorage.store().usdc;
        bool ok = IUSDCFull(usdc).transfer(caller, amount);
        require(ok, "ArbiterRegistry: USDC transfer failed");

        emit ArbiterRewardWithdrawn(caller, amount);
    }

    /// @notice Owner пополняет vault (переводит USDC на Diamond).
    function fundVault(uint256 amount) external onlyOwner {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        address usdc = FactoryStorage.store().usdc;
        bool ok = IUSDCFull(usdc).transferFrom(msg.sender, address(this), amount);
        require(ok, "ArbiterRegistry: USDC transfer failed");
        d.vaultBalance += amount;
        emit VaultFunded(msg.sender, amount);
    }

    function setRewardPerDispute(uint256 amount) external onlyOwner {
        ArbiterRegistryStorage.data().rewardPerDispute = amount;
        emit RewardPerDisputeUpdated(amount);
    }

    function setDAOAddress(address dao) external onlyOwner {
        if (dao == address(0)) revert ZeroAddress();
        ArbiterRegistryStorage.data().daoAddress = dao;
        emit DAOAddressSet(dao);
    }

    // -------- AGREEMENT CALLBACKS --------

    function clearDisputeClaim(address agreement) external {
        require(msg.sender == agreement, "ArbiterRegistry: only agreement");
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        address claimedArbiter = d.disputeClaims[agreement];
        if (claimedArbiter != address(0)) {
            delete d.disputeClaims[agreement];
            if (d.openClaimCount[claimedArbiter] > 0) d.openClaimCount[claimedArbiter]--;
        }
        // Авто-очистка застрявшего вердикта: если Agreement вышел из спора через таймаут,
        // а вердикт ещё не финализирован и не исполняется прямо сейчас — удаляем.
        ArbiterRegistryStorage.PendingVerdict storage v = d.pendingVerdicts[agreement];
        if (v.submittedAt > 0 && !v.finalized && !v.executing) {
            delete d.pendingVerdicts[agreement];
            emit StuckVerdictAutoCleared(agreement);
        }
    }

    /// @notice Аварийная очистка застрявшего pending verdict.
    /// Возникает когда triggerArbiterTimeout исполняет Agreement до finalizeVerdict —
    /// Agreement уходит в REFUNDED, а pendingVerdicts остаётся висеть навечно.
    function clearStuckVerdict(address agreement) external {
        if (msg.sender != OwnershipLib.contractOwner()) revert NotOwner();
        // Убеждаемся что Agreement уже в терминальном состоянии (не DISPUTED = 4)
        (bool ok, bytes memory st) = agreement.staticcall(abi.encodeWithSignature("status()"));
        require(ok, "ArbiterRegistry: status read failed");
        require(abi.decode(st, (uint8)) != 4, "ArbiterRegistry: agreement still disputed");
        delete ArbiterRegistryStorage.data().pendingVerdicts[agreement];
    }

    // -------- VIEWS --------

    function isDaoActive() public view returns (bool) {
        if (ArbiterRegistryStorage.data().daoActiveManual) return true;
        return ReputationStorage.data().uniqueActiveUsers >= DAO_THRESHOLD;
    }

    function getMinXPToRegister() external pure returns (uint256) { return MIN_XP_TO_REGISTER; }
    function getDaoThreshold()    external pure returns (uint256) { return DAO_THRESHOLD; }

    function getChiefArbiter()  external view returns (address) { return ArbiterRegistryStorage.data().chiefArbiter; }
    function isRegisteredArbiter(address addr) external view returns (bool) { return ArbiterRegistryStorage.data().isArbiter[addr]; }
    function getArbiters()      external view returns (address[] memory) { return ArbiterRegistryStorage.data().arbiterList; }
    function getDisputeClaimer(address agreement) external view returns (address) { return ArbiterRegistryStorage.data().disputeClaims[agreement]; }
    function getArbiterDeals(address arbiter) external view returns (address[] memory) { return ArbiterRegistryStorage.data().arbiterDeals[arbiter]; }
    function getClaimCommitment(bytes32 c) external view returns (uint256) { return ArbiterRegistryStorage.data().claimCommitments[c]; }

    function getPendingVerdict(address agreement) external view returns (ArbiterRegistryStorage.PendingVerdict memory) {
        return ArbiterRegistryStorage.data().pendingVerdicts[agreement];
    }

    function getArbiterReward(address arbiter) external view returns (uint256) { return ArbiterRegistryStorage.data().arbiterRewards[arbiter]; }
    function getVaultBalance()  external view returns (uint256) { return ArbiterRegistryStorage.data().vaultBalance; }
    function getRewardPerDispute() external view returns (uint256) { return ArbiterRegistryStorage.data().rewardPerDispute; }
    function getDAOAddress()    external view returns (address) { return ArbiterRegistryStorage.data().daoAddress; }
    function getArbiterMistakeStreak(address addr) external view returns (uint256) { return ArbiterRegistryStorage.data().arbiterMistakeStreak[addr]; }
    function getArbiterBond(address addr) external view returns (uint256) { return ArbiterRegistryStorage.data().arbiterBond[addr]; }
    function getOpenClaimCount(address addr) external view returns (uint256) { return ArbiterRegistryStorage.data().openClaimCount[addr]; }
}
