export const locales = [
  "en", "ru", "es", "de", "fr", "it", "pt",
  "uk", "zh-CN", "ja", "ko", "th", "ar", "hi",
] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

export const localeNames: Record<Locale, string> = {
  en:    "English",
  ru:    "Русский",
  es:    "Español",
  de:    "Deutsch",
  fr:    "Français",
  it:    "Italiano",
  pt:    "Português",
  uk:    "Українська",
  "zh-CN": "简体中文",
  ja:    "日本語",
  ko:    "한국어",
  th:    "ภาษาไทย",
  ar:    "العربية",
  hi:    "हिन्दी",
};
