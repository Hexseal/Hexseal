// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";
import {ArbiterAccountabilityFacet} from "../src/facets/ArbiterAccountabilityFacet.sol";
import {IDiamondCut, IDiamondLoupe, OwnershipFacet} from "../src/DiamondProxy.sol";
// Init-контракт миграции провенанса живёт отдельным файлом, а не рядом в этом:
// `forge script <путь>` отказывается выбирать между двумя контрактами в одном
// файле («Multiple contracts in the target path») и потребовал бы от человека
// лишний флаг --tc в момент подписи. Команда выкатки обязана быть той самой,
// что записана в отчёте, без вариантов.
import {ArbiterProvenanceInit} from "./ArbiterProvenanceInit.sol";

/// Тот же getSuspensionWindow(), но объявленный `view`, а не `pure`. В самом
/// фасете он pure — там он и правда только возвращает константу. А ЧЕРЕЗ
/// ДАЙМОНД тот же вызов сперва ищет фасет в хранилище прокси, то есть состояние
/// читает. Смысл смоука ровно в этом поиске, поэтому и тип здесь честный:
/// `pure` объявлял бы, что маршрутизации не происходит.
interface ISuspensionWindowProbe {
    function getSuspensionWindow() external view returns (uint256);
}

/**
 * ОТВЕТСТВЕННОСТЬ РУЧНЫХ АРБИТРОВ — разрез даймонда (задачи 1-9 плана
 * 2026-08-15-arbiter-accountability).
 *
 * ОДИН diamondCut из ЧЕТЫРЁХ действий:
 *   Replace 63 → новый ArbiterRegistryFacet      (всё, что маршрутизируется
 *                                                 сегодня, кроме removeArbiter)
 *   Add      6 → тот же новый ArbiterRegistryFacet (входы, дописанные задачами
 *                                                 1, 2 и 5)
 *   Add     17 → новый ArbiterAccountabilityFacet (весь фасет целиком)
 *   Remove   1 → address(0): removeArbiter(address), 0x3487e08c
 *
 * ⚠️ ПОЧЕМУ ЧЕТЫРЕ ЭЛЕМЕНТА, А НЕ ТРИ. Группа Add едет на ДВА РАЗНЫХ адреса:
 * шесть новых входов старого фасета — на новый ArbiterRegistryFacet, семнадцать
 * входов ответственности — на ArbiterAccountabilityFacet. Один элемент
 * FacetCut несёт ровно один адрес, поэтому Add физически не может быть одной
 * записью. Remove — пятый по счёту повод для отдельного элемента: он требует
 * `facetAddress == address(0)` (DiamondCutLib.removeFunctions,
 * "Diamond: remove needs zero address"), то есть смешать его с чем-либо
 * нельзя в принципе.
 *
 * ⚠️ ГЛАВНОЕ ПРАВИЛО ДЕЛЕНИЯ Replace/Add, из-за которого разрез отвергается
 * ЦЕЛИКОМ. `Replace` требует, чтобы селектор УЖЕ был смонтирован
 * (DiamondCutLib.replaceFunctions → removeFunction → "Diamond: selector not
 * found"); `Add` требует ОБРАТНОГО — что селектора ещё нет ("Diamond: selector
 * exists"). Значит граница между списками определяется НЕ тем, что лежит в
 * скомпилированном ABI, а тем, ЧТО СЕЙЧАС МАРШРУТИЗИРУЕТ ЖИВОЙ ДАЙМОНД. Ровно
 * так устроен вчерашний разрез UpgradePresentationRecord.s.sol — 56 Replace и
 * 8 Add на одном и том же фасете.
 *
 * Списки объявлены руками (иначе их не проверить тестом), но НЕ приняты на
 * слово: пред-полёт сверяет каждый из трёх с живой цепью через loupe, а
 * test/ArbiterAccountabilityUpgrade.t.sol — со скомпилированным ABI обоих
 * фасетов. Ошибка в списке обязана выясниться ДО броадкаста, а не боевой
 * транзакцией.
 *
 * Состояние цепи на 15 августа 2026 (сверено чтением, а не памятью):
 *   всего смонтировано               177 селекторов, 11 фасетов
 *   ArbiterRegistryFacet             0x1CF4c7DaA27f2241eafd8E818329719418403013, 64 селектора
 *   арбитров                         1 (0x42dCd14e…), банк 6 000 000, пол 10 000 000
 * После разреза: 177 + 23 − 1 = 199 селекторов, 12 фасетов.
 *
 * ── Что именно приезжает ──────────────────────────────────────────────────
 * Задача 1  провенанс посадки            getSeatedBy / getSeatedCountBy
 * Задача 2  потолок блока директора      getChiefBloc
 * Задача 3  потолок споров на арбитра    getMaxClaimsPerArbiter
 * Задача 5  судейский стаж               getCleanVerdicts, getMaxArbiterMistakes
 * Задачи 4-9 — весь ArbiterAccountabilityFacet: приостановка, снос с поводом,
 *             предложение директора, право ответа снятого, положение арбитра.
 * Задача 6  сняла голую removeArbiter    ← единственный Remove этого разреза
 *
 * ── Почему одним cut'ом, а не четырьмя вызовами ───────────────────────────
 * Между действиями даймонд не должен оказаться в состоянии «код новый, входов
 * нет» или, того хуже, «голая removeArbiter ещё жива, а снос с поводом уже
 * рекламируется фронтом». Одна транзакция — одно состояние до и одно после.
 *
 * ── Пред/пост-полёт ───────────────────────────────────────────────────────
 * Форма — UpgradePresentationRecord.s.sol (15 августа 2026). Replace на адрес,
 * у которого нужного селектора нет, НЕ ревертит: DiamondCutLib проверяет
 * только «адрес другой и есть код», не «реализует ли он этот селектор». Это
 * тихий разъезд «смонтировано, но не работает» — ровно того класса, что уже
 * ломал fundDispute на msg.sender вместо _msgSender() (d172064): задеплоено,
 * ни разу не сработало, заметили через месяц. Поэтому:
 *   ДО broadcast  — вся группа Replace целится в ОДИН реально смонтированный
 *                   адрес; ни один Add-селектор не смонтирован; removeArbiter
 *                   смонтирован (иначе удалять нечего и разрез уже не тот,
 *                   который писался);
 *   ПОСЛЕ         — Replace/Add легли на свои новые адреса, старый адрес
 *                   опустел, счёт селекторов сдвинулся ровно на +Add−Remove,
 *                   ГОЛАЯ removeArbiter МЕРТВА (низкоуровневый вызов через
 *                   даймонд обязан не пройти), а приостановка отвечает через
 *                   даймонд РОВНО 72 часами — сверяется значение, а не факт
 *                   возврата: окно объявлено в контракте и только там, фронт
 *                   берёт его из цепи и рисует человеку «столько держит».
 *
 * ── Целостность хранилища ─────────────────────────────────────────────────
 * Всё перечисленное проверяет МАРШРУТИЗАЦИЮ и ни одного значения, уже лежащего
 * в арбитражном неймспейсе, не читает. Это тот самый класс, что в июле 2026
 * сломал JobBoard: getOpenJobs() начал ревертить Panic(0x22) на живом
 * хранилище после смены раскладки, а статические гейты этого не видели.
 * Задачи 1, 4, 5, 7 и 8 дописали в конец ArbiterRegistryStorage.Data ШЕСТЬ
 * полей — ровно тот тип правки, который этот класс и порождает. Поэтому
 * getArbiters().length, getVaultBalance() и getArbiterFloor() читаются ДО
 * vm.startBroadcast и снова ПОСЛЕ, с require на равенство.
 *
 * ── Миграция провенанса — ОТДЕЛЬНОЙ ТРАНЗАКЦИЕЙ ПОСЛЕ РАЗРЕЗА ─────────────
 * В цепи один арбитр, посаженный рукой владельца, но поле «кто посадил» у него
 * пустое: поля не существовало в момент посадки. Пустое seatedBy читается как
 * «сел сам через applyAsArbiter» (ArbiterRegistryFacet:646) — то есть цепь
 * говорит о человеке неправду, и вдобавок потолок блока директора
 * (_chiefBloc) считает его мимо. Backfill идёт ВТОРОЙ транзакцией, а не
 * внутри cut'а, по одной причине: разрез должен быть обратим сам по себе.
 * Откат разреза — это diamondCut обратно на старые адреса; если бы backfill
 * ехал init-калдатой того же cut'а, откат маршрутов не откатил бы записанные
 * данные, и «вернуть как было» перестало бы быть одним действием.
 *
 * Список арбитров читается ИЗ ЦЕПИ (getArbiters()), а не зашит в скрипт:
 * зашитый адрес — это утверждение о составе корпуса, сделанное в момент
 * написания скрипта и никем не перепроверяемое в момент запуска.
 */
contract UpgradeArbiterAccountability is Script {
    /// Окно приостановки — 72 часа (утверждено владельцем 15 августа 2026).
    /// Объявлено в ArbiterAccountabilityFacet, здесь только сверяется.
    uint256 internal constant EXPECTED_SUSPENSION_WINDOW = 72 hours;

    /// removeArbiter(address) — удалена из фасета задачей 6 (15 августа 2026),
    /// поэтому символа `.selector` для неё больше не существует и селектор
    /// записан литералом. То же значение и в тех же словах стоит в четырнадцати
    /// архивных скриптах: `cast sig "removeArbiter(address)"` = 0x3487e08c.
    /// Тест считает его независимо, из keccak подписи, — сверка литерала с
    /// литералом была бы тавтологией.
    bytes4 internal constant REMOVE_ARBITER_SELECTOR = bytes4(0x3487e08c);

    /// Адрес-мишень пост-полётной проверки «голая кнопка мертва». Любой
    /// ненулевой: до разреза вызов дошёл бы до фасета и упал уже на
    /// прикладной проверке, после разреза обязан не найти маршрут вовсе.
    address internal constant DEAD_BUTTON_PROBE = address(0xA1);

    function run() external {
        address diamond = vm.envAddress("DIAMOND_ADDRESS");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        require(diamond != address(0), "DIAMOND_ADDRESS not set");

        bytes4[] memory replaceSels = replaceSelectors();
        bytes4[] memory addSels     = addSelectors();
        bytes4[] memory removeSels  = removeSelectors();

        // ── Pre-flight ────────────────────────────────────────────────────
        console.log("=== UpgradeArbiterAccountability: pre-flight ===");
        address oldFacet = checkReplaceGroup(replaceSels, diamond);
        checkAddGroupUnmounted(addSels, diamond);
        address removeHost = checkRemoveGroupMounted(removeSels, diamond);
        console.log("Old ArbiterRegistryFacet currently mounted at:", oldFacet);
        console.log("Naked removeArbiter currently routed to:", removeHost);

        uint256 selectorsBefore = totalRoutedSelectors(diamond);
        console.log("Total routed selectors BEFORE cut:", selectorsBefore);
        console.log("Replace / Add / Remove:", replaceSels.length, addSels.length, removeSels.length);

        StorageSnapshot memory before = snapshotArbiterStorage(diamond);
        console.log("Arbiter storage BEFORE cut - arbiters:", before.arbiterCount);
        console.log("  vaultBalance:", before.vaultBalance);
        console.log("  arbiterFloor:", before.arbiterFloor);
        console.log("");

        // ── Апгрейд ───────────────────────────────────────────────────────
        vm.startBroadcast(pk);
        ArbiterRegistryFacet registryFacet = new ArbiterRegistryFacet();
        ArbiterAccountabilityFacet accountabilityFacet = new ArbiterAccountabilityFacet();
        IDiamondCut(diamond).diamondCut(
            buildCuts(address(registryFacet), address(accountabilityFacet)),
            address(0),
            ""
        );
        vm.stopBroadcast();

        console.log("New ArbiterRegistryFacet:", address(registryFacet));
        console.log("New ArbiterAccountabilityFacet:", address(accountabilityFacet));
        console.log("");

        // ── Post-flight: маршруты ─────────────────────────────────────────
        console.log("=== Post-flight ===");
        assertRouted(replaceSels, address(registryFacet), diamond);
        assertRouted(addRegistrySelectors(), address(registryFacet), diamond);
        assertRouted(addAccountabilitySelectors(), address(accountabilityFacet), diamond);
        assertFacetHoldsNoSelectors(oldFacet, diamond);
        console.log("Replace/Add landed on the new facets, old facet emptied.");

        assertNakedRemoveArbiterIsDead(diamond);
        console.log("Naked removeArbiter(address) no longer routes anywhere.");

        assertSuspensionWindowAnswers(diamond);
        console.log("Smoke getSuspensionWindow() through diamond returned 72h.");

        // ── Post-flight: хранилище ────────────────────────────────────────
        StorageSnapshot memory afterCut = snapshotArbiterStorage(diamond);
        assertStorageContinuity(before, afterCut);
        console.log("Arbiter storage AFTER cut  - arbiters:", afterCut.arbiterCount);
        console.log("  vaultBalance:", afterCut.vaultBalance);
        console.log("  arbiterFloor:", afterCut.arbiterFloor);
        console.log("Storage continuity OK: arbiters/vaultBalance/arbiterFloor unchanged by the cut.");

        uint256 selectorsAfter = totalRoutedSelectors(diamond);
        require(
            selectorsAfter == selectorsBefore + addSels.length - removeSels.length,
            unicode"post-flight: счёт смонтированных селекторов сдвинулся не ровно на +Add-Remove"
        );
        console.log("Total routed selectors AFTER cut:", selectorsAfter);
        console.log("");

        // ── Миграция провенанса — ВТОРАЯ транзакция ───────────────────────
        migrateProvenance(diamond, pk);
    }

    // ════════════════════════════════════════════════════════════════════
    // МИГРАЦИЯ ПРОВЕНАНСА
    // ════════════════════════════════════════════════════════════════════

    /// Аварийный вход: разрез уже лёг, а вторая транзакция не доехала — упала,
    /// кончился газ, оборвалась сессия. Повторный run() в этом состоянии
    /// откажет на пред-полёте, и правильно сделает: селекторы Add уже
    /// смонтированы, повторять разрез нечем и незачем. Этот вход делает ТОЛЬКО
    /// миграцию:
    ///   forge script script/UpgradeArbiterAccountability.s.sol \
    ///     --sig "migrateProvenanceOnly()" --rpc-url $BASE_SEPOLIA_RPC_URL
    /// Идемпотентен: если провенанс уже дописан, печатает «нечего мигрировать»
    /// и не шлёт ни одной транзакции.
    function migrateProvenanceOnly() external {
        address diamond = vm.envAddress("DIAMOND_ADDRESS");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        require(diamond != address(0), "DIAMOND_ADDRESS not set");
        migrateProvenance(diamond, pk);
    }

    /// Дописывает «кто посадил» тем арбитрам, у которых это поле пусто, потому
    /// что в момент их посадки поля не существовало.
    ///
    /// Зовётся ПОСЛЕ разреза и не может раньше: getSeatedBy — один из
    /// Add-селекторов этого же cut'а, до него даймонд на такой вызов отвечает
    /// "Diamond: function not found".
    ///
    /// Второй broadcast, то есть ВТОРАЯ транзакция в цепи, — намеренно (см.
    /// шапку файла: разрез обязан быть обратим сам по себе).
    ///
    /// Кем подписан backfill, тем он и записывается: владелец диамонда — та
    /// самая рука, что сажала. Адрес читается из цепи (OwnershipFacet.owner()),
    /// а не из окружения: PRIVATE_KEY может оказаться не тем ключом, и тогда
    /// diamondCut всё равно откажет — но записать в цепь чужое имя нельзя даже
    /// в попытке.
    function migrateProvenance(address diamond, uint256 pk) public {
        console.log("=== Provenance migration (separate transaction) ===");

        address[] memory all = ArbiterRegistryFacet(diamond).getArbiters();
        console.log("Arbiters on chain:", all.length);

        address[] memory pending = arbitersMissingProvenance(diamond);
        console.log("Arbiters missing provenance:", pending.length);
        for (uint256 i = 0; i < pending.length; i++) {
            console.log("  no seatedBy:", pending[i]);
        }
        if (pending.length == 0) {
            console.log("Nothing to migrate - skipping the second transaction entirely.");
            return;
        }

        address seater = OwnershipFacet(diamond).owner();
        console.log("Backfilling seatedBy with the diamond owner:", seater);

        uint256 seatedCountBefore = ArbiterRegistryFacet(diamond).getSeatedCountBy(seater);

        vm.startBroadcast(pk);
        ArbiterProvenanceInit init = new ArbiterProvenanceInit();
        IDiamondCut(diamond).diamondCut(
            new IDiamondCut.FacetCut[](0), // ни одного маршрута не трогаем
            address(init),
            abi.encodeCall(ArbiterProvenanceInit.backfillSeatedBy, (pending, seater))
        );
        vm.stopBroadcast();

        console.log("ArbiterProvenanceInit:", address(init));
        assertProvenanceMigrated(diamond, pending, seater, seatedCountBefore);
        console.log("Provenance migrated for", pending.length, "arbiter(s).");
    }

    /// Арбитры, у которых seatedBy пуст. Пустое поле означает ЛИБО самозапись
    /// через applyAsArbiter, ЛИБО посадку до появления поля — различить их
    /// цепь не может, и в этом вся проблема. Сегодня применимо к одному
    /// арбитру, посаженному рукой (самозапись заперта до включения ДАО и ни
    /// разу не срабатывала).
    ///
    /// ⚠️ Читает getSeatedBy — селектор, который монтируется этим же разрезом.
    /// До cut'а вызывать нельзя.
    function arbitersMissingProvenance(address diamond) public view returns (address[] memory pending) {
        ArbiterRegistryFacet f = ArbiterRegistryFacet(diamond);
        address[] memory all = f.getArbiters();

        uint256 count;
        bool[] memory hit = new bool[](all.length);
        for (uint256 i = 0; i < all.length; i++) {
            if (f.getSeatedBy(all[i]) != address(0)) continue;
            hit[i] = true;
            count++;
        }

        pending = new address[](count);
        uint256 k;
        for (uint256 i = 0; i < all.length; i++) {
            if (hit[i]) pending[k++] = all[i];
        }
    }

    /// Проверяет РЕЗУЛЬТАТ миграции, а не факт того, что транзакция прошла:
    /// каждому мигрированному записан именно этот адрес, и счётчик посадок
    /// вырос ровно на число мигрированных. Второе не декоративно — на
    /// seatedCountBy держится потолок блока директора, и backfill, забывший
    /// его поднять, оставил бы директору лишнее место навсегда.
    function assertProvenanceMigrated(
        address diamond,
        address[] memory migrated,
        address seater,
        uint256 seatedCountBefore
    ) public view {
        ArbiterRegistryFacet f = ArbiterRegistryFacet(diamond);
        for (uint256 i = 0; i < migrated.length; i++) {
            require(
                f.getSeatedBy(migrated[i]) == seater,
                unicode"post-migration: провенанс арбитра не записался"
            );
        }
        require(
            f.getSeatedCountBy(seater) == seatedCountBefore + migrated.length,
            unicode"post-migration: счётчик посадок вырос не ровно на число мигрированных"
        );
    }

    // ════════════════════════════════════════════════════════════════════
    // Пред/пост-полётные помощники — public, чтобы
    // test/ArbiterAccountabilityUpgrade.t.sol звал их напрямую против
    // локально развёрнутого даймонда, а не только через run() на живой цепи.
    // ════════════════════════════════════════════════════════════════════

    /// Каждый селектор группы смонтирован сейчас, и все указывают на ОДИН и тот
    /// же адрес — иначе список Replace выведен неверно (фасет уже разъехался по
    /// нескольким адресам, и Replace на единый новый адрес был бы неверной
    /// операцией). Возвращает этот адрес.
    function checkReplaceGroup(bytes4[] memory sels, address diamond)
        public view returns (address facetAddr)
    {
        require(sels.length > 0, unicode"UpgradeArbiterAccountability: группа Replace пуста");
        facetAddr = IDiamondLoupe(diamond).facetAddress(sels[0]);
        require(facetAddr != address(0), unicode"UpgradeArbiterAccountability: первый селектор Replace не смонтирован");
        for (uint256 i = 0; i < sels.length; i++) {
            address a = IDiamondLoupe(diamond).facetAddress(sels[i]);
            require(a != address(0), unicode"UpgradeArbiterAccountability: один из селекторов Replace не смонтирован");
            require(
                a == facetAddr,
                unicode"UpgradeArbiterAccountability: селекторы Replace разъехались больше чем по одному живому адресу фасета"
            );
        }
    }

    /// Ни один селектор группы ещё не смонтирован — иначе Add ревертит
    /// "Diamond: selector exists" в DiamondCutLib.addFunctions, и вся выкатка
    /// падает уже ПОСЛЕ броадкаста двух новых фасетов.
    function checkAddGroupUnmounted(bytes4[] memory sels, address diamond) public view {
        for (uint256 i = 0; i < sels.length; i++) {
            require(
                IDiamondLoupe(diamond).facetAddress(sels[i]) == address(0),
                unicode"UpgradeArbiterAccountability: селектор из Add уже где-то смонтирован — Add ревертнёт"
            );
        }
    }

    /// Удаляемый селектор обязан быть смонтирован — иначе Remove ревертит
    /// "Diamond: selector not found" (DiamondCutLib.removeFunction) и весь
    /// разрез отменяется. Отдельная причина не молчать: если removeArbiter уже
    /// снята кем-то, значит цепь не в том состоянии, для которого этот скрипт
    /// писался, и остальные его допущения тоже стоит перепроверить руками.
    /// Возвращает адрес, на котором она сидит.
    function checkRemoveGroupMounted(bytes4[] memory sels, address diamond)
        public view returns (address facetAddr)
    {
        require(sels.length > 0, unicode"UpgradeArbiterAccountability: группа Remove пуста");
        facetAddr = IDiamondLoupe(diamond).facetAddress(sels[0]);
        for (uint256 i = 0; i < sels.length; i++) {
            require(
                IDiamondLoupe(diamond).facetAddress(sels[i]) != address(0),
                unicode"UpgradeArbiterAccountability: удаляемый селектор не смонтирован — удалять нечего"
            );
        }
    }

    /// Каждый селектор группы ведёт на ожидаемый (новый) адрес фасета.
    function assertRouted(bytes4[] memory sels, address expected, address diamond) public view {
        for (uint256 i = 0; i < sels.length; i++) {
            require(
                IDiamondLoupe(diamond).facetAddress(sels[i]) == expected,
                unicode"UpgradeArbiterAccountability: селектор не приземлился на новый фасет"
            );
        }
    }

    /// У старого адреса фасета не осталось ни одного селектора — он вытеснен
    /// полностью, а не разъехался наполовину. Здесь это ещё и единственная
    /// проверка, которая заметила бы забытый в Replace селектор: 63 заменённых
    /// плюс один удалённый — это ровно те 64, что сидят на нём сегодня.
    function assertFacetHoldsNoSelectors(address facetAddr, address diamond) public view {
        require(
            IDiamondLoupe(diamond).facetFunctionSelectors(facetAddr).length == 0,
            unicode"UpgradeArbiterAccountability: у старого адреса фасета после разреза остались селекторы"
        );
    }

    /// Голая кнопка обязана быть мертва. Низкоуровневый вызов ЧЕРЕЗ ДАЙМОНД,
    /// а не чтение loupe: loupe отвечает по своей таблице, а здесь проверяется
    /// то, что видит человек с фронта или из кошелька — доходит ли вызов до
    /// кода вообще. Отказ ожидаем и является целью: fallback даймонда ревертит
    /// "Diamond: function not found".
    ///
    /// Почему это отдельная проверка, а не следствие Remove: элемент Remove мог
    /// быть собран с неверным селектором (опечатка в литерале), и тогда
    /// diamondCut успешно удалил бы ЧУЖОЙ селектор, а голая кнопка осталась бы
    /// живой — снос без повода, без записи кто нажал и с возвратом залога, то
    /// есть ровно то, ради устранения чего сделана вся работа.
    function assertNakedRemoveArbiterIsDead(address diamond) public {
        (bool ok, ) = diamond.call(
            abi.encodeWithSignature("removeArbiter(address)", DEAD_BUTTON_PROBE)
        );
        require(!ok, unicode"post-flight: голая removeArbiter всё ещё маршрутизируется после разреза");
    }

    /// Функциональный смоук: getSuspensionWindow() ЧЕРЕЗ ДАЙМОНД (не прямым
    /// вызовом фасета) исполняется и отдаёт РОВНО 72 часа.
    ///
    /// Сверяется значение, а не факт возврата: окно объявлено в контракте и
    /// только там, фронт спрашивает его у цепи и рисует человеку «столько
    /// держит приостановка». Диамонд, отвечающий другим числом — например
    /// потому, что Add лёг на чужой адрес с похожей сигнатурой, — маршрутно
    /// выглядит здоровым, а обещает неправду.
    function assertSuspensionWindowAnswers(address diamond) public view {
        require(
            ISuspensionWindowProbe(diamond).getSuspensionWindow() == EXPECTED_SUSPENSION_WINDOW,
            unicode"post-flight: окно приостановки не отвечает через диамонд"
        );
    }

    // ════════════════════════════════════════════════════════════════════
    // Целостность хранилища
    // ════════════════════════════════════════════════════════════════════

    struct StorageSnapshot {
        uint256 arbiterCount;
        uint256 vaultBalance;
        uint256 arbiterFloor;
    }

    /// Три чтения существующих полей арбитражного неймспейса ЧЕРЕЗ ДАЙМОНД.
    /// getArbiterFloor() возвращает DEFAULT_ARBITER_FLOOR, если поле нулевое
    /// (см. сам фасет) — это всё ещё чтение существующего поля: если раскладка
    /// сдвинется, значение прыгнет вместе с остальными.
    function snapshotArbiterStorage(address diamond) public view returns (StorageSnapshot memory s) {
        ArbiterRegistryFacet f = ArbiterRegistryFacet(diamond);
        s.arbiterCount = f.getArbiters().length;
        s.vaultBalance = f.getVaultBalance();
        s.arbiterFloor = f.getArbiterFloor();
    }

    /// Три значения, снятые ДО и ПОСЛЕ разреза, обязаны совпасть буквально —
    /// diamondCut ничего не должен писать в чужой неймспейс. Расхождение
    /// здесь — тот же класс сигнала, что Panic(0x22) на getOpenJobs() после
    /// смены раскладки JobBoard в июле 2026.
    function assertStorageContinuity(StorageSnapshot memory beforeCut, StorageSnapshot memory afterCut)
        public pure
    {
        require(
            afterCut.arbiterCount == beforeCut.arbiterCount,
            unicode"post-flight: getArbiters().length изменился поперёк разреза — раскладка могла сдвинуться"
        );
        require(
            afterCut.vaultBalance == beforeCut.vaultBalance,
            unicode"post-flight: getVaultBalance() изменился поперёк разреза — раскладка могла сдвинуться"
        );
        require(
            afterCut.arbiterFloor == beforeCut.arbiterFloor,
            unicode"post-flight: getArbiterFloor() изменился поперёк разреза — раскладка могла сдвинуться"
        );
    }

    function totalRoutedSelectors(address diamond) public view returns (uint256 total) {
        IDiamondLoupe.Facet[] memory all = IDiamondLoupe(diamond).facets();
        for (uint256 i = 0; i < all.length; i++) total += all[i].functionSelectors.length;
    }

    // ════════════════════════════════════════════════════════════════════
    // СОСТАВ РАЗРЕЗА
    // ════════════════════════════════════════════════════════════════════

    /// Четыре элемента: Replace и Add на реестр, Add на ответственность,
    /// Remove последним. Порядок Remove — последним — чтобы никакое
    /// последующее действие не могло вернуть удалённый селектор обратно:
    /// diamondCut применяет элементы по очереди.
    function buildCuts(address registryFacet, address accountabilityFacet)
        public pure returns (IDiamondCut.FacetCut[] memory cuts)
    {
        cuts = new IDiamondCut.FacetCut[](4);
        cuts[0] = _cut(registryFacet,       IDiamondCut.FacetCutAction.Replace, replaceSelectors());
        cuts[1] = _cut(registryFacet,       IDiamondCut.FacetCutAction.Add,     addRegistrySelectors());
        cuts[2] = _cut(accountabilityFacet, IDiamondCut.FacetCutAction.Add,     addAccountabilitySelectors());
        cuts[3] = _cut(address(0),          IDiamondCut.FacetCutAction.Remove,  removeSelectors());
    }

    /// Всё, что маршрутизирует живой даймонд СЕГОДНЯ, кроме removeArbiter:
    /// 56 селекторов деплоя 25 июля плюс 8, приехавших разрезом «цепь как
    /// свидетель предъявления» 15 августа, минус голая removeArbiter (она
    /// уходит в Remove). Полнота проверяется тестом против скомпилированного
    /// ABI и пред-полётом против цепи, не глазами.
    function replaceSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](63);

        // DAO-режим
        sels[0]  = ArbiterRegistryFacet.activateDAO.selector;
        sels[1]  = ArbiterRegistryFacet.applyAsArbiter.selector;
        sels[2]  = ArbiterRegistryFacet.resignAsArbiter.selector;

        // Admin: управление арбитрами (removeArbiter — в removeSelectors(), не здесь)
        sels[3]  = ArbiterRegistryFacet.setChiefArbiter.selector;
        sels[4]  = ArbiterRegistryFacet.addArbiter.selector;

        // Клейм спора (commit-reveal)
        sels[5]  = ArbiterRegistryFacet.commitDisputeClaim.selector;
        sels[6]  = ArbiterRegistryFacet.claimDispute.selector;
        sels[7]  = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        sels[8]  = ArbiterRegistryFacet.clearDisputeClaim.selector;

        // Вердикт
        sels[9]  = ArbiterRegistryFacet.submitVerdict.selector;
        sels[10] = ArbiterRegistryFacet.finalizeVerdict.selector;
        sels[11] = ArbiterRegistryFacet.overturnVerdict.selector;
        sels[12] = ArbiterRegistryFacet.notifyArbiterTimeout.selector;
        sels[13] = ArbiterRegistryFacet.freezeVerdict.selector;
        sels[14] = ArbiterRegistryFacet.unfreezeVerdict.selector;
        sels[15] = ArbiterRegistryFacet.clearStuckVerdict.selector;

        // Апелляция
        sels[16] = ArbiterRegistryFacet.raiseAppeal.selector;
        sels[17] = ArbiterRegistryFacet.voteOnAppeal.selector;
        sels[18] = ArbiterRegistryFacet.resolveAppeal.selector;

        // Вознаграждения
        sels[19] = ArbiterRegistryFacet.withdrawArbiterReward.selector;
        sels[20] = ArbiterRegistryFacet.fundVault.selector;
        sels[21] = ArbiterRegistryFacet.setRewardPerDispute.selector;
        sels[22] = ArbiterRegistryFacet.setDAOAddress.selector;

        // Views
        sels[23] = ArbiterRegistryFacet.isDaoActive.selector;
        sels[24] = ArbiterRegistryFacet.getMinXPToRegister.selector;
        sels[25] = ArbiterRegistryFacet.getDaoThreshold.selector;
        sels[26] = ArbiterRegistryFacet.getChiefArbiter.selector;
        sels[27] = ArbiterRegistryFacet.isRegisteredArbiter.selector;
        sels[28] = ArbiterRegistryFacet.getArbiters.selector;
        sels[29] = ArbiterRegistryFacet.getDisputeClaimer.selector;
        sels[30] = ArbiterRegistryFacet.getArbiterDeals.selector;
        sels[31] = ArbiterRegistryFacet.getClaimCommitment.selector;
        sels[32] = ArbiterRegistryFacet.getPendingVerdict.selector;
        sels[33] = ArbiterRegistryFacet.getArbiterReward.selector;
        sels[34] = ArbiterRegistryFacet.getVaultBalance.selector;
        sels[35] = ArbiterRegistryFacet.getRewardPerDispute.selector;
        sels[36] = ArbiterRegistryFacet.getDAOAddress.selector;
        sels[37] = ArbiterRegistryFacet.getArbiterMistakeStreak.selector;
        sels[38] = ArbiterRegistryFacet.hasSubmittedVerdict.selector;
        sels[39] = ArbiterRegistryFacet.getAppealVotes.selector;
        sels[40] = ArbiterRegistryFacet.hasVotedOnAppeal.selector;
        sels[41] = ArbiterRegistryFacet.getArbiterBond.selector;
        sels[42] = ArbiterRegistryFacet.getOpenClaimCount.selector;

        // Сбор со спора (3% от спорной суммы) — 80/20 арбитр/казна
        sels[43] = ArbiterRegistryFacet.creditDisputeFee.selector;
        sels[44] = ArbiterRegistryFacet.withdrawTreasurySlice.selector;
        sels[45] = ArbiterRegistryFacet.getTreasurySlice.selector;

        // Платный вызов арбитра: порог и котировка доплаты до него
        sels[46] = ArbiterRegistryFacet.setArbiterFloor.selector;
        sels[47] = ArbiterRegistryFacet.getArbiterFloor.selector;
        sels[48] = ArbiterRegistryFacet.quoteDisputeTopUp.selector;

        // Платный вызов арбитра: оплата и мягкий возврат доплаты
        sels[49] = ArbiterRegistryFacet.fundDispute.selector;
        sels[50] = ArbiterRegistryFacet.getDisputeBounty.selector;
        sels[51] = ArbiterRegistryFacet.withdrawDisputeBounty.selector;
        sels[52] = ArbiterRegistryFacet.getRefundableBounty.selector;

        // Ключи чата арбитра (4б, 9 августа 2026)
        sels[53] = ArbiterRegistryFacet.getArbiterChatKeys.selector;
        sels[54] = ArbiterRegistryFacet.setArbiterChatKey.selector;

        // Цепь как свидетель предъявления (4в-2 Выкатка 2, разрез 15 августа 2026)
        sels[55] = ArbiterRegistryFacet.getDisputeClaimedAt.selector;
        sels[56] = ArbiterRegistryFacet.recordNoResponse.selector;
        sels[57] = ArbiterRegistryFacet.getNoResponseAt.selector;
        sels[58] = ArbiterRegistryFacet.getNoResponseFloor.selector;
        sels[59] = ArbiterRegistryFacet.recordPresentationDigest.selector;
        sels[60] = ArbiterRegistryFacet.getPresentationDigests.selector;
        sels[61] = ArbiterRegistryFacet.getPresentationDigestCount.selector;
        sels[62] = ArbiterRegistryFacet.getPresentationDigestsPage.selector;
    }

    /// ВСЁ, что монтируется впервые: шесть новых входов старого фасета плюс
    /// весь новый фасет. Один список для пред-полёта (ни один из них не должен
    /// быть смонтирован) и для итогового счёта; на два адреса он разделяется
    /// уже в buildCuts().
    function addSelectors() public pure returns (bytes4[] memory sels) {
        bytes4[] memory reg = addRegistrySelectors();
        bytes4[] memory acc = addAccountabilitySelectors();
        sels = new bytes4[](reg.length + acc.length);
        uint256 k;
        for (uint256 i = 0; i < reg.length; i++) sels[k++] = reg[i];
        for (uint256 i = 0; i < acc.length; i++) sels[k++] = acc[i];
    }

    /// Новые входы, дописанные задачами 1-9 в СТАРЫЙ фасет. Их сегодня в
    /// даймонде нет, значит Add, а не Replace, — см. шапку файла.
    function addRegistrySelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](6);

        // Задача 1: провенанс посадки арбитра
        sels[0] = ArbiterRegistryFacet.getSeatedBy.selector;
        sels[1] = ArbiterRegistryFacet.getSeatedCountBy.selector;

        // Задача 2: блок директора — сколько мест он контролирует
        sels[2] = ArbiterRegistryFacet.getChiefBloc.selector;

        // Задача 3: потолок одновременных споров на арбитра
        sels[3] = ArbiterRegistryFacet.getMaxClaimsPerArbiter.selector;

        // Задача 5: судейский стаж и порог автоснятия
        sels[4] = ArbiterRegistryFacet.getCleanVerdicts.selector;
        sels[5] = ArbiterRegistryFacet.getMaxArbiterMistakes.selector;
    }

    /// Весь ArbiterAccountabilityFacet целиком — двенадцатый фасет даймонда.
    /// Полнота проверяется тестом против скомпилированного ABI: забытый Add
    /// означает функцию, которой в даймонде нет, то есть мёртвую кнопку во
    /// фронте.
    function addAccountabilitySelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](17);

        // Задача 4: приостановка — быстрая, обратимая, протухает сама
        sels[0]  = ArbiterAccountabilityFacet.suspendArbiter.selector;
        sels[1]  = ArbiterAccountabilityFacet.liftSuspension.selector;
        sels[2]  = ArbiterAccountabilityFacet.isSuspended.selector;
        sels[3]  = ArbiterAccountabilityFacet.getSuspendedUntil.selector;
        sels[4]  = ArbiterAccountabilityFacet.getSuspensionWindow.selector;

        // Задача 6: снос только с поводом (замена голой removeArbiter)
        sels[5]  = ArbiterAccountabilityFacet.removeArbiterForCause.selector;
        sels[6]  = ArbiterAccountabilityFacet.getMistakeThreshold.selector;
        sels[7]  = ArbiterAccountabilityFacet.getMaxArbiterMistakesMirror.selector;
        sels[8]  = ArbiterAccountabilityFacet.getDaoThresholdMirror.selector;

        // Задача 7: директор предлагает снос, не исполняет
        sels[9]  = ArbiterAccountabilityFacet.proposeRemoval.selector;
        sels[10] = ArbiterAccountabilityFacet.withdrawProposal.selector;
        sels[11] = ArbiterAccountabilityFacet.getRemovalProposal.selector;
        sels[12] = ArbiterAccountabilityFacet.hasLiveProposal.selector;
        sels[13] = ArbiterAccountabilityFacet.getProposalTTL.selector;

        // Задача 8: право ответа снятого
        sels[14] = ArbiterAccountabilityFacet.respondToRemoval.selector;
        sels[15] = ArbiterAccountabilityFacet.getRemovalReply.selector;

        // Задача 9: положение арбитра одним чтением
        sels[16] = ArbiterAccountabilityFacet.getArbiterStanding.selector;
    }

    /// Ровно один: голая removeArbiter(address). Просто убрать её из исходника
    /// мало — без Remove селектор остаётся смонтированным на СТАРЫЙ адрес, и
    /// кнопка продолжает работать после разреза старым кодом.
    function removeSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](1);
        sels[0] = REMOVE_ARBITER_SELECTOR;
    }

    function _cut(address facet, IDiamondCut.FacetCutAction action, bytes4[] memory sels)
        internal pure returns (IDiamondCut.FacetCut memory)
    {
        return IDiamondCut.FacetCut({
            facetAddress: facet,
            action: action,
            functionSelectors: sels
        });
    }
}
