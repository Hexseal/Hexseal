import cron from 'node-cron';
import { Client } from '@xmtp/node-sdk';
import path from 'path';
import { app, botSigner, relayerInfo, runFileCleanup, PAIR_ID_RE, appendLogEntry } from './app.js';

cron.schedule('0 3 * * *', runFileCleanup);

// ─── Start ────────────────────────────────────────────────────────────────────

async function start() {
  app.listen(relayerInfo.port, () => {
    console.log(`Relayer running on :${relayerInfo.port}`);
    console.log(`Relayer wallet:  ${relayerInfo.relayerAddress}`);
    console.log(`Forwarder:       ${relayerInfo.forwarderAddr}`);
    console.log(`Diamond:         ${relayerInfo.diamondAddr}`);
    console.log(`Allowed origins: ${relayerInfo.allowedOrigins.join(', ')}`);
    console.log(`Public URL:      ${relayerInfo.baseUrl}`);
    console.log(`Storage:         ${relayerInfo.storageDir}`);
    console.log(`  files/  → ${relayerInfo.dirFiles} (encrypted, 7d TTL)`);
    console.log(`  public/ → ${relayerInfo.dirPublic} (permanent)`);
  });
}

start();

// ─── XMTP Bot startup ─────────────────────────────────────────────────────────
(async () => {
  try {
    const xmtpDbPath = path.join(relayerInfo.storageDir, 'xmtp-bot');
    const botClient = await Client.create(botSigner, {
      env: 'production',
      dbPath: xmtpDbPath,
    });
    console.log(`[bot] XMTP ready: ${botClient.inboxId}`);

    // Stream messages from one group (fire-and-forget). `currentDealId` is a
    // per-group cursor updated by silent deal_ctx marker messages (sent by the
    // frontend's ChatPanel) — it tags each logged entry with whichever deal was
    // "active" when the message was sent, but never gates whether an entry is
    // written: the log deliberately keeps the whole thread, unfiltered, so an
    // arbiter can see context from before a deal formally started.
    async function streamGroupMessages(group) {
      const groupName = group.name ?? '';
      if (!groupName.startsWith('HSEAL-PAIR-')) return;
      const pairId = groupName.slice('HSEAL-PAIR-'.length).toLowerCase();
      if (!PAIR_ID_RE.test(pairId)) return;

      let currentDealId = null;

      try {
        const stream = await group.stream();
        for await (const msg of stream) {
          if (typeof msg.content !== 'string' || !msg.content) continue;

          if (msg.content.startsWith('{')) {
            try {
              const parsed = JSON.parse(msg.content);
              if (parsed._type === 'deal_ctx') {
                currentDealId = typeof parsed.dealId === 'string' ? parsed.dealId.toLowerCase() : null;
                continue; // marker itself is never a log entry
              }
            } catch { /* not JSON — fall through, log as a normal entry */ }
          }

          const members = await group.members();
          const sender = members.find(m => m.inboxId === msg.senderInboxId);
          const from = sender?.accountIdentifiers?.[0]?.identifier?.toLowerCase() ?? msg.senderInboxId;
          appendLogEntry(pairId, {
            ts:     msg.sentAt ? msg.sentAt.getTime() : Date.now(),
            from,
            text:   msg.content,
            dealId: currentDealId,
          });
        }
      } catch (err) {
        console.warn(`[bot] stream error for ${pairId}:`, err.message);
      }
    }

    // Sync and start streaming all existing HSEAL-* groups
    await botClient.conversations.sync();
    const groups = await botClient.conversations.listGroups();
    for (const g of groups) {
      streamGroupMessages(g); // intentionally not awaited
    }

    // Stream new group invitations
    (async () => {
      try {
        const stream = await botClient.conversations.stream();
        for await (const conv of stream) {
          streamGroupMessages(conv); // intentionally not awaited
        }
      } catch (err) {
        console.warn('[bot] conversation stream error:', err.message);
      }
    })();

  } catch (err) {
    console.error('[bot] XMTP init failed:', err.message);
    // Non-fatal — relay still works without the bot
  }
})();
