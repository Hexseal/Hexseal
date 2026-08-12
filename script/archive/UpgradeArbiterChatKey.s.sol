// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import {ArbiterRegistryFacet} from "../../src/facets/ArbiterRegistryFacet.sol";
import {IDiamondCut, IDiamondLoupe} from "../../src/DiamondProxy.sol";

/**
 * 4б: ключи чата арбитра в цепи.
 *
 * ОДИН diamondCut из трёх действий:
 *   Remove  — старый селектор заявки claimDispute(address,bytes32);
 *   Replace — все остальные селекторы фасета на новый адрес;
 *   Add     — новая заявка, setArbiterChatKey, getArbiterChatKeys.
 *
 * Почему одним, а не тремя вызовами: между операциями диамонд не должен
 * оказаться в состоянии «есть оба входа заявки» — второй вход берёт спор БЕЗ
 * ключа, то есть остаётся ровно та дыра, которую правка закрывает.
 *
 * Почему Replace обязателен: без него 53 селектора фасета остались бы на
 * прежнем адресе, и диамонд поехал бы наполовину старым кодом.
 *
 * ── Pre/post-flight ──────────────────────────────────────────────────────
 * Форма — script/UpgradePaidArbitration.s.sol:166-171, :202-205, помощники
 * :259-299. Replace на адрес, у которого нужного селектора нет, НЕ ревертит
 * (DiamondCutLib.replaceFunctions проверяет только «адрес другой и есть код»,
 * не «реализует ли он этот селектор») — тихий разъезд «смонтировано, но не
 * работает» ровно того класса, что уже ломал fundDispute на msg.sender вместо
 * _msgSender() (d172064): задеплоено, ни разу не сработало, никто не заметил
 * до отдельного разбора. Поэтому до broadcast проверяется, что Replace/Remove
 * целятся в один и тот же реально смонтированный старый адрес, а Add — в
 * пока не смонтированные селекторы; после broadcast — что Replace/Add легли
 * на новый адрес, старый адрес опустел, Remove увёл в никуда, и вдобавок
 * функциональный смоук: getArbiterChatKeys ЧЕРЕЗ ДАЙМОНД реально исполняется
 * (не ревертит, отдаёт нули), а не просто числится в loupe.
 *
 * ── Целостность хранилища (найдено финальным ревью 9 августа) ────────────
 * Всё выше проверяет МАРШРУТИЗАЦИЮ селекторов — ни одна из проверок не
 * читает ни одного значения, которое уже лежало в арбитражном неймспейсе
 * ДО разреза. Это ровно тот класс, что в июле 2026 сломал JobBoard:
 * getOpenJobs() начал ревертить Panic(0x22) на живом хранилище после смены
 * раскладки, а статические гейты (селекторы, ABI) этого не видели — увидеть
 * может только чтение настоящего состояния до и после. Поэтому здесь читаются
 * getArbiters().length, getVaultBalance() и getArbiterFloor() ДО
 * vm.startBroadcast и снова ПОСЛЕ vm.stopBroadcast, с require на равенство —
 * доказательство на реальных данных, а не на факте, что cut прошёл.
 */
contract UpgradeArbiterChatKey is Script {
    function run() external {
        address diamond = vm.envAddress("DIAMOND_ADDRESS");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        require(diamond != address(0), "DIAMOND_ADDRESS not set");

        bytes4[] memory removeSels  = removeSelectors();
        bytes4[] memory replaceSels = replaceSelectors();
        bytes4[] memory addSels     = addSelectors();

        // ── Pre-flight ────────────────────────────────────────────────────
        console.log("=== UpgradeArbiterChatKey: pre-flight ===");
        address oldFacet = checkReplaceGroup(replaceSels, diamond);
        checkRemoveSelectorMounted(removeSels, oldFacet, diamond);
        checkAddGroupUnmounted(addSels, diamond);
        console.log("Old ArbiterRegistryFacet currently mounted at:", oldFacet);

        uint256 selectorsBefore = totalRoutedSelectors(diamond);
        console.log("Total routed selectors BEFORE cut:", selectorsBefore);

        // Значения, которые уже лежат в арбитражном неймспейсе — читаются
        // ДО broadcast, сверяются с тем же чтением ПОСЛЕ. Форма — ниже,
        // snapshotArbiterStorage/assertStorageContinuity.
        StorageSnapshot memory before = snapshotArbiterStorage(diamond);
        console.log("Arbiter storage BEFORE cut - arbiters:", before.arbiterCount);
        console.log("  vaultBalance:", before.vaultBalance);
        console.log("  arbiterFloor:", before.arbiterFloor);

        warnArbitersWithOpenClaimsMissingKeys(diamond);
        console.log("");

        // ── Апгрейд ───────────────────────────────────────────────────────
        vm.startBroadcast(pk);
        ArbiterRegistryFacet facet = new ArbiterRegistryFacet();
        IDiamondCut(diamond).diamondCut(buildCuts(address(facet)), address(0), "");
        vm.stopBroadcast();

        console.log("ArbiterRegistryFacet:", address(facet));
        console.log("Remove 1 / Replace", replaceSels.length, "/ Add", addSels.length);
        console.log("");

        // ── Post-flight ───────────────────────────────────────────────────
        console.log("=== Post-flight ===");
        assertRouted(replaceSels, address(facet), diamond);
        assertRouted(addSels,     address(facet), diamond);
        assertFacetHoldsNoSelectors(oldFacet, diamond);
        assertSelectorsUnrouted(removeSels, diamond);
        console.log("Replace/Add -> new facet, old facet emptied, Remove routes nowhere.");

        StorageSnapshot memory afterCut = snapshotArbiterStorage(diamond);
        assertStorageContinuity(before, afterCut);
        console.log("Arbiter storage AFTER cut  - arbiters:", afterCut.arbiterCount);
        console.log("  vaultBalance:", afterCut.vaultBalance);
        console.log("  arbiterFloor:", afterCut.arbiterFloor);
        console.log("Storage continuity OK: arbiters/vaultBalance/arbiterFloor unchanged by the cut.");

        (bytes32 boxKey, bytes32 signKey) = smokeGetArbiterChatKeys(diamond, address(0xDEAD));
        require(
            boxKey == bytes32(0) && signKey == bytes32(0),
            "post: smoke call to getArbiterChatKeys through the diamond did not return zeros"
        );
        console.log("Smoke getArbiterChatKeys(0x...DEAD) through diamond did not revert, returned (0, 0).");

        uint256 selectorsAfter = totalRoutedSelectors(diamond);
        require(
            selectorsAfter == selectorsBefore - removeSels.length + addSels.length,
            "post: routed selector count did not move by exactly -Remove +Add"
        );
        console.log("Total routed selectors AFTER cut:", selectorsAfter);
    }

    // ════════════════════════════════════════════════════════════════════
    // Pre/post-flight helpers — public так, чтобы test/ArbiterChatKeyUpgrade.t.sol
    // мог звать их напрямую против локально развёрнутого даймонда, не только
    // против живой цепи внутри run(). Форма — script/UpgradePaidArbitration.s.sol:259-299.
    // ════════════════════════════════════════════════════════════════════

    /// Каждый селектор группы смонтирован сейчас, и все указывают на ОДИН и
    /// тот же адрес — иначе список Replace выведен неверно (фасет уже
    /// разъехался по нескольким адресам, и Replace на единый новый адрес
    /// был бы неверной операцией). Возвращает этот адрес.
    function checkReplaceGroup(bytes4[] memory sels, address diamond)
        public view returns (address facetAddr)
    {
        require(sels.length > 0, "UpgradeArbiterChatKey: replace group is empty");
        facetAddr = IDiamondLoupe(diamond).facetAddress(sels[0]);
        require(facetAddr != address(0), "UpgradeArbiterChatKey: selector[0] of Replace is not mounted");
        for (uint256 i = 0; i < sels.length; i++) {
            address a = IDiamondLoupe(diamond).facetAddress(sels[i]);
            require(a != address(0), "UpgradeArbiterChatKey: a Replace selector is not mounted");
            require(a == facetAddr, "UpgradeArbiterChatKey: Replace selectors are split across more than one live facet address");
        }
    }

    /// Удаляемый селектор смонтирован сейчас и живёт на ТОМ ЖЕ адресе, что и
    /// группа Replace — иначе Remove целится не в тот фасет, который
    /// апгрейдится этим cut'ом.
    function checkRemoveSelectorMounted(bytes4[] memory sels, address expectedFacet, address diamond) public view {
        require(sels.length == 1, "UpgradeArbiterChatKey: remove group must have exactly one selector");
        address a = IDiamondLoupe(diamond).facetAddress(sels[0]);
        require(a != address(0), "UpgradeArbiterChatKey: Remove selector is not mounted anywhere");
        require(a == expectedFacet, "UpgradeArbiterChatKey: Remove selector lives on a different facet address than the Replace group");
    }

    /// Ни один селектор группы ещё не смонтирован — иначе Add ревертит
    /// "selector exists" в DiamondCutLib.addFunctions, и вся выкатка падает.
    function checkAddGroupUnmounted(bytes4[] memory sels, address diamond) public view {
        for (uint256 i = 0; i < sels.length; i++) {
            require(
                IDiamondLoupe(diamond).facetAddress(sels[i]) == address(0),
                "UpgradeArbiterChatKey: an Add selector is already mounted somewhere - Add would revert"
            );
        }
    }

    /// Каждый селектор группы ведёт на ожидаемый (новый) адрес фасета.
    function assertRouted(bytes4[] memory sels, address expected, address diamond) public view {
        for (uint256 i = 0; i < sels.length; i++) {
            require(
                IDiamondLoupe(diamond).facetAddress(sels[i]) == expected,
                "UpgradeArbiterChatKey: a selector did not land on the new facet"
            );
        }
    }

    /// У старого адреса фасета не осталось ни одного селектора — полностью
    /// вытеснен, а не разъехался наполовину.
    function assertFacetHoldsNoSelectors(address facetAddr, address diamond) public view {
        require(
            IDiamondLoupe(diamond).facetFunctionSelectors(facetAddr).length == 0,
            "UpgradeArbiterChatKey: old facet address still holds selectors after the cut"
        );
    }

    /// Удалённый селектор больше никуда не ведёт (facetAddress -> address(0)).
    function assertSelectorsUnrouted(bytes4[] memory sels, address diamond) public view {
        for (uint256 i = 0; i < sels.length; i++) {
            require(
                IDiamondLoupe(diamond).facetAddress(sels[i]) == address(0),
                "UpgradeArbiterChatKey: a removed selector still routes somewhere"
            );
        }
    }

    /// Функциональный смоук: getArbiterChatKeys ЧЕРЕЗ ДАЙМОНД (не прямой
    /// вызов фасета) не ревертит и отдаёт нули для адреса без записанных
    /// ключей. Отличает «селектор числится смонтированным по loupe» от
    /// «маршрут правда исполняет код нового фасета» — именно та разница,
    /// которую Replace на нереализующий адрес не ловит никак иначе.
    function smokeGetArbiterChatKeys(address diamond, address probe)
        public view returns (bytes32 boxKey, bytes32 signKey)
    {
        return ArbiterRegistryFacet(diamond).getArbiterChatKeys(probe);
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
    /// getArbiterFloor() возвращает DEFAULT_ARBITER_FLOOR, если поле в
    /// хранилище нулевое (см. сам фасет) — это всё ещё чтение существующего
    /// поля, не выдумка: если раскладка сдвинется, значение прыгнет вместе с
    /// остальными, а не молча останется дефолтным.
    function snapshotArbiterStorage(address diamond) public view returns (StorageSnapshot memory s) {
        ArbiterRegistryFacet f = ArbiterRegistryFacet(diamond);
        s.arbiterCount = f.getArbiters().length;
        s.vaultBalance = f.getVaultBalance();
        s.arbiterFloor = f.getArbiterFloor();
    }

    /// Три значения, снятые ДО и ПОСЛЕ cut'а, обязаны совпасть буквально —
    /// diamondCut ничего не должен писать в чужой неймспейс. Расхождение
    /// здесь — тот же класс сигнала, что Panic(0x22) на getOpenJobs() после
    /// смены раскладки JobBoard в июле 2026: раскладка сдвинулась, и старые
    /// записи читаются не с тех слотов.
    function assertStorageContinuity(StorageSnapshot memory beforeCut, StorageSnapshot memory afterCut) public pure {
        require(
            afterCut.arbiterCount == beforeCut.arbiterCount,
            "post: getArbiters().length changed across the cut - storage layout may have shifted"
        );
        require(
            afterCut.vaultBalance == beforeCut.vaultBalance,
            "post: getVaultBalance() changed across the cut - storage layout may have shifted"
        );
        require(
            afterCut.arbiterFloor == beforeCut.arbiterFloor,
            "post: getArbiterFloor() changed across the cut - storage layout may have shifted"
        );
    }

    // ════════════════════════════════════════════════════════════════════
    // Заявки, взятые старой подписью — громкое предупреждение, не require.
    // ════════════════════════════════════════════════════════════════════

    /// Спор, заклеймленный ДО апгрейда, после cut'а сохраняет арбитра в
    /// disputeClaims (openClaimCount у него > 0), а getArbiterChatKeys по
    /// нему отдаёт нули — ключей у старой заявки не было и не могло быть.
    /// getArbiterChatKeys учит читать нули как «предъявлять некому», так что
    /// сторона молча решит, что предъявить нечего — а лекарство есть:
    /// арбитр сам зовёт setArbiterChatKey() в любой момент, даже посреди
    /// открытого спора (гейт там — isArbiter, не отсутствие ключа). НЕ
    /// require: эти заявки взяты законно, до апгрейда никакого ключа не
    /// требовалось, и падать здесь было бы неправдой.
    ///
    /// НЕ вызывает getArbiterChatKeys(): эта функция зовётся ДО broadcast
    /// (пред-полёт), а getArbiterChatKeys — сам один из трёх Add-селекторов
    /// этого же cut'а, то есть на живом даймонде в этот момент ещё НЕ
    /// смонтирован — вызов ревертнул бы "Diamond: Function does not exist".
    /// Читать его и не нужно: до ЭТОГО апгрейда setArbiterChatKey не
    /// существовал вовсе, значит ключа не могло появиться в принципе — у
    /// любого арбитра с openClaimCount > 0 он гарантированно отсутствует.
    /// Одного openClaimCount (существующий селектор, часть Replace)
    /// достаточно.
    ///
    /// Перечисляет по текущему списку зарегистрированных арбитров
    /// (getArbiters()) — арбитра, уже потерявшего статус, но всё ещё
    /// сидящего в disputeClaims с открытым счётчиком, этот обход не найдёт;
    /// это отдельный, более редкий случай (см. предупреждение в докстринге
    /// setArbiterChatKey про исключение из «петля замыкается сама»).
    function findArbitersWithOpenClaimsMissingKeys(address diamond) public view returns (address[] memory flagged) {
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

    function warnArbitersWithOpenClaimsMissingKeys(address diamond) public view {
        address[] memory flagged = findArbitersWithOpenClaimsMissingKeys(diamond);
        console.log("=== Pre-flight: arbiters with open claims and no chat key ===");
        if (flagged.length == 0) {
            console.log("  none.");
            return;
        }
        for (uint256 i = 0; i < flagged.length; i++) {
            console.log("  MISSING KEY - arbiter:", flagged[i]);
            console.log("    openClaimCount:", ArbiterRegistryFacet(diamond).getOpenClaimCount(flagged[i]));
            console.log("    -> must call setArbiterChatKey(boxKey, signKey) after this upgrade");
        }
        console.log("Total arbiters needing setArbiterChatKey after upgrade:", flagged.length);
    }

    function totalRoutedSelectors(address diamond) public view returns (uint256 total) {
        IDiamondLoupe.Facet[] memory all = IDiamondLoupe(diamond).facets();
        for (uint256 i = 0; i < all.length; i++) total += all[i].functionSelectors.length;
    }

    /// Вынесено в public pure, чтобы тест проверял состав cut'а без выкатки.
    function buildCuts(address facet)
        public pure returns (IDiamondCut.FacetCut[] memory cuts)
    {
        cuts = new IDiamondCut.FacetCut[](3);
        cuts[0] = _cut(address(0), IDiamondCut.FacetCutAction.Remove,  removeSelectors());
        cuts[1] = _cut(facet,      IDiamondCut.FacetCutAction.Replace, replaceSelectors());
        cuts[2] = _cut(facet,      IDiamondCut.FacetCutAction.Add,     addSelectors());
    }

    function removeSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](1);
        sels[0] = bytes4(keccak256("claimDispute(address,bytes32)"));
    }

    function addSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](3);
        sels[0] = ArbiterRegistryFacet.claimDispute.selector;
        sels[1] = ArbiterRegistryFacet.setArbiterChatKey.selector;
        sels[2] = ArbiterRegistryFacet.getArbiterChatKeys.selector;
    }

    /// Все смонтированные селекторы фасета, КРОМЕ трёх новых и удаляемого.
    /// Список — из script/DeployFull.s.sol, arbiterRegistryFacetSelectors()
    /// (56 селекторов), минус claimDispute (новая подпись, идёт в Add) и
    /// setArbiterChatKey/getArbiterChatKeys (новые, тоже в Add). Полнота
    /// проверяется тестом против скомпилированного ABI, не глазами.
    function replaceSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](53);

        // DAO-режим
        sels[0]  = ArbiterRegistryFacet.activateDAO.selector;
        sels[1]  = ArbiterRegistryFacet.applyAsArbiter.selector;
        sels[2]  = ArbiterRegistryFacet.resignAsArbiter.selector;

        // Admin: управление арбитрами
        sels[3]  = ArbiterRegistryFacet.setChiefArbiter.selector;
        sels[4]  = ArbiterRegistryFacet.addArbiter.selector;
        sels[5]  = ArbiterRegistryFacet.removeArbiter.selector;

        // Клейм спора (commit-reveal) — сама claimDispute здесь НЕ стоит:
        // подпись сменилась, новый селектор идёт в Add.
        sels[6]  = ArbiterRegistryFacet.commitDisputeClaim.selector;
        sels[7]  = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        sels[8]  = ArbiterRegistryFacet.clearDisputeClaim.selector;

        // Вердикт
        sels[9]  = ArbiterRegistryFacet.submitVerdict.selector;
        sels[10] = ArbiterRegistryFacet.finalizeVerdict.selector;
        sels[11] = ArbiterRegistryFacet.overturnVerdict.selector;
        sels[12] = ArbiterRegistryFacet.notifyArbiterTimeout.selector;
        sels[13] = ArbiterRegistryFacet.freezeVerdict.selector;
        sels[14] = ArbiterRegistryFacet.unfreezeVerdict.selector;
        sels[15] = ArbiterRegistryFacet.clearStuckVerdict.selector;

        // Апелляция
        sels[16] = ArbiterRegistryFacet.raiseAppeal.selector;
        sels[17] = ArbiterRegistryFacet.voteOnAppeal.selector;
        sels[18] = ArbiterRegistryFacet.resolveAppeal.selector;

        // Вознаграждения
        sels[19] = ArbiterRegistryFacet.withdrawArbiterReward.selector;
        sels[20] = ArbiterRegistryFacet.fundVault.selector;
        sels[21] = ArbiterRegistryFacet.setRewardPerDispute.selector;
        sels[22] = ArbiterRegistryFacet.setDAOAddress.selector;

        // Views
        sels[23] = ArbiterRegistryFacet.isDaoActive.selector;
        sels[24] = ArbiterRegistryFacet.getMinXPToRegister.selector;
        sels[25] = ArbiterRegistryFacet.getDaoThreshold.selector;
        sels[26] = ArbiterRegistryFacet.getChiefArbiter.selector;
        sels[27] = ArbiterRegistryFacet.isRegisteredArbiter.selector;
        sels[28] = ArbiterRegistryFacet.getArbiters.selector;
        sels[29] = ArbiterRegistryFacet.getDisputeClaimer.selector;
        sels[30] = ArbiterRegistryFacet.getArbiterDeals.selector;
        sels[31] = ArbiterRegistryFacet.getClaimCommitment.selector;
        sels[32] = ArbiterRegistryFacet.getPendingVerdict.selector;
        sels[33] = ArbiterRegistryFacet.getArbiterReward.selector;
        sels[34] = ArbiterRegistryFacet.getVaultBalance.selector;
        sels[35] = ArbiterRegistryFacet.getRewardPerDispute.selector;
        sels[36] = ArbiterRegistryFacet.getDAOAddress.selector;
        sels[37] = ArbiterRegistryFacet.getArbiterMistakeStreak.selector;
        sels[38] = ArbiterRegistryFacet.hasSubmittedVerdict.selector;
        sels[39] = ArbiterRegistryFacet.getAppealVotes.selector;
        sels[40] = ArbiterRegistryFacet.hasVotedOnAppeal.selector;
        sels[41] = ArbiterRegistryFacet.getArbiterBond.selector;
        sels[42] = ArbiterRegistryFacet.getOpenClaimCount.selector;

        // Сбор со спора (3% от спорной суммы) — 80/20 арбитр/казна
        sels[43] = ArbiterRegistryFacet.creditDisputeFee.selector;
        sels[44] = ArbiterRegistryFacet.withdrawTreasurySlice.selector;
        sels[45] = ArbiterRegistryFacet.getTreasurySlice.selector;

        // Платный вызов арбитра: порог и котировка доплаты до него
        sels[46] = ArbiterRegistryFacet.setArbiterFloor.selector;
        sels[47] = ArbiterRegistryFacet.getArbiterFloor.selector;
        sels[48] = ArbiterRegistryFacet.quoteDisputeTopUp.selector;

        // Платный вызов арбитра: оплата и мягкий возврат доплаты
        sels[49] = ArbiterRegistryFacet.fundDispute.selector;
        sels[50] = ArbiterRegistryFacet.getDisputeBounty.selector;
        sels[51] = ArbiterRegistryFacet.withdrawDisputeBounty.selector;
        sels[52] = ArbiterRegistryFacet.getRefundableBounty.selector;

        // getArbiterChatKeys/setArbiterChatKey и новая claimDispute — в Add,
        // не здесь (см. addSelectors()).
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
