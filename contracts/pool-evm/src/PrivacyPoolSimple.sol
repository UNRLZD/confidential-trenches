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

  /// @notice The type W signs to take a proof as a buy: the Buy, the note's nullifier and the proof's context
  bytes32 internal constant BUY_TYPEHASH = keccak256(
    'Buy(address adapter,bytes data,uint256 minOut,address token,uint256 nullifier,uint256 context)'
  );

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
    if (_buy.minOut == 0) revert InvalidMinOut();

    uint256 _withdrawn = _release(_withdrawal, _proof, _fee, _data, _buyDigest(_buy, _proof), _signature);
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
   * @notice The EIP-712 digest W signs to take `_proof` as `_buy`, on this pool and this chain
   * @param _buy The buy
   * @param _proof The withdraw proof: its nullifier and context are signed
   * @return The digest
   */
  function _buyDigest(Buy memory _buy, ProofLib.WithdrawProof memory _proof) internal view returns (bytes32) {
    return _typedDigest(
      keccak256(
        abi.encode(
          BUY_TYPEHASH,
          _buy.adapter,
          keccak256(_buy.data),
          _buy.minOut,
          _buy.token,
          _proof.existingNullifierHash(),
          _proof.context()
        )
      )
    );
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
