# FactoryFacet
> **Файл:** `src/FactoryFacet.sol`
> **Теги:** `factory` `fees` `admin`

Фабрика Agreement-контрактов. Хранит fee-конфигурацию, USDC-адрес, trustedForwarder. Деплоит новые эскроу-сделки.

## Модификаторы доступа
- `onlyOwner`
- `whenNotPaused`

## Events
| Event | Параметры |
|-------|-----------|
| `AgreementDeployed` | address indexed agreement, address indexed client, address indexed executor, uint256 amount, uint8 region, uint256 fee |
| `RegionFeeUpdated` | uint8 indexed region, uint256 newFee |
| `FeeRecipientUpdated` | address indexed newRecipient |
| `TrustedForwarderUpdated` | address indexed newForwarder |
| `FactoryPaused` | bool paused |
| `ProtocolArbiterUpdated` | address indexed arbiter |
| `DealFunded` | address indexed agreement, address indexed client, uint256 amount |
| `ArbitrationThresholdUpdated` | uint256 newThreshold |
| `AgreementDeployerUpdated` | address indexed deployer |

## Custom Errors
| Error | Когда |
|-------|-------|
| `FactoryPausedError` | — |
| `ZeroAddress` | — |
| `ZeroAmount` | — |
| `ZeroDeadline` | — |
| `InvalidRegion` | — |
| `ActiveDealExists` | — |
| `ClientEqualsExecutor` | — |
| `NotOwner` | — |
| `AlreadyInitialized` | — |
| `NotClient` | — |
| `DeployerNotSet` | — |

## Write Functions

### `register`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `agreement` | `address` | — |
| `client` | `address` | — |
| `executor` | `address` | — |
| `amount` | `uint256` | — |

**Returns:** `bool`

**Reverts:** `FactoryPausedError`, `ZeroAddress`, `ZeroAmount`, `ZeroDeadline`, `InvalidRegion`, `ActiveDealExists`, `ClientEqualsExecutor`, `NotOwner`, `AlreadyInitialized`, `NotClient`, `DeployerNotSet`

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

**Reverts:** `FactoryPausedError`, `ZeroAddress`, `ZeroAmount`, `ZeroDeadline`, `InvalidRegion`, `ActiveDealExists`, `ClientEqualsExecutor`, `NotOwner`, `AlreadyInitialized`, `NotClient`, `DeployerNotSet`

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

**Reverts:** `FactoryPausedError`, `ZeroAddress`, `ZeroAmount`, `ZeroDeadline`, `InvalidRegion`, `ActiveDealExists`, `ClientEqualsExecutor`, `NotOwner`, `AlreadyInitialized`, `NotClient`, `DeployerNotSet`

---

### `initFactory`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `usdc_` | `address` | — |
| `feeRecipient_` | `address` | — |
| `trustedForwarder_` | `address` | — |
| `diamond_` | `address` | — |
| `agreementDeployer_` | `address` | — |

**Reverts:** `FactoryPausedError`, `ZeroAddress`, `ZeroAmount`, `ZeroDeadline`, `InvalidRegion`, `ActiveDealExists`, `ClientEqualsExecutor`, `NotOwner`, `AlreadyInitialized`, `NotClient`, `DeployerNotSet`

---

### `deployAgreement`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `client` | `address` | — |
| `executor` | `address` | — |
| `address` | `address` | — |
| `amount` | `uint256` | — |
| `deadlineDays` | `uint256` | — |
| `termsHash` | `bytes32` | — |
| `region` | `uint8` | — |

**Returns:** `address agreementAddress`

**Reverts:** `FactoryPausedError`, `ZeroAddress`, `ZeroAmount`, `ZeroDeadline`, `InvalidRegion`, `ActiveDealExists`, `ClientEqualsExecutor`, `NotOwner`, `AlreadyInitialized`, `NotClient`, `DeployerNotSet`

---

### `deployAndFund`

**Mutability:** `nonpayable`  

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `client` | `address` | — |
| `executor` | `address` | — |
| `amount` | `uint256` | — |
| `deadlineDays` | `uint256` | — |
| `termsHash` | `bytes32` | — |
| `region` | `uint8` | — |
| `permitDeadline` | `uint256` | — |
| `v` | `uint8` | — |
| `r` | `bytes32` | — |
| `s` | `bytes32` | — |

**Returns:** `address agreementAddress`

**Reverts:** `FactoryPausedError`, `ZeroAddress`, `ZeroAmount`, `ZeroDeadline`, `InvalidRegion`, `ActiveDealExists`, `ClientEqualsExecutor`, `NotOwner`, `AlreadyInitialized`, `NotClient`, `DeployerNotSet`

---

### `setRegionFee`

**Mutability:** `nonpayable`  
**Access:** `onlyOwner`

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `region` | `uint8` | — |
| `newFee` | `uint256` | — |

**Reverts:** `FactoryPausedError`, `ZeroAddress`, `ZeroAmount`, `ZeroDeadline`, `InvalidRegion`, `ActiveDealExists`, `ClientEqualsExecutor`, `NotOwner`, `AlreadyInitialized`, `NotClient`, `DeployerNotSet`

---

### `setFeeRecipient`

**Mutability:** `nonpayable`  
**Access:** `onlyOwner`

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `newRecipient` | `address` | — |

**Reverts:** `FactoryPausedError`, `ZeroAddress`, `ZeroAmount`, `ZeroDeadline`, `InvalidRegion`, `ActiveDealExists`, `ClientEqualsExecutor`, `NotOwner`, `AlreadyInitialized`, `NotClient`, `DeployerNotSet`

---

### `setTrustedForwarder`

**Mutability:** `nonpayable`  
**Access:** `onlyOwner`

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `newForwarder` | `address` | — |

**Reverts:** `FactoryPausedError`, `ZeroAddress`, `ZeroAmount`, `ZeroDeadline`, `InvalidRegion`, `ActiveDealExists`, `ClientEqualsExecutor`, `NotOwner`, `AlreadyInitialized`, `NotClient`, `DeployerNotSet`

---

### `setPaused`

**Mutability:** `nonpayable`  
**Access:** `onlyOwner`

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `_paused` | `bool` | — |

**Reverts:** `FactoryPausedError`, `ZeroAddress`, `ZeroAmount`, `ZeroDeadline`, `InvalidRegion`, `ActiveDealExists`, `ClientEqualsExecutor`, `NotOwner`, `AlreadyInitialized`, `NotClient`, `DeployerNotSet`

---

### `setProtocolArbiter`

**Mutability:** `nonpayable`  
**Access:** `onlyOwner`

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `arbiter` | `address` | — |

**Reverts:** `FactoryPausedError`, `ZeroAddress`, `ZeroAmount`, `ZeroDeadline`, `InvalidRegion`, `ActiveDealExists`, `ClientEqualsExecutor`, `NotOwner`, `AlreadyInitialized`, `NotClient`, `DeployerNotSet`

---

### `setArbitrationThreshold`

**Mutability:** `nonpayable`  
**Access:** `onlyOwner`

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `newThreshold` | `uint256` | — |

**Reverts:** `FactoryPausedError`, `ZeroAddress`, `ZeroAmount`, `ZeroDeadline`, `InvalidRegion`, `ActiveDealExists`, `ClientEqualsExecutor`, `NotOwner`, `AlreadyInitialized`, `NotClient`, `DeployerNotSet`

---

### `setAgreementDeployer`

**Mutability:** `nonpayable`  
**Access:** `onlyOwner`

**Parameters:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `deployer` | `address` | — |

**Reverts:** `FactoryPausedError`, `ZeroAddress`, `ZeroAmount`, `ZeroDeadline`, `InvalidRegion`, `ActiveDealExists`, `ClientEqualsExecutor`, `NotOwner`, `AlreadyInitialized`, `NotClient`, `DeployerNotSet`

---

## View / Pure Functions

| Функция | Возвращает | Описание |
|---------|-----------|----------|
| `hasActivePair(address, address)` | `bool` | — |
| `getRegionFee(uint8)` | `uint256` | — |
| `getAllFees()` | `uint256 cis, uint256 asia, uint256 eu, uint256 us` | — |
| `getFeeRecipient()` | `address` | — |
| `getTrustedForwarder()` | `address` | — |
| `isPaused()` | `bool` | — |
| `getUsdc()` | `address` | — |
| `getProtocolArbiter()` | `address` | — |
| `getArbitrationThreshold()` | `uint256` | — |
| `getAgreementDeployer()` | `address` | — |
