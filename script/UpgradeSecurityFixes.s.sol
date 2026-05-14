// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "forge-std/Script.sol";
import "forge-std/console.sol";
// DEPRECATED — historical upgrade script, already applied on-chain.
// OfferNFT offer-posting functions removed in cleanup (2026-05).
contract _DeprecatedOfferUpgrade is Script {
    function run() external view { console.log("DEPRECATED: script already applied."); }
}
