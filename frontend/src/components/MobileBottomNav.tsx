"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import {
  LayoutDashboard,
  MessageCircle,
  LayoutList,
  Bell,
  Settings,
  Briefcase,
  User,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useNotifications } from "@/hooks/useNotifications";

// ─── Single pill button ───────────────────────────────────────────────────────

function PillBtn({
  active,
  label,
  badge,
  onClick,
  href,
  children,
}: {
  active: boolean;
  label: string;
  badge?: number;
  onClick?: () => void;
  href?: string;
  children: React.ReactNode;
}) {
  const inner = (
    <span className="flex flex-col items-center gap-[5px] select-none">
      <span className="relative flex items-center justify-center">
        {/* icon circle */}
        <span
          className={cn(
            "w-[46px] h-[46px] rounded-full flex items-center justify-center transition-all duration-200",
            active
              ? "bg-primary/15"
              : "bg-transparent"
          )}
        >
          <span className={cn("transition-colors duration-200", active ? "text-primary" : "text-white/40")}>
            {children}
          </span>
        </span>
        {/* badge */}
        {badge != null && badge > 0 && (
          <span className="absolute top-0.5 right-0.5 min-w-[16px] h-[16px] px-[3px] rounded-full bg-primary text-[9px] font-bold text-white flex items-center justify-center leading-none z-10">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </span>
      <span
        className={cn(
          "text-[10px] font-medium tracking-wide leading-none transition-colors duration-200",
          active ? "text-primary" : "text-white/35"
        )}
      >
        {label}
      </span>
    </span>
  );

  const cls = "flex-1 flex items-center justify-center h-full min-w-0";

  if (href) {
    return (
      <Link href={href} className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {inner}
    </button>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MobileBottomNav() {
  const { isConnected } = useAccount();
  const pathname = usePathname();
  const { unreadCount } = useNotifications();
  const [boardOpen, setBoardOpen] = useState(false);

  if (!isConnected) return null;

  const isActive = (path: string) =>
    pathname === path || pathname.startsWith(path + "/");

  const boardActive = isActive("/board");

  return (
    <>
      {/* backdrop to close board popup */}
      {boardOpen && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setBoardOpen(false)}
        />
      )}

      {/* Board popup — above the pill */}
      {boardOpen && (
        <div
          className="fixed z-50 bottom-[calc(env(safe-area-inset-bottom,0px)+108px)] left-1/2 -translate-x-1/2"
          style={{ minWidth: 200 }}
        >
          <div className="bg-[#111113]/95 backdrop-blur-2xl border border-white/[0.09] rounded-2xl overflow-hidden shadow-2xl shadow-black/70">
            <div className="flex items-center justify-between px-4 pt-3 pb-2">
              <span className="text-[11px] text-white/30 font-medium tracking-widest uppercase">Board</span>
              <button
                onClick={() => setBoardOpen(false)}
                className="w-5 h-5 rounded-full bg-white/10 flex items-center justify-center"
              >
                <X className="w-3 h-3 text-white/50" />
              </button>
            </div>
            <div className="h-px bg-white/[0.06] mx-3" />
            <Link
              href="/board"
              onClick={() => setBoardOpen(false)}
              className="flex items-center gap-3 px-4 py-3.5 text-sm text-white/70 hover:text-white hover:bg-white/5 transition-colors"
            >
              <span className="w-8 h-8 rounded-xl bg-white/[0.07] flex items-center justify-center flex-shrink-0">
                <Briefcase className="w-4 h-4" />
              </span>
              <div>
                <p className="font-medium text-white/85">Jobs</p>
                <p className="text-[11px] text-white/35 mt-0.5">Browse client postings</p>
              </div>
            </Link>
            <div className="h-px bg-white/[0.06] mx-3" />
            <Link
              href="/board/executor"
              onClick={() => setBoardOpen(false)}
              className="flex items-center gap-3 px-4 py-3.5 text-sm text-white/70 hover:text-white hover:bg-white/5 transition-colors"
            >
              <span className="w-8 h-8 rounded-xl bg-white/[0.07] flex items-center justify-center flex-shrink-0">
                <User className="w-4 h-4" />
              </span>
              <div>
                <p className="font-medium text-white/85">Services</p>
                <p className="text-[11px] text-white/35 mt-0.5">Browse executor offers</p>
              </div>
            </Link>
          </div>
          {/* caret */}
          <div className="flex justify-center mt-[-1px]">
            <div
              className="w-0 h-0"
              style={{
                borderLeft: "9px solid transparent",
                borderRight: "9px solid transparent",
                borderTop: "9px solid rgba(17,17,19,0.95)",
              }}
            />
          </div>
        </div>
      )}

      {/* ── Floating pill ─────────────────────────────────────────────────── */}
      <nav
        className="md:hidden fixed left-4 right-4 z-50"
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)" }}
      >
        <div
          className="flex items-center bg-[#111113]/92 backdrop-blur-3xl border border-white/[0.08] rounded-[28px] px-1.5 h-[70px]"
          style={{ boxShadow: "0 8px 40px rgba(0,0,0,0.65), 0 2px 8px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)" }}
        >
          <PillBtn href="/dashboard" active={isActive("/dashboard")} label="Dashboard">
            <LayoutDashboard className="w-[22px] h-[22px]" />
          </PillBtn>

          <PillBtn href="/chat" active={isActive("/chat")} label="Messages">
            <MessageCircle className="w-[22px] h-[22px]" />
          </PillBtn>

          <PillBtn
            active={boardActive || boardOpen}
            label="Board"
            onClick={() => setBoardOpen(v => !v)}
          >
            <LayoutList className="w-[22px] h-[22px]" />
          </PillBtn>

          <PillBtn href="/notifications" active={isActive("/notifications")} label="Alerts" badge={unreadCount}>
            <Bell className="w-[22px] h-[22px]" />
          </PillBtn>

          <PillBtn href="/profile/edit" active={isActive("/profile/edit")} label="Settings">
            <Settings className="w-[22px] h-[22px]" />
          </PillBtn>
        </div>
      </nav>
    </>
  );
}
