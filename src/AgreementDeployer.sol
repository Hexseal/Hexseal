// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// SIGNATURE404 — AgreementDeployer.sol
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
        bytes32 termsHash,
        address diamond,
        address usdc,
        address trustedForwarder,
        address factory
    ) external returns (address);
}

contract AgreementDeployer is IAgreementDeployer {
    function deploy(
        address client,
        address executor,
        address arbiter,
        uint256 amount,
        uint256 deadlineDays,
        bytes32 termsHash,
        address diamond,
        address usdc,
        address trustedForwarder,
        address factory
    ) external returns (address addr) {
        bytes memory bytecode = abi.encodePacked(
            type(Agreement).creationCode,
            abi.encode(
                client, executor, arbiter,
                amount, deadlineDays, termsHash,
                diamond, usdc, trustedForwarder, factory
            )
        );
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "AgreementDeployer: deploy failed");
    }
}
