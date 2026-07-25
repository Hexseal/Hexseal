# Hexseal — Slither + Diamond storage audit

- Slither **0.11.5** (Trail of Bits), solc 0.8.36, crytic-compile 0.3.11
- Команда: `slither . --filter-paths "lib/|test/|script/"` — весь каталог разом
- Результат: **63 контракта, 101 детектор, 155 находок**
- Живая проверка: Diamond `0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557` (Base Sepolia)

Артефакты: `slither.json`, `slither-checklist.md`, `slither-stderr.txt`, `varorder.txt`

---

## Сводка Slither по severity

| Severity | Детектор | Кол-во |
|---|---|---|
| High | encode-packed-collision | 4 |
| High | arbitrary-send-eth | 1 |
| Medium | uninitialized-local | 7 |
| Medium | divide-before-multiply | 5 |
| Medium | incorrect-equality | 4 |
| Medium | unused-return | 4 |
| Low | timestamp | 20 |
| Low | reentrancy-events | 15 |
| Low | reentrancy-benign | 7 |
| Low | missing-zero-check | 6 |
| Low | return-bomb | 1 |
| Info | naming-convention / assembly / low-level-calls / прочее | 81 |

---

## CRITICAL — storage layout break (Slither НЕ нашёл, подтверждено on-chain)

### C1. `bytes32 termsHash` → `string terms` в том же слоте

Коммит `1772ed9` "refactor: replace termsHash (bytes32) with terms (string)"
(деплой-скрипт `script/UpgradeTermsToString.s.sol`, 2026-07-14) заменил тип поля
**на месте**, не сдвигая индекс:

- `JobBoardStorage.Job` поле #5: `bytes32 termsHash` → `string terms`
- `ServiceBoardStorage.HireRequest` поле #4: то же самое

Слот тот же (оба типа занимают 1 слот), но кодировка разная. В слоте старых
записей лежит keccak-дайджест; Solidity читает его как `string`:
младший байт дайджеста произвольный → длина строки берётся из мусора.
При `len/2 > 31` компилятор бросает `Panic(0x22)` — *"storage byte array
incorrectly encoded"*.

**Живое состояние Base Sepolia (`totalJobs` = 19):**

| Job | created | raw terms slot | эффект | status | jobFunds |
|---|---|---|---|---|---|
| 0–11 | 31.05–01.06.2026 | `0x00…` | terms = `""`, безвредно | — | — |
| 12 | до 14.07 | `0x9733…a862` | **getJob revert Panic(0x22)** | CANCELLED | 0 |
| 13 | до 14.07 | `0xa1ac…2092` | **getJob revert Panic(0x22)** | **OPEN** | **5 USDC** |
| 14 | 30.06.2026 | `0x85cc…fc12` | terms = мусор (9 байт) | ACCEPTED | 0 |
| 15 | до 14.07 | `0x0aaa…27a2` | **getJob revert Panic(0x22)** | **OPEN** | **10 USDC** |
| 16–18 | после 16.07 | нормальные строки | ок | — | — |

**Радиус поражения (проверено вызовами):**

1. `getOpenJobs()` → **реверт `Panic(0x22)`**. Функция копирует все OPEN-джобы
   в память, а 13 и 15 — OPEN. **Публичный листинг доски заказов сейчас
   полностью не работает на Base Sepolia.**
2. `getJob(12|13|15)` → реверт. `getJob(14)` → мусор в terms.
3. `acceptApplicant(13|15)` читает `job.terms` (строка 339) → навсегда
   невозможно принять исполнителя по этим заказам.
4. **Деньги НЕ заперты:** `cancelJob` не трогает `terms`. Симуляция
   `cast call cancelJob(13) --from <client>` и `cancelJob(15)` → успех.
   15 USDC клиенты забрать могут.
5. ServiceBoard: латентно. `totalRequests` = 1, запрос создан 17.07 (после
   апгрейда), `terms` = `""`. Пре-апгрейд записей нет — повезло.

**Почему автоматика не поймала:** Slither анализирует один снимок кода.
Изменение типа поля *между версиями* фасета невидимо статике — это класс
багов, специфичный ровно для Diamond/proxy-апгрейдов.

---

## HIGH

### H1. Коллизия селектора `supportsInterface(bytes4)` между фасетами (Diamond-специфично, не от Slither)

`0x01ffc9a7` объявлен и в `DiamondLoupeFacet` (DiamondProxy.sol:344), и в
`JobReceiptFacet` (JobReceiptFacet.sol:75). Это единственная коллизия из
145 селекторов по 11 фасетам.

На живом диамонде селектор роутится на `0x8BC4E7Ba…` = **JobReceiptFacet**
(тот же адрес владеет `balanceOf` и `tokenURI`). Следствия:

| interfaceId | ответ |
|---|---|
| `0x01ffc9a7` ERC-165 | true |
| `0x1f931c1c` IDiamondCut | **false** |
| `0x48e2b093` IDiamondLoupe | **false** |
| `0x80ac58cd` ERC-721 | true |
| `0x5b5e139f` ERC721Metadata | true |

- Нарушение EIP-2535 (диамонд обязан отдавать true на loupe/cut интерфейсы).
- `DiamondStorage.Layout.supportedInterfaces` — мёртвое хранилище, писать
  можно, прочитать через диамонд нельзя.
- `DiamondLoupeFacet.supportsInterface` — недостижимый код.

### H2. `arbitrary-send-eth` — MinimalForwarder.execute (MinimalForwarder.sol:48-63)

```solidity
(success, retdata) = req.to.call{value: req.value, gas: req.gas}(...)
```
Нет `require(msg.value == req.value)`. Форвардер обычно держит нулевой баланс,
поэтому эксплуатации нет — но любой ETH, случайно осевший на контракте,
выводится самоподписанным запросом с `req.value > 0` и `msg.value == 0`.
В OZ `ERC2771Forwarder` value-учёт есть. Дешёвый хардening.

### H3. `encode-packed-collision` ×4 — SVGRenderer (94-102, 201-215, 226-231, 233-241)

**False positive.** `abi.encodePacked` используется для конкатенации SVG-строк,
результат не хэшируется и не идёт в подпись. Детектор ловит только риск
неоднозначности хэша.

---

## MEDIUM

### M1. `incorrect-equality` ×4 — Agreement.sol (422, 421, 790, 798)

`activatedAt == 0`, `fundedAt == 0`, `disputedAt == 0`.
**False positive.** Это sentinel-проверки «этап ещё не наступил», а не
сравнение балансов. Обойти нельзя — timestamp никогда не 0 после записи.

### M2. `divide-before-multiply` ×5 — SVGRenderer._fmtDate (376-395), Agreement._base64Encode (933)

**False positive.** `_fmtDate` — классический алгоритм civil-from-days
(Howard Hinnant), целочисленное деление там по построению. `4 * ((len+2)/3)` —
каноническая формула длины base64. Потери точности намеренные.

### M3. `uninitialized-local` ×7 — RegistryFacet (219, 226, 238, 245, 275, 281), ArbiterRegistryFacet.raiseAppeal (624)

**False positive.** Solidity зануляет локальные переменные. Все семь —
счётчики (`uint256 count;` / `uint256 idx;` / `uint256 eligibleVoters;`),
инкрементируемые в цикле сразу после объявления.

### M4. `unused-return` ×4 — JobBoardFacet (212, 267, 361, 386)

- `mintJobReceipt(...)` возвращает `tokenId`, который игнорируется — но фасет
  сам пишет `jobIdToTokenId` внутри, так что данные не теряются. **Low.**
- `burnJobReceipt(jobId)` обёрнут в `try/catch {}` — намеренно non-blocking,
  чтобы сбой burn'а не блокировал рефанд. Комментарий в коде это фиксирует.
  **Не баг, дизайн.**

---

## LOW

### L1. `timestamp` ×20 — Agreement (10), ArbiterRegistryFacet (5), прочие

Все дедлайны эскроу/арбитража меряются в часах и днях (`FINALIZE_DELAY = 24h`,
`deadlineDays`). На Base блок ~2s, манипуляция валидатором — секунды.
**Принять как есть.**

### L2. `reentrancy-events` ×15 / `reentrancy-benign` ×7

Все точки покрыты `nonReentrant` (Agreement — свой guard; JobBoard/ServiceBoard —
общий `DiamondGuard` из DiamondProxy.sol:86, per-facet guard'ы удалены — это
правильно для Diamond). Оставшееся — порядок «event после external call» и
запись `_finalStatus` после `_complete()`. USDC не имеет колбэков.
**Косметика, но стоит перепроверить `Agreement.fund()`** (462-482): `_mint`
пишется после `safeTransferFrom`.

### L3. `missing-zero-check` ×6

| Место | Параметр |
|---|---|
| Agreement.sol:368 | `arbiter_` |
| ArbiterRegistryFacet.sol:766 | `agreement` в clearStuckVerdict |
| ArbiterRegistryFacet.sol:600 | `agreement` в raiseAppeal |
| ArbiterRegistryFacet.sol:444 | `agreement` в finalizeVerdict |
| JobBoardFacet.sol:317 | `agreementAddr` |
| FactoryFacet.sol:190 | `agreementAddress` |

Вызовы на `address(0)` возвращают `success == true` с пустым `returndata`.
Где после этого идёт `abi.decode` — будет реверт; где проверяется только
`ok` — тихий no-op. Реальный (хоть и низкий) риск для арбитражных путей.

### L4. `return-bomb` — MinimalForwarder.sol:58-60

`retdata` берётся целиком из недоверенного `req.to` при лимите газа.
Злонамеренный `to` возвращает гигантский буфер → memory-expansion съедает газ
релеера. Гриферство против `RELAYER_PRIVATE_KEY`, не кража.

---

## Информационные (81)

`naming-convention` ×27 (в основном `_camelCase` параметры в DiamondProxy —
это стиль эталонной реализации EIP-2535, менять не надо), `assembly` ×20
(все — Diamond Storage `d.slot := pos` и delegatecall в fallback, обязательны),
`low-level-calls` ×19, `missing-inheritance` ×8, `dead-code` ×2,
`unindexed-event-address` ×2 (событие `DiamondCut`), `cyclomatic-complexity` ×1,
`too-many-digits` ×1, `unused-state` ×1 (`ArbiterRegistryFacet.DEFAULT_REWARD`
объявлена, но не используется — 5 USDC ставится где-то иначе, стоит проверить).

---

## Раздел 4 — Diamond storage layout, отдельный разбор

Slither по умолчанию **не проверяет** namespaced-хранилище EIP-2535.
Проверено вручную.

### ✅ Чисто

**1. Ни один фасет не имеет последовательных слотов.**
`slither --print variable-order` по всем 63 контрактам: у всех 11 фасетов
(`FactoryFacet`, `RegistryFacet`, `JobReceiptFacet`, `JobBoardFacet`,
`ServiceBoardFacet`, `ReputationFacet`, `ArbiterRegistryFacet`,
`DealMetadataFacet`, `DiamondCutFacet`, `DiamondLoupeFacet`, `OwnershipFacet`)
— **ноль** state-переменных. Всё через namespaced-библиотеки.
Слоты 0,1,2… в диамонде не заняты вообще — коллизия по конструкции невозможна.

`Agreement` (7–18 слотов) и `MinimalForwarder` (0–2) имеют обычное хранилище,
но это **standalone-контракты**, не фасеты — delegatecall в них не идёт.

**2. Все 9 namespace-слотов не пересекаются.**

| Namespace | base slot | полей |
|---|---|---|
| `hexseal.reputation.storage` | `0x15eae598…10839` | 11 |
| `hexseal.registry.storage` | `0x1df168d2…a61e3` | 4 |
| `hexseal.factory.storage` | `0x2bf0422e…5c2d3` | 9 |
| `hexseal.diamond.reentrancy` | `0x3c235c89…4813a` | 1 |
| `hexseal.serviceboard.storage` | `0x3eb9fbd9…eb092` | 10 |
| `hexseal.jobboard.storage` | `0x86eb1a51…4e204` | 7 |
| `hexseal.arbiterregistry.storage` | `0x916972a9…a0452` | 16 |
| `hexseal.offernft.storage` | `0xc7ea0891…3a75a` | 14 |
| `hexseal.diamond.storage` | `0xdc4d029e…2d2bc` | 6 |

Минимальный зазор между соседними базами ≈ **2^249**, максимальная структура —
17 слотов. Пересечений нет.

**3. Все 8 структур верхнего уровня — строго append-only** по всей истории git:

| Структура | версий | все изменения |
|---|---|---|
| `DiamondStorage.Layout` | 2 | +`pendingOwner` |
| `FactoryStorage.Layout` | 1 | — |
| `RegistryStorage.Layout` | 1 | — |
| `ReceiptStorage.Layout` | 2 | +`jobIdToTokenId`, `jobIdToTokenIdSet` |
| `JobBoardStorage.Layout` | 1 | — |
| `ServiceBoardStorage.Layout` | 2 | +`pendingRequestIdsByClientAndExecutor` |
| `ReputationStorage.Data` | 2 | +`cleanStreak`, `streakEvaluated` |
| `ArbiterRegistryStorage.Data` | **7** | 6 апгрейдов, все append-only |

`ArbiterRegistryStorage.Data` пережил 7 ревизий подряд без единого сдвига —
дисциплина хорошая. Deprecated-слоты сохранены явно
(`_deprecated_receiptNFT`, `_offers_executor`, `_executorOffers`,
`_offerHires`) — правильно.

**4. Вложенная `PendingVerdict`** — 3 версии, append-only (+`executing`,
затем +6 полей апелляции). Это mapping-value, старые записи читают 0 в новых
полях. Безопасно.

**5. Ни у одного фасета нет конструктора или `immutable`** — под delegatecall
они бы не работали. Единственный конструктор в `DiamondProxy` (271), где и
должен быть.

### ⚠️ Проблемы

**6. См. C1 выше** — `Job.terms` и `HireRequest.terms`. Единственные два
нарушения append-only, оба реальные, одно уже сработало на проде.

**7. См. H1 выше** — коллизия селектора `supportsInterface`.

**8. Слоты выводятся как «сырой» `keccak256("строка")`, без ERC-7201.**
Стандарт (`keccak256(abi.encode(uint256(keccak256(id)) - 1)) & ~bytes32(0xff)`)
выравнивает базу по 256 и исключает теоретическое совпадение базы структуры
со слотом, производным от mapping/array. Практически риск нулевой (см. зазоры
2^249), но для мейннета — стандартная галочка для аудиторов.

---

## Приоритет разбора с ревьюером

1. **C1** — доска заказов лежит прямо сейчас; решить, чинить миграцией
   (перезапись `terms` для job 12–15) или ресетом борда на тестнете.
   Главное — процессный вывод: **менять тип поля в Diamond-хранилище нельзя
   даже при том же размере слота.**
2. **H1** — убрать `supportsInterface` из одного из двух фасетов, восстановить
   ERC-165 диамонда.
3. **H2 / L4** — хардening MinimalForwarder (`msg.value`, ограничение returndata).
4. **L3** — zero-check на путях арбитража.
5. **Мейннет:** перевести namespace-слоты на ERC-7201.
6. Остальное (M1–M3, H3) — false positives, характерные для Diamond и
   on-chain-SVG; можно закрывать пачкой.
