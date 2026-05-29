// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// HEXSEAL — OfferNFTFacet.sol
// Soulbound NFT facet. Issues job receipt NFTs to clients
// when a deal is accepted (called internally by JobBoardFacet).
//
// SVG rendering delegated to external SVGRenderer contract.
// ============================================================

import "./FactoryFacet.sol";
import "./DiamondProxy.sol";
import "./SVGRenderer.sol";

// ─── Namespaced Storage ───────────────────────────────────────────────────────

library OfferNFTStorage {
    bytes32 constant POSITION = keccak256("hexseal.offernft.storage");

    // Slot layout must not change — fields below are reserved for storage continuity.
    // The Offer-related fields (slots 2-4) are deprecated but cannot be removed
    // without shifting isJobReceipt/jobReceiptData/jobReceiptMinted (slots 7-9).
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
        mapping(uint256 => Offer)     offers;           // deprecated
        mapping(address => uint256[]) executorOffers;   // deprecated
        mapping(uint256 => address[]) offerHires;       // deprecated
        mapping(address => uint256)   balances;
        mapping(uint256 => address)   owners;
        address _deprecated_receiptNFT;
        mapping(uint256 => bool)           isJobReceipt;
        mapping(uint256 => JobReceiptData) jobReceiptData;
        mapping(uint256 => bool)           jobReceiptMinted;
        address svgRenderer;
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 pos = POSITION;
        assembly { l.slot := pos }
    }
}

// ─── OfferNFTFacet ────────────────────────────────────────────────────────────

contract OfferNFTFacet {
    using Strings for uint256;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event JobReceiptMinted(uint256 indexed tokenId, uint256 indexed jobId, address indexed client);
    event SvgRendererUpdated(address indexed renderer);

    modifier onlyOwner() {
        if (msg.sender != OwnershipLib.contractOwner()) revert("Not owner");
        _;
    }

    // ─── ERC-721 Metadata ─────────────────────────────────────────────────────

    function name() external pure returns (string memory) { return "Hexseal NFT"; }
    function symbol() external pure returns (string memory) { return "HSEAL"; }

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
                tokenId:      tokenId,
                client:       r.client,
                title:        r.title,
                amount:       r.amount,
                deadlineDays: r.deadlineDays,
                region:       r.region,
                createdAt:    r.createdAt
            }));
        }

        // Legacy path for any old offer NFTs still in storage
        OfferNFTStorage.Offer storage o = s.offers[tokenId];
        return ISVGRenderer(renderer).renderOffer(ISVGRenderer.OfferParams({
            tokenId:      tokenId,
            executor:     o.executor,
            title:        o.title,
            category:     o.category,
            price:        o.price,
            deadlineDays: o.deadlineDays,
            createdAt:    o.createdAt,
            active:       o.active,
            hiresCount:   o.hiresCount
        }));
    }

    // Soulbound — all transfers blocked

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

    // ─── Admin ────────────────────────────────────────────────────────────────

    function setSvgRenderer(address renderer) external onlyOwner {
        require(renderer != address(0), "Zero address");
        OfferNFTStorage.layout().svgRenderer = renderer;
        emit SvgRendererUpdated(renderer);
    }

    function getSvgRenderer() external view returns (address) {
        return OfferNFTStorage.layout().svgRenderer;
    }

    // ─── Mint Job Receipt ─────────────────────────────────────────────────────

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
}

import "@openzeppelin/contracts/utils/Strings.sol";
