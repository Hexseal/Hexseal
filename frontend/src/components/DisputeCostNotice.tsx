'use client';

import { useReadContract } from 'wagmi';
import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { AGREEMENT_ABI } from '@/config/contracts';
import { classifyReadFailure } from '@/lib/contractReadError';
import { splitPot, usdcExact } from '@/lib/splitPot';

/**
 * Два факта, которые сторона обязана увидеть ДО нажатия «открыть спор»:
 *
 *  1. Сбор 3% от котла берётся НЕЗАВИСИМО ОТ ИСХОДА. Сегодня пользователь
 *     узнаёт про него только когда деньги пришли меньше ожидаемого.
 *  2. Если за спор никто не возьмётся за DISPUTE_WINDOW, котёл делится
 *     ПОПОЛАМ — не «возвращается клиенту», как было раньше. Арбитру достаётся
 *     3% от котла, то есть на сделке в $50 — $1.50, поэтому на мелких сделках
 *     дележ не редкий край, а основной исход. Обещать разбирательство и не
 *     сказать, что его может не случиться, — ровно то, чего мы избегаем.
 *
 * Суммы и срок читаются с контракта, а не хардкодятся: DISPUTE_WINDOW уже
 * менялась однажды с 7 дней на 4, и захардкоженный фронт после следующей
 * правки начал бы врать молча. Половины считаются в `lib/splitPot` — ровно как
 * в `Agreement.triggerArbiterTimeout`, вычитанием, чтобы показанное совпало с
 * выплаченным до последнего юнита.
 *
 * Если чтение провалилось, важно ПОЧЕМУ (`lib/contractReadError`):
 *
 *  • контракт ответил отказом (старый клон Agreement без селектора
 *    `disputeFee` — у Agreement нет fallback, вызов реверта) — не рисуется
 *    ничего. Это намеренно: такая сделка живёт по старым правилам — сбора нет,
 *    таймаут без клейма возвращает всё клиенту, — и новое предупреждение было
 *    бы про неё ложью;
 *  • не доехали до цепи (RPC, таймаут) — рисуется нейтральная строка. Иначе
 *    сбой сети выглядел бы точно так же, как старый клон, и предупреждение,
 *    которое мы обязались показывать, тихо исчезало бы вместе с ним, оставляя
 *    диалог с активной кнопкой и без единого слова про сбор.
 */

export function DisputeCostNotice({ agreementAddr }: { agreementAddr: string }) {
  const t = useTranslations();
  const address = agreementAddr as `0x${string}`;
  const enabled = !!agreementAddr;

  type Read = { data: bigint | undefined; isLoading: boolean; error: unknown };

  const { data: fee, isLoading: feeLoading, error: feeError } = useReadContract({
    address,
    abi: AGREEMENT_ABI,
    functionName: 'disputeFee',
    query: { enabled },
  }) as Read;

  const { data: pot, isLoading: potLoading, error: potError } = useReadContract({
    address,
    abi: AGREEMENT_ABI,
    functionName: 'totalPayout',
    query: { enabled },
  }) as Read;

  const { data: disputeWindow, isLoading: windowLoading, error: windowError } = useReadContract({
    address,
    abi: AGREEMENT_ABI,
    functionName: 'DISPUTE_WINDOW',
    query: { enabled },
  }) as Read;

  const loading = feeLoading || potLoading || windowLoading;

  if (fee === undefined || pot === undefined || disputeWindow === undefined) {
    // Пока читаем — держим место занятым, а не показываем диалог без
    // предупреждения: иначе оно всплывёт под курсором уже после того, как
    // человек прочитал модалку.
    if (loading) {
      return (
        <div className="rounded-[14px] border border-amber-400/20 bg-amber-400/[0.04] px-3 py-2.5">
          <p className="text-[11px] text-white/30">{t('common.loading')}</p>
        </div>
      );
    }

    // Хотя бы одно чтение не доехало до цепи — сказать нечего, но и молчать
    // нельзя: молчание здесь неотличимо от старого клона, у которого новых
    // правил действительно нет.
    const transportFailed = [feeError, potError, windowError].some(
      (e) => e && classifyReadFailure(e) === 'transport',
    );
    return transportFailed ? (
      <div className="rounded-[14px] border border-white/10 bg-white/[0.03] px-3 py-2.5">
        <p className="text-[11px] leading-relaxed text-white/40">
          {t('deal.dispute_terms_unreadable')}
        </p>
      </div>
    ) : null;
  }

  // Ровно как в контракте: половина исполнителю, ОСТАТОК клиенту.
  const { toExecutor, toClient } = splitPot(pot);

  // Дробное значение допустимо намеренно: окно в 36 часов даст 1.5, и ICU-plural
  // отрендерит "1.5 days" вместо вранья про "1 day".
  const days = Number(disputeWindow) / 86_400;

  return (
    <div className="rounded-[14px] border border-amber-400/25 bg-amber-400/[0.05] px-3 py-2.5 space-y-1.5">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-px" />
        <p className="text-[11px] leading-relaxed text-amber-200/80">
          {t('deal.dispute_fee_notice', { fee: usdcExact(fee), pot: usdcExact(pot) })}
        </p>
      </div>
      <p className="text-[11px] leading-relaxed text-white/45 pl-[22px]">
        {t('deal.dispute_no_arbiter_notice', {
          days,
          toExecutor: usdcExact(toExecutor),
          toClient: usdcExact(toClient),
        })}
      </p>
      {/* Средство от исхода, о котором предупреждает строка выше, теперь
          существует — и молчать о нём, продолжая пугать дележом, значит
          описывать безвыходной ситуацию, у которой выход есть. Суммы тут
          намеренно нет: пока спор не открыт, котировки не существует
          (quoteDisputeTopUp ревертит NotDisputed вне статуса DISPUTED), а
          компонент показывается в том числе в модалке ПОДНЯТИЯ спора. */}
      <p className="text-[11px] leading-relaxed text-white/45 pl-[22px]">
        {t('deal.dispute_arbiter_topup_notice')}
      </p>
    </div>
  );
}
