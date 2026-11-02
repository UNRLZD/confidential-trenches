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
// Changes (contracts/pool-evm/NOTICE): no Entrypoint or ragequit verifier address in the constructor; import paths.

import {Constants} from './lib/Constants.sol';

import {PrivacyPool} from './PrivacyPool.sol';
import {IPrivacyPoolSimple} from 'interfaces/IPrivacyPool.sol';

/**
 * @title PrivacyPoolSimple
 * @notice Native asset implementation of Privacy Pool.
 */
contract PrivacyPoolSimple is PrivacyPool, IPrivacyPoolSimple {
  // @notice Initializes the state addresses
  constructor(
    address _withdrawalVerifier
  ) PrivacyPool(_withdrawalVerifier, Constants.NATIVE_ASSET) {}

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
