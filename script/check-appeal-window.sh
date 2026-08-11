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
#
# Задача 2 (4в-2), находка на сдаче: НЕЯКОРЕННЫЙ `/\*` ловит и одиночный
# слэш-звёздочку ВНУТРИ `//`-комментария — bagStore.js:105 несёт
# `// едут прежним путём (/files/*), в мешок попадает только ссылка…`,
# то есть текстовую "/*" без всякого намерения открыть блочный комментарий.
# На чистом main это было безобидно (в файле не было ни одного настоящего
# `*/` дальше по тексту — non-greedy `.*?\*/` просто не находил пары и не
# резал ничего). Как только Задача 1 добавила первый настоящий `/** … */`
# (докстринг listDisputeBags(), bagStore.js:1396-1438), non-greedy матч
# впервые нашёл закрывающую `*/` — и вырезал ВСЁ от строки 105 до 1438,
# включая export const APPEAL_REVIEW_WINDOW_DAYS = 4; (:171). Гейт падал
# "не нашёл объявление" по причине, не имеющей отношения к формулам.
# Правка: якорим `/\*` на начало строки (после пробелов) — оба настоящих
# блочных комментария в обоих файлах и так начинаются с начала строки
# (замерено: единственное НЕзаякоренное вхождение "/\*" в обоих файлах —
# именно эта одна ложная строка), а текстовая "/*" посреди `//`-комментария
# перестаёт открывать несуществующий блок.
sol_clean="$(perl -0777 -pe 's{^[ \t]*/\*.*?\*/}{}gsm' "$SOL")"
js_clean="$(perl -0777 -pe 's{^[ \t]*/\*.*?\*/}{}gsm' "$JS")"

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
#
# I2 (координатор, критический раунд): та же пара дыр, что уже чинили для
# APPEAL_REVIEW_WINDOW/FINALIZE_DELAY (I-4) выше, здесь оставалась
# нетронутой. Замер координатора: комментарий выше настоящего объявления
# ("дубль const DAY_MS, настоящий — второй (час)") и `head -1` на СЫРОМ
# $JS (не $js_clean) — обе позволяли фальшивому значению победить. Тот же
# приём: comment-stripped источник + extract_unique_or_die вместо
# grep|head -1.
extract_unique_or_die day_ms_expr "$JS (DAY_MS)" "$js_clean" \
  '^const DAY_MS = \K[0-9 \*]+(?=;)'
extract_unique_or_die hour_ms_expr "$JS (HOUR_MS)" "$js_clean" \
  '^const HOUR_MS = \K[0-9 \*]+(?=;)'

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

# I2 (координатор, критический раунд, находка): проверка "формула считает
# правильно" раньше была ЧИСТО ТЕКСТУАЛЬНОЙ — grep на присутствие токенов
# 'FINALIZE_DELAY_MS' и 'APPEAL_REVIEW_WINDOW_DAYS * DAY_MS' ГДЕ-ТО внутри
# тела функции, не проверяя, что эти токены реально УЧАСТВУЮТ в
# возвращаемом значении. Девять мутаций координатора проходили зелёными
# именно поэтому: ранний return с мёртвым кодом настоящей формулы ниже
# (токены есть в тексте — участия в результате нет), знак минус вместо
# плюса (токен есть, вклад в сумму отрицательный), умножение на ноль
# (токен есть, вклад нулевой), декой-функция, объявленная раньше настоящей
# и т.д. — grep текста НЕ МОЖЕТ отличить формулу, которая действительно
# складывает эти слагаемые, от формулы, которая просто упоминает их имена.
#
# Единственный способ поймать все девять разом — ПОЗВАТЬ настоящие функции
# с контролируемым входом и сверить ЧИСЛО, которое они реально вернули, с
# числом, посчитанным независимо (снаружи, из уже провалидированных
# sol_days/js_days/sol_hours/js_hours и внешне известных 86400000/3600000
# — не из day_ms_expr/hour_ms_expr самого JS, чтобы не доверять дважды
# одному и тому же возможно скомпрометированному источнику). Никакая
# декой-функция/дохлый код/подмена знака не может пройти это — если
# реально возвращённое число не совпадает с независимо посчитанным
# ожиданием, гейт красный, с конкретными числами обеих сторон.
# Ревью круг 1, находка 4: под `set -euo pipefail` голое присваивание
# `var="$(cmd)"` — простая команда, и её код выхода = коду выхода cmd. Не
# завёрнутая в `if`/`&&`/`||`, она РОНЯЕТ ВЕСЬ СКРИПТ немедленно при
# ненулевом коде node — до строки `node_exit=$?` ниже. Замерено вживую
# (сломанный экспорт в bagStore.js): гейт умирал молча после трёх «✓», без
# единой строки объяснения, и оставлял `FORMULA_CHECK_STORAGE_DIR` неубранным
# (rm -rf ниже тоже не успевал выполниться). Дефект был записан отдельно —
# docs/OPEN-ITEMS.md:1116-1120. `|| node_exit=$?` — стандартный приём:
# ловит код ошибки, не давая `set -e` сработать раньше присваивания.
FORMULA_CHECK_STORAGE_DIR="$(mktemp -d)"
formula_check_stderr="$(mktemp)"
formula_check_output="$(STORAGE_DIR="$FORMULA_CHECK_STORAGE_DIR" node --input-type=module -e "
import { dealDeadlineFromDispute, dealDeadlineFromCreation, APPEAL_REVIEW_WINDOW_DAYS, FINALIZE_DELAY_HOURS, BAG_DEAL_GRACE_MS, disputeBoxBagDeadline, BAG_TTL_MS } from '$(pwd)/$JS';

const DAY_MS = 86400000; // внешне известное, не из day_ms_expr этого же файла
const HOUR_MS = 3600000;

// dealDeadlineFromDispute: контрольные, произвольно выбранные входы.
const disputedAtMs = 1700000000000;
const disputeWindowMs = 4 * DAY_MS;
const expectedDispute = disputedAtMs + disputeWindowMs
  + FINALIZE_DELAY_HOURS * HOUR_MS + APPEAL_REVIEW_WINDOW_DAYS * DAY_MS + BAG_DEAL_GRACE_MS;
const gotDispute = dealDeadlineFromDispute(disputedAtMs, disputeWindowMs);

// dealDeadlineFromCreation: activatedAtMs=0, nowMs=createdAtMs — анкор
// становится ровно createdAtMs (см. докстринг функции), формула проще для
// независимого пересчёта здесь же.
const createdAtMs = 1700000000000;
const ownDeadlineMs = 10 * DAY_MS;
const disputeWindowMs2 = 4 * DAY_MS;
const deadlineGraceMs = 1 * DAY_MS;
const autoApproveWindowMs = 2 * DAY_MS;
const expectedCreation = createdAtMs + ownDeadlineMs + deadlineGraceMs + autoApproveWindowMs
  + disputeWindowMs2 + FINALIZE_DELAY_HOURS * HOUR_MS + APPEAL_REVIEW_WINDOW_DAYS * DAY_MS + BAG_DEAL_GRACE_MS;
const gotCreation = dealDeadlineFromCreation({
  createdAtMs, activatedAtMs: 0, ownDeadlineMs, disputeWindowMs: disputeWindowMs2,
  deadlineGraceMs, autoApproveWindowMs, nowMs: createdAtMs,
});

// Задача 2 (4в-2): срок мешка ЯЩИКА СПОРА. Считается той же формулой, но с
// якорем «сейчас» — и обязан сходиться с окном спора, иначе предъявление
// сотрут раньше, чем спор кончится.
const boxAnchorMs = 1700000000000;
const expectedBox = boxAnchorMs + disputeWindowMs
  + FINALIZE_DELAY_HOURS * HOUR_MS + APPEAL_REVIEW_WINDOW_DAYS * DAY_MS + BAG_DEAL_GRACE_MS;
const gotBox = disputeBoxBagDeadline(boxAnchorMs, disputeWindowMs);
const boxTailMs = gotBox - boxAnchorMs;

console.log(JSON.stringify({ expectedDispute, gotDispute, expectedCreation, gotCreation, expectedBox, gotBox, boxTailMs, bagTtlMs: BAG_TTL_MS }));
" 2>"$formula_check_stderr")" && node_exit=0 || node_exit=$?
rm -rf "$FORMULA_CHECK_STORAGE_DIR"

if [[ "$node_exit" -ne 0 ]]; then
  echo "❌ не удалось выполнить формулы $JS через node (код выхода $node_exit) — гейт сломан, синтаксическая ошибка (в т.ч. дубль объявления) или экспорт сломан (dealDeadlineFromDispute/dealDeadlineFromCreation/APPEAL_REVIEW_WINDOW_DAYS/FINALIZE_DELAY_HOURS/BAG_DEAL_GRACE_MS/disputeBoxBagDeadline/BAG_TTL_MS обязаны быть export):"
  cat "$formula_check_stderr"
  rm -f "$formula_check_stderr"
  exit 1
fi
rm -f "$formula_check_stderr"

expected_dispute="$(node -e "console.log(JSON.parse(process.argv[1]).expectedDispute)" "$formula_check_output")"
got_dispute="$(node -e "console.log(JSON.parse(process.argv[1]).gotDispute)" "$formula_check_output")"
expected_creation="$(node -e "console.log(JSON.parse(process.argv[1]).expectedCreation)" "$formula_check_output")"
got_creation="$(node -e "console.log(JSON.parse(process.argv[1]).gotCreation)" "$formula_check_output")"

if [[ "$got_dispute" != "$expected_dispute" ]]; then
  echo "❌ dealDeadlineFromDispute($JS) вернула $got_dispute, ожидалось $expected_dispute — формула считает не то (дохлый код/подмена знака/декой-функция?)"
  exit 1
fi
if [[ "$got_creation" != "$expected_creation" ]]; then
  echo "❌ dealDeadlineFromCreation($JS) вернула $got_creation, ожидалось $expected_creation — формула считает не то (дохлый код/подмена знака/декой-функция?)"
  exit 1
fi
echo "✓ обе формулы (dealDeadlineFromDispute/dealDeadlineFromCreation) реально ВЫЧИСЛЕНЫ и дают правильное число, не просто содержат правильные слова"

expected_box="$(node -e "console.log(JSON.parse(process.argv[1]).expectedBox)" "$formula_check_output")"
got_box="$(node -e "console.log(JSON.parse(process.argv[1]).gotBox)" "$formula_check_output")"
box_tail="$(node -e "console.log(JSON.parse(process.argv[1]).boxTailMs)" "$formula_check_output")"
bag_ttl="$(node -e "console.log(JSON.parse(process.argv[1]).bagTtlMs)" "$formula_check_output")"

if [[ "$got_box" != "$expected_box" ]]; then
  echo "❌ disputeBoxBagDeadline($JS) вернула $got_box, ожидалось $expected_box — срок мешка ящика разошёлся с окном спора (подмена хвоста/якоря/декой-функция?)"
  echo "   Пока они не совпадут, предъявление арбитру будет стёрто раньше, чем спор закончится."
  exit 1
fi
# Смысл ящика: пережить правило «семь суток после первого прочтения». Если
# хвост ящика перестанет быть длиннее BAG_TTL_MS, вся задача 2 отменяется
# молча — мешок снова умирает через неделю после того, как арбитр его открыл.
# BAG_TTL_MS здесь — умолчание сборки (окружение гейта его не переопределяет);
# на боевом сервере оно настраивается, и это ограничение проверки названо здесь.
if [[ "$box_tail" -le "$bag_ttl" ]]; then
  echo "❌ хвост мешка ящика $box_tail мс не длиннее правила «после прочтения» BAG_TTL_MS=$bag_ttl мс — мешок предъявления снова умрёт раньше спора"
  exit 1
fi
echo "✓ срок мешка ящика сходится с окном спора: хвост $box_tail мс"
echo "✓ срок мешка ящика длиннее семидневного правила «после прочтения» ($bag_ttl мс)"
