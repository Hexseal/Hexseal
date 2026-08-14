// SPDX-License-Identifier: BUSL-1.1
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
// FeeVault: пополняется вручную (fundVault) и держит буфер под будущие нужды
//   банка арбитров (Treasury.distribute()), но больше не платит за конкретный
//   спор — плоская выплата rewardPerDispute отвергнута дизайном 28 июля и
//   снята 31 июля (setRewardPerDispute теперь ревертит RewardPathRetired,
//   поле rewardPerDispute мёртвое). Оплата за вердикт сегодня из двух
//   источников: creditDisputeFee (80% от 3% сбора со спорной суммы —
//   внутренний замысел экономики арбитража, не публикуется) и
//   disputeBounty — доплата стороны спора до arbiterFloor на мелком котле
//   (fundDispute), которая при финализации уходит арбитру в finalizeVerdict.
//   Арбитр забирает накопленное через withdrawArbiterReward().
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
        uint256                            rewardPerDispute; // МЁРТВОЕ. Плоская выплата из банка отвергнута
                                                              // дизайном 28.07 (§7) и снята 31.07; поле оставлено,
                                                              // потому что раскладка append-only. Не читать и не писать.
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
        // ── Ключи чата арбитра (4б, 9 августа 2026) ──
        // Открытые половины ключей чата: шифрования (X25519) и подписи (Ed25519).
        // Лежат ЗДЕСЬ, а не в справочнике релеера, по требованию владельца:
        // регулировать арбитров должен диамонд, а не владелец. Справочник жил
        // на нашем сервере, и тот, кто до сервера добрался, подсунул бы свой
        // ключ вместо ключа арбитра и прочитал бы ВСЕ предъявления по всем
        // спорам, ничем себя не выдав. Здесь ключ пишет сам арбитр своей
        // транзакцией — сервер перестал быть точкой подмены, и это весь
        // выигрыш этой задачи.
        //
        // Владелец диамонда точкой подмены остался: право апгрейда позволяет
        // развернуть маленький фасет с функцией, пишущей в arbiterBoxKey
        // произвольного адреса, смонтировать его через diamondCut, переписать
        // ключ, прочитать предъявления сторон и снять фасет. ArbiterChatKeySet
        // при этом НЕ летит — приложения сторон смены не увидят. Тот же класс
        // и тот же порядок цены, что уже замеренный обход гейта резерва казны
        // (~31 700 газа, невидим для loupe) — docs/OPEN-ITEMS.md.
        //
        // Закрытые половины в цепь НЕ попадают никогда: они выводятся из
        // подписи арбитра и остаются на его устройстве. Публичность открытой
        // половины — не утечка, а условие работы: сторона берёт её, чтобы
        // запечатать предъявление так, что вскрыть сможет только владелец
        // закрытой.
        mapping(address => bytes32)        arbiterBoxKey;   // арбитр → открытый ключ шифрования
        mapping(address => bytes32)        arbiterSignKey;  // арбитр → открытый ключ подписи
        // ── Момент взятия спора (4в-2 Выкатка 2, 14 августа 2026) ──
        // Нужен для пола записи о молчании: цепь не принимает «не ответили»
        // раньше, чем NO_RESPONSE_FLOOR от взятия. Отсчёт именно отсюда, а не
        // от просьбы: просьба идёт вне цепи и её время арбитр мог бы подделать,
        // а «взял спор на блоке N» — готовый факт. Он же момент, с которого
        // сторона физически может предъявить: до него ключ арбитра неизвестен.
        //
        // Ключ — ПАРА (сделка, арбитр). Не «сделка → время»: иначе новый арбитр
        // наследовал бы время старого, пол оказался бы уже пройденным, и запись
        // о молчании прошла бы в ту же секунду, как он взял спор. Ключевание
        // парой убирает это структурно и заодно снимает нужду в обнулении при
        // снятии клейма — мест снятия два, кандидат на третье уже назван
        // (`abandonClaim`, docs/OPEN-ITEMS.md п. 11), и уборку в нём пришлось бы
        // не забыть. Наружу отдаётся якорь ТЕКУЩЕГО клеймера, см.
        // getDisputeClaimedAt.
        //
        // ⚠️ Пишется при КАЖДОМ взятии этим арбитром, а не только при первом.
        // Решение владельца 14.08.2026, отменяет более раннее «один раз
        // навсегда». Пол должен мерить время, в течение которого стороне было
        // КОМУ предъявлять, — то есть пока спор стоял за этим арбитром. С
        // якорем «первое взятие навсегда» подкупленный арбитр брал спор,
        // отпускал через минуту и возвращался через сутки: пол пройден, запись
        // о молчании проходит немедленно, а спор почти всё это время стоял
        // ничей и предъявлять было некому.
        //
        // Обратная сторона — что перевзятие сдвигает якорь вперёд — оружием не
        // является: сдвиг вперёд только ОТКЛАДЫВАЕТ запись, то есть вредит
        // самому арбитру. Порядок событий при этом виден не отсюда, а из
        // событий DisputeClaimed / DisputeNoResponseRecorded: хранилище держит
        // последнее взятие, лента — все.
        mapping(address => mapping(address => uint256)) disputeClaimedAtBy;
        // Запись «просил переписку, ответа нет» — секунда блока. 0 — записи нет.
        // Ключ тот же, пара (сделка, арбитр), а вот правило записи ДРУГОЕ:
        // пишется ОДИН раз и не стирается никогда. Стираемая или переписываемая
        // запись означала бы, что арбитр волен переставить её время — отпустил
        // спор, взял заново, записал заново, — и «когда именно он это утверждал»
        // становится его выбором, а не фактом. У якоря такой свободы нет: его
        // сдвиг возможен только вперёд и только себе во вред.
        mapping(address => mapping(address => uint256)) disputeNoResponseAtBy;
        // ── Отпечатки предъявлений (4в-2 Выкатка 2, 14 августа 2026) ──
        // Сделка → список 32-байтовых хэшей канонического вида, которым сторона
        // ПОДПИСЫВАЕТ предъявление (canonicalPresentationBytes,
        // frontend/src/lib/presentation.ts:526).
        //
        // Список, а не одно значение: переписка не влезает в один мешок, и
        // предъявлений по спору бывает сколько нужно (замысел 2.7). Ключ —
        // сделка, а не пара (сделка, сторона): доказывается ПОРЯДОК, а порядок
        // общий для спора, и лента должна читаться одним запросом. Кто именно
        // положил, видно из события — в хранилище это не нужно никому.
        //
        // Бессмертен отпечаток, а не переписка (замысел 2.12): склад чистится,
        // 32 байта остаются. Отсюда же то, чего здесь НЕТ и быть не должно —
        // ни удаления, ни переписывания: запись, которую можно снять,
        // доказывает ровно ничего.
        mapping(address => bytes32[]) presentationDigests;
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
    // DEFAULT_REWARD (5 USDC) удалена 31 июля: её не читал ни один вызов, а
    // комментарий над ней называл её «floor формулы» — при том, что настоящий
    // пол выплаты арбитру это DEFAULT_ARBITER_FLOOR ниже. Две константы с
    // одним словом в описании и одна из них мёртвая — ложный след, а не
    // документация.
    uint256 private constant FINALIZE_DELAY      = 24 hours;  // окно для owner/DAO/апелляции до финализации (было 1 час — недостаточно для обычного пользователя)

    // Пол записи о молчании: столько должно пройти от ВЗЯТИЯ спора, прежде чем
    // арбитр вправе записать «просил, ответа нет». Решение владельца 14.08.2026.
    // Совпадает с FINALIZE_DELAY намеренно: одно знакомое число вместо двух похожих.
    //
    // ⚠️ Это ЕДИНСТВЕННОЕ место, где число объявлено. Фронт обязан читать его
    // через getNoResponseFloor(), а не держать копию (замысел 5.2).
    uint256 private constant NO_RESPONSE_FLOOR = 24 hours;

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
    /// Арбитр записал в цепь: просил переписку у стороны — ответа не было.
    /// Событие несёт то же, что и хранилище, и заведено ради ленты апелляции:
    /// хранилище показывает только запись ТЕКУЩЕГО клеймера, а по апелляции
    /// смотрят весь ход спора, включая арбитров, которые спор уже отпустили.
    event DisputeNoResponseRecorded(address indexed agreement, address indexed arbiter, uint256 at);
    /// Сторона спора положила в цепь отпечаток предъявления.
    ///
    /// ⚠️ СОБЫТИЕ ОБЯЗАТЕЛЬНО, и не как дубль хранилища: хранилище отвечает
    /// «сколько и какие», а спор решается вопросом «что было раньше». Номер
    /// блока и порядок относительно DisputeNoResponseRecorded есть только у
    /// ленты. `index` дублирует место в списке нарочно — читающий ленту не
    /// обязан ходить в хранилище, чтобы понять, первое это предъявление или
    /// десятое.
    event PresentationDigestRecorded(
        address indexed agreement, address indexed submitter, bytes32 digest, uint256 index
    );
    event DAOActivated(address indexed by);
    event ArbiterApplied(address indexed arbiter);
    /// Ключи чата арбитра опубликованы или заменены.
    ///
    /// ⚠️ СОБЫТИЕ ОБЯЗАТЕЛЬНО, и вот почему: 4в следит за сменой ключа, чтобы
    /// автоматически предъявить заново, если арбитр сменил устройство. Без
    /// события ему пришлось бы ОПРАШИВАТЬ цепь — а 9 августа мы убрали 8 100
    /// обращений к цепи в час с одной вкладки, и новый опрос вернул бы ту же
    /// беду под другим именем. Не удалять и не делать неиндексируемым.
    event ArbiterChatKeySet(address indexed arbiter, bytes32 boxKey, bytes32 signKey);
    event VerdictSubmitted(address indexed agreement, address indexed arbiter, bool clientWins);
    event VerdictFinalized(address indexed agreement, address indexed arbiter, bool clientWins);
    event VerdictFrozen(address indexed agreement);
    event VerdictUnfrozen(address indexed agreement);
    event VerdictOverturned(address indexed agreement, address indexed arbiter, bool newClientWins);
    event ArbiterRewarded(address indexed arbiter, uint256 amount);
    event ArbiterRewardWithdrawn(address indexed arbiter, uint256 amount);
    event VaultFunded(address indexed by, uint256 amount);
    // RewardPerDisputeUpdated удалено 31 июля вместе с последним, кто его
    // слал: setRewardPerDispute стал `pure revert`, писать значение больше
    // некому. Объявление без единого emit — обещание события, которого не
    // будет, для всякого, кто читает ABI.
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
    error ZeroChatKey();
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
    // Своя ошибка, а не NothingToPush: та живёт в withdrawTreasurySlice.
    // Обе разбираются декодером релеера (relayer/app.js:
    // FORWARDER_CUSTOM_ERRORS, селекторы 0x2d4e8c7b и 0x68d369c9), то есть имя
    // долетает до человека дословно — и человек, забирающий свою доплату,
    // увидел бы сообщение про push, которого не делал. Разделение работает
    // ровно постольку, поскольку обе ошибки в декодере есть: пропусти одну, и
    // до человека доедет сырой хекс, в котором различать нечего.
    error NoRefundableBounty();
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
    error RewardPathRetired();

    // ── Запись «просил, ответа нет» (4в-2 Выкатка 2) ──
    error NoResponseTooEarly();
    error NoResponseAlreadyRecorded();
    /// Отдельно от NotTheClaimer намеренно: тот отвечает на пути вердикта, и
    /// сторона, увидевшая его в ответ на кнопку «ответа не было», решила бы,
    /// что дело в вердикте. Одинаковый смысл, разные экраны.
    error NotClaimingArbiter();
    error ClaimTimeUnknown();

    // ── Отпечаток предъявления (4в-2 Выкатка 2) ──
    /// Отдельно от NotParty намеренно, по той же причине, что NotClaimingArbiter
    /// отдельно от NotTheClaimer: NotParty живёт на пути ОПЛАТЫ арбитра
    /// (fundDispute), и человек, получивший её в ответ на «предъявить
    /// переписку», пошёл бы искать проблему в деньгах. Смысл один, экраны разные.
    error NotDisputeParty();
    /// Нулевой отпечаток — не предъявление, а пустая запись в ленте: хэша, чей
    /// прообраз можно показать, у нуля нет.
    error ZeroDigest();

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

    /// Опубликовать или заменить открытые половины своих ключей чата.
    ///
    /// Нужна отдельно от заявки на спор ради одного случая: арбитр, потерявший
    /// ключ ПОСЛЕ заявки, застревает — адрес в цепи тот же, а прочитать
    /// предъявленное нечем, и повторное предъявление на тот же ключ не
    /// поможет. С этой функцией петля замыкается сама: опубликовал новый →
    /// приложения сторон заметили по событию → предъявили заново → читает.
    ///
    /// Адрес берётся из отправителя, аргумента «кому» НЕТ вовсе: чужой ключ
    /// записать нельзя не потому, что мы проверяем, а потому что записать
    /// некуда.
    ///
    /// ⚠️ Исключение, где петля НЕ замыкается сама: гейт здесь — `isArbiter`,
    /// и он снимается (removeArbiter/resignAsArbiter/демоушен на 3 ошибки
    /// подряд) без очистки уже записанного ключа. Арбитр, потерявший статус
    /// с открытым спором на руках, ключ ротировать больше не может (эта
    /// функция ревертит `NotArbiter`), а `getArbiterChatKeys` по нему
    /// по-прежнему отдаёт старый — живой на вид, но заменить его некому.
    /// `submitVerdict` этот случай не перекрывает: он проверяет только
    /// `disputeClaims`, никогда `isArbiter`. Настоящее лекарство (разрешить
    /// ротацию, пока `openClaimCount` не пуст) меняет права и здесь
    /// сознательно не реализовано.
    function setArbiterChatKey(bytes32 boxKey, bytes32 signKey) external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        if (!d.isArbiter[caller]) revert NotArbiter();
        if (boxKey == bytes32(0) || signKey == bytes32(0)) revert ZeroChatKey();

        // Событие — только если хотя бы одна половина реально изменилась.
        // Запись делаем всегда (идемпотентна и дешевле ветвления) — условие
        // только вокруг emit. Причина в 4в, а не здесь: он предъявляет заново
        // ПО СОБЫТИЮ, и одинаковая перезапись — обычный no-op с фронта
        // (повторный вызов, гонка вкладок) — иначе заставила бы его
        // перешифровать и перезалить на склад переписку по каждому открытому
        // спору арбитра, хотя ключ не менялся вовсе.
        bool changed = d.arbiterBoxKey[caller] != boxKey || d.arbiterSignKey[caller] != signKey;
        d.arbiterBoxKey[caller]  = boxKey;
        d.arbiterSignKey[caller] = signKey;
        if (changed) emit ArbiterChatKeySet(caller, boxKey, signKey);
    }

    /// @notice Клейм спора. Diamond устанавливается арбитром в Agreement (не сам арбитр).
    /// Это позволяет Diamond контролировать исполнение вердикта (задержка, overturn).
    ///
    /// Ключи чата — ОБЯЗАТЕЛЬНЫЕ аргументы, держится формой аргумента, а не
    /// проверкой: контракт не умеет отличить настоящий ключ от двух мусорных
    /// bytes32 — форма только делает невозможным взять спор, вообще ничего не
    /// прислав. Это закрывает случай БЕЗ злого умысла (забыл, не настроил
    /// устройство). Арбитра, который умышленно везёт мусор вместо ключа,
    /// форма не остановит: он получит тот же исход, а стороны впустую
    /// перешифруют переписку на ключ, которым никто не владеет. Умышленный
    /// отказ читать закрывается обнаружением, а не формой аргумента — это
    /// работа следующих частей, не этой.
    ///
    /// Каждая заявка ПЕРЕЗАПИСЫВАЕТ ключи. ⚠️ Раньше здесь было написано, что
    /// этим «смена устройства лечится сама» — это неверно, и поправлено
    /// 9 августа по разбору кода фронта. У ОБЫЧНОГО кошелька ключ чата
    /// детерминирован: он выводится из подписи фиксированных типизированных
    /// данных (все 65 байт подписи идут в семя), а обычные кошельки подписывают
    /// детерминированно (RFC 6979). Значит тот же кошелёк на новом устройстве
    /// даёт ТОТ ЖЕ ключ, и опубликованный в цепи ключ остаётся живым — лечить
    /// нечего.
    ///
    /// Перезапись нужна там, где ключ правда умирает, и таких случаев два:
    ///  1. кошелёк-контракт — ключ там случайный, а не выведенный, и без кода
    ///     восстановления (12 слов) на новом устройстве получается другой;
    ///  2. Safe с порогом 1 — он отдаёт ровно 65 байт, подписанных владельцем,
    ///     поэтому определяется как обычный кошелёк, а ключ фактически выведен
    ///     из подписи ВЛАДЕЛЬЦА. Сменился владелец — сменился ключ, и кода
    ///     восстановления такому роду не выдают.
    /// Плюс общий случай: ключ просто потерян. Ради этих случаев есть ещё и
    /// setArbiterChatKey — заявки ждать не нужно.
    ///
    /// ⚠️ Селектор этой функции сменился 9 августа (4б). Старый
    /// `claimDispute(address,bytes32)` удалён из монтировки тем же diamondCut —
    /// оставить его значило бы держать вторую дорогу, по которой спор берётся
    /// БЕЗ ключа, то есть ровно ту дыру, которую эта правка закрывает.
    function claimDispute(
        address agreement,
        bytes32 salt,
        bytes32 boxKey,
        bytes32 signKey
    ) external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        if (!d.isArbiter[caller]) revert NotArbiter();
        if (boxKey == bytes32(0) || signKey == bytes32(0)) revert ZeroChatKey();
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
        // Якорь пола — при КАЖДОМ взятии, без условия «только если ноль».
        // Условие здесь стояло и снято решением владельца 14.08.2026: оно
        // защищало от самовреда (перевзятие откладывает запись арбитру же), а
        // взамен открывало настоящую дыру — взять спор, отпустить через минуту,
        // вернуться через сутки и записать молчание немедленно, хотя спор почти
        // всё это время стоял ничей и предъявлять было некому. Подробности — у
        // поля в ArbiterRegistryStorage.
        d.disputeClaimedAtBy[agreement][caller] = block.timestamp;
        d.arbiterDeals[caller].push(agreement);
        d.openClaimCount[caller]++;

        // Ключи пишутся ЗДЕСЬ, а не отдельным вызовом: одна транзакция вместо
        // двух, и арбитр не может оказаться заявленным без ключа даже на
        // мгновение.
        //
        // Событие — только при реальной смене (см. setArbiterChatKey выше,
        // тот же приём и та же причина): без условия арбитр с N открытыми
        // спорами, беря спор N+1 своим обычным ключом, шлёт N бесплатных
        // повторных предъявлений на склад — заявка почти всегда везёт ТОТ ЖЕ
        // ключ, что уже записан.
        bool keysChanged = d.arbiterBoxKey[caller] != boxKey || d.arbiterSignKey[caller] != signKey;
        d.arbiterBoxKey[caller]  = boxKey;
        d.arbiterSignKey[caller] = signKey;
        if (keysChanged) emit ArbiterChatKeySet(caller, boxKey, signKey);

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

        // Якорь взятия и запись о молчании здесь НЕ трогаются: они ключуются
        // парой (сделка, арбитр), поэтому «новый арбитр наследует чужое время»
        // невозможно и без уборки, а стирать запись о молчании нельзя — это
        // отдало бы арбитру право переставить её время. Наружу оба геттера
        // ходят через disputeClaims, поэтому сразу после этой строки они честно
        // дают ноль.
        delete d.disputeClaims[agreement];
        if (d.openClaimCount[current] > 0) d.openClaimCount[current]--;

        (bool ok,) = agreement.call(
            abi.encodeWithSignature("setArbiter(address)", address(0))
        );
        require(ok, "ArbiterRegistry: reset arbiter failed");

        emit DisputeReleased(agreement, current);
    }

    /// @notice Арбитр записывает в цепь факт: просил переписку — ответа не было.
    /// @dev Пуск только по слову арбитра, по таймеру не отлетает ничего (замысел 2.5).
    /// Последствий нет: ни XP, ни репутации, ни сдвига вердикта (замысел 2.6) — цепь не
    /// видит наш ящик и поверить может только слову арбитра, а навесить на непроверяемое
    /// слово автоматику значит выдать подкупленному арбитру настоящее оружие.
    /// Отпечаток предъявления записи НЕ мешает (замысел 2.11): жёсткий запрет дал бы
    /// стороне щит — отправить отпечаток пустышки и стать неуязвимой.
    function recordNoResponse(address agreement) external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        if (d.disputeClaims[agreement] != caller) revert NotClaimingArbiter();

        uint256 claimedAt = d.disputeClaimedAtBy[agreement][caller];
        // Ноль — спор взят ДО разреза 4в-2: цепь не знает, когда это было, и пол
        // считать не от чего. Отказываем закрыто. Выход есть и он дешёвый:
        // releaseDisputeClaim и взять спор заново (решение владельца 14.08.2026).
        if (claimedAt == 0) revert ClaimTimeUnknown();
        // Однократность проверяется РАНЬШЕ пола, и порядок здесь не косметика.
        // С якорем, который переставляется при каждом взятии, арбитр, уже
        // сделавший запись и перевзявший спор, упирался бы в NoResponseTooEarly:
        // ответ, который врёт: он обещает, что через сутки получится, а через
        // сутки получится NoResponseAlreadyRecorded. «Уже записано» — состояние
        // окончательное и от времени не зависящее, поэтому и отвечать про него
        // надо первым.
        if (d.disputeNoResponseAtBy[agreement][caller] != 0) revert NoResponseAlreadyRecorded();
        if (block.timestamp < claimedAt + NO_RESPONSE_FLOOR) revert NoResponseTooEarly();

        d.disputeNoResponseAtBy[agreement][caller] = block.timestamp;
        emit DisputeNoResponseRecorded(agreement, caller, block.timestamp);
    }

    /// @notice Сторона спора кладёт в цепь отпечаток предъявления — 32 байта.
    /// @dev Это `keccak256` того же канонического вида, которым сторона
    /// ПОДПИСЫВАЕТ предъявление (`canonicalPresentationBytes`,
    /// frontend/src/lib/presentation.ts:526: длина перед каждым полем, склеек
    /// нет). Функция хэша названа здесь дословно и не случайно: это шов, у
    /// которого цепь видит только 32 байта и совпадение проверить не может
    /// ничем. Возьми фронт sha256 — в цепи лежали бы такие же законные 32
    /// байта, «сходится» не сошлось бы никогда, и узнали бы мы об этом от
    /// человека со сломанным экраном. Смысл — не доказать содержание,
    /// а показать ПОРЯДОК: отпечаток лёг на блоке N, запись арбитра «просил,
    /// ответа нет» — на блоке M. Доверия к нашему серверу для этого не нужно, и
    /// если сервер потеряет ящик, факт предъявления останется.
    ///
    /// Записи о молчании отпечаток НЕ мешает (замысел 2.11) — ни здесь, ни в
    /// recordNoResponse нет ни одной строки, которая связывала бы одно с другим.
    /// Жёсткий запрет дал бы стороне щит: цепь не знает, что лежит под хэшем,
    /// значит неуязвимость покупалась бы отпечатком пустого файла. Кто прав,
    /// решает арбитр, глядя на порядок, а не контракт.
    function recordPresentationDigest(address agreement, bytes32 digest) external {
        if (digest == bytes32(0)) revert ZeroDigest();

        address caller = _msgSender();

        // Стороны берём из СВОЕГО реестра, а не внешним вызовом к сделке.
        // RegistryStorage.AgreementRecord уже держит client и executor
        // (src/RegistryFacet.sol), и остальные функции этого фасета ходят туда
        // же (notifyArbiterTimeout, fundDispute). Так дешевле, не заводит
        // внешнего вызова с разбором returndata — и заодно отвечает на «а
        // сделка вообще наша?»: у адреса, которого в реестре нет, нет ни
        // клиента, ни исполнителя, поэтому стороной по нему не окажется никто и
        // ленту чужой сделки не наполнит никто.
        RegistryStorage.AgreementRecord storage rec =
            RegistryStorage.store().agreements[agreement];
        // ⚠️ Первая строка сегодня СРАБОТАТЬ НЕ МОЖЕТ, и написано это здесь,
        // чтобы следующий читатель не принял её за живой замок. Записи в
        // реестре пишутся целиком (RegistryFacet.register) и не удаляются
        // нигде, поэтому «записи нет» означает и client == 0, и executor == 0 —
        // а тогда вторая строка отвергает любого ненулевого вызывающего сама.
        // Замерено снятием: убрать первую строку — 0 красных из 632; убрать обе
        // — 3 красных. Оставлена как объявление намерения («сделка обязана быть
        // нашей») ценой одного холодного SLOAD; если этот SLOAD когда-нибудь
        // станет жалко, снимать надо именно её, а не вторую.
        if (rec.agreement != agreement) revert NotDisputeParty();
        if (caller != rec.client && caller != rec.executor) revert NotDisputeParty();

        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        d.presentationDigests[agreement].push(digest);
        emit PresentationDigestRecorded(
            agreement, caller, digest, d.presentationDigests[agreement].length - 1
        );
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

        // Доплата обнуляется ЗДЕСЬ, до внешнего вызова, независимо от исхода.
        // resolveDispute через агримент дойдёт до clearDisputeClaim, и если бы
        // доплата была ещё на месте, та вернула бы её плательщику — то есть
        // при обычной выплате арбитр и плательщик получили бы одни и те же
        // деньги. Обнуление до вызова делает двойную выплату невозможной по
        // конструкции, а не по проверке.
        uint256 bounty = d.disputeBounty[agreement];
        if (bounty > 0) {
            d.disputeBounty[agreement] = 0;
            address bountyPayer = d.disputeBountyPayer[agreement];
            delete d.disputeBountyPayer[agreement];

            if (v.overturned) {
                // Отменённый вердикт не оплачивается: 80% сбора при отмене уже
                // уходят в казну (creditDisputeFee), и доплата не должна быть
                // исключением — за одну и ту же ошибку нельзя терять одну часть
                // оплаты и сохранять другую. Деньги возвращаются плательщику:
                // он покупал разрешение спора и не получил его. Через
                // claimable (refundableBounty/withdrawDisputeBounty), а не
                // прямым transfer — жёсткий перевод здесь уронил бы всю
                // финализацию, если плательщик в чёрном списке USDC или иначе
                // не может принять перевод.
                d.refundableBounty[bountyPayer] += bounty;
                emit DisputeBountyRefundable(agreement, bountyPayer, bounty);
            } else {
                d.arbiterRewards[v.arbiter] += bounty;
                emit ArbiterRewarded(v.arbiter, bounty);
            }
        }

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
    /// единственное место, которое умеет удалить запись — clearStuckVerdict
    /// делает то же самое БЕЗ проверки !v.executing; его гейт
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
            // finalizeVerdict при overturned не отдаёт арбитру и доплату, а
            // возвращает её плательщику через refundableBounty (см. блок
            // возврата доплаты внутри finalizeVerdict, выше по файлу).
            // Прежняя ссылка вела на выплату из банка за спор — того блока нет
            // с коммита a9c9095, плоскую выплату сняли целиком.
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

    /// @notice Отключён 31 июля 2026. Плоская выплата из банка отвергнута
    /// дизайном 28 июля (§7), но код за ним не пошёл: начисление жило
    /// параллельно с 80% сбора и включалось одним вызовом владельца. С
    /// появлением доплаты источников стало бы три.
    ///
    /// Функция не удалена, а ревертит: восемь исторических скриптов в script/
    /// ссылаются на её селектор в списках монтирования, forge build собирает
    /// всю папку, и удаление развалило бы сборку. Эти скрипты — записи о
    /// произошедших апгрейдах, а broadcast/ в гитигноре, поэтому их исходники
    /// единственная оставшаяся запись. Ревертящий сеттер честнее рабочего,
    /// который пишет значение, которого никто не читает.
    function setRewardPerDispute(uint256) external pure {
        revert RewardPathRetired();
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
    ///
    /// Отправителя берём через _msgSender(), а не msg.sender: фронт зовёт эту
    /// функцию ТОЛЬКО через ERC-2771-форвардер (frontend/src/lib/relay.ts),
    /// и на этом пути msg.sender — адрес форвардера. С прямым msg.sender
    /// проверка стороны отвергала бы каждую оплату, а плательщиком в
    /// хранилище и в событии оказывался бы форвардер, а не человек.
    function fundDispute(address agreement) external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        RegistryStorage.AgreementRecord storage rec = RegistryStorage.store().agreements[agreement];
        if (rec.client == address(0)) revert NotAuthorized();
        if (caller != rec.client && caller != rec.executor) revert NotParty();

        if (d.disputeClaims[agreement] != address(0)) revert DisputeAlreadyClaimed();
        if (d.disputeBounty[agreement] != 0) revert BountyAlreadyFunded();

        uint256 need = quoteDisputeTopUp(agreement); // ревертит NotDisputed, если спора нет

        // Тот же гейт, что в claimDispute (проверка DisputeWindowPassed после
        // disputedAt()/DISPUTE_WINDOW()), и то же сравнение:
        // после disputedAt + DISPUTE_WINDOW спор нельзя ни заклеймить, ни
        // отсудить (submitVerdict тоже бьёт DisputeWindowPassed), и статус
        // остаётся DISPUTED, пока кто-нибудь не дёрнет таймаут. Принимать
        // деньги за судью, которого уже физически не может быть, нельзя:
        // они не потеряются (вернутся на таймауте), но замрут до чужого
        // действия, а услуга не будет оказана вовсе.
        (bool dOk, bytes memory dData) = agreement.staticcall(abi.encodeWithSignature("disputedAt()"));
        require(dOk, "ArbiterRegistry: disputedAt read failed");
        (bool wOk, bytes memory wData) = agreement.staticcall(abi.encodeWithSignature("DISPUTE_WINDOW()"));
        require(wOk, "ArbiterRegistry: DISPUTE_WINDOW read failed");
        if (block.timestamp > abi.decode(dData, (uint256)) + abi.decode(wData, (uint256))) {
            revert DisputeWindowPassed();
        }

        if (need == 0) revert TopUpNotNeeded();

        d.disputeBounty[agreement]      = need;
        d.disputeBountyPayer[agreement] = caller;

        address usdc = FactoryStorage.store().usdc;
        bool ok = IUSDCFull(usdc).transferFrom(caller, address(this), need);
        require(ok, "ArbiterRegistry: bounty transfer failed");

        emit DisputeBountyFunded(agreement, caller, need);
    }

    function getDisputeBounty(address agreement) external view returns (uint256) {
        return ArbiterRegistryStorage.data().disputeBounty[agreement];
    }

    /// @notice Забрать доплату, которую не удалось вернуть толчком.
    /// Существует ради чёрных списков USDC: возврат внутри clearDisputeClaim
    /// намеренно мягкий, потому что тот путь обёрнут в проглатывающий catch.
    ///
    /// _msgSender(), а не msg.sender, по той же причине, что и в fundDispute:
    /// вызов приходит через форвардер, и на прямом msg.sender человек забирал
    /// бы не свой остаток, а (всегда нулевой) остаток форвардера.
    function withdrawDisputeBounty() external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        uint256 amount = d.refundableBounty[caller];
        if (amount == 0) revert NoRefundableBounty();
        d.refundableBounty[caller] = 0;
        address usdc = FactoryStorage.store().usdc;
        bool ok = IUSDCFull(usdc).transfer(caller, amount);
        require(ok, "ArbiterRegistry: bounty withdrawal failed");
        emit DisputeBountyWithdrawn(caller, amount);
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
            // Якорь и запись о молчании не трогаются — см. releaseDisputeClaim.
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
            // Счётчик обоим: спор кончился, судить было некому или некогда.
            // Пишем напрямую в namespaced-хранилище репутации — тот же приём,
            // которым этот файл уже сбрасывает XP при демоушене
            // (_recordArbiterMistake).
            RegistryStorage.AgreementRecord storage rec = RegistryStorage.store().agreements[agreement];
            if (rec.client != address(0)) {
                ReputationStorage.Data storage rep = ReputationStorage.data();
                rep.unresolvedDisputes[rec.client]   += 1;
                rep.unresolvedDisputes[rec.executor] += 1;
            }

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
                //
                // Длину ответа проверяем явно, тем же приёмом, что и
                // SafeUSDC.trySafeTransfer (Agreement.sol:215-225): abi.decode
                // на ответе от 1 до 31 байта сам паникует, и тогда «мягкий»
                // возврат оказался бы таким же жёстким, как обычный, ровно в
                // ветке, которую мы делаем мягкой намеренно.
                address usdc = FactoryStorage.store().usdc;
                (bool ok, bytes memory ret) = usdc.call(
                    abi.encodeWithSelector(IUSDCFull.transfer.selector, payer, bounty)
                );
                bool delivered;
                if (ok) {
                    if (ret.length == 0) delivered = true;
                    else if (ret.length >= 32) delivered = abi.decode(ret, (bool));
                    // ret.length в 1..31 — delivered остаётся false, decode не зовём.
                }
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

    /// @notice Когда ТЕКУЩИЙ клеймер взял этот спор, в секундах блока. Если он
    /// брал его несколько раз — момент последнего взятия, от него и считается
    /// пол. 0 — спор не взят (в том числе отпущен) или взят до разреза 4в-2.
    ///
    /// Подпись односоставная намеренно: спрашивающему нужен якорь того, кто
    /// судит спор сейчас, а не история по каждому арбитру. История есть, она в
    /// событиях DisputeClaimed/DisputeReleased.
    function getDisputeClaimedAt(address agreement) external view returns (uint256) {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        return d.disputeClaimedAtBy[agreement][d.disputeClaims[agreement]];
    }

    /// @notice Когда текущий клеймер записал «просил, ответа нет». 0 — не записывал.
    /// Ноль здесь же означает «спор ничей»: запись принадлежит арбитру, а не
    /// сделке, и вместе с клеймом уходит из виду, не пропадая из цепи.
    function getNoResponseAt(address agreement) external view returns (uint256) {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        return d.disputeNoResponseAtBy[agreement][d.disputeClaims[agreement]];
    }

    /// @notice Сколько должно пройти от взятия спора до записи о молчании.
    /// Фронт обязан спрашивать здесь, а не держать своё число (замысел 5.2).
    function getNoResponseFloor() external pure returns (uint256) {
        return NO_RESPONSE_FLOOR;
    }

    /// @notice Все отпечатки предъявлений по сделке, в порядке появления.
    /// Порядок и есть содержание ответа: спор решается тем, что легло раньше.
    ///
    /// Удобен и честен на обычных числах, но список целиком при большом их
    /// количестве упирается в потолок газа на eth_call — и ломается чтение У
    /// АРБИТРА и у второй стороны, а не у того, кто список раздул. Кому нужна
    /// гарантия — getPresentationDigestsPage ниже. Кто именно положил каждый
    /// отпечаток, здесь не видно: это в событии PresentationDigestRecorded, и
    /// туда же ходят за номером блока.
    function getPresentationDigests(address agreement) external view returns (bytes32[] memory) {
        return ArbiterRegistryStorage.data().presentationDigests[agreement];
    }

    /// @notice Отпечатки по сделке окном: с `offset`, не больше `limit` штук.
    /// @dev Полный getPresentationDigests честен на малых числах, но при большом
    /// списке упирается в потолок eth_call — и ломается чтение У АРБИТРА, а не у
    /// того, кто список раздул. Окно даёт читателю выход без апгрейда контракта.
    ///
    /// ⚠️ На честном запросе НЕ ревертит никогда: читатель не обязан заранее
    /// знать длину, а узнать её он может только вторым вызовом — то есть в
    /// другом блоке, когда длина уже другая. Реверт на «offset за концом»
    /// означал бы, что листающий обязан выиграть гонку с пишущим. Поэтому:
    ///   - `offset` за концом списка (и пустой список)  → пустой массив;
    ///   - `limit == 0`                                  → пустой массив;
    ///   - `offset + limit` больше длины                 → хвост до конца.
    /// Пустой ответ читается однозначно: «здесь больше ничего нет», и это
    /// условие остановки для листающего. Отличить его от «мимо» можно
    /// getPresentationDigestCount, но обычно незачем.
    ///
    /// Сумма `offset + limit` не считается нигде намеренно, и это не
    /// придирка: на checked-арифметике 0.8 наивное `offset + limit` при
    /// `limit` вроде type(uint256).max ПАНИКУЕТ (0x11), то есть ровно ломает
    /// обещание «на честном запросе не ревертит» — а «дай всё с этого места»
    /// запрос честный. Замерено мутацией: наивная сумма → красный тест
    /// test_Page_HugeLimit_IsUpToTheEnd_NotARevert с panic 0x11.
    function getPresentationDigestsPage(address agreement, uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory)
    {
        bytes32[] storage all = ArbiterRegistryStorage.data().presentationDigests[agreement];
        uint256 len = all.length;
        if (offset >= len) return new bytes32[](0);

        uint256 available = len - offset;
        uint256 n = limit < available ? limit : available;

        bytes32[] memory page = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            page[i] = all[offset + i];
        }
        return page;
    }

    /// @notice Сколько отпечатков лежит по сделке. Отдельно от списка — чтобы
    /// экран, которому нужно только «есть или нет», не тащил весь массив.
    function getPresentationDigestCount(address agreement) external view returns (uint256) {
        return ArbiterRegistryStorage.data().presentationDigests[agreement].length;
    }

    /// Открытые половины ключей чата арбитра. Нули означают «ключей нет» —
    /// для 4в это признак «предъявлять некому», и различать «нет записи» от
    /// «записан нуль» незачем: нулевой ключ запрещён при записи.
    ///
    /// ⚠️ Обратное неверно: ненулевой ключ НЕ означает «действующий арбитр».
    /// Ключ не стирается при потере статуса (removeArbiter/resignAsArbiter/
    /// демоушен) — см. предупреждение в setArbiterChatKey. Статус читается
    /// отдельно, через isRegisteredArbiter, а не выводится из наличия ключа.
    function getArbiterChatKeys(address arbiter)
        external
        view
        returns (bytes32 boxKey, bytes32 signKey)
    {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        return (d.arbiterBoxKey[arbiter], d.arbiterSignKey[arbiter]);
    }
    function getArbiterDeals(address arbiter) external view returns (address[] memory) { return ArbiterRegistryStorage.data().arbiterDeals[arbiter]; }
    function getClaimCommitment(bytes32 c) external view returns (uint256) { return ArbiterRegistryStorage.data().claimCommitments[c]; }

    function getPendingVerdict(address agreement) external view returns (ArbiterRegistryStorage.PendingVerdict memory) {
        return ArbiterRegistryStorage.data().pendingVerdicts[agreement];
    }

    function getArbiterReward(address arbiter) external view returns (uint256) { return ArbiterRegistryStorage.data().arbiterRewards[arbiter]; }
    function getVaultBalance()  external view returns (uint256) { return ArbiterRegistryStorage.data().vaultBalance; }
    /// @notice Путь снят 31 июля 2026 (см. setRewardPerDispute) — поле, которое
    /// эта функция читает, больше никто не пишет, значение всегда 0.
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
