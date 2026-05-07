#!/usr/bin/env node
// scripts/generate-docs.js
// Auto-generates docs/generated/** from Foundry artifacts + Solidity sources.
// Run: node scripts/generate-docs.js

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..');
const OUT_DIR  = path.join(ROOT, 'out');
const SRC_DIR  = path.join(ROOT, 'src');
const DOCS_DIR = path.join(ROOT, 'docs', 'generated');

// ─── Module registry ─────────────────────────────────────────────────────────

const MODULES = [
  {
    name: 'DiamondProxy',
    src:  'src/DiamondProxy.sol',
    artifact: 'out/DiamondProxy.sol/DiamondProxy.json',
    desc: 'Главный прокси-контракт. Содержит DiamondCut, DiamondLoupe и OwnershipFacet. Все вызовы проксируются через fallback к соответствующим фасетам.',
    tags: ['core', 'upgradeable'],
  },
  {
    name: 'FactoryFacet',
    src:  'src/FactoryFacet.sol',
    artifact: 'out/FactoryFacet.sol/FactoryFacet.json',
    desc: 'Фабрика Agreement-контрактов. Хранит fee-конфигурацию, USDC-адрес, trustedForwarder. Деплоит новые эскроу-сделки.',
    tags: ['factory', 'fees', 'admin'],
  },
  {
    name: 'RegistryFacet',
    src:  'src/RegistryFacet.sol',
    artifact: 'out/RegistryFacet.sol/RegistryFacet.json',
    desc: 'Реестр всех Agreement-контрактов. Индексирует сделки по участникам, хранит их текущий статус.',
    tags: ['registry', 'indexing'],
  },
  {
    name: 'ArbiterRegistryFacet',
    src:  'src/facets/ArbiterRegistryFacet.sol',
    artifact: 'out/ArbiterRegistryFacet.sol/ArbiterRegistryFacet.json',
    desc: 'Реестр арбитров. Commit-reveal клейм споров, история решений, управление chief arbiter.',
    tags: ['arbitration', 'admin', 'gasless'],
  },
  {
    name: 'JobBoardFacet',
    src:  'src/facets/JobBoardFacet.sol',
    artifact: 'out/JobBoardFacet.sol/JobBoardFacet.json',
    desc: 'Доска заказов: клиент постит задание с бюджетом, исполнители подают заявки.',
    tags: ['marketplace', 'jobs'],
  },
  {
    name: 'ServiceBoardFacet',
    src:  'src/facets/ServiceBoardFacet.sol',
    artifact: 'out/ServiceBoardFacet.sol/ServiceBoardFacet.json',
    desc: 'Доска услуг: исполнитель постит услугу, клиенты запрашивают её выполнение.',
    tags: ['marketplace', 'services'],
  },
  {
    name: 'OfferNFTFacet',
    src:  'src/OfferNFTFacet.sol',
    artifact: 'out/OfferNFTFacet.sol/OfferNFTFacet.json',
    desc: 'NFT-офферы исполнителей. ERC-1155, ограниченный supply, минт за USDC.',
    tags: ['nft', 'marketplace'],
  },
  {
    name: 'JobReceiptFacet',
    src:  'src/JobReceiptFacet.sol',
    artifact: 'out/JobReceiptFacet.sol/JobReceiptFacet.json',
    desc: 'Soulbound NFT-квитанции за выполненные работы. Минтятся автоматически при закрытии сделки.',
    tags: ['nft', 'reputation'],
  },
  {
    name: 'Agreement',
    src:  'src/Agreement.sol',
    artifact: 'out/Agreement.sol/Agreement.json',
    desc: 'Эскроу-контракт между клиентом и исполнителем. ERC-2771 gasless, USDC permit, reentrancy guard, автоапрув по таймауту.',
    tags: ['escrow', 'core', 'gasless'],
  },
  {
    name: 'MinimalForwarder',
    src:  'src/MinimalForwarder.sol',
    artifact: 'out/MinimalForwarder.sol/MinimalForwarder.json',
    desc: 'EIP-712 форвардер для мета-транзакций (ERC-2771). Принимает подписанные запросы и вызывает целевой контракт.',
    tags: ['gasless', 'relay'],
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function readSrc(relPath) {
  try { return fs.readFileSync(path.join(ROOT, relPath), 'utf8'); }
  catch { return ''; }
}

function ensure(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function write(filePath, content) {
  ensure(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`  ✓ ${path.relative(ROOT, filePath)}`);
}

// ─── Solidity source parser ───────────────────────────────────────────────────

function parseSource(src) {
  const lines  = src.split('\n');
  const result = { fileComment: '', functions: [], events: [], errors: [], modifiers: [] };

  // File-level comment (first `//` block or `/* */`)
  const fileCommentLines = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) {
      fileCommentLines.push(t.replace(/^\/\/\/?|^\*+\/?|^\/\*/g, '').trim());
    } else if (fileCommentLines.length > 0) {
      break;
    }
  }
  result.fileComment = fileCommentLines.filter(Boolean).join(' ').slice(0, 300);

  // Extract functions with preceding natspec
  const natspecRe = /(?:(?:\/\/\/[^\n]*\n)+|\/\*\*[\s\S]*?\*\/)\s*\n?\s*(function\s+\w+[^{;]*[{;])/g;
  const fnOnlyRe  = /(?<!\bif\b|\bfor\b|\bwhile\b)\b(function\s+(\w+)\s*\(([^)]*)\)[^{;]*)(external|public|internal|private)?([^{;]*)[{;]/g;

  let m;
  // First pass: collect natspec → function
  const natspecMap = {};
  const nsRe = /((?:\/\/\/[^\n]*\n)+)\s*\n?\s*function\s+(\w+)/g;
  while ((m = nsRe.exec(src)) !== null) {
    const lines = m[1].split('\n').map(l => l.replace(/^\s*\/\/\/\s?/, '').trim()).filter(Boolean);
    natspecMap[m[2]] = lines.join(' ');
  }

  // Second pass: all function declarations
  const fnRe = /\bfunction\s+(\w+)\s*\(([^)]*)\)([^{;]*?)(external|public|internal|private)\b([^{;]*)[{;]/g;
  while ((m = fnRe.exec(src)) !== null) {
    const name        = m[1];
    const rawParams   = m[2];
    const modBefore   = m[3] + m[5];
    const visibility  = m[4];

    if (visibility === 'internal' || visibility === 'private') continue;

    const params = rawParams.split(',').map(p => p.trim()).filter(Boolean).map(p => {
      const parts = p.trim().split(/\s+/);
      return { type: parts[0], name: parts[parts.length - 1] };
    });

    const isMut = /nonpayable|payable/.test(modBefore) || !/view|pure/.test(modBefore);
    const mutability = /pure/.test(modBefore) ? 'pure'
      : /view/.test(modBefore) ? 'view'
      : /payable/.test(modBefore + m[3] + m[5]) ? 'payable'
      : 'nonpayable';

    const accessControl = [];
    if (/onlyOwner/.test(modBefore + src.slice(m.index - 50, m.index + 200))) accessControl.push('onlyOwner');
    if (/onlyOwnerOrChief/.test(modBefore + src.slice(m.index - 50, m.index + 200))) accessControl.push('onlyOwnerOrChief');
    if (/onlyRegistered/.test(modBefore + src.slice(m.index - 50, m.index + 200))) accessControl.push('onlyRegistered');

    // Returns
    const retMatch = /returns\s*\(([^)]+)\)/.exec(modBefore + src.slice(m.index, m.index + 300));
    const returns = retMatch ? retMatch[1].trim() : '';

    result.functions.push({ name, params, mutability, visibility, accessControl, returns, natspec: natspecMap[name] || '' });
  }

  // Events
  const evRe = /event\s+(\w+)\s*\(([^)]*)\)/g;
  while ((m = evRe.exec(src)) !== null) {
    const params = m[2].split(',').map(p => {
      const parts = p.trim().split(/\s+/);
      return parts.join(' ');
    }).filter(Boolean);
    result.events.push({ name: m[1], params });
  }

  // Custom errors
  const errRe = /error\s+(\w+)\s*\(([^)]*)\)/g;
  while ((m = errRe.exec(src)) !== null) {
    result.errors.push({ name: m[1], params: m[2].trim() });
  }

  // Modifiers
  const modRe = /modifier\s+(\w+)\s*\(/g;
  while ((m = modRe.exec(src)) !== null) {
    result.modifiers.push(m[1]);
  }

  return result;
}

// ─── ABI loader ───────────────────────────────────────────────────────────────

function loadAbi(artifactPath) {
  const artifact = readJson(path.join(ROOT, artifactPath));
  if (!artifact) return [];
  return (artifact.abi || []).filter(e => e.type === 'function' || e.type === 'event' || e.type === 'error');
}

// ─── Contract doc generator ──────────────────────────────────────────────────

function generateContractDoc(mod) {
  const src    = readSrc(mod.src);
  const parsed = parseSource(src);
  const abi    = loadAbi(mod.artifact);

  const abiFnMap = {};
  for (const entry of abi) {
    if (entry.type === 'function') abiFnMap[entry.name] = entry;
  }

  const fns    = parsed.functions.filter(f => f.visibility !== 'internal');
  const views  = fns.filter(f => f.mutability === 'view' || f.mutability === 'pure');
  const writes = fns.filter(f => f.mutability !== 'view' && f.mutability !== 'pure');

  const lines = [];
  const h = (n, t) => lines.push(`${'#'.repeat(n)} ${t}`);
  const nl = () => lines.push('');
  const p  = t => lines.push(t);
  const code = (t) => lines.push('```' + t + '```');

  h(1, `${mod.name}`);
  p(`> **Файл:** \`${mod.src}\``);
  p(`> **Теги:** ${mod.tags.map(t => `\`${t}\``).join(' ')}`);
  nl();
  p(mod.desc);
  nl();

  if (parsed.modifiers.length) {
    h(2, 'Модификаторы доступа');
    for (const mod_ of parsed.modifiers) {
      p(`- \`${mod_}\``);
    }
    nl();
  }

  if (parsed.events.length) {
    h(2, 'Events');
    p('| Event | Параметры |');
    p('|-------|-----------|');
    for (const ev of parsed.events) {
      p(`| \`${ev.name}\` | ${ev.params.join(', ') || '—'} |`);
    }
    nl();
  }

  if (parsed.errors.length) {
    h(2, 'Custom Errors');
    p('| Error | Когда |');
    p('|-------|-------|');
    for (const er of parsed.errors) {
      p(`| \`${er.name}\` | ${er.params || '—'} |`);
    }
    nl();
  }

  if (writes.length) {
    h(2, 'Write Functions');
    nl();
    for (const fn of writes) {
      const abiEntry = abiFnMap[fn.name];
      const inputs   = abiEntry?.inputs || fn.params;

      h(3, `\`${fn.name}\``);
      if (fn.natspec) p(`> ${fn.natspec}`);
      nl();

      p(`**Mutability:** \`${fn.mutability}\`  `);
      if (fn.accessControl.length) p(`**Access:** ${fn.accessControl.map(a => `\`${a}\``).join(', ')}`);
      nl();

      if (inputs.length) {
        p('**Parameters:**');
        p('| Параметр | Тип | Описание |');
        p('|----------|-----|----------|');
        for (const inp of inputs) {
          const name = inp.name || inp.type;
          const type = inp.internalType || inp.type;
          p(`| \`${name}\` | \`${type}\` | — |`);
        }
        nl();
      }

      if (fn.returns) {
        p(`**Returns:** \`${fn.returns}\``);
        nl();
      }

      // Related errors (simple: all errors that might apply)
      const relatedErrors = parsed.errors.filter(e =>
        src.indexOf(`revert ${e.name}`) > -1 &&
        src.indexOf(fn.name) > -1
      );
      if (relatedErrors.length) {
        p(`**Reverts:** ${relatedErrors.map(e => `\`${e.name}\``).join(', ')}`);
        nl();
      }

      p('---');
      nl();
    }
  }

  if (views.length) {
    h(2, 'View / Pure Functions');
    nl();
    p('| Функция | Возвращает | Описание |');
    p('|---------|-----------|----------|');
    for (const fn of views) {
      const abiEntry = abiFnMap[fn.name];
      const outputs  = abiEntry?.outputs || [];
      const ret = fn.returns || outputs.map(o => o.internalType || o.type).join(', ') || '—';
      p(`| \`${fn.name}(${fn.params.map(p => p.type).join(', ')})\` | \`${ret}\` | ${fn.natspec || '—'} |`);
    }
    nl();
  }

  return lines.join('\n');
}

// ─── Test plan generator ──────────────────────────────────────────────────────

function generateTestPlan(mod) {
  const src    = readSrc(mod.src);
  const parsed = parseSource(src);
  const fns    = parsed.functions.filter(f => f.visibility !== 'internal');
  const views  = fns.filter(f => f.mutability === 'view' || f.mutability === 'pure');
  const writes = fns.filter(f => f.mutability !== 'view' && f.mutability !== 'pure');

  const lines = [];
  const h  = (n, t) => lines.push(`${'#'.repeat(n)} ${t}`);
  const nl = () => lines.push('');
  const p  = t  => lines.push(t);
  const cb = t  => lines.push(`- [ ] ${t}`);

  h(1, `Test Plan: ${mod.name}`);
  p(`> Источник: \`${mod.src}\``);
  p(`> Сгенерировано: ${new Date().toISOString().slice(0, 10)}`);
  nl();
  p(mod.desc);
  nl();

  h(2, 'Окружение');
  p('| Параметр | Значение |');
  p('|----------|----------|');
  p('| Сеть | Base Sepolia (chainId 84532) |');
  p('| Diamond | `0xF00CC71878c226E0b64253Fb71dD802aF12165D0` |');
  p('| Тестовый USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |');
  p('| Кошелёк тестера | — |');
  p('| Дата теста | — |');
  nl();

  // Write function tests
  if (writes.length) {
    h(2, '✏️ Write Functions');
    nl();
    for (const fn of writes) {
      h(3, fn.name);
      if (fn.natspec) p(`> ${fn.natspec}`);
      nl();

      p('**Happy path:**');
      cb(`Вызвать \`${fn.name}()\` с валидными параметрами — транзакция принята`);
      if (fn.returns) cb(`Вернулся ожидаемый результат: \`${fn.returns}\``);

      // Event checks
      const fnSrc = src.slice(Math.max(0, src.indexOf(`function ${fn.name}`)), src.indexOf(`function ${fn.name}`) + 1000);
      const emittedEvents = parsed.events.filter(ev => fnSrc.includes(`emit ${ev.name}`));
      for (const ev of emittedEvents) {
        cb(`Event \`${ev.name}\` эмитирован с правильными аргументами`);
      }
      nl();

      p('**Access control:**');
      if (fn.accessControl.includes('onlyOwner')) {
        cb('Вызов от чужого адреса → revert `NotOwner` / `OwnableUnauthorizedAccount`');
        cb('Вызов от owner → успех');
      } else if (fn.accessControl.includes('onlyOwnerOrChief')) {
        cb('Вызов от постороннего → revert `NotOwnerOrChief`');
        cb('Вызов от owner → успех');
        cb('Вызов от chiefArbiter → успех');
      } else {
        cb('Функция публичная — проверить что работает с любого адреса');
      }
      nl();

      p('**Edge cases:**');
      cb('Повторный вызов (идемпотентность / защита от дублей)');
      if (fn.params.some(p => p.type?.includes('address'))) {
        cb('Передать нулевой адрес (0x000…) → ожидаемый revert или silent ignore');
      }
      if (fn.params.some(p => p.type?.includes('uint'))) {
        cb('Передать 0 → ожидаемый revert или корректная обработка');
        cb('Передать type(uint256).max → проверить на overflow');
      }
      nl();

      // Custom error checks
      const relatedErrors = parsed.errors.filter(e => src.includes(`revert ${e.name}`));
      if (relatedErrors.length) {
        p('**Revert cases:**');
        for (const er of relatedErrors) {
          cb(`Спровоцировать условие → revert \`${er.name}\``);
        }
        nl();
      }

      p('---');
      nl();
    }
  }

  // View function tests
  if (views.length) {
    h(2, '👁️ View Functions');
    nl();
    for (const fn of views) {
      h(3, fn.name);
      if (fn.natspec) p(`> ${fn.natspec}`);
      nl();
      cb(`Вызвать \`${fn.name}()\` — возвращает данные без revert`);
      cb(`Результат соответствует on-chain состоянию (проверить через explorer или cast call)`);
      if (fn.returns?.includes('[]')) {
        cb(`Проверить поведение с пустым массивом (до первой записи)`);
      }
      nl();
    }
  }

  // Events
  if (parsed.events.length) {
    h(2, '📡 Events');
    nl();
    for (const ev of parsed.events) {
      h(3, ev.name);
      cb(`Эмитируется при правильном условии`);
      cb(`Все параметры (${ev.params.join(', ')}) заполнены верно`);
      cb(`Indexed-параметры фильтруются корректно`);
      nl();
    }
  }

  h(2, '✅ Результат');
  p('| Функция | Статус | Тестер | Дата | Комментарий |');
  p('|---------|--------|--------|------|-------------|');
  for (const fn of fns) {
    p(`| \`${fn.name}\` | ⬜ | — | — | — |`);
  }
  nl();

  return lines.join('\n');
}

// ─── Bug report template ──────────────────────────────────────────────────────

function generateBugReportTemplate() {
  return `# Bug Report

> **Заполни все поля. Репорты без воспроизводимых шагов и логов не рассматриваются.**

---

## Метаданные

| Поле | Значение |
|------|----------|
| **Модуль** | (Agreement / JobBoard / ServiceBoard / Arbiter / Dashboard / Deal / Chat / Admin / …) |
| **Тип бага** | (UI / Контракт / Gasless-relay / Подключение кошелька / Регион/Fees / XMTP / IPFS / …) |
| **Серьёзность** | 🔴 Критический / 🟠 Высокий / 🟡 Средний / 🟢 Низкий |
| **Среда** | Base Sepolia / Mainnet |
| **Дата** | YYYY-MM-DD |
| **Репортёр** | — |

---

## Краткое описание

> Одна-две фразы. **Что именно не работает** (не "ничего не работает", а "кнопка Fund не отправляет транзакцию при balance < required").

_[Описание]_

---

## Точные шаги воспроизведения

> Должно быть воспроизводимо с нуля любым другим человеком.

1. Открыть [URL страницы]
2. Подключить кошелёк [адрес: 0x…]
3. Нажать [кнопка / поле / действие]
4. Ввести [значение]
5. …
6. Результат: [что произошло]

---

## Ожидаемое поведение

> Что **должно** было произойти согласно документации / логике продукта.

_[Ожидание]_

---

## Фактическое поведение

> Что **произошло** на самом деле.

_[Факт]_

---

## Воспроизводимость

- [ ] 10/10 — воспроизводится всегда
- [ ] ~5/10 — иногда
- [ ] 1/10 — редко / нестабильно

---

## Скриншот / Запись экрана

> Приложи скриншот UI с видимыми ошибками. Если проблема в транзакции — скриншот с toast/alert.

_[Ссылка или вложение]_

---

## Консоль браузера

> DevTools → Console. Скопировать **все красные строки** (errors), не только первую.

\`\`\`
[Вставить вывод console]
\`\`\`

---

## Network лог (если есть HTTP-запрос)

> DevTools → Network. Найти провальный запрос (/api/relay, /api/region, XMTP, IPFS и т.д.), скопировать:

**URL запроса:** \`\`

**Request body:**
\`\`\`json

\`\`\`

**Response (статус + тело):**
\`\`\`json

\`\`\`

---

## Данные транзакции (если проблема on-chain)

| Поле | Значение |
|------|----------|
| **Agreement адрес** | 0x… |
| **TX Hash** | 0x… |
| **Basescan ссылка** | https://sepolia.basescan.org/tx/0x… |
| **Revert reason** | (из etherscan Decoded Reason или cast run) |

---

## Состояние кошелька на момент бага

| Параметр | Значение |
|----------|----------|
| **Адрес** | 0x… |
| **USDC баланс** | — USDC |
| **ETH баланс** | — ETH |
| **VPN** | Да / Нет |
| **Wallet** | MetaMask / WalletConnect / Coinbase / другое |
| **Сеть в кошельке** | Base Sepolia / другая |

---

## Дополнительный контекст

> Что ещё может быть релевантно: была ли это первая попытка, что делал до этого, особые условия (мобильный, расширение, режим инкогнито, …).

_[Контекст]_

---

## Checklist перед отправкой

- [ ] Заполнены все обязательные поля выше
- [ ] Приложен скриншот или запись
- [ ] Вставлен вывод консоли (даже если пустой — написать "консоль чистая")
- [ ] Указан адрес кошелька и Agreement (если on-chain)
- [ ] Указан TX hash (если транзакция была отправлена)
- [ ] Описание не содержит "ничего не работает" / "сломалось" без конкретики
`;
}

// ─── Frontend module docs ─────────────────────────────────────────────────────

const FRONTEND_MODULES = [
  {
    name: 'Dashboard',
    path: 'frontend/src/app/dashboard/page.tsx',
    desc: 'Личный кабинет: активные сделки, списки предложений, статусы.',
    flows: [
      'Просмотр активных сделок (client / executor)',
      'Просмотр своих листингов (JobBoard / ServiceBoard)',
      'Переход к конкретной сделке',
      'Fund сделки: USDC permit → relay → статус Funded',
    ],
  },
  {
    name: 'Deal',
    path: 'frontend/src/app/deal/[address]/page.tsx',
    desc: 'Страница конкретной сделки. Полный цикл: Fund → Activate → MarkDone → Release / Dispute → Resolve.',
    flows: [
      'Клиент: Fund (permit или прямой approve)',
      'Исполнитель: Activate',
      'Исполнитель: MarkDone',
      'Клиент: Release (одобрить) или Dispute (поднять спор)',
      'Арбитр: Resolve (clientWins: true/false)',
      'Таймауты: triggerAutoApprove, triggerArbiterTimeout',
    ],
  },
  {
    name: 'Board (Jobs)',
    path: 'frontend/src/app/board/page.tsx',
    desc: 'Доска заказов — просмотр открытых заданий исполнителями.',
    flows: [
      'Отображение списка открытых jobs',
      'Фильтрация по региону/цене',
      'Переход к деталям задания',
    ],
  },
  {
    name: 'Board › Client Post',
    path: 'frontend/src/app/board/client/post/page.tsx',
    desc: 'Форма публикации задания клиентом.',
    flows: [
      'Заполнить форму (title, desc, budget, deadline, region)',
      'Загрузить детали в IPFS',
      'Подписать postJob — gasless relay',
      'Проверить появление в Board',
    ],
  },
  {
    name: 'Board › Executor',
    path: 'frontend/src/app/board/executor/page.tsx',
    desc: 'Доска услуг — список своих услуг + входящие запросы.',
    flows: [
      'Отображение своих активных услуг',
      'Просмотр и принятие/отклонение запросов',
      'История запросов по каждой услуге',
      'Создание сделки из запроса → deployAgreement',
    ],
  },
  {
    name: 'Arbiter Hub',
    path: 'frontend/src/app/arbiter/page.tsx',
    desc: 'Интерфейс арбитра: список споров, клейм, разрешение, история.',
    flows: [
      'Open Disputes: просмотр некленутых споров',
      'Commit → Claim (двухшаговый commit-reveal)',
      'My Cases: активные дела арбитра',
      'Resolve: clientWins / executorWins через relay',
      'History: поиск по адресам (deal / client / executor)',
      'Manage (chief): добавление/удаление арбитров',
    ],
  },
  {
    name: 'Admin Panel',
    path: 'frontend/src/app/admin/page.tsx',
    desc: 'Панель администратора (только Diamond owner). Управление протоколом.',
    flows: [
      'Arbiter Registry: добавление/удаление арбитров',
      'Chief Arbiter: назначение и отзыв',
      'Arbiter Archive: поиск по истории решений',
      'Dispute Lookup: ручной поиск по адресу сделки',
      'Protocol settings: threshold, fees, pause',
    ],
  },
  {
    name: 'Chat',
    path: 'frontend/src/app/chat/page.tsx',
    desc: 'XMTP-чат: прямые сообщения и чаты по сделкам.',
    flows: [
      'Инициализация XMTP клиента (подписание)',
      'Открытие чата с адресом',
      'Отправка сообщения',
      'Уведомления при новых сообщениях',
    ],
  },
];

function generateFrontendDoc(mod) {
  const lines = [];
  const h  = (n, t) => lines.push(`${'#'.repeat(n)} ${t}`);
  const nl = () => lines.push('');
  const p  = t  => lines.push(t);
  const cb = t  => lines.push(`- [ ] ${t}`);

  h(1, `Frontend: ${mod.name}`);
  p(`> **Файл:** \`${mod.path}\``);
  nl();
  p(mod.desc);
  nl();

  h(2, 'User Flows');
  for (const flow of mod.flows) {
    p(`- ${flow}`);
  }
  nl();

  h(2, 'Test Checklist');
  nl();
  for (const flow of mod.flows) {
    h(3, flow);
    cb('UI рендерится без ошибок');
    cb('Загрузка данных (loading skeleton → контент)');
    cb('Действие выполняется успешно — toast success');
    cb('On-chain состояние изменилось (проверить через explorer / cast)');
    cb('Ошибочный сценарий — показывается понятный toast error');
    cb('Страница корректна на мобильном (375px)');
    nl();
  }

  h(2, 'Known Edge Cases');
  p('- Кошелёк не подключён → показывается prompt подключения');
  p('- Неправильная сеть (не Base Sepolia) → показывается предупреждение');
  p('- USDC баланс = 0 → кнопки с USDC заблокированы, показывается сумма');
  p('- VPN → цена определена как $10, лейбл "VPN · $10"');
  nl();

  return lines.join('\n');
}

// ─── Overview README ──────────────────────────────────────────────────────────

function generateReadme() {
  const lines = [];
  lines.push('# Signature404 — Generated Documentation');
  lines.push('');
  lines.push(`> Автогенерация: \`node scripts/generate-docs.js\` · Дата: ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('## Контракты');
  lines.push('');
  lines.push('| Модуль | Теги | Файл |');
  lines.push('|--------|------|------|');
  for (const m of MODULES) {
    lines.push(`| [${m.name}](contracts/${m.name}.md) | ${m.tags.join(', ')} | \`${m.src}\` |`);
  }
  lines.push('');
  lines.push('## Frontend модули');
  lines.push('');
  lines.push('| Модуль | Файл |');
  lines.push('|--------|------|');
  for (const m of FRONTEND_MODULES) {
    lines.push(`| [${m.name}](frontend/${m.name.replace(/[/ ›]+/g, '_')}.md) | \`${m.path}\` |`);
  }
  lines.push('');
  lines.push('## Тест-планы');
  lines.push('');
  lines.push('| Модуль | Файл |');
  lines.push('|--------|------|');
  for (const m of MODULES) {
    lines.push(`| ${m.name} | [test-plans/${m.name}-test-plan.md](test-plans/${m.name}-test-plan.md) |`);
  }
  lines.push('');
  lines.push('## Шаблон Bug Report');
  lines.push('');
  lines.push('→ [BUG_REPORT_TEMPLATE.md](../BUG_REPORT_TEMPLATE.md)');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Задеплоенные адреса (Base Sepolia)');
  lines.push('');
  lines.push('| Контракт | Адрес |');
  lines.push('|----------|-------|');
  lines.push('| DiamondProxy | `0xF00CC71878c226E0b64253Fb71dD802aF12165D0` |');
  lines.push('| MinimalForwarder | `0x41c66b80B1445F48AF3863763BC0EC0549413CD7` |');
  lines.push('| USDC (test) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |');
  lines.push('');

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log('📚 Generating documentation...\n');

  ensure(path.join(DOCS_DIR, 'contracts'));
  ensure(path.join(DOCS_DIR, 'test-plans'));
  ensure(path.join(DOCS_DIR, 'frontend'));

  // Contract docs
  console.log('Contracts:');
  for (const mod of MODULES) {
    try {
      const doc = generateContractDoc(mod);
      write(path.join(DOCS_DIR, 'contracts', `${mod.name}.md`), doc);
    } catch (e) {
      console.warn(`  ⚠ ${mod.name}: ${e.message}`);
    }
  }

  // Test plans
  console.log('\nTest plans:');
  for (const mod of MODULES) {
    try {
      const plan = generateTestPlan(mod);
      write(path.join(DOCS_DIR, 'test-plans', `${mod.name}-test-plan.md`), plan);
    } catch (e) {
      console.warn(`  ⚠ ${mod.name}: ${e.message}`);
    }
  }

  // Frontend docs
  console.log('\nFrontend:');
  for (const mod of FRONTEND_MODULES) {
    try {
      const doc = generateFrontendDoc(mod);
      const fname = `${mod.name.replace(/[/ ›]+/g, '_')}.md`;
      write(path.join(DOCS_DIR, 'frontend', fname), doc);
    } catch (e) {
      console.warn(`  ⚠ ${mod.name}: ${e.message}`);
    }
  }

  // Overview README
  console.log('\nOverview:');
  write(path.join(DOCS_DIR, 'README.md'), generateReadme());

  // Bug report template
  write(path.join(ROOT, 'docs', 'BUG_REPORT_TEMPLATE.md'), generateBugReportTemplate());

  console.log('\n✅ Done. See docs/generated/');
}

main();
