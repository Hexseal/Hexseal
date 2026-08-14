// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";
import {UpgradeArbiterChatKey} from "../script/archive/UpgradeArbiterChatKey.s.sol";
import "../src/DiamondProxy.sol";

contract ArbiterChatKeyUpgradeTest is Test {
    UpgradeArbiterChatKey internal upgrade;

    function setUp() public {
        upgrade = new UpgradeArbiterChatKey();
    }

    /// Старого входа заявки в фасете БОЛЬШЕ НЕТ. Замок против того, чтобы
    /// кто-нибудь однажды вернул перегрузку «для совместимости»: вторая дорога
    /// к заявке — это дорога к заявке без ключа.
    ///
    /// Что исчезнет из поведения, если снять правку: вернётся возможность взять
    /// спор, не опубликовав ключ, — арбитр заявится, читать предъявленное будет
    /// нечем, и дело уйдёт в таймаут с делением котла пополам.
    function test_OldClaimSelectorGone() public pure {
        bytes4 oldSel = bytes4(keccak256("claimDispute(address,bytes32)"));
        bytes4 newSel = bytes4(keccak256("claimDispute(address,bytes32,bytes32,bytes32)"));
        assertTrue(oldSel != newSel, unicode"селекторы совпали — подпись не менялась");
        assertEq(
            ArbiterRegistryFacet.claimDispute.selector,
            newSel,
            unicode"фасет отдаёт не тот селектор: осталась перегрузка или подпись иная"
        );
    }

    // ── Ground truth: read straight out of the compiled artifact — тот же
    //    приём, что test/DeployFullSelectors.t.sol::_abiSelectors ──────────
    function _abiSelectors(string memory contractName) internal view returns (bytes4[] memory out) {
        string memory json = vm.readFile(string.concat("out/", contractName, ".sol/", contractName, ".json"));
        string[] memory sigs = vm.parseJsonKeys(json, ".methodIdentifiers");
        out = new bytes4[](sigs.length);
        for (uint256 i; i < sigs.length; i++) out[i] = bytes4(keccak256(bytes(sigs[i])));
    }

    /// 1. ── СНЯТ 14 августа 2026, вместе с 4в-2 Выкаткой 2 ──────────────────
    ///
    /// Здесь стоял test_ReplaceAndAddCoverWholeFacet: он сверял объединение
    /// replaceSelectors()+addSelectors() ЭТОГО скрипта со свежим ABI
    /// ArbiterRegistryFacet. Разрез, который описывает этот файл, исполнен на
    /// Base Sepolia 10 августа и больше не повторится, а его списки селекторов
    /// навсегда описывают фасет ТОГО дня (56 методов). Любой последующий рост
    /// фасета — а Задачи 1-3 добавили восемь функций, 56 → 64 — красил тест в
    /// красный, не сообщая ничего ни о чём: сверять исполненный разрез с
    /// сегодняшним кодом бессмысленно.
    ///
    /// Живую роль (заметить недомонтированный или фантомный селектор ДО
    /// выкатки) перенял точно такой же тест против АКТУАЛЬНОГО разреза —
    /// test/PresentationRecordUpgrade.t.sol::test_ReplaceAndAddCoverWholeFacet.
    /// Замок не ослаб: он просто переехал на скрипт, который ещё предстоит
    /// запустить. Остальные 14 тестов этого файла живы и трогать их не за что —
    /// они проверяют пред/пост-полётные помощники и целостность хранилища, то
    /// есть логику, которая от роста фасета не зависит.

    /// 2. Старый вход удаляется и его нет в новом ABI.
    ///
    /// Что исчезнет из поведения, если снять: останется вторая дорога к
    /// заявке — без ключа.
    function test_OldSelectorRemovedAndAbsentFromNewAbi() public view {
        bytes4[] memory removeSels = upgrade.removeSelectors();
        assertEq(removeSels.length, 1, "removeSelectors: expected exactly one selector");
        assertEq(
            removeSels[0],
            bytes4(keccak256("claimDispute(address,bytes32)")),
            "removeSelectors: not the old two-argument claimDispute selector"
        );

        bytes4[] memory abiSels = _abiSelectors("ArbiterRegistryFacet");
        for (uint256 i = 0; i < abiSels.length; i++) {
            assertTrue(
                abiSels[i] != removeSels[0],
                "old claimDispute(address,bytes32) is still present in the compiled facet ABI"
            );
        }
    }

    /// 3. Ни один селектор не назван дважды между тремя списками.
    /// diamondCut отвергает добавление уже существующего, поэтому пересечение
    /// Replace и Add уронило бы всю выкатку целиком, на живом даймонде.
    ///
    /// Что исчезнет из поведения, если снять: тихая опечатка вместо понятного
    /// отказа при сборке (диамонд на цепи ревертнёт весь cut, но здесь это
    /// было бы обнаружено только на настоящей выкатке, а не заранее).
    function test_NoSelectorNamedTwiceAcrossLists() public view {
        bytes4[] memory removeSels = upgrade.removeSelectors();
        bytes4[] memory replaceSels = upgrade.replaceSelectors();
        bytes4[] memory addSels = upgrade.addSelectors();

        bytes4[] memory all = new bytes4[](removeSels.length + replaceSels.length + addSels.length);
        uint256 k = 0;
        for (uint256 i = 0; i < removeSels.length; i++) all[k++] = removeSels[i];
        for (uint256 i = 0; i < replaceSels.length; i++) all[k++] = replaceSels[i];
        for (uint256 i = 0; i < addSels.length; i++) all[k++] = addSels[i];

        for (uint256 i = 0; i < all.length; i++) {
            for (uint256 j = i + 1; j < all.length; j++) {
                assertTrue(all[i] != all[j], "a selector is named more than once across Remove/Replace/Add");
            }
        }
    }

    /// Состав buildCuts(): три действия, ожидаемые длины и адрес(а) —
    /// Remove обязан быть address(0) (правило EIP-2535), Replace/Add — новый
    /// фасет. Проверяет саму сборку run(), а не только списки-источники.
    function test_BuildCutsShapeAndAddresses() public view {
        address facet = address(0xBEEF);
        IDiamondCut.FacetCut[] memory cuts = upgrade.buildCuts(facet);

        assertEq(cuts.length, 3, "buildCuts: expected exactly 3 FacetCut entries");

        assertTrue(cuts[0].action == IDiamondCut.FacetCutAction.Remove, "cuts[0] should be Remove");
        assertEq(cuts[0].facetAddress, address(0), "Remove: facetAddress must be address(0) per EIP-2535");
        assertEq(cuts[0].functionSelectors.length, 1);

        assertTrue(cuts[1].action == IDiamondCut.FacetCutAction.Replace, "cuts[1] should be Replace");
        assertEq(cuts[1].facetAddress, facet, "Replace: facetAddress must be the new facet");
        assertEq(cuts[1].functionSelectors.length, 53);

        assertTrue(cuts[2].action == IDiamondCut.FacetCutAction.Add, "cuts[2] should be Add");
        assertEq(cuts[2].facetAddress, facet, "Add: facetAddress must be the new facet");
        assertEq(cuts[2].functionSelectors.length, 3);
    }

    // ════════════════════════════════════════════════════════════════════
    // Pre/post-flight — доказано на локально развёрнутом даймонде, не только
    // на списках-источниках. Ревьюер (доработка после первого прохода):
    // Replace на адрес без нужного селектора НЕ ревертит
    // (DiamondCutLib.replaceFunctions:184-198 проверяет только «адрес другой
    // и есть код», не «реализует ли он селектор») — тихий разъезд «смонтировано,
    // но не работает» ровно того класса, что уже ломал fundDispute на
    // msg.sender вместо _msgSender() (d172064). Поэтому pre/post-flight
    // проверки в самом скрипте обязаны быть доказаны замером, а не поверены
    // на слово.
    // ════════════════════════════════════════════════════════════════════

    /// Минимальный даймонд: Cut+Loupe+Ownership, без Registry/Factory — их
    /// не нужно, проверки маршрутизации селекторов их не касаются. Приём —
    /// test/Diamond.t.sol::setUp().
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

    /// Монтирует «старую» (пред-апгрейдную) раскладку: 53 селектора из
    /// replaceSelectors() + старый вход заявки из removeSelectors(), все на
    /// ОДНОМ новом адресе фасета — именно такое состояние застаёт скрипт на
    /// живой цепи до апгрейда. addFunctions (DiamondCutLib.sol) не проверяет,
    /// что адрес реально реализует каждый монтируемый селектор — только что
    /// у него есть код, поэтому старый вход можно смонтировать на любом
    /// развёрнутом ArbiterRegistryFacet, не воскрешая удалённую сигнатуру в
    /// исходниках.
    function _mountOldFacet(DiamondProxy diamond) internal returns (address oldFacetAddr) {
        ArbiterRegistryFacet oldFacet = new ArbiterRegistryFacet();
        bytes4[] memory replaceSels = upgrade.replaceSelectors();
        bytes4[] memory removeSels = upgrade.removeSelectors();

        bytes4[] memory mountSels = new bytes4[](replaceSels.length + removeSels.length);
        for (uint256 i = 0; i < replaceSels.length; i++) mountSels[i] = replaceSels[i];
        for (uint256 i = 0; i < removeSels.length; i++) mountSels[replaceSels.length + i] = removeSels[i];

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut(address(oldFacet), IDiamondCut.FacetCutAction.Add, mountSels);
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        oldFacetAddr = address(oldFacet);
    }

    bytes32 constant ARB_POS = 0xaae71de0594cbcb5434f0ab7f7501c1be178552bf788b418a1c2624ba9718d00;

    /// Прямая запись в vaultBalance (простое uint256-поле в
    /// ArbiterRegistryStorage.Data, слот POSITION+9). Сеттера без USDC-перевода
    /// нет, а fundVault() здесь недоступен — этот даймонд не монтирует
    /// Factory, и FactoryStorage.usdc == address(0). Смещение подтверждается
    /// тем же приёмом, что test/ArbiterChatKey.t.sol::_setTrustedForwarder —
    /// перечитыванием через геттер сразу после записи, а не на слово.
    function _setVaultBalance(DiamondProxy diamond, uint256 amount) internal {
        bytes32 slot = bytes32(uint256(ARB_POS) + 9);
        vm.store(address(diamond), slot, bytes32(amount));
        assertEq(
            ArbiterRegistryFacet(address(diamond)).getVaultBalance(), amount,
            unicode"смещение vaultBalance в ArbiterRegistryStorage.Data уехало"
        );
    }

    /// Прямая запись в openClaimCount[arbiter] (мапа, база слота POSITION+13).
    /// Дать арбитру «открытый спор» через настоящий claimDispute здесь
    /// нельзя — тому нужен Agreement, отвечающий на status()/disputedAt()/
    /// client()/executor(), и Registry-запись, которых у этого минимального
    /// даймонда нет. Смещение подтверждается перечитыванием через
    /// getOpenClaimCount(), тем же приёмом, что и выше.
    function _setOpenClaimCount(DiamondProxy diamond, address arbiter, uint256 n) internal {
        bytes32 slot = keccak256(abi.encode(arbiter, uint256(ARB_POS) + 13));
        vm.store(address(diamond), slot, bytes32(n));
        assertEq(
            ArbiterRegistryFacet(address(diamond)).getOpenClaimCount(arbiter), n,
            unicode"смещение openClaimCount в ArbiterRegistryStorage.Data уехало"
        );
    }

    bytes32 constant SEED_BOX_KEY  = bytes32(uint256(0x5eed0001));
    bytes32 constant SEED_SIGN_KEY = bytes32(uint256(0x5eed0002));

    /// Прямая запись в arbiterBoxKey/arbiterSignKey (мапы, базы слотов
    /// POSITION+20/+21). НЕ через setArbiterChatKey: тот селектор, как и
    /// getArbiterChatKeys, смонтирован только ПОСЛЕ этого самого cut'а —
    /// на живой цепи «арбитр с ключом ДО апгрейда» структурно невозможен
    /// (до этого апгрейда возможности задать ключ не существовало вовсе).
    /// Пишем сюда напрямую, чтобы доказать другое: раскладка этих двух
    /// НОВЫХ полей (append-only, добавлены тем же PR) переживает замену
    /// адреса фасета в cut'е — то есть замену кода, а не замену слотов.
    /// Прочитать обратно можно только ПОСЛЕ cut'а (см. вызывающий тест) —
    /// getArbiterChatKeys до него не смонтирован.
    function _setChatKeyRaw(DiamondProxy diamond, address arbiter, bytes32 box, bytes32 sign) internal {
        bytes32 boxSlot  = keccak256(abi.encode(arbiter, uint256(ARB_POS) + 20));
        bytes32 signSlot = keccak256(abi.encode(arbiter, uint256(ARB_POS) + 21));
        vm.store(address(diamond), boxSlot, box);
        vm.store(address(diamond), signSlot, sign);
    }

    /// Итоговое ревью, правка 3: сажает арбитра с ключом и непустой банк ДО
    /// cut'а, чтобы сверка pre/post не сравнивала нули с нулями — без этого
    /// проверка целостности хранилища была бы честной проверкой на пустом
    /// месте, а не проверкой на настоящих данных.
    ///
    /// Вызывать ДО передачи владения диамондом другому адресу: addArbiter —
    /// onlyOwnerOrChief, а сразу после _deployMinimalDiamond владелец —
    /// address(this) (тестовый контракт).
    function _seedPreCutArbiterState(DiamondProxy diamond, address arbiter) internal {
        ArbiterRegistryFacet f = ArbiterRegistryFacet(address(diamond));
        f.addArbiter(arbiter);
        _setVaultBalance(diamond, 777_000_000); // 777 USDC — заведомо не ноль и не «круглый» дефолт
        _setChatKeyRaw(diamond, arbiter, SEED_BOX_KEY, SEED_SIGN_KEY);
    }

    /// Честное состояние: пред-проверки проходят и возвращают правильный
    /// старый адрес. Без этого теста красные из следующих двух ничего бы не
    /// доказывали — мало показать, что замок ревертит на плохом входе, надо
    /// показать, что он НЕ ревертит на хорошем.
    function test_PreflightPassesOnHonestState() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        address oldFacetAddr = _mountOldFacet(diamond);

        address found = upgrade.checkReplaceGroup(upgrade.replaceSelectors(), address(diamond));
        assertEq(found, oldFacetAddr, "checkReplaceGroup: did not find the mounted old facet address");

        upgrade.checkRemoveSelectorMounted(upgrade.removeSelectors(), oldFacetAddr, address(diamond));
        upgrade.checkAddGroupUnmounted(upgrade.addSelectors(), address(diamond));
        // Ничего не ревертнуло — цель теста.
    }

    /// Что исчезнет из поведения, если снять правку: скрипт запустится
    /// диамондом, у которого один из «остающихся» селекторов на самом деле
    /// уже переехал на другой адрес (фасет ЧАСТИЧНО апгрейжен кем-то другим
    /// между запусками) — Replace на единый новый адрес в этом случае увёл
    /// бы часть маршрутов не туда, а run() узнал бы об этом только по
    /// внешнему наблюдению за живым даймондом после выкатки.
    function test_PreflightRevertsWhenReplaceSelectorLivesElsewhere() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond);

        // Отдельный, третий фасет — один из "остающихся" селекторов
        // (getRefundableBounty) переносим на него отдельным Replace ДО
        // пред-проверки, симулируя чужой промежуточный апгрейд.
        ArbiterRegistryFacet strayFacet = new ArbiterRegistryFacet();
        bytes4[] memory strayMount = new bytes4[](1);
        strayMount[0] = ArbiterRegistryFacet.getRefundableBounty.selector;
        IDiamondCut.FacetCut[] memory strayCut = new IDiamondCut.FacetCut[](1);
        strayCut[0] = IDiamondCut.FacetCut(address(strayFacet), IDiamondCut.FacetCutAction.Replace, strayMount);
        IDiamondCut(address(diamond)).diamondCut(strayCut, address(0), "");

        // Список — в локальную переменную ДО expectRevert: expectRevert ловит
        // ровно следующий внешний вызов, а replaceSelectors() как inline-аргумент
        // сам был бы этим "следующим вызовом" (staticcall), не checkReplaceGroup.
        bytes4[] memory sels = upgrade.replaceSelectors();
        vm.expectRevert(bytes("UpgradeArbiterChatKey: Replace selectors are split across more than one live facet address"));
        upgrade.checkReplaceGroup(sels, address(diamond));
    }

    /// Что исчезнет из поведения, если снять правку: скрипт запустится на
    /// диамонде, где Add-селектор уже кем-то смонтирован (например, повторный
    /// запуск того же скрипта, или чужой параллельный cut) — диамонд ревертнёт
    /// весь diamondCut на "Diamond: selector exists" уже ПОСЛЕ броадкаста
    /// нового фасета (деплой состоится, cut — нет), вместо понятного отказа
    /// до единого gas-расхода.
    function test_PreflightRevertsWhenAddSelectorAlreadyMounted() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond);

        ArbiterRegistryFacet stray = new ArbiterRegistryFacet();
        bytes4[] memory strayAdd = new bytes4[](1);
        strayAdd[0] = ArbiterRegistryFacet.setArbiterChatKey.selector;
        IDiamondCut.FacetCut[] memory strayCut = new IDiamondCut.FacetCut[](1);
        strayCut[0] = IDiamondCut.FacetCut(address(stray), IDiamondCut.FacetCutAction.Add, strayAdd);
        IDiamondCut(address(diamond)).diamondCut(strayCut, address(0), "");

        bytes4[] memory sels = upgrade.addSelectors();
        vm.expectRevert(bytes("UpgradeArbiterChatKey: an Add selector is already mounted somewhere - Add would revert"));
        upgrade.checkAddGroupUnmounted(sels, address(diamond));
    }

    /// Что исчезнет из поведения, если снять правку: Remove указал бы не на
    /// тот селектор, что реально стоит на старом фасете (например, кто-то
    /// испортил removeSelectors() на несмонтированную сигнатуру) — cut
    /// целиком ревертнул бы на живом даймонде только в момент broadcast, а не
    /// заранее.
    function test_PreflightRevertsWhenRemoveSelectorNotMounted() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond);

        bytes4[] memory bogus = new bytes4[](1);
        bogus[0] = bytes4(keccak256("thisSelectorDoesNotExistAnywhere()"));

        vm.expectRevert(bytes("UpgradeArbiterChatKey: Remove selector is not mounted anywhere"));
        upgrade.checkRemoveSelectorMounted(bogus, address(0xDEAD), address(diamond));
    }

    /// Что исчезнет из поведения, если снять правку: удаляемый селектор
    /// смонтирован (проходит первую require), но живёт на ДРУГОМ адресе, чем
    /// вся группа Replace — то есть Remove целится не в тот фасет, который
    /// апгрейдится этим cut'ом (например, кто-то уже частично мигрировал
    /// заявку на новый адрес отдельным cut'ом, оставив старую сигнатуру
    /// висеть где-то ещё). Без этой проверки скрипт узнал бы об этом только
    /// по факту — Remove снял бы селектор с чужого фасета, не с того,
    /// который сейчас заменяется. Найдено мутацией: снятие
    /// `require(a == expectedFacet, ...)` давало 0 красных из 11 без этого
    /// теста — сам чек существовал, но ничто в сьюте его не проверяло.
    function test_PreflightRevertsWhenRemoveSelectorLivesOnDifferentFacet() public {
        DiamondProxy diamond = _deployMinimalDiamond();

        // Replace-группа — на одном фасете (A).
        ArbiterRegistryFacet facetA = new ArbiterRegistryFacet();
        IDiamondCut.FacetCut[] memory mountReplace = new IDiamondCut.FacetCut[](1);
        mountReplace[0] = IDiamondCut.FacetCut(address(facetA), IDiamondCut.FacetCutAction.Add, upgrade.replaceSelectors());
        IDiamondCut(address(diamond)).diamondCut(mountReplace, address(0), "");

        // Удаляемый селектор — на ДРУГОМ фасете (B), не на facetA.
        ArbiterRegistryFacet facetB = new ArbiterRegistryFacet();
        IDiamondCut.FacetCut[] memory mountRemove = new IDiamondCut.FacetCut[](1);
        mountRemove[0] = IDiamondCut.FacetCut(address(facetB), IDiamondCut.FacetCutAction.Add, upgrade.removeSelectors());
        IDiamondCut(address(diamond)).diamondCut(mountRemove, address(0), "");

        bytes4[] memory removeSels = upgrade.removeSelectors();
        vm.expectRevert(bytes("UpgradeArbiterChatKey: Remove selector lives on a different facet address than the Replace group"));
        upgrade.checkRemoveSelectorMounted(removeSels, address(facetA), address(diamond));
    }

    /// Полный цикл на локальном даймонде: развернуть → смонтировать «старую»
    /// раскладку → пред-проверки (как в run(), до broadcast) → сам cut через
    /// buildCuts() (та же функция, что зовёт run()) → пост-проверки → смоук
    /// getArbiterChatKeys ЧЕРЕЗ ДАЙМОНД. Самый ценный тест этой задачи: он
    /// один доказывает, что весь путь скрипта — не только списки селекторов —
    /// приводит к реально работающему даймонду, а не к «числится смонтированным,
    /// но ревертит пустым returndata» (класс бага из d172064).
    function test_FullUpgradeCycleOnLocalDiamond() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        address oldFacetAddr = _mountOldFacet(diamond);

        // ── Pre-flight (как в run()) ────────────────────────────────────
        address foundOld = upgrade.checkReplaceGroup(upgrade.replaceSelectors(), address(diamond));
        assertEq(foundOld, oldFacetAddr);
        upgrade.checkRemoveSelectorMounted(upgrade.removeSelectors(), oldFacetAddr, address(diamond));
        upgrade.checkAddGroupUnmounted(upgrade.addSelectors(), address(diamond));

        uint256 before = upgrade.totalRoutedSelectors(address(diamond));

        // ── Сам cut — buildCuts(), та же функция, что зовёт run() ───────
        ArbiterRegistryFacet newFacet = new ArbiterRegistryFacet();
        IDiamondCut(address(diamond)).diamondCut(upgrade.buildCuts(address(newFacet)), address(0), "");

        // ── Post-flight (как в run()) ─────────────────────────────────
        upgrade.assertRouted(upgrade.replaceSelectors(), address(newFacet), address(diamond));
        upgrade.assertRouted(upgrade.addSelectors(), address(newFacet), address(diamond));
        upgrade.assertFacetHoldsNoSelectors(oldFacetAddr, address(diamond));
        upgrade.assertSelectorsUnrouted(upgrade.removeSelectors(), address(diamond));

        uint256 afterTotal = upgrade.totalRoutedSelectors(address(diamond));
        assertEq(
            afterTotal,
            before - upgrade.removeSelectors().length + upgrade.addSelectors().length,
            "total routed selectors did not move by exactly -Remove +Add"
        );

        // ── Функциональный смоук: реальный вызов ЧЕРЕЗ ДАЙМОНД ──────────
        (bytes32 boxKey, bytes32 signKey) = upgrade.smokeGetArbiterChatKeys(address(diamond), address(0xDEAD));
        assertEq(boxKey, bytes32(0), "smoke: getArbiterChatKeys through the diamond did not return zero boxKey");
        assertEq(signKey, bytes32(0), "smoke: getArbiterChatKeys through the diamond did not return zero signKey");

        // Тот же вызов напрямую через интерфейс фасета (не только через
        // helper скрипта) — подтверждает, что делегирование реально
        // исполняет код нового фасета, а не просто не ревертит на пустом
        // fallback.
        (bytes32 boxKey2, bytes32 signKey2) = ArbiterRegistryFacet(address(diamond)).getArbiterChatKeys(address(0xDEAD));
        assertEq(boxKey2, bytes32(0));
        assertEq(signKey2, bytes32(0));
    }

    /// Буквально run() — не воспроизведение его шагов вручную, а сам метод,
    /// с реальным vm.envAddress/vm.envUint/vm.startBroadcast, на локально
    /// развёрнутом даймонде. Владелец даймонда — адрес, выведенный из
    /// PRIVATE_KEY (двухшаговая передача владения OwnershipFacet), точно как
    /// того требует diamondCut на живой цепи. Это единственный тест, который
    /// доказывает замером, что смоук-проверка ВНУТРИ run() (после broadcast,
    /// `require(boxKey == 0 && signKey == 0, ...)`) реально стоит на месте —
    /// остальные тесты вызывают её через smokeGetArbiterChatKeys() отдельно,
    /// но не через сам run(), и не поймали бы, если бы кто-то удалил именно
    /// эту строку из run(), а не из вынесенного помощника.
    ///
    /// Итоговое ревью, правка 3: даймонд ДО cut'а сажается не пустым —
    /// зарегистрированный арбитр, непустой vaultBalance и (сырой записью,
    /// см. _setChatKeyRaw) заполненные arbiterBoxKey/arbiterSignKey. Без
    /// этого проверка целостности хранилища ВНУТРИ run() сверяла бы нули с
    /// нулями и прошла бы даже будучи полностью сломанной. После run()
    /// сверяем, что arbiterCount/vaultBalance пережили cut через
    /// snapshotArbiterStorage(), и что сырые байты ключа, записанные ДО
    /// того, как getArbiterChatKeys вообще существовал, читаются обратно
    /// ЧЕРЕЗ НЕЁ теперь, когда она смонтирована.
    function test_RunEndToEndOnLocalDiamond() public {
        uint256 pk = 0xA11CE;
        address ownerAddr = vm.addr(pk);
        address seededArbiter = address(0xA12BE12);

        DiamondProxy diamond = _deployMinimalDiamond(); // owner = address(this) поначалу
        address oldFacetAddr = _mountOldFacet(diamond);  // тоже как address(this)
        _seedPreCutArbiterState(diamond, seededArbiter); // непустое хранилище ДО cut'а

        UpgradeArbiterChatKey.StorageSnapshot memory before = upgrade.snapshotArbiterStorage(address(diamond));
        assertEq(before.arbiterCount, 1, unicode"сид не добавил арбитра — сверка ниже была бы нулями с нулями");
        assertEq(before.vaultBalance, 777_000_000, unicode"сид не поднял vaultBalance");

        // Передать владение диамондом адресу PRIVATE_KEY — run() зовёт
        // diamondCut, а он проходит только для владельца.
        OwnershipFacet(address(diamond)).transferOwnership(ownerAddr);
        vm.prank(ownerAddr);
        OwnershipFacet(address(diamond)).acceptOwnership();
        assertEq(OwnershipFacet(address(diamond)).owner(), ownerAddr, "ownership transfer did not take");

        vm.setEnv("DIAMOND_ADDRESS", vm.toString(address(diamond)));
        vm.setEnv("PRIVATE_KEY", vm.toString(pk));

        uint256 before_ = upgrade.totalRoutedSelectors(address(diamond));

        upgrade.run(); // ← сам метод, а не его пересказ (доказывает continuity-require ВНУТРИ run())

        // run() сам проверяет всё внутри себя (иначе он бы уже ревертнул);
        // здесь дублируем внешним взглядом, что диамонд действительно
        // переехал так, как обещано.
        upgrade.assertFacetHoldsNoSelectors(oldFacetAddr, address(diamond));
        upgrade.assertSelectorsUnrouted(upgrade.removeSelectors(), address(diamond));

        uint256 afterTotal = upgrade.totalRoutedSelectors(address(diamond));
        assertEq(afterTotal, before_ - upgrade.removeSelectors().length + upgrade.addSelectors().length);

        (bytes32 boxKey, bytes32 signKey) = ArbiterRegistryFacet(address(diamond)).getArbiterChatKeys(address(0xDEAD));
        assertEq(boxKey, bytes32(0));
        assertEq(signKey, bytes32(0));

        // Непустое состояние, посаженное ДО cut'а, пережило замену адреса
        // фасета — не сверка нулей с нулями.
        UpgradeArbiterChatKey.StorageSnapshot memory afterCut = upgrade.snapshotArbiterStorage(address(diamond));
        assertEq(afterCut.arbiterCount, before.arbiterCount, unicode"arbiterCount не пережил cut");
        assertEq(afterCut.vaultBalance, before.vaultBalance, unicode"vaultBalance не пережил cut");

        (bytes32 seededBox, bytes32 seededSign) = ArbiterRegistryFacet(address(diamond)).getArbiterChatKeys(seededArbiter);
        assertEq(seededBox, SEED_BOX_KEY, unicode"arbiterBoxKey, записанный ДО cut'а, не пережил замену фасета");
        assertEq(seededSign, SEED_SIGN_KEY, unicode"arbiterSignKey, записанный ДО cut'а, не пережил замену фасета");
    }

    /// Пост-проверка "старый адрес опустел" ловит недомонтированный Replace:
    /// если бы buildCuts() забыл один из 53 селекторов (тот же класс мутации,
    /// что и test_ReplaceAndAddCoverWholeFacet, но здесь — по факту
    /// маршрутизации на живом даймонде, а не по спискам), старый фасет
    /// остался бы держать хотя бы один селектор, и assertFacetHoldsNoSelectors
    /// обязан это заметить.
    function test_PostflightRevertsWhenOldFacetStillHoldsASelector() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        address oldFacetAddr = _mountOldFacet(diamond);

        // Cut, который переносит все селекторы, КРОМЕ одного — намеренно
        // неполный Replace, собранный вручную (не через buildCuts()), чтобы
        // проверить именно post-flight помощник в изоляции.
        bytes4[] memory full = upgrade.replaceSelectors();
        bytes4[] memory incomplete = new bytes4[](full.length - 1);
        for (uint256 i = 0; i < incomplete.length; i++) incomplete[i] = full[i];

        ArbiterRegistryFacet newFacet = new ArbiterRegistryFacet();
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut(address(newFacet), IDiamondCut.FacetCutAction.Replace, incomplete);
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        vm.expectRevert(bytes("UpgradeArbiterChatKey: old facet address still holds selectors after the cut"));
        upgrade.assertFacetHoldsNoSelectors(oldFacetAddr, address(diamond));
    }

    /// Что исчезнет из поведения, если снять правку: пост-проверку можно
    /// позвать с адресом, на который на самом деле ничего не приземлилось
    /// (например, run() перепутал местами переменные с адресом старого и
    /// нового фасета), и она бы молча согласилась. Найдено мутацией: снятие
    /// require в assertRouted давало 0 красных из 12 без этого теста —
    /// единственный путь, которым assertRouted до сих пор проверялся
    /// (test_FullUpgradeCycleOnLocalDiamond), звал её на ЧЕСТНОМ состоянии,
    /// где require и так истинен, — отсутствие проверки на ЛЖИВОМ состоянии
    /// не отличить было нечем.
    function test_PostflightRevertsWhenSelectorNotRoutedToExpectedFacet() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        address oldFacetAddr = _mountOldFacet(diamond);

        ArbiterRegistryFacet newFacet = new ArbiterRegistryFacet();
        IDiamondCut(address(diamond)).diamondCut(upgrade.buildCuts(address(newFacet)), address(0), "");

        // Реально приземлилось на newFacet, но проверяем против СТАРОГО
        // (уже пустого) адреса — обязано ревертить.
        bytes4[] memory sels = upgrade.replaceSelectors();
        vm.expectRevert(bytes("UpgradeArbiterChatKey: a selector did not land on the new facet"));
        upgrade.assertRouted(sels, oldFacetAddr, address(diamond));
    }

    /// Что исчезнет из поведения, если снять правку: пост-проверку можно
    /// позвать ДО того, как Remove реально снял селектор (например, если
    /// run() перепутал порядок или пропустил это действие в cut'е), и она бы
    /// молча согласилась, оставив вторую дорогу к заявке смонтированной.
    /// Найдено мутацией той же формы, что и предыдущий тест: до этого теста
    /// assertSelectorsUnrouted проверялся только на честном пост-cut
    /// состоянии.
    function test_PostflightRevertsWhenRemovedSelectorStillRoutesSomewhere() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond); // старый вход ЕЩЁ смонтирован, Remove не выполнялся

        bytes4[] memory removeSels = upgrade.removeSelectors();
        vm.expectRevert(bytes("UpgradeArbiterChatKey: a removed selector still routes somewhere"));
        upgrade.assertSelectorsUnrouted(removeSels, address(diamond));
    }

    // ════════════════════════════════════════════════════════════════════
    // Итоговое ревью, правка 3: целостность хранилища арбитражного
    // неймспейса поперёк cut'а — не только маршрутизация селекторов.
    // ════════════════════════════════════════════════════════════════════

    /// Честное состояние: одинаковый снимок до/после не ревертит.
    function test_StorageContinuity_PassesOnUnchangedSnapshot() public view {
        UpgradeArbiterChatKey.StorageSnapshot memory s =
            UpgradeArbiterChatKey.StorageSnapshot({arbiterCount: 3, vaultBalance: 100, arbiterFloor: 5});
        upgrade.assertStorageContinuity(s, s); // ничего не ревертнуло — цель теста
    }

    /// Что исчезнет из поведения, если снять правку: апгрейд-скрипт молча
    /// проедет мимо сдвига раскладки арбитражного неймспейса — ровно тот
    /// класс, что в июле 2026 уронил getOpenJobs() на живом хранилище
    /// JobBoard Panic(0x22) уже ПОСЛЕ выкатки, а не до.
    function test_StorageContinuity_RevertsWhenArbiterCountChanged() public {
        UpgradeArbiterChatKey.StorageSnapshot memory b =
            UpgradeArbiterChatKey.StorageSnapshot({arbiterCount: 3, vaultBalance: 100, arbiterFloor: 5});
        UpgradeArbiterChatKey.StorageSnapshot memory a =
            UpgradeArbiterChatKey.StorageSnapshot({arbiterCount: 4, vaultBalance: 100, arbiterFloor: 5});
        vm.expectRevert(bytes("post: getArbiters().length changed across the cut - storage layout may have shifted"));
        upgrade.assertStorageContinuity(b, a);
    }

    function test_StorageContinuity_RevertsWhenVaultBalanceChanged() public {
        UpgradeArbiterChatKey.StorageSnapshot memory b =
            UpgradeArbiterChatKey.StorageSnapshot({arbiterCount: 3, vaultBalance: 100, arbiterFloor: 5});
        UpgradeArbiterChatKey.StorageSnapshot memory a =
            UpgradeArbiterChatKey.StorageSnapshot({arbiterCount: 3, vaultBalance: 101, arbiterFloor: 5});
        vm.expectRevert(bytes("post: getVaultBalance() changed across the cut - storage layout may have shifted"));
        upgrade.assertStorageContinuity(b, a);
    }

    function test_StorageContinuity_RevertsWhenArbiterFloorChanged() public {
        UpgradeArbiterChatKey.StorageSnapshot memory b =
            UpgradeArbiterChatKey.StorageSnapshot({arbiterCount: 3, vaultBalance: 100, arbiterFloor: 5});
        UpgradeArbiterChatKey.StorageSnapshot memory a =
            UpgradeArbiterChatKey.StorageSnapshot({arbiterCount: 3, vaultBalance: 100, arbiterFloor: 6});
        vm.expectRevert(bytes("post: getArbiterFloor() changed across the cut - storage layout may have shifted"));
        upgrade.assertStorageContinuity(b, a);
    }

    // ════════════════════════════════════════════════════════════════════
    // Итоговое ревью, правка 4: предупреждение об арбитрах с открытыми
    // заявками без ключа — громкое, не require.
    // ════════════════════════════════════════════════════════════════════

    /// Арбитр с открытым спором (openClaimCount > 0) обязан попасть в список.
    function test_FindArbitersWithOpenClaimsMissingKeys_FlagsArbiterWithOpenClaim() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond);
        ArbiterRegistryFacet f = ArbiterRegistryFacet(address(diamond));

        address arb = address(0xAB1);
        f.addArbiter(arb);
        _setOpenClaimCount(diamond, arb, 1);

        address[] memory flagged = upgrade.findArbitersWithOpenClaimsMissingKeys(address(diamond));
        assertEq(flagged.length, 1, unicode"арбитр с открытым спором обязан попасть в предупреждение");
        assertEq(flagged[0], arb);
    }

    /// Что исчезнет из поведения, если снять правку: пред-полёт скрипта
    /// перестанет предупреждать об арбитрах, чьи старые заявки (взятые до
    /// апгрейда, без ключа по построению) после cut'а дадут getArbiterChatKeys
    /// == (0, 0) — сторона молча услышит «предъявлять некому» вместо
    /// «арбитру нужно позвать setArbiterChatKey».
    function test_FindArbitersWithOpenClaimsMissingKeys_SkipsArbiterWithoutOpenClaim() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond);
        ArbiterRegistryFacet f = ArbiterRegistryFacet(address(diamond));

        address arb = address(0xAB2);
        f.addArbiter(arb); // зарегистрирован, но openClaimCount == 0

        address[] memory flagged = upgrade.findArbitersWithOpenClaimsMissingKeys(address(diamond));
        assertEq(flagged.length, 0, unicode"без открытого спора предупреждать не о чем");
    }

    /// Арбитр без открытого спора не попадает, даже если он единственный
    /// зарегистрированный, а другой (с открытым спором) — попадает: список
    /// фильтрует по каждому арбитру отдельно, не по факту "хоть кто-то есть".
    function test_FindArbitersWithOpenClaimsMissingKeys_MixOfFlaggedAndNot() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond);
        ArbiterRegistryFacet f = ArbiterRegistryFacet(address(diamond));

        address quiet = address(0xAB3);
        address busy  = address(0xAB4);
        f.addArbiter(quiet);
        f.addArbiter(busy);
        _setOpenClaimCount(diamond, busy, 2);

        address[] memory flagged = upgrade.findArbitersWithOpenClaimsMissingKeys(address(diamond));
        assertEq(flagged.length, 1);
        assertEq(flagged[0], busy);
    }

    /// findArbitersWithOpenClaimsMissingKeys зовётся ДО broadcast в run() —
    /// то есть ДО того, как getArbiterChatKeys вообще смонтирован на
    /// даймонде (это один из трёх Add-селекторов того же cut'а). Замок на
    /// регрессию: если бы функция читала getArbiterChatKeys напрямую (как в
    /// первой версии этой правки), она ревертела бы "Diamond: Function does
    /// not exist" на КАЖДОМ вызове пред-полёта на живой цепи — предупреждение
    /// уронило бы весь скрипт вместо того, чтобы просто напечататься.
    function test_FindArbitersWithOpenClaimsMissingKeys_WorksBeforeAddSelectorsAreMounted() public {
        DiamondProxy diamond = _deployMinimalDiamond();
        _mountOldFacet(diamond); // ТОЛЬКО старая раскладка — getArbiterChatKeys НЕ смонтирован
        ArbiterRegistryFacet f = ArbiterRegistryFacet(address(diamond));

        address arb = address(0xAB5);
        f.addArbiter(arb);
        _setOpenClaimCount(diamond, arb, 1);

        // Сначала доказываем предпосылку: getArbiterChatKeys правда не
        // смонтирован на этом даймонде до cut'а.
        vm.expectRevert();
        f.getArbiterChatKeys(arb);

        // А предупреждение при этом отрабатывает без единого revert.
        address[] memory flagged = upgrade.findArbitersWithOpenClaimsMissingKeys(address(diamond));
        assertEq(flagged.length, 1);
        assertEq(flagged[0], arb);
    }
}
