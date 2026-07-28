import { fileURLToPath } from 'node:url';

/**
 * ЗАЧЕМ ЭТОТ ФАЙЛ
 *
 * У фронта нет своего тест-раннера и поставить его нельзя: `npm install` в
 * `frontend/` падает целиком на этой файловой системе (exFAT не умеет симлинки,
 * которые npm создаёт в `node_modules/.bin` — по той же причине скрипты в
 * package.json зовут `node node_modules/next/dist/bin/next`, а не `next`).
 * Поэтому `npm test` берёт vitest у релеера по пути:
 * `node ../relayer/node_modules/vitest/vitest.mjs run`. Раннер чужой, а корень
 * (`process.cwd()`) при таком запуске — `frontend/`, поэтому конфиг vitest
 * подхватывает здесь сам, без `--config`.
 *
 * Без него тестировать можно было только модули, которые обходятся
 * относительными импортами: `settledRefund.ts` тянет `@/config/contracts`, и на
 * пустом конфиге не собиралось ни то, ни другое —
 *
 *  1. алиас `@` не резолвился (он живёт в `tsconfig.json`, а Vite tsconfig-paths
 *     сам не читает) — «Failed to resolve import "@/config/contracts"»;
 *  2. даже с алиасом `config/contracts.ts` бросает НА ЗАГРУЗКЕ МОДУЛЯ:
 *     `NEXT_PUBLIC_DIAMOND_ADDRESS is not set`. Это не случайность и не то, что
 *     надо обходить в самом модуле — там намеренно нет захардкоженного
 *     fallback'а (см. комментарий у `requiredAddress`), потому что однажды
 *     устаревший literal молча перебил уже исправленный адрес. Значит адреса
 *     обязан давать тот, кто запускает, — здесь это и делается.
 *
 * БЕЗ `defineConfig` намеренно: он импортируется из `vitest/config`, а vitest
 * лежит в `../relayer/node_modules` и из `frontend/` не резолвится (в корне репа
 * его тоже нет). `defineConfig` — функция-тождество для типов, обычный объект
 * vitest принимает так же.
 */

/**
 * Адреса — фиксированные заглушки, НЕ значения разработчика из `.env.local`.
 * Тесты обязаны читаться одинаково на любой машине и в CI, где `.env.local`
 * нет вовсе; ни один тест на эти адреса не смотрит, они нужны только чтобы
 * `config/contracts.ts` догрузился.
 */
const TEST_ENV = {
  NEXT_PUBLIC_DIAMOND_ADDRESS:   '0x0000000000000000000000000000000000000d1a',
  NEXT_PUBLIC_FORWARDER_ADDRESS: '0x000000000000000000000000000000000000f0Fd',
  NEXT_PUBLIC_USDC_ADDRESS:      '0x0000000000000000000000000000000000005dc0',
};

export default {
  resolve: {
    // Тот же алиас, что в `tsconfig.json` → `compilerOptions.paths`. Абсолютный
    // путь обязателен: Vite отдаёт alias в @rollup/plugin-alias как есть.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    env: TEST_ENV,
  },
};
