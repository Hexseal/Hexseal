import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it, vi } from 'vitest';

import { locales } from './config';
import {
  ACTIVATION_WINDOW,
  AUTO_APPROVE_WINDOW,
  DEADLINE_GRACE,
  DISPUTE_WINDOW,
} from '@/config/constants';

/**
 * ПОЧЕМУ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ
 *
 * Копирайт про сроки сделки врал на живом сайте, и врал двумя разными
 * способами сразу — оба тихие, оба нашлись только ручным замером
 * (`docs/OPEN-ITEMS.md` п. 12).
 *
 *  1. РАСХОЖДЕНИЕ СО СМЫСЛОМ. Число суток было написано словами в пятнадцати
 *     файлах переводов. Контракт менялся, переводы — нет. Исполнителю обещали
 *     3 дня на активацию, пока `ACTIVATION_WINDOW` уже была двухдневной, и
 *     кнопка возврата у клиента появлялась на той же странице раньше, чем
 *     истекал обещанный срок. Арбитру обещали 7-дневное окно спора через год
 *     после того, как `DISPUTE_WINDOW` стала четырёхдневной, — это прямая
 *     судейская ошибка за неявку.
 *  2. РАСХОЖДЕНИЕ В НАЛИЧИИ. Обратный отсчёт на экране арбитра рисовался
 *     сырыми ключами в 12 локалях из 14: ключа там просто не было.
 *
 * Отсюда три группы проверок ниже. Первая держит числа привязанными к
 * контракту, вторая — состав ключей, третья — синтаксис ICU и набор
 * подстановок: перевод, потерявший `{days}`, снова напечатает фразу без срока,
 * и заметить это глазами так же трудно, как и в первый раз.
 */

// ─── 1. Константы окон против самого контракта ───────────────────────────────
//
// Эталон — `src/Agreement.sol`, а не память и не документация: таблицы адресов
// и чисел в docs/ этого проекта протухали неоднократно. CI выкачивает весь репо
// и запускает `npm test` из `frontend/`, поэтому путь наверх здесь рабочий.

const AGREEMENT_SOL = fileURLToPath(
  new URL('../../../src/Agreement.sol', import.meta.url),
);

/** Вытаскивает `uint256 public constant <NAME> = <N> days;` из исходника. */
function solidityWindowDays(source: string, name: string): number {
  const m = new RegExp(
    String.raw`uint256\s+public\s+constant\s+${name}\s*=\s*(\d+)\s*days\s*;`,
  ).exec(source);
  if (!m) throw new Error(`Agreement.sol: константа ${name} не найдена`);
  return Number(m[1]);
}

describe('окна жизненного цикла сделки совпадают с Agreement.sol', () => {
  const source = readFileSync(AGREEMENT_SOL, 'utf8');

  // Пары «константа фронта → имя в контракте». Если контракт переименует или
  // удалит константу, тест падает на «не найдена», а не проходит молча.
  const pairs: Array<[string, bigint, string]> = [
    ['ACTIVATION_WINDOW', ACTIVATION_WINDOW, 'ACTIVATION_WINDOW'],
    ['AUTO_APPROVE_WINDOW', AUTO_APPROVE_WINDOW, 'AUTO_APPROVE_WINDOW'],
    ['DISPUTE_WINDOW', DISPUTE_WINDOW, 'DISPUTE_WINDOW'],
    ['DEADLINE_GRACE', DEADLINE_GRACE, 'DEADLINE_GRACE'],
  ];

  for (const [label, frontendValue, solidityName] of pairs) {
    it(`${label} — столько же секунд, сколько в контракте`, () => {
      const days = solidityWindowDays(source, solidityName);
      expect(frontendValue).toBe(BigInt(days * 86400));
    });
  }
});

// ─── 2. Состав ключей: 14 локалей ключ-в-ключ с английской ───────────────────

type Messages = Record<string, unknown>;

const bundles: Record<string, Messages> = {};
for (const locale of locales) {
  // Статический путь с переменной Vite разрешает через glob-импорт, но здесь
  // проще и надёжнее читать файлом: тест бегает в node-окружении.
  const path = fileURLToPath(
    new URL(`../../messages/${locale}.json`, import.meta.url),
  );
  bundles[locale] = JSON.parse(readFileSync(path, 'utf8')) as Messages;
}

/** Плоский список путей вида `deal.funded_client_hint` → строка. */
function flatten(node: unknown, prefix = '', out: Record<string, string> = {}) {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node as Messages)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out);
    }
  } else if (typeof node === 'string') {
    out[prefix] = node;
  }
  return out;
}

const enFlat = flatten(bundles.en);
const enKeys = Object.keys(enFlat).sort();

describe('состав ключей локалей', () => {
  it('в config.locales ровно 14 языков', () => {
    expect(locales.length).toBe(14);
  });

  for (const locale of locales) {
    if (locale === 'en') continue;
    it(`${locale} — ключ-в-ключ с английской`, () => {
      const keys = Object.keys(flatten(bundles[locale])).sort();
      expect(keys).toEqual(enKeys);
    });
  }
});

// ─── 3. ICU: синтаксис и набор подстановок ───────────────────────────────────

/** Имена аргументов, которые сообщение реально требует при рендере. */
function icuArgs(message: string, locale: string): Set<string> {
  const args = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (nodes: any[]) => {
    for (const node of nodes) {
      // type 0 — литеральный текст, у него `value` это сама строка, не аргумент.
      if (node.type !== 0 && typeof node.value === 'string') args.add(node.value);
      if (node.options) {
        for (const option of Object.values(node.options)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          walk((option as any).value);
        }
      }
      if (node.children) walk(node.children);
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  walk(new IntlMessageFormat(message, locale).getAst() as any[]);
  return args;
}

describe('ICU-разметка сообщений', () => {
  for (const locale of locales) {
    it(`${locale} — все сообщения парсятся и требуют те же подстановки, что английские`, () => {
      const flat = flatten(bundles[locale]);
      const broken: string[] = [];
      const drifted: string[] = [];

      for (const key of enKeys) {
        const message = flat[key];
        if (message === undefined) continue; // отловлено проверкой состава выше

        let args: Set<string>;
        try {
          args = icuArgs(message, locale);
        } catch (error) {
          broken.push(`${key}: ${(error as Error).message}`);
          continue;
        }

        // Перевод, потерявший `{days}`, — это ровно тот баг, из-за которого
        // сроки писались числом руками: строка выглядит целой, а срока в ней
        // больше нет. Лишний аргумент так же плох: он никогда не придёт.
        const expected = icuArgs(enFlat[key], 'en');
        const missing = [...expected].filter((a) => !args.has(a));
        const extra = [...args].filter((a) => !expected.has(a));
        if (missing.length || extra.length) {
          drifted.push(
            `${key}: нет [${missing.join(', ')}], лишние [${extra.join(', ')}]`,
          );
        }
      }

      expect(broken).toEqual([]);
      expect(drifted).toEqual([]);
    });
  }
});

// ─── 4. Строки про сроки действительно печатают число из контракта ───────────
//
// Проверки выше гарантируют, что `{days}` на месте и парсится. Эта — что он
// подставляется в текст, который человек прочитает, и что это именно число
// контракта. Ключи перечислены руками: их немного, и каждый в своё время
// соврал живому пользователю.

interface DeadlineCopy {
  key: string;
  window: bigint;
  /**
   * Можно ли искать в отрендеренном тексте «осталась старая цифра». Для
   * `faq.a_how_deal` — нельзя: это нумерованный список из шести шагов, и
   * цифры 3 и 5 в нём законные номера пунктов, а не сроки.
   */
  scanStaleDigits: boolean;
}

const DEADLINE_COPY: DeadlineCopy[] = [
  { key: 'deal.funded_executor_hint', window: ACTIVATION_WINDOW, scanStaleDigits: true },
  { key: 'deal.funded_client_hint', window: ACTIVATION_WINDOW, scanStaleDigits: true },
  { key: 'faq.a_no_activate', window: ACTIVATION_WINDOW, scanStaleDigits: true },
  { key: 'faq.a_cancel', window: ACTIVATION_WINDOW, scanStaleDigits: true },
  { key: 'faq.a_how_deal', window: AUTO_APPROVE_WINDOW, scanStaleDigits: false },
  // Добавлено 12 августа 2026. Ключа здесь не было — и именно в нём срок был
  // написан числом («5 days») спустя год после того, как AUTO_APPROVE_WINDOW
  // стала двухдневной: страница звала его вообще без подстановки
  // (`faq/page.tsx`), так что ловить расхождение было нечем.
  { key: 'faq.a_autoapprove', window: AUTO_APPROVE_WINDOW, scanStaleDigits: true },
  { key: 'arbiter.my_cases_desc', window: DISPUTE_WINDOW, scanStaleDigits: true },
];

describe('копирайт про сроки печатает число окна, а не своё', () => {
  for (const { key, window, scanStaleDigits } of DEADLINE_COPY) {
    const days = Number(window) / 86400;

    it(`${key} — во всех 14 локалях подставляет ${days}`, () => {
      const offenders: string[] = [];

      for (const locale of locales) {
        const message = flatten(bundles[locale])[key];
        expect(message, `${locale}: ключ ${key} отсутствует`).toBeDefined();

        // `{days}` обязателен: без него число снова написано словами.
        if (!icuArgs(message, locale).has('days')) {
          offenders.push(`${locale}: нет подстановки {days}`);
          continue;
        }

        const format = (n: number) =>
          String(new IntlMessageFormat(message, locale).format({ days: n }));
        const rendered = format(days);

        // Подстановка обязана быть видна в тексте, а не проглочена ветвью
        // plural: строка с `{days}`, которая печатается одинаково для 2 и 9,
        // срок пользователю так и не сообщает.
        if (rendered === format(days + 7)) {
          offenders.push(`${locale}: {days} не влияет на текст`);
        }

        if (!scanStaleDigits) continue;

        // Ни одна из старых лживых цифр не должна пережить подстановку.
        // Именно они стояли в этих строках: 3 дня на активацию, 5 дней до
        // автоприёма, 7-дневное окно спора.
        for (const stale of [3, 5, 7]) {
          if (stale === days) continue;
          const asDigits = new Intl.NumberFormat(locale).format(stale);
          if (rendered.includes(asDigits)) {
            offenders.push(`${locale}: в тексте осталось число ${stale}`);
          }
        }
      }

      expect(offenders).toEqual([]);
    });
  }
});

// ─── 4. Подвал: обещание про план — и лозунг, которого код не даёт ───────────
//
// ⚠️ ЗАЧЕМ ЗАМОК ИМЕННО ЗДЕСЬ И ИМЕННО ТАКОЙ.
//
// 12 августа 2026 подпись подвала во всех локалях утверждала «Без
// администраторов. Код — закон», хотя владелец диамонда отменяет вердикт
// арбитра (`ArbiterRegistryFacet.overturnVerdict`) и меняет любой фасет
// (`diamondCut`). Подпись переписана на честную, и она теперь ОБЕЩАЕТ, что план
// передачи управления опубликован, — значит в подвале обязана быть ссылка на
// сам план, иначе обещание пустое.
//
// Замок меряет УПОТРЕБЛЕНИЕ, а не наличие строки: подвал рендерится настоящий,
// и проверяется разметка. Вычеркнуть ссылку из файла и оставить импорт — тот
// самый способ пройти мимо текстового замка, которым этот проект уже платил.
//
// И вторая половина важнее первой: ссылку заметят глазами, а вернувшийся лозунг
// — нет. Поэтому список запрещённых утверждений проверяется по ВСЕМ файлам
// каталога переводов, а не по списку `locales`: публикуется каталог целиком.
// Не подключённых файлов в нём сейчас нет — сироту `zh.json` снесли 14 августа
// 2026, — но именно она однажды пронесла мимо замков мёртвый адрес, и обход по
// каталогу оставлен затем, чтобы следующая такая не прошла.
//
// ⚠️ Этот же замок ловит промах, которым он и оплачен: правка, адресованная
// «ключу tagline», попала в секцию `hero` вместо `footer` — состав ключей
// остался сойтись, сборка собралась, а «No admins» остался на месте.
const DOC_LINK = 'https://github.com/Hexseal/Hexseal/blob/main/docs/DECENTRALIZATION.md';
const MESSAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../messages');

/** Утверждения, которых код не даёт ни на одном языке. */
const BANNED_CLAIMS = [
  'No admins', 'Code is law',
  'Без администраторов', 'Код — закон',
  'Без адмінів', 'Keine Admins', 'Code ist Gesetz',
  'Sans admins', 'code fait loi',
  'Sin administradores', 'código es la ley',
  'Nessun admin', 'codice è legge',
  'Sem admins', 'código é a lei',
  'بلا مشرفين', 'الكود هو القانون',
  'कोई एडमिन नहीं', 'कोड ही कानून',
  '管理者なし', 'コードが法律',
  '관리자 없음', '코드가 법',
  'ไม่มีผู้ดูแล', 'โค้ดคือกฎหมาย',
  '无管理员', '代码即法律',
];

function translateFromEn(key: string): string {
  const value = key.split('.').reduce<unknown>(
    (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
    bundles.en,
  );
  if (typeof value !== 'string') throw new Error(`нет ключа перевода: ${key}`);
  return value;
}

vi.mock('next-intl', () => ({ useTranslations: () => translateFromEn }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined, isConnected: false }) }));

describe('подвал не обещает того, чего код не даёт', () => {
  it('ссылка на план РИСУЕТСЯ, и ни одна локаль не утверждает отсутствие администраторов', async () => {
    const React = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { default: Footer } = await import('@/components/Footer');

    const html = renderToStaticMarkup(React.createElement(Footer));

    expect(html, 'подпись подвала не доехала до разметки').toContain(
      translateFromEn('footer.tagline'),
    );
    expect(html, `в подвале нет ссылки на ${DOC_LINK} — подпись обещает план, взять его негде`)
      .toContain(DOC_LINK);
    expect(html, 'ссылка есть, а подписи у неё нет — человеку не на что нажать')
      .toContain(translateFromEn('footer.decentralization'));

    const guilty: string[] = [];
    const files = readdirSync(MESSAGES_DIR).filter((f) => f.endsWith('.json'));
    expect(files.length, 'файлы переводов не найдены — замок остался бы зелёным ни на чём')
      .toBeGreaterThanOrEqual(locales.length);
    for (const file of files) {
      const dict = JSON.parse(readFileSync(join(MESSAGES_DIR, file), 'utf8')) as Messages;
      const tagline = (dict.footer as Record<string, unknown> | undefined)?.tagline;
      if (typeof tagline !== 'string') {
        guilty.push(`${file}: нет footer.tagline`);
        continue;
      }
      for (const claim of BANNED_CLAIMS) {
        if (tagline.includes(claim)) guilty.push(`${file}: «${claim}»`);
      }
    }
    expect(guilty).toEqual([]);
  });
});
