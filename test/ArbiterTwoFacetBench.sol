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

// ============================================================
// ДВОЙНИК ФАСЕТА ДО РАЗРЕЗА 4.5 (16 августа 2026)
//
// ЗАЧЕМ. Два разреза УЖЕ ИСПОЛНЕНЫ в цепи — «ключ чата арбитра» (10 августа) и
// «цепь как свидетель предъявления» (15 августа). Их скрипты и тесты остаются в
// репозитории как запись о том, что произошло, и переписывать их нельзя.
//
// Стенды тех тестов повторяют раскладку цепи НА ТОТ МОМЕНТ: все 56 арбитражных
// селекторов на ОДНОМ адресе. Это не декорация — их пред-полёт
// (checkReplaceGroup) прямо требует, чтобы вся группа Replace сидела на одном
// адресе, и падает иначе.
//
// Задача 4.5 увезла четырнадцать чтений в ArbiterAccountabilityFacet, и с тех
// пор НИ ОДИН контракт не реализует все 56 сразу. Смонтировать их на голый
// ArbiterRegistryFacet по-прежнему можно (diamondCut требует от адреса только
// наличия кода), но ВЫЗОВ переехавшего чтения после этого ревертит — а
// пред-полёт тех скриптов реально зовёт getOpenClaimCount, перечисляя арбитров
// с открытыми спорами.
//
// Этот двойник и есть «ArbiterRegistryFacet, каким он был до 4.5»: наследует
// боевой фасет и возвращает четырнадцать уехавших чтений. Тела — те же
// однострочники над тем же неймспейсом, поведение прежнее.
//
// ⚠️ ТОЛЬКО ДЛЯ СТЕНДОВ ИСТОРИЧЕСКИХ РАЗРЕЗОВ. В src/ его нет и быть не должно:
// он существует, чтобы прошлое можно было воспроизвести, а не чтобы у чтений
// стало два дома.
// ============================================================
contract LegacyPreSplitArbiterFacet is ArbiterRegistryFacet {
    function getArbiterMistakeStreak(address addr) external view returns (uint256) { return ArbiterRegistryStorage.data().arbiterMistakeStreak[addr]; }
    function getCleanVerdicts(address a) external view returns (uint256) { return ArbiterRegistryStorage.data().cleanVerdicts[a]; }
    function getArbiterBond(address addr) external view returns (uint256) { return ArbiterRegistryStorage.data().arbiterBond[addr]; }
    function getOpenClaimCount(address addr) external view returns (uint256) { return ArbiterRegistryStorage.data().openClaimCount[addr]; }
    function getArbiterReward(address a) external view returns (uint256) { return ArbiterRegistryStorage.data().arbiterRewards[a]; }
    function getArbiterDeals(address a) external view returns (address[] memory) { return ArbiterRegistryStorage.data().arbiterDeals[a]; }
    function getSeatedBy(address a) external view returns (address) { return ArbiterRegistryStorage.data().seatedBy[a]; }
    function getSeatedCountBy(address a) external view returns (uint256) { return ArbiterRegistryStorage.data().seatedCountBy[a]; }

    function getDisputeClaimedAt(address agreement) external view returns (uint256) {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        return d.disputeClaimedAtBy[agreement][d.disputeClaims[agreement]];
    }

    function getNoResponseAt(address agreement) external view returns (uint256) {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        return d.disputeNoResponseAtBy[agreement][d.disputeClaims[agreement]];
    }

    function getPresentationDigests(address a) external view returns (bytes32[] memory) {
        return ArbiterRegistryStorage.data().presentationDigests[a];
    }

    function getPresentationDigestCount(address a) external view returns (uint256) {
        return ArbiterRegistryStorage.data().presentationDigests[a].length;
    }

    function getPresentationDigestsPage(address a, uint256 offset, uint256 limit)
        external view returns (bytes32[] memory)
    {
        bytes32[] storage all = ArbiterRegistryStorage.data().presentationDigests[a];
        uint256 len = all.length;
        if (offset >= len) return new bytes32[](0);
        uint256 available = len - offset;
        uint256 n = limit < available ? limit : available;
        bytes32[] memory page = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) page[i] = all[offset + i];
        return page;
    }

    function getArbiterChatKeys(address a) external view returns (bytes32 boxKey, bytes32 signKey) {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        return (d.arbiterBoxKey[a], d.arbiterSignKey[a]);
    }
}
