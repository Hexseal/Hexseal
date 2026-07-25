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

    for key in sorted(set(current) & set(snapshot)):
        if not is_prefix(snapshot[key], current[key]):
            changed.append(key)

    if not only_in_current and not only_in_snapshot and not changed:
        print("check-storage-structs: ок — поля структур хранилища не менялись (или только дописаны в конец)")
        return 0

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
