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
#   3 — forge inspect не вернул ни одного поля: либо сам forge inspect упал
#       (ошибка компиляции src/Agreement.sol, либо кэш-глюк артефактов
#       "storage layout missing from artifact" после неполной инкрементальной
#       сборки), либо изменился формат вывода таблицы. В обоих случаях сломан
#       сам гейт, а не раскладка, — она НЕ проверена
set -euo pipefail

cd "$(dirname "$0")/.."

SNAPSHOT="script/agreement-layout.snapshot"

# ВАЖНО: код возврата forge inspect захватывается вручную, в обход `set -e`
# и pipefail — точно так же, как код возврата slither захватывается в
# check-storage-layout.sh. Если положиться на распространение через pipefail
# (`forge inspect | awk`), то при падении самого forge inspect (ошибка
# компиляции или кэш-глюк "storage layout missing from artifact") код возврата
# конвейера достаётся присваиванию `CUR=$(...)`, а под `set -e` это убивает
# скрипт МОЛЧА, до того как строка `if [ -z "$CUR" ]` успеет напечатать
# внятную диагностику и выйти с сентинелом 3. Раньше это давало exit 1 без
# единого байта вывода — неотличимо от «гейт нашёл запрещённое изменение».
set +e
RAW=$(forge inspect Agreement storageLayout 2>&1)
FORGE_RC=$?
set -e

if [ "$FORGE_RC" -ne 0 ]; then
    echo "check-agreement-layout: forge inspect завершился с ошибкой (код $FORGE_RC) — раскладка НЕ проверена:" >&2
    printf '%s\n' "$RAW" >&2
    echo "" >&2
    echo "Частые причины: ошибка компиляции в src/Agreement.sol (правка не" >&2
    echo "собирается) или кэш-глюк форджа после инкрементальной сборки —" >&2
    echo "попробуйте forge clean && forge build и повторите." >&2
    exit 3
fi

# Нормализуем в строки "имя|тип|слот|оффсет", отбрасывая рамку таблицы.
CUR=$(printf '%s\n' "$RAW" | awk -F'|' '/^\| [a-zA-Z_]/ {
          gsub(/^[ \t]+|[ \t]+$/, "", $2);
          gsub(/^[ \t]+|[ \t]+$/, "", $3);
          gsub(/^[ \t]+|[ \t]+$/, "", $4);
          gsub(/^[ \t]+|[ \t]+$/, "", $5);
          if ($2 != "Name") print $2 "|" $3 "|" $4 "|" $5
      }')

if [ -z "$CUR" ]; then
    echo "check-agreement-layout: forge inspect отработал (код 0), но таблица пуста." >&2
    echo "Это поломка самого парсера (изменился формат вывода forge?), а не" >&2
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
