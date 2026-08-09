// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";
import {IDiamondCut, IDiamondLoupe} from "../src/DiamondProxy.sol";

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
