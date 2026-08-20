// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// ЛЁГКИЙ СТЕНД НА ДВА АРБИТРАЖНЫХ ФАСЕТА (задача 4.5, 16 августа 2026)
//
// ЗАЧЕМ ОН ПОЯВИЛСЯ. Прежний лёгкий стенд разворачивал ОДИН фасет
// (`facet = new ArbiterRegistryFacet()`) и звал его напрямую. Пока все нужные
// тесту функции жили в одном контракте, это работало и было дёшево.
//
// Задача 4.5 увезла четырнадцать ЧТЕНИЙ в ArbiterAccountabilityFacet, и
// прежний приём на них ломается — молча и опасно. Оба фасета читают ОДИН
// неймспейс (ArbiterRegistryStorage, тот же POSITION), но неймспейс — это
// СМЕЩЕНИЕ, а не адрес: два отдельных `new` дают два РАЗНЫХ контракта с двумя
// РАЗНЫМИ хранилищами по одному и тому же смещению. Тест, который пишет через
// `new ArbiterRegistryFacet()` и читает через `new ArbiterAccountabilityFacet()`,
// прочитал бы чистый ноль и назвал бы это ответом.
//
// ЧТО ДЕЛАЕТ ЭТОТ СТЕНД. Даёт ОДИН адрес, за которым стоит код ОБОИХ фасетов, —
// то есть ровно то, чем даймонд и является в бою. Оба возвращаемых хендла
// указывают на ЭТОТ ЖЕ адрес, поэтому:
//
//   • `vm.store(address(reg), ...)` и `vm.load(address(acc), ...)` бьют в одно
//     хранилище — все прежние строки засева слотов продолжают работать без
//     единой правки;
//   • `vm.expectEmit(..., address(reg))` продолжает совпадать: события
//     делегированного вызова несут адрес прокси;
//   • `msg.sender` внутри фасета остаётся тестовым контрактом — delegatecall
//     его не меняет, `vm.prank` работает как раньше.
//
// Отличие от прежнего стенда ровно одно и оно в пользу теста: `address(this)`
// внутри фасета теперь адрес прокси, а не отдельного фасета, — то есть тот же
// адрес, что и в бою, и деньги (залог, банк) лежат там же, где их ищет
// соседний фасет.
//
// Списки селекторов берутся из script/DeployFull.s.sol, а не переписываются
// здесь: второй рукописный список разъехался бы с боевым молча, и стенд начал
// бы доказывать что-то про несуществующую раскладку.
// ============================================================

import {DeployFull} from "../script/DeployFull.s.sol";
import {LegacyPreSplitArbiterFacet} from "./legacy/LegacyPreSplitArbiterFacet.sol";
import {ArbiterRegistryFacet, ArbiterRegistryStorage} from "../src/facets/ArbiterRegistryFacet.sol";
import {ArbiterAccountabilityFacet} from "../src/facets/ArbiterAccountabilityFacet.sol";
import {
    DiamondProxy,
    DiamondCutFacet,
    DiamondLoupeFacet,
    OwnershipFacet,
    IDiamondCut,
    IDiamondLoupe,
    IERC165
} from "../src/DiamondProxy.sol";

abstract contract ArbiterTwoFacetBench {
    /// Разворачивает прокси с обоими арбитражными фасетами и отдаёт два хендла
    /// НА ОДИН И ТОТ ЖЕ АДРЕС. Владельцем становится вызывающий (тестовый
    /// контракт), как и было в прежнем стенде после `vm.store` в слот владельца.
    function _deployArbiterBench()
        internal
        returns (ArbiterRegistryFacet reg, ArbiterAccountabilityFacet acc)
    {
        DeployFull deployFull = new DeployFull();

        DiamondCutFacet cutFacet     = new DiamondCutFacet();
        DiamondLoupeFacet loupeFacet = new DiamondLoupeFacet();
        OwnershipFacet ownFacet      = new OwnershipFacet();

        bytes4[] memory cutSels = new bytes4[](1);
        cutSels[0] = IDiamondCut.diamondCut.selector;

        bytes4[] memory loupeSels = new bytes4[](5);
        loupeSels[0] = IDiamondLoupe.facets.selector;
        loupeSels[1] = IDiamondLoupe.facetFunctionSelectors.selector;
        loupeSels[2] = IDiamondLoupe.facetAddresses.selector;
        loupeSels[3] = IDiamondLoupe.facetAddress.selector;
        loupeSels[4] = IERC165.supportsInterface.selector;

        bytes4[] memory ownSels = new bytes4[](4);
        ownSels[0] = OwnershipFacet.transferOwnership.selector;
        ownSels[1] = OwnershipFacet.owner.selector;
        ownSels[2] = OwnershipFacet.acceptOwnership.selector;
        ownSels[3] = OwnershipFacet.pendingOwner.selector;

        IDiamondCut.FacetCut[] memory initCuts = new IDiamondCut.FacetCut[](3);
        initCuts[0] = IDiamondCut.FacetCut(address(cutFacet),   IDiamondCut.FacetCutAction.Add, cutSels);
        initCuts[1] = IDiamondCut.FacetCut(address(loupeFacet), IDiamondCut.FacetCutAction.Add, loupeSels);
        initCuts[2] = IDiamondCut.FacetCut(address(ownFacet),   IDiamondCut.FacetCutAction.Add, ownSels);

        DiamondProxy diamond = new DiamondProxy(address(this), initCuts, address(0), "");

        IDiamondCut.FacetCut[] memory arbCuts = new IDiamondCut.FacetCut[](2);
        arbCuts[0] = IDiamondCut.FacetCut(
            address(new ArbiterRegistryFacet()),
            IDiamondCut.FacetCutAction.Add,
            deployFull.arbiterRegistryFacetSelectors()
        );
        arbCuts[1] = IDiamondCut.FacetCut(
            address(new ArbiterAccountabilityFacet()),
            IDiamondCut.FacetCutAction.Add,
            deployFull.arbiterAccountabilityFacetSelectors()
        );
        IDiamondCut(address(diamond)).diamondCut(arbCuts, address(0), "");

        reg = ArbiterRegistryFacet(address(diamond));
        acc = ArbiterAccountabilityFacet(address(diamond));
    }

    /// Доигрывает на стенде ИСТОРИЧЕСКОГО разреза то, что задача 4.5 сделает
    /// следующим разрезом в цепи: переставляет уехавшие чтения на
    /// ArbiterAccountabilityFacet.
    ///
    /// ЗАЧЕМ ЭТО НУЖНО. Исполненные разрезы (10 и 15 августа 2026) деплоят
    /// ОДИН `new ArbiterRegistryFacet()` и монтируют на него всё. Про задачу
    /// 4.5 они знать не могут, и переписывать их нельзя — это запись о том,
    /// что легло в цепь. Но сегодняшний ArbiterRegistryFacet четырнадцати
    /// чтений уже не реализует, поэтому сразу после такого разреза они
    /// маршрутизированы на код, который на них не отвечает.
    ///
    /// ⚠️ Это НЕ костыль стенда, а верное изображение цепи: ровно в таком
    /// состоянии Base Sepolia и окажется между разрезом 15 августа и разрезом
    /// задачи 4.5. Тест, который зовёт эти чтения после исторического разреза,
    /// обязан сперва доиграть переезд — иначе он проверяет состояние, которое
    /// мы сами же и собираемся починить следующей транзакцией.
    ///
    /// Переставляются ТОЛЬКО те селекторы фасета ответственности, что реально
    /// смонтированы на этом стенде, — список берётся из DeployFull, а не
    /// переписывается руками, чтобы не разъехаться с боевой раскладкой.
    function _applyTask45MoveAfterLegacyCut(DiamondProxy diamond) internal {
        bytes4[] memory candidates = (new DeployFull()).arbiterAccountabilityFacetSelectors();

        uint256 n;
        bool[] memory mounted = new bool[](candidates.length);
        for (uint256 i = 0; i < candidates.length; i++) {
            if (IDiamondLoupe(address(diamond)).facetAddress(candidates[i]) != address(0)) {
                mounted[i] = true;
                n++;
            }
        }
        if (n == 0) return;

        bytes4[] memory sels = new bytes4[](n);
        uint256 k;
        for (uint256 i = 0; i < candidates.length; i++) {
            if (mounted[i]) sels[k++] = candidates[i];
        }

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut(
            address(new ArbiterAccountabilityFacet()),
            IDiamondCut.FacetCutAction.Replace,
            sels
        );
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }
}

// ════════════════════════════════════════════════════════════════════════
// ДВОЙНИК ФАСЕТА ДО РАЗРЕЗА 4.5 ПЕРЕЕХАЛ (уборка 7а, п. 5, 16 августа 2026)
//
// Здесь стоял `contract LegacyPreSplitArbiterFacet is ArbiterRegistryFacet`,
// дописывавший четырнадцать чтений, которые задача 4.5 увезла в фасет
// ответственности. Он НАСЛЕДОВАЛ сегодняшний код и ехал за каждой нашей
// правкой, будучи при этом заявлен как раскладка ЦЕПИ, — и 16 августа
// перевалил EIP-170 (24 646 → 24 722 при пределе 24 576), уронив
// `forge build --sizes` в код 1.
//
// Теперь двойник — замороженный слепок выкаченного исходника:
// `test/legacy/LegacyPreSplitArbiterFacet.sol` (копия с `b110fae1`, 21 227
// байт, запас 3 349). Импорт наверху этого файла ре-экспортирует его, чтобы
// стенды разрезов ничего у себя не меняли.
//
// Реэкспорт намеренно оставлен здесь, а не заменён прямым импортом в двух
// стендах: адрес объявления двойника — это то, по чему его ищут, и переносить
// его дважды значило бы завести два места, куда смотреть.
// ════════════════════════════════════════════════════════════════════════
