// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

// The sell through Uniswap v4's PoolManager (card evm-sell-v4): W sells a token whose pool is v4 only, with no approval,
// and the ETH goes back into the pool in the same transaction. Base's v4 PoolManager runtime, read with eth_getCode on
// https://mainnet.base.org at block 53,438,800 (the answer recorded in test/fixtures/fork-rpc.json, keccak256 pinned
// below, the hash test/BuyV4Fork.t.sol pins), is etched at its own address, so NoDelegateCall's immutable matches;
// Base's WETH9 from the v3 fixture; mock tokens, planted pools and planted hooks. No RPC: this runs on a local chain.
// The delegate is made with deployCode and its errors named by their selectors, so this file builds against the
// delegate before the card too, where every sell here fails (red before, green after).

import {Vm} from 'forge-std/Vm.sol';
import {console} from 'forge-std/console.sol';

import {PrivacyPoolSimple} from '../src/PrivacyPoolSimple.sol';
import {SellDelegate} from '../src/SellDelegate.sol';
import {IPoolManager, PoolKey, SwapParams, PathKey} from '../src/adapters/UniswapV4Adapter.sol';
import {WithdrawalVerifier} from '../src/verifiers/WithdrawalVerifier.sol';
import {IERC20Balance} from 'interfaces/IBuyAdapter.sol';

import {ERC20Mock} from './BuyV3.t.sol';
import {FeeHook, IPoolManagerPlant} from './BuyV4Fork.t.sol';
import {SellBase} from './Sell.t.sol';

interface IWETH9Sell {
  function deposit() external payable;
  function transfer(address _to, uint256 _v) external returns (bool);
  function balanceOf(address _a) external view returns (uint256);
}

/// v4-periphery's IUnlockCallback, the one the delegate now answers
interface IUnlockCallback {
  function unlockCallback(bytes calldata _data) external returns (bytes memory);
}

interface IAllowance {
  function allowance(address _owner, address _spender) external view returns (uint256);
}

/// A token whose transfer delivers 1% less than it moves (a fee-on-transfer token): settling it leaves an amount owed
contract FeeOnTransferToken {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  function mint(address _to, uint256 _a) external {
    balanceOf[_to] += _a;
  }

  function transfer(address _to, uint256 _a) external returns (bool) {
    balanceOf[msg.sender] -= _a;
    balanceOf[_to] += _a - _a / 100;
    return true;
  }
}

/// A token whose transfer returns false and moves nothing
contract FalseTransferToken {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  function mint(address _to, uint256 _a) external {
    balanceOf[_to] += _a;
  }

  function transfer(address, uint256) external pure returns (bool) {
    return false;
  }
}

/// A liquidity provider for a planted pool: a mock token is minted to the PoolManager, WETH wrapped from its own ETH,
/// the native asset paid from its balance
contract LPSell {
  IPoolManager internal immutable PM;
  address internal immutable WETH;

  constructor(IPoolManager _pm, address _weth) {
    PM = _pm;
    WETH = _weth;
  }

  function add(PoolKey memory _key, int24 _lo, int24 _hi, int256 _liq) external {
    PM.unlock(abi.encode(_key, _lo, _hi, _liq));
  }

  function unlockCallback(bytes calldata _raw) external returns (bytes memory) {
    (PoolKey memory _key, int24 _lo, int24 _hi, int256 _liq) = abi.decode(_raw, (PoolKey, int24, int24, int256));
    (int256 _d,) = IPoolManagerPlant(address(PM)).modifyLiquidity(
      _key, IPoolManagerPlant.ModifyLiquidityParams(_lo, _hi, _liq, bytes32(0)), ''
    );
    _pay(_key.currency0, int128(_d >> 128));
    _pay(_key.currency1, int128(_d));
    return '';
  }

  function _pay(address _c, int128 _owed) internal {
    if (_owed >= 0) return;
    uint256 _a = uint256(int256(-_owed));
    if (_c == address(0)) {
      PM.settle{value: _a}();
      return;
    }
    PM.sync(_c);
    if (_c == WETH) {
      IWETH9Sell(WETH).deposit{value: _a}();
      IWETH9Sell(WETH).transfer(address(PM), _a);
    } else {
      ERC20Mock(_c).mint(address(PM), _a);
    }
    PM.settle();
  }

  receive() external payable {}
}

/// A hook that, after each swap of a sell, tries every way back into W (afterSwap only, no return delta)
contract ReenterHook {
  address public w;
  bytes public sellCall;
  uint256 public reentryOk;
  uint256 public tries;

  function set(address _w, bytes calldata _sellCall) external {
    (w, sellCall) = (_w, _sellCall);
  }

  function afterSwap(address, PoolKey calldata, SwapParams calldata, int256, bytes calldata) external returns (bytes4, int128) {
    ++tries;
    PathKey[] memory _path = new PathKey[](1);
    _path[0] = PathKey(address(0), 0, 1, address(0), '');
    // the callback, called by the hook itself
    try IUnlockCallback(w).unlockCallback(abi.encode(address(this), uint256(1), abi.encode(_path))) {
      ++reentryOk;
    } catch {}
    // the PoolManager again (it is unlocked: it refuses)
    try IPoolManager(msg.sender).unlock('') {
      ++reentryOk;
    } catch {}
    // the sell again
    (bool _ok,) = w.call(sellCall);
    if (_ok) ++reentryOk;
    return (ReenterHook.afterSwap.selector, 0);
  }
}

/// What the v4 sell tests share: the etched PoolManager, WETH, the pool, W delegated, planted pools and the helpers
abstract contract SellV4Base is SellBase {
  address internal constant PM_ADDR = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
  bytes32 internal constant PM_HASH = 0x83b2af6e9f3158defc2811cbcb0db71ecf8b2ba2abea39c39e370ac5c6f43eb6;
  address internal constant WETH = 0x4200000000000000000000000000000000000006;
  address internal constant T = 0xF111111111111111111111111111111111111111; // the token W sells
  address internal constant Y = 0x2222222222222222222222222222222222222222; // a middle hop's token, below T
  address internal constant FT = 0xF333333333333333333333333333333333333333; // fee on transfer
  address internal constant BT = 0xF444444444444444444444444444444444444444; // transfer returns false
  address internal constant FH = address(uint160(0xF00D) << 144 | 0x44); // FeeHook: afterSwap, afterSwapReturnDelta
  address internal constant RH = address(uint160(0xBEE) << 144 | 0x40); // ReenterHook: afterSwap
  uint160 internal constant PRICE_1 = uint160(1 << 96); // tick 0
  uint256 internal constant AMOUNT = 0.4 ether; // of T
  uint256 internal constant FEE = 0.002 ether;
  uint256 internal constant PRE = 0x7e4;

  // v4-core's errors, and the delegate's, by selector (so this file builds against the delegate before the card)
  bytes4 internal constant CURRENCY_NOT_SETTLED = 0x5212cba1;
  bytes4 internal constant NOT_POOL_MANAGER = bytes4(keccak256('NotPoolManager()'));
  bytes4 internal constant NOT_IN_SELL = bytes4(keccak256('NotInSell()'));
  bytes4 internal constant INVALID_ROUTE = bytes4(keccak256('InvalidRoute()'));
  bytes4 internal constant PARTIAL_FILL = bytes4(keccak256('PartialFill()'));
  bytes4 internal constant TRANSFER_FAILED = bytes4(keccak256('TransferFailed()'));
  bytes4 internal constant MIN_OUT_NOT_MET = bytes4(keccak256('MinOutNotMet()'));

  IPoolManager internal pm;
  LPSell internal lp;

  function setUp() public {
    _prague();
    _deployPoseidon();
    vm.warp(1_900_000_000);
    string memory _rpc = vm.readFile('test/fixtures/fork-rpc.json');
    string memory _key = '.base[\'eth_getCode ["0x498581ff718922c3f8e6a244956af099b2652b2b","0x32f6950"]\'].result';
    vm.etch(PM_ADDR, vm.parseJsonBytes(_rpc, _key));
    assertEq(PM_ADDR.codehash, PM_HASH, 'the Base PoolManager code');
    vm.etch(WETH, vm.parseJsonBytes(vm.readFile('test/fixtures/uniswap-v3-base.json'), '.weth'));
    pm = IPoolManager(PM_ADDR);
    vm.deal(PM_ADDR, 100 ether); // other users' ETH, as the PoolManager holds on chain
    pool = new PrivacyPoolSimple(address(new WithdrawalVerifier()));
    delegate = SellDelegate(payable(deployCode('SellDelegate.sol:SellDelegate', abi.encode(WETH, PM_ADDR))));
    lp = new LPSell(pm, WETH);
    vm.deal(address(lp), 100_000 ether);
    deployCodeTo('BuyV3.t.sol:ERC20Mock', T);
    deployCodeTo('BuyV3.t.sol:ERC20Mock', Y);
    _setUpW();
    vm.signAndAttachDelegation(address(delegate), W_KEY);
    ERC20Mock(T).mint(W, AMOUNT * 10);
  }

  // ----- helpers -----

  /// A planted pool of (`_a`, `_b`) at tick 0, with `_liq` of the lower currency alone in [`_lo`, `_hi`], above the price
  function _plant(address _a, address _b, address _hooks, int256 _liq, int24 _lo, int24 _hi) internal returns (PathKey memory) {
    (address _c0, address _c1) = _a < _b ? (_a, _b) : (_b, _a);
    (uint24 _fee, int24 _ts) = _hooks == address(0) ? (uint24(500), int24(10)) : (uint24(3000), int24(60));
    PoolKey memory _key = PoolKey(_c0, _c1, _fee, _ts, _hooks);
    IPoolManagerPlant(address(pm)).initialize(_key, PRICE_1);
    lp.add(_key, _lo, _hi, _liq);
    return PathKey(_c0, _fee, _ts, _hooks, '');
  }

  /// A deep pool selling `_token` into `_out` (the native asset or WETH), the token above `_out`
  function _deep(address _token, address _out, address _hooks) internal returns (PathKey[] memory _p) {
    _p = new PathKey[](1);
    _p[0] = _plant(_out, _token, _hooks, 1e22, 60, 6000);
  }

  function _v4Sell(address _token, PathKey[] memory _path, uint256 _minOut, uint256 _nonce) internal view returns (SellDelegate.Sell memory) {
    return SellDelegate.Sell({
      token: _token,
      amount: AMOUNT,
      target: PM_ADDR,
      data: abi.encode(_path),
      minOut: _minOut,
      pool: address(pool),
      precommitment: PRE,
      feeCap: FEE,
      feeRecipient: SENDER,
      deadline: block.timestamp + 60,
      nonce: _nonce
    });
  }

  function _send(SellDelegate.Sell memory _s) internal returns (uint256 _gas) {
    bytes memory _sig = _signed(_s);
    vm.prank(SENDER);
    _gas = gasleft();
    SellDelegate(payable(W)).sell(_s, FEE, _sig);
    _gas -= gasleft();
  }

  /// What the sell gives now (run with minOut 1 and rolled back): the device's quote
  function _quote(address _token, PathKey[] memory _path) internal returns (uint256 _out) {
    uint256 _snap = vm.snapshotState();
    uint256 _before = address(pool).balance;
    _send(_v4Sell(_token, _path, 1, SellDelegate(payable(W)).nonce()));
    _out = address(pool).balance - _before + FEE;
    vm.revertToState(_snap);
  }

  /// The sell lands: the leaf holds the proceeds less the fee, W keeps nothing, no approval was ever given
  function _lands(address _token, PathKey[] memory _path, string memory _what) internal {
    uint256 _quoted = _quote(_token, _path);
    assertGt(_quoted, FEE, 'the route gives something');
    SellDelegate.Sell memory _s = _v4Sell(_token, _path, _quoted * 99 / 100, 0);
    uint256 _poolBefore = address(pool).balance;
    uint256 _pmEth = PM_ADDR.balance;
    uint256 _wTokens = IERC20Balance(_token).balanceOf(W);
    vm.recordLogs();
    uint256 _g = _send(_s);
    console.log(_what, 'gas:', _g);
    (uint256 _c, uint256 _label, uint256 _value, uint256 _pre) = _deposited(vm.getRecordedLogs());
    _c;
    _label;
    assertEq(_value, _quoted - FEE, 'the leaf holds the proceeds less the fee');
    assertEq(_pre, PRE);
    assertEq(address(pool).balance, _poolBefore + _quoted - FEE);
    assertEq(SENDER.balance, FEE, 'the sender is paid the fee');
    assertEq(IERC20Balance(_token).balanceOf(W), _wTokens - AMOUNT, 'W sold exactly the amount');
    assertEq(IAllowance(_token).allowance(W, PM_ADDR), 0, 'no approval was given');
    assertEq(W.balance, 0, 'W keeps no ether');
    assertEq(IWETH9Sell(WETH).balanceOf(W), 0, 'nor WETH');
    // (a hook on the last hop may take its own cut of the output from the PoolManager too)
    if (_path[_path.length - 1].intermediateCurrency == address(0) && _path[_path.length - 1].hooks == address(0)) {
      assertEq(PM_ADDR.balance, _pmEth - _quoted, 'the PoolManager paid out exactly the proceeds');
    }
    assertEq(SellDelegate(payable(W)).nonce(), 1);
  }

  function _refused(SellDelegate.Sell memory _s, bytes4 _err) internal {
    bytes memory _sig = _signed(_s);
    uint256 _poolBefore = address(pool).balance;
    uint256 _wTokens = IERC20Balance(_s.token).balanceOf(W);
    vm.expectRevert(_err);
    vm.prank(SENDER);
    SellDelegate(payable(W)).sell(_s, FEE, _sig);
    assertEq(address(pool).balance, _poolBefore, 'nothing deposited');
    assertEq(IERC20Balance(_s.token).balanceOf(W), _wTokens, 'W keeps its tokens');
    assertEq(SellDelegate(payable(W)).nonce(), 0, 'the nonce is not used');
  }

}

contract SellV4Test is SellV4Base {
  // ----- the sells -----

  function test_v4SellToTheNativeAssetLands() public {
    _lands(T, _deep(T, address(0), address(0)), 'sell, v4 one hop to ETH, depth 0');
  }

  function test_v4SellToWethLands() public {
    _lands(T, _deep(T, WETH, address(0)), 'sell, v4 one hop to WETH, depth 0');
  }

  /// A v4 route to the native asset trusts no WETH contract (review 2, R-3): Robinhood Chain's WETH is an
  /// upgradeable proxy, and a WETH that reverts on every call still leaves such a sell landing
  function test_v4SellToTheNativeAssetTrustsNoWeth() public {
    PathKey[] memory _p = _deep(T, address(0), address(0));
    uint256 _quoted = _quote(T, _p);
    vm.etch(WETH, hex'60006000fd'); // PUSH1 0, PUSH1 0, REVERT
    uint256 _poolBefore = address(pool).balance;
    _send(_v4Sell(T, _p, _quoted * 99 / 100, 0));
    assertEq(address(pool).balance, _poolBefore + _quoted - FEE, 'the leaf holds the proceeds less the fee');
    assertEq(SellDelegate(payable(W)).nonce(), 1);
  }

  /// T to Y, then Y to the native asset: the middle token nets to zero in the PoolManager
  function test_v4TwoHopSellLands() public {
    PathKey[] memory _p = new PathKey[](2);
    _p[0] = _plant(Y, T, address(0), 1e22, 60, 6000);
    _p[0].intermediateCurrency = Y;
    _p[1] = _plant(address(0), Y, address(0), 1e22, 60, 6000);
    _lands(T, _p, 'sell, v4 two hops to ETH, depth 0');
    assertEq(IERC20Balance(Y).balanceOf(W), 0, 'W holds none of the middle token');
  }

  /// A hooked pool whose hook keeps 1% of the output: the sell lands what the hook leaves (the pool pays WETH: the
  /// planted FeeHook takes its cut in the output currency and has no receive for the native asset)
  function test_v4HookedSellLands() public {
    deployCodeTo('BuyV4Fork.t.sol:FeeHook', abi.encode(PM_ADDR), FH);
    FeeHook(FH).setBps(100);
    _lands(T, _deep(T, WETH, FH), 'sell, v4 one hop to WETH through a hook, depth 0');
  }

  /// The hook that takes more at the sell than at the quote: minOut refuses it
  function test_v4AHookTakingMoreThanTheQuoteIsRefused() public {
    deployCodeTo('BuyV4Fork.t.sol:FeeHook', abi.encode(PM_ADDR), FH);
    PathKey[] memory _p = _deep(T, WETH, FH);
    uint256 _quoted = _quote(T, _p);
    FeeHook(FH).setBps(500);
    _refused(_v4Sell(T, _p, _quoted * 99 / 100, 0), MIN_OUT_NOT_MET);
  }

  /// The hook taking all the output and more: refused before W takes anything
  function test_v4AHookTakingTheWholeOutputIsRefused() public {
    deployCodeTo('BuyV4Fork.t.sol:FeeHook', abi.encode(PM_ADDR), FH);
    PathKey[] memory _p = _deep(T, WETH, FH);
    FeeHook(FH).setBps(10_001);
    _refused(_v4Sell(T, _p, 1, 0), MIN_OUT_NOT_MET);
  }

  // ----- the planted failures the card names -----

  /// A callback not from the PoolManager: anyone calling W's unlockCallback is refused
  function test_v4ACallbackNotFromThePoolManagerIsRefused() public {
    PathKey[] memory _p = _deep(T, address(0), address(0));
    vm.expectRevert(NOT_POOL_MANAGER);
    vm.prank(address(0xBAD));
    IUnlockCallback(W).unlockCallback(abi.encode(T, AMOUNT, abi.encode(_p)));
  }

  /// A callback outside a sell: W's own account unlocking the PoolManager (as any transaction W signs could) gets its
  /// callback refused, so no swap of W's tokens runs but through a signed sell
  function test_v4ACallbackOutsideASellIsRefused() public {
    PathKey[] memory _p = _deep(T, address(0), address(0));
    vm.expectRevert(NOT_IN_SELL);
    vm.prank(W);
    pm.unlock(abi.encode(T, AMOUNT, abi.encode(_p)));
    assertEq(IERC20Balance(T).balanceOf(W), AMOUNT * 10);
  }

  /// After a sell lands, W's account unlocking the PoolManager in a later transaction gets its callback refused: the
  /// sell's flag does not stay set
  function test_v4AnUnlockByWAfterASellIsRefused() public {
    PathKey[] memory _p = _deep(T, address(0), address(0));
    _send(_v4Sell(T, _p, 1, 0));
    vm.expectRevert(NOT_IN_SELL);
    vm.prank(W);
    pm.unlock(abi.encode(T, AMOUNT, abi.encode(_p)));
  }

  /// Proceeds under minOut
  function test_v4ProceedsUnderMinOutAreRefused() public {
    PathKey[] memory _p = _deep(T, address(0), address(0));
    uint256 _quoted = _quote(T, _p);
    _refused(_v4Sell(T, _p, _quoted + 1, 0), MIN_OUT_NOT_MET);
  }

  /// Any amount left owed: a token that delivers less than it moves leaves W owing the PoolManager, which reverts
  function test_v4AnAmountLeftOwedIsRefused() public {
    deployCodeTo('SellV4.t.sol:FeeOnTransferToken', FT);
    ERC20Mock(FT).mint(W, AMOUNT);
    PathKey[] memory _p = _deep(FT, address(0), address(0));
    _refused(_v4Sell(FT, _p, 1, 0), CURRENCY_NOT_SETTLED);
  }

  /// A token whose transfer returns false: refused (and the PoolManager would refuse it too)
  function test_v4ATokenThatRefusesTheTransferIsRefused() public {
    deployCodeTo('SellV4.t.sol:FalseTransferToken', BT);
    ERC20Mock(BT).mint(W, AMOUNT);
    PathKey[] memory _p = _deep(BT, address(0), address(0));
    _refused(_v4Sell(BT, _p, 1, 0), TRANSFER_FAILED);
  }

  /// A pool that fills only part of the amount: refused, W keeps every token
  function test_v4APartialFillIsRefused() public {
    PathKey[] memory _p = new PathKey[](1);
    _p[0] = _plant(address(0), T, address(0), 1e9, 60, 600);
    _refused(_v4Sell(T, _p, 1, 0), PARTIAL_FILL);
  }

  /// A route that ends in another token (not the native asset or WETH), and an empty route: refused
  function test_v4ARouteEndingInATokenIsRefused() public {
    PathKey[] memory _p = new PathKey[](1);
    _p[0] = _plant(Y, T, address(0), 1e22, 60, 6000);
    _p[0].intermediateCurrency = Y;
    _refused(_v4Sell(T, _p, 1, 0), INVALID_ROUTE);
  }

  function test_v4AnEmptySellRouteIsRefused() public {
    _refused(_v4Sell(T, new PathKey[](0), 1, 0), INVALID_ROUTE);
  }

  /// A hook that tries the callback, the PoolManager and the sell again from inside the swap: none gets in, the sell
  /// lands
  function test_v4AHookCannotReenterW() public {
    deployCodeTo('SellV4.t.sol:ReenterHook', RH);
    PathKey[] memory _p = _deep(T, address(0), RH);
    SellDelegate.Sell memory _again = _v4Sell(T, _p, 1, 1);
    ReenterHook(RH).set(W, abi.encodeCall(SellDelegate.sell, (_again, 0, _signed(_again))));
    _lands(T, _p, 'sell, v4 through a hook that tries to reenter, depth 0');
    assertGt(ReenterHook(RH).tries(), 0, 'the hook ran');
    assertEq(ReenterHook(RH).reentryOk(), 0, 'no reentry got in');
  }

  /// The pool's tree at depth 32: the deposit's inserts as the pool grows
  function test_gasSellV4Depth32() public {
    PathKey[] memory _p = _deep(T, address(0), address(0));
    // both trees of depth 32 with 2^32 - 1 leaves (test/Sell.t.sol _deepTrees, test/layout.test.mjs)
    for (uint256 _t; _t < 2; ++_t) {
      uint256 _base = _t == 0 ? 3 : 7;
      vm.store(address(pool), bytes32(_base), bytes32(uint256(type(uint32).max)));
      vm.store(address(pool), bytes32(_base + 1), bytes32(uint256(32)));
      for (uint256 _i; _i < 32; ++_i) vm.store(address(pool), keccak256(abi.encode(_i, _base + 2)), bytes32(_i + 1));
    }
    uint256 _g = _send(_v4Sell(T, _p, 1, 0));
    console.log('sell, v4 one hop to ETH, depth 32 gas:', _g);
    assertEq(pool.currentTreeDepth(), 32);
  }
}
