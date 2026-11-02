// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from 'forge-std/Test.sol';

/// What every chain the pool is deployed on already holds, put in place the way it is there.
abstract contract Deploy is Test {
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
}
