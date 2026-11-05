// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Vm} from 'forge-std/Vm.sol';
import {console} from 'forge-std/console.sol';

import {PrivacyPoolSimple} from '../src/PrivacyPoolSimple.sol';
import {SellDelegate, IWETH} from '../src/SellDelegate.sol';
import {IPoolManager} from '../src/adapters/UniswapV4Adapter.sol';
import {PoseidonT4} from '../src/poseidon/PoseidonT4.sol';
import {WithdrawalVerifier} from '../src/verifiers/WithdrawalVerifier.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {Signing} from './Signing.sol';

/// The 7702 cheatcodes' EVM: Prague, the hardfork that brought EIP-7702 (forge 1.7.1 and 1.8.6 both have these)
interface VmEvm {
  function setEvmVersion(string calldata _evm) external;
  function getEvmVersion() external view returns (string memory);
}

/// What the sell tests share: W (the Hardhat mnemonic's account 0, a published test key, as in the buy tests), its
/// EIP-712 Sell digest written here apart from the delegate's own encoder, and the helper that sends the sell.
abstract contract SellBase is Signing {
  uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
  bytes32 internal constant SELL_TYPEHASH = keccak256(
    'Sell(address token,uint256 amount,address target,bytes data,uint256 minOut,address pool,uint256 precommitment,uint256 feeCap,address feeRecipient,uint256 deadline,uint256 nonce)'
  );

  SellDelegate internal delegate;
  PrivacyPoolSimple internal pool;
  address internal W;
  uint256 internal W_KEY;
  address internal SENDER = address(0x5E4D);

  function _prague() internal {
    VmEvm(address(vm)).setEvmVersion('prague');
    assertEq(VmEvm(address(vm)).getEvmVersion(), 'prague');
  }

  function _setUpW() internal {
    W_KEY = vm.deriveKey(MNEMONIC, 0);
    W = vm.addr(W_KEY);
    // W is fresh: no code, no ether (a fork's copy of the published address may hold either)
    vm.etch(W, '');
    vm.deal(W, 0);
  }

  function _sellDigest(SellDelegate.Sell memory _s, uint256 _chainId, address _w) internal pure returns (bytes32) {
    bytes32 _struct = keccak256(
      abi.encode(
        SELL_TYPEHASH,
        _s.token,
        _s.amount,
        _s.target,
        keccak256(_s.data),
        _s.minOut,
        _s.pool,
        _s.precommitment,
        _s.feeCap,
        _s.feeRecipient,
        _s.deadline,
        _s.nonce
      )
    );
    return keccak256(abi.encodePacked(hex'1901', _domain(_chainId, _w), _struct));
  }

  /// W's signature of `_s` on this chain, under W's own address
  function _signed(SellDelegate.Sell memory _s) internal view returns (bytes memory) {
    return _sign(W_KEY, _sellDigest(_s, block.chainid, W));
  }

  /// ERC-7201's slot for `blindfill.sell`, computed here apart from the delegate's constant
  function _nonceSlot() internal pure returns (bytes32) {
    return keccak256(abi.encode(uint256(keccak256('blindfill.sell')) - 1)) & ~bytes32(uint256(0xff));
  }

  /// The pool's Deposited event in the recorded logs: its commitment, label and value
  function _deposited(Vm.Log[] memory _logs) internal view returns (uint256 _c, uint256 _label, uint256 _value, uint256 _pre) {
    bytes32 _topic = IPrivacyPool.Deposited.selector;
    uint256 _n;
    for (uint256 _i; _i < _logs.length; ++_i) {
      if (_logs[_i].emitter == address(pool) && _logs[_i].topics[0] == _topic) {
        assertEq(_logs[_i].topics[1], bytes32(uint256(uint160(W))), 'W is the depositor');
        (_c, _label, _value, _pre) = abi.decode(_logs[_i].data, (uint256, uint256, uint256, uint256));
        ++_n;
      }
    }
    assertEq(_n, 1, 'one deposit');
  }
}

/// A token as ERC-20 has it, but approve
abstract contract BaseToken {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  function mint(address _to, uint256 _v) external {
    balanceOf[_to] += _v;
  }

  function transfer(address _to, uint256 _v) external returns (bool) {
    balanceOf[msg.sender] -= _v;
    balanceOf[_to] += _v;
    return true;
  }

  function transferFrom(address _from, address _to, uint256 _v) external returns (bool) {
    allowance[_from][msg.sender] -= _v;
    balanceOf[_from] -= _v;
    balanceOf[_to] += _v;
    return true;
  }
}

/// A token as ERC-20 has it
contract MockToken is BaseToken {
  function approve(address _spender, uint256 _v) external returns (bool) {
    allowance[msg.sender][_spender] = _v;
    return true;
  }
}

/// A token whose approve returns nothing (as USDT's does on Ethereum)
contract NoReturnToken is BaseToken {
  function approve(address _spender, uint256 _v) external {
    allowance[msg.sender][_spender] = _v;
  }
}

/// A token whose approve returns false and sets nothing
contract FalseApproveToken is BaseToken {
  function approve(address, uint256) external pure returns (bool) {
    return false;
  }
}

/// WETH9's deposit, withdraw and balance
contract MockWETH {
  mapping(address => uint256) public balanceOf;

  function deposit() external payable {
    balanceOf[msg.sender] += msg.value;
  }

  function withdraw(uint256 _v) external {
    balanceOf[msg.sender] -= _v;
    (bool _ok,) = msg.sender.call{value: _v}('');
    require(_ok, 'WETH: send failed');
  }

  function transfer(address _to, uint256 _v) external returns (bool) {
    balanceOf[msg.sender] -= _v;
    balanceOf[_to] += _v;
    return true;
  }
}

/// A router that takes `pull` of the token from its caller and pays `out`, in WETH or in ETH, to `to`; it can call
/// back into its caller with a sell of its own
contract MockRouter {
  MockWETH internal immutable WETH;
  uint256 public seenAllowance;
  bytes internal reenter;

  constructor(MockWETH _weth) {
    WETH = _weth;
  }

  function setReenter(bytes calldata _call) external {
    reenter = _call;
  }

  function swap(MockToken _token, uint256 _pull, uint256 _out, bool _inEth, address _to) external {
    seenAllowance = _token.allowance(msg.sender, address(this));
    _token.transferFrom(msg.sender, address(this), _pull);
    if (reenter.length != 0) {
      (bool _ok, bytes memory _ret) = msg.sender.call(reenter);
      if (!_ok) {
        assembly {
          revert(add(_ret, 0x20), mload(_ret))
        }
      }
    }
    if (_inEth) {
      (bool _ok,) = _to.call{value: _out}('');
      require(_ok, 'router: send failed');
    } else {
      WETH.deposit{value: _out}();
      WETH.transfer(_to, _out);
    }
  }

  function fail() external pure {
    revert('router: no route');
  }
}

/// A sender that refuses ether
contract RefusingSender {
  function send(SellDelegate _w, SellDelegate.Sell calldata _s, uint256 _fee, bytes calldata _sig) external {
    _w.sell(_s, _fee, _sig);
  }
}

/// The sell with a mock router, token and WETH, into the real pool, W delegated by a real EIP-7702 authorization
contract SellTest is SellBase {
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
    assertEq(SellDelegate(payable(W)).nonce(), 0, 'W is delegated');
    assertEq(W.code, abi.encodePacked(hex'ef0100', address(delegate)), 'the 7702 designator');
    token.mint(W, AMOUNT * 10);
  }

  function _w() internal view returns (SellDelegate) {
    return SellDelegate(payable(W));
  }

  function _sellOf(uint256 _pull, uint256 _out, bool _inEth, uint256 _nonce) internal view returns (SellDelegate.Sell memory) {
    return SellDelegate.Sell({
      token: address(token),
      amount: AMOUNT,
      target: address(router),
      data: abi.encodeCall(MockRouter.swap, (token, _pull, _out, _inEth, W)),
      minOut: OUT,
      pool: address(pool),
      precommitment: PRE + _nonce,
      feeCap: FEE,
      feeRecipient: SENDER,
      deadline: block.timestamp + 60,
      nonce: _nonce
    });
  }

  function _good() internal view returns (SellDelegate.Sell memory) {
    return _sellOf(AMOUNT, OUT, false, 0);
  }

  function _send(SellDelegate.Sell memory _s, uint256 _fee, bytes memory _sig) internal returns (uint256) {
    vm.prank(SENDER);
    return _w().sell(_s, _fee, _sig);
  }

  /// The sell lands: the router took exactly the amount, W's WETH is unwrapped, the sender gets the fee and the pool's
  /// new leaf is Poseidon(proceeds less the fee, label, precommitment)
  function test_aSellLandsAndTheLeafHoldsTheProceedsLessTheFee() public {
    SellDelegate.Sell memory _s = _good();
    uint256 _poolBefore = address(pool).balance;
    uint256 _root = pool.currentRoot();
    vm.recordLogs();
    uint256 _c = _send(_s, FEE, _signed(_s));
    (uint256 _ec, uint256 _label, uint256 _value, uint256 _pre) = _deposited(vm.getRecordedLogs());
    assertEq(_value, OUT - FEE, 'the leaf holds the proceeds less the fee');
    assertEq(_pre, PRE);
    assertEq(_c, _ec);
    assertEq(_c, PoseidonT4.hash([OUT - FEE, _label, PRE]), 'the commitment');
    assertTrue(pool.currentRoot() != _root, 'the leaf is in the tree');
    assertEq(address(pool).balance, _poolBefore + OUT - FEE);
    assertEq(SENDER.balance, FEE, 'the sender is paid the fee');
    assertEq(router.seenAllowance(), AMOUNT, 'the approval was exactly the amount');
    assertEq(token.allowance(W, address(router)), 0, 'and it ends at 0');
    assertEq(token.balanceOf(W), AMOUNT * 9);
    assertEq(W.balance, 0, 'W keeps no ether');
    assertEq(weth.balanceOf(W), 0, 'nor WETH');
    assertEq(_w().nonce(), 1);
    assertEq(uint256(vm.load(W, _nonceSlot())), 1, 'the nonce is at the ERC-7201 slot of W');
  }

  /// Review round 3, L-1: anyone who sees W's signed sell before it lands sends it first with the whole fee cap. The
  /// fee is paid to the payee W signed, never to whoever sends it, so a front-run gains its sender nothing
  function test_aFrontRunWithTheCapPaysItsSenderNothing() public {
    SellDelegate.Sell memory _s = _good();
    address _front = address(0xF00D);
    vm.prank(_front);
    _w().sell(_s, FEE, _signed(_s));
    assertEq(_front.balance, 0, 'the front-runner is paid nothing');
    assertEq(SENDER.balance, FEE, 'the fee goes to the recipient W signed');
  }

  /// A Sell whose fee recipient is the zero address or W itself is refused before anything runs
  function test_aZeroOrSelfFeeRecipientIsRefused() public {
    SellDelegate.Sell memory _s = _good();
    _s.feeRecipient = address(0);
    bytes memory _sig = _signed(_s);
    vm.expectRevert(SellDelegate.InvalidFeeRecipient.selector);
    _send(_s, FEE, _sig);
    _s.feeRecipient = W;
    _sig = _signed(_s);
    vm.expectRevert(SellDelegate.InvalidFeeRecipient.selector);
    _send(_s, FEE, _sig);
    assertEq(_w().nonce(), 0, 'nothing ran');
    assertEq(token.balanceOf(W), AMOUNT * 10);
  }

  /// The signature binds the fee recipient: W's signature of one recipient does not pay another
  function test_aChangedFeeRecipientBreaksTheSignature() public {
    SellDelegate.Sell memory _s = _good();
    bytes memory _sig = _signed(_s);
    _s.feeRecipient = address(0xF00D);
    vm.expectRevert(SellDelegate.InvalidSignature.selector);
    _send(_s, FEE, _sig);
  }

  /// A router that pays W in ETH (an unwrap to W) lands the same way
  function test_aSellPaidInEtherLands() public {
    SellDelegate.Sell memory _s = _sellOf(AMOUNT, OUT, true, 0);
    vm.recordLogs();
    _send(_s, FEE, _signed(_s));
    (,, uint256 _value,) = _deposited(vm.getRecordedLogs());
    assertEq(_value, OUT - FEE);
    assertEq(W.balance, 0);
  }

  /// Ether W already holds, or WETH, is not the sale's: only what the sale brings is counted against minOut
  function test_whatWAlreadyHoldsDoesNotCount() public {
    vm.deal(W, 1 ether);
    vm.deal(address(this), 1 ether);
    weth.deposit{value: 1 ether}();
    weth.transfer(W, 1 ether);
    SellDelegate.Sell memory _s = _sellOf(AMOUNT, OUT - 1, false, 0);
    bytes memory _sig = _signed(_s);
    vm.expectRevert(SellDelegate.MinOutNotMet.selector);
    _send(_s, 0, _sig);
    _s = _good();
    vm.recordLogs();
    _send(_s, 0, _signed(_s));
    (,, uint256 _value,) = _deposited(vm.getRecordedLogs());
    assertEq(_value, OUT, 'the deposit is the sale, not what W held');
    assertEq(W.balance, 1 ether);
    assertEq(weth.balanceOf(W), 1 ether);
  }

  function test_aFeeOfZeroSendsTheWholeSale() public {
    SellDelegate.Sell memory _s = _good();
    vm.recordLogs();
    _send(_s, 0, _signed(_s));
    (,, uint256 _value,) = _deposited(vm.getRecordedLogs());
    assertEq(_value, OUT);
    assertEq(SENDER.balance, 0);
  }

  function test_aSellWrongSignerIsRefused() public {
    SellDelegate.Sell memory _s = _good();
    bytes memory _sig = _sign(vm.deriveKey(MNEMONIC, 1), _sellDigest(_s, block.chainid, W));
    vm.expectRevert(SellDelegate.InvalidSignature.selector);
    _send(_s, FEE, _sig);
  }

  function test_changedCalldataIsRefused() public {
    SellDelegate.Sell memory _s = _good();
    bytes memory _sig = _signed(_s);
    // the same swap paying out to another address
    SellDelegate.Sell memory _c = _good();
    _c.data = abi.encodeCall(MockRouter.swap, (token, AMOUNT, OUT, false, address(0xBAD)));
    vm.expectRevert(SellDelegate.InvalidSignature.selector);
    _send(_c, FEE, _sig);
    // the calldata as signed lands
    _send(_s, FEE, _sig);
    assertEq(SENDER.balance, FEE);
  }

  /// Each field W signs, changed after signing, is refused; the sell as signed then lands
  function test_eachChangedFieldIsRefused() public {
    SellDelegate.Sell memory _s = _good();
    bytes memory _sig = _signed(_s);
    for (uint256 _i; _i < 11; ++_i) {
      SellDelegate.Sell memory _c = _good();
      if (_i == 0) _c.token = address(weth);
      if (_i == 1) _c.amount = AMOUNT - 1;
      if (_i == 2) _c.target = address(token);
      if (_i == 3) _c.data = abi.encodeCall(MockRouter.swap, (token, AMOUNT, OUT, true, W));
      if (_i == 4) _c.minOut = OUT - 1;
      if (_i == 5) _c.pool = address(0xB00);
      if (_i == 6) _c.precommitment = PRE + 1;
      if (_i == 7) _c.feeCap = FEE * 2;
      if (_i == 8) _c.deadline = _s.deadline + 1;
      if (_i == 9) _c.nonce = 1;
      if (_i == 10) _c.feeRecipient = address(0xF00D);
      vm.expectRevert(SellDelegate.InvalidSignature.selector);
      _send(_c, FEE, _sig);
    }
    _send(_s, FEE, _sig);
    assertEq(SENDER.balance, FEE);
  }

  function test_aReplayedNonceIsRefused() public {
    SellDelegate.Sell memory _s = _good();
    bytes memory _sig = _signed(_s);
    _send(_s, FEE, _sig);
    vm.expectRevert(SellDelegate.InvalidNonce.selector);
    _send(_s, FEE, _sig);
  }

  /// A nonce ahead of W's is refused, and sells land one after another, each with the next nonce
  function test_noncesRunInTurn() public {
    SellDelegate.Sell memory _s1 = _sellOf(AMOUNT, OUT, false, 1);
    bytes memory _sig1 = _signed(_s1);
    vm.expectRevert(SellDelegate.InvalidNonce.selector);
    _send(_s1, FEE, _sig1);
    SellDelegate.Sell memory _s0 = _good();
    _send(_s0, FEE, _signed(_s0));
    _send(_s1, FEE, _sig1);
    assertEq(_w().nonce(), 2);
    assertEq(uint256(vm.load(W, _nonceSlot())), 2);
  }

  function test_anExpiredDeadlineIsRefused() public {
    SellDelegate.Sell memory _s = _good();
    bytes memory _sig = _signed(_s);
    vm.warp(_s.deadline + 1);
    vm.expectRevert(SellDelegate.DeadlineExpired.selector);
    _send(_s, FEE, _sig);
    // at the deadline itself it lands
    vm.warp(_s.deadline);
    _send(_s, FEE, _sig);
  }

  function test_aSellFeeOverTheCapIsRefused() public {
    SellDelegate.Sell memory _s = _good();
    bytes memory _sig = _signed(_s);
    vm.expectRevert(SellDelegate.FeeOverCap.selector);
    _send(_s, FEE + 1, _sig);
    _send(_s, FEE, _sig);
    assertEq(SENDER.balance, FEE, 'the cap itself is paid');
  }

  function test_aShortOutputIsRefused() public {
    SellDelegate.Sell memory _s = _sellOf(AMOUNT, OUT - 1, false, 0);
    bytes memory _sig = _signed(_s);
    vm.expectRevert(SellDelegate.MinOutNotMet.selector);
    _send(_s, FEE, _sig);
  }

  function test_aShortOutputInEtherIsRefused() public {
    SellDelegate.Sell memory _s = _sellOf(AMOUNT, OUT - 1, true, 0);
    bytes memory _sig = _signed(_s);
    vm.expectRevert(SellDelegate.MinOutNotMet.selector);
    _send(_s, FEE, _sig);
  }

  function test_aSellZeroMinOutIsRefused() public {
    SellDelegate.Sell memory _s = _good();
    _s.minOut = 0;
    bytes memory _sig = _signed(_s);
    vm.expectRevert(SellDelegate.InvalidMinOut.selector);
    _send(_s, 0, _sig);
  }

  /// A router that takes less than the amount leaves an approval: refused, and nothing is sold
  function test_aLeftoverApprovalIsRefused() public {
    SellDelegate.Sell memory _s = _sellOf(AMOUNT - 1, OUT, false, 0);
    bytes memory _sig = _signed(_s);
    vm.expectRevert(SellDelegate.LeftoverApproval.selector);
    _send(_s, FEE, _sig);
    assertEq(token.allowance(W, address(router)), 0);
    assertEq(token.balanceOf(W), AMOUNT * 10);
  }

  function test_aTargetsRevertIsPassedOn() public {
    SellDelegate.Sell memory _s = _good();
    _s.data = abi.encodeCall(MockRouter.fail, ());
    bytes memory _sig = _signed(_s);
    vm.expectRevert(bytes('router: no route'));
    _send(_s, FEE, _sig);
  }

  /// A target that calls back into W with another sell W signed is refused
  function test_aTargetCannotReenter() public {
    SellDelegate.Sell memory _s1 = _sellOf(AMOUNT, OUT, false, 1);
    router.setReenter(abi.encodeCall(SellDelegate.sell, (_s1, 0, _signed(_s1))));
    SellDelegate.Sell memory _s0 = _good();
    bytes memory _sig = _signed(_s0);
    vm.expectRevert(SellDelegate.Reentrancy.selector);
    _send(_s0, FEE, _sig);
  }

  /// Two sells in one transaction (a batch): the guard is lifted after each
  function test_twoSellsInOneTransactionBothLand() public {
    SellDelegate.Sell memory _s0 = _good();
    SellDelegate.Sell memory _s1 = _sellOf(AMOUNT, OUT, false, 1);
    TwoSells _two = new TwoSells();
    _two.run(_w(), _s0, _signed(_s0), _s1, _signed(_s1));
    assertEq(_w().nonce(), 2);
  }

  function test_aFeeRecipientThatRefusesEtherRevertsTheSell() public {
    RefusingSender _r = new RefusingSender();
    SellDelegate.Sell memory _s = _good();
    _s.feeRecipient = address(_r);
    bytes memory _sig = _signed(_s);
    vm.expectRevert(SellDelegate.FailedToSendNativeAsset.selector);
    _r.send(_w(), _s, FEE, _sig);
    // with a fee of 0 nothing is sent to it, and the sell lands
    _r.send(_w(), _s, 0, _sig);
  }

  function test_aSellHighSSignatureIsRefused() public {
    SellDelegate.Sell memory _s = _good();
    (uint8 _v, bytes32 _r, bytes32 _sl) = vm.sign(W_KEY, _sellDigest(_s, block.chainid, W));
    bytes memory _high = abi.encodePacked(_r, bytes32(N - uint256(_sl)), _v == 27 ? uint8(28) : uint8(27));
    vm.expectRevert(SellDelegate.InvalidSignature.selector);
    _send(_s, FEE, _high);
  }

  function test_aSellSignatureWithATrailingByteIsRefused() public {
    SellDelegate.Sell memory _s = _good();
    bytes memory _sig = abi.encodePacked(_signed(_s), bytes1(0));
    vm.expectRevert(SellDelegate.InvalidSignature.selector);
    _send(_s, FEE, _sig);
  }

  function test_aVOtherThan27Or28IsRefused() public {
    SellDelegate.Sell memory _s = _good();
    (uint8 _v, bytes32 _r, bytes32 _sl) = vm.sign(W_KEY, _sellDigest(_s, block.chainid, W));
    vm.expectRevert(SellDelegate.InvalidSignature.selector);
    _send(_s, FEE, abi.encodePacked(_r, _sl, _v - 27));
  }

  function test_sellSignaturesWithVOf27And28BothLand() public {
    bool _seen27;
    bool _seen28;
    for (uint256 _i; _i < 8 && !(_seen27 && _seen28); ++_i) {
      SellDelegate.Sell memory _s = _sellOf(AMOUNT, OUT, false, _i);
      (uint8 _v,,) = vm.sign(W_KEY, _sellDigest(_s, block.chainid, W));
      _send(_s, FEE, _signed(_s));
      if (_v == 27) _seen27 = true;
      else _seen28 = true;
    }
    assertTrue(_seen27 && _seen28);
  }

  function test_anotherChainsSellSignatureIsRefused() public {
    SellDelegate.Sell memory _s = _good();
    bytes memory _sig = _sign(W_KEY, _sellDigest(_s, 8453, W));
    vm.expectRevert(SellDelegate.InvalidSignature.selector);
    _send(_s, FEE, _sig);
  }

  /// A signature W made under another address (another wallet's domain, or the delegate's) never moves W's tokens
  function test_anotherWalletsSignatureIsRefused() public {
    SellDelegate.Sell memory _s = _good();
    bytes memory _sig = _sign(W_KEY, _sellDigest(_s, block.chainid, address(delegate)));
    vm.expectRevert(SellDelegate.InvalidSignature.selector);
    _send(_s, FEE, _sig);
  }

  /// A token whose approve returns nothing sells as any other
  function test_aTokenWhoseApproveReturnsNothingSells() public {
    NoReturnToken _t = new NoReturnToken();
    _t.mint(W, AMOUNT);
    SellDelegate.Sell memory _s = _good();
    _s.token = address(_t);
    _s.data = abi.encodeCall(MockRouter.swap, (MockToken(address(_t)), AMOUNT, OUT, false, W));
    _send(_s, FEE, _signed(_s));
    assertEq(_t.balanceOf(W), 0);
    assertEq(_t.allowance(W, address(router)), 0);
  }

  /// A token whose approve returns false is refused before the router is called
  function test_aTokenThatRefusesTheApprovalIsRefused() public {
    FalseApproveToken _t = new FalseApproveToken();
    _t.mint(W, AMOUNT);
    SellDelegate.Sell memory _s = _good();
    _s.token = address(_t);
    _s.data = abi.encodeCall(MockRouter.swap, (MockToken(address(_t)), 0, OUT, false, W));
    bytes memory _sig = _signed(_s);
    vm.expectRevert(SellDelegate.ApproveFailed.selector);
    _send(_s, FEE, _sig);
  }

  /// Both trees of depth 32 with 2^32 - 1 leaves, so the deposit's two inserts hash all 32 levels each
  function _deepTrees() internal {
    address _p = address(pool);
    for (uint256 _t; _t < 2; ++_t) {
      uint256 _base = _t == 0 ? 3 : 7; // _merkleTree, _labelTree (test/layout.test.mjs)
      vm.store(_p, bytes32(_base), bytes32(uint256(type(uint32).max))); // size
      vm.store(_p, bytes32(_base + 1), bytes32(uint256(32))); // depth
      for (uint256 _i; _i < 32; ++_i) vm.store(_p, keccak256(abi.encode(_i, _base + 2)), bytes32(_i + 1)); // sideNodes
    }
  }

  function _gasSell(bool _deep) internal {
    if (_deep) _deepTrees();
    SellDelegate.Sell memory _s = _good();
    bytes memory _sig = _signed(_s);
    vm.prank(SENDER);
    uint256 _g = gasleft();
    _w().sell(_s, FEE, _sig);
    console.log(_deep ? 'sell (mock router) depth 32 gas:' : 'sell (mock router) depth 0 gas:', _g - gasleft());
    assertEq(pool.currentTreeDepth(), _deep ? 32 : 0);
    assertEq(pool.currentLabelTreeDepth(), _deep ? 32 : 0);
  }

  function test_gasSellMockRouterDepth0() public {
    _gasSell(false);
  }

  function test_gasSellMockRouterDepth32() public {
    _gasSell(true);
  }

  /// A third party that calls the delegate's own address, or W, with any signature it can make moves nothing
  function test_aThirdPartyCallingTheDelegateMovesNothing() public {
    SellDelegate.Sell memory _s = _good();
    bytes memory _wsig = _signed(_s);
    // the delegate itself holds tokens sent to it by mistake: its own address has no key, so no signature is its
    token.mint(address(delegate), AMOUNT);
    SellDelegate.Sell memory _d = _good();
    _d.data = abi.encodeCall(MockRouter.swap, (token, AMOUNT, OUT, false, address(delegate)));
    uint256 _strangerKey = 0x5712;
    address _stranger = vm.addr(_strangerKey);
    vm.startPrank(_stranger);
    // W's own signature, sent to the delegate's address
    vm.expectRevert(SellDelegate.InvalidSignature.selector);
    delegate.sell(_s, FEE, _wsig);
    // W's key under the delegate's domain, and the stranger's key under it
    vm.expectRevert(SellDelegate.InvalidSignature.selector);
    delegate.sell(_d, FEE, _sign(W_KEY, _sellDigest(_d, block.chainid, address(delegate))));
    vm.expectRevert(SellDelegate.InvalidSignature.selector);
    delegate.sell(_d, FEE, _sign(_strangerKey, _sellDigest(_d, block.chainid, address(delegate))));
    // the stranger's own signature, sent to W
    vm.expectRevert(SellDelegate.InvalidSignature.selector);
    _w().sell(_s, FEE, _sign(_strangerKey, _sellDigest(_s, block.chainid, W)));
    // a signature for the stranger's own address, sent to W
    vm.expectRevert(SellDelegate.InvalidSignature.selector);
    _w().sell(_s, FEE, _sign(_strangerKey, _sellDigest(_s, block.chainid, _stranger)));
    vm.stopPrank();
    assertEq(token.balanceOf(W), AMOUNT * 10, 'W kept every token');
    assertEq(token.balanceOf(address(delegate)), AMOUNT, 'the delegate too');
    assertEq(token.allowance(W, address(router)), 0);
    assertEq(_w().nonce(), 0);
    assertEq(address(pool).balance, 0);
  }
}

/// Two sells of W in one call
contract TwoSells {
  function run(
    SellDelegate _w,
    SellDelegate.Sell calldata _s0,
    bytes calldata _sig0,
    SellDelegate.Sell calldata _s1,
    bytes calldata _sig1
  ) external {
    _w.sell(_s0, 0, _sig0);
    _w.sell(_s1, 0, _sig1);
  }
}

/// The delegate's deployed code, read opcode by opcode: no DELEGATECALL, CALLCODE, SELFDESTRUCT, CREATE or CREATE2,
/// and a dispatcher with exactly the listed selectors (its storage layout and ABI: test/layout.test.mjs)
contract SellDelegateKeylessTest is SellBase {
  bytes internal code;

  function setUp() public {
    code = address(new SellDelegate(IWETH(address(0x4200000000000000000000000000000000000006)), IPoolManager(address(0x498581fF718922c3f8e6A244956aF099B2652b2b)))).code;
    assertGt(code.length, 0);
  }

  function _walk() internal view returns (bytes memory _ops, bytes4[] memory _sels) {
    _ops = new bytes(code.length);
    _sels = new bytes4[](code.length / 6);
    uint256 _n;
    uint256 _m;
    for (uint256 _i; _i < code.length;) {
      uint8 _op = uint8(code[_i]);
      _ops[_n++] = bytes1(_op);
      if (_op >= 0x60 && _op <= 0x7f) {
        uint256 _len = _op - 0x5f;
        if (_op == 0x63 && _i + 5 < code.length && uint8(code[_i + 5]) == 0x14) {
          _sels[_m++] = bytes4(
            uint32(uint8(code[_i + 1])) << 24 | uint32(uint8(code[_i + 2])) << 16 | uint32(uint8(code[_i + 3])) << 8
              | uint32(uint8(code[_i + 4]))
          );
        }
        _i += 1 + _len;
      } else {
        _i += 1;
      }
    }
    assembly {
      mstore(_ops, _n)
      mstore(_sels, _m)
    }
  }

  function test_theDelegateHasNoDelegatecallCallcodeSelfdestructOrCreate() public view {
    (bytes memory _ops,) = _walk();
    for (uint256 _i; _i < _ops.length; ++_i) {
      uint8 _op = uint8(_ops[_i]);
      assertTrue(_op != 0xf4, 'DELEGATECALL');
      assertTrue(_op != 0xf2, 'CALLCODE');
      assertTrue(_op != 0xff, 'SELFDESTRUCT');
      assertTrue(_op != 0xf0, 'CREATE');
      assertTrue(_op != 0xf5, 'CREATE2');
    }
  }

  function test_theDelegatesDispatcherHasExactlyTheListedSelectors() public view {
    bytes4[5] memory _want = [
      bytes4(keccak256("WETH()")),
      bytes4(keccak256("POOL_MANAGER()")),
      SellDelegate.nonce.selector,
      SellDelegate.sell.selector,
      SellDelegate.unlockCallback.selector
    ];
    (, bytes4[] memory _got) = _walk();
    assertEq(_got.length, _want.length, 'the number of selectors');
    for (uint256 _i; _i < _want.length; ++_i) {
      bool _found;
      for (uint256 _j; _j < _got.length; ++_j) {
        if (_got[_j] == _want[_i]) _found = true;
      }
      assertTrue(_found, 'a listed selector is missing');
    }
  }
}
