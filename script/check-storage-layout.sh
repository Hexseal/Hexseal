#!/usr/bin/env bash
# Гейт раскладки Diamond-хранилища.
#
# Инвариант: ни один фасет не должен объявлять обычных state-переменных.
# Всё состояние живёт в namespaced-библиотеках (ERC-7201), иначе фасеты
# начнут делить слоты 0,1,2... и затирать друг друга через delegatecall.
#
# Agreement и MinimalForwarder исключены: это standalone-контракты,
# delegatecall в них не идёт, собственное хранилище им положено.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v slither >/dev/null 2>&1; then
    echo "check-storage-layout: slither не найден (pip install slither-analyzer)" >&2
    exit 127
fi

# ВАЖНО: принтер `variable-order` пишет таблицы в stderr, а не в stdout
# (проверено на slither 0.11.5) — stdout при этом остаётся пустым. Поэтому
# stderr здесь сливается в захватываемый поток через 2>&1, а не глушится.
OUT=$(slither . --filter-paths "lib/|test/|script/" --print variable-order 2>&1)

VIOLATIONS=$(printf '%s\n' "$OUT" | awk '
    /^[A-Za-z_][A-Za-z0-9_]*:$/ { contract = substr($0, 1, length($0)-1); next }
    /^\| *[A-Za-z_]/ {
        if (contract ~ /Facet$/ && $0 !~ /Name/ && $0 !~ /---/) print contract ": " $2
    }
')

if [ -n "$VIOLATIONS" ]; then
    echo "check-storage-layout: у фасетов найдены последовательные state-переменные:" >&2
    printf '%s\n' "$VIOLATIONS" >&2
    echo "" >&2
    echo "Всё состояние фасета обязано лежать в namespaced-библиотеке." >&2
    exit 1
fi

echo "check-storage-layout: ок — ни один фасет не занимает последовательных слотов"
