// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// DisputeFee test suite.
// Доски (JobBoardFacet, ServiceBoardFacet) отказывают в создании сделки при
// нулевой комиссии региона. У прямых путей фабрики (deployAgreement,
// deployAndFund) такого гейта не было — асимметрия, которая при добавлении
// нового региона или обнулении комиссии владельцем по ошибке позволила бы
// создавать сделки бесплатно в обход досок. Этот файл проверяет, что
// deployAgreement теперь симметричен доскам.

import "forge-std/Test.sol";
import "../src/DiamondProxy.sol";
import "../src/RegistryFacet.sol";
import "../src/FactoryFacet.sol";
import "../src/AgreementDeployer.sol";
import "../src/Agreement.sol";

// ---------- MOCK USDC ----------

contract MockUSDCDF {
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

contract DisputeFeeTest is Test {
    DiamondProxy diamond;
    MockUSDCDF   usdc;

    address owner;
    address client;
    address executor;
    address feeRecipient;

    uint256 constant CLIENT_USDC = 1_000_000_000;

    // ============================================================
    //  SETUP
    // ============================================================
    // Скопировано из test/Extras.t.sol и вычищено: для этих тестов нужны
    // только RegistryFacet и FactoryFacet (deployAgreement/setRegionFee) —
    // ArbiterRegistryFacet, DiamondCut/Loupe и OwnershipFacet сюда не смонтированы,
    // потому что ни один тест их не вызывает.

    function setUp() public {
        owner        = address(this);
        client       = address(0x1);
        executor     = address(0x2);
        feeRecipient = address(0x4);

        usdc = new MockUSDCDF();
        usdc.mint(client, CLIENT_USDC);

        RegistryFacet registryFacet = new RegistryFacet();
        FactoryFacet  factoryFacet  = new FactoryFacet();

        bytes4[] memory regSels = new bytes4[](3);
        regSels[0] = RegistryFacet.initRegistry.selector;
        regSels[1] = RegistryFacet.register.selector;
        regSels[2] = RegistryFacet.hasActivePair.selector;

        bytes4[] memory facSels = new bytes4[](3);
        facSels[0] = FactoryFacet.initFactory.selector;
        facSels[1] = FactoryFacet.deployAgreement.selector;
        facSels[2] = FactoryFacet.setRegionFee.selector;

        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](2);
        cut[0] = IDiamondCut.FacetCut(address(registryFacet), IDiamondCut.FacetCutAction.Add, regSels);
        cut[1] = IDiamondCut.FacetCut(address(factoryFacet),  IDiamondCut.FacetCutAction.Add, facSels);

        diamond = new DiamondProxy(owner, cut, address(0), "");

        Agreement agreementImpl = new Agreement();
        AgreementDeployer agDeployer = new AgreementDeployer(address(diamond), address(agreementImpl));
        RegistryFacet(address(diamond)).initRegistry(address(diamond));
        FactoryFacet(address(diamond)).initFactory(
            address(usdc), feeRecipient, address(0xDEAD), address(diamond), address(agDeployer)
        );
    }

    // ============================================================
    //  ZERO REGION FEE GATE
    // ============================================================

    /// Комиссия региона обнулена владельцем по ошибке — прямой путь фабрики
    /// обязан отказать, а не создавать сделку бесплатно. В досках такой гейт
    /// уже есть (JobBoardFacet:184, ServiceBoardFacet:182), у фабрики не было.
    function testDeployAgreementRejectsZeroRegionFee() public {
        vm.prank(owner);
        FactoryFacet(address(diamond)).setRegionFee(0, 0);

        vm.startPrank(client);
        usdc.approve(address(diamond), type(uint256).max);
        vm.expectRevert(FactoryFacet.ZeroFee.selector);
        FactoryFacet(address(diamond)).deployAgreement(
            client, executor, address(0), 100_000_000, 7, "terms", 0
        );
        vm.stopPrank();
    }

    /// Ненулевая комиссия проходит — гейт не сломал штатный путь.
    function testDeployAgreementWorksWithNonZeroFee() public {
        vm.startPrank(client);
        usdc.approve(address(diamond), type(uint256).max);
        address agreement = FactoryFacet(address(diamond)).deployAgreement(
            client, executor, address(0), 100_000_000, 7, "terms", 0
        );
        vm.stopPrank();
        assertTrue(agreement != address(0), "deal creation broke");
    }
}
