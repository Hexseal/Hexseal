# Hexseal — Деплой на VPS

> Два сервера. Один — фронт. Второй — релеер + хранилище файлов.

---

## Решение и почему

**Принятая схема: Vercel (фронт) + 1 Hetzner VPS (релеер)**

```
Vercel           →  hexseal.app          ~$20/мес
<провайдер и размер машины>     →  relay.hexseal.app    ~$5/мес
```

**Почему не два VPS (хотя дешевле на $10-15):**
Релеер требует VPS в любом случае — постоянный диск, долгоживущий процесс. Это не меняется.
Фронт на VPS — это nginx, systemd, сертификаты, обновления. Что-то раз в месяц отваливается, нужно SSH.
Vercel за $20 покупает полное отсутствие ops на фронте: `git push` → задеплоилось, больше ничего.

**Почему не масштабировать позже по-другому:**
Когда появятся новые проекты — на том же одном Hetzner VPS запускаются дополнительные релееры на разных портах. Цена не растёт.

**Правило:** не трогать эту схему пока месячный оборот не оправдает выделенные серверы.

---

## Карта инфраструктуры

```
Браузер
  │
  ├── hexseal.app  ──►  VPS 1: Frontend (Next.js)
  │                          next start :3000
  │                          nginx → :3000
  │
  └── relay.hexseal.app ──►  VPS 2: Relayer (Node.js)
                                 node index.js :3001
                                 nginx → :3001
                                 /var/lib/hexseal/storage/
                                     files/   ← зашифрованные чат-файлы, TTL 7 дней
                                     public/  ← аватары, профили (постоянно)
                                     temp/    ← мультипарт чанки (авто-очистка 24ч)
```

---

## VPS 2 — Relayer

### 1. Требования

```
Ubuntu 22.04+
Node.js 20+   (curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install nodejs)
nginx
```

### 2. Загрузить код

```bash
git clone https://github.com/hexseal/hexseal.git /opt/hexseal
cd /opt/hexseal/relayer
npm install
```

### 3. Создать папки для хранилища

```bash
mkdir -p /var/lib/hexseal/storage/{files,public,temp}
chown -R www-data:www-data /var/lib/hexseal/storage   # или от имени пользователя который запускает node
```

### 4. Создать `.env.relayer`

```bash
nano /opt/hexseal/relayer/.env.relayer
```

```env
# ── Сеть ──────────────────────────────────────────────────────────────────────
RPC_URL=https://lb.drpc.live/base-sepolia/ВАШ_КЛЮЧ
# или публичный (медленнее):
# RPC_URL=https://base-sepolia.drpc.org

# ── Контракты ─────────────────────────────────────────────────────────────────
DIAMOND_ADDRESS=0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557
TRUSTED_FORWARDER=0x41c66b80B1445F48AF3863763BC0EC0549413CD7

# ── Релеер ────────────────────────────────────────────────────────────────────
RELAYER_PRIVATE_KEY=0xВАШ_ПРИВАТНЫЙ_КЛЮЧ_РЕЛЕЕРА
PORT=3001

# ── Публичный URL этого сервера (без слэша в конце) ───────────────────────────
RELAYER_PUBLIC_URL=https://relay.hexseal.app

# ── Хранилище (локальный диск) ────────────────────────────────────────────────
STORAGE_DIR=/var/lib/hexseal/storage

# ── CORS: через запятую все домены фронтенда ──────────────────────────────────
ALLOWED_ORIGINS=https://hexseal.app,https://www.hexseal.app

# ── Web Push / VAPID ──────────────────────────────────────────────────────────
# Сгенерировать один раз:
#   node -e "const wp=require('web-push'); const k=wp.generateVAPIDKeys(); console.log('PUBLIC='+k.publicKey+'\nPRIVATE='+k.privateKey)"
VAPID_PUBLIC_KEY=СГЕНЕРИРОВАННЫЙ_PUBLIC_KEY
VAPID_PRIVATE_KEY=СГЕНЕРИРОВАННЫЙ_PRIVATE_KEY
VAPID_EMAIL=mailto:admin@hexseal.app
```

> **ВАЖНО:** `VAPID_PUBLIC_KEY` отсюда нужно скопировать в `NEXT_PUBLIC_VAPID_PUBLIC_KEY` на фронте — они должны совпадать.

### 5. Systemd — автозапуск релеера

```bash
nano /etc/systemd/system/hexseal-relayer.service
```

```ini
[Unit]
Description=Hexseal Relayer
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/hexseal/relayer
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/hexseal/relayer/.env.relayer

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable hexseal-relayer
systemctl start hexseal-relayer
systemctl status hexseal-relayer
```

### 6. Nginx для релеера

```bash
nano /etc/nginx/sites-available/relay.hexseal.app
```

```nginx
server {
    listen 80;
    server_name relay.hexseal.app;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name relay.hexseal.app;

    ssl_certificate     /etc/letsencrypt/live/relay.hexseal.app/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.hexseal.app/privkey.pem;

    # Лимит на загрузку файлов — 5 ГБ (совпадает с лимитом релеера)
    client_max_body_size 5120M;

    # Таймаут для больших файлов
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Нужно для потоковой загрузки (без буферизации nginx)
        proxy_request_buffering off;
        proxy_buffering off;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/relay.hexseal.app /etc/nginx/sites-enabled/
certbot --nginx -d relay.hexseal.app
nginx -t && systemctl reload nginx
```

---

## VPS 1 — Frontend (Next.js)

### 1. Требования

```
Ubuntu 22.04+
Node.js 20+
nginx
```

### 2. Загрузить код

```bash
git clone https://github.com/hexseal/hexseal.git /opt/hexseal
cd /opt/hexseal/frontend
npm install
```

### 3. Создать `.env.local`

```bash
nano /opt/hexseal/frontend/.env.local
```

```env
# ── Chain ─────────────────────────────────────────────────────────────────────
NEXT_PUBLIC_CHAIN_ID=84532

# ── Контракты ─────────────────────────────────────────────────────────────────
NEXT_PUBLIC_DIAMOND_ADDRESS=0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557
NEXT_PUBLIC_FORWARDER_ADDRESS=0x41c66b80B1445F48AF3863763BC0EC0549413CD7
NEXT_PUBLIC_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
NEXT_PUBLIC_OFFER_NFT_ADDRESS=0xE3256e6aE7fdC66745A8de13840322f615fbec1D
DIAMOND_ADDRESS=0x7A91d700CF2a201E99F0aD3C3b4f4D79CFE69557

# ── RPC ───────────────────────────────────────────────────────────────────────
RPC_URL=https://lb.drpc.live/base-sepolia/ВАШ_КЛЮЧ
NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL=https://base-sepolia.drpc.org

# ── WalletConnect ─────────────────────────────────────────────────────────────
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=ВАШ_WC_PROJECT_ID

# ── IPFS (Lighthouse) ─────────────────────────────────────────────────────────
LIGHTHOUSE_API_KEY=ВАШ_LIGHTHOUSE_KEY
NEXT_PUBLIC_IPFS_GATEWAY=https://gateway.lighthouse.storage

# ── Релеер ────────────────────────────────────────────────────────────────────
# URL второго VPS
NEXT_PUBLIC_RELAYER_URL=https://relay.hexseal.app

# Ключ релеера нужен фронту для подписи мета-транзакций через /api/relay
RELAY_PRIVATE_KEY=0xТОТ_ЖЕ_КЛЮЧ_ЧТО_НА_РЕЛЕЕРЕ

# ── Web Push / VAPID ──────────────────────────────────────────────────────────
# ДОЛЖНЫ СОВПАДАТЬ с теми что на релеере!
NEXT_PUBLIC_VAPID_PUBLIC_KEY=ТОТ_ЖЕ_VAPID_PUBLIC_KEY_ЧТО_НА_РЕЛЕЕРЕ
VAPID_PUBLIC_KEY=ТОТ_ЖЕ_VAPID_PUBLIC_KEY_ЧТО_НА_РЕЛЕЕРЕ
VAPID_PRIVATE_KEY=ТОТ_ЖЕ_VAPID_PRIVATE_KEY_ЧТО_НА_РЕЛЕЕРЕ
VAPID_EMAIL=mailto:admin@hexseal.app

# ── Redis (Upstash) ───────────────────────────────────────────────────────────
UPSTASH_REDIS_REST_URL=https://ВАШ.upstash.io
UPSTASH_REDIS_REST_TOKEN=ВАШ_ТОКЕН
```

### 4. Сборка

```bash
cd /opt/hexseal/frontend
npm run build
```

### 5. Systemd — автозапуск фронта

```bash
nano /etc/systemd/system/hexseal-frontend.service
```

```ini
[Unit]
Description=Hexseal Frontend
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/hexseal/frontend
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -p 3000
Restart=always
RestartSec=5
EnvironmentFile=/opt/hexseal/frontend/.env.local

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable hexseal-frontend
systemctl start hexseal-frontend
systemctl status hexseal-frontend
```

### 6. Nginx для фронта

```bash
nano /etc/nginx/sites-available/hexseal.app
```

```nginx
server {
    listen 80;
    server_name hexseal.app www.hexseal.app;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name hexseal.app www.hexseal.app;

    ssl_certificate     /etc/letsencrypt/live/hexseal.app/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hexseal.app/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/hexseal.app /etc/nginx/sites-enabled/
certbot --nginx -d hexseal.app -d www.hexseal.app
nginx -t && systemctl reload nginx
```

---

## Обновление кода (деплой новой версии)

### Релеер (VPS 2)

```bash
cd /opt/hexseal
git pull
cd relayer
npm install
systemctl restart hexseal-relayer
```

### Фронт (VPS 1)

```bash
cd /opt/hexseal
git pull
cd frontend
npm install
npm run build
systemctl restart hexseal-frontend
```

---

## Проверка

```bash
# Релеер жив?
curl https://relay.hexseal.app/health

# Логи релеера
journalctl -u hexseal-relayer -f

# Логи фронта
journalctl -u hexseal-frontend -f

# Занятое место под файлы
du -sh /var/lib/hexseal/storage/files/
du -sh /var/lib/hexseal/storage/public/
```

---

## Ключи и секреты — где что живёт

| Что | Где хранится | Примечание |
|---|---|---|
| `RELAYER_PRIVATE_KEY` | `.env.relayer` на VPS 2 | Кошелёк оплачивает газ |
| `RELAY_PRIVATE_KEY` | `.env.local` на VPS 1 | Тот же ключ — нужен фронту для подписи |
| `VAPID_PUBLIC_KEY` | Оба VPS + `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Должен быть одинаковым везде |
| `VAPID_PRIVATE_KEY` | Оба VPS | Должен быть одинаковым везде |
| `LIGHTHOUSE_API_KEY` | VPS 1 только | Для загрузки профилей в IPFS |
| `WC_PROJECT_ID` | VPS 1 только | WalletConnect dashboard — добавить домен |

---

## Частые проблемы

**Файлы не загружаются / 413 ошибка**
→ Проверь `client_max_body_size` в nginx релеера. Должно быть `5120M`.

**VAPID ошибки / пуши не работают**
→ `VAPID_PUBLIC_KEY` и `VAPID_PRIVATE_KEY` должны совпадать на обоих серверах. Если перегенерировал на одном — меняй на обоих.

**WalletConnect не подключается**
→ Зайди в [cloud.walletconnect.com](https://cloud.walletconnect.com), добавь домен `hexseal.app` в allowlist.

**CORS ошибки с релеером**
→ В `.env.relayer` добавь домен в `ALLOWED_ORIGINS=https://hexseal.app,https://www.hexseal.app`

**Релеер упал — нет газа на кошельке**
→ Пополни `RELAYER_PRIVATE_KEY` адрес нативным ETH на Base (не USDC, именно ETH для газа).
