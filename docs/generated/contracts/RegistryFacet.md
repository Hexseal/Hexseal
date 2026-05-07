# RegistryFacet
> **Файл:** `src/RegistryFacet.sol`
> **Теги:** `registry` `indexing`

Реестр всех Agreement-контрактов. Индексирует сделки по участникам, хранит их текущий статус.

## Модификаторы доступа
- `onlyFactory`
- `onlyAgreement`

## Events
| Event | Параметры |
|-------|-----------|
| `AgreementRegistered` | address indexed agreement, address indexed client, address indexed executor, uint256 amount |
| `AgreementStatusUpdated` | address indexed agreement, RegistryStorage.AgreementStatus newStatus |
| `AuthorizedFactorySet` | address indexed factory |

## Custom Errors
| Error | Когда |
|-------|-------|
| `OnlyAuthorizedFactory` | — |
| `OnlyAgreementItself` | — |
| `AgreementNotRegistered` | — |
| `ActiveDealAlreadyExists` | — |
| `ZeroAddress` | — |
| `AlreadyInitialized` | — |
| `NotOwner` | — |

## Write Functions

### `initRegistry`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `factory_` | `address` | — |

**Reverts:** `OnlyAuthorizedFactory`, `OnlyAgreementItself`, `AgreementNotRegistered`, `ActiveDealAlreadyExists`, `ZeroAddress`, `AlreadyInitialized`, `NotOwner`

---

### `register`
> @notice Регистрация новой сделки. Вызывает только FactoryFacet после деплоя Agreement.

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `agreement` | `address` | — |
| `client` | `address` | — |
| `executor` | `address` | — |
| `amount` | `uint256` | — |

**Reverts:** `OnlyAuthorizedFactory`, `OnlyAgreementItself`, `AgreementNotRegistered`, `ActiveDealAlreadyExists`, `ZeroAddress`, `AlreadyInitialized`, `NotOwner`

---

### `updateStatus`
> @notice Обновление статуса. Вызывает только сам Agreement контракт.

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `agreement` | `address` | — |
| `newStatus` | `enum RegistryStorage.AgreementStatus` | — |

**Reverts:** `OnlyAuthorizedFactory`, `OnlyAgreementItself`, `AgreementNotRegistered`, `ActiveDealAlreadyExists`, `ZeroAddress`, `AlreadyInitialized`, `NotOwner`

---

### `setAuthorizedFactory`
> Нужно если деплоишь новую версию FactoryFacet

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `newFactory` | `address` | — |

**Reverts:** `OnlyAuthorizedFactory`, `OnlyAgreementItself`, `AgreementNotRegistered`, `ActiveDealAlreadyExists`, `ZeroAddress`, `AlreadyInitialized`, `NotOwner`

---

## View / Pure Functions

| Функция | Возвращает | Описание |
|---------|-----------|----------|
| `hasActivePair(address, address)` | `bool` | @notice Есть ли активная сделка между этой парой |
| `getActivePair(address, address)` | `address` | @notice Адрес активной сделки между парой (address(0) если нет) |
| `getRecord(address)` | `RegistryStorage.AgreementRecord memory` | @notice Полная запись по адресу Agreement |
| `getByClient(address)` | `RegistryStorage.AgreementRecord[] memory` | @notice Все сделки клиента |
| `getByExecutor(address)` | `RegistryStorage.AgreementRecord[] memory` | @notice Все сделки исполнителя |
| `getActive()` | `RegistryStorage.AgreementRecord[] memory` | @notice Все активные сделки (для борды) |
| `getDisputed()` | `RegistryStorage.AgreementRecord[] memory` | @notice Все спорные сделки (для борды арбитров) |
| `totalAgreements()` | `uint256` | @notice Общее количество сделок |
| `authorizedFactory()` | `address` | @notice Адрес авторизованного Factory |
