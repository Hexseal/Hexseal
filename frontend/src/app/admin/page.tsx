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
  Loader2, DollarSign, Settings,
  Shield, UserCog, AlertTriangle, UserPlus,
  Search, ExternalLink, Crown, BarChart3, Gavel, Activity,
  TrendingUp, Wallet, CheckCircle2, XCircle,
} from 'lucide-react';
import { isAddress, parseAbi } from 'viem';
import { cn } from '@/lib/utils';
import { PageCenter } from '@/components/PageCenter';
import {
  ArbiterAccountabilityCard,
  ArbiterAccountabilityNotice,
} from '@/components/AdminArbiterAccountability';
import { useRemovalRules } from '@/hooks/useRemovalRules';

// ─── Mini ABI ────────────────────────────────────────────────────────────────

const AGREEMENT_ABI_MINI = parseAbi([
  'function getDetails() view returns (address client_, address executor_, address arbiter_, uint256 amount_, string terms_, uint256 deadlineDays_, uint256 fundedAt_, uint256 activatedAt_, uint256 markedDoneAt_, uint256 disputedAt_, uint256 resolvedAt_, uint8 status_)',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ZERO  = '0x0000000000000000000000000000000000000000';

const DISPUTE_STATUS: Record<number, string> = {
  0: 'Created', 1: 'Funded', 2: 'Active', 3: 'Completed',
  4: 'Disputed', 5: 'Resolved', 6: 'Refunded',
};

// ─── UI primitives ────────────────────────────────────────────────────────────

/** Card-style section with title + icon */
function Section({ title, hint, icon: Icon, children, className }: {
  title: string; hint?: string; icon: React.ElementType;
  children: React.ReactNode; className?: string;
}) {
  return (
    <div
      className={cn("rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] p-5 space-y-4", className)}
      style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}
    >
      <div>
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-white/40 shrink-0" />
          <h3 className="text-sm font-semibold text-white/70">{title}</h3>
        </div>
        {hint && <p className="text-[11px] text-white/30 mt-1 ml-6 leading-relaxed">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-white/40">{label}</span>
      <span className="text-sm font-mono text-white/75">{children}</span>
    </div>
  );
}

function FieldGroup({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-white/50">{label}</p>
      {hint && <p className="text-[11px] text-white/25 leading-relaxed">{hint}</p>}
      {children}
    </div>
  );
}

function Divider() { return <div className="h-px bg-white/[0.06]" />; }

function StatTile({ label, value, icon: Icon, accent }: {
  label: string; value: string | number | undefined; icon: React.ElementType; accent?: string;
}) {
  return (
    <div
      className="rounded-[18px] border border-white/[0.07] bg-white/[0.02] p-4 flex flex-col gap-2"
      style={{ boxShadow: "0 1px 6px rgba(0,0,0,0.3)" }}
    >
      <div className={cn("w-8 h-8 rounded-[10px] flex items-center justify-center", accent ?? "bg-white/[0.05]")}>
        <Icon className="w-4 h-4 text-white/50" />
      </div>
      <div className="text-2xl font-bold font-mono text-white">
        {value ?? <Loader2 className="w-5 h-5 animate-spin text-white/20" />}
      </div>
      <div className="text-xs text-white/35">{label}</div>
    </div>
  );
}

// ─── Tab types ────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'arbiters' | 'activity' | 'settings';

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'overview',  label: 'Overview',  icon: BarChart3 },
  { id: 'arbiters',  label: 'Arbiters',  icon: Gavel     },
  { id: 'activity',  label: 'Activity',  icon: Activity  },
  { id: 'settings',  label: 'Settings',  icon: Settings  },
];

// ─── OVERVIEW TAB ─────────────────────────────────────────────────────────────

function OverviewTab() {
  const { data: total } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`, abi: DIAMOND_ABI,
    functionName: 'totalAgreements',
  }) as { data: bigint | undefined };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: active } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`, abi: DIAMOND_ABI,
    functionName: 'getActive',
  }) as { data: any[] | undefined };

  const totalVolume = active ? active.reduce((s, a) => s + Number(a.amount), 0) : undefined;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <StatTile label="Total agreements" value={total !== undefined ? total.toString() : undefined} icon={TrendingUp} accent="bg-primary/10" />
        <StatTile label="Active deals" value={active !== undefined ? active.length : undefined} icon={Activity} accent="bg-emerald-500/10" />
        <StatTile label="Active volume" value={totalVolume !== undefined ? `$${(totalVolume / 1e6).toFixed(2)}` : undefined} icon={DollarSign} accent="bg-violet-500/10" />
      </div>
    </div>
  );
}

// ─── ARBITERS TAB ─────────────────────────────────────────────────────────────

function ArbitersTab() {
  const { data: arbiters, refetch: refetchArbiters } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`, abi: ARBITER_REGISTRY_ABI,
    functionName: 'getArbiters',
  }) as { data: `0x${string}`[] | undefined; refetch: () => void };

  const { data: chiefRaw, refetch: refetchChief } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`, abi: ARBITER_REGISTRY_ABI,
    functionName: 'getChiefArbiter',
  }) as { data: string | undefined; refetch: () => void };

  const chiefArbiter = chiefRaw && chiefRaw !== ZERO ? chiefRaw.toLowerCase() : null;

  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  const [newArbiter,    setNewArbiter]    = useState('');
  const [newChief,      setNewChief]      = useState('');
  const [addingArbiter, setAddingArbiter] = useState(false);
  const [settingChief,  setSettingChief]  = useState(false);

  /**
   * ⚠️ ОДНА ПРОБА НА ВЕСЬ СПИСОК, А НЕ ПО ОДНОЙ НА АРБИТРА. Правила сноса
   * (пауза, срок годности, потолок слов, порог и потолок судейских ошибок)
   * одинаковы для всех, и они же служат пробой «смонтирован ли фасет»: разрез
   * ещё не сделан, и до него КАЖДОЕ чтение из него ревертит в fallback
   * даймонда. Спрашивать это на каждой строке значило бы двадцать одинаковых
   * отказов вместо одной внятной фразы.
   */
  const removalRules = useRemovalRules();

  /**
   * ⚠️ ЖЁСТКОГО `gas:` ЗДЕСЬ БОЛЬШЕ НЕТ, И ЭТО НЕ КОСМЕТИКА.
   *
   * Явный лимит газа означает «кошелёк, не оценивай вызов»: транзакция уходит в
   * цепь без пробной прогонки. Дальше два разных несчастья, и оба молчат:
   *
   *  1. ОТКАЗ. За август у addArbiter появились три новые двери —
   *     SeatingHandedOver (право посадки передано ДАО),
   *     ReseatingRemovedIsOwnerOnly (снесённого возвращает только владелец),
   *     ChiefBlocWouldDecideAppeal (блок директора решил бы апелляцию сам).
   *     С явным газом такой вызов отревертит УЖЕ В ЦЕПИ и возьмёт деньги,
   *     ничего не объяснив. Без него оценка провалится заранее, локально и
   *     бесплатно, и человек увидит причину до подписи.
   *  2. НЕХВАТКА. Замер 17 августа 2026 (forge test -vvvv,
   *     test_AddArbiterWorksBeforeDao): DiamondProxy::fallback → addArbiter
   *     стоит 134 389 газа, плюс 21 000 внутренних — около 155 900. Потолок
   *     стоял 120 000, то есть кнопка была мертва ПО ПРАВИЛЬНОМУ пути и
   *     сжигала весь лимит впустую при каждом нажатии. Прежде функция стоила
   *     меньше: за август к ней прибавились seatedBy, seatedCountBy, событие
   *     ArbiterSeated и clearRemovalRecord.
   *
   * Литерал был из самого первого коммита репозитория (5d66d355) — привычка, а
   * не решение: единственное, что он давал, — экономию одного eth_estimateGas.
   */
  const handleAddArbiter = async () => {
    if (!isAddress(newArbiter)) { toast.error('Invalid address'); return; }
    if (!publicClient) { toast.error('Failed'); return; }
    setAddingArbiter(true);
    try {
      const hash = await writeContractAsync({
        address: CONTRACTS.diamond as `0x${string}`, abi: ARBITER_REGISTRY_ABI,
        functionName: 'addArbiter', args: [newArbiter as `0x${string}`],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === 'reverted') throw new Error('Transaction reverted on-chain');
      toast.success('Arbiter added');
      setNewArbiter('');
      refetchArbiters();
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      toast.error(e?.shortMessage ?? e?.message ?? 'Failed');
    } finally { setAddingArbiter(false); }
  };

  /**
   * ⚠️ ЗДЕСЬ БЫЛА КНОПКА `removeArbiter(address)`, И ЕЁ БОЛЬШЕ НЕТ.
   *
   * Голая `removeArbiter` (селектор `0x3487e08c`) уходит из даймонда
   * единственным элементом `Remove` в разрезе
   * `script/UpgradeArbiterAccountability.s.sol`: после разреза селектор не
   * маршрутизируется никуда, вызов проваливается в fallback даймонда и
   * ревертит. Кнопку сняли ДО разреза, а не после, — иначе живая кнопка
   * умерла бы молча.
   *
   * ⚠️ И ЗАМЕНИЛА ЕЁ НЕ ДРУГАЯ КНОПКА, А ПРОЦЕСС. Снос теперь идёт четырьмя
   * шагами (замысел `docs/superpowers/specs/2026-08-21-arbiter-screens-design.md`,
   * раздел 4): предложить с поводом → 48 часов паузы, в которые обвинённый
   * отвечает → исполнить тем же поводом или отозвать. Всё это живёт в
   * `components/AdminArbiterAccountability.tsx`; здесь остался только список.
   *
   * Прежний комментарий на этом месте объяснял, почему с умирающей кнопки снят
   * жёсткий `gas:` (чтобы после разреза она падала до подписи и бесплатно). Он
   * не протух — правило переехало вместе с работой и теперь стоит замком на
   * ВЕСЬ арбитражный фасет, а не на одну кнопку: `lib/arbiterWritesEstimateGas.test.ts`.
   */

  const handleSetChief = async () => {
    const addr = newChief.trim();
    if (addr && !isAddress(addr)) { toast.error('Invalid address'); return; }
    if (!publicClient) { toast.error('Failed'); return; }
    setSettingChief(true);
    try {
      const hash = await writeContractAsync({
        address: CONTRACTS.diamond as `0x${string}`, abi: ARBITER_REGISTRY_ABI,
        // Без жёсткого газа по тому же доводу, что у двух кнопок выше: за
        // август setChiefArbiter получила дверь SeatingHandedOver (роль
        // директора упраздняется при активном ДАО). Самой оценке здесь ничего
        // не мешало и раньше — 28 792 газа по замеру, потолок 80 000 хватал, —
        // но с явным литералом отказ стоил бы денег и молчал.
        functionName: 'setChiefArbiter', args: [(addr || ZERO) as `0x${string}`],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === 'reverted') throw new Error('Transaction reverted on-chain');
      toast.success(addr ? 'Chief arbiter set' : 'Chief arbiter cleared');
      setNewChief('');
      refetchChief();
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      toast.error(e?.shortMessage ?? e?.message ?? 'Failed');
    }
    finally { setSettingChief(false); }
  };

  return (
    <div className="space-y-4">

      {/* ── 1. Arbiter Registry ── */}
      <Section
        title="Arbiter Registry"
        hint="Pool of human arbiters who can claim disputed cases. Chief arbiter can manage this list."
        icon={Shield}
      >
        {/* ⚠️ Одна фраза на весь список, если фасета в цепи ещё нет: до разреза
             КАЖДОЕ чтение и КАЖДАЯ кнопка ниже отвечают отказом даймонда, и без
             этой фразы страница выглядела бы сломанной. */}
        <ArbiterAccountabilityNotice presence={removalRules.presence} />

        {/* List */}
        {!arbiters ? (
          <div className="flex justify-center py-4"><Loader2 className="w-4 h-4 animate-spin text-white/20" /></div>
        ) : arbiters.length === 0 ? (
          <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] px-4 py-6 text-center">
            <p className="text-sm text-white/30">No arbiters registered yet.</p>
            <p className="text-xs text-white/20 mt-1">Add addresses below to allow them to claim disputes.</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {arbiters.map((addr) => (
              <ArbiterAccountabilityCard
                key={addr}
                arbiter={addr}
                isChief={addr.toLowerCase() === chiefArbiter}
                rules={removalRules}
                onChanged={refetchArbiters}
              />
            ))}
          </div>
        )}

        <Divider />

        <div className="grid sm:grid-cols-2 gap-4">
          <FieldGroup label="Add arbiter" hint="Address will be able to claim disputed cases.">
            <div className="flex gap-2">
              <Input placeholder="0x…" value={newArbiter} onChange={e => setNewArbiter(e.target.value)}
                className="font-mono text-sm bg-transparent border-white/[0.08] rounded-[14px]" />
              <Button onClick={handleAddArbiter} disabled={addingArbiter || !newArbiter} size="sm" className="gap-1 shrink-0">
                {addingArbiter ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />} Add
              </Button>
            </div>
          </FieldGroup>

          <FieldGroup label="Chief arbiter" hint="Can add/remove arbiters. Leave empty to clear.">
            {chiefArbiter && (
              <p className="flex items-center gap-1 font-mono text-xs text-amber-400/80 mb-1.5">
                <Crown className="w-3 h-3" /> {short(chiefArbiter)}
              </p>
            )}
            <div className="flex gap-2">
              <Input placeholder="0x… or empty to clear" value={newChief} onChange={e => setNewChief(e.target.value)}
                className="font-mono text-sm bg-transparent border-white/[0.08] rounded-[14px]" />
              <Button onClick={handleSetChief} disabled={settingChief} size="sm" variant="outline"
                className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10 shrink-0">
                {settingChief ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Crown className="w-3.5 h-3.5" />}
              </Button>
            </div>
          </FieldGroup>
        </div>
      </Section>

    </div>
  );
}

// ─── ACTIVITY TAB ─────────────────────────────────────────────────────────────

interface PlatformStats {
  totalDeals: number; totalJobs: number; totalServices: number;
  totalDisputes: number; resolvedDisputes: number; completedDeals: number;
  refundedDeals: number; totalRevenue: bigint; revenueByKind: Record<number, bigint>;
}

// FeeCollected.kind — every fee-transfer site in the protocol (10 total: 2 job board,
// 6 service board, 2 direct-factory). 0+1 = job board revenue, 2+3+4 = service board
// revenue; 5 sits outside both (direct hire, no board involved).
const FEE_KIND_LABELS: Record<number, string> = {
  0: 'Job deals (commission)',
  1: 'Job forfeits (cancelled deposits)',
  2: 'Service listings (posting floor)',
  3: 'Hire commissions (requests)',
  4: 'Request forfeits (declined / withdrawn / superseded)',
  5: 'Direct factory hires (no board)',
};

interface FlatDeal {
  addr: string; arbiter: string; client: string; executor: string;
  amount: bigint; status: number; resolvedAt: bigint;
}

const ARCHIVE_LABELS: Record<number, { label: string; cls: string }> = {
  3: { label: 'Completed',       cls: 'border-green-500/30 text-green-400'   },
  5: { label: 'Executor paid',   cls: 'border-violet-500/30 text-violet-400' },
  6: { label: 'Client refunded', cls: 'border-sky-500/30 text-sky-400'       },
};

function ActivityTab() {
  const publicClient = usePublicClient();
  const [stats,    setStats]    = useState<PlatformStats | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [allDeals, setAllDeals] = useState<FlatDeal[]>([]);
  const [archLoad, setArchLoad] = useState(false);
  const [archDone, setArchDone] = useState(false);
  const [search,   setSearch]   = useState('');

  // Dispute Lookup
  const [dealAddr,    setDealAddr]    = useState('');
  const [lookupAddr,  setLookupAddr]  = useState('');
  const [dealDetails, setDealDetails] = useState<{
    client: string; executor: string; arbiter: string; status: number; disputedAt: bigint;
  } | null>(null);
  const [isLooking, setIsLooking] = useState(false);

  const { data: arbiters } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`, abi: ARBITER_REGISTRY_ABI,
    functionName: 'getArbiters',
  }) as { data: `0x${string}`[] | undefined };

  // Platform stats from on-chain events — chunked to stay within RPC 2000-block limit
  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const diamond = CONTRACTS.diamond as `0x${string}`;
        const latest  = await publicClient.getBlockNumber();
        // Fetch from Diamond deployment block (approx) — chunk into 1990-block windows
        const ORIGIN = BigInt(42_134_705); // Base Sepolia block of Diamond deployment (Init Factory tx)
        const CHUNK  = BigInt(1990);
        const from   = latest > ORIGIN ? ORIGIN : BigInt(0);

        const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
        for (let b = from; b <= latest; b += CHUNK) {
          ranges.push({ fromBlock: b, toBlock: b + CHUNK - 1n < latest ? b + CHUNK - 1n : latest });
        }

        const statusUpdatedEvent = {
          anonymous: false,
          inputs: [{ indexed: true, name: 'agreement', type: 'address' }, { indexed: false, name: 'newStatus', type: 'uint8' }],
          name: 'AgreementStatusUpdated', type: 'event',
        } as const;

        const fetchAll = async <T,>(event: T) =>
          (await Promise.all(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ranges.map(r => (publicClient.getLogs as any)({ address: diamond, event, ...r }).catch(() => []))
          )).flat();

        const [dealLogs, jobLogs, serviceLogs, statusLogs, revenueLogs] = await Promise.all([
          fetchAll({ anonymous: false, inputs: [{ indexed: true, name: 'agreement', type: 'address' }, { indexed: true, name: 'client', type: 'address' }, { indexed: true, name: 'executor', type: 'address' }, { indexed: false, name: 'amount', type: 'uint256' }], name: 'AgreementRegistered', type: 'event' }),
          fetchAll({ anonymous: false, inputs: [{ indexed: true, name: 'jobId', type: 'uint256' }, { indexed: true, name: 'client', type: 'address' }, { indexed: false, name: 'amount', type: 'uint256' }, { indexed: false, name: 'region', type: 'uint8' }, { indexed: false, name: 'title', type: 'string' }, { indexed: false, name: 'description', type: 'string' }, { indexed: false, name: 'deadlineDays', type: 'uint256' }, { indexed: false, name: 'terms', type: 'string' }], name: 'JobPosted', type: 'event' }),
          fetchAll(SERVICE_BOARD_ABI[0]),
          fetchAll(statusUpdatedEvent),
          // Actual transfer, not the AgreementDeployed re-quote at hire time — those two
          // can disagree if the rate changed between posting and hiring.
          fetchAll({ anonymous: false, inputs: [
            { indexed: true, name: 'id', type: 'uint256' },
            { indexed: true, name: 'payer', type: 'address' },
            { indexed: true, name: 'kind', type: 'uint8' },
            { indexed: false, name: 'amount', type: 'uint256' },
          ], name: 'FeeCollected', type: 'event' }),
        ]);

        if (cancelled) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const byStatus = (s: number) => (statusLogs as any[]).filter(l => Number(l.args?.newStatus) === s).length;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const revenueByKind = (revenueLogs as any[]).reduce((acc: Record<number, bigint>, l) => {
          const k = Number(l.args?.kind ?? 0);
          acc[k] = (acc[k] ?? 0n) + (l.args?.amount ?? 0n);
          return acc;
        }, {} as Record<number, bigint>);
        const totalRevenue = Object.values(revenueByKind).reduce((sum: bigint, v) => sum + v, 0n);
        setStats({
          totalDeals: dealLogs.length, totalJobs: jobLogs.length, totalServices: serviceLogs.length,
          totalDisputes: byStatus(4), resolvedDisputes: byStatus(5),
          completedDeals: byStatus(3), refundedDeals: byStatus(6), totalRevenue, revenueByKind,
        });
      } catch (e) { console.error('Failed to fetch platform stats:', e); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [publicClient]);

  // Arbiter deal archive
  useEffect(() => {
    if (!arbiters?.length || !publicClient || archLoad || archDone) return;
    setArchLoad(true);
    (async () => {
      const flat: FlatDeal[] = [];
      for (const arbiter of arbiters) {
        try {
          const dealAddrs = await publicClient.readContract({
            address: CONTRACTS.diamond as `0x${string}`, abi: ARBITER_REGISTRY_ABI,
            functionName: 'getArbiterDeals', args: [arbiter],
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

  // Dispute lookup
  const handleLookup = async () => {
    if (!publicClient || !isAddress(dealAddr)) { toast.error('Invalid address'); return; }
    setIsLooking(true);
    setDealDetails(null);
    try {
      const r = await publicClient.readContract({
        address: dealAddr as `0x${string}`, abi: AGREEMENT_ABI_MINI, functionName: 'getDetails',
      }) as [string, string, string, bigint, string, bigint, bigint, bigint, bigint, bigint, bigint, number];
      setLookupAddr(dealAddr);
      setDealDetails({ client: r[0], executor: r[1], arbiter: r[2], status: r[11], disputedAt: r[9] });
    } catch { toast.error('Failed to fetch deal — check address'); }
    finally { setIsLooking(false); }
  };

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
          <div className="flex items-center gap-2 text-white/30 text-sm py-2">
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

      {/* Revenue by source — job board vs. service board */}
      {stats && (
        <Section
          title="Revenue by Source"
          hint="From FeeCollected, at the point of actual transfer — covers all 10 fee-collection sites (not the AgreementDeployed re-quote, which can be stale)."
          icon={DollarSign}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-[14px] border border-emerald-500/20 bg-emerald-500/[0.05] p-3">
              <p className="text-xs text-white/35 mb-1">Job board (deals + forfeits)</p>
              <p className="font-mono text-lg font-bold text-emerald-400">
                ${(Number((stats.revenueByKind[0] ?? 0n) + (stats.revenueByKind[1] ?? 0n)) / 1e6).toFixed(2)}
              </p>
            </div>
            <div className="rounded-[14px] border border-violet-500/20 bg-violet-500/[0.05] p-3">
              <p className="text-xs text-white/35 mb-1">Service board (listings + hires + forfeits)</p>
              <p className="font-mono text-lg font-bold text-violet-400">
                ${(Number((stats.revenueByKind[2] ?? 0n) + (stats.revenueByKind[3] ?? 0n) + (stats.revenueByKind[4] ?? 0n)) / 1e6).toFixed(2)}
              </p>
            </div>
          </div>
          <Divider />
          <div className="space-y-1.5">
            {[0, 1, 2, 3, 4, 5].map(k => (
              <Row key={k} label={FEE_KIND_LABELS[k]}>
                ${(Number(stats.revenueByKind[k] ?? 0n) / 1e6).toFixed(2)}
              </Row>
            ))}
          </div>
        </Section>
      )}

      {/* Dispute Lookup */}
      <Section title="Deal Lookup" hint="Enter any agreement address to inspect its parties and current status." icon={AlertTriangle}>
        <div className="flex gap-2">
          <Input
            placeholder="0x… agreement address"
            value={dealAddr}
            onChange={e => setDealAddr(e.target.value)}
            className="font-mono text-sm bg-transparent border-white/[0.08] rounded-[14px]"
          />
          <Button onClick={handleLookup} disabled={isLooking || !dealAddr} size="sm" className="shrink-0">
            {isLooking ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Lookup'}
          </Button>
        </div>

        {dealDetails && (
          <div className="rounded-[14px] border border-white/[0.07] bg-white/[0.02] p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/35">Status</span>
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
                  <span className="text-xs text-white/35">{label} </span>
                  <span className="font-mono text-xs text-white/65">{addr}</span>
                </div>
                <Link href={`/profile/${addr.toLowerCase()}`}>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-white/30 hover:text-white/70">
                    Profile
                  </Button>
                </Link>
              </div>
            ))}
            <Link href={`/deal/${lookupAddr}`} className="flex items-center gap-1 text-xs text-primary hover:underline">
              <ExternalLink className="w-3 h-3" /> Open deal page
            </Link>
          </div>
        )}
      </Section>

      {/* Arbiter archive */}
      <Section title="Arbiter Archive" hint="All deals handled by registered arbiters." icon={Shield}>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/25 pointer-events-none" />
          <Input
            placeholder="Search by deal, arbiter, client or executor…"
            value={search} onChange={e => setSearch(e.target.value)}
            className="pl-9 font-mono text-sm bg-transparent border-white/[0.08] rounded-[14px]"
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
                  <div key={deal.addr} className="flex items-center justify-between gap-3 rounded-[14px] border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
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
                        <span>Arbiter <span className="font-mono text-white/45">{short(deal.arbiter)}</span></span>
                        <span>C <span className="font-mono">{short(deal.client)}</span></span>
                        <span>E <span className="font-mono">{short(deal.executor)}</span></span>
                        <span className="font-mono text-white/40">${(Number(deal.amount) / 1e6).toFixed(2)}</span>
                      </div>
                    </div>
                    <Link href={`/deal/${deal.addr}`}>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-white/25 hover:text-white/60">
                        <ExternalLink className="w-3.5 h-3.5" />
                      </Button>
                    </Link>
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
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  const { data: currentFeeRecipient, refetch: refetchFee } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`, abi: DIAMOND_ABI,
    functionName: 'getFeeRecipient',
  }) as { data: string | undefined; refetch: () => void };

  const { data: currentForwarder, refetch: refetchFwd } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`, abi: DIAMOND_ABI,
    functionName: 'getTrustedForwarder',
  }) as { data: string | undefined; refetch: () => void };

  const { data: feeBps, refetch: refetchBps } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`, abi: DIAMOND_ABI, functionName: 'getFeeBps',
  }) as { data: bigint | undefined; refetch: () => void };

  const { data: feeFloor, refetch: refetchFloor } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`, abi: DIAMOND_ABI, functionName: 'getFeeFloor',
  }) as { data: bigint | undefined; refetch: () => void };

  const { data: maxPending, refetch: refetchMaxPending } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`, abi: DIAMOND_ABI, functionName: 'getMaxPendingRequests',
  }) as { data: bigint | undefined; refetch: () => void };

  const [feeRecipient,    setFeeRecipient]    = useState('');
  const [forwarder,       setForwarder]       = useState('');
  const [newBps,        setNewBps]        = useState('');
  const [newFloor,      setNewFloor]      = useState('');
  const [newMaxPending, setNewMaxPending] = useState('');
  const [settingFeeRecipient, setSettingFeeRecipient] = useState(false);
  const [settingForwarder,    setSettingForwarder]    = useState(false);
  // Какой именно параметр комиссии сейчас пишется. Флаг был булев, а кнопок
  // «Set» рядом три (ставка, пол, потолок открытых запросов) — нажатие любой
  // зажигало крутилку на всех трёх сразу. Блокировка остаётся общей: все три
  // пишут в один и тот же FactoryStorage одной подписью владельца.
  const [settingFee,    setSettingFee]    = useState<string | null>(null);

  const handleSetFeeRecipient = async () => {
    if (!isAddress(feeRecipient)) { toast.error('Invalid address'); return; }
    if (!publicClient) { toast.error('Failed'); return; }
    setSettingFeeRecipient(true);
    try {
      const hash = await writeContractAsync({ address: CONTRACTS.diamond as `0x${string}`, abi: DIAMOND_ABI, functionName: 'setFeeRecipient', args: [feeRecipient as `0x${string}`], gas: BigInt(100_000) });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === 'reverted') throw new Error('Transaction reverted on-chain');
      toast.success('Fee recipient updated'); setFeeRecipient(''); refetchFee();
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      toast.error(e?.shortMessage ?? e?.message ?? 'Failed');
    } finally { setSettingFeeRecipient(false); }
  };

  const handleSetForwarder = async () => {
    if (!isAddress(forwarder)) { toast.error('Invalid address'); return; }
    if (!publicClient) { toast.error('Failed'); return; }
    setSettingForwarder(true);
    try {
      const hash = await writeContractAsync({ address: CONTRACTS.diamond as `0x${string}`, abi: DIAMOND_ABI, functionName: 'setTrustedForwarder', args: [forwarder as `0x${string}`], gas: BigInt(100_000) });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === 'reverted') throw new Error('Transaction reverted on-chain');
      toast.success('Forwarder updated'); setForwarder(''); refetchFwd();
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      toast.error(e?.shortMessage ?? e?.message ?? 'Failed');
    } finally { setSettingForwarder(false); }
  };

  /**
   * Гейты ввода повторяют контрактные (FactoryFacet.setFeeBps / setFeeFloor), а не
   * бриф: setFeeBps сам по себе отвергает только `> 2000` (:371-375) — нижнюю границу
   * `bps == 0` контракт проверяет только в одноразовом initFeeModel (:213-221), не
   * здесь. setFeeBps(0) — поддерживаемая и покрытая тестом конфигурация
   * (test/DisputeFee.t.sol:155): quote() продолжает отдавать пол, протокол не
   * становится бесплатным. Запрещать ноль тут означало бы врать администратору о
   * возможностях системы. setFeeFloor ноль отвергает всегда (:377-381).
   */
  const handleSetFeeParam = async (
    fn: 'setFeeBps' | 'setFeeFloor' | 'setMaxPendingRequests',
    raw: string,
    after: () => void,
  ) => {
    const n = parseFloat(raw);
    if (isNaN(n)) { toast.error('Invalid value'); return; }
    if (fn === 'setFeeBps'   && (n < 0 || n > 20))   { toast.error('Rate must be between 0 and 20%'); return; }
    if (fn === 'setFeeFloor' && n <= 0)              { toast.error('Floor must be above 0'); return; }
    if (fn === 'setMaxPendingRequests' && n < 0)     { toast.error('Cap cannot be negative'); return; }
    if (!publicClient) { toast.error('Failed'); return; }

    const arg =
      fn === 'setFeeBps'   ? BigInt(Math.round(n * 100)) :   // проценты → bps
      fn === 'setFeeFloor' ? BigInt(Math.round(n * 1e6)) :   // USDC → 6 decimals
                             BigInt(Math.floor(n));

    setSettingFee(fn);
    try {
      const hash = await writeContractAsync({
        address: CONTRACTS.diamond as `0x${string}`, abi: DIAMOND_ABI,
        functionName: fn, args: [arg], gas: BigInt(100_000),
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === 'reverted') throw new Error('Transaction reverted on-chain');
      toast.success('Updated'); after();
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      toast.error(e?.shortMessage ?? e?.message ?? 'Failed');
    } finally { setSettingFee(null); }
  };

  return (
    <div className="space-y-4">

      {/* Fee Configuration */}
      <Section
        title="Fee Configuration"
        hint="Platform fee is amount-proportional: max(amount × rate, floor). It no longer depends on the posting user's region."
        icon={DollarSign}
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] p-3 text-center">
            <p className="text-xs text-white/35 mb-1">Rate</p>
            <p className="font-mono text-sm font-bold text-white/80">
              {feeBps !== undefined ? `${(Number(feeBps) / 100).toFixed(2)}%` : '…'}
            </p>
          </div>
          <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] p-3 text-center">
            <p className="text-xs text-white/35 mb-1">Floor</p>
            <p className="font-mono text-sm font-bold text-white/80">
              {feeFloor !== undefined ? `$${(Number(feeFloor) / 1e6).toFixed(2)}` : '…'}
            </p>
          </div>
          <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] p-3 text-center">
            <p className="text-xs text-white/35 mb-1">Pending request cap</p>
            <p className="font-mono text-sm font-bold text-white/80">
              {maxPending !== undefined ? (maxPending === 0n ? 'Unlimited' : maxPending.toString()) : '…'}
            </p>
          </div>
        </div>

        <Divider />

        <div className="grid sm:grid-cols-3 gap-4">
          <FieldGroup label="Update rate" hint="Percent of deal amount, 0–20%. Zero switches to a flat fee — every deal pays exactly the floor below, nothing scales with amount.">
            <div className="flex gap-2">
              <Input
                type="number" placeholder="e.g. 5" value={newBps}
                onChange={e => setNewBps(e.target.value)}
                className="font-mono text-sm bg-transparent border-white/[0.08] rounded-[14px]"
              />
              <Button
                onClick={() => handleSetFeeParam('setFeeBps', newBps, () => { setNewBps(''); refetchBps(); })}
                disabled={!!settingFee || !newBps} size="sm" className="shrink-0"
              >
                {settingFee === 'setFeeBps' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Set'}
              </Button>
            </div>
          </FieldGroup>

          <FieldGroup label="Update floor" hint="Minimum fee in USDC. Must be above 0.">
            <div className="flex gap-2">
              <Input
                type="number" placeholder="e.g. 1" value={newFloor}
                onChange={e => setNewFloor(e.target.value)}
                className="font-mono text-sm bg-transparent border-white/[0.08] rounded-[14px]"
              />
              <Button
                onClick={() => handleSetFeeParam('setFeeFloor', newFloor, () => { setNewFloor(''); refetchFloor(); })}
                disabled={!!settingFee || !newFloor} size="sm" className="shrink-0"
              >
                {settingFee === 'setFeeFloor' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Set'}
              </Button>
            </div>
          </FieldGroup>

          <FieldGroup label="Update pending cap" hint="Max open requests per client. 0 = unlimited (intentional, not a typo).">
            <div className="flex gap-2">
              <Input
                type="number" placeholder="0 = unlimited" value={newMaxPending}
                onChange={e => setNewMaxPending(e.target.value)}
                className="font-mono text-sm bg-transparent border-white/[0.08] rounded-[14px]"
              />
              <Button
                onClick={() => handleSetFeeParam('setMaxPendingRequests', newMaxPending, () => { setNewMaxPending(''); refetchMaxPending(); })}
                disabled={!!settingFee || !newMaxPending} size="sm" className="shrink-0"
              >
                {settingFee === 'setMaxPendingRequests' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Set'}
              </Button>
            </div>
          </FieldGroup>
        </div>

        <Divider />

        <p className="text-[11px] text-white/25 leading-relaxed">
          Regional pricing was retired on 28.07.2026 — fee no longer depends on the poster&apos;s region,
          only on the deal amount. The old region getters (<code className="text-white/35">getRegionFee</code>,{' '}
          <code className="text-white/35">getAllFees</code>) and <code className="text-white/35">setRegionFee</code>{' '}
          now revert on every call by design (<code className="text-white/35">FeeNotRegional</code>) — that&apos;s
          expected, not a sign this panel failed to load.
        </p>
      </Section>

      {/* Advanced */}
      <Section title="Advanced" hint="Infrastructure addresses — change only if you redeploy." icon={Settings}>
        <FieldGroup label="Fee recipient" hint="Wallet that receives platform fees from each deal.">
          {currentFeeRecipient && (
            <p className="font-mono text-xs text-white/30 break-all mb-1.5">{currentFeeRecipient}</p>
          )}
          <div className="flex gap-2">
            <Input placeholder="0x…" value={feeRecipient} onChange={e => setFeeRecipient(e.target.value)}
              className="font-mono text-sm bg-transparent border-white/[0.08] rounded-[14px]" />
            <Button onClick={handleSetFeeRecipient} disabled={settingFeeRecipient || !feeRecipient} size="sm">
              {settingFeeRecipient ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Set'}
            </Button>
          </div>
        </FieldGroup>

        <Divider />

        <FieldGroup label="Trusted forwarder" hint="MinimalForwarder contract address for gasless meta-transactions.">
          {currentForwarder && (
            <p className="font-mono text-xs text-white/30 break-all mb-1.5">{currentForwarder}</p>
          )}
          <div className="flex gap-2">
            <Input placeholder="0x…" value={forwarder} onChange={e => setForwarder(e.target.value)}
              className="font-mono text-sm bg-transparent border-white/[0.08] rounded-[14px]" />
            <Button onClick={handleSetForwarder} disabled={settingForwarder || !forwarder} size="sm">
              {settingForwarder ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Set'}
            </Button>
          </div>
        </FieldGroup>
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
    address: CONTRACTS.diamond as `0x${string}`, abi: DIAMOND_ABI, functionName: 'owner',
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
      <PageCenter>
        <Loader2 className="w-6 h-6 animate-spin text-white/30" />
      </PageCenter>
    );
  }

  if (!isConnected || !isOwner) {
    return (
      <PageCenter>
        <div className="max-w-sm w-full text-center space-y-4">
          <div className="w-14 h-14 rounded-[18px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center mx-auto">
            <Shield className="w-6 h-6 text-white/30" />
          </div>
          <h2 className="font-syne font-bold text-xl">
            {!isConnected ? 'Connect wallet' : 'Access denied'}
          </h2>
          <p className="text-sm text-white/40">
            {!isConnected ? 'Owner wallet required.' : 'Only the contract owner can access this page.'}
          </p>
          <Link href={isConnected ? '/dashboard' : '/'}>
            <Button variant="outline" className="mt-2 border-white/15 text-white/50">← Go back</Button>
          </Link>
        </div>
      </PageCenter>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">

      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-syne font-bold text-2xl">Admin</h1>
          <p className="text-xs text-white/30 font-mono mt-0.5">{address}</p>
        </div>
        <div className="w-9 h-9 rounded-[12px] bg-primary/10 border border-primary/20 flex items-center justify-center">
          <Shield className="w-4 h-4 text-primary" />
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 p-1 rounded-[18px] bg-white/[0.03] border border-white/[0.06]">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-[12px] text-sm font-medium transition-all duration-150",
              tab === id ? "bg-white/[0.08] text-white" : "text-white/35 hover:text-white/60"
            )}
          >
            <Icon className="w-3.5 h-3.5 shrink-0" />
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
  );
}
