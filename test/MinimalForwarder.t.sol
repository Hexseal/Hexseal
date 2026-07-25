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

/// Возвращает гигантский буфер — модель return-bomb.
contract Bomb {
    function boom() external pure {
        assembly {
            // 200_000 байт нулей
            return(0, 200000)
        }
    }
}

contract MinimalForwarderTest is Test {
    MinimalForwarder forwarder;
    Echo2771 echo;
    Bomb bomb;

    uint256 constant USER_PK = 0xA11CE;
    address user;

    bytes32 constant TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data)"
    );

    function setUp() public {
        forwarder = new MinimalForwarder();
        echo = new Echo2771();
        bomb = new Bomb();
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
        (bool ok,) = forwarder.execute(req, _sign(USER_PK, req));
        assertTrue(ok);
        assertEq(echo.lastSender(), user);
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
            _req(address(bomb), 0, abi.encodeWithSelector(Bomb.boom.selector));
        (bool ok, bytes memory ret) = forwarder.execute(req, _sign(USER_PK, req));
        assertTrue(ok);
        assertLe(ret.length, 4096, "returndata not capped");
    }
}
