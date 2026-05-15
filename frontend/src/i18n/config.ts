export const locales = ["en", "ru", "es", "zh", "de", "th"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

export const localeNames: Record<Locale, string> = {
  en: "English",
  ru: "Русский",
  es: "Español",
  zh: "中文",
  de: "Deutsch",
  th: "ภาษาไทย",
};
