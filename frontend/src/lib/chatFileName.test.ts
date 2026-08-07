/**
 * chatFileName.test.ts — имя вложения из чужих рук.
 *
 * ЧТО НАШЛА ВРАЖДЕБНАЯ ПРОВЕРКА. `sanitizePayload` проверяла у имени файла
 * ровно одно: что это строка. Дальше имя ехало на экран и в атрибут скачивания
 * как есть — вместе с символом переворота направления письма (U+202E, RLO),
 * которым `счёт.exe` показывается человеку как `счёт.pdf`.
 *
 * ⚠️ ОТОБРАЖЕНИЕ — ЧУЖАЯ ЗОНА, ГЕЙТ — НАША. Панель и браузер обязаны рисовать
 * то, что им дали; спорить с направлением письма на уровне вёрстки — гонка,
 * которую не выиграть (каждый новый элемент придётся чинить заново). Правильное
 * место одно: не пропустить такое имя ДАЛЬШЕ РАЗБОРА, здесь.
 *
 * ⚠️ ПОЧЕМУ ИМЯ ЧИСТИТСЯ, А НЕ ОТВЕРГАЕТСЯ ВМЕСТЕ С СООБЩЕНИЕМ. Остальные
 * гейты этого модуля на испорченном знакомом поле возвращают `null` — отказ
 * всему сообщению. Здесь это было бы хуже: имя файла это НЕ форма (строка и
 * есть строка), а содержимое, и отказ означал бы, что у получателя вложение
 * ПРОПАЛО — то есть дыра в переписке за то, что отправитель назвал файл
 * странно. Собеседник видит дыру и не может отличить её от утаивания.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeFileName, sanitizePayload } from './chatPayloadForm';

/** Как имя выглядит ГЛАЗАМИ: всё после переворота читается справа налево.
 *  Грубая, но честная модель — ровно тот эффект, ради которого RLO и ставят. */
function asRendered(name: string): string {
  const at = name.indexOf('\u202E');
  if (at === -1) return name;
  return name.slice(0, at) + [...name.slice(at + 1)].reverse().join('');
}

const BASE = { url: 'https://x/1', name: 'счёт.pdf', size: 10, keyHex: 'aa', ivHex: 'bb' };

describe('имя вложения: переворот направления письма', () => {
  it('ЗАМЕР: «счёт.exe» больше не показывается как «счёт.pdf»', () => {
    // Настоящая заготовка нападения: после RLO хвост читается наоборот, и
    // `fdp.exe` превращается на экране в `exe.pdf`.
    const hostile = 'счёт\u202Efdp.exe';
    const rendered = asRendered(hostile);
    const cleaned = sanitizeFileName(hostile);

    console.info(
      `[мелочь замер] прислано: ${JSON.stringify(hostile)}; ` +
      `видно человеку: «${rendered}»; после чистки: «${cleaned}» (видно: «${asRendered(cleaned)}»)`,
    );

    // Пока символ на месте, показанное расширение НЕ равно настоящему.
    expect(rendered.endsWith('.exe')).toBe(false);
    // После чистки показанное и настоящее — одно и то же.
    expect(asRendered(cleaned)).toBe(cleaned);
    expect(cleaned.endsWith('.exe')).toBe(true);
  });

  it('вычищаются ВСЕ управляющие направлением и невидимые, а не один U+202E', () => {
    // Что красит: вычистка одного только U+202E. Каждый из этих символов
    // делает то же самое — своим способом.
    const sneaky = [
      '\u202A', '\u202B', '\u202C', '\u202D', '\u202E', // embedding/override
      '\u2066', '\u2067', '\u2068', '\u2069',           // isolate
      '\u200E', '\u200F', '\u061C',                     // marks
      '\u200B', '\u200C', '\u200D', '\uFEFF',           // нулевой ширины
      '\u0000', '\u0007', '\u001B', '\u007F',           // управляющие
    ];
    for (const ch of sneaky) {
      const cleaned = sanitizeFileName(`а${ch}б.txt`);
      expect(cleaned, `символ ${ch.codePointAt(0)?.toString(16)} остался`).toBe('аб.txt');
    }
  });

  it('перевод строки внутри имени не разрывает его на два', () => {
    expect(sanitizeFileName('счёт\nОТ БАНКА.pdf')).toBe('счётОТ БАНКА.pdf');
    expect(sanitizeFileName('счёт\r\n.pdf')).toBe('счёт.pdf');
  });

  it('путь в имени схлопывается до имени файла', () => {
    // Атрибут скачивания браузеры и так режут до имени, но полагаться на это
    // нельзя: имя едет ещё и на экран, и в будущий путь сохранения.
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Windows\\system32\\cmd.exe')).toBe('cmd.exe');
    expect(sanitizeFileName('/')).toBe('file');
    expect(sanitizeFileName('..')).toBe('file');
    expect(sanitizeFileName('.')).toBe('file');
  });

  it('пустое и пробельное имя получает опору, а не пустоту', () => {
    expect(sanitizeFileName('')).toBe('file');
    expect(sanitizeFileName('   ')).toBe('file');
    expect(sanitizeFileName('\u202E\u202E')).toBe('file');
  });

  it('ЗАМЕР: имя длиной в сто тысяч символов обрезается', () => {
    // Вопрос «что если этого станет очень много»: имя едет на экран и в
    // атрибут, и сто тысяч символов там — это не имя, а способ сломать вёрстку.
    const huge = 'а'.repeat(100_000) + '.pdf';
    const cleaned = sanitizeFileName(huge);
    console.info(`[мелочь замер] длина имени: ${huge.length} → ${cleaned.length}`);
    expect(cleaned.length).toBeLessThanOrEqual(200);
    // Расширение переживает обрезку — по нему человек и решает, открывать ли.
    expect(cleaned.endsWith('.pdf')).toBe(true);
  });

  it('обычное имя не трогается вовсе', () => {
    expect(sanitizeFileName('Договор №12 (правки).pdf')).toBe('Договор №12 (правки).pdf');
    expect(sanitizeFileName('photo_2026-08-07.jpeg')).toBe('photo_2026-08-07.jpeg');
  });

  it('гейт разбора отдаёт УЖЕ вычищенное имя, а не исходное', () => {
    // Главное: чистка стоит НА ПУТИ, а не рядом с ним. Экспортированная
    // функция, которую никто не зовёт, — это не защита.
    const out = sanitizePayload({ file: { ...BASE, name: 'счёт\u202Efdp.exe' } });
    expect(out?.file?.name).toBe('счётfdp.exe');
    expect(out?.file?.name).not.toContain('\u202E');
  });

  it('имя не той формы (не строка) по-прежнему отвергает всё сообщение', () => {
    // Граница правки: чистка НЕ должна проглатывать испорченную ФОРМУ.
    expect(sanitizePayload({ file: { ...BASE, name: 42 } })).toBeNull();
    expect(sanitizePayload({ file: { ...BASE, name: null } })).toBeNull();
  });
});
