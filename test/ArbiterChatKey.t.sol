// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";

contract ArbiterChatKeyTest is Test {
    ArbiterRegistryFacet facet;

    function setUp() public {
        facet = new ArbiterRegistryFacet();
    }

    /// Ключей нет — обе половины нули. Отдельный тест, потому что «нет ключа»
    /// и «ключ нулевой» для читателя одно и то же, и это намеренно: 4в считает
    /// нулевой ключ признаком «предъявлять некому».
    function test_ChatKeysEmptyByDefault() public view {
        (bytes32 box, bytes32 sign) = facet.getArbiterChatKeys(address(0xBEEF));
        assertEq(box, bytes32(0), unicode"boxKey должен быть нулевым");
        assertEq(sign, bytes32(0), unicode"signKey должен быть нулевым");
    }
}
