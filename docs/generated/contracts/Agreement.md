# Agreement
> **Файл:** `src/Agreement.sol`
> **Теги:** `escrow` `core` `gasless`

Эскроу-контракт между клиентом и исполнителем. ERC-2771 gasless, USDC permit, reentrancy guard, автоапрув по таймауту.

## Модификаторы доступа
- `nonReentrant`

## Events
| Event | Параметры |
|-------|-----------|
| `Transfer` | address indexed from, address indexed to, uint256 indexed tokenId |
| `Approval` | address indexed owner, address indexed approved, uint256 indexed tokenId |
| `ApprovalForAll` | address indexed owner, address indexed operator, bool approved |
| `Funded` | address indexed client, uint256 amount |
| `Activated` | address indexed executor |
| `MarkedDone` | address indexed executor |
| `Released` | address indexed client, address indexed executor, uint256 amount |
| `AutoApproved` | address indexed executor, uint256 amount |
| `DisputeRaised` | address indexed by |
| `DisputeResolved` | address indexed arbiter, bool clientWins, uint256 amount |
| `TimedOut` | address indexed client, uint256 amount |
| `ArbiterTimedOut` | address indexed client, uint256 amount |
| `RegistrySyncFailed` | address indexed agreement, uint8 targetStatus |

## Custom Errors
| Error | Когда |
|-------|-------|
| `ERC721NonexistentToken` | uint256 tokenId |
| `ERC721NotOwnerOrApproved` | — |
| `ERC721TransferToZeroAddress` | — |
| `ERC721AlreadyMinted` | — |
| `TokenSoulbound` | — |
| `NotClient` | — |
| `NotExecutor` | — |
| `NotArbiter` | — |
| `NotParty` | — |
| `AlreadyFunded` | — |
| `NotFunded` | — |
| `NotActive` | — |
| `AlreadyActive` | — |
| `AlreadyMarkedDone` | — |
| `NotMarkedDone` | — |
| `AlreadyDisputed` | — |
| `NotDisputed` | — |
| `AlreadyResolved` | — |
| `AlreadyFinalized` | — |
| `WindowNotPassed` | — |
| `WindowAlreadyPassed` | — |
| `DeadlinePassed` | — |
| `DeadlineNotPassed` | — |
| `ActivationWindowPassed` | — |
| `ArbiterWindowNotPassed` | — |
| `NoArbiterSet` | — |
| `WrongAmount` | — |

## Write Functions

### `approve`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `to` | `address` | — |
| `tokenId` | `uint256` | — |

**Reverts:** `ERC721NonexistentToken`, `ERC721TransferToZeroAddress`, `ERC721AlreadyMinted`, `TokenSoulbound`, `NotClient`, `NotExecutor`, `NotArbiter`, `NotParty`, `AlreadyFunded`, `NotFunded`, `NotActive`, `AlreadyActive`, `AlreadyMarkedDone`, `NotMarkedDone`, `AlreadyDisputed`, `NotDisputed`, `AlreadyResolved`, `AlreadyFinalized`, `WindowNotPassed`, `WindowAlreadyPassed`, `DeadlinePassed`, `DeadlineNotPassed`, `ActivationWindowPassed`, `NoArbiterSet`

---

### `setApprovalForAll`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `operator` | `address` | — |
| `approved` | `bool` | — |

**Reverts:** `ERC721NonexistentToken`, `ERC721TransferToZeroAddress`, `ERC721AlreadyMinted`, `TokenSoulbound`, `NotClient`, `NotExecutor`, `NotArbiter`, `NotParty`, `AlreadyFunded`, `NotFunded`, `NotActive`, `AlreadyActive`, `AlreadyMarkedDone`, `NotMarkedDone`, `AlreadyDisputed`, `NotDisputed`, `AlreadyResolved`, `AlreadyFinalized`, `WindowNotPassed`, `WindowAlreadyPassed`, `DeadlinePassed`, `DeadlineNotPassed`, `ActivationWindowPassed`, `NoArbiterSet`

---

### `transferFrom`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `from` | `address` | — |
| `to` | `address` | — |
| `tokenId` | `uint256` | — |

**Reverts:** `ERC721NonexistentToken`, `ERC721TransferToZeroAddress`, `ERC721AlreadyMinted`, `TokenSoulbound`, `NotClient`, `NotExecutor`, `NotArbiter`, `NotParty`, `AlreadyFunded`, `NotFunded`, `NotActive`, `AlreadyActive`, `AlreadyMarkedDone`, `NotMarkedDone`, `AlreadyDisputed`, `NotDisputed`, `AlreadyResolved`, `AlreadyFinalized`, `WindowNotPassed`, `WindowAlreadyPassed`, `DeadlinePassed`, `DeadlineNotPassed`, `ActivationWindowPassed`, `NoArbiterSet`

---

### `safeTransferFrom`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `from` | `address` | — |
| `to` | `address` | — |
| `tokenId` | `uint256` | — |
| `bytes` | `bytes` | — |

**Reverts:** `ERC721NonexistentToken`, `ERC721TransferToZeroAddress`, `ERC721AlreadyMinted`, `TokenSoulbound`, `NotClient`, `NotExecutor`, `NotArbiter`, `NotParty`, `AlreadyFunded`, `NotFunded`, `NotActive`, `AlreadyActive`, `AlreadyMarkedDone`, `NotMarkedDone`, `AlreadyDisputed`, `NotDisputed`, `AlreadyResolved`, `AlreadyFinalized`, `WindowNotPassed`, `WindowAlreadyPassed`, `DeadlinePassed`, `DeadlineNotPassed`, `ActivationWindowPassed`, `NoArbiterSet`

---

### `safeTransferFrom`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `from` | `address` | — |
| `to` | `address` | — |
| `tokenId` | `uint256` | — |
| `bytes` | `bytes` | — |

**Reverts:** `ERC721NonexistentToken`, `ERC721TransferToZeroAddress`, `ERC721AlreadyMinted`, `TokenSoulbound`, `NotClient`, `NotExecutor`, `NotArbiter`, `NotParty`, `AlreadyFunded`, `NotFunded`, `NotActive`, `AlreadyActive`, `AlreadyMarkedDone`, `NotMarkedDone`, `AlreadyDisputed`, `NotDisputed`, `AlreadyResolved`, `AlreadyFinalized`, `WindowNotPassed`, `WindowAlreadyPassed`, `DeadlinePassed`, `DeadlineNotPassed`, `ActivationWindowPassed`, `NoArbiterSet`

---

### `updateStatus`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `agreement` | `address` | — |
| `newStatus` | `AgreementStatus` | — |

**Reverts:** `ERC721NonexistentToken`, `ERC721TransferToZeroAddress`, `ERC721AlreadyMinted`, `TokenSoulbound`, `NotClient`, `NotExecutor`, `NotArbiter`, `NotParty`, `AlreadyFunded`, `NotFunded`, `NotActive`, `AlreadyActive`, `AlreadyMarkedDone`, `NotMarkedDone`, `AlreadyDisputed`, `NotDisputed`, `AlreadyResolved`, `AlreadyFinalized`, `WindowNotPassed`, `WindowAlreadyPassed`, `DeadlinePassed`, `DeadlineNotPassed`, `ActivationWindowPassed`, `NoArbiterSet`

---

### `clearDisputeClaim`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `agreement` | `address` | — |

**Reverts:** `ERC721NonexistentToken`, `ERC721TransferToZeroAddress`, `ERC721AlreadyMinted`, `TokenSoulbound`, `NotClient`, `NotExecutor`, `NotArbiter`, `NotParty`, `AlreadyFunded`, `NotFunded`, `NotActive`, `AlreadyActive`, `AlreadyMarkedDone`, `NotMarkedDone`, `AlreadyDisputed`, `NotDisputed`, `AlreadyResolved`, `AlreadyFinalized`, `WindowNotPassed`, `WindowAlreadyPassed`, `DeadlinePassed`, `DeadlineNotPassed`, `ActivationWindowPassed`, `NoArbiterSet`

---

### `setArbiter`
> Только Diamond может вызвать — проверяем msg.sender напрямую (не ERC-2771).

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `newArbiter` | `address` | — |

**Reverts:** `ERC721NonexistentToken`, `ERC721TransferToZeroAddress`, `ERC721AlreadyMinted`, `TokenSoulbound`, `NotClient`, `NotExecutor`, `NotArbiter`, `NotParty`, `AlreadyFunded`, `NotFunded`, `NotActive`, `AlreadyActive`, `AlreadyMarkedDone`, `NotMarkedDone`, `AlreadyDisputed`, `NotDisputed`, `AlreadyResolved`, `AlreadyFinalized`, `WindowNotPassed`, `WindowAlreadyPassed`, `DeadlinePassed`, `DeadlineNotPassed`, `ActivationWindowPassed`, `NoArbiterSet`

---

### `fund`
> Клиент должен сделать approve(agreement, amount) на USDC перед вызовом

**Mutability:** `nonpayable`  

**Reverts:** `ERC721NonexistentToken`, `ERC721TransferToZeroAddress`, `ERC721AlreadyMinted`, `TokenSoulbound`, `NotClient`, `NotExecutor`, `NotArbiter`, `NotParty`, `AlreadyFunded`, `NotFunded`, `NotActive`, `AlreadyActive`, `AlreadyMarkedDone`, `NotMarkedDone`, `AlreadyDisputed`, `NotDisputed`, `AlreadyResolved`, `AlreadyFinalized`, `WindowNotPassed`, `WindowAlreadyPassed`, `DeadlinePassed`, `DeadlineNotPassed`, `ActivationWindowPassed`, `NoArbiterSet`

---

### `fundFromFactory`
> Only factory can call this — used by deployAndFund()

**Mutability:** `nonpayable`  

**Reverts:** `ERC721NonexistentToken`, `ERC721TransferToZeroAddress`, `ERC721AlreadyMinted`, `TokenSoulbound`, `NotClient`, `NotExecutor`, `NotArbiter`, `NotParty`, `AlreadyFunded`, `NotFunded`, `NotActive`, `AlreadyActive`, `AlreadyMarkedDone`, `NotMarkedDone`, `AlreadyDisputed`, `NotDisputed`, `AlreadyResolved`, `AlreadyFinalized`, `WindowNotPassed`, `WindowAlreadyPassed`, `DeadlinePassed`, `DeadlineNotPassed`, `ActivationWindowPassed`, `NoArbiterSet`

---

### `activate`
> После этого клиент не может забрать деньги

**Mutability:** `nonpayable`  

**Reverts:** `ERC721NonexistentToken`, `ERC721TransferToZeroAddress`, `ERC721AlreadyMinted`, `TokenSoulbound`, `NotClient`, `NotExecutor`, `NotArbiter`, `NotParty`, `AlreadyFunded`, `NotFunded`, `NotActive`, `AlreadyActive`, `AlreadyMarkedDone`, `NotMarkedDone`, `AlreadyDisputed`, `NotDisputed`, `AlreadyResolved`, `AlreadyFinalized`, `WindowNotPassed`, `WindowAlreadyPassed`, `DeadlinePassed`, `DeadlineNotPassed`, `ActivationWindowPassed`, `NoArbiterSet`

---

### `markDone`
> @notice Исполнитель сигнализирует о завершении работы

**Mutability:** `nonpayable`  

**Reverts:** `ERC721NonexistentToken`, `ERC721TransferToZeroAddress`, `ERC721AlreadyMinted`, `TokenSoulbound`, `NotClient`, `NotExecutor`, `NotArbiter`, `NotParty`, `AlreadyFunded`, `NotFunded`, `NotActive`, `AlreadyActive`, `AlreadyMarkedDone`, `NotMarkedDone`, `AlreadyDisputed`, `NotDisputed`, `AlreadyResolved`, `AlreadyFinalized`, `WindowNotPassed`, `WindowAlreadyPassed`, `DeadlinePassed`, `DeadlineNotPassed`, `ActivationWindowPassed`, `NoArbiterSet`

---

### `release`
> @notice Клиент подтверждает выполнение → USDC уходит исполнителю

**Mutability:** `nonpayable`  

**Reverts:** `ERC721NonexistentToken`, `ERC721TransferToZeroAddress`, `ERC721AlreadyMinted`, `TokenSoulbound`, `NotClient`, `NotExecutor`, `NotArbiter`, `NotParty`, `AlreadyFunded`, `NotFunded`, `NotActive`, `AlreadyActive`, `AlreadyMarkedDone`, `NotMarkedDone`, `AlreadyDisputed`, `NotDisputed`, `AlreadyResolved`, `AlreadyFinalized`, `WindowNotPassed`, `WindowAlreadyPassed`, `DeadlinePassed`, `DeadlineNotPassed`, `ActivationWindowPassed`, `NoArbiterSet`

---

### `triggerAutoApprove`
> Клиент не ответил → исполнитель получает деньги автоматически

**Mutability:** `nonpayable`  

**Reverts:** `ERC721NonexistentToken`, `ERC721TransferToZeroAddress`, `ERC721AlreadyMinted`, `TokenSoulbound`, `NotClient`, `NotExecutor`, `NotArbiter`, `NotParty`, `AlreadyFunded`, `NotFunded`, `NotActive`, `AlreadyActive`, `AlreadyMarkedDone`, `NotMarkedDone`, `AlreadyDisputed`, `NotDisputed`, `AlreadyResolved`, `AlreadyFinalized`, `WindowNotPassed`, `WindowAlreadyPassed`, `DeadlinePassed`, `DeadlineNotPassed`, `ActivationWindowPassed`, `NoArbiterSet`

---

### `raiseDispute`
> Можно поднять спор даже после markDone, если AUTO_APPROVE_WINDOW ещё не прошёл

**Mutability:** `nonpayable`  

**Reverts:** `ERC721NonexistentToken`, `ERC721TransferToZeroAddress`, `ERC721AlreadyMinted`, `TokenSoulbound`, `NotClient`, `NotExecutor`, `NotArbiter`, `NotParty`, `AlreadyFunded`, `NotFunded`, `NotActive`, `AlreadyActive`, `AlreadyMarkedDone`, `NotMarkedDone`, `AlreadyDisputed`, `NotDisputed`, `AlreadyResolved`, `AlreadyFinalized`, `WindowNotPassed`, `WindowAlreadyPassed`, `DeadlinePassed`, `DeadlineNotPassed`, `ActivationWindowPassed`, `NoArbiterSet`

---

### `resolveDispute`
> clientWins = false → оплата исполнителю

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `clientWins` | `bool` | — |

**Reverts:** `ERC721NonexistentToken`, `ERC721TransferToZeroAddress`, `ERC721AlreadyMinted`, `TokenSoulbound`, `NotClient`, `NotExecutor`, `NotArbiter`, `NotParty`, `AlreadyFunded`, `NotFunded`, `NotActive`, `AlreadyActive`, `AlreadyMarkedDone`, `NotMarkedDone`, `AlreadyDisputed`, `NotDisputed`, `AlreadyResolved`, `AlreadyFinalized`, `WindowNotPassed`, `WindowAlreadyPassed`, `DeadlinePassed`, `DeadlineNotPassed`, `ActivationWindowPassed`, `NoArbiterSet`

---

### `triggerActivationTimeout`
> Рефанд клиенту

**Mutability:** `nonpayable`  

**Reverts:** `ERC721NonexistentToken`, `ERC721TransferToZeroAddress`, `ERC721AlreadyMinted`, `TokenSoulbound`, `NotClient`, `NotExecutor`, `NotArbiter`, `NotParty`, `AlreadyFunded`, `NotFunded`, `NotActive`, `AlreadyActive`, `AlreadyMarkedDone`, `NotMarkedDone`, `AlreadyDisputed`, `NotDisputed`, `AlreadyResolved`, `AlreadyFinalized`, `WindowNotPassed`, `WindowAlreadyPassed`, `DeadlinePassed`, `DeadlineNotPassed`, `ActivationWindowPassed`, `NoArbiterSet`

---

### `triggerDeadlineTimeout`
> Рефанд клиенту

**Mutability:** `nonpayable`  

**Reverts:** `ERC721NonexistentToken`, `ERC721TransferToZeroAddress`, `ERC721AlreadyMinted`, `TokenSoulbound`, `NotClient`, `NotExecutor`, `NotArbiter`, `NotParty`, `AlreadyFunded`, `NotFunded`, `NotActive`, `AlreadyActive`, `AlreadyMarkedDone`, `NotMarkedDone`, `AlreadyDisputed`, `NotDisputed`, `AlreadyResolved`, `AlreadyFinalized`, `WindowNotPassed`, `WindowAlreadyPassed`, `DeadlinePassed`, `DeadlineNotPassed`, `ActivationWindowPassed`, `NoArbiterSet`

---

### `triggerArbiterTimeout`
> Авторефанд клиенту — защита от неактивного/злонамеренного арбитра

**Mutability:** `nonpayable`  

**Reverts:** `ERC721NonexistentToken`, `ERC721TransferToZeroAddress`, `ERC721AlreadyMinted`, `TokenSoulbound`, `NotClient`, `NotExecutor`, `NotArbiter`, `NotParty`, `AlreadyFunded`, `NotFunded`, `NotActive`, `AlreadyActive`, `AlreadyMarkedDone`, `NotMarkedDone`, `AlreadyDisputed`, `NotDisputed`, `AlreadyResolved`, `AlreadyFinalized`, `WindowNotPassed`, `WindowAlreadyPassed`, `DeadlinePassed`, `DeadlineNotPassed`, `ActivationWindowPassed`, `NoArbiterSet`

---

### `syncRegistry`
> Может вызвать любой.

**Mutability:** `nonpayable`  

**Reverts:** `ERC721NonexistentToken`, `ERC721TransferToZeroAddress`, `ERC721AlreadyMinted`, `TokenSoulbound`, `NotClient`, `NotExecutor`, `NotArbiter`, `NotParty`, `AlreadyFunded`, `NotFunded`, `NotActive`, `AlreadyActive`, `AlreadyMarkedDone`, `NotMarkedDone`, `AlreadyDisputed`, `NotDisputed`, `AlreadyResolved`, `AlreadyFinalized`, `WindowNotPassed`, `WindowAlreadyPassed`, `DeadlinePassed`, `DeadlineNotPassed`, `ActivationWindowPassed`, `NoArbiterSet`

---

## View / Pure Functions

| Функция | Возвращает | Описание |
|---------|-----------|----------|
| `name()` | `string memory` | — |
| `symbol()` | `string memory` | — |
| `ownerOf(uint256)` | `address` | — |
| `balanceOf(address)` | `uint256` | — |
| `getApproved(uint256)` | `address` | — |
| `isApprovedForAll(address, address)` | `bool` | — |
| `supportsInterface(bytes4)` | `bool` | — |
| `isTrustedForwarder(address)` | `bool` | — |
| `trustedForwarder()` | `address` | — |
| `balanceOf(address)` | `uint256` | — |
| `status()` | `Status` | — |
| `getDetails()` | `address client_,
        address executor_,
        address arbiter_,
        uint256 amount_,
        bytes32 termsHash_,
        uint256 deadlineDays_,
        uint256 fundedAt_,
        uint256 activatedAt_,
        uint256 markedDoneAt_,
        uint256 disputedAt_,
        uint256 resolvedAt_,
        Status  status_` | — |
| `timeLeft()` | `uint256` | @notice Сколько времени осталось до дедлайна (0 если прошёл) |
| `arbiterTimeLeft()` | `uint256` | @notice Сколько времени осталось арбитру (0 если не в споре или прошёл) |
| `tokenURI(uint256)` | `string memory` | — |
