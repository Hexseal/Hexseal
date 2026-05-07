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

        _nonces[req.from]++;

        // EIP-2771: append original sender (req.from) to calldata so receiving
        // contracts can recover it via _msgSender() when msg.sender == trustedForwarder
        (success, retdata) = req.to.call{value: req.value, gas: req.gas}(
            abi.encodePacked(req.data, req.from)
        );

        emit Executed(req.from, req.to, success);
    }
}