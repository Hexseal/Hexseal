# Test Plan: FactoryFacet
> Источник: `src/FactoryFacet.sol`
> Сгенерировано: 2026-05-07

Фабрика Agreement-контрактов. Хранит fee-конфигурацию, USDC-адрес, trustedForwarder. Деплоит новые эскроу-сделки.

## Окружение
| Параметр | Значение |
|----------|----------|
| Сеть | Base Sepolia (chainId 84532) |
| Diamond | `0xF00CC71878c226E0b64253Fb71dD802aF12165D0` |
| Тестовый USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Кошелёк тестера | — |
| Дата теста | — |

## ✏️ Write Functions

### register

**Happy path:**
- [ ] Вызвать `register()` с валидными параметрами — транзакция принята
- [ ] Вернулся ожидаемый результат: `bool`

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `FactoryPausedError`
- [ ] Спровоцировать условие → revert `ZeroAddress`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `ZeroDeadline`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ActiveDealExists`
- [ ] Спровоцировать условие → revert `ClientEqualsExecutor`
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `AlreadyInitialized`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `DeployerNotSet`

---

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
- [ ] Спровоцировать условие → revert `FactoryPausedError`
- [ ] Спровоцировать условие → revert `ZeroAddress`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `ZeroDeadline`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ActiveDealExists`
- [ ] Спровоцировать условие → revert `ClientEqualsExecutor`
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `AlreadyInitialized`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `DeployerNotSet`

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
- [ ] Спровоцировать условие → revert `FactoryPausedError`
- [ ] Спровоцировать условие → revert `ZeroAddress`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `ZeroDeadline`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ActiveDealExists`
- [ ] Спровоцировать условие → revert `ClientEqualsExecutor`
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `AlreadyInitialized`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `DeployerNotSet`

---

### initFactory

**Happy path:**
- [ ] Вызвать `initFactory()` с валидными параметрами — транзакция принята

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

**Revert cases:**
- [ ] Спровоцировать условие → revert `FactoryPausedError`
- [ ] Спровоцировать условие → revert `ZeroAddress`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `ZeroDeadline`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ActiveDealExists`
- [ ] Спровоцировать условие → revert `ClientEqualsExecutor`
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `AlreadyInitialized`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `DeployerNotSet`

---

### deployAgreement

**Happy path:**
- [ ] Вызвать `deployAgreement()` с валидными параметрами — транзакция принята
- [ ] Вернулся ожидаемый результат: `address agreementAddress`

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `FactoryPausedError`
- [ ] Спровоцировать условие → revert `ZeroAddress`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `ZeroDeadline`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ActiveDealExists`
- [ ] Спровоцировать условие → revert `ClientEqualsExecutor`
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `AlreadyInitialized`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `DeployerNotSet`

---

### deployAndFund

**Happy path:**
- [ ] Вызвать `deployAndFund()` с валидными параметрами — транзакция принята
- [ ] Вернулся ожидаемый результат: `address agreementAddress`

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `FactoryPausedError`
- [ ] Спровоцировать условие → revert `ZeroAddress`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `ZeroDeadline`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ActiveDealExists`
- [ ] Спровоцировать условие → revert `ClientEqualsExecutor`
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `AlreadyInitialized`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `DeployerNotSet`

---

### setRegionFee

**Happy path:**
- [ ] Вызвать `setRegionFee()` с валидными параметрами — транзакция принята
- [ ] Event `RegionFeeUpdated` эмитирован с правильными аргументами
- [ ] Event `FeeRecipientUpdated` эмитирован с правильными аргументами
- [ ] Event `TrustedForwarderUpdated` эмитирован с правильными аргументами
- [ ] Event `FactoryPaused` эмитирован с правильными аргументами

**Access control:**
- [ ] Вызов от чужого адреса → revert `NotOwner` / `OwnableUnauthorizedAccount`
- [ ] Вызов от owner → успех

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `FactoryPausedError`
- [ ] Спровоцировать условие → revert `ZeroAddress`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `ZeroDeadline`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ActiveDealExists`
- [ ] Спровоцировать условие → revert `ClientEqualsExecutor`
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `AlreadyInitialized`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `DeployerNotSet`

---

### setFeeRecipient

**Happy path:**
- [ ] Вызвать `setFeeRecipient()` с валидными параметрами — транзакция принята
- [ ] Event `FeeRecipientUpdated` эмитирован с правильными аргументами
- [ ] Event `TrustedForwarderUpdated` эмитирован с правильными аргументами
- [ ] Event `FactoryPaused` эмитирован с правильными аргументами
- [ ] Event `ProtocolArbiterUpdated` эмитирован с правильными аргументами
- [ ] Event `ArbitrationThresholdUpdated` эмитирован с правильными аргументами

**Access control:**
- [ ] Вызов от чужого адреса → revert `NotOwner` / `OwnableUnauthorizedAccount`
- [ ] Вызов от owner → успех

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

**Revert cases:**
- [ ] Спровоцировать условие → revert `FactoryPausedError`
- [ ] Спровоцировать условие → revert `ZeroAddress`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `ZeroDeadline`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ActiveDealExists`
- [ ] Спровоцировать условие → revert `ClientEqualsExecutor`
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `AlreadyInitialized`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `DeployerNotSet`

---

### setTrustedForwarder

**Happy path:**
- [ ] Вызвать `setTrustedForwarder()` с валидными параметрами — транзакция принята
- [ ] Event `TrustedForwarderUpdated` эмитирован с правильными аргументами
- [ ] Event `FactoryPaused` эмитирован с правильными аргументами
- [ ] Event `ProtocolArbiterUpdated` эмитирован с правильными аргументами
- [ ] Event `ArbitrationThresholdUpdated` эмитирован с правильными аргументами
- [ ] Event `AgreementDeployerUpdated` эмитирован с правильными аргументами

**Access control:**
- [ ] Вызов от чужого адреса → revert `NotOwner` / `OwnableUnauthorizedAccount`
- [ ] Вызов от owner → успех

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

**Revert cases:**
- [ ] Спровоцировать условие → revert `FactoryPausedError`
- [ ] Спровоцировать условие → revert `ZeroAddress`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `ZeroDeadline`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ActiveDealExists`
- [ ] Спровоцировать условие → revert `ClientEqualsExecutor`
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `AlreadyInitialized`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `DeployerNotSet`

---

### setPaused

**Happy path:**
- [ ] Вызвать `setPaused()` с валидными параметрами — транзакция принята
- [ ] Event `FactoryPaused` эмитирован с правильными аргументами
- [ ] Event `ProtocolArbiterUpdated` эмитирован с правильными аргументами
- [ ] Event `ArbitrationThresholdUpdated` эмитирован с правильными аргументами
- [ ] Event `AgreementDeployerUpdated` эмитирован с правильными аргументами

**Access control:**
- [ ] Вызов от чужого адреса → revert `NotOwner` / `OwnableUnauthorizedAccount`
- [ ] Вызов от owner → успех

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)

**Revert cases:**
- [ ] Спровоцировать условие → revert `FactoryPausedError`
- [ ] Спровоцировать условие → revert `ZeroAddress`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `ZeroDeadline`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ActiveDealExists`
- [ ] Спровоцировать условие → revert `ClientEqualsExecutor`
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `AlreadyInitialized`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `DeployerNotSet`

---

### setProtocolArbiter

**Happy path:**
- [ ] Вызвать `setProtocolArbiter()` с валидными параметрами — транзакция принята
- [ ] Event `ProtocolArbiterUpdated` эмитирован с правильными аргументами
- [ ] Event `ArbitrationThresholdUpdated` эмитирован с правильными аргументами
- [ ] Event `AgreementDeployerUpdated` эмитирован с правильными аргументами

**Access control:**
- [ ] Вызов от чужого адреса → revert `NotOwner` / `OwnableUnauthorizedAccount`
- [ ] Вызов от owner → успех

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

**Revert cases:**
- [ ] Спровоцировать условие → revert `FactoryPausedError`
- [ ] Спровоцировать условие → revert `ZeroAddress`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `ZeroDeadline`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ActiveDealExists`
- [ ] Спровоцировать условие → revert `ClientEqualsExecutor`
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `AlreadyInitialized`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `DeployerNotSet`

---

### setArbitrationThreshold

**Happy path:**
- [ ] Вызвать `setArbitrationThreshold()` с валидными параметрами — транзакция принята
- [ ] Event `ArbitrationThresholdUpdated` эмитирован с правильными аргументами
- [ ] Event `AgreementDeployerUpdated` эмитирован с правильными аргументами

**Access control:**
- [ ] Вызов от чужого адреса → revert `NotOwner` / `OwnableUnauthorizedAccount`
- [ ] Вызов от owner → успех

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `FactoryPausedError`
- [ ] Спровоцировать условие → revert `ZeroAddress`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `ZeroDeadline`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ActiveDealExists`
- [ ] Спровоцировать условие → revert `ClientEqualsExecutor`
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `AlreadyInitialized`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `DeployerNotSet`

---

### setAgreementDeployer

**Happy path:**
- [ ] Вызвать `setAgreementDeployer()` с валидными параметрами — транзакция принята
- [ ] Event `AgreementDeployerUpdated` эмитирован с правильными аргументами

**Access control:**
- [ ] Вызов от чужого адреса → revert `NotOwner` / `OwnableUnauthorizedAccount`
- [ ] Вызов от owner → успех

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

**Revert cases:**
- [ ] Спровоцировать условие → revert `FactoryPausedError`
- [ ] Спровоцировать условие → revert `ZeroAddress`
- [ ] Спровоцировать условие → revert `ZeroAmount`
- [ ] Спровоцировать условие → revert `ZeroDeadline`
- [ ] Спровоцировать условие → revert `InvalidRegion`
- [ ] Спровоцировать условие → revert `ActiveDealExists`
- [ ] Спровоцировать условие → revert `ClientEqualsExecutor`
- [ ] Спровоцировать условие → revert `NotOwner`
- [ ] Спровоцировать условие → revert `AlreadyInitialized`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `DeployerNotSet`

---

## 👁️ View Functions

### hasActivePair

- [ ] Вызвать `hasActivePair()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getRegionFee

- [ ] Вызвать `getRegionFee()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getAllFees

- [ ] Вызвать `getAllFees()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getFeeRecipient

- [ ] Вызвать `getFeeRecipient()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getTrustedForwarder

- [ ] Вызвать `getTrustedForwarder()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### isPaused

- [ ] Вызвать `isPaused()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getUsdc

- [ ] Вызвать `getUsdc()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getProtocolArbiter

- [ ] Вызвать `getProtocolArbiter()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getArbitrationThreshold

- [ ] Вызвать `getArbitrationThreshold()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getAgreementDeployer

- [ ] Вызвать `getAgreementDeployer()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

## 📡 Events

### AgreementDeployed
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed agreement, address indexed client, address indexed executor, uint256 amount, uint8 region, uint256 fee) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### RegionFeeUpdated
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (uint8 indexed region, uint256 newFee) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### FeeRecipientUpdated
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed newRecipient) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### TrustedForwarderUpdated
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed newForwarder) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### FactoryPaused
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (bool paused) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### ProtocolArbiterUpdated
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed arbiter) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### DealFunded
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed agreement, address indexed client, uint256 amount) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### ArbitrationThresholdUpdated
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (uint256 newThreshold) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### AgreementDeployerUpdated
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed deployer) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

## ✅ Результат
| Функция | Статус | Тестер | Дата | Комментарий |
|---------|--------|--------|------|-------------|
| `register` | ⬜ | — | — | — |
| `hasActivePair` | ⬜ | — | — | — |
| `permit` | ⬜ | — | — | — |
| `transferFrom` | ⬜ | — | — | — |
| `initFactory` | ⬜ | — | — | — |
| `deployAgreement` | ⬜ | — | — | — |
| `deployAndFund` | ⬜ | — | — | — |
| `setRegionFee` | ⬜ | — | — | — |
| `setFeeRecipient` | ⬜ | — | — | — |
| `setTrustedForwarder` | ⬜ | — | — | — |
| `setPaused` | ⬜ | — | — | — |
| `setProtocolArbiter` | ⬜ | — | — | — |
| `setArbitrationThreshold` | ⬜ | — | — | — |
| `setAgreementDeployer` | ⬜ | — | — | — |
| `getRegionFee` | ⬜ | — | — | — |
| `getAllFees` | ⬜ | — | — | — |
| `getFeeRecipient` | ⬜ | — | — | — |
| `getTrustedForwarder` | ⬜ | — | — | — |
| `isPaused` | ⬜ | — | — | — |
| `getUsdc` | ⬜ | — | — | — |
| `getProtocolArbiter` | ⬜ | — | — | — |
| `getArbitrationThreshold` | ⬜ | — | — | — |
| `getAgreementDeployer` | ⬜ | — | — | — |
