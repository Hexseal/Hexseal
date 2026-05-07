# Test Plan: RegistryFacet
> Источник: `src/RegistryFacet.sol`
> Сгенерировано: 2026-05-07

Реестр всех Agreement-контрактов. Индексирует сделки по участникам, хранит их текущий статус.

## Окружение
| Параметр | Значение |
|----------|----------|
| Сеть | Base Sepolia (chainId 84532) |
| Diamond | `0xF00CC71878c226E0b64253Fb71dD802aF12165D0` |
| Тестовый USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Кошелёк тестера | — |
| Дата теста | — |

## ✏️ Write Functions

### initRegistry

**Happy path:**
- [ ] Вызвать `initRegistry()` с валидными параметрами — транзакция принята
- [ ] Event `AuthorizedFactorySet` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

**Revert cases:**
- [ ] Спровоцировать условие → revert `OnlyAuthorizedFactory`
- [ ] Спровоцировать условие → revert `OnlyAgreementItself`
- [ ] Спровоцировать условие → revert `AgreementNotRegistered`
- [ ] Спровоцировать условие → revert `ActiveDealAlreadyExists`
- [ ] Спровоцировать условие → revert `ZeroAddress`
- [ ] Спровоцировать условие → revert `AlreadyInitialized`
- [ ] Спровоцировать условие → revert `NotOwner`

---

### register
> @notice Регистрация новой сделки. Вызывает только FactoryFacet после деплоя Agreement.

**Happy path:**
- [ ] Вызвать `register()` с валидными параметрами — транзакция принята

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `OnlyAuthorizedFactory`
- [ ] Спровоцировать условие → revert `OnlyAgreementItself`
- [ ] Спровоцировать условие → revert `AgreementNotRegistered`
- [ ] Спровоцировать условие → revert `ActiveDealAlreadyExists`
- [ ] Спровоцировать условие → revert `ZeroAddress`
- [ ] Спровоцировать условие → revert `AlreadyInitialized`
- [ ] Спровоцировать условие → revert `NotOwner`

---

### updateStatus
> @notice Обновление статуса. Вызывает только сам Agreement контракт.

**Happy path:**
- [ ] Вызвать `updateStatus()` с валидными параметрами — транзакция принята
- [ ] Event `AgreementStatusUpdated` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

**Revert cases:**
- [ ] Спровоцировать условие → revert `OnlyAuthorizedFactory`
- [ ] Спровоцировать условие → revert `OnlyAgreementItself`
- [ ] Спровоцировать условие → revert `AgreementNotRegistered`
- [ ] Спровоцировать условие → revert `ActiveDealAlreadyExists`
- [ ] Спровоцировать условие → revert `ZeroAddress`
- [ ] Спровоцировать условие → revert `AlreadyInitialized`
- [ ] Спровоцировать условие → revert `NotOwner`

---

### setAuthorizedFactory
> Нужно если деплоишь новую версию FactoryFacet

**Happy path:**
- [ ] Вызвать `setAuthorizedFactory()` с валидными параметрами — транзакция принята
- [ ] Event `AuthorizedFactorySet` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

**Revert cases:**
- [ ] Спровоцировать условие → revert `OnlyAuthorizedFactory`
- [ ] Спровоцировать условие → revert `OnlyAgreementItself`
- [ ] Спровоцировать условие → revert `AgreementNotRegistered`
- [ ] Спровоцировать условие → revert `ActiveDealAlreadyExists`
- [ ] Спровоцировать условие → revert `ZeroAddress`
- [ ] Спровоцировать условие → revert `AlreadyInitialized`
- [ ] Спровоцировать условие → revert `NotOwner`

---

## 👁️ View Functions

### hasActivePair
> @notice Есть ли активная сделка между этой парой

- [ ] Вызвать `hasActivePair()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getActivePair
> @notice Адрес активной сделки между парой (address(0) если нет)

- [ ] Вызвать `getActivePair()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getRecord
> @notice Полная запись по адресу Agreement

- [ ] Вызвать `getRecord()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getByClient
> @notice Все сделки клиента

- [ ] Вызвать `getByClient()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

### getByExecutor
> @notice Все сделки исполнителя

- [ ] Вызвать `getByExecutor()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

### getActive
> @notice Все активные сделки (для борды)

- [ ] Вызвать `getActive()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

### getDisputed
> @notice Все спорные сделки (для борды арбитров)

- [ ] Вызвать `getDisputed()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

### totalAgreements
> @notice Общее количество сделок

- [ ] Вызвать `totalAgreements()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### authorizedFactory
> @notice Адрес авторизованного Factory

- [ ] Вызвать `authorizedFactory()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

## 📡 Events

### AgreementRegistered
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed agreement, address indexed client, address indexed executor, uint256 amount) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### AgreementStatusUpdated
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed agreement, RegistryStorage.AgreementStatus newStatus) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### AuthorizedFactorySet
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed factory) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

## ✅ Результат
| Функция | Статус | Тестер | Дата | Комментарий |
|---------|--------|--------|------|-------------|
| `initRegistry` | ⬜ | — | — | — |
| `register` | ⬜ | — | — | — |
| `updateStatus` | ⬜ | — | — | — |
| `setAuthorizedFactory` | ⬜ | — | — | — |
| `hasActivePair` | ⬜ | — | — | — |
| `getActivePair` | ⬜ | — | — | — |
| `getRecord` | ⬜ | — | — | — |
| `getByClient` | ⬜ | — | — | — |
| `getByExecutor` | ⬜ | — | — | — |
| `getActive` | ⬜ | — | — | — |
| `getDisputed` | ⬜ | — | — | — |
| `totalAgreements` | ⬜ | — | — | — |
| `authorizedFactory` | ⬜ | — | — | — |
