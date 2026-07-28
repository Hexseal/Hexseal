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
//      DISPUTE_FEE_CAP = $500 и без нижней границы, зовёт creditDisputeFee
//      (где сбор расписывается 80% арбитру / остаток казне) и переводит деньги
//      диамонду ТОЛЬКО если зачисление прошло. Порядок именно такой и он
//      намеренный: при обратном сбор сгорал бы на каждом провале — у диамонда
//      нет функции спасения. См. Agreement.sol, комментарий над этим блоком.
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
// DisputeFeeSkipped в логах сделки.
//
// Но полагаться на то, что оператор заметит строку в логе, незачем: скрипт
// читает диамонд и при БРОАДКАСТЕ отказывается стартовать, если creditDisputeFee
// там не смонтирован. Сухой прогон при этом проходит — гейт различает контексты
// через vm.isContext(ForgeContext.ScriptBroadcast), а не по состоянию цепи.
// Иначе обязательный сухой прогон был бы невозможен до выкатки Задачи 5.
//
// ВЫКАТЫВАТЬ ВМЕСТЕ С ЭТИМ — И ЭТО БЛОКЕР РЕЛИЗА, а не пожелание: хендлер
// DisputeSplitNoVerdict в сабграфе (docs/OPEN-ITEMS.md пункт 8, помечен там как
// блокирующий выкатку). Без него сделка, закрытая дележом, на цепи финализирована
// и пуста, а во всех интерфейсах висит в статусе «спор» вечно — состояние
// интерфейса расходится с состоянием цепи, и расходится необратимо.
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

        // Гейт на порядок выкатки. Ключ — не состояние цепи, а КОНТЕКСТ запуска:
        // до броадкаста Задачи 5 селектора здесь нет по определению, и сухой
        // прогон обязан проходить, а вот боевой запуск в неверном порядке должен
        // быть невозможен. Полагаться на то, что оператор заметит строку с "!!"
        // в прокручивающемся логе, — не защита.
        address creditRouter = ILoupe(diamond).facetAddress(ArbiterRegistryFacet.creditDisputeFee.selector);
        if (creditRouter == address(0)) {
            console.log("");
            console.log("!! creditDisputeFee is NOT mounted on this diamond.");
            console.log("!! Expected in a dry run before UpgradeArbiterRegistryDisputeFee.s.sol");
            console.log("!! is broadcast. Shipping in this order would cost the protocol its 3%");
            console.log("!! on every dispute resolved by verdict until the facet lands, and the");
            console.log("!! arbiters their rewards for those. Not recoverable after the fact.");
            require(
                !vm.isContext(VmSafe.ForgeContext.ScriptBroadcast),
                "upgrade: creditDisputeFee is not mounted - ship UpgradeArbiterRegistryDisputeFee.s.sol first"
            );
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
        if (creditRouter != address(0)) {
            console.log("New deals pay the dispute fee and split an unclaimed pot in half.");
        } else {
            console.log("New deals split an unclaimed pot in half. They will NOT pay the dispute");
            console.log("fee until creditDisputeFee is mounted - see the !! block above.");
        }
        console.log("Deals that already exist keep the old logic - this is not a migration.");
        console.log("");
        console.log("STILL A RELEASE BLOCKER: the DisputeSplitNoVerdict handler in the subgraph");
        console.log("(docs/OPEN-ITEMS.md item 8, filed there as blocking). Without it a pot");
        console.log("settled by split is finalized and empty on chain while every interface");
        console.log("shows it as 'disputed' - forever, and the divergence does not heal.");
        console.log("");
        console.log("Confirm on chain after the broadcast, not from this simulation log:");
        console.log("  cast call <diamond> \"getAgreementDeployer()(address)\" \\");
        console.log("    --rpc-url https://sepolia.base.org");
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
        console.log("  Those clones keep charging the 3% for as long as the arbiter facet stays");
        console.log("  mounted. Separately, and regardless of any facet, they keep splitting an");
        console.log("  unclaimed pot in half: that branch is local arithmetic inside the");
        console.log("  agreement. Nothing breaks and nothing is stuck - they simply behave the");
        console.log("  way they were minted.");
        console.log("");
        console.log("  If the facet is rolled back too, creditDisputeFee stops existing and");
        console.log("  those same clones close their disputes fine: the call sits in a try");
        console.log("  with the transfer inside it, so the whole pot goes to the winner and");
        console.log("  the agreement emits DisputeFeeSkipped.");
        console.log("");
        console.log("  BUT ROLLING THE FACET BACK IS NOT ONE COMMAND. Follow the three-step");
        console.log("  order printed by script/UpgradeArbiterRegistryDisputeFee.s.sol: its");
        console.log("  step 2 drains getTreasurySlice() while the new facet is still mounted,");
        console.log("  and step 3 makes step 2 impossible. Skip the order and the accrued");
        console.log("  slice becomes USDC on the diamond with no mounted function reaching it.");
        console.log("");
        console.log("  One caveat on the half-split surviving: triggerArbiterTimeout calls");
        console.log("  hasSubmittedVerdict OUTSIDE any try. That selector predates this branch");
        console.log("  and is among the 44 a facet rollback restores, so the split does survive");
        console.log("  the documented rollback - but unmount that one selector by hand and the");
        console.log("  whole timeout path reverts, split included.");
    }
}
