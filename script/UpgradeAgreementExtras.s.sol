// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Исторический скрипт: отработал один раз при своём апгрейде.
// Адрес диамонда внутри мёртв, живой сегодня — 0x760F07367888C62f7c2Dfb619A5e534132855ce5.
// Запускать не нужно: полный деплой с нуля — script/DeployFull.s.sol,
// инкрементальные апгрейды оформляются новыми скриптами.

// ============================================================
// UpgradeAgreementExtras.s.sol
//
// Деплоит новый AgreementDeployer (с extras функциями) и
// регистрирует его в Diamond через setAgreementDeployer().
//
// Новые функции Agreement:
//   proposeExtra(uint256 amount, bytes32 termsHash)
//   acceptExtra(uint256 extraId)
//   rejectExtra(uint256 extraId)
//   getExtra(uint256 extraId)
//   totalPayout()
//
// Старые сделки не затронуты — они деплоились старым AgreementDeployer.
// Новые сделки (после запуска скрипта) будут иметь extras support.
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DiamondProxy.sol";
import "../src/AgreementDeployer.sol";
import "../src/FactoryFacet.sol";

contract UpgradeAgreementExtras is Script {
    address constant DIAMOND = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        AgreementDeployer newDeployer = new AgreementDeployer(DIAMOND);
        console.log("New AgreementDeployer:", address(newDeployer));

        FactoryFacet(DIAMOND).setAgreementDeployer(address(newDeployer));
        console.log("Diamond.setAgreementDeployer done");

        vm.stopBroadcast();

        address check = FactoryFacet(DIAMOND).getAgreementDeployer();
        require(check == address(newDeployer), "Deployer not set correctly");
        console.log("=== UPGRADE DONE ===");
        console.log("New agreements will support proposeExtra / acceptExtra / rejectExtra");
    }
}
