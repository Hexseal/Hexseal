import { describe, it, expect, afterAll, vi } from 'vitest';
import { startChatStand } from './chatStand';

describe('сквозной стенд', () => {
  it('поднимает настоящий релеер и отдаёт два кошелька', async () => {
    const stand = await startChatStand();
    try {
      expect(stand.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(stand.wallets).toHaveLength(2);
      expect(stand.wallets[0].address).not.toBe(stand.wallets[1].address);
      const res = await fetch(`${stand.url}/health`);
      expect(res.status).toBe(200);
    } finally {
      await stand.stop();
    }
  });

  // Шаг 6 брифа — сквозная проверка серверной правки, НАСТОЯЩИМ
  // chatTransport.ts, не запросами руками: кошелёк A выпускает пропуск,
  // кладёт мешок для B, видит sent: [{ fetched: false }]; B забирает; A
  // видит fetched: true.
  //
  // chatTransport.ts вычисляет RELAYER_URL ОДИН РАЗ на импорте (`const
  // RELAYER_URL = ...`, читает NEXT_PUBLIC_RELAYER_URL) — та же ловушка
  // порядка, которая уже кусалась у bagStore.js на релеере (см. докстринг
  // chatStand.ts): порт стенда известен только ПОСЛЕ startChatStand(),
  // значит переменная окружения и динамический import идут строго после
  // неё, не раньше. `vi.resetModules()` перед импортом — та же дисциплина,
  // что и в самом chatStand.ts: без неё повторный запуск этого теста (или
  // добавление второго такого теста в этот же файл) получил бы уже
  // застывший на ПРЕЖНЕМ порту модуль.
  it('A выпускает пропуск, кладёт мешок для B, видит sent:[{fetched:false}]; после скачивания Б видит fetched:true', async () => {
    const stand = await startChatStand();
    try {
      process.env.NEXT_PUBLIC_RELAYER_URL = stand.url;
      vi.resetModules();
      const { requestBagPass, putBag, listBags, fetchBag } = await import('../chatTransport');

      const [alice, bob] = stand.wallets;
      // Адреса — в том виде, в каком их реально отдаёт ethers.Wallet (с
      // контрольной суммой EIP-55), НЕ приведённые к нижнему регистру
      // заранее — ровно то, что useAccount() отдал бы в браузере.
      const aliceAddr = alice.address as `0x${string}`;
      const bobAddr = bob.address as `0x${string}`;

      const alicePass = await requestBagPass((msg) => alice.signMessage(msg), aliceAddr);
      const { key } = await putBag(alicePass.pass, bobAddr, new TextEncoder().encode('привет, Боб'));

      const aliceView1 = await listBags(alicePass.pass);
      expect(aliceView1.sent).toEqual([
        { key, recipient: bobAddr.toLowerCase(), uploadedAt: expect.any(Number), fetched: false },
      ]);
      // Собеседник появился в peers ДО того, как он вообще что-либо забрал —
      // переписка есть с момента первого мешка в любую сторону (§3.4).
      expect(aliceView1.peers).toEqual([{ address: bobAddr.toLowerCase(), lastSeenAt: null }]);

      const bobPass = await requestBagPass((msg) => bob.signMessage(msg), bobAddr);
      const bytes = await fetchBag(bobPass.pass, key);
      expect(bytes).not.toBeNull();

      const aliceView2 = await listBags(alicePass.pass);
      expect(aliceView2.sent).toEqual([
        { key, recipient: bobAddr.toLowerCase(), uploadedAt: expect.any(Number), fetched: true },
      ]);
      expect(aliceView2.peers[0].address).toBe(bobAddr.toLowerCase());
      expect(aliceView2.peers[0].lastSeenAt).not.toBeNull(); // Боб теперь дал сигнал присутствия — забрал мешок
    } finally {
      await stand.stop();
      delete process.env.NEXT_PUBLIC_RELAYER_URL;
    }
  });
});
