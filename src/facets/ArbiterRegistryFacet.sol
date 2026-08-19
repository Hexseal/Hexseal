// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

// ============================================================
// HEXSEAL — ArbiterRegistryFacet.sol
//
// Реестр арбитров + DAO-режим + Diamond-as-arbiter + вознаграждения
//
// Архитектура:
//   1. Арбитр клеймит спор через commit-reveal → Diamond становится арбитром в Agreement
//   2. Арбитр вызывает submitVerdict(agreement, clientWins) → вердикт в очереди
//   3. Любой вызывает finalizeVerdict(agreement) → Diamond исполняет resolveDispute
//   4. Owner/DAO может overturnVerdict до финализации → slash XP арбитра, выплата не идёт
//
// FeeVault: пополняется вручную (fundVault) и держит буфер под будущие нужды
//   банка арбитров (Treasury.distribute()), но больше не платит за конкретный
//   спор — плоская выплата rewardPerDispute отвергнута дизайном 28 июля и
//   снята 31 июля (setRewardPerDispute теперь ревертит RewardPathRetired,
//   поле rewardPerDispute мёртвое). Оплата за вердикт сегодня из двух
//   источников: creditDisputeFee (80% от 3% сбора со спорной суммы —
//   внутренний замысел экономики арбитража, не публикуется) и
//   disputeBounty — доплата стороны спора до arbiterFloor на мелком котле
//   (fundDispute), которая при финализации уходит арбитру в finalizeVerdict.
//   Арбитр забирает накопленное через withdrawArbiterReward().
//
// DAO-режим: когда uniqueActiveUsers >= 100,000 ИЛИ owner.activateDAO() —
//   пользователи с XP >= 3000 могут сами вступить через applyAsArbiter().
// ============================================================

import "../../src/FactoryFacet.sol";         // FactoryStorage (trustedForwarder, usdc)
import "../../src/DiamondProxy.sol";          // OwnershipLib
import "../../src/facets/ReputationFacet.sol"; // ReputationStorage (XP + cleanStreak + uniqueActiveUsers)
import "../RegistryFacet.sol";                // RegistryStorage — verifying notifyArbiterTimeout's caller
// ArbiterAccountabilityFacet for ONE event declaration: ArbiterSuspensionLifted.
// The vindication branch below lifts a suspension, and a lift that leaves no log
// reads in the feed as a suspension that never ended (review round 1 of task 12).
// The declaration stays where the other suspension events live — a second copy
// here would compile, produce an identical log, and drift on the first edit.
//
// ⚠️ The import is circular (that file imports this one for ArbiterRegistryStorage)
// and Solidity resolves it: neither side inherits from the other, both references
// are to types. Measured by building, not assumed.
import {ArbiterAccountabilityFacet} from "./ArbiterAccountabilityFacet.sol";

// ---------- INTERFACES ----------

interface IAgreementStatus {
    function status()    external view returns (uint8);
    function setArbiter(address newArbiter) external;
    function client()    external view returns (address);
    function executor()  external view returns (address);
    function amount()    external view returns (uint256);
    function disputedAt() external view returns (uint256);
}

interface IUSDCFull {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

// ---------- STORAGE ----------

library ArbiterRegistryStorage {
    /// @custom:storage-location erc7201:hexseal.arbiterregistry.storage
    /// keccak256(abi.encode(uint256(keccak256("hexseal.arbiterregistry.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 constant POSITION = 0xaae71de0594cbcb5434f0ab7f7501c1be178552bf788b418a1c2624ba9718d00;

    /// Сколько держит приостановка арбитра, если её не сняли раньше. Утверждено
    /// владельцем 15 августа 2026: окно финализации — сутки, окно апелляции —
    /// четверо; трое суток хватает разобраться и не держит честные стороны
    /// неделю.
    ///
    /// ⚠️ ЖИВЁТ В БИБЛИОТЕКЕ, А НЕ В ФАСЕТЕ (финальный обзор ветки, правка A,
    /// 16 августа 2026). Приостановку выставляют ДВА места в ДВУХ разных
    /// файлах — и состав их сменился задачей 12 (18 августа 2026):
    ///
    ///   • `ArbiterAccountabilityFacet._performRemoval` — общее тело сноса,
    ///     то есть обе двери сноса разом (было: только
    ///     `removeArbiterForCause`);
    ///   • `ArbiterRegistryFacet._recordArbiterMistake` — ветка порога, где
    ///     приостановка теперь ГЛАВНОЕ действие, а не побочное: снятия там
    ///     больше нет, есть обвинение и быстрый рычаг.
    ///
    /// СТИРАЕТ отметку с той же задачи и третье место —
    /// `ArbiterRegistryFacet.resolveAppeal`, когда коллегия оправдала арбитра
    /// и цепь забирает своё обвинение назад. Копия числа во втором файле
    /// создала бы ровно тот класс дефекта, который эта же ветка
    /// разбирала как M-3: два значения, обещание «они совпадают», и ничего, что
    /// покраснеет при расхождении. Здесь копий не остаётся и сверять нечего —
    /// оба фасета читают одно объявление.
    ///
    /// Наружу отдаётся через ArbiterAccountabilityFacet.getSuspensionWindow() —
    /// единственный публичный геттер этого числа, и он обязан продолжать отдавать
    /// то же самое: перенос менял МЕСТО объявления, а не значение.
    ///
    /// Константы в хранилище не лежат: `Data` ниже этим объявлением не двигается.
    uint256 internal constant SUSPENSION_WINDOW = 72 hours;

    struct PendingVerdict {
        address arbiter;        // кто подал вердикт
        bool    clientWins;     // результат
        uint256 submittedAt;    // timestamp подачи
        bool    frozen;         // заморожен owner/DAO (нельзя финализировать)
        bool    finalized;      // исполнен на Agreement
        bool    overturned;     // отменён owner/DAO (выплата не идёт, XP срезан)
        bool    executing;      // идёт finalizeVerdict — не удалять через clearDisputeClaim
        // ── User-initiated appeal (pre-finalization only) ──
        bool    appealed;        // апелляция подана
        bool    appealResolved;  // голосование по апелляции завершено
        address appellant;       // кто подал апелляцию — для рефанда/форфейта депозита
        uint256 appealDeadline;  // дедлайн окна голосования
        uint256 votesUphold;     // голосов "оставить как есть"
        uint256 votesOverturn;   // голосов "перевернуть"
    }

    /// Предложение директора снести арбитра (задача 7, 15 августа 2026).
    ///
    /// `cause` держится как `uint8`, а не как `Cause` — тот enum объявлен в
    /// ArbiterAccountabilityFacet, и завязывать раскладку хранилища на тип из
    /// другого файла означало бы, что переименование там двигает хранилище
    /// здесь. Значение — тот же численный код, что уже используется в событии
    /// ArbiterRemovedForCause.
    struct RemovalProposal {
        uint8   cause;
        bytes32 evidenceDigest;
        uint256 proposedAt;
        address by;
    }

    struct Data {
        mapping(address => bool)     isArbiter;
        address[]                    arbiterList;
        mapping(address => address)  disputeClaims;      // agreement → arbiter
        mapping(address => address[]) arbiterDeals;
        mapping(bytes32 => uint256)  claimCommitments;
        address                      chiefArbiter;
        bool                         daoActiveManual;
        // ── Diamond-as-arbiter + rewards ──
        mapping(address => PendingVerdict) pendingVerdicts;  // agreement → verdict
        mapping(address => uint256)        arbiterRewards;   // arbiter → USDC claimable
        uint256                            rewardPerDispute; // МЁРТВОЕ. Плоская выплата из банка отвергнута
                                                              // дизайном 28.07 (§7) и снята 31.07; поле оставлено,
                                                              // потому что раскладка append-only. Не читать и не писать.
        uint256                            vaultBalance;     // USDC held by Diamond for rewards
        address                            daoAddress;       // future DAO governance contract
        // ── Provisional status ──
        mapping(address => uint256)        arbiterMistakeStreak; // arbiter → подряд идущие судейские ошибки
        // ── Sybil-resistance: forfeitable bond ──
        mapping(address => uint256)        arbiterBond;           // arbiter → залоченный USDC-бонд
        mapping(address => uint256)        openClaimCount;        // arbiter → сколько споров сейчас забрано и не закрыто
        // ── Appeal voting ──
        mapping(address => mapping(address => bool)) hasVotedAppeal; // agreement → arbiter → уже проголосовал
        // ── Dispute settlement fee (3% от спорной суммы, считает Agreement) ──
        // Доля казны со споров (20% сбора). Начисляется, а не переводится в
        // момент расчёта: заблокированный feeRecipient иначе ронял бы каждый спор.
        uint256                            treasurySlice;
        // ── Платный вызов арбитра ──
        // Доплата до рабочего порога: на мелком котле 80% от 3% сбора не
        // окупают даже пятнадцати минут чтения, и спор никто не берёт.
        // Платит сторона, которой нужен судья, поэтому дотация из общего
        // банка с её фармом не требуется.
        mapping(address => uint256)        disputeBounty;      // сделка → внесённая доплата
        mapping(address => address)        disputeBountyPayer; // сделка → кто внёс
        uint256                            arbiterFloor;       // сколько арбитр должен получить суммарно
        // Мягкий возврат доплаты: clearDisputeClaim толкает transfer() и, если
        // он не доставился (чёрный список USDC у плательщика), не ревертит —
        // Agreement зовёт эту функцию внутри пустого try/catch (Agreement.sol,
        // _clearDisputeClaim), и жёсткий реверт здесь утащил бы за собой снятие
        // клейма и уменьшение openClaimCount молча. Недоставленное складывается
        // сюда и вытягивается через withdrawDisputeBounty().
        mapping(address => uint256)        refundableBounty;   // плательщик → не доставленный возврат, забирается сам
        // ── Ключи чата арбитра (4б, 9 августа 2026) ──
        // Открытые половины ключей чата: шифрования (X25519) и подписи (Ed25519).
        // Лежат ЗДЕСЬ, а не в справочнике релеера, по требованию владельца:
        // регулировать арбитров должен диамонд, а не владелец. Справочник жил
        // на нашем сервере, и тот, кто до сервера добрался, подсунул бы свой
        // ключ вместо ключа арбитра и прочитал бы ВСЕ предъявления по всем
        // спорам, ничем себя не выдав. Здесь ключ пишет сам арбитр своей
        // транзакцией — сервер перестал быть точкой подмены, и это весь
        // выигрыш этой задачи.
        //
        // Владелец диамонда точкой подмены остался: право апгрейда позволяет
        // развернуть маленький фасет с функцией, пишущей в arbiterBoxKey
        // произвольного адреса, смонтировать его через diamondCut, переписать
        // ключ, прочитать предъявления сторон и снять фасет. ArbiterChatKeySet
        // при этом НЕ летит — приложения сторон смены не увидят. Тот же класс
        // и тот же порядок цены, что уже замеренный обход гейта резерва казны
        // (~31 700 газа, невидим для loupe) — docs/OPEN-ITEMS.md.
        //
        // Закрытые половины в цепь НЕ попадают никогда: они выводятся из
        // подписи арбитра и остаются на его устройстве. Публичность открытой
        // половины — не утечка, а условие работы: сторона берёт её, чтобы
        // запечатать предъявление так, что вскрыть сможет только владелец
        // закрытой.
        mapping(address => bytes32)        arbiterBoxKey;   // арбитр → открытый ключ шифрования
        mapping(address => bytes32)        arbiterSignKey;  // арбитр → открытый ключ подписи
        // ── Момент взятия спора (4в-2 Выкатка 2, 14 августа 2026) ──
        // Нужен для пола записи о молчании: цепь не принимает «не ответили»
        // раньше, чем NO_RESPONSE_FLOOR от взятия. Отсчёт именно отсюда, а не
        // от просьбы: просьба идёт вне цепи и её время арбитр мог бы подделать,
        // а «взял спор на блоке N» — готовый факт. Он же момент, с которого
        // сторона физически может предъявить: до него ключ арбитра неизвестен.
        //
        // Ключ — ПАРА (сделка, арбитр). Не «сделка → время»: иначе новый арбитр
        // наследовал бы время старого, пол оказался бы уже пройденным, и запись
        // о молчании прошла бы в ту же секунду, как он взял спор. Ключевание
        // парой убирает это структурно и заодно снимает нужду в обнулении при
        // снятии клейма — мест снятия два, кандидат на третье уже назван
        // (`abandonClaim`, docs/OPEN-ITEMS.md п. 11), и уборку в нём пришлось бы
        // не забыть. Наружу отдаётся якорь ТЕКУЩЕГО клеймера, см.
        // getDisputeClaimedAt.
        //
        // ⚠️ Пишется при КАЖДОМ взятии этим арбитром, а не только при первом.
        // Решение владельца 14.08.2026, отменяет более раннее «один раз
        // навсегда». Пол должен мерить время, в течение которого стороне было
        // КОМУ предъявлять, — то есть пока спор стоял за этим арбитром. С
        // якорем «первое взятие навсегда» подкупленный арбитр брал спор,
        // отпускал через минуту и возвращался через сутки: пол пройден, запись
        // о молчании проходит немедленно, а спор почти всё это время стоял
        // ничей и предъявлять было некому.
        //
        // Обратная сторона — что перевзятие сдвигает якорь вперёд — оружием не
        // является: сдвиг вперёд только ОТКЛАДЫВАЕТ запись, то есть вредит
        // самому арбитру. Порядок событий при этом виден не отсюда, а из
        // событий DisputeClaimed / DisputeNoResponseRecorded: хранилище держит
        // последнее взятие, лента — все.
        mapping(address => mapping(address => uint256)) disputeClaimedAtBy;
        // Запись «просил переписку, ответа нет» — секунда блока. 0 — записи нет.
        // Ключ тот же, пара (сделка, арбитр), а вот правило записи ДРУГОЕ:
        // пишется ОДИН раз и не стирается никогда. Стираемая или переписываемая
        // запись означала бы, что арбитр волен переставить её время — отпустил
        // спор, взял заново, записал заново, — и «когда именно он это утверждал»
        // становится его выбором, а не фактом. У якоря такой свободы нет: его
        // сдвиг возможен только вперёд и только себе во вред.
        mapping(address => mapping(address => uint256)) disputeNoResponseAtBy;
        // ── Отпечатки предъявлений (4в-2 Выкатка 2, 14 августа 2026) ──
        // Сделка → список 32-байтовых хэшей канонического вида, которым сторона
        // ПОДПИСЫВАЕТ предъявление (canonicalPresentationBytes,
        // frontend/src/lib/presentation.ts:526).
        //
        // Список, а не одно значение: переписка не влезает в один мешок, и
        // предъявлений по спору бывает сколько нужно (замысел 2.7). Ключ —
        // сделка, а не пара (сделка, сторона): доказывается ПОРЯДОК, а порядок
        // общий для спора, и лента должна читаться одним запросом. Кто именно
        // положил, видно из события — в хранилище это не нужно никому.
        //
        // Бессмертен отпечаток, а не переписка (замысел 2.12): склад чистится,
        // 32 байта остаются. Отсюда же то, чего здесь НЕТ и быть не должно —
        // ни удаления, ни переписывания: запись, которую можно снять,
        // доказывает ровно ничего.
        mapping(address => bytes32[]) presentationDigests;
        // ── Ответственность ручных арбитров, 15 августа 2026 ────────────────
        //
        // ⚠️ ДОПИСАНО В КОНЕЦ. Порядок и типы полей выше не трогать: раскладка
        // append-only, гейт script/check-storage-structs.sh.

        /// Кто посадил этого арбитра. `address(0)` — самозапись через
        /// applyAsArbiter. Нужен для двух вещей сразу: честно показать
        /// читателю цепи, что за ручным арбитром не стоит ни залога, ни гейта
        /// по XP, и посчитать блок директора.
        mapping(address => address) seatedBy;

        /// Сколько арбитров ЭТОЙ посадки сидят прямо сейчас. Ведётся
        /// инкрементом при посадке и декрементом при любом уходе — иначе
        /// потолок запаса директора обходится циклом «посадил-снял».
        mapping(address => uint256) seatedCountBy;

        /// До какого момента арбитр приостановлен. Ноль — не приостановлен.
        /// Сравнение всегда строгое: `block.timestamp < suspendedUntil`, — то
        /// есть на самой границе окно уже отпустило.
        mapping(address => uint256) suspendedUntil;

        /// Сколько раз вердикт арбитра дошёл до финализации неперевёрнутым.
        /// Решение владельца, задача 5 того же плана (15 августа 2026): при
        /// включении ДАО сидящие арбитры конвертируются «залог плюс судейский
        /// стаж», а считать стаж было нечем. Заводить счётчик позже смысла не
        /// имеет — к моменту включения ДАО у всех будет ноль. Инкремент — в
        /// той же ветке finalizeVerdict, что уже сбрасывает arbiterMistakeStreak.
        ///
        /// ⚠️ ЭТОТ СЧЁТЧИК ФАРМИТСЯ, И МЫ ЭТО ЗНАЕМ (финальный обзор ветки,
        /// I-6, 16 августа 2026). Записано здесь намеренно — кодом не чинится
        /// и в этой ветке не чинилось.
        ///
        /// Путь тот же, что замысел уже назвал необнаруживаемым для XP: «сам
        /// себе контрагент». Один человек с тремя адресами (клиент, исполнитель,
        /// арбитр) заводит пыльную сделку на минимальную сумму, поднимает спор,
        /// берёт его третьим адресом, судит сам себя, ждёт FINALIZE_DELAY и
        /// финализирует. Вердикт неперевёрнутый — перевернуть его мог бы только
        /// владелец, а ему такая сделка не видна ничем, — и стаж растёт на
        /// единицу. Цепь при этом не врёт: вердикт действительно дошёл до
        /// финализации. Она просто не знает и знать не может, что все три
        /// стороны — один человек.
        ///
        /// Цена важнее механики: счётчик заводился ПОД конвертацию ручных
        /// арбитров при включении ДАО. К моменту, когда конвертацию будут
        /// проектировать, в цепи уже будут лежать числа, ВЫГЛЯДЯЩИЕ как
        /// доказательство умения судить. Тот, кто станет их читать, увидит
        /// готовую метрику с историей и никакой пометки о том, чего она не
        /// доказывает. Пометка — вот она.
        ///
        /// Чем лечится (не сейчас): считать стаж только по спорам, где обе
        /// стороны имеют XP от ТРЕТЬИХ лиц (приём MIN_COUNTERPARTY_XP из
        /// ReputationFacet), либо не по количеству, а по спорной сумме, либо
        /// не давать конвертации опираться на одно это число.
        mapping(address => uint256) cleanVerdicts;

        /// Предложение директора снести арбитра (задача 7, 15 августа 2026).
        /// Хранится по адресу арбитра — одно живое предложение на человека, и
        /// это верно: претензия одна, а не очередь претензий.
        ///
        /// ⚠️ Перезаписью её больше не сменить (задача 10, 18 августа 2026).
        /// Живая запись занимает дверь: proposeRemoval ревертит
        /// ProposalAlreadyLive(by, proposedAt) — всякому, кто прошёл проверку
        /// роли, включая самого подавшего (посторонний до этого места не
        /// доходит: роль отказывает раньше, и это намеренно — «дверь занята»
        /// само по себе выдало бы ему, что против арбитра что-то висит).
        /// Сменить обвинение можно, но через отзыв, и тогда сброс
        /// 48-часовых часов виден в ленте (RemovalProposalWithdrawn), а не
        /// происходит бесшумно. Замерено на ревью задачи 2: перезапись давала
        /// директору право гасить чужое обвинение бесконечно, в том числе
        /// обвинение против него самого.
        ///
        /// Живёт ArbiterAccountabilityFacet.PROPOSAL_TTL,
        /// затем читается как протухшее (hasLiveProposal), но не стирается
        /// само — стирает либо withdrawProposal, либо ArbiterRegistryStorage.
        /// clearSeat (круг правок 1, Important 1: ОДНА точка на все ТРИ
        /// двери выхода из корпуса — resignAsArbiter, автодемоушен и снос по
        /// поводу, — не только успешный removeArbiterForCause).
        ///
        /// resignAsArbiter вдобавок ОТКАЗЫВАЕТ, пока против вызывающего висит
        /// живое предложение (Important 2, круг правок 1, см.
        /// HasLiveRemovalProposal ниже) — иначе предупреждённый читает
        /// публичную запись и уходит сам за одну транзакцию, унося залог
        /// целиком, и денежная часть наказания обнуляется тем самым сигналом,
        /// который мы же и опубликовали.
        mapping(address => RemovalProposal) removalProposals;

        // ── Право ответа снятого (задача 8, 15 августа 2026) ────────────────
        //
        // ⚠️ ДОПИСАНО В КОНЕЦ. Порядок и типы полей выше не трогать: раскладка
        // append-only, гейт script/check-storage-structs.sh.

        /// Отпечаток ответа снятого арбитра. Один на человека: ответ, а не
        /// переписка.
        mapping(address => bytes32) removalReply;

        /// Момент сноса. Нужен, чтобы отличить «сняли и он молчит» от «его
        /// никогда не снимали»: без этого поля любой посторонний мог бы
        /// «ответить» на несуществующее обвинение.
        mapping(address => uint256) removedAt;

        // ── Вечная запись о сносах, 16 августа 2026 (п. 72) ─────────────────
        //
        // ⚠️ ДОПИСАНО В КОНЕЦ. Порядок и типы полей выше не трогать: раскладка
        // append-only, гейт script/check-storage-structs.sh.
        //
        // Три поля ниже — единственные в этой структуре, которые не стирает
        // НИЧТО, и это не небрежность, а требование. removedAt/removalReply
        // выше живут ровно до следующей посадки, и для них это верно: они
        // отвечают на вопрос «отвечал ли он на ТЕКУЩЕЕ обвинение». На вопрос
        // «сколько раз его сносили» стираемое поле отвечать не может —
        // стирающая дверь принадлежит обвинителю (addArbiter), а после
        // включения ДАО и самому обвиняемому (applyAsArbiter).
        //
        // Единственная неубиваемая копия истории до этой правки — события. Их
        // не индексирует ни один сабграф и не читает ни один экран: «видно»
        // существовало только для того, кто вручную сканирует сырые логи по
        // уже известному адресу.

        /// Сколько раз этого арбитра снимали НЕ ПО ЕГО ВОЛЕ — обеими такими
        /// дверями: сносом по поводу и автодемоушеном. resignAsArbiter сюда не
        /// считается: уйти самому — не снос, и смешивать их значило бы клеймить
        /// того, кто просто остановился.
        mapping(address => uint256) removalCount;

        /// Момент ПОСЛЕДНЕГО снятия. Не путать с removedAt выше: тот стирается
        /// повторной посадкой, этот — никогда.
        mapping(address => uint256) lastRemovalAt;

        /// Повод последнего снятия, ЗАКОДИРОВАННЫЙ (см. REMOVAL_CAUSE_SHIFT и
        /// AUTO_REMOVAL_BASE рядом с функциями записи): 0 — не снимали ни разу,
        /// 1..6 — код Cause плюс единица, 252..255 — автодемоушен (повода нет
        /// вовсе, но путь назван: AUTO_REMOVAL_BASE + DemotionPath).
        ///
        /// Тип uint8, а не enum: тот объявлен в
        /// ArbiterAccountabilityFacet, и завязывать раскладку хранилища на тип
        /// из другого файла означало бы, что переименование там двигает
        /// хранилище здесь — та же причина, по которой RemovalProposal.cause
        /// тоже uint8.
        mapping(address => uint8) lastRemovalCause;

        // ── Chain-laid removal proposal (task 12, 18 August 2026) ───────────
        //
        // ⚠️ APPENDED AT THE END. Do not touch the order or the types of the
        // fields above: the layout is append-only, gate
        // script/check-storage-structs.sh, and this is the very class of bug
        // that broke the live JobBoard in July 2026.

        /// The demotion path, kept until the removal it will be recorded with.
        ///
        /// It used to be known at the instant of unseating and went straight
        /// into recordAutomaticRemoval. Since task 12 the unseating moves two
        /// days out — through a proposal laid by the chain and the common
        /// door — while getArbiterStanding must still tell the three paths
        /// apart (task 4 built that distinction on purpose, item 72).
        ///
        /// The value is uint8(ArbiterRegistryFacet.DemotionPath) as-is; the
        /// AUTO_REMOVAL_BASE offset is added by recordAutomaticRemoval, as
        /// before. Zero here is MEANINGFUL (DemotionPath.Unspecified), so the
        /// question "is there a chain proposal" is asked of removalProposals
        /// (by == address(0) while proposedAt != 0), never of this field.
        mapping(address => uint8) chainProposalPath;
    }

    function data() internal pure returns (Data storage d) {
        bytes32 pos = POSITION;
        assembly { d.slot := pos }
    }

    /// Снимает провенанс и уменьшает счётчик посадившего. Живёт в БИБЛИОТЕКЕ,
    /// а не в фасете, потому что зовётся из ВСЕХ дверей выхода из корпуса, а
    /// они в разных файлах. Три копии разошлись бы при первой же правке.
    ///
    /// ⚠️ СОСТАВ ВЫЗЫВАЮЩИХ СМЕНИЛСЯ ЗАДАЧЕЙ 12 (18 августа 2026), и прежний
    /// список здесь стал неправдой. Было: `resignAsArbiter`,
    /// `_recordArbiterMistake` (автодемоушен) и `removeArbiterForCause`.
    /// Стало ДВА вызывающих:
    ///
    ///   • `ArbiterRegistryFacet.resignAsArbiter` — уход по своей воле;
    ///   • `ArbiterAccountabilityFacet._performRemoval` — общее тело сноса, и
    ///     через него ОБЕ двери сноса: `removeArbiterForCause` (человек
    ///     обвинил, человек исполнил) и `executeChainRemoval` (обвинила цепь,
    ///     нажал кто угодно).
    ///
    /// `_recordArbiterMistake` сюда больше не ходит вовсе: на третьей ошибке
    /// кресло не освобождается — цепь только обвиняет.
    ///
    /// ⚠️ Стирает и `removalProposals[arbiterAddr]` (найдено ревью, Important
    /// 1, круг правок 1 задачи 7, 15 августа 2026). До этой правки delete
    /// стоял ТОЛЬКО в removeArbiterForCause — человек, ушедший через
    /// resignAsArbiter или снятый автоматическим путём, уносил с собой живое
    /// предложение: hasLiveProposal продолжал бы отвечать true до двух
    /// недель против уже отсутствующего арбитра, который снять запись о себе
    /// не может. Централизация здесь — одна точка на все двери выхода, а не
    /// копия одной и той же строки в каждой.
    function clearSeat(Data storage d, address arbiterAddr) internal {
        address seater = d.seatedBy[arbiterAddr];
        if (seater != address(0) && d.seatedCountBy[seater] > 0) {
            d.seatedCountBy[seater]--;
        }
        delete d.seatedBy[arbiterAddr];
        delete d.removalProposals[arbiterAddr];
        // The saved demotion path belongs to the proposal being erased on the
        // line above, and outlives it nowhere: leaving it behind would let a
        // later, unrelated chain accusation inherit the path of an older one.
        // Same argument as the delete above it, same single point for all
        // three exit doors (task 12, 18 August 2026).
        delete d.chainProposalPath[arbiterAddr];
    }

    /// Сдвиг кода повода на единицу. Хозяин кодировки — эта библиотека, и
    /// только она: оба фасета пишут через recordRemovalForCause /
    /// recordAutomaticRemoval и арифметики не делают вовсе. Сдвиг обязателен
    /// потому, что ноль в lastRemovalCause обязан означать «не снимали ни
    /// разу», а Cause.OverturnedVerdicts == 0 — без сдвига самый частый
    /// проверяемый повод был бы неотличим от пустоты.
    uint8 internal constant REMOVAL_CAUSE_SHIFT = 1;

    /// НАЧАЛО диапазона автодемоушена. Повода у автомата нет: цепь сняла
    /// арбитра по серии ошибок, а не по чьему-то обвинению, и запись обязана
    /// говорить это прямо, а не притворяться поводом номер ноль. Диапазон
    /// взят на другом конце, чтобы никакой будущий Cause в него не дорос.
    ///
    /// ⚠️ Это БАЗА, а не одно значение (п. 65 + п. 72, 16 августа 2026).
    /// Путей у автоснятия ровно три, и ArbiterRegistryFacet.DemotionPath их
    /// уже различает — но только в ленте событий, то есть ровно там, где п. 72
    /// и признал, что не читает никто. Карточка getArbiterStanding —
    /// единственное читаемое место, и единый код терял бы в ней различие,
    /// которое задача 4 специально завела.
    ///
    /// Кодировка: `AUTO_REMOVAL_BASE + uint8(DemotionPath)`, то есть
    ///   252 — Unspecified (путь не назван; ни один вызывающий его не шлёт),
    ///   253 — OwnerOverturn, 254 — AgreementTimeout, 255 — AppealVote.
    /// База 252, а не 255, потому что значений в перечислении четыре и верхний
    /// конец uint8 обязан остаться достижимым без переполнения. Новый путь
    /// придётся сажать НИЖЕ базы (или двигать базу) — и это хорошо: молчаливо
    /// дописать пятый нельзя.
    uint8 internal constant AUTO_REMOVAL_BASE = 252;

    /// Снос по поводу. `rawCause` — численное значение
    /// ArbiterAccountabilityFacet.Cause как есть; сдвиг делает библиотека.
    function recordRemovalForCause(Data storage d, address arbiterAddr, uint8 rawCause) internal {
        _recordRemoval(d, arbiterAddr, rawCause + REMOVAL_CAUSE_SHIFT);
    }

    /// Снятие по обвинению ЦЕПИ. Отдельная точка входа, а не «передай сюда
    /// 253»: если бы код называл вызывающий, кодировка получила бы второго
    /// хозяина — и разошлась бы при первой же правке.
    ///
    /// ⚠️ ВЫЗЫВАЮЩИЙ ПЕРЕЕХАЛ В ДРУГОЙ ФАЙЛ (задача 12, 18 августа 2026):
    /// зовёт `ArbiterAccountabilityFacet.executeChainRemoval`, а не ветка
    /// порога в этом файле. Путь при этом известен на двое суток раньше, чем
    /// записывается, — отсюда поле `chainProposalPath` в `Data`.
    ///
    /// `rawPath` — численное значение ArbiterRegistryFacet.DemotionPath как
    /// есть; базу прибавляет библиотека. Тип uint8, а не сам DemotionPath, по
    /// той же причине, по которой lastRemovalCause хранится как uint8:
    /// перечисление объявлено в ФАСЕТЕ, и завязывать на него библиотеку
    /// хранилища значило бы, что правка там двигает раскладку здесь.
    function recordAutomaticRemoval(Data storage d, address arbiterAddr, uint8 rawPath) internal {
        _recordRemoval(d, arbiterAddr, AUTO_REMOVAL_BASE + rawPath);
    }

    /// ⚠️ ЭТА ФУНКЦИЯ БОЛЬШЕ НЕ ЛЕЖИТ НА ПУТИ ПУСТОГО try/catch, и прежнее
    /// предупреждение здесь стало неправдой (задача 12, 18 августа 2026).
    /// Было: «зовётся из ветки, которую Agreement исполняет внутри пустого
    /// try/catch (Agreement.sol:964, notifyArbiterTimeout), ревертить здесь
    /// нельзя». Оба сегодняшних вызывающих — `recordRemovalForCause` из
    /// `removeArbiterForCause` и `recordAutomaticRemoval` из
    /// `executeChainRemoval` — это ОТДЕЛЬНЫЕ человеческие транзакции, и ревёрт
    /// в них виден вызывающему.
    ///
    /// ⚠️ Запрет ревертить НЕ ИСЧЕЗ, он ПЕРЕЕХАЛ — в ветку порога
    /// `ArbiterRegistryFacet._recordArbiterMistake`, где он теперь и записан.
    /// Читать этот абзац как «try/catch прикрывает нас» и ослабить тот запрет
    /// было бы худшим из возможных выводов: там ревёрт по-прежнему глотается
    /// молча и оставляет арбитра ненаказанным без единого следа.
    ///
    /// Ревертить здесь всё равно нечему: инкремент uint256 и две записи.
    function _recordRemoval(Data storage d, address arbiterAddr, uint8 code) private {
        d.removalCount[arbiterAddr] += 1;
        d.lastRemovalAt[arbiterAddr] = block.timestamp;
        d.lastRemovalCause[arbiterAddr] = code;
    }

    /// Стирает признаки ПРЕДЫДУЩЕГО сноса при посадке (задача 8, круг правок
    /// 1, 15 августа 2026, Important 1 ревью). `removedAt`/`removalReply`
    /// привязаны к АДРЕСУ, а не к конкретному событию сноса — addArbiter не
    /// смотрит историю (только `!isDaoActive()` и `!d.isArbiter[arbiter]`), и
    /// владелец возвращает снятого одной командой (починка ошибочного сноса
    /// — реальный, не гипотетический сценарий при ручной посадке). Без
    /// очистки второе обвинение против того же адреса осталось бы либо
    /// невидимым (respondToRemoval сразу видел бы «уже отвечал» —
    /// AlreadyAnswered на пустом месте), либо, если бы очистили только
    /// removalReply, действующий, ещё не снятый арбитр мог бы ответить на
    /// давно закрытое обвинение (removedAt != 0 у активного человека).
    ///
    /// Живёт в БИБЛИОТЕКЕ и зовётся из ОБЕИХ дверей входа —
    /// ArbiterRegistryFacet.addArbiter (ручная посадка) и .applyAsArbiter
    /// (самозапись после активации ДАО) — чтобы не разойтись копиями, как
    /// clearSeat выше зовётся из всех трёх дверей выхода.
    ///
    /// ⚠️ Историю это НЕ трёт: события ArbiterRemovedForCause/RemovalAnswered
    /// лежат в цепи навсегда, читатель по-прежнему видит обе стороны каждого
    /// прошлого спора. Эти поля — только счётчик «отвечал ли на ТЕКУЩИЙ,
    /// ещё не отменённый снос».
    ///
    /// ⚠️ И с 16 августа 2026 (п. 72) историю не трёт уже не только в логах:
    /// removalCount / lastRemovalAt / lastRemovalCause эта функция НЕ ТРОГАЕТ
    /// намеренно, ни при одном значении liftSuspension. Дописать сюда их
    /// удаление — значит вернуть ровно тот дефект, ради которого поля
    /// заведены: стирающая дверь принадлежит обвинителю (addArbiter), а после
    /// включения ДАО и самому обвиняемому (applyAsArbiter), и стираемая
    /// история — не история.
    ///
    /// ⚠️ `suspendedUntil` стирается ТОЛЬКО ПО ЯВНОМУ ТРЕБОВАНИЮ ВЫЗЫВАЮЩЕГО
    /// (финальный обзор ветки, M-4 + решение владельца по шву, 16 августа 2026).
    ///
    /// Довод в одну фразу: **приостановку накладывает не арбитр, значит и
    /// снимать её не ему.**
    ///
    /// Снос теперь ВЫСТАВЛЯЕТ приостановку (ArbiterAccountabilityFacet.
    /// removeArbiterForCause, C-1), а до правки M-4 её не стирал НИКТО — ни одна
    /// дверь выхода, ни повторная посадка. Но у двух дверей входа разные
    /// хозяева, и уравнивать их было ошибкой:
    ///
    ///   • `addArbiter` передаёт `liftSuspension = true`. Владелец сознательно
    ///     отменяет СВОЁ ЖЕ решение; вернуть человека с недожитой приостановкой
    ///     значит вернуть его немым — тот молча не может ни клеймить, ни
    ///     финализировать, ни уволиться, и почему, из цепи не видно ничем,
    ///     кроме getSuspendedUntil.
    ///   • `applyAsArbiter` передаёт `liftSuspension = false`. Это САМОЗАПИСЬ.
    ///     Первая редакция правки стирала приостановку и здесь — и тем открывала
    ///     дыру ровно в C-1: снятый по поводу платил свежие ARBITER_BOND (50
    ///     USDC) поверх только что сожжённого, возвращался в корпус и
    ///     финализировал вердикты, взятые ДО сноса, не дожидаясь 72 часов. То
    ///     есть покупал обход окна, за которое владелец обязан успеть
    ///     overturnVerdict/freezeVerdict.
    ///
    /// Признаки самого сноса (`removedAt`, `removalReply`) стираются в ОБОИХ
    /// случаях: они про запись о ПРОШЛОМ сносе и не должны мешать ответить на
    /// будущий (см. два абзаца выше). Разделено параметром, а не второй копией
    /// функции: копий по-прежнему нет, а разница между дверями видна В МЕСТЕ
    /// ВЫЗОВА, а не спрятана в теле.
    function clearRemovalRecord(Data storage d, address arbiterAddr, bool liftSuspension) internal {
        delete d.removedAt[arbiterAddr];
        delete d.removalReply[arbiterAddr];
        if (liftSuspension) delete d.suspendedUntil[arbiterAddr];
    }
}

// ---------- FACET ----------

contract ArbiterRegistryFacet {

    // -------- CONSTANTS --------

    uint256 private constant COMMIT_MAX_BLOCKS  = 50;         // ~100s на Base
    uint256 private constant DAO_THRESHOLD      = 100_000;   // uniqueActiveUsers для авто-DAO
    uint256 private constant MIN_XP_TO_REGISTER = 3_000;     // ~30 сделок с разными людьми
    uint256 private constant OVERTURN_XP_SLASH  = 200;       // XP штраф при overturn
    // DEFAULT_REWARD (5 USDC) удалена 31 июля: её не читал ни один вызов, а
    // комментарий над ней называл её «floor формулы» — при том, что настоящий
    // пол выплаты арбитру это DEFAULT_ARBITER_FLOOR ниже. Две константы с
    // одним словом в описании и одна из них мёртвая — ложный след, а не
    // документация.
    uint256 private constant FINALIZE_DELAY      = 24 hours;  // окно для owner/DAO/апелляции до финализации (было 1 час — недостаточно для обычного пользователя)

    // Пол записи о молчании: столько должно пройти от ВЗЯТИЯ спора, прежде чем
    // арбитр вправе записать «просил, ответа нет». Решение владельца 14.08.2026.
    // Совпадает с FINALIZE_DELAY намеренно: одно знакомое число вместо двух похожих.
    //
    // ⚠️ Это ЕДИНСТВЕННОЕ место, где число объявлено. Фронт обязан читать его
    // через getNoResponseFloor(), а не держать копию (замысел 5.2).
    uint256 private constant NO_RESPONSE_FLOOR = 24 hours;

    uint256 private constant MIN_CLEAN_STREAK_TO_REGISTER = 10;   // та же серия, что держит XP исполнителя выше 1000
    /// Подряд ошибок до того, как ЦЕПЬ ОБВИНИТ (не до снятия — задача 12,
    /// 18 августа 2026). На этом числе `_recordArbiterMistake` приостанавливает
    /// арбитра и кладёт предложение о сносе от имени цепи; само снятие идёт
    /// общей дверью через `REMOVAL_DELAY`. Не путать с
    /// ArbiterAccountabilityFacet.MISTAKE_THRESHOLD (2) — тем ЧЕЛОВЕК
    /// доказывает повод, и он на единицу ниже намеренно.
    uint256 private constant MAX_ARBITER_MISTAKES         = 3;
    uint256 private constant DEMOTION_XP_RESET            = 2500; // фиксированный сброс при снятии — не вычитание
    uint256 private constant ARBITER_BOND                 = 50_000_000; // 50 USDC (6 decimals) — форфейтится при демоушене, возвращается при resignAsArbiter()

    uint256 private constant APPEAL_REVIEW_WINDOW = 4 days;     // столько же, сколько DISPUTE_WINDOW даёт арбитру
    uint256 private constant APPEAL_MIN_VOTES     = 3;          // кворум других арбитров
    uint256 private constant APPEAL_DEPOSIT       = 20_000_000; // 20 USDC (6 decimals) — flat, НЕ % от суммы сделки

    /// Сколько голосов РЕШАЮТ апелляцию при явке ровно в кворум (п. 67,
    /// 16 августа 2026).
    ///
    /// resolveAppeal подводит итог простым большинством ПОДАННЫХ голосов, как
    /// только их набралось APPEAL_MIN_VOTES, и звать её может кто угодно. При
    /// трёх поданных решают два — значит охраняемое свойство «директор не
    /// решает апелляцию» требует блока СТРОГО МЕНЬШЕ двух, а не меньше трёх,
    /// как считала прежняя редакция потолка.
    ///
    /// ВЫВЕДЕНО из кворума, а не записано числом: два значения об одном
    /// правиле разъехались бы молча — тот же класс, что MISTAKE_THRESHOLD в
    /// ArbiterAccountabilityFacet, объявленный вычитанием, а не литералом.
    /// Кворум при этом НЕ меняется: 3 остаётся 3.
    uint256 private constant APPEAL_DECIDING_VOTES = APPEAL_MIN_VOTES / 2 + 1;

    uint256 private constant ARBITER_SHARE_BPS = 8_000; // 80% сбора арбитру, остаток казне

    uint256 private constant DEFAULT_ARBITER_FLOOR = 10_000_000; // 10 USDC (6 decimals)

    // ── Потолок споров в руках (arbiter-accountability, задача 3) ──
    /// Сколько споров арбитр держит одновременно. Ограничивает ферму сборов —
    /// арбитр зарабатывает долю сбора с КАЖДОГО спора независимо от того,
    /// куда решил, значит «набрать много и решать наугад» — доход без
    /// работы. Потолок считает ЧИСЛО, а не сумму: сумму назначает создатель
    /// сделки, и любой потолок по ней наследовал бы её недоверенность.
    /// Утверждено владельцем 15 августа 2026.
    uint256 private constant MAX_CLAIMS_PER_ARBITER = 10;

    // -------- ENUM --------

    /// Каким путём сработало АВТОМАТИЧЕСКОЕ снятие по серии судейских ошибок.
    /// Значений на одно больше, чем вызывающих у _recordArbiterMistake, и
    /// каждое отвечает на вопрос «кто это сделал» честно, включая ответ
    /// «никто»:
    ///
    ///   Unspecified      — ⚠️ НУЛЕВОЕ ЗНАЧЕНИЕ НАРОЧНО НЕ ЯВЛЯЕТСЯ ПУТЁМ
    ///                      (круг правок 1, 16 августа 2026). В Solidity ноль —
    ///                      значение по умолчанию: его получает всякий, кто
    ///                      забыл проставить путь, и всякий новый путь, автор
    ///                      которого не дописал сюда своё значение. Стой на нуле
    ///                      OwnerOverturn — забывчивость молча обвиняла бы
    ///                      ВЛАДЕЛЬЦА, и запись выглядела бы обвинением, которого
    ///                      никто не выдвигал. Ровно то, ради чего задача
    ///                      делалась, только наизнанку. Ни один вызывающий это
    ///                      значение не шлёт; увидев его в ленте, читатель обязан
    ///                      понимать «путь не назван», а не «виноват такой-то».
    ///   OwnerOverturn    — overturnVerdict. Зовёт владелец либо daoAddress,
    ///                      проверок обоснованности в ней нет ни одной. Нажавший
    ///                      есть, и он назван полем `by` — им может быть и НЕ
    ///                      владелец (см. test_ArbiterDemotedNamesTheDaoNotTheOwner).
    ///   AgreementTimeout — notifyArbiterTimeout. Зовёт САМ АГРИМЕНТ изнутри
    ///                      triggerArbiterTimeout (msg.sender == agreement).
    ///                      Человека за вызовом нет, `by` нулевой.
    ///   AppealVote       — resolveAppeal. Подводит итог голосования, и звать её
    ///                      может кто угодно. Это тот случай, где msg.sender лгал
    ///                      бы громче всего: решают ГОЛОСА, а не нажавший
    ///                      «подвести итог». `by` нулевой, голосовавшие — в ленте
    ///                      AppealVoteCast по тому же агрименту.
    enum DemotionPath { Unspecified, OwnerOverturn, AgreementTimeout, AppealVote }

    // -------- EVENTS --------

    event ArbiterAdded(address indexed arbiter);
    /// Посадка с указанием того, кто нажал. `ArbiterAdded` остаётся ради
    /// совместимости сабграфа v2.3.0, который уже в цепи и его читает.
    event ArbiterSeated(address indexed arbiter, address indexed by, bool selfService);
    // ArbiterRemoved удалено вместе с removeArbiter (15 августа 2026, задача 6):
    // единственный emit-сайт исчез вместе с функцией. Замена —
    // ArbiterAccountabilityFacet.ArbiterRemovedForCause.
    /// The chain accuses, in its own name, having proved the cause itself
    /// (task 12, 18 August 2026). Laid by _recordArbiterMistake when the
    /// mistake streak reaches MAX_ARBITER_MISTAKES: the arbiter is suspended
    /// on the spot and a removal proposal opens against him with no author —
    /// `by` in the record is the zero address, and no such field exists here,
    /// because there is nobody to name.
    ///
    /// `path` is uint8(DemotionPath) raw, the same value that goes into the
    /// permanent record two days later; `agreement` is the deal whose verdict
    /// tipped him over. Both are carried HERE and not on the removal, because
    /// here is where they are known.
    event RemovalProposedByChain(
        address indexed arbiter,
        uint8           path,
        address indexed agreement,
        uint256         proposedAt
    );

    /// The panel found the arbiter right, so the chain takes its own accusation
    /// back (task 12, trap 5, design decision 13). Proposal erased, streak
    /// zeroed, suspension lifted — one record, because the three happen
    /// together and mean one thing.
    ///
    /// A separate event rather than RemovalProposalWithdrawn: that one names
    /// `by` and it is always a person: a zero there would read as "withdrawn
    /// by nobody" and the feed would be guessing which of the two happened.
    /// Only the CHAIN's accusation is ever cleared this way — a human's stands
    /// until its author or the authority withdraws it.
    event ChainAccusationCleared(address indexed arbiter, address indexed agreement);

    event ChiefArbiterSet(address indexed prev, address indexed next);
    event DisputeClaimCommitted(address indexed arbiter, bytes32 indexed commitment);
    event DisputeClaimed(address indexed agreement, address indexed arbiter);
    event DisputeReleased(address indexed agreement, address indexed prevArbiter);
    /// Арбитр записал в цепь: просил переписку у стороны — ответа не было.
    /// Событие несёт то же, что и хранилище, и заведено ради ленты апелляции:
    /// хранилище показывает только запись ТЕКУЩЕГО клеймера, а по апелляции
    /// смотрят весь ход спора, включая арбитров, которые спор уже отпустили.
    event DisputeNoResponseRecorded(address indexed agreement, address indexed arbiter, uint256 at);
    /// Сторона спора положила в цепь отпечаток предъявления.
    ///
    /// ⚠️ СОБЫТИЕ ОБЯЗАТЕЛЬНО, и не как дубль хранилища: хранилище отвечает
    /// «сколько и какие», а спор решается вопросом «что было раньше». Номер
    /// блока и порядок относительно DisputeNoResponseRecorded есть только у
    /// ленты. `index` дублирует место в списке нарочно — читающий ленту не
    /// обязан ходить в хранилище, чтобы понять, первое это предъявление или
    /// десятое.
    event PresentationDigestRecorded(
        address indexed agreement, address indexed submitter, bytes32 digest, uint256 index
    );
    event DAOActivated(address indexed by);
    event ArbiterApplied(address indexed arbiter);
    /// Ключи чата арбитра опубликованы или заменены.
    ///
    /// ⚠️ СОБЫТИЕ ОБЯЗАТЕЛЬНО, и вот почему: 4в следит за сменой ключа, чтобы
    /// автоматически предъявить заново, если арбитр сменил устройство. Без
    /// события ему пришлось бы ОПРАШИВАТЬ цепь — а 9 августа мы убрали 8 100
    /// обращений к цепи в час с одной вкладки, и новый опрос вернул бы ту же
    /// беду под другим именем. Не удалять и не делать неиндексируемым.
    event ArbiterChatKeySet(address indexed arbiter, bytes32 boxKey, bytes32 signKey);
    event VerdictSubmitted(address indexed agreement, address indexed arbiter, bool clientWins);
    event VerdictFinalized(address indexed agreement, address indexed arbiter, bool clientWins);
    event VerdictFrozen(address indexed agreement);
    event VerdictUnfrozen(address indexed agreement);
    event VerdictOverturned(address indexed agreement, address indexed arbiter, bool newClientWins);
    event ArbiterRewarded(address indexed arbiter, uint256 amount);
    event ArbiterRewardWithdrawn(address indexed arbiter, uint256 amount);
    event VaultFunded(address indexed by, uint256 amount);
    // RewardPerDisputeUpdated удалено 31 июля вместе с последним, кто его
    // слал: setRewardPerDispute стал `pure revert`, писать значение больше
    // некому. Объявление без единого emit — обещание события, которого не
    // будет, для всякого, кто читает ABI.
    event DAOAddressSet(address indexed daoAddress);
    event StuckVerdictAutoCleared(address indexed agreement);
    event AppealRaised(address indexed agreement, address indexed appellant);
    event AppealVoteCast(address indexed agreement, address indexed arbiter, bool overturn);
    event AppealResolved(address indexed agreement, address indexed appellant, bool overturned);
    /// Снятие по серии судейских ошибок.
    ///
    /// ⚠️ ЧЕТЫРЕ ПОЛЯ ВМЕСТО ОДНОГО (п. 65, 16 августа 2026). Прежняя
    /// редакция — `ArbiterDemoted(address indexed arbiter)` — не называла ни
    /// повода, ни нажавшего. Снаружи это читалось как «система сама демоутнула
    /// судью за три ошибки подряд»: запись не просто скрывала обвинителя, она
    /// перекладывала вину на обвиняемого убедительнее любого обвинения. При том
    /// что владелец тремя переворотами снимал арбитра мимо двери с поводом, а
    /// проверок обоснованности в overturnVerdict нет ни одной.
    ///
    /// ⚠️ И ЭТО СОБЫТИЕ ТЕПЕРЬ ЗВУЧИТ НЕ ОТСЮДА (задача 12, 18 августа 2026).
    /// Три переворота больше не снимают: они приостанавливают и открывают
    /// обвинение от имени цепи (`RemovalProposedByChain` ниже), а «снят»
    /// становится правдой через 48 часов, в
    /// `ArbiterAccountabilityFacet.executeChainRemoval`, — оттуда и звучит.
    /// Объявление остаётся здесь одно: подпись и topic0 те же, живой сабграф
    /// правки не требует, а гейт script/check_subgraph_arbiter_events.py
    /// сверяет оба конца.
    ///
    /// `by` на новом месте нулевой всегда: руки на том пути нет, а нажавшего
    /// кнопку называть нельзя — он не обвинитель.
    ///
    /// ⚠️ ЦЕНА ЭТОГО ПУТИ ПОДНЯЛАСЬ ДВАЖДЫ 18 августа 2026 (задача 11 и круг
    /// правок к ней), и прежняя редакция строки выше — «тремя вызовами по
    /// ОДНОМУ агрименту» — с тех пор неправда:
    ///
    ///   • `AlreadyOverturned` закрыл повторное нажатие по одному вердикту:
    ///     нужны три РАЗНЫХ спора, а не три нажатия;
    ///   • коллегия, вернувшая вердикт арбитра, забирает записанную ошибку
    ///     назад (см. resolveAppeal). До этой правки она, наоборот, ДАРИЛА
    ///     владельцу вторую ошибку своим верным решением, и снятие стоило двух
    ///     споров вместо трёх.
    ///
    /// `by` нулевой там, где нажавшего нет ВООБЩЕ (таймаут, голосование) — это
    /// утверждение, а не пропуск: см. докстринг DemotionPath.
    ///
    /// `agreement` — спор, на котором сработала ПОСЛЕДНЯЯ ошибка серии. Он не
    /// вся история и ею не притворяется: он вход в неё.
    ///
    /// ⚠️ И вход этот НЕПОЛНЫЙ — сказано прямо, потому что прежняя редакция
    /// докстринга обещала больше, чем цепь отдаёт (круг правок 1, 16 августа
    /// 2026). Сверено с объявлениями:
    ///
    ///   • серия из одних переворотов восстанавливается полностью:
    ///     VerdictOverturned(address indexed agreement, address indexed arbiter,
    ///     bool) индексирует арбитра, и все три события фильтруются по нему;
    ///   • ошибка-ТАЙМАУТ, не ставшая третьей, не оставляет на цепи НИ ОДНОЙ
    ///     записи, адресуемой по арбитру: notifyArbiterTimeout при первой и
    ///     второй ошибке не шлёт ничего вообще, а ArbiterTimedOut(address
    ///     indexed client, uint256) живёт на самом агрименте и арбитра не
    ///     называет. Найти такую ошибку по этому полю нельзя никак;
    ///   • по апелляции снятого не называет ни AppealResolved (там appellant),
    ///     ни AppealVoteCast (там ГОЛОСУЮЩИЙ, а не судимый) — вход остаётся,
    ///     но ведёт к голосам, а не к судимому.
    ///
    /// Значит по смешанной серии (переворот + таймаут + голоса) читатель видит
    /// последнюю ошибку и её путь, но пересчитать первые две по одному этому
    /// полю не может. Обещать обратное — та же неправда, что и одно поле.
    ///
    /// Событие в селектор функции не входит — состав селекторов фасета этой
    /// правкой не меняется, и это проверено хешем methodIdentifiers до и после,
    /// а не принято на веру.
    event ArbiterDemoted(
        address      indexed arbiter,
        address      indexed by,
        DemotionPath indexed path,
        address              agreement
    );
    event ArbiterResigned(address indexed arbiter, uint256 bondRefunded);
    event DisputeFeeCredited(address indexed arbiter, uint256 toArbiter, uint256 toTreasury);
    event TreasurySlicePushed(address indexed to, uint256 amount);
    event ArbiterFloorUpdated(uint256 amount);
    event DisputeBountyFunded(address indexed agreement, address indexed payer, uint256 amount);
    event DisputeBountyRefunded(address indexed agreement, address indexed payer, uint256 amount);
    event DisputeBountyRefundable(address indexed agreement, address indexed payer, uint256 amount);
    event DisputeBountyWithdrawn(address indexed payer, uint256 amount);

    // -------- ERRORS --------

    error NotOwner();
    error NotOwnerOrFeeRecipient();
    error NotOwnerOrChief();
    error NotOwnerOrDAO();
    error NotArbiter();
    error AlreadyArbiter();
    error NotAnArbiter();
    error AlreadyClaimed();
    error NotClaimed();
    error NotDisputed();
    error NotAuthorized();
    error CommitmentNotFound();
    error CommitmentTooEarly();
    error CommitmentExpired();
    error DAONotActive();
    error ZeroChatKey();
    error InsufficientXP(uint256 have, uint256 need);
    error NoVerdict();
    error DisputeWindowPassed();
    error NotLosingParty();
    error AlreadyAppealed();
    error AppealWindowClosed();
    error InsufficientArbitersForAppeal();
    error NoAppeal();
    error AlreadyVoted();
    error CannotVoteOnOwnVerdict();
    error AppealAlreadyResolved();
    error AppealWindowNotClosed();
    error AlreadyFinalized();
    /// The flag was written and never read back as a refusal, so three calls
    /// against the SAME agreement in the SAME block reached the demotion
    /// threshold — the price of unseating an arbiter was one submitted verdict,
    /// not three disputes.
    ///
    /// ⚠️ This error is only HALF of "one verdict, at most one judicial
    /// mistake". It shuts the hand pressing twice; it never touched the second
    /// way to book two, which ran through resolveAppeal and is closed there.
    /// Alone it was not the promise, and saying otherwise here would be the
    /// very class of documentation this branch keeps having to correct.
    error AlreadyOverturned();
    error VerdictFrozenError();
    error VerdictAlreadySubmitted();
    error NotTheClaimer();
    error VaultInsufficient();
    error NoRewardToClaim();
    error ArbiterZeroAddress();
    error InsufficientCleanStreak(uint256 have, uint256 need);
    error HasOpenDisputeClaims();
    error AppealInProgress();
    error NotRegisteredAgreement();
    error NothingToPush();
    // Своя ошибка, а не NothingToPush: та живёт в withdrawTreasurySlice.
    // Обе разбираются декодером релеера (relayer/app.js:
    // FORWARDER_CUSTOM_ERRORS, селекторы 0x2d4e8c7b и 0x68d369c9), то есть имя
    // долетает до человека дословно — и человек, забирающий свою доплату,
    // увидел бы сообщение про push, которого не делал. Разделение работает
    // ровно постольку, поскольку обе ошибки в декодере есть: пропусти одну, и
    // до человека доедет сырой хекс, в котором различать нечего.
    error NoRefundableBounty();
    error ZeroAmount();
    // Название отражает актуальную охраняемую проверку: источник арбитра —
    // pendingVerdicts, значит гейт бьёт по отсутствию вердикта, а не клеймера
    // (клейм и вердикт разошлись после того, как аргумент арбитра убрали
    // из creditDisputeFee — см. комментарий над функцией).
    error NoVerdictSubmitted();
    error TopUpNotNeeded();
    error BountyAlreadyFunded();
    error DisputeAlreadyClaimed();
    error NotParty();
    error RewardPathRetired();

    // ── Запись «просил, ответа нет» (4в-2 Выкатка 2) ──
    error NoResponseTooEarly();
    error NoResponseAlreadyRecorded();
    /// Отдельно от NotTheClaimer намеренно: тот отвечает на пути вердикта, и
    /// сторона, увидевшая его в ответ на кнопку «ответа не было», решила бы,
    /// что дело в вердикте. Одинаковый смысл, разные экраны.
    error NotClaimingArbiter();
    error ClaimTimeUnknown();

    // ── Отпечаток предъявления (4в-2 Выкатка 2) ──
    /// Отдельно от NotParty намеренно, по той же причине, что NotClaimingArbiter
    /// отдельно от NotTheClaimer: NotParty живёт на пути ОПЛАТЫ арбитра
    /// (fundDispute), и человек, получивший её в ответ на «предъявить
    /// переписку», пошёл бы искать проблему в деньгах. Смысл один, экраны разные.
    error NotDisputeParty();
    /// Нулевой отпечаток — не предъявление, а пустая запись в ленте: хэша, чей
    /// прообраз можно показать, у нуля нет.
    error ZeroDigest();

    // ── Потолок запаса директора (arbiter-accountability, задача 2;
    // переименована и пересчитана 16 августа 2026, п. 67) ──
    /// Директор не может собрать блок, РЕШАЮЩИЙ апелляцию, СВОИМИ РУКАМИ:
    /// иначе его ставленники определяют исход любой апелляции, а после передачи
    /// сноса голосованию — и исход любого сноса, включая его собственный.
    ///
    /// ⚠️ ОБЕЩАНИЕ СУЖЕНО ДО ПРАВДЫ (уборка 7а, п. 2.4, Ruling 17). Прежняя
    /// редакция обещала свойство АБСОЛЮТНО — «директор не может собрать блок».
    /// Держится оно на гораздо меньшем: на ОДНОЙ двери (`addArbiter`), у ОДНОГО
    /// нажимающего (директора) и в ОДИН момент (нажатия). После этого инвариант
    /// «блок ≤ 1» не поддерживается ничем:
    ///
    ///   • владелец, посадив директора арбитром ПОСЛЕ его ставленника, доводит
    ///     блок до настоящей двойки — замерено, `getChiefBloc()` = 2;
    ///   • `applyAsArbiter` `_chiefBloc` не зовёт ВОВСЕ, то есть после включения
    ///     ДАО ставленник может вернуться в корпус мимо потолка.
    ///
    /// Это не регресс (у прежней редакции потолка тот же порядок давал 3) и не
    /// дыра в сегодняшнем смысле: обе лазейки открывает владелец, а он же роль
    /// директора и выдаёт. Честная формулировка одной фразой: свойство
    /// сторожится на той двери, которой распоряжается ДИРЕКТОР.
    /// Настоящее лекарство — считать блок в момент ГОЛОСОВАНИЯ, а не посадки;
    /// это изменение замысла, и оно в OPEN-ITEMS.
    ///
    /// ⚠️ Прежнее имя — ChiefBlocWouldReachQuorum — называло неверное
    /// свойство, и это было опаснее самого числа: следующий читатель оперся
    /// бы на имя. Кворум и решающее большинство — разные величины, и
    /// апелляцию решает второе. Имя ошибки в селектор ФУНКЦИИ не входит,
    /// каскад деплоя переименованием не тронут; на цепи эта ошибка ещё ни
    /// разу не отдавалась — фасет с ней не выкачен.
    error ChiefBlocWouldDecideAppeal(uint256 bloc, uint256 decidingVotes);

    // ── Потолок споров в руках (arbiter-accountability, задача 3) ──
    error TooManyOpenClaims(uint256 held, uint256 cap);

    // ── Зубы приостановки (arbiter-accountability, задача 5) ──
    /// Арбитр приостановлен: не берёт споров, его вердикты не финализируются,
    /// уволиться он не может. Последнее — не мелочь: resignAsArbiter возвращает
    /// залог целиком, и без этого запрета подозреваемый уходит с деньгами за
    /// одну транзакцию, а весь денежный контур наказания становится надписью.
    error ArbiterSuspendedError(uint256 until);

    // ── Зубы предложения (arbiter-accountability, задача 7, круг правок 1,
    // 15 августа 2026, Important 2) ──
    /// Третий запрет двери резигнации, симметричный ArbiterSuspendedError
    /// выше — тем же приёмом, но против ДРУГОЙ угрозы. Приостановка не
    /// годится сюда сама по себе: её окно 72 часа против 14 суток
    /// предложения, и с одиннадцатых суток дверь снова открыта, даже если
    /// владелец приостановил в ту же секунду, что предложил. Без отдельного
    /// запрета обвиняемый читает публичное `RemovalProposed` в цепи и уходит
    /// сам за одну транзакцию, унося залог целиком (resignAsArbiter
    /// возвращает бонд без остатка) — единственная материальная санкция
    /// (форфейт в removeArbiterForCause) обнуляется чтением записи, которую
    /// мы же и опубликовали.
    error HasLiveRemovalProposal();

    // ── Передача корпуса ДАО (arbiter-accountability, задача 6, 15 августа
    // 2026): дословное решение владельца — «никаких ручных», «человек должен
    // выйти и остаться только даймонд, который пропускает по гейту» ──
    /// activateDAO() односторонний и не гасится нигде: включить его, не назначив
    /// daoAddress, значит осиротить корпус одной транзакцией — автоматика ловит
    /// только то, что видит цепь, а посадка/снятие человеком станут недоступны
    /// никому.
    error DaoAddressNotSet();
    /// addArbiter/setChiefArbiter: вход только через applyAsArbiter (по гейту),
    /// роль директора упраздняется вместе с активацией ДАО.
    ///
    /// ⚠️ ОДНА ОШИБКА, ДВА РАЗНЫХ УСЛОВИЯ — и это не небрежность (финальный
    /// обзор ветки, правка B, 16 августа 2026). `addArbiter` отказывает по
    /// передаче посадки (`isDaoActive() && daoAddress != address(0)`,
    /// _requireSeatingNotHandedOver), `setChiefArbiter` — по упразднению роли
    /// (`isDaoActive()`), потому что назначать бессильного директора незачем.
    /// Новую ошибку не заводили намеренно: этот текст уже называет обе
    /// половины поимённо, а лишний селектор в ABI фасета стоил бы разреза.
    error SeatingHandedOver();
    /// setDAOAddress после активации ДАО: назвать преемника может только уже
    /// действующий daoAddress (самомиграция), не владелец. Без этого гейта
    /// владелец мог бы вернуть себе снос по поводу лишней транзакцией —
    /// activateDAO() → setDAOAddress(свой_адрес) → removeArbiterForCause по
    /// ветке msg.sender == daoAddress — и «человек вышел» осталось бы верным
    /// только для одной из двух дверей (найдено ревью, C-3, круг правок 1).
    error NotCurrentDaoAddress();

    // ── Вес приостановки, вторая дверь (п. 66, круг правок 1, 16 августа 2026) ──
    /// Возврат в корпус СНЕСЁННОГО — владельческое действие, директору
    /// недоступно. Отмена сноса есть зеркало сноса, а сносить директор не
    /// вправе вовсе.
    ///
    /// Найдено ревью задачи 2: гейт `ArbiterAccountabilityFacet.liftSuspension`
    /// запер одну дверь, а `addArbiter` вела туда же и была открыта директору.
    /// `clearRemovalRecord(d, arbiter, true)` ниже стирает `removedAt` И
    /// `suspendedUntil` разом — то есть директор одной транзакцией снимал то
    /// самое окно C-1, которое держит деньги по вердиктам снятого, да вдобавок
    /// возвращал его в реестр с нетронутыми клеймами (снос не трогает ни
    /// `disputeClaims`, ни `openClaimCount`). Замерено пробой на настоящем
    /// даймонде: `liftSuspension` директору ревертит, `addArbiter` проходит.
    ///
    /// ⚠️ Почему отказ, а не «вернуть, но приостановку оставить» (мягкий
    /// вариант рассмотрен и отвергнут): `clearRemovalRecord(..., false)` стёр
    /// бы `removedAt`, оставив окно, — и следующей же транзакцией
    /// `liftSuspension` прошла бы гейт п. 66, потому что различитель уже ноль.
    /// Мягкий вариант не закрывает обход, а удлиняет его на одну транзакцию.
    ///
    /// Кого НЕ касается: посадку нового человека и возврат ушедшего
    /// добровольно — `resignAsArbiter` `removedAt` не пишет, у таких он ноль,
    /// и директор сажает их как раньше. Кого касается дополнительно: возврат
    /// снятого ПО ОБВИНЕНИЮ ЦЕПИ — `removedAt` пишет общее тело сноса
    /// (`ArbiterAccountabilityFacet._performRemoval`), одинаково для обеих
    /// дверей, значит и отменять автоматический путь вправе только владелец.
    /// Так и задумано: у обвинения цепи нет автора, которому можно возразить,
    /// кроме того, кто отвечает за корпус целиком.
    ///
    /// ⚠️ Задача 12 (18 августа 2026) сдвинула МОМЕНТ, а не правило: до неё
    /// `removedAt` ставила третья ошибка сама, теперь — нажатие
    /// `executeChainRemoval` через двое суток. Пока обвинение висит и кнопка не
    /// нажата, `removedAt` НОЛЬ, человек ещё в корпусе, и эта ветка его не
    /// касается вовсе.
    error ReseatingRemovedIsOwnerOnly();

    // -------- MODIFIERS --------

    modifier onlyOwner() {
        if (OwnershipLib.contractOwner() != msg.sender) revert NotOwner();
        _;
    }

    /// ⚠️ ДИРЕКТОР ПЕРЕСТАЁТ СУЩЕСТВОВАТЬ ПРИ АКТИВНОМ ДАО (финальный обзор
    /// ветки, I-2, 16 августа 2026). Вторая половина той же правки — в
    /// ArbiterAccountabilityFacet.onlyOwnerOrChief, где разобрана причина
    /// целиком: setChiefArbiter — единственный писатель d.chiefArbiter и
    /// единственный способ его обнулить, а задача 6 закрыла её при активном ДАО.
    /// Без этой строки «директор упраздняется» означало бы «директор становится
    /// несменяемым».
    ///
    /// Обе половины обязаны меняться синхронно: права директора разложены по
    /// двум фасетам (здесь — addArbiter, там — приостановка и предложение
    /// сноса), и закрытая половина без второй ничего не стоила бы.
    modifier onlyOwnerOrChief() {
        if (msg.sender != OwnershipLib.contractOwner()) {
            if (isDaoActive() || msg.sender != ArbiterRegistryStorage.data().chiefArbiter)
                revert NotOwnerOrChief();
        }
        _;
    }

    modifier onlyOwnerOrDAO() {
        address dao = ArbiterRegistryStorage.data().daoAddress;
        if (msg.sender != OwnershipLib.contractOwner() && msg.sender != dao)
            revert NotOwnerOrDAO();
        _;
    }

    // -------- ERC-2771 SENDER --------

    function _msgSender() internal view returns (address sender) {
        address forwarder = FactoryStorage.store().trustedForwarder;
        if (msg.sender == forwarder && msg.data.length >= 20) {
            assembly { sender := shr(96, calldataload(sub(calldatasize(), 20))) }
        } else {
            sender = msg.sender;
        }
    }

    // -------- DAO MODE --------

    /// Требует уже назначенного daoAddress. Без этой проверки владелец мог бы
    /// включить ДАО раньше, чем назначил его адрес, и осиротить корпус одной
    /// транзакцией: activateDAO() необратим (флаг не гасится нигде в src/), а
    /// removeArbiterForCause/addArbiter/setChiefArbiter после активации уже не
    /// пускают владельца — не по злому умыслу, а просто перепутав порядок
    /// вызовов setDAOAddress/activateDAO.
    function activateDAO() external onlyOwner {
        if (ArbiterRegistryStorage.data().daoAddress == address(0)) revert DaoAddressNotSet();
        ArbiterRegistryStorage.data().daoActiveManual = true;
        emit DAOActivated(msg.sender);
    }

    function applyAsArbiter() external {
        if (!isDaoActive()) revert DAONotActive();

        address caller = _msgSender();
        ReputationStorage.Data storage rep = ReputationStorage.data();
        uint256 xp = rep.xp[caller];
        if (xp < MIN_XP_TO_REGISTER) revert InsufficientXP(xp, MIN_XP_TO_REGISTER);
        uint256 streak = rep.cleanStreak[caller];
        if (streak < MIN_CLEAN_STREAK_TO_REGISTER) revert InsufficientCleanStreak(streak, MIN_CLEAN_STREAK_TO_REGISTER);

        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        if (d.isArbiter[caller]) revert AlreadyArbiter();

        address usdc = FactoryStorage.store().usdc;
        bool bondOk = IUSDCFull(usdc).transferFrom(caller, address(this), ARBITER_BOND);
        require(bondOk, "ArbiterRegistry: bond transfer failed");
        d.arbiterBond[caller] = ARBITER_BOND;

        d.isArbiter[caller] = true;
        d.arbiterList.push(caller);

        // Признаки прошлого сноса (если был) не переживают повторную посадку
        // (задача 8, круг правок 1, Important 1) — respondToRemoval судит о
        // ТЕКУЩЕМ статусе, не о ветхой истории.
        //
        // ⚠️ liftSuspension = FALSE — приостановку самозапись НЕ снимает
        // (решение владельца по шву M-4, 16 августа 2026): её накладывает
        // владелец или директор, значит и снимать её не арбитру. Иначе снятый
        // по поводу покупал бы обход окна C-1 за один свежий залог: вернулся —
        // и финализировал вердикты, взятые до сноса, не дожидаясь 72 часов.
        ArbiterRegistryStorage.clearRemovalRecord(d, caller, false);

        emit ArbiterAdded(caller);
        emit ArbiterApplied(caller);
        // Самозапись: seatedBy остаётся нулём — это и есть признак «сел сам».
        // Событие всё равно шлём, чтобы у читателя был один поток вместо двух.
        emit ArbiterSeated(caller, address(0), true);
    }

    /// @notice Самостоятельный выход из статуса арбитра, без штрафа. Возвращает бонд
    /// полностью. Без этого статус арбитра был бы дорогой в один конец для тех, кого
    /// никогда не демоушенили — бонд лочился бы навечно в момент, когда человек просто
    /// хочет остановиться.
    function resignAsArbiter() external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        _requireNotSuspended(d, caller);
        _requireNoLiveRemovalProposal(d, caller);
        if (!d.isArbiter[caller]) revert NotAnArbiter();
        if (d.openClaimCount[caller] > 0) revert HasOpenDisputeClaims();

        d.isArbiter[caller] = false;

        uint256 len = d.arbiterList.length;
        for (uint256 i = 0; i < len; i++) {
            if (d.arbiterList[i] == caller) {
                d.arbiterList[i] = d.arbiterList[len - 1];
                d.arbiterList.pop();
                break;
            }
        }

        uint256 bond = d.arbiterBond[caller];
        d.arbiterBond[caller] = 0;
        if (bond > 0) {
            address usdc = FactoryStorage.store().usdc;
            bool ok = IUSDCFull(usdc).transfer(caller, bond);
            require(ok, "ArbiterRegistry: bond refund failed");
        }

        ArbiterRegistryStorage.clearSeat(d, caller);

        emit ArbiterResigned(caller, bond);
    }

    // -------- ADMIN: MANAGE ARBITERS --------

    /// Роль директора упраздняется вместе с активацией ДАО (дословное решение
    /// владельца, задача 6, 15 августа 2026: «никаких ручных», «человек должен
    /// выйти и остаться только даймонд, который пропускает по гейту»). Храповик:
    /// isDaoActive() необратим, назначить нового директора после передачи
    /// нельзя уже никому.
    ///
    /// ⚠️ ПРЕДИКАТ ЗДЕСЬ — УПРАЗДНЕНИЕ РОЛИ, А НЕ ПЕРЕДАЧА ПОСАДКИ (финальный
    /// обзор ветки, правка B, 16 августа 2026). Это НЕ то же условие, что у
    /// addArbiter, и разъезжались они на живом состоянии:
    ///
    ///   • роль директора УПРАЗДНЕНА, когда `isDaoActive()` — так устроены оба
    ///     модификатора `onlyOwnerOrChief` (здесь и в
    ///     ArbiterAccountabilityFacet): при живом ДАО директора они не видят
    ///     вовсе, ни одного его права не остаётся;
    ///   • посадка ПЕРЕДАНА, когда `isDaoActive() && daoAddress != address(0)`
    ///     (_requireSeatingNotHandedOver) — там условие слабее нарочно, I-3:
    ///     пока преемник не назван, сажать арбитров, кроме владельца, некому,
    ///     и он обязан мочь.
    ///
    /// В промежутке — ДАО заработано, преемник ещё не прописан — прежняя
    /// редакция писала слот и слала событие, хотя назначенный директор уже
    /// бессилен: ни одна функция его не пропустит. `getChiefArbiter()` при этом
    /// честно возвращал адрес, а публичный docs/DECENTRALIZATION.md говорил,
    /// что роли больше нет. Функция про РОЛЬ директора — значит и отказывать
    /// обязана тогда, когда роли нет.
    ///
    /// `addArbiter` ниже предикат НЕ меняет: она про посадку арбитров, и её
    /// условие верно.
    function setChiefArbiter(address arbiter) external onlyOwner {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        if (isDaoActive()) revert SeatingHandedOver();
        emit ChiefArbiterSet(d.chiefArbiter, arbiter);
        d.chiefArbiter = arbiter;
    }

    /// Передача права посадки защёлкивается ТОЛЬКО когда преемник реально
    /// существует (финальный обзор ветки, I-3, 16 августа 2026) — тем же
    /// приёмом, что уже применён к setDAOAddress в круге правок 2 (см. его
    /// докстринг).
    ///
    /// ⚠️ ЕДИНСТВЕННЫЙ ВЫЗЫВАЮЩИЙ — `addArbiter` (правка B, 16 августа 2026).
    /// `setChiefArbiter` эту проверку больше не зовёт: она про РОЛЬ директора и
    /// отказывает по упразднению (`isDaoActive()`), а не по передаче посадки —
    /// см. её докстринг выше.
    ///
    /// Заработанный порог (`uniqueActiveUsers >= DAO_THRESHOLD`) раньше только
    /// ОТКРЫВАЛ дверь самозаписи; задача 6 сделала его вдобавок НЕОБРАТИМЫМ
    /// ЗАМКОМ на addArbiter/setChiefArbiter. Защита `DaoAddressNotSet` стоит
    /// только ВНУТРИ activateDAO() — то есть на ручной двери; автоматическая не
    /// была защищена ничем. Цена нажатия замерена в самом проекте
    /// (src/Treasury.sol: порог достижим за деньги, а на тестнете просто за
    /// время постороннего) — значит ЧУЖОЙ человек навсегда лишал владельца
    /// права сажать арбитров, а корпус пополнялся бы только самозаписью с
    /// гейтом MIN_XP_TO_REGISTER, которому живой ручной арбитр (XP 0) не
    /// удовлетворяет. Корпус осиротел бы необратимо, единственный выход —
    /// замена фасета diamondCut'ом.
    ///
    /// Правка НЕ в isDaoActive() (соблазн, но нельзя): его читает уже
    /// развёрнутая и неизменяемая src/Treasury.sol для пропорций дохода, и
    /// сдвиг момента «ДАО наступила» подвинул бы деньги. Отдельное решение
    /// владельца, не побочный эффект.
    function _requireSeatingNotHandedOver(ArbiterRegistryStorage.Data storage d) private view {
        if (isDaoActive() && d.daoAddress != address(0)) revert SeatingHandedOver();
    }

    /// Вход в корпус арбитров при активном ДАО — только через applyAsArbiter
    /// (самозапись по гейту XP/cleanStreak/бонда). Дословное решение владельца,
    /// задача 6, 15 августа 2026: «никаких ручных» — ни владелец, ни директор
    /// больше не сажают арбитров, когда ДАО включено.
    ///
    /// ⚠️ Про `&& d.daoAddress != address(0)` — см. _requireSeatingNotHandedOver.
    ///
    /// ⚠️ ВОЗВРАТ СНЕСЁННОГО — ТОЛЬКО ВЛАДЕЛЬЦУ (п. 66, круг правок 1,
    /// 16 августа 2026). Эта функция — вторая дверь к тому же результату, что
    /// заперт в `ArbiterAccountabilityFacet.liftSuspension`: `clearRemovalRecord`
    /// ниже стирает окно сноса заодно с записью о нём. Разбор — у объявления
    /// ошибки ReseatingRemovedIsOwnerOnly выше.
    function addArbiter(address arbiter) external onlyOwnerOrChief {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        _requireSeatingNotHandedOver(d);
        if (d.isArbiter[arbiter]) revert AlreadyArbiter();

        // Потолок касается только директора. Владелец не ограничен: он и есть
        // тот, кто решает состав, и ограничивать его этим правилом означало бы
        // ограничить его же способность разбавить блок директора.
        //
        // Считается от РЕШАЮЩЕГО БОЛЬШИНСТВА, а не от кворума (п. 67,
        // 16 августа 2026): при явке ровно в кворум апелляцию решают два
        // голоса из трёх, поэтому блок ≤ 1.
        if (msg.sender != OwnershipLib.contractOwner()) {
            // Отмена сноса — зеркало сноса, и она не его. Различитель тот же
            // СТИРАЕМЫЙ `removedAt`, что у гейта liftSuspension: у ушедшего
            // добровольно и у новичка он ноль, дверь им открыта как прежде.
            if (d.removedAt[arbiter] != 0) revert ReseatingRemovedIsOwnerOnly();

            uint256 blocAfter = _chiefBloc(d) + 1;
            if (blocAfter >= APPEAL_DECIDING_VOTES) {
                revert ChiefBlocWouldDecideAppeal(blocAfter, APPEAL_DECIDING_VOTES);
            }
        }

        d.isArbiter[arbiter] = true;
        d.arbiterList.push(arbiter);

        d.seatedBy[arbiter] = msg.sender;
        d.seatedCountBy[msg.sender]++;
        emit ArbiterSeated(arbiter, msg.sender, false);

        // Признаки прошлого сноса (если был) не переживают повторную посадку
        // (задача 8, круг правок 1, Important 1) — respondToRemoval судит о
        // ТЕКУЩЕМ статусе, не о ветхой истории. Реальный сценарий: владелец
        // исправляет ошибочный снос одной командой addArbiter.
        //
        // ⚠️ liftSuspension = TRUE — и только здесь (решение владельца по шву
        // M-4, 16 августа 2026). Владелец отменяет СВОЁ ЖЕ решение: вернуть
        // человека с недожитой приостановкой значит вернуть его немым — он не
        // сможет ни клеймить, ни финализировать, ни уволиться, и причина не
        // будет видна из цепи ничем, кроме getSuspendedUntil.
        ArbiterRegistryStorage.clearRemovalRecord(d, arbiter, true);

        emit ArbiterAdded(arbiter);
    }

    // removeArbiter(address) удалена 15 августа 2026. Она снимала арбитра без
    // повода, без записи о том, кто нажал, и возвращала залог целиком — то есть
    // снятие за дело и тихая зачистка выглядели в цепи одинаково и стоили
    // одинаково. Замена — ArbiterAccountabilityFacet.removeArbiterForCause.
    // Селектор удаляется из даймонда разрезом UpgradeArbiterAccountability.

    // -------- ARBITER: CLAIM DISPUTE --------

    function commitDisputeClaim(bytes32 commitment) external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        if (!d.isArbiter[caller]) revert NotArbiter();
        d.claimCommitments[commitment] = block.number;
        emit DisputeClaimCommitted(caller, commitment);
    }

    /// Опубликовать или заменить открытые половины своих ключей чата.
    ///
    /// Нужна отдельно от заявки на спор ради одного случая: арбитр, потерявший
    /// ключ ПОСЛЕ заявки, застревает — адрес в цепи тот же, а прочитать
    /// предъявленное нечем, и повторное предъявление на тот же ключ не
    /// поможет. С этой функцией петля замыкается сама: опубликовал новый →
    /// приложения сторон заметили по событию → предъявили заново → читает.
    ///
    /// Адрес берётся из отправителя, аргумента «кому» НЕТ вовсе: чужой ключ
    /// записать нельзя не потому, что мы проверяем, а потому что записать
    /// некуда.
    ///
    /// ⚠️ Исключение, где петля НЕ замыкается сама: гейт здесь — `isArbiter`,
    /// и он снимается (removeArbiter/resignAsArbiter/демоушен на 3 ошибки
    /// подряд) без очистки уже записанного ключа. Арбитр, потерявший статус
    /// с открытым спором на руках, ключ ротировать больше не может (эта
    /// функция ревертит `NotArbiter`), а `getArbiterChatKeys` по нему
    /// по-прежнему отдаёт старый — живой на вид, но заменить его некому.
    /// `submitVerdict` этот случай не перекрывает: он проверяет только
    /// `disputeClaims`, никогда `isArbiter`. Настоящее лекарство (разрешить
    /// ротацию, пока `openClaimCount` не пуст) меняет права и здесь
    /// сознательно не реализовано.
    function setArbiterChatKey(bytes32 boxKey, bytes32 signKey) external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        if (!d.isArbiter[caller]) revert NotArbiter();
        if (boxKey == bytes32(0) || signKey == bytes32(0)) revert ZeroChatKey();

        // Событие — только если хотя бы одна половина реально изменилась.
        // Запись делаем всегда (идемпотентна и дешевле ветвления) — условие
        // только вокруг emit. Причина в 4в, а не здесь: он предъявляет заново
        // ПО СОБЫТИЮ, и одинаковая перезапись — обычный no-op с фронта
        // (повторный вызов, гонка вкладок) — иначе заставила бы его
        // перешифровать и перезалить на склад переписку по каждому открытому
        // спору арбитра, хотя ключ не менялся вовсе.
        bool changed = d.arbiterBoxKey[caller] != boxKey || d.arbiterSignKey[caller] != signKey;
        d.arbiterBoxKey[caller]  = boxKey;
        d.arbiterSignKey[caller] = signKey;
        if (changed) emit ArbiterChatKeySet(caller, boxKey, signKey);
    }

    /// @notice Клейм спора. Diamond устанавливается арбитром в Agreement (не сам арбитр).
    /// Это позволяет Diamond контролировать исполнение вердикта (задержка, overturn).
    ///
    /// Ключи чата — ОБЯЗАТЕЛЬНЫЕ аргументы, держится формой аргумента, а не
    /// проверкой: контракт не умеет отличить настоящий ключ от двух мусорных
    /// bytes32 — форма только делает невозможным взять спор, вообще ничего не
    /// прислав. Это закрывает случай БЕЗ злого умысла (забыл, не настроил
    /// устройство). Арбитра, который умышленно везёт мусор вместо ключа,
    /// форма не остановит: он получит тот же исход, а стороны впустую
    /// перешифруют переписку на ключ, которым никто не владеет. Умышленный
    /// отказ читать закрывается обнаружением, а не формой аргумента — это
    /// работа следующих частей, не этой.
    ///
    /// Каждая заявка ПЕРЕЗАПИСЫВАЕТ ключи. ⚠️ Раньше здесь было написано, что
    /// этим «смена устройства лечится сама» — это неверно, и поправлено
    /// 9 августа по разбору кода фронта. У ОБЫЧНОГО кошелька ключ чата
    /// детерминирован: он выводится из подписи фиксированных типизированных
    /// данных (все 65 байт подписи идут в семя), а обычные кошельки подписывают
    /// детерминированно (RFC 6979). Значит тот же кошелёк на новом устройстве
    /// даёт ТОТ ЖЕ ключ, и опубликованный в цепи ключ остаётся живым — лечить
    /// нечего.
    ///
    /// Перезапись нужна там, где ключ правда умирает, и таких случаев два:
    ///  1. кошелёк-контракт — ключ там случайный, а не выведенный, и без кода
    ///     восстановления (12 слов) на новом устройстве получается другой;
    ///  2. Safe с порогом 1 — он отдаёт ровно 65 байт, подписанных владельцем,
    ///     поэтому определяется как обычный кошелёк, а ключ фактически выведен
    ///     из подписи ВЛАДЕЛЬЦА. Сменился владелец — сменился ключ, и кода
    ///     восстановления такому роду не выдают.
    /// Плюс общий случай: ключ просто потерян. Ради этих случаев есть ещё и
    /// setArbiterChatKey — заявки ждать не нужно.
    ///
    /// ⚠️ Селектор этой функции сменился 9 августа (4б). Старый
    /// `claimDispute(address,bytes32)` удалён из монтировки тем же diamondCut —
    /// оставить его значило бы держать вторую дорогу, по которой спор берётся
    /// БЕЗ ключа, то есть ровно ту дыру, которую эта правка закрывает.
    function claimDispute(
        address agreement,
        bytes32 salt,
        bytes32 boxKey,
        bytes32 signKey
    ) external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        if (!d.isArbiter[caller]) revert NotArbiter();

        // Потолок проверяется до staticcall'ов в Agreement: отказывать надо
        // дёшево, а не после четырёх чтений чужого контракта.
        uint256 held = d.openClaimCount[caller];
        if (held >= MAX_CLAIMS_PER_ARBITER) revert TooManyOpenClaims(held, MAX_CLAIMS_PER_ARBITER);

        _requireNotSuspended(d, caller);

        if (boxKey == bytes32(0) || signKey == bytes32(0)) revert ZeroChatKey();
        if (d.disputeClaims[agreement] != address(0)) revert AlreadyClaimed();

        bytes32 commitment = keccak256(abi.encodePacked(agreement, caller, salt));
        uint256 committedAt = d.claimCommitments[commitment];
        if (committedAt == 0) revert CommitmentNotFound();
        if (block.number <= committedAt) revert CommitmentTooEarly();
        if (block.number > committedAt + COMMIT_MAX_BLOCKS) revert CommitmentExpired();
        delete d.claimCommitments[commitment];

        (bool statusOk, bytes memory statusData) = agreement.staticcall(
            abi.encodeWithSignature("status()")
        );
        require(statusOk, "ArbiterRegistry: failed to read status");
        uint8 agreementStatus = abi.decode(statusData, (uint8));
        if (agreementStatus != 4) revert NotDisputed();

        // Клеймить после окна вердикта нельзя. submitVerdict всё равно откажет
        // (DisputeWindowPassed), так что поздний клейм не может привести к
        // вердикту — зато он выставляет arbiter в Agreement и тем самым
        // отменяет дележ котла пополам на таймауте. Без этой проверки сторона
        // с дружественным арбитром забирала бы весь котёл, ничего не доказав.
        (bool dOk, bytes memory dData) = agreement.staticcall(abi.encodeWithSignature("disputedAt()"));
        require(dOk, "ArbiterRegistry: disputedAt read failed");
        (bool wOk, bytes memory wData) = agreement.staticcall(abi.encodeWithSignature("DISPUTE_WINDOW()"));
        require(wOk, "ArbiterRegistry: DISPUTE_WINDOW read failed");
        if (block.timestamp > abi.decode(dData, (uint256)) + abi.decode(wData, (uint256))) {
            revert DisputeWindowPassed();
        }

        // Арбитр не может быть стороной спора
        (bool clientOk, bytes memory clientData) = agreement.staticcall(abi.encodeWithSignature("client()"));
        (bool execOk,   bytes memory execData)   = agreement.staticcall(abi.encodeWithSignature("executor()"));
        require(clientOk && execOk, "ArbiterRegistry: failed to read parties");
        address agreementClient   = abi.decode(clientData,  (address));
        address agreementExecutor = abi.decode(execData,    (address));
        require(caller != agreementClient && caller != agreementExecutor, "ArbiterRegistry: arbiter is party");

        // Diamond становится арбитром в Agreement — это позволяет контролировать вердикт
        (bool setOk,) = agreement.call(
            abi.encodeWithSignature("setArbiter(address)", address(this))
        );
        require(setOk, "ArbiterRegistry: setArbiter failed");

        d.disputeClaims[agreement] = caller;
        // Якорь пола — при КАЖДОМ взятии, без условия «только если ноль».
        // Условие здесь стояло и снято решением владельца 14.08.2026: оно
        // защищало от самовреда (перевзятие откладывает запись арбитру же), а
        // взамен открывало настоящую дыру — взять спор, отпустить через минуту,
        // вернуться через сутки и записать молчание немедленно, хотя спор почти
        // всё это время стоял ничей и предъявлять было некому. Подробности — у
        // поля в ArbiterRegistryStorage.
        d.disputeClaimedAtBy[agreement][caller] = block.timestamp;
        d.arbiterDeals[caller].push(agreement);
        d.openClaimCount[caller]++;

        // Ключи пишутся ЗДЕСЬ, а не отдельным вызовом: одна транзакция вместо
        // двух, и арбитр не может оказаться заявленным без ключа даже на
        // мгновение.
        //
        // Событие — только при реальной смене (см. setArbiterChatKey выше,
        // тот же приём и та же причина): без условия арбитр с N открытыми
        // спорами, беря спор N+1 своим обычным ключом, шлёт N бесплатных
        // повторных предъявлений на склад — заявка почти всегда везёт ТОТ ЖЕ
        // ключ, что уже записан.
        bool keysChanged = d.arbiterBoxKey[caller] != boxKey || d.arbiterSignKey[caller] != signKey;
        d.arbiterBoxKey[caller]  = boxKey;
        d.arbiterSignKey[caller] = signKey;
        if (keysChanged) emit ArbiterChatKeySet(caller, boxKey, signKey);

        emit DisputeClaimed(agreement, caller);
    }

    function releaseDisputeClaim(address agreement) external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        address current = d.disputeClaims[agreement];
        if (current == address(0)) revert NotClaimed();
        if (caller != current && caller != OwnershipLib.contractOwner()) revert NotAuthorized();

        // Нельзя освободить клейм если вердикт уже подан (ждёт финализации)
        require(d.pendingVerdicts[agreement].submittedAt == 0, "ArbiterRegistry: verdict pending");

        // Отпускать спор после закрытия окна нельзя, и по той же причине, по
        // которой нельзя его после окна клеймить: вердикт там уже невозможен
        // (submitVerdict откажет), перезаклеймить спор тоже нельзя — значит в
        // оборот поздний отпуск спор не возвращает.
        //
        // Вредит он дважды. Уводит от наказания: notifyArbiterTimeout читает
        // disputeClaims и по пустому ключу молча выходит, так что неявившийся
        // арбитр уходил без судейской ошибки. И переключает ветку таймаута —
        // setArbiter(0) ниже превращает полный возврат клиенту в дележ
        // пополам, чем мог бесплатно пользоваться арбитр, дружественный
        // исполнителю.
        //
        // Третий его эффект полезен, и мы его тут теряем: отпуск уменьшал
        // openClaimCount, то есть освобождал самого арбитра. Пока сторона не
        // дёрнет triggerArbiterTimeout, счётчик неявившегося остаётся занят, а
        // с ним заперт и выход из статуса вместе с бондом. Осознанный размен:
        // цена — 50 USDC у того, кто уже нарушил; дыра стоила бы половины
        // любого спорного котла. Подробности и кандидат на честное лекарство
        // (`abandonClaim`, который снимает счётчик, пишет ошибку и НЕ трогает
        // Agreement.arbiter) — docs/OPEN-ITEMS.md, пункт 11.
        //
        // ⚠️ Лекарства «владелец расклинит» здесь БОЛЬШЕ НЕТ (финальный обзор
        // ветки, M-1, 16 августа 2026). Прежняя редакция этих строк называла им
        // `removeArbiter` — функцию, удалённую 15 августа: она снимала статус и
        // возвращала залог ЦЕЛИКОМ, то есть действительно распутывала запертого
        // арбитра без потерь. Её замена,
        // ArbiterAccountabilityFacet.removeArbiterForCause, залог не возвращает,
        // а СЖИГАЕТ в банк арбитров, требует кода повода и кладёт в цепь вечное
        // публичное обвинение. Это наказание, а не расклинивание: применять его
        // к человеку, который всего лишь застрял на чужом счётчике, значит
        // обвинить его публично за нашу же незакрытую дыру.
        //
        // Владелец диамонда (второй допустимый вызывающий выше) под гейт
        // попадает так же и обхода не получает: исключение вернуло бы ровно ту
        // дыру, ради которой гейт и стоит. До появления `abandonClaim` запертый
        // счётчик отпирает только явка стороны с triggerArbiterTimeout.
        (bool dOk, bytes memory dData) = agreement.staticcall(abi.encodeWithSignature("disputedAt()"));
        require(dOk, "ArbiterRegistry: disputedAt read failed");
        (bool wOk, bytes memory wData) = agreement.staticcall(abi.encodeWithSignature("DISPUTE_WINDOW()"));
        require(wOk, "ArbiterRegistry: DISPUTE_WINDOW read failed");
        if (block.timestamp > abi.decode(dData, (uint256)) + abi.decode(wData, (uint256))) {
            revert DisputeWindowPassed();
        }

        // Якорь взятия и запись о молчании здесь НЕ трогаются: они ключуются
        // парой (сделка, арбитр), поэтому «новый арбитр наследует чужое время»
        // невозможно и без уборки, а стирать запись о молчании нельзя — это
        // отдало бы арбитру право переставить её время. Наружу оба геттера
        // ходят через disputeClaims, поэтому сразу после этой строки они честно
        // дают ноль.
        delete d.disputeClaims[agreement];
        if (d.openClaimCount[current] > 0) d.openClaimCount[current]--;

        (bool ok,) = agreement.call(
            abi.encodeWithSignature("setArbiter(address)", address(0))
        );
        require(ok, "ArbiterRegistry: reset arbiter failed");

        emit DisputeReleased(agreement, current);
    }

    /// @notice Арбитр записывает в цепь факт: просил переписку — ответа не было.
    /// @dev Пуск только по слову арбитра, по таймеру не отлетает ничего (замысел 2.5).
    /// Последствий нет: ни XP, ни репутации, ни сдвига вердикта (замысел 2.6) — цепь не
    /// видит наш ящик и поверить может только слову арбитра, а навесить на непроверяемое
    /// слово автоматику значит выдать подкупленному арбитру настоящее оружие.
    /// Отпечаток предъявления записи НЕ мешает (замысел 2.11): жёсткий запрет дал бы
    /// стороне щит — отправить отпечаток пустышки и стать неуязвимой.
    function recordNoResponse(address agreement) external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        if (d.disputeClaims[agreement] != caller) revert NotClaimingArbiter();

        uint256 claimedAt = d.disputeClaimedAtBy[agreement][caller];
        // Ноль — спор взят ДО разреза 4в-2: цепь не знает, когда это было, и пол
        // считать не от чего. Отказываем закрыто. Выход есть и он дешёвый:
        // releaseDisputeClaim и взять спор заново (решение владельца 14.08.2026).
        if (claimedAt == 0) revert ClaimTimeUnknown();
        // Однократность проверяется РАНЬШЕ пола, и порядок здесь не косметика.
        // С якорем, который переставляется при каждом взятии, арбитр, уже
        // сделавший запись и перевзявший спор, упирался бы в NoResponseTooEarly:
        // ответ, который врёт: он обещает, что через сутки получится, а через
        // сутки получится NoResponseAlreadyRecorded. «Уже записано» — состояние
        // окончательное и от времени не зависящее, поэтому и отвечать про него
        // надо первым.
        if (d.disputeNoResponseAtBy[agreement][caller] != 0) revert NoResponseAlreadyRecorded();
        if (block.timestamp < claimedAt + NO_RESPONSE_FLOOR) revert NoResponseTooEarly();

        d.disputeNoResponseAtBy[agreement][caller] = block.timestamp;
        emit DisputeNoResponseRecorded(agreement, caller, block.timestamp);
    }

    /// @notice Сторона спора кладёт в цепь отпечаток предъявления — 32 байта.
    /// @dev Это `keccak256` того же канонического вида, которым сторона
    /// ПОДПИСЫВАЕТ предъявление (`canonicalPresentationBytes`,
    /// frontend/src/lib/presentation.ts:526: длина перед каждым полем, склеек
    /// нет). Функция хэша названа здесь дословно и не случайно: это шов, у
    /// которого цепь видит только 32 байта и совпадение проверить не может
    /// ничем. Возьми фронт sha256 — в цепи лежали бы такие же законные 32
    /// байта, «сходится» не сошлось бы никогда, и узнали бы мы об этом от
    /// человека со сломанным экраном. Смысл — не доказать содержание,
    /// а показать ПОРЯДОК: отпечаток лёг на блоке N, запись арбитра «просил,
    /// ответа нет» — на блоке M. Доверия к нашему серверу для этого не нужно, и
    /// если сервер потеряет ящик, факт предъявления останется.
    ///
    /// Записи о молчании отпечаток НЕ мешает (замысел 2.11) — ни здесь, ни в
    /// recordNoResponse нет ни одной строки, которая связывала бы одно с другим.
    /// Жёсткий запрет дал бы стороне щит: цепь не знает, что лежит под хэшем,
    /// значит неуязвимость покупалась бы отпечатком пустого файла. Кто прав,
    /// решает арбитр, глядя на порядок, а не контракт.
    function recordPresentationDigest(address agreement, bytes32 digest) external {
        if (digest == bytes32(0)) revert ZeroDigest();

        address caller = _msgSender();

        // Стороны берём из СВОЕГО реестра, а не внешним вызовом к сделке.
        // RegistryStorage.AgreementRecord уже держит client и executor
        // (src/RegistryFacet.sol), и остальные функции этого фасета ходят туда
        // же (notifyArbiterTimeout, fundDispute). Так дешевле, не заводит
        // внешнего вызова с разбором returndata — и заодно отвечает на «а
        // сделка вообще наша?»: у адреса, которого в реестре нет, нет ни
        // клиента, ни исполнителя, поэтому стороной по нему не окажется никто и
        // ленту чужой сделки не наполнит никто.
        RegistryStorage.AgreementRecord storage rec =
            RegistryStorage.store().agreements[agreement];
        // ⚠️ Первая строка сегодня СРАБОТАТЬ НЕ МОЖЕТ, и написано это здесь,
        // чтобы следующий читатель не принял её за живой замок. Записи в
        // реестре пишутся целиком (RegistryFacet.register) и не удаляются
        // нигде, поэтому «записи нет» означает и client == 0, и executor == 0 —
        // а тогда вторая строка отвергает любого ненулевого вызывающего сама.
        // Замерено снятием: убрать первую строку — 0 красных из 632; убрать обе
        // — 3 красных. Оставлена как объявление намерения («сделка обязана быть
        // нашей») ценой одного холодного SLOAD; если этот SLOAD когда-нибудь
        // станет жалко, снимать надо именно её, а не вторую.
        if (rec.agreement != agreement) revert NotDisputeParty();
        if (caller != rec.client && caller != rec.executor) revert NotDisputeParty();

        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        d.presentationDigests[agreement].push(digest);
        emit PresentationDigestRecorded(
            agreement, caller, digest, d.presentationDigests[agreement].length - 1
        );
    }

    // -------- VERDICT FLOW --------

    /// @notice Арбитр подаёт вердикт. Ещё не исполняется — ждёт finalizeVerdict.
    function submitVerdict(address agreement, bool clientWins) external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        if (d.disputeClaims[agreement] != caller) revert NotTheClaimer();
        if (d.pendingVerdicts[agreement].submittedAt != 0) revert VerdictAlreadySubmitted();

        // Проверяем что соглашение ещё в споре
        (bool ok, bytes memory st) = agreement.staticcall(abi.encodeWithSignature("status()"));
        require(ok, "ArbiterRegistry: status read failed");
        require(abi.decode(st, (uint8)) == 4, "ArbiterRegistry: not disputed");

        // Арбитр должен успеть подать вердикт за DISPUTE_WINDOW от disputedAt. Раньше эта
        // проверка жила в Agreement.resolveDispute() и срабатывала в момент ИСПОЛНЕНИЯ —
        // из-за FINALIZE_DELAY/апелляции исполнение легитимно происходит намного позже
        // подачи, так что единственное место, где время должно проверяться — подача.
        (bool disputedOk, bytes memory disputedData) = agreement.staticcall(abi.encodeWithSignature("disputedAt()"));
        require(disputedOk, "ArbiterRegistry: disputedAt read failed");
        uint256 disputedAt = abi.decode(disputedData, (uint256));

        (bool windowOk, bytes memory windowData) = agreement.staticcall(abi.encodeWithSignature("DISPUTE_WINDOW()"));
        require(windowOk, "ArbiterRegistry: DISPUTE_WINDOW read failed");
        uint256 disputeWindow = abi.decode(windowData, (uint256));

        if (block.timestamp > disputedAt + disputeWindow) revert DisputeWindowPassed();

        d.pendingVerdicts[agreement] = ArbiterRegistryStorage.PendingVerdict({
            arbiter:        caller,
            clientWins:     clientWins,
            submittedAt:    block.timestamp,
            frozen:         false,
            finalized:      false,
            overturned:     false,
            executing:      false,
            appealed:       false,
            appealResolved: false,
            appellant:      address(0),
            appealDeadline: 0,
            votesUphold:    0,
            votesOverturn:  0
        });

        emit VerdictSubmitted(agreement, caller, clientWins);
    }

    /// @notice Исполнить вердикт. Любой может вызвать. Diamond вызывает resolveDispute на Agreement.
    /// Если вердикт заморожен (frozen) — ждём пока owner/DAO разморозит или отменит.
    function finalizeVerdict(address agreement) external {
        if (agreement == address(0)) revert ArbiterZeroAddress();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        ArbiterRegistryStorage.PendingVerdict storage v = d.pendingVerdicts[agreement];

        if (v.submittedAt == 0) revert NoVerdict();
        if (v.finalized) revert AlreadyFinalized();
        if (v.frozen) revert VerdictFrozenError();
        // Проверяем АРБИТРА ВЕРДИКТА, не вызывающего: финализировать может кто
        // угодно, а держим мы именно приостановленного судью.
        _requireNotSuspended(d, v.arbiter);
        require(block.timestamp >= v.submittedAt + FINALIZE_DELAY, "ArbiterRegistry: finalize delay not passed");

        // Защита от авто-удаления в clearDisputeClaim во время этого вызова
        v.executing = true;

        // Доплата обнуляется ЗДЕСЬ, до внешнего вызова, независимо от исхода.
        // resolveDispute через агримент дойдёт до clearDisputeClaim, и если бы
        // доплата была ещё на месте, та вернула бы её плательщику — то есть
        // при обычной выплате арбитр и плательщик получили бы одни и те же
        // деньги. Обнуление до вызова делает двойную выплату невозможной по
        // конструкции, а не по проверке.
        uint256 bounty = d.disputeBounty[agreement];
        if (bounty > 0) {
            d.disputeBounty[agreement] = 0;
            address bountyPayer = d.disputeBountyPayer[agreement];
            delete d.disputeBountyPayer[agreement];

            if (v.overturned) {
                // Отменённый вердикт не оплачивается: 80% сбора при отмене уже
                // уходят в казну (creditDisputeFee), и доплата не должна быть
                // исключением — за одну и ту же ошибку нельзя терять одну часть
                // оплаты и сохранять другую. Деньги возвращаются плательщику:
                // он покупал разрешение спора и не получил его. Через
                // claimable (refundableBounty/withdrawDisputeBounty), а не
                // прямым transfer — жёсткий перевод здесь уронил бы всю
                // финализацию, если плательщик в чёрном списке USDC или иначе
                // не может принять перевод.
                d.refundableBounty[bountyPayer] += bounty;
                emit DisputeBountyRefundable(agreement, bountyPayer, bounty);
            } else {
                d.arbiterRewards[v.arbiter] += bounty;
                emit ArbiterRewarded(v.arbiter, bounty);
            }
        }

        // Diamond (address(this)) вызывает resolveDispute — работает т.к. Diamond = arbiter
        (bool ok, bytes memory ret) = agreement.call(
            abi.encodeWithSignature("resolveDispute(bool)", v.clientWins)
        );

        v.executing = false; // всегда сбрасываем, даже при ревёрте

        if (!ok) {
            // пробросить причину ревёрта из Agreement
            assembly { revert(add(ret, 32), mload(ret)) }
        }

        v.finalized = true;

        // Вердикт дошёл до финализации без overturn — судейская ошибка не подтвердилась,
        // серия ошибок сбрасывается. Заодно растёт судейский стаж (задача 5,
        // 15 августа 2026): счётчик неперевёрнутых финализированных вердиктов,
        // нужный для будущей конвертации «залог плюс стаж» при включении ДАО.
        if (!v.overturned) {
            d.arbiterMistakeStreak[v.arbiter] = 0;
            d.cleanVerdicts[v.arbiter]++;
        }

        emit VerdictFinalized(agreement, v.arbiter, v.clientWins);
    }

    /// @notice Owner или DAO отменяют вердикт до финализации.
    /// Арбитр теряет XP и награду. Новый вердикт исполняется вместо старого.
    ///
    /// ONE VERDICT EARNS AT MOST ONE JUDICIAL MISTAKE — and that promise is
    /// kept by two lines, not by this one. Here: a verdict already overturned,
    /// by this door or by the appeal vote, refuses with AlreadyOverturned.
    /// There in resolveAppeal: a panel that overturns a verdict the hand had
    /// already overturned books nothing, and takes the hand's booking back.
    ///
    /// There is no changing one's mind after the press, and none is needed:
    /// the mind is made up inside the call, through `newClientWins`. Letting
    /// the hand press twice would let the owner walk a dispute's outcome back
    /// and forth without limit, and "whoever pressed last decided" is a worse
    /// property than not being able to reconsider.
    ///
    /// ⚠️ No check of MERIT lives on this door — not one. The whole restraint
    /// on it is arithmetic — three mistakes, and since task 12 (18 August 2026)
    /// they buy an ACCUSATION plus a 48-hour pause rather than an unseating —
    /// plus the appeal, which stays open after a press here precisely so that
    /// it can contradict it. That pause is what makes the arithmetic worth
    /// something: pressing this three times used to end the matter in one
    /// transaction, past the door that demands a cause, and it survived the
    /// handover because this function admits the owner always.
    function overturnVerdict(address agreement, bool newClientWins) external onlyOwnerOrDAO {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        ArbiterRegistryStorage.PendingVerdict storage v = d.pendingVerdicts[agreement];

        if (v.submittedAt == 0) revert NoVerdict();
        if (v.finalized) revert AlreadyFinalized();
        if (v.appealed && !v.appealResolved) revert AppealInProgress();
        // ⚠️ resolveAppeal sets this flag too, so a verdict already reversed by
        // the vote can no longer be reversed again by hand — deliberately: one
        // verdict earns at most one judicial mistake, whoever books it.
        //
        // This line alone did NOT deliver that. The reverse order — hand first,
        // panel second — stayed open, had to stay open (the appeal is the only
        // check on this door), and booked the second mistake there instead.
        // That half is closed inside resolveAppeal, not here.
        //
        // Stands BELOW the three checks above, and that is load-bearing: both
        // `finalized` and an appeal in flight are reachable with `overturned`
        // already true, and in both the older reason is the larger fact and
        // must be the one the person reads.
        if (v.overturned) revert AlreadyOverturned();

        address slashedArbiter = v.arbiter;
        v.clientWins = newClientWins;
        v.overturned = true;
        v.frozen     = false; // размораживаем чтобы можно было финализировать

        // Slash XP арбитра
        ReputationStorage.Data storage rep = ReputationStorage.data();
        _slashArbiterXP(rep, slashedArbiter);

        // `by` — СЫРОЙ msg.sender, и это не оплошность: роль на этой двери
        // проверил модификатор onlyOwnerOrDAO по нему же. Взять здесь
        // _msgSender() значило бы записать в вечную ленту одного, а решение
        // приписать другому (запись в script/gasless-sender.allow).
        _recordArbiterMistake(d, rep, slashedArbiter, msg.sender, DemotionPath.OwnerOverturn, agreement);

        emit VerdictOverturned(agreement, slashedArbiter, newClientWins);
    }

    /// @notice Вызывается Agreement, когда арбитр не успел вынести вердикт за DISPUTE_WINDOW
    /// (triggerArbiterTimeout). Считается судейской ошибкой для демоушена (в отличие от
    /// overturnVerdict — XP при этом не режется, вердикт ведь не был неверным, его просто
    /// не было). Реальный арбитр читается из disputeClaims, а НЕ из Agreement.arbiter() —
    /// после claimDispute() тот указывает на сам Diamond (паттерн Diamond-as-arbiter для
    /// контроля вердикта), а не на человека, который забрал спор. Вызывается ДО
    /// _clearDisputeClaim() внутри triggerArbiterTimeout, так что запись ещё на месте.
    function notifyArbiterTimeout(address agreement) external {
        if (msg.sender != agreement) revert NotAuthorized();
        if (RegistryStorage.store().agreements[agreement].agreement != agreement) revert NotAuthorized();

        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        address arbiterAddr = d.disputeClaims[agreement];
        if (arbiterAddr == address(0)) return; // никто не забирал спор — не на кого списывать

        ReputationStorage.Data storage rep = ReputationStorage.data();
        // `by` нулевой: msg.sender здесь — сам агримент (проверено выше),
        // человека за вызовом нет вовсе.
        _recordArbiterMistake(d, rep, arbiterAddr, address(0), DemotionPath.AgreementTimeout, agreement);
    }

    /// @notice Списывает OVERTURN_XP_SLASH у арбитра, не давая уйти в underflow.
    /// Общий хелпер для overturnVerdict и resolveAppeal (оба режут XP одинаково).
    function _slashArbiterXP(ReputationStorage.Data storage rep, address arbiterAddr) private {
        if (rep.xp[arbiterAddr] >= OVERTURN_XP_SLASH) {
            rep.xp[arbiterAddr] -= OVERTURN_XP_SLASH;
        } else {
            rep.xp[arbiterAddr] = 0;
        }
    }

    /// Общий запрет для трёх мест: claimDispute, resignAsArbiter, finalizeVerdict.
    /// Читает то же поле, которое пишет ArbiterAccountabilityFacet.suspendArbiter —
    /// оба фасета делят один ArbiterRegistryStorage.
    function _requireNotSuspended(ArbiterRegistryStorage.Data storage d, address who) private view {
        uint256 until = d.suspendedUntil[who];
        if (block.timestamp < until) revert ArbiterSuspendedError(until);
    }

    /// Зеркало ArbiterAccountabilityFacet.PROPOSAL_TTL (arbiter-accountability,
    /// задача 7, круг правок 1, Important 2, 15 августа 2026) —
    /// resignAsArbiter обязан знать срок жизни предложения, не вызывая другой
    /// фасет (тот же приём, что MISTAKE_THRESHOLD/DAO_THRESHOLD в обратную
    /// сторону). Равенство доказано ПОВЕДЕНЧЕСКИ — граничные тесты на «14
    /// суток минус секунда» / «ровно 14 суток» в test/ArbiterSuspension.t.sol
    /// (test_ResignHoldsUntilTheLastSecondOfProposal /
    /// test_ResignSucceedsAfterProposalExpires), а не идентичностью через
    /// геттер: отдельный публичный геттер стоил бы нового селектора ради числа,
    /// которое в этом фасете читает один-единственный помощник, а граничный
    /// тест ловит рассинхрон надёжнее — он падает, если мираж числа хоть на
    /// секунду разошёлся с настоящим, идентичность же сравнивала бы два
    /// одинаково неверных числа как совпадающие.
    ///
    /// ⚠️ ЧИСЛО ЧИТАЕТ РОВНО ОДИН ПОМОЩНИК, А ЕГО ЗОВУТ ТРОЕ (задача 12,
    /// круги правок 1 и 2, 18 августа 2026). Здесь стояло «больше нигде в этом
    /// фасете не читается», и это устарело дважды подряд — сперва задачей,
    /// потом её же кругом правок.
    ///
    /// Читатель числа один: `_hasLiveProposalHere`. Зовут его:
    ///   • `_requireNoLiveRemovalProposal` — дверь резигнации;
    ///   • ветка порога в `_recordArbiterMistake` — цепь молча уступает
    ///     занятой двери;
    ///   • ветка оправдания в `resolveAppeal` — гасится только ЖИВОЕ обвинение
    ///     цепи (круг правок 2: мёртвое стирало счётчик целиком).
    ///
    /// ⚠️ Считать вызывающих здесь поимённо — значит держать список, который
    /// протухает от правки в чужой функции. Он и протух, дважды. Ценность
    /// абзаца не в списке, а в том, что охраняется: ВТОРОГО НАПИСАНИЯ ФОРМУЛЫ
    /// ПРОТУХАНИЯ В ФАЙЛЕ НЕТ. Это и проверяйте — грепом по
    /// `PROPOSAL_TTL_MIRROR`, а не чтением этого перечисления.
    uint256 private constant PROPOSAL_TTL_MIRROR = 14 days;

    /// Numeric codes of ArbiterAccountabilityFacet.Cause, mirrored here
    /// because the proposal the chain lays needs a cause and the enum lives in
    /// the OTHER facet (task 12, 18 August 2026). Same reason the storage
    /// struct keeps `cause` as uint8: importing a type from another file to
    /// write a record would mean a rename there moves the record here.
    ///
    /// ⚠️ A copy without a guard drifts in silence, so this pair is guarded
    /// BEHAVIOURALLY, the way PROPOSAL_TTL_MIRROR above is: the tests read the
    /// expected value out of ArbiterAccountabilityFacet.Cause — an independent
    /// source, the enum itself — and compare it against the cause the chain
    /// actually wrote into getRemovalProposal(). Reorder the enum and they go
    /// red. An identity getter would have cost a second selector and would
    /// have compared two equally wrong numbers as equal.
    uint8 private constant CAUSE_OVERTURNED_VERDICTS_MIRROR = 0;
    uint8 private constant CAUSE_TIMEOUTS_MIRROR            = 1;

    /// Which cause the chain writes for which path. Both codes are
    /// _isChainVerifiable and both are proved by the SAME counter, so
    /// _requireProven admits either — while the feed and the standing card
    /// keep the distinction that task 4 paid a field for.
    ///
    /// ⚠️ CANNOT REVERT, and the default is deliberate rather than lazy: this
    /// runs inside the threshold branch, which notifyArbiterTimeout reaches
    /// from an EMPTY try/catch in Agreement.sol. DemotionPath.Unspecified is
    /// sent by no caller (see the enum's docstring); were it ever sent, the
    /// record would say OverturnedVerdicts, which is the cause the counter
    /// actually proves.
    function _causeForPath(DemotionPath path) private pure returns (uint8) {
        return path == DemotionPath.AgreementTimeout
            ? CAUSE_TIMEOUTS_MIRROR
            : CAUSE_OVERTURNED_VERDICTS_MIRROR;
    }

    /// Is a removal proposal — anyone's — standing against this person right
    /// now. One owner for the staleness rule inside this facet:
    /// _requireNoLiveRemovalProposal below is written on top of this, not
    /// beside it.
    function _hasLiveProposalHere(ArbiterRegistryStorage.Data storage d, address who)
        private view returns (bool)
    {
        uint256 proposedAt = d.removalProposals[who].proposedAt;
        return proposedAt != 0 && block.timestamp < proposedAt + PROPOSAL_TTL_MIRROR;
    }

    /// Третий запрет двери резигнации (см. HasLiveRemovalProposal и докстринг
    /// поля removalProposals). НЕ через suspendArbiter изнутри proposeRemoval
    /// (был предложен ревьюером, решение владельца — отклонено): приостановка
    /// морозит уже поданные вердикты арбитра, то есть каждое предложение
    /// морозило бы деньги честных сторон в его ОТКРЫТЫХ спорах, не имеющих к
    /// предложению отношения. Предложение слабее сноса и такой цены не стоит —
    /// точечный запрет здесь и только здесь, ничего постороннего не морозит.
    ///
    /// ⚠️ Известное ограничение, не баг: директор может класть предложение
    /// заново каждые 14 суток и держать чужой залог запертым бесконечно.
    /// Сегодня это приемлемо — предложения публично приписаны его адресу
    /// (RemovalProposed индексирует `by`), а заверяемые коды требуют
    /// отпечатка, то есть безосновательное перевыставление видно в ленте так
    /// же явно, как само предложение.
    function _requireNoLiveRemovalProposal(ArbiterRegistryStorage.Data storage d, address who) private view {
        if (_hasLiveProposalHere(d, who)) revert HasLiveRemovalProposal();
    }

    /// Блок директора = арбитры его посадки, сидящие сейчас, ПЛЮС он сам, если
    /// он арбитр. Второе слагаемое обязательно: setChiefArbiter не запрещает
    /// директору быть арбитром, и ОДИН его ставленник плюс он сам — это уже
    /// два голоса, то есть решающее большинство при явке ровно в кворум
    /// (п. 67, 16 августа 2026; прежняя редакция считала здесь до тройки).
    ///
    /// ⚠️ Это МОЩНОСТЬ ОБЪЕДИНЕНИЯ, а не сумма (уборка 7а, М-1 ревью задачи 3).
    /// Директор, посадивший САМ СЕБЯ, попадает в оба слагаемых сразу:
    /// `seatedCountBy[chief]` его уже посчитал, и слепое `+1` считало бы его
    /// вторым голосом, которого нет. Условие `seatedBy[chief] != chief` эту
    /// вторую копию снимает.
    ///
    /// На ИСХОД посадки это не влияет ни в одном достижимом состоянии — при
    /// самопосадке обе редакции дают `blocAfter >= APPEAL_DECIDING_VOTES` и
    /// одинаково отказывают, — но геттер `getChiefBloc` публичный и читается
    /// снаружи, а число, которым он отвечает, объявлено как «сколько голосов
    /// у блока». Врать на единицу ему нельзя: два — это порог, за которым
    /// апелляция решена, и читатель принимает по этому числу решение.
    ///
    /// ⚠️ Свойство «блок ≤ 1» держится ТОЛЬКО на двери addArbiter, ТОЛЬКО у
    /// директора и ТОЛЬКО в момент нажатия (И-1, Ruling 17). Владелец, посадив
    /// директора арбитром ПОСЛЕ его ставленника, доводит блок до настоящей
    /// двойки — замерено, `getChiefBloc()` = 2. `applyAsArbiter` `_chiefBloc`
    /// не зовёт вовсе. Настоящее лекарство — считать блок в момент
    /// ГОЛОСОВАНИЯ, а не посадки; это изменение замысла, оно в OPEN-ITEMS.
    function _chiefBloc(ArbiterRegistryStorage.Data storage d) private view returns (uint256) {
        address chief = d.chiefArbiter;
        if (chief == address(0)) return 0;
        uint256 bloc = d.seatedCountBy[chief];
        // Второй раз того же человека не считаем: см. «мощность объединения».
        if (d.isArbiter[chief] && d.seatedBy[chief] != chief) bloc += 1;
        return bloc;
    }

    /// @notice The shared judicial-mistake counter for overturnVerdict,
    /// notifyArbiterTimeout and resolveAppeal.
    ///
    /// On the MAX_ARBITER_MISTAKES-th mistake in a row: XP hard-reset to
    /// DEMOTION_XP_RESET (a landing point, not a subtraction), suspension for
    /// SUSPENSION_WINDOW, and a removal proposal opened in the CHAIN'S OWN
    /// NAME. The seat is NOT taken here any more — see the branch below.
    /// cleanStreak (the executor streak) is untouched: judging and delivering
    /// are different skills.
    ///
    /// ⚠️ TWO THRESHOLDS LIVE NEXT TO EACH OTHER AND THEY ARE NOT THE SAME
    /// NUMBER (review of task 11, 18 August 2026 — this is what a reviewer
    /// tripped over):
    ///
    ///   • MAX_ARBITER_MISTAKES = 3 — the AUTOMATIC threshold, right here. The
    ///     chain acts on its own: suspension plus an accusation with no author.
    ///   • ArbiterAccountabilityFacet.MISTAKE_THRESHOLD = 2 — the PROOF
    ///     threshold, read by _requireProven. It is what a HUMAN needs to have
    ///     against an arbiter before Cause.OverturnedVerdicts/Timeouts counts
    ///     as proven, and it is one lower on purpose: the manual door is
    ///     valuable precisely because it fires EARLIER than the automaton.
    ///
    /// ⚠️ AND THE CONSEQUENCE IS NOT THE ONE THIS PARAGRAPH USED TO CLAIM
    /// (review round 2 of task 12, 18 August 2026). It said: "the streak stays
    /// at 3, and 3 >= 2, so the accusation the chain just laid is provable when
    /// the button is pressed two days later" — which stopped being true in the
    /// same commit that wrote it, when executeChainRemoval stopped re-proving
    /// the cause at all (C-1). The button asks the RECORD, never the counter,
    /// and works at streak 0.
    ///
    /// What the two thresholds still do differ about: MISTAKE_THRESHOLD gates
    /// the MANUAL door, and only it. The reachable case is not hypothetical —
    /// the chain's accusation goes stale after PROPOSAL_TTL with nobody having
    /// pressed, and a human may then propose on the very same evidence, because
    /// the counter is still standing where the mistakes left it.
    ///
    /// `by` is kept in the signature and no longer read: ArbiterDemoted moved
    /// to the actual removal (ArbiterAccountabilityFacet.executeChainRemoval),
    /// where nobody pressed anything and the presser is deliberately not named.
    /// Unnamed rather than deleted — the three call sites still say who acted,
    /// which is the thing to restore if the record ever wants him again.
    function _recordArbiterMistake(
        ArbiterRegistryStorage.Data storage d,
        ReputationStorage.Data storage rep,
        address arbiterAddr,
        address /* by */,
        DemotionPath path,
        address agreement
    ) private {
        uint256 mistakes = d.arbiterMistakeStreak[arbiterAddr] + 1;
        d.arbiterMistakeStreak[arbiterAddr] = mistakes;

        if (mistakes >= MAX_ARBITER_MISTAKES) {
            // The seat is no longer taken here. The automatic path stops the
            // arbiter at once and ACCUSES him; the removal itself runs through
            // the common door — proposal, 48 hours, a right to answer — like
            // every other removal. Owner's decision of 18 August 2026: "the
            // same door, and the suspension is the fast path".
            //
            // Before this, the quiet door also survived the handover:
            // overturnVerdict sits under onlyOwnerOrDAO, which lets the owner
            // through always, so the ratchet this whole branch exists to build
            // was bypassed by three presses.
            rep.xp[arbiterAddr] = DEMOTION_XP_RESET;

            // ⚠️ THE SUSPENSION IS UNCONDITIONAL and stands ABOVE the guard
            // below. It is the fast lever, and it must land even when the
            // accusation cannot: an arbiter whose third mistake arrives while
            // a human accusation stands is still stopped this second.
            d.suspendedUntil[arbiterAddr] = block.timestamp + ArbiterRegistryStorage.SUSPENSION_WINDOW;

            // ⚠️ THE STREAK IS NOT CLEARED HERE, AND THE REASON WAS REWRITTEN
            // (review round 2 of task 12). It used to say that _requireProven
            // reads this counter and zeroing it would leave the chain's own
            // accusation unprovable — "a door that looks built and never
            // opens". C-1 made that false: executeChainRemoval does not ask the
            // counter at all, and opens at streak 0.
            //
            // The reason it stays is plainer. The counter means "judicial
            // mistakes in an unbroken row", and the arbiter has done nothing to
            // break the row by being accused — clearing it here would have the
            // chain assert an end that did not happen. Two readers still live
            // on that value: the MANUAL door through _requireProven (reachable
            // once this accusation goes stale unpressed), and resolveAppeal,
            // which subtracts from it when a panel takes a mistake back.
            //
            // ⚠️ WHERE THE "BUILT AND NEVER OPENS" RISK ACTUALLY LIVES NOW: in
            // WRITING THE RECORD BELOW. That record is the whole proof the
            // button consults, so the way to build a door that never opens is
            // to skip it, not to touch this counter.
            //
            // The streak clears on the actual removal (_performRemoval), on
            // withdrawal of this proposal, and when a panel vindicates him.
            //
            // ⚠️ AND NOTHING BELOW MAY REVERT. notifyArbiterTimeout reaches
            // here from Agreement.sol (triggerArbiterTimeout) inside an EMPTY
            // try/catch: a revert is swallowed in silence and the arbiter walks
            // away untouched, without a trace. So a live proposal — anyone's —
            // is yielded to, not fought over: task 10 made proposeRemoval
            // refuse to overwrite a standing record, and this branch writes
            // storage directly, past that door. It must obey the same rule
            // WITHOUT the revert that enforces it there.
            //
            // What yielding costs, named rather than hidden: the human
            // accusation may later be withdrawn, and the chain's proof does not
            // turn into a proposal by itself — another overturn is needed. The
            // streak is kept for exactly that, so the next one tries again.
            if (!_hasLiveProposalHere(d, arbiterAddr)) {
                d.removalProposals[arbiterAddr] = ArbiterRegistryStorage.RemovalProposal({
                    cause:          _causeForPath(path),
                    // No digest: the evidence is the chain's own state, and a
                    // hash of nothing would be a promise of a preimage nobody
                    // can show. _requireProven reads the counter instead.
                    evidenceDigest: bytes32(0),
                    proposedAt:     block.timestamp,
                    // ⚠️ THE ACCUSER IS THE CHAIN, so this is the zero address
                    // and that is the whole guarantee: executeChainRemoval
                    // refuses anything else, and nobody's name is dirtied by an
                    // accusation no person made (design decision 11,
                    // consequence 2).
                    by:             address(0)
                });
                d.chainProposalPath[arbiterAddr] = uint8(path);
                emit RemovalProposedByChain(arbiterAddr, uint8(path), agreement, block.timestamp);
            }
        }
    }

    /// @notice Заморозить вердикт (например пока идёт расследование).
    function freezeVerdict(address agreement) external onlyOwnerOrDAO {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        ArbiterRegistryStorage.PendingVerdict storage v = d.pendingVerdicts[agreement];
        if (v.submittedAt == 0) revert NoVerdict();
        if (v.finalized) revert AlreadyFinalized();
        v.frozen = true;
        emit VerdictFrozen(agreement);
    }

    /// @notice Разморозить вердикт.
    function unfreezeVerdict(address agreement) external onlyOwnerOrDAO {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        ArbiterRegistryStorage.PendingVerdict storage v = d.pendingVerdicts[agreement];
        if (v.appealed && !v.appealResolved) revert AppealInProgress();
        v.frozen = false;
        emit VerdictUnfrozen(agreement);
    }

    // -------- APPEAL FLOW (user-initiated, pre-finalization only) --------

    /// @notice Проигравшая сторона оспаривает вердикт до того как деньги ушли исполнителю/клиенту.
    /// Требует APPEAL_DEPOSIT — флэт, не % от суммы сделки (сумма выбрана сторонами, ей нельзя
    /// доверять как входу для чего-либо, что можно проиграть/выиграть).
    function raiseAppeal(address agreement) external {
        if (agreement == address(0)) revert ArbiterZeroAddress();
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        ArbiterRegistryStorage.PendingVerdict storage v = d.pendingVerdicts[agreement];

        if (v.submittedAt == 0) revert NoVerdict();
        if (v.finalized) revert AlreadyFinalized();
        // Checked before `frozen`: raiseAppeal() itself sets frozen=true as a side effect, so
        // once appealed, frozen is always already true too — checking frozen first would make
        // AlreadyAppealed unreachable on a second call to this same function.
        if (v.appealed) revert AlreadyAppealed();
        if (v.frozen) revert VerdictFrozenError();
        if (block.timestamp >= v.submittedAt + FINALIZE_DELAY) revert AppealWindowClosed();

        (bool clientOk, bytes memory clientData) = agreement.staticcall(abi.encodeWithSignature("client()"));
        (bool execOk,   bytes memory execData)   = agreement.staticcall(abi.encodeWithSignature("executor()"));
        require(clientOk && execOk, "ArbiterRegistry: failed to read parties");
        address agreementClient   = abi.decode(clientData, (address));
        address agreementExecutor = abi.decode(execData,   (address));

        bool callerIsLosingClient   = caller == agreementClient   && !v.clientWins;
        bool callerIsLosingExecutor = caller == agreementExecutor &&  v.clientWins;
        if (!callerIsLosingClient && !callerIsLosingExecutor) revert NotLosingParty();

        uint256 eligibleVoters;
        uint256 len = d.arbiterList.length;
        for (uint256 i = 0; i < len; i++) {
            if (d.arbiterList[i] != v.arbiter) eligibleVoters++;
        }
        if (eligibleVoters < APPEAL_MIN_VOTES) revert InsufficientArbitersForAppeal();

        address usdc = FactoryStorage.store().usdc;
        bool ok = IUSDCFull(usdc).transferFrom(caller, address(this), APPEAL_DEPOSIT);
        require(ok, "ArbiterRegistry: deposit transfer failed");

        v.appealed       = true;
        v.frozen         = true;
        v.appellant      = caller;
        v.appealDeadline = block.timestamp + APPEAL_REVIEW_WINDOW;

        emit AppealRaised(agreement, caller);
    }

    /// @notice Любой зарегистрированный арбитр, кроме вынесшего вердикт, голосует один раз.
    function voteOnAppeal(address agreement, bool overturn) external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        ArbiterRegistryStorage.PendingVerdict storage v = d.pendingVerdicts[agreement];

        if (!d.isArbiter[caller]) revert NotArbiter();
        if (!v.appealed) revert NoAppeal();
        if (v.appealResolved) revert AppealAlreadyResolved();
        if (caller == v.arbiter) revert CannotVoteOnOwnVerdict();
        if (block.timestamp >= v.appealDeadline) revert AppealWindowClosed();
        if (d.hasVotedAppeal[agreement][caller]) revert AlreadyVoted();

        d.hasVotedAppeal[agreement][caller] = true;
        if (overturn) {
            v.votesOverturn++;
        } else {
            v.votesUphold++;
        }

        emit AppealVoteCast(agreement, caller, overturn);
    }

    /// @notice Подводит итог голосования по апелляции. Можно звать сразу как кворум
    /// (APPEAL_MIN_VOTES) набран — не дожидаясь конца окна. Если окно закрылось без
    /// кворума, апелляция отклоняется по умолчанию (не зависаем навечно).
    function resolveAppeal(address agreement) external {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        ArbiterRegistryStorage.PendingVerdict storage v = d.pendingVerdicts[agreement];

        if (!v.appealed) revert NoAppeal();
        if (v.appealResolved) revert AppealAlreadyResolved();

        bool quorumReached = v.votesUphold + v.votesOverturn >= APPEAL_MIN_VOTES;
        bool windowClosed  = block.timestamp >= v.appealDeadline;
        if (!quorumReached && !windowClosed) revert AppealWindowNotClosed();

        v.appealResolved = true;
        v.frozen         = false;

        bool overturn = quorumReached && v.votesOverturn > v.votesUphold;
        address usdc  = FactoryStorage.store().usdc;

        if (overturn) {
            address slashedArbiter = v.arbiter;

            // ⚠️ READ BEFORE THE WRITE BELOW (review round 1 of task 11,
            // 18 August 2026). At this point `overturned` is true if and only
            // if a HAND already overturned this verdict: overturnVerdict and
            // this branch are its only writers, and this branch runs at most
            // once per verdict (appealResolved). That is why telling the two
            // cases apart needs no new storage field and the layout does not
            // move.
            bool alreadyOverturned = v.overturned;

            v.clientWins = !v.clientWins;
            v.overturned = true;

            // ⚠️ A PANEL THAT VINDICATES THE ARBITER TAKES HIS MISTAKE BACK.
            // The sequence that made this necessary: the arbiter rules, the
            // owner's hand overturns him (mistake one), the losing side appeals
            // — which stays open on purpose, it is the only check on the owner
            // there is — and the panel votes to overturn, flipping the ruling
            // back to the ARBITER'S OWN. The panel has just said he was right
            // and the owner was wrong.
            //
            // Booking that as HIS mistake slashed his XP twice for one verdict
            // and wrote DemotionPath.AppealVote into the permanent record: the
            // chain asserting "the panel found him wrong" precisely where it
            // found the opposite. Measured before the fix: two disputes unseated
            // an arbiter instead of three, and no collusion was needed — an
            // honest panel deciding correctly handed the owner the second
            // mistake for free.
            //
            // So the second booking does not happen, and the first is taken
            // back: if the panel says there was no judicial mistake, then a
            // mark standing against him for that verdict is the record lying.
            // ONE is subtracted, not the whole streak — mistakes on OTHER
            // disputes are his and stay his.
            //
            // ⚠️ XP IS NOT GIVEN BACK, and that is said out loud rather than
            // passed over. _slashArbiterXP takes OVERTURN_XP_SLASH with a floor
            // at zero and records nowhere how much it actually took, so adding
            // the constant back would hand an arbiter who was slashed INTO the
            // floor points he never had. Storing the amount taken would cost a
            // storage field for a small truth, and that trade was refused. The
            // slash he keeps is one instead of two, the second having left
            // together with the booking.
            //
            // ⚠️ HOW FAR THE VINDICATION REACHES, REWRITTEN BY TASK 12
            // (18 August 2026). This paragraph used to say "the counter comes
            // back, the seat does not: the demotion already fired inside
            // _recordArbiterMistake — seat gone, bond forfeited, suspension set
            // — and none of that is walked back here". Two of its three facts
            // died with the threshold branch, and the code seven lines below
            // now contradicts a third.
            //
            // As it stands:
            //   • the third mistake takes NO seat and burns NO bond — it
            //     suspends and accuses, so on the ordinary timeline there is
            //     nothing to walk back and the branch below simply cancels the
            //     accusation, the counter and the suspension together;
            //   • the seat is still not restored, and that remains true in the
            //     one case where it was really lost: somebody pressed
            //     executeChainRemoval before the panel finished. Re-seating a
            //     removed arbiter is a different decision from arithmetic on a
            //     counter, and it is not this line's to make;
            //   • the bond is not returned in that same case, for the same
            //     reason and by the same silence.
            //
            // Named so that it stays a known gap rather than a silent one.
            if (alreadyOverturned) {
                // ⚠️ VINDICATION MUST REACH THE CHAIN'S OWN ACCUSATION, not
                // just the counter (task 12, trap 5, 18 August 2026) — and
                // since C-1 the reason is STRONGER than the arithmetic first
                // written here (review round 2).
                //
                // The old wording argued by numbers: the streak sits at 3, the
                // proof threshold is 2, so decrementing to 2 leaves the charge
                // "still provable". That is no longer how the button decides.
                // executeChainRemoval consults the RECORD and nothing else, so
                // the charge would survive the panel's verdict at ANY value of
                // the counter — decrementing it, zeroing it, none of it would
                // matter. Forty-eight hours later a passer-by presses, and the
                // very man the panel found right loses his seat. The button is
                // nobody's on purpose, so there would be no one to ask.
                //
                // Which is why the record itself has to go, and why this branch
                // is not a nicety: it is the only thing standing between a
                // vindication and a removal for the thing vindicated.
                //
                // He cannot even step aside: resignAsArbiter is barred by the
                // suspension AND by the live proposal, and withdrawing that
                // proposal belongs to the owner and the chief alone — otherwise
                // he waits out PROPOSAL_TTL, fourteen days.
                //
                // So the chain withdraws what the chain laid: proposal erased,
                // streak zeroed (same argument as withdrawal — a vindicated
                // arbiter must not stand one overturn away from being accused
                // again), suspension lifted.
                //
                // ⚠️ ONLY THE CHAIN'S OWN. A human accusation (`by` non-zero)
                // is untouched here: a panel deciding one dispute says nothing
                // about a collusion charge somebody else laid, and quashing it
                // would hand every accused arbiter a way to clear his record by
                // appealing an unrelated verdict.
                //
                // ⚠️ Known cost, named rather than papered over: the
                // suspension carries no provenance. If a chief suspended this
                // person for an unrelated reason AFTER the automatic path
                // fired, that suspension is lifted here too. Telling the two
                // apart needs a field the layout does not have, and leaving a
                // vindicated arbiter frozen was judged the worse of the two.
                // ⚠️ `_hasLiveProposalHere`, NOT `proposedAt != 0` (review round
                // 2 of task 12). The same defect as C-2 one door over, and it
                // was measured here too: a DEAD accusation, stale for a
                // fortnight and executable by nobody, wiped a streak of 3 down
                // to 0 in one go — flatly against the paragraph seven lines
                // above, which promises that ONE is subtracted — and announced
                // ChainAccusationCleared about a record that had stopped
                // meaning anything long before. Staleness has a home in this
                // file; every predicate that asks about a proposal goes through
                // it.
                if (_hasLiveProposalHere(d, slashedArbiter)
                    && d.removalProposals[slashedArbiter].by == address(0)) {
                    delete d.removalProposals[slashedArbiter];
                    delete d.chainProposalPath[slashedArbiter];
                    d.arbiterMistakeStreak[slashedArbiter] = 0;
                    d.suspendedUntil[slashedArbiter]       = 0;
                    emit ChainAccusationCleared(slashedArbiter, agreement);
                    // ⚠️ AND THE LIFT IS ANNOUNCED, not done in silence (review
                    // round 1 of task 12). Every other way a suspension ends
                    // says so — liftSuspension emits, and the 72 hours running
                    // out is visible because the deadline was in the log when it
                    // was set. This one erased the deadline instead, so a reader
                    // saw a suspension that never ended.
                    //
                    // `by` is the zero address: the panel decided, and no hand
                    // pressed anything here — same reading as everywhere else in
                    // these two facets.
                    //
                    // ⚠️ Known cost, named rather than papered over: the
                    // suspension carries no provenance, so a chief's later,
                    // unrelated suspension of the same person is lifted here
                    // too. Reviewed on 18 August 2026 and the field was
                    // REFUSED: every cheap discriminator produces false
                    // refusals, and a false refusal is the dearer mistake —
                    // it leaves a vindicated man locked in, while the chief who
                    // loses his mark simply sets it again. The log is what
                    // makes that bearable: he can see it happened.
                    emit ArbiterAccountabilityFacet.ArbiterSuspensionLifted(
                        slashedArbiter, address(0)
                    );
                } else {
                    // ⚠️ Underflow is reachable, not theoretical, and since
                    // task 12 the way in is exact: the accusation the third
                    // mistake laid was EXECUTED while this appeal was in
                    // flight, and _performRemoval zeroed the streak on the way
                    // out. raiseAppeal never asks whether the arbiter is still
                    // seated, so the vote lands on a counter with nothing left
                    // to take back. Withdrawal of the accusation reaches the
                    // same state by a different road. Guarded by
                    // test_VindicationAfterDemotionDoesNotUnderflowTheStreak.
                    uint256 streak = d.arbiterMistakeStreak[slashedArbiter];
                    if (streak > 0) d.arbiterMistakeStreak[slashedArbiter] = streak - 1;
                }
            } else {
                ReputationStorage.Data storage rep = ReputationStorage.data();
                _slashArbiterXP(rep, slashedArbiter);
                // `by` нулевой: resolveAppeal зовёт кто угодно, а решают ГОЛОСА.
                // Назвать нажавшего «подвести итог» виновником было бы худшей из
                // трёх возможных неправд.
                _recordArbiterMistake(d, rep, slashedArbiter, address(0), DemotionPath.AppealVote, agreement);
            }

            // Outside the branch: the appellant won the vote and gets his
            // deposit back whether or not this verdict had already been
            // overturned by hand. The deposit is the price of asking, not part
            // of the arbiter's penalty.
            bool refundOk = IUSDCFull(usdc).transfer(v.appellant, APPEAL_DEPOSIT);
            require(refundOk, "ArbiterRegistry: deposit refund failed");
        } else {
            d.vaultBalance += APPEAL_DEPOSIT;
        }

        emit AppealResolved(agreement, v.appellant, overturn);
    }

    // -------- REWARDS --------

    /// @notice Арбитр забирает накопленное вознаграждение.
    function withdrawArbiterReward() external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        uint256 amount = d.arbiterRewards[caller];
        if (amount == 0) revert NoRewardToClaim();

        d.arbiterRewards[caller] = 0;

        address usdc = FactoryStorage.store().usdc;
        bool ok = IUSDCFull(usdc).transfer(caller, amount);
        require(ok, "ArbiterRegistry: USDC transfer failed");

        emit ArbiterRewardWithdrawn(caller, amount);
    }

    /// @notice Зачислить сбор со спора. Агримент (Agreement.resolveDispute) зовёт
    /// эту функцию ДО перевода `total` на диамонд и переводит только если вызов
    /// не ревертнул — так провал зачисления не оставляет деньги на диамонде без
    /// единого счётчика, который на них указывает (см. Agreement.sol:resolveDispute).
    ///
    /// Почему не тянем сами через transferFrom: тогда агриментy пришлось бы
    /// выдавать разрешение, а при провале вызова оно осталось бы висеть — ровно
    /// тот дефект, который пришлось чинить в казне. Push-перевод (Agreement сам
    /// вызывает transfer(), диамонд не тянет через transferFrom) не оставляет
    /// разрешения вообще — это не зависит от того, что идёт первым, зачисление
    /// или перевод (сейчас первым идёт зачисление, см. комментарий выше).
    ///
    /// Доверие здесь ровно то же, что у updateStatus и notifyArbiterTimeout:
    /// вызывающий обязан быть зарегистрированным агриментом, а зарегистрировать
    /// может только фабрика.
    ///
    /// Аргумента-адреса арбитра НЕТ (и не было бы правильно его принимать):
    /// claimDispute() всегда ставит арбитром В АГРИМЕНТЕ сам диамонд
    /// (setArbiter(address(this)), Diamond-as-arbiter), поэтому Agreement.arbiter
    /// — это всегда 0 либо адрес диамонда, никогда не человек. Принять его
    /// параметром означало бы сжигать 80% каждого сбора на арбитра, у которого
    /// нет способа вызвать withdrawArbiterReward() от своего имени (тот читает
    /// _msgSender(), а заставить диамонд вызвать самого себя нечем).
    ///
    /// Источник настоящего арбитра — pendingVerdicts[msg.sender].arbiter, а НЕ
    /// disputeClaims[msg.sender]. Оба поля пишутся синхронно (submitVerdict
    /// требует caller == disputeClaims[agreement]) и до финализации не могут
    /// разойтись — но на момент, когда Agreement (Задача 3) реально вызовет эту
    /// функцию (изнутри finalizeVerdict → agreement.call(resolveDispute)),
    /// гарантия у pendingVerdicts сильнее: finalizeVerdict уже требует
    /// v.submittedAt != 0 (иначе revert NoVerdict до вызова) и держит
    /// v.executing = true всё время внешнего вызова — именно executing==true
    /// не даёт clearDisputeClaim() удалить pendingVerdicts в этом окне (это не
    /// единственное место, которое умеет удалить запись — clearStuckVerdict
    /// делает то же самое БЕЗ проверки !v.executing; его гейт
    /// require(status != DISPUTED) сам по себе здесь не защита — resolvedAt
    /// уже выставлен к этому моменту (Agreement.sol:665, до вызова), поэтому
    /// status() внутри этого окна уже вернул бы RESOLVED, а не DISPUTED, и
    /// gate его бы ПРОПУСТИЛ. Вклиниться невозможно по другой причине: всё
    /// окно — от resolvedAt до этого вызова — лежит внутри одной атомарной
    /// транзакции (finalizeVerdict → agreement.call(resolveDispute) →
    /// creditDisputeFee), а clearStuckVerdict — отдельный вызов от owner,
    /// которому просто негде исполниться между шагами чужой транзакции).
    /// disputeClaims такой защиты не имеет: clearDisputeClaim() чистит его
    /// безусловно, так что его целостность здесь зависела бы от того, что
    /// Agreement переведёт сбор и позовёт нас строго до _clearDisputeClaim() —
    /// то есть от порядка кода в чужой функции, а не от инварианта здесь.
    /// pendingVerdicts.arbiter не зависит от этого порядка ни при каком раскладе.
    function creditDisputeFee(uint256 total) external {
        if (RegistryStorage.store().agreements[msg.sender].client == address(0))
            revert NotRegisteredAgreement();
        if (total == 0) revert ZeroAmount();

        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        ArbiterRegistryStorage.PendingVerdict storage v = d.pendingVerdicts[msg.sender];

        address arbiter_ = v.arbiter;
        // Спор никто не довёл до вердикта (submitVerdict не звали) — зачислять
        // некому, молчать нельзя: деньги без адресата зависли бы в контракте
        // без единого счётчика, который на них указывает.
        if (arbiter_ == address(0)) revert NoVerdictSubmitted();

        uint256 toArbiter;
        uint256 toTreasury;
        if (v.overturned) {
            // Вердикт отменён (overturnVerdict/resolveAppeal) — арбитр ошибся,
            // награды не будет, весь сбор идёт в казну. Симметрично тому, что
            // finalizeVerdict при overturned не отдаёт арбитру и доплату, а
            // возвращает её плательщику через refundableBounty (см. блок
            // возврата доплаты внутри finalizeVerdict, выше по файлу).
            // Прежняя ссылка вела на выплату из банка за спор — того блока нет
            // с коммита a9c9095, плоскую выплату сняли целиком.
            toTreasury = total;
        } else {
            toArbiter = (total * ARBITER_SHARE_BPS) / 10_000;
            // Вычитанием, а не второй долей: так ни один юнит не теряется на
            // округлении и части всегда складываются в целое.
            toTreasury = total - toArbiter;
        }

        d.arbiterRewards[arbiter_] += toArbiter;
        d.treasurySlice            += toTreasury;

        emit DisputeFeeCredited(arbiter_, toArbiter, toTreasury);
    }

    /// @notice Отправить накопленную долю казны текущему получателю комиссий.
    ///
    /// Открытая намеренно: деньги уходят только на адрес из
    /// FactoryStorage.feeRecipient, поэтому право вызова ничего не решает, а
    /// открытость означает, что выплата не зависит от того, помнит ли о ней
    /// владелец, и её может протолкнуть кипер.
    function withdrawTreasurySlice() external {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        uint256 slice = d.treasurySlice;
        if (slice == 0) revert NothingToPush();

        d.treasurySlice = 0;

        FactoryStorage.Layout storage fs = FactoryStorage.store();
        address recipient = fs.feeRecipient;
        bool ok = IUSDCFull(fs.usdc).transfer(recipient, slice);
        require(ok, "ArbiterRegistry: treasury slice transfer failed");

        emit TreasurySlicePushed(recipient, slice);
    }

    function getTreasurySlice() external view returns (uint256) {
        return ArbiterRegistryStorage.data().treasurySlice;
    }

    /// @notice Пополнить банк арбитров. Кроме владельца это может сделать
    /// текущий получатель комиссий (`FactoryStorage.feeRecipient`) — им
    /// становится казна, когда её подставляют вызовом `setFeeRecipient`.
    ///
    /// Отдельного поля под адрес казны намеренно нет: источник правды один,
    /// и замена казны переносит это право автоматически, забыть нечего.
    /// Если получатель комиссий — обычный кошелёк (как было до казны), он
    /// получает право положить в банк свои деньги. Это пожертвование, не риск.
    function fundVault(uint256 amount) external {
        if (msg.sender != OwnershipLib.contractOwner()
            && msg.sender != FactoryStorage.store().feeRecipient) revert NotOwnerOrFeeRecipient();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        address usdc = FactoryStorage.store().usdc;
        bool ok = IUSDCFull(usdc).transferFrom(msg.sender, address(this), amount);
        require(ok, "ArbiterRegistry: USDC transfer failed");
        d.vaultBalance += amount;
        emit VaultFunded(msg.sender, amount);
    }

    /// @notice Отключён 31 июля 2026. Плоская выплата из банка отвергнута
    /// дизайном 28 июля (§7), но код за ним не пошёл: начисление жило
    /// параллельно с 80% сбора и включалось одним вызовом владельца. С
    /// появлением доплаты источников стало бы три.
    ///
    /// Функция не удалена, а ревертит: восемь исторических скриптов в script/
    /// ссылаются на её селектор в списках монтирования, forge build собирает
    /// всю папку, и удаление развалило бы сборку. Эти скрипты — записи о
    /// произошедших апгрейдах, а broadcast/ в гитигноре, поэтому их исходники
    /// единственная оставшаяся запись. Ревертящий сеттер честнее рабочего,
    /// который пишет значение, которого никто не читает.
    function setRewardPerDispute(uint256) external pure {
        revert RewardPathRetired();
    }

    /// @notice Сколько арбитр должен получить за спор суммарно.
    /// Хранимое поле, а не константа: правильную цену человеческого времени
    /// нельзя угадать заранее, а менять её потом надо одной транзакцией, без
    /// апгрейда. Старт — 10 USDC.
    function setArbiterFloor(uint256 amount) external onlyOwner {
        ArbiterRegistryStorage.data().arbiterFloor = amount;
        emit ArbiterFloorUpdated(amount);
    }

    // -------- ПЛАТНЫЙ ВЫЗОВ АРБИТРА: ОПЛАТА И ВОЗВРАТ --------

    /// @notice Доплатить до порога, чтобы арбитр взялся за спор.
    ///
    /// Строить отдельный «вызов арбитра» не требуется: добровольный клейм уже
    /// работает, он просто не срабатывает на мелком котле. Деньги на кону —
    /// единственное, чего ему не хватает.
    ///
    /// Платит сторона, которой нужен судья, а не общий банк. Это и есть защита
    /// от фарма: подставить своего арбитра означает заплатить самому себе.
    ///
    /// Отправителя берём через _msgSender(), а не msg.sender: фронт зовёт эту
    /// функцию ТОЛЬКО через ERC-2771-форвардер (frontend/src/lib/relay.ts),
    /// и на этом пути msg.sender — адрес форвардера. С прямым msg.sender
    /// проверка стороны отвергала бы каждую оплату, а плательщиком в
    /// хранилище и в событии оказывался бы форвардер, а не человек.
    function fundDispute(address agreement) external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();

        RegistryStorage.AgreementRecord storage rec = RegistryStorage.store().agreements[agreement];
        if (rec.client == address(0)) revert NotAuthorized();
        if (caller != rec.client && caller != rec.executor) revert NotParty();

        if (d.disputeClaims[agreement] != address(0)) revert DisputeAlreadyClaimed();
        if (d.disputeBounty[agreement] != 0) revert BountyAlreadyFunded();

        uint256 need = quoteDisputeTopUp(agreement); // ревертит NotDisputed, если спора нет

        // Тот же гейт, что в claimDispute (проверка DisputeWindowPassed после
        // disputedAt()/DISPUTE_WINDOW()), и то же сравнение:
        // после disputedAt + DISPUTE_WINDOW спор нельзя ни заклеймить, ни
        // отсудить (submitVerdict тоже бьёт DisputeWindowPassed), и статус
        // остаётся DISPUTED, пока кто-нибудь не дёрнет таймаут. Принимать
        // деньги за судью, которого уже физически не может быть, нельзя:
        // они не потеряются (вернутся на таймауте), но замрут до чужого
        // действия, а услуга не будет оказана вовсе.
        (bool dOk, bytes memory dData) = agreement.staticcall(abi.encodeWithSignature("disputedAt()"));
        require(dOk, "ArbiterRegistry: disputedAt read failed");
        (bool wOk, bytes memory wData) = agreement.staticcall(abi.encodeWithSignature("DISPUTE_WINDOW()"));
        require(wOk, "ArbiterRegistry: DISPUTE_WINDOW read failed");
        if (block.timestamp > abi.decode(dData, (uint256)) + abi.decode(wData, (uint256))) {
            revert DisputeWindowPassed();
        }

        if (need == 0) revert TopUpNotNeeded();

        d.disputeBounty[agreement]      = need;
        d.disputeBountyPayer[agreement] = caller;

        address usdc = FactoryStorage.store().usdc;
        bool ok = IUSDCFull(usdc).transferFrom(caller, address(this), need);
        require(ok, "ArbiterRegistry: bounty transfer failed");

        emit DisputeBountyFunded(agreement, caller, need);
    }

    function getDisputeBounty(address agreement) external view returns (uint256) {
        return ArbiterRegistryStorage.data().disputeBounty[agreement];
    }

    /// @notice Забрать доплату, которую не удалось вернуть толчком.
    /// Существует ради чёрных списков USDC: возврат внутри clearDisputeClaim
    /// намеренно мягкий, потому что тот путь обёрнут в проглатывающий catch.
    ///
    /// _msgSender(), а не msg.sender, по той же причине, что и в fundDispute:
    /// вызов приходит через форвардер, и на прямом msg.sender человек забирал
    /// бы не свой остаток, а (всегда нулевой) остаток форвардера.
    function withdrawDisputeBounty() external {
        address caller = _msgSender();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        uint256 amount = d.refundableBounty[caller];
        if (amount == 0) revert NoRefundableBounty();
        d.refundableBounty[caller] = 0;
        address usdc = FactoryStorage.store().usdc;
        bool ok = IUSDCFull(usdc).transfer(caller, amount);
        require(ok, "ArbiterRegistry: bounty withdrawal failed");
        emit DisputeBountyWithdrawn(caller, amount);
    }

    function getRefundableBounty(address who) external view returns (uint256) {
        return ArbiterRegistryStorage.data().refundableBounty[who];
    }

    /// До активации ДАО назначает владелец (называет преемника заранее —
    /// activateDAO() требует, чтобы daoAddress уже был ненулевым). После
    /// активации меняет только уже действующий daoAddress сам себя
    /// (самомиграция) — НЕ через `onlyOwner`: тот пустил бы владельца назад
    /// в дверь, которую он якобы навсегда закрыл (найдено ревью, C-3, круг
    /// правок 1, 15 августа 2026). Без этого гейта owner мог бы вернуть себе
    /// removeArbiterForCause одной лишней транзакцией:
    /// activateDAO() → setDAOAddress(свой_адрес) → снос по ветке
    /// msg.sender == daoAddress.
    ///
    /// ⚠️ Храповик защёлкивается только когда `d.daoAddress != address(0)` —
    /// это НЕ то же самое, что просто `isDaoActive()` (найдено ревью, круг
    /// правок 2, 15 августа 2026, стык C-3×M-9). isDaoActive() включается САМА
    /// по заработанному порогу (uniqueActiveUsers >= DAO_THRESHOLD), в обход
    /// activateDAO() — а значит и в обход его защиты DaoAddressNotSet, которая
    /// стоит ТОЛЬКО внутри activateDAO(). Если ДАО включилась заработанным
    /// путём при ещё нулевом daoAddress, а храповик слушал бы один
    /// isDaoActive(), «звать может только текущий daoAddress» превращалось бы
    /// в «звать может только address(0)» — то есть никто и никогда: обе
    /// двери (посадка через SeatingHandedOver и снос через
    /// removeArbiterForCause, обе завязанные на daoAddress) осиротели бы
    /// необратимо, единственный выход — замена фасета diamondCut'ом.
    /// Условие `&& d.daoAddress != address(0)` держит владельца в игре ровно
    /// до тех пор, пока преемника физически некому передать право.
    ///
    /// Правка НЕ в isDaoActive() (соблазн, но нельзя): его же читает
    /// src/Treasury.sol для выбора пропорции распределения дохода, а казна
    /// уже развёрнута в цепи и неизменяема — сдвиг момента «ДАО наступила»
    /// сдвинул бы деньги. Отдельное решение владельца, не побочный эффект
    /// этой правки.
    function setDAOAddress(address dao) external {
        if (dao == address(0)) revert ArbiterZeroAddress();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        if (isDaoActive() && d.daoAddress != address(0)) {
            if (msg.sender != d.daoAddress) revert NotCurrentDaoAddress();
        } else {
            if (msg.sender != OwnershipLib.contractOwner()) revert NotOwner();
        }
        d.daoAddress = dao;
        emit DAOAddressSet(dao);
    }

    // -------- AGREEMENT CALLBACKS --------

    function clearDisputeClaim(address agreement) external {
        require(msg.sender == agreement, "ArbiterRegistry: only agreement");
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        address claimedArbiter = d.disputeClaims[agreement];
        if (claimedArbiter != address(0)) {
            // Якорь и запись о молчании не трогаются — см. releaseDisputeClaim.
            delete d.disputeClaims[agreement];
            if (d.openClaimCount[claimedArbiter] > 0) d.openClaimCount[claimedArbiter]--;
        }
        // Авто-очистка застрявшего вердикта: если Agreement вышел из спора через таймаут,
        // а вердикт ещё не финализирован и не исполняется прямо сейчас — удаляем.
        ArbiterRegistryStorage.PendingVerdict storage v = d.pendingVerdicts[agreement];
        if (v.submittedAt > 0 && !v.finalized && !v.executing) {
            delete d.pendingVerdicts[agreement];
            emit StuckVerdictAutoCleared(agreement);
        }

        // Возврат доплаты, если вердикта не случилось.
        //
        // Различитель уже существует и второго заводить не надо: finalizeVerdict
        // выставляет v.executing перед вызовом resolveDispute и снимает после, а
        // v.finalized ставит ПОЗЖЕ внешнего вызова — то есть здесь он ещё false.
        // Значит executing == true означает «мы внутри финализации вердикта», и
        // выставлен он только на этом пути; на обеих ветках таймаута он false.
        //
        // Продавать то, чего нельзя гарантировать, хуже, чем не продавать:
        // заплатил и не получил ни судьи, ни денег — это уже не услуга.
        if (!v.executing) {
            // Счётчик обоим: спор кончился, судить было некому или некогда.
            // Пишем напрямую в namespaced-хранилище репутации — тот же приём,
            // которым этот файл уже сбрасывает XP при демоушене
            // (_recordArbiterMistake).
            RegistryStorage.AgreementRecord storage rec = RegistryStorage.store().agreements[agreement];
            if (rec.client != address(0)) {
                ReputationStorage.Data storage rep = ReputationStorage.data();
                rep.unresolvedDisputes[rec.client]   += 1;
                rep.unresolvedDisputes[rec.executor] += 1;
            }

            uint256 bounty = d.disputeBounty[agreement];
            if (bounty > 0) {
                address payer = d.disputeBountyPayer[agreement];
                d.disputeBounty[agreement] = 0;
                delete d.disputeBountyPayer[agreement];

                // Мягкий возврат. Жёсткий здесь недопустим: Agreement зовёт эту
                // функцию внутри `try {} catch {}` с пустым обработчиком
                // (Agreement.sol:1286), поэтому реверт перевода утащил бы за собой
                // снятие клейма и уменьшение openClaimCount — молча, и арбитр
                // остался бы навсегда с незакрытым спором.
                //
                // Длину ответа проверяем явно, тем же приёмом, что и
                // SafeUSDC.trySafeTransfer (Agreement.sol:215-225): abi.decode
                // на ответе от 1 до 31 байта сам паникует, и тогда «мягкий»
                // возврат оказался бы таким же жёстким, как обычный, ровно в
                // ветке, которую мы делаем мягкой намеренно.
                address usdc = FactoryStorage.store().usdc;
                (bool ok, bytes memory ret) = usdc.call(
                    abi.encodeWithSelector(IUSDCFull.transfer.selector, payer, bounty)
                );
                bool delivered;
                if (ok) {
                    if (ret.length == 0) delivered = true;
                    else if (ret.length >= 32) delivered = abi.decode(ret, (bool));
                    // ret.length в 1..31 — delivered остаётся false, decode не зовём.
                }
                if (delivered) {
                    emit DisputeBountyRefunded(agreement, payer, bounty);
                } else {
                    d.refundableBounty[payer] += bounty;
                    emit DisputeBountyRefundable(agreement, payer, bounty);
                }
            }
        }
    }

    /// @notice Аварийная очистка застрявшего pending verdict.
    /// Возникает когда triggerArbiterTimeout исполняет Agreement до finalizeVerdict —
    /// Agreement уходит в REFUNDED, а pendingVerdicts остаётся висеть навечно.
    function clearStuckVerdict(address agreement) external {
        if (msg.sender != OwnershipLib.contractOwner()) revert NotOwner();
        if (agreement == address(0)) revert ArbiterZeroAddress();
        // Убеждаемся что Agreement уже в терминальном состоянии (не DISPUTED = 4)
        (bool ok, bytes memory st) = agreement.staticcall(abi.encodeWithSignature("status()"));
        require(ok, "ArbiterRegistry: status read failed");
        require(abi.decode(st, (uint8)) != 4, "ArbiterRegistry: agreement still disputed");
        delete ArbiterRegistryStorage.data().pendingVerdicts[agreement];
    }

    // -------- VIEWS --------
    //
    // ⚠️ ГРАНИЦА С ArbiterAccountabilityFacet (задача 4.5, 16 августа 2026).
    // Фасет упёрся в потолок EIP-170: 24 516 байт из 24 576, свободно 60. Любая
    // следующая правка реестра физически не влезала бы. Четырнадцать ЧТЕНИЙ
    // уехали в соседний фасет, который держит тот же ArbiterRegistryStorage и
    // тот же POSITION, — снаружи даймонда перенос не виден вовсе: тот же адрес,
    // тот же селектор, тот же ответ, меняется только строка в таблице маршрутов.
    //
    // Граница проведена по смыслу, а не по размеру:
    //   уехало  — чтения про ПОВЕДЕНИЕ арбитра, его ПОЛОЖЕНИЕ и ДОКАЗАТЕЛЬСТВА
    //             (счётчики ошибок и чистых вердиктов, залог, споры в руках,
    //             провенанс посадки, награда, послужной список сделок, ключи
    //             чата, якорь предъявления, запись о молчании, отпечатки);
    //   осталось — реестр как ХОЗЯИН СОСТАВА, СПОРОВ, ВЕРДИКТОВ и АПЕЛЛЯЦИЙ
    //             (getArbiters, isRegisteredArbiter, getChiefArbiter,
    //             getDisputeClaimer, getClaimCommitment, getPendingVerdict,
    //             hasSubmittedVerdict, getAppealVotes, hasVotedOnAppeal, деньги
    //             спора и банка).
    //
    // ⚠️ ЧЕТЫРЕ ГЕТТЕРА КОНСТАНТ НЕ УЕХАЛИ, И ЭТО НЕ НЕДОСМОТР.
    // getMinXPToRegister, getNoResponseFloor, getMaxArbiterMistakes,
    // getMaxClaimsPerArbiter читают ПРИВАТНЫЕ КОНСТАНТЫ ЭТОГО ФАСЕТА, которые
    // применяет остающийся здесь код (applyAsArbiter :851, recordNoResponse
    // :1327, _recordArbiterMistake, claimDispute). Переезд геттера потребовал бы
    // ВТОРОГО ОБЪЯВЛЕНИЯ числа в соседнем файле — и тогда наружу отвечало бы
    // зеркало, а боевое правило применялось бы по оригиналу. Ровно тот класс,
    // что этот план ловит весь: getMaxArbiterMistakes, переехав, превратил бы
    // test_MistakeThresholdMatchesRegistry в сверку зеркала с самим собой.
    // Понадобятся эти байты — константу переносят в ArbiterRegistryStorage
    // ОДНИМ объявлением на оба фасета, как уже сделано с SUSPENSION_WINDOW; это
    // отдельная работа, здесь не сделана.
    //
    // Три чтения не уехали по другой причине — их зовут ИЗНУТРИ: isDaoActive
    // (модификатор onlyOwnerOrChief), getArbiterFloor (из quoteDisputeTopUp),
    // quoteDisputeTopUp (из fundDispute). Плюс getChiefBloc — она зовёт
    // приватную _chiefBloc, которую держит addArbiter, и переезд стоил бы
    // второй копии тела.

    function isDaoActive() public view returns (bool) {
        if (ArbiterRegistryStorage.data().daoActiveManual) return true;
        return ReputationStorage.data().uniqueActiveUsers >= DAO_THRESHOLD;
    }

    function getMinXPToRegister() external pure returns (uint256) { return MIN_XP_TO_REGISTER; }
    function getDaoThreshold()    external pure returns (uint256) { return DAO_THRESHOLD; }

    /// MAX_ARBITER_MISTAKES прочитанное с этой стороны. Совпадает с
    /// ArbiterAccountabilityFacet.MISTAKE_THRESHOLD и обязано совпадать — одно
    /// и то же правило серии судейских ошибок, читаемое двумя фасетами.
    /// Сверяется test_MistakeThresholdMatchesRegistry.
    function getMaxArbiterMistakes() external pure returns (uint256) { return MAX_ARBITER_MISTAKES; }

    function getChiefArbiter()  external view returns (address) { return ArbiterRegistryStorage.data().chiefArbiter; }
    function isRegisteredArbiter(address addr) external view returns (bool) { return ArbiterRegistryStorage.data().isArbiter[addr]; }
    function getArbiters()      external view returns (address[] memory) { return ArbiterRegistryStorage.data().arbiterList; }
    function getDisputeClaimer(address agreement) external view returns (address) { return ArbiterRegistryStorage.data().disputeClaims[agreement]; }

    // getDisputeClaimedAt / getNoResponseAt переехали в ArbiterAccountabilityFacet
    // (задача 4.5, 16 августа 2026) — доказательства поведения арбитра. Здесь
    // остаётся getNoResponseFloor: он читает приватную константу NO_RESPONSE_FLOOR,
    // которую применяет recordNoResponse (:1327) в этом же файле, и переезд
    // потребовал бы второго объявления числа. Разбор — в шапке VIEWS ниже.

    /// @notice Сколько должно пройти от взятия спора до записи о молчании.
    /// Фронт обязан спрашивать здесь, а не держать своё число (замысел 5.2).
    function getNoResponseFloor() external pure returns (uint256) {
        return NO_RESPONSE_FLOOR;
    }

    // getPresentationDigests / getPresentationDigestsPage /
    // getPresentationDigestCount / getArbiterChatKeys / getArbiterDeals переехали
    // в ArbiterAccountabilityFacet (задача 4.5, 16 августа 2026). Записи в этом
    // файле (recordPresentationDigest, setArbiterChatKey) остались — уехали
    // только чтения.

    function getClaimCommitment(bytes32 c) external view returns (uint256) { return ArbiterRegistryStorage.data().claimCommitments[c]; }

    function getPendingVerdict(address agreement) external view returns (ArbiterRegistryStorage.PendingVerdict memory) {
        return ArbiterRegistryStorage.data().pendingVerdicts[agreement];
    }

    function getVaultBalance()  external view returns (uint256) { return ArbiterRegistryStorage.data().vaultBalance; }
    /// @notice Путь снят 31 июля 2026 (см. setRewardPerDispute) — поле, которое
    /// эта функция читает, больше никто не пишет, значение всегда 0.
    function getRewardPerDispute() external view returns (uint256) { return ArbiterRegistryStorage.data().rewardPerDispute; }
    function getDAOAddress()    external view returns (address) { return ArbiterRegistryStorage.data().daoAddress; }

    /// @notice Публичная (не external), потому что quoteDisputeTopUp зовёт её
    /// напрямую — дефолт при нуле подставляется в одном месте, а не в двух.
    function getArbiterFloor() public view returns (uint256) {
        uint256 f = ArbiterRegistryStorage.data().arbiterFloor;
        return f == 0 ? DEFAULT_ARBITER_FLOOR : f;
    }
    function hasSubmittedVerdict(address agreement) external view returns (bool) {
        return ArbiterRegistryStorage.data().pendingVerdicts[agreement].submittedAt != 0;
    }
    function getAppealVotes(address agreement) external view returns (uint256 uphold, uint256 overturnVotes) {
        ArbiterRegistryStorage.PendingVerdict storage v = ArbiterRegistryStorage.data().pendingVerdicts[agreement];
        return (v.votesUphold, v.votesOverturn);
    }

    function hasVotedOnAppeal(address agreement, address arbiterAddr) external view returns (bool) {
        return ArbiterRegistryStorage.data().hasVotedAppeal[agreement][arbiterAddr];
    }
    /// @notice Сколько надо доплатить, чтобы арбитр суммарно получил порог.
    /// Возвращает 0, если котёл и так достаточно велик — тогда кнопку доплаты
    /// показывать не надо вовсе.
    ///
    /// Сбор берётся У СДЕЛКИ вызовом disputeFee(), а не пересчитывается здесь.
    /// Формула сбора (3% с потолком) живёт в Agreement, и вторая копия в
    /// фасете разошлась бы с ней при первой же правке — молча, потому что
    /// расхождение видно только тому, кто сравнит показанное число с пришедшим
    /// на кошелёк.
    function quoteDisputeTopUp(address agreement) public view returns (uint256) {
        (bool statusOk, bytes memory statusData) = agreement.staticcall(
            abi.encodeWithSignature("status()")
        );
        require(statusOk, "ArbiterRegistry: failed to read status");
        if (abi.decode(statusData, (uint8)) != 4) revert NotDisputed();

        (bool feeOk, bytes memory feeData) = agreement.staticcall(
            abi.encodeWithSignature("disputeFee()")
        );
        require(feeOk, "ArbiterRegistry: failed to read dispute fee");
        uint256 fee = abi.decode(feeData, (uint256));

        uint256 arbiterGets = (fee * ARBITER_SHARE_BPS) / 10_000;
        uint256 floor_ = getArbiterFloor();

        return arbiterGets >= floor_ ? 0 : floor_ - arbiterGets;
    }

    // getSeatedBy / getSeatedCountBy переехали в ArbiterAccountabilityFacet
    // (задача 4.5, 16 августа 2026) — провенанс посадки. Запись провенанса
    // (addArbiter, clearSeat) осталась здесь; уехало только чтение. Скрипт
    // разреза читает их ЧЕРЕЗ ДАЙМОНД, поэтому миграция провенанса не
    // затронута — адрес один и тот же.

    /// @notice Текущий блок директора: сколько голосов на апелляции достались
    /// бы ему, если бы все посаженные им арбитры и он сам (если он тоже
    /// арбитр) проголосовали заодно.
    ///
    /// Охраняемое свойство — «директор не РЕШАЕТ апелляцию», не «не набирает
    /// кворум» (п. 67, 16 августа 2026). resolveAppeal подводит итог простым
    /// большинством поданных голосов, как только их набралось APPEAL_MIN_VOTES:
    /// при трёх поданных решают два. addArbiter не даёт этому числу дорасти до
    /// решающего большинства для посадок директора, то есть держит его на
    /// единице.
    ///
    /// ⚠️ Чего это НЕ даёт и не обещает: при большом корпусе кворум остаётся
    /// АБСОЛЮТНОЙ тройкой, и любые трое сговорившихся решают всё — потолок
    /// считает только людей директора и таких троих не касается. Привязка
    /// кворума к размеру корпуса — отдельная работа, здесь не сделана.
    function getChiefBloc() external view returns (uint256) {
        return _chiefBloc(ArbiterRegistryStorage.data());
    }

    /// @notice Потолок споров, которые арбитр может держать одновременно.
    /// Единственное место, где число объявлено — фронт обязан читать через
    /// эту функцию, а не держать копию.
    function getMaxClaimsPerArbiter() external pure returns (uint256) {
        return MAX_CLAIMS_PER_ARBITER;
    }

    // getCleanVerdicts переехал в ArbiterAccountabilityFacet (задача 4.5,
    // 16 августа 2026) — счётчик чистых вердиктов. Пишет его finalizeVerdict
    // в этом файле, читают отсюда только снаружи.
}
