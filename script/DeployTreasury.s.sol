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

        // Наличия кода МАЛО. Рядом в .env лежат ещё два адреса контрактов —
        // TRUSTED_FORWARDER и USDC_ADDRESS, — и у обоих код есть. Опечатка в
        // DIAMOND_ADDRESS прошла бы проверку выше и дала бы НЕИЗМЕНЯЕМУЮ казну,
        // у которой ревертит любой distribute() (казна не может ни исправить
        // адрес, ни мигрировать: в ней нет ни одной onlyOwner-функции), а весь
        // отправленный на неё доход потерян навсегда. Поэтому проверяем не
        // «контракт», а «ТОТ САМЫЙ контракт»: пробуем ровно те ЧЕТЫРЕ чтения,
        // которыми казна пользуется в работе.
        //
        // Четвёртое — getUniqueActiveUsers() — живёт в ДРУГОМ фасете
        // (ReputationFacet), чем первые три (ArbiterRegistryFacet), и без него
        // пре-флайт был неполон по-настоящему, а не формально: диамонд с
        // ArbiterRegistryFacet, но без ReputationFacet проходил три пробы и
        // давал неизменяемую казну с мёртвым withdrawReserve() — то есть
        // резерв не вышел бы к ДАО НИКОГДА.
        _requireDiamondAnswers(diamond, "getVaultBalance()");
        _requireDiamondAnswers(diamond, "isDaoActive()");
        _requireDiamondAnswers(diamond, "getDAOAddress()");
        _requireDiamondAnswers(diamond, "getUniqueActiveUsers()");

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

    /// Пробует прочитать селектор с указанного адреса. Требует и успеха, и
    /// ответа длиной в целое слово: диамонд без нужного фасета ревертит
    /// фоллбэком, а посторонний контракт (форвардер, USDC) на чужой селектор
    /// либо ревертит, либо отвечает пустотой — оба случая ловятся здесь.
    function _requireDiamondAnswers(address diamond, string memory signature) internal view {
        (bool ok, bytes memory data) = diamond.staticcall(abi.encodeWithSignature(signature));
        require(
            ok && data.length >= 32,
            string.concat(
                "DeployTreasury: DIAMOND_ADDRESS does not answer ", signature,
                " -- wrong address? (TRUSTED_FORWARDER and USDC_ADDRESS live in the same .env and also have code). ",
                "A treasury deployed against a wrong diamond is IMMUTABLE and reverts on every distribute()."
            )
        );
    }
}
