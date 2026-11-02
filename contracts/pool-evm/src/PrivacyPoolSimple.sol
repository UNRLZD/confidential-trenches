// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/*

Made with ♥ for 0xBow by

░██╗░░░░░░░██╗░█████╗░███╗░░██╗██████╗░███████╗██████╗░██╗░░░░░░█████╗░███╗░░██╗██████╗░
░██║░░██╗░░██║██╔══██╗████╗░██║██╔══██╗██╔════╝██╔══██╗██║░░░░░██╔══██╗████╗░██║██╔══██╗
░╚██╗████╗██╔╝██║░░██║██╔██╗██║██║░░██║█████╗░░██████╔╝██║░░░░░███████║██╔██╗██║██║░░██║
░░████╔═████║░██║░░██║██║╚████║██║░░██║██╔══╝░░██╔══██╗██║░░░░░██╔══██║██║╚████║██║░░██║
░░╚██╔╝░╚██╔╝░╚█████╔╝██║░╚███║██████╔╝███████╗██║░░██║███████╗██║░░██║██║░╚███║██████╔╝
░░░╚═╝░░░╚═╝░░░╚════╝░╚═╝░░╚══╝╚═════╝░╚══════╝╚═╝░░╚═╝╚══════╝╚═╝░░╚═╝╚═╝░░╚══╝╚═════╝░

https://defi.sucks/

*/

// Blindfill: ported from Privacy Pools v1.3.0 (commit c312dcd,
// packages/contracts/src/contracts/implementations/PrivacyPoolSimple.sol), Copyright 2025 0XBOW LTD, Apache-2.0.
// Changes (contracts/pool-evm/NOTICE): no Entrypoint or ragequit verifier address in the constructor; import paths;
// Blindfill's buy: a relayed release into a swap for W, signed by W (NOTICE change 11).

import {Constants} from './lib/Constants.sol';
import {ProofLib} from './lib/ProofLib.sol';

import {PrivacyPool} from './PrivacyPool.sol';
import {IBuyAdapter, IERC20Balance} from 'interfaces/IBuyAdapter.sol';
import {IPrivacyPoolSimple} from 'interfaces/IPrivacyPool.sol';

/**
 * @title PrivacyPoolSimple
 * @notice Native asset implementation of Privacy Pool.
 */
contract PrivacyPoolSimple is PrivacyPool, IPrivacyPoolSimple {
  using ProofLib for ProofLib.WithdrawProof;

  /// @notice EIP-712's domain type, and the domain's name and version
  bytes32 internal constant DOMAIN_TYPEHASH =
    keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
  bytes32 internal constant NAME_HASH = keccak256('Blindfill');
  bytes32 internal constant VERSION_HASH = keccak256('1');
  /// @notice The type W signs: a Buy with the nullifier of the note it spends
  bytes32 internal constant BUY_TYPEHASH =
    keccak256('Buy(address adapter,bytes data,uint256 minOut,address token,uint256 nullifier)');
  /// @notice Half the secp256k1 group order: a signature's s is at most this (EIP-2), so it has one form
  uint256 internal constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

  // @notice Initializes the state addresses
  constructor(
    address _withdrawalVerifier
  ) PrivacyPool(_withdrawalVerifier, Constants.NATIVE_ASSET) {}

  /// @inheritdoc IPrivacyPoolSimple
  function buy(
    Withdrawal memory _withdrawal,
    ProofLib.WithdrawProof memory _proof,
    uint256 _fee,
    Buy memory _buy,
    bytes memory _signature
  ) external nonReentrant {
    RelayData memory _data = _relayData(_withdrawal.data);
    // W signed this buy of this note, on this pool and this chain
    if (_signer(_buyDigest(_buy, _proof.existingNullifierHash()), _signature) != _data.recipient) {
      revert InvalidSignature();
    }
    if (_buy.minOut == 0) revert InvalidMinOut();

    uint256 _withdrawn = _release(_withdrawal, _proof, _fee, _data);
    if (_fee != 0) _push(_data.feeRecipient, _fee);

    // The rest of the chunk goes to the adapter; W's balance of the token must rise by at least minOut
    uint256 _before = IERC20Balance(_buy.token).balanceOf(_data.recipient);
    IBuyAdapter(_buy.adapter).buy{value: _withdrawn - _fee}(_buy.token, _data.recipient, _buy.minOut, _buy.data);
    uint256 _out = IERC20Balance(_buy.token).balanceOf(_data.recipient) - _before;
    if (_out < _buy.minOut) revert MinOutNotMet();

    emit Bought(
      _data.recipient,
      _data.feeRecipient,
      _withdrawn,
      _fee,
      _proof.existingNullifierHash(),
      _proof.newCommitmentHash(),
      _buy.token,
      _out
    );
  }

  /**
   * @notice The EIP-712 digest W signs for a buy of the note whose nullifier hash is `_nullifier`, on this pool and
   *         this chain (read at each call)
   * @param _buy The buy
   * @param _nullifier The spend's nullifier hash
   * @return The digest
   */
  function _buyDigest(Buy memory _buy, uint256 _nullifier) internal view returns (bytes32) {
    bytes32 _domain = keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    bytes32 _struct = keccak256(
      abi.encode(BUY_TYPEHASH, _buy.adapter, keccak256(_buy.data), _buy.minOut, _buy.token, _nullifier)
    );
    return keccak256(abi.encodePacked(hex'1901', _domain, _struct));
  }

  /**
   * @notice The address that signed `_digest`: r, s, v, with s in the lower half; 0 for no signer
   * @param _digest The signed digest
   * @param _signature r, s, v (65 bytes)
   * @return The signer
   */
  function _signer(bytes32 _digest, bytes memory _signature) internal pure returns (address) {
    if (_signature.length != 65) revert InvalidSignature();
    bytes32 _r;
    bytes32 _s;
    uint8 _v;
    assembly ("memory-safe") {
      _r := mload(add(_signature, 0x20))
      _s := mload(add(_signature, 0x40))
      _v := byte(0, mload(add(_signature, 0x60)))
    }
    if (uint256(_s) > HALF_N) revert InvalidSignature();
    return ecrecover(_digest, _v, _r, _s);
  }

  /**
   * @notice Handle receiving native asset asset
   * @param _amount The amount of asset receiving
   * @inheritdoc PrivacyPool
   */
  function _pull(address, uint256 _amount) internal override(PrivacyPool) {
    // Check the amount matches the value sent
    if (msg.value != _amount) revert InsufficientValue();
  }

  /**
   * @notice Handle sending native asset
   * @param _recipient The address of the user receiving the asset
   * @param _amount The amount of native asset being sent
   * @inheritdoc PrivacyPool
   */
  function _push(address _recipient, uint256 _amount) internal override(PrivacyPool) {
    /// Try to send native asset to recipient
    (bool _success,) = _recipient.call{value: _amount}('');
    if (!_success) revert FailedToSendNativeAsset();
  }
}
