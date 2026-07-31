import { describe, it, expect } from 'vitest';
import { acquireWalletLock, withWalletLock } from './walletLock';

// Очередь лока живёт в модульной Map, общей на весь файл тестов. Каждому тесту
// — свой адрес, иначе один упавший тест оставляет лок взятым и все следующие
// молча висят на нём до трёхминутного потолка.
let n = 0;
const addr = () => `0x${String(++n).padStart(40, '1')}`;

/** Промис, который тест резолвит сам. Ждать таймерами здесь нельзя: смысл
 *  лока — порядок между промисами, а сравнение «кто раньше по setTimeout(0)»
 *  зависит от того, сколько await'ов оказалось на каждой стороне. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

/** Даёт очереди микрозадач провернуться до конца. */
const settle = () => new Promise<void>(r => setTimeout(r, 0));

describe('acquireWalletLock', () => {
  it('второй захват ждёт освобождения первого', async () => {
    // Ровно то, ради чего лок существует: два запроса подписи для одного
    // кошелька, стартовавшие рядом. Второй, улетевший в кошелёк не дождавшись
    // первого, получает -32002 'already pending', а в мобильном MetaMask такой
    // запрос не отменяется ничем, кроме полного закрытия приложения кошелька.
    const a = addr();
    const release1 = await acquireWalletLock(a);

    let secondGotIt = false;
    const second = acquireWalletLock(a).then(r => { secondGotIt = true; return r; });

    await settle();
    expect(secondGotIt).toBe(false); // держим — второй стоит

    release1();
    const release2 = await second;
    expect(secondGotIt).toBe(true);
    release2();
  });

  it('разные кошельки друг друга не блокируют', async () => {
    // Лок — на адрес, а не глобальный: очередь у чужого кошелька не должна
    // останавливать наш.
    const releaseA = await acquireWalletLock(addr());
    const releaseB = await acquireWalletLock(addr()); // не должно зависнуть
    releaseA();
    releaseB();
  });

  it('адрес нечувствителен к регистру', async () => {
    // Один и тот же кошелёк приходит сюда то как checksum-адрес (viem), то
    // как lowercase (наши собственные вызовы) — без нормализации это были бы
    // две независимые очереди, то есть лока фактически нет.
    const a = `0x${'aB'.repeat(20)}`;
    const release1 = await acquireWalletLock(a.toUpperCase().replace('0X', '0x'));

    let secondGotIt = false;
    const second = acquireWalletLock(a.toLowerCase()).then(r => { secondGotIt = true; return r; });

    await settle();
    expect(secondGotIt).toBe(false);

    release1();
    (await second)();
    expect(secondGotIt).toBe(true);
  });

  it('очередь из трёх соблюдает порядок', async () => {
    const a = addr();
    const order: number[] = [];
    const release1 = await acquireWalletLock(a);
    order.push(1);

    const second = acquireWalletLock(a).then(r => { order.push(2); return r; });
    await settle(); // second встал в хвост раньше third
    const third  = acquireWalletLock(a).then(r => { order.push(3); return r; });

    await settle();
    expect(order).toEqual([1]);

    release1();
    (await second)();
    (await third)();
    expect(order).toEqual([1, 2, 3]);
  });

  it('провал под локом всё равно освобождает очередь', async () => {
    // Отказ от подписи в кошельке — самый обычный исход, и он не должен
    // заклинивать все остальные действия до перезагрузки страницы.
    const a = addr();
    await expect(
      withWalletLock(a, async () => { throw new Error('user rejected'); }),
    ).rejects.toThrow('user rejected');

    // Если бы лок не отпустился, этот await не вернулся бы никогда.
    const release = await acquireWalletLock(a);
    release();
  });

  it('withWalletLock держит лок на всё время колбэка и отдаёт его результат', async () => {
    const a = addr();
    const gate = deferred();

    let finished = false;
    const result = withWalletLock(a, async () => {
      await gate.promise;   // «окно подписи» открыто ровно пока мы не разрешим
      finished = true;
      return 'sig';
    });

    let secondGotIt = false;
    const second = acquireWalletLock(a).then(r => { secondGotIt = true; return r; });

    await settle();
    expect(finished).toBe(false);
    expect(secondGotIt).toBe(false); // колбэк ещё внутри — второй ждёт

    gate.resolve();
    expect(await result).toBe('sig');
    (await second)();
    expect(secondGotIt).toBe(true);
  });

  it('withWalletLock сериализует конкурирующие подписи', async () => {
    // Три «окна подписи» подряд: пересечения быть не должно ни в одной точке.
    const a = addr();
    let concurrent = 0;
    let maxConcurrent = 0;
    const sign = () => withWalletLock(a, async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await settle();
      concurrent--;
    });

    await Promise.all([sign(), sign(), sign()]);
    expect(maxConcurrent).toBe(1);
  });
});
