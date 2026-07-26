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

/// USDC, у которого approve() можно переключаемо заставить возвращать false —
/// нужен, чтобы поймать мутанта, убирающего проверку возврата approve()
/// (MockUSDCT всегда возвращает true, эта проверка ничем не убивалась).
contract MockUSDCApproveFailT {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public approveShouldFail;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function setApproveShouldFail(bool v) external { approveShouldFail = v; }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address, uint256) external view returns (bool) {
        if (approveShouldFail) return false;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// USDC, у которого transfer() на конкретный адрес можно заблокировать —
/// имитирует чёрный список Circle. Проверяет, что withdrawFoundation()
/// изолированно ловит этот отказ и не рушит distribute().
contract BlacklistableUSDCT {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blacklisted;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function setBlacklisted(address who, bool v) external { blacklisted[who] = v; }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (blacklisted[to]) return false;
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

/// Диамонд, у которого fundVault ревертит с мегабайтным payload — имитирует
/// фасет, смонтированный владельцем диамонда через diamondCut так, что
/// revert-данные весят мегабайты. Без сырого CALL с нулевым выходным буфером
/// это заморозило бы distribute() газом (ревью замерило 158М газа на 6.4 МБ).
contract ReturndataBombDiamondT {
    address public usdc;
    uint256 public vaultBalance;
    bool    public daoActive;

    constructor(address usdc_) { usdc = usdc_; }

    function setVaultBalance(uint256 v) external { vaultBalance = v; }
    function setDaoActive(bool v)       external { daoActive = v; }

    function fundVault(uint256) external pure {
        bytes memory bomb = new bytes(1_000_000); // 1 МБ мусора в revert-payload
        assembly {
            revert(add(bomb, 0x20), mload(bomb))
        }
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

        assertEq(treasury.foundationOwed(),         700_000_000, "foundation owed");
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
        assertEq(treasury.foundationOwed(),  rest * 70 / 100, "foundation owed for the remainder");
        assertEq(treasury.reserveBalance(),  rest - rest * 70 / 100, "reserve share of the remainder");
    }

    /// Приход меньше, чем не хватает банку — всё уходит в банк, делить нечего.
    function testSmallIncomeGoesEntirelyToTheVault() public {
        diamond.setVaultBalance(0);
        usdc.mint(address(treasury), 10_000_000); // 10 USDC

        treasury.distribute();

        assertEq(diamond.getVaultBalance(),   10_000_000, "vault should have taken all of it");
        assertEq(treasury.foundationOwed(),   0,          "foundation must get nothing");
        assertEq(treasury.reserveBalance(),   0,          "reserve must get nothing");
    }

    /// После активации ДАО доли меняются местами, и ничего больше.
    function testSplitFlipsToTwentyEightyWhenDaoIsActive() public {
        diamond.setVaultBalance(treasury.VAULT_TARGET());
        diamond.setDaoActive(true);
        usdc.mint(address(treasury), 1_000_000_000);

        treasury.distribute();

        assertEq(treasury.foundationOwed(),  200_000_000, "foundation owed after DAO");
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

        assertEq(treasury.foundationOwed(), 700_000_000, "stranger's call must accrue the same foundation debt");
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

        // Второй приход 100 делится 70/30: долг фаундейшну растёт на 70, резерв на 30.
        assertEq(treasury.foundationOwed(), 700_000_000 + 70_000_000, "foundation owed");
        assertEq(treasury.reserveBalance(), 300_000_000 + 30_000_000, "reserve");
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

    /// USDC без кода не проходит — симметрично проверке диамонда: balanceOf/
    /// transfer/approve молча "успели" бы вернуть пустоту, и вся бухгалтерия
    /// потеряла бы опору.
    function testConstructorRejectsCodelessUsdc() public {
        vm.expectRevert(Treasury.NoCode.selector);
        new Treasury(address(0xC0DE1E55), address(diamond), FOUNDATION);
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
        assertEq(evilTreasury.foundationOwed(),   rest * 70 / 100,      "foundation debt unaffected by reentry attempt");
        assertEq(evilTreasury.reserveBalance(),   rest - rest * 70/100, "reserve share unaffected by reentry attempt");

        assertEq(
            usdc.balanceOf(address(evilTreasury)),
            evilTreasury.reserveBalance() + evilTreasury.foundationOwed() + evilTreasury.pendingDistribution(),
            "three-way invariant holds after a blocked reentrancy attempt"
        );
    }

    /// То же самое, но пост-ДАО (сплит 20/80) — именно этот случай ревью
    /// воспроизвело как тихую порчу до появления стража: без nonReentrant
    /// фаундейшн получал бы 120 вместо положенных, а reserveBalance
    /// расходился бы с реальным балансом на 100 USDC. Явно проверяем
    /// инвариант, а не полагаемся на то, что мок упадёт по нехватке средств.
    function testReentrancyDuringVaultFundingIsBlockedPostDao() public {
        ReentrantDiamondT evilDiamond = new ReentrantDiamondT(address(usdc));
        Treasury evilTreasury = new Treasury(address(usdc), address(evilDiamond), FOUNDATION);
        evilDiamond.setTreasury(address(evilTreasury));
        evilDiamond.setDaoActive(true);
        evilDiamond.setAttack(true);

        usdc.mint(address(evilTreasury), 1_000_000_000); // банк пуст → шортфолл 500

        evilTreasury.distribute();

        assertTrue(evilDiamond.reentryAttempted(),  "reentrancy must have been attempted");
        assertFalse(evilDiamond.reentrySucceeded(), "reentrant distribute() must not succeed post-DAO either");
        assertEq(
            evilDiamond.reentryRevertSelector(),
            Treasury.Reentrancy.selector,
            "must fail specifically with Reentrancy, not e.g. an insufficient-balance require inside the mock"
        );

        uint256 target = evilTreasury.VAULT_TARGET();
        uint256 rest   = 1_000_000_000 - target;
        assertEq(evilDiamond.getVaultBalance(),   target,               "vault funded exactly once");
        assertEq(evilTreasury.foundationOwed(),   rest * 20 / 100,      "foundation debt matches the post-DAO 20% split, not doubled");
        assertEq(evilTreasury.reserveBalance(),   rest - rest * 20/100, "reserve share matches the post-DAO 80% split");

        assertEq(
            usdc.balanceOf(address(evilTreasury)),
            evilTreasury.reserveBalance() + evilTreasury.foundationOwed() + evilTreasury.pendingDistribution(),
            "three-way invariant holds after a blocked reentrancy attempt post-DAO"
        );
    }

    /// Инвариант balanceOf(казна) == reserveBalance + foundationOwed +
    /// pendingDistribution() запиннен отдельно, через несколько подряд
    /// распределений (и один withdrawFoundation()) с разными состояниями
    /// банка/ДАО, а не проверяется только косвенно через суммы.
    function testInvariantHoldsAcrossMultipleDistributions() public {
        diamond.setVaultBalance(0);
        usdc.mint(address(treasury), 300_000_000);
        treasury.distribute();
        assertEq(
            usdc.balanceOf(address(treasury)),
            treasury.reserveBalance() + treasury.foundationOwed() + treasury.pendingDistribution(),
            "invariant after distribution #1 (vault partially filled)"
        );

        usdc.mint(address(treasury), 777_777_777);
        treasury.distribute();
        assertEq(
            usdc.balanceOf(address(treasury)),
            treasury.reserveBalance() + treasury.foundationOwed() + treasury.pendingDistribution(),
            "invariant after distribution #2 (vault now full, odd remainder split)"
        );

        diamond.setDaoActive(true);
        usdc.mint(address(treasury), 1_234_567);
        treasury.distribute();
        assertEq(
            usdc.balanceOf(address(treasury)),
            treasury.reserveBalance() + treasury.foundationOwed() + treasury.pendingDistribution(),
            "invariant after distribution #3 (DAO active, non-round income)"
        );

        // И после забора долга фаундейшном инвариант всё ещё держится.
        treasury.withdrawFoundation();
        assertEq(
            usdc.balanceOf(address(treasury)),
            treasury.reserveBalance() + treasury.foundationOwed() + treasury.pendingDistribution(),
            "invariant after withdrawFoundation()"
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

        uint256 toFoundation = treasury.foundationOwed();
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
        assertEq(t.foundationOwed(),  350_000_000, "foundation debt unaffected by partial pull");
        assertEq(t.reserveBalance(),  150_000_000, "reserve share unaffected by partial pull");

        assertEq(
            usdc.balanceOf(address(t)),
            t.reserveBalance() + t.foundationOwed() + t.pendingDistribution(),
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
        assertEq(t.foundationOwed(), rest * 70 / 100,       "foundation debt still accrues");
        assertEq(t.reserveBalance(), rest - rest * 70/100,  "reserve still got its share");
        assertEq(usdc.allowance(address(t), address(stuckDiamond)), 0, "allowance reset even after a revert");

        // Недостающая для банка сумма осталась на казне и попадёт в следующее
        // распределение как pending, а не потерялась и не украдена.
        assertEq(t.pendingDistribution(), target, "vault-stage amount stays pending, not lost");
        assertEq(
            usdc.balanceOf(address(t)),
            t.reserveBalance() + t.foundationOwed() + t.pendingDistribution(),
            "invariant holds after a fundVault revert"
        );
    }

    /// Возврат данных диамонда не ограничен обычным `.call(...)` — Solidity
    /// всегда копирует ВЕСЬ returndata в память, даже если он отбрасывается.
    /// Здесь fundVault ревертит с 1 МБ мусора. Само построение бомбы —
    /// неизбежная квадратичная стоимость расширения памяти ВНУТРИ чужого
    /// вызова (~2 млн газа на 1 МБ, её платит сам зловредный диамонд и от
    /// нашего фикса это не зависит). Но если бы казна использовала обычный
    /// `.call(...)` вместо сырого CALL с нулевым выходным буфером, она бы
    /// ВТОРОЙ раз заплатила примерно ту же квадратичную цену, чтобы
    /// скопировать этот же 1 МБ в свою собственную память — итог был бы в
    /// районе 4+ млн газа вместо ~2 млн. Порог ниже разделяет эти два случая
    /// с запасом, не разросшимся до точной оценки константы EVM.
    function testReturndataBombOnVaultStageDoesNotBlowUpGas() public {
        ReturndataBombDiamondT bombDiamond = new ReturndataBombDiamondT(address(usdc));
        bombDiamond.setVaultBalance(0);

        Treasury t = new Treasury(address(usdc), address(bombDiamond), FOUNDATION);
        usdc.mint(address(t), 1_000_000_000);

        uint256 gasBefore = gasleft();
        t.distribute();
        uint256 used = gasBefore - gasleft();

        assertLt(used, 3_000_000, "vault stage must not additionally pay to copy the bomb's returndata on top of the callee's own unavoidable memory cost");

        uint256 target = t.VAULT_TARGET();
        uint256 rest   = 1_000_000_000 - target;
        assertEq(bombDiamond.getVaultBalance(), 0, "vault stage failed, nothing moved");
        assertEq(t.foundationOwed(), rest * 70 / 100,      "foundation debt still accrues normally");
        assertEq(t.reserveBalance(), rest - rest * 70/100, "reserve still fills normally");
    }

    /// approve(), вернувший false, роняет всю раздачу целиком — а не молча
    /// продолжает как будто разрешение выставилось.
    function testApproveFailureRevertsTheWholeDistribution() public {
        MockUSDCApproveFailT flakyUsdc = new MockUSDCApproveFailT();
        MockDiamond flakyDiamond = new MockDiamond(address(flakyUsdc));
        Treasury flakyTreasury = new Treasury(address(flakyUsdc), address(flakyDiamond), FOUNDATION);

        flakyDiamond.setVaultBalance(0); // шортфолл > 0 → _fundVault точно вызовет approve()
        flakyUsdc.mint(address(flakyTreasury), 1_000_000_000);
        flakyUsdc.setApproveShouldFail(true);

        vm.expectRevert(Treasury.ApproveFailed.selector);
        flakyTreasury.distribute();
    }

    /// Чёрный список Circle на адресе фаундейшна: distribute() всё равно
    /// проходит целиком (перевод фаундейшну больше не часть distribute()),
    /// долг копится, банк и резерв продолжают наполняться. withdrawFoundation()
    /// честно ревертит, пока блокировка активна, и отдаёт всё накопленное
    /// одним вызовом после снятия блокировки.
    function testBlacklistedFoundationDoesNotBrickDistribution() public {
        BlacklistableUSDCT blUsdc = new BlacklistableUSDCT();
        MockDiamond blDiamond = new MockDiamond(address(blUsdc));
        Treasury blTreasury = new Treasury(address(blUsdc), address(blDiamond), FOUNDATION);

        blDiamond.setVaultBalance(blTreasury.VAULT_TARGET()); // банк полон, вся сумма делится
        blUsdc.mint(address(blTreasury), 1_000_000_000);
        blUsdc.setBlacklisted(FOUNDATION, true);

        // distribute() проходит целиком, несмотря на блокировку.
        blTreasury.distribute();

        assertEq(blTreasury.foundationOwed(), 700_000_000, "debt accrues even though foundation is blacklisted");
        assertEq(blTreasury.reserveBalance(), 300_000_000, "reserve still filled normally");
        assertEq(blDiamond.getVaultBalance(), blTreasury.VAULT_TARGET(), "vault unaffected");

        // Пока фаундейшн в блэклисте, забрать долг нельзя.
        vm.expectRevert(Treasury.TransferFailed.selector);
        blTreasury.withdrawFoundation();

        // Банк и резерв продолжают наполняться дальше, несмотря на застрявший долг.
        blUsdc.mint(address(blTreasury), 500_000_000);
        blTreasury.distribute();
        assertEq(blTreasury.foundationOwed(), 700_000_000 + 350_000_000, "debt keeps accruing across calls");
        assertEq(blTreasury.reserveBalance(), 300_000_000 + 150_000_000, "reserve keeps growing regardless of the stuck debt");

        // Снимаем блокировку — накопленное можно забрать одним вызовом.
        blUsdc.setBlacklisted(FOUNDATION, false);
        blTreasury.withdrawFoundation();
        assertEq(blUsdc.balanceOf(FOUNDATION), 700_000_000 + 350_000_000, "accumulated debt paid out in one go");
        assertEq(blTreasury.foundationOwed(), 0, "debt cleared after withdrawal");

        assertEq(
            blUsdc.balanceOf(address(blTreasury)),
            blTreasury.reserveBalance() + blTreasury.foundationOwed() + blTreasury.pendingDistribution(),
            "three-way invariant holds throughout"
        );
    }

    /// Забор начисленного: переводит ровно то, что накопилось, обнуляет долг,
    /// эмитит событие. Вызов permissionless по тем же причинам, что и
    /// distribute() — деньги всё равно уходят только на immutable-адрес.
    function testWithdrawFoundationTransfersOwedAndZeroesIt() public {
        diamond.setVaultBalance(treasury.VAULT_TARGET());
        usdc.mint(address(treasury), 1_000_000_000);
        treasury.distribute();
        assertEq(treasury.foundationOwed(), 700_000_000, "setup");

        vm.expectEmit(false, false, false, true, address(treasury));
        emit Treasury.FoundationWithdrawn(700_000_000);
        vm.prank(address(0xBEEF));
        treasury.withdrawFoundation();

        assertEq(usdc.balanceOf(FOUNDATION), 700_000_000, "foundation received the owed amount");
        assertEq(treasury.foundationOwed(), 0, "debt cleared");

        // Второй забор находит 0 — двойного вывода нет.
        vm.expectRevert(Treasury.NothingOwed.selector);
        treasury.withdrawFoundation();
    }

    /// Нечего забирать — ревертит, а не молча переводит 0.
    function testWithdrawFoundationRevertsWhenNothingOwed() public {
        vm.expectRevert(Treasury.NothingOwed.selector);
        treasury.withdrawFoundation();
    }
}
