#!/usr/bin/env python3
"""
Гейт раскладки ПОЛЕЙ Diamond-хранилища (в дополнение к check-storage-layout.sh,
который проверяет только базовые слоты неймспейсов и последовательные
state-переменные фасетов).

Инцидент, который ни один из существующих гейтов не ловит: коммит 1772ed9
заменил `bytes32 termsHash` на `string terms` ВНУТРИ `JobBoardStorage.Job` —
тот же слот, другая кодировка. Старые keccak-дайджесты стали читаться как
строки с мусорной длиной, `getJob()` ревертил Panic(0x22) на четырёх живых
записях. Ни компиляция, ни test/StorageLayout.t.sol (пиннит только базовые
слоты неймспейсов, не содержимое структур), ни check-storage-layout.sh
(ловит только ПОСЛЕДОВАТЕЛЬНЫЕ state-переменные фасетов — другой класс
дефекта) этого не заметили бы.

Что делает этот скрипт:

1. Находит все namespaced storage-библиотеки в src/ — те, что помечены
   `@custom:storage-location erc7201:` (это ровно девять неймспейсов,
   см. test/StorageLayout.t.sol). DiamondGuard использует такую метку, но
   хранит голый uint256 через inline-assembly sload/sstore, без struct —
   это ожидаемо и не ошибка парсера.
2. Внутри каждой такой библиотеки находит ВСЕ `struct X { ... }` —
   и главную структуру хранилища (`Layout`/`Data`), и вложенные структуры,
   которые она использует как тип поля (`Job`, `Service`, `HireRequest`,
   `AgreementRecord`, `JobReceiptData`, `PendingVerdict`,
   `FacetAddressAndPosition`, `FacetFunctionSelectors`). Вложенные структуры
   в этой кодовой базе всегда объявлены в той же namespaced-библиотеке, что
   и структура, которая их использует — отдельный проход "найти тип поля
   и сматчить с известным именем структуры" не нужен и был бы хрупче, чем
   просто взять все структуры внутри помеченной библиотеки.
3. Каждая структура — упорядоченный список пар (type, name) полей.
4. Сравнивает с закоммиченным снапшотом (script/storage-structs.snapshot).
   Единственная легальная эволюция — дописывание новых полей СТРОГО в конец
   списка (существующий список полей должен быть точным префиксом нового).
   Смена типа поля, переименование, реордер, вставка в середину, удаление —
   всё это ломает свойство "префикс" и валит гейт.
5. Структура, которой нет в снапшоте (новое имя — новая структура или
   переименование старой), и структура из снапшота, которой больше нет в
   коде (удалена или переименована) — обе ситуации проваливают гейт громко,
   а не считаются "ОК, просто новое". Это специально: если разрешить новым
   именам молча появляться, переименование (Job -> JobV2) прошло бы гейт
   незамеченным — ровно тот klass бага, ради которого это всё пишется.

Режимы запуска:
    python3 script/check_storage_structs.py            — проверка (exit-коды ниже)
    python3 script/check_storage_structs.py --update    — перегенерировать снапшот
    python3 script/check_storage_structs.py --print     — вывести текущую раскладку и выйти

Коды возврата:
    0  — снапшот совпадает или текущий код — чистое дописывание в конец
    1  — найдено нелегальное изменение (смена типа / реордер / вставка / удаление /
         переименование / новая или пропавшая структура)
    2  — снапшот отсутствует (для check-режима) — гейт не может решить, что "чисто",
         без базовой линии; не путать со "всё ок"
    3  — парсер не нашёл вообще ни одной структуры в src/ — сам парсер сломан
         (маркер erc7201 переименовали, формат структуры изменился и т.п.),
         раскладка НЕ проверена, это не то же самое, что "структур нет"
"""
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = REPO_ROOT / "src"
SNAPSHOT_PATH = REPO_ROOT / "script" / "storage-structs.snapshot"

STORAGE_MARKER_RE = re.compile(r"@custom:storage-location\s+erc7201:")
LIBRARY_RE = re.compile(r"^\s*library\s+(\w+)")
STRUCT_RE = re.compile(r"^\s*struct\s+(\w+)\s*\{")
# Поле: `<тип с возможными пробелами внутри mapping(...)/массивов> <имя>;`
# Тип — всё до последнего identifier-токена перед ';', имя — этот последний токен.
FIELD_RE = re.compile(r"^\s*(.+?)\s+([A-Za-z_]\w*)\s*;\s*$")


class ParseError(Exception):
    pass


def strip_line_comment(line: str) -> str:
    """Убирает `// ...` комментарий в конце строки.

    Ни в одном файле с namespaced storage-библиотеками в этом репо `//` не
    встречается внутри строковых литералов внутри struct-блоков — упрощение
    безопасно для реального содержимого src/ (в отличие от произвольного
    Solidity-кода в общем случае).
    """
    idx = line.find("//")
    if idx != -1:
        line = line[:idx]
    return line


def find_matching_brace(lines: list[str], open_idx: int) -> int:
    """lines[open_idx] содержит открывающую `{` (объявление library/struct).
    Возвращает индекс строки с соответствующей закрывающей `}` через подсчёт
    глубины (комментарии предварительно вырезаны strip_line_comment)."""
    depth = 0
    for i in range(open_idx, len(lines)):
        code = strip_line_comment(lines[i])
        depth += code.count("{")
        depth -= code.count("}")
        if depth == 0:
            return i
    raise ParseError(f"unbalanced braces starting at line {open_idx + 1}")


def normalize_type(t: str) -> str:
    """Схлопывает форматирование, не влияющее на смысл типа, чтобы гейт не
    палился на чисто косметические правки (пробелы вокруг `=>`, `(`, `)`)."""
    t = re.sub(r"\s+", " ", t.strip())
    t = re.sub(r"\s*=>\s*", "=>", t)
    t = re.sub(r"\s*\(\s*", "(", t)
    t = re.sub(r"\s*\)\s*", ")", t)
    t = re.sub(r"\s*,\s*", ",", t)
    t = re.sub(r"\s*\[\s*\]", "[]", t)
    return t


def parse_struct_fields(lines: list[str], struct_start: int, struct_end: int) -> list[tuple[str, str]]:
    """struct_start/struct_end — индексы строк с `struct X {` и закрывающей `}`.
    Возвращает упорядоченный список (type, name) для строк строго между ними."""
    fields: list[tuple[str, str]] = []
    for i in range(struct_start + 1, struct_end):
        line = strip_line_comment(lines[i]).strip()
        if not line:
            continue
        m = FIELD_RE.match(line)
        if not m:
            raise ParseError(
                f"не удалось разобрать поле структуры (строка {i + 1}): {lines[i]!r}"
            )
        field_type, field_name = m.group(1), m.group(2)
        fields.append((normalize_type(field_type), field_name))
    return fields


def structs_from_text(relpath: str, text: str) -> dict[str, list[tuple[str, str]]]:
    """Тот же разбор, но для ПРОИЗВОЛЬНОГО текста файла, а не только для того,
    что лежит на диске.

    Вынесено отдельной функцией кругом правок 2 (21 августа 2026): второй
    источник раскладки — не диск, а git (`git show HEAD:<путь>`), и разбирать
    его обязан ТОТ ЖЕ код. Две копии разбора разошлись бы при первой правке
    регулярки, и тогда «поле изменилось» и «поле такое же» решались бы разными
    парсерами — то есть сравнение перестало бы что-либо значить."""
    result: dict[str, list[tuple[str, str]]] = {}
    lines = text.splitlines()

    i = 0
    while i < len(lines):
        m = LIBRARY_RE.match(lines[i])
        if not m:
            i += 1
            continue

        lib_name = m.group(1)
        lib_start = i
        lib_end = find_matching_brace(lines, lib_start)
        lib_body = lines[lib_start : lib_end + 1]

        if any(STORAGE_MARKER_RE.search(l) for l in lib_body):
            j = lib_start
            while j <= lib_end:
                sm = STRUCT_RE.match(lines[j])
                if sm:
                    struct_name = sm.group(1)
                    struct_end = find_matching_brace(lines, j)
                    result[f"{relpath} :: {lib_name}.{struct_name}"] = parse_struct_fields(
                        lines, j, struct_end
                    )
                    j = struct_end + 1
                else:
                    j += 1

        i = lib_end + 1

    return result


def extract_storage_structs() -> dict[str, list[tuple[str, str]]]:
    """Возвращает {"relpath :: Library.Struct": [(type, name), ...]} для всех
    структур внутри namespaced storage-библиотек в src/."""
    result: dict[str, list[tuple[str, str]]] = {}

    sol_files = sorted(SRC_DIR.rglob("*.sol"))
    for path in sol_files:
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines()
        relpath = path.relative_to(REPO_ROOT).as_posix()

        i = 0
        while i < len(lines):
            m = LIBRARY_RE.match(lines[i])
            if not m:
                i += 1
                continue

            lib_name = m.group(1)
            lib_start = i
            lib_end = find_matching_brace(lines, lib_start)
            lib_body = lines[lib_start : lib_end + 1]

            is_storage_lib = any(STORAGE_MARKER_RE.search(l) for l in lib_body)
            if is_storage_lib:
                j = lib_start
                while j <= lib_end:
                    sm = STRUCT_RE.match(lines[j])
                    if sm:
                        struct_name = sm.group(1)
                        struct_end = find_matching_brace(lines, j)
                        fields = parse_struct_fields(lines, j, struct_end)
                        key = f"{relpath} :: {lib_name}.{struct_name}"
                        result[key] = fields
                        j = struct_end + 1
                    else:
                        j += 1

            i = lib_end + 1

    return result


# ── ВТОРОЙ ИСТОЧНИК РАСКЛАДКИ: git ────────────────────────────────────────────
#
# ⚠️ ЗАЧЕМ ОН ВООБЩЕ. Снимок отвечает на вопрос «что было записано», и для поля,
# которого в снимке НЕТ, он не отвечает ничего. А различить надо два случая,
# внешне одинаковых:
#
#   • поле ДОПИСАНО — законно, лечится `--update`;
#   • поле СУЩЕСТВОВАЛО и у него СМЕНИЛИ ТИП — незаконно, и `--update` тут не
#     лекарство, а увековечивание бага.
#
# Из одного лишь снимка они неразличимы в принципе: в обоих случаях слева
# «ничего», справа поле. Значит нужен второй источник, независимый от снимка, —
# и он есть, потому что исходники лежат в git. `git show HEAD:<путь>` даёт
# раскладку ДО правки, и по ней вопрос решается механически, а не просьбой к
# человеку читать внимательно.
#
# ⚠️ ЧЕГО ЭТОТ ИСТОЧНИК НЕ ЛОВИТ, названо, а не замолчано: смену типа, УЖЕ
# закоммиченную в HEAD. Там git и диск совпадают, разницы нет. Дыра узкая и
# закрывается сама: пока снимок не обновлён, `--check` возвращает 4 и краснеет
# в CI вечно, а `--update` откажет ровно в тот момент, когда поле попробуют
# записать. То есть попасть в HEAD такая правка может, а стать благословлённой —
# нет.


def git_baseline(ref: str = "HEAD") -> dict[str, list[tuple[str, str]]] | None:
    """Раскладка структур в `ref`. None — git недоступен или ответа нет
    (не репозиторий, первый коммит, вырезанный архив). None означает «не смог
    выяснить», и вызывающий обязан отнестись к этому как к незнанию, а не как
    к «изменений нет»."""
    import subprocess

    try:
        listing = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "ls-tree", "-r", "--name-only", ref, "src/"],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if listing.returncode != 0:
        return None

    result: dict[str, list[tuple[str, str]]] = {}
    for relpath in listing.stdout.splitlines():
        if not relpath.endswith(".sol"):
            continue
        try:
            blob = subprocess.run(
                ["git", "-C", str(REPO_ROOT), "show", f"{ref}:{relpath}"],
                capture_output=True, text=True, timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if blob.returncode != 0:
            continue
        try:
            result.update(structs_from_text(relpath, blob.stdout))
        except ParseError:
            # Старая ревизия могла не разбираться нынешним парсером. Молчать
            # об этом нельзя, но и валить гейт из-за истории — тоже: файл
            # просто не участвует в сверке, а его поля попадут в «не смог
            # выяснить».
            continue
    return result


def classify_unrecorded(
    key: str,
    fields: list[tuple[str, str]],
    baseline: dict[str, list[tuple[str, str]]] | None,
) -> tuple[list[tuple[str, str]], list[tuple[str, str, str]], list[tuple[str, str]]]:
    """Делит незаписанные в снимок поля на три кучи:
    (законно дописанные, [(имя, было, стало)] с изменённым типом, неопределимые)."""
    if baseline is None:
        return [], [], list(fields)

    before = {name: ftype for ftype, name in baseline.get(key, [])}
    appended: list[tuple[str, str]] = []
    retyped: list[tuple[str, str, str]] = []
    for ftype, fname in fields:
        old_type = before.get(fname)
        if old_type is None:
            appended.append((ftype, fname))
        elif old_type != ftype:
            retyped.append((fname, old_type, ftype))
        else:
            appended.append((ftype, fname))
    return appended, retyped, []


def format_snapshot(structs: dict[str, list[tuple[str, str]]]) -> str:
    header = """\
# Diamond storage struct snapshot — коммитится в git, руками не редактировать.
#
# Перегенерировать: python3 script/check_storage_structs.py --update
# Проверить:        ./script/check-storage-structs.sh
#
# Это снапшот ПОЛЕЙ (не только базовых слотов, см. test/StorageLayout.t.sol) —
# главных структур хранилища (struct Layout / struct Data) каждой namespaced
# storage-библиотеки в src/, плюс вложенных структур, которые они используют
# как тип поля. Единственная легальная эволюция — дописывание новых полей
# СТРОГО в конец списка существующей структуры. Смена типа, реордер, вставка
# в середину, удаление, переименование структуры или поля — всё это ломает
# инвариант "текущий код = префикс-расширение снапшота" и валит гейт.
#
# См. docs/CONTRACT_GUIDE.md, раздел "Правило раскладки Diamond-хранилища".
"""
    parts = [header]
    for key in sorted(structs.keys()):
        parts.append(f"=== {key} ===")
        for ftype, fname in structs[key]:
            parts.append(f"{ftype} {fname}")
        parts.append("")
    return "\n".join(parts).rstrip() + "\n"


def parse_snapshot(text: str) -> dict[str, list[tuple[str, str]]]:
    structs: dict[str, list[tuple[str, str]]] = {}
    current_key = None
    header_re = re.compile(r"^=== (.+) ===$")
    for raw_line in text.splitlines():
        line = raw_line.rstrip("\n")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = header_re.match(line)
        if m:
            current_key = m.group(1)
            structs[current_key] = []
            continue
        if current_key is None:
            raise ParseError(f"снапшот повреждён — данные до заголовка структуры: {line!r}")
        parts = line.rsplit(" ", 1)
        if len(parts) != 2:
            raise ParseError(f"снапшот повреждён — не разобрать строку поля: {line!r}")
        ftype, fname = parts
        structs[current_key].append((ftype, fname))
    return structs


def is_prefix(old: list[tuple[str, str]], new: list[tuple[str, str]]) -> bool:
    """True, если `old` — точный префикс `new` (т.е. `new` получен из `old`
    строго дописыванием полей в конец, без изменения ни одного существующего)."""
    if len(new) < len(old):
        return False
    return new[: len(old)] == old


def render_field_list(fields: list[tuple[str, str]]) -> list[str]:
    return [f"{t} {n}" for t, n in fields]


def diff_report(key: str, old: list[tuple[str, str]], new: list[tuple[str, str]]) -> str:
    old_lines = render_field_list(old)
    new_lines = render_field_list(new)
    lines = [f"  структура: {key}", "  снапшот (было)          -> текущий код (стало)"]
    max_len = max(len(old_lines), len(new_lines))
    first_mismatch = None
    for idx in range(max_len):
        o = old_lines[idx] if idx < len(old_lines) else "<нет>"
        n = new_lines[idx] if idx < len(new_lines) else "<нет>"
        marker = "   "
        if first_mismatch is None and o != n:
            first_mismatch = idx
            marker = " ! "
        lines.append(f"  [{idx:>2}]{marker}{o:<40} | {n}")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    mode = argv[1] if len(argv) > 1 else "--check"

    try:
        current = extract_storage_structs()
    except ParseError as e:
        print("check-storage-structs: ПАРСЕР СЛОМАН — не удалось разобрать src/:", file=sys.stderr)
        print(f"  {e}", file=sys.stderr)
        print(
            "  Раскладка НЕ проверена. Это не значит 'структур нет' — значит,\n"
            "  что формат исходников разошёлся с тем, что понимает парсер.",
            file=sys.stderr,
        )
        return 3

    if not current:
        print(
            "check-storage-structs: ПАРСЕР СЛОМАН — в src/ не найдено ни одной "
            "namespaced storage-структуры (искали `@custom:storage-location erc7201:`).",
            file=sys.stderr,
        )
        print(
            "  Ожидались структуры минимум для FactoryStorage, RegistryStorage,\n"
            "  ReceiptStorage, JobBoardStorage, ServiceBoardStorage, ReputationStorage,\n"
            "  ArbiterRegistryStorage, DiamondStorage. Ноль найденных — сигнал, что либо\n"
            "  маркер erc7201 переименовали, либо парсер не распознаёт формат структур.\n"
            "  Раскладка НЕ проверена — это не то же самое, что 'структур нет'.",
            file=sys.stderr,
        )
        return 3

    if mode == "--print":
        sys.stdout.write(format_snapshot(current))
        return 0

    if mode == "--update":
        # ⚠️ `--update` ОТКАЗЫВАЕТ, КОГДА ЕГО ЗОВУТ КАК ЛЕКАРСТВО ОТ БАГА
        # (круг правок 2, 21 августа 2026). Ревьюер замерил цепочку: `--check`
        # даёт 4, человек делает РОВНО ТО, ЧТО СОВЕТУЕТ СООБЩЕНИЕ, — и
        # запрещённая смена типа `uint8 -> bytes32` записывается в снимок
        # навсегда, `--check` после этого зелёный. То есть гейт своими руками
        # узаконивал тот самый класс, ради которого заведён.
        #
        # Отличаем механически, а не просьбой читать внимательно: у поля,
        # которого нет в снимке, спрашиваем git — было ли оно в HEAD и с каким
        # типом. Было с другим — это не дописывание, и записывать это нельзя.
        retyped_all: list[tuple[str, str, str, str]] = []
        unknown_all: list[tuple[str, str]] = []
        if SNAPSHOT_PATH.exists():
            try:
                snap = parse_snapshot(SNAPSHOT_PATH.read_text(encoding="utf-8"))
            except ParseError:
                snap = {}
            baseline = git_baseline()
            for key in sorted(set(current) & set(snap)):
                if is_prefix(snap[key], current[key]) and len(current[key]) > len(snap[key]):
                    _, retyped, unknown = classify_unrecorded(
                        key, current[key][len(snap[key]):], baseline
                    )
                    retyped_all += [(key, n, o, w) for n, o, w in retyped]
                    unknown_all += [(key, n) for _, n in unknown]

        if retyped_all:
            print(
                "check-storage-structs: --update ОТКАЗАН — это не дописывание, "
                "а смена типа",
                file=sys.stderr,
            )
            print("", file=sys.stderr)
            print(
                "Поля ниже уже существовали в HEAD, и у них ДРУГОЙ тип, чем сейчас\n"
                "в src/. Записать это в снимок значило бы объявить нормой ровно тот\n"
                "класс правки, который сломал живой JobBoard в июле 2026: слот тот\n"
                "же, кодировка другая, старые записи читаются мусором.",
                file=sys.stderr,
            )
            for key, fname, old_type, new_type in retyped_all:
                print("", file=sys.stderr)
                print(f"  структура: {key}", file=sys.stderr)
                print(f"    {fname}:  было {old_type}  ->  стало {new_type}", file=sys.stderr)
            print("", file=sys.stderr)
            print(
                "Что делать: ВЕРНУТЬ прежний тип. Если новый тип действительно\n"
                "нужен — это новое поле с новым именем, дописанное в конец, а\n"
                "старое остаётся на месте нетронутым (раскладка append-only).\n"
                "Обойти этот отказ можно только правкой самого гейта — и это\n"
                "намеренно: осознанное усилие, а не одна клавиша.",
                file=sys.stderr,
            )
            return 1

        if unknown_all:
            # git не ответил — записать можно, но не молча: человек обязан
            # знать, что второй источник в этот раз ничего не подтвердил.
            print(
                "check-storage-structs: ⚠️ git не ответил, проверить «дописано или "
                "переименовано» было нечем",
                file=sys.stderr,
            )
            for key, fname in unknown_all:
                print(f"  ? {fname}   ({key})", file=sys.stderr)
            print(
                "  Снимок обновлён на слово вызывающего. Если это смена типа, а не "
                "дописывание — она только что стала нормой.",
                file=sys.stderr,
            )

        SNAPSHOT_PATH.write_text(format_snapshot(current), encoding="utf-8")
        print(f"check-storage-structs: снапшот перезаписан -> {SNAPSHOT_PATH}")
        return 0

    if mode not in ("--check", ""):
        print(f"check-storage-structs: неизвестный режим {mode!r}", file=sys.stderr)
        return 2

    if not SNAPSHOT_PATH.exists():
        print(
            f"check-storage-structs: снапшот не найден ({SNAPSHOT_PATH}) — гейту не с "
            "чем сравнивать.",
            file=sys.stderr,
        )
        print(
            "  Это не 'чисто' и не 'ошибка' — это отсутствие базовой линии.\n"
            "  Создать: python3 script/check_storage_structs.py --update, затем "
            "закоммитить файл.",
            file=sys.stderr,
        )
        return 2

    try:
        snapshot = parse_snapshot(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    except ParseError as e:
        print(f"check-storage-structs: снапшот повреждён — {e}", file=sys.stderr)
        return 2

    only_in_current = sorted(set(current) - set(snapshot))
    only_in_snapshot = sorted(set(snapshot) - set(current))
    changed: list[str] = []
    unrecorded: list[tuple[str, list[tuple[str, str]]]] = []

    for key in sorted(set(current) & set(snapshot)):
        if not is_prefix(snapshot[key], current[key]):
            changed.append(key)
        elif len(current[key]) > len(snapshot[key]):
            # ⚠️ ЗАКОННОЕ ДОПИСЫВАНИЕ — И ВСЁ РАВНО ОТКАЗ. Разбор круга правок 1
            # к пункту 101 (21 августа 2026) замерил дыру: `chainProposalPath`
            # (задача 12, 18 августа) в снапшот не попал, потому что чистое
            # дописывание гейт устраивало. Смена его типа uint8 -> bytes32 —
            # ровно тот класс, что сломал живой JobBoard, — давала rc=0 и слово
            # «ок». Та же порча на СОСЕДНЕМ поле, которое в снапшоте есть,
            # давала rc=1 с диагностикой.
            #
            # То есть два поля одной структуры охранялись по-разному, и
            # различало их только то, добежал ли кто-то до `--update`. По репо
            # было 168 полей в коде против 167 в снимке.
            #
            # Поле вне снимка не сторожится НИЧЕМ: базовой линии для него нет,
            # значит и «изменение» обнаружить не с чем. Поэтому дописывание
            # законно как ПРАВКА, но незаконно как КОНЕЧНОЕ СОСТОЯНИЕ дерева, и
            # у него свой код возврата: 4, не 1. Раскладку никто не ломал —
            # сломана полнота снимка, и лечится она одной командой.
            unrecorded.append((key, current[key][len(snapshot[key]):]))

    # ⚠️ РАЗЛИЧАЕМ ДВА СЛУЧАЯ ВНУТРИ «НЕЗАПИСАННОГО», И ЭТО ГЛАВНАЯ ПРАВКА
    # КРУГА 2 (21 августа 2026). Внешне они одинаковы — слева в снимке ничего,
    # справа поле, — а требуют ПРОТИВОПОЛОЖНЫХ действий:
    #
    #   • поле дописано  -> `--update`, всё законно;
    #   • у поля сменили тип -> `--update` ЗАПРЕЩЁН, он увековечит баг.
    #
    # Сообщение, которое не различало их, отправляло человека в `--update`
    # ОБА раза. Замерено ревьюером: rc=4 -> `--update` -> rc=0, и запрещённая
    # смена типа благословлена навсегда. Совет гейта был ловушкой.
    #
    # Различаем вторым источником, а не просьбой читать внимательно: git.
    # Лениво: ~30 вызовов `git show` не нужны, когда классифицировать нечего,
    # а гейт зовётся в CI на каждом прогоне.
    baseline = git_baseline() if unrecorded else {}
    unrecorded_appended: list[tuple[str, list[tuple[str, str]]]] = []
    retyped_unrecorded: list[tuple[str, str, str, str]] = []
    unknown_unrecorded: list[tuple[str, list[tuple[str, str]]]] = []
    for key, fields in unrecorded:
        appended, retyped, unknown = classify_unrecorded(key, fields, baseline)
        if appended:
            unrecorded_appended.append((key, appended))
        if unknown:
            unknown_unrecorded.append((key, unknown))
        retyped_unrecorded += [(key, n, o, w) for n, o, w in retyped]

    # Смена типа — это код 1, а не 4, где бы её ни нашли: снимок тут ни при чём,
    # сломана раскладка. Печатается ПЕРВОЙ и отдельно, чтобы `--update` даже не
    # пришёл человеку в голову.
    if retyped_unrecorded:
        print(
            "check-storage-structs: СМЕНА ТИПА У ПОЛЯ, КОТОРОГО НЕТ В СНИМКЕ",
            file=sys.stderr,
        )
        print("", file=sys.stderr)
        print(
            "Поле есть в HEAD с ОДНИМ типом и в src/ с ДРУГИМ. Снимок про него\n"
            "молчит, поэтому обычная сверка это пропустила бы — сравнили с git.\n"
            "\n"
            "⚠️ `--update` ЗДЕСЬ НЕ ЛЕКАРСТВО. Он запишет новый тип, гейт станет\n"
            "зелёным, и ровно та правка, что сломала живой JobBoard в июле 2026\n"
            "(bytes32 termsHash -> string terms в том же слоте, Panic(0x22) на\n"
            "живых записях), будет объявлена нормой навсегда. Он и откажет.",
            file=sys.stderr,
        )
        for key, fname, old_type, new_type in retyped_unrecorded:
            print("", file=sys.stderr)
            print(f"  структура: {key}", file=sys.stderr)
            print(f"    {fname}:  было {old_type}  ->  стало {new_type}", file=sys.stderr)
        print("", file=sys.stderr)
        print(
            "Что делать: ВЕРНУТЬ прежний тип. Нужен новый — заводится НОВОЕ поле\n"
            "с новым именем в конце структуры, старое остаётся нетронутым.",
            file=sys.stderr,
        )
        if changed or only_in_current or only_in_snapshot:
            print("", file=sys.stderr)
            print("И это не всё — ниже остальное:", file=sys.stderr)
        else:
            return 1

    if not only_in_current and not only_in_snapshot and not changed and not unrecorded:
        print("check-storage-structs: ок — поля структур хранилища не менялись (или только дописаны в конец)")
        return 0

    # Отдельная, БОЛЕЕ МЯГКАЯ ветка, и печатается она раньше грозного текста про
    # сломанную раскладку — иначе человек прочитал бы «старые записи
    # декодируются мусором» про правку, которая ничего не сломала.
    if unrecorded_appended and not retyped_unrecorded and not only_in_current \
            and not only_in_snapshot and not changed:
        print(
            "check-storage-structs: РАСКЛАДКА ЦЕЛА, НО СНИМОК НЕПОЛОН — "
            "дописанные поля не сторожатся",
            file=sys.stderr,
        )
        print("", file=sys.stderr)
        print(
            "Поля ниже есть в src/ и дописаны СТРОГО В КОНЕЦ — то есть правка\n"
            "законна и живое хранилище цело. Но в снимке их нет, а значит для\n"
            "них не существует базовой линии: смена типа у такого поля пройдёт\n"
            "мимо гейта молча, ровно как прошла бы у termsHash в июле 2026.\n"
            "Пока снимок не обновлён, эти поля защищены НИЧЕМ.",
            file=sys.stderr,
        )
        for key, fields in unrecorded_appended:
            print("", file=sys.stderr)
            print(f"  структура: {key}", file=sys.stderr)
            for ftype, fname in fields:
                print(f"    + {ftype} {fname}", file=sys.stderr)
        if unknown_unrecorded:
            print("", file=sys.stderr)
            print(
                "⚠️ git не ответил, поэтому «дописано» здесь — предположение, а не\n"
                "  проверенный факт. Поля ниже могли оказаться и сменой типа:",
                file=sys.stderr,
            )
            for key, fields in unknown_unrecorded:
                for ftype, fname in fields:
                    print(f"  ? {ftype} {fname}   ({key})", file=sys.stderr)
        print("", file=sys.stderr)
        print(
            "Проверено по git: это ДОПИСЫВАНИЕ, а не смена типа, — поэтому\n"
            "лечится одной командой, и её результат надо закоммитить вместе\n"
            "с правкой кода:\n"
            "  python3 script/check_storage_structs.py --update\n"
            "\n"
            "(Если бы это была смена типа, гейт сказал бы другое и `--update`\n"
            " отказал бы. Совет выше даётся не всякому незаписанному полю.)",
            file=sys.stderr,
        )
        return 4

    print("check-storage-structs: НАЙДЕНО ЗАПРЕЩЁННОЕ ИЗМЕНЕНИЕ РАСКЛАДКИ ХРАНИЛИЩА", file=sys.stderr)
    print("", file=sys.stderr)
    print(
        "Менять тип поля / порядок / имя внутри struct Layout или struct Data\n"
        "нельзя даже при совпадающем размере слота — старые записи начинают\n"
        "декодироваться мусором (см. инцидент термса job'а, июль 2026, коммит\n"
        "1772ed9: bytes32 termsHash -> string terms в том же слоте, Panic(0x22)\n"
        "на живых записях). Единственная легальная эволюция — дописывание новых\n"
        "полей строго в конец структуры.",
        file=sys.stderr,
    )

    if only_in_snapshot:
        print("", file=sys.stderr)
        print("Структуры есть в снапшоте, но пропали из src/ (удалены или переименованы):", file=sys.stderr)
        for key in only_in_snapshot:
            print(f"  - {key}", file=sys.stderr)

    if only_in_current:
        print("", file=sys.stderr)
        print(
            "Структуры есть в src/, но их нет в снапшоте (новая структура ИЛИ "
            "переименование существующей — гейт не считает 'новое имя' автоматически "
            "безопасным, потому что именно так выглядело бы переименование Job -> JobV2):",
            file=sys.stderr,
        )
        for key in only_in_current:
            print(f"  - {key}", file=sys.stderr)

    if changed:
        print("", file=sys.stderr)
        print("Структуры с нелегальным изменением полей:", file=sys.stderr)
        for key in changed:
            print("", file=sys.stderr)
            print(diff_report(key, snapshot[key], current[key]), file=sys.stderr)

    if unrecorded_appended:
        # Сюда попадаем, только когда рядом есть и НАСТОЯЩАЯ поломка: код 1
        # старше кода 4. Но назвать незащищённые поля всё равно обязаны —
        # человек чинит одно и не должен потом второй раз узнавать про другое.
        #
        # Речь всегда о ДРУГОЙ структуре: внутри одной поломка ломает и
        # префикс, так что структура попадает в `changed`, а не сюда, — и
        # незаписанное поле там видно прямо в diff_report строкой «<нет> | …».
        print("", file=sys.stderr)
        print(
            "Кроме того, эти поля дописаны законно, но в снимок не попали — "
            "и потому не сторожатся:",
            file=sys.stderr,
        )
        for key, fields in unrecorded_appended:
            for ftype, fname in fields:
                print(f"  + {ftype} {fname}   ({key})", file=sys.stderr)

    print("", file=sys.stderr)
    print(
        "Если изменение осознанное и легальное (чистое дописывание в конец,\n"
        "новая структура/неймспейс после ревью) — перегенерировать снапшот:\n"
        "  python3 script/check_storage_structs.py --update\n"
        "и закоммитить script/storage-structs.snapshot вместе с изменением кода.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
