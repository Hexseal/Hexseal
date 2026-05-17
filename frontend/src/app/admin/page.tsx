'use client';

import { useAccount, useReadContract, useWriteContract, usePublicClient } from 'wagmi';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useIsMounted } from '@/hooks/useIsMounted';
import { DIAMOND_ABI, ARBITER_REGISTRY_ABI, SERVICE_BOARD_ABI, CONTRACTS } from '@/config/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'react-hot-toast';
import {
  Loader2, PauseCircle, PlayCircle, DollarSign, Settings,
  Shield, UserCog, MessageCircle, AlertTriangle, UserPlus, UserMinus,
  Search, ExternalLink, Crown, BarChart3, Gavel, Activity,
  TrendingUp, CheckCircle2, XCircle, Wallet,
} from 'lucide-react';
import { isAddress, parseAbi } from 'viem';
import { cn } from '@/lib/utils';

// ─── Mini ABI ────────────────────────────────────────────────────────────────

const AGREEMENT_ABI_MINI = parseAbi([
  'function getDetails() view returns (address client_, address executor_, address arbiter_, uint256 amount_, bytes32 termsHash_, uint256 deadlineDays_, uint256 fundedAt_, uint256 activatedAt_, uint256 markedDoneAt_, uint256 disputedAt_, uint256 resolvedAt_, uint8 status_)',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ZERO  = '0x0000000000000000000000000000000000000000';

const DISPUTE_STATUS: Record<number, string> = {
  0: 'Created', 1: 'Funded', 2: 'Active', 3: 'Completed',
  4: 'Disputed', 5: 'Resolved', 6: 'Refunded',
};

// ─── Tabs ─────────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'arbiters' | 'activity' | 'settings';

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'overview',  label: 'Overview',  icon: BarChart3  },
  { id: 'arbiters',  label: 'Arbiters',  icon: Gavel      },
  { id: 'activity',  label: 'Activity',  icon: Activity   },
  { id: 'settings',  label: 'Settings',  icon: Settings   },
];

// ─── Shared section wrapper ───────────────────────────────────────────────────

function Section({ title, icon: Icon, children, className }: {
  title: string; icon: React.ElementType; children: React.ReactNode; className?: string;
}) {
  return (
    <div className={cn("rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5 space-y-4", className)}>
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-white/40" />
        <h3 className="text-sm font-semibold text-white/70 tracking-wide">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-white/40">{label}</span>
      <span className="text-sm font-mono text-white/80">{children}</span>
    </div>
  );
}

function FieldGroup({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-white/50">{label}</p>
      {hint && <p className="text-[11px] text-white/25">{hint}</p>}
      {children}
    </div>
  );
}

function Divider() {
  return <div className="h-px bg-white/[0.06]" />;
}

// ─── Stat tile ────────────────────────────────────────────────────────────────

function StatTile({ label, value, icon: Icon, accent }: {
  label: string; value: string | number | undefined; icon: React.ElementType; accent?: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 flex flex-col gap-2">
      <div className={cn("w-8 h-8 rounded-xl flex items-center justify-center", accent ?? "bg-white/[0.05]")}>
        <Icon className="w-4 h-4 text-white/50" />
      </div>
      <div className="text-2xl font-bold font-mono text-white">
        {value ?? <Loader2 className="w-5 h-5 animate-spin text-white/20" />}
      </div>
      <div className="text-xs text-white/35">{label}</div>
    </div>
  );
}

// ─── OVERVIEW TAB ─────────────────────────────────────────────────────────────

function OverviewTab() {
  const { data: total } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'totalAgreements',
  }) as { data: bigint | undefined };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: active } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'getActive',
  }) as { data: any[] | undefined };

  const { data: isPaused, refetch: refetchPause } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'isPaused',
  }) as { data: boolean | undefined; refetch: () => void };

  const { writeContract, isPending } = useWriteContract();

  const totalVolume = active
    ? active.reduce((s, a) => s + Number(a.amount), 0)
    : undefined;

  const handleToggle = async () => {
    try {
      await writeContract({
        address: CONTRACTS.diamond as `0x${string}`,
        abi: DIAMOND_ABI,
        functionName: 'setPaused',
        args: [!isPaused],
        gas: BigInt(80_000),
      });
      toast.success(isPaused ? 'Factory unpaused' : 'Factory paused');
      refetchPause();
    } catch (err: unknown) {
      toast.error((err as { shortMessage?: string })?.shortMessage ?? 'Failed');
    }
  };

  return (
    <div className="space-y-4">
      {/* Stat grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile
          label="Total agreements"
          value={total !== undefined ? total.toString() : undefined}
          icon={TrendingUp}
          accent="bg-primary/10"
        />
        <StatTile
          label="Active deals"
          value={active !== undefined ? active.length : undefined}
          icon={Activity}
          accent="bg-emerald-500/10"
        />
        <StatTile
          label="Active volume"
          value={totalVolume !== undefined ? `$${(totalVolume / 1e6).toFixed(2)}` : undefined}
          icon={DollarSign}
          accent="bg-violet-500/10"
        />
        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 flex flex-col gap-2">
          <div className={cn(
            "w-8 h-8 rounded-xl flex items-center justify-center",
            isPaused ? "bg-red-500/15" : "bg-emerald-500/10"
          )}>
            {isPaused ? <XCircle className="w-4 h-4 text-red-400" /> : <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
          </div>
          <div className={cn("text-xl font-bold", isPaused ? "text-red-400" : "text-emerald-400")}>
            {isPaused === undefined ? '…' : isPaused ? 'Paused' : 'Active'}
          </div>
          <div className="text-xs text-white/35">Factory status</div>
        </div>
      </div>

      {/* Factory control */}
      <Section title="Factory Control" icon={Shield}>
        <p className="text-sm text-white/40">
          {isPaused
            ? 'Factory is paused — new agreements cannot be created.'
            : 'Factory is active — users can create new agreements.'}
        </p>
        <Button
          onClick={handleToggle}
          disabled={isPending || isPaused === undefined}
          variant={isPaused ? 'default' : 'destructive'}
          className="w-full sm:w-auto"
        >
          {isPending
            ? <Loader2 className="w-4 h-4 animate-spin mr-2" />
            : isPaused
              ? <PlayCircle className="w-4 h-4 mr-2" />
              : <PauseCircle className="w-4 h-4 mr-2" />
          }
          {isPaused ? 'Unpause factory' : 'Pause factory'}
        </Button>
      </Section>
    </div>
  );
}

// ─── ARBITERS TAB ─────────────────────────────────────────────────────────────

function ArbitersTab() {
  // Protocol arbiter
  const { data: protocolArbiter, refetch: refetchProtocol } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'getProtocolArbiter',
  }) as { data: `0x${string}` | undefined; refetch: () => void };

  // Arbitration threshold
  const { data: threshold, refetch: refetchThreshold } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'getArbitrationThreshold',
  }) as { data: bigint | undefined; refetch: () => void };

  // Registry
  const { data: arbiters, refetch: refetchArbiters } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: ARBITER_REGISTRY_ABI,
    functionName: 'getArbiters',
  }) as { data: `0x${string}`[] | undefined; refetch: () => void };

  const { data: chiefRaw, refetch: refetchChief } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: ARBITER_REGISTRY_ABI,
    functionName: 'getChiefArbiter',
  }) as { data: string | undefined; refetch: () => void };

  const chiefArbiter = chiefRaw && chiefRaw !== ZERO ? chiefRaw.toLowerCase() : null;

  const { writeContract, isPending } = useWriteContract();

  // Local state
  const [arbiterAddr,    setArbiterAddr]    = useState('');
  const [thresholdVal,   setThresholdVal]   = useState('');
  const [newArbiter,     setNewArbiter]     = useState('');
  const [newChief,       setNewChief]       = useState('');
  const [removingAddr,   setRemovingAddr]   = useState<string | null>(null);
  const [settingChief,   setSettingChief]   = useState(false);

  // Dispute lookup
  const [dealAddr,   setDealAddr]   = useState('');
  const [lookupAddr, setLookupAddr] = useState('');
  const [dealDetails, setDealDetails] = useState<{
    client: string; executor: string; arbiter: string; status: number; disputedAt: bigint;
  } | null>(null);
  const [isLooking, setIsLooking] = useState(false);
  const publicClient = usePublicClient();

  const isTimerOnly = !protocolArbiter || protocolArbiter === ZERO;

  const handleSetProtocol = async () => {
    try {
      await writeContract({
        address: CONTRACTS.diamond as `0x${string}`,
        abi: DIAMOND_ABI,
        functionName: 'setProtocolArbiter',
        args: [(arbiterAddr || ZERO) as `0x${string}`],
        gas: BigInt(100_000),
      });
      toast.success(arbiterAddr ? 'Protocol arbiter updated' : 'Arbiter cleared (timer-only)');
      setArbiterAddr('');
      refetchProtocol();
    } catch (err: unknown) {
      toast.error((err as { shortMessage?: string })?.shortMessage ?? 'Failed');
    }
  };

  const handleSetThreshold = async () => {
    const v = parseFloat(thresholdVal);
    if (isNaN(v) || v < 0) { toast.error('Invalid value'); return; }
    try {
      await writeContract({
        address: CONTRACTS.diamond as `0x${string}`,
        abi: DIAMOND_ABI,
        functionName: 'setArbitrationThreshold',
        args: [BigInt(Math.floor(v * 1e6))],
        gas: BigInt(100_000),
      });
      toast.success('Threshold updated');
      setThresholdVal('');
      refetchThreshold();
    } catch (err: unknown) {
      toast.error((err as { shortMessage?: string })?.shortMessage ?? 'Failed');
    }
  };

  const handleAddArbiter = async () => {
    if (!isAddress(newArbiter)) { toast.error('Invalid address'); return; }
    try {
      await writeContract({
        address: CONTRACTS.diamond as `0x${string}`,
        abi: ARBITER_REGISTRY_ABI,
        functionName: 'addArbiter',
        args: [newArbiter as `0x${string}`],
        gas: BigInt(120_000),
      });
      toast.success('Arbiter added');
      setNewArbiter('');
      refetchArbiters();
    } catch (err: unknown) {
      toast.error((err as { shortMessage?: string })?.shortMessage ?? 'Failed');
    }
  };

  const handleRemove = async (addr: string) => {
    setRemovingAddr(addr);
    try {
      await writeContract({
        address: CONTRACTS.diamond as `0x${string}`,
        abi: ARBITER_REGISTRY_ABI,
        functionName: 'removeArbiter',
        args: [addr as `0x${string}`],
        gas: BigInt(120_000),
      });
      toast.success('Arbiter removed');
      refetchArbiters();
    } catch (err: unknown) {
      toast.error((err as { shortMessage?: string })?.shortMessage ?? 'Failed');
    } finally {
      setRemovingAddr(null);
    }
  };

  const handleSetChief = async () => {
    const addr = newChief.trim();
    if (addr && !isAddress(addr)) { toast.error('Invalid address'); return; }
    setSettingChief(true);
    try {
      await writeContract({
        address: CONTRACTS.diamond as `0x${string}`,
        abi: ARBITER_REGISTRY_ABI,
        functionName: 'setChiefArbiter',
        args: [(addr || ZERO) as `0x${string}`],
        gas: BigInt(80_000),
      });
      toast.success(addr ? 'Chief arbiter set' : 'Chief arbiter cleared');
      setNewChief('');
      refetchChief();
    } catch (err: unknown) {
      toast.error((err as { shortMessage?: string })?.shortMessage ?? 'Failed');
    } finally {
      setSettingChief(false);
    }
  };

  const handleLookup = async () => {
    if (!publicClient || !isAddress(dealAddr)) { toast.error('Invalid address'); return; }
    setIsLooking(true);
    setDealDetails(null);
    try {
      const r = await publicClient.readContract({
        address: dealAddr as `0x${string}`,
        abi: AGREEMENT_ABI_MINI,
        functionName: 'getDetails',
      }) as [string, string, string, bigint, string, bigint, bigint, bigint, bigint, bigint, bigint, number];
      setLookupAddr(dealAddr);
      setDealDetails({ client: r[0], executor: r[1], arbiter: r[2], status: r[11], disputedAt: r[9] });
    } catch {
      toast.error('Failed to fetch deal — check address');
    } finally {
      setIsLooking(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Protocol arbiter + threshold side-by-side or stacked */}
      <div className="grid md:grid-cols-2 gap-4">
        <Section title="Protocol Arbiter" icon={UserCog}>
          <Row label="Mode">
            <span className={cn("px-2 py-0.5 rounded-full text-xs", isTimerOnly ? "bg-white/10 text-white/50" : "bg-primary/15 text-primary")}>
              {isTimerOnly ? 'Timer-only' : 'Human'}
            </span>
          </Row>
          {!isTimerOnly && <Row label="Address">{short(protocolArbiter!)}</Row>}
          <Divider />
          <FieldGroup label="Set address" hint="Leave empty to switch to timer-only mode">
            <div className="flex gap-2">
              <Input placeholder="0x… or empty" value={arbiterAddr} onChange={e => setArbiterAddr(e.target.value)} className="font-mono text-sm" />
              <Button onClick={handleSetProtocol} disabled={isPending} size="sm">Set</Button>
            </div>
          </FieldGroup>
        </Section>

        <Section title="Arbitration Threshold" icon={DollarSign}>
          <Row label="Current">
            {threshold !== undefined ? `$${(Number(threshold) / 1e6).toFixed(2)} USDC` : '…'}
          </Row>
          <p className="text-xs text-white/30">Deals at or above this amount use the protocol arbiter. Below = timer-only.</p>
          <Divider />
          <FieldGroup label="Set threshold (USDC)" hint="Default: 10 USDC. Set 0 for timer-only on all deals.">
            <div className="flex gap-2">
              <Input type="number" placeholder="10" value={thresholdVal} onChange={e => setThresholdVal(e.target.value)} />
              <Button onClick={handleSetThreshold} disabled={isPending || !thresholdVal} size="sm">Set</Button>
            </div>
          </FieldGroup>
        </Section>
      </div>

      {/* Arbiter Registry */}
      <Section title="Arbiter Registry" icon={Shield}>
        {/* List */}
        {!arbiters ? (
          <div className="flex justify-center py-4"><Loader2 className="w-4 h-4 animate-spin text-white/20" /></div>
        ) : arbiters.length === 0 ? (
          <p className="text-sm text-white/30 py-2">No arbiters registered yet.</p>
        ) : (
          <div className="space-y-1.5">
            {arbiters.map((addr) => {
              const isChief = addr.toLowerCase() === chiefArbiter;
              return (
                <div key={addr} className={cn(
                  "flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5",
                  isChief ? "border-amber-500/20 bg-amber-500/5" : "border-white/[0.06] bg-white/[0.02]"
                )}>
                  <div className="flex items-center gap-2 min-w-0">
                    {isChief && <Crown className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />}
                    <span className="font-mono text-xs text-white/60 truncate">{addr}</span>
                    {isChief && <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/30 text-amber-400 shrink-0">Chief</span>}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-red-400/60 hover:text-red-400 hover:bg-red-500/10 shrink-0"
                    disabled={removingAddr === addr}
                    onClick={() => handleRemove(addr)}
                  >
                    {removingAddr === addr ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserMinus className="w-3.5 h-3.5" />}
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        <Divider />

        <div className="grid sm:grid-cols-2 gap-4">
          <FieldGroup label="Add arbiter">
            <div className="flex gap-2">
              <Input placeholder="0x…" value={newArbiter} onChange={e => setNewArbiter(e.target.value)} className="font-mono text-sm" />
              <Button onClick={handleAddArbiter} disabled={isPending || !newArbiter} size="sm">
                <UserPlus className="w-3.5 h-3.5" />
              </Button>
            </div>
          </FieldGroup>

          <FieldGroup label="Chief arbiter" hint="Can add/remove arbiters. Empty = clear.">
            {chiefArbiter && (
              <p className="font-mono text-xs text-amber-400/80 mb-1.5">{short(chiefArbiter)}</p>
            )}
            <div className="flex gap-2">
              <Input placeholder="0x… or empty to clear" value={newChief} onChange={e => setNewChief(e.target.value)} className="font-mono text-sm" />
              <Button onClick={handleSetChief} disabled={settingChief} size="sm" variant="outline" className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10">
                {settingChief ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Crown className="w-3.5 h-3.5" />}
              </Button>
            </div>
          </FieldGroup>
        </div>
      </Section>

      {/* Dispute Lookup */}
      <Section title="Dispute Lookup" icon={AlertTriangle}>
        <p className="text-xs text-white/30">Enter an agreement address to view parties and jump to their chats.</p>
        <div className="flex gap-2">
          <Input
            placeholder="0x… agreement address"
            value={dealAddr}
            onChange={e => setDealAddr(e.target.value)}
            className="font-mono text-sm"
          />
          <Button onClick={handleLookup} disabled={isLooking || !dealAddr}>
            {isLooking ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Lookup'}
          </Button>
        </div>

        {dealDetails && (
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/35">Status:</span>
              <span className={cn(
                "text-xs font-semibold px-2 py-0.5 rounded-full",
                dealDetails.status === 4 ? "bg-red-500/15 text-red-400" : "bg-white/10 text-white/60"
              )}>
                {DISPUTE_STATUS[dealDetails.status] ?? String(dealDetails.status)}
              </span>
              {dealDetails.status === 4 && dealDetails.disputedAt > 0n && (
                <span className="text-xs text-white/25">
                  since {new Date(Number(dealDetails.disputedAt) * 1000).toLocaleString()}
                </span>
              )}
            </div>

            {([
              { label: 'Client',   addr: dealDetails.client },
              { label: 'Executor', addr: dealDetails.executor },
              ...(dealDetails.arbiter !== ZERO ? [{ label: 'Arbiter', addr: dealDetails.arbiter }] : []),
            ] as { label: string; addr: string }[]).map(({ label, addr }) => (
              <div key={label} className="flex items-center justify-between gap-3">
                <div>
                  <span className="text-xs text-white/35">{label}: </span>
                  <span className="font-mono text-xs text-white/70">{addr}</span>
                </div>
                <Link href={`/chat/${addr.toLowerCase()}`}>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-white/35 hover:text-primary">
                    <MessageCircle className="w-3.5 h-3.5" />
                  </Button>
                </Link>
              </div>
            ))}

            <Link href={`/deal/${lookupAddr}`} className="text-xs text-primary hover:underline flex items-center gap-1">
              <ExternalLink className="w-3 h-3" />
              Open deal page
            </Link>
          </div>
        )}
      </Section>
    </div>
  );
}

// ─── ACTIVITY TAB ─────────────────────────────────────────────────────────────

interface PlatformStats {
  totalDeals: number; totalJobs: number; totalServices: number;
  totalDisputes: number; resolvedDisputes: number; completedDeals: number;
  refundedDeals: number; totalRevenue: bigint;
}

interface FlatDeal {
  addr: string; arbiter: string; client: string; executor: string;
  amount: bigint; status: number; resolvedAt: bigint;
}

const ARCHIVE_LABELS: Record<number, { label: string; cls: string }> = {
  3: { label: 'Completed',       cls: 'border-green-500/30 text-green-400' },
  5: { label: 'Executor paid',   cls: 'border-violet-500/30 text-violet-400' },
  6: { label: 'Client refunded', cls: 'border-blue-500/30 text-blue-400' },
};

function ActivityTab() {
  const publicClient = usePublicClient();
  const [stats,    setStats]    = useState<PlatformStats | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [allDeals, setAllDeals] = useState<FlatDeal[]>([]);
  const [archLoad, setArchLoad] = useState(false);
  const [archDone, setArchDone] = useState(false);
  const [search,   setSearch]   = useState('');

  const { data: arbiters } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: ARBITER_REGISTRY_ABI,
    functionName: 'getArbiters',
  }) as { data: `0x${string}`[] | undefined };

  // Platform stats
  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const diamond = CONTRACTS.diamond;
        const statusUpdatedEvent = {
          anonymous: false,
          inputs: [
            { indexed: true, name: 'agreement', type: 'address' },
            { indexed: false, name: 'newStatus', type: 'uint8' },
          ],
          name: 'AgreementStatusUpdated',
          type: 'event',
        } as const;

        const [dealLogs, jobLogs, serviceLogs, statusLogs, revenueLogs] = await Promise.all([
          publicClient.getLogs({ address: diamond, fromBlock: BigInt(0), toBlock: 'latest', event: { anonymous: false, inputs: [{ indexed: true, name: 'agreement', type: 'address' }, { indexed: true, name: 'client', type: 'address' }, { indexed: true, name: 'executor', type: 'address' }, { indexed: false, name: 'amount', type: 'uint256' }], name: 'AgreementRegistered', type: 'event' } as const }),
          publicClient.getLogs({ address: diamond, fromBlock: BigInt(0), toBlock: 'latest', event: { anonymous: false, inputs: [{ indexed: true, name: 'jobId', type: 'uint256' }, { indexed: true, name: 'client', type: 'address' }, { indexed: false, name: 'amount', type: 'uint256' }, { indexed: false, name: 'region', type: 'uint8' }], name: 'JobPosted', type: 'event' } as const }),
          publicClient.getLogs({ address: diamond, fromBlock: BigInt(0), toBlock: 'latest', event: SERVICE_BOARD_ABI[0] }),
          publicClient.getLogs({ address: diamond, fromBlock: BigInt(0), toBlock: 'latest', event: statusUpdatedEvent }),
          publicClient.getLogs({ address: diamond, fromBlock: BigInt(0), toBlock: 'latest', event: { anonymous: false, inputs: [{ indexed: true, name: 'agreement', type: 'address' }, { indexed: true, name: 'client', type: 'address' }, { indexed: true, name: 'executor', type: 'address' }, { indexed: false, name: 'amount', type: 'uint256' }, { indexed: false, name: 'region', type: 'uint8' }, { indexed: false, name: 'fee', type: 'uint256' }], name: 'AgreementDeployed', type: 'event' } as const }),
        ]);

        if (cancelled) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const byStatus = (s: number) => (statusLogs as any[]).filter(l => Number(l.args?.newStatus) === s).length;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const totalRevenue = (revenueLogs as any[]).reduce((sum: bigint, l) => sum + (l.args?.fee ?? 0n), 0n);

        setStats({
          totalDeals: dealLogs.length,
          totalJobs: jobLogs.length,
          totalServices: serviceLogs.length,
          totalDisputes: byStatus(4),
          resolvedDisputes: byStatus(5),
          completedDeals: byStatus(3),
          refundedDeals: byStatus(6),
          totalRevenue,
        });
      } catch (e) {
        console.error('Failed to fetch platform stats:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [publicClient]);

  // Arbiter archive
  useEffect(() => {
    if (!arbiters?.length || !publicClient || archLoad || archDone) return;
    setArchLoad(true);
    (async () => {
      const flat: FlatDeal[] = [];
      for (const arbiter of arbiters) {
        try {
          const dealAddrs = await publicClient.readContract({
            address: CONTRACTS.diamond as `0x${string}`,
            abi: ARBITER_REGISTRY_ABI,
            functionName: 'getArbiterDeals',
            args: [arbiter],
          }) as string[];
          const details = await Promise.all(dealAddrs.map(addr =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            publicClient.readContract({ address: addr as `0x${string}`, abi: AGREEMENT_ABI_MINI, functionName: 'getDetails' }).then((r: any) => ({
              addr, arbiter, client: r[0] as string, executor: r[1] as string,
              amount: r[3] as bigint, resolvedAt: r[10] as bigint, status: Number(r[11]),
            } satisfies FlatDeal)).catch(() => null)
          ));
          flat.push(...(details.filter(Boolean) as FlatDeal[]));
        } catch { /* skip */ }
      }
      flat.sort((a, b) => Number(b.resolvedAt - a.resolvedAt));
      setAllDeals(flat);
    })().finally(() => { setArchLoad(false); setArchDone(true); });
  }, [arbiters, publicClient, archLoad, archDone]);

  const filtered = allDeals.filter(d => {
    if (!search) return true;
    const q = search.toLowerCase();
    return [d.addr, d.arbiter, d.client, d.executor].some(s => s.toLowerCase().includes(q));
  });

  const statItems = stats ? [
    { label: 'Deals',     value: stats.totalDeals,       icon: TrendingUp,    accent: 'bg-primary/10'      },
    { label: 'Jobs',      value: stats.totalJobs,        icon: Activity,      accent: 'bg-emerald-500/10'  },
    { label: 'Services',  value: stats.totalServices,    icon: Wallet,        accent: 'bg-violet-500/10'   },
    { label: 'Completed', value: stats.completedDeals,   icon: CheckCircle2,  accent: 'bg-green-500/10'    },
    { label: 'Disputes',  value: stats.totalDisputes,    icon: AlertTriangle, accent: 'bg-amber-500/10'    },
    { label: 'Resolved',  value: stats.resolvedDisputes, icon: Gavel,         accent: 'bg-blue-500/10'     },
    { label: 'Refunded',  value: stats.refundedDeals,    icon: XCircle,       accent: 'bg-red-500/10'      },
    { label: 'Revenue',   value: `$${(Number(stats.totalRevenue) / 1e6).toFixed(2)}`, icon: DollarSign, accent: 'bg-yellow-500/10' },
  ] : [];

  return (
    <div className="space-y-4">
      {/* Platform stats */}
      <Section title="Platform Activity (All Time)" icon={BarChart3}>
        {loading ? (
          <div className="flex items-center gap-2 text-white/30 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Fetching on-chain data…
          </div>
        ) : !stats ? (
          <p className="text-sm text-white/30">Failed to load</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {statItems.map(({ label, value, icon, accent }) => (
              <StatTile key={label} label={label} value={value} icon={icon} accent={accent} />
            ))}
          </div>
        )}
      </Section>

      {/* Arbiter archive */}
      <Section title="Arbiter Archive" icon={Shield}>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/25 pointer-events-none" />
          <Input
            placeholder="Search by deal, arbiter, client or executor…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 font-mono text-sm"
          />
        </div>

        {(!arbiters || archLoad) ? (
          <div className="flex justify-center py-6"><Loader2 className="w-4 h-4 animate-spin text-white/20" /></div>
        ) : allDeals.length === 0 ? (
          <p className="text-sm text-white/30 py-2 text-center">No resolved disputes yet</p>
        ) : (
          <>
            <p className="text-xs text-white/25 font-mono">
              {filtered.length === allDeals.length
                ? `${allDeals.length} case${allDeals.length !== 1 ? 's' : ''}`
                : `${filtered.length} / ${allDeals.length}`}
            </p>
            <div className="space-y-1.5">
              {filtered.map(deal => {
                const st = ARCHIVE_LABELS[deal.status];
                return (
                  <div key={deal.addr} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="font-mono text-xs text-white/60">{short(deal.addr)}</span>
                        {st
                          ? <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${st.cls}`}>{st.label}</span>
                          : <span className="text-[10px] text-white/25">Status {deal.status}</span>
                        }
                        {deal.resolvedAt > 0n && (
                          <span className="text-[10px] text-white/20 font-mono">
                            {new Date(Number(deal.resolvedAt) * 1000).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2.5 text-[11px] text-white/30 flex-wrap">
                        <span>Arbiter: <span className="font-mono text-white/45">{short(deal.arbiter)}</span></span>
                        <span>C: <span className="font-mono">{short(deal.client)}</span></span>
                        <span>E: <span className="font-mono">{short(deal.executor)}</span></span>
                        <span className="font-mono text-white/40">${(Number(deal.amount) / 1e6).toFixed(2)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Link href={`/chat/${deal.client.toLowerCase()}`}>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-white/25 hover:text-primary">
                          <MessageCircle className="w-3.5 h-3.5" />
                        </Button>
                      </Link>
                      <Link href={`/deal/${deal.addr}`}>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-white/25 hover:text-white/60">
                          <ExternalLink className="w-3.5 h-3.5" />
                        </Button>
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Section>
    </div>
  );
}

// ─── SETTINGS TAB ─────────────────────────────────────────────────────────────

function SettingsTab() {
  const { writeContract, isPending } = useWriteContract();

  const { data: currentFeeRecipient, refetch: refetchFee } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'getFeeRecipient',
  }) as { data: string | undefined; refetch: () => void };

  const { data: currentForwarder, refetch: refetchFwd } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'getTrustedForwarder',
  }) as { data: string | undefined; refetch: () => void };

  const { data: fees, refetch: refetchFees } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'getAllFees',
  }) as { data: [bigint, bigint, bigint, bigint] | undefined; refetch: () => void };

  const [feeRecipient, setFeeRecipient] = useState('');
  const [forwarder,    setForwarder]    = useState('');
  const [newFee,       setNewFee]       = useState('');
  const [selectedRegion, setSelectedRegion] = useState(0);

  const regions = [
    { idx: 0, name: 'CIS (СНГ)',  fee: fees?.[0] },
    { idx: 1, name: 'Asia',       fee: fees?.[1] },
    { idx: 2, name: 'Europe',     fee: fees?.[2] },
    { idx: 3, name: 'US',         fee: fees?.[3] },
    { idx: 4, name: 'LATAM',      fee: fees?.[4] },
    { idx: 5, name: 'CA',         fee: fees?.[5] },
    { idx: 6, name: 'AU',         fee: fees?.[6] },
  ];

  const handleSetFeeRecipient = async () => {
    if (!isAddress(feeRecipient)) { toast.error('Invalid address'); return; }
    try {
      await writeContract({ address: CONTRACTS.diamond as `0x${string}`, abi: DIAMOND_ABI, functionName: 'setFeeRecipient', args: [feeRecipient as `0x${string}`], gas: BigInt(100_000) });
      toast.success('Fee recipient updated');
      setFeeRecipient('');
      refetchFee();
    } catch (err: unknown) {
      toast.error((err as { shortMessage?: string })?.shortMessage ?? 'Failed');
    }
  };

  const handleSetForwarder = async () => {
    if (!isAddress(forwarder)) { toast.error('Invalid address'); return; }
    try {
      await writeContract({ address: CONTRACTS.diamond as `0x${string}`, abi: DIAMOND_ABI, functionName: 'setTrustedForwarder', args: [forwarder as `0x${string}`], gas: BigInt(100_000) });
      toast.success('Forwarder updated');
      setForwarder('');
      refetchFwd();
    } catch (err: unknown) {
      toast.error((err as { shortMessage?: string })?.shortMessage ?? 'Failed');
    }
  };

  const handleSetFee = async () => {
    if (!newFee || parseFloat(newFee) <= 0) { toast.error('Invalid fee'); return; }
    try {
      await writeContract({ address: CONTRACTS.diamond as `0x${string}`, abi: DIAMOND_ABI, functionName: 'setRegionFee', args: [selectedRegion, BigInt(Math.floor(parseFloat(newFee) * 1e6))], gas: BigInt(100_000) });
      toast.success('Fee updated');
      setNewFee('');
      refetchFees();
    } catch (err: unknown) {
      toast.error((err as { shortMessage?: string })?.shortMessage ?? 'Failed');
    }
  };

  return (
    <div className="space-y-4">
      {/* PPP Fees */}
      <Section title="PPP Region Fees" icon={DollarSign}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {regions.map(r => (
            <div key={r.idx} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-center">
              <p className="text-xs text-white/35 mb-1">{r.name}</p>
              <p className="font-mono text-sm font-bold text-white/80">
                {r.fee !== undefined ? `$${(Number(r.fee) / 1e6).toFixed(2)}` : '…'}
              </p>
            </div>
          ))}
        </div>
        <Divider />
        <FieldGroup label="Update fee">
          <div className="flex gap-2 flex-wrap">
            <select
              aria-label="Region"
              value={selectedRegion}
              onChange={e => setSelectedRegion(Number(e.target.value))}
              className="px-3 py-2 rounded-lg border border-white/[0.08] bg-white/[0.03] text-sm text-white/80"
            >
              {regions.map(r => <option key={r.idx} value={r.idx}>{r.name}</option>)}
            </select>
            <Input type="number" placeholder="USDC amount" value={newFee} onChange={e => setNewFee(e.target.value)} className="flex-1 min-w-[120px]" />
            <Button onClick={handleSetFee} disabled={isPending || !newFee} size="sm">Update</Button>
          </div>
        </FieldGroup>
      </Section>

      {/* Advanced */}
      <Section title="Advanced" icon={Settings}>
        <div className="space-y-5">
          <FieldGroup label="Fee recipient">
            {currentFeeRecipient && (
              <p className="font-mono text-xs text-white/35 break-all mb-1.5">{currentFeeRecipient}</p>
            )}
            <div className="flex gap-2">
              <Input placeholder="0x…" value={feeRecipient} onChange={e => setFeeRecipient(e.target.value)} className="font-mono text-sm" />
              <Button onClick={handleSetFeeRecipient} disabled={isPending || !feeRecipient} size="sm">Set</Button>
            </div>
          </FieldGroup>

          <Divider />

          <FieldGroup label="Trusted forwarder">
            {currentForwarder && (
              <p className="font-mono text-xs text-white/35 break-all mb-1.5">{currentForwarder}</p>
            )}
            <div className="flex gap-2">
              <Input placeholder="0x…" value={forwarder} onChange={e => setForwarder(e.target.value)} className="font-mono text-sm" />
              <Button onClick={handleSetForwarder} disabled={isPending || !forwarder} size="sm">Set</Button>
            </div>
          </FieldGroup>
        </div>
      </Section>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const { isConnected, address } = useAccount();
  const [isChecking, setIsChecking] = useState(true);
  const [isOwner,    setIsOwner]    = useState(false);
  const [tab,        setTab]        = useState<Tab>('overview');
  const isMounted = useIsMounted();

  const { data: ownerAddress } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'owner',
  });

  useEffect(() => {
    if (isMounted && !isConnected) setIsChecking(false);
    if (ownerAddress && address) {
      setIsOwner(String(ownerAddress).toLowerCase() === String(address).toLowerCase());
      setIsChecking(false);
    }
  }, [address, isConnected, isMounted, ownerAddress]);

  if (!isMounted || isChecking) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-white/30" />
      </div>
    );
  }

  if (!isConnected || !isOwner) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="max-w-sm w-full text-center space-y-4">
          <div className="w-14 h-14 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center mx-auto">
            <Shield className="w-6 h-6 text-white/30" />
          </div>
          <h2 className="font-syne font-bold text-xl">
            {!isConnected ? 'Connect wallet' : 'Access denied'}
          </h2>
          <p className="text-sm text-white/40">
            {!isConnected ? 'Owner wallet required to access admin panel.' : 'Only the contract owner can access this page.'}
          </p>
          <Link href={isConnected ? '/dashboard' : '/'}>
            <Button variant="outline" className="mt-2">← Go back</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <div className="max-w-4xl mx-auto px-4 py-8">

        {/* Page header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="font-syne font-bold text-2xl">Admin</h1>
            <p className="text-xs text-white/30 font-mono mt-0.5">{address}</p>
          </div>
          <div className="w-9 h-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
            <Shield className="w-4 h-4 text-primary" />
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 p-1 rounded-2xl bg-white/[0.03] border border-white/[0.06] mb-6">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150",
                tab === id
                  ? "bg-white/[0.08] text-white shadow-sm"
                  : "text-white/35 hover:text-white/60"
              )}
            >
              <Icon className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>

        {/* Tab content */}
        {tab === 'overview'  && <OverviewTab  />}
        {tab === 'arbiters'  && <ArbitersTab  />}
        {tab === 'activity'  && <ActivityTab  />}
        {tab === 'settings'  && <SettingsTab  />}
      </div>
    </div>
  );
}
