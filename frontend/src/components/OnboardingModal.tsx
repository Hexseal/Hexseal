"use client";

import React, { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Briefcase, FileSignature, Lock, CheckCircle, Zap, ArrowRight, ChevronLeft } from "lucide-react";
import { useTranslations } from "next-intl";

const STORAGE_KEY = "hexseal_onboarding_done";

const STEP_ICONS = [Briefcase, FileSignature, Lock, CheckCircle, Zap];

interface Props {
  forceOpen?: boolean;
  onClose?: () => void;
}

export default function OnboardingModal({ forceOpen, onClose }: Props) {
  const { isConnected, address } = useAccount();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const router = useRouter();
  const t = useTranslations();

  const steps = [1, 2, 3, 4, 5].map((n) => ({
    icon: STEP_ICONS[n - 1],
    title: t(`onboarding.step${n}_title`),
    desc: t(`onboarding.step${n}_desc`),
  }));

  const isFinal = step === steps.length;

  useEffect(() => {
    if (!isConnected || !address) return;
    const done = localStorage.getItem(`${STORAGE_KEY}_${address.toLowerCase()}`);
    if (!done) setOpen(true);
  }, [isConnected, address]);

  useEffect(() => {
    if (forceOpen) { setOpen(true); setStep(0); }
  }, [forceOpen]);

  const handleClose = () => {
    if (address) {
      localStorage.setItem(`${STORAGE_KEY}_${address.toLowerCase()}`, "1");
    }
    setOpen(false);
    onClose?.();
  };

  const handleCta = (path: string) => {
    handleClose();
    router.push(path);
  };

  const current = steps[step];
  const Icon = current ? current.icon : null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="max-w-md bg-card border-border p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border">
          <DialogTitle className="font-syne text-lg font-bold">{t("onboarding.title")}</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">{t("onboarding.subtitle")}</p>
        </DialogHeader>

        {/* Step dots */}
        <div className="flex justify-center gap-1.5 pt-5 px-6">
          {steps.map((_, i) => (
            <div
              key={i}
              className={`h-1 rounded-full transition-all duration-300 ${
                i < step ? "bg-primary w-4" : i === step ? "bg-primary w-6" : "bg-white/10 w-4"
              }`}
            />
          ))}
          <div className={`h-1 rounded-full transition-all duration-300 ${isFinal ? "bg-primary w-6" : "bg-white/10 w-4"}`} />
        </div>

        <div className="px-6 py-6 min-h-[160px]">
          {!isFinal && Icon && (
            <div className="flex gap-4 items-start">
              <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                <Icon className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="font-semibold text-sm text-foreground">{current.title}</p>
                <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{current.desc}</p>
              </div>
            </div>
          )}

          {isFinal && (
            <div className="text-center space-y-2 pt-2">
              <p className="font-semibold text-sm text-foreground">{t("onboarding.final_title")}</p>
              <p className="text-xs text-muted-foreground">{t("onboarding.final_desc")}</p>
            </div>
          )}
        </div>

        <div className="px-6 pb-6 space-y-2">
          {!isFinal && (
            <div className="flex gap-2">
              {step > 0 && (
                <button
                  onClick={() => setStep(s => s - 1)}
                  className="flex items-center gap-1 px-3 py-2.5 rounded-xl border border-white/10 text-sm text-white/50 hover:text-white/70 transition-colors"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={() => setStep(s => s + 1)}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-primary text-white font-semibold text-sm hover:bg-primary/90 transition-colors"
              >
                {step < steps.length - 1 ? t("onboarding.next_btn") : t("onboarding.last_step_btn")}
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {isFinal && (
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => handleCta("/board/client")}
                className="flex flex-col items-center gap-1.5 py-3 rounded-xl border border-white/10 hover:border-primary/40 hover:bg-primary/5 transition-all text-center"
              >
                <Briefcase className="w-4 h-4 text-primary" />
                <span className="text-xs font-semibold text-foreground">{t("onboarding.cta_client")}</span>
                <span className="text-[10px] text-muted-foreground">{t("onboarding.cta_client_sub")}</span>
              </button>
              <button
                onClick={() => handleCta("/board/executor")}
                className="flex flex-col items-center gap-1.5 py-3 rounded-xl border border-white/10 hover:border-primary/40 hover:bg-primary/5 transition-all text-center"
              >
                <Zap className="w-4 h-4 text-primary" />
                <span className="text-xs font-semibold text-foreground">{t("onboarding.cta_executor")}</span>
                <span className="text-[10px] text-muted-foreground">{t("onboarding.cta_executor_sub")}</span>
              </button>
            </div>
          )}

          <button
            onClick={handleClose}
            className="w-full text-xs text-white/25 hover:text-white/40 transition-colors py-1"
          >
            {t("onboarding.skip")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
