// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFactory {
    function deployAgreement(
        address client,
        address executor,
        address arbiter,
        uint256 amount,
        uint256 deadlineDays,
        bytes32 termsHash,
        uint8 region
    ) external returns (address agreementAddress);
}
