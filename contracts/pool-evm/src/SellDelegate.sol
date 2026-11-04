// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IPoolManager, PathKey, PoolKey, SwapParams} from './adapters/UniswapV4Adapter.sol';

/// @notice The ERC-20 reads, the approve and the transfer the sell makes
interface IERC20Sell {
  function balanceOf(address _account) external view returns (uint256);
  function allowance(address _owner, address _spender) external view returns (uint256);
  function approve(address _spender, uint256 _value) external returns (bool);
  function transfer(address _to, uint256 _value) external returns (bool);
}

/// @notice The chain's WETH: its balance and unwrap
interface IWETH {
  function balanceOf(address _account) external view returns (uint256);
  function withdraw(uint256 _value) external;
}

/// @notice The pool's public deposit (src/PrivacyPool.sol)
interface IPoolDeposit {
  function deposit(uint256 _value, uint256 _precommitmentHash) external payable returns (uint256 _commitment);
}

/**
 * @title SellDelegate
 * @notice An EIP-7702 delegate for W, the fresh wallet a buy pays its tokens to (card pool-evm-sell, NOTICE change 14).
 *         W sells a token and puts the ETH back in the pool in one transaction that anyone sends (the helper, which
 *         pays the gas, since W holds no ETH). W authorizes each sell with an EIP-712 signature of Sell, under the
 *         domain {name "Blindfill", version "1", chainId, verifyingContract: W}: 65 bytes, s in the lower half. The
 *         delegate approves the router exactly the amount, calls it with W's calldata, refuses unless the router took
 *         the whole approval (the approval ends at 0), refuses unless W's balance of the token fell by exactly the
 *         amount (on v4 too, card evm-selldelegate-exact-debit), unwraps the WETH the sale paid W, refuses an ETH gain
 *         under minOut, pays the sender the fee it names (at most W's fee cap), and deposits the rest into the pool
 *         with W's precommitment. A sell whose target is the chain's v4 PoolManager (card evm-sell-v4) goes through it
 *         directly instead, as v4-periphery's V4Router does: W unlocks the PoolManager, which calls W's
 *         unlockCallback; that swaps exactly the amount along the signed route (abi.encode(PathKey[]), ending in the
 *         native asset or WETH), settles the token with a transfer from W (no approval at all) and takes the whole
 *         output to W. The callback runs only from the PoolManager, only once inside W's own sell and only with the
 *         payload that sell passed (a one-shot transient flag holding its keccak256), and the PoolManager reverts the
 *         unlock unless nothing is left owed. Then
 *         minOut, the fee and the deposit are as above. No owner, no setter, no selfdestruct, no config in storage:
 *         WETH and the PoolManager are immutables (code), and the one stored value is W's sell nonce at an ERC-7201
 *         slot of W's own account, so no other delegate's storage meets it.
 */
contract SellDelegate {
  /// @notice One sell, as W signs it
  struct Sell {
    address token;
    uint256 amount;
    address target;
    bytes data;
    uint256 minOut;
    address pool;
    uint256 precommitment;
    uint256 feeCap;
    uint256 deadline;
    uint256 nonce;
  }

  /// @custom:storage-location erc7201:blindfill.sell
  struct SellStorage {
    uint256 nonce;
  }

  /// @notice keccak256(abi.encode(uint256(keccak256('blindfill.sell')) - 1)) & ~bytes32(uint256(0xff))
  bytes32 internal constant SELL_STORAGE = 0xd19ce3d034be62269d1d8903d496806b7944251c1f2a9fe8014ceeba63edbd00;
  /// @notice The reentrancy guard's transient slot in W's account, ERC-7201 for 'blindfill.sell.guard' (as
  ///         OpenZeppelin's ReentrancyGuardTransient keeps its own), so no other code W runs meets it at slot 0
  bytes32 internal constant SELL_GUARD = 0x440bd9ccab75449a1500e3c92e1ea82c77befa0047a75538597e7e92c1806400;
  /// @notice The v4 sell's one-shot flag, the ERC-7201 transient slot for 'blindfill.sell.v4': the keccak256 of the
  ///         exact payload the sell passes to unlock, set just before it, cleared by the one callback it allows; a
  ///         callback with any other payload (a PoolManager that hands back another token, amount or route) is refused
  bytes32 internal constant SELL_V4 = 0xa182b9e3e55bed52dc0b28ee8cc4d7e4ceccf229db5eeab43bb8c656cc982500;
  /// v4-core TickMath's MIN_SQRT_PRICE + 1 and MAX_SQRT_PRICE - 1: no price limit of our own (minOut is the bound)
  uint160 internal constant MIN_PRICE_LIMIT = 4_295_128_740;
  uint160 internal constant MAX_PRICE_LIMIT = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341;

  bytes32 internal constant DOMAIN_TYPEHASH =
    keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
  bytes32 internal constant NAME_HASH = keccak256('Blindfill');
  bytes32 internal constant VERSION_HASH = keccak256('1');
  bytes32 internal constant SELL_TYPEHASH = keccak256(
    'Sell(address token,uint256 amount,address target,bytes data,uint256 minOut,address pool,uint256 precommitment,uint256 feeCap,uint256 deadline,uint256 nonce)'
  );
  /// @notice secp256k1's n / 2: a signature with a higher s is the other form of a lower one (EIP-2)
  uint256 internal constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

  /// @notice The chain's WETH, which a sale may pay W in
  IWETH public immutable WETH;
  /// @notice The chain's Uniswap v4 PoolManager, the one target the delegate sells through without an approval
  IPoolManager public immutable POOL_MANAGER;

  error InvalidSignature();
  error InvalidNonce();
  error DeadlineExpired();
  error FeeOverCap();
  error InvalidMinOut();
  error MinOutNotMet();
  error LeftoverApproval();
  error ApproveFailed();
  error FailedToSendNativeAsset();
  error Reentrancy();
  error NotPoolManager();
  error NotInSell();
  error InvalidRoute();
  error PartialFill();
  error TransferFailed();
  error DebitNotExact();

  constructor(IWETH _weth, IPoolManager _poolManager) {
    WETH = _weth;
    POOL_MANAGER = _poolManager;
  }

  /// @notice A sale may pay W in ETH, and WETH's unwrap does
  receive() external payable {}

  /**
   * @notice W's next sell nonce
   * @return The nonce the next Sell must carry
   */
  function nonce() external view returns (uint256) {
    return _store().nonce;
  }

  /**
   * @notice Runs one sell W signed and deposits its ETH, less the fee, into the pool
   * @param _sell The sell
   * @param _fee What the sender takes from the sale's ETH, at most _sell.feeCap
   * @param _signature W's EIP-712 signature of _sell, 65 bytes
   * @return _commitment The pool's new commitment
   */
  function sell(
    Sell calldata _sell,
    uint256 _fee,
    bytes calldata _signature
  ) external returns (uint256 _commitment) {
    if (_guard()) revert Reentrancy();
    _setGuard(true);

    if (block.timestamp > _sell.deadline) revert DeadlineExpired();
    if (_fee > _sell.feeCap) revert FeeOverCap();
    if (_sell.minOut == 0) revert InvalidMinOut();
    if (_signer(_sellDigest(_sell), _signature) != address(this)) revert InvalidSignature();
    SellStorage storage $ = _store();
    if (_sell.nonce != $.nonce) revert InvalidNonce();
    $.nonce = _sell.nonce + 1;

    uint256 _eth = address(this).balance;
    uint256 _weth = WETH.balanceOf(address(this));
    uint256 _held = IERC20Sell(_sell.token).balanceOf(address(this));

    if (_sell.target == address(POOL_MANAGER)) {
      // v4: no approval; the PoolManager calls unlockCallback back once, with this payload, and reverts unless
      // nothing is left owed
      bytes memory _payload = abi.encode(_sell.token, _sell.amount, _sell.data);
      _setV4(keccak256(_payload));
      POOL_MANAGER.unlock(_payload);
    } else {
      // Exactly the amount, and the router must take all of it: the approval ends at 0
      _approve(_sell.token, _sell.target, _sell.amount);
      (bool _ok, bytes memory _ret) = _sell.target.call(_sell.data);
      if (!_ok) {
        assembly ("memory-safe") {
          revert(add(_ret, 0x20), mload(_ret))
        }
      }
      if (IERC20Sell(_sell.token).allowance(address(this), _sell.target) != 0) revert LeftoverApproval();
    }
    // W's balance of the token fell by exactly the amount it signed, on v3 and v4 alike (card
    // evm-selldelegate-exact-debit): a token that takes more only on chain (only inside the unlock, only toward the
    // pool, only in transferFrom, where an eth_call probe cannot see it) reverts the whole sell, as does one that
    // takes less (a target giving tokens back); a balance that rose is an underflow revert (Panic 0x11)
    if (_held - IERC20Sell(_sell.token).balanceOf(address(this)) != _sell.amount) revert DebitNotExact();

    uint256 _wethGained = WETH.balanceOf(address(this)) - _weth;
    if (_wethGained != 0) WETH.withdraw(_wethGained);
    uint256 _gained = address(this).balance - _eth;
    if (_gained < _sell.minOut) revert MinOutNotMet();

    if (_fee != 0) {
      (bool _sent,) = msg.sender.call{value: _fee}('');
      if (!_sent) revert FailedToSendNativeAsset();
    }
    _commitment = IPoolDeposit(_sell.pool).deposit{value: _gained - _fee}(_gained - _fee, _sell.precommitment);

    _setGuard(false);
  }

  /**
   * @notice The v4 sell, inside the PoolManager's unlock: each hop swaps exactly what the hop before gave (the first,
   *         the signed amount of the signed token), and must take all of it; the token is settled by W's transfer and
   *         the route's whole output, in the native asset or WETH, is taken to W. Runs only from the PoolManager and
   *         once inside W's own sell, with the payload that sell passed to unlock.
   * @param _raw abi.encode(token, amount, data) as the sell passed it to unlock, data being abi.encode(PathKey[])
   * @return Nothing
   */
  function unlockCallback(bytes calldata _raw) external returns (bytes memory) {
    if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
    if (_v4() != keccak256(_raw)) revert NotInSell();
    _setV4(bytes32(0));
    (address _token, uint256 _amount, bytes memory _data) = abi.decode(_raw, (address, uint256, bytes));
    PathKey[] memory _path = abi.decode(_data, (PathKey[]));
    if (_path.length == 0) revert InvalidRoute();
    address _out = _path[_path.length - 1].intermediateCurrency;
    if (_out != address(0) && _out != address(WETH)) revert InvalidRoute();

    address _currency = _token;
    uint256 _got = _amount;
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
          amountSpecified: -int256(_got),
          sqrtPriceLimitX96: _zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
        }),
        _hop.hookData
      );
      (int128 _paid, int128 _gave) =
        _zeroForOne ? (int128(_delta >> 128), int128(_delta)) : (int128(_delta), int128(_delta >> 128));
      if (_paid != -int256(_got)) revert PartialFill();
      if (_gave <= 0) revert MinOutNotMet();
      _got = uint256(int256(_gave));
      _currency = _hop.intermediateCurrency;
    }

    POOL_MANAGER.sync(_token);
    _transfer(_token, address(POOL_MANAGER), _amount);
    POOL_MANAGER.settle();
    POOL_MANAGER.take(_currency, address(this), _got);
    return '';
  }

  /**
   * @notice The EIP-712 digest W signs for `_sell`, on this chain, under W's own address
   * @param _sell The sell
   * @return The digest
   */
  function _sellDigest(Sell calldata _sell) internal view returns (bytes32) {
    bytes32 _domain = keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    bytes32 _struct = keccak256(
      abi.encode(
        SELL_TYPEHASH,
        _sell.token,
        _sell.amount,
        _sell.target,
        keccak256(_sell.data),
        _sell.minOut,
        _sell.pool,
        _sell.precommitment,
        _sell.feeCap,
        _sell.deadline,
        _sell.nonce
      )
    );
    return keccak256(abi.encodePacked(hex'1901', _domain, _struct));
  }

  /**
   * @notice The signer of `_digest`: 65 bytes (r, s, v), s in the lower half; ecrecover gives 0 for a v other than
   *         27 or 28, and 0 is never W
   * @param _digest The digest
   * @param _signature The signature
   * @return The signer, or 0
   */
  function _signer(bytes32 _digest, bytes calldata _signature) internal pure returns (address) {
    if (_signature.length != 65) revert InvalidSignature();
    bytes32 _r = bytes32(_signature[0:32]);
    bytes32 _s = bytes32(_signature[32:64]);
    uint8 _v = uint8(_signature[64]);
    if (uint256(_s) > HALF_N) revert InvalidSignature();
    return ecrecover(_digest, _v, _r, _s);
  }

  /**
   * @notice approve(_spender, _value) on `_token`, for a token that returns true or nothing
   * @param _token The token
   * @param _spender The spender
   * @param _value The allowance
   */
  function _approve(address _token, address _spender, uint256 _value) internal {
    (bool _ok, bytes memory _ret) = _token.call(abi.encodeCall(IERC20Sell.approve, (_spender, _value)));
    if (!_ok || (_ret.length != 0 && !abi.decode(_ret, (bool)))) revert ApproveFailed();
  }

  /**
   * @notice transfer(_to, _value) on `_token`, for a token that returns true or nothing
   * @param _token The token
   * @param _to The recipient
   * @param _value The amount
   */
  function _transfer(address _token, address _to, uint256 _value) internal {
    (bool _ok, bytes memory _ret) = _token.call(abi.encodeCall(IERC20Sell.transfer, (_to, _value)));
    if (!_ok || (_ret.length != 0 && !abi.decode(_ret, (bool)))) revert TransferFailed();
  }

  /**
   * @notice The payload hash a v4 sell's callback must carry: W's transient storage at SELL_V4
   * @return _hash keccak256 of the payload between the sell's unlock and its one callback, else 0
   */
  function _v4() internal view returns (bytes32 _hash) {
    assembly ("memory-safe") {
      _hash := tload(SELL_V4)
    }
  }

  /**
   * @notice Sets or clears the v4 flag
   * @param _hash keccak256 of the unlock payload from the sell's unlock until its callback, then 0
   */
  function _setV4(bytes32 _hash) internal {
    assembly ("memory-safe") {
      tstore(SELL_V4, _hash)
    }
  }

  /**
   * @notice Whether a sell runs: W's transient storage at SELL_GUARD
   * @return _on True while a sell runs
   */
  function _guard() internal view returns (bool _on) {
    assembly ("memory-safe") {
      _on := tload(SELL_GUARD)
    }
  }

  /**
   * @notice Sets or clears the guard
   * @param _on True while a sell runs
   */
  function _setGuard(bool _on) internal {
    assembly ("memory-safe") {
      tstore(SELL_GUARD, _on)
    }
  }

  /**
   * @notice W's sell storage, at its ERC-7201 slot
   * @return $ The storage
   */
  function _store() internal pure returns (SellStorage storage $) {
    assembly ("memory-safe") {
      $.slot := SELL_STORAGE
    }
  }
}
