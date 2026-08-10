/**
 * arbiterClaimPhoneCircumstances.test.ts — вечная петля на телефоне, ответ числом.
 *
 * Находка №1 финального ревью ветки: на телефоне арбитр не мог взять спор
 * ВООБЩЕ — гейт подписи стоял ОДИН РАЗ, ПОСЛЕ добычи ключа чата, и видел
 * СВОЙ ЖЕ уход к кошельку (`noteWalletHandoff()` внутри
 * `createGatedSignChatKey` взводит отметку, следующая проверка гейта тут же
 * её читает). Выйти из отсрочки было нечем: страница нигде не звала
 * `clearWalletHandoff()`, а на повторном нажатии ключ читается с диска БЕЗ
 * новой подписи (`chatSession.ts:995-997`) — значит новой отметки не будет,
 * и старая держится до перезагрузки вкладки.
 *
 * Замер ревьюера: 20 нажатий → взято 0, «нажмите ещё раз» — 20.
 *
 * Этот файл прогоняет ТОЧНУЮ последовательность обработчика —
 * `runGatedKeyAction` (`arbiterClaimKeys.ts`), ту же функцию, которую зовут
 * все три места страницы арбитра, — против НАСТОЯЩЕГО `chatSignatureGate.ts`,
 * не против пересказа. Подставные — только подписчик кошелька (окна кошелька
 * настоящего нет) и сама транзакция; гейт, отметка ухода и их правила —
 * боевой код.
 *
 * ⚠️ ЧЕСТНО О ГРАНИЦЕ. «Ключ уже на диске, повторная добыча не подписывает
 * заново» — поведение НАСТОЯЩЕГО `chatSession.ts` (`openSession`, строки
 * 995-997), покрытое своими тестами (`chatSession.test.ts`). Здесь оно не
 * перепроверяется, а СМОДЕЛИРОВАНО простым флагом — иначе пришлось бы тащить
 * сюда всю подделку IndexedDB `chatSession.test.ts`, а измеряется в этом
 * файле другое: гейт-последовательность `runGatedKeyAction`, а не хранилище.
 * Пограничная сцепка двух модулей — то, ПОЧЕМУ на телефоне первое нажатие
 * стоит второго, а не механика диска сама по себе.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runGatedKeyAction, createGatedSignChatKey, type GatedSignChatKey } from './arbiterClaimKeys';
import { _resetSignatureGateForTest, isSignatureDeferred } from './chatSignatureGate';

interface FakePage {
  visibilityState: 'visible' | 'hidden';
  listeners: Set<() => void>;
  addEventListener: (t: string, fn: () => void) => void;
  removeEventListener: (t: string, fn: () => void) => void;
  goAway: () => void;
  comeBack: () => void;
}
function fakePage(): FakePage {
  const p: FakePage = {
    visibilityState: 'visible',
    listeners: new Set(),
    addEventListener: (t, fn) => { if (t === 'visibilitychange') p.listeners.add(fn); },
    removeEventListener: (_t, fn) => { p.listeners.delete(fn); },
    goAway() { p.visibilityState = 'hidden'; for (const fn of p.listeners) fn(); },
    comeBack() { p.visibilityState = 'visible'; for (const fn of p.listeners) fn(); },
  };
  return p;
}

let page: FakePage;

beforeEach(() => {
  _resetSignatureGateForTest();
  page = fakePage();
  vi.stubGlobal('document', page);
});

afterEach(() => {
  _resetSignatureGateForTest();
  vi.unstubAllGlobals();
});

/**
 * Строит `deriveKey`, моделирующий `deriveClaimChatKeys` → `openSession`:
 * первый вызов ПОДПИСЫВАЕТ (через настоящий `createGatedSignChatKey`, значит
 * настоящий `noteWalletHandoff()` тоже настоящий), последующие — читают «с
 * диска» и подписи не просят вовсе, ровно как `chatSession.ts:995-997`.
 */
function makeDeriveKey(rawSign: () => Promise<`0x${string}`>) {
  let onDisk = false;
  const gatedSign: GatedSignChatKey = createGatedSignChatKey(rawSign);
  return async () => {
    if (!onDisk) {
      await gatedSign({} as never);
      onDisk = true;
    }
    return { key: onDisk ? 'from-disk-or-fresh' : 'unreachable' } as const;
  };
}

async function pressTwenty(deriveKey: () => Promise<{ key: string }>) {
  let claimed = 0;
  let deferred = 0;
  for (let i = 0; i < 20; i++) {
    try {
      await runGatedKeyAction(deriveKey, async () => { claimed++; });
    } catch (err) {
      if (isSignatureDeferred(err)) { deferred++; continue; }
      throw err;
    }
  }
  return { claimed, deferred };
}

describe('runGatedKeyAction — 20 нажатий «Взяться за спор»', () => {
  it('телефон (кошелёк прячет страницу): 19 из 20 берут спор, 1 откладывается', async () => {
    // «Телефонный» кошелёк — отдельное приложение: показывая окно, система
    // прячет нашу страницу и сама возвращает её, когда человек подписал.
    const rawSign = async () => { page.goAway(); page.comeBack(); return '0xsig' as `0x${string}`; };
    const deriveKey = makeDeriveKey(rawSign);

    const { claimed, deferred } = await pressTwenty(deriveKey);

    // Первое нажатие тратится на саму добычу ключа (страница уходила в
    // кошелёк — вторая, автоматическая подпись отложена, как и задумано).
    // Ключ при этом УЖЕ на диске, и все следующие 19 нажатий берут спор
    // сразу, без нового похода в кошелёк за ключом.
    expect({ claimed, deferred }).toEqual({ claimed: 19, deferred: 1 });
  });

  it('десктоп (кошелёк не прячет страницу): 20 из 20 берут спор сразу', async () => {
    const rawSign = async () => '0xsig' as `0x${string}`; // страница никогда не пропадала
    const deriveKey = makeDeriveKey(rawSign);

    const { claimed, deferred } = await pressTwenty(deriveKey);

    expect({ claimed, deferred }).toEqual({ claimed: 20, deferred: 0 });
  });
});
