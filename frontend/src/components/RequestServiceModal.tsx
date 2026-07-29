"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, ArrowRight, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { UserName } from "@/components/UserName";
import { useFeeConfig } from "@/hooks/useFeeConfig";
import { quoteFeeLocal } from "@/lib/fee";

function fmtUSDC(v: bigint) { return (Number(v) / 1e6).toFixed(2); }

interface RequestServiceModalProps {
  service: {
    title: string;
    executor: string;
    price: bigint;
    deadlineDays: bigint;
  };
  onClose: () => void;
  onSubmit: (amount: string, days: string, terms: string) => void;
  loading: boolean;
  userUsdcBalance?: bigint;
}

export function RequestServiceModal({
  service,
  onClose,
  onSubmit,
  loading,
  userUsdcBalance,
}: RequestServiceModalProps) {
  const [amount, setAmount] = useState(fmtUSDC(service.price));
  const [days, setDays]     = useState(String(Number(service.deadlineDays)));
  const [terms, setTerms]   = useState("");
  const t = useTranslations();

  const { feeBps, feeFloor, isLoading: feeConfigLoading } = useFeeConfig();
  // Same rule as board/client/post/page.tsx: false while still loading AND
  // after a failed read (isLoading goes false but the values stay undefined).
  // Either way the fee is an unknown, not a zero — treating it as zero would
  // make hasEnough pass for a wallet that can't actually cover amount + fee.
  // Also excludes feeFloor === 0n: that's FactoryStorage.quote()'s
  // "not configured yet" state (it reverts FeeNotConfigured() there), not a
  // real zero fee — quoteFeeLocal has no such branch, so treating 0n as ready
  // would preview a fee of 0 for a request that will revert on submit.
  const feeConfigReady = !feeConfigLoading && feeBps !== undefined && feeFloor !== undefined && feeFloor > 0n;

  const parsedAmount = parseFloat(amount || "0");
  const requiredRaw  = parsedAmount > 0 ? BigInt(Math.round(parsedAmount * 1e6)) : 0n;
  const feeRaw       = feeBps !== undefined && feeFloor !== undefined
    ? quoteFeeLocal(requiredRaw, feeBps, feeFloor)
    : 0n;
  const totalRaw     = requiredRaw + feeRaw;
  // Gated on feeConfigReady, not just on the balance comparison — otherwise an
  // unready read defaults feeRaw to 0 and totalRaw silently degrades back to
  // requiredRaw, passing a wallet that has enough for the trade but not the fee.
  const hasEnough    = feeConfigReady && (userUsdcBalance === undefined || userUsdcBalance >= totalRaw);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 10 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-sm rounded-[22px] border border-white/[0.08] bg-[#111113] p-5"
          style={{ boxShadow: "0 8px 40px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.04)" }}
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-syne font-bold text-lg">{t("board.services.request_btn")}</h2>
            <button onClick={onClose} className="text-white/30 hover:text-white/60 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          <p className="text-sm text-white/50 mb-4 border-b border-white/8 pb-4 font-medium text-white/80">
            {service.title}
            <br />
            <UserName address={service.executor} link className="font-mono text-xs text-white/30 hover:text-white/60 transition-colors" />
          </p>

          <p className="text-xs text-white/40 leading-relaxed mb-5">
            {t("board.services.request_intro")}
          </p>

          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs text-white/40">{t("board.services.amount_label")}</label>
                <span className="text-xs text-white/30 font-mono">
                  {t("board.services.listed_price_label", { amount: fmtUSDC(service.price) })}
                </span>
              </div>
              <Input
                type="number" step="0.01" min="0.01"
                value={amount} onChange={e => setAmount(e.target.value)}
                className="bg-white/[0.04] border-white/10 text-white"
                placeholder="10.00"
              />
              <p className="text-xs text-white/25 mt-1">{t("board.services.amount_suggested")}</p>
            </div>

            <div>
              <label className="text-xs text-white/40 block mb-1.5">{t("board.services.deadline_label")}</label>
              <Input
                type="number" min="1" max="365"
                value={days} onChange={e => setDays(e.target.value)}
                className="bg-white/[0.04] border-white/10 text-white"
              />
            </div>

            <div>
              <label className="text-xs text-white/40 block mb-1.5">{t("board.services.terms_label")}</label>
              <Textarea
                placeholder={t("board.services.terms_placeholder")}
                value={terms}
                onChange={e => setTerms(e.target.value)}
                rows={3}
                maxLength={2000}
                className="bg-white/[0.04] border-white/10 text-white resize-none text-sm placeholder:text-white/20 rounded-[10px]"
              />
              <p className="text-xs text-white/20 mt-1">{t("board.services.terms_hint")}</p>
            </div>
          </div>

          <div className="border-t border-white/8 pt-2.5 mt-3 space-y-1 text-sm">
            <div className="flex justify-between text-white/50">
              <span>{t("board.services.amount_row")}</span>
              <span className="font-mono">{parsedAmount.toFixed(2)} USDC</span>
            </div>
            <div className="flex justify-between text-white/50">
              <span>{t("board.services.fee_row")}</span>
              <span className="font-mono">{feeConfigReady ? `${fmtUSDC(feeRaw)} USDC` : "—"}</span>
            </div>
            <div className="flex justify-between font-semibold text-white border-t border-white/8 pt-1.5 mt-1.5">
              <span>{t("board.post_common.total_label")}</span>
              <span className="font-mono">{feeConfigReady ? `${fmtUSDC(totalRaw)} USDC` : "—"}</span>
            </div>
            {/* feeFloor !== undefined repeated here (redundant with
                feeConfigReady at runtime) purely so TS narrows it to bigint
                for fmtUSDC — feeConfigReady is a plain boolean, its own
                feeFloor > 0n check doesn't carry through. */}
            {feeConfigReady && feeFloor !== undefined && (
              <p className="text-xs text-white/35">
                {t("board.services.request_refund_note", { floor: fmtUSDC(feeFloor) })}
              </p>
            )}
          </div>

          <div className="mt-6 flex gap-2">
            <Button
              variant="ghost"
              className="flex-1 border border-white/10 text-white/50"
              onClick={onClose}
              disabled={loading}
            >
              {t("common.cancel")}
            </Button>
            <Button
              className="flex-1 gap-1.5"
              disabled={loading || !amount || !days || !hasEnough}
              onClick={() => onSubmit(amount, days, terms)}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
              {t("board.services.request_confirm")}
            </Button>
          </div>

          {!hasEnough && feeConfigReady && userUsdcBalance !== undefined && (
            <p className="text-xs text-red-400 text-center mt-2">
              {t("board.services.insufficient_usdc", {
                have: fmtUSDC(userUsdcBalance),
                need: fmtUSDC(totalRaw),
              })}
            </p>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
