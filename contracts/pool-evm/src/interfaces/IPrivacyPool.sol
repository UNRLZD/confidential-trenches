// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

// Blindfill: ported from Privacy Pools v1.3.0 (commit c312dcd, packages/contracts/src/interfaces/IPrivacyPool.sol),
// Copyright 2025 0XBOW LTD, Apache-2.0. Changes (contracts/pool-evm/NOTICE): RelayData (from IEntrypoint's, with a
// fee cap and a deadline), deposit(value, precommitment) with msg.sender the depositor, withdraw with the fee, the
// Withdrawn event names the payees, the deposit and relay errors moved in from IEntrypoint, no windDown or PoolDied,
// IncorrectASPRoot is UnknownLabelRoot, the unused ScopeMismatch removed; no ragequit, Ragequit, InvalidCommitment or
// OnlyOriginalDepositor.

import {ProofLib} from '../lib/ProofLib.sol';
import {IState} from 'interfaces/IState.sol';

/**
 * @title IPrivacyPool
 * @notice Interface for the PrivacyPool contract
 */
interface IPrivacyPool is IState {
  /*///////////////////////////////////////////////////////////////
                              STRUCTS
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Struct for the withdrawal request
   * @dev The context is keccak256(abi.encode(Withdrawal, SCOPE)) % SNARK_SCALAR_FIELD
   * @param processooor This pool's own address: any relayer may submit
   * @param data abi.encode(RelayData)
   */
  struct Withdrawal {
    address processooor;
    bytes data;
  }

  /**
   * @notice The request a withdraw proof binds, through its context
   * @param recipient W: receives withdrawnValue less the fee
   * @param feeRecipient Receives the fee
   * @param feeCap The most the fee may be, in the asset's base units; the fee comes out of withdrawnValue
   * @param deadlineMs The last block time, in ms (block.timestamp * 1000), the withdrawal may land at
   * @param refundPrecommitment The device's precommitment for a refund note; bound, unused by withdraw
   * @param salt Keeps two otherwise equal requests apart
   */
  struct RelayData {
    address recipient;
    address feeRecipient;
    uint256 feeCap;
    uint64 deadlineMs;
    uint256 refundPrecommitment;
    bytes16 salt;
  }

  /*///////////////////////////////////////////////////////////////
                              EVENTS
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Emitted when making a user deposit
   * @param _depositor The address of the depositor
   * @param _commitment The commitment hash
   * @param _label The deposit generated label
   * @param _value The deposited amount
   * @param _precommitmentHash The deposit precommitment hash
   */
  event Deposited(
    address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash
  );

  /**
   * @notice Emitted when processing a withdrawal
   * @param _recipient W, paid _value less _fee
   * @param _feeRecipient The fee recipient, paid _fee
   * @param _value The withdrawn value
   * @param _fee The fee
   * @param _spentNullifier The spent nullifier
   * @param _newCommitment The new commitment
   */
  event Withdrawn(
    address indexed _recipient,
    address _feeRecipient,
    uint256 _value,
    uint256 _fee,
    uint256 _spentNullifier,
    uint256 _newCommitment
  );

  /*///////////////////////////////////////////////////////////////
                              ERRORS
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Thrown when failing to verify a withdrawal proof through the Groth16 verifier
   */
  error InvalidProof();

  /**
   * @notice Thrown when the withdrawal's processooor is not this pool
   */
  error InvalidProcessooor();

  /**
   * @notice Thrown when calling `withdraw` with a ASP or state tree depth greater or equal than the max tree depth
   */
  error InvalidTreeDepth();

  /**
   * @notice Thrown when trying to deposit an amount higher than 2**128
   */
  error InvalidDepositValue();

  /**
   * @notice Thrown when the provided context doesn't match the context computed on chain
   */
  error ContextMismatch();

  /**
   * @notice Thrown when the provided state root is not one the state tree has had
   */
  error UnknownStateRoot();

  /**
   * @notice Thrown when the provided ASP root is not one the label tree has had
   */
  error UnknownLabelRoot();

  /**
   * @notice Thrown when a deposit is below MIN_DEPOSIT
   */
  error MinimumDepositAmount();

  /**
   * @notice Thrown when a deposit names a precommitment a deposit already used
   */
  error PrecommitmentAlreadyUsed();

  /**
   * @notice Thrown when the withdrawn value is zero
   */
  error InvalidWithdrawalAmount();

  /**
   * @notice Thrown when the block time is past the request's deadline
   */
  error DeadlineExpired();

  /**
   * @notice Thrown when the fee is over the request's fee cap
   */
  error FeeOverCap();

  /**
   * @notice Thrown when the fee is over MAX_RELAY_FEE_BPS of the withdrawn value
   */
  error RelayFeeGreaterThanMax();

  /**
   * @notice Thrown when a payee is the zero address or this pool
   */
  error InvalidRecipient();

  /*///////////////////////////////////////////////////////////////
                              LOGIC
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Returns the smallest deposit, in the asset's base units
   * @return _min The minimum deposit
   */
  function MIN_DEPOSIT() external view returns (uint256 _min);

  /**
   * @notice Returns the backstop on the fee, in basis points of the withdrawn value
   * @return _bps The backstop
   */
  function MAX_RELAY_FEE_BPS() external view returns (uint256 _bps);

  /**
   * @notice Deposit funds into the Privacy Pool; msg.sender is the depositor
   * @param _value The value being deposited
   * @param _precommitment The precommitment hash
   * @return _commitment The commitment hash
   */
  function deposit(uint256 _value, uint256 _precommitment) external payable returns (uint256 _commitment);

  /**
   * @notice Privately withdraw funds by spending an existing commitment; anyone may submit
   * @param _w The `Withdrawal` struct; its data is abi.encode(RelayData)
   * @param _p The `WithdrawProof` struct containing the withdrawal proof signals
   * @param _fee The fee paid to the request's fee recipient, at most its fee cap, out of withdrawnValue
   */
  function withdraw(Withdrawal memory _w, ProofLib.WithdrawProof memory _p, uint256 _fee) external;

}

/**
 * @title IPrivacyPoolSimple
 * @notice Interface for the PrivacyPool native asset implementation
 */
interface IPrivacyPoolSimple is IPrivacyPool {
  /*///////////////////////////////////////////////////////////////
                              ERRORS
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Thrown when sending less amount of native asset than required
   */
  error InsufficientValue();

  /**
   * @notice Thrown when failing to send native asset to an account
   */
  error FailedToSendNativeAsset();
}
