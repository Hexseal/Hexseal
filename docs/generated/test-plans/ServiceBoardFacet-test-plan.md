# Test Plan: ServiceBoardFacet
> Источник: `src/facets/ServiceBoardFacet.sol`
> Сгенерировано: 2026-05-07

Доска услуг: исполнитель постит услугу, клиенты запрашивают её выполнение.

## Окружение
| Параметр | Значение |
|----------|----------|
| Сеть | Base Sepolia (chainId 84532) |
| Diamond | `0xF00CC71878c226E0b64253Fb71dD802aF12165D0` |
| Тестовый USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Кошелёк тестера | — |
| Дата теста | — |

## ✏️ Write Functions

### permit

**Happy path:**
- [ ] Вызвать `permit()` с валидными параметрами — транзакция принята

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `TitleInvalid`
- [ ] Спровоцировать условие → revert `DescriptionTooLong`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `DeadlineInvalid`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ZeroFee`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `ServiceNotActive`
- [ ] Спровоцировать условие → revert `RequestNotPending`
- [ ] Спровоцировать условие → revert `Reentrant`
- [ ] Спровоцировать условие → revert `FactoryPaused`
- [ ] Спровоцировать условие → revert `SelfRequest`

---

### mintService
> @notice Исполнитель публикует услугу. Требует approve(diamond, fee) до вызова.

**Happy path:**
- [ ] Вызвать `mintService()` с валидными параметрами — транзакция принята
- [ ] Вернулся ожидаемый результат: `uint256 serviceId`

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `TitleInvalid`
- [ ] Спровоцировать условие → revert `DescriptionTooLong`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `DeadlineInvalid`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ZeroFee`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `ServiceNotActive`
- [ ] Спровоцировать условие → revert `RequestNotPending`
- [ ] Спровоцировать условие → revert `Reentrant`
- [ ] Спровоцировать условие → revert `FactoryPaused`
- [ ] Спровоцировать условие → revert `SelfRequest`

---

### mintServiceWithPermit
> @dev executor передаётся явно — msg.sender здесь форвардер (ERC-2771).

**Happy path:**
- [ ] Вызвать `mintServiceWithPermit()` с валидными параметрами — транзакция принята
- [ ] Вернулся ожидаемый результат: `uint256 serviceId`

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `TitleInvalid`
- [ ] Спровоцировать условие → revert `DescriptionTooLong`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `DeadlineInvalid`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ZeroFee`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `ServiceNotActive`
- [ ] Спровоцировать условие → revert `RequestNotPending`
- [ ] Спровоцировать условие → revert `Reentrant`
- [ ] Спровоцировать условие → revert `FactoryPaused`
- [ ] Спровоцировать условие → revert `SelfRequest`

---

### removeService

**Happy path:**
- [ ] Вызвать `removeService()` с валидными параметрами — транзакция принята
- [ ] Event `ServiceRemoved` эмитирован с правильными аргументами
- [ ] Event `ServicePaused` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `TitleInvalid`
- [ ] Спровоцировать условие → revert `DescriptionTooLong`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `DeadlineInvalid`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ZeroFee`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `ServiceNotActive`
- [ ] Спровоцировать условие → revert `RequestNotPending`
- [ ] Спровоцировать условие → revert `Reentrant`
- [ ] Спровоцировать условие → revert `FactoryPaused`
- [ ] Спровоцировать условие → revert `SelfRequest`

---

### pauseService

**Happy path:**
- [ ] Вызвать `pauseService()` с валидными параметрами — транзакция принята
- [ ] Event `ServicePaused` эмитирован с правильными аргументами
- [ ] Event `ServiceUnpaused` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `TitleInvalid`
- [ ] Спровоцировать условие → revert `DescriptionTooLong`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `DeadlineInvalid`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ZeroFee`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `ServiceNotActive`
- [ ] Спровоцировать условие → revert `RequestNotPending`
- [ ] Спровоцировать условие → revert `Reentrant`
- [ ] Спровоцировать условие → revert `FactoryPaused`
- [ ] Спровоцировать условие → revert `SelfRequest`

---

### unpauseService

**Happy path:**
- [ ] Вызвать `unpauseService()` с валидными параметрами — транзакция принята
- [ ] Event `ServiceUnpaused` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `TitleInvalid`
- [ ] Спровоцировать условие → revert `DescriptionTooLong`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `DeadlineInvalid`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ZeroFee`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `ServiceNotActive`
- [ ] Спровоцировать условие → revert `RequestNotPending`
- [ ] Спровоцировать условие → revert `Reentrant`
- [ ] Спровоцировать условие → revert `FactoryPaused`
- [ ] Спровоцировать условие → revert `SelfRequest`

---

### requestService
> @param amount     Сумма сделки (может отличаться от price — договорились off-chain)

**Happy path:**
- [ ] Вызвать `requestService()` с валидными параметрами — транзакция принята
- [ ] Вернулся ожидаемый результат: `uint256 requestId`

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `TitleInvalid`
- [ ] Спровоцировать условие → revert `DescriptionTooLong`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `DeadlineInvalid`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ZeroFee`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `ServiceNotActive`
- [ ] Спровоцировать условие → revert `RequestNotPending`
- [ ] Спровоцировать условие → revert `Reentrant`
- [ ] Спровоцировать условие → revert `FactoryPaused`
- [ ] Спровоцировать условие → revert `SelfRequest`

---

### requestServiceWithPermit
> @dev client передаётся явно — msg.sender здесь форвардер (ERC-2771).

**Happy path:**
- [ ] Вызвать `requestServiceWithPermit()` с валидными параметрами — транзакция принята
- [ ] Вернулся ожидаемый результат: `uint256 requestId`

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `TitleInvalid`
- [ ] Спровоцировать условие → revert `DescriptionTooLong`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `DeadlineInvalid`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ZeroFee`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `ServiceNotActive`
- [ ] Спровоцировать условие → revert `RequestNotPending`
- [ ] Спровоцировать условие → revert `Reentrant`
- [ ] Спровоцировать условие → revert `FactoryPaused`
- [ ] Спровоцировать условие → revert `SelfRequest`

---

### acceptRequest
> @notice Исполнитель принимает запрос → деплоит Agreement, переводит amount из Diamond.

**Happy path:**
- [ ] Вызвать `acceptRequest()` с валидными параметрами — транзакция принята
- [ ] Вернулся ожидаемый результат: `address agreementAddr`

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `TitleInvalid`
- [ ] Спровоцировать условие → revert `DescriptionTooLong`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `DeadlineInvalid`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ZeroFee`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `ServiceNotActive`
- [ ] Спровоцировать условие → revert `RequestNotPending`
- [ ] Спровоцировать условие → revert `Reentrant`
- [ ] Спровоцировать условие → revert `FactoryPaused`
- [ ] Спровоцировать условие → revert `SelfRequest`

---

### rejectRequest
> @notice Исполнитель отклоняет запрос → amount рефандится клиенту.

**Happy path:**
- [ ] Вызвать `rejectRequest()` с валидными параметрами — транзакция принята
- [ ] Event `RequestRejected` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `TitleInvalid`
- [ ] Спровоцировать условие → revert `DescriptionTooLong`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `DeadlineInvalid`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ZeroFee`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `ServiceNotActive`
- [ ] Спровоцировать условие → revert `RequestNotPending`
- [ ] Спровоцировать условие → revert `Reentrant`
- [ ] Спровоцировать условие → revert `FactoryPaused`
- [ ] Спровоцировать условие → revert `SelfRequest`

---

### cancelRequest
> @notice Клиент отменяет запрос пока он PENDING → amount рефандится.

**Happy path:**
- [ ] Вызвать `cancelRequest()` с валидными параметрами — транзакция принята
- [ ] Event `RequestCancelled` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `TitleInvalid`
- [ ] Спровоцировать условие → revert `DescriptionTooLong`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `DeadlineInvalid`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ZeroFee`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `ServiceNotActive`
- [ ] Спровоцировать условие → revert `RequestNotPending`
- [ ] Спровоцировать условие → revert `Reentrant`
- [ ] Спровоцировать условие → revert `FactoryPaused`
- [ ] Спровоцировать условие → revert `SelfRequest`

---

## 👁️ View Functions

### getService

- [ ] Вызвать `getService()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getExecutorServices

- [ ] Вызвать `getExecutorServices()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

### getServiceClients

- [ ] Вызвать `getServiceClients()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

### totalServices

- [ ] Вызвать `totalServices()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getRequest

- [ ] Вызвать `getRequest()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getServiceRequests

- [ ] Вызвать `getServiceRequests()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

### getClientRequests

- [ ] Вызвать `getClientRequests()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

### totalRequests

- [ ] Вызвать `totalRequests()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getRequestFunds

- [ ] Вызвать `getRequestFunds()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getActiveServices
> @notice Все активные услуги с их ID

- [ ] Вызвать `getActiveServices()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

### getPendingRequests
> @notice Ожидающие (PENDING) запросы на услугу

- [ ] Вызвать `getPendingRequests()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

## 📡 Events

### ServicePosted
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (uint256 indexed serviceId, address indexed executor, uint256 price, uint8 region) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### ServiceRemoved
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (uint256 indexed serviceId, address indexed executor) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### ServicePaused
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (uint256 indexed serviceId) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### ServiceUnpaused
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (uint256 indexed serviceId) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### ServiceRequested
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (uint256 indexed requestId, uint256 indexed serviceId, address indexed client, uint256 amount) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### RequestAccepted
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (uint256 indexed requestId, address indexed executor, address indexed client, address agreement) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### RequestRejected
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (uint256 indexed requestId, address indexed executor, address indexed client) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### RequestCancelled
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (uint256 indexed requestId, address indexed client) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

## ✅ Результат
| Функция | Статус | Тестер | Дата | Комментарий |
|---------|--------|--------|------|-------------|
| `permit` | ⬜ | — | — | — |
| `mintService` | ⬜ | — | — | — |
| `mintServiceWithPermit` | ⬜ | — | — | — |
| `removeService` | ⬜ | — | — | — |
| `pauseService` | ⬜ | — | — | — |
| `unpauseService` | ⬜ | — | — | — |
| `requestService` | ⬜ | — | — | — |
| `requestServiceWithPermit` | ⬜ | — | — | — |
| `acceptRequest` | ⬜ | — | — | — |
| `rejectRequest` | ⬜ | — | — | — |
| `cancelRequest` | ⬜ | — | — | — |
| `getService` | ⬜ | — | — | — |
| `getExecutorServices` | ⬜ | — | — | — |
| `getServiceClients` | ⬜ | — | — | — |
| `totalServices` | ⬜ | — | — | — |
| `getRequest` | ⬜ | — | — | — |
| `getServiceRequests` | ⬜ | — | — | — |
| `getClientRequests` | ⬜ | — | — | — |
| `totalRequests` | ⬜ | — | — | — |
| `getRequestFunds` | ⬜ | — | — | — |
| `getActiveServices` | ⬜ | — | — | — |
| `getPendingRequests` | ⬜ | — | — | — |
