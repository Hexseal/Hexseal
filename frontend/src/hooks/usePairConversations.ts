'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { useXmtp } from '@/contexts/XmtpContext';
import { getXmtpClientIfCached, listPairConversations, listPairConversationsLocal, type PairConversation } from '@/lib/xmtp';

// Module-level cache — survives navigation (same as board page SWR pattern).
// Keyed by wallet address lowercase → last known conversation list.
// Populated after every successful load so the next mount renders instantly.
const _convCache = new Map<string, PairConversation[]>();

// NOTE: a former mergeWithLocalPeers() helper used to surface every
// `hexseal_chat_seen_*` localStorage key as a conversation row. Those keys are
// written eagerly just by opening /chat?peer=X (ChatPanel mount/focus) — long
// before any real message or MLS group exists — and are never cleaned up, so they
// showed up as permanent PHANTOM conversations. Removed: real conversations come
// from _buildPairConversations, on-chain deal counterparties are merged in
// chat/page.tsx, and the URL-selected peer is force-rendered there too. The
// seen-keys remain solely for unread tracking (seenAt / hasUnread).

export function usePairConversations(isEnabled = false) {
  const { address } = useAccount();
  const { status } = useXmtp();

  const addrLc = address?.toLowerCase();
  const [conversations, setConversations] = useState<PairConversation[]>(() =>
    addrLc ? (_convCache.get(addrLc) ?? []) : []
  );
  const [isLoading, setIsLoading]         = useState(false);
  const [error, setError]                 = useState<string | null>(null);

  const addressRef = useRef(address);
  useEffect(() => { addressRef.current = address; });

  // Reset the visible list the instant the wallet address changes — before load()
  // has a chance to run. Without this, a same-device account switch keeps showing
  // the PREVIOUS account's conversation list (peer addresses, last messages) until
  // the effect below re-fires and load() actually resolves, which can take a while
  // (or never happen at all if XMTP isn't cached yet for the new address).
  const prevAddrRef = useRef(addrLc);
  useEffect(() => {
    if (prevAddrRef.current === addrLc) return;
    prevAddrRef.current = addrLc;
    setConversations(addrLc ? (_convCache.get(addrLc) ?? []) : []);
  }, [addrLc]);

  const load = useCallback(async () => {
    const addr = addressRef.current;
    if (!addr) return;
    // Use the already-initialized client — never trigger a new init here.
    // If status isn't 'ready', XmtpContext is still loading or disabled.
    const xmtp = getXmtpClientIfCached(addr);
    if (!xmtp) return;
    setIsLoading(true);
    setError(null);
    try {
      // Phase 1: read from local SQLite cache — no network, near-instant.
      // Shows conversations immediately so the UI never stares at a spinner.
      const local = await listPairConversationsLocal(xmtp, addr);
      _convCache.set(addr.toLowerCase(), local);
      setConversations(local);
      // Only stop loading after Phase 1 if we already have data.
      // If local cache is empty, keep the skeleton visible during Phase 2
      // (network sync) so the user never sees the false "no conversations" state.
      if (local.length > 0) setIsLoading(false);

      // Phase 2: full network sync — fetches groups/messages from XMTP network.
      const fresh = await listPairConversations(xmtp, addr);
      _convCache.set(addr.toLowerCase(), fresh);
      setConversations(fresh);
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Failed to load conversations';
      const isLimit = raw.includes('10/10') || raw.includes('registered 10');
      setError(isLimit
        ? 'Too many active XMTP sessions (10/10). Visit xmtp.chat → Settings → Revoke installations, then reload.'
        : raw);
    } finally {
      // ОБЯЗАТЕЛЬНО в `finally`, а не только в ветке успеха с непустым
      // результатом выше. Ранний сброс на 66-й строке снимает скелетон, только
      // если в локальном кэше уже что-то было; успешная фаза 2, вернувшая
      // ПУСТОЙ список, флаг не сбрасывала вообще. У человека без переписок и с
      // чистым кэшем (новый пользователь, новое устройство, очищенный
      // браузер) `isLoading` оставался true навсегда: скелетон в списке чатов
      // висел вечно, честное пустое состояние «переписок нет» не
      // отрисовывалось никогда, а кнопка обновления оставалась заблокированной.
      // То есть нормальный, полностью успешный исход выглядел как вечная
      // загрузка — ровно тот случай, когда исправная работа притворяется
      // поломкой, а поломка неотличима от неё.
      setIsLoading(false);
    }
  }, []); // stable — reads address via ref

  // Load when client becomes ready or address changes.
  // status dep ensures we trigger when XmtpContext transitions loading → ready.
  useEffect(() => {
    if (address && isEnabled && status === 'ready') load();
  }, [address, isEnabled, status, load]);

  const ready = isEnabled && status === 'ready';

  // Auto-poll every 30s as fallback
  useEffect(() => {
    if (!address || !ready) return;
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [address, ready, load]);

  // Instant update when usePairChat notifies of a new incoming message
  useEffect(() => {
    if (!address || !ready) return;
    window.addEventListener('hexseal-conv-update', load);
    return () => window.removeEventListener('hexseal-conv-update', load);
  }, [address, ready, load]);

  // Re-sync immediately when the tab regains focus (stream may have gone stale)
  useEffect(() => {
    if (!address || !ready) return;
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [address, ready, load]);

  return { conversations, isLoading, error, reload: load };
}
