# ServiceBoardFacet
> **Файл:** `src/facets/ServiceBoardFacet.sol`
> **Теги:** `marketplace` `services`

Доска услуг: исполнитель постит услугу, клиенты запрашивают её выполнение.

## Модификаторы доступа
- `nonReentrant`
- `whenNotPaused`

## Events
| Event | Параметры |
|-------|-----------|
| `ServicePosted` | uint256 indexed serviceId, address indexed executor, uint256 price, uint8 region |
| `ServiceRemoved` | uint256 indexed serviceId, address indexed executor |
| `ServicePaused` | uint256 indexed serviceId |
| `ServiceUnpaused` | uint256 indexed serviceId |
| `ServiceRequested` | uint256 indexed requestId, uint256 indexed serviceId, address indexed client, uint256 amount |
| `RequestAccepted` | uint256 indexed requestId, address indexed executor, address indexed client, address agreement |
| `RequestRejected` | uint256 indexed requestId, address indexed executor, address indexed client |
| `RequestCancelled` | uint256 indexed requestId, address indexed client |

## Custom Errors
| Error | Когда |
|-------|-------|
| `TitleInvalid` | — |
| `DescriptionTooLong` | — |
| `ZeroAmount` | — |
| `DeadlineInvalid` | — |
| `InvalidRegion` | — |
| `ZeroFee` | — |
| `NotExecutor` | — |
| `NotClient` | — |
| `ServiceNotActive` | — |
| `RequestNotPending` | — |
| `Reentrant` | — |
| `FactoryPaused` | — |
| `SelfRequest` | — |

## Write Functions

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

**Reverts:** `TitleInvalid`, `DescriptionTooLong`, `ZeroAmount`, `DeadlineInvalid`, `InvalidRegion`, `ZeroFee`, `NotExecutor`, `NotClient`, `ServiceNotActive`, `RequestNotPending`, `Reentrant`, `FactoryPaused`, `SelfRequest`

---

### `mintService`
> @notice Исполнитель публикует услугу. Требует approve(diamond, fee) до вызова.

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `title` | `string` | — |
| `description` | `string` | — |
| `price` | `uint256` | — |
| `deadlineDays` | `uint256` | — |
| `region` | `uint8` | — |

**Returns:** `uint256 serviceId`

**Reverts:** `TitleInvalid`, `DescriptionTooLong`, `ZeroAmount`, `DeadlineInvalid`, `InvalidRegion`, `ZeroFee`, `NotExecutor`, `NotClient`, `ServiceNotActive`, `RequestNotPending`, `Reentrant`, `FactoryPaused`, `SelfRequest`

---

### `mintServiceWithPermit`
> @dev executor передаётся явно — msg.sender здесь форвардер (ERC-2771).

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `executor` | `address` | — |
| `title` | `string` | — |
| `description` | `string` | — |
| `price` | `uint256` | — |
| `deadlineDays` | `uint256` | — |
| `region` | `uint8` | — |
| `permitDeadline` | `uint256` | — |
| `v` | `uint8` | — |
| `r` | `bytes32` | — |
| `s` | `bytes32` | — |

**Returns:** `uint256 serviceId`

**Reverts:** `TitleInvalid`, `DescriptionTooLong`, `ZeroAmount`, `DeadlineInvalid`, `InvalidRegion`, `ZeroFee`, `NotExecutor`, `NotClient`, `ServiceNotActive`, `RequestNotPending`, `Reentrant`, `FactoryPaused`, `SelfRequest`

---

### `removeService`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `serviceId` | `uint256` | — |

**Reverts:** `TitleInvalid`, `DescriptionTooLong`, `ZeroAmount`, `DeadlineInvalid`, `InvalidRegion`, `ZeroFee`, `NotExecutor`, `NotClient`, `ServiceNotActive`, `RequestNotPending`, `Reentrant`, `FactoryPaused`, `SelfRequest`

---

### `pauseService`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `serviceId` | `uint256` | — |

**Reverts:** `TitleInvalid`, `DescriptionTooLong`, `ZeroAmount`, `DeadlineInvalid`, `InvalidRegion`, `ZeroFee`, `NotExecutor`, `NotClient`, `ServiceNotActive`, `RequestNotPending`, `Reentrant`, `FactoryPaused`, `SelfRequest`

---

### `unpauseService`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `serviceId` | `uint256` | — |

**Reverts:** `TitleInvalid`, `DescriptionTooLong`, `ZeroAmount`, `DeadlineInvalid`, `InvalidRegion`, `ZeroFee`, `NotExecutor`, `NotClient`, `ServiceNotActive`, `RequestNotPending`, `Reentrant`, `FactoryPaused`, `SelfRequest`

---

### `requestService`
> @param amount     Сумма сделки (может отличаться от price — договорились off-chain)

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `serviceId` | `uint256` | — |
| `amount` | `uint256` | — |
| `deadlineDays` | `uint256` | — |
| `termsHash` | `bytes32` | — |
| `region` | `uint8` | — |

**Returns:** `uint256 requestId`

**Reverts:** `TitleInvalid`, `DescriptionTooLong`, `ZeroAmount`, `DeadlineInvalid`, `InvalidRegion`, `ZeroFee`, `NotExecutor`, `NotClient`, `ServiceNotActive`, `RequestNotPending`, `Reentrant`, `FactoryPaused`, `SelfRequest`

---

### `requestServiceWithPermit`
> @dev client передаётся явно — msg.sender здесь форвардер (ERC-2771).

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `client` | `address` | — |
| `serviceId` | `uint256` | — |
| `amount` | `uint256` | — |
| `deadlineDays` | `uint256` | — |
| `termsHash` | `bytes32` | — |
| `region` | `uint8` | — |
| `permitDeadline` | `uint256` | — |
| `v` | `uint8` | — |
| `r` | `bytes32` | — |
| `s` | `bytes32` | — |

**Returns:** `uint256 requestId`

**Reverts:** `TitleInvalid`, `DescriptionTooLong`, `ZeroAmount`, `DeadlineInvalid`, `InvalidRegion`, `ZeroFee`, `NotExecutor`, `NotClient`, `ServiceNotActive`, `RequestNotPending`, `Reentrant`, `FactoryPaused`, `SelfRequest`

---

### `acceptRequest`
> @notice Исполнитель принимает запрос → деплоит Agreement, переводит amount из Diamond.

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `requestId` | `uint256` | — |

**Returns:** `address agreementAddr`

**Reverts:** `TitleInvalid`, `DescriptionTooLong`, `ZeroAmount`, `DeadlineInvalid`, `InvalidRegion`, `ZeroFee`, `NotExecutor`, `NotClient`, `ServiceNotActive`, `RequestNotPending`, `Reentrant`, `FactoryPaused`, `SelfRequest`

---

### `rejectRequest`
> @notice Исполнитель отклоняет запрос → amount рефандится клиенту.

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `requestId` | `uint256` | — |

**Reverts:** `TitleInvalid`, `DescriptionTooLong`, `ZeroAmount`, `DeadlineInvalid`, `InvalidRegion`, `ZeroFee`, `NotExecutor`, `NotClient`, `ServiceNotActive`, `RequestNotPending`, `Reentrant`, `FactoryPaused`, `SelfRequest`

---

### `cancelRequest`
> @notice Клиент отменяет запрос пока он PENDING → amount рефандится.

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `requestId` | `uint256` | — |

**Reverts:** `TitleInvalid`, `DescriptionTooLong`, `ZeroAmount`, `DeadlineInvalid`, `InvalidRegion`, `ZeroFee`, `NotExecutor`, `NotClient`, `ServiceNotActive`, `RequestNotPending`, `Reentrant`, `FactoryPaused`, `SelfRequest`

---

## View / Pure Functions

| Функция | Возвращает | Описание |
|---------|-----------|----------|
| `getService(uint256)` | `ServiceBoardStorage.Service memory` | — |
| `getExecutorServices(address)` | `uint256[] memory` | — |
| `getServiceClients(uint256)` | `address[] memory` | — |
| `totalServices()` | `uint256` | — |
| `getRequest(uint256)` | `ServiceBoardStorage.HireRequest memory` | — |
| `getServiceRequests(uint256)` | `uint256[] memory` | — |
| `getClientRequests(address)` | `uint256[] memory` | — |
| `totalRequests()` | `uint256` | — |
| `getRequestFunds(uint256)` | `uint256` | — |
| `getActiveServices()` | `uint256[] memory ids,
        ServiceBoardStorage.Service[] memory activeServices` | @notice Все активные услуги с их ID |
| `getPendingRequests(uint256)` | `uint256[] memory ids,
        ServiceBoardStorage.HireRequest[] memory pendingReqs` | @notice Ожидающие (PENDING) запросы на услугу |
