// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IBuyAdapter, IERC20Balance} from 'interfaces/IBuyAdapter.sol';

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
 *         a v3 path that starts at the chain's WETH (the router wraps what each swap takes), and the tokens out go to
 *         the recipient. A pool may fill less than the whole amount (it stops at its price limit), and the router
 *         then keeps the rest, as ETH or as a middle token of the path, where anyone can take it (refundETH,
 *         sweepToken). So the router's ETH and its balance of every middle token must be what they were before the
 *         swap, or the call reverts and the buy with it. No owner, no storage, nothing kept.
 */
contract UniswapV3Adapter is IBuyAdapter {
  /// @notice The chain's SwapRouter02
  IV3SwapRouter public immutable ROUTER;

  /// @notice Thrown when the swap left any of the value in the router
  error PartialFill();

  constructor(IV3SwapRouter _router) {
    ROUTER = _router;
  }

  /// @inheritdoc IBuyAdapter
  function buy(address, address recipient, uint256 minOut, bytes calldata data) external payable {
    uint256 _eth = address(ROUTER).balance;
    // the path is token (20 bytes) then (fee (3), token (20)) a hop: the middle tokens start at 23 * i, 0 < i < hops
    uint256 _hops = (data.length - 20) / 23;
    uint256[] memory _mid = new uint256[](_hops);
    for (uint256 _i = 1; _i < _hops; ++_i) {
      _mid[_i] = IERC20Balance(address(bytes20(data[23 * _i:23 * _i + 20]))).balanceOf(address(ROUTER));
    }
    ROUTER.exactInput{value: msg.value}(
      IV3SwapRouter.ExactInputParams({path: data, recipient: recipient, amountIn: msg.value, amountOutMinimum: minOut})
    );
    if (address(ROUTER).balance != _eth) revert PartialFill();
    for (uint256 _i = 1; _i < _hops; ++_i) {
      if (IERC20Balance(address(bytes20(data[23 * _i:23 * _i + 20]))).balanceOf(address(ROUTER)) != _mid[_i]) {
        revert PartialFill();
      }
    }
  }
}
