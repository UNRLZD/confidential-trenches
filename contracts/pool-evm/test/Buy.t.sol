// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Vm} from 'forge-std/Vm.sol';
import {console} from 'forge-std/console.sol';

import {PrivacyPoolSimple} from '../src/PrivacyPoolSimple.sol';
import {ProofLib} from '../src/lib/ProofLib.sol';
import {WithdrawalVerifier} from '../src/verifiers/WithdrawalVerifier.sol';
import {IBuyAdapter} from 'interfaces/IBuyAdapter.sol';
import {IPrivacyPool, IPrivacyPoolSimple} from 'interfaces/IPrivacyPool.sol';
import {IState} from 'interfaces/IState.sol';

import {Signing} from './Signing.sol';

/// What the buy tests share: the pool's proofs from test/fixtures/buy-proofs.json and W's published test key (the
/// Hardhat mnemonic's account 0); the EIP-712 digests are test/Signing.sol's.
abstract contract BuyBase is Signing {
  uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

  string internal fx;
  PrivacyPoolSimple internal pool;
  address internal POOL;
  address internal W;
  uint256 internal W_KEY;
  address internal RELAYER;

  function _setUpPool(string memory _set) internal {
    fx = vm.readFile('test/fixtures/buy-proofs.json');
    POOL = vm.parseJsonAddress(fx, string.concat('.', _set, '.pool'));
    W_KEY = vm.deriveKey(MNEMONIC, 0);
    W = vm.addr(W_KEY);
    assertEq(W, vm.parseJsonAddress(fx, string.concat('.', _set, '.buy.request.recipient')), 'W is the proofs recipient');
    RELAYER = vm.parseJsonAddress(fx, string.concat('.', _set, '.buy.request.feeRecipient'));
    assertEq(block.chainid, vm.parseJsonUint(fx, string.concat('.', _set, '.chainId')));
    deployCodeTo('PrivacyPoolSimple.sol:PrivacyPoolSimple', abi.encode(address(new WithdrawalVerifier())), POOL);
    pool = PrivacyPoolSimple(POOL);
    assertEq(pool.SCOPE(), vm.parseJsonUint(fx, string.concat('.', _set, '.scope')));
    address _depositor = vm.parseJsonAddress(fx, string.concat('.', _set, '.depositor'));
    vm.deal(_depositor, 100 ether);
    for (uint256 _i; _i < 3; ++_i) {
      string memory _k = string.concat('.', _set, '.values[', vm.toString(_i), ']');
      uint256 _v = vm.parseJsonUint(fx, _k);
      _k = string.concat('.', _set, '.precommitments[', vm.toString(_i), ']');
      vm.prank(_depositor);
      pool.deposit{value: _v}(_v, vm.parseJsonUint(fx, _k));
    }
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

  function _withdrawal(string memory _name) internal view returns (IPrivacyPool.Withdrawal memory) {
    return IPrivacyPool.Withdrawal({processooor: POOL, data: abi.encode(_request(_name))});
  }

  function _proof(string memory _name) internal view returns (ProofLib.WithdrawProof memory _p) {
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

  /// The Buy digest for `_name`'s proof (its nullifier and context) on `_pool` at `_chainId`
  function _digest(
    IPrivacyPoolSimple.Buy memory _b,
    string memory _name,
    uint256 _chainId,
    address _pool
  ) internal view returns (bytes32) {
    ProofLib.WithdrawProof memory _p = _proof(_name);
    return _buyDigest(_b, _p.pubSignals[1], _p.pubSignals[7], _p.pubSignals[2], _chainId, _pool);
  }

  /// W's signature that takes `_name`'s proof as a withdraw on this pool and chain
  function _wsig(string memory _name) internal view returns (bytes memory) {
    ProofLib.WithdrawProof memory _p = _proof(_name);
    return _sign(W_KEY, _withdrawDigest(_p.pubSignals[1], _p.pubSignals[7], _p.pubSignals[2], block.chainid, POOL));
  }

  /// W's signature of `_b` for `_name`'s note on this pool and chain
  function _signed(IPrivacyPoolSimple.Buy memory _b, string memory _name) internal view returns (bytes memory) {
    return _sign(W_KEY, _digest(_b, _name, block.chainid, POOL));
  }

  function _buy(
    string memory _name,
    uint256 _fee,
    IPrivacyPoolSimple.Buy memory _b,
    bytes memory _sig
  ) internal {
    vm.prank(address(0xBEEF));
    pool.buy(_withdrawal(_name), _proof(_name), _fee, _b, _sig);
  }

  /// Any revert, for _paysOut's reason
  bytes4 internal constant ANY_REVERT = 0x00000000;
  /// No reason check, for _paysOut (a swap that burns all the gas it is given cannot be run apart in a test)
  bytes4 internal constant NO_REASON = 0xffffffff;

  /// The swap of `_b` fails, with `_err` when run apart as the pool runs it (buySwap from the pool), so the buy lands
  /// as a withdraw: buy returns false, the note is spent, the change leaf inserted, the fee paid to the request's fee
  /// recipient, W paid the rest in the native asset, the adapter left nothing, and the pool's one log is Withdrawn,
  /// byte for byte as withdraw emits it
  function _paysOut(
    string memory _name,
    uint256 _fee,
    IPrivacyPoolSimple.Buy memory _b,
    bytes memory _sig,
    bytes4 _err
  ) internal {
    ProofLib.WithdrawProof memory _p = _proof(_name);
    uint256 _rest = _p.pubSignals[2] - _fee;
    if (_err != NO_REASON) {
      uint256 _snap = vm.snapshotState();
      vm.prank(POOL);
      if (_err == ANY_REVERT) vm.expectRevert();
      else vm.expectRevert(_err);
      pool.buySwap(_b, W, _rest);
      vm.revertToState(_snap);
    }
    address _fr = _request(_name).feeRecipient;
    uint256[5] memory _before = [_fr.balance, W.balance, POOL.balance, pool.currentTreeSize(), _b.adapter.balance];
    vm.recordLogs();
    vm.prank(address(0xBEEF));
    assertFalse(pool.buy(_withdrawal(_name), _p, _fee, _b, _sig), 'buy says the swap failed');
    _onlyWithdrawn(_fr, _p, _fee);
    assertTrue(pool.nullifierHashes(_p.pubSignals[1]), 'the note is spent');
    assertEq(pool.currentTreeSize(), _before[3] + 1, 'the change leaf is in');
    assertEq(_fr.balance - _before[0], _fee, 'the fee recipient got the fee');
    assertEq(W.balance - _before[1], _rest, 'W got the rest in the native asset');
    assertEq(_before[2] - POOL.balance, _p.pubSignals[2], 'the pool paid out the chunk');
    assertEq(_b.adapter.balance, _before[4], 'the adapter kept nothing');
  }

  /// The recorded logs hold one release log from the pool (LeafInserted aside): Withdrawn for W, `_fr`, `_p` and
  /// `_fee`, as withdraw emits it, and no Bought
  function _onlyWithdrawn(address _fr, ProofLib.WithdrawProof memory _p, uint256 _fee) internal {
    Vm.Log[] memory _logs = vm.getRecordedLogs();
    uint256 _n;
    for (uint256 _i; _i < _logs.length; ++_i) {
      if (_logs[_i].emitter != POOL || _logs[_i].topics[0] == IState.LeafInserted.selector) continue;
      ++_n;
      assertEq(_logs[_i].topics.length, 2);
      assertEq(_logs[_i].topics[0], IPrivacyPool.Withdrawn.selector, 'Withdrawn');
      assertEq(_logs[_i].topics[1], bytes32(uint256(uint160(W))), 'topic 1 is W');
      assertEq(_logs[_i].data, abi.encode(_fr, _p.pubSignals[2], _fee, _p.pubSignals[1], _p.pubSignals[0]));
    }
    assertEq(_n, 1, 'the pool emits one release log');
  }
}

/// The buy with the kit's real proofs and a mock adapter and token at the addresses W's fixture signature names.
contract BuyTest is BuyBase {
  // block time in the tests: 2030-03-17, below every request's deadline (2,000,000,000,000 ms)
  uint256 internal constant NOW = 1_900_000_000;

  MockToken internal token;
  MockAdapter internal adapter;

  function setUp() public {
    _deployPoseidon();
    vm.warp(NOW);
    _setUpPool('local');
    address _token = vm.parseJsonAddress(fx, '.local.signed.message.token');
    address _adapter = vm.parseJsonAddress(fx, '.local.signed.message.adapter');
    deployCodeTo('Buy.t.sol:MockToken', _token);
    deployCodeTo('Buy.t.sol:MockAdapter', _adapter);
    token = MockToken(_token);
    adapter = MockAdapter(payable(_adapter));
  }

  /// The buy W signed in the fixture, with cast's EIP-712
  function _fixtureBuy() internal view returns (IPrivacyPoolSimple.Buy memory _b) {
    _b.adapter = address(adapter);
    _b.data = vm.parseJsonBytes(fx, '.local.signed.message.data');
    _b.minOut = vm.parseJsonUint(fx, '.local.signed.message.minOut');
    _b.token = address(token);
  }

  function _fixtureSig() internal view returns (bytes memory) {
    return vm.parseJsonBytes(fx, '.local.signed.signature');
  }

  function _refusesBuy(
    string memory _name,
    uint256 _fee,
    IPrivacyPoolSimple.Buy memory _b,
    bytes memory _sig,
    bytes4 _error
  ) internal {
    vm.expectRevert(_error);
    _buy(_name, _fee, _b, _sig);
  }

  /*///////////////////////////////////////////////////////////////
                              LANDS
  //////////////////////////////////////////////////////////////*/

  /// W's signatures, made by cast (alloy's EIP-712) as the device makes them, match the test's digests and the pool's.
  function test_theDevicesSignaturesAreEIP712() public view {
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    ProofLib.WithdrawProof memory _p = _proof('local.buy');
    assertEq(vm.parseJsonUint(fx, '.local.signed.message.nullifier'), _p.pubSignals[1], 'the buy proofs nullifier');
    assertEq(vm.parseJsonUint(fx, '.local.signed.message.context'), _p.pubSignals[7], 'and context');
    assertEq(vm.parseJsonUint(fx, '.local.signed.message.value'), _p.pubSignals[2], 'and value');
    assertEq(_recover(_digest(_b, 'local.buy', 31_337, POOL), _fixtureSig()), W);
    assertEq(vm.parseJsonUint(fx, '.local.signedWithdraw.message.nullifier'), _p.pubSignals[1]);
    assertEq(vm.parseJsonUint(fx, '.local.signedWithdraw.message.context'), _p.pubSignals[7]);
    assertEq(vm.parseJsonUint(fx, '.local.signedWithdraw.message.value'), _p.pubSignals[2]);
    assertEq(_recover(_withdrawDigest(_p.pubSignals[1], _p.pubSignals[7], _p.pubSignals[2], 31_337, POOL), _fixtureWithdrawSig()), W);
  }

  function _recover(bytes32 _d, bytes memory _sig) internal pure returns (address) {
    bytes32 _r;
    bytes32 _s;
    assembly {
      _r := mload(add(_sig, 0x20))
      _s := mload(add(_sig, 0x40))
    }
    return ecrecover(_d, uint8(_sig[64]), _r, _s);
  }

  function _fixtureWithdrawSig() internal view returns (bytes memory) {
    return vm.parseJsonBytes(fx, '.local.signedWithdraw.signature');
  }

  function test_buyLandsAndWHoldsMinOut() public {
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    ProofLib.WithdrawProof memory _p = _proof('local.buy');
    uint256 _fee = 0.01 ether;
    uint256 _rest = 0.4 ether - _fee;
    vm.expectEmit(POOL);
    emit IPrivacyPoolSimple.Bought(
      W, RELAYER, 0.4 ether, _fee, _p.pubSignals[1], _p.pubSignals[0], address(token), adapter.rate() * _rest
    );
    _buy('local.buy', _fee, _b, _fixtureSig());
    assertEq(token.balanceOf(W), adapter.rate() * _rest, 'W holds what the adapter bought');
    assertGe(token.balanceOf(W), _b.minOut, 'at least minOut');
    assertEq(address(adapter).balance, _rest, 'the adapter got the chunk less the fee');
    assertEq(adapter.lastRecipient(), W, 'the adapter was told W');
    assertEq(adapter.lastMinOut(), _b.minOut, 'and minOut');
    assertEq(keccak256(adapter.lastData()), keccak256(_b.data), 'and the route');
    assertEq(RELAYER.balance, _fee, 'the fee recipient got the fee');
    assertEq(W.balance, 0, 'W got no ether');
    assertEq(POOL.balance, 3.1 ether, 'the pool paid out the chunk');
    assertTrue(pool.nullifierHashes(_p.pubSignals[1]));
    assertEq(pool.currentTreeSize(), 4, 'the change note is in the state tree');
  }

  /// One ready proof serves either: the same proof and request land as a withdraw, or as a buy.
  function test_oneProofServesWithdrawOrBuy() public {
    uint256 _snap = vm.snapshotState();
    IPrivacyPool.Withdrawal memory _w = _withdrawal('local.buy');
    ProofLib.WithdrawProof memory _p = _proof('local.buy');
    bytes memory _sig = _fixtureWithdrawSig();
    vm.prank(address(0xBEEF));
    pool.withdraw(_w, _p, 0.01 ether, _sig);
    assertEq(W.balance, 0.39 ether);
    vm.revertToState(_snap);
    _buy('local.buy', 0.01 ether, _fixtureBuy(), _fixtureSig());
    assertEq(W.balance, 0);
    assertGt(token.balanceOf(W), 0);
  }

  /// With fee 0 the whole chunk goes to the adapter and nothing is sent to the fee recipient.
  function test_aBuyWithFeeZeroSendsTheWholeChunk() public {
    vm.etch(RELAYER, hex'5f5ffd'); // PUSH0 PUSH0 REVERT
    _buy('local.buy', 0, _fixtureBuy(), _fixtureSig());
    assertEq(address(adapter).balance, 0.4 ether);
  }

  /*///////////////////////////////////////////////////////////////
                         W'S SIGNATURE
  //////////////////////////////////////////////////////////////*/

  function test_aWrongSignerIsRefused() public {
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    bytes memory _sig = _sign(vm.deriveKey(MNEMONIC, 1), _digest(_b, 'local.buy', block.chainid, POOL));
    _refusesBuy('local.buy', 0, _b, _sig, IPrivacyPool.InvalidSignature.selector);
    _refusesBuy('local.buy', 0, _b, new bytes(65), IPrivacyPool.InvalidSignature.selector);
  }

  /// A signature replayed: once more on its own note (spent), and on W's other note (another nullifier).
  function test_aReplayedSignatureIsRefused() public {
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    _buy('local.buy', 0, _b, _fixtureSig());
    _refusesBuy('local.buy', 0, _b, _fixtureSig(), IState.NullifierAlreadySpent.selector);
    _refusesBuy('local.buy2', 0, _b, _fixtureSig(), IPrivacyPool.InvalidSignature.selector);
  }

  /// W's signature for one note is refused with another of W's notes, before anything is spent.
  function test_aSignatureForAnotherNoteIsRefused() public {
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    _refusesBuy('local.buy2', 0, _b, _fixtureSig(), IPrivacyPool.InvalidSignature.selector);
    _buy('local.buy2', 0, _b, _signed(_b, 'local.buy2'));
  }

  /// A signature made for this pool on this chain is refused once the chain is another; one made for another chain
  /// is refused here.
  function test_anotherChainsSignatureIsRefused() public {
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    _refusesBuy('local.buy', 0, _b, _sign(W_KEY, _digest(_b, 'local.buy', 8453, POOL)), IPrivacyPool.InvalidSignature.selector);
    vm.chainId(8453);
    _refusesBuy('local.buy', 0, _b, _fixtureSig(), IPrivacyPool.InvalidSignature.selector);
    _buy('local.buy', 0, _b, _sign(W_KEY, _digest(_b, 'local.buy', 8453, POOL)));
  }

  /// A signature for this pool is refused by the same code at another address (before the proof is looked at), and
  /// one for another pool is refused here.
  function test_anotherPoolsSignatureIsRefused() public {
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    address _other = address(0xB1F1F002);
    _refusesBuy('local.buy', 0, _b, _sign(W_KEY, _digest(_b, 'local.buy', block.chainid, _other)), IPrivacyPool.InvalidSignature.selector);
    deployCodeTo('PrivacyPoolSimple.sol:PrivacyPoolSimple', abi.encode(address(pool.WITHDRAWAL_VERIFIER())), _other);
    IPrivacyPool.Withdrawal memory _w = _withdrawal('local.buy');
    ProofLib.WithdrawProof memory _p = _proof('local.buy');
    vm.expectRevert(IPrivacyPool.InvalidSignature.selector);
    PrivacyPoolSimple(_other).buy(_w, _p, 0, _b, _fixtureSig());
    // signed for the other pool, the signature passes there, and the proof (made for this pool) does not
    vm.expectRevert(IPrivacyPool.InvalidProcessooor.selector);
    PrivacyPoolSimple(_other).buy(_w, _p, 0, _b, _sign(W_KEY, _digest(_b, 'local.buy', block.chainid, _other)));
  }

  /// Each field of the buy, changed after W signed it, is refused.
  function test_aChangedBuyIsRefused() public {
    bytes memory _sig = _fixtureSig();
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    _b.adapter = address(0xADA2);
    _refusesBuy('local.buy', 0, _b, _sig, IPrivacyPool.InvalidSignature.selector);
    _b = _fixtureBuy();
    _b.data = bytes.concat(_b.data, hex'00');
    _refusesBuy('local.buy', 0, _b, _sig, IPrivacyPool.InvalidSignature.selector);
    _b = _fixtureBuy();
    _b.minOut -= 1;
    _refusesBuy('local.buy', 0, _b, _sig, IPrivacyPool.InvalidSignature.selector);
    _b = _fixtureBuy();
    _b.token = address(0x70C2);
    _refusesBuy('local.buy', 0, _b, _sig, IPrivacyPool.InvalidSignature.selector);
    _buy('local.buy', 0, _fixtureBuy(), _sig);
  }

  /// The same signature with s flipped to the upper half (and v flipped) still recovers W; the pool refuses it.
  function test_aHighSSignatureIsRefused() public {
    bytes memory _sig = _fixtureSig();
    bytes32 _r;
    bytes32 _s;
    assembly {
      _r := mload(add(_sig, 0x20))
      _s := mload(add(_sig, 0x40))
    }
    uint8 _v = uint8(_sig[64]) == 27 ? 28 : 27;
    bytes32 _highS = bytes32(N - uint256(_s));
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    assertEq(ecrecover(_digest(_b, 'local.buy', block.chainid, POOL), _v, _r, _highS), W);
    _refusesBuy('local.buy', 0, _b, abi.encodePacked(_r, _highS, _v), IPrivacyPool.InvalidSignature.selector);
  }

  function test_aSignatureWithATrailingByteIsRefused() public {
    _refusesBuy('local.buy', 0, _fixtureBuy(), bytes.concat(_fixtureSig(), hex'00'), IPrivacyPool.InvalidSignature.selector);
  }

  /*///////////////////////////////////////////////////////////////
                         WHAT W GETS
  //////////////////////////////////////////////////////////////*/

  function test_aZeroMinOutIsRefused() public {
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    _b.minOut = 0;
    _refusesBuy('local.buy', 0, _b, _signed(_b, 'local.buy'), IPrivacyPoolSimple.InvalidMinOut.selector);
  }

  /// Too little out: the swap is undone and the buy pays out as a withdraw, the fee paid (card pool-evm-buy-pays-revert)
  function test_minOutNotMetPaysOut() public {
    uint256 _snap = vm.snapshotState();
    adapter.setMode(MockAdapter.Mode.Short);
    _paysOut('local.buy', 0.01 ether, _fixtureBuy(), _fixtureSig(), IPrivacyPoolSimple.MinOutNotMet.selector);
    assertEq(token.balanceOf(W), 0, 'W holds none of the token');
    vm.revertToState(_snap);
    adapter.setMode(MockAdapter.Mode.Exact);
    _buy('local.buy', 0, _fixtureBuy(), _fixtureSig());
    assertEq(token.balanceOf(W), _fixtureBuy().minOut, 'exactly minOut lands');
  }

  function test_anAdapterThatSendsElsewherePaysOut() public {
    adapter.setMode(MockAdapter.Mode.Elsewhere);
    _paysOut('local.buy', 0.01 ether, _fixtureBuy(), _fixtureSig(), IPrivacyPoolSimple.MinOutNotMet.selector);
    assertEq(token.balanceOf(address(0xD0D0)), 0, 'what the adapter sent elsewhere is undone');
  }

  /// Tokens W already holds count for nothing: only the rise does.
  function test_tokensWAlreadyHoldsDoNotCount() public {
    token.mint(W, 1_000_000);
    adapter.setMode(MockAdapter.Mode.Nothing);
    _paysOut('local.buy', 0.01 ether, _fixtureBuy(), _fixtureSig(), IPrivacyPoolSimple.MinOutNotMet.selector);
  }

  /*///////////////////////////////////////////////////////////////
                A SWAP THAT FAILS (pool-evm-buy-pays-revert)
  //////////////////////////////////////////////////////////////*/

  /// The adapter reverts: the buy lands, the fee paid, W paid the rest
  function test_anAdapterThatRevertsPaysOut() public {
    adapter.setMode(MockAdapter.Mode.Revert);
    _paysOut('local.buy', 0.01 ether, _fixtureBuy(), _fixtureSig(), MockAdapter.Refused.selector);
  }

  /// The token's balanceOf reverts on an odd block (the review's griefer, 02:31Z): a simulation on an even block
  /// passes, and the buy that lands on an odd block still lands and pays the fee
  function test_aTokenWhoseBalanceOfRevertsPaysOut() public {
    address _parity = address(0xC0FFEE);
    deployCodeTo('Buy.t.sol:ParityToken', _parity);
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    _b.token = _parity;
    bytes memory _sig = _signed(_b, 'local.buy');
    uint256 _snap = vm.snapshotState();
    vm.roll(1000);
    assertTrue(_bought('local.buy', 0.01 ether, _b, _sig), 'the even block buys');
    assertEq(ParityToken(_parity).held(W), adapter.rate() * 0.39 ether);
    vm.revertToState(_snap);
    vm.roll(1001);
    _paysOut('local.buy', 0.01 ether, _b, _sig, ParityToken.Odd.selector);
    assertEq(ParityToken(_parity).held(W), 0, 'the mint is undone');
  }

  /// The token's balanceOf answers the first read and reverts on the second, after the adapter paid W
  function test_aTokenWhoseSecondBalanceOfRevertsPaysOut() public {
    address _parity = address(0xC0FFEE);
    deployCodeTo('Buy.t.sol:ParityToken', _parity);
    ParityToken(_parity).revertOnceHolding();
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    _b.token = _parity;
    vm.roll(1000);
    _paysOut('local.buy', 0.01 ether, _b, _signed(_b, 'local.buy'), ParityToken.Odd.selector);
  }

  /// buy as the sender calls it, its answer
  function _bought(
    string memory _name,
    uint256 _fee,
    IPrivacyPoolSimple.Buy memory _b,
    bytes memory _sig
  ) internal returns (bool) {
    vm.prank(address(0xBEEF));
    return pool.buy(_withdrawal(_name), _proof(_name), _fee, _b, _sig);
  }

  /// A swap that burns every unit of gas it is given: from the least gas that passes the floor up to 10,000,000 the
  /// buy lands and pays out; with less it reverts at the floor (SwapGasTooLow) and spends nothing
  function test_aSwapThatBurnsAllItsGasPaysOut() public {
    address _hog = address(0xADA1);
    vm.etch(_hog, address(new GasHogAdapter()).code);
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    _b.adapter = _hog;
    bytes memory _sig = _signed(_b, 'local.buy');
    uint256 _least = _leastGas(_b, _sig);
    console.log('least gas a buy with a swap that burns all its gas lands with:', _least);
    uint256[5] memory _gs = [_least, _least + 1, _least + 63, _least + 1_000_000, 10_000_000];
    for (uint256 _i; _i < 5; ++_i) {
      uint256 _snap = vm.snapshotState();
      vm.prank(address(0xBEEF));
      assertFalse(pool.buy{gas: _gs[_i]}(_withdrawal('local.buy'), _proof('local.buy'), 0.01 ether, _b, _sig));
      assertTrue(pool.nullifierHashes(_proof('local.buy').pubSignals[1]), 'spent');
      assertEq(W.balance, 0.39 ether, 'W paid the rest');
      assertEq(RELAYER.balance, 0.01 ether, 'the fee paid');
      vm.revertToState(_snap);
    }
    vm.prank(address(0xBEEF));
    vm.expectRevert(IPrivacyPoolSimple.SwapGasTooLow.selector);
    pool.buy{gas: _least - 1}(_withdrawal('local.buy'), _proof('local.buy'), 0.01 ether, _b, _sig);
    assertFalse(pool.nullifierHashes(_proof('local.buy').pubSignals[1]), 'below the floor nothing is spent');
    _paysOut('local.buy', 0.01 ether, _b, _sig, NO_REASON);
  }

  /// The least gas limit with which buy does not revert (binary search; each try rolled back)
  function _leastGas(IPrivacyPoolSimple.Buy memory _b, bytes memory _sig) internal returns (uint256 _hi) {
    IPrivacyPool.Withdrawal memory _w = _withdrawal('local.buy');
    ProofLib.WithdrawProof memory _p = _proof('local.buy');
    uint256 _lo = 100_000;
    _hi = 10_000_000;
    while (_hi - _lo > 1) {
      uint256 _mid = (_lo + _hi) / 2;
      uint256 _snap = vm.snapshotState();
      vm.prank(address(0xBEEF));
      try pool.buy{gas: _mid}(_w, _p, 0.01 ether, _b, _sig) returns (bool) {
        _hi = _mid;
      } catch {
        _lo = _mid;
      }
      vm.revertToState(_snap);
    }
  }

  /// The reserve: with the least gas, the swap burns all it gets, and what the failure path leaves unspent of
  /// BUY_FAIL_GAS (vm.lastCallGas) shows what it used: one push to an empty W (a new account) and Withdrawn
  function test_gasTheFailurePathUsesOfItsReserve() public {
    address _hog = address(0xADA1);
    vm.etch(_hog, address(new GasHogAdapter()).code);
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    _b.adapter = _hog;
    bytes memory _sig = _signed(_b, 'local.buy');
    uint256 _least = _leastGas(_b, _sig);
    assertEq(W.balance, 0);
    assertEq(vm.getNonce(W), 0, 'W is an empty account: the push pays for a new account');
    vm.prank(address(0xBEEF));
    assertFalse(pool.buy{gas: _least}(_withdrawal('local.buy'), _proof('local.buy'), 0.01 ether, _b, _sig));
    Vm.Gas memory _g = vm.lastCallGas();
    console.log('failure path: gas left of the reserve at the least gas:', _g.gasRemaining);
    console.log('failure path: used of BUY_FAIL_GAS:', pool.BUY_FAIL_GAS() - _g.gasRemaining);
    assertLt(pool.BUY_FAIL_GAS() - _g.gasRemaining, pool.BUY_FAIL_GAS() / 2, 'the reserve is over twice what it needs');
  }

  /// buySwap gets at least BUY_SWAP_GAS: at the least gas that passes the floor, the adapter's frame starts with 63/64
  /// of it less buySwap's own first steps (the calldata, a cold token's balanceOf: under 20,000)
  function test_theSwapGetsAtLeastBuySwapGas() public {
    address _meter = address(0xADA2);
    vm.etch(_meter, address(new GasMeterAdapter()).code);
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    _b.adapter = _meter;
    bytes memory _sig = _signed(_b, 'local.buy');
    uint256 _least = _leastGas(_b, _sig);
    vm.prank(address(0xBEEF));
    pool.buy{gas: _least}(_withdrawal('local.buy'), _proof('local.buy'), 0.01 ether, _b, _sig);
    uint256 _got = uint256(vm.load(_meter, 0));
    console.log('the adapter starts with, at the least gas:', _got);
    assertGe(_got, (pool.BUY_SWAP_GAS() - 20_000) * 63 / 64);
  }

  /// buySwap answers only the pool: a direct call, and the adapter calling it from inside a buy, are refused
  function test_onlyThePoolCallsBuySwap() public {
    vm.prank(address(0xBEEF));
    vm.expectRevert(IPrivacyPoolSimple.OnlyPool.selector);
    pool.buySwap(_fixtureBuy(), address(0xBEEF), 1 ether);
    adapter.setReenter(POOL, abi.encodeCall(pool.buySwap, (_fixtureBuy(), address(adapter), 1 ether)));
    assertTrue(_bought('local.buy', 0.01 ether, _fixtureBuy(), _fixtureSig()), 'the buy itself lands');
    assertEq(bytes4(adapter.err()), IPrivacyPoolSimple.OnlyPool.selector, 'the inner call is refused');
  }

  /// A landed buy's one release log is Bought (beside LeafInserted), byte for byte as before this card: the same topics (its signature's hash
  /// and W) and the same data, in the same order; buy answers true
  function test_boughtIsByteEqual() public {
    ProofLib.WithdrawProof memory _p = _proof('local.buy');
    vm.recordLogs();
    assertTrue(_bought('local.buy', 0.01 ether, _fixtureBuy(), _fixtureSig()));
    Vm.Log[] memory _logs = vm.getRecordedLogs();
    uint256 _n;
    for (uint256 _i; _i < _logs.length; ++_i) {
      if (_logs[_i].emitter != POOL || _logs[_i].topics[0] == IState.LeafInserted.selector) continue;
      ++_n;
      assertEq(_logs[_i].topics.length, 2);
      assertEq(_logs[_i].topics[0], keccak256('Bought(address,address,uint256,uint256,uint256,uint256,address,uint256)'));
      assertEq(_logs[_i].topics[1], bytes32(uint256(uint160(W))));
      assertEq(
        _logs[_i].data,
        abi.encode(RELAYER, 0.4 ether, 0.01 ether, _p.pubSignals[1], _p.pubSignals[0], address(token), 1000 * 0.39 ether)
      );
    }
    assertEq(_n, 1, 'the pool emits one release log');
  }

  /// The adapter, paid by a buy, calls withdraw with another valid proof, or buy again: the guard refuses both.
  function test_anAdapterCannotReenter() public {
    IPrivacyPoolSimple.Buy memory _b2 = _fixtureBuy();
    bytes[2] memory _calls = [
      abi.encodeCall(pool.withdraw, (_withdrawal('local.buy2'), _proof('local.buy2'), 0, _wsig('local.buy2'))),
      abi.encodeCall(pool.buy, (_withdrawal('local.buy2'), _proof('local.buy2'), 0, _b2, _signed(_b2, 'local.buy2')))
    ];
    for (uint256 _i; _i < 2; ++_i) {
      uint256 _snap = vm.snapshotState();
      adapter.setReenter(POOL, _calls[_i]);
      _buy('local.buy', 0, _fixtureBuy(), _fixtureSig());
      assertEq(bytes4(adapter.err()), IState.Reentrancy.selector, 'the inner call is refused');
      assertFalse(pool.nullifierHashes(_proof('local.buy2').pubSignals[1]), 'the other note is not spent');
      vm.revertToState(_snap);
    }
  }

  /*///////////////////////////////////////////////////////////////
                         THE REQUEST'S BYTES
  //////////////////////////////////////////////////////////////*/

  /// A proof whose request is RelayData and one more word: its context is right, abi.decode reads the request, and
  /// both withdraw and buy refuse it by its length.
  function test_trailingRelayDataIsRefused() public {
    IPrivacyPool.Withdrawal memory _w = _withdrawal('local.trailing');
    _w.data = bytes.concat(_w.data, vm.parseJsonBytes(fx, '.local.trailing.request.trailing'));
    assertEq(_w.data.length, 224);
    ProofLib.WithdrawProof memory _p = _proof('local.trailing');
    assertEq(uint256(keccak256(abi.encode(_w, pool.SCOPE()))) % Constants_P, _p.pubSignals[7], 'the context binds it');
    bytes memory _ws = _wsig('local.trailing');
    vm.prank(address(0xBEEF));
    vm.expectRevert(IPrivacyPool.InvalidRelayData.selector);
    pool.withdraw(_w, _p, 0, _ws);
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    bytes memory _sig = _signed(_b, 'local.trailing');
    vm.prank(address(0xBEEF));
    vm.expectRevert(IPrivacyPool.InvalidRelayData.selector);
    pool.buy(_w, _p, 0, _b, _sig);
  }

  uint256 internal constant Constants_P =
    21_888_242_871_839_275_222_246_405_745_257_275_088_548_364_400_416_034_343_698_204_186_575_808_495_617;

  /*///////////////////////////////////////////////////////////////
                       W PICKS THE RELEASE
  //////////////////////////////////////////////////////////////*/

  function _withdrawWith(string memory _name, uint256 _fee, bytes memory _sig) internal {
    IPrivacyPool.Withdrawal memory _w = _withdrawal(_name);
    ProofLib.WithdrawProof memory _p = _proof(_name);
    vm.prank(address(0xBEEF));
    pool.withdraw(_w, _p, _fee, _sig);
  }

  /// Whoever sees W's buy (the helper, the sequencer, anyone) cannot land its proof as a withdraw.
  function test_aBuysSignatureIsRefusedAsAWithdraw() public {
    vm.expectRevert(IPrivacyPool.InvalidSignature.selector);
    _withdrawWith('local.buy', 0.01 ether, _fixtureSig());
    _buy('local.buy', 0.01 ether, _fixtureBuy(), _fixtureSig());
  }

  function test_aWithdrawsSignatureIsRefusedAsABuy() public {
    vm.expectRevert(IPrivacyPool.InvalidSignature.selector);
    _buy('local.buy', 0, _fixtureBuy(), _fixtureWithdrawSig());
    _withdrawWith('local.buy', 0, _fixtureWithdrawSig());
    assertEq(W.balance, 0.4 ether);
  }

  /// A withdraw with no signature, a zero one, another key's, a high-s one or one with a trailing byte is refused,
  /// and the note stays unspent.
  function test_aWithdrawWithNoOrAWrongSignatureIsRefused() public {
    ProofLib.WithdrawProof memory _p = _proof('local.buy');
    bytes32 _d = _withdrawDigest(_p.pubSignals[1], _p.pubSignals[7], _p.pubSignals[2], block.chainid, POOL);
    bytes memory _good = _fixtureWithdrawSig();
    bytes32 _r;
    bytes32 _s;
    assembly {
      _r := mload(add(_good, 0x20))
      _s := mload(add(_good, 0x40))
    }
    bytes[5] memory _bad = [
      bytes(''),
      new bytes(65),
      _sign(vm.deriveKey(MNEMONIC, 1), _d),
      abi.encodePacked(_r, bytes32(N - uint256(_s)), uint8(_good[64]) == 27 ? uint8(28) : uint8(27)),
      bytes.concat(_good, hex'00')
    ];
    for (uint256 _i; _i < 5; ++_i) {
      vm.expectRevert(IPrivacyPool.InvalidSignature.selector);
      _withdrawWith('local.buy', 0, _bad[_i]);
    }
    assertFalse(pool.nullifierHashes(_p.pubSignals[1]), 'the note is not spent');
    _withdrawWith('local.buy', 0, _good);
  }

  /// W's signature for one proof of a note, paired with another proof of the same note (here, twice the fee cap), is
  /// refused, as a buy and as a withdraw; the other proof lands with its own signature, as a buy or as a withdraw.
  function test_aSignatureForAnotherProofOfTheNoteIsRefused() public {
    assertEq(_proof('local.swap').pubSignals[1], _proof('local.buy').pubSignals[1], 'one note, one nullifier');
    assertTrue(_proof('local.swap').pubSignals[7] != _proof('local.buy').pubSignals[7], 'two contexts');
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    vm.expectRevert(IPrivacyPool.InvalidSignature.selector);
    _buy('local.swap', 0.02 ether, _b, _fixtureSig());
    vm.expectRevert(IPrivacyPool.InvalidSignature.selector);
    _withdrawWith('local.swap', 0.02 ether, _fixtureWithdrawSig());
    uint256 _snap = vm.snapshotState();
    _buy('local.swap', 0.02 ether, _b, _signed(_b, 'local.swap'));
    assertEq(RELAYER.balance, 0.02 ether);
    vm.revertToState(_snap);
    _withdrawWith('local.swap', 0.02 ether, _wsig('local.swap'));
    assertEq(RELAYER.balance, 0.02 ether);
  }

  /// W's signature for a chunk of a note, paired with a proof of the same note and request (so the same nullifier and
  /// context) for a bigger chunk, is refused, as a buy and as a withdraw; the bigger proof lands with its own signature.
  function test_aSignatureForASmallerChunkOfTheNoteIsRefused() public {
    ProofLib.WithdrawProof memory _big = _proof('local.big');
    assertEq(_big.pubSignals[1], _proof('local.buy').pubSignals[1], 'one note, one nullifier');
    assertEq(_big.pubSignals[7], _proof('local.buy').pubSignals[7], 'one request, one context');
    assertEq(_big.pubSignals[2], 2 * _proof('local.buy').pubSignals[2], 'twice the value');
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    vm.expectRevert(IPrivacyPool.InvalidSignature.selector);
    _buy('local.big', 0, _b, _signed(_b, 'local.buy'));
    vm.expectRevert(IPrivacyPool.InvalidSignature.selector);
    _withdrawWith('local.big', 0, _wsig('local.buy'));
    uint256 _snap = vm.snapshotState();
    _buy('local.big', 0, _b, _signed(_b, 'local.big'));
    assertTrue(pool.nullifierHashes(_big.pubSignals[1]));
    vm.revertToState(_snap);
    _withdrawWith('local.big', 0, _wsig('local.big'));
    assertEq(W.balance, _big.pubSignals[2]);
  }

  /*///////////////////////////////////////////////////////////////
                         SHARED CHECKS
  //////////////////////////////////////////////////////////////*/

  /// buy takes withdraw's fee check: a fee over W's cap is refused.
  function test_buyTakesTheFeeChecks() public {
    _refusesBuy('local.buy', 0.01 ether + 1, _fixtureBuy(), _fixtureSig(), IPrivacyPool.FeeOverCap.selector);
  }

  function test_gasBuyMockAdapter() public {
    IPrivacyPool.Withdrawal memory _w = _withdrawal('local.buy');
    ProofLib.WithdrawProof memory _p = _proof('local.buy');
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    bytes memory _sig = _fixtureSig();
    vm.prank(address(0xBEEF));
    uint256 _g = gasleft();
    pool.buy(_w, _p, 0.01 ether, _b, _sig);
    console.log('buy (depth 2, mock adapter) gas:', _g - gasleft());
  }

  /// A state tree of depth 32 with 2^32 - 1 leaves, so the change commitment's insert hashes all 32 levels
  function _deepTree() internal {
    vm.store(POOL, bytes32(uint256(3)), bytes32(uint256(type(uint32).max))); // size
    vm.store(POOL, bytes32(uint256(4)), bytes32(uint256(32))); // depth
    for (uint256 _i; _i < 32; ++_i) vm.store(POOL, keccak256(abi.encode(_i, uint256(5))), bytes32(_i + 1)); // sideNodes
  }

  /// withdraw at depth 2 (the change commitment at index 3: 2 hashes) or 32 (32 hashes), each the test's first call
  function _gasWithdraw(bool _deep) internal {
    IPrivacyPool.Withdrawal memory _w = _withdrawal('local.buy');
    ProofLib.WithdrawProof memory _p = _proof('local.buy');
    bytes memory _sig = _fixtureWithdrawSig();
    if (_deep) _deepTree();
    vm.prank(address(0xBEEF));
    uint256 _g = gasleft();
    pool.withdraw(_w, _p, 0.01 ether, _sig);
    console.log(_deep ? 'withdraw depth 32 gas:' : 'withdraw depth 2 gas:', _g - gasleft());
    assertEq(pool.currentTreeDepth(), _deep ? 32 : 2);
  }

  /// buy through the mock adapter at depth 2 or 32
  function _gasBuy(bool _deep) internal {
    IPrivacyPool.Withdrawal memory _w = _withdrawal('local.buy');
    ProofLib.WithdrawProof memory _p = _proof('local.buy');
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    bytes memory _sig = _fixtureSig();
    if (_deep) _deepTree();
    vm.prank(address(0xBEEF));
    uint256 _g = gasleft();
    pool.buy(_w, _p, 0.01 ether, _b, _sig);
    console.log(_deep ? 'buy (mock adapter) depth 32 gas:' : 'buy (mock adapter) depth 2 gas:', _g - gasleft());
    assertEq(pool.currentTreeDepth(), _deep ? 32 : 2);
  }

  function test_gasWithdrawDepth2() public {
    _gasWithdraw(false);
  }

  function test_gasWithdrawDepth32() public {
    _gasWithdraw(true);
  }

  function test_gasBuyMockAdapterDepth2() public {
    _gasBuy(false);
  }

  function test_gasBuyMockAdapterDepth32() public {
    _gasBuy(true);
  }

  /*///////////////////////////////////////////////////////////////
                      THE REVIEW'S TESTS (b61f0f5)
  //////////////////////////////////////////////////////////////*/

  /// The pool's digests equal ethers 6.13.5's (TypedDataEncoder.hash) for the fixture's Buy and Withdraw: a third
  /// encoder's, not only cast's and the test's own
  function test_R_digestsEqualEthers() public view {
    ProofLib.WithdrawProof memory _p = _proof('local.buy');
    assertEq(
      _digest(_fixtureBuy(), 'local.buy', 31_337, POOL),
      0x5e1c4296528ec3262a8694bf1c1e8a283776a21968e41d0be636a71f1fc8f784
    );
    assertEq(
      _withdrawDigest(_p.pubSignals[1], _p.pubSignals[7], _p.pubSignals[2], 31_337, POOL),
      0xdb39366dbb89d418cdf2e3d09d0f568836bd69569aaa1c6b1ba885683c24df85
    );
  }

  /// v as a y-parity (0 or 1) or any other value but 27 or 28: ecrecover gives 0, which is never the recipient
  function test_R_vOtherThan27Or28IsRefused() public {
    uint8[4] memory _vs = [uint8(0), 1, 29, 255];
    for (uint256 _i; _i < 4; ++_i) {
      bytes memory _b = bytes.concat(_fixtureSig());
      _b[64] = bytes1(_vs[_i]);
      _refusesBuy('local.buy', 0, _fixtureBuy(), _b, IPrivacyPool.InvalidSignature.selector);
      bytes memory _w = bytes.concat(_fixtureWithdrawSig());
      _w[64] = bytes1(_vs[_i]);
      vm.expectRevert(IPrivacyPool.InvalidSignature.selector);
      _withdrawWith('local.buy', 0, _w);
    }
    _buy('local.buy', 0, _fixtureBuy(), _fixtureSig());
  }

  /// W's signatures land with v of 27 and of 28: the pool reads v from the signature, whichever it is
  function test_signaturesWithVOf27And28BothLand() public {
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    bool[2] memory _seen;
    uint256 _snap = vm.snapshotState();
    for (uint256 _m = 1; _m <= 40 && !(_seen[0] && _seen[1]); ++_m) {
      _b.minOut = _m;
      bytes memory _sig = _signed(_b, 'local.buy');
      uint8 _v = uint8(_sig[64]);
      if (_seen[_v - 27]) continue;
      _seen[_v - 27] = true;
      _buy('local.buy', 0, _b, _sig);
      assertTrue(pool.nullifierHashes(_proof('local.buy').pubSignals[1]), 'landed');
      vm.revertToState(_snap);
    }
    assertTrue(_seen[0] && _seen[1], 'both v values were tried');
  }

  /// A 64-byte EIP-2098 compact signature is refused: only 65 bytes
  function test_R_compactSignatureIsRefused() public {
    bytes memory _sig = _fixtureSig();
    bytes memory _c = new bytes(64);
    for (uint256 _i; _i < 64; ++_i) _c[_i] = _sig[_i];
    _refusesBuy('local.buy', 0, _fixtureBuy(), _c, IPrivacyPool.InvalidSignature.selector);
  }

  /// A buy sent with too little gas for the floor reverts whole: the note stays unspent and nothing is paid; with
  /// enough for the floor, a swap that burns all its gas pays out (test_aSwapThatBurnsAllItsGasPaysOut)
  function test_R_gasGriefingLandsNothing() public {
    address _hog = address(0xADA1);
    vm.etch(_hog, address(new GasHogAdapter()).code);
    uint256 _poolBefore = POOL.balance;
    IPrivacyPool.Withdrawal memory _w = _withdrawal('local.buy');
    ProofLib.WithdrawProof memory _p = _proof('local.buy');
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    _b.adapter = _hog;
    bytes memory _sig = _signed(_b, 'local.buy');
    for (uint256 _g = 300_000; _g <= 900_000; _g += 100_000) {
      vm.prank(address(0xBEEF));
      try pool.buy{gas: _g}(_w, _p, 0.01 ether, _b, _sig) {
        revert('a buy with too little gas for the floor landed');
      } catch {}
      assertFalse(pool.nullifierHashes(_p.pubSignals[1]), 'the note is not spent');
      assertEq(POOL.balance, _poolBefore, 'the pool paid nothing');
      assertEq(RELAYER.balance, 0, 'no fee');
    }
  }

  /// The fee recipient, paid first in a buy, tries to withdraw W's other note in the same call: refused
  function test_R_feeRecipientCannotReenterBuy() public {
    deployCodeTo('Buy.t.sol:FeeReenter', RELAYER);
    ProofLib.WithdrawProof memory _p2 = _proof('local.buy2');
    FeeReenter(payable(RELAYER)).set(
      POOL, abi.encodeCall(pool.withdraw, (_withdrawal('local.buy2'), _p2, 0, _wsig('local.buy2')))
    );
    _buy('local.buy', 0.01 ether, _fixtureBuy(), _fixtureSig());
    assertTrue(FeeReenter(payable(RELAYER)).tried());
    assertEq(bytes4(FeeReenter(payable(RELAYER)).err()), IState.Reentrancy.selector);
    assertFalse(pool.nullifierHashes(_p2.pubSignals[1]), 'buy2 not spent');
  }

  /// Anyone who sees W's signed buy can land it with any fee from 0 to the cap: the fee still goes only to the bound
  /// fee recipient, and W still gets at least minOut (NOTICE change 6)
  function test_R_aThirdPartyLandsWsBuyWithItsOwnFee() public {
    vm.prank(address(0xA77AC4));
    pool.buy(_withdrawal('local.buy'), _proof('local.buy'), 0, _fixtureBuy(), _fixtureSig());
    assertEq(RELAYER.balance, 0);
    assertEq(address(0xA77AC4).balance, 0);
    assertGe(token.balanceOf(W), _fixtureBuy().minOut);
  }
}

/// An adapter that burns every unit of gas it is given
contract GasHogAdapter is IBuyAdapter {
  function buy(address, address, uint256, bytes calldata) external payable {
    while (true) {}
  }
}

/// An adapter that writes the gas it starts with to slot 0 and buys exactly minOut
contract GasMeterAdapter is IBuyAdapter {
  function buy(address _token, address _recipient, uint256 _minOut, bytes calldata) external payable {
    uint256 _g = gasleft();
    assembly {
      sstore(0, _g)
    }
    MockToken(_token).mint(_recipient, _minOut);
  }
}

/// A token whose balanceOf reverts on an odd block, or, once set, on the read after W first holds some
contract ParityToken {
  error Odd();

  mapping(address => uint256) public held;
  bool internal once;

  function revertOnceHolding() external {
    once = true;
  }

  function mint(address _to, uint256 _amount) external {
    held[_to] += _amount;
  }

  function balanceOf(address _a) external view returns (uint256) {
    if (block.number % 2 == 1 || (once && held[_a] != 0)) revert Odd();
    return held[_a];
  }
}

/// A fee recipient that, when paid, makes a call set in advance and keeps its error
contract FeeReenter {
  address internal target;
  bytes internal call;
  bytes public err;
  bool public tried;

  function set(address _t, bytes memory _c) external {
    (target, call) = (_t, _c);
  }

  receive() external payable {
    if (target != address(0)) {
      tried = true;
      (, err) = target.call(call);
    }
  }
}

/// A token with a public mint
contract MockToken {
  mapping(address => uint256) public balanceOf;

  function mint(address _to, uint256 _amount) external {
    balanceOf[_to] += _amount;
  }
}

/// An adapter that buys `rate` tokens a wei, or misbehaves as set
contract MockAdapter is IBuyAdapter {
  enum Mode {
    Rate,
    Exact,
    Short,
    Elsewhere,
    Nothing,
    Revert
  }

  error Refused();

  uint256 public constant rate = 1000;
  Mode internal mode;
  address internal target;
  bytes internal call;
  bytes public err;
  address public lastRecipient;
  uint256 public lastMinOut;
  bytes public lastData;

  function setMode(Mode _m) external {
    mode = _m;
  }

  function setReenter(address _target, bytes memory _call) external {
    (target, call) = (_target, _call);
  }

  function buy(address _token, address _recipient, uint256 _minOut, bytes calldata _data) external payable {
    (lastRecipient, lastMinOut, lastData) = (_recipient, _minOut, _data);
    if (target != address(0)) (, err) = target.call(call);
    if (mode == Mode.Rate) MockToken(_token).mint(_recipient, msg.value * rate);
    if (mode == Mode.Exact) MockToken(_token).mint(_recipient, _minOut);
    if (mode == Mode.Short) MockToken(_token).mint(_recipient, _minOut - 1);
    if (mode == Mode.Elsewhere) MockToken(_token).mint(address(0xD0D0), msg.value * rate);
    if (mode == Mode.Revert) revert Refused();
  }
}
