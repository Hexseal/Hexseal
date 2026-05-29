"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { fetchProfile } from "@/lib/profiles-ipfs";

// ─── UserAvatar ───────────────────────────────────────────────────────────────
// Small avatar circle: profile pic or initials fallback. Lazy-fetches on mount.

interface UserAvatarProps {
  address: string;
  size?: number;       // px, default 22
  link?: boolean;
  className?: string;
}

export function UserAvatar({ address, size = 22, link = false, className = "" }: UserAvatarProps) {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    if (!address) return;
    let alive = true;
    fetchProfile(address)
      .then(p => {
        if (!alive) return;
        if (p?.avatarUrl) setAvatarUrl(p.avatarUrl);
        else if (p?.avatarCid) {
          const gw = process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://dweb.link';
          setAvatarUrl(`${gw}/ipfs/${p.avatarCid}`);
        }
        if (p?.displayName) setName(p.displayName);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [address]);

  const initials = name
    ? name.slice(0, 2).toUpperCase()
    : address.slice(2, 4).toUpperCase();

  const circle = (
    <div
      className={`rounded-full overflow-hidden flex-shrink-0 bg-white/[0.08] border border-white/[0.08] flex items-center justify-center ${className}`}
      style={{ width: size, height: size }}
      title={name ?? address}
    >
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
      ) : (
        <span style={{ fontSize: Math.round(size * 0.42) }} className="text-white/40 font-mono font-semibold select-none leading-none">
          {initials}
        </span>
      )}
    </div>
  );

  if (link) return <Link href={`/profile/${address}`}>{circle}</Link>;
  return circle;
}

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
