# ArbiterRegistryFacet
> **Файл:** `src/facets/ArbiterRegistryFacet.sol`
> **Теги:** `arbitration` `admin` `gasless`

Реестр арбитров. Commit-reveal клейм споров, история решений, управление chief arbiter.

## Модификаторы доступа
- `onlyOwner`
- `onlyOwnerOrChief`

## Events
| Event | Параметры |
|-------|-----------|
| `ArbiterAdded` | address indexed arbiter |
| `ArbiterRemoved` | address indexed arbiter |
| `ChiefArbiterSet` | address indexed prev, address indexed next |
| `DisputeClaimCommitted` | address indexed arbiter, bytes32 indexed commitment |
| `DisputeClaimed` | address indexed agreement, address indexed arbiter |
| `DisputeReleased` | address indexed agreement, address indexed prevArbiter |

## Custom Errors
| Error | Когда |
|-------|-------|
| `NotOwner` | — |
| `NotOwnerOrChief` | — |
| `NotArbiter` | — |
| `AlreadyArbiter` | — |
| `NotAnArbiter` | — |
| `AlreadyClaimed` | — |
| `NotClaimed` | — |
| `NotDisputed` | — |
| `NotAuthorized` | — |
| `CommitmentNotFound` | — |
| `CommitmentTooEarly` | — |
| `CommitmentExpired` | — |

## Write Functions

### `setArbiter`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `newArbiter` | `address` | — |

**Returns:** `address`

**Reverts:** `NotOwner`, `NotOwnerOrChief`, `NotArbiter`, `AlreadyArbiter`, `NotAnArbiter`, `AlreadyClaimed`, `NotClaimed`, `NotDisputed`, `NotAuthorized`, `CommitmentNotFound`, `CommitmentTooEarly`, `CommitmentExpired`

---

### `setChiefArbiter`
> @notice Назначить главного арбитра. Только owner.

**Mutability:** `nonpayable`  
**Access:** `onlyOwner`

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `arbiter` | `address` | — |

**Reverts:** `NotOwner`, `NotOwnerOrChief`, `NotArbiter`, `AlreadyArbiter`, `NotAnArbiter`, `AlreadyClaimed`, `NotClaimed`, `NotDisputed`, `NotAuthorized`, `CommitmentNotFound`, `CommitmentTooEarly`, `CommitmentExpired`

---

### `addArbiter`
> @notice Добавить арбитра в реестр. Owner или chief arbiter.

**Mutability:** `nonpayable`  
**Access:** `onlyOwner`, `onlyOwnerOrChief`

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `arbiter` | `address` | — |

**Reverts:** `NotOwner`, `NotOwnerOrChief`, `NotArbiter`, `AlreadyArbiter`, `NotAnArbiter`, `AlreadyClaimed`, `NotClaimed`, `NotDisputed`, `NotAuthorized`, `CommitmentNotFound`, `CommitmentTooEarly`, `CommitmentExpired`

---

### `removeArbiter`
> @notice Убрать арбитра из реестра. Owner или chief arbiter.

**Mutability:** `nonpayable`  
**Access:** `onlyOwner`, `onlyOwnerOrChief`

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `arbiter` | `address` | — |

**Reverts:** `NotOwner`, `NotOwnerOrChief`, `NotArbiter`, `AlreadyArbiter`, `NotAnArbiter`, `AlreadyClaimed`, `NotClaimed`, `NotDisputed`, `NotAuthorized`, `CommitmentNotFound`, `CommitmentTooEarly`, `CommitmentExpired`

---

### `commitDisputeClaim`
> Раскрывать можно не раньше следующего блока — защита от фронтраннинга.

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `commitment` | `bytes32` | — |

**Reverts:** `NotOwner`, `NotOwnerOrChief`, `NotArbiter`, `AlreadyArbiter`, `NotAnArbiter`, `AlreadyClaimed`, `NotClaimed`, `NotDisputed`, `NotAuthorized`, `CommitmentNotFound`, `CommitmentTooEarly`, `CommitmentExpired`

---

### `claimDispute`
> Вызывает Agreement.setArbiter(caller) через Diamond delegatecall.

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `agreement` | `address` | — |
| `salt` | `bytes32` | — |

**Reverts:** `NotOwner`, `NotOwnerOrChief`, `NotArbiter`, `AlreadyArbiter`, `NotAnArbiter`, `AlreadyClaimed`, `NotClaimed`, `NotDisputed`, `NotAuthorized`, `CommitmentNotFound`, `CommitmentTooEarly`, `CommitmentExpired`

---

### `releaseDisputeClaim`
> @notice Снять клейм (арбитр или owner). Освобождает сделку для другого арбитра.

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `agreement` | `address` | — |

**Reverts:** `NotOwner`, `NotOwnerOrChief`, `NotArbiter`, `AlreadyArbiter`, `NotAnArbiter`, `AlreadyClaimed`, `NotClaimed`, `NotDisputed`, `NotAuthorized`, `CommitmentNotFound`, `CommitmentTooEarly`, `CommitmentExpired`

---

### `clearDisputeClaim`
> Только Agreement сам может очистить свой клейм — msg.sender == agreement.

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `agreement` | `address` | — |

**Reverts:** `NotOwner`, `NotOwnerOrChief`, `NotArbiter`, `AlreadyArbiter`, `NotAnArbiter`, `AlreadyClaimed`, `NotClaimed`, `NotDisputed`, `NotAuthorized`, `CommitmentNotFound`, `CommitmentTooEarly`, `CommitmentExpired`

---

## View / Pure Functions

| Функция | Возвращает | Описание |
|---------|-----------|----------|
| `status()` | `uint8` | — |
| `client()` | `address` | — |
| `executor()` | `address` | — |
| `amount()` | `uint256` | — |
| `disputedAt()` | `uint256` | — |
| `getChiefArbiter()` | `address` | — |
| `isRegisteredArbiter(address)` | `bool` | — |
| `getArbiters()` | `address[] memory` | — |
| `getDisputeClaimer(address)` | `address` | — |
| `getArbiterDeals(address)` | `address[] memory` | @notice История сделок арбитра (все когда-либо взятые им) |
| `getClaimCommitment(bytes32)` | `uint256` | @notice Блок в котором был сохранён коммит (0 если не существует или удалён) |
