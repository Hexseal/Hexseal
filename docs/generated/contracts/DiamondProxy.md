# DiamondProxy
> **Файл:** `src/DiamondProxy.sol`
> **Теги:** `core` `upgradeable`

Главный прокси-контракт. Содержит DiamondCut, DiamondLoupe и OwnershipFacet. Все вызовы проксируются через fallback к соответствующим фасетам.

## Events
| Event | Параметры |
|-------|-----------|
| `DiamondCut` | FacetCut[] _diamondCut, address _init, bytes _calldata |
| `OwnershipTransferred` | address indexed previousOwner, address indexed newOwner |
| `DiamondCut` | IDiamondCut.FacetCut[] _diamondCut, address _init, bytes _calldata |
| `OwnershipTransferred` | address indexed previousOwner, address indexed newOwner |

## Write Functions

### `diamondCut`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `_diamondCut` | `FacetCut[]` | — |
| `_init` | `address` | — |
| `_calldata` | `bytes` | — |

---

### `diamondCut`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `_diamondCut` | `FacetCut[]` | — |
| `_init` | `address` | — |
| `_calldata` | `bytes` | — |

---

### `transferOwnership`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `_newOwner` | `address` | — |

**Returns:** `address owner_`

---

## View / Pure Functions

| Функция | Возвращает | Описание |
|---------|-----------|----------|
| `facets()` | `Facet[] memory facets_` | — |
| `facetFunctionSelectors(address)` | `bytes4[] memory facetFunctionSelectors_` | — |
| `facetAddresses()` | `address[] memory facetAddresses_` | — |
| `facetAddress(bytes4)` | `address facetAddress_` | — |
| `facets()` | `Facet[] memory facets_` | — |
| `facetFunctionSelectors(address)` | `bytes4[] memory facetFunctionSelectors_` | — |
| `facetAddresses()` | `address[] memory facetAddresses_` | — |
| `facetAddress(bytes4)` | `address facetAddress_` | — |
| `supportsInterface(bytes4)` | `bool` | — |
| `owner()` | `address owner_` | — |
