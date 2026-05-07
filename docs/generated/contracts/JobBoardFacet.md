# JobBoardFacet
> **Файл:** `src/facets/JobBoardFacet.sol`
> **Теги:** `marketplace` `jobs`

Доска заказов: клиент постит задание с бюджетом, исполнители подают заявки.

## Модификаторы доступа
- `nonReentrant`
- `whenNotPaused`

## Events
| Event | Параметры |
|-------|-----------|
| `JobPosted` | uint256 indexed jobId, address indexed client, uint256 amount, uint8 region |
| `JobApplied` | uint256 indexed jobId, address indexed executor |
| `JobAccepted` | uint256 indexed jobId, address indexed client, address indexed executor, address agreement |
| `JobCancelled` | uint256 indexed jobId, address indexed client, uint256 refundAmount |

## Custom Errors
| Error | Когда |
|-------|-------|
| `TitleInvalid` | — |
| `DescriptionTooLong` | — |
| `ZeroAmount` | — |
| `DeadlineInvalid` | — |
| `InvalidRegion` | — |
| `ZeroFee` | — |
| `NotClient` | — |
| `JobNotOpen` | — |
| `NotApplicant` | — |
| `AlreadyApplied` | — |
| `Reentrant` | — |
| `FactoryPaused` | — |
| `SelfApply` | — |

## Write Functions

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

**Returns:** `uint256`

**Reverts:** `TitleInvalid`, `DescriptionTooLong`, `ZeroAmount`, `DeadlineInvalid`, `InvalidRegion`, `ZeroFee`, `NotClient`, `JobNotOpen`, `NotApplicant`, `AlreadyApplied`, `Reentrant`, `FactoryPaused`, `SelfApply`

---

### `permit`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `owner` | `address` | — |
| `spender` | `address` | — |
| `value` | `uint256` | — |
| `deadline` | `uint256` | — |
| `v` | `uint8` | — |
| `r` | `bytes32` | — |
| `s` | `bytes32` | — |

**Returns:** `bool`

**Reverts:** `TitleInvalid`, `DescriptionTooLong`, `ZeroAmount`, `DeadlineInvalid`, `InvalidRegion`, `ZeroFee`, `NotClient`, `JobNotOpen`, `NotApplicant`, `AlreadyApplied`, `Reentrant`, `FactoryPaused`, `SelfApply`

---

### `transferFrom`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `from` | `address` | — |
| `to` | `address` | — |
| `amount` | `uint256` | — |

**Returns:** `bool`

**Reverts:** `TitleInvalid`, `DescriptionTooLong`, `ZeroAmount`, `DeadlineInvalid`, `InvalidRegion`, `ZeroFee`, `NotClient`, `JobNotOpen`, `NotApplicant`, `AlreadyApplied`, `Reentrant`, `FactoryPaused`, `SelfApply`

---

### `mintJobWithPermit`
> @notice Клиент создаёт заказ — gasless via off-chain USDC permit

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `client` | `address` | — |
| `title` | `string` | — |
| `description` | `string` | — |
| `amount` | `uint256` | — |
| `deadlineDays` | `uint256` | — |
| `termsHash` | `bytes32` | — |
| `region` | `uint8` | — |
| `permitDeadline` | `uint256` | — |
| `v` | `uint8` | — |
| `r` | `bytes32` | — |
| `s` | `bytes32` | — |

**Returns:** `uint256 jobId`

**Reverts:** `TitleInvalid`, `DescriptionTooLong`, `ZeroAmount`, `DeadlineInvalid`, `InvalidRegion`, `ZeroFee`, `NotClient`, `JobNotOpen`, `NotApplicant`, `AlreadyApplied`, `Reentrant`, `FactoryPaused`, `SelfApply`

---

### `mintJob`
> @dev Требует approve(diamond, fee + amount) до вызова

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `title` | `string` | — |
| `description` | `string` | — |
| `amount` | `uint256` | — |
| `deadlineDays` | `uint256` | — |
| `termsHash` | `bytes32` | — |
| `region` | `uint8` | — |

**Returns:** `uint256 jobId`

**Reverts:** `TitleInvalid`, `DescriptionTooLong`, `ZeroAmount`, `DeadlineInvalid`, `InvalidRegion`, `ZeroFee`, `NotClient`, `JobNotOpen`, `NotApplicant`, `AlreadyApplied`, `Reentrant`, `FactoryPaused`, `SelfApply`

---

### `applyForJob`
> @notice Исполнитель откликается на заказ (gasless-совместим через ERC-2771)

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `jobId` | `uint256` | — |

**Reverts:** `TitleInvalid`, `DescriptionTooLong`, `ZeroAmount`, `DeadlineInvalid`, `InvalidRegion`, `ZeroFee`, `NotClient`, `JobNotOpen`, `NotApplicant`, `AlreadyApplied`, `Reentrant`, `FactoryPaused`, `SelfApply`

---

### `acceptApplicant`
> @notice Клиент принимает исполнителя → Factory деплоит Agreement (gasless-совместим)

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `jobId` | `uint256` | — |
| `executor` | `address` | — |

**Returns:** `address agreementAddr`

**Reverts:** `TitleInvalid`, `DescriptionTooLong`, `ZeroAmount`, `DeadlineInvalid`, `InvalidRegion`, `ZeroFee`, `NotClient`, `JobNotOpen`, `NotApplicant`, `AlreadyApplied`, `Reentrant`, `FactoryPaused`, `SelfApply`

---

### `cancelJob`
> @notice Клиент отменяет заказ (amount рефандится, fee нет) — gasless-совместим

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `jobId` | `uint256` | — |

**Reverts:** `TitleInvalid`, `DescriptionTooLong`, `ZeroAmount`, `DeadlineInvalid`, `InvalidRegion`, `ZeroFee`, `NotClient`, `JobNotOpen`, `NotApplicant`, `AlreadyApplied`, `Reentrant`, `FactoryPaused`, `SelfApply`

---

## View / Pure Functions

| Функция | Возвращает | Описание |
|---------|-----------|----------|
| `getJob(uint256)` | `JobBoardStorage.Job memory` | — |
| `getClientJobs(address)` | `uint256[] memory` | — |
| `getApplicants(uint256)` | `address[] memory` | — |
| `totalJobs()` | `uint256` | — |
| `getOpenJobs()` | `uint256[] memory ids, JobBoardStorage.Job[] memory openJobs` | @notice Возвращает все OPEN-заказы с их ID |
