// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {console} from 'forge-std/console.sol';

import {UniswapV3Adapter, IV3SwapRouter} from '../src/adapters/UniswapV3Adapter.sol';
import {ProofLib} from '../src/lib/ProofLib.sol';
import {IERC20Balance} from 'interfaces/IBuyAdapter.sol';
import {IPrivacyPool, IPrivacyPoolSimple} from 'interfaces/IPrivacyPool.sol';

import {BuyBase} from './Buy.t.sol';

interface IUniPool {
  function initialize(uint160 sqrtPriceX96) external;
  function mint(
    address recipient,
    int24 tickLower,
    int24 tickUpper,
    uint128 amount,
    bytes calldata data
  ) external returns (uint256, uint256);
  function token0() external view returns (address);
  function token1() external view returns (address);
}

interface IWETH9 {
  function deposit() external payable;
  function transfer(address, uint256) external returns (bool);
}

/// A plain ERC-20 with an open mint
contract ERC20Mock {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  function mint(address _to, uint256 _a) external {
    balanceOf[_to] += _a;
  }

  function approve(address _s, uint256 _a) external returns (bool) {
    allowance[msg.sender][_s] = _a;
    return true;
  }

  function transfer(address _to, uint256 _a) external returns (bool) {
    balanceOf[msg.sender] -= _a;
    balanceOf[_to] += _a;
    return true;
  }

  function transferFrom(address _f, address _to, uint256 _a) external returns (bool) {
    allowance[_f][msg.sender] -= _a;
    balanceOf[_f] -= _a;
    balanceOf[_to] += _a;
    return true;
  }
}

/// A liquidity provider for the v3 pool code: pays the mint callback (WETH by wrapping, a mock token by minting)
contract LP {
  address internal constant WETH = 0x4200000000000000000000000000000000000006;

  function mint(address _pool, int24 _lo, int24 _hi, uint128 _liq) external {
    IUniPool(_pool).mint(address(this), _lo, _hi, _liq, '');
  }

  function uniswapV3MintCallback(uint256 _a0, uint256 _a1, bytes calldata) external {
    if (_a0 > 0) _pay(IUniPool(msg.sender).token0(), _a0);
    if (_a1 > 0) _pay(IUniPool(msg.sender).token1(), _a1);
  }

  function _pay(address _t, uint256 _a) internal {
    if (_t == WETH) {
      IWETH9(WETH).deposit{value: _a}();
      IWETH9(WETH).transfer(msg.sender, _a);
    } else {
      ERC20Mock(_t).mint(msg.sender, _a);
    }
  }

  receive() external payable {}
}

/// The buy through the real SwapRouter02 and Uniswap v3 pool code (Base, block 53,434,000:
/// test/fixtures/uniswap-v3-base.json) on a local chain with no RPC, over pools whose liquidity the test sets, so a
/// thin pool shows what a partial fill does. The pool code sits at its own CREATE2 address (the router's callback
/// check passes); USDC's address holds a mock ERC-20. From the review of b61f0f5 (ReviewV3Test).
contract BuyV3Test is BuyBase {
  uint256 internal constant NOW = 1_900_000_000;
  address internal constant ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
  address internal constant FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
  address internal constant WETH = 0x4200000000000000000000000000000000000006;
  address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
  address internal constant V3POOL = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
  bytes32 internal constant INIT_HASH = 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;
  // below USDC's address, so a (X, USDC) pool's token0 is X, as WETH is token0 of (WETH, USDC)
  address internal constant X = 0x1111111111111111111111111111111111111111;
  // UniswapV3Adapter.PartialFill, spelled out so this file also builds against the adapter before it had it
  bytes4 internal constant PARTIAL_FILL = bytes4(keccak256('PartialFill()'));

  LP internal lp;
  string internal v3;
  UniswapV3Adapter internal adapter;

  function setUp() public {
    _deployPoseidon();
    vm.warp(NOW);
    _setUpPool('local');
    v3 = vm.readFile('test/fixtures/uniswap-v3-base.json');
    vm.etch(ROUTER, vm.parseJsonBytes(v3, '.router'));
    vm.etch(WETH, vm.parseJsonBytes(v3, '.weth'));
    vm.etch(V3POOL, vm.parseJsonBytes(v3, '.pool'));
    deployCodeTo('BuyV3.t.sol:ERC20Mock', USDC);
    deployCodeTo('BuyV3.t.sol:ERC20Mock', X);
    assertEq(_poolAddress(WETH, USDC, 500), V3POOL, 'the pool code sits where the router looks');
    lp = new LP();
    vm.deal(address(lp), 1000 ether);
    IUniPool(V3POOL).initialize(uint160(1 << 96)); // tick 0
    adapter = new UniswapV3Adapter(IV3SwapRouter(ROUTER));
  }

  function _poolAddress(address _a, address _b, uint24 _fee) internal pure returns (address) {
    return address(
      uint160(uint256(keccak256(abi.encodePacked(hex'ff', FACTORY, keccak256(abi.encode(_a, _b, _fee)), INIT_HASH))))
    );
  }

  function _patch(bytes memory _code, address _fromA, address _toA) internal pure returns (uint256 _n) {
    bytes20 _from = bytes20(_fromA);
    bytes20 _to = bytes20(_toA);
    for (uint256 _i; _i + 20 <= _code.length; ++_i) {
      bool _m = true;
      for (uint256 _j; _j < 20 && _m; ++_j) if (_code[_i + _j] != _from[_j]) _m = false;
      if (_m) {
        for (uint256 _j; _j < 20; ++_j) _code[_i + _j] = _to[_j];
        ++_n;
      }
    }
  }

  /// A second pool (X, USDC, 0.05%): the same code with each WETH immutable replaced by X and its own address (the
  /// noDelegateCall immutable) by the new one, at its CREATE2 address
  function _secondPool() internal returns (address _at) {
    bytes memory _code = vm.parseJsonBytes(v3, '.pool');
    _at = _poolAddress(X, USDC, 500);
    assertEq(_patch(_code, WETH, X), 6, 'six WETH immutables');
    assertEq(_patch(_code, V3POOL, _at), 1, 'one self-address immutable');
    vm.etch(_at, _code);
    assertEq(IUniPool(_at).token0(), X);
    assertEq(IUniPool(_at).token1(), USDC);
    IUniPool(_at).initialize(uint160(1 << 96));
  }

  function _signedBuy(
    bytes memory _path,
    address _token,
    uint256 _minOut
  ) internal view returns (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) {
    _b = IPrivacyPoolSimple.Buy({adapter: address(adapter), data: _path, minOut: _minOut, token: _token});
    _sig = _signed(_b, 'local.buy');
  }

  /// The pool fills only part of the chunk (it stops at its price limit): the router would keep the rest as ETH, for
  /// anyone's refundETH. The swap reverts whole, and the buy pays out as a withdraw (card pool-evm-buy-pays-revert).
  function test_aPartialFillRevertsTheBuy() public {
    lp.mint(V3POOL, -1000, -500, 1e9); // token1 only, below the price: about 2.4e7 units for about 2.6e7 wei
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) = _signedBuy(abi.encodePacked(WETH, uint24(500), USDC), USDC, 2e7);
    _paysOut('local.buy', 0.01 ether, _b, _sig, PARTIAL_FILL);
    assertEq(ROUTER.balance, 0, 'nothing in the router');
    assertEq(IERC20Balance(USDC).balanceOf(W), 0, 'W holds no USDC');
  }

  /// The second hop is thin: the router would keep the first hop's USDC, for anyone's sweepToken (a check on the
  /// router's ETH alone would not see it). The swap reverts whole, and the buy pays out as a withdraw.
  function test_aPartialSecondHopRevertsTheBuy() public {
    lp.mint(V3POOL, -1000, -500, 1e22); // a deep first hop
    lp.mint(_secondPool(), 500, 1000, 1e9); // a thin second hop: token0 (X) only, above the price
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) =
      _signedBuy(abi.encodePacked(WETH, uint24(500), USDC, uint24(500), X), X, 2e7);
    _paysOut('local.buy', 0.01 ether, _b, _sig, PARTIAL_FILL);
    assertEq(IERC20Balance(USDC).balanceOf(ROUTER), 0, 'no USDC in the router');
  }

  /// A full fill over two hops lands what the router gives for the chunk called directly, and leaves the router empty
  function test_aFullFillLandsWhatTheRouterGives() public {
    lp.mint(V3POOL, -1000, -500, 1e22);
    lp.mint(_secondPool(), 500, 1000, 1e22);
    bytes memory _path = abi.encodePacked(WETH, uint24(500), USDC, uint24(500), X);
    uint256 _chunk = _proof('local.buy').pubSignals[2] - 0.01 ether;
    uint256 _snap = vm.snapshotState();
    vm.deal(address(0xD1EC7), _chunk);
    vm.prank(address(0xD1EC7));
    uint256 _direct = IV3SwapRouter(ROUTER).exactInput{value: _chunk}(
      IV3SwapRouter.ExactInputParams({path: _path, recipient: W, amountIn: _chunk, amountOutMinimum: 1})
    );
    assertGt(_direct, 0);
    vm.revertToState(_snap);
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) = _signedBuy(_path, X, 1);
    vm.prank(address(0xBEEF));
    uint256 _g = gasleft();
    pool.buy(_withdrawal('local.buy'), _proof('local.buy'), 0.01 ether, _b, _sig);
    console.log('buy, real router, two hops, depth 2 gas:', _g - gasleft());
    assertEq(IERC20Balance(X).balanceOf(W), _direct, 'what the router gives directly');
    assertEq(ROUTER.balance, 0);
    assertEq(IERC20Balance(USDC).balanceOf(ROUTER), 0);
    assertEq(IERC20Balance(WETH).balanceOf(ROUTER), 0);
  }

  /// The buy through the real router on one hop at depth 2 (the change commitment's insert: 2 hashes) or 32 (32), as
  /// the test's first call
  function _gasOneHop(bool _deep) internal {
    lp.mint(V3POOL, -1000, -500, 1e22);
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) = _signedBuy(abi.encodePacked(WETH, uint24(500), USDC), USDC, 1);
    IPrivacyPool.Withdrawal memory _w = _withdrawal('local.buy');
    ProofLib.WithdrawProof memory _p = _proof('local.buy');
    if (_deep) {
      vm.store(POOL, bytes32(uint256(3)), bytes32(uint256(type(uint32).max))); // size 2^32 - 1
      vm.store(POOL, bytes32(uint256(4)), bytes32(uint256(32))); // depth 32
      for (uint256 _i; _i < 32; ++_i) vm.store(POOL, keccak256(abi.encode(_i, uint256(5))), bytes32(_i + 1));
    }
    vm.prank(address(0xBEEF));
    uint256 _g = gasleft();
    pool.buy(_w, _p, 0.01 ether, _b, _sig);
    console.log(_deep ? 'buy, real router one hop, depth 32 gas:' : 'buy, real router one hop, depth 2 gas:', _g - gasleft());
    assertEq(pool.currentTreeDepth(), _deep ? 32 : 2);
  }

  function test_gasRealRouterOneHopDepth2() public {
    _gasOneHop(false);
  }

  function test_gasRealRouterOneHopDepth32() public {
    _gasOneHop(true);
  }
}
