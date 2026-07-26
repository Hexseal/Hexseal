// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/Agreement.sol";
import "../src/AgreementDeployer.sol";

contract AgreementCloneTest is Test {
    Agreement         impl;
    AgreementDeployer deployer;

    address constant CALLER    = address(0xCA11E4);
    address constant CLIENT    = address(0xC11E17);
    address constant EXECUTOR  = address(0xE8EC);
    address constant DIAMOND   = address(0xD1A);
    address constant USDC      = address(0x05DC);
    address constant FORWARDER = address(0xF04D);

    function setUp() public {
        impl     = new Agreement();
        deployer = new AgreementDeployer(CALLER, address(impl));
    }

    function _deploy() internal returns (address) {
        vm.prank(CALLER);
        return deployer.deploy(
            CLIENT, EXECUTOR, address(0),
            1_000_000, 7, "terms",
            DIAMOND, USDC, FORWARDER, DIAMOND
        );
    }

    function testCloneCarriesAllInitParams() public {
        Agreement a = Agreement(_deploy());

        assertEq(a.client(),       CLIENT,    "client");
        assertEq(a.executor(),     EXECUTOR,  "executor");
        assertEq(a.arbiter(),      address(0), "arbiter starts unset");
        assertEq(a.amount(),       1_000_000, "amount");
        assertEq(a.deadlineDays(), 7,         "deadlineDays");
        assertEq(a.terms(),        "terms",   "terms");
        assertEq(a.diamond(),      DIAMOND,   "diamond");
        assertEq(a.usdc(),         USDC,      "usdc");
        assertEq(a.factory(),      DIAMOND,   "factory");
        assertEq(a.trustedForwarder(), FORWARDER, "trustedForwarder");
        assertEq(uint8(a.status()), uint8(Agreement.Status.CREATED), "status");
        assertEq(a.name(),   "Hexseal Deal", "name");
        assertEq(a.symbol(), "HSEAL",        "symbol");
    }

    /// Клон — 45 байт EIP-1167, а не копия двадцатикилобайтного агримента.
    function testCloneIsMinimalProxy() public {
        assertEq(_deploy().code.length, 45, "clone is not a 45-byte EIP-1167 proxy");
    }

    /// Повторный вызов на уже инициализированном клоне.
    function testInitializeRevertsOnSecondCall() public {
        Agreement a = Agreement(_deploy());
        vm.expectRevert(Agreement.AlreadyInitialized.selector);
        a.initialize(
            address(0xBAD), address(0xBAD2), address(0),
            1, 1, "hijack",
            DIAMOND, USDC, FORWARDER, DIAMOND
        );
    }

    /// Посторонний не может переинициализировать чужую сделку — проверка
    /// стража не зависит от того, кто вызывает.
    function testStrangerCannotReinitialize() public {
        Agreement a = Agreement(_deploy());
        vm.prank(address(0xDEAD));
        vm.expectRevert(Agreement.AlreadyInitialized.selector);
        a.initialize(
            address(0xBAD), address(0xBAD2), address(0),
            1, 1, "hijack",
            DIAMOND, USDC, FORWARDER, DIAMOND
        );
    }

    /// Сам контракт-реализация заперт в конструкторе: у него собственное
    /// хранилище, и без замка посторонний стал бы его «клиентом».
    function testImplementationIsLocked() public {
        vm.expectRevert(Agreement.AlreadyInitialized.selector);
        impl.initialize(
            address(0xBAD), address(0xBAD2), address(0),
            1, 1, "hijack",
            DIAMOND, USDC, FORWARDER, DIAMOND
        );
    }

    /// Реализация без кода отвергается на конструкторе деплойера. Иначе
    /// Clones.clone() создал бы прокси в никуда, initialize() вернул бы
    /// успех (вызов к адресу без кода в EVM успешен), и сделка оказалась бы
    /// пустой скорлупой, доступной для захвата.
    function testDeployerRejectsCodelessImplementation() public {
        vm.expectRevert("AgreementDeployer: implementation has no code");
        new AgreementDeployer(CALLER, address(0xC0DE1E55));
    }

    /// _initReentrancyGuard() не имеет наблюдаемого эффекта: модификатор
    /// сравнивает только с ENTERED, поэтому клон со _status == 0 ведёт себя
    /// так же. Значит удаление этой строки не уронило бы ни один тест.
    /// Читаем слот напрямую — иначе мера против тихой поломки сама введена тихо.
    function testReentrancyGuardIsInitialized() public {
        address clone = _deploy();
        assertEq(
            uint256(vm.load(clone, bytes32(uint256(4)))),
            1,
            "reentrancy guard left uninitialized"
        );
    }
}
