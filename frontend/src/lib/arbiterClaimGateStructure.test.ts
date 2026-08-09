import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Структурный замок на Задачу 4: третья автоподпись `handleClaim` (страница
 * арбитра) обязана быть под гейтом, а сам ключ обязан добываться ТОЛЬКО по
 * нажатию — никогда реактивно на входе на страницу.
 *
 * Рендерить страницу нечем (нет jsdom/@testing-library, `npm test` берёт
 * vitest у релеера, окружение `node`), поэтому обе проверки — структурные, по
 * исходнику. Прецедент такого чтения — `disputeBounty.test.ts:140-148`,
 * `claimAbiMatchesContract.test.ts`, `signaturePaths.test.ts`.
 *
 * ⚠️ ЗАМЕРЕНО, ЧТО ЗАМКА НЕ БЫЛО. Убрав обе строки `requireSignatureGate(false);`
 * из `handleClaim` (мутация Шага 8, пункт 2) и прогнав `npm test`, получили
 * 0 красных из 1799 — гейт был подключен без единой проверки, ровно тот
 * класс дыры, который CLAUDE.md называет «замок, который ищет имя, а не
 * употребление». Этот файл — та самая недостающая проверка.
 *
 * ⚠️⚠️ ЧЕСТНО О ТОМ, ЧЕГО ЭТОТ ФАЙЛ НЕ ЛОВИТ (найдено независимым ревью
 * Задачи 4, круг доработки). Этот замок читает ТЕКСТ: он видит, что вызов
 * `requireSignatureGate(false)` стоит между нужными строками, и всё. Он НЕ
 * умеет проверить, что этот вызов имеет хоть какую-то власть — а власть у
 * него ровно такая, сколько раз до него позвали `noteWalletHandoff()`.
 * Ревьюер убрал `noteWalletHandoff()` из обёртки подписи, оставив
 * `requireSignatureGate(false)` на прежнем месте: `npm test` дал 0 красных
 * из 1804. Вызов синтаксически стоит где надо, а порог всегда решает
 * «можно» — пустышка, неотличимая от рабочего кода по тексту файла.
 *
 * Это свойство — «отметка ДО подписи, по факту исполнения» — ловится не
 * здесь, а поведенческими тестами `arbiterClaimKeys.test.ts`
 * (`createGatedSignChatKey`): они вызывают настоящий код с подставными
 * функциями и проверяют ПОРЯДОК вызовов, а не взаимное расположение строк.
 * Ниже добавлена только проверка, что страница зовёт ИМЕННО эти вынесенные
 * функции, а не пересобирает тот же приём сама — если пересобирает, замок в
 * `arbiterClaimKeys.test.ts` защищает код, которым никто не пользуется.
 *
 * ⚠️⚠️⚠️ ТРЕТИЙ СЛОЙ ТОЙ ЖЕ БОЛЕЗНИ (третий круг ревью). Ревьюер нашёл, что
 * поведенческие тесты выше защищают лишь ВЫЗОВ функций
 * `createGatedSignChatKey`/(бывшего) `canRetryRevealAsFreshCommit`, но
 * ничем не защищают, что их РЕЗУЛЬТАТ действительно используется:
 *   1. `createGatedSignChatKey(rawSignChatKey)` позвать, а результат
 *      выбросить, подставив дальше голый `rawSignChatKey`, — компилировалось
 *      (тип был структурным `SignChatKey`), и `npm test` был зелёным;
 *   2. `if (!canRetryRevealAsFreshCommit(revealErr)) throw revealErr;` →
 *      `canRetryRevealAsFreshCommit(revealErr);` — вызов остался, `if`/`throw`
 *      исчезли, ответ никто не смотрит, тесты падать не могли — предикат
 *      честно возвращал `false`, просто в пустоту.
 * Общая форма — «вызов виден в тексте, а его результат никто не смотрит» —
 * это ТРЕТИЙ уровень того же класса дыры, и её нельзя закрыть ЕЩЁ одним
 * тестом: следующий обход написал бы себе новый способ проигнорировать
 * результат новой проверки. Закрыто ФОРМОЙ, не проверкой:
 *   - `createGatedSignChatKey` теперь возвращает фирменный (nominal) тип
 *     `GatedSignChatKey` (`arbiterClaimKeys.ts`), а `deriveClaimChatKeys`
 *     принимает ТОЛЬКО его — подмену на голый `SignChatKey` красит
 *     `npm run type-check`, ДО всякого запуска тестов;
 *   - предикат `canRetryRevealAsFreshCommit` заменён действием
 *     `rethrowIfSignatureDeferred(err): void` — оно либо бросает само, либо
 *     не бросает; результата, который можно не посмотреть, у него нет.
 *
 * ЧЕСТНО: этот файл (структурный, по тексту) в принципе НЕ МОЖЕТ отличить
 * «результат вызова использован» от «вызов сделан впустую» — он читает
 * текст, а не поток данных. Раньше это было дырой; теперь, когда обход не
 * компилируется (пункт 1) и обходить нечего (пункт 2, действие вместо
 * решения), это уже не дыра, а просто честно названная граница инструмента.
 */

const PAGE_PATH = new URL('../app/arbiter/page.tsx', import.meta.url);
const RAW = readFileSync(PAGE_PATH, 'utf8');

/** Строки кода без комментариев — тот же приём, что в `signaturePaths.test.ts`:
 *  полноценный разбор синтаксиса здесь опаснее пользы, а код в этом файле
 *  никогда не начинается с `//` или `*`. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter(line => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .map(line => line
      .replace(/\/\*[^\n]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/, '$1 '))
    .join('\n');
}

const CODE = codeOnly(RAW);

/** Тело `handleClaim` целиком, от объявления до закрывающей `};` на уровне
 *  функции. Балансом фигурных скобок — тело плоское, без JSX, скобки в нём
 *  идут только от блоков и шаблонных `${...}`, и те и другие парные. */
function extractHandleClaim(code: string): string {
  const start = code.indexOf('const handleClaim = async');
  if (start === -1) throw new Error('handleClaim не найден в arbiter/page.tsx');
  const bodyStart = code.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  throw new Error('не нашли парную закрывающую скобку handleClaim');
}

const HANDLE_CLAIM = extractHandleClaim(CODE);

/** Индексы всех вхождений подстроки, по порядку. */
function indicesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return out;
}

describe('handleClaim: гейт подписи на пути добычи ключа', () => {
  it('оба пути заявки добывают ключ (deriveClaimChatKeys встречается дважды)', () => {
    // Два места — быстрый путь (соль уже была) и полный (свежий коммит).
    // Задача 2 оставляла здесь по TODO_BOX_KEY/TODO_SIGN_KEY в обоих; если
    // осталась заглушка хоть в одном, вызовов будет меньше двух.
    expect(indicesOf(HANDLE_CLAIM, 'deriveClaimChatKeys(')).toHaveLength(2);
    expect(HANDLE_CLAIM).not.toMatch(/TODO_BOX_KEY|TODO_SIGN_KEY/);
  });

  it('каждая добыча ключа стоит МЕЖДУ добычей и следующей заявкой claimDisputeGasless', () => {
    // Главное свойство задачи: гейт стоит НЕ где попало в файле, а именно на
    // критическом отрезке — после того, как кошелёк вернул ключ (и мог
    // заморозить страницу), и до следующего автоматического обращения к
    // кошельку (заявка). Порядок, не просто присутствие.
    const deriveCalls = indicesOf(HANDLE_CLAIM, 'deriveClaimChatKeys(');
    const claimCalls = indicesOf(HANDLE_CLAIM, 'claimDisputeGasless(');
    const gateCalls = indicesOf(HANDLE_CLAIM, 'requireSignatureGate(false)');

    expect(deriveCalls).toHaveLength(2);
    expect(claimCalls).toHaveLength(2);
    expect(gateCalls).toHaveLength(2);

    deriveCalls.forEach((deriveAt, i) => {
      const claimAt = claimCalls[i];
      expect(claimAt, 'claimDisputeGasless обязан идти ПОСЛЕ добычи ключа').toBeGreaterThan(deriveAt);

      const gateBetween = gateCalls.some(g => g > deriveAt && g < claimAt);
      expect(
        gateBetween,
        `requireSignatureGate(false) не найден между добычей ключа №${i + 1} и её claimDisputeGasless — ` +
        `при заморозке страницы в кошельке третья автоподпись улетела бы в спящую вкладку`,
      ).toBe(true);
    });
  });

  it('отсрочка гейта обрабатывается отдельно от общей ошибки (isSignatureDeferred)', () => {
    // Без этого отказ порога показался бы человеку как «ошибка», а не как
    // просьба нажать ещё раз — и увёл бы с экрана того, кто ничего не сломал.
    expect(HANDLE_CLAIM).toMatch(/isSignatureDeferred\(err\)/);
  });

  it('подписывающая обёртка — из createGatedSignChatKey, а не собрана на странице своими руками', () => {
    // Дополнено кругом доработки. Поведение (порядок «отметили → подписали»)
    // доказывает `arbiterClaimKeys.test.ts` — здесь только проверка, что
    // страница действительно зовёт ТУ САМУЮ функцию, а не завела рядом
    // вторую копию того же приёма, которую никакой тест не видит.
    expect(RAW).toMatch(/from\s+['"]@\/lib\/arbiterClaimKeys['"]/);
    expect(CODE).toMatch(/createGatedSignChatKey\s*\(/);
    // Прямой вызов noteWalletHandoff() на странице означал бы, что отметка
    // ухода снова пишется тут же вручную — ровно тот разъезд, из-за
    // которого мутация ревьюера дала 0 красных до этого круга доработки.
    expect(CODE).not.toMatch(/\bnoteWalletHandoff\s*\(/);
  });

  it('проброс отсрочки reveal — из rethrowIfSignatureDeferred, а не переписан в catch', () => {
    expect(CODE).toMatch(/rethrowIfSignatureDeferred\s*\(\s*revealErr\s*\)/);
  });
});

describe('страница арбитра не заводит ключ реактивно', () => {
  it('useChatSession() на странице не смонтирован', () => {
    // Решение владельца 9 августа: «никаких заранее быть не может». Хук
    // реактивный — при уже взведённом `_armed` (человек заходил в чат с
    // другой страницы этой же вкладки) он завёл бы ключ на ВХОДЕ на страницу
    // арбитра, без всякого нажатия «Взяться за спор». Замер этого на живом
    // рендере снять нечем (нет jsdom), поэтому граница — по исходнику:
    // хука здесь нет и не должно быть вовсе, ни в импортах, ни в вызове.
    expect(RAW).not.toMatch(/from\s+['"]@\/hooks\/useChatSession['"]/);
    expect(CODE).not.toMatch(/\buseChatSession\s*\(/);
  });

  it('ключ добывается только явным вызовом openSession через deriveClaimChatKeys', () => {
    expect(RAW).toMatch(/from\s+['"]@\/lib\/arbiterClaimKeys['"]/);
    expect(CODE).toMatch(/\bderiveClaimChatKeys\s*\(/);
  });
});

/**
 * Задача 5. ЗАМЕРЕНО, ЧТО БЕЗ ЭТОЙ ПРОВЕРКИ ЗАМКА НЕ БЫЛО: заменить строку
 * `const showNoKeyNotice = decideNoKeyNotice({ keys: ..., error: ... });` на
 * собственноручное условие такой же формы (`!error && !!keys && (keys[0] ===
 * ZERO || keys[1] === ZERO)`) и прогнать `npm test` — 0 красных из 1823.
 * `arbiterNoticeDecision.test.ts` защищает саму функцию `decideNoKeyNotice`
 * (arbiterChatKey.ts), но ничем не защищает, что страница арбитра реально её
 * ЗОВЁТ, а не пересобирает то же условие рядом, без разбора «отказ чтения ≠
 * ключа нет» — тот самый класс дыры, что CLAUDE.md называет «замок, который
 * ищет имя, а не употребление» (см. заголовок файла, третий круг ревью
 * Задачи 4, тот же приём для createGatedSignChatKey/rethrowIfSignatureDeferred
 * выше).
 */
describe('дисклеймер «нет ключа» решается через decideNoKeyNotice, а не переписан на странице', () => {
  it('showNoKeyNotice — результат вызова decideNoKeyNotice(...), не своего условия', () => {
    expect(RAW).toMatch(/from\s+['"]@\/lib\/arbiterChatKey['"]/);
    expect(CODE).toMatch(/\bshowNoKeyNotice\s*=\s*decideNoKeyNotice\s*\(/);
  });
});

/**
 * ЗАМЕРЕНО, ЧТО БЕЗ ЭТОЙ ПРОВЕРКИ ЗАМКА НЕ БЫЛО: убрав саму разметку
 * дисклеймера из `MyCaseCard` целиком (JSX-блок с текстом и кнопкой), оставив
 * `showNoKeyNotice`/`onPublishKey` объявленными, но нигде не отрисованными —
 * `npm test` дал 0 красных из 1824, `npm run type-check` тоже чист
 * (неиспользуемые пропсы не запрещены tsconfig'ом). Проверка выше в этом файле
 * защищает только ВЫЧИСЛЕНИЕ `showNoKeyNotice`, а не то, что карточка спора
 * его реально показывает арбитру, — тот же класс дыры, вид сверху.
 *
 * ⚠️ ДВЕ ОТДЕЛЬНЫЕ СЛАБОСТИ, НАЙДЕНЫ НЕЗАВИСИМЫМ РЕВЬЮ.
 *
 * 1) Резать нужно из `CODE` (без комментариев), а не из `RAW` — как и более
 *    ранние проверки в этом файле, сделано нарочно ради строгости. Первая
 *    версия этого замка резала `MY_CASE_CARD` из `RAW` — закомментированный
 *    (например, обёрнутый в `{/* ... *\/}`) блок остаётся в `RAW` как текст,
 *    и регэксп ниже нашёл бы совпадение внутри мёртвого комментария так же
 *    охотно, как внутри рабочего кода. Резка по `CODE` не даёт закомментированному
 *    коду засчитаться доказательством — тем же приёмом, что уже применяется
 *    выше в этом файле для `handleClaim`.
 *
 * 2) ⚠️⚠️ ЭТО НЕ ЧИНИТСЯ РЕЗКОЙ ПО `CODE`, И ЭТО НАДО ПРИЗНАТЬ ЧЕСТНО.
 *    Независимое ревью обернуло рабочий (не закомментированный) JSX-блок в
 *    заведомо ложное условие — `{false && isMineClaim && showNoKeyNotice &&
 *    (...)}` — и получило 0 красных: подстрока `isMineClaim && showNoKeyNotice`
 *    как была в тексте, так и осталась, просто перед ней появилось `false &&`.
 *    Блок отныне НЕДОСТИЖИМ (ни один арбитр кнопку не увидит), но текстовый
 *    поиск этого не видит — он ищет ПОДСТРОКУ, а не вычисляет, входит ли она
 *    в исполняемую ветку. Это ДРУГОЙ класс слабости, чем «звонок сделан, а
 *    результат не смотрят» (докстринг файла выше, про
 *    createGatedSignChatKey/rethrowIfSignatureDeferred): там речь про то,
 *    используется ли РЕЗУЛЬТАТ вызова; здесь — про то, что текстовый поиск в
 *    принципе не умеет отличить «код в исполняемой ветке» от «тот же текст
 *    внутри всегда-ложного условия». Настоящий поведенческий замок на
 *    разметку требует окружения отрисовки (jsdom/@testing-library), которого
 *    в проекте нет ни для одной страницы — записано отдельным открытым
 *    вопросом, не в этом круге.
 */
function extractMyCaseCard(code: string): string {
  const start = code.indexOf('function MyCaseCard(');
  if (start === -1) throw new Error('MyCaseCard не найден в arbiter/page.tsx');
  const end = code.indexOf('function HistoryRow(', start);
  if (end === -1) throw new Error('не нашли конец MyCaseCard (маркер функции HistoryRow)');
  return code.slice(start, end);
}

const MY_CASE_CARD = extractMyCaseCard(CODE);

describe('дисклеймер «нет ключа» реально отрисован в карточке взятого спора', () => {
  it('показывается только для карточки ЭТОГО арбитра и когда showNoKeyNotice истинно', () => {
    expect(MY_CASE_CARD).toMatch(/isMineClaim\s*&&\s*showNoKeyNotice/);
  });

  it('кнопка зовёт onPublishKey, текст и надпись кнопки — из локалей no_key_notice/publish_key', () => {
    expect(MY_CASE_CARD).toMatch(/onClick=\{onPublishKey\}/);
    expect(MY_CASE_CARD).toMatch(/t\(\s*["']arbiter\.no_key_notice["']\s*\)/);
    expect(MY_CASE_CARD).toMatch(/t\(\s*["']arbiter\.publish_key["']\s*\)/);
  });
});
