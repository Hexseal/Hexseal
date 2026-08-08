/**
 * appVersion.test.ts — установленное приложение узнаёт, что выкатилась новая версия.
 *
 * ─── ЧТО СТОИЛО НАМ ЧАСОВ ───────────────────────────────────────────────────
 *
 * В манифесте `launch_handler: { client_mode: 'focus-existing' }` — открытие
 * ярлыка ВОЗВРАЩАЕТ существующее окно, а не перезагружает страницу. Куски кода с
 * хешем в имени живут вечно (`/_next/static/...`, `immutable`). Значит
 * приложение, открытое ДО выкатки, работает на прежнем коде сколько угодно — и
 * человек проверяет починку, которой у него нет.
 *
 * ─── ГЛАВНАЯ ОПАСНОСТЬ ЗДЕСЬ — НЕ СТАРЫЙ КОД, А ПЕТЛЯ ───────────────────────
 *
 * Своя починка легко выходит хуже дефекта: если признак «моя версия» и признак
 * «версия на сервере» разъедутся по любой причине (например, номер считается
 * заново при каждом запуске сервера), страница будет перезагружаться БЕСКОНЕЧНО.
 * Стало бы не «работает старый код», а «не работает ничего».
 *
 * Поэтому правило перезагрузки — чистая функция, и у неё есть память: на одну
 * версию сервера ОДНА попытка. Не помогло — больше не пробуем.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  shouldReloadForVersion, rememberReloadAttempt, reloadAlreadyTried,
  fetchServedVersion, _resetVersionMemoryForTest,
} from '@/lib/appVersion';

/** Подделка сеансовой кладовой: приватный режим её вовсе не даёт. */
function fakeStore(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, v); },
  } as Storage;
}

beforeEach(() => {
  _resetVersionMemoryForTest();
  vi.stubGlobal('sessionStorage', fakeStore());
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('перезагружаться или нет', () => {
  it('версии совпали — НЕТ', () => {
    expect(shouldReloadForVersion({ current: 'abc', served: 'abc', alreadyTried: false })).toBe(false);
  });

  it('версия на сервере другая, ещё не пробовали — ДА', () => {
    expect(shouldReloadForVersion({ current: 'abc', served: 'def', alreadyTried: false })).toBe(true);
  });

  it('версия другая, но уже пробовали — НЕТ (петля)', () => {
    // ⚠️ ГЛАВНЫЙ ЗАМОК ФАЙЛА. Что красит: снятие памяти о попытке. Тогда любой
    // разъезд номеров даёт бесконечную перезагрузку — приложение, которое не
    // работает вовсе, вместо приложения на старом коде.
    expect(shouldReloadForVersion({ current: 'abc', served: 'def', alreadyTried: true })).toBe(false);
  });

  it('своей версии нет (сборка без номера) — НЕТ', () => {
    // Иначе развёртывание без переменной означало бы перезагрузку у всех и
    // сразу, по кругу.
    for (const current of ['', undefined, null]) {
      expect(shouldReloadForVersion({
        current: current as unknown as string, served: 'def', alreadyTried: false,
      }), String(current)).toBe(false);
    }
  });

  it('сервер номера не назвал — НЕТ', () => {
    // Мусор в ответе, старый посредник, страница-заглушка от прокси: ничего из
    // этого не повод трогать работающее приложение.
    for (const served of ['', undefined, null, 'null']) {
      expect(shouldReloadForVersion({
        current: 'abc', served: served as unknown as string, alreadyTried: false,
      }), String(served)).toBe(served === 'null'); // 'null' — обычная строка, законный номер
    }
  });
});

describe('память о попытке', () => {
  it('помнит попытку ПО ВЕРСИИ, а не «однажды»', () => {
    rememberReloadAttempt('v2');
    expect(reloadAlreadyTried('v2')).toBe(true);
    // Выкатили v3 — попытка обязана быть новой, иначе после одной неудачи
    // приложение не обновится больше НИКОГДА.
    expect(reloadAlreadyTried('v3')).toBe(false);
  });

  it('кладовой нет (приватный режим) — не падаем и не перезагружаемся по кругу', () => {
    // Требование «диск не пишет». Без кладовой память о попытке невозможна;
    // значит безопаснее НЕ перезагружаться вовсе, чем перезагружаться вечно.
    vi.stubGlobal('sessionStorage', undefined);
    expect(() => rememberReloadAttempt('v2')).not.toThrow();
    expect(reloadAlreadyTried('v2'), 'без кладовой попытка не считается — будет петля').toBe(true);
  });

  it('кладовая бросает на записи — тот же безопасный исход', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('заперто'); },
      setItem: () => { throw new Error('заперто'); },
    } as unknown as Storage);
    expect(() => rememberReloadAttempt('v2')).not.toThrow();
    expect(reloadAlreadyTried('v2')).toBe(true);
  });
});

describe('спросить сервер о версии', () => {
  it('ответ разобран, и запрос идёт БЕЗ кэша', async () => {
    // Смысл всей затеи: этот запрос обязан миновать любой кэш. Спросив через
    // кэш, мы получили бы тот же старый номер, что и старый код.
    let init: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, i?: RequestInit) => {
      init = i;
      return new Response(JSON.stringify({ buildId: 'v9' }), { status: 200 });
    }));
    expect(await fetchServedVersion()).toBe('v9');
    expect(init?.cache, 'запрос версии пошёл через кэш — вернётся тот же старый номер').toBe('no-store');
  });

  it('сервер отдал мусор — `null`, не падение', async () => {
    for (const body of ['не json', '{}', '[]', 'null', '{"buildId":123}']) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
      expect(await fetchServedVersion(), body).toBeNull();
    }
  });

  it('сервер ответил отказом или не ответил — `null`', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    expect(await fetchServedVersion()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('сеть'); }));
    expect(await fetchServedVersion()).toBeNull();
  });
});

describe('обстоятельство: долбят нарочно', () => {
  it('версия спрашивается не чаще раза в минуту', async () => {
    // Возвращение в приложение бывает частым (переключение на кошелёк и обратно
    // — каждое!). Без ограничителя каждое переключение стоило бы запроса.
    const { versionCheckDue } = await import('@/lib/appVersion');
    expect(versionCheckDue(0, 0)).toBe(true);
    expect(versionCheckDue(1_000, 30_000)).toBe(false);
    expect(versionCheckDue(1_000, 61_000)).toBe(true);
  });
});
