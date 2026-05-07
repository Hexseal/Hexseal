# Test Plan: ArbiterRegistryFacet
> Источник: `src/facets/ArbiterRegistryFacet.sol`
> Сгенерировано: 2026-05-07

Реестр арбитров. Commit-reveal клейм споров, история решений, управление chief arbiter.

## Окружение
| Параметр | Значение |
|----------|----------|
| Сеть | Base Sepolia (chainId 84532) |
| Diamond | `0xF00CC71878c226E0b64253Fb71dD802aF12165D0` |
| Тестовый USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Кошелёк тестера | — |
| Дата теста | — |

## ✏️ Write Functions

### setArbiter

**Happy path:**
- [ ] Вызвать `setArbiter()` с валидными параметрами — транзакция принята
- [ ] Вернулся ожидаемый результат: `address`

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

**Revert cases:**
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `NotOwnerOrChief`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `AlreadyArbiter`
- [ ] Спровоцировать условие → revert `NotAnArbiter`
- [ ] Спровоцировать условие → revert `AlreadyClaimed`
- [ ] Спровоцировать условие → revert `NotClaimed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `NotAuthorized`
- [ ] Спровоцировать условие → revert `CommitmentNotFound`
- [ ] Спровоцировать условие → revert `CommitmentTooEarly`
- [ ] Спровоцировать условие → revert `CommitmentExpired`

---

### setChiefArbiter
> @notice Назначить главного арбитра. Только owner.

**Happy path:**
- [ ] Вызвать `setChiefArbiter()` с валидными параметрами — транзакция принята
- [ ] Event `ArbiterAdded` эмитирован с правильными аргументами
- [ ] Event `ChiefArbiterSet` эмитирован с правильными аргументами

**Access control:**
- [ ] Вызов от чужого адреса → revert `NotOwner` / `OwnableUnauthorizedAccount`
- [ ] Вызов от owner → успех

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

**Revert cases:**
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `NotOwnerOrChief`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `AlreadyArbiter`
- [ ] Спровоцировать условие → revert `NotAnArbiter`
- [ ] Спровоцировать условие → revert `AlreadyClaimed`
- [ ] Спровоцировать условие → revert `NotClaimed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `NotAuthorized`
- [ ] Спровоцировать условие → revert `CommitmentNotFound`
- [ ] Спровоцировать условие → revert `CommitmentTooEarly`
- [ ] Спровоцировать условие → revert `CommitmentExpired`

---

### addArbiter
> @notice Добавить арбитра в реестр. Owner или chief arbiter.

**Happy path:**
- [ ] Вызвать `addArbiter()` с валидными параметрами — транзакция принята
- [ ] Event `ArbiterAdded` эмитирован с правильными аргументами
- [ ] Event `ArbiterRemoved` эмитирован с правильными аргументами

**Access control:**
- [ ] Вызов от чужого адреса → revert `NotOwner` / `OwnableUnauthorizedAccount`
- [ ] Вызов от owner → успех

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

**Revert cases:**
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `NotOwnerOrChief`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `AlreadyArbiter`
- [ ] Спровоцировать условие → revert `NotAnArbiter`
- [ ] Спровоцировать условие → revert `AlreadyClaimed`
- [ ] Спровоцировать условие → revert `NotClaimed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `NotAuthorized`
- [ ] Спровоцировать условие → revert `CommitmentNotFound`
- [ ] Спровоцировать условие → revert `CommitmentTooEarly`
- [ ] Спровоцировать условие → revert `CommitmentExpired`

---

### removeArbiter
> @notice Убрать арбитра из реестра. Owner или chief arbiter.

**Happy path:**
- [ ] Вызвать `removeArbiter()` с валидными параметрами — транзакция принята
- [ ] Event `ArbiterRemoved` эмитирован с правильными аргументами

**Access control:**
- [ ] Вызов от чужого адреса → revert `NotOwner` / `OwnableUnauthorizedAccount`
- [ ] Вызов от owner → успех

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

**Revert cases:**
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `NotOwnerOrChief`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `AlreadyArbiter`
- [ ] Спровоцировать условие → revert `NotAnArbiter`
- [ ] Спровоцировать условие → revert `AlreadyClaimed`
- [ ] Спровоцировать условие → revert `NotClaimed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `NotAuthorized`
- [ ] Спровоцировать условие → revert `CommitmentNotFound`
- [ ] Спровоцировать условие → revert `CommitmentTooEarly`
- [ ] Спровоцировать условие → revert `CommitmentExpired`

---

### commitDisputeClaim
> Раскрывать можно не раньше следующего блока — защита от фронтраннинга.

**Happy path:**
- [ ] Вызвать `commitDisputeClaim()` с валидными параметрами — транзакция принята
- [ ] Event `DisputeClaimCommitted` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)

**Revert cases:**
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `NotOwnerOrChief`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `AlreadyArbiter`
- [ ] Спровоцировать условие → revert `NotAnArbiter`
- [ ] Спровоцировать условие → revert `AlreadyClaimed`
- [ ] Спровоцировать условие → revert `NotClaimed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `NotAuthorized`
- [ ] Спровоцировать условие → revert `CommitmentNotFound`
- [ ] Спровоцировать условие → revert `CommitmentTooEarly`
- [ ] Спровоцировать условие → revert `CommitmentExpired`

---

### claimDispute
> Вызывает Agreement.setArbiter(caller) через Diamond delegatecall.

**Happy path:**
- [ ] Вызвать `claimDispute()` с валидными параметрами — транзакция принята

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

**Revert cases:**
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `NotOwnerOrChief`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `AlreadyArbiter`
- [ ] Спровоцировать условие → revert `NotAnArbiter`
- [ ] Спровоцировать условие → revert `AlreadyClaimed`
- [ ] Спровоцировать условие → revert `NotClaimed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `NotAuthorized`
- [ ] Спровоцировать условие → revert `CommitmentNotFound`
- [ ] Спровоцировать условие → revert `CommitmentTooEarly`
- [ ] Спровоцировать условие → revert `CommitmentExpired`

---

### releaseDisputeClaim
> @notice Снять клейм (арбитр или owner). Освобождает сделку для другого арбитра.

**Happy path:**
- [ ] Вызвать `releaseDisputeClaim()` с валидными параметрами — транзакция принята
- [ ] Event `DisputeReleased` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

**Revert cases:**
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `NotOwnerOrChief`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `AlreadyArbiter`
- [ ] Спровоцировать условие → revert `NotAnArbiter`
- [ ] Спровоцировать условие → revert `AlreadyClaimed`
- [ ] Спровоцировать условие → revert `NotClaimed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `NotAuthorized`
- [ ] Спровоцировать условие → revert `CommitmentNotFound`
- [ ] Спровоцировать условие → revert `CommitmentTooEarly`
- [ ] Спровоцировать условие → revert `CommitmentExpired`

---

### clearDisputeClaim
> Только Agreement сам может очистить свой клейм — msg.sender == agreement.

**Happy path:**
- [ ] Вызвать `clearDisputeClaim()` с валидными параметрами — транзакция принята

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

**Revert cases:**
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `NotOwnerOrChief`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `AlreadyArbiter`
- [ ] Спровоцировать условие → revert `NotAnArbiter`
- [ ] Спровоцировать условие → revert `AlreadyClaimed`
- [ ] Спровоцировать условие → revert `NotClaimed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `NotAuthorized`
- [ ] Спровоцировать условие → revert `CommitmentNotFound`
- [ ] Спровоцировать условие → revert `CommitmentTooEarly`
- [ ] Спровоцировать условие → revert `CommitmentExpired`

---

## 👁️ View Functions

### status

- [ ] Вызвать `status()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### client

- [ ] Вызвать `client()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### executor

- [ ] Вызвать `executor()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### amount

- [ ] Вызвать `amount()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### disputedAt

- [ ] Вызвать `disputedAt()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getChiefArbiter

- [ ] Вызвать `getChiefArbiter()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### isRegisteredArbiter

- [ ] Вызвать `isRegisteredArbiter()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getArbiters

- [ ] Вызвать `getArbiters()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

### getDisputeClaimer

- [ ] Вызвать `getDisputeClaimer()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getArbiterDeals
> @notice История сделок арбитра (все когда-либо взятые им)

- [ ] Вызвать `getArbiterDeals()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

### getClaimCommitment
> @notice Блок в котором был сохранён коммит (0 если не существует или удалён)

- [ ] Вызвать `getClaimCommitment()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

## 📡 Events

### ArbiterAdded
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed arbiter) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### ArbiterRemoved
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed arbiter) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### ChiefArbiterSet
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed prev, address indexed next) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### DisputeClaimCommitted
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed arbiter, bytes32 indexed commitment) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### DisputeClaimed
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed agreement, address indexed arbiter) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### DisputeReleased
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed agreement, address indexed prevArbiter) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

## ✅ Результат
| Функция | Статус | Тестер | Дата | Комментарий |
|---------|--------|--------|------|-------------|
| `status` | ⬜ | — | — | — |
| `setArbiter` | ⬜ | — | — | — |
| `client` | ⬜ | — | — | — |
| `executor` | ⬜ | — | — | — |
| `amount` | ⬜ | — | — | — |
| `disputedAt` | ⬜ | — | — | — |
| `setChiefArbiter` | ⬜ | — | — | — |
| `addArbiter` | ⬜ | — | — | — |
| `removeArbiter` | ⬜ | — | — | — |
| `commitDisputeClaim` | ⬜ | — | — | — |
| `claimDispute` | ⬜ | — | — | — |
| `releaseDisputeClaim` | ⬜ | — | — | — |
| `clearDisputeClaim` | ⬜ | — | — | — |
| `getChiefArbiter` | ⬜ | — | — | — |
| `isRegisteredArbiter` | ⬜ | — | — | — |
| `getArbiters` | ⬜ | — | — | — |
| `getDisputeClaimer` | ⬜ | — | — | — |
| `getArbiterDeals` | ⬜ | — | — | — |
| `getClaimCommitment` | ⬜ | — | — | — |
