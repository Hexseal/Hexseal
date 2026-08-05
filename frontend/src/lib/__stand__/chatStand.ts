/**
 * chatStand.ts — сквозной стенд (Задача 1 плана «Клиент чата»).
 *
 * Поднимает НАСТОЯЩЕЕ приложение релеера (`relayer/app.js`, тот же Express
 * `app`, что и в проде — не мок, не подмена) на свободном порту, с временным
 * `STORAGE_DIR` (mkdtemp) и настоящими `ethers.Wallet.createRandom()`
 * кошельками. Живёт в репозитории, а не в черновиках проверяющего — план
 * 2 запустил клиент и сервер вместе только на финальной проверке, шесть
 * задач писали две половины, ни разу не встречавшиеся до самого конца.
 * Здесь стенд появляется первым, и каждая следующая задача плана
 * проверяется на нём.
 *
 * НЕ мок ethers/express/relayer — единственное, что здесь искусственно,
 * это переменные окружения (свежие случайные ключи/адреса, ни один не имеет
 * отношения к боевому `.env.relayer`) и временный каталог хранения.
 *
 * ⚠️ Порядок critical: переменные окружения ставятся ДО динамического
 * `import('.../relayer/app.js')`. `bagStore.js`/`bagPass.js` (импортируемые
 * из app.js) считают свои пути/секреты РОВНО ОДИН РАЗ, на уровне модуля —
 * если бы `app.js` импортировался статически (или динамически, но раньше,
 * чем эти присваивания), склад заморозил бы боевой `STORAGE_DIR` (или его
 * умолчание) навсегда для этого процесса. План 2 уже терял на этом раунд
 * (см. bagStore.js, комментарий над импортами в app.js, И-3) — здесь та же
 * дисциплина, что `relayer/test/*.test.js` уже применяют собственным
 * `process.env.X = ...` ДО `await import('../app.js')`.
 *
 * `vi.resetModules()` перед импортом — не стиль, а необходимость: Node/Vite
 * кэширует модуль по specifier, так что ВТОРОЙ вызов `startChatStand()` в
 * том же тестовом процессе (например, две разные `it()` одного файла)
 * получил бы уже проинициализированный со СТАРЫМ `STORAGE_DIR` инстанс
 * `app.js` без сброса — тот же приём, что `relayer/test/bagStore.test.js`
 * уже применяет в `withFreshBagStoreModule()` для той же причины.
 */
import { ethers } from 'ethers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';

// frontend/src/lib/__stand__/chatStand.ts -> (repo root)/relayer/app.js
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAYER_APP_PATH = path.resolve(__dirname, '../../../../relayer/app.js');

/**
 * Не `import type { Express } from 'express'` — 'express' не зависимость
 * фронта (она есть только в `relayer/node_modules`), а `npm run type-check`
 * (frontend/tsconfig.json) идёт БЕЗ доступа к ней: `Cannot find module
 * 'express'`. Нужен только `.listen()`, возвращающий настоящий
 * `node:http.Server` (`@types/node` у фронта есть всегда, используется по
 * всему этому файлу и так) — минимальная своя структурная форма вместо
 * чужого пакета типов.
 */
interface MinimalExpressApp {
  listen(port: number): Server;
}

export interface ChatStand {
  /** `http://127.0.0.1:<port>` — свободный порт, выбранный ОС (`listen(0)`). */
  url: string;
  /** Два независимых, ни разу не пересекающихся кошелька. */
  wallets: [ethers.HDNodeWallet, ethers.HDNodeWallet];
  /** Останавливает сервер и убирает временный каталог хранения. */
  stop(): Promise<void>;
}

let standCounter = 0;

/**
 * Поднимает настоящий релеер на свободном порту. Каждый вызов — полностью
 * независимый инстанс (свой `STORAGE_DIR`, свой `SERVER_SECRET`, свой
 * порт) — можно звать несколько раз подряд в одном тестовом файле, включая
 * параллельно (два разных стенда друг другу не мешают: ни общего диска, ни
 * общего процесса релеера).
 */
export async function startChatStand(): Promise<ChatStand> {
  standCounter += 1;
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-chat-stand-'));

  // Обязательные переменные (relayer/app.js падает на pre-flight throw без
  // них — SERVER_SECRET/RELAYER_PRIVATE_KEY/TRUSTED_FORWARDER/DIAMOND_ADDRESS,
  // см. app.js) + STORAGE_DIR (изоляция от боевого/чужого стенда) — все
  // свежие, случайные, никак не связаны с `.env.relayer` в relayer/ (тот
  // файл существует в репозитории для локального запуска боевого процесса;
  // dotenv.config() внутри app.js НЕ перезаписывает уже выставленные здесь
  // значения — таково поведение dotenv по умолчанию, override не включён).
  process.env.STORAGE_DIR = storageDir;
  process.env.SERVER_SECRET = `chat-stand-secret-${standCounter}-${Date.now()}`;
  process.env.RELAYER_PRIVATE_KEY = ethers.Wallet.createRandom().privateKey;
  process.env.TRUSTED_FORWARDER = ethers.Wallet.createRandom().address;
  process.env.DIAMOND_ADDRESS = ethers.Wallet.createRandom().address;
  process.env.PUSH_SECRET = `chat-stand-push-secret-${standCounter}`;
  process.env.ALLOWED_ORIGINS = 'http://127.0.0.1';
  // Явно false, не delete: не полагаемся на то, что .env.relayer НЕ
  // выставляет её сам (он выставляет — боевая настройка за туннелем
  // Cloudflare) — стенд слушает напрямую, без прокси.
  process.env.TRUST_PROXY = 'false';
  // Гарантированно недостижимый адрес — маршруты /bags/* этого стенда его
  // не вызывают вообще (ни один затрагиваемый обработчик не делает
  // staticcall), но защита в глубину: даже случайно задетый путь не
  // дозвонится до настоящей сети, а не тихо использует боевой RPC_URL из
  // .env.relayer.
  process.env.RPC_URL = 'http://127.0.0.1:1';

  // Динамический import ПОСЛЕ всех присваиваний выше — см. докстринг файла.
  // `vi.resetModules()` — только если тестовый раннер (vitest) сейчас
  // активен; вне теста (гипотетический прямой `node` запуск стенда) его
  // просто нет, и первый (единственный в таком запуске) импорт и так
  // получает чистый модуль.
  //
  // Specifier — через переменную, не строковый литерал `import('vitest')`:
  // 'vitest' — как и 'express' выше — недоступна `npm run type-check`
  // (тесты и всё, что им нужно, исключены из программы tsc, см.
  // frontend/tsconfig.json). Литерал заставил бы tsc резолвить типы пакета
  // и падать тем же `Cannot find module`; за переменной tsc не видит, какой
  // модуль это, и не пытается — ровно то поведение, которое здесь нужно
  // (рантайм при этом не меняется никак, Node/Vite резолвят по значению
  // строки одинаково что для литерала, что для переменной).
  try {
    const vitestSpecifier = 'vitest';
    const vitestModule = (await import(/* @vite-ignore */ vitestSpecifier)) as {
      vi: { resetModules: () => void };
    };
    vitestModule.vi.resetModules();
  } catch {
    // Не под vitest — no-op, см. комментарий выше.
  }

  // Абсолютный ПУТЬ, не `file://`-URL: Vite/vite-node (стенд идёт через
  // тестовый раннер фронта, см. frontend/vitest.config.mjs) грузит голый
  // абсолютный путь честно, а `file://` c пробелом в пути (реальный путь
  // этого репозитория — "…/dev project/…") у Vite надёжно даёт «Failed to
  // load url … Does the file exist?» независимо от того, внутри корня
  // фронта файл или снаружи — проверено вживую на пустом diagnostic-тесте
  // ДО этой строки, отдельно на файле внутри `frontend/src` и на файле в
  // `relayer/`, оба ломались ИМЕННО через `file://`, оба грузились честно
  // голым путём. `@vite-ignore` — тот же приём, что и у `pollBags`/`fetch`
  // нигде в этом файле не нужен по факту (путь всё равно вычисляется в
  // рантайме, не литералом), но явно говорит Vite не пытаться статически
  // анализировать динамический импорт.
  const appModule = (await import(/* @vite-ignore */ RELAYER_APP_PATH)) as { app: MinimalExpressApp };
  const app = appModule.app;

  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('chatStand: failed to bind a port (server.address() gave no port info)');
  }
  const url = `http://127.0.0.1:${address.port}`;

  const wallets: [ethers.HDNodeWallet, ethers.HDNodeWallet] = [
    ethers.Wallet.createRandom(),
    ethers.Wallet.createRandom(),
  ];

  let stopped = false;
  return {
    url,
    wallets,
    async stop() {
      if (stopped) return; // идемпотентно — двойной stop() не должен падать
      stopped = true;
      // closeAllConnections (Node 18.2+): без него server.close() ждёт,
      // пока закроются уже установленные keep-alive соединения САМИ —
      // для undici/fetch они держатся открытыми в пуле и НЕ закрываются
      // сами по себе просто потому, что тест закончил ими пользоваться,
      // так что close() без этого мог бы зависнуть до истечения таймаута
      // сокета, а не до конца самого теста.
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      fs.rmSync(storageDir, { recursive: true, force: true });
    },
  };
}
