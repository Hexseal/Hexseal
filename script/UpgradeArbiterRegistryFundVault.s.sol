// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeArbiterRegistryFundVault.s.sol
//
// Открывает fundVault текущему получателю комиссий на ЖИВОМ диамонде.
//
// Зачем. Казна задеплоена и подставлена получателем комиссий, но первая
// ступень её лестницы не работает: она зовёт fundVault на диамонде, а там
// до сих пор старый ArbiterRegistryFacet, где эта функция onlyOwner.
// Казна владельцем не является, получает NotOwner() (0x30cd7471), и
// distribute() честно завершается успехом, ничего не переместив — провал
// первой ступени терпится намеренно, чтобы её нельзя было замуровать.
// Наблюдалось вживую: tx 0x7ed5a40d..., 84 144 газа, деньги остались на казне.
//
// Что меняется в фасете: ровно одна проверка доступа. Было onlyOwner, стало
// «владелец ИЛИ текущий FactoryStorage.feeRecipient». Отдельного поля под
// адрес казны намеренно нет — замена казны через setFeeRecipient переносит
// право автоматически, забыть нечего.
//
// Наборы селекторов совпадают побайтово (44 с обеих сторон), поэтому это
// чистый Replace без Add/Remove.
//
// Usage (сухой прогон — сначала всегда он):
//   forge script script/UpgradeArbiterRegistryFundVault.s.sol \
//     --rpc-url https://sepolia.base.org
//
// Usage (боевой запуск):
//   forge script script/UpgradeArbiterRegistryFundVault.s.sol \
//     --rpc-url https://sepolia.base.org --private-key $PRIVATE_KEY --broadcast -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DiamondProxy.sol";
import "../src/facets/ArbiterRegistryFacet.sol";

interface IDiamondOwner {
    function owner() external view returns (address);
}

interface ILoupe {
    function facetAddress(bytes4 selector) external view returns (address);
    function facetFunctionSelectors(address facet) external view returns (bytes4[] memory);
}

contract UpgradeArbiterRegistryFundVault is Script {
    function run() external {
        address diamond     = vm.envAddress("DIAMOND_ADDRESS");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address broadcaster = vm.addr(deployerKey);

        require(diamond != address(0), "upgrade: DIAMOND_ADDRESS is zero");
        require(diamond.code.length > 0, "upgrade: DIAMOND_ADDRESS has no code");
        require(
            IDiamondOwner(diamond).owner() == broadcaster,
            "upgrade: PRIVATE_KEY is not the diamond owner - diamondCut would revert after a paid deploy"
        );

        bytes4 fundVaultSel = ArbiterRegistryFacet.fundVault.selector;
        address oldFacet    = ILoupe(diamond).facetAddress(fundVaultSel);
        require(oldFacet != address(0), "upgrade: fundVault is not mounted at all");

        // Берём набор селекторов у ЖИВОГО диамонда, а не собираем руками:
        // рукописный массив — это ещё один способ разойтись с реальностью,
        // и ровно так в этом репозитории уже отставал DeployFull на 40 апгрейдов.
        bytes4[] memory selectors = ILoupe(diamond).facetFunctionSelectors(oldFacet);
        require(selectors.length == 44, "upgrade: unexpected selector count on the live facet");

        console.log("--- Before ---");
        console.log("Diamond:        ", diamond);
        console.log("Old facet:      ", oldFacet);
        console.log("Selectors:      ", selectors.length);
        console.log("");

        vm.startBroadcast(deployerKey);

        ArbiterRegistryFacet newFacet = new ArbiterRegistryFacet();

        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = IDiamondCut.FacetCut({
            facetAddress:      address(newFacet),
            action:            IDiamondCut.FacetCutAction.Replace,
            functionSelectors: selectors
        });

        IDiamondCut(diamond).diamondCut(cut, address(0), "");

        vm.stopBroadcast();

        address routed = ILoupe(diamond).facetAddress(fundVaultSel);
        require(routed == address(newFacet), "upgrade: fundVault still routes to the old facet");

        console.log("--- After ---");
        console.log("New facet:      ", address(newFacet));
        console.log("fundVault routes to:", routed);
        console.log("");
        console.log("The treasury can now fund the arbiter vault. The next keeper pass");
        console.log("should move the pending fees instead of silently doing nothing.");
        console.log("");
        console.log("Rollback (routes every selector back to the previous facet):");
        console.log("  old facet =", oldFacet);
    }
}
