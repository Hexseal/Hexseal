/**
 * chatKeyAttestationTypeBans.ts — фикстура ЗАПРЕЩЁННЫХ ПОДСТАНОВОК для формы
 * заверения и для словаря вердиктов.
 *
 * ⚠️ ПОЧЕМУ ЭТО НЕ `*.test.ts`. `frontend/tsconfig.json` исключает из программы
 * tsc любые `*.test.ts`, по любому пути — замерено соседней задачей:
 * `const n: number = "строка"` в тест-файле даёт `npm run type-check` НОЛЬ
 * ошибок и код выхода 0, тот же текст в обычном `.ts` даёт TS2322 и код 2.
 * Фикстура, положенная в тест, была бы замком, который зеленеет всегда.
 *
 * Каждый `@ts-expect-error` ниже — утверждение «это НЕ компилируется», и он
 * двусторонний: снимешь директиву — появится ошибка подстановки; ослабишь тип —
 * директивы станут ЛИШНИМИ (TS2578). Молча выродиться в ничто фикстура не может.
 *
 * Импортируется тестом (`chatKeyAttestation.test.ts`) не ради поведения, а чтобы
 * удаление этого файла краснело и в `npm test`: type-check от удаления запретов
 * молчит — файла нет, проверять нечего (мутация М30).
 */
import {
  verifyChatKeyAttestation, verifyChatKeyAttestationForKeys,
  type ChatKeyAttestation, type AttestationVerdict,
} from './chatKeyAttestation';

/** Сколько запретов стоит ниже. Число записано РУКАМИ: производное от самой
 *  фикстуры доказывало бы только «сколько-то запретов есть». */
export const FORBIDDEN_SUBSTITUTIONS = 4;

/**
 * Все вердикты, названные руками и по порядку. Исчезнет любой из союза — здесь
 * TS2322, и это единственное место, где «словарь стал беднее» видно ДО того,
 * как читалка арбитра показала бы пустоту вместо причины.
 */
export const EVERY_VERDICT: AttestationVerdict[] = [
  'ok', 'absent', 'malformed', 'bad_signature', 'wrong_address', 'wrong_keys', 'expired',
];

/**
 * Разбор по вердиктам, исчерпывающий по форме: `never` в `default` не даст
 * добавить восьмой вердикт, не обработав его. Употребляется тестом (A15) —
 * значит это не только тип-замок.
 */
export function verdictsAreExhaustive(v: AttestationVerdict): string {
  switch (v) {
    case 'ok': return 'ok';
    case 'absent': return 'absent';
    case 'malformed': return 'malformed';
    case 'bad_signature': return 'bad_signature';
    case 'wrong_address': return 'wrong_address';
    case 'wrong_keys': return 'wrong_keys';
    case 'expired': return 'expired';
    default: { const nothingLeft: never = v; return nothingLeft; }
  }
}

/** Непроверенная строка — ровно то, что приезжает из JSON справочника. */
const fromNetwork: string = '0x' + '11'.repeat(32);

const att: ChatKeyAttestation = {
  address: '0x00000000000000000000000000000000000000a1',
  boxKey: `0x${'11'.repeat(32)}`,
  signKey: `0x${'22'.repeat(32)}`,
  issuedAt: 1,
  signature: '0xab',
};

/** Никогда не вызывается. Её работа — быть проверенной тип-чекером. */
export async function forbiddenSubstitutionsMustNotCompile(): Promise<void> {
  // РАЗРЕШЕНО: клеймёные поля остаются строками там, где ждут строку.
  const shown: string = att.boxKey;
  if (shown.length === 0) return;

  // 1. непроверенная строка на месте ключа запечатывания. Класс промаха
  //    замерен в этом проекте: 0 красных из 1826 (`arbiterChatKey.ts:28-42`).
  // @ts-expect-error ключ заверения — не любая строка
  const bad1: ChatKeyAttestation = { ...att, boxKey: fromNetwork };

  // 2. то же для подписного ключа
  // @ts-expect-error ключ заверения — не любая строка
  const bad2: ChatKeyAttestation = { ...att, signKey: fromNetwork };

  // 3. вердикт, которого нет в словаре: опечатка читалки не должна
  //    компилироваться. Без этого запрета `if (verdict === 'unverified')`
  //    молча никогда не срабатывал бы — тот же класс, что мёртвая ветка.
  const verdict = await verifyChatKeyAttestation(att);
  // @ts-expect-error 'unverified' — не вердикт; словарь ровно из семи слов
  if (verdict === 'unverified') return;

  // 4. параметр `expected` — ОБЯЗАТЕЛЬНЫЙ аргумент (поля внутри необязательны,
  //    договор об именах v4): без объекта вовсе вердикта `wrong_keys` быть не
  //    может, и «забыть сверить» не должно компилироваться (Л-9). Сделать
  //    необязательным сам ПАРАМЕТР нельзя — это дало бы TS2578 здесь же.
  // @ts-expect-error без объекта ожидаемых ключей сверять нечего
  await verifyChatKeyAttestationForKeys(att);

  void bad1; void bad2;
}
