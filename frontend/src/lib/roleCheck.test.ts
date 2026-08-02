import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError, HttpRequestError } from 'viem';
import {
  roleDenied,
  roleFailureKind,
  roleFromRead,
  roleGranted,
  roleUnreadable,
  type RoleCheck,
} from './roleCheck';

/** Заготовка «чтение ещё не начиналось». */
const pending = { data: undefined, isError: false, error: undefined, isPending: true, enabled: true };

describe('roleFromRead — три ответа вместо двух', () => {
  it('true с цепи → арбитр', () => {
    expect(roleFromRead({ ...pending, data: true, isPending: false }, Boolean)).toBe('yes');
  });

  it('false с цепи → не арбитр', () => {
    expect(roleFromRead({ ...pending, data: false, isPending: false }, Boolean)).toBe('no');
  });

  it('СБОЙ ЧТЕНИЯ → «не смогли проверить», а НЕ «не арбитр»', () => {
    // Ровно этот случай 2 августа 2026 и унёс роль у владельца:
    // `!!undefined === false`, и сбой сети выдавался за уверенный ответ.
    const err = new HttpRequestError({ url: 'https://x/api/rpc', status: 502 });
    expect(roleFromRead({ ...pending, isError: true, error: err, isPending: false }, Boolean))
      .toBe('unreadable');
  });

  it('чтение в полёте → «ещё проверяем», а не «не смогли»', () => {
    // Слить эти два состояния значило бы показывать тревогу на каждой загрузке
    // страницы — и обесценить её к тому дню, когда она настоящая.
    expect(roleFromRead(pending, Boolean)).toBe('checking');
  });

  it('запрос выключен (кошелёк не подключён) → «нет», это не сбой', () => {
    expect(roleFromRead({ ...pending, enabled: false }, Boolean)).toBe('no');
  });

  it('РЕВЕРТ тоже «не смогли проверить»: отказ цепи — не отрицательный ответ', () => {
    // `isRegisteredArbiter` — обычная view. Её реверт означает «селектора нет /
    // фасет снят», а не «этот адрес не арбитр».
    const err = new BaseError('reverted', {
      cause: new ContractFunctionRevertedError({ abi: [], functionName: 'isRegisteredArbiter' }),
    });
    expect(roleFromRead({ ...pending, isError: true, error: err, isPending: false }, Boolean))
      .toBe('unreadable');
  });

  it('данные есть, а фоновое перечитывание упало → держим ответ цепи', () => {
    // react-query v5 ставит status:"error" и на провал ФОНОВОГО перечитывания,
    // сохраняя прежнее `data`. Это «час назад цепь ответила», а не «не знаем»:
    // поднимать тревогу и гасить вкладку тут не за что.
    const err = new HttpRequestError({ url: 'https://x/api/rpc', status: 502 });
    expect(roleFromRead({ data: true, isError: true, error: err, isPending: false, enabled: true }, Boolean))
      .toBe('yes');
    expect(roleFromRead({ data: false, isError: true, error: err, isPending: false, enabled: true }, Boolean))
      .toBe('no');
  });

  it('ни данных, ни ошибки, ни полёта → «не смогли», а не «нет»', () => {
    expect(roleFromRead({ ...pending, isPending: false }, Boolean)).toBe('unreadable');
  });

  it('`decide` решает, что считать ролью — сравнение адресов для owner()', () => {
    const me = '0x42dCd14eeE50cE7179ABdc9F1770b4C1C3250894';
    const decide = (owner: string) => owner.toLowerCase() === me.toLowerCase();
    // Регистр не должен решать ничего: цепь отдаёт checksummed, wagmi — как есть.
    expect(roleFromRead({ ...pending, data: me.toLowerCase(), isPending: false }, decide)).toBe('yes');
    expect(roleFromRead({ ...pending, data: '0x0000000000000000000000000000000000000001', isPending: false }, decide)).toBe('no');
  });
});

describe('roleGranted / roleDenied — не отрицания друг друга', () => {
  const all: RoleCheck[] = ['yes', 'no', 'checking', 'unreadable'];

  it('право даёт ТОЛЬКО подтверждённое «да»', () => {
    expect(all.filter(roleGranted)).toEqual(['yes']);
  });

  it('подтверждённое «нет» — ровно одно состояние', () => {
    expect(all.filter(roleDenied)).toEqual(['no']);
  });

  it('«не смогли проверить» не даёт ни права, ни отказа', () => {
    // Оба false — и это главное свойство: осторожность (прав не выдаём) без
    // вранья (обратного не утверждаем).
    expect(roleGranted('unreadable')).toBe(false);
    expect(roleDenied('unreadable')).toBe(false);
  });

  it('«Стать арбитром» не показывается при непрочитанной роли', () => {
    // Прежнее условие было `!isArbiter`, а `!false` — правда: настоящему
    // арбитру предлагалась кнопка в гарантированный реверт applyAsArbiter().
    expect(roleDenied('unreadable')).toBe(false);
    expect(roleDenied('checking')).toBe(false);
    expect(roleDenied('no')).toBe(true);
  });
});

describe('roleUnreadable', () => {
  it('срабатывает, если хоть одна роль не прочиталась', () => {
    expect(roleUnreadable('yes', 'no')).toBe(false);
    expect(roleUnreadable('yes', 'unreadable')).toBe(true);
    expect(roleUnreadable('checking', 'checking')).toBe(false);
    expect(roleUnreadable()).toBe(false);
  });
});

/**
 * Гейт по исходникам — тем же приёмом, что `connectWallet.test.ts`.
 *
 * ЗАЧЕМ. Правило «сбой чтения роли не выдаётся за отсутствие роли» живёт не в
 * типах: `useReadContract` отдаёт `boolean | undefined`, и `!!` на нём
 * компилируется молча. Именно так этот баг и приехал в прод, причём в трёх
 * местах сразу и в разной форме — в шапке он прятал вкладку, в меню кошелька
 * пункты, а в защите маршрута `/arbiter` ВЫБРАСЫВАЛ арбитра на главную.
 * Модульные тесты выше проверяют само правило; этот проверяет, что им
 * пользуются там, где раздаются права.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url)); // frontend/src

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...walk(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

const FILES = walk(SRC).map(f => ({
  path: relative(SRC, f).split(/[\\/]/).join('/'),
  raw:  readFileSync(f, 'utf8'),
}));

describe('роль читают через общее правило, а не через `!!`', () => {
  it('места, раздающие права по роли, ходят через lib/roleCheck', () => {
    // Не «сколько-то файлов», а именно эти. Новый файл, читающий
    // `isRegisteredArbiter`, обязан осознанно решить, что делать со сбоем, а
    // не молча пройти гейт с очередным `!!`.
    const readers = FILES
      .filter(f => /functionName:\s*['"]isRegisteredArbiter['"]/.test(f.raw))
      .map(f => f.path)
      .sort();

    expect(readers).toEqual([
      'app/arbiter/layout.tsx',        // защита маршрута — раздаёт доступ
      'app/arbiter/page.tsx',          // внутри уже пущенного layout'ом маршрута
      'hooks/useNotifications.ts',     // порождает уведомления, прав не даёт
      'hooks/useWalletAccountData.ts', // вкладка в шапке + пункты меню
    ]);

    const gates = ['app/arbiter/layout.tsx', 'hooks/useWalletAccountData.ts'];
    for (const path of gates) {
      const file = FILES.find(f => f.path === path);
      expect(file, `${path} исчез — обнови список`).toBeDefined();
      expect(file!.raw, `${path} обязан решать про сбой через lib/roleCheck`)
        .toMatch(/from ['"]@\/lib\/roleCheck['"]/);
    }
  });

  it('в этих файлах не осталось `!!` над результатом чтения роли', () => {
    // `const isArbiter = !!isArbiterRaw;` — ровно та строка, что стоила
    // владельцу роли 2 августа 2026.
    const gates = ['app/arbiter/layout.tsx', 'hooks/useWalletAccountData.ts'];
    const offenders: string[] = [];
    for (const path of gates) {
      const file = FILES.find(f => f.path === path)!;
      file.raw.split('\n').forEach((line, i) => {
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
        if (!/rbiter|\bowner|Owner/.test(line)) return;
        if (/=\s*!!/.test(line)) offenders.push(`${path}:${i + 1} ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('roleFailureKind — различие для журнала, не для UI', () => {
  it('без ошибки — null', () => {
    expect(roleFailureKind({ isError: false })).toBeNull();
  });

  it('RPC отвалился → transport', () => {
    const err = new HttpRequestError({ url: 'https://x/api/rpc', status: 502 });
    expect(roleFailureKind({ isError: true, error: err })).toBe('transport');
  });

  it('цепь ответила отказом → contract', () => {
    const err = new BaseError('reverted', {
      cause: new ContractFunctionRevertedError({ abi: [], functionName: 'isRegisteredArbiter' }),
    });
    expect(roleFailureKind({ isError: true, error: err })).toBe('contract');
  });

  it('незнакомый класс ошибки попадает в честное «не знаем»', () => {
    expect(roleFailureKind({ isError: true, error: new Error('что-то') })).toBe('transport');
  });
});
