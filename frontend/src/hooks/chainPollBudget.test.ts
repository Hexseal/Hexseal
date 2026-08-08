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
  /** Заведён ли цикл под `runChainWatch` — единственным замеренным остановом. */
  underGate: boolean;
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
      // Чем этот цикл можно остановить. У хука wagmi это `enabled` (и `enabled: x`,
      // и сокращённая запись `enabled,`). У прямого вызова viem такого поля нет
      // вовсе — там останов делает `runChainWatch`, и признак этого — что вызов
      // стоит в свойстве `watch:` его же ввода-вывода.
      const before = code.slice(Math.max(0, m.index! - 200), m.index!);
      loops.push({
        file: f.path,
        via: m[1],
        intervalMs,
        ownInterval,
        hasEnabled: /\benabled\s*[,:}]/.test(arg),
        underGate: /\bwatch:\s*\(/.test(before) && /\brunChainWatch\s*\(/.test(code),
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
 * ТРИ ПРАВИЛА, ВЫВЕДЕННЫЕ ИЗ ЗАМЫСЛА, А НЕ ИЗ ПОЛУЧЕННОГО ЧИСЛА.
 *
 *  - циклов на страницу не больше двух: общий колокольчик плюс один живой экран
 *    самой страницы. Третий цикл означает, что кто-то снова завёл слежение
 *    рядом, вместо того чтобы добавить род события в общий набор;
 *  - такт не чаще десяти секунд: быстрее человеку незаметно, а платит владелец;
 *  - и РАТЧЕТ: не хуже уже добытого. 8 в минуту — замер на этой ветке (было 140).
 *    Это не цель, а храповик: любое ухудшение краснеет.
 */
const MAX_LOOPS = 2;
const MIN_INTERVAL_MS = 10_000;
const BUDGET_PER_MINUTE = 8;

describe('расход на опрос цепи — замер по боевым исходникам', () => {
  it('циклы опроса найдены и интервал у каждого известен', () => {
    const loops = findPollLoops();
    // Если инструмент не нашёл ни одного цикла — он врёт в сторону зелёного, а
    // это ровно тот класс промаха, ради которого файл заведён.
    expect(loops.length, 'ни одного цикла опроса не найдено — инструмент сломан').toBeGreaterThan(0);
    for (const l of loops) expect(l.intervalMs).toBeGreaterThan(0);
  });

  it('циклов опроса не больше двух и такт не чаще десяти секунд', () => {
    const loops = findPollLoops();
    const detail = loops.map((l) => `${l.file} (${l.via}, ${l.intervalMs} мс)`).join('\n  ');
    expect(loops.length, `циклов: ${loops.length}\n  ${detail}`).toBeLessThanOrEqual(MAX_LOOPS);
    const tooFast = loops.filter((l) => l.intervalMs < MIN_INTERVAL_MS)
      .map((l) => `${l.file}: ${l.intervalMs} мс`);
    expect(tooFast, 'такт чаще десяти секунд').toEqual([]);
  });

  it('простаивающая страница просит у цепи не больше 8 раз в минуту (было 140)', () => {
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

  it('каждый цикл заглушается на скрытой странице — своим `enabled` или воротами', () => {
    // ⚠️ ЧТО ЭТОТ ЗАМОК ДОКАЗЫВАЕТ, А ЧТО НЕТ. Он доказывает, что цикл опроса
    // ЗАВЕДЁН под механизмом, у которого останов есть. Что этот останов
    // действительно даёт ноль запросов на скрытой странице — доказано отдельно и
    // поведением: `lib/chainWatchGate.test.ts` считает запросы до и после
    // сворачивания. Один без другого бессмыслен: этот замок зелен и при
    // сломанных воротах, а тот — при цикле, заведённом рядом с воротами.
    const orphans = findPollLoops()
      .filter((l) => !l.hasEnabled && !l.underGate)
      .map((l) => `${l.file} (${l.via})`);
    expect(orphans, 'цикл опроса нечем остановить на скрытой странице').toEqual([]);
  });

  it('слежение за цепью заводится ТОЛЬКО через ворота видимости', () => {
    // `useWatchContractEvent` идёт мимо ворот: его `enabled` пришлось бы
    // связывать с видимостью в каждом месте заново, и один пропущенный вызов
    // возвращал бы круглосуточный опрос целиком. Тринадцать таких вызовов и дали
    // 140 запросов в минуту.
    const viaWagmiHook = findPollLoops().filter((l) => l.via === 'useWatchContractEvent');
    expect(viaWagmiHook.map((l) => l.file), 'слежение мимо ворот видимости').toEqual([]);

    const outsideGate = findPollLoops().filter((l) => !l.underGate).map((l) => l.file);
    expect(outsideGate, 'цикл опроса не под runChainWatch').toEqual([]);
  });
});
