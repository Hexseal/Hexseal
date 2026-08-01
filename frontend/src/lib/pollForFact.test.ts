import { describe, it, expect } from 'vitest';
import { pollForFact } from './pollForFact';

/** Чтение по сценарию: значения по списку, последнее — навсегда.
 *  `null` в списке означает упавшую пробу. */
function reader(values: (number | null)[]) {
  let i = 0;
  let calls = 0;
  const read = async () => {
    const v = values[Math.min(i, values.length - 1)];
    i++; calls++;
    if (v === null) throw new Error('RPC hiccup');
    return v;
  };
  return { read, get calls() { return calls; } };
}

/** Опрос без настоящих таймеров: считаем сны, но не спим. */
function fakeSleep() {
  const slept: number[] = [];
  return { sleep: async (ms: number) => { slept.push(ms); }, slept };
}

const isTrue = (v: number) => v === 1;

describe('pollForFact', () => {
  it('факт есть сразу — одно чтение и ни одного сна', async () => {
    // Отставания реплик могло не быть вовсе, и лишние секунды ожидания на
    // ровном месте — чистый вред: человек смотрит на «крутилку».
    const r = reader([1]);
    const s = fakeSleep();
    const res = await pollForFact(r.read, isTrue, { sleep: s.sleep });
    expect(res).toEqual({ value: 1, satisfied: true, reads: 1 });
    expect(s.slept).toEqual([]);
  });

  it('ждёт, пока чтение не подтвердит факт', async () => {
    // Ровно живой случай: квитанция получена, а следующее чтение попадает на
    // узел, который этот блок ещё не видел.
    const r = reader([0, 0, 1]);
    const s = fakeSleep();
    const res = await pollForFact(r.read, isTrue, { sleep: s.sleep, intervalMs: 750 });
    expect(res.value).toBe(1);
    expect(res.satisfied).toBe(true);
    expect(res.reads).toBe(3);
    expect(s.slept).toEqual([750, 750]);
  });

  it('попытки кончились — говорит об этом прямо', async () => {
    // Отдать «не подтвердилось» обязательно: вызывающая сторона обязана либо
    // сказать человеку, либо оставить след. Молчаливое «всё хорошо» здесь —
    // это ровно та поломка, которая притворяется работой.
    const r = reader([0]);
    const s = fakeSleep();
    const res = await pollForFact(r.read, isTrue, { sleep: s.sleep, attempts: 4 });
    expect(res.satisfied).toBe(false);
    expect(res.value).toBe(0);
    expect(res.reads).toBe(4);   // первое чтение + три повтора
    expect(s.slept).toHaveLength(3);
  });

  it('сбой одной пробы не роняет весь путь', async () => {
    // Моргнувшая сеть на середине опроса не должна отменять действие человека:
    // следующая проба может увидеть уже приехавшую правду.
    const r = reader([0, null, 1]);
    const s = fakeSleep();
    const res = await pollForFact(r.read, isTrue, { sleep: s.sleep });
    expect(res.value).toBe(1);
    expect(res.satisfied).toBe(true);
  });

  it('упавшая последняя проба не затирает прочитанное', async () => {
    const r = reader([7, null]);
    const s = fakeSleep();
    const res = await pollForFact(r.read, isTrue, { sleep: s.sleep, attempts: 3 });
    expect(res.value).toBe(7);      // значение из последней УДАЧНОЙ пробы
    expect(res.satisfied).toBe(false);
  });

  it('сбой первого чтения пробрасывается наружу', async () => {
    // Значения нет вообще — отдавать нечего, и притворяться нечем.
    const r = reader([null]);
    await expect(pollForFact(r.read, isTrue, { sleep: fakeSleep().sleep })).rejects.toThrow('RPC hiccup');
  });

  it('attempts=1 — ровно одна проба без снов', async () => {
    const r = reader([0]);
    const s = fakeSleep();
    const res = await pollForFact(r.read, isTrue, { sleep: s.sleep, attempts: 1 });
    expect(res.reads).toBe(1);
    expect(res.satisfied).toBe(false);
    expect(s.slept).toEqual([]);
  });

  it('условие проверяется на каждом чтении, включая первое', async () => {
    const seen: number[] = [];
    const r = reader([3, 4, 5]);
    const s = fakeSleep();
    await pollForFact(r.read, v => { seen.push(v); return v === 5; }, { sleep: s.sleep });
    expect(seen).toEqual([3, 4, 5]);
  });
});
