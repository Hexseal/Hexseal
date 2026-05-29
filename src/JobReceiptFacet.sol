// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// HEXSEAL — JobReceiptFacet.sol
//
// Soulbound NFT-квитанция клиента при размещении заказа.
// Минтится автоматически из JobBoardFacet через internal Diamond call.
//
// Использует тот же namespaced storage slot что и OfferNFTFacet
// (keccak256("hexseal.offernft.storage")) — данные сохраняются.
//
// OfferNFTFacet выпилен из Diamond — этот фасет его заменяет.
// ============================================================

import "./DiamondProxy.sol";
import "./SVGRenderer.sol";

// ─── Storage (same slot as OfferNFTFacet — data preserved) ───────────────────

library ReceiptStorage {
    bytes32 constant POSITION = keccak256("hexseal.offernft.storage");

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
        mapping(uint256 => address)  _offers_executor;   // deprecated
        mapping(address => uint256[]) _executorOffers;   // deprecated
        mapping(uint256 => address[]) _offerHires;       // deprecated
        mapping(address => uint256)  balances;
        mapping(uint256 => address)  owners;
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

// ─── JobReceiptFacet ──────────────────────────────────────────────────────────

contract JobReceiptFacet {

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event JobReceiptMinted(uint256 indexed tokenId, uint256 indexed jobId, address indexed client);
    event SvgRendererUpdated(address indexed renderer);

    modifier onlyOwner() {
        if (msg.sender != OwnershipLib.contractOwner()) revert("Not owner");
        _;
    }

    // ─── ERC-721 Metadata ─────────────────────────────────────────────────────

    function name()   external pure returns (string memory) { return "Hexseal Receipt"; }
    function symbol() external pure returns (string memory) { return "HSEALR"; }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x80ac58cd
            || interfaceId == 0x5b5e139f
            || interfaceId == 0x01ffc9a7;
    }

    // ─── ERC-721 Views ────────────────────────────────────────────────────────

    function balanceOf(address owner) external view returns (uint256) {
        require(owner != address(0), "ERC721: zero address");
        return ReceiptStorage.layout().balances[owner];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address owner = ReceiptStorage.layout().owners[tokenId];
        require(owner != address(0), "ERC721: nonexistent token");
        return owner;
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ReceiptStorage.Layout storage s = ReceiptStorage.layout();
        require(s.owners[tokenId] != address(0), "ERC721: nonexistent token");
        require(s.isJobReceipt[tokenId], "Not a receipt token");

        address renderer = s.svgRenderer;
        require(renderer != address(0), "SVGRenderer not set");

        ReceiptStorage.JobReceiptData storage r = s.jobReceiptData[tokenId];
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

    // ─── Soulbound — все transfer/approve заблокированы ──────────────────────

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
        ReceiptStorage.layout().svgRenderer = renderer;
        emit SvgRendererUpdated(renderer);
    }

    function getSvgRenderer() external view returns (address) {
        return ReceiptStorage.layout().svgRenderer;
    }

    // ─── Core: Mint Receipt ───────────────────────────────────────────────────

    function mintJobReceipt(
        address to,
        uint256 jobId,
        uint256 amount,
        uint256 deadlineDays,
        uint8   region,
        string calldata title
    ) external returns (uint256 tokenId) {
        require(msg.sender == address(this), "Only Diamond");

        ReceiptStorage.Layout storage s = ReceiptStorage.layout();
        if (s.jobReceiptMinted[jobId]) return type(uint256).max;

        s.jobReceiptMinted[jobId] = true;
        tokenId = s.nextTokenId++;

        s.isJobReceipt[tokenId] = true;
        s.jobReceiptData[tokenId] = ReceiptStorage.JobReceiptData({
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

    // ─── Views ────────────────────────────────────────────────────────────────

    function getJobReceiptData(uint256 tokenId) external view returns (ReceiptStorage.JobReceiptData memory) {
        ReceiptStorage.Layout storage s = ReceiptStorage.layout();
        require(s.isJobReceipt[tokenId], "Not a receipt token");
        return s.jobReceiptData[tokenId];
    }

    function isJobReceiptToken(uint256 tokenId) external view returns (bool) {
        return ReceiptStorage.layout().isJobReceipt[tokenId];
    }

    function getReceiptTotalSupply() external view returns (uint256) {
        return ReceiptStorage.layout().nextTokenId;
    }
}
