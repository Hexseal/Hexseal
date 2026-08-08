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
  it('⚠️ панель РАСПАКОВЫВАЕТ три поля из хука, а не просто упоминает их', () => {
    // ГЛАВНЫЙ ЗАМОК. До этого `grep` по `components/` не находил ни одного.
    //
    // ⚠️ Сверяется САМА РАСПАКОВКА. Первая версия искала имена где угодно в
    // файле и осталась зелёной, когда мутация выбросила строку из
    // деструктуризации: имена остались в вызове `bagsNoticeFor(pendingBags,
    // …)` ниже (мутация М-52 прошла незамеченной).
    const panel = read('components/ChatPanel.tsx');
    const unpack = panel.slice(panel.indexOf('} = usePairChat(') - 2000, panel.indexOf('} = usePairChat('));
    for (const field of ['pendingBags', 'bagsFailed', 'pushOutcome']) {
      expect(unpack, `${field} не распакован из usePairChat`).toContain(field);
    }
    expect(panel).toMatch(/bagsNoticeFor\(\s*pendingBags\s*,\s*bagsFailed\s*\)/);
    expect(panel).toMatch(/pushOutcomeKey\(\s*pushOutcome\s*\)/);
  });

  it('⚠️ подписка стоит ТАМ, КУДА СОБЫТИЕ ПРИХОДИТ, а не где придётся', () => {
    // ⚠️ ЗАМЕР сквозной проверки: сначала подписка стояла на двух досках, а
    // уведомления отправляет РОВНО ОДНО место — `notifyPush` из
    // `usePairChat`. На доски событие не приходило никогда: подписчик был,
    // события не было. Замок «кто-то слушает» этого не видел, потому что
    // спрашивал про наличие вызова, а не про то, долетит ли до него хоть
    // что-нибудь.
    //
    // Теперь слушает общая обёртка: она на КАЖДОЙ странице и держит
    // `Toaster`. Не сам чат — отправка «пожар и забыл», и к моменту отказа
    // вкладка может уже уйти со страницы переписки.
    const layout = read('app/client-layout.tsx');
    expect(layout).toMatch(/onPushDeliveryFailure\(\s*\(/);
    expect(layout).toMatch(/pushOutcomeKey\(/);
  });

  it('⚠️ отправитель уведомлений ровно один — иначе подписка снова не там', () => {
    // Красит: появление второго отправителя. Тогда общая обёртка перестанет
    // быть достаточной, и это надо заметить, а не узнать от человека.
    const fsx = fs.readdirSync(path.join(SRC, 'hooks'))
      .filter(f => f.endsWith('.ts') && !f.includes('.test.'));
    const senders: string[] = [];
    for (const f of [...fsx.map(f => `hooks/${f}`), 'lib/chatConversation.ts']) {
      const body = read(f);
      if (/\bnotifyPush\(/.test(body)) senders.push(f);
    }
    expect(senders).toEqual(['hooks/usePairChat.ts']);
  });

  it('доски НЕ подписаны — событие туда не приходит', () => {
    // Обратная сторона: подписка там была ложью, и возвращать её нельзя.
    for (const rel of ['app/board/page.tsx', 'app/board/executor/page.tsx']) {
      expect(read(rel), rel).not.toMatch(/onPushDeliveryFailure/);
    }
  });
});
