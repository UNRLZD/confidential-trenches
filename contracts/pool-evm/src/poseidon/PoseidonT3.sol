// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @title PoseidonT3
/// @notice poseidon-solidity 0.0.5's PoseidonT3 (MIT, by Chance Hudson), called where it is deployed on every chain
///         with a STATICCALL: the deterministic deployment proxy (0x4e59b44847b379578588920ca78fbf26c0b4956c) puts its
///         bytes at 0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93, an address that commits to them (CREATE2). Linked as a library it would be a DELEGATECALL;
///         inlined it would put the pool over the 24,576-byte code limit. The pool's tests deploy the same bytes at the
///         same address through the same proxy and check their hash against the code read on Base and Robinhood.
///         This file stands in for poseidon-solidity/PoseidonT3.sol (foundry.toml's remapping), so the vendored
///         lean-imt/InternalLeanIMT.sol, which imports it, is unchanged.
library PoseidonT3 {
  address internal constant DEPLOYED = 0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93;
  /// @notice The hash of the code at DEPLOYED, read on Base and Robinhood; the pool's constructor checks it
  bytes32 internal constant CODEHASH = 0x4495c92f7f5db02c3922c3e56cbe427af9cb349a77fd3faf41165afb3137d022;

  /// @notice Poseidon over 2 field elements; reverts when the code is missing or the call fails
  function hash(uint256[2] memory _inputs) internal pure returns (uint256) {
    return IPoseidonT3(DEPLOYED).hash(_inputs);
  }
}

interface IPoseidonT3 {
  function hash(uint256[2] memory _inputs) external pure returns (uint256);
}
