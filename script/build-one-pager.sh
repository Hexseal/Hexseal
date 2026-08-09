#!/usr/bin/env bash
# Собирает самодостаточный файл и PDF из исходника одностраничника.
#
# Зачем отдельная сборка: docs/hexseal-one-pager.html — ИСХОДНИК для артефакта,
# и обёртку страницы (doctype/head/body) там добавляет платформа при публикации.
# Тот же файл, открытый локально или отправленный вложением, остаётся без
# объявления кодировки — тире, точки-разделители и неразрывные пробелы у
# получателя едут. Поэтому вложение собирается здесь, а исходник не трогаем.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=docs/hexseal-one-pager.html
OUT=docs/hexseal-one-pager.standalone.html
PDF=docs/hexseal-one-pager.pdf

python3 - "$SRC" "$OUT" <<'PY'
import sys
src, out = sys.argv[1], sys.argv[2]
s = open(src, encoding='utf-8').read()
# Разрез по первому <div class="page"> — всё до него (title, style) уходит в head.
marker = '<div class="page">'
i = s.index(marker)
head, body = s[:i].rstrip(), s[i:]
page = (
    '<!doctype html>\n<html lang="en">\n<head>\n'
    '<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    '<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0}'
    '@page{margin:14mm}</style>\n'
    f'{head}\n</head>\n<body>\n{body.rstrip()}\n</body>\n</html>\n'
)
open(out, 'w', encoding='utf-8').write(page)
print(f'собран {out} ({len(page.encode())} байт)')
PY

# PDF намеренно НЕ собирается здесь. Замерено 9 августа: brave в headless на этой
# машине уходит в тупик и не возвращается — два прогона по отсечке (60 и 120 с),
# ноль вывода, файла нет. wkhtmltopdf и weasyprint не установлены, а libreoffice
# рендерит grid/flex мимо макета.
#
# Рабочий путь — печать из своего браузера: открыть собранный файл и
# Печать → Сохранить как PDF. В исходнике для этого стоит блок @media print:
# светлая палитра принудительно (иначе тёмная тема дала бы чёрные страницы),
# фоны плашек печатаются явно (в них смысл — кто решает, контракт или человек;
# браузер по умолчанию фоны не печатает, и различие исчезло бы молча),
# карточки и строки таблиц не разрываются между страницами.
echo
echo "PDF: открой $OUT в браузере и Печать → Сохранить как PDF."
echo "     Стили печати уже настроены (светлая палитра, фоны плашек, без разрывов)."
