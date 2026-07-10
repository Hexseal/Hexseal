'use client';

/**
 * xmtp.ts — XMTP v3 (browser-sdk) helpers
 *
 * Uses MLS group messaging (no dependency on crypto.subtle — MetaMask compatible).
 * Deal chats use groups named "HSEAL-{agreementAddress}".
 * Direct chats (DMs) use XMTP 1:1 conversations.
 */

import {
  Client,
  GroupMessageKind,
  IdentifierKind,
  SortDirection,
} from '@xmtp/browser-sdk';
import type { DecodedMessage, GroupMember, Identifier } from '@xmtp/browser-sdk';
import type { Signer } from '@xmtp/browser-sdk';
import { toBytes } from 'viem';
import type { WalletClient } from 'viem';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChatMessage = {
  id: string;
  from: string;           // lowercase 0x address
  text: string;           // display text (file name for attachments)
  timestamp: number;      // ms since epoch
  isFromMe: boolean;
  attachment?: {          // present for file messages
    name: string;
    url: string;          // presigned download URL (expires in 6 days)
    storjKey?: string;    // Storj object key — used to refresh expired URL
    size?: number;        // original plaintext file size in bytes
    mime?: string;
    key?: string;         // AES-256-GCM key, hex
    iv?:  string;         // AES-256-GCM base IV, hex
    // Large-file chunked fields (present when chunked === true)
    chunked?: boolean;
    chunkCount?: number;
    chunkSize?: number;   // plaintext bytes per chunk (always CHUNK_SIZE = 8 MB)
  };
};

/**
 * Encode a file message for transmission over XMTP.
 * If key + iv are provided the blob at `url` is AES-256-GCM encrypted;
 * omit them for legacy unencrypted files.
 */
export function encodeFileMessage(
  name: string,
  url: string,
  size?: number,
  mime?: string,
  key?: string,
  iv?:  string,
  chunkedOpts?: { chunked: true; chunkCount: number; chunkSize: number },
  storjKey?: string,
): string {
  return JSON.stringify({ _type: 'enc_file', name, url, storjKey, size, mime, key, iv, ...chunkedOpts });
}

export type XmtpClient = Client;
export type XmtpGroup  = Awaited<ReturnType<XmtpClient['conversations']['createGroupWithIdentifiers']>>;

// ─── Identifier helper ────────────────────────────────────────────────────────

export function toIdentifier(address: string): Identifier {
  return {
    identifier: address.toLowerCase(),
    identifierKind: IdentifierKind.Ethereum,
  };
}

// ─── Session helpers ──────────────────────────────────────────────────────────

// No TTL — session persists until user explicitly disconnects messaging.
// OPFS stores the XMTP keys permanently; localStorage flag is just the enable/disable toggle.

const registeredKey = (addr: string) => `xmtp-registered-${addr.toLowerCase()}`;
const expiryKey     = (addr: string) => `xmtp-expiry-${addr.toLowerCase()}`; // kept for legacy cleanup only
const installIdKey  = (addr: string) => `xmtp-install-id-${addr.toLowerCase()}`;

/** Check whether the XMTP OPFS database file exists for this address.
 *  If it exists, Client.create() will NOT require a wallet signature.
 *  If it's gone (browser cleared storage), signing would be needed — we
 *  avoid that by clearing the session instead.
 *
 *  We enumerate the OPFS root directory instead of exact-name lookup because
 *  the XMTP WASM runtime may append a suffix (.db, .db3, etc.) to dbPath.
 */
export async function checkXmtpDbExists(address: string): Promise<boolean> {
  try {
    const root   = await navigator.storage.getDirectory();
    const prefix = `xmtp-${address.toLowerCase()}`;

    // Primary: .entries() scan works in Chrome/Firefox.
    // On some WebKit/iOS versions it silently yields nothing even when files exist,
    // so we track whether it ever yielded an entry; if it did, the scan was complete.
    let yieldedAny = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const iter = (root as any).entries() as AsyncIterable<[string, FileSystemHandle]>;
      for await (const [name] of iter) {
        yieldedAny = true;
        if (name.startsWith(prefix)) return true;
      }
    } catch { /* entries() not supported — fall through to direct probe */ }

    // If entries() yielded at least one file we trust it found everything.
    if (yieldedAny) return false;

    // entries() yielded nothing — could be iOS WebKit bug rather than truly empty.
    // Probe known file-name patterns the XMTP WASM runtime may use.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rootHandle = root as any;
    for (const suffix of ['.db3', '.db', '-shm', '-wal', '']) {
      try {
        await rootHandle.getFileHandle(`${prefix}${suffix}`);
        return true;
      } catch { /* not found with this suffix */ }
    }
    return false;
  } catch {
    return false;
  }
}

/** Clear XMTP session state for this address (localStorage flag + in-memory cache).
 *  OPFS keys file is intentionally kept — re-enabling won't require a wallet signature.
 *  Dispatches a DOM event so any mounted useXmtpStatus instances update immediately.
 */
export function clearXmtpSession(address: string): void {
  const addr = address.toLowerCase();
  localStorage.removeItem(registeredKey(addr));
  localStorage.removeItem(expiryKey(addr));
  localStorage.removeItem(installIdKey(addr));
  _clientCache.delete(addr);
  window.dispatchEvent(new CustomEvent('hexseal:xmtp-session-cleared', { detail: addr }));
}

// ─── Signer ───────────────────────────────────────────────────────────────────

export function createXmtpSigner(
  walletClient: WalletClient,
  onSignStep?: (step: number) => void,
): Signer {
  let signCount = 0;
  return {
    type: 'EOA' as const,
    getIdentifier: () => toIdentifier(walletClient.account!.address),
    // The TypeScript type omits getChainId for EOA, but the XMTP WASM runtime
    // calls it via duck typing when publishing identity updates. Without it the
    // runtime falls back to chainId=0, causing "Wrong chain id. Initially added
    // with 8453 but now signing from 0". Production env anchors to Base mainnet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getChainId: () => BigInt(8453) as any,
    signMessage: async (message: string): Promise<Uint8Array> => {
      signCount++;
      onSignStep?.(signCount);
      const sig = await walletClient.signMessage({
        account: walletClient.account!,
        message,
      });
      return toBytes(sig);
    },
  } as unknown as Signer;
}

// ─── Client init ──────────────────────────────────────────────────────────────

// Singleton caches — prevent multiple Client.create() calls for the same address
// (React StrictMode double-mounts, concurrent hooks, etc.)
const _clientCache:  Map<string, Client>          = new Map();
const _initPromises: Map<string, Promise<Client>> = new Map();

// Returns the cached client for this address if it was already initialized in this
// browser session — without triggering any wallet signatures. Returns null otherwise.
export function getXmtpClientIfCached(address: string): Client | null {
  return _clientCache.get(address.toLowerCase()) ?? null;
}

export async function initXmtpClient(walletClient: WalletClient, onSignStep?: (step: number) => void): Promise<Client> {
  // XMTP WASM requires OPFS (Origin Private File System) which is only available
  // on secure contexts (localhost or https). Check BEFORE spawning the worker so
  // the error surfaces on the main thread as a friendly message rather than
  // an uncaught worker exception.
  try {
    await navigator.storage.getDirectory();
  } catch {
    throw new Error(
      'Messaging requires a secure context. Open the app via http://localhost:3001 (not an IP address), or use HTTPS in production.',
    );
  }

  const address = walletClient.account!.address.toLowerCase();

  // Return already-built client
  const cached = _clientCache.get(address);
  if (cached) return cached;

  // Return in-flight promise so concurrent callers share one Client.create() call
  const inFlight = _initPromises.get(address);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      const signer = createXmtpSigner(walletClient, onSignStep);
      // dbPath: per-address OPFS path so different wallets on the same browser
      // don't share (and clobber) each other's MLS database.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = await Client.create(signer, { env: 'production', dbPath: `xmtp-${address}` } as any);

      // Track installationId to detect OPFS clears across sessions.
      // We do NOT auto-revoke other installations here — revokeAllOtherInstallations()
      // requires a wallet signature even when nothing to revoke, which was triggering
      // an extra sign prompt on every fresh installation (first use AND OPFS clear).
      // Users who hit the 10/10 limit see a clear error message and can clean up via
      // xmtp.chat → Settings → Revoke installations.
      const currentId = client.installationId;
      if (currentId) {
        localStorage.setItem(installIdKey(address), currentId);
      }

      _clientCache.set(address, client);
      return client;
    } finally {
      _initPromises.delete(address);
    }
  })();

  _initPromises.set(address, promise);
  return promise;
}

/**
 * Tries to add a member to an existing group.
 * Silently skips if the address hasn't registered XMTP yet.
 */
export async function tryAddGroupMember(
  group: XmtpGroup,
  address: string,
  client: XmtpClient,
): Promise<void> {
  const id = toIdentifier(address);
  const canMsg = await client.canMessage([id]);
  if (canMsg.get(id.identifier) === true) {
    await group.addMembersByIdentifiers([id]);
  }
}

// ─── Pair group ────────────────────────────────────────────────────────────────
// One persistent MLS group per counterparty pair replaces the old DM/deal-group
// split. Created on first contact (before any deal exists) and reused for every
// subsequent deal between the same two addresses.

/** Sorts two addresses into a stable, deterministic order (lowercase). */
export function sortAddressPair(a: string, b: string): [string, string] {
  const lc: [string, string] = [a.toLowerCase(), b.toLowerCase()];
  return lc[0] <= lc[1] ? lc : [lc[1], lc[0]];
}

/** Group name for the single persistent conversation between two addresses. */
export function pairGroupName(addrA: string, addrB: string): string {
  const [a, b] = sortAddressPair(addrA, addrB);
  return `HSEAL-PAIR-${a}-${b}`;
}

/**
 * Finds the existing pair group for these two addresses or creates it.
 * Includes the bot (if reachable) from the very first message, so deal
 * notifications and dispute logging work before any deal exists.
 */
export async function findOrCreatePairGroup(
  client: XmtpClient,
  memberAddresses: [string, string],
  botAddress: string | null,
): Promise<XmtpGroup> {
  const name = pairGroupName(memberAddresses[0], memberAddresses[1]);

  await client.conversations.sync();

  const groups = await client.conversations.listGroups();
  for (const g of groups) {
    if (g.name === name) {
      await g.sync();
      return g;
    }
  }

  const allMembers = botAddress ? [...memberAddresses, botAddress] : [...memberAddresses];
  const identifiers = allMembers.map(toIdentifier);
  const canMsg = await client.canMessage(identifiers);
  const reachable = identifiers.filter((id) => canMsg.get(id.identifier) === true);

  return client.conversations.createGroupWithIdentifiers(reachable, {
    groupName: name,
    groupDescription: `Hexseal conversation: ${memberAddresses[0]} <-> ${memberAddresses[1]}`,
  });
}

// ─── Deal-context marker ───────────────────────────────────────────────────────
// A silent message that tags "from this point in the group, messages are about
// deal X" (or null = general chat, no active deal). Consumed only by the relayer
// bot to tag entries in the arbiter dispute log — parseContent() below filters
// it out of the UI message list entirely, it never renders as a chat bubble.

export function encodeDealContextMarker(dealId: string | null): string {
  return JSON.stringify({ _type: 'deal_ctx', dealId });
}

// ─── Message helpers ──────────────────────────────────────────────────────────

export function buildInboxAddressMap(members: GroupMember[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of members) {
    const addr = m.accountIdentifiers[0]?.identifier?.toLowerCase();
    if (addr) map.set(m.inboxId, addr);
  }
  return map;
}

type ParsedContent = { text: string; attachment?: ChatMessage['attachment'] };

function parseContent(msg: DecodedMessage): ParsedContent | null {
  if (msg.kind !== GroupMessageKind.Application) return null;
  if (typeof msg.content !== 'string' || !msg.content) return null;

  // Detect file attachment messages (enc_file = encrypted, file = legacy unencrypted)
  if (msg.content.startsWith('{')) {
    try {
      const p = JSON.parse(msg.content) as Record<string, unknown>;
      if (p._type === 'deal_ctx') return null; // silent marker — never rendered
      if (
        (p._type === 'enc_file' || p._type === 'file') &&
        typeof p.name === 'string' &&
        typeof p.url  === 'string'
      ) {
        const storjKey = typeof p.storjKey === 'string' ? p.storjKey : undefined;
        // Reconstruct download URL from current relayer base — baked URLs go stale when ngrok rotates
        const RELAYER = (process.env.NEXT_PUBLIC_RELAYER_URL ?? 'http://localhost:3001').replace(/\/$/, '');
        const resolvedUrl = storjKey ? `${RELAYER}/files/${storjKey}` : (p.url as string);
        return {
          text: p.name,
          attachment: {
            name:       p.name,
            url:        resolvedUrl,
            storjKey,
            size:       typeof p.size       === 'number'  ? p.size       : undefined,
            mime:       typeof p.mime       === 'string'  ? p.mime       : undefined,
            key:        typeof p.key        === 'string'  ? p.key        : undefined,
            iv:         typeof p.iv         === 'string'  ? p.iv         : undefined,
            chunked:    p.chunked === true                ? true         : undefined,
            chunkCount: typeof p.chunkCount === 'number'  ? p.chunkCount : undefined,
            chunkSize:  typeof p.chunkSize  === 'number'  ? p.chunkSize  : undefined,
          },
        };
      }
    } catch { /* not JSON — fall through to plain text */ }
  }

  return { text: msg.content };
}

export function normalizeGroupMessage(
  msg: DecodedMessage,
  myInboxId: string,
  myAddress: string,
  inboxToAddr: Map<string, string>,
): ChatMessage | null {
  const parsed = parseContent(msg);
  if (!parsed) return null;
  const isFromMe = msg.senderInboxId === myInboxId;
  const from = isFromMe
    ? myAddress.toLowerCase()
    : (inboxToAddr.get(msg.senderInboxId) ?? msg.senderInboxId);
  return { id: msg.id, from, timestamp: msg.sentAt.getTime(), isFromMe, ...parsed };
}

// ─── History loading ──────────────────────────────────────────────────────────


const MSG_PAGE_SIZE = 50n;

export interface LoadedMessages {
  messages:  ChatMessage[];
  hasMore:   boolean;       // true if there may be older messages to load
  oldestNs:  bigint | null; // sentAtNs of the oldest message — cursor for next page
}

export async function loadGroupMessages(
  group: XmtpGroup,
  myInboxId: string,
  myAddress: string,
  beforeNs?: bigint,
): Promise<LoadedMessages> {
  const members     = await group.members();
  const inboxToAddr = buildInboxAddressMap(members);
  const raw         = await group.messages({
    direction: SortDirection.Descending, // newest first
    limit:     MSG_PAGE_SIZE,
    ...(beforeNs ? { beforeNs } : {}),
  });

  const oldestNs = raw.length > 0 ? (raw[raw.length - 1].sentAtNs ?? null) : null;
  const messages = [...raw]
    .reverse()
    .map((m)  => normalizeGroupMessage(m, myInboxId, myAddress, inboxToAddr))
    .filter((m): m is ChatMessage => m !== null);

  return { messages, hasMore: BigInt(raw.length) === MSG_PAGE_SIZE, oldestNs };
}

// ─── Pair conversation list (sidebar) ──────────────────────────────────────────

export type PairConversation = {
  group: XmtpGroup;
  peerAddress: string;
  lastText: string;
  lastAt: number;
  lastFromMe: boolean;
};

const PAIR_PREFIX = 'HSEAL-PAIR-';

export async function listPairConversations(
  client: XmtpClient,
  myAddress: string,
): Promise<PairConversation[]> {
  await client.conversations.sync();
  const groups = await client.conversations.listGroups();
  const myInboxId = client.inboxId ?? '';
  const myLc = myAddress.toLowerCase();
  const result: PairConversation[] = [];

  for (const g of groups) {
    const name = g.name ?? '';
    if (!name.startsWith(PAIR_PREFIX)) continue;
    try {
      await g.sync();
      const members = await g.members();
      const inboxToAddr = buildInboxAddressMap(members);
      const peerAddress = [...inboxToAddr.values()].find(addr => addr !== myLc);
      if (!peerAddress) continue;

      // Read up to 5 to skip silent deal_ctx markers when building the preview.
      const msgs = await g.messages({ limit: BigInt(5), direction: SortDirection.Descending });
      let lastText = '';
      let lastAt = msgs[0] ? (msgs[0].sentAtNs ? Number(msgs[0].sentAtNs) / 1_000_000 : 0) : 0;
      let lastFromMe = msgs[0] ? msgs[0].senderInboxId === myInboxId : true;

      for (const msg of msgs) {
        const parsed = parseContent(msg);
        if (parsed) {
          const fromMe = msg.senderInboxId === myInboxId;
          lastText = parsed.attachment
            ? `📎 ${parsed.attachment.name}`
            : (fromMe ? `You: ${parsed.text}` : parsed.text);
          break;
        }
      }

      result.push({ group: g, peerAddress, lastText, lastAt, lastFromMe });
    } catch {
      // skip malformed conversations
    }
  }

  return result.sort((a, b) => b.lastAt - a.lastAt);
}

// ─── Relay bot address ────────────────────────────────────────────────────────

const RELAYER_URL_XMTP = process.env.NEXT_PUBLIC_RELAYER_URL ?? 'http://localhost:3001';
let _botAddress: string | null = null;

export async function getBotAddress(): Promise<string | null> {
  if (_botAddress) return _botAddress;
  try {
    const res = await fetch(`${RELAYER_URL_XMTP}/bot-address`);
    const { address } = await res.json() as { address: string };
    _botAddress = address.toLowerCase();
    return _botAddress;
  } catch {
    return null; // non-fatal — group works without bot, just no log
  }
}

// ─── Arbiter notifications ────────────────────────────────────────────────────

export async function notifyArbiters(
  client: XmtpClient,
  agreementAddress: string,
  arbiters: string[],
): Promise<void> {
  const msg = `[Hexseal] New dispute on deal ${agreementAddress}. Check your Arbiter Hub.`;
  for (const arbiter of arbiters) {
    try {
      const id = toIdentifier(arbiter);
      const canMsg = await client.canMessage([id]);
      if (!canMsg.get(id.identifier)) continue;
      const dm = await client.conversations.createDmWithIdentifier(id);
      await dm.sendText(msg);
    } catch {
      // Non-critical — arbiter may not have XMTP identity yet
    }
  }
}
