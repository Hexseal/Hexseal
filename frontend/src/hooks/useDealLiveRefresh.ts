'use client';

import { useCallback } from 'react';
import { isAddress, parseAbi } from 'viem';
import { useWatchContractEvent } from 'wagmi';
import { refreshFromLogs } from '@/lib/subgraphSync';

/**
 * Живое обновление страницы сделки по событиям САМОГО клона.
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ useNotifications. Тринадцать наблюдателей там сидят на
 * диамонде, а диамонд про сделку эмитит `AgreementStatusUpdated` только на
 * DISPUTED (`src/Agreement.sol:695`) и на терминальных статусах (через
 * `_complete` → `_updateRegistry`). Главные переходы — оплата, активация, сдача
 * работы — эмитятся НА КЛОНЕ: `Funded`, `Activated`, `MarkedDone`. С диамонда
 * их не видно вовсе, и до этой правки экран сделки узнавал о них только по
 * `refetchInterval` в 15 секунд или по возвращению во вкладку.
 *
 * ОДИН НАБЛЮДАТЕЛЬ, А НЕ ПЯТНАДЦАТЬ. `eventName` не указан намеренно: viem
 * строит фильтр по topic0 ВСЕХ событий переданного ABI, то есть один опрос
 * покрывает весь список ниже. Адрес — конкретный клон, так что посторонних
 * логов сюда физически не попадает и фильтровать по пользователю не нужно:
 * любое событие этой сделки касается того, кто на неё смотрит.
 *
 * ERC-721 события (`Transfer`, `Approval`) в ABI не входят и в фильтр не
 * попадают: чек минтится в `fund()`, то есть в одной транзакции с `Funded`, и
 * отдельного повода перечитывать не даёт.
 */
const AGREEMENT_STATE_EVENTS = parseAbi([
  'event Funded(address indexed client, uint256 amount)',
  'event Activated(address indexed executor)',
  'event MarkedDone(address indexed executor)',
  'event Released(address indexed client, address indexed executor, uint256 amount)',
  'event AutoApproved(address indexed executor, uint256 amount)',
  'event DisputeRaised(address indexed by)',
  'event DisputeResolved(address indexed arbiter, bool clientWins, uint256 amount)',
  'event DisputeResponded(address indexed party)',
  'event DisputeSplitNoVerdict(uint256 toClient, uint256 toExecutor)',
  'event DisputeUnanswered(address indexed responder, uint256 toResponder, uint256 toSilent)',
  'event TimedOut(address indexed client, uint256 amount)',
  'event ArbiterTimedOut(address indexed client, uint256 amount)',
  'event ExtraProposed(uint256 indexed extraId, address indexed client, uint256 amount, string terms)',
  'event ExtraAccepted(uint256 indexed extraId, uint256 newTotal)',
  'event ExtraRejected(uint256 indexed extraId)',
]);

/**
 * Какие из них сабграф индексирует (шаблон AgreementContract в
 * `subgraph/subgraph.yaml`). Остальные — `MarkedDone` и вся тройка Extra* —
 * меняют только состояние в цепи, и гонять ради них ожидание индексации,
 * сброс кэша прокси и перечитывание графовых запросов было бы работой впустую.
 */
const GRAPH_INDEXED_EVENTS = new Set([
  'Funded',
  'Activated',
  'Released',
  'AutoApproved',
  'DisputeRaised',
  'DisputeResolved',
  'DisputeResponded',
  'DisputeSplitNoVerdict',
  'DisputeUnanswered',
  'TimedOut',
  'ArbiterTimedOut',
]);

export function useDealLiveRefresh(dealAddress: string | undefined): void {
  const enabled = !!dealAddress && isAddress(dealAddress);

  const onLogs = useCallback((logs: unknown[]) => {
    // Цепные чтения несвежи от любого события сделки; деньги двигают только
    // выплатные, но `balanceOf` дёшев и раздельный учёт тут не окупается.
    refreshFromLogs(logs, { chain: ['deals', 'wallet'] });

    const indexed = logs.filter((log) =>
      GRAPH_INDEXED_EVENTS.has(String((log as { eventName?: string }).eventName)),
    );
    refreshFromLogs(indexed, { graph: ['deals'] });
  }, []);

  useWatchContractEvent({
    address: enabled ? (dealAddress as `0x${string}`) : undefined,
    abi: AGREEMENT_STATE_EVENTS,
    enabled,
    onLogs,
  });
}
