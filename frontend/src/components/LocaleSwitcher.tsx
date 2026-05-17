"use client";

import { useLocale } from "@/hooks/useLocale";
import { locales, localeNames, type Locale } from "@/i18n/config";
import { cn } from "@/lib/utils";
import { Globe } from "lucide-react";
import { useState, useRef, useEffect } from "react";

const RTL_LOCALES: Set<string> = new Set(["ar"]);

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

  const currentName = localeNames[locale as Locale] ?? locale.toUpperCase();

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-white/50 hover:text-white hover:bg-white/5 transition-colors text-sm"
        aria-label="Switch language"
      >
        <Globe className="w-3.5 h-3.5" />
        <span className="font-medium">{currentName}</span>
      </button>

      {open && (
        <div className="absolute top-full mt-2 right-0 w-48 bg-[#111113]/95 backdrop-blur-2xl border border-white/[0.09] rounded-xl overflow-hidden shadow-2xl shadow-black/70 z-50">
          <div className="overflow-y-auto max-h-72 [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.1)_transparent]">
            {locales.map((l) => {
              const isRtl = RTL_LOCALES.has(l);
              return (
                <button
                  key={l}
                  type="button"
                  dir={isRtl ? "rtl" : "ltr"}
                  onClick={() => { setLocale(l as Locale); setOpen(false); }}
                  className={cn(
                    "w-full flex items-center gap-3 px-3.5 py-2.5 text-sm transition-colors",
                    l === locale
                      ? "text-primary bg-primary/10"
                      : "text-white/70 hover:text-white hover:bg-white/5"
                  )}
                >
                  <span className="font-mono text-[10px] opacity-40 w-8 flex-shrink-0 text-left">
                    {l.toUpperCase()}
                  </span>
                  <span className={cn("flex-1", isRtl && "text-right")}>{localeNames[l as Locale]}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
