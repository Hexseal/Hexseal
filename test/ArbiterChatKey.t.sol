// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";
import {ArbiterAccountabilityFacet} from "../src/facets/ArbiterAccountabilityFacet.sol";
import {ArbiterTwoFacetBench} from "./ArbiterTwoFacetBench.sol";
import {FactoryStorage} from "../src/FactoryFacet.sol";
import {MinimalForwarder} from "../src/MinimalForwarder.sol";

contract ArbiterChatKeyTest is Test, ArbiterTwoFacetBench {
    /// Оба хендла указывают на ОДИН адрес — прокси с обоими фасетами
    /// (см. test/ArbiterTwoFacetBench.sol). `facet` оставлен под прежним
    /// именем нарочно: все vm.store(address(facet), ...) ниже продолжают
    /// бить в то же самое хранилище.
    ArbiterRegistryFacet facet;
    ArbiterAccountabilityFacet accFacet;

    function setUp() public {
        (facet, accFacet) = _deployArbiterBench();
    }

    /// Ключей нет — обе половины нули. Отдельный тест, потому что «нет ключа»
    /// и «ключ нулевой» для читателя одно и то же, и это намеренно: 4в считает
    /// нулевой ключ признаком «предъявлять некому».
    function test_ChatKeysEmptyByDefault() public view {
        (bytes32 box, bytes32 sign) = accFacet.getArbiterChatKeys(address(0xBEEF));
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

        (bytes32 gotBox, bytes32 gotSign) = accFacet.getArbiterChatKeys(arb);
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

        (bytes32 bBox, bytes32 bSign) = accFacet.getArbiterChatKeys(b);
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

        (bytes32 box, bytes32 sign) = accFacet.getArbiterChatKeys(arb);
        assertEq(box, bytes32(uint256(0x33)));
        assertEq(sign, bytes32(uint256(0x44)));
    }

    bytes32 constant CHAT_KEY_SET_TOPIC = keccak256("ArbiterChatKeySet(address,bytes32,bytes32)");

    function _countChatKeySetEvents(Vm.Log[] memory logs) internal pure returns (uint256 n) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == CHAT_KEY_SET_TOPIC) n++;
        }
    }

    /// Итоговое ревью, правка 5 (амплификация через событие): одинаковая
    /// перезапись НЕ излучает ArbiterChatKeySet. Следующая часть (4в)
    /// предъявляет заново ПО СОБЫТИЮ — без этого условия арбитр с N открытыми
    /// спорами, беря спор N+1 обычным (тем же) ключом, посылал бы N
    /// бессмысленных повторных предъявлений: полное перешифрование и
    /// перезалив каждой переписки на склад, бесплатно для него самого.
    ///
    /// Что исчезнет из поведения, если снять правку: событие полетит и на
    /// байт-в-байт идентичную перезапись — ровно та амплификация, которую
    /// замысел уже поймал в опросе цепи (8 100 обращений в час, см. комментарий
    /// у ArbiterChatKeySet) и закрыл, а здесь она вернулась бы через другую
    /// дверь.
    function test_SetChatKey_NoEventOnIdenticalRewrite() public {
        address arb = address(0xA1);
        _makeArbiter(arb);
        bytes32 box  = bytes32(uint256(0x11));
        bytes32 sign = bytes32(uint256(0x22));

        vm.prank(arb);
        facet.setArbiterChatKey(box, sign);

        vm.recordLogs();
        vm.prank(arb);
        facet.setArbiterChatKey(box, sign); // те же значения — no-op по смыслу
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(
            _countChatKeySetEvents(logs), 0,
            unicode"одинаковая перезапись не должна излучать ArbiterChatKeySet"
        );
        // Запись при этом всё равно на месте — идемпотентность, не отказ записи.
        (bytes32 gotBox, bytes32 gotSign) = accFacet.getArbiterChatKeys(arb);
        assertEq(gotBox, box);
        assertEq(gotSign, sign);
    }

    /// Симметрия предыдущего теста: РЕАЛЬНО изменённая перезапись обязана
    /// излучать событие ровно один раз — иначе замок test_SetChatKey_NoEventOnIdenticalRewrite
    /// прошёл бы и в мире, где событие не летит вообще никогда (замок сторожил
    /// бы текст условия, а не поведение).
    function test_SetChatKey_EmitsEventWhenValueActuallyChanges() public {
        address arb = address(0xA1);
        _makeArbiter(arb);

        vm.prank(arb);
        facet.setArbiterChatKey(bytes32(uint256(0x11)), bytes32(uint256(0x22)));

        vm.recordLogs();
        vm.prank(arb);
        facet.setArbiterChatKey(bytes32(uint256(0x33)), bytes32(uint256(0x22))); // boxKey меняется
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(
            _countChatKeySetEvents(logs), 1,
            unicode"изменённая перезапись обязана излучать ArbiterChatKeySet ровно один раз"
        );
    }

    // ============================================================
    //  ЧЕРЕЗ НАСТОЯЩИЙ ФОРВАРДЕР (ERC-2771)
    // ============================================================
    //
    // Все шесть тестов выше зовут facet.setArbiterChatKey(...) напрямую под
    // vm.prank — в этом окружении trustedForwarder не выставлен, поэтому
    // _msgSender() возвращает msg.sender, и подмена _msgSender() → msg.sender
    // внутри функции никак не отличалась бы по их зелёному цвету. Ровно тот
    // же класс бага уже был у fundDispute (см. CLAUDE.md, фикс d172064) —
    // платный вызов арбитра не срабатывал ни разу, потому что читал
    // msg.sender, а прямые тесты этого не ловили. Единственный путь, которым
    // арбитр реально публикует ключ — гейслесс, через релеер: если функция
    // прочитает msg.sender, ключ запишется на адрес форвардера, арбитр решит,
    // что опубликовал его, а стороны запечатают предъявление в пустоту.
    // Образец сетапа (сигнатура ForwardRequest, EIP-712 домен) —
    // test/DisputeSettlement.t.sol:1782-1857.

    bytes32 constant FWD_TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data)"
    );

    /// Смещение trustedForwarder внутри FactoryStorage.Layout — 3 слота от
    /// базы (usdc(0), feeRecipient(1), regionFee(2, mapping — свой слот),
    /// trustedForwarder(3)). То же смещение, что уже утверждено и
    /// используется в test/BoardsFixture.sol (комментарий там же). Пишем
    /// напрямую в слот фасета, потому что здесь нет диамонда и initFactory —
    /// facet развёрнут отдельно, как и во всех остальных тестах файла.
    function _setTrustedForwarder(address forwarder) internal {
        bytes32 slot = bytes32(uint256(FactoryStorage.FACTORY_STORAGE_POSITION) + 3);
        vm.store(address(facet), slot, bytes32(uint256(uint160(forwarder))));
        // Не берём смещение на веру: если раскладка Layout когда-нибудь
        // уедет, тест должен упасть здесь с понятной причиной, а не молча
        // писать в чужое поле и потом гадать, почему подпись «не сработала».
        assertEq(
            address(uint160(uint256(vm.load(address(facet), slot)))),
            forwarder,
            unicode"смещение trustedForwarder в FactoryStorage.Layout уехало"
        );
    }

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

    /// Замер ревью: setArbiterChatKey, вызванный через настоящий
    /// MinimalForwarder, должен записать ключ ЧЕЛОВЕКУ, который подписал
    /// ForwardRequest, а не адресу форвардера, который физически сделал
    /// msg.sender-вызов на facet. Отправляет execute() ТРЕТИЙ адрес (не
    /// арбитр, не форвардер) — ровно так это устроено в проде: релеер платит
    /// газ, но не является ни подписантом, ни получателем.
    ///
    /// Второе утверждение (нули на адресе форвардера) обязательно: оно и
    /// отличает «прочитали человека» от «прочитали посыльного» — без него
    /// тест прошёл бы и в мире, где _msgSender() тихо вернул бы что угодно,
    /// лишь бы на этом адресе потом лежали какие-то ключи.
    function test_SetChatKey_ThroughRealForwarder_RecordsHumanNotForwarder() public {
        uint256 arbiterPk = 0xCA11;
        address arb = vm.addr(arbiterPk);
        address relayer = address(0x9999); // третий адрес: не арбитр, не форвардер
        _makeArbiter(arb);

        MinimalForwarder fwd = new MinimalForwarder();
        _setTrustedForwarder(address(fwd));

        bytes32 box  = bytes32(uint256(0x77));
        bytes32 sign = bytes32(uint256(0x88));
        bytes memory data = abi.encodeWithSelector(ArbiterRegistryFacet.setArbiterChatKey.selector, box, sign);

        MinimalForwarder.ForwardRequest memory req = MinimalForwarder.ForwardRequest({
            from:  arb,
            to:    address(facet),
            value: 0,
            gas:   500_000,
            nonce: fwd.getNonce(arb),
            data:  data
        });
        bytes memory sig = _signFwd(fwd, arbiterPk, req);

        vm.prank(relayer);
        (bool ok, bytes memory ret) = fwd.execute(req, sig);
        assertTrue(ok, string.concat("forwarded setArbiterChatKey failed: ", vm.toString(ret)));

        (bytes32 gotBox, bytes32 gotSign) = accFacet.getArbiterChatKeys(arb);
        assertEq(gotBox, box, unicode"ключ должен быть записан подписанту, а не форвардеру");
        assertEq(gotSign, sign, unicode"ключ должен быть записан подписанту, а не форвардеру");

        (bytes32 fwdBox, bytes32 fwdSign) = accFacet.getArbiterChatKeys(address(fwd));
        assertEq(fwdBox, bytes32(0), unicode"ключ утёк на адрес форвардера вместо человека");
        assertEq(fwdSign, bytes32(0), unicode"ключ утёк на адрес форвардера вместо человека");
    }

    /// Заявка обязана возить ключи и записывать их. Проверяется на уровне
    /// подписи: тест не скомпилируется, если аргументов нет.
    function test_ClaimDispute_HasKeyArguments() public {
        // Достаточно того, что вызов с четырьмя аргументами компилируется и
        // отваливается на проверке арбитра, а не на форме вызова.
        vm.prank(address(0xDEAD));
        vm.expectRevert(ArbiterRegistryFacet.NotArbiter.selector);
        facet.claimDispute(
            address(0xA9),
            bytes32(uint256(1)),
            bytes32(uint256(0x11)),
            bytes32(uint256(0x22))
        );
    }

    /// Нулевой ключ в заявке отвергается той же ошибкой, что в setArbiterChatKey:
    /// два входа, одно правило.
    function test_ClaimDispute_RejectsZeroKey() public {
        address arb = address(0xA1);
        _makeArbiter(arb);
        vm.prank(arb);
        vm.expectRevert(ArbiterRegistryFacet.ZeroChatKey.selector);
        facet.claimDispute(address(0xA9), bytes32(uint256(1)), bytes32(0), bytes32(uint256(0x22)));
    }

    /// Успешный клейм обязан ЗАПИСАТЬ ключи, а не только принять их формой
    /// аргумента. Замок на регрессию: «ключ — обязательный аргумент» без
    /// записи означает, что арбитр заявился, ключ уехал в calldata и пропал,
    /// а стороны по-прежнему предъявляют переписку в пустоту — ровно та дыра,
    /// ради закрытия которой заводилась вся задача.
    function test_ClaimDispute_WritesKeys() public {
        address arb = address(0xA1);
        _makeArbiter(arb);

        MockDisputedAgreement agr = new MockDisputedAgreement(address(0xC1), address(0xE1));

        bytes32 salt = bytes32(uint256(0x9));
        bytes32 commitment = keccak256(abi.encodePacked(address(agr), arb, salt));
        vm.prank(arb);
        facet.commitDisputeClaim(commitment);
        vm.roll(block.number + 1);

        bytes32 box  = bytes32(uint256(0x33));
        bytes32 sign = bytes32(uint256(0x44));
        vm.prank(arb);
        facet.claimDispute(address(agr), salt, box, sign);

        (bytes32 gotBox, bytes32 gotSign) = accFacet.getArbiterChatKeys(arb);
        assertEq(gotBox, box, unicode"успешный клейм не записал boxKey");
        assertEq(gotSign, sign, unicode"успешный клейм не записал signKey");
    }

    /// commit+roll+claim в отдельном хелпере, а не инлайном дважды в теле
    /// теста: тот же приём, что test/Diamond.t.sol::_claimDisputeAs — вызов
    /// одной и той же последовательности ВТОРОЙ раз инлайном в одной функции
    /// теста под этим репозиторием (via_ir) наблюдался как «второй
    /// vm.roll(block.number + 1) не берётся», хотя тот же паттерн через
    /// вызов функции-хелпера работает штатно.
    function _commitAndClaim(MockDisputedAgreement agr, address arb, bytes32 salt, bytes32 box, bytes32 sign) internal {
        bytes32 commitment = keccak256(abi.encodePacked(address(agr), arb, salt));
        vm.prank(arb);
        facet.commitDisputeClaim(commitment);
        uint256 nextBlock = block.number + 1;
        vm.roll(nextBlock);
        vm.prank(arb);
        facet.claimDispute(address(agr), salt, box, sign);
    }

    /// Итоговое ревью, правка 5: клейм ВТОРОГО спора тем же ключом, что уже
    /// записан за арбитром, не излучает ArbiterChatKeySet повторно. Прямое
    /// продолжение амплификации из задания: арбитр с N открытыми спорами,
    /// беря спор N+1 обычным ключом устройства (а не новым), не должен
    /// заставлять 4в перешифровывать и перезаливать N уже открытых переписок.
    function test_ClaimDispute_NoEventWhenKeySameAsAlreadyRecorded() public {
        address arb = address(0xA1);
        _makeArbiter(arb);

        MockDisputedAgreement agr1 = new MockDisputedAgreement(address(0xC1), address(0xE1));
        MockDisputedAgreement agr2 = new MockDisputedAgreement(address(0xC2), address(0xE2));

        bytes32 box  = bytes32(uint256(0x33));
        bytes32 sign = bytes32(uint256(0x44));

        _commitAndClaim(agr1, arb, bytes32(uint256(0x9)), box, sign); // первый клейм — ключ новый, событие летит

        vm.recordLogs();
        _commitAndClaim(agr2, arb, bytes32(uint256(0xA)), box, sign); // тот же ключ, второй спор
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(
            _countChatKeySetEvents(logs), 0,
            unicode"клейм вторым спором с тем же ключом не должен переизлучать ArbiterChatKeySet"
        );

        // DisputeClaimed при этом обязан лететь — условие только вокруг
        // ArbiterChatKeySet, не вокруг всей функции.
        bytes32 disputeClaimedTopic = keccak256("DisputeClaimed(address,address)");
        bool sawDisputeClaimed;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == disputeClaimedTopic) sawDisputeClaimed = true;
        }
        assertTrue(sawDisputeClaimed, unicode"DisputeClaimed обязан лететь при каждом клейме");
    }

    /// Симметрия предыдущего теста: клейм с ДРУГИМ ключом обязан излучать
    /// событие — иначе предыдущий замок прошёл бы и в мире, где
    /// ArbiterChatKeySet из claimDispute не летит вообще никогда.
    function test_ClaimDispute_EmitsEventWhenKeyDiffersFromRecorded() public {
        address arb = address(0xA1);
        _makeArbiter(arb);

        MockDisputedAgreement agr1 = new MockDisputedAgreement(address(0xC1), address(0xE1));
        MockDisputedAgreement agr2 = new MockDisputedAgreement(address(0xC2), address(0xE2));

        _commitAndClaim(agr1, arb, bytes32(uint256(0x9)), bytes32(uint256(0x33)), bytes32(uint256(0x44)));

        vm.recordLogs();
        _commitAndClaim(agr2, arb, bytes32(uint256(0xA)), bytes32(uint256(0x55)), bytes32(uint256(0x44))); // новый boxKey
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(
            _countChatKeySetEvents(logs), 1,
            unicode"смена ключа на клейме обязана излучать ArbiterChatKeySet ровно один раз"
        );
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

/// Минимальная заглушка Agreement — ровно то подмножество интерфейса, которое
/// claimDispute() опрашивает staticcall'ами (status/disputedAt/DISPUTE_WINDOW/
/// client/executor) и вызывает (setArbiter). Живёт в статусе DISPUTED(4) с
/// открытым окном спора с момента деплоя.
contract MockDisputedAgreement {
    uint8 public constant status = 4; // Agreement.Status.DISPUTED
    uint256 public disputedAt;
    uint256 public constant DISPUTE_WINDOW = 3 days;
    address public client;
    address public executor;
    address public arbiter;

    constructor(address _client, address _executor) {
        client = _client;
        executor = _executor;
        disputedAt = block.timestamp;
    }

    function setArbiter(address newArbiter) external {
        arbiter = newArbiter;
    }
}
