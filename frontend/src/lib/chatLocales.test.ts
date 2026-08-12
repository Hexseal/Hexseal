/**
 * chatLocales.test.ts — тексты пересадки во всех локалях (Задача 7).
 *
 * `zh.json` НЕ ТРОГАЕТСЯ и здесь не проверяется: он сирота — в списке локалей
 * приложения его нет (`i18n/routing`, `zh-CN` — китайская локаль проекта).
 * Правило записано в плане прямым текстом; тест повторяет его числом, а не
 * доверием: список локалей задан здесь явно, и `zh.json` в нём отсутствует.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../messages');

/** Четырнадцать локалей приложения. `zh.json` — сирота, вне списка. */
const LOCALES = [
  'ar', 'de', 'en', 'es', 'fr', 'hi', 'it', 'ja', 'ko', 'pt', 'ru', 'th', 'uk', 'zh-CN',
];

/** Ключи, появившиеся вместе с пересадкой. */
const REQUIRED = [
  'chat.privacy_badge_title',
  'chat.privacy_badge_storage',
  'chat.privacy_badge_dispute',
  'chat.chain_gap',
  'chat.chain_gap_start',
  'chat.pass_signature_hint',
  'chat.key_not_saved',
  'chat.key_not_saved_blocked',
];

/** Ключи показа кода восстановления (Задача 8). Отдельным списком, а не
 *  дописью в `REQUIRED`: у них своя причина существовать и свой владелец
 *  текста — четыре первых утверждены им дословно и меняться не должны. */
const REQUIRED_RECOVERY = [
  // Утверждено владельцем — текст плашки.
  'chat.recovery_warning_title',
  'chat.recovery_warning_access',
  'chat.recovery_warning_loss',
  'chat.recovery_warning_keep',
  // Проверка «докажи, что записал» и честный выход из неё.
  'chat.recovery_written',
  'chat.recovery_skip',
  'chat.recovery_where',
  'chat.recovery_check_title',
  'chat.recovery_check_hint',
  'chat.recovery_check_word',
  'chat.recovery_check_failed',
  'chat.recovery_check_done',
  'chat.recovery_reminder',
  'chat.recovery_show',
  // Вход в восстановление по коду (Задача 8б): без него код показывался, но
  // ввести его было некуда — половина, которая пугает, без половины, ради
  // которой всё затевалось.
  'chat.restore_title',
  'chat.restore_hint',
  'chat.restore_placeholder',
  'chat.restore_submit',
  'chat.restore_menu',
  'chat.restore_done',
  'chat.restore_forget_first',
  'chat.restore_err_empty',
  'chat.restore_err_word_count',
  'chat.restore_err_unknown_word',
  'chat.restore_err_checksum',
  'chat.restore_err_busy',
  'chat.restore_err_not_applicable',
  'chat.restore_err_storage_read',
  'chat.restore_err_storage_slow',
  'chat.restore_err_address',
  'chat.restore_err_signature',
  'chat.restore_err_other',
];

/** Ключи предъявления арбитру (4в-2, Задача 6). Отдельным списком, а не
 *  дописью в `REQUIRED`: у них свой владелец текста, и `present_warn_files` —
 *  текст, утверждённый владельцем на ВЫКАТКУ 1 (правда про сегодня). */
const REQUIRED_PRESENT = [
  'chat.present_btn',
  'chat.present_pick_title',
  'chat.present_pick_hint',
  'chat.present_pick_dropped',
  'chat.present_pick_fits',
  'chat.present_pick_fits_unknown',
  'chat.present_pick_next',
  'chat.present_warn_title',
  'chat.present_warn_who',
  'chat.present_warn_turn',
  'chat.present_warn_turn_unknown',
  'chat.present_warn_everything',
  'chat.present_warn_files',
  // Ревью, круг 2: у старых вложений ключ лежит в самом сообщении.
  'chat.present_warn_legacy_files',
  'chat.present_pick_legacy_mark',
  'chat.present_warn_final',
  'chat.present_consent',
  'chat.present_send',
  'chat.present_sent',
  'chat.present_fetched',
  'chat.present_fetch_unknown',
  'chat.present_draft_found',
  'chat.present_draft_sent',
  'chat.present_draft_use',
  // Ревью, круг 1 (I-4): запись на устройстве не легла, а мешок уехал.
  'chat.present_draft_not_saved',
  'chat.present_err_arbiter_has_no_key',
  'chat.present_err_peer_has_no_key',
  'chat.present_err_nothing_selected',
  'chat.present_err_too_large',
  'chat.present_err_no_session',
  'chat.present_err_attestation_missing',
  'chat.present_err_attestation_expired',
  'chat.present_err_attestation_unproven',
  'chat.present_err_not_disputed',
  'chat.present_err_arbiter_changed',
  'chat.present_err_key_changed',
  'chat.present_err_arbiter_left',
  'chat.present_err_no_consent',
  'chat.present_err_busy',
  'chat.present_err_chain_unavailable',
  'chat.present_err_not_a_party',
  'chat.present_err_no_such_deal',
  'chat.present_err_rate_limited',
  'chat.present_err_box_refused',
  'chat.present_err_offline',
  'chat.present_err_pass_refused',
  // Ревью, круг 1 (I-5): наша поломка ДО склада — своё имя и свой текст.
  'chat.present_err_internal_error',
];

/** Ключи, которые обязаны исчезнуть: они говорили про XMTP и про журнал
 *  бота, которого больше нет. Оставленный ключ — не мусор, а обещание,
 *  которое кто-нибудь снова выведет на экран. */
const REMOVED = [
  'chat.dispute_log_badge',
  'chat.dispute_log_hint',
  'chat.log_incomplete',
  'chat.load_older',
  'chat.search_history_hint',
  'chat.open_xmtp',
  'chat.connecting_messenger',
  'notifications.enable_messaging_hint',
];

function read(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, `${locale}.json`), 'utf8'));
}

function pick(dict: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>(
    (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
    dict,
  );
}

describe('тексты пересадки — 14 локалей', () => {
  it('в каждой локали есть все новые ключи, и ни один не пустой', () => {
    const missing: string[] = [];
    for (const locale of LOCALES) {
      const dict = read(locale);
      for (const key of REQUIRED) {
        const value = pick(dict, key);
        if (typeof value !== 'string' || value.trim().length === 0) missing.push(`${locale}:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('третья строка бейджа — настоящее предложение, а не заглушка', () => {
    // Смысл проверить нечем, длину и несовпадение — можно. Заглушка вида
    // "TODO" или копия соседней строки этот замок красит.
    //
    // Порог разный: иероглифическое письмо укладывает то же предложение
    // втрое короче по символам (ja/zh-CN — 36–37 знаков против 88 у ru), и
    // единый латинский порог красил бы честный перевод. Числа записаны
    // руками по факту, а не выведены формулой.
    const MIN_LEN: Record<string, number> = { ja: 20, ko: 20, 'zh-CN': 18, th: 30 };
    const bad: string[] = [];
    for (const locale of LOCALES) {
      const dict = read(locale);
      const dispute = pick(dict, 'chat.privacy_badge_dispute');
      const storage = pick(dict, 'chat.privacy_badge_storage');
      const title = pick(dict, 'chat.privacy_badge_title');
      const min = MIN_LEN[locale] ?? 40;
      if (typeof dispute !== 'string' || dispute.length < min) bad.push(`${locale}: короткая`);
      if (dispute === storage || dispute === title) bad.push(`${locale}: копия соседней`);
    }
    expect(bad).toEqual([]);
  });

  it('русский бейдж — дословно утверждённый владельцем текст', () => {
    const ru = read('ru');
    expect(pick(ru, 'chat.privacy_badge_title')).toBe('Только вы двое');
    expect(pick(ru, 'chat.privacy_badge_storage'))
      .toBe('Переписка зашифрована. Сервер хранит её в нечитаемом виде и не имеет ключей.');
    expect(pick(ru, 'chat.privacy_badge_dispute'))
      .toBe('При споре предъявить переписку арбитру может каждая из сторон — со своего устройства.');
  });

  it('код восстановления: все четырнадцать ключей есть в каждой локали и не пусты', () => {
    const missing: string[] = [];
    for (const locale of LOCALES) {
      const dict = read(locale);
      for (const key of REQUIRED_RECOVERY) {
        const value = pick(dict, key);
        if (typeof value !== 'string' || value.trim().length === 0) missing.push(`${locale}:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('номер слова подставляется, а не вписан цифрой', () => {
    // `{n}` обязан доехать до каждой локали: без него человек получит
    // «Слово» без номера и не поймёт, какое слово вписывать. Общий гейт
    // (`i18n/messages.test.ts`) сверяет набор аргументов с английским — здесь
    // сказано ЧИСЛОМ, какой именно аргумент нужен.
    const bad: string[] = [];
    for (const locale of LOCALES) {
      const dict = read(locale);
      for (const key of [
        'chat.recovery_check_word', 'chat.recovery_check_failed',
        'chat.restore_err_unknown_word',
      ]) {
        if (!String(pick(dict, key)).includes('{n}')) bad.push(`${locale}:${key}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('⚠️ нигде не сказано «сохраните» — только «запишите»', () => {
    // Правило владельца, и причина у него неочевидная: «сохраните» люди
    // читают как «сфотографируйте». Снимок уезжает в галерею, галерея — в
    // облако, и код оказывается ровно там, где мы просили его не держать.
    // Обнаружить это мы не можем никак — единственное, что в наших силах,
    // это не подсказывать такой способ словом.
    // ⚠️ ЗАПРЕЩЕН ГЛАГОЛ, А НЕ КОРЕНЬ. Немецкий поймал это замером: `/speicher/`
    // краснел на `Gerätespeicher` — «хранилище устройства», существительное в
    // надписи про отказ диска. Запрет корня сделал бы гейт про слово вообще, а
    // он про ПРОСЬБУ: «сохраните» человек читает как «сфотографируйте».
    // Поэтому `\bspeichern\b` (глагол) ловится, `Gerätespeicher` — нет.
    const BANNED: Record<string, RegExp> = {
      ru: /сохран/i,
      uk: /збереж|зберіг/i,
      en: /\bsav(e|ed|ing)\b|\bstore\b/i,
      de: /\bspeicher(n|e|t|st)\b|abspeichern/i,
      fr: /sauvegard|enregistr/i,
      es: /guard/i,
      pt: /guard|salv/i,
      it: /salva/i,
    };
    const bad: string[] = [];
    for (const locale of LOCALES) {
      const banned = BANNED[locale];
      if (!banned) continue; // письменности без прямого аналога — гейт не врёт
      const chat = pick(read(locale), 'chat') as Record<string, string>;
      for (const [key, value] of Object.entries(chat)) {
        // И показ кода (`recovery_`), И ввод кода (`restore_`): правило про
        // слово одно на обе половины, иначе оно живёт только там, где его
        // завели, а нарушается там, где о нём забыли.
        const covered = key.startsWith('recovery_') || key.startsWith('restore_');
        if (covered && banned.test(value)) bad.push(`${locale}:${key}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('русское предупреждение — дословно утверждённый владельцем текст', () => {
    const ru = read('ru');
    expect(pick(ru, 'chat.recovery_warning_title')).toBe('Код восстановления');
    expect(pick(ru, 'chat.recovery_warning_access')).toBe(
      'Это доступ ко всей вашей переписке. Кто получит эти 12 слов — прочитает всё. Отозвать или сменить их нельзя.',
    );
    expect(pick(ru, 'chat.recovery_warning_loss')).toBe('Потеряете — переписка не вернётся.');
    expect(pick(ru, 'chat.recovery_warning_keep')).toBe('Запишите и держите в секрете.');
  });

  it('ключи про XMTP и журнал бота удалены во всех локалях', () => {
    const alive: string[] = [];
    for (const locale of LOCALES) {
      const dict = read(locale);
      if (pick(dict, 'xmtp_error') !== undefined) alive.push(`${locale}:xmtp_error`);
      for (const key of REMOVED) {
        if (pick(dict, key) !== undefined) alive.push(`${locale}:${key}`);
      }
    }
    expect(alive).toEqual([]);
  });

  it('обещание «платформа читает переписку» убрано из оставшихся текстов', () => {
    // Прямая ложь после пересадки: сервер ключей не имеет. Ловится по двум
    // текстам, которые её несли (ru), — остальные локали закрыты тем, что
    // ключи `dispute_log_*` удалены целиком (проверка выше).
    const ru = read('ru');
    expect(String(pick(ru, 'chat.e2e_notice'))).not.toContain('спор');
    expect(String(pick(ru, 'chat.encrypted'))).not.toContain('спор');
  });

  it('zh.json — сирота: в списке локалей его нет, и он не тронут', () => {
    expect(LOCALES).not.toContain('zh');
    const zh = read('zh');
    // Ровно то, что там было до пересадки: старые ключи на месте, новых нет.
    expect(pick(zh, 'chat.open_xmtp')).toBeTypeOf('string');
    expect(pick(zh, 'chat.privacy_badge_title')).toBeUndefined();
  });
});

/* ─── Правда после сноса XMTP: справка и разрозненные бейджи (аудит текстов,
 * 2026-08-07). Найдено врождебным аудитом: справка (`faq.q_chat`/`a_chat`,
 * `faq.q_files`/`a_files`) описывала снесённый мессенджер и утверждала
 * обратное новому бейджу шапки чата — что платформа состоит в переписке и
 * читает её. Заодно всплыли два соседних бага: тултип/подпись про вложение
 * (`chat.attach_file_title`, `chat.e2e_notice`) обещали ровно "7 дней" без
 * учёта того, что мешок, усыновлённый сделкой, живёт дольше (до 90 дней —
 * `relayer/bagStore.js`, BAG_MAX_AGE_MS); а баннер обрыва связи
 * (`chat.stream_dead`) и кнопка рядом (`chat.reconnect`) были переведены
 * только на два языка из четырнадцати — двенадцать локалей показывали
 * английский текст человеку, переставшему получать сообщения. */
describe('справка и бейджи не врут после сноса XMTP (аудит текстов)', () => {
  /** Ключи `chat.*`, добавленные/тронутые вместе с бейджем "Только вы двое":
   *  полнота по всему пространству имён, а не только по точечному списку —
   *  REQUIRED выше ловит регресс конкретных ключей, это ловит вообще любой
   *  пустой или пропавший `chat.*`. */
  it('каждый ключ chat.* есть во всех 14 локалях и не пуст (кроме zh — сироты)', () => {
    const enChat = pick(read('en'), 'chat') as Record<string, unknown>;
    const chatKeys = Object.keys(enChat);
    expect(chatKeys.length).toBeGreaterThan(50); // защита от пустого namespace по ошибке чтения

    const missing: string[] = [];
    for (const locale of LOCALES) {
      const dict = read(locale);
      for (const key of chatKeys) {
        const value = pick(dict, `chat.${key}`);
        if (typeof value !== 'string' || value.trim().length === 0) missing.push(`${locale}:chat.${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('нигде в chat/messaging/faq не осталось слова XMTP — снесённого мессенджера больше нет', () => {
    const found: string[] = [];
    for (const locale of LOCALES) {
      const dict = read(locale);
      for (const ns of ['chat', 'messaging', 'faq']) {
        const node = pick(dict, ns) as Record<string, unknown> | undefined;
        if (!node) continue;
        for (const [key, value] of Object.entries(node)) {
          if (typeof value === 'string' && /xmtp/i.test(value)) found.push(`${locale}:${ns}.${key}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  /** Старые (XMTP-эры) значения — то, что было ДО правки. Тест запирает
   *  именно регресс к НИМ, а не подгоняется под то, что написано сейчас: если
   *  кто-то откатит правку буква в букву, тест покраснеет. */
  const OLD_ENABLED_DESC: Record<string, string> = {
    ar: 'تشفير كامل عبر XMTP · يمكن للآخرين مراسلتك',
    de: 'Ende-zu-Ende verschlüsselt via XMTP · Andere können dir Nachrichten senden',
    en: 'End-to-end encrypted via XMTP · Others can message you',
    es: 'Cifrado de extremo a extremo vía XMTP · Otros pueden enviarte mensajes',
    fr: 'Chiffrement de bout en bout via XMTP · Les autres peuvent vous envoyer des messages',
    hi: 'XMTP के माध्यम से एंड-टू-एंड एन्क्रिप्टेड · अन्य आपको संदेश कर सकते हैं',
    it: 'Crittografia end-to-end tramite XMTP · Gli altri possono scriverti',
    ja: 'XMTPによるエンドツーエンド暗号化 · 他のユーザーからメッセージを受信できます',
    ko: 'XMTP를 통한 엔드투엔드 암호화 · 다른 사용자가 메시지를 보낼 수 있습니다',
    pt: 'Criptografia de ponta a ponta via XMTP · Outros podem te enviar mensagens',
    ru: 'Сквозное шифрование через XMTP · Другие пользователи могут писать вам',
    th: 'เข้ารหัสแบบ end-to-end ผ่าน XMTP · ผู้อื่นสามารถส่งข้อความถึงคุณได้',
    uk: 'Наскрізне шифрування через XMTP · Інші можуть вам писати',
    'zh-CN': '通过 XMTP 端对端加密 · 他人可以向您发送消息',
  };

  it('messaging.enabled_desc больше не зовёт снесённый мессенджер по имени', () => {
    const regressed: string[] = [];
    for (const locale of LOCALES) {
      const value = pick(read(locale), 'messaging.enabled_desc');
      if (value === OLD_ENABLED_DESC[locale]) regressed.push(locale);
    }
    expect(regressed).toEqual([]);
  });

  /** `attach_file_title` / `e2e_notice`: строка обязана упоминать что-то,
   *  кроме голых "7 дней" — то есть продление, пока сделка открыта. Ловится
   *  не regexp'ом по числу (число уже подставляется параметром `{mb}` в
   *  attach_file_title, и "7" законно присутствует само по себе), а прямым
   *  сравнением со СТАРЫМ, урезанным текстом, которого больше быть не должно.
   */
  const OLD_E2E_NOTICE: Record<string, string> = {
    ar: 'مشفَّر · يُحفظ 7 أيام · المفتاح لديكما وحدكما',
    de: 'Verschlüsselt · 7 Tage gespeichert · nur ihr zwei habt den Schlüssel',
    en: 'Encrypted · kept 7 days · only the two of you hold the key',
    es: 'Cifrado · guardado 7 días · solo vosotros dos tenéis la clave',
    fr: 'Chiffré · conservé 7 jours · vous seuls avez la clé',
    hi: 'एन्क्रिप्टेड · 7 दिन तक रखा · कुंजी सिर्फ़ आप दोनों के पास',
    it: 'Cifrato · conservato 7 giorni · solo voi due avete la chiave',
    ja: '暗号化 · 7日間保存 · 鍵はお二人だけ',
    ko: '암호화 · 7일 보관 · 키는 두 사람만 보유',
    pt: 'Cifrado · guardado 7 dias · só vocês dois têm a chave',
    ru: 'Зашифровано · хранится 7 дней · ключ только у вас двоих',
    th: 'เข้ารหัส · เก็บ 7 วัน · กุญแจอยู่กับคุณสองคนเท่านั้น',
    uk: 'Зашифровано · зберігається 7 днів · ключ лише у вас двох',
    'zh-CN': '已加密 · 保存 7 天 · 密钥只在你们两人手中',
  };

  it('chat.e2e_notice говорит не только "7 дней", но и про продление, пока открыта сделка', () => {
    const regressed: string[] = [];
    for (const locale of LOCALES) {
      const value = pick(read(locale), 'chat.e2e_notice');
      if (value === OLD_E2E_NOTICE[locale]) regressed.push(locale);
    }
    expect(regressed).toEqual([]);
  });

  it('faq.a_chat и faq.a_files не утверждают, что платформа состоит в переписке и читает её', () => {
    // "we open them" / "мы открываем их" / их аналоги в старом тексте — прямая
    // ложь после пересадки на сквозное шифрование. Форма проверки та же, что
    // выше: сравнение со старым текстом, а не поиск слова — ключевая фраза
    // формулируется по-разному в каждом языке, а старый текст известен точно.
    const OLD_A_CHAT_HAS_PLATFORM_READS: Record<string, string> = {
      en: 'the platform can read them',
      ru: 'платформа имеет к ним доступ',
    };
    for (const [locale, phrase] of Object.entries(OLD_A_CHAT_HAS_PLATFORM_READS)) {
      const value = String(pick(read(locale), 'faq.a_chat'));
      expect(value, `${locale}: faq.a_chat`).not.toContain(phrase);
    }
  });

  /** Баннер обрыва связи и переведён, и не совпадает с английским нигде,
   *  кроме самого английского и русского (тот уже был переведён до этой
   *  правки). До правки 12 локалей из 14 показывали дословно английский
   *  текст — ровно то, что здесь заперто. */
  it('chat.stream_dead и chat.reconnect переведены во всех 14 локалях, не только в en/ru', () => {
    const enStreamDead = pick(read('en'), 'chat.stream_dead');
    const enReconnect = pick(read('en'), 'chat.reconnect');
    const untranslated: string[] = [];
    for (const locale of LOCALES) {
      if (locale === 'en') continue;
      const dict = read(locale);
      if (pick(dict, 'chat.stream_dead') === enStreamDead) untranslated.push(`${locale}:stream_dead`);
      if (pick(dict, 'chat.reconnect') === enReconnect) untranslated.push(`${locale}:reconnect`);
    }
    expect(untranslated).toEqual([]);
  });
});

// ── Адрес контракта не живёт в переводах ────────────────────────────────────
//
// Найдено 7 августа 2026 при аудите текстов. `faq.a_verify` во всех 14 локалях
// предлагал «проверить контракты» и называл адрес `0xF00CC718…`, вписанный
// руками. Замер на цепи: у этого адреса 10 фасетов и он до сих пор отдаёт
// СТАРЫЕ заказы — то есть выглядит настоящим; у живого диамонда 11 фасетов и
// рабочая доска. Человек, пришедший проверить контракты перед сделкой, смотрел
// бы на брошенное развёртывание.
//
// Причина не в опечатке, а в месте: адрес, вписанный в перевод, обновляется
// вручную четырнадцать раз и потому не обновляется никогда. Теперь он
// подставляется из `CONTRACTS.diamond` — из того же места, что и весь код.
//
// Этот замок стоит на самой возможности вернуться к прежнему: любой
// шестнадцатеричный адрес, вписанный в справку руками, красит тест.
describe('адрес контракта не вписан в переводы руками', () => {
  const HEX_ADDRESS = /0x[a-fA-F0-9]{40}/;

  it.each(LOCALES)('%s: faq.a_verify подставляет адрес, а не называет его', (locale) => {
    const dict = JSON.parse(
      fs.readFileSync(path.join(MESSAGES_DIR, `${locale}.json`), 'utf8')
    );
    const text = dict?.faq?.a_verify;
    expect(typeof text, `${locale}: нет ключа faq.a_verify`).toBe('string');
    expect(text, `${locale}: адрес вписан руками — он устареет и уведёт человека не туда`)
      .not.toMatch(HEX_ADDRESS);
    expect(text, `${locale}: нет подстановки {address}`).toContain('{address}');
  });

  // ⚠️ ХОДИМ ПО КАТАЛОГУ, А НЕ ПО СПИСКУ `LOCALES`. Список — это то, что грузит
  // приложение; в каталоге переводов лежит БОЛЬШЕ файлов. Замер 12 августа
  // 2026: `zh.json` — сирота, в приложение не подключён, а мёртвый адрес
  // `0xF00CC718…` пролежал в нём ещё пять дней после того, как его убрали из
  // четырнадцати подключённых, — потому что оба замка выше ходили по списку.
  // Публикуется каталог целиком, значит и сторожить надо каталог.
  it('ни один текст справки не называет адрес руками — во всех файлах каталога', () => {
    const guilty: string[] = [];
    const files = fs.readdirSync(MESSAGES_DIR).filter((f) => f.endsWith('.json'));
    expect(files.length, 'файлы переводов не найдены — замок остался бы зелёным ни на чём')
      .toBeGreaterThanOrEqual(LOCALES.length);
    for (const file of files) {
      const dict = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, file), 'utf8'));
      for (const [key, value] of Object.entries(dict?.faq ?? {})) {
        if (typeof value === 'string' && HEX_ADDRESS.test(value)) {
          guilty.push(`${file}:faq.${key}`);
        }
      }
    }
    expect(guilty).toEqual([]);
  });
});

/* ─── Предъявление арбитру (4в-2, Задача 6) ─────────────────────────────── */
describe('тексты предъявления арбитру', () => {
  it('L1: все 47 ключей есть в каждой из 14 локалей и ни один не пуст', () => {
    // Число написано РУКАМИ: список выше может усохнуть незамеченным.
    // 25 ключей показа + 22 ключа отказа (по числу членов `PresentRefusal`).
    expect(REQUIRED_PRESENT.length).toBe(47);
    const missing: string[] = [];
    for (const locale of LOCALES) {
      const dict = read(locale);
      for (const key of REQUIRED_PRESENT) {
        const value = pick(dict, key);
        if (typeof value !== 'string' || value.trim().length === 0) missing.push(`${locale}:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('L2: у каждой из 22 причин отказа есть свой ключ, и он в локалях', async () => {
    // ⚠️ Список причин пишется ЗДЕСЬ РУКАМИ и сверяется с картой модуля.
    // ВОСЕМЬ имён сборщика — от Задачи 4, включая три беды заверения с
    // РАЗНЫМ лечением. Добавит она девятое — карта не соберётся в
    // type-check, а этот замер назовёт расхождение числом. Ожидаемое не
    // берётся из проверяемого.
    const REASONS = [
      'arbiter_has_no_key', 'peer_has_no_key', 'nothing_selected', 'too_large', 'no_session',
      'attestation_missing', 'attestation_expired', 'attestation_unproven',
      'not_disputed', 'arbiter_changed', 'key_changed', 'arbiter_left',
      'no_consent', 'already_sending',
      'chain_unavailable', 'not_a_party', 'no_such_deal', 'rate_limited',
      'box_refused', 'offline', 'pass_refused', 'internal_error',
    ];
    expect(REASONS.length).toBe(22);
    const { PRESENT_REFUSAL_KEYS } = await import('./presentToArbiter');
    expect(Object.keys(PRESENT_REFUSAL_KEYS).sort()).toEqual([...REASONS].sort());
    const en = read('en');
    for (const reason of REASONS) {
      const key = (PRESENT_REFUSAL_KEYS as Record<string, string>)[reason];
      expect(REQUIRED_PRESENT, `ключ ${key} не в списке обязательных`).toContain(key);
      expect(typeof pick(en, key)).toBe('string');
    }
  });

  it('L3: ⚠️ нигде не сказано «прочитал» — только «забрали»', () => {
    // §4 замысла: «Слова „прочитал“ и „понял“ нет и не будет. „Забрал“ — про
    // байты, а не про глаза». Написать «арбитр прочитал» значило бы дать
    // стороне расслабиться там, где нельзя.
    //
    // ⚠️ ЧЕГО ЭТОТ ЗАПРЕТ НЕ КАСАЕТСЯ, и это надо сказать вслух, иначе
    // следующий читатель сочтёт замок дырявым: запрещено ПРИПИСЫВАТЬ
    // АРБИТРУ чтение и понимание. Согласие стороны («Я понимаю: это уйдёт
    // арбитру») сюда не относится — там человек говорит про себя, а не мы
    // про арбитра. Поэтому корень «поним…» в чёрный список не входит, хотя
    // §4 называет и его.
    //
    // ⚠️ ЭТО ЗАМОК НА СЛОВО, и он честно ограничен: языки без однословного
    // аналога, который ловится без ложных срабатываний, не проверяются вовсе —
    // та же дисциплина, что у запрета «сохраните» выше (немецкий поймал
    // `Gerätespeicher` и заставил гейтить ГЛАГОЛ, а не корень).
    const BANNED: Record<string, RegExp> = {
      ru: /прочит|прочёл|прочел|прочтёт/i,
      uk: /прочит|прочов|прочитає/i,
      en: /\bread\b|\bhas read\b/i,
      de: /\bgelesen\b|\bliest\b/i,
    };
    const bad: string[] = [];
    for (const locale of LOCALES) {
      const banned = BANNED[locale];
      if (!banned) continue;
      const chat = pick(read(locale), 'chat') as Record<string, string>;
      for (const [key, value] of Object.entries(chat)) {
        if (key.startsWith('present_') && banned.test(value)) bad.push(`${locale}:${key}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('L4: обе строки про файлы — ПРАВДА ПРО СЕГОДНЯ, и они не спорят друг с другом', () => {
    const ru = read('ru');
    // ⚠️ РЕШЕНИЕ ВЛАДЕЛЬЦА ОТ 11 АВГУСТА. В Выкатке 1 арбитру уходит только
    // имя, размер и тип файла — сам файл не уходит вовсе и показать его
    // арбитру нельзя даже стороне. Формулировка §2.10 замысла («арбитр
    // увидит файл, но копию штатно не получит») приезжает ВМЕСТЕ С
    // ВЫКАТКОЙ 3, когда станет правдой; поставить её сейчас значило бы
    // обещать передачу того, что не передаётся, и разойтись с экраном
    // арбитра из этой же выкатки («только фактом, сам файл не показывается»).
    expect(pick(ru, 'chat.present_warn_files')).toBe(
      'Сам файл арбитру не уйдёт: уедут имя, размер и тип; '
      + 'показать ему файл нельзя даже вам.',
    );
    expect(pick(ru, 'chat.present_warn_final')).toBe('Отменить нельзя: отправленное уже у арбитра.');

    // ⚠️ И СОСЕДНЯЯ СТРОКА ТОГО ЖЕ ОКНА НЕ ОБЕЩАЕТ САМОГО ФАЙЛА. Решение
    // владельца было внесено в `present_warn_files` и НЕ внесено сюда:
    // «уйдёт… текст целиком и НАЗВАННЫЕ В НЁМ ФАЙЛЫ» — это обещание передать
    // файл, прямо против строки выше. Человек читал бы два
    // взаимоисключающих обещания подряд и решал бы сам, какому верить.
    const everything = String(pick(ru, 'chat.present_warn_everything'));
    expect(everything).toBe(
      'Уйдёт всё, что внутри отмеченных сообщений: текст целиком и названия '
      + 'упомянутых файлов — включая сведения о третьих лицах, к спору не причастных.',
    );
    // Третьи лица — несущее, и потерять их молча нельзя.
    expect(everything).toContain('третьих лицах');
    // ⚠️ И отдельно — запрет прежней формулировки: дословная сверка выше
    // покраснеет на ЛЮБОЙ правке строки, а эта — только на возврате
    // обещания самого файла, то есть скажет, ЧТО именно сломалось.
    expect(everything, 'предупреждение снова обещает сам файл')
      .not.toMatch(/названные в нём файлы|сами файлы|файлы целиком/i);

    // «Забрали» — про байты и без имени: опись имени забравшего не хранит.
    expect(String(pick(ru, 'chat.present_fetched'))).toContain('{time}');
    // Два текста про черновик — разные: «не отправляли» и «уже предъявляли».
    expect(pick(ru, 'chat.present_draft_sent')).not.toBe(pick(ru, 'chat.present_draft_found'));
  });
});
