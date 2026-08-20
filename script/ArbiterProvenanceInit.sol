// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ArbiterRegistryStorage} from "../src/facets/ArbiterRegistryFacet.sol";

/**
 * Одноразовый init-контракт миграции провенанса.
 *
 * Зовётся ТОЛЬКО делегированным вызовом из diamondCut(_init, _calldata), то
 * есть исполняется в хранилище даймонда и под его же владельческой проверкой
 * (DiamondCutFacet.diamondCut → OwnershipLib.enforceIsContractOwner). Прямой
 * вызов этого контракта посторонним пишет в ЕГО СОБСТВЕННОЕ хранилище и
 * даймонда не касается — гейта здесь нет за ненадобностью, а не по недосмотру.
 *
 * Почему init, а не функция в фасете: писать «кто посадил» задним числом
 * незачем никогда больше. Постоянный вход для этого — это постоянная
 * возможность переписать провенанс живого арбитра, то есть ровно та тихая
 * правка публичной записи, против которой сделана вся работа. Init-контракт
 * живёт одну транзакцию и в даймонде не остаётся: маршрутов он не получает.
 *
 * Событие своё, не ArbiterSeated. Посадка произошла в июле, и выпустить
 * сегодня событие о посадке значило бы соврать в ленте. Здесь дописывают
 * недостающее поле, и запись говорит именно это.
 */
contract ArbiterProvenanceInit {
    event ArbiterProvenanceBackfilled(address indexed arbiter, address indexed seater);

    error ProvenanceZeroSeater();
    error ProvenanceNotAnArbiter(address who);

    /// Дописывает seatedBy тем, у кого он пуст, и поднимает seatedCountBy
    /// посадившего ровно на число дописанных.
    ///
    /// Идемпотентна: арбитр с уже записанным провенансом пропускается молча —
    /// повторный запуск не превратит одну посадку в две и не раздует счётчик,
    /// на котором держится потолок блока директора.
    ///
    /// Не-арбитр — отказ, а не пропуск: адрес, которого нет в корпусе, попал
    /// сюда из ошибочного списка, и записывать ему провенанс значит утверждать
    /// в цепи, что кто-то его посадил.
    function backfillSeatedBy(address[] calldata arbiters, address seater) external {
        if (seater == address(0)) revert ProvenanceZeroSeater();

        ArbiterRegistryStorage.Data storage d = ArbiterRegistryStorage.data();
        for (uint256 i = 0; i < arbiters.length; i++) {
            address a = arbiters[i];
            if (!d.isArbiter[a]) revert ProvenanceNotAnArbiter(a);
            if (d.seatedBy[a] != address(0)) continue;

            d.seatedBy[a] = seater;
            d.seatedCountBy[seater]++;
            emit ArbiterProvenanceBackfilled(a, seater);
        }
    }
}
