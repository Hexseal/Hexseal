// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Потолок одновременно взятых споров.
//
// Он ограничивает ферму сборов: арбитр зарабатывает долю сбора с КАЖДОГО
// спора независимо от того, куда решил, поэтому «набрать много и решать
// наугад» — доход без работы. Потолок считает ЧИСЛО, а не сумму: сумму
// назначает создатель сделки, и любой потолок по ней наследует её
// недоверенность (2026-07-20-arbiter-verdict-appeal-design.md, Out of scope).
//
// ⚠️ Цена потолка названа в спеке: при корпусе из одного человека спор N+1
// ждёт или уходит в таймаут с дележом котла. Это определённый исход, а не
// поломка.

import "forge-std/Test.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";
import {ArbiterAccountabilityFacet} from "../src/facets/ArbiterAccountabilityFacet.sol";
import {ArbiterTwoFacetBench} from "./ArbiterTwoFacetBench.sol";

contract ArbiterClaimCapTest is Test, ArbiterTwoFacetBench {
    /// Оба хендла указывают на ОДИН адрес — прокси с обоими фасетами
    /// (см. test/ArbiterTwoFacetBench.sol). `facet` оставлен под прежним
    /// именем нарочно: все vm.store(address(facet), ...) ниже продолжают
    /// бить в то же самое хранилище.
    ArbiterRegistryFacet facet;
    ArbiterAccountabilityFacet accFacet;
    address arbiter;

    bytes32 constant ARB_BASE = 0xaae71de0594cbcb5434f0ab7f7501c1be178552bf788b418a1c2624ba9718d00;
    /// Смещение поля openClaimCount внутри Data. Добыто замером и сторожится
    /// тестом test_OpenClaimCountSlotMatchesLiveStorage ниже.
    ///
    /// Найдено перебором (не 21, как предполагал бриф): временный тест
    /// перебрал offset 0..59, писал 7 в keccak256(arbiter, ARB_BASE+offset) и
    /// проверял getOpenClaimCount(arbiter) == 7. Единственное совпадение —
    /// offset 13. Упаковка структуры (bool/адреса делят слоты с соседями)
    /// сдвигает индекс поля относительно его порядкового номера в объявлении.
    uint256 constant SLOT_OPEN_CLAIM_COUNT = 13;

    function setUp() public {
        (facet, accFacet) = _deployArbiterBench();
        arbiter = address(0xA1);
        vm.store(address(facet), keccak256(abi.encode(arbiter, uint256(ARB_BASE))), bytes32(uint256(1)));
    }

    /// Смещение слота не берётся на веру: если поле уедет, тест ниже начнёт
    /// писать не туда и молча позеленеет.
    function test_OpenClaimCountSlotMatchesLiveStorage() public {
        _setOpenClaims(arbiter, 7);
        assertEq(accFacet.getOpenClaimCount(arbiter), 7, unicode"смещение слота openClaimCount уехало");
    }

    function test_CapIsTen() public view {
        assertEq(facet.getMaxClaimsPerArbiter(), 10, unicode"потолок утверждён владельцем 15.08.2026");
    }

    function test_ClaimRevertsAtCap() public {
        _setOpenClaims(arbiter, 10);
        vm.prank(arbiter);
        vm.expectRevert(
            abi.encodeWithSelector(ArbiterRegistryFacet.TooManyOpenClaims.selector, 10, 10)
        );
        facet.claimDispute(address(0xDEAD), bytes32(0), bytes32(uint256(1)), bytes32(uint256(2)));
    }

    /// Под потолком отказ обязан быть ДРУГИМ — иначе тест выше зеленел бы на
    /// любой поломке claimDispute, а не на потолке.
    function test_BelowCapFailsForADifferentReason() public {
        _setOpenClaims(arbiter, 9);
        vm.prank(arbiter);
        vm.expectRevert(ArbiterRegistryFacet.CommitmentNotFound.selector);
        facet.claimDispute(address(0xDEAD), bytes32(0), bytes32(uint256(1)), bytes32(uint256(2)));
    }

    function _setOpenClaims(address who, uint256 n) internal {
        bytes32 base = bytes32(uint256(ARB_BASE) + SLOT_OPEN_CLAIM_COUNT);
        vm.store(address(facet), keccak256(abi.encode(who, uint256(base))), bytes32(n));
    }
}
