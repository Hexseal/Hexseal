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
// Право сноса передаётся, а не запирается: до активации ДАО зовёт только
// владелец, после — только daoAddress. Дыра в первой версии этого плана
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
        vm.expectRevert(
            abi.encodeWithSelector(ArbiterAccountabilityFacet.CauseNotProven.selector, uint8(0))
        );
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));
    }

    function test_OverturnedVerdictsPassesAtThreshold() public {
        _setStreak(arbiter, 2);   // MISTAKE_THRESHOLD = MAX_ARBITER_MISTAKES(3) − 1

        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.ArbiterRemovedForCause(
            arbiter, owner, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, true, bytes32(0), 0
        );

        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));
        assertFalse(_isArbiterRaw(arbiter), unicode"снятый больше не арбитр");
    }

    // ---------- ЗАВЕРЯЕМЫЕ, НО НЕ ПРОВЕРЯЕМЫЕ ----------

    function test_CollusionWithoutEvidenceIsRefused() public {
        vm.expectRevert(ArbiterAccountabilityFacet.EvidenceRequired.selector);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, bytes32(0), address(0));
    }

    function test_CollusionWithEvidenceIsMarkedUnverified() public {
        bytes32 digest = keccak256(unicode"переписка со стороной спора");

        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.ArbiterRemovedForCause(
            arbiter, owner, ArbiterAccountabilityFacet.Cause.Collusion, false, digest, 0
        );

        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, digest, address(0));
    }

    /// I-6 (круг правок 1): вторая копия DisputeRefNotApplicable, живущая ВНЕ
    /// _requireProven (на пути Collusion/Leak/Other), не была покрыта ничем —
    /// снять её раньше давало 0 красных.
    function test_UnverifiableCauseRejectsDisputeRef() public {
        vm.expectRevert(ArbiterAccountabilityFacet.DisputeRefNotApplicable.selector);
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.Collusion, keccak256("evidence"), address(0xD1)
        );
    }

    /// Silence — признак ПО КОНКРЕТНОМУ СПОРУ, и без адреса спора проверить
    /// его нечем. Слить его со счётчиком серии нельзя: тогда цепь заверяла бы
    /// не то, что написано в записи.
    function test_SilenceRequiresDisputeRef() public {
        vm.expectRevert(ArbiterAccountabilityFacet.DisputeRefRequired.selector);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Silence, bytes32(0), address(0));
    }

    function test_SilenceRequiresTheRecord() public {
        address deal = address(0xD1);
        vm.expectRevert(
            abi.encodeWithSelector(ArbiterAccountabilityFacet.CauseNotProven.selector, uint8(2))
        );
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Silence, bytes32(0), deal);
    }

    function test_SilencePassesWhenRecorded() public {
        address deal = address(0xD1);
        _setNoResponse(deal, arbiter, 1_700_000_000);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Silence, bytes32(0), deal);
        assertFalse(_isArbiterRaw(arbiter), unicode"снят по записанному молчанию");
    }

    /// Адрес спора у кода, который его не читает, — мусор в записи: читатель
    /// решит, что снос связан с той сделкой.
    function test_DisputeRefIsRefusedWhereItDoesNotApply() public {
        _setStreak(arbiter, 2);
        vm.expectRevert(ArbiterAccountabilityFacet.DisputeRefNotApplicable.selector);
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0xD1)
        );
    }

    /// Timeouts и OverturnedVerdicts упираются в ОДИН счётчик — цепь их не
    /// различает. Тест это фиксирует, чтобы никто не считал, будто различает.
    function test_TimeoutsUsesTheSameCounter() public {
        _setStreak(arbiter, 2);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Timeouts, bytes32(0), address(0));
        assertFalse(_isArbiterRaw(arbiter));
    }

    // ---------- КТО МОЖЕТ ----------

    function test_ChiefCannotRemove() public {
        _setStreak(arbiter, 2);
        _setChief(chief);
        vm.prank(chief);
        vm.expectRevert(ArbiterAccountabilityFacet.NotOwner.selector);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));
    }

    /// I-4 (круг правок 1): NotAnArbiter на пути сноса не был покрыт ничем.
    function test_RemovalForCauseRevertsIfNotAnArbiter() public {
        address stranger = address(0xF00D); // никогда не регистрировался
        vm.expectRevert(ArbiterAccountabilityFacet.NotAnArbiter.selector);
        acc.removeArbiterForCause(stranger, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));
    }

    /// Храповик: после активации ДАО владельца цепь не пускает вовсе — право
    /// уехало к daoAddress (см. следующие два теста). daoAddress здесь не
    /// назначен (остаётся нулём), поэтому и он не смог бы: это осознанный
    /// снимок «активировали ДАО, забыли назначить преемника» — за него
    /// отвечает activateDAO()'s DaoAddressNotSet() guard в ArbiterRegistryFacet,
    /// не этот тест.
    function test_OwnerCannotRemoveAfterDAO() public {
        _setStreak(arbiter, 2);
        _activateDAO();
        vm.expectRevert(ArbiterAccountabilityFacet.RemovalHandedOver.selector);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));
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
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));
    }

    /// Симметричная половина test_OwnerCannotRemoveAfterDAO: назначенный
    /// daoAddress ПОСЛЕ активации ДАО может снимать — право не потеряно,
    /// оно уехало к конкретному адресу.
    function test_DaoAddressCanRemoveAfterDao() public {
        _setStreak(arbiter, 2);
        address dao = address(0xDA0);
        _setDaoAddress(dao);
        _activateDAO();

        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.ArbiterRemovedForCause(
            arbiter, dao, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, true, bytes32(0), 0
        );

        vm.prank(dao);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));
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

        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.ArbiterRemovedForCause(
            arbiter, owner, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, true, bytes32(0), bond
        );

        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));

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

        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));

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

        vm.expectRevert(
            abi.encodeWithSelector(ArbiterAccountabilityFacet.CauseNotProven.selector, uint8(0))
        );
        acc.removeArbiterForCause(untouched, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));

        _setStreak(arbiter, acc.getMistakeThreshold());
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));
        assertFalse(_isArbiterRaw(arbiter), unicode"снятый больше не арбитр");
    }

    /// Тот же приём для disputeNoResponseAtBy: позитив (запись через
    /// вычисленный слот — снос проходит) и негатив (другая сделка — падает).
    function test_NoResponseSlotOffsetIsCorrect() public {
        address deal = address(0xD1);
        address untouchedDeal = address(0xD2);

        vm.expectRevert(
            abi.encodeWithSelector(ArbiterAccountabilityFacet.CauseNotProven.selector, uint8(2))
        );
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Silence, bytes32(0), untouchedDeal);

        _setNoResponse(deal, arbiter, 1_700_000_000);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Silence, bytes32(0), deal);
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
    /// этот сценарий проходил бы мимо: владелец продолжал бы снимать
    /// арбитров, пока addArbiter/setChiefArbiter (которые зовут
    /// ArbiterRegistryFacet.isDaoActive() напрямую) уже отказывали бы.
    function test_EarnedDaoActivatesWithoutManualFlag() public {
        _setStreak(arbiter, 2);
        _setUniqueActiveUsers(acc.getDaoThresholdMirror());

        vm.expectRevert(ArbiterAccountabilityFacet.RemovalHandedOver.selector);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));
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
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, digest);

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
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"));

        vm.warp(vm.getBlockTimestamp() + 14 days);
        assertFalse(acc.hasLiveProposal(arbiter), unicode"через 14 суток предложение протухло");
    }

    function test_ProposalIsLiveUntilTheLastSecond() public {
        _setChief(chief);
        vm.prank(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"));

        vm.warp(vm.getBlockTimestamp() + 14 days - 1);
        assertTrue(acc.hasLiveProposal(arbiter), unicode"за секунду до конца ещё живо");
    }

    function test_ChiefWithdrawsHisOwnProposal() public {
        _setChief(chief);
        vm.startPrank(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"));
        acc.withdrawProposal(arbiter);
        vm.stopPrank();
        assertFalse(acc.hasLiveProposal(arbiter), unicode"передумал — отозвал");
    }

    function test_StrangerCannotPropose() public {
        vm.prank(address(0x5A));
        vm.expectRevert(ArbiterAccountabilityFacet.NotOwnerOrChief.selector);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"));
    }

    /// Второе требование контроллера сверх брифа: код заверяемый — отпечаток
    /// обязателен УЖЕ на этапе предложения, не только при исполнении.
    function test_ProposeUnverifiableWithoutEvidenceIsRefused() public {
        _setChief(chief);
        vm.prank(chief);
        vm.expectRevert(ArbiterAccountabilityFacet.EvidenceRequired.selector);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, bytes32(0));
    }

    /// Проверяемые цепью коды (OverturnedVerdicts/Timeouts/Silence) на этапе
    /// предложения НЕ проверяются намеренно: streak здесь ниже порога, а
    /// предложение всё равно проходит — признак может появиться уже после
    /// того, как директор предупредил.
    function test_ProposeVerifiableCauseDoesNotCheckTheStreakYet() public {
        _setChief(chief);
        // streak НЕ выставлен — ниже MISTAKE_THRESHOLD (и вообще ноль).
        vm.prank(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0));
        assertTrue(acc.hasLiveProposal(arbiter), unicode"проверяемый код не сверяется на этапе предложения");
    }

    /// Владелец предлагает наравне с директором — onlyOwnerOrChief пускает
    /// обоих, не только директора.
    function test_OwnerCanAlsoPropose() public {
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"));
        (, , , address by, ) = acc.getRemovalProposal(arbiter);
        assertEq(by, owner);
    }

    /// Владелец может отозвать предложение, положенное директором — оба
    /// ходят под одним модификатором, право отзыва не привязано к тому, кто
    /// именно предложил.
    function test_OwnerWithdrawsChiefsProposal() public {
        _setChief(chief);
        vm.prank(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"));

        acc.withdrawProposal(arbiter);
        assertFalse(acc.hasLiveProposal(arbiter), unicode"владелец снял чужое предложение");
    }

    /// Второе предложение перезаписывает первое — претензия одна, а не
    /// очередь претензий.
    function test_SecondProposalOverwritesFirst() public {
        _setChief(chief);
        vm.startPrank(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("first"));
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Other, keccak256("second"));
        vm.stopPrank();

        (uint8 c, bytes32 dg, , , ) = acc.getRemovalProposal(arbiter);
        assertEq(c, uint8(ArbiterAccountabilityFacet.Cause.Other));
        assertEq(dg, keccak256("second"));
    }

    /// Успешный снос очищает предложение — иначе оно пережило бы уже снятого
    /// арбитра и висело бы против него бессмысленным обвинением.
    function test_RemovalClearsTheProposal() public {
        _setChief(chief);
        vm.prank(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"));
        assertTrue(acc.hasLiveProposal(arbiter), unicode"сетап: предложение живо");

        _setStreak(arbiter, 2);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));

        assertFalse(acc.hasLiveProposal(arbiter), unicode"снос обязан стереть предложение");
    }

    /// Предложение на несуществующего арбитра не кладётся — та же проверка,
    /// что и у самого сноса.
    function test_ProposeRevertsIfNotAnArbiter() public {
        address stranger = address(0xF00D);
        vm.expectRevert(ArbiterAccountabilityFacet.NotAnArbiter.selector);
        acc.proposeRemoval(stranger, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0));
    }

    /// Minor 5, круг правок 1: ветка ArbiterZeroAddress была объявлена, но ни
    /// один тест её не проверял — снять строку и ни один тест не покраснел бы,
    /// потому что следующая же строка ревертит NotAnArbiter (тот же класс, что
    /// уже ловили в задаче 4 у suspendArbiter, см. test_SuspendZeroAddressReverts
    /// в test/ArbiterSuspension.t.sol).
    function test_ProposeRevertsOnZeroAddress() public {
        vm.expectRevert(ArbiterAccountabilityFacet.ArbiterZeroAddress.selector);
        acc.proposeRemoval(address(0), ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"));
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
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"));

        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.RemovalProposalWithdrawn(arbiter, owner);
        acc.withdrawProposal(arbiter);
    }

    /// Minor 4: снос эмитит RemovalProposalConsumed с полями СТЁРТОЙ записи —
    /// «предложили за Leak/директором — снесли за OverturnedVerdicts/владельцем»
    /// видно в одной транзакции, оба события лежат в одном логе.
    function test_RemovalConsumesTheProposal() public {
        _setChief(chief);
        bytes32 digest = keccak256(unicode"докладная");
        vm.prank(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, digest);
        (, , uint256 proposedAt, , ) = acc.getRemovalProposal(arbiter);

        _setStreak(arbiter, 2);

        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.RemovalProposalConsumed(
            arbiter, ArbiterAccountabilityFacet.Cause.Leak, chief, digest, proposedAt
        );
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0)
        );
    }

    /// Отрицательная половина Minor 4: снос без предшествующего предложения
    /// не обязан ничего сообщать про предложение, которого не было — ровно
    /// один лог (ArbiterRemovedForCause), Consumed молчит.
    function test_RemovalWithoutProposalEmitsOnlyTheRemovalEvent() public {
        _setStreak(arbiter, 2);
        vm.recordLogs();
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0)
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, unicode"без предложения — только ArbiterRemovedForCause, Consumed молчит");
    }

    /// Улучшение: пятое поле `live` в getRemovalProposal согласовано с
    /// hasLiveProposal на протухшей записи, не только на свежей (свежую уже
    /// проверяет test_ChiefProposes).
    function test_GetRemovalProposalLiveFieldFalseAfterExpiry() public {
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Leak, keccak256("x"));
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
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));

        bytes32 reply = keccak256(unicode"вот переписка целиком, судите сами");

        vm.expectEmit(true, false, false, true, address(acc));
        emit ArbiterAccountabilityFacet.RemovalAnswered(arbiter, reply);

        vm.prank(arbiter);
        acc.respondToRemoval(reply);

        assertEq(acc.getRemovalReply(arbiter), reply, unicode"ответ лёг в цепь");
    }

    function test_AnswerIsOnceOnly() public {
        _setStreak(arbiter, 2);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));

        vm.startPrank(arbiter);
        acc.respondToRemoval(keccak256("first"));
        vm.expectRevert(ArbiterAccountabilityFacet.AlreadyAnswered.selector);
        acc.respondToRemoval(keccak256("second"));
        vm.stopPrank();
    }

    function test_ZeroReplyIsRefused() public {
        _setStreak(arbiter, 2);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));
        vm.prank(arbiter);
        vm.expectRevert(ArbiterAccountabilityFacet.ZeroDigest.selector);
        acc.respondToRemoval(bytes32(0));
    }

    /// Отвечать может только тот, кого сняли. Иначе посторонний засыпал бы
    /// ленту чужими «ответами».
    function test_OnlyRemovedCanAnswer() public {
        vm.prank(address(0x5A));
        vm.expectRevert(ArbiterAccountabilityFacet.NothingToAnswer.selector);
        acc.respondToRemoval(keccak256("x"));
    }

    bytes32 constant FWD_TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data)"
    );

    /// Две копии _msgSender() обязаны вести себя одинаково. Разойдутся —
    /// гейслесс-путь одного фасета начнёт видеть форвардер вместо человека.
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
    function test_MsgSenderMatchesRegistry() public {
        uint256 arbiterPk = 0xCA11;
        address arb = vm.addr(arbiterPk);
        address relayer = address(0x9999); // третий адрес: не арбитр, не форвардер

        // Свежий арбитр под этим адресом — setUp сажает только фиксированный
        // `arbiter` (0xA1), у которого нет известного приватного ключа.
        vm.store(address(acc), keccak256(abi.encode(arb, uint256(ARB_BASE))), bytes32(uint256(1)));

        MinimalForwarder fwd = new MinimalForwarder();
        _setForwarder(address(acc), address(fwd));

        _setStreak(arb, 2);
        acc.removeArbiterForCause(arb, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));

        MinimalForwarder.ForwardRequest memory req = MinimalForwarder.ForwardRequest({
            from:  arb,
            to:    address(acc),
            value: 0,
            gas:   500_000,
            nonce: fwd.getNonce(arb),
            data:  abi.encodeWithSelector(acc.respondToRemoval.selector, keccak256("x"))
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

    function _setStreak(address who, uint256 n) internal {
        bytes32 base = bytes32(uint256(ARB_BASE) + SLOT_MISTAKE_STREAK);
        vm.store(address(acc), keccak256(abi.encode(who, uint256(base))), bytes32(n));
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
    /// test_MsgSenderMatchesRegistry проверял бы совсем не то, о чём его имя.
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
