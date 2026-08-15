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

contract ArbiterSuspensionTest is Test {
    ArbiterAccountabilityFacet acc;
    ArbiterRegistryFacet reg;

    address owner;
    address chief;
    address arbiter;
    address stranger;

    bytes32 constant ARB_BASE = 0xaae71de0594cbcb5434f0ab7f7501c1be178552bf788b418a1c2624ba9718d00;
    bytes32 constant OWNER_SLOT = 0x178642b411f9f4783b21ef338f3e96db6c1272d763f0b7500ec93464dafb8604;

    function setUp() public {
        // Оба фасета разворачиваются отдельно, но пишут в ОДИН неймспейс,
        // поэтому в лёгком стенде состояние у каждого своё. Тесты этой задачи
        // трогают только счётчик приостановки, и он живёт в acc.
        acc = new ArbiterAccountabilityFacet();
        reg = new ArbiterRegistryFacet();

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

        bytes32 salt = bytes32(uint256(7));
        vm.prank(arbiter);
        reg.commitDisputeClaim(keccak256(abi.encodePacked(address(agreement), arbiter, salt)));
        vm.roll(block.number + 1);

        vm.prank(arbiter);
        reg.claimDispute(address(agreement), salt, bytes32(uint256(1)), bytes32(uint256(2)));

        vm.prank(arbiter);
        reg.submitVerdict(address(agreement), true);

        uint256 until = vm.getBlockTimestamp() + 72 hours;
        _suspendInReg(arbiter, until);

        vm.expectRevert(
            abi.encodeWithSelector(ArbiterRegistryFacet.ArbiterSuspendedError.selector, until)
        );
        reg.finalizeVerdict(address(agreement));
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

    function test_SuspendedUntilSlotMatchesLiveStorage() public {
        _suspendInReg(arbiter, 12345);
        assertEq(acc.getSuspendedUntil(arbiter), 0, unicode"это другой контракт, ноль ожидаем");
        // Сверяем через тот же контракт, в который писали:
        vm.store(address(acc), keccak256(abi.encode(arbiter, uint256(bytes32(uint256(ARB_BASE) + SLOT_SUSPENDED_UNTIL)))), bytes32(uint256(12345)));
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

        bytes32 salt = bytes32(uint256(11));
        vm.prank(arbiter);
        reg.commitDisputeClaim(keccak256(abi.encodePacked(address(agreement), arbiter, salt)));
        vm.roll(block.number + 1);

        vm.prank(arbiter);
        reg.claimDispute(address(agreement), salt, bytes32(uint256(1)), bytes32(uint256(2)));

        vm.prank(arbiter);
        reg.submitVerdict(address(agreement), true);

        assertEq(reg.getCleanVerdicts(arbiter), 0, unicode"до финализации стажа нет");

        vm.warp(vm.getBlockTimestamp() + 24 hours);
        reg.finalizeVerdict(address(agreement));

        assertEq(reg.getCleanVerdicts(arbiter), 1, unicode"неперевёрнутый вердикт добавил стаж");
    }

    function _makeArbiter(ArbiterAccountabilityFacet f, address who) internal {
        vm.store(address(f), keccak256(abi.encode(who, uint256(ARB_BASE))), bytes32(uint256(1)));
    }

    /// chiefArbiter — шестое поле Data (индекс 5), обычная переменная, не мэппинг.
    /// Раньше сверялось вызовом acc.getChiefArbiterAddress() — тестового геттера,
    /// снятого в задаче 5 (добавление 2): он дублировал уже существующий
    /// ArbiterRegistryFacet.getChiefArbiter(), а через прокси-даймонд оба
    /// селектора всё равно идут на один и тот же адрес. Теперь сверяем прямым
    /// чтением слота — постоянный публичный селектор ради теста не заводим.
    function _setChief(ArbiterAccountabilityFacet f, address who) internal {
        bytes32 slot = bytes32(uint256(ARB_BASE) + 5);
        vm.store(address(f), slot, bytes32(uint256(uint160(who))));
        bytes32 raw = vm.load(address(f), slot);
        assertEq(address(uint160(uint256(raw))), who, unicode"смещение слота chiefArbiter уехало");
    }
}
