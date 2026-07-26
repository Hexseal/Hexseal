#!/usr/bin/env bash
# Гейт раскладки хранилища Agreement.
#
# Зачем отдельный скрипт, а не расширение check-storage-structs.sh: тот
# разбирает struct Layout/Data в namespaced-библиотеках по маркеру ERC-7201.
# У Agreement никакой структуры нет — это обычные state-переменные контракта,
# включая унаследованные от MinimalERC721 / ReentrancyGuard / ERC2771Context.
# Их раскладку выдаёт forge inspect.
#
# Почему это вообще нужно: с переходом на EIP-1167 все клоны разделяют
# раскладку реализации. Смена типа или порядка поля подействует на все
# будущие сделки, а при подмене реализации — и на существующие. Это ровно
# тот класс бага, который сломал JobBoard в июле 2026.
#
# Использование:
#   ./script/check-agreement-layout.sh           — проверка (её вызывает CI)
#   ./script/check-agreement-layout.sh --update  — перегенерировать снапшот
#                                                  (только после осознанного,
#                                                  отревьюженного изменения)
#
# Коды возврата:
#   0 — раскладка совпадает со снапшотом или дописана в конец
#   1 — запрещённое изменение (смена типа/слота/оффсета, реордер, удаление)
#   2 — снапшот отсутствует или пуст — сравнивать не с чем, это НЕ "чисто"
#   3 — forge inspect не вернул ни одного поля: сломан сам гейт, а не код
set -euo pipefail

cd "$(dirname "$0")/.."

SNAPSHOT="script/agreement-layout.snapshot"

# Нормализуем в строки "имя|тип|слот|оффсет", отбрасывая рамку таблицы.
current() {
    forge inspect Agreement storageLayout 2>/dev/null \
        | awk -F'|' '/^\| [a-zA-Z_]/ {
              gsub(/^[ \t]+|[ \t]+$/, "", $2);
              gsub(/^[ \t]+|[ \t]+$/, "", $3);
              gsub(/^[ \t]+|[ \t]+$/, "", $4);
              gsub(/^[ \t]+|[ \t]+$/, "", $5);
              if ($2 != "Name") print $2 "|" $3 "|" $4 "|" $5
          }'
}

CUR="$(current)"

if [ -z "$CUR" ]; then
    echo "check-agreement-layout: forge inspect не вернул ни одного поля." >&2
    echo "Это поломка самого гейта (изменился формат вывода forge?), а не" >&2
    echo "признак чистой раскладки. Раскладка НЕ проверена." >&2
    exit 3
fi

if [ "${1:-}" = "--update" ]; then
    printf '%s\n' "$CUR" > "$SNAPSHOT"
    echo "check-agreement-layout: снапшот перезаписан ($(printf '%s\n' "$CUR" | wc -l) полей)."
    echo "Коммитить вместе с изменением кода, которое его потребовало."
    exit 0
fi

if [ ! -s "$SNAPSHOT" ]; then
    echo "check-agreement-layout: $SNAPSHOT отсутствует или пуст." >&2
    echo "Сравнивать не с чем. Создать: ./script/check-agreement-layout.sh --update" >&2
    exit 2
fi

OLD_COUNT=$(wc -l < "$SNAPSHOT")

# Разрешено ровно одно: prefix снапшота совпадает, новые поля дописаны в конец.
if ! printf '%s\n' "$CUR" | head -n "$OLD_COUNT" | diff -q - "$SNAPSHOT" >/dev/null; then
    echo "check-agreement-layout: раскладка Agreement изменена не дописыванием в конец." >&2
    echo "" >&2
    echo "--- снапшот" >&2
    echo "+++ сейчас" >&2
    printf '%s\n' "$CUR" | head -n "$OLD_COUNT" | diff "$SNAPSHOT" - >&2 || true
    echo "" >&2
    echo "Клоны разделяют раскладку реализации: смена типа, слота или порядка" >&2
    echo "поля меняет чтение хранилища у всех будущих сделок. Допустимо только" >&2
    echo "дописывание новых полей в конец. Если изменение осознанное и" >&2
    echo "отревьюжено — ./script/check-agreement-layout.sh --update" >&2
    exit 1
fi

NEW_COUNT=$(printf '%s\n' "$CUR" | wc -l)
if [ "$NEW_COUNT" -gt "$OLD_COUNT" ]; then
    echo "check-agreement-layout: раскладка дописана в конец ($((NEW_COUNT - OLD_COUNT)) новых полей) — допустимо."
else
    echo "check-agreement-layout: раскладка Agreement не изменилась ($NEW_COUNT полей)."
fi
exit 0
