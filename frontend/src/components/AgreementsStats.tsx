'use client';

import { motion } from 'framer-motion';
import { Zap } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { fmtVolume, type xpLevel } from '@/hooks/useAgreementsSummary';

// Shared by /dashboard and /profile/[address] — the "loaded" counterpart to
// StatsCardSkeleton in components/AgreementsSkeleton.tsx.
//
// One bordered card: level/XP block on top, a hairline divider, then the
// three-column stats row (active/completed/volume) below.

// Must match ReputationFacet.CLEAN_STREAK_REQUIRED / ArbiterRegistryFacet.MIN_CLEAN_STREAK_TO_REGISTER.
const CLEAN_STREAK_REQUIRED = 10;

interface AgreementsStatsProps {
  level: ReturnType<typeof xpLevel>;
  xp: number;
  cleanStreak: number;
  activeCount: number;
  completedCount: number;
  totalVolume: number;
  unresolvedDisputes: number;
  totalDeals: number;
  /** Сделки прочитать не удалось (сабграф не ответил). Числа, которые из них
   *  считаются, показывать НЕЛЬЗЯ: они будут нулями, а ноль здесь — это
   *  утверждение о человеке («сделок не было, оборот $0»), а не отсутствие
   *  ответа. Ровно та же подмена, что «услуг вы не публиковали» вместо
   *  «услугу не удалось прочитать». */
  dealsUnavailable?: boolean;
}

export function AgreementsStats({
  level, xp, cleanStreak, activeCount, completedCount, totalVolume,
  unresolvedDisputes, totalDeals, dealsUnavailable = false,
}: AgreementsStatsProps) {
  const t = useTranslations();

  // Below master tier: normal "until next tier" hint. At master (nextThreshold/nextLabelKey
  // are null — nothing above it), that slot would otherwise sit empty, so it shows the clean
  // streak instead — the thing that actually gates further XP growth past this point.
  const xpLine = level.nextThreshold !== null && level.nextLabelKey !== null
    ? `${xp} XP ${t('dashboard.stat_xp_until_next', { n: level.nextThreshold - xp, tier: t(level.nextLabelKey) })}`
    : cleanStreak < CLEAN_STREAK_REQUIRED
      ? `${xp} XP ${t('dashboard.stat_streak_building', { n: cleanStreak, need: CLEAN_STREAK_REQUIRED })}`
      : `${xp} XP ${t('dashboard.stat_streak_unlocked', { n: cleanStreak })}`;

  // Споры, кончившиеся без вердикта — ДОЛЕЙ от числа сделок, а не голым числом:
  // один спор из пятидесяти это шум, восемь из десяти — портрет, и голая
  // восьмёрка не отличает одно от другого. Механика без показа бесполезна
  // целиком — весь её смысл в том, что о ней ЗНАЕТ тот, кого она считает.
  //
  // При нулевом знаменателе колонки нет: доли от нуля сделок не существует,
  // а «0/0» у свежего адреса — это обвинение, выданное авансом ни за что.
  // При нулевом ЧИСЛИТЕЛЕ колонка остаётся: «0/12» ничего не портит, зато
  // делает счётчик публично известным ещё до того, как он кому-то понадобится,
  // — а сдерживает он именно тем, что о нём знают заранее.
  // Прочерк, а не ноль. Уровень и XP рядом остаются числами — они читаются
  // прямо с цепи и от сабграфа не зависят вовсе; гасить и их значило бы
  // прятать данные, которые как раз есть.
  const NO_DATA = '—';
  const stats: { value: string | number; label: string; danger?: boolean; muted?: boolean }[] = [
    { value: dealsUnavailable ? NO_DATA : activeCount,           label: t('dashboard.stat_active'),    muted: dealsUnavailable },
    { value: dealsUnavailable ? NO_DATA : completedCount,        label: t('dashboard.stat_completed'), muted: dealsUnavailable },
    { value: dealsUnavailable ? NO_DATA : fmtVolume(totalVolume), label: t('dashboard.stat_volume'),   muted: dealsUnavailable },
  ];
  // Доля споров без вердикта считается по знаменателю из сабграфа: без него
  // колонки нет — «8/0» бессмысленно, а «8/—» выглядит как обвинение с
  // потерянным контекстом.
  if (!dealsUnavailable && totalDeals > 0) {
    stats.push({
      value: `${unresolvedDisputes}/${totalDeals}`,
      label: t('dashboard.stat_unjudged'),
      danger: unresolvedDisputes > 0,
    });
  }

  return (
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

      <div className="flex items-center justify-between px-2 mt-3 pt-3 border-t border-white/[0.08]">
        {stats.map((s, i) => (
          <div key={i} className="flex flex-col items-center gap-0.5">
            <span className={`text-lg font-bold leading-none ${
              s.danger ? 'text-amber-400' : s.muted ? 'text-white/25' : 'text-white'
            }`}>{s.value}</span>
            <span className="text-[11px] text-white/35 leading-none">{s.label}</span>
          </div>
        ))}
      </div>
      {dealsUnavailable && (
        <p className="mt-2 text-[11px] leading-snug text-amber-400/70">
          {t('dashboard.stats_unavailable')}
        </p>
      )}
    </motion.div>
  );
}
