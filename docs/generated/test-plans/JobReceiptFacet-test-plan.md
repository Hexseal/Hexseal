# Test Plan: JobReceiptFacet
> Источник: `src/JobReceiptFacet.sol`
> Сгенерировано: 2026-05-07

Soulbound NFT-квитанции за выполненные работы. Минтятся автоматически при закрытии сделки.

## Окружение
| Параметр | Значение |
|----------|----------|
| Сеть | Base Sepolia (chainId 84532) |
| Diamond | `0xF00CC71878c226E0b64253Fb71dD802aF12165D0` |
| Тестовый USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Кошелёк тестера | — |
| Дата теста | — |

## ✏️ Write Functions

### setSvgRenderer

**Happy path:**
- [ ] Вызвать `setSvgRenderer()` с валидными параметрами — транзакция принята
- [ ] Вернулся ожидаемый результат: `address`
- [ ] Event `SvgRendererUpdated` эмитирован с правильными аргументами

**Access control:**
- [ ] Вызов от чужого адреса → revert `NotOwner` / `OwnableUnauthorizedAccount`
- [ ] Вызов от owner → успех

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

---

### mintJobReceipt

**Happy path:**
- [ ] Вызвать `mintJobReceipt()` с валидными параметрами — транзакция принята
- [ ] Вернулся ожидаемый результат: `uint256 tokenId`
- [ ] Event `Transfer` эмитирован с правильными аргументами
- [ ] Event `JobReceiptMinted` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

---

## 👁️ View Functions

### name

- [ ] Вызвать `name()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### symbol

- [ ] Вызвать `symbol()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### supportsInterface

- [ ] Вызвать `supportsInterface()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### balanceOf

- [ ] Вызвать `balanceOf()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### ownerOf

- [ ] Вызвать `ownerOf()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### tokenURI

- [ ] Вызвать `tokenURI()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### transferFrom

- [ ] Вызвать `transferFrom()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### safeTransferFrom

- [ ] Вызвать `safeTransferFrom()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### safeTransferFrom

- [ ] Вызвать `safeTransferFrom()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### approve

- [ ] Вызвать `approve()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### setApprovalForAll

- [ ] Вызвать `setApprovalForAll()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getApproved

- [ ] Вызвать `getApproved()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### isApprovedForAll

- [ ] Вызвать `isApprovedForAll()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getSvgRenderer

- [ ] Вызвать `getSvgRenderer()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getJobReceiptData

- [ ] Вызвать `getJobReceiptData()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### isJobReceiptToken

- [ ] Вызвать `isJobReceiptToken()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getReceiptTotalSupply

- [ ] Вызвать `getReceiptTotalSupply()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

## 📡 Events

### Transfer
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed from, address indexed to, uint256 indexed tokenId) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### JobReceiptMinted
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (uint256 indexed tokenId, uint256 indexed jobId, address indexed client) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### SvgRendererUpdated
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed renderer) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

## ✅ Результат
| Функция | Статус | Тестер | Дата | Комментарий |
|---------|--------|--------|------|-------------|
| `name` | ⬜ | — | — | — |
| `symbol` | ⬜ | — | — | — |
| `supportsInterface` | ⬜ | — | — | — |
| `balanceOf` | ⬜ | — | — | — |
| `ownerOf` | ⬜ | — | — | — |
| `tokenURI` | ⬜ | — | — | — |
| `transferFrom` | ⬜ | — | — | — |
| `safeTransferFrom` | ⬜ | — | — | — |
| `safeTransferFrom` | ⬜ | — | — | — |
| `approve` | ⬜ | — | — | — |
| `setApprovalForAll` | ⬜ | — | — | — |
| `getApproved` | ⬜ | — | — | — |
| `isApprovedForAll` | ⬜ | — | — | — |
| `setSvgRenderer` | ⬜ | — | — | — |
| `getSvgRenderer` | ⬜ | — | — | — |
| `mintJobReceipt` | ⬜ | — | — | — |
| `getJobReceiptData` | ⬜ | — | — | — |
| `isJobReceiptToken` | ⬜ | — | — | — |
| `getReceiptTotalSupply` | ⬜ | — | — | — |
