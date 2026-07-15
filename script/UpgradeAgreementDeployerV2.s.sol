// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeAgreementDeployerV2.s.sol
//
// Деплоит новый AgreementDeployer с обновлённым Agreement.sol:
//   - setArbiter() разрешает Diamond как арбитра (без isRegisteredArbiter)
//   - resolveDispute() принимает вызов от Diamond напрямую
//
// Usage:
//   forge script script/UpgradeAgreementDeployerV2.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/AgreementDeployer.sol";
import "../src/FactoryFacet.sol";

contract UpgradeAgreementDeployerV2 is Script {
    address constant DIAMOND = 0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        AgreementDeployer newDeployer = new AgreementDeployer(DIAMOND);
        console.log("New AgreementDeployer:", address(newDeployer));

        FactoryFacet(DIAMOND).setAgreementDeployer(address(newDeployer));
        console.log("AgreementDeployer set in Diamond.");

        address stored = FactoryFacet(DIAMOND).getAgreementDeployer();
        require(stored == address(newDeployer), "Verification failed");
        console.log("Verification passed.");

        vm.stopBroadcast();
    }
}
