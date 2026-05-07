// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/FactoryFacet.sol";

/// @notice Обновляет feeRecipient в Diamond (и опционально trustedForwarder).
/// Запуск:
///   forge script script/UpdateKeys.s.sol \
///     --rpc-url $BASE_SEPOLIA_RPC_URL \
///     --private-key $PRIVATE_KEY \
///     --broadcast
contract UpdateKeys is Script {
    function run() external {
        address diamond       = vm.envAddress("DIAMOND_ADDRESS");
        uint256 ownerKey      = vm.envUint("PRIVATE_KEY");
        address newFeeRecipient = vm.envAddress("FEE_RECIPIENT");

        console.log("Diamond:          ", diamond);
        console.log("New feeRecipient: ", newFeeRecipient);

        // Текущие значения для проверки
        address currentFeeRecipient = FactoryFacet(diamond).getFeeRecipient();
        address currentForwarder    = FactoryFacet(diamond).getTrustedForwarder();
        console.log("Current feeRecipient: ", currentFeeRecipient);
        console.log("Current forwarder:    ", currentForwarder);

        vm.startBroadcast(ownerKey);

        // Обновить feeRecipient
        if (currentFeeRecipient != newFeeRecipient) {
            FactoryFacet(diamond).setFeeRecipient(newFeeRecipient);
            console.log("feeRecipient updated to:", newFeeRecipient);
        } else {
            console.log("feeRecipient already up to date, skipping");
        }

        vm.stopBroadcast();

        // Финальная проверка
        address finalFeeRecipient = FactoryFacet(diamond).getFeeRecipient();
        console.log("Final feeRecipient:", finalFeeRecipient);
        require(finalFeeRecipient == newFeeRecipient, "feeRecipient not updated!");
    }
}
