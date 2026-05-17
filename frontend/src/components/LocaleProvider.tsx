"use client";

import { useState, useEffect } from "react";
import { NextIntlClientProvider } from "next-intl";
import { defaultLocale, locales, type Locale } from "@/i18n/config";
import enMessages from "../../messages/en.json";

const STORAGE_KEY = "sig404_locale";
const RTL_LOCALES = new Set<Locale>(["ar"]);

// Maps browser language tags to our locale codes
function normalizeBrowserLang(lang: string): Locale | null {
  const lower = lang.toLowerCase();
  // Chinese variants → zh-CN
  if (lower.startsWith("zh")) return "zh-CN";
  const base = lower.split("-")[0];
  return (locales as readonly string[]).includes(base) ? (base as Locale) : null;
}

function detectLocale(): Locale {
  if (typeof window === "undefined") return defaultLocale;
  const stored = localStorage.getItem(STORAGE_KEY) as Locale | null;
  if (stored && (locales as readonly string[]).includes(stored)) return stored;
  for (const lang of navigator.languages ?? [navigator.language]) {
    const matched = normalizeBrowserLang(lang);
    if (matched) return matched;
  }
  return defaultLocale;
}

async function loadMessages(locale: Locale) {
  switch (locale) {
    case "ru":    return (await import("../../messages/ru.json")).default;
    case "es":    return (await import("../../messages/es.json")).default;
    case "de":    return (await import("../../messages/de.json")).default;
    case "fr":    return (await import("../../messages/fr.json")).default;
    case "it":    return (await import("../../messages/it.json")).default;
    case "pt":    return (await import("../../messages/pt.json")).default;
    case "uk":    return (await import("../../messages/uk.json")).default;
    case "zh-CN": return (await import("../../messages/zh-CN.json")).default;
    case "ja":    return (await import("../../messages/ja.json")).default;
    case "ko":    return (await import("../../messages/ko.json")).default;
    case "th":    return (await import("../../messages/th.json")).default;
    case "ar":    return (await import("../../messages/ar.json")).default;
    case "hi":    return (await import("../../messages/hi.json")).default;
    default:      return enMessages;
  }
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState<Locale>(defaultLocale);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [messages, setMessages] = useState<any>(enMessages);

  function applyLocale(next: Locale) {
    document.documentElement.lang = next;
    document.documentElement.dir = RTL_LOCALES.has(next) ? "rtl" : "ltr";
    setLocale(next);
    loadMessages(next).then(setMessages);
  }

  useEffect(() => {
    applyLocale(detectLocale());

    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY && e.newValue) {
        const next = e.newValue as Locale;
        if ((locales as readonly string[]).includes(next)) applyLocale(next);
      }
    }

    function onLocaleChange(e: Event) {
      applyLocale((e as CustomEvent<Locale>).detail);
    }

    window.addEventListener("storage", onStorage);
    window.addEventListener("sig404:locale", onLocaleChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("sig404:locale", onLocaleChange);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}
