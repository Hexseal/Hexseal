#!/usr/bin/env python3
"""
Раскрыватель раскладки хранилища Agreement для check-agreement-layout.sh.

Зачем он нужен. Табличный вывод `forge inspect Agreement storageLayout`
печатает для составного поля только ИМЯ его типа, а не форму:

    extras        | mapping(uint256 => struct Agreement.Extra) | 21 | 0
    _finalStatus  | enum Agreement.Status                      | 20 | 2

Строка не меняется, если переставить поля внутри `struct Extra` или
переименовать/переставить члены `enum Status`. Оба изменения ломают чтение
хранилища у всех существующих клонов, но снапшот на табличном выводе их
не видит — гейт отдаёт 0. Это ровно та слепая зона, из-за которой в июле
2026 сломался JobBoard (коммит 1772ed9: смена типа поля ВНУТРИ struct Job),
и ровно та, которую коммит 7575b33 закрыл в соседнем гейте
check-storage-structs.sh.

Что делает этот скрипт: читает `forge inspect Agreement storageLayout --json`
со stdin и печатает на stdout по строке на каждое поле верхнего уровня в
формате

    имя|раскрытый тип|слот|оффсет

где «раскрытый тип» — рекурсивно развёрнутая ФОРМА типа, а не его имя:

    extras|mapping(uint256 => struct Agreement.Extra{amount:uint256@0+0,\
terms:string@1+0,status:enum Agreement.ExtraStatus[PENDING,ACCEPTED,REJECTED]@2+0})|21|0

Благодаря тому, что раскрытие остаётся ОДНОЙ строкой на поле верхнего уровня,
bash-обёртка сравнивает снапшот ровно тем же правилом «префикс + дописывание
в конец», что и раньше, — менять её логику сравнения не пришлось.

Откуда берётся форма:

  * структуры, отображения, массивы — из секции `types` того же JSON: там у
    структуры перечислены члены с типами, слотами и оффсетами;
  * члены enum'ов — из исходников src/, потому что секция `types` для enum'а
    отдаёт ТОЛЬКО encoding/label/numberOfBytes, без списка членов. Проверено
    на forge из этого окружения: у `t_enum(Status)819` нет ключа `members`,
    а astId в имени типа не меняется при перестановке членов. Значит,
    компилятор такой формы не отдаёт вовсе и единственный источник —
    объявление enum'а в коде.

Коды возврата:
    0 — раскрытие удалось, строки напечатаны
    3 — раскрыть не удалось (не JSON на входе, нет секции storage, не
        разрезолвился тип или enum). Это поломка САМОГО гейта, а не находка:
        раскладка НЕ проверена. Код совпадает с сентинелом 3 обёртки.
"""
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = REPO_ROOT / "src"

# `contract X`, `abstract contract X`, `library X`, `interface X`
SCOPE_RE = re.compile(r"^\s*(?:abstract\s+)?(?:contract|library|interface)\s+(\w+)", re.M)
# `enum X { A, B, C }` — тело enum'а не может содержать вложенных `}`
ENUM_RE = re.compile(r"\benum\s+(\w+)\s*\{([^}]*)\}", re.S)


class ExpandError(Exception):
    pass


def strip_comments(text: str) -> str:
    """Вырезает `//...` и `/*...*/`.

    То же упрощение, что в check_storage_structs.py: в src/ этого репозитория
    `//` и `/*` не встречаются внутри строковых литералов рядом с объявлениями
    контрактов и enum'ов, а больше нам от текста ничего не нужно.
    """
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"//[^\n]*", "", text)
    return text


def collect_enums() -> tuple[dict[str, list[str]], dict[str, list[list[str]]]]:
    """Собирает члены всех enum'ов, объявленных в src/.

    Возвращает пару словарей:
      * by_scoped: "Agreement.Status" -> ["CREATED", "FUNDED", ...]
      * by_bare:   "Status"           -> [список членов на каждое объявление]

    Область видимости определяется ближайшим предшествующим объявлением
    contract/library/interface — в Solidity контракты не вкладываются друг в
    друга, поэтому для enum'а внутри контракта это точный ответ. Для enum'а
    файлового уровня область пустая; такие резолвятся по by_bare.
    """
    by_scoped: dict[str, list[str]] = {}
    by_bare: dict[str, list[list[str]]] = {}

    for path in sorted(SRC_DIR.rglob("*.sol")):
        text = strip_comments(path.read_text(encoding="utf-8"))
        scopes = [(m.start(), m.group(1)) for m in SCOPE_RE.finditer(text)]

        for m in ENUM_RE.finditer(text):
            name = m.group(1)
            members = [p.strip() for p in m.group(2).split(",")]
            members = [p for p in members if p]
            if not members:
                raise ExpandError(f"enum {name} в {path} разобран как пустой")

            scope = ""
            for pos, scope_name in scopes:
                if pos < m.start():
                    scope = scope_name
                else:
                    break

            if scope:
                by_scoped.setdefault(f"{scope}.{name}", members)
            by_bare.setdefault(name, []).append(members)

    return by_scoped, by_bare


def enum_members(label: str, by_scoped, by_bare) -> list[str]:
    """label — то, что печатает forge: `enum Agreement.Status`."""
    qualified = label[len("enum "):].strip()
    if qualified in by_scoped:
        return by_scoped[qualified]

    bare = qualified.rsplit(".", 1)[-1]
    candidates = by_bare.get(bare, [])
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        raise ExpandError(
            f"не найдено объявление {label!r} ни в одном файле src/ — "
            f"парсер enum'ов разошёлся с кодом"
        )
    raise ExpandError(
        f"неоднозначное объявление {label!r}: в src/ найдено {len(candidates)} "
        f"enum'ов с именем {bare!r} и разными членами"
    )


def expand(type_id: str, types: dict, by_scoped, by_bare, stack: tuple[str, ...] = ()) -> str:
    """Рекурсивно разворачивает тип в его форму."""
    if type_id in stack:
        # Рекурсивный тип (структура через mapping на саму себя). Дальше не
        # разворачиваем, но помечаем, чтобы строка не выглядела «раскрытой».
        return f"<рекурсия:{type_id}>"

    entry = types.get(type_id)
    if entry is None:
        raise ExpandError(f"тип {type_id!r} отсутствует в секции `types` вывода forge")

    label = entry.get("label")
    if label is None:
        raise ExpandError(f"у типа {type_id!r} нет поля `label`")

    stack = stack + (type_id,)
    encoding = entry.get("encoding")

    if "members" in entry:
        parts = []
        for member in entry["members"]:
            member_type = expand(member["type"], types, by_scoped, by_bare, stack)
            parts.append(
                f"{member['label']}:{member_type}@{member['slot']}+{member['offset']}"
            )
        return f"{label}{{{','.join(parts)}}}"

    if encoding == "mapping":
        key = expand(entry["key"], types, by_scoped, by_bare, stack)
        value = expand(entry["value"], types, by_scoped, by_bare, stack)
        return f"mapping({key} => {value})"

    if "base" in entry:
        base = expand(entry["base"], types, by_scoped, by_bare, stack)
        # Из label берём только суффикс размерности: `uint256[3]` -> `[3]`.
        suffix = label[label.rindex("["):] if "[" in label else "[]"
        return f"{base}{suffix}"

    if label.startswith("enum "):
        members = enum_members(label, by_scoped, by_bare)
        return f"{label}[{','.join(members)}]"

    if label.startswith("struct "):
        # Структура без `members` — forge не отдал форму, а мы на неё
        # рассчитываем. Молча пропускать нельзя: это и есть слепая зона.
        raise ExpandError(
            f"у структуры {label!r} ({type_id}) нет секции `members` — "
            f"формат вывода forge изменился, форма НЕ проверена"
        )

    return label


def main() -> int:
    raw = sys.stdin.read()
    # Отрезаем возможный шум вокруг JSON (forge пишет прогресс сборки в stderr,
    # а обёртка сливает его в тот же поток через 2>&1).
    start, end = raw.find("{"), raw.rfind("}")
    if start == -1 or end == -1 or end < start:
        print("expand_agreement_layout: на входе нет JSON-объекта.", file=sys.stderr)
        return 3

    try:
        layout = json.loads(raw[start : end + 1])
    except json.JSONDecodeError as e:
        print(f"expand_agreement_layout: вход не разобрался как JSON — {e}", file=sys.stderr)
        return 3

    storage = layout.get("storage")
    types = layout.get("types") or {}
    if not storage:
        print(
            "expand_agreement_layout: в JSON нет непустой секции `storage` — "
            "раскладка НЕ проверена.",
            file=sys.stderr,
        )
        return 3

    try:
        by_scoped, by_bare = collect_enums()
        lines = []
        for field in storage:
            expanded = expand(field["type"], types, by_scoped, by_bare)
            lines.append(f"{field['label']}|{expanded}|{field['slot']}|{field['offset']}")
    except ExpandError as e:
        print(f"expand_agreement_layout: не удалось раскрыть тип — {e}", file=sys.stderr)
        return 3
    except (KeyError, ValueError) as e:
        print(
            f"expand_agreement_layout: неожиданная структура вывода forge — {e!r}",
            file=sys.stderr,
        )
        return 3

    sys.stdout.write("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
