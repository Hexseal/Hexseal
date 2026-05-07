# Test Plan: Agreement
> Источник: `src/Agreement.sol`
> Сгенерировано: 2026-05-07

Эскроу-контракт между клиентом и исполнителем. ERC-2771 gasless, USDC permit, reentrancy guard, автоапрув по таймауту.

## Окружение
| Параметр | Значение |
|----------|----------|
| Сеть | Base Sepolia (chainId 84532) |
| Diamond | `0xF00CC71878c226E0b64253Fb71dD802aF12165D0` |
| Тестовый USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Кошелёк тестера | — |
| Дата теста | — |

## ✏️ Write Functions

### approve

**Happy path:**
- [ ] Вызвать `approve()` с валидными параметрами — транзакция принята
- [ ] Event `Approval` эмитирован с правильными аргументами
- [ ] Event `ApprovalForAll` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `ERC721NonexistentToken`
- [ ] Спровоцировать условие → revert `ERC721TransferToZeroAddress`
- [ ] Спровоцировать условие → revert `ERC721AlreadyMinted`
- [ ] Спровоцировать условие → revert `TokenSoulbound`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `NotParty`
- [ ] Спровоцировать условие → revert `AlreadyFunded`
- [ ] Спровоцировать условие → revert `NotFunded`
- [ ] Спровоцировать условие → revert `NotActive`
- [ ] Спровоцировать условие → revert `AlreadyActive`
- [ ] Спровоцировать условие → revert `AlreadyMarkedDone`
- [ ] Спровоцировать условие → revert `NotMarkedDone`
- [ ] Спровоцировать условие → revert `AlreadyDisputed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `AlreadyResolved`
- [ ] Спровоцировать условие → revert `AlreadyFinalized`
- [ ] Спровоцировать условие → revert `WindowNotPassed`
- [ ] Спровоцировать условие → revert `WindowAlreadyPassed`
- [ ] Спровоцировать условие → revert `DeadlinePassed`
- [ ] Спровоцировать условие → revert `DeadlineNotPassed`
- [ ] Спровоцировать условие → revert `ActivationWindowPassed`
- [ ] Спровоцировать условие → revert `NoArbiterSet`

---

### setApprovalForAll

**Happy path:**
- [ ] Вызвать `setApprovalForAll()` с валидными параметрами — транзакция принята
- [ ] Event `Approval` эмитирован с правильными аргументами
- [ ] Event `ApprovalForAll` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

**Revert cases:**
- [ ] Спровоцировать условие → revert `ERC721NonexistentToken`
- [ ] Спровоцировать условие → revert `ERC721TransferToZeroAddress`
- [ ] Спровоцировать условие → revert `ERC721AlreadyMinted`
- [ ] Спровоцировать условие → revert `TokenSoulbound`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `NotParty`
- [ ] Спровоцировать условие → revert `AlreadyFunded`
- [ ] Спровоцировать условие → revert `NotFunded`
- [ ] Спровоцировать условие → revert `NotActive`
- [ ] Спровоцировать условие → revert `AlreadyActive`
- [ ] Спровоцировать условие → revert `AlreadyMarkedDone`
- [ ] Спровоцировать условие → revert `NotMarkedDone`
- [ ] Спровоцировать условие → revert `AlreadyDisputed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `AlreadyResolved`
- [ ] Спровоцировать условие → revert `AlreadyFinalized`
- [ ] Спровоцировать условие → revert `WindowNotPassed`
- [ ] Спровоцировать условие → revert `WindowAlreadyPassed`
- [ ] Спровоцировать условие → revert `DeadlinePassed`
- [ ] Спровоцировать условие → revert `DeadlineNotPassed`
- [ ] Спровоцировать условие → revert `ActivationWindowPassed`
- [ ] Спровоцировать условие → revert `NoArbiterSet`

---

### transferFrom

**Happy path:**
- [ ] Вызвать `transferFrom()` с валидными параметрами — транзакция принята

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `ERC721NonexistentToken`
- [ ] Спровоцировать условие → revert `ERC721TransferToZeroAddress`
- [ ] Спровоцировать условие → revert `ERC721AlreadyMinted`
- [ ] Спровоцировать условие → revert `TokenSoulbound`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `NotParty`
- [ ] Спровоцировать условие → revert `AlreadyFunded`
- [ ] Спровоцировать условие → revert `NotFunded`
- [ ] Спровоцировать условие → revert `NotActive`
- [ ] Спровоцировать условие → revert `AlreadyActive`
- [ ] Спровоцировать условие → revert `AlreadyMarkedDone`
- [ ] Спровоцировать условие → revert `NotMarkedDone`
- [ ] Спровоцировать условие → revert `AlreadyDisputed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `AlreadyResolved`
- [ ] Спровоцировать условие → revert `AlreadyFinalized`
- [ ] Спровоцировать условие → revert `WindowNotPassed`
- [ ] Спровоцировать условие → revert `WindowAlreadyPassed`
- [ ] Спровоцировать условие → revert `DeadlinePassed`
- [ ] Спровоцировать условие → revert `DeadlineNotPassed`
- [ ] Спровоцировать условие → revert `ActivationWindowPassed`
- [ ] Спровоцировать условие → revert `NoArbiterSet`

---

### safeTransferFrom

**Happy path:**
- [ ] Вызвать `safeTransferFrom()` с валидными параметрами — транзакция принята

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `ERC721NonexistentToken`
- [ ] Спровоцировать условие → revert `ERC721TransferToZeroAddress`
- [ ] Спровоцировать условие → revert `ERC721AlreadyMinted`
- [ ] Спровоцировать условие → revert `TokenSoulbound`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `NotParty`
- [ ] Спровоцировать условие → revert `AlreadyFunded`
- [ ] Спровоцировать условие → revert `NotFunded`
- [ ] Спровоцировать условие → revert `NotActive`
- [ ] Спровоцировать условие → revert `AlreadyActive`
- [ ] Спровоцировать условие → revert `AlreadyMarkedDone`
- [ ] Спровоцировать условие → revert `NotMarkedDone`
- [ ] Спровоцировать условие → revert `AlreadyDisputed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `AlreadyResolved`
- [ ] Спровоцировать условие → revert `AlreadyFinalized`
- [ ] Спровоцировать условие → revert `WindowNotPassed`
- [ ] Спровоцировать условие → revert `WindowAlreadyPassed`
- [ ] Спровоцировать условие → revert `DeadlinePassed`
- [ ] Спровоцировать условие → revert `DeadlineNotPassed`
- [ ] Спровоцировать условие → revert `ActivationWindowPassed`
- [ ] Спровоцировать условие → revert `NoArbiterSet`

---

### safeTransferFrom

**Happy path:**
- [ ] Вызвать `safeTransferFrom()` с валидными параметрами — транзакция принята

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore
- [ ] Передать 0 → ожидаемый revert или корректная обработка
- [ ] Передать type(uint256).max → проверить на overflow

**Revert cases:**
- [ ] Спровоцировать условие → revert `ERC721NonexistentToken`
- [ ] Спровоцировать условие → revert `ERC721TransferToZeroAddress`
- [ ] Спровоцировать условие → revert `ERC721AlreadyMinted`
- [ ] Спровоцировать условие → revert `TokenSoulbound`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `NotParty`
- [ ] Спровоцировать условие → revert `AlreadyFunded`
- [ ] Спровоцировать условие → revert `NotFunded`
- [ ] Спровоцировать условие → revert `NotActive`
- [ ] Спровоцировать условие → revert `AlreadyActive`
- [ ] Спровоцировать условие → revert `AlreadyMarkedDone`
- [ ] Спровоцировать условие → revert `NotMarkedDone`
- [ ] Спровоцировать условие → revert `AlreadyDisputed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `AlreadyResolved`
- [ ] Спровоцировать условие → revert `AlreadyFinalized`
- [ ] Спровоцировать условие → revert `WindowNotPassed`
- [ ] Спровоцировать условие → revert `WindowAlreadyPassed`
- [ ] Спровоцировать условие → revert `DeadlinePassed`
- [ ] Спровоцировать условие → revert `DeadlineNotPassed`
- [ ] Спровоцировать условие → revert `ActivationWindowPassed`
- [ ] Спровоцировать условие → revert `NoArbiterSet`

---

### updateStatus

**Happy path:**
- [ ] Вызвать `updateStatus()` с валидными параметрами — транзакция принята

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

**Revert cases:**
- [ ] Спровоцировать условие → revert `ERC721NonexistentToken`
- [ ] Спровоцировать условие → revert `ERC721TransferToZeroAddress`
- [ ] Спровоцировать условие → revert `ERC721AlreadyMinted`
- [ ] Спровоцировать условие → revert `TokenSoulbound`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `NotParty`
- [ ] Спровоцировать условие → revert `AlreadyFunded`
- [ ] Спровоцировать условие → revert `NotFunded`
- [ ] Спровоцировать условие → revert `NotActive`
- [ ] Спровоцировать условие → revert `AlreadyActive`
- [ ] Спровоцировать условие → revert `AlreadyMarkedDone`
- [ ] Спровоцировать условие → revert `NotMarkedDone`
- [ ] Спровоцировать условие → revert `AlreadyDisputed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `AlreadyResolved`
- [ ] Спровоцировать условие → revert `AlreadyFinalized`
- [ ] Спровоцировать условие → revert `WindowNotPassed`
- [ ] Спровоцировать условие → revert `WindowAlreadyPassed`
- [ ] Спровоцировать условие → revert `DeadlinePassed`
- [ ] Спровоцировать условие → revert `DeadlineNotPassed`
- [ ] Спровоцировать условие → revert `ActivationWindowPassed`
- [ ] Спровоцировать условие → revert `NoArbiterSet`

---

### clearDisputeClaim

**Happy path:**
- [ ] Вызвать `clearDisputeClaim()` с валидными параметрами — транзакция принята

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

**Revert cases:**
- [ ] Спровоцировать условие → revert `ERC721NonexistentToken`
- [ ] Спровоцировать условие → revert `ERC721TransferToZeroAddress`
- [ ] Спровоцировать условие → revert `ERC721AlreadyMinted`
- [ ] Спровоцировать условие → revert `TokenSoulbound`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `NotParty`
- [ ] Спровоцировать условие → revert `AlreadyFunded`
- [ ] Спровоцировать условие → revert `NotFunded`
- [ ] Спровоцировать условие → revert `NotActive`
- [ ] Спровоцировать условие → revert `AlreadyActive`
- [ ] Спровоцировать условие → revert `AlreadyMarkedDone`
- [ ] Спровоцировать условие → revert `NotMarkedDone`
- [ ] Спровоцировать условие → revert `AlreadyDisputed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `AlreadyResolved`
- [ ] Спровоцировать условие → revert `AlreadyFinalized`
- [ ] Спровоцировать условие → revert `WindowNotPassed`
- [ ] Спровоцировать условие → revert `WindowAlreadyPassed`
- [ ] Спровоцировать условие → revert `DeadlinePassed`
- [ ] Спровоцировать условие → revert `DeadlineNotPassed`
- [ ] Спровоцировать условие → revert `ActivationWindowPassed`
- [ ] Спровоцировать условие → revert `NoArbiterSet`

---

### setArbiter
> Только Diamond может вызвать — проверяем msg.sender напрямую (не ERC-2771).

**Happy path:**
- [ ] Вызвать `setArbiter()` с валидными параметрами — транзакция принята

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)
- [ ] Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore

**Revert cases:**
- [ ] Спровоцировать условие → revert `ERC721NonexistentToken`
- [ ] Спровоцировать условие → revert `ERC721TransferToZeroAddress`
- [ ] Спровоцировать условие → revert `ERC721AlreadyMinted`
- [ ] Спровоцировать условие → revert `TokenSoulbound`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `NotParty`
- [ ] Спровоцировать условие → revert `AlreadyFunded`
- [ ] Спровоцировать условие → revert `NotFunded`
- [ ] Спровоцировать условие → revert `NotActive`
- [ ] Спровоцировать условие → revert `AlreadyActive`
- [ ] Спровоцировать условие → revert `AlreadyMarkedDone`
- [ ] Спровоцировать условие → revert `NotMarkedDone`
- [ ] Спровоцировать условие → revert `AlreadyDisputed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `AlreadyResolved`
- [ ] Спровоцировать условие → revert `AlreadyFinalized`
- [ ] Спровоцировать условие → revert `WindowNotPassed`
- [ ] Спровоцировать условие → revert `WindowAlreadyPassed`
- [ ] Спровоцировать условие → revert `DeadlinePassed`
- [ ] Спровоцировать условие → revert `DeadlineNotPassed`
- [ ] Спровоцировать условие → revert `ActivationWindowPassed`
- [ ] Спровоцировать условие → revert `NoArbiterSet`

---

### fund
> Клиент должен сделать approve(agreement, amount) на USDC перед вызовом

**Happy path:**
- [ ] Вызвать `fund()` с валидными параметрами — транзакция принята
- [ ] Event `Funded` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)

**Revert cases:**
- [ ] Спровоцировать условие → revert `ERC721NonexistentToken`
- [ ] Спровоцировать условие → revert `ERC721TransferToZeroAddress`
- [ ] Спровоцировать условие → revert `ERC721AlreadyMinted`
- [ ] Спровоцировать условие → revert `TokenSoulbound`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `NotParty`
- [ ] Спровоцировать условие → revert `AlreadyFunded`
- [ ] Спровоцировать условие → revert `NotFunded`
- [ ] Спровоцировать условие → revert `NotActive`
- [ ] Спровоцировать условие → revert `AlreadyActive`
- [ ] Спровоцировать условие → revert `AlreadyMarkedDone`
- [ ] Спровоцировать условие → revert `NotMarkedDone`
- [ ] Спровоцировать условие → revert `AlreadyDisputed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `AlreadyResolved`
- [ ] Спровоцировать условие → revert `AlreadyFinalized`
- [ ] Спровоцировать условие → revert `WindowNotPassed`
- [ ] Спровоцировать условие → revert `WindowAlreadyPassed`
- [ ] Спровоцировать условие → revert `DeadlinePassed`
- [ ] Спровоцировать условие → revert `DeadlineNotPassed`
- [ ] Спровоцировать условие → revert `ActivationWindowPassed`
- [ ] Спровоцировать условие → revert `NoArbiterSet`

---

### fundFromFactory
> Only factory can call this — used by deployAndFund()

**Happy path:**
- [ ] Вызвать `fundFromFactory()` с валидными параметрами — транзакция принята
- [ ] Event `Funded` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)

**Revert cases:**
- [ ] Спровоцировать условие → revert `ERC721NonexistentToken`
- [ ] Спровоцировать условие → revert `ERC721TransferToZeroAddress`
- [ ] Спровоцировать условие → revert `ERC721AlreadyMinted`
- [ ] Спровоцировать условие → revert `TokenSoulbound`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `NotParty`
- [ ] Спровоцировать условие → revert `AlreadyFunded`
- [ ] Спровоцировать условие → revert `NotFunded`
- [ ] Спровоцировать условие → revert `NotActive`
- [ ] Спровоцировать условие → revert `AlreadyActive`
- [ ] Спровоцировать условие → revert `AlreadyMarkedDone`
- [ ] Спровоцировать условие → revert `NotMarkedDone`
- [ ] Спровоцировать условие → revert `AlreadyDisputed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `AlreadyResolved`
- [ ] Спровоцировать условие → revert `AlreadyFinalized`
- [ ] Спровоцировать условие → revert `WindowNotPassed`
- [ ] Спровоцировать условие → revert `WindowAlreadyPassed`
- [ ] Спровоцировать условие → revert `DeadlinePassed`
- [ ] Спровоцировать условие → revert `DeadlineNotPassed`
- [ ] Спровоцировать условие → revert `ActivationWindowPassed`
- [ ] Спровоцировать условие → revert `NoArbiterSet`

---

### activate
> После этого клиент не может забрать деньги

**Happy path:**
- [ ] Вызвать `activate()` с валидными параметрами — транзакция принята
- [ ] Event `Activated` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)

**Revert cases:**
- [ ] Спровоцировать условие → revert `ERC721NonexistentToken`
- [ ] Спровоцировать условие → revert `ERC721TransferToZeroAddress`
- [ ] Спровоцировать условие → revert `ERC721AlreadyMinted`
- [ ] Спровоцировать условие → revert `TokenSoulbound`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `NotParty`
- [ ] Спровоцировать условие → revert `AlreadyFunded`
- [ ] Спровоцировать условие → revert `NotFunded`
- [ ] Спровоцировать условие → revert `NotActive`
- [ ] Спровоцировать условие → revert `AlreadyActive`
- [ ] Спровоцировать условие → revert `AlreadyMarkedDone`
- [ ] Спровоцировать условие → revert `NotMarkedDone`
- [ ] Спровоцировать условие → revert `AlreadyDisputed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `AlreadyResolved`
- [ ] Спровоцировать условие → revert `AlreadyFinalized`
- [ ] Спровоцировать условие → revert `WindowNotPassed`
- [ ] Спровоцировать условие → revert `WindowAlreadyPassed`
- [ ] Спровоцировать условие → revert `DeadlinePassed`
- [ ] Спровоцировать условие → revert `DeadlineNotPassed`
- [ ] Спровоцировать условие → revert `ActivationWindowPassed`
- [ ] Спровоцировать условие → revert `NoArbiterSet`

---

### markDone
> @notice Исполнитель сигнализирует о завершении работы

**Happy path:**
- [ ] Вызвать `markDone()` с валидными параметрами — транзакция принята
- [ ] Event `MarkedDone` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)

**Revert cases:**
- [ ] Спровоцировать условие → revert `ERC721NonexistentToken`
- [ ] Спровоцировать условие → revert `ERC721TransferToZeroAddress`
- [ ] Спровоцировать условие → revert `ERC721AlreadyMinted`
- [ ] Спровоцировать условие → revert `TokenSoulbound`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `NotParty`
- [ ] Спровоцировать условие → revert `AlreadyFunded`
- [ ] Спровоцировать условие → revert `NotFunded`
- [ ] Спровоцировать условие → revert `NotActive`
- [ ] Спровоцировать условие → revert `AlreadyActive`
- [ ] Спровоцировать условие → revert `AlreadyMarkedDone`
- [ ] Спровоцировать условие → revert `NotMarkedDone`
- [ ] Спровоцировать условие → revert `AlreadyDisputed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `AlreadyResolved`
- [ ] Спровоцировать условие → revert `AlreadyFinalized`
- [ ] Спровоцировать условие → revert `WindowNotPassed`
- [ ] Спровоцировать условие → revert `WindowAlreadyPassed`
- [ ] Спровоцировать условие → revert `DeadlinePassed`
- [ ] Спровоцировать условие → revert `DeadlineNotPassed`
- [ ] Спровоцировать условие → revert `ActivationWindowPassed`
- [ ] Спровоцировать условие → revert `NoArbiterSet`

---

### release
> @notice Клиент подтверждает выполнение → USDC уходит исполнителю

**Happy path:**
- [ ] Вызвать `release()` с валидными параметрами — транзакция принята
- [ ] Event `Released` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)

**Revert cases:**
- [ ] Спровоцировать условие → revert `ERC721NonexistentToken`
- [ ] Спровоцировать условие → revert `ERC721TransferToZeroAddress`
- [ ] Спровоцировать условие → revert `ERC721AlreadyMinted`
- [ ] Спровоцировать условие → revert `TokenSoulbound`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `NotParty`
- [ ] Спровоцировать условие → revert `AlreadyFunded`
- [ ] Спровоцировать условие → revert `NotFunded`
- [ ] Спровоцировать условие → revert `NotActive`
- [ ] Спровоцировать условие → revert `AlreadyActive`
- [ ] Спровоцировать условие → revert `AlreadyMarkedDone`
- [ ] Спровоцировать условие → revert `NotMarkedDone`
- [ ] Спровоцировать условие → revert `AlreadyDisputed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `AlreadyResolved`
- [ ] Спровоцировать условие → revert `AlreadyFinalized`
- [ ] Спровоцировать условие → revert `WindowNotPassed`
- [ ] Спровоцировать условие → revert `WindowAlreadyPassed`
- [ ] Спровоцировать условие → revert `DeadlinePassed`
- [ ] Спровоцировать условие → revert `DeadlineNotPassed`
- [ ] Спровоцировать условие → revert `ActivationWindowPassed`
- [ ] Спровоцировать условие → revert `NoArbiterSet`

---

### triggerAutoApprove
> Клиент не ответил → исполнитель получает деньги автоматически

**Happy path:**
- [ ] Вызвать `triggerAutoApprove()` с валидными параметрами — транзакция принята
- [ ] Event `AutoApproved` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)

**Revert cases:**
- [ ] Спровоцировать условие → revert `ERC721NonexistentToken`
- [ ] Спровоцировать условие → revert `ERC721TransferToZeroAddress`
- [ ] Спровоцировать условие → revert `ERC721AlreadyMinted`
- [ ] Спровоцировать условие → revert `TokenSoulbound`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `NotParty`
- [ ] Спровоцировать условие → revert `AlreadyFunded`
- [ ] Спровоцировать условие → revert `NotFunded`
- [ ] Спровоцировать условие → revert `NotActive`
- [ ] Спровоцировать условие → revert `AlreadyActive`
- [ ] Спровоцировать условие → revert `AlreadyMarkedDone`
- [ ] Спровоцировать условие → revert `NotMarkedDone`
- [ ] Спровоцировать условие → revert `AlreadyDisputed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `AlreadyResolved`
- [ ] Спровоцировать условие → revert `AlreadyFinalized`
- [ ] Спровоцировать условие → revert `WindowNotPassed`
- [ ] Спровоцировать условие → revert `WindowAlreadyPassed`
- [ ] Спровоцировать условие → revert `DeadlinePassed`
- [ ] Спровоцировать условие → revert `DeadlineNotPassed`
- [ ] Спровоцировать условие → revert `ActivationWindowPassed`
- [ ] Спровоцировать условие → revert `NoArbiterSet`

---

### raiseDispute
> Можно поднять спор даже после markDone, если AUTO_APPROVE_WINDOW ещё не прошёл

**Happy path:**
- [ ] Вызвать `raiseDispute()` с валидными параметрами — транзакция принята
- [ ] Event `DisputeRaised` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)

**Revert cases:**
- [ ] Спровоцировать условие → revert `ERC721NonexistentToken`
- [ ] Спровоцировать условие → revert `ERC721TransferToZeroAddress`
- [ ] Спровоцировать условие → revert `ERC721AlreadyMinted`
- [ ] Спровоцировать условие → revert `TokenSoulbound`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `NotParty`
- [ ] Спровоцировать условие → revert `AlreadyFunded`
- [ ] Спровоцировать условие → revert `NotFunded`
- [ ] Спровоцировать условие → revert `NotActive`
- [ ] Спровоцировать условие → revert `AlreadyActive`
- [ ] Спровоцировать условие → revert `AlreadyMarkedDone`
- [ ] Спровоцировать условие → revert `NotMarkedDone`
- [ ] Спровоцировать условие → revert `AlreadyDisputed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `AlreadyResolved`
- [ ] Спровоцировать условие → revert `AlreadyFinalized`
- [ ] Спровоцировать условие → revert `WindowNotPassed`
- [ ] Спровоцировать условие → revert `WindowAlreadyPassed`
- [ ] Спровоцировать условие → revert `DeadlinePassed`
- [ ] Спровоцировать условие → revert `DeadlineNotPassed`
- [ ] Спровоцировать условие → revert `ActivationWindowPassed`
- [ ] Спровоцировать условие → revert `NoArbiterSet`

---

### resolveDispute
> clientWins = false → оплата исполнителю

**Happy path:**
- [ ] Вызвать `resolveDispute()` с валидными параметрами — транзакция принята
- [ ] Event `DisputeResolved` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)

**Revert cases:**
- [ ] Спровоцировать условие → revert `ERC721NonexistentToken`
- [ ] Спровоцировать условие → revert `ERC721TransferToZeroAddress`
- [ ] Спровоцировать условие → revert `ERC721AlreadyMinted`
- [ ] Спровоцировать условие → revert `TokenSoulbound`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `NotParty`
- [ ] Спровоцировать условие → revert `AlreadyFunded`
- [ ] Спровоцировать условие → revert `NotFunded`
- [ ] Спровоцировать условие → revert `NotActive`
- [ ] Спровоцировать условие → revert `AlreadyActive`
- [ ] Спровоцировать условие → revert `AlreadyMarkedDone`
- [ ] Спровоцировать условие → revert `NotMarkedDone`
- [ ] Спровоцировать условие → revert `AlreadyDisputed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `AlreadyResolved`
- [ ] Спровоцировать условие → revert `AlreadyFinalized`
- [ ] Спровоцировать условие → revert `WindowNotPassed`
- [ ] Спровоцировать условие → revert `WindowAlreadyPassed`
- [ ] Спровоцировать условие → revert `DeadlinePassed`
- [ ] Спровоцировать условие → revert `DeadlineNotPassed`
- [ ] Спровоцировать условие → revert `ActivationWindowPassed`
- [ ] Спровоцировать условие → revert `NoArbiterSet`

---

### triggerActivationTimeout
> Рефанд клиенту

**Happy path:**
- [ ] Вызвать `triggerActivationTimeout()` с валидными параметрами — транзакция принята
- [ ] Event `TimedOut` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)

**Revert cases:**
- [ ] Спровоцировать условие → revert `ERC721NonexistentToken`
- [ ] Спровоцировать условие → revert `ERC721TransferToZeroAddress`
- [ ] Спровоцировать условие → revert `ERC721AlreadyMinted`
- [ ] Спровоцировать условие → revert `TokenSoulbound`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `NotParty`
- [ ] Спровоцировать условие → revert `AlreadyFunded`
- [ ] Спровоцировать условие → revert `NotFunded`
- [ ] Спровоцировать условие → revert `NotActive`
- [ ] Спровоцировать условие → revert `AlreadyActive`
- [ ] Спровоцировать условие → revert `AlreadyMarkedDone`
- [ ] Спровоцировать условие → revert `NotMarkedDone`
- [ ] Спровоцировать условие → revert `AlreadyDisputed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `AlreadyResolved`
- [ ] Спровоцировать условие → revert `AlreadyFinalized`
- [ ] Спровоцировать условие → revert `WindowNotPassed`
- [ ] Спровоцировать условие → revert `WindowAlreadyPassed`
- [ ] Спровоцировать условие → revert `DeadlinePassed`
- [ ] Спровоцировать условие → revert `DeadlineNotPassed`
- [ ] Спровоцировать условие → revert `ActivationWindowPassed`
- [ ] Спровоцировать условие → revert `NoArbiterSet`

---

### triggerDeadlineTimeout
> Рефанд клиенту

**Happy path:**
- [ ] Вызвать `triggerDeadlineTimeout()` с валидными параметрами — транзакция принята
- [ ] Event `TimedOut` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)

**Revert cases:**
- [ ] Спровоцировать условие → revert `ERC721NonexistentToken`
- [ ] Спровоцировать условие → revert `ERC721TransferToZeroAddress`
- [ ] Спровоцировать условие → revert `ERC721AlreadyMinted`
- [ ] Спровоцировать условие → revert `TokenSoulbound`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `NotParty`
- [ ] Спровоцировать условие → revert `AlreadyFunded`
- [ ] Спровоцировать условие → revert `NotFunded`
- [ ] Спровоцировать условие → revert `NotActive`
- [ ] Спровоцировать условие → revert `AlreadyActive`
- [ ] Спровоцировать условие → revert `AlreadyMarkedDone`
- [ ] Спровоцировать условие → revert `NotMarkedDone`
- [ ] Спровоцировать условие → revert `AlreadyDisputed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `AlreadyResolved`
- [ ] Спровоцировать условие → revert `AlreadyFinalized`
- [ ] Спровоцировать условие → revert `WindowNotPassed`
- [ ] Спровоцировать условие → revert `WindowAlreadyPassed`
- [ ] Спровоцировать условие → revert `DeadlinePassed`
- [ ] Спровоцировать условие → revert `DeadlineNotPassed`
- [ ] Спровоцировать условие → revert `ActivationWindowPassed`
- [ ] Спровоцировать условие → revert `NoArbiterSet`

---

### triggerArbiterTimeout
> Авторефанд клиенту — защита от неактивного/злонамеренного арбитра

**Happy path:**
- [ ] Вызвать `triggerArbiterTimeout()` с валидными параметрами — транзакция принята
- [ ] Event `ArbiterTimedOut` эмитирован с правильными аргументами

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)

**Revert cases:**
- [ ] Спровоцировать условие → revert `ERC721NonexistentToken`
- [ ] Спровоцировать условие → revert `ERC721TransferToZeroAddress`
- [ ] Спровоцировать условие → revert `ERC721AlreadyMinted`
- [ ] Спровоцировать условие → revert `TokenSoulbound`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `NotParty`
- [ ] Спровоцировать условие → revert `AlreadyFunded`
- [ ] Спровоцировать условие → revert `NotFunded`
- [ ] Спровоцировать условие → revert `NotActive`
- [ ] Спровоцировать условие → revert `AlreadyActive`
- [ ] Спровоцировать условие → revert `AlreadyMarkedDone`
- [ ] Спровоцировать условие → revert `NotMarkedDone`
- [ ] Спровоцировать условие → revert `AlreadyDisputed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `AlreadyResolved`
- [ ] Спровоцировать условие → revert `AlreadyFinalized`
- [ ] Спровоцировать условие → revert `WindowNotPassed`
- [ ] Спровоцировать условие → revert `WindowAlreadyPassed`
- [ ] Спровоцировать условие → revert `DeadlinePassed`
- [ ] Спровоцировать условие → revert `DeadlineNotPassed`
- [ ] Спровоцировать условие → revert `ActivationWindowPassed`
- [ ] Спровоцировать условие → revert `NoArbiterSet`

---

### syncRegistry
> Может вызвать любой.

**Happy path:**
- [ ] Вызвать `syncRegistry()` с валидными параметрами — транзакция принята

**Access control:**
- [ ] Функция публичная — проверить что работает с любого адреса

**Edge cases:**
- [ ] Повторный вызов (идемпотентность / защита от дублей)

**Revert cases:**
- [ ] Спровоцировать условие → revert `ERC721NonexistentToken`
- [ ] Спровоцировать условие → revert `ERC721TransferToZeroAddress`
- [ ] Спровоцировать условие → revert `ERC721AlreadyMinted`
- [ ] Спровоцировать условие → revert `TokenSoulbound`
- [ ] Спровоцировать условие → revert `NotClient`
- [ ] Спровоцировать условие → revert `NotExecutor`
- [ ] Спровоцировать условие → revert `NotArbiter`
- [ ] Спровоцировать условие → revert `NotParty`
- [ ] Спровоцировать условие → revert `AlreadyFunded`
- [ ] Спровоцировать условие → revert `NotFunded`
- [ ] Спровоцировать условие → revert `NotActive`
- [ ] Спровоцировать условие → revert `AlreadyActive`
- [ ] Спровоцировать условие → revert `AlreadyMarkedDone`
- [ ] Спровоцировать условие → revert `NotMarkedDone`
- [ ] Спровоцировать условие → revert `AlreadyDisputed`
- [ ] Спровоцировать условие → revert `NotDisputed`
- [ ] Спровоцировать условие → revert `AlreadyResolved`
- [ ] Спровоцировать условие → revert `AlreadyFinalized`
- [ ] Спровоцировать условие → revert `WindowNotPassed`
- [ ] Спровоцировать условие → revert `WindowAlreadyPassed`
- [ ] Спровоцировать условие → revert `DeadlinePassed`
- [ ] Спровоцировать условие → revert `DeadlineNotPassed`
- [ ] Спровоцировать условие → revert `ActivationWindowPassed`
- [ ] Спровоцировать условие → revert `NoArbiterSet`

---

## 👁️ View Functions

### name

- [ ] Вызвать `name()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### symbol

- [ ] Вызвать `symbol()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### ownerOf

- [ ] Вызвать `ownerOf()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### balanceOf

- [ ] Вызвать `balanceOf()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getApproved

- [ ] Вызвать `getApproved()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### isApprovedForAll

- [ ] Вызвать `isApprovedForAll()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### supportsInterface

- [ ] Вызвать `supportsInterface()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### isTrustedForwarder

- [ ] Вызвать `isTrustedForwarder()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### trustedForwarder

- [ ] Вызвать `trustedForwarder()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### balanceOf

- [ ] Вызвать `balanceOf()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### status

- [ ] Вызвать `status()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### getDetails

- [ ] Вызвать `getDetails()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### timeLeft
> @notice Сколько времени осталось до дедлайна (0 если прошёл)

- [ ] Вызвать `timeLeft()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### arbiterTimeLeft
> @notice Сколько времени осталось арбитру (0 если не в споре или прошёл)

- [ ] Вызвать `arbiterTimeLeft()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

### tokenURI

- [ ] Вызвать `tokenURI()` — возвращает данные без revert
- [ ] Результат соответствует on-chain состоянию (проверить через explorer или cast call)

## 📡 Events

### Transfer
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed from, address indexed to, uint256 indexed tokenId) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### Approval
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed owner, address indexed approved, uint256 indexed tokenId) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### ApprovalForAll
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed owner, address indexed operator, bool approved) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### Funded
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed client, uint256 amount) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### Activated
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed executor) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### MarkedDone
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed executor) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### Released
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed client, address indexed executor, uint256 amount) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### AutoApproved
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed executor, uint256 amount) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### DisputeRaised
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed by) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### DisputeResolved
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed arbiter, bool clientWins, uint256 amount) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### TimedOut
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed client, uint256 amount) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### ArbiterTimedOut
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed client, uint256 amount) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

### RegistrySyncFailed
- [ ] Эмитируется при правильном условии
- [ ] Все параметры (address indexed agreement, uint8 targetStatus) заполнены верно
- [ ] Indexed-параметры фильтруются корректно

## ✅ Результат
| Функция | Статус | Тестер | Дата | Комментарий |
|---------|--------|--------|------|-------------|
| `name` | ⬜ | — | — | — |
| `symbol` | ⬜ | — | — | — |
| `ownerOf` | ⬜ | — | — | — |
| `balanceOf` | ⬜ | — | — | — |
| `getApproved` | ⬜ | — | — | — |
| `isApprovedForAll` | ⬜ | — | — | — |
| `approve` | ⬜ | — | — | — |
| `setApprovalForAll` | ⬜ | — | — | — |
| `transferFrom` | ⬜ | — | — | — |
| `safeTransferFrom` | ⬜ | — | — | — |
| `safeTransferFrom` | ⬜ | — | — | — |
| `supportsInterface` | ⬜ | — | — | — |
| `isTrustedForwarder` | ⬜ | — | — | — |
| `trustedForwarder` | ⬜ | — | — | — |
| `balanceOf` | ⬜ | — | — | — |
| `updateStatus` | ⬜ | — | — | — |
| `clearDisputeClaim` | ⬜ | — | — | — |
| `setArbiter` | ⬜ | — | — | — |
| `status` | ⬜ | — | — | — |
| `fund` | ⬜ | — | — | — |
| `fundFromFactory` | ⬜ | — | — | — |
| `activate` | ⬜ | — | — | — |
| `markDone` | ⬜ | — | — | — |
| `release` | ⬜ | — | — | — |
| `triggerAutoApprove` | ⬜ | — | — | — |
| `raiseDispute` | ⬜ | — | — | — |
| `resolveDispute` | ⬜ | — | — | — |
| `triggerActivationTimeout` | ⬜ | — | — | — |
| `triggerDeadlineTimeout` | ⬜ | — | — | — |
| `triggerArbiterTimeout` | ⬜ | — | — | — |
| `getDetails` | ⬜ | — | — | — |
| `timeLeft` | ⬜ | — | — | — |
| `arbiterTimeLeft` | ⬜ | — | — | — |
| `tokenURI` | ⬜ | — | — | — |
| `syncRegistry` | ⬜ | — | — | — |
