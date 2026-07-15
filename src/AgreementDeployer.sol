// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// HEXSEAL — AgreementDeployer.sol
// Отдельный контракт (не фасет Diamond) который держит
// bytecode Agreement и деплоит новые инстансы через CREATE.
//
// Зачем: type(Agreement).creationCode раздувает FactoryFacet
// на ~20KB. Вынос в отдельный контракт решает проблему.
// ============================================================

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

    constructor(address authorizedCaller_) {
        require(authorizedCaller_ != address(0), "AgreementDeployer: zero caller");
        authorizedCaller = authorizedCaller_;
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
        bytes memory bytecode = abi.encodePacked(
            type(Agreement).creationCode,
            abi.encode(
                client, executor, arbiter,
                amount, deadlineDays, terms,
                diamond, usdc, trustedForwarder, factory
            )
        );
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "AgreementDeployer: deploy failed");
    }
}
