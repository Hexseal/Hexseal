// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ════════════════════════════════════════════════════════════════════════════
// Золотой отпечаток метаданных, которые видит человек.
//
// Зачем. `DealMetadataFacet.getDealTokenURI` и `SVGRenderer` собирают JSON и SVG
// прямо в цепи, через `Base64` и `Strings` из OpenZeppelin. До 15 августа 2026
// содержимое этого вывода не проверял НИ ОДИН тест: единственный тест про
// tokenURI (Boards.t.sol) утверждал, что без рендерера вызов ревертит, — то есть
// сторожил отсутствие рендерера, а не то, что он рисует.
//
// Замер, которым дыра найдена: при обновлении OpenZeppelin `Base64.sol` менялся
// на +144/-29 строк, `Strings.sol` на +48/-24. Вопрос «изменится ли от этого
// картинка у пользователя» задать было некому — вся подвеска зелёная в любом
// случае. Этот файл делает такой вопрос отвечаемым.
//
// Что делать, если покраснел. Значит байты, которые кошелёк показывает
// владельцу NFT, стали другими. Это не обязательно плохо — но обязано быть
// НАМЕРЕННЫМ. Посмотри на вывод (тест печатает обе строки целиком при -vv),
// убедись, что новая картинка та, которую ты хотел, и обнови константу.
// Молча подгонять константу под новый хеш — ровно тот случай, ради которого
// файл написан.
// ════════════════════════════════════════════════════════════════════════════

import "forge-std/Test.sol";
import "../src/facets/DealMetadataFacet.sol";
import "../src/SVGRenderer.sol";

contract MetadataRenderSnapshotTest is Test {
    DealMetadataFacet internal meta;
    SVGRenderer internal renderer;

    // Входные данные прибиты гвоздями: рендер `pure`, поэтому вывод зависит
    // только от них и от кода OpenZeppelin.
    address internal constant DEAL     = address(0xdEA110C0dE0000000000000000000000000000a1);
    address internal constant CLIENT   = address(0xc11E4700000000000000000000000000000000B2);
    address internal constant EXECUTOR = address(0xe8ec0700000000000000000000000000000000c3);
    uint256 internal constant AMOUNT   = 1_234_567_890;      // 1234.56789 USDC
    uint256 internal constant DAYS_    = 14;
    bytes32 internal constant TERMS    = keccak256("hexseal.metadata.snapshot.terms");

    function setUp() public {
        meta = new DealMetadataFacet();
        renderer = new SVGRenderer();
    }

    /// Все семь статусов сделки разом: у каждого своя картинка и свои атрибуты.
    function testDealTokenURIRenderIsUnchanged() public view {
        bytes memory joined;
        for (uint8 status = 0; status < 7; status++) {
            string memory uri = meta.getDealTokenURI(
                DEAL, 0, status, CLIENT, EXECUTOR, AMOUNT, DAYS_, TERMS
            );
            console.log("--- status", status, "---");
            console.log(uri);
            joined = abi.encodePacked(joined, uri);
        }

        assertEq(
            keccak256(joined),
            0xcae50244f4ecc1268eea42189362e4fcb67d3db7d5a172a01ace2dbcb66e5745,
            unicode"Вывод getDealTokenURI изменился. Прочти шапку файла: подгонять константу можно только после того, как ты посмотрел на новую картинку и признал её верной."
        );
    }

    function testReceiptRenderIsUnchanged() public view {
        string memory out = renderer.renderReceipt(
            ISVGRenderer.ReceiptParams({
                tokenId: 42,
                client: CLIENT,
                title: unicode"Ремонт кофеварки",
                amount: AMOUNT,
                deadlineDays: DAYS_,
                region: 3,
                createdAt: 1_760_000_000
            })
        );
        console.log(out);

        assertEq(
            keccak256(bytes(out)),
            0xae92d489923d9bd260a721eb54bd0337e0780507105389cc1817b76ed3879a63,
            unicode"Вывод renderReceipt изменился — см. шапку файла."
        );
    }

    function testOfferRenderIsUnchanged() public view {
        string memory out = renderer.renderOffer(
            ISVGRenderer.OfferParams({
                tokenId: 7,
                executor: EXECUTOR,
                title: unicode"Вёрстка лендинга",
                category: unicode"Дизайн",
                price: AMOUNT,
                deadlineDays: DAYS_,
                createdAt: 1_760_000_000,
                active: true,
                hiresCount: 5
            })
        );
        console.log(out);

        assertEq(
            keccak256(bytes(out)),
            0xec73470f6e748a0c51ce8138fe5a3b4f523dea2fe1bb3e2d0095c3601b8b6216,
            unicode"Вывод renderOffer изменился — см. шапку файла."
        );
    }
}
