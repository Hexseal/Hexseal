// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeArbiterRegistryDisputeFee.s.sol
//
// Ставит на ЖИВОЙ диамонд ArbiterRegistryFacet, умеющий принимать сбор за спор.
//
// Что меняется. У фасета появились три внешние функции:
//   creditDisputeFee(uint256)  — агримент переводит сбор и зовёт её, чтобы
//                                сбор разошёлся: доля арбитру в arbiterRewards,
//                                остаток в treasurySlice;
//   withdrawTreasurySlice()    — вытолкнуть накопленную долю казны текущему
//                                FactoryStorage.feeRecipient;
//   getTreasurySlice()         — чтение накопленной доли.
// Прежние 44 селектора остаются, их реализация переезжает на новый фасет.
//
// Почему это нельзя отложить. Пока фасет не выкачен, creditDisputeFee на
// диамонде НЕ СУЩЕСТВУЕТ: агримент переведёт сбор, получит провал зачисления,
// и деньги осядут на диамонде неучтёнными — ни один счётчик на них не
// указывает. Это не гипотеза. Ровно так 27 июля сломалась казна: правку
// fundVault выкатили только в исходники, фасет на диамонд не ушёл, distribute()
// возвращался успехом и ничего не перемещал. Поймали по расхождению между
// рапортом и балансом.
//
// ПОРЯДОК ВЫКАТКИ. Этот скрипт обязан пройти ДО
// script/UpgradeAgreementDisputeFee.s.sol, который переключает диамонд на
// реализацию Agreement, эти сборы отправляющую. Наоборот — это ровно
// повторение июльской ошибки, только уже деньгами спорящих сторон.
//
// Почему не чистый Replace, как было в UpgradeArbiterRegistryFundVault.s.sol.
// Там наборы селекторов совпадали побайтово. Здесь на диамонде 44 селектора,
// а у нового фасета 47: нужен Replace для существующих ПЛЮС Add для трёх
// новых, одним diamondCut. Replace несмонтированного селектора ревертит,
// Add уже смонтированного — тоже, поэтому оба списка проверяются до траты газа.
//
// Набор для замены берётся у самого диамонда через facetFunctionSelectors(),
// а не собирается руками: рукописный массив — это ещё один способ разойтись
// с реальностью, и ровно так в этом репозитории DeployFull отстал на сорок
// апгрейдов.
//
// Usage (сухой прогон — сначала всегда он):
//   forge script script/UpgradeArbiterRegistryDisputeFee.s.sol \
//     --rpc-url https://sepolia.base.org
//
// Usage (боевой запуск):
//   forge script script/UpgradeArbiterRegistryDisputeFee.s.sol \
//     --rpc-url https://sepolia.base.org --private-key $PRIVATE_KEY --broadcast -vvv
//
// RPC публичный намеренно: бесплатный тариф drpc валится по таймауту на
// скриптах, читающих диамонд несколько раз (docs/OPEN-ITEMS.md §5).
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DiamondProxy.sol";
import "../src/facets/ArbiterRegistryFacet.sol";

interface IDiamondOwner {
    function owner() external view returns (address);
}

interface ILoupe {
    function facetAddress(bytes4 selector) external view returns (address);
    function facetFunctionSelectors(address facet) external view returns (bytes4[] memory);
}

contract UpgradeArbiterRegistryDisputeFee is Script {
    uint256 constant EXPECTED_OLD_SELECTORS = 44;
    uint256 constant ADDED_SELECTORS        = 3;

    function run() external {
        address diamond     = vm.envAddress("DIAMOND_ADDRESS");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address broadcaster = vm.addr(deployerKey);

        require(diamond != address(0), "upgrade: DIAMOND_ADDRESS is zero");
        require(diamond.code.length > 0, "upgrade: DIAMOND_ADDRESS has no code");
        require(
            IDiamondOwner(diamond).owner() == broadcaster,
            "upgrade: PRIVATE_KEY is not the diamond owner - diamondCut would revert after a paid deploy"
        );

        // Прежний фасет ищем по селектору, который на нём точно есть.
        bytes4 fundVaultSel = ArbiterRegistryFacet.fundVault.selector;
        address oldFacet    = ILoupe(diamond).facetAddress(fundVaultSel);
        require(oldFacet != address(0), "upgrade: fundVault is not mounted at all");

        bytes4[] memory replaced = ILoupe(diamond).facetFunctionSelectors(oldFacet);
        require(
            replaced.length == EXPECTED_OLD_SELECTORS,
            "upgrade: unexpected selector count on the live facet - stop and look"
        );

        bytes4[] memory added = new bytes4[](ADDED_SELECTORS);
        added[0] = ArbiterRegistryFacet.creditDisputeFee.selector;
        added[1] = ArbiterRegistryFacet.withdrawTreasurySlice.selector;
        added[2] = ArbiterRegistryFacet.getTreasurySlice.selector;

        // Add уже смонтированного селектора ревертит. Если хоть один из трёх
        // где-то есть — состояние не то, которое ожидалось, и цена ошибки
        // это оплаченный деплой фасета впустую.
        for (uint256 i = 0; i < added.length; i++) {
            require(
                ILoupe(diamond).facetAddress(added[i]) == address(0),
                "upgrade: one of the three new selectors is already mounted - Add would revert"
            );
        }

        console.log("--- Before ---");
        console.log("Diamond:            ", diamond);
        console.log("Old arbiter facet:  ", oldFacet);
        console.log("Selectors to Replace:", replaced.length);
        console.log("Selectors to Add:   ", added.length);
        console.log("");

        vm.startBroadcast(deployerKey);

        ArbiterRegistryFacet newFacet = new ArbiterRegistryFacet();

        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](2);
        cut[0] = IDiamondCut.FacetCut({
            facetAddress:      address(newFacet),
            action:            IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaced
        });
        cut[1] = IDiamondCut.FacetCut({
            facetAddress:      address(newFacet),
            action:            IDiamondCut.FacetCutAction.Add,
            functionSelectors: added
        });

        IDiamondCut(diamond).diamondCut(cut, address(0), "");

        vm.stopBroadcast();

        // Проверяем результат чтением, а не верой в успешный вызов.
        for (uint256 i = 0; i < added.length; i++) {
            require(
                ILoupe(diamond).facetAddress(added[i]) == address(newFacet),
                "upgrade: a new selector did not land on the new facet"
            );
        }
        require(
            ILoupe(diamond).facetAddress(fundVaultSel) == address(newFacet),
            "upgrade: fundVault still routes to the old facet"
        );
        bytes4[] memory nowMounted = ILoupe(diamond).facetFunctionSelectors(address(newFacet));
        require(
            nowMounted.length == EXPECTED_OLD_SELECTORS + ADDED_SELECTORS,
            "upgrade: the new facet does not hold 47 selectors"
        );

        console.log("--- After ---");
        console.log("New arbiter facet:  ", address(newFacet));
        console.log("Selectors on it:    ", nowMounted.length);
        console.log("creditDisputeFee ->  ", ILoupe(diamond).facetAddress(added[0]));
        console.log("withdrawTreasurySlice ->", ILoupe(diamond).facetAddress(added[1]));
        console.log("getTreasurySlice ->  ", ILoupe(diamond).facetAddress(added[2]));
        console.log("fundVault ->         ", ILoupe(diamond).facetAddress(fundVaultSel));
        console.log("");
        console.log("Now, and only now, ship script/UpgradeAgreementDisputeFee.s.sol.");
        console.log("");
        console.log("Rollback - TWO steps, and the second one is easy to forget:");
        console.log("");
        console.log("  1) route the 44 old selectors back to the previous facet");
        console.log("     (Replace, action 1; build the list from the live diamond:");
        console.log("      cast call <diamond> \"facetFunctionSelectors(address)(bytes4[])\" <new>)");
        console.log("     <old> =", oldFacet);
        console.log("     <new> =", address(newFacet));
        console.log("");
        console.log("  2) unmount the three added selectors with Remove");
        console.log("     (action 2, facetAddress = address(0)):");
        console.log("       creditDisputeFee(uint256)");
        console.log("       withdrawTreasurySlice()");
        console.log("       getTreasurySlice()");
        console.log("     NOT a Replace onto the old facet. replaceFunctions never checks");
        console.log("     that the target actually implements the selector (DiamondProxy");
        console.log("     :173), so that cut would SUCCEED and leave three selectors");
        console.log("     pointing at a facet with no such function - every call then");
        console.log("     reverts in the fallback. Remove is the only correct action.");
        console.log("");
        console.log("  Two things step 2 must wait for:");
        console.log("    - roll back UpgradeAgreementDisputeFee.s.sol FIRST. Unmounting");
        console.log("      creditDisputeFee while the live implementation still sends the");
        console.log("      fee reproduces exactly the silent-credit failure this script");
        console.log("      exists to prevent.");
        console.log("    - drain getTreasurySlice() to zero via withdrawTreasurySlice()");
        console.log("      BEFORE removing them. treasurySlice is a field appended by this");
        console.log("      release; the old facet has neither a getter nor a pusher for it,");
        console.log("      so whatever is accrued becomes USDC sitting on the diamond with");
        console.log("      no mounted function pointing at it.");
        console.log("");
        console.log("  <diamond> =", diamond);
    }
}
