/**
 * chatRecoveryTwoTabs.test.ts — обстоятельство 3 для показа кода: две
 * вкладки открывают сеанс разом. Сколько окон с кодом и один ли это код?
 *
 * ⚠️ ПОЧЕМУ ОТДЕЛЬНО ОТ `chatSession.test.ts`. Там замерено, что две вкладки
 * дают ОДНО окно подписи и один и тот же закрытый ключ. Про КОД там не
 * сказано ничего, а вопрос не тот же самый: показывает окно не тот, у кого
 * ключ, а тот, у кого `restored === false`. Между «ключ один» и «окно одно»
 * лежит целый признак, и он мог бы врать.
 *
 * Подделка диска переехала в `__stand__/fakeChatDisk.ts` и делится с
 * `chatRestore.test.ts`: две копии одного хранилища расходятся молча, а в
 * этой же задаче уже был случай, когда числа врал стенд, а не код.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAT_KEY_TYPED_DATA } from './chatCrypto';
import { installFakeChatDisk } from './__stand__/fakeChatDisk';

const ACCOUNT = privateKeyToAccount(`0x${'03'.repeat(32)}`);
const ADDRESS = ACCOUNT.address;

/** Подпись кошелька-КОНТРАКТА: длиннее 65 байт, значит род `contract` и
 *  ветка кода восстановления (три ступени — `establishIdentity`). */
const CONTRACT_SIG = `0x${'ab'.repeat(96)}` as `0x${string}`;
/** Обычная подпись — настоящая, над той же структурой: только такая
 *  восстанавливается в свой же адрес и даёт род `eoa`. */
const EOA_SIG = await ACCOUNT.signTypedData(CHAT_KEY_TYPED_DATA as never);

describe('обстоятельство 3: две вкладки и код восстановления', () => {
  let stand: ReturnType<typeof installFakeChatDisk>;
  beforeEach(() => { stand = installFakeChatDisk(); });
  afterEach(() => { stand?.restore(); vi.unstubAllGlobals(); vi.resetModules(); });

  it('⚠️ кошелёк-контракт, две вкладки разом — ОДИН показ и ОДИН код', async () => {
    vi.resetModules();
    const tabOne = await import('./chatSession');
    vi.resetModules();
    const tabTwo = await import('./chatSession');
    expect(tabOne.openSession).not.toBe(tabTwo.openSession); // это правда два экземпляра

    const sign = vi.fn(async () => CONTRACT_SIG);
    const [a, b] = await Promise.all([
      tabOne.openSession(ADDRESS, sign),
      tabTwo.openSession(ADDRESS, sign),
    ]);

    // Одно окно подписи — то есть личность заводилась ровно раз.
    expect(sign).toHaveBeenCalledTimes(1);

    // ⚠️ ГЛАВНОЕ ЧИСЛО. Окно с кодом показывает тот, у кого `restored ===
    // false` (`useChatSession.ts`). Здесь таких РОВНО ОДИН: вторая вкладка
    // перечитала запись под замком и пришла с `restored: true`.
    const shows = [a, b].filter(s => s.origin === 'recovery' && !s.restored);
    expect(shows).toHaveLength(1);

    // И код у обеих вкладок ОДИН И ТОТ ЖЕ — вторая не завела свой.
    const codeA = tabOne.exportRecoveryCode(a);
    const codeB = tabTwo.exportRecoveryCode(b);
    expect(codeB).toBe(codeA);
    expect(codeA.split(' ')).toHaveLength(tabOne.RECOVERY_WORD_COUNT);
  });

  it('обычный кошелёк, две вкладки разом — НОЛЬ показов', async () => {
    vi.resetModules();
    const tabOne = await import('./chatSession');
    vi.resetModules();
    const tabTwo = await import('./chatSession');

    const sign = vi.fn(async () => EOA_SIG);
    const [a, b] = await Promise.all([
      tabOne.openSession(ADDRESS, sign),
      tabTwo.openSession(ADDRESS, sign),
    ]);

    expect([a, b].filter(s => s.origin === 'recovery' && !s.restored)).toHaveLength(0);
    for (const s of [a, b]) expect(s.walletKind).toBe('eoa');
  });

  it('перезагрузка вкладки после показа — код ТОТ ЖЕ и второго окна нет', async () => {
    // Обстоятельство 1: закрыл вкладку, не записав. Запись на диске цела,
    // значит код достижим — но САМ СОБОЙ он больше не показывается.
    vi.resetModules();
    const first = await import('./chatSession');
    const opened = await first.openSession(ADDRESS, async () => CONTRACT_SIG);
    const code = first.exportRecoveryCode(opened);
    expect(opened.restored).toBe(false); // первый раз — показ

    vi.resetModules();
    const reloaded = await import('./chatSession');
    const again = await reloaded.openSession(ADDRESS, async () => CONTRACT_SIG);
    expect(again.restored).toBe(true);   // второй раз — показа нет
    // Но код на месте: пункт меню кошелька его достанет.
    expect(reloaded.exportRecoveryCode(again)).toBe(code);
  });
});
