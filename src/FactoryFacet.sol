// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// HEXSEAL — FactoryFacet.sol
// Деплоит Agreement контракты через внешний AgreementDeployer.
// Берёт PPP fee в USDC, регистрирует в RegistryFacet.
// ============================================================

import "./RegistryFacet.sol";
import "./AgreementDeployer.sol"; // только интерфейс IAgreementDeployer

// ---------- INTERFACES ----------

interface IRegistry {
    function register(address agreement, address client, address executor, uint256 amount) external;
    function hasActivePair(address client, address executor) external view returns (bool);
}

// USDC permit interface (EIP-2612)
interface IUSDC {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);
}

// ---------- STORAGE ----------

library FactoryStorage {
    bytes32 constant FACTORY_STORAGE_POSITION = keccak256("hexseal.factory.storage");

    uint8 constant REGION_CIS   = 0;
    uint8 constant REGION_ASIA  = 1;
    uint8 constant REGION_EU    = 2;
    uint8 constant REGION_US    = 3;
    uint8 constant REGION_LATAM = 4;
    uint8 constant REGION_CA    = 5;

    struct Layout {
        address usdc;
        address feeRecipient;
        mapping(uint8 => uint256) regionFee;
        address trustedForwarder;
        address diamond;
        bool paused;
        address protocolArbiter;
        uint256 arbitrationThreshold;
        // Деплойер Agreement (держит его creationCode, не раздувая этот фасет)
        address agreementDeployer;
    }

    function layout() internal pure returns (Layout storage fs) {
        bytes32 position = FACTORY_STORAGE_POSITION;
        assembly {
            fs.slot := position
        }
    }
}

// ---------- FACET ----------

contract FactoryFacet {

    // -------- EVENTS --------

    event AgreementDeployed(
        address indexed agreement,
        address indexed client,
        address indexed executor,
        uint256 amount,
        uint8 region,
        uint256 fee
    );

    event RegionFeeUpdated(uint8 indexed region, uint256 newFee);
    event FeeRecipientUpdated(address indexed newRecipient);
    event TrustedForwarderUpdated(address indexed newForwarder);
    event FactoryPaused(bool paused);
    event ProtocolArbiterUpdated(address indexed arbiter);
    event DealFunded(address indexed agreement, address indexed client, uint256 amount);
    event ArbitrationThresholdUpdated(uint256 newThreshold);
    event AgreementDeployerUpdated(address indexed deployer);

    // -------- ERRORS --------

    error FactoryPausedError();
    error ZeroAddress();
    error ZeroAmount();
    error ZeroDeadline();
    error InvalidRegion();
    error ActiveDealExists();
    error ClientEqualsExecutor();
    error NotOwner();
    error AlreadyInitialized();
    error NotClient();
    error DeployerNotSet();

    // -------- OWNER CHECK --------

    function _owner() internal view returns (address) {
        return OwnershipLib.contractOwner();
    }

    modifier onlyOwner() {
        if (msg.sender != _owner()) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (FactoryStorage.layout().paused) revert FactoryPausedError();
        _;
    }

    // -------- INIT --------

    function initFactory(
        address usdc_,
        address feeRecipient_,
        address trustedForwarder_,
        address diamond_,
        address agreementDeployer_
    ) external {
        FactoryStorage.Layout storage fs = FactoryStorage.layout();
        if (fs.usdc != address(0)) revert AlreadyInitialized();
        if (msg.sender != _owner()) revert NotOwner();

        if (usdc_ == address(0)) revert ZeroAddress();
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        if (diamond_ == address(0)) revert ZeroAddress();
        if (agreementDeployer_ == address(0)) revert ZeroAddress();

        fs.usdc              = usdc_;
        fs.feeRecipient      = feeRecipient_;
        fs.trustedForwarder  = trustedForwarder_;
        fs.diamond           = diamond_;
        fs.agreementDeployer = agreementDeployer_;

        fs.regionFee[FactoryStorage.REGION_CIS]  = 2_000_000;
        fs.regionFee[FactoryStorage.REGION_ASIA] = 4_000_000;
        fs.regionFee[FactoryStorage.REGION_EU]   = 7_000_000;
        fs.regionFee[FactoryStorage.REGION_US]   = 10_000_000;

        fs.arbitrationThreshold = 10_000_000;
    }

    // -------- DEPLOY AGREEMENT --------

    function deployAgreement(
        address client,
        address executor,
        address, // arbiter — ignored, assigned at dispute claim time
        uint256 amount,
        uint256 deadlineDays,
        bytes32 termsHash,
        uint8 region
    ) external whenNotPaused returns (address agreementAddress) {
        if (client == address(0)) revert ZeroAddress();
        if (executor == address(0)) revert ZeroAddress();
        if (client == executor) revert ClientEqualsExecutor();
        if (amount == 0) revert ZeroAmount();
        if (deadlineDays == 0) revert ZeroDeadline();
        if (region > 6) revert InvalidRegion();
        if (msg.sender != client && msg.sender != address(this)) revert NotClient();

        FactoryStorage.Layout storage fs = FactoryStorage.layout();
        if (fs.agreementDeployer == address(0)) revert DeployerNotSet();

        if (IRegistry(fs.diamond).hasActivePair(client, executor)) revert ActiveDealExists();

        uint256 fee = fs.regionFee[region];
        if (msg.sender == client) {
            _safeTransferFrom(fs.usdc, msg.sender, fs.feeRecipient, fee);
        }

        agreementAddress = IAgreementDeployer(fs.agreementDeployer).deploy(
            client, executor, address(0),
            amount, deadlineDays, termsHash,
            fs.diamond, fs.usdc, fs.trustedForwarder, address(this)
        );

        IRegistry(fs.diamond).register(agreementAddress, client, executor, amount);

        emit AgreementDeployed(agreementAddress, client, executor, amount, region, fee);
    }

    // -------- DEPLOY AND FUND --------

    function deployAndFund(
        address client,
        address executor,
        uint256 amount,
        uint256 deadlineDays,
        bytes32 termsHash,
        uint8 region,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused returns (address agreementAddress) {
        if (client == address(0)) revert ZeroAddress();
        if (executor == address(0)) revert ZeroAddress();
        if (client == executor) revert ClientEqualsExecutor();
        if (amount == 0) revert ZeroAmount();
        if (deadlineDays == 0) revert ZeroDeadline();
        if (region > 6) revert InvalidRegion();

        FactoryStorage.Layout storage fs = FactoryStorage.layout();
        if (fs.agreementDeployer == address(0)) revert DeployerNotSet();

        if (IRegistry(fs.diamond).hasActivePair(client, executor)) revert ActiveDealExists();

        uint256 fee = fs.regionFee[region];
        uint256 total = amount + fee;

        IUSDC(fs.usdc).permit(client, address(this), total, permitDeadline, v, r, s);

        _safeTransferFrom(fs.usdc, client, fs.feeRecipient, fee);

        agreementAddress = IAgreementDeployer(fs.agreementDeployer).deploy(
            client, executor, address(0),
            amount, deadlineDays, termsHash,
            fs.diamond, fs.usdc, fs.trustedForwarder, address(this)
        );

        IRegistry(fs.diamond).register(agreementAddress, client, executor, amount);

        _safeTransferFrom(fs.usdc, client, agreementAddress, amount);

        (bool success, ) = agreementAddress.call(abi.encodeWithSignature("fundFromFactory()"));
        require(success, "Factory: fundFromFactory failed");

        emit AgreementDeployed(agreementAddress, client, executor, amount, region, fee);
        emit DealFunded(agreementAddress, client, amount);
    }

    // -------- SAFE TRANSFER --------

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0x23b872dd, from, to, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "Factory: fee transfer failed");
    }

    // -------- ADMIN --------

    function setRegionFee(uint8 region, uint256 newFee) external onlyOwner {
        if (region > 6) revert InvalidRegion();
        FactoryStorage.layout().regionFee[region] = newFee;
        emit RegionFeeUpdated(region, newFee);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        FactoryStorage.layout().feeRecipient = newRecipient;
        emit FeeRecipientUpdated(newRecipient);
    }

    function setTrustedForwarder(address newForwarder) external onlyOwner {
        FactoryStorage.layout().trustedForwarder = newForwarder;
        emit TrustedForwarderUpdated(newForwarder);
    }

    function setPaused(bool _paused) external onlyOwner {
        FactoryStorage.layout().paused = _paused;
        emit FactoryPaused(_paused);
    }

    function setProtocolArbiter(address arbiter) external onlyOwner {
        FactoryStorage.layout().protocolArbiter = arbiter;
        emit ProtocolArbiterUpdated(arbiter);
    }

    function setArbitrationThreshold(uint256 newThreshold) external onlyOwner {
        FactoryStorage.layout().arbitrationThreshold = newThreshold;
        emit ArbitrationThresholdUpdated(newThreshold);
    }

    function setAgreementDeployer(address deployer) external onlyOwner {
        if (deployer == address(0)) revert ZeroAddress();
        FactoryStorage.layout().agreementDeployer = deployer;
        emit AgreementDeployerUpdated(deployer);
    }

    // -------- READ --------

    function getRegionFee(uint8 region) external view returns (uint256) {
        if (region > 6) revert InvalidRegion();
        return FactoryStorage.layout().regionFee[region];
    }

    function getAllFees() external view returns (
        uint256 cis, uint256 asia, uint256 eu, uint256 us, uint256 latam, uint256 ca, uint256 au
    ) {
        FactoryStorage.Layout storage fs = FactoryStorage.layout();
        cis   = fs.regionFee[0];
        asia  = fs.regionFee[1];
        eu    = fs.regionFee[2];
        us    = fs.regionFee[3];
        latam = fs.regionFee[4];
        ca    = fs.regionFee[5];
        au    = fs.regionFee[6];
    }

    function getFeeRecipient() external view returns (address) {
        return FactoryStorage.layout().feeRecipient;
    }

    function getTrustedForwarder() external view returns (address) {
        return FactoryStorage.layout().trustedForwarder;
    }

    function isPaused() external view returns (bool) {
        return FactoryStorage.layout().paused;
    }

    function getUsdc() external view returns (address) {
        return FactoryStorage.layout().usdc;
    }

    function getProtocolArbiter() external view returns (address) {
        return FactoryStorage.layout().protocolArbiter;
    }

    function getArbitrationThreshold() external view returns (uint256) {
        return FactoryStorage.layout().arbitrationThreshold;
    }

    function getAgreementDeployer() external view returns (address) {
        return FactoryStorage.layout().agreementDeployer;
    }
}
