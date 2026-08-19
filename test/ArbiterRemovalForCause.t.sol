// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Снос арбитра с поводом.
//
// Половина настоящих поводов проверяема цепью, половина — нет никогда. Если
// обе выглядят в записи одинаково, «доказательство в цепи» становится враньём
// для второй половины. Поэтому повод — это КОД, и цепь знает, какие коды она
// обязана проверить:
//   • OverturnedVerdicts / Timeouts / Silence — проверяет сама, без признака
//     транзакция откажет;
//   • Collusion / Leak / Other — не проверяет ничего и не притворяется:
//     требует непустой отпечаток доказательства и помечает запись
//     verifiedByChain = false.
//
// Право сноса передаётся, а не запирается: до передачи зовёт только
// владелец, после — только daoAddress. «После» — это пара «ДАО активна И
// преемник назван» (п. 69, 16 августа 2026), тот же предикат, что у двери
// посадки: одного `isDaoActive()` мало, он включается заработанным порогом
// сам, чужим действием, и в окне без преемника дверь не открывал никто.
// Дыра в первой версии этого плана
// («после ДАО не может никто») найдена владельцем ДО реализации: голосования
// по арбитрам в коде нет, daoAddress по умолчанию нулевой, и чистый лок означал
// бы, что сговор и слив переписки после включения ДАО становятся неснимаемыми
// вовсе — автоматика ловит только то, что видит цепь.
//
// ⚠️ Смещения слотов ниже добыты одноразовым перебором (offset 0..59, запись
// пробного значения, сверка с боевым getter'ом), НЕ взяты из брифа задачи:
// тот дважды промахнулся (arbiterMistakeStreak — 18 в брифе, реальность 11;
// упаковка chiefArbiter/daoActiveManual в один слот 5 сдвигает индексы всех
// полей после него на единицу назад относительно наивного расчёта без
// упаковки). Верно предположенные в брифе значения (SLOT_NO_RESPONSE=23,
// смещение chiefArbiter=5) подтверждены тем же перебором, не на слово.
//
// ═══════════════ КРУГ ПРАВОК 1 (ревью, 15 августа 2026) ═══════════════
//
// C-1: MISTAKE_THRESHOLD == MAX_ARBITER_MISTAKES делало OverturnedVerdicts/
// Timeouts недостижимыми НИКОГДА — _recordArbiterMistake сбрасывает счётчик
// В ТОЙ ЖЕ транзакции, что снимает isArbiter, поэтому "streak == 3 И
// isArbiter == true" — состояние, которое живой контракт произвести не
// способен, а вот стенд vm.store'ом — способен, отсюда ложно-зелёные тесты.
// Порог стал MAX_ARBITER_MISTAKES − 1 = 2 (объявлен как вычитание в самом
// фасете, не отдельным литералом). Все streak-значения ниже пересчитаны под
// 2, а не под старые 3. Добавлен test_OverturnedVerdictsIsReachableThroughRealPath
// (в отдельном интеграционном файле — см. test/ArbiterRemovalForCauseIntegration.t.sol)
// с БОЕВЫМ путём через overturnVerdict.
//
// C-2: форфейт бонда не был покрыт НИЧЕМ — все expectEmit ждали
// bondForfeited=0. test_RemovalForCauseForfeitsTheBond ниже.
//
// C-3: setDAOAddress остался бы обходом храповика (activateDAO → setDAOAddress
// (свой адрес) → снос по ветке daoAddress) — починено в ArbiterRegistryFacet,
// тесты на обе стороны в test/ArbiterSeatingHandover.t.sol.
//
// I-4: test_RemovalForCauseRevertsIfNotAnArbiter (ниже) + выпиливание из
// arbiterList (test/ArbiterRemovalForCauseIntegration.t.sol — нужен getArbiters(),
// его тут нет).
//
// I-6: test_UnverifiableCauseRejectsDisputeRef (ниже) — вторая копия
// DisputeRefNotApplicable, вне _requireProven, не была покрыта вовсе.
//
// I-7: isRegisteredArbiterHere/getMistakeStreakOf/getNoResponseAtHere сняты —
// ровно тот дефект, что getChiefArbiterAddress в задаче 5 (дубли уже
// смонтированных ArbiterRegistryFacet.isRegisteredArbiter/getArbiterMistakeStreak/
// getNoResponseAt). Пост-условия «больше не арбитр» читаются через
// _isArbiterRaw (vm.load по слоту 0, уже доказанному живым: на нём держится
// КАЖДЫЙ тест в этом файле через setUp). Смещения arbiterMistakeStreak и
// disputeNoResponseAtBy сторожат отдельные ИМЕНОВАННЫЕ тесты (не через
// геттер-тождество, а боевым путём — позитив/негатив), как сделано с
// директором в задаче 5.
//
// M-9: _isDaoActive теперь полное выражение (ручной флаг ИЛИ заработанный
// порог), как ArbiterRegistryFacet.isDaoActive(). test_DaoThresholdMatchesRegistry
// и test_EarnedDaoActivatesWithoutManualFlag ниже.

import "forge-std/Test.sol";
import {ArbiterAccountabilityFacet} from "../src/facets/ArbiterAccountabilityFacet.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";
import {FactoryStorage} from "../src/FactoryFacet.sol";
import {MinimalForwarder} from "../src/MinimalForwarder.sol";

contract ArbiterRemovalForCauseTest is Test {
    ArbiterAccountabilityFacet acc;

    address owner;
    address chief;
    address arbiter;

    bytes32 constant ARB_BASE = 0xaae71de0594cbcb5434f0ab7f7501c1be178552bf788b418a1c2624ba9718d00;
    bytes32 constant OWNER_SLOT = 0x178642b411f9f4783b21ef338f3e96db6c1272d763f0b7500ec93464dafb8604;
    bytes32 constant REP_BASE = 0xa32193c5e38bd2de27c8550f156d709eafdc63aaa4290e5e27473f2ffc097400;

    /// Добыто перебором (см. докстринг файла). Брифом было предложено 18 —
    /// промах: настоящее смещение 11, сторожится тестом ниже.
    uint256 constant SLOT_MISTAKE_STREAK = 11;

    /// arbiterBond — слот 12, vaultBalance — слот 9. Оба добыты перебором
    /// (круг правок 1, C-2) против ArbiterRegistryFacet.getArbiterBond/
    /// getVaultBalance — та же раскладка, другой развёрнутый контракт.
    uint256 constant SLOT_ARBITER_BOND = 12;
    uint256 constant SLOT_VAULT_BALANCE = 9;

    /// uniqueActiveUsers в ReputationStorage — слот 8, добыт перебором
    /// (круг правок 1, M-9) против ReputationFacet.getUniqueActiveUsers().
    /// Все семь полей перед ним в struct Data — мэппинги (каждый съедает
    /// ровно один слот целиком, упаковки с ним нет — uniqueActiveUsers сам
    /// uint256, следующий за ним cleanStreak снова мэппинг).
    uint256 constant SLOT_UNIQUE_ACTIVE_USERS = 8;

    /// Words the stand puts on a proposal whose cause the chain does not check
    /// (those causes require both a digest and words). Short and constant on
    /// purpose: what these scenes test is the pause, not the words.
    string constant PROPOSAL_WORDS = "the accusation, stated once, on the proposal";

    /// Отпечаток, которым обходятся сцены про саму дверь: поводы, которые цепь
    /// не проверяет, требуют непустой bytes32, но какой именно — этим сценам
    /// безразлично. Один на всех, чтобы разница в отпечатке не читалась как
    /// часть проверяемого правила.
    bytes32 constant DIGEST = keccak256("the evidence, attested not verified");


    function setUp() public {
        acc = new ArbiterAccountabilityFacet();
        owner   = address(this);
        chief   = address(0xC4);
        arbiter = address(0xA1);
        vm.store(address(acc), OWNER_SLOT, bytes32(uint256(uint160(owner))));
        vm.store(address(acc), keccak256(abi.encode(arbiter, uint256(ARB_BASE))), bytes32(uint256(1)));
    }

    // ---------- ПРОВЕРЯЕМЫЕ ЦЕПЬЮ ----------

    function test_OverturnedVerdictsRequiresTheStreak() public {
        _setStreak(arbiter, 1);   // порог теперь 2 (C-1) — единицы не хватает
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        vm.expectRevert(
            abi.encodeWithSelector(ArbiterAccountabilityFacet.CauseNotProven.selector, uint8(0))
        );
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), "");
    }

    function test_OverturnedVerdictsPassesAtThreshold() public {
        _setStreak(arbiter, 2);   // MISTAKE_THRESHOLD = MAX_ARBITER_MISTAKES(3) − 1

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.ArbiterRemovedForCause(
            arbiter, owner, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, true, bytes32(0), 0
        );

        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), "");
        assertFalse(_isArbiterRaw(arbiter), unicode"снятый больше не арбитр");
    }

    // ---------- ЗАВЕРЯЕМЫЕ, НО НЕ ПРОВЕРЯЕМЫЕ ----------

    function test_CollusionWithoutEvidenceIsRefused() public {
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("the proposal's own evidence"), PROPOSAL_WORDS);
        vm.expectRevert(ArbiterAccountabilityFacet.EvidenceRequired.selector);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, bytes32(0), address(0), unicode"трижды забирал споры одного контрагента и трижды решал в его пользу");
    }

    function test_CollusionWithEvidenceIsMarkedUnverified() public {
        bytes32 digest = keccak256(unicode"переписка со стороной спора");

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("the proposal's own evidence"), PROPOSAL_WORDS);
        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.ArbiterRemovedForCause(
            arbiter, owner, ArbiterAccountabilityFacet.Cause.Collusion, false, digest, 0
        );

        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, digest, address(0), unicode"трижды забирал споры одного контрагента и трижды решал в его пользу");
    }

    /// I-6 (круг правок 1): вторая копия DisputeRefNotApplicable, живущая ВНЕ
    /// _requireProven (на пути Collusion/Leak/Other), не была покрыта ничем —
    /// снять её раньше давало 0 красных.
    function test_UnverifiableCauseRejectsDisputeRef() public {
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("the proposal's own evidence"), PROPOSAL_WORDS);
        vm.expectRevert(ArbiterAccountabilityFacet.DisputeRefNotApplicable.selector);
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), address(0xD1),
            unicode"трижды забирал споры одного контрагента и трижды решал в его пользу"
        );
    }

    /// Silence — признак ПО КОНКРЕТНОМУ СПОРУ, и без адреса спора проверить
    /// его нечем. Слить его со счётчиком серии нельзя: тогда цепь заверяла бы
    /// не то, что написано в записи.
    function test_SilenceRequiresDisputeRef() public {
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Silence, bytes32(0), "");
        vm.expectRevert(ArbiterAccountabilityFacet.DisputeRefRequired.selector);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Silence, bytes32(0), address(0), "");
    }

    function test_SilenceRequiresTheRecord() public {
        address deal = address(0xD1);
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Silence, bytes32(0), "");
        vm.expectRevert(
            abi.encodeWithSelector(ArbiterAccountabilityFacet.CauseNotProven.selector, uint8(2))
        );
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Silence, bytes32(0), deal, "");
    }

    function test_SilencePassesWhenRecorded() public {
        address deal = address(0xD1);
        _setNoResponse(deal, arbiter, 1_700_000_000);
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Silence, bytes32(0), "");
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Silence, bytes32(0), deal, "");
        assertFalse(_isArbiterRaw(arbiter), unicode"снят по записанному молчанию");
    }

    /// Адрес спора у кода, который его не читает, — мусор в записи: читатель
    /// решит, что снос связан с той сделкой.
    function test_DisputeRefIsRefusedWhereItDoesNotApply() public {
        _setStreak(arbiter, 2);
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        vm.expectRevert(ArbiterAccountabilityFacet.DisputeRefNotApplicable.selector);
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0xD1),
            ""
        );
    }

    /// Timeouts и OverturnedVerdicts упираются в ОДИН счётчик — цепь их не
    /// различает. Тест это фиксирует, чтобы никто не считал, будто различает.
    function test_TimeoutsUsesTheSameCounter() public {
        _setStreak(arbiter, 2);
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Timeouts, bytes32(0), "");
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Timeouts, bytes32(0), address(0), "");
        assertFalse(_isArbiterRaw(arbiter));
    }

    // ---------- КТО МОЖЕТ ----------

    function test_ChiefCannotRemove() public {
        _setStreak(arbiter, 2);
        _setChief(chief);
        vm.prank(chief);
        vm.expectRevert(ArbiterAccountabilityFacet.NotOwner.selector);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), "");
    }

    /// I-4 (круг правок 1): NotAnArbiter на пути сноса не был покрыт ничем.
    function test_RemovalForCauseRevertsIfNotAnArbiter() public {
        address stranger = address(0xF00D); // никогда не регистрировался
        vm.expectRevert(ArbiterAccountabilityFacet.NotAnArbiter.selector);
        acc.removeArbiterForCause(stranger, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), "");
    }

    /// Храповик: после активации ДАО И назначения преемника владельца цепь не
    /// пускает вовсе — право уехало к daoAddress.
    ///
    /// ⚠️ `_setDaoAddress` здесь обязателен (п. 69, 16 августа 2026). Прежняя
    /// редакция намеренно оставляла преемника нулевым и ждала
    /// RemovalHandedOver — то есть сторожила ровно то состояние, в котором
    /// дверь не открывал никто. Сценарий «активировали, забыли назначить»
    /// теперь проверяется с противоположным ожиданием:
    /// test_EarnedDaoWithoutSuccessorLeavesRemovalWithTheOwner.
    ///
    /// ⚠️ Чем эта запертая дверь НЕ является — решение по п. 69, 16 августа
    /// 2026. Она не ограничивает владельца: у него остаются `overturnVerdict`
    /// (onlyOwnerOrDAO пускает его ВСЕГДА, а MAX_ARBITER_MISTAKES = 3 — три
    /// отмены подряд снимают арбитра автодемоушеном) и `diamondCut`, которым
    /// фасет заменяется целиком.
    ///
    /// ⚠️ ЦЕНА ЭТОГО ОБХОДА НАЗВАНА ТОЧНО (уборка 7а, п. 2.5). Прежняя
    /// редакция говорила просто «три overturnVerdict», и это преувеличивало —
    /// путь не бесплатный и не всегда доступен. Что он требует на самом деле,
    /// сверено с кодом, а не оценено:
    ///
    ///   • ЖИВОЙ, ещё не финализированный вердикт ИМЕННО ЭТОГО арбитра
    ///     (`v.submittedAt != 0`, `!v.finalized`, и не идёт апелляция). Против
    ///     арбитра, который вердиктов не подавал, путь не открыт ВОВСЕ;
    ///   • время: `finalizeVerdict` физически недоступна первые
    ///     `FINALIZE_DELAY` = 24 часа от подачи, а после — доступна КОМУ
    ///     УГОДНО. То есть окно у владельца не «сутки», а «пока кто-нибудь не
    ///     финализировал»; гарантированы только первые сутки.
    ///
    ///   • ТРИ РАЗНЫХ СПОРА — с 18 августа 2026 (задача 11) именно так, и до
    ///     неё было НЕ так: флаг `v.overturned` писался и нигде не читался как
    ///     запрет, поэтому три отмены ОДНОГО агримента в одном блоке снимали
    ///     арбитра. То есть цена пути равнялась одному поданному вердикту.
    ///     Теперь флаг отказывает (`AlreadyOverturned`), и владельцу нужны три
    ///     живых вердикта по трём разным спорам — каждый со своим окном и
    ///     своей стороной, которая вправе его финализировать раньше. Замерено
    ///     живым тестом ArbiterRemovalForCauseIntegration::
    ///     test_OneVerdictCannotBeOverturnedThreeTimes.
    ///
    ///     ⚠️ И ЭТО СТАЛО ПРАВДОЙ НЕ СРАЗУ. В первой редакции задачи 11 строка
    ///     выше уже стояла, а цена на деле была ДВА спора, не три: владелец
    ///     переворачивал рукой, проигравший подавал апелляцию (она остаётся
    ///     открытой намеренно — это единственная проверка на владельца), и
    ///     коллегия, ВЕРНУВШАЯ вердикт арбитра, записывала арбитру вторую
    ///     ошибку. То есть верное решение честной коллегии дарило владельцу
    ///     половину пути. Закрыто кругом правок в resolveAppeal: сцены
    ///     Diamond::test_PanelVindicatingTheArbiterClearsHisMistake и
    ///     Diamond::test_VindicationAfterDemotionDoesNotUnderflowTheStreak.
    ///
    /// Настоящая ЗАПАСНАЯ дверь — не эта, а `diamondCut`: она не требует ни
    /// вердикта, ни времени, ни повода и заменяет фасет целиком.
    ///
    /// Замок глушит ГРОМКУЮ дверь — ту, что кладёт в цепь повод, отпечаток и
    /// имя нажавшего, — и выталкивает снос на тихие пути, где в ленте видно
    /// только отменённые вердикты. Держим его не как преграду, а как правило
    /// протокола, обещанное публично.
    function test_OwnerCannotRemoveAfterDAO() public {
        _setStreak(arbiter, 2);
        _setDaoAddress(address(0xDA0));
        _activateDAO();
        vm.expectRevert(ArbiterAccountabilityFacet.RemovalHandedOver.selector);
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0),
            ""
        );
    }

    /// Передача, а не запирание в пустоту (правка владельца после первой
    /// версии плана): daoAddress назначен, но ДАО ещё не активна — дверь
    /// по-прежнему только у владельца.
    function test_DaoAddressCannotRemoveBeforeDao() public {
        _setStreak(arbiter, 2);
        address dao = address(0xDA0);
        _setDaoAddress(dao);
        vm.prank(dao);
        vm.expectRevert(ArbiterAccountabilityFacet.NotOwner.selector);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), "");
    }

    /// Симметричная половина test_OwnerCannotRemoveAfterDAO: назначенный
    /// daoAddress ПОСЛЕ активации ДАО может снимать — право не потеряно,
    /// оно уехало к конкретному адресу.
    function test_DaoAddressCanRemoveAfterDao() public {
        _setStreak(arbiter, 2);
        address dao = address(0xDA0);
        _setDaoAddress(dao);
        _activateDAO();

        // The successor proposes for himself: past handover the owner cannot
        // (review round 2, 17 August 2026), and the whole point of a handover
        // is that he needs nobody.
        _proposeAndWaitAs(dao, arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.ArbiterRemovedForCause(
            arbiter, dao, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, true, bytes32(0), 0
        );

        vm.prank(dao);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), "");
        assertFalse(_isArbiterRaw(arbiter), unicode"снят голосованием ДАО после передачи");
    }

    // ---------- ФОРФЕЙТ БОНДА (C-2, круг правок 1) ----------

    /// Снос по поводу — не самостоятельный уход: бонд форфейтится в банк
    /// арбитров (обратное поведение resignAsArbiter, который возвращает).
    /// Не было покрыто НИЧЕМ — все expectEmit ждали bondForfeited=0, потому
    /// что бонд ни разу не выставлялся. Снять блок форфейта раньше давало
    /// 0 красных.
    function test_RemovalForCauseForfeitsTheBond() public {
        uint256 bond = 50_000_000; // 50 USDC, тот же порядок, что ARBITER_BOND
        _setArbiterBond(arbiter, bond);
        _setStreak(arbiter, 2);

        assertEq(_getArbiterBond(arbiter), bond, unicode"сетап: бонд выставлен");
        assertEq(_getVaultBalance(), 0, unicode"сетап: банк пуст");

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.ArbiterRemovedForCause(
            arbiter, owner, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, true, bytes32(0), bond
        );

        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), "");

        assertEq(_getArbiterBond(arbiter), 0, unicode"бонд снят с арбитра");
        assertEq(_getVaultBalance(), bond, unicode"бонд ушёл в банк арбитров, не пропал");
    }

    // ---------- ОЧИСТКА МЕСТА (закрывает пробел задачи 1) ----------

    /// Задача 1 намеренно оставила removeArbiter без теста очистки места,
    /// потому что задача 6 её удаляет. removeArbiterForCause — новый
    /// единственный путь снятия чужой посадки, и путь очистки места обязан
    /// работать и через него: посаженный директором арбитр снесён —
    /// getSeatedCountBy(директор) обязан упасть.
    function test_RemovalForCauseFreesDirectorSlot() public {
        address director = address(0xD3);
        _setStreak(arbiter, 2);
        _setSeatedBy(arbiter, director);
        _setSeatedCountBy(director, 1);
        assertEq(_getSeatedCountBy(director), 1, unicode"сетап: посадка директора учтена");

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), "");

        assertEq(_getSeatedCountBy(director), 0, unicode"снос по поводу обязан освобождать место посадившего");
    }

    // ---------- СТОРОЖА СМЕЩЕНИЙ (I-7, круг правок 1) ----------
    //
    // isRegisteredArbiterHere/getMistakeStreakOf/getNoResponseAtHere сняты —
    // ровно тот дефект, что getChiefArbiterAddress в задаче 5 (дубли уже
    // смонтированных геттеров ArbiterRegistryFacet через диамонд). Как и там,
    // сторож смещения — ИМЕНОВАННЫЙ, ОТДЕЛЬНЫЙ тест, а не побочный эффект
    // других тестов: та защита случайна и исчезла бы незаметно, если бы
    // кто-то в будущем убрал или переписал именно тот тест.

    /// Позитив: streak выставлен ЧЕРЕЗ ВЫЧИСЛЕННЫЙ СЛОТ на пороге — снос
    /// проходит. Негатив: ДРУГОЙ, нетронутый арбитр — снос падает. Различие
    /// доказывает, что тест видит записанный слот, а не совпадает при любом
    /// смещении (тождество записи с собой такого различия дать не может).
    function test_MistakeStreakSlotOffsetIsCorrect() public {
        address untouched = address(0xA9);
        vm.store(address(acc), keccak256(abi.encode(untouched, uint256(ARB_BASE))), bytes32(uint256(1)));

        _proposeAndWait(untouched, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        vm.expectRevert(
            abi.encodeWithSelector(ArbiterAccountabilityFacet.CauseNotProven.selector, uint8(0))
        );
        acc.removeArbiterForCause(untouched, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), "");

        _setStreak(arbiter, acc.getMistakeThreshold());
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), "");
        assertFalse(_isArbiterRaw(arbiter), unicode"снятый больше не арбитр");
    }

    /// Тот же приём для disputeNoResponseAtBy: позитив (запись через
    /// вычисленный слот — снос проходит) и негатив (другая сделка — падает).
    function test_NoResponseSlotOffsetIsCorrect() public {
        address deal = address(0xD1);
        address untouchedDeal = address(0xD2);

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Silence, bytes32(0), "");
        vm.expectRevert(
            abi.encodeWithSelector(ArbiterAccountabilityFacet.CauseNotProven.selector, uint8(2))
        );
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Silence, bytes32(0), untouchedDeal, "");

        _setNoResponse(deal, arbiter, 1_700_000_000);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Silence, bytes32(0), deal, "");
        assertFalse(_isArbiterRaw(arbiter), unicode"снят по записанному молчанию");
    }

    // ---------- M-9 (круг правок 1): полное выражение ДАО ----------

    function test_DaoThresholdMatchesRegistry() public {
        ArbiterRegistryFacet reg = new ArbiterRegistryFacet();
        assertEq(acc.getDaoThresholdMirror(), reg.getDaoThreshold(),
            unicode"порог авто-ДАО обязан быть один на оба фасета");
    }

    /// Заработанный порог (uniqueActiveUsers >= DAO_THRESHOLD) обязан
    /// закрывать дверь ТАК ЖЕ, как ручной activateDAO() — без единого его
    /// вызова. До правки M-9 _isDaoActive читал только daoActiveManual, и
    /// этот сценарий проходил бы мимо.
    ///
    /// ⚠️ Преемник назначается явно (п. 69, 16 августа 2026): с 16 августа
    /// заработанный порог САМ ПО СЕБЕ дверь не закрывает — закрывает пара
    /// «порог плюс названный преемник», как у двери посадки. Проверка про
    /// заработанный порог БЕЗ преемника — отдельная и с другим ожиданием.
    ///
    /// ⚠️ Тот же довод, что у test_OwnerCannotRemoveAfterDAO: закрытая дверь
    /// владельца не ограничивает — у него остаются `overturnVerdict`
    /// (автодемоушен на MAX_ARBITER_MISTAKES = 3) и `diamondCut`. Точная цена
    /// первого пути — в докстринге того теста: он требует ТРЁХ живых
    /// нефинализированных вердиктов этого арбитра, по одному на спор (задача
    /// 11, 18 августа 2026). Безусловная запасная дверь — `diamondCut`. Замок глушит
    /// громкую дверь с поводом и именем нажавшего и выталкивает снос на тихие
    /// пути. Это правило протокола, а не преграда.
    function test_EarnedDaoActivatesWithoutManualFlag() public {
        _setStreak(arbiter, 2);
        _setUniqueActiveUsers(acc.getDaoThresholdMirror());
        _setDaoAddress(address(0xDA0));

        vm.expectRevert(ArbiterAccountabilityFacet.RemovalHandedOver.selector);
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0),
            ""
        );
    }

    // ── п. 69 (16 августа 2026): предикат храповика ──
    //
    // Заработанный порог включает ДАО САМ, чужим действием и без единой
    // человеческой транзакции. Пока преемник не назван, отдавать право
    // сноса некому — и предикат обязан это учитывать ровно так же, как
    // учитывает соседняя дверь посадки (_requireSeatingNotHandedOver).

    /// Порог заработан, преемника нет — дверь остаётся у владельца.
    /// До правки здесь ревертило RemovalHandedOver, и снести не мог НИКТО:
    /// условие вырождалось в `msg.sender != address(0)`.
    function test_EarnedDaoWithoutSuccessorLeavesRemovalWithTheOwner() public {
        _setStreak(arbiter, 2);
        _setUniqueActiveUsers(acc.getDaoThresholdMirror());
        // daoAddress НЕ назначаем — это и есть разбираемое окно

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0),
            ""
        );

        assertFalse(
            _isArbiterRaw(arbiter),
            unicode"пока преемника нет, дверь у владельца — и она открывается"
        );
    }

    /// Как только преемник назван — дверь уезжает, и при заработанном пороге
    /// точно так же, как при ручном флаге. Вторая половина той же правки:
    /// без неё «остаётся у владельца» превратилось бы в «остаётся у владельца
    /// навсегда».
    function test_EarnedDaoWithSuccessorHandsRemovalOver() public {
        _setStreak(arbiter, 2);
        _setUniqueActiveUsers(acc.getDaoThresholdMirror());
        _setDaoAddress(address(0xDA0));

        vm.expectRevert(ArbiterAccountabilityFacet.RemovalHandedOver.selector);
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0),
            ""
        );
    }

    /// Контроль стыка, а не замок: три места об одном условии обязаны отвечать
    /// одинаково. Единственным красным он не бывает никогда — на любой порче
    /// рядом краснеет собственный тест испорченной стороны. Он ловит РАЗЪЕЗД
    /// пары: если завтра кто-то ослабит предикат посадки в реестре, здесь
    /// станет видно, что двери перестали закрываться вместе.
    function test_HandoverPredicateMatchesSeatingPredicate() public {
        ArbiterRegistryFacet reg = new ArbiterRegistryFacet();
        vm.store(address(reg), OWNER_SLOT, bytes32(uint256(uint160(owner))));
        vm.store(
            address(reg),
            bytes32(uint256(REP_BASE) + SLOT_UNIQUE_ACTIVE_USERS),
            bytes32(acc.getDaoThresholdMirror())
        );

        assertTrue(reg.isDaoActive(), unicode"сетап: порог заработан обеими сторонами");
        assertEq(reg.getDAOAddress(), address(0), unicode"сетап: преемника нет");

        // Дверь ПОСАДКИ в этом состоянии открыта владельцу — это уже так, и
        // именно с ней дверь сноса обязана совпадать.
        reg.addArbiter(address(0xA7));
        assertTrue(
            reg.isRegisteredArbiter(address(0xA7)),
            unicode"посадка при заработанном пороге без преемника работает — значит и снос обязан"
        );
    }

    // ============================================================
    //  ПРЕДЛОЖЕНИЕ ДИРЕКТОРА (задача 7, 15 августа 2026)
    //
    //  Директор не сносит — он предлагает. Предложение ложится в цепь
    //  отдельной записью с его адресом, и владелец соглашается отдельной.
    //  Значит в ленте видно И кто предложил, И кто согласился.
    //
    //  Предложение ПРОТУХАЕТ: иначе оно висит в хранилище вечным обвинением
    //  против работающего арбитра, и «предложение есть» перестаёт значить
    //  «претензия жива».
    // ============================================================

    function test_ChiefProposes() public {
        _setChief(chief);
        bytes32 digest = keccak256(unicode"докладная");
        uint256 t0 = vm.getBlockTimestamp();

        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.RemovalProposed(
            arbiter, chief, ArbiterAccountabilityFacet.Cause.Leak, digest, t0
        );

        vm.prank(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, digest, unicode"выложил переписку по спору третьей стороне");

        (uint8 c, bytes32 dg, uint256 at, address by, bool live) = acc.getRemovalProposal(arbiter);
        assertEq(c, uint8(ArbiterAccountabilityFacet.Cause.Leak));
        assertEq(dg, digest);
        assertEq(at, t0);
        assertEq(by, chief);
        assertTrue(live, unicode"свежее предложение обязано быть live");
    }

    function test_ProposalExpires() public {
        _setChief(chief);
        vm.prank(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"), unicode"выложил переписку по спору третьей стороне");

        vm.warp(vm.getBlockTimestamp() + 14 days);
        assertFalse(acc.hasLiveProposal(arbiter), unicode"через 14 суток предложение протухло");
    }

    function test_ProposalIsLiveUntilTheLastSecond() public {
        _setChief(chief);
        vm.prank(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"), unicode"выложил переписку по спору третьей стороне");

        vm.warp(vm.getBlockTimestamp() + 14 days - 1);
        assertTrue(acc.hasLiveProposal(arbiter), unicode"за секунду до конца ещё живо");
    }

    /// ⚠️ COUNTER-HALF of test_ChiefCannotWithdrawTheOwnersProposal since
    /// 17 August 2026 (review round 1 of the pause). The new rule is "your own
    /// only", not "nothing": a lock forbidding the chief every withdrawal would
    /// pass the forbidding measurement and kill the role in silence. This test
    /// is what reddens if that happens.
    function test_ChiefWithdrawsHisOwnProposal() public {
        _setChief(chief);
        vm.startPrank(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"), unicode"выложил переписку по спору третьей стороне");
        acc.withdrawProposal(arbiter);
        vm.stopPrank();
        assertFalse(acc.hasLiveProposal(arbiter), unicode"передумал — отозвал");
    }

    // ────────────────────────────────────────────────────────────
    //  THE ACCUSATION DOOR TRAVELS WITH THE RIGHT TO ACT ON IT
    //  (review round 2 of the pause, 17 August 2026)
    //
    //  proposeRemoval stood under onlyOwnerOrChief alone, and the named
    //  successor fits through neither half of that. Harmless while the proposal
    //  was optional — he removed with one button and needed nobody. The pause
    //  made the proposal MANDATORY, and so cancelled the very handover this
    //  branch was built to deliver: the right had moved, but the successor
    //  could not use it until the FORMER owner laid a proposal for him. A veto
    //  by inaction, invisible in the feed, held by the one person the handover
    //  exists to take out of the loop.
    // ────────────────────────────────────────────────────────────

    /// The designated lock. After handover the successor lays his own
    /// accusation and needs nobody — checked by the record, not by "it did not
    /// revert": the proposal must stand, and stand under HIS address.
    function test_SuccessorProposesAfterHandover() public {
        address dao = address(0xDA0);
        _setDaoAddress(dao);
        _activateDAO();

        vm.prank(dao);
        acc.proposeRemoval(
            arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"),
            unicode"выложил переписку по спору третьей стороне"
        );

        assertTrue(acc.hasLiveProposal(arbiter), "the successor's accusation is on chain");
        (, , , address by, ) = acc.getRemovalProposal(arbiter);
        assertEq(by, dao, "and it stands under his own address, not the former owner's");
    }

    /// The other side of the same rule: the handover is whole or it is theatre.
    /// A proposal the former owner could still lay would be executable by the
    /// successor, so leaving him the door would leave him in the loop by the
    /// back way.
    function test_OwnerCannotProposeAfterHandover() public {
        _setDaoAddress(address(0xDA0));
        _activateDAO();

        vm.expectRevert(ArbiterAccountabilityFacet.RemovalHandedOver.selector);
        acc.proposeRemoval(
            arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"),
            unicode"выложил переписку по спору третьей стороне"
        );
        assertFalse(acc.hasLiveProposal(arbiter), "and nothing was written");
    }

    // ────────────────────────────────────────────────────────────
    //  WITHDRAWING SOMEONE ELSE'S PROPOSAL (review round 1 of the pause,
    //  17 August 2026)
    //
    //  The pause turned withdrawal into a weapon it never was. While a proposal
    //  was only a signal, clearing another person's record took nothing away.
    //  Now the removal runs ONLY through a proposal that has sat — so clearing
    //  the record is the power to STOP a removal, again and again, for as long
    //  as the accuser keeps trying.
    //
    //  Rule: your own only. Plus whoever holds the removal right may clear
    //  anyone's — before handover the owner, after it the named successor, by
    //  the SAME predicate as the removal itself.
    // ────────────────────────────────────────────────────────────

    /// The designated lock. Refusal is checked by BEHAVIOUR as well as by the
    /// label: the proposal must still be standing afterwards, or "he was
    /// refused" would say nothing about whether the record survived.
    function test_ChiefCannotWithdrawTheOwnersProposal() public {
        _setChief(chief);
        acc.proposeRemoval(
            arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"),
            unicode"выложил переписку по спору третьей стороне"
        );

        vm.prank(chief);
        vm.expectRevert(ArbiterAccountabilityFacet.NotYourProposal.selector);
        acc.withdrawProposal(arbiter);

        assertTrue(acc.hasLiveProposal(arbiter), "the accusation is still standing");
        (, , , address by, ) = acc.getRemovalProposal(arbiter);
        assertEq(by, owner, "and it is still the owner's");
    }

    /// The right to clear anyone's travels WITH the right to remove.
    ///
    /// ⚠️ THE REFUSAL CHANGED ITS LABEL IN REVIEW ROUND 4 OF TASK 12 (19 August
    /// 2026), and the property got STRONGER rather than different. It used to
    /// be NotYourProposal — "this record is not yours" — which was true but
    /// small: the former owner was refused as a stranger to this particular
    /// record, and would still have cleared one he had laid himself.
    ///
    /// withdrawProposal now has its own handover branch, so he is refused as a
    /// man who gave the door away: RemovalHandedOver, and it applies to every
    /// record including his own. Same reasoning proposeRemoval already carried
    /// — "a proposal he could still lay would be executable by the successor,
    /// so keeping it would keep him in the loop by the back door" — read on the
    /// other side: a veto he could still exercise keeps him in the loop just as
    /// well. The handover is whole or it is theatre.
    ///
    /// The larger reason is the one the person should read; that is the same
    /// rule AlreadyOverturned is ordered by. What is asserted below did not
    /// move: the record survives him.
    function test_AfterHandoverTheOwnerCannotWithdrawTheChiefsProposal() public {
        _setChief(chief);
        vm.prank(chief);
        acc.proposeRemoval(
            arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"),
            unicode"выложил переписку по спору третьей стороне"
        );

        _setDaoAddress(address(0xDA0));
        _activateDAO();

        vm.expectRevert(ArbiterAccountabilityFacet.RemovalHandedOver.selector);
        acc.withdrawProposal(arbiter);
        assertTrue(acc.hasLiveProposal(arbiter), "the chief's record survived the former owner");
    }

    /// And the door has an opener on the far side — otherwise "the owner may no
    /// longer" would mean "nobody may", which is the exact trap В-2 dug out of
    /// liftSuspension. onlyOwnerOrChief would not have let the successor in at
    /// all.
    function test_AfterHandoverTheSuccessorWithdrawsAnyProposal() public {
        address dao = address(0xDA0);
        _setChief(chief);
        vm.prank(chief);
        acc.proposeRemoval(
            arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"),
            unicode"выложил переписку по спору третьей стороне"
        );

        _setDaoAddress(dao);
        _activateDAO();

        vm.expectEmit(true, true, false, true, address(acc));
        emit ArbiterAccountabilityFacet.RemovalProposalWithdrawn(arbiter, dao);
        vm.prank(dao);
        acc.withdrawProposal(arbiter);

        assertFalse(acc.hasLiveProposal(arbiter), "whoever removes today also clears");
    }

    /// ⚠️ COUNTER-HALF of the handover rule since review round 2 (17 August
    /// 2026): a stranger is still refused before handover, and refused BY ROLE
    /// (NotOwnerOrChief). A gate narrowed to "the removal authority only" would
    /// pass test_SuccessorProposesAfterHandover and silently take the door from
    /// the chief; this and test_ChiefProposes are what redden then.
    function test_StrangerCannotPropose() public {
        vm.prank(address(0x5A));
        vm.expectRevert(ArbiterAccountabilityFacet.NotOwnerOrChief.selector);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"), unicode"выложил переписку по спору третьей стороне");
    }

    /// Второе требование контроллера сверх брифа: код заверяемый — отпечаток
    /// обязателен УЖЕ на этапе предложения, не только при исполнении.
    function test_ProposeUnverifiableWithoutEvidenceIsRefused() public {
        _setChief(chief);
        vm.prank(chief);
        vm.expectRevert(ArbiterAccountabilityFacet.EvidenceRequired.selector);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, bytes32(0), unicode"трижды забирал споры одного контрагента и трижды решал в его пользу");
    }

    /// Проверяемые цепью коды (OverturnedVerdicts/Timeouts/Silence) на этапе
    /// предложения НЕ проверяются намеренно: streak здесь ниже порога, а
    /// предложение всё равно проходит — признак может появиться уже после
    /// того, как директор предупредил.
    function test_ProposeVerifiableCauseDoesNotCheckTheStreakYet() public {
        _setChief(chief);
        // streak НЕ выставлен — ниже MISTAKE_THRESHOLD (и вообще ноль).
        vm.prank(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        assertTrue(acc.hasLiveProposal(arbiter), unicode"проверяемый код не сверяется на этапе предложения");
    }

    /// Владелец предлагает наравне с директором — `_requireOwnerOrChief`
    /// пускает обоих, не только директора.
    ///
    /// ⚠️ «Под модификатором» больше не говорим: `proposeRemoval` его с
    /// подписи потеряла ещё кругом правок 2 паузы и зовёт проверку явно, в
    /// ветке «передачи не было». Сегодня модификатор носит одна функция этого
    /// фасета — `suspendArbiter`. Сцена ДО передачи, и это существенно:
    /// после неё владельца не пускает никто.
    function test_OwnerCanAlsoPropose() public {
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"), unicode"выложил переписку по спору третьей стороне");
        (, , , address by, ) = acc.getRemovalProposal(arbiter);
        assertEq(by, owner);
    }

    /// Владелец может отозвать предложение, положенное директором: право
    /// отзыва не привязано к тому, кто именно предложил, — чужое чистит
    /// держатель права сноса.
    ///
    /// ⚠️ Здесь стояло «оба ходят под одним модификатором». `withdrawProposal`
    /// модификатора не носит с круга правок 1 паузы, а с круга правок 4 задачи
    /// 12 у неё своя ветка передачи. Сцена ДО передачи; после неё отзывает
    /// только преемник, и владелец получает RemovalHandedOver — см.
    /// test_AfterHandoverTheOwnerCannotWithdrawTheChiefsProposal ниже.
    function test_OwnerWithdrawsChiefsProposal() public {
        _setChief(chief);
        vm.prank(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"), unicode"выложил переписку по спору третьей стороне");

        acc.withdrawProposal(arbiter);
        assertFalse(acc.hasLiveProposal(arbiter), unicode"владелец снял чужое предложение");
    }

    /// Претензия одна, а не очередь претензий — запись ЗАМЕЩАЕТСЯ, не копится.
    ///
    /// ⚠️ Сцена называлась test_SecondProposalOverwritesFirst и клала второе
    /// предложение прямо поверх первого (задача 10, 17 августа 2026). Ровно эту
    /// перезапись правка и запретила: она бесшумно сбрасывала 48-часовые часы.
    /// Смысл сцены («одна претензия, не очередь») правкой не отменён — отменён
    /// способ её сменить, и теперь он проходит через отзыв, попадающий в ленту.
    function test_ChangingTheAccusationRunsThroughAWithdrawal() public {
        _setChief(chief);
        vm.startPrank(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("first"), unicode"выложил переписку по спору третьей стороне");
        acc.withdrawProposal(arbiter);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Other, keccak256("second"), unicode"разбор целиком под приложенным отпечатком");
        vm.stopPrank();

        (uint8 c, bytes32 dg, , , ) = acc.getRemovalProposal(arbiter);
        assertEq(c, uint8(ArbiterAccountabilityFacet.Cause.Other));
        assertEq(dg, keccak256("second"));
    }

    // ── Живое предложение занимает дверь (задача 10, 17 августа 2026) ──
    //
    // Круг правок 1 отнял у директора власть «снос остановить и завести
    // заново, сколько угодно раз» на withdrawProposal. Перезапись возвращала её
    // через соседнюю дверь одной транзакцией и не оставляла в ленте НИЧЕГО.

    function test_ChiefCannotOverwriteOwnersLiveProposal() public {
        _setChief(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Other, DIGEST, "owner's case");

        (, , uint256 proposedAt, address by, ) = acc.getRemovalProposal(arbiter);
        vm.prank(chief);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArbiterAccountabilityFacet.ProposalAlreadyLive.selector, by, proposedAt
            )
        );
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, DIGEST, "mine instead");
    }

    /// Автор своего предложения — тоже нет. Сброс часов обязан быть видимым.
    function test_ProposerCannotRefreshHisOwnClockSilently() public {
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Other, DIGEST, "first");
        (, , uint256 proposedAt, , ) = acc.getRemovalProposal(arbiter);

        vm.warp(vm.getBlockTimestamp() + 47 hours);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArbiterAccountabilityFacet.ProposalAlreadyLive.selector, owner, proposedAt
            )
        );
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Other, DIGEST, "again");
    }

    /// А через отзыв — можно, и отзыв остаётся в ленте.
    function test_WithdrawThenProposeIsAllowedAndRecorded() public {
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Other, DIGEST, "first");

        vm.expectEmit(true, true, false, false);
        emit ArbiterAccountabilityFacet.RemovalProposalWithdrawn(arbiter, owner);
        acc.withdrawProposal(arbiter);

        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, DIGEST, "second");
        (uint8 cause, , , , ) = acc.getRemovalProposal(arbiter);
        assertEq(cause, uint8(ArbiterAccountabilityFacet.Cause.Collusion));
    }

    /// Протухшее не занимает дверь: гейт читает hasLiveProposal, а не proposedAt != 0.
    function test_StaleProposalDoesNotBlockANewOne() public {
        _setChief(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Other, DIGEST, "old");

        vm.warp(vm.getBlockTimestamp() + acc.getProposalTTL() + 1);
        vm.prank(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, DIGEST, "fresh");
        (, , , address by, ) = acc.getRemovalProposal(arbiter);
        assertEq(by, chief);
    }

    /// Директор больше не прикроет самого себя.
    function test_ChiefCannotShieldHimselfByOverwriting() public {
        // посадить директора арбитром, чтобы против него можно было предложить снос
        _setChief(chief);
        _seatChiefAsArbiter();

        acc.proposeRemoval(chief, ArbiterAccountabilityFacet.Cause.Collusion, DIGEST, "against the chief");
        (, , uint256 proposedAt, , ) = acc.getRemovalProposal(chief);

        vm.prank(chief);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArbiterAccountabilityFacet.ProposalAlreadyLive.selector, owner, proposedAt
            )
        );
        acc.proposeRemoval(chief, ArbiterAccountabilityFacet.Cause.Other, DIGEST, "nothing to see");
    }

    // ── Порядок гейта: «дверь занята» — не для посторонних ──
    //
    // Круг правок 1 ревью задачи 10 (18 августа 2026): свойство «посторонний
    // упирается в роль РАНЬШЕ, чем узнаёт про чужое обвинение» было верным и
    // не сторожилось ничем — ревьюер перенёс гейт выше проверки роли и получил
    // 0 красных из 894. Сегодня оно держалось на порядке строк.
    //
    // Почему это не педантизм: ProposalAlreadyLive(by, proposedAt) — не «нет»,
    // а СВЕДЕНИЕ. Оно сообщает постороннему, что против конкретного арбитра
    // висит обвинение, и кто его подал, — до того как спрашивающий вообще имел
    // право спрашивать. Роль обязана отказывать первой.

    function test_StrangerLearnsNothingAboutALiveProposal() public {
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Other, DIGEST, "owner's case");

        address stranger = address(0xF00D);
        vm.prank(stranger);
        vm.expectRevert(ArbiterAccountabilityFacet.NotOwnerOrChief.selector);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, DIGEST, "prying");
    }

    /// Та же проверка на ВТОРОЙ двери ролей — после передачи права. Там роль
    /// сторожит не _requireOwnerOrChief, а отдельная ветка RemovalHandedOver,
    /// и перенос гейта наверх обошёл бы обе разом.
    function test_StrangerLearnsNothingAboutALiveProposalAfterHandover() public {
        address dao = address(0xDA0);
        _setDaoAddress(dao);
        _activateDAO();

        vm.prank(dao);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Other, DIGEST, "the successor's case");

        // Прежний владелец здесь — тоже посторонний, и это самая ценная
        // половина: право уехало, и вместе с ним уехало право узнавать.
        vm.expectRevert(ArbiterAccountabilityFacet.RemovalHandedOver.selector);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, DIGEST, "prying");
    }

    /// Успешный снос очищает предложение — иначе оно пережило бы уже снятого
    /// арбитра и висело бы против него бессмысленным обвинением.
    ///
    /// ⚠️ Both doors now carry the SAME cause (design of 17 August 2026,
    /// decision 4). This scene used to propose `Leak` and execute
    /// `OverturnedVerdicts`; that pair is refused outright now, and the scene
    /// where the codes diverge is test_RemovalUnderADifferentCauseIsRefused.
    function test_RemovalClearsTheProposal() public {
        _setChief(chief);
        vm.prank(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"), unicode"выложил переписку по спору третьей стороне");
        assertTrue(acc.hasLiveProposal(arbiter), unicode"сетап: предложение живо");

        vm.warp(vm.getBlockTimestamp() + acc.getRemovalDelay());
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("dump"), address(0),
            unicode"выложил переписку по спору третьей стороне"
        );

        assertFalse(acc.hasLiveProposal(arbiter), unicode"снос обязан стереть предложение");
    }

    /// Предложение на несуществующего арбитра не кладётся — та же проверка,
    /// что и у самого сноса.
    function test_ProposeRevertsIfNotAnArbiter() public {
        address stranger = address(0xF00D);
        vm.expectRevert(ArbiterAccountabilityFacet.NotAnArbiter.selector);
        acc.proposeRemoval(stranger, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
    }

    /// Minor 5, круг правок 1: ветка ArbiterZeroAddress была объявлена, но ни
    /// один тест её не проверял — снять строку и ни один тест не покраснел бы,
    /// потому что следующая же строка ревертит NotAnArbiter (тот же класс, что
    /// уже ловили в задаче 4 у suspendArbiter, см. test_SuspendZeroAddressReverts
    /// в test/ArbiterSuspension.t.sol).
    function test_ProposeRevertsOnZeroAddress() public {
        vm.expectRevert(ArbiterAccountabilityFacet.ArbiterZeroAddress.selector);
        acc.proposeRemoval(address(0), ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"), unicode"выложил переписку по спору третьей стороне");
    }

    // ============================================================
    //  КРУГ ПРАВОК 1 РЕВЬЮ ЗАДАЧИ 7 (15 августа 2026)
    // ============================================================

    /// Minor 3: withdrawProposal на человека, на которого никто ничего не
    /// клал, не должен оставлять в ленте RemovalProposalWithdrawn — такой лог
    /// читался бы как «против него что-то было и это отозвали», а лента и
    /// есть весь смысл этой работы.
    function test_WithdrawProposalOnStrangerEmitsNothing() public {
        vm.recordLogs();
        acc.withdrawProposal(arbiter); // никто ничего не предлагал
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0, unicode"withdraw без предложения не обязан эмитить ничего");
    }

    /// Симметричная позитивная половина Minor 3: реальное предложение реально
    /// отзывается событием — правка не превратила withdraw в вечно немой.
    function test_WithdrawProposalOnExistingEmitsEvent() public {
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"), unicode"выложил переписку по спору третьей стороне");

        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.RemovalProposalWithdrawn(arbiter, owner);
        acc.withdrawProposal(arbiter);
    }

    /// Minor 4: снос эмитит RemovalProposalConsumed с полями СТЁРТОЙ записи —
    /// они видны в одной транзакции, оба события лежат в одном логе.
    ///
    /// ⚠️ THE SCENE CHANGED ON 17 AUGUST 2026. It used to propose `Leak` and
    /// remove for `OverturnedVerdicts`, so the log showed "proposed for X,
    /// removed for Y". That pair is now refused outright
    /// (CauseDiffersFromProposal): a pause is worth nothing if the warning
    /// names one thing and the execution another. What the event still shows in
    /// one transaction, and what this test still checks, is the rest of the
    /// divergence — the CHIEF proposed, the OWNER executed, and the digest in
    /// the consumed record is the proposer's, not the one the owner passed.
    function test_RemovalConsumesTheProposal() public {
        _setChief(chief);
        bytes32 proposedDigest = keccak256(unicode"докладная");
        vm.prank(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, proposedDigest, unicode"выложил переписку по спору третьей стороне");
        (, , uint256 proposedAt, , ) = acc.getRemovalProposal(arbiter);

        vm.warp(vm.getBlockTimestamp() + acc.getRemovalDelay());

        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.RemovalProposalConsumed(
            arbiter, ArbiterAccountabilityFacet.Cause.Leak, chief, proposedDigest, proposedAt
        );
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("what the owner actually found"),
            address(0), unicode"выложил переписку по спору третьей стороне"
        );
    }

    // ⚠️ test_RemovalWithoutProposalEmitsOnlyTheRemovalEvent DELETED HERE
    // (17 August 2026). It played "a removal with no preceding proposal", and
    // that scene no longer exists: removeArbiterForCause reverts NoLiveProposal
    // before it can emit anything. Kept, it would have become a test standing
    // guard over a state the contract cannot reach — exactly the dead lock this
    // project keeps finding. The negative half of Minor 4 it used to guard is
    // gone with the scene, not silently dropped: see the note on the `if
    // (consumedProposal.proposedAt != 0)` branch in the facet.

    /// Улучшение: пятое поле `live` в getRemovalProposal согласовано с
    /// hasLiveProposal на протухшей записи, не только на свежей (свежую уже
    /// проверяет test_ChiefProposes).
    function test_GetRemovalProposalLiveFieldFalseAfterExpiry() public {
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"), unicode"выложил переписку по спору третьей стороне");
        vm.warp(vm.getBlockTimestamp() + 14 days);

        (, , , , bool live) = acc.getRemovalProposal(arbiter);
        assertFalse(live, unicode"протухшая запись — live обязано быть false");
        assertFalse(acc.hasLiveProposal(arbiter), unicode"согласовано с hasLiveProposal");
    }

    /// Круг правок 2, шов: `proposedAt == 0` (ни разу не предлагали, а не
    /// "предлагали и протухло") — единственный случай, где формула-копия и
    /// вызов `hasLiveProposal` реально способны разойтись (протухшую запись
    /// с настоящим `proposedAt` обе формы читают одинаково: сравнение с TTL
    /// само даёт false). Тест ставит именно эту границу.
    function test_GetRemovalProposalLiveFieldFalseForNeverProposed() public {
        (, , , , bool live) = acc.getRemovalProposal(arbiter);
        assertFalse(live, unicode"на арбитра ни разу не предлагали — live обязано быть false");
    }

    // ============================================================
    //  ПРАВО ОТВЕТА (задача 8, 15 августа 2026)
    //
    //  Обвинение против настоящего адреса лежит в цепи вечно. Ответ ничего не
    //  отменяет и ничего не возвращает — он существует, чтобы читатель цепи
    //  видел ДВЕ записи вместо одной.
    //
    //  ⚠️ Единственная функция этого фасета, которая читает _msgSender(): её
    //  зовёт обычный человек, у которого может не быть ETH. Через релеер
    //  msg.sender это адрес форвардера, и ответ записался бы форвардеру.
    // ============================================================

    function test_RemovedArbiterAnswers() public {
        _setStreak(arbiter, 2);
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), "");

        bytes32 reply = keccak256(unicode"вот переписка целиком, судите сами");

        vm.expectEmit(true, false, false, true, address(acc));
        emit ArbiterAccountabilityFacet.RemovalAnswered(arbiter, reply);

        vm.prank(arbiter);
        acc.respondToRemoval(reply, "");

        assertEq(acc.getRemovalReply(arbiter), reply, unicode"ответ лёг в цепь");
    }

    function test_AnswerIsOnceOnly() public {
        _setStreak(arbiter, 2);
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), "");

        vm.startPrank(arbiter);
        acc.respondToRemoval(keccak256("first"), "");
        vm.expectRevert(ArbiterAccountabilityFacet.AlreadyAnswered.selector);
        acc.respondToRemoval(keccak256("second"), "");
        vm.stopPrank();
    }

    function test_ZeroReplyIsRefused() public {
        _setStreak(arbiter, 2);
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), "");
        vm.prank(arbiter);
        vm.expectRevert(ArbiterAccountabilityFacet.ZeroDigest.selector);
        acc.respondToRemoval(bytes32(0), "");
    }

    /// Отвечать может только тот, кого сняли. Иначе посторонний засыпал бы
    /// ленту чужими «ответами».
    function test_OnlyRemovedCanAnswer() public {
        vm.prank(address(0x5A));
        vm.expectRevert(ArbiterAccountabilityFacet.NothingToAnswer.selector);
        acc.respondToRemoval(keccak256("x"), "");
    }

    // ============================================================
    //  ФИНАЛЬНЫЙ ОБЗОР ВЕТКИ, I-5 (16 августа 2026)
    //
    //  ЧЕТВЁРТОЕ НЕПРОВЕРЯЕМОЕ МЕСТО: значения перечисления поводов.
    //
    //  `Cause` хранится числом (uint8 в RemovalProposal), летит indexed-топиком
    //  в трёх событиях (ArbiterRemovedForCause, RemovalProposed,
    //  RemovalProposalConsumed) и отдаётся наружу как uint8 из
    //  getRemovalProposal. Сверки самих ЧИСЕЛ не было ни одной: оба места,
    //  которые выглядели проверкой — `assertEq(c, uint8(Cause.Leak))` в
    //  test_ChiefProposalIsReadable и `assertEq(c, uint8(Cause.Other))` в
    //  test_SecondProposalOverwritesTheFirst — сравнивают перечисление с самим
    //  собой и переживают ЛЮБУЮ перестановку членов.
    //
    //  Цена перестановки или вставки члена в середину: все уже лежащие в цепи
    //  предложения молча меняют смысл, и все прошлые логи обвинений тоже —
    //  «снят за слив переписки» превращается в «снят за сговор» задним числом.
    //  Это вечная публичная запись против настоящего адреса, отозвать её
    //  нельзя.
    // ============================================================

    /// Литералы прибиты. Дописывать новые коды можно только В КОНЕЦ — как поля
    /// в Diamond Storage, и ровно по той же причине.
    function test_CauseCodesArePinnedToTheirNumbers() public {
        assertEq(uint8(ArbiterAccountabilityFacet.Cause.OverturnedVerdicts), 0, "OverturnedVerdicts");
        assertEq(uint8(ArbiterAccountabilityFacet.Cause.Timeouts),           1, "Timeouts");
        assertEq(uint8(ArbiterAccountabilityFacet.Cause.Silence),            2, "Silence");
        assertEq(uint8(ArbiterAccountabilityFacet.Cause.Collusion),          3, "Collusion");
        assertEq(uint8(ArbiterAccountabilityFacet.Cause.Leak),               4, "Leak");
        assertEq(uint8(ArbiterAccountabilityFacet.Cause.Other),              5, "Other");
    }

    /// Вторая половина того же замка: граница «проверяется цепью / заверяется
    /// отпечатком» проходит между кодами 2 и 3, и это не косметика —
    /// _isChainVerifiable перечисляет первые три поимённо. Перестановка,
    /// уронившая первый тест, обязана уронить и этот, если она переносит член
    /// через границу; проверяется БОЕВЫМ путём (флаг verifiedByChain в
    /// событии), а не повторным чтением того же перечисления.
    function test_ChainVerifiableBorderSitsBetweenSilenceAndCollusion() public {
        _setStreak(arbiter, 2);
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Timeouts, bytes32(0), "");
        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.ArbiterRemovedForCause(
            arbiter, owner, ArbiterAccountabilityFacet.Cause.Timeouts, true, bytes32(0), 0
        );
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Timeouts, bytes32(0), address(0), "");

        address second = address(0xA2);
        vm.store(address(acc), keccak256(abi.encode(second, uint256(ARB_BASE))), bytes32(uint256(1)));
        _proposeAndWait(second, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("the proposal's own evidence"), PROPOSAL_WORDS);
        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.ArbiterRemovedForCause(
            second, owner, ArbiterAccountabilityFacet.Cause.Collusion, false, keccak256("e"), 0
        );
        acc.removeArbiterForCause(second, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("e"), address(0), unicode"трижды забирал споры одного контрагента и трижды решал в его пользу");
    }

    // ============================================================
    //  ПРИЧИНА СЛОВАМИ (замысел 17 августа 2026, решение 7)
    //
    //  Обязательна ровно там, где цепь молчит, — и на ОБЕИХ дверях, не только
    //  на сносе: пауза задачи 2 даёт обвиняемому время ответить, и отвечать он
    //  должен на обвинение, а не на числовой код.
    //
    //  Живут слова в СОБЫТИИ, не в хранилище: их читатель — лента и карточка,
    //  а хранилище стоило бы дороже и двигало бы раскладку зря.
    // ============================================================

    /// Заверяемый код без слов не проходит. До правки проходил: хватало
    /// ненулевого отпечатка, под которым может лежать что угодно.
    function test_UnverifiableCauseRequiresWords() public {
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), PROPOSAL_WORDS);
        vm.expectRevert(ArbiterAccountabilityFacet.ReasonRequired.selector);
        acc.removeArbiterForCause(
            arbiter,
            ArbiterAccountabilityFacet.Cause.Collusion,
            keccak256("evidence"),
            address(0),
            ""
        );
    }

    /// Проверяемый код словами не обязан объясняться: «три перевёрнутых
    /// вердикта» само себя объясняет, и требовать поверх этого текст значило бы
    /// заводить поле, которое заполняют точкой.
    function test_VerifiableCauseNeedsNoWords() public {
        _setStreak(arbiter, 2);
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        acc.removeArbiterForCause(
            arbiter,
            ArbiterAccountabilityFacet.Cause.OverturnedVerdicts,
            bytes32(0),
            address(0),
            ""
        );
        assertFalse(_isArbiterRaw(arbiter), unicode"проверяемый код прошёл без слов");
    }

    /// Слова уезжают отдельным событием — старое НЕ переопределяется, потому
    /// что его уже читает лента.
    function test_WordsRideTheirOwnEvent() public {
        string memory why = unicode"трижды забирал споры одного контрагента и трижды решал в его пользу";

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("dump"), PROPOSAL_WORDS);
        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.RemovalReasonGiven(arbiter, owner, 1, why);

        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("dump"), address(0), why
        );
    }

    /// Потолок считается в БАЙТАХ. 513 байт — уже нет.
    function test_ReasonOverTheCapIsRefused() public {
        bytes memory tooLong = new bytes(513);
        for (uint256 i = 0; i < 513; i++) tooLong[i] = "x";

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Other, keccak256("e"), PROPOSAL_WORDS);
        vm.expectRevert(
            abi.encodeWithSelector(ArbiterAccountabilityFacet.ReasonTooLong.selector, uint256(513))
        );
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Other, keccak256("e"), address(0), string(tooLong)
        );
    }

    /// Ровно потолок — проходит. Граница строгая с одной стороны, как у всех
    /// границ этого проекта.
    function test_ReasonExactlyAtTheCapPasses() public {
        bytes memory atCap = new bytes(acc.getMaxReasonBytes());
        for (uint256 i = 0; i < atCap.length; i++) atCap[i] = "x";

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Other, keccak256("e"), PROPOSAL_WORDS);
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Other, keccak256("e"), address(0), string(atCap)
        );
        assertFalse(_isArbiterRaw(arbiter), unicode"512 байт — законная длина");
    }

    /// Предложение подчиняется тому же правилу. Без этого пауза давала бы
    /// обвиняемому код повода и ничего больше.
    function test_ProposalWithUnverifiableCauseRequiresWords() public {
        _setChief(chief);
        vm.prank(chief);
        vm.expectRevert(ArbiterAccountabilityFacet.ReasonRequired.selector);
        acc.proposeRemoval(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), ""
        );
    }

    /// Слова предложения тоже уезжают своим событием — и это единственная
    /// проверка, которая на них смотрит. Замерено ревью (круг правок 2):
    /// удалить из `proposeRemoval` весь блок `emit RemovalReasonGiven` — **0
    /// красных из 872**; подменить стадию 0 на 7 — снова **0**. Гейт сабграфа
    /// и фронтовый ABI-тест сверяют ОБЪЯВЛЕНИЕ события, а не отправку, гейт
    /// гейслесса смотрит на отправителя — сторона сноса разыграна, сторона
    /// ответа разыграна, сторона предложения не была разыграна ничем.
    ///
    /// Почему это важнее, чем выглядит: задача 2 строит паузу поверх этого
    /// обещания. Обвиняемый узнаёт слова обвинения ТОЛЬКО отсюда, а `stage`
    /// — признак, которым лента отделит предложение от сноса. Пропади событие
    /// молча, и пауза станет сорока восемью часами молчания.
    ///
    /// ⚠️ Стадия сверяется ЛИТЕРАЛОМ 0, а не константой фасета: спросив
    /// значение у той же цепи, тест смотрелся бы в зеркало и был бы доволен
    /// любой подменой (тот же дефект, что у test_ReasonExactlyAtTheCapPasses).
    function test_ProposalWordsRideTheirOwnEventAtStageZero() public {
        _setChief(chief);
        string memory why = unicode"забрал три спора одного клиента подряд, ни одного чужого";

        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.RemovalReasonGiven(arbiter, chief, 0, why);

        vm.prank(chief);
        acc.proposeRemoval(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), why
        );

        assertTrue(acc.hasLiveProposal(arbiter), unicode"предложение обязано лежать в цепи");
    }

    /// У обвиняемого это ПРАВО, а не обязанность: ответ без слов принимается.
    /// Заставлять человека оправдываться публично нельзя.
    function test_ReplyWordsAreOptional() public {
        _setStreak(arbiter, 2);
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), ""
        );

        vm.prank(arbiter);
        acc.respondToRemoval(keccak256("full log attached"), "");

        assertEq(
            acc.getRemovalReply(arbiter),
            keccak256("full log attached"),
            unicode"ответ без слов принят"
        );
    }

    /// Но если слова есть — они публичны, своим событием.
    function test_ReplyWordsRideTheirOwnEvent() public {
        _setStreak(arbiter, 2);
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), ""
        );

        string memory said = unicode"оба вердикта перевернули по апелляции, третьего не было";

        vm.expectEmit(true, false, false, true, address(acc));
        emit ArbiterAccountabilityFacet.RemovalReplyGiven(arbiter, said);

        vm.prank(arbiter);
        acc.respondToRemoval(keccak256("x"), said);
    }

    /// Потолок один на обе стороны: ответ длиннее 512 байт тоже отвергается.
    /// Разная длина у обвинения и защиты была бы перекосом ровно там, где вся
    /// работа про симметрию.
    function test_ReplyOverTheCapIsRefused() public {
        _setStreak(arbiter, 2);
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), ""
        );

        bytes memory tooLong = new bytes(513);
        for (uint256 i = 0; i < 513; i++) tooLong[i] = "y";

        vm.prank(arbiter);
        vm.expectRevert(
            abi.encodeWithSelector(ArbiterAccountabilityFacet.ReasonTooLong.selector, uint256(513))
        );
        acc.respondToRemoval(keccak256("x"), string(tooLong));
    }

    /// Пустых событий не бывает. Молчание — сигнал (решение 9 замысла), и
    /// пустая строка в ленте стирала бы разницу между «объяснил» и «промолчал».
    function test_NoWordsMeansNoWordsEvent() public {
        _setStreak(arbiter, 2);
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        vm.recordLogs();
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), ""
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(
                logs[i].topics[0] != ArbiterAccountabilityFacet.RemovalReasonGiven.selector,
                unicode"пустых слов в ленте быть не должно"
            );
        }
    }

    // ────────────────────────────────────────────────────────────
    //  БАЙТ, А НЕ СИМВОЛ — И ЭТО ВИДНО ТОЛЬКО НА МНОГОБАЙТНОЙ БУКВЕ
    //
    //  Три проверки выше меряют потолок латинским «x», а у него байт и
    //  символ — одно и то же. Значит на них правило «считаем символы»
    //  неотличимо от правила «считаем байты»: обе редакции зелёные. Тот
    //  самый класс, ради которого потолок и назван в БАЙТАХ.
    //
    //  Здесь стоит кириллица: 257 букв — это 257 символов и 514 байт.
    //  Счётом по символам такая строка проходит (257 < 512), счётом по
    //  байтам отвергается. Ровно эту развилку разыгрывают два теста ниже,
    //  и больше её не разыгрывает никто.
    //
    //  ⚠️ Ожидаемое здесь — ЛИТЕРАЛЫ 512 и 514, а не getMaxReasonBytes():
    //  спросив потолок у той же цепи, стенд сверял бы её с самой собой и
    //  пережил бы любую смену числа молча. Соседний
    //  test_ReasonExactlyAtTheCapPasses такой потолок как раз спрашивает —
    //  он сторожит границу, но не значение.
    // ────────────────────────────────────────────────────────────

    /// Строка из `letters` кириллических «я». Байты берутся из самой буквы, а
    /// не выписаны хексом: стенд, в котором «многобайтная буква» оказалась бы
    /// однобайтной опечаткой, обязан упасть здесь, а не выдать зелёный замер.
    function _cyrillic(uint256 letters) private pure returns (string memory) {
        bytes memory ya = bytes(unicode"я");
        require(ya.length == 2, unicode"стенд врёт: «я» обязана весить два байта");
        bytes memory out = new bytes(letters * 2);
        for (uint256 i = 0; i < letters; i++) {
            out[2 * i]     = ya[0];
            out[2 * i + 1] = ya[1];
        }
        return string(out);
    }

    /// 257 кириллических букв — 514 байт, и цепь их отвергает. Счётом по
    /// символам это была бы законная строка, и обвинитель клал бы в цепь
    /// вдвое больше обещанного.
    function test_TheCapCountsBytesNotCharacters() public {
        string memory tooLong = _cyrillic(257);
        assertEq(bytes(tooLong).length, 514, unicode"стенд собран неверно: не 514 байт");

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Other, keccak256("e"), PROPOSAL_WORDS);
        vm.expectRevert(
            abi.encodeWithSelector(ArbiterAccountabilityFacet.ReasonTooLong.selector, uint256(514))
        );
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Other, keccak256("e"), address(0), tooLong
        );
    }

    /// А 256 кириллических букв — ровно 512 байт — проходят. Это и есть та
    /// «~256 символов», что обещаны человеку: в худшей кодировке, которой он
    /// тут пишет.
    function test_TwoHundredFiftySixCyrillicLettersFitExactly() public {
        string memory atCap = _cyrillic(256);
        assertEq(bytes(atCap).length, 512, unicode"стенд собран неверно: не 512 байт");

        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Other, keccak256("e"), PROPOSAL_WORDS);
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Other, keccak256("e"), address(0), atCap
        );
        assertFalse(_isArbiterRaw(arbiter), unicode"256 кириллических букв — законная длина");
    }

    /// Ответ считается той же единицей. Разойдись стороны в единице счёта —
    /// защита получила бы вдвое меньше места, чем обвинение, и заметил бы это
    /// только тот, кто пишет не по-английски.
    function test_TheReplyCapCountsBytesToo() public {
        _setStreak(arbiter, 2);
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), ""
        );

        string memory tooLong = _cyrillic(257);
        assertEq(bytes(tooLong).length, 514, unicode"стенд собран неверно: не 514 байт");

        vm.prank(arbiter);
        vm.expectRevert(
            abi.encodeWithSelector(ArbiterAccountabilityFacet.ReasonTooLong.selector, uint256(514))
        );
        acc.respondToRemoval(keccak256("x"), tooLong);
    }

    // ============================================================
    //  ФИНАЛЬНЫЙ ОБЗОР ВЕТКИ, I-2 (16 августа 2026)
    //
    //  «Директор упраздняется при ДАО» было неправдой: setChiefArbiter —
    //  ЕДИНСТВЕННЫЙ писатель слота и единственный способ его обнулить, а
    //  задача 6 закрыла её при активном ДАО. Сидящий директор оставался в
    //  слоте навсегда со всеми правами onlyOwnerOrChief. Починено в самом
    //  модификаторе — обеих его копий, по фасету на каждую.
    //
    //  Здесь — половина ArbiterAccountabilityFacet (четыре функции).
    //  Половина ArbiterRegistryFacet (addArbiter) — в
    //  test/ArbiterSeatingHandover.t.sol.
    // ============================================================

    function test_ChiefCanSuspendBeforeDao() public {
        _setChief(chief);
        vm.prank(chief);
        acc.suspendArbiter(arbiter);
        assertTrue(acc.isSuspended(arbiter), unicode"до ДАО директор работает как прежде");
    }

    function test_ChiefLosesSuspendAfterDao() public {
        _setChief(chief);
        _activateDAO();
        vm.prank(chief);
        vm.expectRevert(ArbiterAccountabilityFacet.NotOwnerOrChief.selector);
        acc.suspendArbiter(arbiter);
    }

    function test_ChiefLosesLiftSuspensionAfterDao() public {
        _setChief(chief);
        _activateDAO();
        vm.prank(chief);
        vm.expectRevert(ArbiterAccountabilityFacet.NotOwnerOrChief.selector);
        acc.liftSuspension(arbiter);
    }

    function test_ChiefLosesProposeRemovalAfterDao() public {
        _setChief(chief);
        _activateDAO();
        vm.prank(chief);
        vm.expectRevert(ArbiterAccountabilityFacet.NotOwnerOrChief.selector);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"), unicode"выложил переписку по спору третьей стороне");
    }

    /// Четвёртая дверь. Важна отдельно: без неё несменяемый директор,
    /// потерявший право КЛАСТЬ предложение, сохранял бы право СНИМАТЬ чужое —
    /// то есть гасить обвинения владельца против своих ставленников.
    function test_ChiefLosesWithdrawProposalAfterDao() public {
        _setChief(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"), unicode"выложил переписку по спору третьей стороне");
        _activateDAO();
        vm.prank(chief);
        vm.expectRevert(ArbiterAccountabilityFacet.NotOwnerOrChief.selector);
        acc.withdrawProposal(arbiter);
    }

    /// Заработанный порог обязан упразднять директора ТАК ЖЕ, как ручной флаг:
    /// модификатор читает _isDaoActive (полное выражение), а не daoActiveManual.
    /// Без этой половины владелец, никогда не звавший activateDAO(), жил бы с
    /// действующим директором и после того, как ДАО включилась сама.
    function test_ChiefLosesPowerOnEarnedDaoToo() public {
        _setChief(chief);
        _setUniqueActiveUsers(acc.getDaoThresholdMirror());
        vm.prank(chief);
        vm.expectRevert(ArbiterAccountabilityFacet.NotOwnerOrChief.selector);
        acc.suspendArbiter(arbiter);
    }

    /// Контроль, что модификатор закрылся не для всех: приостановка обратима и
    /// протухает сама, владелец её не теряет и после передачи сноса.
    function test_OwnerKeepsSuspendAfterDao() public {
        _setChief(chief);
        _activateDAO();
        acc.suspendArbiter(arbiter);
        assertTrue(acc.isSuspended(arbiter), unicode"владелец не теряет приостановку никогда");
    }

    // ============================================================
    //  ФИНАЛЬНЫЙ ОБЗОР ВЕТКИ, C-1 (16 августа 2026)
    //
    //  Снос ВЫСТАВЛЯЕТ приостановку: без неё сильная мера была слабее слабой
    //  (submitVerdict гейтится клеймом, а не статусом, и suspendArbiter на
    //  снятом уже ревертит NotAnArbiter). Здесь — только сама отметка; то, что
    //  она реально держит финализацию, доказывается связкой трёх задач на
    //  настоящем даймонде в test/ArbiterRemovalForCauseIntegration.t.sol.
    // ============================================================

    function test_RemovalForCauseSuspendsTheRemoved() public {
        _setStreak(arbiter, 2);
        assertEq(acc.getSuspendedUntil(arbiter), 0, unicode"сетап: приостановки не было");

        // ⚠️ t0 is read AFTER the pause, not before it. Since 17 August 2026 a
        // removal is two transactions two days apart, and the suspension window
        // is counted from the second one; reading t0 at the top of the body
        // would put the expectation 48 hours in the past.
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        uint256 t0 = vm.getBlockTimestamp();

        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), "");

        assertEq(
            acc.getSuspendedUntil(arbiter), t0 + acc.getSuspensionWindow(),
            unicode"снос обязан подразумевать приостановку — окно то же, что у suspendArbiter"
        );
        assertTrue(acc.isSuspended(arbiter), unicode"снятый приостановлен прямо сейчас");
    }

    /// Приостановка от сноса протухает сама, как всякая другая: снятый
    /// навсегда остаётся снятым, но вечно морозить чужие деньги ценой одного
    /// сноса — новое оружие, а не защита.
    function test_RemovalSuspensionExpiresByItself() public {
        _setStreak(arbiter, 2);
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), "");

        vm.warp(vm.getBlockTimestamp() + acc.getSuspensionWindow());
        assertFalse(acc.isSuspended(arbiter), unicode"на границе окна отпустило");
    }

    // ============================================================
    //  THE 48-HOUR PAUSE (design of 17 August 2026, decisions 1-4)
    //
    //  Removal stopped being a single button. It is now two transactions two
    //  days apart, and between them the person has time to see the accusation
    //  and answer it on chain.
    //
    //  There is no fast path, deliberately: "stop right now" is covered by
    //  suspension — instant, reversible, expiring by itself.
    // ============================================================

    /// Without a proposal there is no removal at all. Before this change it
    /// went through in one transaction and the person learned of it afterwards.
    function test_RemovalWithoutProposalIsRefused() public {
        _setStreak(arbiter, 2);
        vm.expectRevert(ArbiterAccountabilityFacet.NoLiveProposal.selector);
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), ""
        );
    }

    /// The proposal is there but the clock is still running. The error carries
    /// THE MOMENT from which it is allowed: the form can say "19 hours to go"
    /// instead of "try later".
    function test_RemovalBeforeTheDelayIsRefused() public {
        _setStreak(arbiter, 2);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        uint256 proposedAt = vm.getBlockTimestamp();

        vm.warp(proposedAt + acc.getRemovalDelay() - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArbiterAccountabilityFacet.RemovalTooEarly.selector,
                proposedAt + acc.getRemovalDelay()
            )
        );
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), ""
        );
    }

    /// One second later it goes through — the same scene, the same setup, the
    /// boundary crossed. The pair is the point: a stand that only played "a lot
    /// of time has passed" could not tell 48 hours from 47, or from any
    /// positive number at all.
    function test_RemovalAtTheExactBoundaryPasses() public {
        _setStreak(arbiter, 2);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        vm.warp(vm.getBlockTimestamp() + acc.getRemovalDelay());

        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), ""
        );
        assertFalse(_isArbiterRaw(arbiter), "48 hours are up, the removal is allowed");
    }

    /// A stale proposal is not executed. Otherwise an accusation half a year
    /// old would fire without a fresh warning.
    function test_RemovalOnStaleProposalIsRefused() public {
        _setStreak(arbiter, 2);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        uint256 proposedAt = vm.getBlockTimestamp();

        vm.warp(proposedAt + acc.getProposalTTL());
        vm.expectRevert(
            abi.encodeWithSelector(ArbiterAccountabilityFacet.ProposalStale.selector, proposedAt)
        );
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), ""
        );
    }

    /// The last second of the proposal's life still works. The same strictness
    /// as hasLiveProposal: they must not diverge, or the button goes dark a day
    /// before the feed stops showing the accusation as live.
    function test_RemovalOnTheLastSecondOfTheProposalPasses() public {
        _setStreak(arbiter, 2);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        vm.warp(vm.getBlockTimestamp() + acc.getProposalTTL() - 1);

        assertTrue(acc.hasLiveProposal(arbiter), "stand: the proposal is still live");
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), ""
        );
        assertFalse(_isArbiterRaw(arbiter), "a live proposal executes down to its last second");
    }

    /// Warned about one thing, removed for another. Refused: the pause is given
    /// so the person answers THAT PARTICULAR accusation.
    function test_RemovalUnderADifferentCauseIsRefused() public {
        _setStreak(arbiter, 2);
        _proposeAndWait(arbiter, ArbiterAccountabilityFacet.Cause.Timeouts, bytes32(0), "");

        vm.expectRevert(
            abi.encodeWithSelector(
                ArbiterAccountabilityFacet.CauseDiffersFromProposal.selector,
                uint8(ArbiterAccountabilityFacet.Cause.Timeouts),
                uint8(ArbiterAccountabilityFacet.Cause.OverturnedVerdicts)
            )
        );
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), ""
        );
    }

    /// The digest and the dispute reference are still the accuser's OWN, not
    /// taken from the proposal. Exactly one field is compared — the cause code,
    /// the thing the person was warned about — and not the whole application.
    function test_EvidenceIsPassedAfreshNotTakenFromTheProposal() public {
        _proposeAndWait(
            arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("first guess"), PROPOSAL_WORDS
        );

        bytes32 realEvidence = keccak256("what the owner actually found");
        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.ArbiterRemovedForCause(
            arbiter, owner, ArbiterAccountabilityFacet.Cause.Leak, false, realEvidence, 0
        );
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Leak, realEvidence, address(0), PROPOSAL_WORDS
        );
    }

    /// A withdrawal kills the clock along with the proposal: the hours do not
    /// "keep running", they are gone. Checked down the live road, not by
    /// reading a field.
    function test_WithdrawalKillsTheClock() public {
        _setStreak(arbiter, 2);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        acc.withdrawProposal(arbiter);
        vm.warp(vm.getBlockTimestamp() + acc.getRemovalDelay());

        vm.expectRevert(ArbiterAccountabilityFacet.NoLiveProposal.selector);
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), ""
        );
    }

    /// The execution window is not empty. This looks like a tautology and is
    /// not one: let these two numbers cross in a future edit and removal would
    /// become impossible AT ALL, under any schedule, while no scenario test
    /// would show it — they would all fail one by one, each with its own
    /// plausible-looking error.
    function test_RemovalWindowIsNotEmpty() public view {
        assertLt(
            acc.getRemovalDelay(),
            acc.getProposalTTL(),
            "the pause must be shorter than the proposal's own lifetime"
        );
    }

    /// The number of the pause is pinned. Proportionality to its neighbours is
    /// not decoration: 48 hours sit between the finalisation window (24) and
    /// suspension (72), and a silent shift would break the reasoning without
    /// breaking a single scenario.
    ///
    /// ⚠️ The expectation is a LITERAL, not acc.getRemovalDelay() read twice:
    /// asking the same chain for the number would make the stand look into a
    /// mirror and be happy with any substitution. The boundary tests above ask
    /// the chain on purpose — they guard the boundary, this one guards the
    /// value.
    function test_RemovalDelayIsFortyEightHours() public view {
        assertEq(acc.getRemovalDelay(), 48 hours, "the pause is 48 hours");
    }


    bytes32 constant FWD_TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data)"
    );

    /// Гейслесс-путь ЭТОЙ копии _msgSender() целиком: подпись, форвардер,
    /// релеер третьим адресом.
    ///
    /// ⚠️ ПЕРЕИМЕНОВАН правкой C (16 августа 2026). Звался
    /// `test_MsgSenderMatchesRegistry` — имя обещало сверку двух копий, которой
    /// тест не делает и никогда не делал; его же докстринг ниже это опровергал.
    /// Имя приведено к тому, что тест проверяет на самом деле.
    ///
    /// ⚠️ Финальный обзор ветки, M-3 (16 августа 2026): этот тест НЕ сверяет
    /// две копии между собой, хотя его прежнее имя и прежний докстринг это
    /// обещали —
    /// он гоняет только respondToRemoval, и правка в оригинале
    /// (ArbiterRegistryFacet._msgSender) не покраснела бы здесь ничем. Его
    /// настоящая ценность в другом и она не пропадает: он сверяет ответ с
    /// ВНЕШНЕЙ правдой — с адресом подписанта vm.addr(arbiterPk), — а значит
    /// ловит одинаковую порчу, внесённую в ОБА тела сразу, чего не может ни
    /// один дифференциал. Настоящая сверка пары живёт в
    /// test/ArbiterRemovalForCauseIntegration.t.sol::
    /// test_MsgSenderAgreesAcrossBothFacetsOnOneForwarder.
    ///
    /// ⚠️ Круг правок 1 ревью задачи 8, Minor 3: прежняя версия пранкалась
    /// адресом форвардера и вручную клеила хвост calldata (`abi.encodePacked`),
    /// минуя `MinimalForwarder.execute()` и проверку подписи целиком — это
    /// доказывало «функция правильно достаёт адрес из хвоста calldata», а не
    /// «гейслесс-путь работает целиком: подпись, проверка, релеер». Переписан
    /// по золотому образцу — `testFundDisputeThroughForwarderIsPaidByTheHuman`
    /// (на который ссылается шапка check_gasless_sender.py) и
    /// `test/DisputeNoResponse.t.sol::test_RecordNoResponse_ThroughRealForwarder_CreditsHumanNotForwarder`:
    /// настоящий EIP-712-запрос, настоящая подпись, настоящий `fwd.execute()`
    /// от третьего адреса (не арбитр, не форвардер) — как это реально делает
    /// релеер.
    function test_RespondToRemovalThroughForwarderCreditsHuman() public {
        uint256 arbiterPk = 0xCA11;
        address arb = vm.addr(arbiterPk);
        address relayer = address(0x9999); // третий адрес: не арбитр, не форвардер

        // Свежий арбитр под этим адресом — setUp сажает только фиксированный
        // `arbiter` (0xA1), у которого нет известного приватного ключа.
        vm.store(address(acc), keccak256(abi.encode(arb, uint256(ARB_BASE))), bytes32(uint256(1)));

        MinimalForwarder fwd = new MinimalForwarder();
        _setForwarder(address(acc), address(fwd));

        _setStreak(arb, 2);
        _proposeAndWait(arb, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), "");
        acc.removeArbiterForCause(arb, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0), "");

        MinimalForwarder.ForwardRequest memory req = MinimalForwarder.ForwardRequest({
            from:  arb,
            to:    address(acc),
            value: 0,
            gas:   500_000,
            nonce: fwd.getNonce(arb),
            // ⚠️ Селектор берётся ОТ ТИПА, поэтому смену подписи (17 августа
            // 2026, слова ответа) компилятор подхватывает сам; аргументов
            // теперь два. Собранная руками старая калдата дала бы «function
            // not found» — красный по чужой причине.
            data:  abi.encodeWithSelector(acc.respondToRemoval.selector, keccak256("x"), "")
        });

        vm.prank(relayer);
        (bool ok, bytes memory ret) = fwd.execute(req, _signFwd(fwd, arbiterPk, req));
        assertTrue(ok, string.concat("forwarded respondToRemoval failed: ", vm.toString(ret)));

        assertEq(acc.getRemovalReply(arb), keccak256("x"),
            unicode"ответ обязан записаться ЧЕЛОВЕКУ, а не форвардеру");
    }

    // ---------- ХЕЛПЕРЫ ----------

    function _isArbiterRaw(address who) internal view returns (bool) {
        return vm.load(address(acc), keccak256(abi.encode(who, uint256(ARB_BASE)))) != bytes32(0);
    }

    /// Removal only runs through a proposal that has sat. The helper lays one
    /// down and winds time exactly to the far side of the pause.
    ///
    /// ⚠️ vm.getBlockTimestamp(), not block.timestamp: under via_ir solc treats
    /// TIMESTAMP as constant within a call, and a second warp in the same body
    /// would jump to the same second as the first (docs/OPEN-ITEMS.md, item 57).
    ///
    /// ⚠️ The cause given here must be the cause given to the removal — since
    /// 17 August 2026 the two are compared (CauseDiffersFromProposal).
    function _proposeAndWait(
        address who,
        ArbiterAccountabilityFacet.Cause cause,
        bytes32 digest,
        string memory reason
    ) internal {
        acc.proposeRemoval(who, cause, digest, reason);
        vm.warp(vm.getBlockTimestamp() + acc.getRemovalDelay());
    }

    /// Same, laid down by a named caller. Needed after handover: since review
    /// round 2 (17 August 2026) the accusation door travels with the right to
    /// act on it, so past handover the OWNER cannot propose and the successor
    /// must do it himself — which is the point of a handover.
    function _proposeAndWaitAs(
        address caller,
        address who,
        ArbiterAccountabilityFacet.Cause cause,
        bytes32 digest,
        string memory reason
    ) internal {
        vm.prank(caller);
        acc.proposeRemoval(who, cause, digest, reason);
        vm.warp(vm.getBlockTimestamp() + acc.getRemovalDelay());
    }

    function _setStreak(address who, uint256 n) internal {
        bytes32 base = bytes32(uint256(ARB_BASE) + SLOT_MISTAKE_STREAK);
        vm.store(address(acc), keccak256(abi.encode(who, uint256(base))), bytes32(n));
    }

    /// Посадить директора арбитром — тем же единственным способом, каким setUp
    /// сажает `arbiter`: `isArbiter[who] = true` по слоту 0 неймспейса. Нужен
    /// сценам, где обвинение кладут ПРОТИВ директора: proposeRemoval отказывает
    /// NotAnArbiter тому, кто арбитром не числится.
    function _seatChiefAsArbiter() internal {
        vm.store(address(acc), keccak256(abi.encode(chief, uint256(ARB_BASE))), bytes32(uint256(1)));
    }

    /// chiefArbiter делит слот 5 с daoActiveManual (bool, байт-смещение 20).
    /// Читаем-меняем-пишем, чтобы порядок вызова с _activateDAO не имел
    /// значения — ни один сегодняшний тест их не комбинирует, но слепая
    /// перезапись всего слота была бы тихой миной на будущее.
    function _setChief(address who) internal {
        bytes32 slot = bytes32(uint256(ARB_BASE) + 5);
        bytes32 current = vm.load(address(acc), slot);
        bytes32 daoBit = current & bytes32(uint256(1) << 160);
        vm.store(address(acc), slot, bytes32(uint256(uint160(who))) | daoBit);
    }

    /// daoActiveManual — bool, упакован в слот 5 (тот же, что chiefArbiter) на
    /// байт-смещении 20 (бит 160). Добыто перебором offset×byte, см. докстринг
    /// файла. Брифом было предложено «слот 6, отдельно» — промах: упаковка
    /// адреса и bool в общий 32-байтовый слот сдвигает всё, что после,
    /// назад на единицу относительно наивного расчёта.
    function _activateDAO() internal {
        bytes32 slot = bytes32(uint256(ARB_BASE) + 5);
        bytes32 current = vm.load(address(acc), slot);
        vm.store(address(acc), slot, current | bytes32(uint256(1) << 160));
    }

    /// daoAddress — слот 10, добыт перебором.
    function _setDaoAddress(address dao) internal {
        vm.store(address(acc), bytes32(uint256(ARB_BASE) + 10), bytes32(uint256(uint160(dao))));
    }

    /// disputeNoResponseAtBy — вложенный мэппинг сделка → арбитр → момент.
    /// Смещение сторожится тестом test_NoResponseSlotOffsetIsCorrect.
    uint256 constant SLOT_NO_RESPONSE = 23;

    function _setNoResponse(address deal, address who, uint256 at) internal {
        bytes32 outer = keccak256(abi.encode(deal, uint256(bytes32(uint256(ARB_BASE) + SLOT_NO_RESPONSE))));
        vm.store(address(acc), keccak256(abi.encode(who, uint256(outer))), bytes32(at));
    }

    /// seatedBy — слот 25, seatedCountBy — слот 26. Добыты перебором против
    /// ArbiterRegistryFacet.getSeatedBy/getSeatedCountBy (та же раскладка,
    /// другой развёрнутый контракт — позиция слота от этого не зависит).
    /// У ArbiterAccountabilityFacet своих геттеров этих полей нет, поэтому
    /// обратное чтение — прямой vm.load, а не через ABI.
    function _setSeatedBy(address arbiterAddr, address seater) internal {
        bytes32 slot = keccak256(abi.encode(arbiterAddr, uint256(bytes32(uint256(ARB_BASE) + 25))));
        vm.store(address(acc), slot, bytes32(uint256(uint160(seater))));
    }

    function _setSeatedCountBy(address seater, uint256 count) internal {
        bytes32 slot = keccak256(abi.encode(seater, uint256(bytes32(uint256(ARB_BASE) + 26))));
        vm.store(address(acc), slot, bytes32(count));
    }

    function _getSeatedCountBy(address seater) internal view returns (uint256) {
        bytes32 slot = keccak256(abi.encode(seater, uint256(bytes32(uint256(ARB_BASE) + 26))));
        return uint256(vm.load(address(acc), slot));
    }

    function _setArbiterBond(address who, uint256 amount) internal {
        bytes32 slot = keccak256(abi.encode(who, uint256(bytes32(uint256(ARB_BASE) + SLOT_ARBITER_BOND))));
        vm.store(address(acc), slot, bytes32(amount));
    }

    function _getArbiterBond(address who) internal view returns (uint256) {
        bytes32 slot = keccak256(abi.encode(who, uint256(bytes32(uint256(ARB_BASE) + SLOT_ARBITER_BOND))));
        return uint256(vm.load(address(acc), slot));
    }

    function _getVaultBalance() internal view returns (uint256) {
        return uint256(vm.load(address(acc), bytes32(uint256(ARB_BASE) + SLOT_VAULT_BALANCE)));
    }

    function _setUniqueActiveUsers(uint256 n) internal {
        vm.store(address(acc), bytes32(uint256(REP_BASE) + SLOT_UNIQUE_ACTIVE_USERS), bytes32(n));
    }

    /// trustedForwarder — слот 3 внутри FactoryStorage.Layout (usdc(0),
    /// feeRecipient(1), regionFee(2, mapping — свой слот), trustedForwarder(3)).
    /// НЕ «второе поле», как ошибочно предполагал бриф задачи 8 — то же
    /// смещение, что уже утверждено test/DisputeNoResponse.t.sol,
    /// test/ArbiterChatKey.t.sol и test/BoardsFixture.sol. Читаем-сверяем
    /// сразу же: при неверном смещении vm.store молча пишет в чужое поле, и
    /// test_RespondToRemovalThroughForwarderCreditsHuman проверял бы совсем не
    /// то, о чём его имя.
    function _setForwarder(address facet, address forwarder) internal {
        bytes32 slot = bytes32(uint256(FactoryStorage.FACTORY_STORAGE_POSITION) + 3);
        vm.store(facet, slot, bytes32(uint256(uint160(forwarder))));
        assertEq(
            address(uint160(uint256(vm.load(facet, slot)))),
            forwarder,
            unicode"смещение trustedForwarder в FactoryStorage.Layout уехало"
        );
    }

    /// EIP-712-подпись ForwardRequest — дословная копия
    /// test/DisputeNoResponse.t.sol::_signFwd (круг правок 1 ревью задачи 8,
    /// Minor 3): тот же домен `("MinimalForwarder", "0.0.1")`, тот же typehash.
    function _signFwd(MinimalForwarder fwd, uint256 pk, MinimalForwarder.ForwardRequest memory req)
        internal view returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(
            FWD_TYPEHASH, req.from, req.to, req.value, req.gas, req.nonce, keccak256(req.data)
        ));
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",
            keccak256(abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("MinimalForwarder")),
                keccak256(bytes("0.0.1")),
                block.chainid,
                address(fwd)
            )),
            structHash
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// MISTAKE_THRESHOLD в новом фасете обязан быть СТРОГО НИЖЕ
    /// MAX_ARBITER_MISTAKES в старом (C-1, круг правок 1) — не равен: на
    /// равенстве автоматика (_recordArbiterMistake) сбрасывает счётчик в той
    /// же транзакции, что снимает isArbiter, и OverturnedVerdicts/Timeouts не
    /// проходили бы никогда. Дополнительно сверяется зеркало
    /// MAX_ARBITER_MISTAKES_MIRROR отдельно от производного порога — так
    /// ловится дрейф самого зеркала, а не только итоговое неравенство.
    function test_MistakeThresholdMatchesRegistry() public {
        ArbiterRegistryFacet reg = new ArbiterRegistryFacet();
        assertEq(acc.getMaxArbiterMistakesMirror(), reg.getMaxArbiterMistakes(),
            unicode"зеркало порога обязано совпадать с боевым числом");
        assertLt(acc.getMistakeThreshold(), reg.getMaxArbiterMistakes(),
            unicode"порог ручного сноса обязан быть СТРОГО ниже автоматического — иначе недостижим");
    }
}
