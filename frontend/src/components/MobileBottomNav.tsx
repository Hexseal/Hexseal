"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import { LayoutDashboard, MessageCircle, LayoutList, Bell, Settings, Briefcase, User, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNotifications } from "@/hooks/useNotifications";

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
      {boardOpen && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setBoardOpen(false)}
        />
      )}

      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-50 border-t border-white/[0.07] bg-black/90 backdrop-blur-2xl"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 16px)" }}
      >
        {boardOpen && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 flex flex-col items-center">
            <div className="bg-[#0e0e0e] border border-white/[0.10] rounded-2xl overflow-hidden shadow-2xl shadow-black/80 min-w-[172px]">
              <Link
                href="/board"
                onClick={() => setBoardOpen(false)}
                className="flex items-center gap-3 px-5 py-4 text-sm text-white/70 hover:text-white hover:bg-white/5 transition-colors"
              >
                <Briefcase className="w-4 h-4 flex-shrink-0" />
                Jobs
              </Link>
              <div className="h-px bg-white/[0.07] mx-3" />
              <Link
                href="/board/executor"
                onClick={() => setBoardOpen(false)}
                className="flex items-center gap-3 px-5 py-4 text-sm text-white/70 hover:text-white hover:bg-white/5 transition-colors"
              >
                <User className="w-4 h-4 flex-shrink-0" />
                Services
              </Link>
            </div>
            {/* connecting arrow */}
            <div
              className="w-0 h-0"
              style={{
                borderLeft: "8px solid transparent",
                borderRight: "8px solid transparent",
                borderTop: "8px solid #0e0e0e",
                marginTop: "-1px",
              }}
            />
          </div>
        )}

        <div className="flex items-center h-[74px] px-1">

          <Link href="/dashboard" className="flex-1 flex flex-col items-center justify-center gap-2 py-3">
            <LayoutDashboard className={cn("w-[24px] h-[24px] transition-colors", isActive("/dashboard") ? "text-primary" : "text-white/30")} />
            <span className={cn("text-[11px] font-medium tracking-wide", isActive("/dashboard") ? "text-primary" : "text-white/30")}>Dashboard</span>
          </Link>

          <Link href="/chat" className="flex-1 flex flex-col items-center justify-center gap-2 py-3">
            <MessageCircle className={cn("w-[24px] h-[24px] transition-colors", isActive("/chat") ? "text-primary" : "text-white/30")} />
            <span className={cn("text-[11px] font-medium tracking-wide", isActive("/chat") ? "text-primary" : "text-white/30")}>Messages</span>
          </Link>

          <button
            onClick={() => setBoardOpen(v => !v)}
            className="flex-1 flex flex-col items-center justify-center gap-2 py-3"
          >
            <LayoutList className={cn("w-[24px] h-[24px] transition-colors", boardActive || boardOpen ? "text-primary" : "text-white/30")} />
            <span className={cn("text-[11px] font-medium tracking-wide flex items-center gap-0.5", boardActive || boardOpen ? "text-primary" : "text-white/30")}>
              Board
              <ChevronUp className={cn("w-2.5 h-2.5 transition-transform duration-200", boardOpen ? "rotate-0" : "rotate-180")} />
            </span>
          </button>

          <Link href="/notifications" className="flex-1 flex flex-col items-center justify-center gap-2 py-3">
            <div className="relative">
              <Bell className={cn("w-[24px] h-[24px] transition-colors", isActive("/notifications") ? "text-primary" : "text-white/30")} />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1.5 min-w-[15px] h-[15px] px-0.5 rounded-full bg-primary text-[8px] font-bold text-white flex items-center justify-center leading-none">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </div>
            <span className={cn("text-[11px] font-medium tracking-wide", isActive("/notifications") ? "text-primary" : "text-white/30")}>Alerts</span>
          </Link>

          <Link href="/profile/edit" className="flex-1 flex flex-col items-center justify-center gap-2 py-3">
            <Settings className={cn("w-[24px] h-[24px] transition-colors", isActive("/profile/edit") ? "text-primary" : "text-white/30")} />
            <span className={cn("text-[11px] font-medium tracking-wide", isActive("/profile/edit") ? "text-primary" : "text-white/30")}>Settings</span>
          </Link>

        </div>
      </nav>
    </>
  );
}
