// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeAgreementDisputeFee.s.sol
//
// Переключает ЖИВОЙ диамонд на реализацию Agreement, которая берёт сбор за спор
// и делит котёл при таймауте без клейма.
//
// Что делает механически: разворачивает новую реализацию Agreement, разворачивает
// новый AgreementDeployer(diamond, impl), который её клонирует, и подставляет его
// в фабрику через setAgreementDeployer. Тот же приём, что и в
// UpgradeAgreementDeployerV5.s.sol, отработавший 27 июля.
//
// Что меняется для сделок, созданных ПОСЛЕ этого шага:
//
//   1) Спор перестаёт быть бесплатным. Agreement.resolveDispute удерживает
//      DISPUTE_FEE_BPS = 300 (3%) от котла (amount + extras) с потолком
//      DISPUTE_FEE_CAP = $500 и без нижней границы, переводит их диамонду и
//      зовёт creditDisputeFee, где сбор расходится 80% арбитру / остаток казне.
//      Раньше сбор был нулевым: победитель забирал котёл целиком, а арбитр
//      работал за награду из банка. Сбор берётся при любом исходе — и когда
//      прав клиент, и когда прав исполнитель.
//
//   2) Таймаут спора, за который НИКТО не брался (arbiter == 0), делит котёл
//      пополам между сторонами и эмитит DisputeSplitNoVerdict вместо полного
//      возврата клиенту. Таймаут после клейма по-прежнему возвращает всё клиенту
//      и наказывает арбитра — та ветка не изменилась.
//
// ЭТО НЕ МИГРАЦИЯ. Уже созданные сделки остаются на старой логике навсегда:
// и полноценные контракты, развёрнутые до июльского перехода на клоны, и клоны
// EIP-1167, чей 45-байтовый байткод намертво содержит адрес прежней реализации.
// Ни один из них после этого скрипта не начнёт брать сбор и не начнёт делить
// котёл. Скрипт меняет только то, из чего будут отчеканены БУДУЩИЕ сделки.
//
// ПОРЯДОК ВЫКАТКИ. Сначала script/UpgradeArbiterRegistryDisputeFee.s.sol
// (он монтирует creditDisputeFee), только потом этот.
//
// Обратный порядок ничего не ломает и ничего не запирает: в resolveDispute
// перевод сбора стоит ВНУТРИ try, поэтому при отсутствии селектора на диамонд
// не уходит ни цента — весь котёл достаётся победителю спора, а агримент эмитит
// DisputeFeeSkipped. Держит это testResolveDisputeSurvivesAFailingCredit.
//
// Цена неверного порядка другая: протокол просто НЕ БЕРЁТ свои 3% со всех
// споров, закрытых в этом окне, и арбитры за них не получают награды. Задним
// числом сбор не начислить — для этих сделок потеря окончательная.
//
// В отличие от июльского инцидента с fundVault, провал здесь НЕ молчаливый:
// там distribute() возвращался успехом и ничего не перемещал, а расхождение
// заметили только по балансу. Здесь каждый пропущенный сбор виден как
// DisputeFeeSkipped в логах сделки. Скрипт к тому же читает диамонд и печатает
// ниже, смонтирован ли creditDisputeFee, — но не блокирует запуск: до
// броадкаста Задачи 5 селектора там нет по определению, и сухой прогон должен
// проходить.
//
// ВЫКАТЫВАТЬ ВМЕСТЕ С ЭТИМ: хендлер DisputeSplitNoVerdict в сабграфе
// (docs/OPEN-ITEMS.md пункт 8). Без него сделка, закрытая дележом, на цепи
// финализирована и пуста, а во всех интерфейсах висит в статусе «спор» вечно.
//
// Usage (сухой прогон — сначала всегда он):
//   forge script script/UpgradeAgreementDisputeFee.s.sol \
//     --rpc-url https://sepolia.base.org
//
// Usage (боевой запуск):
//   forge script script/UpgradeAgreementDisputeFee.s.sol \
//     --rpc-url https://sepolia.base.org --private-key $PRIVATE_KEY --broadcast -vvv
//
// RPC публичный намеренно: бесплатный тариф drpc валится по таймауту на
// скриптах, читающих диамонд несколько раз (docs/OPEN-ITEMS.md §5).
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/AgreementDeployer.sol";
import "../src/FactoryFacet.sol";
import "../src/facets/ArbiterRegistryFacet.sol";

interface IDiamondOwner {
    function owner() external view returns (address);
}

interface ILoupe {
    function facetAddress(bytes4 selector) external view returns (address);
}

/// Только ради селектора: implementation() — автогеттер публичной переменной,
/// а у них селектор через AgreementDeployer.implementation.selector не берётся.
interface IImplementationReader {
    function implementation() external view returns (address);
}

contract UpgradeAgreementDisputeFee is Script {
    function run() external {
        address diamond     = vm.envAddress("DIAMOND_ADDRESS");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address broadcaster = vm.addr(deployerKey);

        // ── Пре-флайт: всё, что можно проверить до траты газа ──────────────
        // Два деплоя перед setAgreementDeployer стоят реальных денег, поэтому
        // спотыкаться дешевле здесь, чем на последнем шаге.
        require(diamond != address(0), "upgrade: DIAMOND_ADDRESS is zero");
        require(diamond.code.length > 0, "upgrade: DIAMOND_ADDRESS has no code");

        address currentOwner = IDiamondOwner(diamond).owner();
        require(
            currentOwner == broadcaster,
            "upgrade: PRIVATE_KEY is not the diamond owner - setAgreementDeployer would revert after two paid deploys"
        );

        // Старый деплойер нужен для отката: вернуть прежнее поведение можно
        // одной транзакцией на этот адрес.
        address oldDeployer = FactoryFacet(diamond).getAgreementDeployer();
        require(oldDeployer != address(0), "upgrade: factory has no deployer set - use DeployFull, not this upgrade");

        console.log("--- Before ---");
        console.log("Diamond:              ", diamond);
        console.log("Owner:                ", currentOwner);
        console.log("Current deployer:     ", oldDeployer);
        // Реализация, на которую откат вернёт новые сделки. Читаем низкоуровнево:
        // деплойеры до перехода на клоны функции implementation() не имели, и
        // упасть на справочной строке было бы глупо.
        (bool ok, bytes memory raw) = oldDeployer.staticcall(
            abi.encodeWithSelector(IImplementationReader.implementation.selector)
        );
        if (ok && raw.length == 32) {
            console.log("  clones impl:        ", abi.decode(raw, (address)));
        } else {
            console.log("  clones impl:         n/a (pre-clones deployer, deploys full contracts)");
        }

        // Не гейт, а громкая справка: до броадкаста Задачи 5 селектора здесь
        // нет, и сухой прогон обязан проходить. См. «ПОРЯДОК ВЫКАТКИ» в шапке.
        address creditRouter = ILoupe(diamond).facetAddress(ArbiterRegistryFacet.creditDisputeFee.selector);
        if (creditRouter == address(0)) {
            console.log("");
            console.log("!! creditDisputeFee is NOT mounted on this diamond.");
            console.log("!! Expected in a dry run before UpgradeArbiterRegistryDisputeFee.s.sol");
            console.log("!! is broadcast. If you see this with --broadcast, you are shipping in");
            console.log("!! the wrong order: every dispute closed until the facet lands emits");
            console.log("!! DisputeFeeSkipped, and those 3% are lost for good.");
        } else {
            console.log("  creditDisputeFee -> ", creditRouter);
        }
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
        require(stored == address(newDeployer), "upgrade: setAgreementDeployer did not take effect");
        require(
            newDeployer.authorizedCaller() == diamond,
            "upgrade: new deployer is wired to a different caller"
        );
        require(
            newDeployer.implementation() == address(agreementImpl),
            "upgrade: new deployer points at a different implementation"
        );

        console.log("");
        console.log("--- After ---");
        console.log("Deployer in diamond:  ", stored);
        console.log("  authorizedCaller:   ", newDeployer.authorizedCaller());
        console.log("  implementation:     ", newDeployer.implementation());
        // Ставку и потолок читаем с только что развёрнутой реализации, а не
        // переписываем из исходника: печатается то, что реально на цепи.
        console.log("  dispute fee bps:    ", agreementImpl.DISPUTE_FEE_BPS());
        console.log("  dispute fee cap:    ", agreementImpl.DISPUTE_FEE_CAP());
        console.log("");
        console.log("New deals pay the dispute fee and split an unclaimed pot in half.");
        console.log("Deals that already exist keep the old logic - this is not a migration.");
        console.log("");
        console.log("Still owed with this release: the DisputeSplitNoVerdict handler in the");
        console.log("subgraph (docs/OPEN-ITEMS.md item 8). Without it a pot settled by split");
        console.log("shows as 'disputed' forever in every interface.");
        console.log("");
        console.log("Rollback - one transaction, but read what it does NOT undo:");
        console.log("");
        console.log("  cast send <diamond> \"setAgreementDeployer(address)\" <old> \\");
        console.log("    --private-key $PRIVATE_KEY --rpc-url https://sepolia.base.org");
        console.log("  <diamond> =", diamond);
        console.log("  <old>     =", oldDeployer);
        console.log("");
        console.log("  This is INCOMPLETE BY CONSTRUCTION. Every EIP-1167 clone minted");
        console.log("  between the upgrade and the rollback carries the new implementation");
        console.log("  address inside its 45 bytes of code and delegates there forever.");
        console.log("  Swapping the deployer restores the old behaviour for NEW deals only;");
        console.log("  there is no way to move an existing clone to another implementation.");
        console.log("");
        console.log("  Those clones keep charging the 3% and keep splitting an unclaimed pot");
        console.log("  in half for as long as the arbiter facet stays mounted. Nothing breaks");
        console.log("  and nothing is stuck - they simply behave the way they were minted.");
        console.log("");
        console.log("  If the facet is rolled back too, creditDisputeFee stops existing and");
        console.log("  those same clones close their disputes fine: the call sits in a try");
        console.log("  with the transfer inside it, so the whole pot goes to the winner and");
        console.log("  the agreement emits DisputeFeeSkipped. The half-split on an unclaimed");
        console.log("  timeout stays either way - it is local to the agreement and no facet");
        console.log("  rollback touches it.");
    }
}
