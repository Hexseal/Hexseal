// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/Agreement.sol";
import "../src/AgreementDeployer.sol";
import "../src/MinimalForwarder.sol";

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

    /// Печатает фактическую стоимость создания сделки (число идёт в отчёт и
    /// в пересчёт модели казны) и одновременно сторожит регресс: порог взят
    /// с большим запасом над измеренными 278 355, но на порядок ниже
    /// прежних ~4 400 000. Если кто-то вернёт полноценный CREATE — упадёт.
    function testCloneDeployStaysCheap() public {
        uint256 before = gasleft();
        _deploy();
        uint256 used = before - gasleft();
        emit log_named_uint("gas: clone + initialize", used);
        assertLt(used, 400_000, "deal creation is no longer clone-cheap");
    }
}

// ---------- MOCK USDC ----------

contract MockUSDCClone {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Сквозной гейслесс-путь: настоящий MinimalForwarder → клон Agreement.
///
/// Зачем отдельный тест. С переходом на EIP-1167 trustedForwarder переехал из
/// кода реализации (immutable) в хранилище клона, а ERC-2771 держится на том,
/// что 20-байтовый суффикс отправителя, дописанный форвардером в конец
/// calldata, доезжает до реализации через delegatecall прокси. Держится он на
/// рантайме EIP-1167 (`36 3d 3d 37` — calldatacopy всей calldata), но ни один
/// тест этого не проверял: во всех диамонд-сетапах trustedForwarder — это
/// address(0xDEAD), а test/MinimalForwarder.t.sol бьёт по моку Echo2771, а не
/// по клону. Ближайшее, что было, — testCloneCarriesAllInitParams, но он
/// сверяет только записанный адрес форвардера, не работу _msgSender().
///
/// Ломается это молча: например, при переходе на Clones.cloneWithImmutableArgs,
/// который дописывает свои аргументы в конец той же calldata и столкнётся
/// ровно с этой конвенцией — _msgSender() начнёт возвращать хвост аргументов
/// вместо адреса подписанта, и любое действие стороны сделки будет отвергнуто
/// как «не клиент».
contract AgreementCloneGaslessTest is Test {
    MinimalForwarder  forwarder;
    Agreement         impl;
    AgreementDeployer deployer;
    MockUSDCClone     usdc;

    address constant CALLER  = address(0xCA11E4);
    address constant DIAMOND = address(0xD1A);
    uint256 constant AMOUNT  = 1_000_000;

    uint256 constant CLIENT_PK   = 0xC11;
    uint256 constant EXECUTOR_PK = 0xE8E;
    uint256 constant STRANGER_PK = 0xBAD;
    address client;
    address executor;
    address stranger;

    Agreement agr;

    bytes32 constant TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data)"
    );

    function setUp() public {
        forwarder = new MinimalForwarder();
        usdc      = new MockUSDCClone();
        impl      = new Agreement();
        deployer  = new AgreementDeployer(CALLER, address(impl));

        client   = vm.addr(CLIENT_PK);
        executor = vm.addr(EXECUTOR_PK);
        stranger = vm.addr(STRANGER_PK);

        vm.prank(CALLER);
        agr = Agreement(deployer.deploy(
            client, executor, address(0),
            AMOUNT, 7, "terms",
            DIAMOND, address(usdc), address(forwarder), DIAMOND
        ));

        usdc.mint(client, AMOUNT);
        vm.prank(client);
        usdc.approve(address(agr), AMOUNT);
    }

    function _sign(uint256 pk, MinimalForwarder.ForwardRequest memory req)
        internal view returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(
            TYPEHASH, req.from, req.to, req.value, req.gas, req.nonce, keccak256(req.data)
        ));
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",
            keccak256(abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("MinimalForwarder")),
                keccak256(bytes("0.0.1")),
                block.chainid,
                address(forwarder)
            )),
            structHash
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// execute() не ревертит на провале внутреннего вызова — она возвращает
    /// (false, revertData). Поэтому success приходится читать возвратом,
    /// а не полагаться на отсутствие реверта.
    function _relay(uint256 pk, bytes memory data)
        internal returns (bool success, bytes memory retdata)
    {
        address from = vm.addr(pk);
        MinimalForwarder.ForwardRequest memory req = MinimalForwarder.ForwardRequest({
            from:  from,
            to:    address(agr),
            value: 0,
            gas:   1_000_000,
            nonce: forwarder.getNonce(from),
            data:  data
        });
        return forwarder.execute(req, _sign(pk, req));
    }

    /// fund() — самая показательная проверка: она и сверяет _msgSender() с
    /// client, и тянет USDC именно с него. Если бы суффикс не доехал,
    /// _msgSender() вернул бы адрес форвардера и вызов упал бы на NotClient.
    function testGaslessFundThroughForwarderReachesClone() public {
        (bool ok, ) = _relay(CLIENT_PK, abi.encodeWithSelector(Agreement.fund.selector));
        assertTrue(ok, "forwarded fund() failed inside the clone");

        assertEq(agr.fundedAt(), block.timestamp, "agr not funded");
        assertEq(usdc.balanceOf(address(agr)), AMOUNT, "USDC pulled from the wrong account");
        assertEq(usdc.balanceOf(client), 0, "client was not the payer");
        assertEq(agr.ownerOf(1), client,   "client NFT");
        assertEq(agr.ownerOf(2), executor, "executor NFT");
        assertEq(uint8(agr.status()), uint8(Agreement.Status.FUNDED), "status");
    }

    /// Вторая сторона, второй нонс: суффикс распознаётся не только для того
    /// адреса, что деплоил сделку.
    function testGaslessActivateThroughForwarderReachesClone() public {
        (bool funded, ) = _relay(CLIENT_PK, abi.encodeWithSelector(Agreement.fund.selector));
        assertTrue(funded, "setup: fund failed");

        (bool ok, ) = _relay(EXECUTOR_PK, abi.encodeWithSelector(Agreement.activate.selector));
        assertTrue(ok, "forwarded activate() failed inside the clone");

        assertEq(agr.activatedAt(), block.timestamp, "agr not activated");
        assertEq(uint8(agr.status()), uint8(Agreement.Status.ACTIVE), "status");
    }

    /// Негативный контроль: без него тест выше прошёл бы и в мире, где
    /// _msgSender() возвращает что угодно, лишь бы совпало с client.
    /// Посторонний подписант через тот же форвардер должен получить отказ.
    function testGaslessCallFromStrangerIsRejectedByTheClone() public {
        (bool ok, bytes memory retdata) =
            _relay(STRANGER_PK, abi.encodeWithSelector(Agreement.fund.selector));

        assertFalse(ok, "clone accepted a forwarded call from a non-party");
        assertEq(bytes4(retdata), Agreement.NotClient.selector, "wrong revert reason");
        assertEq(agr.fundedAt(), 0, "agr must stay unfunded");
    }

    /// Прямой вызов мимо форвардера по-прежнему работает от самой стороны —
    /// проверка ERC-2771 не должна была сломать обычный путь через кошелёк
    /// (он же фолбэк фронта, когда релеер недоступен).
    function testDirectCallStillWorksAlongsideTheForwarder() public {
        vm.prank(client);
        agr.fund();
        assertEq(agr.fundedAt(), block.timestamp, "direct fund() broken");
    }
}
