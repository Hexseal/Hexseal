/**
 * chatPanelLabels.test.ts — надписи панели, которые врали или обвиняли
 * (находки аудита: мелочь про потолок файла и `key_not_saved`).
 *
 * ⚠️ ПОЧЕМУ ОСМОТР ИСХОДНИКОВ И СЛОВАРЕЙ, А НЕ РАЗМЕТКИ. Обе находки — про
 * ЧИСЛО и про ЯЗЫК, а не про ветвление. Зашитая по-английски строка
 * отрисовывается ровно так же, как переведённая, и «5 ГБ» вместо «200 МБ»
 * выглядит на экране совершенно исправно. Заметить это можно только чтением.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_FILE_SIZE } from './fileStorage';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const MESSAGES_DIR = path.resolve(HERE, '../../messages');

const LOCALES = ['ar', 'de', 'en', 'es', 'fr', 'hi', 'it', 'ja', 'ko', 'pt', 'ru', 'th', 'uk', 'zh-CN'];

const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const dict = (locale: string) =>
  JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, `${locale}.json`), 'utf8')) as
    { chat: Record<string, string> };

/** Потолок в мегабайтах — из ЕДИНСТВЕННОГО места, а не литералом. */
const MB = MAX_FILE_SIZE / (1024 * 1024);

describe('потолок размера файла: одно число, и оно верное', () => {
  it('единственный источник — 200 МБ', () => {
    // Красит: смену потолка без сверки с сервером. То же число проверяет
    // `relayer/test/chatFilesPass.test.js`, разбирая ЭТОТ файл регуляркой.
    expect(MB).toBe(200);
  });

  it('⚠️ панель не держит зашитой по-английски надписи про размер', () => {
    // Красит: возврат `setUploadErr(\`File too large...\`)`. Строка мимо всех
    // четырнадцати локалей: человек, читающий по-тайски, получал английское
    // предложение посреди своего экрана.
    const panel = read('components/ChatPanel.tsx');
    expect(panel).not.toMatch(/File too large/);
    expect(panel).toContain('chat.file_too_large');
  });

  it('надпись про потолок берёт число из константы, а не вписывает руками', () => {
    // Красит: `{ mb: 200 }`. Тогда снижение потолка снова разошлось бы с
    // тем, что видит человек, — ровно как случилось с «5 ГБ».
    const panel = read('components/ChatPanel.tsx');
    expect(panel).toMatch(/mb:\s*MAX_FILE_SIZE\s*\/\s*\(1024\s*\*\s*1024\)/);
  });

  it('⚠️ ни одна локаль больше не обещает 5 ГБ', () => {
    // ГЛАВНЫЙ ЗАМОК находки. Потолок снизили до 200 МБ, а подпись к скрепке
    // во всех четырнадцати локалях продолжала звать на 5 ГБ — человек
    // выбирал файл на гигабайт и получал отказ, которого ему не обещали.
    const lying: string[] = [];
    for (const locale of LOCALES) {
      const title = dict(locale).chat.attach_file_title ?? '';
      if (/5\s*(GB|ГБ|Go|غيغابايت|GB|기가|ギガ)/i.test(title)) lying.push(locale);
    }
    expect(lying).toEqual([]);
  });

  it('подпись к скрепке подставляет число, а не вписывает его', () => {
    const missing: string[] = [];
    for (const locale of LOCALES) {
      if (!(dict(locale).chat.attach_file_title ?? '').includes('{mb}')) missing.push(locale);
    }
    expect(missing).toEqual([]);
  });
});

describe('«ключ не сохранился» разведён по роду кошелька', () => {
  it('⚠️ у кошелька-контракта своя надпись, и она про ПОТЕРЮ ЛИЧНОСТИ', () => {
    // Находка аудита. Общая надпись говорит «переписка работает до
    // перезагрузки вкладки» — для обычного кошелька это правда и это
    // неудобство. Для кошелька-контракта каждая перезагрузка заводит НОВЫЙ
    // случайный ключ: прежняя переписка становится нечитаемой, а собеседник
    // видит человека под новым ключом. Это не неудобство.
    const ru = dict('ru');
    expect(ru.chat.key_not_saved_contract).toBeTruthy();
    expect(ru.chat.key_not_saved_contract).not.toBe(ru.chat.key_not_saved);
  });

  it('надпись есть во всех четырнадцати локалях и не пуста', () => {
    const missing: string[] = [];
    for (const locale of LOCALES) {
      const v = dict(locale).chat.key_not_saved_contract;
      if (typeof v !== 'string' || v.trim().length === 0) missing.push(locale);
    }
    expect(missing).toEqual([]);
  });

  it('панель ВЫБИРАЕТ надпись по роду кошелька, а не показывает общую', () => {
    // Красит: заведённый ключ, который никто не читает, — тот же дефект,
    // ради которого существовала задача про код восстановления.
    const panel = read('components/ChatPanel.tsx');
    expect(panel).toContain('chat.key_not_saved_contract');
    expect(panel).toContain('hasRecoveryCode');
  });
});
