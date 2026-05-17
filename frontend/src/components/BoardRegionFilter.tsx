"use client";

import { Globe } from "lucide-react";
import { cn } from "@/lib/utils";

export const REGION_LABELS: Record<number, string> = {
  0: "CIS",
  1: "Asia",
  2: "Europe",
  3: "US",
  4: "LATAM",
  5: "CA",
  6: "AU",
};

const REGION_HINTS: Record<number, string> = {
  0: "RU · BY · KZ",
  1: "CN · JP · TH",
  2: "DE · FR · PL",
  3: "US",
  4: "BR · MX · AR",
  5: "CA · GB",
  6: "AU · NZ",
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
    <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {/* Global */}
      <button
        type="button"
        onClick={() => onChange(null)}
        className={cn(
          "flex-shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors",
          value === null
            ? "border-primary bg-primary/10 text-primary"
            : "border-white/10 text-white/40 hover:border-white/20 hover:text-white/60"
        )}
      >
        <Globe className="w-3 h-3" />
        Global
      </button>

      {/* Separator */}
      <span className="flex-shrink-0 w-px h-4 bg-white/10" />

      {Object.entries(REGION_LABELS).map(([k, label]) => {
        const region = Number(k);
        const isActive = value === region;
        const isDetected = userRegion === region && value !== region;
        return (
          <button
            key={k}
            type="button"
            onClick={() => onChange(region)}
            title={REGION_HINTS[region]}
            className={cn(
              "flex-shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors",
              isActive
                ? "border-primary bg-primary/10 text-primary"
                : "border-white/10 text-white/40 hover:border-white/20 hover:text-white/60"
            )}
          >
            {label}
            {isDetected && <span className="w-1 h-1 rounded-full bg-current opacity-50" />}
          </button>
        );
      })}
    </div>
  );
}
