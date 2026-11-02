// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IPrivacyPoolSimple} from 'interfaces/IPrivacyPool.sol';

import {Deploy} from './Deploy.sol';

/// W's EIP-712 signatures as the device's wallet makes them, written here apart from the pool's own encoder. W is the
/// Hardhat mnemonic's account 0, a published test key.
abstract contract Signing is Deploy {
  string internal constant MNEMONIC = 'test test test test test test test test test test test junk';

  function _domain(uint256 _chainId, address _pool) internal pure returns (bytes32) {
    return keccak256(
      abi.encode(
        keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
        keccak256('Blindfill'),
        keccak256('1'),
        _chainId,
        _pool
      )
    );
  }

  function _withdrawDigest(
    uint256 _nullifier,
    uint256 _context,
    uint256 _chainId,
    address _pool
  ) internal pure returns (bytes32) {
    bytes32 _struct = keccak256(abi.encode(keccak256('Withdraw(uint256 nullifier,uint256 context)'), _nullifier, _context));
    return keccak256(abi.encodePacked(hex'1901', _domain(_chainId, _pool), _struct));
  }

  function _buyDigest(
    IPrivacyPoolSimple.Buy memory _b,
    uint256 _nullifier,
    uint256 _context,
    uint256 _chainId,
    address _pool
  ) internal pure returns (bytes32) {
    bytes32 _struct = keccak256(
      abi.encode(
        keccak256('Buy(address adapter,bytes data,uint256 minOut,address token,uint256 nullifier,uint256 context)'),
        _b.adapter,
        keccak256(_b.data),
        _b.minOut,
        _b.token,
        _nullifier,
        _context
      )
    );
    return keccak256(abi.encodePacked(hex'1901', _domain(_chainId, _pool), _struct));
  }

  function _sign(uint256 _key, bytes32 _d) internal pure returns (bytes memory) {
    (uint8 _v, bytes32 _r, bytes32 _s) = vm.sign(_key, _d);
    return abi.encodePacked(_r, _s, _v);
  }
}
