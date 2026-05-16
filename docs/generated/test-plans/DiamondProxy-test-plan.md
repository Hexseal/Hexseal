# Тест-план: DiamondProxy — Прокси и управление контрактом

> Сеть: Base Sepolia · Diamond: `0xF00CC71878c226E0b64253Fb71dD802aF12165D0`
> Тестер: — · Дата: —

DiamondProxy — главный контракт системы. Пользователи никогда не взаимодействуют с ним напрямую — всё проксируется к фасетам. Тесты здесь в основном административные и проверяются через `/admin` или скрипты Foundry.

---

## Сценарий 1: Проверить владельца Diamond

**Страница:** `/admin` или через explorer
**Предусловие:** кошелёк владельца известен

- [ ] Открыть `/admin` под кошельком, который **не** является owner → страница либо пустая, либо показывает «Not authorized»
- [ ] Переключиться на owner-кошелёк → административные опции доступны
- [ ] Проверить через basescan: `owner()` возвращает ожидаемый адрес

---

## Сценарий 2: DiamondCut — замена фасета (только скрипт)

**Роль:** Владелец Diamond
**Инструмент:** Foundry (`forge script`)
**Предусловие:** написан upgrade-скрипт, например `UpgradeJobBoardFacet.s.sol`

> DiamondCut нельзя сделать через UI — это операция через `cast send` или Foundry скрипт.

- [ ] Задеплоить новую версию фасета: `forge script script/UpgradeJobBoardFacet.s.sol --broadcast`
- [ ] Проверить что транзакция прошла: hash виден в выводе
- [ ] На basescan: найти Diamond-адрес → вкладка «Internal Txns» → новый фасет добавлен
- [ ] Функционал нового фасета работает через UI (например, новая кнопка или поведение)

**Проверить access control:**
- [ ] Попытка DiamondCut от не-owner кошелька → revert (NotOwner / OwnableUnauthorizedAccount)

---

## Сценарий 3: DiamondLoupe — проверить список фасетов

**Инструмент:** cast call или basescan
**Цель:** убедиться, что все нужные фасеты зарегистрированы

- [ ] Выполнить: `cast call $DIAMOND "facets()" --rpc-url $BASE_SEPOLIA_RPC_URL`
- [ ] Убедиться что в списке есть: FactoryFacet, JobBoardFacet, ServiceBoardFacet, ArbiterRegistryFacet, RegistryFacet, JobReceiptFacet, OfferNFTFacet
- [ ] Для каждого фасета: список функций корректный (facetFunctionSelectors)
- [ ] Нет дублирующихся селекторов

---

## Сценарий 4: Передача владения Diamond

**Роль:** Текущий владелец
**Инструмент:** cast send или `/admin`

> Используй с осторожностью — после передачи старый owner теряет доступ к adminPanel.

- [ ] Выполнить: `cast send $DIAMOND "transferOwnership(address)" $NEW_OWNER --private-key $PRIVATE_KEY --rpc-url ...`
- [ ] Проверить: `cast call $DIAMOND "owner()"` → новый адрес
- [ ] Старый owner пробует выполнить admin-операцию → revert

---

## Граничные случаи

- [ ] **Вызов несуществующего селектора** → Diamond возвращает revert с пустыми данными или ошибкой «FunctionNotFound»
- [ ] **Прямой ETH transfer на Diamond без данных** → revert или fallback без паники
- [ ] **DiamondCut с пустым массивом фасетов** → no-op без ошибки (или revert — проверить поведение)

---

## ✅ Итог по сценариям

| Сценарий | Статус | Тестер | Дата | Комментарий |
|----------|--------|--------|------|-------------|
| 1. Проверить owner | ⬜ | — | — | — |
| 2. DiamondCut — замена фасета | ⬜ | — | — | — |
| 3. DiamondLoupe — список фасетов | ⬜ | — | — | — |
| 4. Передача владения | ⬜ | — | — | — |
| Граничные случаи | ⬜ | — | — | — |
