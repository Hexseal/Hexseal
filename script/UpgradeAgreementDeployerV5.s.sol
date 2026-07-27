// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeAgreementDeployerV5.s.sol
//
// Включает EIP-1167 клоны на ЖИВОМ диамонде.
//
// Что делает: разворачивает Agreement один раз как контракт-реализацию,
// разворачивает новый AgreementDeployer, который клонирует её через
// Clones.clone(), и подставляет его в диамонд через setAgreementDeployer.
//
// Зачем: до этого каждая сделка разворачивала полноценный контракт Agreement
// на 20 549 байт рантайма — примерно 4 400 000 газа, которые платит релеер.
// После — 45-байтовый клон, измерено 278 355 газа. В 15.8 раза дешевле
// (не в 20, как обещала первоначальная оценка: инициализация девяти полей
// хранилища вышла дороже расчёта на 27%). Замеры — docs/audits/2026-07-26-clones-report.md.
//
// НЕ РЕТРОАКТИВНО. Уже задеплоенные Agreement остаются обычными контрактами
// со своим байткодом и работают как работали. Схема применяется только к
// сделкам, созданным ПОСЛЕ этого апгрейда.
//
// Почему адрес диамонда из окружения, а не константой: предыдущие четыре
// версии этого скрипта захардкожены на диамонды, которых больше нет, и
// запуск любой из них сегодня отработал бы «успешно» против мёртвого
// адреса. Ровно по этой причине из репозитория удалён Deploy.s.sol.
//
// Usage (сухой прогон — сначала всегда он):
//   forge script script/UpgradeAgreementDeployerV5.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL
//
// Usage (боевой запуск):
//   forge script script/UpgradeAgreementDeployerV5.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/AgreementDeployer.sol";
import "../src/FactoryFacet.sol";

interface IDiamondOwner {
    function owner() external view returns (address);
}

contract UpgradeAgreementDeployerV5 is Script {
    function run() external {
        address diamond     = vm.envAddress("DIAMOND_ADDRESS");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address broadcaster = vm.addr(deployerKey);

        // ── Пре-флайт: всё, что можно проверить до траты газа ──────────────
        // Два деплоя перед setAgreementDeployer стоят реальных денег, поэтому
        // спотыкаться дешевле здесь, чем на последнем шаге.
        require(diamond != address(0), "V5: DIAMOND_ADDRESS is zero");
        require(diamond.code.length > 0, "V5: DIAMOND_ADDRESS has no code");

        address currentOwner = IDiamondOwner(diamond).owner();
        require(
            currentOwner == broadcaster,
            "V5: PRIVATE_KEY is not the diamond owner - setAgreementDeployer would revert after two paid deploys"
        );

        // Старый деплойер нужен для отката: если что-то пойдёт не так, вернуть
        // прежнее поведение можно одной транзакцией на этот адрес.
        address oldDeployer = FactoryFacet(diamond).getAgreementDeployer();
        require(oldDeployer != address(0), "V5: factory has no deployer set - use DeployFull, not this upgrade");

        console.log("--- Before ---");
        console.log("Diamond:              ", diamond);
        console.log("Owner:                ", currentOwner);
        console.log("Current deployer:     ", oldDeployer);
        console.log("");

        // ── Апгрейд ────────────────────────────────────────────────────────
        vm.startBroadcast(deployerKey);

        // Реализация разворачивается ОДИН раз. Её конструктор запирает сам
        // контракт (_initialized = true), поэтому проинициализировать
        // реализацию напрямую нельзя — только клоны, у каждого своё хранилище.
        Agreement agreementImpl = new Agreement();
        console.log("Agreement impl:       ", address(agreementImpl));

        // Конструктор деплойера сам проверяет, что у реализации есть код:
        // Clones.clone() этого не делает, а вызов к адресу без кода в EVM
        // возвращает УСПЕХ — клон-скорлупа прошла бы как рабочая сделка.
        AgreementDeployer newDeployer = new AgreementDeployer(diamond, address(agreementImpl));
        console.log("New AgreementDeployer:", address(newDeployer));

        FactoryFacet(diamond).setAgreementDeployer(address(newDeployer));

        vm.stopBroadcast();

        // ── Проверка результата ────────────────────────────────────────────
        address stored = FactoryFacet(diamond).getAgreementDeployer();
        require(stored == address(newDeployer), "V5: setAgreementDeployer did not take effect");
        require(
            newDeployer.authorizedCaller() == diamond,
            "V5: new deployer is wired to a different caller"
        );
        require(
            newDeployer.implementation() == address(agreementImpl),
            "V5: new deployer points at a different implementation"
        );

        console.log("");
        console.log("--- After ---");
        console.log("Deployer in diamond:  ", stored);
        console.log("  authorizedCaller:   ", newDeployer.authorizedCaller());
        console.log("  implementation:     ", newDeployer.implementation());
        console.log("");
        console.log("Clones are live. New deals cost ~278k gas instead of ~4.4M.");
        console.log("Already-deployed agreements are untouched and keep working.");
        console.log("");
        console.log("Rollback (restores the previous deployer in one transaction):");
        console.log("  cast send <diamond> \"setAgreementDeployer(address)\" <old> \\");
        console.log("    --private-key $PRIVATE_KEY --rpc-url $BASE_SEPOLIA_RPC_URL");
        console.log("  <diamond> =", diamond);
        console.log("  <old>     =", oldDeployer);
    }
}
