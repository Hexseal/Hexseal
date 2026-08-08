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
  announceNeedsPress, announceMayAuto, standingFromDirectory, attemptAfterFailure, mailboxWorthPolling,
  type KeyStanding, type AnnounceAttempt,
} from '@/lib/chatAnnounce';
import { ChatDirectoryError } from '@/hooks/useChatSession';
import { ChatSignatureDeferred, type SignatureGateVerdict } from '@/lib/chatSignatureGate';

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

/* ═══════════ «в справочнике ключ с другого устройства» — не как «нет» ═══════ */

describe('other_key — ЛОВУШКА С ПОТЕРЕЙ ДАННЫХ, а не разновидность «нет»', () => {
  // ⚠️ НАЙДЕНО РЕВЬЮ КООРДИНАТОРА ПО МОЕМУ ЖЕ СОМНЕНИЮ, и оказалось хуже, чем я
  // его описал. У кошелька-контракта ключ случайный и живёт только на
  // устройстве. Если в справочнике лежит ключ ДРУГОГО устройства, то:
  //
  //   - объявив свой, мы ЗАМЕНИМ чужой. Собеседники начнут запечатывать на наш
  //     ключ, и то устройство перестанет получать новое, а прежние мешки
  //     останутся читаемыми только там;
  //   - у человека есть выход получше — код восстановления: он даёт ТОТ ЖЕ ключ,
  //     ничего не заменяя.
  //
  // Значит замена — осознанный выбор с предупреждением, а не «починка».

  it('объявлять САМИМ при чужом ключе НЕЛЬЗЯ — даже на десктопе', () => {
    // ⚠️ ЭТО БЫЛ ЖИВОЙ ДЕФЕКТ, а не недостающая осторожность: `other_key` шёл в
    // одном множестве с `absent`, поэтому на десктопе (порог «go») автоматика
    // МОЛЧА заменяла ключ другого устройства. Кнопки человек при этом даже не
    // видел — замена происходила без единого нажатия.
    expect(announceMayAuto({
      keyOnDevice: true, standing: 'other_key', attempt: 'none', gate: 'go',
    }), 'десктоп молча заменяет ключ другого устройства').toBe(false);
  });

  it('при ОТСУТСТВИИ ключа объявлять самим по-прежнему можно', () => {
    // Замок, который горит всегда, — не замок. Терять там нечего: записи нет.
    expect(announceMayAuto({
      keyOnDevice: true, standing: 'absent', attempt: 'none', gate: 'go',
    })).toBe(true);
  });

  it('чужой ключ НЕ блокирует опрос ящика — читаемые мешки скрывать нельзя', () => {
    // ⚠️ ВТОРАЯ ПОТЕРЯ, из того же слипания. Мешок запечатывается на тот ключ,
    // который был в справочнике на момент отправки, а забирается ПО АДРЕСУ.
    // Значит при чужом ключе на складе могут лежать мешки, запечатанные на НАШ
    // прежний ключ, — и они здесь открываются. Заблокировав опрос, мы спрятали
    // бы от человека переписку, которую он может прочесть.
    //
    // У `absent` этого случая нет по построению: записи не было НИКОГДА, значит
    // запечатать нам было нечем и мешков быть не может.
    expect(mailboxWorthPolling('other_key'), 'читаемые мешки спрятаны').toBe(true);
    expect(mailboxWorthPolling('absent')).toBe(false);
  });

  it('кнопка/объяснение показываются в ОБОИХ состояниях — писать сюда некуда', () => {
    // Общее у них ровно одно, и оно верно: на ЭТО устройство собеседник писать не
    // может. Значит сказать надо в обоих случаях — но РАЗНЫМИ словами и с
    // разным действием (замок на слова — `components/chatKeyNotAnnounced.test.tsx`).
    expect(announceNeedsPress({
      keyOnDevice: true, standing: 'other_key', attempt: 'none', gate: 'needs_press',
    })).toBe(true);
    expect(announceNeedsPress({
      keyOnDevice: true, standing: 'absent', attempt: 'none', gate: 'needs_press',
    })).toBe(true);
  });

  it('при чужом ключе кнопка показывается ВСЕГДА, а не только после ухода к кошельку', () => {
    // Следствие первого замка: раз автоматики здесь нет, человек обязан увидеть
    // выбор и на десктопе. Иначе состояние стало бы невылечиваемым: сами не
    // делаем и не предлагаем.
    expect(announceNeedsPress({
      keyOnDevice: true, standing: 'other_key', attempt: 'none', gate: 'go',
    }), 'на десктопе чужой ключ не показывает выбора — состояние невылечимо').toBe(true);
  });
});

describe('опрашивать ли ящик — то есть брать ли пропуск', () => {
  it('пока справочник не прочитан — НЕТ: не просим пропуск наперёд', () => {
    // Находка замера, а не осторожность: на повторном заходе с телефона подписи
    // нет, порог говорит «можно», и опрос успевал взять пропуск ДО того, как
    // выяснится, что объявлять нечего.
    expect(mailboxWorthPolling('unknown')).toBe(false);
  });

  it('точно знаем, что писать нам некуда — НЕТ', () => {
    expect(mailboxWorthPolling('absent')).toBe(false);
    expect(mailboxWorthPolling('other_key')).toBe(false);
  });

  it('объявлены — ДА', () => { expect(mailboxWorthPolling('mine')).toBe(true); });

  it('справочник недоступен — ДА, отказ в сторону работы', () => {
    // ⚠️ Намеренно. Опрос блокируется только тогда, когда мы ПОЛОЖИТЕЛЬНО знаем,
    // что написать нам нельзя. Иначе один отказавший запрос к справочнику
    // означал бы чат, молчащий навсегда, — хуже лишнего пропуска.
    expect(mailboxWorthPolling('unreachable')).toBe(true);
  });
});

describe('«ещё не время» и «не удалось» — разные исходы', () => {
  // ⚠️ ЭТОТ БЛОК НАЙДЕН МУТАЦИЕЙ, А НЕ РАССУЖДЕНИЕМ. Мутация «считать отказ
  // порога неудачей» прошла ЗЕЛЁНОЙ на 54 замерах — то есть различие,
  // выписанное в коде отдельной веткой с абзацем объяснения, не сторожил никто.
  //
  // Цена промаха — ровно требование 6. Десктоп, у которого видимость моргнула
  // один раз (восстановление вкладки, переключение окна): порог отказывает,
  // отказ записывается в `failed`, `announceMayAuto` больше НИКОГДА не вернёт
  // true (`attempt !== 'none'`) — и на десктопе появляется кнопка, которой там
  // быть не должно.
  it('отказ порога НЕ становится «не удалось»', () => {
    for (const reason of ['page_hidden', 'needs_press', 'not_announced'] as const) {
      expect(attemptAfterFailure(new ChatSignatureDeferred(reason)), reason).toBe('none');
    }
  });

  it('настоящий отказ становится «не удалось»', () => {
    // Замок, который горит всегда, — не замок.
    expect(attemptAfterFailure(new Error('сеть'))).toBe('failed');
    expect(attemptAfterFailure(new ChatDirectoryError('503', 'directory_unavailable'))).toBe('failed');
    expect(attemptAfterFailure('мусор вместо ошибки')).toBe('failed');
    expect(attemptAfterFailure(null)).toBe('failed');
  });

  it('СЛЕДСТВИЕ: после отказа порога автоматика на десктопе жива', () => {
    // Главное. Мерится не классификация сама по себе, а то, ради чего она есть.
    const after = attemptAfterFailure(new ChatSignatureDeferred('page_hidden'));
    expect(announceMayAuto({
      keyOnDevice: true, standing: 'absent', attempt: after, gate: 'go',
    }), 'десктоп потерял автоматику из-за одного моргания видимости').toBe(true);
  });

  it('СЛЕДСТВИЕ: после настоящего отказа автоматика молчит, а кнопка есть', () => {
    const after = attemptAfterFailure(new Error('сеть'));
    expect(announceMayAuto({ keyOnDevice: true, standing: 'absent', attempt: after, gate: 'go' })).toBe(false);
    expect(announceNeedsPress({ keyOnDevice: true, standing: 'absent', attempt: after, gate: 'go' })).toBe(true);
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
