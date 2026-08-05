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

  // Находка координатора (ревью): докстринг файла заявлял «можно звать
  // параллельно, ни общего диска, ни общего процесса» — воспроизведено
  // ОБРАТНОЕ: `Promise.all([startChatStand(), startChatStand()])` даёт ОДИН
  // экземпляр app.js на двоих (общий env/module-registry процесса), мешок с
  // первого стенда виден на втором, а stop() первого сносит каталог, которым
  // пользуется второй — молчаливое смешение складов вместо честной ошибки.
  //
  // Решение (координатор явно предложил оба варианта, выбран второй — «либо
  // почини… либо убери обещание и напиши прямо: стенд один на процесс, для
  // двух пользователей — два кошелька на одном стенде»): не пытаемся дать
  // параллелизм (это значило бы реальный отдельный ОС-процесс на стенд —
  // отдельная задача сама по себе), а запираем ОДИН активный стенд на
  // процесс явной, громкой ошибкой вместо тихой порчи. Два кошелька,
  // которые уже отдаёт один стенд, — это и есть «два пользователя» для
  // всех задач этого плана.
  it('второй стенд, пока первый ещё жив, отвергается громко — не тихое смешение складов (см. докстринг chatStand.ts)', async () => {
    const stand1 = await startChatStand();
    try {
      await expect(startChatStand()).rejects.toThrow(/already running|already active/i);
    } finally {
      await stand1.stop();
    }

    // Ограничение не залипает навсегда — после честного stop() первого
    // следующий стенд поднимается нормально.
    const stand2 = await startChatStand();
    await stand2.stop();
  });

  // Та же гарантия, но буквально репродукцией координатора —
  // Promise.all([startChatStand(), startChatStand()]): ровно один поднимается
  // и живёт, второй отвергается — никогда оба одновременно и никогда оба с
  // ошибкой (флаг корректно освобождается, если проигравший бросил ДО
  // какой-либо мутации процесса — см. реализацию).
  it('Promise.all([startChatStand(), startChatStand()]) — ровно один поднимается, второй отвергается, склады не смешиваются', async () => {
    const results = await Promise.allSettled([startChatStand(), startChatStand()]);
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof startChatStand>>> => r.status === 'fulfilled',
    );
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    await fulfilled[0].value.stop();
  });
});
