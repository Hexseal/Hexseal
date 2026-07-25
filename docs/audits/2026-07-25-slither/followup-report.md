# Follow-up отчёт — 2026-07-25

Реализация трёх пунктов из `FOLLOW-UPS.md` (F-3, F-4, и два пункта из
«Мелочи»). Каждый пункт — отдельный коммит, независимый от остальных.

---

## Item 1 — F-3: тест на путь неудачи внутреннего вызова форвардера

### Что сделано

`test/MinimalForwarder.t.sol`:

- Добавлен мок `Reverter` (плюс кастомная ошибка `MockRevertError(uint256 code)`,
  объявлена на уровне файла) — контракт с единственной функцией `explode(uint256)`,
  которая всегда ревертит этой ошибкой. Отдельный мок, не переиспользует
  `Echo2771`/`Bomb` — у них другое назначение (2771-суффикс и return-bomb).
- Добавлен тест `testExecuteDoesNotRevertOnInnerCallFailure()` с русским
  комментарием-характеризацией сверху, объясняющим:
  - `execute()` осознанно не ревертит при провале вложенного вызова;
  - на это опирается `frontend/src/app/api/relay/route.ts` (симулирует
    `execute()` через `publicClient.simulateContract`, разбирает `sim.result`
    как `[success, retdata]`, и именно по `success === false` определяет,
    что вложенный вызов провалился — строки 365–462 файла);
  - тест фиксирует поведение, чтобы будущая «починка» (заставить `execute`
    ревертить) не проскочила незамеченной.
- Тест проверяет все пять пунктов из задания:
  1. `execute()` сам не ревертит (просто выполняется до конца, без
     `vm.expectRevert`);
  2. возвращённый `success == false` (`assertFalse(ok, ...)`);
  3. nonce **потреблён** — сравнение `getNonce(user)` до/после вызова
     (`nonceBefore + 1`);
  4. `retdata` — не просто непустой, а побайтово равен
     `abi.encodeWithSelector(MockRevertError.selector, code)`, и
     дополнительно раздельно декодирован: селектор извлечён через
     `assembly { mload(add(retdata, 32)) }` и сравнён с
     `MockRevertError.selector`, а payload декодирован через
     `abi.decode(_dropSelector(retdata), (uint256))` и сравнён с исходным
     `code`;
  5. `Executed(from, to, false)` — через `vm.expectEmit(true, true, false, true)`
     + `emit MinimalForwarder.Executed(user, address(reverter), false)`
     непосредственно перед вызовом `execute()`.
- Добавлен приватный хелпер `_dropSelector(bytes memory)` — отбрасывает
  первые 4 байта буфера, чтобы декодировать оставшийся ABI-payload.

### Доказательство, что тест различает поведение (discriminates)

Временно инвертировал ключевую проверку (`assertTrue(ok, ...)` вместо
`assertFalse(ok, ...)`) и прогнал только этот тест:

```
$ forge test --match-test testExecuteDoesNotRevertOnInnerCallFailure -vv
[FAIL: INVERTED FOR VERIFICATION: proving the test discriminates] testExecuteDoesNotRevertOnInnerCallFailure() (gas: 56450)
Suite result: FAILED. 0 passed; 1 failed; 0 skipped
```

Откатил инверсию (`cp` бэкапа файла обратно), прогнал снова:

```
$ forge test --match-test testExecuteDoesNotRevertOnInnerCallFailure -vv
[PASS] testExecuteDoesNotRevertOnInnerCallFailure() (gas: 68120)
Suite result: ok. 1 passed; 0 failed; 0 skipped
```

Тест реально пинует именно эту семантику, а не проходит случайно.

### Полный прогон

```
$ forge test
...
Ran 8 test suites in 98.53ms (500.18ms CPU time): 277 tests passed, 0 failed, 0 skipped (277 total tests)
```

276 (база) + 1 (новый) = 277. Всё зелёное.

---

## Item 2 — F-4: тесты и гейт в CI

### Что сделано

`.github/workflows/deploy.yml`: добавлена новая job `contracts`, и job `build`
теперь `needs: contracts`.

```yaml
jobs:
  contracts:
    runs-on: ubuntu-latest
    permissions:
      contents: read

    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0

      - name: Install Foundry
        uses: foundry-rs/foundry-toolchain@b00af27efadbc7b4ca8b82abbd903b17cc874d2a # v1.9.0

      - name: Install slither
        run: pip install --break-system-packages slither-analyzer

      - name: Run contract tests
        run: forge test

      - name: Check Diamond storage layout
        run: ./script/check-storage-layout.sh

  build:
    needs: contracts
    ...
```

### Решения и почему

- **Submodules**: проверил — `lib/` не git submodule (`.gitmodules`
  отсутствует, `git submodule status` пуст), а полностью завендорено:
  `git ls-files lib/ | wc -l` → 924 отслеживаемых файла (`forge-std`,
  `openzeppelin-contracts`). Значит обычного `actions/checkout` достаточно,
  без `submodules: true/recursive` — задание прямо предусматривало этот
  случай.
- **Гейт vs. рядом**: сделал `build: needs: contracts`, то есть `contracts`
  реально **блокирует** сборку и пуш Docker-образов (relayer + frontend) в
  ghcr — и на push в `main`, и на ручном `workflow_dispatch`. Не сделал их
  параллельными, потому что «гейт», который просто репортит красный статус
  рядом с уже запущенным пушем образов, — это ровно та же проблема
  («чеклист, а не гейт»), только теперь в CI, а не в голове человека.
  `deploy` не трогал: он как был `needs: build` + `if: workflow_dispatch &&
  inputs.deploy`, так и остался — деплой по-прежнему полностью ручной,
  триггерится не этим изменением. Транзитивно `deploy` теперь тоже не
  доедет до VPS без прошедших контрактных тестов, но это следствие того,
  что он уже зависел от `build`, а не новая логика деплоя.
- **Пин версий**:
  - `actions/checkout` — переиспользован тот же SHA, что уже в файле
    (`9c091bb2...` = v7.0.0), просто для консистентности с существующей job.
  - `foundry-rs/foundry-toolchain` — SHA получен через
    `gh api repos/foundry-rs/foundry-toolchain/tags`, взял актуальный тег
    `v1.9.0` → `b00af27efadbc7b4ca8b82abbd903b17cc874d2a`.
  - Никаких плавающих тегов (`@v1`, `@master`) не введено — стиль файла
    (полный SHA + `# vX.Y.Z` комментарий) соблюдён на обоих новых шагах.
- **`pip install slither-analyzer` → `pip install --break-system-packages
  slither-analyzer`**: буквальная команда из задания
  (`pip install slither-analyzer`) была протестирована локально и падает с
  `error: externally-managed-environment` (PEP 668) — эта машина и, по всей
  видимости, `ubuntu-latest` раннер GitHub Actions в 2026 году оба на базе
  Ubuntu 24.04 (noble), где системный Python помечен как externally-managed.
  `--user` тоже не помогает (тот же отказ). Рабочий вариант, подтверждённый
  локально (`--dry-run`) — `--break-system-packages`. Использовал именно
  его, а не venv/pipx, чтобы остаться максимально близко к букве задания и
  не усложнять job лишним шагом создания виртуального окружения.

### Время выполнения

Не могу измерить реальное время CI-раннера (нет доступа к запуску GitHub
Actions). Локальные ориентиры (тёплый кэш solc/pip на этой машине):

- `forge test` (полный прогон, все 277 тестов, `via_ir = true`): ~69с реального времени.
- `./script/check-storage-layout.sh` (включает полную рекомпиляцию slither'ом): ~17с.

На холодном CI-раннере ожидаю на пару минут больше сверху из-за: скачивания
бинаря `forge`/`solc` через `foundry-toolchain`, установки `slither-analyzer`
и его зависимостей (`web3`, `eth-utils`, и т.д.) через pip с нуля, и
отсутствия прогретого `out/`-кэша Forge. В сумме ожидаю, что job `contracts`
добавит порядка 2–4 минут к общему пайплайну — это соответствует
ожиданию из задания («пара минут — это нормально»). Если по факту будет
существенно больше, стоит присмотреться к кэшированию pip/foundry
(`actions/cache`) отдельной задачей — не делал этого сейчас, чтобы не
переусложнять исходный запрос.

### Что проверено, а что нет

Проверено:
- YAML парсится: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/deploy.yml'))"` — ок,
  плюс явно распечатаны `jobs.keys()` и `needs`-связи (`contracts`, `build`
  needs `contracts`, `deploy` needs `build`) — соответствуют ожидаемым.
- `lib/` — вендор, не submodule (см. выше).
- SHA `foundry-rs/foundry-toolchain@b00af27...` — реальный коммит тега
  `v1.9.0`, получен напрямую из GitHub API (`gh api`), не выдуман.
- `pip install --break-system-packages slither-analyzer` — работает
  локально (`--dry-run`, все зависимости резолвятся, ошибки нет).
- `forge test` и `./script/check-storage-layout.sh` — оба реально
  выполнены локально с нуля после всех правок, оба зелёные (см. выше и Item 1).

НЕ проверено (невозможно без реального запуска Actions):
- Что job `contracts` в GitHub Actions действительно скачает `forge` через
  `foundry-toolchain` без ошибок сети/прав на конкретном раннере.
- Реальное время выполнения на `ubuntu-latest` раннере GitHub (холодный кэш,
  их сетевые условия к PyPI/crates.io/solc-bin могут отличаться от этой
  машины).
- Что `ubuntu-latest` в момент, когда этот workflow реально запустится,
  всё ещё резолвится в Ubuntu 24.04 (PEP 668 могла бы не мешать на более
  старом образе — но `--break-system-packages` безвреден и на образах, где
  ограничения нет, так что это не риск обратной несовместимости).
- Поведение `docker/build-push-action` и остальных существующих шагов — не
  трогал, эти шаги не менялись и не тестировались повторно.

---

## Item 3 — два предложения в `docs/CONTRACT_GUIDE.md`

### Что сделано

В разделе «Правило раскладки Diamond-хранилища»:

1. После списка «Что удерживает инвариант» добавлен абзац:

   > Десятый неймспейс, если он появится, обязан использовать вывод ERC-7201
   > (формула `_erc7201` в `StorageLayoutTest`) и быть добавленным в этот
   > тест — ни гейт, ни существующий тест не заметят новый неймспейс с сырым
   > `keccak256`, это ловится только ревью.

2. В конец абзаца про суффикс `Facet` добавлено предложение про
   `IReputationFacet`/`IArbiterRegistryFacet`:

   > По этому же суффиксу проходят и
   > `IReputationFacet`/`IArbiterRegistryFacet` — это безвредно, потому что
   > интерфейсы Solidity не могут объявлять state-переменные, а не потому
   > что скрипт как-то их отличает от настоящих фасетов.

Оба добавления — по одному-два предложения, без реструктуризации файла,
как и просилось («это гайд, не changelog»).

### Что проверено

Прочитал `script/check-storage-layout.sh` целиком — формулировка про
`IReputationFacet`/`IArbiterRegistryFacet` в гайде дословно соответствует
комментарию в скрипте (строки про «безопасны только потому, что интерфейсы
Solidity не могут объявлять state-переменные»). Прочитал
`test/StorageLayout.t.sol` — подтвердил, что формула ERC-7201 там называется
`_erc7201` и что тест пиннит именно девять неймспейсов (`testAllSlotsDistinct`
проверяет массив из 9 элементов).

---

## Итог по коммитам

Три коммита, по одному на пункт (см. `git log`).

## Область, которой не касался

- `script/DeployFull.s.sol` — не трогал вообще, включая заголовочный
  комментарий (явно вне scope).
- Остальные пункты `FOLLOW-UPS.md` (F-1, F-2, F-5, N-1..N-3, оставшиеся
  две «мелочи» — заголовок `DeployFull.s.sol` и газовый дифференциальный
  тест форвардера) — не трогал, не входили в задание.
