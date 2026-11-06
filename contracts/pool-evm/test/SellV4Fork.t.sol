// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

// The sell of a real token whose only pool is a hooked Uniswap v4 pool (card evm-sell-v4), on a fork of each chain at a
// pinned block, with the chain's own Poseidon, v4 PoolManager, V4Quoter, WETH, token, pool and hook. W buys the token
// through the pool's v4 adapter, then the helper sends one type-4 transaction carrying W's EIP-7702 authorization and
// the sell through the PoolManager. The fork reads test/fork-rpc.mjs's replay of test/fixtures/fork-rpc.json, so the
// tests read no RPC. The delegate is made with deployCode and its errors named by selector, so this file builds against
// the delegate before the card too, where the sell fails (red before, green after).

import {console} from 'forge-std/console.sol';

import {PrivacyPoolSimple} from '../src/PrivacyPoolSimple.sol';
import {SellDelegate} from '../src/SellDelegate.sol';
import {UniswapV4Adapter, IPoolManager, IWETH9, PathKey} from '../src/adapters/UniswapV4Adapter.sol';
import {IV3SwapRouter} from '../src/adapters/UniswapV3Adapter.sol';
import {PoseidonT3} from '../src/poseidon/PoseidonT3.sol';
import {PoseidonT4} from '../src/poseidon/PoseidonT4.sol';
import {WithdrawalVerifier} from '../src/verifiers/WithdrawalVerifier.sol';
import {IERC20Balance} from 'interfaces/IBuyAdapter.sol';

import {IV4Quoter} from './BuyV4Fork.t.sol';
import {SellBase} from './Sell.t.sol';

interface IAllowanceFork {
  function allowance(address _owner, address _spender) external view returns (uint256);
}

abstract contract SellV4ForkBase is SellBase {
  uint256 internal constant FEE = 0.0005 ether;
  uint256 internal constant BUY = 0.05 ether;
  uint256 internal constant PRE = 0x5e114;
  bytes4 internal constant MIN_OUT_NOT_MET = bytes4(keccak256('MinOutNotMet()'));

  UniswapV4Adapter internal adapter;

  function _chain() internal pure virtual returns (string memory _rpc, uint256 _block);
  /// The chain's PoolManager with the keccak256 of its code, its V4Quoter, WETH, and v3 SwapRouter02 (or 0)
  function _v4() internal pure virtual returns (address _pm, bytes32 _pmCodehash, address _quoter, address _weth, address _v3Router);
  /// The token and its one pool: a WETH pool with a hook, as read on chain
  function _pool() internal pure virtual returns (address _token, uint24 _fee, int24 _tickSpacing, address _hooks);

  function setUp() public {
    (string memory _rpc, uint256 _block) = _chain();
    vm.createSelectFork(_rpc, _block);
    _prague();
    emit log_named_uint('coinbase balance', block.coinbase.balance);
    assertEq(PoseidonT3.DEPLOYED.codehash, PoseidonT3.CODEHASH);
    assertEq(PoseidonT4.DEPLOYED.codehash, PoseidonT4.CODEHASH);
    (address _pm, bytes32 _hash,, address _weth,) = _v4();
    assertEq(_pm.codehash, _hash, 'the v4 PoolManager read on chain');
    (address _token,,, address _hooks) = _pool();
    assertGt(_hooks.code.length, 0, 'the pool has a hook');
    pool = new PrivacyPoolSimple(address(new WithdrawalVerifier()));
    delegate = SellDelegate(payable(deployCode('SellDelegate.sol:SellDelegate', abi.encode(_weth, _pm))));
    adapter = new UniswapV4Adapter(IPoolManager(_pm), IWETH9(_weth));
    _setUpW();
    // the buy W holds: the token for BUY of ETH through the hooked pool, paid to W (as the pool's buy pays it)
    vm.deal(address(this), BUY);
    adapter.buy{value: BUY}(_token, W, 1, abi.encode(_weth, _toToken()));
    assertGt(IERC20Balance(_token).balanceOf(W), 0, 'W holds the token');
    assertEq(W.balance, 0);
  }

  function _toToken() internal pure returns (PathKey[] memory _p) {
    (address _token, uint24 _fee, int24 _ts, address _hooks) = _pool();
    _p = new PathKey[](1);
    _p[0] = PathKey(_token, _fee, _ts, _hooks, '');
  }

  function _toWeth() internal pure returns (PathKey[] memory _p) {
    (, uint24 _fee, int24 _ts, address _hooks) = _pool();
    (,,, address _weth,) = _v4();
    _p = new PathKey[](1);
    _p[0] = PathKey(_weth, _fee, _ts, _hooks, '');
  }

  function _quote(uint256 _amount) internal returns (uint256 _out) {
    (,, address _quoter,,) = _v4();
    (address _token,,,) = _pool();
    (_out,) = IV4Quoter(_quoter).quoteExactInput(IV4Quoter.QuoteExactParams(_token, _toWeth(), uint128(_amount)));
  }

  function _v4Sell(uint256 _minOut) internal view returns (SellDelegate.Sell memory) {
    (address _pm,,,,) = _v4();
    (address _token,,,) = _pool();
    return SellDelegate.Sell({
      token: _token,
      amount: IERC20Balance(_token).balanceOf(W),
      target: _pm,
      data: abi.encode(_toWeth()),
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
  function _sendDelegated(SellDelegate.Sell memory _s) internal returns (uint256 _gas) {
    bytes memory _sig = _signed(_s);
    vm.signAndAttachDelegation(address(delegate), W_KEY);
    vm.prank(SENDER);
    _gas = gasleft();
    SellDelegate(payable(W)).sell(_s, FEE, _sig);
    _gas -= gasleft();
  }

  /// The token W bought sells back through its hooked v4 pool, with no approval, and the leaf holds the V4Quoter's
  /// quote at the pinned block less the fee
  function test_aV4OnlyTokenSellsBackIntoThePool() public {
    (address _pm,,, address _weth,) = _v4();
    (address _token,,,) = _pool();
    uint256 _amount = IERC20Balance(_token).balanceOf(W);
    uint256 _quoted = _quote(_amount);
    assertGt(_quoted, FEE);
    SellDelegate.Sell memory _s = _v4Sell(_quoted * 99 / 100);
    uint256 _poolBefore = address(pool).balance;
    vm.recordLogs();
    uint256 _g = _sendDelegated(_s);
    (string memory _rpc,) = _chain();
    console.log(_rpc, 'sell, v4 hooked pool to WETH (one type-4 transaction, W authorized in it, depth 0) gas:', _g);
    (,, uint256 _value, uint256 _pre) = _deposited(vm.getRecordedLogs());
    console.log('sold', _amount, 'for wei', _quoted);
    assertEq(_value, _quoted - FEE, 'the leaf holds the quote at the pinned block less the fee');
    assertEq(_pre, PRE);
    assertEq(address(pool).balance, _poolBefore + _quoted - FEE);
    assertEq(SENDER.balance, FEE, 'the helper is paid the fee');
    assertEq(IERC20Balance(_token).balanceOf(W), 0, 'W sold every token');
    assertEq(IAllowanceFork(_token).allowance(W, _pm), 0, 'no approval was given');
    assertEq(W.balance, 0, 'W keeps no ether');
    assertEq(IERC20Balance(_weth).balanceOf(W), 0, 'nor WETH');
    assertEq(SellDelegate(payable(W)).nonce(), 1);
  }

  /// minOut one wei over the quote: refused, W keeps the token
  function test_aV4ForkShortOutputFails() public {
    (address _token,,,) = _pool();
    uint256 _amount = IERC20Balance(_token).balanceOf(W);
    SellDelegate.Sell memory _s = _v4Sell(_quote(_amount) + 1);
    vm.expectRevert(MIN_OUT_NOT_MET);
    _sendDelegated(_s);
  }

  /// The token has no v3 pool at the pinned block: the v3 router path (the only one before this card) cannot sell it
  function test_theV3RouterCannotSellIt() public {
    (,,, address _weth, address _router) = _v4();
    (address _token,,,) = _pool();
    if (_router == address(0)) return;
    uint256 _amount = IERC20Balance(_token).balanceOf(W);
    uint24[4] memory _fees = [uint24(100), 500, 3000, 10_000];
    for (uint256 _i; _i < 4; ++_i) {
      vm.prank(W);
      (bool _ok,) = _token.call(abi.encodeWithSignature('approve(address,uint256)', _router, _amount));
      assertTrue(_ok);
      vm.prank(W);
      vm.expectRevert();
      IV3SwapRouter(_router).exactInput(
        IV3SwapRouter.ExactInputParams({path: abi.encodePacked(_token, _fees[_i], _weth), recipient: W, amountIn: _amount, amountOutMinimum: 1})
      );
    }
  }
}

/// Base at 53,440,000 (the block test/SellFork.t.sol pins). PoolManager, V4Quoter and WETH as test/BuyV4Fork.t.sol
/// reads them; SwapRouter02 as test/SellFork.t.sol. The token: BTC1 0x494837c2b5d24846eeacfdec1cd8f7559d093b07, a Clanker
/// v4 coin: read on https://base-rpc.publicnode.com at block 53,440,000, its allData() names interface "clanker"; its pool
/// was initialized at block 53,439,700 (the PoolManager's Initialize log, id
/// 0xd8e86d4023074ed014f78b580dc00dc156d6b1b5336ec1a7b3358994bbd32fa2): WETH/BTC1, fee 0x800000 (dynamic), tick spacing
/// 200, hook 0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc, whose factory() is Clanker v4's
/// 0xE85A59c628F7d27878ACeB4bf3b35733630083a9. Uniswap v3's factory 0x33128a8fC17869897dcE68Ed026d694621f6FDfD
/// getPool(BTC1, WETH, 100 | 500 | 3000 | 10000) is 0 at that block: v4 is its only Uniswap pool.
contract SellV4ForkBaseTest is SellV4ForkBase {
  function _chain() internal pure override returns (string memory, uint256) {
    return ('base', 53_440_000);
  }

  function _v4() internal pure override returns (address, bytes32, address, address, address) {
    return (
      0x498581fF718922c3f8e6A244956aF099B2652b2b,
      0x83b2af6e9f3158defc2811cbcb0db71ecf8b2ba2abea39c39e370ac5c6f43eb6,
      0x0d5e0F971ED27FBfF6c2837bf31316121532048D,
      0x4200000000000000000000000000000000000006,
      0x2626664c2603336E57B271c5C0b26F421741e481
    );
  }

  function _pool() internal pure override returns (address, uint24, int24, address) {
    return (0x494837c2b5D24846EEaCfdEC1CD8F7559D093b07, 0x800000, 200, 0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC);
  }
}

/// Robinhood Chain at 105,683,000. PoolManager and V4Quoter as test/BuyV4Fork.t.sol reads them; WETH and SwapRouter02 as
/// test/SellFork.t.sol. The token: CRYBABYTRUMP 0x0dab83ad1c6d961c40daf7368e7603739c750087 (supply 1e27), read on
/// https://rpc.mainnet.chain.robinhood.com at block 105,683,000; its pool was initialized at block 105,667,701 (the
/// PoolManager's Initialize log, id 0x691bad24f8ed3d8690fcb0769e3080a466e9a265f56e10349f94c13842a440dd): WETH/CRYBABYTRUMP,
/// fee 0, tick spacing 200, hook 0x2c668601193e4a081dd82604785e436aff6a2acc. Uniswap v3's factory on Robinhood
/// 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA (QuoterV2.factory()) getPool(token, WETH, 100 | 500 | 3000 | 10000) is 0 at
/// that block: v4 is its only Uniswap pool.
contract SellV4ForkRobinhoodTest is SellV4ForkBase {
  function _chain() internal pure override returns (string memory, uint256) {
    return ('robinhood', 105_683_000);
  }

  function _v4() internal pure override returns (address, bytes32, address, address, address) {
    return (
      0x8366a39CC670B4001A1121B8F6A443A643e40951,
      0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626,
      0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94,
      0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73,
      0xCaf681a66D020601342297493863E78C959E5cb2
    );
  }

  function _pool() internal pure override returns (address, uint24, int24, address) {
    return (0x0dab83AD1C6D961c40daF7368E7603739C750087, 0, 200, 0x2c668601193e4A081DD82604785e436AFf6a2aCC);
  }
}
