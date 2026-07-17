'use client';

import { useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Activity, CheckCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { DealCard, type AgreementRecord } from '@/app/dashboard/components/DealCard';
import { MyJobs, MyServices, MyClientRequests } from '@/app/dashboard/components/MyListings';

// Shared by /dashboard and /profile/[address] — tab row + tab content
// (listings sub-tabs, active deals, history). The two pages differ only in
// *whose* data is shown and whether it's editable, which the props below
// parameterize; the tab mechanics and markup are otherwise identical.

type TabKey = 'listings' | 'deals' | 'history';
type ListingsSub = 'jobs' | 'services' | 'requests';

// ─── Tab button ───────────────────────────────────────────────────────────────

export function Tab({ active, onClick, children, count }: {
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
  showRequestsTab?: boolean;          // default true
  readOnlyListings?: boolean;         // default false
  hideClosedJobs?: boolean;           // default false
  showEmptyActiveHint?: boolean;      // default true
}

export function AgreementsTabs({
  listingsAddress,
  viewerAddress,
  activeDeals,
  historyDeals,
  refetch,
  onListingsChange,
  showRequestsTab = true,
  readOnlyListings = false,
  hideClosedJobs = false,
  showEmptyActiveHint = true,
}: AgreementsTabsProps) {
  const t = useTranslations();
  const [tab, setTab] = useState<TabKey>('listings');
  const [listingsSub, setListingsSub] = useState<ListingsSub>('jobs');

  const listingsTabs: [ListingsSub, string][] = [
    ['jobs', t('dashboard.section_job_postings')],
    ['services', t('nav.services')],
    ...(showRequestsTab ? ([['requests', t('dashboard.section_service_requests')]] as [ListingsSub, string][]) : []),
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
                    <MyJobs address={listingsAddress} onDealCreated={onListingsChange} readOnly={readOnlyListings} hideClosed={hideClosedJobs} />
                  )}
                  {listingsSub === 'services' && (
                    <MyServices address={listingsAddress} onDealCreated={onListingsChange} readOnly={readOnlyListings} />
                  )}
                  {listingsSub === 'requests' && showRequestsTab && (
                    <MyClientRequests address={listingsAddress} />
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          )}

          {tab === 'deals' && (
            activeDeals.length === 0 ? (
              <div className="text-center py-10">
                <div className="float-icon">
                  <Activity className="w-8 h-8 text-white/10 mx-auto mb-3" />
                </div>
                <p className="text-sm text-white/30">{t("dashboard.empty_active")}</p>
                {showEmptyActiveHint && <p className="text-xs text-white/20 mt-1">{t("dashboard.empty_active_hint")}</p>}
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
            historyDeals.length === 0 ? (
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
    </div>
  );
}
