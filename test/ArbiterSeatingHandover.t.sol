// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// «Никаких ручных» — дословное решение владельца, задача 6 плана
// arbiter-accountability (15 августа 2026), принятое ПОСЛЕ написания брифа:
// «ручные арбитры должны будут конвертироваться в дао арбитров, а директор
// упразднится, человек должен выйти и остаться только даймонд, который
// пропускает по гейту». При активном ДАО у человека не остаётся ни одной
// двери в корпус:
//   • addArbiter      — ревертит SeatingHandedOver(), вход только через
//                        applyAsArbiter (самозапись по гейту XP/cleanStreak/
//                        бонда);
//   • setChiefArbiter — ревертит той же ошибкой, роль директора упраздняется.
//
// Приостановка (suspendArbiter/liftSuspension в ArbiterAccountabilityFacet)
// сюда НЕ входит намеренно — она обратимая и протухает сама, владелец её не
// теряет.
//
// activateDAO() дополнительно требует уже назначенного daoAddress — без этой
// проверки владелец мог бы включить ДАО раньше, чем назвал преемника, и
// осиротить корпус одной транзакцией (activateDAO необратим, флаг не гасится
// нигде в src/): removeArbiterForCause, addArbiter, setChiefArbiter потеряли
// бы владельца без единого адреса, который мог бы их заменить.
//
// ═══ C-3 (ревью, круг правок 1, 15 августа 2026) ═══
// setDAOAddress остался бы обходом всего храповика: activateDAO() →
// setDAOAddress(свой_адрес) → removeArbiterForCause проходит по ветке
// msg.sender == daoAddress — владелец вернул бы себе снос ОДНОЙ лишней
// транзакцией, и «человек вышел» осталось бы верным только для одной из двух
// дверей. Починено: до активации ДАО зовёт владелец (называет преемника
// заранее), после — только ТЕКУЩИЙ daoAddress (самомиграция). Владелец,
// пытающийся назначить адрес после активации, получает NotCurrentDaoAddress.
//
// ═══ Круг правок 2 (переревью, 15 августа 2026) — стык C-3×M-9 ═══
// Починки круга 1 встретились и породили новую ловушку: isDaoActive()
// включается САМА по заработанному порогу (uniqueActiveUsers >= DAO_THRESHOLD,
// M-9), в обход activateDAO() и его защиты DaoAddressNotSet (та стоит только
// ВНУТРИ activateDAO()). Если ДАО включилась заработанным путём при ещё
// нулевом daoAddress, а храповик setDAOAddress слушал бы просто isDaoActive()
// (как после круга 1), «звать может только текущий daoAddress» превращалось
// бы в «звать может только address(0)» — то есть никто и никогда: обе двери
// осиротели бы необратимо. Починено добавлением `&& d.daoAddress !=
// address(0)` — храповик защёлкивается только когда преемник уже есть,
// физически кому передать право.
//
// Лёгкий стенд: фасет развёрнут отдельно, диамонда не нужно (тот же приём,
// что у test/ArbiterProvenance.t.sol). В отличие от ArbiterRemovalForCause.t.sol
// слоты добывать не пришлось для setDAOAddress/activateDAO/addArbiter/
// setChiefArbiter — обычные функции этого фасета. Для заработанного ДАО нужен
// слот uniqueActiveUsers в ReputationStorage (8) — тот же, что добыт перебором
// в test/ArbiterRemovalForCause.t.sol (не переоткрывается, тот же метод дал
// бы то же число). Третий тест круга 2 (связка целиком — снос по поводу
// заработавший на назначенном преемнике) живёт в
// test/ArbiterRemovalForCauseIntegration.t.sol: ему нужен removeArbiterForCause,
// а тот — ArbiterAccountabilityFacet, другой контракт с другим хранилищем в
// этом лёгком стенде.

import "forge-std/Test.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";

contract ArbiterSeatingHandoverTest is Test {
    ArbiterRegistryFacet facet;

    address owner;

    /// Слот владельца даймонда — тот же, что в test/ArbiterProvenance.t.sol
    /// (DiamondStorage.POSITION + 4), пересчитан и проверен запуском там же.
    bytes32 constant OWNER_SLOT = 0x178642b411f9f4783b21ef338f3e96db6c1272d763f0b7500ec93464dafb8604;

    /// ReputationStorage.POSITION — см. src/facets/ReputationFacet.sol.
    bytes32 constant REP_BASE = 0xa32193c5e38bd2de27c8550f156d709eafdc63aaa4290e5e27473f2ffc097400;

    /// uniqueActiveUsers — слот 8 в ReputationStorage.Data, добыт перебором в
    /// test/ArbiterRemovalForCause.t.sol (круг правок 1, M-9). Семь полей
    /// перед ним — мэппинги, каждый съедает ровно один слот, упаковки нет.
    uint256 constant SLOT_UNIQUE_ACTIVE_USERS = 8;

    function setUp() public {
        facet = new ArbiterRegistryFacet();
        owner = address(this);
        vm.store(address(facet), OWNER_SLOT, bytes32(uint256(uint160(owner))));
    }

    function _setUniqueActiveUsers(uint256 n) internal {
        vm.store(address(facet), bytes32(uint256(REP_BASE) + SLOT_UNIQUE_ACTIVE_USERS), bytes32(n));
    }

    function _activateDaoWithSuccessor() internal {
        facet.setDAOAddress(address(0xDA0));
        facet.activateDAO();
    }

    // ---------- addArbiter ----------

    function test_AddArbiterWorksBeforeDao() public {
        facet.addArbiter(address(0xA1));
        assertTrue(facet.isRegisteredArbiter(address(0xA1)), unicode"до ДАО владелец сажает как прежде");
    }

    function test_AddArbiterRevertsAfterDao() public {
        _activateDaoWithSuccessor();
        vm.expectRevert(ArbiterRegistryFacet.SeatingHandedOver.selector);
        facet.addArbiter(address(0xA1));
    }

    // ---------- setChiefArbiter ----------

    function test_SetChiefArbiterWorksBeforeDao() public {
        facet.setChiefArbiter(address(0xC4));
        assertEq(facet.getChiefArbiter(), address(0xC4), unicode"до ДАО директор назначается как прежде");
    }

    function test_SetChiefArbiterRevertsAfterDao() public {
        _activateDaoWithSuccessor();
        vm.expectRevert(ArbiterRegistryFacet.SeatingHandedOver.selector);
        facet.setChiefArbiter(address(0xC4));
    }

    // ---------- activateDAO требует уже назначенного daoAddress ----------

    function test_ActivateDaoRevertsWithoutDaoAddress() public {
        vm.expectRevert(ArbiterRegistryFacet.DaoAddressNotSet.selector);
        facet.activateDAO();
    }

    function test_ActivateDaoSucceedsAfterDaoAddressSet() public {
        facet.setDAOAddress(address(0xDA0));
        facet.activateDAO();
        assertTrue(facet.isDaoActive(), unicode"daoAddress назначен — включение проходит");
    }

    // ---------- C-3: setDAOAddress тоже храповик ----------

    function test_SetDaoAddressWorksBeforeDaoAsOwner() public {
        facet.setDAOAddress(address(0xDA0));
        assertEq(facet.getDAOAddress(), address(0xDA0), unicode"до ДАО владелец называет преемника как прежде");
    }

    /// Ровно та дыра, что нашло ревью (C-3): владелец после активации ДАО
    /// пытается назначить СЕБЯ (или кого угодно) daoAddress'ом заново —
    /// обязан получить отказ, иначе через activateDAO() → setDAOAddress(...)
    /// → removeArbiterForCause он вернул бы себе снос лишней транзакцией.
    function test_SetDaoAddressRevertsForOwnerAfterDao() public {
        _activateDaoWithSuccessor(); // daoAddress = 0xDA0
        vm.expectRevert(ArbiterRegistryFacet.NotCurrentDaoAddress.selector);
        facet.setDAOAddress(address(0xBEEF));
    }

    /// Симметричная половина: ДЕЙСТВУЮЩИЙ daoAddress вправе мигрировать сам
    /// себя (ДАО меняет реализацию/адрес контракта) — право не заперто
    /// навсегда, оно принадлежит текущему держателю.
    function test_SetDaoAddressSucceedsForCurrentDaoAfterDao() public {
        _activateDaoWithSuccessor(); // daoAddress = 0xDA0
        vm.prank(address(0xDA0));
        facet.setDAOAddress(address(0xBEEF));
        assertEq(facet.getDAOAddress(), address(0xBEEF), unicode"текущий daoAddress мигрирует сам себя");
    }

    // ---------- Круг правок 2: заработанное ДАО при нулевом преемнике ----------

    /// Тест 1 (главный негатив ловушки): ДАО включилась ЗАРАБОТАННЫМ путём —
    /// activateDAO() не звался ни разу, daoActiveManual остаётся false — а
    /// daoAddress ещё нулевой. Без `&& d.daoAddress != address(0)` эта же
    /// проверка потребовала бы msg.sender == address(0), то есть не пустила
    /// бы никого и никогда: посадка и снос осиротели бы необратимо. С
    /// починкой владелец обязан суметь назначить первого преемника.
    function test_SetDaoAddressWorksWhenDaoEarnedButNoSuccessorYet() public {
        _setUniqueActiveUsers(facet.getDaoThreshold());
        assertTrue(facet.isDaoActive(), unicode"ДАО активна заработанным путём, без activateDAO()");
        assertEq(facet.getDAOAddress(), address(0), unicode"сетап: преемника ещё нет");

        facet.setDAOAddress(address(0xDA0));

        assertEq(facet.getDAOAddress(), address(0xDA0), unicode"владелец назначил первого преемника");
    }

    /// Тест 2: как только преемник назначен, храповик держит как держал —
    /// владелец больше не может, действующий daoAddress может.
    function test_SetDaoAddressRatchetsAfterEarnedDaoOnceSuccessorNamed() public {
        _setUniqueActiveUsers(facet.getDaoThreshold());
        facet.setDAOAddress(address(0xDA0)); // владелец называет первого преемника

        vm.expectRevert(ArbiterRegistryFacet.NotCurrentDaoAddress.selector);
        facet.setDAOAddress(address(0xBEEF)); // владелец пытается снова — отказ

        vm.prank(address(0xDA0));
        facet.setDAOAddress(address(0xBEEF)); // действующий daoAddress мигрирует сам себя
        assertEq(facet.getDAOAddress(), address(0xBEEF));
    }

    // ============================================================
    //  ФИНАЛЬНЫЙ ОБЗОР ВЕТКИ, I-3 (16 августа 2026)
    //
    //  ЗАРАБОТАННЫЙ ПОРОГ ЗАКРЫВАЛ ДВЕРИ ПОСАДКИ НЕОБРАТИМО, И НАЖАТЬ ЕГО МОГ
    //  ПОСТОРОННИЙ.
    //
    //  Раньше `uniqueActiveUsers >= DAO_THRESHOLD` только ОТКРЫВАЛ дверь
    //  самозаписи (applyAsArbiter). Задача 6 сделала его вдобавок ЗАМКОМ на
    //  addArbiter/setChiefArbiter. При этом защита DaoAddressNotSet стоит
    //  ТОЛЬКО внутри activateDAO() — то есть на ручной двери; автоматическая
    //  не была защищена ничем, а цена её нажатия замерена в самом проекте
    //  (src/Treasury.sol: порог достижим за деньги, на тестнете — просто за
    //  время постороннего).
    //
    //  Итог до правки: ЧУЖОЙ человек навсегда лишал владельца права сажать
    //  арбитров, а корпус пополнялся бы только самозаписью с гейтом
    //  MIN_XP_TO_REGISTER = 3000, которому живой ручной арбитр (XP 0) не
    //  удовлетворяет.
    //
    //  Починено тем же приёмом, что уже применён к setDAOAddress в круге
    //  правок 2: передача защёлкивается ТОЛЬКО когда преемник реально
    //  существует. isDaoActive() НЕ ТРОГАЛИ — его читает уже развёрнутая и
    //  неизменяемая src/Treasury.sol для пропорций дохода.
    // ============================================================

    function test_AddArbiterStillWorksWhenDaoEarnedButNoSuccessorYet() public {
        _setUniqueActiveUsers(facet.getDaoThreshold());
        assertTrue(facet.isDaoActive(), unicode"ДАО активна заработанным путём, без activateDAO()");
        assertEq(facet.getDAOAddress(), address(0), unicode"сетап: преемника ещё нет");

        facet.addArbiter(address(0xA1));

        assertTrue(
            facet.isRegisteredArbiter(address(0xA1)),
            unicode"пока преемника нет — сажать некому, кроме владельца, и он обязан мочь"
        );
    }

    function test_SetChiefArbiterStillWorksWhenDaoEarnedButNoSuccessorYet() public {
        _setUniqueActiveUsers(facet.getDaoThreshold());
        facet.setChiefArbiter(address(0xC4));
        assertEq(facet.getChiefArbiter(), address(0xC4), unicode"та же половина для роли директора");
    }

    /// Симметричная половина обеих: как только преемник назван, обе двери
    /// закрываются необратимо — ровно то, ради чего задача 6 их и закрывала.
    function test_AddArbiterRatchetsOnceSuccessorNamedAfterEarnedDao() public {
        _setUniqueActiveUsers(facet.getDaoThreshold());
        facet.setDAOAddress(address(0xDA0));

        vm.expectRevert(ArbiterRegistryFacet.SeatingHandedOver.selector);
        facet.addArbiter(address(0xA1));
    }

    function test_SetChiefArbiterRatchetsOnceSuccessorNamedAfterEarnedDao() public {
        _setUniqueActiveUsers(facet.getDaoThreshold());
        facet.setDAOAddress(address(0xDA0));

        vm.expectRevert(ArbiterRegistryFacet.SeatingHandedOver.selector);
        facet.setChiefArbiter(address(0xC4));
    }

    // ============================================================
    //  ФИНАЛЬНЫЙ ОБЗОР ВЕТКИ, I-2 (16 августа 2026) — половина ЭТОГО фасета
    //
    //  Директор перестаёт существовать при активном ДАО, потому что иначе он
    //  становится НЕСМЕНЯЕМЫМ: setChiefArbiter — единственный писатель слота и
    //  единственный способ его обнулить, а сама она при ДАО закрыта. Здесь
    //  проверяется единственная функция этого фасета под onlyOwnerOrChief —
    //  addArbiter. Четыре функции второй половины (приостановка, снятие
    //  приостановки, предложение сноса, отзыв предложения) — в
    //  test/ArbiterRemovalForCause.t.sol.
    // ============================================================

    function test_ChiefCanAddArbiterBeforeDao() public {
        facet.setChiefArbiter(address(0xC4));
        vm.prank(address(0xC4));
        facet.addArbiter(address(0xA1));
        assertTrue(facet.isRegisteredArbiter(address(0xA1)), unicode"до ДАО директор сажает как прежде");
    }

    /// Отказ обязан быть именно NotOwnerOrChief, а не SeatingHandedOver:
    /// модификатор стоит ПЕРЕД телом, и различие тут не косметическое —
    /// SeatingHandedOver означал бы «директор ещё существует, просто дверь
    /// закрыта всем», то есть все ОСТАЛЬНЫЕ его права (в соседнем фасете) при
    /// нём. Проверяем упразднение роли, а не закрытие одной двери.
    function test_ChiefLosesAddArbiterAfterDao() public {
        facet.setChiefArbiter(address(0xC4));
        _activateDaoWithSuccessor();

        vm.prank(address(0xC4));
        vm.expectRevert(ArbiterRegistryFacet.NotOwnerOrChief.selector);
        facet.addArbiter(address(0xA1));
    }

    /// Заработанный путь — та же половина: модификатор читает isDaoActive(),
    /// а не daoActiveManual. Преемник здесь НЕ назначен нарочно: владелец в
    /// этом состоянии сажать ещё может (I-3 выше), а директор — уже нет.
    /// Значит отказ директору приходит от модификатора, а не от храповика
    /// тела, и один тест разделяет обе правки.
    function test_ChiefLosesAddArbiterOnEarnedDaoWhileOwnerStillSeats() public {
        facet.setChiefArbiter(address(0xC4));
        _setUniqueActiveUsers(facet.getDaoThreshold());

        vm.prank(address(0xC4));
        vm.expectRevert(ArbiterRegistryFacet.NotOwnerOrChief.selector);
        facet.addArbiter(address(0xA1));

        facet.addArbiter(address(0xA1)); // владелец — может
        assertTrue(facet.isRegisteredArbiter(address(0xA1)));
    }
}
