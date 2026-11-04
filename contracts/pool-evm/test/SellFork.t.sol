// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Vm, VmSafe} from 'forge-std/Vm.sol';
import {console} from 'forge-std/console.sol';

import {PrivacyPoolSimple} from '../src/PrivacyPoolSimple.sol';
import {Constants} from '../src/lib/Constants.sol';
import {SellDelegate, IWETH} from '../src/SellDelegate.sol';
import {IPoolManager} from '../src/adapters/UniswapV4Adapter.sol';
import {IV3SwapRouter} from '../src/adapters/UniswapV3Adapter.sol';
import {PoseidonT3} from '../src/poseidon/PoseidonT3.sol';
import {PoseidonT4} from '../src/poseidon/PoseidonT4.sol';
import {WithdrawalVerifier} from '../src/verifiers/WithdrawalVerifier.sol';
import {IERC20Balance} from 'interfaces/IBuyAdapter.sol';

import {IQuoterV2} from './BuyFork.t.sol';
import {SellBase} from './Sell.t.sol';

interface IERC20Allowance {
  function allowance(address _owner, address _spender) external view returns (uint256);
}

/// The sell through Uniswap v3's SwapRouter02 on a fork of a chain at a pinned block, with the chain's own Poseidon,
/// router, WETH and pool: W holds the token a buy paid it, and the helper sends one type-4 transaction that carries
/// W's EIP-7702 authorization (vm.signAndAttachDelegation) and the sell. The fork reads test/fork-rpc.mjs's replay of
/// test/fixtures/fork-rpc.json, so the tests read no RPC (contracts/pool-evm/NOTICE).
abstract contract SellForkBase is SellBase {
  uint256 internal constant FEE = 0.0005 ether;
  uint256 internal constant PRE = 0x5e11;

  function _chain() internal pure virtual returns (string memory _rpc, uint256 _block);
  function _route() internal pure virtual returns (address _router, address _quoter, address _weth, address _token, uint24 _fee);
  /// The chain's v4 PoolManager, the delegate's pin (test/BuyV4Fork.t.sol reads its code on chain)
  function _poolManager() internal pure virtual returns (address);

  function setUp() public {
    (string memory _rpc, uint256 _block) = _chain();
    vm.createSelectFork(_rpc, _block);
    _prague();
    // Foundry 1.8 loads the block's coinbase account (warm since Shanghai) and 1.7 does not: read it here, so the
    // recording holds it for either
    emit log_named_uint('coinbase balance', block.coinbase.balance);
    assertEq(PoseidonT3.DEPLOYED.codehash, PoseidonT3.CODEHASH);
    assertEq(PoseidonT4.DEPLOYED.codehash, PoseidonT4.CODEHASH);
    (address _router,, address _weth, address _token, uint24 _fee) = _route();
    _deploy(_weth);
    _setUpW();
    // the buy W holds: the token for 0.4 ETH, paid to W
    vm.deal(address(this), 0.4 ether);
    IV3SwapRouter(_router).exactInput{value: 0.4 ether}(
      IV3SwapRouter.ExactInputParams({
        path: abi.encodePacked(_weth, _fee, _token),
        recipient: W,
        amountIn: 0.4 ether,
        amountOutMinimum: 1
      })
    );
    assertGt(IERC20Balance(_token).balanceOf(W), 0);
    assertEq(W.balance, 0);
  }

  /// The pool and the delegate this fork's sells go through: new ones here (a pinned chain's are at its pins)
  function _deploy(address _weth) internal virtual {
    pool = new PrivacyPoolSimple(address(new WithdrawalVerifier()));
    delegate = new SellDelegate(IWETH(_weth), IPoolManager(_poolManager()));
  }

  /// This fork's entry in test/fixtures/kit-sells.json
  function _kitKey() internal pure virtual returns (string memory _key) {
    (_key,) = _chain();
  }

  function _sellPath() internal pure returns (bytes memory) {
    (,, address _weth, address _token, uint24 _fee) = _route();
    return abi.encodePacked(_token, _fee, _weth);
  }

  /// W's whole token balance, sold for WETH paid to W, with `_routerMin` as the router's own minimum
  function _forkSell(uint256 _amountIn, uint256 _routerMin, uint256 _minOut) internal view returns (SellDelegate.Sell memory) {
    (address _router,,, address _token,) = _route();
    return SellDelegate.Sell({
      token: _token,
      amount: IERC20Balance(_token).balanceOf(W),
      target: _router,
      data: abi.encodeCall(
        IV3SwapRouter.exactInput,
        (IV3SwapRouter.ExactInputParams({path: _sellPath(), recipient: W, amountIn: _amountIn, amountOutMinimum: _routerMin}))
      ),
      minOut: _minOut,
      pool: address(pool),
      precommitment: PRE,
      feeCap: FEE,
      deadline: block.timestamp + 60,
      nonce: 0
    });
  }

  function _quote(uint256 _in) internal returns (uint256 _out) {
    (, address _quoter,,,) = _route();
    (_out,,,) = IQuoterV2(_quoter).quoteExactInput(_sellPath(), _in);
  }

  /// One type-4 transaction from the helper: W's authorization and the sell
  function _sendDelegated(SellDelegate.Sell memory _s, uint256 _fee, bytes memory _sig) internal returns (uint256 _gas) {
    vm.signAndAttachDelegation(address(delegate), W_KEY);
    vm.prank(SENDER);
    _gas = gasleft();
    SellDelegate(payable(W)).sell(_s, _fee, _sig);
    _gas -= gasleft();
  }

  function test_aForkSellLandsAndTheLeafHoldsTheProceedsLessTheFee() public {
    (,,, address _token,) = _route();
    uint256 _amount = IERC20Balance(_token).balanceOf(W);
    uint256 _quoted = _quote(_amount);
    SellDelegate.Sell memory _s = _forkSell(_amount, _quoted * 99 / 100, _quoted * 99 / 100);
    bytes memory _sig = _signed(_s);
    uint256 _poolBefore = address(pool).balance;
    vm.recordLogs();
    uint256 _g = _sendDelegated(_s, FEE, _sig);
    console.log('sell + deposit (one type-4 transaction, W authorized in it, depth 0) gas:', _g);
    (uint256 _c, uint256 _label, uint256 _value, uint256 _pre) = _deposited(vm.getRecordedLogs());
    console.log('sold', _amount, 'for wei', _quoted);
    assertEq(_value, _quoted - FEE, 'the leaf holds the proceeds (the quote at the pinned block) less the fee');
    assertEq(_pre, PRE);
    assertEq(_c, PoseidonT4.hash([_quoted - FEE, _label, PRE]), 'the commitment, by the chain own Poseidon');
    assertEq(address(pool).balance, _poolBefore + _quoted - FEE);
    assertEq(SENDER.balance, FEE, 'the helper is paid the fee');
    assertEq(W.code, abi.encodePacked(hex'ef0100', address(delegate)), 'W is delegated by the same transaction');
    assertEq(IERC20Balance(_token).balanceOf(W), 0, 'W sold every token');
    assertEq(IERC20Allowance(_token).allowance(W, _s.target), 0, 'the approval ends at 0');
    assertEq(W.balance, 0, 'W keeps no ether');
    (,, address _weth,,) = _route();
    assertEq(IERC20Balance(_weth).balanceOf(W), 0, 'nor WETH');
    assertEq(SellDelegate(payable(W)).nonce(), 1);
  }

  /// The kit's sell (card evm-pool-sell-tx): test/fixtures/kit-sells.json, made by packages/kit/test/make-kit-sells.ts
  /// with evmPoolBuildSell, evmPoolSignSell and evmPoolSignSellAuthorization from this fork's values. The test's own
  /// sell equals the kit's field for field and byte for byte, and the helper's one type-4 transaction carries the
  /// kit's authorization and signature, not the test's: the pool's Deposited log ends it.
  function test_theKitsSellLands() public {
    (address _router,,, address _token,) = _route();
    string memory _set = _kitKey();
    string memory _j = vm.readFile('test/fixtures/kit-sells.json');
    string memory _k = string.concat('.', _set);
    uint256 _amount = IERC20Balance(_token).balanceOf(W);
    uint256 _minOut = _quote(_amount) * 99 / 100;
    SellDelegate.Sell memory _s = _forkSell(_amount, _minOut, _minOut);
    _s.deadline = block.timestamp + 300;
    assertEq(vm.parseJsonAddress(_j, string.concat(_k, '.sells')), _s.token);
    assertEq(vm.parseUint(vm.parseJsonString(_j, string.concat(_k, '.amount'))), _s.amount);
    assertEq(vm.parseJsonAddress(_j, string.concat(_k, '.target')), _router);
    assertEq(vm.parseJsonBytes(_j, string.concat(_k, '.data')), _s.data, 'the kit encodes the swap byte for byte');
    assertEq(vm.parseUint(vm.parseJsonString(_j, string.concat(_k, '.minOut'))), _s.minOut);
    assertEq(vm.parseJsonAddress(_j, string.concat(_k, '.pool')), _s.pool);
    assertEq(vm.parseUint(vm.parseJsonString(_j, string.concat(_k, '.precommitment'))), _s.precommitment);
    assertEq(vm.parseUint(vm.parseJsonString(_j, string.concat(_k, '.feeCap'))), _s.feeCap);
    assertEq(vm.parseUint(vm.parseJsonString(_j, string.concat(_k, '.deadline'))), _s.deadline);
    assertEq(vm.parseUint(vm.parseJsonString(_j, string.concat(_k, '.nonce'))), _s.nonce);
    bytes memory _sig = vm.parseJsonBytes(_j, string.concat(_k, '.signature'));
    assertEq(_sig, _signed(_s), "the kit's signature is the test's own");
    string memory _a = string.concat(_k, '.authorization');
    assertEq(vm.parseJsonUint(_j, string.concat(_a, '.chainId')), block.chainid);
    assertEq(vm.parseJsonAddress(_j, string.concat(_a, '.delegate')), address(delegate));
    uint64 _authNonce = uint64(vm.parseUint(vm.parseJsonString(_j, string.concat(_a, '.nonce'))));
    assertEq(_authNonce, vm.getNonce(W), "the authorization carries W's account nonce");
    vm.attachDelegation(
      VmSafe.SignedDelegation({
        v: uint8(vm.parseJsonUint(_j, string.concat(_a, '.yParity'))),
        r: vm.parseJsonBytes32(_j, string.concat(_a, '.r')),
        s: vm.parseJsonBytes32(_j, string.concat(_a, '.s')),
        nonce: _authNonce,
        implementation: address(delegate)
      })
    );
    uint256 _poolBefore = address(pool).balance;
    vm.recordLogs();
    vm.prank(SENDER);
    SellDelegate(payable(W)).sell(_s, FEE, _sig);
    assertEq(W.code, abi.encodePacked(hex'ef0100', address(delegate)), "the kit's authorization delegates W");
    (, , uint256 _value, uint256 _pre) = _deposited(vm.getRecordedLogs());
    assertGe(_value, _minOut - FEE, 'the leaf holds at least minOut less the fee');
    assertEq(_pre, PRE);
    assertEq(address(pool).balance, _poolBefore + _value);
    assertEq(SENDER.balance, FEE);
    assertEq(IERC20Balance(_token).balanceOf(W), 0);
    assertEq(SellDelegate(payable(W)).nonce(), 1);
  }

  /// The router's own minimum left at 1: the delegate's minOut still refuses an output under it
  function test_aForkShortOutputFails() public {
    (,,, address _token,) = _route();
    uint256 _amount = IERC20Balance(_token).balanceOf(W);
    uint256 _quoted = _quote(_amount);
    SellDelegate.Sell memory _s = _forkSell(_amount, 1, _quoted + 1);
    bytes memory _sig = _signed(_s);
    vm.expectRevert(SellDelegate.MinOutNotMet.selector);
    _sendDelegated(_s, FEE, _sig);
  }

  /// A swap of less than the approved amount leaves an approval: refused
  function test_aForkLeftoverApprovalFails() public {
    (,,, address _token,) = _route();
    uint256 _amount = IERC20Balance(_token).balanceOf(W);
    SellDelegate.Sell memory _s = _forkSell(_amount - 1, 1, 1);
    bytes memory _sig = _signed(_s);
    vm.expectRevert(SellDelegate.LeftoverApproval.selector);
    _sendDelegated(_s, FEE, _sig);
  }
}

/// Base: SwapRouter02, QuoterV2, WETH and the WETH/USDC 0.05% pool, as test/BuyFork.t.sol
contract SellForkBaseTest is SellForkBase {
  function _poolManager() internal pure virtual override returns (address) {
    return 0x498581fF718922c3f8e6A244956aF099B2652b2b;
  }

  function _chain() internal pure override returns (string memory, uint256) {
    return ('base', 53_440_000);
  }

  function _route() internal pure virtual override returns (address, address, address, address, uint24) {
    return (
      0x2626664c2603336E57B271c5C0b26F421741e481,
      0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a,
      0x4200000000000000000000000000000000000006,
      0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, // USDC
      500
    );
  }
}

/// Robinhood Chain: Uniswap v3's SwapRouter02, QuoterV2, WETH and the WETH/USDG 0.01% pool, as test/BuyFork.t.sol
contract SellForkRobinhoodTest is SellForkBase {
  function _poolManager() internal pure override returns (address) {
    return 0x8366a39CC670B4001A1121B8F6A443A643e40951;
  }

  function _chain() internal pure override returns (string memory, uint256) {
    return ('robinhood', 104_675_000);
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

/// Base Sepolia's pins (card evm-venues-pin) on the Base fork, so the kit's sell is its real one for "base-sepolia",
/// with no pin of the test's own: the chain id is Base Sepolia's; the pool and the sell delegate are built at the
/// addresses packages/kit/src/trade/evm/buy-unpinned.ts pins (each constructor runs where its code then lives, so the
/// pool's SCOPE is the one Base Sepolia's pool has); and Base Sepolia's SwapRouter02 address, the kit's only router there,
/// holds this fork's SwapRouter02 code. scripts/live-checks/evm-venues-pin.mjs reads the pins' code on Base Sepolia.
contract SellForkBaseSepoliaPinsTest is SellForkBaseTest {
  address internal constant PIN_POOL = 0xB239A38Af69B68E6C5C305df64985F283b5d5Fe5;
  address internal constant PIN_DELEGATE = 0xfa1442419b6984b8e3aA8933C690f80f063B6ADf;
  address internal constant PIN_ROUTER = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4;

  function _route() internal pure override returns (address, address, address, address, uint24) {
    (, address _quoter, address _weth, address _token, uint24 _fee) = super._route();
    return (PIN_ROUTER, _quoter, _weth, _token, _fee);
  }

  function _kitKey() internal pure override returns (string memory) {
    return 'base-sepolia';
  }

  /// Base Sepolia's v4 PoolManager (scripts/live-checks/pool-evm-deploy.mjs CHAINS)
  function _poolManager() internal pure override returns (address) {
    return 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;
  }

  function _deploy(address _weth) internal override {
    vm.chainId(84_532);
    vm.etch(PIN_ROUTER, address(0x2626664c2603336E57B271c5C0b26F421741e481).code);
    _deployAt(PIN_POOL, abi.encodePacked(type(PrivacyPoolSimple).creationCode, abi.encode(address(new WithdrawalVerifier()))));
    _deployAt(PIN_DELEGATE, abi.encodePacked(type(SellDelegate).creationCode, abi.encode(_weth, _poolManager())));
    pool = PrivacyPoolSimple(PIN_POOL);
    delegate = SellDelegate(payable(PIN_DELEGATE));
    assertEq(pool.SCOPE(), uint256(keccak256(abi.encodePacked(PIN_POOL, uint256(84_532), pool.ASSET()))) % Constants.SNARK_SCALAR_FIELD);
  }

  /// The contract `_init` makes, made at `_at`: its constructor runs there, then its runtime is the code there
  function _deployAt(address _at, bytes memory _init) internal {
    vm.etch(_at, _init);
    (bool _ok, bytes memory _runtime) = _at.call('');
    assertTrue(_ok, 'the constructor ran');
    vm.etch(_at, _runtime);
  }
}
