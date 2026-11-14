// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Vm} from 'forge-std/Vm.sol';
import {console} from 'forge-std/console.sol';

import {FeeCollector} from '../src/FeeCollector.sol';
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
  /// The largest rung of the pools' 1-2-5 ladder from 0.001 ETH at or under `_x`, or 0 under it, walked rung by rung
  /// apart from the delegate's own rule: what a sale of `_x` (its ETH less the fee) deposits
  function _rungOf(uint256 _x) internal pure returns (uint256 _want) {
    for (uint256 _r = 0.001 ether; _r <= _x; ) {
      _want = _r;
      uint256 _d = _r;
      while (_d % 10 == 0) _d /= 10;
      _r = _d == 2 ? (_r * 5) / 2 : _r * 2;
    }
  }

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

/// The delegate's rung rule, called from a test (no W, no sale)
contract RungProbe is SellDelegate {
  constructor() SellDelegate(IWETH(address(0)), IPoolManager(address(0))) {}

  function rung(uint256 _x) external pure returns (uint256) {
    return _rungAtOrUnder(_x);
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
  /// The largest rung at or under OUT - FEE (0.398 ether): what a sale of OUT deposits
  uint256 internal constant RUNG = 0.2 ether;

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
  /// new leaf is Poseidon(the largest rung of the proceeds less the fee, label, precommitment); W keeps the rest
  function test_aSellLandsAndTheLeafHoldsTheLargestRung() public {
    SellDelegate.Sell memory _s = _good();
    uint256 _poolBefore = address(pool).balance;
    uint256 _root = pool.currentRoot();
    vm.recordLogs();
    uint256 _c = _send(_s, FEE, _signed(_s));
    (uint256 _ec, uint256 _label, uint256 _value, uint256 _pre) = _deposited(vm.getRecordedLogs());
    assertEq(_value, RUNG, 'the leaf holds the largest rung of the proceeds less the fee');
    assertEq(_pre, PRE);
    assertEq(_c, _ec);
    assertEq(_c, PoseidonT4.hash([RUNG, _label, PRE]), 'the commitment');
    assertTrue(pool.currentRoot() != _root, 'the leaf is in the tree');
    assertEq(address(pool).balance, _poolBefore + RUNG);
    assertEq(SENDER.balance, FEE, 'the sender is paid the fee');
    assertEq(router.seenAllowance(), AMOUNT, 'the approval was exactly the amount');
    assertEq(token.allowance(W, address(router)), 0, 'and it ends at 0');
    assertEq(token.balanceOf(W), AMOUNT * 9);
    assertEq(W.balance, OUT - FEE - RUNG, 'W keeps the rest in ether');
    assertEq(weth.balanceOf(W), 0, 'and no WETH');
    assertEq(_w().nonce(), 1);
    assertEq(uint256(vm.load(W, _nonceSlot())), 1, 'the nonce is at the ERC-7201 slot of W');
  }

  /// Card pool-amounts-are-standard-sizes-evm: a sale's deposit is public in value, so it is the largest rung of the
  /// pool's 1-2-5 ladder (from 0.001 ETH, 10 x MIN_DEPOSIT) at or under the proceeds less the fee, and the rest stays on
  /// W as the user's ether, never paid away (the Solana rule of f344853ca). 0.4 ether less 0.002: 0.2 ether into the
  /// pool, 0.198 ether kept on W.
  function test_aSaleDepositsTheLargestRungAndWKeepsTheRest() public {
    SellDelegate.Sell memory _s = _good();
    vm.recordLogs();
    _send(_s, FEE, _signed(_s));
    (,, uint256 _value,) = _deposited(vm.getRecordedLogs());
    assertEq(_value, 0.2 ether, 'the deposit is the largest rung under the proceeds less the fee');
    assertEq(W.balance, OUT - FEE - 0.2 ether, 'the rest stays on W');
    assertEq(SENDER.balance, FEE, 'the fee as before');
  }

  /// The least rung: proceeds less the fee of exactly 0.001 ETH deposit 0.001 ETH and leave W nothing; 1 wei under it
  /// deposits nothing, the sale still lands (W's nonce moves, the fee is paid) and W keeps the whole rest, the user's own
  function test_underTheLeastRungTheSaleLandsAndWKeepsItAll() public {
    SellDelegate.Sell memory _s = _good();
    _s.data = abi.encodeCall(MockRouter.swap, (token, AMOUNT, 0.001 ether + FEE, false, W));
    _s.minOut = 0.001 ether + FEE;
    vm.recordLogs();
    _send(_s, FEE, _signed(_s));
    (,, uint256 _value,) = _deposited(vm.getRecordedLogs());
    assertEq(_value, 0.001 ether, 'the least rung');
    assertEq(W.balance, 0, 'nothing left');

    SellDelegate.Sell memory _u = _sellOf(AMOUNT, OUT, false, 1);
    _u.data = abi.encodeCall(MockRouter.swap, (token, AMOUNT, 0.001 ether + FEE - 1, false, W));
    _u.minOut = 0.001 ether + FEE - 1;
    uint256 _root = pool.currentRoot();
    uint256 _poolBefore = address(pool).balance;
    vm.recordLogs();
    uint256 _c = _send(_u, FEE, _signed(_u));
    assertEq(_c, 0, 'no commitment');
    assertEq(pool.currentRoot(), _root, 'no leaf');
    assertEq(address(pool).balance, _poolBefore, 'nothing into the pool');
    assertEq(W.balance, 0.001 ether - 1, 'W keeps the whole rest');
    assertEq(SENDER.balance, 2 * FEE, 'the fee as before');
    assertEq(_w().nonce(), 2, 'the sale landed');
    Vm.Log[] memory _logs = vm.getRecordedLogs();
    for (uint256 _i; _i < _logs.length; ++_i) assertTrue(_logs[_i].emitter != address(pool), 'the pool logs nothing');
  }

  /// The rule at each edge of the ladder: a rung deposits itself, one wei under it the rung below, and under 0.001 ETH
  /// nothing
  function test_theRungsAtTheirEdges() public {
    RungProbe _p = new RungProbe();
    uint256[14] memory _x = [uint256(0), 0.001 ether - 1, 0.001 ether, 0.002 ether - 1, 0.002 ether, 0.005 ether - 1, 0.005 ether, 0.01 ether - 1, 0.01 ether, 0.0199 ether, 0.05 ether, 0.398 ether, 1 ether, 1000 ether + 1];
    uint256[14] memory _r = [uint256(0), 0, 0.001 ether, 0.001 ether, 0.002 ether, 0.002 ether, 0.005 ether, 0.005 ether, 0.01 ether, 0.01 ether, 0.05 ether, 0.2 ether, 1 ether, 1000 ether];
    for (uint256 _i; _i < _x.length; ++_i) assertEq(_p.rung(_x[_i]), _r[_i]);
  }

  /// The rung rule against the ladder walked here apart from the delegate (1, 2, 5 x 10^k from 0.001 ETH): the
  /// deposit is the largest rung at or under the proceeds less the fee, and 0 under 0.001 ETH, for any amount
  function testFuzz_theDepositIsTheLargestRungAtOrUnder(uint256 _x) public {
    _x = bound(_x, 0, 1e30);
    RungProbe _p = new RungProbe();
    assertEq(_p.rung(_x), _rungOf(_x));
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
    assertEq(_value, RUNG);
    assertEq(W.balance, OUT - FEE - RUNG);
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
    assertEq(_value, RUNG, 'the deposit is the largest rung of the sale, not of what W held');
    assertEq(W.balance, 1 ether + OUT - RUNG, 'W keeps what it held and the sale\'s rest');
    assertEq(weth.balanceOf(W), 1 ether);
  }

  function test_aFeeOfZeroKeepsTheWholeSale() public {
    SellDelegate.Sell memory _s = _good();
    vm.recordLogs();
    _send(_s, 0, _signed(_s));
    (,, uint256 _value,) = _deposited(vm.getRecordedLogs());
    assertEq(_value, RUNG, 'the largest rung of the whole sale (0.4 ether: 0.2)');
    assertEq(W.balance, OUT - RUNG, 'and the rest on W');
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

  /// Card evm-fee-collector: a sell whose fee recipient is the fee collector leaves, in its own transaction, Paid(W,
  /// fee) from the collector, and the collector's sink holds the fee; a failing sink reverts the whole sell
  function test_aFeePaidToTheCollectorEmitsPaidFromW() public {
    address payable _sink = payable(address(0x5141));
    FeeCollector _collector = new FeeCollector(_sink);
    SellDelegate.Sell memory _s = _good();
    _s.feeRecipient = address(_collector);
    vm.recordLogs();
    _send(_s, FEE, _signed(_s));
    Vm.Log[] memory _logs = vm.getRecordedLogs();
    uint256 _n;
    for (uint256 _i; _i < _logs.length; ++_i) {
      if (_logs[_i].emitter == address(_collector)) {
        assertEq(_logs[_i].topics[0], FeeCollector.Paid.selector, 'the one log is Paid');
        assertEq(_logs[_i].topics[1], bytes32(uint256(uint160(W))), 'paid from W');
        assertEq(abi.decode(_logs[_i].data, (uint256)), FEE, 'the fee');
        ++_n;
      }
    }
    assertEq(_n, 1, 'one Paid');
    (,, uint256 _value,) = _deposited(_logs);
    assertEq(_value, RUNG, 'the largest rung of the rest is deposited');
    assertEq(_sink.balance, FEE, 'the sink holds the fee');
    assertEq(address(_collector).balance, 0);
    assertEq(SENDER.balance, 0, 'the sender is paid nothing directly');

    FeeCollector _refusing = new FeeCollector(payable(address(new RefusingSender())));
    SellDelegate.Sell memory _s1 = _sellOf(AMOUNT, OUT, false, 1);
    _s1.feeRecipient = address(_refusing);
    bytes memory _sig = _signed(_s1);
    vm.expectRevert(SellDelegate.FailedToSendNativeAsset.selector);
    _send(_s1, FEE, _sig);
    assertEq(_w().nonce(), 1, 'the refused sell ran nothing');
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

  /*///////////////////////////////////////////////////////////////
      AUDIT E-01: FOREIGN ETH DURING A SELL MEETS MINOUT (the delegate's behaviour, held)
  //////////////////////////////////////////////////////////////*/

  // Pillow Auditors v1.0 (7 Nov), E-01, their PoC as they wrote it. A hostile target takes the tokens and pays nothing;
  // a release that lands on W mid-sell (modelled by PendingRelease) meets minOut. The release's ETH becomes the sell's
  // note and the proceeds are gone. The deployed delegate is final, so this stays its documented behaviour, and the
  // guard is the kit's: no sell is built for a W while a release to W is not final on two RPCs (card
  // evm-sell-no-release-in-flight; packages/kit src/trade/evm/sell-releases.ts).
  function test_pillow_E01_foreignEthDuringTheSellMeetsMinOut() public {
    PendingRelease _release = new PendingRelease{value: 0.5 ether}();
    SkimRouter _skim = new SkimRouter();
    SellDelegate.Sell memory _s = _good();
    _s.target = address(_skim);
    _s.data = abi.encodeCall(SkimRouter.swap, (token, AMOUNT, _release, W));
    uint256 _before = W.balance;
    uint256 _poolBefore = address(pool).balance;
    _send(_s, FEE, _signed(_s));
    assertEq(token.balanceOf(address(_skim)), AMOUNT, 'the target kept the tokens');
    assertEq(W.balance, _before + 0.5 ether - FEE - 0.2 ether, 'W keeps the release less the fee and the rung');
    assertEq(address(pool).balance - _poolBefore, 0.2 ether, 'the largest rung of the release, less the fee, is the note');
  }

  // Review 181fd050 of the card, R2-3: a Bought in W's tail can land again as ETH. A replayed buy is the same proof and
  // the same signature, and whether it lands as Bought or as Withdrawn is decided when it runs: a route that moves the
  // buy's pool first makes buySwap fail MinOutNotMet, and the pool's fallback pays the chunk to W in ETH and logs
  // Withdrawn (Buy.t.sol test_minOutNotMetPaysOut, through _paysOut). ETH that lands on W mid-sell meets minOut, the
  // target keeps the tokens and the ETH becomes the sell's note (test_pillow_E01_foreignEthDuringTheSellMeetsMinOut
  // above). The two together are E-01 through a replayed buy, so the kit holds the sell for every Bought to W in the tail
  // but the sale's own funding buy (packages/kit src/trade/evm/sell-releases.ts).

  // Review a5956de3 of the card, item 1: a Bought that lands again as Bought pays W the bought token and no ETH, so it
  // meets no minOut. Where the bought token is the one W sells, W's balance of it no longer falls by exactly the amount,
  // and the whole sell reverts at the exact-debit check: DebitNotExact where the buy pays less than the amount, an
  // underflow (Panic 0x11) where it pays as much or more. Its fallback is the note above.
  function test_aBoughtReplayedMidSellRevertsAtTheExactDebit() public {
    uint256[2] memory _paid = [AMOUNT / 2, AMOUNT * 2];
    for (uint256 _k; _k < 2; ++_k) {
      PendingBuy _buy = new PendingBuy();
      token.mint(address(_buy), _paid[_k]);
      BuyReplayRouter _r = new BuyReplayRouter();
      vm.deal(address(_r), OUT);
      SellDelegate.Sell memory _s = _good();
      _s.target = address(_r);
      _s.data = abi.encodeCall(BuyReplayRouter.swap, (token, AMOUNT, _buy, W, OUT));
      bytes memory _sig = _signed(_s);
      uint256 _tokens = token.balanceOf(W);
      vm.prank(SENDER);
      if (_k == 0) vm.expectRevert(SellDelegate.DebitNotExact.selector);
      else vm.expectRevert(abi.encodeWithSignature('Panic(uint256)', 0x11));
      _w().sell(_s, FEE, _sig);
      assertEq(token.balanceOf(W), _tokens, 'W keeps its tokens');
      assertEq(_w().nonce(), 0, 'the nonce is not used');
    }
  }

  /*///////////////////////////////////////////////////////////////
      REVIEW ROUND 3, L-2: A COPIED PRECOMMITMENT (today's behaviour, held)
  //////////////////////////////////////////////////////////////*/

  // A stranger who deposits a signed Sell's precommitment first, at MIN_DEPOSIT, makes the whole sell revert: W keeps its
  // tokens and its nonce, and signs again with a fresh precommitment (the kit's recovery: card precommit-taken-recover).
  // Reproduced by the pool-scan-3 scanner (its Scan3.t.sol), kept here as L-2's standing test.
  function test_aCopiedPrecommitmentRevertsTheWholeSellAndWKeepsItsTokens() public {
    SellDelegate.Sell memory _s = _good();
    bytes memory _sig = _signed(_s);
    address _griefer = address(0xBAD0);
    vm.deal(_griefer, 1 ether);
    vm.prank(_griefer);
    pool.deposit{value: 0.0001 ether}(0.0001 ether, _s.precommitment);
    uint256 _tokens = token.balanceOf(W);
    vm.prank(SENDER);
    vm.expectRevert(IPrivacyPool.PrecommitmentAlreadyUsed.selector);
    _w().sell(_s, FEE, _sig);
    assertEq(token.balanceOf(W), _tokens, 'W still holds the tokens');
    assertEq(_w().nonce(), 0, 'the nonce is not used: W signs a new Sell');
    assertEq(_griefer.balance, 1 ether - 0.0001 ether, 'the grief costs the stranger MIN_DEPOSIT');
  }

  // The same for a plain deposit: the stranger's note is Poseidon(value, label, the copied precommitment), which only
  // the precommitment's owner can spend, and the owner's own deposit is refused with its ether kept.
  function test_aCopiedPrecommitmentRefusesTheOwnersDepositAndItKeepsItsEther() public {
    uint256 _pre = 0xABCD;
    address _owner = address(0x71C7);
    address _griefer = address(0xBAD0);
    vm.deal(_owner, 1 ether);
    vm.deal(_griefer, 1 ether);
    vm.recordLogs();
    vm.prank(_griefer);
    uint256 _c = pool.deposit{value: 0.0001 ether}(0.0001 ether, _pre);
    Vm.Log[] memory _logs = vm.getRecordedLogs();
    uint256 _label;
    for (uint256 _i; _i < _logs.length; ++_i) {
      if (_logs[_i].topics[0] == IPrivacyPool.Deposited.selector) {
        (, _label,,) = abi.decode(_logs[_i].data, (uint256, uint256, uint256, uint256));
      }
    }
    assertEq(_c, PoseidonT4.hash([uint256(0.0001 ether), _label, _pre]), 'the note only the precommitment owner spends');
    vm.prank(_owner);
    vm.expectRevert(IPrivacyPool.PrecommitmentAlreadyUsed.selector);
    pool.deposit{value: 0.5 ether}(0.5 ether, _pre);
    assertEq(_owner.balance, 1 ether, 'the owner keeps its ether; its deposit did not land');
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

contract PendingRelease {
  constructor() payable {}

  function land(address _to) external {
    (bool _ok,) = _to.call{value: address(this).balance}('');
    require(_ok, 'release: send failed');
  }
}

contract SkimRouter {
  function swap(MockToken _token, uint256 _pull, PendingRelease _release, address _w) external {
    _token.transferFrom(msg.sender, address(this), _pull);
    _release.land(_w);
  }
}

/// A buy of W's own token, landed when a route calls it (a Bought a reorg put back in the mempool)
contract PendingBuy {
  function land(MockToken _token, address _to) external {
    _token.transfer(_to, _token.balanceOf(address(this)));
  }
}

/// A router that takes the amount and pays W `_pay` of ETH, and lands a pending buy on W in between
contract BuyReplayRouter {
  function swap(MockToken _token, uint256 _pull, PendingBuy _buy, address _w, uint256 _pay) external {
    _token.transferFrom(msg.sender, address(this), _pull);
    _buy.land(_token, _w);
    (bool _ok,) = _w.call{value: _pay}('');
    require(_ok, 'router: pay failed');
  }
}
