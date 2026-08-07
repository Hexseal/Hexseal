/**
 * chatNotices.test.ts — три поля, которые хук считал, а читать было некому.
 *
 * ⚠️ ЧЕМ ЭТО БЫЛО. `usePairChat` честно отдавал `pendingBags`, `bagsFailed` и
 * `pushOutcome`; `grep` по `components/` не находил ни одного из трёх. Это
 * тот же класс, что и код восстановления, который никто не показывал:
 * вычислено, отдано, невидимо. Половина починки «обрыв сети теряет остаток
 * пачки» существовала как ВОЗМОЖНОСТЬ, а не как поведение.
 *
 * Здесь заперты обе развилки, каждая — про РАЗНЫЕ новости:
 *
 *   `pendingBags > 0, bagsFailed = false` — «ещё качаем», очередь за
 *     потолком бюджета. Тревожить нечем;
 *   `bagsFailed = true`                   — «скачать НЕ СМОГЛИ». Другая
 *     новость, и сводить её с первой значило бы либо пугать очередью, либо
 *     молчать об отказе.
 *
 * И три исхода уведомления, которым нужны три разных слова: `no-pass` —
 * «заведите сеанс чата», `rate-limited` — «слишком часто», `error` — «сеть».
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bagsNoticeFor, pushOutcomeKey, PUSH_OUTCOME_KEYS } from './chatNotices';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const MESSAGES_DIR = path.resolve(HERE, '../../messages');
const LOCALES = ['ar', 'de', 'en', 'es', 'fr', 'hi', 'it', 'ja', 'ko', 'pt', 'ru', 'th', 'uk', 'zh-CN'];
const dict = (l: string) => JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, `${l}.json`), 'utf8'));
const pick = (d: unknown, k: string) => k.split('.').reduce<unknown>(
  (a, p) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[p] : undefined), d);
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('невзятые мешки: «ещё качаем» и «не смогли» — разные новости', () => {
  it('ничего не ждёт — плашки нет', () => {
    expect(bagsNoticeFor(0, false)).toBeNull();
  });

  it('очередь без отказов — тихая плашка с ЧИСЛОМ', () => {
    const n = bagsNoticeFor(3, false);
    expect(n).not.toBeNull();
    expect(n!.tone).toBe('quiet');
    expect(n!.count).toBe(3);
  });

  it('⚠️ отказ — ГРОМКАЯ плашка и ДРУГИЕ слова', () => {
    // Красит: сведение двух случаев в один. Тогда человек, у которого
    // скачивание отказало, читал бы «ещё качаем» и ждал бы вечно.
    const failed = bagsNoticeFor(3, true);
    const queued = bagsNoticeFor(3, false);
    expect(failed!.tone).toBe('loud');
    expect(failed!.key).not.toBe(queued!.key);
  });

  it('отказ показывается, даже когда счётчик успел обнулиться', () => {
    // `bagsFailed` живёт своим счётчиком неудач, а не длиной очереди.
    // Красит: условие `pendingBags > 0 && bagsFailed`.
    expect(bagsNoticeFor(0, true)).not.toBeNull();
    expect(bagsNoticeFor(0, true)!.tone).toBe('loud');
  });

  it('отрицательное и дробное число не ломают плашку', () => {
    expect(bagsNoticeFor(-1, false)).toBeNull();
    expect(bagsNoticeFor(2.7, false)!.count).toBe(2);
  });
});

describe('исход уведомления: три случая — три надписи', () => {
  it('⚠️ у каждого исхода СВОЯ надпись', () => {
    // Красит: одна надпись «уведомление не ушло». `no-pass` лечится
    // заведением сеанса, `rate-limited` — ожиданием, `error` — ничем из
    // этого. Три разных действия за одной надписью — три тупика.
    const keys = (['no-pass', 'rate-limited', 'error'] as const).map(o => pushOutcomeKey(o));
    expect(new Set(keys).size).toBe(3);
    for (const k of keys) expect(k).toBeTruthy();
  });

  it('удача и молчание надписи не дают', () => {
    expect(pushOutcomeKey('ok')).toBeNull();
    expect(pushOutcomeKey(null)).toBeNull();
  });

  it('незнакомый исход не роняет и не молчит', () => {
    expect(pushOutcomeKey('что-то новое' as never)).toBeTruthy();
  });
});

describe('надписи есть во всех четырнадцати локалях', () => {
  it('и плашки мешков, и исходы уведомления', () => {
    const keys = new Set<string>([
      ...Object.values(PUSH_OUTCOME_KEYS),
      bagsNoticeFor(1, false)!.key,
      bagsNoticeFor(1, true)!.key,
    ]);
    const missing: string[] = [];
    for (const locale of LOCALES) {
      for (const key of keys) {
        const v = pick(dict(locale), key);
        if (typeof v !== 'string' || v.trim().length === 0) missing.push(`${locale}:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('число невзятых подставляется, а не вписано словом', () => {
    const key = bagsNoticeFor(1, false)!.key;
    const bad: string[] = [];
    for (const locale of LOCALES) {
      if (!String(pick(dict(locale), key)).includes('{n}')) bad.push(locale);
    }
    expect(bad).toEqual([]);
  });
});

describe('три поля наконец читают', () => {
  it('⚠️ панель берёт pendingBags, bagsFailed и pushOutcome', () => {
    // ГЛАВНЫЙ ЗАМОК. До этого `grep` по `components/` не находил ни одного.
    const panel = read('components/ChatPanel.tsx');
    for (const field of ['pendingBags', 'bagsFailed', 'pushOutcome']) {
      expect(panel, field).toContain(field);
    }
    expect(panel).toContain('bagsNoticeFor');
    expect(panel).toContain('pushOutcomeKey');
  });

  it('⚠️ отказ доставки уведомления кто-то слушает', () => {
    // `onPushDeliveryFailure` был заведён исполнителем стойкости и не имел
    // НИ ОДНОГО подписчика в боевом коде — только в тесте. Событие общее,
    // поэтому подписка живёт там, где человек нажимает и ждёт: на досках.
    const boards = ['app/board/page.tsx', 'app/board/executor/page.tsx'];
    for (const rel of boards) {
      expect(read(rel), rel).toContain('onPushDeliveryFailure');
    }
  });

  it('доски берут слова из той же карты, а не пишут свои', () => {
    for (const rel of ['app/board/page.tsx', 'app/board/executor/page.tsx']) {
      expect(read(rel), rel).toContain('pushOutcomeKey');
    }
  });
});
