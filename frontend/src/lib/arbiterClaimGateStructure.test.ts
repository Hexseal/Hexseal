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

/**
 * ⚠️⚠️⚠️⚠️ ЧЕТВЁРТЫЙ СЛОЙ (финальное ревью ветки, находка №1 — «вечная петля на
 * телефоне»). Одиночный `requireSignatureGate(false)` ПОСЛЕ добычи ключа —
 * и НИЧЕГО перед ней — видел СВОЙ ЖЕ уход: `noteWalletHandoff()` внутри
 * `createGatedSignChatKey` взводит отметку, а следующая же (и единственная)
 * проверка гейта читала её как «мы только что были в кошельке». На телефоне
 * это давало отсрочку НА КАЖДОМ нажатии, и выйти было нечем — страница
 * нигде не звала `clearWalletHandoff()`. Замер: 20 нажатий → взято 0.
 *
 * Лечение вынесено в `runGatedKeyAction` (`arbiterClaimKeys.ts`) — общую для
 * всех ТРЁХ мест страницы (быстрый путь заявки, полный путь заявки, кнопка
 * дисклеймера), а не втроём переписанное вручную здесь. Проверки ниже
 * переписаны под эту форму: ищут `runGatedKeyAction(`, а не голый
 * `requireSignatureGate(false)` — он больше не должен появляться в тексте
 * страницы вовсе, только внутри библиотечной функции.
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

/** Тело `handlePublishKey` целиком — тем же приёмом, что `extractHandleClaim`. */
function extractHandlePublishKey(code: string): string {
  const start = code.indexOf('const handlePublishKey = async');
  if (start === -1) throw new Error('handlePublishKey не найден в arbiter/page.tsx');
  const bodyStart = code.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  throw new Error('не нашли парную закрывающую скобку handlePublishKey');
}

const HANDLE_PUBLISH_KEY = extractHandlePublishKey(CODE);

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

  it('оба пути идут через runGatedKeyAction — не переписывают гейт-последовательность вручную', () => {
    // Находка №1 финального ревью: голый requireSignatureGate(false) ПОСЛЕ
    // добычи ключа (и без проверки ДО неё, и без сброса памяти в начале)
    // видел СВОЙ ЖЕ уход и вечно откладывал заявку. Три места страницы
    // обязаны звать ОДНУ общую функцию (runGatedKeyAction,
    // arbiterClaimKeys.ts) — не держать на странице свою копию, которой
    // легко разъехаться с двумя остальными местами.
    const runCalls = indicesOf(HANDLE_CLAIM, 'runGatedKeyAction(');
    expect(runCalls).toHaveLength(2);
    // requireSignatureGate/clearWalletHandoff НЕ должны появляться на
    // странице напрямую — только внутри библиотечной функции. Прямой вызов
    // здесь означал бы вторую, несинхронизированную копию гейта.
    expect(HANDLE_CLAIM).not.toMatch(/\brequireSignatureGate\s*\(/);
    expect(HANDLE_CLAIM).not.toMatch(/\bclearWalletHandoff\s*\(/);
  });

  it('каждая добыча ключа (deriveClaimChatKeys) вложена в СВОЙ runGatedKeyAction, ПЕРЕД claimDisputeGasless', () => {
    // Главное свойство задачи: добыча ключа — первый аргумент
    // runGatedKeyAction, заявка (claimDisputeGasless) — внутри второго.
    // Порядок вложенности, не просто присутствие где-то в файле.
    const runCalls = indicesOf(HANDLE_CLAIM, 'runGatedKeyAction(');
    const deriveCalls = indicesOf(HANDLE_CLAIM, 'deriveClaimChatKeys(');
    const claimCalls = indicesOf(HANDLE_CLAIM, 'claimDisputeGasless(');

    expect(runCalls).toHaveLength(2);
    expect(deriveCalls).toHaveLength(2);
    expect(claimCalls).toHaveLength(2);

    runCalls.forEach((runAt, i) => {
      const deriveAt = deriveCalls[i];
      const claimAt = claimCalls[i];
      expect(deriveAt, 'deriveClaimChatKeys обязан идти ПОСЛЕ открытия runGatedKeyAction(').toBeGreaterThan(runAt);
      expect(claimAt, 'claimDisputeGasless обязан идти ПОСЛЕ добычи ключа').toBeGreaterThan(deriveAt);
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

describe('handlePublishKey (кнопка дисклеймера): тот же гейт, что у handleClaim', () => {
  it('добыча ключа и публикация идут через ту же runGatedKeyAction, вложенно и по порядку', () => {
    const runCalls = indicesOf(HANDLE_PUBLISH_KEY, 'runGatedKeyAction(');
    const deriveCalls = indicesOf(HANDLE_PUBLISH_KEY, 'deriveClaimChatKeys(');
    const publishCalls = indicesOf(HANDLE_PUBLISH_KEY, 'setArbiterChatKeyGasless(');

    expect(runCalls).toHaveLength(1);
    expect(deriveCalls).toHaveLength(1);
    expect(publishCalls).toHaveLength(1);
    expect(deriveCalls[0]).toBeGreaterThan(runCalls[0]);
    expect(publishCalls[0]).toBeGreaterThan(deriveCalls[0]);

    // Третье место — то же требование, что у handleClaim выше: никакой
    // отдельной, ручной копии гейта на этой странице.
    expect(HANDLE_PUBLISH_KEY).not.toMatch(/\brequireSignatureGate\s*\(/);
    expect(HANDLE_PUBLISH_KEY).not.toMatch(/\bclearWalletHandoff\s*\(/);
  });

  it('отсрочка гейта тоже обрабатывается отдельно от общей ошибки', () => {
    expect(HANDLE_PUBLISH_KEY).toMatch(/isSignatureDeferred\(err\)/);
  });
});

describe('страница арбитра не заводит ключ реактивно', () => {
  it('useChatSession() на странице не смонтирован', () => {
    // Решение владельца 9 августа: «никаких заранее быть не может». Хук
    // РЕАКТИВНЫЙ — при уже взведённом `_armed` (человек заходил в чат с
    // другой страницы этой же вкладки) он завёл бы ключ на ВХОДЕ на страницу
    // арбитра, без всякого нажатия «Взяться за спор». Замер этого на живом
    // рендере снять нечем (нет jsdom), поэтому граница — по исходнику: САМ
    // ХУК не должен быть смонтирован ни в импортах, ни в вызове.
    //
    // ⚠️ Находка №2 финального ревью добавила импорт `fetchPeerChatKeys` из
    // ТОГО ЖЕ модуля (`@/hooks/useChatSession`) — это ОБЫЧНАЯ асинхронная
    // функция чтения справочника, не реактивный хук, окна кошелька не просит
    // и ключ не заводит. Поэтому запрет сужен ИМЕННО на символ `useChatSession`
    // в списке импортируемых имён, а не на весь модуль целиком.
    const importLine = RAW.match(/import\s*\{([^}]*)\}\s*from\s*['"]@\/hooks\/useChatSession['"]/);
    if (importLine) {
      const names = importLine[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0]);
      expect(names, 'страница обязана импортировать fetchPeerChatKeys, не сам хук useChatSession')
        .not.toContain('useChatSession');
    }
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
