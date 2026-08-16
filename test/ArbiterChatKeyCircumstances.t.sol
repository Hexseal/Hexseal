// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Пять вопросов проекта про обстоятельства (docs/PROCESS.md), применённые к
// setArbiterChatKey(). Правило дословно: «"Почини вот это" выполняется
// формально. "Докажи замером, что стало иначе" — нет.» Каждый тест ниже —
// замер, а не рассуждение: он проверяет состояние ПОСЛЕ события, а не факт,
// что функция была вызвана.
//
// Пятый вопрос проекта — «диск кончился: вернули ошибку или упали целиком?» —
// у контракта прямого аналога не имеет и намеренно НЕ тестируется здесь как
// «кончилось место». У Diamond Storage нет диска и нет места, которое
// кончается постепенно: кончается только газ, а обрыв по газу на любой
// строке отменяет ВСЮ транзакцию целиком (EVM это гарантирует сама, это не
// свойство нашего кода, и придумывать тест на газ значило бы тестировать
// EVM, а не setArbiterChatKey()). Настоящий аналог вопроса «вернули ошибку
// или упали целиком?» в этой системе — «неудачная запись обязана оставить
// прежнее состояние нетронутым, а не половину новой записи» — и это ровно
// test_FailedKeyChange_LeavesOldKeyAlive ниже (замер №1). Он же закрывает
// вопрос честно: частичной записи здесь физически не бывает (два поля
// пишутся в одном вызове, который либо целиком выполняется, либо целиком
// откатывается), но что «отказ не портит рабочий ключ» — утверждение,
// которое обязано быть замерено, а не объявлено верным по конструкции EVM.
import "forge-std/Test.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";
import {ArbiterAccountabilityFacet} from "../src/facets/ArbiterAccountabilityFacet.sol";
import {ArbiterTwoFacetBench} from "./ArbiterTwoFacetBench.sol";

contract ArbiterChatKeyCircumstancesTest is Test, ArbiterTwoFacetBench {
    /// Оба хендла указывают на ОДИН адрес — прокси с обоими фасетами
    /// (см. test/ArbiterTwoFacetBench.sol). `facet` оставлен под прежним
    /// именем нарочно: все vm.store(address(facet), ...) ниже продолжают
    /// бить в то же самое хранилище.
    ArbiterRegistryFacet facet;
    ArbiterAccountabilityFacet accFacet;

    function setUp() public { (facet, accFacet) = _deployArbiterBench(); }

    function _makeArbiter(address who) internal {
        bytes32 pos = 0xaae71de0594cbcb5434f0ab7f7501c1be178552bf788b418a1c2624ba9718d00;
        vm.store(address(facet), keccak256(abi.encode(who, uint256(pos))), bytes32(uint256(1)));
        // Проверка обязательна: при неверном слоте посадка молча не срабатывает,
        // и все пять замеров ниже начали бы падать на NotArbiter, а читались бы
        // как «обстоятельства проверены».
        assertTrue(facet.isRegisteredArbiter(who), unicode"не удалось посадить арбитра");
    }

    /// 1. БРОСИЛ НА СЕРЕДИНЕ — и это самый дорогой из пяти случаев.
    ///    У арбитра ЕСТЬ рабочий ключ, он затевает смену устройства и на
    ///    полпути присылает мусор (вторая половина нулевая). Отказ обязан
    ///    оставить ПРЕЖНИЙ ключ целым.
    ///
    ///    Почему это дорого: арбитр без ключа не читает предъявленное, а
    ///    молчание мы толкуем против молчащего. Значит неудачная смена ключа,
    ///    затирающая рабочий, превратила бы промах пальцем в проигранный спор.
    ///    Замер: после отказа читаются РОВНО прежние 0x11/0x22.
    function test_FailedKeyChange_LeavesOldKeyAlive() public {
        address arb = address(0xA1);
        _makeArbiter(arb);

        vm.prank(arb);
        facet.setArbiterChatKey(bytes32(uint256(0x11)), bytes32(uint256(0x22)));

        vm.prank(arb);
        vm.expectRevert(ArbiterRegistryFacet.ZeroChatKey.selector);
        facet.setArbiterChatKey(bytes32(uint256(0x99)), bytes32(0));

        (bytes32 box, bytes32 sign) = accFacet.getArbiterChatKeys(arb);
        assertEq(box,  bytes32(uint256(0x11)), unicode"неудачная смена затёрла рабочий ключ");
        assertEq(sign, bytes32(uint256(0x22)), unicode"неудачная смена затёрла рабочий ключ");
    }

    /// 2. ПРИШЁЛ МУСОР: нулевой ключ в любой половине. Ожидается ВЕРДИКТ
    ///    (именованная ошибка), а не тихая запись и не падение.
    function test_Garbage_GivesVerdictNotSilence() public {
        address arb = address(0xA1);
        _makeArbiter(arb);
        vm.prank(arb);
        vm.expectRevert(ArbiterRegistryFacet.ZeroChatKey.selector);
        facet.setArbiterChatKey(bytes32(0), bytes32(0));
    }

    /// 3. ДВА ПРОЦЕССА РАЗОМ: два арбитра пишут в одном блоке. Ожидается — не
    ///    подрались, у каждого своё. Замер числами.
    function test_TwoAtOnce_DoNotCollide() public {
        address a = address(0xA1);
        address b = address(0xB2);
        _makeArbiter(a); _makeArbiter(b);

        vm.prank(a); facet.setArbiterChatKey(bytes32(uint256(0xA0)), bytes32(uint256(0xA1)));
        vm.prank(b); facet.setArbiterChatKey(bytes32(uint256(0xB0)), bytes32(uint256(0xB1)));

        (bytes32 aBox,) = accFacet.getArbiterChatKeys(a);
        (bytes32 bBox,) = accFacet.getArbiterChatKeys(b);
        assertEq(aBox, bytes32(uint256(0xA0)));
        assertEq(bBox, bytes32(uint256(0xB0)));
    }

    /// 4. ДОЛБЯТ НАРОЧНО: сто перезаписей подряд. Вопрос проекта — «кому
    ///    больно, ему или соседу?» — про ДВЕ стороны, не про одну. Первая
    ///    половина: должнику (он платит газ каждый раз, состояние сходится к
    ///    последней записи — газ на одну запись из --gas-report идёт в
    ///    отчёт). Вторая половина, ради которой этот тест переписан: сосед —
    ///    второй арбитр, чьи ключи записаны ДО долбёжки первого — обязан
    ///    остаться нетронутым ни на бит после всех ста перезаписей чужих
    ///    ключей. Без этой половины замер отвечает только «больно ему», не
    ///    проверив «не больно соседу».
    function test_Hammering_HurtsOnlySender() public {
        address arb = address(0xA1);
        _makeArbiter(arb);

        // Сосед: ключи записаны один раз, до начала долбёжки первого арбитра.
        address neighbor = address(0xB2);
        _makeArbiter(neighbor);
        bytes32 neighborBoxBefore  = bytes32(uint256(0xDEAD));
        bytes32 neighborSignBefore = bytes32(uint256(0xBEEF));
        vm.prank(neighbor);
        facet.setArbiterChatKey(neighborBoxBefore, neighborSignBefore);

        for (uint256 i = 1; i <= 100; i++) {
            vm.prank(arb);
            facet.setArbiterChatKey(bytes32(i), bytes32(i + 1000));
        }

        (bytes32 box, bytes32 sign) = accFacet.getArbiterChatKeys(arb);
        assertEq(box, bytes32(uint256(100)));
        assertEq(sign, bytes32(uint256(1100)));

        // Сосед не задет: ни на один бит, несмотря на сто чужих записей.
        (bytes32 neighborBoxAfter, bytes32 neighborSignAfter) = accFacet.getArbiterChatKeys(neighbor);
        assertEq(neighborBoxAfter,  neighborBoxBefore,  unicode"долбёжка первого арбитра задела ключ соседа");
        assertEq(neighborSignAfter, neighborSignBefore, unicode"долбёжка первого арбитра задела ключ соседа");
    }

    /// 5. ПЕРЕЗАПУСК/ПОВТОР: запись идемпотентна по результату — тот же ключ
    ///    дважды даёт то же состояние, а не ошибку. Арбитр, нажавший дважды,
    ///    не должен получить отказ.
    function test_SameKeyTwice_IsNotAnError() public {
        address arb = address(0xA1);
        _makeArbiter(arb);
        vm.prank(arb); facet.setArbiterChatKey(bytes32(uint256(7)), bytes32(uint256(8)));
        vm.prank(arb); facet.setArbiterChatKey(bytes32(uint256(7)), bytes32(uint256(8)));
        (bytes32 box,) = accFacet.getArbiterChatKeys(arb);
        assertEq(box, bytes32(uint256(7)));
    }
}
