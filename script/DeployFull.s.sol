// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// HEXSEAL — DeployFull.s.sol
// Полный деплой с нуля: Diamond + все фасеты + SVGRenderer + init.
// Хранилище — ERC-7201 (namespaced slots): каждый фасет держит свой слот через
// keccak256(abi.encode(uint256(keccak256("hexseal.<name>.storage")) - 1)) & ~bytes32(uint256(0xff)),
// см. test/StorageLayout.t.sol.
//
// Регенерирован 2026-07-25 из живых ABI (`forge inspect <Facet> methodIdentifiers`)
// после ~40 инкрементальных апгрейдов, которые этот файл не отслеживал. Все 177
// селекторов 11 фасетов проверены против test/DeployFullSelectors.t.sol — тот тест
// падает, если этот файл и живые ABI разойдутся снова. Число здесь — сумма
// литералов `new bytes4[](n)` в билдерах ниже; оно уже шестикратно протухало (стояло
// 148, когда фабрика выросла с 13 до 20; затем 159, до порога и котировки
// платного вызова арбитра; затем 162 — цифру не поправили в том же коммите,
// где код вырос до 167, 31 июля 2026; затем 167, когда 9 августа 2026 добавился
// getArbiterChatKeys; затем 168, когда в тот же день добавился setArbiterChatKey;
// затем 169, когда 14 августа 2026 приехали восемь функций 4в-2 Выкатки 2),
// поэтому сверяется тем же тестом.
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
// сразу, чем после того как скрипт уже задеплоил одиннадцать имплементаций и Diamond.

import "forge-std/Script.sol";
import "forge-std/console.sol";

import "../src/DiamondProxy.sol";
import "../src/RegistryFacet.sol";
import "../src/FactoryFacet.sol";
import "../src/AgreementDeployer.sol";
import "../src/facets/JobBoardFacet.sol";
import "../src/facets/ServiceBoardFacet.sol";
import "../src/facets/ArbiterRegistryFacet.sol";
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
        // одиннадцать имплементаций и сам Diamond.

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
        // Порядок: JobBoard, ServiceBoard, ArbiterRegistry, DealMetadata,
        //          JobReceiptFacet, ReputationFacet
        IDiamondCut.FacetCut[] memory cuts2 = buildRemainingCuts(
            address(jobBoard),
            address(serviceBoard),
            address(arbiterFacet),
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
        address metaFacetAddr,
        address receiptFacetAddr,
        address reputationFacetAddr
    ) public pure returns (IDiamondCut.FacetCut[] memory cuts) {
        cuts = new IDiamondCut.FacetCut[](6);
        cuts[0] = _cut(jobBoardAddr,         IDiamondCut.FacetCutAction.Add, jobBoardFacetSelectors());
        cuts[1] = _cut(serviceBoardAddr,     IDiamondCut.FacetCutAction.Add, serviceBoardFacetSelectors());
        cuts[2] = _cut(arbiterFacetAddr,     IDiamondCut.FacetCutAction.Add, arbiterRegistryFacetSelectors());
        cuts[3] = _cut(metaFacetAddr,        IDiamondCut.FacetCutAction.Add, dealMetadataFacetSelectors());
        cuts[4] = _cut(receiptFacetAddr,     IDiamondCut.FacetCutAction.Add, jobReceiptFacetSelectors());
        cuts[5] = _cut(reputationFacetAddr,  IDiamondCut.FacetCutAction.Add, reputationFacetSelectors());
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

    // ArbiterRegistryFacet — 64 селектора
    function arbiterRegistryFacetSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](66);

        // DAO-режим
        sels[0]  = ArbiterRegistryFacet.activateDAO.selector;
        sels[1]  = ArbiterRegistryFacet.applyAsArbiter.selector;
        sels[2]  = ArbiterRegistryFacet.resignAsArbiter.selector;

        // Admin: управление арбитрами
        sels[3]  = ArbiterRegistryFacet.setChiefArbiter.selector;
        sels[4]  = ArbiterRegistryFacet.addArbiter.selector;
        sels[5]  = ArbiterRegistryFacet.removeArbiter.selector;

        // Клейм спора (commit-reveal)
        sels[6]  = ArbiterRegistryFacet.commitDisputeClaim.selector;
        sels[7]  = ArbiterRegistryFacet.claimDispute.selector;
        sels[8]  = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        sels[9]  = ArbiterRegistryFacet.clearDisputeClaim.selector;

        // Вердикт
        sels[10] = ArbiterRegistryFacet.submitVerdict.selector;
        sels[11] = ArbiterRegistryFacet.finalizeVerdict.selector;
        sels[12] = ArbiterRegistryFacet.overturnVerdict.selector;
        sels[13] = ArbiterRegistryFacet.notifyArbiterTimeout.selector;
        sels[14] = ArbiterRegistryFacet.freezeVerdict.selector;
        sels[15] = ArbiterRegistryFacet.unfreezeVerdict.selector;
        sels[16] = ArbiterRegistryFacet.clearStuckVerdict.selector;

        // Апелляция
        sels[17] = ArbiterRegistryFacet.raiseAppeal.selector;
        sels[18] = ArbiterRegistryFacet.voteOnAppeal.selector;
        sels[19] = ArbiterRegistryFacet.resolveAppeal.selector;

        // Вознаграждения
        sels[20] = ArbiterRegistryFacet.withdrawArbiterReward.selector;
        sels[21] = ArbiterRegistryFacet.fundVault.selector;
        sels[22] = ArbiterRegistryFacet.setRewardPerDispute.selector;
        sels[23] = ArbiterRegistryFacet.setDAOAddress.selector;

        // Views
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

        // Сбор со спора (3% от спорной суммы, считает Agreement) — 80/20 арбитр/казна
        sels[44] = ArbiterRegistryFacet.creditDisputeFee.selector;
        sels[45] = ArbiterRegistryFacet.withdrawTreasurySlice.selector;
        sels[46] = ArbiterRegistryFacet.getTreasurySlice.selector;

        // Платный вызов арбитра: порог и котировка доплаты до него
        sels[47] = ArbiterRegistryFacet.setArbiterFloor.selector;
        sels[48] = ArbiterRegistryFacet.getArbiterFloor.selector;
        sels[49] = ArbiterRegistryFacet.quoteDisputeTopUp.selector;

        // Платный вызов арбитра: оплата и мягкий возврат доплаты
        sels[50] = ArbiterRegistryFacet.fundDispute.selector;
        sels[51] = ArbiterRegistryFacet.getDisputeBounty.selector;
        sels[52] = ArbiterRegistryFacet.withdrawDisputeBounty.selector;
        sels[53] = ArbiterRegistryFacet.getRefundableBounty.selector;

        // Ключи чата арбитра (4б, 9 августа 2026)
        sels[54] = ArbiterRegistryFacet.getArbiterChatKeys.selector;
        sels[55] = ArbiterRegistryFacet.setArbiterChatKey.selector;

        // Запись «просил, ответа нет» и отпечаток предъявления
        // (4в-2 Выкатка 2, 14 августа 2026). На живой диамонд эти восемь
        // приезжают разрезом script/UpgradePresentationRecord.s.sol.
        sels[56] = ArbiterRegistryFacet.getDisputeClaimedAt.selector;
        sels[57] = ArbiterRegistryFacet.recordNoResponse.selector;
        sels[58] = ArbiterRegistryFacet.getNoResponseAt.selector;
        sels[59] = ArbiterRegistryFacet.getNoResponseFloor.selector;
        sels[60] = ArbiterRegistryFacet.recordPresentationDigest.selector;
        sels[61] = ArbiterRegistryFacet.getPresentationDigests.selector;
        sels[62] = ArbiterRegistryFacet.getPresentationDigestCount.selector;
        sels[63] = ArbiterRegistryFacet.getPresentationDigestsPage.selector;

        // Провенанс посадки: кто посадил арбитра (15 августа 2026). На живой
        // диамонд эти два приезжают отдельным разрезом апгрейда, не этим
        // скриптом — см. следующую задачу плана.
        sels[64] = ArbiterRegistryFacet.getSeatedBy.selector;
        sels[65] = ArbiterRegistryFacet.getSeatedCountBy.selector;
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
