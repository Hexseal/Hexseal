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
# Составные типы РАСКРЫВАЮТСЯ. Табличный вывод forge печатает для составного
# поля только имя типа («mapping(uint256 => struct Agreement.Extra)»,
# «enum Agreement.Status»), поэтому снапшот на нём был слеп к перестановке
# полей ВНУТРИ struct Extra и к реордеру членов enum Status — оба изменения
# ломают чтение живого хранилища, а гейт отдавал 0. Теперь форма типа
# разворачивается рекурсивно (script/expand_agreement_layout.py) и входит в
# ту же строку снапшота, что и поле верхнего уровня, — правило сравнения
# «префикс + дописывание в конец» осталось прежним.
#
# Побочное следствие раскрытия: дописывание поля в конец struct Extra тоже
# провалит гейт (строка поля `extras` изменится), хотя для структуры,
# лежащей значением mapping'а, это безопасно. Гейт здесь намеренно строже
# необходимого: осознанное изменение проводится через --update с ревью.
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
#   3 — раскладку не удалось получить: либо сам forge inspect упал (ошибка
#       компиляции src/Agreement.sol, либо кэш-глюк артефактов "storage layout
#       missing from artifact" после неполной инкрементальной сборки), либо
#       раскрыватель не разобрал JSON / не разрезолвил тип или enum, либо
#       на выходе не осталось ни одного поля. Во всех случаях сломан сам
#       гейт, а не раскладка, — она НЕ проверена
#   127 — python3 не найден (как в check-storage-structs.sh)
set -euo pipefail

cd "$(dirname "$0")/.."

SNAPSHOT="script/agreement-layout.snapshot"
EXPANDER="script/expand_agreement_layout.py"

if ! command -v python3 >/dev/null 2>&1; then
    echo "check-agreement-layout: python3 не найден" >&2
    exit 127
fi

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
RAW=$(forge inspect Agreement storageLayout --json 2>&1)
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

# Раскрываем составные типы и нормализуем в строки "имя|раскрытый тип|слот|оффсет".
# Код возврата раскрывателя ловим тем же ручным способом и по той же причине,
# что и код возврата forge inspect выше: под `set -e` падение внутри
# `CUR=$(...)` убило бы скрипт молча, без сентинела 3.
set +e
CUR=$(printf '%s\n' "$RAW" | python3 "$EXPANDER")
EXPAND_RC=$?
set -e

if [ "$EXPAND_RC" -ne 0 ] || [ -z "$CUR" ]; then
    echo "check-agreement-layout: forge inspect отработал (код 0), но раскрыть" >&2
    echo "раскладку не удалось (код $EXPAND_RC, полей: $(printf '%s' "$CUR" | grep -c . || true))." >&2
    echo "Это поломка самого гейта (изменился формат вывода forge? разошёлся" >&2
    echo "парсер enum'ов в $EXPANDER?), а не признак чистой раскладки." >&2
    echo "Раскладка НЕ проверена." >&2
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
    echo "поля меняет чтение хранилища у всех будущих сделок. Считается и" >&2
    echo "ВНУТРЕННОСТЬ составных типов: перестановка полей внутри struct Extra" >&2
    echo "или реордер членов enum Status меняют раскрытый тип в строке поля." >&2
    echo "Допустимо только дописывание новых полей в конец. Если изменение" >&2
    echo "осознанное и отревьюжено — ./script/check-agreement-layout.sh --update" >&2
    exit 1
fi

NEW_COUNT=$(printf '%s\n' "$CUR" | wc -l)
if [ "$NEW_COUNT" -gt "$OLD_COUNT" ]; then
    echo "check-agreement-layout: раскладка дописана в конец ($((NEW_COUNT - OLD_COUNT)) новых полей) — допустимо."
else
    echo "check-agreement-layout: раскладка Agreement не изменилась ($NEW_COUNT полей)."
fi
exit 0
