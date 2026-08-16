// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Отпечаток предъявления в цепи (4в-2 Выкатка 2, Задача 3).
//
// Цепь не видит нашего склада и содержание предъявления проверить не может
// ничем. Смысл отпечатка не в содержании, а в ПОРЯДКЕ: 32 байта легли на блоке
// N, запись арбитра «просил — ответа нет» на блоке M. Если M > N, слово арбитра
// опровергнуто цепью, и доверия к нашему серверу для этого не нужно.
//
// Отсюда два свойства, которые здесь сторожатся:
//   1. Класть может ТОЛЬКО сторона спора. Иначе посторонний засыпал бы ленту
//      чужой сделки отпечатками, и «сторона предъявляла» перестало бы что-либо
//      значить.
//   2. Отпечаток НЕ запрещает запись о молчании (замысел 2.11). Жёсткий запрет
//      дал бы стороне щит: положил отпечаток пустышки — и неуязвим.
//
// ⚠️ Время здесь берётся ТОЛЬКО через vm.getBlockTimestamp() — по той же
// причине, что и в test/DisputeNoResponse.t.sol: под via_ir solc считает
// TIMESTAMP неизменным внутри вызова, и второй `vm.warp(block.timestamp + …)`
// в одном теле теста прыгает в ту же секунду, что и первый (docs/OPEN-ITEMS.md
// п. 57).
//
// Сетап — тот же лёгкий, что у test/DisputeNoResponse.t.sol: фасет развёрнут
// отдельно, настоящего диамонда не нужно. Одно отличие обязательно:
// recordPresentationDigest читает стороны из СВОЕГО RegistryStorage, поэтому
// запись о сделке в реестр класть надо, и мимо неё тесты не поедут. Реестр
// заполняется прямой записью в слоты (боевой путь — RegistryFacet.register(),
// он заперт за authorizedFactory и живёт в другом фасете), а смещения слотов
// не берутся на веру: их сторожит test_RegistrySlotOffsets_MatchLiveStorage
// чужим, написанным до этой задачи кодом.

import "forge-std/Test.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";
import {ArbiterAccountabilityFacet} from "../src/facets/ArbiterAccountabilityFacet.sol";
import {ArbiterTwoFacetBench} from "./ArbiterTwoFacetBench.sol";
import {RegistryStorage} from "../src/RegistryFacet.sol";
import {FactoryStorage} from "../src/FactoryFacet.sol";
import {MinimalForwarder} from "../src/MinimalForwarder.sol";

contract PresentationDigestTest is Test, ArbiterTwoFacetBench {
    /// Оба хендла указывают на ОДИН адрес — прокси с обоими фасетами
    /// (см. test/ArbiterTwoFacetBench.sol). `facet` оставлен под прежним
    /// именем нарочно: все vm.store(address(facet), ...) ниже продолжают
    /// бить в то же самое хранилище.
    ArbiterRegistryFacet facet;
    ArbiterAccountabilityFacet accFacet;

    address client;
    address executor;
    address stranger;
    address arbiter;
    address agreement;

    /// База неймспейса ArbiterRegistryStorage — ArbiterRegistryStorage.POSITION.
    bytes32 constant ARB_BASE = 0xaae71de0594cbcb5434f0ab7f7501c1be178552bf788b418a1c2624ba9718d00;

    /// Смещение слота `agreements` (первое поле RegistryStorage.Layout) от базы
    /// неймспейса реестра. Внутри записи AgreementRecord: agreement(+0),
    /// client(+1), executor(+2).
    ///
    /// ⚠️ `forge inspect ArbiterRegistryFacet storage-layout` здесь молчит и
    /// молчать будет: у фасета нет ни одной обычной state-переменной, всё
    /// хранилище namespaced и достаётся assembly. Числа ниже добыты замером и
    /// замером же сторожатся — см. test_RegistrySlotOffsets_MatchLiveStorage.
    uint256 constant SLOT_REGISTRY_AGREEMENTS = 0;
    uint256 constant REC_OFFSET_CLIENT   = 1;
    uint256 constant REC_OFFSET_EXECUTOR = 2;

    function setUp() public {
        (facet, accFacet) = _deployArbiterBench();

        client   = address(0xC1);
        executor = address(0xE1);
        stranger = address(0x5A);
        arbiter  = address(0xA1);

        _makeArbiter(arbiter);
        agreement = address(new MockDisputedAgreementPD(client, executor));
        _registerAgreement(agreement, client, executor);
    }

    // ============================================================
    //  КТО МОЖЕТ КЛАСТЬ ОТПЕЧАТОК
    // ============================================================

    function test_PartyRecordsDigest() public {
        bytes32 digest = keccak256(unicode"предъявление один");

        vm.expectEmit(true, true, false, true, address(facet));
        emit ArbiterRegistryFacet.PresentationDigestRecorded(agreement, client, digest, 0);

        vm.prank(client);
        facet.recordPresentationDigest(agreement, digest);

        bytes32[] memory all = accFacet.getPresentationDigests(agreement);
        assertEq(all.length, 1, unicode"отпечаток обязан лечь в цепь");
        assertEq(all[0], digest, unicode"в цепь обязаны лечь те самые 32 байта, что подписаны");
    }

    /// Исполнитель — такая же сторона спора, как клиент. Предъявляет чаще
    /// именно он: спор обычно про то, сделана ли работа.
    function test_ExecutorIsAlsoAParty() public {
        vm.prank(executor);
        facet.recordPresentationDigest(agreement, keccak256(unicode"работа сдана"));
        assertEq(
            accFacet.getPresentationDigestCount(agreement),
            1,
            unicode"исполнитель — сторона спора и предъявлять обязан мочь"
        );
    }

    function test_ManyDigestsFit() public {
        vm.startPrank(client);
        facet.recordPresentationDigest(agreement, keccak256(unicode"раз"));
        facet.recordPresentationDigest(agreement, keccak256(unicode"два"));
        vm.stopPrank();
        assertEq(
            accFacet.getPresentationDigestCount(agreement),
            2,
            unicode"переписка не влезает в один мешок — предъявлений столько, сколько нужно (2.7)"
        );
    }

    /// Порядок — единственное, ради чего вся запись существует, поэтому список
    /// обязан отдаваться в порядке появления, а индекс в событии — совпадать с
    /// местом в списке. Без этого «отпечаток лёг раньше записи о молчании»
    /// нечем предъявить: лента и хранилище разошлись бы.
    function test_DigestsKeepOrderAndIndex() public {
        bytes32 first  = keccak256(unicode"первое");
        bytes32 second = keccak256(unicode"второе");

        vm.prank(client);
        facet.recordPresentationDigest(agreement, first);

        vm.expectEmit(true, true, false, true, address(facet));
        emit ArbiterRegistryFacet.PresentationDigestRecorded(agreement, executor, second, 1);
        vm.prank(executor);
        facet.recordPresentationDigest(agreement, second);

        bytes32[] memory all = accFacet.getPresentationDigests(agreement);
        assertEq(all.length, 2, unicode"оба отпечатка обязаны остаться");
        assertEq(all[0], first,  unicode"первым в списке обязан быть первый положенный");
        assertEq(all[1], second, unicode"порядок в списке — это и есть то, что доказывается");
    }

    function test_StrangerCannotRecord() public {
        vm.prank(stranger);
        vm.expectRevert(ArbiterRegistryFacet.NotDisputeParty.selector);
        facet.recordPresentationDigest(agreement, keccak256(unicode"чужое"));
    }

    /// Арбитр, взявший спор, стороной не становится: его дело — читать
    /// предъявления, а не подкладывать свои. Сцена отдельная от «постороннего»
    /// намеренно — арбитр единственный, у кого есть законный повод трогать эту
    /// сделку, и именно про него читатель спросит «а он-то может?».
    function test_ArbiterIsNotAParty() public {
        _claimBy(arbiter, agreement);
        vm.prank(arbiter);
        vm.expectRevert(ArbiterRegistryFacet.NotDisputeParty.selector);
        facet.recordPresentationDigest(agreement, keccak256(unicode"судейское"));
    }

    /// Адрес, которого нет в нашем реестре. Без этой проверки любой развернул
    /// бы свой контракт, назвал себя его стороной и наполнял бы ленту
    /// «предъявлениями» по сделке, которой у нас никогда не было.
    function test_UnknownAgreementRejected() public {
        address foreign = address(new MockDisputedAgreementPD(client, executor));
        vm.prank(client);
        vm.expectRevert(ArbiterRegistryFacet.NotDisputeParty.selector);
        facet.recordPresentationDigest(foreign, keccak256(unicode"по чужой сделке"));
    }

    function test_ZeroDigestRejected() public {
        vm.prank(client);
        vm.expectRevert(ArbiterRegistryFacet.ZeroDigest.selector);
        facet.recordPresentationDigest(agreement, bytes32(0));
    }

    function test_CountIsZeroBeforeAnyDigest() public view {
        assertEq(
            accFacet.getPresentationDigestCount(agreement),
            0,
            unicode"пока не предъявляли — считать нечего"
        );
        assertEq(
            accFacet.getPresentationDigests(agreement).length,
            0,
            unicode"пустой список, а не мусор"
        );
    }

    // ============================================================
    //  ОКНО: ЧТЕНИЕ, КОТОРОЕ НЕ ЛОМАЕТСЯ ОТ ЧУЖОГО УСЕРДИЯ
    // ============================================================
    //
    // Полный getPresentationDigests при длинном списке упирается в потолок газа
    // на eth_call — и ломается он у АРБИТРА и у второй стороны, а не у того, кто
    // список раздул. Окно — выход для читателя без апгрейда контракта.
    //
    // Главное свойство здесь не «режет по limit», а «не ревертит на честном
    // запросе». Читатель не знает длину заранее: узнать её он может только
    // вторым вызовом, то есть в другом блоке, когда длина уже другая. Реверт на
    // краю означал бы, что листающий обязан выиграть гонку с пишущим.

    function test_Page_ReturnsWindow() public {
        bytes32[] memory put = _fillDigests(5);

        bytes32[] memory page = accFacet.getPresentationDigestsPage(agreement, 1, 2);
        assertEq(page.length, 2, unicode"окно обязано отдать ровно limit, пока хватает списка");
        assertEq(page[0], put[1], unicode"окно обязано начинаться с offset");
        assertEq(page[1], put[2], unicode"порядок внутри окна — тот же, что в списке");
    }

    /// `offset` за концом — пустой массив, а не реверт. Это условие остановки
    /// для листающего: «здесь больше ничего нет».
    function test_Page_OffsetPastEnd_ReturnsEmptyNotRevert() public {
        _fillDigests(3);
        assertEq(
            accFacet.getPresentationDigestsPage(agreement, 3, 10).length,
            0,
            unicode"offset ровно за концом — пусто, и это ответ, а не ошибка"
        );
        assertEq(
            accFacet.getPresentationDigestsPage(agreement, 999, 10).length,
            0,
            unicode"offset далеко за концом — тоже пусто, читатель длины не знал"
        );
    }

    /// Пустой список — тот же случай, и он частый: экран открыли до первого
    /// предъявления.
    function test_Page_EmptyList_ReturnsEmptyNotRevert() public view {
        assertEq(
            accFacet.getPresentationDigestsPage(agreement, 0, 10).length,
            0,
            unicode"по пустому списку окно обязано отдать пусто, а не упасть"
        );
    }

    function test_Page_ZeroLimit_ReturnsEmptyNotRevert() public {
        _fillDigests(3);
        assertEq(
            accFacet.getPresentationDigestsPage(agreement, 0, 0).length,
            0,
            unicode"limit == 0 — законный запрос «ничего не надо», не ошибка"
        );
    }

    /// Хвост короче окна: отдаём сколько есть. Без этого листающий, попросивший
    /// последнюю страницу, получал бы реверт вместо остатка.
    function test_Page_LimitBeyondEnd_ReturnsTail() public {
        bytes32[] memory put = _fillDigests(3);

        bytes32[] memory page = accFacet.getPresentationDigestsPage(agreement, 2, 100);
        assertEq(page.length, 1, unicode"хвост короче окна — отдаётся хвост, а не реверт");
        assertEq(page[0], put[2], unicode"в хвосте обязан быть последний положенный");
    }

    /// `limit` в потолок uint256 — тот же «до конца», и запрос это честный:
    /// «дай всё, что есть с этого места», когда длина заранее неизвестна.
    ///
    /// Проверяется отдельно, потому что наивное `offset + limit` здесь
    /// ПАНИКУЕТ (0x11, checked-арифметика 0.8) — то есть ломает не точность
    /// ответа, а само обещание «на честном запросе не ревертит». Замерено
    /// мутацией: наивная сумма даёт красным ровно этот тест.
    function test_Page_HugeLimit_IsUpToTheEnd_NotARevert() public {
        _fillDigests(3);
        assertEq(
            accFacet.getPresentationDigestsPage(agreement, 1, type(uint256).max).length,
            2,
            unicode"limit в потолок — это «до конца», а не панику на честном запросе"
        );
    }

    /// Окно и полный геттер обязаны говорить одно и то же — иначе «сходится /
    /// не сходится» на экране зависело бы от того, каким геттером читали.
    function test_Page_AgreesWithFullGetter() public {
        _fillDigests(4);
        bytes32[] memory full = accFacet.getPresentationDigests(agreement);
        bytes32[] memory page = accFacet.getPresentationDigestsPage(agreement, 0, full.length);

        assertEq(page.length, full.length, unicode"окно во всю длину обязано дать весь список");
        for (uint256 i = 0; i < full.length; i++) {
            assertEq(page[i], full[i], unicode"окно и полный список разошлись — читателю верить нечему");
        }
    }

    /// Листание страницами обязано покрыть список целиком и без повторов —
    /// ровно так им и пользуются.
    function test_Page_WalkCoversEverythingOnce() public {
        bytes32[] memory put = _fillDigests(5);

        uint256 seen = 0;
        for (uint256 off = 0; off < 6; off += 2) {
            bytes32[] memory page = accFacet.getPresentationDigestsPage(agreement, off, 2);
            for (uint256 i = 0; i < page.length; i++) {
                assertEq(page[i], put[seen], unicode"листание сбилось: не тот отпечаток на своём месте");
                seen++;
            }
        }
        assertEq(seen, put.length, unicode"листание обязано покрыть список целиком");
    }

    // ============================================================
    //  ОТПЕЧАТОК НЕ ЩИТ
    // ============================================================

    /// Замысел 2.11. Соблазн «раз сторона предъявила, запретить арбитру писать
    /// молчание» выглядит справедливым и является дырой: цепь не знает, что
    /// именно лежит под отпечатком, поэтому щит достался бы и тому, кто положил
    /// хэш пустого файла. Спор решает арбитр, глядя на порядок, а не контракт.
    function test_DigestDoesNotBlockNoResponse() public {
        _claimBy(arbiter, agreement);

        vm.prank(client);
        facet.recordPresentationDigest(agreement, keccak256(unicode"что-то"));

        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.prank(arbiter);
        facet.recordNoResponse(agreement);

        assertGt(
            accFacet.getNoResponseAt(agreement),
            0,
            unicode"жёсткий запрет дал бы стороне щит: отпечаток пустышки и неуязвимость (2.11)"
        );
    }

    /// Обратная сторона той же монеты: запись арбитра о молчании не запирает
    /// сторону. Она обязана иметь возможность предъявить и ПОСЛЕ неё — тогда в
    /// цепи останется, что предъявление опоздало, и это честнее, чем не дать
    /// предъявить вовсе.
    function test_NoResponseDoesNotBlockDigest() public {
        _claimBy(arbiter, agreement);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.prank(arbiter);
        facet.recordNoResponse(agreement);

        vm.prank(client);
        facet.recordPresentationDigest(agreement, keccak256(unicode"поздно, но было"));

        assertEq(
            accFacet.getPresentationDigestCount(agreement),
            1,
            unicode"запись о молчании не имеет права запереть сторону"
        );
    }

    // ============================================================
    //  ЧЕРЕЗ НАСТОЯЩИЙ ФОРВАРДЕР (ERC-2771)
    // ============================================================
    //
    // Все тесты выше зовут фасет напрямую под vm.prank — в этом окружении
    // trustedForwarder не выставлен, поэтому _msgSender() возвращает
    // msg.sender, и подмена _msgSender() → msg.sender внутри функции не
    // отличалась бы по их зелёному цвету ничем. Ровно тот же класс бага уже был
    // у fundDispute (CLAUDE.md, фикс d172064).
    //
    // Здесь он был бы не «неудобно», а «не работает никогда»: сторона спора
    // ходит гейслесс, и с msg.sender отправителем оказался бы форвардер —
    // адрес, которого нет ни в client, ни в executor. Каждый отпечаток
    // упирался бы в NotDisputeParty, а человек видел бы «транзакция не прошла».

    bytes32 constant FWD_TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data)"
    );

    function test_DigestThroughRealForwarder_CreditsHumanNotForwarder() public {
        uint256 clientPk = 0xC11E27;
        address human = vm.addr(clientPk);
        address relayer = address(0x9999); // третий адрес: не сторона, не форвардер

        // Стороной в реестре делаем именно подписанта.
        address agr = address(new MockDisputedAgreementPD(human, executor));
        _registerAgreement(agr, human, executor);

        MinimalForwarder fwd = new MinimalForwarder();
        _setTrustedForwarder(address(fwd));

        bytes32 digest = keccak256(unicode"через релеер");
        MinimalForwarder.ForwardRequest memory req = MinimalForwarder.ForwardRequest({
            from:  human,
            to:    address(facet),
            value: 0,
            gas:   500_000,
            nonce: fwd.getNonce(human),
            data:  abi.encodeWithSelector(
                ArbiterRegistryFacet.recordPresentationDigest.selector, agr, digest
            )
        });

        vm.prank(relayer);
        (bool ok, bytes memory ret) = fwd.execute(req, _signFwd(fwd, clientPk, req));
        assertTrue(ok, string.concat("forwarded recordPresentationDigest failed: ", vm.toString(ret)));

        bytes32[] memory all = accFacet.getPresentationDigests(agr);
        assertEq(all.length, 1, unicode"через форвардер отправителем обязан считаться человек, не форвардер");
        assertEq(all[0], digest, unicode"в цепь обязан лечь отпечаток из подписанного запроса");
    }

    // ============================================================
    //  ЗАМОК НА САМ СЕТАП
    // ============================================================

    /// Реестр здесь заполняется прямой записью в слоты, и если смещения уедут,
    /// запись ляжет мимо: `rec.agreement` останется нулём, ЛЮБОЙ вызов
    /// упрётся в NotDisputeParty — и все тесты «посторонний не может» станут
    /// зелёными по неверной причине, проверяя пустое место.
    ///
    /// Поэтому смещения сверяются ЧУЖИМ кодом, написанным до этой задачи:
    /// notifyArbiterTimeout читает `rec.agreement`, fundDispute — `rec.client`
    /// и `rec.executor`. Разные ответы этих функций и есть замер.
    function test_RegistrySlotOffsets_MatchLiveStorage() public {
        // (1) поле `agreement`. notifyArbiterTimeout зовёт только сама сделка и
        // первым делом требует, чтобы запись в реестре нашлась; клейма нет,
        // поэтому дальше он молча выходит, ничего не задев.
        vm.prank(agreement);
        facet.notifyArbiterTimeout(agreement); // не ревертит ⇒ rec.agreement на месте

        // (2) поле `client`. У постороннего fundDispute отвечает NotParty —
        // это значит, что проверку «запись найдена» (rec.client != 0) он уже
        // прошёл. Уехало бы смещение — ответ был бы NotAuthorized.
        vm.prank(stranger);
        vm.expectRevert(ArbiterRegistryFacet.NotParty.selector);
        facet.fundDispute(agreement);

        // (3) поле `executor`. Тот же вызов от исполнителя обязан пройти
        // проверку стороны и споткнуться ДАЛЬШЕ (мок не умеет disputeFee()).
        // Утверждать «ревертит не этим» приходится вручную: vm.expectRevert
        // умеет только «ревертит вот этим».
        vm.prank(executor);
        (bool ok, bytes memory ret) = address(facet).call(
            abi.encodeWithSelector(ArbiterRegistryFacet.fundDispute.selector, agreement)
        );
        assertFalse(ok, unicode"сцена не собралась: мок не умеет disputeFee(), вызов обязан упасть");
        assertTrue(ret.length >= 4, unicode"сцена не собралась: ожидался ответ с причиной");
        assertTrue(
            bytes4(ret) != ArbiterRegistryFacet.NotParty.selector,
            unicode"исполнитель не опознан стороной — смещение executor в AgreementRecord уехало"
        );
    }

    // ============================================================
    //  ХЕЛПЕРЫ
    // ============================================================

    /// Кладёт запись о сделке в RegistryStorage самого фасета. Боевой путь
    /// (RegistryFacet.register) заперт за authorizedFactory и живёт в другом
    /// фасете — здесь его нет вовсе, диамонда не поднимаем.
    function _registerAgreement(address agr, address cli, address exe) internal {
        bytes32 rec = keccak256(abi.encode(
            agr,
            uint256(RegistryStorage.REGISTRY_STORAGE_POSITION) + SLOT_REGISTRY_AGREEMENTS
        ));
        vm.store(address(facet), rec, bytes32(uint256(uint160(agr))));
        vm.store(
            address(facet),
            bytes32(uint256(rec) + REC_OFFSET_CLIENT),
            bytes32(uint256(uint160(cli)))
        );
        vm.store(
            address(facet),
            bytes32(uint256(rec) + REC_OFFSET_EXECUTOR),
            bytes32(uint256(uint160(exe)))
        );
    }

    /// Кладёт n отпечатков от клиента и возвращает их в том же порядке —
    /// чтобы тесты окна сверяли содержимое, а не только длину.
    function _fillDigests(uint256 n) internal returns (bytes32[] memory put) {
        put = new bytes32[](n);
        vm.startPrank(client);
        for (uint256 i = 0; i < n; i++) {
            put[i] = keccak256(abi.encodePacked(unicode"предъявление", i));
            facet.recordPresentationDigest(agreement, put[i]);
        }
        vm.stopPrank();
    }

    /// commit + roll + claim одной последовательностью в хелпере, а не
    /// инлайном — та же причина, что у test/DisputeNoResponse.t.sol::_claimBy.
    function _claimBy(address arb, address agr) internal {
        bytes32 salt = keccak256(abi.encodePacked(arb, agr, block.number, block.timestamp));
        bytes32 commitment = keccak256(abi.encodePacked(agr, arb, salt));
        vm.prank(arb);
        facet.commitDisputeClaim(commitment);
        vm.roll(block.number + 1);
        vm.prank(arb);
        facet.claimDispute(agr, salt, bytes32(uint256(0x11)), bytes32(uint256(0x22)));
    }

    /// Садит арбитра прямо в хранилище фасета — как в test/ArbiterChatKey.t.sol.
    function _makeArbiter(address who) internal {
        vm.store(address(facet), keccak256(abi.encode(who, uint256(ARB_BASE))), bytes32(uint256(1)));
        assertTrue(facet.isRegisteredArbiter(who), unicode"не удалось посадить арбитра");
    }

    /// Смещение trustedForwarder внутри FactoryStorage.Layout — 3 слота от базы.
    /// То же смещение, что утверждено в test/DisputeNoResponse.t.sol и
    /// test/ArbiterChatKey.t.sol.
    function _setTrustedForwarder(address forwarder) internal {
        bytes32 slot = bytes32(uint256(FactoryStorage.FACTORY_STORAGE_POSITION) + 3);
        vm.store(address(facet), slot, bytes32(uint256(uint160(forwarder))));
        assertEq(
            address(uint160(uint256(vm.load(address(facet), slot)))),
            forwarder,
            unicode"смещение trustedForwarder в FactoryStorage.Layout уехало"
        );
    }

    function _signFwd(MinimalForwarder fwd, uint256 pk, MinimalForwarder.ForwardRequest memory req)
        internal view returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(
            FWD_TYPEHASH, req.from, req.to, req.value, req.gas, req.nonce, keccak256(req.data)
        ));
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",
            keccak256(abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("MinimalForwarder")),
                keccak256(bytes("0.0.1")),
                block.chainid,
                address(fwd)
            )),
            structHash
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}

/// Минимальная заглушка Agreement — то подмножество, которое опрашивают
/// claimDispute()/recordNoResponse() (status/disputedAt/DISPUTE_WINDOW/
/// client/executor) и вызывают (setArbiter). Живёт в статусе DISPUTED(4) с
/// открытым окном спора с момента деплоя. Копия MockDisputedAgreement из
/// test/ArbiterChatKey.t.sol — под своим именем, потому что forge разворачивает
/// все тестовые файлы в одном проекте.
///
/// disputeFee() здесь намеренно НЕТ: замок на смещения слотов реестра
/// опирается на то, что fundDispute от стороны спотыкается именно об нём,
/// пройдя проверку стороны.
contract MockDisputedAgreementPD {
    uint8 public constant status = 4; // Agreement.Status.DISPUTED
    uint256 public disputedAt;
    uint256 public constant DISPUTE_WINDOW = 4 days;
    address public client;
    address public executor;
    address public arbiter;

    constructor(address _client, address _executor) {
        client = _client;
        executor = _executor;
        disputedAt = block.timestamp;
    }

    function setArbiter(address newArbiter) external {
        arbiter = newArbiter;
    }
}
