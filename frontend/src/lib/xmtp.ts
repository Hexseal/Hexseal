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
  LogLevel,
  SortDirection,
  isReadReceipt,
} from '@xmtp/browser-sdk';
import type { DecodedMessage, GroupMember, Identifier } from '@xmtp/browser-sdk';
import type { Signer } from '@xmtp/browser-sdk';
import { toBytes } from 'viem';
import type { WalletClient } from 'viem';
import { withWalletLock } from '@/lib/walletLock';
import {
  ensurePeerInGroup, blocksDelivery, PEER_UNREACHABLE_MESSAGE,
} from '@/lib/xmtpDelivery';

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
    fileKey?: string;     // relayer file key — used to reconstruct download URL
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

export function encodeFileMessage(
  name: string,
  url: string,
  size?: number,
  mime?: string,
  key?: string,
  iv?:  string,
  chunkedOpts?: { chunked: true; chunkCount: number; chunkSize: number },
  fileKey?: string,
): string {
  return JSON.stringify({ _type: 'enc_file', name, url, fileKey, size, mime, key, iv, ...chunkedOpts });
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

// Здесь раньше жил `checkXmtpDbExists()` — эвристика, которая перечисляла
// корень OPFS и по именам файлов ГАДАЛА, поднимется ли `Client.create()` без
// подписи. Гадание убрано вместе с функцией: авто-путь теперь строит клиента
// через `Client.build()` + `isRegistered()` (см. `buildXmtpClient` ниже), то
// есть спрашивает у самого SDK, есть ли уже личность, вместо того чтобы
// угадывать это по разметке хранилища. Промах эвристики стоил дорого: ложное
// «база есть» вело прямиком в `Client.create()`, а тот молча просил подпись.

/** Clear XMTP session state for this address (localStorage flag + in-memory cache).
 *  OPFS keys file is intentionally kept — re-enabling won't require a wallet signature.
 *  Dispatches a DOM event so XmtpContext can react immediately.
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
      // Под общим мьютексом кошелька: пока идёт любой другой запрос подписи
      // (гейслесс-действие, push, профиль), второй улетел бы в кошелёк как
      // -32002 'already pending', а в мобильном MetaMask такой запрос не
      // отменяется ничем, кроме полного закрытия приложения кошелька.
      const sig = await withWalletLock(walletClient.account!.address, () =>
        walletClient.signMessage({
          account: walletClient.account!,
          message,
        }),
      );
      return toBytes(sig);
    },
  } as unknown as Signer;
}

// ─── Crash breadcrumbs (temporary Android debug) ────────────────────────────────
// The XMTP WASM worker can take down the whole browser tab on memory-tight Android
// devices — and a crashing tab wipes the console before any remote debugger (which
// we can't attach to a borrowed test phone anyway) could read it. So we drop a
// timestamped step into localStorage before every heavy XMTP operation. localStorage
// survives the crash, so the next page load can show exactly which operation was
// in flight when the tab died. Key is mirrored (snapshot + reader) in providers.tsx.
const CRUMB_KEY = 'hexseal-xmtp-crumb';
export function xmtpCrumb(step: string): void {
  try {
    // WASM linear memory isn't counted here, but a climbing JS heap is still a hint.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mem = (performance as any)?.memory?.usedJSHeapSize as number | undefined;
    const heap = mem ? ` [${Math.round(mem / 1048576)}mb]` : '';
    const t = new Date().toISOString().slice(11, 23);
    const prev = localStorage.getItem(CRUMB_KEY);
    const trail = (prev ? prev.split('\n') : []).concat(`${t} ${step}${heap}`).slice(-28);
    localStorage.setItem(CRUMB_KEY, trail.join('\n'));
  } catch { /* localStorage unavailable — diagnostics are best-effort */ }
}

// ─── Client init ──────────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let id: ReturnType<typeof setTimeout>;
  const timer = new Promise<never>((_, reject) => { id = setTimeout(() => reject(new Error(msg)), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(id));
}

// Singleton caches — prevent multiple Client.create() calls for the same address
// (React StrictMode double-mounts, concurrent hooks, etc.)
const _clientCache:  Map<string, Client>          = new Map();
const _initPromises: Map<string, Promise<Client>> = new Map();
// Bumped by abandonXmtpInit() so a still-running attempt (Client.create() has
// no AbortSignal — it can't actually be cancelled) can recognize, once it
// finally does resolve, that it's been superseded and must not overwrite
// whatever a newer attempt already produced (or clear a session the user
// just disabled).
const _generation: Map<string, number> = new Map();

// Returns the cached client for this address if it was already initialized in this
// browser session — without triggering any wallet signatures. Returns null otherwise.
export function getXmtpClientIfCached(address: string): Client | null {
  return _clientCache.get(address.toLowerCase()) ?? null;
}

/** True while a Client.create() attempt for this address is already in flight.
 *  Callers that might re-fire auto-init (e.g. a visibilitychange/focus rearm)
 *  must check this first — retriggering while an attempt is already running
 *  doesn't start a second Client.create() (initXmtpClient dedupes via
 *  _initPromises), but it does re-run the caller's own pre-flight work
 *  (OPFS enumeration, etc.) on every foreground event, competing with the
 *  in-flight attempt's own OPFS/network access for the entire time it's
 *  pending — including while it's genuinely waiting on the wallet signature. */
export function isXmtpInitPending(address: string): boolean {
  return _initPromises.has(address.toLowerCase());
}

/** Evicts any in-flight initXmtpClient() attempt for this address, so the next
 *  call starts a fresh Client.create() instead of re-attaching to one that's
 *  stuck (e.g. waiting on a wallet signature the user backed out of, or a
 *  page that got backgrounded mid-signature — both common on Android), and
 *  marks the stuck attempt as superseded so if it does eventually resolve on
 *  its own, initXmtpClient() closes it instead of caching it. */
export function abandonXmtpInit(address: string): void {
  const addr = address.toLowerCase();
  _initPromises.delete(addr);
  _generation.set(addr, (_generation.get(addr) ?? 0) + 1);
}

/** Открывает УЖЕ ЗАРЕГИСТРИРОВАННУЮ личность XMTP — БЕЗ сайнера и, как
 *  следствие, без единого шанса запросить подпись кошелька.
 *
 *  Это штатный путь SDK, а не трюк: `Client.build(identifier, options)`
 *  создаёт клиента с `disableAutoRegister: true` и вообще не принимает сайнера
 *  (`@xmtp/browser-sdk` 7.0.0, `src/Client.ts`). Его докстрока говорит прямо:
 *  клиент обязан быть уже зарегистрирован, любой метод, которому нужен сайнер,
 *  бросит. Ровно это нам и нужно на автоматическом пути — он СТРУКТУРНО не
 *  способен показать человеку окно подписи, а не «обычно её не просит».
 *
 *  `isRegistered()` после сборки — дешёвая проверка «личность здесь есть».
 *  Без неё `build()` на пустом хранилище отдал бы вполне живой объект клиента,
 *  который развалился бы позже и в другом месте — на первом же вызове,
 *  которому нужен сайнер.
 *
 *  Подпись остаётся только за `initXmtpClient()` ниже — и он зовётся ТОЛЬКО из
 *  явного нажатия «включить мессенджер».
 *
 *  Делит кэши (`_clientCache`, `_initPromises`, `_generation`) с
 *  `initXmtpClient` намеренно: `isXmtpInitPending()` и `abandonXmtpInit()`
 *  должны видеть обе попытки одинаково, иначе rearm по возврату во вкладку
 *  начал бы наслаивать сборку поверх ещё не закончившейся сборки. */
export function buildXmtpClient(address: string): Promise<Client> {
  const addr = address.toLowerCase();

  const cached = _clientCache.get(addr);
  if (cached) return Promise.resolve(cached);

  const inFlight = _initPromises.get(addr);
  if (inFlight) return inFlight;

  // Снято до любого await — метка этой конкретной попытки, чтобы понять
  // потом, не вытеснил ли её abandonXmtpInit().
  const myGeneration = _generation.get(addr) ?? 0;

  // Ссылка на «сырое» обещание сборки. Как и у Client.create(), у Client.build()
  // нет AbortSignal: если сработает наш таймаут, воркер продолжит жить. Держим
  // ссылку, чтобы закрыть клиента, если он всё-таки доедет позже.
  let rawBuild: Promise<Client> | null = null;

  let promise!: Promise<Client>;
  promise = (async () => {
    try {
      // XMTP WASM требует OPFS — он есть только в защищённом контексте.
      try {
        await navigator.storage.getDirectory();
      } catch {
        throw new Error('XMTP_NO_OPFS');
      }
      // Просим браузер не вытеснять OPFS, чтобы личность пережила сессию.
      // Best-effort и молча — как в initXmtpClient.
      try { await navigator.storage.persist?.(); } catch { /* не поддержано */ }

      xmtpCrumb(`init:build-start ${addr.slice(0, 6)}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rawBuild = Client.build(toIdentifier(addr), { env: 'production', dbPath: `xmtp-${addr}`, loggingLevel: LogLevel.Error } as any) as Promise<Client>;

      // Потолок ниже, чем 90 с у initXmtpClient: там в бюджет входит живое
      // ожидание подписи человеком, здесь подписи нет по построению — только
      // подъём WASM/OPFS и сверка личности.
      const client = await withTimeout(rawBuild, 45_000, 'XMTP_TIMEOUT');
      xmtpCrumb('init:build-done');

      let registered = false;
      try {
        registered = await client.isRegistered();
      } catch {
        registered = false;
      }
      if (!registered) {
        // Личности здесь нет (первый вход, или хранилище вычистили). Это НЕ
        // повод молча просить подпись — закрываем и отдаём наверх отказ,
        // чтобы интерфейс предложил включить мессенджер явным нажатием.
        xmtpCrumb('init:build-unregistered');
        try { client.close(); } catch { /* уже закрыт */ }
        throw new Error('XMTP_NOT_REGISTERED');
      }

      if ((_generation.get(addr) ?? 0) !== myGeneration) {
        // abandonXmtpInit() отработал, пока мы собирались — более новая
        // попытка уже взяла управление (или адрес выключили).
        try { client.close(); } catch { /* уже закрыт */ }
        throw new Error('XMTP_ABANDONED');
      }

      xmtpCrumb('init:build-ok');
      _clientCache.set(addr, client);
      return client;
    } catch (err) {
      xmtpCrumb(`init:build-error ${err instanceof Error ? err.message.slice(0, 40) : 'unknown'}`);
      // Опоздавшая сборка не должна утечь воркером до конца жизни страницы.
      // Вешается строго здесь, после того как мы уже сдались, — гонки с
      // успешной веткой выше быть не может.
      const msg = err instanceof Error ? err.message : '';
      if (msg !== 'XMTP_ABANDONED' && msg !== 'XMTP_NOT_REGISTERED') {
        rawBuild?.then(c => { try { c.close(); } catch { /* уже закрыт */ } })
          .catch(() => { /* сама сборка упала — закрывать нечего */ });
      }
      throw err;
    } finally {
      // Удаляем только СВОЮ запись: опоздавшая попытка не должна выдернуть
      // из-под более новой её собственное, ещё живое обещание.
      if (_initPromises.get(addr) === promise) {
        _initPromises.delete(addr);
      }
    }
  })();

  _initPromises.set(addr, promise);
  return promise;
}

/** Создаёт клиента XMTP С САЙНЕРОМ — то есть путь, который МОЖЕТ запросить
 *  подпись кошелька (её просит фаза register()).
 *
 *  Зовётся ровно из одного места: явного нажатия «включить мессенджер»
 *  (`XmtpContext.retry()`). Автоматика сюда не ходит вообще — у неё есть
 *  `buildXmtpClient()` выше, который подписывать не умеет по построению. */
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

  // Ask the browser to keep OPFS durable so the MLS identity survives across
  // sessions. Without this, storage-tight mobile browsers (Brave especially)
  // evict the XMTP db between visits — forcing a brand-new installation, a fresh
  // wallet signature, and lost history every time (and burning toward the 10/10
  // installation cap). Best-effort and silent: never blocks init, granted by the
  // browser's own engagement heuristics.
  try { await navigator.storage.persist?.(); } catch { /* not supported */ }

  const address = walletClient.account!.address.toLowerCase();

  // Return already-built client
  const cached = _clientCache.get(address);
  if (cached) return cached;

  // Return in-flight promise so concurrent callers share one Client.create() call
  const inFlight = _initPromises.get(address);
  if (inFlight) return inFlight;

  // Captured now, before any await — identifies this specific attempt so it
  // can tell later whether abandonXmtpInit() superseded it in the meantime.
  const myGeneration = _generation.get(address) ?? 0;

  // Wrap onSignStep so we always crumb when the signer is actually invoked. A wallet
  // signature is only requested during register() — the FINAL phase, after WASM +
  // OPFS are already up. So if a device trail hits XMTP_TIMEOUT *without* an
  // `init:sign` crumb, the hang is in WASM/OPFS/worker (phases A–C), not at network
  // register (phase D). That single bit splits the tree in half.
  const signer = createXmtpSigner(walletClient, (step) => {
    xmtpCrumb(`init:sign step=${step}`);
    onSignStep?.(step);
  });

  // Fire-and-forget preflight probes — run CONCURRENTLY with Client.create() below so
  // they add zero latency to the happy path. XMTP's worker swallows WASM/OPFS failures
  // (it logs to the worker console and never rejects create()), so those otherwise
  // surface only as our opaque 90s XMTP_TIMEOUT — invisible on iOS where you can't open
  // the worker console. These crumb the two cheapest independent failure modes so a
  // device trail reads e.g. `probe:wasm=BLOCKED` (iOS Lockdown Mode disables WASM
  // engine-wide) or `probe:net=BLOCKED`, instead of one blind timeout.
  void (async () => {
    try {
      await WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      xmtpCrumb('probe:wasm=ok');
    } catch {
      xmtpCrumb('probe:wasm=BLOCKED');
    }
  })();
  void (async () => {
    try {
      await withTimeout(
        fetch('https://api.production.xmtp.network', { mode: 'no-cors' }).then(() => {}),
        8_000,
        'PROBE_NET',
      );
      xmtpCrumb('probe:net=ok');
    } catch {
      xmtpCrumb('probe:net=BLOCKED');
    }
  })();

  // dbPath: per-address OPFS path so different wallets on the same browser
  // don't share (and clobber) each other's MLS database.
  xmtpCrumb(`init:create-start ${address.slice(0, 6)}`);
  // loggingLevel Error: the WASM layer otherwise floods the console with INFO/WARN
  // noise on every stream reconnect (`stream closed`, `msg … has been seen, skipping`)
  // — benign, but it buries real errors and alarms users looking at the console.
  // Error keeps genuine failures; our own xmtpCrumb trail is separate and unaffected.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawCreate = Client.create(signer, { env: 'production', dbPath: `xmtp-${address}`, loggingLevel: LogLevel.Error } as any) as Promise<Client>;

  // Declared with a definite-assignment assertion (not `const promise =
  // (async () => {...})()`) so the finally block below can reference
  // `promise` itself — by the time that block runs, the assignment two
  // lines down has long since completed; TypeScript's control-flow analysis
  // just can't see that across the closure boundary.
  let promise!: Promise<Client>;
  promise = (async () => {
    try {
      // 90-second timeout: covers wallet signature + XMTP network identity publication.
      // If network is unreachable (e.g. blocked by ISP/firewall), surfaces an error
      // instead of spinning forever. The user can retry after checking connectivity.
      const client = await withTimeout(rawCreate, 90_000, 'XMTP_TIMEOUT');
      xmtpCrumb('init:create-done');

      if ((_generation.get(address) ?? 0) !== myGeneration) {
        // abandonXmtpInit() ran while Client.create() was still in flight — a
        // newer attempt has since taken over (or the address was disabled).
        // Close this straggler instead of overwriting what the newer one
        // produced (or reviving messaging the user just turned off).
        client.close();
        throw new Error('XMTP_ABANDONED');
      }
      xmtpCrumb('init:ok');

      // Persist installationId — write-only telemetry for manual debugging (e.g.
      // via xmtp.chat's installation list); nothing in this codebase reads it back
      // to compare against a fresh id and detect an OPFS clear automatically, so
      // don't rely on this for that despite what it might look like at a glance.
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
    } catch (err) {
      xmtpCrumb(`init:error ${err instanceof Error ? err.message.slice(0, 40) : 'unknown'}`);
      // Client.create() has no AbortSignal — timing out on it (or abandoning
      // it above) doesn't stop its WASM worker from running in the
      // background. If it resolves later, close it then instead of leaking
      // its worker for the rest of the page's lifetime. Attached only here,
      // strictly after we've already given up on this attempt, so it can
      // never race the success path above.
      if (!(err instanceof Error && err.message === 'XMTP_ABANDONED')) {
        rawCreate.then(client => { try { client.close(); } catch { /* already closed / never fully opened */ } })
          .catch(() => { /* Client.create() itself failed — nothing to close */ });
      }
      throw err;
    } finally {
      // Only remove our own map entry — a stuck attempt resolving late
      // (after abandonXmtpInit() already evicted it and a newer attempt
      // registered its own promise under the same address) must not delete
      // that newer, still in-flight promise out from under it.
      if (_initPromises.get(address) === promise) {
        _initPromises.delete(address);
      }
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
  /** false = look up only, never create (used when merely OPENING a chat).
   *  Creation — and the "peer must be XMTP-reachable" requirement — is deferred to
   *  the first actual send, so browsing leaves no empty groups behind and you can
   *  open/type a chat with someone who hasn't enabled messaging yet. */
  createIfMissing = true,
): Promise<XmtpGroup | null> {
  // Positional convention (see the one call site in usePairChat.ts): self first,
  // peer second. Needed below to tell "the group is missing someone" apart from
  // "the group is missing *the peer specifically*".
  const [myAddress, peerAddress] = memberAddresses;
  const name = pairGroupName(memberAddresses[0], memberAddresses[1]);

  // Only these addresses are allowed in a legitimate pair group.
  // MLS invariant: the group creator is always a member.
  // An attacker who creates a spoofed group with this name will always appear
  // in its member list — so filtering by expectedAddrs detects and skips it.
  const expectedAddrs = new Set<string>([
    memberAddresses[0].toLowerCase(),
    memberAddresses[1].toLowerCase(),
    ...(botAddress ? [botAddress.toLowerCase()] : []),
  ]);

  /** Returns true only if every member of g is in expectedAddrs. */
  async function isLegitimate(g: XmtpGroup): Promise<boolean> {
    try {
      const members = await g.members();
      return members.every(m => {
        const addr = m.accountIdentifiers[0]?.identifier?.toLowerCase() ?? '';
        return expectedAddrs.has(addr);
      });
    } catch {
      return false;
    }
  }

  // Best-effort: a churn-corrupted group can throw here (openmls SecretReuseError).
  // Swallow it so one bad group doesn't blank the whole chat to "unavailable" —
  // we proceed with whatever groups are already in the local cache.
  await client.conversations.sync().catch(() => {});

  const groups = await client.conversations.listGroups();
  const nameMatches = groups.filter(g => g.name === name);

  // Filter out attacker-created groups (unexpected members), then pick the
  // group with the smallest ID among legitimate ones so both clients converge
  // deterministically in the race-condition case (both created simultaneously).
  const legitGroups: XmtpGroup[] = [];
  for (const g of nameMatches) {
    if (await isLegitimate(g)) legitGroups.push(g);
  }

  if (legitGroups.length > 0) {
    const canonical = legitGroups.reduce((best, g) => g.id < best.id ? g : best);
    // Best-effort: if this specific group is churn-corrupted, load its cached
    // history rather than throwing and blanking the chat to "unavailable".
    await canonical.sync().catch(() => {});

    // Self-heal: the peer may have had no reachable installation at all when
    // this group was first created (e.g. mid session churn on their end) and
    // so was silently left out of it — every message sent since then exists
    // in a group they were never a member of and can never see. If they're
    // reachable now, add them so the conversation recovers instead of staying
    // one-sided forever. Best-effort: never block opening an existing
    // conversation over this.
    //
    // А вот отправку — блокирует: раньше эта же ветка при недостижимом
    // собеседнике молча возвращала группу без него, и любое сообщение туда
    // выглядело отправленным, не имея ни одного шанса дойти. Проверка теперь
    // общая с путём создания (lib/xmtpDelivery.ts) и повторяется перед каждой
    // отправкой в usePairChat — там же она и отказывает.
    await ensurePeerInGroup(canonical, client, toIdentifier(peerAddress));

    return canonical;
  }

  // No existing conversation. When we're only opening the chat, stop here and let
  // the UI render an empty (but usable) thread — the group is created on first send.
  if (!createIfMissing) return null;

  const allMembers = botAddress ? [...memberAddresses, botAddress] : [...memberAddresses];
  const identifiers = allMembers.map(toIdentifier);
  const canMsg = await client.canMessage(identifiers);
  const reachable = identifiers.filter((id) => canMsg.get(id.identifier) === true);

  // Refuse to create a conversation the peer can never see. Without this check,
  // an unreachable peer (no currently-registered XMTP installation — e.g. mid
  // session churn, or genuinely never opened Hexseal chat) is silently dropped
  // from `reachable` and the group gets created without them: the sender's
  // message goes into a group the recipient was never part of, with no error
  // and no way to ever discover it by re-syncing. Fail loudly instead so the
  // sender knows to retry rather than wonder why nothing arrived.
  const peerIdentifier = toIdentifier(peerAddress);
  if (canMsg.get(peerIdentifier.identifier) !== true) {
    // Message matched against in ChatPanel.tsx (error.includes('not registered')) to
    // trigger the "share an invite" UI instead of the generic connection-failed one —
    // covers both "never opened Hexseal chat" and "temporarily between XMTP installations".
    // Та же строка используется на пути отправки в уже существующую группу
    // (assertPeerCanReceive ниже) — оба отказа обязаны выглядеть одинаково.
    throw new Error(PEER_UNREACHABLE_MESSAGE);
  }

  const created = await client.conversations.createGroupWithIdentifiers(reachable, {
    groupName: name,
    groupDescription: `Hexseal conversation: ${myAddress} <-> ${peerAddress}`,
  });

  // Re-sync after creation: if the peer raced us, their group is now visible.
  // Apply the same membership filter so a racing attacker is still rejected.
  await client.conversations.sync();
  const afterMatches = (await client.conversations.listGroups()).filter(g => g.name === name);
  const afterLegit: XmtpGroup[] = [];
  for (const g of afterMatches) {
    if (await isLegitimate(g)) afterLegit.push(g);
  }
  if (afterLegit.length > 1) {
    return afterLegit.reduce((best, g) => g.id < best.id ? g : best);
  }
  return created;
}

/**
 * Гейт перед отправкой: собеседник обязан состоять в группе.
 *
 * Зовётся из `usePairChat` перед каждым `sendText` в УЖЕ СУЩЕСТВУЮЩУЮ группу.
 * Только что созданная группа этой проверки не требует — путь создания сам
 * отказывается собирать группу без собеседника (см. выше).
 *
 * Бросает ту же ошибку, что и путь создания, поэтому ChatPanel показывает то
 * же понятное объяснение со ссылкой-приглашением. Разбор, почему проверка
 * стоит именно здесь, — в шапке `lib/xmtpDelivery.ts`.
 */
export async function assertPeerCanReceive(
  client: XmtpClient,
  group: XmtpGroup,
  peerAddress: string,
): Promise<void> {
  const state = await ensurePeerInGroup(group, client, toIdentifier(peerAddress));
  if (blocksDelivery(state)) throw new Error(PEER_UNREACHABLE_MESSAGE);
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
        // fileKey is the new field; storjKey is the legacy name — check both for old messages
        const fileKey = typeof p.fileKey === 'string' ? p.fileKey
          : typeof p.storjKey === 'string' ? p.storjKey : undefined;
        // Reconstruct download URL from current relayer base — baked URLs go stale when ngrok rotates
        const RELAYER = (process.env.NEXT_PUBLIC_RELAYER_URL ?? 'http://localhost:3001').replace(/\/$/, '');
        const resolvedUrl = fileKey ? `${RELAYER}/files/${fileKey}` : (p.url as string);
        return {
          text: p.name,
          attachment: {
            name:       p.name,
            url:        resolvedUrl,
            fileKey,
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

// A read receipt means "everything up to here is read" — not a per-message
// flag. Returns the receipt's timestamp (ms) only if it came from the peer,
// never our own echoed back through the group.
export function readReceiptTimestampMs(msg: DecodedMessage, myInboxId: string): number | null {
  if (msg.senderInboxId === myInboxId || !isReadReceipt(msg)) return null;
  return msg.sentAtNs ? Number(msg.sentAtNs) / 1_000_000 : 0;
}

export interface LoadedMessages {
  messages:       ChatMessage[];
  hasMore:        boolean;       // true if there may be older messages to load
  oldestNs:       bigint | null; // sentAtNs of the oldest message — cursor for next page
  peerLastReadAt: number | null; // ms — latest read-receipt seen from the peer in this page
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

  let peerLastReadAt: number | null = null;
  for (const m of raw) {
    const ms = readReceiptTimestampMs(m, myInboxId);
    if (ms !== null && (peerLastReadAt === null || ms > peerLastReadAt)) peerLastReadAt = ms;
  }

  return { messages, hasMore: BigInt(raw.length) === MSG_PAGE_SIZE, oldestNs, peerLastReadAt };
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

async function _buildPairConversations(
  client: XmtpClient,
  myAddress: string,
  sync: boolean,
): Promise<PairConversation[]> {
  // Network sync with timeout — on mobile or poor connectivity this can hang indefinitely.
  // If global sync times out, we continue with whatever is already in the local OPFS cache.
  if (sync) {
    await withTimeout(client.conversations.sync(), 15_000, 'sync_timeout').catch(() => {});
  }
  const groups = await client.conversations.listGroups();
  const myInboxId = client.inboxId ?? '';
  const myLc = myAddress.toLowerCase();
  // Keyed by peer address, NOT by group: the pre-persist-fix installation churn could
  // leave several HSEAL-PAIR groups for the same pair (each new install couldn't see
  // the old group, so it made a new one), which showed up as a separate one-message
  // "chat" per group. Collapse them into a single row per contact (Telegram-style).
  const byPeer = new Map<string, PairConversation>();

  for (const g of groups) {
    const name = g.name ?? '';
    if (!name.startsWith(PAIR_PREFIX)) continue;
    try {
      if (sync) {
        await withTimeout(g.sync(), 5_000, 'group_sync_timeout').catch(() => {});
      }
      const members = await g.members();
      const inboxToAddr = buildInboxAddressMap(members);
      const peerAddress = [...inboxToAddr.values()].find(addr => addr !== myLc);
      if (!peerAddress) continue;

      // Read up to 10 to skip MembershipChange events and deal_ctx markers.
      // lastText/lastAt/lastFromMe all come from the SAME message so they're consistent.
      const msgs = await g.messages({ limit: BigInt(10), direction: SortDirection.Descending });
      let lastText = '';
      let lastAt = 0;
      let lastFromMe = true;

      for (const msg of msgs) {
        const parsed = parseContent(msg);
        if (parsed) {
          const fromMe = msg.senderInboxId === myInboxId;
          lastText = parsed.attachment
            ? `📎 ${parsed.attachment.name}`
            : (fromMe ? `You: ${parsed.text}` : parsed.text);
          lastAt = msg.sentAtNs ? Number(msg.sentAtNs) / 1_000_000 : 0;
          lastFromMe = fromMe;
          break;
        }
      }

      // Keep, per peer, the group whose latest message is newest — so the sidebar
      // preview stays meaningful. Opening is by peer address (findOrCreatePairGroup
      // converges on the canonical group), so which group object we keep here only
      // affects the preview text, not which conversation opens.
      const peerLc = peerAddress.toLowerCase();
      const existing = byPeer.get(peerLc);
      if (!existing || lastAt > existing.lastAt) {
        byPeer.set(peerLc, { group: g, peerAddress, lastText, lastAt, lastFromMe });
      }
    } catch {
      // skip malformed conversations
    }
  }

  return [...byPeer.values()].sort((a, b) => b.lastAt - a.lastAt);
}

// Reads from local XMTP SQLite cache only — no network sync, returns instantly.
export function listPairConversationsLocal(
  client: XmtpClient,
  myAddress: string,
): Promise<PairConversation[]> {
  return _buildPairConversations(client, myAddress, false);
}

// Full network sync — fetches the latest messages before returning.
export function listPairConversations(
  client: XmtpClient,
  myAddress: string,
): Promise<PairConversation[]> {
  return _buildPairConversations(client, myAddress, true);
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
