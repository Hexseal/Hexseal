"use client";

import { Globe } from "lucide-react";
import { cn } from "@/lib/utils";

export const REGION_LABELS: Record<number, string> = {
  0: "CIS",
  1: "Asia / LATAM",
  2: "Europe",
  3: "US / CA",
};

const REGION_HINTS: Record<number, string> = {
  0: "RU · BY · KZ",
  1: "TH · BR · MX",
  2: "DE · FR · PL",
  3: "US · CA · AU",
};

const LS_KEY = "sig404_board_region";

export function getStoredBoardRegion(): number | null {
  if (typeof window === "undefined") return null;
  const v = localStorage.getItem(LS_KEY);
  if (v === null || v === "null") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

export function storeBoardRegion(v: number | null) {
  if (typeof window === "undefined") return;
  localStorage.setItem(LS_KEY, v === null ? "null" : String(v));
}

export function BoardRegionFilter({
  value,
  onChange,
  userRegion,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  userRegion: number | null;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {Object.entries(REGION_LABELS).map(([k, label]) => {
        const region = Number(k);
        const isActive = value === region;
        const isDetected = userRegion === region && value !== region;
        return (
          <button
            key={k}
            type="button"
            onClick={() => onChange(region)}
            className={cn(
              "px-2.5 py-1 rounded-full text-xs font-medium border transition-colors flex flex-col items-center leading-tight",
              isActive
                ? "border-primary bg-primary/10 text-primary"
                : "border-white/10 text-white/40 hover:border-white/20 hover:text-white/60"
            )}
          >
            <span className="flex items-center gap-0.5">
              {label}
              {isDetected && (
                <span className="text-[8px] opacity-50">●</span>
              )}
            </span>
            <span className="text-[9px] opacity-40 font-normal tracking-wide">
              {REGION_HINTS[region]}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => onChange(null)}
        className={cn(
          "px-2.5 py-1 rounded-full text-xs font-medium border transition-colors flex items-center gap-1",
          value === null
            ? "border-primary bg-primary/10 text-primary"
            : "border-white/10 text-white/40 hover:border-white/20 hover:text-white/60"
        )}
      >
        <Globe className="w-3 h-3" />
        Global
      </button>
    </div>
  );
}
