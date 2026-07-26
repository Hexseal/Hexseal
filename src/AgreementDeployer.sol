// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// HEXSEAL — AgreementDeployer.sol
// Отдельный контракт (не фасет Diamond), который создаёт новые
// инстансы Agreement как минимальные прокси EIP-1167.
//
// Раньше он носил в себе type(Agreement).creationCode и делал
// CREATE — это стоило ~4.4M газа на сделку и раздувало сам
// деплойер до 23 849 байт. Теперь Agreement развёрнут один раз
// как реализация, а на сделку создаётся 45-байтовый клон.
//
// import Agreement.sol сохранён намеренно: тестам и скриптам он
// нужен транзитивно, а creationCode в байткод не попадает, пока
// не написано type(Agreement).creationCode или new Agreement().
// ============================================================

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./Agreement.sol";

interface IAgreementDeployer {
    function deploy(
        address client,
        address executor,
        address arbiter,
        uint256 amount,
        uint256 deadlineDays,
        string  calldata terms,
        address diamond,
        address usdc,
        address trustedForwarder,
        address factory
    ) external returns (address);
}

contract AgreementDeployer is IAgreementDeployer {
    address public immutable authorizedCaller;
    address public immutable implementation;

    constructor(address authorizedCaller_, address implementation_) {
        require(authorizedCaller_ != address(0), "AgreementDeployer: zero caller");
        require(implementation_   != address(0), "AgreementDeployer: zero implementation");
        // Обязательно, а не для красоты. Clones.clone() не проверяет наличие
        // кода у реализации, а вызов к адресу без кода в EVM возвращает УСПЕХ:
        // initialize() «отработал бы», deploy() вернул бы адрес, клиент
        // профинансировал бы пустую скорлупу, которую любой посторонний потом
        // проинициализировал бы на себя.
        require(implementation_.code.length > 0, "AgreementDeployer: implementation has no code");
        authorizedCaller = authorizedCaller_;
        implementation   = implementation_;
    }

    function deploy(
        address client,
        address executor,
        address arbiter,
        uint256 amount,
        uint256 deadlineDays,
        string  calldata terms,
        address diamond,
        address usdc,
        address trustedForwarder,
        address factory
    ) external returns (address addr) {
        require(msg.sender == authorizedCaller, "AgreementDeployer: unauthorized");
        // clone() и initialize() в одной транзакции — между ними никто не
        // вклинится, поэтому перехватить неинициализированный клон нельзя.
        addr = Clones.clone(implementation);
        Agreement(addr).initialize(
            client, executor, arbiter,
            amount, deadlineDays, terms,
            diamond, usdc, trustedForwarder, factory
        );
    }
}
