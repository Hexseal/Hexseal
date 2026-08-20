// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// HEXSEAL — DeployFull.s.sol
// Полный деплой с нуля: Diamond + все фасеты + SVGRenderer + init.
// Хранилище — ERC-7201 (namespaced slots): каждый фасет держит свой слот через
// keccak256(abi.encode(uint256(keccak256("hexseal.<name>.storage")) - 1)) & ~bytes32(uint256(0xff)),
// см. test/StorageLayout.t.sol.
//
// Регенерирован 2026-07-25 из живых ABI (`forge inspect <Facet> methodIdentifiers`)
// после ~40 инкрементальных апгрейдов, которые этот файл не отслеживал. Все 200
// селекторов 12 фасетов проверены против test/DeployFullSelectors.t.sol — тот тест
// падает, если этот файл и живые ABI разойдутся снова. Число здесь — сумма
// литералов `new bytes4[](n)` в билдерах ниже; оно уже тринадцатикратно протухало (стояло
// 148, когда фабрика выросла с 13 до 20; затем 159, до порога и котировки
// платного вызова арбитра; затем 162 — цифру не поправили в том же коммите,
// где код вырос до 167, 31 июля 2026; затем 167, когда 9 августа 2026 добавился
// getArbiterChatKeys; затем 168, когда в тот же день добавился setArbiterChatKey;
// затем 169, когда 14 августа 2026 приехали восемь функций 4в-2 Выкатки 2;
// затем 177, когда 15 августа 2026 приехали getSeatedBy/getSeatedCountBy —
// провенанс посадки арбитра, задача 1 плана arbiter-accountability; затем 180,
// когда следом же 15 августа 2026 приехал getChiefBloc — потолок запаса
// директора, задача 2 того же плана; затем 181, когда в тот же день приехал
// getMaxClaimsPerArbiter — потолок споров в руках, задача 3 того же плана;
// затем 187, когда в тот же день ArbiterRegistryFacet упёрся в 86.4% лимита
// EIP-170 и приостановка арбитра переехала в двенадцатый фасет,
// ArbiterAccountabilityFacet — задача 4 того же плана, шесть новых
// селекторов; затем 186, в тот же день, когда задача 5 сняла
// getChiefArbiterAddress из ArbiterAccountabilityFacet (дублировала
// ArbiterRegistryFacet.getChiefArbiter, обоснование в брифе задачи 4 было
// ошибкой автора плана — через прокси-даймонд оба селектора шли на один
// адрес); затем снова 187, тем же коммитом задачи 5, когда в ArbiterRegistryFacet
// приехал getCleanVerdicts — счётчик неперевёрнутых финализированных
// вердиктов, задел под будущую конвертацию «залог плюс судейский стаж» при
// включении ДАО; затем 192, в тот же день, задача 6 того же плана: снос по
// поводу — removeArbiter снята с ArbiterRegistryFacet (−1), getMaxArbiterMistakes
// добавлен туда же (+1, читает тот же порог с другой стороны), а
// ArbiterAccountabilityFacet получил removeArbiterForCause, getMistakeThreshold
// и три тестовых геттера лёгкого стенда (+5) — заодно addArbiter/setChiefArbiter
// стали ревертить при активном ДАО (дословное решение владельца «никаких
// ручных»), без изменения числа селекторов; затем 191, в тот же день, круг
// правок 1 ревью задачи 6: три тестовых геттера-дубля
// (isRegisteredArbiterHere/getMistakeStreakOf/getNoResponseAtHere — ровно
// тот дефект, что getChiefArbiterAddress в задаче 5) сняты с
// ArbiterAccountabilityFacet, взамен добавлены два геттера СОБСТВЕННЫХ
// констант (getMaxArbiterMistakesMirror, getDaoThresholdMirror — не дубли,
// у ArbiterRegistryFacet таких чисел под этими именами нет), 9 против
// прежних 10, ArbiterRegistryFacet без изменений), поэтому сверяется тем же
// тестом; затем 196, в тот же день, задача 7 того же плана: предложение
// директора — снос остаётся правом владельца (либо daoAddress после
// передачи), директор только сигнализирует своим адресом.
// ArbiterAccountabilityFacet получил proposeRemoval, withdrawProposal,
// hasLiveProposal, getRemovalProposal и getProposalTTL (+5, 14 против
// прежних 9), ArbiterRegistryFacet без изменений (новое поле
// removalProposals — только раскладка хранилища, не селектор); затем 198, в
// тот же день, задача 8 того же плана: право ответа снятого — обвинение
// против настоящего адреса лежит в цепи вечно, respondToRemoval даёт снятому
// арбитру положить рядом СВОЙ отпечаток, не отменяя и не возвращая ничего.
// ArbiterAccountabilityFacet получил respondToRemoval и getRemovalReply (+2,
// 16 против прежних 14) — она же первая гейслесс-функция фасета, потребовала
// собственный _msgSender() (см. script/gasless-sender.allow); новые поля
// removalReply/removedAt — только раскладка хранилища, не селекторы; затем
// 199, в тот же день, задача 9 того же плана: getArbiterStanding — всё
// положение арбитра одним чтением вместо семи-восьми отдельных запросов,
// между которыми проходят блоки и картинка расходится сама с собой.
// ArbiterAccountabilityFacet получил один селектор (+1, 17 против прежних
// 16); набор полей шире брифа задачи — за время работы над планом в
// хранилище появились cleanVerdicts и removedAt, которых бриф не знал, оба
// добавлены в возврат функции, плюс hasLiveRemovalProposal (вызовом
// hasLiveProposal, не копией формулы) — новых полей хранилища задача не
// потребовала, ArbiterRegistryFacet без изменений. Число 199 задачей 4.5
// (16 августа 2026) НЕ сдвинулось и сдвинуться не могло: она ПЕРЕЛОЖИЛА
// четырнадцать чтений из ArbiterRegistryFacet в ArbiterAccountabilityFacet
// (69 → 55 и 17 → 31), не добавив и не убрав ни одного селектора. Повод —
// потолок EIP-170: реестр стоял на 24 516 из 24 576, свободно 60 байт, и
// задача 5 в него не помещалась; после переноса 23 238, запас 1 338.
// Затем 200, 17 августа 2026, задача 1 плана removal-due-process: причина
// СЛОВАМИ. `Cause` — числовой код, и публичная запись о сносе не содержала ни
// одного слова; «снос с поводом» обещал объяснение, которого не было нигде.
// ArbiterAccountabilityFacet получил getMaxReasonBytes (+1, 32 против прежних
// 31) — потолок слов в БАЙТАХ, чтобы форма спрашивала его у цепи, а не хранила
// копию. Три уже перечисленных входа сменили ПОДПИСЬ, не прибавив селекторов
// в этом файле (removeArbiterForCause/proposeRemoval получили `string reason`,
// respondToRemoval — `string reply`): здесь селекторы берутся от типа. В цепи
// это Replace трёх старых селекторов, а не Add — состав разреза в
// script/UpgradeArbiterAccountability.s.sol. Новых полей хранилища задача не
// потребовала: слова живут в СОБЫТИЯХ (RemovalReasonGiven/RemovalReplyGiven),
// их читатель — лента и карточка, а хранилище стоило бы дороже и двигало бы
// раскладку зря.
// Пересчитать, не полагаясь на глаз:
//   grep -o "new bytes4\[\]([0-9]*)" script/DeployFull.s.sol \
//     | sed 's/.*(\([0-9]*\))/\1/' | awk '{s+=$1} END {print s}'
//
// Требует ДО запуска:
//   TRUSTED_FORWARDER — уже задеплоенный MinimalForwarder (script/DeployForwarder.s.sol),
//                        должен реально существовать на цепи (код проверяется).
//   USDC_ADDRESS       — должен реально существовать на цепи (код проверяется);
//                        по умолчанию — тестовый USDC Base Sepolia.
//   FEE_RECIPIENT      — ненулевой; без него платформенные комиссии молча ушли
//                        бы на deployer-ключ.
//   INITIAL_ARBITER    — ненулевой; без единого арбитра ни один спор нельзя
//                        закрыть иначе как таймаутом-рефандом клиенту на 100%
//                        (applyAsArbiter требует DAO-режим, которого на свежем
//                        деплое ещё нет, а addArbiter — onlyOwnerOrChief).
// Все четыре проверяются до единого вызова vm.startBroadcast — дешевле споткнуться
// сразу, чем после того как скрипт уже задеплоил двенадцать имплементаций и Diamond.

import "forge-std/Script.sol";
import "forge-std/console.sol";

import "../src/DiamondProxy.sol";
import "../src/RegistryFacet.sol";
import "../src/FactoryFacet.sol";
import "../src/AgreementDeployer.sol";
import "../src/facets/JobBoardFacet.sol";
import "../src/facets/ServiceBoardFacet.sol";
import "../src/facets/ArbiterRegistryFacet.sol";
import "../src/facets/ArbiterAccountabilityFacet.sol";
import "../src/facets/DealMetadataFacet.sol";
import "../src/facets/ReputationFacet.sol";
import "../src/JobReceiptFacet.sol";
import "../src/SVGRenderer.sol";

contract DeployFull is Script {

    function run() external {
        address usdc             = vm.envOr("USDC_ADDRESS",      address(0x036CbD53842c5426634e7929541eC2318f3dCF7e));
        address feeRecipient     = vm.envOr("FEE_RECIPIENT",     address(0));
        address trustedForwarder = vm.envOr("TRUSTED_FORWARDER", address(0));
        address initialArbiter   = vm.envOr("INITIAL_ARBITER",   address(0));
        uint256 deployerKey      = vm.envUint("PRIVATE_KEY");
        address owner            = vm.addr(deployerKey);

        // ── Pre-flight checks — все ДО единого деплоя ────────────────────────
        // Дешевле споткнуться здесь, чем после того как скрипт уже сжёг газ на
        // двенадцать имплементаций и сам Diamond.

        // initFactory() ревертит FactoryZeroAddress() на нулевом forwarder-е — та же
        // проверка здесь просто дешевле по месту.
        require(
            trustedForwarder != address(0),
            "DeployFull: TRUSTED_FORWARDER is zero - deploy MinimalForwarder first (script/DeployForwarder.s.sol) and export TRUSTED_FORWARDER"
        );
        // Не только ненулевой, но и реально существующий на этой цепи. Устаревший
        // или опечатанный адрес молча проходит проверку на ноль и задеплоил бы
        // диамонд с mis-wired gasless-путём, который сломается только при первом
        // реальном relay — не при деплое.
        require(
            trustedForwarder.code.length > 0,
            "DeployFull: TRUSTED_FORWARDER has no code on this chain"
        );

        // Тот же класс риска, что и forwarder: USDC_ADDRESS по умолчанию —
        // захардкоженный адрес Base Sepolia. Деплой не на ту цепь тихо привяжет
        // несуществующий токен, и каждая сделка будет ревертить на первом же
        // transferFrom — а не на деплое, где это дёшево поймать.
        require(usdc.code.length > 0, "DeployFull: USDC_ADDRESS has no code on this chain");

        // Раньше при отсутствующем FEE_RECIPIENT комиссии молча утекали на
        // deployer-ключ (owner). На живом диаманде это два РАЗНЫХ адреса —
        // такой фолбэк здесь был бы неверной конфигурацией, которая выглядит
        // как успешный деплой.
        require(
            feeRecipient != address(0),
            "DeployFull: FEE_RECIPIENT is zero - platform fees would silently route to the deployer key"
        );

        // Без этого диамонд стартует с ПУСТЫМ реестром арбитров: applyAsArbiter()
        // требует isDaoActive() (uniqueActiveUsers >= 100k ИЛИ owner.activateDAO()) —
        // ни то ни другое не истинно на свежем деплое, а addArbiter — onlyOwnerOrChief,
        // chiefArbiter тоже нулевой. Без единого арбитра commitDisputeClaim/
        // claimDispute ревертят NotArbiter() для всех, и triggerArbiterTimeout()
        // после 4-дневного окна становится единственным терминальным исходом спора —
        // 100% рефанд клиенту. В сочетании с raiseDispute() это безусловный "undo"
        // на любую уже поставленную работу.
        require(
            initialArbiter != address(0),
            "DeployFull: INITIAL_ARBITER is zero - a diamond with no arbiter resolves every dispute as a client refund"
        );

        vm.startBroadcast(deployerKey);

        // ── 1. Деплой всех имплементаций ─────────────────────────────────────
        DiamondCutFacet        cutFacet     = new DiamondCutFacet();
        DiamondLoupeFacet      loupeFacet   = new DiamondLoupeFacet();
        OwnershipFacet         ownFacet     = new OwnershipFacet();
        RegistryFacet          regFacet     = new RegistryFacet();
        FactoryFacet           facFacet     = new FactoryFacet();
        JobBoardFacet          jobBoard     = new JobBoardFacet();
        ServiceBoardFacet      serviceBoard = new ServiceBoardFacet();
        ArbiterRegistryFacet   arbiterFacet = new ArbiterRegistryFacet();
        ArbiterAccountabilityFacet accFacet = new ArbiterAccountabilityFacet();
        DealMetadataFacet      metaFacet    = new DealMetadataFacet();
        JobReceiptFacet        receiptFacet = new JobReceiptFacet();
        ReputationFacet        repFacet     = new ReputationFacet();
        SVGRenderer            svgRenderer  = new SVGRenderer();

        console.log("--- Implementations ---");
        console.log("DiamondCutFacet:      ", address(cutFacet));
        console.log("DiamondLoupeFacet:    ", address(loupeFacet));
        console.log("OwnershipFacet:       ", address(ownFacet));
        console.log("RegistryFacet:        ", address(regFacet));
        console.log("FactoryFacet:         ", address(facFacet));
        console.log("JobBoardFacet:        ", address(jobBoard));
        console.log("ServiceBoardFacet:    ", address(serviceBoard));
        console.log("ArbiterRegistryFacet: ", address(arbiterFacet));
        console.log("ArbiterAccountabilityFacet:", address(accFacet));
        console.log("DealMetadataFacet:    ", address(metaFacet));
        console.log("JobReceiptFacet:      ", address(receiptFacet));
        console.log("ReputationFacet:      ", address(repFacet));
        console.log("SVGRenderer:          ", address(svgRenderer));

        // ── 2. Базовые фасеты для конструктора Diamond ────────────────────────
        // (DiamondCut, DiamondLoupe, Ownership, Registry, Factory)
        // supportsInterface здесь от DiamondLoupeFacet — так и остаётся, ERC-721
        // интерфейсы для receipt-NFT регистрируются в маппинге конструктором Diamond
        IDiamondCut.FacetCut[] memory initCuts = buildInitCuts(
            address(cutFacet), address(loupeFacet), address(ownFacet), address(regFacet), address(facFacet)
        );

        // ── 3. Деплой Diamond ─────────────────────────────────────────────────
        DiamondProxy diamond = new DiamondProxy(owner, initCuts, address(0), "");
        console.log("--- Diamond ---");
        console.log("DiamondProxy:         ", address(diamond));

        // Agreement разворачивается ОДИН раз как контракт-реализация; на сделку
        // создаётся 45-байтовый клон EIP-1167. Конструктор запирает реализацию,
        // поэтому проинициализировать её саму нельзя.
        Agreement          agreementImpl = new Agreement();
        console.log("Agreement impl:       ", address(agreementImpl));

        // AgreementDeployer needs Diamond as authorizedCaller — deploy after Diamond is known
        AgreementDeployer  agDeployer     = new AgreementDeployer(address(diamond), address(agreementImpl));
        console.log("AgreementDeployer:    ", address(agDeployer));

        // ── 4. Инициализация Registry + Factory ──────────────────────────────
        RegistryFacet(address(diamond)).initRegistry(address(diamond));
        FactoryFacet(address(diamond)).initFactory(
            usdc,
            feeRecipient,
            trustedForwarder,
            address(diamond),
            address(agDeployer)
        );

        // ── 5. Добавляем остальные фасеты одним diamondCut ───────────────────
        // Порядок: JobBoard, ServiceBoard, ArbiterRegistry,
        //          ArbiterAccountability, DealMetadata, JobReceiptFacet,
        //          ReputationFacet
        IDiamondCut.FacetCut[] memory cuts2 = buildRemainingCuts(
            address(jobBoard),
            address(serviceBoard),
            address(arbiterFacet),
            address(accFacet),
            address(metaFacet),
            address(receiptFacet),
            address(repFacet)
        );

        IDiamondCut(address(diamond)).diamondCut(cuts2, address(0), "");

        // ── 6. Линкуем SVGRenderer ────────────────────────────────────────────
        JobReceiptFacet(address(diamond)).setSvgRenderer(address(svgRenderer));

        // ── 7. Первый арбитр ──────────────────────────────────────────────────
        // Без этого раунд споров невозможно закрыть иначе как таймаутом-рефандом
        // клиенту (см. пояснение у require(initialArbiter != address(0)) выше).
        // chiefArbiter НЕ выставляется — на живом диаманде он остаётся нулевым.
        ArbiterRegistryFacet(address(diamond)).addArbiter(initialArbiter);

        vm.stopBroadcast();

        // ── 8. Итог ───────────────────────────────────────────────────────────
        uint256 feeBps = FactoryFacet(address(diamond)).getFeeBps();
        uint256 feeFloor = FactoryFacet(address(diamond)).getFeeFloor();
        address[] memory arbiters = ArbiterRegistryFacet(address(diamond)).getArbiters();

        console.log("\n======== HEXSEAL DEPLOYMENT COMPLETE ========");
        console.log("DiamondProxy:  ", address(diamond));
        console.log("SVGRenderer:   ", address(svgRenderer));
        console.log("USDC:          ", usdc);
        console.log("FeeRecipient:  ", feeRecipient);
        console.log("Forwarder:     ", trustedForwarder);
        console.log("Owner:         ", owner);
        console.log("Fee bps:       ", feeBps);
        console.log("Fee floor:     ", feeFloor);
        console.log("--- Arbiters ---");
        console.log("Count:         ", arbiters.length);
        for (uint256 i = 0; i < arbiters.length; i++) {
            console.log("  Arbiter:     ", arbiters[i]);
        }
        console.log("=============================================");
        console.log("Update your .env:");
        console.log("DIAMOND_ADDRESS=", address(diamond));
    }

    // ════════════════════════════════════════════════════════════════════════
    // Построение FacetCut[] — вынесено в public pure функции, чтобы
    // test/DeployFullSelectors.t.sol мог сверить их с живыми ABI без
    // повторного запуска деплоя. Единственный источник правды: run() выше
    // строит куты ровно через эти же функции, ничего не дублирует руками.
    // ════════════════════════════════════════════════════════════════════════

    function buildInitCuts(
        address cutFacetAddr,
        address loupeFacetAddr,
        address ownFacetAddr,
        address regFacetAddr,
        address facFacetAddr
    ) public pure returns (IDiamondCut.FacetCut[] memory cuts) {
        cuts = new IDiamondCut.FacetCut[](5);
        cuts[0] = _cut(cutFacetAddr,   IDiamondCut.FacetCutAction.Add, cutFacetSelectors());
        cuts[1] = _cut(loupeFacetAddr, IDiamondCut.FacetCutAction.Add, loupeFacetSelectors());
        cuts[2] = _cut(ownFacetAddr,   IDiamondCut.FacetCutAction.Add, ownershipFacetSelectors());
        cuts[3] = _cut(regFacetAddr,   IDiamondCut.FacetCutAction.Add, registryFacetSelectors());
        cuts[4] = _cut(facFacetAddr,   IDiamondCut.FacetCutAction.Add, factoryFacetSelectors());
    }

    function buildRemainingCuts(
        address jobBoardAddr,
        address serviceBoardAddr,
        address arbiterFacetAddr,
        address accountabilityFacetAddr,
        address metaFacetAddr,
        address receiptFacetAddr,
        address reputationFacetAddr
    ) public pure returns (IDiamondCut.FacetCut[] memory cuts) {
        cuts = new IDiamondCut.FacetCut[](7);
        cuts[0] = _cut(jobBoardAddr,             IDiamondCut.FacetCutAction.Add, jobBoardFacetSelectors());
        cuts[1] = _cut(serviceBoardAddr,         IDiamondCut.FacetCutAction.Add, serviceBoardFacetSelectors());
        cuts[2] = _cut(arbiterFacetAddr,         IDiamondCut.FacetCutAction.Add, arbiterRegistryFacetSelectors());
        cuts[3] = _cut(accountabilityFacetAddr,  IDiamondCut.FacetCutAction.Add, arbiterAccountabilityFacetSelectors());
        cuts[4] = _cut(metaFacetAddr,            IDiamondCut.FacetCutAction.Add, dealMetadataFacetSelectors());
        cuts[5] = _cut(receiptFacetAddr,         IDiamondCut.FacetCutAction.Add, jobReceiptFacetSelectors());
        cuts[6] = _cut(reputationFacetAddr,      IDiamondCut.FacetCutAction.Add, reputationFacetSelectors());
    }

    // ── Per-facet selector arrays (ground truth: `forge inspect <Facet> methodIdentifiers`) ──

    // DiamondCutFacet — 1 селектор
    function cutFacetSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](1);
        sels[0] = IDiamondCut.diamondCut.selector;
    }

    // DiamondLoupeFacet — 5 селекторов
    function loupeFacetSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](5);
        sels[0] = IDiamondLoupe.facets.selector;
        sels[1] = IDiamondLoupe.facetFunctionSelectors.selector;
        sels[2] = IDiamondLoupe.facetAddresses.selector;
        sels[3] = IDiamondLoupe.facetAddress.selector;
        sels[4] = IERC165.supportsInterface.selector;
    }

    // OwnershipFacet — 4 селектора
    function ownershipFacetSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](4);
        sels[0] = OwnershipFacet.transferOwnership.selector;
        sels[1] = OwnershipFacet.owner.selector;
        sels[2] = OwnershipFacet.acceptOwnership.selector;
        sels[3] = OwnershipFacet.pendingOwner.selector;
    }

    // RegistryFacet — 13 селекторов
    function registryFacetSelectors() public pure returns (bytes4[] memory sels) {
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

    // FactoryFacet — 21 селектор (setPaused/isPaused/getProtocolArbiter/setProtocolArbiter/
    // getArbitrationThreshold/setArbitrationThreshold удалены в a95865d — их больше нет в ABI)
    function factoryFacetSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](21);
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
        sels[13] = FactoryFacet.setFeeBps.selector;
        sels[14] = FactoryFacet.setFeeFloor.selector;
        sels[15] = FactoryFacet.setMaxPendingRequests.selector;
        sels[16] = FactoryFacet.quoteFee.selector;
        sels[17] = FactoryFacet.getFeeBps.selector;
        sels[18] = FactoryFacet.getFeeFloor.selector;
        sels[19] = FactoryFacet.getMaxPendingRequests.selector;
        // Одноразовый засев модели комиссии через `_init`/`_calldata` diamondCut'а.
        // На свежем деплое не зовётся (initFactory уже всё выставил), но должен
        // быть смонтирован: апгрейд живого диамонда без него не имеет способа
        // выставить feeFloor той же транзакцией, что и cut.
        sels[20] = FactoryFacet.initFeeModel.selector;
    }

    // JobBoardFacet — 13 селекторов
    function jobBoardFacetSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](13);
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
        sels[12] = JobBoardFacet.getJobFeeHeld.selector;
    }

    // ServiceBoardFacet — 25 селекторов
    function serviceBoardFacetSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](25);
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
        sels[23] = ServiceBoardFacet.getRequestFeeHeld.selector;
        sels[24] = ServiceBoardFacet.getPendingRequestCount.selector;
    }

    // ArbiterRegistryFacet — 55 селекторов
    function arbiterRegistryFacetSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](55);

        // DAO-режим
        sels[0] = ArbiterRegistryFacet.activateDAO.selector;
        sels[1] = ArbiterRegistryFacet.applyAsArbiter.selector;
        sels[2] = ArbiterRegistryFacet.resignAsArbiter.selector;

        // Admin: управление арбитрами
        sels[3] = ArbiterRegistryFacet.setChiefArbiter.selector;
        sels[4] = ArbiterRegistryFacet.addArbiter.selector;

        // Клейм спора (commit-reveal)
        sels[5] = ArbiterRegistryFacet.commitDisputeClaim.selector;
        sels[6] = ArbiterRegistryFacet.claimDispute.selector;
        sels[7] = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        sels[8] = ArbiterRegistryFacet.clearDisputeClaim.selector;

        // Вердикт
        sels[9] = ArbiterRegistryFacet.submitVerdict.selector;
        sels[10] = ArbiterRegistryFacet.finalizeVerdict.selector;
        sels[11] = ArbiterRegistryFacet.overturnVerdict.selector;
        sels[12] = ArbiterRegistryFacet.notifyArbiterTimeout.selector;
        sels[13] = ArbiterRegistryFacet.freezeVerdict.selector;
        sels[14] = ArbiterRegistryFacet.unfreezeVerdict.selector;
        sels[15] = ArbiterRegistryFacet.clearStuckVerdict.selector;

        // Апелляция
        sels[16] = ArbiterRegistryFacet.raiseAppeal.selector;
        sels[17] = ArbiterRegistryFacet.voteOnAppeal.selector;
        sels[18] = ArbiterRegistryFacet.resolveAppeal.selector;

        // Вознаграждения
        sels[19] = ArbiterRegistryFacet.withdrawArbiterReward.selector;
        sels[20] = ArbiterRegistryFacet.fundVault.selector;
        sels[21] = ArbiterRegistryFacet.setRewardPerDispute.selector;
        sels[22] = ArbiterRegistryFacet.setDAOAddress.selector;

        // Views
        sels[23] = ArbiterRegistryFacet.isDaoActive.selector;
        sels[24] = ArbiterRegistryFacet.getMinXPToRegister.selector;
        sels[25] = ArbiterRegistryFacet.getDaoThreshold.selector;
        sels[26] = ArbiterRegistryFacet.getChiefArbiter.selector;
        sels[27] = ArbiterRegistryFacet.isRegisteredArbiter.selector;
        sels[28] = ArbiterRegistryFacet.getArbiters.selector;
        sels[29] = ArbiterRegistryFacet.getDisputeClaimer.selector;
        sels[30] = ArbiterRegistryFacet.getClaimCommitment.selector;
        sels[31] = ArbiterRegistryFacet.getPendingVerdict.selector;
        sels[32] = ArbiterRegistryFacet.getVaultBalance.selector;
        sels[33] = ArbiterRegistryFacet.getRewardPerDispute.selector;
        sels[34] = ArbiterRegistryFacet.getDAOAddress.selector;
        sels[35] = ArbiterRegistryFacet.hasSubmittedVerdict.selector;
        sels[36] = ArbiterRegistryFacet.getAppealVotes.selector;
        sels[37] = ArbiterRegistryFacet.hasVotedOnAppeal.selector;

        // Сбор со спора (3% от спорной суммы, считает Agreement) — 80/20 арбитр/казна
        sels[38] = ArbiterRegistryFacet.creditDisputeFee.selector;
        sels[39] = ArbiterRegistryFacet.withdrawTreasurySlice.selector;
        sels[40] = ArbiterRegistryFacet.getTreasurySlice.selector;

        // Платный вызов арбитра: порог и котировка доплаты до него
        sels[41] = ArbiterRegistryFacet.setArbiterFloor.selector;
        sels[42] = ArbiterRegistryFacet.getArbiterFloor.selector;
        sels[43] = ArbiterRegistryFacet.quoteDisputeTopUp.selector;

        // Платный вызов арбитра: оплата и мягкий возврат доплаты
        sels[44] = ArbiterRegistryFacet.fundDispute.selector;
        sels[45] = ArbiterRegistryFacet.getDisputeBounty.selector;
        sels[46] = ArbiterRegistryFacet.withdrawDisputeBounty.selector;
        sels[47] = ArbiterRegistryFacet.getRefundableBounty.selector;

        // Ключи чата арбитра (4б, 9 августа 2026)
        sels[48] = ArbiterRegistryFacet.setArbiterChatKey.selector;

        // Запись «просил, ответа нет» и отпечаток предъявления
        // (4в-2 Выкатка 2, 14 августа 2026). На живой диамонд эти восемь
        // приезжают разрезом script/UpgradePresentationRecord.s.sol.
        //
        // ⚠️ Здесь остались только ЗАПИСИ плюс геттер константы
        // NO_RESPONSE_FLOOR: пять чтений этой группы (getDisputeClaimedAt,
        // getNoResponseAt, getPresentationDigests/Page/Count) уехали в
        // ArbiterAccountabilityFacet задачей 4.5, 16 августа 2026.
        // getNoResponseFloor не уехала намеренно — она читает приватную
        // константу, которую применяет recordNoResponse в том же файле.
        sels[49] = ArbiterRegistryFacet.recordNoResponse.selector;
        sels[50] = ArbiterRegistryFacet.getNoResponseFloor.selector;
        sels[51] = ArbiterRegistryFacet.recordPresentationDigest.selector;

        // Провенанс посадки (getSeatedBy/getSeatedCountBy) уехал в
        // ArbiterAccountabilityFacet задачей 4.5, 16 августа 2026 — ЗАПИСЬ
        // провенанса (addArbiter, ArbiterRegistryStorage.clearSeat) осталась
        // здесь, уехало только чтение.

        // Потолок запаса директора (arbiter-accountability, задача 2,
        // 15 августа 2026): addArbiter теперь запрещает директору собрать
        // блок размером с кворум апелляции. На живой диамонд приезжает
        // отдельным разрезом апгрейда, не этим скриптом.
        sels[52] = ArbiterRegistryFacet.getChiefBloc.selector;

        // Потолок споров в руках (arbiter-accountability, задача 3,
        // 15 августа 2026): claimDispute отказывает арбитру, который уже
        // держит MAX_CLAIMS_PER_ARBITER открытых споров, — ферма сборов
        // (доход без работы независимо от вердикта) не может расти
        // числом клеймов. На живой диамонд приезжает отдельным разрезом
        // апгрейда, не этим скриптом.
        sels[53] = ArbiterRegistryFacet.getMaxClaimsPerArbiter.selector;

        // Зубы приостановки (arbiter-accountability, задача 5, 15 августа
        // 2026): claimDispute/resignAsArbiter/finalizeVerdict теперь
        // отказывают приостановленному арбитру — это поведение, а не селектор.
        // Счётчик getCleanVerdicts уехал в ArbiterAccountabilityFacet задачей
        // 4.5, 16 августа 2026; пишет его finalizeVerdict здесь.

        // Порог серии судейских ошибок прочитанный с этой стороны
        // (arbiter-accountability, задача 6, 15 августа 2026): совпадает с
        // ArbiterAccountabilityFacet.getMistakeThreshold(), сверяется
        // test_MistakeThresholdMatchesRegistry.
        sels[54] = ArbiterRegistryFacet.getMaxArbiterMistakes.selector;
    }

    // ArbiterAccountabilityFacet — 31 селектор (arbiter-accountability,
    // задача 4, 15 августа 2026, пять; шестой, getChiefArbiterAddress, снят
    // задачей 5 того же дня — см. комментарий ниже; задача 6 того же дня
    // добавила пять (снос с поводом + четыре view), круг правок 1 ревью
    // задачи 6 снял три тестовых геттера-дубля (isRegisteredArbiterHere,
    // getMistakeStreakOf, getNoResponseAtHere — ровно тот дефект, что
    // getChiefArbiterAddress в задаче 5) и добавил два зеркальных геттера
    // констант (getMaxArbiterMistakesMirror, getDaoThresholdMirror) —
    // 10 → 7 → 9; задача 7 того же дня добавила предложение директора
    // (proposeRemoval/withdrawProposal/hasLiveProposal/getRemovalProposal/
    // getProposalTTL, +5 → 14); задача 8 того же дня добавила право ответа
    // снятого (respondToRemoval/getRemovalReply, +2 → 16); задача 9 того же
    // дня добавила getArbiterStanding (+1 → 17) — всё положение арбитра
    // одним чтением (xp, cleanStreak, mistakeStreak, bond, seatedBy,
    // suspendedUntil, openClaims, cleanVerdicts, removedAt,
    // hasLiveRemovalProposal), вместо семи-восьми отдельных запросов,
    // которые могли разойтись между собой на блок. Отдельный фасет,
    // не дописка в ArbiterRegistryFacet: тот занимал 21 227 из 24 576 байт
    // (86.4%), запаса не хватало. Делит тот же ArbiterRegistryStorage
    // namespace — переноса данных нет.
    function arbiterAccountabilityFacetSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](34);
        sels[0] = ArbiterAccountabilityFacet.suspendArbiter.selector;
        sels[1] = ArbiterAccountabilityFacet.liftSuspension.selector;
        sels[2] = ArbiterAccountabilityFacet.isSuspended.selector;
        sels[3] = ArbiterAccountabilityFacet.getSuspendedUntil.selector;
        sels[4] = ArbiterAccountabilityFacet.getSuspensionWindow.selector;
        // getChiefArbiterAddress СНЯТА (задача 5, добавление 2, 15 августа
        // 2026): дублировала ArbiterRegistryFacet.getChiefArbiter() — через
        // прокси-даймонд оба селектора шли на один и тот же адрес, а
        // обоснование «фронту не дёргать второй фасет» было ошибкой автора
        // плана. Настоящая причина её появления — лёгкий тестовый стенд с
        // раздельно развёрнутыми фасетами; test/ArbiterSuspension.t.sol теперь
        // сверяет смещение слота chiefArbiter прямым vm.load, не заводя ради
        // теста постоянный публичный селектор.

        // Снос по поводу (задача 6, 15 августа 2026): три кода цепь проверяет
        // сама, три требуют отпечатка доказательства и помечаются
        // verifiedByChain=false. Право сноса уезжает владельцу вместе с
        // активацией ДАО и передаётся daoAddress — не запирается в пустоту.
        sels[5] = ArbiterAccountabilityFacet.removeArbiterForCause.selector;

        // Зеркальные геттеры констант (круг правок 1 ревью задачи 6):
        // getMistakeThreshold — порог РУЧНОГО сноса (MAX_ARBITER_MISTAKES − 1,
        // строго ниже автоматического — иначе OverturnedVerdicts/Timeouts
        // недостижимы, C-1). getMaxArbiterMistakesMirror/getDaoThresholdMirror
        // — локальные зеркала чисел ArbiterRegistryFacet, нужны тестам, чтобы
        // сверить обе половины связи с боевыми числами, а не только друг с
        // другом. Это НЕ дубли снятых трёх выше: те читали ЖИВОЕ СОСТОЯНИЕ,
        // уже доступное через ArbiterRegistryFacet (тот же дефект, что
        // getChiefArbiterAddress); эти читают СОБСТВЕННЫЕ приватные константы
        // фасета, которые больше ниоткуда не достать.
        sels[6] = ArbiterAccountabilityFacet.getMistakeThreshold.selector;
        sels[7] = ArbiterAccountabilityFacet.getMaxArbiterMistakesMirror.selector;
        sels[8] = ArbiterAccountabilityFacet.getDaoThresholdMirror.selector;

        // Предложение директора (задача 7, 15 августа 2026): снос остаётся
        // необратимым правом владельца (либо daoAddress после передачи) —
        // директор кладёт в цепь только СИГНАЛЬНУЮ запись своим адресом.
        // Исполнение (removeArbiterForCause) removalProposals не читает —
        // владелец обязан передать код повода и отпечаток заново, своими
        // аргументами; единственная связь — очистка предложения при успешном
        // сносе того же арбитра.
        sels[9]  = ArbiterAccountabilityFacet.proposeRemoval.selector;
        sels[10] = ArbiterAccountabilityFacet.withdrawProposal.selector;
        sels[11] = ArbiterAccountabilityFacet.hasLiveProposal.selector;
        sels[12] = ArbiterAccountabilityFacet.getRemovalProposal.selector;
        sels[13] = ArbiterAccountabilityFacet.getProposalTTL.selector;

        // Право ответа обвинённого (задача 8, 15 августа 2026; с 19 августа
        // ответ принимается ещё ВО ВРЕМЯ паузы, а не только после сноса):
        // обвинение против настоящего адреса лежит в цепи вечно,
        // respondToRemoval — ЕДИНСТВЕННАЯ гейслесс-функция этого фасета (зовёт
        // её обвинённый или снятый арбитр, обычный человек), читает
        // отправителя через собственный _msgSender().
        sels[14] = ArbiterAccountabilityFacet.respondToRemoval.selector;
        sels[15] = ArbiterAccountabilityFacet.getRemovalReply.selector;

        // Положение арбитра одним чтением (задача 9, 15 августа 2026): один
        // view вместо семи-восьми отдельных запросов, которые между собой
        // могли разойтись на блок — залог прочитан до сноса, а статус после.
        sels[16] = ArbiterAccountabilityFacet.getArbiterStanding.selector;

        // ── Задача 4.5 (16 августа 2026): ЧЕТЫРНАДЦАТЬ ЧТЕНИЙ ИЗ РЕЕСТРА ──
        // ArbiterRegistryFacet упёрся в потолок EIP-170 (24 516 из 24 576,
        // свободно 60) — задача 5 в него физически не помещалась. Чтения про
        // поведение арбитра, его положение и доказательства переехали сюда;
        // реестр стал 23 238 (запас 1 338), этот фасет — 6 327.
        //
        // ⚠️ ЭТО ПЕРЕНОС, НЕ НОВЫЕ ВХОДЫ. Общее множество селекторов даймонда
        // не изменилось: 86 до и 86 после, побайтно то же множество (у реестра
        // 69 → 55, здесь 17 → 31). Снаружи вызывающий не видит ничего.
        //
        // Поведение и положение арбитра
        sels[17] = ArbiterAccountabilityFacet.getArbiterMistakeStreak.selector;
        sels[18] = ArbiterAccountabilityFacet.getCleanVerdicts.selector;
        sels[19] = ArbiterAccountabilityFacet.getArbiterBond.selector;
        sels[20] = ArbiterAccountabilityFacet.getOpenClaimCount.selector;
        sels[21] = ArbiterAccountabilityFacet.getArbiterReward.selector;
        sels[22] = ArbiterAccountabilityFacet.getArbiterDeals.selector;

        // Провенанс посадки (задача 1 плана, чтение переехало сюда задачей 4.5)
        sels[23] = ArbiterAccountabilityFacet.getSeatedBy.selector;
        sels[24] = ArbiterAccountabilityFacet.getSeatedCountBy.selector;

        // Доказательства: ключи чата, якорь предъявления, запись о молчании,
        // отпечатки (4б и 4в-2; записи остались в реестре)
        sels[25] = ArbiterAccountabilityFacet.getArbiterChatKeys.selector;
        sels[26] = ArbiterAccountabilityFacet.getDisputeClaimedAt.selector;
        sels[27] = ArbiterAccountabilityFacet.getNoResponseAt.selector;
        sels[28] = ArbiterAccountabilityFacet.getPresentationDigests.selector;
        sels[29] = ArbiterAccountabilityFacet.getPresentationDigestCount.selector;
        sels[30] = ArbiterAccountabilityFacet.getPresentationDigestsPage.selector;

        // ── Причина словами (замысел 17 августа 2026, решение 7) ──
        // Потолок слов в БАЙТАХ, спрашивается у цепи. Копия числа во фронте
        // разошлась бы молча и дала бы человеку отказ транзакции вместо
        // подсказки в поле. Той же работой сменились ПОДПИСИ трёх уже
        // перечисленных входов (removeArbiterForCause, proposeRemoval,
        // respondToRemoval получили `string`) — здесь селекторы берутся от
        // типа, поэтому строки выше править не пришлось. В цепи это по-прежнему
        // Add, а не Replace: разрез этого плана ещё не сделан, ни один из трёх
        // старых селекторов в даймонде не смонтирован — сменилось лишь
        // ЗНАЧЕНИЕ селектора внутри Add-группы
        // script/UpgradeArbiterAccountability.s.sol.
        sels[31] = ArbiterAccountabilityFacet.getMaxReasonBytes.selector;

        // ── The 48-hour pause (design of 17 August 2026, decision 2) ──
        // Removal stopped being a single button: it now runs only through a
        // proposal that has sat for REMOVAL_DELAY and is still inside
        // PROPOSAL_TTL, and the cause at execution must match the one proposed.
        // The pause itself is a rule, not a selector; what is mounted here is
        // the READING of it, so the form can say "19 hours to go" and show the
        // button as live at the same second the chain does. A copy of the
        // number in the frontend would drift in silence.
        sels[32] = ArbiterAccountabilityFacet.getRemovalDelay.selector;

        // ── The quiet door leads into the common one (task 12, 18 August 2026) ──
        // The third judicial mistake no longer unseats. It suspends at once and
        // lays a removal proposal in the CHAIN'S OWN NAME; once the 48 hours
        // have passed, anyone may press this — the chain proved the cause
        // itself, so pressing carries no discretion. One argument, and it
        // refuses any accusation a human laid: that one is still the removal
        // authority's to execute through removeArbiterForCause.
        sels[33] = ArbiterAccountabilityFacet.executeChainRemoval.selector;
    }

    // DealMetadataFacet — 1 селектор
    function dealMetadataFacetSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](1);
        sels[0] = DealMetadataFacet.getDealTokenURI.selector;
    }

    // JobReceiptFacet — 21 селектор (ERC-721 + receipt)
    function jobReceiptFacetSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](21);
        sels[0]  = JobReceiptFacet.name.selector;
        sels[1]  = JobReceiptFacet.symbol.selector;
        sels[2]  = JobReceiptFacet.balanceOf.selector;
        sels[3]  = JobReceiptFacet.ownerOf.selector;
        sels[4]  = JobReceiptFacet.tokenURI.selector;
        sels[5]  = JobReceiptFacet.transferFrom.selector;
        sels[6]  = bytes4(0x42842e0e); // safeTransferFrom(address,address,uint256) — overload, .selector ambiguous
        sels[7]  = bytes4(0xb88d4fde); // safeTransferFrom(address,address,uint256,bytes) — overload, .selector ambiguous
        sels[8]  = JobReceiptFacet.approve.selector;
        sels[9]  = JobReceiptFacet.setApprovalForAll.selector;
        sels[10] = JobReceiptFacet.getApproved.selector;
        sels[11] = JobReceiptFacet.isApprovedForAll.selector;
        sels[12] = JobReceiptFacet.mintJobReceipt.selector;
        sels[13] = JobReceiptFacet.burnJobReceipt.selector;
        sels[14] = JobReceiptFacet.setSvgRenderer.selector;
        sels[15] = JobReceiptFacet.getSvgRenderer.selector;
        sels[16] = JobReceiptFacet.getJobReceiptData.selector;
        sels[17] = JobReceiptFacet.isJobReceiptToken.selector;
        sels[18] = JobReceiptFacet.isJobReceiptBurned.selector;
        sels[19] = JobReceiptFacet.getTokenIdByJobId.selector;
        sels[20] = JobReceiptFacet.getReceiptTotalSupply.selector;
    }

    // ReputationFacet — 9 селекторов (Задача 4: getUnresolvedDisputes — счётчик
    // споров, закончившихся без вердикта)
    function reputationFacetSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](9);
        sels[0] = ReputationFacet.autoAwardXP.selector;
        sels[1] = ReputationFacet.claimXP.selector;
        sels[2] = ReputationFacet.notifyExecutorFault.selector;
        sels[3] = ReputationFacet.getXP.selector;
        sels[4] = ReputationFacet.getUniqueActiveUsers.selector;
        sels[5] = ReputationFacet.hasClaimed.selector;
        sels[6] = ReputationFacet.isDealWin.selector;
        sels[7] = ReputationFacet.getCleanStreak.selector;
        sels[8] = ReputationFacet.getUnresolvedDisputes.selector;
    }

    function _cut(address facet, IDiamondCut.FacetCutAction action, bytes4[] memory sels)
        internal pure returns (IDiamondCut.FacetCut memory)
    {
        return IDiamondCut.FacetCut({ facetAddress: facet, action: action, functionSelectors: sels });
    }
}
