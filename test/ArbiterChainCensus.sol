// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {CommonBase} from "forge-std/Base.sol";

// ============================================================
// ПЕРЕПИСЬ ЖИВОЙ ЦЕПИ — НЕЗАВИСИМЫЙ ОРАКУЛ ДЛЯ РАЗРЕЗОВ (задача 4.6,
// 16 августа 2026)
//
// ЗАЧЕМ ОН ПОЯВИЛСЯ. Стенды разрезов монтировали «сегодняшнюю раскладку цепи»
// из `upgrade.replaceSelectors()` — то есть выводили ПРОВЕРЯЕМОЕ из
// ПРОВЕРЯЮЩЕГО. Селектор, переложенный из Replace в Add, исчезал из стенда
// вместе со списком, и пред-полёт честно не находил его смонтированным.
// Замок сверялся сам с собой и был доволен всегда.
//
// Цена этого — весь разрез: `Replace` ревертит на несмонтированном селекторе
// ("Diamond: selector not found"), `Add` — на смонтированном ("Diamond:
// selector exists"). Ошибка в любую сторону отвергает боевую транзакцию уже
// ПОСЛЕ выкатки обоих фасетов.
//
// ЛИТЕРАЛ-СЧЁТЧИК НЕ СПАСАЕТ. `routedBefore == 10 + 64` — это счёт, а не
// тождество: он ловит одиночный переезд и не ловит ОБМЕН. Замер ревью задачи
// 4.5: переложить смонтированный `getArbiterChatKeys` в Add, несмонтированный
// `getCleanVerdicts` в Replace, поправив заодно литеральный список подписей —
// 843 зелёных, 0 красных, и разрез в бою отвергнут целиком.
//
// ЧТО ДЕЛАЕТ ЭТОТ ФАЙЛ. Отдаёт 64 селектора, СНЯТЫЕ С ЦЕПИ и закоммиченные
// данными (test/fixtures/chain-2026-08-16-arbiter-selectors.json, шапка там же:
// блок, дата, команда, адреса). Ожидаемое перестаёт браться из наших списков.
// Утверждения над ней формулируются ТОЖДЕСТВАМИ, а не количествами:
//   Replace ∪ Remove == перепись,  Add ∩ перепись == ∅.
//
// Подробности класса бага — docs/PROCESS.md, «Четвёртый способ: замок, который
// смотрится в зеркало».
//
// ⚠️ ПОЧЕМУ НЕ ФОРК ЦЕПИ. `vm.createSelectFork` был бы оракулом честнее
// некуда, но `forge test` перестал бы работать без сети и RPC-ключа. Перепись
// даёт то же самое за одно чтение, сделанное однажды и записанное в репозиторий.
// ============================================================
abstract contract ArbiterChainCensus is CommonBase {
    /// Перепись снята с ЭТОГО даймонда и ЭТОГО фасета — пиннится здесь, чтобы
    /// подменённый файл (перепись другого контракта, другой сети) не проехал
    /// молча. Значения обязаны совпадать с CLAUDE.md.
    address internal constant CENSUS_DIAMOND = 0x760F07367888C62f7c2Dfb619A5e534132855ce5;
    address internal constant CENSUS_FACET = 0x1CF4c7DaA27f2241eafd8E818329719418403013;

    string internal constant CENSUS_PATH = "test/fixtures/chain-2026-08-16-arbiter-selectors.json";

    /// Селекторы, смонтированные на старом ArbiterRegistryFacet в живой цепи.
    /// Шапка сверяется здесь же: адреса, счёт и непустота блока. Файл читается
    /// целиком каждым вызовом — 64 строки, цена измеряется микросекундами, а
    /// кеширование в storage потребовало бы не-view и сломало бы `public view`
    /// у тестов состава.
    function _chainCensus() internal view returns (bytes4[] memory out) {
        string memory json = vm.readFile(CENSUS_PATH);

        require(
            vm.parseJsonAddress(json, ".diamond") == CENSUS_DIAMOND,
            unicode"перепись снята не с того даймонда"
        );
        require(
            vm.parseJsonAddress(json, ".facet") == CENSUS_FACET,
            unicode"перепись снята не с того фасета"
        );
        require(vm.parseJsonUint(json, ".block") > 0, unicode"в шапке переписи нет номера блока");
        require(
            bytes(vm.parseJsonString(json, ".takenAt")).length > 0,
            unicode"в шапке переписи нет даты снятия"
        );

        string[] memory raw = vm.parseJsonStringArray(json, ".selectors");
        require(
            raw.length == vm.parseJsonUint(json, ".count"),
            unicode"шапка переписи обещает не столько селекторов, сколько в ней есть"
        );

        out = new bytes4[](raw.length);
        for (uint256 i = 0; i < raw.length; i++) {
            bytes memory b = vm.parseBytes(raw[i]);
            require(b.length == 4, unicode"в переписи строка не длиной в селектор");
            out[i] = bytes4(b);
        }
    }

    /// Восемь селекторов, приехавших разрезом «цепь как свидетель предъявления»
    /// (15 августа 2026), названные ЛИТЕРАЛЬНЫМИ ПОДПИСЯМИ. Ими перепись
    /// отматывается на шаг назад — до раскладки, которую тот разрез застал.
    ///
    /// ⚠️ ПОЧЕМУ ТЕКСТОМ, А НЕ `new UpgradePresentationRecord().addSelectors()`.
    /// Стенду разреза 10 августа нужно отмотать перепись на ДВА шага, и ради
    /// трёх строк пришлось бы РАЗВЕРНУТЬ второй скрипт в `setUp`. Замерено:
    /// лишний `new` в setUp сдвигает nonce тестового контракта, а с ним — адрес
    /// локально развёрнутого даймонда, и полный `forge test` начинает падать
    /// примерно раз в двадцать прогонов (2 из 40 против 0 из 40 без него).
    ///
    /// Механика, которую это вскрыло и о которой стоит знать: `vm.setEnv` —
    /// ПРОЦЕСС-ГЛОБАЛЕН, а сюиты `forge test` идут ПАРАЛЛЕЛЬНО. Три стенда
    /// разрезов пишут `DIAMOND_ADDRESS` и тут же читают его внутри `run()`.
    /// Гонка там есть всегда — она безобидна ровно потому, что все три суют в
    /// переменную ОДИН И ТОТ ЖЕ адрес: тестовый контракт у всех трёх на одном
    /// адресе, и последовательность `new` в их `setUp` совпадает. Стоит одной
    /// сюите развернуть на контракт больше — адрес её даймонда уезжает, чужая
    /// запись перестаёт совпадать со своей, и `run()` идёт лупой в контракт,
    /// который в ЕЁ EVM оказался чем-то другим: «EvmError: Revert» без слова о
    /// причине.
    ///
    /// Совпадение адресов — совпадение случайное, и держится оно на счётчике
    /// nonce. Детерминированный способ прогнать полный набор — `forge test -j 1`
    /// (проверено: гонки нет вовсе, цена — 0,9 с против 0,18 с).
    ///
    /// Что тут сверяется с чем: список ниже сверяется с боевым
    /// `upgrade.addSelectors()` тестом
    /// PresentationRecordUpgrade.t.sol::test_CensusRewindListMatchesTheCutsOwnAdd,
    /// а сам боевой — с теми же подписями в
    /// test_AddSelectorsAreTheEightNewSignatures. Разъехаться втихую им негде.
    function _presentationCutAddSelectors() internal pure returns (bytes4[] memory out) {
        out = new bytes4[](8);
        out[0] = bytes4(keccak256("getDisputeClaimedAt(address)"));
        out[1] = bytes4(keccak256("recordNoResponse(address)"));
        out[2] = bytes4(keccak256("getNoResponseAt(address)"));
        out[3] = bytes4(keccak256("getNoResponseFloor()"));
        out[4] = bytes4(keccak256("recordPresentationDigest(address,bytes32)"));
        out[5] = bytes4(keccak256("getPresentationDigests(address)"));
        out[6] = bytes4(keccak256("getPresentationDigestCount(address)"));
        out[7] = bytes4(keccak256("getPresentationDigestsPage(address,uint256,uint256)"));
    }

    function _censusContains(bytes4[] memory haystack, bytes4 needle) internal pure returns (bool) {
        for (uint256 i = 0; i < haystack.length; i++) {
            if (haystack[i] == needle) return true;
        }
        return false;
    }

    /// Перепись минус один селектор. Нужна стендам, которые монтируют часть
    /// раскладки на отдельный адрес (двойник голой кнопки).
    function _censusWithout(bytes4[] memory census, bytes4 excluded)
        internal
        pure
        returns (bytes4[] memory out)
    {
        require(_censusContains(census, excluded), unicode"вычитаемого селектора в переписи нет");
        out = new bytes4[](census.length - 1);
        uint256 k;
        for (uint256 i = 0; i < census.length; i++) {
            if (census[i] != excluded) out[k++] = census[i];
        }
    }

    /// ОТМОТКА ИСПОЛНЕННОГО РАЗРЕЗА НА ОДИН ШАГ НАЗАД.
    ///
    /// Перепись описывает цепь СЕГОДНЯ. Стендам двух УЖЕ ИСПОЛНЕННЫХ разрезов
    /// (10 и 15 августа 2026) нужна раскладка ДО них — а она из переписи
    /// выводится ровно: разрез добавил `added`, удалил `removed`, значит до
    /// него было `(состояние \ added) ∪ removed`.
    ///
    /// Почему это честный оракул, а не то же зеркало. Списки Add и Remove тех
    /// скриптов запёрты ЛИТЕРАЛЬНЫМИ ПОДПИСЯМИ в их собственных тестах (восемь
    /// подписей у разреза предъявления, одна у разреза ключа чата) — то есть
    /// текстом, а не `.selector` из тех же контрактов. Список Replace, ради
    /// которого стенд и строится, в отмотке НЕ участвует вовсе: именно он
    /// и проверяется.
    function _rewindCut(bytes4[] memory state, bytes4[] memory added, bytes4[] memory removed)
        internal
        pure
        returns (bytes4[] memory out)
    {
        for (uint256 i = 0; i < added.length; i++) {
            require(
                _censusContains(state, added[i]),
                unicode"отмотка: добавленного разрезом селектора нет в раскладке после него"
            );
        }
        for (uint256 i = 0; i < removed.length; i++) {
            require(
                !_censusContains(state, removed[i]),
                unicode"отмотка: удалённый разрезом селектор всё ещё в раскладке после него"
            );
        }

        out = new bytes4[](state.length - added.length + removed.length);
        uint256 k;
        for (uint256 i = 0; i < state.length; i++) {
            if (!_censusContains(added, state[i])) out[k++] = state[i];
        }
        for (uint256 i = 0; i < removed.length; i++) out[k++] = removed[i];
    }
}
