'use client';

import { useAccount, useReadContract } from 'wagmi';
import { useMemo } from 'react';
import { DIAMOND_ABI, CONTRACTS, STATUS_LABELS } from '@/config/contracts';
import { FormSection } from '@/components/form/FormSection';
import { FormField, MonoInput } from '@/components/form/FormField';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, Clock, CheckCircle, AlertTriangle } from 'lucide-react';

interface AgreementRecord {
  agreement: string;
  client: string;
  executor: string;
  amount: bigint;
  status: number;
  createdAt: bigint;
  resolvedAt: bigint;
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatAmount(amount: bigint): string {
  return (Number(amount) / 1e6).toFixed(2);
}

function formatDate(ts: bigint | undefined): string {
  if (!ts || ts === BigInt(0)) return '—';
  return new Date(Number(ts) * 1000).toLocaleDateString();
}

function statusIcon(status: number) {
  switch (status) {
    case 0: return <Clock className="w-3 h-3 text-yellow-500" />;
    case 1: return <CheckCircle className="w-3 h-3 text-green-500" />;
    case 3: return <AlertTriangle className="w-3 h-3 text-red-500" />;
    default: return null;
  }
}

export function WalletInfoForm() {
  const { address } = useAccount();

  return (
    <FormSection title="Wallet Information" defaultOpen>
      <div className="space-y-4">
        <FormField label="Wallet Address" description="Your connected wallet address">
          <MonoInput
            readOnly
            value={address ? `${address.substring(0, 6)}...${address.substring(38)}` : 'Not connected'}
            className="font-mono text-sm"
          />
        </FormField>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField label="Network" description="Current blockchain network">
            <MonoInput readOnly value="Base Mainnet" />
          </FormField>
          <FormField label="Status" description="Connection status">
            <div className="flex items-center">
              <span className="inline-block w-2 h-2 rounded-full bg-green-500 mr-2"></span>
              <span>Connected</span>
            </div>
          </FormField>
        </div>
      </div>
    </FormSection>
  );
}

export function MyAgreementsForm() {
  const { address } = useAccount();

  const { data: clientAgreements, isLoading: isLoadingClient } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'getByClient',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  }) as { data: AgreementRecord[] | undefined; isLoading: boolean };

  const { data: executorAgreements, isLoading: isLoadingExecutor } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'getByExecutor',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  }) as { data: AgreementRecord[] | undefined; isLoading: boolean };

  const allAgreements = useMemo(() => {
    const client = clientAgreements || [];
    const executor = executorAgreements || [];
    const map = new Map<string, AgreementRecord>();
    [...client, ...executor].forEach((a) => map.set(a.agreement.toLowerCase(), a));
    return Array.from(map.values());
  }, [clientAgreements, executorAgreements]);

  const isLoading = isLoadingClient || isLoadingExecutor;

  return (
    <FormSection title="My Agreements" defaultOpen>
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : allAgreements.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-muted-foreground">No agreements yet</p>
          <Link href="/deal">
            <Button variant="outline" className="mt-4">Create First Deal</Button>
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {allAgreements.map((agreement) => (
            <Link key={agreement.agreement} href={`/deal/${agreement.agreement}`}>
              <div className="border border-gray-700 rounded-lg p-4 hover:bg-white/5 transition-colors cursor-pointer">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {statusIcon(agreement.status)}
                    <span className="font-mono text-sm">{shortAddr(agreement.agreement)}</span>
                  </div>
                  <Badge variant={agreement.status === 0 ? 'default' : 'secondary'}>
                    {STATUS_LABELS[agreement.status] || 'Unknown'}
                  </Badge>
                </div>
                <div className="flex items-center justify-between mt-2 text-sm text-muted-foreground">
                  <span>{formatAmount(agreement.amount)} USDC</span>
                  <span>Created: {formatDate(agreement.createdAt)}</span>
                </div>
                <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                  <span>Client: {shortAddr(agreement.client)}</span>
                  <span>Executor: {shortAddr(agreement.executor)}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </FormSection>
  );
}

export function QuickActionsForm() {
  return (
    <FormSection title="Quick Actions">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Link href="/deal">
          <div className="p-4 border border-gray-700 rounded-lg hover:bg-white/5 transition-colors cursor-pointer">
            <div className="flex items-center">
              <div className="p-2 bg-white/10 rounded-lg mr-3">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
              </div>
              <div>
                <h4 className="font-medium">Create Deal</h4>
                <p className="text-xs text-gray-400">New escrow agreement</p>
              </div>
            </div>
          </div>
        </Link>

        <Link href="/board">
          <div className="p-4 border border-gray-700 rounded-lg hover:bg-white/5 transition-colors cursor-pointer">
            <div className="flex items-center">
              <div className="p-2 bg-white/10 rounded-lg mr-3">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                </svg>
              </div>
              <div>
                <h4 className="font-medium">Browse Board</h4>
                <p className="text-xs text-gray-400">View all deals</p>
              </div>
            </div>
          </div>
        </Link>
      </div>
    </FormSection>
  );
}

export function ActivityForm() {
  const { address } = useAccount();

  const { data: clientAgreements } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'getByClient',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  }) as { data: AgreementRecord[] | undefined };

  const { data: executorAgreements } = useReadContract({
    address: CONTRACTS.diamond as `0x${string}`,
    abi: DIAMOND_ABI,
    functionName: 'getByExecutor',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  }) as { data: AgreementRecord[] | undefined };

  const recentActivity = useMemo(() => {
    const all = [...(clientAgreements || []), ...(executorAgreements || [])];
    const map = new Map<string, AgreementRecord>();
    all.forEach((a) => map.set(a.agreement.toLowerCase(), a));
    return Array.from(map.values())
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
      .slice(0, 5);
  }, [clientAgreements, executorAgreements]);

  return (
    <FormSection title="Recent Activity" defaultOpen>
      <div className="space-y-4">
        {recentActivity.length === 0 ? (
          <p className="text-muted-foreground text-sm">No activity yet</p>
        ) : (
          recentActivity.map((agreement) => (
            <div key={agreement.agreement} className="border-b border-gray-800 pb-3 last:border-0 last:pb-0">
              <div className="flex justify-between items-start">
                <div>
                  <h4 className="font-medium font-mono text-sm">{shortAddr(agreement.agreement)}</h4>
                  <p className="text-sm text-gray-400">{formatAmount(agreement.amount)} USDC</p>
                </div>
                <div className="text-right">
                  <span className="text-xs text-gray-400 block">{formatDate(agreement.createdAt)}</span>
                  <span className="inline-block mt-1 px-2 py-0.5 text-xs rounded bg-gray-800 text-gray-200">
                    {STATUS_LABELS[agreement.status] || 'Unknown'}
                  </span>
                </div>
              </div>
            </div>
          ))
        )}
        {recentActivity.length > 0 && (
          <div className="pt-2">
            <Link href="/board" className="text-sm text-gray-400 hover:text-white transition-colors flex items-center">
              View all deals
              <svg className="w-4 h-4 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        )}
      </div>
    </FormSection>
  );
}

export function DashboardForms() {
  return (
    <div className="space-y-6">
      <WalletInfoForm />
      <QuickActionsForm />
      <MyAgreementsForm />
      <ActivityForm />
    </div>
  );
}
