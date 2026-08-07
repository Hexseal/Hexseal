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
  // Печатаем адрес УЖЕ ПОДНЯВШЕГОСЯ сервера, а не то, что просили в
  // окружении (сквозная проверка перед слиянием, 8 августа).
  //
  // Причина: `PORT=0` — законное «дай любой свободный порт» (так поднимают
  // сервер тесты), и Node действительно выдаёт случайный — замерено: 32843.
  // Прежняя строка рапортовала бы «Relayer running on :0», то есть человек
  // видел бы номер, по которому сервер найти нельзя. Нечисловое значение
  // Node вообще понимает как ПУТЬ К UNIX-СОКЕТУ (замерено: PORT=3O01 →
  // сервер поднялся на сокете с таким именем и был недостижим по TCP); эту
  // половину закрывает readPort() в app.js, отвергая такое при старте, а
  // здесь закрыта вторая половина — чтобы журнал не мог соврать про адрес
  // ни при каком раскладе.
  const server = app.listen(relayerInfo.port, () => {
    const addr = server.address();
    const where = typeof addr === 'string' ? `UNIX-сокет ${addr}` : `:${addr.port}`;
    console.log(`Relayer running on ${where}`);
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
