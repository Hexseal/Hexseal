/**
 * chatRecoveryHygiene.test.ts — структурный гейт: код восстановления не
 * уезжает туда, где его не ждут (Задача 8, свойство 4).
 *
 * ⚠️ ПОЧЕМУ СТРУКТУРНЫЙ, А НЕ ПОВЕДЕНЧЕСКИЙ. Утечку в журнал поведением не
 * поймать: `console.log(code)` работает ровно так же, как отсутствие
 * `console.log(code)`, — экран тот же, тесты те же, разница видна только в
 * консоли того, кто в этот момент смотрел. Единственная проверка, которая
 * это ловит, — чтение исходников.
 *
 * Тот же приём и та же причина, что у `noXmtpImports.test.ts` и
 * `signaturePaths.test.ts`.
 *
 * Список файлов ЯВНЫЙ, а не обход каталога: новый файл, работающий с кодом,
 * обязан быть внесён сюда руками — иначе гейт молча расширился бы на весь
 * `src/` и стал бы про что угодно, кроме кода восстановления.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Всё, что держит код восстановления в руках. */
const HANDLERS = [
  'lib/chatRecovery.ts',
  'components/RecoveryCodeModal.tsx',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

/** Комментарии и строковые литералы выкидываются: гейт про КОД, а не про
 *  слова в комментариях (иначе абзац «не логировать» красил бы сам себя). */
function stripProse(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

describe('код восстановления не утекает — осмотр исходников', () => {
  it.each(HANDLERS)('%s не пишет в журнал вовсе', (rel) => {
    // Красит: любой `console.*` в файле, который держит код. Проверено
    // снятием — добавленный `console.log(code)` красит эту строку.
    const body = stripProse(read(rel));
    expect(body.match(/\bconsole\s*\./g) ?? []).toEqual([]);
  });

  it.each(HANDLERS)('%s не кладёт в localStorage ничего, кроме отметки', (rel) => {
    // В `localStorage` разрешено ровно одно обращение и ровно из одного
    // места — `markRecoveryConfirmed`/`isRecoveryConfirmed` в chatRecovery.ts.
    // Красит: `localStorage.setItem(..., code)` где угодно.
    const body = stripProse(read(rel));
    const calls = body.match(/localStorage\s*\.\s*\w+/g) ?? [];
    if (rel === 'lib/chatRecovery.ts') {
      expect(calls.sort()).toEqual(['localStorage.getItem', 'localStorage.setItem']);
    } else {
      expect(calls).toEqual([]);
    }
  });

  it.each(HANDLERS)('%s не кладёт код в sessionStorage и не шлёт его наружу', (rel) => {
    const body = stripProse(read(rel));
    expect(body).not.toMatch(/sessionStorage/);
    expect(body).not.toMatch(/\bfetch\s*\(/);
    expect(body).not.toMatch(/navigator\s*\.\s*sendBeacon/);
  });

  it.each(HANDLERS)('%s не сериализует код — ни JSON.stringify, ни аналитики', (rel) => {
    const body = stripProse(read(rel));
    expect(body).not.toMatch(/JSON\s*\.\s*stringify/);
  });
});
