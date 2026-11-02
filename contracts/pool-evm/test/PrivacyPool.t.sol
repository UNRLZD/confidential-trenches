// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from 'forge-std/Test.sol';
import {console} from 'forge-std/console.sol';

import {PrivacyPoolSimple} from '../src/PrivacyPoolSimple.sol';
import {ProofLib} from '../src/lib/ProofLib.sol';
import {CommitmentVerifier} from '../src/verifiers/CommitmentVerifier.sol';
import {WithdrawalVerifier} from '../src/verifiers/WithdrawalVerifier.sol';
import {IPrivacyPool, IPrivacyPoolSimple} from 'interfaces/IPrivacyPool.sol';
import {IState} from 'interfaces/IState.sol';

/// The pool with the kit's real proofs (test/fixtures/pool-proofs.json, made with packages/kit/zk) through the
/// verifiers the pool deploys, and Poseidon at its CREATE2 address, put there by the same proxy and bytes as on chain.
contract PoolTest is Test {
  uint256 internal constant P = 21_888_242_871_839_275_222_246_405_745_257_275_088_548_364_400_416_034_343_698_204_186_575_808_495_617;
  // block time in the tests: 2030-03-17, below every request's deadline (2,000,000,000,000 ms)
  uint256 internal constant NOW = 1_900_000_000;

  string internal fx;
  PrivacyPoolSimple internal pool;
  address internal POOL;
  address internal DEPOSITOR;
  address internal W;
  address internal RELAYER;

  function setUp() public {
    fx = vm.readFile('test/fixtures/pool-proofs.json');
    _deployPoseidon();
    WithdrawalVerifier _wv = new WithdrawalVerifier();
    CommitmentVerifier _cv = new CommitmentVerifier();
    POOL = vm.parseJsonAddress(fx, '.pool');
    DEPOSITOR = vm.parseJsonAddress(fx, '.depositor');
    W = vm.parseJsonAddress(fx, '.relayed.request.recipient');
    RELAYER = vm.parseJsonAddress(fx, '.relayed.request.feeRecipient');
    assertEq(block.chainid, vm.parseJsonUint(fx, '.chainId'));
    deployCodeTo('PrivacyPoolSimple.sol:PrivacyPoolSimple', abi.encode(address(_wv), address(_cv)), POOL);
    pool = PrivacyPoolSimple(POOL);
    vm.warp(NOW);
    vm.deal(DEPOSITOR, 100 ether);
  }

  /*///////////////////////////////////////////////////////////////
                              HELPERS
  //////////////////////////////////////////////////////////////*/

  /// The deterministic deployment proxy, then PoseidonT3 and T4 through it, as on every chain.
  function _deployPoseidon() internal {
    string memory _d = vm.readFile('test/fixtures/poseidon-deploy.json');
    address _proxy = vm.parseJsonAddress(_d, '.proxy.address');
    vm.etch(_proxy, vm.parseJsonBytes(_d, '.proxy.runtime'));
    assertEq(_proxy.codehash, vm.parseJsonBytes32(_d, '.proxy.codeHash'), 'the proxy is the one on chain');
    string[2] memory _t = ['.T3', '.T4'];
    for (uint256 _i; _i < 2; ++_i) {
      (bool _ok, bytes memory _out) = _proxy.call(vm.parseJsonBytes(_d, string.concat(_t[_i], '.data')));
      assertTrue(_ok, 'the proxy deploys Poseidon');
      address _at = vm.parseJsonAddress(_d, string.concat(_t[_i], '.address'));
      assertEq(address(bytes20(_out)), _at, 'at its CREATE2 address');
      assertEq(_at.codehash, vm.parseJsonBytes32(_d, string.concat(_t[_i], '.codeHash')), 'the code read on chain');
    }
  }

  function _deposit(uint256 _i) internal returns (uint256 _commitment) {
    string memory _k = string.concat('[', vm.toString(_i), ']');
    uint256 _value = vm.parseJsonUint(fx, string.concat('.values', _k));
    vm.prank(DEPOSITOR);
    _commitment = pool.deposit{value: _value}(_value, vm.parseJsonUint(fx, string.concat('.precommitments', _k)));
    assertEq(_commitment, vm.parseJsonUint(fx, string.concat('.commitments', _k)), 'the commitment the kit computes');
  }

  function _depositAll() internal {
    for (uint256 _i; _i < 3; ++_i) _deposit(_i);
  }

  function _request(string memory _name) internal view returns (IPrivacyPool.RelayData memory _r) {
    string memory _k = string.concat('.', _name, '.request');
    _r.recipient = vm.parseJsonAddress(fx, string.concat(_k, '.recipient'));
    _r.feeRecipient = vm.parseJsonAddress(fx, string.concat(_k, '.feeRecipient'));
    _r.feeCap = vm.parseJsonUint(fx, string.concat(_k, '.feeCap'));
    _r.deadlineMs = uint64(vm.parseJsonUint(fx, string.concat(_k, '.deadlineMs')));
    _r.refundPrecommitment = vm.parseJsonUint(fx, string.concat(_k, '.refundPrecommitment'));
    _r.salt = bytes16(vm.parseJsonBytes(fx, string.concat(_k, '.salt')));
  }

  function _withdrawal(IPrivacyPool.RelayData memory _r) internal view returns (IPrivacyPool.Withdrawal memory) {
    return IPrivacyPool.Withdrawal({processooor: address(pool), data: abi.encode(_r)});
  }

  function _withdrawProof(string memory _name) internal view returns (ProofLib.WithdrawProof memory _p) {
    string memory _k = string.concat('.', _name, '.proof');
    uint256[] memory _a = vm.parseJsonUintArray(fx, string.concat(_k, '.pA'));
    uint256[] memory _b0 = vm.parseJsonUintArray(fx, string.concat(_k, '.pB[0]'));
    uint256[] memory _b1 = vm.parseJsonUintArray(fx, string.concat(_k, '.pB[1]'));
    uint256[] memory _c = vm.parseJsonUintArray(fx, string.concat(_k, '.pC'));
    uint256[] memory _s = vm.parseJsonUintArray(fx, string.concat(_k, '.pubSignals'));
    _p.pA = [_a[0], _a[1]];
    _p.pB = [[_b0[0], _b0[1]], [_b1[0], _b1[1]]];
    _p.pC = [_c[0], _c[1]];
    for (uint256 _i; _i < 8; ++_i) _p.pubSignals[_i] = _s[_i];
  }

  function _ragequitProof(string memory _name) internal view returns (ProofLib.RagequitProof memory _p) {
    string memory _k = string.concat('.', _name, '.proof');
    uint256[] memory _a = vm.parseJsonUintArray(fx, string.concat(_k, '.pA'));
    uint256[] memory _b0 = vm.parseJsonUintArray(fx, string.concat(_k, '.pB[0]'));
    uint256[] memory _b1 = vm.parseJsonUintArray(fx, string.concat(_k, '.pB[1]'));
    uint256[] memory _c = vm.parseJsonUintArray(fx, string.concat(_k, '.pC'));
    uint256[] memory _s = vm.parseJsonUintArray(fx, string.concat(_k, '.pubSignals'));
    _p.pA = [_a[0], _a[1]];
    _p.pB = [[_b0[0], _b0[1]], [_b1[0], _b1[1]]];
    _p.pC = [_c[0], _c[1]];
    for (uint256 _i; _i < 4; ++_i) _p.pubSignals[_i] = _s[_i];
  }

  /// Submits `_name`'s proof from an address that is neither payee, with `_fee`.
  function _relay(
    IPrivacyPool.RelayData memory _r,
    ProofLib.WithdrawProof memory _p,
    uint256 _fee
  ) internal {
    vm.prank(address(0xBEEF));
    pool.withdraw(_withdrawal(_r), _p, _fee);
  }

  function _refusesRelay(
    IPrivacyPool.RelayData memory _r,
    ProofLib.WithdrawProof memory _p,
    uint256 _fee,
    bytes4 _error
  ) internal {
    vm.expectRevert(_error);
    _relay(_r, _p, _fee);
  }

  /*///////////////////////////////////////////////////////////////
                         SCOPE AND CONTEXT
  //////////////////////////////////////////////////////////////*/

  function test_scopeIsTheKitsScope() public view {
    assertEq(pool.SCOPE(), vm.parseJsonUint(fx, '.scope'));
  }

  function test_contextIsKeccakOfTheEncodedWithdrawalAndScope() public view {
    IPrivacyPool.RelayData memory _r = _request('relayed');
    bytes memory _pre = abi.encode(_withdrawal(_r), pool.SCOPE());
    assertEq(_pre, vm.parseJsonBytes(fx, '.relayed.contextPreimage'), 'the preimage the kit hashes');
    assertEq(uint256(keccak256(_pre)) % P, vm.parseJsonUint(fx, '.relayed.context'));
    assertEq(uint256(keccak256(_pre)) % P, _withdrawProof('relayed').pubSignals[7]);
  }

  /*///////////////////////////////////////////////////////////////
                              DEPOSIT
  //////////////////////////////////////////////////////////////*/

  function test_depositFillsBothTrees() public {
    _depositAll();
    assertEq(pool.currentTreeSize(), 3);
    assertEq(pool.currentLabelTreeSize(), 3);
    assertEq(pool.nonce(), 3);
    assertEq(address(pool).balance, 3.5 ether);
    ProofLib.WithdrawProof memory _p = _withdrawProof('relayed');
    assertEq(pool.currentRoot(), _p.pubSignals[3], 'the state root the kit computes');
    assertEq(pool.currentLabelRoot(), _p.pubSignals[5], 'the label root the kit computes');
    for (uint256 _i; _i < 3; ++_i) {
      uint256 _label = vm.parseJsonUint(fx, string.concat('.labels[', vm.toString(_i), ']'));
      assertEq(pool.depositors(_label), DEPOSITOR);
    }
  }

  function test_depositRefusesBelowMinimum() public {
    uint256 _min = pool.MIN_DEPOSIT();
    vm.prank(DEPOSITOR);
    vm.expectRevert(IPrivacyPool.MinimumDepositAmount.selector);
    pool.deposit{value: _min - 1}(_min - 1, 1);
    vm.prank(DEPOSITOR);
    pool.deposit{value: _min}(_min, 1);
  }

  function test_depositRefusesAValueOtherThanSent() public {
    vm.prank(DEPOSITOR);
    vm.expectRevert(IPrivacyPoolSimple.InsufficientValue.selector);
    pool.deposit{value: 1 ether}(2 ether, 1);
  }

  function test_depositRefuses2To128() public {
    vm.deal(DEPOSITOR, type(uint128).max);
    vm.prank(DEPOSITOR);
    vm.expectRevert(IPrivacyPool.InvalidDepositValue.selector);
    pool.deposit{value: type(uint128).max}(type(uint128).max, 1);
  }

  function test_depositRefusesAUsedPrecommitment() public {
    _deposit(0);
    uint256 _pre = vm.parseJsonUint(fx, '.precommitments[0]');
    vm.prank(DEPOSITOR);
    vm.expectRevert(IPrivacyPool.PrecommitmentAlreadyUsed.selector);
    pool.deposit{value: 1 ether}(1 ether, _pre);
  }

  function test_plainEtherIsRefused() public {
    vm.prank(DEPOSITOR);
    (bool _ok,) = address(pool).call{value: 1 ether}('');
    assertFalse(_ok, 'no receive, no fallback');
  }

  /*///////////////////////////////////////////////////////////////
                          RELAYED WITHDRAW
  //////////////////////////////////////////////////////////////*/

  function test_depositThenRelayedWithdraw() public {
    _depositAll();
    IPrivacyPool.RelayData memory _r = _request('relayed');
    ProofLib.WithdrawProof memory _p = _withdrawProof('relayed');
    uint256 _fee = _r.feeCap;
    vm.expectEmit(address(pool));
    emit IPrivacyPool.Withdrawn(W, RELAYER, 0.4 ether, _fee, _p.pubSignals[1], _p.pubSignals[0]);
    _relay(_r, _p, _fee);
    assertEq(W.balance, 0.4 ether - _fee, 'W gets withdrawnValue less the fee');
    assertEq(RELAYER.balance, _fee, 'the fee recipient gets the fee');
    assertEq(address(pool).balance, 3.1 ether);
    assertTrue(pool.nullifierHashes(_p.pubSignals[1]));
    assertEq(pool.currentTreeSize(), 4, 'the change note is in the state tree');
    assertEq(pool.currentLabelTreeSize(), 3, 'no label for a change note');
  }

  function test_aFeeBelowTheCapPaysTheRestToW() public {
    _depositAll();
    _relay(_request('relayed'), _withdrawProof('relayed'), 0);
    assertEq(W.balance, 0.4 ether);
    assertEq(RELAYER.balance, 0);
  }

  function test_contextPlusOneFails() public {
    _depositAll();
    ProofLib.WithdrawProof memory _p = _withdrawProof('relayed');
    // the verifier the pool deploys: true on the kit's proof, false with context + 1
    assertTrue(pool.WITHDRAWAL_VERIFIER().verifyProof(_p.pA, _p.pB, _p.pC, _p.pubSignals));
    _p.pubSignals[7] += 1;
    assertFalse(pool.WITHDRAWAL_VERIFIER().verifyProof(_p.pA, _p.pB, _p.pC, _p.pubSignals));
    _refusesRelay(_request('relayed'), _p, 0, IPrivacyPool.ContextMismatch.selector);
  }

  function test_aSpentNullifierIsRefused() public {
    _depositAll();
    IPrivacyPool.RelayData memory _r = _request('relayed');
    ProofLib.WithdrawProof memory _p = _withdrawProof('relayed');
    _relay(_r, _p, 0);
    _refusesRelay(_r, _p, 0, IState.NullifierAlreadySpent.selector);
  }

  function test_anUnknownStateRootIsRefused() public {
    // the proof's state root is the tree of three deposits; the pool has had two
    _deposit(0);
    _deposit(1);
    _refusesRelay(_request('relayed'), _withdrawProof('relayed'), 0, IPrivacyPool.UnknownStateRoot.selector);
  }

  function test_anUnknownLabelRootIsRefused() public {
    _depositAll();
    ProofLib.WithdrawProof memory _p = _withdrawProof('relayed');
    _p.pubSignals[5] = vm.parseJsonUint(fx, '.labels[0]') + 1;
    _refusesRelay(_request('relayed'), _p, 0, IPrivacyPool.UnknownLabelRoot.selector);
  }

  function test_aZeroRootIsRefused() public {
    _depositAll();
    ProofLib.WithdrawProof memory _p = _withdrawProof('relayed');
    _p.pubSignals[3] = 0;
    _refusesRelay(_request('relayed'), _p, 0, IPrivacyPool.UnknownStateRoot.selector);
    _p = _withdrawProof('relayed');
    _p.pubSignals[5] = 0;
    _refusesRelay(_request('relayed'), _p, 0, IPrivacyPool.UnknownLabelRoot.selector);
  }

  function test_anOldRootIsAccepted() public {
    // made against the roots of the first two deposits; the pool has had three since
    _depositAll();
    ProofLib.WithdrawProof memory _p = _withdrawProof('old_root');
    assertTrue(_p.pubSignals[3] != pool.currentRoot() && _p.pubSignals[5] != pool.currentLabelRoot());
    _relay(_request('old_root'), _p, 0);
    assertEq(W.balance, 0.5 ether);
  }

  function test_aFeeOverTheCapIsRefused() public {
    _depositAll();
    IPrivacyPool.RelayData memory _r = _request('relayed');
    _refusesRelay(_r, _withdrawProof('relayed'), _r.feeCap + 1, IPrivacyPool.FeeOverCap.selector);
  }

  function test_aFeeOverTheBackstopIsRefused() public {
    // big_cap binds a fee cap of all 0.1 ETH it withdraws; the backstop is half
    _depositAll();
    IPrivacyPool.RelayData memory _r = _request('big_cap');
    ProofLib.WithdrawProof memory _p = _withdrawProof('big_cap');
    _refusesRelay(_r, _p, 0.05 ether + 1, IPrivacyPool.RelayFeeGreaterThanMax.selector);
    _relay(_r, _p, 0.05 ether);
    assertEq(W.balance, 0.05 ether);
    assertEq(RELAYER.balance, 0.05 ether);
  }

  function test_aPastDeadlineIsRefused() public {
    _depositAll();
    IPrivacyPool.RelayData memory _r = _request('relayed');
    ProofLib.WithdrawProof memory _p = _withdrawProof('relayed');
    vm.warp(_r.deadlineMs / 1000 + 1);
    _refusesRelay(_r, _p, 0, IPrivacyPool.DeadlineExpired.selector);
    vm.warp(_r.deadlineMs / 1000);
    _relay(_r, _p, 0);
  }

  function test_anotherRecipientIsRefused() public {
    _depositAll();
    IPrivacyPool.RelayData memory _r = _request('relayed');
    _r.recipient = address(0xBAD);
    _refusesRelay(_r, _withdrawProof('relayed'), 0, IPrivacyPool.ContextMismatch.selector);
  }

  function test_everyOtherRequestFieldIsRefused() public {
    _depositAll();
    ProofLib.WithdrawProof memory _p = _withdrawProof('relayed');
    for (uint256 _i; _i < 5; ++_i) {
      IPrivacyPool.RelayData memory _r = _request('relayed');
      if (_i == 0) _r.feeRecipient = address(0xBAD);
      if (_i == 1) _r.feeCap += 1;
      if (_i == 2) _r.deadlineMs += 1;
      if (_i == 3) _r.refundPrecommitment += 1;
      if (_i == 4) _r.salt = bytes16(uint128(_r.salt) ^ 1);
      _refusesRelay(_r, _p, 0, IPrivacyPool.ContextMismatch.selector);
    }
  }

  function test_anotherProcessooorIsRefused() public {
    _depositAll();
    IPrivacyPool.Withdrawal memory _w = _withdrawal(_request('relayed'));
    _w.processooor = address(0xBEEF);
    ProofLib.WithdrawProof memory _p = _withdrawProof('relayed');
    vm.prank(address(0xBEEF));
    vm.expectRevert(IPrivacyPool.InvalidProcessooor.selector);
    pool.withdraw(_w, _p, 0);
  }

  function test_aSignalAtOrAbovePIsRefused() public {
    // the nullifier hash + p: the same field element; without the verifier's field check it would spend the note twice
    _depositAll();
    IPrivacyPool.RelayData memory _r = _request('relayed');
    ProofLib.WithdrawProof memory _p = _withdrawProof('relayed');
    _p.pubSignals[1] += P;
    _refusesRelay(_r, _p, 0, IPrivacyPool.InvalidProof.selector);
    _p = _withdrawProof('relayed');
    _p.pubSignals[2] += P;
    _refusesRelay(_r, _p, 0, IPrivacyPool.InvalidProof.selector);
    _relay(_r, _withdrawProof('relayed'), 0);
    _p = _withdrawProof('relayed');
    _p.pubSignals[1] += P;
    _refusesRelay(_r, _p, 0, IPrivacyPool.InvalidProof.selector);
  }

  function test_aDepthOver32IsRefused() public {
    _depositAll();
    ProofLib.WithdrawProof memory _p = _withdrawProof('relayed');
    _p.pubSignals[4] = 33;
    _refusesRelay(_request('relayed'), _p, 0, IPrivacyPool.InvalidTreeDepth.selector);
    _p = _withdrawProof('relayed');
    _p.pubSignals[6] = 33;
    _refusesRelay(_request('relayed'), _p, 0, IPrivacyPool.InvalidTreeDepth.selector);
  }

  function test_aChangedProofPointIsRefused() public {
    _depositAll();
    ProofLib.WithdrawProof memory _p = _withdrawProof('relayed');
    _p.pA[0] += 1;
    _refusesRelay(_request('relayed'), _p, 0, IPrivacyPool.InvalidProof.selector);
    _p = _withdrawProof('relayed');
    _p.pC = _withdrawProof('old_root').pC;
    _refusesRelay(_request('relayed'), _p, 0, IPrivacyPool.InvalidProof.selector);
  }

  function test_aZeroOrPoolPayeeIsRefused() public {
    _depositAll();
    ProofLib.WithdrawProof memory _p = _withdrawProof('relayed');
    address[2] memory _bad = [address(0), POOL];
    for (uint256 _i; _i < 2; ++_i) {
      IPrivacyPool.RelayData memory _r = _request('relayed');
      _r.recipient = _bad[_i];
      _refusesRelay(_r, _p, 0, IPrivacyPool.InvalidRecipient.selector);
      _r = _request('relayed');
      _r.feeRecipient = _bad[_i];
      _refusesRelay(_r, _p, 0, IPrivacyPool.InvalidRecipient.selector);
    }
  }

  /*///////////////////////////////////////////////////////////////
                              RAGEQUIT
  //////////////////////////////////////////////////////////////*/

  function test_theDepositorRagequits() public {
    _depositAll();
    uint256 _before = DEPOSITOR.balance;
    vm.prank(DEPOSITOR);
    pool.ragequit(_ragequitProof('ragequit_note3'));
    assertEq(DEPOSITOR.balance, _before + 2 ether);
    vm.prank(DEPOSITOR);
    vm.expectRevert(IState.NullifierAlreadySpent.selector);
    pool.ragequit(_ragequitProof('ragequit_note3'));
  }

  function test_onlyTheDepositorRagequits() public {
    _depositAll();
    ProofLib.RagequitProof memory _p = _ragequitProof('ragequit_note3');
    vm.prank(address(0xBEEF));
    vm.expectRevert(IPrivacyPool.OnlyOriginalDepositor.selector);
    pool.ragequit(_p);
  }

  function test_aRagequitWithAnotherValueIsRefused() public {
    _depositAll();
    ProofLib.RagequitProof memory _p = _ragequitProof('ragequit_note3');
    _p.pubSignals[2] += 1;
    vm.prank(DEPOSITOR);
    vm.expectRevert(IPrivacyPool.InvalidProof.selector);
    pool.ragequit(_p);
  }

  function test_aRagequitOfANoteNeverDepositedIsRefused() public {
    _depositAll();
    vm.prank(DEPOSITOR);
    vm.expectRevert(IPrivacyPool.InvalidCommitment.selector);
    pool.ragequit(_ragequitProof('ragequit_unknown'));
  }

  function test_aWithdrawnNoteCannotBeRagequit() public {
    _depositAll();
    _relay(_request('relayed'), _withdrawProof('relayed'), 0);
    vm.prank(DEPOSITOR);
    vm.expectRevert(IState.NullifierAlreadySpent.selector);
    pool.ragequit(_ragequitProof('ragequit_note1'));
  }

  function test_aRagequitNoteCannotBeWithdrawn() public {
    _depositAll();
    vm.prank(DEPOSITOR);
    pool.ragequit(_ragequitProof('ragequit_note1'));
    _refusesRelay(_request('relayed'), _withdrawProof('relayed'), 0, IState.NullifierAlreadySpent.selector);
  }

  /*///////////////////////////////////////////////////////////////
                           REENTRANCY
  //////////////////////////////////////////////////////////////*/

  function _withdrawCall(string memory _name) internal view returns (bytes memory) {
    return abi.encodeCall(pool.withdraw, (_withdrawal(_request(_name)), _withdrawProof(_name), 0));
  }

  /// Puts a Reenter at `_at` that makes `_call` with `_value` when paid.
  function _reenterAt(address _at, bytes memory _call, uint256 _value) internal returns (Reenter _r) {
    vm.etch(_at, address(new Reenter()).code);
    _r = Reenter(payable(_at));
    _r.arm(address(pool), _call, _value);
  }

  function test_aPayeeCannotReenterWithdraw() public {
    // W, paid by a withdrawal, calls withdraw again with another valid proof: the guard refuses it
    _depositAll();
    Reenter _r = _reenterAt(W, _withdrawCall('old_root'), 0);
    _relay(_request('relayed'), _withdrawProof('relayed'), 0);
    assertEq(_r.tries(), 1);
    assertEq(bytes4(_r.err()), IState.Reentrancy.selector, 'the inner call is refused');
    assertEq(W.balance, 0.4 ether, 'paid once');
  }

  function test_aPayeeCannotReenterDeposit() public {
    _depositAll();
    vm.deal(W, 1 ether);
    Reenter _r = _reenterAt(W, abi.encodeCall(pool.deposit, (1 ether, 7)), 1 ether);
    _relay(_request('relayed'), _withdrawProof('relayed'), 0);
    assertEq(bytes4(_r.err()), IState.Reentrancy.selector, 'the inner deposit is refused');
    assertEq(pool.nonce(), 3);
  }

  function test_aRagequitterCannotReenter() public {
    _depositAll();
    Reenter _r = _reenterAt(DEPOSITOR, _withdrawCall('old_root'), 0);
    vm.prank(DEPOSITOR);
    pool.ragequit(_ragequitProof('ragequit_note3'));
    assertEq(bytes4(_r.err()), IState.Reentrancy.selector, 'the inner withdraw is refused');
  }

  function test_aPayeeThatRefusesEtherRevertsTheWithdrawal() public {
    _depositAll();
    vm.etch(W, hex'5f5ffd'); // PUSH0 PUSH0 REVERT
    _refusesRelay(_request('relayed'), _withdrawProof('relayed'), 0, IPrivacyPoolSimple.FailedToSendNativeAsset.selector);
    assertFalse(pool.nullifierHashes(_withdrawProof('relayed').pubSignals[1]), 'the note is not spent');
  }

  function test_aZeroWithdrawalIsRefused() public {
    _depositAll();
    _refusesRelay(
      _request('zero_withdrawal'), _withdrawProof('zero_withdrawal'), 0, IPrivacyPool.InvalidWithdrawalAmount.selector
    );
  }

  /// Sets a tree (`_slot`: its size; then depth, side nodes, leaves) to 2^32 leaves at depth 32.
  function _fill(uint256 _slot) internal {
    vm.store(POOL, bytes32(_slot), bytes32(uint256(1) << 32));
    vm.store(POOL, bytes32(_slot + 1), bytes32(uint256(32)));
    vm.store(POOL, keccak256(abi.encode(uint256(32), _slot + 2)), bytes32(uint256(1)));
  }

  function test_aStateTreePast32IsRefused() public {
    _fill(3); // _merkleTree
    vm.prank(DEPOSITOR);
    vm.expectRevert(IState.MaxTreeDepthReached.selector);
    pool.deposit{value: 1 ether}(1 ether, 1);
  }

  function test_aLabelTreePast32IsRefused() public {
    _fill(7); // _labelTree
    vm.prank(DEPOSITOR);
    vm.expectRevert(IState.MaxTreeDepthReached.selector);
    pool.deposit{value: 1 ether}(1 ether, 1);
  }

  /*///////////////////////////////////////////////////////////////
                                GAS
  //////////////////////////////////////////////////////////////*/

  function test_gas() public {
    _deposit(0);
    _deposit(1);
    uint256 _v = vm.parseJsonUint(fx, '.values[2]');
    uint256 _pre = vm.parseJsonUint(fx, '.precommitments[2]');
    vm.prank(DEPOSITOR);
    uint256 _g = gasleft();
    pool.deposit{value: _v}(_v, _pre);
    console.log('deposit (third, depth 2) gas:', _g - gasleft());
    IPrivacyPool.Withdrawal memory _w = _withdrawal(_request('relayed'));
    ProofLib.WithdrawProof memory _p = _withdrawProof('relayed');
    vm.prank(address(0xBEEF));
    _g = gasleft();
    pool.withdraw(_w, _p, 0.01 ether);
    console.log('relayed withdraw (depth 2) gas:', _g - gasleft());
  }

  /// A deposit into two trees of 699,050 leaves (0xAAAAA, alternating bits: about half the levels hash) at depth 20.
  function test_gasDepth20() public {
    for (uint256 _slot = 3; _slot <= 7; _slot += 4) {
      vm.store(POOL, bytes32(_slot), bytes32(uint256(0xAAAAA)));
      vm.store(POOL, bytes32(_slot + 1), bytes32(uint256(20)));
      for (uint256 _l; _l <= 20; ++_l) vm.store(POOL, keccak256(abi.encode(_l, _slot + 2)), bytes32(_l + 1));
    }
    vm.prank(DEPOSITOR);
    uint256 _g = gasleft();
    pool.deposit{value: 1 ether}(1 ether, 1);
    console.log('deposit (depth 20, index 0xAAAAA) gas:', _g - gasleft());
    assertEq(pool.currentTreeDepth(), 20);
  }
}

/// A payee that makes one call when first paid, and keeps what the call returned.
contract Reenter {
  address internal target;
  bytes internal call;
  uint256 internal value;
  uint256 public tries;
  bytes public err;

  function arm(address _target, bytes memory _call, uint256 _value) external {
    (target, call, value) = (_target, _call, _value);
  }

  receive() external payable {
    if (tries != 0) return;
    tries = 1;
    (, err) = target.call{value: value}(call);
  }
}
