import { describe, it, expect } from 'vitest';
import { mergePages } from './boardPaging';

const job = (id: string) => ({ id, title: `Job ${id}` });

describe('mergePages', () => {
  it('первая страница замещает накопленное', () => {
    const prev = [job('9'), job('8')];
    expect(mergePages(prev, 0, [job('1'), job('2')])).toEqual([job('1'), job('2')]);
  });

  it('первая страница замещает накопленное и пустым результатом (сброс фильтра)', () => {
    expect(mergePages([job('1')], 0, [])).toEqual([]);
  });

  it('следующая страница дописывается в хвост', () => {
    expect(mergePages([job('1'), job('2')], 1, [job('3'), job('4')]))
      .toEqual([job('1'), job('2'), job('3'), job('4')]);
  });

  // Собственно тот баг, ради которого функция и появилась: повторное
  // выполнение того же запроса (кнопка «Обновить» со страницы ≥ 1) отдавало
  // новую ссылку на массив, эффект снова уходил в ветку append и дописывал ту
  // же страницу второй раз.
  it('повтор той же страницы ничего не добавляет', () => {
    const afterFirstAppend = mergePages([job('1'), job('2')], 1, [job('3'), job('4')]);
    const afterRefetch     = mergePages(afterFirstAppend, 1, [job('3'), job('4')]);
    expect(afterRefetch).toEqual([job('1'), job('2'), job('3'), job('4')]);
  });

  it('повтор не создаёт дублирующихся React-ключей даже после трёх обновлений', () => {
    let acc = mergePages([], 0, [job('1'), job('2')]);
    acc = mergePages(acc, 1, [job('3')]);
    acc = mergePages(acc, 1, [job('3')]);
    acc = mergePages(acc, 1, [job('3')]);
    expect(acc.map(j => j.id)).toEqual(['1', '2', '3']);
    expect(new Set(acc.map(j => j.id)).size).toBe(acc.length);
  });

  it('частичное пересечение страниц отбрасывает только повторы', () => {
    // Сабграф на живых данных умеет вернуть в следующем окне запись, уже
    // попавшую в предыдущее: между запросами добавился новый заказ и сдвинул
    // сортировку.
    expect(mergePages([job('1'), job('2')], 1, [job('2'), job('3')]).map(j => j.id))
      .toEqual(['1', '2', '3']);
  });

  it('повторы внутри одной входящей страницы тоже схлопываются', () => {
    expect(mergePages([], 1, [job('5'), job('5'), job('6')]).map(j => j.id))
      .toEqual(['5', '6']);
  });

  it('пустая следующая страница не затирает накопленное', () => {
    expect(mergePages([job('1'), job('2')], 1, [])).toEqual([job('1'), job('2')]);
  });

  it('не мутирует переданный массив', () => {
    const prev = [job('1')];
    const frozen = Object.freeze([...prev]);
    mergePages(frozen, 1, [job('2')]);
    expect(prev).toEqual([job('1')]);
  });

  it('возвращает новый массив, а не ту же ссылку', () => {
    const prev = [job('1')];
    expect(mergePages(prev, 1, [])).not.toBe(prev);
  });
});
