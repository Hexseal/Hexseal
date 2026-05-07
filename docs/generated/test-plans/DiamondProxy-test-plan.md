# Test Plan: DiamondProxy
> Источник: `src/DiamondProxy.sol`
> Сгенерировано: 2026-05-07

Главный прокси-контракт. Содержит DiamondCut, DiamondLoupe и OwnershipFacet. Все вызовы проксируются через fallback к соответствующим фасетам.

## Окружение
| Параметр | Значение |
|----------|----------|
| Сеть | Base Sepolia (chainId 84532) |
| Diamond | `0xF00CC71878c226E0b64253Fb71dD802aF12165D0` |
| Тестовый USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Кошелёк тестера | — |
| Дата теста | — |

## ✏️ Write Functions

### diamondCut

**Happy path:**
- [ ] Вызвать `diamondCut()` с валидными параметрами — транзакция принята

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

---

### diamondCut

**Happy path:**
- [ ] Вызвать `diamondCut()` с валидными параметрами — транзакция принята

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

---

### transferOwnership

**Happy path:**
- [ ] Вызвать `transferOwnership()` с валидными параметрами — транзакция принята
- [ ] Вернулся ожидаемый результат: `address owner_`

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

---

## 👁️ View Functions

### facets

- [ ] Вызвать `facets()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

### facetFunctionSelectors

- [ ] Вызвать `facetFunctionSelectors()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

### facetAddresses

- [ ] Вызвать `facetAddresses()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

### facetAddress

- [ ] Вызвать `facetAddress()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### facets

- [ ] Вызвать `facets()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

### facetFunctionSelectors

- [ ] Вызвать `facetFunctionSelectors()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

### facetAddresses

- [ ] Вызвать `facetAddresses()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)
- [ ] Проверить поведение с пустым массивом (до первой записи)

### facetAddress

- [ ] Вызвать `facetAddress()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### supportsInterface

- [ ] Вызвать `supportsInterface()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### owner

- [ ] Вызвать `owner()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

## 📡 Events

### DiamondCut
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (FacetCut[] _diamondCut, address _init, bytes _calldata) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### OwnershipTransferred
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed previousOwner, address indexed newOwner) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### DiamondCut
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (IDiamondCut.FacetCut[] _diamondCut, address _init, bytes _calldata) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### OwnershipTransferred
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed previousOwner, address indexed newOwner) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

## ✅ Результат
| Функция | Статус | Тестер | Дата | Комментарий |
|---------|--------|--------|------|-------------|
| `diamondCut` | ⬜ | — | — | — |
| `facets` | ⬜ | — | — | — |
| `facetFunctionSelectors` | ⬜ | — | — | — |
| `facetAddresses` | ⬜ | — | — | — |
| `facetAddress` | ⬜ | — | — | — |
| `diamondCut` | ⬜ | — | — | — |
| `facets` | ⬜ | — | — | — |
| `facetFunctionSelectors` | ⬜ | — | — | — |
| `facetAddresses` | ⬜ | — | — | — |
| `facetAddress` | ⬜ | — | — | — |
| `supportsInterface` | ⬜ | — | — | — |
| `transferOwnership` | ⬜ | — | — | — |
| `owner` | ⬜ | — | — | — |
