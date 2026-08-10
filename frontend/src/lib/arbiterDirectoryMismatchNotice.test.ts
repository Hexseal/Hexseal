/**
 * arbiterDirectoryMismatchNotice.test.ts — расхождение цепи и справочника
 * доходит до человека (финальное ревью, находка №2).
 *
 * Замер ревьюера, который вскрыл дыру: он переименовал
 * `compareChainWithDirectory` и `readArbiterChatKeysFromChain` →
 * `npm run type-check` дал 0 ошибок. Единственные ссылки на обе функции были
 * их СОБСТВЕННЫМИ тестами — боевых потребителей не было ни одного, страница
 * читала цепь своим инлайновым `useReadContract`, и расхождение не
 * вычислялось нигде.
 *
 * Решение владельца 9 августа: расхождение обязано быть проговорено. Ниже —
 * структурный замок (страница не рендерится, jsdom нет — тот же приём, что
 * `arbiterClaimGateStructure.test.ts`) на то, что:
 *   1. страница читает ключ ЧЕРЕЗ `readArbiterChatKeysFromChain`, а не своим
 *      инлайновым вызовом;
 *   2. рядом читается справочник (`fetchPeerChatKeys`) и оба сравниваются
 *      через `compareChainWithDirectory`;
 *   3. вердикт решается через `decideDirectoryDivergenceNotice`, а не своим
 *      условием на месте — прежний класс дыры («замок, который ищет имя, а
 *      не употребление») для `showNoKeyNotice` уже случался в этом же файле,
 *      и лечился ровно так;
 *   4. дисклеймер РЕАЛЬНО отрисован, а не только вычислен.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const PAGE_PATH = new URL('../app/arbiter/page.tsx', import.meta.url);
const RAW = readFileSync(PAGE_PATH, 'utf8');

/** Строки кода без комментариев — тот же приём, что `arbiterClaimGateStructure.test.ts`. */
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

describe('чтение ключа арбитра идёт через точку доверия, не инлайновым useReadContract', () => {
  it('импортирует и зовёт readArbiterChatKeysFromChain', () => {
    expect(RAW).toMatch(/from\s+['"]@\/lib\/arbiterChatKey['"]/);
    expect(CODE).toMatch(/\breadArbiterChatKeysFromChain\s*\(/);
  });

  it('никакого своего инлайнового useReadContract на getArbiterChatKeys не осталось', () => {
    // Раньше страница читала getArbiterChatKeys() СВОИМ отдельным вызовом
    // useReadContract — вторым, несинхронизированным с точкой доверия чтением
    // того же самого. Строки "getArbiterChatKeys" на странице быть не должно
    // вовсе: единственное место, которому позволено её знать, — сама
    // readArbiterChatKeysFromChain (arbiterChatKey.ts), не эта страница.
    expect(RAW).not.toMatch(/getArbiterChatKeys/);
  });
});

describe('своя же публикация в справочнике читается и сравнивается с цепью', () => {
  it('зовёт fetchPeerChatKeys (справочник) и compareChainWithDirectory', () => {
    expect(RAW).toMatch(/from\s+['"]@\/hooks\/useChatSession['"]/);
    expect(CODE).toMatch(/\bfetchPeerChatKeys\s*\(/);
    expect(CODE).toMatch(/\bcompareChainWithDirectory\s*\(/);
  });

  it('отказ чтения справочника не роняет решение — обёрнут try/catch', () => {
    // directory_missing покрывает и "справочник не знает", и "справочник не
    // ответил": оба ведут к null на входе compareChainWithDirectory, а не к
    // необработанному throw внутри эффекта.
    const fetchAt = CODE.indexOf('fetchPeerChatKeys(');
    expect(fetchAt).toBeGreaterThan(-1);
    const before = CODE.slice(Math.max(0, fetchAt - 200), fetchAt);
    expect(before, 'fetchPeerChatKeys не в try-блоке рядом').toMatch(/\btry\s*\{/);
  });

  it('вердикт решается через decideDirectoryDivergenceNotice, а не переписан на странице', () => {
    expect(CODE).toMatch(/\bshowDirectoryMismatchNotice\s*=\s*decideDirectoryDivergenceNotice\s*\(/);
  });
});

describe('дисклеймер расхождения реально отрисован, а не только вычислен', () => {
  it('JSX показывает arbiter.key_directory_mismatch под showDirectoryMismatchNotice', () => {
    // ЗАМЕРЕНО НА СОСЕДНЕМ ДИСКЛЕЙМЕРЕ (showNoKeyNotice, тот же файл выше):
    // вычисление решения без реальной отрисовки давало 0 красных из 1824.
    // Тот же вопрос здесь: показывается ли РЕЗУЛЬТАТ, а не просто существует.
    expect(CODE).toMatch(/\{showDirectoryMismatchNotice\s*&&/);
    expect(CODE).toMatch(/t\(\s*["']arbiter\.key_directory_mismatch["']\s*\)/);
  });
});
