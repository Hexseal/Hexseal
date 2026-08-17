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
import {ArbiterChainCensus} from "./ArbiterChainCensus.sol";
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

contract ArbiterAccountabilityUpgradeTest is Test, ArbiterChainCensus {
    UpgradeArbiterAccountability internal upgrade;

    /// Голая кнопка, названная ТЕКСТОМ ПОДПИСИ, а не `upgrade.removeSelectors()[0]`.
    /// Стенд не имеет права брать хоть один селектор из списков разреза — иначе
    /// он снова начнёт выводить проверяемое из проверяющего (задача 4.6).
    bytes4 internal constant NAKED_REMOVE_ARBITER = bytes4(keccak256("removeArbiter(address)"));

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
    /// ⚠️ ПЕРЕПИСАН ЗАДАЧЕЙ 4.5 (16 августа 2026) И УСИЛЕН, А НЕ ОСЛАБЛЕН.
    ///
    /// Прежняя редакция знала один фасет и складывала `replaceSelectors() +
    /// addRegistrySelectors()`, сверяя сумму с ABI реестра. После того как
    /// четырнадцать чтений уехали в фасет ответственности, эта сумма перестала
    /// быть осмысленной: общий Replace содержит теперь селекторы ОБОИХ фасетов.
    ///
    /// Новая редакция проверяет БОЛЬШЕ, чем прежняя: каждая из четырёх групп
    /// сверяется со СВОИМ фасетом ПОИМЁННО и ПО СЧЁТУ. То есть теперь пиннится
    /// не только «селектор не забыт», но и «селектор лежит в той группе, чей
    /// адрес его реализует» — ровно тот разъезд, который в этой задаче и
    /// возможен впервые.
    ///
    /// Что исчезнет из поведения, если снять: забытый в обеих группах селектор
    /// останется смонтированным на СТАРЫЙ адрес фасета — половина даймонда
    /// поедет новым кодом, половина старым, поверх одного хранилища. А селектор,
    /// попавший в группу ЧУЖОГО фасета, смонтируется на адрес, который его не
    /// реализует: diamondCut на это не ревертит (проверяет только «адрес другой
    /// и есть код»), и вызов начнёт ревертить уже в цепи.
    function test_ReplaceAndAddCoverWholeRegistryABI() public view {
        _assertGroupsCoverFacetExactly(
            "ArbiterRegistryFacet",
            upgrade.replaceRegistrySelectors(),
            upgrade.addRegistrySelectors()
        );
        _assertGroupsCoverFacetExactly(
            "ArbiterAccountabilityFacet",
            upgrade.replaceAccountabilitySelectors(),
            upgrade.addAccountabilitySelectors()
        );
    }

    /// Объединение двух групп ОДНОГО фасета обязано совпадать с его ABI —
    /// поимённо в обе стороны и по счёту. Счёт здесь не декоративен: без него
    /// список с повтором прошёл бы поимённую проверку.
    function _assertGroupsCoverFacetExactly(
        string memory facetName,
        bytes4[] memory replaceGroup,
        bytes4[] memory addGroup
    ) internal view {
        bytes4[] memory abiSels = _abiSelectors(facetName);
        assertGt(abiSels.length, 0, unicode"ABI фасета пуст — читать нечего");

        // Ни один селектор фасета не забыт.
        for (uint256 i = 0; i < abiSels.length; i++) {
            assertTrue(
                _contains(replaceGroup, abiSels[i]) || _contains(addGroup, abiSels[i]),
                string.concat(unicode"селектор не попал ни в Replace, ни в Add: ", facetName)
            );
        }
        // Ни один селектор группы не чужой этому фасету.
        for (uint256 i = 0; i < replaceGroup.length; i++) {
            assertTrue(
                _contains(abiSels, replaceGroup[i]),
                string.concat(unicode"Replace-группа несёт селектор чужого фасета: ", facetName)
            );
        }
        for (uint256 i = 0; i < addGroup.length; i++) {
            assertTrue(
                _contains(abiSels, addGroup[i]),
                string.concat(unicode"Add-группа несёт селектор чужого фасета: ", facetName)
            );
        }
        // И счётом — иначе повтор внутри группы прошёл бы обе проверки выше.
        assertEq(
            replaceGroup.length + addGroup.length, abiSels.length,
            string.concat(unicode"Replace+Add не совпадает с ABI по числу селекторов: ", facetName)
        );
    }

    /// Add покрывает ABI ArbiterAccountabilityFacet целиком.
    ///
    /// Что исчезнет из поведения, если снять: забытый Add означает функцию,
    /// которой в даймонде нет. Фронт зовёт — «Diamond: function not found».
    /// Мёртвая кнопка, и узнаем мы о ней от человека, который на неё нажал.
    function test_AddCoversWholeAccountabilityABI() public view {
        bytes4[] memory addAcc     = upgrade.addAccountabilitySelectors();
        bytes4[] memory replaceAcc = upgrade.replaceAccountabilitySelectors();
        bytes4[] memory abiSels    = _abiSelectors("ArbiterAccountabilityFacet");

        // ⚠️ Задача 4.5 (16 августа 2026): фасет ответственности приезжает
        // теперь ДВУМЯ группами, а не одной. Одиннадцать переехавших чтений
        // уже смонтированы в цепи, поэтому едут Replace'ом на новый адрес;
        // остальные двадцать — по-прежнему Add. Требовать «весь ABI лежит в
        // Add» стало бы неправдой, требовать «весь ABI лежит в объединении» —
        // ровно та же сила, что была.
        assertEq(
            addAcc.length + replaceAcc.length, abiSels.length,
            unicode"число монтируемых селекторов не совпадает с ABI нового фасета"
        );
        for (uint256 i = 0; i < abiSels.length; i++) {
            assertTrue(
                _contains(addAcc, abiSels[i]) || _contains(replaceAcc, abiSels[i]),
                unicode"селектор нового фасета забыт и в Add, и в Replace"
            );
        }

        // Полный addSelectors() обязан содержать всю Add-половину — из него
        // берёт пред-полёт (эти селекторы обязаны быть НЕ смонтированы) и
        // итоговый счёт. Replace-половина туда не входит по определению: она
        // в цепи уже есть.
        bytes4[] memory addAll = upgrade.addSelectors();
        for (uint256 i = 0; i < addAcc.length; i++) {
            assertTrue(_contains(addAll, addAcc[i]), unicode"селектор нового фасета потерялся в общем списке Add");
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
        string[] memory regSigs = new string[](3);
        regSigs[0] = "getChiefBloc()";
        regSigs[1] = "getMaxClaimsPerArbiter()";
        regSigs[2] = "getMaxArbiterMistakes()";

        string[] memory accSigs = new string[](21);
        accSigs[0]  = "suspendArbiter(address)";
        accSigs[1]  = "liftSuspension(address)";
        accSigs[2]  = "isSuspended(address)";
        accSigs[3]  = "getSuspendedUntil(address)";
        accSigs[4]  = "getSuspensionWindow()";
        accSigs[5]  = "removeArbiterForCause(address,uint8,bytes32,address,string)";
        accSigs[6]  = "getMistakeThreshold()";
        accSigs[7]  = "getMaxArbiterMistakesMirror()";
        accSigs[8]  = "getDaoThresholdMirror()";
        accSigs[9]  = "proposeRemoval(address,uint8,bytes32,string)";
        accSigs[10] = "withdrawProposal(address)";
        accSigs[11] = "getRemovalProposal(address)";
        accSigs[12] = "hasLiveProposal(address)";
        accSigs[13] = "getProposalTTL()";
        accSigs[14] = "respondToRemoval(bytes32,string)";
        accSigs[15] = "getRemovalReply(address)";
        accSigs[16] = "getArbiterStanding(address)";
        // Задача 4.5: три чтения переехали из реестра и ЕЩЁ НЕ смонтированы,
        // потому остались Add — просто в другом списке и на другой адрес.
        accSigs[17] = "getSeatedBy(address)";
        accSigs[18] = "getSeatedCountBy(address)";
        accSigs[19] = "getCleanVerdicts(address)";
        // Причина словами (замысел 17 августа 2026, решение 7): потолок слов в
        // БАЙТАХ. Три подписи выше переписаны той же работой — обвинение и
        // защита получили строку, и подпись в цепи от этого сменилась.
        accSigs[20] = "getMaxReasonBytes()";

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

    /// Состав buildCuts(): ПЯТЬ записей, свои действия, свои адреса.
    /// Пять, а не три, потому что И Replace, И Add едут на ДВА разных адреса —
    /// один элемент FacetCut несёт ровно один адрес (задача 4.5, 16 августа
    /// 2026: одиннадцать смонтированных чтений переехали на фасет
    /// ответственности и остались Replace, потому что в цепи они уже есть).
    ///
    /// Что исчезнет из поведения, если снять: перепутанный адрес у половины
    /// Replace смонтировал бы одиннадцать чтений на фасет, который их не
    /// реализует. diamondCut на это НЕ ревертит — он проверяет только «адрес
    /// другой и есть код». Тихий разъезд «смонтировано, но не работает».
    function test_BuildCutsShapeAndAddresses() public view {
        address reg = address(0xBEEF);
        address acc = address(0xCAFE);
        IDiamondCut.FacetCut[] memory cuts = upgrade.buildCuts(reg, acc);

        assertEq(cuts.length, 5, unicode"buildCuts: ожидались ровно пять записей FacetCut");

        // ⚠️ ЧИСЛА ЗДЕСЬ ЛИТЕРАЛЬНЫЕ (задача 4.6, 16 августа 2026). Раньше на
        // их месте стояло `upgrade.replaceRegistrySelectors().length` и т.д. —
        // сверка списка с самим собой, зелёная при любом его составе. У соседних
        // разрезов на этом месте литералы и стояли (UpgradeFeeModelSelectors:
        // «expected 44», «exactly 14»). Обмен они не поймают — это счёт, а не
        // тождество, для того выше стоят две сверки с переписью цепи, — но
        // одиночный переезд из группы в группу ловят вторым, независимым от
        // литеральных подписей замком.
        assertTrue(cuts[0].action == IDiamondCut.FacetCutAction.Replace, unicode"cuts[0] должен быть Replace");
        assertEq(cuts[0].facetAddress, reg, unicode"Replace-реестр: адрес обязан быть новым реестром");
        assertEq(cuts[0].functionSelectors.length, 52, unicode"Replace-реестр: ожидались ровно 52 селектора");

        assertTrue(cuts[1].action == IDiamondCut.FacetCutAction.Replace, unicode"cuts[1] должен быть Replace");
        assertEq(cuts[1].facetAddress, acc, unicode"Replace-ответственность: адрес обязан быть новым фасетом");
        assertEq(cuts[1].functionSelectors.length, 11, unicode"Replace-ответственность: ожидались ровно 11 селекторов");

        assertTrue(cuts[2].action == IDiamondCut.FacetCutAction.Add, unicode"cuts[2] должен быть Add");
        assertEq(cuts[2].facetAddress, reg, unicode"Add-реестр: адрес обязан быть новым реестром");
        assertEq(cuts[2].functionSelectors.length, 3, unicode"Add-реестр: ожидались ровно 3 селектора");

        assertTrue(cuts[3].action == IDiamondCut.FacetCutAction.Add, unicode"cuts[3] должен быть Add");
        assertEq(cuts[3].facetAddress, acc, unicode"Add-ответственность: адрес обязан быть новым фасетом");
        assertEq(cuts[3].functionSelectors.length, 21, unicode"Add-ответственность: ожидались ровно 21 селектор");

        // Remove — последним и с нулевым адресом: DiamondCutLib.removeFunctions
        // требует ровно этого ("Diamond: remove needs zero address"), а
        // последним — чтобы никакое следующее действие не вернуло селектор.
        assertTrue(cuts[4].action == IDiamondCut.FacetCutAction.Remove, unicode"cuts[4] должен быть Remove");
        assertEq(cuts[4].facetAddress, address(0), unicode"Remove: адрес обязан быть нулевым");
        assertEq(cuts[4].functionSelectors.length, 1, unicode"Remove: ровно один селектор");
    }

    /// Общий Replace — ровно объединение своих двух половин, как и общий Add.
    /// Он не декоративен: из него берёт пред-полёт checkReplaceGroup, который
    /// требует, чтобы ВСЕ заменяемые селекторы сидели сегодня на ОДНОМ адресе.
    ///
    /// Что исчезнет из поведения, если снять: половина, выпавшая из общего
    /// списка, не попала бы под пред-полёт вовсе — и её несмонтированность
    /// выяснилась бы боевым "Diamond: selector not found" уже после броадкаста
    /// двух новых фасетов.
    function test_ReplaceSelectorsIsExactlyTheUnionOfItsTwoHalves() public view {
        bytes4[] memory all = upgrade.replaceSelectors();
        bytes4[] memory reg = upgrade.replaceRegistrySelectors();
        bytes4[] memory acc = upgrade.replaceAccountabilitySelectors();

        assertEq(all.length, reg.length + acc.length, unicode"общий Replace не равен сумме половин");
        for (uint256 i = 0; i < reg.length; i++) assertTrue(_contains(all, reg[i]), unicode"половина реестра потерялась в общем Replace");
        for (uint256 i = 0; i < acc.length; i++) assertTrue(_contains(all, acc[i]), unicode"половина ответственности потерялась в общем Replace");
    }

    // ════════════════════════════════════════════════════════════════════
    // ДЕЛЕНИЕ REPLACE/ADD ПРОТИВ ПЕРЕПИСИ ЖИВОЙ ЦЕПИ (задача 4.6)
    //
    // Всё, что выше, сверяет списки со СКОМПИЛИРОВАННЫМ ABI — то есть отвечает
    // на вопрос «что умеет наш код». На вопрос «что смонтировано в даймонде
    // СЕГОДНЯ» ABI не отвечает вовсе, а именно им и определяется граница между
    // Replace и Add: `Replace` ревертит на несмонтированном селекторе, `Add` —
    // на смонтированном. Оракул здесь один — перепись, снятая с цепи
    // (test/ArbiterChainCensus.sol).
    //
    // Оба теста ниже — ТОЖДЕСТВА, а не количества. Счёт ловит одиночный переезд
    // и не ловит обмен: переложи смонтированный селектор в Add, а
    // несмонтированный в Replace, поправив заодно литеральный список подписей —
    // и все числа останутся прежними (11 и 21, 63+1). Замерено ревью задачи
    // 4.5: 843 зелёных, 0 красных, разрез в бою отвергнут целиком.
    // ════════════════════════════════════════════════════════════════════

    /// ТОЖДЕСТВО ПЕРВОЕ: всё, что живой даймонд маршрутизирует на старый фасет,
    /// этим разрезом либо заменяется, либо снимается — ни больше, ни меньше.
    ///
    /// Ловит обе половины обмена сразу: селектор, СМОНТИРОВАННЫЙ в цепи и
    /// переложенный в Add, пропадёт из объединения (недобор); селектор,
    /// в цепи ОТСУТСТВУЮЩИЙ и переложенный в Replace, окажется лишним (перебор).
    ///
    /// Что исчезнет из поведения, если снять: боевой `Replace` получит селектор,
    /// которого в даймонде нет, и `diamondCut` ревертнёт "Diamond: selector not
    /// found" — весь разрез отменён одной транзакцией, уже после броадкаста
    /// двух новых фасетов. Либо, симметрично, старый адрес не опустеет
    /// полностью, и половина даймонда поедет старым кодом поверх нового
    /// хранилища.
    function test_ReplaceAndRemoveExactlyCoverTheChainCensus() public view {
        bytes4[] memory census = _chainCensus(upgrade.scriptPath());
        bytes4[] memory replaceSels = upgrade.replaceSelectors();
        bytes4[] memory removeSels = upgrade.removeSelectors();

        assertEq(census.length, 64, unicode"перепись цепи обязана быть 64 селектора");

        // Ни один смонтированный селектор не забыт: он либо заменяется, либо снимается.
        for (uint256 i = 0; i < census.length; i++) {
            assertTrue(
                _censusContains(replaceSels, census[i]) || _censusContains(removeSels, census[i]),
                unicode"селектор смонтирован в цепи, но не попал ни в Replace, ни в Remove"
            );
        }
        // И ни один заменяемый/снимаемый не выдуман: он обязан быть в цепи.
        for (uint256 i = 0; i < replaceSels.length; i++) {
            assertTrue(
                _censusContains(census, replaceSels[i]),
                unicode"Replace целится в селектор, которого в цепи нет — diamondCut ревертнёт весь разрез"
            );
        }
        for (uint256 i = 0; i < removeSels.length; i++) {
            assertTrue(
                _censusContains(census, removeSels[i]),
                unicode"Remove целится в селектор, которого в цепи нет — удалять нечего"
            );
        }
        // Счётом — иначе повтор внутри Replace прошёл бы обе проверки выше.
        assertEq(
            replaceSels.length + removeSels.length,
            census.length,
            unicode"Replace+Remove не сходится с переписью по числу селекторов"
        );
    }

    /// ТОЖДЕСТВО ВТОРОЕ: ни одного добавляемого селектора в цепи ещё нет.
    ///
    /// Что исчезнет из поведения, если снять: боевой `Add` по уже
    /// смонтированному селектору ревертит "Diamond: selector exists" и отменяет
    /// ВЕСЬ разрез. Пред-полёт `checkAddGroupUnmounted` заведён ровно под этот
    /// случай, но он живёт на стенде и запускается один раз в бою; здесь то же
    /// самое утверждается прямо о данных, без даймонда.
    function test_AddSelectorsAreAbsentFromTheChainCensus() public view {
        bytes4[] memory census = _chainCensus(upgrade.scriptPath());
        bytes4[] memory addSels = upgrade.addSelectors();

        for (uint256 i = 0; i < addSels.length; i++) {
            assertFalse(
                _censusContains(census, addSels[i]),
                unicode"Add несёт селектор, который в цепи уже смонтирован — Add ревертнёт весь разрез"
            );
        }
    }

    /// ЛУПА ОТДАЁТ ПЕРЕПИСЬ ЦЕЛИКОМ — сквозная проверка монтировки, НЕ третье
    /// тождество.
    ///
    /// ⚠️ ПЕРЕИМЕНОВАН И ПЕРЕПИСАН (уборка 7а, п. 2.8, Ruling 31). Звался
    /// `test_LiveLayoutStandIsTheChainCensusItself` и был объявлен «тождеством
    /// третьим, ГЛАВНЫМ». Своей мутацией он не ловится: верните
    /// `_mountLiveLayout` на `upgrade.replaceSelectors()` — 0 красных из 848
    /// (замерено ревью задачи 4.6). Причина не в слабости замка, а в том, что
    /// утверждение ТАВТОЛОГИЧНО, пока держится тождество первое
    /// (`Replace ∪ Remove == перепись`): стенд монтирует перепись, лупа отдаёт
    /// смонтированное, множества сходятся по построению.
    ///
    /// Настоящая защита от перекрёстной подмены Replace/Add — два тождества НА
    /// ДАННЫХ выше (test_ReplaceAndRemoveExactlyCoverTheChainCensus и
    /// test_AddSelectorsAreAbsentFromTheChainCensus), и она доказана: та же
    /// подмена даёт 20 красных, оба тождества среди них своими сообщениями.
    /// Четвёртый замок вместо этого НЕ строится намеренно — он сторожил бы то
    /// же самое третий раз.
    ///
    /// Что этот тест сторожит НА САМОМ ДЕЛЕ, и почему остаётся: он единственный
    /// проверяет, что путь «перепись → diamondCut → лупа» проходит ЦЕЛИКОМ, без
    /// потерь на монтировке. Тождества выше сравнивают списки с файлом и
    /// даймонда не поднимают вовсе; если бы `_mountLiveLayout` смонтировал
    /// перепись частично (обрезанный массив, дубль селектора, `Add` вместо
    /// `Replace` на части), они бы этого не увидели, а стенды всех остальных
    /// тестов молча работали бы на неполной раскладке.
    function test_MountingTheCensusRoutesEverySelectorToTheOldFacet() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        address oldFacetAddr = _mountLiveLayout(diamond);

        bytes4[] memory mounted = IDiamondLoupe(address(diamond)).facetFunctionSelectors(oldFacetAddr);
        bytes4[] memory census = _chainCensus(upgrade.scriptPath());

        assertEq(mounted.length, census.length, unicode"стенд смонтировал не столько селекторов, сколько в переписи");
        for (uint256 i = 0; i < census.length; i++) {
            assertTrue(
                _censusContains(mounted, census[i]),
                unicode"селектор из переписи не смонтирован стендом"
            );
        }
        for (uint256 i = 0; i < mounted.length; i++) {
            assertTrue(
                _censusContains(census, mounted[i]),
                unicode"стенд смонтировал селектор, которого в переписи нет"
            );
        }
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

    /// Раскладка, буквально совпадающая с Base Sepolia: все 64 арбитражных
    /// селектора (63 будущих Replace + голая removeArbiter) на ОДНОМ адресе
    /// фасета. Голая кнопка при этом смонтирована, но не реализована — задача 6
    /// удалила функцию из кода, — что для проверок маршрутизации ровно то же
    /// самое: addFunctions требует от адреса только наличия кода. Тестам,
    /// которым нужна ЖИВАЯ кнопка, служит _mountLiveLayoutWithWorkingButton.
    ///
    /// ⚠️ ПЕРЕВЕДЁН НА ПЕРЕПИСЬ ЦЕПИ (задача 4.6, 16 августа 2026). Раньше здесь
    /// стояло `upgrade.replaceSelectors() + upgrade.removeSelectors()[0]` — то
    /// есть стенд выводил «что смонтировано в цепи» ИЗ ТОГО САМОГО СПИСКА,
    /// который проверяет. Селектор, переложенный из Replace в Add, исчезал из
    /// стенда вместе со списком, и `checkAddGroupUnmounted` честно не находил
    /// его смонтированным: пред-полёт, заведённый ровно под этот случай, молчал.
    /// Симметрично страдал `checkReplaceGroup` — «все Replace на одном адресе»
    /// на раскладке, собранной из его же аргумента, верно по построению.
    ///
    /// Теперь монтируется ПЕРЕПИСЬ — 64 селектора, снятые с цепи и лежащие
    /// данными (test/fixtures/…). Стенд перестал зависеть от проверяемого, и
    /// обе пред-проверки стали настоящими.
    ///
    /// Что исчезнет из поведения, если вернуть список на место: перекрёстная
    /// подмена (смонтированный селектор в Add, несмонтированный в Replace, счёт
    /// не сдвинулся) снова пройдёт молча — и отвергнет весь разрез одной боевой
    /// транзакцией, уже после броадкаста двух фасетов.
    function _mountLiveLayout(DiamondProxy diamond) internal returns (address oldFacetAddr) {
        ArbiterRegistryFacet oldFacet = new ArbiterRegistryFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut(address(oldFacet), IDiamondCut.FacetCutAction.Add, _chainCensus(upgrade.scriptPath()));
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        oldFacetAddr = address(oldFacet);
    }

    /// То же самое, но removeArbiter смонтирована на двойник, который на неё
    /// РЕАЛЬНО отвечает: единственный способ показать переход «кнопка работала
    /// → кнопка мертва», раз настоящей функции в коде больше нет.
    ///
    /// ⚠️ Тоже от переписи (задача 4.6): 63 = перепись минус голая кнопка,
    /// названная текстом подписи. Ни одного селектора из списков разреза.
    function _mountLiveLayoutWithWorkingButton(DiamondProxy diamond)
        internal returns (address oldFacetAddr, address stubAddr)
    {
        ArbiterRegistryFacet oldFacet = new ArbiterRegistryFacet();
        LegacyRemoveArbiterStub stub = new LegacyRemoveArbiterStub();

        bytes4[] memory nakedSel = new bytes4[](1);
        nakedSel[0] = NAKED_REMOVE_ARBITER;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut(
            address(oldFacet),
            IDiamondCut.FacetCutAction.Add,
            _censusWithout(_chainCensus(upgrade.scriptPath()), NAKED_REMOVE_ARBITER)
        );
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
        // ⚠️ ГОНКА ЧЕРЕЗ ПРОЦЕСС-ГЛОБАЛЬНЫЙ vm.setEnv (задача 4.6, Ruling 34,
        // 16 августа 2026). `vm.setEnv` пишет в окружение ПРОЦЕССА, а сюиты
        // форджа идут параллельно. Три стенда разрезов
        // (ArbiterAccountabilityUpgrade, PresentationRecordUpgrade,
        // ArbiterChatKeyUpgrade) кладут сюда DIAMOND_ADDRESS и тут же читают
        // его внутри run(). Безобидно это ровно потому, что все три кладут
        // ОДИН И ТОТ ЖЕ адрес: последовательность `new` до создания даймонда у
        // них совпадает, а значит совпадает и nonce.
        //
        // Лишний `new`, дописанный в любой из трёх, сдвигает nonce — адрес
        // уезжает, чужой run() уходит лупой в посторонний контракт, и полный
        // прогон начинает падать «случайным EvmError: Revert» примерно раз в
        // двадцать раз, ничего не говоря о причине (замерено: 2 падения из 40
        // при зелёном одиночном прогоне 25 из 25).
        //
        // Сама гонка этой строкой НЕ чинится — настоящее лекарство в том,
        // чтобы не передавать адрес через окружение вовсе, и оно записано
        // отдельным пунктом в OPEN-ITEMS. Строка превращает будущий флейк в
        // ДЕТЕРМИНИРОВАННЫЙ красный с названной причиной.
        //
        // Адрес взят ЗАМЕРОМ (пробой assertEq по всем трём стендам разом), а
        // не выведен из кода: выведенный уехал бы вместе с гонкой и промолчал.
        assertEq(
            address(diamond),
            0xc7183455a4C133Ae270771860664b6B7ec320bB1,
            unicode"адрес даймонда уехал: сдвинулся nonce стенда, и DIAMOND_ADDRESS "
            unicode"в процессе теперь разный у трёх сюит — см. комментарий выше"
        );
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

        // Монтируем перепись БЕЗ голой кнопки — 63 из 64. Вычитается она по
        // тексту подписи, а не по upgrade.removeSelectors(): стенд не берёт из
        // списков разреза ничего (задача 4.6).
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut(
            address(oldFacet),
            IDiamondCut.FacetCutAction.Add,
            _censusWithout(_chainCensus(upgrade.scriptPath()), NAKED_REMOVE_ARBITER)
        );
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
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getSeatedBy(arb), address(this), unicode"addArbiter обязан записать провенанс");
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getSeatedCountBy(address(this)), 1, unicode"addArbiter обязан поднять счётчик посадок");

        vm.store(address(diamond), keccak256(abi.encode(arb, uint256(ARB_POS) + SLOT_SEATED_BY)), bytes32(0));
        vm.store(
            address(diamond),
            keccak256(abi.encode(address(this), uint256(ARB_POS) + SLOT_SEATED_COUNT_BY)),
            bytes32(0)
        );
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getSeatedBy(arb), address(0), unicode"смещение seatedBy уехало — сырая запись не попала в поле");
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getSeatedCountBy(address(this)), 0, unicode"смещение seatedCountBy уехало");
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

        assertEq(ArbiterAccountabilityFacet(address(diamond)).getSeatedBy(blank), seater, unicode"пустой провенанс не дописан");
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getSeatedBy(known), address(this), unicode"чужой провенанс переписан — так нельзя");
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getSeatedCountBy(seater), 1, unicode"счётчик посадок не поднят");

        // Повторный прогон по ТОМУ ЖЕ списку не должен менять ничего.
        IDiamondCut(address(diamond)).diamondCut(
            new IDiamondCut.FacetCut[](0),
            address(init),
            abi.encodeCall(ArbiterProvenanceInit.backfillSeatedBy, (pending, seater))
        );
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getSeatedCountBy(seater), 1, unicode"повторная миграция раздула счётчик посадок");
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
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getSeatedBy(arb), ownerAddr, unicode"провенанс не дописан миграцией");
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getSeatedCountBy(ownerAddr), 1, unicode"счётчик посадок владельца не поднят");
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
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getSeatedBy(arb), address(this), unicode"провенанс переписан на владельца — так нельзя");
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getSeatedCountBy(vm.addr(pk)), 0, unicode"владельцу засчитана посадка, которой он не делал");
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
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getSeatedBy(arb), address(0), unicode"предпосылка: провенанс ещё не дописан");

        upgrade.migrateProvenanceOnly();
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getSeatedBy(arb), ownerAddr, unicode"аварийный вход не дописал провенанс");
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getSeatedCountBy(ownerAddr), 1, unicode"счётчик посадок не поднят");

        // Повторный вызов ничего не меняет и не шлёт транзакций.
        upgrade.migrateProvenanceOnly();
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getSeatedCountBy(ownerAddr), 1, unicode"повторный аварийный вход раздул счётчик");
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
        // ⚠️ ЧЕТЫРЕ ГРУППЫ, А НЕ ТРИ (задача 4.5, 16 августа 2026). Общий
        // replaceSelectors() здесь больше не годится: он содержит селекторы
        // ОБОИХ фасетов, и проверка «все на newReg» была бы заведомо ложной.
        // Каждая половина сверяется со СВОИМ адресом — это строже прежнего,
        // потому что пиннит ещё и принадлежность, а не только «переехало».
        upgrade.assertRouted(upgrade.replaceRegistrySelectors(), newReg, address(diamond));
        upgrade.assertRouted(upgrade.replaceAccountabilitySelectors(), newAcc, address(diamond));
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
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getCleanVerdicts(arb), 0, unicode"судейский стаж свежего арбитра обязан быть нулём");

        // Провенанс дописан второй транзакцией, и блок директора считается по
        // нему: директор не назначен, значит блок — ноль, а посадка засчитана
        // владельцу.
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getSeatedBy(arb), ownerAddr, unicode"провенанс не мигрирован");
        assertEq(ArbiterAccountabilityFacet(address(diamond)).getSeatedCountBy(ownerAddr), 1, unicode"счётчик посадок владельца не поднят");
        assertEq(d.getChiefBloc(), 0, unicode"директора нет — блок обязан быть нулевым");

        // Пишущая функция нового фасета — тоже через даймонд. Отказ ожидаем и
        // он же доказательство, что маршрут исполняет НАШ код: пустой fallback
        // даймонда ревертнул бы "Diamond: function not found", а не прикладной
        // ошибкой фасета.
        vm.expectRevert(abi.encodeWithSignature("NothingToAnswer()"));
        ArbiterAccountabilityFacet(address(diamond)).respondToRemoval(bytes32(uint256(1)), "");
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
