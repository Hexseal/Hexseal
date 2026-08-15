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
// ⚠️ Задача 8 (15 августа 2026, право ответа снятого) добавила respondToRemoval
// — ПЕРВУЮ и ЕДИНСТВЕННУЮ гейслесс-функцию этого фасета. Зовёт её снятый
// арбитр, обычный человек, у которого может не быть ETH; на пути через
// релеер msg.sender — адрес MinimalForwarder, а не человек. Файл теперь
// реализует собственный _msgSender() (копия тела ArbiterRegistryFacet.
// _msgSender — про то, чем это совпадение сторожится и чем НЕ сторожится, см.
// докстринг самой функции ниже) и стал ERC-2771-файлом: автопоиск
// script/check_gasless_sender.py подхватывает его сам, а script/gasless-sender.allow
// учитывает файл per-function, как соседние ArbiterRegistryFacet/JobBoardFacet/
// ServiceBoardFacet, а не одной общей записью «вне области».
//
// ВСЕ ОСТАЛЬНЫЕ функции фасета остаются административными (владелец либо, до
// активации ДАО, директор) и по-прежнему читают сырой msg.sender —
// гейслесс-путь им не нужен и был бы опасен: доверять хвосту calldata в
// проверке владельческой роли значит отдать её форвардеру. Причины —
// поимённо, по функциям, в script/gasless-sender.allow.
// ============================================================

import {ArbiterRegistryStorage} from "./ArbiterRegistryFacet.sol";
import {ReputationStorage} from "./ReputationFacet.sol";
import {OwnershipLib} from "../DiamondProxy.sol";
import {FactoryStorage} from "../FactoryFacet.sol";

contract ArbiterAccountabilityFacet {

    // -------- CONSTANTS --------

    // Окно приостановки (SUSPENSION_WINDOW, 72 часа) переехало в
    // ArbiterRegistryStorage 16 августа 2026 (финальный обзор ветки, правка A).
    // Причина — там же, у объявления: приостановку выставляют ДВЕ двери в ДВУХ
    // файлах (removeArbiterForCause здесь и автодемоушен в
    // ArbiterRegistryFacet._recordArbiterMistake), и копия числа во втором была
    // бы тем же классом дефекта, что разобранный в этой ветке M-3. Значение не
    // менялось, getSuspensionWindow() ниже отдаёт его по-прежнему.

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

    // Зеркало DEMOTION_XP_RESET (2500) снято финальным обзором ветки (M-2,
    // 16 августа 2026). Оно было объявлено «якорем на будущее» и не читалось
    // ниоткуда: третья копия числа из соседнего фасета — и единственная из трёх
    // без геттера и без сверки. Два других зеркала этого файла
    // (MAX_ARBITER_MISTAKES_MIRROR, DAO_THRESHOLD_MIRROR) отдаются наружу
    // геттерами и сверяются с боевыми числами тестами; это не сверялось ничем и
    // разошлось бы молча. Понадобится сброс XP при сносе по поводу — число
    // возьмётся из ArbiterRegistryFacet вместе с решением, а не пролежит года
    // самостоятельным литералом.

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

    // ── Право ответа снятого (задача 8, 15 августа 2026) ──
    error AlreadyAnswered();
    error NothingToAnswer();
    error ZeroDigest();

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

    /// Обвинение против настоящего адреса лежит в цепи вечно. Ответ ничего
    /// не отменяет и ничего не возвращает — он существует, чтобы читатель
    /// цепи видел ДВЕ записи вместо одной (задача 8, 15 августа 2026).
    event RemovalAnswered(address indexed arbiter, bytes32 replyDigest);

    /// Стирание предложения В МОМЕНТ реального сноса — отдельно от
    /// RemovalProposalWithdrawn (тот значит «передумали», этот — «сбылось»,
    /// круг правок 1, Minor 4, 15 августа 2026). Несёт поля СТЁРТОГО
    /// предложения (не нового состояния — того уже нет), чтобы «предложили
    /// за X — снесли за Y» было видно в одной транзакции, без сшивания двух
    /// логов по адресу арбитра.
    event RemovalProposalConsumed(
        address indexed arbiter,
        Cause   indexed proposedCause,
        address indexed proposedBy,
        bytes32         evidenceDigest,
        uint256         proposedAt
    );

    // -------- MODIFIERS --------

    /// ⚠️ ДИРЕКТОР ПЕРЕСТАЁТ СУЩЕСТВОВАТЬ ПРИ АКТИВНОМ ДАО — здесь, в
    /// модификаторе, а не в activateDAO() (финальный обзор ветки, I-2,
    /// 16 августа 2026).
    ///
    /// Задача 6 закрыла `setChiefArbiter` при активном ДАО, а она — ЕДИНСТВЕННЫЙ
    /// писатель `d.chiefArbiter` и единственный способ его обнулить. Значит
    /// «роль директора упраздняется» на деле означало обратное: сидящий директор
    /// оставался в слоте НАВСЕГДА, со всеми правами этого модификатора —
    /// приостанавливать, снимать приостановку, предлагать снос, отзывать
    /// предложение. Несменяемый директор мог приостанавливать арбитра каждые 72
    /// часа бесконечно (тот не клеймит, не финализирует, НЕ УВОЛЬНЯЕТСЯ и не
    /// получает назад свои 50 USDC) или класть предложение о сносе каждые 14
    /// суток — ограничение, записанное как терпимое в
    /// ArbiterRegistryFacet._requireNoLiveRemovalProposal ровно потому, что
    /// директора можно снять.
    ///
    /// Правка в модификаторе, а не в activateDAO(), по двум причинам: она верна
    /// независимо от того, каким путём включилось ДАО (ручной флаг ИЛИ
    /// заработанный порог, см. _isDaoActive), и не зависит от того, вспомнит ли
    /// владелец обнулить слот заранее.
    ///
    /// Владелец сохраняет все четыре функции — приостановка обратима и протухает
    /// сама, её он не теряет и после передачи сноса (см. докстринг
    /// suspendArbiter).
    modifier onlyOwnerOrChief() {
        if (msg.sender != OwnershipLib.contractOwner()) {
            ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
            if (_isDaoActive(d) || msg.sender != d.chiefArbiter) revert NotOwnerOrChief();
        }
        _;
    }

    // -------- ERC-2771 SENDER --------

    /// Копия из ArbiterRegistryFacet — фасеты не наследуются друг от друга, и
    /// общего базового контракта в этом проекте нет. Единственный вызывающий её
    /// пользовательский путь — respondToRemoval; все прочие функции фасета
    /// остаются на сыром msg.sender (владельческие, не гейслесс — см.
    /// script/gasless-sender.allow).
    ///
    /// ⚠️ ЧЕМ ЭТО СТОРОЖИТСЯ НА САМОМ ДЕЛЕ (финальный обзор ветки, M-3,
    /// 16 августа 2026; числа ниже — ЗАМЕРЫ, не рассуждение).
    ///
    /// Прежняя редакция обещала, что тело «обязано совпадать побайтно —
    /// сверяется test_MsgSenderMatchesRegistry». Обещание было ложным дважды:
    /// побайтной сверки не существует вовсе, а названный тест
    /// (test/ArbiterRemovalForCause.t.sol) гоняет через форвардер ТОЛЬКО
    /// respondToRemoval — то есть доказывает, что работает ЭТА копия, и ни
    /// слова о совпадении с реестровой.
    ///
    /// Как обстоит дело в действительности: КАЖДАЯ из двух копий доказана
    /// НЕЗАВИСИМО и против ВНЕШНЕЙ правды — адреса подписанта, а не соседнего
    /// фасета. Замер: порча оригинала
    /// (ArbiterRegistryFacet._msgSender → `sender = msg.sender`) даёт 6 красных,
    /// пять из них — гейслесс-пути самого реестра (fundDispute,
    /// withdrawDisputeBounty, recordNoResponse, recordPresentationDigest,
    /// setArbiterChatKey), шестой — дифференциал ниже; порча копии — 2 красных.
    /// Разъехаться молча не может ни одна.
    ///
    /// Что добавлено этой правкой:
    /// test/ArbiterRemovalForCauseIntegration.t.sol::
    /// test_MsgSenderAgreesAcrossBothFacetsOnOneForwarder — единственное место,
    /// где обе реализации работают на ОДНОМ даймонде, ОДНОМ хранилище, с ОДНИМ
    /// настоящим MinimalForwarder и ОДНИМ подписантом, и их ответы сверяются
    /// друг с другом. Честная оговорка: единственным красным он не бывает
    /// НИКОГДА — на любой порче рядом краснеет собственный тест испорченной
    /// стороны. Он не замок, он контроль стыка: ловит разъезд именно ПАРЫ
    /// (например, копия начала читать чужое поле хранилища — замерено, 2
    /// красных, оба про эту пару), а не работоспособность каждой в одиночку.
    ///
    /// Побайтной сверки текста нет и не заводилась. Она стоила бы расширения
    /// fs_permissions в foundry.toml с `./out` на `./src` — открыть тестам
    /// чтение исходников ради равенства пробелов и комментариев. Расхождение,
    /// не меняющее поведения, вреда не наносит; расхождение, меняющее
    /// поведение, краснеет и так, замерено выше.
    function _msgSender() internal view returns (address sender) {
        address forwarder = FactoryStorage.store().trustedForwarder;
        if (msg.sender == forwarder && msg.data.length >= 20) {
            assembly { sender := shr(96, calldataload(sub(calldatasize(), 20))) }
        } else {
            sender = msg.sender;
        }
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
        uint256 until = block.timestamp + ArbiterRegistryStorage.SUSPENSION_WINDOW;
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
    ///
    /// ⚠️ ПОВОД НЕ РАСХОДУЕТСЯ (финальный обзор ветки, M-5, 16 августа 2026).
    /// Записано намеренно, кодом не чинится — решение о поведении за владельцем.
    ///
    /// Обе проверяемые улики переживают снос, за который были предъявлены:
    ///
    ///   • `arbiterMistakeStreak` снос по поводу НЕ обнуляет — в отличие от
    ///     автодемоушена, который в `_recordArbiterMistake` сбрасывает счётчик
    ///     той же транзакцией, что снимает статус. Значит владелец, вернувший
    ///     ошибочно снятого через addArbiter, возвращает его вместе со
    ///     счётчиком на пороге: тот же признак оправдывает снос ПОВТОРНО, без
    ///     единой новой ошибки.
    ///   • `disputeNoResponseAtBy` не стирается никогда и по замыслу (см. поле
    ///     в ArbiterRegistryStorage: стираемая запись отдала бы арбитру право
    ///     переставить её время). Но `Silence` проверяет только НАЛИЧИЕ записи
    ///     и ничего не знает о том, чем спор кончился. Арбитр, который честно
    ///     записал молчание стороны, а потом ДОСУДИЛ спор до финализации,
    ///     навсегда носит на себе готовый повод для сноса со штампом
    ///     «проверено цепью».
    ///
    /// Чем лечится (не сейчас): помнить момент прошлого сноса и требовать,
    /// чтобы улика была НОВЕЕ его (`removedAt` для этого уже есть), а для
    /// `Silence` — не засчитывать запись по спору, дошедшему до
    /// финализированного вердикта этого же арбитра.
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

        // Снимок предложения (если было) ДО clearSeat — тот теперь стирает
        // removalProposals как часть общей уборки провенанса (круг правок 1,
        // Important 1, 15 августа 2026: раньше delete стоял только здесь, и
        // человек, ушедший через resignAsArbiter или снятый автодемоушеном,
        // уносил с собой живое предложение — hasLiveProposal продолжал бы
        // отвечать true до двух недель против уже отсутствующего арбитра,
        // который снять запись о себе не может). Снимок нужен ТОЛЬКО для
        // события ниже — после clearSeat читать уже нечего.
        ArbiterRegistryStorage.RemovalProposal memory consumedProposal = d.removalProposals[arbiter];

        d.isArbiter[arbiter] = false;
        ArbiterRegistryStorage.clearSeat(d, arbiter);

        // Момент сноса — нужен, чтобы respondToRemoval (задача 8) отличал
        // «сняли и он молчит» от «его никогда не снимали»: без этой отметки
        // любой посторонний мог бы «ответить» на несуществующее обвинение.
        d.removedAt[arbiter] = block.timestamp;

        // ⚠️ СНОС ПОДРАЗУМЕВАЕТ ПРИОСТАНОВКУ (финальный обзор ветки, C-1,
        // 16 августа 2026). Без этой строки сильная мера была СЛАБЕЕ слабой —
        // инверсия всего замысла:
        //
        //   • submitVerdict гейтится КЛЕЙМОМ, а не статусом
        //     (`d.disputeClaims[agreement] != caller`), и снос не трогает ни
        //     disputeClaims, ни openClaimCount. Значит снятый в ту же минуту
        //     подавал вердикты по всем взятым спорам (до MAX_CLAIMS_PER_ARBITER),
        //     через сутки любой прохожий их финализировал, и котлы уходили
        //     подкупившей стороне.
        //   • suspendArbiter к тому моменту УЖЕ НЕДОСТУПНА: она ревертит
        //     NotAnArbiter на снятом. То есть снос закрывал единственную дверь,
        //     которая спасала.
        //
        // Приостановка объявлена слабой и обратимой, но деньги держит
        // (_requireNotSuspended в finalizeVerdict читает АРБИТРА ВЕРДИКТА, не
        // вызывающего — проверено). Снос объявлен сильным и необратимым, и
        // обязан держать как минимум не меньше. 72 часа — ровно то окно, за
        // которое владелец успевает пройтись overturnVerdict/freezeVerdict по
        // спорам, оставшимся за снятым.
        //
        // Отметка протухает сама, как всякая приостановка: снятый навсегда
        // остаётся снятым, но его вердикты после окна финализируются обычным
        // порядком — вечная заморозка чужих денег ценой одного сноса была бы
        // новым оружием, а не защитой.
        d.suspendedUntil[arbiter] = block.timestamp + ArbiterRegistryStorage.SUSPENSION_WINDOW;

        uint256 len = d.arbiterList.length;
        for (uint256 i = 0; i < len; i++) {
            if (d.arbiterList[i] == arbiter) {
                d.arbiterList[i] = d.arbiterList[len - 1];
                d.arbiterList.pop();
                break;
            }
        }

        emit ArbiterRemovedForCause(arbiter, msg.sender, cause, verified, evidenceDigest, forfeited);

        // Minor 4, круг правок 1: отдельное событие с полями СТЁРТОГО
        // предложения — «предложили за X, снесли за Y» видно в одной
        // транзакции (оба события лежат в одном логе), без сшивания с
        // RemovalProposed по адресу арбитра через историю. Молчит, если
        // предложения не было вовсе (proposedAt == 0) — снос без
        // предшествующего сигнала директора не обязан ничего сообщать
        // про предложение, которого не было.
        if (consumedProposal.proposedAt != 0) {
            emit RemovalProposalConsumed(
                arbiter,
                Cause(consumedProposal.cause),
                consumedProposal.by,
                consumedProposal.evidenceDigest,
                consumedProposal.proposedAt
            );
        }
    }

    // ⚠️ Сброс XP здесь не делается: ReputationStorage живёт в другом
    // неймспейсе, и тянуть его сюда означало бы вторую точку записи в чужое
    // хранилище — расходится с единственным местом, которое сегодня пишет XP
    // демоушена (_recordArbiterMistake в ArbiterRegistryFacet). XP снятого по
    // поводу остаётся как есть; расхождение с автоматическим демоушеном
    // сознательное и решается отдельной задачей, если владелец сочтёт нужным.

    // ============================================================
    //  ПРАВО ОТВЕТА (задача 8, 15 августа 2026)
    //
    //  Обвинение против настоящего адреса лежит в цепи вечно. Ответ ничего
    //  не отменяет и ничего не возвращает — он существует, чтобы читатель
    //  цепи видел ДВЕ записи вместо одной.
    // ============================================================

    /// ⚠️ ЕДИНСТВЕННАЯ гейслесс-функция этого фасета. Отправитель берётся через
    /// _msgSender(), а не msg.sender: её зовёт снятый арбитр — обычный человек,
    /// у которого может не быть ETH. На пути через релеер msg.sender это адрес
    /// MinimalForwarder, и ответ записался бы форвардеру, а не человеку.
    function respondToRemoval(bytes32 replyDigest) external {
        if (replyDigest == bytes32(0)) revert ZeroDigest();

        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        if (d.removedAt[caller] == 0) revert NothingToAnswer();
        if (d.removalReply[caller] != bytes32(0)) revert AlreadyAnswered();

        d.removalReply[caller] = replyDigest;
        emit RemovalAnswered(caller, replyDigest);
    }

    function getRemovalReply(address arbiter) external view returns (bytes32) {
        return ArbiterRegistryStorage.data().removalReply[arbiter];
    }

    // -------- ПРЕДЛОЖЕНИЕ ДИРЕКТОРА (задача 7, 15 августа 2026) --------
    //
    // Снос необратим: он снимает статус, сжигает залог и оставляет в цепи
    // вечное публичное обвинение против настоящего адреса. Такое не должно
    // зависеть от одного человека, кроме владельца. Директор при этом видит
    // работу корпуса ближе всех, и запрещать ему сигнализировать было бы
    // глупо — отсюда разделение: он кладёт предложение в цепь СВОИМ адресом,
    // владелец соглашается СВОИМ, вызывая обычный removeArbiterForCause.
    //
    // ⚠️ Связь предложения с исполнением — ТОЛЬКО очистка. removeArbiterForCause
    // не читает removalProposals ни для чего: код повода, отпечаток и ссылку
    // на спор владелец обязан передать заново, своими аргументами.
    // Предложение — сигнал в ленте, а не аргумент функции сноса; принять его
    // на веру и исполнить одной кнопкой было бы обратной стороной того же
    // риска, ради которого право сноса не отдано директору вовсе.
    //
    // Сама очистка (круг правок 1, Important 1, 15 августа 2026) живёт в
    // ArbiterRegistryStorage.clearSeat — ОДНОЙ точке на все ТРИ двери выхода
    // из корпуса (removeArbiterForCause, resignAsArbiter, автодемоушен в
    // _recordArbiterMistake), а не только здесь. Обоснование то же самое,
    // что и для removeArbiterForCause: предложение не должно пережить
    // человека, против которого оно висело, — а resignAsArbiter и
    // автодемоушен снимают ровно так же, как снос по поводу.
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
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        // Minor 3, круг правок 1: событие только если запись реально была —
        // иначе вызов против человека, на которого никто ничего не клал,
        // оставлял бы в ленте RemovalProposalWithdrawn, читающийся как «против
        // него что-то было и это отозвали». Лента и есть весь смысл этой
        // работы, врать ей нельзя даже пустым отзывом.
        bool existed = d.removalProposals[arbiter].proposedAt != 0;
        delete d.removalProposals[arbiter];
        if (existed) {
            emit RemovalProposalWithdrawn(arbiter, msg.sender);
        }
    }

    // -------- VIEWS --------

    function isSuspended(address arbiter) public view returns (bool) {
        return block.timestamp < ArbiterRegistryStorage.data().suspendedUntil[arbiter];
    }

    function getSuspendedUntil(address arbiter) external view returns (uint256) {
        return ArbiterRegistryStorage.data().suspendedUntil[arbiter];
    }

    /// Единственный публичный геттер окна приостановки — и он остаётся здесь
    /// после переноса константы в ArbiterRegistryStorage (правка A, 16 августа
    /// 2026): селектор фасета не трогается, число то же самое.
    function getSuspensionWindow() external pure returns (uint256) {
        return ArbiterRegistryStorage.SUSPENSION_WINDOW;
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

    /// Чтение записи целиком, включая архивную (протухшую или уже
    /// исполненную — она читается отсюда, пока не перезаписана новой или не
    /// удалена). Пятое поле `live` (улучшение, круг правок 1, 15 августа
    /// 2026; починка круга правок 2 — тот же день) — ВЫЗОВ `hasLiveProposal`,
    /// а не копия её формулы: у ответа «живо ли предложение» один хозяин,
    /// разойтись со строгостью сравнения или проверкой `proposedAt` внутри
    /// этого файла невозможно структурно, не только по факту сегодняшнего
    /// совпадения текста. Раньше вызывающий был обязан ПОМНИТЬ вызвать
    /// `hasLiveProposal` отдельно, прочитав докстринг, — защита, держащаяся
    /// на том, что человек прочтёт
    /// комментарий, в этом проекте не защита. Селектор функции от типа
    /// возврата не зависит, каскад деплоя не тронут.
    function getRemovalProposal(address arbiter)
        external view returns (uint8 cause, bytes32 evidenceDigest, uint256 proposedAt, address by, bool live)
    {
        ArbiterRegistryStorage.RemovalProposal storage p =
            ArbiterRegistryStorage.data().removalProposals[arbiter];
        return (p.cause, p.evidenceDigest, p.proposedAt, p.by, hasLiveProposal(arbiter));
    }

    function getProposalTTL() external pure returns (uint256) {
        return PROPOSAL_TTL;
    }

    // -------- ПОЛОЖЕНИЕ АРБИТРА ОДНИМ ЧТЕНИЕМ (задача 9, 15 августа 2026) --------

    /// Всё положение арбитра одним чтением. Собирать это на фронте семью-восемью
    /// отдельными запросами нельзя: между ними проходят блоки, и картинка
    /// расходится сама с собой — залог прочитан до сноса, а статус после.
    ///
    /// Набор полей шире брифа задачи (там семь: xp..openClaims) — за время
    /// работы над планом в хранилище появилось то, чего в брифе ещё не было:
    ///
    /// `cleanVerdicts` — судейский стаж (сколько вердиктов дошло до
    /// финализации неперевёрнутыми). Без него показатель не показывает
    /// главного: именно по нему решено конвертировать ручных арбитров при
    /// включении ДАО (см. докстринг ArbiterRegistryStorage.Data.cleanVerdicts).
    ///
    /// `removedAt` — момент сноса, ноль если не снимали. Экран отличает
    /// действующего арбитра от снятого одним полем, не гадая по остальным.
    ///
    /// `hasLiveRemovalProposal` — висит ли прямо сейчас предложение
    /// директора о сносе. Читается ВЫЗОВОМ hasLiveProposal(arbiter), а не
    /// копией её формулы протухания: в этой же работе (getRemovalProposal,
    /// круг правок 2 задачи 7) уже ловили и переделывали ровно такой
    /// дубликат — второе место, сравнивающее `proposedAt + PROPOSAL_TTL` со
    /// своим собственным пониманием "живо", было бы новым швом с тем же
    /// классом дефекта.
    ///
    /// XP и cleanStreak читаются из ReputationStorage — чужого неймспейса,
    /// тем же приёмом, что и _isDaoActive выше: фасет уже умеет туда ходить.
    function getArbiterStanding(address arbiter) external view returns (
        uint256 xp,
        uint256 cleanStreak,
        uint256 mistakeStreak,
        uint256 bond,
        address seatedBy,
        uint256 suspendedUntil,
        uint256 openClaims,
        uint256 cleanVerdicts,
        uint256 removedAt,
        bool    hasLiveRemovalProposal
    ) {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        ReputationStorage.Data storage rep = ReputationStorage.data();
        return (
            rep.xp[arbiter],
            rep.cleanStreak[arbiter],
            d.arbiterMistakeStreak[arbiter],
            d.arbiterBond[arbiter],
            d.seatedBy[arbiter],
            d.suspendedUntil[arbiter],
            d.openClaimCount[arbiter],
            d.cleanVerdicts[arbiter],
            d.removedAt[arbiter],
            hasLiveProposal(arbiter)
        );
    }
}
