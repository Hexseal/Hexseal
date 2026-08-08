/**
 * chatAnnounce.test.ts — решение «показывать кнопку или идти самим», чистой функцией.
 *
 * Замеры на настоящем справочнике — `__stand__/chatAnnounceKey.test.ts`. Здесь —
 * таблица решений, и главная её строка та, которую легче всего проглядеть:
 * НА ДЕСКТОПЕ КНОПКА НЕ ПОКАЗЫВАЕТСЯ ВООБЩЕ, даже на миг.
 *
 * Почему это отдельный замок: состояние «ключ не объявлен» на десктопе тоже
 * бывает — просто живёт доли секунды, между чтением справочника и своим же
 * объявлением. Показав кнопку в этот промежуток, мы получили бы мигающую
 * надпись «Вам пока не могут писать» у человека, у которого всё в порядке. Это
 * ровно тот класс «своя починка хуже дефекта».
 */
import { describe, it, expect } from 'vitest';
import {
  announceNeedsPress, announceMayAuto, standingFromDirectory,
  type KeyStanding, type AnnounceAttempt,
} from '@/lib/chatAnnounce';
import { ChatDirectoryError } from '@/hooks/useChatSession';
import type { SignatureGateVerdict } from '@/lib/chatSignatureGate';

const MINE = new Uint8Array(32).fill(7);
const OTHER = new Uint8Array(32).fill(9);

function press(over: Partial<{
  keyOnDevice: boolean; standing: KeyStanding; attempt: AnnounceAttempt; gate: SignatureGateVerdict;
}> = {}): boolean {
  return announceNeedsPress({
    keyOnDevice: true, standing: 'absent', attempt: 'none', gate: 'needs_press', ...over,
  });
}

describe('как понимать ответ справочника про СВОЙ адрес', () => {
  it('наш ключ лежит — «mine»', () => {
    expect(standingFromDirectory({ ok: true, boxKey: MINE }, MINE)).toBe('mine');
  });

  it('лежит ЧУЖОЙ ключ — «other_key», а не «всё хорошо»', () => {
    // Так бывает у кошельков-контрактов: ключ у них случайный на устройство,
    // и справочник держит тот, что объявили с другого. Считать это порядком
    // значило бы молча оставить человека нечитаемым на ЭТОМ устройстве.
    expect(standingFromDirectory({ ok: true, boxKey: OTHER }, MINE)).toBe('other_key');
  });

  it('404 — «absent»: не заходил, а не «сломалось»', () => {
    expect(standingFromDirectory(
      { ok: false, error: new ChatDirectoryError('нет', 'peer_unknown') }, MINE,
    )).toBe('absent');
  });

  it('справочник молчит или отдал мусор — «unreachable», и это НЕ «absent»', () => {
    // Разница дорогая: `absent` останавливает опрос ящика (объявлять нечем), а
    // `unreachable` не имеет права — моргнувший справочник не должен запирать
    // чат тому, кто давно объявлен.
    for (const code of ['directory_unavailable', 'directory_failed', 'peer_key_malformed'] as const) {
      expect(standingFromDirectory(
        { ok: false, error: new ChatDirectoryError('ой', code) }, MINE,
      ), code).toBe('unreachable');
    }
    expect(standingFromDirectory({ ok: false, error: new Error('сеть') }, MINE)).toBe('unreachable');
  });
});

describe('кнопку показывать — когда именно', () => {
  it('ключ не объявлен и автоматика запрещена — ДА', () => {
    expect(press({ gate: 'needs_press' })).toBe(true);
  });

  it('ДЕСКТОП: автоматика разрешена — кнопки НЕТ, даже на миг', () => {
    // ⚠️ Требование 6. Мутация «показывать всегда, когда не объявлен» красит
    // именно эту строку.
    expect(press({ gate: 'go' })).toBe(false);
  });

  it('уже объявлен — кнопки нет', () => {
    expect(press({ standing: 'mine' })).toBe(false);
  });

  it('ещё не спрашивали справочник — кнопки нет: не пугаем раньше времени', () => {
    expect(press({ standing: 'unknown' })).toBe(false);
  });

  it('справочник недоступен — кнопки нет: это не его вина', () => {
    expect(press({ standing: 'unreachable' })).toBe(false);
  });

  it('прямо сейчас объявляем — кнопки нет', () => {
    expect(press({ attempt: 'busy' })).toBe(false);
  });

  it('попытка НЕ УДАЛАСЬ — кнопка есть даже на десктопе', () => {
    // Иначе десктопный отказ (сеть моргнула на `POST /keys`) остался бы совсем
    // без выхода: автоматика уже отработала и больше не повторится, а кнопки нет.
    expect(press({ attempt: 'failed', gate: 'go' })).toBe(true);
  });

  it('в справочнике чужой ключ — кнопка есть', () => {
    expect(press({ standing: 'other_key', gate: 'needs_press' })).toBe(true);
  });

  it('ключа на устройстве нет вовсе — кнопки нет: объявлять нечего', () => {
    // Это другое состояние и другой экран («включить мессенджер»). Смешав их,
    // человек получил бы «Вам пока не могут писать» там, где он ещё вообще не
    // подписывал ключ.
    expect(press({ keyOnDevice: false })).toBe(false);
  });

  it('страница скрыта — кнопки нет: показывать некому, ждём', () => {
    expect(press({ gate: 'page_hidden' })).toBe(false);
  });
});

describe('объявлять самим — когда именно', () => {
  const auto = (over: Partial<Parameters<typeof announceMayAuto>[0]> = {}) =>
    announceMayAuto({ keyOnDevice: true, standing: 'absent', attempt: 'none', gate: 'go', ...over });

  it('десктоп, ключ не объявлен — ДА', () => { expect(auto()).toBe(true); });
  it('порог не пускает — НЕТ', () => { expect(auto({ gate: 'needs_press' })).toBe(false); });
  it('страница скрыта — НЕТ', () => { expect(auto({ gate: 'page_hidden' })).toBe(false); });
  it('уже объявлен — НЕТ', () => { expect(auto({ standing: 'mine' })).toBe(false); });
  it('справочник молчит — НЕТ: объявлять вслепую незачем', () => {
    expect(auto({ standing: 'unreachable' })).toBe(false);
  });
  it('уже пробовали и не вышло — НЕТ: второй раз только по нажатию', () => {
    // Без этого отказ `POST /keys` крутился бы сам каждый тик — то есть
    // «долбят нарочно» устраивали бы мы сами себе.
    expect(auto({ attempt: 'failed' })).toBe(false);
  });
  it('уже идём — НЕТ', () => { expect(auto({ attempt: 'busy' })).toBe(false); });
  it('ключа на устройстве нет — НЕТ', () => { expect(auto({ keyOnDevice: false })).toBe(false); });

  it('кнопка и автоматика НЕ включаются одновременно — ни в одном сочетании', () => {
    // Замок на противоречие: если оба признака истинны разом, человек видит
    // кнопку и одновременно получает окно кошелька без нажатия.
    const standings: KeyStanding[] = ['unknown', 'mine', 'absent', 'other_key', 'unreachable'];
    const attempts: AnnounceAttempt[] = ['none', 'busy', 'failed'];
    const gates: SignatureGateVerdict[] = ['go', 'needs_press', 'page_hidden'];
    let both = 0;
    for (const keyOnDevice of [true, false]) {
      for (const standing of standings) {
        for (const attempt of attempts) {
          for (const gate of gates) {
            const i = { keyOnDevice, standing, attempt, gate };
            if (announceNeedsPress(i) && announceMayAuto(i)) both++;
          }
        }
      }
    }
    expect(both, 'есть сочетание, где показываем кнопку И лезем в кошелёк сами').toBe(0);
  });
});
