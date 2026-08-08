/**
 * noXmtpImports.test.ts — гейт «XMTP выключен» (Задача 7 плана «Клиент чата»).
 *
 * ⚠️ ЭТО НЕ ПОИСК СЛОВ. План требует дословно: «проверяется разбором импортов,
 * не поиском слов», и требование куплено дорого — в этом проекте `grep` по
 * исходникам уже отвечал «чисто» на файле, где импорт стоял, но переносился
 * иначе, и отвечал «грязно» на файле, где слово встречалось только в
 * комментарии. Поэтому здесь модуль-спецификаторы собираются РАЗБОРОМ
 * СИНТАКСИСА (`typescript`, `createSourceFile` → обход узлов): все четыре
 * формы, которыми в этом коде вообще можно притащить чужой модуль —
 * `import ... from`, `export ... from`, `import(...)` и `require(...)`.
 *
 * Комментарии, строковые литералы и имена переменных, где встречается слово
 * «xmtp», гейт не трогает по построению — и это заперто отдельным замком
 * («гейт читает дерево импортов, а не слова»), а не заявлено на словах.
 *
 * Почему «ни один файл в src/», а не «ничего не достижимо из точек входа»:
 * первое строго сильнее и не требует угадывать список точек входа Next.js
 * (страницы, лейауты, `route.ts`, воркеры — их находит сборщик, не мы).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Все исходники фронта. Тесты включены намеренно: тест, который тянет
 *  удалённый модуль, — такой же сломанный импорт, как и рабочий код. */
function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...allSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Спецификаторы модулей одного файла — из дерева разбора, а не из текста.
 *
 * `import('typescript')` динамическим: пакет есть в `frontend/node_modules`
 * (им же работает `npm run type-check`), но статический импорт заставил бы
 * vitest тянуть его при сборе КАЖДОГО тестового файла.
 */
async function moduleSpecifiersOf(source: string, fileName: string): Promise<string[]> {
  const tsSpecifier = 'typescript';
  const ts = (await import(/* @vite-ignore */ tsSpecifier)) as typeof import('typescript');
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: import('typescript').Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) found.push(spec.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const arg = node.moduleReference.expression;
      if (ts.isStringLiteral(arg)) found.push(arg.text);
    } else if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const first = node.arguments[0];
      if ((dynamicImport || requireCall) && first && ts.isStringLiteral(first)) found.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Спецификатор ведёт в XMTP? Два случая:
 *  - сам пакет (`@xmtp/browser-sdk`, `@xmtp/node-sdk`, …);
 *  - наш модуль-обвязка (`@/lib/xmtp`, `./xmtpErrors`, `@/contexts/XmtpContext`,
 *    `@/hooks/useXmtpNotifications`) — сравнивается ПОСЛЕДНИЙ сегмент пути,
 *    чтобы каталог с таким именем в середине не давал ложного срабатывания.
 */
function leadsToXmtp(specifier: string): boolean {
  if (/^@xmtp(\/|$)/.test(specifier)) return true;
  const last = specifier.split('/').pop() ?? '';
  return /xmtp/i.test(last);
}

/** Модули XMTP-обвязки, которые Задача 7 удаляет вместе с их тестами. */
const REMOVED_MODULES = [
  'lib/xmtp.ts',
  'lib/xmtpPairGroup.ts',
  'lib/xmtpBotMembership.ts',
  'lib/xmtpDelivery.ts',
  'lib/xmtpErrors.ts',
  'lib/xmtpTabLock.ts',
  'lib/xmtpPairGroup.test.ts',
  'lib/xmtpBotMembership.test.ts',
  'lib/xmtpDelivery.test.ts',
  'lib/xmtpErrors.test.ts',
  'lib/xmtpTabLock.test.ts',
  'contexts/XmtpContext.tsx',
  'hooks/useXmtpNotifications.ts',
  'hooks/useXmtpFailureText.ts',
];

describe('XMTP выключен', () => {
  it('ни один модуль в src/ не импортирует XMTP', async () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles(SRC_DIR)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const spec of await moduleSpecifiersOf(source, file)) {
        if (leadsToXmtp(spec)) {
          offenders.push(`${path.relative(SRC_DIR, file)} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('удалённые модули XMTP-обвязки отсутствуют на диске', () => {
    const alive = REMOVED_MODULES.filter(rel => fs.existsSync(path.join(SRC_DIR, rel)));
    expect(alive).toEqual([]);
  });

  it('гейт читает ДЕРЕВО ИМПОРТОВ, а не слова', async () => {
    // Слово есть везде, где его хватило бы поиску, — и ни одного импорта.
    const looksGuilty = [
      "// import { Client } from '@xmtp/browser-sdk';",
      "const url = 'https://xmtp.chat';",
      "let xmtpStatus = 'ready';",
      "export function useXmtpFailureText() { return null; }",
      "/* from '@/lib/xmtp' */",
    ].join('\n');
    expect(await moduleSpecifiersOf(looksGuilty, 'probe.ts')).toEqual([]);

    // А настоящие импорты — все четыре формы — гейт видит.
    const reallyGuilty = [
      "import { Client } from '@xmtp/browser-sdk';",
      "export { toIdentifier } from '@/lib/xmtp';",
      "const m = await import('@/contexts/XmtpContext');",
      "const n = require('./xmtpErrors');",
    ].join('\n');
    expect(await moduleSpecifiersOf(reallyGuilty, 'probe.ts')).toEqual([
      '@xmtp/browser-sdk',
      '@/lib/xmtp',
      '@/contexts/XmtpContext',
      './xmtpErrors',
    ]);
    // И все четыре опознаются как XMTP.
    for (const spec of ['@xmtp/browser-sdk', '@/lib/xmtp', '@/contexts/XmtpContext', './xmtpErrors']) {
      expect(leadsToXmtp(spec)).toBe(true);
    }
    // А посторонние — нет (замок, который запирает всех, — не замок).
    for (const spec of ['react', '@/lib/chatTransport', './chatSession', 'wagmi']) {
      expect(leadsToXmtp(spec)).toBe(false);
    }
  });
});
