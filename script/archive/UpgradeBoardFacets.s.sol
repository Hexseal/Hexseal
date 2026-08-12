// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

// UpgradeBoardFacets.s.sol
//
// Заменяет mintJob / mintService / requestService на ERC-2771-совместимые версии.
// Подписи функций не меняются — только реализация (msg.sender → _msgSender()).
// WithPermit-варианты остаются в Diamond (backward compat), но frontend больше их не использует.

import "forge-std/Script.sol";
import "../../src/facets/JobBoardFacet.sol";
import "../../src/facets/ServiceBoardFacet.sol";
import "../../src/DiamondProxy.sol";

contract UpgradeBoardFacets is Script {
    address constant DIAMOND = 0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557;

    function run() external {
        vm.startBroadcast();

        // ── Deploy new facets ─────────────────────────────────────────────────
        JobBoardFacet     newJobBoard     = new JobBoardFacet();
        ServiceBoardFacet newServiceBoard = new ServiceBoardFacet();

        // ── Build cut: Replace 3 selectors ───────────────────────────────────
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](2);

        // [0] JobBoardFacet: Replace mintJob
        bytes4[] memory jobSelectors = new bytes4[](1);
        jobSelectors[0] = bytes4(0x7a6be706); // mintJob(string,string,uint256,uint256,string,uint8)

        cut[0] = IDiamondCut.FacetCut({
            facetAddress: address(newJobBoard),
            action:       IDiamondCut.FacetCutAction.Replace,
            functionSelectors: jobSelectors
        });

        // [1] ServiceBoardFacet: Replace mintService + requestService
        bytes4[] memory svcSelectors = new bytes4[](2);
        svcSelectors[0] = bytes4(0xe590d3ae); // mintService(string,string,uint256,uint256,uint8)
        svcSelectors[1] = bytes4(0x8d00688f); // requestService(uint256,uint256,uint256,string,uint8)

        cut[1] = IDiamondCut.FacetCut({
            facetAddress: address(newServiceBoard),
            action:       IDiamondCut.FacetCutAction.Replace,
            functionSelectors: svcSelectors
        });

        // ── Execute diamondCut ────────────────────────────────────────────────
        IDiamondCut(DIAMOND).diamondCut(cut, address(0), "");

        vm.stopBroadcast();

        console.log("JobBoardFacet:     ", address(newJobBoard));
        console.log("ServiceBoardFacet: ", address(newServiceBoard));
        console.log("Replaced 3 selectors: mintJob, mintService, requestService");
    }
}
