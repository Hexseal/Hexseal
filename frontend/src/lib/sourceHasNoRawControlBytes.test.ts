import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * Замок против сырых управляющих байтов в исходниках.
 *
 * ЧТО ИМЕННО ОН СТОРОЖИТ — не красоту текста, а ВОЗМОЖНОСТЬ ЗАМЕРА. Файл с
 * байтом NUL инструменты считают двоичным и молча пропускают. Замерено
 * 11 августа 2026 на `frontend/src/lib/chatPayloadForm.ts`: класс опасных
 * символов имени вложения был записан СЫРЫМИ управляющими байтами, и
 *
 *   grep -rl UNSAFE_NAME_CHARS frontend/src/lib   →   ПУСТО
 *   grep -rl RedactedFilePayload frontend/src/lib →   файла-объявителя НЕТ в списке
 *
 * то есть проверка «единственный источник» не видела файл, где источник и
 * объявлен, а отвечала «не найдено» — неотличимо от честного отсутствия.
 * Молчали все формы: -c, -l, -n, -rl. Ровно этим способом любая проверка
 * грепом по такому файлу зелёная навсегда, что бы в нём ни лежало.
 *
 * Что исчезнет из поведения, если снять этот замок: сама возможность снова
 * получить исходник, невидимый для грепа, без единого красного. Поведение
 * самого санитайзера сторожит НЕ этот файл, а `chatFileName.test.ts` — там
 * каждый враждебный символ проверяется поштучно; при переводе класса из сырых
 * байтов в экранированный вид те девять проверок остались зелёными, чем и
 * доказано, что смысл не поехал.
 *
 * Двоичные вложения (иконки, PNG) в объём не входят по расширению: они и
 * должны быть двоичными.
 */

/** Разрешённые управляющие: табуляция, перевод строки, возврат каретки. */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

/** Байт вне печатного диапазона ASCII и не разрешённый явно. */
function isRawControlByte(byte: number): boolean {
  if (ALLOWED.has(byte)) return false;
  return byte < 0x20 || byte === 0x7f;
}

interface Hit {
  file: string;
  line: number;
  byte: number;
}

/**
 * Ищет сырые управляющие байты. Работает по БАЙТАМ, а не по символам: C1
 * (0x80…0x9F) в UTF-8 представлены двухбайтовой парой и печатному тексту не
 * мешают, а вот C0 и DEL мешают ровно как байты — именно они и делают файл
 * двоичным в глазах инструментов.
 */
function findRawControlBytes(buf: Buffer, file: string): Hit[] {
  const hits: Hit[] = [];
  let line = 1;
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i];
    if (byte === 0x0a) {
      line += 1;
      continue;
    }
    if (isRawControlByte(byte)) hits.push({ file, line, byte });
  }
  return hits;
}

/**
 * Корень репозитория. Именно `fileURLToPath`, а НЕ `url.pathname`: путь этого
 * проекта содержит пробел («dev project»), и `pathname` отдаёт его в виде `%20`.
 * Замерено при заводе замка: обходчик по такому пути набрал НОЛЬ файлов, и
 * проверка «сырых байтов нет» прошла бы зелёной по пустому списку. Покраснел
 * тогда только порог непустоты — он для этого и стоит.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sol', '.sh', '.css', '.json'];

const SCANNED_DIRS = ['frontend/src', 'src', 'script', 'test', 'relayer'];

/**
 * Пропуск по ИМЕНИ каталога — и только для имён, которых внутри исходников быть
 * не может. Замерено при заводе замка: сюда сперва попало имя `lib` (ради
 * зависимостей Foundry в корне репозитория), и оно вырезало `frontend/src/lib`
 * целиком — весь каталог, из-за которого замок и заводился. Мутация «вернуть
 * один сырой NUL» дала тогда 0 красных из 2051. Каталоги вроде `lib`, `out`,
 * `cache` в перечень обхода (SCANNED_DIRS) не входят вовсе, поэтому по имени их
 * отсекать НЕЛЬЗЯ: имя может повториться внутри исходников.
 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'broadcast', 'storage']);

function collect(dir: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = `${dir}/${name}`;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collect(full, acc);
    } else if (SCANNED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      acc.push(full);
    }
  }
}

const FILES: string[] = [];
for (const rel of SCANNED_DIRS) collect(`${ROOT}${rel}`, FILES);

/**
 * Порог непустоты. Без него сломанный обходчик каталогов даёт «ноль файлов —
 * ноль находок — зелено» — тот самый мёртвый замок, ради которого этот файл и
 * заведён. Число заведомо ниже настоящего (на 11 августа 2026 — свыше 400),
 * чтобы не краснеть от обычного роста и удаления файлов.
 */
const MIN_FILES_SCANNED = 250;

describe('в исходниках нет сырых управляющих байтов', () => {
  it('обходчик действительно набрал корпус, а не пустоту', () => {
    expect(FILES.length).toBeGreaterThan(MIN_FILES_SCANNED);
  });

  it('искатель находит сырой байт, когда он есть (проверка самого прибора)', () => {
    const poisoned = Buffer.concat([
      Buffer.from('первая строка\n', 'utf8'),
      Buffer.from('вторая ', 'utf8'),
      Buffer.from([0x00]),
      Buffer.from(' строка\n', 'utf8'),
    ]);
    const hits = findRawControlBytes(poisoned, 'синтетика');
    expect(hits).toEqual([{ file: 'синтетика', line: 2, byte: 0x00 }]);
  });

  it('искатель не считает находкой табуляцию, перевод строки и возврат каретки', () => {
    const benign = Buffer.from('a\tb\r\nc\n', 'utf8');
    expect(findRawControlBytes(benign, 'синтетика')).toEqual([]);
  });

  it('ни один исходник не содержит сырых управляющих байтов', () => {
    const hits: Hit[] = [];
    for (const file of FILES) {
      hits.push(...findRawControlBytes(readFileSync(file), file.slice(ROOT.length)));
    }
    const report = hits
      .slice(0, 20)
      .map((h) => `${h.file}:${h.line} — байт 0x${h.byte.toString(16).padStart(2, '0')}`)
      .join('\n');
    expect(hits, `сырые управляющие байты делают файл двоичным для грепа:\n${report}`).toEqual([]);
  });
});
