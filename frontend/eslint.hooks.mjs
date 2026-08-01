// TEMPORARY, one-off: hooks-only lint pass.
// The repo-wide `npm run lint` is broken (OPEN-ITEMS #18: eslint ^9 vs
// @typescript-eslint ^7 vs eslint-config-next 15.5.15). This config sidesteps
// all of that and loads *only* eslint-plugin-react-hooks.
//   node node_modules/eslint/bin/eslint.js -c eslint.hooks.mjs "src/**/*.{ts,tsx}"
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

const noop = { create: () => ({}) };

export default [
  {
    files: ["src/**/*.{ts,tsx,js,jsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      // Stubs: files carry inline `eslint-disable` comments for rules that this
      // minimal config does not load. Without stubs ESLint reports
      // "Definition for rule ... was not found" and drowns the real signal.
      "@typescript-eslint": { rules: { "no-explicit-any": noop } },
      "@next/next": { rules: { "no-img-element": noop } },
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@next/next/no-img-element": "off",
    },
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
];
