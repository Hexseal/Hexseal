# Test Plan: JobBoardFacet
> Источник: `src/facets/JobBoardFacet.sol`
> Сгенерировано: 2026-05-07

Доска заказов: клиент постит задание с бюджетом, исполнители подают заявки.

## Окружение
| Параметр | Значение |
|----------|----------|
| Сеть | Base Sepolia (chainId 84532) |
| Diamond | `0xF00CC71878c226E0b64253Fb71dD802aF12165D0` |
| Тестовый USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Кошелёк тестера | — |
| Дата теста | — |

## ✏️ Write Functions

### mintJobReceipt

**Happy path:**
- [ ] Вызвать `mintJobReceipt()` с валидными параметрами — транзакция принята
- [ ] Вернулся ожидаемый результат: `uint256`

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
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `JobNotOpen`
- [ ] Спровоцировать условие → revert `NotApplicant`
- [ ] Спровоцировать условие → revert `AlreadyApplied`
- [ ] Спровоцировать условие → revert `Reentrant`
- [ ] Спровоцировать условие → revert `FactoryPaused`
- [ ] Спровоцировать условие → revert `SelfApply`

---

### permit

**Happy path:**
- [ ] Вызвать `permit()` с валидными параметрами — транзакция принята
- [ ] Вернулся ожидаемый результат: `bool`

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
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `JobNotOpen`
- [ ] Спровоцировать условие → revert `NotApplicant`
- [ ] Спровоцировать условие → revert `AlreadyApplied`
- [ ] Спровоцировать условие → revert `Reentrant`
- [ ] Спровоцировать условие → revert `FactoryPaused`
- [ ] Спровоцировать условие → revert `SelfApply`

---

### transferFrom

**Happy path:**
- [ ] Вызвать `transferFrom()` с валидными параметрами — транзакция принята
- [ ] Вернулся ожидаемый результат: `bool`

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
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `JobNotOpen`
- [ ] Спровоцировать условие → revert `NotApplicant`
- [ ] Спровоцировать условие → revert `AlreadyApplied`
- [ ] Спровоцировать условие → revert `Reentrant`
- [ ] Спровоцировать условие → revert `FactoryPaused`
- [ ] Спровоцировать условие → revert `SelfApply`

---

### mintJobWithPermit
> @notice Клиент создаёт заказ — gasless via off-chain USDC permit

**Happy path:**
- [ ] Вызвать `mintJobWithPermit()` с валидными параметрами — транзакция принята
- [ ] Вернулся ожидаемый результат: `uint256 jobId`

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
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `JobNotOpen`
- [ ] Спровоцировать условие → revert `NotApplicant`
- [ ] Спровоцировать условие → revert `AlreadyApplied`
- [ ] Спровоцировать условие → revert `Reentrant`
- [ ] Спровоцировать условие → revert `FactoryPaused`
- [ ] Спровоцировать условие → revert `SelfApply`

---

### mintJob
> @dev Требует approve(diamond, fee + amount) до вызова

**Happy path:**
- [ ] Вызвать `mintJob()` с валидными параметрами — транзакция принята
- [ ] Вернулся ожидаемый результат: `uint256 jobId`

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
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `JobNotOpen`
- [ ] Спровоцировать условие → revert `NotApplicant`
- [ ] Спровоцировать условие → revert `AlreadyApplied`
- [ ] Спровоцировать условие → revert `Reentrant`
- [ ] Спровоцировать условие → revert `FactoryPaused`
- [ ] Спровоцировать условие → revert `SelfApply`

---

### applyForJob
> @notice Исполнитель откликается на заказ (gasless-совместим через ERC-2771)

**Happy path:**
- [ ] Вызвать `applyForJob()` с валидными параметрами — транзакция принята
- [ ] Event `JobApplied` эмитирован с правильными аргументами

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
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `JobNotOpen`
- [ ] Спровоцировать условие → revert `NotApplicant`
- [ ] Спровоцировать условие → revert `AlreadyApplied`
- [ ] Спровоцировать условие → revert `Reentrant`
- [ ] Спровоцировать условие → revert `FactoryPaused`
- [ ] Спровоцировать условие → revert `SelfApply`

---

### acceptApplicant
> @notice Клиент принимает исполнителя → Factory деплоит Agreement (gasless-совместим)

**Happy path:**
- [ ] Вызвать `acceptApplicant()` с валидными параметрами — транзакция принята
- [ ] Вернулся ожидаемый результат: `address agreementAddr`

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
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `JobNotOpen`
- [ ] Спровоцировать условие → revert `NotApplicant`
- [ ] Спровоцировать условие → revert `AlreadyApplied`
- [ ] Спровоцировать условие → revert `Reentrant`
- [ ] Спровоцировать условие → revert `FactoryPaused`
- [ ] Спровоцировать условие → revert `SelfApply`

---

### cancelJob
> @notice Клиент отменяет заказ (amount рефандится, fee нет) — gasless-совместим

**Happy path:**
- [ ] Вызвать `cancelJob()` с валидными параметрами — транзакция принята
- [ ] Event `JobCancelled` эмитирован с правильными аргументами

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
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `JobNotOpen`
- [ ] Спровоцировать условие → revert `NotApplicant`
- [ ] Спровоцировать условие → revert `AlreadyApplied`
- [ ] Спровоцировать условие → revert `Reentrant`
- [ ] Спровоцировать условие → revert `FactoryPaused`
- [ ] Спровоцировать условие → revert `SelfApply`

---

## 👁️ View Functions

### getJob

- [ ] Вызвать `getJob()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getClientJobs

- [ ] Вызвать `getClientJobs()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

### getApplicants

- [ ] Вызвать `getApplicants()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

### totalJobs

- [ ] Вызвать `totalJobs()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getOpenJobs
> @notice Возвращает все OPEN-заказы с их ID

- [ ] Вызвать `getOpenJobs()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

## 📡 Events

### JobPosted
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (uint256 indexed jobId, address indexed client, uint256 amount, uint8 region) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### JobApplied
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (uint256 indexed jobId, address indexed executor) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### JobAccepted
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (uint256 indexed jobId, address indexed client, address indexed executor, address agreement) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### JobCancelled
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (uint256 indexed jobId, address indexed client, uint256 refundAmount) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

## ✅ Результат
| Функция | Статус | Тестер | Дата | Комментарий |
|---------|--------|--------|------|-------------|
| `mintJobReceipt` | ⬜ | — | — | — |
| `permit` | ⬜ | — | — | — |
| `transferFrom` | ⬜ | — | — | — |
| `mintJobWithPermit` | ⬜ | — | — | — |
| `mintJob` | ⬜ | — | — | — |
| `applyForJob` | ⬜ | — | — | — |
| `acceptApplicant` | ⬜ | — | — | — |
| `cancelJob` | ⬜ | — | — | — |
| `getJob` | ⬜ | — | — | — |
| `getClientJobs` | ⬜ | — | — | — |
| `getApplicants` | ⬜ | — | — | — |
| `totalJobs` | ⬜ | — | — | — |
| `getOpenJobs` | ⬜ | — | — | — |
