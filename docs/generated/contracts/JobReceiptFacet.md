# JobReceiptFacet
> **Файл:** `src/JobReceiptFacet.sol`
> **Теги:** `nft` `reputation`

Soulbound NFT-квитанции за выполненные работы. Минтятся автоматически при закрытии сделки.

## Модификаторы доступа
- `onlyOwner`

## Events
| Event | Параметры |
|-------|-----------|
| `Transfer` | address indexed from, address indexed to, uint256 indexed tokenId |
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
| `getJobReceiptData(uint256)` | `ReceiptStorage.JobReceiptData memory` | — |
| `isJobReceiptToken(uint256)` | `bool` | — |
| `getReceiptTotalSupply()` | `uint256` | — |
