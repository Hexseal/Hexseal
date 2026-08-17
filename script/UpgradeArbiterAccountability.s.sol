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
 * ОДИН diamondCut из ПЯТИ действий:
 *   Replace 52 → новый ArbiterRegistryFacet      (всё, что маршрутизируется
 *                                                 сегодня и остаётся в реестре)
 *   Replace 11 → новый ArbiterAccountabilityFacet (чтения, переехавшие туда
 *                                                 задачей 4.5 — они СМОНТИРОВАНЫ
 *                                                 сегодня, потому Replace)
 *   Add      3 → тот же новый ArbiterRegistryFacet (входы задач 2, 3 и 5,
 *                                                 оставшиеся в реестре)
 *   Add     21 → ArbiterAccountabilityFacet       (весь фасет целиком: 18 своих
 *                                                 плюс 3 переехавших, которых в
 *                                                 цепи ещё нет)
 *   Remove   1 → address(0): removeArbiter(address), 0x3487e08c
 *
 * ⚠️ ПОЧЕМУ ПЯТЬ ЭЛЕМЕНТОВ. И Replace, и Add едут на ДВА РАЗНЫХ адреса, а один
 * элемент FacetCut несёт ровно один адрес — поэтому ни та, ни другая группа не
 * может быть одной записью. Remove — пятый по счёту повод для отдельного
 * элемента: он требует `facetAddress == address(0)`
 * (DiamondCutLib.removeFunctions, "Diamond: remove needs zero address"), то
 * есть смешать его с чем-либо нельзя в принципе.
 *
 * ⚠️ ЗАДАЧА 4.5 (16 августа 2026) — РАЗГРУЗКА РЕЕСТРА. ArbiterRegistryFacet
 * упёрся в потолок EIP-170 (24 516 из 24 576, свободно 60), и задача 5 в него
 * физически не помещалась. Четырнадцать ЧТЕНИЙ переехали в фасет
 * ответственности: реестр 24 516 → 23 238 (запас 1 338), ответственность
 * 4 500 → 6 327. Селекторов у реестра 69 → 55, у ответственности 17 → 31;
 * ОБЩЕЕ МНОЖЕСТВО СЕЛЕКТОРОВ ДАЙМОНДА НЕ ИЗМЕНИЛОСЬ — 86 до и 86 после,
 * побайтно то же множество. Снаружи перенос не виден: тот же адрес прокси, тот
 * же селектор, тот же ответ.
 *
 * Одиннадцать из четырнадцати смонтированы в цепи сегодня → Replace на новый
 * адрес. Три (getSeatedBy, getSeatedCountBy, getCleanVerdicts) не смонтированы
 * → остаются Add, просто в другом списке. Итог по числам не сдвинулся:
 * Add было 6+17=23, стало 3+20=23.
 *
 * ⚠️ ЗАДАЧА 1 ПЛАНА removal-due-process (17 августа 2026) — ПРИЧИНА СЛОВАМИ.
 * Add-группа ответственности 20 → 21: приехал getMaxReasonBytes, потолок слов в
 * БАЙТАХ. Той же работой сменились ПОДПИСИ трёх входов этой же группы
 * (removeArbiterForCause и proposeRemoval получили `string reason`,
 * respondToRemoval — `string reply`), и это НЕ переводит их в Replace: ни один
 * из трёх в цепи не смонтирован, разрез ещё не сделан. Сменилось только
 * ЗНАЧЕНИЕ селектора внутри Add-группы, и подхватил его компилятор — списки
 * ниже берут `.selector` от типа. Литеральные подписи в
 * test/ArbiterAccountabilityUpgrade.t.sol переписаны руками: там и стоит
 * замок, который замечает смену подписи (цепь на этот счёт молчит, потому что
 * этих селекторов у неё нет ни до, ни после).
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
 * После разреза: 177 + 24 − 1 = 200 селекторов, 12 фасетов. Задача 4.5 это
 * число НЕ сдвинула: она переложила селекторы между фасетами, не добавив и не
 * убрав ни одного. Старый адрес по-прежнему опустошается ровно: 63 Replace
 * (52 + 11) плюс 1 Remove — те самые 64, что сидят на нём сегодня.
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

    /// Собственное имя скрипта. Нужно НЕ для логов, а для того, чтобы перепись
    /// цепи могла назвать, ДЛЯ КОГО она снята (уборка 7а, п. 4, Ruling 33).
    ///
    /// Ловушка, ради которой это заведено, — не «перепись устареет», а
    /// «кто-то возьмёт СТАРУЮ перепись для НОВОГО скрипта разреза». Такой
    /// человек напишет второй скрипт и скопирует стенд этого; литеральную
    /// строку в стенде он скопировал бы вместе с остальным и ничего бы не
    /// заметил. Значение, взятое у САМОГО ПРОВЕРЯЕМОГО скрипта, копированием
    /// не переносится: у нового скрипта оно своё, а `forScript` в переписи —
    /// прежний, и стенд краснеет детерминированно и БЕЗ обращения к сети.
    ///
    /// Строка обязана совпадать с полем `forScript` в
    /// test/fixtures/chain-2026-08-16-arbiter-selectors.json.
    function scriptPath() public pure returns (string memory) {
        return "script/UpgradeArbiterAccountability.s.sol";
    }

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
        // Удаляемый селектор обязан сидеть на ТОМ ЖЕ фасете, что и вся группа
        // Replace. Иначе Remove тихо выдернет чужой селектор с ЧУЖОГО фасета, и
        // не заметит этого ничто: голая кнопка честно мертва, счёт +Add-Remove
        // сходится, а assertFacetHoldsNoSelectors спрашивает только хост группы
        // Replace. Разрез прошёл бы зелёным и попутно оторвал кусок от чужого
        // фасета. Найдено ревью круга 1: до этой строки инвариант ПЕЧАТАЛСЯ, то
        // есть держался на том, что человек сличит строку глазами.
        require(
            removeHost == oldFacet,
            unicode"pre-flight: removeArbiter сидит не на том фасете, что группа Replace"
        );
        console.log("Old ArbiterRegistryFacet currently mounted at:", oldFacet);
        console.log("Naked removeArbiter currently routed to the same facet:", removeHost);

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
        assertRouted(replaceRegistrySelectors(), address(registryFacet), diamond);
        assertRouted(replaceAccountabilitySelectors(), address(accountabilityFacet), diamond);
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

        // ⚠️ Каст на ArbiterAccountabilityFacet, а не на ArbiterRegistryFacet
        // (задача 4.5, 16 августа 2026): провенанс ЧИТАЕТСЯ теперь оттуда.
        // Адрес тот же — это диамонд; каст здесь только называет ABI, по
        // которому кодируется вызов. Пишет провенанс по-прежнему реестр
        // (addArbiter/clearSeat) и init-контракт миграции.
        uint256 seatedCountBefore = ArbiterAccountabilityFacet(diamond).getSeatedCountBy(seater);

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
        // Состав корпуса читается у реестра, провенанс — у фасета
        // ответственности (задача 4.5). Адрес один и тот же — диамонд.
        address[] memory all = ArbiterRegistryFacet(diamond).getArbiters();
        ArbiterAccountabilityFacet f = ArbiterAccountabilityFacet(diamond);

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
        ArbiterAccountabilityFacet f = ArbiterAccountabilityFacet(diamond);
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

    /// ПЯТЬ элементов: Replace на реестр, Replace на ответственность, Add на
    /// реестр, Add на ответственность, Remove последним. Порядок Remove —
    /// последним — чтобы никакое последующее действие не могло вернуть
    /// удалённый селектор обратно: diamondCut применяет элементы по очереди.
    ///
    /// ⚠️ ПЯТЫЙ ЭЛЕМЕНТ ПОЯВИЛСЯ ЗАДАЧЕЙ 4.5 (16 августа 2026). Одиннадцать
    /// чтений переехали из реестра в фасет ответственности, и они СМОНТИРОВАНЫ
    /// В ЦЕПИ СЕГОДНЯ — значит операция над ними по-прежнему `Replace` (селектор
    /// в даймонде есть, меняется только адрес), но целится он на ДРУГОЙ адрес,
    /// чем остальные 52. Один элемент FacetCut несёт ровно один адрес, поэтому
    /// Replace физически не может остаться одной записью — ровно та же причина,
    /// по которой Add уже был разделён надвое.
    ///
    /// Цена ошибки в делении: `Add` ревертит "Diamond: selector exists" на уже
    /// смонтированном, `Replace` — "Diamond: selector not found" на
    /// несмонтированном. Любая из двух роняет ВЕСЬ разрез одной боевой
    /// транзакцией. Род каждого селектора выведен по спискам этого файла и
    /// проверяется пред-полётом против живой цепи.
    function buildCuts(address registryFacet, address accountabilityFacet)
        public pure returns (IDiamondCut.FacetCut[] memory cuts)
    {
        cuts = new IDiamondCut.FacetCut[](5);
        cuts[0] = _cut(registryFacet,       IDiamondCut.FacetCutAction.Replace, replaceRegistrySelectors());
        cuts[1] = _cut(accountabilityFacet, IDiamondCut.FacetCutAction.Replace, replaceAccountabilitySelectors());
        cuts[2] = _cut(registryFacet,       IDiamondCut.FacetCutAction.Add,     addRegistrySelectors());
        cuts[3] = _cut(accountabilityFacet, IDiamondCut.FacetCutAction.Add,     addAccountabilitySelectors());
        cuts[4] = _cut(address(0),          IDiamondCut.FacetCutAction.Remove,  removeSelectors());
    }

    /// ВСЁ, что маршрутизирует живой даймонд СЕГОДНЯ, кроме removeArbiter:
    /// 56 селекторов деплоя 25 июля плюс 8, приехавших разрезом «цепь как
    /// свидетель предъявления» 15 августа, минус голая removeArbiter (она
    /// уходит в Remove). Полнота проверяется тестом против скомпилированного
    /// ABI и пред-полётом против цепи, не глазами.
    ///
    /// ⚠️ РАЗДЕЛЁН НА ДВЕ ПОЛОВИНЫ (задача 4.5, 16 августа 2026), потому что
    /// они едут на РАЗНЫЕ АДРЕСА. Одиннадцать чтений про поведение арбитра
    /// переехали в ArbiterAccountabilityFacet; они СМОНТИРОВАНЫ В ЦЕПИ
    /// СЕГОДНЯ, поэтому остаются `Replace` — меняется только адрес фасета, не
    /// наличие селектора. Соблазн переложить их в Add смертелен: `Add` ревертит
    /// "Diamond: selector exists" на уже смонтированном, и падает ВЕСЬ разрез
    /// одной боевой транзакцией.
    ///
    /// Этот общий список остаётся и остаётся ЕДИНЫМ: пред-полёт
    /// checkReplaceGroup требует, чтобы все его селекторы сидели на ОДНОМ
    /// адресе, и сегодня это верно для объединения — обе половины лежат на
    /// старом ArbiterRegistryFacet. Разделяется он только в buildCuts().
    function replaceSelectors() public pure returns (bytes4[] memory sels) {
        bytes4[] memory reg = replaceRegistrySelectors();
        bytes4[] memory acc = replaceAccountabilitySelectors();
        sels = new bytes4[](reg.length + acc.length);
        uint256 k;
        for (uint256 i = 0; i < reg.length; i++) sels[k++] = reg[i];
        for (uint256 i = 0; i < acc.length; i++) sels[k++] = acc[i];
    }

    /// Половина Replace, которая остаётся на реестре: состав корпуса, споры,
    /// вердикты, апелляции, деньги.
    function replaceRegistrySelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](52);

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
        sels[30] = ArbiterRegistryFacet.getClaimCommitment.selector;
        sels[31] = ArbiterRegistryFacet.getPendingVerdict.selector;
        sels[32] = ArbiterRegistryFacet.getVaultBalance.selector;
        sels[33] = ArbiterRegistryFacet.getRewardPerDispute.selector;
        sels[34] = ArbiterRegistryFacet.getDAOAddress.selector;
        sels[35] = ArbiterRegistryFacet.hasSubmittedVerdict.selector;
        sels[36] = ArbiterRegistryFacet.getAppealVotes.selector;
        sels[37] = ArbiterRegistryFacet.hasVotedOnAppeal.selector;

        // Сбор со спора (3% от спорной суммы) — 80/20 арбитр/казна
        sels[38] = ArbiterRegistryFacet.creditDisputeFee.selector;
        sels[39] = ArbiterRegistryFacet.withdrawTreasurySlice.selector;
        sels[40] = ArbiterRegistryFacet.getTreasurySlice.selector;

        // Платный вызов арбитра: порог и котировка доплаты до него
        sels[41] = ArbiterRegistryFacet.setArbiterFloor.selector;
        sels[42] = ArbiterRegistryFacet.getArbiterFloor.selector;
        sels[43] = ArbiterRegistryFacet.quoteDisputeTopUp.selector;

        // Платный вызов арбитра: оплата и мягкий возврат доплаты
        sels[44] = ArbiterRegistryFacet.fundDispute.selector;
        sels[45] = ArbiterRegistryFacet.getDisputeBounty.selector;
        sels[46] = ArbiterRegistryFacet.withdrawDisputeBounty.selector;
        sels[47] = ArbiterRegistryFacet.getRefundableBounty.selector;

        // Ключи чата арбитра (4б, 9 августа 2026) — ЗАПИСЬ осталась здесь,
        // чтение (getArbiterChatKeys) уехало, см. половину ниже.
        sels[48] = ArbiterRegistryFacet.setArbiterChatKey.selector;

        // Цепь как свидетель предъявления (4в-2 Выкатка 2, разрез 15 августа
        // 2026) — здесь остались ЗАПИСИ и геттер константы NO_RESPONSE_FLOOR
        // (её применяет recordNoResponse в этом же файле, переезд геттера
        // потребовал бы второго объявления числа).
        sels[49] = ArbiterRegistryFacet.recordNoResponse.selector;
        sels[50] = ArbiterRegistryFacet.getNoResponseFloor.selector;
        sels[51] = ArbiterRegistryFacet.recordPresentationDigest.selector;
    }

    /// Половина Replace, которая ПЕРЕЕЗЖАЕТ на ArbiterAccountabilityFacet
    /// (задача 4.5, 16 августа 2026). Все одиннадцать смонтированы в цепи
    /// сегодня на старом ArbiterRegistryFacet — потому Replace, а не Add.
    ///
    /// Что это за функции: чтения про ПОВЕДЕНИЕ арбитра, его ПОЛОЖЕНИЕ и
    /// ДОКАЗАТЕЛЬСТВА. Тела перенесены без единой правки — снаружи даймонда
    /// перенос не виден вовсе, отвечает тот же адрес прокси тем же ответом.
    function replaceAccountabilitySelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](11);

        // Поведение и положение арбитра
        sels[0]  = ArbiterAccountabilityFacet.getArbiterMistakeStreak.selector;
        sels[1]  = ArbiterAccountabilityFacet.getArbiterBond.selector;
        sels[2]  = ArbiterAccountabilityFacet.getOpenClaimCount.selector;
        sels[3]  = ArbiterAccountabilityFacet.getArbiterReward.selector;
        sels[4]  = ArbiterAccountabilityFacet.getArbiterDeals.selector;

        // Доказательства: ключи чата, якорь предъявления, запись о молчании,
        // отпечатки
        sels[5]  = ArbiterAccountabilityFacet.getArbiterChatKeys.selector;
        sels[6]  = ArbiterAccountabilityFacet.getDisputeClaimedAt.selector;
        sels[7]  = ArbiterAccountabilityFacet.getNoResponseAt.selector;
        sels[8]  = ArbiterAccountabilityFacet.getPresentationDigests.selector;
        sels[9]  = ArbiterAccountabilityFacet.getPresentationDigestCount.selector;
        sels[10] = ArbiterAccountabilityFacet.getPresentationDigestsPage.selector;
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

    /// Новые входы, дописанные задачами 1-9 и ОСТАВШИЕСЯ в реестре. Их сегодня
    /// в даймонде нет, значит Add, а не Replace, — см. шапку файла.
    ///
    /// ⚠️ Было шесть, стало три (задача 4.5, 16 августа 2026): getSeatedBy,
    /// getSeatedCountBy и getCleanVerdicts уехали в фасет ответственности.
    /// Они НЕ смонтированы в цепи, поэтому переезд не меняет операцию — Add
    /// остаётся Add, просто в другом списке и на другой адрес.
    ///
    /// getChiefBloc осталась потому, что зовёт приватную _chiefBloc, которую
    /// держит addArbiter, — переезд стоил бы второй копии тела.
    /// getMaxClaimsPerArbiter и getMaxArbiterMistakes остались потому, что
    /// читают ПРИВАТНЫЕ КОНСТАНТЫ реестра, применяемые остающимся там кодом:
    /// переезд геттера завёл бы второе объявление числа, и наружу отвечало бы
    /// зеркало, а правило применялось бы по оригиналу. Для
    /// getMaxArbiterMistakes это вдобавок выродило бы
    /// test_MistakeThresholdMatchesRegistry в сверку зеркала с самим собой.
    function addRegistrySelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](3);

        // Задача 2: блок директора — сколько мест он контролирует
        sels[0] = ArbiterRegistryFacet.getChiefBloc.selector;

        // Задача 3: потолок одновременных споров на арбитра
        sels[1] = ArbiterRegistryFacet.getMaxClaimsPerArbiter.selector;

        // Задача 5: порог автоснятия
        sels[2] = ArbiterRegistryFacet.getMaxArbiterMistakes.selector;
    }

    /// Весь ArbiterAccountabilityFacet целиком — двенадцатый фасет даймонда.
    /// Полнота проверяется тестом против скомпилированного ABI: забытый Add
    /// означает функцию, которой в даймонде нет, то есть мёртвую кнопку во
    /// фронте.
    function addAccountabilitySelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](22);

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

        // Задача 4.5 (16 августа 2026): три чтения, переехавшие из реестра и
        // при этом ЕЩЁ НЕ СМОНТИРОВАННЫЕ в цепи — потому Add, а не Replace.
        // Остальные одиннадцать переехавших смонтированы и едут группой
        // replaceAccountabilitySelectors(). Род каждого определён по спискам
        // этого файла и пред-полётом против цепи, не по интуиции.
        sels[17] = ArbiterAccountabilityFacet.getSeatedBy.selector;
        sels[18] = ArbiterAccountabilityFacet.getSeatedCountBy.selector;
        sels[19] = ArbiterAccountabilityFacet.getCleanVerdicts.selector;

        // Причина словами (замысел 17 августа 2026, решение 7): потолок в
        // БАЙТАХ, спрашивается у цепи, а не хранится копией во фронте.
        sels[20] = ArbiterAccountabilityFacet.getMaxReasonBytes.selector;

        // The 48-hour pause (design of 17 August 2026, decision 2): removal
        // runs only through a proposal that has sat. The reading is mounted so
        // the form asks the chain for the number instead of keeping a copy that
        // drifts and shows the button as live an hour before it works.
        sels[21] = ArbiterAccountabilityFacet.getRemovalDelay.selector;
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
