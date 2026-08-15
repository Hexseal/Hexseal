// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

// ============================================================
// UpgradeArbiterRegistryV3.s.sol
//
// Diamond-as-arbiter + FeeVault + вознаграждения арбитров + DAO overturn.
//
// Replace (18 существующих селекторов):
//   addArbiter, removeArbiter, setChiefArbiter, getChiefArbiter,
//   commitDisputeClaim, claimDispute, releaseDisputeClaim, clearDisputeClaim,
//   isRegisteredArbiter, getArbiters, getDisputeClaimer,
//   getArbiterDeals, getClaimCommitment,
//   activateDAO, applyAsArbiter, isDaoActive,
//   getMinXPToRegister, getDaoThreshold
//
// Add (13 новых селекторов):
//   submitVerdict, finalizeVerdict, overturnVerdict,
//   freezeVerdict, unfreezeVerdict,
//   withdrawArbiterReward, fundVault,
//   setRewardPerDispute, setDAOAddress,
//   getPendingVerdict, getArbiterReward,
//   getVaultBalance, getRewardPerDispute, getDAOAddress
//
// Usage:
//   forge script script/UpgradeArbiterRegistryV3.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../../src/facets/ArbiterRegistryFacet.sol";
import "../../src/DiamondProxy.sol";

contract UpgradeArbiterRegistryV3 is Script {
    address constant DIAMOND = 0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        ArbiterRegistryFacet newFacet = new ArbiterRegistryFacet();
        console.log("New ArbiterRegistryFacet:", address(newFacet));

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);

        // ── Replace: 18 существующих ──────────────────────────────────────────
        bytes4[] memory replaceSels = new bytes4[](18);
        replaceSels[0]  = ArbiterRegistryFacet.addArbiter.selector;
        replaceSels[1]  = bytes4(0x3487e08c) /* removeArbiter(address), удалена 15 августа 2026 (задача 6 arbiter-accountability) */;
        replaceSels[2]  = ArbiterRegistryFacet.setChiefArbiter.selector;
        replaceSels[3]  = ArbiterRegistryFacet.getChiefArbiter.selector;
        replaceSels[4]  = ArbiterRegistryFacet.commitDisputeClaim.selector;
        replaceSels[5]  = bytes4(keccak256("claimDispute(address,bytes32)")) /* frozen: old 2-arg selector, historical cut */;
        replaceSels[6]  = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        replaceSels[7]  = ArbiterRegistryFacet.clearDisputeClaim.selector;
        replaceSels[8]  = ArbiterRegistryFacet.isRegisteredArbiter.selector;
        replaceSels[9]  = ArbiterRegistryFacet.getArbiters.selector;
        replaceSels[10] = ArbiterRegistryFacet.getDisputeClaimer.selector;
        replaceSels[11] = ArbiterRegistryFacet.getArbiterDeals.selector;
        replaceSels[12] = ArbiterRegistryFacet.getClaimCommitment.selector;
        replaceSels[13] = ArbiterRegistryFacet.activateDAO.selector;
        replaceSels[14] = ArbiterRegistryFacet.applyAsArbiter.selector;
        replaceSels[15] = ArbiterRegistryFacet.isDaoActive.selector;
        replaceSels[16] = ArbiterRegistryFacet.getMinXPToRegister.selector;
        replaceSels[17] = ArbiterRegistryFacet.getDaoThreshold.selector;

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replaceSels
        });

        // ── Add: 14 новых селекторов ─────────────────────────────────────────
        bytes4[] memory addSels = new bytes4[](14);
        addSels[0]  = ArbiterRegistryFacet.submitVerdict.selector;
        addSels[1]  = ArbiterRegistryFacet.finalizeVerdict.selector;
        addSels[2]  = ArbiterRegistryFacet.overturnVerdict.selector;
        addSels[3]  = ArbiterRegistryFacet.freezeVerdict.selector;
        addSels[4]  = ArbiterRegistryFacet.unfreezeVerdict.selector;
        addSels[5]  = ArbiterRegistryFacet.withdrawArbiterReward.selector;
        addSels[6]  = ArbiterRegistryFacet.fundVault.selector;
        addSels[7]  = ArbiterRegistryFacet.setRewardPerDispute.selector;
        addSels[8]  = ArbiterRegistryFacet.setDAOAddress.selector;
        addSels[9]  = ArbiterRegistryFacet.getPendingVerdict.selector;
        addSels[10] = ArbiterRegistryFacet.getArbiterReward.selector;
        addSels[11] = ArbiterRegistryFacet.getVaultBalance.selector;
        addSels[12] = ArbiterRegistryFacet.getRewardPerDispute.selector;
        addSels[13] = ArbiterRegistryFacet.getDAOAddress.selector;

        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(newFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: addSels
        });

        IDiamondCut(DIAMOND).diamondCut(cuts, address(0), "");

        console.log("=== ArbiterRegistry V3 upgrade complete ===");
        console.log("  [Replace] 18 existing selectors");
        console.log("  [Add]     submitVerdict / finalizeVerdict / overturnVerdict");
        console.log("  [Add]     freezeVerdict / unfreezeVerdict");
        console.log("  [Add]     withdrawArbiterReward / fundVault");
        console.log("  [Add]     setRewardPerDispute / setDAOAddress");
        console.log("  [Add]     views: getPendingVerdict, getArbiterReward, getVaultBalance, ...");

        require(
            IDiamondLoupe(DIAMOND).facetAddress(ArbiterRegistryFacet.submitVerdict.selector) == address(newFacet),
            "submitVerdict: wrong facet"
        );
        require(
            IDiamondLoupe(DIAMOND).facetAddress(bytes4(keccak256("claimDispute(address,bytes32)")) /* frozen: old 2-arg selector, historical cut */) == address(newFacet),
            "claimDispute: wrong facet"
        );
        console.log("Verification passed.");

        vm.stopBroadcast();
    }
}
