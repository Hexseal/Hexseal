import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Структурный гейт на главное свойство этой починки:
 *
 *   1. НИ ОДИН путь не запрашивает подпись кошелька без явного действия
 *      человека;
 *   2. КАЖДЫЙ путь, который её всё-таки запрашивает, делает это под общим
 *      мьютексом кошелька.
 *
 * Проверяется чтением исходников, а не запуском браузера, — намеренно. Оба
 * свойства ломаются одинаково: кто-то добавляет новый вызов подписи и просто
 * не знает про мьютекс, либо вешает `Client.create()` на эффект. Ни то, ни
 * другое не видно ни в типах, ни в тестах модулей; единственный дешёвый
 * способ поймать это до устройства — пересчитать места в коде.
 *
 * Цена промаха несоразмерна цене теста: второй одновременный запрос подписи
 * прилетает в кошелёк как -32002 ('personal_sign already pending for origin'),
 * а мобильный MetaMask отменять такие запросы не умеет — просьба об этом висит
 * у них с 2023 года. Человек остаётся заблокирован, пока не закроет приложение
 * кошелька целиком.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url)); // frontend/src

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      out.push(...walk(full));
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.test\.tsx?$/.test(name)) continue; // сами тесты не в счёт
    out.push(full);
  }
  return out;
}

/** Оставляет только строки КОДА: выбрасывает строчные комментарии и тела
 *  блочных (в этом репозитории они всегда оформлены с ведущей `*`).
 *
 *  Без этого гейт срабатывает на собственных объяснениях в коде: в
 *  XmtpContext.tsx `Client.create()` упоминается в комментарии про
 *  длительность первого входа, и файл выглядел бы как второе место вызова.
 *
 *  Это намеренно фильтр по строкам, а не разбор синтаксиса. Полноценный
 *  токенайзер здесь опаснее пользы: он спотыкается о JSX-текст с апострофом
 *  («don't») и о литералы регулярок, и, ошибившись, тихо СЪЕДАЕТ настоящий код
 *  — то есть гейт молча перестаёт что-либо проверять. Отбросить строку,
 *  которая целиком является комментарием, ошибиться так не может: код в этом
 *  файле никогда не начинается с `//` или `*`. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter(line => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    // Хвостовые комментарии на строке кода. Оба вычищения — строго в пределах
    // одной строки, поэтому промах портит ровно её, а не разъезжается по файлу.
    .map(line => line
      // `/* … */` целиком внутри строки: оба ограничителя на месте, спутать не с чем.
      .replace(/\/\*[^\n]*?\*\//g, ' ')
      // `// …` в конце строки кода — но НЕ `://`, иначе от 'http://localhost:3001'
      // остаётся непарная кавычка и полстроки исчезает.
      .replace(/(^|[^:])\/\/.*$/, '$1 '))
    .join('\n');
}

const FILES = walk(SRC).map(f => {
  const raw = readFileSync(f, 'utf8');
  return {
    path: relative(SRC, f).split(/[\\/]/).join('/'),
    raw,
    text: codeOnly(raw),
  };
});

// Вызовы, которые реально открывают окно подписи в кошельке. Голый
// `signMessage(` сюда не годится: в `lib/webpush.ts` так называется наш
// собственный колбэк-параметр, а он кошелька не трогает — подпись делает тот,
// кто этот колбэк передал.
const WALLET_SIGN_CALL = /walletClient\.signMessage\s*\(|\.signTypedData\s*\(|\bsignMessageAsync\s*\(/;
const TAKES_LOCK       = /from\s+['"]@\/lib\/walletLock['"]/;

// Файлы, где вообще есть вызов подписи. Ищем по тексту БЕЗ комментариев и
// строк, чтобы не ловить собственные объяснения в коде.
const SIGNING_FILES = FILES.filter(f => WALLET_SIGN_CALL.test(f.text));

describe('пути подписи', () => {
  it('каждый файл с вызовом подписи берёт общий мьютекс кошелька', () => {
    // Импорт проверяем по СЫРОМУ тексту: путь модуля — строковый литерал, а в
    // `text` строки вырезаны.
    const offenders = SIGNING_FILES
      .filter(f => f.path !== 'lib/walletLock.ts')
      .filter(f => !TAKES_LOCK.test(f.raw))
      .map(f => f.path);

    expect(offenders).toEqual([]);
  });

  it('места подписи наперечёт и известны поимённо', () => {
    // Не «сколько-то файлов», а именно эти. Новый файл в списке — это повод
    // осознанно проверить, по нажатию ли там подпись, а не молча пройти гейт.
    const signing = SIGNING_FILES.map(f => f.path).sort();

    expect(signing).toEqual([
      'app/arbiter/page.tsx',            // журнал спора — по нажатию «View history»
      'app/deal/[address]/page.tsx',     // причина спора — по нажатию «Dispute»
      'app/profile/edit/page.tsx',       // сохранение профиля — по нажатию «Save»
      'components/DealActionBar.tsx',    // причина спора — по нажатию «Dispute»
      'components/DealCard.tsx',         // причина спора — по нажатию «Dispute»
      'contexts/PushContext.tsx',        // подписка на пуши — по нажатию тумблера
      // Пропуск склада чата и подпись ключа переписки. Оба — единственные на
      // весь чат (Задача 6 плана «Клиент чата»): переписка и список переписок
      // зовут `getBagPass` отсюда, своего вызова подписи у них нет.
      //
      // ⚠️ ЧЕСТНО: это НЕ «по нажатию». Пропуск склада нужен, чтобы вообще
      // прочитать переписку, и на холодном кэше он спрашивает подпись при
      // открытии чата, а не по кнопке (кэш живёт 12 часов, так что это
      // максимум дважды в сутки). Так устроена сама защита выдачи мешков —
      // §4 общей спеки: «защита стоит на выдаче мешков, а не на подписи».
      // Ключ переписки спрашивается один раз в жизни устройства
      // (`chatSession.ts`). Оба под общим мьютексом кошелька.
      'hooks/useChatSession.ts',
      'lib/relay.ts',                    // гейслесс-действия — все по нажатию
      'lib/xmtp.ts',                     // сайнер XMTP — только из ручного включения
    ]);
  });
});

describe('автоматических подписей не осталось', () => {
  it('Client.create() существует в одном экземпляре и только в lib/xmtp.ts', () => {
    // Client.create() — единственный конструктор XMTP, принимающий сайнера, то
    // есть единственный, который может попросить подпись. Автоматика обязана
    // ходить через Client.build(), у которого сайнера нет вовсе.
    const withCreate = FILES.filter(f => /Client\.create\s*\(/.test(f.text));
    expect(withCreate.map(f => f.path)).toEqual(['lib/xmtp.ts']);

    const occurrences = (withCreate[0].text.match(/Client\.create\s*\(/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('lib/xmtp.ts отдаёт путь без подписи через Client.build + isRegistered', () => {
    const xmtp = FILES.find(f => f.path === 'lib/xmtp.ts')!;
    expect(xmtp.text).toMatch(/Client\.build\s*\(/);
    expect(xmtp.text).toMatch(/isRegistered\s*\(\s*\)/);
    expect(xmtp.text).toMatch(/export function buildXmtpClient/);
  });

  it('XmtpContext зовёт подписывающий initXmtpClient ровно один раз — в ручной ветке', () => {
    const ctx = FILES.find(f => f.path === 'contexts/XmtpContext.tsx')!;
    // Один вызов на весь файл: если бы автоматическая ветка тоже его звала
    // (как было до починки), их стало бы два.
    const calls = (ctx.text.match(/\binitXmtpClient\s*\(\s*walletClient/g) ?? []).length;
    expect(calls).toBe(1);
    // …и автоматическая ветка идёт через сборку без сайнера.
    expect(ctx.text).toMatch(/await buildXmtpClient\(/);
  });

  it('PushContext подписывает только из явного enable()', () => {
    const ctx = FILES.find(f => f.path === 'contexts/PushContext.tsx')!;
    // Фоновая перерегистрация раз в 24 часа держала здесь второй вызов
    // enablePush() — он и выбрасывал человека в кошелёк без нажатия.
    const calls = (ctx.text.match(/\bawait enablePush\s*\(|\benablePush\s*\(address/g) ?? []).length;
    expect(calls).toBe(1);
    // Порог протухания больше не запускает действие — он только для показа.
    expect(ctx.text).not.toMatch(/shouldAutoRegisterPush/);
  });

  it('в lib/webpush.ts не осталось функции, разрешающей фоновую подписку', () => {
    const wp = FILES.find(f => f.path === 'lib/webpush.ts')!;
    expect(wp.text).not.toMatch(/shouldAutoRegisterPush/);
    expect(wp.text).toMatch(/export function isPushRegistrationStale/);
  });
});
