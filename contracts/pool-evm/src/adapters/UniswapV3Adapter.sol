// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IBuyAdapter} from 'interfaces/IBuyAdapter.sol';

/// @notice SwapRouter02's exact-input swap (Uniswap swap-router-contracts, IV3SwapRouter): no deadline field
interface IV3SwapRouter {
  struct ExactInputParams {
    bytes path;
    address recipient;
    uint256 amountIn;
    uint256 amountOutMinimum;
  }

  function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/**
 * @title UniswapV3Adapter
 * @notice A buy through Uniswap v3: all the native asset it is sent goes into SwapRouter02's exactInput along `data`,
 *         a v3 path that starts at the chain's WETH (the router wraps the sent value itself), and the tokens out go to
 *         the recipient. No owner, no storage, nothing kept: the router takes the whole value or the call reverts.
 */
contract UniswapV3Adapter is IBuyAdapter {
  /// @notice The chain's SwapRouter02
  IV3SwapRouter public immutable ROUTER;

  constructor(IV3SwapRouter _router) {
    ROUTER = _router;
  }

  /// @inheritdoc IBuyAdapter
  function buy(address, address recipient, uint256 minOut, bytes calldata data) external payable {
    ROUTER.exactInput{value: msg.value}(
      IV3SwapRouter.ExactInputParams({path: data, recipient: recipient, amountIn: msg.value, amountOutMinimum: minOut})
    );
  }
}
