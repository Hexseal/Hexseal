#!/usr/bin/env python3
"""
Гейт правила ERC-2771: в гейслесс-контрактах сырой `msg.sender` запрещён.

Инцидент, ради которого это написано (31 июля 2026, коммит d172064): у
`ArbiterRegistryFacet.fundDispute` и `withdrawDisputeBounty` отправитель читался
как `msg.sender`, а не `_msgSender()`. Обе функции фронт зовёт ИСКЛЮЧИТЕЛЬНО
через форвардер (frontend/src/lib/relay.ts), где `msg.sender` — адрес
MinimalForwarder, а человек лежит в хвосте calldata. Проверка «ты сторона
спора?» отвергала каждую оплату: платный вызов арбитра не сработал ни разу.

Важна не описка, а как она выжила. В том же файле правило соблюдено пятнадцать
раз, две новые функции его просто не унаследовали, компилятор об этом ничего не
знает, а ни один из 550 тестов не ходил по этому пути через настоящий форвардер.
Соглашение жило в головах — этот скрипт переселяет его в проверку.

---------------------------------------------------------------------------
ЧТО СЧИТАЕТСЯ НАРУШЕНИЕМ

Обращение к `msg.sender` (а также к ассемблерному `caller()`, это то же самое
другими буквами) внутри файла, который реализует ERC-2771. «Реализует» здесь =
в файле есть определение `function _msgSender()`. Сейчас таких файлов ровно
шесть (arbiter-accountability, задача 8, 15 августа 2026, добавила
ArbiterAccountabilityFacet.sol — respondToRemoval, единственная гейслесс-функция
фасета, потребовала собственный _msgSender), они перечислены в
KNOWN_ERC2771_FILES и служат нижней границей: если скрипт обнаружит меньше,
значит сломался он сам, а не код (см. код возврата 3).

Проверяются ВСЕ контракты такого файла, а не только тот, что объявил
`_msgSender`. Причина — Agreement.sol: `MinimalERC721` сам по себе про ERC-2771
не знает, но его функции входят в задеплоенный `Agreement` и вызываются людьми
ровно так же, как остальные.

---------------------------------------------------------------------------
ЗАКОННЫЕ ИСКЛЮЧЕНИЯ

Их немало, и молча пропускать их нельзя — это и есть тот случай, когда «гейт
промолчал» ничем не отличается от «гейта нет». Каждое исключение записано в
script/gasless-sender.allow отдельной записью, и каждая запись обязана нести
причину, начинающуюся дословно с «не гейслесс, потому что:». Формат сделан
неудобным намеренно: добавить исключение нельзя, не сказав вслух, почему эта
функция намеренно не гейслесс.

Запись пиннит ещё и КОЛИЧЕСТВО сырых обращений в функции. Иначе однажды
разрешённая функция становится дырой: новый `msg.sender`, дописанный в уже
внесённое в список тело, прошёл бы незамеченным. Изменилось количество —
гейт красный, изменение идёт через ревью и правку записи.

---------------------------------------------------------------------------
ОБЛАСТЬ ПРОВЕРКИ ЗАКРЫТА ЦЕЛИКОМ

Автопоиск «файл реализует _msgSender» сам по себе имеет дыру ровно той формы,
ради которой писался гейт: новый фасет, который правила не выучил и _msgSender
не завёл, для автопоиска невидим. Так и обнаружилось, что ReputationFacet.claimXP
— пользовательская функция с сырым msg.sender в фасете без _msgSender вовсе.

Поэтому КАЖДЫЙ .sol в src/ обязан быть отнесён к одной из двух категорий:
либо он ERC-2771 (есть _msgSender — проверяется по функциям), либо он явно
исключён записью «вне области :: <путь>» в том же allow-файле, тоже с причиной.
Файл, не попавший никуда, валит гейт. Добавить в src/ новый фасет и не заметить
правило теперь нельзя: не отнеся его к категории, до зелёного CI не дойти.

Записи «вне области» пиннят количество ТОЧНО ТАК ЖЕ — только по файлу целиком,
а не по функции: ключ у них файл, функций внутри гейт не разбирает. Без этого
счётчика вторая половина области держалась бы на одном обещании человека
перечитывать причину при каждой правке файла: в ReputationFacet, RegistryFacet,
Treasury, JobReceiptFacet и DiamondProxy можно было дописать новую
пользовательскую функцию с сырым msg.sender, и гейт остался бы зелёным — тот же
самый класс, ради которого он писался. Теперь любое изменение числа сырых
обращений в исключённом файле красит гейт и заставляет перечитать причину.
Ноль тоже пиннится (SVGRenderer, DealMetadataFacet, IFactory): «отправителя не
читает нигде» — утверждение, которое проверяется.

---------------------------------------------------------------------------
КАК РАЗБИРАЕТСЯ КОД

Не регулярками по тексту, а AST'ом solc из артефактов `out/<File>.sol/*.json`
(ключ `ast`, включён через `ast = true` в foundry.toml). Причина: в этих пяти
файлах `msg.sender` встречается в комментариях больше десяти раз — ровно там,
где объясняется, почему в соседней строке его как раз НЕТ. Текстовый поиск
захлебнулся бы в собственной документации, а дерево видит только настоящие
обращения и точно знает, в какой функции каждое лежит.

`msg.sender` в дереве — это MemberAccess{memberName: "sender"} над
Identifier{name: "msg"}. Ассемблерный `caller()` — YulFunctionCall с тем же
смыслом; он тоже ловится, хотя сейчас в src/ не встречается ни разу.

---------------------------------------------------------------------------
Режимы запуска:
    python3 script/check_gasless_sender.py            — проверка
    python3 script/check_gasless_sender.py --print    — вывести найденное
                                                        заготовкой для allow-файла
                                                        (причину дописывает человек)

Коды возврата:
    0   — все сырые обращения к msg.sender объяснены в allow-файле
    1   — найдено необъяснённое обращение, ИЛИ у объяснённой функции изменилось
          их количество, ИЛИ изменилось количество в файле «вне области»,
          ИЛИ запись в allow-файле протухла (функции больше нет),
          ИЛИ файл в src/ не отнесён ни к одной из двух категорий
    2   — allow-файл отсутствует, пуст или повреждён (в том числе: запись без
          причины) — сравнивать не с чем, это НЕ «чисто»
    3   — разбор не состоялся: нет артефакта или AST у файла из src/, не найден
          ни один ERC-2771-файл из известных, не найдено ни одного обращения
          вообще. Сломан сам гейт, правило НЕ проверено — это не то же самое,
          что «нарушений нет»
"""
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = REPO_ROOT / "src"
OUT_DIR = REPO_ROOT / "out"
ALLOW_PATH = REPO_ROOT / "script" / "gasless-sender.allow"

REASON_MARKER = "не гейслесс, потому что:"
# Префикс ключа для записей второго рода — «этот файл src/ вне области проверки».
OUT_OF_SCOPE_PREFIX = "вне области :: "
MIN_REASON_CHARS = 30
PLACEHOLDERS = ("ЗАПОЛНИТЬ", "TODO", "FIXME", "XXX")

# Нижняя граница множества ERC-2771-файлов. Скрипт находит их сам (по наличию
# `function _msgSender()`), но если автопоиск вернёт меньше этого списка —
# значит сломался автопоиск, а не код. Дописывать сюда новый файл нужно ровно
# тогда, когда в src/ появляется ещё один гейслесс-контракт.
KNOWN_ERC2771_FILES = (
    "src/Agreement.sol",
    "src/FactoryFacet.sol",
    "src/facets/ArbiterAccountabilityFacet.sol",
    "src/facets/ArbiterRegistryFacet.sol",
    "src/facets/JobBoardFacet.sol",
    "src/facets/ServiceBoardFacet.sol",
)


class ParseError(Exception):
    pass


# --------------------------------------------------------------------------
# Загрузка AST


def load_asts() -> dict[str, dict]:
    """Возвращает {relpath: ast} для каждого .sol в src/.

    Артефакты форджа лежат по basename файла (out/<File>.sol/<Contract>.json), и
    у всех контрактов одного файла AST один и тот же — берём первый подошедший
    по absolutePath. Файл, для которого AST не нашёлся, — это ParseError, а не
    «в нём ничего нет»: не прочитав дерево, нельзя утверждать, что в файле нет
    нарушений.
    """
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
    """Рекурсивный обход дерева: отдаёт каждый dict-узел, у которого есть
    nodeType. Специально не перечисляет имена дочерних полей — solc их
    добавляет и переименовывает от версии к версии, а «обойти всё, что похоже
    на узел» устойчиво к этому."""
    if isinstance(node, dict):
        if "nodeType" in node:
            yield node
        for value in node.values():
            yield from iter_nodes(value)
    elif isinstance(node, list):
        for item in node:
            yield from iter_nodes(item)


def src_offset(node) -> int:
    """`src` узла — строка вида "offset:length:fileIndex"."""
    raw = node.get("src")
    if not isinstance(raw, str):
        raise ParseError(f"у узла {node.get('nodeType')!r} нет поля src")
    try:
        return int(raw.split(":", 1)[0])
    except ValueError as exc:
        raise ParseError(f"не разобрать src={raw!r}") from exc


def line_index(data: bytes) -> list[int]:
    """Смещения начала каждой строки — для перевода offset -> номер строки.

    Считается по БАЙТАМ, а не по символам: `src` у solc — байтовое смещение, а
    в этих файлах комментарии на русском, то есть двухбайтовые. На тексте,
    декодированном в str, номера уезжали вперёд на сотню строк.
    """
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
    """Человекочитаемое имя функции/модификатора для ключа записи."""
    name = node.get("name") or ""
    if name:
        return name
    kind = node.get("kind")
    if kind in ("constructor", "fallback", "receive"):
        return f"<{kind}>"
    return "<anonymous>"


def is_raw_msg_sender(node) -> bool:
    if node.get("nodeType") != "MemberAccess" or node.get("memberName") != "sender":
        return False
    expr = node.get("expression")
    return isinstance(expr, dict) and expr.get("nodeType") == "Identifier" and expr.get("name") == "msg"


def is_yul_caller(node) -> bool:
    if node.get("nodeType") != "YulFunctionCall":
        return False
    fn = node.get("functionName")
    return isinstance(fn, dict) and fn.get("name") == "caller"


class Occurrence:
    __slots__ = ("relpath", "contract", "member", "line", "form")

    def __init__(self, relpath, contract, member, line, form):
        self.relpath = relpath
        self.contract = contract
        self.member = member
        self.line = line
        self.form = form

    @property
    def key(self) -> str:
        return f"{self.relpath} :: {self.contract}.{self.member}"


def occurrence_form(node) -> str | None:
    if is_raw_msg_sender(node):
        return "msg.sender"
    if is_yul_caller(node):
        return "caller()"
    return None


def scan_file(relpath: str, ast: dict, source: bytes):
    """Возвращает (defines_msg_sender, [Occurrence, ...]) для одного файла."""
    starts = line_index(source)
    defines = False
    occurrences: list[Occurrence] = []

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
            if mname == "_msgSender":
                defines = True
            for node in iter_nodes(member):
                form = occurrence_form(node)
                if form is None:
                    continue
                occurrences.append(
                    Occurrence(relpath, cname, mname, line_of(starts, src_offset(node)), form)
                )

    # Привязка обращений к функциям идёт по прямым членам ContractDefinition —
    # то есть по телам функций и модификаторов. Обращение, лежащее где-то ещё
    # (инициализатор state-переменной, свободная функция вне контракта), в
    # список не попадёт и молча выпадет из проверки. Сверяем с честным
    # пересчётом по всему дереву файла: разошлось — сломана привязка, а не код.
    total = sum(1 for node in iter_nodes(ast) if occurrence_form(node) is not None)
    if total != len(occurrences):
        unattached = total - len(occurrences)
        raise ParseError(
            f"{relpath}: {unattached} обращений к msg.sender/caller() не удалось привязать\n"
            f"  к функции или модификатору (всего в файле {total}, привязано {len(occurrences)}).\n"
            "  Такое обращение лежит вне тела функции — например, в инициализаторе\n"
            "  state-переменной или в свободной функции. Гейт не умеет их адресовать\n"
            "  и не станет молча пропускать."
        )

    return defines, occurrences


def summarize(occurrences: list[Occurrence], key_of) -> dict[str, dict]:
    """Сводка обращений: {ключ: {count, lines, forms}}. `key_of` решает, что
    считать ключом — функцию (проверяемые файлы) или файл целиком (записи
    «вне области»)."""
    summary: dict[str, dict] = {}
    for occ in occurrences:
        entry = summary.setdefault(key_of(occ), {"count": 0, "lines": [], "forms": set()})
        entry["count"] += 1
        entry["lines"].append(occ.line)
        entry["forms"].add(occ.form)
    for entry in summary.values():
        entry["lines"].sort()
    return summary


def collect() -> tuple[dict[str, dict], set[str], set[str], dict[str, dict]]:
    """Возвращает (сводка обращений по функциям ERC-2771-файлов,
    множество ERC-2771-файлов, множество всех .sol в src/,
    сводка обращений по файлам ВНЕ области — по файлу целиком)."""
    asts = load_asts()

    per_file_defines: dict[str, bool] = {}
    per_file_occ: dict[str, list[Occurrence]] = {}

    for relpath, ast in asts.items():
        source = (REPO_ROOT / relpath).read_bytes()
        defines, occ = scan_file(relpath, ast, source)
        per_file_defines[relpath] = defines
        per_file_occ[relpath] = occ

    erc2771 = {p for p, d in per_file_defines.items() if d}

    lost = sorted(set(KNOWN_ERC2771_FILES) - erc2771)
    if lost:
        raise ParseError(
            "автопоиск ERC-2771-файлов не нашёл `function _msgSender()` в:\n  "
            + "\n  ".join(lost)
            + "\n\nЭто известные гейслесс-контракты (KNOWN_ERC2771_FILES). Либо в них\n"
            "правда не осталось _msgSender (тогда правило переехало и список надо\n"
            "править осознанно), либо сломался обход дерева."
        )

    flat: list[Occurrence] = []
    for relpath in sorted(erc2771):
        flat.extend(per_file_occ[relpath])

    if not flat:
        raise ParseError(
            "в ERC-2771-файлах не найдено ни одного обращения к msg.sender.\n"
            "Так не бывает: тело самого _msgSender() обязано его содержать в\n"
            "каждом из пяти файлов. Сломан обход дерева или формат AST."
        )

    summary = summarize(flat, lambda occ: occ.key)

    # Файлы вне области считаются тем же механизмом, только ключ — сам файл.
    # Пустая сводка тут не «нет данных», а факт: в файле нет ни одного сырого
    # обращения. Такие файлы обязаны получить запись с `occurrences: 0`, иначе
    # утверждение «отправителя не читает нигде» осталось бы непроверяемым, —
    # поэтому ключи заводятся на ВСЕ файлы вне области, а не только на те, где
    # что-то нашлось.
    scope_flat: list[Occurrence] = []
    for relpath in sorted(set(asts) - erc2771):
        scope_flat.extend(per_file_occ[relpath])
    scope_summary = summarize(scope_flat, lambda occ: occ.relpath)
    for relpath in set(asts) - erc2771:
        scope_summary.setdefault(relpath, {"count": 0, "lines": [], "forms": set()})

    return summary, erc2771, set(asts), scope_summary


# --------------------------------------------------------------------------
# Allow-файл


ALLOW_HEADER = """\
# Реестр функций, которым сырой msg.sender разрешён.
#
# Проверяет: ./script/check-gasless-sender.sh
# Правило:   в файле, реализующем ERC-2771, отправителя берут через _msgSender().
#            Прочитал msg.sender — получил адрес форвардера, а не человека.
#
# Это НЕ свалка подавленных предупреждений, а запись принятых решений. Каждая
# запись обязана содержать строку, начинающуюся дословно с
#
#     не гейслесс, потому что: ...
#
# Без неё гейт считает файл повреждённым и падает. Формат неудобен намеренно:
# внести исключение нельзя, не сказав вслух, почему эта функция намеренно не
# гейслесс. Причина продолжается на следующих строках, пока не начнётся
# следующая запись.
#
# `occurrences:` — сколько сырых обращений в теле. Число пиннится, чтобы
# однажды разрешённая функция не стала дырой: новый msg.sender, дописанный в
# уже внесённое тело, изменит счёт и уронит гейт.
#
# Записи вида `вне области :: <путь>` — второй род: файл src/, который правило
# не касается вовсе. Они нужны потому, что автопоиск гейслесс-файлов идёт по
# наличию _msgSender, а фасет, который правила не выучил, его и не заведёт —
# и стал бы для гейта невидимым. Каждый .sol в src/ обязан быть либо ERC-2771,
# либо явно исключён; файл, не отнесённый никуда, валит гейт.
#
# У записей «вне области» `occurrences:` тоже обязателен и считается по файлу
# целиком (функций внутри гейт не разбирает — ключ у записи файл). Без него
# исключённый файл был бы дырой того же класса, что и разрешённая функция без
# счёта: новую пользовательскую функцию с сырым msg.sender можно было бы
# дописать в ReputationFacet или Treasury, и гейт остался бы зелёным.
# Ноль — законное и осмысленное значение: он пиннит утверждение «отправителя
# этот файл не читает нигде».
#
# Заготовку новой записи (без причины) печатает
#     python3 script/check_gasless_sender.py --print
"""


def format_allow(summary: dict[str, dict], scope_summary: dict[str, dict]) -> str:
    parts = [ALLOW_HEADER]
    for key in sorted(summary):
        parts.append(f"=== {key} ===")
        parts.append(f"occurrences: {summary[key]['count']}")
        parts.append(f"{REASON_MARKER} ЗАПОЛНИТЬ (строки: {', '.join(str(n) for n in summary[key]['lines'])})")
        parts.append("")
    for relpath in sorted(scope_summary):
        entry = scope_summary[relpath]
        lines = ", ".join(str(n) for n in entry["lines"]) or "нет"
        parts.append(f"=== {OUT_OF_SCOPE_PREFIX}{relpath} ===")
        parts.append(f"occurrences: {entry['count']}")
        parts.append(f"{REASON_MARKER} ЗАПОЛНИТЬ (строки: {lines})")
        parts.append("")
    return "\n".join(parts).rstrip() + "\n"


def parse_allow(text: str) -> tuple[dict[str, dict], dict[str, dict]]:
    """Возвращает (записи про функции, записи про файлы вне области)."""
    entries: dict[str, dict] = {}
    key = None

    for lineno, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("===") and line.endswith("==="):
            key = line[3:-3].strip()
            if not key:
                raise ParseError(f"строка {lineno}: пустой заголовок записи")
            if key in entries:
                raise ParseError(f"строка {lineno}: запись {key!r} встречается дважды")
            entries[key] = {"count": None, "reason": "", "lineno": lineno}
            continue
        if key is None:
            raise ParseError(f"строка {lineno}: данные до первого заголовка записи: {raw!r}")

        if line.startswith("occurrences:"):
            if entries[key]["count"] is not None:
                raise ParseError(f"строка {lineno}: у записи {key!r} два поля occurrences")
            value = line[len("occurrences:"):].strip()
            if not value.isdigit():
                raise ParseError(f"строка {lineno}: occurrences у {key!r} — не число: {value!r}")
            entries[key]["count"] = int(value)
            continue

        if line.startswith(REASON_MARKER):
            if entries[key]["reason"]:
                raise ParseError(f"строка {lineno}: у записи {key!r} две причины")
            entries[key]["reason"] = line[len(REASON_MARKER):].strip()
            continue

        # Продолжение причины.
        if entries[key]["reason"]:
            entries[key]["reason"] += " " + line
            continue

        raise ParseError(
            f"строка {lineno}: непонятная строка в записи {key!r}: {raw!r}\n"
            f"  Ожидались `occurrences: N` и строка, начинающаяся с «{REASON_MARKER}»."
        )

    functions: dict[str, dict] = {}
    out_of_scope: dict[str, dict] = {}

    for key, entry in entries.items():
        is_scope_entry = key.startswith(OUT_OF_SCOPE_PREFIX)
        if entry["count"] is None:
            # Счёт обязателен у обоих родов записей. У функции он пиннит тело,
            # у файла вне области — весь файл; без него исключение превращается
            # в бессрочное разрешение дописывать сырой msg.sender.
            raise ParseError(f"у записи {key!r} (строка {entry['lineno']}) нет поля `occurrences:`")
        if is_scope_entry:
            out_of_scope[key[len(OUT_OF_SCOPE_PREFIX):]] = entry
        else:
            functions[key] = entry
        reason = entry["reason"]
        if not reason:
            raise ParseError(
                f"у записи {key!r} (строка {entry['lineno']}) нет причины.\n"
                f"  Добавьте строку «{REASON_MARKER} ...» — исключение без объяснения\n"
                f"  это подавленное предупреждение, а не принятое решение."
            )
        for bad in PLACEHOLDERS:
            if bad in reason:
                raise ParseError(
                    f"причина записи {key!r} (строка {entry['lineno']}) содержит заглушку {bad!r}.\n"
                    f"  Заготовку надо дописать словами, а не оставить как есть."
                )
        if len(reason) < MIN_REASON_CHARS:
            raise ParseError(
                f"причина записи {key!r} (строка {entry['lineno']}) короче {MIN_REASON_CHARS} символов: {reason!r}\n"
                f"  Причина должна объяснять, почему функция намеренно не гейслесс."
            )

    return functions, out_of_scope


# --------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    mode = argv[1] if len(argv) > 1 else "--check"
    if mode not in ("--check", "--print", ""):
        print(f"check-gasless-sender: неизвестный режим {mode!r}", file=sys.stderr)
        return 2

    try:
        summary, erc2771, all_files, scope_summary = collect()
    except ParseError as exc:
        print("check-gasless-sender: РАЗБОР НЕ СОСТОЯЛСЯ — правило НЕ проверено:", file=sys.stderr)
        print(f"  {exc}", file=sys.stderr)
        print(
            "\n  Это не «нарушений нет». Пока дерево не разобрано, гейт ничего\n"
            "  не знает про msg.sender в гейслесс-контрактах.",
            file=sys.stderr,
        )
        return 3

    if mode == "--print":
        sys.stdout.write(format_allow(summary, scope_summary))
        return 0

    if not ALLOW_PATH.exists() or not ALLOW_PATH.read_text(encoding="utf-8").strip():
        print(f"check-gasless-sender: {ALLOW_PATH} отсутствует или пуст.", file=sys.stderr)
        print(
            "  Сравнивать не с чем — это не «чисто». Заготовку печатает\n"
            "  python3 script/check_gasless_sender.py --print, причины дописываются руками.",
            file=sys.stderr,
        )
        return 2

    try:
        allowed, out_of_scope = parse_allow(ALLOW_PATH.read_text(encoding="utf-8"))
    except ParseError as exc:
        print(f"check-gasless-sender: {ALLOW_PATH} повреждён — сравнивать не с чем:", file=sys.stderr)
        print(f"  {exc}", file=sys.stderr)
        return 2

    unexplained = sorted(set(summary) - set(allowed))
    stale = sorted(set(allowed) - set(summary))
    drifted = sorted(
        key for key in set(summary) & set(allowed) if summary[key]["count"] != allowed[key]["count"]
    )

    # Область проверки закрыта целиком: каждый .sol в src/ — либо ERC-2771,
    # либо явно исключён.
    unclassified = sorted(all_files - erc2771 - set(out_of_scope))
    contradicted = sorted(set(out_of_scope) & erc2771)
    ghost_scope = sorted(set(out_of_scope) - all_files)

    # Счёт по файлам вне области — та же проверка на дрейф, что у функций,
    # только ключ файл. Она и закрывает вторую половину области: без неё в
    # исключённый файл можно дописать пользовательскую функцию с сырым
    # msg.sender, ничего не тронув в allow-файле.
    scope_drifted = sorted(
        relpath
        for relpath in set(scope_summary) & set(out_of_scope)
        if scope_summary[relpath]["count"] != out_of_scope[relpath]["count"]
    )

    if not any((unexplained, stale, drifted, unclassified, contradicted, ghost_scope, scope_drifted)):
        total = sum(e["count"] for e in summary.values())
        scope_total = sum(e["count"] for e in scope_summary.values())
        print(
            f"check-gasless-sender: ок — все {total} сырых обращений к msg.sender "
            f"в {len(summary)} функциях объяснены в script/gasless-sender.allow"
        )
        print(
            f"  область закрыта: {len(erc2771)} ERC-2771-файлов проверено, "
            f"{len(out_of_scope)} явно исключено, всего {len(all_files)} в src/"
        )
        print(
            f"  в исключённых файлах под счётчиком ещё {scope_total} обращений — "
            f"дописать туда новое, не тронув allow-файл, нельзя"
        )
        return 0

    print("check-gasless-sender: ПРАВИЛО ERC-2771 НАРУШЕНО", file=sys.stderr)
    print("", file=sys.stderr)

    if unexplained:
        print(
            "Сырой msg.sender без записи в script/gasless-sender.allow:",
            file=sys.stderr,
        )
        for key in unexplained:
            entry = summary[key]
            lines = ", ".join(str(n) for n in entry["lines"])
            forms = "/".join(sorted(entry["forms"]))
            print(f"  - {key}  ({forms} x{entry['count']}, строки: {lines})", file=sys.stderr)
        print(
            "\n  Транзакцию отправляет релеер, человек приезжает в хвосте calldata\n"
            "  по ERC-2771. msg.sender на этом пути — адрес MinimalForwarder.\n"
            "  Если функция вызывается человеком: `address caller = _msgSender();`\n"
            "  и дальше caller везде вместо msg.sender. Доказательство фикса —\n"
            "  тест через настоящий форвардер, краснеющий на неисправленном коде\n"
            "  (образец: test/DisputeSettlement.t.sol,\n"
            "  testFundDisputeThroughForwarderIsPaidByTheHuman).\n"
            "  Если функция намеренно НЕ гейслесс (владельческая, вызов\n"
            "  контракт-контракт, разбор calldata) — записать её в\n"
            "  script/gasless-sender.allow вместе с причиной.",
            file=sys.stderr,
        )

    if drifted:
        print("", file=sys.stderr)
        print("У разрешённых функций изменилось число сырых обращений:", file=sys.stderr)
        for key in drifted:
            was = allowed[key]["count"]
            now = summary[key]["count"]
            lines = ", ".join(str(n) for n in summary[key]["lines"])
            print(f"  - {key}: было {was}, стало {now} (строки: {lines})", file=sys.stderr)
        print(
            "\n  Разрешение выдавалось конкретному телу функции, а не её имени.\n"
            "  Новое обращение внутри уже разрешённой функции проходит ревью так же,\n"
            "  как в любой другой: убедиться, что оно законно, и поправить\n"
            "  occurrences в записи (причину — если она изменилась).",
            file=sys.stderr,
        )

    if stale:
        print("", file=sys.stderr)
        print("Записи в allow-файле, которым в коде ничего не соответствует:", file=sys.stderr)
        for key in stale:
            print(f"  - {key}", file=sys.stderr)
        print(
            "\n  Функцию переименовали, удалили или в ней больше нет сырого\n"
            "  msg.sender — запись протухла, её надо убрать. Если функция на месте,\n"
            "  значит сломался обход дерева, и правило НЕ проверено.",
            file=sys.stderr,
        )

    if unclassified:
        print("", file=sys.stderr)
        print("Файлы src/, не отнесённые ни к одной категории:", file=sys.stderr)
        for relpath in unclassified:
            print(f"  - {relpath}", file=sys.stderr)
        print(
            "\n  Гейслесс-контракты гейт находит по наличию `function _msgSender()`,\n"
            "  и в этом его слабое место: фасет, который правила не выучил, его и\n"
            "  не заведёт. Ровно так пропустили ReputationFacet.claimXP — там сырой\n"
            "  msg.sender в пользовательской функции, а _msgSender в фасете нет вовсе.\n"
            "  Поэтому решение принимается на каждый файл: либо контракт становится\n"
            "  ERC-2771 (заводит _msgSender и читает отправителя через него), либо\n"
            "  в script/gasless-sender.allow появляется запись\n"
            f"  «=== {OUT_OF_SCOPE_PREFIX}<путь> ===» с причиной.",
            file=sys.stderr,
        )

    if contradicted:
        print("", file=sys.stderr)
        print("Файлы, помеченные «вне области», но реализующие ERC-2771:", file=sys.stderr)
        for relpath in contradicted:
            print(f"  - {relpath}", file=sys.stderr)
        print(
            "\n  В файле появился _msgSender — значит он стал гейслесс, и его функции\n"
            "  обязаны проверяться. Снять запись «вне области» и разобрать файл\n"
            "  по функциям.",
            file=sys.stderr,
        )

    if ghost_scope:
        print("", file=sys.stderr)
        print("Записи «вне области» на файлы, которых в src/ нет:", file=sys.stderr)
        for relpath in ghost_scope:
            print(f"  - {relpath}", file=sys.stderr)
        print("\n  Файл удалён или переименован — запись протухла, убрать.", file=sys.stderr)

    if scope_drifted:
        print("", file=sys.stderr)
        print("У файлов «вне области» изменилось число сырых обращений:", file=sys.stderr)
        for relpath in scope_drifted:
            was = out_of_scope[relpath]["count"]
            now = scope_summary[relpath]["count"]
            lines = ", ".join(str(n) for n in scope_summary[relpath]["lines"]) or "нет"
            print(f"  - {relpath}: было {was}, стало {now} (строки: {lines})", file=sys.stderr)
        print(
            "\n  «Вне области» — утверждение про СЕГОДНЯШНЕЕ содержимое файла, а не\n"
            "  бессрочная индульгенция. Причина в записи объясняет каждое из тогдашних\n"
            "  обращений (колбэк от Agreement, onlyOwner, вызов контракт-контракт);\n"
            "  новое обращение под неё не подпадает автоматически.\n"
            "  Если дописана пользовательская функция — она обязана читать отправителя\n"
            "  через _msgSender(), а файл тем самым переезжает в ERC-2771 и запись\n"
            "  «вне области» снимается. Если обращение того же рода, что уже описаны, —\n"
            "  поправить occurrences и дополнить причину.",
            file=sys.stderr,
        )

    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
