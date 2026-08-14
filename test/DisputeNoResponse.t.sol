// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Момент взятия спора и запись «просил переписку — ответа нет»
// (4в-2 Выкатка 2, Задачи 1 и 2).
//
// Цепь не видит нашего ящика и проверить «просил» не может ничем. Всё, что она
// умеет — записать факт со слов арбитра и точное время. Ради этого времени и
// заведён якорь: по апелляции должен быть виден ПОРЯДОК событий (взял спор →
// столько-то ждал → записал молчание), а не чьё-то слово.
//
// Отсюда главное свойство обоих полей: ни якорь, ни запись не переписываются
// никогда. Оба ключуются ПАРОЙ (сделка, арбитр) и пишутся один раз. Арбитру
// обе транзакции — отпустить спор и взять заново — достаются бесплатно
// (гейслесс), поэтому «стирать при снятии клейма» означало бы «арбитр сам
// выбирает, какое время будет записано»: он мог бы отодвинуть якорь на «сейчас»
// уже ПОСЛЕ записи о молчании, и в цепи осталось бы, что молчание записано
// раньше, чем спор взят. Порядок событий — единственное, ради чего вся эта
// запись существует, — рассыпался бы.
//
// ⚠️ Время здесь берётся ТОЛЬКО через vm.getBlockTimestamp(), а не через
// block.timestamp, и это не вкусовщина. Проект собирается с via_ir, и solc
// считает TIMESTAMP неизменным внутри вызова — на настоящей цепи это правда, а
// под vm.warp нет. Второй `vm.warp(block.timestamp + 24 hours)` в одном теле
// теста фактически прыгал в ТУ ЖЕ секунду, что и первый (замер: `VM::warp(86401)`
// дважды подряд). Класс промаха ровно тот, о котором предупреждает
// docs/PROCESS.md: тест выглядит как «прошли сутки», а проверяет ноль секунд —
// и заметен он был только потому, что нам повезло получить красный. Тесты, где
// такой прыжок ослабил бы проверку молча, тем же приёмом чинятся вслепую.
//
// Сетап — тот же, что у test/ArbiterChatKey.t.sol: фасет развёрнут отдельно,
// арбитр сажается прямо в хранилище (applyAsArbiter заперт за isDaoActive, а
// ДАО намеренно не запущено — решение владельца 1 августа), спор изображает
// MockDisputedAgreementNR. Настоящего диамонда здесь не нужно: всё, что
// утверждается ниже — состояние namespaced-хранилища самого фасета.

import "forge-std/Test.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";
import {FactoryStorage} from "../src/FactoryFacet.sol";
import {MinimalForwarder} from "../src/MinimalForwarder.sol";

contract DisputeNoResponseTest is Test {
    ArbiterRegistryFacet facet;

    address arbiter;
    address otherArbiter;
    address agreement;

    /// База неймспейса ArbiterRegistryStorage — keccak256("hexseal.arbiterregistry.storage")
    /// с обнулённым последним байтом (ERC-7201), она же ArbiterRegistryStorage.POSITION.
    bytes32 constant ARB_BASE = 0xaae71de0594cbcb5434f0ab7f7501c1be178552bf788b418a1c2624ba9718d00;

    /// Смещение слота `disputeClaims` от базы неймспейса (третье поле Data).
    uint256 constant SLOT_DISPUTE_CLAIMS = 2;

    /// Смещение слота `disputeClaimedAtBy` от базы неймспейса.
    ///
    /// ⚠️ Бриф велел взять его из `forge inspect ArbiterRegistryFacet
    /// storage-layout` — здесь эта команда не годится и молчит: у фасета нет
    /// ни одной state-переменной, вся Data живёт по namespaced-слоту через
    /// assembly, и в выводе inspect её попросту нет. Число добыто замером —
    /// тестом test_SlotOffsets_MatchLiveStorage ниже, который сверяет его с
    /// живым хранилищем.
    ///
    /// Считать в уме тем более нельзя: номер ПОЛЯ в struct Data (23) и номер
    /// СЛОТА (22) расходятся — `chiefArbiter` (address, 20 байт) и
    /// `daoActiveManual` (bool, 1 байт) упакованы в один слот, и всё после них
    /// съехало на единицу.
    uint256 constant SLOT_CLAIMED_AT_BY = 22;

    function setUp() public {
        facet = new ArbiterRegistryFacet();
        arbiter = address(0xA1);
        otherArbiter = address(0xA2);
        _makeArbiter(arbiter);
        _makeArbiter(otherArbiter);
        agreement = address(new MockDisputedAgreementNR(address(0xC1), address(0xE1)));
    }

    // ============================================================
    //  ЯКОРЬ: МОМЕНТ ВЗЯТИЯ СПОРА
    // ============================================================

    function test_ClaimDispute_RecordsClaimMoment() public {
        _claimBy(arbiter, agreement);
        assertEq(
            facet.getDisputeClaimedAt(agreement),
            vm.getBlockTimestamp(),
            unicode"время взятия обязано лечь в хранилище"
        );
    }

    /// До взятия времени нет. Ноль здесь — не «поле сломано», а рабочий
    /// признак «спор не брался»: на нём же стоит отказ спорам, взятым до
    /// разреза (ClaimTimeUnknown ниже).
    function test_GetDisputeClaimedAt_ZeroBeforeClaim() public view {
        assertEq(
            facet.getDisputeClaimedAt(agreement),
            0,
            unicode"невзятый спор не может иметь момента взятия"
        );
    }

    /// Перевзятие тем же арбитром двигает якорь ВПЕРЁД, на момент последнего
    /// взятия. Решение владельца 14.08.2026, отменяет более раннее «один раз
    /// навсегда»: пол должен мерить время, пока спор стоял ЗА ЭТИМ арбитром,
    /// то есть пока стороне было кому предъявлять.
    ///
    /// Сдвиг вперёд арбитру не выгоден — он только откладывает его же запись,
    /// см. следующий тест, который показывает, что именно этим сдвигом дыра и
    /// закрывается.
    function test_ReclaimBySameArbiter_AnchorMovesForward() public {
        _claimBy(arbiter, agreement);
        uint256 firstClaim = facet.getDisputeClaimedAt(agreement);

        vm.prank(arbiter);
        facet.releaseDisputeClaim(agreement);

        vm.warp(vm.getBlockTimestamp() + 25 hours);
        _claimBy(arbiter, agreement);

        assertEq(
            facet.getDisputeClaimedAt(agreement),
            firstClaim + 25 hours,
            unicode"перевзятие обязано переставить якорь на момент последнего взятия"
        );
    }

    /// Дыра, ради закрытия которой якорь пишется при каждом взятии.
    ///
    /// Подкупленный арбитр берёт спор, отпускает через минуту и возвращается
    /// через двое суток. Формально «клеймером» он был двое суток назад — но
    /// почти всё это время спор стоял ничей, ключ судьи был неизвестен, и
    /// предъявлять стороне было НЕКОМУ. С якорем «первое взятие навсегда» он
    /// записал бы молчание в ту же секунду, как вернулся. Теперь пол для него
    /// начинается заново.
    function test_ReclaimAfterLongGap_FloorStartsOver() public {
        _claimBy(arbiter, agreement);

        vm.warp(vm.getBlockTimestamp() + 1 minutes);
        vm.prank(arbiter);
        facet.releaseDisputeClaim(agreement);

        vm.warp(vm.getBlockTimestamp() + 2 days);
        _claimBy(arbiter, agreement);

        vm.prank(arbiter);
        vm.expectRevert(ArbiterRegistryFacet.NoResponseTooEarly.selector);
        facet.recordNoResponse(agreement);
    }

    /// Пока клеймера нет, геттер обязан молчать: спор ничей, показывать
    /// «взят тогда-то» некому и не про кого.
    function test_Release_ClearsVisibleAnchor() public {
        _claimBy(arbiter, agreement);
        vm.prank(arbiter);
        facet.releaseDisputeClaim(agreement);
        assertEq(
            facet.getDisputeClaimedAt(agreement),
            0,
            unicode"клейм снят — геттер обязан молчать, спор ничей"
        );
    }

    /// Второй путь снятия клейма — обратный вызов из самого Agreement
    /// (таймаут, исполнение вердикта). Ведёт себя так же, и не потому, что
    /// здесь дописана уборка, а потому что уборки нет вовсе (см. инвариант ниже).
    function test_ClearDisputeClaim_ClearsVisibleAnchor() public {
        _claimBy(arbiter, agreement);
        vm.prank(agreement); // clearDisputeClaim зовёт только сам Agreement
        facet.clearDisputeClaim(agreement);
        assertEq(
            facet.getDisputeClaimedAt(agreement),
            0,
            unicode"клейм снят обратным вызовом — геттер обязан молчать"
        );
    }

    /// У нового арбитра свой якорь, от момента, когда взял ОН. Чужой ему не
    /// достаётся ни в каком виде: иначе пол оказался бы уже пройденным и он
    /// записал бы молчание в ту же секунду, как взял спор.
    function test_OtherArbiter_GetsOwnAnchor() public {
        _claimBy(arbiter, agreement);
        uint256 firstClaim = facet.getDisputeClaimedAt(agreement);

        vm.prank(arbiter);
        facet.releaseDisputeClaim(agreement);

        vm.warp(vm.getBlockTimestamp() + 25 hours);
        _claimBy(otherArbiter, agreement);

        assertEq(
            facet.getDisputeClaimedAt(agreement),
            firstClaim + 25 hours,
            unicode"новый арбитр обязан получить СВОЙ якорь, а не чужой"
        );

        vm.prank(otherArbiter);
        vm.expectRevert(ArbiterRegistryFacet.NoResponseTooEarly.selector);
        facet.recordNoResponse(agreement);
    }

    // ============================================================
    //  ИНВАРИАНТ ВМЕСТО ПЕРЕЧИСЛЕНИЯ МЕСТ
    // ============================================================

    /// Отложенный Minor из ревью Задачи 1: «клейм снят ⇒ ничего не протухло»
    /// держалось двумя поимённо названными тестами, по одному на каждое место
    /// снятия. Перечисление ветшает — в самом фасете уже назван кандидат на
    /// ТРЕТЬЕ место снятия (`abandonClaim`, docs/OPEN-ITEMS.md п. 11), и его
    /// автор про этот файл ничего знать не обязан.
    ///
    /// Здесь замок стоит на свойстве, а не на списке: клейм снимается напрямую
    /// в хранилище — то есть путём, которого в коде ещё НЕТ, — и оба геттера
    /// всё равно обязаны дать ноль. Свойство держится формой хранилища (оба
    /// поля ключуются арбитром, геттеры ходят через disputeClaims), а не
    /// уборкой в каждом месте: любое будущее место снятия наследует его само.
    function test_NoClaimer_EverythingReadsZero_ByShapeNotByCleanup() public {
        _claimBy(arbiter, agreement);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.prank(arbiter);
        facet.recordNoResponse(agreement);

        // Обе величины видны — иначе замер ниже прошёл бы на пустом месте.
        assertGt(facet.getDisputeClaimedAt(agreement), 0, unicode"якорь обязан быть виден до снятия");
        assertGt(facet.getNoResponseAt(agreement), 0, unicode"запись обязана быть видна до снятия");

        // Снятие клейма ЛЮБЫМ путём, включая ещё не написанный.
        bytes32 claimSlot = keccak256(abi.encode(agreement, uint256(ARB_BASE) + SLOT_DISPUTE_CLAIMS));
        assertEq(
            address(uint160(uint256(vm.load(address(facet), claimSlot)))),
            arbiter,
            unicode"смещение disputeClaims в struct Data уехало"
        );
        vm.store(address(facet), claimSlot, bytes32(0));
        assertEq(facet.getDisputeClaimer(agreement), address(0), unicode"клейм обязан сняться");

        assertEq(facet.getDisputeClaimedAt(agreement), 0,
            unicode"клеймера нет — якорь обязан молчать, каким бы путём клейм ни снялся");
        assertEq(facet.getNoResponseAt(agreement), 0,
            unicode"клеймера нет — запись обязана молчать, каким бы путём клейм ни снялся");
    }

    /// Замок на два числа выше. Оба смещения добыты замером, а не выводом
    /// `forge inspect` (он про namespaced-хранилище ничего не знает) и не
    /// счётом в уме (номер поля и номер слота расходятся из-за упаковки
    /// chiefArbiter+daoActiveManual). Раз добыты замером — замером и
    /// сторожатся: вставка поля в середину Data сдвинет слоты, и падать это
    /// обязано здесь, с понятной причиной, а не молчаливо превращать соседние
    /// тесты в проверку пустого места.
    function test_SlotOffsets_MatchLiveStorage() public {
        _claimBy(arbiter, agreement);

        bytes32 claimSlot = keccak256(abi.encode(agreement, uint256(ARB_BASE) + SLOT_DISPUTE_CLAIMS));
        assertEq(
            address(uint160(uint256(vm.load(address(facet), claimSlot)))),
            arbiter,
            unicode"SLOT_DISPUTE_CLAIMS больше не указывает на disputeClaims"
        );

        bytes32 anchorSlot = keccak256(abi.encode(
            arbiter, keccak256(abi.encode(agreement, uint256(ARB_BASE) + SLOT_CLAIMED_AT_BY))
        ));
        assertEq(
            uint256(vm.load(address(facet), anchorSlot)),
            vm.getBlockTimestamp(),
            unicode"SLOT_CLAIMED_AT_BY больше не указывает на disputeClaimedAtBy"
        );
    }

    // ============================================================
    //  ЗАПИСЬ «ПРОСИЛ, ОТВЕТА НЕТ»
    // ============================================================

    function test_RecordNoResponse_RevertsBeforeFloor() public {
        _claimBy(arbiter, agreement);
        vm.warp(vm.getBlockTimestamp() + 23 hours);
        vm.prank(arbiter);
        vm.expectRevert(ArbiterRegistryFacet.NoResponseTooEarly.selector);
        facet.recordNoResponse(agreement);
    }

    function test_RecordNoResponse_PassesAtFloor() public {
        _claimBy(arbiter, agreement);
        vm.warp(vm.getBlockTimestamp() + 24 hours);

        vm.expectEmit(true, true, false, true, address(facet));
        emit ArbiterRegistryFacet.DisputeNoResponseRecorded(agreement, arbiter, vm.getBlockTimestamp());

        vm.prank(arbiter);
        facet.recordNoResponse(agreement);

        assertEq(
            facet.getNoResponseAt(agreement),
            vm.getBlockTimestamp(),
            unicode"пол пройден — запись обязана лечь в цепь секундой блока"
        );
    }

    function test_RecordNoResponse_OnlyOnce() public {
        _claimBy(arbiter, agreement);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.startPrank(arbiter);
        facet.recordNoResponse(agreement);
        vm.expectRevert(ArbiterRegistryFacet.NoResponseAlreadyRecorded.selector);
        facet.recordNoResponse(agreement);
        vm.stopPrank();
    }

    /// Однократность не смывается отпуском спора: арбитр не может стереть свою
    /// запись и поставить её другим временем. Здесь якорь и запись расходятся
    /// в правилах — якорь при перевзятии переставляется, запись нет, — и тест
    /// сторожит именно это расхождение.
    function test_RecordNoResponse_ReclaimCannotRewriteRecord() public {
        _claimBy(arbiter, agreement);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.prank(arbiter);
        facet.recordNoResponse(agreement);
        uint256 recordedAt = facet.getNoResponseAt(agreement);

        vm.prank(arbiter);
        facet.releaseDisputeClaim(agreement);
        vm.warp(vm.getBlockTimestamp() + 25 hours);
        _claimBy(arbiter, agreement);

        assertEq(
            facet.getNoResponseAt(agreement),
            recordedAt,
            unicode"перевзятие не имеет права переставить время уже сделанной записи"
        );
        // Осознанное следствие правила «якорь при каждом взятии»: в хранилище
        // якорь теперь ПОЗЖЕ записи о молчании. Это не порча порядка событий —
        // порядок читается из ленты (DisputeClaimed / DisputeReleased /
        // DisputeNoResponseRecorded), а хранилище держит только последнее
        // взятие. Утверждается здесь явно, чтобы следующий читатель не принял
        // это за баг и не «починил» обратно в «один раз навсегда».
        assertGt(
            facet.getDisputeClaimedAt(agreement),
            facet.getNoResponseAt(agreement),
            unicode"якорь обязан переставиться на последнее взятие, даже если оно позже записи"
        );

        // Ответ обязан быть «уже записано», а не «рано»: якорь после перевзятия
        // свежий, и пол формально не пройден — но обещать арбитру, что через
        // сутки получится, значит соврать. Поэтому однократность проверяется
        // раньше пола, см. recordNoResponse.
        vm.prank(arbiter);
        vm.expectRevert(ArbiterRegistryFacet.NoResponseAlreadyRecorded.selector);
        facet.recordNoResponse(agreement);
    }

    /// Арбитр, который спор вообще не брал. Замок слабый и назван таковым
    /// намеренно: у чужого арбитра якорь нулевой, поэтому без проверки
    /// NotClaimingArbiter вызов не прошёл бы насквозь, а упёрся бы дальше в
    /// ClaimTimeUnknown — тест покраснел бы «не тем классом ошибки», а не тем,
    /// что неавторизованный записал. Настоящую сцену сторожит следующий тест.
    function test_RecordNoResponse_RevertsForNonClaimingArbiter() public {
        _claimBy(arbiter, agreement);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.prank(otherArbiter);
        vm.expectRevert(ArbiterRegistryFacet.NotClaimingArbiter.selector);
        facet.recordNoResponse(agreement);
    }

    /// ЕДИНСТВЕННАЯ сцена, ради которой проверка NotClaimingArbiter вообще
    /// стоит: БЫВШИЙ клеймер с ЖИВЫМ якорем.
    ///
    /// Первый арбитр взял спор, подождал сутки, отпустил — спор взял второй. У
    /// первого якорь остался ненулевым: ключ по паре (сделка, арбитр), и мы его
    /// намеренно не чистим. Значит все остальные проверки он проходит: время
    /// взятия известно, пол пройден, своей записи ещё нет. Не пускает его
    /// ровно одна строка.
    ///
    /// ⚠️ И пропажа этой строки была бы НЕВИДИМА там, где её стали бы искать:
    /// `getNoResponseAt` ходит через текущего клеймера и запись бывшего не
    /// показал бы вовсе. А вот событие DisputeNoResponseRecorded ушло бы в
    /// ленту — и лента, а не геттер, есть то, ради чего вся задача сделана.
    /// Замерено: без проверки вызов не ревертит и событие испускается.
    function test_FormerClaimer_WithLiveAnchor_CannotRecord() public {
        _claimBy(arbiter, agreement);
        vm.warp(vm.getBlockTimestamp() + 24 hours);

        vm.prank(arbiter);
        facet.releaseDisputeClaim(agreement);
        _claimBy(otherArbiter, agreement);

        // Якорь бывшего клеймера жив и стар — все прочие ворота для него открыты.
        bytes32 anchorSlot = keccak256(abi.encode(
            arbiter, keccak256(abi.encode(agreement, uint256(ARB_BASE) + SLOT_CLAIMED_AT_BY))
        ));
        assertEq(
            uint256(vm.load(address(facet), anchorSlot)),
            vm.getBlockTimestamp() - 24 hours,
            unicode"сцена не собралась: у бывшего клеймера обязан остаться живой якорь"
        );

        vm.prank(arbiter);
        vm.expectRevert(ArbiterRegistryFacet.NotClaimingArbiter.selector);
        facet.recordNoResponse(agreement);
    }

    /// Спор, взятый ДО разреза: клеймер в хранилище есть, времени взятия нет.
    /// Цепь не знает, когда это было, и пол считать не от чего — отказываем
    /// закрыто. Выход дешёвый: releaseDisputeClaim и взять спор заново.
    function test_RecordNoResponse_RevertsWhenClaimTimeUnknown() public {
        _claimBy(arbiter, agreement);
        _forceClaimedAtZero(agreement, arbiter);
        vm.warp(vm.getBlockTimestamp() + 365 days);
        vm.prank(arbiter);
        vm.expectRevert(ArbiterRegistryFacet.ClaimTimeUnknown.selector);
        facet.recordNoResponse(agreement);
    }

    /// Прежняя запись о молчании не тянется к новому арбитру: он видит ноль и
    /// делает свою, со своим временем.
    function test_Release_HidesRecordFromNextArbiter() public {
        _claimBy(arbiter, agreement);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.startPrank(arbiter);
        facet.recordNoResponse(agreement);
        facet.releaseDisputeClaim(agreement);
        vm.stopPrank();

        assertEq(
            facet.getNoResponseAt(agreement),
            0,
            unicode"отпустил спор — прежняя запись о молчании не должна тянуться к новому арбитру"
        );

        _claimBy(otherArbiter, agreement);
        assertEq(
            facet.getNoResponseAt(agreement),
            0,
            unicode"новый арбитр обязан начать с чистого листа, а не с чужой записи"
        );

        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.prank(otherArbiter);
        facet.recordNoResponse(agreement);
        assertEq(
            facet.getNoResponseAt(agreement),
            vm.getBlockTimestamp(),
            unicode"новый арбитр обязан мочь сделать СВОЮ запись"
        );
    }

    /// Пол объявлен в цепи и только там: фронт обязан спрашивать его здесь, а
    /// не держать свою копию (замысел 5.2).
    function test_NoResponseFloor_IsOnChainAndEqualsOneDay() public view {
        assertEq(
            facet.getNoResponseFloor(),
            24 hours,
            unicode"пол записи о молчании — сутки от взятия спора"
        );
    }

    // ============================================================
    //  ЧЕРЕЗ НАСТОЯЩИЙ ФОРВАРДЕР (ERC-2771)
    // ============================================================
    //
    // Все тесты выше зовут facet.recordNoResponse напрямую под vm.prank — в
    // этом окружении trustedForwarder не выставлен, поэтому _msgSender()
    // возвращает msg.sender, и подмена _msgSender() → msg.sender внутри
    // функции не отличалась бы по их зелёному цвету ничем. Ровно тот же класс
    // бага уже был у fundDispute (CLAUDE.md, фикс d172064): платный вызов
    // арбитра не срабатывал ни разу, а прямые тесты этого не ловили.
    //
    // Единственный путь, которым арбитр реально делает эту запись — гейслесс,
    // через релеер. Прочитай функция msg.sender — вызов упирался бы в
    // NotClaimingArbiter (клеймер не форвардер), и запись не проходила бы
    // НИКОГДА, а арбитр видел бы только «транзакция не прошла».

    bytes32 constant FWD_TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data)"
    );

    function test_RecordNoResponse_ThroughRealForwarder_CreditsHumanNotForwarder() public {
        uint256 arbiterPk = 0xCA11;
        address arb = vm.addr(arbiterPk);
        address relayer = address(0x9999); // третий адрес: не арбитр, не форвардер
        _makeArbiter(arb);
        _claimBy(arb, agreement);
        vm.warp(vm.getBlockTimestamp() + 24 hours);

        MinimalForwarder fwd = new MinimalForwarder();
        _setTrustedForwarder(address(fwd));

        MinimalForwarder.ForwardRequest memory req = MinimalForwarder.ForwardRequest({
            from:  arb,
            to:    address(facet),
            value: 0,
            gas:   500_000,
            nonce: fwd.getNonce(arb),
            data:  abi.encodeWithSelector(ArbiterRegistryFacet.recordNoResponse.selector, agreement)
        });

        vm.prank(relayer);
        (bool ok, bytes memory ret) = fwd.execute(req, _signFwd(fwd, arbiterPk, req));
        assertTrue(ok, string.concat("forwarded recordNoResponse failed: ", vm.toString(ret)));

        assertEq(
            facet.getNoResponseAt(agreement),
            vm.getBlockTimestamp(),
            unicode"запись обязана лечь ПОДПИСАНТУ, а не форвардеру"
        );
    }

    // ============================================================
    //  ХЕЛПЕРЫ
    // ============================================================

    /// commit + roll + claim одной последовательностью в хелпере, а не
    /// инлайном: тот же приём и та же причина, что у
    /// test/ArbiterChatKey.t.sol::_commitAndClaim — повтор той же
    /// последовательности инлайном дважды в одном теле теста под via_ir
    /// наблюдался как «второй vm.roll не берётся».
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
        // POSITION хранилища + слот mapping isArbiter (первое поле Data).
        vm.store(address(facet), keccak256(abi.encode(who, uint256(ARB_BASE))), bytes32(uint256(1)));
        // Проверка обязательна: при неверном слоте посадка молча не срабатывает,
        // и все замеры ниже падали бы на NotArbiter, а читались бы как
        // «время взятия проверено».
        assertTrue(facet.isRegisteredArbiter(who), unicode"не удалось посадить арбитра");
    }

    /// Ставит время взятия в ноль, как у споров, взятых ДО разреза 4в-2.
    /// Пишем прямо в слот: боевого пути к нулю нет и быть не должно.
    /// disputeClaimedAtBy — вложенный mapping, поэтому два keccak: сначала
    /// сделка, потом арбитр.
    function _forceClaimedAtZero(address agr, address arb) internal {
        bytes32 outer = keccak256(abi.encode(agr, uint256(ARB_BASE) + SLOT_CLAIMED_AT_BY));
        bytes32 slot  = keccak256(abi.encode(arb, outer));
        // Не берём смещение на веру: при неверном слоте vm.store молча писал бы
        // в чужое поле, якорь остался бы ненулевым, и тест «отказ старым спорам»
        // проверял бы совсем не то, о чём его имя.
        assertGt(uint256(vm.load(address(facet), slot)), 0,
            unicode"смещение disputeClaimedAtBy в struct Data уехало");
        vm.store(address(facet), slot, bytes32(0));
        assertEq(facet.getDisputeClaimedAt(agr), 0, unicode"якорь обязан обнулиться");
    }

    /// Смещение trustedForwarder внутри FactoryStorage.Layout — 3 слота от
    /// базы (usdc(0), feeRecipient(1), regionFee(2, mapping — свой слот),
    /// trustedForwarder(3)). То же смещение, что утверждено в
    /// test/ArbiterChatKey.t.sol и test/BoardsFixture.sol.
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

/// Минимальная заглушка Agreement — ровно то подмножество интерфейса, которое
/// claimDispute()/releaseDisputeClaim() опрашивают staticcall'ами
/// (status/disputedAt/DISPUTE_WINDOW/client/executor) и вызывают (setArbiter).
/// Живёт в статусе DISPUTED(4) с открытым окном спора с момента деплоя.
/// Копия MockDisputedAgreement из test/ArbiterChatKey.t.sol — под своим именем,
/// потому что forge разворачивает оба файла в одном проекте.
contract MockDisputedAgreementNR {
    uint8 public constant status = 4; // Agreement.Status.DISPUTED
    uint256 public disputedAt;
    /// 4 дня, как в настоящем Agreement.sol (DISPUTE_WINDOW). Мок, врущий про
    /// окно, здесь не безобиден: тесты ниже гоняют время сутками, и заниженное
    /// окно закрывало бы им перевзятие раньше, чем закрыло бы его боевому спору.
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
