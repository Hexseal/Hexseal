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
// FeeVault: owner пополняет вручную (fundVault) и вручную же выставляет ставку
//   (setRewardPerDispute); при финализации арбитру начисляется rewardPerDispute
//   USDC, арбитр забирает через withdrawArbiterReward(). Сегодня банк не наполнен
//   и ставка не выставлена — DeployFull не вызывает ни fundVault, ни
//   setRewardPerDispute, поэтому rewardPerDispute == 0 и арбитраж де-факто
//   неоплачиваемый. Постоянную модель оплаты (3% от спорной суммы) закрывает
//   docs/superpowers/specs/2026-07-22-arbiter-economics-design.md.
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
    /// @custom:storage-location erc7201:hexseal.arbiterregistry.storage
    /// keccak256(abi.encode(uint256(keccak256("hexseal.arbiterregistry.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 constant POSITION = 0xaae71de0594cbcb5434f0ab7f7501c1be178552bf788b418a1c2624ba9718d00;

    struct PendingVerdict {
        address arbiter;        // кто подал вердикт
        bool    clientWins;     // результат
        uint256 submittedAt;    // timestamp подачи
        bool    frozen;         // заморожен owner/DAO (нельзя финализировать)
        bool    finalized;      // исполнен на Agreement
        bool    overturned;     // отменён owner/DAO (выплата не идёт, XP срезан)
        bool    executing;      // идёт finalizeVerdict — не удалять через clearDisputeClaim
        // ── User-initiated appeal (pre-finalization only) ──
        bool    appealed;        // апелляция подана
        bool    appealResolved;  // голосование по апелляции завершено
        address appellant;       // кто подал апелляцию — для рефанда/форфейта депозита
        uint256 appealDeadline;  // дедлайн окна голосования
        uint256 votesUphold;     // голосов "оставить как есть"
        uint256 votesOverturn;   // голосов "перевернуть"
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
        // ── Appeal voting ──
        mapping(address => mapping(address => bool)) hasVotedAppeal; // agreement → arbiter → уже проголосовал
        // ── Dispute settlement fee (3% от спорной суммы, считает Agreement) ──
        // Доля казны со споров (20% сбора). Начисляется, а не переводится в
        // момент расчёта: заблокированный feeRecipient иначе ронял бы каждый спор.
        uint256                            treasurySlice;
        // ── Платный вызов арбитра ──
        // Доплата до рабочего порога: на мелком котле 80% от 3% сбора не
        // окупают даже пятнадцати минут чтения, и спор никто не берёт.
        // Платит сторона, которой нужен судья, поэтому дотация из общего
        // банка с её фармом не требуется.
        mapping(address => uint256)        disputeBounty;      // сделка → внесённая доплата
        mapping(address => address)        disputeBountyPayer; // сделка → кто внёс
        uint256                            arbiterFloor;       // сколько арбитр должен получить суммарно
        // Мягкий возврат доплаты: clearDisputeClaim толкает transfer() и, если
        // он не доставился (чёрный список USDC у плательщика), не ревертит —
        // Agreement зовёт эту функцию внутри пустого try/catch (Agreement.sol,
        // _clearDisputeClaim), и жёсткий реверт здесь утащил бы за собой снятие
        // клейма и уменьшение openClaimCount молча. Недоставленное складывается
        // сюда и вытягивается через withdrawDisputeBounty().
        mapping(address => uint256)        refundableBounty;   // плательщик → не доставленный возврат, забирается сам
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
    // Нигде не используется: награда сегодня берётся из d.rewardPerDispute (storage),
    // а не отсюда. Оставлено как floor будущей формулы «3% от спорной суммы» —
    // docs/superpowers/specs/2026-07-22-arbiter-economics-design.md §3.
    uint256 private constant DEFAULT_REWARD      = 5_000_000; // 5 USDC (6 decimals)
    uint256 private constant FINALIZE_DELAY      = 24 hours;  // окно для owner/DAO/апелляции до финализации (было 1 час — недостаточно для обычного пользователя)

    uint256 private constant MIN_CLEAN_STREAK_TO_REGISTER = 10;   // та же серия, что держит XP исполнителя выше 1000
    uint256 private constant MAX_ARBITER_MISTAKES         = 3;    // подряд ошибок до снятия статуса
    uint256 private constant DEMOTION_XP_RESET            = 2500; // фиксированный сброс при снятии — не вычитание
    uint256 private constant ARBITER_BOND                 = 50_000_000; // 50 USDC (6 decimals) — форфейтится при демоушене, возвращается при resignAsArbiter()

    uint256 private constant APPEAL_REVIEW_WINDOW = 4 days;     // столько же, сколько DISPUTE_WINDOW даёт арбитру
    uint256 private constant APPEAL_MIN_VOTES     = 3;          // кворум других арбитров
    uint256 private constant APPEAL_DEPOSIT       = 20_000_000; // 20 USDC (6 decimals) — flat, НЕ % от суммы сделки

    uint256 private constant ARBITER_SHARE_BPS = 8_000; // 80% сбора арбитру, остаток казне

    uint256 private constant DEFAULT_ARBITER_FLOOR = 10_000_000; // 10 USDC (6 decimals)

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
    event AppealRaised(address indexed agreement, address indexed appellant);
    event AppealVoteCast(address indexed agreement, address indexed arbiter, bool overturn);
    event AppealResolved(address indexed agreement, address indexed appellant, bool overturned);
    event ArbiterDemoted(address indexed arbiter);
    event ArbiterResigned(address indexed arbiter, uint256 bondRefunded);
    event DisputeFeeCredited(address indexed arbiter, uint256 toArbiter, uint256 toTreasury);
    event TreasurySlicePushed(address indexed to, uint256 amount);
    event ArbiterFloorUpdated(uint256 amount);
    event DisputeBountyFunded(address indexed agreement, address indexed payer, uint256 amount);
    event DisputeBountyRefunded(address indexed agreement, address indexed payer, uint256 amount);
    event DisputeBountyRefundable(address indexed agreement, address indexed payer, uint256 amount);
    event DisputeBountyWithdrawn(address indexed payer, uint256 amount);

    // -------- ERRORS --------

    error NotOwner();
    error NotOwnerOrFeeRecipient();
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
    error DisputeWindowPassed();
    error NotLosingParty();
    error AlreadyAppealed();
    error AppealWindowClosed();
    error InsufficientArbitersForAppeal();
    error NoAppeal();
    error AlreadyVoted();
    error CannotVoteOnOwnVerdict();
    error AppealAlreadyResolved();
    error AppealWindowNotClosed();
    error AlreadyFinalized();
    error VerdictFrozenError();
    error VerdictAlreadySubmitted();
    error NotTheClaimer();
    error VaultInsufficient();
    error NoRewardToClaim();
    error ArbiterZeroAddress();
    error InsufficientCleanStreak(uint256 have, uint256 need);
    error HasOpenDisputeClaims();
    error AppealInProgress();
    error NotRegisteredAgreement();
    error NothingToPush();
    error ZeroAmount();
    // Название отражает актуальную охраняемую проверку: источник арбитра —
    // pendingVerdicts, значит гейт бьёт по отсутствию вердикта, а не клеймера
    // (клейм и вердикт разошлись после того, как аргумент арбитра убрали
    // из creditDisputeFee — см. комментарий над функцией).
    error NoVerdictSubmitted();
    error TopUpNotNeeded();
    error BountyAlreadyFunded();
    error DisputeAlreadyClaimed();
    error NotParty();

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

        // Клеймить после окна вердикта нельзя. submitVerdict всё равно откажет
        // (DisputeWindowPassed), так что поздний клейм не может привести к
        // вердикту — зато он выставляет arbiter в Agreement и тем самым
        // отменяет дележ котла пополам на таймауте. Без этой проверки сторона
        // с дружественным арбитром забирала бы весь котёл, ничего не доказав.
        (bool dOk, bytes memory dData) = agreement.staticcall(abi.encodeWithSignature("disputedAt()"));
        require(dOk, "ArbiterRegistry: disputedAt read failed");
        (bool wOk, bytes memory wData) = agreement.staticcall(abi.encodeWithSignature("DISPUTE_WINDOW()"));
        require(wOk, "ArbiterRegistry: DISPUTE_WINDOW read failed");
        if (block.timestamp > abi.decode(dData, (uint256)) + abi.decode(wData, (uint256))) {
            revert DisputeWindowPassed();
        }

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

        // Отпускать спор после закрытия окна нельзя, и по той же причине, по
        // которой нельзя его после окна клеймить: вердикт там уже невозможен
        // (submitVerdict откажет), перезаклеймить спор тоже нельзя — значит в
        // оборот поздний отпуск спор не возвращает.
        //
        // Вредит он дважды. Уводит от наказания: notifyArbiterTimeout читает
        // disputeClaims и по пустому ключу молча выходит, так что неявившийся
        // арбитр уходил без судейской ошибки. И переключает ветку таймаута —
        // setArbiter(0) ниже превращает полный возврат клиенту в дележ
        // пополам, чем мог бесплатно пользоваться арбитр, дружественный
        // исполнителю.
        //
        // Третий его эффект полезен, и мы его тут теряем: отпуск уменьшал
        // openClaimCount, то есть освобождал самого арбитра. Пока сторона не
        // дёрнет triggerArbiterTimeout, счётчик неявившегося остаётся занят, а
        // с ним заперт и выход из статуса вместе с бондом. Осознанный размен:
        // цена — 50 USDC у того, кто уже нарушил, и её отпирает владелец через
        // removeArbiter; дыра стоила бы половины любого спорного котла.
        // Подробности и кандидат на честное лекарство (`abandonClaim`, который
        // снимает счётчик, пишет ошибку и НЕ трогает Agreement.arbiter) —
        // docs/OPEN-ITEMS.md, пункт 11.
        //
        // Владелец диамонда (второй допустимый вызывающий выше) под гейт
        // попадает так же. Причина расклинить чужой счётчик у него как раз
        // есть, но исключение вернуло бы ровно эту дыру, поэтому расклинивает
        // он через removeArbiter, а не в обход гейта.
        (bool dOk, bytes memory dData) = agreement.staticcall(abi.encodeWithSignature("disputedAt()"));
        require(dOk, "ArbiterRegistry: disputedAt read failed");
        (bool wOk, bytes memory wData) = agreement.staticcall(abi.encodeWithSignature("DISPUTE_WINDOW()"));
        require(wOk, "ArbiterRegistry: DISPUTE_WINDOW read failed");
        if (block.timestamp > abi.decode(dData, (uint256)) + abi.decode(wData, (uint256))) {
            revert DisputeWindowPassed();
        }

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

        // Арбитр должен успеть подать вердикт за DISPUTE_WINDOW от disputedAt. Раньше эта
        // проверка жила в Agreement.resolveDispute() и срабатывала в момент ИСПОЛНЕНИЯ —
        // из-за FINALIZE_DELAY/апелляции исполнение легитимно происходит намного позже
        // подачи, так что единственное место, где время должно проверяться — подача.
        (bool disputedOk, bytes memory disputedData) = agreement.staticcall(abi.encodeWithSignature("disputedAt()"));
        require(disputedOk, "ArbiterRegistry: disputedAt read failed");
        uint256 disputedAt = abi.decode(disputedData, (uint256));

        (bool windowOk, bytes memory windowData) = agreement.staticcall(abi.encodeWithSignature("DISPUTE_WINDOW()"));
        require(windowOk, "ArbiterRegistry: DISPUTE_WINDOW read failed");
        uint256 disputeWindow = abi.decode(windowData, (uint256));

        if (block.timestamp > disputedAt + disputeWindow) revert DisputeWindowPassed();

        d.pendingVerdicts[agreement] = ArbiterRegistryStorage.PendingVerdict({
            arbiter:        caller,
            clientWins:     clientWins,
            submittedAt:    block.timestamp,
            frozen:         false,
            finalized:      false,
            overturned:     false,
            executing:      false,
            appealed:       false,
            appealResolved: false,
            appellant:      address(0),
            appealDeadline: 0,
            votesUphold:    0,
            votesOverturn:  0
        });

        emit VerdictSubmitted(agreement, caller, clientWins);
    }

    /// @notice Исполнить вердикт. Любой может вызвать. Diamond вызывает resolveDispute на Agreement.
    /// Если вердикт заморожен (frozen) — ждём пока owner/DAO разморозит или отменит.
    function finalizeVerdict(address agreement) external {
        if (agreement == address(0)) revert ArbiterZeroAddress();
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
        if (v.appealed && !v.appealResolved) revert AppealInProgress();

        address slashedArbiter = v.arbiter;
        v.clientWins = newClientWins;
        v.overturned = true;
        v.frozen     = false; // размораживаем чтобы можно было финализировать

        // Slash XP арбитра
        ReputationStorage.Data storage rep = ReputationStorage.data();
        _slashArbiterXP(rep, slashedArbiter);

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

    /// @notice Списывает OVERTURN_XP_SLASH у арбитра, не давая уйти в underflow.
    /// Общий хелпер для overturnVerdict и resolveAppeal (оба режут XP одинаково).
    function _slashArbiterXP(ReputationStorage.Data storage rep, address arbiterAddr) private {
        if (rep.xp[arbiterAddr] >= OVERTURN_XP_SLASH) {
            rep.xp[arbiterAddr] -= OVERTURN_XP_SLASH;
        } else {
            rep.xp[arbiterAddr] = 0;
        }
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
        ArbiterRegistryStorage.PendingVerdict storage v = d.pendingVerdicts[agreement];
        if (v.appealed && !v.appealResolved) revert AppealInProgress();
        v.frozen = false;
        emit VerdictUnfrozen(agreement);
    }

    // -------- APPEAL FLOW (user-initiated, pre-finalization only) --------

    /// @notice Проигравшая сторона оспаривает вердикт до того как деньги ушли исполнителю/клиенту.
    /// Требует APPEAL_DEPOSIT — флэт, не % от суммы сделки (сумма выбрана сторонами, ей нельзя
    /// доверять как входу для чего-либо, что можно проиграть/выиграть).
    function raiseAppeal(address agreement) external {
        if (agreement == address(0)) revert ArbiterZeroAddress();
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        ArbiterRegistryStorage.PendingVerdict storage v = d.pendingVerdicts[agreement];

        if (v.submittedAt == 0) revert NoVerdict();
        if (v.finalized) revert AlreadyFinalized();
        // Checked before `frozen`: raiseAppeal() itself sets frozen=true as a side effect, so
        // once appealed, frozen is always already true too — checking frozen first would make
        // AlreadyAppealed unreachable on a second call to this same function.
        if (v.appealed) revert AlreadyAppealed();
        if (v.frozen) revert VerdictFrozenError();
        if (block.timestamp >= v.submittedAt + FINALIZE_DELAY) revert AppealWindowClosed();

        (bool clientOk, bytes memory clientData) = agreement.staticcall(abi.encodeWithSignature("client()"));
        (bool execOk,   bytes memory execData)   = agreement.staticcall(abi.encodeWithSignature("executor()"));
        require(clientOk && execOk, "ArbiterRegistry: failed to read parties");
        address agreementClient   = abi.decode(clientData, (address));
        address agreementExecutor = abi.decode(execData,   (address));

        bool callerIsLosingClient   = caller == agreementClient   && !v.clientWins;
        bool callerIsLosingExecutor = caller == agreementExecutor &&  v.clientWins;
        if (!callerIsLosingClient && !callerIsLosingExecutor) revert NotLosingParty();

        uint256 eligibleVoters;
        uint256 len = d.arbiterList.length;
        for (uint256 i = 0; i < len; i++) {
            if (d.arbiterList[i] != v.arbiter) eligibleVoters++;
        }
        if (eligibleVoters < APPEAL_MIN_VOTES) revert InsufficientArbitersForAppeal();

        address usdc = FactoryStorage.store().usdc;
        bool ok = IUSDCFull(usdc).transferFrom(caller, address(this), APPEAL_DEPOSIT);
        require(ok, "ArbiterRegistry: deposit transfer failed");

        v.appealed       = true;
        v.frozen         = true;
        v.appellant      = caller;
        v.appealDeadline = block.timestamp + APPEAL_REVIEW_WINDOW;

        emit AppealRaised(agreement, caller);
    }

    /// @notice Любой зарегистрированный арбитр, кроме вынесшего вердикт, голосует один раз.
    function voteOnAppeal(address agreement, bool overturn) external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        ArbiterRegistryStorage.PendingVerdict storage v = d.pendingVerdicts[agreement];

        if (!d.isArbiter[caller]) revert NotArbiter();
        if (!v.appealed) revert NoAppeal();
        if (v.appealResolved) revert AppealAlreadyResolved();
        if (caller == v.arbiter) revert CannotVoteOnOwnVerdict();
        if (block.timestamp >= v.appealDeadline) revert AppealWindowClosed();
        if (d.hasVotedAppeal[agreement][caller]) revert AlreadyVoted();

        d.hasVotedAppeal[agreement][caller] = true;
        if (overturn) {
            v.votesOverturn++;
        } else {
            v.votesUphold++;
        }

        emit AppealVoteCast(agreement, caller, overturn);
    }

    /// @notice Подводит итог голосования по апелляции. Можно звать сразу как кворум
    /// (APPEAL_MIN_VOTES) набран — не дожидаясь конца окна. Если окно закрылось без
    /// кворума, апелляция отклоняется по умолчанию (не зависаем навечно).
    function resolveAppeal(address agreement) external {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        ArbiterRegistryStorage.PendingVerdict storage v = d.pendingVerdicts[agreement];

        if (!v.appealed) revert NoAppeal();
        if (v.appealResolved) revert AppealAlreadyResolved();

        bool quorumReached = v.votesUphold + v.votesOverturn >= APPEAL_MIN_VOTES;
        bool windowClosed  = block.timestamp >= v.appealDeadline;
        if (!quorumReached && !windowClosed) revert AppealWindowNotClosed();

        v.appealResolved = true;
        v.frozen         = false;

        bool overturn = quorumReached && v.votesOverturn > v.votesUphold;
        address usdc  = FactoryStorage.store().usdc;

        if (overturn) {
            address slashedArbiter = v.arbiter;
            v.clientWins = !v.clientWins;
            v.overturned = true;

            ReputationStorage.Data storage rep = ReputationStorage.data();
            _slashArbiterXP(rep, slashedArbiter);
            _recordArbiterMistake(d, rep, slashedArbiter);

            bool refundOk = IUSDCFull(usdc).transfer(v.appellant, APPEAL_DEPOSIT);
            require(refundOk, "ArbiterRegistry: deposit refund failed");
        } else {
            d.vaultBalance += APPEAL_DEPOSIT;
        }

        emit AppealResolved(agreement, v.appellant, overturn);
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

    /// @notice Зачислить сбор со спора. Агримент (Agreement.resolveDispute) зовёт
    /// эту функцию ДО перевода `total` на диамонд и переводит только если вызов
    /// не ревертнул — так провал зачисления не оставляет деньги на диамонде без
    /// единого счётчика, который на них указывает (см. Agreement.sol:resolveDispute).
    ///
    /// Почему не тянем сами через transferFrom: тогда агриментy пришлось бы
    /// выдавать разрешение, а при провале вызова оно осталось бы висеть — ровно
    /// тот дефект, который пришлось чинить в казне. Push-перевод (Agreement сам
    /// вызывает transfer(), диамонд не тянет через transferFrom) не оставляет
    /// разрешения вообще — это не зависит от того, что идёт первым, зачисление
    /// или перевод (сейчас первым идёт зачисление, см. комментарий выше).
    ///
    /// Доверие здесь ровно то же, что у updateStatus и notifyArbiterTimeout:
    /// вызывающий обязан быть зарегистрированным агриментом, а зарегистрировать
    /// может только фабрика.
    ///
    /// Аргумента-адреса арбитра НЕТ (и не было бы правильно его принимать):
    /// claimDispute() всегда ставит арбитром В АГРИМЕНТЕ сам диамонд
    /// (setArbiter(address(this)), Diamond-as-arbiter), поэтому Agreement.arbiter
    /// — это всегда 0 либо адрес диамонда, никогда не человек. Принять его
    /// параметром означало бы сжигать 80% каждого сбора на арбитра, у которого
    /// нет способа вызвать withdrawArbiterReward() от своего имени (тот читает
    /// _msgSender(), а заставить диамонд вызвать самого себя нечем).
    ///
    /// Источник настоящего арбитра — pendingVerdicts[msg.sender].arbiter, а НЕ
    /// disputeClaims[msg.sender]. Оба поля пишутся синхронно (submitVerdict
    /// требует caller == disputeClaims[agreement]) и до финализации не могут
    /// разойтись — но на момент, когда Agreement (Задача 3) реально вызовет эту
    /// функцию (изнутри finalizeVerdict → agreement.call(resolveDispute)),
    /// гарантия у pendingVerdicts сильнее: finalizeVerdict уже требует
    /// v.submittedAt != 0 (иначе revert NoVerdict до вызова) и держит
    /// v.executing = true всё время внешнего вызова — именно executing==true
    /// не даёт clearDisputeClaim() удалить pendingVerdicts в этом окне (это не
    /// единственное место, которое умеет удалить запись — clearStuckVerdict,
    /// :905-913, делает то же самое БЕЗ проверки !v.executing; его гейт
    /// require(status != DISPUTED) сам по себе здесь не защита — resolvedAt
    /// уже выставлен к этому моменту (Agreement.sol:665, до вызова), поэтому
    /// status() внутри этого окна уже вернул бы RESOLVED, а не DISPUTED, и
    /// gate его бы ПРОПУСТИЛ. Вклиниться невозможно по другой причине: всё
    /// окно — от resolvedAt до этого вызова — лежит внутри одной атомарной
    /// транзакции (finalizeVerdict → agreement.call(resolveDispute) →
    /// creditDisputeFee), а clearStuckVerdict — отдельный вызов от owner,
    /// которому просто негде исполниться между шагами чужой транзакции).
    /// disputeClaims такой защиты не имеет: clearDisputeClaim() чистит его
    /// безусловно, так что его целостность здесь зависела бы от того, что
    /// Agreement переведёт сбор и позовёт нас строго до _clearDisputeClaim() —
    /// то есть от порядка кода в чужой функции, а не от инварианта здесь.
    /// pendingVerdicts.arbiter не зависит от этого порядка ни при каком раскладе.
    function creditDisputeFee(uint256 total) external {
        if (RegistryStorage.store().agreements[msg.sender].client == address(0))
            revert NotRegisteredAgreement();
        if (total == 0) revert ZeroAmount();

        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        ArbiterRegistryStorage.PendingVerdict storage v = d.pendingVerdicts[msg.sender];

        address arbiter_ = v.arbiter;
        // Спор никто не довёл до вердикта (submitVerdict не звали) — зачислять
        // некому, молчать нельзя: деньги без адресата зависли бы в контракте
        // без единого счётчика, который на них указывает.
        if (arbiter_ == address(0)) revert NoVerdictSubmitted();

        uint256 toArbiter;
        uint256 toTreasury;
        if (v.overturned) {
            // Вердикт отменён (overturnVerdict/resolveAppeal) — арбитр ошибся,
            // награды не будет, весь сбор идёт в казну. Симметрично тому, что
            // finalizeVerdict уже пропускает награду из банка при overturned (:518).
            toTreasury = total;
        } else {
            toArbiter = (total * ARBITER_SHARE_BPS) / 10_000;
            // Вычитанием, а не второй долей: так ни один юнит не теряется на
            // округлении и части всегда складываются в целое.
            toTreasury = total - toArbiter;
        }

        d.arbiterRewards[arbiter_] += toArbiter;
        d.treasurySlice            += toTreasury;

        emit DisputeFeeCredited(arbiter_, toArbiter, toTreasury);
    }

    /// @notice Отправить накопленную долю казны текущему получателю комиссий.
    ///
    /// Открытая намеренно: деньги уходят только на адрес из
    /// FactoryStorage.feeRecipient, поэтому право вызова ничего не решает, а
    /// открытость означает, что выплата не зависит от того, помнит ли о ней
    /// владелец, и её может протолкнуть кипер.
    function withdrawTreasurySlice() external {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        uint256 slice = d.treasurySlice;
        if (slice == 0) revert NothingToPush();

        d.treasurySlice = 0;

        FactoryStorage.Layout storage fs = FactoryStorage.store();
        address recipient = fs.feeRecipient;
        bool ok = IUSDCFull(fs.usdc).transfer(recipient, slice);
        require(ok, "ArbiterRegistry: treasury slice transfer failed");

        emit TreasurySlicePushed(recipient, slice);
    }

    function getTreasurySlice() external view returns (uint256) {
        return ArbiterRegistryStorage.data().treasurySlice;
    }

    /// @notice Пополнить банк арбитров. Кроме владельца это может сделать
    /// текущий получатель комиссий (`FactoryStorage.feeRecipient`) — им
    /// становится казна, когда её подставляют вызовом `setFeeRecipient`.
    ///
    /// Отдельного поля под адрес казны намеренно нет: источник правды один,
    /// и замена казны переносит это право автоматически, забыть нечего.
    /// Если получатель комиссий — обычный кошелёк (как было до казны), он
    /// получает право положить в банк свои деньги. Это пожертвование, не риск.
    function fundVault(uint256 amount) external {
        if (msg.sender != OwnershipLib.contractOwner()
            && msg.sender != FactoryStorage.store().feeRecipient) revert NotOwnerOrFeeRecipient();
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

    /// @notice Сколько арбитр должен получить за спор суммарно.
    /// Хранимое поле, а не константа: правильную цену человеческого времени
    /// нельзя угадать заранее, а менять её потом надо одной транзакцией, без
    /// апгрейда. Старт — 10 USDC.
    function setArbiterFloor(uint256 amount) external onlyOwner {
        ArbiterRegistryStorage.data().arbiterFloor = amount;
        emit ArbiterFloorUpdated(amount);
    }

    // -------- ПЛАТНЫЙ ВЫЗОВ АРБИТРА: ОПЛАТА И ВОЗВРАТ --------

    /// @notice Доплатить до порога, чтобы арбитр взялся за спор.
    ///
    /// Строить отдельный «вызов арбитра» не требуется: добровольный клейм уже
    /// работает, он просто не срабатывает на мелком котле. Деньги на кону —
    /// единственное, чего ему не хватает.
    ///
    /// Платит сторона, которой нужен судья, а не общий банк. Это и есть защита
    /// от фарма: подставить своего арбитра означает заплатить самому себе.
    function fundDispute(address agreement) external {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        RegistryStorage.AgreementRecord storage rec = RegistryStorage.store().agreements[agreement];
        if (rec.client == address(0)) revert NotAuthorized();
        if (msg.sender != rec.client && msg.sender != rec.executor) revert NotParty();

        if (d.disputeClaims[agreement] != address(0)) revert DisputeAlreadyClaimed();
        if (d.disputeBounty[agreement] != 0) revert BountyAlreadyFunded();

        uint256 need = quoteDisputeTopUp(agreement); // ревертит NotDisputed, если спора нет
        if (need == 0) revert TopUpNotNeeded();

        d.disputeBounty[agreement]      = need;
        d.disputeBountyPayer[agreement] = msg.sender;

        address usdc = FactoryStorage.store().usdc;
        bool ok = IUSDCFull(usdc).transferFrom(msg.sender, address(this), need);
        require(ok, "ArbiterRegistry: bounty transfer failed");

        emit DisputeBountyFunded(agreement, msg.sender, need);
    }

    function getDisputeBounty(address agreement) external view returns (uint256) {
        return ArbiterRegistryStorage.data().disputeBounty[agreement];
    }

    /// @notice Забрать доплату, которую не удалось вернуть толчком.
    /// Существует ради чёрных списков USDC: возврат внутри clearDisputeClaim
    /// намеренно мягкий, потому что тот путь обёрнут в проглатывающий catch.
    function withdrawDisputeBounty() external {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        uint256 amount = d.refundableBounty[msg.sender];
        if (amount == 0) revert NothingToPush();
        d.refundableBounty[msg.sender] = 0;
        address usdc = FactoryStorage.store().usdc;
        bool ok = IUSDCFull(usdc).transfer(msg.sender, amount);
        require(ok, "ArbiterRegistry: bounty withdrawal failed");
        emit DisputeBountyWithdrawn(msg.sender, amount);
    }

    function getRefundableBounty(address who) external view returns (uint256) {
        return ArbiterRegistryStorage.data().refundableBounty[who];
    }

    function setDAOAddress(address dao) external onlyOwner {
        if (dao == address(0)) revert ArbiterZeroAddress();
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

        // Возврат доплаты, если вердикта не случилось.
        //
        // Различитель уже существует и второго заводить не надо: finalizeVerdict
        // выставляет v.executing перед вызовом resolveDispute и снимает после, а
        // v.finalized ставит ПОЗЖЕ внешнего вызова — то есть здесь он ещё false.
        // Значит executing == true означает «мы внутри финализации вердикта», и
        // выставлен он только на этом пути; на обеих ветках таймаута он false.
        //
        // Продавать то, чего нельзя гарантировать, хуже, чем не продавать:
        // заплатил и не получил ни судьи, ни денег — это уже не услуга.
        if (!v.executing) {
            uint256 bounty = d.disputeBounty[agreement];
            if (bounty > 0) {
                address payer = d.disputeBountyPayer[agreement];
                d.disputeBounty[agreement] = 0;
                delete d.disputeBountyPayer[agreement];

                // Мягкий возврат. Жёсткий здесь недопустим: Agreement зовёт эту
                // функцию внутри `try {} catch {}` с пустым обработчиком
                // (Agreement.sol:1286), поэтому реверт перевода утащил бы за собой
                // снятие клейма и уменьшение openClaimCount — молча, и арбитр
                // остался бы навсегда с незакрытым спором.
                address usdc = FactoryStorage.store().usdc;
                (bool ok, bytes memory ret) = usdc.call(
                    abi.encodeWithSelector(IUSDCFull.transfer.selector, payer, bounty)
                );
                bool delivered = ok && (ret.length == 0 || abi.decode(ret, (bool)));
                if (delivered) {
                    emit DisputeBountyRefunded(agreement, payer, bounty);
                } else {
                    d.refundableBounty[payer] += bounty;
                    emit DisputeBountyRefundable(agreement, payer, bounty);
                }
            }
        }
    }

    /// @notice Аварийная очистка застрявшего pending verdict.
    /// Возникает когда triggerArbiterTimeout исполняет Agreement до finalizeVerdict —
    /// Agreement уходит в REFUNDED, а pendingVerdicts остаётся висеть навечно.
    function clearStuckVerdict(address agreement) external {
        if (msg.sender != OwnershipLib.contractOwner()) revert NotOwner();
        if (agreement == address(0)) revert ArbiterZeroAddress();
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

    /// @notice Публичная (не external), потому что quoteDisputeTopUp зовёт её
    /// напрямую — дефолт при нуле подставляется в одном месте, а не в двух.
    function getArbiterFloor() public view returns (uint256) {
        uint256 f = ArbiterRegistryStorage.data().arbiterFloor;
        return f == 0 ? DEFAULT_ARBITER_FLOOR : f;
    }
    function getArbiterMistakeStreak(address addr) external view returns (uint256) { return ArbiterRegistryStorage.data().arbiterMistakeStreak[addr]; }
    function hasSubmittedVerdict(address agreement) external view returns (bool) {
        return ArbiterRegistryStorage.data().pendingVerdicts[agreement].submittedAt != 0;
    }
    function getAppealVotes(address agreement) external view returns (uint256 uphold, uint256 overturnVotes) {
        ArbiterRegistryStorage.PendingVerdict storage v = ArbiterRegistryStorage.data().pendingVerdicts[agreement];
        return (v.votesUphold, v.votesOverturn);
    }

    function hasVotedOnAppeal(address agreement, address arbiterAddr) external view returns (bool) {
        return ArbiterRegistryStorage.data().hasVotedAppeal[agreement][arbiterAddr];
    }
    function getArbiterBond(address addr) external view returns (uint256) { return ArbiterRegistryStorage.data().arbiterBond[addr]; }
    function getOpenClaimCount(address addr) external view returns (uint256) { return ArbiterRegistryStorage.data().openClaimCount[addr]; }

    /// @notice Сколько надо доплатить, чтобы арбитр суммарно получил порог.
    /// Возвращает 0, если котёл и так достаточно велик — тогда кнопку доплаты
    /// показывать не надо вовсе.
    ///
    /// Сбор берётся У СДЕЛКИ вызовом disputeFee(), а не пересчитывается здесь.
    /// Формула сбора (3% с потолком) живёт в Agreement, и вторая копия в
    /// фасете разошлась бы с ней при первой же правке — молча, потому что
    /// расхождение видно только тому, кто сравнит показанное число с пришедшим
    /// на кошелёк.
    function quoteDisputeTopUp(address agreement) public view returns (uint256) {
        (bool statusOk, bytes memory statusData) = agreement.staticcall(
            abi.encodeWithSignature("status()")
        );
        require(statusOk, "ArbiterRegistry: failed to read status");
        if (abi.decode(statusData, (uint8)) != 4) revert NotDisputed();

        (bool feeOk, bytes memory feeData) = agreement.staticcall(
            abi.encodeWithSignature("disputeFee()")
        );
        require(feeOk, "ArbiterRegistry: failed to read dispute fee");
        uint256 fee = abi.decode(feeData, (uint256));

        uint256 arbiterGets = (fee * ARBITER_SHARE_BPS) / 10_000;
        uint256 floor_ = getArbiterFloor();

        return arbiterGets >= floor_ ? 0 : floor_ - arbiterGets;
    }
}
