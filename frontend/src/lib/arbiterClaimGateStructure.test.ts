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
 * (`createGatedSignChatKey`, `canRetryRevealAsFreshCommit`): они вызывают
 * настоящий код с подставными функциями и проверяют ПОРЯДОК вызовов, а не
 * взаимное расположение строк. Ниже добавлена только проверка, что страница
 * зовёт ИМЕННО эти вынесенные функции, а не пересобирает тот же приём сама
 * — если пересобирает, замок в `arbiterClaimKeys.test.ts` защищает код,
 * которым никто не пользуется.
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

  it('решение по неудавшемуся reveal — из canRetryRevealAsFreshCommit, а не переписано в catch', () => {
    expect(CODE).toMatch(/canRetryRevealAsFreshCommit\s*\(\s*revealErr\s*\)/);
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
