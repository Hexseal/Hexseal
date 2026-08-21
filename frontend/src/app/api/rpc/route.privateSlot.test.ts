/**
 * ШОВ: маршрут действительно ЗОВЁТ признак «есть ли в адресе ключ» — и молчит
 * там, где раньше кричал.
 *
 * ЧТО БЫЛО. `route.ts` узнавал «публичный узел в приватном слоте» по СПИСКУ
 * ДОМЕНОВ (`base.org`, `drpc.org`, `publicnode.com`, `blockpi.network`), и
 * рядом стоял довод: платный drpc живёт на другом домене, значит запрет на
 * `drpc.org` безопасен. Довод был неверен — боевой платный адрес владельца
 * оканчивается на `.drpc.org`, и предупреждение печаталось при КАЖДОМ запуске
 * фронта. Ложная тревога хуже молчания: в ней тонет настоящий сигнал.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫМ ФАЙЛОМ И ЧЕРЕЗ `vi.resetModules()`. Приватный слот читается
 * ОДИН РАЗ на уровне модуля (как `ALLOWED_ORIGINS` в `route.origin.test.ts`),
 * и предупреждение печатается там же — при импорте. Значит каждая сцена
 * требует своего импорта с своим окружением.
 *
 * ⚠️ И ПОЭТОМУ ЖЕ — `delete` трёх переменных перед каждой сценой. Рабочий
 * каталог ходит под direnv (`.envrc: dotenv`), а корневой `.env` реально
 * задаёт `DRPC_URL` и `BASE_SEPOLIA_RPC_URL`: «не задавать переменную в тесте»
 * здесь НЕ значит «она пуста». Без этих трёх строк сцена «слот пуст» молча
 * проверяла бы боевой адрес владельца.
 *
 * ⚠️ Ключи ниже ВЫДУМАНЫ. Репозиторий публичный.
 */
import { describe, it, expect, vi } from 'vitest';

const FAKE_QUERY_KEY = 'Zq7Xm2Vp9Ld4Rt6Yn1Ks8Hb3Jc5Wf0Ag';
const FAKE_PATH_KEY  = 'A1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU1vW2xY3zB';

/** Что маршрут напечатает про приватный слот при запуске с этим адресом. */
async function slotLinesFor(privateUrl: string | undefined): Promise<string[]> {
  vi.resetModules();
  delete process.env.DRPC_URL;
  delete process.env.RPC_URL;
  delete process.env.BASE_SEPOLIA_RPC_URL;
  if (privateUrl !== undefined) process.env.DRPC_URL = privateUrl;

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await import('./route');
    return warn.mock.calls
      .map(c => String(c[0]))
      .filter(line => line.includes('private RPC slot'));
  } finally {
    warn.mockRestore();
  }
}

describe('/api/rpc — приватный слот узнаётся по КЛЮЧУ, а не по имени хоста', () => {
  it('ЗАМЕР 1: боевой платный адрес — ключ СЕГМЕНТОМ ПУТИ — маршрут МОЛЧИТ', async () => {
    // Форма из окружения владельца. Список доменов её не увидел бы никогда.
    expect(await slotLinesFor(`https://lb.drpc.live/base-sepolia/${FAKE_PATH_KEY}`)).toEqual([]);
  });

  it('ЗАМЕР 1б: та же платная точка на домене из прежнего чёрного списка — тоже МОЛЧИТ', async () => {
    expect(await slotLinesFor(`https://lb.drpc.org/ogrpc?network=base-sepolia&dkey=${FAKE_QUERY_KEY}`)).toEqual([]);
  });

  it('ЗАМЕР 2: бесплатный drpc — ТОТ ЖЕ домен, ключа нет — маршрут предупреждает', async () => {
    const lines = await slotLinesFor('https://base-sepolia.drpc.org');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('no access key');
    expect(lines[0]).toContain('base-sepolia.drpc.org');
  });

  it('ЗАМЕР 3: публичный узел Base — маршрут предупреждает', async () => {
    const lines = await slotLinesFor('https://sepolia.base.org');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('no access key');
  });

  it('ЗАМЕР 4: ключ в пути у другого поставщика (`/v2/<ключ>`) — МОЛЧИТ', async () => {
    expect(await slotLinesFor(`https://base-sepolia.g.alchemy.com/v2/${FAKE_QUERY_KEY}`)).toEqual([]);
  });

  it('ВСТРЕЧНЫЙ ЗАМЕР: маршрут не может добиться молчания на боевом тем, что молчит всегда', async () => {
    // Если признак признаёт приватным ВСЁ (или маршрут перестал его звать),
    // эти две строки — единственное, что об этом скажет.
    expect(await slotLinesFor('https://base-sepolia.drpc.org')).toHaveLength(1);
    expect(await slotLinesFor('https://base-sepolia-rpc.publicnode.com')).toHaveLength(1);
  });

  it('слот пуст — про ключ не говорим вовсе (об этом кричит другая строка, на каждый запрос)', async () => {
    expect(await slotLinesFor(undefined)).toEqual([]);
  });

  it('в строке журнала — только хост: ни ключа, ни значений параметров', async () => {
    // Сцена, где предупреждение ЕСТЬ и короткий ключ в адресе ТОЖЕ есть.
    const lines = await slotLinesFor('https://lb.drpc.org/base-sepolia/Ab3xK9zQ');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('Ab3xK9zQ');
    expect(lines[0]).toContain('lb.drpc.org');
  });

  it('адрес не разбирается — маршрут ГОВОРИТ ВСЛУХ (раньше здесь был пустой catch)', async () => {
    const lines = await slotLinesFor('lb.drpc.org/base-sepolia/ключ');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('cannot tell');
  });
});
