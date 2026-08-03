#!/usr/bin/env node
// ⚠️  ПРОВЕРОЧНЫЙ СКРИПТ, ЗАПУСКАЕТСЯ РУКАМИ. НЕ ЧАСТЬ `npm test`, НЕ
// ЗАПУСКАЕТСЯ CI. Временно ПЕРЕЗАПИСЫВАЕТ ../app.js на диске (накладывает
// мутацию, потом восстанавливает исходный файл из памяти в try/finally) —
// не гонять параллельно с чем-либо ещё, что читает или пишет этот файл.
// Существует ради разового замера/доказательства, зафиксированного в
// task-3-report.md, а не ради регрессионной защиты (та живёт в
// test/bagRoutes.test.js, свойство 2 — обычный vitest-тест).
//
// Самое сильное доказательство из трёх: настоящий ДОЧЕРНИЙ Node-процесс
// (disk-failure-child.mjs), без единого process.on('uncaughtException') —
// точная копия реальности релеера. Родитель бьёт по нему настоящими HTTP-
// запросами через реальный TCP, устраивает настоящий отказ диска (chmod),
// и проверяет НЕ логи, а факт: жив ли дочерний процесс после этого (exit
// code, отвечает ли /health).
//
// Запускается дважды за один вызов: первый раз с текущим кодом app.js
// (try/catch внутри res.on('finish') на месте), второй раз — с временно
// наложенной мутацией (try/catch вокруг markFetched() убран), чтобы
// показать разницу вживую, а не только рассуждением.
//
// Запуск: node relayer/scripts/verify-disk-failure-real-crash.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHILD_SCRIPT = path.join(__dirname, 'disk-failure-child.mjs');
const APP_JS = path.join(__dirname, '..', 'app.js');

function httpReq(method, url, { headers = {}, body, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const m = buf.match(/LISTENING (\d+)/);
      if (m) {
        child.stdout.off('data', onData);
        resolve(Number(m[1]));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => process.stderr.write(`[child stderr] ${chunk}`));
    child.once('exit', (code, signal) => reject(new Error(`child exited before listening (code=${code}, signal=${signal})`)));
    setTimeout(() => reject(new Error('timed out waiting for child to listen')), 5000);
  });
}

async function runOnce(label) {
  console.log(`\n=== ${label} ===`);
  const STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-real-crash-'));
  const child = spawn(process.execPath, [CHILD_SCRIPT], {
    env: { ...process.env, STORAGE_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let childExited = false;
  let exitInfo = null;
  child.once('exit', (code, signal) => { childExited = true; exitInfo = { code, signal }; });

  const port = await waitForListening(child);
  const base = `http://127.0.0.1:${port}`;

  const alice = ethers.Wallet.createRandom();
  const bob = ethers.Wallet.createRandom();
  const aliceAddr = (await alice.getAddress()).toLowerCase();
  const bobAddr = (await bob.getAddress()).toLowerCase();

  const { bagPassChallenge } = await import(path.join(__dirname, '..', 'bagPass.js'));

  async function getPass(wallet, address) {
    const ts = Math.floor(Date.now() / 1000);
    const sig = await wallet.signMessage(bagPassChallenge(address, ts));
    const bodyStr = JSON.stringify({ address });
    const res = await httpReq('POST', `${base}/bags/pass`, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(bodyStr)),
        'x-ts': String(ts),
        'x-sig': sig,
        'cf-connecting-ip': '203.0.113.20',
      },
      body: bodyStr,
    });
    if (res.status !== 200) throw new Error(`getPass failed: ${res.status} ${res.text}`);
    return res.body.pass;
  }

  const alicePass = await getPass(alice, aliceAddr);
  const bobPass = await getPass(bob, bobAddr);

  const payload = 'real-sealed-bag-bytes-child-process';
  const putRes = await httpReq('PUT', `${base}/bags/${bobAddr}`, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(Buffer.byteLength(payload)),
      'x-bag-pass': alicePass,
      'cf-connecting-ip': '203.0.113.20',
    },
    body: payload,
  });
  if (putRes.status !== 200) throw new Error(`PUT failed: ${putRes.status} ${putRes.text}`);
  const key = putRes.body.key;

  fs.chmodSync(STORAGE_DIR, 0o500);
  let getRes = null;
  let getErr = null;
  try {
    getRes = await httpReq('GET', `${base}/bags/${key}`, {
      headers: { 'x-bag-pass': bobPass, 'cf-connecting-ip': '203.0.113.21' },
    });
  } catch (e) {
    getErr = e;
  } finally {
    try { fs.chmodSync(STORAGE_DIR, 0o700); } catch { /* child may already be dead */ }
  }

  await new Promise((r) => setTimeout(r, 300));

  let healthRes = null;
  let healthErr = null;
  try {
    healthRes = await httpReq('GET', `${base}/health`);
  } catch (e) {
    healthErr = e;
  }

  console.log('GET /bags/:key во время отказа диска:', getRes ? `status=${getRes.status}` : `ОШИБКА СЕТИ (${getErr?.message})`);
  console.log('GET /health после отказа диска:', healthRes ? `status=${healthRes.status}` : `ОШИБКА СЕТИ (${healthErr?.message})`);
  console.log('Дочерний процесс завершился сам:', childExited ? `ДА (code=${exitInfo.code}, signal=${exitInfo.signal})` : 'НЕТ, всё ещё работает');

  if (!childExited) child.kill('SIGKILL');
  fs.rmSync(STORAGE_DIR, { recursive: true, force: true });

  const survived = !childExited && healthRes?.status === 200;
  console.log(`Итог "${label}": процесс пережил отказ диска —`, survived ? 'ДА' : 'НЕТ, УПАЛ');
  return survived;
}

console.log('Прогон А: текущий код (try/catch на месте)');
const survivedWithCatch = await runOnce('А — try/catch на месте');

console.log('\nНакладываю мутацию: try/catch вокруг markFetched() внутри res.on(\'finish\') убран...');
const original = fs.readFileSync(APP_JS, 'utf8');
const mutated = original.replace(
  `res.on('finish', () => {
    try {
      markFetched(key, Date.now());
    } catch (e) {
      console.error('[bags] markFetched failed after successful delivery (read receipt lost, bytes already sent):', e.message);
    }
  });`,
  `res.on('finish', () => {
    markFetched(key, Date.now()); // MUTATION (verify-disk-failure-real-crash.mjs)
  });`,
);
if (mutated === original) {
  console.error('FAIL: не нашёл ожидаемый блок res.on(\'finish\') в app.js — приём мутации устарел, скрипт нужно поправить под текущий код');
  process.exit(1);
}
fs.writeFileSync(APP_JS, mutated);

let survivedMutated;
try {
  console.log('\nПрогон Б: та же логика, БЕЗ try/catch (мутация)');
  survivedMutated = await runOnce('Б — try/catch убран (мутация)');
} finally {
  fs.writeFileSync(APP_JS, original);
  console.log('\napp.js возвращён к исходному состоянию.');
}

console.log('\n=== Сводка ===');
console.log('С try/catch (текущий код) процесс пережил отказ диска:', survivedWithCatch ? 'ДА' : 'НЕТ');
console.log('Без try/catch (мутация) процесс пережил отказ диска:', survivedMutated ? 'ДА' : 'НЕТ');

if (!survivedWithCatch) {
  console.error('\nFAIL: текущий код НЕ пережил отказ диска — это значит настоящая находка, а не мутация');
  process.exit(1);
}
if (survivedMutated) {
  console.error('\nВНИМАНИЕ: мутация тоже "пережила" — try/catch не единственная защита, либо отказ не воспроизвёлся так, как задумано');
  process.exit(1);
}
console.log('\nOK: try/catch внутри res.on(\'finish\') — единственное, что стоит между отказом диска и падением всего процесса, и оно на месте.');
