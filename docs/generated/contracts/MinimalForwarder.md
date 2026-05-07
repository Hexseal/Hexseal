# MinimalForwarder
> **Файл:** `src/MinimalForwarder.sol`
> **Теги:** `gasless` `relay`

EIP-712 форвардер для мета-транзакций (ERC-2771). Принимает подписанные запросы и вызывает целевой контракт.

## Events
| Event | Параметры |
|-------|-----------|
| `Executed` | address indexed from, address indexed to, bool success |

## Write Functions

### `execute`

**Mutability:** `payable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `req` | `struct MinimalForwarder.ForwardRequest` | — |
| `signature` | `bytes` | — |

**Returns:** `bool success, bytes memory retdata`

---

## View / Pure Functions

| Функция | Возвращает | Описание |
|---------|-----------|----------|
| `getNonce(address)` | `uint256` | — |
| `verify(ForwardRequest, bytes)` | `bool` | — |
