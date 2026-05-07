"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { fetchProfile } from "@/lib/profiles-ipfs";

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

interface UserNameProps {
  address: string;
  link?: boolean;
  className?: string;
  fallback?: string;
}

export function UserName({ address, link = false, className, fallback }: UserNameProps) {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    if (!address) return;
    let alive = true;
    fetchProfile(address)
      .then(p => { if (alive && p?.displayName) setName(p.displayName); })
      .catch(() => {});
    return () => { alive = false; };
  }, [address]);

  const display = name ?? fallback ?? shortAddr(address);

  if (link) {
    return (
      <Link href={`/profile/${address}`} className={className}>
        {display}
      </Link>
    );
  }
  return <span className={className}>{display}</span>;
}
