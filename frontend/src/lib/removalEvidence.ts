/**
 * removalEvidence.ts — доказательство к обвинению: файл наружу, отпечаток в цепь.
 *
 * Замысел `2026-08-21-arbiter-screens-design.md`, раздел 1 (решение владельца):
 *
 *   • в цепь уходит ТОЛЬКО отпечаток (`evidenceDigest`), содержимого там не
 *     бывает никогда — доказательство слива переписки это и есть переписка, и
 *     опубликовав его, мы дали бы пострадавшему второй слив, вечный и
 *     публичный (раздел 2);
 *   • файл лежит на релеере, и долговечность ему даёт ЧИСЛО КОПИЙ, а не место:
 *     копия у обвинителя, копия у обвинённого (он получает доказательство
 *     вместе с обвинением, иначе ему нечего опровергать), копия у любого, кто
 *     открыл историю. Умер релеер — отпечаток сходится с чужой копией.
 *
 * ⚠️ ГЛАВНОЕ В ЭТОМ ФАЙЛЕ — КОРЗИНА, А НЕ ЗАЛИВКА.
 *
 * У релеера ДВЕ файловые корзины, и попасть не в ту здесь стоит дороже всего:
 *
 *   • `/files/presign`        → `/storage/files/`, ЧАТОВАЯ, TTL 7 ДНЕЙ,
 *                               чистится ежедневно в 03:00;
 *   • `/files/public/presign` → `/storage/public/`, ПОСТОЯННАЯ, там же, где
 *                               профили и аватары (`max-age: 365d`).
 *
 * Обвинение живёт 14 дней (`PROPOSAL_TTL`), а запись о сносе — вечно. Уйди
 * доказательство в чатовую корзину, и на восьмой день отпечаток пережил бы
 * файл ПО УСТРОЙСТВУ: в цепи осталось бы обязательство, проверить которое
 * нечем. Причём молча — ни отказа, ни события, просто ссылка перестаёт
 * отвечать через неделю после того, как все посмотрели и разошлись.
 *
 * Поэтому заливка идёт через `/api/ipfs/upload` (обычный файл, Flow B), а тот
 * маршрут ходит в `/files/public/presign`. Замок — `removalEvidence.test.ts`:
 * он сверяет и адрес, которым зовём отсюда, и то, в какую корзину этот адрес
 * ведёт, читая исходник самого маршрута. Одной проверки мало: первая молчит,
 * если корзину переключат в маршруте; вторая — если позовём мимо маршрута.
 */

import { keccak256, type Hex } from 'viem';

/**
 * Дверь к ПОСТОЯННОЙ корзине.
 *
 * ⚠️ Не `RELAYER_URL + '/files/public/presign'` напрямую: маршрут Next'а поверх
 * релеера — не украшение. Он держит ограничитель (10 заливок в минуту на IP),
 * переписывает localhost-адреса, которые релеер отдаёт без
 * `RELAYER_PUBLIC_URL`, и разводит внутренний адрес (докер-сеть) с внешним
 * (браузер). Обойти его — значит завести всё это заново и разойтись.
 */
export const EVIDENCE_UPLOAD_ENDPOINT = '/api/ipfs/upload';

/**
 * Потолок на доказательство. Тот же, что у маршрута (`MAX_FILE_SIZE` в
 * `app/api/ipfs/upload/route.ts`), — чтобы человек узнал о нём ДО заливки, а
 * не 413-м после.
 */
export const MAX_EVIDENCE_BYTES = 100 * 1024 * 1024;

export interface RemovalEvidence {
  /** Тридцать два байта, которые лягут в цепь. */
  digest: Hex;
  /** Постоянная ссылка на файл. В цепь НЕ идёт — только людям. */
  url: string;
  /** Имя, как его дал человек: цепь его не увидит, история покажет. */
  name: string;
  size: number;
}

export class EvidenceTooLargeError extends Error {
  constructor(public readonly size: number) {
    super(`Evidence file is ${Math.round(size / 1024 / 1024)} MB — the cap is ${MAX_EVIDENCE_BYTES / 1024 / 1024} MB`);
    this.name = 'EvidenceTooLargeError';
  }
}

/**
 * Отпечаток доказательства — `keccak256` СЫРЫХ БАЙТОВ ФАЙЛА.
 *
 * ⚠️ ПРЕ-ОБРАЗ НАЗВАН ЗДЕСЬ ДОСЛОВНО, ПОТОМУ ЧТО ПРОВЕРИТЬ ЕГО НЕЧЕМ. Цепь
 * видит 32 байта и совпадения не проверяет — возьми сверяющая сторона другой
 * пре-образ (файл в base64, контейнер с именем, канонический JSON), и
 * «сходится» не сошлось бы никогда, а узнали бы мы об этом от обвинённого со
 * сломанной сверкой. Договор простой нарочно: хэш содержимого файла, как оно
 * лежит на диске. Тот же `keccak256`, что в цепи, — второй функции хэша в
 * проекте не заводить (ср. `presentationDigest`).
 */
export async function evidenceDigest(file: Blob): Promise<Hex> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return keccak256(bytes);
}

/**
 * Залить доказательство в ПОСТОЯННУЮ корзину и вернуть отпечаток.
 *
 * `fetchImpl` — только для замка: боевой путь берёт `globalThis.fetch`.
 */
export async function uploadRemovalEvidence(
  file: File,
  fetchImpl: typeof fetch = fetch,
): Promise<RemovalEvidence> {
  if (file.size > MAX_EVIDENCE_BYTES) throw new EvidenceTooLargeError(file.size);

  // Отпечаток считается ДО заливки нарочно: если сервер недоступен, человек уже
  // знает 32 байта своего файла и может положить обвинение позже, тем же
  // отпечатком, не потеряв доказательства.
  const digest = await evidenceDigest(file);

  const form = new FormData();
  form.append('file', file);

  const res = await fetchImpl(EVIDENCE_UPLOAD_ENDPOINT, { method: 'POST', body: form });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Evidence upload failed (${res.status})`);
  }
  const { url } = (await res.json()) as { url: string };
  if (!url) throw new Error('Evidence upload returned no URL');

  return { digest, url, name: file.name, size: file.size };
}
