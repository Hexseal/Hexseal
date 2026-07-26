// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Интеграционный тест Treasury с НАСТОЯЩИМ диамондом (не мок-диамонд, на
// котором гонялась вся остальная лестница в Задачах 2-4).
//
// Проверяется то, чего мок проверить не может:
//   1) комиссия за создание сделки реально доходит до казны через живой
//      FactoryFacet.deployAgreement — без единого изменения в FactoryFacet;
//   2) казна умеет наполнить настоящий банк арбитров (ArbiterRegistryFacet)
//      через fundVault(), а не только выставленное вручную значение мока;
//   3) подстановка казны через setFeeRecipient не ломает старый путь
//      создания сделки — фабрика и эскроу казну не видят вообще, для них
//      это просто адрес.
//
// setUp скопирован из test/Extras.t.sol (тот же набор смонтированных
// фасетов и тот же MockUSDCE) и дополнен ReputationFacet — она отсутствовала
// в Extras.t.sol. Для продакшн-параллели (DeployFull.s.sol её монтирует) и
// на вырост будущим тестам этого файла — НЕ потому что без неё падает
// нынешняя тройка тестов (проверено: не падает; подробности — у монтирования
// repSels ниже).
import "forge-std/Test.sol";
import "../src/DiamondProxy.sol";
import "../src/RegistryFacet.sol";
import "../src/FactoryFacet.sol";
import "../src/AgreementDeployer.sol";
import "../src/Agreement.sol";
import "../src/facets/ArbiterRegistryFacet.sol";
import "../src/facets/ReputationFacet.sol";
import "../src/Treasury.sol";

// ---------- MOCK USDC (дословная копия из test/Extras.t.sol) ----------

contract MockUSDCE {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

// ---------- TEST ----------

contract TreasuryIntegrationTest is Test {
    DiamondProxy diamond;
    MockUSDCE    usdc;

    address owner;
    address client;
    address executor;
    address arbiter;
    address feeRecipient;

    /// Адрес фаундейшна для этих тестов — казна не знает и не должна знать,
    /// что за ним стоит (см. докстринг Treasury.foundation).
    address constant FOUNDATION = address(0xF00D);

    uint256 constant CLIENT_USDC   = 1_000_000_000;
    uint256 constant EXECUTOR_USDC =   200_000_000;

    uint8   constant REGION     = 0; // CIS — $2 комиссия, задаётся в FactoryFacet.initFactory
    uint256 constant JOB_AMOUNT = 100_000_000;
    uint256 constant DEADLINE   = 7;
    string constant TERMS = "Standard work terms";

    // ============================================================
    //  SETUP — скопирован из test/Extras.t.sol, дополнен ReputationFacet
    // ============================================================

    function setUp() public {
        owner        = address(this);
        client       = address(0x1);
        executor     = address(0x2);
        arbiter      = address(0x3);
        feeRecipient = address(0x4);

        usdc = new MockUSDCE();
        usdc.mint(client,   CLIENT_USDC);
        usdc.mint(executor, EXECUTOR_USDC);

        RegistryFacet        registryFacet        = new RegistryFacet();
        FactoryFacet         factoryFacet         = new FactoryFacet();
        DiamondCutFacet      diamondCutFacet      = new DiamondCutFacet();
        DiamondLoupeFacet    diamondLoupeFacet    = new DiamondLoupeFacet();
        OwnershipFacet       ownershipFacet       = new OwnershipFacet();
        ArbiterRegistryFacet arbiterRegistryFacet = new ArbiterRegistryFacet();
        ReputationFacet      reputationFacet      = new ReputationFacet();

        bytes4[] memory regSels = new bytes4[](12);
        regSels[0]  = RegistryFacet.initRegistry.selector;
        regSels[1]  = RegistryFacet.register.selector;
        regSels[2]  = RegistryFacet.updateStatus.selector;
        regSels[3]  = RegistryFacet.setAuthorizedFactory.selector;
        regSels[4]  = RegistryFacet.hasActivePair.selector;
        regSels[5]  = RegistryFacet.getActivePair.selector;
        regSels[6]  = RegistryFacet.getRecord.selector;
        regSels[7]  = RegistryFacet.getByClient.selector;
        regSels[8]  = RegistryFacet.getByExecutor.selector;
        regSels[9]  = RegistryFacet.getActive.selector;
        regSels[10] = RegistryFacet.totalAgreements.selector;
        regSels[11] = RegistryFacet.authorizedFactory.selector;

        bytes4[] memory facSels = new bytes4[](13);
        facSels[0]  = FactoryFacet.initFactory.selector;
        facSels[1]  = FactoryFacet.deployAgreement.selector;
        facSels[2]  = FactoryFacet.setRegionFee.selector;
        facSels[3]  = FactoryFacet.setFeeRecipient.selector;
        facSels[4]  = FactoryFacet.setTrustedForwarder.selector;
        facSels[5]  = bytes4(0x16c38b3c);
        facSels[6]  = FactoryFacet.getRegionFee.selector;
        facSels[7]  = FactoryFacet.getAllFees.selector;
        facSels[8]  = FactoryFacet.getFeeRecipient.selector;
        facSels[9]  = FactoryFacet.getTrustedForwarder.selector;
        facSels[10] = bytes4(0xb187bd26);
        facSels[11] = FactoryFacet.getUsdc.selector;
        facSels[12] = bytes4(0x220f72fc);

        bytes4[] memory arbSels = new bytes4[](33);
        arbSels[0]  = ArbiterRegistryFacet.setChiefArbiter.selector;
        arbSels[1]  = ArbiterRegistryFacet.addArbiter.selector;
        arbSels[2]  = ArbiterRegistryFacet.removeArbiter.selector;
        arbSels[3]  = ArbiterRegistryFacet.commitDisputeClaim.selector;
        arbSels[4]  = ArbiterRegistryFacet.claimDispute.selector;
        arbSels[5]  = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        arbSels[6]  = ArbiterRegistryFacet.clearDisputeClaim.selector;
        arbSels[7]  = ArbiterRegistryFacet.getChiefArbiter.selector;
        arbSels[8]  = ArbiterRegistryFacet.isRegisteredArbiter.selector;
        arbSels[9]  = ArbiterRegistryFacet.getArbiters.selector;
        arbSels[10] = ArbiterRegistryFacet.getDisputeClaimer.selector;
        arbSels[11] = ArbiterRegistryFacet.getArbiterDeals.selector;
        arbSels[12] = ArbiterRegistryFacet.getClaimCommitment.selector;
        arbSels[13] = ArbiterRegistryFacet.activateDAO.selector;
        arbSels[14] = ArbiterRegistryFacet.applyAsArbiter.selector;
        arbSels[15] = ArbiterRegistryFacet.isDaoActive.selector;
        arbSels[16] = ArbiterRegistryFacet.getMinXPToRegister.selector;
        arbSels[17] = ArbiterRegistryFacet.getDaoThreshold.selector;
        arbSels[18] = ArbiterRegistryFacet.submitVerdict.selector;
        arbSels[19] = ArbiterRegistryFacet.finalizeVerdict.selector;
        arbSels[20] = ArbiterRegistryFacet.overturnVerdict.selector;
        arbSels[21] = ArbiterRegistryFacet.freezeVerdict.selector;
        arbSels[22] = ArbiterRegistryFacet.unfreezeVerdict.selector;
        arbSels[23] = ArbiterRegistryFacet.withdrawArbiterReward.selector;
        arbSels[24] = ArbiterRegistryFacet.fundVault.selector;
        arbSels[25] = ArbiterRegistryFacet.setRewardPerDispute.selector;
        arbSels[26] = ArbiterRegistryFacet.setDAOAddress.selector;
        arbSels[27] = ArbiterRegistryFacet.getPendingVerdict.selector;
        arbSels[28] = ArbiterRegistryFacet.getArbiterReward.selector;
        arbSels[29] = ArbiterRegistryFacet.getVaultBalance.selector;
        arbSels[30] = ArbiterRegistryFacet.getRewardPerDispute.selector;
        arbSels[31] = ArbiterRegistryFacet.getDAOAddress.selector;
        arbSels[32] = ArbiterRegistryFacet.clearStuckVerdict.selector;

        bytes4[] memory cutSels   = new bytes4[](1);
        cutSels[0] = DiamondCutFacet.diamondCut.selector;

        bytes4[] memory loupeSels = new bytes4[](5);
        loupeSels[0] = DiamondLoupeFacet.facets.selector;
        loupeSels[1] = DiamondLoupeFacet.facetFunctionSelectors.selector;
        loupeSels[2] = DiamondLoupeFacet.facetAddresses.selector;
        loupeSels[3] = DiamondLoupeFacet.facetAddress.selector;
        loupeSels[4] = DiamondLoupeFacet.supportsInterface.selector;

        bytes4[] memory ownSels   = new bytes4[](4);
        ownSels[0] = OwnershipFacet.transferOwnership.selector;
        ownSels[1] = OwnershipFacet.owner.selector;
        ownSels[2] = OwnershipFacet.acceptOwnership.selector;
        ownSels[3] = OwnershipFacet.pendingOwner.selector;

        // ReputationFacet selectors — добавлено сверх Extras.t.sol, где этот
        // фасет вообще не монтировался. ЧЕСТНО: тройке тестов ниже он не
        // нужен — проверено удалением: без него все три по-прежнему проходят,
        // потому что ни один не завершает сделку (autoAwardXP из
        // Agreement._complete вызывается через try/catch и не вызывается
        // здесь вовсе) и ни один не дергает withdrawReserve() (единственное
        // место, где Treasury делает ВНЕШНИЙ вызов getUniqueActiveUsers() —
        // а foundationBps()/isDaoActive() читают ReputationStorage напрямую
        // из хранилища диамонда, это работает независимо от того, смонтирован
        // ли сам фасет). Мостируем для параллели с продакшн-конфигурацией
        // (DeployFull.s.sol монтирует ReputationFacet) и на вырост будущим
        // тестам этого файла, которые могут завершать сделку или проверять
        // withdrawReserve() — не потому что без него падает уже написанное.
        bytes4[] memory repSels = new bytes4[](8);
        repSels[0] = ReputationFacet.claimXP.selector;
        repSels[1] = ReputationFacet.getXP.selector;
        repSels[2] = ReputationFacet.getUniqueActiveUsers.selector;
        repSels[3] = ReputationFacet.hasClaimed.selector;
        repSels[4] = ReputationFacet.isDealWin.selector;
        repSels[5] = ReputationFacet.autoAwardXP.selector;
        repSels[6] = ReputationFacet.notifyExecutorFault.selector;
        repSels[7] = ReputationFacet.getCleanStreak.selector;

        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](7);
        cut[0] = IDiamondCut.FacetCut(address(registryFacet),        IDiamondCut.FacetCutAction.Add, regSels);
        cut[1] = IDiamondCut.FacetCut(address(factoryFacet),         IDiamondCut.FacetCutAction.Add, facSels);
        cut[2] = IDiamondCut.FacetCut(address(diamondCutFacet),      IDiamondCut.FacetCutAction.Add, cutSels);
        cut[3] = IDiamondCut.FacetCut(address(diamondLoupeFacet),    IDiamondCut.FacetCutAction.Add, loupeSels);
        cut[4] = IDiamondCut.FacetCut(address(ownershipFacet),       IDiamondCut.FacetCutAction.Add, ownSels);
        cut[5] = IDiamondCut.FacetCut(address(arbiterRegistryFacet), IDiamondCut.FacetCutAction.Add, arbSels);
        cut[6] = IDiamondCut.FacetCut(address(reputationFacet),      IDiamondCut.FacetCutAction.Add, repSels);

        diamond = new DiamondProxy(owner, cut, address(0), "");

        Agreement agreementImpl = new Agreement();
        AgreementDeployer agDeployer = new AgreementDeployer(address(diamond), address(agreementImpl));
        RegistryFacet(address(diamond)).initRegistry(address(diamond));
        FactoryFacet(address(diamond)).initFactory(
            address(usdc), feeRecipient, address(0xDEAD), address(diamond), address(agDeployer)
        );
        ArbiterRegistryFacet(address(diamond)).addArbiter(arbiter);
    }

    // ============================================================
    //  ТЕСТЫ
    // ============================================================

    /// Ради этого всё и делалось: комиссия за создание сделки должна дойти
    /// до казны без единого изменения в FactoryFacet.
    function testDealFeeReachesTheTreasury() public {
        Treasury treasury = new Treasury(address(usdc), address(diamond), FOUNDATION);

        vm.prank(owner);
        FactoryFacet(address(diamond)).setFeeRecipient(address(treasury));

        uint256 before = usdc.balanceOf(address(treasury));

        // Создание сделки клиентом — комиссия платится региональная.
        vm.startPrank(client);
        usdc.approve(address(diamond), type(uint256).max);
        FactoryFacet(address(diamond)).deployAgreement(
            client, executor, address(0), 100_000_000, 7, "terms", 0
        );
        vm.stopPrank();

        // Точная сумма, не просто "больше нуля": комиссия REGION_CIS зашита
        // константой в FactoryFacet.sol:131 (fs.regionFee[REGION_CIS] =
        // 2_000_000) и передаётся ровно этой суммой — deployAgreement выше
        // вызван с region = 0 (CIS). Слабая проверка ">0" не отличила бы это
        // от списания чужого региона или задвоенной комиссии.
        assertEq(
            usdc.balanceOf(address(treasury)) - before,
            2_000_000,
            "deal fee arriving at the treasury does not match the REGION_CIS fee"
        );
    }

    /// Казна должна уметь наполнить банк настоящего диамонда, а не только мока.
    function testTreasuryCanFillTheRealVault() public {
        Treasury treasury = new Treasury(address(usdc), address(diamond), FOUNDATION);

        vm.prank(owner);
        FactoryFacet(address(diamond)).setFeeRecipient(address(treasury));

        usdc.mint(address(treasury), 1_000_000_000);
        treasury.distribute();

        assertEq(
            ArbiterRegistryFacet(address(diamond)).getVaultBalance(),
            treasury.VAULT_TARGET(),
            "the real vault was not filled to target"
        );

        // distribute() только размечает foundationOwed (pull-модель — см.
        // докстринг Treasury.foundationOwed про чёрный список Circle);
        // реальный перевод на кошелёк фаундейшна происходит только через
        // withdrawFoundation(), поэтому он нужен здесь до проверки баланса.
        treasury.withdrawFoundation();
        assertEq(usdc.balanceOf(FOUNDATION), (1_000_000_000 - 500_000_000) * 70 / 100, "foundation share");
    }

    /// FactoryFacet, Agreement и доски менять не пришлось — казна для них
    /// просто адрес. Проверяем это тем, что старый путь продолжает работать
    /// после подстановки казны.
    function testSettingTheTreasuryDoesNotBreakDealCreation() public {
        Treasury treasury = new Treasury(address(usdc), address(diamond), FOUNDATION);

        vm.prank(owner);
        FactoryFacet(address(diamond)).setFeeRecipient(address(treasury));

        vm.startPrank(client);
        usdc.approve(address(diamond), type(uint256).max);
        address agreement = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, address(0), 100_000_000, 7, "terms", 0
        );
        vm.stopPrank();

        assertTrue(agreement != address(0), "deal creation broke after the treasury was wired in");
    }
}
