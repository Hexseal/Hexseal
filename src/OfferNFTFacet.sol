// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// SIGNATURE404 — OfferNFTFacet.sol
// Единый NFT-фасет платформы. Два типа токенов:
//   OFFER       — Soulbound NFT объявления исполнителя
//   JOB_RECEIPT — Soulbound NFT-квитанция клиента при размещении заказа
//
// SVG/JSON рендеринг вынесен в SVGRenderer.sol (внешний контракт).
// ============================================================

import "./FactoryFacet.sol";
import "./DiamondProxy.sol";
import "./SVGRenderer.sol";

// ─── Namespaced Storage ───────────────────────────────────────────────────────

library OfferNFTStorage {
    bytes32 constant POSITION = keccak256("signature404.offernft.storage");

    struct Offer {
        address executor;
        string  title;
        string  category;
        uint256 price;
        uint256 deadlineDays;
        uint256 createdAt;
        bool    active;
        uint256 hiresCount;
    }

    struct JobReceiptData {
        address client;
        string  title;
        uint256 amount;
        uint256 deadlineDays;
        uint8   region;
        uint256 createdAt;
    }

    struct Layout {
        uint256 reentrancyStatus;
        uint256 nextTokenId;
        mapping(uint256 => Offer)    offers;
        mapping(address => uint256[]) executorOffers;
        mapping(uint256 => address[]) offerHires;
        mapping(address => uint256)  balances;
        mapping(uint256 => address)  owners;
        address _deprecated_receiptNFT;         // slot reserved
        mapping(uint256 => bool)           isJobReceipt;
        mapping(uint256 => JobReceiptData) jobReceiptData;
        mapping(uint256 => bool)           jobReceiptMinted;
        address svgRenderer;                    // ISVGRenderer external contract
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 pos = POSITION;
        assembly { l.slot := pos }
    }
}

// ─── OfferNFTFacet ────────────────────────────────────────────────────────────

contract OfferNFTFacet {
    using Strings for uint256;

    // ─── ERC-721 Events ──────────────────────────────────────────────────────
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    // ─── Business Events ─────────────────────────────────────────────────────
    event OfferMinted(uint256 indexed tokenId, address indexed executor, string title, string category, uint256 price);
    event OfferHired(uint256 indexed tokenId, address indexed executor, address hirer);
    event OfferDeactivated(uint256 indexed tokenId);
    event DealCreated(uint256 indexed tokenId, address indexed client, address indexed executor, address agreement);
    event JobReceiptMinted(uint256 indexed tokenId, uint256 indexed jobId, address indexed client);
    event SvgRendererUpdated(address indexed renderer);

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier nonReentrant() {
        if (DiamondGuard.status() == DiamondGuard.ENTERED) revert("Reentrant call");
        DiamondGuard.setStatus(DiamondGuard.ENTERED);
        _;
        DiamondGuard.setStatus(DiamondGuard.NOT_ENTERED);
    }

    modifier onlyOwner() {
        if (msg.sender != OwnershipLib.contractOwner()) revert("Not owner");
        _;
    }

    // ─── ERC-2771 ─────────────────────────────────────────────────────────────

    function _msgSender() internal view returns (address sender) {
        address forwarder = FactoryStorage.layout().trustedForwarder;
        if (msg.sender == forwarder && msg.data.length >= 20) {
            assembly {
                sender := shr(96, calldataload(sub(calldatasize(), 20)))
            }
        } else {
            sender = msg.sender;
        }
    }

    // ─── ERC-721 Metadata ─────────────────────────────────────────────────────

    function name() external pure returns (string memory) { return "Signature404 NFT"; }
    function symbol() external pure returns (string memory) { return "S404"; }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x80ac58cd
            || interfaceId == 0x5b5e139f
            || interfaceId == 0x01ffc9a7;
    }

    // ─── ERC-721 Core ─────────────────────────────────────────────────────────

    function balanceOf(address owner) external view returns (uint256) {
        require(owner != address(0), "ERC721: zero address");
        return OfferNFTStorage.layout().balances[owner];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address owner = OfferNFTStorage.layout().owners[tokenId];
        require(owner != address(0), "ERC721: nonexistent token");
        return owner;
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        OfferNFTStorage.Layout storage s = OfferNFTStorage.layout();
        require(s.owners[tokenId] != address(0), "ERC721: nonexistent token");

        address renderer = s.svgRenderer;
        require(renderer != address(0), "SVGRenderer not set");

        if (s.isJobReceipt[tokenId]) {
            OfferNFTStorage.JobReceiptData storage r = s.jobReceiptData[tokenId];
            return ISVGRenderer(renderer).renderReceipt(ISVGRenderer.ReceiptParams({
                tokenId:     tokenId,
                client:      r.client,
                title:       r.title,
                amount:      r.amount,
                deadlineDays: r.deadlineDays,
                region:      r.region,
                createdAt:   r.createdAt
            }));
        }

        OfferNFTStorage.Offer storage o = s.offers[tokenId];
        return ISVGRenderer(renderer).renderOffer(ISVGRenderer.OfferParams({
            tokenId:     tokenId,
            executor:    o.executor,
            title:       o.title,
            category:    o.category,
            price:       o.price,
            deadlineDays: o.deadlineDays,
            createdAt:   o.createdAt,
            active:      o.active,
            hiresCount:  o.hiresCount
        }));
    }

    // Soulbound — все transfer/approve заблокированы

    function transferFrom(address, address, uint256) external pure {
        revert("Soulbound: non-transferable");
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert("Soulbound: non-transferable");
    }

    // solhint-disable-next-line
    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert("Soulbound: non-transferable");
    }

    function approve(address, uint256) external pure {
        revert("Soulbound: non-transferable");
    }

    function setApprovalForAll(address, bool) external pure {
        revert("Soulbound: non-transferable");
    }

    function getApproved(uint256) external pure returns (address) { return address(0); }
    function isApprovedForAll(address, address) external pure returns (bool) { return false; }

    // ─── Admin: SVGRenderer ───────────────────────────────────────────────────

    function setSvgRenderer(address renderer) external onlyOwner {
        require(renderer != address(0), "Zero address");
        OfferNFTStorage.layout().svgRenderer = renderer;
        emit SvgRendererUpdated(renderer);
    }

    function getSvgRenderer() external view returns (address) {
        return OfferNFTStorage.layout().svgRenderer;
    }

    // ─── Business: Mint Offer ─────────────────────────────────────────────────

    function mintOffer(
        string memory title,
        string memory category,
        uint256 price,
        uint256 deadlineDays,
        string memory /* metadataURI — deprecated, kept for ABI compatibility */
    ) external nonReentrant returns (uint256) {
        require(bytes(title).length > 0 && bytes(title).length <= 100, "Title invalid");
        require(bytes(category).length > 0 && bytes(category).length <= 50, "Category invalid");
        require(price > 0 && price <= 1_000_000_000_000, "Price invalid");
        require(deadlineDays >= 1 && deadlineDays <= 365, "Deadline invalid");

        address caller = _msgSender();
        OfferNFTStorage.Layout storage s = OfferNFTStorage.layout();
        uint256 tokenId = s.nextTokenId++;

        s.offers[tokenId] = OfferNFTStorage.Offer({
            executor:     caller,
            title:        title,
            category:     category,
            price:        price,
            deadlineDays: deadlineDays,
            createdAt:    block.timestamp,
            active:       true,
            hiresCount:   0
        });

        s.executorOffers[caller].push(tokenId);
        s.owners[tokenId] = caller;
        s.balances[caller]++;

        emit Transfer(address(0), caller, tokenId);
        emit OfferMinted(tokenId, caller, title, category, price);

        return tokenId;
    }

    // ─── Business: Mint Job Receipt ───────────────────────────────────────────

    function mintJobReceipt(
        address to,
        uint256 jobId,
        uint256 amount,
        uint256 deadlineDays,
        uint8   region,
        string calldata title
    ) external returns (uint256 tokenId) {
        require(msg.sender == address(this), "Only Diamond");

        OfferNFTStorage.Layout storage s = OfferNFTStorage.layout();
        if (s.jobReceiptMinted[jobId]) return type(uint256).max;

        s.jobReceiptMinted[jobId] = true;
        tokenId = s.nextTokenId++;

        s.isJobReceipt[tokenId] = true;
        s.jobReceiptData[tokenId] = OfferNFTStorage.JobReceiptData({
            client:       to,
            title:        title,
            amount:       amount,
            deadlineDays: deadlineDays,
            region:       region,
            createdAt:    block.timestamp
        });

        s.owners[tokenId] = to;
        s.balances[to]++;

        emit Transfer(address(0), to, tokenId);
        emit JobReceiptMinted(tokenId, jobId, to);
    }

    // ─── Business: Hire ───────────────────────────────────────────────────────

    // ── Old signature removed ── previously took (tokenId, address client, termsHash, region)
    // with no authorization, no fee, no funding — anyone could create a fee-free unfunded deal.
    // New: CLIENT is the caller (msg.sender / ERC-2771), fee + amount collected atomically.

    /// @notice Client hires an executor via their Offer NFT.
    /// Requires prior approve(diamond, fee + offer.price) on USDC.
    /// For gasless use hireAndCreateDealWithPermit.
    function hireAndCreateDeal(
        uint256 tokenId,
        bytes32 termsHash,
        uint8   region
    ) external nonReentrant returns (address agreement) {
        address client = _msgSender();

        OfferNFTStorage.Layout storage s = OfferNFTStorage.layout();
        OfferNFTStorage.Offer storage offer = s.offers[tokenId];

        require(offer.executor != address(0), "Offer does not exist");
        require(offer.active,                 "Offer not active");
        require(client != offer.executor,     "Cannot hire yourself");
        require(region <= 3,                  "Invalid region");

        FactoryStorage.Layout storage fs = FactoryStorage.layout();
        require(!fs.paused, "Factory paused");
        uint256 fee        = fs.regionFee[region];
        require(fee > 0,  "Zero fee");
        uint256 dealAmount = offer.price;

        // Effects
        s.offerHires[tokenId].push(client);
        offer.hiresCount++;

        emit OfferHired(tokenId, offer.executor, client);

        // Fee: client → feeRecipient (non-refundable anti-spam)
        _safeTransferFrom(fs.usdc, client, fs.feeRecipient, fee);

        // Deploy Agreement via FactoryFacet (checks hasActivePair, registers pair)
        agreement = _deployAgreement(client, offer.executor, dealAmount, offer.deadlineDays, termsHash, region);

        // Fund Agreement atomically: client → agreement → fundFromFactory()
        _safeTransferFrom(fs.usdc, client, agreement, dealAmount);
        (bool funded, ) = agreement.call(abi.encodeWithSignature("fundFromFactory()"));
        require(funded, "OfferNFT: fund failed");

        emit DealCreated(tokenId, client, offer.executor, agreement);
    }

    /// @notice Gasless variant — permit replaces pre-approval.
    /// @param permitAmount Must equal fee + offer.price for the given region.
    function hireAndCreateDealWithPermit(
        uint256 tokenId,
        bytes32 termsHash,
        uint8   region,
        uint256 permitAmount,
        uint256 permitDeadline,
        uint8   v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (address agreement) {
        address client = _msgSender();

        OfferNFTStorage.Layout storage os = OfferNFTStorage.layout();
        OfferNFTStorage.Offer storage offer = os.offers[tokenId];

        require(offer.executor != address(0), "Offer does not exist");
        require(offer.active,                 "Offer not active");
        require(client != offer.executor,     "Cannot hire yourself");
        require(region <= 3,                  "Invalid region");

        FactoryStorage.Layout storage fs = FactoryStorage.layout();
        require(!fs.paused, "Factory paused");
        uint256 fee        = fs.regionFee[region];
        require(fee > 0,  "Zero fee");
        uint256 dealAmount = offer.price;
        require(permitAmount == fee + dealAmount, "Permit amount mismatch");

        // Permit: one signature covers fee + amount
        (bool pOk, ) = fs.usdc.call(abi.encodeWithSignature(
            "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
            client, address(this), permitAmount, permitDeadline, v, r, s
        ));
        require(pOk, "OfferNFT: permit failed");

        // Effects
        os.offerHires[tokenId].push(client);
        offer.hiresCount++;

        emit OfferHired(tokenId, offer.executor, client);

        _safeTransferFrom(fs.usdc, client, fs.feeRecipient, fee);

        agreement = _deployAgreement(client, offer.executor, dealAmount, offer.deadlineDays, termsHash, region);

        _safeTransferFrom(fs.usdc, client, agreement, dealAmount);
        (bool funded, ) = agreement.call(abi.encodeWithSignature("fundFromFactory()"));
        require(funded, "OfferNFT: fund failed");

        emit DealCreated(tokenId, client, offer.executor, agreement);
    }

    // ─── Internal Helpers ─────────────────────────────────────────────────────

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0x23b872dd, from, to, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "OfferNFT: transferFrom failed");
    }

    // ─── Business: Deactivate ─────────────────────────────────────────────────

    function deactivateOffer(uint256 tokenId) external nonReentrant {
        OfferNFTStorage.Layout storage s = OfferNFTStorage.layout();
        OfferNFTStorage.Offer storage offer = s.offers[tokenId];

        require(offer.executor != address(0), "Offer does not exist");
        require(offer.executor == _msgSender(), "Not offer owner");
        require(offer.active, "Offer already inactive");

        offer.active = false;
        emit OfferDeactivated(tokenId);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function getOffer(uint256 tokenId) external view returns (OfferNFTStorage.Offer memory) {
        OfferNFTStorage.Layout storage s = OfferNFTStorage.layout();
        require(s.offers[tokenId].executor != address(0), "Offer does not exist");
        return s.offers[tokenId];
    }

    function getExecutorOffers(address executor) external view returns (uint256[] memory) {
        return OfferNFTStorage.layout().executorOffers[executor];
    }

    function getOfferHires(uint256 tokenId) external view returns (address[] memory) {
        OfferNFTStorage.Layout storage s = OfferNFTStorage.layout();
        require(s.offers[tokenId].executor != address(0), "Offer does not exist");
        return s.offerHires[tokenId];
    }

    function getTotalSupply() external view returns (uint256) {
        return OfferNFTStorage.layout().nextTokenId;
    }

    function getActiveOffersCount() external view returns (uint256) {
        OfferNFTStorage.Layout storage s = OfferNFTStorage.layout();
        uint256 count = 0;
        for (uint256 i = 0; i < s.nextTokenId; i++) {
            if (!s.isJobReceipt[i] && s.offers[i].active) count++;
        }
        return count;
    }

    // ─── Internal: Deploy Agreement ───────────────────────────────────────────

    function _deployAgreement(
        address client,
        address executor,
        uint256 amount,
        uint256 deadlineDays,
        bytes32 termsHash,
        uint8   region
    ) internal returns (address) {
        bytes memory payload = abi.encodeWithSelector(
            0x79a9c0c8, // deployAgreement(address,address,address,uint256,uint256,bytes32,uint8)
            client, executor, address(0), amount, deadlineDays, termsHash, region
        );
        (bool success, bytes memory returnData) = address(this).call(payload);
        require(success, "Factory deploy failed");
        return abi.decode(returnData, (address));
    }
}

import "@openzeppelin/contracts/utils/Strings.sol";
