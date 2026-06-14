# Hexseal — Полная карта платформы

> Сводный документ: все страницы, что делают, кто их использует, что реализовано.
> Обновлён: 2026-06-14

---

## Страницы — 21 штука (+ 2 редиректа)

### Публичные / лендинг

| Маршрут | Файл | Кто видит | Что делает |
|---|---|---|---|
| `/` | `app/page.tsx` | все | Лендинг (Hero). Если кошелёк уже подключён — редиректит сразу на `/dashboard` |
| `/docs/faq` | `app/docs/faq/page.tsx` | все | FAQ страница |

---

### Личный кабинет

| Маршрут | Файл | Кто видит | Что делает |
|---|---|---|---|
| `/dashboard` | `app/dashboard/page.tsx` | подключённый | Активные сделки (client + executor), свои листинги, кнопка Fund |

---

### Биржа заказов (Jobs)

| Маршрут | Файл | Кто | Что делает |
|---|---|---|---|
| `/board` | `app/board/page.tsx` | исполнитель | Список открытых заказов от клиентов. Фильтры регионов + категорий + поиск. Откликнуться, отозвать отклик |
| `/board/client/post` | `app/board/client/post/page.tsx` | клиент | Форма публикации заказа: title, desc, бюджет, дедлайн, регион, категория → gasless relay → on-chain |
| `/job/[id]` | `app/job/[id]/page.tsx` | оба | Детальная страница заказа: описание, список откликов, принять исполнителя → создать сделку |
| `/job/[id]/receipt` | `app/job/[id]/receipt/page.tsx` | клиент | Просмотр Job NFT Receipt (Soulbound NFT за выполненную работу) с SVG рендером |

---

### Биржа услуг (Services)

| Маршрут | Файл | Кто | Что делает |
|---|---|---|---|
| `/board/executor` | `app/board/executor/page.tsx` | клиент | Список услуг исполнителей. Фильтры + поиск. Перейти к услуге |
| `/board/executor/post` | `app/board/executor/post/page.tsx` | исполнитель | Форма публикации услуги: title, desc, цена, дедлайн, регион → gasless relay → on-chain |
| `/service/[id]` | `app/service/[id]/page.tsx` | клиент | Детальная страница услуги: описание, кнопка "Запросить" → requestService (gasless, с permit) |
| `/request/[id]` | `app/request/[id]/page.tsx` | исполнитель | Входящий запрос: принять (→ deployAgreement + создать сделку) или отклонить |

---

### Сделка (Deal)

| Маршрут | Файл | Кто | Что делает |
|---|---|---|---|
| `/deal/[address]` | `app/deal/[address]/page.tsx` | оба | **Главная страница сделки.** Полный lifecycle: Fund → Activate → MarkDone → Release / Dispute → Resolve. Чат встроен (ChatPanel). Доп. работы (extras). Таймауты. Статус on-chain |
| `/deal` | `app/deal/page.tsx` | — | Редирект на `/board/client/post` (старый роут) |
| `/deal/[address]/chat` | `app/deal/[address]/chat/page.tsx` | — | Редирект на `/chat?peer=...` (старый роут чата по сделке) |

---

### Чат

| Маршрут | Файл | Кто | Что делает |
|---|---|---|---|
| `/chat` | `app/chat/page.tsx` | подключённый | Список всех чатов (XMTP). Переключение между диалогами |
| `/chat/[address]` | `app/chat/[address]/page.tsx` | подключённый | Прямой DM с конкретным адресом |

> **Как работает чат:** deal-чат = XMTP MLS group (client + executor + relay bot). Прямой чат = XMTP DM 1:1. Файлы шифруются на фронте, хранятся на relay-диске 7 дней.

---

### Уведомления

| Маршрут | Файл | Кто | Что делает |
|---|---|---|---|
| `/notifications` | `app/notifications/page.tsx` | подключённый | Список уведомлений (статусы сделок, входящие запросы). Управление Web Push подпиской (включить/выключить). Кнопки "прочитать все" / "удалить все" |

---

### Профиль

| Маршрут | Файл | Кто | Что делает |
|---|---|---|---|
| `/profile/edit` | `app/profile/edit/page.tsx` | свой | Редактирование профиля: аватар, имя, bio, ссылки → IPFS → on-chain (через relay) |
| `/profile/[address]` | `app/profile/[address]/page.tsx` | все | Публичный профиль: аватар, имя, bio, история сделок |

---

### Арбитраж

| Маршрут | Файл | Кто | Что делает |
|---|---|---|---|
| `/arbiter` | `app/arbiter/page.tsx` | арбитр | Вкладки: Open Disputes (клейм), My Cases (разрешение), History (поиск), Manage (chief only). Лог чата по сделке (DisputeLog — расшифровка по подписи) |

---

### Администрирование

| Маршрут | Файл | Кто | Что делает |
|---|---|---|---|
| `/admin` | `app/admin/page.tsx` | Diamond owner | Управление реестром арбитров, chief arbiter, Protocol Arbiter, пороги, комиссии, пауза |

---

## Что реализовано — статус по фичам

### ✅ Полностью готово

| Фича | Где |
|---|---|
| Создание заказа (клиент) | `/board/client/post` → JobBoard on-chain |
| Отклик на заказ (исполнитель) | `/board` + `/job/[id]` → applyForJob |
| Принятие исполнителя → сделка | `/job/[id]` → acceptApplicant → deployAgreement |
| Создание услуги (исполнитель) | `/board/executor/post` → ServiceBoard on-chain |
| Запрос услуги (клиент) | `/service/[id]` → requestServiceWithPermit |
| Принятие запроса → сделка | `/request/[id]` → acceptRequest → deployAgreement |
| Полный lifecycle сделки | `/deal/[address]` → Fund/Activate/MarkDone/Release/Dispute/Resolve |
| Доп. работы (extras) | `/deal/[address]` → proposeExtra / acceptExtra / rejectExtra |
| Таймауты автоматические | triggerActivationTimeout / triggerDeadlineTimeout / triggerAutoApprove / triggerArbiterTimeout |
| Арбитраж (commit-reveal клейм) | `/arbiter` → commitDisputeClaim → claimDispute |
| Разрешение спора | `/arbiter` → resolveDispute (clientWins) |
| Лог чата по сделке | `/arbiter` DisputeLog → `/dispute-log/:dealId` relay endpoint |
| XMTP чат (deal group + DM) | `/chat`, `/deal/[address]` ChatPanel |
| Файлы в чате (шифрованные) | relay `/files/*` + фронт uploadFileWithEncryption |
| Web Push уведомления | `/notifications`, relay `/push/*` |
| Job NFT Receipt | `/job/[id]/receipt` → claimReceipt |
| Профиль (IPFS) | `/profile/edit`, `/profile/[address]` |
| Admin панель | `/admin` → onlyOwner функции |
| Chief arbiter + реестр | `/admin` + `/arbiter` → addArbiter / removeArbiter |
| Dispute bot (лог с начала) | relay → XMTP MLS group stream → AES-256-GCM log |
| Gasless (ERC-2771) | relay `/relay` → MinimalForwarder.execute() |

### ⚠️ Есть, но не проверено end-to-end

| Фича | Замечание |
|---|---|
| `proposeExtra` через ChatPanel | Нестандартный флоу, нужна живая проверка |
| Dispute bot XMTP init | Проверено локально: `[bot] XMTP ready` ✓ |
| Job NFT Receipt mint | Mintится при closeJob on-chain, но визуально не тестировалось |

### ❌ Не реализовано / заглушки

| Фича | Статус |
|---|---|
| `/docs/faq` контент | Страница есть, контент скорее всего заглушка |
| Arbiter — добавление в deal group | Арбитр не присоединяется к XMTP группе сделки (осознанное решение, есть DisputeLog) |

> **Note про OfferNFTFacet:** контракт назван криво — внутри два слоя. Executor offer-поля помечены `// deprecated` и не используются. Активная часть — **Job Receipt NFT** (Soulbound) для клиента после завершения сделки с джоба. Страница есть: `/job/[id]/receipt`. API: `/api/offer-nft`.

---

## Инфраструктура

| Компонент | Где живёт | Технология |
|---|---|---|
| Фронт | Vercel | Next.js 14, wagmi/viem, framer-motion, XMTP browser-sdk |
| Релей | <провайдер и размер машины> | Node.js Express, ethers.js, XMTP node-sdk, локальный диск |
| Смарт-контракты | Base Sepolia | Solidity 0.8.20, Diamond EIP-2535, ERC-2771 |
| Хранилище файлов | relay `/var/lib/hexseal/storage/` | Локальный диск, TTL 7д для чат-файлов |
| Профили | IPFS (Lighthouse) | lighthouse SDK |
| Push | relay VAPID | web-push npm |

---

## Контракты (Base Sepolia)

| Контракт | Адрес |
|---|---|
| DiamondProxy | `0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557` |
| MinimalForwarder | `0x41c66b80B1445F48AF3863763BC0EC0549413CD7` |
| USDC (тест) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

---

## Пути к ключевым файлам

```
frontend/src/
├── app/                    ← все страницы (21 page.tsx)
├── components/
│   ├── ChatPanel.tsx       ← универсальный чат-компонент (deal group + DM)
│   ├── DealActionBar.tsx   ← кнопки действий по сделке
│   ├── MobileBottomNav.tsx ← нижняя навигация мобильного
│   └── BoardRegionFilter   ← фильтр регионов с wheel-скроллом
├── hooks/
│   ├── useDealGroupChat.ts ← XMTP MLS group для сделки
│   ├── useDirectChat.ts    ← XMTP DM
│   └── useNotifications.ts ← локальные уведомления
├── lib/
│   ├── relay.ts            ← все gasless функции (sendAgreementGasless, fund, etc.)
│   ├── xmtp.ts             ← XMTP client init, findOrCreateDealGroup, getBotAddress
│   └── ipfs.ts             ← загрузка файлов профилей
└── config/
    ├── contracts.ts        ← все ABI + адреса
    └── categories.ts       ← категории (Дизайн, Разработка, ...)

relayer/
└── index.js                ← Express: relay + files + push + XMTP bot + dispute-log
```
