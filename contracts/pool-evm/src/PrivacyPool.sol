// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/*

Made with ♥ for 0xBow by

░██╗░░░░░░░██╗░█████╗░███╗░░██╗██████╗░███████╗██████╗░██╗░░░░░░█████╗░███╗░░██╗██████╗░
░██║░░██╗░░██║██╔══██╗████╗░██║██╔══██╗██╔════╝██╔══██╗██║░░░░░██╔══██╗████╗░██║██╔══██╗
░╚██╗████╗██╔╝██║░░██║██╔██╗██║██║░░██║█████╗░░██████╔╝██║░░░░░███████║██╔██╗██║██║░░██║
░░████╔═████║░██║░░██║██║╚████║██║░░██║██╔══╝░░██╔══██╗██║░░░░░██╔══██║██║╚████║██║░░██║
░░╚██╔╝░╚██╔╝░╚█████╔╝██║░╚███║██████╔╝███████╗██║░░██║███████╗██║░░██║██║░╚███║██████╔╝
░░░╚═╝░░░╚═╝░░░╚════╝░╚═╝░░╚══╝╚═════╝░╚══════╝╚═╝░░╚═╝╚══════╝╚═╝░░╚═╝╚═╝░░╚══╝╚═════╝░

https://defi.sucks

*/

// Blindfill: ported from Privacy Pools v1.3.0 (commit c312dcd, packages/contracts/src/contracts/PrivacyPool.sol, with
// the deposit and relay checks of Entrypoint.sol), Copyright 2025 0XBOW LTD, Apache-2.0. Changes, each listed in
// contracts/pool-evm/NOTICE:
// - deposit is public: the depositor is msg.sender, the precommitment is refused a second time (Entrypoint.sol:153-156)
//   and the deposit is at least MIN_DEPOSIT (Entrypoint.sol:159); the pool puts the label in its own label tree;
// - the withdrawal's processooor is the pool itself, so any relayer submits: the request names W (the recipient), the
//   fee recipient, the fee cap and the deadline, and the context binds them; the fee comes out of withdrawnValue;
// - the ASP root is a root the label tree has had, in place of ENTRYPOINT.latestRoot();
// - no windDown;
// - the spend checks are one internal function, _spendChecked, for each method that spends a note.

import {PoseidonT4} from 'poseidon-solidity/PoseidonT4.sol';

import {Constants} from './lib/Constants.sol';
import {ProofLib} from './lib/ProofLib.sol';

import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {State} from './State.sol';

/**
 * @title PrivacyPool
 * @notice Allows publicly depositing and privately withdrawing funds.
 * @dev Withdrawals require a valid proof that the note's label is in the pool's label tree. No key, owner or setter:
 *      nothing can stop deposits, withdrawals or ragequits.
 */
abstract contract PrivacyPool is State, IPrivacyPool {
  using ProofLib for ProofLib.WithdrawProof;
  using ProofLib for ProofLib.RagequitProof;

  /// @inheritdoc IPrivacyPool
  uint256 public constant MIN_DEPOSIT = 0.0001 ether;
  /// @inheritdoc IPrivacyPool
  uint256 public constant MAX_RELAY_FEE_BPS = 5000;

  /**
   * @notice Initializes the contract state addresses
   * @param _withdrawalVerifier Address of the Groth16 verifier for withdrawal proofs
   * @param _ragequitVerifier Address of the Groth16 verifier for ragequit proofs
   * @param _asset Address of the pool asset
   */
  constructor(
    address _withdrawalVerifier,
    address _ragequitVerifier,
    address _asset
  ) State(_asset, _withdrawalVerifier, _ragequitVerifier) {}

  /*///////////////////////////////////////////////////////////////
                             USER METHODS
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPrivacyPool
  function deposit(
    uint256 _value,
    uint256 _precommitmentHash
  ) external payable nonReentrant returns (uint256 _commitment) {
    if (_value < MIN_DEPOSIT) revert MinimumDepositAmount();
    if (_value >= type(uint128).max) revert InvalidDepositValue();

    // Check the precommitment has not been used, then mark it
    if (usedPrecommitments[_precommitmentHash]) revert PrecommitmentAlreadyUsed();
    usedPrecommitments[_precommitmentHash] = true;

    // Compute label
    uint256 _label = uint256(keccak256(abi.encodePacked(SCOPE, ++nonce))) % Constants.SNARK_SCALAR_FIELD;
    // Store depositor
    depositors[_label] = msg.sender;

    // Compute commitment hash
    _commitment = PoseidonT4.hash([_value, _label, _precommitmentHash]);

    // Insert commitment in state (revert if already present)
    _insert(_commitment);
    // The pool approves every deposit: its label joins the label tree
    _insertLabel(_label);

    // Pull funds from caller
    _pull(msg.sender, _value);

    emit Deposited(msg.sender, _commitment, _label, _value, _precommitmentHash);
  }

  /// @inheritdoc IPrivacyPool
  function withdraw(
    Withdrawal memory _withdrawal,
    ProofLib.WithdrawProof memory _proof,
    uint256 _fee
  ) external nonReentrant {
    RelayData memory _data = abi.decode(_withdrawal.data, (RelayData));

    // The two payees: never the zero address or the pool
    if (_data.recipient == address(0) || _data.recipient == address(this)) revert InvalidRecipient();
    if (_data.feeRecipient == address(0) || _data.feeRecipient == address(this)) revert InvalidRecipient();
    // The fee: at most the cap the context binds
    if (_fee > _data.feeCap) revert FeeOverCap();

    uint256 _withdrawn = _spendChecked(_withdrawal, _proof, _data.deadlineMs);

    // The backstop: at most MAX_RELAY_FEE_BPS of the withdrawn value, whatever cap a proof binds
    if (_fee > _withdrawn * MAX_RELAY_FEE_BPS / 10_000) revert RelayFeeGreaterThanMax();

    // The fee comes out of the withdrawn value
    _push(_data.recipient, _withdrawn - _fee);
    if (_fee != 0) _push(_data.feeRecipient, _fee);

    emit Withdrawn(
      _data.recipient,
      _data.feeRecipient,
      _withdrawn,
      _fee,
      _proof.existingNullifierHash(),
      _proof.newCommitmentHash()
    );
  }

  /// @inheritdoc IPrivacyPool
  function ragequit(ProofLib.RagequitProof memory _proof) external nonReentrant {
    // Check if caller is original depositor
    uint256 _label = _proof.label();
    if (depositors[_label] != msg.sender) revert OnlyOriginalDepositor();

    // Verify proof with Groth16 verifier
    if (!RAGEQUIT_VERIFIER.verifyProof(_proof.pA, _proof.pB, _proof.pC, _proof.pubSignals)) revert InvalidProof();

    // Check commitment exists in state
    if (!_isInState(_proof.commitmentHash())) revert InvalidCommitment();

    // Mark existing commitment nullifier as spent
    _spend(_proof.nullifierHash());

    // Transfer out funds to ragequitter
    _push(msg.sender, _proof.value());

    emit Ragequit(msg.sender, _proof.commitmentHash(), _proof.label(), _proof.value());
  }

  /*///////////////////////////////////////////////////////////////
                             SPEND CHECKS
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Every check a spend of a note makes, then the spend: the nullifier is marked and the change commitment
   *         inserted. Each method that pays out a withdraw proof calls it before any payment.
   * @param _withdrawal The withdrawal the proof's context binds; its processooor is this pool
   * @param _proof The withdraw proof
   * @param _deadlineMs The last block time, in ms, the spend may land at (from the request the context binds)
   * @return _withdrawn The proof's withdrawnValue
   */
  function _spendChecked(
    Withdrawal memory _withdrawal,
    ProofLib.WithdrawProof memory _proof,
    uint256 _deadlineMs
  ) internal returns (uint256 _withdrawn) {
    // Check the processooor is this pool
    if (_withdrawal.processooor != address(this)) revert InvalidProcessooor();

    // Check the context matches to ensure its integrity
    if (_proof.context() != uint256(keccak256(abi.encode(_withdrawal, SCOPE))) % Constants.SNARK_SCALAR_FIELD) {
      revert ContextMismatch();
    }

    // Check the deadline, in the chain's own time
    if (block.timestamp * 1000 > _deadlineMs) revert DeadlineExpired();

    // Check the tree depth signals are less than the max tree depth
    if (_proof.stateTreeDepth() > MAX_TREE_DEPTH || _proof.ASPTreeDepth() > MAX_TREE_DEPTH) revert InvalidTreeDepth();

    // Check the state root is one the state tree has had
    if (!_isKnownRoot(_proof.stateRoot())) revert UnknownStateRoot();

    // Check the ASP root is one the label tree has had
    if (!_isKnownLabelRoot(_proof.ASPRoot())) revert UnknownLabelRoot();

    // Check withdrawn amount is non-zero
    _withdrawn = _proof.withdrawnValue();
    if (_withdrawn == 0) revert InvalidWithdrawalAmount();

    // Verify proof with Groth16 verifier
    if (!WITHDRAWAL_VERIFIER.verifyProof(_proof.pA, _proof.pB, _proof.pC, _proof.pubSignals)) revert InvalidProof();

    // Mark existing commitment nullifier as spent
    _spend(_proof.existingNullifierHash());

    // Insert new commitment in state
    _insert(_proof.newCommitmentHash());
  }

  /*///////////////////////////////////////////////////////////////
                          ASSET OVERRIDES
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Handle receiving an asset
   * @dev To be implemented by an asset specific contract
   * @param _sender The address of the user sending funds
   * @param _value The amount of asset being received
   */
  function _pull(address _sender, uint256 _value) internal virtual;

  /**
   * @notice Handle sending an asset
   * @dev To be implemented by an asset specific contract
   * @param _recipient The address of the user receiving funds
   * @param _value The amount of asset being sent
   */
  function _push(address _recipient, uint256 _value) internal virtual;
}
