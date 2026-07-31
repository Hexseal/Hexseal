'use client';

import { useState } from 'react';
import { useAccount, usePublicClient, useReadContract, useWalletClient } from 'wagmi';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Loader2, Undo2 } from 'lucide-react';
import { ARBITER_REGISTRY_ABI, CONTRACTS } from '@/config/contracts';
import { withdrawDisputeBountyGasless } from '@/lib/relay';
import { usdcExact } from '@/lib/splitPot';
import { Button } from '@/components/ui/button';

/**
 * Возврат доплаты за арбитра — единственный интерфейс к нему.
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ БЛОК, А НЕ СТРОКА В БАННЕРЕ СПОРА. Возврат появляется
 * ровно в тот миг, когда спор КОНЧИЛСЯ: `clearDisputeClaim` на таймауте и
 * `finalizeVerdict` при отменённом вердикте — оба пути срабатывают, когда
 * сделка уже уходит из статуса DISPUTED. Всё, что нарисовано внутри баннера
 * `status === 4`, к этому моменту с экрана исчезло. Кнопка, живущая там, была
 * бы мёртвым кодом: показывалась бы ровно тогда, когда забирать нечего, и
 * пропадала бы ровно тогда, когда есть.
 *
 * ПОЧЕМУ ОБЕЩАНИЕ ВОЗВРАТА НЕ ВЫПОЛНЯЕТСЯ САМО. Таймаут пытается вернуть
 * деньги толчком, и обычно это удаётся — но перевод там намеренно мягкий
 * (Agreement зовёт фасет внутри `try/catch`), и когда он не доходит, сумма
 * оседает в `refundableBounty`. А отменённый вердикт кладёт её туда ВСЕГДА и
 * безусловно: это не редкий край с чёрным списком USDC, а штатный исход
 * «арбитр ошибся». До этого блока о таких деньгах нельзя было узнать ничем,
 * кроме прямого вызова геттера, о существовании которого человек знать не мог.
 *
 * Баланс `getRefundableBounty` — ПО АДРЕСУ, а не по сделке: контракт не хранит,
 * из какого спора он набежал. Поэтому копирайт здесь не называет конкретную
 * сделку — назвать её значило бы соврать тому, кто оплачивал два спора.
 * По той же причине блок показывается и на дашборде: страницу закрытой сделки
 * можно не открыть больше никогда, а дашборд — то место, куда идут за деньгами.
 */
export function RefundableBounty({ className }: { className?: string }) {
  const t = useTranslations();
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [busy, setBusy] = useState(false);

  const { data: refundable, refetch } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: ARBITER_REGISTRY_ABI,
    functionName: 'getRefundableBounty',
    args: address ? [address as `0x${string}`] : undefined,
    query: { enabled: !!address },
  }) as { data: bigint | undefined; refetch: () => void };

  const handleWithdraw = async () => {
    if (!walletClient || !publicClient) return;
    setBusy(true);
    try {
      await withdrawDisputeBountyGasless(walletClient, publicClient);
      toast.success(t('deal.refund_bounty_success'));
      // Тот же приём, что у остальных денежных действий на странице сделки:
      // держим кнопку занятой, пока отложенное перечитывание не приедет, —
      // иначе она на секунду оживает с уже потраченной суммой.
      setTimeout(() => { refetch(); setBusy(false); }, 2000);
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      toast.error(e?.shortMessage || e?.message || t('common.transaction_failed'));
      setBusy(false);
    }
  };

  // Нечего забирать — блока нет вовсе. Не «$0.00 к возврату»: пустая строка про
  // деньги на каждой сделке и на каждом дашборде читалась бы как шум, а не как
  // событие, и настоящий возврат в ней бы утонул.
  if (refundable === undefined || refundable === 0n) return null;

  return (
    <div
      className={`rounded-[18px] border border-emerald-400/25 bg-emerald-400/[0.05] px-4 py-3.5 ${className ?? ''}`}
      style={{ boxShadow: '0 1px 8px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.03)' }}
    >
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-[10px] bg-emerald-400/15 flex items-center justify-center flex-shrink-0">
          <Undo2 className="w-4 h-4 text-emerald-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-emerald-300 mb-0.5">
            {t('deal.refund_bounty_title', { amount: usdcExact(refundable) })}
          </p>
          <p className="text-xs text-white/40 leading-relaxed mb-2.5">{t('deal.refund_bounty_hint')}</p>
          <Button
            size="sm"
            onClick={handleWithdraw}
            disabled={busy || !walletClient}
            className="bg-emerald-500/90 hover:bg-emerald-500 text-white"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Undo2 className="w-3.5 h-3.5 mr-1.5" />}
            {t('deal.refund_bounty_btn', { amount: usdcExact(refundable) })}
          </Button>
        </div>
      </div>
    </div>
  );
}
