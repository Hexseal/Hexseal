// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/Treasury.sol";

contract MockUSDCT {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "insufficient");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Диамонд в объёме, который нужен казне: банк, флаг ДАО, счётчик
/// пользователей и адрес ДАО. Позволяет ставить их в любое состояние.
contract MockDiamond {
    address public usdc;
    uint256 public vaultBalance;
    bool    public daoActive;
    uint256 public uniqueActiveUsers;
    address public dao;

    constructor(address usdc_) { usdc = usdc_; }

    function setVaultBalance(uint256 v)      external { vaultBalance = v; }
    function setDaoActive(bool v)            external { daoActive = v; }
    function setUniqueActiveUsers(uint256 v) external { uniqueActiveUsers = v; }
    function setDao(address v)               external { dao = v; }

    function fundVault(uint256 amount) external {
        MockUSDCT(usdc).transferFrom(msg.sender, address(this), amount);
        vaultBalance += amount;
    }

    function getVaultBalance()       external view returns (uint256) { return vaultBalance; }
    function isDaoActive()           external view returns (bool)    { return daoActive; }
    function getUniqueActiveUsers()  external view returns (uint256) { return uniqueActiveUsers; }
    function getDAOAddress()         external view returns (address) { return dao; }
}

contract TreasuryTest is Test {
    MockUSDCT   usdc;
    MockDiamond diamond;
    Treasury    treasury;

    address constant FOUNDATION = address(0xF00D);

    function setUp() public {
        usdc     = new MockUSDCT();
        diamond  = new MockDiamond(address(usdc));
        treasury = new Treasury(address(usdc), address(diamond), FOUNDATION);
    }

    /// Банк уже полон — первая ступень не берёт ничего, остаток делится 70/30.
    function testDistributeSplitsSeventyThirtyWhenVaultIsFull() public {
        diamond.setVaultBalance(treasury.VAULT_TARGET());
        usdc.mint(address(treasury), 1_000_000_000); // 1000 USDC

        treasury.distribute();

        assertEq(usdc.balanceOf(FOUNDATION),        700_000_000, "foundation share");
        assertEq(treasury.reserveBalance(),         300_000_000, "reserve share");
        assertEq(diamond.getVaultBalance(),         treasury.VAULT_TARGET(), "vault must not grow past target");
        assertEq(treasury.pendingDistribution(),    0, "nothing may stay undistributed");
    }

    /// Банк пуст — первая ступень забирает недостающее до цели ЦЕЛИКОМ,
    /// и только остаток делится. Буфер — абсолютная величина, а не доля.
    function testVaultBufferIsFilledBeforeAnySplit() public {
        diamond.setVaultBalance(0);
        usdc.mint(address(treasury), 1_000_000_000);

        treasury.distribute();

        uint256 target = treasury.VAULT_TARGET();
        assertEq(diamond.getVaultBalance(), target, "vault not filled to target");

        uint256 rest = 1_000_000_000 - target;
        assertEq(usdc.balanceOf(FOUNDATION), rest * 70 / 100, "foundation share of the remainder");
        assertEq(treasury.reserveBalance(),  rest - rest * 70 / 100, "reserve share of the remainder");
    }

    /// Приход меньше, чем не хватает банку — всё уходит в банк, делить нечего.
    function testSmallIncomeGoesEntirelyToTheVault() public {
        diamond.setVaultBalance(0);
        usdc.mint(address(treasury), 10_000_000); // 10 USDC

        treasury.distribute();

        assertEq(diamond.getVaultBalance(),   10_000_000, "vault should have taken all of it");
        assertEq(usdc.balanceOf(FOUNDATION),  0,          "foundation must get nothing");
        assertEq(treasury.reserveBalance(),   0,          "reserve must get nothing");
    }

    /// После активации ДАО доли меняются местами, и ничего больше.
    function testSplitFlipsToTwentyEightyWhenDaoIsActive() public {
        diamond.setVaultBalance(treasury.VAULT_TARGET());
        diamond.setDaoActive(true);
        usdc.mint(address(treasury), 1_000_000_000);

        treasury.distribute();

        assertEq(usdc.balanceOf(FOUNDATION), 200_000_000, "foundation share after DAO");
        assertEq(treasury.reserveBalance(),  800_000_000, "reserve share after DAO");
    }

    /// Распределять нечего — вызов ревертит, а не тратит газ впустую.
    function testDistributeRevertsWhenNothingPending() public {
        vm.expectRevert(Treasury.NothingToDistribute.selector);
        treasury.distribute();
    }

    /// Сторожит ОТСУТСТВИЕ ограничения, а не его наличие: упадёт, если кто-то
    /// однажды «на всякий случай» повесит на distribute() владельца. Соседние
    /// тесты этого не поймают — они зовут из тест-контракта, который стал бы
    /// владельцем. Отсутствие гейта здесь — решение, и его надо пиннить.
    function testAnyoneCanTriggerDistribution() public {
        diamond.setVaultBalance(treasury.VAULT_TARGET());
        usdc.mint(address(treasury), 1_000_000_000);

        vm.prank(address(0xBEEF));
        treasury.distribute();

        assertEq(usdc.balanceOf(FOUNDATION), 700_000_000, "stranger's call must distribute identically");
    }

    /// Второй вызов подряд не находит новых денег — двойного распределения нет.
    function testSecondDistributeFindsNothing() public {
        diamond.setVaultBalance(treasury.VAULT_TARGET());
        usdc.mint(address(treasury), 1_000_000_000);
        treasury.distribute();

        vm.expectRevert(Treasury.NothingToDistribute.selector);
        treasury.distribute();
    }

    /// Резерв лежит на казне и НЕ попадает в следующее распределение повторно.
    function testReserveIsNotRedistributed() public {
        diamond.setVaultBalance(treasury.VAULT_TARGET());
        usdc.mint(address(treasury), 1_000_000_000);
        treasury.distribute();
        assertEq(treasury.reserveBalance(), 300_000_000, "setup");

        usdc.mint(address(treasury), 100_000_000);
        treasury.distribute();

        // Второй приход 100 делится 70/30, резерв прирастает на 30, а не делится сам.
        assertEq(usdc.balanceOf(FOUNDATION), 700_000_000 + 70_000_000, "foundation");
        assertEq(treasury.reserveBalance(),  300_000_000 + 30_000_000, "reserve");
    }

    /// Нулевые адреса в конструкторе не проходят.
    function testConstructorRejectsZeroAddresses() public {
        vm.expectRevert(Treasury.ZeroAddress.selector);
        new Treasury(address(0), address(diamond), FOUNDATION);

        vm.expectRevert(Treasury.ZeroAddress.selector);
        new Treasury(address(usdc), address(0), FOUNDATION);

        vm.expectRevert(Treasury.ZeroAddress.selector);
        new Treasury(address(usdc), address(diamond), address(0));
    }

    /// Диамонд без кода не проходит: казна будет звать его fundVault, а вызов
    /// к адресу без кода в EVM возвращает УСПЕХ — деньги ушли бы в никуда,
    /// а банк бы не наполнился.
    function testConstructorRejectsCodelessDiamond() public {
        vm.expectRevert(Treasury.NoCode.selector);
        new Treasury(address(usdc), address(0xC0DE1E55), FOUNDATION);
    }
}
