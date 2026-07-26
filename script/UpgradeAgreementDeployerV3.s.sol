// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

// ============================================================
// UpgradeAgreementDeployerV3.s.sol
//
// Деплоит новый AgreementDeployer с обновлённым Agreement.sol:
//   - resolveDispute() пишет clientWonDispute — кто выиграл арбитраж.
//     ReputationFacet читает это поле, чтобы начислять XP только
//     победившей стороне и списывать её у проигравшей (см.
//     UpgradeReputationFacetDisputePenalty.s.sol — применить вместе).
//
// НЕ ретроактивно: уже задеплоенные Agreement остаются на старой логике
// (start-XP уже начислен обеим сторонам без разбора победителя). Влияет
// только на сделки, созданные после этого апгрейда.
//
// Usage:
//   forge script script/UpgradeAgreementDeployerV3.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/AgreementDeployer.sol";
import "../src/FactoryFacet.sol";

contract UpgradeAgreementDeployerV3 is Script {
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
