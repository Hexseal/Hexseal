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

function NavLink({
  href,
  activePrefix,
  children,
  mobile,
  onClick,
}: {
  href: string;
  activePrefix?: string;
  children: React.ReactNode;
  mobile?: boolean;
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
        "flex items-center gap-2 font-medium transition-colors rounded-lg",
        mobile
          ? "px-4 py-3 text-base w-full"
          : "px-3 py-1.5 text-sm",
        isActive
          ? "bg-white/10 text-white"
          : "text-white/60 hover:text-white hover:bg-white/5"
      )}
    >
      {children}
    </Link>
  );
}

export default function Header() {
  const { isConnected, address } = useAccount();
  const [openPanel, setOpenPanel] = useState<"notifications" | "wallet" | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  const showBack = pathname !== "/";

  const { data: isArbiter } = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "isRegisteredArbiter",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: !!address },
  }) as { data: boolean | undefined };

  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-white/10 bg-black/70 backdrop-blur-xl" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <div className="grid grid-cols-[auto_1fr_auto] items-center pl-4 pr-2 sm:pl-6 sm:pr-4 h-16 max-w-screen-xl mx-auto gap-4">

        {/* Left: back button + brand */}
        <div className="flex items-center gap-1">
          {showBack && (
            <button
              onClick={() => router.back()}
              className="flex items-center justify-center w-8 h-8 rounded-lg text-white/40 hover:text-white hover:bg-white/5 transition-colors"
              aria-label="Go back"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <Link href="/" className="flex items-center gap-2.5 group">
            <Image
              src="/s404logo.png"
              alt="S404"
              width={26}
              height={26}
              className="opacity-80 group-hover:opacity-100 transition-opacity"
            />
            <span className="font-syne font-bold text-base tracking-tight">
              Signature<span className="text-primary">404</span>
            </span>
          </Link>
        </div>

        {/* Desktop Nav — always occupies center column, no layout shift */}
        <nav className="hidden md:flex items-center justify-center gap-1">
          {isConnected && (
            <>
              <NavLink href="/board" activePrefix="/board/client">
                <Briefcase className="w-3.5 h-3.5" />
                Jobs
              </NavLink>
              <NavLink href="/board/executor">
                <User className="w-3.5 h-3.5" />
                Services
              </NavLink>
              {isArbiter && (
                <NavLink href="/arbiter">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Arbiter
                </NavLink>
              )}
            </>
          )}
        </nav>

        {/* Right */}
        <div className="flex items-center gap-2 sm:gap-3 justify-end">
          {isConnected && (
            <NotificationCenter
              open={openPanel === "notifications"}
              onOpenChange={(o) => setOpenPanel(o ? "notifications" : null)}
            />
          )}
          <WalletMenu
            open={openPanel === "wallet"}
            onOpenChange={(o) => setOpenPanel(o ? "wallet" : null)}
          />
        </div>
      </div>
    </header>
  );
}
