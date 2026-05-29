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
    url: string;          // URL to (encrypted) blob on Storj
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
): string {
  return JSON.stringify({ _type: 'enc_file', name, url, size, mime, key, iv, ...chunkedOpts });
}

export type XmtpClient = Client;
export type XmtpGroup  = Awaited<ReturnType<XmtpClient['conversations']['createGroupWithIdentifiers']>>;
export type XmtpDm     = Awaited<ReturnType<XmtpClient['conversations']['createDmWithIdentifier']>>;

export type DmConversation = {
  dm: XmtpDm;
  peerAddress: string;
  lastText: string;
  lastAt: number;
  lastFromMe: boolean;
};

// ─── Identifier helper ────────────────────────────────────────────────────────

export function toIdentifier(address: string): Identifier {
  return {
    identifier: address.toLowerCase(),
    identifierKind: IdentifierKind.Ethereum,
  };
}

// ─── Installation ID tracking ─────────────────────────────────────────────────
// Used to detect when OPFS was cleared and a fresh installation was registered,
// so we can revoke the now-orphaned old installations automatically.

const installIdKey = (addr: string) => `xmtp-install-id-${addr.toLowerCase()}`;

// ─── Signer ───────────────────────────────────────────────────────────────────

export function createXmtpSigner(walletClient: WalletClient): Signer {
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

export async function initXmtpClient(walletClient: WalletClient): Promise<Client> {
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
      const signer = createXmtpSigner(walletClient);
      // Note: dbEncryptionKey is silently ignored by the XMTP WASM runtime.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = await Client.create(signer, { env: 'production' } as any);

      // Detect fresh installation (OPFS lost/cleared → new installationId).
      // Revoke the now-orphaned stale installations to prevent hitting the 10/10 limit.
      // revokeAllOtherInstallations() is a no-op (no wallet prompt) when nothing to revoke.
      const currentId = client.installationId;
      if (currentId) {
        const storedId = localStorage.getItem(installIdKey(address));
        if (storedId !== currentId) {
          try { await client.revokeAllOtherInstallations(); } catch { /* non-critical */ }
          localStorage.setItem(installIdKey(address), currentId);
        }
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

// ─── Deal group ───────────────────────────────────────────────────────────────

export function dealGroupName(agreementAddress: string): string {
  return `HSEAL-${agreementAddress.toLowerCase()}`;
}

/**
 * Finds an existing deal group or creates a new one.
 * Only adds members who have XMTP identities (checked via canMessage).
 */
export async function findOrCreateDealGroup(
  client: XmtpClient,
  agreementAddress: string,
  memberAddresses: string[],
): Promise<XmtpGroup> {
  const name = dealGroupName(agreementAddress);

  await client.conversations.sync();

  const groups = await client.conversations.listGroups();
  for (const g of groups) {
    if (g.name === name) {
      await g.sync();
      return g;
    }
  }

  // Filter to addresses that have registered XMTP identities
  const identifiers = memberAddresses.map(toIdentifier);
  const canMsg = await client.canMessage(identifiers);
  const reachable = identifiers.filter((id) => canMsg.get(id.identifier) === true);

  return client.conversations.createGroupWithIdentifiers(reachable, {
    groupName: name,
    groupDescription: `Hexseal deal: ${agreementAddress}`,
  });
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
      if (
        (p._type === 'enc_file' || p._type === 'file') &&
        typeof p.name === 'string' &&
        typeof p.url  === 'string'
      ) {
        return {
          text: p.name,
          attachment: {
            name:       p.name,
            url:        p.url,
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

export function normalizeDmMessage(
  msg: DecodedMessage,
  myInboxId: string,
  myAddress: string,
  peerAddress: string,
): ChatMessage | null {
  const parsed = parseContent(msg);
  if (!parsed) return null;
  const isFromMe = msg.senderInboxId === myInboxId;
  return {
    id: msg.id,
    from: isFromMe ? myAddress.toLowerCase() : peerAddress.toLowerCase(),
    timestamp: msg.sentAt.getTime(),
    isFromMe,
    ...parsed,
  };
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

export async function loadDmMessages(
  dm: XmtpDm,
  myInboxId: string,
  myAddress: string,
  peerAddress: string,
  beforeNs?: bigint,
): Promise<LoadedMessages> {
  const raw = await dm.messages({
    direction: SortDirection.Descending, // newest first
    limit:     MSG_PAGE_SIZE,
    ...(beforeNs ? { beforeNs } : {}),
  });

  const oldestNs = raw.length > 0 ? (raw[raw.length - 1].sentAtNs ?? null) : null;
  const messages = [...raw]
    .reverse()
    .map((m)  => normalizeDmMessage(m, myInboxId, myAddress, peerAddress))
    .filter((m): m is ChatMessage => m !== null);

  return { messages, hasMore: BigInt(raw.length) === MSG_PAGE_SIZE, oldestNs };
}

// ─── Conversation list ────────────────────────────────────────────────────────

export async function listDmConversations(client: XmtpClient): Promise<DmConversation[]> {
  await client.conversations.sync();
  const dms = await client.conversations.listDms();
  const myInboxId = client.inboxId ?? '';
  const result: DmConversation[] = [];

  for (const dm of dms) {
    try {
      await dm.sync();
      const peerInboxId = await dm.peerInboxId();
      const members = await dm.members();
      const peer = members.find(m => m.inboxId === peerInboxId);
      if (!peer) continue;
      const peerAddress = peer.accountIdentifiers[0]?.identifier?.toLowerCase();
      if (!peerAddress) continue;

      const msgs = await dm.messages({ limit: BigInt(1), direction: SortDirection.Descending });
      const last = msgs[0];
      let lastText = '';
      let lastAt = 0;

      let lastFromMe = true;
      if (last) {
        lastAt = last.sentAtNs ? Number(last.sentAtNs) / 1_000_000 : 0;
        const isFromMe = last.senderInboxId === myInboxId;
        lastFromMe = isFromMe;
        const content = typeof last.content === 'string' ? last.content : '';
        if (content.startsWith('{')) {
          try { const p = JSON.parse(content) as { name?: string }; lastText = p.name ? `📎 ${p.name}` : content; }
          catch { lastText = content; }
        } else {
          lastText = isFromMe ? `You: ${content}` : content;
        }
      }

      result.push({ dm, peerAddress, lastText, lastAt, lastFromMe });
    } catch {
      // skip malformed conversations
    }
  }

  return result.sort((a, b) => b.lastAt - a.lastAt);
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
