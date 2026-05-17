'use client';

import { useState, useMemo, Suspense } from 'react';
import { useAccount, useReadContract, useReadContracts } from 'wagmi';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { Abi } from 'viem';
import { isAddress } from 'viem';
import { useConversations } from '@/hooks/useConversations';
import { useXmtpStatus } from '@/hooks/useXmtpStatus';
import { useProfile } from '@/hooks/useProfile';
import { ChatPanel } from '@/components/ChatPanel';
import { MessagingSetup } from '@/components/MessagingSetup';
import { Button } from '@/components/ui/button';
import { DIAMOND_ABI, CONTRACTS } from '@/config/contracts';
import { MessageCircle, Loader2, RefreshCw, Plus, Lock, Briefcase, User, X, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface AgreementRecord {
  agreement: string;
  client: string;
  executor: string;
  amount: bigint;
  status: number;
  createdAt: bigint;
  resolvedAt: bigint;
}

interface JobRecord {
  client: string;
  title: string;
  description: string;
  amount: bigint;
  deadlineDays: bigint;
  termsHash: string;
  region: number;
  status: number;
  createdAt: bigint;
  chosenExecutor: string;
  agreement: string;
}

interface DealContext {
  agreementAddr: string;
  role: 'client' | 'executor';
  status: number;
  amount: bigint;
  jobTitle?: string;
  jobId?: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatTime(ts: number) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000)     return 'now';
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ─── Conversation item ─────────────────────────────────────────────────────────

function ConvoItem({
  peerAddress, lastText, lastAt, lastFromMe, isSelected, isSeen, onClick, dealCtx,
}: {
  peerAddress: string;
  lastText: string;
  lastAt: number;
  lastFromMe: boolean;
  isSelected: boolean;
  isSeen: boolean;
  onClick: () => void;
  dealCtx?: DealContext;
}) {
  const { displayName, avatarUrl } = useProfile(peerAddress);
  const t = useTranslations();

  const seenAt = typeof window !== 'undefined'
    ? Number(localStorage.getItem(`sig404_chat_seen_${peerAddress}`) ?? 0)
    : 0;
  const hasUnread = !lastFromMe && !isSeen && lastAt > seenAt && lastAt > 0;

  // Registry AgreementStatus enum: 0=ACTIVE, 1=COMPLETED, 2=REFUNDED, 3=DISPUTED, 4=RESOLVED
  const DEAL_STATUS_LABEL: Record<number, { label: string; cls: string }> = {
    0: { label: t("deal_status.active"),    cls: 'text-violet-400/60' },
    1: { label: t("deal_status.completed"), cls: 'text-green-400/60' },
    2: { label: t("deal_status.refunded"),  cls: 'text-white/25' },
    3: { label: t("deal_status.disputed"),  cls: 'text-red-400/60' },
    4: { label: t("deal_status.resolved"),  cls: 'text-purple-400/60' },
  };
  const ds = dealCtx ? DEAL_STATUS_LABEL[dealCtx.status] : null;

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-start gap-3 px-4 py-3 text-left transition-colors border-l-2',
        isSelected ? 'bg-white/8 border-primary' : 'border-transparent hover:bg-white/[0.04]',
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={avatarUrl ?? `https://effigy.im/a/${peerAddress}.svg`}
        alt=""
        className="w-9 h-9 rounded-full flex-shrink-0 mt-0.5 bg-white/10 object-cover"
        onError={(e) => {
          const img = e.target as HTMLImageElement;
          if (avatarUrl && img.src !== `https://effigy.im/a/${peerAddress}.svg`) {
            img.src = `https://effigy.im/a/${peerAddress}.svg`;
          }
        }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <span className={`text-sm truncate block ${hasUnread ? 'font-semibold text-white' : 'font-medium text-white/85'}`}>
              {displayName ?? shortAddr(peerAddress)}
            </span>
            {displayName && (
              <span className="text-[10px] text-white/25 font-mono truncate block -mt-0.5">
                {shortAddr(peerAddress)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {lastAt > 0 && (
              <span className="text-[11px] text-white/25">{formatTime(lastAt)}</span>
            )}
            {hasUnread && (
              <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />
            )}
          </div>
        </div>

        {dealCtx && (
          <div className="mt-0.5">
            {dealCtx.jobTitle && (
              <p className="text-[11px] text-white/55 truncate leading-tight mb-0.5 font-medium">
                {dealCtx.jobTitle}
              </p>
            )}
            <div className="flex items-center gap-1.5">
              {dealCtx.role === 'client'
                ? <Briefcase className="w-2.5 h-2.5 text-sky-400/60 flex-shrink-0" />
                : <User      className="w-2.5 h-2.5 text-emerald-400/60 flex-shrink-0" />
              }
              <span className={`text-[11px] font-medium ${dealCtx.role === 'client' ? 'text-sky-400/70' : 'text-emerald-400/70'}`}>
                {dealCtx.role === 'client' ? t("common.role_client") : t("common.role_executor")}
              </span>
              <span className="text-white/20 text-[11px]">·</span>
              <span className="text-[11px] font-mono text-white/30">
                #{dealCtx.agreementAddr.slice(2, 10).toUpperCase()}
              </span>
              {ds && (
                <>
                  <span className="text-white/20 text-[11px]">·</span>
                  <span className={`text-[11px] ${ds.cls}`}>{ds.label}</span>
                </>
              )}
            </div>
          </div>
        )}

        {lastText && (
          <p className="text-xs text-white/30 truncate mt-0.5">{lastText}</p>
        )}
      </div>
    </button>
  );
}

// ─── Empty chat state ─────────────────────────────────────────────────────────

function EmptyState() {
  const t = useTranslations();
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-4">
      <div className="w-16 h-16 rounded-2xl bg-white/[0.04] border border-white/10 flex items-center justify-center">
        <MessageCircle className="w-7 h-7 text-white/25" />
      </div>
      <div>
        <p className="text-white/50 text-sm font-medium">{t("chat.select_conversation")}</p>
        <p className="text-white/20 text-xs mt-1 max-w-xs leading-relaxed">
          {t("chat.empty_state_hint")}
        </p>
      </div>
    </div>
  );
}

// ─── Inner page (needs Suspense for useSearchParams) ─────────────────────────

function ChatHubPageInner() {
  const { address, isConnected } = useAccount();
  const searchParams = useSearchParams();
  const initialPeer  = searchParams.get('peer')?.toLowerCase() ?? null;

  const { isEnabled: xmtpEnabled }   = useXmtpStatus();
  const { conversations, isLoading, error, reload } = useConversations();

  const [selected, setSelected]       = useState<string | null>(initialPeer);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showNewChat, setShowNewChat] = useState(false);
  const [newChatAddr, setNewChatAddr] = useState('');
  const [seenConvos, setSeenConvos]   = useState<Set<string>>(() =>
    initialPeer ? new Set([initialPeer.toLowerCase()]) : new Set()
  );

  // Load agreements to build peer→deal context map
  const { data: clientDeals } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getByClient',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  }) as { data: AgreementRecord[] | undefined };

  const { data: executorDeals } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getByExecutor',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  }) as { data: AgreementRecord[] | undefined };

  const { data: clientJobIds } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getClientJobs',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  }) as { data: bigint[] | undefined };

  const jobContracts = useMemo(() =>
    (clientJobIds ?? []).map(id => ({
      address: CONTRACTS.diamond as `0x${string}`,
      abi: DIAMOND_ABI as Abi,
      functionName: 'getJob' as const,
      args: [id] as const,
    })),
    [clientJobIds]
  );

  const { data: jobResults } = useReadContracts({
    contracts: jobContracts,
    query: { enabled: jobContracts.length > 0 },
  });

  const agreementJobMap = useMemo(() => {
    const map = new Map<string, { title: string; jobId: string }>();
    if (!clientJobIds || !jobResults) return map;
    jobResults.forEach((result, i) => {
      if (result.status !== 'success') return;
      const job = result.result as JobRecord;
      if (job.status === 1 && job.agreement !== '0x0000000000000000000000000000000000000000') {
        map.set(job.agreement.toLowerCase(), {
          title: job.title,
          jobId: clientJobIds[i].toString(),
        });
      }
    });
    return map;
  }, [clientJobIds, jobResults]);

  const peerDealMap = useMemo(() => {
    const map = new Map<string, DealContext>();

    // Registry: 0=ACTIVE and 3=DISPUTED are in-progress; 1=COMPLETED,2=REFUNDED,4=RESOLVED are terminal
    const isInProgress = (s: number) => s === 0 || s === 3;

    const prefer = (peer: string, ctx: DealContext) => {
      const existing = map.get(peer);
      if (!existing) { map.set(peer, ctx); return; }
      if (isInProgress(ctx.status) && !isInProgress(existing.status)) map.set(peer, ctx);
    };

    for (const d of clientDeals ?? []) {
      prefer(d.executor.toLowerCase(), {
        agreementAddr: d.agreement,
        role: 'client',
        status: d.status,
        amount: d.amount,
      });
    }
    for (const d of executorDeals ?? []) {
      prefer(d.client.toLowerCase(), {
        agreementAddr: d.agreement,
        role: 'executor',
        status: d.status,
        amount: d.amount,
      });
    }

    map.forEach((ctx, peer) => {
      const jobCtx = agreementJobMap.get(ctx.agreementAddr.toLowerCase());
      if (jobCtx) map.set(peer, { ...ctx, jobTitle: jobCtx.title, jobId: jobCtx.jobId });
    });

    return map;
  }, [clientDeals, executorDeals, agreementJobMap]);

  const handleOpenNewChat = () => {
    const addr = newChatAddr.trim().toLowerCase();
    if (!isAddress(addr)) return;
    setSelected(addr);
    setShowNewChat(false);
    setNewChatAddr('');
  };

  const t = useTranslations();

  if (!isConnected) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center max-w-sm px-4">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-6">
            <MessageCircle className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-bold font-syne mb-2">{t("chat.title")}</h1>
          <p className="text-muted-foreground text-sm mb-6">{t("chat.wallet_required")}</p>
          <Link href="/"><Button variant="outline">{t("common.go_home")}</Button></Link>
        </div>
      </div>
    );
  }

  if (!xmtpEnabled) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-8">
        <div className="w-full max-w-md">
          <h1 className="text-xl font-bold font-syne mb-4">{t("chat.title")}</h1>
          <MessagingSetup />
        </div>
      </div>
    );
  }

  const handleConvoClick = (addr: string) => {
    const lc = addr.toLowerCase();
    setSelected(lc);
    setSidebarOpen(false);
    setSeenConvos(prev => new Set([...prev, lc]));
    localStorage.setItem(`sig404_chat_seen_${lc}`, String(Date.now()));
  };

  const selectedDealCtx = selected ? peerDealMap.get(selected) : undefined;

  return (
    <div className="flex-1 min-h-0 flex overflow-hidden bg-background">

      {/* Mobile backdrop when drawer is open over a chat */}
      {sidebarOpen && !!selected && (
        <div
          className="sm:hidden fixed inset-0 z-20 bg-black/60 backdrop-blur-[2px]"
          style={{ top: 'calc(env(safe-area-inset-top, 0px) + 68px)' }}
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Sidebar ── */}
      <aside
        className={cn(
          'flex-shrink-0 border-r border-white/[0.07] flex flex-col overflow-hidden bg-[#070707]',
          // Desktop: always static in layout
          'sm:relative sm:flex sm:w-80 sm:translate-x-0 sm:z-auto',
          // Mobile, no chat selected: full-width (sidebar IS the page)
          !selected && 'flex w-full',
          // Mobile, chat selected: slide-over drawer from left
          !!selected && cn(
            'fixed bottom-0 left-0 w-[88vw] max-w-[340px] z-30',
            'transition-transform duration-300 ease-out',
            sidebarOpen ? 'translate-x-0' : '-translate-x-full',
          ),
        )}
        style={!!selected ? { top: 'calc(env(safe-area-inset-top, 0px) + 68px)' } : undefined}
      >

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/8 flex-shrink-0">
          <div>
            <h2 className="text-sm font-semibold">{t("chat.title")}</h2>
            <div className="flex items-center gap-1 mt-0.5">
              <Lock className="w-2.5 h-2.5 text-white/25" />
              <span className="text-[11px] text-white/25">{t("chat.encrypted")}</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={reload} disabled={isLoading} title={t("common.refresh")}
              className="p-1.5 rounded-lg text-white/35 hover:text-white/65 hover:bg-white/5 transition-colors disabled:opacity-30">
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={() => { setShowNewChat(v => !v); setNewChatAddr(''); }}
              title={t("chat.new_conversation")}
              className={cn(
                'p-1.5 rounded-lg transition-colors',
                showNewChat ? 'bg-white/10 text-white/70' : 'text-white/35 hover:text-white/65 hover:bg-white/5',
              )}>
              {showNewChat ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* New chat search */}
        {showNewChat && (
          <div className="px-3 py-2.5 border-b border-white/8 bg-white/[0.02]">
            <p className="text-[11px] text-white/35 mb-1.5">{t("chat.paste_address_hint")}</p>
            <div className="flex gap-2">
              <input
                autoFocus
                type="text"
                value={newChatAddr}
                onChange={e => setNewChatAddr(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleOpenNewChat(); }}
                placeholder="0x…"
                className="flex-1 min-w-0 bg-white/[0.06] border border-white/10 rounded-xl px-3 py-1.5 text-xs text-white placeholder:text-white/20 focus:outline-none focus:border-primary/35 focus:bg-white/8 transition-all font-mono"
              />
              <button
                onClick={handleOpenNewChat}
                disabled={!isAddress(newChatAddr.trim())}
                className="px-3 py-1.5 rounded-xl bg-primary text-white text-xs font-medium disabled:opacity-30 hover:bg-primary/80 transition-colors flex items-center gap-1 flex-shrink-0">
                <ArrowRight className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">

          {isLoading && (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-white/30">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-xs">{t("chat.loading_conversations")}</span>
            </div>
          )}

          {!isLoading && error && (
            <div className="px-4 py-8 text-center space-y-3">
              <p className="text-xs text-red-400/60 leading-relaxed">{error}</p>
              {error.includes('xmtp.chat') && (
                <a
                  href="https://xmtp.chat"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-white/40 hover:text-white/70 underline underline-offset-2 transition-colors"
                >
                  {t("chat.open_xmtp")} <ArrowRight className="w-3 h-3" />
                </a>
              )}
              <div>
                <Button size="sm" variant="outline" onClick={reload} className="border-white/15 text-white/50 text-xs">{t("chat.retry")}</Button>
              </div>
            </div>
          )}

          {!isLoading && !error && conversations.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center px-4">
              <MessageCircle className="w-8 h-8 text-white/15 mb-3" />
              <p className="text-sm text-white/35 mb-1">{t("chat.no_conversations")}</p>
              <p className="text-xs text-white/20 leading-relaxed">
                {t("chat.start_hint")}
              </p>
            </div>
          )}

          {/* If peer from URL is not yet in conversation list, show it at top */}
          {selected && !conversations.some(c => c.peerAddress === selected) && (
            <ConvoItem
              peerAddress={selected}
              lastText=""
              lastAt={0}
              lastFromMe={true}
              isSelected
              isSeen
              dealCtx={peerDealMap.get(selected)}
              onClick={() => {}}
            />
          )}

          {!isLoading && !error && conversations.map(({ peerAddress, lastText, lastAt, lastFromMe }) => (
            <ConvoItem
              key={peerAddress}
              peerAddress={peerAddress}
              lastText={lastText}
              lastAt={lastAt}
              lastFromMe={lastFromMe}
              isSelected={selected === peerAddress}
              isSeen={seenConvos.has(peerAddress)}
              dealCtx={peerDealMap.get(peerAddress)}
              onClick={() => handleConvoClick(peerAddress)}
            />
          ))}

        </div>
      </aside>

      {/* ── Chat panel ── */}
      <main className={cn(
        'flex-1 min-w-0 min-h-0 flex-col overflow-hidden',
        !selected ? 'hidden sm:flex' : 'flex',
      )}>
        {selected
          ? <ChatPanel
              recipientAddress={selected}
              dealContext={selectedDealCtx}
              onBack={() => setSidebarOpen(true)}
            />
          : <EmptyState />
        }
      </main>

    </div>
  );
}

// ─── Page wrapper (Suspense for useSearchParams) ──────────────────────────────

export default function ChatHubPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-white/30" />
      </div>
    }>
      <ChatHubPageInner />
    </Suspense>
  );
}
