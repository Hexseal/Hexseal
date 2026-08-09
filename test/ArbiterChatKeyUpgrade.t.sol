// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";
import {UpgradeArbiterChatKey} from "../script/UpgradeArbiterChatKey.s.sol";
import {IDiamondCut} from "../src/DiamondProxy.sol";

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

    /// 1. Полнота: объединение replaceSelectors() и addSelectors() совпадает
    /// (как множество, без дубликатов) со всеми селекторами скомпилированного
    /// ArbiterRegistryFacet.
    ///
    /// Что исчезнет из поведения, если снять: забытый в Replace селектор
    /// молча останется висеть на прежнем адресе фасета — диамонд после
    /// апгрейда наполовину поедет старым кодом, и никто этого не заметит,
    /// пока не наткнётся на конкретный вызов.
    function test_ReplaceAndAddCoverWholeFacet() public view {
        bytes4[] memory replaceSels = upgrade.replaceSelectors();
        bytes4[] memory addSels = upgrade.addSelectors();
        bytes4[] memory expected = _abiSelectors("ArbiterRegistryFacet");

        bytes4[] memory actual = new bytes4[](replaceSels.length + addSels.length);
        for (uint256 i = 0; i < replaceSels.length; i++) actual[i] = replaceSels[i];
        for (uint256 i = 0; i < addSels.length; i++) actual[replaceSels.length + i] = addSels[i];

        assertEq(actual.length, expected.length, "Replace+Add: selector count mismatch against compiled ABI");

        for (uint256 i = 0; i < actual.length; i++) {
            bool found = false;
            for (uint256 j = 0; j < expected.length; j++) {
                if (actual[i] == expected[j]) { found = true; break; }
            }
            assertTrue(found, "Replace+Add: mounts a selector the facet does not implement (phantom)");
        }

        for (uint256 i = 0; i < expected.length; i++) {
            bool found = false;
            for (uint256 j = 0; j < actual.length; j++) {
                if (expected[i] == actual[j]) { found = true; break; }
            }
            assertTrue(found, "Replace+Add: facet has a selector the cut does not mount (undercut)");
        }
    }

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
}
