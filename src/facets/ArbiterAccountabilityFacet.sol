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

    /// Потолок слов, в БАЙТАХ, а не в символах — цепь символов не считает и
    /// считать не может: `bytes(s).length` это длина UTF-8, и «256 символов»
    /// на кириллице это 512 байт, а на эмодзи 1024.
    ///
    /// Число выбрано так, чтобы обещанные владельцем ~256 символов помещались
    /// в ХУДШЕЙ кодировке из тех, которыми люди тут пишут: 512 байт — это 512
    /// латинских символов или 256 кириллических. Хватает на «трижды забирал
    /// споры одного контрагента и трижды решал в его пользу» (123 байта) и не
    /// превращает цепь в блог.
    ///
    /// ⚠️ Форма обязана показывать остаток В БАЙТАХ. Счётчик «осталось 40
    /// символов» соврёт на первом же эмодзи вчетверо, и человек получит отказ
    /// транзакции вместо подсказки.
    uint256 private constant MAX_REASON_BYTES = 512;

    /// The pause between a proposal and the removal it authorises (design of
    /// 17 August 2026, decision 2). The clock runs FROM THE PROPOSAL and the
    /// accused answering does not move it.
    ///
    /// The number is proportionate to its neighbours rather than picked out of
    /// thin air: suspension lasts 72 hours, the verdict finalisation window 24.
    /// One day for the person to notice at all, one day to answer. Under a day
    /// is missable by anyone who did not log in; over a week and the arbiter
    /// hangs while his disputes stand still.
    ///
    /// ⚠️ Rejected alternative (design, decision 3): "silence buys a fast
    /// removal, an answer buys the full pause". It creates a perverse
    /// incentive — the silent get removed sooner, so answering pays as a way of
    /// stalling rather than because there is something to say. It also lets the
    /// button be pressed while the person sleeps.
    ///
    /// ⚠️ There is no fast path to removal and none may be added: "he is doing
    /// damage right now" is covered by suspendArbiter — instant, reversible,
    /// expiring by itself. Two levers of different speed, and that separation
    /// is half the design.
    uint256 private constant REMOVAL_DELAY = 48 hours;

    /// Этап, на котором сказаны слова. Уезжает indexed-топиком, чтобы лента
    /// могла спросить «покажи все обвинения» отдельно от «покажи все сносы»,
    /// не разбирая тело события.
    uint8 private constant REASON_STAGE_PROPOSAL = 0;
    uint8 private constant REASON_STAGE_REMOVAL  = 1;

    // -------- ERRORS --------

    error NotOwnerOrChief();
    error NotOwner();
    error NotAnArbiter();
    error ArbiterZeroAddress();

    // ── Вес приостановки (п. 66, 16 августа 2026) ──
    /// Приостановку, наложенную СНОСОМ (ручным или автоматическим), снимает
    /// только ДЕРЖАТЕЛЬ ПРАВА СНОСА. Отдельная ошибка, а не NotOwner: директор,
    /// получивший NotOwner на функции, которая ему в общем случае разрешена,
    /// пошёл бы искать проблему в своей роли. Здесь дело не в роли, а в весе
    /// конкретной приостановки.
    ///
    /// ⚠️ ПЕРЕИМЕНОВАНА (уборка 7а, п. 2.3, Ruling 12). Звалась
    /// `RemovalSuspensionIsOwnerOnly`, и после правки В-2 имя стало врать:
    /// право принадлежит не владельцу вообще, а тому, у кого СЕГОДНЯ снос
    /// (`_removalAuthority`) — до передачи владелец, после передачи названный
    /// преемник. Имя ошибки в `methodIdentifiers` не входит, поэтому состав
    /// разреза от переименования не меняется — проверено сверкой хешей карт
    /// селекторов обоих фасетов до и после, а не принято на слово.
    error RemovalSuspensionIsRemovalAuthorityOnly();

    // ── Снос по поводу (задача 6, 15 августа 2026) ──
    error CauseNotProven(uint8 cause);
    error EvidenceRequired();
    /// Право сноса уехало к названному преемнику — звать может только
    /// daoAddress (см. removeArbiterForCause). Владелец получает эту же
    /// ошибку: это передача, а не запирание в пустоту, но передача
    /// односторонняя и владельцу дороги назад нет.
    ///
    /// ⚠️ Именно «к НАЗВАННОМУ» (п. 69, 16 августа 2026): пока `daoAddress`
    /// нулевой, эта ошибка не выдаётся никому, сколько бы путей ни включило
    /// `isDaoActive()` — передавать некому, и дверь остаётся у владельца.
    error RemovalHandedOver();
    error DisputeRefRequired();
    error DisputeRefNotApplicable();

    // ── Право ответа снятого (задача 8, 15 августа 2026) ──
    error AlreadyAnswered();
    error NothingToAnswer();
    error ZeroDigest();

    // ── Причина словами (замысел 17 августа 2026, решение 7) ──
    /// Цепь этот повод не проверяет, значит обвинитель обязан объяснить
    /// словами. Обязанность лежит на обвинителе и только на нём: у
    /// обвиняемого слова — право.
    error ReasonRequired();
    /// Длина в БАЙТАХ, не в символах. Значение возвращается в ошибке, чтобы
    /// форма могла показать, насколько именно перебрали.
    error ReasonTooLong(uint256 given);

    // ── The 48-hour pause (design of 17 August 2026, decisions 1-2) ──
    /// There is nothing to execute: no proposal stands against this address at
    /// all, or it was withdrawn. A separate error from ProposalStale — there
    /// the accusation existed and expired, here it never existed.
    error NoLiveProposal();
    /// The clock is still running. Carries THE MOMENT from which removal is
    /// allowed, so the form can say "19 hours to go" instead of "try later".
    error RemovalTooEarly(uint256 notBefore);
    /// The proposal outlived PROPOSAL_TTL. Executing it would mean an
    /// accusation half a year old firing without a fresh warning.
    error ProposalStale(uint256 proposedAt);
    /// Warned about one thing, removed for another. The pause exists so the
    /// person can answer THAT PARTICULAR accusation; swapping the code
    /// devalues both the pause and the answer.
    error CauseDiffersFromProposal(uint8 proposed, uint8 given);
    /// The caller is allowed on this door in general, but THIS proposal is not
    /// his. A separate error from NotOwnerOrChief on purpose: there the role is
    /// wrong, here the role is right and the record belongs to someone else.
    ///
    /// ⚠️ Introduced by review round 1 of the pause (17 August 2026), and the
    /// pause is what made it necessary. Until then a withdrawal cancelled a
    /// SIGNAL — it took nothing away, because removal did not depend on the
    /// proposal at all. Now the proposal is a MANDATORY INPUT, so withdrawing
    /// someone else's is the power to stop a removal. The chief was
    /// deliberately denied the power to REMOVE; handing him the power to
    /// PREVENT a removal — and to do it again every time, proposal after
    /// proposal — is no lighter.
    error NotYourProposal();

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

    /// Слова обвинителя. ОТДЕЛЬНОЕ событие, а не поле в
    /// ArbiterRemovedForCause/RemovalProposed: те уже индексируются живым
    /// сабграфом (subgraph/src/arbiter.ts), и смена их подписи остановила бы
    /// ленту молча — graph-cli сопоставляет лог по канонической подписи с
    /// `indexed` включительно. Тот же приём, что уже применён к
    /// RemovalProposalConsumed: два лога в одной транзакции, сшиваются по ней.
    ///
    /// `stage` различает предложение (0) и снос (1). Молчит, если слов нет:
    /// пустая строка в ленте стирала бы разницу между «объяснил» и
    /// «промолчал», а вся эта работа держится ровно на этой разнице.
    event RemovalReasonGiven(
        address indexed arbiter,
        address indexed by,
        uint8   indexed stage,
        string          reason
    );

    /// Слова обвиняемого. Симметрия с RemovalReasonGiven, но модальность
    /// другая: у обвинителя это обязанность (когда цепь молчит), у
    /// обвиняемого — право. Заставлять человека оправдываться публично
    /// нельзя; оставлять запись односторонней — обвинение словами, защита
    /// хешем — тоже.
    event RemovalReplyGiven(address indexed arbiter, string reply);

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
    /// ⚠️ У ВЛАДЕЛЬЦА ОСТАЮТСЯ ТРИ ИЗ ЧЕТЫРЁХ, А НЕ ВСЕ ЧЕТЫРЕ (уборка 7а,
    /// п. 2.1). Здесь стояло «владелец сохраняет все четыре функции… её он не
    /// теряет и после передачи сноса» — с 16 августа это неправда, и неправдой
    /// её сделала правка В-2 в этом же файле.
    ///
    /// Как обстоит дело: под этим модификатором ходят `suspendArbiter`,
    /// `proposeRemoval` и `withdrawProposal` — их владелец действительно
    /// сохраняет всегда, и они действительно лёгкие: приостановка обратима и
    /// протухает сама, предложение — не исполнение.
    ///
    /// Четвёртая, `liftSuspension`, ПОД МОДИФИКАТОРОМ БОЛЬШЕ НЕ ХОДИТ. У неё
    /// две ветки: обычную приостановку снимает та же пара, что и раньше, а окно,
    /// выставленное СНОСОМ, — только держатель права сноса (`_removalAuthority`).
    /// До передачи это владелец, после — названный преемник. То есть после
    /// передачи владелец эту половину теряет, и это ровно то, ради чего правка
    /// делалась.
    /// Тело модификатора вынесено отдельной функцией (п. 66, круг правок 1,
    /// 16 августа 2026), потому что у `liftSuspension` появились ДВЕ ветки прав
    /// и ей нужно звать эту проверку в одной из них, а не во всех. Модификатор
    /// ниже теперь только зовёт её — копии условия не заводится, роль
    /// по-прежнему описана ровно в одном месте.
    function _requireOwnerOrChief(ArbiterRegistryStorage.Data storage d) private view {
        if (msg.sender != OwnershipLib.contractOwner()) {
            if (_isDaoActive(d) || msg.sender != d.chiefArbiter) revert NotOwnerOrChief();
        }
    }

    modifier onlyOwnerOrChief() {
        _requireOwnerOrChief(ArbiterRegistryStorage.data());
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
    /// слова о совпадении с реестровой. Правка C (16 августа 2026)
    /// переименовала и сам тест — он зовётся
    /// test_RespondToRemovalThroughForwarderCreditsHuman, по тому, что делает.
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
    ///
    /// ⚠️ ДВА ВЕСА У ОДНОЙ КНОПКИ (п. 66, 16 августа 2026). Прежняя редакция
    /// не проверяла НИЧЕГО — ни статуса, ни повода, ни того, кто накладывал, —
    /// и была доступна директору. Из этого следовали две вещи сразу:
    ///
    ///   • директор одной транзакцией отменял самое весомое действие
    ///     владельца. После removeArbiterForCause человек уже не арбитр, а
    ///     suspendArbiter требует isArbiter — значит наложить обратно владелец
    ///     не мог. Окно C-1 держит деньги: finalizeVerdict гейтится
    ///     приостановкой АРБИТРА ВЕРДИКТА, звать её может кто угодно;
    ///   • тем же вызовом глушился АВТОМАТ: то же окно ставит автодемоушен
    ///     (_recordArbiterMistake), который специально сделан работающим без
    ///     человека.
    ///
    /// Различитель — `removedAt`, и он уже есть: обе двери снятия его пишут,
    /// а обе двери входа (addArbiter/applyAsArbiter) стирают. То есть у
    /// действующего арбитра он ноль всегда, и обычная приостановка остаётся
    /// лёгкой, как и задумано: её снимает директор, это его работа.
    ///
    /// ⚠️ Читать нужно ИМЕННО `removedAt`, а не «сколько раз сносили» из
    /// вечной истории (removalCount/lastRemovalAt, п. 72). Вечная запись не
    /// стирается никогда — гейт на ней означал бы, что однажды снесённый
    /// человек, возвращённый в корпус, навсегда лишает директора права снять с
    /// него обычную приостановку. Здесь нужен признак «снос ТЕКУЩИЙ, ещё не
    /// отменённый», и это ровно `removedAt`. Сторожится не докстрингом, а
    /// тестом: ArbiterRemovalForCauseIntegration::
    /// test_ChiefStillLiftsOrdinarySuspensionAfterReseat — снесли, вернули,
    /// приостановили обычным порядком, директор снял. Заведён потому, что
    /// симуляция этого промаха давала 0 красных из 831.
    ///
    /// ⚠️ ПРАВО ЕДЕТ ЗА ПРАВОМ СНОСИТЬ (круг правок 1, В-2, 16 августа 2026).
    /// Не «владелец» вообще, а ТОТ, У КОГО СЕГОДНЯ СНОС: до передачи владелец,
    /// после — названный преемник (_removalAuthority, одно выражение на оба
    /// места). Прежняя редакция сравнивала с владельцем всегда, и это прямо
    /// противоречило доводу, ради которого removeArbiterForCause владельца
    /// выпихивает: «дороги назад нет — иначе сговор и слив переписки стали бы
    /// неснимаемыми вовсе». Замерено ревью: после передачи управление своё же
    /// окно снять не могло (модификатор его не видел), а владелец — снимал
    /// ЧУЖОЕ, и вернуть приостановку после этого нельзя ничем.
    ///
    /// Отсюда и снятый модификатор: `onlyOwnerOrChief` не пустил бы преемника
    /// в тело вовсе, и после передачи окно не открывал бы НИКТО — дверь без
    /// открывающего хуже двери у владельца (тот же довод, что записан в
    /// removeArbiterForCause про нулевой daoAddress). Обычная ветка ходит под
    /// той же проверкой, что раньше, — _requireOwnerOrChief, то самое тело
    /// модификатора, вызванное явно.
    ///
    /// ⚠️ Честная оговорка про происхождение окна (найдено ревью, 16 августа
    /// 2026). Различитель отвечает на вопрос «висит ли на человеке снос», а не
    /// «этим ли сносом поставлено окно», и на одном живом пути это уже
    /// расходится: `applyAsArbiter` зовёт `clearRemovalRecord(..., false)` —
    /// стирает `removedAt`, НАМЕРЕННО оставляя `suspendedUntil` (шов M-4: иначе
    /// снятый покупал бы обход окна C-1 свежим залогом). После самозаписи
    /// человек сидит с живым окном сноса и нулевым различителем, то есть эта
    /// ветка на нём не срабатывает.
    ///
    /// ⚠️ ДОВОД «ДЫРЫ СЕГОДНЯ НЕТ» ПОЧИНЕН (уборка 7а, п. 2.2). Прежняя
    /// редакция говорила: «дыры нет потому, что applyAsArbiter требует активного
    /// ДАО, а при активном ДАО _requireOwnerOrChief директора не видит вовсе».
    /// Это разбор только для ДИРЕКТОРА, и для него он верен. Для ВЛАДЕЛЬЦА он
    /// неверен, и остаток настоящий:
    ///
    ///   после передачи права сноса владелец всё ещё снимает окно ЧУЖОГО сноса
    ///   за ДВЕ транзакции — снесённый зовёт `applyAsArbiter` (окно переживает
    ///   по правилу M-4), `removedAt` обнуляется, и владельца пускает обычная
    ///   ветка ниже, потому что различитель уже ноль.
    ///
    /// Это не регресс: до правки В-2 то же самое делалось ОДНОЙ транзакцией.
    /// И чинится оно не здесь — по-настоящему чинит только память о том, КТО
    /// наложил приостановку, а она объявлена вне объёма этой работы и лежит
    /// пунктом в OPEN-ITEMS вместе с той же оговоркой про происхождение окна.
    /// Инвариант сегодня держится на совпадении двух независимых предикатов, и
    /// ни один тест эту пару не сверяет.
    function liftSuspension(address arbiter) external {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        if (d.removedAt[arbiter] != 0) {
            (address authority, ) = _removalAuthority(d);
            if (msg.sender != authority) revert RemovalSuspensionIsRemovalAuthorityOnly();
        } else {
            _requireOwnerOrChief(d);
        }

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

    /// Потолок — ОДИН на все три двери: обе двери обвинения (proposeRemoval,
    /// removeArbiterForCause) и дверь защиты (respondToRemoval). Общее правило
    /// живёт в одном месте, а не копией на каждой стороне.
    ///
    /// ⚠️ Здесь стояла копия, и это было замерено, а не заподозрено (круг
    /// правок 1, 18 августа 2026): до правки respondToRemoval считала длину
    /// своей строкой, и мутация «считать символы вместо байтов», внесённая в
    /// _requireReason, дверь ответа НЕ задевала вовсе. То есть у одного
    /// правила было два независимых дома, и разойтись они могли молча —
    /// защита получила бы вдвое меньше места, чем обвинение, и заметил бы это
    /// только тот, кто пишет не по-английски.
    ///
    /// Длина возвращается наружу, потому что она нужна вызывающему ещё раз, и
    /// каждому — за своим: `_requireReason` сверяет ею обязательность,
    /// `respondToRemoval` гейтит ею событие (пустых слов в ленте не бывает).
    /// Обе двери обвинения читают длину заново уже перед своим `emit` —
    /// сегодня это единственное оставшееся повторение, и оно безобидное:
    /// `bytes(s).length` не правило, а вопрос к той же строке. Считать её
    /// здесь и выбросить значило бы завести ту же копию заново, только на
    /// полстроки ниже.
    function _requireWithinCap(string calldata words) private pure returns (uint256 len) {
        len = bytes(words).length;
        if (len > MAX_REASON_BYTES) revert ReasonTooLong(len);
    }

    /// Обязательность — только у ОБВИНИТЕЛЯ, и потому живёт отдельно от
    /// потолка. Асимметрия здесь не случайность и не недоделка: у обвинителя
    /// слова — обязанность (там, где цепь молчит), у обвиняемого — право.
    /// Заставлять человека оправдываться публично нельзя. Разделив общее и
    /// разное, мы делаем эту разницу видимой в коде, а не поддерживаемой
    /// дисциплиной того, кто будет править файл через полгода.
    ///
    /// Одно правило на обе двери обвинения (proposeRemoval и
    /// removeArbiterForCause). Копии здесь быть не должно: разойдясь, они дали
    /// бы предложение, которое проходит без слов, и снос, который без них не
    /// проходит, — то есть паузу, в которую обвиняемому нечего читать.
    ///
    /// Порядок проверок: длина ПЕРЕД обязательностью. Иначе обвинитель,
    /// приславший 5 килобайт на проверяемом коде, получил бы «ок» вместо
    /// отказа, и калдата такого размера доехала бы до цепи.
    function _requireReason(bool verified, string calldata reason) private pure {
        uint256 len = _requireWithinCap(reason);
        if (!verified && len == 0) revert ReasonRequired();
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

    /// КТО СЕГОДНЯ ВПРАВЕ СНОСИТЬ — единственное место, где это вычисляется
    /// (п. 66, круг правок 1, 16 августа 2026). Отвечает сразу двумя вещами:
    /// адресом права и признаком, уехало ли оно, — потому что вызывающим нужны
    /// оба, а считать их по отдельности значило бы развести условие на копии.
    ///
    /// До правки предикат «передано» стоял здесь одной копией, в
    /// removeArbiterForCause, и `liftSuspension` не знала о нём вовсе. Копий
    /// этого условия по проекту уже три (тут, ArbiterRegistryFacet.
    /// _requireSeatingNotHandedOver, ArbiterRegistryFacet.setDAOAddress), и
    /// четвёртая, написанная своими словами, была бы ровно тем швом, который
    /// в этой ветке ловили как M-3: два выражения, обещание «они совпадают», и
    /// ничего, что покраснеет при расхождении.
    ///
    /// ⚠️ Про `&& d.daoAddress != address(0)`: передача защёлкивается только
    /// когда преемник РЕАЛЬНО НАЗВАН. Без второй половины в окне «порог
    /// заработан посторонними, преемник ещё не назначен» право уезжало бы на
    /// нулевой адрес — то есть дверь не открывал бы никто. Полный разбор — в
    /// докстринге removeArbiterForCause.
    function _removalAuthority(ArbiterRegistryStorage.Data storage d)
        private
        view
        returns (address authority, bool handedOver)
    {
        handedOver = _isDaoActive(d) && d.daoAddress != address(0);
        authority = handedOver ? d.daoAddress : OwnershipLib.contractOwner();
    }

    /// `disputeRef` читается ТОЛЬКО кодом Silence: молчание — признак по
    /// конкретному спору (`disputeNoResponseAtBy[сделка][арбитр]`), и без
    /// адреса спора проверить его нечем. Для остальных кодов параметр обязан
    /// быть нулевым — иначе в записи оседал бы адрес, ни к чему не
    /// относящийся, и читатель решил бы, что снос связан с той сделкой.
    ///
    /// Право сноса передаётся, а не запирается, и передача защёлкивается
    /// ТОЛЬКО когда преемник реально существует: пока `daoAddress` нулевой,
    /// зовёт владелец — сколько бы путей ни включило `isDaoActive()`. После
    /// того как преемник назван, зовёт только он (не через onlyOwnerOrDAO из
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
    ///
    /// ⚠️ `reason` — ОБЯЗАННОСТЬ обвинителя ровно там, где цепь молчит
    /// (замысел 17 августа 2026, решение 7). До этой правки публичная запись о
    /// сносе не содержала ни одного слова: `Cause` — числовой код, событие
    /// несёт адреса, код, отпечаток и сумму. Имя «снос с поводом» обещало
    /// объяснение, которого не было нигде. Правило легло на уже существующий
    /// `_isChainVerifiable` без нового условия: три проверяемых кода цепь
    /// объясняет сама, три заверяемых на слово — обязаны объясняться словами.
    function removeArbiterForCause(
        address arbiter,
        Cause   cause,
        bytes32 evidenceDigest,
        address disputeRef,
        string calldata reason
    ) external {
        if (arbiter == address(0)) revert ArbiterZeroAddress();

        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        // ⚠️ ПРЕДИКАТ ТОТ ЖЕ, ЧТО У СОСЕДНЕЙ ДВЕРИ (п. 69, 16 августа 2026).
        // Раньше здесь стоял один `_isDaoActive(d)`, и это отличалось от
        // ArbiterRegistryFacet._requireSeatingNotHandedOver и от
        // ArbiterRegistryFacet.setDAOAddress, где условие полное.
        //
        // ⚠️ Ссылки ПО ИМЕНИ ФУНКЦИИ, а не по номеру строки (уборка 7а, п. 2.6).
        // Здесь стояли `:855` и `:1956` — оба уехали за задачи 3-5 и указывали
        // не туда, молча. Правило на будущее: номер строки в комментарии живёт
        // до первой правки СОСЕДА и протухает без единого признака. Имя
        // функции находится грепом и переживает переезд.
        //
        // Цена расхождения замерена, а не предположена: isDaoActive()
        // включается не только ручным activateDAO() (у того есть защита
        // DaoAddressNotSet), но и ЗАРАБОТАННЫМ порогом uniqueActiveUsers >=
        // DAO_THRESHOLD — то есть чужим действием, без единой нашей
        // транзакции. В окне «порог заработан, преемник ещё не назван»
        // прежнее условие вырождалось в `msg.sender != address(0)` — истинно
        // для ВСЕХ, и removeArbiterForCause не мог позвать никто. Дверь,
        // которую не открывает никто, хуже двери у владельца: единственный
        // путь снять арбитра с поводом отключался бы посторонним.
        //
        // Окно закрывается одной транзакцией владельца (setDAOAddress в этом
        // состоянии требует именно его), но до неё дверь обязана оставаться
        // рабочей — ровно то, что публичный docs/DECENTRALIZATION.md, Stage 3
        // и обещает читателю: «once governance is active AND a successor
        // address has been named».
        //
        // ⚠️ Само условие переехало в _removalAuthority (п. 66, круг правок 1,
        // 16 августа 2026) — не ради красоты, а потому что у него появился
        // ВТОРОЙ читатель: liftSuspension. Право отменить окно сноса обязано
        // ехать вместе с правом сносить, и вычисляться по одному выражению, а
        // не по двум похожим. Поведение здесь не изменилось ни на байт: ветка
        // и обе ошибки те же.
        (address authority, bool handedOver) = _removalAuthority(d);
        if (msg.sender != authority) {
            if (handedOver) revert RemovalHandedOver();
            revert NotOwner();
        }

        if (!d.isArbiter[arbiter]) revert NotAnArbiter();

        // ⚠️ REMOVAL ONLY RUNS THROUGH A PROPOSAL THAT HAS SAT (design of
        // 17 August 2026, decisions 1-2). Before this change the proposal
        // existed but was OPTIONAL and changed nothing: removal was a single
        // button, and the person learned of it after the fact — sentence
        // first, word after.
        //
        // Execution window: [proposedAt + REMOVAL_DELAY, proposedAt +
        // PROPOSAL_TTL). The lower bound is inclusive, the upper exclusive,
        // exactly as in hasLiveProposal — diverge from it and the button would
        // go dark before the feed stops showing the accusation as live.
        //
        // Read HERE rather than through hasLiveProposal(): that one answers
        // "does an accusation stand", while three different refusals with
        // three different hints are needed here — "no accusation", "too
        // early", "expired". One boolean answering three questions would leave
        // the form guessing.
        ArbiterRegistryStorage.RemovalProposal storage p = d.removalProposals[arbiter];
        uint256 proposedAt = p.proposedAt;
        if (proposedAt == 0) revert NoLiveProposal();
        if (block.timestamp < proposedAt + REMOVAL_DELAY) {
            revert RemovalTooEarly(proposedAt + REMOVAL_DELAY);
        }
        if (block.timestamp >= proposedAt + PROPOSAL_TTL) revert ProposalStale(proposedAt);

        // EXACTLY the cause code is compared — the thing the person was warned
        // about. Not the whole application: the digest, the dispute reference
        // and the words are supplied afresh, by the accuser's own arguments,
        // and the older rule "a proposal is a signal in the feed, not an
        // argument of the removal function" is not repealed by this. It would
        // be repealed if removal READ anything out of the proposal and put it
        // into the record; it still reads nothing — it merely refuses to
        // execute an accusation that was never served.
        if (p.cause != uint8(cause)) {
            revert CauseDiffersFromProposal(p.cause, uint8(cause));
        }

        bool verified = _isChainVerifiable(cause);
        if (verified) {
            _requireProven(d, arbiter, cause, disputeRef);
        } else {
            if (disputeRef != address(0)) revert DisputeRefNotApplicable();
            // Цепь не проверяет ничего и не притворяется — но пустая запись
            // тоже не годится: у нуля нет прообраза, который можно показать.
            if (evidenceDigest == bytes32(0)) revert EvidenceRequired();
        }
        _requireReason(verified, reason);

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

        // Вечная половина той же записи (п. 72). Кодирует библиотека — здесь
        // передаётся сырой номер повода, ровно тот же, что уезжает в событие
        // ArbiterRemovedForCause ниже.
        ArbiterRegistryStorage.recordRemovalForCause(d, arbiter, uint8(cause));

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
        // предложения — видно в одной транзакции (оба события лежат в одном
        // логе), без сшивания с RemovalProposed по адресу арбитра через
        // историю.
        //
        // ⚠️ THE CONDITION BELOW CANNOT BE FALSE ANY MORE, and saying so beats
        // letting the next reader take it for a guard (17 August 2026). The
        // gate at the top of this function already refused `proposedAt == 0`
        // with NoLiveProposal, and nothing between there and here clears the
        // record — so every removal that reaches this line consumed a real
        // proposal. Kept rather than deleted because deleting it changes no
        // behaviour and no test could tell the two versions apart; the honest
        // note is the part that has value. The scene it used to serve — a
        // removal with no preceding proposal — is gone with the test that
        // played it (see test/ArbiterRemovalForCause.t.sol).
        //
        // WHAT WOULD MAKE IT REACHABLE AGAIN — so the next reader neither
        // deletes it as litter nor has to guess. Exactly three things, and any
        // one of them is enough:
        //   • the `proposedAt == 0` refusal at the top weakens — a "fast path"
        //     for some cause, an exemption for the successor, anything that
        //     lets a removal run without a standing proposal;
        //   • something between that refusal and the snapshot below starts
        //     clearing `d.removalProposals[arbiter]` — today nothing does, and
        //     the snapshot is deliberately taken BEFORE clearSeat for that
        //     reason;
        //   • the snapshot moves ABOVE the gate, at which point it can again
        //     be read on a record the gate was going to reject.
        // If any of those happens, this branch goes back to carrying weight
        // and needs a test of its own; until then it carries none.
        if (consumedProposal.proposedAt != 0) {
            emit RemovalProposalConsumed(
                arbiter,
                Cause(consumedProposal.cause),
                consumedProposal.by,
                consumedProposal.evidenceDigest,
                consumedProposal.proposedAt
            );
        }

        // Слова — отдельным логом той же транзакции, и только если они есть:
        // пустая строка в ленте стирала бы разницу между «объяснил» и
        // «промолчал».
        if (bytes(reason).length != 0) {
            emit RemovalReasonGiven(arbiter, msg.sender, REASON_STAGE_REMOVAL, reason);
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
    ///
    /// ⚠️ `reply` — ПРАВО, а не обязанность (замысел 17 августа 2026, решение
    /// 7). Пустая строка законна и события не порождает. Отпечаток
    /// по-прежнему обязателен: он и есть ответ, а слова — его краткое
    /// изложение для ленты. Пускать ответ без отпечатка означало бы, что
    /// «ответ» может быть строкой без прообраза, а признак «уже отвечал»
    /// (`removalReply != 0`) перестал бы работать.
    function respondToRemoval(bytes32 replyDigest, string calldata reply) external {
        if (replyDigest == bytes32(0)) revert ZeroDigest();
        // Потолок берётся из общей проверки, а не считается здесь заново:
        // единица счёта у обвинения и защиты обязана быть одной. Что копия
        // расходится молча — замерено, см. _requireWithinCap.
        //
        // Обязательности здесь нет и быть не должно: _requireReason сюда не
        // зовут именно поэтому. Пустой ответ законен.
        uint256 len = _requireWithinCap(reply);

        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        if (d.removedAt[caller] == 0) revert NothingToAnswer();
        if (d.removalReply[caller] != bytes32(0)) revert AlreadyAnswered();

        d.removalReply[caller] = replyDigest;
        emit RemovalAnswered(caller, replyDigest);
        if (len != 0) {
            emit RemovalReplyGiven(caller, reply);
        }
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
    // ⚠️ The link between proposal and execution is CLEANUP plus ONE
    // COMPARISON (design of 17 August 2026). removeArbiterForCause still READS
    // nothing out of removalProposals into the record: the cause code, the
    // digest, the dispute reference and the words are all supplied afresh, by
    // the accuser's own arguments. Taking the proposal on trust and executing
    // it with one button would be the mirror image of the very risk for which
    // the right of removal is withheld from the chief altogether.
    //
    // But since 17 August the proposal is a MANDATORY INPUT: without one there
    // is no removal, and the pause runs from it. Hence the single comparison —
    // the cause code at execution must match the one proposed. Otherwise the
    // warning would be about one thing and the execution about another, and
    // "a word before the sentence" would be a word off the point.
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
    ///
    /// ⚠️ Слова обязательны ЗДЕСЬ, а не только при исполнении (замысел 17
    /// августа 2026, решения 1+7 вместе). Между предложением и сносом теперь
    /// стоит пауза, во время которой обвиняемый вправе ответить. Если слова
    /// появляются только в момент сноса, пауза даёт человеку числовой код
    /// повода и ничего больше — отвечать он будет на догадку.
    ///
    /// ⚠️ Since 17 August 2026 this is the ONLY way in to a removal. The
    /// proposal is no longer "a signal one may skip": without it
    /// removeArbiterForCause reverts NoLiveProposal, and executing it is
    /// possible no earlier than REMOVAL_DELAY and no later than PROPOSAL_TTL
    /// from this very second.
    function proposeRemoval(
        address arbiter,
        Cause   cause,
        bytes32 evidenceDigest,
        string calldata reason
    )
        external
        onlyOwnerOrChief
    {
        if (arbiter == address(0)) revert ArbiterZeroAddress();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        if (!d.isArbiter[arbiter]) revert NotAnArbiter();

        bool verified = _isChainVerifiable(cause);
        if (!verified && evidenceDigest == bytes32(0)) revert EvidenceRequired();
        _requireReason(verified, reason);

        d.removalProposals[arbiter] = ArbiterRegistryStorage.RemovalProposal({
            cause:          uint8(cause),
            evidenceDigest: evidenceDigest,
            proposedAt:     block.timestamp,
            by:             msg.sender
        });
        emit RemovalProposed(arbiter, msg.sender, cause, evidenceDigest, block.timestamp);
        if (bytes(reason).length != 0) {
            emit RemovalReasonGiven(arbiter, msg.sender, REASON_STAGE_PROPOSAL, reason);
        }
    }

    /// Withdraw a proposal before it expires — YOUR OWN. The holder of the
    /// removal right may withdraw anyone's.
    ///
    /// ⚠️ THIS USED TO BE "ANYONE'S, BY EITHER OF THE TWO" (review round 1 of
    /// the 48-hour pause, 17 August 2026). Both the owner and the chief walked
    /// under onlyOwnerOrChief and either could clear any record — harmless
    /// while a proposal was only a SIGNAL that took nothing away.
    ///
    /// The pause ended that. A removal now runs ONLY through a proposal that
    /// has sat, so clearing someone else's record is the power to STOP a
    /// removal — and to do it again every time, for as long as the accuser
    /// keeps trying. The chief was deliberately denied the power to remove;
    /// giving him the power to prevent one is no lighter, and it lands on the
    /// exact principle the owner set out: gate what is WEIGHTY, not
    /// everything.
    ///
    /// There is no case where the chief needs to withdraw the owner's
    /// proposal. Someone else's record expires on its own after PROPOSAL_TTL,
    /// and the chief cannot execute it in any event — it just lies there,
    /// harming nobody.
    ///
    /// ⚠️ "The elder" is _removalAuthority, not the owner literally — the same
    /// predicate as the right to remove, not a second condition written in its
    /// own words (the seam this branch already caught twice: see M-3 and the
    /// docstring of _removalAuthority). Before handover that is the owner;
    /// after it, the named successor. So the successor gains a door that
    /// onlyOwnerOrChief kept shut to him entirely — the same fix as В-2 made
    /// for liftSuspension, and for the same reason: a door nobody opens is
    /// worse than a door at the owner's.
    ///
    /// The modifier is gone from the signature for that reason and that reason
    /// only; the role check itself did not weaken. Callers who are not the
    /// authority still go through _requireOwnerOrChief — the very body of the
    /// old modifier, now called explicitly — so a stranger still gets
    /// NotOwnerOrChief, and the chief still loses this door entirely once
    /// governance is active (I-2).
    function withdrawProposal(address arbiter) external {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        ArbiterRegistryStorage.RemovalProposal storage p = d.removalProposals[arbiter];

        (address authority, ) = _removalAuthority(d);
        if (msg.sender != authority) {
            _requireOwnerOrChief(d);
            // An empty record needs no separate branch: `by` is the zero
            // address there, and no caller can be the zero address. So a
            // non-authority calling against nobody's record is refused by this
            // very line, while the authority still passes above it and no-ops
            // in silence — which is what Minor 3 below is about.
            if (msg.sender != p.by) revert NotYourProposal();
        }

        // Minor 3, круг правок 1: событие только если запись реально была —
        // иначе вызов против человека, на которого никто ничего не клал,
        // оставлял бы в ленте RemovalProposalWithdrawn, читающийся как «против
        // него что-то было и это отозвали». Лента и есть весь смысл этой
        // работы, врать ей нельзя даже пустым отзывом.
        bool existed = p.proposedAt != 0;
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

    /// The pause between a proposal and the removal. Ask the chain rather than
    /// counting at home: a copy of this number in the frontend would drift in
    /// silence and show the button as live an hour before it starts working.
    function getRemovalDelay() external pure returns (uint256) {
        return REMOVAL_DELAY;
    }

    /// Потолок слов в БАЙТАХ. Форма обязана спрашивать его у цепи, а не
    /// хранить своё число: разойдясь, они дадут человеку отказ транзакции
    /// вместо подсказки в поле.
    function getMaxReasonBytes() external pure returns (uint256) {
        return MAX_REASON_BYTES;
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
    ///
    /// `removalCount` / `lastRemovalAt` / `lastRemovalCause` — история сносов
    /// (п. 72, 16 августа 2026). Она отвечает на вопрос, на который остальные
    /// поля ответить не могут: `removedAt` выше говорит только про ТЕКУЩИЙ,
    /// ещё не отменённый снос и обнуляется любой повторной посадкой — а
    /// повторную посадку делает обвинитель, и после включения ДАО ещё и сам
    /// обвиняемый. Без этих трёх полей карточка показывала бы чистого
    /// человека тому, кого сносили трижды.
    ///
    /// `lastRemovalCause` закодирован: 0 — не снимали ни разу, 1..6 — Cause
    /// плюс единица, 252..255 — автодемоушен (повода нет, но путь назван:
    /// AUTO_REMOVAL_BASE + ArbiterRegistryFacet.DemotionPath, то есть
    /// 253 — переворот владельцем, 254 — таймаут агримента, 255 — голоса по
    /// апелляции; 252 — «путь не назван», его не шлёт ни один вызывающий).
    /// Кодировку держит ArbiterRegistryStorage, здесь только чтение.
    ///
    /// Три автоматических кода, а не один (16 августа 2026): различие путей
    /// завела задача 4 и потратила на него отдельное поле события, но
    /// СОБЫТИЯ не читает никто (п. 72) — карточка единственное читаемое
    /// место, и единый код терял бы различие ровно там, где оно нужно.
    ///
    /// Селектор функции от типа возврата не зависит — расширение кортежа
    /// каскад деплоя не трогает; читателей у функции сегодня ноль
    /// (проверено грепом по frontend/src), ломать нечего.
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
        bool    hasLiveRemovalProposal,
        uint256 removalCount,
        uint256 lastRemovalAt,
        uint8   lastRemovalCause
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
            hasLiveProposal(arbiter),
            d.removalCount[arbiter],
            d.lastRemovalAt[arbiter],
            d.lastRemovalCause[arbiter]
        );
    }

    // ============================================================
    //  ЧТЕНИЯ, ПЕРЕЕХАВШИЕ ИЗ ArbiterRegistryFacet (задача 4.5, 16 августа 2026)
    //
    //  ⚠️ ЭТО ПЕРЕНОС, А НЕ ПРАВКА. Тела ниже — байт в байт те же, что стояли в
    //  ArbiterRegistryFacet; ни одно поведение не изменено. Снаружи даймонда
    //  перенос не виден вообще: вызывающий бьёт в тот же адрес прокси тем же
    //  селектором и получает тот же ответ — меняется только строка во
    //  внутренней таблице маршрутов.
    //
    //  ПОЧЕМУ ПЕРЕЕХАЛИ. ArbiterRegistryFacet упёрся в потолок EIP-170:
    //  24 516 байт из 24 576, свободно 60 — «реестр арбитров больше нельзя
    //  чинить». Соседний фасет занят на 18 %. Оба держат ОДИН неймспейс
    //  (ArbiterRegistryStorage, тот же POSITION), поэтому переноса данных не
    //  происходит вовсе и раскладка хранилища не тронута ни на бит.
    //
    //  ПОЧЕМУ ИМЕННО ЭТИ. Граница проведена по смыслу: сюда уехали чтения про
    //  ПОВЕДЕНИЕ арбитра, его ПОЛОЖЕНИЕ и ДОКАЗАТЕЛЬСТВА — то, чем этот фасет и
    //  занимается (прецедент задан getArbiterStanding выше, она читает те же
    //  поля). В реестре осталось то, чему он хозяин: состав корпуса, споры,
    //  вердикты, апелляции и деньги.
    //
    //  ⚠️ ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ: геттеров КОНСТАНТ реестра
    //  (getMinXPToRegister, getNoResponseFloor, getMaxArbiterMistakes,
    //  getMaxClaimsPerArbiter). Их числа объявлены приватно в
    //  ArbiterRegistryFacet и применяются остающимся там кодом; переезд геттера
    //  завёл бы ВТОРОЕ объявление, и наружу отвечало бы зеркало, а правило
    //  применялось бы по оригиналу — тот же класс дефекта, что разобран в
    //  докстринге _msgSender выше как M-3. Нужны будут эти байты — константа
    //  переносится в ArbiterRegistryStorage ОДНИМ объявлением на оба фасета,
    //  как уже сделано с SUSPENSION_WINDOW.
    // ============================================================

    // ── Поведение и положение арбитра ──

    /// @notice Серия судейских ошибок подряд. На MAX_ARBITER_MISTAKES
    /// автодемоушен снимает статус и обнуляет счётчик, поэтому в покое значение
    /// всегда строго меньше порога — разбор в докстринге MISTAKE_THRESHOLD.
    function getArbiterMistakeStreak(address addr) external view returns (uint256) { return ArbiterRegistryStorage.data().arbiterMistakeStreak[addr]; }

    /// @notice Сколько раз вердикт этого арбитра дошёл до финализации
    /// неперевёрнутым. Задел под будущую конвертацию «залог плюс судейский
    /// стаж» при включении ДАО (задача 5, 15 августа 2026) — сам перевод здесь
    /// не реализован, только счётчик.
    function getCleanVerdicts(address arbiterAddr) external view returns (uint256) {
        return ArbiterRegistryStorage.data().cleanVerdicts[arbiterAddr];
    }

    /// @notice Залог арбитра. Форфейтится в банк при сносе по поводу и при
    /// автодемоушене, возвращается целиком при resignAsArbiter.
    function getArbiterBond(address addr) external view returns (uint256) { return ArbiterRegistryStorage.data().arbiterBond[addr]; }

    /// @notice Сколько споров арбитр держит прямо сейчас. Потолок —
    /// ArbiterRegistryFacet.getMaxClaimsPerArbiter().
    function getOpenClaimCount(address addr) external view returns (uint256) { return ArbiterRegistryStorage.data().openClaimCount[addr]; }

    /// @notice Накопленная доля сборов, которую арбитр ещё не забрал.
    function getArbiterReward(address arbiter) external view returns (uint256) { return ArbiterRegistryStorage.data().arbiterRewards[arbiter]; }

    /// @notice Послужной список: сделки, по которым этот арбитр брал спор.
    function getArbiterDeals(address arbiter) external view returns (address[] memory) { return ArbiterRegistryStorage.data().arbiterDeals[arbiter]; }

    // ── Провенанс посадки ──

    /// @notice Кто посадил этого арбитра. `address(0)` — самозапись через
    /// applyAsArbiter (нет ни залога, ни гейта по XP за ручной посадкой).
    function getSeatedBy(address arbiter) external view returns (address) {
        return ArbiterRegistryStorage.data().seatedBy[arbiter];
    }

    /// @notice Сколько арбитров этой посадки сидят прямо сейчас.
    function getSeatedCountBy(address seater) external view returns (uint256) {
        return ArbiterRegistryStorage.data().seatedCountBy[seater];
    }

    // ── Доказательства: якорь, молчание, отпечатки, ключи ──

    /// @notice Когда ТЕКУЩИЙ клеймер взял этот спор, в секундах блока. Если он
    /// брал его несколько раз — момент последнего взятия, от него и считается
    /// пол. 0 — спор не взят (в том числе отпущен) или взят до разреза 4в-2.
    ///
    /// Подпись односоставная намеренно: спрашивающему нужен якорь того, кто
    /// судит спор сейчас, а не история по каждому арбитру. История есть, она в
    /// событиях DisputeClaimed/DisputeReleased.
    function getDisputeClaimedAt(address agreement) external view returns (uint256) {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        return d.disputeClaimedAtBy[agreement][d.disputeClaims[agreement]];
    }

    /// @notice Когда текущий клеймер записал «просил, ответа нет». 0 — не записывал.
    /// Ноль здесь же означает «спор ничей»: запись принадлежит арбитру, а не
    /// сделке, и вместе с клеймом уходит из виду, не пропадая из цепи.
    ///
    /// ⚠️ Пол этой записи (NO_RESPONSE_FLOOR, 24 часа) объявлен и применяется в
    /// ArbiterRegistryFacet — спрашивать его надо там, через
    /// getNoResponseFloor(). Второго объявления здесь нет намеренно, см. шапку.
    function getNoResponseAt(address agreement) external view returns (uint256) {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        return d.disputeNoResponseAtBy[agreement][d.disputeClaims[agreement]];
    }

    /// @notice Все отпечатки предъявлений по сделке, в порядке появления.
    /// Порядок и есть содержание ответа: спор решается тем, что легло раньше.
    ///
    /// Удобен и честен на обычных числах, но список целиком при большом их
    /// количестве упирается в потолок газа на eth_call — и ломается чтение У
    /// АРБИТРА и у второй стороны, а не у того, кто список раздул. Кому нужна
    /// гарантия — getPresentationDigestsPage ниже. Кто именно положил каждый
    /// отпечаток, здесь не видно: это в событии PresentationDigestRecorded, и
    /// туда же ходят за номером блока.
    function getPresentationDigests(address agreement) external view returns (bytes32[] memory) {
        return ArbiterRegistryStorage.data().presentationDigests[agreement];
    }

    /// @notice Отпечатки по сделке окном: с `offset`, не больше `limit` штук.
    /// @dev Полный getPresentationDigests честен на малых числах, но при большом
    /// списке упирается в потолок eth_call — и ломается чтение У АРБИТРА, а не у
    /// того, кто список раздул. Окно даёт читателю выход без апгрейда контракта.
    ///
    /// ⚠️ На честном запросе НЕ ревертит никогда: читатель не обязан заранее
    /// знать длину, а узнать её он может только вторым вызовом — то есть в
    /// другом блоке, когда длина уже другая. Реверт на «offset за концом»
    /// означал бы, что листающий обязан выиграть гонку с пишущим. Поэтому:
    ///   - `offset` за концом списка (и пустой список)  → пустой массив;
    ///   - `limit == 0`                                  → пустой массив;
    ///   - `offset + limit` больше длины                 → хвост до конца.
    /// Пустой ответ читается однозначно: «здесь больше ничего нет», и это
    /// условие остановки для листающего. Отличить его от «мимо» можно
    /// getPresentationDigestCount, но обычно незачем.
    ///
    /// Сумма `offset + limit` не считается нигде намеренно, и это не
    /// придирка: на checked-арифметике 0.8 наивное `offset + limit` при
    /// `limit` вроде type(uint256).max ПАНИКУЕТ (0x11), то есть ровно ломает
    /// обещание «на честном запросе не ревертит» — а «дай всё с этого места»
    /// запрос честный. Замерено мутацией: наивная сумма → красный тест
    /// test_Page_HugeLimit_IsUpToTheEnd_NotARevert с panic 0x11.
    function getPresentationDigestsPage(address agreement, uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory)
    {
        bytes32[] storage all = ArbiterRegistryStorage.data().presentationDigests[agreement];
        uint256 len = all.length;
        if (offset >= len) return new bytes32[](0);

        uint256 available = len - offset;
        uint256 n = limit < available ? limit : available;

        bytes32[] memory page = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            page[i] = all[offset + i];
        }
        return page;
    }

    /// @notice Сколько отпечатков лежит по сделке. Отдельно от списка — чтобы
    /// экран, которому нужно только «есть или нет», не тащил весь массив.
    function getPresentationDigestCount(address agreement) external view returns (uint256) {
        return ArbiterRegistryStorage.data().presentationDigests[agreement].length;
    }

    /// Открытые половины ключей чата арбитра. Нули означают «ключей нет» —
    /// для 4в это признак «предъявлять некому», и различать «нет записи» от
    /// «записан нуль» незачем: нулевой ключ запрещён при записи.
    ///
    /// ⚠️ Обратное неверно: ненулевой ключ НЕ означает «действующий арбитр».
    /// Ключ не стирается при потере статуса (removeArbiterForCause/
    /// resignAsArbiter/демоушен) — см. предупреждение в setArbiterChatKey.
    /// Статус читается отдельно, через ArbiterRegistryFacet.isRegisteredArbiter,
    /// а не выводится из наличия ключа.
    function getArbiterChatKeys(address arbiter)
        external
        view
        returns (bytes32 boxKey, bytes32 signKey)
    {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        return (d.arbiterBoxKey[arbiter], d.arbiterSignKey[arbiter]);
    }
}
