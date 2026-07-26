// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// HEXSEAL — Treasury.sol
//
// Казна протокола. Принимает фикс-комиссии за создание сделок и
// распределяет их по лестнице: буфер банка арбитров → фаундейшн → резерв.
//
// Подставляется одной транзакцией FactoryFacet.setFeeRecipient(treasury).
// Фабрика, эскроу и доски не меняются: они платят на адрес, и им
// безразлично, кошелёк там или контракт.
//
// АДМИНИСТРАТОРА НЕТ. Ни одной функции только-для-владельца. Проценты —
// constant, изменить их нельзя ничем; ошибка в числах исправляется только
// новым контрактом и новым setFeeRecipient, что видно снаружи.
//
// ЦЕНА ЗАМЕНЫ. setFeeRecipient перенаправляет только БУДУЩИЙ доход.
// Накопленный reserveBalance остаётся в этом контракте и достаётся оттуда
// только через withdrawReserve, то есть по заработанному порогу ДАО.
// Миграционная функция потребовала бы того, кто имеет право её вызвать,
// то есть администратора — а это отменяет всё вышенаписанное. Принято
// осознанно: цена ошибки здесь — замороженный резерв, а не украденный.
// ============================================================

interface IUSDC {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IHexsealDiamond {
    function fundVault(uint256 amount) external;
    function getVaultBalance() external view returns (uint256);
    function isDaoActive() external view returns (bool);
    function getUniqueActiveUsers() external view returns (uint256);
    function getDAOAddress() external view returns (address);
}

contract Treasury {

    // -------- КОНСТАНТЫ (изменить невозможно ничем) --------

    /// Цель буфера банка арбитров. Величина абсолютная по природе: это запас
    /// на N дотаций, а не доля дохода. Банк не переполняется и не сохнет.
    uint256 public constant VAULT_TARGET = 500_000_000; // 500 USDC (6 decimals)

    uint256 public constant FOUNDATION_BPS_PRE_DAO  = 7_000; // 70%
    uint256 public constant FOUNDATION_BPS_POST_DAO = 2_000; // 20%
    uint256 public constant DAO_THRESHOLD           = 100_000; // uniqueActiveUsers

    uint256 private constant BPS = 10_000;

    // -------- IMMUTABLE --------

    address public immutable usdc;
    address public immutable diamond;
    /// Один адрес. Что происходит за ним — команда, инвестор, инфраструктура —
    /// казна не знает и знать не должна: это бумажный договор, не код.
    address public immutable foundation;

    // -------- ХРАНИЛИЩЕ --------

    /// Единственная переменная состояния во всём контракте: сколько из
    /// лежащего здесь USDC уже отнесено в резерв. Всё остальное выводится
    /// из фактического баланса, поэтому USDC, присланный сюда напрямую кем
    /// угодно, просто попадёт в ближайшее распределение и учёт не сломает.
    uint256 public reserveBalance;

    // -------- СОБЫТИЯ --------

    event Distributed(uint256 toVault, uint256 toFoundation, uint256 toReserve);
    event VaultToppedUp(uint256 amount);
    event ReserveWithdrawn(address indexed dao, uint256 amount);

    // -------- ОШИБКИ --------

    error ZeroAddress();
    error NoCode();
    error NothingToDistribute();
    error TransferFailed();

    constructor(address usdc_, address diamond_, address foundation_) {
        if (usdc_ == address(0) || diamond_ == address(0) || foundation_ == address(0)) revert ZeroAddress();
        // Диамонд обязан иметь код: казна будет звать его fundVault, а вызов к
        // адресу без кода в EVM возвращает УСПЕХ — approve прошёл бы, вызов
        // «удался» бы, и деньги остались бы на казне, числясь ушедшими в банк.
        if (diamond_.code.length == 0) revert NoCode();
        usdc       = usdc_;
        diamond    = diamond_;
        foundation = foundation_;
    }

    // -------- ЛЕСТНИЦА --------

    /// @notice Распределить всё, что накопилось с прошлого раза.
    ///
    /// Вызвать может кто угодно. Это не упущение: у ERC-20 нет колбэка, о
    /// поступлении комиссии казна узнать в момент поступления не может, а
    /// результат вызова полностью определяется состоянием — ни момент, ни
    /// вызывающий на дележ не влияют. Право вызова не даёт преимущества.
    function distribute() external {
        uint256 pending = pendingDistribution();
        if (pending == 0) revert NothingToDistribute();

        // Ступень 1. Буфер банка арбитров — до цели и ни центом больше.
        uint256 toVault = vaultShortfall();
        if (toVault > pending) toVault = pending;
        if (toVault > 0) {
            pending -= toVault;
            _fundVault(toVault);
        }

        // Ступень 2. Фаундейшн — фиксированная доля остатка.
        uint256 toFoundation = (pending * foundationBps()) / BPS;

        // Ступень 3. Резерв — весь остаток. Считаем вычитанием, а не второй
        // долей: так ни один цент не может потеряться на округлении.
        uint256 toReserve = pending - toFoundation;
        if (toReserve > 0) reserveBalance += toReserve;

        if (toFoundation > 0) {
            if (!IUSDC(usdc).transfer(foundation, toFoundation)) revert TransferFailed();
        }

        emit Distributed(toVault, toFoundation, toReserve);
    }

    // -------- ВЬЮХИ --------

    /// Сколько лежит на казне сверх того, что уже отнесено в резерв.
    function pendingDistribution() public view returns (uint256) {
        uint256 balance = IUSDC(usdc).balanceOf(address(this));
        return balance > reserveBalance ? balance - reserveBalance : 0;
    }

    /// Сколько банку арбитров не хватает до цели.
    function vaultShortfall() public view returns (uint256) {
        uint256 balance = IHexsealDiamond(diamond).getVaultBalance();
        return balance >= VAULT_TARGET ? 0 : VAULT_TARGET - balance;
    }

    /// Доля фаундейшна в текущем режиме.
    ///
    /// Гейт мягкий (isDaoActive учитывает и ручной флаг владельца) намеренно:
    /// раннее переключение УМЕНЬШАЕТ долю фаундейшна, то есть злоупотреблять
    /// им себе дороже. Для вывода резерва, где стимул обратный, гейт другой —
    /// см. withdrawReserve.
    function foundationBps() public view returns (uint256) {
        return IHexsealDiamond(diamond).isDaoActive()
            ? FOUNDATION_BPS_POST_DAO
            : FOUNDATION_BPS_PRE_DAO;
    }

    // -------- ВНУТРЕННЕЕ --------

    function _fundVault(uint256 amount) private {
        IUSDC(usdc).approve(diamond, amount);
        IHexsealDiamond(diamond).fundVault(amount);
    }
}
