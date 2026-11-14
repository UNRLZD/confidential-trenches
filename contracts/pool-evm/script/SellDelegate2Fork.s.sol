// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from 'forge-std/Script.sol';
import {Vm} from 'forge-std/Vm.sol';
import {console} from 'forge-std/console.sol';

import {SellDelegate} from '../src/SellDelegate.sol';
import {IV3SwapRouter} from '../src/adapters/UniswapV3Adapter.sol';

interface IQuoterV2Fork {
  function quoteExactInput(bytes memory path, uint256 amountIn) external returns (uint256, uint160[] memory, uint32[] memory, uint256);
}

interface IERC20Fork {
  function balanceOf(address) external view returns (uint256);
}

/// One sale through a deployed SellDelegate on an anvil fork of a mainnet, sent as real transactions to that fork
/// (card pool-amounts-are-standard-sizes-evm, script/sell-delegate-2-rehearsal.sh): a fresh W (the Hardhat mnemonic's
/// account W_INDEX, a published test key the fork never funded) is bought TOKEN for BUY_WEI by the sender (account 0,
/// funded by anvil), then W's EIP-7702 authorization of DELEGATE and its EIP-712 Sell ride one type-4 transaction from
/// the sender, selling W's whole TOKEN for ETH, paying FEE to FEE_TO and depositing into POOL. Nothing reaches a chain:
/// the sh driver refuses any RPC but loopback.
contract SellDelegate2Fork is Script {
  string internal constant MNEMONIC = 'test test test test test test test test test test test junk';
  uint256 internal constant SNARK_SCALAR_FIELD = 21_888_242_871_839_275_222_246_405_745_257_275_088_548_364_400_416_034_343_698_204_186_575_808_495_617;
  bytes32 internal constant SELL_TYPEHASH = keccak256(
    'Sell(address token,uint256 amount,address target,bytes data,uint256 minOut,address pool,uint256 precommitment,uint256 feeCap,address feeRecipient,uint256 deadline,uint256 nonce)'
  );
  uint256 internal constant FEE = 0.00001 ether;

  address internal delegate;
  address internal pool;
  address internal router;
  address internal weth;
  address internal token;
  uint24 internal tier;
  uint256 internal sender;
  uint256 internal wKey;
  address internal w;

  function run() external {
    delegate = vm.envAddress('DELEGATE');
    pool = vm.envAddress('POOL');
    router = vm.envAddress('ROUTER');
    weth = vm.envAddress('WETH');
    token = vm.envAddress('TOKEN');
    tier = uint24(vm.envUint('FEE_TIER'));
    sender = vm.deriveKey(MNEMONIC, 0);
    wKey = vm.deriveKey(MNEMONIC, uint32(vm.envUint('W_INDEX')));
    w = vm.addr(wKey);
    require(w.code.length == 0 && w.balance == 0, 'W is fresh');

    vm.startBroadcast(sender);
    IV3SwapRouter(router).exactInput{value: vm.envUint('BUY_WEI')}(
      IV3SwapRouter.ExactInputParams({path: abi.encodePacked(weth, tier, token), recipient: w, amountIn: vm.envUint('BUY_WEI'), amountOutMinimum: 1})
    );
    vm.stopBroadcast();

    (SellDelegate.Sell memory _s, uint256 _quoted) = _sellOf();
    bytes memory _sig = _signed(_s);
    Vm.SignedDelegation memory _auth = vm.signDelegation(delegate, wKey);
    uint256 _poolBefore = pool.balance;
    vm.startBroadcast(sender);
    vm.attachDelegation(_auth);
    SellDelegate(payable(w)).sell(_s, FEE, _sig);
    vm.stopBroadcast();

    console.log('W', w);
    console.log('quoted wei', _quoted);
    console.log('pool took wei', pool.balance - _poolBefore);
    console.log('W keeps wei', w.balance);
    console.log('W sell nonce', SellDelegate(payable(w)).nonce());
  }

  /// W's whole TOKEN for ETH paid to W, at 99% of the quote
  function _sellOf() internal returns (SellDelegate.Sell memory _s, uint256 _quoted) {
    uint256 _amount = IERC20Fork(token).balanceOf(w);
    bytes memory _path = abi.encodePacked(token, tier, weth);
    (_quoted,,,) = IQuoterV2Fork(vm.envAddress('QUOTER')).quoteExactInput(_path, _amount);
    _s = SellDelegate.Sell({
      token: token,
      amount: _amount,
      target: router,
      data: abi.encodeCall(IV3SwapRouter.exactInput, (IV3SwapRouter.ExactInputParams({path: _path, recipient: w, amountIn: _amount, amountOutMinimum: 1}))),
      minOut: (_quoted * 99) / 100,
      pool: pool,
      precommitment: uint256(keccak256(abi.encode('sell-delegate-2 rehearsal', w))) % SNARK_SCALAR_FIELD,
      feeCap: FEE,
      feeRecipient: vm.envAddress('FEE_TO'),
      deadline: block.timestamp + 600,
      nonce: 0
    });
  }

  function _signed(SellDelegate.Sell memory _s) internal view returns (bytes memory) {
    (uint8 _v, bytes32 _r, bytes32 _sg) = vm.sign(wKey, _digest(_s, w));
    return abi.encodePacked(_r, _sg, _v);
  }

  /// The Sell's EIP-712 digest under W's own address, written here apart from the delegate's encoder
  function _digest(SellDelegate.Sell memory _s, address _w) internal view returns (bytes32) {
    bytes32 _domain = keccak256(
      abi.encode(keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'), keccak256('Blindfill'), keccak256('1'), block.chainid, _w)
    );
    bytes32 _struct = keccak256(
      abi.encode(SELL_TYPEHASH, _s.token, _s.amount, _s.target, keccak256(_s.data), _s.minOut, _s.pool, _s.precommitment, _s.feeCap, _s.feeRecipient, _s.deadline, _s.nonce)
    );
    return keccak256(abi.encodePacked(hex'1901', _domain, _struct));
  }
}
