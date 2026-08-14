// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Момент взятия спора (4в-2 Выкатка 2, Задача 1).
//
// Цепь до этой правки не знала, КОГДА арбитр взял спор: claimDispute писала
// арбитра, список сделок и счётчик, но не время. Без времени пол будущей
// записи «просил переписку, ответа нет» считать не от чего.
//
// Сетап — тот же, что у test/ArbiterChatKey.t.sol: фасет развёрнут отдельно,
// арбитр сажается прямо в хранилище (applyAsArbiter заперт за isDaoActive, а
// ДАО намеренно не запущено — решение владельца 1 августа), спор изображает
// MockDisputedAgreement. Настоящего диамонда здесь не нужно: всё, что
// утверждается ниже — состояние namespaced-хранилища самого фасета.

import "forge-std/Test.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";

contract DisputeNoResponseTest is Test {
    ArbiterRegistryFacet facet;

    address arbiter;
    address agreement;

    function setUp() public {
        facet = new ArbiterRegistryFacet();
        arbiter = address(0xA1);
        _makeArbiter(arbiter);
        agreement = address(new MockDisputedAgreementNR(address(0xC1), address(0xE1)));
    }

    // ============================================================
    //  МОМЕНТ ВЗЯТИЯ
    // ============================================================

    function test_ClaimDispute_RecordsClaimMoment() public {
        _claimBy(arbiter, agreement);
        assertEq(
            facet.getDisputeClaimedAt(agreement),
            block.timestamp,
            unicode"время взятия обязано лечь в хранилище"
        );
    }

    function test_ReleaseDisputeClaim_ClearsClaimMoment() public {
        _claimBy(arbiter, agreement);
        vm.prank(arbiter);
        facet.releaseDisputeClaim(agreement);
        assertEq(
            facet.getDisputeClaimedAt(agreement),
            0,
            unicode"отпустил спор — время обязано уйти вместе с клеймом"
        );
    }

    /// Второй путь снятия клейма — обратный вызов из самого Agreement (таймаут,
    /// исполнение вердикта). Он обязан снимать время так же, как отпуск: иначе
    /// новый арбитр унаследовал бы время старого, пол оказался бы уже
    /// пройденным, и запись о молчании прошла бы в ту же секунду, как он взял
    /// спор. Мест снятия клейма ровно два, и замок нужен на каждом — один
    /// пропущенный оставляет ровно эту дыру.
    function test_ClearDisputeClaim_ClearsClaimMoment() public {
        _claimBy(arbiter, agreement);
        vm.prank(agreement); // clearDisputeClaim зовёт только сам Agreement
        facet.clearDisputeClaim(agreement);
        assertEq(
            facet.getDisputeClaimedAt(agreement),
            0,
            unicode"клейм снят обратным вызовом — время обязано уйти вместе с ним"
        );
    }

    /// До взятия времени нет. Ноль здесь — не «поле сломано», а рабочий
    /// признак «спор не брался»: на нём же стоит будущий отказ спорам,
    /// взятым до разреза.
    function test_GetDisputeClaimedAt_ZeroBeforeClaim() public view {
        assertEq(
            facet.getDisputeClaimedAt(agreement),
            0,
            unicode"невзятый спор не может иметь момента взятия"
        );
    }

    /// Перевзятие после отпуска пишет НОВОЕ время, а не оставляет старое.
    /// Замер на то, что обнуление не превратилось в «поле пишется один раз
    /// навсегда»: время сдвигается ровно на прожитые секунды.
    function test_ReclaimAfterRelease_RecordsFreshMoment() public {
        _claimBy(arbiter, agreement);
        uint256 first = facet.getDisputeClaimedAt(agreement);

        vm.prank(arbiter);
        facet.releaseDisputeClaim(agreement);

        vm.warp(block.timestamp + 1 hours);
        _claimBy(arbiter, agreement);

        assertEq(
            facet.getDisputeClaimedAt(agreement),
            first + 1 hours,
            unicode"перевзятый спор обязан получить новое время, а не старое"
        );
    }

    // ============================================================
    //  ХЕЛПЕРЫ
    // ============================================================

    /// commit + roll + claim одной последовательностью в хелпере, а не
    /// инлайном: тот же приём и та же причина, что у
    /// test/ArbiterChatKey.t.sol::_commitAndClaim — повтор той же
    /// последовательности инлайном дважды в одном теле теста под via_ir
    /// наблюдался как «второй vm.roll не берётся».
    function _claimBy(address arb, address agr) internal {
        bytes32 salt = keccak256(abi.encodePacked(arb, agr, block.number, block.timestamp));
        bytes32 commitment = keccak256(abi.encodePacked(agr, arb, salt));
        vm.prank(arb);
        facet.commitDisputeClaim(commitment);
        vm.roll(block.number + 1);
        vm.prank(arb);
        facet.claimDispute(agr, salt, bytes32(uint256(0x11)), bytes32(uint256(0x22)));
    }

    /// Садит арбитра прямо в хранилище фасета — как в test/ArbiterChatKey.t.sol.
    function _makeArbiter(address who) internal {
        // POSITION хранилища + слот mapping isArbiter (первое поле Data).
        bytes32 pos = 0xaae71de0594cbcb5434f0ab7f7501c1be178552bf788b418a1c2624ba9718d00;
        vm.store(address(facet), keccak256(abi.encode(who, uint256(pos))), bytes32(uint256(1)));
        // Проверка обязательна: при неверном слоте посадка молча не срабатывает,
        // и все замеры ниже падали бы на NotArbiter, а читались бы как
        // «время взятия проверено».
        assertTrue(facet.isRegisteredArbiter(who), unicode"не удалось посадить арбитра");
    }
}

/// Минимальная заглушка Agreement — ровно то подмножество интерфейса, которое
/// claimDispute()/releaseDisputeClaim() опрашивают staticcall'ами
/// (status/disputedAt/DISPUTE_WINDOW/client/executor) и вызывают (setArbiter).
/// Живёт в статусе DISPUTED(4) с открытым окном спора с момента деплоя.
/// Копия MockDisputedAgreement из test/ArbiterChatKey.t.sol — под своим именем,
/// потому что forge разворачивает оба файла в одном проекте.
contract MockDisputedAgreementNR {
    uint8 public constant status = 4; // Agreement.Status.DISPUTED
    uint256 public disputedAt;
    uint256 public constant DISPUTE_WINDOW = 3 days;
    address public client;
    address public executor;
    address public arbiter;

    constructor(address _client, address _executor) {
        client = _client;
        executor = _executor;
        disputedAt = block.timestamp;
    }

    function setArbiter(address newArbiter) external {
        arbiter = newArbiter;
    }
}
