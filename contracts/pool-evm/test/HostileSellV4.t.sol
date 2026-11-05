// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

// Hostile cases against the v4 sell, from the review of e9f6ff9 (card evm-sell-v4): a PoolManager that calls back
// with another payload or twice, a sender that tampers with the signed route, an input-taking hook on a thin pool, and
// the reviewer's probes. Runs on the local chain of test/SellV4.t.sol (Base's PoolManager code etched, no RPC).

import {SellDelegate} from '../src/SellDelegate.sol';
import {IPoolManager, PoolKey, SwapParams, PathKey} from '../src/adapters/UniswapV4Adapter.sol';
import {IERC20Balance} from 'interfaces/IBuyAdapter.sol';

import {ERC20Mock} from './BuyV3.t.sol';
import {FeeHook} from './BuyV4Fork.t.sol';
import {HostileHook, IPMx} from './HostileV4.t.sol';
import {SellV4Base, IUnlockCallback, IWETH9Sell, IAllowance} from './SellV4.t.sol';

/// A wrong pin: a "PoolManager" that calls W back with a payload of its choosing (ALTER), or with W's own payload twice
/// in one unlock (TWICE); its swap fills exactly what it is asked and pays 0.01 ETH, its take pays ETH
contract MockPM {
  uint256 public constant ALTER = 1;
  uint256 public constant TWICE = 2;
  uint256 public mode;
  bytes public altered;

  function set(uint256 _mode, bytes calldata _altered) external {
    (mode, altered) = (_mode, _altered);
  }

  function unlock(bytes calldata _data) external returns (bytes memory) {
    if (mode == ALTER) return IUnlockCallback(msg.sender).unlockCallback(altered);
    IUnlockCallback(msg.sender).unlockCallback(_data);
    return IUnlockCallback(msg.sender).unlockCallback(_data);
  }

  function swap(PoolKey memory, SwapParams memory _sp, bytes calldata) external pure returns (int256) {
    int128 _paid = int128(_sp.amountSpecified);
    int128 _gave = 0.01 ether;
    return (int256(_gave) << 128) | int256(uint256(uint128(_paid)));
  }

  function sync(address) external {}

  function settle() external payable returns (uint256) {
    return 0;
  }

  function take(address, address _to, uint256 _a) external {
    payable(_to).transfer(_a);
  }

  receive() external payable {}
}

/// FeeHook with a receive, so it can take its cut of a native-asset output
contract PayableFeeHook is FeeHook {
  constructor(IPoolManager _pm) FeeHook(_pm) {}

  receive() external payable {}
}

/// A sender that calls W's sell from inside its own unlock of the PoolManager (review probe)
contract UnlockedSender {
  function go(IPoolManager _pm, address _w, bytes calldata _call) external {
    _pm.unlock(abi.encode(_w, _call));
  }

  function unlockCallback(bytes calldata _raw) external returns (bytes memory) {
    (address _w, bytes memory _call) = abi.decode(_raw, (address, bytes));
    (bool _ok, bytes memory _ret) = _w.call(_call);
    if (!_ok) {
      assembly {
        revert(add(_ret, 0x20), mload(_ret))
      }
    }
    return '';
  }
}

/// A token whose transfer to the PoolManager settles for itself, then tries W's callback (review probe)
contract EvilToken {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;
  address public pm;
  address public w;
  uint256 public reentryOk;

  function setUp(address _pm, address _w) external {
    (pm, w) = (_pm, _w);
  }

  function mint(address _to, uint256 _a) external {
    balanceOf[_to] += _a;
  }

  function transfer(address _to, uint256 _a) external returns (bool) {
    balanceOf[msg.sender] -= _a;
    balanceOf[_to] += _a;
    if (_to == pm && w != address(0)) {
      IPoolManager(pm).settle(); // credits this token, not W
      PathKey[] memory _p = new PathKey[](1);
      try IUnlockCallback(w).unlockCallback(abi.encode(address(this), _a, abi.encode(_p))) {
        ++reentryOk;
      } catch {}
    }
    return true;
  }
}

contract HostileSellV4Test is SellV4Base {
  address internal constant HH = address(uint160(0xBAD) << 144 | 0xCC); // HostileHook's flags
  address internal constant PFH = address(uint160(0xF00E) << 144 | 0x44); // PayableFeeHook: afterSwap + return delta
  address internal constant ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
  bytes4 internal constant INVALID_SIGNATURE = bytes4(keccak256('InvalidSignature()'));
  bytes4 internal constant ALREADY_UNLOCKED = bytes4(keccak256('AlreadyUnlocked()'));

  /// W delegated to a delegate pinned to `_pm` (a wrong pin), holding 1000 of Y besides its T
  function _wrongPin(MockPM _pm) internal {
    vm.deal(address(_pm), 1 ether);
    SellDelegate _d = SellDelegate(payable(deployCode('SellDelegate.sol:SellDelegate', abi.encode(WETH, address(_pm)))));
    vm.signAndAttachDelegation(address(_d), W_KEY);
    ERC20Mock(Y).mint(W, 1000 ether);
  }

  function _mockSell(MockPM _pm, uint256 _amount) internal view returns (SellDelegate.Sell memory) {
    PathKey[] memory _p = new PathKey[](1);
    return SellDelegate.Sell({
      token: T,
      amount: _amount,
      target: address(_pm),
      data: abi.encode(_p),
      minOut: 1,
      pool: address(pool),
      precommitment: PRE,
      feeCap: FEE,
      deadline: block.timestamp + 60,
      nonce: 0
    });
  }

  /// A PoolManager that calls back with a payload other than the one W's sell passed (another token, another amount,
  /// another route) is refused: W signed "sell 1 wei of T" and keeps all its Y
  function test_aCallbackWithAnotherPayloadIsRefused() public {
    MockPM _pm = new MockPM();
    _wrongPin(_pm);
    PathKey[] memory _p = new PathKey[](1);
    PathKey[] memory _other = new PathKey[](1);
    _other[0].fee = 1;
    bytes[3] memory _payloads =
      [abi.encode(Y, uint256(1000 ether), abi.encode(_p)), abi.encode(T, uint256(2), abi.encode(_p)), abi.encode(T, uint256(1), abi.encode(_other))];
    for (uint256 _i; _i < 3; ++_i) {
      _pm.set(_pm.ALTER(), _payloads[_i]);
      SellDelegate.Sell memory _s = _mockSell(_pm, 1);
      bytes memory _sig = _signed(_s);
      vm.expectRevert(NOT_IN_SELL);
      vm.prank(SENDER);
      SellDelegate(payable(W)).sell(_s, 0, _sig);
    }
    assertEq(IERC20Balance(Y).balanceOf(W), 1000 ether, 'W keeps its Y');
    assertEq(IERC20Balance(T).balanceOf(W), AMOUNT * 10, 'and its T');
  }

  /// The same PoolManager calling W's own payload back twice in one unlock: the second is refused (the flag is
  /// one-shot), so the sell reverts and W pays nothing twice
  function test_aSecondCallbackInOneUnlockIsRefused() public {
    MockPM _pm = new MockPM();
    _wrongPin(_pm);
    _pm.set(_pm.TWICE(), '');
    SellDelegate.Sell memory _s = _mockSell(_pm, 1 ether);
    bytes memory _sig = _signed(_s);
    vm.expectRevert(NOT_IN_SELL);
    vm.prank(SENDER);
    SellDelegate(payable(W)).sell(_s, 0, _sig);
    assertEq(IERC20Balance(T).balanceOf(W), AMOUNT * 10);
  }

  /// Every hop field, the token, the amount and the target changed after W signed: refused
  function test_aRouteChangedAfterSigningIsRefused() public {
    PathKey[] memory _p = _deep(T, address(0), address(0));
    SellDelegate.Sell memory _good = _v4Sell(T, _p, 1, 0);
    bytes memory _sig = _signed(_good);
    for (uint256 _i; _i < 8; ++_i) {
      SellDelegate.Sell memory _s = _v4Sell(T, _p, 1, 0);
      PathKey[] memory _q = _deep2(_p);
      if (_i == 0) _q[0].intermediateCurrency = WETH;
      if (_i == 1) _q[0].fee = 3000;
      if (_i == 2) _q[0].tickSpacing = 60;
      if (_i == 3) _q[0].hooks = PFH;
      if (_i == 4) _q[0].hookData = hex'01';
      _s.data = abi.encode(_q);
      if (_i == 5) _s.token = Y;
      if (_i == 6) _s.amount = AMOUNT - 1;
      if (_i == 7) _s.target = ROUTER;
      vm.expectRevert(INVALID_SIGNATURE);
      vm.prank(SENDER);
      SellDelegate(payable(W)).sell(_s, FEE, _sig);
    }
    _send(_good);
    assertEq(SellDelegate(payable(W)).nonce(), 1, 'the signed sell still lands');
  }

  function _deep2(PathKey[] memory _p) internal pure returns (PathKey[] memory _q) {
    _q = new PathKey[](_p.length);
    for (uint256 _i; _i < _p.length; ++_i) {
      _q[_i] = PathKey(_p[_i].intermediateCurrency, _p[_i].fee, _p[_i].tickSpacing, _p[_i].hooks, _p[_i].hookData);
    }
  }

  /// Any amount: W pays exactly the amount, the leaf holds all the ETH (fee 0), W keeps no ETH or WETH
  function testFuzz_wPaysExactlyTheAmountAndKeepsNoEther(uint256 _amount, bool _toWeth) public {
    // from 0.001 of T (its proceeds clear the pool's MIN_DEPOSIT, 0.0001 ETH) to all W holds
    _amount = bound(_amount, 1e15, AMOUNT * 10);
    PathKey[] memory _p = _deep(T, _toWeth ? WETH : address(0), address(0));
    SellDelegate.Sell memory _s = _v4Sell(T, _p, 1, 0);
    _s.amount = _amount;
    bytes memory _sig = _signed(_s);
    uint256 _poolBefore = address(pool).balance;
    vm.recordLogs();
    vm.prank(SENDER);
    SellDelegate(payable(W)).sell(_s, 0, _sig);
    (,, uint256 _value,) = _deposited(vm.getRecordedLogs());
    assertEq(IERC20Balance(T).balanceOf(W), AMOUNT * 10 - _amount, 'W paid exactly the amount');
    assertEq(address(pool).balance - _poolBefore, _value, 'the pool holds what the leaf says');
    assertGt(_value, 0);
    assertEq(W.balance, 0, 'W keeps no ether');
    assertEq(IWETH9Sell(WETH).balanceOf(W), 0, 'nor WETH');
    assertEq(IAllowance(T).allowance(W, PM_ADDR), 0, 'no approval');
  }

  /// A hooked pool paying the native asset, its hook keeping 1% of it: lands
  function test_aHookedPoolPayingEtherLands() public {
    deployCodeTo('HostileSellV4.t.sol:PayableFeeHook', abi.encode(PM_ADDR), PFH);
    FeeHook(PFH).setBps(100);
    _lands(T, _deep(T, address(0), PFH), 'sell, v4 one hop to ETH through a hook, depth 0');
    assertGt(PFH.balance, 0, 'the hook kept its cut in ether');
  }

  /// T to Y, then Y to WETH (Y is currency0 of that pool, so the second hop is zero for one)
  function test_twoHopsEndingInWethLand() public {
    PathKey[] memory _p = new PathKey[](2);
    _p[0] = _plant(Y, T, address(0), 1e22, 60, 6000);
    _p[0].intermediateCurrency = Y;
    _p[1] = _plant(Y, WETH, address(0), 1e22, -6000, -60);
    _p[1].intermediateCurrency = WETH;
    _lands(T, _p, 'sell, v4 two hops to WETH, depth 0');
    assertEq(IERC20Balance(Y).balanceOf(W), 0);
  }

  /// A hook that takes a tenth of the INPUT before the swap, on a pool too thin for the rest: PartialFill, W keeps
  /// every token
  function test_anInputTakingHookOnAThinPoolIsRefused() public {
    deployCodeTo('HostileV4.t.sol:HostileHook', abi.encode(PM_ADDR), HH);
    PathKey[] memory _p = new PathKey[](1);
    _p[0] = _plant(address(0), T, HH, 1e9, 60, 600);
    HostileHook(payable(HH)).set(1, AMOUNT / 10, address(0), T, address(pool), WETH);
    ERC20Mock(T).mint(PM_ADDR, AMOUNT); // other users' T in the PoolManager, which the hook takes from before W settles
    _refused(_v4Sell(T, _p, 1, 0), PARTIAL_FILL);
  }

  /// The same hook on a deep pool: its tenth is a fee, W pays exactly the amount and the leaf holds what is left
  function test_anInputTakingHookOnADeepPoolLands() public {
    deployCodeTo('HostileV4.t.sol:HostileHook', abi.encode(PM_ADDR), HH);
    PathKey[] memory _p = new PathKey[](1);
    _p[0] = _plant(address(0), T, HH, 1e22, 60, 6000);
    HostileHook(payable(HH)).set(1, AMOUNT / 10, address(0), T, address(pool), WETH);
    ERC20Mock(T).mint(PM_ADDR, AMOUNT); // other users' T in the PoolManager, which the hook takes from before W settles
    _lands(T, _p, 'sell, v4 through an input-fee hook, depth 0');
    assertEq(IERC20Balance(T).balanceOf(HH), AMOUNT / 10, 'the hook kept a tenth of the input');
  }

  // ----- the reviewer's probes (review of e9f6ff9) -----

  function test_probe_sellInsideAnUnlockedPoolManagerIsRefused() public {
    PathKey[] memory _p = _deep(T, address(0), address(0));
    SellDelegate.Sell memory _s = _v4Sell(T, _p, 1, 0);
    UnlockedSender _u = new UnlockedSender();
    bytes memory _call = abi.encodeCall(SellDelegate.sell, (_s, 0, _signed(_s)));
    vm.expectRevert(ALREADY_UNLOCKED);
    _u.go(pm, W, _call);
    assertEq(IERC20Balance(T).balanceOf(W), AMOUNT * 10);
  }

  function test_probe_aTokenSettlingForItselfIsRefused() public {
    address _e = 0xf555555555555555555555555555555555555555;
    deployCodeTo('HostileSellV4.t.sol:EvilToken', _e);
    EvilToken(_e).mint(W, AMOUNT);
    PathKey[] memory _p = _deep(_e, address(0), address(0));
    EvilToken(_e).setUp(PM_ADDR, W);
    _refused(_v4Sell(_e, _p, 1, 0), CURRENCY_NOT_SETTLED);
  }

  /// T to ETH, ETH back to T, T to ETH again (one pool): W still pays exactly the amount
  function test_probe_aRouteRevisitingTheTokenPaysExactlyTheAmount() public {
    PathKey[] memory _one = _deep(T, address(0), address(0));
    PathKey[] memory _p = new PathKey[](3);
    PathKey memory _k = _one[0];
    _p[0] = PathKey(address(0), _k.fee, _k.tickSpacing, _k.hooks, '');
    _p[1] = PathKey(T, _k.fee, _k.tickSpacing, _k.hooks, '');
    _p[2] = PathKey(address(0), _k.fee, _k.tickSpacing, _k.hooks, '');
    _lands(T, _p, 'probe: T->ETH->T->ETH');
  }

  /// The sender changes a hop's hookData after W signed: the signature no longer matches
  function test_probe_aChangedHopIsRefused() public {
    PathKey[] memory _p = _deep(T, address(0), address(0));
    SellDelegate.Sell memory _s = _v4Sell(T, _p, 1, 0);
    bytes memory _sig = _signed(_s);
    _p[0].hookData = hex'01';
    _s.data = abi.encode(_p);
    vm.expectRevert(INVALID_SIGNATURE);
    vm.prank(SENDER);
    SellDelegate(payable(W)).sell(_s, FEE, _sig);
  }

  /// The deploy with the old one-argument constructor fails (script/deploy.mjs must pass WETH and the PoolManager)
  function test_probe_oneConstructorArgReverts() public {
    bytes memory _code = abi.encodePacked(vm.getCode('SellDelegate.sol:SellDelegate'), abi.encode(WETH));
    address _a;
    assembly {
      _a := create(0, add(_code, 0x20), mload(_code))
    }
    assertEq(_a, address(0), 'the deploy with one argument fails');
  }
}
