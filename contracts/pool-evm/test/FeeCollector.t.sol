// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from 'forge-std/Test.sol';
import {Vm} from 'forge-std/Vm.sol';
import {console} from 'forge-std/console.sol';

import {FeeCollector} from '../src/FeeCollector.sol';

/// A sink that refuses ether
contract RefusingSink {
  receive() external payable {
    revert('sink: no');
  }
}

/// A sink that takes ether and calls the collector again from inside its own receive, with what it was paid
contract ReenteringSink {
  FeeCollector internal collector;
  uint256 public seen;

  function aim(FeeCollector _c) external {
    collector = _c;
  }

  receive() external payable {
    ++seen;
    if (seen == 1) {
      (bool _ok,) = address(collector).call{value: msg.value}('');
      require(_ok, 'sink: re-entry failed');
    }
  }
}

/// The fee collector (card evm-fee-collector): a payment emits Paid(from, value) from the collector and the sink holds
/// it when the call returns; a failing forward reverts the payment; nothing but a plain payment runs; the sink is never
/// the zero address; the deployed code has no function, no storage write and no way to change its code.
contract FeeCollectorTest is Test {
  address payable internal constant SINK = payable(address(0x5141));
  address internal constant PAYER = address(0xBEEF);
  FeeCollector internal collector;

  function setUp() public {
    collector = new FeeCollector(SINK);
    vm.deal(PAYER, 10 ether);
  }

  function _pay(address _from, address _to, uint256 _value) internal returns (bool _ok) {
    vm.prank(_from);
    (_ok,) = _to.call{value: _value}('');
  }

  /// The Paid logs `_logs` holds from `_emitter`, as (from, value)
  function _paid(Vm.Log[] memory _logs, address _emitter) internal pure returns (address[] memory _from, uint256[] memory _value) {
    _from = new address[](_logs.length);
    _value = new uint256[](_logs.length);
    uint256 _n;
    for (uint256 _i; _i < _logs.length; ++_i) {
      if (_logs[_i].emitter == _emitter && _logs[_i].topics[0] == FeeCollector.Paid.selector) {
        assertEq(_logs[_i].topics.length, 2, 'Paid has one indexed field');
        _from[_n] = address(uint160(uint256(_logs[_i].topics[1])));
        _value[_n] = abi.decode(_logs[_i].data, (uint256));
        ++_n;
      }
    }
    assembly {
      mstore(_from, _n)
      mstore(_value, _n)
    }
  }

  function test_aPaymentEmitsPaidAndTheSinkReceivesIt() public {
    uint256 _gas = gasleft();
    vm.expectEmit(true, false, false, true, address(collector));
    emit FeeCollector.Paid(PAYER, 0.002 ether);
    assertTrue(_pay(PAYER, address(collector), 0.002 ether), 'the payment lands');
    console.log('gas of a payment, sink cold and empty before', _gas - gasleft());
    assertEq(SINK.balance, 0.002 ether, 'the sink holds the payment');
    assertEq(address(collector).balance, 0, 'the collector keeps nothing');
    assertEq(PAYER.balance, 10 ether - 0.002 ether);
  }

  /// One Paid per payment, each from its own sender and with its own value, all forwarded
  function test_eachPaymentIsItsOwnPaid() public {
    address _other = address(0xCAFE);
    vm.deal(_other, 1 ether);
    vm.recordLogs();
    assertTrue(_pay(PAYER, address(collector), 3));
    assertTrue(_pay(_other, address(collector), 5));
    (address[] memory _from, uint256[] memory _value) = _paid(vm.getRecordedLogs(), address(collector));
    assertEq(_from.length, 2, 'two Paid');
    assertEq(_from[0], PAYER);
    assertEq(_value[0], 3);
    assertEq(_from[1], _other);
    assertEq(_value[1], 5);
    assertEq(SINK.balance, 8);
  }

  function testFuzz_anyPaymentIsForwardedWhole(address _from, uint96 _value) public {
    assumeNotForgeAddress(_from);
    vm.assume(_from != address(collector) && _from != SINK && uint160(_from) > 0xff);
    vm.deal(_from, _value);
    uint256 _before = SINK.balance;
    vm.expectEmit(true, false, false, true, address(collector));
    emit FeeCollector.Paid(_from, _value);
    assertTrue(_pay(_from, address(collector), _value));
    assertEq(SINK.balance - _before, _value, 'the sink gains exactly the value');
    assertEq(address(collector).balance, 0);
  }

  function test_aSinkThatRevertsRevertsThePayment() public {
    FeeCollector _c = new FeeCollector(payable(address(new RefusingSink())));
    vm.prank(PAYER);
    vm.expectRevert(FeeCollector.ForwardFailed.selector);
    (bool _ok,) = address(_c).call{value: 1 ether}('');
    _ok;
    assertEq(PAYER.balance, 10 ether, 'the payer keeps its ether');
    assertEq(address(_c).balance, 0);
  }

  /// A sink that pays the collector again from its own receive gets both payments, each its own Paid; nothing is kept
  function test_aReenteringSinkGetsEachPaymentOnce() public {
    ReenteringSink _sink = new ReenteringSink();
    FeeCollector _c = new FeeCollector(payable(address(_sink)));
    _sink.aim(_c);
    vm.recordLogs();
    assertTrue(_pay(PAYER, address(_c), 7));
    (address[] memory _from, uint256[] memory _value) = _paid(vm.getRecordedLogs(), address(_c));
    assertEq(_from.length, 2);
    assertEq(_from[0], PAYER);
    assertEq(_from[1], address(_sink));
    assertEq(_value[0], 7);
    assertEq(_value[1], 7);
    assertEq(address(_sink).balance, 7, 'the sink ends with the one payment');
    assertEq(address(_c).balance, 0);
  }

  /// No fallback: any calldata, with or without value, reverts and moves nothing
  function test_calldataToTheCollectorReverts() public {
    bytes[4] memory _calls = [
      bytes(hex'00'),
      abi.encodeWithSignature('owner()'),
      abi.encodeWithSignature('setSink(address)', PAYER),
      abi.encodeWithSignature('withdraw()')
    ];
    for (uint256 _i; _i < _calls.length; ++_i) {
      vm.prank(PAYER);
      (bool _ok,) = address(collector).call(_calls[_i]);
      assertFalse(_ok, 'calldata without value is refused');
      vm.prank(PAYER);
      (_ok,) = address(collector).call{value: 1}(_calls[_i]);
      assertFalse(_ok, 'calldata with value is refused');
    }
    assertEq(SINK.balance, 0);
    assertEq(PAYER.balance, 10 ether);
  }

  function test_theConstructorRefusesTheZeroSink() public {
    vm.expectRevert(FeeCollector.ZeroSink.selector);
    new FeeCollector(payable(address(0)));
  }

  /// The sink is in the code (an immutable), read where solc puts it: the runtime holds it, and no storage slot does
  function test_theSinkIsInTheCodeNotInStorage() public {
    FeeCollector _c = new FeeCollector(payable(address(0x1234567890AbcdEF1234567890aBcdef12345678)));
    assertEq(vm.load(address(_c), bytes32(0)), bytes32(0), 'slot 0 is empty');
    bytes memory _code = address(_c).code;
    bool _found;
    for (uint256 _i; _i + 20 <= _code.length; ++_i) {
      bytes20 _w;
      assembly {
        _w := mload(add(add(_code, 0x20), _i))
      }
      if (_w == bytes20(address(0x1234567890AbcdEF1234567890aBcdef12345678))) _found = true;
    }
    assertTrue(_found, 'the runtime holds the sink');
  }

  /// The deployed code, opcode by opcode (PUSH data skipped): no SSTORE, DELEGATECALL, CALLCODE, SELFDESTRUCT, CREATE
  /// or CREATE2, and no dispatcher (no PUSH4 that an EQ follows): receive() is its only entry
  function test_theCodeHasNoFunctionNoStoreAndNoWayToChangeIt() public view {
    bytes memory _code = address(collector).code;
    assertGt(_code.length, 0);
    uint256 _sels;
    for (uint256 _i; _i < _code.length;) {
      uint8 _op = uint8(_code[_i]);
      assertTrue(_op != 0x55, 'SSTORE');
      assertTrue(_op != 0xf4, 'DELEGATECALL');
      assertTrue(_op != 0xf2, 'CALLCODE');
      assertTrue(_op != 0xff, 'SELFDESTRUCT');
      assertTrue(_op != 0xf0, 'CREATE');
      assertTrue(_op != 0xf5, 'CREATE2');
      if (_op >= 0x60 && _op <= 0x7f) {
        if (_op == 0x63 && _i + 5 < _code.length && uint8(_code[_i + 5]) == 0x14) ++_sels;
        _i += 1 + (_op - 0x5f);
      } else {
        _i += 1;
      }
    }
    assertEq(_sels, 0, 'no selector in a dispatcher');
  }
}
