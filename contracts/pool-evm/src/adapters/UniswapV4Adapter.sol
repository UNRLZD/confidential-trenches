// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IBuyAdapter} from 'interfaces/IBuyAdapter.sol';

/// @notice A Uniswap v4 pool's key (v4-core PoolKey), each currency an address, address(0) the native asset
struct PoolKey {
  address currency0;
  address currency1;
  uint24 fee;
  int24 tickSpacing;
  address hooks;
}

/// @notice A swap's parameters (v4-core SwapParams): amountSpecified < 0 is an exact input
struct SwapParams {
  bool zeroForOne;
  int256 amountSpecified;
  uint160 sqrtPriceLimitX96;
}

/// @notice A hop of a route, in v4-periphery's PathKey order: the currency it ends in and the pool it goes through
struct PathKey {
  address intermediateCurrency;
  uint24 fee;
  int24 tickSpacing;
  address hooks;
  bytes hookData;
}

/// @notice The PoolManager calls this adapter uses (v4-core IPoolManager); swap returns a BalanceDelta, amount0 in the
///         upper 128 bits and amount1 in the lower, each the caller's (negative: owed to the PoolManager)
interface IPoolManager {
  function unlock(bytes calldata data) external returns (bytes memory);
  function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
  function sync(address currency) external;
  function settle() external payable returns (uint256);
  function take(address currency, address to, uint256 amount) external;
}

interface IWETH9 {
  function deposit() external payable;
  function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title UniswapV4Adapter
 * @notice A buy through Uniswap v4's PoolManager, called directly: no router between, so no router can keep any of
 *         the value. `data` is abi.encode(address currencyIn, PathKey[] path): currencyIn is the native asset
 *         (address(0)) or the chain's WETH, which the adapter wraps all it is sent into. Inside one unlock each hop
 *         swaps exactly what the hop before gave (the first, msg.value), the adapter pays in msg.value and the last
 *         hop's output goes to the recipient. A v4 pool may fill only part of an exact input (it stops at the price
 *         limit when its liquidity runs out), and a hook may change what the swap takes or gives. So every hop must
 *         take exactly its whole amount, or the call reverts with PartialFill and the buy with it: nothing of the
 *         value is left with the adapter or as a balance in the PoolManager, which in any case reverts the unlock
 *         unless every balance the adapter has there ends at zero. What the last hop gives must be at least minOut
 *         (the pool then checks the recipient's own balance). No owner, no storage, nothing kept.
 */
contract UniswapV4Adapter is IBuyAdapter {
  /// @notice The chain's v4 PoolManager
  IPoolManager public immutable POOL_MANAGER;
  /// @notice The chain's WETH, the one currency other than the native asset a route may start from
  IWETH9 public immutable WETH;

  /// v4-core TickMath's MIN_SQRT_PRICE + 1 and MAX_SQRT_PRICE - 1: no price limit of our own
  uint160 internal constant MIN_PRICE_LIMIT = 4_295_128_740;
  uint160 internal constant MAX_PRICE_LIMIT = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341;

  /// @notice Thrown when a hop took less than its whole amount
  error PartialFill();
  /// @notice Thrown when the route gives less than minOut, or a hop gives nothing
  error TooLittleReceived();
  /// @notice Thrown when the route is empty or starts from a currency other than the native asset or WETH
  error InvalidRoute();
  /// @notice Thrown when anyone but the PoolManager calls unlockCallback
  error NotPoolManager();

  constructor(IPoolManager _poolManager, IWETH9 _weth) {
    POOL_MANAGER = _poolManager;
    WETH = _weth;
  }

  /// @inheritdoc IBuyAdapter
  function buy(address, address recipient, uint256 minOut, bytes calldata data) external payable {
    POOL_MANAGER.unlock(abi.encode(recipient, msg.value, minOut, data));
  }

  /// @notice The swap, inside the PoolManager's unlock; the PoolManager calls back only whoever called unlock
  function unlockCallback(bytes calldata _raw) external returns (bytes memory) {
    if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
    (address _recipient, uint256 _in, uint256 _minOut, bytes memory _data) =
      abi.decode(_raw, (address, uint256, uint256, bytes));
    (address _currencyIn, PathKey[] memory _path) = abi.decode(_data, (address, PathKey[]));
    if (_path.length == 0) revert InvalidRoute();
    if (_currencyIn != address(0) && _currencyIn != address(WETH)) revert InvalidRoute();

    address _currency = _currencyIn;
    uint256 _amount = _in;
    for (uint256 _i; _i < _path.length; ++_i) {
      PathKey memory _hop = _path[_i];
      bool _zeroForOne = _currency < _hop.intermediateCurrency;
      int256 _delta = POOL_MANAGER.swap(
        PoolKey({
          currency0: _zeroForOne ? _currency : _hop.intermediateCurrency,
          currency1: _zeroForOne ? _hop.intermediateCurrency : _currency,
          fee: _hop.fee,
          tickSpacing: _hop.tickSpacing,
          hooks: _hop.hooks
        }),
        SwapParams({
          zeroForOne: _zeroForOne,
          amountSpecified: -int256(_amount),
          sqrtPriceLimitX96: _zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
        }),
        _hop.hookData
      );
      (int128 _paid, int128 _got) =
        _zeroForOne ? (int128(_delta >> 128), int128(_delta)) : (int128(_delta), int128(_delta >> 128));
      if (_paid != -int256(_amount)) revert PartialFill();
      if (_got <= 0) revert TooLittleReceived();
      _amount = uint256(int256(_got));
      _currency = _hop.intermediateCurrency;
    }
    if (_amount < _minOut) revert TooLittleReceived();

    if (_currencyIn == address(0)) {
      POOL_MANAGER.settle{value: _in}();
    } else {
      WETH.deposit{value: _in}();
      POOL_MANAGER.sync(_currencyIn);
      WETH.transfer(address(POOL_MANAGER), _in);
      POOL_MANAGER.settle();
    }
    POOL_MANAGER.take(_currency, _recipient, _amount);
    return '';
  }
}
