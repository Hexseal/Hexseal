"use client";

import { useLocale } from "@/hooks/useLocale";
import { locales, localeNames, type Locale } from "@/i18n/config";
import { cn } from "@/lib/utils";
import { Globe } from "lucide-react";
import { useState, useRef, useEffect } from "react";

export function LocaleSwitcher({ className }: { className?: string }) {
  const { locale, setLocale } = useLocale();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-white/50 hover:text-white hover:bg-white/5 transition-colors text-sm"
        aria-label="Switch language"
      >
        <Globe className="w-3.5 h-3.5" />
        <span className="font-medium">{locale.toUpperCase()}</span>
      </button>

      {open && (
        <div className="absolute top-full mt-2 right-0 w-44 bg-[#111113]/95 backdrop-blur-2xl border border-white/[0.09] rounded-xl overflow-hidden shadow-2xl shadow-black/70 z-50">
          {locales.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => { setLocale(l as Locale); setOpen(false); }}
              className={cn(
                "w-full flex items-center gap-3 px-3.5 py-2.5 text-sm transition-colors",
                l === locale
                  ? "text-primary bg-primary/10"
                  : "text-white/70 hover:text-white hover:bg-white/5"
              )}
            >
              <span className="font-mono text-xs opacity-50 w-6">{l.toUpperCase()}</span>
              <span>{localeNames[l as Locale]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
