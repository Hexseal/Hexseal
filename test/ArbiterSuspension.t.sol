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

    function _makeArbiter(ArbiterAccountabilityFacet f, address who) internal {
        vm.store(address(f), keccak256(abi.encode(who, uint256(ARB_BASE))), bytes32(uint256(1)));
    }

    /// chiefArbiter — шестое поле Data (индекс 5), обычная переменная, не мэппинг.
    function _setChief(ArbiterAccountabilityFacet f, address who) internal {
        vm.store(address(f), bytes32(uint256(ARB_BASE) + 5), bytes32(uint256(uint160(who))));
        assertEq(f.getChiefArbiterAddress(), who, unicode"смещение слота chiefArbiter уехало");
    }
}
