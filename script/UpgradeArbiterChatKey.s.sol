// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";
import {IDiamondCut} from "../src/DiamondProxy.sol";

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
 */
contract UpgradeArbiterChatKey is Script {
    function run() external {
        address diamond = vm.envAddress("DIAMOND_ADDRESS");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        require(diamond != address(0), "DIAMOND_ADDRESS not set");

        vm.startBroadcast(pk);
        ArbiterRegistryFacet facet = new ArbiterRegistryFacet();
        IDiamondCut(diamond).diamondCut(buildCuts(address(facet)), address(0), "");
        vm.stopBroadcast();

        console.log("ArbiterRegistryFacet:", address(facet));
        console.log("Remove 1 / Replace", replaceSelectors().length, "/ Add", addSelectors().length);
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
