// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

// Hostile hooks and routes against the v4 adapter, from the Opus review of 756ee51 (card evm-adapters). Base's v4
// PoolManager runtime, read with eth_getCode on https://mainnet.base.org at block 53,438,800 (the answer recorded in
// test/fixtures/fork-rpc.json, keccak256 pinned below, the hash BuyV4Fork.t.sol pins), is etched at its own address,
// so NoDelegateCall's immutable matches; Base's WETH9 from the v3 fixture; mock tokens and planted pools; the real
// pool with the kit's 'local' proofs. No RPC: this runs on a local chain.

import {console} from 'forge-std/console.sol';

import {UniswapV4Adapter, IPoolManager, IWETH9, PoolKey, SwapParams, PathKey} from '../src/adapters/UniswapV4Adapter.sol';
import {ProofLib} from '../src/lib/ProofLib.sol';
import {IERC20Balance} from 'interfaces/IBuyAdapter.sol';
import {IPrivacyPool, IPrivacyPoolSimple} from 'interfaces/IPrivacyPool.sol';

import {BuyBase} from './Buy.t.sol';
import {ERC20Mock} from './BuyV3.t.sol';
import {LPv4, FeeHook, IPoolManagerPlant} from './BuyV4Fork.t.sol';

interface IPMx {
  function unlock(bytes calldata data) external returns (bytes memory);
  function settleFor(address recipient) external payable returns (uint256);
  function sync(address currency) external;
  function settle() external payable returns (uint256);
  function take(address currency, address to, uint256 amount) external;
}

interface IPoolDeposit {
  function deposit(uint256 _value, uint256 _precommitmentHash) external payable returns (uint256);
}

/// One hook, many hostile behaviours, picked by `mode`
contract HostileHook {
  IPMx internal immutable PM;
  uint256 public mode;
  uint256 public amt;
  address public adapter;
  address public token;
  address public pool;
  address public weth;
  uint256 public reentryOk; // how many reentry attempts succeeded

  constructor(IPMx _pm) {
    PM = _pm;
  }

  function set(uint256 _mode, uint256 _amt, address _adapter, address _token, address _pool, address _weth) external {
    (mode, amt, adapter, token, pool, weth) = (_mode, _amt, _adapter, _token, _pool, _weth);
  }

  function beforeSwap(
    address,
    PoolKey calldata _key,
    SwapParams calldata _p,
    bytes calldata
  ) external returns (bytes4, int256, uint24) {
    int128 _spec;
    // 1: take `amt` of the INPUT and return it as the specified delta (an input fee, or the unfilled remainder)
    if (mode == 1) {
      PM.take(_p.zeroForOne ? _key.currency0 : _key.currency1, address(this), amt);
      _spec = int128(int256(amt));
    }
    return (HostileHook.beforeSwap.selector, int256(_spec) << 128, 0);
  }

  function afterSwap(
    address,
    PoolKey calldata _key,
    SwapParams calldata _p,
    int256,
    bytes calldata
  ) external returns (bytes4, int128) {
    address _out = _p.zeroForOne ? _key.currency1 : _key.currency0;
    // 2: credit the adapter 1 wei of ETH from the hook's own balance
    if (mode == 2) PM.settleFor{value: 1}(adapter);
    // 3: leave `token` synced (native settle after it must fail)
    if (mode == 3) PM.sync(token);
    // 4: take `amt` of the output without owning up to it (no return delta)
    if (mode == 4) PM.take(_out, address(this), amt);
    // 5: every reentry a hook can try
    if (mode == 5) {
      try PM.unlock('') {
        ++reentryOk;
      } catch {}
      PathKey[] memory _path = new PathKey[](1);
      _path[0] = PathKey(token, _key.fee, _key.tickSpacing, address(this), '');
      try UniswapV4Adapter(adapter).unlockCallback(abi.encode(address(this), uint256(1), uint256(0), abi.encode(address(0), _path))) {
        ++reentryOk;
      } catch {}
      try UniswapV4Adapter(adapter).buy{value: 1}(token, address(this), 1, abi.encode(address(0), _path)) {
        ++reentryOk;
      } catch {}
      try IPoolDeposit(pool).deposit{value: 1}(1, 1) {
        ++reentryOk;
      } catch {}
    }
    // 6: sync WETH, send the PoolManager hook-owned WETH and leave it unsettled (stale sync before the adapter's)
    if (mode == 6) {
      PM.sync(weth);
      IWETH9(weth).deposit{value: amt}();
      IWETH9(weth).transfer(address(PM), amt);
    }
    return (HostileHook.afterSwap.selector, 0);
  }

  receive() external payable {}
}

contract HostileV4Test is BuyBase {
  uint256 internal constant NOW = 1_900_000_000;
  address internal constant PM_ADDR = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
  bytes32 internal constant PM_HASH = 0x83b2af6e9f3158defc2811cbcb0db71ecf8b2ba2abea39c39e370ac5c6f43eb6;
  address internal constant WETH = 0x4200000000000000000000000000000000000006;
  address internal constant X = 0xF111111111111111111111111111111111111111;
  address internal constant Y = 0x2222222222222222222222222222222222222222; // below X: X -> Y is one for zero
  // beforeSwap 1<<7, afterSwap 1<<6, beforeSwapReturnDelta 1<<3, afterSwapReturnDelta 1<<2
  address internal constant HH = address(uint160(0xBAD) << 144 | 0xCC);
  address internal constant FH = address(uint160(0xF00D) << 144 | 0x44); // FeeHook's flags
  uint160 internal constant PRICE_1 = uint160(1 << 96);
  uint256 internal constant FEE = 0.01 ether;
  uint256 internal constant CHUNK = 0.4 ether - FEE;

  bytes4 internal constant CURRENCY_NOT_SETTLED = 0x5212cba1;
  bytes4 internal constant NONZERO_NATIVE_VALUE = 0xb0ec849e;

  IPoolManager internal pm;
  UniswapV4Adapter internal adapter;
  LPv4 internal lp;
  HostileHook internal hh;

  function setUp() public {
    _deployPoseidon();
    vm.warp(NOW);
    _setUpPool('local');
    // the eth_getCode answer recorded for BuyV4Fork.t.sol (block 0x32f6950 = 53,438,800)
    string memory _rpc = vm.readFile('test/fixtures/fork-rpc.json');
    string memory _key = '.base[\'eth_getCode ["0x498581ff718922c3f8e6a244956af099b2652b2b","0x32f6950"]\'].result';
    vm.etch(PM_ADDR, vm.parseJsonBytes(_rpc, _key));
    assertEq(PM_ADDR.codehash, PM_HASH, 'the Base PoolManager code');
    vm.etch(WETH, vm.parseJsonBytes(vm.readFile('test/fixtures/uniswap-v3-base.json'), '.weth'));
    pm = IPoolManager(PM_ADDR);
    vm.deal(PM_ADDR, 100 ether); // other users' ETH, as the PoolManager holds on chain
    adapter = new UniswapV4Adapter(pm, IWETH9(WETH));
    deployCodeTo('BuyV3.t.sol:ERC20Mock', X);
    deployCodeTo('BuyV3.t.sol:ERC20Mock', Y);
    lp = new LPv4(pm);
    vm.deal(address(lp), 1000 ether);
    deployCodeTo('HostileV4.t.sol:HostileHook', abi.encode(PM_ADDR), HH);
    hh = HostileHook(payable(HH));
    vm.deal(HH, 10 ether);
    hh.set(0, 0, address(adapter), X, POOL, WETH);
  }

  // ----- helpers -----

  function _plant(address _c0, address _c1, address _hooks, int256 _liq, int24 _lo, int24 _hi) internal returns (PoolKey memory _key) {
    (uint24 _fee, int24 _ts) = _hooks == address(0) ? (uint24(500), int24(10)) : (uint24(3000), int24(60));
    _key = PoolKey(_c0, _c1, _fee, _ts, _hooks);
    IPoolManagerPlant(address(pm)).initialize(_key, PRICE_1);
    lp.add(_key, _lo, _hi, _liq);
  }

  function _hop(address _c, address _hooks) internal pure returns (PathKey memory) {
    (uint24 _fee, int24 _ts) = _hooks == address(0) ? (uint24(500), int24(10)) : (uint24(3000), int24(60));
    return PathKey(_c, _fee, _ts, _hooks, '');
  }

  function _one(PathKey memory _a) internal pure returns (PathKey[] memory _p) {
    _p = new PathKey[](1);
    _p[0] = _a;
  }

  function _two(PathKey memory _a, PathKey memory _b) internal pure returns (PathKey[] memory _p) {
    _p = new PathKey[](2);
    _p[0] = _a;
    _p[1] = _b;
  }

  /// What the route gives for the chunk now (the swap run and rolled back): the device's quote
  function _quote(address _in, PathKey[] memory _path) internal returns (uint256 _out) {
    address _tok = _path[_path.length - 1].intermediateCurrency;
    address _q = address(0xA11CE);
    vm.deal(_q, CHUNK);
    uint256 _snap = vm.snapshotState();
    vm.prank(_q);
    adapter.buy{value: CHUNK}(_tok, _q, 1, abi.encode(_in, _path));
    _out = IERC20Balance(_tok).balanceOf(_q);
    vm.revertToState(_snap);
  }

  function _signedBuy(address _in, PathKey[] memory _path, uint256 _minOut) internal view returns (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) {
    _b = IPrivacyPoolSimple.Buy({adapter: address(adapter), data: abi.encode(_in, _path), minOut: _minOut, token: _path[_path.length - 1].intermediateCurrency});
    _sig = _signed(_b, 'local.buy');
  }

  function _refused(IPrivacyPoolSimple.Buy memory _b, bytes memory _sig, bytes4 _err) internal {
    uint256 _poolBefore = POOL.balance;
    vm.expectRevert(_err);
    _buy('local.buy', FEE, _b, _sig);
    assertFalse(pool.nullifierHashes(_proof('local.buy').pubSignals[1]), 'the note is not spent');
    assertEq(POOL.balance, _poolBefore, 'the chunk stays in the pool');
  }

  function _lands(IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) internal returns (uint256 _got) {
    uint256 _pmEth = PM_ADDR.balance;
    _buy('local.buy', FEE, _b, _sig);
    _got = IERC20Balance(_b.token).balanceOf(W);
    assertGe(_got, _b.minOut);
    assertEq(address(adapter).balance, 0, 'adapter: no ETH');
    assertEq(IERC20Balance(WETH).balanceOf(address(adapter)), 0, 'adapter: no WETH');
    assertEq(IERC20Balance(X).balanceOf(address(adapter)), 0, 'adapter: no X');
    assertEq(IERC20Balance(Y).balanceOf(address(adapter)), 0, 'adapter: no Y');
    console.log('W got', _got, 'PM ETH delta', PM_ADDR.balance - _pmEth);
  }

  // ----- controls -----

  function test_controlPlainLands() public {
    _plant(address(0), X, address(0), 1e22, -6000, -60);
    PathKey[] memory _p = _one(_hop(X, address(0)));
    uint256 _q = _quote(address(0), _p);
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) = _signedBuy(address(0), _p, _q * 99 / 100);
    assertEq(_lands(_b, _sig), _q);
  }

  // ----- 1: a beforeSwap hook that returns a specified (input) delta -----

  /// The hook takes 10% of the INPUT before the swap (beforeSwapReturnDelta): the adapter's input check still sees
  /// exactly -msg.value, the hook holds its fee, the buy lands at the quote that included the hook
  function test_inputFeeHookLandsAtQuote() public {
    _plant(address(0), X, HH, 1e22, -6000, -60);
    hh.set(1, CHUNK / 10, address(adapter), X, POOL, WETH);
    PathKey[] memory _p = _one(_hop(X, HH));
    uint256 _q = _quote(address(0), _p);
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) = _signedBuy(address(0), _p, _q * 99 / 100);
    uint256 _hookEth = HH.balance;
    assertEq(_lands(_b, _sig), _q);
    assertEq(HH.balance - _hookEth, CHUNK / 10, 'the hook kept its input fee');
  }

  /// The same input-fee hook on a thin pool: the pool fills only part of what the hook left; PartialFill
  function test_inputFeeHookDoesNotMaskAPartialFill() public {
    _plant(address(0), X, HH, 1e9, -1020, -540);
    hh.set(1, CHUNK / 10, address(adapter), X, POOL, WETH);
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) = _signedBuy(address(0), _one(_hop(X, HH)), 1);
    _refused(_b, _sig, UniswapV4Adapter.PartialFill.selector);
  }

  /// The hook takes, as its "fee", exactly the part the thin pool cannot fill: the adapter's checks pass (it is a fee,
  /// not a partial fill) and only minOut stands between W and a near-zero buy: minOut one above what W would get,
  /// TooLittleReceived; minOut 1, it lands and the hook holds the remainder.
  function test_hookAbsorbsTheRemainderOnlyMinOutStops() public {
    _plant(address(0), X, HH, 1e9, -1020, -540);
    PathKey[] memory _p = _one(_hop(X, HH));
    // what the thin pool takes for the whole chunk, read from the partial fill's own swap: binary-search the most it fills
    uint256 _cap = _capacity(_p);
    console.log('thin pool capacity (wei)', _cap);
    hh.set(1, CHUNK - _cap, address(adapter), X, POOL, WETH);
    uint256 _q = _quote(address(0), _p);
    console.log('W would get', _q);
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) = _signedBuy(address(0), _p, _q + 1);
    _refused(_b, _sig, UniswapV4Adapter.TooLittleReceived.selector);
    (_b, _sig) = _signedBuy(address(0), _p, 1);
    uint256 _h = HH.balance;
    _lands(_b, _sig);
    assertEq(HH.balance - _h, CHUNK - _cap, 'the hook holds the unfilled remainder, as its fee');
  }

  function _capacity(PathKey[] memory _p) internal returns (uint256 _lo) {
    uint256 _hi = CHUNK;
    while (_hi - _lo > 1) {
      uint256 _mid = (_lo + _hi) / 2;
      address _q = address(0xA11CE);
      vm.deal(_q, _mid);
      uint256 _snap = vm.snapshotState();
      vm.prank(_q);
      try adapter.buy{value: _mid}(X, _q, 1, abi.encode(address(0), _p)) {
        _lo = _mid;
      } catch {
        _hi = _mid;
      }
      vm.revertToState(_snap);
    }
  }

  // ----- 2: a hook credits the adapter -----

  function test_hookCreditsTheAdapterRevertsUnlock() public {
    _plant(address(0), X, HH, 1e22, -6000, -60);
    hh.set(2, 0, address(adapter), X, POOL, WETH);
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) = _signedBuy(address(0), _one(_hop(X, HH)), 1);
    _refused(_b, _sig, CURRENCY_NOT_SETTLED);
  }

  // ----- 3: a hook leaves a currency synced -----

  /// Native route: the adapter's settle{value} meets a synced token and the PoolManager refuses; liveness only
  function test_hookLeavesSyncNativeRouteReverts() public {
    _plant(address(0), X, HH, 1e22, -6000, -60);
    hh.set(3, 0, address(adapter), X, POOL, WETH);
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) = _signedBuy(address(0), _one(_hop(X, HH)), 1);
    _refused(_b, _sig, NONZERO_NATIVE_VALUE);
  }

  /// WETH route: the adapter syncs WETH itself after every hook ran, so a stale sync (and hook WETH sent in unsettled)
  /// changes nothing: the adapter is credited exactly msg.value, the hook's WETH stays unclaimed in the PoolManager
  function test_hookStaleWethSyncWethRouteLandsExact() public {
    _plant(WETH, X, HH, 1e22, -6000, -60);
    hh.set(6, 1 ether, address(adapter), X, POOL, WETH);
    PathKey[] memory _p = _one(_hop(X, HH));
    uint256 _q = _quote(WETH, _p);
    uint256 _pmWeth = IERC20Balance(WETH).balanceOf(PM_ADDR);
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) = _signedBuy(WETH, _p, _q * 99 / 100);
    assertEq(_lands(_b, _sig), _q);
    assertEq(IERC20Balance(WETH).balanceOf(PM_ADDR) - _pmWeth, CHUNK + 1 ether, 'chunk settled, hook WETH donated');
  }

  // ----- 4: a hook takes output without a return delta -----

  function test_hookTakesWithoutDeltaRevertsUnlock() public {
    _plant(address(0), X, HH, 1e22, -6000, -60);
    hh.set(4, 1e6, address(adapter), X, POOL, WETH);
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) = _signedBuy(address(0), _one(_hop(X, HH)), 1);
    _refused(_b, _sig, CURRENCY_NOT_SETTLED);
  }

  // ----- 5: reentry from a hook -----

  /// Inside the adapter's unlock a hook tries: a nested unlock, the adapter's callback directly, the adapter's buy, the
  /// pool's deposit. None succeeds and the buy lands at the quote.
  function test_hookReentryAllFail() public {
    _plant(address(0), X, HH, 1e22, -6000, -60);
    PathKey[] memory _p = _one(_hop(X, HH));
    uint256 _q = _quote(address(0), _p);
    hh.set(5, 0, address(adapter), X, POOL, WETH);
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) = _signedBuy(address(0), _p, _q * 99 / 100);
    _lands(_b, _sig);
    assertEq(hh.reentryOk(), 0, 'no reentry succeeded');
  }

  // ----- 6: one for zero -----

  /// ETH -> X (deep), X -> Y (deep, Y below X: one for zero): lands at the quote
  function test_oneForZeroHopLands() public {
    _plant(address(0), X, address(0), 1e22, -6000, -60);
    _plant(Y, X, address(0), 1e22, 60, 6000);
    PathKey[] memory _p = _two(_hop(X, address(0)), _hop(Y, address(0)));
    uint256 _q = _quote(address(0), _p);
    assertGt(_q, 0);
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) = _signedBuy(address(0), _p, _q * 99 / 100);
    assertEq(_lands(_b, _sig), _q);
  }

  /// X -> Y one for zero on a thin pool: PartialFill on the second hop, in the other direction
  function test_oneForZeroPartialSecondHop() public {
    _plant(address(0), X, address(0), 1e22, -6000, -60);
    _plant(Y, X, address(0), 1e9, 500, 1000);
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) =
      _signedBuy(address(0), _two(_hop(X, address(0)), _hop(Y, address(0))), 1);
    _refused(_b, _sig, UniswapV4Adapter.PartialFill.selector);
  }

  // ----- 7: a fee hook on the middle hop: the PoolManager's X balance falls by the fee, nothing is owed to anyone -----

  function test_middleHopFeeHookLands() public {
    deployCodeTo('BuyV4Fork.t.sol:FeeHook', abi.encode(PM_ADDR), FH);
    FeeHook(FH).setBps(100);
    _plant(address(0), X, FH, 1e22, -6000, -60);
    _plant(Y, X, address(0), 1e22, 60, 6000);
    PathKey[] memory _p = _two(_hop(X, FH), _hop(Y, address(0)));
    uint256 _q = _quote(address(0), _p);
    uint256 _pmX = IERC20Balance(X).balanceOf(PM_ADDR);
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) = _signedBuy(address(0), _p, _q * 99 / 100);
    assertEq(_lands(_b, _sig), _q);
    uint256 _hookX = IERC20Balance(X).balanceOf(FH);
    assertGt(_hookX, 0);
    // the PoolManager's X: + what hop 2 put in, - hop 1's output; the hook's cut left with the hook
    console.log('PM X before', _pmX, 'after', IERC20Balance(X).balanceOf(PM_ADDR));
    assertEq(_pmX - IERC20Balance(X).balanceOf(PM_ADDR), _hookX, 'the PoolManager X fell by exactly the hook fee');
  }
}
