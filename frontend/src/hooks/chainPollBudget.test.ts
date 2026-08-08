/**
 * ЗАМЕР РАСХОДА НА ОПРОС ЦЕПИ — сколько запросов в минуту просит простаивающая
 * страница, ничего не делая.
 *
 * ОТКУДА ЗАДАЧА. Замер с живого телефона 9 августа 2026 (Redmi по кабелю,
 * счётчик на `fetch` внутри страницы): простаивающая страница чата — 93 запроса
 * к `/api/rpc` за 45 секунд, из них 90 `eth_getFilterChanges` за 40 секунд. Это
 * 135 в минуту, 8 100 в час с ОДНОЙ вкладки. Разбор — `docs/OPEN-ITEMS.md`,
 * пункт 38.
 *
 * ЧТО ЭТОТ ФАЙЛ МЕРИТ, А ЧТО НЕТ. Он считает бюджет опроса по исходникам: сколько
 * ЦИКЛОВ ОПРОСА взводит приложение и с какой частотой каждый. Это не догадка о
 * стоимости — стоимость проверена по коду viem
 * (`node_modules/viem/_esm/actions/public/watchEvent.js`, цикл `poll`): один
 * цикл опроса = РОВНО ОДИН `eth_getFilterChanges` за интервал, плюс один
 * `eth_newFilter` на взводе и один `eth_uninstallFilter` на снятии. Значит
 * «запросов в минуту» = сумма по циклам 60000/интервал, и это ровно то число,
 * которое видит прибор.
 *
 * ⚠️ ЧЕГО ЭТОТ ФАЙЛ НЕ ДОКАЗЫВАЕТ: что уведомления доходят. Он сторожит ЦЕНУ.
 * Что уведомления живы — доказывают `notifRouter.test.ts` (все родá событий
 * доезжают до колокольчика) и `chainWatchGate.test.ts` (скрытая страница молчит,
 * возврат догоняет пропущенное). Один без других бессмыслен: этот файл зелен и
 * при нуле запросов, то есть при полностью сломанных уведомлениях.
 *
 * ⚠️ ИНТЕРВАЛ БЕРЁТСЯ БОЕВОЙ, А НЕ ПОДСТАВЛЕННЫЙ. Цикл без своего
 * `pollingInterval` наследует общий из конфига wagmi, и этот общий читается
 * здесь из `app/providers.tsx` — не задаётся константой в тесте. Ровно на этом
 * месте 4 августа сгорела правка ограничителя: тест подставлял свои значения
 * вместо боевых и остался зелёным на неизменённом коде.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { out.push(...walk(full)); continue; }
    if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const FILES = walk(SRC).map((f) => ({
  path: relative(SRC, f).split(/[\\/]/).join('/'),
  raw: readFileSync(f, 'utf8'),
}));

/**
 * Убрать комментарии. Без этого шага замер врёт: в `useNotifications.ts`
 * слово `useWatchContractEvent` встречается в шапке трижды, и цикл опроса
 * посчитался бы там, где кода нет.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' | 'str' | 'tpl' = 'code';
  let quote = '';
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (mode === 'code') {
      if (two === '//') { mode = 'line'; i += 2; continue; }
      if (two === '/*') { mode = 'block'; i += 2; continue; }
      if (src[i] === '"' || src[i] === "'") { mode = 'str'; quote = src[i]; out += ' '; i++; continue; }
      if (src[i] === '`') { mode = 'tpl'; out += ' '; i++; continue; }
      out += src[i]; i++; continue;
    }
    if (mode === 'line') {
      if (src[i] === '\n') { mode = 'code'; out += '\n'; }
      i++; continue;
    }
    if (mode === 'block') {
      if (two === '*/') { mode = 'code'; i += 2; continue; }
      if (src[i] === '\n') out += '\n';
      i++; continue;
    }
    // строка или шаблон — содержимое замера не касается, но переводы строк храним
    if (src[i] === '\\') { i += 2; continue; }
    if ((mode === 'str' && src[i] === quote) || (mode === 'tpl' && src[i] === '`')) { mode = 'code'; i++; continue; }
    if (src[i] === '\n') out += '\n';
    i++;
  }
  return out;
}

/** Аргумент-объект вызова, начиная с `(` — по парности скобок. */
function objectArg(src: string, callEnd: number): string | null {
  let i = callEnd;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== '{') return null;
  let depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

/** Число из литерала вида `60_000` / `60000`. */
function numeric(lit: string): number | null {
  const n = Number(lit.replace(/_/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Общий интервал опроса из БОЕВОГО конфига wagmi. Все циклы без своего
 * `pollingInterval` наследуют его (viem: `pollingInterval = client.pollingInterval`).
 */
function readWagmiDefaultInterval(): number {
  const providers = FILES.find((f) => f.path === 'app/providers.tsx');
  expect(providers, 'app/providers.tsx исчез — замер потерял боевой интервал').toBeDefined();
  const code = stripComments(providers!.raw);
  const found = [...code.matchAll(/pollingInterval:\s*([0-9_]+)/g)]
    .map((m) => numeric(m[1]))
    .filter((n): n is number => n !== null);
  expect(found.length, 'в providers.tsx не найден pollingInterval конфига wagmi').toBeGreaterThan(0);
  // Конфигов два (с projectId и без), интервал в них обязан быть один — иначе
  // замер не знает, какой боевой.
  expect(new Set(found).size, `в providers.tsx разные pollingInterval: ${found.join(', ')}`).toBe(1);
  return found[0];
}

export interface PollLoop {
  file: string;
  /** Как взведён: хук wagmi или прямой вызов viem. */
  via: string;
  intervalMs: number;
  /** Интервал свой или унаследован от конфига. */
  ownInterval: boolean;
  /** Есть ли у цикла выключатель (`enabled`) вообще. */
  hasEnabled: boolean;
}

/**
 * Найти все циклы опроса логов цепи. Считаются обе формы, которыми это можно
 * завести: хук wagmi `useWatchContractEvent` и прямой вызов viem
 * `watchEvent` / `watchContractEvent` у клиента.
 */
function findPollLoops(): PollLoop[] {
  const dflt = readWagmiDefaultInterval();
  const loops: PollLoop[] = [];
  const CALL = /(?:\.)?(useWatchContractEvent|watchContractEvent|watchEvent)\s*\(/g;
  for (const f of FILES) {
    const code = stripComments(f.raw);
    for (const m of code.matchAll(CALL)) {
      const arg = objectArg(code, m.index! + m[0].length);
      if (arg === null) continue; // не вызов с объектом (импорт, тип, реэкспорт)
      const own = arg.match(/pollingInterval:\s*([A-Za-z0-9_$.]+)/);
      let intervalMs = dflt;
      let ownInterval = false;
      if (own) {
        const lit = numeric(own[1]);
        if (lit !== null) { intervalMs = lit; ownInterval = true; }
        else {
          // Интервал задан именем — развернуть по объявлению константы в проекте.
          const name = own[1].split('.').pop()!;
          for (const g of FILES) {
            const decl = stripComments(g.raw).match(
              new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*([0-9_]+)`),
            );
            const v = decl ? numeric(decl[1]) : null;
            if (v !== null) { intervalMs = v; ownInterval = true; break; }
          }
          expect(ownInterval, `не удалось развернуть pollingInterval: ${own[1]} в ${f.path}`).toBe(true);
        }
      }
      loops.push({
        file: f.path,
        via: m[1],
        intervalMs,
        ownInterval,
        // И `enabled: x`, и сокращённая запись `enabled,` — вторая живёт в
        // `useDealLiveRefresh.ts`, и без неё замер соврал бы «выключателя нет».
        hasEnabled: /\benabled\s*[,:}]/.test(arg),
      });
    }
  }
  return loops;
}

/** Запросов к цепи в минуту от всех циклов, взведённых одновременно. */
function requestsPerMinute(loops: PollLoop[]): number {
  return loops.reduce((sum, l) => sum + 60_000 / l.intervalMs, 0);
}

/**
 * Потолок. Прибор показал 135 в минуту; целимся в РАЗЫ, а не проценты, поэтому
 * потолок — единицы запросов, а не десятки. 6 в минуту это интервал 10 секунд у
 * одного цикла либо 20 секунд у двух (страница сделки: уведомления + живое
 * обновление самой сделки).
 */
const BUDGET_PER_MINUTE = 6;

describe('расход на опрос цепи — замер по боевым исходникам', () => {
  it('циклы опроса найдены и интервал у каждого известен', () => {
    const loops = findPollLoops();
    // Если инструмент не нашёл ни одного цикла — он врёт в сторону зелёного, а
    // это ровно тот класс промаха, ради которого файл заведён.
    expect(loops.length, 'ни одного цикла опроса не найдено — инструмент сломан').toBeGreaterThan(0);
    for (const l of loops) expect(l.intervalMs).toBeGreaterThan(0);
  });

  it('простаивающая страница просит у цепи не больше 6 раз в минуту', () => {
    const loops = findPollLoops();
    const perMin = requestsPerMinute(loops);
    const detail = loops
      .map((l) => `${l.file} (${l.via}, ${l.intervalMs} мс${l.ownInterval ? '' : ' — унаследован'})`)
      .join('\n  ');
    expect(
      perMin,
      `циклов опроса: ${loops.length}, запросов в минуту: ${perMin}\n  ${detail}`,
    ).toBeLessThanOrEqual(BUDGET_PER_MINUTE);
  });

  it('у каждого цикла есть выключатель — иначе скрытую страницу нечем заглушить', () => {
    const without = findPollLoops().filter((l) => !l.hasEnabled).map((l) => `${l.file} (${l.via})`);
    expect(without, 'цикл опроса без `enabled` невозможно остановить на скрытой странице').toEqual([]);
  });
});
