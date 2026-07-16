# Hexseal — Деплой на VPS

---

## Архитектура

**Один VPS** → Docker Compose → 3 контейнера → Cloudflare Tunnel

```
hexseal.net         → frontend  (Next.js  :3000)
api.hexseal.net     → relayer   (Node.js  :3001)
                      cloudflared  — SSL / routing (без nginx)
```

| Что | Где |
|---|---|
| VPS | Hetzner `<адрес сервера>` |
| Путь на VPS | `/opt/hexseal/app/` |
| Деплой | `bash deploy-local.sh` (локальный сборки → SSH → VPS) |
| Хранилище файлов | Docker volume `relayer_storage` → `/app/storage/` |

---

## Env файлы

### Локально (разработка)

| Файл | Назначение |
|---|---|
| `.env` | Foundry / `cast` команды |
| `frontend/.env.local` | Локальная разработка Next.js (ngrok URL для релеера) |
| `relayer/.env.relayer` | Локальный запуск релеера |

### На VPS — один файл

`/opt/hexseal/app/.env.vps` — всё в одном. `deploy-local.sh` тянет его по SCP перед сборкой, чтобы запечь `NEXT_PUBLIC_*` переменные в Next.js бандл.

```env
# ── Сеть ──────────────────────────────────────────────────────────────────────
RPC_URL=https://lb.drpc.org/ogrpc?network=base-sepolia&dkey=ВАШ_DRPC_КЛЮЧ
DRPC_URL=https://lb.drpc.org/ogrpc?network=base-sepolia&dkey=ВАШ_DRPC_КЛЮЧ

# Публичный RPC — бесплатный, медленнее (для NEXT_PUBLIC_*)
NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL=https://base-sepolia.drpc.org
NEXT_PUBLIC_RPC_URL=https://base-sepolia.drpc.org

# ── Контракты ─────────────────────────────────────────────────────────────────
NEXT_PUBLIC_DIAMOND_ADDRESS=0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557
NEXT_PUBLIC_FORWARDER_ADDRESS=0x41c66b80B1445F48AF3863763BC0EC0549413CD7
NEXT_PUBLIC_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
NEXT_PUBLIC_JOB_RECEIPT_ADDRESS=0x...   # адрес JobReceiptFacet если нужен на фронте
DIAMOND_ADDRESS=0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557
NEXT_PUBLIC_CHAIN_ID=84532

# ── Subgraph ───────────────────────────────────────────────────────────────────
SUBGRAPH_URL=https://api.studio.thegraph.com/query/1755241/hexseal/latest

# ── Релеер ────────────────────────────────────────────────────────────────────
RELAYER_PRIVATE_KEY=0xВАШ_КЛЮЧ_РЕЛЕЕРА
NEXT_PUBLIC_RELAYER_URL=https://api.hexseal.net

# Секрет для детерминированного XMTP бот-кошелька — сгенерировать 1 раз:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SERVER_SECRET=СГЕНЕРИРОВАННЫЙ_СЕКРЕТ

# ── Web Push / VAPID ───────────────────────────────────────────────────────────
# Сгенерировать 1 раз:
#   node -e "const wp=require('web-push'); const k=wp.generateVAPIDKeys(); console.log(JSON.stringify(k,null,2))"
VAPID_PUBLIC_KEY=СГЕНЕРИРОВАННЫЙ_PUBLIC_KEY
VAPID_PRIVATE_KEY=СГЕНЕРИРОВАННЫЙ_PRIVATE_KEY
VAPID_EMAIL=mailto:admin@hexseal.net
# Должен совпадать с VAPID_PUBLIC_KEY:
NEXT_PUBLIC_VAPID_PUBLIC_KEY=ТОТ_ЖЕ_PUBLIC_KEY

# ── WalletConnect ─────────────────────────────────────────────────────────────
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=ВАШ_WC_PROJECT_ID

# ── CORS ──────────────────────────────────────────────────────────────────────
ALLOWED_ORIGINS=https://hexseal.net,https://www.hexseal.net

# ── Legacy (чтение старых аватаров из IPFS) ───────────────────────────────────
NEXT_PUBLIC_IPFS_GATEWAY=https://w3s.link

# ── Cloudflare Tunnel ─────────────────────────────────────────────────────────
CLOUDFLARE_TUNNEL_TOKEN=ВАШ_TUNNEL_TOKEN
```

> **VAPID**: `VAPID_PUBLIC_KEY` и `NEXT_PUBLIC_VAPID_PUBLIC_KEY` должны быть одинаковыми — один ключ, две переменные.

---

## Первый деплой (чистый VPS)

### 1. Подготовка VPS

```bash
ssh root@<адрес сервера>

# Docker
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

# Папка приложения
mkdir -p /opt/hexseal/app
```

### 2. Файлы на VPS

Скопировать на VPS:

```bash
# С локальной машины:
scp docker-compose.yml root@<адрес сервера>:/opt/hexseal/app/
scp -r cloudflared root@<адрес сервера>:/opt/hexseal/app/
```

### 3. Создать `.env.vps` на VPS

```bash
ssh root@<адрес сервера>
nano /opt/hexseal/app/.env.vps
# Заполнить по шаблону выше
```

### 4. Первый деплой с локальной машины

```bash
# Frontend
bash deploy-local.sh

# Frontend + relayer
bash deploy-local.sh --all
```

Скрипт:
1. Тянет `.env.vps` с VPS по SCP
2. Собирает Docker образ локально (с `NEXT_PUBLIC_*` переменными в `--build-arg`)
3. Пайпит образ на VPS по SSH (`docker save | ssh | docker load`)
4. Запускает `docker compose up -d --force-recreate`

> **Требования:** Docker запущен локально, SSH доступ к VPS без пароля (через ключ).
>
> Ошибка `permission denied /var/run/docker.sock`:
> ```bash
> sudo usermod -aG docker $USER && newgrp docker
> ```

---

## Обновление кода

### Только фронт (обычный деплой)

```bash
bash deploy-local.sh
```

### Фронт + релеер

```bash
bash deploy-local.sh --all
```

> Релеер деплоить нужно только если менялся код в `relayer/`. Большинство изменений — только фронт.

---

## Мониторинг

```bash
ssh root@<адрес сервера>
cd /opt/hexseal/app

# Статус контейнеров
docker compose ps

# Логи в реальном времени
docker compose logs -f frontend
docker compose logs -f relayer
docker compose logs -f cloudflared

# Проверка что релеер живёт
curl https://api.hexseal.net/health

# Место под файлы
docker exec $(docker compose ps -q relayer) du -sh /app/storage/files/ /app/storage/public/
```

---

## Частые проблемы

**Файлы не загружаются (413)**
→ В nginx нет nginx — Cloudflare Tunnel не ограничивает upload. Проверь лимит в коде релеера.

**Пуши не работают**
→ `VAPID_PUBLIC_KEY` и `NEXT_PUBLIC_VAPID_PUBLIC_KEY` в `.env.vps` должны совпадать.
→ После смены VAPID ключей — все пользователи должны переподписаться (старые подписки протухнут).

**XMTP бот не отвечает / шифрование файлов сломано**
→ `SERVER_SECRET` изменился — ключ бот-кошелька перегенерировался. Новые сделки с новым ботом работают; старые группы с ботом придётся пересоздать. Не менять `SERVER_SECRET` без необходимости.

**WalletConnect не подключается**
→ [cloud.walletconnect.com](https://cloud.walletconnect.com) → добавить `hexseal.net` в Allowed Domains.

**CORS ошибки с релеером**
→ В `.env.vps` проверь `ALLOWED_ORIGINS=https://hexseal.net,https://www.hexseal.net`.

**Нет газа — релеер не может отправлять транзакции**
→ Пополни кошелёк `RELAYER_PRIVATE_KEY` нативным ETH на Base Sepolia.
→ Адрес: `cast wallet address --private-key $RELAYER_PRIVATE_KEY`

**Контейнер не поднимается после деплоя**
```bash
docker compose logs relayer --tail=50
docker compose logs frontend --tail=50
```
