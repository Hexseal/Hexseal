// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradeFeeModel.s.sol
//
// Переводит ЖИВОЙ диамонд 0x760F07367888C62f7c2Dfb619A5e534132855ce5 с
// фиксированной комиссии по региону на max(amount * feeBps / 10_000, feeFloor).
// См. внутренний замысел экономики комиссий (не публикуется) и
// docs/OPEN-ITEMS.md п.20 («Скриптов выкатки комиссии не существует»).
//
// ── БАЗА ОТСЧЁТА — ЦЕПЬ, НЕ main. ────────────────────────────────────────
// Живой диамонд собран script/DeployFull.s.sol 25.07.2026 (коммит 827bea2,
// broadcast/DeployFull.s.sol/84532/run-latest.json, ts 1784994655863) и с тех
// пор точечно патчился ТРИЖДЫ — подтверждено реальными (не dry-run)
// broadcast/*/84532/run-latest.json с более поздним timestamp:
//
//   - UpgradeAgreementDeployerV5.s.sol (27.07, ts 1785153774304) — включил
//     EIP-1167 клоны. Живой AgreementDeployer сейчас 0x863923769fbefb5da6c46
//     57d6f9ae7d900965b2b, а НЕ 0x5B765CeeCA347973a33AFD5eD2d3c8a6Bde0323B из
//     DeployFull — и это тот же адрес, что в CLAUDE.md, то есть таблица в
//     CLAUDE.md эту замену не отражает. Implementation сейчас
//     0xf7cbece7949a0f7df325fff27122840a19c14a2b (ДО того, как в исходники
//     попал сбор за спор — подробности ниже).
//   - DeployTreasury.s.sol (27.07, ts 1785158208535) — Treasury
//     0x2e7a7a0515bfdc0006a812ebb3e55d32800bc660. Диамонд эта транзакция НЕ
//     трогает (setFeeRecipient — отдельный ручной шаг, вне скрипта).
//   - UpgradeArbiterRegistryFundVault.s.sol (27.07, ts 1785167272950) — чистый
//     Replace 44/44 селекторов ArbiterRegistryFacet (доступ к fundVault:
//     onlyOwner -> owner ИЛИ feeRecipient). Живой ArbiterRegistryFacet сейчас
//     0x3380e0a5b9b87cb677e19a96a76f094c511f8bc0, а НЕ 0xf707aa69fdcd0160dbe
//     57e402356de2079085326 из DeployFull.
//
// Ни один из этих трёх патчей не трогал FactoryFacet, JobBoardFacet,
// ServiceBoardFacet, RegistryFacet, DealMetadataFacet — их живой адрес
// по-прежнему тот, что развернул DeployFull.
//
// Из этого следствие для самого скрипта: он читает ТЕКУЩИЕ адреса и
// селекторы С ЦЕПИ через facetAddress()/facets() в момент запуска, а не
// подставляет константой ни один из адресов, перечисленных выше. Поэтому
// его корректность не зависит от того, не патчили ли диамонд ещё раз в
// промежутке между написанием этого файла и его запуском.
//
// ── ЧТО МЕНЯЕТСЯ ─────────────────────────────────────────────────────────
// Шесть фасетов меняли исходники после 827bea2 (git diff 827bea2 HEAD --stat
// -- src/): FactoryFacet, ArbiterRegistryFacet, JobBoardFacet,
// ServiceBoardFacet, RegistryFacet, DealMetadataFacet.
//
// На цепи сейчас 145 селекторов (11 фасетов), в текущих исходниках у тех же
// 11 фасетов — 159. Remove — НОЛЬ (ни одна функция не удалена, снято прямым
// сравнением facets() с methodIdentifiers). Add — РОВНО 14:
//
//   FactoryFacet (8):          getFeeBps, getFeeFloor, getMaxPendingRequests,
//                              initFeeModel, quoteFee, setFeeBps, setFeeFloor,
//                              setMaxPendingRequests
//   ArbiterRegistryFacet (3):  creditDisputeFee, getTreasurySlice,
//                              withdrawTreasurySlice
//   JobBoardFacet (1):         getJobFeeHeld
//   ServiceBoardFacet (2):     getPendingRequestCount, getRequestFeeHeld
//
// RegistryFacet и DealMetadataFacet — ноль Add. Их правки не трогают ABI:
// RegistryFacet переименовал error ZeroAddress -> RegistryZeroAddress (тот же
// приём, что и FactoryZeroAddress в 1172618 — смена СЕЛЕКТОРА ОШИБКИ, но не
// селектора функции), DealMetadataFacet поменял домен в SVG hexseal.com ->
// hexseal.net. Оба — чистый Replace.
//
// ── ПОЧЕМУ ОДИН diamondCut, А НЕ ШЕСТЬ ───────────────────────────────────
// Формально атомарность с initFeeModel обязательна только для FactoryFacet —
// но эту обязанность делят JobBoardFacet и ServiceBoardFacet: их
// mintJob/mintJobWithPermit и requestService/requestServiceWithPermit тоже
// зовут FactoryStorage.quote() для удержания комиссии при постинге
// (JobBoardFacet.sol:217,275, ServiceBoardFacet.sol:408,468). Если их Replace
// попадёт в цепь раньше, чем FactoryFacet.initFeeModel засеет feeFloor, —
// ровно тот же revert FeeNotConfigured ловит уже опубликованные доски,
// просто через другой фасет, чем описано в шапке п.20 OPEN-ITEMS.md.
// ArbiterRegistryFacet/RegistryFacet/DealMetadataFacet от feeFloor не зависят
// вовсе, но выносить их в отдельный cut ради этого незачем: газ не
// ограничение (явное решение владельца), а одна транзакция с явно
// перечисленными адресами проще проверить глазами, чем оркестровать порядок
// нескольких.
//
// ── ПОЧЕМУ НЕ СТАРЫЕ СКРИПТЫ ──────────────────────────────────────────────
// В script/ уже лежат V1-V5 UpgradeFactoryFacet*.s.sol — ревертят все пять,
// см. шапку script/UpgradeFactoryFacetDisputeGate.s.sol. Там же лежат
// script/UpgradeArbiterRegistryDisputeFee.s.sol и
// script/UpgradeAgreementDisputeFee.s.sol — написаны раньше, НИ РАЗУ не
// broadcast (только broadcast/*/84532/dry-run/run-latest.json), делают
// Replace(44)+Add(3) для ArbiterRegistryFacet ровно так же, как этот скрипт.
// Не трогаю и не дублирую их логику — см. "СБОР ЗА СПОР" ниже. После того как
// ЭТОТ cut пройдёт, UpgradeArbiterRegistryDisputeFee.s.sol будет ревертить на
// собственном пре-флайте («один из трёх уже смонтирован») — это ожидаемо,
// безопасно и не является поломкой: он просто больше не нужен.
//
// ── СПИСКИ СЕЛЕКТОРОВ — ИЗ ИСХОДНИКОВ, НЕ РУКАМИ ──────────────────────────
// Как в DeployFull.s.sol: каждый список — `public pure` функция вида
// `<Facet>.<fn>.selector`, единый источник правды для buildFeeModelCuts()
// ниже и для test/UpgradeFeeModelSelectors.t.sol, который сверяет их с
// `out/<Facet>.sol/<Facet>.json`.methodIdentifiers.
//
// ── REPLACE И ADD — ОТДЕЛЬНЫЕ ЗАПИСИ FacetCut ────────────────────────────
// Ни один селектор не в обоих: DiamondCutLib.replaceFunctions
// (DiamondProxy.sol:184) ревертит на `oldFacetAddress == _facetAddress` (тот
// же адрес — Replace бессмыслен), DiamondCutLib.addFunctions
// (DiamondProxy.sol:167) ревертит на `oldFacetAddress != address(0)` (селектор
// уже существует). Оба списка для каждого фасета проверяются на цепи ДО
// broadcast (см. run() — _checkReplaceGroup/_checkAddGroup).
//
// ── АТОМАРНЫЙ ЗАСЕВ ───────────────────────────────────────────────────────
// initFeeModel(bps, floor, maxPending) зовётся через _init/_calldata ЭТОГО ЖЕ
// diamondCut. _init — адрес РАЗВЁРНУТОЙ ЗАНОВО имплементации FactoryFacet, а
// НЕ диамонда: DiamondCutLib.initializeDiamondCut делает
// `_init.delegatecall(_calldata)` уже в контексте диамонда, поэтому
// хранилище резолвится диамондовское, а msg.sender сквозь delegatecall
// остаётся владельцем, вызвавшим diamondCut — onlyOwner здесь настоящий
// гейт, а не декорация. Без этого между cut'ом и отдельной конфигурирующей
// транзакцией есть окно, в котором quote() ревертит FeeNotConfigured на
// КАЖДОМ денежном пути, включая acceptApplicant/acceptRequest по уже
// опубликованным заказам. Спецификация вызова —
// test/Boards.t.sol::testInitFeeModel_SeedsConfigInTheSameTransactionAsTheCut.
// Значения — 500 bps (5%), floor 1_000_000 (1 USDC, 6 decimals), maxPending 5
// — те же дефолты, что initFactory() выставляет на свежем деплое.
//
// ── САБГРАФ v2.2.0 — ЕДЕТ ВМЕСТЕ С ЭТИМ CUT'ОМ, А НЕ ПОСЛЕ ───────────────
// Вторая зависимость этого cut'а, помимо сбора за спор ниже (и в отличие от
// него — не «следующим шагом», а тем же окном выкатки). Своя заметка о
// совместной выкатке лежит в subgraph/package.json (`_note_deploy`): v2.2.0
// добавила сущность FeeCollection — индексацию события FeeCollected, которое
// эмитят FactoryFacet, JobBoardFacet и ServiceBoardFacet этого же релиза.
// Деплой — ручной, `npm run deploy:studio` из subgraph/ (публикация наружу).
//
// Что деградирует, пока сабграф старый: леджер дохода читается из
// AgreementDeployed.fee, а это ПЕРЕСЧЁТ FactoryStorage.quote() на момент
// НАЙМА (FactoryFacet.sol:254/273 и :308/327) — не то, что реально удержано:
//   - на прямом найме (deployAgreement/deployAndFund) число совпадает с
//     переведённым: quote() и перевод стоят в одной транзакции;
//   - на досках расходится. acceptApplicant/acceptRequest зовут
//     deployAgreement изнутри диамонда (msg.sender == address(this)), перевода
//     комиссии там нет вовсе — реальные деньги это jobFeeHeld/requestFeeHeld,
//     удержанные при ПОСТИНГЕ. Числа сходятся только если между постингом и
//     наймом не менялись feeBps/feeFloor;
//   - у заказов и заявок, опубликованных ДО этого cut'а, jobFeeHeld и
//     requestFeeHeld равны нулю (живые фасеты этих полей не пишут вообще),
//     поэтому AgreementDeployed.fee покажет процент, которого в той
//     транзакции не списывали. FeeCollection на этом найме, наоборот,
//     не появится: старая комиссия ушла при постинге фасетом, который
//     FeeCollected не эмитит. Ни один из двух источников на таких сделках
//     не полон — это цена перехода, а не баг сабграфа.
//
// Что НЕ деградирует: статусы сделок и деньги. FeeCollection не читает ни
// один интерфейс (grep по frontend/src — ни одной ссылки), от него не
// зависит ни один денежный или жизненный путь. Это аналитика — разбивка
// дохода по kind (шесть видов, schema.graphql:66-85), и только она. Тем
// этот пункт и отличается от docs/OPEN-ITEMS.md п.8, где без хендлера
// пользователь видит открытым спор, которого на цепи уже нет.
//
// Задержка не теряет данные навсегда: subgraph.yaml держит
// startBlock: 44613049, новая версия синхронизируется с него, поэтому
// выкаченный позже v2.2.0 доиндексирует FeeCollection задним числом. Плата
// за задержку — окно, в котором леджер дохода неверен, а не дырка в истории.
//
// ── СБОР ЗА СПОР 3% — ЧТО ЗАРАБОТАЕТ, А ЧТО НЕТ ──────────────────────────
// ArbiterRegistryFacet.creditDisputeFee/getTreasurySlice/withdrawTreasurySlice
// монтируются ЭТИМ cut'ом и готовы принимать сбор — но звать их пока некому.
// Сбор считает и переводит Agreement.resolveDispute (DISPUTE_FEE_BPS = 300 —
// Agreement.sol:285 объявление, :518 вычисление, :728 try-вызов
// creditDisputeFee), а Agreement — НЕ фасет: это реализация для
// EIP-1167 клонов за AgreementDeployer.implementation (immutable, см. выше).
// Живой клон-деплойер указывает на Agreement, развёрнутый
// UpgradeAgreementDeployerV5 27.07 — ДО того, как в исходники попал сбор за
// спор. Ни один уже существующий клон (и ни один retained pre-clone
// контракт) не начнёт брать 3% после ЭТОГО cut'а: implementation зашита в
// байткод клона навсегда, задним числом не меняется.
//
// Чтобы сбор заработал для НОВЫХ сделок, нужен ОТДЕЛЬНЫЙ деплой — этот
// скрипт его сознательно не делает (см. внутренний отчёт по этому скрипту
// выкатки, не публикуется — решение не должно приниматься молча):
//   1) script/UpgradeAgreementDisputeFee.s.sol уже написан и уже гейтится по
//      факту, что creditDisputeFee смонтирован (при реальном broadcast
//      требует facetAddress(creditDisputeFee.selector) != 0; dry-run
//      проходит всегда) — ни разу не broadcast. После ЭТОГО cut'а его
//      предусловие уже выполнено, можно запускать сразу, без
//      script/UpgradeArbiterRegistryDisputeFee.s.sol (который стал избыточен
//      — те же три селектора уже будут смонтированы этим скриптом).
//   2) РЕЛИЗ-БЛОКЕР для шага (1), а не для этого cut'а: обработчик
//      DisputeSplitNoVerdict в сабграфе не задеплоен (docs/OPEN-ITEMS.md
//      п.8) — без него сделка, закрытая дележом без клейма, останется в
//      статусе "спор" во всех интерфейсах навсегда, хотя на цепи уже
//      финализирована. Agreement этот cut не трогает вообще, поэтому сам он
//      блокером не является.
//
// Usage (сухой прогон — сначала всегда он):
//   forge script script/UpgradeFeeModel.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL
//
// Usage (боевой запуск):
//   forge script script/UpgradeFeeModel.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";

import "../../src/DiamondProxy.sol";
import "../../src/FactoryFacet.sol";
import "../../src/facets/ArbiterRegistryFacet.sol";
import "../../src/facets/JobBoardFacet.sol";
import "../../src/facets/ServiceBoardFacet.sol";
import "../../src/RegistryFacet.sol";
import "../../src/facets/DealMetadataFacet.sol";

contract UpgradeFeeModel is Script {

    // Модель комиссии: те же дефолты, что initFactory() ставит на свежем
    // деплое (см. FactoryFacet.initFactory), так что живой диамонд после
    // этого апгрейда неотличим по конфигу от диамонда, развёрнутого сегодня
    // с нуля.
    uint256 constant NEW_FEE_BPS     = 500;        // 5%
    uint256 constant NEW_FEE_FLOOR   = 1_000_000;  // 1 USDC (6 decimals)
    uint256 constant NEW_MAX_PENDING = 5;

    /// Смещение `feeFloor` внутри FactoryStorage.Layout, в слотах от
    /// FACTORY_STORAGE_POSITION. public — чтобы
    /// test/UpgradeFeeModelSelectors.t.sol сверял именно ЭТО число, а не
    /// повторял его у себя: разъедется раскладка — красным станет тест про
    /// апгрейд, а не только чужая фикстура. Обоснование числа — в
    /// readFeeFloorRaw() ниже.
    uint256 public constant FEE_FLOOR_SLOT_OFFSET = 9;

    function run() external {
        address diamond     = vm.envAddress("DIAMOND_ADDRESS");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address broadcaster = vm.addr(deployerKey);

        // ── Pre-flight ────────────────────────────────────────────────────
        require(diamond != address(0), "UpgradeFeeModel: DIAMOND_ADDRESS is zero");
        require(diamond.code.length > 0, "UpgradeFeeModel: DIAMOND_ADDRESS has no code");

        address currentOwner = OwnershipFacet(diamond).owner();
        require(
            currentOwner == broadcaster,
            "UpgradeFeeModel: PRIVATE_KEY is not the diamond owner - diamondCut would revert after six paid facet deploys"
        );

        // feeFloor должен быть НОЛЬ: initFeeModel (зовётся в _init этого
        // cut'а) ревертит AlreadyInitialized на ненулевом floor и уронит
        // ВЕСЬ cut целиком, включая шесть уже оплаченных Replace/Add — cut
        // атомарен, частичного применения не бывает.
        //
        // getFeeFloor() САМ ЕЩЁ НЕ СМОНТИРОВАН на живом диамонде — это один
        // из 14 Add-селекторов этого же скрипта, вызвать его нечем (проверено
        // руками: живая цепь ревертит "Diamond: function not found" на
        // FactoryFacet(diamond).getFeeFloor() ДО этого апгрейда). Значение
        // читается напрямую из хранилища через readFeeFloorRaw ниже.
        uint256 currentFloor = readFeeFloorRaw(diamond);
        require(
            currentFloor == 0,
            "UpgradeFeeModel: feeFloor is already nonzero on chain - initFeeModel would revert AlreadyInitialized and take the whole cut down with it"
        );

        console.log("=== UpgradeFeeModel: pre-flight ===");
        console.log("Diamond: ", diamond);
        console.log("Owner:   ", currentOwner);
        console.log("Current feeFloor (must be 0):", currentFloor);
        console.log("");

        bytes4[] memory factoryReplace  = factoryFacetReplaceSelectors();
        bytes4[] memory factoryAdd      = factoryFacetAddSelectors();
        bytes4[] memory arbiterReplace  = arbiterRegistryFacetReplaceSelectors();
        bytes4[] memory arbiterAdd      = arbiterRegistryFacetAddSelectors();
        bytes4[] memory jobBoardReplace = jobBoardFacetReplaceSelectors();
        bytes4[] memory jobBoardAdd     = jobBoardFacetAddSelectors();
        bytes4[] memory serviceReplace  = serviceBoardFacetReplaceSelectors();
        bytes4[] memory serviceAdd      = serviceBoardFacetAddSelectors();
        bytes4[] memory registryReplace = registryFacetReplaceSelectors();
        bytes4[] memory metaReplace     = dealMetadataFacetReplaceSelectors();

        // Каждый Replace-селектор смонтирован сейчас, и все селекторы одного
        // фасета указывают на ОДИН и тот же живой адрес (иначе наш список
        // Replace для этого фасета выведен неверно).
        address oldFactory  = _checkReplaceGroup("FactoryFacet",         factoryReplace, diamond);
        address oldArbiter  = _checkReplaceGroup("ArbiterRegistryFacet", arbiterReplace, diamond);
        address oldJobBoard = _checkReplaceGroup("JobBoardFacet",        jobBoardReplace, diamond);
        address oldService  = _checkReplaceGroup("ServiceBoardFacet",    serviceReplace, diamond);
        address oldRegistry = _checkReplaceGroup("RegistryFacet",        registryReplace, diamond);
        address oldMeta     = _checkReplaceGroup("DealMetadataFacet",    metaReplace, diamond);

        // Ни один из 14 Add-селекторов не смонтирован нигде на диамонде.
        _checkAddGroup("FactoryFacet",         factoryAdd, diamond);
        _checkAddGroup("ArbiterRegistryFacet", arbiterAdd, diamond);
        _checkAddGroup("JobBoardFacet",        jobBoardAdd, diamond);
        _checkAddGroup("ServiceBoardFacet",    serviceAdd, diamond);

        uint256 selectorsBefore = _totalRoutedSelectors(diamond);
        console.log("");
        console.log("Total routed selectors BEFORE cut:", selectorsBefore, "(expect 145)");
        console.log("");

        // ── Апгрейд ───────────────────────────────────────────────────────
        vm.startBroadcast(deployerKey);

        FactoryFacet         newFactory  = new FactoryFacet();
        ArbiterRegistryFacet newArbiter  = new ArbiterRegistryFacet();
        JobBoardFacet        newJobBoard = new JobBoardFacet();
        ServiceBoardFacet    newService  = new ServiceBoardFacet();
        RegistryFacet        newRegistry = new RegistryFacet();
        DealMetadataFacet    newMeta     = new DealMetadataFacet();

        console.log("=== New facet implementations ===");
        console.log("FactoryFacet:         ", address(newFactory));
        console.log("ArbiterRegistryFacet: ", address(newArbiter));
        console.log("JobBoardFacet:        ", address(newJobBoard));
        console.log("ServiceBoardFacet:    ", address(newService));
        console.log("RegistryFacet:        ", address(newRegistry));
        console.log("DealMetadataFacet:    ", address(newMeta));
        console.log("");

        IDiamondCut.FacetCut[] memory cuts = buildFeeModelCuts(
            address(newFactory), address(newArbiter), address(newJobBoard),
            address(newService), address(newRegistry), address(newMeta)
        );

        IDiamondCut(diamond).diamondCut(
            cuts,
            address(newFactory),
            abi.encodeCall(FactoryFacet.initFeeModel, (NEW_FEE_BPS, NEW_FEE_FLOOR, NEW_MAX_PENDING))
        );

        vm.stopBroadcast();

        // ── Post-flight ───────────────────────────────────────────────────
        console.log("=== Post-flight ===");

        _assertRouted("FactoryFacet Replace",         factoryReplace,  address(newFactory),  diamond);
        _assertRouted("FactoryFacet Add",             factoryAdd,      address(newFactory),  diamond);
        _assertRouted("ArbiterRegistryFacet Replace", arbiterReplace,  address(newArbiter),  diamond);
        _assertRouted("ArbiterRegistryFacet Add",     arbiterAdd,      address(newArbiter),  diamond);
        _assertRouted("JobBoardFacet Replace",        jobBoardReplace, address(newJobBoard), diamond);
        _assertRouted("JobBoardFacet Add",            jobBoardAdd,     address(newJobBoard), diamond);
        _assertRouted("ServiceBoardFacet Replace",    serviceReplace,  address(newService),  diamond);
        _assertRouted("ServiceBoardFacet Add",        serviceAdd,      address(newService),  diamond);
        _assertRouted("RegistryFacet Replace",        registryReplace, address(newRegistry), diamond);
        _assertRouted("DealMetadataFacet Replace",    metaReplace,     address(newMeta),     diamond);

        require(IDiamondLoupe(diamond).facetFunctionSelectors(oldFactory).length == 0,  "post: old FactoryFacet still holds selectors");
        require(IDiamondLoupe(diamond).facetFunctionSelectors(oldArbiter).length == 0,  "post: old ArbiterRegistryFacet still holds selectors");
        require(IDiamondLoupe(diamond).facetFunctionSelectors(oldJobBoard).length == 0, "post: old JobBoardFacet still holds selectors");
        require(IDiamondLoupe(diamond).facetFunctionSelectors(oldService).length == 0,  "post: old ServiceBoardFacet still holds selectors");
        require(IDiamondLoupe(diamond).facetFunctionSelectors(oldRegistry).length == 0, "post: old RegistryFacet still holds selectors");
        require(IDiamondLoupe(diamond).facetFunctionSelectors(oldMeta).length == 0,     "post: old DealMetadataFacet still holds selectors");
        console.log("All six old facet addresses hold zero selectors (fully displaced).");
        console.log("");

        uint256 selectorsAfter = _totalRoutedSelectors(diamond);
        require(selectorsAfter == selectorsBefore + 14, "post: expected exactly +14 routed selectors after the cut");
        console.log("Total routed selectors AFTER cut: ", selectorsAfter, "(expect 159)");
        console.log("");

        uint256 feeBps   = FactoryFacet(diamond).getFeeBps();
        uint256 feeFloor = FactoryFacet(diamond).getFeeFloor();
        uint256 maxPend  = FactoryFacet(diamond).getMaxPendingRequests();
        uint256 quoted   = FactoryFacet(diamond).quoteFee(200_000_000); // 200 USDC

        console.log("getFeeBps():             ", feeBps,   "(expect 500)");
        console.log("getFeeFloor():           ", feeFloor, "(expect 1000000)");
        console.log("getMaxPendingRequests(): ", maxPend,  "(expect 5)");
        console.log("quoteFee(200e6):         ", quoted,   "(expect 10000000)");

        require(feeBps == NEW_FEE_BPS, "post: feeBps mismatch");
        require(feeFloor == NEW_FEE_FLOOR, "post: feeFloor mismatch");
        require(maxPend == NEW_MAX_PENDING, "post: maxPendingRequests mismatch");
        require(quoted == 10_000_000, "post: quoteFee(200e6) mismatch");

        // getAllFees() ревертит FeeNotRegional() внутри — снаружи диамонда
        // это виден как success=false на низкоуровневом .call.
        (bool okAllFees, ) = diamond.call(abi.encodeWithSelector(FactoryFacet.getAllFees.selector));
        require(!okAllFees, "post: getAllFees() should revert (region fees are retired) but it succeeded");
        console.log("getAllFees() reverts as expected:", !okAllFees);
        console.log("");

        console.log("=== Fee model live on chain ===");
        console.log("500 bps (5%) with a 1 USDC floor, max 5 pending requests per client.");
        console.log("");
        console.log("=== Still needed for the dispute fee to actually collect (separate decision) ===");
        console.log("script/UpgradeAgreementDisputeFee.s.sol - deploys a new Agreement impl +");
        console.log("AgreementDeployer + setAgreementDeployer. Its own gate now passes: this cut");
        console.log("mounted creditDisputeFee. Blocked on docs/OPEN-ITEMS.md item 8 (subgraph).");
        console.log("");

        console.log("=== Rollback ===");
        console.log("One diamondCut: Replace each of the six groups above back onto <old*>, PLUS");
        console.log("Remove (action 2, facetAddress MUST be address(0) - see DiamondProxy.sol:194)");
        console.log("of the 14 Add selectors, in the SAME cut.");
        console.log("");
        console.log("Never Replace the 14 Add selectors onto an old facet. That cut does NOT");
        console.log("revert - replaceFunctions only checks the target facet is a DIFFERENT address");
        console.log("that has SOME code, never that it implements the selector. It succeeds, loupe");
        console.log("reports the selector mounted, and every call to it reverts with empty");
        console.log("returndata. Silent and invisible to facet-level monitoring. Remove is the");
        console.log("only correct action for them. Same warning: docs/RUNBOOK-dispute-settlement.md.");
        console.log("  <old FactoryFacet>         =", oldFactory);
        console.log("  <old ArbiterRegistryFacet> =", oldArbiter);
        console.log("  <old JobBoardFacet>        =", oldJobBoard);
        console.log("  <old ServiceBoardFacet>    =", oldService);
        console.log("  <old RegistryFacet>        =", oldRegistry);
        console.log("  <old DealMetadataFacet>    =", oldMeta);
    }

    // ════════════════════════════════════════════════════════════════════
    // Pre/post-flight helpers
    // ════════════════════════════════════════════════════════════════════

    /// Проверяет, что каждый селектор группы смонтирован (иначе Replace
    /// ревертит "selector not exist" в DiamondCutLib.replaceFunctions), и что
    /// все они указывают на ОДИН и тот же текущий адрес — если это не так,
    /// список Replace для этого фасета выведен неверно (например, часть
    /// функций уже переехала на другой фасет). Возвращает этот адрес.
    function _checkReplaceGroup(string memory label, bytes4[] memory sels, address diamond)
        internal view returns (address facetAddr)
    {
        require(sels.length > 0, string.concat(label, ": replace group is empty"));
        facetAddr = IDiamondLoupe(diamond).facetAddress(sels[0]);
        require(facetAddr != address(0), string.concat(label, ": selector[0] is not mounted at all"));
        for (uint256 i = 0; i < sels.length; i++) {
            address a = IDiamondLoupe(diamond).facetAddress(sels[i]);
            require(a != address(0), string.concat(label, ": a replace selector is not mounted"));
            require(a == facetAddr, string.concat(label, ": replace selectors are split across more than one live facet address"));
        }
        console.log(string.concat(label, " currently mounted at:"), facetAddr);
        console.log(string.concat(label, " selectors to Replace:"), sels.length);
    }

    /// Проверяет, что ни один селектор группы ещё не смонтирован — иначе Add
    /// ревертит "selector exists" в DiamondCutLib.addFunctions.
    function _checkAddGroup(string memory label, bytes4[] memory sels, address diamond) internal view {
        for (uint256 i = 0; i < sels.length; i++) {
            require(
                IDiamondLoupe(diamond).facetAddress(sels[i]) == address(0),
                string.concat(label, ": an Add selector is already mounted somewhere - Add would revert")
            );
        }
        console.log(string.concat(label, " selectors to Add (currently unmounted):"), sels.length);
    }

    function _assertRouted(string memory label, bytes4[] memory sels, address expected, address diamond) internal view {
        for (uint256 i = 0; i < sels.length; i++) {
            require(
                IDiamondLoupe(diamond).facetAddress(sels[i]) == expected,
                string.concat(label, ": a selector did not land on the new facet")
            );
        }
        console.log(string.concat(label, " -> "), expected);
    }

    function _totalRoutedSelectors(address diamond) internal view returns (uint256 total) {
        IDiamondLoupe.Facet[] memory all = IDiamondLoupe(diamond).facets();
        for (uint256 i = 0; i < all.length; i++) total += all[i].functionSelectors.length;
    }

    /// Читает `FactoryStorage.Layout.feeFloor` напрямую из хранилища диамонда,
    /// потому что getFeeFloor() (как и getFeeBps()/getMaxPendingRequests())
    /// сам является одним из 14 Add-селекторов этого скрипта — до броадкаста
    /// его физически нечем вызвать, `Diamond: function not found`.
    ///
    /// Смещение внутри FactoryStorage.Layout (10 полей до feeFloor, с учётом
    /// packing):
    ///   +0 usdc, +1 feeRecipient, +2 regionFee (mapping — резервирует слот
    ///   целиком), +3 trustedForwarder, +4 diamond+paused (packed вместе, т.к.
    ///   20+1 <= 32 байт), +5 protocolArbiter, +6 arbitrationThreshold,
    ///   +7 agreementDeployer, +8 feeBps, +9 feeFloor, +10 maxPendingRequests.
    /// Раскладка append-only (script/check-storage-structs.sh это гейтит), то
    /// есть смещение +9 стабильно навсегда, а не только сегодня — новые поля
    /// дописываются СТРОГО в конец, существующие никогда не сдвигаются.
    ///
    /// public, а не internal, по той же причине, что buildFeeModelCuts выше:
    /// test/UpgradeFeeModelSelectors.t.sol зовёт ИМЕННО ЭТУ функцию против
    /// локального диамонда, где feeFloor выставлен через getFeeFloor()/
    /// setFeeFloor(), то есть через настоящую раскладку. Если смещение
    /// разъедется — красным станет тест про апгрейд, а не только
    /// BoardsFixture._unconfigureFeeModel.
    function readFeeFloorRaw(address diamond) public view returns (uint256) {
        bytes32 base = FactoryStorage.FACTORY_STORAGE_POSITION;
        bytes32 slot = bytes32(uint256(base) + FEE_FLOOR_SLOT_OFFSET);
        return uint256(vm.load(diamond, slot));
    }

    // ════════════════════════════════════════════════════════════════════
    // FacetCut[] builder — вынесено в public pure, чтобы
    // test/UpgradeFeeModelSelectors.t.sol мог сверить выход с живыми ABI без
    // повторного запуска скрипта. run() выше строит cuts ровно через эту
    // функцию, ничего не дублирует руками.
    // ════════════════════════════════════════════════════════════════════

    function buildFeeModelCuts(
        address factoryAddr,
        address arbiterAddr,
        address jobBoardAddr,
        address serviceBoardAddr,
        address registryAddr,
        address dealMetaAddr
    ) public pure returns (IDiamondCut.FacetCut[] memory cuts) {
        cuts = new IDiamondCut.FacetCut[](10);
        cuts[0] = _cut(factoryAddr,      IDiamondCut.FacetCutAction.Replace, factoryFacetReplaceSelectors());
        cuts[1] = _cut(factoryAddr,      IDiamondCut.FacetCutAction.Add,     factoryFacetAddSelectors());
        cuts[2] = _cut(arbiterAddr,      IDiamondCut.FacetCutAction.Replace, arbiterRegistryFacetReplaceSelectors());
        cuts[3] = _cut(arbiterAddr,      IDiamondCut.FacetCutAction.Add,     arbiterRegistryFacetAddSelectors());
        cuts[4] = _cut(jobBoardAddr,     IDiamondCut.FacetCutAction.Replace, jobBoardFacetReplaceSelectors());
        cuts[5] = _cut(jobBoardAddr,     IDiamondCut.FacetCutAction.Add,     jobBoardFacetAddSelectors());
        cuts[6] = _cut(serviceBoardAddr, IDiamondCut.FacetCutAction.Replace, serviceBoardFacetReplaceSelectors());
        cuts[7] = _cut(serviceBoardAddr, IDiamondCut.FacetCutAction.Add,     serviceBoardFacetAddSelectors());
        cuts[8] = _cut(registryAddr,     IDiamondCut.FacetCutAction.Replace, registryFacetReplaceSelectors());
        cuts[9] = _cut(dealMetaAddr,     IDiamondCut.FacetCutAction.Replace, dealMetadataFacetReplaceSelectors());
    }

    // ── Per-facet selector arrays (ground truth: `forge inspect <Facet> methodIdentifiers`) ──
    // Split Replace (already on chain today) vs. Add (the 14 new selectors),
    // per the table verified against facets() on the live diamond.

    // FactoryFacet — 13 Replace (unchanged signatures) + 8 Add (fee model)
    function factoryFacetReplaceSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](13);
        sels[0]  = FactoryFacet.initFactory.selector;
        sels[1]  = FactoryFacet.deployAgreement.selector;
        sels[2]  = FactoryFacet.deployAndFund.selector;
        sels[3]  = FactoryFacet.setRegionFee.selector;
        sels[4]  = FactoryFacet.setFeeRecipient.selector;
        sels[5]  = FactoryFacet.setTrustedForwarder.selector;
        sels[6]  = FactoryFacet.setAgreementDeployer.selector;
        sels[7]  = FactoryFacet.getRegionFee.selector;
        sels[8]  = FactoryFacet.getAllFees.selector;
        sels[9]  = FactoryFacet.getFeeRecipient.selector;
        sels[10] = FactoryFacet.getTrustedForwarder.selector;
        sels[11] = FactoryFacet.getUsdc.selector;
        sels[12] = FactoryFacet.getAgreementDeployer.selector;
    }

    function factoryFacetAddSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](8);
        sels[0] = FactoryFacet.setFeeBps.selector;
        sels[1] = FactoryFacet.setFeeFloor.selector;
        sels[2] = FactoryFacet.setMaxPendingRequests.selector;
        sels[3] = FactoryFacet.quoteFee.selector;
        sels[4] = FactoryFacet.getFeeBps.selector;
        sels[5] = FactoryFacet.getFeeFloor.selector;
        sels[6] = FactoryFacet.getMaxPendingRequests.selector;
        sels[7] = FactoryFacet.initFeeModel.selector;
    }

    // ArbiterRegistryFacet — 44 Replace (unchanged) + 3 Add (dispute fee ledger)
    function arbiterRegistryFacetReplaceSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](44);
        sels[0]  = ArbiterRegistryFacet.activateDAO.selector;
        sels[1]  = ArbiterRegistryFacet.applyAsArbiter.selector;
        sels[2]  = ArbiterRegistryFacet.resignAsArbiter.selector;
        sels[3]  = ArbiterRegistryFacet.setChiefArbiter.selector;
        sels[4]  = ArbiterRegistryFacet.addArbiter.selector;
        sels[5]  = bytes4(0x3487e08c) /* removeArbiter(address), удалена 15 августа 2026 (задача 6 arbiter-accountability) */;
        sels[6]  = ArbiterRegistryFacet.commitDisputeClaim.selector;
        sels[7]  = bytes4(keccak256("claimDispute(address,bytes32)")) /* frozen: old 2-arg selector, historical cut */;
        sels[8]  = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        sels[9]  = ArbiterRegistryFacet.clearDisputeClaim.selector;
        sels[10] = ArbiterRegistryFacet.submitVerdict.selector;
        sels[11] = ArbiterRegistryFacet.finalizeVerdict.selector;
        sels[12] = ArbiterRegistryFacet.overturnVerdict.selector;
        sels[13] = ArbiterRegistryFacet.notifyArbiterTimeout.selector;
        sels[14] = ArbiterRegistryFacet.freezeVerdict.selector;
        sels[15] = ArbiterRegistryFacet.unfreezeVerdict.selector;
        sels[16] = ArbiterRegistryFacet.clearStuckVerdict.selector;
        sels[17] = ArbiterRegistryFacet.raiseAppeal.selector;
        sels[18] = ArbiterRegistryFacet.voteOnAppeal.selector;
        sels[19] = ArbiterRegistryFacet.resolveAppeal.selector;
        sels[20] = ArbiterRegistryFacet.withdrawArbiterReward.selector;
        sels[21] = ArbiterRegistryFacet.fundVault.selector;
        sels[22] = ArbiterRegistryFacet.setRewardPerDispute.selector;
        sels[23] = ArbiterRegistryFacet.setDAOAddress.selector;
        sels[24] = ArbiterRegistryFacet.isDaoActive.selector;
        sels[25] = ArbiterRegistryFacet.getMinXPToRegister.selector;
        sels[26] = ArbiterRegistryFacet.getDaoThreshold.selector;
        sels[27] = ArbiterRegistryFacet.getChiefArbiter.selector;
        sels[28] = ArbiterRegistryFacet.isRegisteredArbiter.selector;
        sels[29] = ArbiterRegistryFacet.getArbiters.selector;
        sels[30] = ArbiterRegistryFacet.getDisputeClaimer.selector;
        sels[31] = ArbiterRegistryFacet.getArbiterDeals.selector;
        sels[32] = ArbiterRegistryFacet.getClaimCommitment.selector;
        sels[33] = ArbiterRegistryFacet.getPendingVerdict.selector;
        sels[34] = ArbiterRegistryFacet.getArbiterReward.selector;
        sels[35] = ArbiterRegistryFacet.getVaultBalance.selector;
        sels[36] = ArbiterRegistryFacet.getRewardPerDispute.selector;
        sels[37] = ArbiterRegistryFacet.getDAOAddress.selector;
        sels[38] = ArbiterRegistryFacet.getArbiterMistakeStreak.selector;
        sels[39] = ArbiterRegistryFacet.hasSubmittedVerdict.selector;
        sels[40] = ArbiterRegistryFacet.getAppealVotes.selector;
        sels[41] = ArbiterRegistryFacet.hasVotedOnAppeal.selector;
        sels[42] = ArbiterRegistryFacet.getArbiterBond.selector;
        sels[43] = ArbiterRegistryFacet.getOpenClaimCount.selector;
    }

    function arbiterRegistryFacetAddSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](3);
        sels[0] = ArbiterRegistryFacet.creditDisputeFee.selector;
        sels[1] = ArbiterRegistryFacet.withdrawTreasurySlice.selector;
        sels[2] = ArbiterRegistryFacet.getTreasurySlice.selector;
    }

    // JobBoardFacet — 12 Replace (unchanged) + 1 Add (fee-held getter)
    function jobBoardFacetReplaceSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](12);
        sels[0]  = JobBoardFacet.mintJobWithPermit.selector;
        sels[1]  = JobBoardFacet.mintJob.selector;
        sels[2]  = JobBoardFacet.applyForJob.selector;
        sels[3]  = JobBoardFacet.withdrawApplication.selector;
        sels[4]  = JobBoardFacet.acceptApplicant.selector;
        sels[5]  = JobBoardFacet.cancelJob.selector;
        sels[6]  = JobBoardFacet.editJob.selector;
        sels[7]  = JobBoardFacet.getJob.selector;
        sels[8]  = JobBoardFacet.getClientJobs.selector;
        sels[9]  = JobBoardFacet.getApplicants.selector;
        sels[10] = JobBoardFacet.totalJobs.selector;
        sels[11] = JobBoardFacet.getOpenJobs.selector;
    }

    function jobBoardFacetAddSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](1);
        sels[0] = JobBoardFacet.getJobFeeHeld.selector;
    }

    // ServiceBoardFacet — 23 Replace (unchanged) + 2 Add (fee-held + pending count)
    function serviceBoardFacetReplaceSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](23);
        sels[0]  = ServiceBoardFacet.mintService.selector;
        sels[1]  = ServiceBoardFacet.mintServiceWithPermit.selector;
        sels[2]  = ServiceBoardFacet.removeService.selector;
        sels[3]  = ServiceBoardFacet.pauseService.selector;
        sels[4]  = ServiceBoardFacet.unpauseService.selector;
        sels[5]  = ServiceBoardFacet.editService.selector;
        sels[6]  = ServiceBoardFacet.requestService.selector;
        sels[7]  = ServiceBoardFacet.requestServiceWithPermit.selector;
        sels[8]  = ServiceBoardFacet.acceptRequest.selector;
        sels[9]  = ServiceBoardFacet.rejectRequest.selector;
        sels[10] = ServiceBoardFacet.cancelRequest.selector;
        sels[11] = ServiceBoardFacet.getService.selector;
        sels[12] = ServiceBoardFacet.getExecutorServices.selector;
        sels[13] = ServiceBoardFacet.getServiceClients.selector;
        sels[14] = ServiceBoardFacet.totalServices.selector;
        sels[15] = ServiceBoardFacet.getRequest.selector;
        sels[16] = ServiceBoardFacet.getServiceRequests.selector;
        sels[17] = ServiceBoardFacet.getClientRequests.selector;
        sels[18] = ServiceBoardFacet.totalRequests.selector;
        sels[19] = ServiceBoardFacet.getRequestFunds.selector;
        sels[20] = ServiceBoardFacet.getActiveServices.selector;
        sels[21] = ServiceBoardFacet.getPendingRequests.selector;
        sels[22] = ServiceBoardFacet.getPendingRequestIdsByClientAndExecutor.selector;
    }

    function serviceBoardFacetAddSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](2);
        sels[0] = ServiceBoardFacet.getRequestFeeHeld.selector;
        sels[1] = ServiceBoardFacet.getPendingRequestCount.selector;
    }

    // RegistryFacet — 13 Replace, 0 Add (error rename only, ABI unchanged)
    function registryFacetReplaceSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](13);
        sels[0]  = RegistryFacet.initRegistry.selector;
        sels[1]  = RegistryFacet.register.selector;
        sels[2]  = RegistryFacet.updateStatus.selector;
        sels[3]  = RegistryFacet.setAuthorizedFactory.selector;
        sels[4]  = RegistryFacet.hasActivePair.selector;
        sels[5]  = RegistryFacet.getActivePair.selector;
        sels[6]  = RegistryFacet.getRecord.selector;
        sels[7]  = RegistryFacet.getByClient.selector;
        sels[8]  = RegistryFacet.getByExecutor.selector;
        sels[9]  = RegistryFacet.getActive.selector;
        sels[10] = RegistryFacet.getDisputed.selector;
        sels[11] = RegistryFacet.totalAgreements.selector;
        sels[12] = RegistryFacet.authorizedFactory.selector;
    }

    function registryFacetAddSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](0);
    }

    // DealMetadataFacet — 1 Replace, 0 Add (domain fix in SVG only)
    function dealMetadataFacetReplaceSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](1);
        sels[0] = DealMetadataFacet.getDealTokenURI.selector;
    }

    function dealMetadataFacetAddSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](0);
    }

    function _cut(address facet, IDiamondCut.FacetCutAction action, bytes4[] memory sels)
        internal pure returns (IDiamondCut.FacetCut memory)
    {
        return IDiamondCut.FacetCut({ facetAddress: facet, action: action, functionSelectors: sels });
    }
}
