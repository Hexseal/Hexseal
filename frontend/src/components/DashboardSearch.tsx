'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Search, X, ArrowRight, Briefcase, Wrench, Handshake } from 'lucide-react';
import type { GraphAgreement } from '@/hooks/useMyAgreements';
import type { MyJobEntry } from '@/hooks/useMyJobs';
import type { MyServiceEntry } from '@/hooks/useMyServices';
import { shortAddr } from '@/lib/utils';


function fmtUsdc(v: string) {
  const n = Number(v);
  return isNaN(n) ? v : (n / 1e6).toFixed(0);
}

const DEAL_STATUS: Record<number, { label: string; dot: string }> = {
  0: { label: 'Pending',   dot: 'bg-white/30' },
  1: { label: 'Active',    dot: 'bg-violet-400' },
  2: { label: 'Done',      dot: 'bg-emerald-400' },
  3: { label: 'Refunded',  dot: 'bg-white/30' },
  4: { label: 'Disputed',  dot: 'bg-orange-400' },
  5: { label: 'Resolved',  dot: 'bg-blue-400' },
};

const JOB_STATUS_LABEL: Record<string, string> = {
  open: 'Open', closed: 'Closed', cancelled: 'Cancelled',
};

function hit(q: string, ...fields: (string | undefined | null)[]) {
  const ql = q.toLowerCase();
  return fields.some(f => f?.toLowerCase().includes(ql));
}

type Result =
  | { kind: 'deal';    data: GraphAgreement }
  | { kind: 'job';     data: MyJobEntry }
  | { kind: 'service'; data: MyServiceEntry };

export function DashboardSearch({
  agreements,
  jobs,
  services,
}: {
  agreements: GraphAgreement[];
  jobs: MyJobEntry[];
  services: MyServiceEntry[];
}) {
  const t = useTranslations('dashboard.search');
  const [query, setQuery] = useState('');
  const [open, setOpen]   = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const q = query.trim();

  const results = useMemo((): Result[] => {
    if (q.length < 2) return [];

    const deals = agreements
      .filter(a => hit(q, a.id, a.client, a.executor, fmtUsdc(a.amount)))
      .slice(0, 4)
      .map((data): Result => ({ kind: 'deal', data }));

    const jobResults = jobs
      .filter(j => hit(q, j.title, j.id, fmtUsdc(j.amount)))
      .slice(0, 4)
      .map((data): Result => ({ kind: 'job', data }));

    const svcResults = services
      .filter(s => hit(q, s.title, s.id, fmtUsdc(s.price)))
      .slice(0, 4)
      .map((data): Result => ({ kind: 'service', data }));

    return [...deals, ...jobResults, ...svcResults];
  }, [q, agreements, jobs, services]);

  const showDropdown = open && q.length >= 2;

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  function clear() {
    setQuery('');
    setOpen(false);
    inputRef.current?.focus();
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative flex items-center">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/25 pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={t('placeholder')}
          className="w-full h-10 pl-10 pr-9 rounded-[16px] bg-white/[0.04] border border-white/[0.08] text-sm text-white/80 placeholder:text-white/20 outline-none focus:border-white/20 focus:bg-white/[0.06] transition-all duration-150"
        />
        {query && (
          <button
            onClick={clear}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/50 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {showDropdown && (
        <div className="absolute top-full left-0 right-0 mt-1.5 z-50 rounded-[18px] border border-white/[0.09] bg-[#0f0f11] overflow-hidden shadow-[0_8px_32px_rgba(0,0,0,0.6),0_2px_8px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.04)]">
          {results.length === 0 ? (
            <p className="px-4 py-3.5 text-sm text-white/25">{t('no_results')}</p>
          ) : (
            <div className="py-1">
              {(['deal', 'job', 'service'] as const).map(kind => {
                const group = results.filter(r => r.kind === kind);
                if (!group.length) return null;

                const { icon, label, href } = kind === 'deal'
                  ? { icon: <Handshake className="w-3 h-3" />, label: t('type_deals'), href: (r: Result) => `/deal/${(r.data as GraphAgreement).id}` }
                  : kind === 'job'
                  ? { icon: <Briefcase className="w-3 h-3" />, label: t('type_jobs'), href: (r: Result) => `/job/${(r.data as MyJobEntry).id}` }
                  : { icon: <Wrench className="w-3 h-3" />, label: t('type_services'), href: (r: Result) => `/service/${(r.data as MyServiceEntry).id}` };

                return (
                  <div key={kind}>
                    <div className="flex items-center gap-1.5 px-4 pt-2.5 pb-1">
                      <span className="text-white/20">{icon}</span>
                      <span className="text-[10px] font-semibold tracking-widest uppercase text-white/25">{label}</span>
                    </div>
                    {group.map((r, i) => (
                      <Link
                        key={i}
                        href={href(r)}
                        onClick={() => setOpen(false)}
                        className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-white/[0.04] transition-colors group"
                      >
                        <div className="min-w-0 flex-1">
                          {r.kind === 'deal' && (
                            <>
                              <div className="flex items-center gap-1.5 mb-0.5">
                                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${DEAL_STATUS[r.data.status]?.dot ?? 'bg-white/20'}`} />
                                <span className="text-[11px] font-medium text-white/50">{DEAL_STATUS[r.data.status]?.label ?? `#${r.data.status}`}</span>
                                <span className="text-[11px] text-white/20">·</span>
                                <span className="text-[11px] font-mono text-white/40">{fmtUsdc(r.data.amount)} USDC</span>
                              </div>
                              <p className="text-[11px] font-mono text-white/30 truncate">{shortAddr(r.data.client)} → {shortAddr(r.data.executor)}</p>
                            </>
                          )}
                          {r.kind === 'job' && (
                            <>
                              <p className="text-[13px] font-medium text-white/75 truncate leading-snug">{r.data.title}</p>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <span className="text-[11px] text-white/30">{JOB_STATUS_LABEL[r.data.status] ?? r.data.status}</span>
                                <span className="text-[11px] text-white/15">·</span>
                                <span className="text-[11px] font-mono text-white/30">{fmtUsdc(r.data.amount)} USDC</span>
                              </div>
                            </>
                          )}
                          {r.kind === 'service' && (
                            <>
                              <p className="text-[13px] font-medium text-white/75 truncate leading-snug">{r.data.title}</p>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <span className="text-[11px] text-white/30">{r.data.status}</span>
                                <span className="text-[11px] text-white/15">·</span>
                                <span className="text-[11px] font-mono text-white/30">{fmtUsdc(r.data.price)} USDC</span>
                              </div>
                            </>
                          )}
                        </div>
                        <ArrowRight className="w-3 h-3 text-white/15 group-hover:text-white/35 transition-colors flex-shrink-0" />
                      </Link>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
