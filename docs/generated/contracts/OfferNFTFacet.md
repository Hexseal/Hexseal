# OfferNFTFacet
> **Файл:** `src/OfferNFTFacet.sol`
> **Теги:** `nft` `marketplace`

NFT-офферы исполнителей. ERC-1155, ограниченный supply, минт за USDC.

## Модификаторы доступа
- `nonReentrant`
- `onlyOwner`

## Events
| Event | Параметры |
|-------|-----------|
| `Transfer` | address indexed from, address indexed to, uint256 indexed tokenId |
| `Approval` | address indexed owner, address indexed approved, uint256 indexed tokenId |
| `ApprovalForAll` | address indexed owner, address indexed operator, bool approved |
| `OfferMinted` | uint256 indexed tokenId, address indexed executor, string title, string category, uint256 price |
| `OfferHired` | uint256 indexed tokenId, address indexed executor, address hirer |
| `OfferDeactivated` | uint256 indexed tokenId |
| `DealCreated` | uint256 indexed tokenId, address indexed client, address indexed executor, address agreement |
| `JobReceiptMinted` | uint256 indexed tokenId, uint256 indexed jobId, address indexed client |
| `SvgRendererUpdated` | address indexed renderer |

## Write Functions

### `setSvgRenderer`

**Mutability:** `nonpayable`  
**Access:** `onlyOwner`

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `renderer` | `address` | — |

**Returns:** `address`

---

### `mintOffer`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `title` | `string` | — |
| `category` | `string` | — |
| `price` | `uint256` | — |
| `deadlineDays` | `uint256` | — |
| `string` | `string` | — |

**Returns:** `uint256`

---

### `mintJobReceipt`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `to` | `address` | — |
| `jobId` | `uint256` | — |
| `amount` | `uint256` | — |
| `deadlineDays` | `uint256` | — |
| `region` | `uint8` | — |
| `title` | `string` | — |

**Returns:** `uint256 tokenId`

---

### `hireAndCreateDeal`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `tokenId` | `uint256` | — |
| `client` | `address` | — |
| `termsHash` | `bytes32` | — |
| `region` | `uint8` | — |

**Returns:** `address agreement`

---

### `deactivateOffer`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `tokenId` | `uint256` | — |

---

## View / Pure Functions

| Функция | Возвращает | Описание |
|---------|-----------|----------|
| `name()` | `string memory` | — |
| `symbol()` | `string memory` | — |
| `supportsInterface(bytes4)` | `bool` | — |
| `balanceOf(address)` | `uint256` | — |
| `ownerOf(uint256)` | `address` | — |
| `tokenURI(uint256)` | `string memory` | — |
| `transferFrom(address, address, uint256)` | `—` | — |
| `safeTransferFrom(address, address, uint256)` | `—` | — |
| `safeTransferFrom(address, address, uint256, bytes)` | `—` | — |
| `approve(address, uint256)` | `address` | — |
| `setApprovalForAll(address, bool)` | `address` | — |
| `getApproved(uint256)` | `address` | — |
| `isApprovedForAll(address, address)` | `bool` | — |
| `getSvgRenderer()` | `address` | — |
| `getOffer(uint256)` | `OfferNFTStorage.Offer memory` | — |
| `getExecutorOffers(address)` | `uint256[] memory` | — |
| `getOfferHires(uint256)` | `address[] memory` | — |
| `getTotalSupply()` | `uint256` | — |
| `getActiveOffersCount()` | `uint256` | — |
