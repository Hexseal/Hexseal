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

const STORAGE_KEY = "sig404_onboarding_done";

const STEPS = [
  {
    icon: Briefcase,
    title: "Post or Find Work",
    desc: "Clients post jobs on the Job Board. Executors list services. Browse and respond to offers.",
  },
  {
    icon: FileSignature,
    title: "Create a Deal",
    desc: "Both parties agree to terms. A smart contract is deployed — this is your binding agreement.",
  },
  {
    icon: Lock,
    title: "Fund Escrow",
    desc: "Client deposits USDC into the contract. Funds are locked on-chain — no one can touch them until conditions are met.",
  },
  {
    icon: CheckCircle,
    title: "Complete & Release",
    desc: "Executor marks done. Client releases payment. No release after timeout? Funds auto-approve. Dispute? Arbiter resolves.",
  },
  {
    icon: Zap,
    title: "Gasless by Default",
    desc: "You sign transactions, the platform pays gas. No ETH needed — just USDC for deal funding.",
  },
];

interface Props {
  /** Controlled open state — lets parent (e.g. WalletMenu) force-open */
  forceOpen?: boolean;
  onClose?: () => void;
}

export default function OnboardingModal({ forceOpen, onClose }: Props) {
  const { isConnected, address } = useAccount();
  const [open, setOpen] = useState(false);

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
          <DialogTitle className="font-syne text-lg font-bold">How Signature404 works</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">Decentralized freelance on Base — no middlemen, code enforces.</p>
        </DialogHeader>

        <div className="px-6 py-5 space-y-4">
          {STEPS.map((step, i) => {
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
            Got it, let&apos;s go →
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
