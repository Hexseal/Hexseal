// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Приостановка арбитра.
//
// Главная часть всей работы. Между недобросовестным арбитром и котлом стоят
// ровно 24 часа (FINALIZE_DELAY): обжаловать можно только до финализации, а
// после неё не отыгрывается ничего. Приостановка — единственное, что успевает
// внутрь этого окна.
//
// Она намеренно ОБРАТИМА и протухает сама: худшее, что ею можно сделать —
// задержать деньги на срок окна, и цепь покажет, кто это сделал. Поэтому она
// остаётся у владельца и после передачи сноса голосованию.
//
// ⚠️ Время читается ТОЛЬКО через vm.getBlockTimestamp(): под via_ir solc
// считает TIMESTAMP неизменным внутри вызова, и второй vm.warp в одном теле
// теста прыгнул бы в ту же секунду (docs/OPEN-ITEMS.md п. 57).

import "forge-std/Test.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";
import {ArbiterTwoFacetBench} from "./ArbiterTwoFacetBench.sol";
import {ArbiterAccountabilityFacet} from "../src/facets/ArbiterAccountabilityFacet.sol";

/// Минимальный мок Agreement — только то, что читает/зовёт finalizeVerdict
/// (через claimDispute/submitVerdict на пути туда): status/disputedAt/
/// DISPUTE_WINDOW/client/executor читаются staticcall'ом, setArbiter/
/// resolveDispute зовутся call'ом. Реальный Agreement сюда не нужен — задача 5
/// не про исполнение вердикта, а про то, что приостановленному его исполнить
/// не дают.
contract MockAgreementForFinalize {
    address public client;
    address public executor;

    constructor(address client_, address executor_) {
        client = client_;
        executor = executor_;
    }

    function status() external pure returns (uint8) { return 4; } // DISPUTED
    function disputedAt() external view returns (uint256) { return block.timestamp; }
    function DISPUTE_WINDOW() external pure returns (uint256) { return 30 days; }
    function setArbiter(address) external {}
    function resolveDispute(bool) external {}
}

contract ArbiterSuspensionTest is Test, ArbiterTwoFacetBench {
    ArbiterAccountabilityFacet acc;
    ArbiterRegistryFacet reg;

    address owner;
    address chief;
    address arbiter;
    address stranger;

    bytes32 constant ARB_BASE = 0xaae71de0594cbcb5434f0ab7f7501c1be178552bf788b418a1c2624ba9718d00;
    bytes32 constant OWNER_SLOT = 0x178642b411f9f4783b21ef338f3e96db6c1272d763f0b7500ec93464dafb8604;

    function setUp() public {
        // ⚠️ ОДИН АДРЕС НА ОБА ФАСЕТА (задача 4.5, 16 августа 2026).
        // Прежде здесь стояли два отдельных `new`, и у каждого фасета было
        // СВОЁ хранилище по одному и тому же смещению неймспейса. Это
        // работало, пока каждый тест трогал состояние ровно одного из них.
        //
        // Задача 4.5 увезла getCleanVerdicts в фасет ответственности, а пишет
        // счётчик по-прежнему finalizeVerdict в реестре — то есть путь
        // «записал через reg, прочитал через acc» стал обычным делом. На двух
        // отдельных контрактах он давал бы чистый ноль и выглядел бы ответом.
        // Стенд теперь даёт один прокси с кодом обоих фасетов, как в бою.
        (reg, acc) = _deployArbiterBench();

        owner    = address(this);
        chief    = address(0xC4);
        arbiter  = address(0xA1);
        stranger = address(0x5A);

        vm.store(address(acc), OWNER_SLOT, bytes32(uint256(uint160(owner))));
        _makeArbiter(acc, arbiter);
        _setChief(acc, chief);
    }

    function test_OwnerSuspends() public {
        uint256 t0 = vm.getBlockTimestamp();

        vm.expectEmit(true, true, false, true, address(acc));
        emit ArbiterAccountabilityFacet.ArbiterSuspended(arbiter, owner, t0 + 72 hours);

        acc.suspendArbiter(arbiter);

        assertTrue(acc.isSuspended(arbiter), unicode"после нажатия арбитр приостановлен");
        assertEq(acc.getSuspendedUntil(arbiter), t0 + 72 hours, unicode"окно ровно 72 часа");
    }

    function test_ChiefSuspends() public {
        vm.prank(chief);
        acc.suspendArbiter(arbiter);
        assertTrue(acc.isSuspended(arbiter), unicode"остановить кровь — работа директора");
    }

    function test_StrangerCannotSuspend() public {
        vm.prank(stranger);
        vm.expectRevert(ArbiterAccountabilityFacet.NotOwnerOrChief.selector);
        acc.suspendArbiter(arbiter);
    }

    function test_SuspensionExpiresByItself() public {
        acc.suspendArbiter(arbiter);
        assertTrue(acc.isSuspended(arbiter));

        vm.warp(vm.getBlockTimestamp() + 72 hours);
        assertFalse(acc.isSuspended(arbiter), unicode"на границе окна приостановка уже отпустила");
    }

    function test_SuspensionHoldsUntilTheLastSecond() public {
        acc.suspendArbiter(arbiter);
        vm.warp(vm.getBlockTimestamp() + 72 hours - 1);
        assertTrue(acc.isSuspended(arbiter), unicode"за секунду до конца ещё держит");
    }

    function test_OwnerLiftsEarly() public {
        acc.suspendArbiter(arbiter);
        acc.liftSuspension(arbiter);
        assertFalse(acc.isSuspended(arbiter), unicode"разобрался раньше срока — отпустил");
        assertEq(acc.getSuspendedUntil(arbiter), 0, unicode"счётчик обнулён, а не оставлен в прошлом");
    }

    // ── п. 66 (16 августа 2026): слабая рука не отменяет сильную ──
    //
    // Приостановка бывает двух весов, и цепь их различает по записи о сносе.
    // Обычная — быстрая, обратимая, никого не обвиняет: её снимает и
    // директор, это его работа. Наложенная СНОСОМ — единственное, что держит
    // деньги по вердиктам снятого внутри FINALIZE_DELAY, и вернуть её после
    // снятия нельзя ничем (suspendArbiter требует isArbiter, а снятый уже не
    // арбитр). Отменять её — то же самое, что отменять сам снос, а сносить
    // директору нельзя.

    /// Директор не открывает окно, выставленное сносом.
    function test_ChiefCannotLiftRemovalSuspension() public {
        acc.removeArbiterForCause(
            arbiter,
            ArbiterAccountabilityFacet.Cause.Collusion,
            keccak256(unicode"переписка"),
            address(0)
        );
        assertTrue(acc.isSuspended(arbiter), unicode"сетап: снос выставил окно C-1");

        vm.prank(chief);
        vm.expectRevert(ArbiterAccountabilityFacet.RemovalSuspensionIsRemovalAuthorityOnly.selector);
        acc.liftSuspension(arbiter);

        assertTrue(acc.isSuspended(arbiter), unicode"окно на месте — директор его не открыл");
    }

    /// Владелец — открывает. Он отменяет СВОЁ ЖЕ решение, и это ровно та же
    /// развилка, что уже решена в addArbiter (liftSuspension = true).
    function test_OwnerLiftsRemovalSuspension() public {
        acc.removeArbiterForCause(
            arbiter,
            ArbiterAccountabilityFacet.Cause.Collusion,
            keccak256(unicode"переписка"),
            address(0)
        );

        acc.liftSuspension(arbiter);

        assertFalse(acc.isSuspended(arbiter), unicode"владелец вправе отменить своё решение");
        assertEq(acc.getSuspendedUntil(arbiter), 0, unicode"счётчик обнулён, а не оставлен в прошлом");
    }

    /// Обратная сторона той же проверки, и без неё замок был бы слишком
    /// широким: ОБЫЧНУЮ приостановку директор по-прежнему снимает. Если
    /// потерять эту проверку, «гейтится весомое» незаметно превратится в
    /// «гейтится всякое», и у директора не останется работы вовсе.
    function test_ChiefStillLiftsAnOrdinarySuspension() public {
        acc.suspendArbiter(arbiter);
        assertTrue(acc.isSuspended(arbiter));

        vm.prank(chief);
        acc.liftSuspension(arbiter);

        assertFalse(acc.isSuspended(arbiter), unicode"лёгкая мера — лёгкая рука, это его работа");
    }

    function test_SuspendingNonArbiterReverts() public {
        vm.expectRevert(ArbiterAccountabilityFacet.NotAnArbiter.selector);
        acc.suspendArbiter(stranger);
    }

    /// Ветка ArbiterZeroAddress была объявлена, но ни один тест её не проверял:
    /// поведение заявлено именем ошибки, а не доказано (добавление 3, задача 5).
    function test_SuspendZeroAddressReverts() public {
        vm.expectRevert(ArbiterAccountabilityFacet.ArbiterZeroAddress.selector);
        acc.suspendArbiter(address(0));
    }

    /// Повторное нажатие продлевает окно от текущего момента, а не удлиняет
    /// его вдвое: иначе владелец, нажавший дважды по невнимательности, держит
    /// чужие деньги шесть суток вместо трёх.
    function test_SecondSuspendRestartsWindow() public {
        acc.suspendArbiter(arbiter);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        uint256 t1 = vm.getBlockTimestamp();
        acc.suspendArbiter(arbiter);
        assertEq(acc.getSuspendedUntil(arbiter), t1 + 72 hours, unicode"окно считается от нового нажатия");
    }

    // ============================================================
    //  ЗУБЫ ПРИОСТАНОВКИ
    //
    //  Без них приостановка — надпись. Третий запрет (увольнение) важнее
    //  первых двух: resignAsArbiter возвращает залог ЦЕЛИКОМ, значит
    //  подозреваемый уходит с деньгами до сноса, и весь денежный контур
    //  наказания остаётся декоративным.
    // ============================================================

    /// Здесь нужен один фасет на оба контракта: запрет читает то же поле,
    /// которое пишет приостановка. Разворачиваем reg и правим его слоты.
    function test_SuspendedCannotClaim() public {
        _makeArbiterReg(arbiter);
        _suspendInReg(arbiter, vm.getBlockTimestamp() + 72 hours);

        vm.prank(arbiter);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArbiterRegistryFacet.ArbiterSuspendedError.selector,
                vm.getBlockTimestamp() + 72 hours
            )
        );
        reg.claimDispute(address(0xDEAD), bytes32(0), bytes32(uint256(1)), bytes32(uint256(2)));
    }

    function test_SuspendedCannotResign() public {
        _makeArbiterReg(arbiter);
        _suspendInReg(arbiter, vm.getBlockTimestamp() + 72 hours);

        vm.prank(arbiter);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArbiterRegistryFacet.ArbiterSuspendedError.selector,
                vm.getBlockTimestamp() + 72 hours
            )
        );
        reg.resignAsArbiter();
    }

    /// Приостановка отпустила — увольняться снова можно. Иначе она была бы
    /// вечным запретом под видом временного.
    function test_ResignWorksAfterSuspensionExpires() public {
        _makeArbiterReg(arbiter);
        _suspendInReg(arbiter, vm.getBlockTimestamp() + 72 hours);

        vm.warp(vm.getBlockTimestamp() + 72 hours);

        vm.prank(arbiter);
        reg.resignAsArbiter();
        assertFalse(reg.isRegisteredArbiter(arbiter), unicode"после окна уволиться можно");
    }

    /// Третий запрет проверяет АРБИТРА ВЕРДИКТА, а не вызывающего finalizeVerdict
    /// (тот может звать кто угодно). Доводим спор до поданного вердикта реальным
    /// путём (commit → claim → submit), приостанавливаем арбитра ПОСЛЕ подачи —
    /// и финализация обязана отказать той же ошибкой.
    function test_SuspendedArbiterCannotFinalize() public {
        _makeArbiterReg(arbiter);
        MockAgreementForFinalize agreement = new MockAgreementForFinalize(address(0xC1), address(0xE1));
        _advanceToSubmittedVerdict(agreement, bytes32(uint256(7)));

        uint256 until = vm.getBlockTimestamp() + 72 hours;
        _suspendInReg(arbiter, until);

        vm.expectRevert(
            abi.encodeWithSelector(ArbiterRegistryFacet.ArbiterSuspendedError.selector, until)
        );
        reg.finalizeVerdict(address(agreement));
    }

    /// commit → roll → claim → submit, общий разгон обоих тестов пути
    /// finalizeVerdict (третий запрет и счётчик чистых вердиктов) до
    /// поданного вердикта. Вынесено в круге правок 1 (задача 5, minor):
    /// семь-восемь строк дословно повторялись в двух тестах.
    function _advanceToSubmittedVerdict(MockAgreementForFinalize agreement, bytes32 salt) internal {
        vm.prank(arbiter);
        reg.commitDisputeClaim(keccak256(abi.encodePacked(address(agreement), arbiter, salt)));
        // vm.getBlockNumber(), а не block.number: под via_ir solc считает NUMBER
        // неизменным внутри вызова ровно так же, как TIMESTAMP (шапка файла), и
        // второй vm.roll в одном теле теста прыгнул бы в тот же блок — клейм
        // получил бы CommitmentTooEarly. Одиночным вызовам хелпера это было
        // безразлично; правка A зовёт его четырежды подряд.
        vm.roll(vm.getBlockNumber() + 1);

        vm.prank(arbiter);
        reg.claimDispute(address(agreement), salt, bytes32(uint256(1)), bytes32(uint256(2)));

        vm.prank(arbiter);
        reg.submitVerdict(address(agreement), true);
    }

    function _makeArbiterReg(address who) internal {
        vm.store(address(reg), keccak256(abi.encode(who, uint256(ARB_BASE))), bytes32(uint256(1)));
    }

    /// Смещение suspendedUntil внутри Data. Добыто перебором, не взято из
    /// брифа: тот предполагал 25 (по образцу задачи 3, где предположение 21
    /// оказалось реальностью 13 — упаковка адреса/bool со слотом chiefArbiter
    /// сдвигает индексы всех полей после него). Одноразовый зонд (перебор
    /// offset 0..59, запись 999999 в keccak256(arbiter, ARB_BASE+offset),
    /// сверка с acc.getSuspendedUntil(arbiter)) дал единственное совпадение —
    /// offset 27. Сторожится тестом ниже.
    uint256 constant SLOT_SUSPENDED_UNTIL = 27;

    function _suspendInReg(address who, uint256 until) internal {
        bytes32 base = bytes32(uint256(ARB_BASE) + SLOT_SUSPENDED_UNTIL);
        vm.store(address(reg), keccak256(abi.encode(who, uint256(base))), bytes32(until));
    }

    /// ⚠️ Упрощён задачей 4.5 (16 августа 2026), и это усиление, а не потеря.
    /// Прежде тест писал сырой слот в ОДИН контракт, убеждался, что ВТОРОЙ
    /// отвечает нулём («это другой контракт»), и лишь потом дублировал запись
    /// во второй, чтобы сверить смещение. Первая половина проверяла не
    /// смещение, а тот факт, что у двух отдельных `new` разные хранилища.
    ///
    /// Стенд теперь один адрес на оба фасета, и проверка стала прямой: пишем
    /// сырой слот ровно там, куда смотрит боевой геттер, и требуем от него
    /// это значение. Смещение 27 сторожится по-прежнему — и теперь тем же
    /// адресом, которым пользуется `_suspendInReg` во всех тестах зубов.
    function test_SuspendedUntilSlotMatchesLiveStorage() public {
        _suspendInReg(arbiter, 12345);
        assertEq(acc.getSuspendedUntil(arbiter), 12345, unicode"смещение слота suspendedUntil уехало");
    }

    // ============================================================
    //  СЧЁТЧИК ЧИСТЫХ ВЕРДИКТОВ (добавление 1 к задаче 5)
    //
    //  Стаж понадобится ПОЗЖЕ, при включении ДАО («залог плюс судейский
    //  стаж»), но считать его нечем, если не завести счётчик сейчас — заводить
    //  его в момент включения ДАО бессмысленно, у всех будет ноль.
    // ============================================================

    function test_CleanVerdictIncrementsOnFinalize() public {
        _makeArbiterReg(arbiter);
        MockAgreementForFinalize agreement = new MockAgreementForFinalize(address(0xC2), address(0xE2));
        _advanceToSubmittedVerdict(agreement, bytes32(uint256(11)));

        assertEq(acc.getCleanVerdicts(arbiter), 0, unicode"до финализации стажа нет");

        vm.warp(vm.getBlockTimestamp() + 24 hours);
        reg.finalizeVerdict(address(agreement));

        assertEq(acc.getCleanVerdicts(arbiter), 1, unicode"неперевёрнутый вердикт добавил стаж");
    }

    // ============================================================
    //  АВТОДЕМОУШЕН ТОЖЕ ПРИОСТАНАВЛИВАЕТ (правка A, 16 августа 2026)
    //
    //  Дверей снятия арбитра две. Ручная (removeArbiterForCause) выставляет
    //  приостановку с починки C-1. Автоматическая — третья судейская ошибка в
    //  _recordArbiterMistake — до правки A её не выставляла, и это была та же
    //  дыра на двери, которая срабатывает БЕЗ человека: finalizeVerdict
    //  смотрит на приостановку, а не на статус, так что автоснятый доводил уже
    //  взятые споры до денег внутри FINALIZE_DELAY, и остановить его было
    //  нечем (suspendArbiter на неарбитре ревертит NotAnArbiter).
    //
    //  Оба теста доказывают ПОСЛЕДСТВИЕМ — отказом finalizeVerdict, — а не
    //  чтением поля: поле можно выставить и не читать нигде.
    // ============================================================

    /// Доводит `arbiter` до автодемоушена настоящим путём: три перевёрнутых
    /// вердикта подряд по трём разным сделкам. Никаких vm.store в счётчик
    /// ошибок — иначе тест разыгрывал бы сцену, до которой боевой код мог и не
    /// доходить.
    function _driveToAutoDemotion() internal {
        for (uint256 i = 0; i < 3; i++) {
            MockAgreementForFinalize mistake =
                new MockAgreementForFinalize(address(uint160(0xD00 + i)), address(uint160(0xE00 + i)));
            _advanceToSubmittedVerdict(mistake, bytes32(uint256(100 + i)));
            reg.overturnVerdict(address(mistake), false);
        }
    }

    function test_AutoDemotedArbiterCannotFinalize() public {
        vm.store(address(reg), OWNER_SLOT, bytes32(uint256(uint160(owner))));
        _makeArbiterReg(arbiter);

        // Спор, взятый ДО снятия: его-то автоснятый и доводил бы до денег.
        MockAgreementForFinalize victim = new MockAgreementForFinalize(address(0xC7), address(0xE7));
        _advanceToSubmittedVerdict(victim, bytes32(uint256(77)));

        uint256 t0 = vm.getBlockTimestamp();
        _driveToAutoDemotion();

        assertFalse(reg.isRegisteredArbiter(arbiter), unicode"сцена не та: автодемоушен не сработал");

        // Окно финализации прошло — единственное, что теперь стоит между
        // снятым арбитром и котлом, это приостановка.
        vm.warp(t0 + 24 hours);

        vm.expectRevert(
            abi.encodeWithSelector(ArbiterRegistryFacet.ArbiterSuspendedError.selector, t0 + 72 hours)
        );
        reg.finalizeVerdict(address(victim));
    }

    /// Различитель: без него первый тест не отличает приостановку от «сломалось
    /// вообще всё». После окна вердикт финализируется обычным порядком — снятый
    /// навсегда остаётся снятым, но вечно морозить чужие деньги приостановка не
    /// должна.
    function test_AutoDemotedArbiterVerdictFinalizesAfterWindow() public {
        vm.store(address(reg), OWNER_SLOT, bytes32(uint256(uint160(owner))));
        _makeArbiterReg(arbiter);

        MockAgreementForFinalize victim = new MockAgreementForFinalize(address(0xC8), address(0xE8));
        _advanceToSubmittedVerdict(victim, bytes32(uint256(78)));

        uint256 t0 = vm.getBlockTimestamp();
        _driveToAutoDemotion();

        assertFalse(reg.isRegisteredArbiter(arbiter), unicode"сцена не та: автодемоушен не сработал");

        vm.warp(t0 + 72 hours);
        reg.finalizeVerdict(address(victim));

        assertEq(acc.getCleanVerdicts(arbiter), 1, unicode"после окна вердикт исполнился обычным порядком");
    }

    function _makeArbiter(ArbiterAccountabilityFacet f, address who) internal {
        vm.store(address(f), keccak256(abi.encode(who, uint256(ARB_BASE))), bytes32(uint256(1)));
    }

    /// chiefArbiter — шестое поле Data (индекс 5), обычная переменная, не мэппинг.
    /// Раньше сверялось вызовом acc.getChiefArbiterAddress() — тестового геттера,
    /// снятого в задаче 5 (добавление 2): он дублировал уже существующий
    /// ArbiterRegistryFacet.getChiefArbiter(), а через прокси-даймонд оба
    /// селектора всё равно идут на один и тот же адрес.
    ///
    /// ⚠️ Голая запись, БЕЗ сторожа здесь (круг правок 1, задача 5, 15 августа
    /// 2026). Первая версия читала записанное обратно через `vm.load` того же
    /// вычисленного слота — тождество записи с самой собой: совпадало бы при
    /// ЛЮБОМ значении константы `+ 5`, верном или нет, и не могло покраснеть
    /// никогда. Постоянный публичный геттер заводить не стали (та же причина,
    /// по которой убрали getChiefArbiterAddress) — вместо него сторож смещения
    /// вынесен в отдельный поведенческий тест test_ChiefSlotOffsetIsCorrect
    /// ниже: он доказывает боевым кодом (`_requireOwnerOrChief`), что записанный
    /// слот — тот самый, а не тождеством.
    function _setChief(ArbiterAccountabilityFacet f, address who) internal {
        vm.store(address(f), bytes32(uint256(ARB_BASE) + 5), bytes32(uint256(uint160(who))));
    }

    /// Поведенческий сторож смещения слота chiefArbiter. Замена мёртвого
    /// vm.load-тождества (круг правок 1, задача 5, см. докстринг _setChief
    /// выше): записываем newChief через тот же хелпер, что использует setUp,
    /// и доказываем ПОВЕДЕНИЕМ, что боевое чтение слота видит именно его —
    /// вызовом liftSuspension (no-op помимо события, безопасный зонд: ничего
    /// не портит ни при успехе, ни при ревёрте). Посторонний на том же вызове
    /// обязан получить NotOwnerOrChief — контроль, что тест вообще что-то
    /// различает, а не проходит при любом caller'е.
    ///
    /// ⚠️ ЗОНД ХОДИТ НЕ ПОД МОДИФИКАТОРОМ (уборка 7а, п. 2.7). Здесь и ниже
    /// было написано «прошёл onlyOwnerOrChief» — с 16 августа это неправда:
    /// задача 2 сняла модификатор с `liftSuspension` целиком. Тело проверки то
    /// же самое (`_requireOwnerOrChief`, из которого модификатор и состоит), но
    /// зовётся оно теперь ЯВНО и только в одной из двух веток — той, где
    /// `removedAt == 0`. На свежем фасете он и есть ноль, поэтому зонд попадает
    /// именно в неё и остаётся годным. Стоило бы кому-нибудь завести здесь
    /// ненулевой `removedAt` — и зонд молча проверял бы уже другую ветку.
    function test_ChiefSlotOffsetIsCorrect() public {
        ArbiterAccountabilityFacet f = new ArbiterAccountabilityFacet();
        address newChief = address(0xC5);
        _setChief(f, newChief);

        vm.prank(newChief);
        f.liftSuspension(arbiter); // не ревертит — прошёл _requireOwnerOrChief боевым чтением слота

        vm.prank(stranger);
        vm.expectRevert(ArbiterAccountabilityFacet.NotOwnerOrChief.selector);
        f.liftSuspension(arbiter);
    }

    // ============================================================
    //  ПОЛОЖЕНИЕ АРБИТРА ОДНИМ ЧТЕНИЕМ (задача 9, 15 августа 2026)
    //
    //  getArbiterStanding — один вызов вместо семи-восьми. Нужен фронту и
    //  внешнему читателю: собирать это семью отдельными запросами нельзя —
    //  между ними проходят блоки, и картинка расходится сама с собой (залог
    //  прочитан до сноса, а статус после).
    // ============================================================

    /// Смещения полей, нужных getArbiterStanding, но недоступных вызывающему
    /// через собственные функции ArbiterAccountabilityFacet: arbiterMistakeStreak/
    /// arbiterBond/seatedBy/openClaimCount/cleanVerdicts/removedAt живут в
    /// ArbiterRegistryStorage (той же raw-хранилищной модели, что и
    /// suspendedUntil выше — SLOT_SUSPENDED_UNTIL = 27), а xp/cleanStreak — в
    /// ReputationStorage, чужом неймспейсе. Добыты перебором (offset 0..40 /
    /// 0..15, запись маркера в кандидатный слот, чтение через сам
    /// getArbiterStanding как оракул: он использует именованные поля
    /// структуры, слот считает компилятор, ошибиться может только перебор
    /// снаружи) — одноразовый зонд прогнан и удалён, как предписано.
    bytes32 constant REP_BASE            = 0xa32193c5e38bd2de27c8550f156d709eafdc63aaa4290e5e27473f2ffc097400;
    uint256 constant SLOT_MISTAKE_STREAK = 11;
    uint256 constant SLOT_BOND           = 12;
    uint256 constant SLOT_OPEN_CLAIMS    = 13;
    uint256 constant SLOT_SEATED_BY      = 25;
    uint256 constant SLOT_CLEAN_VERDICTS = 28;
    uint256 constant SLOT_REMOVED_AT     = 31;
    uint256 constant SLOT_XP             = 0;
    uint256 constant SLOT_CLEAN_STREAK   = 9;

    /// Вечная запись о сносах (п. 72, 16 августа 2026) — дописана в конец
    /// структуры, значит её смещения идут следом за removedAt (31). Числа
    /// выведены счётом полей И проверены поведенчески тут же: при неверном
    /// смещении vm.store молча пишет в чужое поле, и assertEq на своё число
    /// в test_StandingDistinguishesEveryField падает.
    uint256 constant SLOT_REMOVAL_COUNT       = 32;
    uint256 constant SLOT_LAST_REMOVAL_AT     = 33;
    uint256 constant SLOT_LAST_REMOVAL_CAUSE  = 34;

    function _storeUint(bytes32 base, uint256 offset, address who, uint256 value) internal {
        bytes32 slot = keccak256(abi.encode(who, uint256(base) + offset));
        vm.store(address(acc), slot, bytes32(value));
    }

    /// Ветка из брифа задачи 9: положение только что приостановленного
    /// арбитра, остальное — нули лёгкого стенда по умолчанию. Расширена
    /// тремя полями, которых не было в брифе (cleanVerdicts, removedAt,
    /// hasLiveRemovalProposal) — бриф писался до того, как они появились в
    /// хранилище (см. докстринг getArbiterStanding в самом фасете).
    function test_StandingReturnsEverythingAtOnce() public {
        acc.suspendArbiter(arbiter);

        (
            uint256 xp,
            uint256 cleanStreak,
            uint256 mistakeStreak,
            uint256 bond,
            address seatedBy,
            uint256 suspendedUntil,
            uint256 openClaims,
            uint256 cleanVerdicts,
            uint256 removedAt,
            bool    hasLiveRemovalProposal,
            uint256 removalCount,
            uint256 lastRemovalAt,
            uint8   lastRemovalCause
        ) = acc.getArbiterStanding(arbiter);

        assertEq(xp, 0);
        assertEq(cleanStreak, 0);
        assertEq(mistakeStreak, 0);
        assertEq(bond, 0, unicode"за ручным арбитром залога нет — и это видно");
        assertEq(seatedBy, address(0));
        assertEq(suspendedUntil, vm.getBlockTimestamp() + 72 hours, unicode"приостановка видна тут же");
        assertEq(openClaims, 0);
        assertEq(cleanVerdicts, 0, unicode"судейского стажа ещё нет");
        assertEq(removedAt, 0, unicode"не снимали — ноль, а не мусор");
        assertFalse(hasLiveRemovalProposal, unicode"предложения о сносе не было");
        assertEq(removalCount, 0, unicode"не снимали ни разу — ноль, а не мусор");
        assertEq(lastRemovalAt, 0, unicode"момента прошлого сноса нет");
        assertEq(lastRemovalCause, 0, unicode"ноль означает «не снимали», а не Cause номер ноль");
    }

    /// Мутационная проба: КАЖДОЕ числовое/адресное поле получает своё
    /// уникальное значение — подмена любого одного поля другим (например,
    /// вернуть bond там, где должен быть cleanVerdicts) обязана уронить ровно
    /// свой assertEq и никакой другой. hasLiveRemovalProposal — булево, у
    /// него нет "своего числа" для подмены; прямая (захардкожен true) и
    /// обратная (захардкожен false) порча ловятся здесь и в
    /// test_StandingReturnsEverythingAtOnce одновременно: там ожидается
    /// false, здесь — true.
    function test_StandingDistinguishesEveryField() public {
        _storeUint(REP_BASE, SLOT_XP, arbiter, 501);
        _storeUint(REP_BASE, SLOT_CLEAN_STREAK, arbiter, 502);
        _storeUint(ARB_BASE, SLOT_MISTAKE_STREAK, arbiter, 503);
        _storeUint(ARB_BASE, SLOT_BOND, arbiter, 504);
        _storeUint(ARB_BASE, SLOT_SEATED_BY, arbiter, uint256(uint160(address(0xBEEF))));
        _storeUint(ARB_BASE, SLOT_OPEN_CLAIMS, arbiter, 506);
        _storeUint(ARB_BASE, SLOT_CLEAN_VERDICTS, arbiter, 507);
        _storeUint(ARB_BASE, SLOT_REMOVED_AT, arbiter, 508);
        _storeUint(ARB_BASE, SLOT_REMOVAL_COUNT, arbiter, 509);
        _storeUint(ARB_BASE, SLOT_LAST_REMOVAL_AT, arbiter, 510);
        // Повод — uint8, в 509/510 он не влезает, поэтому свой маркер из того
        // же ряда, но в диапазоне типа: 211 не совпадает ни с одним настоящим
        // поводом (1..6) и не попадает в диапазон автоснятия (252..255 =
        // AUTO_REMOVAL_BASE + DemotionPath). Константы AUTO_REMOVAL_CODE, на
        // которую ссылалась прежняя редакция этой строки, больше нет — её
        // заменила база в уборке 7а, п. 1; само утверждение верным быть не
        // перестало, врала только ссылка.
        _storeUint(ARB_BASE, SLOT_LAST_REMOVAL_CAUSE, arbiter, 211);

        // suspendedUntil — через боевой вызов, а не маркер: значение (t0 + 72h)
        // уже отличается от всех восьми маркеров выше на любом разумном t0.
        acc.suspendArbiter(arbiter);
        uint256 expectedSuspendedUntil = vm.getBlockTimestamp() + 72 hours;

        // hasLiveRemovalProposal — тоже боевым вызовом: Collusion не проверяется
        // цепью, поэтому proposeRemoval не трогает arbiterMistakeStreak (503
        // выше остаётся нетронутым) и требует только ненулевой отпечаток.
        vm.prank(chief);
        acc.proposeRemoval(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, bytes32(uint256(0xC0FFEE)));

        (
            uint256 xp,
            uint256 cleanStreak,
            uint256 mistakeStreak,
            uint256 bond,
            address seatedBy,
            uint256 suspendedUntil,
            uint256 openClaims,
            uint256 cleanVerdicts,
            uint256 removedAt,
            bool    hasLiveRemovalProposal,
            uint256 removalCount,
            uint256 lastRemovalAt,
            uint8   lastRemovalCause
        ) = acc.getArbiterStanding(arbiter);

        assertEq(xp, 501, "xp");
        assertEq(cleanStreak, 502, "cleanStreak");
        assertEq(mistakeStreak, 503, "mistakeStreak");
        assertEq(bond, 504, "bond");
        assertEq(seatedBy, address(0xBEEF), "seatedBy");
        assertEq(suspendedUntil, expectedSuspendedUntil, "suspendedUntil");
        assertEq(openClaims, 506, "openClaims");
        assertEq(cleanVerdicts, 507, "cleanVerdicts");
        assertEq(removedAt, 508, "removedAt");
        assertTrue(hasLiveRemovalProposal, "hasLiveRemovalProposal");
        assertEq(removalCount, 509, unicode"поле сносов отдаёт своё число");
        assertEq(lastRemovalAt, 510, unicode"поле момента отдаёт своё");
        assertEq(lastRemovalCause, uint8(211), unicode"поле повода отдаёт своё");
    }
}
