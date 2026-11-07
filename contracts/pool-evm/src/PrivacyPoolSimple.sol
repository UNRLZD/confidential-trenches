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

  /// @notice The type W signs to take a proof as a buy: the Buy, the note's nullifier, the proof's context and value
  bytes32 internal constant BUY_TYPEHASH = keccak256(
    'Buy(address adapter,bytes data,uint256 minOut,address token,uint256 nullifier,uint256 context,uint256 value)'
  );

  // @notice Initializes the state addresses
  constructor(
    address _withdrawalVerifier
  ) PrivacyPool(_withdrawalVerifier, Constants.NATIVE_ASSET) {}

  /// @inheritdoc IPrivacyPoolSimple
  uint256 public constant BUY_SWAP_GAS = 500_000;
  /// @inheritdoc IPrivacyPoolSimple
  uint256 public constant BUY_FAIL_GAS = 150_000;

  /// @inheritdoc IPrivacyPoolSimple
  function buy(
    Withdrawal memory _withdrawal,
    ProofLib.WithdrawProof memory _proof,
    uint256 _fee,
    Buy memory _buy,
    bytes memory _signature
  ) external nonReentrant returns (bool _bought) {
    RelayData memory _data = _relayData(_withdrawal.data);
    if (_buy.minOut == 0) revert InvalidMinOut();

    uint256 _withdrawn = _release(_withdrawal, _proof, _fee, _data, _buyDigest(_buy, _proof), _signature);
    if (_fee != 0) _push(_data.feeRecipient, _fee);

    // The swap runs in one call to the pool itself, so a revert anywhere in it (the adapter, the token's balanceOf,
    // too little out, all its gas burnt) undoes the swap alone: the note stays spent, the fee paid, and the rest of the
    // chunk goes to W as a withdraw would send it. The call is encoded first and given all the gas but BUY_FAIL_GAS,
    // read at the call, so the failure path keeps BUY_FAIL_GAS whatever the route's length; its return data is never
    // copied but on success (32 bytes, from this code). It gets at least BUY_SWAP_GAS, or the buy reverts here: a
    // sender cannot pick a gas limit that fails a swap the floor would carry, and an estimate finds the floor. The
    // 1,000 covers the few steps between this read and the call.
    bytes memory _call = abi.encodeCall(this.buySwap, (_buy, _data.recipient, _withdrawn - _fee));
    if (gasleft() < BUY_SWAP_GAS + BUY_FAIL_GAS + 1000) revert SwapGasTooLow();
    uint256 _out;
    assembly ("memory-safe") {
      _bought := call(sub(gas(), BUY_FAIL_GAS), address(), 0, add(_call, 0x20), mload(_call), 0, 0)
      if _bought {
        returndatacopy(0, 0, 0x20)
        _out := mload(0)
      }
    }

    if (_bought) {
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
    } else {
      _push(_data.recipient, _withdrawn - _fee);
      emit Withdrawn(
        _data.recipient,
        _data.feeRecipient,
        _withdrawn,
        _fee,
        _proof.existingNullifierHash(),
        _proof.newCommitmentHash()
      );
    }
  }

  /// @inheritdoc IPrivacyPoolSimple
  function buySwap(Buy calldata _buy, address _recipient, uint256 _amount) external returns (uint256 _out) {
    if (msg.sender != address(this)) revert OnlyPool();
    // The rest of the chunk goes to the adapter; W's balance of the token must rise by at least minOut
    uint256 _before = IERC20Balance(_buy.token).balanceOf(_recipient);
    IBuyAdapter(_buy.adapter).buy{value: _amount}(_buy.token, _recipient, _buy.minOut, _buy.data);
    _out = IERC20Balance(_buy.token).balanceOf(_recipient) - _before;
    if (_out < _buy.minOut) revert MinOutNotMet();
  }

  /**
   * @notice The EIP-712 digest W signs to take `_proof` as `_buy`, on this pool and this chain
   * @param _buy The buy
   * @param _proof The withdraw proof: its nullifier, context and value are signed
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
          _proof.context(),
          _proof.withdrawnValue()
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
