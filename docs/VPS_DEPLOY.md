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
| VPS | 1984 `IP_VPS` |
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
NEXT_PUBLIC_DIAMOND_ADDRESS=0x760F07367888C62f7c2Dfb619A5e534132855ce5
NEXT_PUBLIC_FORWARDER_ADDRESS=0x268dCfa7ab0DC134d01C5cBcAa7d2834d6dD0f0f
NEXT_PUBLIC_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
NEXT_PUBLIC_JOB_RECEIPT_ADDRESS=0x...   # адрес JobReceiptFacet если нужен на фронте
DIAMOND_ADDRESS=0x760F07367888C62f7c2Dfb619A5e534132855ce5
NEXT_PUBLIC_CHAIN_ID=84532

# ── Subgraph ───────────────────────────────────────────────────────────────────
SUBGRAPH_URL=https://api.studio.thegraph.com/query/***/hexseal/latest

# ── Релеер ────────────────────────────────────────────────────────────────────
RELAYER_PRIVATE_KEY=0xВАШ_КЛЮЧ_РЕЛЕЕРА
NEXT_PUBLIC_RELAYER_URL=https://api.hexseal.net

# Секрет релеера — сгенерировать 1 раз и больше не трогать:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# На нём держатся три вещи: подпись (HMAC) пропуска к складу мешков,
# подпись пропуска к журналу спора и ключ шифрования самих журналов споров.
# Переписку он НЕ шифрует — она запечатана ключами людей на их устройствах.
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
ssh root@IP_VPS

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
scp docker-compose.yml root@IP_VPS:/opt/hexseal/app/
scp -r cloudflared root@IP_VPS:/opt/hexseal/app/
```

### 3. Создать `.env.vps` на VPS

```bash
ssh root@IP_VPS
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
ssh root@IP_VPS
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

## Апгрейд VPS (больше памяти / ядер)

**Прямо сейчас апгрейд безопасен и стоит ноль** — пользователей нет, переписки нет,
терять нечего. Порядок ниже нужен, когда появятся живые разговоры.

### Что вообще может пострадать

Ценное на машине ровно одно — **том `relayer_storage`**. В нём мешки переписки,
опись — **два файла, `bag-meta.json` (снимок) и `bag-meta.log` (журнал
дозаписи)**, — вложения и подписки на уведомления.

> ⚠️ **Опись — это ДВА файла, и они бессмысленны по отдельности** (аудит
> устойчивости, 7 августа 2026). Снимок переписывается только при схлопывании —
> раз в сутки ночной уборкой и при переполнении журнала; всё, что пришло после
> последнего схлопывания, живёт ТОЛЬКО в журнале. Отсюда три правила:
>
> * **Резервная копия обязана брать оба файла одним снимком.** Скопировать один
>   `bag-meta.json` — значит потерять всё с последней ночи.
> * **У свежего сервера снимка нет вовсе**, пока не отработает первая ночная
>   уборка. Это нормально, а не признак поломки.
> * **«Начать с чистого листа» — это снести ТРИ вещи вместе:** снимок, журнал и
>   сами файлы мешков (`bags/`). Снести часть — оставить склад, который врёт про
>   себя: забытый журнал доиграется поверх любого снимка, включая пустой. Ровно
>   об этом говорит строка режима недоверия в логе релеера. Всё остальное
пересобирается из репозитория одной командой.

**Смена IP-адреса машины нам безразлична.** Туннель Cloudflare соединяется изнутри
наружу, поэтому адрес VPS никого не волнует — ни DNS, ни фронт трогать не надо.

**Настоящая опасность одна: две копии релеера одновременно.** Два процесса на одном
хранилище **теряют записи описи** — воспроизведено, записано пунктом 28.3 в
`docs/OPEN-ITEMS.md`. Если хостер делает перенос по схеме «скопировали, потом
переключили», может возникнуть окно, где работают обе. Поэтому релеер на время
апгрейда **выключается**, а не оставляется «пусть работает».

### Порядок

```bash
# 1. Остановить релеер (фронт может жить, он безсостоятельный)
ssh root@<vps> "cd /opt/hexseal/app && docker compose stop relayer"

# 2. Забрать хранилище к себе. Это ТОМ DOCKER, а не папка на хосте —
#    копировать путь бесполезно, получишь пустоту.
ssh root@<vps> "docker run --rm -v relayer_storage:/s -v /tmp:/out alpine \
  tar czf /out/relayer-storage-\$(date +%F).tgz -C /s ."
scp root@<vps>:/tmp/relayer-storage-*.tgz ./

# 3. Проверить, что копия не пустая — ДО апгрейда, а не после
tar tzf relayer-storage-*.tgz | head
tar tzf relayer-storage-*.tgz | grep -c . 
```

Дальше — апгрейд у хостера. Точный порядок у 1984 смотреть в их документации:
бывает «добавили памяти на том же железе» (перезагрузка, диск на месте) и бывает
«перенесли на другое железо» (диск обычно едет следом, но не всегда).

```bash
# 4. Поднять и убедиться, что опись цела
ssh root@<vps> "cd /opt/hexseal/app && docker compose up -d relayer"
ssh root@<vps> "docker compose logs relayer | tail -20"
```

### Что смотреть в логах после подъёма

Релеер сам скажет, если с описью беда — это сделано намеренно:

- `[bags] _loadBagMeta: FAILED TO LOAD INDEX` — опись не прочиталась. Релеер входит
  в **режим недоверия**: восстанавливает список по файлам на диске, **ничего не
  удаляет и ничего не пишет**, пока человек не разберётся. Это защита, не поломка.
- `[bags] cleanup: removed N, kept M` — обычная ночная строка, значит всё в порядке.
- Строка про несоответствие между описью и складом — значит копия приехала не
  целиком, разворачивай резервную.

**Если опись потеряна, а мешки на месте** — не создавай пустую опись руками.
Она читается как «склад пуст», и ночная чистка снесёт настоящие мешки. Либо
верни настоящий файл из копии, либо убирай **и опись, и мешки** вместе.

---

## Частые проблемы

**Файлы не загружаются (413)**
→ В nginx нет nginx — Cloudflare Tunnel не ограничивает upload. Проверь лимит в коде релеера.

**Пуши не работают**
→ `VAPID_PUBLIC_KEY` и `NEXT_PUBLIC_VAPID_PUBLIC_KEY` в `.env.vps` должны совпадать.
→ После смены VAPID ключей — все пользователи должны переподписаться (старые подписки протухнут).

**Чат просит подписать заново у всех разом / старые журналы споров не читаются**
→ Сменился `SERVER_SECRET`. Последствия разные по тяжести, и вторая необратима:
→ **Обратимо.** Все выданные пропуска к складу мешков и к журналу спора перестают
  сходиться по HMAC, релеер отвечает `401`. Люди подписывают вызов заново, и всё
  работает дальше. Сама переписка цела: мешки запечатаны ключами людей, сервер к
  ним отношения не имеет.
→ **Необратимо.** Журналы споров зашифрованы ключом, выведенным из этого секрета
  (`deriveLogKey`). Со сменой секрета всё, что записано прежним, не расшифруется
  уже никогда.
→ Поэтому: сгенерировать один раз при заведении сервера и не менять.

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
