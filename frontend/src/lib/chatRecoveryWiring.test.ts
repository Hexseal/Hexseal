/**
 * chatRecoveryWiring.test.ts — окно ДОЕХАЛО ДО ЭКРАНА (Задача 8).
 *
 * ⚠️ ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ. Ровно эта задача и есть тот самый дефект:
 * `useChatSession.ts` отдавал `recoveryCode` наружу, всё было написано
 * правильно, тесты были зелёные — и НИ ОДИН компонент его не читал. Код
 * выдавался и не показывался никогда.
 *
 * Сделать окно и не подключить его — повторить тот же дефект дословно.
 * Поведением это не ловится: окно-то работает. Ловится только осмотром
 * исходников на предмет «кто его зовёт».
 *
 * Тот же приём и та же причина, что у `signaturePaths.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import {
  RECOVERY_CHECK_WORDS,
  openRecoveryPrompt,
  forgetRecoveryConfirmed,
  markRecoveryConfirmed,
  isRecoveryConfirmed,
} from './chatRecovery';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const GOLD = entropyToMnemonic(new Uint8Array(16).fill(0x7f), wordlist);

/* ─────────────── подготовка показа: мусор — вердикт ───────────────────── */

describe('подготовка показа', () => {
  it('годный код даёт двенадцать слов и три номера разом', () => {
    const prompt = openRecoveryPrompt(GOLD);
    expect(prompt).not.toBeNull();
    expect(prompt!.words).toEqual(GOLD.split(' '));
    expect(prompt!.positions).toHaveLength(RECOVERY_CHECK_WORDS);
  });

  it.each([
    ['пусто', ''],
    ['не строка', 7],
    ['ничего', null],
    ['одиннадцать слов', GOLD.split(' ').slice(0, 11).join(' ')],
    ['тринадцать слов', `${GOLD} extra`],
  ])('негодный код («%s») — окна НЕ БУДЕТ, и это не падение', (_name, junk) => {
    // Обстоятельство 4. Красит: подготовка, которая доверяет входу и зовёт
    // `.split` на чём попало — уронит весь экран вместо отказа показать окно.
    expect(openRecoveryPrompt(junk)).toBeNull();
  });

  it('два показа подряд дают разные номера — вторая попытка не та же самая', () => {
    // Красит: номера, посчитанные один раз на модуль. Человек, ошибшийся и
    // открывший окно снова, получал бы ровно те же три слова.
    const sets = new Set<string>();
    for (let i = 0; i < 100; i++) sets.add(openRecoveryPrompt(GOLD)!.positions.join(','));
    expect(sets.size).toBeGreaterThan(10);
  });
});

/* ─────────────── снятие отметки: новый код — новый показ ──────────────── */

describe('снятие отметки «записал»', () => {
  const store = new Map<string, string>();
  const ADDR = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';

  function stub() {
    store.clear();
    globalThis.localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
    } as unknown as Storage;
  }

  it('⚠️ выдан НОВЫЙ код — прежняя отметка снимается, иначе он не покажется', () => {
    // Дыра, которую это закрывает: человек подтвердил код, потом устройство
    // потеряло запись (чистка хранилища, приватный режим). Открытие сеанса
    // заводит НОВЫЙ ключ и НОВЫЙ код — а отметка в `localStorage` всё ещё
    // говорит «записал». Без снятия новый код не показался бы никогда, то
    // есть вернулся бы ровно тот дефект, ради которого задача заведена.
    stub();
    markRecoveryConfirmed(ADDR);
    expect(isRecoveryConfirmed(ADDR)).toBe(true);
    forgetRecoveryConfirmed(ADDR);
    expect(isRecoveryConfirmed(ADDR)).toBe(false);
  });

  it('снятие переживает отказ хранилища и отсутствие адреса', () => {
    stub();
    expect(() => forgetRecoveryConfirmed(undefined)).not.toThrow();
    globalThis.localStorage = {
      getItem: () => { throw new Error('нет'); },
      setItem: () => { throw new Error('нет'); },
      removeItem: () => { throw new Error('нет'); },
    } as unknown as Storage;
    expect(() => forgetRecoveryConfirmed(ADDR)).not.toThrow();
  });
});

/* ─────────────────────── окно доехало до экрана ───────────────────────── */

describe('окно подключено, а не просто написано', () => {
  it('привратник смонтирован ровно в одном месте — в общей обёртке приложения', () => {
    // ОДИН раз: `useChatSession()` живёт в нескольких компонентах сразу
    // (WalletMenu, ChatPanel, страница чата), и все они на первом открытии
    // получают ОДИН И ТОТ ЖЕ объект сеанса — значит все увидели бы код
    // непустым. Смонтируй окно в каждом — человек получил бы три окна.
    const layout = read('app/client-layout.tsx');
    expect(layout).toContain('RecoveryCodeGate');
    expect(layout.match(/<RecoveryCodeGate\s*\/>/g) ?? []).toHaveLength(1);
  });

  it('привратник читает код из хука — иначе он снова никому не нужен', () => {
    const gate = read('components/RecoveryCodeGate.tsx');
    expect(gate).toContain('useChatSession');
    expect(gate).toMatch(/recoveryCode/);
    expect(gate).toContain('RecoveryCodeModal');
  });

  it('меню кошелька умеет показать код снова', () => {
    // Свойство 5 задачи: закрыл не записав — может открыть снова.
    //
    // ⚠️ РЕШЕНИЕ «КОМУ ПОКАЗЫВАТЬ» ПЕРЕЕХАЛО ИЗ РАЗМЕТКИ В ТАБЛИЦУ
    // (`lib/walletMenuChat.ts`) после замера на живом телефоне: меню
    // предлагало код обычному кошельку, у которого его не бывает, и
    // «Подключить мессенджер» у работающего чата. Здесь остаётся проверка
    // ПРОВОДКИ (пункт есть и зовёт то событие), а само правило перебрано
    // таблицей три-состояния-на-два-рода в `lib/walletMenuChat.test.ts` —
    // то есть замером поведения, а не наличием имени в файле.
    const menu = read('components/WalletMenu.tsx');
    expect(menu).toContain('SHOW_RECOVERY_EVENT');
    expect(menu).toContain('walletMenuChatItems');
    expect(menu).toContain("chatMenu.has('show-code')");
  });

  it('плашка-напоминание доехала до чата', () => {
    const panel = read('components/ChatPanel.tsx');
    expect(panel).toContain('RecoveryReminder');
    expect(panel).toContain('useRecoveryReminder');
  });

  it('имя события — одно на всех, из одного места', () => {
    // Красит: строка события, набранная руками во втором месте. Опечатка в
    // ней сделала бы пункт меню мёртвым, и заметить это было бы нечем.
    const gate = read('components/RecoveryCodeGate.tsx');
    expect(gate).toMatch(/export const SHOW_RECOVERY_EVENT\s*=/);
    for (const rel of ['components/WalletMenu.tsx', 'components/ChatPanel.tsx']) {
      const body = read(rel);
      if (!body.includes('SHOW_RECOVERY_EVENT') && !body.includes('useRecoveryReminder')) {
        throw new Error(`${rel} не подключён`);
      }
      expect(body, rel).not.toMatch(/'hexseal:show-recovery-code'/);
    }
  });
});
