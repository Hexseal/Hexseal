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
 *
 * ⚠️ ОДИН СТЕНД НА ПРОЦЕСС ОДНОВРЕМЕННО, не параллельно. Найдено ревью
 * (координатор, воспроизведено вживую): `Promise.all([startChatStand(),
 * startChatStand()])` даёт молчаливое смешение складов — `process.env` и
 * реестр модулей процесса ОБЩИЕ, так что второй вызов, начавшийся ДО того,
 * как первый закончил инициализацию, переписывает переменные окружения
 * первого своими, и мешок с одного стенда становится виден на другом, а
 * `stop()` первого сносит каталог, которым пользуется второй. Настоящий
 * параллелизм (реального ОС-процесса на стенд) — отдельная, более тяжёлая
 * задача (child_process, IPC для чтения порта); здесь вместо этого —
 * честный, громкий отказ: `startChatStand()`, вызванный пока предыдущий
 * стенд ещё жив, БРОСАЕТ, не пытается притвориться независимым.
 *
 * Для сценария «два пользователя» (которым понадобится задачам 5/6 этого
 * плана) это не потеря: два кошелька, которые уже отдаёт ОДИН стенд, — и
 * есть два пользователя одного сервера, ровно то же самое отношение, что в
 * бою (один релеер, много кошельков). Два стенда нужны, только если нужны
 * ДВА разных сервера — этот стенд такого сценария не обслуживает.
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
  /**
   * Временный `STORAGE_DIR` этого стенда — тот самый, которым живёт склад
   * (`bags/<адрес>/<ключ>.bin`, опись в `bag-meta.json`).
   *
   * Открыт наружу ради ровно одного сценария, ради которого весь этот план и
   * существует: ВЫРЕЗАТЬ мешок по-настоящему, со стороны сервера, оставив
   * опись на месте. Пропустить мешок на клиенте было бы не тем же самым —
   * это проверяло бы наш собственный `if`, а не картину «склад утверждает,
   * что мешок был, а байтов нет».
   */
  storageDir: string;
  /** Останавливает сервер и убирает временный каталог хранения. */
  stop(): Promise<void>;
}

let standCounter = 0;

// Гейт «один стенд на процесс» (см. предупреждение в докстринге файла).
// Проверяется и выставляется СИНХРОННО, первым делом в startChatStand(), ДО
// какого-либо `await` — это то, что делает гейт эффективным даже против
// буквального `Promise.all([startChatStand(), startChatStand()])`: вызов
// функции внутри Promise.all выполняется синхронно вплоть до первого
// await, так что первый вызов в массиве успевает поставить флаг ДО того,
// как второй вызов вообще начнёт своё тело. Обычный module-level `let`, не
// что-то более сложное (мьютекс и т.п.) — конкурентности внутри одного
// синхронного отрезка кода в JS не бывает по построению языка.
let activeStand = false;

/**
 * Поднимает настоящий релеер на свободном порту. Каждый вызов — независимый
 * инстанс (свой `STORAGE_DIR`, свой `SERVER_SECRET`, свой порт) — можно
 * звать несколько раз ПОДРЯД в одном тестовом файле (предыдущий обязан быть
 * остановлен через `stop()` первым). ОДНОВРЕМЕННО — то есть без ожидания
 * `stop()` предыдущего — нельзя: см. предупреждение в докстринге файла.
 * Нарушение бросает громко, а не смешивает склады молча.
 */
export interface ChatStandOptions {
  /** Адрес JSON-RPC узла для релеера. Умолчание — недостижимый адрес. */
  rpcUrl?: string;
}

export async function startChatStand(opts: ChatStandOptions = {}): Promise<ChatStand> {
  if (activeStand) {
    throw new Error(
      'chatStand: another stand from this module is already running in this process. ' +
        'startChatStand() is not safe to call while a previous stand is still active — ' +
        'process.env and the module registry are shared, so a second concurrent stand ' +
        'silently mixes bag stores with the first instead of being independent. ' +
        'Call .stop() on the existing stand before starting a new one, or use the two ' +
        'wallets the current stand already gives you for a two-user scenario.',
    );
  }
  activeStand = true;
  // Отпустить гейт при ЛЮБОМ отказе на пути инициализации (mkdtemp, import,
  // listen, ...) — иначе неудачный старт (например, порт занят гонкой,
  // import бросил) навсегда запирает гейт: следующий startChatStand() бился
  // бы в "already running" о стенд, который на самом деле никогда не
  // поднялся и никогда не будет остановлен через .stop(). Снимается сразу
  // после успешного return — владение флагом переходит возвращённому
  // stop().
  try {
    return await createStand(opts);
  } catch (e) {
    activeStand = false;
    throw e;
  }
}

async function createStand(opts: ChatStandOptions): Promise<ChatStand> {
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
  // ⚠️ Умолчание НЕ МЕНЯЕТСЯ: гарантированно недостижимый адрес, чтобы
  // случайно задетый путь не дозвонился до настоящей сети. Параметр появился
  // ради маршрутов ящика спора (4в-2, Задача 1): они читают цепь, и на
  // недостижимом узле отвечают отказом ВСЕГДА — то есть замок ящика на таком
  // стенде проверить нечем.
  process.env.RPC_URL = opts.rpcUrl ?? 'http://127.0.0.1:1';

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
    storageDir,
    async stop() {
      if (stopped) return; // идемпотентно — повторный УСПЕШНЫЙ stop() не делает ничего дважды
      try {
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
        // `stopped` ставится ТОЛЬКО после реального успеха (находка ревью,
        // координатор третий раунд) — раньше стояло ДО работы, и неудавшийся
        // stop() (например, server.close() отказал) делал ПОВТОРНЫЙ вызов
        // немым: `stopped` уже true, значит следующий stop() молча
        // резолвился бы, ничего не пробуя заново, а не по-настоящему
        // повторял отказавшую попытку.
        stopped = true;
      } finally {
        // Гейт «один стенд на процесс» освобождается ВСЕГДА — даже если
        // что-то из шагов выше упало. Раньше стоял ПОСЛЕ шагов, вне finally:
        // неудавшийся stop() (например, server.close() отказал) навсегда
        // запирал ЦЕЛЫЙ ПРОЦЕСС — каждый следующий startChatStand() отвечал
        // бы "already running", хотя реально не работает НИЧЕГО (находка
        // ревью, координатор третий раунд).
        activeStand = false;
      }
    },
  };
}
