"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import WalletMenu from "@/components/WalletMenu";
import NotificationCenter from "@/components/NotificationCenter";
import { Briefcase, User, ShieldCheck, ShieldQuestion, ArrowLeft, Loader2 } from "lucide-react";
import { useWalletAccountData } from "@/hooks/useWalletAccountData";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

function NavLink({
  href,
  activePrefix,
  children,
  onClick,
}: {
  href: string;
  activePrefix?: string;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  const pathname = usePathname();
  const checkPath = activePrefix ?? href;
  const isActive = pathname === href || pathname.startsWith(checkPath + "/");

  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 font-medium transition-colors rounded-lg px-3 py-1.5 text-sm",
        isActive
          ? "bg-white/10 text-white"
          : "text-white/50 hover:text-white hover:bg-white/5"
      )}
    >
      {children}
    </Link>
  );
}

export default function Header() {
  const accountData = useWalletAccountData();
  const { isConnected, isArbiter, rolesUnreadable, rolesRechecking, recheckRoles } = accountData;
  const [openPanelMobile, setOpenPanelMobile] = useState<"notifications" | "wallet" | null>(null);
  const [openPanelDesktop, setOpenPanelDesktop] = useState<"notifications" | "wallet" | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  const showBack = pathname !== "/";
  const isHome = pathname === "/";
  const t = useTranslations();

  const glassStyle = {
    boxShadow: "0 4px 24px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.04)",
  } as React.CSSProperties;

  return (
    <>
      {/* ── Top edge fade — masks content scrolling above the pill header ── */}
      <div
        className="fixed inset-x-0 top-0 z-40 pointer-events-none"
        style={{ height: 80, background: "linear-gradient(to bottom, #0d0d0f 20%, transparent)" }}
      />

      {/* ── Mobile floating pill header ────────────────────────────────── */}
      <header
        className="md:hidden fixed left-4 right-4 z-50"
        style={{ top: "calc(env(safe-area-inset-top, 0px) + 10px)" }}
      >
        <div
          className="flex items-center justify-between px-3 h-[52px] bg-[#111113]/80 backdrop-blur-md border border-white/[0.08] rounded-[18px]"
          style={glassStyle}
        >
          {/* Left: back + logo — slot always reserves back-button width so HEXSEAL never shifts */}
          <div className="flex items-center">
            <div className="w-8 flex items-center justify-center">
              {showBack && (
                <button
                  onClick={() => router.back()}
                  className="p-2 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 transition-colors"
                  aria-label="Go back"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
              )}
            </div>
            <Link href={isConnected ? "/board" : "/"} className="ml-1 flex items-center group">
              <span className="font-bold text-[17px] tracking-wide text-white" style={{ fontFamily: "var(--font-syne)" }}>
                HEXSEAL
              </span>
            </Link>
          </div>

          {/* Right: notifications + wallet */}
          <div className="flex items-center gap-2">
            <div className={isConnected ? undefined : 'invisible pointer-events-none'}>
              <NotificationCenter
                open={openPanelMobile === "notifications"}
                onOpenChange={(o) => setOpenPanelMobile(o ? "notifications" : null)}
              />
            </div>
            <WalletMenu
              data={accountData}
              open={openPanelMobile === "wallet"}
              onOpenChange={(o) => setOpenPanelMobile(o ? "wallet" : null)}
              hideNavItems
              hideLocale={isHome}
            />
          </div>
        </div>
      </header>

      {/* ── Desktop floating pill header ───────────────────────────────── */}
      <header
        className="hidden md:block fixed left-5 right-5 z-50"
        style={{ top: "calc(env(safe-area-inset-top, 0px) + 12px)" }}
      >
        <div
          className="max-w-screen-xl mx-auto bg-[#111113]/92 backdrop-blur-3xl border border-white/[0.08] rounded-[18px] h-[52px] flex items-center px-5"
          style={glassStyle}
        >
          <div className="grid grid-cols-[auto_1fr_auto] items-center w-full gap-4">

            {/* Left: back + brand — slot always reserves back-button width so HEXSEAL never shifts */}
            <div className="flex items-center">
              <div className="w-[38px] flex items-center">
                {showBack && (
                  <button
                    onClick={() => router.back()}
                    className="flex items-center justify-center w-8 h-8 rounded-[12px] text-white/40 hover:text-white hover:bg-white/[0.06] transition-colors"
                    aria-label="Go back"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                )}
              </div>
              <Link href={isConnected ? "/board" : "/"} className="flex items-center group">
                <span className="font-bold text-[17px] tracking-wide text-white" style={{ fontFamily: "var(--font-syne)" }}>
                  HEXSEAL
                </span>
              </Link>
            </div>

            {/* Center nav */}
            <nav className="flex items-center justify-center gap-0.5">
              {isConnected && (
                <>
                  <NavLink href="/board" activePrefix="/board/client">
                    <Briefcase className="w-3.5 h-3.5" />
                    {t("nav.jobs")}
                  </NavLink>
                  <NavLink href="/board/executor">
                    <User className="w-3.5 h-3.5" />
                    {t("nav.services")}
                  </NavLink>
                  {isArbiter && (
                    <NavLink href="/arbiter">
                      <ShieldCheck className="w-3.5 h-3.5" />
                      {t("nav.arbiter")}
                    </NavLink>
                  )}
                  {/* Третье состояние роли: не «арбитр» и не «не арбитр», а
                      «не смогли проверить». Ссылки тут намеренно нет — прав при
                      неизвестной роли не выдаём, — но и молчаливого исчезновения
                      тоже: 2 августа вкладка просто пропала, и понять, что дело
                      в связи, было неоткуда. Нажатие переспрашивает цепь. */}
                  {rolesUnreadable && !isArbiter && (
                    <button
                      type="button"
                      onClick={recheckRoles}
                      disabled={rolesRechecking}
                      title={t("nav.arbiter_unverified_hint")}
                      className="flex items-center gap-2 font-medium transition-colors rounded-lg px-3 py-1.5 text-sm text-amber-400/70 hover:text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
                    >
                      {rolesRechecking
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <ShieldQuestion className="w-3.5 h-3.5" />}
                      {t("nav.arbiter_unverified")}
                    </button>
                  )}
                </>
              )}
            </nav>

            {/* Right */}
            <div className="flex items-center gap-1.5 justify-end">
              <div className={isConnected ? undefined : 'invisible pointer-events-none'}>
                <NotificationCenter
                  open={openPanelDesktop === "notifications"}
                  onOpenChange={(o) => setOpenPanelDesktop(o ? "notifications" : null)}
                />
              </div>
              <WalletMenu
                data={accountData}
                open={openPanelDesktop === "wallet"}
                onOpenChange={(o) => setOpenPanelDesktop(o ? "wallet" : null)}
                hideLocale={isHome}
              />
            </div>
          </div>
        </div>
      </header>
    </>
  );
}
