// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// ReAddOfferNFTFacet.s.sol — DEPRECATED
//
// Исторический скрипт (Apr 7). Был использован однократно.
// Для обновления OfferNFTFacet используй DeployJobReceiptNFT.s.sol
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/OfferNFTFacet.sol";
import "../src/DiamondProxy.sol";

contract ReAddOfferNFTFacet is Script {
    address constant DIAMOND = 0xF00CC71878c226E0b64253Fb71dD802aF12165D0;

    function run() external view {
        console.log("DEPRECATED: use DeployJobReceiptNFT.s.sol instead");
    }
}
