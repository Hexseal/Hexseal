# Frontend: Deal
> **Файл:** `frontend/src/app/deal/[address]/page.tsx`

Страница конкретной сделки. Полный цикл: Fund → Activate → MarkDone → Release / Dispute → Resolve.

## User Flows
- Клиент: Fund (permit или прямой approve)
- Исполнитель: Activate
- Исполнитель: MarkDone
- Клиент: Release (одобрить) или Dispute (поднять спор)
- Арбитр: Resolve (clientWins: true/false)
- Таймауты: triggerAutoApprove, triggerArbiterTimeout

## Test Checklist

### Клиент: Fund (permit или прямой approve)
- [ ] UI рендерится без ошибок
- [ ] Загрузка данных (loading skeleton → контент)
- [ ] Действие выполняется успешно — toast success
- [ ] On-chain состояние изменилось (проверить через explorer / cast)
- [ ] Ошибочный сценарий — показывается понятный toast error
- [ ] Страница корректна на мобильном (375px)

### Исполнитель: Activate
- [ ] UI рендерится без ошибок
- [ ] Загрузка данных (loading skeleton → контент)
- [ ] Действие выполняется успешно — toast success
- [ ] On-chain состояние изменилось (проверить через explorer / cast)
- [ ] Ошибочный сценарий — показывается понятный toast error
- [ ] Страница корректна на мобильном (375px)

### Исполнитель: MarkDone
- [ ] UI рендерится без ошибок
- [ ] Загрузка данных (loading skeleton → контент)
- [ ] Действие выполняется успешно — toast success
- [ ] On-chain состояние изменилось (проверить через explorer / cast)
- [ ] Ошибочный сценарий — показывается понятный toast error
- [ ] Страница корректна на мобильном (375px)

### Клиент: Release (одобрить) или Dispute (поднять спор)
- [ ] UI рендерится без ошибок
- [ ] Загрузка данных (loading skeleton → контент)
- [ ] Действие выполняется успешно — toast success
- [ ] On-chain состояние изменилось (проверить через explorer / cast)
- [ ] Ошибочный сценарий — показывается понятный toast error
- [ ] Страница корректна на мобильном (375px)

### Арбитр: Resolve (clientWins: true/false)
- [ ] UI рендерится без ошибок
- [ ] Загрузка данных (loading skeleton → контент)
- [ ] Действие выполняется успешно — toast success
- [ ] On-chain состояние изменилось (проверить через explorer / cast)
- [ ] Ошибочный сценарий — показывается понятный toast error
- [ ] Страница корректна на мобильном (375px)

### Таймауты: triggerAutoApprove, triggerArbiterTimeout
- [ ] UI рендерится без ошибок
- [ ] Загрузка данных (loading skeleton → контент)
- [ ] Действие выполняется успешно — toast success
- [ ] On-chain состояние изменилось (проверить через explorer / cast)
- [ ] Ошибочный сценарий — показывается понятный toast error
- [ ] Страница корректна на мобильном (375px)

## Known Edge Cases
- Кошелёк не подключён → показывается prompt подключения
- Неправильная сеть (не Base Sepolia) → показывается предупреждение
- USDC баланс = 0 → кнопки с USDC заблокированы, показывается сумма
- VPN → цена определена как $10, лейбл "VPN · $10"
