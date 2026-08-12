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
// Почему это нельзя отложить — и почему НЕ по той причине, о которой думаешь.
// Пока фасет не выкачен, creditDisputeFee на диамонде НЕ СУЩЕСТВУЕТ. Деньги
// при этом никуда не деваются: в Agreement.resolveDispute перевод стоит ВНУТРИ
// try, и при провале зачисления на диамонд не уходит ни цента — весь котёл
// достаётся победителю спора, а агримент эмитит DisputeFeeSkipped. Это
// закреплено тестом testResolveDisputeSurvivesAFailingCredit с ассертом
// "not a cent may be stranded on the diamond".
//
// Настоящая цена отсрочки: протокол просто НЕ БЕРЁТ свои 3% со всех споров,
// закрытых в этом окне, и арбитры за них не получают награды. Задним числом
// сбор не начислить — для этих сделок потеря окончательная.
//
// Не путать с июльским инцидентом. Там правку fundVault выкатили только в
// исходники, distribute() возвращался успехом и МОЛЧА ничего не перемещал —
// заметили лишь по расхождению рапорта с балансом. Здесь провал не молчит:
// каждый пропущенный сбор виден как DisputeFeeSkipped в логах сделки.
//
// ПОРЯДОК ВЫКАТКИ. Этот скрипт обязан пройти ДО
// script/UpgradeAgreementDisputeFee.s.sol, который переключает диамонд на
// реализацию Agreement, эти сборы отправляющую. Обратный порядок ничего не
// ломает и не запирает — он стоит выручки за окно и наград арбитрам за него.
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
import "../../src/DiamondProxy.sol";
import "../../src/facets/ArbiterRegistryFacet.sol";

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
        console.log("Also due with that one: the subgraph handler for DisputeSplitNoVerdict");
        console.log("(docs/OPEN-ITEMS.md item 8). Without it a pot settled by split stays");
        console.log("'disputed' forever in every interface, while the chain says otherwise.");
        console.log("");
        console.log("Rollback - THREE steps, and the ORDER is the whole point.");
        console.log("Read all three before starting: step 3 makes step 2 impossible.");
        console.log("");
        console.log("  1) roll back script/UpgradeAgreementDisputeFee.s.sol FIRST, so new");
        console.log("     deals stop landing on an implementation that sends the fee.");
        console.log("     This is not a full undo: EIP-1167 clones minted in the meantime");
        console.log("     delegate to that implementation forever and keep calling");
        console.log("     creditDisputeFee. Harmless - the call sits in a try and the");
        console.log("     transfer is inside it, so a missing selector costs the protocol");
        console.log("     its fee, never the parties their pot.");
        console.log("");
        console.log("  2) while the NEW facet is STILL MOUNTED, drain the treasury slice:");
        console.log("       cast call <diamond> \"getTreasurySlice()(uint256)\"");
        console.log("       cast send <diamond> \"withdrawTreasurySlice()\"    # if non-zero");
        console.log("     After step 3 neither function is reachable. treasurySlice is a");
        console.log("     storage field appended by this release and the old facet has");
        console.log("     neither a getter nor a pusher for it, so whatever is left becomes");
        console.log("     USDC on the diamond with no mounted function pointing at it.");
        console.log("     There is no rescue function anywhere in src/ - only another");
        console.log("     diamondCut would ever get it back.");
        console.log("");
        console.log("  3) ONE diamondCut carrying BOTH elements:");
        console.log("       Replace (action 1) -> <old>, the 44 original selectors");
        console.log("       Remove  (action 2) -> address(0), the 3 selectors below");
        console.log("");
        console.log("     Build the 44 like this - the live call returns 47, not 44:");
        console.log("       cast call <diamond> \"facetFunctionSelectors(address)(bytes4[])\" <new>");
        console.log("     then SUBTRACT exactly these three:");
        console.logBytes4(added[0]); // creditDisputeFee(uint256)
        console.logBytes4(added[1]); // withdrawTreasurySlice()
        console.logBytes4(added[2]); // getTreasurySlice()
        console.log("");
        console.log("     Do NOT Replace those three onto the old facet, and do NOT leave");
        console.log("     them in the list of 44. replaceFunctions never checks that the");
        console.log("     target implements the selector (DiamondProxy:173) - only that the");
        console.log("     facet differs - so such a cut SUCCEEDS. The selectors then point");
        console.log("     at a facet with no such code: the diamond's fallback lets the call");
        console.log("     through and the old facet reverts with empty returndata, while the");
        console.log("     loupe cheerfully reports them as mounted. That is the bad part -");
        console.log("     unmounted also reverts, but at least it is visible to monitoring");
        console.log("     and repairable with Add. This state is invisible and needs Replace.");
        console.log("");
        console.log("     One cut, not two: splitting it leaves a gap in which step 2 has");
        console.log("     already become impossible.");
        console.log("");
        console.log("     <old> =", oldFacet);
        console.log("     <new> =", address(newFacet));
        console.log("");
        console.log("  <diamond> =", diamond);
    }
}
