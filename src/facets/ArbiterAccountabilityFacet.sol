// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

// ============================================================
// HEXSEAL — ArbiterAccountabilityFacet.sol
//
// Ответственность ручных арбитров: приостановка, снос с поводом, предложение
// директора, право ответа снятого.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ФАСЕТ, а не дописка в ArbiterRegistryFacet: тот занимает
// 21 227 байт развёрнутого кода из 24 576 (86.4 %, замерено 15 августа 2026).
// Запаса в 3.3 КБ не хватает. Фасеты даймонда делят хранилище по неймспейсу,
// поэтому этот работает с тем же ArbiterRegistryStorage и тем же POSITION —
// переноса данных не происходит вовсе.
//
// Задача 4 (15 августа 2026) реализовала приостановку — быструю, обратимую,
// протухающую саму. Задача 6 того же дня добавила снос с поводом
// (removeArbiterForCause) — голая removeArbiter в ArbiterRegistryFacet снята
// целиком, потому что не записывала ни кто нажал, ни почему, и возвращала
// залог целиком: снятие за дело и тихая зачистка выглядели в цепи одинаково
// и стоили одинаково. Предложение директора и право ответа снятого — задел
// следующих задач того же плана, здесь не реализованы.
//
// ⚠️ ВСЕ функции этого фасета сегодня — административные (владелец либо, до
// активации ДАО, директор для приостановки) и читают сырой msg.sender, как
// onlyOwnerOrChief в ArbiterRegistryFacet: владелец и директор ходят прямой
// транзакцией, не через релеер, а гейслесс-пути у этого фасета пока нет
// вовсе. Файл не реализует _msgSender() и учтён в script/gasless-sender.allow
// отдельной записью «вне области». Когда сюда приедет respondToRemoval (право
// ответа снятого, зовётся ОБЫЧНЫМ ЧЕЛОВЕКОМ через релеер), фасет обзаведётся
// собственным _msgSender() и станет ERC-2771-файлом — тогда запись в
// allow-файле сменит форму на per-function, как у соседей.
// ============================================================

import {ArbiterRegistryStorage} from "./ArbiterRegistryFacet.sol";
import {OwnershipLib} from "../DiamondProxy.sol";

contract ArbiterAccountabilityFacet {

    // -------- CONSTANTS --------

    /// Сколько держит приостановка, если её не сняли раньше. Утверждено
    /// владельцем 15 августа 2026: окно финализации — сутки, окно апелляции —
    /// четверо; трое суток хватает разобраться и не держит честные стороны
    /// неделю.
    uint256 private constant SUSPENSION_WINDOW = 72 hours;

    /// Порог серии судейских ошибок. Совпадает с MAX_ARBITER_MISTAKES в
    /// ArbiterRegistryFacet и обязано совпадать: это одно и то же правило,
    /// прочитанное с двух сторон. Сверяется тестом
    /// test_MistakeThresholdMatchesRegistry.
    uint256 private constant MISTAKE_THRESHOLD = 3;

    /// XP, на который сбрасывается снятый демоушеном. Совпадает с
    /// DEMOTION_XP_RESET в ArbiterRegistryFacet. Здесь НЕ применяется —
    /// removeArbiterForCause XP не трогает (см. комментарий над функцией) —
    /// константа лежит только как якорь совпадения чисел на будущее, если
    /// решение о сбросе XP при сносе по поводу когда-нибудь примут.
    uint256 private constant DEMOTION_XP_RESET = 2500;

    // -------- ERRORS --------

    error NotOwnerOrChief();
    error NotOwner();
    error NotAnArbiter();
    error ArbiterZeroAddress();

    // ── Снос по поводу (задача 6, 15 августа 2026) ──
    error CauseNotProven(uint8 cause);
    error EvidenceRequired();
    /// Право сноса уехало вместе с активацией ДАО — звать может только
    /// daoAddress (см. removeArbiterForCause). Владелец получает эту же
    /// ошибку: это передача, а не запирание в пустоту, но передача
    /// односторонняя и владельцу дороги назад нет.
    error RemovalHandedOver();
    error DisputeRefRequired();
    error DisputeRefNotApplicable();

    // Примечание: addArbiter/setChiefArbiter в ArbiterRegistryFacet тем же
    // решением владельца («никаких ручных», человек выходит, остаётся только
    // гейт applyAsArbiter) ревертят ошибкой SeatingHandedOver при активном
    // ДАО — объявлена ТАМ отдельно: у фасетов диамонда нет общего
    // пространства ошибок, каждый объявляет свои.

    // -------- ENUM --------

    enum Cause {
        OverturnedVerdicts,  // проверяется цепью (счётчик arbiterMistakeStreak)
        Timeouts,            // проверяется цепью (тот же счётчик — цепь их не различает)
        Silence,             // проверяется цепью (запись «просил, ответа нет»)
        Collusion,           // заверяется отпечатком, не проверяется
        Leak,                // заверяется отпечатком, не проверяется
        Other                // заверяется отпечатком, не проверяется
    }

    // -------- EVENTS --------

    event ArbiterSuspended(address indexed arbiter, address indexed by, uint256 until);
    event ArbiterSuspensionLifted(address indexed arbiter, address indexed by);

    /// Снос арбитра с поводом. `verifiedByChain` — правда о том, проверила ли
    /// цепь код сама (OverturnedVerdicts/Timeouts/Silence) или только
    /// заверила запись отпечатком доказательства, не читая, что под ним
    /// (Collusion/Leak/Other). Это и есть весь смысл разреза: без метки
    /// «доказано в цепи» читало бы одинаково для обеих половин, а для второй
    /// половины это было бы враньём.
    event ArbiterRemovedForCause(
        address indexed arbiter,
        address indexed by,
        Cause   indexed cause,
        bool            verifiedByChain,
        bytes32         evidenceDigest,
        uint256         bondForfeited
    );

    // -------- MODIFIERS --------

    modifier onlyOwnerOrChief() {
        address chief = ArbiterRegistryStorage.data().chiefArbiter;
        if (msg.sender != OwnershipLib.contractOwner() && msg.sender != chief)
            revert NotOwnerOrChief();
        _;
    }

    // -------- SUSPENSION --------

    /// Быстрая обратимая остановка. Никого не обвиняет и ничего не отбирает:
    /// поэтому ею владеет и директор, и поэтому она остаётся у владельца после
    /// передачи сноса голосованию.
    function suspendArbiter(address arbiter) external onlyOwnerOrChief {
        if (arbiter == address(0)) revert ArbiterZeroAddress();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        if (!d.isArbiter[arbiter]) revert NotAnArbiter();

        // От ТЕКУЩЕГО момента, а не прибавкой к прежнему сроку: иначе два
        // нажатия подряд держат чужие деньги шесть суток вместо трёх.
        uint256 until = block.timestamp + SUSPENSION_WINDOW;
        d.suspendedUntil[arbiter] = until;
        emit ArbiterSuspended(arbiter, msg.sender, until);
    }

    /// Снять раньше срока. Отдельная функция, а не «приостановить на ноль»:
    /// в ленте это разные события, и читателю важно видеть именно снятие.
    function liftSuspension(address arbiter) external onlyOwnerOrChief {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        delete d.suspendedUntil[arbiter];
        emit ArbiterSuspensionLifted(arbiter, msg.sender);
    }

    // -------- REMOVAL FOR CAUSE --------

    /// Цепь проверяет только то, что видит своим состоянием. Три первых кода
    /// проверяемы, три последних — нет, и метка verifiedByChain в событии
    /// говорит читателю правду о том, какой это случай.
    function _isChainVerifiable(Cause cause) private pure returns (bool) {
        return cause == Cause.OverturnedVerdicts
            || cause == Cause.Timeouts
            || cause == Cause.Silence;
    }

    /// Каждый проверяемый код смотрит СВОЙ признак. Слить их в одну проверку
    /// нельзя: тогда `Silence` проходил бы по счётчику переворотов, то есть
    /// цепь заверяла бы не то, что написано в записи.
    ///
    /// ⚠️ Честная оговорка про первые два: `OverturnedVerdicts` и `Timeouts`
    /// упираются в ОДИН счётчик `arbiterMistakeStreak` — его увеличивают и
    /// `overturnVerdict`, и `notifyArbiterTimeout`, и различить их постфактум
    /// цепь не может. Значит выбор между этими двумя кодами — заявление
    /// владельца о том, ЧТО именно произошло, а проверяет цепь лишь факт
    /// серии. Разделить их можно только вторым счётчиком, и это отдельная
    /// работа, а не эта.
    function _requireProven(
        ArbiterRegistryStorage.Data storage d,
        address arbiter,
        Cause   cause,
        address disputeRef
    ) private view {
        if (cause == Cause.Silence) {
            if (disputeRef == address(0)) revert DisputeRefRequired();
            // Запись о молчании ставит сам арбитр через recordNoResponse: она
            // означает «я просил, сторона не ответила». Как повод для СНОСА
            // она читается наоборот — арбитр записал молчание и всё равно не
            // довёл спор. Поэтому проверяется её наличие, а не отсутствие.
            if (d.disputeNoResponseAtBy[disputeRef][arbiter] == 0) {
                revert CauseNotProven(uint8(cause));
            }
            return;
        }

        if (disputeRef != address(0)) revert DisputeRefNotApplicable();
        if (d.arbiterMistakeStreak[arbiter] < MISTAKE_THRESHOLD) {
            revert CauseNotProven(uint8(cause));
        }
    }

    /// Храповик: право сноса уезжает вместе с активацией ДАО и не
    /// возвращается — activateDAO() односторонний, флаг не гасится нигде во
    /// всём src/.
    ///
    /// ⚠️ Читает только daoActiveManual, а не полный
    /// ArbiterRegistryFacet.isDaoActive() (тот ещё и uniqueActiveUsers >=
    /// DAO_THRESHOLD — авто-ДАО органическим ростом, без единого вызова
    /// activateDAO()). Дублировать этот второй порог здесь означало бы новую
    /// константу, которая может разойтись с оригиналом, ради сценария не этой
    /// задачи: авто-ДАО — теоретический путь при сегодняшних ручных арбитрах
    /// (решение владельца 01.08.2026, «ДАО не запускаем»). Из этого следует
    /// узкий, но честный разрыв: addArbiter/setChiefArbiter (в
    /// ArbiterRegistryFacet, где isDaoActive() — своя функция, вызывается
    /// напрямую) закрылись бы по авто-порогу раньше, чем это поле. Не эта
    /// работа.
    function _isDaoActive(ArbiterRegistryStorage.Data storage d) private view returns (bool) {
        return d.daoActiveManual;
    }

    /// `disputeRef` читается ТОЛЬКО кодом Silence: молчание — признак по
    /// конкретному спору (`disputeNoResponseAtBy[сделка][арбитр]`), и без
    /// адреса спора проверить его нечем. Для остальных кодов параметр обязан
    /// быть нулевым — иначе в записи оседал бы адрес, ни к чему не
    /// относящийся, и читатель решил бы, что снос связан с той сделкой.
    ///
    /// Право сноса передаётся, а не запирается: до активации ДАО зовёт только
    /// владелец, после — только daoAddress (не через onlyOwnerOrDAO из
    /// ArbiterRegistryFacet: тот модификатор пускает владельца ВСЕГДА, а
    /// здесь после передачи владельцу дороги нет — иначе автоматика (только
    /// то, что видит цепь) осталась бы единственной защитой, а сговор и слив
    /// переписки стали бы неснимаемыми вовсе).
    function removeArbiterForCause(
        address arbiter,
        Cause   cause,
        bytes32 evidenceDigest,
        address disputeRef
    ) external {
        if (arbiter == address(0)) revert ArbiterZeroAddress();

        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        if (_isDaoActive(d)) {
            if (msg.sender != d.daoAddress) revert RemovalHandedOver();
        } else {
            if (msg.sender != OwnershipLib.contractOwner()) revert NotOwner();
        }

        if (!d.isArbiter[arbiter]) revert NotAnArbiter();

        bool verified = _isChainVerifiable(cause);
        if (verified) {
            _requireProven(d, arbiter, cause, disputeRef);
        } else {
            if (disputeRef != address(0)) revert DisputeRefNotApplicable();
            // Цепь не проверяет ничего и не притворяется — но пустая запись
            // тоже не годится: у нуля нет прообраза, который можно показать.
            if (evidenceDigest == bytes32(0)) revert EvidenceRequired();
        }

        // Снос по поводу — не самостоятельный уход: бонд форфейтится в банк
        // арбитров, а не возвращается (обратное поведение resignAsArbiter,
        // задуманное намеренно — наказание, а не расставание).
        uint256 forfeited = d.arbiterBond[arbiter];
        if (forfeited > 0) {
            d.arbiterBond[arbiter] = 0;
            d.vaultBalance += forfeited;
        }

        d.isArbiter[arbiter] = false;
        ArbiterRegistryStorage.clearSeat(d, arbiter);

        uint256 len = d.arbiterList.length;
        for (uint256 i = 0; i < len; i++) {
            if (d.arbiterList[i] == arbiter) {
                d.arbiterList[i] = d.arbiterList[len - 1];
                d.arbiterList.pop();
                break;
            }
        }

        emit ArbiterRemovedForCause(arbiter, msg.sender, cause, verified, evidenceDigest, forfeited);
    }

    // ⚠️ Сброс XP здесь не делается: ReputationStorage живёт в другом
    // неймспейсе, и тянуть его сюда означало бы вторую точку записи в чужое
    // хранилище — расходится с единственным местом, которое сегодня пишет XP
    // демоушена (_recordArbiterMistake в ArbiterRegistryFacet). XP снятого по
    // поводу остаётся как есть; расхождение с автоматическим демоушеном
    // сознательное и решается отдельной задачей, если владелец сочтёт нужным.

    // -------- VIEWS --------

    function isSuspended(address arbiter) public view returns (bool) {
        return block.timestamp < ArbiterRegistryStorage.data().suspendedUntil[arbiter];
    }

    function getSuspendedUntil(address arbiter) external view returns (uint256) {
        return ArbiterRegistryStorage.data().suspendedUntil[arbiter];
    }

    function getSuspensionWindow() external pure returns (uint256) {
        return SUSPENSION_WINDOW;
    }

    /// Порог серии судейских ошибок прочитанный с этой стороны. Совпадает с
    /// ArbiterRegistryFacet.getMaxArbiterMistakes(). Сверяется тестом
    /// test_MistakeThresholdMatchesRegistry.
    function getMistakeThreshold() external pure returns (uint256) {
        return MISTAKE_THRESHOLD;
    }

    function isRegisteredArbiterHere(address who) external view returns (bool) {
        return ArbiterRegistryStorage.data().isArbiter[who];
    }

    function getMistakeStreakOf(address who) external view returns (uint256) {
        return ArbiterRegistryStorage.data().arbiterMistakeStreak[who];
    }

    /// Нужен тестам, чтобы сверить смещение вложенного мэппинга. Дублирует
    /// getNoResponseAt из ArbiterRegistryFacet намеренно: через даймонд оба
    /// селектора ведут в одно хранилище, а в лёгком стенде фасеты разные.
    function getNoResponseAtHere(address agreement, address arbiter) external view returns (uint256) {
        return ArbiterRegistryStorage.data().disputeNoResponseAtBy[agreement][arbiter];
    }
}
