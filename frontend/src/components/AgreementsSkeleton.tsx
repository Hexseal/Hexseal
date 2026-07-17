"use client";

// Shared skeleton pieces for pages built around useMyAgreements() — /dashboard
// and the public /profile/[address] page render the same stats row, XP bar,
// tab row and deal list, so their loading placeholders live here once instead
// of as two hand-copied definitions that can drift apart.

export function StatCardSkeleton({ index = 0 }: { index?: number }) {
  return (
    <div
      className="animate-pulse rounded-[20px] border border-white/[0.08] bg-[#0d0d0f] px-4 py-3 flex items-center gap-3"
      style={{ animationDelay: `${index * 0.05}s` }}
    >
      <div className="w-9 h-9 rounded-[12px] bg-white/[0.06] flex-shrink-0" />
      <div className="min-w-0 space-y-2">
        <div className="h-2.5 w-16 rounded bg-white/[0.06]" />
        <div className="h-5 w-10 rounded bg-white/[0.08]" />
        <div className="h-2 w-12 rounded bg-white/[0.04]" />
      </div>
    </div>
  );
}

export function StatsRowSkeleton() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {[0, 1, 2, 3].map(i => <StatCardSkeleton key={i} index={i} />)}
    </div>
  );
}

export function XpBarSkeleton() {
  return (
    <div className="animate-pulse rounded-[20px] border border-white/[0.08] bg-[#0d0d0f] px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <div className="h-3 w-16 rounded bg-white/[0.06]" />
        <div className="h-3 w-10 rounded bg-white/[0.06]" />
      </div>
      <div className="h-1.5 rounded-full bg-white/[0.06]" />
    </div>
  );
}

export function TabsRowSkeleton() {
  return (
    <div className="flex gap-1">
      {[0, 1, 2].map(i => <div key={i} className="animate-pulse h-9 w-24 rounded-[10px] bg-white/[0.04]" />)}
    </div>
  );
}

export function ListSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map(i => (
        <div key={i} className="animate-pulse rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] h-[72px]" style={{ animationDelay: `${i * 0.1}s` }} />
      ))}
    </div>
  );
}
