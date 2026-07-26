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
// Нераспределённый остаток (то, что ещё не reserveBalance) при замене НЕ
// замораживается: ступень банка обёрнута так, что её провал не рушит
// раздачу (см. _tryFundVault) — всё, что выше текущего vaultShortfall,
// по-прежнему уходит в фаундейшн и в резерв каждым следующим distribute().
// Заперт остаётся только хвост размером не больше vaultShortfall (то есть
// не больше VAULT_TARGET, 500 USDC): казна больше не может профинансировать
// банк, эта часть будет вечно значиться «нераспределённой», но не потеряна
// и не украдена — просто бессрочно pending на старом контракте.
//
// ДОВЕРИЕ, КОТОРОЕ КАЗНА ОБЯЗАНА ОКАЗАТЬ. Банк арбитров стоит ПЕРВЫМ в
// лестнице сознательно — без него арбитраж останавливается. Но опустошение
// банка управляется владельцем диамонда через setRewardPerDispute (onlyOwner
// в ArbiterRegistryFacet): пока vaultShortfall не нулевой, весь доход
// приоритетно идёт туда. Значит, владелец диамонда, договорившись со своим
// арбитром, теоретически может держать банк искусственно сухим (завысив
// rewardPerDispute) и таким образом перетягивать через него выручку казны
// вместо честной доли фаундейшна/резерва. Казна этого не видит и не может
// проверить — она обязана кому-то верить, и это осознанный выбор, а не
// недосмотр: альтернатива (казна сама решает, сколько банку «на самом деле»
// нужно) означала бы, что казна знает бизнес-логику арбитража лучше самого
// диамонда, что не так.
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

    // -------- РЕЕНТРАНСИ --------
    //
    // Простейший страж в стиле ReentrancyGuard из Agreement.sol, без внешних
    // зависимостей. У Agreement обычный конструктор подменяется клоном и
    // initialize(), поэтому там _status инициализируется отдельным методом;
    // у Treasury конструктор ровно один и вызывается один раз — инициализация
    // прямо в нём, отдельный метод здесь был бы лишней поверхностью.

    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;
    uint256 private _status;

    modifier nonReentrant() {
        if (_status == ENTERED) revert Reentrancy();
        _status = ENTERED;
        _;
        _status = NOT_ENTERED;
    }

    // -------- СОБЫТИЯ --------

    event Distributed(uint256 toVault, uint256 toFoundation, uint256 toReserve);
    event VaultToppedUp(uint256 amount);
    event ReserveWithdrawn(address indexed dao, uint256 amount);

    // -------- ОШИБКИ --------

    error ZeroAddress();
    error NoCode();
    error NothingToDistribute();
    error TransferFailed();
    error ApproveFailed();
    error Reentrancy();

    constructor(address usdc_, address diamond_, address foundation_) {
        if (usdc_ == address(0) || diamond_ == address(0) || foundation_ == address(0)) revert ZeroAddress();
        // Оба внешних контракта обязаны иметь код: вызов к адресу без кода в
        // EVM возвращает УСПЕХ. Для диамонда это значило бы, что approve
        // прошёл, fundVault «удался», а деньги остались бы на казне, числясь
        // ушедшими в банк. Для USDC — что balanceOf/transfer молча вернут
        // пустоту вместо провала, и вся бухгалтерия контракта потеряет опору.
        if (usdc_.code.length == 0) revert NoCode();
        if (diamond_.code.length == 0) revert NoCode();
        usdc       = usdc_;
        diamond    = diamond_;
        foundation = foundation_;
        _status    = NOT_ENTERED;
    }

    // -------- ЛЕСТНИЦА --------

    /// @notice Распределить всё, что накопилось с прошлого раза.
    ///
    /// Вызвать может кто угодно. Это не упущение: у ERC-20 нет колбэка, о
    /// поступлении комиссии казна узнать в момент поступления не может, а
    /// результат вызова полностью определяется состоянием — ни момент, ни
    /// вызывающий на дележ не влияют. Право вызова не даёт преимущества.
    function distribute() external nonReentrant {
        uint256 pending = pendingDistribution();
        if (pending == 0) revert NothingToDistribute();

        // Все три суммы считаются ДО единого внешнего вызова — реентрант,
        // даже если бы страж его не остановил, не увидел бы состояние, в
        // котором эффект уже применён частично, а деньги ещё на месте.
        uint256 toVault = vaultShortfall();
        if (toVault > pending) toVault = pending;
        uint256 rest = pending - toVault;
        uint256 toFoundation = (rest * foundationBps()) / BPS;

        // Резерв — весь остаток. Считаем вычитанием, а не второй долей: так
        // ни один цент не может потеряться на округлении.
        uint256 toReserve = rest - toFoundation;

        // Эффект — до взаимодействий.
        if (toReserve > 0) reserveBalance += toReserve;

        // Ступень 1. Буфер банка арбитров — до цели и ни центом больше.
        // Обёрнута в _tryFundVault: провал этой ступени не должен рушить
        // ступени 2 и 3.
        uint256 spent = 0;
        if (toVault > 0) spent = _tryFundVault(toVault);

        // Ступень 2. Фаундейшн — фиксированная доля остатка.
        if (toFoundation > 0) {
            if (!IUSDC(usdc).transfer(foundation, toFoundation)) revert TransferFailed();
        }

        emit Distributed(spent, toFoundation, toReserve);
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

    /// Возвращает СКОЛЬКО РЕАЛЬНО ушло, а не сколько запрошено: если fundVault
    /// возьмёт меньше, остаток просто останется на казне и попадёт в следующее
    /// распределение. Разрешение обнуляется сразу — иначе оно висело бы
    /// бессрочно в тот момент, когда банк дорастает до цели помимо казны
    /// (сгоревшие залоги, депозиты апелляций), toVault становится нулём и
    /// перезаписать разрешение уже некому.
    ///
    /// Используется и отсюда (через _tryFundVault), и задачей 3 (topUpVault) —
    /// напрямую, без обёртки: там провал — это нормальный revert, не то, что
    /// нужно проглатывать.
    function _fundVault(uint256 amount) private returns (uint256 spent) {
        uint256 balanceBefore = IUSDC(usdc).balanceOf(address(this));
        if (!IUSDC(usdc).approve(diamond, amount)) revert ApproveFailed();
        IHexsealDiamond(diamond).fundVault(amount);
        if (!IUSDC(usdc).approve(diamond, 0)) revert ApproveFailed();
        spent = balanceBefore - IUSDC(usdc).balanceOf(address(this));
    }

    /// Провал первой ступени не должен рушить всю раздачу. Так бывает штатно:
    /// если казну заменили через setFeeRecipient, диамонд перестаёт пускать
    /// эту казну в fundVault (revert NotOwnerOrFeeRecipient), и без обёртки
    /// весь нераспределённый остаток оказался бы заперт здесь навсегда.
    /// Непереведённое просто остаётся на балансе казны, в reserveBalance не
    /// попадает — значит, снова окажется в pendingDistribution() при
    /// следующем вызове.
    ///
    /// try/catch в Solidity ловит только внешние вызовы; обернуть приватный
    /// _fundVault напрямую нельзя. Вариант через this.fundVault(...) с
    /// проверкой msg.sender == address(this) добавил бы в ABI неизменяемого
    /// контракта функцию, вызываемую отовсюду (сама проверка её не защищает
    /// от прочтения/попыток вызова, только от последствий) — лишняя
    /// поверхность там, где её сознательно не должно быть. Низкоуровневый
    /// call прямо к диамонду с ручной проверкой успеха читается яснее и
    /// ничего нового не открывает.
    function _tryFundVault(uint256 amount) private returns (uint256 spent) {
        uint256 balanceBefore = IUSDC(usdc).balanceOf(address(this));
        if (!IUSDC(usdc).approve(diamond, amount)) revert ApproveFailed();

        (bool ok, ) = diamond.call(abi.encodeWithSelector(IHexsealDiamond.fundVault.selector, amount));

        // Разрешение обнуляем в обоих случаях: при успехе fundVault мог
        // забрать не всё, при провале оно осталось бы висеть бессрочно.
        if (!IUSDC(usdc).approve(diamond, 0)) revert ApproveFailed();

        if (!ok) return 0;
        spent = balanceBefore - IUSDC(usdc).balanceOf(address(this));
    }
}
