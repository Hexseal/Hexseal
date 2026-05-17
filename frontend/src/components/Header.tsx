"use client";

import React, { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useAccount } from "wagmi";
import { usePathname, useRouter } from "next/navigation";
import WalletMenu from "@/components/WalletMenu";
import NotificationCenter from "@/components/NotificationCenter";
import { Briefcase, User, ShieldCheck, ArrowLeft } from "lucide-react";
import { useReadContract } from "wagmi";
import { ARBITER_REGISTRY_ABI, CONTRACTS } from "@/config/contracts";
import type { Abi } from "viem";
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

export default function Header({ chatMode = false }: { chatMode?: boolean }) {
  const { isConnected, address } = useAccount();
  const [openPanelMobile, setOpenPanelMobile] = useState<"notifications" | "wallet" | null>(null);
  const [openPanelDesktop, setOpenPanelDesktop] = useState<"notifications" | "wallet" | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  const showBack = pathname !== "/";
  const t = useTranslations();

  const { data: isArbiter } = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "isRegisteredArbiter",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: !!address },
  }) as { data: boolean | undefined };

  const glassStyle = {
    boxShadow: "0 4px 24px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.04)",
  } as React.CSSProperties;

  return (
    <>
      {/* ── Mobile floating pill header ────────────────────────────────── */}
      <header
        className={chatMode ? "hidden" : "md:hidden fixed left-2 right-2 z-50"}
        style={{ top: "calc(env(safe-area-inset-top, 0px) + 10px)" }}
      >
        <div
          className="flex items-center justify-between px-3 py-3 bg-[#111113]/80 backdrop-blur-md border border-white/[0.08] rounded-[22px]"
          style={glassStyle}
        >
          {/* Left: back + logo */}
          <div className="flex items-center gap-1.5">
            {showBack && (
              <button
                onClick={() => router.back()}
                className="w-8 h-8 rounded-full flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 transition-colors"
                aria-label="Go back"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}
            <Link href="/" className="flex items-center gap-2 group">
              <Image
                src="/s404logo.png"
                alt="S404"
                width={22}
                height={22}
                className="opacity-75 group-hover:opacity-100 transition-opacity"
              />
              <span className="font-syne font-bold text-sm tracking-tight" style={{ fontFamily: "var(--font-syne)" }}>
                Signature<span className="text-primary">404</span>
              </span>
            </Link>
          </div>

          {/* Right: notifications + wallet */}
          <div className="flex items-center gap-1">
            {isConnected && (
              <NotificationCenter
                open={openPanelMobile === "notifications"}
                onOpenChange={(o) => setOpenPanelMobile(o ? "notifications" : null)}
              />
            )}
            <WalletMenu
              open={openPanelMobile === "wallet"}
              onOpenChange={(o) => setOpenPanelMobile(o ? "wallet" : null)}
              hideNavItems
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
          className="max-w-screen-xl mx-auto bg-[#111113]/92 backdrop-blur-3xl border border-white/[0.08] rounded-[26px] h-14 flex items-center px-4"
          style={glassStyle}
        >
          <div className="grid grid-cols-[auto_1fr_auto] items-center w-full gap-4">

            {/* Left: back + brand */}
            <div className="flex items-center gap-1">
              {showBack && (
                <button
                  onClick={() => router.back()}
                  className="flex items-center justify-center w-8 h-8 rounded-[12px] text-white/40 hover:text-white hover:bg-white/[0.06] transition-colors"
                  aria-label="Go back"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
              )}
              <Link href="/" className="flex items-center gap-2.5 group">
                <Image
                  src="/s404logo.png"
                  alt="S404"
                  width={24}
                  height={24}
                  className="opacity-80 group-hover:opacity-100 transition-opacity"
                />
                <span className="font-syne font-bold text-sm tracking-tight" style={{ fontFamily: "var(--font-syne)" }}>
                  Signature<span className="text-primary">404</span>
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
                </>
              )}
            </nav>

            {/* Right */}
            <div className="flex items-center gap-1.5 justify-end">
              {isConnected && (
                <NotificationCenter
                  open={openPanelDesktop === "notifications"}
                  onOpenChange={(o) => setOpenPanelDesktop(o ? "notifications" : null)}
                />
              )}
              <WalletMenu
                open={openPanelDesktop === "wallet"}
                onOpenChange={(o) => setOpenPanelDesktop(o ? "wallet" : null)}
              />
            </div>
          </div>
        </div>
      </header>
    </>
  );
}
