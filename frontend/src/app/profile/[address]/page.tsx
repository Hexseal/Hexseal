"use client";

import { useParams } from "next/navigation";
import { useAccount } from "wagmi";
import { useProfile } from "@/hooks/useProfile";
import { useAgreementsSummary } from "@/hooks/useAgreementsSummary";
import { resolveMediaUrl } from "@/lib/mediaUrl";
import { Button } from "@/components/ui/button";
import { Zap, Copy, Edit, ExternalLink } from "lucide-react";
import Link from "next/link";
import { toast } from "react-hot-toast";
import { isAddress } from "viem";
import { useTranslations } from "next-intl";
import { StatsRowSkeleton, XpBarSkeleton, TabsRowSkeleton, ListSkeleton } from "@/components/AgreementsSkeleton";
import { AgreementsStats } from "@/components/AgreementsStats";
import { AgreementsTabs } from "@/components/AgreementsTabs";
import { PageCenter } from "@/components/PageCenter";
import { shortAddr } from "@/lib/utils";

// ─── Address Avatar ───────────────────────────────────────────────────────────

function AddressAvatar({ address, size = 64 }: { address: string; size?: number }) {
  const palettes = [
    ['#6366f1', '#8b5cf6'], ['#06b6d4', '#3b82f6'], ['#10b981', '#06b6d4'],
    ['#f59e0b', '#ef4444'], ['#ec4899', '#8b5cf6'], ['#84cc16', '#10b981'],
  ];
  const hash = address.slice(2).split('').reduce((a, b) => a + b.charCodeAt(0), 0);
  const [c1, c2] = palettes[hash % palettes.length];
  const initial = address.slice(2, 4).toUpperCase();
  return (
    <div
      className="rounded-2xl flex items-center justify-center font-mono font-bold text-white flex-shrink-0"
      style={{
        width: size, height: size,
        background: `linear-gradient(135deg, ${c1}, ${c2})`,
        fontSize: size * 0.32,
        boxShadow: `0 0 ${size * 0.4}px ${c1}33`,
      }}
    >
      {initial}
    </div>
  );
}

// ─── Bottom-half skeleton — one block for stats + xp bar + tabs + content, all of
// which key off the same useMyAgreements isLoading. Previously this was checked
// independently in three places, so the three sections could flash out of step. ──

function ProfileBottomSkeleton() {
  return (
    <>
      <StatsRowSkeleton />
      <XpBarSkeleton />
      <TabsRowSkeleton />
      <ListSkeleton />
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const t = useTranslations();
  const params = useParams();
  const profileAddress = ((params.address as string) || '').toLowerCase();
  const { address: viewerAddress } = useAccount();

  const isOwner = viewerAddress?.toLowerCase() === profileAddress;
  const validAddress = isAddress(profileAddress);

  const { profile } = useProfile(validAddress ? profileAddress : undefined);

  const {
    rawAgreements, isLoading, refetch,
    xp, level, activeDeals, historyDeals, completed, totalVolume,
  } = useAgreementsSummary(validAddress ? profileAddress : undefined);

  const memberSince = rawAgreements.length > 0
    ? new Date(Math.min(...rawAgreements.map(a => Number(a.createdAt))) * 1000)
    : null;

  if (!validAddress) {
    return (
      <PageCenter>
        <p className="text-white/40 text-sm">{t("profile.invalid_address")}</p>
      </PageCenter>
    );
  }

  return (
    <div className="mx-auto px-4 py-5 max-w-4xl space-y-4 overflow-x-hidden w-full">

      {/* ── Profile header ─────────────────────────────────────────────── */}
      <div
        className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-6 py-5"
        style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}
      >
        <div className="flex items-start gap-4">
          {(profile?.avatarUrl || profile?.avatarCid) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={
                resolveMediaUrl(
                  profile.avatarUrl ||
                  `${process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://cloudflare-ipfs.com'}/ipfs/${profile.avatarCid}`
                ) ?? undefined
              }
              alt={profile.displayName || 'Avatar'}
              className="w-[72px] h-[72px] rounded-2xl object-cover flex-shrink-0"
            />
          ) : (
            <AddressAvatar address={profileAddress} size={72} />
          )}

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <h1 className="text-xl font-bold text-white">
                {profile?.displayName || (isOwner ? t("profile.your_profile") : shortAddr(profileAddress))}
              </h1>
              <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs border border-white/10 font-semibold ${level.color}`}>
                <Zap className="w-3 h-3" />{t(level.labelKey)}
              </span>
              {profile?.role && (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs border border-white/10 text-white/40 bg-white/[0.03]">
                  {profile.role === 'client' ? t("profile.client_role_badge") : profile.role === 'executor' ? t("profile.executor_role_badge") : t("profile.role_client_executor")}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-white/30 font-mono">
              <span>{shortAddr(profileAddress)}</span>
              <button
                onClick={() => { navigator.clipboard.writeText(profileAddress); toast.success(t("common.copied")); }}
                className="hover:text-white/60 transition-colors"
              >
                <Copy className="w-3 h-3" />
              </button>
            </div>
            {profile?.bio ? (
              <p className="text-xs text-white/50 mt-2 leading-relaxed">{profile.bio}</p>
            ) : (
              <p className="text-xs text-white/25 mt-1.5">{t("profile.on_chain_info")}</p>
            )}
            {profile?.specializations && profile.specializations.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {profile.specializations.map(s => (
                  <span key={s} className="px-2 py-0.5 rounded-full text-[11px] border border-white/10 text-white/50 bg-white/[0.03]">
                    {s}
                  </span>
                ))}
              </div>
            )}
            {profile?.links && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
                {profile.links.telegram && (
                  <a href={`https://t.me/${profile.links.telegram}`} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-white/35 hover:text-white/70 transition-colors">
                    tg: @{profile.links.telegram}
                  </a>
                )}
                {profile.links.github && (
                  <a href={`https://github.com/${profile.links.github}`} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-white/35 hover:text-white/70 transition-colors">
                    github/{profile.links.github}
                  </a>
                )}
                {profile.links.twitter && (
                  <a href={`https://twitter.com/${profile.links.twitter}`} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-white/35 hover:text-white/70 transition-colors">
                    x.com/{profile.links.twitter}
                  </a>
                )}
                {profile.links.discord && (
                  <span className="text-xs text-white/35">discord: {profile.links.discord}</span>
                )}
                {profile.links.website && (
                  <a href={profile.links.website} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-white/35 hover:text-white/70 transition-colors truncate max-w-[160px]">
                    {profile.links.website.replace(/^https?:\/\//, '')}
                  </a>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-col items-end gap-2 shrink-0">
            {memberSince && (
              <span className="text-[11px] text-white/25">
                {t("profile.member_since", { date: memberSince.toLocaleDateString('en', { month: 'short', year: 'numeric' }) })}
              </span>
            )}
            {isOwner && (
              <Link href="/profile/edit">
                <Button variant="outline" size="sm">
                  <Edit className="w-3.5 h-3.5 mr-1" />{t("common.edit")}
                </Button>
              </Link>
            )}
            {!isOwner && viewerAddress && (
              <Link href={`/chat?peer=${profileAddress}`}>
                <Button variant="outline" size="sm">
                  <ExternalLink className="w-3.5 h-3.5 mr-1" />
                  {t("common.message") ?? "Message"}
                </Button>
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* ── Bottom half: stats + xp bar + tabs + content — one loading guard, since
           all of it keys off the same useMyAgreements isLoading. ── */}
      {isLoading ? (
        <ProfileBottomSkeleton />
      ) : (
        <>
          <AgreementsStats level={level} xp={xp} activeCount={activeDeals.length} completedCount={completed} totalVolume={totalVolume} />
          <AgreementsTabs
            key={profileAddress}
            listingsAddress={profileAddress as `0x${string}`}
            viewerAddress={viewerAddress ?? ''}
            activeDeals={activeDeals}
            historyDeals={historyDeals}
            refetch={refetch}
            showRequestsTab={isOwner}
            readOnlyListings={!isOwner}
            hideClosedJobs
            showEmptyActiveHint={isOwner}
          />
        </>
      )}

    </div>
  );
}
