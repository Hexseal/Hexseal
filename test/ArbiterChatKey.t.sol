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

    /// Арбитр записывает свои ключи и читает их обратно.
    function test_SetChatKey_WritesOwnKeys() public {
        address arb = address(0xA1);
        _makeArbiter(arb);
        bytes32 box  = bytes32(uint256(0x11));
        bytes32 sign = bytes32(uint256(0x22));

        vm.prank(arb);
        facet.setArbiterChatKey(box, sign);

        (bytes32 gotBox, bytes32 gotSign) = facet.getArbiterChatKeys(arb);
        assertEq(gotBox, box);
        assertEq(gotSign, sign);
    }

    /// Нулевой ключ отвергается: он неотличим от «ключей нет», и записать его
    /// значило бы объявить себя готовым принимать предъявления, не умея их
    /// прочитать.
    function test_SetChatKey_RejectsZero() public {
        address arb = address(0xA1);
        _makeArbiter(arb);

        vm.prank(arb);
        vm.expectRevert(ArbiterRegistryFacet.ZeroChatKey.selector);
        facet.setArbiterChatKey(bytes32(0), bytes32(uint256(0x22)));

        vm.prank(arb);
        vm.expectRevert(ArbiterRegistryFacet.ZeroChatKey.selector);
        facet.setArbiterChatKey(bytes32(uint256(0x11)), bytes32(0));
    }

    /// Не арбитр записать не может: реестр — не общая доска объявлений.
    function test_SetChatKey_OnlyArbiter() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(ArbiterRegistryFacet.NotArbiter.selector);
        facet.setArbiterChatKey(bytes32(uint256(0x11)), bytes32(uint256(0x22)));
    }

    /// Записать можно ТОЛЬКО себе: аргумента «кому» нет вовсе, адрес берётся
    /// из отправителя. Замок на то, что аргумент не появится.
    function test_SetChatKey_WritesOnlyForSender() public {
        address a = address(0xA1);
        address b = address(0xB2);
        _makeArbiter(a);
        _makeArbiter(b);

        vm.prank(a);
        facet.setArbiterChatKey(bytes32(uint256(0xAA)), bytes32(uint256(0xAB)));

        (bytes32 bBox, bytes32 bSign) = facet.getArbiterChatKeys(b);
        assertEq(bBox, bytes32(0), unicode"запись арбитра A попала арбитру B");
        assertEq(bSign, bytes32(0), unicode"запись арбитра A попала арбитру B");
    }

    /// СОБЫТИЕ ОБЯЗАТЕЛЬНО. Без него 4в придётся опрашивать цепь, а 9 августа
    /// мы убрали 8 100 обращений к цепи в час с одной вкладки (пункт 38
    /// открытых вопросов) — новый опрос вернул бы ту же беду под другим именем.
    function test_SetChatKey_EmitsEvent() public {
        address arb = address(0xA1);
        _makeArbiter(arb);
        bytes32 box  = bytes32(uint256(0x11));
        bytes32 sign = bytes32(uint256(0x22));

        vm.expectEmit(true, false, false, true);
        emit ArbiterRegistryFacet.ArbiterChatKeySet(arb, box, sign);
        vm.prank(arb);
        facet.setArbiterChatKey(box, sign);
    }

    /// Перезапись разрешена и обязана менять значение: у арбитра ключ живёт на
    /// устройстве, и смена телефона иначе оставила бы стороны запечатывать
    /// предъявление в мёртвый ключ.
    function test_SetChatKey_Overwrites() public {
        address arb = address(0xA1);
        _makeArbiter(arb);

        vm.prank(arb);
        facet.setArbiterChatKey(bytes32(uint256(0x11)), bytes32(uint256(0x22)));
        vm.prank(arb);
        facet.setArbiterChatKey(bytes32(uint256(0x33)), bytes32(uint256(0x44)));

        (bytes32 box, bytes32 sign) = facet.getArbiterChatKeys(arb);
        assertEq(box, bytes32(uint256(0x33)));
        assertEq(sign, bytes32(uint256(0x44)));
    }

    /// Садит арбитра прямо в хранилище фасета. `applyAsArbiter()` заперт за
    /// `isDaoActive()` (ArbiterRegistryFacet.sol:293), а ДАО намеренно не
    /// запущено — решение владельца 1 августа. Тест не должен зависеть от
    /// способа посадки.
    function _makeArbiter(address who) internal {
        // POSITION хранилища + слот mapping isArbiter (первое поле Data).
        bytes32 pos = 0xaae71de0594cbcb5434f0ab7f7501c1be178552bf788b418a1c2624ba9718d00;
        bytes32 slot = keccak256(abi.encode(who, uint256(pos)));
        vm.store(address(facet), slot, bytes32(uint256(1)));
        assertTrue(facet.isRegisteredArbiter(who), unicode"не удалось посадить арбитра");
    }
}
