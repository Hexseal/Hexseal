// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Провенанс посадки: цепь обязана помнить, КТО посадил арбитра.
//
// До 15 августа 2026 `ArbiterAdded(arbiter)` не говорил ни кто нажал, ни каким
// путём человек сел. Из-за этого нельзя было ни ограничить директора, ни
// честно показать читателю, что за ручным арбитром не стоит ни залога, ни
// гейта по XP.
//
// Сетап лёгкий: фасет развёрнут отдельно, настоящего даймонда не нужно.
// Владелец даймонда в этом стенде — сам тест-контракт (OwnershipLib читает
// слот владельца, и `new ArbiterRegistryFacet()` оставляет его нулевым),
// поэтому владельца сажаем прямой записью в слот.

import "forge-std/Test.sol";
import {ArbiterRegistryFacet} from "../src/facets/ArbiterRegistryFacet.sol";

contract ArbiterProvenanceTest is Test {
    ArbiterRegistryFacet facet;

    address owner;
    address chief;
    address seat1;
    address seat2;

    /// Слот владельца даймонда — DiamondStorage.POSITION + 4
    /// (OwnershipLib.contractOwner() → DiamondStorage.Layout.contractOwner,
    /// пятое поле struct Layout: mapping/mapping/array/mapping занимают слоты
    /// +0..+3, contractOwner лежит в +4).
    ///
    /// Значение из брифа задачи (0xc8fcad8d…) не подставляло владельца вовсе:
    /// проверено замером — с ним `setChiefArbiter` в setUp падал `NotOwner()`
    /// ещё до первого теста. DIAMOND_STORAGE_POSITION пересчитан дословно по
    /// формуле erc7201 из комментария над константой в `src/DiamondProxy.sol`
    /// (`cast keccak` / `cast abi-encode`) и сходится байт-в-байт с исходником;
    /// первая попытка `POSITION + 0` тоже давала `NotOwner()` — offset поля
    /// внутри struct Layout виден только по самому struct, не по формуле
    /// erc7201. `POSITION + 4` проверен запуском теста.
    bytes32 constant OWNER_SLOT = 0x178642b411f9f4783b21ef338f3e96db6c1272d763f0b7500ec93464dafb8604;

    function setUp() public {
        facet = new ArbiterRegistryFacet();
        owner = address(0x0);
        chief = address(0xC4);
        seat1 = address(0xA1);
        seat2 = address(0xA2);

        owner = address(this);
        vm.store(address(facet), OWNER_SLOT, bytes32(uint256(uint160(owner))));
        facet.setChiefArbiter(chief);
    }

    function test_OwnerSeatIsAttributedToOwner() public {
        vm.expectEmit(true, true, false, true, address(facet));
        emit ArbiterRegistryFacet.ArbiterSeated(seat1, owner, false);

        facet.addArbiter(seat1);

        assertEq(facet.getSeatedBy(seat1), owner, unicode"цепь обязана помнить, что посадил владелец");
        assertEq(facet.getSeatedCountBy(owner), 1, unicode"счётчик посадок владельца обязан вырасти");
    }

    function test_ChiefSeatIsAttributedToChief() public {
        vm.prank(chief);
        facet.addArbiter(seat1);

        assertEq(facet.getSeatedBy(seat1), chief, unicode"посадил директор — так и записано");
        assertEq(facet.getSeatedCountBy(chief), 1, unicode"счётчик директора");
        assertEq(facet.getSeatedCountBy(owner), 0, unicode"владельцу чужая посадка не приписывается");
    }

    /// removeArbiter в тестах намеренно не используется: более поздняя задача
    /// этого же плана удаляет функцию целиком, и тест на ней стал бы мёртвым
    /// грузом. Очистку места на выходе проверяем через resignAsArbiter() —
    /// она переживает план и зовёт тот же хелпер _clearSeat. В чистом стенде
    /// arbiterBond[seat1] == 0 (addArbiter бонд не берёт), поэтому
    /// resignAsArbiter не трогает USDC вовсе — мок токена не нужен.
    function test_ResignDecrementsSeaterCount() public {
        vm.prank(chief);
        facet.addArbiter(seat1);
        assertEq(facet.getSeatedCountBy(chief), 1);

        vm.prank(seat1);
        facet.resignAsArbiter();

        assertEq(facet.getSeatedCountBy(chief), 0, unicode"снятый больше не сидит — счётчик посадившего падает");
        assertEq(facet.getSeatedBy(seat1), address(0), unicode"провенанс снятого очищается");
    }

    /// Счётчик посадок накапливается и не смешивает посадивших.
    ///
    /// ⚠️ Двоих сажает ВЛАДЕЛЕЦ, а не директор (п. 67, 16 августа 2026):
    /// потолок блока директора опустился до единицы, и прежняя редакция —
    /// две подряд посадки директором — теперь ревертит. Проверяемое свойство
    /// здесь про счётчик, а не про потолок, поэтому взят тот, кого потолок не
    /// касается; директор оставлен в сцене одной посадкой, иначе «раздельно»
    /// проверять было бы не с кем.
    function test_TwoSeatsCountSeparately() public {
        facet.addArbiter(seat1);
        facet.addArbiter(seat2);
        assertEq(facet.getSeatedCountBy(owner), 2, unicode"две посадки — счётчик два");

        vm.prank(chief);
        facet.addArbiter(address(0xA3));

        assertEq(facet.getSeatedCountBy(owner), 2, unicode"чужая посадка счётчик владельца не двигает");
        assertEq(facet.getSeatedCountBy(chief), 1, unicode"а своя ложится на счётчик директора");
    }

    // ============================================================
    //  ПОТОЛОК ЗАПАСА ДИРЕКТОРА
    //
    //  Требуемое свойство — не число, а факт: директор НИКОГДА не решает
    //  апелляцию. Не «не держит кворум» — это слабее и ничего не даёт
    //  (п. 67, 16 августа 2026): resolveAppeal подводит итог ПРОСТЫМ
    //  БОЛЬШИНСТВОМ поданных голосов, как только их набралось
    //  APPEAL_MIN_VOTES, и при явке ровно в кворум решают ДВА из трёх.
    //  Значит потолок обязан держать двойку, а не тройку: блок ≤ 1.
    //
    //  Потолок скорости («не чаще одного в неделю») этого свойства не даёт:
    //  за год набирается пятьдесят два.
    // ============================================================

    function test_ChiefSeatsOneFreely() public {
        vm.prank(chief);
        facet.addArbiter(seat1);
        assertEq(facet.getChiefBloc(), 1, unicode"одного директор сажает сам");
    }

    /// Второй — уже большинство при явке в кворум, и его цепь не пускает.
    function test_ChiefCannotDecideAppeal() public {
        vm.startPrank(chief);
        facet.addArbiter(seat1);
        vm.expectRevert(
            abi.encodeWithSelector(ArbiterRegistryFacet.ChiefBlocWouldDecideAppeal.selector, 2, 2)
        );
        facet.addArbiter(seat2);
        vm.stopPrank();
    }

    /// Директор может быть арбитром сам — setChiefArbiter этого не запрещает.
    /// Тогда он сам плюс ОДИН ставленник — это уже два голоса, то есть
    /// решающее большинство при явке в кворум. Значит он сам обязан считаться
    /// в блоке, и первая же его посадка обязана отказать.
    function test_ChiefCountsHimselfWhenHeIsArbiter() public {
        facet.addArbiter(chief);            // владелец сажает директора арбитром
        assertEq(facet.getChiefBloc(), 1, unicode"директор-арбитр — уже единица блока");

        vm.prank(chief);
        vm.expectRevert(
            abi.encodeWithSelector(ArbiterRegistryFacet.ChiefBlocWouldDecideAppeal.selector, 2, 2)
        );
        facet.addArbiter(seat1);
    }

    /// Владельца потолок не касается: он и есть тот, кто решает.
    function test_OwnerIsNotCapped() public {
        facet.addArbiter(seat1);
        facet.addArbiter(seat2);
        facet.addArbiter(address(0xA3));
        facet.addArbiter(address(0xA4));
        assertEq(facet.getSeatedCountBy(owner), 4, unicode"владелец сажает сколько нужно");
    }

    /// Ушёл один — освободилось место. Иначе директор, ошибшийся один раз,
    /// заперт навсегда.
    ///
    /// ⚠️ Выход из корпуса здесь через `resignAsArbiter`, а НЕ через
    /// `removeArbiter`: та удалена целиком (задача 6 плана
    /// 2026-08-15-arbiter-accountability). `resignAsArbiter` зовёт тот же
    /// хелпер очистки места.
    function test_ResignFreesChiefSlot() public {
        vm.prank(chief);
        facet.addArbiter(seat1);

        vm.prank(seat1);
        facet.resignAsArbiter();
        assertEq(facet.getChiefBloc(), 0, unicode"место освободилось");

        vm.prank(chief);
        facet.addArbiter(seat2);
        assertEq(facet.getChiefBloc(), 1, unicode"и занято заново");
    }

    /// Пятая проверка, которой не было: потолок обязан быть СТРОГО НИЖЕ
    /// кворума, а не равен ему. Это и есть вся разница между «не решает
    /// апелляцию» и «не держит кворум», и без отдельной проверки её легко
    /// потерять обратно при следующей правке — ровно так она и появилась.
    ///
    /// Число 2 читается из полезной нагрузки ошибки: приватную константу
    /// снаружи не прочесть, а ревёрт её называет. Второй конец связи —
    /// поведенческий и лежит в test/Diamond.t.sol: там два голоса из трёх
    /// реально переворачивают вердикт.
    function test_ChiefCapIsStrictlyBelowQuorum() public {
        vm.prank(chief);
        facet.addArbiter(seat1);

        vm.prank(chief);
        try facet.addArbiter(seat2) {
            revert(unicode"вторая посадка директора обязана отказать");
        } catch (bytes memory err) {
            assertEq(bytes4(err), ArbiterRegistryFacet.ChiefBlocWouldDecideAppeal.selector);
            (uint256 bloc, uint256 deciding) = abi.decode(_stripSelector(err), (uint256, uint256));
            assertEq(bloc, 2, unicode"блок после посадки — двое");
            assertEq(deciding, 2, unicode"решающее большинство при кворуме 3 — двое, не трое");
        }
    }

    /// Обрезает четырёхбайтовый селектор ошибки, оставляя её поля.
    function _stripSelector(bytes memory err) internal pure returns (bytes memory out) {
        out = new bytes(err.length - 4);
        for (uint256 i = 4; i < err.length; i++) out[i - 4] = err[i];
    }
}
