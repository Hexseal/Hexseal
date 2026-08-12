// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeSvgRenderer.s.sol
//
// Разворачивает заново SVGRenderer и переключает на него JobReceiptFacet
// живого диамонда 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
//
// SVGRenderer — НЕ фасет (отдельный контракт, JobReceiptFacet.tokenURI()
// зовёт его через ISVGRenderer.renderReceipt(...), см. JobReceiptFacet.sol:99).
// diamondCut его не касается вообще: это плоский деплой + один вызов
// setSvgRenderer(address), onlyOwner. Намеренно ОТДЕЛЁН от
// script/UpgradeFeeModel.s.sol — владелец подтвердил, что газ выкатки не
// ограничение, и что раздельные транзакции здесь безопаснее: до вызова
// setSvgRenderer новый рендерер ни на что живое не влияет (JobReceiptFacet
// продолжает staticcall'ить старый адрес), поэтому эта транзакция никогда
// не оставляет диамонд в промежуточном состоянии — она либо ещё не
// случилась, либо уже случилась целиком.
//
// ── ПОЧЕМУ ЭТО НЕЛЬЗЯ ОТКЛАДЫВАТЬ ПОСЛЕ UpgradeFeeModel.s.sol ────────────
// Живой SVGRenderer (0x548a99A89a218DC681e0bF75A7362eE1c3052bAa,
// broadcast/DeployFull.s.sol/84532/run-latest.json) всё ещё несёт старую
// таблицу региональных комиссий (_regionFeeRaw: 2e6/4e6/7e6/1e7/4e6/1e7/7e6
// USDC по региону, была в src/SVGRenderer.sol до коммита, см.
// `git diff 827bea2 HEAD -- src/SVGRenderer.sol`) и печатает в чек-NFT
// строки `PPP FEE $X (NON-REFUNDABLE)` и `TOTAL = amount + fee`.
//
// После UpgradeFeeModel.s.sol комиссия больше не входит в эскроу-сумму и не
// имеет отношения к региону — эти две строки на СТАРОМ рендерере станут
// прямым враньём (списания на сумму региональной таблицы не было и не
// будет). Текущие исходники SVGRenderer.sol убрали обе строки и печатают
// `ESCROW = amount` — ровно то, что реально удерживается в Agreement.
// Порядок относительно UpgradeFeeModel.s.sol не жёсткий (контракты разные,
// вызовы разные), но логика окна одна: пока не выкатить и то, и другое, чек
// либо ещё честен по-старому (плоская комиссия), либо уже врёт по-новому.
//
// Тем же деплоем бесплатно решается расхождение домена (docs/OPEN-ITEMS.md
// п.19): текущий SVGRenderer печатает hexseal.net вместо потерянного
// hexseal.com (см. DealMetadataFacet — этот скрипт его не трогает, домен
// там правится Replace-частью script/UpgradeFeeModel.s.sol).
//
// Usage (сухой прогон — сначала всегда он):
//   forge script script/UpgradeSvgRenderer.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL
//
// Usage (боевой запуск):
//   forge script script/UpgradeSvgRenderer.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";

import "../../src/DiamondProxy.sol";
import "../../src/SVGRenderer.sol";
import "../../src/JobReceiptFacet.sol";

contract UpgradeSvgRenderer is Script {
    function run() external {
        address diamond     = vm.envAddress("DIAMOND_ADDRESS");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address broadcaster = vm.addr(deployerKey);

        // ── Pre-flight ────────────────────────────────────────────────────
        require(diamond != address(0), "UpgradeSvgRenderer: DIAMOND_ADDRESS is zero");
        require(diamond.code.length > 0, "UpgradeSvgRenderer: DIAMOND_ADDRESS has no code");

        address currentOwner = OwnershipFacet(diamond).owner();
        require(
            currentOwner == broadcaster,
            "UpgradeSvgRenderer: PRIVATE_KEY is not the diamond owner - setSvgRenderer would revert after a paid deploy"
        );

        address oldRenderer = JobReceiptFacet(diamond).getSvgRenderer();
        require(oldRenderer != address(0), "UpgradeSvgRenderer: no renderer set on this diamond - use DeployFull, not this upgrade");
        require(oldRenderer.code.length > 0, "UpgradeSvgRenderer: the renderer currently set has no code");

        console.log("=== UpgradeSvgRenderer: pre-flight ===");
        console.log("Diamond:      ", diamond);
        console.log("Owner:        ", currentOwner);
        console.log("Old renderer: ", oldRenderer);
        console.log("");

        // Пример квитанции — те же значения, что печатает JobReceiptFacet.tokenURI
        // (см. JobReceiptFacet.sol:92-105), region=3 (US) специально: в старой
        // таблице _regionFeeRaw это самая дорогая комиссия (10 USDC), поэтому
        // расхождение со старым рендерером самое заметное глазами.
        ISVGRenderer.ReceiptParams memory sample = ISVGRenderer.ReceiptParams({
            tokenId:      1,
            client:       broadcaster,
            title:        "Sample job for renderer diff",
            amount:       200_000_000, // 200 USDC
            deadlineDays: 7,
            region:       3,           // US
            createdAt:    block.timestamp
        });

        console.log("--- Old renderer output (expect PPP FEE + TOTAL lines) ---");
        console.log(ISVGRenderer(oldRenderer).renderReceipt(sample));
        console.log("");

        // ── Апгрейд ───────────────────────────────────────────────────────
        vm.startBroadcast(deployerKey);

        SVGRenderer newRenderer = new SVGRenderer();
        console.log("New SVGRenderer: ", address(newRenderer));

        JobReceiptFacet(diamond).setSvgRenderer(address(newRenderer));

        vm.stopBroadcast();

        // ── Post-flight ───────────────────────────────────────────────────
        address stored = JobReceiptFacet(diamond).getSvgRenderer();
        require(stored == address(newRenderer), "UpgradeSvgRenderer: setSvgRenderer did not take effect");
        require(stored != oldRenderer, "UpgradeSvgRenderer: renderer address did not change");

        console.log("");
        console.log("=== Post-flight ===");
        console.log("Renderer now wired into diamond:", stored);
        console.log("");

        console.log("--- New renderer output (expect ESCROW line, no PPP FEE / TOTAL) ---");
        console.log(ISVGRenderer(stored).renderReceipt(sample));
        console.log("");

        console.log("=== Rollback - one transaction ===");
        console.log("  cast send <diamond> \"setSvgRenderer(address)\" <old> \\");
        console.log("    --private-key $PRIVATE_KEY --rpc-url $BASE_SEPOLIA_RPC_URL");
        console.log("  <diamond> =", diamond);
        console.log("  <old>     =", oldRenderer);
        console.log("");
        console.log("Rolling back re-introduces the stale region-fee table on every receipt");
        console.log("rendered afterwards - only correct if UpgradeFeeModel.s.sol is rolled back too.");
    }
}
