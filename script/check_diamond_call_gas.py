#!/usr/bin/env python3
"""
Гейт правила «обращение из Agreement наружу идёт под газ-капом».

ПОЧЕМУ ЭТО ГЕЙТ, А НЕ КОММЕНТАРИЙ

Каждая сделка Hexseal — клон EIP-1167 контракта Agreement, и деньги лежат в
клоне. Диамонд ему нужен как реестр, репутация и арбитраж, то есть как
СБОКУ стоящая служба, отказ которой не должен запирать чужие деньги. Все такие
обращения обёрнуты в try/catch, и до 23 августа 2026 это считалось защитой.

Не считается. try/catch превращает реверт в пойманную неудачу, но НЕ ВОЗВРАЩАЕТ
газ, уже сожжённый вызываемым. По EIP-150 вызываемому уходит 63/64 остатка, а
между Agreement и фасетом стоит ещё кадр прокси, поэтому одно логическое
обращение к диамонду забирает у Agreement примерно 31/32 остатка, если фасет
съедает всё. Замер (docs/audits/2026-08-22-diamond-death-escrow.md, раздел 4):
два таких обращения подряд ПЕРЕД выплатой подняли стоимость автоапрува с
419 481 до 29 791 258 газа — в 71 раз, то есть выше любого разумного лимита
транзакции. Деньги не выходили, и ни один catch этому не мешал.

Лекарство — `{gas: КАП}` на каждом обращении, кап замерен. Правило держится на
одной строке в каждом вызове, а строки теряются: следующая правка допишет
седьмое обращение без капа, компилятор промолчит, тесты пройдут (обычный фасет
газ не жжёт), и дефект вернётся ровно в той же форме. Отсюда гейт.

---------------------------------------------------------------------------
ЧТО СЧИТАЕТСЯ НАРУШЕНИЕМ

В `src/Agreement.sol`: внешний вызов (любой — типизированный через интерфейс
или низкоуровневый `.call`/`.staticcall`/`.delegatecall`), у которого НЕТ ни
опции `{gas: ...}`, ни записи в script/diamond-call-gas.allow.

Плюс инлайн-ассемблер: `call`/`staticcall`/`delegatecall`/`callcode`, первым
аргументом которого стоит `gas()` — то есть «отдать всё».

---------------------------------------------------------------------------
«А ЕСЛИ ЧЕРЕЗ ПЕРЕМЕННУЮ?»  (docs/PROCESS.md, шестой способ обмануться)

Два гейта репозитория уже оказывались слепыми ровно так: сканер узнавал
НАПИСАНИЕ, а не то, на что оно ссылается, и молчал, когда та же запись делалась
через переменную. Поэтому здесь разбирается AST solc, а не текст, и признак
берётся ТИПОВОЙ, а не именной:

  * `ISignatureRegistry(diamond).updateStatus(...)`   — тип получателя
  * `ISignatureRegistry r = ...; r.updateStatus(...)` — тот же тип, тот же вердикт
  * `address d = diamond; d.call(...)`                — низкоуровневый по типу address

Ни одна из трёх форм не опознаётся по слову «diamond»: слова в разборе нет
вообще. Замер, подтверждающий это, — в шапке check-diamond-call-gas.sh.

СЛУЧАЙ, КОТОРЫЙ СКАНЕР РАЗОБРАТЬ НЕ СМОГ, ОБЯЗАН КРАСНЕТЬ. Внешний вызов,
который не удалось отнести ни к одной категории, валит гейт с пометкой
«не классифицирован» — молчать в такой ситуации значит ровно то, ради чего гейт
и писался.

---------------------------------------------------------------------------
ОБЛАСТЬ: ОДИН ФАЙЛ, И ЭТО СКАЗАНО ВСЛУХ

Проверяется только `src/Agreement.sol`. Не потому, что остальные не важны, а
потому, что Agreement — единственный контракт репозитория, который ОДНОВРЕМЕННО
держит чужие деньги на своём балансе и зовёт диамонд снаружи. Фасеты живут
ВНУТРИ диамонда (delegatecall), у них этого шва нет вовсе.

Остаётся `src/Treasury.sol`: он тоже зовёт диамонд снаружи, свой денежный путь
уже читает под капом (`_readDiamondWord` / `DIAMOND_VIEW_GAS`), но три вьюхи
(`getDAOAddress`, `getUniqueActiveUsers`, `getVaultBalance`) зовутся без капа.
Расширение области на него — отдельная работа, заведена пунктом в
docs/OPEN-ITEMS.md. Здесь это записано, а не умолчано.

Внутри своего файла область ЗАКРЫТА: гейт смотрит на все внешние вызовы, а не
на список известных интерфейсов, поэтому новый интерфейс, дописанный завтра,
обязан либо нести кап, либо попасть в allow-файл с причиной.

---------------------------------------------------------------------------
КОДЫ ВОЗВРАТА

  0 — все внешние вызовы под капом или объяснены
  1 — вызов без капа и без записи / изменилось число в разрешённой записи /
      протухшая запись в allow-файле / вызов, который не удалось разобрать
  2 — allow-файл отсутствует, пуст или повреждён (запись без причины)
  3 — разбор не состоялся: нет артефакта с AST, или в файле не нашлось
      известных диамонд-интерфейсов (сломан сам гейт, правило НЕ проверено)
"""

import glob
import json
import os
import sys

TARGET = "src/Agreement.sol"
ALLOW = "script/diamond-call-gas.allow"
REASON_PREFIX = "без капа, потому что:"

# Нижняя граница здравости разбора. Это интерфейсы, через которые Agreement
# ходит в диамонд СЕГОДНЯ. Если их вдруг не находится — сломался разбор, а не
# исчезло правило: молчать в этом случае нельзя (код 3).
KNOWN_DIAMOND_INTERFACES = {
    "contract IReputationFacet",
    "contract IArbiterRegistryFacet",
    "contract ISignatureRegistry",
    "contract IArbiterRegistry",
}

LOW_LEVEL = {"call", "staticcall", "delegatecall", "callcode"}
YUL_CALLS = {"call", "staticcall", "delegatecall", "callcode"}


# --------------------------------------------------------------------------
#  AST
# --------------------------------------------------------------------------

def load_ast(path):
    """AST файла из артефактов forge. Любой контракт файла несёт AST целиком."""
    base = os.path.basename(path)
    for artifact in sorted(glob.glob(f"out/{base}/*.json")):
        try:
            with open(artifact, encoding="utf-8") as fh:
                ast = json.load(fh).get("ast")
        except (OSError, ValueError):
            continue
        if ast and ast.get("absolutePath") == path:
            return ast
    return None


class Finding:
    def __init__(self, contract, function, callee, member, capped, kind, line):
        self.contract = contract
        self.function = function
        self.callee = callee
        self.member = member
        self.capped = capped
        self.kind = kind      # "external" | "lowlevel" | "assembly" | "unclassified"
        self.line = line

    @property
    def key(self):
        return f"{self.contract}.{self.function} :: {self.callee}.{self.member}"


def _line_of(node, src_lines_offsets):
    """Приблизительный номер строки по полю src ('offset:length:file')."""
    try:
        offset = int(str(node.get("src", "")).split(":")[0])
    except (ValueError, IndexError):
        return 0
    lo, hi = 0, len(src_lines_offsets) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if src_lines_offsets[mid] <= offset:
            lo = mid
        else:
            hi = mid - 1
    return lo + 1


def collect(ast, source_text):
    """Все внешние вызовы файла, с контрактом и функцией, в которых они стоят."""
    offsets = [0]
    for ch in source_text:
        offsets.append(offsets[-1] + len(ch.encode("utf-8")))
    line_starts = [0]
    for i, ch in enumerate(source_text):
        if ch == "\n":
            line_starts.append(offsets[i + 1])

    findings = []

    def yul_walk(node, contract, function):
        if isinstance(node, dict):
            if node.get("nodeType") == "YulFunctionCall":
                name = (node.get("functionName") or {}).get("name")
                if name in YUL_CALLS:
                    args = node.get("arguments") or []
                    gas_arg = args[0] if args else None
                    # Первый аргумент — газ. `gas()` означает «отдать всё».
                    unbounded = (
                        isinstance(gas_arg, dict)
                        and gas_arg.get("nodeType") == "YulFunctionCall"
                        and (gas_arg.get("functionName") or {}).get("name") == "gas"
                    )
                    findings.append(Finding(
                        contract, function, "assembly", name,
                        capped=not unbounded, kind="assembly",
                        line=_line_of(node, line_starts),
                    ))
            for value in node.values():
                yul_walk(value, contract, function)
        elif isinstance(node, list):
            for value in node:
                yul_walk(value, contract, function)

    def walk(node, contract, function):
        if isinstance(node, dict):
            nt = node.get("nodeType")
            if nt == "ContractDefinition":
                contract = node.get("name") or contract
            elif nt in ("FunctionDefinition", "ModifierDefinition"):
                function = node.get("name") or ("<constructor>" if node.get("kind") == "constructor" else function)

            if nt == "InlineAssembly":
                yul = node.get("AST")
                if yul is None:
                    findings.append(Finding(
                        contract, function, "assembly", "<unparsed>",
                        capped=False, kind="unclassified",
                        line=_line_of(node, line_starts),
                    ))
                else:
                    yul_walk(yul, contract, function)

            if nt == "FunctionCall" and node.get("kind") == "functionCall":
                expr = node.get("expression") or {}
                capped = False
                inner = expr
                if expr.get("nodeType") == "FunctionCallOptions":
                    capped = "gas" in (expr.get("names") or [])
                    inner = expr.get("expression") or {}
                if inner.get("nodeType") == "MemberAccess":
                    member = inner.get("memberName")
                    fn_type = ((inner.get("typeDescriptions") or {}).get("typeString") or "")
                    base_type = (((inner.get("expression") or {}).get("typeDescriptions") or {})
                                 .get("typeString") or "")
                    line = _line_of(inner, line_starts)
                    if member in LOW_LEVEL and base_type.startswith("address"):
                        findings.append(Finding(contract, function, base_type, member,
                                                capped, "lowlevel", line))
                    elif "external" in fn_type:
                        if not base_type.startswith("contract "):
                            # Внешний вызов, у которого получатель не контрактного
                            # типа. Разобрать нечем — краснеем, а не молчим.
                            findings.append(Finding(contract, function, base_type or "<?>",
                                                    member, capped, "unclassified", line))
                        else:
                            findings.append(Finding(contract, function, base_type, member,
                                                    capped, "external", line))

            for value in node.values():
                walk(value, contract, function)
        elif isinstance(node, list):
            for value in node:
                walk(value, contract, function)

    walk(ast, "<file>", "<top>")
    return findings


# --------------------------------------------------------------------------
#  ALLOW
# --------------------------------------------------------------------------

def parse_allow(path):
    """{key: (count, reason)}. Бросает ValueError на повреждённом файле."""
    if not os.path.exists(path):
        raise ValueError(f"{path} отсутствует")
    entries = {}
    key = None
    count = None
    reason = []
    order = []

    def flush():
        if key is None:
            return
        if count is None:
            raise ValueError(f"запись «{key}» без строки occurrences:")
        text = " ".join(reason).strip()
        if not text.startswith(REASON_PREFIX):
            raise ValueError(
                f"запись «{key}» без причины — она обязана начинаться словами "
                f"«{REASON_PREFIX}»"
            )
        entries[key] = (count, text)
        order.append(key)

    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            if line.startswith("#"):
                continue
            if line.startswith("=== ") and line.endswith(" ==="):
                flush()
                key = line[4:-4].strip()
                count = None
                reason = []
                continue
            if key is None:
                continue
            stripped = line.strip()
            if stripped.startswith("occurrences:"):
                count = int(stripped.split(":", 1)[1].strip())
                continue
            if stripped:
                reason.append(stripped)
    flush()
    if not entries:
        raise ValueError(f"{path} пуст — сравнивать не с чем, это НЕ «чисто»")
    return entries


# --------------------------------------------------------------------------

def main(argv):
    mode = argv[1] if len(argv) > 1 else "--check"

    if not os.path.exists(TARGET):
        print(f"check-diamond-call-gas: {TARGET} не найден — правило НЕ проверено",
              file=sys.stderr)
        return 3

    ast = load_ast(TARGET)
    if ast is None:
        print(f"check-diamond-call-gas: у {TARGET} нет артефакта с AST "
              f"(нужен forge build с ast = true) — правило НЕ проверено",
              file=sys.stderr)
        return 3

    with open(TARGET, encoding="utf-8") as fh:
        source = fh.read()

    findings = collect(ast, source)

    seen_interfaces = {f.callee for f in findings if f.kind == "external"}
    missing = KNOWN_DIAMOND_INTERFACES - seen_interfaces
    if missing:
        print("check-diamond-call-gas: разбор не нашёл известных диамонд-интерфейсов "
              f"({', '.join(sorted(missing))}) — сломан сам гейт, правило НЕ проверено",
              file=sys.stderr)
        return 3

    uncapped = [f for f in findings if not f.capped]

    if mode == "--print":
        counts = {}
        for f in uncapped:
            counts.setdefault(f.key, []).append(f)
        for key in sorted(counts):
            print(f"=== {key} ===")
            print(f"occurrences: {len(counts[key])}")
            print(f"{REASON_PREFIX} <дописать руками>")
            print()
        return 0

    try:
        allow = parse_allow(ALLOW)
    except ValueError as exc:
        print(f"check-diamond-call-gas: {exc}", file=sys.stderr)
        return 2

    actual = {}
    for f in uncapped:
        actual.setdefault(f.key, []).append(f)

    problems = []

    for key in sorted(actual):
        found = actual[key]
        unclassified = [f for f in found if f.kind == "unclassified"]
        if unclassified:
            problems.append(
                f"НЕ КЛАССИФИЦИРОВАН: {key} (строка {unclassified[0].line}). "
                "Сканер не смог отнести этот вызов ни к одной форме. Молчать здесь "
                "нельзя: именно так слепнут сканеры, узнающие написание."
            )
            continue
        if key not in allow:
            lines = ", ".join(str(f.line) for f in found)
            problems.append(
                f"БЕЗ КАПА и без записи: {key} (строка {lines}). "
                f"Либо {{gas: ...}} с ЗАМЕРЕННЫМ капом, либо запись в {ALLOW}."
            )
            continue
        expected, _ = allow[key]
        if expected != len(found):
            problems.append(
                f"ИЗМЕНИЛОСЬ ЧИСЛО: {key} — в {ALLOW} записано {expected}, "
                f"в коде {len(found)}. Перечитать причину и поправить запись."
            )

    for key in sorted(allow):
        if key not in actual:
            problems.append(
                f"ПРОТУХШАЯ ЗАПИСЬ: {key} есть в {ALLOW}, а в коде такого вызова "
                "без капа больше нет. Убрать запись."
            )

    if problems:
        print("check-diamond-call-gas: правило нарушено\n", file=sys.stderr)
        for p in problems:
            print(f"  * {p}", file=sys.stderr)
        print("", file=sys.stderr)
        return 1

    capped = [f for f in findings if f.capped]
    print(f"check-diamond-call-gas: чисто — {len(capped)} внешних вызова под капом, "
          f"{len(uncapped)} объяснены в {ALLOW}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
