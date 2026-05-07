// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/OfferNFTFacet.sol";
import "../src/DiamondProxy.sol";

/**
 * @notice DEPRECATED — используй UpgradeOfferNFTFacet.s.sol
 *
 * Этот скрипт — первоначальный деплой OfferNFTFacet (до рефакторинга на ERC-721).
 * Оставлен для истории. Для обновления используй:
 *   forge script script/UpgradeOfferNFTFacet.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast
 */
contract DeployOfferNFTFacet is Script {
    function run() external view {
        console.log("DEPRECATED: use UpgradeOfferNFTFacet.s.sol instead");
    }
}
