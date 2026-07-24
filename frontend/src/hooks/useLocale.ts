"use client";

import { useState, useEffect, useCallback } from "react";
import type { Locale } from "@/i18n/config";
import { locales, defaultLocale } from "@/i18n/config";

const STORAGE_KEY = "hexseal_locale";

function detectBrowserLocale(): Locale {
  if (typeof navigator === "undefined") return defaultLocale;
  for (const lang of navigator.languages ?? [navigator.language]) {
    const lower = lang.toLowerCase();
    if (lower.startsWith("zh")) return "zh-CN";
    const base = lower.split("-")[0];
    if ((locales as readonly string[]).includes(base)) return base as Locale;
  }
  return defaultLocale;
}

export function useLocale() {
  const [locale, setLocaleState] = useState<Locale>(defaultLocale);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Locale | null;
    setLocaleState(stored && (locales as readonly string[]).includes(stored)
      ? stored
      : detectBrowserLocale());

    // Mirrors LocaleProvider.tsx's own listeners: without these, a second
    // useLocale() instance on the same page (e.g. WalletMenu's mobile + desktop
    // renders) never learns that another instance called setLocale() — it keeps
    // showing the old locale until it happens to re-render for an unrelated reason.
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY && e.newValue && (locales as readonly string[]).includes(e.newValue)) {
        setLocaleState(e.newValue as Locale);
      }
    }
    function onLocaleChange(e: Event) {
      setLocaleState((e as CustomEvent<Locale>).detail);
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener("hexseal:locale", onLocaleChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("hexseal:locale", onLocaleChange);
    };
  }, []);

  const setLocale = useCallback((next: Locale) => {
    localStorage.setItem(STORAGE_KEY, next);
    setLocaleState(next);
    window.dispatchEvent(new CustomEvent("hexseal:locale", { detail: next }));
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
