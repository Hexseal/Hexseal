'use client';

import { useCallback, useEffect } from 'react';
import { isAddress, parseAbi, type AbiEvent } from 'viem';
import { usePublicClient } from 'wagmi';
import { refreshFromLogs } from '@/lib/subgraphSync';
import { runChainWatch, type ChainWatchIO } from '@/lib/chainWatchGate';

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
 * ОДИН НАБЛЮДАТЕЛЬ, А НЕ ПЯТНАДЦАТЬ. Фильтр строится по НАБОРУ событий
 * (`events`), то есть `topics[0]` уходит на узел массивом и один опрос покрывает
 * весь список ниже. Адрес — конкретный клон, так что посторонних логов сюда
 * физически не попадает и фильтровать по пользователю не нужно: любое событие
 * этой сделки касается того, кто на неё смотрит.
 *
 * ⚠️ ТАКТ И ВИДИМОСТЬ (правка от 9 августа 2026, пункт 38). Опрос шёл раз в
 * шесть секунд круглые сутки, в том числе на свёрнутой вкладке — это десять
 * запросов в минуту к платному узлу за экран, на который никто не смотрит.
 * Теперь такт `DEAL_POLL_MS`, и слежение идёт только пока страница видима
 * (`lib/chainWatchGate`).
 *
 * ДОГОНА ЗДЕСЬ НАМЕРЕННО НЕТ — курсор в `runChainWatch` не передаётся. При
 * возврате во вкладку `VisibilityRefresher` (app/providers.tsx) и так сбрасывает
 * ВСЕ запросы разом, то есть экран сделки перечитывается целиком; второй догон
 * стоил бы двух запросов ради того, что уже сделано.
 *
 * ERC-721 события (`Transfer`, `Approval`) в ABI не входят и в фильтр не
 * попадают: чек минтится в `fund()`, то есть в одной транзакции с `Funded`, и
 * отдельного повода перечитывать не даёт.
 */
/**
 * Такт опроса живого экрана сделки. Чаще, чем у колокольчика (двадцать секунд):
 * здесь человек смотрит на состояние сделки и ждёт, когда контрагент нажмёт.
 * Двенадцать вместо шести — вдвое дешевле при задержке, которой на глаз не
 * видно; при этом своё нажатие обновляет экран сразу, из обработчика кнопки.
 */
export const DEAL_POLL_MS = 12_000;

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
  const publicClient = usePublicClient();

  const onLogs = useCallback((logs: unknown[]) => {
    // Цепные чтения несвежи от любого события сделки; деньги двигают только
    // выплатные, но `balanceOf` дёшев и раздельный учёт тут не окупается.
    refreshFromLogs(logs, { chain: ['deals', 'wallet'] });

    const indexed = logs.filter((log) =>
      GRAPH_INDEXED_EVENTS.has(String((log as { eventName?: string }).eventName)),
    );
    refreshFromLogs(indexed, { graph: ['deals'] });
  }, []);

  useEffect(() => {
    if (!enabled || !publicClient) return;
    if (typeof document === 'undefined') return;
    const address = dealAddress as `0x${string}`;

    const io: ChainWatchIO = {
      watch: (deliver, onError) =>
        publicClient.watchEvent({
          address,
          events: AGREEMENT_STATE_EVENTS as unknown as AbiEvent[],
          pollingInterval: DEAL_POLL_MS,
          onLogs: (logs) => deliver(logs as unknown[]),
          onError,
        }),
      // Без курсора эти двое не зовутся ни разу — догона здесь нет, см. шапку.
      blockNumber: () => publicClient.getBlockNumber(),
      getLogs: async () => [],
    };

    return runChainWatch({
      io,
      doc: document,
      onLogs,
      onError: (error, phase) => {
        console.warn(`[hexseal] живое обновление сделки (${phase}) не удалось:`, error);
      },
    });
  }, [enabled, dealAddress, publicClient, onLogs]);
}
