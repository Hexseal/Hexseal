"use client";

import Link from "next/link";
import { useProfile } from "@/hooks/useProfile";
import { shortAddr } from "@/lib/utils";

// ─── UserAvatar ───────────────────────────────────────────────────────────────

interface UserAvatarProps {
  address: string;
  size?: number;
  link?: boolean;
  className?: string;
}

export function UserAvatar({ address, size = 22, link = false, className = "" }: UserAvatarProps) {
  const { avatarUrl, displayName } = useProfile(address);

  const initials = displayName
    ? displayName.slice(0, 2).toUpperCase()
    : address.slice(2, 4).toUpperCase();

  const circle = (
    <div
      className={`rounded-full overflow-hidden flex-shrink-0 bg-white/[0.08] border border-white/[0.08] flex items-center justify-center ${className}`}
      style={{ width: size, height: size }}
      title={displayName ?? address}
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

// ─── UserName ─────────────────────────────────────────────────────────────────

interface UserNameProps {
  address: string;
  link?: boolean;
  className?: string;
  fallback?: string;
}

export function UserName({ address, link = false, className, fallback }: UserNameProps) {
  const { displayName } = useProfile(address);
  const display = displayName ?? fallback ?? shortAddr(address);

  if (link) return <Link href={`/profile/${address}`} className={className}>{display}</Link>;
  return <span className={className}>{display}</span>;
}
