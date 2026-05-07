"use client";

import React, { useEffect, useRef } from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import BackgroundFX from "@/components/BackgroundFX";
import Link from "next/link";
import { appChainId } from "@/config/chain";

const SUBHEADING_LINES = [
  "No middlemen. No trust required.",
  "Sign once. Code enforces.",
  "Escrow without the escrow.",
];

const TECH_TAGS = ["Base Network", "EIP-2535", "Gasless", "Escrow"];

export default function Hero() {
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const chainId = useChainId();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();

  const consoleRef = useRef<HTMLDivElement | null>(null);
  const badgeRef = useRef<HTMLDivElement | null>(null);
  const headlineRef = useRef<HTMLHeadingElement | null>(null);
  const subheadingRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    const ensureBaseSepolia = async () => {
      try {
        if (isConnected && chainId !== appChainId && !isSwitching) {
          await switchChainAsync({ chainId: appChainId });
        }
      } catch (_) {}
    };
    ensureBaseSepolia();
  }, [isConnected, chainId, isSwitching, switchChainAsync]);

  const onConnectClick = async () => {
    const c = consoleRef.current;
    if (c) {
      c.textContent = "// opening wallet picker…";
      c.classList.add("visible");
      setTimeout(() => c.classList.remove("visible"), 2400);
    }
    await openConnectModal?.();
  };

  return (
    <div className="hero">
      <BackgroundFX />
      <div className="hero-scrim" />

      <div className="content-container">
        {/* Protocol badge */}
        <div className="hero-badge" ref={badgeRef}>
          <span className="hero-dot" />
          Decentralized Freelance &nbsp;·&nbsp; Base Network
        </div>

        {/* Headline */}
        <h1
          className="font-syne font-black leading-[0.88] tracking-tight"
          style={{ fontSize: "clamp(2.4rem, 9vw, 6.5rem)" }}
          ref={headlineRef}
        >
          <span className="block">THE DEAL</span>
          <span className="block">IS THE</span>
          <span className="block hero-accent">CONTRACT</span>
        </h1>

        {/* Subheading */}
        <div className="subheading mt-7" ref={subheadingRef}>
          {SUBHEADING_LINES.map((line) => (
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
              <span className="cta-command" onClick={onConnectClick}>
                connect.wallet
              </span>
              <span className="cta-cursor"></span>
              <div className="console-message" ref={consoleRef}>
                // ready to connect
              </div>
            </>
          ) : (
            <Link href="/board">
              <button className="primary-btn">Get Started →</button>
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
