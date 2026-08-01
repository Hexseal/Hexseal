"use client";

import React, { useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import { useConnectWallet } from "@/hooks/useConnectWallet";
import BackgroundFX from "@/components/BackgroundFX";
import Link from "next/link";
import { useTranslations } from "next-intl";

const TECH_TAGS = ["Base Network", "EIP-2535", "Gasless", "Escrow"];

export default function Hero() {
  const { isConnected } = useAccount();
  // Та же точка запуска, что у кнопки в шапке: на мобильном — WalletConnect
  // напрямую, на десктопе — модалка RainbowKit (см. hooks/useConnectWallet).
  const { connect: connectWallet, connecting } = useConnectWallet();
  const t = useTranslations();

  const consoleRef   = useRef<HTMLDivElement | null>(null);
  const badgeRef     = useRef<HTMLDivElement | null>(null);
  const headlineRef  = useRef<HTMLHeadingElement | null>(null);
  const subheadingRef = useRef<HTMLDivElement | null>(null);

  const subheadingLines = [
    t("hero.heading1") + " " + t("hero.heading2"),
    t("hero.subheading1"),
    t("hero.subheading2"),
  ];

  useEffect(() => {
    const b = badgeRef.current;
    const h = headlineRef.current;
    const p = subheadingRef.current;
    const t0 = setTimeout(() => {
      b?.classList.add("revealed");
      const t1 = setTimeout(() => {
        h?.classList.add("revealed");
        const t2 = setTimeout(() => p?.classList.add("revealed"), 350);
        return () => clearTimeout(t2);
      }, 260);
      return () => clearTimeout(t1);
    }, 180);
    return () => clearTimeout(t0);
  }, []);

  const onConnectClick = () => {
    // Повторное нажатие ничего не плодит: хук проглатывает его, пока попытка в
    // полёте. Терминальную строчку при этом не повторяем — она бы мигала.
    if (connecting) return;
    const c = consoleRef.current;
    if (c) {
      c.textContent = "// opening wallet picker…";
      c.classList.add("visible");
      setTimeout(() => c.classList.remove("visible"), 2400);
    }
    connectWallet();
  };

  return (
    <div className="hero">
      <BackgroundFX />
      <div className="hero-scrim" />

      <div className="content-container">
        {/* Protocol badge */}
        <div className="hero-badge" ref={badgeRef}>
          <span className="hero-dot" />
          {t("hero.tagline")}
        </div>

        {/* Headline */}
        <h1
          className="font-syne font-black leading-[0.88] tracking-tight"
          style={{ fontSize: "var(--hero-fs, clamp(2.4rem, 9vw, 6.5rem))" }}
          ref={headlineRef}
        >
          <span className="block">{t("hero.wordmark1")}</span>
          <span className="block">{t("hero.wordmark2")}</span>
          <span className="block hero-accent">{t("hero.wordmark3")}</span>
        </h1>

        {/* Subheading */}
        <div className="subheading mt-7" ref={subheadingRef}>
          {subheadingLines.map((line) => (
            <div key={line} className="flex items-center gap-3 mb-2.5">
              <span className="hero-dot" />
              <p className="font-sans text-white/85 text-sm sm:text-base tracking-wide" style={{ textShadow: '0 1px 8px rgba(0,0,0,0.9)' }}>
                {line}
              </p>
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="cta-container">
          {!isConnected ? (
            <>
              <span className="cta-prompt">{">"}</span>
              <span className="cta-command" onClick={onConnectClick} aria-busy={connecting}>
                {connecting ? t("wallet.connecting") : t("hero.connect_wallet")}
              </span>
              <span className="cta-cursor"></span>
              <div className="console-message" ref={consoleRef}>
                // ready to connect
              </div>
            </>
          ) : (
            <Link href="/board">
              <button className="primary-btn">{t("hero.cta")} →</button>
            </Link>
          )}
        </div>

        {/* Tech stack tags */}
        <div className="flex flex-wrap gap-2 mt-9">
          {TECH_TAGS.map((tag) => (
            <span key={tag} className="hero-tag">
              {tag}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
