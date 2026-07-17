'use client';

import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Activity, CheckCircle, DollarSign, Star, Zap } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { fmtVolume, type xpLevel } from '@/hooks/useAgreementsSummary';

// Shared by /dashboard and /profile/[address] — the "loaded" counterpart to
// StatsRowSkeleton/XpBarSkeleton in components/AgreementsSkeleton.tsx.

// ─── Stat card — tween entrance, no hover/tap springs ────────────────────────

export function StatCard({ icon, label, value, sub, index = 0 }: {
  icon: ReactNode; label: string; value: string | number; sub?: string; index?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay: index * 0.07, type: 'tween', duration: 0.25, ease: 'easeOut' }}
      className="rounded-[20px] border border-white/[0.08] bg-[#0d0d0f] px-4 py-3 flex items-center gap-3 cursor-default"
      style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}
    >
      <motion.div
        className="w-9 h-9 rounded-[12px] bg-white/[0.06] flex items-center justify-center flex-shrink-0"
        initial={{ rotate: -10, scale: 0.8 }}
        animate={{ rotate: 0, scale: 1 }}
        transition={{ delay: index * 0.07 + 0.08, type: 'tween', duration: 0.2, ease: 'easeOut' }}
      >
        {icon}
      </motion.div>
      <div className="min-w-0">
        <p className="text-xs text-white/35 leading-none mb-1">{label}</p>
        <p className="text-lg font-bold text-white leading-none">{value}</p>
        {sub && <p className="text-[11px] text-white/30 mt-0.5">{sub}</p>}
      </div>
    </motion.div>
  );
}

interface AgreementsStatsProps {
  level: ReturnType<typeof xpLevel>;
  xp: number;
  activeCount: number;
  completedCount: number;
  totalVolume: number;
}

// Stats row (level / active / completed / volume) + XP progress bar.
export function AgreementsStats({ level, xp, activeCount, completedCount, totalVolume }: AgreementsStatsProps) {
  const t = useTranslations();
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard index={0} icon={<Zap className="w-4 h-4 text-violet-400" />} label={t("dashboard.stat_level")} value={t(level.labelKey)} sub={`${xp} XP`} />
        <StatCard index={1} icon={<Activity className="w-4 h-4 text-sky-400" />} label={t("dashboard.stat_active")} value={activeCount} sub={activeCount === 1 ? t("dashboard.stat_deal") : t("dashboard.stat_deals")} />
        <StatCard index={2} icon={<CheckCircle className="w-4 h-4 text-emerald-400" />} label={t("dashboard.stat_completed")} value={completedCount} sub={completedCount === 1 ? t("dashboard.stat_deal") : t("dashboard.stat_deals")} />
        <StatCard index={3} icon={<DollarSign className="w-4 h-4 text-amber-400" />} label={t("dashboard.stat_volume")} value={fmtVolume(totalVolume)} sub={t("dashboard.stat_usdc_total")} />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, type: 'tween', duration: 0.25, ease: 'easeOut' }}
        className="rounded-[20px] border border-white/[0.08] bg-[#0d0d0f] px-4 py-3"
        style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Star className="w-3.5 h-3.5 text-white/30" />
            <span className={`text-xs font-semibold ${level.color}`}>{t(level.labelKey)}</span>
          </div>
          <span className="text-xs font-mono text-white/30">{xp} XP</span>
        </div>
        <div className="h-1.5 rounded-full bg-white/8 overflow-hidden">
          <motion.div
            className={`h-full rounded-full origin-left ${level.bar}`}
            initial={{ scaleX: 0 }}
            animate={{ scaleX: Math.min(100, level.pct) / 100 }}
            transition={{ delay: 0.4, type: 'tween', duration: 0.6, ease: [0.25, 1, 0.5, 1] }}
          />
        </div>
      </motion.div>
    </>
  );
}
