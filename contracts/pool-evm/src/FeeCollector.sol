// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/**
 * @title FeeCollector
 * @notice The address a sell pays the server's fee to (card evm-fee-collector), so the payment leaves a log only a
 *         real payment makes. SellDelegate pays the fee in native ETH to the feeRecipient W signed
 *         (`_sell.feeRecipient.call{value: _fee}('')`), which leaves no log of its own; with feeRecipient set to this
 *         contract, the payment runs receive(), which emits Paid(msg.sender, msg.value) and forwards every wei to the
 *         sink in the same call, reverting the payment (and so the whole sell) when the forward fails. A Paid from
 *         this address in a sell's receipt therefore means the sink was paid that value by that sender in that
 *         transaction: no other code can emit it, and no call emits it without the value having arrived here.
 *
 *         No owner, no setter, no upgrade, no fallback, no storage, and no function but receive(): the sink is an
 *         immutable (code) set once in the constructor, the network's server sell sender, so the fees paid refill the
 *         gas that sender spends sending sells. The contract holds nothing between calls.
 *
 *         Known trade-off: the sink cannot change. Rotating the sell sender's key means deploying a new collector
 *         for the new sender and pinning its address in place of this one.
 */
contract FeeCollector {
  /// @notice Where every payment goes, in the same call: the network's server sell sender
  address payable internal immutable SINK;

  /// @notice A payment `value` from `from`, already forwarded to the sink when the call returns
  event Paid(address indexed from, uint256 value);

  error ZeroSink();
  error ForwardFailed();

  constructor(address payable _sink) {
    if (_sink == address(0)) revert ZeroSink();
    SINK = _sink;
  }

  /// @notice Takes a payment: emits Paid(msg.sender, msg.value), then forwards msg.value to the sink, reverting if the
  ///         forward fails
  receive() external payable {
    emit Paid(msg.sender, msg.value);
    (bool _sent,) = SINK.call{value: msg.value}('');
    if (!_sent) revert ForwardFailed();
  }
}
