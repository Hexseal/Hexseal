// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeFactoryFacetDisputeGate.s.sol
//
// Ставит на ЖИВОЙ диамонд FactoryFacet с гейтом ZeroFee.
//
// Что меняется. Ровно три строки исходника: error ZeroFee() и по одному
// `if (fee == 0) revert ZeroFee();` в deployAgreement и deployAndFund, сразу
// после чтения fs.regionFee[region]. Ни одной подписи правка не меняет,
// кастомные ошибки селекторов в даймонд не приносят — значит нужен ЧИСТЫЙ
// Replace 13 селекторов. Ни одного Add, ни одного Remove.
//
// Зачем. Нулевая комиссия региона означает «регион не настроен», а не «сделка
// бесплатная». Доски это уже понимают: JobBoardFacet:184 и
// ServiceBoardFacet:182 обе ревертят ZeroFee. Прямой путь через фабрику —
// нет: _safeTransferFrom с суммой 0 проходит успешно, и сделка создаётся даром.
// Апгрейд выравнивает три входа в один инвариант.
//
// Честно о срочности. Сегодня это НЕ открытая дыра, а расхождение: на цепи у
// всех семи регионов комиссия ненулевая (замерено getAllFees(): 2/4/7/10/4/10/7
// USDC для CIS/ASIA/EU/US/LATAM/CA/AU), поэтому в текущем состоянии ни один
// вызов гейта не задел бы. Дыра открывается одной транзакцией владельца
// setRegionFee(region, 0) — после неё доски отказывают, а фабрика молча
// создаёт сделки бесплатно. То есть цена отсрочки — не утечка деньгами прямо
// сейчас, а то, что критерий готовности плана №7 остаётся только в исходниках.
//
// Ровно этот класс отказа в репозитории уже случался: коммит a8e9e33
// называется «ship the fundVault access change that was only ever in source».
//
// ПОРЯДОК ВЫКАТКИ. Этот скрипт НЕЗАВИСИМ от Задач 5 и 6 (сбор за спор) и может
// идти в любой момент — до них, после них, между ними. Гейт ZeroFee про
// комиссию платформы при СОЗДАНИИ сделки и со сбором за спор не связан ничем:
// ни хранилищем, ни селекторами, ни вызовами. Не ищи зависимости, её нет.
//
// НЕ ЗАПУСКАЙ ВМЕСТО ЭТОГО НИ ОДИН ИЗ ПЯТИ СТАРЫХ СКРИПТОВ ФАБРИКИ.
// UpgradeFactoryFacet / V2 / V3 / V4 ревертят: они несут рукописные массивы
// селекторов, где часть на цепи не смонтирована (Remove и Replace
// несмонтированного ревертят), а часть смонтирована (Add смонтированного
// ревертит). Опаснее всех V5: он попутно разворачивает новый AgreementDeployer
// и зовёт setAgreementDeployer(address) — запуск после Задачи 6 МОЛЧА затрёт
// новый деплойер и откатит сбор за спор.
//
// Этот скрипт деплойер не трогает вообще: не разворачивает, не подставляет,
// не читает. Его единственное дело — заменить реализацию 13 селекторов.
//
// Набор для замены берётся у самого диамонда через facetFunctionSelectors(),
// а не собирается руками: рукописный массив — это ещё один способ разойтись
// с реальностью, и ровно так родились пять негодных скриптов выше.
//
// Usage (сухой прогон — сначала всегда он):
//   forge script script/UpgradeFactoryFacetDisputeGate.s.sol \
//     --rpc-url https://sepolia.base.org
//
// Usage (боевой запуск):
//   forge script script/UpgradeFactoryFacetDisputeGate.s.sol \
//     --rpc-url https://sepolia.base.org --private-key $PRIVATE_KEY --broadcast -vvv
//
// RPC публичный намеренно: бесплатный тариф drpc валится по таймауту на
// скриптах, читающих диамонд несколько раз (docs/OPEN-ITEMS.md §5).
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DiamondProxy.sol";
import "../src/FactoryFacet.sol";

interface IDiamondOwner {
    function owner() external view returns (address);
}

interface ILoupe {
    function facetAddress(bytes4 selector) external view returns (address);
    function facetFunctionSelectors(address facet) external view returns (bytes4[] memory);
}

contract UpgradeFactoryFacetDisputeGate is Script {
    uint256 constant EXPECTED_SELECTORS = 13;

    /// Все 13 внешних функций FactoryFacet, собранные компилятором из того же
    /// контракта, который этот скрипт разворачивает. Это НЕ рукописный массив
    /// хексов: если у фасета изменится состав функций, значение поменяется само.
    /// Нужно, чтобы доказать (а не предположить), что новый фасет реализует все
    /// селекторы, которые мы на него переводим — см. блок про DiamondProxy:173
    /// в инструкции отката ниже.
    function _abiSelectors() internal pure returns (bytes4[] memory sels) {
        sels = new bytes4[](EXPECTED_SELECTORS);
        sels[0]  = FactoryFacet.initFactory.selector;
        sels[1]  = FactoryFacet.deployAgreement.selector;
        sels[2]  = FactoryFacet.deployAndFund.selector;
        sels[3]  = FactoryFacet.setRegionFee.selector;
        sels[4]  = FactoryFacet.setFeeRecipient.selector;
        sels[5]  = FactoryFacet.setTrustedForwarder.selector;
        sels[6]  = FactoryFacet.setAgreementDeployer.selector;
        sels[7]  = FactoryFacet.getRegionFee.selector;
        sels[8]  = FactoryFacet.getAllFees.selector;
        sels[9]  = FactoryFacet.getFeeRecipient.selector;
        sels[10] = FactoryFacet.getTrustedForwarder.selector;
        sels[11] = FactoryFacet.getUsdc.selector;
        sels[12] = FactoryFacet.getAgreementDeployer.selector;
    }

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
        bytes4 deploySel = FactoryFacet.deployAgreement.selector;
        address oldFacet = ILoupe(diamond).facetAddress(deploySel);
        require(oldFacet != address(0), "upgrade: deployAgreement is not mounted at all");

        bytes4[] memory replaced = ILoupe(diamond).facetFunctionSelectors(oldFacet);
        require(
            replaced.length == EXPECTED_SELECTORS,
            "upgrade: unexpected selector count on the live factory facet - stop and look"
        );

        // Каждый селектор с цепи обязан быть одной из 13 функций нового фасета.
        // Диамонд гарантирует уникальность селекторов внутри фасета, поэтому
        // 13 уникальных, каждый из которых лежит в 13-элементном множестве ABI,
        // означает, что множества СОВПАДАЮТ. На этом равенстве держится простота
        // отката, и проверять его надо здесь, а не верить таблице в плане.
        bytes4[] memory abiSels = _abiSelectors();
        for (uint256 i = 0; i < replaced.length; i++) {
            bool found;
            for (uint256 j = 0; j < abiSels.length; j++) {
                if (replaced[i] == abiSels[j]) { found = true; break; }
            }
            require(
                found,
                "upgrade: a live selector is not in the new facet ABI - Replace would mount dead code"
            );
        }

        console.log("--- Before ---");
        console.log("Diamond:              ", diamond);
        console.log("Old factory facet:    ", oldFacet);
        console.log("Selectors to Replace: ", replaced.length);
        console.log("Selectors to Add:      0");
        console.log("Selectors to Remove:   0");
        console.log("AgreementDeployer:     untouched by this script");
        console.log("");

        vm.startBroadcast(deployerKey);

        FactoryFacet newFacet = new FactoryFacet();

        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = IDiamondCut.FacetCut({
            facetAddress:      address(newFacet),
            action:            IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaced
        });

        IDiamondCut(diamond).diamondCut(cut, address(0), "");

        vm.stopBroadcast();

        // Проверяем результат чтением, а не верой в успешный вызов.
        require(
            ILoupe(diamond).facetAddress(deploySel) == address(newFacet),
            "upgrade: deployAgreement still routes to the old facet"
        );
        require(
            ILoupe(diamond).facetAddress(FactoryFacet.deployAndFund.selector) == address(newFacet),
            "upgrade: deployAndFund still routes to the old facet"
        );
        bytes4[] memory nowMounted = ILoupe(diamond).facetFunctionSelectors(address(newFacet));
        require(
            nowMounted.length == EXPECTED_SELECTORS,
            "upgrade: the new facet does not hold 13 selectors"
        );
        // Прежний фасет обязан опустеть: Replace всех его селекторов снимает его
        // с диамонда целиком (DiamondProxy.removeFunction сносит и сам фасет,
        // когда у него не осталось селекторов). Если тут не ноль — часть
        // селекторов осталась на старой реализации.
        require(
            ILoupe(diamond).facetFunctionSelectors(oldFacet).length == 0,
            "upgrade: the old factory facet still holds selectors"
        );

        console.log("--- After ---");
        console.log("New factory facet:    ", address(newFacet));
        console.log("Selectors on it:      ", nowMounted.length);
        console.log("Selectors left on old:", ILoupe(diamond).facetFunctionSelectors(oldFacet).length);
        console.log("deployAgreement ->    ", ILoupe(diamond).facetAddress(deploySel));
        console.log("deployAndFund ->      ", ILoupe(diamond).facetAddress(FactoryFacet.deployAndFund.selector));
        console.log("");
        console.log("Smoke check - a zero-fee region must now be refused, not served free:");
        console.log("  cast call <diamond> \"getAllFees()(uint256,uint256,uint256,uint256,uint256,uint256,uint256)\"");
        console.log("  all seven were non-zero at the time this script was written, so the gate");
        console.log("  is expected to stay silent; it only bites after setRegionFee(r, 0).");
        console.log("");
        console.log("Rollback - ONE step, and here is WHY it is only one.");
        console.log("");
        console.log("  ONE diamondCut with ONE element:");
        console.log("    Replace (action 1) -> <old>, the same 13 selectors");
        console.log("");
        console.log("  Build the list from the chain, it returns exactly 13, subtract nothing:");
        console.log("    cast call <diamond> \"facetFunctionSelectors(address)(bytes4[])\" <new>");
        console.log("");
        console.log("  No Remove: this release added no selector. No drain: it added no storage");
        console.log("  field either, so nothing can be stranded behind an unmounted getter -");
        console.log("  that is what made the Task 5 rollback three steps instead of one.");
        console.log("");
        console.log("  It is safe because THE TWO SELECTOR SETS ARE THE SAME 13, and the old");
        console.log("  facet implements every one of them - not because the chain will catch a");
        console.log("  mistake. It will not. replaceFunctions (DiamondProxy:173) checks only");
        console.log("  that the target facet DIFFERS from the current one; it never checks that");
        console.log("  the target has code for the selector. A cut pointing a selector at a");
        console.log("  facet without that function SUCCEEDS, the loupe then reports it as");
        console.log("  mounted, and every call reverts with empty returndata. That state is");
        console.log("  invisible to monitoring and only another Replace can undo it.");
        console.log("");
        console.log("  Practically: do not hand-type the 13, do not borrow a list from");
        console.log("  UpgradeFactoryFacet/V2/V3/V4 - theirs contain selectors this diamond");
        console.log("  never mounted - and do NOT run V5, which would also overwrite the");
        console.log("  AgreementDeployer this script deliberately never touched.");
        console.log("");
        console.log("     <old> =", oldFacet);
        console.log("     <new> =", address(newFacet));
        console.log("");
        console.log("  <diamond> =", diamond);
    }
}
