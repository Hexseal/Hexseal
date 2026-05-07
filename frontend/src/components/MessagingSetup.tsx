'use client';

import React from 'react';
import { MessageCircle, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useXmtpStatus } from '@/hooks/useXmtpStatus';

export function MessagingSetup() {
  const { isEnabled, isEnabling, error, enable } = useXmtpStatus();

  if (isEnabled) {
    return (
      <div className="flex items-center justify-between rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center flex-shrink-0">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-emerald-400">Messaging enabled</p>
            <p className="text-xs text-white/40">
              End-to-end encrypted via XMTP · Others can message you
            </p>
          </div>
        </div>
        <ShieldCheck className="w-4 h-4 text-emerald-400/40 flex-shrink-0" />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
          <MessageCircle className="w-4.5 h-4.5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white/90 mb-0.5">Enable Messaging</p>
          <p className="text-xs text-white/45 mb-3 leading-relaxed">
            One-time wallet signature to set up end-to-end encrypted messaging.
            Clients, executors and arbiters will be able to reach you directly.
          </p>
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
                Signing…
              </>
            ) : (
              <>
                <MessageCircle className="w-3.5 h-3.5" />
                Enable Messaging
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
