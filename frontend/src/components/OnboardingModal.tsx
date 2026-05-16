"use client";

import React, { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Briefcase, FileSignature, Lock, CheckCircle, Zap } from "lucide-react";
import { useTranslations } from "next-intl";

const STORAGE_KEY = "sig404_onboarding_done";

const STEP_ICONS = [Briefcase, FileSignature, Lock, CheckCircle, Zap];

interface Props {
  /** Controlled open state — lets parent (e.g. WalletMenu) force-open */
  forceOpen?: boolean;
  onClose?: () => void;
}

export default function OnboardingModal({ forceOpen, onClose }: Props) {
  const { isConnected, address } = useAccount();
  const [open, setOpen] = useState(false);
  const t = useTranslations();

  const steps = [1, 2, 3, 4, 5].map((n) => ({
    icon: STEP_ICONS[n - 1],
    title: t(`onboarding.step${n}_title`),
    desc: t(`onboarding.step${n}_desc`),
  }));

  // Auto-show once per wallet on first connect
  useEffect(() => {
    if (!isConnected || !address) return;
    const done = localStorage.getItem(`${STORAGE_KEY}_${address.toLowerCase()}`);
    if (!done) setOpen(true);
  }, [isConnected, address]);

  // Respect forceOpen from parent
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  const handleClose = (v: boolean) => {
    if (!v) {
      if (address) {
        localStorage.setItem(`${STORAGE_KEY}_${address.toLowerCase()}`, "1");
      }
      setOpen(false);
      onClose?.();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg bg-card border-border p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border">
          <DialogTitle className="font-syne text-lg font-bold">{t("onboarding.title")}</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">{t("onboarding.subtitle")}</p>
        </DialogHeader>

        <div className="px-6 py-5 space-y-4">
          {steps.map((step, i) => {
            const Icon = step.icon;
            return (
              <div key={i} className="flex gap-4 items-start">
                <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <Icon className="w-4 h-4 text-primary" />
                </div>
                <div>
                  <p className="font-semibold text-sm text-foreground">{step.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{step.desc}</p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-6 pb-6">
          <button
            onClick={() => handleClose(false)}
            className="w-full py-2.5 rounded-xl bg-primary text-white font-semibold text-sm hover:bg-primary/90 transition-colors"
          >
            {t("onboarding.cta")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
