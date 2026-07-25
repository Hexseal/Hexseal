// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract MinimalForwarder is EIP712 {
    using ECDSA for bytes32;

    struct ForwardRequest {
        address from;
        address to;
        uint256 value;
        uint256 gas;
        uint256 nonce;
        bytes data;
    }

    bytes32 private constant _TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data)"
    );

    /// Максимум байт, копируемых из ответа вызываемого контракта.
    /// Недоверенный `req.to` может вернуть сколь угодно большой буфер и сжечь
    /// газ релеера на расширении памяти. Легитимные ответы (адрес нового
    /// Agreement, uint256) укладываются в 32-64 байта.
    uint256 private constant MAX_RETURNDATA = 4096;

    mapping(address => uint256) private _nonces;

    event Executed(address indexed from, address indexed to, bool success);

    constructor() EIP712("MinimalForwarder", "0.0.1") {}

    function getNonce(address from) public view returns (uint256) {
        return _nonces[from];
    }

    function verify(ForwardRequest calldata req, bytes calldata signature) public view returns (bool) {
        address signer = _hashTypedDataV4(
            keccak256(abi.encode(
                _TYPEHASH,
                req.from,
                req.to,
                req.value,
                req.gas,
                req.nonce,
                keccak256(req.data)
            ))
        ).recover(signature);
        return signer == req.from;
    }

    function execute(ForwardRequest calldata req, bytes calldata signature)
        external payable returns (bool success, bytes memory retdata)
    {
        require(verify(req, signature), "MinimalForwarder: signature does not match request");
        require(_nonces[req.from] == req.nonce, "MinimalForwarder: nonce mismatch");
        // Без этой проверки вызов с req.value > msg.value оплачивается балансом
        // самого форвардера — любой осевший на нём ETH выводится самоподписанным
        // запросом.
        require(msg.value == req.value, "MinimalForwarder: value mismatch");

        _nonces[req.from]++;

        // EIP-2771: append original sender (req.from) to calldata so receiving
        // contracts can recover it via _msgSender() when msg.sender == trustedForwarder
        bytes memory payload = abi.encodePacked(req.data, req.from);

        // Вызов сделан вручную в assembly с нулевым выходным буфером (последние
        // 0, 0 у call) — это, а не отбрасывание переменной на уровне Solidity,
        // и есть фикс: `.call(...)` на уровне языка всегда тянет за собой
        // стандартный хелпер компилятора, который копирует ответ в память
        // целиком ещё до того, как мы успеваем его ограничить (проверено
        // дизассемблингом — там был безусловный returndatacopy на весь размер).
        // Здесь CALL не копирует ничего сам, а returndata мы забираем ниже
        // вручную, с капом.
        address to = req.to;
        uint256 value = req.value;
        uint256 gasLimit = req.gas;
        uint256 size;
        assembly ("memory-safe") {
            success := call(gasLimit, to, value, add(payload, 0x20), mload(payload), 0, 0)
            size := returndatasize()
        }
        if (size > MAX_RETURNDATA) size = MAX_RETURNDATA;
        retdata = new bytes(size);
        assembly ("memory-safe") {
            returndatacopy(add(retdata, 0x20), 0, size)
        }

        emit Executed(req.from, req.to, success);
    }
}
