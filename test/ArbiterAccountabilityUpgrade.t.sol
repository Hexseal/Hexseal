// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Гейт на скрипт разреза script/UpgradeArbiterAccountability.s.sol.
//
// Скрипт объявляет три списка селекторов руками. Руки ошибаются, а цена ошибки
// здесь — разрез, смонтировавший не то, и выясняется это уже в цепи. Поэтому
// списки сверяются с настоящим ABI, прочитанным из скомпилированного артефакта
// (fs_permissions в foundry.toml уже открывает ./out на чтение ради
// test/DeployFullSelectors.t.sol — этот файл пользуется тем же приёмом).
//
// ⚠️ ЭТОТ ФАЙЛ ДЕРЖИТ ЗАМОК, ПЕРЕЕХАВШИЙ СЮДА ПО RULING 4 (15 августа 2026).
// Задача 1 плана arbiter-accountability сняла из
// test/PresentationRecordUpgrade.t.sol тест test_ReplaceAndAddCoverWholeFacet:
// он сверял списки УЖЕ ИСПОЛНЕННОГО разреза со свежим ABI фасета и краснел от
// любого роста фасета, не сообщая ничего. Снятие принято УСЛОВНО: живая роль
// замка — «недомонтированный или фантомный селектор» — обязана переехать на
// разрез, которому ещё предстоит запуститься. Вот она:
//   test_ReplaceAndAddCoverWholeRegistryABI      (ни один селектор не забыт)
//   test_NoPhantomSelectorInEitherList           (ни одного лишнего)
// Ниже у каждого написано, что исчезнет из поведения, если его снять.

import "forge-std/Test.sol";
import {UpgradeArbiterAccountability} from "../script/UpgradeArbiterAccountability.s.sol";
import {ArbiterProvenanceInit} from "../script/ArbiterProvenanceInit.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";
import {ArbiterAccountabilityFacet} from "../src/facets/ArbiterAccountabilityFacet.sol";
import "../src/DiamondProxy.sol";

/// Двойник голой кнопки: контракт, который РЕАЛЬНО отвечает на
/// removeArbiter(address). Нужен ровно для одного — показать, что до разреза
/// вызов проходил, а после перестал. Настоящий ArbiterRegistryFacet этой
/// функции больше не содержит (задача 6 удалила её), поэтому смонтированный на
/// него селектор ревертил бы и до разреза, и сравнение «было живо → стало
/// мертво» выродилось бы в «мертво → мертво».
contract LegacyRemoveArbiterStub {
    event LegacyRemoveArbiterCalled(address arbiter);

    function removeArbiter(address arbiter) external {
        emit LegacyRemoveArbiterCalled(arbiter);
    }
}

/// Двойник, отвечающий на getSuspensionWindow() НЕ тем числом — доказывает
/// замером, что пост-проверка сверяет ЗНАЧЕНИЕ, а не «вызов не ревертнул».
contract WrongSuspensionWindowStub {
    function getSuspensionWindow() external pure returns (uint256) {
        return 48 hours;
    }
}

contract ArbiterAccountabilityUpgradeTest is Test {
    UpgradeArbiterAccountability internal upgrade;

    /// Неймспейс арбитражного хранилища, ERC-7201 (ArbiterRegistryStorage.POSITION,
    /// src/facets/ArbiterRegistryFacet.sol:55-56):
    ///   keccak256(abi.encode(uint256(keccak256("hexseal.arbiterregistry.storage")) - 1))
    ///     & ~bytes32(uint256(0xff))
    /// Тот же, что в test/ArbiterRemovalForCause.t.sol. (Формула и строка
    /// исправлены в комментарии кругом правок 1 — значение было верным, врало
    /// описание.)
    bytes32 constant ARB_POS = 0xaae71de0594cbcb5434f0ab7f7501c1be178552bf788b418a1c2624ba9718d00;

    /// seatedBy — слот 25, seatedCountBy — 26. Не приняты на слово: смещение
    /// доказывается круговым замером в test_SeatedBySlotOffsetIsProvenByGetter.
    uint256 constant SLOT_SEATED_BY = 25;
    uint256 constant SLOT_SEATED_COUNT_BY = 26;

    function setUp() public {
        upgrade = new UpgradeArbiterAccountability();
    }

    // ── Ground truth: читаем прямо из скомпилированного артефакта — тот же
    //    приём, что test/DeployFullSelectors.t.sol::_abiSelectors ──────────
    function _abiSelectors(string memory contractName) internal view returns (bytes4[] memory out) {
        string memory json = vm.readFile(string.concat("out/", contractName, ".sol/", contractName, ".json"));
        string[] memory sigs = vm.parseJsonKeys(json, ".methodIdentifiers");
        out = new bytes4[](sigs.length);
        for (uint256 i; i < sigs.length; i++) out[i] = bytes4(keccak256(bytes(sigs[i])));
    }

    function _contains(bytes4[] memory haystack, bytes4 needle) internal pure returns (bool) {
        for (uint256 i = 0; i < haystack.length; i++) {
            if (haystack[i] == needle) return true;
        }
        return false;
    }

    // ════════════════════════════════════════════════════════════════════
    // СОСТАВ СПИСКОВ ПРОТИВ СКОМПИЛИРОВАННОГО ABI
    // ════════════════════════════════════════════════════════════════════

    /// ЗАМОК RULING 4, половина первая: объединение Replace и Add покрывает
    /// ABI ArbiterRegistryFacet ЦЕЛИКОМ.
    ///
    /// Что исчезнет из поведения, если снять: забытый в обоих списках селектор
    /// останется смонтированным на СТАРЫЙ адрес фасета — половина даймонда
    /// поедет новым кодом, половина старым, поверх одного и того же хранилища,
    /// в которое задачи 1-8 дописали шесть полей. Худший из возможных исходов
    /// разреза, и снаружи он выглядит как «всё прошло, транзакция зелёная».
    function test_ReplaceAndAddCoverWholeRegistryABI() public view {
        bytes4[] memory replaceSels = upgrade.replaceSelectors();
        bytes4[] memory addReg      = upgrade.addRegistrySelectors();
        bytes4[] memory abiSels     = _abiSelectors("ArbiterRegistryFacet");

        assertGt(replaceSels.length, 0, unicode"список замены пуст — скрипт ничего не заменит");

        for (uint256 i = 0; i < abiSels.length; i++) {
            assertTrue(
                _contains(replaceSels, abiSels[i]) || _contains(addReg, abiSels[i]),
                unicode"селектор ArbiterRegistryFacet не попал ни в Replace, ни в Add"
            );
        }

        // И обратная сторона счётом: ABI фасета ровно равен объединению.
        // removeArbiter в ABI больше нет вовсе — задача 6 удалила её из кода,
        // поэтому вычитать её здесь не из чего.
        assertEq(
            replaceSels.length + addReg.length, abiSels.length,
            unicode"Replace+Add не совпадает с ABI фасета по числу селекторов"
        );
    }

    /// Add покрывает ABI ArbiterAccountabilityFacet целиком.
    ///
    /// Что исчезнет из поведения, если снять: забытый Add означает функцию,
    /// которой в даймонде нет. Фронт зовёт — «Diamond: function not found».
    /// Мёртвая кнопка, и узнаем мы о ней от человека, который на неё нажал.
    function test_AddCoversWholeAccountabilityABI() public view {
        bytes4[] memory addAcc  = upgrade.addAccountabilitySelectors();
        bytes4[] memory abiSels = _abiSelectors("ArbiterAccountabilityFacet");

        assertEq(
            addAcc.length, abiSels.length,
            unicode"число добавляемых селекторов не совпадает с ABI нового фасета"
        );
        for (uint256 i = 0; i < abiSels.length; i++) {
            assertTrue(_contains(addAcc, abiSels[i]), unicode"селектор нового фасета забыт в Add");
        }

        // Полный addSelectors() обязан содержать их все — из него берёт
        // пред-полёт и итоговый счёт.
        bytes4[] memory addAll = upgrade.addSelectors();
        for (uint256 i = 0; i < abiSels.length; i++) {
            assertTrue(_contains(addAll, abiSels[i]), unicode"селектор нового фасета потерялся в общем списке Add");
        }
    }

    /// Все 23 добавляемых селектора названы ЛИТЕРАЛЬНЫМИ ПОДПИСЯМИ, а не
    /// `.selector` из тех же контрактов. Приём взят у соседа —
    /// test/PresentationRecordUpgrade.t.sol:62-65: сверка `.selector` с
    /// `.selector` тавтологична, потому что при переименовании функции обе
    /// стороны едут вместе и тест остаётся зелёным. Здесь слева фасет, справа
    /// текст подписи, на который завязываются фронт и релеер, — расхождение
    /// обязано краснеть.
    ///
    /// Почему именно Add, а не заодно и 63 Replace: у Replace независимый
    /// оракул уже есть и он сильнее текста — ЖИВАЯ ЦЕПЬ. Переименованная
    /// функция даст селектор, которого в даймонде нет, и пред-полёт
    /// checkReplaceGroup покраснеет на первом же запуске. У Add такого оракула
    /// нет по устройству: этих селекторов в цепи не должно быть НИ ДО, НИ
    /// ПОСЛЕ переименования, и пред-полёт одинаково доволен обоими. Значит
    /// текстовая сверка нужна ровно там, где чейн молчит (найдено ревью круга 1,
    /// Minor 3).
    ///
    /// Что исчезнет из поведения, если снять: переименование или смена подписи
    /// (лишний аргумент, uint256 вместо bytes32) проехали бы молча — цепь
    /// смонтировала бы новый селектор, а фронт продолжал бы звать старый и
    /// получал «Diamond: function not found».
    function test_AddSelectorsMatchLiteralSignatures() public view {
        string[] memory regSigs = new string[](6);
        regSigs[0] = "getSeatedBy(address)";
        regSigs[1] = "getSeatedCountBy(address)";
        regSigs[2] = "getChiefBloc()";
        regSigs[3] = "getMaxClaimsPerArbiter()";
        regSigs[4] = "getCleanVerdicts(address)";
        regSigs[5] = "getMaxArbiterMistakes()";

        string[] memory accSigs = new string[](17);
        accSigs[0]  = "suspendArbiter(address)";
        accSigs[1]  = "liftSuspension(address)";
        accSigs[2]  = "isSuspended(address)";
        accSigs[3]  = "getSuspendedUntil(address)";
        accSigs[4]  = "getSuspensionWindow()";
        accSigs[5]  = "removeArbiterForCause(address,uint8,bytes32,address)";
        accSigs[6]  = "getMistakeThreshold()";
        accSigs[7]  = "getMaxArbiterMistakesMirror()";
        accSigs[8]  = "getDaoThresholdMirror()";
        accSigs[9]  = "proposeRemoval(address,uint8,bytes32)";
        accSigs[10] = "withdrawProposal(address)";
        accSigs[11] = "getRemovalProposal(address)";
        accSigs[12] = "hasLiveProposal(address)";
        accSigs[13] = "getProposalTTL()";
        accSigs[14] = "respondToRemoval(bytes32)";
        accSigs[15] = "getRemovalReply(address)";
        accSigs[16] = "getArbiterStanding(address)";

        bytes4[] memory declaredReg = upgrade.addRegistrySelectors();
        assertEq(declaredReg.length, regSigs.length, unicode"Add-реестр: число селекторов разошлось с числом подписей");
        for (uint256 i = 0; i < regSigs.length; i++) {
            assertTrue(
                _contains(declaredReg, bytes4(keccak256(bytes(regSigs[i])))),
                unicode"Add-реестр: подписи нет среди добавляемых селекторов"
            );
        }

        bytes4[] memory declaredAcc = upgrade.addAccountabilitySelectors();
        assertEq(declaredAcc.length, accSigs.length, unicode"Add-ответственность: число селекторов разошлось с числом подписей");
        for (uint256 i = 0; i < accSigs.length; i++) {
            assertTrue(
                _contains(declaredAcc, bytes4(keccak256(bytes(accSigs[i])))),
                unicode"Add-ответственность: подписи нет среди добавляемых селекторов"
            );
        }
    }

    /// ЗАМОК RULING 4, половина вторая: ни в Replace, ни в Add нет селектора,
    /// которого нет ни в одном из двух ABI.
    ///
    /// Что исчезнет из поведения, если снять: опечатка в списке смонтирует
    /// селектор-фантом. Replace на адрес, который его не реализует, НЕ ревертит
    /// (DiamondCutLib проверяет только «адрес другой и есть код»), поэтому
    /// разрез прошёл бы зелёным, а в даймонде навсегда осталась бы запись,
    /// ведущая в никуда, — снять её можно только отдельным разрезом с Remove.
    function test_NoPhantomSelectorInEitherList() public view {
        bytes4[] memory reg = _abiSelectors("ArbiterRegistryFacet");
        bytes4[] memory acc = _abiSelectors("ArbiterAccountabilityFacet");

        bytes4[] memory replaceSels = upgrade.replaceSelectors();
        for (uint256 i = 0; i < replaceSels.length; i++) {
            assertTrue(
                _contains(reg, replaceSels[i]) || _contains(acc, replaceSels[i]),
                unicode"Replace: селектора нет ни в одном из двух фасетов — фантом"
            );
        }

        bytes4[] memory addSels = upgrade.addSelectors();
        for (uint256 i = 0; i < addSels.length; i++) {
            assertTrue(
                _contains(reg, addSels[i]) || _contains(acc, addSels[i]),
                unicode"Add: селектора нет ни в одном из двух фасетов — фантом"
            );
        }
    }

    /// removeArbiter обязана быть именно в списке на УДАЛЕНИЕ и нигде больше.
    /// Селектор считается независимо, из keccak подписи: сверка литерала с тем
    /// же литералом была бы тавтологией.
    ///
    /// Что исчезнет из поведения, если снять: без Remove селектор остаётся
    /// смонтированным на старый адрес, и голая кнопка продолжает сносить
    /// арбитра без повода, без записи кто нажал и с возвратом залога — ровно
    /// то, ради устранения чего сделана вся работа.
    function test_RemoveArbiterIsInRemoveListAndNowhereElse() public view {
        bytes4 naked = bytes4(keccak256("removeArbiter(address)"));

        bytes4[] memory removeSels = upgrade.removeSelectors();
        assertEq(removeSels.length, 1, unicode"удаляется ровно один селектор");
        assertEq(removeSels[0], naked, unicode"удаляется именно голая removeArbiter");

        assertFalse(
            _contains(upgrade.replaceSelectors(), naked),
            unicode"удаляемый селектор не может одновременно заменяться"
        );
        assertFalse(
            _contains(upgrade.addSelectors(), naked),
            unicode"удаляемый селектор не может одновременно добавляться"
        );

        // И его действительно больше нет в коде фасета — иначе удаление
        // селектора при живой функции означало бы просто отрезанный вход.
        assertFalse(
            _contains(_abiSelectors("ArbiterRegistryFacet"), naked),
            unicode"removeArbiter всё ещё есть в ABI фасета — удалять её селектор рано"
        );
    }

    /// Replace и Add не пересекаются, и внутри каждого нет повторов.
    ///
    /// Что исчезнет из поведения, если снять: diamondCut отверг бы весь разрез
    /// на "Diamond: selector exists" — но узнали бы мы об этом боевой
    /// транзакцией, уже после броадкаста двух фасетов.
    function test_NoSelectorNamedTwiceAcrossLists() public view {
        bytes4[] memory replaceSels = upgrade.replaceSelectors();
        bytes4[] memory addSels     = upgrade.addSelectors();

        bytes4[] memory all = new bytes4[](replaceSels.length + addSels.length);
        uint256 k;
        for (uint256 i = 0; i < replaceSels.length; i++) all[k++] = replaceSels[i];
        for (uint256 i = 0; i < addSels.length; i++) all[k++] = addSels[i];

        for (uint256 i = 0; i < all.length; i++) {
            for (uint256 j = i + 1; j < all.length; j++) {
                assertTrue(all[i] != all[j], unicode"селектор назван больше одного раза в Replace/Add");
            }
        }
    }

    /// Общий Add — ровно объединение двух своих половин, без потерь и добавок.
    /// Половины едут на РАЗНЫЕ адреса, поэтому существуют порознь; общий
    /// список читают пред-полёт и итоговый счёт, и разъехаться им нельзя.
    function test_AddSelectorsIsExactlyTheUnionOfItsTwoHalves() public view {
        bytes4[] memory addAll = upgrade.addSelectors();
        bytes4[] memory reg    = upgrade.addRegistrySelectors();
        bytes4[] memory acc    = upgrade.addAccountabilitySelectors();

        assertEq(addAll.length, reg.length + acc.length, unicode"общий Add не равен сумме половин");
        for (uint256 i = 0; i < reg.length; i++) assertTrue(_contains(addAll, reg[i]));
        for (uint256 i = 0; i < acc.length; i++) assertTrue(_contains(addAll, acc[i]));
    }

    /// Состав buildCuts(): четыре записи, свои действия, свои адреса.
    /// Четыре, а не три, потому что группа Add едет на ДВА разных адреса —
    /// один элемент FacetCut несёт ровно один адрес.
    function test_BuildCutsShapeAndAddresses() public view {
        address reg = address(0xBEEF);
        address acc = address(0xCAFE);
        IDiamondCut.FacetCut[] memory cuts = upgrade.buildCuts(reg, acc);

        assertEq(cuts.length, 4, unicode"buildCuts: ожидались ровно четыре записи FacetCut");

        assertTrue(cuts[0].action == IDiamondCut.FacetCutAction.Replace, unicode"cuts[0] должен быть Replace");
        assertEq(cuts[0].facetAddress, reg, unicode"Replace: адрес обязан быть новым реестром");
        assertEq(cuts[0].functionSelectors.length, upgrade.replaceSelectors().length);

        assertTrue(cuts[1].action == IDiamondCut.FacetCutAction.Add, unicode"cuts[1] должен быть Add");
        assertEq(cuts[1].facetAddress, reg, unicode"Add-реестр: адрес обязан быть новым реестром");
        assertEq(cuts[1].functionSelectors.length, upgrade.addRegistrySelectors().length);

        assertTrue(cuts[2].action == IDiamondCut.FacetCutAction.Add, unicode"cuts[2] должен быть Add");
        assertEq(cuts[2].facetAddress, acc, unicode"Add-ответственность: адрес обязан быть новым фасетом");
        assertEq(cuts[2].functionSelectors.length, upgrade.addAccountabilitySelectors().length);

        // Remove — последним и с нулевым адресом: DiamondCutLib.removeFunctions
        // требует ровно этого ("Diamond: remove needs zero address"), а
        // последним — чтобы никакое следующее действие не вернуло селектор.
        assertTrue(cuts[3].action == IDiamondCut.FacetCutAction.Remove, unicode"cuts[3] должен быть Remove");
        assertEq(cuts[3].facetAddress, address(0), unicode"Remove: адрес обязан быть нулевым");
        assertEq(cuts[3].functionSelectors.length, 1, unicode"Remove: ровно один селектор");
    }

    // ════════════════════════════════════════════════════════════════════
    // СТЕНД: локальный даймонд с сегодняшней раскладкой цепи
    // ════════════════════════════════════════════════════════════════════

    /// Минимальный даймонд: Cut+Loupe+Ownership. Приём — test/Diamond.t.sol.
    function _deployMinimalDiamond() internal returns (DiamondProxy) {
        DiamondCutFacet cutFacet = new DiamondCutFacet();
        DiamondLoupeFacet loupeFacet = new DiamondLoupeFacet();
        OwnershipFacet ownFacet = new OwnershipFacet();

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

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](3);
        cuts[0] = IDiamondCut.FacetCut(address(cutFacet), IDiamondCut.FacetCutAction.Add, cutSels);
        cuts[1] = IDiamondCut.FacetCut(address(loupeFacet), IDiamondCut.FacetCutAction.Add, loupeSels);
        cuts[2] = IDiamondCut.FacetCut(address(ownFacet), IDiamondCut.FacetCutAction.Add, ownSels);

        return new DiamondProxy(address(this), cuts, address(0), "");
    }

    /// Раскладка, буквально совпадающая с Base Sepolia на 15 августа 2026: все
    /// 64 арбитражных селектора (63 будущих Replace + голая removeArbiter) на
    /// ОДНОМ адресе фасета. Голая кнопка при этом смонтирована, но не
    /// реализована — задача 6 удалила функцию из кода, — что для проверок
    /// маршрутизации ровно то же самое: addFunctions требует от адреса только
    /// наличия кода. Тестам, которым нужна ЖИВАЯ кнопка, служит
    /// _mountLiveLayoutWithWorkingButton ниже.
    function _mountLiveLayout(DiamondProxy diamond) internal returns (address oldFacetAddr) {
        ArbiterRegistryFacet oldFacet = new ArbiterRegistryFacet();

        bytes4[] memory replaceSels = upgrade.replaceSelectors();
        bytes4[] memory live = new bytes4[](replaceSels.length + 1);
        for (uint256 i = 0; i < replaceSels.length; i++) live[i] = replaceSels[i];
        live[replaceSels.length] = upgrade.removeSelectors()[0];

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut(address(oldFacet), IDiamondCut.FacetCutAction.Add, live);
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        oldFacetAddr = address(oldFacet);
    }

    /// То же самое, но removeArbiter смонтирована на двойник, который на неё
    /// РЕАЛЬНО отвечает: единственный способ показать переход «кнопка работала
    /// → кнопка мертва», раз настоящей функции в коде больше нет.
    function _mountLiveLayoutWithWorkingButton(DiamondProxy diamond)
        internal returns (address oldFacetAddr, address stubAddr)
    {
        ArbiterRegistryFacet oldFacet = new ArbiterRegistryFacet();
        LegacyRemoveArbiterStub stub = new LegacyRemoveArbiterStub();

        bytes4[] memory nakedSel = new bytes4[](1);
        nakedSel[0] = upgrade.removeSelectors()[0];

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut(address(oldFacet), IDiamondCut.FacetCutAction.Add, upgrade.replaceSelectors());
        cuts[1] = IDiamondCut.FacetCut(address(stub), IDiamondCut.FacetCutAction.Add, nakedSel);
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        oldFacetAddr = address(oldFacet);
        stubAddr = address(stub);
    }

    /// Владение — адресу, выведенному из PRIVATE_KEY (двухшаговая передача),
    /// плюс окружение, которое читает run().
    function _armRun(DiamondProxy diamond) internal returns (uint256 pk) {
        pk = 0xA11CE;
        address ownerAddr = vm.addr(pk);
        OwnershipFacet(address(diamond)).transferOwnership(ownerAddr);
        vm.prank(ownerAddr);
        OwnershipFacet(address(diamond)).acceptOwnership();
        vm.setEnv("DIAMOND_ADDRESS", vm.toString(address(diamond)));
        vm.setEnv("PRIVATE_KEY", vm.toString(pk));
    }

    /// Арбитр в состоянии живой цепи: зарегистрирован, но провенанс ПУСТ —
    /// поля seatedBy в момент его посадки не существовало. Воспроизводится
    /// сырой записью нулей поверх того, что проставил addArbiter.
    function _seatArbiterWithoutProvenance(DiamondProxy diamond, address arb) internal {
        ArbiterRegistryFacet(address(diamond)).addArbiter(arb);
        vm.store(address(diamond), keccak256(abi.encode(arb, uint256(ARB_POS) + SLOT_SEATED_BY)), bytes32(0));
        vm.store(
            address(diamond),
            keccak256(abi.encode(address(this), uint256(ARB_POS) + SLOT_SEATED_COUNT_BY)),
            bytes32(0)
        );
    }

    // ════════════════════════════════════════════════════════════════════
    // ПРЕД-ПОЛЁТ
    // ════════════════════════════════════════════════════════════════════

    /// Честное состояние: все три пред-проверки молчат и находят верные адреса.
    /// Без этого теста красные из следующих трёх ничего бы не доказывали: мало
    /// показать, что замок ревертит на плохом входе, надо показать, что на
    /// хорошем он НЕ ревертит.
    function test_PreflightPassesOnHonestState() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        address oldFacetAddr = _mountLiveLayout(diamond);

        address found = upgrade.checkReplaceGroup(upgrade.replaceSelectors(), address(diamond));
        assertEq(found, oldFacetAddr, unicode"checkReplaceGroup не нашёл смонтированный старый адрес фасета");

        upgrade.checkAddGroupUnmounted(upgrade.addSelectors(), address(diamond));

        address host = upgrade.checkRemoveGroupMounted(upgrade.removeSelectors(), address(diamond));
        assertEq(host, oldFacetAddr, unicode"голая кнопка сегодня сидит на том же фасете");
    }

    /// Снять `checkReplaceGroup(...)` из run() — этот тест покраснеет.
    ///
    /// Мир сломан по-настоящему: один из «остающихся» селекторов переведён на
    /// посторонний фасет, как если бы чужой апгрейд проехал между запусками.
    /// Replace на единый новый адрес в таком состоянии увёл бы часть маршрутов
    /// не туда, и без пред-полёта скрипт узнал бы об этом после броадкаста.
    function test_RunRevertsWhenReplaceGroupIsSplitAcrossFacets() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountLiveLayout(diamond);

        ArbiterRegistryFacet strayFacet = new ArbiterRegistryFacet();
        bytes4[] memory stray = new bytes4[](1);
        stray[0] = ArbiterRegistryFacet.getRefundableBounty.selector;
        IDiamondCut.FacetCut[] memory strayCut = new IDiamondCut.FacetCut[](1);
        strayCut[0] = IDiamondCut.FacetCut(address(strayFacet), IDiamondCut.FacetCutAction.Replace, stray);
        IDiamondCut(address(diamond)).diamondCut(strayCut, address(0), "");

        _armRun(diamond);

        vm.expectRevert(bytes(unicode"UpgradeArbiterAccountability: селекторы Replace разъехались больше чем по одному живому адресу фасета"));
        upgrade.run();
    }

    /// Снять `checkAddGroupUnmounted(...)` из run() — этот тест покраснеет.
    ///
    /// Мир сломан по-настоящему: один из новых селекторов уже смонтирован
    /// (повторный запуск скрипта, чужой параллельный cut). Без пред-полёта
    /// диамонд ревертнул бы весь diamondCut на "Diamond: selector exists" уже
    /// ПОСЛЕ броадкаста двух фасетов — деплой состоялся, разрез нет.
    function test_RunRevertsWhenAnAddSelectorIsAlreadyMounted() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountLiveLayout(diamond);

        ArbiterAccountabilityFacet stray = new ArbiterAccountabilityFacet();
        bytes4[] memory strayAdd = new bytes4[](1);
        strayAdd[0] = ArbiterAccountabilityFacet.suspendArbiter.selector;
        IDiamondCut.FacetCut[] memory strayCut = new IDiamondCut.FacetCut[](1);
        strayCut[0] = IDiamondCut.FacetCut(address(stray), IDiamondCut.FacetCutAction.Add, strayAdd);
        IDiamondCut(address(diamond)).diamondCut(strayCut, address(0), "");

        _armRun(diamond);

        vm.expectRevert(bytes(unicode"UpgradeArbiterAccountability: селектор из Add уже где-то смонтирован — Add ревертнёт"));
        upgrade.run();
    }

    /// Снять `checkRemoveGroupMounted(...)` из run() — этот тест покраснеет.
    ///
    /// Мир сломан по-настоящему: голой кнопки в даймонде уже нет (кто-то снял
    /// её раньше). Без пред-полёта Remove ревертнул бы "Diamond: selector not
    /// found" и отменил ВЕСЬ разрез — но опять же после броадкаста. А ещё это
    /// сигнал сам по себе: цепь не в том состоянии, для которого скрипт писан.
    function test_RunRevertsWhenRemoveTargetIsNotMounted() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        ArbiterRegistryFacet oldFacet = new ArbiterRegistryFacet();

        // Монтируем ТОЛЬКО 63 будущих Replace — без голой кнопки.
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut(address(oldFacet), IDiamondCut.FacetCutAction.Add, upgrade.replaceSelectors());
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        _armRun(diamond);

        vm.expectRevert(bytes(unicode"UpgradeArbiterAccountability: удаляемый селектор не смонтирован — удалять нечего"));
        upgrade.run();
    }

    // ════════════════════════════════════════════════════════════════════
    // ПОСТ-ПОЛЁТ: ГОЛАЯ КНОПКА
    // ════════════════════════════════════════════════════════════════════

    /// Кнопка работала до разреза и перестала после. Единственный тест, где
    /// переход виден целиком, — поэтому двойник, реально отвечающий на
    /// removeArbiter: со смонтированной-но-нереализованной функцией сравнение
    /// выродилось бы в «мертво до, мертво после» и не доказывало бы ничего.
    ///
    /// Разрез здесь применяется составом buildCuts() напрямую, а не через
    /// run(): двойник по определению стоит на ДРУГОМ адресе, чем группа
    /// Replace, а run() с круга правок 1 такое состояние отвергает пред-полётом
    /// (Important 1 — Remove на чужом фасете оторвал бы кусок чужого фасета).
    /// Проверяется здесь не пред-полёт, а сам факт «маршрут был — маршрута
    /// нет»; что эту проверку зовёт именно run(), доказывает соседний
    /// test_RunRevertsWhenNakedRemoveArbiterStillAnswers.
    function test_NakedButtonWasAliveBeforeTheCutAndDeadAfter() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        (, address stubAddr) = _mountLiveLayoutWithWorkingButton(diamond);
        assertTrue(stubAddr != address(0));

        (bool okBefore, ) = address(diamond).call(
            abi.encodeWithSignature("removeArbiter(address)", address(0xA1))
        );
        assertTrue(okBefore, unicode"предпосылка: до разреза голая кнопка обязана срабатывать");

        ArbiterRegistryFacet newReg = new ArbiterRegistryFacet();
        ArbiterAccountabilityFacet newAcc = new ArbiterAccountabilityFacet();
        IDiamondCut(address(diamond)).diamondCut(
            upgrade.buildCuts(address(newReg), address(newAcc)), address(0), ""
        );

        (bool okAfter, ) = address(diamond).call(
            abi.encodeWithSignature("removeArbiter(address)", address(0xA1))
        );
        assertFalse(okAfter, unicode"после разреза голая кнопка обязана быть мертва");
        assertEq(
            IDiamondLoupe(address(diamond)).facetAddress(bytes4(keccak256("removeArbiter(address)"))),
            address(0),
            unicode"после разреза селектор голой кнопки не должен вести никуда"
        );
        // И проверка скрипта на этом же мире молчит — то есть согласна с миром,
        // а не только ревертит на лживом.
        upgrade.assertNakedRemoveArbiterIsDead(address(diamond));
    }

    /// ⚠️ ЗАМЕР КРУГА ПРАВОК 1. Снять из run() строку
    /// `require(removeHost == oldFacet, ...)` — покраснеет ровно этот тест.
    ///
    /// Мир сломан по-настоящему и без единой подмены: голая removeArbiter
    /// смонтирована на ЧУЖОМ фасете (посторонний разрез между написанием
    /// скрипта и днём подписи). Группа Replace при этом честна и целиком сидит
    /// на своём адресе, все Add свободны, счёт сойдётся, и после разреза кнопка
    /// будет честно мертва — то есть НИ ОДНА другая проверка скрипта этого не
    /// видит. А Remove в таком мире выдёргивает селектор из чужого фасета:
    /// разрез зелёный, чужой фасет обкусан.
    function test_RunRevertsWhenRemoveTargetSitsOnAForeignFacet() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountLiveLayoutWithWorkingButton(diamond); // кнопка — на двойнике, не на фасете реестра
        _armRun(diamond);

        vm.expectRevert(bytes(unicode"pre-flight: removeArbiter сидит не на том фасете, что группа Replace"));
        upgrade.run();
    }

    /// ⚠️ ЗАМЕР ИЗ ЗАДАНИЯ. Снять из run() строку
    /// `assertNakedRemoveArbiterIsDead(diamond);` — покраснеет ровно этот тест.
    ///
    /// Мир сломан так, что упасть обязан САМ run(): разрез и маршруты честны,
    /// но вызов removeArbiter через даймонд ПРОХОДИТ — как если бы элемент
    /// Remove был собран с чужим селектором (опечатка в литерале 0x3487e08c) и
    /// удалил не то. Loupe в таком мире доволен, счёт селекторов сходится, а
    /// голая кнопка жива: снос без повода, без записи кто нажал и с возвратом
    /// залога. Никакая другая проверка run() этого не ловит — она и стоит
    /// отдельной строкой.
    function test_RunRevertsWhenNakedRemoveArbiterStillAnswers() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountLiveLayout(diamond);
        _armRun(diamond);

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(bytes4(keccak256("removeArbiter(address)"))),
            bytes("")
        );

        vm.expectRevert(bytes(unicode"post-flight: голая removeArbiter всё ещё маршрутизируется после разреза"));
        upgrade.run();
    }

    // ════════════════════════════════════════════════════════════════════
    // ПОСТ-ПОЛЁТ: СМОУК, СЧЁТ, ХРАНИЛИЩЕ
    // ════════════════════════════════════════════════════════════════════

    /// Снять `assertSuspensionWindowAnswers(diamond)` из run() — покраснеет
    /// этот тест. Маршрут при этом честный: подменён ОТВЕТ. Ровно тот случай,
    /// ради которого сверяется значение, а не факт возврата: фронт берёт окно
    /// из цепи и нарисовал бы человеку «48 часов», после чего цепь держала бы
    /// приостановку ещё сутки.
    function test_RunRevertsWhenSuspensionWindowAnswersWrong() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountLiveLayout(diamond);
        _armRun(diamond);

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(ArbiterAccountabilityFacet.getSuspensionWindow.selector),
            abi.encode(uint256(48 hours))
        );

        vm.expectRevert(bytes(unicode"post-flight: окно приостановки не отвечает через диамонд"));
        upgrade.run();
    }

    /// Тот же замок, но проверенный на СВОЁМ двойнике, а не мокке: селектор
    /// физически смонтирован на контракт, который отвечает 48 часами. Маршрут
    /// жив, loupe доволен, значение враньё.
    function test_SuspensionWindowCheckRevertsOnAWrongAnsweringFacet() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        WrongSuspensionWindowStub stub = new WrongSuspensionWindowStub();

        bytes4[] memory sel = new bytes4[](1);
        sel[0] = ArbiterAccountabilityFacet.getSuspensionWindow.selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut(address(stub), IDiamondCut.FacetCutAction.Add, sel);
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        vm.expectRevert(bytes(unicode"post-flight: окно приостановки не отвечает через диамонд"));
        upgrade.assertSuspensionWindowAnswers(address(diamond));
    }

    /// Снять итоговый `require(selectorsAfter == selectorsBefore + Add − Remove)`
    /// из run() — покраснеет этот тест. Ломается перепись: facets() отвечает
    /// одинаково обоим чтениям, до и после. Счёт обязан был сдвинуться на +22,
    /// а не сдвинулся вовсе — то есть разрез сделал не то, что заявлял. Ни одна
    /// другая проверка этого не ловит: маршруты по отдельности честны, старый
    /// адрес пуст, хранилище на месте, окно отвечает.
    function test_RunRevertsWhenRoutedSelectorCountDoesNotMove() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountLiveLayout(diamond);
        _armRun(diamond);

        IDiamondLoupe.Facet[] memory frozen = new IDiamondLoupe.Facet[](0);
        vm.mockCall(address(diamond), abi.encodeWithSelector(IDiamondLoupe.facets.selector), abi.encode(frozen));

        vm.expectRevert(bytes(unicode"post-flight: счёт смонтированных селекторов сдвинулся не ровно на +Add-Remove"));
        upgrade.run();
    }

    /// Снять `assertStorageContinuity(before, afterCut)` из run() — покраснеет
    /// этот тест. Расхождение сделано так же, как в соседнем файле:
    /// getVaultBalance() подменяется на СТАРОМ адресе фасета, поэтому
    /// пред-полётный снимок (диамонд делегирует туда до разреза) видит 999, а
    /// пост-полётный идёт уже в новый фасет и видит настоящее. Буквальная
    /// имитация того, ради чего сверка есть: одно поле до и после разреза
    /// читается разным кодом и разошлось.
    function test_RunRevertsWhenStorageDriftsAcrossTheCut() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        address oldFacetAddr = _mountLiveLayout(diamond);
        _armRun(diamond);

        vm.mockCall(
            oldFacetAddr,
            abi.encodeWithSelector(ArbiterRegistryFacet.getVaultBalance.selector),
            abi.encode(uint256(999))
        );

        vm.expectRevert(bytes(unicode"post-flight: getVaultBalance() изменился поперёк разреза — раскладка могла сдвинуться"));
        upgrade.run();
    }

    /// Снять `assertFacetHoldsNoSelectors(oldFacet, diamond)` из run() —
    /// покраснеет этот тест. Мир сломан без единой подмены: на старом адресе
    /// висит ЛИШНИЙ селектор, которого нет ни в одном списке разреза — след
    /// прежнего cut'а. Replace вытеснит знакомые, а этот останется, и старый
    /// адрес продолжит обслуживать живой маршрут поверх «уже заменённого» кода.
    function test_RunRevertsWhenOldFacetKeepsALeftoverSelector() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        address oldFacetAddr = _mountLiveLayout(diamond);

        bytes4[] memory leftover = new bytes4[](1);
        leftover[0] = bytes4(keccak256("leftoverFromAnOlderCut()"));
        IDiamondCut.FacetCut[] memory leftoverCut = new IDiamondCut.FacetCut[](1);
        leftoverCut[0] = IDiamondCut.FacetCut(oldFacetAddr, IDiamondCut.FacetCutAction.Add, leftover);
        IDiamondCut(address(diamond)).diamondCut(leftoverCut, address(0), "");

        _armRun(diamond);

        vm.expectRevert(bytes(unicode"UpgradeArbiterAccountability: у старого адреса фасета после разреза остались селекторы"));
        upgrade.run();
    }

    /// Снять любой из трёх `assertRouted(...)` — покраснеет этот тест.
    /// Заставить настоящий diamondCut увести селектор мимо нового фасета
    /// нельзя (маршруты собирает сам buildCuts), поэтому лжёт СПРАВОЧНИК: ответ
    /// loupe по одному селектору ответственности подменён нулём. Пред-полёт
    /// требует от Add-селекторов ровно нуля и остаётся доволен, а пост-полёт
    /// обязан увидеть новый фасет и не видит.
    function test_RunRevertsWhenAnAddSelectorDidNotLandOnTheNewFacet() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountLiveLayout(diamond);
        _armRun(diamond);

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                IDiamondLoupe.facetAddress.selector,
                ArbiterAccountabilityFacet.getArbiterStanding.selector
            ),
            abi.encode(address(0))
        );

        vm.expectRevert(bytes(unicode"UpgradeArbiterAccountability: селектор не приземлился на новый фасет"));
        upgrade.run();
    }

    // ════════════════════════════════════════════════════════════════════
    // МИГРАЦИЯ ПРОВЕНАНСА
    // ════════════════════════════════════════════════════════════════════

    /// Смещение seatedBy доказывается круговым замером через БОЕВОЙ геттер, а
    /// не принимается на слово: addArbiter пишет провенанс, геттер его видит,
    /// сырая запись нуля в тот же слот его гасит. Если бы слот был не тот,
    /// _seatArbiterWithoutProvenance ничего бы не гасил, и весь стенд миграции
    /// проверял бы уже записанный провенанс — то есть ничего.
    function test_SeatedBySlotOffsetIsProvenByGetter() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountLiveLayout(diamond);

        address arb = address(0xA12BE12);
        ArbiterRegistryFacet(address(diamond)).addArbiter(arb);

        // Геттеры провенанса приезжают этим же разрезом — сперва cut.
        ArbiterRegistryFacet newReg = new ArbiterRegistryFacet();
        ArbiterAccountabilityFacet newAcc = new ArbiterAccountabilityFacet();
        IDiamondCut(address(diamond)).diamondCut(
            upgrade.buildCuts(address(newReg), address(newAcc)), address(0), ""
        );

        ArbiterRegistryFacet d = ArbiterRegistryFacet(address(diamond));
        assertEq(d.getSeatedBy(arb), address(this), unicode"addArbiter обязан записать провенанс");
        assertEq(d.getSeatedCountBy(address(this)), 1, unicode"addArbiter обязан поднять счётчик посадок");

        vm.store(address(diamond), keccak256(abi.encode(arb, uint256(ARB_POS) + SLOT_SEATED_BY)), bytes32(0));
        vm.store(
            address(diamond),
            keccak256(abi.encode(address(this), uint256(ARB_POS) + SLOT_SEATED_COUNT_BY)),
            bytes32(0)
        );
        assertEq(d.getSeatedBy(arb), address(0), unicode"смещение seatedBy уехало — сырая запись не попала в поле");
        assertEq(d.getSeatedCountBy(address(this)), 0, unicode"смещение seatedCountBy уехало");
    }

    /// Backfill дописывает только пустое и не трогает уже записанное.
    ///
    /// Что исчезнет из поведения, если снять пропуск непустых: повторный запуск
    /// раздул бы seatedCountBy, а на нём держится потолок блока директора —
    /// каждый лишний счёт даёт директору лишнее место навсегда.
    function test_BackfillFillsOnlyEmptySeatsAndIsIdempotent() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountLiveLayout(diamond);

        address blank = address(0xB1A2C);
        address known = address(0xC0FFEE);
        _seatArbiterWithoutProvenance(diamond, blank);
        ArbiterRegistryFacet(address(diamond)).addArbiter(known); // провенанс = address(this)

        ArbiterRegistryFacet newReg = new ArbiterRegistryFacet();
        ArbiterAccountabilityFacet newAcc = new ArbiterAccountabilityFacet();
        IDiamondCut(address(diamond)).diamondCut(
            upgrade.buildCuts(address(newReg), address(newAcc)), address(0), ""
        );

        ArbiterRegistryFacet d = ArbiterRegistryFacet(address(diamond));
        address[] memory pending = upgrade.arbitersMissingProvenance(address(diamond));
        assertEq(pending.length, 1, unicode"пустое место ровно одно");
        assertEq(pending[0], blank);

        address seater = address(0xDEC1DE7);
        ArbiterProvenanceInit init = new ArbiterProvenanceInit();
        IDiamondCut(address(diamond)).diamondCut(
            new IDiamondCut.FacetCut[](0),
            address(init),
            abi.encodeCall(ArbiterProvenanceInit.backfillSeatedBy, (pending, seater))
        );

        assertEq(d.getSeatedBy(blank), seater, unicode"пустой провенанс не дописан");
        assertEq(d.getSeatedBy(known), address(this), unicode"чужой провенанс переписан — так нельзя");
        assertEq(d.getSeatedCountBy(seater), 1, unicode"счётчик посадок не поднят");

        // Повторный прогон по ТОМУ ЖЕ списку не должен менять ничего.
        IDiamondCut(address(diamond)).diamondCut(
            new IDiamondCut.FacetCut[](0),
            address(init),
            abi.encodeCall(ArbiterProvenanceInit.backfillSeatedBy, (pending, seater))
        );
        assertEq(d.getSeatedCountBy(seater), 1, unicode"повторная миграция раздула счётчик посадок");
    }

    /// Не-арбитр в списке — отказ, а не тихий пропуск: записать провенанс
    /// постороннему значит утверждать в цепи, что кто-то его посадил.
    function test_BackfillRevertsForNonArbiter() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountLiveLayout(diamond);

        ArbiterRegistryFacet newReg = new ArbiterRegistryFacet();
        ArbiterAccountabilityFacet newAcc = new ArbiterAccountabilityFacet();
        IDiamondCut(address(diamond)).diamondCut(
            upgrade.buildCuts(address(newReg), address(newAcc)), address(0), ""
        );

        address stranger = address(0x5747A9E);
        address[] memory list = new address[](1);
        list[0] = stranger;

        ArbiterProvenanceInit init = new ArbiterProvenanceInit();
        vm.expectRevert(abi.encodeWithSelector(ArbiterProvenanceInit.ProvenanceNotAnArbiter.selector, stranger));
        IDiamondCut(address(diamond)).diamondCut(
            new IDiamondCut.FacetCut[](0),
            address(init),
            abi.encodeCall(ArbiterProvenanceInit.backfillSeatedBy, (list, address(0xDEC1DE7)))
        );
    }

    /// Снять `migrateProvenance(diamond, pk)` из run() — покраснеет этот тест.
    /// Мерится СЛЕД, который миграция обязана оставить: у арбитра с пустым
    /// провенансом после run() записан владелец, и счётчик посадок владельца
    /// равен единице. Без вызова оба остались бы нулями — то есть цепь
    /// продолжала бы называть посаженного рукой самозаписавшимся.
    function test_RunMigratesProvenanceOfTheSeatedArbiter() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountLiveLayout(diamond);

        address arb = address(0x42dCd14e);
        _seatArbiterWithoutProvenance(diamond, arb);

        uint256 pk = _armRun(diamond);
        address ownerAddr = vm.addr(pk);

        upgrade.run();

        ArbiterRegistryFacet d = ArbiterRegistryFacet(address(diamond));
        assertEq(d.getSeatedBy(arb), ownerAddr, unicode"провенанс не дописан миграцией");
        assertEq(d.getSeatedCountBy(ownerAddr), 1, unicode"счётчик посадок владельца не поднят");
        assertEq(upgrade.arbitersMissingProvenance(address(diamond)).length, 0, unicode"после миграции пустых мест быть не должно");
    }

    /// Миграция не выдумывает работу там, где её нет: у всех арбитров провенанс
    /// заполнен — второй транзакции не будет, чужие записи не тронуты.
    function test_RunSkipsMigrationWhenNothingIsMissing() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountLiveLayout(diamond);

        address arb = address(0xA5EA7ED);
        ArbiterRegistryFacet(address(diamond)).addArbiter(arb); // провенанс = address(this)

        uint256 pk = _armRun(diamond);
        upgrade.run();

        ArbiterRegistryFacet d = ArbiterRegistryFacet(address(diamond));
        assertEq(d.getSeatedBy(arb), address(this), unicode"провенанс переписан на владельца — так нельзя");
        assertEq(d.getSeatedCountBy(vm.addr(pk)), 0, unicode"владельцу засчитана посадка, которой он не делал");
    }

    /// Аварийный вход работает сам по себе: разрез уже лёг (повторный run()
    /// откажет на пред-полёте — селекторы Add смонтированы), а провенанс не
    /// дописан. Что исчезнет из поведения, если снять migrateProvenanceOnly():
    /// человек, у которого вторая транзакция не доехала, остался бы без
    /// единственного способа её доделать — кроме как писать разовый скрипт
    /// руками в тот же вечер.
    function test_MigrateProvenanceOnlyFinishesAnInterruptedRollout() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountLiveLayout(diamond);

        address arb = address(0x42dCd14e);
        _seatArbiterWithoutProvenance(diamond, arb);

        // Разрез прошёл, вторая транзакция — нет.
        ArbiterRegistryFacet newReg = new ArbiterRegistryFacet();
        ArbiterAccountabilityFacet newAcc = new ArbiterAccountabilityFacet();
        IDiamondCut(address(diamond)).diamondCut(
            upgrade.buildCuts(address(newReg), address(newAcc)), address(0), ""
        );

        uint256 pk = _armRun(diamond);
        address ownerAddr = vm.addr(pk);
        ArbiterRegistryFacet d = ArbiterRegistryFacet(address(diamond));
        assertEq(d.getSeatedBy(arb), address(0), unicode"предпосылка: провенанс ещё не дописан");

        upgrade.migrateProvenanceOnly();
        assertEq(d.getSeatedBy(arb), ownerAddr, unicode"аварийный вход не дописал провенанс");
        assertEq(d.getSeatedCountBy(ownerAddr), 1, unicode"счётчик посадок не поднят");

        // Повторный вызов ничего не меняет и не шлёт транзакций.
        upgrade.migrateProvenanceOnly();
        assertEq(d.getSeatedCountBy(ownerAddr), 1, unicode"повторный аварийный вход раздул счётчик");
    }

    // ════════════════════════════════════════════════════════════════════
    // ПОЛНЫЙ ЦИКЛ
    // ════════════════════════════════════════════════════════════════════

    /// Буквально run() — не пересказ его шагов, а сам метод, с настоящими
    /// vm.envAddress/vm.envUint/vm.startBroadcast, на локально развёрнутом
    /// даймонде с сегодняшней раскладкой цепи. Даймонд ДО разреза сажается НЕ
    /// пустым: арбитр без провенанса и ненулевой банк — иначе сверка
    /// целостности хранилища сравнивала бы нули с нулями и прошла бы, даже
    /// будучи полностью сломанной.
    ///
    /// Смоук новых входов — ЧЕРЕЗ ДАЙМОНД, а не прямым вызовом фасета:
    /// «числится смонтированным» и «маршрут исполняет код» это разные вещи
    /// (класс бага d172064 — задеплоено, ни разу не сработало, заметили через
    /// месяц).
    function test_RunEndToEndOnLocalDiamond() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        address oldFacetAddr = _mountLiveLayout(diamond);

        address arb = address(0x42dCd14e);
        _seatArbiterWithoutProvenance(diamond, arb);
        _setVaultBalance(diamond, 777_000_000);

        uint256 pk = _armRun(diamond);
        address ownerAddr = vm.addr(pk);

        uint256 routedBefore = upgrade.totalRoutedSelectors(address(diamond));
        assertEq(routedBefore, 10 + 64, unicode"стенд обязан повторять живую раскладку: 64 арбитражных селектора");

        upgrade.run();

        // ── Маршруты ──────────────────────────────────────────────────────
        upgrade.assertFacetHoldsNoSelectors(oldFacetAddr, address(diamond));

        address newReg = IDiamondLoupe(address(diamond)).facetAddress(ArbiterRegistryFacet.addArbiter.selector);
        address newAcc = IDiamondLoupe(address(diamond)).facetAddress(ArbiterAccountabilityFacet.suspendArbiter.selector);
        assertTrue(newReg != address(0) && newReg != oldFacetAddr, unicode"реестр не переехал на новый адрес");
        assertTrue(newAcc != address(0) && newAcc != newReg, unicode"ответственность обязана быть отдельным фасетом");
        upgrade.assertRouted(upgrade.replaceSelectors(), newReg, address(diamond));
        upgrade.assertRouted(upgrade.addRegistrySelectors(), newReg, address(diamond));
        upgrade.assertRouted(upgrade.addAccountabilitySelectors(), newAcc, address(diamond));

        assertEq(
            upgrade.totalRoutedSelectors(address(diamond)),
            routedBefore + upgrade.addSelectors().length - upgrade.removeSelectors().length,
            unicode"счёт селекторов сдвинулся не ровно на +Add-Remove"
        );

        // ── Хранилище пережило разрез ─────────────────────────────────────
        ArbiterRegistryFacet d = ArbiterRegistryFacet(address(diamond));
        assertEq(d.getArbiters().length, 1, unicode"арбитр не пережил разрез");
        assertEq(d.getVaultBalance(), 777_000_000, unicode"банк не пережил разрез");
        assertTrue(d.isRegisteredArbiter(arb), unicode"статус арбитра не пережил разрез");

        // ── Голая кнопка мертва ───────────────────────────────────────────
        (bool ok, ) = address(diamond).call(abi.encodeWithSignature("removeArbiter(address)", arb));
        assertFalse(ok, unicode"голая removeArbiter обязана быть мертва после разреза");

        // ── Смоук новых входов ЧЕРЕЗ ДАЙМОНД ──────────────────────────────
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getSuspensionWindow(), 72 hours, unicode"окно приостановки не 72 часа");
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getProposalTTL(), 14 days, unicode"срок жизни предложения не две недели");
        assertFalse(ArbiterAccountabilityFacet(address(diamond)).isSuspended(arb), unicode"свежий арбитр не приостановлен");
        assertFalse(ArbiterAccountabilityFacet(address(diamond)).hasLiveProposal(arb), unicode"против свежего арбитра нет предложения");
        assertEq(d.getMaxClaimsPerArbiter(), 10, unicode"потолок споров на арбитра не отвечает");
        assertGt(d.getMaxArbiterMistakes(), 0, unicode"порог судейских ошибок не отвечает");
        assertEq(d.getCleanVerdicts(arb), 0, unicode"судейский стаж свежего арбитра обязан быть нулём");

        // Провенанс дописан второй транзакцией, и блок директора считается по
        // нему: директор не назначен, значит блок — ноль, а посадка засчитана
        // владельцу.
        assertEq(d.getSeatedBy(arb), ownerAddr, unicode"провенанс не мигрирован");
        assertEq(d.getSeatedCountBy(ownerAddr), 1, unicode"счётчик посадок владельца не поднят");
        assertEq(d.getChiefBloc(), 0, unicode"директора нет — блок обязан быть нулевым");

        // Пишущая функция нового фасета — тоже через даймонд. Отказ ожидаем и
        // он же доказательство, что маршрут исполняет НАШ код: пустой fallback
        // даймонда ревертнул бы "Diamond: function not found", а не прикладной
        // ошибкой фасета.
        vm.expectRevert(abi.encodeWithSignature("NothingToAnswer()"));
        ArbiterAccountabilityFacet(address(diamond)).respondToRemoval(bytes32(uint256(1)));
    }

    /// Прямая запись в vaultBalance (простое uint256-поле, слот POSITION+9).
    /// Сеттера без USDC-перевода нет, а fundVault() здесь недоступен — этот
    /// даймонд не монтирует Factory. Смещение подтверждается перечитыванием
    /// через геттер сразу после записи, а не на слово.
    function _setVaultBalance(DiamondProxy diamond, uint256 amount) internal {
        vm.store(address(diamond), bytes32(uint256(ARB_POS) + 9), bytes32(amount));
        assertEq(
            ArbiterRegistryFacet(address(diamond)).getVaultBalance(), amount,
            unicode"смещение vaultBalance в ArbiterRegistryStorage.Data уехало"
        );
    }
}
