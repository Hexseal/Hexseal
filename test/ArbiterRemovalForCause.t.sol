// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Снос арбитра с поводом.
//
// Половина настоящих поводов проверяема цепью, половина — нет никогда. Если
// обе выглядят в записи одинаково, «доказательство в цепи» становится враньём
// для второй половины. Поэтому повод — это КОД, и цепь знает, какие коды она
// обязана проверить:
//   • OverturnedVerdicts / Timeouts / Silence — проверяет сама, без признака
//     транзакция откажет;
//   • Collusion / Leak / Other — не проверяет ничего и не притворяется:
//     требует непустой отпечаток доказательства и помечает запись
//     verifiedByChain = false.
//
// Право сноса передаётся, а не запирается: до активации ДАО зовёт только
// владелец, после — только daoAddress. Дыра в первой версии этого плана
// («после ДАО не может никто») найдена владельцем ДО реализации: голосования
// по арбитрам в коде нет, daoAddress по умолчанию нулевой, и чистый лок означал
// бы, что сговор и слив переписки после включения ДАО становятся неснимаемыми
// вовсе — автоматика ловит только то, что видит цепь.
//
// ⚠️ Смещения слотов ниже добыты одноразовым перебором (offset 0..59, запись
// пробного значения, сверка с боевым getter'ом), НЕ взяты из брифа задачи:
// тот дважды промахнулся (arbiterMistakeStreak — 18 в брифе, реальность 11;
// упаковка chiefArbiter/daoActiveManual в один слот 5 сдвигает индексы всех
// полей после него на единицу назад относительно наивного расчёта без
// упаковки). Верно предположенные в брифе значения (SLOT_NO_RESPONSE=23,
// смещение chiefArbiter=5) подтверждены тем же перебором, не на слово.

import "forge-std/Test.sol";
import {ArbiterAccountabilityFacet} from "../src/facets/ArbiterAccountabilityFacet.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";

contract ArbiterRemovalForCauseTest is Test {
    ArbiterAccountabilityFacet acc;

    address owner;
    address chief;
    address arbiter;

    bytes32 constant ARB_BASE = 0xaae71de0594cbcb5434f0ab7f7501c1be178552bf788b418a1c2624ba9718d00;
    bytes32 constant OWNER_SLOT = 0x178642b411f9f4783b21ef338f3e96db6c1272d763f0b7500ec93464dafb8604;

    /// Добыто перебором (см. докстринг файла). Брифом было предложено 18 —
    /// промах: настоящее смещение 11, сторожится тестом ниже.
    uint256 constant SLOT_MISTAKE_STREAK = 11;

    function setUp() public {
        acc = new ArbiterAccountabilityFacet();
        owner   = address(this);
        chief   = address(0xC4);
        arbiter = address(0xA1);
        vm.store(address(acc), OWNER_SLOT, bytes32(uint256(uint160(owner))));
        vm.store(address(acc), keccak256(abi.encode(arbiter, uint256(ARB_BASE))), bytes32(uint256(1)));
    }

    function test_MistakeStreakSlotMatchesLiveStorage() public {
        _setStreak(arbiter, 2);
        assertEq(acc.getMistakeStreakOf(arbiter), 2, unicode"смещение слота arbiterMistakeStreak уехало");
    }

    // ---------- ПРОВЕРЯЕМЫЕ ЦЕПЬЮ ----------

    function test_OverturnedVerdictsRequiresTheStreak() public {
        _setStreak(arbiter, 2);   // порога 3 ещё нет
        vm.expectRevert(
            abi.encodeWithSelector(ArbiterAccountabilityFacet.CauseNotProven.selector, uint8(0))
        );
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));
    }

    function test_OverturnedVerdictsPassesAtThreshold() public {
        _setStreak(arbiter, 3);

        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.ArbiterRemovedForCause(
            arbiter, owner, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, true, bytes32(0), 0
        );

        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));
        assertFalse(acc.isRegisteredArbiterHere(arbiter), unicode"снятый больше не арбитр");
    }

    // ---------- ЗАВЕРЯЕМЫЕ, НО НЕ ПРОВЕРЯЕМЫЕ ----------

    function test_CollusionWithoutEvidenceIsRefused() public {
        vm.expectRevert(ArbiterAccountabilityFacet.EvidenceRequired.selector);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, bytes32(0), address(0));
    }

    function test_CollusionWithEvidenceIsMarkedUnverified() public {
        bytes32 digest = keccak256(unicode"переписка со стороной спора");

        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.ArbiterRemovedForCause(
            arbiter, owner, ArbiterAccountabilityFacet.Cause.Collusion, false, digest, 0
        );

        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Collusion, digest, address(0));
    }

    /// Silence — признак ПО КОНКРЕТНОМУ СПОРУ, и без адреса спора проверить
    /// его нечем. Слить его со счётчиком серии нельзя: тогда цепь заверяла бы
    /// не то, что написано в записи.
    function test_SilenceRequiresDisputeRef() public {
        vm.expectRevert(ArbiterAccountabilityFacet.DisputeRefRequired.selector);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Silence, bytes32(0), address(0));
    }

    function test_SilenceRequiresTheRecord() public {
        address deal = address(0xD1);
        vm.expectRevert(
            abi.encodeWithSelector(ArbiterAccountabilityFacet.CauseNotProven.selector, uint8(2))
        );
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Silence, bytes32(0), deal);
    }

    function test_SilencePassesWhenRecorded() public {
        address deal = address(0xD1);
        _setNoResponse(deal, arbiter, 1_700_000_000);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Silence, bytes32(0), deal);
        assertFalse(acc.isRegisteredArbiterHere(arbiter), unicode"снят по записанному молчанию");
    }

    /// Адрес спора у кода, который его не читает, — мусор в записи: читатель
    /// решит, что снос связан с той сделкой.
    function test_DisputeRefIsRefusedWhereItDoesNotApply() public {
        _setStreak(arbiter, 3);
        vm.expectRevert(ArbiterAccountabilityFacet.DisputeRefNotApplicable.selector);
        acc.removeArbiterForCause(
            arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0xD1)
        );
    }

    /// Timeouts и OverturnedVerdicts упираются в ОДИН счётчик — цепь их не
    /// различает. Тест это фиксирует, чтобы никто не считал, будто различает.
    function test_TimeoutsUsesTheSameCounter() public {
        _setStreak(arbiter, 3);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.Timeouts, bytes32(0), address(0));
        assertFalse(acc.isRegisteredArbiterHere(arbiter));
    }

    // ---------- КТО МОЖЕТ ----------

    function test_ChiefCannotRemove() public {
        _setStreak(arbiter, 3);
        _setChief(chief);
        vm.prank(chief);
        vm.expectRevert(ArbiterAccountabilityFacet.NotOwner.selector);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));
    }

    /// Храповик: после активации ДАО владельца цепь не пускает вовсе — право
    /// уехало к daoAddress (см. следующие два теста). daoAddress здесь не
    /// назначен (остаётся нулём), поэтому и он не смог бы: это осознанный
    /// снимок «активировали ДАО, забыли назначить преемника» — за него
    /// отвечает activateDAO()'s DaoAddressNotSet() guard в ArbiterRegistryFacet,
    /// не этот тест.
    function test_OwnerCannotRemoveAfterDAO() public {
        _setStreak(arbiter, 3);
        _activateDAO();
        vm.expectRevert(ArbiterAccountabilityFacet.RemovalHandedOver.selector);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));
    }

    /// Передача, а не запирание в пустоту (правка владельца после первой
    /// версии плана): daoAddress назначен, но ДАО ещё не активна — дверь
    /// по-прежнему только у владельца.
    function test_DaoAddressCannotRemoveBeforeDao() public {
        _setStreak(arbiter, 3);
        address dao = address(0xDA0);
        _setDaoAddress(dao);
        vm.prank(dao);
        vm.expectRevert(ArbiterAccountabilityFacet.NotOwner.selector);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));
    }

    /// Симметричная половина test_OwnerCannotRemoveAfterDAO: назначенный
    /// daoAddress ПОСЛЕ активации ДАО может снимать — право не потеряно,
    /// оно уехало к конкретному адресу.
    function test_DaoAddressCanRemoveAfterDao() public {
        _setStreak(arbiter, 3);
        address dao = address(0xDA0);
        _setDaoAddress(dao);
        _activateDAO();

        vm.expectEmit(true, true, true, true, address(acc));
        emit ArbiterAccountabilityFacet.ArbiterRemovedForCause(
            arbiter, dao, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, true, bytes32(0), 0
        );

        vm.prank(dao);
        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));
        assertFalse(acc.isRegisteredArbiterHere(arbiter), unicode"снят голосованием ДАО после передачи");
    }

    // ---------- ОЧИСТКА МЕСТА (закрывает пробел задачи 1) ----------

    /// Задача 1 намеренно оставила removeArbiter без теста очистки места,
    /// потому что задача 6 её удаляет. removeArbiterForCause — новый
    /// единственный путь снятия чужой посадки, и путь очистки места обязан
    /// работать и через него: посаженный директором арбитр снесён —
    /// getSeatedCountBy(директор) обязан упасть.
    function test_RemovalForCauseFreesDirectorSlot() public {
        address director = address(0xD3);
        _setStreak(arbiter, 3);
        _setSeatedBy(arbiter, director);
        _setSeatedCountBy(director, 1);
        assertEq(_getSeatedCountBy(director), 1, unicode"сетап: посадка директора учтена");

        acc.removeArbiterForCause(arbiter, ArbiterAccountabilityFacet.Cause.OverturnedVerdicts, bytes32(0), address(0));

        assertEq(_getSeatedCountBy(director), 0, unicode"снос по поводу обязан освобождать место посадившего");
    }

    function _setStreak(address who, uint256 n) internal {
        bytes32 base = bytes32(uint256(ARB_BASE) + SLOT_MISTAKE_STREAK);
        vm.store(address(acc), keccak256(abi.encode(who, uint256(base))), bytes32(n));
    }

    /// chiefArbiter делит слот 5 с daoActiveManual (bool, байт-смещение 20).
    /// Читаем-меняем-пишем, чтобы порядок вызова с _activateDAO не имел
    /// значения — ни один сегодняшний тест их не комбинирует, но слепая
    /// перезапись всего слота была бы тихой миной на будущее.
    function _setChief(address who) internal {
        bytes32 slot = bytes32(uint256(ARB_BASE) + 5);
        bytes32 current = vm.load(address(acc), slot);
        bytes32 daoBit = current & bytes32(uint256(1) << 160);
        vm.store(address(acc), slot, bytes32(uint256(uint160(who))) | daoBit);
    }

    /// daoActiveManual — bool, упакован в слот 5 (тот же, что chiefArbiter) на
    /// байт-смещении 20 (бит 160). Добыто перебором offset×byte, см. докстринг
    /// файла. Брифом было предложено «слот 6, отдельно» — промах: упаковка
    /// адреса и bool в общий 32-байтовый слот сдвигает всё, что после,
    /// назад на единицу относительно наивного расчёта.
    function _activateDAO() internal {
        bytes32 slot = bytes32(uint256(ARB_BASE) + 5);
        bytes32 current = vm.load(address(acc), slot);
        vm.store(address(acc), slot, current | bytes32(uint256(1) << 160));
    }

    /// daoAddress — слот 10, добыт перебором.
    function _setDaoAddress(address dao) internal {
        vm.store(address(acc), bytes32(uint256(ARB_BASE) + 10), bytes32(uint256(uint160(dao))));
    }

    /// disputeNoResponseAtBy — вложенный мэппинг сделка → арбитр → момент.
    /// Смещение сторожится тестом test_NoResponseSlotMatchesLiveStorage.
    uint256 constant SLOT_NO_RESPONSE = 23;

    function _setNoResponse(address deal, address who, uint256 at) internal {
        bytes32 outer = keccak256(abi.encode(deal, uint256(bytes32(uint256(ARB_BASE) + SLOT_NO_RESPONSE))));
        vm.store(address(acc), keccak256(abi.encode(who, uint256(outer))), bytes32(at));
    }

    function test_NoResponseSlotMatchesLiveStorage() public {
        _setNoResponse(address(0xD1), arbiter, 99);
        assertEq(acc.getNoResponseAtHere(address(0xD1), arbiter), 99,
            unicode"смещение слота disputeNoResponseAtBy уехало");
    }

    /// seatedBy — слот 25, seatedCountBy — слот 26. Добыты перебором против
    /// ArbiterRegistryFacet.getSeatedBy/getSeatedCountBy (та же раскладка,
    /// другой развёрнутый контракт — позиция слота от этого не зависит).
    /// У ArbiterAccountabilityFacet своих геттеров этих полей нет, поэтому
    /// обратное чтение — прямой vm.load, а не через ABI.
    function _setSeatedBy(address arbiterAddr, address seater) internal {
        bytes32 slot = keccak256(abi.encode(arbiterAddr, uint256(bytes32(uint256(ARB_BASE) + 25))));
        vm.store(address(acc), slot, bytes32(uint256(uint160(seater))));
    }

    function _setSeatedCountBy(address seater, uint256 count) internal {
        bytes32 slot = keccak256(abi.encode(seater, uint256(bytes32(uint256(ARB_BASE) + 26))));
        vm.store(address(acc), slot, bytes32(count));
    }

    function _getSeatedCountBy(address seater) internal view returns (uint256) {
        bytes32 slot = keccak256(abi.encode(seater, uint256(bytes32(uint256(ARB_BASE) + 26))));
        return uint256(vm.load(address(acc), slot));
    }

    /// MISTAKE_THRESHOLD в новом фасете и MAX_ARBITER_MISTAKES в старом — одно
    /// и то же правило, прочитанное с двух сторон. Разойдутся — снос будет
    /// требовать не того, что копит автоматика.
    function test_MistakeThresholdMatchesRegistry() public {
        ArbiterRegistryFacet reg = new ArbiterRegistryFacet();
        assertEq(acc.getMistakeThreshold(), reg.getMaxArbiterMistakes(),
            unicode"порог серии обязан быть один на оба фасета");
    }
}
