"use client";

import React, { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useRouter } from "next/navigation";
import Hero from "@/components/Hero";

// Set when wallet connects; cleared when wagmi confirms disconnected.
// Allows instant redirect on revisit without waiting for wagmi hydration.
const FLAG = "wallet-ever-connected";

export default function Home() {
  const { isConnected, status } = useAccount();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!mounted) return;

    if (isConnected) {
      localStorage.setItem(FLAG, "1");
      router.replace("/board");
      return;
    }

    // status==='disconnected' means wagmi finished hydrating and confirmed
    // the wallet is genuinely gone — safe to clear the flag.
    if (status === "disconnected") {
      localStorage.removeItem(FLAG);
    }
  }, [isConnected, status, mounted, router]);

  // Before mount, return nothing to avoid SSR/hydration mismatch.
  // After mount: if the flag is set and wagmi hasn't confirmed disconnected yet,
  // show nothing — the redirect will fire in the effect above.
  if (!mounted) return null;
  if (localStorage.getItem(FLAG) === "1" && status !== "disconnected") return null;

  return <Hero />;
}
