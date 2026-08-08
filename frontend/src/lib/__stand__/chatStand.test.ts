import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import type { ethers } from 'ethers';
import { startChatStand } from './chatStand';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
      expect(aliceView1.peers).toEqual([{ address: bobAddr.toLowerCase(), lastActivityWithMeAt: null }]);

      const bobPass = await requestBagPass((msg) => bob.signMessage(msg), bobAddr);
      const bytes = await fetchBag(bobPass.pass, key);
      expect(bytes).not.toBeNull();

      const aliceView2 = await listBags(alicePass.pass);
      expect(aliceView2.sent).toEqual([
        { key, recipient: bobAddr.toLowerCase(), uploadedAt: expect.any(Number), fetched: true },
      ]);
      expect(aliceView2.peers[0].address).toBe(bobAddr.toLowerCase());
      expect(aliceView2.peers[0].lastActivityWithMeAt).not.toBeNull(); // Боб теперь дал сигнал присутствия — забрал мешок
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

  // Находка ревью (координатор, третий раунд): дисциплина «переменные ДО
  // импорта» и «vi.resetModules() перед импортом» — обе несущие (докстринг
  // файла их так и называет), но ни одна не была заперта. Мутация «не
  // выставлять STORAGE_DIR» проходила все 703 зелёными, и стенд при этом
  // писал настоящий мешок в БОЕВОЙ relayer/storage/ (bagStore.js падает на
  // умолчание `path.join(__dirname, 'storage')`, если STORAGE_DIR ничем не
  // переопределён) — ревьюер поймал это вживую и восстанавливал каталог
  // руками.
  //
  // "Заведомо чужой" STORAGE_DIR (не боевой каталог — временный decoy,
  // безопасный даже если гейт сломан) выставляется ДО startChatStand():
  // если бы строка `process.env.STORAGE_DIR = storageDir` внутри пропала,
  // это значение осталось бы в силе, и мешок лёг бы в decoy, а не в
  // собственный каталог стенда.
  it('STORAGE_DIR реально переустанавливается ДО импорта app.js — чужой каталог не трогается, мешок ложится в собственный временный каталог стенда', async () => {
    const decoyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-decoy-'));
    process.env.STORAGE_DIR = decoyDir;
    try {
      const stand = await startChatStand();
      try {
        // Стенд обязан ПЕРЕОПРЕДЕЛИТЬ STORAGE_DIR собственным временным
        // каталогом — не унаследовать decoy.
        expect(process.env.STORAGE_DIR).not.toBe(decoyDir);
        const standStorageDir = process.env.STORAGE_DIR as string;

        process.env.NEXT_PUBLIC_RELAYER_URL = stand.url;
        vi.resetModules();
        const { requestBagPass, putBag } = await import('../chatTransport');
        const [alice, bob] = stand.wallets;
        const alicePass = await requestBagPass((m) => alice.signMessage(m), alice.address as `0x${string}`);
        await putBag(alicePass.pass, bob.address as `0x${string}`, new TextEncoder().encode('discipline-check'));

        // Мешок реально лёг в каталог СТЕНДА — не в decoy.
        expect(fs.existsSync(path.join(standStorageDir, 'bags'))).toBe(true);
        // И decoy остался нетронутым — ни один файл склада в него не попал.
        expect(fs.readdirSync(decoyDir)).toEqual([]);
      } finally {
        await stand.stop();
        delete process.env.NEXT_PUBLIC_RELAYER_URL;
      }
    } finally {
      fs.rmSync(decoyDir, { recursive: true, force: true });
      delete process.env.STORAGE_DIR;
    }
  });

  // Тот же замок, но БЕЗ единой записи на диск — проверяет именно опасный
  // сценарий из находки ревьюера (STORAGE_DIR не унаследован НИОТКУДА, не
  // decoy, а полностью отсутствует) чистым сравнением строк, не реальной
  // загрузкой: даже если бы гейт был сломан, этот тест сам по себе ничего
  // не пишет в боевой каталог — опасность создаёт только реальная
  // отправка мешка, которой здесь нет.
  it('без унаследованного STORAGE_DIR результат — не боевое умолчание bagStore.js (relayer/storage/)', async () => {
    delete process.env.STORAGE_DIR;
    const stand = await startChatStand();
    try {
      const productionDefault = path.resolve(__dirname, '../../../../relayer/storage');
      expect(process.env.STORAGE_DIR).not.toBe(productionDefault);
      expect(fs.existsSync(process.env.STORAGE_DIR as string)).toBe(true); // собственный временный каталог реально создан
    } finally {
      await stand.stop();
    }
  });

  // Находка ревью (координатор, третий раунд): мутация «убрать
  // vi.resetModules()» воспроизводит РОВНО ту беду, ради которой писалась
  // правка 1 (гейт «один стенд на процесс») — только теперь ПОСЛЕДОВАТЕЛЬНО,
  // не параллельно: второй стенд, поднятый ПОСЛЕ честного stop() первого,
  // всё равно делит с ним модуль (а значит и склад), если реестр модулей не
  // сброшен между вызовами.
  //
  // ⚠️ НЕ через chatTransport.ts/import('../chatTransport') здесь: та обёртка
  // сама зовёт `vi.resetModules()` (чтобы подхватить NEXT_PUBLIC_RELAYER_URL
  // каждого стенда — см. тест выше), а resetModules() чистит РЕСТР ЦЕЛИКОМ,
  // не по одному модулю — вызов ради chatTransport ПОПУТНО сбросил бы и
  // закешированный app.js, замаскировав ровно ту мутацию, которую этот тест
  // обязан ловить (проверено вживую: первая версия этого теста с
  // import('../chatTransport') оставалась зелёной даже с выключенным
  // resetModules() внутри chatStand.ts — ложный проход). Голый `fetch()` —
  // единственный способ дойти до склада, не трогая реестр модулей самому.
  const rawChallenge = (addr: string, ts: string) => `hexseal:chat-bags:${addr.toLowerCase()}:${ts}`;

  async function rawRequestPass(baseUrl: string, wallet: ethers.HDNodeWallet): Promise<string> {
    const addr = wallet.address.toLowerCase();
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await wallet.signMessage(rawChallenge(addr, ts));
    const res = await fetch(`${baseUrl}/bags/pass`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ts': ts, 'x-sig': sig },
      body: JSON.stringify({ address: addr }),
    });
    const body = (await res.json()) as { pass?: string; error?: string };
    if (!res.ok || !body.pass) throw new Error(`rawRequestPass failed: ${res.status} ${JSON.stringify(body)}`);
    return body.pass;
  }

  async function rawPutBag(baseUrl: string, pass: string, recipient: string, bytes: Uint8Array): Promise<void> {
    const res = await fetch(`${baseUrl}/bags/${recipient.toLowerCase()}`, {
      method: 'PUT',
      headers: { 'x-bag-pass': pass, 'content-type': 'application/octet-stream' },
      body: bytes as BodyInit,
    });
    if (!res.ok) throw new Error(`rawPutBag failed: ${res.status} ${JSON.stringify(await res.json())}`);
  }

  async function rawListSent(baseUrl: string, pass: string): Promise<unknown[]> {
    const res = await fetch(`${baseUrl}/bags`, { headers: { 'x-bag-pass': pass } });
    const body = (await res.json()) as { sent?: unknown[]; error?: string };
    if (!res.ok || !body.sent) throw new Error(`rawListSent failed: ${res.status} ${JSON.stringify(body)}`);
    return body.sent;
  }

  it('второй ПОСЛЕДОВАТЕЛЬНЫЙ стенд не видит данные первого — vi.resetModules() реально даёт свежий модуль, не просто присутствует в коде', async () => {
    const stand1 = await startChatStand();
    const [alice, bob] = stand1.wallets;
    const pass1 = await rawRequestPass(stand1.url, alice);
    await rawPutBag(stand1.url, pass1, bob.address, new TextEncoder().encode('stand1-bag'));
    const sent1 = await rawListSent(stand1.url, pass1);
    expect(sent1).toHaveLength(1); // sanity: мешок реально записан на первом стенде

    await stand1.stop();

    const stand2 = await startChatStand();
    try {
      // ТА ЖЕ Алиса (тот же приватный ключ), но пропуск — уже у ВТОРОГО
      // стенда. Если бы vi.resetModules() внутри chatStand.ts был пропущен,
      // второй "стенд" делил бы _bagMeta первого — её sent показал бы мешок
      // из прошлого стенда, хотя это обязаны быть два ничем не связанных
      // процесса.
      const pass2 = await rawRequestPass(stand2.url, alice);
      const sent2 = await rawListSent(stand2.url, pass2);
      expect(sent2).toEqual([]);
    } finally {
      await stand2.stop();
    }
  });

  // Мелочь (ревью, координатор третий раунд): stop() реально убирает свой
  // временный каталог — до этого теста не было заперто ничем.
  it('stop() убирает временный каталог хранения', async () => {
    const stand = await startChatStand();
    const storageDir = process.env.STORAGE_DIR as string;
    await stand.stop();
    expect(fs.existsSync(storageDir)).toBe(false);
  });

  // Мелочь (ревью, координатор третий раунд): неудавшийся stop() запирал
  // гейт «один стенд на процесс» НАВСЕГДА — первый вызов бросает (например,
  // server.close() отказал), флаг `stopped` уже стоит true ДО того, как
  // работа реально сделана, так что повторный stop() молча резолвится
  // (ничего не пробует заново), а `activeStand` никогда не освобождается —
  // каждый следующий startChatStand() в этом процессе отвечает "already
  // running", хотя реально не работает НИЧЕГО.
  //
  // http.Server.prototype.close заспаен на ОДИН отказ — тот же класс сбоя,
  // что и любой другой на пути остановки (сеть моргнула, сокет уже не
  // слушает), не что-то специфичное для этого теста.
  it('неудавшийся stop() всё равно освобождает гейт «один стенд на процесс» — иначе процесс заперт навсегда', async () => {
    const stand = await startChatStand();

    const closeSpy = vi.spyOn(http.Server.prototype, 'close').mockImplementationOnce(function (
      this: http.Server,
      cb?: (err?: Error) => void,
    ) {
      cb?.(new Error('simulated close failure (test)'));
      return this;
    });

    await expect(stand.stop()).rejects.toThrow(/simulated close failure/);
    closeSpy.mockRestore();

    // Гейт обязан быть свободен, несмотря на отказ — иначе КАЖДЫЙ следующий
    // стенд в этом процессе отвечает "already running", хотя ничего не
    // работает.
    const stand2 = await startChatStand();
    await stand2.stop();
  });
});
