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
  • `d.arbiterBond[кто]++` и `--d.arbiterBond[кто]`         → ненулевая запись
    (Ф-1/Ф-2 переревью: `++` увеличивает залог ровно как `+=`, а первая
    редакция разбирала `UnaryOperation` только ради `delete` и молчала)
  • кортеж: `(d.arbiterBond[кто], x) = (…, …)`              → ненулевая запись,
    кроме случая «справа кортеж той же длины и на нашей позиции литеральный
    ноль» (Ф-4 переревью: слева тут TupleExpression, а не IndexAccess)
  • оператор `=` с литеральным нулём справа                 → НУЛЕВАЯ, не в счёт
  • `delete d.arbiterBond[кто]`                             → НУЛЕВАЯ, не в счёт

Чтения (`uint256 x = d.arbiterBond[кто]`, возврат из геттера) не считаются
вовсе: гейт про то, кто НАЗНАЧАЕТ залог, а не про то, кто его видит.

---------------------------------------------------------------------------
ПСЕВДОНИМ ХРАНИЛИЩА — ОТСЛЕЖИВАЕТСЯ (Ф-1 ревью, 17 августа 2026)

Первая редакция смотрела только на `d.arbiterBond[кто] = …` и была слепа к

    mapping(address => uint256) storage bonds = d.arbiterBond;
    bonds[кто] = ARBITER_BOND;                  // настоящая запись, банк растёт

Гейт при этом отвечал `exit 0` и «писатель ровно один». Обход не выдуманный:
идиома `X storage v = d.…` живёт в том же фасете восемь раз подряд
(`PendingVerdict storage v = d.pendingVerdicts[…]`), и двухшаговый залог
естественнее всего написать именно так — то есть возле замка лежали восемь
готовых калиток.

Теперь внутри каждой функции строится множество ЛОКАЛЬНЫХ УКАЗАТЕЛЕЙ на это
поле, до неподвижной точки:

  • `mapping(...) storage x = d.arbiterBond;`         — x становится псевдонимом
  • `mapping(...) storage y = x;`                     — и y тоже (цепочка)
  • `x = d.arbiterBond;` (переприсваивание указателя)  — тоже

и `x[кто] = …` считается записью наравне с `d.arbiterBond[кто] = …`.
Указатель на СТРУКТУРУ (`Data storage d = …data()`) отдельно отслеживать не
нужно: `d.arbiterBond` — это тот же MemberAccess, он ловился всегда.

---------------------------------------------------------------------------
ССЫЛКА, УТЕКШАЯ КУДА-ТО ЕЩЁ — КРАСНОЕ, А НЕ МОЛЧАНИЕ

Голая `d.arbiterBond` (не под индексом и не в связывании псевдонима) означает,
что поле уехало туда, куда разбор не идёт: аргументом в другую функцию
(`function f(mapping(address => uint256) storage m)` и `m[кто] = …` внутри),
возвратом storage-указателя наружу, в кортеж. Гейт такие места ВЫДАЁТ КАК
НАРУШЕНИЕ, а не пропускает: молчание тут означало бы «покрытие шире, чем на
самом деле» — ровно тот дефект, ради которого гейт и написан. Сегодня таких
мест в src/ ноль.

То же самое — про ГОЛЫЙ ПСЕВДОНИМ (Ф-5 переревью, 17 августа 2026). Первая
редакция искала здесь только узлы `MemberAccess`, а в

    mapping(address => uint256) storage bonds = d.arbiterBond;
    _grant(bonds, кто);                          // запись живёт внутри _grant

аргументом стоит `Identifier`. Гейт печатал «ссылка на поле никуда не
утекает» — утверждение, ОБРАТНОЕ истине, и это хуже молчания: молчание никого
не убеждает, а такая строка убеждает. Теперь голый псевдоним красит наравне с
голым полем.

---------------------------------------------------------------------------
КУДА ЭТО ПРАВИЛО НЕЛЬЗЯ КОПИРОВАТЬ — ЗАМЕРЕНО, А НЕ ПРИКИНУТО

Замер 17 августа 2026: правило «голая ссылка = красное» прогнано по КАЖДОМУ
полю-состоянию в src/, поимённо.

  • **Поля-отображения: 77 штук, 0 красных мест.** К мэппингу обращаются только
    по ключу, голой ссылки на него в рабочем коде не встречается вовсе. То есть
    работе гейт не мешает — это не удача `arbiterBond`, а свойство идиомы.

  • **Поля-массивы: 5 штук, 35 красных мест.** `.push`, `.length`, `.pop` — это
    как раз `MemberAccess` по голой ссылке, а не `IndexAccess`. Скопировать
    гейт на `arbiterList` НЕЛЬЗЯ: он покраснеет на исправном коде в первый же
    прогон, и его отключат. Массиву нужна другая разметка законных обращений.

  • **⚠️ И третье, менее очевидное: мэппинг НА СТРУКТУРУ.** Ветка псевдонимов
    (выше) считает псевдонимом всякий локальный storage-указатель, чей
    инициализатор упоминает поле, — а `PendingVerdict storage v =
    d.pendingVerdicts[спор];` это ровно он. После чего КАЖДОЕ чтение `v.поле`
    — голый псевдоним, то есть красное. Замер по тому же прогону: с веткой
    псевдонимов те же 77 мэппингов дают уже **201** красное место, и все 201
    сидят на мэппингах со структурой в значении (`pendingVerdicts` 72, `jobs`
    29, `requests` 31, `services` 31, …).

    `arbiterBond` от этого защищён не проверкой, а ТИПОМ: значение `uint256`,
    а локальным storage-указателем на `uint256`-элемент в Solidity быть
    нечему. Значит гейт годен для мэппингов с ЗНАЧЕНИЕМ-ЗНАЧИМЫМ ТИПОМ и не
    годен для мэппингов на структуру — до тех пор, пока `collect_aliases` не
    научится отличать указатель на САМО ПОЛЕ от указателя на его ЭЛЕМЕНТ.

---------------------------------------------------------------------------
ЧЕГО ГЕЙТ НЕ ЛОВИТ — СКАЗАНО ВСЛУХ

  • Запись через ассемблерный `sstore` по вычисленному слоту. В src/ такого
    нет ни разу (ассемблер здесь только в `data()`-адресации неймспейсов и в
    `_msgSender`), но гейт этого не проверяет и обещать не станет.
  • МЕЖПРОЦЕДУРНЫЙ путь: `arbiterBond`, переданная storage-указателем в другую
    функцию, разбором НЕ прослеживается. Не молчим — см. абзац выше: такое
    место гейт красит, называя его «ссылка утекла». То есть непокрытый случай
    превращён в отказ анализировать, а не в зелёный.
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
    0   — ненулевой писатель ровно один и он тот, что записан ниже, и ни одна
          ссылка на поле не утекла из-под разбора
    1   — писателей стало больше/меньше, это не тот писатель, ИЛИ ссылка на
          поле (либо локальный указатель на него) утекла туда, куда разбор не
          идёт: покрытие в этом месте меньше обещанного
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


def is_alias_id(node, aliases=()) -> bool:
    """`x`, где `x` — локальный storage-указатель на это поле."""
    return (
        isinstance(node, dict)
        and node.get("nodeType") == "Identifier"
        and node.get("referencedDeclaration") in aliases
    )


def is_field_slot(node, aliases=()) -> bool:
    """Левая часть присваивания вида `d.arbiterBond[кто]` — или `x[кто]`, где
    `x` локальный storage-указатель на то же поле.

    Проверяется именно IndexAccess: присвоение самому отображению в Solidity
    невозможно, а обращение по ключу — единственная форма записи в него.
    """
    if not isinstance(node, dict) or node.get("nodeType") != "IndexAccess":
        return False
    base = node.get("baseExpression")
    if not isinstance(base, dict):
        return False
    return touches_field(base) or is_alias_id(base, aliases)


def through_alias(slot) -> str:
    """Пометка для сообщения: место найдено по псевдониму, а не по
    `d.arbiterBond[…]` напрямую."""
    if not isinstance(slot, dict):
        return " через псевдоним"
    return "" if touches_field(slot.get("baseExpression") or {}) else " через псевдоним"


def is_storage_pointer_decl(node) -> bool:
    return (
        isinstance(node, dict)
        and node.get("nodeType") == "VariableDeclaration"
        and node.get("storageLocation") == "storage"
    )


def _mentions_field_or_alias(node, aliases) -> bool:
    """В поддереве есть `…​.arbiterBond` или ссылка на уже известный псевдоним."""
    for n in iter_nodes(node):
        if touches_field(n):
            return True
        if n.get("nodeType") == "Identifier" and n.get("referencedDeclaration") in aliases:
            return True
    return False


def collect_aliases(member) -> set:
    """Локальные storage-указатели на `arbiterBond` внутри одной функции.

    До неподвижной точки, чтобы ловились цепочки (`y = x;` после
    `x = d.arbiterBond;`). Переприсваивание указателя учитывается наравне с
    объявлением: `x` в Solidity можно перенаправить внутри той же функции.

    Указатель на СТРУКТУРУ (`Data storage d = …data()`) сюда не попадает и не
    должен: `d.arbiterBond` — обычный MemberAccess, он ловился всегда.
    """
    aliases: set = set()
    while True:
        grew = False
        for node in iter_nodes(member):
            ntype = node.get("nodeType")

            if ntype == "VariableDeclarationStatement":
                init = node.get("initialValue")
                if init is None or not _mentions_field_or_alias(init, aliases):
                    continue
                for decl in node.get("declarations") or []:
                    if is_storage_pointer_decl(decl) and decl.get("id") not in aliases:
                        aliases.add(decl["id"])
                        grew = True

            elif ntype == "Assignment" and (node.get("operator") or "=") == "=":
                lhs = node.get("leftHandSide")
                if not isinstance(lhs, dict) or lhs.get("nodeType") != "Identifier":
                    continue
                ref = lhs.get("referencedDeclaration")
                if ref is None or ref in aliases:
                    continue
                rhs = node.get("rightHandSide")
                if rhs is not None and _mentions_field_or_alias(rhs, aliases):
                    aliases.add(ref)
                    grew = True

        if not grew:
            return aliases


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
        self.kind = kind      # "nonzero" | "zero" | "escape"
        self.text = text

    @property
    def key(self) -> str:
        return f"{self.relpath} :: {self.contract}.{self.member}"


def classify_tuple(lhs, rhs, op, aliases):
    """Кортежное присваивание: `(d.arbiterBond[кто], x) = (…, …)`.

    Слева тут стоит TupleExpression, а не IndexAccess, — первая редакция такое
    место не видела ВОВСЕ и отвечала `exit 0`.

    Нулевой запись засчитывается только когда справа тоже кортеж той же длины и
    на нашей позиции стоит литеральный ноль. Во всех прочих случаях (распаковка
    возврата функции, кортеж иной длины) — «ненулевая»: громкое красное здесь
    дешевле молчания, а живых кортежных записей в поле сегодня ноль.
    """
    comps = lhs.get("components") or []
    rcomps = (
        rhs.get("components") or []
        if isinstance(rhs, dict) and rhs.get("nodeType") == "TupleExpression"
        else []
    )
    verdict = None
    for i, comp in enumerate(comps):
        if not is_field_slot(comp, aliases):
            continue
        through = through_alias(comp)
        paired = rcomps[i] if len(rcomps) == len(comps) else None
        if op == "=" and paired is not None and is_literal_zero(paired):
            verdict = verdict or ("zero", f"в кортеже = 0{through}")
        else:
            return "nonzero", f"в кортеже = <не ноль>{through}"
    return verdict


def classify(node, aliases=()):
    """Возвращает ("nonzero"|"zero", описание) или None, если узел не запись."""
    ntype = node.get("nodeType")

    if ntype == "Assignment":
        lhs = node.get("leftHandSide")
        op = node.get("operator") or "="
        if isinstance(lhs, dict) and lhs.get("nodeType") == "TupleExpression":
            return classify_tuple(lhs, node.get("rightHandSide"), op, aliases)
        if not is_field_slot(lhs, aliases):
            return None
        through = through_alias(lhs)
        if op != "=":
            return "nonzero", f"составной оператор {op}{through}"
        if is_literal_zero(node.get("rightHandSide")):
            return "zero", f"= 0{through}"
        return "nonzero", f"= <не ноль>{through}"

    if ntype == "UnaryOperation":
        sub = node.get("subExpression")
        if not is_field_slot(sub, aliases):
            return None
        op = node.get("operator")
        through = through_alias(sub)
        if op == "delete":
            return "zero", f"delete{through}"
        # `d.arbiterBond[кто]++` и `--d.arbiterBond[кто]` — настоящие записи,
        # и `++` увеличивает залог ровно так же, как `+=`. Прочие унарные
        # (`!`, `~`, унарный минус) значения не меняют — это чтения.
        if op in ("++", "--"):
            return "nonzero", f"{op}{through}"
        return None

    return None


def find_escapes(member, aliases, relpath, cname, mname, starts):
    """Места, где `arbiterBond` — ИЛИ ЛОКАЛЬНЫЙ УКАЗАТЕЛЬ НА НЕЁ — упомянуты НЕ
    под индексом и НЕ как связывание псевдонима: то есть ссылка уехала туда,
    куда разбор не идёт.

    Такое место гейт красит, а не пропускает: аргумент storage-указателем в
    чужую функцию (`f(d.arbiterBond)` и `m[кто] = …` внутри неё) — настоящий
    путь записи, и молчать о нём значило бы обещать покрытие шире фактического.

    ⚠️ ПСЕВДОНИМ ТОЖЕ УТЕКАЕТ (Ф-5 переревью, 17 августа 2026). Первая редакция
    искала только узлы `MemberAccess`, а в `_grant(bonds)` стоит `Identifier`, —
    и гейт печатал «ссылка на поле никуда не утекает» ровно тогда, когда она
    утекла. Утверждение, обратное истине, хуже молчания: молчание не убеждает.
    """
    ok_ids = set()
    for node in iter_nodes(member):
        ntype = node.get("nodeType")

        # `d.arbiterBond[кто]` и `x[кто]` — законное обращение по ключу.
        if ntype == "IndexAccess":
            base = node.get("baseExpression")
            if isinstance(base, dict) and (touches_field(base) or is_alias_id(base, aliases)):
                ok_ids.add(id(base))

        # `mapping(...) storage x = d.arbiterBond;` (или `= y;`) — законное связывание.
        elif ntype == "VariableDeclarationStatement":
            init = node.get("initialValue")
            if (
                isinstance(init, dict)
                and (touches_field(init) or is_alias_id(init, aliases))
                and any(
                    is_storage_pointer_decl(dcl) and dcl.get("id") in aliases
                    for dcl in node.get("declarations") or []
                )
            ):
                ok_ids.add(id(init))

        # `x = d.arbiterBond;` / `x = y;` — переприсваивание уже признанного указателя.
        elif ntype == "Assignment" and (node.get("operator") or "=") == "=":
            lhs, rhs = node.get("leftHandSide"), node.get("rightHandSide")
            if is_alias_id(lhs, aliases):
                ok_ids.add(id(lhs))  # цель присваивания — не утечка
                if isinstance(rhs, dict) and (touches_field(rhs) or is_alias_id(rhs, aliases)):
                    ok_ids.add(id(rhs))

    out = []
    for node in iter_nodes(member):
        if id(node) in ok_ids:
            continue
        if touches_field(node):
            what = "ссылка на поле утекла из-под разбора"
        elif is_alias_id(node, aliases):
            what = "псевдоним поля утёк из-под разбора"
        else:
            continue
        out.append(
            Write(relpath, cname, mname, line_of(starts, src_offset(node)), "escape", what)
        )
    return out


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
                # Псевдонимы считаются ПОФУНКЦИОННО: storage-указатель — это
                # локальная переменная, и её область видимости кончается вместе
                # с телом. Общее множество на файл смешало бы разные функции.
                aliases = collect_aliases(member)
                for node in iter_nodes(member):
                    verdict = classify(node, aliases)
                    if verdict is None:
                        continue
                    kind, text = verdict
                    attached += 1
                    writes.append(
                        Write(relpath, cname, mname, line_of(starts, src_offset(node)), kind, text)
                    )
                writes.extend(find_escapes(member, aliases, relpath, cname, mname, starts))

        # Та же сверка привязки, что в гейте гейслесса: запись, лежащая вне
        # тела функции (инициализатор state-переменной, свободная функция),
        # молча выпала бы из проверки.
        #
        # Считается БЕЗ псевдонимов (их область видимости — тело функции,
        # которого здесь нет): это нижняя граница, и её достаточно — запись
        # вне функции по определению не может ходить через локальный указатель.
        total = sum(1 for node in iter_nodes(ast) if classify(node) is not None)
        if total > attached:
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
    escapes = [w for w in writes if w.kind == "escape"]

    if "--print" in argv:
        print(f"Упоминаний `{FIELD}` в src/: {mentions}")
        print(f"Ненулевых записей: {len(nonzero)}")
        for w in nonzero:
            print(f"  {w.key}  ({w.relpath.split('/')[-1]}:{w.line}, {w.text})")
        print(f"Нулевых записей (в счёт не идут): {len(zero)}")
        for w in zero:
            print(f"  {w.key}  ({w.relpath.split('/')[-1]}:{w.line}, {w.text})")
        print(f"Утёкших ссылок на поле: {len(escapes)}")
        for w in escapes:
            print(f"  {w.key}  ({w.relpath.split('/')[-1]}:{w.line})")
        return 0

    found = {}
    for w in nonzero:
        found.setdefault(w.key, []).append(w)

    expected = set(EXPECTED_NONZERO_WRITERS)
    unexpected = sorted(set(found) - expected)
    vanished = sorted(expected - set(found))

    if not unexpected and not vanished and not escapes:
        print(
            f"check-arbiter-bond-writers: ненулевую запись в `{FIELD}` делает "
            f"ровно одна функция — {', '.join(sorted(found))}. "
            f"Нулевых записей {len(zero)}, они не в счёт; ссылка на поле никуда "
            f"не утекает."
        )
        return 0

    print("check-arbiter-bond-writers: КРАСНЫЙ", file=sys.stderr)
    print(file=sys.stderr)

    for w in escapes:
        print(
            f"  {w.text.upper()}: {w.key}\n"
            f"    {w.relpath}:{w.line}\n"
            f"    `{FIELD}` (или локальный указатель на неё) упомянута не под\n"
            "    индексом и не как связывание storage-указателя — значит уехала\n"
            "    аргументом в чужую функцию, возвратом или в кортеж. Куда именно,\n"
            "    разбор не идёт, и запись там он не увидит. Это не запрет: либо\n"
            "    перепишите обращение прямым `d.arbiterBond[кто]`, либо научите\n"
            "    гейт этому случаю.",
            file=sys.stderr,
        )

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
