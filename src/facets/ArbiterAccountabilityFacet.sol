// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

// ============================================================
// HEXSEAL — ArbiterAccountabilityFacet.sol
//
// Ответственность ручных арбитров: приостановка, снос с поводом, предложение
// директора (задача 7), право ответа снятого.
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
// и стоили одинаково. Задача 7 добавила предложение директора
// (proposeRemoval/withdrawProposal): снос необратим и остаётся правом
// владельца (либо daoAddress после передачи), а директор кладёт в цепь свою
// СИГНАЛЬНУЮ запись отдельным адресом — в ленте видно и кто предложил, и кто
// согласился, вместо одной записи на двоих. Право ответа снятого — задел
// следующей задачи того же плана, здесь не реализовано.
//
// ⚠️ ВСЕ функции этого фасета сегодня — административные (владелец либо, до
// активации ДАО, директор для приостановки и предложения сноса) и читают
// сырой msg.sender, как onlyOwnerOrChief в ArbiterRegistryFacet: владелец и
// директор ходят прямой транзакцией, не через релеер, а гейслесс-пути у
// этого фасета пока нет вовсе. Файл не реализует _msgSender() и учтён в
// script/gasless-sender.allow отдельной записью «вне области». Когда сюда
// приедет respondToRemoval (право ответа снятого, зовётся ОБЫЧНЫМ ЧЕЛОВЕКОМ
// через релеер), фасет обзаведётся собственным _msgSender() и станет
// ERC-2771-файлом — тогда запись в allow-файле сменит форму на per-function,
// как у соседей.
// ============================================================

import {ArbiterRegistryStorage} from "./ArbiterRegistryFacet.sol";
import {ReputationStorage} from "./ReputationFacet.sol";
import {OwnershipLib} from "../DiamondProxy.sol";

contract ArbiterAccountabilityFacet {

    // -------- CONSTANTS --------

    /// Сколько держит приостановка, если её не сняли раньше. Утверждено
    /// владельцем 15 августа 2026: окно финализации — сутки, окно апелляции —
    /// четверо; трое суток хватает разобраться и не держит честные стороны
    /// неделю.
    uint256 private constant SUSPENSION_WINDOW = 72 hours;

    /// Зеркало MAX_ARBITER_MISTAKES из ArbiterRegistryFacet — само по себе НЕ
    /// порог сноса, а якорь, от которого MISTAKE_THRESHOLD ниже вычисляется
    /// вычитанием. Совпадение с оригиналом сверяется тестом
    /// test_MistakeThresholdMatchesRegistry.
    uint256 private constant MAX_ARBITER_MISTAKES_MIRROR = 3;

    /// Порог РУЧНОГО сноса. СТРОГО МЕНЬШЕ автоматического демоушена — и это
    /// не произвольный выбор, а необходимость (найдено ревью, круг правок 1,
    /// 15 августа 2026): `_recordArbiterMistake` на достижении
    /// MAX_ARBITER_MISTAKES В ОДНОЙ ТРАНЗАКЦИИ и снимает `isArbiter`, и
    /// обнуляет сам счётчик. Значит в покое (между транзакциями)
    /// `arbiterMistakeStreak` ∈ {0, 1, ..., MAX_ARBITER_MISTAKES − 1} —
    /// значение, РАВНОЕ автоматическому порогу, никогда не переживает
    /// транзакцию живьём. Порог сноса на равенстве был бы кодом, которого
    /// ни один боевой путь достичь не может: `removeArbiterForCause` с
    /// OverturnedVerdicts/Timeouts не проходил бы вообще никогда.
    ///
    /// −1 читается не как техническая заплатка, а как замысел: ДВЕ ошибки
    /// подряд — владелец видит и снимает сам, с записью повода в цепи; на
    /// ТРЕТЬЕЙ автоматика уже сделала бы то же самое без повода и без записи,
    /// кто нажал. Ручной путь ценен именно тем, что срабатывает РАНЬШЕ
    /// автомата, а не дублирует его в момент, когда он и так уже сработал.
    uint256 private constant MISTAKE_THRESHOLD = MAX_ARBITER_MISTAKES_MIRROR - 1;

    /// XP, на который сбрасывается снятый демоушеном. Совпадает с
    /// DEMOTION_XP_RESET в ArbiterRegistryFacet. Здесь НЕ применяется —
    /// removeArbiterForCause XP не трогает (см. комментарий над функцией) —
    /// константа лежит только как якорь совпадения чисел на будущее, если
    /// решение о сбросе XP при сносе по поводу когда-нибудь примут.
    uint256 private constant DEMOTION_XP_RESET = 2500;

    /// Сколько живёт предложение директора (задача 7, 15 августа 2026).
    /// Утверждено владельцем: хватает вернуться из отпуска, мало чтобы
    /// обвинение висело кварталами.
    uint256 private constant PROPOSAL_TTL = 14 days;

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

    /// Директор предлагает снос — не исполняет. Отдельная запись своим
    /// адресом (задача 7, 15 августа 2026): в ленте видно и кто предложил, и
    /// кто согласился, вместо одной записи на двоих.
    event RemovalProposed(
        address indexed arbiter,
        address indexed by,
        Cause   indexed cause,
        bytes32         evidenceDigest,
        uint256         at
    );
    event RemovalProposalWithdrawn(address indexed arbiter, address indexed by);

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

    /// Зеркало DAO_THRESHOLD из ArbiterRegistryFacet. Найдено ревью (M-9, круг
    /// правок 1, 15 августа 2026): читать только `daoActiveManual` было
    /// половиной правды — при органическом росте `uniqueActiveUsers` ДАО
    /// включилась бы САМА, addArbiter/setChiefArbiter (которые зовут
    /// isDaoActive() напрямую, в своём же контракте) уже отказывали бы, а
    /// removeArbiterForCause продолжал бы слушаться владельца — асимметрия
    /// между «человек вышел» и «человек ещё здесь» ровно там, где обе двери
    /// обязаны закрываться вместе. Совпадение с оригиналом сверяется тестом
    /// test_DaoThresholdMatchesRegistry.
    uint256 private constant DAO_THRESHOLD_MIRROR = 100_000;

    /// Храповик: право сноса уезжает вместе с активацией ДАО и не
    /// возвращается — activateDAO() односторонний, флаг не гасится нигде во
    /// всём src/. Полное выражение, как и ArbiterRegistryFacet.isDaoActive():
    /// ручной флаг ИЛИ заработанный порог. ReputationStorage — чужой
    /// неймспейс, но этот фасет уже умеет в него ходить, а раздельная
    /// семантика с ArbiterRegistryFacet.isDaoActive() была бы новым швом.
    function _isDaoActive(ArbiterRegistryStorage.Data storage d) private view returns (bool) {
        if (d.daoActiveManual) return true;
        return ReputationStorage.data().uniqueActiveUsers >= DAO_THRESHOLD_MIRROR;
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
    ///
    /// ⚠️ «Владельцу дороги нет» держится ещё на одном замке — не только
    /// здесь: `ArbiterRegistryFacet.setDAOAddress` после активации ДАО тоже
    /// требует, чтобы звал ТЕКУЩИЙ daoAddress, не владелец (иначе владелец
    /// вернул бы себе эту функцию через `activateDAO()` →
    /// `setDAOAddress(свой_адрес)`, круг правок 1, C-3). Обе половины
    /// обязаны запираться синхронно — починка тут без починки там ничего не
    /// стоила бы.
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

        // Предложение (если было) переживать снос не должно — иначе оно
        // висело бы обвинением против уже снятого арбитра.
        delete d.removalProposals[arbiter];

        emit ArbiterRemovedForCause(arbiter, msg.sender, cause, verified, evidenceDigest, forfeited);
    }

    // ⚠️ Сброс XP здесь не делается: ReputationStorage живёт в другом
    // неймспейсе, и тянуть его сюда означало бы вторую точку записи в чужое
    // хранилище — расходится с единственным местом, которое сегодня пишет XP
    // демоушена (_recordArbiterMistake в ArbiterRegistryFacet). XP снятого по
    // поводу остаётся как есть; расхождение с автоматическим демоушеном
    // сознательное и решается отдельной задачей, если владелец сочтёт нужным.

    // -------- ПРЕДЛОЖЕНИЕ ДИРЕКТОРА (задача 7, 15 августа 2026) --------
    //
    // Снос необратим: он снимает статус, сжигает залог и оставляет в цепи
    // вечное публичное обвинение против настоящего адреса. Такое не должно
    // зависеть от одного человека, кроме владельца. Директор при этом видит
    // работу корпуса ближе всех, и запрещать ему сигнализировать было бы
    // глупо — отсюда разделение: он кладёт предложение в цепь СВОИМ адресом,
    // владелец соглашается СВОИМ, вызывая обычный removeArbiterForCause.
    //
    // ⚠️ Связь предложения с исполнением — ТОЛЬКО очистка выше (delete в
    // removeArbiterForCause). removeArbiterForCause не читает
    // removalProposals ни для чего: код повода, отпечаток и ссылку на спор
    // владелец обязан передать заново, своими аргументами. Предложение —
    // сигнал в ленте, а не аргумент функции сноса; принять его на веру и
    // исполнить одной кнопкой было бы обратной стороной того же риска, ради
    // которого право сноса не отдано директору вовсе.
    //
    // Предложение обязано проверяться теми же правилами, что и сам снос:
    // если код заверяемый (Collusion/Leak/Other), отпечаток доказательства
    // обязателен уже здесь, а не только при исполнении — иначе директор
    // клал бы в цепь пустое обвинение, которое висит две недели и ничем не
    // подкреплено. Проверяемые коды (OverturnedVerdicts/Timeouts/Silence)
    // цепью на этом этапе НЕ проверяются намеренно: признак может появиться
    // уже после предложения, и требовать его заранее значило бы запретить
    // предупреждать раньше, чем случилось.

    /// Положить предложение в цепь. Одно живое предложение на арбитра —
    /// второе перезаписывает первое (претензия одна, а не очередь).
    function proposeRemoval(address arbiter, Cause cause, bytes32 evidenceDigest)
        external
        onlyOwnerOrChief
    {
        if (arbiter == address(0)) revert ArbiterZeroAddress();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        if (!d.isArbiter[arbiter]) revert NotAnArbiter();
        if (!_isChainVerifiable(cause) && evidenceDigest == bytes32(0)) revert EvidenceRequired();

        d.removalProposals[arbiter] = ArbiterRegistryStorage.RemovalProposal({
            cause:          uint8(cause),
            evidenceDigest: evidenceDigest,
            proposedAt:     block.timestamp,
            by:             msg.sender
        });
        emit RemovalProposed(arbiter, msg.sender, cause, evidenceDigest, block.timestamp);
    }

    /// Отозвать предложение раньше срока — своё или чужое: владелец и
    /// директор оба ходят под onlyOwnerOrChief, и любой из двух вправе снять
    /// запись (та же пара, что вправе её положить).
    function withdrawProposal(address arbiter) external onlyOwnerOrChief {
        delete ArbiterRegistryStorage.data().removalProposals[arbiter];
        emit RemovalProposalWithdrawn(arbiter, msg.sender);
    }

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

    /// Порог РУЧНОГО сноса прочитанный с этой стороны. Строго меньше
    /// ArbiterRegistryFacet.getMaxArbiterMistakes() — сверяется тестом
    /// test_MistakeThresholdMatchesRegistry (равенство запрещено намеренно,
    /// см. докстринг MISTAKE_THRESHOLD).
    function getMistakeThreshold() external pure returns (uint256) {
        return MISTAKE_THRESHOLD;
    }

    /// Зеркало MAX_ARBITER_MISTAKES прочитанное отсюда — само число, не порог
    /// сноса (тот — getMistakeThreshold(), на единицу ниже). Существует
    /// только для того, чтобы test_MistakeThresholdMatchesRegistry мог
    /// сверить оба конца связи `MISTAKE_THRESHOLD = MAX_ARBITER_MISTAKES − 1`
    /// с боевым числом в ArbiterRegistryFacet, а не только друг с другом.
    function getMaxArbiterMistakesMirror() external pure returns (uint256) {
        return MAX_ARBITER_MISTAKES_MIRROR;
    }

    /// Зеркало DAO_THRESHOLD прочитанное отсюда. Сверяется тестом
    /// test_DaoThresholdMatchesRegistry.
    function getDaoThresholdMirror() external pure returns (uint256) {
        return DAO_THRESHOLD_MIRROR;
    }

    /// Живо ли предложение прямо сейчас. `proposedAt == 0` — предложения нет
    /// вовсе (ни разу не клали, либо снято withdrawProposal/сносом). Граница
    /// строгая, как у suspendedUntil: на самой последней секунде TTL ещё живо.
    function hasLiveProposal(address arbiter) public view returns (bool) {
        ArbiterRegistryStorage.RemovalProposal storage p =
            ArbiterRegistryStorage.data().removalProposals[arbiter];
        if (p.proposedAt == 0) return false;
        return block.timestamp < p.proposedAt + PROPOSAL_TTL;
    }

    /// Сырое чтение записи — не смотрит на TTL. Протухшее предложение
    /// (hasLiveProposal == false) всё ещё читается отсюда, пока его не
    /// перезаписали новым или не удалили: это архивная запись, а не
    /// действующая претензия, и вызывающий обязан сам свериться с
    /// hasLiveProposal, если разница ему важна.
    function getRemovalProposal(address arbiter)
        external view returns (uint8 cause, bytes32 evidenceDigest, uint256 proposedAt, address by)
    {
        ArbiterRegistryStorage.RemovalProposal storage p =
            ArbiterRegistryStorage.data().removalProposals[arbiter];
        return (p.cause, p.evidenceDigest, p.proposedAt, p.by);
    }

    function getProposalTTL() external pure returns (uint256) {
        return PROPOSAL_TTL;
    }
}
