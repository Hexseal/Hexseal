'use client';

import { useState, useMemo, Suspense, useRef, useEffect, useCallback, memo } from 'react';
import { useAccount, useReadContract, useReadContracts } from 'wagmi';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { Abi } from 'viem';
import { isAddress } from 'viem';
import { usePairConversations } from '@/hooks/usePairConversations';
import { useXmtp } from '@/contexts/XmtpContext';
import { useProfile } from '@/hooks/useProfile';
import { ChatPanel } from '@/components/ChatPanel';
import { Button } from '@/components/ui/button';
import { DIAMOND_ABI, CONTRACTS, AGREEMENT_ABI } from '@/config/contracts';
import { MessageCircle, Loader2, RefreshCw, Plus, Lock, Briefcase, User, X, ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
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

// 0=Created 1=Funded 2=Active 3=Completed 4=Disputed 5=Resolved 6=Refunded
const DEAL_STATUS_CLS: Record<number, string> = {
  0: 'text-white/40',
  1: 'text-sky-400/70',
  2: 'text-green-400/70',
  3: 'text-white/30',
  4: 'text-red-400/70',
  5: 'text-white/30',
  6: 'text-white/30',
};

const ConvoItem = memo(function ConvoItem({
  peerAddress, lastText, lastAt, lastFromMe, isSelected, isSeen, onSelect, dealCtx,
}: {
  peerAddress: string;
  lastText: string;
  lastAt: number;
  lastFromMe: boolean;
  isSelected: boolean;
  isSeen: boolean;
  onSelect: (addr: string) => void;
  dealCtx?: DealContext;
}) {
  const onClick = useCallback(() => onSelect(peerAddress), [onSelect, peerAddress]);
  const { displayName, avatarUrl } = useProfile(peerAddress);
  const t = useTranslations();

  const seenAt = useMemo(() =>
    typeof window !== 'undefined'
      ? Number(localStorage.getItem(`hexseal_chat_seen_${peerAddress}`) ?? 0)
      : 0,
    [peerAddress],
  );
  const hasUnread = !lastFromMe && !isSeen && lastAt > seenAt && lastAt > 0;

  const dsLabel = dealCtx ? t(`deal_status.${(['created','funded','active','completed','disputed','resolved','refunded'] as const)[dealCtx.status] ?? 'active'}` as Parameters<typeof t>[0]) : null;
  const dsCls   = dealCtx ? (DEAL_STATUS_CLS[dealCtx.status] ?? 'text-white/30') : null;

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-start gap-3 px-3 py-2.5 text-left transition-all rounded-[16px] border',
        isSelected
          ? 'bg-white/[0.07] border-white/[0.08]'
          : 'bg-white/[0.03] border-white/[0.04] hover:bg-white/[0.05] hover:border-white/[0.07]',
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
              {dsLabel && (
                <>
                  <span className="text-white/20 text-[11px]">·</span>
                  <span className={`text-[11px] ${dsCls}`}>{dsLabel}</span>
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
});

// ─── Empty chat state ─────────────────────────────────────────────────────────

function EmptyState() {
  const t = useTranslations();
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-4">
      <div className="w-16 h-16 rounded-[18px] bg-white/[0.03] border border-white/[0.08] flex items-center justify-center">
        <MessageCircle className="w-7 h-7 text-white/20" />
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

  const { status: xmtpStatus } = useXmtp();
  const { conversations, isLoading, error, reload } = usePairConversations(xmtpStatus === 'ready');

  // selected is URL-driven: ?peer=addr — router.back() returns to /chat (list view)
  const selected = searchParams.get('peer')?.toLowerCase() ?? null;
  const [showNewChat, setShowNewChat] = useState(false);
  const [newChatAddr, setNewChatAddr] = useState('');
  const newChatInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (showNewChat) newChatInputRef.current?.focus();
  }, [showNewChat]);
  const [seenConvos, setSeenConvos]   = useState<Set<string>>(() =>
    initialPeer ? new Set([initialPeer.toLowerCase()]) : new Set()
  );
  const router = useRouter();

  const handleConvoClick = useCallback((addr: string) => {
    const lc = addr.toLowerCase();
    setSeenConvos(prev => new Set([...prev, lc]));
    localStorage.setItem(`hexseal_chat_seen_${lc}`, String(Date.now()));
    router.push(`/chat?peer=${lc}`);
  }, [router]);

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

  // Registry (getByClient/getByExecutor) only enumerates WHICH agreements exist —
  // its own `status` field is a stale snapshot (frozen near ACTIVE) and must never
  // be used for display. Every candidate's real status comes from a single batched
  // live read below.
  const candidateAgreements = useMemo(() => {
    const map = new Map<string, { agreement: string; role: 'client' | 'executor'; peerAddress: string }>();
    for (const d of clientDeals ?? []) {
      map.set(d.agreement.toLowerCase(), { agreement: d.agreement, role: 'client', peerAddress: d.executor.toLowerCase() });
    }
    for (const d of executorDeals ?? []) {
      map.set(d.agreement.toLowerCase(), { agreement: d.agreement, role: 'executor', peerAddress: d.client.toLowerCase() });
    }
    return [...map.values()];
  }, [clientDeals, executorDeals]);

  const dealDetailContracts = useMemo(() =>
    candidateAgreements.map(c => ({
      address: c.agreement as `0x${string}`,
      abi: AGREEMENT_ABI as Abi,
      functionName: 'getDetails' as const,
    })),
    [candidateAgreements]
  );

  const { data: dealDetailResults } = useReadContracts({
    contracts: dealDetailContracts,
    query: { enabled: dealDetailContracts.length > 0 },
  });

  // peer address → every non-terminal deal with that counterparty, live status.
  // Array (not a single "preferred" deal) because the product allows genuinely
  // parallel deals between the same pair — ChatPanel shows a selector when 2+.
  const peerDealsMap = useMemo(() => {
    const map = new Map<string, DealContext[]>();
    if (!dealDetailResults) return map;
    // Agreement.Status: 0=Created 1=Funded 2=Active 3=Completed 4=Disputed 5=Resolved 6=Refunded
    const isOpen = (s: number) => s === 0 || s === 1 || s === 2 || s === 4;

    candidateAgreements.forEach((c, i) => {
      const result = dealDetailResults[i];
      if (!result || result.status !== 'success') return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = result.result as any;
      const status = Number(d.status_ ?? d[11] ?? -1);
      if (!isOpen(status)) return;

      const jobCtx = agreementJobMap.get(c.agreement.toLowerCase());
      const ctx: DealContext = {
        agreementAddr: c.agreement,
        role: c.role,
        status,
        amount: (d.amount_ ?? d[3] ?? 0n) as bigint,
        jobTitle: jobCtx?.title,
        jobId: jobCtx?.jobId,
      };

      const list = map.get(c.peerAddress) ?? [];
      list.push(ctx);
      map.set(c.peerAddress, list);
    });

    return map;
  }, [candidateAgreements, dealDetailResults, agreementJobMap]);

  const handleOpenNewChat = () => {
    const addr = newChatAddr.trim().toLowerCase();
    if (!isAddress(addr)) return;
    setShowNewChat(false);
    setNewChatAddr('');
    setSeenConvos(prev => new Set([...prev, addr]));
    localStorage.setItem(`hexseal_chat_seen_${addr}`, String(Date.now()));
    router.push(`/chat?peer=${addr}`);
  };

  const t = useTranslations();

  if (!isConnected) {
    return (
      <div className="flex-1 flex items-center justify-center">
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

  const selectedDealCtxs = selected ? (peerDealsMap.get(selected) ?? []) : [];

  return (
    <div className="flex-1 min-h-0 flex overflow-hidden justify-center">
      <div className="flex w-full max-w-6xl min-h-0 overflow-hidden border-x border-white/[0.04]">

      {/* ── Sidebar ── */}
      <aside
        className={cn(
          'flex-shrink-0 flex flex-col overflow-hidden bg-black',
          'sm:relative sm:flex sm:w-80 sm:border-r sm:border-white/[0.04]',
          !selected ? 'flex w-full' : 'hidden sm:flex',
        )}
      >

        {/* Header — only visible on desktop; on mobile the app header covers this */}
        <div className="hidden sm:flex items-center justify-between px-4 py-3 flex-shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-white/70">{t("chat.title")}</h2>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={reload} disabled={isLoading} title={t("common.refresh")}
              className="p-2 rounded-[12px] text-white/25 hover:text-white/55 hover:bg-white/[0.06] transition-colors disabled:opacity-30">
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={() => { setShowNewChat(v => !v); setNewChatAddr(''); }}
              title={t("chat.new_conversation")}
              className={cn(
                'p-2 rounded-[12px] transition-colors',
                showNewChat ? 'bg-white/[0.08] text-white/70' : 'text-white/25 hover:text-white/55 hover:bg-white/[0.06]',
              )}>
              {showNewChat ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* Mobile: minimal action bar */}
        <div className="sm:hidden flex items-center justify-between px-3 pt-2 pb-1 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <Lock className="w-3 h-3 text-white/15" />
            <span className="text-[11px] text-white/20">{t("chat.encrypted")}</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={reload} disabled={isLoading}
              className="p-2 rounded-[12px] text-white/20 hover:text-white/50 hover:bg-white/[0.06] transition-colors disabled:opacity-30">
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={() => { setShowNewChat(v => !v); setNewChatAddr(''); }}
              className={cn('p-2 rounded-[12px] transition-colors',
                showNewChat ? 'bg-white/[0.08] text-white/60' : 'text-white/20 hover:text-white/50 hover:bg-white/[0.06]')}>
              {showNewChat ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* New chat search */}
        <div className={showNewChat ? "px-3 py-2.5 mx-2 mb-2 rounded-[16px] bg-white/[0.03]" : "hidden"}>
            <p className="text-[11px] text-white/30 mb-1.5">{t("chat.paste_address_hint")}</p>
            <div className="flex gap-2">
              <input
                ref={newChatInputRef}
                type="text"
                value={newChatAddr}
                onChange={e => setNewChatAddr(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleOpenNewChat(); }}
                placeholder="0x…"
                tabIndex={showNewChat ? 0 : -1}
                className="flex-1 min-w-0 bg-[#0d0d0f] border border-white/[0.08] rounded-[12px] px-3 py-1.5 text-xs text-white placeholder:text-white/20 focus:outline-none focus:border-primary/40 focus:bg-[#111113] transition-all font-mono"
              />
              <button
                onClick={handleOpenNewChat}
                disabled={!isAddress(newChatAddr.trim())}
                className="px-3 py-1.5 rounded-[12px] bg-primary text-white text-xs font-medium disabled:opacity-30 hover:bg-primary/80 transition-colors flex items-center gap-1 flex-shrink-0">
                <ArrowRight className="w-3 h-3" />
              </button>
            </div>
          </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">

          {(isLoading || xmtpStatus === 'loading') && conversations.length === 0 && (
            <div className="space-y-0.5">
              {[1, 2, 3].map(i => (
                <div key={i} className="flex items-start gap-3 px-3 py-2.5 rounded-[16px] border border-white/[0.04] bg-white/[0.02]">
                  <div className="w-9 h-9 rounded-full bg-white/[0.07] flex-shrink-0 mt-0.5 animate-pulse" />
                  <div className="flex-1 min-w-0 pt-0.5 space-y-1.5">
                    <div className="h-3 bg-white/[0.07] rounded animate-pulse" style={{ width: `${48 + i * 14}%` }} />
                    <div className="h-2.5 bg-white/[0.04] rounded animate-pulse" style={{ width: `${60 + i * 8}%` }} />
                  </div>
                  <div className="h-2.5 bg-white/[0.04] rounded animate-pulse w-7 mt-1 flex-shrink-0" />
                </div>
              ))}
            </div>
          )}

          {!isLoading && xmtpStatus !== 'loading' && error && (
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

          {!isLoading && xmtpStatus !== 'loading' && !error && conversations.length === 0 && xmtpStatus === 'ready' && (
            <div className="flex flex-col items-center justify-center py-16 text-center px-4">
              <MessageCircle className="w-8 h-8 text-white/[0.12] mb-3" />
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
              dealCtx={peerDealsMap.get(selected)?.[0]}
              onSelect={handleConvoClick}
            />
          )}

          {!error && conversations.map(({ peerAddress, lastText, lastAt, lastFromMe }) => (
            <ConvoItem
              key={peerAddress}
              peerAddress={peerAddress}
              lastText={lastText}
              lastAt={lastAt}
              lastFromMe={lastFromMe}
              isSelected={selected === peerAddress}
              isSeen={seenConvos.has(peerAddress)}
              dealCtx={peerDealsMap.get(peerAddress)?.[0]}
              onSelect={handleConvoClick}
            />
          ))}

          {/* Spacer so last items aren't hidden under the bottom nav pill on mobile */}
          <div className="sm:hidden flex-shrink-0" style={{ height: 'calc(98px + env(safe-area-inset-bottom, 0px))' }} />

        </div>
      </aside>

      {/* ── Chat panel ── */}
      <main className={cn(
        'flex-1 min-w-0 min-h-0 flex-col overflow-hidden',
        !selected ? 'hidden sm:flex' : 'flex',
      )}>
        {selected
          ? <div key={selected} className="chat-conv-enter flex flex-col flex-1 min-h-0 overflow-hidden">
              <ChatPanel
                recipientAddress={selected}
                dealContexts={selectedDealCtxs}
                onBack={() => router.push('/chat')}
              />
            </div>
          : <EmptyState />
        }
      </main>

      </div>
    </div>
  );
}

// ─── Page wrapper (Suspense for useSearchParams) ──────────────────────────────

export default function ChatHubPage() {
  return (
    <Suspense fallback={
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-white/30" />
      </div>
    }>
      <ChatHubPageInner />
    </Suspense>
  );
}
