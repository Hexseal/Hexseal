/**
 * §5 замысла: что именно видит арбитр вместо вложения.
 *
 * Вид арбитра строится РАЗРЕШИТЕЛЬНЫМ списком — перечислением полей, которые
 * ему положены, а не вычёркиванием запрещённых. Разница несущая: запретительный
 * список надо не забыть дополнить, когда в `ChatPayload` появится новое поле, а
 * разрешительный новое поле не пропустит сам по себе.
 */
import { describe, it, expect } from 'vitest';
import { redactPayload, type ChatPayload } from './chatPayloadForm';

const DEAL = '0x1234567890123456789012345678901234567890' as `0x${string}`;
/** 184 байта = 368 hex-цифр, записано РУКАМИ (договор v2, исправление 12).
 *  `redactPayload` формы не проверяет — здесь важно лишь, что это похоже на
 *  настоящий замок и что в выдачу оно не попадает. */
const SEALED = 'ab'.repeat(184);

describe('вид арбитра: видит, что вложение было, и не может его взять', () => {
  it('новая форма: ни ключа, ни адреса, ни замка — только имя, размер, тип', () => {
    const payload: ChatPayload = {
      text: 'акт приёмки',
      dealId: DEAL,
      file: {
        url: 'https://relayer.example/files/abc', name: 'акт.pdf', size: 12_345,
        sealedKey: SEALED, fileKey: 'files/abc', mime: 'application/pdf',
        chunked: true, chunkCount: 2, chunkSize: 8 * 1024 * 1024,
      },
    };
    const { payload: seen, legacyAttachmentExposed } = redactPayload(payload);

    expect(seen).toEqual({
      text: 'акт приёмки',
      dealId: DEAL,
      file: { name: 'акт.pdf', size: 12_345, mime: 'application/pdf', chunked: true },
    });
    // Поимённо, а не «форма похожа»: `toEqual` уже покраснел бы, но названные
    // отсутствия читаются как требование, а не как случайность набора.
    expect('url' in seen.file!).toBe(false);
    expect('fileKey' in seen.file!).toBe(false);
    expect('sealedKey' in seen.file!).toBe(false);
    expect('keyHex' in seen.file!).toBe(false);
    expect('ivHex' in seen.file!).toBe(false);
    expect(legacyAttachmentExposed).toBe(false);
  });

  it('старая форма: тот же вид, но признак legacyAttachmentExposed поднят', () => {
    // ⚠️ ЧЕСТНОСТЬ §5. У сообщений ДО правки формы ключ открыт. Признак —
    // единственное, чем экран может не соврать: без него копирайт обещал бы
    // «арбитр не откроет вложения» и там, где откроет.
    const { payload: seen, legacyAttachmentExposed } = redactPayload({
      file: { url: 'https://x', name: 'старое.txt', size: 10, keyHex: 'ee'.repeat(32), ivHex: 'ff'.repeat(12) },
    });
    expect(legacyAttachmentExposed).toBe(true);
    expect(seen.file).toEqual({ name: 'старое.txt', size: 10 });
    expect('keyHex' in seen.file!).toBe(false);   // в ВИДЕ его всё равно нет
  });

  it('оба ключа сразу (легаси плюс замок) — признак поднят: открытый ключ существует', () => {
    const { legacyAttachmentExposed } = redactPayload({
      file: { url: 'https://x', name: 'f', size: 1, keyHex: 'ee'.repeat(32), ivHex: 'ff'.repeat(12), sealedKey: SEALED },
    });
    expect(legacyAttachmentExposed).toBe(true);
  });

  it('текст без вложения: признак опущен, поля file нет ВОВСЕ (а не пустое)', () => {
    const { payload: seen, legacyAttachmentExposed } = redactPayload({ text: 'просто слова' });
    expect(seen).toEqual({ text: 'просто слова' });
    expect('file' in seen).toBe(false);
    expect(legacyAttachmentExposed).toBe(false);
  });

  it('незнакомые поля НЕ переезжают — список разрешительный, не запретительный', () => {
    // Гейт формы намеренно СОХРАНЯЕТ незнакомые поля (чтобы будущая версия
    // формата не съедалась старой сборкой). Значит в payload может лежать
    // что угодно, включая чей-то ключ под именем, которого мы не знаем.
    const p = {
      text: 'a',
      secretKey: 'ff'.repeat(32),
      file: { url: 'https://x', name: 'f', size: 1, sealedKey: SEALED, backupKeyHex: 'ee'.repeat(32) },
    } as unknown as ChatPayload;
    const { payload: seen } = redactPayload(p);
    expect(seen).toEqual({ text: 'a', file: { name: 'f', size: 1 } });
    expect(JSON.stringify(seen)).not.toContain('ee');
    expect(JSON.stringify(seen)).not.toContain('ff');
  });

  // ⚠️ ЗДЕСЬ БЫЛ ТЕСТ С `@ts-expect-error`— И ОН БЫЛ ЗАМКОМ-ПУСТЫШКОЙ. Снят.
  //
  // ЗАМЕРЕНО: `frontend/tsconfig.json` содержит
  // `"exclude": ["node_modules", "**/*.test.ts", "**/*.test.tsx"]` — то есть
  // `npm run type-check` этот файл В ПРОГРАММУ НЕ БЕРЁТ ВООБЩЕ (исключение
  // намеренное, у него в tsconfig свой комментарий: тесты берут vitest из
  // ../relayer/node_modules, которого нет в Docker-контексте фронта). Значит
  // `@ts-expect-error`, поставленный ЗДЕСЬ, не проверяется ничем: прогон типов
  // не смотрит, а vitest типы не считает. Мутация «добавить `keyHex?: string` в
  // RedactedFilePayload» дала бы **0 красных и на `npm test`, и на
  // `npm run type-check`** — ровно тот класс дефекта, ради которого замок
  // заводился («код есть, никто им не пользуется»).
  //
  // Настоящий тип-замок переехал ТУДА, КУДА ПРОВЕРКА ТИПОВ СМОТРИТ — в сам
  // `chatPayloadForm.ts` (Шаг 3, `ArbiterViewLacksKeyFields`). Мутация M9
  // замеряет его там, настоящим tsc.
  //
  // Поведенческая половина того же требования никуда не делась: отсутствие
  // `keyHex`/`ivHex`/`url`/`fileKey`/`sealedKey` в выдаче заперто поимённо в
  // первом тесте этого файла.
});
