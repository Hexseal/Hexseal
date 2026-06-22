'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useReadContract, useReadContracts, useWalletClient, usePublicClient } from 'wagmi';
import type { Abi } from 'viem';
import { parseAbiItem } from 'viem';
import { DIAMOND_ABI, JOB_RECEIPT_FACET_ABI, CONTRACTS } from '@/config/contracts';
import { sendGasless } from '@/lib/relay';
import { Button } from '@/components/ui/button';
import { toast } from 'react-hot-toast';
import {
  Briefcase, ChevronDown, ExternalLink, Clock,
  CheckCircle, XCircle, Users, Zap, Loader2, UserCheck, Trash2,
  Pause, Play, Inbox, AlertCircle, Pencil,
} from 'lucide-react';

const REGION_LABELS: Record<number, string> = {
  0: 'CIS', 1: 'Asia', 2: 'Europe', 3: 'US', 4: 'LATAM', 5: 'CA', 6: 'AU',
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface ServiceRecord {
  executor: string;
  title: string;
  description: string;
  price: bigint;
  deadlineDays: bigint;
  region: number;
  status: number; // 0=ACTIVE 1=PAUSED 2=REMOVED
  createdAt: bigint;
  hiresCount: bigint;
}

interface HireRequestRecord {
  client: string;
  serviceId: bigint;
  amount: bigint;
  deadlineDays: bigint;
  termsHash: string;
  region: number;
  status: number; // 0=PENDING 1=ACCEPTED 2=REJECTED 3=CANCELLED
  createdAt: bigint;
  agreement: string;
}

interface JobRecord {
  client: string;
  title: string;
  description: string;
  amount: bigint;
  deadlineDays: bigint;
  termsHash: string;
  region: number;
  status: number; // 0=OPEN 1=ACCEPTED 2=CANCELLED
  createdAt: bigint;
  chosenExecutor: string;
  agreement: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(amount: bigint) {
  return (Number(amount) / 1e6).toFixed(2);
}
function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

const SERVICE_STATUS: Record<number, { label: string; icon: React.ReactNode; cls: string; dot: string; textCls: string }> = {
  0: { label: 'Active',  icon: <Zap className="w-3 h-3" />,     cls: 'bg-emerald-400/10 text-emerald-400 border-emerald-400/20', dot: 'bg-emerald-400',   textCls: 'text-emerald-400/80' },
  1: { label: 'Paused',  icon: <Pause className="w-3 h-3" />,   cls: 'bg-amber-400/10 text-amber-400 border-amber-400/20',      dot: 'bg-amber-400',     textCls: 'text-amber-400/80' },
  2: { label: 'Removed', icon: <XCircle className="w-3 h-3" />, cls: 'bg-white/5 text-white/40 border-white/10',               dot: 'bg-white/[0.15]',  textCls: 'text-white/30' },
};

const REQUEST_STATUS: Record<number, { label: string; cls: string }> = {
  0: { label: 'Pending',   cls: 'bg-sky-400/10 text-sky-400 border-sky-400/20' },
  1: { label: 'Accepted',  cls: 'bg-green-400/10 text-green-400 border-green-400/20' },
  2: { label: 'Rejected',  cls: 'bg-red-400/10 text-red-400 border-red-400/20' },
  3: { label: 'Cancelled', cls: 'bg-white/5 text-white/40 border-white/10' },
};

const JOB_STATUS: Record<number, { label: string; icon: React.ReactNode; cls: string; dot: string; textCls: string }> = {
  0: { label: 'Open',      icon: <Clock className="w-3 h-3" />,       cls: 'bg-sky-400/10 text-sky-400 border-sky-400/20',       dot: 'bg-emerald-400',   textCls: 'text-emerald-400/80' },
  1: { label: 'Accepted',  icon: <CheckCircle className="w-3 h-3" />, cls: 'bg-green-400/10 text-green-400 border-green-400/20', dot: 'bg-violet-400',    textCls: 'text-violet-400/80' },
  2: { label: 'Cancelled', icon: <XCircle className="w-3 h-3" />,     cls: 'bg-white/5 text-white/40 border-white/10',          dot: 'bg-white/[0.15]',  textCls: 'text-white/30' },
};

// ── Edit Listing Modal ──────────────────────────────────────────────────────
// Shared by jobs and services. `kind` switches the amount field:
//   service → price is editable
//   job     → amount is locked (funds already escrowed); shown disabled

export interface EditTarget {
  kind: 'job' | 'service';
  id: bigint;
  title: string;
  description: string;
  amount: bigint;        // job budget OR service price
  deadlineDays: bigint;
  region: number;
  termsHash?: string;    // job only — passed through unchanged
}

function EditListingModal({
  target, busy, onClose, onSave,
}: {
  target: EditTarget;
  busy: boolean;
  onClose: () => void;
  onSave: (fields: { title: string; description: string; price: bigint; deadlineDays: bigint; region: number }) => void;
}) {
  const [title, setTitle]             = useState(target.title);
  const [description, setDescription] = useState(target.description);
  const [priceStr, setPriceStr]       = useState((Number(target.amount) / 1e6).toString());
  const [deadlineStr, setDeadlineStr] = useState(target.deadlineDays.toString());
  const [region, setRegion]           = useState(target.region);
  const [err, setErr]                 = useState<string | null>(null);

  const isService = target.kind === 'service';

  const submit = () => {
    const t = title.trim();
    if (!t || t.length > 100) { setErr('Заголовок обязателен (макс 100 символов)'); return; }
    if (description.length > 500) { setErr('Описание слишком длинное (макс 500)'); return; }
    const days = parseInt(deadlineStr, 10);
    if (isNaN(days) || days < 1 || days > 365) { setErr('Срок: от 1 до 365 дней'); return; }
    // For services the price can change; for jobs we keep the original amount.
    let price = target.amount;
    if (isService) {
      const p = parseFloat(priceStr);
      if (isNaN(p) || p < 1) { setErr('Цена: минимум 1 USDC'); return; }
      price = BigInt(Math.round(p * 1e6));
    }
    setErr(null);
    onSave({ title: t, description: description.trim(), price, deadlineDays: BigInt(days), region });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={() => !busy && onClose()}>
      <div className="w-full max-w-md rounded-2xl border border-white/12 bg-[#111118] p-6 shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 mb-5">
          <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Pencil className="w-4 h-4 text-primary" />
          </div>
          <h2 className="text-base font-bold font-syne text-white">
            {isService ? 'Редактировать услугу' : 'Редактировать заказ'} #{target.id.toString()}
          </h2>
        </div>

        <div className="space-y-3.5">
          <div className="space-y-1.5">
            <label className="text-xs text-white/50">Заголовок</label>
            <input value={title} onChange={e => setTitle(e.target.value)} maxLength={100}
              className="w-full bg-[#0d0d0f] border border-white/[0.08] rounded-[12px] px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/[0.18]" />
            <p className="text-[11px] text-white/25 text-right">{title.length}/100</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-white/50">Описание</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={4} maxLength={500}
              className="w-full bg-[#0d0d0f] border border-white/[0.08] rounded-[12px] px-3 py-2 text-sm text-white placeholder:text-white/20 resize-none focus:outline-none focus:border-white/[0.18]" />
            <p className="text-[11px] text-white/25 text-right">{description.length}/500</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs text-white/50">{isService ? 'Цена (USDC)' : 'Бюджет (USDC)'}</label>
              <input value={priceStr} onChange={e => setPriceStr(e.target.value)} type="number" min={isService ? '1' : '0'}
                disabled={!isService}
                className={`w-full bg-[#0d0d0f] border border-white/[0.08] rounded-[12px] px-3 py-2 text-sm rounded-[12px] focus:outline-none focus:border-white/[0.18] ${isService ? 'text-white' : 'text-white/35 cursor-not-allowed'}`} />
              {!isService && <p className="text-[11px] text-white/25">Бюджет нельзя менять — отмени и создай новый</p>}
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-white/50">Срок (дней)</label>
              <input value={deadlineStr} onChange={e => setDeadlineStr(e.target.value)} type="number" min="1" max="365"
                className="w-full bg-[#0d0d0f] border border-white/[0.08] rounded-[12px] px-3 py-2 text-sm text-white focus:outline-none focus:border-white/[0.18]" />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-white/50">Регион</label>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(REGION_LABELS).map(([val, label]) => (
                <button key={val} onClick={() => setRegion(Number(val))}
                  className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                    region === Number(val) ? 'bg-white/10 border-white/20 text-white/80' : 'border-white/[0.07] text-white/30 hover:border-white/15 hover:text-white/50'
                  }`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {err && <p className="text-xs text-red-400/80">{err}</p>}
        </div>

        <div className="flex gap-2.5 mt-5">
          <Button variant="ghost" className="flex-1 border border-white/10 text-white/50 hover:text-white/80 hover:bg-white/5"
            onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button className="flex-1 gap-1.5" onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
            Сохранить
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Service Card ──────────────────────────────────────────────────────────────

function ServiceCard({
  serviceId, service, pendingIds, pendingReqs, busyId,
  onPause, onUnpause, onRemove, onAccept, onReject, onEdit,
}: {
  serviceId: bigint;
  service: ServiceRecord;
  pendingIds: bigint[];
  pendingReqs: HireRequestRecord[];
  busyId: string | null;
  onPause: () => void;
  onUnpause: () => void;
  onRemove: () => void;
  onAccept: (requestId: bigint, req: HireRequestRecord) => void;
  onReject: (requestId: bigint) => void;
  onEdit: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [histLoaded, setHistLoaded] = useState(false);
  const [historyReqs, setHistoryReqs] = useState<{ id: bigint; req: HireRequestRecord }[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const publicClient = usePublicClient();

  useEffect(() => {
    if (!expanded || histLoaded || !publicClient) return;
    setHistLoaded(true);
    const pendingSet = new Set(pendingIds.map(id => id.toString()));
    const load = async () => {
      setLoadingHistory(true);
      try {
        const allIds = await publicClient.readContract({
          address: CONTRACTS.diamond as `0x${string}`,
          abi: DIAMOND_ABI as Abi,
          functionName: 'getServiceRequests',
          args: [serviceId],
        }) as bigint[];
        const histIds = allIds.filter(id => !pendingSet.has(id.toString()));
        if (histIds.length === 0) return;
        const results = await Promise.all(
          histIds.map(id =>
            publicClient.readContract({
              address: CONTRACTS.diamond as `0x${string}`,
              abi: DIAMOND_ABI as Abi,
              functionName: 'getRequest',
              args: [id],
            }).then((r: any) => ({ id, req: r as HireRequestRecord })).catch(() => null)
          )
        );
        setHistoryReqs(results.filter(Boolean) as { id: bigint; req: HireRequestRecord }[]);
      } catch { } finally {
        setLoadingHistory(false);
      }
    };
    load();
  }, [expanded, histLoaded, publicClient, serviceId, pendingIds]);

  const s = SERVICE_STATUS[service.status] ?? SERVICE_STATUS[0];
  const pendingCount = pendingIds.length;
  const sId = serviceId.toString();
  const serviceBusy = busyId === sId;

  return (
    <div
      className={`rounded-[22px] border transition-all duration-150 cursor-pointer ${
        expanded ? 'border-white/[0.12] bg-[#111113]' : 'border-white/[0.08] bg-[#0d0d0f] hover:bg-[#111113]'
      }`}
      style={expanded
        ? { boxShadow: "0 4px 20px rgba(0,0,0,0.5), 0 1px 4px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.05)" }
        : { boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }
      }
      onClick={() => setExpanded(v => !v)}
    >
      <div className="px-4 py-3 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-white/90 truncate leading-snug mb-1">{service.title}</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.dot}`} />
            <span className={`text-[11px] font-medium ${s.textCls}`}>{s.label}</span>
            <span className="text-[11px] text-white/15 select-none">·</span>
            <span className="text-[11px] font-mono text-white/55">{fmt(service.price)} USDC</span>
            <span className="text-[11px] text-white/15 select-none">·</span>
            <span className="text-[11px] text-white/35">{Number(service.deadlineDays)}d</span>
            {Number(service.hiresCount) > 0 && (
              <>
                <span className="text-[11px] text-white/15 select-none">·</span>
                <span className="text-[11px] text-white/35">{Number(service.hiresCount)} hire{Number(service.hiresCount) !== 1 ? 's' : ''}</span>
              </>
            )}
            {pendingCount > 0 && (
              <>
                <span className="text-[11px] text-white/15 select-none">·</span>
                <span className="text-[11px] font-medium text-violet-400/80">{pendingCount} request{pendingCount !== 1 ? 's' : ''}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
          {service.status !== 2 && (
            <Button size="sm" variant="ghost" onClick={onEdit} disabled={!!busyId}
              className="h-7 w-7 p-0 text-white/25 hover:text-primary" title="Edit service">
              <Pencil className="w-3.5 h-3.5" />
            </Button>
          )}
          {service.status === 0 && (
            <Button size="sm" variant="ghost" onClick={onPause} disabled={!!busyId}
              className="h-7 w-7 p-0 text-white/25 hover:text-amber-400/80" title="Pause service">
              {serviceBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Pause className="w-3.5 h-3.5" />}
            </Button>
          )}
          {service.status === 1 && (
            <Button size="sm" variant="ghost" onClick={onUnpause} disabled={!!busyId}
              className="h-7 w-7 p-0 text-white/25 hover:text-emerald-400/80" title="Resume service">
              {serviceBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            </Button>
          )}
          {service.status !== 2 && (
            <Button size="sm" variant="ghost" onClick={onRemove} disabled={!!busyId}
              className="h-7 w-7 p-0 text-white/25 hover:text-red-400/80" title="Remove service">
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
          <ChevronDown className={`w-3.5 h-3.5 text-white/25 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </div>

      {expanded && (
        <div className="border-t border-white/8 px-4 pb-4 pt-3" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
          {service.description && (
            <p className="text-xs text-white/45 mb-3 leading-relaxed">{service.description}</p>
          )}
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs mb-3">
            <div><span className="text-white/25">Service ID</span><span className="ml-2 text-white/60 font-mono">#{sId}</span></div>
            <div><span className="text-white/25">Price</span><span className="ml-2 text-white/60 font-mono">{fmt(service.price)} USDC</span></div>
            <div><span className="text-white/25">Deadline</span><span className="ml-2 text-white/60">{Number(service.deadlineDays)}d from start</span></div>
            <div><span className="text-white/25">Total hires</span><span className="ml-2 text-white/60">{Number(service.hiresCount)}</span></div>
          </div>

          {pendingCount > 0 && (
            <div className="mb-3">
              <p className="text-xs text-white/40 font-semibold mb-2 uppercase tracking-wider">
                Incoming Requests · {pendingCount}
              </p>
              <div className="space-y-1.5">
                {pendingIds.map((rid, i) => {
                  const req = pendingReqs[i];
                  if (!req) return null;
                  const rId = rid.toString();
                  return (
                    <div key={rId} className="flex items-center justify-between gap-3 rounded-[14px] bg-white/[0.04] border border-white/[0.07] px-3 py-2">
                      <div className="min-w-0">
                        <span className="text-xs font-mono text-white/60">{shortAddr(req.client)}</span>
                        <span className="ml-3 text-xs font-mono font-semibold text-white/80">{fmt(req.amount)} USDC</span>
                        <span className="ml-2 text-xs text-white/35">{Number(req.deadlineDays)}d</span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <Link href={`/request/${rId}`} onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
                          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-white/40 hover:text-white/70">Details</Button>
                        </Link>
                        <Link href={`/chat/${req.client}`} onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
                          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-white/40 hover:text-primary">Chat</Button>
                        </Link>
                        <Button size="sm" variant="ghost" onClick={() => onReject(rid)} disabled={!!busyId}
                          className="h-6 px-2 text-xs text-red-400/60 hover:text-red-400 hover:bg-red-400/10">
                          {busyId === rId ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Reject'}
                        </Button>
                        <Button size="sm" onClick={() => onAccept(rid, req)} disabled={!!busyId} className="h-6 px-2 text-xs gap-1">
                          {busyId === rId ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserCheck className="w-3 h-3" />}
                          {busyId === rId ? 'Accepting…' : 'Accept'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {pendingCount === 0 && service.status === 0 && (
            <p className="text-xs text-white/25 mb-3">No pending requests yet — share your service to attract clients.</p>
          )}

          {/* Request History */}
          {expanded && (loadingHistory ? (
            <div className="mb-3 flex items-center gap-1.5 text-xs text-white/20">
              <Loader2 className="w-3 h-3 animate-spin" />Loading history…
            </div>
          ) : historyReqs.length > 0 && (
            <div className="mb-3">
              <p className="text-xs text-white/30 font-semibold mb-2 uppercase tracking-wider">
                Request History · {historyReqs.length}
              </p>
              <div className="space-y-1.5">
                {historyReqs.map(({ id, req }) => (
                  <div key={id.toString()} className="flex items-center justify-between gap-3 rounded-[14px] bg-white/[0.04] border border-white/[0.07] px-3 py-2 opacity-80">
                    <div className="min-w-0">
                      <span className="text-xs font-mono text-white/45">{shortAddr(req.client)}</span>
                      <span className="ml-3 text-xs font-mono text-white/60">{fmt(req.amount)} USDC</span>
                      <span className={`ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] border font-medium ${REQUEST_STATUS[req.status]?.cls ?? ''}`}>
                        {REQUEST_STATUS[req.status]?.label}
                      </span>
                    </div>
                    {req.status === 1 && req.agreement !== '0x0000000000000000000000000000000000000000' && (
                      <Link href={`/deal/${req.agreement}`} onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs gap-1 text-violet-400/60 hover:text-violet-400">
                          <ExternalLink className="w-3 h-3" />Deal
                        </Button>
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {service.status !== 2 && (
            <div className="flex items-center gap-2 pt-1 border-t border-white/8">
              {service.status === 0 && (
                <Button size="sm" variant="ghost" onClick={onPause} disabled={!!busyId}
                  className="gap-1.5 text-amber-400/60 hover:text-amber-400 hover:bg-amber-400/10 text-xs">
                  {serviceBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Pause className="w-3 h-3" />}
                  Pause Service
                </Button>
              )}
              {service.status === 1 && (
                <Button size="sm" variant="ghost" onClick={onUnpause} disabled={!!busyId}
                  className="gap-1.5 text-emerald-400/60 hover:text-emerald-400 hover:bg-emerald-400/10 text-xs">
                  {serviceBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                  Resume Service
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={onRemove} disabled={!!busyId}
                className="gap-1.5 text-red-400/60 hover:text-red-400 hover:bg-red-400/10 text-xs">
                <Trash2 className="w-3 h-3" />Remove Service
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── My Services (executor listings) ──────────────────────────────────────────

export function MyServices({ address, onDealCreated }: { address: string; onDealCreated?: () => void }) {
  const [showRemoved, setShowRemoved] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmReq, setConfirmReq] = useState<{ requestId: bigint; client: string; amount: bigint; deadlineDays: bigint } | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const { data: serviceIds, isLoading: loadingIds, refetch: refetchIds } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getExecutorServices',
    args: [address as `0x${string}`],
    query: { enabled: !!address },
  }) as { data: bigint[] | undefined; isLoading: boolean; refetch: () => void };

  const svcContracts = (serviceIds || []).map(id => ({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getService' as const,
    args: [id],
  }));

  const { data: svcResults, isLoading: loadingSvcs, refetch: refetchSvcs } = useReadContracts({
    contracts: svcContracts,
    query: { enabled: (serviceIds || []).length > 0 },
  });

  // Load pending requests only for ACTIVE services
  const activeIds = (serviceIds || []).filter((id, i) => {
    const svc = svcResults?.[i]?.result as ServiceRecord | undefined;
    return svc?.status === 0;
  });

  const pendingContracts = activeIds.map(id => ({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getPendingRequests' as const,
    args: [id],
  }));

  const { data: pendingResults, refetch: refetchPending } = useReadContracts({
    contracts: pendingContracts,
    query: { enabled: activeIds.length > 0 },
  });

  const pendingMap = new Map<string, { ids: bigint[]; reqs: HireRequestRecord[] }>();
  activeIds.forEach((id, i) => {
    const r = pendingResults?.[i];
    if (r?.status === 'success') {
      const [ids, reqs] = r.result as [readonly bigint[], readonly HireRequestRecord[]];
      pendingMap.set(id.toString(), { ids: [...ids], reqs: [...reqs] });
    }
  });

  const refetch = () => { refetchIds(); refetchSvcs(); refetchPending(); };
  const isLoading = loadingIds || loadingSvcs;

  const services: { id: bigint; svc: ServiceRecord }[] = (serviceIds || [])
    .map((id, i) => ({ id, svc: svcResults?.[i]?.result as ServiceRecord | undefined }))
    .filter((x): x is { id: bigint; svc: ServiceRecord } => !!x.svc);

  const active  = services.filter(x => x.svc.status === 0 || x.svc.status === 1);
  const removed = services.filter(x => x.svc.status === 2);

  const handleServiceAction = async (
    serviceId: bigint,
    action: 'pauseService' | 'unpauseService' | 'removeService',
  ) => {
    if (!walletClient || !publicClient) { toast.error('Wallet not connected'); return; }
    setBusyId(serviceId.toString());
    const done: Record<string, string> = {
      pauseService:   'Service paused',
      unpauseService: 'Service resumed',
      removeService:  'Service removed',
    };
    try {
      await sendGasless(walletClient, publicClient, action, [serviceId], DIAMOND_ABI as Abi);
      toast.success(done[action]);
      setTimeout(refetch, 2000);
    } catch (err: any) {
      toast.error(err?.message?.slice(0, 80) || 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  const doAccept = async (requestId: bigint) => {
    if (!walletClient || !publicClient) { toast.error('Wallet not connected'); return; }
    setBusyId(requestId.toString());
    let success = false;
    try {
      toast('Accepting request…');
      await sendGasless(walletClient, publicClient, 'acceptRequest', [requestId], DIAMOND_ABI as Abi);
      toast.success('Request accepted! Deal created.');
      success = true;
      setTimeout(() => { refetch(); onDealCreated?.(); setBusyId(null); }, 2000);
    } catch (err: any) {
      toast.error(err?.message?.slice(0, 80) || 'Accept failed');
    } finally {
      if (!success) setBusyId(null);
    }
  };

  const handleReject = async (requestId: bigint) => {
    if (!walletClient || !publicClient) { toast.error('Wallet not connected'); return; }
    setBusyId(requestId.toString());
    try {
      toast('Rejecting request…');
      await sendGasless(walletClient, publicClient, 'rejectRequest', [requestId], DIAMOND_ABI as Abi);
      toast.success('Request rejected');
      setTimeout(refetch, 2000);
    } catch (err: any) {
      toast.error(err?.message?.slice(0, 80) || 'Reject failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleEditSave = async (
    fields: { title: string; description: string; price: bigint; deadlineDays: bigint; region: number },
  ) => {
    if (!walletClient || !publicClient || !editTarget) { toast.error('Wallet not connected'); return; }
    setEditBusy(true);
    try {
      await sendGasless(
        walletClient, publicClient, 'editService',
        [editTarget.id, fields.title, fields.description, fields.price, fields.deadlineDays, fields.region],
        DIAMOND_ABI as Abi,
      );
      toast.success('Услуга обновлена');
      setEditTarget(null);
      setTimeout(refetch, 2000);
    } catch (err: any) {
      toast.error(err?.message?.slice(0, 80) || 'Edit failed');
    } finally {
      setEditBusy(false);
    }
  };

  if (isLoading) {
    return <div className="py-8 text-center text-sm text-white/30"><Loader2 className="w-4 h-4 animate-spin mx-auto" /></div>;
  }

  if (services.length === 0) {
    return (
      <div className="flex items-center justify-between py-2">
        <p className="text-xs text-white/30">No services posted yet</p>
        <Link href="/board/executor/post">
          <Button size="sm" variant="outline" className="h-7 text-xs border-white/15 text-white/60">Post a Service</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {active.length > 0 && (
        <div className="space-y-3">
          {active.map(({ id, svc }, index) => {
            const pending = pendingMap.get(id.toString()) ?? { ids: [], reqs: [] };
            return (
              <div key={id.toString()} className="card-enter" style={{ animationDelay: `${index * 0.04}s` }}>
                <ServiceCard
                  serviceId={id}
                  service={svc}
                  pendingIds={pending.ids}
                  pendingReqs={pending.reqs}
                  busyId={busyId}
                  onPause={() => handleServiceAction(id, 'pauseService')}
                  onUnpause={() => handleServiceAction(id, 'unpauseService')}
                  onRemove={() => handleServiceAction(id, 'removeService')}
                  onAccept={(rid, req) => setConfirmReq({ requestId: rid, client: req.client, amount: req.amount, deadlineDays: req.deadlineDays })}
                  onReject={handleReject}
                  onEdit={() => setEditTarget({ kind: 'service', id, title: svc.title, description: svc.description, amount: svc.price, deadlineDays: svc.deadlineDays, region: svc.region })}
                />
              </div>
            );
          })}
        </div>
      )}

      {removed.length > 0 && (
        <div>
          <button onClick={() => setShowRemoved(v => !v)}
            className="flex items-center gap-2 mb-2 group w-full text-left">
            <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
            <span className="text-xs font-semibold text-white/35 uppercase tracking-wider group-hover:text-white/55 transition-colors">
              Removed · {removed.length}
            </span>
            <ChevronDown className={`w-3 h-3 text-white/25 ml-0.5 transition-transform group-hover:text-white/50 ${showRemoved ? 'rotate-180' : ''}`} />
          </button>
          {showRemoved && (
            <div className="space-y-3 opacity-70">
              {removed.map(({ id, svc }) => (
                <ServiceCard
                  key={id.toString()}
                  serviceId={id}
                  service={svc}
                  pendingIds={[]}
                  pendingReqs={[]}
                  busyId={busyId}
                  onPause={() => {}}
                  onUnpause={() => {}}
                  onRemove={() => {}}
                  onAccept={() => {}}
                  onReject={() => {}}
                  onEdit={() => {}}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Edit Service Modal */}
      {editTarget && editTarget.kind === 'service' && (
        <EditListingModal
          target={editTarget}
          busy={editBusy}
          onClose={() => !editBusy && setEditTarget(null)}
          onSave={handleEditSave}
        />
      )}

      {/* Accept Request Confirmation Modal */}
      {confirmReq && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={() => !busyId && setConfirmReq(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-white/12 bg-[#111118] p-6 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-5">
              <div className="w-9 h-9 rounded-full bg-emerald-400/10 flex items-center justify-center flex-shrink-0">
                <CheckCircle className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <h2 className="text-base font-bold font-syne text-white mb-1">Accept Request?</h2>
                <p className="text-sm text-white/50 leading-relaxed">
                  An on-chain escrow agreement will be deployed and the deal will start.
                </p>
              </div>
            </div>

            <div className="rounded-[14px] border border-white/[0.07] bg-[#0d0d0f] divide-y divide-white/6 mb-5">
              <div className="flex justify-between items-center px-4 py-2.5 text-sm">
                <span className="text-white/40">Client</span>
                <span className="font-mono text-white/60 text-xs">{shortAddr(confirmReq.client)}</span>
              </div>
              <div className="flex justify-between items-center px-4 py-2.5 text-sm">
                <span className="text-white/40">Amount</span>
                <span className="font-mono font-semibold text-white">{(Number(confirmReq.amount) / 1e6).toFixed(2)} USDC</span>
              </div>
              <div className="flex justify-between items-center px-4 py-2.5 text-sm">
                <span className="text-white/40">Deadline</span>
                <span className="text-white/70">{Number(confirmReq.deadlineDays)} days</span>
              </div>
            </div>

            <div className="flex gap-2.5">
              <Button
                variant="ghost"
                className="flex-1 border border-white/10 text-white/50 hover:text-white/80 hover:bg-white/5"
                onClick={() => setConfirmReq(null)}
                disabled={!!busyId}
              >
                Cancel
              </Button>
              <Button
                className="flex-1 gap-1.5"
                onClick={() => {
                  const { requestId } = confirmReq;
                  setConfirmReq(null);
                  doAccept(requestId);
                }}
                disabled={!!busyId}
              >
                <UserCheck className="w-3.5 h-3.5" />
                Accept
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Job Card ──────────────────────────────────────────────────────────────────

function JobCard({
  jobId, job, applicants, onCancel, onAccept, onEdit, busy,
}: {
  jobId: bigint;
  job: JobRecord;
  applicants?: string[];
  onCancel: () => void;
  onAccept: (executor: string) => void;
  onEdit: () => void;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const s = JOB_STATUS[job.status] ?? JOB_STATUS[0];
  const count = applicants?.length ?? 0;
  // Editable only while OPEN and nobody has applied yet
  const canEdit = job.status === 0 && count === 0;

  return (
    <div
      className={`rounded-[22px] border transition-all duration-150 cursor-pointer ${
        expanded ? 'border-white/[0.12] bg-[#111113]' : 'border-white/[0.08] bg-[#0d0d0f] hover:bg-[#111113]'
      }`}
      style={expanded
        ? { boxShadow: "0 4px 20px rgba(0,0,0,0.5), 0 1px 4px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.05)" }
        : { boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }
      }
      onClick={() => setExpanded(v => !v)}
    >
      <div className="px-4 py-3 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-white/90 truncate leading-snug mb-1">{job.title}</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.dot}`} />
            <span className={`text-[11px] font-medium ${s.textCls}`}>{s.label}</span>
            <span className="text-[11px] text-white/15 select-none">·</span>
            <span className="text-[11px] font-mono text-white/55">{fmt(job.amount)} USDC</span>
            <span className="text-[11px] text-white/15 select-none">·</span>
            <span className="text-[11px] text-white/35">{Number(job.deadlineDays)}d</span>
            {job.status === 0 && count > 0 && (
              <>
                <span className="text-[11px] text-white/15 select-none">·</span>
                <span className="text-[11px] font-medium text-violet-400/80">{count} applicant{count !== 1 ? 's' : ''}</span>
              </>
            )}
            {job.status === 1 && job.agreement !== '0x0000000000000000000000000000000000000000' && (
              <>
                <span className="text-[11px] text-white/15 select-none">·</span>
                <Link href={`/deal/${job.agreement}`} onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}
                  className="text-[11px] text-violet-400/70 hover:text-violet-400 flex items-center gap-0.5 transition-colors">
                  <ExternalLink className="w-2.5 h-2.5" />Deal
                </Link>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
          {canEdit && (
            <Button size="sm" variant="ghost" onClick={onEdit} disabled={busy}
              className="h-7 w-7 p-0 text-white/25 hover:text-primary" title="Edit job">
              <Pencil className="w-3.5 h-3.5" />
            </Button>
          )}
          {job.status === 0 && (
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}
              className="h-7 w-7 p-0 text-white/25 hover:text-red-400/80" title="Cancel job">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            </Button>
          )}
          <ChevronDown className={`w-3.5 h-3.5 text-white/25 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </div>

      {expanded && (
        <div className="border-t border-white/8 px-4 pb-4 pt-3" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
          {job.description && (
            <p className="text-xs text-white/45 mb-3 leading-relaxed">{job.description}</p>
          )}
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs mb-3">
            <div><span className="text-white/25">Job ID</span><span className="ml-2 text-white/60 font-mono">#{jobId.toString()}</span></div>
            <div><span className="text-white/25">Budget</span><span className="ml-2 text-white/60 font-mono">{fmt(job.amount)} USDC</span></div>
            <div><span className="text-white/25">Deadline</span><span className="ml-2 text-white/60">{Number(job.deadlineDays)}d from start</span></div>
            {job.status === 1 && job.chosenExecutor !== '0x0000000000000000000000000000000000000000' && (
              <div><span className="text-white/25">Executor</span><span className="ml-2 text-white/60 font-mono">{shortAddr(job.chosenExecutor)}</span></div>
            )}
          </div>

          {job.status === 0 && count > 0 && (
            <div className="mb-3">
              <p className="text-xs text-white/40 font-semibold mb-2 uppercase tracking-wider">
                Applicants · {count}
              </p>
              <div className="space-y-1.5">
                {applicants!.map(addr => (
                  <div key={addr} className="flex items-center justify-between gap-3 rounded-[14px] bg-white/[0.04] border border-white/[0.07] px-3 py-2">
                    <span className="text-xs font-mono text-white/60 min-w-0 truncate">{shortAddr(addr)}</span>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <Link href={`/chat/${addr}`}>
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-white/40 hover:text-primary">Chat</Button>
                      </Link>
                      <Button size="sm" onClick={() => onAccept(addr)} disabled={busy} className="h-6 px-2 text-xs gap-1">
                        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserCheck className="w-3 h-3" />}
                        {busy ? 'Accepting…' : 'Accept'}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {job.status === 0 && count === 0 && (
            <p className="text-xs text-white/25 mb-3">No applicants yet — share your job link to attract executors.</p>
          )}

          <div className="flex items-center gap-2 pt-1 border-t border-white/8">
            <Link href={`/job/${jobId.toString()}`}>
              <Button size="sm" variant="outline" className="gap-1.5 border-white/15 text-white/50 text-xs">
                <ExternalLink className="w-3 h-3" /> Full Job Page
              </Button>
            </Link>
            {job.status === 0 && (
              <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}
                className="gap-1.5 text-red-400/60 hover:text-red-400 hover:bg-red-400/10 text-xs">
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                Cancel Job
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── My Jobs (client postings) ─────────────────────────────────────────────────

export function MyJobs({ address, onDealCreated }: { address: string; onDealCreated?: () => void }) {
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [confirmHire, setConfirmHire] = useState<{ jobId: bigint; executor: string; amount: bigint; deadlineDays: bigint } | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const router = useRouter();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const { data: jobIds, isLoading: loadingIds, refetch: refetchIds } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getClientJobs',
    args: [address as `0x${string}`],
    query: { enabled: !!address },
  }) as { data: bigint[] | undefined; isLoading: boolean; refetch: () => void };

  const jobContracts = (jobIds || []).map(id => ({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getJob' as const,
    args: [id],
  }));

  const { data: jobResults, isLoading: loadingJobs, refetch: refetchJobs } = useReadContracts({
    contracts: jobContracts,
    query: { enabled: (jobIds || []).length > 0 },
  });

  const openJobIds = (jobIds || []).filter((id, i) => {
    const job = jobResults?.[i]?.result as JobRecord | undefined;
    return job?.status === 0;
  });

  const applicantContracts = openJobIds.map(id => ({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getApplicants' as const,
    args: [id] as const,
  }));

  const { data: applicantResults, refetch: refetchApplicants } = useReadContracts({
    contracts: applicantContracts,
    query: { enabled: openJobIds.length > 0 },
  });

  const applicantsMap = new Map<string, string[]>();
  openJobIds.forEach((id, i) => {
    const r = applicantResults?.[i];
    if (r?.status === 'success') applicantsMap.set(id.toString(), r.result as string[]);
  });

  const refetch = () => { refetchIds(); refetchJobs(); refetchApplicants(); };
  const isLoading = loadingIds || loadingJobs;

  const jobs: { id: bigint; job: JobRecord }[] = (jobIds || [])
    .map((id, i) => ({ id, job: jobResults?.[i]?.result as JobRecord | undefined }))
    .filter((x): x is { id: bigint; job: JobRecord } => !!x.job);

  const active = jobs.filter(x => x.job.status === 0);

  const handleCancel = async (jobId: bigint) => {
    if (!walletClient || !publicClient) { toast.error('Wallet not connected'); return; }
    setBusyJobId(jobId.toString());
    try {
      toast('Cancelling job…');
      await sendGasless(walletClient, publicClient, 'cancelJob', [jobId], DIAMOND_ABI as Abi);
      toast.success('Job cancelled');
      setTimeout(refetch, 2000);
    } catch (err: any) {
      toast.error(err?.message?.slice(0, 80) || 'Cancel failed');
    } finally {
      setBusyJobId(null);
    }
  };

  const doAccept = async (jobId: bigint, executorAddr: string) => {
    if (!walletClient || !publicClient) { toast.error('Wallet not connected'); return; }
    setBusyJobId(jobId.toString());
    let success = false;
    try {
      toast('Accepting applicant…');
      const result = await sendGasless(walletClient, publicClient, 'acceptApplicant', [jobId, executorAddr], DIAMOND_ABI as Abi);
      toast.success('Executor accepted! Deal created.');
      success = true;
      const ZERO = '0x0000000000000000000000000000000000000000';
      if (result.agreementAddr && result.agreementAddr !== ZERO) {
        setTimeout(() => router.push(`/deal/${result.agreementAddr}`), 1500);
      } else {
        setTimeout(() => { refetch(); onDealCreated?.(); setBusyJobId(null); }, 2000);
      }
    } catch (err: any) {
      toast.error(err?.message?.slice(0, 80) || 'Accept failed');
    } finally {
      if (!success) setBusyJobId(null);
    }
  };

  const handleEditSave = async (
    fields: { title: string; description: string; price: bigint; deadlineDays: bigint; region: number },
  ) => {
    if (!walletClient || !publicClient || !editTarget) { toast.error('Wallet not connected'); return; }
    setEditBusy(true);
    try {
      // editJob(jobId, title, description, deadlineDays, termsHash, region) — amount is immutable
      await sendGasless(
        walletClient, publicClient, 'editJob',
        [editTarget.id, fields.title, fields.description, fields.deadlineDays, editTarget.termsHash ?? `0x${'0'.repeat(64)}`, fields.region],
        DIAMOND_ABI as Abi,
      );
      toast.success('Заказ обновлён');
      setEditTarget(null);
      setTimeout(refetch, 2000);
    } catch (err: any) {
      toast.error(err?.message?.slice(0, 80) || 'Edit failed');
    } finally {
      setEditBusy(false);
    }
  };

  if (isLoading) return <div className="py-8 text-center text-sm text-white/30"><Loader2 className="w-4 h-4 animate-spin mx-auto" /></div>;

  if (jobs.length === 0) {
    return (
      <div className="flex flex-col items-center py-8 text-center">
        <Briefcase className="w-7 h-7 text-white/15 mb-2" />
        <p className="text-sm text-white/40 mb-1">No jobs posted yet</p>
        <Link href="/board/client/post">
          <Button size="sm" variant="outline" className="mt-2 border-white/15 text-white/60">Post a Job</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {active.length > 0 && (
        <div className="space-y-3">
          {active.map(({ id, job }, index) => (
            <div key={id.toString()} className="card-enter" style={{ animationDelay: `${index * 0.04}s` }}>
              <JobCard
                jobId={id}
                job={job}
                applicants={applicantsMap.get(id.toString())}
                onCancel={() => handleCancel(id)}
                onAccept={(exec) => setConfirmHire({ jobId: id, executor: exec, amount: job.amount, deadlineDays: job.deadlineDays })}
                onEdit={() => setEditTarget({ kind: 'job', id, title: job.title, description: job.description, amount: job.amount, deadlineDays: job.deadlineDays, region: job.region, termsHash: job.termsHash })}
                busy={busyJobId === id.toString()}
              />
            </div>
          ))}
        </div>
      )}


      {/* Edit Job Modal */}
      {editTarget && editTarget.kind === 'job' && (
        <EditListingModal
          target={editTarget}
          busy={editBusy}
          onClose={() => !editBusy && setEditTarget(null)}
          onSave={handleEditSave}
        />
      )}

      {/* Hire Confirmation Modal */}
      {confirmHire && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={() => !busyJobId && setConfirmHire(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-white/12 bg-[#111118] p-6 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-5">
              <div className="w-9 h-9 rounded-full bg-amber-400/10 flex items-center justify-center flex-shrink-0">
                <AlertCircle className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h2 className="text-base font-bold font-syne text-white mb-1">Confirm Hire</h2>
                <p className="text-sm text-white/50 leading-relaxed">
                  You're about to lock funds into an on-chain escrow. Once confirmed, deal terms are final and cannot be changed.
                </p>
              </div>
            </div>

            <div className="rounded-[14px] border border-white/[0.07] bg-[#0d0d0f] divide-y divide-white/6 mb-4">
              <div className="flex justify-between items-center px-4 py-2.5 text-sm">
                <span className="text-white/40">Executor</span>
                <span className="font-mono text-white/60 text-xs">{shortAddr(confirmHire.executor)}</span>
              </div>
              <div className="flex justify-between items-center px-4 py-2.5 text-sm">
                <span className="text-white/40">Budget locked in escrow</span>
                <span className="font-mono font-semibold text-white">{fmt(confirmHire.amount)} USDC</span>
              </div>
              <div className="flex justify-between items-center px-4 py-2.5 text-sm">
                <span className="text-white/40">Deadline</span>
                <span className="text-white/70">{Number(confirmHire.deadlineDays)} days</span>
              </div>
            </div>

            <div className="rounded-xl border border-amber-400/15 bg-amber-400/5 px-4 py-3 mb-5">
              <p className="text-xs text-amber-400/80 leading-relaxed">
                Budget will stay locked until you approve the work, a dispute is resolved, or an auto-release timeout expires. You cannot change the executor or amount after this point.
              </p>
            </div>

            <div className="flex gap-2.5">
              <Button
                variant="ghost"
                className="flex-1 border border-white/10 text-white/50 hover:text-white/80 hover:bg-white/5"
                onClick={() => setConfirmHire(null)}
                disabled={!!busyJobId}
              >
                Cancel
              </Button>
              <Button
                className="flex-1 gap-1.5"
                onClick={() => {
                  const { jobId, executor } = confirmHire;
                  setConfirmHire(null);
                  doAccept(jobId, executor);
                }}
                disabled={!!busyJobId}
              >
                <CheckCircle className="w-3.5 h-3.5" />
                Confirm Hire
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── My Client Requests (service board) ───────────────────────────────────────

export function MyClientRequests({ address }: { address: string }) {
  const [showHistory, setShowHistory] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const { data: reqIds, isLoading: loadingIds, refetch: refetchIds } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getClientRequests',
    args: [address as `0x${string}`],
    query: { enabled: !!address },
  }) as { data: bigint[] | undefined; isLoading: boolean; refetch: () => void };

  const reqContracts = (reqIds || []).map(id => ({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getRequest' as const,
    args: [id],
  }));

  const { data: reqResults, isLoading: loadingReqs, refetch: refetchReqs } = useReadContracts({
    contracts: reqContracts,
    query: { enabled: (reqIds || []).length > 0 },
  });

  const refetch = () => { refetchIds(); refetchReqs(); };
  const isLoading = loadingIds || loadingReqs;

  const requests: { id: bigint; req: HireRequestRecord }[] = (reqIds || [])
    .map((id, i) => ({ id, req: reqResults?.[i]?.result as HireRequestRecord | undefined }))
    .filter((x): x is { id: bigint; req: HireRequestRecord } => !!x.req);

  const pending = requests.filter(x => x.req.status === 0);
  const history = requests.filter(x => x.req.status !== 0);

  const handleCancel = async (reqId: bigint) => {
    if (!walletClient || !publicClient) { toast.error('Wallet not connected'); return; }
    setBusyId(reqId.toString());
    try {
      toast('Cancelling request…');
      await sendGasless(walletClient, publicClient, 'cancelRequest', [reqId], DIAMOND_ABI as Abi);
      toast.success('Request cancelled');
      setTimeout(refetch, 2000);
    } catch (err: any) {
      toast.error(err?.message?.slice(0, 80) || 'Cancel failed');
    } finally {
      setBusyId(null);
    }
  };

  if (isLoading) return <div className="py-4 text-center"><Loader2 className="w-4 h-4 animate-spin mx-auto text-white/30" /></div>;

  if (requests.length === 0) {
    return <p className="text-xs text-white/25 py-3">No service requests sent yet.</p>;
  }

  return (
    <div className="space-y-3">
      {pending.map(({ id, req }) => (
        <div key={id.toString()} className="rounded-[14px] border border-white/[0.07] bg-[#0d0d0f] px-4 py-3 flex items-center justify-between gap-3">
          <Link href={`/request/${id.toString()}`} className="min-w-0 flex-1 group">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border font-medium ${REQUEST_STATUS[0].cls}`}>
                Pending
              </span>
              <span className="text-sm font-semibold text-white/80 font-mono">{fmt(req.amount)} USDC</span>
            </div>
            <div className="text-xs text-white/35 group-hover:text-white/50 transition-colors">
              Service #{req.serviceId.toString()} · {Number(req.deadlineDays)}d deadline · View details →
            </div>
          </Link>
          <Button size="sm" variant="ghost" onClick={() => handleCancel(id)}
            disabled={busyId === id.toString()}
            className="h-7 w-7 p-0 text-white/25 hover:text-red-400/80 flex-shrink-0" title="Cancel request">
            {busyId === id.toString() ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
          </Button>
        </div>
      ))}

      {history.length > 0 && (
        <div>
          <button onClick={() => setShowHistory(v => !v)}
            className="flex items-center gap-2 my-2 group w-full text-left">
            <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
            <span className="text-xs font-semibold text-white/35 uppercase tracking-wider group-hover:text-white/55 transition-colors">
              History · {history.length}
            </span>
            <ChevronDown className={`w-3 h-3 text-white/25 ml-0.5 transition-transform group-hover:text-white/50 ${showHistory ? 'rotate-180' : ''}`} />
          </button>
          {showHistory && (
            <div className="space-y-3 opacity-70">
              {history.map(({ id, req }) => (
                <Link key={id.toString()} href={`/request/${id.toString()}`} className="block rounded-[14px] border border-white/[0.07] bg-[#0d0d0f] px-4 py-3 hover:border-white/[0.12] transition-colors">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border font-medium ${REQUEST_STATUS[req.status]?.cls ?? ''}`}>
                      {REQUEST_STATUS[req.status]?.label}
                    </span>
                    <span className="text-sm font-semibold text-white/80 font-mono">{fmt(req.amount)} USDC</span>
                    {req.status === 1 && req.agreement !== '0x0000000000000000000000000000000000000000' && (
                      <span onClick={e => e.preventDefault()}>
                        <Link href={`/deal/${req.agreement}`}>
                          <Button size="sm" variant="ghost" className="h-5 px-2 text-xs gap-1 text-violet-400/70 hover:text-violet-400">
                            <ExternalLink className="w-3 h-3" />Deal
                          </Button>
                        </Link>
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-white/35">
                    Service #{req.serviceId.toString()} · {Number(req.deadlineDays)}d deadline
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── MyJobReceipts ────────────────────────────────────────────────────────────

const RECEIPT_REGION: Record<number, string> = {
  0: 'CIS', 1: 'Asia', 2: 'Europe', 3: 'US', 4: 'LATAM', 5: 'CA', 6: 'AU',
};

interface ReceiptItem {
  tokenId:      bigint;
  jobId:        bigint;
  title:        string;
  amount:       bigint;
  deadlineDays: bigint;
  region:       number;
  createdAt:    bigint;
}

export function MyJobReceipts({ address }: { address: string }) {
  const publicClient = usePublicClient();
  const [receipts, setReceipts] = useState<ReceiptItem[]>([]);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    if (!publicClient || !address) return;

    const load = async () => {
      setLoading(true);
      try {
        const logs = await publicClient.getLogs({
          address: CONTRACTS.diamond,
          event: parseAbiItem('event JobReceiptMinted(uint256 indexed tokenId, uint256 indexed jobId, address indexed client)'),
          args:  { client: address as `0x${string}` },
          fromBlock: 'earliest',
          toBlock:   'latest',
        });

        const items = await Promise.all(
          logs.map(async (log) => {
            const tokenId = log.args.tokenId!;
            const jobId   = log.args.jobId!;
            try {
              const r = await publicClient.readContract({
                address:      CONTRACTS.diamond,
                abi:          JOB_RECEIPT_FACET_ABI as Abi,
                functionName: 'getJobReceiptData',
                args:         [tokenId],
              }) as { client: string; title: string; amount: bigint; deadlineDays: bigint; region: number; createdAt: bigint };
              return { tokenId, jobId, title: r.title, amount: r.amount, deadlineDays: r.deadlineDays, region: r.region, createdAt: r.createdAt } as ReceiptItem;
            } catch {
              return null;
            }
          })
        );

        setReceipts(items.filter(Boolean).reverse() as ReceiptItem[]);
      } catch {
        // silently fail — receipts are non-critical display
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [address, publicClient]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-white/25">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span className="text-xs">Loading receipts…</span>
      </div>
    );
  }

  if (receipts.length === 0) {
    return (
      <div className="text-xs text-white/20 text-center py-6 border border-dashed border-white/8 rounded-xl">
        No receipts yet — posted jobs appear here as NFTs.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {receipts.map((r) => (
        <div key={r.tokenId.toString()} className="rounded-[14px] border border-white/[0.07] bg-[#0d0d0f] px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white/85 truncate">{r.title}</p>
              <div className="flex items-center gap-2 mt-1 text-xs text-white/35 flex-wrap">
                <span className="font-mono font-semibold text-white/55">{fmt(r.amount)} USDC</span>
                <span className="text-white/15">·</span>
                <span>{Number(r.deadlineDays)}d</span>
                <span className="text-white/15">·</span>
                <span>{RECEIPT_REGION[r.region] ?? r.region}</span>
              </div>
            </div>
            <div className="text-right flex-shrink-0">
              <span className="text-[10px] font-mono text-white/20">NFT #{r.tokenId.toString()}</span>
              <p className="text-[10px] text-white/15 mt-0.5">
                {new Date(Number(r.createdAt) * 1000).toLocaleDateString()}
              </p>
            </div>
          </div>
          <Link href={`/job/${r.jobId.toString()}`}>
            <Button size="sm" variant="ghost" className="mt-1.5 h-6 px-2 text-[11px] text-white/25 hover:text-white/55 gap-1 -ml-1">
              View Job <ExternalLink className="w-3 h-3" />
            </Button>
          </Link>
        </div>
      ))}
    </div>
  );
}
