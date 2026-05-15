"use client";

import { useState, useEffect, useCallback } from "react";
import type { Locale } from "@/i18n/config";
import { locales, defaultLocale } from "@/i18n/config";

const STORAGE_KEY = "sig404_locale";

function detectBrowserLocale(): Locale {
  if (typeof navigator === "undefined") return defaultLocale;
  const lang = navigator.language.split("-")[0].toLowerCase();
  return (locales as readonly string[]).includes(lang)
    ? (lang as Locale)
    : defaultLocale;
}

export function useLocale() {
  const [locale, setLocaleState] = useState<Locale>(defaultLocale);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Locale | null;
    setLocaleState(stored && (locales as readonly string[]).includes(stored)
      ? stored
      : detectBrowserLocale());
  }, []);

  const setLocale = useCallback((next: Locale) => {
    localStorage.setItem(STORAGE_KEY, next);
    setLocaleState(next);
    window.dispatchEvent(new CustomEvent("sig404:locale", { detail: next }));
  }, []);

  return { locale, setLocale };
}

export function getStoredLocale(): Locale {
  if (typeof window === "undefined") return defaultLocale;
  const stored = localStorage.getItem(STORAGE_KEY) as Locale | null;
  return stored && (locales as readonly string[]).includes(stored)
    ? stored
    : detectBrowserLocale();
}
