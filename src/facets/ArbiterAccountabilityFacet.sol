// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

// ============================================================
// HEXSEAL — ArbiterAccountabilityFacet.sol
//
// Ответственность ручных арбитров: приостановка, снос с поводом, предложение
// директора, право ответа снятого.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ФАСЕТ, а не дописка в ArbiterRegistryFacet: тот занимает
// 21 227 байт развёрнутого кода из 24 576 (86.4 %, замерено 15 августа 2026).
// Запаса в 3.3 КБ не хватает. Фасеты даймонда делят хранилище по неймспейсу,
// поэтому этот работает с тем же ArbiterRegistryStorage и тем же POSITION —
// переноса данных не происходит вовсе.
//
// В этой задаче (arbiter-accountability, задача 4, 15 августа 2026) реализована
// только приостановка — быстрая, обратимая, протухающая сама. Снос с поводом,
// предложение директора и право ответа снятого — задел следующих задач того же
// плана, здесь не реализованы.
//
// ⚠️ ВСЕ функции этого фасета сегодня — административные (владелец или
// директор) и читают сырой msg.sender, как onlyOwnerOrChief в
// ArbiterRegistryFacet: владелец и директор ходят прямой транзакцией, не через
// релеер, а гейслесс-пути у этого фасета пока нет вовсе. Файл не реализует
// _msgSender() и учтён в script/gasless-sender.allow отдельной записью «вне
// области». Когда сюда приедет respondToRemoval (право ответа снятого,
// зовётся ОБЫЧНЫМ ЧЕЛОВЕКОМ через релеер), фасет обзаведётся собственным
// _msgSender() и станет ERC-2771-файлом — тогда запись в allow-файле сменит
// форму на per-function, как у соседей.
// ============================================================

import {ArbiterRegistryStorage} from "./ArbiterRegistryFacet.sol";
import {OwnershipLib} from "../DiamondProxy.sol";

contract ArbiterAccountabilityFacet {

    // -------- CONSTANTS --------

    /// Сколько держит приостановка, если её не сняли раньше. Утверждено
    /// владельцем 15 августа 2026: окно финализации — сутки, окно апелляции —
    /// четверо; трое суток хватает разобраться и не держит честные стороны
    /// неделю.
    uint256 private constant SUSPENSION_WINDOW = 72 hours;

    // -------- ERRORS --------

    error NotOwnerOrChief();
    error NotAnArbiter();
    error ArbiterZeroAddress();

    // -------- EVENTS --------

    event ArbiterSuspended(address indexed arbiter, address indexed by, uint256 until);
    event ArbiterSuspensionLifted(address indexed arbiter, address indexed by);

    // -------- MODIFIERS --------

    modifier onlyOwnerOrChief() {
        address chief = ArbiterRegistryStorage.data().chiefArbiter;
        if (msg.sender != OwnershipLib.contractOwner() && msg.sender != chief)
            revert NotOwnerOrChief();
        _;
    }

    // -------- SUSPENSION --------

    /// Быстрая обратимая остановка. Никого не обвиняет и ничего не отбирает:
    /// поэтому ею владеет и директор, и поэтому она остаётся у владельца после
    /// передачи сноса голосованию.
    function suspendArbiter(address arbiter) external onlyOwnerOrChief {
        if (arbiter == address(0)) revert ArbiterZeroAddress();
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        if (!d.isArbiter[arbiter]) revert NotAnArbiter();

        // От ТЕКУЩЕГО момента, а не прибавкой к прежнему сроку: иначе два
        // нажатия подряд держат чужие деньги шесть суток вместо трёх.
        uint256 until = block.timestamp + SUSPENSION_WINDOW;
        d.suspendedUntil[arbiter] = until;
        emit ArbiterSuspended(arbiter, msg.sender, until);
    }

    /// Снять раньше срока. Отдельная функция, а не «приостановить на ноль»:
    /// в ленте это разные события, и читателю важно видеть именно снятие.
    function liftSuspension(address arbiter) external onlyOwnerOrChief {
        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        delete d.suspendedUntil[arbiter];
        emit ArbiterSuspensionLifted(arbiter, msg.sender);
    }

    // -------- VIEWS --------

    function isSuspended(address arbiter) public view returns (bool) {
        return block.timestamp < ArbiterRegistryStorage.data().suspendedUntil[arbiter];
    }

    function getSuspendedUntil(address arbiter) external view returns (uint256) {
        return ArbiterRegistryStorage.data().suspendedUntil[arbiter];
    }

    function getSuspensionWindow() external pure returns (uint256) {
        return SUSPENSION_WINDOW;
    }
}
