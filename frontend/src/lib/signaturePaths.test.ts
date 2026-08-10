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
 *      мьютексом кошелька — И ИМЕННО ЭТИМ ВЫЗОВОМ ПОДПИСИ, А НЕ ФАКТОМ, ЧТО
 *      МЬЮТЕКС ГДЕ-ТО В ФАЙЛЕ УПОМЯНУТ.
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
 *
 * ⚠️ РАУНД УСИЛЕНИЯ (10 августа 2026, ревью Задачи 1 плана «предъявление чата
 * арбитру»). Пункт 2 раньше проверялся ИМПОРТОМ: строка
 * `from '@/lib/walletLock'` где-то в файле. Этого достаточно для «файл знает
 * про мьютекс», но НЕ для «этот конкретный вызов подписи мьютексом закрыт».
 * Замер ревьюера: снять саму обёртку `withWalletLock(...)` вокруг
 * `walletClient.signTypedData(...)` в `signChatKeyAttestation`
 * (`lib/chatKeyAttestation.ts`), оставив импорт нетронутым (мёртвый
 * импорт) — **0 красных из 45**. Гейт зелёный, защиты нет.
 *
 * Ниже — проверка ПО МЕСТУ (`unlockedSignCalls`): каждый найденный вызов
 * подписи обязан лежать лексически ВНУТРИ вызова `withWalletLock(...)`, либо
 * внутри `try`-блока, за которым следует `acquireWalletLock` и `finally` с
 * вызовом освобождения — те же два раскроя, что реально встречаются в этом
 * репозитории (`lib/walletLock.ts`, шапка `withWalletLock`/`acquireWalletLock`).
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
 *  файле никогда не начинается с `//` или `*`.
 *
 *  ⚠️ Комментарийная строка становится ПУСТОЙ, а не УДАЛЯЕТСЯ (было —
 *  `.filter()`, до раунда усиления 10 августа 2026). Раньше это было
 *  безопасно: `text` использовался только для матчинга по regex без оглядки
 *  на номер строки. Проверка вложенности ниже (`unlockedSignCalls`) считает
 *  позиции символов внутри `text` и обязана сходиться с номерами строк
 *  `raw` — построчное удаление сдвигало бы координаты на число выброшенных
 *  строк выше по файлу и портило бы диагностику (а при достаточно кривом
 *  файле — и сам разбор скобок, если вырезанная строка меняла их баланс). */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .map(line => {
      const t = line.trim();
      return (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) ? '' : line;
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

// Файлы, где вообще есть вызов подписи. Ищем по тексту БЕЗ комментариев и
// строк, чтобы не ловить собственные объяснения в коде.
const SIGNING_FILES = FILES.filter(f => WALLET_SIGN_CALL.test(f.text));

/* ─────────────────────── разбор вложенности по месту ───────────────────── */

/** Индекс символа, где закрывается скобка, открытая в `openIdx` (`text[openIdx]`
 *  обязан быть `(`). Считает по балансу, БЕЗ разбора строк/шаблонов —
 *  см. предупреждения в докстринге `unlockedSignCalls` ниже. `-1` — не
 *  закрылась до конца файла (битый код или парная скобка отрезана обрывом). */
function matchParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** То же для `{`/`}`. */
function matchBrace(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Диапазоны текста, закрытые раскроем А: `withWalletLock(АДРЕС, () => ЗВОНОК)`.
 *  Вызов подписи защищён, если его индекс попадает СТРОГО ВНУТРЬ пары скобок
 *  вызова `withWalletLock(` — вне зависимости от того, сколько промежуточных
 *  вызовов лежит между (`getBagPass`/`requestBagPass` в `useChatSession.ts`
 *  зовут подпись через два вложенных колбэка, и это по-прежнему «внутри»). */
function lockedSpansWithWalletLock(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /\bwithWalletLock\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = matchParen(text, openIdx);
    if (closeIdx !== -1) spans.push([m.index, closeIdx]);
  }
  return spans;
}

/** Диапазоны текста, закрытые раскроем Б:
 *
 *    const X = await acquireWalletLock(АДРЕС);
 *    try {
 *      ЗВОНОК
 *    } finally {
 *      X();
 *    }
 *
 *  Защищённый диапазон — тело `try` (там реально стоит вызов подписи в
 *  каждом сегодняшнем случае в `lib/relay.ts`). Требуем, чтобы `finally`
 *  шёл СРАЗУ за закрытием `try` (между ними — только пробелы: в этом
 *  репозитории нет `try {} catch {} finally {}` на верхнем уровне таких
 *  функций, только вложенный `catch` ВНУТРИ тела `try`) и чтобы внутри
 *  `finally` реально звался тот же `X()` — иначе `acquireWalletLock` взят,
 *  но не отпущен по этому пути, и защиты фактически нет. */
function lockedSpansAcquireRelease(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /\b(?:const|let|var)\s+(\w+)\s*=\s*await\s+acquireWalletLock\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const varName = m[1];
    const acquireOpenParen = m.index + m[0].length - 1;
    const acquireCloseParen = matchParen(text, acquireOpenParen);
    if (acquireCloseParen === -1) continue;

    const tryRe = /\btry\s*\{/g;
    tryRe.lastIndex = acquireCloseParen;
    const tryMatch = tryRe.exec(text);
    if (!tryMatch) continue;
    const tryBraceIdx = tryMatch.index + tryMatch[0].length - 1;
    const tryCloseIdx = matchBrace(text, tryBraceIdx);
    if (tryCloseIdx === -1) continue;

    const finallyRe = /\bfinally\s*\{/g;
    finallyRe.lastIndex = tryCloseIdx;
    const finallyMatch = finallyRe.exec(text);
    if (!finallyMatch) continue;
    // `finally` обязан идти СРАЗУ за закрытием `try` — только пробелы между.
    if (!/^\s*$/.test(text.slice(tryCloseIdx + 1, finallyMatch.index))) continue;
    const finallyBraceIdx = finallyMatch.index + finallyMatch[0].length - 1;
    const finallyCloseIdx = matchBrace(text, finallyBraceIdx);
    if (finallyCloseIdx === -1) continue;

    const releaseCallRe = new RegExp(`\\b${varName}\\s*\\(`);
    if (!releaseCallRe.test(text.slice(finallyBraceIdx, finallyCloseIdx))) continue;

    spans.push([tryBraceIdx, tryCloseIdx]);
  }
  return spans;
}

/** Индекс `{`, открывающего ТЕЛО функции — считая от закрытия списка
 *  параметров и ПРОПУСКАЯ аннотацию типа возврата между ними. Наивный
 *  `text.indexOf('{', parenCloseIdx)` спотыкается о ПЕРВУЮ `{` в самом типе:
 *  `Promise<{ txHash: string; jobId?: string }>` — то есть находил бы фигурную
 *  скобку объектного типа, а не тела функции, и `matchBrace` от неё закрывал бы
 *  тело в ОДНУ строку (замерено на `_sendForwardRequest`: без этой пропайки
 *  тело считалось строкой 502-502 вместо настоящих 502-580). Здесь `<`, `(`,
 *  `[` в позиции типа возврата ОДНОЗНАЧНО открывающие скобки, не операторы
 *  сравнения — эта неоднозначность существует только внутри тела функции,
 *  куда мы ещё не дошли. */
function findBodyBrace(text: string, parenCloseIdx: number): number {
  let depth = 0;
  for (let i = parenCloseIdx + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '>') { if (depth > 0) depth--; }
    else if (c === '{') {
      if (depth === 0) return i;
      depth++;
    } else if (c === '}') {
      if (depth > 0) depth--;
    }
  }
  return -1;
}

/** Тела НЕэкспортируемых функций файла — кандидаты на «приватный хелпер,
 *  защищённый вызывающим». Экспортные функции не считаем: у них может быть
 *  сколько угодно вызывающих ВНЕ файла, и «где-то в файле есть защищённый
 *  вызов» тогда ничего не доказывает. */
function privateHelperBodies(text: string): Array<{ name: string; bodyStart: number; bodyEnd: number }> {
  const out: Array<{ name: string; bodyStart: number; bodyEnd: number }> = [];
  const re = /(^|\n)([ \t]*)async function\s+(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = m[3];
    const parenOpenIdx = m.index + m[0].length - 1;
    const parenCloseIdx = matchParen(text, parenOpenIdx);
    if (parenCloseIdx === -1) continue;
    const braceIdx = findBodyBrace(text, parenCloseIdx);
    if (braceIdx === -1) continue;
    const braceCloseIdx = matchBrace(text, braceIdx);
    if (braceCloseIdx === -1) continue;
    out.push({ name, bodyStart: braceIdx, bodyEnd: braceCloseIdx });
  }
  return out;
}

/** Номер строки (1-based) индекса символа `idx` в `text` — используется
 *  только для читаемого отчёта офендеров. */
function lineOf(text: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * Индексы (и читаемые `path:line`) вызовов подписи, которые НЕ лежат внутри
 * защищённого раскроя.
 *
 * ⚠️ ЧЕГО ЭТА ПРОВЕРКА НЕ ДЕЛАЕТ — сказано вслух, а не спрятано:
 *
 *   - Это счётчик скобок по тексту БЕЗ комментариев, а НЕ разбор синтаксиса
 *     (AST). Строковый литерал или JSX-текст с непарной скобкой внутри собьёт
 *     баланс молча. В сегодняшнем коде рядом с вызовами подписи такого нет —
 *     но полагаться на это вслепую в будущем файле нельзя.
 *   - Понимает «приватный вызов защищён вызывающим» РОВНО НА ОДИН ХОП: если
 *     вызов подписи сидит в теле НЕэкспортируемой функции этого же файла, а
 *     ИМЯ этой функции зовётся (буквально, `имя(`) из места, которое уже
 *     внутри защищённого диапазона — засчитывает как защищённый (в этом
 *     репозитории это ровно `_sendForwardRequest` в `lib/relay.ts`,
 *     приватный хелпер двенадцати обёрток `*Gasless`). Хелпер, зовущий ДРУГОЙ
 *     хелпер, который уже зовёт подпись, — два хопа — тест не распутает и
 *     засчитает как офендера: то есть ошибётся в БЕЗОПАСНУЮ сторону (ложный
 *     красный, не ложный зелёный).
 *   - Не проверяет, что мьютекс взят по ТОМУ ЖЕ адресу, что подписывает
 *     кошелёк, — только что вызов лексически внутри защищённого диапазона.
 *     `withWalletLock(чужойАдрес, () => сюдаПодписьВерногоАдреса)` тест не
 *     поймает.
 *   - Не ловит передачу подписчика ПО ССЫЛКЕ без вызова в скобках
 *     (`withWalletLock(addr, someNamedSigner)`, где `someNamedSigner` сам
 *     где-то дальше зовёт подпись) — засчитает такой файл офендером, даже
 *     если по факту он защищён. В сегодняшнем коде такого раскроя нет (везде
 *     явные стрелочные обёртки), но если он появится — тест ложно покраснеет,
 *     а не ложно промолчит.
 */
function unlockedSignCalls(f: { path: string; text: string }): string[] {
  const { text } = f;
  const lockedSpans = [...lockedSpansWithWalletLock(text), ...lockedSpansAcquireRelease(text)];
  const isLocked = (idx: number) => lockedSpans.some(([s, e]) => idx > s && idx < e);

  const helpers = privateHelperBodies(text);
  const protectedHelperNames = new Set<string>();
  for (const h of helpers) {
    const callRe = new RegExp(`\\b${h.name}\\s*\\(`, 'g');
    let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(text))) {
      if (cm.index >= h.bodyStart && cm.index < h.bodyEnd) continue; // вызов самой себя внутри своего же тела — не в счёт
      if (isLocked(cm.index)) { protectedHelperNames.add(h.name); break; }
    }
  }

  const offenders: string[] = [];
  const scanRe = new RegExp(WALLET_SIGN_CALL.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = scanRe.exec(text))) {
    const idx = m.index;
    if (isLocked(idx)) continue;
    const enclosing = helpers.find(h => idx > h.bodyStart && idx < h.bodyEnd);
    if (enclosing && protectedHelperNames.has(enclosing.name)) continue;
    offenders.push(`${f.path}:${lineOf(text, idx)}`);
  }
  return offenders;
}

describe('пути подписи', () => {
  it('каждый ВЫЗОВ подписи лежит внутри withWalletLock/acquireWalletLock — не просто соседствует с импортом', () => {
    const offenders = SIGNING_FILES
      .filter(f => f.path !== 'lib/walletLock.ts')
      .flatMap(f => unlockedSignCalls(f));

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
      // ⚠️ ПРЕЖНЯЯ ЧЕСТНАЯ ОГОВОРКА ЗДЕСЬ БОЛЬШЕ НЕ ВЕРНА, и её надо было
      // переписать, а не оставить: докстринг, отставший от дела, врёт ровно так
      // же, как враньё в другую сторону. Тут было написано «это НЕ по нажатию:
      // пропуск спрашивает подпись при открытии чата». С починкой чата на
      // телефоне (9 августа) это стало неправдой в двух местах сразу:
      //
      //  1. пока страница СКРЫТА, подпись не запрашивается вовсе — ни ключа, ни
      //     пропуска (`lib/chatSignatureGate.ts`; замер: 1 окно → 0);
      //  2. если кошелёк только что уводил страницу из глаз — а на телефоне он
      //     отдельное приложение и уводит всегда, — следующую подпись запускает
      //     ЧЕЛОВЕК нажатием («Подтвердить», `ChatKeyNotAnnounced`). Замер: после
      //     первой подписи вторая уходила сама (2 окна), теперь ждёт нажатия (1).
      //
      // На десктопе (кошелёк-расширение, страница не пропадает) обе подписи
      // по-прежнему идут подряд и без нажатий — замерено, путь не удлинился.
      // Плюс пропуск РАДИ ЯЩИКА теперь не берётся, пока свой ключ не объявлен в
      // справочнике: запечатать нам нечем, значит и подписывать нечего.
      //
      // Ключ переписки спрашивается один раз в жизни устройства
      // (`chatSession.ts`). Оба под общим мьютексом кошелька.
      'hooks/useChatSession.ts',
      // Заверение ключей чата кошельком (4в-1, §15.2). `signChatKeyAttestation`
      // зовётся ТОЛЬКО из `ensureChatKeyAttestation`, а та — только по
      // человеческому действию (нажатие «заверить»/«предъявить арбитру» в
      // будущем экране 4в-2): `publishChatKeys` в `useChatSession.ts` возит из
      // кладовой ТОЛЬКО уже подписанное и подписи не просит никогда (см. шапку
      // `chatKeyAttestation.ts` про петлю на Android 31 июля). Мьютекс взят
      // прямо в точке вызова кошелька, а не у будущего вызывающего экрана.
      'lib/chatKeyAttestation.ts',
      'lib/relay.ts',                    // гейслесс-действия — все по нажатию
    ]);
  });
});

describe('автоматических подписей не осталось', () => {
  // ⚠️ ТРИ ЗАМКА ОТСЮДА УБРАНЫ ВМЕСТЕ С ТЕМ, ЧТО ОНИ СТЕРЕГЛИ (6 августа 2026).
  //
  // Они стерегли `Client.create()` XMTP — единственный конструктор,
  // принимавший сайнера, то есть единственный, способный попросить подпись из
  // автоматики. Ни `lib/xmtp.ts`, ни `contexts/XmtpContext.tsx` больше не
  // существуют; замок на несуществующий файл — не замок, а зелёная галочка ни
  // о чём.
  //
  // Само свойство при этом НЕ осталось без охраны, и охрана стала строже:
  // «ни один модуль в src/ не импортирует XMTP» (`lib/noXmtpImports.test.ts`,
  // разбор дерева импортов) плюс замок «места подписи наперечёт» выше — он
  // теперь называет ВОСЕМЬ файлов вместо девяти, и любой новый в списке
  // требует осознанного решения, а не молчаливого прохода.

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
