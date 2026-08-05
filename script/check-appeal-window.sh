#!/usr/bin/env bash
# APPEAL_REVIEW_WINDOW и FINALIZE_DELAY объявлены private в
# ArbiterRegistryFacet, из цепи их не прочитать, поэтому релеер держит свои
# копии (обе нужны формуле dealDeadlineFromDispute()/dealDeadlineFromCreation()
# в relayer/bagStore.js — конец окна апелляции считается через ОБЕ константы,
# см. докстринг там же, находка I2 закрывающего раунда ревью). Копии обязаны
# совпадать с оригиналом: если любое из окон удлинят, а релеер об этом не
# узнает, он сотрёт доказательства до того, как апелляция закончится — и
# оспорить вердикт станет нечем. Тот же класс гейта, что check-storage-layout.sh
# и check-gasless-sender.sh.
set -euo pipefail

SOL="src/facets/ArbiterRegistryFacet.sol"
JS="relayer/bagStore.js"

if [[ ! -f "$SOL" ]]; then
  echo "❌ $SOL не найден (сейчас: $(pwd)) — запусти гейт из корня репозитория, не по относительному пути откуда-то ещё"
  exit 1
fi
if [[ ! -f "$JS" ]]; then
  echo "❌ $JS не найден (сейчас: $(pwd)) — запусти гейт из корня репозитория, не по относительному пути откуда-то ещё"
  exit 1
fi

# I-4 (четвёртый закрывающий раунд ревью, находка координатора): якорь на
# строку объявления делает иммунным к `//`-комментариям, но НЕ к блочным
# `/* ... */` — строка внутри блочного комментария всё ещё ТЕКСТУАЛЬНО
# начинается с "uint256 private constant NAME" и матчится тем же
# заякоренным регексом, что настоящая:
#   /* было раньше:
#   uint256 private constant APPEAL_REVIEW_WINDOW = 4 days;
#   */
#   uint256 private constant APPEAL_REVIEW_WINDOW = 7 days;
# `head -1` брал первое совпадение — фальшивую "4" внутри комментария, не
# настоящие "7". Вырезаем блочные комментарии ОБЕИХ сторон ПЕРЕД любым
# извлечением (perl -0777, слёрп всего файла, non-greedy + dotall — ловит и
# многострочные блоки).
sol_clean="$(perl -0777 -pe 's{/\*.*?\*/}{}gs' "$SOL")"
js_clean="$(perl -0777 -pe 's{/\*.*?\*/}{}gs' "$JS")"

# Та же находка, вторая часть: дубль настоящего (не закомментированного)
# объявления где-то ещё в файле раньше выигрывал бы через `head -1` точно
# так же слепо. Требуем РОВНО одно совпадение — не "первое" и не
# "последнее", а единственное; два и больше — тоже громкий отказ, гейт не
# гадает, какое из них настоящее.
extract_unique_or_die() {
  local __var="$1" __src="$2" __text="$3" __pattern="$4"
  local matches count
  matches="$(printf '%s\n' "$__text" | grep -oP "$__pattern" || true)"
  count=0
  if [[ -n "$matches" ]]; then
    count="$(printf '%s\n' "$matches" | grep -c .)"
  fi
  if [[ "$count" -eq 0 ]]; then
    echo "❌ не нашёл объявление в $__src — гейт сломан, почини гейт"
    exit 1
  fi
  if [[ "$count" -gt 1 ]]; then
    echo "❌ нашёл $count совпадений объявления в $__src, ожидал ровно одно (дубль объявления?) — почини вручную, гейт не берёт первое/последнее наугад"
    exit 1
  fi
  printf -v "$__var" '%s' "$matches"
}

extract_unique_or_die sol_days "$SOL (APPEAL_REVIEW_WINDOW)" "$sol_clean" \
  '^\s*uint256 private constant APPEAL_REVIEW_WINDOW\s*=\s*\K[0-9]+(?=\s*days)'
extract_unique_or_die js_days "$JS (APPEAL_REVIEW_WINDOW_DAYS)" "$js_clean" \
  '^export const APPEAL_REVIEW_WINDOW_DAYS = \K[0-9]+'

if [[ "$sol_days" != "$js_days" ]]; then
  echo "❌ окно апелляции разошлось: контракт $sol_days дн., релеер $js_days дн."
  echo "   Пока они не совпадут, релеер будет стирать доказательства до конца апелляции."
  exit 1
fi
echo "✓ окно апелляции сходится: $sol_days дн."

extract_unique_or_die sol_hours "$SOL (FINALIZE_DELAY)" "$sol_clean" \
  '^\s*uint256 private constant FINALIZE_DELAY\s*=\s*\K[0-9]+(?=\s*hours)'
extract_unique_or_die js_hours "$JS (FINALIZE_DELAY_HOURS)" "$js_clean" \
  '^export const FINALIZE_DELAY_HOURS = \K[0-9]+'

if [[ "$sol_hours" != "$js_hours" ]]; then
  echo "❌ окно финализации разошлось: контракт $sol_hours ч., релеер $js_hours ч."
  echo "   Пока они не совпадут, релеер будет стирать доказательства до того, как окно апелляции реально откроется/закроется."
  exit 1
fi
echo "✓ окно финализации сходится: $sol_hours ч."

# I-A (второй закрывающий раунд ревью): гейт проверяет, что DAY_MS/HOUR_MS
# (множители перевода дней/часов в мс) равны ровно 86400000/3600000 —
# подмена одного из них (например, DAY_MS = 60*60*1000, дни на часы) даёт
# сравнение "4=4" зелёным, при этом формула считает в 24 раза меньший
# интервал.
day_ms_expr="$(grep -oP '^const DAY_MS = \K[0-9 \*]+(?=;)' "$JS" | head -1 || true)"
hour_ms_expr="$(grep -oP '^const HOUR_MS = \K[0-9 \*]+(?=;)' "$JS" | head -1 || true)"

if [[ -z "$day_ms_expr" ]]; then
  echo "❌ не нашёл объявление DAY_MS в $JS — гейт сломан, почини гейт"; exit 1
fi
if [[ -z "$hour_ms_expr" ]]; then
  echo "❌ не нашёл объявление HOUR_MS в $JS — гейт сломан, почини гейт"; exit 1
fi

day_ms_value=$(( day_ms_expr ))
hour_ms_value=$(( hour_ms_expr ))

if [[ "$day_ms_value" -ne 86400000 ]]; then
  echo "❌ DAY_MS в $JS считается как $day_ms_value мс, а не 86400000 (сутки) — подмена множителя, формула APPEAL_REVIEW_WINDOW_DAYS*DAY_MS считает не то"
  exit 1
fi
if [[ "$hour_ms_value" -ne 3600000 ]]; then
  echo "❌ HOUR_MS в $JS считается как $hour_ms_value мс, а не 3600000 (час) — подмена множителя, формула FINALIZE_DELAY_HOURS*HOUR_MS считает не то"
  exit 1
fi
echo "✓ множители сходятся: DAY_MS=$day_ms_value мс, HOUR_MS=$hour_ms_value мс"

# I-3 (четвёртый закрывающий раунд ревью, находка координатора): проверка
# "формула применяет множитель к правильной константе" раньше искала строку
# 'APPEAL_REVIEW_WINDOW_DAYS * DAY_MS' по ВСЕМУ файлу (grep -q "$JS") — а её
# удовлетворяла СОВСЕМ ДРУГАЯ строка, из _warnIfBagMaxAgeTooSmallForAppeal()
# (I-D), которая считает ТУ ЖЕ константу для ДРУГОЙ цели (предупреждение при
# старте). Три мутации, ломающие ОБЕ формулы (умножение на HOUR_MS вместо
# DAY_MS, выброшенное слагаемое апелляции, выброшенное слагаемое
# финализации), проходили гейт зелёным, потому что формулу никто не
# смотрел — смотрели файл целиком. Извлекаем ИМЕННО тело каждой формулы
# (от объявления функции до закрывающей `}` в начале строки) и проверяем
# ВНУТРИ него, не снаружи.
extract_function_body() {
  local file="$1" func_name="$2"
  sed -n "/^export function ${func_name}/,/^}\$/p" "$file"
}

for fn in dealDeadlineFromDispute dealDeadlineFromCreation; do
  body="$(extract_function_body "$JS" "$fn")"
  if [[ -z "$body" ]]; then
    echo "❌ не нашёл функцию $fn() в $JS — гейт сломан, почини гейт"
    exit 1
  fi
  if ! grep -q 'FINALIZE_DELAY_MS' <<<"$body"; then
    echo "❌ формула $fn() в $JS не содержит FINALIZE_DELAY_MS — слагаемое окна финализации выброшено из формулы"
    exit 1
  fi
  if ! grep -q 'APPEAL_REVIEW_WINDOW_DAYS \* DAY_MS' <<<"$body"; then
    echo "❌ формула $fn() в $JS не содержит 'APPEAL_REVIEW_WINDOW_DAYS * DAY_MS' — слагаемое окна апелляции выброшено или множитель подменён (дни на часы?)"
    exit 1
  fi
done
echo "✓ обе формулы (dealDeadlineFromDispute/dealDeadlineFromCreation) содержат оба слагаемых с правильными множителями"
