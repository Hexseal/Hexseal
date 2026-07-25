// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {DiamondStorage, DiamondGuard} from "../src/DiamondProxy.sol";
import {FactoryStorage} from "../src/FactoryFacet.sol";
import {RegistryStorage} from "../src/RegistryFacet.sol";
import {ReceiptStorage} from "../src/JobReceiptFacet.sol";
import {JobBoardStorage} from "../src/facets/JobBoardFacet.sol";
import {ServiceBoardStorage} from "../src/facets/ServiceBoardFacet.sol";
import {ReputationStorage} from "../src/facets/ReputationFacet.sol";
import {ArbiterRegistryStorage} from "../src/facets/ArbiterRegistryFacet.sol";

/// Пиннит вывод базовых слотов Diamond-хранилища.
/// Любая правка строки-идентификатора или формулы валит этот тест.
/// Это прямая защита от класса багов, который сломал JobBoard в июле 2026:
/// молчаливое изменение раскладки хранилища между версиями фасета.
contract StorageLayoutTest is Test {

    /// Каноническая формула ERC-7201.
    function _erc7201(string memory id) internal pure returns (bytes32) {
        return keccak256(abi.encode(uint256(keccak256(bytes(id))) - 1)) & ~bytes32(uint256(0xff));
    }

    function _check(bytes32 actual, bytes32 expected, string memory id) internal pure {
        assertEq(actual, expected, "slot changed from pinned value");
        assertEq(actual, _erc7201(id), "slot does not match ERC-7201 formula");
        assertEq(uint256(actual) & 0xff, 0, "slot not 256-aligned");
    }

    function testDiamondStorageSlot() public pure {
        _check(
            DiamondStorage.DIAMOND_STORAGE_POSITION,
            0x178642b411f9f4783b21ef338f3e96db6c1272d763f0b7500ec93464dafb8600,
            "hexseal.diamond.storage"
        );
    }

    function testDiamondGuardSlot() public pure {
        _check(
            DiamondGuard.GUARD_POSITION,
            0xb7972581c5756b955ddfcaf36802d7a349c326f2d1a13edfdb5743b59d909700,
            "hexseal.diamond.reentrancy"
        );
    }

    function testFactoryStorageSlot() public pure {
        _check(
            FactoryStorage.FACTORY_STORAGE_POSITION,
            0x6e1a7c9e564b098cf0d979de1ae0cacf8bfb22a7e8f2c8f4c244a2031b744700,
            "hexseal.factory.storage"
        );
    }

    function testRegistryStorageSlot() public pure {
        _check(
            RegistryStorage.REGISTRY_STORAGE_POSITION,
            0xc2046377b613f781ce75bf5776eb70f650372f5239ada8a3238d951cdca15e00,
            "hexseal.registry.storage"
        );
    }

    function testReceiptStorageSlot() public pure {
        _check(
            ReceiptStorage.POSITION,
            0xcda203cf548fb5f65947761da4867a0c96d965f3755581c496cf785aac114900,
            "hexseal.offernft.storage"
        );
    }

    function testJobBoardStorageSlot() public pure {
        _check(
            JobBoardStorage.POSITION,
            0x2dfb8cbdd723e055b4c668e1f7986e659e6340635543242a2d9ff47b878af000,
            "hexseal.jobboard.storage"
        );
    }

    function testServiceBoardStorageSlot() public pure {
        _check(
            ServiceBoardStorage.POSITION,
            0x46cd88da19a0b25b4baeccf5bdf5b6735146dba41575547a28d877fa2b430000,
            "hexseal.serviceboard.storage"
        );
    }

    function testReputationStorageSlot() public pure {
        _check(
            ReputationStorage.POSITION,
            0xa32193c5e38bd2de27c8550f156d709eafdc63aaa4290e5e27473f2ffc097400,
            "hexseal.reputation.storage"
        );
    }

    function testArbiterRegistryStorageSlot() public pure {
        _check(
            ArbiterRegistryStorage.POSITION,
            0xaae71de0594cbcb5434f0ab7f7501c1be178552bf788b418a1c2624ba9718d00,
            "hexseal.arbiterregistry.storage"
        );
    }

    /// Все девять баз должны быть попарно различны.
    function testAllSlotsDistinct() public pure {
        bytes32[9] memory s = [
            DiamondStorage.DIAMOND_STORAGE_POSITION,
            DiamondGuard.GUARD_POSITION,
            FactoryStorage.FACTORY_STORAGE_POSITION,
            RegistryStorage.REGISTRY_STORAGE_POSITION,
            ReceiptStorage.POSITION,
            JobBoardStorage.POSITION,
            ServiceBoardStorage.POSITION,
            ReputationStorage.POSITION,
            ArbiterRegistryStorage.POSITION
        ];
        for (uint256 i = 0; i < 9; i++) {
            for (uint256 j = i + 1; j < 9; j++) {
                assertTrue(s[i] != s[j], "namespace slot collision");
            }
        }
    }
}
