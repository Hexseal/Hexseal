'use client';

import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useIsMounted } from '@/hooks/useIsMounted';
import { DIAMOND_ABI, ARBITER_REGISTRY_ABI, SERVICE_BOARD_ABI, CONTRACTS } from '@/config/contracts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { toast } from 'react-hot-toast';
import { Loader2, PauseCircle, PlayCircle, DollarSign, Settings, Users, FileText, Shield, UserCog, MessageCircle, AlertTriangle, UserPlus, UserMinus, List, Search, ExternalLink, Crown } from 'lucide-react';
import { isAddress, parseAbi } from 'viem';
import { usePublicClient } from 'wagmi';

const AGREEMENT_ABI_MINI = parseAbi([
  'function getDetails() view returns (address client_, address executor_, address arbiter_, uint256 amount_, bytes32 termsHash_, uint256 deadlineDays_, uint256 fundedAt_, uint256 activatedAt_, uint256 markedDoneAt_, uint256 disputedAt_, uint256 resolvedAt_, uint8 status_)',
]);

export default function AdminPage() {
  const { isConnected, address } = useAccount();
  const [isChecking, setIsChecking] = useState(true);
  const [isOwner, setIsOwner] = useState(false);
  const isMounted = useIsMounted();

  const { data: ownerAddress } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'owner',
  });

  useEffect(() => {
    if (isMounted && !isConnected) {
      setIsChecking(false);
    }
    if (ownerAddress && address) {
      setIsOwner(String(ownerAddress).toLowerCase() === String(address).toLowerCase());
      setIsChecking(false);
    }
  }, [address, isConnected, isMounted, ownerAddress]);

  if (!isMounted || isChecking) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>
    );
  }

  if (!isConnected) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md text-center">
          <CardHeader><CardTitle className="font-mono">Connect Wallet</CardTitle></CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-4">Owner access required</p>
            <Button variant="outline" asChild><Link href="/">Home</Link></Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!isOwner) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md text-center">
          <CardHeader><CardTitle className="font-mono">Access Denied</CardTitle></CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-4">Only the contract owner can access this page</p>
            <Button variant="outline" asChild><Link href="/dashboard">Dashboard</Link></Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-10 space-y-8">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-mono">Admin Panel</h1>
          {address && (
            <div className="text-sm font-mono border px-3 py-1 rounded">
              {`${address.slice(0, 6)}...${address.slice(-4)}`}
            </div>
          )}
        </div>

        {/* Stats Grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <AdminStatsCard />
          <AdminActiveCard />
          <AdminVolumeCard />
          <AdminStatusCard />
        </div>

        {/* Controls */}
        <div className="grid gap-6 md:grid-cols-2">
          <AdminFeesCard />
          <AdminPauseCard />
        </div>

        {/* Protocol Arbiter (single, auto-assigned) */}
        <AdminArbiterCard />

        {/* Arbiter Registry (multi-arbiter list) */}
        <AdminArbiterRegistryCard />

        {/* Arbiter Archive — who resolved what */}
        <AdminArbiterArchiveCard />

        {/* Arbitration Threshold */}
        <AdminThresholdCard />

        {/* Advanced Settings */}
        <AdminSettingsCard />

        {/* Dispute Lookup */}
        <AdminDisputeLookupCard />

        {/* Platform Activity */}
        <PlatformActivitySection />
      </main>
    </div>
  );
}

function AdminStatsCard() {
  const { data: total } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'totalAgreements',
  }) as { data: bigint | undefined };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-mono text-muted-foreground flex items-center gap-2">
          <FileText className="w-4 h-4" />
          Total Agreements
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold font-mono">{total ? total.toString() : '—'}</div>
      </CardContent>
    </Card>
  );
}

function AdminActiveCard() {
  const { data: active } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'getActive',
  }) as { data: any[] | undefined };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-mono text-muted-foreground flex items-center gap-2">
          <Users className="w-4 h-4" />
          Active Deals
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold font-mono">{active ? active.length : '—'}</div>
      </CardContent>
    </Card>
  );
}

function AdminVolumeCard() {
  const { data: active } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'getActive',
  }) as { data: any[] | undefined };

  const totalVolume = active
    ? active.reduce((sum, a) => sum + Number(a.amount), 0)
    : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-mono text-muted-foreground flex items-center gap-2">
          <DollarSign className="w-4 h-4" />
          Active Volume
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold font-mono">${(totalVolume / 1e6).toFixed(2)}</div>
      </CardContent>
    </Card>
  );
}

function AdminStatusCard() {
  const { data: isPaused } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'isPaused',
  }) as { data: boolean | undefined };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-mono text-muted-foreground flex items-center gap-2">
          <Shield className="w-4 h-4" />
          Factory Status
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Badge variant={isPaused ? 'destructive' : 'default'} className="text-sm">
          {isPaused ? 'Paused' : 'Active'}
        </Badge>
      </CardContent>
    </Card>
  );
}

function AdminFeesCard() {
  const { data: fees, refetch } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'getAllFees',
  }) as { data: [bigint, bigint, bigint, bigint] | undefined; refetch: () => void };

  const { writeContract, isPending } = useWriteContract();
  const [newFee, setNewFee] = useState('');
  const [selectedRegion, setSelectedRegion] = useState(0);

  const handleSetFee = async () => {
    if (!newFee || parseFloat(newFee) <= 0) {
      toast.error('Invalid fee amount');
      return;
    }
    try {
      await writeContract({
        address: CONTRACTS.diamond as `0x${string}`,
        abi: DIAMOND_ABI,
        functionName: 'setRegionFee',
        args: [selectedRegion, BigInt(Math.floor(parseFloat(newFee) * 1e6))],
        gas: BigInt(100000),
      });
      toast.success('Fee updated');
      setNewFee('');
      refetch();
    } catch (err: any) {
      toast.error(err?.shortMessage || 'Failed');
    }
  };

  const regions = [
    { idx: 0, name: 'CIS (СНГ)', fee: fees ? fees[0] : undefined },
    { idx: 1, name: 'Asia/LatAm', fee: fees ? fees[1] : undefined },
    { idx: 2, name: 'Europe', fee: fees ? fees[2] : undefined },
    { idx: 3, name: 'US/Canada', fee: fees ? fees[3] : undefined },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono flex items-center gap-2">
          <DollarSign className="w-5 h-5" />
          PPP Fees
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {regions.map((r) => (
          <div key={r.idx} className="flex justify-between items-center">
            <span className="text-sm">{r.name}</span>
            <span className="font-mono">{r.fee ? (Number(r.fee) / 1e6).toFixed(2) : '—'} USDC</span>
          </div>
        ))}
        <Separator />
        <div className="space-y-2">
          <Label>Update Fee</Label>
          <div className="flex gap-2">
            <select
              aria-label="Select region"
              value={selectedRegion}
              onChange={(e) => setSelectedRegion(Number(e.target.value))}
              className="px-3 py-2 border rounded-md bg-background"
            >
              {regions.map((r) => (
                <option key={r.idx} value={r.idx}>{r.name}</option>
              ))}
            </select>
            <Input type="number" placeholder="USDC" value={newFee} onChange={(e) => setNewFee(e.target.value)} className="flex-1" />
            <Button onClick={handleSetFee} disabled={isPending || !newFee}>
              {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Update'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AdminPauseCard() {
  const { data: isPaused, refetch } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'isPaused',
  }) as { data: boolean | undefined; refetch: () => void };

  const { writeContract, isPending } = useWriteContract();

  const handleToggle = async () => {
    try {
      await writeContract({
        address: CONTRACTS.diamond as `0x${string}`,
        abi: DIAMOND_ABI,
        functionName: 'setPaused',
        args: [!isPaused],
        gas: BigInt(80000),
      });
      toast.success(isPaused ? 'Factory unpaused' : 'Factory paused');
      refetch();
    } catch (err: any) {
      toast.error(err?.shortMessage || 'Failed');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono flex items-center gap-2">
          {isPaused ? <PlayCircle className="w-5 h-5" /> : <PauseCircle className="w-5 h-5" />}
          Factory Control
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex justify-between items-center">
          <span className="text-muted-foreground">Status</span>
          <Badge variant={isPaused ? 'destructive' : 'default'}>{isPaused ? 'Paused' : 'Active'}</Badge>
        </div>
        <Button variant={isPaused ? 'default' : 'destructive'} onClick={handleToggle} disabled={isPending} className="w-full">
          {isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          {isPaused ? 'Unpause' : 'Pause'}
        </Button>
      </CardContent>
    </Card>
  );
}

function AdminSettingsCard() {
  const { writeContract, isPending } = useWriteContract();
  const [feeRecipient, setFeeRecipient] = useState('');
  const [forwarder, setForwarder] = useState('');

  const { data: currentFeeRecipient, refetch: refetchFeeRecipient } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'getFeeRecipient',
  }) as { data: string | undefined; refetch: () => void };

  const { data: currentForwarder, refetch: refetchForwarder } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'getTrustedForwarder',
  }) as { data: string | undefined; refetch: () => void };

  const handleSetFeeRecipient = async () => {
    if (!isAddress(feeRecipient)) { toast.error('Invalid address'); return; }
    try {
      await writeContract({
        address: CONTRACTS.diamond as `0x${string}`,
        abi: DIAMOND_ABI,
        functionName: 'setFeeRecipient',
        args: [feeRecipient as `0x${string}`],
        gas: BigInt(100000),
      });
      toast.success('Fee recipient updated');
      setFeeRecipient('');
      refetchFeeRecipient();
    } catch (err: any) {
      toast.error(err?.shortMessage || 'Failed');
    }
  };

  const handleSetForwarder = async () => {
    if (!isAddress(forwarder)) { toast.error('Invalid address'); return; }
    try {
      await writeContract({
        address: CONTRACTS.diamond as `0x${string}`,
        abi: DIAMOND_ABI,
        functionName: 'setTrustedForwarder',
        args: [forwarder as `0x${string}`],
        gas: BigInt(100000),
      });
      toast.success('Forwarder updated');
      setForwarder('');
      refetchForwarder();
    } catch (err: any) {
      toast.error(err?.shortMessage || 'Failed');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono flex items-center gap-2">
          <Settings className="w-5 h-5" />
          Advanced Settings
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label>Fee Recipient</Label>
          {currentFeeRecipient && (
            <p className="text-xs font-mono text-muted-foreground break-all">{currentFeeRecipient}</p>
          )}
          <div className="flex gap-2">
            <Input placeholder="0x..." value={feeRecipient} onChange={(e) => setFeeRecipient(e.target.value)} />
            <Button onClick={handleSetFeeRecipient} disabled={isPending || !feeRecipient}>Set</Button>
          </div>
        </div>
        <Separator />
        <div className="space-y-2">
          <Label>Trusted Forwarder</Label>
          {currentForwarder && (
            <p className="text-xs font-mono text-muted-foreground break-all">{currentForwarder}</p>
          )}
          <div className="flex gap-2">
            <Input placeholder="0x..." value={forwarder} onChange={(e) => setForwarder(e.target.value)} />
            <Button onClick={handleSetForwarder} disabled={isPending || !forwarder}>Set</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AdminArbiterCard() {
  const { data: arbiter, refetch } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'getProtocolArbiter',
  }) as { data: `0x${string}` | undefined; refetch: () => void };

  const { writeContract, isPending } = useWriteContract();
  const [arbiterAddress, setArbiterAddress] = useState('');

  const handleSetArbiter = async () => {
    try {
      await writeContract({
        address: CONTRACTS.diamond as `0x${string}`,
        abi: DIAMOND_ABI,
        functionName: 'setProtocolArbiter',
        args: [(arbiterAddress || '0x0000000000000000000000000000000000000000') as `0x${string}`],
        gas: BigInt(100000),
      });
      toast.success(arbiterAddress ? 'Arbiter updated' : 'Arbiter removed (timer-only mode)');
      setArbiterAddress('');
      refetch();
    } catch (err: any) {
      toast.error(err?.shortMessage || 'Failed');
    }
  };

  const isTimerOnly = !arbiter || arbiter === '0x0000000000000000000000000000000000000000';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono flex items-center gap-2">
          <UserCog className="w-5 h-5" />
          Protocol Arbiter
        </CardTitle>
        <CardDescription>
          {isTimerOnly
            ? 'Timer-only mode — no human arbiter'
            : `Current arbiter: ${arbiter?.slice(0, 6)}...${arbiter?.slice(-4)}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex justify-between items-center">
          <span className="text-muted-foreground">Mode</span>
          <Badge variant={isTimerOnly ? 'secondary' : 'default'}>
            {isTimerOnly ? 'Timer-only' : 'Human Arbiter'}
          </Badge>
        </div>
        <Separator />
        <div className="space-y-2">
          <Label>Set Arbiter Address</Label>
          <p className="text-xs text-muted-foreground">
            Enter address or leave empty for timer-only mode
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="0x... or empty for timer-only"
              value={arbiterAddress}
              onChange={(e) => setArbiterAddress(e.target.value)}
            />
            <Button onClick={handleSetArbiter} disabled={isPending}>
              {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Set'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const ARCHIVE_STATUS_LABELS: Record<number, { label: string; cls: string }> = {
  3: { label: 'Completed',       cls: 'border-green-500/30 text-green-400' },
  5: { label: 'Executor paid',   cls: 'border-violet-500/30 text-violet-400' },
  6: { label: 'Client refunded', cls: 'border-blue-500/30 text-blue-400' },
};

const shortA = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

interface FlatDeal {
  addr: string; arbiter: string; client: string; executor: string;
  amount: bigint; status: number; resolvedAt: bigint;
}

function AdminArbiterArchiveCard() {
  const publicClient = usePublicClient();

  const { data: arbiters } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: ARBITER_REGISTRY_ABI,
    functionName: 'getArbiters',
  }) as { data: `0x${string}`[] | undefined };

  const [allDeals, setAllDeals] = useState<FlatDeal[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [loaded,   setLoaded]   = useState(false);
  const [search,   setSearch]   = useState('');

  useEffect(() => {
    if (!arbiters?.length || !publicClient || loading || loaded) return;
    setLoading(true);
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
            publicClient.readContract({
              address: addr as `0x${string}`,
              abi: AGREEMENT_ABI_MINI,
              functionName: 'getDetails',
            }).then((r: any) => ({
              addr, arbiter,
              client:     r[0] as string,
              executor:   r[1] as string,
              amount:     r[3] as bigint,
              resolvedAt: r[10] as bigint,
              status:     Number(r[11]),
            } satisfies FlatDeal)).catch(() => null)
          ));
          flat.push(...(details.filter(Boolean) as FlatDeal[]));
        } catch {}
      }
      flat.sort((a, b) => Number(b.resolvedAt - a.resolvedAt));
      setAllDeals(flat);
    })().finally(() => { setLoading(false); setLoaded(true); });
  }, [arbiters, publicClient, loading, loaded]);

  const filtered = allDeals.filter(d => {
    if (!search) return true;
    const q = search.toLowerCase();
    return d.addr.toLowerCase().includes(q)     ||
      d.arbiter.toLowerCase().includes(q)        ||
      d.client.toLowerCase().includes(q)         ||
      d.executor.toLowerCase().includes(q);
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono flex items-center gap-2">
          <Shield className="w-5 h-5" />
          Arbiter Archive
        </CardTitle>
        <CardDescription>
          All resolved disputes — search by deal, arbiter, client or executor address
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" />
          <Input
            placeholder="Search by deal, arbiter, client or executor address…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 font-mono text-sm bg-white/[0.03] border-white/10 placeholder:text-white/25"
          />
        </div>

        {(!arbiters || loading) ? (
          <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-white/30" /></div>
        ) : allDeals.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No resolved disputes yet</p>
        ) : (
          <>
            <p className="text-xs text-white/30 font-mono">
              {filtered.length === allDeals.length
                ? `${allDeals.length} case${allDeals.length !== 1 ? 's' : ''}`
                : `${filtered.length} of ${allDeals.length} cases`}
            </p>
            <div className="space-y-1.5">
              {filtered.map(deal => {
                const st = ARCHIVE_STATUS_LABELS[deal.status];
                return (
                  <div key={deal.addr} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="font-mono text-xs text-white/70">{shortA(deal.addr)}</span>
                        {st ? (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${st.cls}`}>{st.label}</span>
                        ) : (
                          <span className="text-[10px] text-white/30">Status {deal.status}</span>
                        )}
                        {deal.resolvedAt > 0n && (
                          <span className="text-[10px] text-white/25 font-mono">
                            {new Date(Number(deal.resolvedAt) * 1000).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2.5 text-[11px] text-white/35 flex-wrap">
                        <span>Arbiter: <span className="font-mono text-white/50">{shortA(deal.arbiter)}</span></span>
                        <span>C: <span className="font-mono">{shortA(deal.client)}</span></span>
                        <span>E: <span className="font-mono">{shortA(deal.executor)}</span></span>
                        <span className="font-mono text-white/45">${(Number(deal.amount) / 1e6).toFixed(2)} USDC</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Link href={`/chat/${deal.client.toLowerCase()}`}>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-white/30 hover:text-primary">
                          <MessageCircle className="w-3.5 h-3.5" />
                        </Button>
                      </Link>
                      <Link href={`/deal/${deal.addr}`}>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-white/30 hover:text-white/70">
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
      </CardContent>
    </Card>
  );
}

function AdminThresholdCard() {
  const { data: threshold, refetch } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'getArbitrationThreshold',
  }) as { data: bigint | undefined; refetch: () => void };

  const { writeContract, isPending } = useWriteContract();
  const [thresholdValue, setThresholdValue] = useState('');

  const handleSetThreshold = async () => {
    try {
      const value = parseFloat(thresholdValue);
      if (isNaN(value) || value < 0) {
        toast.error('Invalid threshold value');
        return;
      }
      await writeContract({
        address: CONTRACTS.diamond as `0x${string}`,
        abi: DIAMOND_ABI,
        functionName: 'setArbitrationThreshold',
        args: [BigInt(Math.floor(value * 1e6))],
        gas: BigInt(100000),
      });
      toast.success('Arbitration threshold updated');
      setThresholdValue('');
      refetch();
    } catch (err: any) {
      toast.error(err?.shortMessage || 'Failed');
    }
  };

  const currentThreshold = threshold ? (Number(threshold) / 1e6).toFixed(2) : '—';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono flex items-center gap-2">
          <Shield className="w-5 h-5" />
          Arbitration Threshold
        </CardTitle>
        <CardDescription>
          Deals at or above this amount use protocol arbiter. Below = timer-only mode.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex justify-between items-center">
          <span className="text-muted-foreground">Current Threshold</span>
          <Badge variant="default">{currentThreshold} USDC</Badge>
        </div>
        <Separator />
        <div className="space-y-2">
          <Label>Set New Threshold (USDC)</Label>
          <p className="text-xs text-muted-foreground">
            Default: 10 USDC. Set to 0 for timer-only on all deals.
          </p>
          <div className="flex gap-2">
            <Input
              type="number"
              placeholder="10"
              value={thresholdValue}
              onChange={(e) => setThresholdValue(e.target.value)}
            />
            <Button onClick={handleSetThreshold} disabled={isPending || !thresholdValue}>
              {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Set'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AdminArbiterRegistryCard() {
  const { data: arbiters, refetch } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: ARBITER_REGISTRY_ABI,
    functionName: 'getArbiters',
  }) as { data: `0x${string}`[] | undefined; refetch: () => void };

  const { data: chiefArbiterRaw, refetch: refetchChief } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: ARBITER_REGISTRY_ABI,
    functionName: 'getChiefArbiter',
  }) as { data: string | undefined; refetch: () => void };

  const ZERO = '0x0000000000000000000000000000000000000000';
  const chiefArbiter = chiefArbiterRaw && chiefArbiterRaw !== ZERO ? chiefArbiterRaw.toLowerCase() : null;

  const { writeContract, isPending } = useWriteContract();
  const [newArbiter,  setNewArbiter]  = useState('');
  const [newChief,    setNewChief]    = useState('');
  const [removingAddr, setRemovingAddr] = useState<string | null>(null);
  const [settingChief, setSettingChief] = useState(false);

  const handleAdd = async () => {
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
      refetch();
    } catch (err: any) { toast.error(err?.shortMessage || 'Failed'); }
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
      refetch();
    } catch (err: any) { toast.error(err?.shortMessage || 'Failed'); }
    finally { setRemovingAddr(null); }
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
    } catch (err: any) { toast.error(err?.shortMessage || 'Failed'); }
    finally { setSettingChief(false); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono flex items-center gap-2">
          <List className="w-5 h-5" />
          Arbiter Registry
        </CardTitle>
        <CardDescription>
          Owner and chief arbiter can add/remove arbiters
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Arbiter list */}
        {!arbiters || arbiters.length === 0 ? (
          <p className="text-sm text-muted-foreground">No arbiters registered yet.</p>
        ) : (
          <div className="space-y-2">
            {arbiters.map((addr) => {
              const isChief = addr.toLowerCase() === chiefArbiter;
              return (
                <div key={addr} className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 ${isChief ? 'border-amber-500/25 bg-amber-500/5' : ''}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    {isChief && <Crown className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />}
                    <span className="font-mono text-xs text-white/70 truncate">{addr}</span>
                    {isChief && (
                      <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-500/30 shrink-0">Chief</Badge>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 shrink-0"
                    disabled={removingAddr === addr || isPending}
                    onClick={() => handleRemove(addr)}
                  >
                    {removingAddr === addr ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserMinus className="w-3.5 h-3.5" />}
                    Remove
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        <Separator />

        {/* Add arbiter */}
        <div className="space-y-2">
          <Label>Add Arbiter</Label>
          <div className="flex gap-2">
            <Input
              placeholder="0x..."
              value={newArbiter}
              onChange={(e) => setNewArbiter(e.target.value)}
              className="font-mono text-sm"
            />
            <Button onClick={handleAdd} disabled={isPending || !newArbiter} className="gap-1">
              {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
              Add
            </Button>
          </div>
        </div>

        <Separator />

        {/* Chief arbiter */}
        <div className="space-y-2">
          <Label className="flex items-center gap-1.5">
            <Crown className="w-3.5 h-3.5 text-amber-400" />
            Chief Arbiter
          </Label>
          <p className="text-xs text-muted-foreground">
            Trusted role that can add/remove arbiters. Set to 0x000…000 to clear.
          </p>
          {chiefArbiter ? (
            <div className="flex items-center gap-2 rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2">
              <Crown className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
              <span className="font-mono text-xs text-white/70 truncate flex-1">{chiefArbiterRaw}</span>
            </div>
          ) : (
            <p className="text-xs text-white/35 font-mono">Not set</p>
          )}
          <div className="flex gap-2">
            <Input
              placeholder="0x... (empty = clear)"
              value={newChief}
              onChange={(e) => setNewChief(e.target.value)}
              className="font-mono text-sm"
            />
            <Button
              onClick={handleSetChief}
              disabled={settingChief}
              variant="outline"
              className="gap-1 border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
            >
              {settingChief ? <Loader2 className="w-4 h-4 animate-spin" /> : <Crown className="w-4 h-4" />}
              Set
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const DISPUTE_STATUS_LABELS: Record<number, string> = {
  0: 'Created', 1: 'Funded', 2: 'Active', 3: 'Completed', 4: 'Disputed', 5: 'Resolved', 6: 'Refunded',
};

function AdminDisputeLookupCard() {
  const [dealAddr, setDealAddr] = useState('');
  const [lookupAddr, setLookupAddr] = useState('');
  const [details, setDetails] = useState<{
    client: string; executor: string; arbiter: string; status: number; disputedAt: bigint;
  } | null>(null);
  const [isLooking, setIsLooking] = useState(false);
  const publicClient = usePublicClient();

  const handleLookup = async () => {
    if (!publicClient || !isAddress(dealAddr)) {
      toast.error('Enter a valid agreement address');
      return;
    }
    setIsLooking(true);
    setDetails(null);
    try {
      const result = await publicClient.readContract({
        address: dealAddr as `0x${string}`,
        abi: AGREEMENT_ABI_MINI,
        functionName: 'getDetails',
      }) as unknown as [string, string, string, bigint, string, bigint, bigint, bigint, bigint, bigint, bigint, number];
      // [client_, executor_, arbiter_, amount_, termsHash_, deadlineDays_, fundedAt_, activatedAt_, markedDoneAt_, disputedAt_, resolvedAt_, status_]
      setLookupAddr(dealAddr);
      setDetails({
        client: result[0],
        executor: result[1],
        arbiter: result[2],
        status: result[11],
        disputedAt: result[9],
      });
    } catch {
      toast.error('Failed to fetch deal — check address');
    } finally {
      setIsLooking(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-red-400" />
          Dispute Lookup
        </CardTitle>
        <CardDescription>Enter an agreement address to view parties and join their chats</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            placeholder="0x... agreement address"
            value={dealAddr}
            onChange={(e) => setDealAddr(e.target.value)}
            className="font-mono text-sm"
          />
          <Button onClick={handleLookup} disabled={isLooking || !dealAddr}>
            {isLooking ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Lookup'}
          </Button>
        </div>

        {details && (
          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/40">Status:</span>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                details.status === 4 ? 'bg-red-500/20 text-red-400' : 'bg-white/10 text-white/60'
              }`}>
                {DISPUTE_STATUS_LABELS[details.status] ?? String(details.status)}
              </span>
              {details.status === 4 && details.disputedAt > 0n && (
                <span className="text-xs text-white/30">
                  since {new Date(Number(details.disputedAt) * 1000).toLocaleString()}
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 gap-2">
              {([
                { label: 'Client', addr: details.client },
                { label: 'Executor', addr: details.executor },
                ...(details.arbiter !== '0x0000000000000000000000000000000000000000'
                  ? [{ label: 'Arbiter', addr: details.arbiter }]
                  : []),
              ] as { label: string; addr: string }[]).map(({ label, addr }) => (
                <div key={label} className="flex items-center justify-between gap-3">
                  <div>
                    <span className="text-xs text-white/40">{label}: </span>
                    <span className="font-mono text-xs text-white/70">{addr}</span>
                  </div>
                  <Link href={`/chat/${addr.toLowerCase()}`}>
                    <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs text-white/40 hover:text-primary">
                      <MessageCircle className="w-3.5 h-3.5" />
                      Chat
                    </Button>
                  </Link>
                </div>
              ))}
            </div>
            <div className="pt-2">
              <Link href={`/deal/${lookupAddr}`} className="text-xs text-primary hover:underline">
                → Open deal page
              </Link>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Platform Activity Stats ───────────────────────────────────────────────

interface PlatformStats {
  totalDeals: number;
  totalJobs: number;
  totalServices: number;
  totalDisputes: number;
  resolvedDisputes: number;
  completedDeals: number;
  refundedDeals: number;
  totalRevenue: bigint;
}

function PlatformActivitySection() {
  const publicClient = usePublicClient();
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;

    const fetch = async () => {
      setLoading(true);
      try {
        const diamond = CONTRACTS.diamond;

        const statusUpdatedEvent = { anonymous: false, inputs: [{ indexed: true, name: 'agreement', type: 'address' }, { indexed: false, name: 'newStatus', type: 'uint8' }], name: 'AgreementStatusUpdated', type: 'event' } as const;

        const [dealLogs, jobLogs, serviceLogs, statusLogs, revenueLogs] = await Promise.all([
          publicClient.getLogs({ address: diamond, event: { anonymous: false, inputs: [{ indexed: true, name: 'agreement', type: 'address' }, { indexed: true, name: 'client', type: 'address' }, { indexed: true, name: 'executor', type: 'address' }, { indexed: false, name: 'amount', type: 'uint256' }], name: 'AgreementRegistered', type: 'event' } as const, fromBlock: BigInt(0), toBlock: 'latest' }),
          publicClient.getLogs({ address: diamond, event: { anonymous: false, inputs: [{ indexed: true, name: 'jobId', type: 'uint256' }, { indexed: true, name: 'client', type: 'address' }, { indexed: false, name: 'amount', type: 'uint256' }, { indexed: false, name: 'region', type: 'uint8' }], name: 'JobPosted', type: 'event' } as const, fromBlock: BigInt(0), toBlock: 'latest' }),
          publicClient.getLogs({ address: diamond, event: SERVICE_BOARD_ABI[0], fromBlock: BigInt(0), toBlock: 'latest' }),
          publicClient.getLogs({ address: diamond, event: statusUpdatedEvent, fromBlock: BigInt(0), toBlock: 'latest' }),
          publicClient.getLogs({ address: diamond, event: { anonymous: false, inputs: [{ indexed: true, name: 'agreement', type: 'address' }, { indexed: true, name: 'client', type: 'address' }, { indexed: true, name: 'executor', type: 'address' }, { indexed: false, name: 'amount', type: 'uint256' }, { indexed: false, name: 'region', type: 'uint8' }, { indexed: false, name: 'fee', type: 'uint256' }], name: 'AgreementDeployed', type: 'event' } as const, fromBlock: BigInt(0), toBlock: 'latest' }),
        ]);

        if (cancelled) return;

        // newStatus is not indexed — filter decoded args in JS
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const byStatus = (status: number) =>
          (statusLogs as any[]).filter((l) => Number(l.args?.newStatus) === status).length;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const totalRevenue = (revenueLogs as any[]).reduce(
          (sum: bigint, l) => sum + (l.args?.fee ?? BigInt(0)),
          BigInt(0)
        );

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
    };

    fetch();
    return () => { cancelled = true; };
  }, [publicClient]);

  const statItems = stats
    ? [
        { label: 'Total Deals', value: stats.totalDeals, icon: '🤝' },
        { label: 'Jobs Posted', value: stats.totalJobs, icon: '📋' },
        { label: 'Services Listed', value: stats.totalServices, icon: '🛠️' },
        { label: 'Completed', value: stats.completedDeals, icon: '✅' },
        { label: 'Disputes', value: stats.totalDisputes, icon: '⚠️' },
        { label: 'Resolved', value: stats.resolvedDisputes, icon: '⚖️' },
        { label: 'Refunded', value: stats.refundedDeals, icon: '↩️' },
        { label: 'Revenue', value: `$${(Number(stats.totalRevenue) / 1e6).toFixed(2)}`, icon: '💰' },
      ]
    : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-mono text-sm text-muted-foreground">
          <List className="w-4 h-4" />
          Platform Activity (All Time)
        </CardTitle>
        <CardDescription>On-chain event counts — fetched live from Base Sepolia</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Fetching on-chain data...
          </div>
        ) : !stats ? (
          <p className="text-sm text-muted-foreground">Failed to load stats</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {statItems.map(({ label, value, icon }) => (
              <div key={label} className="flex flex-col gap-1 p-3 rounded-lg bg-white/[0.03] border border-white/5">
                <span className="text-lg">{icon}</span>
                <span className="text-2xl font-bold font-mono">{value}</span>
                <span className="text-xs text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
