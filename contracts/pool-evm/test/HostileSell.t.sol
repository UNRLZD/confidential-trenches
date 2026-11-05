// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

// Hostile tokens, routers, senders and delegates against the sell delegate, from the review of c2a8da2 (card
// pool-evm-sell): selling WETH, a fee over the gain, a target that gives tokens back, a token hook and a sender that
// call back into W, fee on transfer, a fee under the cap, a burnt precommitment, a pool revert, a caught revert, the
// nonce across delegations, an arbitrary signed call, and a module that guards with transient slot 0. Mock tokens and
// routers and the real pool on a local chain; no RPC. The review's two gas probes are not kept (NOTICE change 14 has
// the gas).

import {Vm} from 'forge-std/Vm.sol';
import {stdError} from 'forge-std/StdError.sol';

import {PrivacyPoolSimple} from '../src/PrivacyPoolSimple.sol';
import {SellDelegate, IWETH} from '../src/SellDelegate.sol';
import {IPoolManager} from '../src/adapters/UniswapV4Adapter.sol';
import {WithdrawalVerifier} from '../src/verifiers/WithdrawalVerifier.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {SellBase, MockToken, MockWETH, MockRouter, BaseToken} from './Sell.t.sol';

// ---------- hostile pieces ----------

/// Pulls `_pull` of the token, gives `_back` of it to W again, pays `_out` WETH to W
contract GiveBackRouter {
  MockWETH internal immutable WETH;

  constructor(MockWETH _weth) {
    WETH = _weth;
  }

  function swap(MockToken _token, uint256 _pull, uint256 _back, uint256 _out, address _to) external {
    _token.transferFrom(msg.sender, address(this), _pull);
    _token.transfer(msg.sender, _back);
    WETH.deposit{value: _out}();
    WETH.transfer(_to, _out);
  }
}

/// A router for WETH itself: pulls WETH from W and pays ETH (the "sell WETH" case)
contract WethSellRouter {
  MockWETH internal immutable WETH;

  constructor(MockWETH _weth) {
    WETH = _weth;
  }

  function swapWeth(uint256 _pull, uint256 _out) external {
    // MockWETH has no transferFrom: model it with a balance move the approval allowed
    HookWETH(payable(address(WETH))).transferFrom(msg.sender, address(this), _pull);
    (bool _ok,) = msg.sender.call{value: _out}('');
    require(_ok);
  }
}

/// WETH9 with approve/transferFrom (as the real WETH9 has)
contract HookWETH is MockWETH {
  mapping(address => mapping(address => uint256)) public allowance;

  function approve(address _s, uint256 _v) external returns (bool) {
    allowance[msg.sender][_s] = _v;
    return true;
  }

  function transferFrom(address _f, address _t, uint256 _v) external returns (bool) {
    allowance[_f][msg.sender] -= _v;
    balanceOf[_f] -= _v;
    balanceOf[_t] += _v;
    return true;
  }

  receive() external payable {}
}

/// ERC-777-like: transferFrom calls a hook on `from` (W) and on `to`, with whatever the test set
contract HookToken is BaseToken {
  bytes public hookCall;
  address public hookTarget;

  function approve(address _spender, uint256 _v) external returns (bool) {
    allowance[msg.sender][_spender] = _v;
    return true;
  }

  function setHook(address _t, bytes calldata _c) external {
    hookTarget = _t;
    hookCall = _c;
  }

  function transferFromHooked(address _from, address _to, uint256 _v) external returns (bool) {
    allowance[_from][msg.sender] -= _v;
    balanceOf[_from] -= _v;
    balanceOf[_to] += _v;
    if (hookTarget != address(0)) {
      (bool _ok, bytes memory _ret) = hookTarget.call(hookCall);
      if (!_ok) {
        assembly {
          revert(add(_ret, 0x20), mload(_ret))
        }
      }
    }
    return true;
  }
}

contract HookRouter {
  MockWETH internal immutable WETH;

  constructor(MockWETH _weth) {
    WETH = _weth;
  }

  function swap(HookToken _token, uint256 _pull, uint256 _out, address _to) external {
    _token.transferFromHooked(msg.sender, address(this), _pull);
    WETH.deposit{value: _out}();
    WETH.transfer(_to, _out);
  }
}

/// Fee on transfer: 1% burnt on every transferFrom
contract FotToken is BaseToken {
  function approve(address _spender, uint256 _v) external returns (bool) {
    allowance[msg.sender][_spender] = _v;
    return true;
  }

  function transferFromFot(address _from, address _to, uint256 _v) external returns (bool) {
    allowance[_from][msg.sender] -= _v;
    balanceOf[_from] -= _v;
    balanceOf[_to] += _v - _v / 100;
    return true;
  }
}

contract FotRouter {
  MockWETH internal immutable WETH;

  constructor(MockWETH _weth) {
    WETH = _weth;
  }

  function swap(FotToken _token, uint256 _pull, uint256 _out, address _to) external {
    _token.transferFromFot(msg.sender, address(this), _pull);
    WETH.deposit{value: _out}();
    WETH.transfer(_to, _out);
  }
}

/// A sender whose fee callback runs `call` on `to` (and swallows the result), then optionally reverts
contract HostileSender {
  address public to;
  bytes public cb;
  bool public lastOk;
  bytes public lastRet;
  uint256 public sendBack;

  function set(address _to, bytes calldata _cb, uint256 _sendBack) external {
    to = _to;
    cb = _cb;
    sendBack = _sendBack;
  }

  function send(SellDelegate _w, SellDelegate.Sell calldata _s, uint256 _fee, bytes calldata _sig) external returns (uint256) {
    return _w.sell(_s, _fee, _sig);
  }

  receive() external payable {
    if (to != address(0)) {
      (lastOk, lastRet) = to.call{value: sendBack}(cb);
    }
  }
}

/// Pays `price` in WETH for the whole pull: a market that moves
contract PriceRouter {
  MockWETH internal immutable WETH;
  uint256 public price;

  constructor(MockWETH _weth) {
    WETH = _weth;
  }

  function setPrice(uint256 _p) external {
    price = _p;
  }

  function swap(MockToken _token, uint256 _pull, address _to) external {
    _token.transferFrom(msg.sender, address(this), _pull);
    WETH.deposit{value: price}();
    WETH.transfer(_to, price);
  }
}

/// Wraps a sell in try/catch: the sell's revert is caught, the caller's frame goes on
contract Catcher {
  function tryOnce(SellDelegate _w, SellDelegate.Sell calldata _s, uint256 _fee, bytes calldata _sig) external returns (bool _ok) {
    try _w.sell(_s, _fee, _sig) {
      _ok = true;
    } catch {
      _ok = false;
    }
  }
}

/// Another delegate W might be given later: it writes slots 0..3 and transient slot 0, has nothing at blindfill.sell
contract OtherDelegate {
  uint256 public a;
  uint256 public b;

  function poke() external {
    a = 7;
    b = 8;
    assembly {
      tstore(0, 1)
    }
  }
}

/// A smart-account style delegate that guards with transient slot 0 and DELEGATECALLs the sell delegate as a module
/// (the review's mock, with a receive added: a smart account takes ether)
contract ModuleAccount {
  address public immutable SELL;

  constructor(address _sell) {
    SELL = _sell;
  }

  /// A smart account takes ether, as the sale's unwrap pays W in it
  receive() external payable {}

  function run(bytes calldata _call) external returns (bool _guardStillSet) {
    assembly {
      tstore(0, 1)
    }
    (bool _ok, bytes memory _ret) = SELL.delegatecall(_call);
    if (!_ok) {
      assembly {
        revert(add(_ret, 0x20), mload(_ret))
      }
    }
    assembly {
      _guardStillSet := tload(0)
    }
  }
}

// ---------- the tests ----------

contract HostileSellTest is SellBase {
  MockToken internal token;
  MockWETH internal weth;
  MockRouter internal router;

  uint256 internal constant AMOUNT = 1000e6;
  uint256 internal constant OUT = 0.4 ether;
  uint256 internal constant FEE = 0.002 ether;
  uint256 internal constant PRE = 0x1234;

  function setUp() public {
    _prague();
    _deployPoseidon();
    vm.warp(1_900_000_000);
    pool = new PrivacyPoolSimple(address(new WithdrawalVerifier()));
    token = new MockToken();
    weth = new MockWETH();
    router = new MockRouter(weth);
    vm.deal(address(router), 100 ether);
    delegate = new SellDelegate(IWETH(address(weth)), IPoolManager(address(0)));
    _setUpW();
    vm.signAndAttachDelegation(address(delegate), W_KEY);
    assertEq(SellDelegate(payable(W)).nonce(), 0);
    token.mint(W, AMOUNT * 10);
  }

  function _w() internal view returns (SellDelegate) {
    return SellDelegate(payable(W));
  }

  function _base(address _token, uint256 _amount, address _target, bytes memory _data, uint256 _minOut, uint256 _nonce)
    internal
    view
    returns (SellDelegate.Sell memory)
  {
    return SellDelegate.Sell({
      token: _token,
      amount: _amount,
      target: _target,
      data: _data,
      minOut: _minOut,
      pool: address(pool),
      precommitment: PRE + _nonce,
      feeCap: FEE,
      deadline: block.timestamp + 60,
      nonce: _nonce
    });
  }

  function _good(uint256 _nonce) internal view returns (SellDelegate.Sell memory) {
    return _base(address(token), AMOUNT, address(router), abi.encodeCall(MockRouter.swap, (token, AMOUNT, OUT, false, W)), OUT, _nonce);
  }

  function _send(SellDelegate.Sell memory _s, uint256 _fee, bytes memory _sig) internal returns (uint256) {
    vm.prank(SENDER);
    return _w().sell(_s, _fee, _sig);
  }

  // ---- 2. ETH accounting ----

  /// Selling WETH: W's WETH falls across the target call, so WETH.balanceOf(W) - _weth underflows: a Panic(0x11)
  /// revert, never a miscount. Same when the target is WETH.withdraw itself.
  function test_R_sellingWethIsAnUnderflowRevert() public {
    HookWETH _hw = new HookWETH();
    SellDelegate _d = new SellDelegate(IWETH(address(_hw)), IPoolManager(address(0)));
    vm.signAndAttachDelegation(address(_d), W_KEY);
    _w().nonce();
    vm.deal(address(this), 2 ether);
    _hw.deposit{value: 1 ether}();
    _hw.transfer(W, 1 ether);
    WethSellRouter _r = new WethSellRouter(MockWETH(address(_hw)));
    vm.deal(address(_r), 2 ether);
    SellDelegate.Sell memory _s =
      _base(address(_hw), 1 ether, address(_r), abi.encodeCall(WethSellRouter.swapWeth, (1 ether, 1 ether)), 1 ether, 0);
    bytes memory _sig = _signed(_s);
    vm.expectRevert(stdError.arithmeticError);
    _send(_s, 0, _sig);
    // target = WETH, data = withdraw, amount 0: the plain unwrap takes 1 WETH where W signed 0, so it is refused
    // before the WETH count (card evm-selldelegate-exact-debit: W's balance falls by exactly the amount)
    SellDelegate.Sell memory _u =
      _base(address(_hw), 0, address(_hw), abi.encodeCall(IWETH.withdraw, (1 ether)), 1 ether, 0);
    _sig = _signed(_u);
    vm.expectRevert(bytes4(keccak256('DebitNotExact()')));
    _send(_u, 0, _sig);
    assertEq(_hw.balanceOf(W), 1 ether, 'W keeps its WETH');
    assertEq(W.balance, 0);
  }

  /// A fee over the sale's gain is never paid from W's own ether: the transfer happens, then _gained - _fee
  /// underflows and the whole sell reverts, so W's prior ether stays
  function test_R_aFeeOverTheGainCannotTakeWsPriorEther() public {
    vm.deal(W, 1 ether);
    SellDelegate.Sell memory _s =
      _base(address(token), AMOUNT, address(router), abi.encodeCall(MockRouter.swap, (token, AMOUNT, 0.001 ether, false, W)), 0.001 ether, 0);
    _s.feeCap = 1 ether; // a cap above minOut (a device bug)
    bytes memory _sig = _signed(_s);
    vm.expectRevert(stdError.arithmeticError);
    _send(_s, 1 ether, _sig);
    assertEq(W.balance, 1 ether, 'W keeps its ether');
    assertEq(SENDER.balance, 0);
    assertEq(_w().nonce(), 0);
  }

  /// fee == gain: the deposit is 0, under the pool's minimum, and the sell reverts
  function test_R_aFeeEqualToTheGainReverts() public {
    SellDelegate.Sell memory _s = _good(0);
    _s.feeCap = OUT;
    bytes memory _sig = _signed(_s);
    vm.expectRevert(IPrivacyPool.MinimumDepositAmount.selector);
    _send(_s, OUT, _sig);
  }

  /// A target that takes the whole approval and gives part of the token back: the approval ends at 0, but W's balance
  /// fell by less than the amount it signed, so the sell is refused (card evm-selldelegate-exact-debit: exactly the
  /// amount, never more and never less) and W keeps every token
  function test_R_aTargetGivingTokenBackIsRefused() public {
    GiveBackRouter _r = new GiveBackRouter(weth);
    vm.deal(address(_r), 1 ether);
    SellDelegate.Sell memory _s =
      _base(address(token), AMOUNT, address(_r), abi.encodeCall(GiveBackRouter.swap, (token, AMOUNT, AMOUNT / 2, OUT, W)), OUT, 0);
    bytes memory _sig = _signed(_s);
    vm.expectRevert(bytes4(keccak256('DebitNotExact()')));
    _send(_s, FEE, _sig);
    assertEq(token.balanceOf(W), AMOUNT * 10, 'W keeps every token');
    assertEq(_w().nonce(), 0);
  }

  /// The device's sell sim (card evm-quote-exec-sim) signed and sent for real: pool = EVM_SELL_SIM, the low 20 bytes
  /// of keccak256("blindfill.sell.sim.v1"), which has no code, and deadline = the agreed block's timestamp. On a chain
  /// where several blocks share one timestamp (Robinhood) the deadline alone does not stop it; the deposit into the
  /// codeless address does: its empty return cannot be decoded, the whole sell reverts, W keeps every token and the
  /// nonce is not used
  function test_R_aSimSellAtTheBlockTimestampReverts() public {
    address _sim = address(uint160(uint256(keccak256('blindfill.sell.sim.v1'))));
    assertEq(_sim.code.length, 0, 'the sim pool has no code');
    SellDelegate.Sell memory _s = _good(0);
    _s.pool = _sim;
    _s.deadline = block.timestamp;
    bytes memory _sig = _signed(_s);
    vm.expectRevert();
    _send(_s, FEE, _sig);
    assertEq(token.balanceOf(W), AMOUNT * 10, 'W keeps every token');
    assertEq(_w().nonce(), 0, 'the nonce is not used');
  }

  /// An ERC-777-style hook on transferFrom that calls back into W with another signed sell: Reentrancy
  function test_R_aTokenHookCannotReenterW() public {
    HookToken _t = new HookToken();
    _t.mint(W, AMOUNT * 2);
    HookRouter _r = new HookRouter(weth);
    vm.deal(address(_r), 2 ether);
    SellDelegate.Sell memory _s1 =
      _base(address(_t), AMOUNT, address(_r), abi.encodeCall(HookRouter.swap, (_t, AMOUNT, OUT, W)), OUT, 1);
    _t.setHook(W, abi.encodeCall(SellDelegate.sell, (_s1, 0, _signed(_s1))));
    SellDelegate.Sell memory _s0 =
      _base(address(_t), AMOUNT, address(_r), abi.encodeCall(HookRouter.swap, (_t, AMOUNT, OUT, W)), OUT, 0);
    bytes memory _sig = _signed(_s0);
    vm.expectRevert(SellDelegate.Reentrancy.selector);
    _send(_s0, FEE, _sig);
    // a hook that calls W with any other data hits no fallback: refused
    _t.setHook(W, hex'deadbeef');
    vm.expectRevert();
    _send(_s0, FEE, _sig);
    // a hook that only sends W ether is a gift: counted as gain, deposited for W
    _t.setHook(address(0), '');
    _send(_s0, FEE, _sig);
    assertEq(_t.allowance(W, address(_r)), 0);
  }

  /// Fee on transfer: the router's pull spends the whole approval, so the sell lands
  function test_R_aFeeOnTransferTokenSells() public {
    FotToken _t = new FotToken();
    _t.mint(W, AMOUNT);
    FotRouter _r = new FotRouter(weth);
    vm.deal(address(_r), 1 ether);
    SellDelegate.Sell memory _s =
      _base(address(_t), AMOUNT, address(_r), abi.encodeCall(FotRouter.swap, (_t, AMOUNT, OUT, W)), OUT, 0);
    _send(_s, FEE, _signed(_s));
    assertEq(_t.balanceOf(W), 0);
    assertEq(_t.allowance(W, address(_r)), 0);
  }

  /// A fee under the cap: the sender is paid exactly the fee it names, the deposit is the gain less that fee, and W's
  /// own ether is untouched. No card test pays 0 < fee < feeCap, so `{value: _fee}` -> `{value: _sell.feeCap}` survives
  /// the card's suite while it would pay the cap and fund the deposit from W's prior ether.
  function test_R_theSenderGetsTheFeeItNamesNotTheCap() public {
    vm.deal(W, 1 ether);
    SellDelegate.Sell memory _s = _good(0);
    vm.recordLogs();
    _send(_s, FEE / 2, _signed(_s));
    (,, uint256 _value,) = _deposited(vm.getRecordedLogs());
    assertEq(SENDER.balance, FEE / 2, 'the fee named, not the cap');
    assertEq(_value, OUT - FEE / 2, 'the gain less that fee');
    assertEq(W.balance, 1 ether, "W's prior ether stays");
  }

  // ---- 5. the fee call to msg.sender ----

  /// A contract sender's fee callback tries to re-enter W with another signed sell: refused (and swallowed by the
  /// sender), the outer sell lands, only one nonce is used
  function test_R_aSenderCannotReenterFromTheFeeCall() public {
    HostileSender _h = new HostileSender();
    SellDelegate.Sell memory _s1 = _good(1);
    _h.set(W, abi.encodeCall(SellDelegate.sell, (_s1, 0, _signed(_s1))), 0);
    SellDelegate.Sell memory _s0 = _good(0);
    _h.send(_w(), _s0, FEE, _signed(_s0));
    assertFalse(_h.lastOk(), 're-entry refused');
    assertEq(bytes4(_h.lastRet()), SellDelegate.Reentrancy.selector);
    assertEq(_w().nonce(), 1, 'one sell');
    assertEq(address(_h).balance, FEE);
  }

  /// A contract sender's fee callback burns W's precommitment in the pool first: W's deposit then reverts, which
  /// reverts the whole sell, fee included. The sender only hurts itself.
  function test_R_aSenderBurningThePrecommitmentRevertsItsOwnFee() public {
    HostileSender _h = new HostileSender();
    vm.deal(address(_h), 1 ether);
    SellDelegate.Sell memory _s0 = _good(0);
    _h.set(address(pool), abi.encodeCall(IPrivacyPool.deposit, (0.0001 ether, _s0.precommitment)), 0.0001 ether);
    bytes memory _sig = _signed(_s0);
    vm.expectRevert(IPrivacyPool.PrecommitmentAlreadyUsed.selector);
    _h.send(_w(), _s0, FEE, _sig);
    assertEq(address(_h).balance, 1 ether, 'no fee kept');
    assertEq(_w().nonce(), 0);
  }

  // ---- 6. the deposit, the precommitment ----

  /// A third party who sees the signed sell (mempool, or a failed sell's calldata on chain) deposits MIN_DEPOSIT with
  /// W's precommitment first: that signed sell can never land (PrecommitmentAlreadyUsed). Nothing is lost, the nonce
  /// stays, W must sign again with a fresh precommitment. A liveness grief, at 0.0001 ETH + gas a try.
  function test_R_aThirdPartyCanBurnASignedSellsPrecommitment() public {
    SellDelegate.Sell memory _s = _good(0);
    bytes memory _sig = _signed(_s);
    address _griefer = address(0x6121EF);
    vm.deal(_griefer, 1 ether);
    vm.prank(_griefer);
    pool.deposit{value: 0.0001 ether}(0.0001 ether, _s.precommitment);
    vm.expectRevert(IPrivacyPool.PrecommitmentAlreadyUsed.selector);
    _send(_s, FEE, _sig);
    assertEq(_w().nonce(), 0, 'the nonce is not burnt');
    assertEq(token.balanceOf(W), AMOUNT * 10, 'nothing moved');
    // re-signed with a fresh precommitment, the same nonce lands
    _s.precommitment = PRE + 99;
    _send(_s, FEE, _signed(_s));
    assertEq(_w().nonce(), 1);
  }

  /// The pool reverts: the sell reverts as a whole (token back, approval 0, nonce kept)
  function test_R_aPoolRevertUndoesTheWholeSell() public {
    SellDelegate.Sell memory _s = _good(0);
    _s.precommitment = type(uint256).max; // >= the field: InvalidPrecommitment
    bytes memory _sig = _signed(_s);
    vm.expectRevert(IPrivacyPool.InvalidPrecommitment.selector);
    _send(_s, FEE, _sig);
    assertEq(token.balanceOf(W), AMOUNT * 10);
    assertEq(token.allowance(W, address(router)), 0);
    assertEq(weth.balanceOf(W), 0);
    assertEq(_w().nonce(), 0);
  }

  // ---- 1. the nonce ----

  /// A sell that reverts after the nonce write, caught by the caller: the write is undone with the frame, the nonce
  /// is not burnt, and the same signature lands later (until its deadline) once its terms can be met
  function test_R_aCaughtRevertNeitherBurnsNorConsumesTheNonce() public {
    Catcher _c = new Catcher();
    PriceRouter _p = new PriceRouter(weth);
    vm.deal(address(_p), 10 ether);
    _p.setPrice(OUT - 1); // the market pays under minOut now
    SellDelegate.Sell memory _s =
      _base(address(token), AMOUNT, address(_p), abi.encodeCall(PriceRouter.swap, (token, AMOUNT, W)), OUT, 0);
    bytes memory _sig = _signed(_s);
    assertFalse(_c.tryOnce(_w(), _s, FEE, _sig), 'refused under minOut');
    assertEq(_w().nonce(), 0, 'nonce kept');
    assertEq(token.allowance(W, address(_p)), 0, 'approval undone');
    // later, anyone holding the same signature lands it once the market meets minOut, until the deadline
    vm.warp(block.timestamp + 59);
    _p.setPrice(OUT);
    vm.prank(address(0xF00D)); // not the helper
    _w().sell(_s, FEE, _sig);
    assertEq(_w().nonce(), 1);
    assertEq(address(0xF00D).balance, FEE, 'whoever sends it takes the fee');
  }

  /// W re-delegated to another contract and back: the nonce at the ERC-7201 slot survives; and a second SellDelegate
  /// deployment (a new address, same domain since verifyingContract is W) sees the same nonce, so a sell landed
  /// through the first cannot be replayed through the second
  function test_R_theNonceSurvivesReDelegationAndANewDelegateDeployment() public {
    SellDelegate.Sell memory _s = _good(0);
    bytes memory _sig = _signed(_s);
    _send(_s, FEE, _sig);
    assertEq(_w().nonce(), 1);
    OtherDelegate _o = new OtherDelegate();
    vm.signAndAttachDelegation(address(_o), W_KEY);
    OtherDelegate(W).poke();
    assertEq(OtherDelegate(W).a(), 7);
    SellDelegate _d2 = new SellDelegate(IWETH(address(weth)), IPoolManager(address(0)));
    vm.signAndAttachDelegation(address(_d2), W_KEY);
    assertEq(_w().nonce(), 1, 'the nonce survived');
    vm.expectRevert(SellDelegate.InvalidNonce.selector);
    _send(_s, FEE, _sig);
    // and a W first used with another delegate sells with nonce 0 as any fresh W
    assertEq(uint256(vm.load(W, bytes32(0))), 7, "the other delegate's slot 0 is untouched");
  }

  /// A second guard against replay: if W's nonce slot were ever reset (only a later delegate W signs for could), a
  /// landed sell still cannot land again, since its precommitment is marked used in the pool
  function test_R_aReplayAfterANonceResetStopsAtThePool() public {
    SellDelegate.Sell memory _s = _good(0);
    bytes memory _sig = _signed(_s);
    _send(_s, FEE, _sig);
    vm.store(W, _nonceSlot(), bytes32(0));
    assertEq(_w().nonce(), 0);
    vm.expectRevert(IPrivacyPool.PrecommitmentAlreadyUsed.selector);
    _send(_s, FEE, _sig);
  }

  /// The guard sits at its ERC-7201 transient slot, not slot 0: a delegate that guards itself with transient slot 0 and
  /// DELEGATECALLs this one as a module runs a sell, and its own guard is still set afterwards. Across transactions and
  /// delegations nothing meets it anyway (transient storage is cleared after every transaction).
  function test_R_aModuleGuardAtSlot0DoesNotCollide() public {
    ModuleAccount _m = new ModuleAccount(address(delegate));
    vm.signAndAttachDelegation(address(_m), W_KEY);
    SellDelegate.Sell memory _s = _good(0);
    bytes memory _sig = _signed(_s);
    vm.prank(SENDER);
    assertTrue(ModuleAccount(payable(W)).run(abi.encodeCall(SellDelegate.sell, (_s, FEE, _sig))), "the module's slot-0 guard stays");
    assertEq(uint256(vm.load(W, _nonceSlot())), 1, 'the sell landed');
    assertEq(SENDER.balance, FEE);
  }

  // ---- the target is an arbitrary call from W ----

  /// amount 0, target = another token W holds, data = transfer of all of it: the delegate's post-checks pass on the
  /// allowance (0) and stop it only at minOut (the gain is 0). The signature, i.e. the device's check of target and
  /// data, is what keeps W's other assets; minOut >= 1 is the delegate's last line.
  function test_R_aSignedArbitraryCallIsStoppedOnlyByMinOut() public {
    MockToken _other = new MockToken();
    _other.mint(W, 5e18);
    SellDelegate.Sell memory _s =
      _base(address(token), 0, address(_other), abi.encodeCall(BaseToken.transfer, (address(0xA77), 5e18)), 1, 0);
    bytes memory _sig = _signed(_s);
    vm.expectRevert(SellDelegate.MinOutNotMet.selector);
    _send(_s, 0, _sig);
    assertEq(_other.balanceOf(W), 5e18);
  }
}
