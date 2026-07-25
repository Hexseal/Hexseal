// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/MinimalForwarder.sol";

/// Возвращает последние 20 байт calldata — то есть адрес, который ERC-2771
/// форвардер дописывает в хвост. Так проверяем сам механизм 2771.
contract Echo2771 {
    address public lastSender;
    uint256 public lastValue;

    function ping() external payable returns (address) {
        address sender;
        assembly {
            sender := shr(96, calldataload(sub(calldatasize(), 20)))
        }
        lastSender = sender;
        lastValue = msg.value;
        return sender;
    }
}

/// Возвращает буфер заданного размера — параметризованная модель
/// return-bomb. Размер варьируется аргументом, а не отдельными контрактами,
/// чтобы в газ-дифференциальном тесте (L4) сравнивать маленький и большой
/// возврат при прочих равных.
contract Bomb {
    function boom(uint256 size) external pure {
        assembly {
            return(0, size)
        }
    }
}

/// Именованная кастомная ошибка, которой ревертит `Reverter` ниже —
/// нужна тесту F-3, чтобы проверить, что `retdata` содержит именно её,
/// а не просто непустой буфер.
error MockRevertError(uint256 code);

/// Всегда ревертит заданной кастомной ошибкой — отдельный моковый колли
/// для теста F-3 (путь провала внутреннего вызова), не переиспользует
/// Echo2771/Bomb, у которых другое назначение.
contract Reverter {
    function explode(uint256 code) external pure {
        revert MockRevertError(code);
    }
}

contract MinimalForwarderTest is Test {
    MinimalForwarder forwarder;
    Echo2771 echo;
    Bomb bomb;
    Reverter reverter;

    uint256 constant USER_PK = 0xA11CE;
    address user;

    bytes32 constant TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data)"
    );

    function setUp() public {
        forwarder = new MinimalForwarder();
        echo = new Echo2771();
        bomb = new Bomb();
        reverter = new Reverter();
        user = vm.addr(USER_PK);
        vm.deal(user, 100 ether);
        vm.deal(address(this), 100 ether);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("MinimalForwarder")),
            keccak256(bytes("0.0.1")),
            block.chainid,
            address(forwarder)
        ));
    }

    function _sign(uint256 pk, MinimalForwarder.ForwardRequest memory req)
        internal view returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(
            TYPEHASH, req.from, req.to, req.value, req.gas, req.nonce, keccak256(req.data)
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _req(address to, uint256 value, bytes memory data)
        internal view returns (MinimalForwarder.ForwardRequest memory)
    {
        return MinimalForwarder.ForwardRequest({
            from:  user,
            to:    to,
            value: value,
            gas:   1_000_000,
            nonce: forwarder.getNonce(user),
            data:  data
        });
    }

    // ── verify ────────────────────────────────────────────────────────────

    function testVerifyAcceptsValidSignature() public view {
        MinimalForwarder.ForwardRequest memory req =
            _req(address(echo), 0, abi.encodeWithSelector(Echo2771.ping.selector));
        assertTrue(forwarder.verify(req, _sign(USER_PK, req)));
    }

    function testVerifyRejectsForeignSignature() public view {
        MinimalForwarder.ForwardRequest memory req =
            _req(address(echo), 0, abi.encodeWithSelector(Echo2771.ping.selector));
        assertFalse(forwarder.verify(req, _sign(0xB0B, req)));
    }

    function testExecuteRevertsOnForeignSignature() public {
        MinimalForwarder.ForwardRequest memory req =
            _req(address(echo), 0, abi.encodeWithSelector(Echo2771.ping.selector));
        vm.expectRevert("MinimalForwarder: signature does not match request");
        forwarder.execute(req, _sign(0xB0B, req));
    }

    // ── ERC-2771 суффикс ──────────────────────────────────────────────────

    function testAppendsOriginalSenderToCalldata() public {
        MinimalForwarder.ForwardRequest memory req =
            _req(address(echo), 0, abi.encodeWithSelector(Echo2771.ping.selector));
        (bool ok, bytes memory ret) = forwarder.execute(req, _sign(USER_PK, req));
        assertTrue(ok);
        assertEq(echo.lastSender(), user);
        // Возврат самого echo (адрес sender) должен дойти до вызывающего
        // форвардера нетронутым — ловит порчу destination при ручном копировании.
        assertEq(abi.decode(ret, (address)), user);
    }

    // ── nonce / replay ────────────────────────────────────────────────────

    function testNonceIncrementsOnExecute() public {
        MinimalForwarder.ForwardRequest memory req =
            _req(address(echo), 0, abi.encodeWithSelector(Echo2771.ping.selector));
        assertEq(forwarder.getNonce(user), 0);
        forwarder.execute(req, _sign(USER_PK, req));
        assertEq(forwarder.getNonce(user), 1);
    }

    function testReplayRejected() public {
        MinimalForwarder.ForwardRequest memory req =
            _req(address(echo), 0, abi.encodeWithSelector(Echo2771.ping.selector));
        bytes memory sig = _sign(USER_PK, req);
        forwarder.execute(req, sig);
        vm.expectRevert("MinimalForwarder: nonce mismatch");
        forwarder.execute(req, sig);
    }

    // ── H2: msg.value должен совпадать с req.value ────────────────────────

    function testExecuteRevertsWhenMsgValueBelowReqValue() public {
        MinimalForwarder.ForwardRequest memory req =
            _req(address(echo), 1 ether, abi.encodeWithSelector(Echo2771.ping.selector));
        vm.expectRevert("MinimalForwarder: value mismatch");
        forwarder.execute{value: 0}(req, _sign(USER_PK, req));
    }

    function testExecuteRevertsWhenMsgValueAboveReqValue() public {
        MinimalForwarder.ForwardRequest memory req =
            _req(address(echo), 0, abi.encodeWithSelector(Echo2771.ping.selector));
        vm.expectRevert("MinimalForwarder: value mismatch");
        forwarder.execute{value: 1 ether}(req, _sign(USER_PK, req));
    }

    function testExecuteForwardsMatchingValue() public {
        MinimalForwarder.ForwardRequest memory req =
            _req(address(echo), 1 ether, abi.encodeWithSelector(Echo2771.ping.selector));
        (bool ok,) = forwarder.execute{value: 1 ether}(req, _sign(USER_PK, req));
        assertTrue(ok);
        assertEq(echo.lastValue(), 1 ether);
    }

    /// Ядро H2: без проверки msg.value осевший на форвардере ETH выводится
    /// самоподписанным запросом с value > 0 и msg.value == 0.
    function testCannotDrainForwarderBalance() public {
        vm.deal(address(forwarder), 5 ether);
        MinimalForwarder.ForwardRequest memory req =
            _req(address(echo), 5 ether, abi.encodeWithSelector(Echo2771.ping.selector));
        vm.expectRevert("MinimalForwarder: value mismatch");
        forwarder.execute{value: 0}(req, _sign(USER_PK, req));
        assertEq(address(forwarder).balance, 5 ether);
    }

    // ── L4: return bomb ───────────────────────────────────────────────────

    function testReturndataIsCapped() public {
        MinimalForwarder.ForwardRequest memory req =
            _req(address(bomb), 0, abi.encodeWithSelector(Bomb.boom.selector, uint256(200_000)));
        (bool ok, bytes memory ret) = forwarder.execute(req, _sign(USER_PK, req));
        assertTrue(ok);
        // Точное равенство, а не "<=": иначе испорченный destination
        // (например обнулённая длина) тоже прошёл бы проверку.
        assertEq(ret.length, 4096, "returndata not capped to expected size");
    }

    /// Ядро L4, газовое измерение. До фикса `.call(...)` на уровне Solidity
    /// тянет за собой стандартный хелпер компилятора, который копирует ВЕСЬ
    /// ответ вызываемого контракта в память форвардера ещё до того, как мы
    /// успеваем его закапить (см. дизассемблинг в отчёте) — эта копия растёт
    /// квадратично с размером ответа и сжигает газ релеера сверх капа. После
    /// фикса (сырой CALL в assembly с нулевым выходным буфером) форвардер
    /// сам ничего не копирует до капа, поэтому разница в газе между большим
    /// и маленьким возвратом объясняется только собственным исполнением
    /// bomb-контракта (расширение памяти в ЕГО фрейме под req.gas), а не
    /// работой форвардера.
    function testReturndataCopyGasDoesNotScaleWithBombSize() public {
        uint256 smallSize = 32;
        uint256 largeSize = 200_000;

        MinimalForwarder.ForwardRequest memory reqSmall =
            _req(address(bomb), 0, abi.encodeWithSelector(Bomb.boom.selector, smallSize));
        bytes memory sigSmall = _sign(USER_PK, reqSmall);
        uint256 gasBeforeSmall = gasleft();
        forwarder.execute(reqSmall, sigSmall);
        uint256 gasUsedSmall = gasBeforeSmall - gasleft();

        MinimalForwarder.ForwardRequest memory reqLarge =
            _req(address(bomb), 0, abi.encodeWithSelector(Bomb.boom.selector, largeSize));
        bytes memory sigLarge = _sign(USER_PK, reqLarge);
        uint256 gasBeforeLarge = gasleft();
        forwarder.execute(reqLarge, sigLarge);
        uint256 gasUsedLarge = gasBeforeLarge - gasleft();

        // Порог между «дельта объясняется только исполнением bomb» (после
        // фикса) и «дельта включает ещё и лишнюю полную копию ответа внутри
        // форвардера» (до фикса, кратно больше) — конкретные числа в отчёте.
        assertLt(
            gasUsedLarge - gasUsedSmall,
            140_000,
            "returndata copy gas scales with bomb size"
        );
    }

    // ── F-3: провал внутреннего вызова ──────────────────────────────────────

    /// Вспомогательное: отбрасывает первые 4 байта (селектор) буфера, чтобы
    /// декодировать оставшийся ABI-payload кастомной ошибки через abi.decode.
    function _dropSelector(bytes memory data) internal pure returns (bytes memory out) {
        out = new bytes(data.length - 4);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = data[i + 4];
        }
    }

    /// ХАРАКТЕРИЗАЦИОННЫЙ тест: `execute()` осознанно НЕ ревертит, когда
    /// вложенный вызов проваливается — жжёт nonce, эмитит
    /// `Executed(from, to, false)` и кладёт revert-данные вызванного
    /// контракта в `retdata`. На это поведение опирается
    /// `frontend/src/app/api/relay/route.ts`: он симулирует `execute()`
    /// именно для того, чтобы отличить "execute вернулся нормально, но
    /// success == false" от настоящего успеха, и разбирает `retdata`, чтобы
    /// показать пользователю название конкретной ошибки, а не общий "Call
    /// failed". Если когда-нибудь захочется "починить" execute() так, чтобы
    /// он сам ревертил при провале вложенного вызова — это сломает симуляцию
    /// на фронте. Этот тест фиксирует текущее поведение, чтобы такое
    /// изменение не проскочило незамеченным.
    function testExecuteDoesNotRevertOnInnerCallFailure() public {
        uint256 code = 1337;
        MinimalForwarder.ForwardRequest memory req =
            _req(address(reverter), 0, abi.encodeWithSelector(Reverter.explode.selector, code));
        bytes memory sig = _sign(USER_PK, req);

        uint256 nonceBefore = forwarder.getNonce(user);

        vm.expectEmit(true, true, false, true);
        emit MinimalForwarder.Executed(user, address(reverter), false);

        (bool ok, bytes memory retdata) = forwarder.execute(req, sig);

        assertFalse(ok, "execute() must report inner-call failure via success == false, not revert");
        assertEq(forwarder.getNonce(user), nonceBefore + 1, "nonce must be consumed even when inner call fails");

        // retdata должен быть ИМЕННО revert-данными Reverter.explode(code),
        // а не просто непустым буфером — сравниваем побайтово с ожидаемой
        // ABI-кодировкой кастомной ошибки...
        assertEq(retdata, abi.encodeWithSelector(MockRevertError.selector, code), "retdata does not match callee's revert data");

        // ...и дополнительно декодируем селектор и payload по отдельности.
        bytes4 selector;
        assembly {
            selector := mload(add(retdata, 32))
        }
        assertEq(selector, MockRevertError.selector, "retdata selector mismatch");
        uint256 decodedCode = abi.decode(_dropSelector(retdata), (uint256));
        assertEq(decodedCode, code, "retdata payload mismatch");
    }
}
