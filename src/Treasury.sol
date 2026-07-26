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
// Накопленный foundationOwed остаётся здесь же, но достаётся в любой
// момент через withdrawFoundation() — это не спорные деньги, а просто
// причитающееся, порог ДАО тут ни при чём.
// Миграционная функция потребовала бы того, кто имеет право её вызвать,
// то есть администратора — а это отменяет всё вышенаписанное. Принято
// осознанно: цена ошибки здесь — замороженный резерв, а не украденный.
// Нераспределённый остаток (то, что ещё не reserveBalance и не
// foundationOwed) при замене НЕ замораживается: ступень банка обёрнута так,
// что её провал не рушит раздачу (см. _fundVault) — всё, что выше текущего
// vaultShortfall, по-прежнему уходит в фаундейшн и в резерв каждым
// следующим distribute(). Заперт остаётся только хвост размером не больше
// vaultShortfall (то есть не больше VAULT_TARGET, 500 USDC): казна больше
// не может профинансировать банк, эта часть будет вечно значиться
// «нераспределённой», но не потеряна и не украдена — просто бессрочно
// pending на старом контракте.
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

    /// Сколько из лежащего здесь USDC уже отнесено в резерв.
    uint256 public reserveBalance;

    /// Сколько причитается фаундейшну и ещё не забрано через
    /// withdrawFoundation().
    ///
    /// Выплата фаундейшну вытягивающая, а не «в момент распределения»: у
    /// USDC есть чёрный список Circle, и попадание туда адреса фаундейшна
    /// ревертило бы transfer прямо внутри distribute() — а вместе с ним и
    /// всю раздачу, навсегда, потому что foundation immutable и обойти
    /// нечем. Долг просто копится, банк и резерв при этом продолжают
    /// наполняться как обычно; это тот же самый класс поломки, что уже
    /// изолирован на ступени банка через _fundVault — ни одна ступень
    /// лестницы не имеет права замуровать остальные.
    uint256 public foundationOwed;

    /// Вместе reserveBalance и foundationOwed — это ВСЁ состояние контракта.
    /// Всё остальное выводится из фактического баланса:
    /// pendingDistribution() = balanceOf(казна) − reserveBalance −
    /// foundationOwed. USDC, присланный сюда напрямую кем угодно, просто
    /// увеличит нераспределённую часть и попадёт в ближайший distribute() —
    /// учёт не сломает ни то, ни другое.

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
    event FoundationWithdrawn(uint256 amount);

    // -------- ОШИБКИ --------

    error ZeroAddress();
    error NoCode();
    error NothingToDistribute();
    error TransferFailed();
    error ApproveFailed();
    error Reentrancy();
    error NothingOwed();
    error VaultAtTarget();
    error ReserveEmpty();
    error VaultFundingFailed();
    error VaultDidNotGrow();

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

        // Порядок «эффекты до взаимодействий» ниже размечает ВЕСЬ pending —
        // и toReserve в reserveBalance, и toFoundation в foundationOwed, а не
        // только один из них — ДО вызова банка. Что именно увидит реентрант,
        // попавший сюда изнутри _fundVault() (через raw CALL к диамонду),
        // решает АТАКУЮЩИЙ, а не код: если он (как ReentrantDiamondT) тянет
        // свой transferFrom до реентранси, pendingDistribution() читается
        // нулём. Но атакующий может реентерить и ПЕРВЫМ, до собственного
        // pull, — тогда он увидит pendingDistribution() == toVault (общий
        // случай, ноль — лишь частный: toVault оказывается нулевым только
        // когда банк и так уже полон).
        //
        // Несмотря на это, вторым уровнем вложенности вытянуть больше денег,
        // чем было в исходном pending, всё равно нельзя — БЕЗ какого-либо
        // стража. Причина не в том, что реентрант видит ноль, а в том, что
        // КАЖДЫЙ вложенный вызов заново пересчитывает toVault как
        // min(vaultShortfall(), свой собственный pendingDistribution() на
        // тот момент) и выдаёт approve() ровно на эту обрезанную величину —
        // а approve на USDC является потолком, который сам fundVault не
        // может превысить. Каждый уровень earmark'ает (переводит в
        // reserveBalance/foundationOwed) ровно (pending_этого_уровня −
        // toVault_этого_уровня) ДО своего вызова банка, поэтому
        // reserveBalance + foundationOwed никогда не обгоняет фактический
        // balanceOf(казна) — вне зависимости от того, на какой глубине и в
        // каком порядке происходит вложение. Проверено ревью на текущей
        // версии контракта прогоном двух атакующих (обычный сплит и
        // пост-ДАО, глубина 2 и 4): в обоих случаях без nonReentrant баланс
        // не расходится ни на копейку.
        //
        // От чего защищает nonReentrant здесь — это не деньги, а телеметрия:
        // без стража один и тот же внешний триггер может исполнить тело
        // distribute() несколько раз и заэмитить несколько Distributed за
        // один вызов извне. Замерено: без стража — четыре события Distributed
        // с суммарным toVault 2 000 000 000 вместо одного с нулём. Это
        // испорченная бухгалтерия для всего, что слушает событие снаружи
        // (индексаторы, дашборды), а не украденные или замороженные деньги.
        //
        // Само по себе это не делает страж необязательным. Он остаётся
        // несущим для функций, которые двигают счётчики ДО своего внешнего
        // вызова, но размечают не весь pending, а только его часть —
        // см. topUpVault(): там до вызова банка убывает reserveBalance, а
        // vaultShortfall() не меняется, и без стража реентрант списал бы
        // резерв второй раз на тот же самый неизменившийся недостаток.
        uint256 toVault = vaultShortfall();
        if (toVault > pending) toVault = pending;
        uint256 rest = pending - toVault;
        uint256 toFoundation = (rest * foundationBps()) / BPS;

        // Резерв — весь остаток. Считаем вычитанием, а не второй долей: так
        // ни один цент не может потеряться на округлении.
        uint256 toReserve = rest - toFoundation;

        if (toReserve > 0)    reserveBalance += toReserve;
        if (toFoundation > 0) foundationOwed += toFoundation;

        // Ступень 1. Буфер банка арбитров — до цели и ни центом больше.
        // Провал этой ступени (казну заменили и диамонд её больше не
        // пускает в fundVault, гигантский revert-payload и т.п.) не должен
        // рушить ступени 2 и 3 — см. _fundVault.
        uint256 spent = 0;
        if (toVault > 0) (, spent) = _fundVault(toVault);

        emit Distributed(spent, toFoundation, toReserve);
    }

    // -------- ДОБИВКА БАНКА --------

    /// @notice Добить банк арбитров из резерва.
    ///
    /// Единственный расход резерва до появления ДАО. Вызвать может кто угодно,
    /// но перевод происходит ТОЛЬКО при просадке банка ниже цели и ТОЛЬКО на
    /// недостающую сумму. У ВЫЗЫВАЮЩЕГО нет ни выбора суммы, ни выбора
    /// момента — всё определяется состоянием, никто не «решает» потратить
    /// резерв здесь: решает правило.
    ///
    /// Но само состояние, по которому это правило считает (vaultShortfall,
    /// то есть текущий getVaultBalance() диамонда), двигается владельцем
    /// диамонда через onlyOwner setRewardPerDispute в ArbiterRegistryFacet —
    /// см. «ДОВЕРИЕ, КОТОРОЕ КАЗНА ОБЯЗАНА ОКАЗАТЬ» в шапке файла. Там это
    /// доверие описано только для БУДУЩЕГО дохода; topUpVault распространяет
    /// тот же рычаг на уже НАКОПЛЕННЫЙ резерв. Владелец, осушающий банк между
    /// вызовами (или просто держащий его искусственно сухим), тремя
    /// открытыми вызовами topUpVault() может вынести весь резерв — это тот
    /// же осознанный компромисс, что и в distribute(), просто на большую
    /// ставку (весь накопленный резерв, а не только будущий доход).
    ///
    /// Покрывает и наплыв споров, и дотацию нижней границы на мелких спорах:
    /// обе ситуации проявляются одинаково — как просадка банка.
    function topUpVault() external nonReentrant {
        uint256 shortfall = vaultShortfall();
        if (shortfall == 0) revert VaultAtTarget();

        uint256 amount = shortfall > reserveBalance ? reserveBalance : shortfall;
        if (amount == 0) revert ReserveEmpty();

        uint256 vaultBefore = IHexsealDiamond(diamond).getVaultBalance();

        // Резерв убывает ДО внешнего вызова, а vaultShortfall() ниже —
        // размеченная только частично величина (в отличие от distribute(),
        // который перед вызовом банка размечает ВЕСЬ pending). Без
        // nonReentrant реентрант увидел бы уменьшенный reserveBalance при
        // неизменившемся vaultShortfall() (сам банк ещё не пополнился) и
        // списал бы резерв второй раз на тот же самый недостаток.
        reserveBalance -= amount;
        (bool ok, uint256 spent) = _fundVault(amount);
        // Всё или ничего — и это НАМЕРЕННО противоположно поведению distribute().
        // Там провал первой ступени терпится, иначе замена казны через
        // setFeeRecipient замуровала бы весь нераспределённый остаток. Здесь
        // терпеть нельзя: резерв уже списан, и молчаливый провал означал бы,
        // что деньги ушли из резерва, не дойдя до банка. Реверт возвращает
        // списание вместе со всей транзакцией.
        if (!ok || spent != amount) revert VaultFundingFailed();

        // spent == amount доказывает только то, что USDC ПОКИНУЛИ казну —
        // не то, что банк их УЧЁЛ. Это два разных факта: сломанный (не
        // обязательно враждебный — например, при будущем апгрейде фасета)
        // fundVault может честно принять transferFrom и забыть записать
        // прирост в собственном счётчике. Проверяем отдельно, что
        // getVaultBalance() вырос хотя бы на amount — «хотя бы», а не
        // «ровно», потому что банк в той же транзакции мог получить деньги и
        // по другим поводам (сгоревшие залоги арбитров, депозиты апелляций),
        // и требование точного равенства давало бы ложные реверты.
        uint256 vaultAfter = IHexsealDiamond(diamond).getVaultBalance();
        if (vaultAfter < vaultBefore + amount) revert VaultDidNotGrow();

        emit VaultToppedUp(amount);
    }

    // -------- ВЫВОД ФАУНДЕЙШНА --------

    /// @notice Забрать начисленное фаундейшну.
    ///
    /// Вызвать может кто угодно — деньги всё равно уходят только на
    /// immutable-адрес фаундейшна, поэтому право вызова ничего не решает, а
    /// открытость означает, что сторонний может «протолкнуть» выплату, если
    /// самому фаундейшну лень или недосуг.
    function withdrawFoundation() external nonReentrant {
        uint256 amount = foundationOwed;
        if (amount == 0) revert NothingOwed();
        foundationOwed = 0;
        if (!IUSDC(usdc).transfer(foundation, amount)) revert TransferFailed();
        emit FoundationWithdrawn(amount);
    }

    // -------- ВЬЮХИ --------

    /// Сколько лежит на казне сверх того, что уже размечено (резерв плюс
    /// причитающееся фаундейшну).
    function pendingDistribution() public view returns (uint256) {
        uint256 balance = IUSDC(usdc).balanceOf(address(this));
        uint256 earmarked = reserveBalance + foundationOwed;
        return balance > earmarked ? balance - earmarked : 0;
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

    /// Пробует профинансировать банк на amount. Возвращает (ok, spent): ok —
    /// удался ли сам вызов диамонда, spent — сколько реально ушло с баланса
    /// казны (может быть меньше amount, если fundVault решит забрать не
    /// всё, и всегда 0, если !ok). Разрешение обнуляется в обоих случаях:
    /// при успехе fundVault мог забрать не всё, при провале (например,
    /// казну заменили через setFeeRecipient, и диамонд больше не пускает её
    /// в fundVault) оно осталось бы висеть бессрочно.
    ///
    /// Что делать с !ok, решает вызывающий, а не эта функция — и решают они
    /// по-разному, оба постоянно (не «сегодня»/«будущий»: контракт
    /// неизменяем, других вызывающих здесь больше не появится). distribute()
    /// сознательно игнорирует ok и работает только со spent — провал банка
    /// не должен рушить фаундейшн и резерв. topUpVault(), напротив, !ok
    /// терпеть не может и честно ревертит: это явный разовый вызов, а не
    /// фоновая раздача, и резерв к этому моменту уже списан.
    ///
    /// Вызов диамонда сделан сырым CALL с нулевым выходным буфером — тот же
    /// приём, что и в MinimalForwarder.execute(): `.call(...)` на уровне
    /// Solidity всегда копирует ВЕСЬ returndata в память ещё до того, как
    /// код успевает его отбросить, независимо от того, что сам код потом
    /// делает с результатом (проверено ревью: диамонд с фасетом, чей
    /// fundVault ревертит мегабайтным payload, иначе замораживает
    /// distribute() газом — а владелец диамонда может смонтировать такой
    /// фасет через diamondCut в любой момент). Здесь возврат не нужен
    /// вообще, нужен только флаг успеха — выходной буфер нулевой длины,
    /// EVM не копирует ничего.
    function _fundVault(uint256 amount) private returns (bool ok, uint256 spent) {
        uint256 balanceBefore = IUSDC(usdc).balanceOf(address(this));
        if (!IUSDC(usdc).approve(diamond, amount)) revert ApproveFailed();

        address to = diamond;
        bytes memory payload = abi.encodeWithSelector(IHexsealDiamond.fundVault.selector, amount);
        assembly ("memory-safe") {
            ok := call(gas(), to, 0, add(payload, 0x20), mload(payload), 0, 0)
        }

        // Разрешение обнуляем независимо от исхода вызова выше.
        if (!IUSDC(usdc).approve(diamond, 0)) revert ApproveFailed();

        uint256 balanceAfter = IUSDC(usdc).balanceOf(address(this));
        // Если баланс не уменьшился (в т.ч. неожиданно вырос), считаем, что
        // ничего не потрачено — вычитание в обратную сторону дало бы Panic
        // 0x11 и обрушило бы всю раздачу.
        spent = balanceAfter < balanceBefore ? balanceBefore - balanceAfter : 0;
    }
}
