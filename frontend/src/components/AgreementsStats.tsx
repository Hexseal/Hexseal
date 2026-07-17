'use client';

import { motion } from 'framer-motion';
import { Zap } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { fmtVolume, type xpLevel } from '@/hooks/useAgreementsSummary';

// Shared by /dashboard and /profile/[address] — the "loaded" counterpart to
// LevelCardSkeleton/StatsRowSkeleton in components/AgreementsSkeleton.tsx.
//
// One merged level card (icon + name + XP-until-next-tier + progress bar) +
// one plain three-column stats row, replacing the old 4-card grid + separate
// XP-bar card (which duplicated the level name/XP in two places).

interface AgreementsStatsProps {
  level: ReturnType<typeof xpLevel>;
  xp: number;
  activeCount: number;
  completedCount: number;
  totalVolume: number;
}

export function AgreementsStats({ level, xp, activeCount, completedCount, totalVolume }: AgreementsStatsProps) {
  const t = useTranslations();

  const xpLine = level.nextThreshold !== null && level.nextLabelKey !== null
    ? `${xp} XP ${t('dashboard.stat_xp_until_next', { n: level.nextThreshold - xp, tier: t(level.nextLabelKey) })}`
    : `${xp} XP`;

  const stats: { value: string | number; label: string }[] = [
    { value: activeCount, label: t('dashboard.stat_active') },
    { value: completedCount, label: t('dashboard.stat_completed') },
    { value: fmtVolume(totalVolume), label: t('dashboard.stat_volume') },
  ];

  return (
    <div className="space-y-3">
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'tween', duration: 0.25, ease: 'easeOut' }}
        className="rounded-[20px] border border-white/[0.08] bg-[#0d0d0f] px-4 py-3"
        style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}
      >
        <div className="flex items-center gap-3 mb-2">
          <motion.div
            className="w-9 h-9 rounded-[12px] bg-white/[0.06] flex items-center justify-center flex-shrink-0"
            initial={{ rotate: -10, scale: 0.8 }}
            animate={{ rotate: 0, scale: 1 }}
            transition={{ delay: 0.08, type: 'tween', duration: 0.2, ease: 'easeOut' }}
          >
            <Zap className={`w-4 h-4 ${level.color}`} />
          </motion.div>
          <div className="min-w-0">
            <p className={`text-sm font-bold leading-none mb-1 ${level.color}`}>{t(level.labelKey)}</p>
            <p className="text-[11px] text-white/35 leading-none">{xpLine}</p>
          </div>
        </div>
        <div className="h-1.5 rounded-full bg-white/8 overflow-hidden">
          <motion.div
            className={`h-full rounded-full origin-left ${level.bar}`}
            initial={{ scaleX: 0 }}
            animate={{ scaleX: Math.min(100, level.pct) / 100 }}
            transition={{ delay: 0.15, type: 'tween', duration: 0.6, ease: [0.25, 1, 0.5, 1] }}
          />
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, type: 'tween', duration: 0.25, ease: 'easeOut' }}
        className="flex items-center justify-between px-2"
      >
        {stats.map((s, i) => (
          <div key={i} className="flex flex-col items-center gap-0.5">
            <span className="text-lg font-bold text-white leading-none">{s.value}</span>
            <span className="text-[11px] text-white/35 leading-none">{s.label}</span>
          </div>
        ))}
      </motion.div>
    </div>
  );
}
