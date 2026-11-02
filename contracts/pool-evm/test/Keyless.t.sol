// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {PrivacyPoolSimple} from '../src/PrivacyPoolSimple.sol';
import {WithdrawalVerifier} from '../src/verifiers/WithdrawalVerifier.sol';

import {Deploy} from './Deploy.sol';

/// The pool's deployed code, read opcode by opcode: no DELEGATECALL, CALLCODE, SELFDESTRUCT, CREATE or CREATE2, and a
/// dispatcher with exactly the listed selectors. Its storage layout and ABI are read by test/layout.test.mjs.
contract KeylessTest is Deploy {
  bytes internal code;
  address internal pool;

  function setUp() public {
    _deployPoseidon();
    pool = address(new PrivacyPoolSimple(address(new WithdrawalVerifier())));
    code = pool.code;
    assertGt(code.length, 0);
  }

  /// The opcodes of `code`, PUSH data skipped, and each PUSH4 immediate an EQ follows (the dispatcher's table).
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

  function test_noDelegatecallCallcodeSelfdestructOrCreate() public view {
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

  function test_theDispatcherHasExactlyTheListedSelectors() public view {
    bytes4[20] memory _want = [
      bytes4(0x4800d97f), // ASSET()
      0xc072c05c, // MAX_RELAY_FEE_BPS()
      0xe38df5f0, // MAX_TREE_DEPTH()
      0xe1e158a5, // MIN_DEPOSIT()
      0x33d09200, // SCOPE()
      0x8735eb2b, // WITHDRAWAL_VERIFIER()
      0x50f3e219, // currentLabelRoot()
      0x33fd7edb, // currentLabelTreeDepth()
      0x4181445b, // currentLabelTreeSize()
      0xfdab463d, // currentRoot()
      0x4a2b75c8, // currentTreeDepth()
      0xa8f0f95a, // currentTreeSize()
      0xe2bbb158, // deposit(uint256,uint256)
      0xbbfaea22, // labelRootTimes(uint256)
      0x4b278d9c, // stateRootTimes(uint256)
      0xaffed0e0, // nonce()
      0x1f79a1e9, // nullifierHashes(uint256)
      0xa1cc748b, // usedPrecommitments(uint256)
      0x8a3bff22, // withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256)
      0x3edadd79 // buy((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,(address,bytes,uint256,address),bytes)
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

  function test_ragequitIsAbsent() public {
    // Privacy Pools' ragequit, its verifier and its depositors record: none is in the dispatcher, and a call fails
    bytes4[3] memory _gone = [
      bytes4(0x71235b34), // ragequit((uint256[2],uint256[2][2],uint256[2],uint256[4]))
      0xda662925, // RAGEQUIT_VERIFIER()
      0xe4b2fb79 // depositors(uint256)
    ];
    (, bytes4[] memory _got) = _walk();
    address _pool = pool;
    for (uint256 _i; _i < 3; ++_i) {
      for (uint256 _j; _j < _got.length; ++_j) assertTrue(_got[_j] != _gone[_i], 'a ragequit selector is in the code');
      (bool _ok,) = _pool.call(abi.encodePacked(_gone[_i], new bytes(32 * 16)));
      assertFalse(_ok, 'a ragequit call is refused');
    }
  }

  function test_anUnknownSelectorAndPlainValueAreRefused() public {
    address _pool = pool;
    (bool _ok,) = _pool.call(abi.encodeWithSignature('owner()'));
    assertFalse(_ok, 'no fallback');
    vm.deal(address(this), 1 ether);
    (_ok,) = _pool.call{value: 1}('');
    assertFalse(_ok, 'no receive');
  }
}
