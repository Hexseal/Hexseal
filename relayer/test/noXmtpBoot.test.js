/**
 * noXmtpBoot.test.js — бот XMTP больше не поднимается (Задача 7 плана
 * «Клиент чата»).
 *
 * ⚠️ ДОКАЗАТЕЛЬСТВО — ГРАФОМ МОДУЛЕЙ И ЖИВЫМ ПРОЦЕССОМ, не поиском слов.
 * Релеер запускается НАСТОЯЩИМ `node index.js` в отдельном процессе, с
 * крючком резолвера, который бросает на любой `@xmtp/*`. Если хоть один
 * модуль по дороге попросит XMTP — процесс упадёт, и тест это увидит.
 *
 * Отдельный процесс, а не `await import('../index.js')` в тестовом: index.js
 * слушает порт и вешает `setInterval`, то есть внутри теста он не
 * останавливается, а крючок резолвера регистрируется на процесс целиком и
 * сломал бы соседние тесты, которым XMTP-модули не запрещены.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const RELAYER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBID_HOOK = path.join(RELAYER_DIR, 'test', 'helpers', 'forbidXmtp.mjs');

/** Настоящие переменные боевого запуска, но все свежие и случайные — ни одна
 *  не связана с `.env.relayer` (dotenv по умолчанию НЕ перезаписывает то, что
 *  уже стоит в окружении). Переменных XMTP здесь нет ВОВСЕ — в этом и вопрос:
 *  «процесс стартует без переменных XMTP и не падает». */
function bootEnv(storageDir) {
  return {
    ...process.env,
    STORAGE_DIR: storageDir,
    SERVER_SECRET: `no-xmtp-boot-${Date.now()}`,
    RELAYER_PRIVATE_KEY: ethers.Wallet.createRandom().privateKey,
    TRUSTED_FORWARDER: ethers.Wallet.createRandom().address,
    DIAMOND_ADDRESS: ethers.Wallet.createRandom().address,
    PUSH_SECRET: 'no-xmtp-boot-push',
    ALLOWED_ORIGINS: 'http://127.0.0.1',
    TRUST_PROXY: 'false',
    RPC_URL: 'http://127.0.0.1:1',
    PORT: '0',
  };
}

/** Поднимает процесс, копит его вывод, ждёт `ready` или смерти. */
function runBoot({ withHook }) {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-noxmtp-'));
  const args = withHook ? ['--import', FORBID_HOOK, 'index.js'] : ['index.js'];
  const child = spawn(process.execPath, args, {
    cwd: RELAYER_DIR,
    env: bootEnv(storageDir),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', d => { out += d.toString(); });
  child.stderr.on('data', d => { err += d.toString(); });

  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  let exitInfo = null;
  exited.then(info => { exitInfo = info; });

  return {
    get out() { return out; },
    get err() { return err; },
    get exitInfo() { return exitInfo; },
    /** Ждёт строку в выводе (или смерти процесса) не дольше `ms`. */
    async waitFor(needle, ms) {
      const started = Date.now();
      while (Date.now() - started < ms) {
        if (out.includes(needle) || err.includes(needle)) return true;
        if (exitInfo) return false;
        await new Promise(r => setTimeout(r, 50));
      }
      return out.includes(needle) || err.includes(needle);
    },
    async settle(ms) { await new Promise(r => setTimeout(r, ms)); },
    async stop() {
      if (!exitInfo) {
        child.kill('SIGKILL');
        await exited;
      }
      fs.rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

describe('бот XMTP не поднимается', () => {
  let boot;

  beforeAll(async () => {
    boot = runBoot({ withHook: true });
    await boot.waitFor('Relayer running on', 20_000);
    // Дать процессу пожить: прежний бот поднимался ПОСЛЕ старта сервера,
    // отдельным асинхронным хвостом. Проверка сразу после «Relayer running»
    // ловила бы только тот случай, когда бот падает синхронно.
    await boot.settle(2_000);
  }, 30_000);

  afterAll(async () => { await boot?.stop(); });

  it('процесс стартует без переменных XMTP и остаётся жив', () => {
    expect(boot.out).toContain('Relayer running on');
    expect(boot.exitInfo).toBeNull();
  });

  it('запрет на загрузку @xmtp/* НЕ сработал — значит XMTP никто не просил', () => {
    expect(boot.out + boot.err).not.toContain('FORBIDDEN_XMTP_IMPORT');
  });

  it('ни одной строки бота в выводе', () => {
    const all = boot.out + boot.err;
    expect(all).not.toContain('[bot]');
    expect(all).not.toContain('XMTP ready');
    expect(all).not.toContain('XMTP init failed');
  });

  it('запрет РАБОТАЕТ (замок, который запирает всех, — не замок)', async () => {
    // Без этой проверки все три замка выше проходили бы зелёными и на
    // сломанном крючке: «нет строки FORBIDDEN_XMTP_IMPORT» одинаково верно и
    // когда XMTP не просили, и когда запрет не действует вовсе.
    const probe = spawn(
      process.execPath,
      ['--import', FORBID_HOOK, '--input-type=module', '-e', "await import('@xmtp/node-sdk');"],
      { cwd: RELAYER_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let text = '';
    probe.stdout.on('data', d => { text += d.toString(); });
    probe.stderr.on('data', d => { text += d.toString(); });
    const code = await new Promise(resolve => probe.on('exit', c => resolve(c)));
    expect(text).toContain('FORBIDDEN_XMTP_IMPORT:@xmtp/node-sdk');
    expect(code).not.toBe(0);
  }, 20_000);

  it('botLog.js и notifier.js — бот-только модули — удалены', () => {
    expect(fs.existsSync(path.join(RELAYER_DIR, 'botLog.js'))).toBe(false);
    expect(fs.existsSync(path.join(RELAYER_DIR, 'notifier.js'))).toBe(false);
    expect(fs.existsSync(path.join(RELAYER_DIR, 'test', 'botLogCatchup.test.js'))).toBe(false);
  });
});
