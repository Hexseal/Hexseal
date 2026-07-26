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
///
/// Провал также можно запиннить по НОМЕРУ вызова (setFailOnApproveCall):
/// _fundVault зовёт approve() дважды подряд — сначала выдаёт разрешение,
/// потом сбрасывает его в 0. approveShouldFail роняет ОБЕ проверки разом
/// (снятие любой одной выживает — срабатывает вторая), а failOnApproveCall
/// бьёт точно по одной из двух, чтобы убедиться, что запиннена именно она,
/// а не другая.
contract MockUSDCApproveFailT {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public approveShouldFail;
    uint256 public failOnApproveCall; // 0 = выключено; N = провалить именно N-й вызов approve()
    uint256 public approveCallCount;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function setApproveShouldFail(bool v) external { approveShouldFail = v; }
    function setFailOnApproveCall(uint256 n) external { failOnApproveCall = n; }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address, uint256) external returns (bool) {
        approveCallCount += 1;
        if (approveShouldFail) return false;
        if (failOnApproveCall != 0 && approveCallCount == failOnApproveCall) return false;
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
    bool    public fundVaultReverts;

    error FundVaultDisabled();

    constructor(address usdc_) { usdc = usdc_; }

    function setVaultBalance(uint256 v)      external { vaultBalance = v; }
    function setDaoActive(bool v)            external { daoActive = v; }
    function setUniqueActiveUsers(uint256 v) external { uniqueActiveUsers = v; }
    function setDao(address v)               external { dao = v; }
    /// Имитирует момент, когда казну заменили через setFeeRecipient и
    /// диамонд больше не пускает эту казну в fundVault.
    function setFundVaultReverts(bool v)     external { fundVaultReverts = v; }

    function fundVault(uint256 amount) external {
        if (fundVaultReverts) revert FundVaultDisabled();
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
/// просто тянет actuallyTake вместо amount), но начисляет себе ЗАПРОШЕННОЕ —
/// зеркалит арифметику настоящего ArbiterRegistryFacet.fundVault
/// (src/facets/ArbiterRegistryFacet.sol:751: `d.vaultBalance += amount;`, где
/// amount — параметр вызова, а не то, что реально пришло по transferFrom).
/// Раньше мок начислял `+= take` (то, что реально утянул) — это делало
/// getVaultBalance() зеркалом spent, и мутация, убирающая проверку
/// `spent != amount` в topUpVault(), всё равно ловилась постусловием
/// VaultDidNotGrow (банк не дорастал до vaultBefore+amount), а не самой
/// целевой проверкой. С начислением ЗАПРОШЕННОГО банк дорастает до полного
/// amount независимо от того, что реально утянуто, — постусловие проходит,
/// и утечку резерва при снятой проверке `spent != amount` ловит только она.
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
        vaultBalance += amount;
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

/// Диамонд, чей fundVault ничего не забирает через transferFrom, а вместо
/// этого сам присылает казне немного лишнего USDC — баланс казны неожиданно
/// РАСТЁТ во время вызова. Проверяет ветку spent=0 в _fundVault: без неё
/// вычитание balanceBefore - balanceAfter ушло бы в подполье (balanceAfter
/// оказался бы больше balanceBefore) и схлопнулось бы в Panic(0x11),
/// обрушив всю раздачу. Требует предварительного минта самому диамонду —
/// он не может прислать то, чего у него нет.
contract BalanceGrowingFundDiamondT {
    address public usdc;
    uint256 public vaultBalance;
    bool    public daoActive;
    uint256 public constant GIFT = 1_000_000; // 1 USDC — сумма, которую диамонд сам шлёт казне

    constructor(address usdc_) { usdc = usdc_; }

    function setVaultBalance(uint256 v) external { vaultBalance = v; }
    function setDaoActive(bool v)       external { daoActive = v; }

    function fundVault(uint256) external {
        // Игнорируем запрошенный amount и НЕ забираем ничего через
        // transferFrom — вместо этого сами отправляем казне GIFT.
        MockUSDCT(usdc).transfer(msg.sender, GIFT);
        vaultBalance += GIFT;
    }

    function getVaultBalance()      external view returns (uint256) { return vaultBalance; }
    function isDaoActive()          external view returns (bool)    { return daoActive; }
    function getUniqueActiveUsers() external pure returns (uint256) { return 0; }
    function getDAOAddress()        external pure returns (address) { return address(0); }
}

/// USDC, который во время transfer() (1) записывает, каким было
/// foundationOwed казны В МОМЕНТ вызова — пиннит порядок «effects-before-
/// interaction» в withdrawFoundation() без реентранси, и (2) при attack=true
/// пытается реентерить withdrawFoundation() изнутри собственного transfer(),
/// как это уже делает ReentrantDiamondT для distribute()/fundVault().
contract ReentrantWithdrawUSDCT {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public treasury;
    bool    public attack;

    bool    public reentryAttempted;
    bool    public reentrySucceeded;
    bytes4  public reentryRevertSelector;
    uint256 public foundationOwedDuringTransfer;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function setTreasury(address t) external { treasury = t; }
    function setAttack(bool v)      external { attack = v; }

    function transfer(address to, uint256 amount) external returns (bool) {
        // Снимок ДО собственного перевода — если withdrawFoundation()
        // обнулит foundationOwed ПОСЛЕ transfer(), а не до, здесь будет
        // видно старое ненулевое значение.
        foundationOwedDuringTransfer = Treasury(treasury).foundationOwed();

        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;

        if (attack) {
            reentryAttempted = true;
            try Treasury(treasury).withdrawFoundation() {
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

/// Диамонд, чей fundVault на ПЕРВОМ уровне вложенности ничего не тянет, а
/// сразу реентерит treasury.topUpVault(); реально забирает деньги (через
/// transferFrom) только на ВТОРОМ уровне. Так внешний spent совпадёт с
/// внешним amount, и проверка «всё или ничего» в topUpVault() пропустит
/// вызов, даже если резерв на самом деле списан дважды на один и тот же
/// неизменившийся недостаток. Перехватывает исход реентранси через
/// try/catch, как и ReentrantDiamondT/ReentrantWithdrawUSDCT.
contract ReentrantTopUpDiamondT {
    address public usdc;
    uint256 public vaultBalance;
    bool    public daoActive;
    address public treasury;
    bool    public attack;
    bool    public reentered;

    bool    public reentryAttempted;
    bool    public reentrySucceeded;
    bytes4  public reentryRevertSelector;

    constructor(address usdc_) { usdc = usdc_; }

    function setTreasury(address t)     external { treasury = t; }
    function setVaultBalance(uint256 v) external { vaultBalance = v; }
    function setDaoActive(bool v)       external { daoActive = v; }
    function setAttack(bool v)          external { attack = v; }

    function fundVault(uint256 amount) external {
        if (attack && !reentered) {
            reentered = true;
            reentryAttempted = true;
            try Treasury(treasury).topUpVault() {
                reentrySucceeded = true;
            } catch (bytes memory reason) {
                reentrySucceeded = false;
                if (reason.length >= 4) {
                    bytes4 sel;
                    assembly { sel := mload(add(reason, 32)) }
                    reentryRevertSelector = sel;
                }
            }
            // Первый уровень сам ничего не тянет — только реентерит.
            return;
        }
        // Второй уровень (или атака выключена) — реально тянем деньги.
        MockUSDCT(usdc).transferFrom(msg.sender, address(this), amount);
        vaultBalance += amount;
    }

    function getVaultBalance()      external view returns (uint256) { return vaultBalance; }
    function isDaoActive()          external view returns (bool)    { return daoActive; }
    function getUniqueActiveUsers() external pure returns (uint256) { return 0; }
    function getDAOAddress()        external pure returns (address) { return address(0); }
}

/// Диамонд, который честно принимает transferFrom (деньги реально покидают
/// казну), но НЕ учитывает пополнение в собственном балансе банка —
/// имитирует не обязательно враждебный, а просто СЛОМАННЫЙ (например, при
/// будущем апгрейде фасета банка) fundVault: перевод состоялся, счётчик не
/// увеличился. Проверяет постусловие topUpVault(): spent == amount доказывает
/// только то, что USDC покинули казну, а не то, что банк их учёл.
contract SilentFundDiamondT {
    address public usdc;
    uint256 public vaultBalance;
    bool    public daoActive;

    constructor(address usdc_) { usdc = usdc_; }

    function setVaultBalance(uint256 v) external { vaultBalance = v; }
    function setDaoActive(bool v)       external { daoActive = v; }

    function fundVault(uint256 amount) external {
        MockUSDCT(usdc).transferFrom(msg.sender, address(this), amount);
        // Намеренно НЕ увеличиваем vaultBalance — деньги пришли, свой учёт не обновился.
    }

    function getVaultBalance()      external view returns (uint256) { return vaultBalance; }
    function isDaoActive()          external view returns (bool)    { return daoActive; }
    function getUniqueActiveUsers() external pure returns (uint256) { return 0; }
    function getDAOAddress()        external pure returns (address) { return address(0); }
}

/// USDC, который сам выступает адресом ДАО и при собственном transfer()
/// пытается реентерить withdrawReserve() — зеркалит приём
/// ReentrantWithdrawUSDCT (реентрант withdrawFoundation() изнутри transfer()),
/// но withdrawReserve() дополнительно требует msg.sender == dao, поэтому
/// сам мок и назначается адресом ДАО: вложенный вызов инициирует ИМЕННО
/// этот контракт, и msg.sender реентранта совпадает с dao без дополнительных
/// ухищрений. Так тест бьёт строго по nonReentrant, не задевая NotDao.
contract ReentrantWithdrawReserveUSDCT {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public treasury;
    bool    public attack;

    bool    public reentryAttempted;
    bool    public reentrySucceeded;
    bytes4  public reentryRevertSelector;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function setTreasury(address t) external { treasury = t; }
    function setAttack(bool v)      external { attack = v; }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;

        if (attack) {
            reentryAttempted = true;
            try Treasury(treasury).withdrawReserve(1) {
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

contract TreasuryTest is Test {
    MockUSDCT   usdc;
    MockDiamond diamond;
    Treasury    treasury;

    address constant FOUNDATION = address(0xF00D);
    address constant DAO        = address(0xDA0);

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
    /// меньше). distribute() при этом не проверяет, сколько реально дошло до
    /// банка (в отличие от topUpVault() — см. testTopUpVaultRevertsWhenVaultFundingIsPartial):
    /// недобранное остаётся на казне и всплывает в pendingDistribution(),
    /// событие рапортует фактически ушедшее (spent), разрешение всё равно
    /// обнуляется. getVaultBalance() мока растёт на ЗАПРОШЕННОЕ (как у
    /// настоящего фасета) — тем самым уже здесь виден расходящийся факт,
    /// который distribute() сознательно не проверяет: банк отчитывается о
    /// большем приросте (500), чем реально утянуто с казны (200).
    function testFundVaultTakingLessThanRequestedLeavesRemainderPending() public {
        PartialFundDiamondT partialDiamond = new PartialFundDiamondT(address(usdc));
        partialDiamond.setVaultBalance(0); // шортфолл = полный VAULT_TARGET = 500 USDC
        partialDiamond.setActuallyTake(200_000_000); // берёт только 200 из запрошенных 500

        Treasury t = new Treasury(address(usdc), address(partialDiamond), FOUNDATION);
        usdc.mint(address(t), 1_000_000_000); // 1000 USDC

        vm.expectEmit(false, false, false, true, address(t));
        emit Treasury.Distributed(200_000_000, 350_000_000, 150_000_000);
        t.distribute();

        assertEq(partialDiamond.getVaultBalance(), 500_000_000, "vault self-reports the requested amount, not what it actually pulled");
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

    // ============================================================
    // Задача 3: topUpVault() — резерв добивает банк.
    // ============================================================

    /// Банк просел — резерв добивает его до цели, и ровно на недостающее.
    function testTopUpVaultMovesOnlyTheShortfall() public {
        diamond.setVaultBalance(treasury.VAULT_TARGET());
        usdc.mint(address(treasury), 1_000_000_000);
        treasury.distribute();
        assertEq(treasury.reserveBalance(), 300_000_000, "setup: reserve");

        // Банк потратился на дотации арбитрам.
        diamond.setVaultBalance(treasury.VAULT_TARGET() - 120_000_000);

        treasury.topUpVault();

        assertEq(diamond.getVaultBalance(), treasury.VAULT_TARGET(), "vault not restored to target");
        assertEq(treasury.reserveBalance(), 300_000_000 - 120_000_000, "reserve must lose exactly the shortfall");
    }

    /// Банк полон — вызов ревертит, а не переводит ноль и не льёт сверх цели.
    function testTopUpVaultRevertsWhenVaultIsAtTarget() public {
        diamond.setVaultBalance(treasury.VAULT_TARGET());
        vm.expectRevert(Treasury.VaultAtTarget.selector);
        treasury.topUpVault();
    }

    /// Резерв пуст — ревертит, а не делает вид, что сработал.
    function testTopUpVaultRevertsWhenReserveIsEmpty() public {
        diamond.setVaultBalance(0);
        vm.expectRevert(Treasury.ReserveEmpty.selector);
        treasury.topUpVault();
    }

    /// Резерва меньше, чем просадка — отдаёт сколько есть, а не ревертит.
    function testTopUpVaultGivesWhatItHasWhenReserveIsShort() public {
        diamond.setVaultBalance(treasury.VAULT_TARGET());
        usdc.mint(address(treasury), 100_000_000);
        treasury.distribute();
        uint256 reserve = treasury.reserveBalance();
        assertGt(reserve, 0, "setup: reserve must be non-empty");

        diamond.setVaultBalance(0); // просадка много больше резерва

        treasury.topUpVault();

        assertEq(treasury.reserveBalance(), 0, "reserve must be drained");
        assertEq(diamond.getVaultBalance(), reserve, "vault must receive exactly what the reserve had");
    }

    /// Провал наполнения банка обязан откатить списание резерва. Без проверки
    /// флага резерв обнулялся бы, банк не получал бы ничего, а деньги уезжали
    /// бы в нераспределённый остаток — с событием об успехе. Замерено ревью:
    /// 300 USDC уходят из резерва безвозвратно, вызов открытый и повторяемый.
    function testTopUpVaultRevertsWhenVaultFundingFails() public {
        diamond.setVaultBalance(treasury.VAULT_TARGET());
        usdc.mint(address(treasury), 1_000_000_000);
        treasury.distribute();
        uint256 reserveBefore = treasury.reserveBalance();
        assertGt(reserveBefore, 0, "setup: reserve must be non-empty");

        diamond.setVaultBalance(0);
        diamond.setFundVaultReverts(true);

        vm.expectRevert(Treasury.VaultFundingFailed.selector);
        treasury.topUpVault();

        assertEq(treasury.reserveBalance(), reserveBefore, "reserve must be untouched after a failed top-up");
    }

    /// Как и у distribute: сторожит отсутствие гейта. Упадёт, если кто-то
    /// решит, что тратить резерв должен только владелец — а это ровно то
    /// усмотрение, которого в конструкции быть не должно.
    function testAnyoneCanTopUpVault() public {
        diamond.setVaultBalance(treasury.VAULT_TARGET());
        usdc.mint(address(treasury), 1_000_000_000);
        treasury.distribute();
        diamond.setVaultBalance(treasury.VAULT_TARGET() - 50_000_000);

        vm.prank(address(0xBEEF));
        treasury.topUpVault();

        assertEq(diamond.getVaultBalance(), treasury.VAULT_TARGET(), "stranger's call must work identically");
    }

    // ============================================================
    // Хвосты из ревью Задачи 3.
    // ============================================================

    /// _fundVault зовёт approve() дважды: сначала выдаёт разрешение, потом
    /// сбрасывает его в 0. MockUSDCApproveFailT.approveShouldFail роняет ОБЕ
    /// проверки разом, поэтому снятие любой ОДНОЙ из двух в коде им не
    /// ловится — срабатывает вторая. failOnApproveCall бьёт точно по первому
    /// вызову (выдача), проверяя, что именно эта проверка реальна.
    function testFundVaultRevertsWhenGrantApproveFails() public {
        MockUSDCApproveFailT flakyUsdc = new MockUSDCApproveFailT();
        MockDiamond flakyDiamond = new MockDiamond(address(flakyUsdc));
        Treasury flakyTreasury = new Treasury(address(flakyUsdc), address(flakyDiamond), FOUNDATION);

        flakyDiamond.setVaultBalance(0); // шортфолл > 0 → _fundVault точно вызовет approve() дважды
        flakyUsdc.mint(address(flakyTreasury), 1_000_000_000);
        flakyUsdc.setFailOnApproveCall(1); // роняем ИМЕННО первый вызов — выдачу разрешения

        vm.expectRevert(Treasury.ApproveFailed.selector);
        flakyTreasury.distribute();
    }

    /// Симметричный тест: первый approve() (выдача) проходит успешно, а
    /// проваливается именно ВТОРОЙ (сброс в 0). Без этого теста мутант,
    /// убирающий проверку возврата у ВТОРОГО approve(), не ловился бы никем —
    /// testApproveFailureRevertsTheWholeDistribution роняет первый вызов и
    /// до второго код никогда не доходит.
    function testFundVaultRevertsWhenResetApproveFails() public {
        MockUSDCApproveFailT flakyUsdc = new MockUSDCApproveFailT();
        MockDiamond flakyDiamond = new MockDiamond(address(flakyUsdc));
        Treasury flakyTreasury = new Treasury(address(flakyUsdc), address(flakyDiamond), FOUNDATION);

        flakyDiamond.setVaultBalance(0);
        flakyUsdc.mint(address(flakyTreasury), 1_000_000_000);
        flakyUsdc.setFailOnApproveCall(2); // выдача проходит, сброс в 0 — нет

        vm.expectRevert(Treasury.ApproveFailed.selector);
        flakyTreasury.distribute();
    }

    /// Пиннит порядок «effects-before-interaction» в withdrawFoundation()
    /// БЕЗ реентранси: USDC-мок записывает foundationOwed казны в момент
    /// собственного transfer(). Если долг обнуляется ПОСЛЕ перевода, а не
    /// до, здесь будет видно старое ненулевое значение — мутант "перенести
    /// foundationOwed = 0 после transfer()" пойман именно этим тестом.
    function testWithdrawFoundationZeroesDebtBeforeTransfer() public {
        ReentrantWithdrawUSDCT rUsdc = new ReentrantWithdrawUSDCT();
        MockDiamond rDiamond = new MockDiamond(address(rUsdc));
        Treasury rTreasury = new Treasury(address(rUsdc), address(rDiamond), FOUNDATION);
        rUsdc.setTreasury(address(rTreasury));

        rDiamond.setVaultBalance(rTreasury.VAULT_TARGET()); // банк полон — fundVault в distribute() не зовётся
        rUsdc.mint(address(rTreasury), 1_000_000_000);
        rTreasury.distribute();
        assertEq(rTreasury.foundationOwed(), 700_000_000, "setup: foundation debt accrued");

        rTreasury.withdrawFoundation();

        assertEq(
            rUsdc.foundationOwedDuringTransfer(), 0,
            "foundationOwed must already be zero at the moment of transfer() -- effects before interaction"
        );
        assertEq(rTreasury.foundationOwed(), 0, "debt cleared after withdrawal");
        assertEq(rUsdc.balanceOf(FOUNDATION), 700_000_000, "foundation actually received the funds");
    }

    /// Пиннит страж nonReentrant на withdrawFoundation() отдельно от порядка:
    /// реентрант, пытающийся вернуться в withdrawFoundation() изнутри
    /// собственного transfer(), обязан упасть именно с Treasury.Reentrancy —
    /// а не молча пройти и не упасть с чем-то другим (например, NothingOwed
    /// от уже обнулённого при верном порядке долга). Мутант "снять
    /// nonReentrant" (при сохранённом порядке) ловится именно тем, что
    /// селектор ошибки меняется с Reentrancy на NothingOwed.
    function testWithdrawFoundationBlocksReentrancy() public {
        ReentrantWithdrawUSDCT rUsdc = new ReentrantWithdrawUSDCT();
        MockDiamond rDiamond = new MockDiamond(address(rUsdc));
        Treasury rTreasury = new Treasury(address(rUsdc), address(rDiamond), FOUNDATION);
        rUsdc.setTreasury(address(rTreasury));
        rUsdc.setAttack(true);

        rDiamond.setVaultBalance(rTreasury.VAULT_TARGET());
        rUsdc.mint(address(rTreasury), 1_000_000_000);
        rTreasury.distribute();

        rTreasury.withdrawFoundation();

        assertTrue(rUsdc.reentryAttempted(),  "reentrancy must have been attempted");
        assertFalse(rUsdc.reentrySucceeded(), "reentrant withdrawFoundation() must not succeed");
        assertEq(
            rUsdc.reentryRevertSelector(), Treasury.Reentrancy.selector,
            "must fail specifically with Reentrancy, not e.g. NothingOwed from an already-zeroed debt"
        );

        assertEq(rTreasury.foundationOwed(), 0, "debt cleared exactly once");
        assertEq(rUsdc.balanceOf(FOUNDATION), 700_000_000, "foundation received the owed amount exactly once, not twice");
    }

    /// Ветка spent=0 при НЕОЖИДАННО выросшем балансе казны во время вызова
    /// банка. Достижимо только враждебным диамондом (шлёт казне USDC внутри
    /// собственного fundVault вместо того, чтобы его забирать) — ровно та
    /// модель угроз, ради которой сделан весь _fundVault. Без этой ветки
    /// вычитание balanceBefore - balanceAfter ушло бы в подполье и
    /// схлопнулось бы в Panic(0x11), обрушив всю раздачу целиком.
    function testFundVaultTreatsUnexpectedBalanceGrowthAsZeroSpent() public {
        BalanceGrowingFundDiamondT giftDiamond = new BalanceGrowingFundDiamondT(address(usdc));
        giftDiamond.setVaultBalance(0); // шортфолл = полный VAULT_TARGET
        usdc.mint(address(giftDiamond), giftDiamond.GIFT()); // диамонду есть что прислать казне

        Treasury t = new Treasury(address(usdc), address(giftDiamond), FOUNDATION);
        usdc.mint(address(t), 1_000_000_000);

        // Не должно ревертить Panic(0x11).
        t.distribute();

        uint256 target = t.VAULT_TARGET();
        uint256 rest = 1_000_000_000 - target;
        assertEq(t.foundationOwed(), rest * 70 / 100,      "foundation debt still accrues normally");
        assertEq(t.reserveBalance(), rest - rest * 70/100, "reserve still fills normally");

        assertEq(
            usdc.balanceOf(address(t)),
            t.reserveBalance() + t.foundationOwed() + t.pendingDistribution(),
            "invariant holds even when the diamond unexpectedly grows the treasury's balance mid-call"
        );
    }

    // ============================================================
    // Ревью Задачи 3 (второй раунд): три недержащихся мутанта +
    // постусловие "банк реально учёл прирост", которого раньше не было.
    // ============================================================

    /// Important-1: `spent != amount` в topUpVault() пиннится ПЕРЕИСПОЛЬЗОВАННЫМ
    /// PartialFundDiamondT, направленным на topUpVault (а не на distribute, как
    /// в исходном тесте на тот же мок). Диамонд запрошен на 300 USDC, тянет
    /// только 100, но начисляет себе ЗАПРОШЕННОЕ (300, как настоящий фасет —
    /// см. комментарий у PartialFundDiamondT) — поэтому getVaultBalance()
    /// дорастает ровно до vaultBefore+amount, и постусловие VaultDidNotGrow
    /// эту атаку НЕ ловит: без проверки `spent != amount` резерв списался бы
    /// целиком (300), банк реально получил бы только треть (100), а 200
    /// утекли бы в нераспределённый остаток с событием об успехе — и это
    /// ловит только `spent != amount`, никакая другая проверка.
    function testTopUpVaultRevertsWhenVaultFundingIsPartial() public {
        PartialFundDiamondT partialDiamond = new PartialFundDiamondT(address(usdc));
        Treasury t = new Treasury(address(usdc), address(partialDiamond), FOUNDATION);

        partialDiamond.setVaultBalance(t.VAULT_TARGET()); // временно полон — distribute() банк не трогает
        usdc.mint(address(t), 1_000_000_000);
        t.distribute();
        assertEq(t.reserveBalance(), 300_000_000, "setup: reserve");

        partialDiamond.setVaultBalance(200_000_000); // шортфолл = 300 USDC
        partialDiamond.setActuallyTake(100_000_000); // банк берёт только треть запрошенного

        vm.expectRevert(Treasury.VaultFundingFailed.selector);
        t.topUpVault();

        assertEq(t.reserveBalance(), 300_000_000, "reserve must be untouched after a failed (partial) top-up");
        assertEq(partialDiamond.getVaultBalance(), 200_000_000, "vault must be untouched after a failed top-up");
    }

    /// Important-2: страж nonReentrant на topUpVault() пиннится отдельно от
    /// суммовой проверки. ReentrantTopUpDiamondT на первом уровне ничего не
    /// тянет, сразу реентерит topUpVault(), и тянет по-настоящему только на
    /// втором уровне — так внешний spent совпадает с внешним amount, и
    /// `spent != amount` эту атаку НЕ ловит (см. Important-1 выше — другая
    /// проверка, другой мутант). Со стражем реентрантный вызов внутри
    /// fundVault() падает с Reentrancy СРАЗУ, поэтому первый уровень
    /// возвращается, ничего не забрав (spent=0 на внешнем уровне), и внешняя
    /// проверка `spent != amount` заваливает всю транзакцию целиком. Без
    /// стража реентрантный вызов проходит и реально тянет деньги — внешний
    /// уровень видит spent == amount (пул случился, просто на вложенном
    /// уровне) и тихо пропускает двойное списание резерва.
    function testTopUpVaultBlocksReentrancy() public {
        ReentrantTopUpDiamondT evilDiamond = new ReentrantTopUpDiamondT(address(usdc));
        Treasury evilTreasury = new Treasury(address(usdc), address(evilDiamond), FOUNDATION);
        evilDiamond.setTreasury(address(evilTreasury));

        evilDiamond.setVaultBalance(evilTreasury.VAULT_TARGET()); // временно полон
        usdc.mint(address(evilTreasury), 4_000_000_000);
        evilTreasury.distribute();
        assertEq(evilTreasury.reserveBalance(), 1_200_000_000, "setup: reserve");

        evilDiamond.setVaultBalance(0); // шортфолл = VAULT_TARGET = 500 USDC
        evilDiamond.setAttack(true);

        // Со стражем реентрантный вызов внутри fundVault() обязан упасть, а
        // внешний уровень — не найти своего pull и провалить транзакцию
        // целиком: без стража этот же сценарий тихо списывает резерв дважды
        // (1200 → 200, ушло 1000) на один и тот же неизменившийся недостаток
        // банка (0 → 500, а не 0 → 1000), и эмитит два события VaultToppedUp.
        vm.expectRevert(Treasury.VaultFundingFailed.selector);
        evilTreasury.topUpVault();

        assertEq(evilTreasury.reserveBalance(), 1_200_000_000, "reserve must be untouched -- whole call reverted");
        assertEq(evilDiamond.getVaultBalance(), 0, "vault must be untouched -- whole call reverted");
    }

    /// Постусловие "банк реально учёл прирост": SilentFundDiamondT честно
    /// принимает transferFrom (деньги покидают казну, spent == amount), но
    /// не увеличивает собственный getVaultBalance() — имитирует сломанный
    /// (не обязательно враждебный) фасет банка. Без отдельной проверки
    /// vaultAfter >= vaultBefore + amount казна списала бы резерв, диамонд
    /// реально забрал бы деньги, а банк по своему же отчёту остался бы сухим
    /// навсегда — с событием VaultToppedUp об успехе.
    function testTopUpVaultRevertsWhenVaultBalanceDoesNotGrow() public {
        SilentFundDiamondT silentDiamond = new SilentFundDiamondT(address(usdc));
        Treasury t = new Treasury(address(usdc), address(silentDiamond), FOUNDATION);

        silentDiamond.setVaultBalance(t.VAULT_TARGET()); // временно полон — distribute() банк не трогает
        usdc.mint(address(t), 1_000_000_000);
        t.distribute();
        assertEq(t.reserveBalance(), 300_000_000, "setup: reserve");

        silentDiamond.setVaultBalance(0); // диамонд ОТЧИТЫВАЕТСЯ о полной просадке

        vm.expectRevert(Treasury.VaultDidNotGrow.selector);
        t.topUpVault();

        assertEq(t.reserveBalance(), 300_000_000, "reserve must be untouched when the vault silently fails to record the top-up");
    }

    // ============================================================
    // Задача 4: withdrawReserve() — выход резерва к ДАО.
    // ============================================================

    /// Заработанный порог достигнут, адрес ДАО выставлен — резерв выводится им.
    function testDaoWithdrawsReserveOnceThresholdIsEarned() public {
        diamond.setVaultBalance(treasury.VAULT_TARGET());
        usdc.mint(address(treasury), 1_000_000_000);
        treasury.distribute();
        assertEq(treasury.reserveBalance(), 300_000_000, "setup");

        diamond.setUniqueActiveUsers(treasury.DAO_THRESHOLD());
        diamond.setDao(DAO);

        vm.prank(DAO);
        treasury.withdrawReserve(100_000_000);

        assertEq(usdc.balanceOf(DAO),       100_000_000, "dao did not receive the funds");
        assertEq(treasury.reserveBalance(), 200_000_000, "reserve not reduced");
    }

    /// ГЛАВНЫЙ ТЕСТ. Ручной флаг ДАО резерв НЕ открывает.
    ///
    /// isDaoActive() истинна при daoActiveManual ИЛИ при заработанном пороге.
    /// Владелец диамонда может включить ручной флаг и выставить daoAddress на
    /// свой кошелёк. Если бы вывод резерва гейтился по isDaoActive(), резерв
    /// выводился бы по решению владельца — то есть обещание «без администраторов»
    /// не стоило бы ничего именно там, где лежат деньги.
    function testManualDaoFlagDoesNotUnlockTheReserve() public {
        diamond.setVaultBalance(treasury.VAULT_TARGET());
        usdc.mint(address(treasury), 1_000_000_000);
        treasury.distribute();

        diamond.setDaoActive(true);            // ручной флаг включён
        diamond.setUniqueActiveUsers(5);       // но порог НЕ заработан
        diamond.setDao(DAO);

        vm.prank(DAO);
        vm.expectRevert(Treasury.DaoNotEarned.selector);
        treasury.withdrawReserve(1);
    }

    /// Порог заработан, но адрес ДАО ещё не выставлен — выводить некому.
    function testWithdrawRevertsWhenDaoAddressUnset() public {
        diamond.setUniqueActiveUsers(treasury.DAO_THRESHOLD());
        vm.expectRevert(Treasury.DaoAddressUnset.selector);
        treasury.withdrawReserve(1);
    }

    /// Порог заработан, адрес выставлен — но зовёт не ДАО.
    function testStrangerCannotWithdrawReserve() public {
        diamond.setVaultBalance(treasury.VAULT_TARGET());
        usdc.mint(address(treasury), 1_000_000_000);
        treasury.distribute();
        diamond.setUniqueActiveUsers(treasury.DAO_THRESHOLD());
        diamond.setDao(DAO);

        vm.prank(address(0xBAD));
        vm.expectRevert(Treasury.NotDao.selector);
        treasury.withdrawReserve(1);
    }

    /// Запрос больше резерва обрезается до наличного, а не ревертит — иначе
    /// открытый topUpVault() был бы инструментом срыва вывода ДАО. И обрезка
    /// не даёт зацепить нераспределённые деньги, которые резерву не принадлежат.
    function testWithdrawIsClampedToTheReserveAndSpillsNothingElse() public {
        diamond.setVaultBalance(treasury.VAULT_TARGET());
        usdc.mint(address(treasury), 1_000_000_000);
        treasury.distribute();
        assertEq(treasury.reserveBalance(), 300_000_000, "setup: reserve");
        diamond.setUniqueActiveUsers(treasury.DAO_THRESHOLD());
        diamond.setDao(DAO);

        usdc.mint(address(treasury), 500_000_000); // нераспределённый приход
        uint256 pendingBefore = treasury.pendingDistribution();

        vm.prank(DAO);
        treasury.withdrawReserve(300_000_001);

        assertEq(usdc.balanceOf(DAO),            300_000_000, "dao must receive exactly the reserve");
        assertEq(treasury.reserveBalance(),      0,           "reserve must be drained, not overdrawn");
        assertEq(treasury.pendingDistribution(), pendingBefore, "undistributed money must be untouched");
    }

    /// Сценарий срыва: посторонний опережает ДАО открытым topUpVault(), резерв
    /// законно уменьшается — вывод обязан пройти на остаток, а не упасть.
    function testTopUpVaultCannotGriefTheDaoWithdrawal() public {
        diamond.setVaultBalance(treasury.VAULT_TARGET());
        usdc.mint(address(treasury), 1_000_000_000);
        treasury.distribute();
        diamond.setUniqueActiveUsers(treasury.DAO_THRESHOLD());
        diamond.setDao(DAO);

        // Посторонний просаживает банк и добивает его из резерва.
        diamond.setVaultBalance(treasury.VAULT_TARGET() - 100_000_000);
        vm.prank(address(0xBEEF));
        treasury.topUpVault();
        assertEq(treasury.reserveBalance(), 200_000_000, "setup: reserve after the front-run");

        vm.prank(DAO);
        treasury.withdrawReserve(300_000_000); // ДАО просит по устаревшим данным

        assertEq(usdc.balanceOf(DAO),       200_000_000, "dao must get what is left, not revert");
        assertEq(treasury.reserveBalance(), 0,           "reserve drained");
    }

    /// Резерв пуст — вывод ревертит, а не отправляет ноль.
    function testWithdrawRevertsWhenReserveIsEmpty() public {
        diamond.setUniqueActiveUsers(treasury.DAO_THRESHOLD());
        diamond.setDao(DAO);

        vm.prank(DAO);
        vm.expectRevert(Treasury.ReserveEmpty.selector);
        treasury.withdrawReserve(1);
    }

    /// Ноль — не вывод.
    function testCannotWithdrawZero() public {
        diamond.setUniqueActiveUsers(treasury.DAO_THRESHOLD());
        diamond.setDao(DAO);

        vm.prank(DAO);
        vm.expectRevert(Treasury.InvalidAmount.selector);
        treasury.withdrawReserve(0);
    }

    // ---- Хвосты сверх брифа: заготовки Задачи 2, которые бриф просил
    // ---- закрепить (событие), и две защиты, которые ни один из восьми
    // ---- тестов выше не бьёт. ----

    /// Оба условия провала выполнены ОДНОВРЕМЕННО (uniqueActiveUsers по
    /// умолчанию 0, daoAddress по умолчанию address(0)) — ни один тест выше
    /// их не совмещает, поэтому порядок между DaoNotEarned и DaoAddressUnset
    /// ничем не запиннен. Ожидаем именно DaoNotEarned: порог — гейт, который
    /// нельзя подделать, он проверяется первым и всегда виден отдельно от
    /// того, выставлен ли вообще адрес.
    function testDaoNotEarnedTakesPriorityOverDaoAddressUnset() public {
        vm.expectRevert(Treasury.DaoNotEarned.selector);
        treasury.withdrawReserve(1);
    }

    /// Событие обязано репортить ФАКТИЧЕСКИ отправленное, а не запрошенное —
    /// иначе обрезка молчала бы: снаружи выглядело бы, что ДАО получило
    /// запрошенную сумму, хотя реально ушло меньше. Запрос заведомо больше
    /// резерва (300_000_000), чтобы отличить amount от toSend в самом событии,
    /// а не только по балансам (testWithdrawIsClampedToTheReserveAndSpillsNothingElse
    /// проверяет то же самое поведение через балансы, но мутант "emit amount
    /// вместо toSend" ими не ловится — событие никто не читает).
    function testWithdrawReserveEmitsClampedAmountNotRequested() public {
        diamond.setVaultBalance(treasury.VAULT_TARGET());
        usdc.mint(address(treasury), 1_000_000_000);
        treasury.distribute();
        assertEq(treasury.reserveBalance(), 300_000_000, "setup: reserve");
        diamond.setUniqueActiveUsers(treasury.DAO_THRESHOLD());
        diamond.setDao(DAO);

        vm.expectEmit(true, false, false, true, address(treasury));
        emit Treasury.ReserveWithdrawn(DAO, 300_000_000); // обрезано, не 999_999_999
        vm.prank(DAO);
        treasury.withdrawReserve(999_999_999);
    }

    /// Чёрный список Circle на адресе ДАО: перевод проваливается — вывод
    /// обязан честно ревертить TransferFailed, а не тихо "списать" резерв без
    /// факта перевода. reserveBalance -= toSend происходит ДО transfer();
    /// без проверки возврата откат не наступил бы, реверта тоже — резерв
    /// уменьшился бы, а деньги остались бы на казне. Ни один из тестов выше
    /// не проваливает transfer(), поэтому эта проверка была бы неубиваемой
    /// без отдельного мока.
    function testWithdrawRevertsWhenDaoTransferFails() public {
        BlacklistableUSDCT blUsdc = new BlacklistableUSDCT();
        MockDiamond blDiamond = new MockDiamond(address(blUsdc));
        Treasury blTreasury = new Treasury(address(blUsdc), address(blDiamond), FOUNDATION);

        blDiamond.setVaultBalance(blTreasury.VAULT_TARGET());
        blUsdc.mint(address(blTreasury), 1_000_000_000);
        blTreasury.distribute();
        assertEq(blTreasury.reserveBalance(), 300_000_000, "setup: reserve");

        blDiamond.setUniqueActiveUsers(blTreasury.DAO_THRESHOLD());
        blDiamond.setDao(DAO);
        blUsdc.setBlacklisted(DAO, true);

        vm.prank(DAO);
        vm.expectRevert(Treasury.TransferFailed.selector);
        blTreasury.withdrawReserve(100_000_000);

        assertEq(blTreasury.reserveBalance(), 300_000_000, "reserve must be untouched -- whole call reverted");
    }

    /// Страж nonReentrant на withdrawReserve() пиннится отдельно от всех
    /// суммовых/адресных проверок. ДАО здесь — сам USDC-мок: msg.sender
    /// реентрантного вызова совпадает с dao без дополнительных ухищрений,
    /// поэтому падение может доказывать только страж, а не NotDao.
    function testWithdrawReserveBlocksReentrancy() public {
        ReentrantWithdrawReserveUSDCT rUsdc = new ReentrantWithdrawReserveUSDCT();
        MockDiamond rDiamond = new MockDiamond(address(rUsdc));
        Treasury rTreasury = new Treasury(address(rUsdc), address(rDiamond), FOUNDATION);
        rUsdc.setTreasury(address(rTreasury));
        rUsdc.setAttack(true);

        rDiamond.setVaultBalance(rTreasury.VAULT_TARGET()); // банк полон — fundVault не понадобится
        rUsdc.mint(address(rTreasury), 1_000_000_000);
        rTreasury.distribute();
        assertEq(rTreasury.reserveBalance(), 300_000_000, "setup: reserve");

        rDiamond.setUniqueActiveUsers(rTreasury.DAO_THRESHOLD());
        rDiamond.setDao(address(rUsdc)); // ДАО -- сам мок USDC

        vm.prank(address(rUsdc));
        rTreasury.withdrawReserve(100_000_000);

        assertTrue(rUsdc.reentryAttempted(),  "reentrancy must have been attempted");
        assertFalse(rUsdc.reentrySucceeded(), "reentrant withdrawReserve() must not succeed");
        assertEq(
            rUsdc.reentryRevertSelector(), Treasury.Reentrancy.selector,
            "must fail specifically with Reentrancy, not e.g. NotDao from a mismatched sender"
        );

        assertEq(rTreasury.reserveBalance(), 200_000_000, "reserve reduced exactly once, not twice");
    }
}
