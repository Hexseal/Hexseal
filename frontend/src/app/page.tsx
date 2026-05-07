"use client";

import React, { useEffect } from "react";
import { useAccount } from "wagmi";
import Hero from "@/components/Hero";

export default function Home() {
  const { isConnected } = useAccount();

  useEffect(() => {
    if (isConnected) {
      const el = document.getElementById("site-content");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [isConnected]);

  return (
    <>
      <Hero />
    </>
  );
}
