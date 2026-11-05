// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {PrivacyPoolSimple} from '../src/PrivacyPoolSimple.sol';
import {ProofLib} from '../src/lib/ProofLib.sol';
import {WithdrawalVerifier} from '../src/verifiers/WithdrawalVerifier.sol';
import {IPrivacyPool, IPrivacyPoolSimple} from 'interfaces/IPrivacyPool.sol';

import {Signing} from './Signing.sol';

/// The circuit, as the pool sees it: a proof verifies when the handler made it the way the withdraw circuit allows (a
/// live note's nullifier, a value at most the note's, its change as a new commitment). Its code is put over the real
/// verifier's after the pool is built, so the pool's code-hash check holds and each run costs no pairing.
contract CircuitModel {
  mapping(bytes32 _signals => bool _ok) public provable;

  function allow(uint256[8] calldata _s) external {
    provable[keccak256(abi.encode(_s))] = true;
  }

  function verifyProof(
    uint256[2] calldata,
    uint256[2][2] calldata,
    uint256[2] calldata,
    uint256[8] calldata _s
  ) external view returns (bool) {
    return provable[keccak256(abi.encode(_s))];
  }
}

/// A token a buy is paid in
contract InvToken {
  mapping(address => uint256) public balanceOf;

  function mint(address _to, uint256 _v) external {
    balanceOf[_to] += _v;
  }
}

/// A swap that keeps the ETH it is sent and sends one token per wei to W
contract InvAdapter {
  function buy(address _token, address _recipient, uint256, bytes calldata) external payable {
    InvToken(_token).mint(_recipient, msg.value);
  }
}

/// Deposits, withdraws, buys and replays of spent notes in any order and amount, from 3 depositors, 3 Ws, 3 fee
/// recipients and 3 relayers. It records what each release pays and to whom; the invariants read it with the chain.
contract PoolHandler is Signing {
  uint256 internal constant P = 21_888_242_871_839_275_222_246_405_745_257_275_088_548_364_400_416_034_343_698_204_186_575_808_495_617;

  PrivacyPoolSimple public pool;
  CircuitModel public circuit;
  InvAdapter public adapter;
  InvToken public token;

  struct Note {
    uint256 value;
    uint256 nullifier;
  }

  Note[] public live;
  uint256[] public spent;
  uint256 internal seq;

  uint256 public deposited;
  uint256 public releases;
  uint256 public doubleSpends;
  uint256 public overNote;
  uint256 public feeViolations;
  uint256 public refusedGood;
  uint256 public liveValue;

  constructor(PrivacyPoolSimple _pool, CircuitModel _circuit) {
    pool = _pool;
    circuit = _circuit;
    adapter = new InvAdapter();
    token = new InvToken();
  }

  /*///////////////////////////////////////////////////////////////
                               ACTORS
  //////////////////////////////////////////////////////////////*/

  function wKey(uint256 _i) public pure returns (uint256) {
    return 0xA11CE + _i % 3;
  }

  function feeTo(uint256 _i) public pure returns (address) {
    return address(uint160(0xFEE10 + _i % 3));
  }

  function relayer(uint256 _i) public pure returns (address) {
    return address(uint160(0xBEE10 + _i % 3));
  }

  /// Every address a release may pay, plus the relayers, which a release must never pay
  function payees() public view returns (address[] memory _a) {
    _a = new address[](10);
    for (uint256 _i; _i < 3; ++_i) {
      _a[_i] = vm.addr(wKey(_i));
      _a[3 + _i] = feeTo(_i);
      _a[6 + _i] = relayer(_i);
    }
    _a[9] = address(adapter);
  }

  function liveCount() external view returns (uint256) {
    return live.length;
  }

  function spentCount() external view returns (uint256) {
    return spent.length;
  }

  function _field(string memory _tag) internal returns (uint256) {
    return uint256(keccak256(abi.encode(_tag, ++seq))) % P;
  }

  /*///////////////////////////////////////////////////////////////
                              HANDLERS
  //////////////////////////////////////////////////////////////*/

  function deposit(uint256 _who, uint256 _value) external {
    _value = bound(_value, pool.MIN_DEPOSIT(), 10 ether);
    address _d = address(uint160(0xD0010 + _who % 3));
    vm.deal(_d, _value);
    vm.prank(_d);
    pool.deposit{value: _value}(_value, _field('precommitment'));
    live.push(Note(_value, _field('nullifier')));
    deposited += _value;
    liveValue += _value;
  }

  struct Release {
    uint256 key;
    address w;
    address feeRecipient;
    address sender;
    uint256 withdrawn;
    uint256 feeCap;
    uint256 fee;
  }

  function _pick(uint256[6] memory _seeds, uint256 _value) internal pure returns (Release memory _r) {
    _r.key = wKey(_seeds[0]);
    _r.w = vm.addr(_r.key);
    _r.feeRecipient = feeTo(_seeds[1]);
    _r.sender = relayer(_seeds[2]);
    _r.withdrawn = bound(_seeds[3], 1, _value);
    _r.feeCap = bound(_seeds[4], 0, _r.withdrawn);
    // a fee up to twice the cap: the pool must refuse the part above it
    _r.fee = bound(_seeds[5], 0, _r.feeCap * 2);
  }

  /// The proof the circuit allows for spending `_nullifier` into a release of `_r`, against the pool's current roots
  function _prove(
    Release memory _r,
    uint256 _nullifier,
    uint256 _change
  ) internal returns (IPrivacyPool.Withdrawal memory _wd, ProofLib.WithdrawProof memory _p) {
    IPrivacyPool.RelayData memory _data = IPrivacyPool.RelayData({
      recipient: _r.w,
      feeRecipient: _r.feeRecipient,
      feeCap: _r.feeCap,
      deadlineMs: uint64((block.timestamp + 3600) * 1000),
      refundPrecommitment: _field('refund'),
      salt: bytes16(bytes32(_field('salt')))
    });
    _wd = IPrivacyPool.Withdrawal({processooor: address(pool), data: abi.encode(_data)});
    _p.pubSignals[0] = _change;
    _p.pubSignals[1] = _nullifier;
    _p.pubSignals[2] = _r.withdrawn;
    _p.pubSignals[3] = pool.currentRoot();
    _p.pubSignals[4] = pool.currentTreeDepth();
    _p.pubSignals[5] = pool.currentLabelRoot();
    _p.pubSignals[6] = pool.currentLabelTreeDepth();
    _p.pubSignals[7] = uint256(keccak256(abi.encode(_wd, pool.SCOPE()))) % P;
    circuit.allow(_p.pubSignals);
  }

  /// The payees' balances, the relayers' among them
  function _balances() internal view returns (uint256[] memory _b) {
    address[] memory _a = payees();
    _b = new uint256[](_a.length);
    for (uint256 _i; _i < _a.length; ++_i) _b[_i] = _a[_i].balance;
  }

  /// After a release that landed: the pool paid out exactly the withdrawn value, at most the note's; the fee recipient
  /// got exactly the fee, at most the cap; `_to` got the rest; nobody else got a wei.
  function _checkPaid(
    Release memory _r,
    uint256 _noteValue,
    address _to,
    uint256 _poolBefore,
    uint256[] memory _before
  ) internal {
    ++releases;
    uint256 _out = _poolBefore - address(pool).balance;
    if (_out > _noteValue || _out != _r.withdrawn) ++overNote;
    if (_r.fee > _r.feeCap) ++feeViolations;
    address[] memory _a = payees();
    for (uint256 _i; _i < _a.length; ++_i) {
      uint256 _got = _a[_i].balance - _before[_i];
      uint256 _want = (_a[_i] == _r.feeRecipient ? _r.fee : 0) + (_a[_i] == _to ? _r.withdrawn - _r.fee : 0);
      if (_got != _want) ++feeViolations;
    }
  }

  function _take(uint256 _noteSeed) internal returns (Note memory _n) {
    uint256 _i = _noteSeed % live.length;
    _n = live[_i];
    live[_i] = live[live.length - 1];
    live.pop();
  }

  function _settle(Note memory _n, uint256 _withdrawn) internal {
    spent.push(_n.nullifier);
    liveValue -= _n.value;
    if (_n.value > _withdrawn) {
      // the change note: its nullifier is the circuit's, a new one
      live.push(Note(_n.value - _withdrawn, _field('nullifier')));
      liveValue += _n.value - _withdrawn;
    }
  }

  function withdraw(uint256 _noteSeed, uint256[6] memory _seeds) external {
    if (live.length == 0) return;
    Note memory _n = live[_noteSeed % live.length];
    Release memory _r = _pick(_seeds, _n.value);
    uint256 _change = _field('change');
    (IPrivacyPool.Withdrawal memory _wd, ProofLib.WithdrawProof memory _p) = _prove(_r, _n.nullifier, _change);
    bytes memory _sig = _sign(_r.key, _withdrawDigest(_n.nullifier, _p.pubSignals[7], _r.withdrawn, block.chainid, address(pool)));
    uint256 _poolBefore = address(pool).balance;
    uint256[] memory _before = _balances();
    vm.prank(_r.sender);
    try pool.withdraw(_wd, _p, _r.fee, _sig) {
      _checkPaid(_r, _n.value, _r.w, _poolBefore, _before);
      _settle(_take(_noteSeed), _r.withdrawn);
    } catch {
      // refused: only a fee above the cap or above half the withdrawn value may be
      if (_r.fee <= _r.feeCap && _r.fee * 10_000 <= _r.withdrawn * 5000) ++refusedGood;
    }
  }

  function buy(uint256 _noteSeed, uint256[6] memory _seeds) external {
    if (live.length == 0) return;
    Note memory _n = live[_noteSeed % live.length];
    Release memory _r = _pick(_seeds, _n.value);
    uint256 _change = _field('change');
    (IPrivacyPool.Withdrawal memory _wd, ProofLib.WithdrawProof memory _p) = _prove(_r, _n.nullifier, _change);
    IPrivacyPoolSimple.Buy memory _b =
      IPrivacyPoolSimple.Buy({adapter: address(adapter), data: hex'01', minOut: 1, token: address(token)});
    bytes memory _sig =
      _sign(_r.key, _buyDigest(_b, _n.nullifier, _p.pubSignals[7], _r.withdrawn, block.chainid, address(pool)));
    uint256 _poolBefore = address(pool).balance;
    uint256[] memory _before = _balances();
    vm.prank(_r.sender);
    try pool.buy(_wd, _p, _r.fee, _b, _sig) {
      _checkPaid(_r, _n.value, address(adapter), _poolBefore, _before);
      _settle(_take(_noteSeed), _r.withdrawn);
    } catch {
      // refused: a fee above the cap or above half, or nothing left to swap (minOut 1)
      if (_r.fee <= _r.feeCap && _r.fee * 10_000 <= _r.withdrawn * 5000 && _r.withdrawn > _r.fee) ++refusedGood;
    }
  }

  /// A spent note's nullifier again, in a proof the circuit allows (it was the note's), against today's roots: the
  /// pool must refuse it
  function replay(uint256 _spentSeed, uint256[6] memory _seeds) external {
    if (spent.length == 0) return;
    uint256 _nullifier = spent[_spentSeed % spent.length];
    Release memory _r = _pick(_seeds, pool.MIN_DEPOSIT());
    _r.fee = 0;
    (IPrivacyPool.Withdrawal memory _wd, ProofLib.WithdrawProof memory _p) = _prove(_r, _nullifier, _field('change'));
    bytes memory _sig = _sign(_r.key, _withdrawDigest(_nullifier, _p.pubSignals[7], _r.withdrawn, block.chainid, address(pool)));
    vm.prank(_r.sender);
    try pool.withdraw(_wd, _p, 0, _sig) {
      ++doubleSpends;
    } catch {}
  }
}

/// The pool's invariants under random deposits, withdraws, buys and replays: its ETH is deposits minus payouts and
/// equals its live notes; a nullifier spends once; no release pays more than its note; a fee is at most the cap and
/// goes only to the fee recipient; a release within its cap lands. The circuit is modelled (CircuitModel), so the runs check the pool's own code.
contract PoolInvariantTest is Signing {
  PrivacyPoolSimple internal pool;
  PoolHandler internal handler;

  function setUp() public {
    _deployPoseidon();
    WithdrawalVerifier _wv = new WithdrawalVerifier();
    pool = new PrivacyPoolSimple(address(_wv));
    // the circuit model over the real verifier's code, now that the pool has checked that code's hash
    vm.etch(address(_wv), address(new CircuitModel()).code);
    vm.warp(1_900_000_000);
    handler = new PoolHandler(pool, CircuitModel(address(_wv)));
    bytes4[] memory _s = new bytes4[](4);
    _s[0] = PoolHandler.deposit.selector;
    _s[1] = PoolHandler.withdraw.selector;
    _s[2] = PoolHandler.buy.selector;
    _s[3] = PoolHandler.replay.selector;
    targetSelector(FuzzSelector({addr: address(handler), selectors: _s}));
    targetContract(address(handler));
  }

  function _paidOut() internal view returns (uint256 _sum) {
    address[] memory _a = handler.payees();
    for (uint256 _i; _i < _a.length; ++_i) _sum += _a[_i].balance;
  }

  function invariant_poolEthIsDepositsMinusPayouts() public view {
    assertEq(address(pool).balance, handler.deposited() - _paidOut(), 'pool ETH = deposits - payouts');
    assertEq(address(pool).balance, handler.liveValue(), 'pool ETH = the live notes');
  }

  function invariant_aNullifierSpendsOnce() public view {
    assertEq(handler.doubleSpends(), 0, 'a spent nullifier spent again');
    for (uint256 _i; _i < handler.spentCount(); ++_i) assertTrue(pool.nullifierHashes(handler.spent(_i)));
    for (uint256 _i; _i < handler.liveCount(); ++_i) {
      (, uint256 _n) = handler.live(_i);
      assertFalse(pool.nullifierHashes(_n), 'a live note is marked spent');
    }
  }

  function invariant_noPayoutAboveTheNote() public view {
    assertEq(handler.overNote(), 0, 'a release paid more than its note, or other than its value');
  }

  function invariant_aFeeIsAtMostTheCapAndOnlyToTheFeeRecipient() public view {
    assertEq(handler.feeViolations(), 0, 'a fee above the cap, or a wei to an address the release does not name');
    for (uint256 _i; _i < 3; ++_i) assertEq(handler.relayer(_i).balance, 0, 'a relayer was paid');
  }

  function invariant_aGoodReleaseLands() public view {
    assertEq(handler.refusedGood(), 0, 'a release within its cap and half its value was refused');
  }

  /// Each run released at least once, so the invariants above read payouts and not only deposits
  function afterInvariant() public view {
    assertGt(handler.releases(), 0, 'the run released nothing');
  }
}
