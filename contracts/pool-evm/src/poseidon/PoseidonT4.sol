// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @title PoseidonT4
/// @notice poseidon-solidity 0.0.5's PoseidonT4 (MIT, by Chance Hudson), called where it is deployed on every chain
///         with a STATICCALL: the deterministic deployment proxy (0x4e59b44847b379578588920ca78fbf26c0b4956c) puts its
///         bytes at 0x4443338EF595F44e0121df4C21102677B142ECF0, an address that commits to them (CREATE2). Linked as a library it would be a DELEGATECALL;
///         inlined it would put the pool over the 24,576-byte code limit. The pool's tests deploy the same bytes at the
///         same address through the same proxy and check their hash against the code read on Base and Robinhood.
///         This file stands in for poseidon-solidity/PoseidonT4.sol (foundry.toml's remapping), so the vendored
///         lean-imt/InternalLeanIMT.sol, which imports it, is unchanged.
library PoseidonT4 {
  address internal constant DEPLOYED = 0x4443338EF595F44e0121df4C21102677B142ECF0;

  /// @notice Poseidon over 3 field elements; reverts when the code is missing or the call fails
  function hash(uint256[3] memory _inputs) internal pure returns (uint256) {
    return IPoseidonT4(DEPLOYED).hash(_inputs);
  }
}

interface IPoseidonT4 {
  function hash(uint256[3] memory _inputs) external pure returns (uint256);
}
