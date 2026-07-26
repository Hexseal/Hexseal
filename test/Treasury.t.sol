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

/// Диамонд, который пытается реентерить treasury.distribute() изнутри
/// собственного fundVault(). Перехватывает исход попытки через try/catch,
/// чтобы наружный fundVault(amount) не откатился целиком из-за реентранси —
/// так тест может отдельно проверить (а) что реентрантный вызов упал именно
/// с Treasury.Reentrancy, и (б) что банк всё равно корректно
/// профинансировался ровно один раз, без двойного распределения.
contract ReentrantDiamondT {
    address public usdc;
    uint256 public vaultBalance;
    bool    public daoActive;
    address public treasury;
    bool    public attack;

    bool    public reentryAttempted;
    bool    public reentrySucceeded;
    bytes4  public reentryRevertSelector;

    constructor(address usdc_) { usdc = usdc_; }

    function setTreasury(address t) external { treasury = t; }
    function setVaultBalance(uint256 v) external { vaultBalance = v; }
    function setDaoActive(bool v)       external { daoActive = v; }
    function setAttack(bool v)          external { attack = v; }

    function fundVault(uint256 amount) external {
        MockUSDCT(usdc).transferFrom(msg.sender, address(this), amount);
        vaultBalance += amount;

        if (attack) {
            reentryAttempted = true;
            try Treasury(treasury).distribute() {
                reentrySucceeded = true;
            } catch (bytes memory reason) {
                reentrySucceeded = false;
                if (reason.length >= 4) {
                    bytes4 sel;
                    assembly { sel := mload(add(reason, 32)) }
                    reentryRevertSelector = sel;
                }
            }
        }
    }

    function getVaultBalance()      external view returns (uint256) { return vaultBalance; }
    function isDaoActive()          external view returns (bool)    { return daoActive; }
    function getUniqueActiveUsers() external pure returns (uint256) { return 0; }
    function getDAOAddress()        external pure returns (address) { return address(0); }
}

/// Диамонд, который забирает МЕНЬШЕ запрошенного из fundVault (не ревертит,
/// просто тянет actuallyTake вместо amount). Проверяет, что казна учитывает
/// реально ушедшее, а не запрошенное.
contract PartialFundDiamondT {
    address public usdc;
    uint256 public vaultBalance;
    bool    public daoActive;
    uint256 public actuallyTake;

    constructor(address usdc_) { usdc = usdc_; }

    function setVaultBalance(uint256 v) external { vaultBalance = v; }
    function setDaoActive(bool v)       external { daoActive = v; }
    function setActuallyTake(uint256 v) external { actuallyTake = v; }

    function fundVault(uint256 amount) external {
        uint256 take = actuallyTake < amount ? actuallyTake : amount;
        if (take > 0) {
            MockUSDCT(usdc).transferFrom(msg.sender, address(this), take);
        }
        vaultBalance += take;
    }

    function getVaultBalance()      external view returns (uint256) { return vaultBalance; }
    function isDaoActive()          external view returns (bool)    { return daoActive; }
    function getUniqueActiveUsers() external pure returns (uint256) { return 0; }
    function getDAOAddress()        external pure returns (address) { return address(0); }
}

/// Диамонд, у которого fundVault всегда ревертит — имитирует момент, когда
/// казну заменили через setFeeRecipient и диамонд больше не пускает её в банк.
contract RevertingFundDiamondT {
    address public usdc;
    uint256 public vaultBalance;
    bool    public daoActive;

    error NotFeeRecipientAnymore();

    constructor(address usdc_) { usdc = usdc_; }

    function setVaultBalance(uint256 v) external { vaultBalance = v; }
    function setDaoActive(bool v)       external { daoActive = v; }

    function fundVault(uint256) external pure {
        revert NotFeeRecipientAnymore();
    }

    function getVaultBalance()      external view returns (uint256) { return vaultBalance; }
    function isDaoActive()          external view returns (bool)    { return daoActive; }
    function getUniqueActiveUsers() external pure returns (uint256) { return 0; }
    function getDAOAddress()        external pure returns (address) { return address(0); }
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

    // ---- Ревью после первичной реализации: реентранси, инвариант, округление,
    // ---- частичный забор банком, провал первой ступени. ----

    /// Реентрант, пытающийся вернуться в distribute() изнутри fundVault(),
    /// падает именно с Treasury.Reentrancy — а не с чем-то ещё и не молча.
    /// Несмотря на попытку, банк финансируется ровно один раз, остаток честно
    /// поделён, двойного распределения не происходит.
    function testReentrancyDuringVaultFundingIsBlocked() public {
        ReentrantDiamondT evilDiamond = new ReentrantDiamondT(address(usdc));
        Treasury evilTreasury = new Treasury(address(usdc), address(evilDiamond), FOUNDATION);
        evilDiamond.setTreasury(address(evilTreasury));
        evilDiamond.setAttack(true);

        usdc.mint(address(evilTreasury), 1_000_000_000); // 1000 USDC, банк пуст → шортфолл 500

        evilTreasury.distribute();

        assertTrue(evilDiamond.reentryAttempted(),  "reentrancy must have been attempted");
        assertFalse(evilDiamond.reentrySucceeded(), "reentrant distribute() must not succeed");
        assertEq(evilDiamond.reentryRevertSelector(), Treasury.Reentrancy.selector, "must fail specifically with Reentrancy");

        uint256 target = evilTreasury.VAULT_TARGET();
        uint256 rest   = 1_000_000_000 - target;
        assertEq(evilDiamond.getVaultBalance(),   target,               "vault funded exactly once, not twice");
        assertEq(usdc.balanceOf(FOUNDATION),      rest * 70 / 100,      "foundation share unaffected by reentry attempt");
        assertEq(evilTreasury.reserveBalance(),   rest - rest * 70/100, "reserve share unaffected by reentry attempt");

        assertEq(
            usdc.balanceOf(address(evilTreasury)),
            evilTreasury.reserveBalance() + evilTreasury.pendingDistribution(),
            "invariant holds after a blocked reentrancy attempt"
        );
    }

    /// Инвариант balanceOf(казна) == reserveBalance + pendingDistribution()
    /// запиннен отдельно, через несколько подряд распределений с разными
    /// состояниями банка/ДАО, а не проверяется только косвенно через суммы.
    function testInvariantHoldsAcrossMultipleDistributions() public {
        diamond.setVaultBalance(0);
        usdc.mint(address(treasury), 300_000_000);
        treasury.distribute();
        assertEq(
            usdc.balanceOf(address(treasury)),
            treasury.reserveBalance() + treasury.pendingDistribution(),
            "invariant after distribution #1 (vault partially filled)"
        );

        usdc.mint(address(treasury), 777_777_777);
        treasury.distribute();
        assertEq(
            usdc.balanceOf(address(treasury)),
            treasury.reserveBalance() + treasury.pendingDistribution(),
            "invariant after distribution #2 (vault now full, odd remainder split)"
        );

        diamond.setDaoActive(true);
        usdc.mint(address(treasury), 1_234_567);
        treasury.distribute();
        assertEq(
            usdc.balanceOf(address(treasury)),
            treasury.reserveBalance() + treasury.pendingDistribution(),
            "invariant after distribution #3 (DAO active, non-round income)"
        );
    }

    /// Мутационный киллер: toReserve посчитан ВЫЧИТАНИЕМ (pending - toFoundation),
    /// а не второй долей (pending * (BPS - bps) / BPS). На круглых суммах разницы
    /// не видно — оба способа округляются к одному числу. 1_000_003 её вскрывает:
    /// вторая доля отдельным floor-делением потеряла бы 1 единицу.
    function testNonRoundAmountPreservesExactSumOnSplit() public {
        diamond.setVaultBalance(treasury.VAULT_TARGET()); // банк полон — стадия 1 не берёт ничего
        uint256 pending = 1_000_003;
        usdc.mint(address(treasury), pending);

        treasury.distribute();

        uint256 toFoundation = usdc.balanceOf(FOUNDATION);
        uint256 toReserve    = treasury.reserveBalance();

        assertEq(toFoundation, 700_002, "foundation share floors down");
        assertEq(toReserve,    300_001, "reserve is what subtraction leaves, not a second floor division");
        assertEq(toFoundation + toReserve, pending, "not a single unit lost or created to rounding");
    }

    /// fundVault может забрать МЕНЬШЕ запрошенного (не ревертит, просто тянет
    /// меньше). Недобранное остаётся на казне и всплывает в pendingDistribution(),
    /// событие рапортует фактически ушедшее, разрешение всё равно обнуляется.
    function testFundVaultTakingLessThanRequestedLeavesRemainderPending() public {
        PartialFundDiamondT partialDiamond = new PartialFundDiamondT(address(usdc));
        partialDiamond.setVaultBalance(0); // шортфолл = полный VAULT_TARGET = 500 USDC
        partialDiamond.setActuallyTake(200_000_000); // берёт только 200 из запрошенных 500

        Treasury t = new Treasury(address(usdc), address(partialDiamond), FOUNDATION);
        usdc.mint(address(t), 1_000_000_000); // 1000 USDC

        vm.expectEmit(false, false, false, true, address(t));
        emit Treasury.Distributed(200_000_000, 350_000_000, 150_000_000);
        t.distribute();

        assertEq(partialDiamond.getVaultBalance(), 200_000_000, "vault only got what it actually pulled");
        assertEq(usdc.allowance(address(t), address(partialDiamond)), 0, "allowance must be zeroed regardless of partial pull");

        // Недобранные 300 остаются на казне и попадают в pendingDistribution(),
        // а не считаются распределёнными и не теряются.
        assertEq(t.pendingDistribution(), 300_000_000, "the un-pulled remainder must stay pending, not vanish");

        // Остаток (1000 - 500 запрошенных на банк) всё равно честно поделён 70/30.
        assertEq(usdc.balanceOf(FOUNDATION), 350_000_000, "foundation share unaffected by partial pull");
        assertEq(t.reserveBalance(),         150_000_000, "reserve share unaffected by partial pull");

        assertEq(
            usdc.balanceOf(address(t)),
            t.reserveBalance() + t.pendingDistribution(),
            "invariant holds after a partial vault pull"
        );
    }

    /// fundVault ревертит целиком (например, казну заменили через
    /// setFeeRecipient, и диамонд больше не пускает эту казну в банк).
    /// Раздача остальных ступеней всё равно проходит — казна не замуровывается
    /// вместе с нераспределённым остатком.
    function testFundVaultRevertDoesNotBrickTheRestOfTheDistribution() public {
        RevertingFundDiamondT stuckDiamond = new RevertingFundDiamondT(address(usdc));
        stuckDiamond.setVaultBalance(0); // шортфолл = полный VAULT_TARGET

        Treasury t = new Treasury(address(usdc), address(stuckDiamond), FOUNDATION);
        usdc.mint(address(t), 1_000_000_000);

        t.distribute(); // не должно ревертить целиком

        uint256 target = t.VAULT_TARGET();
        uint256 rest   = 1_000_000_000 - target;

        assertEq(stuckDiamond.getVaultBalance(), 0, "vault stage failed entirely, nothing moved");
        assertEq(usdc.balanceOf(FOUNDATION), rest * 70 / 100,       "foundation still got its share");
        assertEq(t.reserveBalance(),         rest - rest * 70/100,  "reserve still got its share");
        assertEq(usdc.allowance(address(t), address(stuckDiamond)), 0, "allowance reset even after a revert");

        // Недостающая для банка сумма осталась на казне и попадёт в следующее
        // распределение как pending, а не потерялась и не украдена.
        assertEq(t.pendingDistribution(), target, "vault-stage amount stays pending, not lost");
        assertEq(
            usdc.balanceOf(address(t)),
            t.reserveBalance() + t.pendingDistribution(),
            "invariant holds after a fundVault revert"
        );
    }
}
