'use client';

/**
 * Пропуск к журналу спора — чтобы арбитр подписывал один раз, а не на каждое
 * открытие истории.
 *
 * ЗАЧЕМ. Принять спор стоило трёх подписей: `commitDisputeClaim`,
 * `claimDispute` и — отдельно — чтение переписки. Первые две это commit-reveal,
 * он защищает от перехвата чужого спора и остаётся как есть. Третья была лишней
 * при КАЖДОМ открытии: релеер требовал свежую подпись
 * `hexseal:dispute-log:{deal}:{unix}` с окном ±5 минут на каждый GET, так что
 * «открыл — закрыл — открыл» стоило ещё одного окна кошелька.
 *
 * ЧТО ХРАНИТСЯ. Непрозрачный токен, который выдал релеер: MAC над тройкой
 * (сделка, адрес арбитра, срок) на его собственном секрете. Здесь он лежит
 * только как строка — фронт его не разбирает и не может подделать.
 *
 * ЧЕМ ЭТО НЕ ОСЛАБЛЕНИЕ ДОСТУПА. Пропуск заменяет только доказательство «кто
 * спрашивает». Право на журнал релеер перепроверяет в цепи на КАЖДОМ запросе:
 * держит ли этот адрес спор прямо сейчас. Отпустил клейм — пропуск перестаёт
 * работать на следующем же чтении, до всякого истечения срока.
 *
 * ПОЧЕМУ sessionStorage, А НЕ localStorage. Пропуск — предъявительский: кто
 * держит строку, тот в пределах её срока читает журнал этой сделки. Значит его
 * время жизни на диске должно быть не длиннее рабочего сеанса. sessionStorage
 * умирает вместе со вкладкой, но переживает перезагрузку страницы и переходы
 * по ней — то есть ровно те случаи, из-за которых и появлялись лишние подписи.
 * localStorage пережил бы закрытый браузер и общий компьютер, а это уже не
 * сеанс, а хранение ключа.
 *
 * СМЕНА КОШЕЛЬКА. Ключ содержит адрес, поэтому чужой пропуск просто не
 * находится. Сверх того `dropForeignPasses()` при каждом обращении вычищает
 * пропуска всех остальных адресов — «сменил кошелёк, старый пропуск
 * недействителен» становится фактом в хранилище, а не следствием того, что мы
 * не туда посмотрели.
 */

export type DisputeLogPass = { token: string; expiresAt: number };

const PREFIX = 'hexseal:dispute-log-pass:';

/** Запас на дорогу до релеера: пропуск, которому осталось меньше — считаем
 *  просроченным здесь, вместо гарантированного 401 с той стороны. */
const EXPIRY_SKEW_SEC = 30;

function keyFor(address: string, dealId: string): string {
  return `${PREFIX}${address.toLowerCase()}:${dealId.toLowerCase()}`;
}

/** sessionStorage недоступен при SSR и умеет бросать в приватных режимах и при
 *  отключённых сайтовых данных. Все обращения к нему проходят здесь: отсутствие
 *  хранилища должно означать «просто подпишем ещё раз», а не упавшую страницу. */
function store(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Удаляет пропуска, выданные любому адресу кроме текущего. */
export function dropForeignPasses(address: string): void {
  const s = store();
  if (!s) return;
  const mine = `${PREFIX}${address.toLowerCase()}:`;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(PREFIX) && !k.startsWith(mine)) doomed.push(k);
    }
    for (const k of doomed) s.removeItem(k);
  } catch { /* хранилище недоступно — чистить нечего */ }
}

export function savePass(address: string, dealId: string, pass: DisputeLogPass): void {
  const s = store();
  if (!s || !pass?.token) return;
  try {
    s.setItem(keyFor(address, dealId), JSON.stringify(pass));
  } catch { /* переполнено или запрещено — просто останемся на подписи */ }
}

export function clearPass(address: string, dealId: string): void {
  const s = store();
  if (!s) return;
  try { s.removeItem(keyFor(address, dealId)); } catch { /* см. store() */ }
}

/**
 * Живой пропуск этого адреса на эту сделку, либо null.
 * Побочно вычищает пропуска других адресов — точка входа одна, значит и место
 * для этой уборки одно.
 */
export function loadPass(
  address: string,
  dealId: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): string | null {
  dropForeignPasses(address);
  const s = store();
  if (!s) return null;
  let raw: string | null = null;
  try { raw = s.getItem(keyFor(address, dealId)); } catch { return null; }
  if (!raw) return null;

  let parsed: Partial<DisputeLogPass>;
  try { parsed = JSON.parse(raw) as Partial<DisputeLogPass>; } catch {
    clearPass(address, dealId);
    return null;
  }

  if (typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'number') {
    clearPass(address, dealId);
    return null;
  }
  if (parsed.expiresAt - EXPIRY_SKEW_SEC <= nowSec) {
    clearPass(address, dealId);
    return null;
  }
  return parsed.token;
}
