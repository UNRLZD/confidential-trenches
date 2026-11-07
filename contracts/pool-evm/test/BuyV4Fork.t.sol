// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {console} from 'forge-std/console.sol';

import {
  UniswapV4Adapter,
  IPoolManager,
  IWETH9,
  PoolKey,
  SwapParams,
  PathKey
} from '../src/adapters/UniswapV4Adapter.sol';
import {ProofLib} from '../src/lib/ProofLib.sol';
import {PoseidonT3} from '../src/poseidon/PoseidonT3.sol';
import {PoseidonT4} from '../src/poseidon/PoseidonT4.sol';
import {IERC20Balance} from 'interfaces/IBuyAdapter.sol';
import {IPrivacyPool, IPrivacyPoolSimple} from 'interfaces/IPrivacyPool.sol';

import {BuyBase} from './Buy.t.sol';
import {ERC20Mock} from './BuyV3.t.sol';

/// v4-periphery V4Quoter's exact-input quote (it runs the swap, hooks included, and reverts with the result)
interface IV4Quoter {
  struct QuoteExactParams {
    address exactCurrency;
    PathKey[] path;
    uint128 exactAmount;
  }

  function quoteExactInput(QuoteExactParams memory params) external returns (uint256 amountOut, uint256 gasEstimate);
}

/// The PoolManager calls a test makes to plant a pool (v4-core IPoolManager)
interface IPoolManagerPlant {
  struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
  }

  function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24);
  function modifyLiquidity(
    PoolKey memory key,
    ModifyLiquidityParams memory params,
    bytes calldata hookData
  ) external returns (int256, int256);
}

/// A liquidity provider for a planted pool of the native asset or a mock token: it pays a mock token by minting it to
/// the PoolManager, the native asset from its own balance
contract LPv4 {
  IPoolManager internal immutable PM;

  constructor(IPoolManager _pm) {
    PM = _pm;
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
    } else {
      PM.sync(_c);
      ERC20Mock(_c).mint(address(PM), _a);
      PM.settle();
    }
  }

  receive() external payable {}
}

/// A hook that, after a swap, takes `bps` of the swap's output for itself (afterSwap with a return delta): a pool whose
/// hook takes more at the buy than it did at the quote
contract FeeHook {
  IPoolManager internal immutable PM;
  uint256 public bps;

  constructor(IPoolManager _pm) {
    PM = _pm;
  }

  function setBps(uint256 _bps) external {
    bps = _bps;
  }

  function afterSwap(
    address,
    PoolKey calldata _key,
    SwapParams calldata _p,
    int256 _delta,
    bytes calldata
  ) external returns (bytes4, int128) {
    (address _c, int128 _out) = _p.zeroForOne ? (_key.currency1, int128(_delta)) : (_key.currency0, int128(_delta >> 128));
    uint256 _fee = uint256(int256(_out)) * bps / 10_000;
    if (_fee > 0) PM.take(_c, address(this), _fee);
    return (FeeHook.afterSwap.selector, int128(int256(_fee)));
  }
}

/// The buy through Uniswap v4 on a fork of a chain at a pinned block: the chain's own Poseidon, v4 PoolManager, V4Quoter,
/// WETH and pools. The fork reads test/fork-rpc.mjs's replay of test/fixtures/fork-rpc.json (contracts/pool-evm/NOTICE).
/// A planted pool (a mock token X, liquidity this test sets, optionally a planted hook) sits in the chain's real
/// PoolManager, so a thin pool or a hook shows what the adapter does with the code that runs on chain.
abstract contract BuyV4ForkBase is BuyBase {
  // above every real currency these routes use, so a (real, X) pool's currency0 is the real one
  address internal constant X = 0xF111111111111111111111111111111111111111;
  // afterSwap (1 << 6) and afterSwapReturnDelta (1 << 2) in the low 14 bits: v4 reads a hook's calls from its address
  address internal constant HOOK = address(uint160(0xF00D) << 144 | 0x44);
  uint160 internal constant PRICE_1 = uint160(1 << 96); // tick 0
  uint256 internal constant FEE = 0.01 ether;

  UniswapV4Adapter internal adapter;
  IPoolManager internal pm;
  LPv4 internal lp;

  function _chain() internal pure virtual returns (string memory _rpc, string memory _set, uint256 _block);
  /// The chain's v4 PoolManager with the keccak256 of its code, the V4Quoter and WETH, each read on chain (eth_getCode)
  function _v4() internal pure virtual returns (address _pm, bytes32 _pmCodehash, address _quoter, address _weth);
  /// A one-hop route from the native asset to a real token
  function _oneHop() internal pure virtual returns (PathKey[] memory);
  /// A two-hop route from the native asset through a real token to another
  function _twoHop() internal pure virtual returns (PathKey[] memory);
  /// A one-hop route from WETH
  function _wethHop() internal pure virtual returns (PathKey[] memory);

  function setUp() public {
    (string memory _rpc, string memory _set, uint256 _block) = _chain();
    vm.createSelectFork(_rpc, _block);
    emit log_named_uint('coinbase balance', block.coinbase.balance);
    assertEq(PoseidonT3.DEPLOYED.codehash, PoseidonT3.CODEHASH);
    assertEq(PoseidonT4.DEPLOYED.codehash, PoseidonT4.CODEHASH);
    (address _pm, bytes32 _hash,, address _weth) = _v4();
    assertEq(_pm.codehash, _hash, 'the v4 PoolManager read on chain');
    vm.warp(1_900_000_000);
    _setUpPool(_set);
    // W is the published test key's address, which carries an EIP-7702 delegation on these mainnets (a sweeper that
    // forwards the ETH it gets); the device's W is a fresh key with no code, so the fork's W has none either (a buy
    // whose swap fails pays W in ETH, card pool-evm-buy-pays-revert)
    vm.etch(W, '');
    pm = IPoolManager(_pm);
    adapter = new UniswapV4Adapter(pm, IWETH9(_weth));
  }

  function _hop(address _c, uint24 _fee, int24 _ts, address _hooks) internal pure returns (PathKey memory) {
    return PathKey({intermediateCurrency: _c, fee: _fee, tickSpacing: _ts, hooks: _hooks, hookData: ''});
  }

  function _route(address _in, PathKey[] memory _path) internal pure returns (bytes memory) {
    return abi.encode(_in, _path);
  }

  function _quote(address _in, PathKey[] memory _path, uint256 _amount) internal returns (uint256 _out) {
    (,, address _quoter,) = _v4();
    (_out,) = IV4Quoter(_quoter).quoteExactInput(IV4Quoter.QuoteExactParams(_in, _path, uint128(_amount)));
  }

  function _setName() internal pure returns (string memory) {
    (, string memory _set,) = _chain();
    return string.concat(_set, '.buy');
  }

  function _signedBuy(
    address _in,
    PathKey[] memory _path,
    uint256 _minOut
  ) internal view returns (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) {
    _b = IPrivacyPoolSimple.Buy({
      adapter: address(adapter),
      data: _route(_in, _path),
      minOut: _minOut,
      token: _path[_path.length - 1].intermediateCurrency
    });
    _sig = _signed(_b, _setName());
  }

  /// The buy lands what V4Quoter quotes for the chunk at the pinned block, at least minOut, and leaves nothing behind
  function _lands(address _in, PathKey[] memory _path, string memory _what) internal {
    uint256 _quoted = _quote(_in, _path, 0.4 ether - FEE);
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) = _signedBuy(_in, _path, _quoted * 99 / 100);
    IPrivacyPool.Withdrawal memory _w = _withdrawal(_setName());
    ProofLib.WithdrawProof memory _p = _proof(_setName());
    uint256 _poolBefore = POOL.balance;
    uint256 _pmBefore = address(pm).balance;
    vm.prank(address(0xBEEF));
    uint256 _g = gasleft();
    pool.buy(_w, _p, FEE, _b, _sig);
    console.log(_what, 'gas:', _g - gasleft());
    uint256 _got = IERC20Balance(_b.token).balanceOf(W);
    console.log('W got', _got, 'quoted', _quoted);
    assertEq(_got, _quoted, 'W got the quote at the pinned block');
    assertGe(_got, _b.minOut);
    assertEq(RELAYER.balance, FEE);
    assertEq(POOL.balance, _poolBefore - 0.4 ether);
    assertEq(address(adapter).balance, 0, 'the adapter keeps no ether');
    assertEq(IERC20Balance(_b.token).balanceOf(address(adapter)), 0, 'nor any token');
    if (_in == address(0)) assertEq(address(pm).balance, _pmBefore + 0.4 ether - FEE, 'the PoolManager got the chunk');
    assertEq(W.balance, 0);
  }

  /// The swap is refused with `_err`, so the buy pays out as a withdraw (card pool-evm-buy-pays-revert): the fee paid,
  /// W paid the rest in ETH, the note spent, and the PoolManager and the adapter hold what they held
  function _refused(IPrivacyPoolSimple.Buy memory _b, bytes memory _sig, bytes4 _err) internal {
    uint256 _pmBefore = address(pm).balance;
    _paysOut(_setName(), FEE, _b, _sig, _err);
    assertEq(address(pm).balance, _pmBefore, 'the PoolManager holds what it held');
    assertEq(address(adapter).balance, 0);
  }

  function test_v4OneHopLands() public {
    _lands(address(0), _oneHop(), 'buy, v4 one hop, depth 2');
  }

  function test_v4TwoHopLands() public {
    _lands(address(0), _twoHop(), 'buy, v4 two hops, depth 2');
  }

  function test_v4FromWethLands() public {
    (,,, address _weth) = _v4();
    _lands(_weth, _wethHop(), 'buy, v4 from WETH, depth 2');
  }

  /// The kit builds this test's routes byte for byte (test/fixtures/kit-routes.json, packages/kit/test/evm-pool-buy.test.ts)
  function test_theKitBuildsTheseRoutes() public view {
    string memory _k = vm.readFile('test/fixtures/kit-routes.json');
    (, string memory _set,) = _chain();
    (,,, address _weth) = _v4();
    string memory _at = string.concat('.', _set);
    assertEq(vm.parseJsonBytes(_k, string.concat(_at, '.v4OneHop.data')), _route(address(0), _oneHop()));
    assertEq(vm.parseJsonBytes(_k, string.concat(_at, '.v4TwoHop.data')), _route(address(0), _twoHop()));
    assertEq(vm.parseJsonBytes(_k, string.concat(_at, '.v4FromWeth.data')), _route(_weth, _wethHop()));
  }

  /// A minOut above what the route gives: the adapter refuses before paying anything out
  function test_v4AMinOutOverTheQuoteFails() public {
    uint256 _quoted = _quote(address(0), _oneHop(), 0.4 ether - FEE);
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) = _signedBuy(address(0), _oneHop(), _quoted + 1);
    _refused(_b, _sig, UniswapV4Adapter.TooLittleReceived.selector);
  }

  /// A route that buys another token than the one W signed for: W's balance of it does not rise
  function test_v4ARouteToAnotherTokenFails() public {
    (IPrivacyPoolSimple.Buy memory _b,) = _signedBuy(address(0), _oneHop(), 1);
    _b.token = _twoHop()[1].intermediateCurrency;
    _refused(_b, _signed(_b, _setName()), IPrivacyPoolSimple.MinOutNotMet.selector);
  }

  /// A route from a currency the adapter is not sent (here X, a token with no pool) is refused before any swap
  function test_v4ARouteFromAnotherCurrencyIsRefused() public {
    deployCodeTo('BuyV3.t.sol:ERC20Mock', X);
    PathKey[] memory _path = _oneHop();
    IPrivacyPoolSimple.Buy memory _b = IPrivacyPoolSimple.Buy({
      adapter: address(adapter),
      data: _route(X, _path),
      minOut: 1,
      token: _path[0].intermediateCurrency
    });
    _refused(_b, _signed(_b, _setName()), UniswapV4Adapter.InvalidRoute.selector);
  }

  function test_v4AnEmptyRouteIsRefused() public {
    IPrivacyPoolSimple.Buy memory _b = IPrivacyPoolSimple.Buy({
      adapter: address(adapter),
      data: _route(address(0), new PathKey[](0)),
      minOut: 1,
      token: _oneHop()[0].intermediateCurrency
    });
    _refused(_b, _signed(_b, _setName()), UniswapV4Adapter.InvalidRoute.selector);
  }

  /// Only the PoolManager calls the adapter back, and only inside the adapter's own unlock
  function test_v4OnlyThePoolManagerCallsBack() public {
    vm.expectRevert(UniswapV4Adapter.NotPoolManager.selector);
    adapter.unlockCallback(abi.encode(address(this), uint256(1), uint256(1), _route(address(0), _oneHop())));
  }

  /// A planted pool of (`_c`, X) at tick 0 with `_liq` of X alone in [`_lo`, `_hi`], below the price
  function _plant(address _c, address _hooks, int256 _liq, int24 _lo, int24 _hi) internal returns (PathKey memory) {
    if (X.code.length == 0) deployCodeTo('BuyV3.t.sol:ERC20Mock', X);
    if (address(lp) == address(0)) lp = new LPv4(pm);
    (uint24 _fee, int24 _ts) = _hooks == address(0) ? (uint24(500), int24(10)) : (uint24(3000), int24(60));
    PoolKey memory _key = PoolKey(_c, X, _fee, _ts, _hooks);
    IPoolManagerPlant(address(pm)).initialize(_key, PRICE_1);
    lp.add(_key, _lo, _hi, _liq);
    return _hop(X, _fee, _ts, _hooks);
  }

  /// The pool fills only part of the chunk (its liquidity runs out and the price reaches the limit): the buy reverts
  /// whole and the note stays unspent
  function test_v4APartialFillRevertsTheBuy() public {
    PathKey[] memory _path = new PathKey[](1);
    _path[0] = _plant(address(0), address(0), 1e9, -1000, -500); // about 2.6e7 wei fills it
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) = _signedBuy(address(0), _path, 1);
    _refused(_b, _sig, UniswapV4Adapter.PartialFill.selector);
  }

  /// The second hop is thin: it takes only part of what the first gave. The buy reverts whole.
  function test_v4APartialSecondHopRevertsTheBuy() public {
    PathKey[] memory _path = new PathKey[](2);
    _path[0] = _oneHop()[0];
    _path[1] = _plant(_path[0].intermediateCurrency, address(0), 1e9, -1000, -500);
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) = _signedBuy(address(0), _path, 1);
    _refused(_b, _sig, UniswapV4Adapter.PartialFill.selector);
    assertEq(IERC20Balance(_path[0].intermediateCurrency).balanceOf(address(adapter)), 0);
  }

  /// A pool whose hook takes nothing at the quote and `_bps` of the output at the buy: W signed minOut 1% under the
  /// quote, so the buy reverts and W is never paid less
  function _hookTakes(uint256 _bps) internal {
    deployCodeTo('BuyV4Fork.t.sol:FeeHook', abi.encode(address(pm)), HOOK);
    PathKey[] memory _path = new PathKey[](1);
    _path[0] = _plant(address(0), HOOK, 1e22, -6000, -60);
    uint256 _quoted = _quote(address(0), _path, 0.4 ether - FEE);
    assertGt(_quoted, 0);
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) = _signedBuy(address(0), _path, _quoted * 99 / 100);
    FeeHook(HOOK).setBps(_bps);
    _refused(_b, _sig, UniswapV4Adapter.TooLittleReceived.selector);
    assertEq(IERC20Balance(X).balanceOf(W), 0, 'W got nothing');
  }

  function test_v4AHookThatTakesMoreThanTheQuoteFails() public {
    _hookTakes(500); // 5%
  }

  function test_v4AHookThatTakesMoreThanTheOutputFails() public {
    _hookTakes(10_001);
  }

  /// The same planted hook taking nothing: the buy lands what the quote says (the hook test's control)
  function test_v4AHookThatTakesNothingLands() public {
    deployCodeTo('BuyV4Fork.t.sol:FeeHook', abi.encode(address(pm)), HOOK);
    PathKey[] memory _path = new PathKey[](1);
    _path[0] = _plant(address(0), HOOK, 1e22, -6000, -60);
    _lands(address(0), _path, 'buy, v4 planted hook, depth 2');
  }

  /// The buy at depth 2 (the change commitment's insert: 2 hashes) or 32 (32), as the test's first call
  function _gas(PathKey[] memory _path, bool _deep, string memory _what) internal {
    (IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) = _signedBuy(address(0), _path, 1);
    IPrivacyPool.Withdrawal memory _w = _withdrawal(_setName());
    ProofLib.WithdrawProof memory _p = _proof(_setName());
    if (_deep) {
      vm.store(POOL, bytes32(uint256(3)), bytes32(uint256(type(uint32).max))); // size 2^32 - 1
      vm.store(POOL, bytes32(uint256(4)), bytes32(uint256(32))); // depth 32
      for (uint256 _i; _i < 32; ++_i) vm.store(POOL, keccak256(abi.encode(_i, uint256(5))), bytes32(_i + 1));
    }
    vm.prank(address(0xBEEF));
    uint256 _g = gasleft();
    pool.buy(_w, _p, FEE, _b, _sig);
    console.log(_what, 'gas:', _g - gasleft());
    assertEq(pool.currentTreeDepth(), _deep ? 32 : 2);
  }

  function test_gasV4OneHopDepth2() public {
    _gas(_oneHop(), false, 'buy, v4 one hop, depth 2');
  }

  function test_gasV4OneHopDepth32() public {
    _gas(_oneHop(), true, 'buy, v4 one hop, depth 32');
  }

  function test_gasV4TwoHopDepth2() public {
    _gas(_twoHop(), false, 'buy, v4 two hops, depth 2');
  }

  function test_gasV4TwoHopDepth32() public {
    _gas(_twoHop(), true, 'buy, v4 two hops, depth 32');
  }
}

/// Base at 53,438,800. eth_getCode on https://mainnet.base.org at that block: PoolManager
/// 0x498581fF718922c3f8e6A244956aF099B2652b2b (24,009 bytes, keccak256 below), V4Quoter
/// 0x0d5e0F971ED27FBfF6c2837bf31316121532048D (5,820 bytes); the addresses are Uniswap's (sdk-core addresses.ts,
/// v4PoolManagerAddress and v4QuoterAddress for chain 8453). Pools (StateView.getLiquidity at that block, all non-zero,
/// no hooks): native ETH/USDC 0.05% (tick spacing 10), USDC/cbBTC 0.05% (10), WETH/USDC 0.3% (60).
contract BuyV4ForkBaseTest is BuyV4ForkBase {
  address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
  address internal constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;

  function _chain() internal pure override returns (string memory, string memory, uint256) {
    return ('base', 'base', 53_438_800);
  }

  function _v4() internal pure override returns (address, bytes32, address, address) {
    return (
      0x498581fF718922c3f8e6A244956aF099B2652b2b,
      0x83b2af6e9f3158defc2811cbcb0db71ecf8b2ba2abea39c39e370ac5c6f43eb6,
      0x0d5e0F971ED27FBfF6c2837bf31316121532048D,
      0x4200000000000000000000000000000000000006
    );
  }

  function _oneHop() internal pure override returns (PathKey[] memory _p) {
    _p = new PathKey[](1);
    _p[0] = _hop(USDC, 500, 10, address(0));
  }

  function _twoHop() internal pure override returns (PathKey[] memory _p) {
    _p = new PathKey[](2);
    _p[0] = _hop(USDC, 500, 10, address(0));
    _p[1] = _hop(CBBTC, 500, 10, address(0));
  }

  function _wethHop() internal pure override returns (PathKey[] memory _p) {
    _p = new PathKey[](1);
    _p[0] = _hop(USDC, 3000, 60, address(0));
  }
}

/// Robinhood Chain at 104,661,630. eth_getCode on https://rpc.mainnet.chain.robinhood.com at that block: PoolManager
/// 0x8366a39cc670b4001a1121b8f6a443a643e40951 (24,009 bytes, keccak256 below), V4Quoter
/// 0x8dc178efb8111bb0973dd9d722ebeff267c98f94 (6,118 bytes); the addresses are Uniswap's (sdk-core addresses.ts,
/// ROBINHOOD_ADDRESSES, chain 4663). Pools (StateView 0xf3334192d15450cdd385c8b70e03f9a6bd9e673b getLiquidity at that
/// block, all non-zero, no hooks): native ETH/USDG 0.05% (10), WETH/USDG 0.05% (10).
contract BuyV4ForkRobinhoodTest is BuyV4ForkBase {
  address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
  address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

  function _chain() internal pure override returns (string memory, string memory, uint256) {
    return ('robinhood', 'robinhood', 104_661_630);
  }

  function _v4() internal pure override returns (address, bytes32, address, address) {
    return (
      0x8366a39CC670B4001A1121B8F6A443A643e40951,
      0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626,
      0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94,
      WETH
    );
  }

  function _oneHop() internal pure override returns (PathKey[] memory _p) {
    _p = new PathKey[](1);
    _p[0] = _hop(USDG, 500, 10, address(0));
  }

  /// native ETH to USDG, then USDG to WETH: two real v4 pools
  function _twoHop() internal pure override returns (PathKey[] memory _p) {
    _p = new PathKey[](2);
    _p[0] = _hop(USDG, 500, 10, address(0));
    _p[1] = _hop(WETH, 500, 10, address(0));
  }

  function _wethHop() internal pure override returns (PathKey[] memory _p) {
    _p = new PathKey[](1);
    _p[0] = _hop(USDG, 500, 10, address(0));
  }
}
