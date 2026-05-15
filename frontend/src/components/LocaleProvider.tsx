"use client";

import { useState, useEffect } from "react";
import { NextIntlClientProvider } from "next-intl";
import { defaultLocale, locales, type Locale } from "@/i18n/config";
import enMessages from "../../messages/en.json";

const STORAGE_KEY = "sig404_locale";

function detectLocale(): Locale {
  if (typeof window === "undefined") return defaultLocale;
  const stored = localStorage.getItem(STORAGE_KEY) as Locale | null;
  if (stored && (locales as readonly string[]).includes(stored)) return stored;
  const lang = navigator.language.split("-")[0].toLowerCase() as Locale;
  return (locales as readonly string[]).includes(lang) ? lang : defaultLocale;
}

async function loadMessages(locale: Locale) {
  switch (locale) {
    case "ru": return (await import("../../messages/ru.json")).default;
    case "es": return (await import("../../messages/es.json")).default;
    case "zh": return (await import("../../messages/zh.json")).default;
    case "de": return (await import("../../messages/de.json")).default;
    case "th": return (await import("../../messages/th.json")).default;
    default:   return enMessages;
  }
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState<Locale>(defaultLocale);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [messages, setMessages] = useState<any>(enMessages);

  useEffect(() => {
    const detected = detectLocale();
    document.documentElement.lang = detected;
    if (detected !== defaultLocale) {
      setLocale(detected);
      loadMessages(detected).then(setMessages);
    }

    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY && e.newValue) {
        const next = e.newValue as Locale;
        if ((locales as readonly string[]).includes(next)) {
          document.documentElement.lang = next;
          setLocale(next);
          loadMessages(next).then(setMessages);
        }
      }
    }

    function onLocaleChange(e: Event) {
      const next = (e as CustomEvent<Locale>).detail;
      document.documentElement.lang = next;
      setLocale(next);
      loadMessages(next).then(setMessages);
    }

    window.addEventListener("storage", onStorage);
    window.addEventListener("sig404:locale", onLocaleChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("sig404:locale", onLocaleChange);
    };
  }, []);

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}
