// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

// Card evm-selldelegate-exact-debit: a token that takes more from W than the amount W signed, but only on chain, where
// the device's eth_call probe cannot see it (review low L1 of evm-sell-device-quote, 4 Nov 11:18Z): an extra debit only
// in transferFrom (the sender side, which a v3 pool's balance check passes while W holds more than it sells), only
// toward the pool, and only inside the v4 PoolManager's unlock. Each lands before the card with W losing the amount
// plus the extra; the delegate now reverts each one unless W's balance fell by exactly the amount, on v3 and v4.

import {PrivacyPoolSimple} from '../src/PrivacyPoolSimple.sol';
import {SellDelegate, IWETH} from '../src/SellDelegate.sol';
import {IPoolManager, PathKey} from '../src/adapters/UniswapV4Adapter.sol';
import {WithdrawalVerifier} from '../src/verifiers/WithdrawalVerifier.sol';

import {stdError} from 'forge-std/StdError.sol';

import {SellBase, MockToken, MockWETH, MockRouter} from './Sell.t.sol';
import {SellV4Base} from './SellV4.t.sol';
import {GiveBackRouter} from './HostileSell.t.sol';

interface IExttload {
  function exttload(bytes32 _slot) external view returns (bytes32);
}

/// An ERC-20 that debits its sender `extra` more than it moves (burnt), in one of three modes: FROM, only in
/// transferFrom; TO_POOL, only when the tokens go to `to`; IN_UNLOCK, only while the v4 PoolManager `pm` is unlocked
contract ExtraDebitToken {
  uint256 public constant FROM = 1;
  uint256 public constant TO_POOL = 2;
  uint256 public constant IN_UNLOCK = 3;
  /// v4-core Lock.sol's IS_UNLOCKED_SLOT: keccak256("Unlocked") - 1
  bytes32 internal constant IS_UNLOCKED_SLOT = 0xc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab23;

  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;
  uint256 public mode;
  uint256 public extra;
  address public to;
  address public pm;

  function set(uint256 _mode, uint256 _extra, address _to, address _pm) external {
    (mode, extra, to, pm) = (_mode, _extra, _to, _pm);
  }

  function mint(address _to, uint256 _v) external {
    balanceOf[_to] += _v;
  }

  function approve(address _spender, uint256 _v) external returns (bool) {
    allowance[msg.sender][_spender] = _v;
    return true;
  }

  function transfer(address _to, uint256 _v) external returns (bool) {
    _move(msg.sender, _to, _v, false);
    return true;
  }

  function transferFrom(address _from, address _to, uint256 _v) external returns (bool) {
    allowance[_from][msg.sender] -= _v;
    _move(_from, _to, _v, true);
    return true;
  }

  function _move(address _from, address _to, uint256 _v, bool _fromCall) internal {
    balanceOf[_from] -= _v + _extraOn(_to, _fromCall);
    balanceOf[_to] += _v;
  }

  function _extraOn(address _to, bool _fromCall) internal view returns (uint256) {
    if (mode == FROM) return _fromCall ? extra : 0;
    if (mode == TO_POOL) return _to == to ? extra : 0;
    if (mode == IN_UNLOCK) return IExttload(pm).exttload(IS_UNLOCKED_SLOT) != bytes32(0) ? extra : 0;
    return 0;
  }
}

/// The v3 path: the delegate approves the router exactly the amount and the router pulls it with transferFrom
contract ExactDebitV3Test is SellBase {
  bytes4 internal constant DEBIT_NOT_EXACT = bytes4(keccak256('DebitNotExact()'));
  uint256 internal constant AMOUNT = 1000e6;
  uint256 internal constant EXTRA = 400e6;
  uint256 internal constant OUT = 0.4 ether;
  uint256 internal constant FEE = 0.002 ether;

  ExtraDebitToken internal token;
  MockWETH internal weth;
  MockRouter internal router;

  function setUp() public {
    _prague();
    _deployPoseidon();
    vm.warp(1_900_000_000);
    pool = new PrivacyPoolSimple(address(new WithdrawalVerifier()));
    token = new ExtraDebitToken();
    weth = new MockWETH();
    router = new MockRouter(weth);
    vm.deal(address(router), 100 ether);
    delegate = new SellDelegate(IWETH(address(weth)), IPoolManager(address(0)));
    _setUpW();
    vm.signAndAttachDelegation(address(delegate), W_KEY);
    // W holds more than it sells, so an extra debit has something to take
    token.mint(W, AMOUNT * 10);
  }

  function _sell() internal view returns (SellDelegate.Sell memory) {
    return SellDelegate.Sell({
      token: address(token),
      amount: AMOUNT,
      target: address(router),
      data: abi.encodeCall(MockRouter.swap, (MockToken(address(token)), AMOUNT, OUT, false, W)),
      minOut: OUT,
      pool: address(pool),
      precommitment: 0x1234,
      feeCap: FEE,
      deadline: block.timestamp + 60,
      nonce: 0
    });
  }

  /// The sell reverts DebitNotExact and changes nothing: W keeps every token, the pool gets nothing, the nonce stays
  function _refused() internal {
    SellDelegate.Sell memory _s = _sell();
    bytes memory _sig = _signed(_s);
    uint256 _poolBefore = address(pool).balance;
    vm.expectRevert(DEBIT_NOT_EXACT);
    vm.prank(SENDER);
    SellDelegate(payable(W)).sell(_s, FEE, _sig);
    assertEq(token.balanceOf(W), AMOUNT * 10, 'W keeps every token');
    assertEq(address(pool).balance, _poolBefore, 'nothing deposited');
    assertEq(SellDelegate(payable(W)).nonce(), 0, 'the nonce is not used');
  }

  /// The same token taking no extra: the sell lands and W pays exactly the amount (the control)
  function test_aTokenTakingNoExtraLands() public {
    token.set(token.FROM(), 0, address(0), address(0));
    SellDelegate.Sell memory _s = _sell();
    bytes memory _sig = _signed(_s);
    vm.prank(SENDER);
    SellDelegate(payable(W)).sell(_s, FEE, _sig);
    assertEq(token.balanceOf(W), AMOUNT * 9, 'W paid exactly the amount');
  }

  /// An extra debit only in transferFrom, from W's side, while the router receives exactly the amount: refused
  function test_anExtraDebitOnlyInTransferFromIsRefused() public {
    token.set(token.FROM(), EXTRA, address(0), address(0));
    _refused();
  }

  /// An extra debit only when the tokens go to the pool the sell pays (here the router): refused
  function test_anExtraDebitOnlyTowardThePoolIsRefused() public {
    token.set(token.TO_POOL(), EXTRA, address(router), address(0));
    _refused();
  }
}

/// The v4 path: W settles the token with its own transfer to the PoolManager, inside the unlock
contract ExactDebitV4Test is SellV4Base {
  bytes4 internal constant DEBIT_NOT_EXACT = bytes4(keccak256('DebitNotExact()'));
  address internal constant XT = 0xf555555555555555555555555555555555555555; // the extra-debit token, above ETH
  uint256 internal constant EXTRA = 0.1 ether;

  function _token(uint256 _mode, uint256 _extra) internal returns (ExtraDebitToken _t) {
    deployCodeTo('ExactDebit.t.sol:ExtraDebitToken', XT);
    _t = ExtraDebitToken(XT);
    _t.set(_mode, _extra, PM_ADDR, PM_ADDR);
    _t.mint(W, AMOUNT * 10);
  }

  /// The same token taking no extra: the v4 sell lands, W pays exactly the amount (the control)
  function test_v4ATokenTakingNoExtraLands() public {
    _token(3, 0);
    _lands(XT, _deep(XT, address(0), address(0)), 'sell, v4, the extra-debit token at 0');
  }

  /// An extra debit only while the PoolManager is unlocked: refused. Outside the unlock the token takes no extra (the
  /// same transfer from W, as an eth_call probe of it would see)
  function test_v4AnExtraDebitOnlyInsideTheUnlockIsRefused() public {
    ExtraDebitToken _t = _token(3, EXTRA);
    PathKey[] memory _p = _deep(XT, address(0), address(0));
    uint256 _snap = vm.snapshotState();
    vm.prank(W);
    _t.transfer(address(0xdead), 1);
    assertEq(_t.balanceOf(W), AMOUNT * 10 - 1, 'outside the unlock: no extra');
    vm.revertToState(_snap);
    _refused(_v4Sell(XT, _p, 1, 0), DEBIT_NOT_EXACT);
  }

  /// An extra debit only on a transfer to the PoolManager: refused
  function test_v4AnExtraDebitOnlyTowardThePoolIsRefused() public {
    _token(2, EXTRA);
    _refused(_v4Sell(XT, _deep(XT, address(0), address(0)), 1, 0), DEBIT_NOT_EXACT);
  }
}

/// A balance that rose: a target that pulls the amount and gives back twice it leaves W holding more than before, so
/// the check's subtraction underflows (Panic 0x11) and the whole sell reverts with W keeping every token
contract ExactDebitRoseTest is SellBase {
  uint256 internal constant AMOUNT = 1000e6;
  uint256 internal constant OUT = 0.4 ether;
  uint256 internal constant FEE = 0.002 ether;

  MockToken internal token;
  MockWETH internal weth;

  function setUp() public {
    _prague();
    _deployPoseidon();
    vm.warp(1_900_000_000);
    pool = new PrivacyPoolSimple(address(new WithdrawalVerifier()));
    token = new MockToken();
    weth = new MockWETH();
    delegate = new SellDelegate(IWETH(address(weth)), IPoolManager(address(0)));
    _setUpW();
    vm.signAndAttachDelegation(address(delegate), W_KEY);
    token.mint(W, AMOUNT * 10);
  }

  function test_aBalanceThatRoseIsAnUnderflow() public {
    GiveBackRouter _r = new GiveBackRouter(weth);
    vm.deal(address(_r), 1 ether);
    token.mint(address(_r), AMOUNT * 2);
    SellDelegate.Sell memory _s = SellDelegate.Sell({
      token: address(token),
      amount: AMOUNT,
      target: address(_r),
      data: abi.encodeCall(GiveBackRouter.swap, (token, AMOUNT, AMOUNT * 2, OUT, W)),
      minOut: OUT,
      pool: address(pool),
      precommitment: 0x1234,
      feeCap: FEE,
      deadline: block.timestamp + 60,
      nonce: 0
    });
    bytes memory _sig = _signed(_s);
    vm.expectRevert(stdError.arithmeticError);
    vm.prank(SENDER);
    SellDelegate(payable(W)).sell(_s, FEE, _sig);
    assertEq(token.balanceOf(W), AMOUNT * 10, 'W keeps every token');
    assertEq(SellDelegate(payable(W)).nonce(), 0, 'the nonce is not used');
  }
}
