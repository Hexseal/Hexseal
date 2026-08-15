#!/usr/bin/env bash
# С 15 августа 2026 версия каждой зависимости контрактов объявлена ДВАЖДЫ:
# гитлинком подмодуля (`git ls-files -s lib/`) и строкой в `foundry.lock`.
# Два хозяина у одного числа — тот самый шов, из-за которого «каждая часть
# верна, а стык мёртв».
#
# Замер, ради которого гейт заведён (проведён 15 августа 2026, до его
# написания): в `foundry.lock` подставили ЧУЖОЙ коммит forge-std, снесли
# подмодуль и позвали `forge build`. Forge молча поставил версию ИЗ ГИТЛИНКА,
# врущую строку в локе НЕ поправил и НЕ пожаловался. То есть без этого гейта
# лок может годами показывать одну версию, а собираться будет другая — и
# заметит это только человек, который сверит вручную.
#
# Хозяин числа — гитлинк: собирается именно он. `foundry.lock` обязан лишь
# не противоречить. Тот же класс гейта, что check-appeal-window.sh.
set -euo pipefail

LOCK="foundry.lock"

if [[ ! -d .git ]] && [[ ! -f .git ]]; then
  echo "❌ запусти гейт из корня репозитория (сейчас: $(pwd))"
  exit 1
fi

if [[ ! -f "$LOCK" ]]; then
  echo "❌ $LOCK не найден. Он появляется сам при первой сборке с подмодулями;"
  echo "   если его удалили намеренно — удали и этот гейт, иначе он сторожит пустоту."
  exit 1
fi

pins=$(git ls-files -s lib/ | awk '$1=="160000" {print $4" "$2}' | sort)

if [[ -z "$pins" ]]; then
  echo "❌ в индексе нет ни одного подмодуля под lib/ — либо их снесли, либо гейт запущен не там."
  echo "   Ожидались gitlink-и (режим 160000) для lib/forge-std и lib/openzeppelin-contracts."
  exit 1
fi

fail=0
while read -r path rev; do
  locked=$(python3 -c "
import json,sys
try:
    d=json.load(open('$LOCK'))
except Exception as e:
    print('READ_ERROR:'+str(e)); sys.exit(0)
print(d.get('$path',{}).get('rev','MISSING'))
")
  case "$locked" in
    READ_ERROR:*)
      echo "❌ $LOCK не читается: ${locked#READ_ERROR:}"
      exit 1
      ;;
    MISSING)
      echo "❌ $path есть в git, но отсутствует в $LOCK."
      echo "   Собираться будет $rev, а лок про эту зависимость молчит."
      fail=1
      ;;
    "$rev")
      echo "  ✓ $path — $rev, лок совпадает"
      ;;
    *)
      echo "❌ $path: git и $LOCK расходятся."
      echo "   gitlink (собирается ЭТО): $rev"
      echo "   foundry.lock (враньё):    $locked"
      echo "   Лечение: приведи $LOCK к гитлинку, а не наоборот — forge слушается гитлинка."
      fail=1
      ;;
  esac
done <<< "$pins"

# Обратная сторона: строка в локе, которой не соответствует ни один подмодуль.
extra=$(python3 -c "
import json
d=json.load(open('$LOCK'))
known=set('''$pins'''.split('\n')[i].split(' ')[0] for i in range(len('''$pins'''.split('\n'))))
for k in d:
    if k not in known: print(k)
")
if [[ -n "$extra" ]]; then
  echo "❌ в $LOCK записаны зависимости, которых нет среди подмодулей:"
  echo "$extra" | sed 's/^/   /'
  fail=1
fi

# ── Третья сверка: что РЕАЛЬНО выложено на диск ───────────────────────────────
#
# Найдено замером 15 августа 2026, уже после того как гейт был написан и признан
# рабочим. Свежий `git clone --recursive` оборвался на середине (связь легла на
# большом репозитории OZ), обновление подмодулей отменилось — и forge-std остался
# на верхушке мастера вместо записанного пина. Гейт в этот момент был ЗЕЛЁНЫЙ:
# он сверял лок с индексом, а оба были верны. Врал диск.
#
# `git submodule status` помечает такое префиксом `+` (выложено не то, что
# записано). Префикс `-` — не инициализирован; это НЕ ошибка: forge доустановит
# сам и ровно по гитлинку, поэтому только предупреждение.
while read -r line; do
  [[ -z "$line" ]] && continue
  mark="${line:0:1}"
  body="${line#?}"
  sub_rev="${body%% *}"
  sub_path=$(echo "$body" | awk '{print $2}')
  case "$mark" in
    '+')
      echo "❌ $sub_path: на диске выложен НЕ тот коммит, что записан."
      echo "   выложено: $sub_rev"
      echo "   записано: $(git ls-files -s "$sub_path" | awk '{print $2}')"
      echo "   Лечение: git submodule update --init --recursive"
      fail=1
      ;;
    '-')
      echo "  ⚠ $sub_path не инициализирован — forge доустановит сам, но лучше явно:"
      echo "    git submodule update --init --recursive"
      ;;
    'U')
      echo "❌ $sub_path в состоянии конфликта слияния."
      fail=1
      ;;
    *)
      echo "  ✓ $sub_path — на диске ровно записанный коммит"
      ;;
  esac
done <<< "$(git submodule status 2>/dev/null)"

if [[ "$fail" != 0 ]]; then
  echo
  echo "check-submodule-pins: РАСХОЖДЕНИЕ."
  exit 1
fi

echo "check-submodule-pins: ок — гитлинки, $LOCK и выложенное на диск сходятся"
