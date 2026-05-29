// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "/Users/tvoybatya/Documents/hexseal/node_modules/@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "/Users/tvoybatya/Documents/hexseal/node_modules/@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "/Users/tvoybatya/Documents/hexseal/node_modules/@openzeppelin/contracts/access/Ownable.sol";
import "/Users/tvoybatya/Documents/hexseal/node_modules/@openzeppelin/contracts/utils/Strings.sol";
import "/Users/tvoybatya/Documents/hexseal/node_modules/@openzeppelin/contracts/security/Pausable.sol";
import "/Users/tvoybatya/Documents/hexseal/node_modules/@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

contract Hexseal is ERC721, Ownable, Pausable, ReentrancyGuard {
    using Strings for uint256;
    using EnumerableSet for EnumerableSet.UintSet;

    error NotOwnerOrApproved();
    error TokenLocked();
    error WrongPrice();
    error SupplyExceeded();
    error TokenNotExists();
    error InvalidWorkDescription();
    error WorkAlreadyActivated();
    error WorkNotActive();
    error InsufficientFunds();
    error CannotBurnActiveWork();

    struct WorkData {
        string description;
        uint256 activatedAt;
        uint256 completedAt;
        uint256 estimatedDays;
        bool isActive;
    }

    uint256 public immutable maxSupply;
    uint256 public price;
    address payable public feeRecipient;
    string private baseURI_;
    uint256 private _nextId = 1;

    mapping(uint256 => WorkData) public workDetails;
    mapping(uint256 => bool) public isBurned;
    
    // Оптимизированное хранение активных токенов
    EnumerableSet.UintSet private activeTokensSet;

    // Статистика
    uint256 public totalCompleted;
    uint256 public averageCompletionTime;
    mapping(address => uint256) public clientOrders;

    event Minted(address indexed to, uint256 indexed tokenId, uint256 price);
    event Activated(uint256 indexed tokenId, string description, uint256 estimatedDays);
    event Completed(uint256 indexed tokenId, uint256 actualDays);
    event Burned(uint256 indexed tokenId);
    event PriceUpdated(uint256 newPrice);
    event BaseURIUpdated(string newBaseURI);
    event FeeRecipientUpdated(address newRecipient);
    event WorkDescriptionUpdated(uint256 indexed tokenId, string description);
    event Refunded(uint256 indexed tokenId, address indexed to, uint256 amount);

    constructor(
        string memory name_,
        string memory symbol_,
        string memory baseURIInit,
        uint256 priceInit,
        uint256 maxSupplyInit,
        address payable feeRecipientInit
    ) ERC721(name_, symbol_) Ownable() {
        baseURI_ = baseURIInit;
        price = priceInit;
        maxSupply = maxSupplyInit;
        feeRecipient = feeRecipientInit;
    }

    // ---------- МИНТ ----------
    function mint() external payable whenNotPaused nonReentrant {
        if (msg.value != price) revert WrongPrice();
        uint256 tokenId = _nextId;
        if (tokenId > maxSupply) revert SupplyExceeded();

        unchecked {
            _nextId++;
            clientOrders[msg.sender]++;
        }

        _safeMint(msg.sender, tokenId);
        emit Minted(msg.sender, tokenId, msg.value);
    }

    // ---------- АКТИВАЦИЯ ----------
    function activate(
        uint256 tokenId, 
        string calldata description, 
        uint256 estimatedDays
    ) external onlyOwner {
        if (!_exists(tokenId)) revert TokenNotExists();
        if (bytes(description).length == 0) revert InvalidWorkDescription();
        if (workDetails[tokenId].isActive) revert WorkAlreadyActivated();

        // Очищаем старые данные если они были
        delete workDetails[tokenId];
        
        workDetails[tokenId] = WorkData({
            description: description,
            activatedAt: block.timestamp,
            completedAt: 0,
            estimatedDays: estimatedDays,
            isActive: true
        });

        activeTokensSet.add(tokenId);
        emit Activated(tokenId, description, estimatedDays);
    }

    // ---------- ЗАВЕРШЕНИЕ ----------
    function complete(uint256 tokenId) external onlyOwner {
        if (!_exists(tokenId)) revert TokenNotExists();
        if (!workDetails[tokenId].isActive) revert WorkNotActive();

        uint256 actualDays = (block.timestamp - workDetails[tokenId].activatedAt) / 1 days;

        workDetails[tokenId].completedAt = block.timestamp;
        workDetails[tokenId].isActive = false;

        activeTokensSet.remove(tokenId);

        // Обновляем статистику с защитой от переполнения
        unchecked {
            totalCompleted++;
        }
        
        if (totalCompleted == 1) {
            averageCompletionTime = actualDays;
        } else {
            averageCompletionTime = ((averageCompletionTime * (totalCompleted - 1)) + actualDays) / totalCompleted;
        }

        emit Completed(tokenId, actualDays);
    }

    // ---------- ОБНОВЛЕНИЕ ОПИСАНИЯ ----------
    function updateWorkDescription(uint256 tokenId, string calldata newDescription) external onlyOwner {
        if (!_exists(tokenId)) revert TokenNotExists();
        if (bytes(newDescription).length == 0) revert InvalidWorkDescription();

        workDetails[tokenId].description = newDescription;
        emit WorkDescriptionUpdated(tokenId, newDescription);
    }

    // ---------- БЁРН ----------
    function burn(uint256 tokenId) external {
        if (!_isApprovedOrOwner(msg.sender, tokenId)) revert NotOwnerOrApproved();
        
        // Защита от сжигания активных работ
        if (workDetails[tokenId].isActive) revert CannotBurnActiveWork();

        isBurned[tokenId] = true;
        delete workDetails[tokenId];
        _burn(tokenId);

        emit Burned(tokenId);
    }

    // ---------- БЛОК ПЕРЕВОДОВ ----------
    function _beforeTokenTransfer(
        address from, 
        address to, 
        uint256 tokenId, 
        uint256 batchSize
    ) internal override whenNotPaused {
        super._beforeTokenTransfer(from, to, tokenId, batchSize);
        
        // Блокируем трансфер активных работ
        if (from != address(0) && to != address(0) && workDetails[tokenId].isActive) {
            revert TokenLocked();
        }
    }

    // ---------- ВЫВОД СРЕДСТВ ----------
    function withdraw() external nonReentrant onlyOwner {
        uint256 balance = address(this).balance;
        if (balance == 0) revert InsufficientFunds();
        
        (bool success, ) = feeRecipient.call{value: balance}("");
        require(success, "Withdraw failed");
    }

    // ---------- ВОЗВРАТ СРЕДСТВ ----------
    function emergencyRefund(uint256 tokenId, bool burnAfterRefund) external onlyOwner {
        if (!_exists(tokenId)) revert TokenNotExists();
        if (!workDetails[tokenId].isActive) revert WorkNotActive();
        if (address(this).balance < price) revert InsufficientFunds();

        address tokenOwner = ownerOf(tokenId);
        workDetails[tokenId].isActive = false;
        
        activeTokensSet.remove(tokenId);

        (bool success, ) = payable(tokenOwner).call{value: price}("");
        require(success, "Refund failed");

        emit Refunded(tokenId, tokenOwner, price);
        
        // Опциональное сжигание после возврата
        if (burnAfterRefund) {
            isBurned[tokenId] = true;
            delete workDetails[tokenId];
            _burn(tokenId);
            emit Burned(tokenId);
        }
    }

    // ---------- VIEW ФУНКЦИИ ----------
    function getActiveWorks() external view returns (uint256[] memory) {
        return activeTokensSet.values();
    }

    function getActiveWorksCount() external view returns (uint256) {
        return activeTokensSet.length();
    }

    function isTokenActive(uint256 tokenId) external view returns (bool) {
        return activeTokensSet.contains(tokenId);
    }

    function totalSupply() public view returns (uint256) {
        return _nextId - 1;
    }

    function getWorkDetails(uint256 tokenId) external view returns (WorkData memory) {
        if (!_exists(tokenId)) revert TokenNotExists();
        return workDetails[tokenId];
    }

    function getReputationStats() external view returns (
        uint256 completed, 
        uint256 avgTime, 
        uint256 total,
        uint256 active
    ) {
        return (totalCompleted, averageCompletionTime, totalSupply(), activeTokensSet.length());
    }

    // ---------- АДМИН ----------
    function setPrice(uint256 newPrice) external onlyOwner {
        price = newPrice;
        emit PriceUpdated(newPrice);
    }

    function setBaseURI(string calldata newBaseURI) external onlyOwner {
        baseURI_ = newBaseURI;
        emit BaseURIUpdated(newBaseURI);
    }

    function setFeeRecipient(address payable newRecipient) external onlyOwner {
        require(newRecipient != address(0), "Invalid recipient");
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(newRecipient);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------- МЕТАДАННЫЕ ----------
    function _baseURI() internal view override returns (string memory) {
        return baseURI_;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_exists(tokenId), "Token doesn't exist");
        return bytes(baseURI_).length > 0 
            ? string(abi.encodePacked(baseURI_, tokenId.toString()))
            : "";
    }

    // Batch операции для экономии газа
    function batchActivate(
        uint256[] calldata tokenIds,
        string[] calldata descriptions,
        uint256[] calldata estimatedDays
    ) external onlyOwner {
        require(
            tokenIds.length == descriptions.length && 
            descriptions.length == estimatedDays.length,
            "Array length mismatch"
        );

        for (uint256 i = 0; i < tokenIds.length;) {
            this.activate(tokenIds[i], descriptions[i], estimatedDays[i]);
            unchecked { i++; }
        }
    }

    function batchComplete(uint256[] calldata tokenIds) external onlyOwner {
        for (uint256 i = 0; i < tokenIds.length;) {
            this.complete(tokenIds[i]);
            unchecked { i++; }
        }
    }
}