// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

// ============================================================
// UpgradeReputationFacetCounterpartyGate.s.sol
//
// Заменяет ReputationFacet в Diamond: cleanStreak инкрементится и Phase-2 XP
// начисляется только если у контрагента конкретной сделки уже есть
// xp >= MIN_COUNTERPARTY_XP (50) — закрывает sybil-кольцо свежих кошельков,
// фармящих cleanStreak друг на друге.
//
// Replace: все существующие 8 селекторов (whole-facet redeploy, см.
//   UpgradeReputationFacetCleanStreak.s.sol). Новых external функций нет —
//   изменились только внутренние _evalStreakOnce/_awardXP.
//
// Применять вместе с UpgradeArbiterRegistryFacetBondAndGuard.s.sol.
//
// Usage:
//   forge script script/UpgradeReputationFacetCounterpartyGate.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../../src/facets/ReputationFacet.sol";
import "../../src/DiamondProxy.sol";

contract UpgradeReputationFacetCounterpartyGate is Script {
    address constant DIAMOND = 0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        ReputationFacet facet = new ReputationFacet();
        console.log("New ReputationFacet:", address(facet));

        bytes4[] memory replaceSels = new bytes4[](8);
        replaceSels[0] = ReputationFacet.claimXP.selector;
        replaceSels[1] = ReputationFacet.getXP.selector;
        replaceSels[2] = ReputationFacet.getUniqueActiveUsers.selector;
        replaceSels[3] = ReputationFacet.hasClaimed.selector;
        replaceSels[4] = ReputationFacet.isDealWin.selector;
        replaceSels[5] = ReputationFacet.autoAwardXP.selector;
        replaceSels[6] = ReputationFacet.notifyExecutorFault.selector;
        replaceSels[7] = ReputationFacet.getCleanStreak.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(facet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSels
        });

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        require(
            IDiamondLoupe(DIAMOND).facetAddress(ReputationFacet.autoAwardXP.selector) == address(facet),
            "autoAwardXP: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(ReputationFacet.getCleanStreak.selector) == address(facet),
            "getCleanStreak: wrong facet"
        );
        console.log("Verification passed.");

        vm.stopBroadcast();
    }
}
