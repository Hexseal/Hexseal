/**
 * К-1 — кошелёк-контракт не может пользоваться чатом ВООБЩЕ.
 *
 * Родов кошельков на Base четыре (docs/superpowers/specs/2026-08-02-e2e-chat-
 * design.md, таблица в §4). Два из них подписывают НЕ 65 байтами:
 *
 *   - развёрнутый кошелёк-контракт (Safe)            — ERC-1271, есть код на цепи
 *   - счётный смарт-кошелёк (Coinbase до первой tx)  — обёртка ERC-6492, кода НЕТ
 *
 * Выдача пропуска (`POST /bags/pass`) проверяла подпись ТОЛЬКО через
 * `ethers.verifyMessage` — то есть через ecrecover, который по определению
 * работает лишь с обычной 65-байтовой подписью. Значит владелец Safe заводил
 * сеанс, получал ключ, шифровал сообщение — и не мог ни выложить мешок, ни
 * скачать его: пропуска ему не давали никогда.
 *
 * Здесь заперты обе половины: что контрактные роды пропуск ПОЛУЧАЮТ, и что
 * цена этого не легла на обычный кошелёк (у него проверка местная, сети не
 * требует — замер числом ниже).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Тот же приём, что bagRoutes.test.js: маленькие бюджеты, выставленные ДО
// динамического import('../app.js'), иначе тест границы гоняет боевые
// десятки-сотни запросов.
process.env.BAG_PASS_RATE_MAX  = '50';
process.env.BAG_IP_RATE_MAX    = '200';
process.env.BAG_PASS_CHAIN_RATE_MAX = '5';
// Боевое терпение — секунды; тест на «узел молчит» ждал бы их по-настоящему.
process.env.CONTRACT_SIG_TIMEOUT_MS = '400';

const { app, UNIVERSAL_SIG_VALIDATOR_BYTECODE } = await import('../app.js');
const { bagPassChallenge, verifyBagPass } = await import('../bagPass.js');
const { providerMocks, mockProviderCall } = await import('./mocks/ethersRegistry.js');

let _ipCounter = 0;
function freshIp() {
  _ipCounter++;
  return `172.${(_ipCounter >> 16) & 255}.${(_ipCounter >> 8) & 255}.${_ipCounter & 255}`;
}

const ERC6492_SUFFIX = '6492649264926492649264926492649264926492649264926492649264926492';

/** Подпись развёрнутого кошелька-контракта: произвольной длины, не 65 байт. */
function safeStyleSignature() {
  return '0x' + 'ab'.repeat(200);
}

/** Обёртка ERC-6492 вокруг внутренней подписи: abi.encode(factory, factoryCalldata, sig) ‖ магия. */
function erc6492Signature(factory, innerSig) {
  const body = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'bytes', 'bytes'],
    [factory, '0xdeadbeef', innerSig],
  );
  return ethers.concat([body, '0x' + ERC6492_SUFFIX]);
}

async function postPass({ address, sig, ts, ip }) {
  const nowSec = ts ?? Math.floor(Date.now() / 1000);
  return request(app)
    .post('/bags/pass')
    .set('CF-Connecting-IP', ip ?? freshIp())
    .set('x-ts', String(nowSec))
    .set('x-sig', sig)
    .send({ address });
}

describe('К-1: пропуск склада и четыре рода кошельков', () => {
  beforeEach(() => {
    mockProviderCall(async () => '0x00');
  });

  describe('обычный кошелёк (EOA) — местная проверка, без сети', () => {
    it('получает пропуск и НЕ делает НИ ОДНОГО обращения к цепи (замер)', async () => {
      const wallet = ethers.Wallet.createRandom();
      const addr   = wallet.address.toLowerCase();
      const ts     = Math.floor(Date.now() / 1000);
      const sig    = await wallet.signMessage(bagPassChallenge(addr, ts));

      const calls = [];
      mockProviderCall(async (tx) => { calls.push(tx); return '0x01'; });

      const res = await postPass({ address: addr, sig, ts });

      expect(res.status).toBe(200);
      expect(verifyBagPass(res.body.pass)).toEqual({ address: addr });
      // ЗАМЕР: ноль. Отказ узла цепи не имеет права стоить обычному кошельку чата.
      expect(calls.length).toBe(0);
    });

    it('узел цепи лежит — обычный кошелёк всё равно получает пропуск', async () => {
      const wallet = ethers.Wallet.createRandom();
      const addr   = wallet.address.toLowerCase();
      const ts     = Math.floor(Date.now() / 1000);
      const sig    = await wallet.signMessage(bagPassChallenge(addr, ts));

      mockProviderCall(async () => { throw new Error('RPC node is down (test)'); });

      const res = await postPass({ address: addr, sig, ts });
      expect(res.status).toBe(200);
    });
  });

  describe('развёрнутый кошелёк-контракт (Safe, ERC-1271)', () => {
    it('подпись, которую контракт признаёт, даёт пропуск на тот самый адрес', async () => {
      const addr = '0x1111111111111111111111111111111111111112';
      mockProviderCall(async () => '0x01');

      const res = await postPass({ address: addr, sig: safeStyleSignature() });

      expect(res.status).toBe(200);
      expect(verifyBagPass(res.body.pass)).toEqual({ address: addr });
    });

    it('проверку делает СВОЙ валидатор по СВОЕЙ фразе — адрес, хеш и подпись доехали', async () => {
      const addr = '0x1111111111111111111111111111111111111113';
      const sig  = safeStyleSignature();
      const ts   = Math.floor(Date.now() / 1000);

      let seen = null;
      mockProviderCall(async (tx) => { seen = tx; return '0x01'; });

      const res = await postPass({ address: addr, sig, ts });
      expect(res.status).toBe(200);

      // Развёрнутого контракта у вызова нет — это deployless-вызов: `to` пуст.
      expect(seen.to ?? null).toBe(null);
      expect(seen.data.startsWith(UNIVERSAL_SIG_VALIDATOR_BYTECODE)).toBe(true);

      const args = '0x' + seen.data.slice(UNIVERSAL_SIG_VALIDATOR_BYTECODE.length);
      const [signer, hash, passedSig] = ethers.AbiCoder.defaultAbiCoder().decode(
        ['address', 'bytes32', 'bytes'], args,
      );
      expect(signer.toLowerCase()).toBe(addr);
      expect(hash).toBe(ethers.hashMessage(bagPassChallenge(addr, ts)));
      expect(passedSig).toBe(sig);
    });

    it('подпись, которую контракт НЕ признал, пропуска не даёт', async () => {
      const addr = '0x1111111111111111111111111111111111111114';
      mockProviderCall(async () => '0x00');

      const res = await postPass({ address: addr, sig: safeStyleSignature() });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_signature');
    });
  });

  describe('счётный смарт-кошелёк (Coinbase до первой транзакции, ERC-6492)', () => {
    it('обёрнутая подпись без кода на цепи даёт пропуск', async () => {
      const addr    = '0x1111111111111111111111111111111111111115';
      const factory = '0x2222222222222222222222222222222222222223';
      const sig     = erc6492Signature(factory, '0x' + 'cd'.repeat(65));

      mockProviderCall(async () => '0x01');

      const res = await postPass({ address: addr, sig });
      expect(res.status).toBe(200);
      expect(verifyBagPass(res.body.pass)).toEqual({ address: addr });
    });

    it('обёртка доезжает до валидатора ЦЕЛИКОМ (её разбирает он, не мы)', async () => {
      const addr    = '0x1111111111111111111111111111111111111116';
      const factory = '0x2222222222222222222222222222222222222224';
      const sig     = erc6492Signature(factory, '0x' + 'cd'.repeat(65));

      let seen = null;
      mockProviderCall(async (tx) => { seen = tx; return '0x01'; });

      await postPass({ address: addr, sig });

      const args = '0x' + seen.data.slice(UNIVERSAL_SIG_VALIDATOR_BYTECODE.length);
      const [, , passedSig] = ethers.AbiCoder.defaultAbiCoder().decode(
        ['address', 'bytes32', 'bytes'], args,
      );
      expect(passedSig).toBe(sig);
      expect(passedSig.endsWith(ERC6492_SUFFIX)).toBe(true);
    });
  });

  describe('отказ узла цепи — не то же самое, что негодная подпись', () => {
    it('узел лежит → 503 chain_unavailable, а не 401 (переподписывать нечего)', async () => {
      const addr = '0x1111111111111111111111111111111111111117';
      mockProviderCall(async () => { throw new Error('RPC node is down (test)'); });

      const res = await postPass({ address: addr, sig: safeStyleSignature() });

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('chain_unavailable');
    });

    it('узел молчит дольше нашего терпения → 503, а не зависший запрос', async () => {
      const addr = '0x1111111111111111111111111111111111111118';
      mockProviderCall(() => new Promise(() => {}));   // никогда не разрешается

      const started = Date.now();
      const res = await postPass({ address: addr, sig: safeStyleSignature() });
      const elapsed = Date.now() - started;

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('chain_unavailable');
      // Терпение задаётся CONTRACT_SIG_TIMEOUT_MS; в тесте оно сокращено
      // (см. env выше), но здесь важно лишь то, что оно КОНЕЧНО и заметно
      // меньше 20-секундного таймаута самого RPC-соединения.
      expect(elapsed).toBeLessThan(15_000);
    });
  });

  describe('долбят нарочно: мусорные контрактные подписи не жгут узел цепи без предела', () => {
    it('свой бюджет обращений к цепи, отдельный от бюджета обычных кошельков', async () => {
      const ip = freshIp();
      let chainCalls = 0;
      mockProviderCall(async () => { chainCalls++; return '0x00'; });

      const statuses = [];
      for (let i = 0; i < 8; i++) {
        const res = await postPass({
          address: '0x111111111111111111111111111111111111111' + (i % 10),
          sig: safeStyleSignature(),
          ip,
        });
        statuses.push(res.status);
      }

      // BAG_PASS_CHAIN_RATE_MAX=5 (выставлен выше): пять обращений к цепи,
      // дальше — отказ ДО обращения.
      expect(chainCalls).toBe(5);
      expect(statuses.slice(0, 5).every(s => s === 401)).toBe(true);
      expect(statuses.slice(5).every(s => s === 429)).toBe(true);
    });

    it('исчерпанный бюджет цепи НЕ мешает обычному кошельку с того же адреса выхода', async () => {
      const ip = freshIp();
      mockProviderCall(async () => '0x00');

      for (let i = 0; i < 8; i++) {
        await postPass({ address: '0x111111111111111111111111111111111111112' + (i % 10), sig: safeStyleSignature(), ip });
      }

      const wallet = ethers.Wallet.createRandom();
      const addr   = wallet.address.toLowerCase();
      const ts     = Math.floor(Date.now() / 1000);
      const sig    = await wallet.signMessage(bagPassChallenge(addr, ts));

      const res = await postPass({ address: addr, sig, ts, ip });
      expect(res.status).toBe(200);
    });
  });

  describe('пришёл мусор — вердикт, а не падение и не поход в цепь', () => {
    // Кириллица сюда НЕ годится специально: заголовок с не-latin1 символами
    // отвергает сам Node на стороне клиента ("Invalid character in header
    // content"), до сервера он не доезжает вообще — такой кейс проверял бы
    // не нас, а http-стек.
    it.each([
      ['не шестнадцатеричная строка', 'not-a-signature'],
      ['пустая подпись (0x)',         '0x'],
      ['нечётное число полубайт',     '0xabc'],
      ['одна буква',                  'x'],
    ])('%s → 401, и узел цепи не тревожили', async (_name, sig) => {
      let chainCalls = 0;
      // Мок нарочно ЩЕДРЫЙ («контракт признал»): если мусор доедет до цепи,
      // он получит 200, и тест это увидит. Так проверяется именно то, что он
      // ДО цепи не доезжает, а не то, что цепь его отвергла за нас.
      mockProviderCall(async () => { chainCalls++; return '0x01'; });

      const res = await postPass({ address: '0x4444444444444444444444444444444444444444', sig });

      expect(res.status).toBe(401);
      expect(chainCalls).toBe(0);
    });
  });

  describe('ЗАМЕР: чего стоит проверка', () => {
    it('обычный кошелёк — цена местная, обращений к цепи ноль на сто выдач', async () => {
      let chainCalls = 0;
      mockProviderCall(async () => { chainCalls++; return '0x01'; });

      const wallets = await Promise.all(
        Array.from({ length: 20 }, () => ethers.Wallet.createRandom()),
      );

      const started = Date.now();
      for (const w of wallets) {
        const addr = w.address.toLowerCase();
        const ts   = Math.floor(Date.now() / 1000);
        const sig  = await w.signMessage(bagPassChallenge(addr, ts));
        const res  = await postPass({ address: addr, sig, ts });
        expect(res.status).toBe(200);
      }
      const elapsed = Date.now() - started;

      console.log(`[замер К-1] 20 выдач пропуска обычному кошельку: ${elapsed} мс, обращений к цепи ${chainCalls}`);
      expect(chainCalls).toBe(0);
    });

    it('контрактный кошелёк — РОВНО одно обращение к цепи на выдачу, не два', async () => {
      let chainCalls = 0;
      mockProviderCall(async () => { chainCalls++; return '0x01'; });

      for (let i = 0; i < 5; i++) {
        const res = await postPass({
          address: '0x333333333333333333333333333333333333333' + i,
          sig: safeStyleSignature(),
        });
        expect(res.status).toBe(200);
      }

      console.log(`[замер К-1] 5 выдач контрактному кошельку: обращений к цепи ${chainCalls}`);
      expect(chainCalls).toBe(5);
    });
  });

  describe('происхождение байткода валидатора', () => {
    it('совпадает байт в байт с тем, что везёт viem (канонический ERC-6492)', () => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const viemFile = path.join(here, '../../frontend/node_modules/viem/_esm/constants/contracts.js');
      if (!fs.existsSync(viemFile)) {
        // Зависимости фронта не установлены — проверять нечем; молча пройти
        // нельзя, но и падать не за что: это проверка происхождения, а не поведения.
        console.warn('[К-1] viem не установлен — сверка происхождения байткода пропущена');
        return;
      }
      const src = fs.readFileSync(viemFile, 'utf8');
      const m = src.match(/universalSignatureValidatorByteCode\s*=\s*'(0x[0-9a-fA-F]+)'/);
      expect(m).not.toBeNull();
      expect(UNIVERSAL_SIG_VALIDATOR_BYTECODE).toBe(m[1]);
    });
  });
});
