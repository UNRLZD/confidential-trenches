// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {console} from 'forge-std/console.sol';

import {PrivacyPoolSimple} from '../src/PrivacyPoolSimple.sol';
import {UniswapV3Adapter, IV3SwapRouter} from '../src/adapters/UniswapV3Adapter.sol';
import {ProofLib} from '../src/lib/ProofLib.sol';
import {PoseidonT3} from '../src/poseidon/PoseidonT3.sol';
import {PoseidonT4} from '../src/poseidon/PoseidonT4.sol';
import {IERC20Balance} from 'interfaces/IBuyAdapter.sol';
import {IPrivacyPool, IPrivacyPoolSimple} from 'interfaces/IPrivacyPool.sol';

import {BuyBase} from './Buy.t.sol';

interface IQuoterV2 {
  function quoteExactInput(
    bytes memory path,
    uint256 amountIn
  ) external returns (uint256 amountOut, uint160[] memory, uint32[] memory, uint256 gasEstimate);
}

/// The buy through Uniswap v3 on a fork of a chain at a pinned block, with the chain's own Poseidon, SwapRouter02,
/// WETH and pool. The fork reads test/fork-rpc.mjs's replay of test/fixtures/fork-rpc.json, the chains' recorded
/// answers to these tests' reads, so the tests read no RPC (contracts/pool-evm/NOTICE).
abstract contract BuyForkBase is BuyBase {
  UniswapV3Adapter internal adapter;

  function _chain() internal pure virtual returns (string memory _rpc, string memory _set, uint256 _block);
  function _route() internal pure virtual returns (address _router, address _quoter, address _weth, address _out, uint24 _fee);

  function setUp() public {
    (string memory _rpc, string memory _set, uint256 _block) = _chain();
    vm.createSelectFork(_rpc, _block);
    // Foundry 1.8 loads the block's coinbase account (warm since Shanghai) and 1.7 does not: read it here, so the
    // recording holds it for either
    emit log_named_uint('coinbase balance', block.coinbase.balance);
    // the chain's own Poseidon, at the address and with the code the pool requires
    assertEq(PoseidonT3.DEPLOYED.codehash, PoseidonT3.CODEHASH);
    assertEq(PoseidonT4.DEPLOYED.codehash, PoseidonT4.CODEHASH);
    vm.warp(1_900_000_000);
    _setUpPool(_set);
    (address _router,,,,) = _route();
    adapter = new UniswapV3Adapter(IV3SwapRouter(_router));
  }

  function _path() internal pure returns (bytes memory) {
    (,, address _weth, address _out, uint24 _fee) = _route();
    return abi.encodePacked(_weth, _fee, _out);
  }

  function _quote(uint256 _in) internal returns (uint256 _out) {
    (, address _quoter,,,) = _route();
    (_out,,,) = IQuoterV2(_quoter).quoteExactInput(_path(), _in);
  }

  function _forkBuy(uint256 _minOut) internal view returns (IPrivacyPoolSimple.Buy memory _b) {
    (,,, address _out,) = _route();
    _b = IPrivacyPoolSimple.Buy({adapter: address(adapter), data: _path(), minOut: _minOut, token: _out});
  }

  function _setName() internal pure returns (string memory) {
    (, string memory _set,) = _chain();
    return string.concat(_set, '.buy');
  }

  function test_aBuyLandsAndWHoldsAtLeastMinOut() public {
    uint256 _fee = 0.01 ether;
    uint256 _quoted = _quote(0.4 ether - _fee);
    IPrivacyPoolSimple.Buy memory _b = _forkBuy(_quoted * 99 / 100);
    bytes memory _sig = _signed(_b, _setName());
    IPrivacyPool.Withdrawal memory _w = _withdrawal(_setName());
    ProofLib.WithdrawProof memory _p = _proof(_setName());
    uint256 _poolBefore = POOL.balance;
    vm.prank(address(0xBEEF));
    uint256 _g = gasleft();
    pool.buy(_w, _p, _fee, _b, _sig);
    console.log('buy (depth 2, Uniswap v3 one hop) gas:', _g - gasleft());
    uint256 _got = IERC20Balance(_b.token).balanceOf(W);
    console.log('W got', _got, 'quoted', _quoted);
    assertEq(_got, _quoted, 'W got the quote at the pinned block');
    assertGe(_got, _b.minOut);
    assertEq(RELAYER.balance, _fee);
    assertEq(POOL.balance, _poolBefore - 0.4 ether);
    assertEq(address(adapter).balance, 0, 'the adapter keeps no ether');
    assertEq(IERC20Balance(_b.token).balanceOf(address(adapter)), 0, 'nor any token');
    assertEq(IERC20Balance(_b.token).balanceOf(POOL), 0, 'and the pool got none');
    assertEq(W.balance, 0);
  }

  /// A minOut above what the swap gives: the router refuses it (the adapter passes minOut on), so the buy reverts
  /// and the note stays unspent.
  function test_aMinOutOverTheQuoteFails() public {
    uint256 _quoted = _quote(0.4 ether);
    IPrivacyPoolSimple.Buy memory _b = _forkBuy(_quoted + 1);
    bytes memory _sig = _signed(_b, _setName());
    vm.expectRevert(bytes('Too little received'));
    _buy(_setName(), 0, _b, _sig);
    assertFalse(pool.nullifierHashes(_proof(_setName()).pubSignals[1]));
  }

  /// A route that buys another token than the one W signed for: W's balance of it does not rise.
  function test_aRouteToAnotherTokenFails() public {
    IPrivacyPoolSimple.Buy memory _b = _forkBuy(1);
    (,, address _weth,,) = _route();
    _b.token = _weth;
    bytes memory _sig = _signed(_b, _setName());
    vm.expectRevert(IPrivacyPoolSimple.MinOutNotMet.selector);
    _buy(_setName(), 0, _b, _sig);
  }
}

/// Base: SwapRouter02, QuoterV2, WETH and the WETH/USDC 0.05% pool (0xd0b53D9277642d899DF5C87A3966A349A798F224)
contract BuyForkBaseTest is BuyForkBase {
  function _chain() internal pure override returns (string memory, string memory, uint256) {
    return ('base', 'base', 53_434_000);
  }

  function _route() internal pure override returns (address, address, address, address, uint24) {
    return (
      0x2626664c2603336E57B271c5C0b26F421741e481,
      0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a,
      0x4200000000000000000000000000000000000006,
      0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, // USDC
      500
    );
  }
}

/// Robinhood Chain: Uniswap v3's SwapRouter02, QuoterV2, WETH and the WETH/USDG 0.01% pool
/// (0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca, from the v3 factory 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA)
contract BuyForkRobinhoodTest is BuyForkBase {
  function _chain() internal pure override returns (string memory, string memory, uint256) {
    return ('robinhood', 'robinhood', 104_619_000);
  }

  function _route() internal pure override returns (address, address, address, address, uint24) {
    return (
      0xCaf681a66D020601342297493863E78C959E5cb2,
      0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7,
      0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73,
      0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168, // USDG
      100
    );
  }
}
