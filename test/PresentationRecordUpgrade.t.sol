// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";
import {UpgradePresentationRecord} from "../script/UpgradePresentationRecord.s.sol";
import "../src/DiamondProxy.sol";

/// Двойник, отвечающий на getNoResponseFloor() НЕ тем числом. Нужен ровно для
/// одного: доказать замером, что пост-проверка пола в скрипте правда сверяет
/// ЗНАЧЕНИЕ, а не только «вызов не ревертнул». Без него require про пол был бы
/// тавтологией — свежесобранный фасет по определению отдаёт свою же константу.
contract WrongFloorStub {
    function getNoResponseFloor() external pure returns (uint256) {
        return 12 hours;
    }
}

contract PresentationRecordUpgradeTest is Test {
    UpgradePresentationRecord internal upgrade;

    function setUp() public {
        upgrade = new UpgradePresentationRecord();
    }

    // ── Ground truth: читаем прямо из скомпилированного артефакта — тот же
    //    приём, что test/DeployFullSelectors.t.sol::_abiSelectors ──────────
    function _abiSelectors(string memory contractName) internal view returns (bytes4[] memory out) {
        string memory json = vm.readFile(string.concat("out/", contractName, ".sol/", contractName, ".json"));
        string[] memory sigs = vm.parseJsonKeys(json, ".methodIdentifiers");
        out = new bytes4[](sigs.length);
        for (uint256 i; i < sigs.length; i++) out[i] = bytes4(keccak256(bytes(sigs[i])));
    }

    // ════════════════════════════════════════════════════════════════════
    // Состав cut'а против скомпилированного ABI
    // ════════════════════════════════════════════════════════════════════

    /// Полнота: объединение replaceSelectors() и addSelectors() совпадает (как
    /// множество, без дубликатов) со всеми селекторами скомпилированного
    /// ArbiterRegistryFacet.
    ///
    /// Что исчезнет из поведения, если снять: забытый в Replace селектор молча
    /// останется висеть на прежнем адресе фасета — диамонд после апгрейда
    /// наполовину поедет старым кодом, и никто этого не заметит, пока не
    /// наткнётся на конкретный вызов. Забытый в Add — новая функция просто не
    /// смонтируется, и фронт получит «Diamond: Function does not exist».
    ///
    /// Этот тест перенял живую роль снятого test_ReplaceAndAddCoverWholeFacet
    /// из test/ArbiterChatKeyUpgrade.t.sol (см. комментарий там).
    function test_ReplaceAndAddCoverWholeFacet() public view {
        bytes4[] memory replaceSels = upgrade.replaceSelectors();
        bytes4[] memory addSels = upgrade.addSelectors();
        bytes4[] memory expected = _abiSelectors("ArbiterRegistryFacet");

        bytes4[] memory actual = new bytes4[](replaceSels.length + addSels.length);
        for (uint256 i = 0; i < replaceSels.length; i++) actual[i] = replaceSels[i];
        for (uint256 i = 0; i < addSels.length; i++) actual[replaceSels.length + i] = addSels[i];

        assertEq(
            actual.length, expected.length,
            unicode"список скрипта разошёлся с ABI фасета"
        );

        for (uint256 i = 0; i < actual.length; i++) {
            bool found = false;
            for (uint256 j = 0; j < expected.length; j++) {
                if (actual[i] == expected[j]) { found = true; break; }
            }
            assertTrue(found, unicode"Replace+Add: монтируется селектор, которого у фасета нет (фантом)");
        }

        for (uint256 i = 0; i < expected.length; i++) {
            bool found = false;
            for (uint256 j = 0; j < actual.length; j++) {
                if (expected[i] == actual[j]) { found = true; break; }
            }
            assertTrue(found, unicode"Replace+Add: у фасета есть селектор, которого cut не монтирует (недомонтаж)");
        }
    }

    /// Восемь Add-селекторов — именно те восемь, и названы по ПОДПИСИ, а не по
    /// `.selector` из того же фасета. Сверка `.selector` с `.selector` была бы
    /// тавтологией: переименуй функцию — совпадут оба. Здесь слева фасет,
    /// справа литеральная подпись, на которую уже завязаны фронт (Задача 5) и
    /// релеер, — расхождение обязано краснеть.
    ///
    /// Что исчезнет из поведения, если снять: сменившаяся подпись (лишний
    /// аргумент, uint256 вместо bytes32) проехала бы молча — цепь смонтировала
    /// бы новый селектор, а фронт продолжал бы звать старый и получал «функции
    /// не существует».
    function test_AddSelectorsAreTheEightNewSignatures() public view {
        bytes4[] memory addSels = upgrade.addSelectors();
        assertEq(addSels.length, 8, unicode"Add: новых селекторов ровно восемь");

        bytes4[8] memory expected = [
            bytes4(keccak256("getDisputeClaimedAt(address)")),
            bytes4(keccak256("recordNoResponse(address)")),
            bytes4(keccak256("getNoResponseAt(address)")),
            bytes4(keccak256("getNoResponseFloor()")),
            bytes4(keccak256("recordPresentationDigest(address,bytes32)")),
            bytes4(keccak256("getPresentationDigests(address)")),
            bytes4(keccak256("getPresentationDigestCount(address)")),
            bytes4(keccak256("getPresentationDigestsPage(address,uint256,uint256)"))
        ];

        for (uint256 i = 0; i < expected.length; i++) {
            bool found = false;
            for (uint256 j = 0; j < addSels.length; j++) {
                if (expected[i] == addSels[j]) { found = true; break; }
            }
            assertTrue(found, unicode"Add: одна из восьми подписей не смонтирована этим разрезом");
        }

        // И обратная сторона: ни один из восьми не сидит заодно в Replace —
        // diamondCut отверг бы весь разрез на "Diamond: selector exists".
        bytes4[] memory replaceSels = upgrade.replaceSelectors();
        for (uint256 i = 0; i < expected.length; i++) {
            for (uint256 j = 0; j < replaceSels.length; j++) {
                assertTrue(
                    expected[i] != replaceSels[j],
                    unicode"новый селектор попал ещё и в Replace — весь cut ревертнёт на живом даймонде"
                );
            }
        }
    }

    /// Ни один селектор не назван дважды между двумя списками.
    ///
    /// Что исчезнет из поведения, если снять: тихая опечатка вместо понятного
    /// отказа при сборке — диамонд на цепи ревертнул бы весь cut, но узнали бы
    /// мы об этом на настоящей выкатке, а не заранее.
    function test_NoSelectorNamedTwiceAcrossLists() public view {
        bytes4[] memory replaceSels = upgrade.replaceSelectors();
        bytes4[] memory addSels = upgrade.addSelectors();

        bytes4[] memory all = new bytes4[](replaceSels.length + addSels.length);
        uint256 k = 0;
        for (uint256 i = 0; i < replaceSels.length; i++) all[k++] = replaceSels[i];
        for (uint256 i = 0; i < addSels.length; i++) all[k++] = addSels[i];

        for (uint256 i = 0; i < all.length; i++) {
            for (uint256 j = i + 1; j < all.length; j++) {
                assertTrue(all[i] != all[j], unicode"селектор назван больше одного раза в Replace/Add");
            }
        }
    }

    /// Состав buildCuts(): два действия, ожидаемые длины и адреса. Группы
    /// Remove здесь нет вовсе — подписи прежних функций не менялись.
    function test_BuildCutsShapeAndAddresses() public view {
        address facet = address(0xBEEF);
        IDiamondCut.FacetCut[] memory cuts = upgrade.buildCuts(facet);

        assertEq(cuts.length, 2, unicode"buildCuts: ожидались ровно две записи FacetCut");

        assertTrue(cuts[0].action == IDiamondCut.FacetCutAction.Replace, unicode"cuts[0] должен быть Replace");
        assertEq(cuts[0].facetAddress, facet, unicode"Replace: адрес обязан быть новым фасетом");
        assertEq(cuts[0].functionSelectors.length, 56, unicode"Replace: ожидались 56 прежних селекторов");

        assertTrue(cuts[1].action == IDiamondCut.FacetCutAction.Add, unicode"cuts[1] должен быть Add");
        assertEq(cuts[1].facetAddress, facet, unicode"Add: адрес обязан быть новым фасетом");
        assertEq(cuts[1].functionSelectors.length, 8, unicode"Add: ожидались 8 новых селекторов");
    }

    // ════════════════════════════════════════════════════════════════════
    // Пред/пост-полёт — доказано на локально развёрнутом даймонде, а не
    // только на списках-источниках. Replace на адрес, у которого нужного
    // селектора нет, НЕ ревертит (DiamondCutLib.replaceFunctions проверяет
    // только «адрес другой и есть код»), поэтому сами проверки скрипта обязаны
    // быть доказаны замером, а не поверены на слово.
    // ════════════════════════════════════════════════════════════════════

    /// Минимальный даймонд: Cut+Loupe+Ownership. Приём — test/Diamond.t.sol::setUp().
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

    /// Селекторы «старого» (пред-разрезного) фасета — из скомпилированного ABI
    /// МИНУС восемь новых, а НЕ из upgrade.replaceSelectors().
    ///
    /// Разница принципиальная, и найдена замером. Пока стенд монтировал ровно
    /// то, что скрипт собирается заменить, недомонтаж был для него невидим:
    /// выбрось селектор из replaceSelectors() — он же исчезнет и из стенда,
    /// старый фасет всё равно опустеет, и обе пост-проверки на живом даймонде
    /// довольно кивнут. Замерено: 2 красных из 661 при таком стенде, обе — из
    /// сверки списков. С независимым источником стенда пост-проверки начинают
    /// ловить недомонтаж по ФАКТУ маршрутизации, а не по спискам.
    function _oldFacetSelectors() internal view returns (bytes4[] memory out) {
        bytes4[] memory all = _abiSelectors("ArbiterRegistryFacet");
        bytes4[] memory addSels = upgrade.addSelectors();

        out = new bytes4[](all.length - addSels.length);
        uint256 k;
        for (uint256 i = 0; i < all.length; i++) {
            bool isNew = false;
            for (uint256 j = 0; j < addSels.length; j++) {
                if (all[i] == addSels[j]) { isNew = true; break; }
            }
            if (!isNew) out[k++] = all[i];
        }
        require(k == out.length, unicode"стенд: список Add не подмножество ABI фасета");
    }

    /// Монтирует «старую» (пред-разрезную) раскладку: 56 селекторов на ОДНОМ
    /// адресе фасета — именно то состояние, что стоит на Base Sepolia сегодня
    /// (169 селекторов всего, из них 56 арбитражных). Восемь новых НЕ
    /// монтируются: их и приносит этот разрез.
    function _mountOldFacet(DiamondProxy diamond) internal returns (address oldFacetAddr) {
        ArbiterRegistryFacet oldFacet = new ArbiterRegistryFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut(address(oldFacet), IDiamondCut.FacetCutAction.Add, _oldFacetSelectors());
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        oldFacetAddr = address(oldFacet);
    }

    bytes32 constant ARB_POS = 0xaae71de0594cbcb5434f0ab7f7501c1be178552bf788b418a1c2624ba9718d00;

    /// Прямая запись в vaultBalance (простое uint256-поле ArbiterRegistryStorage.Data,
    /// слот POSITION+9). Сеттера без USDC-перевода нет, а fundVault() здесь
    /// недоступен — этот даймонд не монтирует Factory, и FactoryStorage.usdc
    /// нулевой. Смещение подтверждается перечитыванием через геттер сразу после
    /// записи, а не на слово.
    function _setVaultBalance(DiamondProxy diamond, uint256 amount) internal {
        vm.store(address(diamond), bytes32(uint256(ARB_POS) + 9), bytes32(amount));
        assertEq(
            ArbiterRegistryFacet(address(diamond)).getVaultBalance(), amount,
            unicode"смещение vaultBalance в ArbiterRegistryStorage.Data уехало"
        );
    }

    /// Прямая запись в openClaimCount[arbiter] (мапа, база слота POSITION+13).
    /// Дать арбитру «открытый спор» настоящим claimDispute здесь нельзя — тому
    /// нужен Agreement, отвечающий на status()/disputedAt()/client()/executor(),
    /// и запись в реестре, которых у минимального даймонда нет.
    function _setOpenClaimCount(DiamondProxy diamond, address arbiter, uint256 n) internal {
        vm.store(address(diamond), keccak256(abi.encode(arbiter, uint256(ARB_POS) + 13)), bytes32(n));
        assertEq(
            ArbiterRegistryFacet(address(diamond)).getOpenClaimCount(arbiter), n,
            unicode"смещение openClaimCount в ArbiterRegistryStorage.Data уехало"
        );
    }

    /// Прямая запись в disputeClaims[agreement] (мапа, база слота POSITION+2).
    /// Смещение подтверждается через getDisputeClaimer() — существующий
    /// селектор, он смонтирован и ДО разреза.
    function _setDisputeClaimer(DiamondProxy diamond, address agreement, address arbiter) internal {
        vm.store(
            address(diamond),
            keccak256(abi.encode(agreement, uint256(ARB_POS) + 2)),
            bytes32(uint256(uint160(arbiter)))
        );
        assertEq(
            ArbiterRegistryFacet(address(diamond)).getDisputeClaimer(agreement), arbiter,
            unicode"смещение disputeClaims в ArbiterRegistryStorage.Data уехало"
        );
    }

    /// Прямая запись в disputeClaimedAtBy[agreement][arbiter] (вложенная мапа,
    /// база слота POSITION+22) и в presentationDigests[agreement] (динамический
    /// массив в мапе, база слота POSITION+24).
    ///
    /// НЕ через recordNoResponse/recordPresentationDigest: оба селектора этим
    /// самым разрезом и монтируются, то есть ДО него на даймонде их нет. Смысл
    /// сырой записи другой — доказать, что раскладка ТРЁХ НОВЫХ полей
    /// (append-only, дописаны Задачами 1-3) переживает замену адреса фасета,
    /// то есть замену кода, а не замену слотов. Прочитать обратно можно только
    /// ПОСЛЕ разреза, через getDisputeClaimedAt/getPresentationDigests.
    function _seedNewFieldsRaw(
        DiamondProxy diamond,
        address agreement,
        address arbiter,
        uint256 claimedAt,
        bytes32 digest
    ) internal {
        bytes32 claimedSlot = keccak256(
            abi.encode(arbiter, keccak256(abi.encode(agreement, uint256(ARB_POS) + 22)))
        );
        vm.store(address(diamond), claimedSlot, bytes32(claimedAt));

        bytes32 lenSlot = keccak256(abi.encode(agreement, uint256(ARB_POS) + 24));
        vm.store(address(diamond), lenSlot, bytes32(uint256(1)));
        vm.store(address(diamond), keccak256(abi.encode(lenSlot)), digest);
    }

    address constant SEED_AGREEMENT = address(0xA9DEEA1);
    uint256 constant SEED_CLAIMED_AT = 1_723_600_000;
    bytes32 constant SEED_DIGEST = bytes32(uint256(0xD16E57));

    /// Сажает НЕПУСТОЕ состояние ДО разреза: зарегистрированный арбитр,
    /// ненулевой банк, взятый спор с якорем времени и один отпечаток. Без этого
    /// сверка целостности хранилища сравнивала бы нули с нулями и прошла бы,
    /// даже будучи полностью сломанной.
    ///
    /// Звать ДО передачи владения диамондом: addArbiter — onlyOwnerOrChief.
    function _seedPreCutState(DiamondProxy diamond, address arbiter) internal {
        ArbiterRegistryFacet(address(diamond)).addArbiter(arbiter);
        _setVaultBalance(diamond, 777_000_000); // 777 USDC — заведомо не ноль и не «круглый» дефолт
        _setDisputeClaimer(diamond, SEED_AGREEMENT, arbiter);
        _setOpenClaimCount(diamond, arbiter, 1);
        _seedNewFieldsRaw(diamond, SEED_AGREEMENT, arbiter, SEED_CLAIMED_AT, SEED_DIGEST);
    }

    /// Честное состояние: пред-проверки проходят и возвращают правильный старый
    /// адрес. Без этого теста красные из следующих двух ничего бы не
    /// доказывали — мало показать, что замок ревертит на плохом входе, надо
    /// показать, что он НЕ ревертит на хорошем.
    function test_PreflightPassesOnHonestState() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        address oldFacetAddr = _mountOldFacet(diamond);

        address found = upgrade.checkReplaceGroup(upgrade.replaceSelectors(), address(diamond));
        assertEq(found, oldFacetAddr, unicode"checkReplaceGroup не нашёл смонтированный старый адрес фасета");

        upgrade.checkAddGroupUnmounted(upgrade.addSelectors(), address(diamond));
        // Ничего не ревертнуло — цель теста.
    }

    /// Что исчезнет из поведения, если снять правку: скрипт запустится на
    /// даймонде, у которого один из «остающихся» селекторов уже переехал на
    /// другой адрес (фасет ЧАСТИЧНО апгрейжен кем-то другим между запусками) —
    /// Replace на единый новый адрес увёл бы часть маршрутов не туда, а run()
    /// узнал бы об этом только по внешнему наблюдению после выкатки.
    function test_PreflightRevertsWhenReplaceSelectorLivesElsewhere() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond);

        ArbiterRegistryFacet strayFacet = new ArbiterRegistryFacet();
        bytes4[] memory strayMount = new bytes4[](1);
        strayMount[0] = ArbiterRegistryFacet.getRefundableBounty.selector;
        IDiamondCut.FacetCut[] memory strayCut = new IDiamondCut.FacetCut[](1);
        strayCut[0] = IDiamondCut.FacetCut(address(strayFacet), IDiamondCut.FacetCutAction.Replace, strayMount);
        IDiamondCut(address(diamond)).diamondCut(strayCut, address(0), "");

        // Список — в локальную переменную ДО expectRevert: expectRevert ловит
        // ровно следующий внешний вызов, а replaceSelectors() как inline-аргумент
        // сам был бы этим «следующим вызовом», не checkReplaceGroup.
        bytes4[] memory sels = upgrade.replaceSelectors();
        vm.expectRevert(bytes(unicode"UpgradePresentationRecord: селекторы Replace разъехались больше чем по одному живому адресу фасета"));
        upgrade.checkReplaceGroup(sels, address(diamond));
    }

    /// Что исчезнет из поведения, если снять правку: скрипт запустится на
    /// даймонде, где Add-селектор уже кем-то смонтирован (повторный запуск того
    /// же скрипта, чужой параллельный cut) — диамонд ревертнёт весь diamondCut
    /// на "Diamond: selector exists" уже ПОСЛЕ броадкаста нового фасета (деплой
    /// состоится, cut — нет), вместо понятного отказа до единого расхода газа.
    function test_PreflightRevertsWhenAddSelectorAlreadyMounted() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond);

        ArbiterRegistryFacet stray = new ArbiterRegistryFacet();
        bytes4[] memory strayAdd = new bytes4[](1);
        strayAdd[0] = ArbiterRegistryFacet.recordNoResponse.selector;
        IDiamondCut.FacetCut[] memory strayCut = new IDiamondCut.FacetCut[](1);
        strayCut[0] = IDiamondCut.FacetCut(address(stray), IDiamondCut.FacetCutAction.Add, strayAdd);
        IDiamondCut(address(diamond)).diamondCut(strayCut, address(0), "");

        bytes4[] memory sels = upgrade.addSelectors();
        vm.expectRevert(bytes(unicode"UpgradePresentationRecord: селектор из Add уже где-то смонтирован — Add ревертнёт"));
        upgrade.checkAddGroupUnmounted(sels, address(diamond));
    }

    /// Пост-проверка «старый адрес опустел» ловит недомонтированный Replace:
    /// если бы buildCuts() забыл один из 56 селекторов (тот же класс, что и
    /// test_ReplaceAndAddCoverWholeFacet, но здесь — по факту маршрутизации на
    /// живом даймонде, а не по спискам), старый фасет остался бы держать хотя
    /// бы один селектор.
    function test_PostflightRevertsWhenOldFacetStillHoldsASelector() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        address oldFacetAddr = _mountOldFacet(diamond);

        bytes4[] memory full = upgrade.replaceSelectors();
        bytes4[] memory incomplete = new bytes4[](full.length - 1);
        for (uint256 i = 0; i < incomplete.length; i++) incomplete[i] = full[i];

        ArbiterRegistryFacet newFacet = new ArbiterRegistryFacet();
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut(address(newFacet), IDiamondCut.FacetCutAction.Replace, incomplete);
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        vm.expectRevert(bytes(unicode"UpgradePresentationRecord: у старого адреса фасета после разреза остались селекторы"));
        upgrade.assertFacetHoldsNoSelectors(oldFacetAddr, address(diamond));
    }

    /// Что исчезнет из поведения, если снять правку: пост-проверку можно
    /// позвать с адресом, на который на самом деле ничего не приземлилось
    /// (run() перепутал переменные старого и нового фасета), и она бы молча
    /// согласилась. В соседнем файле этот же класс был найден мутацией: снятие
    /// require в assertRouted давало 0 красных, пока проверку звали только на
    /// ЧЕСТНОМ состоянии.
    function test_PostflightRevertsWhenSelectorNotRoutedToExpectedFacet() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        address oldFacetAddr = _mountOldFacet(diamond);

        ArbiterRegistryFacet newFacet = new ArbiterRegistryFacet();
        IDiamondCut(address(diamond)).diamondCut(upgrade.buildCuts(address(newFacet)), address(0), "");

        bytes4[] memory sels = upgrade.replaceSelectors();
        vm.expectRevert(bytes(unicode"UpgradePresentationRecord: селектор не приземлился на новый фасет"));
        upgrade.assertRouted(sels, oldFacetAddr, address(diamond));
    }

    // ════════════════════════════════════════════════════════════════════
    // Пол записи о молчании — сверяется ЗНАЧЕНИЕ, а не «вызов не упал»
    // ════════════════════════════════════════════════════════════════════

    /// Честное состояние: пол через даймонд равен суткам, проверка молчит.
    function test_FloorCheckPassesOnHonestDiamond() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond);
        ArbiterRegistryFacet newFacet = new ArbiterRegistryFacet();
        IDiamondCut(address(diamond)).diamondCut(upgrade.buildCuts(address(newFacet)), address(0), "");

        upgrade.assertNoResponseFloorAnswers(address(diamond)); // не ревертнуло — цель теста
    }

    /// Что исчезнет из поведения, если снять правку: пост-проверка перестанет
    /// отличать «пол отвечает» от «пол отвечает ПРАВИЛЬНО». Замер настоящий:
    /// селектор getNoResponseFloor смонтирован на двойник, который отдаёт 12
    /// часов вместо суток — маршрут жив, loupe доволен, значение враньё. Это
    /// ровно тот случай, ради которого проверка сверяет число, а не факт
    /// возврата: фронт (Задача 5) берёт пол из цепи и нарисовал бы человеку
    /// «ждать 12 часов», после чего цепь отказала бы ему ещё двенадцать.
    function test_FloorCheckRevertsWhenDiamondAnswersWrongNumber() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond);

        WrongFloorStub stub = new WrongFloorStub();
        bytes4[] memory stubSel = new bytes4[](1);
        stubSel[0] = ArbiterRegistryFacet.getNoResponseFloor.selector;
        IDiamondCut.FacetCut[] memory stubCut = new IDiamondCut.FacetCut[](1);
        stubCut[0] = IDiamondCut.FacetCut(address(stub), IDiamondCut.FacetCutAction.Add, stubSel);
        IDiamondCut(address(diamond)).diamondCut(stubCut, address(0), "");

        vm.expectRevert(bytes(unicode"post-flight: пол записи о молчании не отвечает через диамонд"));
        upgrade.assertNoResponseFloorAnswers(address(diamond));
    }

    // ════════════════════════════════════════════════════════════════════
    // Целостность арбитражного хранилища поперёк разреза
    // ════════════════════════════════════════════════════════════════════

    /// Честное состояние: одинаковый снимок до/после не ревертит.
    function test_StorageContinuity_PassesOnUnchangedSnapshot() public view {
        UpgradePresentationRecord.StorageSnapshot memory s =
            UpgradePresentationRecord.StorageSnapshot({arbiterCount: 3, vaultBalance: 100, arbiterFloor: 5});
        upgrade.assertStorageContinuity(s, s); // ничего не ревертнуло — цель теста
    }

    /// Что исчезнет из поведения, если снять правку: скрипт молча проедет мимо
    /// сдвига раскладки арбитражного неймспейса — ровно тот класс, что в июле
    /// 2026 уронил getOpenJobs() на живом хранилище JobBoard Panic(0x22) уже
    /// ПОСЛЕ выкатки, а не до.
    function test_StorageContinuity_RevertsWhenArbiterCountChanged() public {
        UpgradePresentationRecord.StorageSnapshot memory b =
            UpgradePresentationRecord.StorageSnapshot({arbiterCount: 3, vaultBalance: 100, arbiterFloor: 5});
        UpgradePresentationRecord.StorageSnapshot memory a =
            UpgradePresentationRecord.StorageSnapshot({arbiterCount: 4, vaultBalance: 100, arbiterFloor: 5});
        vm.expectRevert(bytes(unicode"post-flight: getArbiters().length изменился поперёк разреза — раскладка могла сдвинуться"));
        upgrade.assertStorageContinuity(b, a);
    }

    function test_StorageContinuity_RevertsWhenVaultBalanceChanged() public {
        UpgradePresentationRecord.StorageSnapshot memory b =
            UpgradePresentationRecord.StorageSnapshot({arbiterCount: 3, vaultBalance: 100, arbiterFloor: 5});
        UpgradePresentationRecord.StorageSnapshot memory a =
            UpgradePresentationRecord.StorageSnapshot({arbiterCount: 3, vaultBalance: 101, arbiterFloor: 5});
        vm.expectRevert(bytes(unicode"post-flight: getVaultBalance() изменился поперёк разреза — раскладка могла сдвинуться"));
        upgrade.assertStorageContinuity(b, a);
    }

    function test_StorageContinuity_RevertsWhenArbiterFloorChanged() public {
        UpgradePresentationRecord.StorageSnapshot memory b =
            UpgradePresentationRecord.StorageSnapshot({arbiterCount: 3, vaultBalance: 100, arbiterFloor: 5});
        UpgradePresentationRecord.StorageSnapshot memory a =
            UpgradePresentationRecord.StorageSnapshot({arbiterCount: 3, vaultBalance: 100, arbiterFloor: 6});
        vm.expectRevert(bytes(unicode"post-flight: getArbiterFloor() изменился поперёк разреза — раскладка могла сдвинуться"));
        upgrade.assertStorageContinuity(b, a);
    }

    // ════════════════════════════════════════════════════════════════════
    // Предупреждение о спорах, взятых ДО разреза
    // ════════════════════════════════════════════════════════════════════

    /// Арбитр с открытым спором обязан попасть в список: его спор взят ДО
    /// разреза, якоря времени у него нет, и recordNoResponse ответит ему
    /// ClaimTimeUnknown. Лекарство — releaseDisputeClaim и взять спор заново.
    function test_FindArbitersWithPreCutClaims_FlagsArbiterWithOpenClaim() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond);
        ArbiterRegistryFacet f = ArbiterRegistryFacet(address(diamond));

        address arb = address(0xAB1);
        f.addArbiter(arb);
        _setOpenClaimCount(diamond, arb, 1);

        address[] memory flagged = upgrade.findArbitersWithPreCutClaims(address(diamond));
        assertEq(flagged.length, 1, unicode"арбитр с открытым спором обязан попасть в предупреждение");
        assertEq(flagged[0], arb);
    }

    /// Что исчезнет из поведения, если снять правку: пред-полёт перестанет
    /// предупреждать об арбитрах, чьи взятые до разреза споры после выкатки
    /// молча откажут в записи о молчании — арбитр решит, что «кнопка сломана»,
    /// вместо того чтобы перевзять спор.
    function test_FindArbitersWithPreCutClaims_SkipsArbiterWithoutOpenClaim() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond);
        ArbiterRegistryFacet f = ArbiterRegistryFacet(address(diamond));

        f.addArbiter(address(0xAB2)); // зарегистрирован, но openClaimCount == 0

        address[] memory flagged = upgrade.findArbitersWithPreCutClaims(address(diamond));
        assertEq(flagged.length, 0, unicode"без открытого спора предупреждать не о чем");
    }

    /// Фильтрует по каждому арбитру отдельно, а не по факту «хоть кто-то есть».
    function test_FindArbitersWithPreCutClaims_MixOfFlaggedAndNot() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond);
        ArbiterRegistryFacet f = ArbiterRegistryFacet(address(diamond));

        address quiet = address(0xAB3);
        address busy  = address(0xAB4);
        f.addArbiter(quiet);
        f.addArbiter(busy);
        _setOpenClaimCount(diamond, busy, 2);

        address[] memory flagged = upgrade.findArbitersWithPreCutClaims(address(diamond));
        assertEq(flagged.length, 1);
        assertEq(flagged[0], busy);
    }

    /// Предупреждение зовётся ДО broadcast — то есть ДО того, как
    /// getDisputeClaimedAt смонтирован (это один из восьми Add-селекторов
    /// ЭТОГО же разреза). Замок на регрессию: если бы функция читала якорь
    /// напрямую, она ревертела бы "Diamond: Function does not exist" на КАЖДОМ
    /// пред-полёте на живой цепи — предупреждение уронило бы весь скрипт вместо
    /// того, чтобы просто напечататься.
    function test_FindArbitersWithPreCutClaims_WorksBeforeAddSelectorsAreMounted() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond); // ТОЛЬКО старая раскладка — getDisputeClaimedAt НЕ смонтирован
        ArbiterRegistryFacet f = ArbiterRegistryFacet(address(diamond));

        address arb = address(0xAB5);
        f.addArbiter(arb);
        _setOpenClaimCount(diamond, arb, 1);

        // Сначала доказываем предпосылку: якорь правда не смонтирован до разреза.
        vm.expectRevert();
        f.getDisputeClaimedAt(address(0xDEAD));

        // А предупреждение при этом отрабатывает без единого revert.
        address[] memory flagged = upgrade.findArbitersWithPreCutClaims(address(diamond));
        assertEq(flagged.length, 1);
        assertEq(flagged[0], arb);
    }

    // ════════════════════════════════════════════════════════════════════
    // Полный цикл
    // ════════════════════════════════════════════════════════════════════

    /// Развернуть → смонтировать «старую» раскладку → пред-проверки → сам cut
    /// через buildCuts() (та же функция, что зовёт run()) → пост-проверки →
    /// функциональный смоук ВСЕХ ВОСЬМИ новых входов ЧЕРЕЗ ДАЙМОНД. Смоук
    /// именно через даймонд, а не прямым вызовом фасета: Replace/Add на адрес,
    /// который селектора не реализует, НЕ ревертит на cut'е — «числится
    /// смонтированным» и «маршрут исполняет код» это разные вещи (класс бага
    /// d172064: задеплоено, ни разу не сработало, заметили через месяц).
    function test_FullUpgradeCycleOnLocalDiamond() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        address oldFacetAddr = _mountOldFacet(diamond);

        address foundOld = upgrade.checkReplaceGroup(upgrade.replaceSelectors(), address(diamond));
        assertEq(foundOld, oldFacetAddr);
        upgrade.checkAddGroupUnmounted(upgrade.addSelectors(), address(diamond));

        uint256 before = upgrade.totalRoutedSelectors(address(diamond));

        ArbiterRegistryFacet newFacet = new ArbiterRegistryFacet();
        IDiamondCut(address(diamond)).diamondCut(upgrade.buildCuts(address(newFacet)), address(0), "");

        upgrade.assertRouted(upgrade.replaceSelectors(), address(newFacet), address(diamond));
        upgrade.assertRouted(upgrade.addSelectors(), address(newFacet), address(diamond));
        upgrade.assertFacetHoldsNoSelectors(oldFacetAddr, address(diamond));

        uint256 afterTotal = upgrade.totalRoutedSelectors(address(diamond));
        assertEq(
            afterTotal, before + upgrade.addSelectors().length,
            unicode"счёт смонтированных селекторов сдвинулся не ровно на +Add"
        );

        // ── Смоук всех восьми ЧЕРЕЗ ДАЙМОНД ──────────────────────────────
        ArbiterRegistryFacet d = ArbiterRegistryFacet(address(diamond));
        address probe = address(0xDEAD);

        assertEq(d.getNoResponseFloor(), 24 hours, unicode"пол записи о молчании через даймонд не сутки");
        assertEq(d.getDisputeClaimedAt(probe), 0, unicode"якорь взятия по чистой сделке обязан быть нулём");
        assertEq(d.getNoResponseAt(probe), 0, unicode"запись о молчании по чистой сделке обязана быть нулём");
        assertEq(d.getPresentationDigestCount(probe), 0, unicode"счётчик отпечатков по чистой сделке обязан быть нулём");
        assertEq(d.getPresentationDigests(probe).length, 0, unicode"лента отпечатков по чистой сделке обязана быть пустой");
        assertEq(d.getPresentationDigestsPage(probe, 0, 10).length, 0, unicode"окно отпечатков по чистой сделке обязано быть пустым");

        // Две пишущие функции — тоже через даймонд. Отказ ожидаем и он же
        // доказательство, что маршрут исполняет НАШ код: пустой fallback
        // даймонда ревертнул бы "Diamond: Function does not exist", а не
        // прикладной ошибкой фасета.
        vm.expectRevert(abi.encodeWithSignature("NotClaimingArbiter()"));
        d.recordNoResponse(probe);

        vm.expectRevert(abi.encodeWithSignature("ZeroDigest()"));
        d.recordPresentationDigest(probe, bytes32(0));
    }

    /// Буквально run() — не пересказ его шагов, а сам метод, с настоящими
    /// vm.envAddress/vm.envUint/vm.startBroadcast, на локально развёрнутом
    /// даймонде. Владелец — адрес, выведенный из PRIVATE_KEY (двухшаговая
    /// передача владения), точно как того требует diamondCut на живой цепи.
    ///
    /// Даймонд ДО разреза сажается НЕ пустым: арбитр, ненулевой банк, взятый
    /// спор с якорем времени и один отпечаток — записанные сырой записью в
    /// слоты, потому что монтируются эти входы только этим самым разрезом.
    /// Без сида проверка целостности хранилища ВНУТРИ run() сверяла бы нули с
    /// нулями и прошла бы даже будучи полностью сломанной.
    function test_RunEndToEndOnLocalDiamond() public {
        uint256 pk = 0xA11CE;
        address ownerAddr = vm.addr(pk);
        address seededArbiter = address(0xA12BE12);

        DiamondProxy diamond = _deployMinimalDiamond();
        address oldFacetAddr = _mountOldFacet(diamond);
        _seedPreCutState(diamond, seededArbiter);

        UpgradePresentationRecord.StorageSnapshot memory before =
            upgrade.snapshotArbiterStorage(address(diamond));
        assertEq(before.arbiterCount, 1, unicode"сид не добавил арбитра — сверка ниже была бы нулями с нулями");
        assertEq(before.vaultBalance, 777_000_000, unicode"сид не поднял vaultBalance");

        OwnershipFacet(address(diamond)).transferOwnership(ownerAddr);
        vm.prank(ownerAddr);
        OwnershipFacet(address(diamond)).acceptOwnership();
        assertEq(OwnershipFacet(address(diamond)).owner(), ownerAddr, unicode"владение не переехало");

        vm.setEnv("DIAMOND_ADDRESS", vm.toString(address(diamond)));
        vm.setEnv("PRIVATE_KEY", vm.toString(pk));

        uint256 routedBefore = upgrade.totalRoutedSelectors(address(diamond));

        upgrade.run(); // ← сам метод, а не его пересказ

        upgrade.assertFacetHoldsNoSelectors(oldFacetAddr, address(diamond));
        assertEq(
            upgrade.totalRoutedSelectors(address(diamond)),
            routedBefore + upgrade.addSelectors().length,
            unicode"после run() счёт селекторов сдвинулся не ровно на +Add"
        );

        UpgradePresentationRecord.StorageSnapshot memory afterCut =
            upgrade.snapshotArbiterStorage(address(diamond));
        assertEq(afterCut.arbiterCount, before.arbiterCount, unicode"arbiterCount не пережил разрез");
        assertEq(afterCut.vaultBalance, before.vaultBalance, unicode"vaultBalance не пережил разрез");

        // Сырые байты трёх НОВЫХ полей, записанные ДО того, как их геттеры
        // вообще существовали на этом даймонде, читаются обратно ЧЕРЕЗ НИХ
        // теперь, когда они смонтированы: раскладка append-only пережила
        // замену адреса фасета.
        ArbiterRegistryFacet d = ArbiterRegistryFacet(address(diamond));
        assertEq(
            d.getDisputeClaimedAt(SEED_AGREEMENT), SEED_CLAIMED_AT,
            unicode"якорь взятия, записанный ДО разреза, не пережил замену фасета"
        );
        assertEq(
            d.getPresentationDigestCount(SEED_AGREEMENT), 1,
            unicode"счётчик отпечатков, записанный ДО разреза, не пережил замену фасета"
        );
        assertEq(
            d.getPresentationDigests(SEED_AGREEMENT)[0], SEED_DIGEST,
            unicode"отпечаток, записанный ДО разреза, не пережил замену фасета"
        );
    }

    /// Единственный тест, доказывающий замером, что проверка пола стоит ВНУТРИ
    /// run(), а не только в вынесенном помощнике. Даймонду подменяется ответ
    /// getNoResponseFloor() — маршрут и разрез при этом полностью честные, —
    /// и run() обязан упасть на пост-полёте. Снять вызов
    /// assertNoResponseFloorAnswers из run(), оставив саму функцию, — этот тест
    /// покраснеет, остальные нет.
    function test_RunRevertsWhenFloorAnswersWrong() public {
        uint256 pk = 0xA11CE;
        address ownerAddr = vm.addr(pk);

        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond);

        OwnershipFacet(address(diamond)).transferOwnership(ownerAddr);
        vm.prank(ownerAddr);
        OwnershipFacet(address(diamond)).acceptOwnership();

        vm.setEnv("DIAMOND_ADDRESS", vm.toString(address(diamond)));
        vm.setEnv("PRIVATE_KEY", vm.toString(pk));

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(ArbiterRegistryFacet.getNoResponseFloor.selector),
            abi.encode(uint256(12 hours))
        );

        vm.expectRevert(bytes(unicode"post-flight: пол записи о молчании не отвечает через диамонд"));
        upgrade.run();
    }

    /// Второй такой же замер, но для сверки целостности хранилища: доказывает,
    /// что assertStorageContinuity правда ВЫЗЫВАЕТСЯ из run(), а не просто
    /// существует рядом. Без этого теста снятие строки
    /// `assertStorageContinuity(before, afterCut);` из run() давало 0 красных
    /// из 661 — три теста ниже проверяли УСЛОВИЕ, и ни один не проверял, что
    /// его кто-то спрашивает. Ровно тот класс, ради которого замки и заводятся:
    /// код есть, никто им не пользуется.
    ///
    /// Как сделано расхождение: getVaultBalance() подменяется на СТАРОМ адресе
    /// фасета. Пред-полётный снимок читается через него (диамонд делегирует
    /// туда до разреза) и видит 999; пост-полётный идёт уже в новый фасет и
    /// видит настоящее значение. Это буквальная имитация того, ради чего
    /// сверка существует: одно и то же поле до и после разреза читается разным
    /// кодом и разошлось.
    function test_RunRevertsWhenStorageDriftsAcrossTheCut() public {
        uint256 pk = 0xA11CE;
        address ownerAddr = vm.addr(pk);

        DiamondProxy diamond = _deployMinimalDiamond();
        address oldFacetAddr = _mountOldFacet(diamond);

        OwnershipFacet(address(diamond)).transferOwnership(ownerAddr);
        vm.prank(ownerAddr);
        OwnershipFacet(address(diamond)).acceptOwnership();

        vm.setEnv("DIAMOND_ADDRESS", vm.toString(address(diamond)));
        vm.setEnv("PRIVATE_KEY", vm.toString(pk));

        vm.mockCall(
            oldFacetAddr,
            abi.encodeWithSelector(ArbiterRegistryFacet.getVaultBalance.selector),
            abi.encode(uint256(999))
        );

        vm.expectRevert(bytes(unicode"post-flight: getVaultBalance() изменился поперёк разреза — раскладка могла сдвинуться"));
        upgrade.run();
    }

    // ════════════════════════════════════════════════════════════════════
    // Круг правок 1: КАЖДЫЙ замок run() ломается через сам run()
    //
    // Ревью нашло общий изъян всех тестов ниже по файлу: они мерили УСЛОВИЕ
    // помощника (позвать его отдельно на лживом состоянии и увидеть revert), но
    // не мерили, что его ЗОВЁТ run(). Замер ревьюера: снять из run() вызов
    // checkReplaceGroup / checkAddGroupUnmounted / assertRouted (оба) /
    // assertFacetHoldsNoSelectors / счёт селекторов — по 0 красных из 662 на
    // каждый. Причина была в сквозном тесте: он САМ заново звал пост-проверки
    // после run(), то есть проверял мир после разреза, а не то, что скрипт
    // сторожит.
    //
    // Форма ниже одна на все: сломать мир так, чтобы упасть был обязан САМ
    // run(), и потребовать от него именно того сообщения. Образец — два теста
    // выше (пол и целостность хранилища), они этим изъяном не болели.
    // ════════════════════════════════════════════════════════════════════

    /// Общая подготовка негативных тестов на run(): даймонд со «старой»
    /// раскладкой, владение у адреса из PRIVATE_KEY, окружение выставлено.
    function _armRun(DiamondProxy diamond) internal returns (uint256 pk) {
        pk = 0xA11CE;
        address ownerAddr = vm.addr(pk);
        OwnershipFacet(address(diamond)).transferOwnership(ownerAddr);
        vm.prank(ownerAddr);
        OwnershipFacet(address(diamond)).acceptOwnership();
        vm.setEnv("DIAMOND_ADDRESS", vm.toString(address(diamond)));
        vm.setEnv("PRIVATE_KEY", vm.toString(pk));
    }

    /// Снять `checkReplaceGroup(...)` из run() — этот тест покраснеет.
    ///
    /// Мир сломан по-настоящему: один из 56 «остающихся» селекторов переведён
    /// на посторонний фасет, как если бы чужой апгрейд проехал между запусками.
    /// Replace на единый новый адрес в таком состоянии увёл бы часть маршрутов
    /// не туда, и без пред-полёта скрипт узнал бы об этом уже после броадкаста.
    function test_RunRevertsWhenReplaceGroupIsSplitAcrossFacets() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond);

        ArbiterRegistryFacet strayFacet = new ArbiterRegistryFacet();
        bytes4[] memory stray = new bytes4[](1);
        stray[0] = ArbiterRegistryFacet.getRefundableBounty.selector;
        IDiamondCut.FacetCut[] memory strayCut = new IDiamondCut.FacetCut[](1);
        strayCut[0] = IDiamondCut.FacetCut(address(strayFacet), IDiamondCut.FacetCutAction.Replace, stray);
        IDiamondCut(address(diamond)).diamondCut(strayCut, address(0), "");

        _armRun(diamond);

        vm.expectRevert(bytes(unicode"UpgradePresentationRecord: селекторы Replace разъехались больше чем по одному живому адресу фасета"));
        upgrade.run();
    }

    /// Снять `checkAddGroupUnmounted(...)` из run() — этот тест покраснеет.
    ///
    /// Мир сломан по-настоящему: один из восьми новых уже смонтирован
    /// (повторный запуск скрипта, чужой параллельный cut). Без пред-полёта
    /// диамонд ревертнул бы весь diamondCut на "Diamond: selector exists" уже
    /// ПОСЛЕ броадкаста нового фасета — деплой состоялся, разрез нет, газ
    /// потрачен.
    function test_RunRevertsWhenAnAddSelectorIsAlreadyMounted() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond);

        ArbiterRegistryFacet stray = new ArbiterRegistryFacet();
        bytes4[] memory strayAdd = new bytes4[](1);
        strayAdd[0] = ArbiterRegistryFacet.recordNoResponse.selector;
        IDiamondCut.FacetCut[] memory strayCut = new IDiamondCut.FacetCut[](1);
        strayCut[0] = IDiamondCut.FacetCut(address(stray), IDiamondCut.FacetCutAction.Add, strayAdd);
        IDiamondCut(address(diamond)).diamondCut(strayCut, address(0), "");

        _armRun(diamond);

        vm.expectRevert(bytes(unicode"UpgradePresentationRecord: селектор из Add уже где-то смонтирован — Add ревертнёт"));
        upgrade.run();
    }

    /// Снять ПЕРВЫЙ `assertRouted(replaceSels, ...)` из run() — этот тест
    /// покраснеет.
    ///
    /// Заставить настоящий diamondCut увести один Replace-селектор мимо нового
    /// фасета нельзя: маршруты собирает сам buildCuts(). Поэтому лжёт
    /// СПРАВОЧНИК — ответ loupe по одному селектору подменён на СТАРЫЙ адрес
    /// фасета. Подмена выбрана именно такой, чтобы пред-полёт остался доволен
    /// (до разреза там и должен быть старый адрес) и упало ровно то, что
    /// проверяется. Это и есть натура бага, ради которого проверка написана:
    /// «числится смонтированным» и «стоит там, где мы думаем» — разные вещи.
    function test_RunRevertsWhenAReplaceSelectorDidNotLandOnTheNewFacet() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        address oldFacetAddr = _mountOldFacet(diamond);
        _armRun(diamond);

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                IDiamondLoupe.facetAddress.selector,
                ArbiterRegistryFacet.setArbiterChatKey.selector
            ),
            abi.encode(oldFacetAddr)
        );

        vm.expectRevert(bytes(unicode"UpgradePresentationRecord: селектор не приземлился на новый фасет"));
        upgrade.run();
    }

    /// Снять ВТОРОЙ `assertRouted(addSels, ...)` из run() — этот тест
    /// покраснеет. Тот же приём, но подменённый ответ — ноль: пред-полёт
    /// требует от Add-селекторов ровно нуля и остаётся доволен, а пост-полёт
    /// обязан увидеть новый фасет и не видит. Отдельный тест, потому что это
    /// отдельная строка в run(): снять можно любую из двух.
    function test_RunRevertsWhenAnAddSelectorDidNotLandOnTheNewFacet() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond);
        _armRun(diamond);

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                IDiamondLoupe.facetAddress.selector,
                ArbiterRegistryFacet.getPresentationDigestsPage.selector
            ),
            abi.encode(address(0))
        );

        vm.expectRevert(bytes(unicode"UpgradePresentationRecord: селектор не приземлился на новый фасет"));
        upgrade.run();
    }

    /// Снять `assertFacetHoldsNoSelectors(oldFacet, ...)` из run() — этот тест
    /// покраснеет.
    ///
    /// Мир сломан по-настоящему и без единой подмены: на адресе старого фасета
    /// висит ЛИШНИЙ селектор, которого нет ни в Replace, ни в Add — след
    /// какого-то прежнего разреза. Replace вытеснит 56 знакомых, а этот
    /// останется, и старый адрес продолжит обслуживать живой маршрут поверх
    /// «уже заменённого» кода. Пред-полёт этого не видит и не должен: он
    /// смотрит только на группы разреза.
    function test_RunRevertsWhenOldFacetKeepsALeftoverSelector() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        address oldFacetAddr = _mountOldFacet(diamond);

        // addFunctions требует от адреса только наличия кода, не реализации
        // селектора, — поэтому «след прежнего разреза» вешается прямо сюда.
        bytes4[] memory leftover = new bytes4[](1);
        leftover[0] = bytes4(keccak256("leftoverFromAnOlderCut()"));
        IDiamondCut.FacetCut[] memory leftoverCut = new IDiamondCut.FacetCut[](1);
        leftoverCut[0] = IDiamondCut.FacetCut(oldFacetAddr, IDiamondCut.FacetCutAction.Add, leftover);
        IDiamondCut(address(diamond)).diamondCut(leftoverCut, address(0), "");

        _armRun(diamond);

        vm.expectRevert(bytes(unicode"UpgradePresentationRecord: у старого адреса фасета после разреза остались селекторы"));
        upgrade.run();
    }

    /// Снять итоговый `require(selectorsAfter == selectorsBefore + addSels.length)`
    /// из run() — этот тест покраснеет.
    ///
    /// Ломается перепись: facets() отвечает одним и тем же обоим чтениям, до и
    /// после разреза. Счёт обязан был сдвинуться ровно на +8, а не сдвинулся
    /// вовсе — то есть разрез сделал не то, что заявлял. Ни одна другая
    /// проверка run() этого не ловит: маршруты по отдельности честны, старый
    /// адрес пуст, хранилище на месте, пол отвечает. Именно поэтому итоговый
    /// счёт стоит отдельной строкой.
    function test_RunRevertsWhenRoutedSelectorCountDoesNotMoveByAdd() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond);
        _armRun(diamond);

        IDiamondLoupe.Facet[] memory frozen = new IDiamondLoupe.Facet[](0);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(IDiamondLoupe.facets.selector),
            abi.encode(frozen)
        );

        vm.expectRevert(bytes(unicode"post-flight: счёт смонтированных селекторов сдвинулся не ровно на +Add"));
        upgrade.run();
    }

    /// Снять `warnArbitersWithPreCutClaims(diamond)` из run() — этот тест
    /// покраснеет.
    ///
    /// Это предупреждение, а не замок: оно печатает и НЕ ревертит, поэтому
    /// «сломать мир так, чтобы run() упал» к нему неприменимо в принципе.
    /// Молчаливым исключением оставлять нельзя (это хуже отсутствующей
    /// проверки), поэтому меряется иначе — по СЛЕДУ, который оно обязано
    /// оставить: getOpenClaimCount() зовётся во всём run() ровно из этого
    /// обхода и больше ниоткуда (снимок хранилища читает getArbiters,
    /// getVaultBalance и getArbiterFloor). vm.expectCall требует этого вызова
    /// по имени конкретного арбитра — уберут обход, вызова не будет, тест
    /// красный.
    ///
    /// Ценность самого предупреждения: спор, взятый ДО разреза, останется без
    /// якоря времени, и recordNoResponse откажет ему ClaimTimeUnknown. Без
    /// печати арбитр решит, что кнопка сломана, вместо того чтобы перевзять
    /// спор. На 14 августа таких споров на цепи нет (getOpenClaimCount = 0),
    /// поэтому здесь арбитр с открытым спором сажается руками — иначе обход
    /// прошёл бы по пустому списку и след был бы неотличим от его отсутствия.
    function test_RunCallsThePreCutClaimsWarning() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond);

        address arb = address(0xAB7);
        ArbiterRegistryFacet(address(diamond)).addArbiter(arb);
        _setOpenClaimCount(diamond, arb, 1);

        _armRun(diamond);

        vm.expectCall(
            address(diamond),
            abi.encodeWithSelector(ArbiterRegistryFacet.getOpenClaimCount.selector, arb)
        );
        upgrade.run();
    }
}
