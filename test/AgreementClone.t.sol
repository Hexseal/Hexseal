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
}
