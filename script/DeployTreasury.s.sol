// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// HEXSEAL — DeployTreasury.s.sol
// Деплой казны протокола. НЕ подставляет её получателем комиссий — это
// отдельное решение человека, отдельной транзакцией:
//   cast send $DIAMOND_ADDRESS "setFeeRecipient(address)" <treasury> \
//     --private-key $PRIVATE_KEY --rpc-url $BASE_SEPOLIA_RPC_URL
// Разделено намеренно: деплой обратим (просто не подставлять), подстановка
// перенаправляет весь доход протокола.

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/Treasury.sol";

contract DeployTreasury is Script {
    function run() external {
        address usdc       = vm.envAddress("USDC_ADDRESS");
        address diamond    = vm.envAddress("DIAMOND_ADDRESS");
        address foundation = vm.envAddress("FOUNDATION_ADDRESS");

        require(usdc       != address(0), "DeployTreasury: USDC_ADDRESS is zero");
        require(diamond    != address(0), "DeployTreasury: DIAMOND_ADDRESS is zero");
        require(foundation != address(0), "DeployTreasury: FOUNDATION_ADDRESS is zero");
        require(usdc.code.length    > 0,  "DeployTreasury: USDC_ADDRESS has no code");
        require(diamond.code.length > 0,  "DeployTreasury: DIAMOND_ADDRESS has no code");

        vm.startBroadcast();
        Treasury treasury = new Treasury(usdc, diamond, foundation);
        vm.stopBroadcast();

        console.log("Treasury:            ", address(treasury));
        console.log("  usdc:              ", usdc);
        console.log("  diamond:           ", diamond);
        console.log("  foundation:        ", foundation);
        console.log("");
        console.log("NOT wired in yet. To route protocol fees here, run:");
        console.log("  cast send <diamond> \"setFeeRecipient(address)\" <treasury>");
    }
}
