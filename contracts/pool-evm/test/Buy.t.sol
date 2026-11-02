// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {console} from 'forge-std/console.sol';

import {PrivacyPoolSimple} from '../src/PrivacyPoolSimple.sol';
import {ProofLib} from '../src/lib/ProofLib.sol';
import {WithdrawalVerifier} from '../src/verifiers/WithdrawalVerifier.sol';
import {IBuyAdapter} from 'interfaces/IBuyAdapter.sol';
import {IPrivacyPool, IPrivacyPoolSimple} from 'interfaces/IPrivacyPool.sol';
import {IState} from 'interfaces/IState.sol';

import {Deploy} from './Deploy.sol';

/// What the buy tests share: the pool's proofs from test/fixtures/buy-proofs.json, W's published test key (the Hardhat
/// mnemonic's account 0) and the EIP-712 digest W signs, written here apart from the pool's.
abstract contract BuyBase is Deploy {
  string internal constant MNEMONIC = 'test test test test test test test test test test test junk';
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

  /// EIP-712, as the device's wallet encodes it
  function _digest(
    IPrivacyPoolSimple.Buy memory _b,
    uint256 _nullifier,
    uint256 _chainId,
    address _pool
  ) internal pure returns (bytes32) {
    bytes32 _domain = keccak256(
      abi.encode(
        keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
        keccak256('Blindfill'),
        keccak256('1'),
        _chainId,
        _pool
      )
    );
    bytes32 _struct = keccak256(
      abi.encode(
        keccak256('Buy(address adapter,bytes data,uint256 minOut,address token,uint256 nullifier)'),
        _b.adapter,
        keccak256(_b.data),
        _b.minOut,
        _b.token,
        _nullifier
      )
    );
    return keccak256(abi.encodePacked(hex'1901', _domain, _struct));
  }

  function _sign(uint256 _key, bytes32 _d) internal pure returns (bytes memory) {
    (uint8 _v, bytes32 _r, bytes32 _s) = vm.sign(_key, _d);
    return abi.encodePacked(_r, _s, _v);
  }

  /// W's signature of `_b` for `_name`'s note on this pool and chain
  function _signed(IPrivacyPoolSimple.Buy memory _b, string memory _name) internal view returns (bytes memory) {
    return _sign(W_KEY, _digest(_b, _proof(_name).pubSignals[1], block.chainid, POOL));
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

  /// W's signature, made by cast (alloy's EIP-712) as the device makes it, matches the test's digest and the pool's.
  function test_theDevicesSignatureIsEIP712() public view {
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    uint256 _nullifier = vm.parseJsonUint(fx, '.local.signed.message.nullifier');
    assertEq(_nullifier, _proof('local.buy').pubSignals[1], 'the fixture signs the buy proofs nullifier');
    bytes memory _sig = _fixtureSig();
    bytes32 _r;
    bytes32 _s;
    assembly {
      _r := mload(add(_sig, 0x20))
      _s := mload(add(_sig, 0x40))
    }
    assertEq(ecrecover(_digest(_b, _nullifier, 31_337, POOL), uint8(_sig[64]), _r, _s), W);
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
    vm.prank(address(0xBEEF));
    pool.withdraw(_withdrawal('local.buy'), _proof('local.buy'), 0.01 ether);
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
    bytes memory _sig = _sign(vm.deriveKey(MNEMONIC, 1), _digest(_b, _proof('local.buy').pubSignals[1], block.chainid, POOL));
    _refusesBuy('local.buy', 0, _b, _sig, IPrivacyPoolSimple.InvalidSignature.selector);
    _refusesBuy('local.buy', 0, _b, new bytes(65), IPrivacyPoolSimple.InvalidSignature.selector);
  }

  /// A signature replayed: once more on its own note (spent), and on W's other note (another nullifier).
  function test_aReplayedSignatureIsRefused() public {
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    _buy('local.buy', 0, _b, _fixtureSig());
    _refusesBuy('local.buy', 0, _b, _fixtureSig(), IState.NullifierAlreadySpent.selector);
    _refusesBuy('local.buy2', 0, _b, _fixtureSig(), IPrivacyPoolSimple.InvalidSignature.selector);
  }

  /// W's signature for one note is refused with another of W's notes, before anything is spent.
  function test_aSignatureForAnotherNoteIsRefused() public {
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    _refusesBuy('local.buy2', 0, _b, _fixtureSig(), IPrivacyPoolSimple.InvalidSignature.selector);
    _buy('local.buy2', 0, _b, _signed(_b, 'local.buy2'));
  }

  /// A signature made for this pool on this chain is refused once the chain is another; one made for another chain
  /// is refused here.
  function test_anotherChainsSignatureIsRefused() public {
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    uint256 _nullifier = _proof('local.buy').pubSignals[1];
    _refusesBuy('local.buy', 0, _b, _sign(W_KEY, _digest(_b, _nullifier, 8453, POOL)), IPrivacyPoolSimple.InvalidSignature.selector);
    vm.chainId(8453);
    _refusesBuy('local.buy', 0, _b, _fixtureSig(), IPrivacyPoolSimple.InvalidSignature.selector);
    _buy('local.buy', 0, _b, _sign(W_KEY, _digest(_b, _nullifier, 8453, POOL)));
  }

  /// A signature for this pool is refused by the same code at another address (before the proof is looked at), and
  /// one for another pool is refused here.
  function test_anotherPoolsSignatureIsRefused() public {
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    uint256 _nullifier = _proof('local.buy').pubSignals[1];
    address _other = address(0xB1F1F002);
    _refusesBuy('local.buy', 0, _b, _sign(W_KEY, _digest(_b, _nullifier, block.chainid, _other)), IPrivacyPoolSimple.InvalidSignature.selector);
    deployCodeTo('PrivacyPoolSimple.sol:PrivacyPoolSimple', abi.encode(address(pool.WITHDRAWAL_VERIFIER())), _other);
    IPrivacyPool.Withdrawal memory _w = _withdrawal('local.buy');
    ProofLib.WithdrawProof memory _p = _proof('local.buy');
    vm.expectRevert(IPrivacyPoolSimple.InvalidSignature.selector);
    PrivacyPoolSimple(_other).buy(_w, _p, 0, _b, _fixtureSig());
    // signed for the other pool, the signature passes there, and the proof (made for this pool) does not
    vm.expectRevert(IPrivacyPool.InvalidProcessooor.selector);
    PrivacyPoolSimple(_other).buy(_w, _p, 0, _b, _sign(W_KEY, _digest(_b, _nullifier, block.chainid, _other)));
  }

  /// Each field of the buy, changed after W signed it, is refused.
  function test_aChangedBuyIsRefused() public {
    bytes memory _sig = _fixtureSig();
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    _b.adapter = address(0xADA2);
    _refusesBuy('local.buy', 0, _b, _sig, IPrivacyPoolSimple.InvalidSignature.selector);
    _b = _fixtureBuy();
    _b.data = bytes.concat(_b.data, hex'00');
    _refusesBuy('local.buy', 0, _b, _sig, IPrivacyPoolSimple.InvalidSignature.selector);
    _b = _fixtureBuy();
    _b.minOut -= 1;
    _refusesBuy('local.buy', 0, _b, _sig, IPrivacyPoolSimple.InvalidSignature.selector);
    _b = _fixtureBuy();
    _b.token = address(0x70C2);
    _refusesBuy('local.buy', 0, _b, _sig, IPrivacyPoolSimple.InvalidSignature.selector);
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
    assertEq(ecrecover(_digest(_b, _proof('local.buy').pubSignals[1], block.chainid, POOL), _v, _r, _highS), W);
    _refusesBuy('local.buy', 0, _b, abi.encodePacked(_r, _highS, _v), IPrivacyPoolSimple.InvalidSignature.selector);
  }

  function test_aSignatureWithATrailingByteIsRefused() public {
    _refusesBuy('local.buy', 0, _fixtureBuy(), bytes.concat(_fixtureSig(), hex'00'), IPrivacyPoolSimple.InvalidSignature.selector);
  }

  /*///////////////////////////////////////////////////////////////
                         WHAT W GETS
  //////////////////////////////////////////////////////////////*/

  function test_aZeroMinOutIsRefused() public {
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    _b.minOut = 0;
    _refusesBuy('local.buy', 0, _b, _signed(_b, 'local.buy'), IPrivacyPoolSimple.InvalidMinOut.selector);
  }

  function test_minOutNotMetIsRefused() public {
    adapter.setMode(MockAdapter.Mode.Short);
    _refusesBuy('local.buy', 0, _fixtureBuy(), _fixtureSig(), IPrivacyPoolSimple.MinOutNotMet.selector);
    assertFalse(pool.nullifierHashes(_proof('local.buy').pubSignals[1]), 'the note is not spent');
    adapter.setMode(MockAdapter.Mode.Exact);
    _buy('local.buy', 0, _fixtureBuy(), _fixtureSig());
    assertEq(token.balanceOf(W), _fixtureBuy().minOut, 'exactly minOut lands');
  }

  function test_anAdapterThatSendsElsewhereIsRefused() public {
    adapter.setMode(MockAdapter.Mode.Elsewhere);
    _refusesBuy('local.buy', 0, _fixtureBuy(), _fixtureSig(), IPrivacyPoolSimple.MinOutNotMet.selector);
  }

  /// Tokens W already holds count for nothing: only the rise does.
  function test_tokensWAlreadyHoldsDoNotCount() public {
    token.mint(W, 1_000_000);
    adapter.setMode(MockAdapter.Mode.Nothing);
    _refusesBuy('local.buy', 0, _fixtureBuy(), _fixtureSig(), IPrivacyPoolSimple.MinOutNotMet.selector);
  }

  /// The adapter, paid by a buy, calls withdraw with another valid proof, or buy again: the guard refuses both.
  function test_anAdapterCannotReenter() public {
    IPrivacyPoolSimple.Buy memory _b2 = _fixtureBuy();
    bytes[2] memory _calls = [
      abi.encodeCall(pool.withdraw, (_withdrawal('local.buy2'), _proof('local.buy2'), 0)),
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
    vm.prank(address(0xBEEF));
    vm.expectRevert(IPrivacyPool.InvalidRelayData.selector);
    pool.withdraw(_w, _p, 0);
    IPrivacyPoolSimple.Buy memory _b = _fixtureBuy();
    bytes memory _sig = _signed(_b, 'local.trailing');
    vm.prank(address(0xBEEF));
    vm.expectRevert(IPrivacyPool.InvalidRelayData.selector);
    pool.buy(_w, _p, 0, _b, _sig);
  }

  uint256 internal constant Constants_P =
    21_888_242_871_839_275_222_246_405_745_257_275_088_548_364_400_416_034_343_698_204_186_575_808_495_617;

  /*///////////////////////////////////////////////////////////////
                         SHARED CHECKS
  //////////////////////////////////////////////////////////////*/

  /// buy takes withdraw's fee and payee checks: a fee over the cap, and over the backstop's half, are refused.
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
    Nothing
  }

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
  }
}
