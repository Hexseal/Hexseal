import cron from 'node-cron';
import { Client } from '@xmtp/node-sdk';
import path from 'path';
import { app, botSigner, relayerInfo, runFileCleanup, runTreasuryKeeper } from './app.js';
import { watchPairGroup, rescanPairGroups } from './botLog.js';

cron.schedule('0 3 * * *', runFileCleanup);

// Hourly, at :07 rather than on the hour — nothing here is time-critical, and
// off-peak minutes keep it clear of whatever else fires at :00.
//
// The treasury cannot distribute itself: ERC-20 has no callback, so it never
// learns a fee arrived. Without this, fees accumulate on the contract and the
// arbiter vault is never funded. No-op until TREASURY_ADDRESS is set.
cron.schedule('7 * * * *', runTreasuryKeeper);

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

    // Подхват одной группы: дочитать историю, затем слушать поток. Вся логика —
    // включая дедупликацию, курсор `deal_ctx` и глубину дочитывания — живёт в
    // `botLog.js`, где её можно проверить тестами без сети. Здесь остаётся
    // только «кого подхватывать».
    //
    // Раньше на этом месте стоял голый `group.stream()` без единого чтения
    // истории: поток начинался «с этого момента», и первое сообщение переписки
    // (обычно бриф) вместе со всем, что писали во время перезапуска релеера, в
    // журнал спора не попадало никогда. Разбор — в шапке `botLog.js`.
    const watch = (g) => {
      watchPairGroup(g).catch(err => console.warn('[bot] watch failed:', err.message));
    };

    // Sync and start watching all existing HSEAL-* groups
    await botClient.conversations.sync();
    const groups = await botClient.conversations.listGroups();
    for (const g of groups) {
      watch(g); // intentionally not awaited
    }

    // Stream new group invitations
    (async () => {
      try {
        const stream = await botClient.conversations.stream();
        for await (const conv of stream) {
          watch(conv); // intentionally not awaited
        }
      } catch (err) {
        console.warn('[bot] conversation stream error:', err.message);
      }
    })();

    // Подстраховка обоих потоков разом. Приглашение в группу можно пропустить
    // (`conversations.stream()` моргнул), а поток отдельной группы — потерять;
    // и то и другое молча превращает переписку в непишущуюся, и до сих пор
    // лечилось только перезапуском процесса. Раз в десять минут пересматриваем
    // список: уже подхваченные группы отсекает карта внутри `botLog.js`, а
    // выпавшая пара возвращается в журнал вместе со всем, что прошло мимо.
    setInterval(() => { rescanPairGroups(botClient); }, 10 * 60 * 1000);

  } catch (err) {
    console.error('[bot] XMTP init failed:', err.message);
    // Non-fatal — relay still works without the bot
  }
})();
