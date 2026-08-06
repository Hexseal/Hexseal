import cron from 'node-cron';
import { app, relayerInfo, runFileCleanup, runTreasuryKeeper } from './app.js';

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

// ─── Бота XMTP здесь больше нет ──────────────────────────────────────────────
//
// До 6 августа 2026 сразу после старта сервера поднимался бот `@xmtp/node-sdk`:
// он состоял в каждой парной группе, дочитывал историю и писал переписку в
// журнал спора открытым текстом (`botLog.js`, удалён вместе с ним).
//
// Он выключен НЕ ради экономии процесса, а потому что противоречил тому, что
// теперь написано у человека на экране: «сервер хранит переписку в нечитаемом
// виде и не имеет ключей». Бот ключи имел — по построению.
//
// Что встало на его место: переписка едет запечатанной через склад мешков
// (`/bags/*`), а предъявить её арбитру при споре может каждая из сторон со
// своего устройства — у обеих половин разговора лежат самодостаточные
// доказательства (`chatConversation.MessageProof`). Сам механизм предъявления
// — отдельный план; здесь бот именно ВЫКЛЮЧЕН, а не заменён по месту.
//
// Маршрут `GET /dispute-log/:dealId` и хранилище журнала оставлены: в них
// лежит то, что бот успел записать до выключения, и туда же будет писать
// предъявление сторон. Писателя у журнала сейчас нет — сказано прямо в
// докстринге `appendLogEntry` в app.js.
