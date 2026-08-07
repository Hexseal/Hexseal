import { describe, it, expect, vi, afterEach } from 'vitest';

// ─── Сквозная проверка перед слиянием, 8 августа ────────────────────────────
//
// Перебор ручек на негодные значения (В-5) пропустил две, и обе проваливаются
// в одну и ту же сторону: значение принимается МОЛЧА и выключает ровно то,
// ради чего ручка заведена.
//
//   RPC_TIMEOUT_MS=0 — ethers понимает нулевой таймаут как «ждать без конца»
//     (проверено: fr.timeout = 0 принимается без возражений). То есть ручка,
//     заведённая против зависшего узла, при 0 своё же лекарство и отменяет:
//     один повисший вызов вешает весь ночной прогон целиком.
//
//   PORT с опечаткой — Node видит нечисловую строку как ПУТЬ К UNIX-СОКЕТУ.
//     Замер на обычной ФС: PORT=3O01 (буква O вместо нуля) → сервер
//     поднимается, обратный вызов listen срабатывает, в журнале «запустился»,
//     а снаружи по TCP его нет вовсе. PORT=0 — свой сорт того же: Node
//     выдаёт СЛУЧАЙНЫЙ свободный порт (замерено: 32843), обратный прокси
//     туда не попадёт никогда.
//
// Проверяем импортом настоящего app.js с подменённым окружением: отказ обязан
// случиться ПРИ СТАРТЕ и назвать переменную, а не проявиться мёртвым сервером
// с зелёным журналом.
const saved = {};
function setEnv(patch) {
  for (const k of Object.keys(patch)) {
    if (!(k in saved)) saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
}

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(saved)) delete saved[k];
  vi.resetModules();
  await import('../app.js');
});

describe('RPC_TIMEOUT_MS — нулевое значение выключает таймаут, значит отвергается при старте', () => {
  for (const bad of ['0', '-1', 'abc']) {
    it(`RPC_TIMEOUT_MS=${JSON.stringify(bad)} — громкий отказ, переменная названа`, async () => {
      setEnv({ RPC_TIMEOUT_MS: bad });
      vi.resetModules();
      await expect(import('../app.js')).rejects.toThrow(/RPC_TIMEOUT_MS/);
    });
  }

  it('пустое значение — законное «пользуйся умолчанием»', async () => {
    setEnv({ RPC_TIMEOUT_MS: '' });
    vi.resetModules();
    const fresh = await import('../app.js');
    expect(fresh.relayerInfo.rpcTimeoutMs).toBe(20000);
  });
});

describe('PORT — опечатка не имеет права поднять сервер на UNIX-сокете', () => {
  // 0 в списке НЕТ намеренно: это осмысленное «дай любой свободный порт»,
  // которым пользуются тесты, а не опечатка. Запрет сломал бы намеренный
  // приём — поймано ровно так: правка уронила test/noXmtpBoot.test.js,
  // который поднимает настоящий процесс с PORT=0, чтобы не драться за номер.
  // Опасность нуля не в значении, а в журнале — закрыто в index.js.
  for (const bad of ['3O01', 'port3001', '-1', '99999', '3001.5']) {
    it(`PORT=${JSON.stringify(bad)} — громкий отказ, переменная названа`, async () => {
      setEnv({ PORT: bad });
      vi.resetModules();
      await expect(import('../app.js')).rejects.toThrow(/PORT/);
    });
  }

  it('нормальный порт принимается как число, а не как строка', async () => {
    setEnv({ PORT: '3005' });
    vi.resetModules();
    const fresh = await import('../app.js');
    expect(fresh.relayerInfo.port).toBe(3005);
  });

  it('0 — законное «любой свободный порт», не отказ', async () => {
    setEnv({ PORT: '0' });
    vi.resetModules();
    const fresh = await import('../app.js');
    expect(fresh.relayerInfo.port).toBe(0);
  });

  it('пустое значение — умолчание 3001', async () => {
    setEnv({ PORT: '' });
    vi.resetModules();
    const fresh = await import('../app.js');
    expect(fresh.relayerInfo.port).toBe(3001);
  });
});
