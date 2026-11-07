// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

// The sell of a real launchpad token through its fee-taking Uniswap v4 hook (card evm-sell-hooked-fork), on a fork of
// Base at one pinned block: a Clanker v4 coin, a Flaunch coin (paired with flETH, so the route is two v4 hops ending in
// the native asset through Flaunch's own flETH/ETH hook) and a Zora coin. W buys the token through the pool's v4
// adapter along the reverse route, then the helper sends one type-4 transaction carrying W's EIP-7702 authorization and
// the sell through the PoolManager, with minOut the V4Quoter's quote at the block. The fork reads test/fork-rpc.mjs's
// replay of test/fixtures/fork-rpc.json, so the tests read no RPC.

import {console} from 'forge-std/console.sol';

import {PrivacyPoolSimple} from '../src/PrivacyPoolSimple.sol';
import {SellDelegate, IWETH} from '../src/SellDelegate.sol';
import {UniswapV4Adapter, IPoolManager, IWETH9, PathKey} from '../src/adapters/UniswapV4Adapter.sol';
import {PoseidonT3} from '../src/poseidon/PoseidonT3.sol';
import {PoseidonT4} from '../src/poseidon/PoseidonT4.sol';
import {WithdrawalVerifier} from '../src/verifiers/WithdrawalVerifier.sol';
import {IERC20Balance} from 'interfaces/IBuyAdapter.sol';

import {IV4Quoter} from './BuyV4Fork.t.sol';
import {SellBase} from './Sell.t.sol';

interface IAllowanceHooked {
  function allowance(address _owner, address _spender) external view returns (uint256);
}

abstract contract SellHookedForkBase is SellBase {
  uint256 internal constant FEE = 0.0005 ether;
  uint256 internal constant BUY = 0.05 ether;
  uint256 internal constant PRE = 0x5e114;
  bytes4 internal constant MIN_OUT_NOT_MET = bytes4(keccak256('MinOutNotMet()'));

  /// Base at 54,124,000: every pool below was initialized before it (blocks in each contract's note)
  uint256 internal constant BLOCK = 54_124_000;
  /// Base's v4 PoolManager (with the keccak256 of its code), V4Quoter and WETH, as test/SellV4Fork.t.sol reads them
  address internal constant PM = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
  bytes32 internal constant PM_CODEHASH = 0x83b2af6e9f3158defc2811cbcb0db71ecf8b2ba2abea39c39e370ac5c6f43eb6;
  address internal constant QUOTER = 0x0d5e0F971ED27FBfF6c2837bf31316121532048D;
  address internal constant WETH = 0x4200000000000000000000000000000000000006;

  UniswapV4Adapter internal adapter;

  /// The token
  function _token() internal pure virtual returns (address);
  /// What the buy starts from (the native asset or WETH) and its route to the token
  function _buyRoute() internal pure virtual returns (address _in, PathKey[] memory _path);
  /// The sell's route from the token, ending in the native asset or WETH
  function _sellRoute() internal pure virtual returns (PathKey[] memory _path);
  /// Every hook on the sell's route
  function _hooks() internal pure virtual returns (address[] memory _h);
  /// Whether the coin's own hook (the first) takes its fee by delta: v4's address flags BEFORE_SWAP_RETURNS_DELTA (1 << 3)
  /// and AFTER_SWAP_RETURNS_DELTA (1 << 2) both set
  function _takesDelta() internal pure virtual returns (bool) {
    return true;
  }

  function setUp() public {
    vm.createSelectFork('base', BLOCK);
    _prague();
    assertEq(PoseidonT3.DEPLOYED.codehash, PoseidonT3.CODEHASH);
    assertEq(PoseidonT4.DEPLOYED.codehash, PoseidonT4.CODEHASH);
    assertEq(PM.codehash, PM_CODEHASH, 'the v4 PoolManager read on chain');
    address[] memory _h = _hooks();
    for (uint256 _i; _i < _h.length; ++_i) {
      assertGt(_h[_i].code.length, 0, 'the hook has code');
    }
    assertEq(uint160(_h[0]) & 0xC == 0xC, _takesDelta(), 'the hook returns a delta from beforeSwap and afterSwap');
    pool = new PrivacyPoolSimple(address(new WithdrawalVerifier()));
    delegate = new SellDelegate(IWETH(WETH), IPoolManager(PM));
    adapter = new UniswapV4Adapter(IPoolManager(PM), IWETH9(WETH));
    _setUpW();
    vm.deal(address(this), BUY);
    (address _in, PathKey[] memory _path) = _buyRoute();
    adapter.buy{value: BUY}(_token(), W, 1, abi.encode(_in, _path));
    assertGt(IERC20Balance(_token()).balanceOf(W), 0, 'W holds the token');
    assertEq(W.balance, 0);
  }

  function _quote(uint256 _amount) internal returns (uint256 _out) {
    (_out,) = IV4Quoter(QUOTER).quoteExactInput(IV4Quoter.QuoteExactParams(_token(), _sellRoute(), uint128(_amount)));
  }

  function _sell(uint256 _minOut) internal view returns (SellDelegate.Sell memory) {
    return SellDelegate.Sell({
      token: _token(),
      amount: IERC20Balance(_token()).balanceOf(W),
      target: PM,
      data: abi.encode(_sellRoute()),
      minOut: _minOut,
      pool: address(pool),
      precommitment: PRE,
      feeCap: FEE,
      feeRecipient: SENDER,
      deadline: block.timestamp + 60,
      nonce: 0
    });
  }

  /// One type-4 transaction from the helper: W's authorization and the sell
  function _send(SellDelegate.Sell memory _s) internal returns (uint256 _gas) {
    bytes memory _sig = _signed(_s);
    vm.signAndAttachDelegation(address(delegate), W_KEY);
    vm.prank(SENDER);
    _gas = gasleft();
    SellDelegate(payable(W)).sell(_s, FEE, _sig);
    _gas -= gasleft();
  }

  /// The token sells back through its hooked pool with no approval; the leaf holds the V4Quoter's quote less the fee
  function test_hookedTokenSellsBackIntoThePool() public {
    uint256 _amount = IERC20Balance(_token()).balanceOf(W);
    uint256 _quoted = _quote(_amount);
    assertGt(_quoted, FEE);
    SellDelegate.Sell memory _s = _sell(_quoted);
    uint256 _poolBefore = address(pool).balance;
    vm.recordLogs();
    uint256 _g = _send(_s);
    (,, uint256 _value, uint256 _pre) = _deposited(vm.getRecordedLogs());
    console.log('sold', _amount);
    console.log('for wei', _quoted);
    console.log('gas', _g);
    assertEq(_value, _quoted - FEE, 'the leaf holds the quote less the fee');
    assertEq(_pre, PRE);
    assertEq(address(pool).balance, _poolBefore + _quoted - FEE);
    assertEq(SENDER.balance, FEE, 'the helper is paid the fee');
    assertEq(IERC20Balance(_token()).balanceOf(W), 0, 'W sold every token');
    assertEq(IAllowanceHooked(_token()).allowance(W, PM), 0, 'no approval was given');
    assertEq(W.balance, 0, 'W keeps no ether');
    assertEq(IERC20Balance(WETH).balanceOf(W), 0, 'nor WETH');
    assertEq(SellDelegate(payable(W)).nonce(), 1);
  }

  /// minOut one wei over the quote: refused, W keeps the token
  function test_hookedShortOutputFails() public {
    uint256 _amount = IERC20Balance(_token()).balanceOf(W);
    SellDelegate.Sell memory _s = _sell(_quote(_amount) + 1);
    vm.expectRevert(MIN_OUT_NOT_MET);
    _send(_s);
    assertEq(IERC20Balance(_token()).balanceOf(W), _amount, 'W keeps the token');
  }
}

/// A Clanker v4 coin: 0x73fe2507f7255e60b73cc5c21e6762feea040b07, launched by Clanker v4's factory
/// 0xE85A59c628F7d27878ACeB4bf3b35733630083a9 in tx 0x5c84b7c12376eb3c47ea188ea5c7fc7f6c53235b5b16f27a8994123763506db6
/// (block 54,110,658), whose PoolManager Initialize log (id 0x0e7e48fcebb9185a1912669bf1958b563fc8121041c066673f04061b6bfc7f6a)
/// reads WETH/coin, fee 0x800000 (dynamic), tick spacing 200, hook 0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc: flags
/// 0x28cc, beforeSwap and afterSwap, both returning a delta (the hook takes its fee from the swap's amounts). Read on
/// https://base-rpc.publicnode.com.
contract SellHookedForkClankerTest is SellHookedForkBase {
  address internal constant COIN = 0x73fe2507f7255E60b73Cc5c21E6762FEEa040B07;
  address internal constant HOOK = 0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC;

  function _token() internal pure override returns (address) {
    return COIN;
  }

  function _buyRoute() internal pure override returns (address, PathKey[] memory _p) {
    _p = new PathKey[](1);
    _p[0] = PathKey(COIN, 0x800000, 200, HOOK, '');
    return (WETH, _p);
  }

  function _sellRoute() internal pure override returns (PathKey[] memory _p) {
    _p = new PathKey[](1);
    _p[0] = PathKey(WETH, 0x800000, 200, HOOK, '');
  }

  function _hooks() internal pure override returns (address[] memory _h) {
    _h = new address[](1);
    _h[0] = HOOK;
  }
}

/// A Flaunch coin: GACHA 0xc5f56808e3a1c9cb12b427bcfb72163172416ba0, whose pool Flaunch's PositionManager
/// 0x23321f11a6d44fd1ab790044fdfde5758c902fdc (flaunchContract() "Flaunch Revenue Streams") names in poolKey(GACHA):
/// flETH/GACHA, fee 0, tick spacing 60, the PositionManager itself as hook (flags 0x2fdc & 0x3fff: beforeSwap and
/// afterSwap, both returning a delta). Every Flaunch coin is paired with flETH 0x000000000d564d5be76f7f0d28fe52605afc7cf8,
/// so the route ends through Flaunch's ETH/flETH pool (fee 0, tick spacing 60, hook
/// 0x9e433f32bb5481a9ca7dff5b3af74a7ed041a888, as docs.flaunch.gg's Solidity cookbook names it and the real buy tx
/// 0xc6d9f26e8451c072eb36056e50fa10bbd4d430beee588a249da411fc609dd686 routes) in the native asset. Read on
/// https://base-rpc.publicnode.com and https://mainnet.base.org.
contract SellHookedForkFlaunchTest is SellHookedForkBase {
  address internal constant COIN = 0xC5F56808e3A1C9CB12b427BCfB72163172416ba0;
  address internal constant FLETH = 0x000000000D564D5be76f7f0d28fE52605afC7Cf8;
  address internal constant FLETH_HOOK = 0x9E433F32bb5481a9CA7DFF5b3af74A7ed041a888;
  address internal constant HOOK = 0x23321f11a6d44Fd1ab790044FdFDE5758c902FDc;

  function _token() internal pure override returns (address) {
    return COIN;
  }

  function _buyRoute() internal pure override returns (address, PathKey[] memory _p) {
    _p = new PathKey[](2);
    _p[0] = PathKey(FLETH, 0, 60, FLETH_HOOK, '');
    _p[1] = PathKey(COIN, 0, 60, HOOK, '');
    return (address(0), _p);
  }

  function _sellRoute() internal pure override returns (PathKey[] memory _p) {
    _p = new PathKey[](2);
    _p[0] = PathKey(FLETH, 0, 60, HOOK, '');
    _p[1] = PathKey(address(0), 0, 60, FLETH_HOOK, '');
  }

  function _hooks() internal pure override returns (address[] memory _h) {
    _h = new address[](2);
    _h[0] = HOOK;
    _h[1] = FLETH_HOOK;
  }
}

/// A Zora coin: NATF 0x484d87b19a55225c3b8ab47687450dfe09de2718 (contractVersion() "2.6.0", currency() WETH), created in
/// tx 0x71a94467160fb45a41c7c9a5369bc820294379fde8db2cd04da711cbce5b32e1 (block 54,120,939), where Zora's factory
/// 0x777777751622c0d3258f214F9DF38E35BF45baF3 emits CoinCreatedV4 and the PoolManager's Initialize log (id
/// 0x18e6a37d5d8ad12d0016cc1fb229053c753b9843d1fa49a9bb3c7c101ed4bf01) reads WETH/NATF, fee 0x800000 (dynamic), tick
/// spacing 200, hook 0x0469a4bd3724dc86c9542f4694c976da13c450c0 (its hooks()). Read on https://base-rpc.publicnode.com.
contract SellHookedForkZoraTest is SellHookedForkBase {
  address internal constant COIN = 0x484d87B19A55225c3b8ab47687450DFe09De2718;
  address internal constant HOOK = 0x0469a4Bd3724DC86C9542F4694c976DA13C450c0;

  /// Zora's hook (flags 0x10c0: afterInitialize, beforeSwap, afterSwap) returns no delta: its fee is the pool's own
  function _takesDelta() internal pure override returns (bool) {
    return false;
  }

  function _token() internal pure override returns (address) {
    return COIN;
  }

  function _buyRoute() internal pure override returns (address, PathKey[] memory _p) {
    _p = new PathKey[](1);
    _p[0] = PathKey(COIN, 0x800000, 200, HOOK, '');
    return (WETH, _p);
  }

  function _sellRoute() internal pure override returns (PathKey[] memory _p) {
    _p = new PathKey[](1);
    _p[0] = PathKey(WETH, 0x800000, 200, HOOK, '');
  }

  function _hooks() internal pure override returns (address[] memory _h) {
    _h = new address[](1);
    _h[0] = HOOK;
  }
}
