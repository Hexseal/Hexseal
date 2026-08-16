#!/usr/bin/env python3
"""
Гейт: ненулевую запись в `arbiterBond` делает РОВНО ОДНА функция.

⚠️ Этот гейт НЕ включён в CI (.github/workflows/ci.yml). Их там шесть, и
каждый новый — налог на каждый прогон; седьмой добавляется отдельным решением
владельца. Запускать руками: ./script/check-arbiter-bond-writers.sh

---------------------------------------------------------------------------
ЗАЧЕМ, ЕСЛИ ЕСТЬ ТЕСТ

Тест `test_HandSeatedArbiterHasNoBondToBurn` (test/ArbiterRemovalForCause*.t.sol)
пришпиливает УЗКОЕ утверждение: «addArbiter сама залога не берёт». Публичный
документ (docs/DECENTRALIZATION.md) утверждает ШИРОКОЕ: «zero for everyone who
can actually be removed» — у всякого, кого можно снести, залога нет, значит
сжигать нечего.

Разница между узким и широким и есть дыра, и она НЕ теоретическая. Ревью
задачи 6 её разыграло на настоящем даймонде: посадить рукой → пройти второй
шаг существующей арбитрской дверью → снести. Банк арбитров вырос на 50 000 000
при НУЛЕ красных из 852. То есть при двухшаговом залоге — устройстве, которое
владелец уже выбрал, — `addArbiter` залога по-прежнему брать не будет, тест
останется зелёным, а утверждение документа станет ложным.

Замок, который переживает своё истечение молча, хуже отсутствующего: он
обещает предупредить и не предупреждает.

Гейт переживает этот переход по построению. При двухшаговом залоге ненулевых
писателей станет ДВА, гейт покраснеет и потребует осознанно дописать второго —
вместе с перечитыванием того абзаца документа, который от этого станет ложным.

---------------------------------------------------------------------------
ЧТО СЧИТАЕТСЯ НЕНУЛЕВОЙ ЗАПИСЬЮ

Присваивание, левая часть которого — обращение по ключу к полю `arbiterBond`
(`d.arbiterBond[кто] = ...`), И при этом:

  • оператор `=`, а правая часть НЕ литеральный ноль        → ненулевая запись
  • составной оператор (`+=`, `-=`, `|=` и прочие)          → ненулевая запись
    (составной оператор может увеличить, каким бы ни был операнд)
  • оператор `=` с литеральным нулём справа                 → НУЛЕВАЯ, не в счёт
  • `delete d.arbiterBond[кто]`                             → НУЛЕВАЯ, не в счёт

Чтения (`uint256 x = d.arbiterBond[кто]`, возврат из геттера) не считаются
вовсе: гейт про то, кто НАЗНАЧАЕТ залог, а не про то, кто его видит.

---------------------------------------------------------------------------
ЧЕГО ГЕЙТ НЕ ЛОВИТ — СКАЗАНО ВСЛУХ

  • Запись через ассемблерный `sstore` по вычисленному слоту. В src/ такого
    нет ни разу (ассемблер здесь только в `data()`-адресации неймспейсов и в
    `_msgSender`), но гейт этого не проверяет и обещать не станет.
  • Запись из контракта ВНЕ src/ — её физически не бывает: неймспейс
    `hexseal.arbiter.registry.storage` живёт в хранилище даймонда, писать в
    него может только смонтированный фасет, а фасеты все в src/.
  • Косвенное изменение через переименование поля. Ловится иначе: если во
    всём src/ не найдено НИ ОДНОГО обращения к `arbiterBond`, гейт выходит с
    кодом 3 «сломан сам гейт», а не с зелёным.

---------------------------------------------------------------------------
КАК РАЗБИРАЕТСЯ КОД

AST'ом solc из артефактов `out/<File>.sol/*.json` (ключ `ast`, включён через
`ast = true` в foundry.toml) — тем же приёмом и тем же кодом обхода, что
script/check_gasless_sender.py. Регулярки здесь не годятся по той же причине:
слово `arbiterBond` встречается в комментариях этих файлов чаще, чем в коде,
и ровно там, где объясняется, почему рядом его как раз НЕ трогают.

Коды возврата:
    0   — ненулевой писатель ровно один и он тот, что записан ниже
    1   — писателей стало больше/меньше, или это не тот писатель
    3   — разбор не состоялся: нет артефакта с AST, или поле `arbiterBond`
          не найдено в src/ вовсе. Сломан сам гейт, правило НЕ проверено —
          это не то же самое, что «нарушений нет»
"""
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = REPO_ROOT / "src"
OUT_DIR = REPO_ROOT / "out"

FIELD = "arbiterBond"

# Единственный ненулевой писатель на сегодня, вместе с причиной. Дописать сюда
# второго — значит вслух признать, что «залога нет у всякого, кого можно
# снести» перестало быть правдой, и пойти править docs/DECENTRALIZATION.md.
# Формат ключа: "<путь> :: <Контракт>.<функция>".
EXPECTED_NONZERO_WRITERS = {
    "src/facets/ArbiterRegistryFacet.sol :: ArbiterRegistryFacet.applyAsArbiter":
        "самозапись — единственная дверь, где человек кладёт залог сам; "
        "заперта за isDaoActive(), то есть сегодня недостижима вовсе",
}

# Без номера строки НАМЕРЕННО (урок этой же уборки): номер в комментарии
# живёт до первой правки соседа и протухает молча. Ссылка по заголовку строки
# таблицы и по дословной цитате — их видно грепом.
DOC_CLAIM = (
    "docs/DECENTRALIZATION.md, строка таблицы «Suspend or remove an arbiter»:\n"
    "  «The only code path that posts a bond is the self-service applyAsArbiter»\n"
    "  и «Today that bond is zero for everyone who can actually be removed»"
)


class ParseError(Exception):
    pass


# --------------------------------------------------------------------------
# Загрузка AST (тот же приём, что в check_gasless_sender.py)


def load_asts() -> dict[str, dict]:
    asts: dict[str, dict] = {}
    missing: list[str] = []

    for src_path in sorted(SRC_DIR.rglob("*.sol")):
        relpath = src_path.relative_to(REPO_ROOT).as_posix()
        art_dir = OUT_DIR / src_path.name
        found = None
        if art_dir.is_dir():
            for art in sorted(art_dir.glob("*.json")):
                try:
                    data = json.loads(art.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                ast = data.get("ast")
                if isinstance(ast, dict) and ast.get("absolutePath") == relpath:
                    found = ast
                    break
        if found is None:
            missing.append(relpath)
        else:
            asts[relpath] = found

    if missing:
        raise ParseError(
            "у следующих файлов src/ не нашлось артефакта с AST:\n  "
            + "\n  ".join(missing)
            + "\n\nПричины: сборка не проходила (forge build), в foundry.toml пропал\n"
            "`ast = true`, или изменился формат артефактов форджа."
        )

    return asts


# --------------------------------------------------------------------------
# Обход AST


def iter_nodes(node):
    """Рекурсивный обход: отдаёт каждый dict-узел с nodeType. Имена дочерних
    полей не перечисляются намеренно — solc их переименовывает от версии к
    версии."""
    if isinstance(node, dict):
        if "nodeType" in node:
            yield node
        for value in node.values():
            yield from iter_nodes(value)
    elif isinstance(node, list):
        for item in node:
            yield from iter_nodes(item)


def src_offset(node) -> int:
    raw = node.get("src")
    if not isinstance(raw, str):
        raise ParseError(f"у узла {node.get('nodeType')!r} нет поля src")
    try:
        return int(raw.split(":", 1)[0])
    except ValueError as exc:
        raise ParseError(f"не разобрать src={raw!r}") from exc


def line_index(data: bytes) -> list[int]:
    """Смещения начала строк. По БАЙТАМ: `src` у solc байтовый, а комментарии
    здесь на русском (двухбайтовые)."""
    starts = [0]
    pos = data.find(b"\n")
    while pos != -1:
        starts.append(pos + 1)
        pos = data.find(b"\n", pos + 1)
    return starts


def line_of(starts: list[int], offset: int) -> int:
    lo, hi = 0, len(starts) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if starts[mid] <= offset:
            lo = mid
        else:
            hi = mid - 1
    return lo + 1


def member_name(node) -> str:
    name = node.get("name") or ""
    if name:
        return name
    kind = node.get("kind")
    if kind in ("constructor", "fallback", "receive"):
        return f"<{kind}>"
    return "<anonymous>"


def touches_field(node) -> bool:
    """`<что-то>.arbiterBond` — MemberAccess с этим memberName."""
    return node.get("nodeType") == "MemberAccess" and node.get("memberName") == FIELD


def is_field_slot(node) -> bool:
    """Левая часть присваивания вида `d.arbiterBond[кто]`.

    Проверяется именно IndexAccess над MemberAccess: присвоение самому
    отображению в Solidity невозможно, а обращение по ключу — единственная
    форма записи в него.
    """
    if not isinstance(node, dict) or node.get("nodeType") != "IndexAccess":
        return False
    base = node.get("baseExpression")
    return isinstance(base, dict) and touches_field(base)


def is_literal_zero(node) -> bool:
    if not isinstance(node, dict) or node.get("nodeType") != "Literal":
        return False
    return node.get("kind") == "number" and str(node.get("value")).strip() in ("0", "0x0", "0x00")


class Write:
    __slots__ = ("relpath", "contract", "member", "line", "kind", "text")

    def __init__(self, relpath, contract, member, line, kind, text):
        self.relpath = relpath
        self.contract = contract
        self.member = member
        self.line = line
        self.kind = kind      # "nonzero" | "zero"
        self.text = text

    @property
    def key(self) -> str:
        return f"{self.relpath} :: {self.contract}.{self.member}"


def classify(node):
    """Возвращает ("nonzero"|"zero", описание) или None, если узел не запись."""
    ntype = node.get("nodeType")

    if ntype == "Assignment":
        lhs = node.get("leftHandSide")
        if not is_field_slot(lhs):
            return None
        op = node.get("operator") or "="
        if op != "=":
            return "nonzero", f"составной оператор {op}"
        if is_literal_zero(node.get("rightHandSide")):
            return "zero", "= 0"
        return "nonzero", "= <не ноль>"

    if ntype == "UnaryOperation" and node.get("operator") == "delete":
        if is_field_slot(node.get("subExpression")):
            return "zero", "delete"
        return None

    return None


def scan(asts: dict[str, dict]):
    """Возвращает (все записи, сколько раз поле вообще упомянуто)."""
    writes: list[Write] = []
    mentions = 0

    for relpath, ast in asts.items():
        source = (REPO_ROOT / relpath).read_bytes()
        starts = line_index(source)
        mentions += sum(1 for node in iter_nodes(ast) if touches_field(node))

        attached = 0
        for contract in iter_nodes(ast):
            if contract.get("nodeType") != "ContractDefinition":
                continue
            cname = contract.get("name") or "<unnamed>"
            for member in contract.get("nodes", []):
                if not isinstance(member, dict):
                    continue
                if member.get("nodeType") not in ("FunctionDefinition", "ModifierDefinition"):
                    continue
                mname = member_name(member)
                for node in iter_nodes(member):
                    verdict = classify(node)
                    if verdict is None:
                        continue
                    kind, text = verdict
                    attached += 1
                    writes.append(
                        Write(relpath, cname, mname, line_of(starts, src_offset(node)), kind, text)
                    )

        # Та же сверка привязки, что в гейте гейслесса: запись, лежащая вне
        # тела функции (инициализатор state-переменной, свободная функция),
        # молча выпала бы из проверки.
        total = sum(1 for node in iter_nodes(ast) if classify(node) is not None)
        if total != attached:
            raise ParseError(
                f"{relpath}: {total - attached} записей в {FIELD} не удалось привязать\n"
                f"  к функции или модификатору (всего {total}, привязано {attached}).\n"
                "  Гейт не умеет их адресовать и не станет молча пропускать."
            )

    return writes, mentions


# --------------------------------------------------------------------------


def main(argv) -> int:
    try:
        asts = load_asts()
        writes, mentions = scan(asts)
    except ParseError as exc:
        print(f"check-arbiter-bond-writers: разбор не состоялся\n{exc}", file=sys.stderr)
        return 3

    if mentions == 0:
        print(
            f"check-arbiter-bond-writers: поле `{FIELD}` не встречается в src/ ни разу.\n"
            "  Либо его переименовали, либо сломан разбор. В обоих случаях правило\n"
            "  НЕ проверено — а зелёный здесь означал бы обратное.",
            file=sys.stderr,
        )
        return 3

    nonzero = [w for w in writes if w.kind == "nonzero"]
    zero = [w for w in writes if w.kind == "zero"]

    if "--print" in argv:
        print(f"Упоминаний `{FIELD}` в src/: {mentions}")
        print(f"Ненулевых записей: {len(nonzero)}")
        for w in nonzero:
            print(f"  {w.key}  ({w.relpath.split('/')[-1]}:{w.line}, {w.text})")
        print(f"Нулевых записей (в счёт не идут): {len(zero)}")
        for w in zero:
            print(f"  {w.key}  ({w.relpath.split('/')[-1]}:{w.line}, {w.text})")
        return 0

    found = {}
    for w in nonzero:
        found.setdefault(w.key, []).append(w)

    expected = set(EXPECTED_NONZERO_WRITERS)
    unexpected = sorted(set(found) - expected)
    vanished = sorted(expected - set(found))

    if not unexpected and not vanished:
        print(
            f"check-arbiter-bond-writers: ненулевую запись в `{FIELD}` делает "
            f"ровно одна функция — {', '.join(sorted(found))}. "
            f"Нулевых записей {len(zero)}, они не в счёт."
        )
        return 0

    print("check-arbiter-bond-writers: КРАСНЫЙ", file=sys.stderr)
    print(file=sys.stderr)

    for key in unexpected:
        for w in found[key]:
            print(
                f"  НОВЫЙ ненулевой писатель: {key}\n"
                f"    {w.relpath}:{w.line} ({w.text})",
                file=sys.stderr,
            )

    for key in vanished:
        print(
            f"  ПРОПАЛ ожидаемый писатель: {key}\n"
            "    Либо функцию переименовали/убрали, либо запись перестала быть\n"
            "    ненулевой. Запись в EXPECTED_NONZERO_WRITERS протухла.",
            file=sys.stderr,
        )

    print(
        "\n  Почему это важнее, чем выглядит.\n"
        f"  На числе ненулевых писателей стоит утверждение публичного документа:\n"
        f"  {DOC_CLAIM}.\n"
        "  Пока писатель один и он заперт за спящей ДАО, у посаженного рукой\n"
        "  арбитра залога нет — сжигать при сносе нечего, и документ говорит правду.\n"
        "  Второй писатель делает утверждение ложным, НЕ трогая addArbiter, —\n"
        "  то есть тест про ручную посадку останется зелёным и не предупредит.\n"
        "\n  Что делать: если второй писатель заведён осознанно (например,\n"
        "  двухшаговый залог) — дописать его в EXPECTED_NONZERO_WRITERS вместе с\n"
        "  причиной И перечитать тот абзац документа. Гейт не про запрет, он про\n"
        "  то, чтобы переход не прошёл молча.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
