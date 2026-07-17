'use client';

import Link from 'next/link';
import { useAccount } from 'wagmi';
import { useAgreementsSummary } from '@/hooks/useAgreementsSummary';
import { Activity } from 'lucide-react';
import { DashboardSearch } from '@/components/DashboardSearch';
import { LevelCardSkeleton, StatsRowSkeleton, TabsRowSkeleton, ListSkeleton } from '@/components/AgreementsSkeleton';
import { AgreementsStats } from '@/components/AgreementsStats';
import { AgreementsTabs } from '@/components/AgreementsTabs';
import { useTranslations } from 'next-intl';
import { useMyJobs } from '@/hooks/useMyJobs';
import { useMyServices } from '@/hooks/useMyServices';
import { PageCenter } from "@/components/PageCenter";
import { Button } from '@/components/ui/button';

export default function DashboardPage() {
  const { address, isConnected, status } = useAccount();
  const t = useTranslations();

  const {
    rawAgreements, isLoading, refetch,
    xp, level, activeDeals, historyDeals, completed, totalVolume,
  } = useAgreementsSummary(address);
  const { jobs: mySearchJobs }     = useMyJobs(address);
  const { services: mySearchSvcs } = useMyServices(address);

  if (status === 'reconnecting' || status === 'connecting') {
    return (
      <div className="mx-auto px-4 py-5 max-w-6xl space-y-4 overflow-x-hidden w-full">
        <LevelCardSkeleton />
        <StatsRowSkeleton />
        <div className="animate-pulse h-9 rounded-[12px] bg-white/[0.04] w-full" />
        <TabsRowSkeleton />
        <ListSkeleton />
      </div>
    );
  }

  if (!isConnected) {
    return (
      <PageCenter>
        <div className="text-center max-w-sm">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-6">
            <Activity className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-bold font-syne mb-2">{t("dashboard.title")}</h1>
          <p className="text-muted-foreground text-sm mb-6">{t("dashboard.connect_prompt")}</p>
          <Link href="/"><Button variant="outline">{t("dashboard.go_home")}</Button></Link>
        </div>
      </PageCenter>
    );
  }

  return (
    <div className="mx-auto px-4 py-5 max-w-6xl space-y-4 overflow-x-hidden w-full">

        {/* ── Stats row + XP bar — one guard, since both key off the same isLoading ── */}
        {isLoading ? (
          <>
            <LevelCardSkeleton />
            <StatsRowSkeleton />
          </>
        ) : (
          <AgreementsStats level={level} xp={xp} activeCount={activeDeals.length} completedCount={completed} totalVolume={totalVolume} />
        )}

        {/* ── Unified search ── */}
        <DashboardSearch
          agreements={rawAgreements}
          jobs={mySearchJobs}
          services={mySearchSvcs}
        />

        {/* ── Tabs — rendered unconditionally so the tab row stays visible/clickable
             while agreements load, matching the original dashboard's timing; only
             the content pane swaps to a skeleton (via AgreementsTabs' isLoading prop) ── */}
        <AgreementsTabs
          listingsAddress={address!}
          viewerAddress={address!}
          activeDeals={activeDeals}
          historyDeals={historyDeals}
          refetch={refetch}
          onListingsChange={refetch}
          isLoading={isLoading}
        />
      </div>
  );
}
