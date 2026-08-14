// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";
import {IDiamondCut, IDiamondLoupe} from "../src/DiamondProxy.sol";

/// Тот же getNoResponseFloor(), но объявленный `view`, а не `pure`.
/// В самом фасете он pure — там он и правда только возвращает константу. А
/// ЧЕРЕЗ ДАЙМОНД тот же вызов сперва ищет фасет в хранилище прокси, то есть
/// состояние читает. Смысл смоука ровно в этом поиске, поэтому и тип здесь
/// честный: `pure` объявлял бы, что маршрутизации не происходит.
interface INoResponseFloorProbe {
    function getNoResponseFloor() external view returns (uint256);
}

/**
 * 4в-2 Выкатка 2: запись «просил, ответа нет» и отпечаток предъявления.
 *
 * ОДИН diamondCut из двух действий:
 *   Replace — все 56 прежних селекторов фасета на новый адрес;
 *   Add     — восемь новых:
 *               getDisputeClaimedAt(address)                          (Задача 1)
 *               recordNoResponse(address)                             (Задача 2)
 *               getNoResponseAt(address)                              (Задача 2)
 *               getNoResponseFloor()                                  (Задача 2)
 *               recordPresentationDigest(address,bytes32)             (Задача 3)
 *               getPresentationDigests(address)                       (Задача 3)
 *               getPresentationDigestCount(address)                   (Задача 3)
 *               getPresentationDigestsPage(address,uint256,uint256)   (Задача 3, круг правок)
 *
 * Группы Remove НЕТ: ни одна прежняя подпись не менялась, удалять нечего.
 * Смонтированных селекторов в диамонде станет 169 → 177. Число проверяется
 * пост-полётом ниже, а не глазами.
 *
 * Почему одним cut'ом, а не двумя вызовами: между Replace и Add диамонд не
 * должен оказаться в состоянии «код новый, входов нет» — recordNoResponse и
 * recordPresentationDigest пишут в поля, которые новый код уже читает.
 *
 * Почему Replace обязателен: без него 56 селекторов фасета остались бы на
 * прежнем адресе, и диамонд поехал бы наполовину старым кодом, который про три
 * новых поля хранилища не знает вовсе.
 *
 * ── Pre/post-flight ──────────────────────────────────────────────────────
 * Форма — script/archive/UpgradeArbiterChatKey.s.sol (10 августа 2026). Replace
 * на адрес, у которого нужного селектора нет, НЕ ревертит
 * (DiamondCutLib.replaceFunctions проверяет только «адрес другой и есть код»,
 * не «реализует ли он этот селектор») — тихий разъезд «смонтировано, но не
 * работает» ровно того класса, что уже ломал fundDispute на msg.sender вместо
 * _msgSender() (d172064): задеплоено, ни разу не сработало, никто не заметил до
 * отдельного разбора. Поэтому до broadcast проверяется, что вся группа Replace
 * целится в один и тот же реально смонтированный старый адрес, а Add — в пока
 * не смонтированные селекторы; после broadcast — что Replace/Add легли на новый
 * адрес, старый адрес опустел, и вдобавок функциональный смоук:
 * getNoResponseFloor() ЧЕРЕЗ ДАЙМОНД отдаёт РОВНО сутки, а не просто числится в
 * loupe. Сверяется значение, а не факт возврата, потому что пол объявлен в
 * контракте и только там (замысел 5.2) — фронт берёт его из цепи, и цепь,
 * отвечающая другим числом, нарисовала бы человеку неверное ожидание.
 *
 * ── Целостность хранилища ────────────────────────────────────────────────
 * Всё выше проверяет МАРШРУТИЗАЦИЮ селекторов — ни одна из проверок не читает
 * ни одного значения, которое уже лежало в арбитражном неймспейсе ДО разреза.
 * Это ровно тот класс, что в июле 2026 сломал JobBoard: getOpenJobs() начал
 * ревертить Panic(0x22) на живом хранилище после смены раскладки, а статические
 * гейты (селекторы, ABI) этого не видели. Задачи 1-3 дописали в конец
 * ArbiterRegistryStorage.Data ТРИ поля, то есть ровно тот тип правки, который
 * этот класс и порождает. Поэтому здесь читаются getArbiters().length,
 * getVaultBalance() и getArbiterFloor() ДО vm.startBroadcast и снова ПОСЛЕ
 * vm.stopBroadcast, с require на равенство — доказательство на реальных данных,
 * а не на факте, что cut прошёл.
 *
 * ── Споры, взятые ДО разреза ─────────────────────────────────────────────
 * Кода переноса нет вовсе (решение владельца 14 августа): у спора, взятого до
 * этого cut'а, якоря времени в цепи не существует, и recordNoResponse ответит
 * ему ClaimTimeUnknown. Лекарство дешёвое — releaseDisputeClaim и взять спор
 * заново. Пред-полёт такие споры ПЕРЕЧИСЛЯЕТ И ПЕЧАТАЕТ, но не ревертит: они
 * взяты законно, и падать здесь было бы неправдой.
 */
contract UpgradePresentationRecord is Script {
    /// Пол записи о молчании — сутки (решение владельца 14 августа 2026).
    /// Объявлен в контракте, здесь только сверяется.
    uint256 internal constant EXPECTED_NO_RESPONSE_FLOOR = 24 hours;

    function run() external {
        address diamond = vm.envAddress("DIAMOND_ADDRESS");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        require(diamond != address(0), "DIAMOND_ADDRESS not set");

        bytes4[] memory replaceSels = replaceSelectors();
        bytes4[] memory addSels     = addSelectors();

        // ── Pre-flight ────────────────────────────────────────────────────
        console.log("=== UpgradePresentationRecord: pre-flight ===");
        address oldFacet = checkReplaceGroup(replaceSels, diamond);
        checkAddGroupUnmounted(addSels, diamond);
        console.log("Old ArbiterRegistryFacet currently mounted at:", oldFacet);

        uint256 selectorsBefore = totalRoutedSelectors(diamond);
        console.log("Total routed selectors BEFORE cut:", selectorsBefore);

        // Значения, уже лежащие в арбитражном неймспейсе — читаются ДО
        // broadcast, сверяются с тем же чтением ПОСЛЕ.
        StorageSnapshot memory before = snapshotArbiterStorage(diamond);
        console.log("Arbiter storage BEFORE cut - arbiters:", before.arbiterCount);
        console.log("  vaultBalance:", before.vaultBalance);
        console.log("  arbiterFloor:", before.arbiterFloor);

        warnArbitersWithPreCutClaims(diamond);
        console.log("");

        // ── Апгрейд ───────────────────────────────────────────────────────
        vm.startBroadcast(pk);
        ArbiterRegistryFacet facet = new ArbiterRegistryFacet();
        IDiamondCut(diamond).diamondCut(buildCuts(address(facet)), address(0), "");
        vm.stopBroadcast();

        console.log("ArbiterRegistryFacet:", address(facet));
        console.log("Replace", replaceSels.length, "/ Add", addSels.length);
        console.log("");

        // ── Post-flight ───────────────────────────────────────────────────
        console.log("=== Post-flight ===");
        assertRouted(replaceSels, address(facet), diamond);
        assertRouted(addSels,     address(facet), diamond);
        assertFacetHoldsNoSelectors(oldFacet, diamond);
        console.log("Replace/Add -> new facet, old facet emptied.");

        StorageSnapshot memory afterCut = snapshotArbiterStorage(diamond);
        assertStorageContinuity(before, afterCut);
        console.log("Arbiter storage AFTER cut  - arbiters:", afterCut.arbiterCount);
        console.log("  vaultBalance:", afterCut.vaultBalance);
        console.log("  arbiterFloor:", afterCut.arbiterFloor);
        console.log("Storage continuity OK: arbiters/vaultBalance/arbiterFloor unchanged by the cut.");

        assertNoResponseFloorAnswers(diamond);
        console.log("Smoke getNoResponseFloor() through diamond returned 24h.");

        uint256 selectorsAfter = totalRoutedSelectors(diamond);
        require(
            selectorsAfter == selectorsBefore + addSels.length,
            "post: routed selector count did not move by exactly +Add"
        );
        console.log("Total routed selectors AFTER cut:", selectorsAfter);
    }

    // ════════════════════════════════════════════════════════════════════
    // Pre/post-flight helpers — public так, чтобы
    // test/PresentationRecordUpgrade.t.sol мог звать их напрямую против
    // локально развёрнутого даймонда, не только против живой цепи внутри run().
    // ════════════════════════════════════════════════════════════════════

    /// Каждый селектор группы смонтирован сейчас, и все указывают на ОДИН и тот
    /// же адрес — иначе список Replace выведен неверно (фасет уже разъехался по
    /// нескольким адресам, и Replace на единый новый адрес был бы неверной
    /// операцией). Возвращает этот адрес.
    function checkReplaceGroup(bytes4[] memory sels, address diamond)
        public view returns (address facetAddr)
    {
        require(sels.length > 0, unicode"UpgradePresentationRecord: группа Replace пуста");
        facetAddr = IDiamondLoupe(diamond).facetAddress(sels[0]);
        require(facetAddr != address(0), unicode"UpgradePresentationRecord: первый селектор Replace не смонтирован");
        for (uint256 i = 0; i < sels.length; i++) {
            address a = IDiamondLoupe(diamond).facetAddress(sels[i]);
            require(a != address(0), unicode"UpgradePresentationRecord: один из селекторов Replace не смонтирован");
            require(
                a == facetAddr,
                unicode"UpgradePresentationRecord: селекторы Replace разъехались больше чем по одному живому адресу фасета"
            );
        }
    }

    /// Ни один селектор группы ещё не смонтирован — иначе Add ревертит
    /// "selector exists" в DiamondCutLib.addFunctions, и вся выкатка падает
    /// уже ПОСЛЕ броадкаста нового фасета.
    function checkAddGroupUnmounted(bytes4[] memory sels, address diamond) public view {
        for (uint256 i = 0; i < sels.length; i++) {
            require(
                IDiamondLoupe(diamond).facetAddress(sels[i]) == address(0),
                unicode"UpgradePresentationRecord: селектор из Add уже где-то смонтирован — Add ревертнёт"
            );
        }
    }

    /// Каждый селектор группы ведёт на ожидаемый (новый) адрес фасета.
    function assertRouted(bytes4[] memory sels, address expected, address diamond) public view {
        for (uint256 i = 0; i < sels.length; i++) {
            require(
                IDiamondLoupe(diamond).facetAddress(sels[i]) == expected,
                unicode"UpgradePresentationRecord: селектор не приземлился на новый фасет"
            );
        }
    }

    /// У старого адреса фасета не осталось ни одного селектора — полностью
    /// вытеснен, а не разъехался наполовину.
    function assertFacetHoldsNoSelectors(address facetAddr, address diamond) public view {
        require(
            IDiamondLoupe(diamond).facetFunctionSelectors(facetAddr).length == 0,
            unicode"UpgradePresentationRecord: у старого адреса фасета после разреза остались селекторы"
        );
    }

    /// Функциональный смоук: getNoResponseFloor() ЧЕРЕЗ ДАЙМОНД (не прямым
    /// вызовом фасета) исполняется и отдаёт РОВНО сутки.
    ///
    /// Сверяется значение, а не факт возврата, и это не придирка: пол объявлен
    /// в контракте и только там (замысел 5.2), фронт спрашивает его у цепи и
    /// рисует человеку «столько ждать». Диамонд, отвечающий другим числом —
    /// например потому, что Replace/Add легли на чужой адрес с похожей
    /// сигнатурой, — маршрутно выглядит здоровым, а обещает неправду.
    function assertNoResponseFloorAnswers(address diamond) public view {
        require(
            INoResponseFloorProbe(diamond).getNoResponseFloor() == EXPECTED_NO_RESPONSE_FLOOR,
            unicode"post-flight: пол записи о молчании не отвечает через диамонд"
        );
    }

    // ════════════════════════════════════════════════════════════════════
    // Целостность хранилища — читает значения, которые уже лежали в
    // арбитражном неймспейсе ДО разреза, не только маршрутизацию селекторов.
    // ════════════════════════════════════════════════════════════════════

    struct StorageSnapshot {
        uint256 arbiterCount;
        uint256 vaultBalance;
        uint256 arbiterFloor;
    }

    /// Три чтения существующих полей арбитражного неймспейса ЧЕРЕЗ ДАЙМОНД.
    /// getArbiterFloor() возвращает DEFAULT_ARBITER_FLOOR, если поле нулевое
    /// (см. сам фасет) — это всё ещё чтение существующего поля, не выдумка:
    /// если раскладка сдвинется, значение прыгнет вместе с остальными, а не
    /// молча останется дефолтным.
    function snapshotArbiterStorage(address diamond) public view returns (StorageSnapshot memory s) {
        ArbiterRegistryFacet f = ArbiterRegistryFacet(diamond);
        s.arbiterCount = f.getArbiters().length;
        s.vaultBalance = f.getVaultBalance();
        s.arbiterFloor = f.getArbiterFloor();
    }

    /// Три значения, снятые ДО и ПОСЛЕ разреза, обязаны совпасть буквально —
    /// diamondCut ничего не должен писать в чужой неймспейс. Расхождение
    /// здесь — тот же класс сигнала, что Panic(0x22) на getOpenJobs() после
    /// смены раскладки JobBoard в июле 2026: раскладка сдвинулась, и старые
    /// записи читаются не с тех слотов.
    function assertStorageContinuity(StorageSnapshot memory beforeCut, StorageSnapshot memory afterCut)
        public pure
    {
        require(
            afterCut.arbiterCount == beforeCut.arbiterCount,
            unicode"post-flight: getArbiters().length изменился поперёк разреза — раскладка могла сдвинуться"
        );
        require(
            afterCut.vaultBalance == beforeCut.vaultBalance,
            unicode"post-flight: getVaultBalance() изменился поперёк разреза — раскладка могла сдвинуться"
        );
        require(
            afterCut.arbiterFloor == beforeCut.arbiterFloor,
            unicode"post-flight: getArbiterFloor() изменился поперёк разреза — раскладка могла сдвинуться"
        );
    }

    // ════════════════════════════════════════════════════════════════════
    // Споры, взятые ДО разреза — громкое предупреждение, не require.
    // ════════════════════════════════════════════════════════════════════

    /// Спор, заклеймленный ДО этого разреза, после cut'а сохраняет арбитра в
    /// disputeClaims (openClaimCount у него > 0), а якоря времени взятия по
    /// нему в цепи нет и быть не может: поле disputeClaimedAtBy дописано этим
    /// же PR, и до него писать в него было нечему. recordNoResponse таким
    /// спорам отказывает закрыто (ClaimTimeUnknown, решение владельца 14
    /// августа 2026 — кода переноса нет вовсе). Лекарство дешёвое: арбитр зовёт
    /// releaseDisputeClaim и берёт спор заново — тогда время запишется.
    /// НЕ require: эти заявки взяты законно, до разреза никакого якоря не
    /// требовалось, и падать здесь было бы неправдой.
    ///
    /// НЕ вызывает getDisputeClaimedAt(): эта функция зовётся ДО broadcast
    /// (пред-полёт), а getDisputeClaimedAt — сам один из восьми Add-селекторов
    /// ЭТОГО же cut'а, то есть на живом даймонде в этот момент ещё НЕ
    /// смонтирован — вызов ревертнул бы "Diamond: Function does not exist" и
    /// уронил бы весь скрипт вместо того, чтобы напечатать предупреждение.
    /// Читать его и не нужно: до этого разреза якорь не мог появиться в
    /// принципе, поэтому у любого арбитра с openClaimCount > 0 он
    /// гарантированно нулевой. Одного openClaimCount (существующий селектор,
    /// часть Replace) достаточно.
    ///
    /// Перечисляет по текущему списку зарегистрированных арбитров
    /// (getArbiters()) — арбитра, уже потерявшего статус, но всё ещё сидящего в
    /// disputeClaims с открытым счётчиком, этот обход не найдёт; это отдельный,
    /// более редкий случай.
    function findArbitersWithPreCutClaims(address diamond) public view returns (address[] memory flagged) {
        ArbiterRegistryFacet f = ArbiterRegistryFacet(diamond);
        address[] memory arbiters = f.getArbiters();

        uint256 count;
        bool[] memory hit = new bool[](arbiters.length);
        for (uint256 i = 0; i < arbiters.length; i++) {
            if (f.getOpenClaimCount(arbiters[i]) == 0) continue;
            hit[i] = true;
            count++;
        }

        flagged = new address[](count);
        uint256 k;
        for (uint256 i = 0; i < arbiters.length; i++) {
            if (hit[i]) flagged[k++] = arbiters[i];
        }
    }

    function warnArbitersWithPreCutClaims(address diamond) public view {
        address[] memory flagged = findArbitersWithPreCutClaims(diamond);
        console.log("=== Pre-flight: arbiters holding claims taken BEFORE this cut ===");
        if (flagged.length == 0) {
            console.log("  none.");
            return;
        }
        for (uint256 i = 0; i < flagged.length; i++) {
            console.log("  NO CLAIM ANCHOR - arbiter:", flagged[i]);
            console.log("    openClaimCount:", ArbiterRegistryFacet(diamond).getOpenClaimCount(flagged[i]));
            console.log("    -> recordNoResponse will revert ClaimTimeUnknown");
            console.log("    -> cure: releaseDisputeClaim(deal) and claim it again");
        }
        console.log("Total arbiters whose open claims predate this cut:", flagged.length);
    }

    function totalRoutedSelectors(address diamond) public view returns (uint256 total) {
        IDiamondLoupe.Facet[] memory all = IDiamondLoupe(diamond).facets();
        for (uint256 i = 0; i < all.length; i++) total += all[i].functionSelectors.length;
    }

    /// Вынесено в public pure, чтобы тест проверял состав cut'а без выкатки.
    function buildCuts(address facet)
        public pure returns (IDiamondCut.FacetCut[] memory cuts)
    {
        cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = _cut(facet, IDiamondCut.FacetCutAction.Replace, replaceSelectors());
        cuts[1] = _cut(facet, IDiamondCut.FacetCutAction.Add,     addSelectors());
    }

    /// Восемь новых входов Задач 1-3. Полнота и отсутствие пересечения с
    /// Replace проверяются тестом против скомпилированного ABI, не глазами:
    /// поиск строк `function ... external` пропускает функции, у которых
    /// подпись занимает две строки (ровно так был потерян
    /// getPresentationDigestsPage при первом счёте).
    function addSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](8);

        // Задача 1: момент взятия спора
        sels[0] = ArbiterRegistryFacet.getDisputeClaimedAt.selector;

        // Задача 2: запись «просил, ответа нет» + пол в сутки
        sels[1] = ArbiterRegistryFacet.recordNoResponse.selector;
        sels[2] = ArbiterRegistryFacet.getNoResponseAt.selector;
        sels[3] = ArbiterRegistryFacet.getNoResponseFloor.selector;

        // Задача 3: отпечаток предъявления + чтение ленты
        sels[4] = ArbiterRegistryFacet.recordPresentationDigest.selector;
        sels[5] = ArbiterRegistryFacet.getPresentationDigests.selector;
        sels[6] = ArbiterRegistryFacet.getPresentationDigestCount.selector;
        sels[7] = ArbiterRegistryFacet.getPresentationDigestsPage.selector;
    }

    /// Все смонтированные сегодня селекторы фасета — 56 штук, тот же список,
    /// что script/DeployFull.s.sol::arbiterRegistryFacetSelectors() держал до
    /// этой работы. Ни одна прежняя подпись не менялась, поэтому здесь ровно
    /// «всё, кроме восьми новых». Полнота проверяется тестом против
    /// скомпилированного ABI, не глазами.
    function replaceSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](56);

        // DAO-режим
        sels[0]  = ArbiterRegistryFacet.activateDAO.selector;
        sels[1]  = ArbiterRegistryFacet.applyAsArbiter.selector;
        sels[2]  = ArbiterRegistryFacet.resignAsArbiter.selector;

        // Admin: управление арбитрами
        sels[3]  = ArbiterRegistryFacet.setChiefArbiter.selector;
        sels[4]  = ArbiterRegistryFacet.addArbiter.selector;
        sels[5]  = ArbiterRegistryFacet.removeArbiter.selector;

        // Клейм спора (commit-reveal)
        sels[6]  = ArbiterRegistryFacet.commitDisputeClaim.selector;
        sels[7]  = ArbiterRegistryFacet.claimDispute.selector;
        sels[8]  = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        sels[9]  = ArbiterRegistryFacet.clearDisputeClaim.selector;

        // Вердикт
        sels[10] = ArbiterRegistryFacet.submitVerdict.selector;
        sels[11] = ArbiterRegistryFacet.finalizeVerdict.selector;
        sels[12] = ArbiterRegistryFacet.overturnVerdict.selector;
        sels[13] = ArbiterRegistryFacet.notifyArbiterTimeout.selector;
        sels[14] = ArbiterRegistryFacet.freezeVerdict.selector;
        sels[15] = ArbiterRegistryFacet.unfreezeVerdict.selector;
        sels[16] = ArbiterRegistryFacet.clearStuckVerdict.selector;

        // Апелляция
        sels[17] = ArbiterRegistryFacet.raiseAppeal.selector;
        sels[18] = ArbiterRegistryFacet.voteOnAppeal.selector;
        sels[19] = ArbiterRegistryFacet.resolveAppeal.selector;

        // Вознаграждения
        sels[20] = ArbiterRegistryFacet.withdrawArbiterReward.selector;
        sels[21] = ArbiterRegistryFacet.fundVault.selector;
        sels[22] = ArbiterRegistryFacet.setRewardPerDispute.selector;
        sels[23] = ArbiterRegistryFacet.setDAOAddress.selector;

        // Views
        sels[24] = ArbiterRegistryFacet.isDaoActive.selector;
        sels[25] = ArbiterRegistryFacet.getMinXPToRegister.selector;
        sels[26] = ArbiterRegistryFacet.getDaoThreshold.selector;
        sels[27] = ArbiterRegistryFacet.getChiefArbiter.selector;
        sels[28] = ArbiterRegistryFacet.isRegisteredArbiter.selector;
        sels[29] = ArbiterRegistryFacet.getArbiters.selector;
        sels[30] = ArbiterRegistryFacet.getDisputeClaimer.selector;
        sels[31] = ArbiterRegistryFacet.getArbiterDeals.selector;
        sels[32] = ArbiterRegistryFacet.getClaimCommitment.selector;
        sels[33] = ArbiterRegistryFacet.getPendingVerdict.selector;
        sels[34] = ArbiterRegistryFacet.getArbiterReward.selector;
        sels[35] = ArbiterRegistryFacet.getVaultBalance.selector;
        sels[36] = ArbiterRegistryFacet.getRewardPerDispute.selector;
        sels[37] = ArbiterRegistryFacet.getDAOAddress.selector;
        sels[38] = ArbiterRegistryFacet.getArbiterMistakeStreak.selector;
        sels[39] = ArbiterRegistryFacet.hasSubmittedVerdict.selector;
        sels[40] = ArbiterRegistryFacet.getAppealVotes.selector;
        sels[41] = ArbiterRegistryFacet.hasVotedOnAppeal.selector;
        sels[42] = ArbiterRegistryFacet.getArbiterBond.selector;
        sels[43] = ArbiterRegistryFacet.getOpenClaimCount.selector;

        // Сбор со спора (3% от спорной суммы) — 80/20 арбитр/казна
        sels[44] = ArbiterRegistryFacet.creditDisputeFee.selector;
        sels[45] = ArbiterRegistryFacet.withdrawTreasurySlice.selector;
        sels[46] = ArbiterRegistryFacet.getTreasurySlice.selector;

        // Платный вызов арбитра: порог и котировка доплаты до него
        sels[47] = ArbiterRegistryFacet.setArbiterFloor.selector;
        sels[48] = ArbiterRegistryFacet.getArbiterFloor.selector;
        sels[49] = ArbiterRegistryFacet.quoteDisputeTopUp.selector;

        // Платный вызов арбитра: оплата и мягкий возврат доплаты
        sels[50] = ArbiterRegistryFacet.fundDispute.selector;
        sels[51] = ArbiterRegistryFacet.getDisputeBounty.selector;
        sels[52] = ArbiterRegistryFacet.withdrawDisputeBounty.selector;
        sels[53] = ArbiterRegistryFacet.getRefundableBounty.selector;

        // Ключи чата арбитра (4б, 9 августа 2026)
        sels[54] = ArbiterRegistryFacet.getArbiterChatKeys.selector;
        sels[55] = ArbiterRegistryFacet.setArbiterChatKey.selector;

        // Восемь новых входов Задач 1-3 — в Add, не здесь (см. addSelectors()).
    }

    function _cut(address facet, IDiamondCut.FacetCutAction action, bytes4[] memory sels)
        internal pure returns (IDiamondCut.FacetCut memory)
    {
        return IDiamondCut.FacetCut({
            facetAddress: facet,
            action: action,
            functionSelectors: sels
        });
    }
}
