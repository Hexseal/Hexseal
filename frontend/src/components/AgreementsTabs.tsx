'use client';

import { useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Activity, CheckCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { DealCard, type AgreementRecord } from '@/components/DealCard';
import { MyJobs, MyServices, MyClientRequests } from '@/components/MyListings';
import { ListSkeleton } from '@/components/AgreementsSkeleton';
import { Button } from '@/components/ui/button';

// Shared by /dashboard and /profile/[address] — tab row + tab content
// (listings sub-tabs, active deals, history). The two pages differ only in
// *whose* data is shown and whether it's editable, which the props below
// parameterize; the tab mechanics and markup are otherwise identical.

type TabKey = 'listings' | 'deals' | 'history';
type ListingsSub = 'jobs' | 'services' | 'requests';

// ─── Tab button ───────────────────────────────────────────────────────────────

function Tab({ active, onClick, children, count }: {
  active: boolean; onClick: () => void; children: ReactNode; count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative px-4 py-2 text-sm font-medium rounded-[10px] flex items-center gap-1.5 flex-shrink-0 transition-all duration-200 ${
        active ? 'text-white bg-white/10' : 'text-white/40 hover:text-white/60 hover:bg-white/[0.05]'
      }`}
    >
      {count !== undefined && count > 0 && (
        <span className={`text-[11px] px-1.5 py-0.5 rounded-md font-mono transition-colors duration-200 ${
          active ? 'bg-white/15 text-white/80' : 'bg-white/[0.06] text-white/35'
        }`}>
          {count}
        </span>
      )}
      {children}
    </button>
  );
}

interface AgreementsTabsProps {
  listingsAddress: `0x${string}`;     // whose jobs/services/requests to list
  viewerAddress: string;              // passed to DealCard as `address` for role detection (client/executor/arbiter) — may differ from listingsAddress when viewing someone else's profile
  activeDeals: AgreementRecord[];
  historyDeals: AgreementRecord[];
  refetch: () => void;
  onListingsChange?: () => void;      // fired when MyJobs/MyServices create a deal — dashboard refetches its own agreements; omitted on a read-only profile view
  isLoading?: boolean;                // default false. Tab row always renders; only the content pane swaps to a skeleton. Callers that want the whole component (tabs included) to stay hidden until data is ready should gate the AgreementsTabs call itself instead of using this prop.
  error?: string | null;              // set when the underlying agreements fetch failed — the Deals/History panes show a retry block instead of empty-state copy, so a failed fetch doesn't read as "you have nothing"
  editable?: boolean;                 // default true. Dashboard is always the viewer's own data (no concept of ownership); profile passes its isOwner check. Gates the "requests" sub-tab, whether listings are read-only, and whether the empty-active-deals hint shows — these three always move together in this app, so one prop says what's actually true instead of three that happen to agree.
  hideClosedJobs?: boolean;           // default false — independent of `editable`; profile always hides closed job postings regardless of ownership, dashboard never does
}

export function AgreementsTabs({
  listingsAddress,
  viewerAddress,
  activeDeals,
  historyDeals,
  refetch,
  onListingsChange,
  isLoading = false,
  error = null,
  editable = true,
  hideClosedJobs = false,
}: AgreementsTabsProps) {
  const t = useTranslations();
  const [tab, setTab] = useState<TabKey>('listings');
  const [listingsSub, setListingsSub] = useState<ListingsSub>('jobs');

  const listingsTabs: [ListingsSub, string][] = [
    ['jobs', t('dashboard.section_job_postings')],
    ['services', t('nav.services')],
    ...(editable ? ([['requests', t('dashboard.section_service_requests')]] as [ListingsSub, string][]) : []),
  ];

  return (
    <div>
      <div className="flex gap-1 overflow-x-auto scrollbar-none mb-4">
        <Tab active={tab === 'listings'} onClick={() => setTab('listings')}>
          {t("dashboard.tabs.listings")}
        </Tab>
        <Tab active={tab === 'deals'} onClick={() => setTab('deals')} count={activeDeals.length}>
          {t("dashboard.tabs.deals")}
        </Tab>
        <Tab active={tab === 'history'} onClick={() => setTab('history')} count={historyDeals.length}>
          {t("dashboard.tabs.history")}
        </Tab>
      </div>

      {isLoading ? (
        <ListSkeleton />
      ) : (
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -3 }}
          transition={{ type: 'tween', duration: 0.15, ease: 'easeOut' }}
        >
          {tab === 'listings' && (
            <div>
              <div className="flex border-b border-white/[0.07] mb-5 -mx-0.5">
                {listingsTabs.map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setListingsSub(key)}
                    className={`px-3 pb-2.5 text-[11px] font-semibold tracking-widest uppercase border-b-2 -mb-px transition-colors ${
                      listingsSub === key
                        ? 'border-white/40 text-white/70'
                        : 'border-transparent text-white/25 hover:text-white/45'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={listingsSub}
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -3 }}
                  transition={{ type: 'tween', duration: 0.13 }}
                >
                  {listingsSub === 'jobs' && (
                    <MyJobs address={listingsAddress} onDealCreated={onListingsChange} readOnly={!editable} hideClosed={hideClosedJobs} />
                  )}
                  {listingsSub === 'services' && (
                    <MyServices address={listingsAddress} onDealCreated={onListingsChange} readOnly={!editable} />
                  )}
                  {listingsSub === 'requests' && editable && (
                    <MyClientRequests address={listingsAddress} />
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          )}

          {tab === 'deals' && (
            error ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <div className="mb-3 rounded-[14px] border border-red-400/20 bg-red-400/5 px-4 py-3 text-xs text-red-400/80">
                  {t("common.error")}
                </div>
                <Button size="sm" variant="outline" className="border-white/15 text-white/60" onClick={refetch}>
                  {t("common.retry")}
                </Button>
              </div>
            ) : activeDeals.length === 0 ? (
              <div className="text-center py-10">
                <div className="float-icon">
                  <Activity className="w-8 h-8 text-white/10 mx-auto mb-3" />
                </div>
                <p className="text-sm text-white/30">{t("dashboard.empty_active")}</p>
                {editable && <p className="text-xs text-white/20 mt-1">{t("dashboard.empty_active_hint")}</p>}
              </div>
            ) : (
              <div className="space-y-3">
                {activeDeals.map((a, index) => (
                  <div
                    key={a.agreement}
                    className="card-enter active:scale-[0.985] transition-transform duration-100 cursor-pointer"
                    style={{ animationDelay: `${Math.min(index, 5) * 0.06}s` }}
                  >
                    <DealCard agreement={a} address={viewerAddress} refetch={refetch} />
                  </div>
                ))}
              </div>
            )
          )}

          {tab === 'history' && (
            error ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <div className="mb-3 rounded-[14px] border border-red-400/20 bg-red-400/5 px-4 py-3 text-xs text-red-400/80">
                  {t("common.error")}
                </div>
                <Button size="sm" variant="outline" className="border-white/15 text-white/60" onClick={refetch}>
                  {t("common.retry")}
                </Button>
              </div>
            ) : historyDeals.length === 0 ? (
              <div className="text-center py-10">
                <div className="float-icon">
                  <CheckCircle className="w-8 h-8 text-white/10 mx-auto mb-3" />
                </div>
                <p className="text-sm text-white/30">{t("dashboard.empty_history")}</p>
              </div>
            ) : (
              <div className="space-y-2 opacity-80">
                {historyDeals.map((a, index) => (
                  <div
                    key={`${a.agreement}-hist`}
                    className="card-enter active:scale-[0.985] transition-transform duration-100 cursor-pointer"
                    style={{ animationDelay: `${Math.min(index, 5) * 0.06}s` }}
                  >
                    <DealCard agreement={a} address={viewerAddress} refetch={refetch} />
                  </div>
                ))}
              </div>
            )
          )}
        </motion.div>
      </AnimatePresence>
      )}
    </div>
  );
}
