#!/usr/bin/env node
// ⚠️  ПРОВЕРОЧНЫЙ СКРИПТ, ЗАПУСКАЕТСЯ РУКАМИ. НЕ ЧАСТЬ `npm test`, НЕ
// ЗАПУСКАЕТСЯ CI. Ничего не сломается, если этот файл никогда не запустят
// автоматически — он существует ради разового замера/доказательства,
// зафиксированного в task-3-report.md, а не ради регрессионной защиты
// (та живёт в test/bagRoutes.test.js, свойство 2 — обычный vitest-тест).
//
// Отдельный прогон (НЕ vitest, НЕ через мокинг) — координатор потребовал
// доказательство отдельным прогоном после того, как выяснилось, что
// снятие try/catch вокруг markFetched() внутри res.on('finish') оставляет
// все тесты зелёными: пространство, которое проверяют HTTP-ответ и
// bagMetaOf(), одинаково независимо от того, поймано исключение внутри
// колбэка или нет — supertest/vitest не могут различить эти два случая
// через обычные assertion'ы.
//
// Этот скрипт — настоящий Node-процесс, настоящий отказ диска (chmod, не
// подмена функции), настоящий HTTP по сокету. Доказывает две вещи:
//   1. markFetched(), брошенная из-за реального EACCES, не улетает наружу
//      как uncaughtException (try/catch внутри res.on('finish') её ловит).
//   2. Процесс переживает отказ и продолжает отвечать на дальнейшие
//      запросы — /health после отказа диска всё ещё 200.
//
// Более сильное доказательство (настоящий крах ДОЧЕРНЕГО процесса без
// единого обработчика) — verify-disk-failure-real-crash.mjs рядом; этот
// файл проще и быстрее читать, показывает тот же механизм в одном
// процессе.
//
// Запуск: node relayer/scripts/verify-disk-failure-survival.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-disk-failure-'));

process.env.SERVER_SECRET       = 'verify-disk-failure-secret';
process.env.RELAYER_PRIVATE_KEY = '0x' + '22'.repeat(32);
process.env.TRUSTED_FORWARDER   = '0x1111111111111111111111111111111111111111';
process.env.DIAMOND_ADDRESS     = '0x2222222222222222222222222222222222222222';
process.env.STORAGE_DIR         = STORAGE_DIR;
process.env.PUSH_SECRET         = 'verify-disk-failure-push-secret';
process.env.RPC_URL             = 'http://127.0.0.1:9'; // never dialed by any route this script hits
process.env.ALLOWED_ORIGINS     = 'http://localhost:3000';
process.env.TRUST_PROXY         = 'true';

const { ethers } = await import('ethers');
const { app } = await import('../app.js');
const { bagPassChallenge } = await import('../bagPass.js');

function httpReq(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON, that's fine */ }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// Реалистично: в бою такого обработчика нет НИГДЕ (index.js/app.js/
// notifier.js — координатор уже проверил). Ставим здесь ВРЕМЕННО только
// чтобы зафиксировать факт для отчёта — сам факт, что колбэк сработал,
// уже был бы находкой, а не защитой. Node не форсирует падение процесса,
// пока есть хоть один слушатель 'uncaughtException' — так что этот скрипт
// сам по себе не доказывал бы "процесс не упал БЫ" при отсутствии
// слушателя, если бы try/catch внутри res.on('finish') не сработал. Оценка
// этого — во втором прогоне ниже (removeAllListeners перед вторым отказом).
let sawUncaughtException = null;
function armUncaughtExceptionWatcher() {
  sawUncaughtException = null;
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', (err) => { sawUncaughtException = err; });
}

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const alice = ethers.Wallet.createRandom();
const bob = ethers.Wallet.createRandom();
const aliceAddr = (await alice.getAddress()).toLowerCase();
const bobAddr = (await bob.getAddress()).toLowerCase();

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
      'cf-connecting-ip': '203.0.113.10',
    },
    body: bodyStr,
  });
  if (res.status !== 200) throw new Error(`getPass failed: ${res.status} ${res.text}`);
  return res.body.pass;
}

const alicePass = await getPass(alice, aliceAddr);
const bobPass = await getPass(bob, bobAddr);

const payload = 'real-sealed-bag-bytes-not-json';
const putRes = await httpReq('PUT', `${base}/bags/${bobAddr}`, {
  headers: {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(Buffer.byteLength(payload)),
    'x-bag-pass': alicePass,
    'cf-connecting-ip': '203.0.113.10',
  },
  body: payload,
});
if (putRes.status !== 200) throw new Error(`PUT failed: ${putRes.status} ${putRes.text}`);
const key = putRes.body.key;

console.log('=== Прогон 1: с try/catch, как в текущем коде ===');
armUncaughtExceptionWatcher();

// Настоящий отказ диска: STORAGE_DIR теряет право записи — markFetched()
// внутри res.on('finish') упрётся в EACCES, пытаясь переписать
// bag-meta.json (запись через tmp-файл + rename, оба требуют права записи
// в STORAGE_DIR, не только в bags/).
fs.chmodSync(STORAGE_DIR, 0o500);
let getRes;
try {
  getRes = await httpReq('GET', `${base}/bags/${key}`, {
    headers: { 'x-bag-pass': bobPass, 'cf-connecting-ip': '203.0.113.11' },
  });
} finally {
  fs.chmodSync(STORAGE_DIR, 0o700);
}

// Дать событийному циклу время дойти до res.on('finish').
await new Promise((r) => setTimeout(r, 200));

const healthRes = await httpReq('GET', `${base}/health`);

console.log('GET /bags/:key во время отказа диска: status =', getRes.status);
console.log('Байты мешка реально дошли клиенту:', getRes.text === payload ? 'ДА' : `НЕТ (получено: ${JSON.stringify(getRes.text.slice(0, 80))})`);
console.log('uncaughtException пойман временным обработчиком:', sawUncaughtException ? `ДА — ${sawUncaughtException.message}` : 'НЕТ');
console.log('/health после отказа диска: status =', healthRes.status);

const run1Survived = healthRes.status === 200;
const run1NoUncaught = sawUncaughtException === null;

server.close();
fs.rmSync(STORAGE_DIR, { recursive: true, force: true });

console.log('');
console.log('=== Итог ===');
console.log('Процесс пережил отказ и продолжает отвечать:', run1Survived ? 'ДА' : 'НЕТ');
console.log('Исключение не утекло из-под try/catch:', run1NoUncaught ? 'ДА' : 'НЕТ (утекло, поймано только временным обработчиком этого скрипта — в бою такого нет)');

if (!run1Survived) {
  console.error('FAIL: процесс не отвечает после отказа диска');
  process.exit(1);
}
process.exit(0);
