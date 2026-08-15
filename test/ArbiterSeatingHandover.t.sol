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
// Лёгкий стенд: фасет развёрнут отдельно, диамонда не нужно (тот же приём,
// что у test/ArbiterProvenance.t.sol). В отличие от ArbiterRemovalForCause.t.sol
// слоты добывать не пришлось — setDAOAddress/activateDAO/addArbiter/
// setChiefArbiter существуют как обычные функции этого фасета.

import "forge-std/Test.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";

contract ArbiterSeatingHandoverTest is Test {
    ArbiterRegistryFacet facet;

    address owner;

    /// Слот владельца даймонда — тот же, что в test/ArbiterProvenance.t.sol
    /// (DiamondStorage.POSITION + 4), пересчитан и проверен запуском там же.
    bytes32 constant OWNER_SLOT = 0x178642b411f9f4783b21ef338f3e96db6c1272d763f0b7500ec93464dafb8604;

    function setUp() public {
        facet = new ArbiterRegistryFacet();
        owner = address(this);
        vm.store(address(facet), OWNER_SLOT, bytes32(uint256(uint160(owner))));
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
}
