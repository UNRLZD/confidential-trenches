// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/**
 * @title IBuyAdapter
 * @notice A swap the pool releases a chunk into: it swaps all the native asset it is sent for `token` and sends the
 *         tokens to `recipient`. An adapter has no owner and no storage; the pool checks the recipient's balance.
 */
interface IBuyAdapter {
  /**
   * @notice Swap msg.value of the native asset for at least `minOut` of `token`, sent to `recipient`
   * @param token The token bought
   * @param recipient W
   * @param minOut The least `recipient` must get
   * @param data The route
   */
  function buy(address token, address recipient, uint256 minOut, bytes calldata data) external payable;
}

/**
 * @title IERC20Balance
 * @notice The one ERC-20 read the pool makes
 */
interface IERC20Balance {
  function balanceOf(address account) external view returns (uint256);
}
