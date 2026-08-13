// Плоская настройка ESLint.
//
// ⚠️ Переезд на Next 16 (13 августа 2026). Раньше здесь стоял переходник
// `FlatCompat`, который заворачивал `next/core-web-vitals` из старого формата
// в новый. В 16-й версии `eslint-config-next` сам переехал на плоский формат —
// и прогон через переходник давал не понятную ошибку, а
// `TypeError: Converting circular structure to JSON` из недр `@eslint/eslintrc`.
// Теперь настройки берутся напрямую, переходник не нужен.
//
// ⚠️ Рядом лежит `.eslintrc.json` — это НАСЛЕДИЕ старого формата, и ESLint 9
// его больше НЕ ЧИТАЕТ. Правила из него сюда не перенесены намеренно: это
// отдельная работа (там `import/order`, `jsx-a11y` и прочее — на живом коде
// они дадут поток замечаний, который надо разбирать, а не глушить). Файл
// оставлен как запись о том, чего мы хотели, но не забывайте: **он не
// действует**. Не правьте его в надежде что-то изменить.
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...(Array.isArray(coreWebVitals) ? coreWebVitals : [coreWebVitals]),
  ...(Array.isArray(typescript) ? typescript : [typescript]),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
