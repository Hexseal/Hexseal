'use client';

import React from 'react';
import { MessageCircle, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useXmtpStatus } from '@/hooks/useXmtpStatus';
import { useTranslations } from 'next-intl';

export function MessagingSetup() {
  const { isEnabled, isEnabling, error, enable } = useXmtpStatus();
  const t = useTranslations();

  if (isEnabled) {
    return (
      <div className="flex items-center justify-between rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center flex-shrink-0">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-emerald-400">{t("messaging.enabled_title")}</p>
            <p className="text-xs text-white/40">{t("messaging.enabled_desc")}</p>
          </div>
        </div>
        <ShieldCheck className="w-4 h-4 text-emerald-400/40 flex-shrink-0" />
      </div>
    );
  }

  return (
    <div className="rounded-[20px] border border-white/[0.08] bg-[#0d0d0f] p-4" style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
          <MessageCircle className="w-4.5 h-4.5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white/90 mb-0.5">{t("messaging.enable_title")}</p>
          <p className="text-xs text-white/45 mb-3 leading-relaxed">{t("messaging.enable_desc")}</p>
          {error && (
            <p className="text-xs text-red-400/70 mb-2">{error}</p>
          )}
          <Button
            size="sm"
            onClick={enable}
            disabled={isEnabling}
            className="gap-2"
          >
            {isEnabling ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t("messaging.signing")}
              </>
            ) : (
              <>
                <MessageCircle className="w-3.5 h-3.5" />
                {t("messaging.enable_title")}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
