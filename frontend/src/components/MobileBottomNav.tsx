"use client";

import { useState, useEffect, useRef } from "react";

// Only animate the nav entrance once per page load — not on every route change
let _navHasAppeared = false;
import { motion } from "framer-motion";
import { usePathname, useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import {
  LayoutDashboard,
  MessageCircle,
  LayoutList,
  Bell,
  Settings,
  Briefcase,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useNotifications } from "@/hooks/useNotifications";
import { useTranslations } from "next-intl";

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
  const router = useRouter();

  const inner = (
    <span className="flex flex-col items-center gap-[6px] select-none">
      <span className="relative flex items-center justify-center">
        <span
          className={cn(
            "transition-colors duration-200",
            active ? "text-white" : "text-white/35"
          )}
        >
          {children}
        </span>
        {badge != null && badge > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-[16px] px-[3px] rounded-full bg-primary text-[9px] font-bold text-white flex items-center justify-center leading-none z-10">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </span>
      <span
        className={cn(
          "text-[10px] font-medium tracking-wide leading-none transition-colors duration-200",
          active ? "text-white/80" : "text-white/28"
        )}
      >
        {label}
      </span>
      {/* active bar — fixed-height slot keeps layout stable; motion.div slides between tabs */}
      <span className="h-[2px] flex items-center justify-center">
        {active && (
          <motion.div
            layoutId="nav-indicator"
            className="h-[2px] w-[20px] bg-primary rounded-full"
            transition={{ type: "tween", ease: [0.4, 0, 0.2, 1], duration: 0.22 }}
          />
        )}
      </span>
    </span>
  );

  const cls = "flex-1 flex items-center justify-center h-full min-w-0";

  return (
    <button type="button" onClick={href ? () => router.push(href) : onClick} className={cls}>
      {inner}
    </button>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MobileBottomNav() {
  const { isConnected } = useAccount();
  const pathname = usePathname();
  const { unreadCount, unreadMessageCount } = useNotifications();
  const [boardMounted, setBoardMounted] = useState(false);
  const [boardVisible, setBoardVisible] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const t = useTranslations();

  const openBoard = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setBoardMounted(true);
    // Two RAF frames so the browser paints the element before the transition fires.
    requestAnimationFrame(() => requestAnimationFrame(() => setBoardVisible(true)));
  };

  const closeBoard = () => {
    setBoardVisible(false);
    closeTimer.current = setTimeout(() => setBoardMounted(false), 280);
  };

  const toggleBoard = () => (boardMounted && boardVisible ? closeBoard() : openBoard());

  // Close on navigation.
  useEffect(() => { closeBoard(); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  // Must be before early return — hooks cannot be called conditionally.
  const isFirstAppear = !_navHasAppeared;
  useEffect(() => { _navHasAppeared = true; }, []);

  if (!isConnected) return null;

  const isActive = (path: string) =>
    pathname === path || pathname.startsWith(path + "/");

  const boardActive = isActive("/board");
  const boardOpen = boardMounted && boardVisible;

  const POPUP_TRANSITION = "transform 280ms cubic-bezier(0.34,1.56,0.64,1), opacity 220ms ease-out";

  return (
    <>
      {/* backdrop */}
      {boardMounted && (
        <div
          className="fixed inset-0 z-40"
          style={{
            opacity: boardVisible ? 1 : 0,
            transition: "opacity 220ms ease-out",
            pointerEvents: boardVisible ? "auto" : "none",
          }}
          onClick={closeBoard}
        />
      )}

      {/* Board popup */}
      {boardMounted && (
        <div
          className="fixed z-50 left-3 right-3"
          style={{
            bottom: "calc(env(safe-area-inset-bottom, 0px) + 94px)",
            transform: boardVisible ? "translateY(0) scale(1)" : "translateY(16px) scale(0.97)",
            opacity: boardVisible ? 1 : 0,
            transition: POPUP_TRANSITION,
            willChange: "transform, opacity",
          }}
        >
          <div
            className="flex backdrop-blur-3xl border border-white/[0.08] rounded-[22px] overflow-hidden"
            style={{
              background: 'rgba(0,0,0,0.96)',
              boxShadow:
                "0 8px 40px rgba(0,0,0,0.65), 0 2px 8px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)",
            }}
          >
            <Link
              href="/board"
              onClick={closeBoard}
              className="flex-1 flex items-center gap-3 px-5 py-4 transition-colors active:bg-white/[0.06]"
            >
              <span className="w-9 h-9 rounded-[12px] bg-white/[0.06] border border-white/[0.06] flex items-center justify-center flex-shrink-0">
                <Briefcase className="w-[18px] h-[18px] text-white/55" />
              </span>
              <div>
                <p className="text-sm font-medium text-white/85">
                  {t("board.mobile_popup.jobs_label")}
                </p>
                <p className="text-[11px] text-white/30 mt-0.5">
                  {t("board.mobile_popup.jobs_desc")}
                </p>
              </div>
            </Link>

            <div className="w-px bg-white/[0.06] my-3" />

            <Link
              href="/board/executor"
              onClick={closeBoard}
              className="flex-1 flex items-center gap-3 px-5 py-4 transition-colors active:bg-white/[0.06]"
            >
              <span className="w-9 h-9 rounded-[12px] bg-white/[0.06] border border-white/[0.06] flex items-center justify-center flex-shrink-0">
                <User className="w-[18px] h-[18px] text-white/55" />
              </span>
              <div>
                <p className="text-sm font-medium text-white/85">
                  {t("board.mobile_popup.services_label")}
                </p>
                <p className="text-[11px] text-white/30 mt-0.5">
                  {t("board.mobile_popup.services_desc")}
                </p>
              </div>
            </Link>
          </div>
        </div>
      )}

      {/* ── Floating pill ─────────────────────────────────────────────────── */}
      <motion.nav
        initial={isFirstAppear ? { y: 20, opacity: 0 } : false}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.28, ease: [0.25, 0.46, 0.45, 0.94] }}
        className="md:hidden fixed left-3 right-3 z-50"
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 2px)" }}
      >
        <div
          className="flex items-center bg-[#111113]/92 backdrop-blur-3xl border border-white/[0.08] rounded-[32px] px-4 h-[86px]"
          style={{
            boxShadow:
              "0 8px 40px rgba(0,0,0,0.65), 0 2px 8px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)",
          }}
        >
          <PillBtn
            href="/dashboard"
            active={isActive("/dashboard")}
            label={t("nav.dashboard")}
          >
            <LayoutDashboard className="w-[24px] h-[24px]" />
          </PillBtn>

          <PillBtn
            href="/chat"
            active={isActive("/chat")}
            label={t("nav.messages")}
            badge={unreadMessageCount}
          >
            <MessageCircle className="w-[24px] h-[24px]" />
          </PillBtn>

          <PillBtn
            active={boardActive || boardOpen}
            label={t("nav.board")}
            onClick={toggleBoard}
          >
            <LayoutList className="w-[24px] h-[24px]" />
          </PillBtn>

          <PillBtn
            href="/notifications"
            active={isActive("/notifications")}
            label={t("nav.alerts")}
            badge={unreadCount}
          >
            <Bell className="w-[24px] h-[24px]" />
          </PillBtn>

          <PillBtn
            href="/profile/edit"
            active={isActive("/profile/edit")}
            label={t("nav.settings")}
          >
            <Settings className="w-[24px] h-[24px]" />
          </PillBtn>
        </div>
      </motion.nav>
    </>
  );
}
