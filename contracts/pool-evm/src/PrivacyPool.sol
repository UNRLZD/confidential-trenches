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
// - no windDown, and no ragequit (nor its depositors record): every label is in the pool's own label tree, so a
//   withdraw proof always works, and ragequit would only add a public exit that links a deposit to its exit;
// - the spend checks are one internal function, _spendChecked, for each method that spends a note, and a relayed
//   release's checks one more, _release, for withdraw and buy; the request is exactly RelayData's 192 bytes;
// - W signs every release (EIP-712: a Withdraw or a Buy, with the proof's nullifier and context), so only W picks how
//   a proof is used.

import {PoseidonT4} from 'poseidon-solidity/PoseidonT4.sol';

import {Constants} from './lib/Constants.sol';
import {ProofLib} from './lib/ProofLib.sol';

import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {State} from './State.sol';

/**
 * @title PrivacyPool
 * @notice Allows publicly depositing and privately withdrawing funds.
 * @dev Withdrawals require a valid proof that the note's label is in the pool's label tree. No key, owner or setter:
 *      nothing can stop deposits or withdrawals.
 */
abstract contract PrivacyPool is State, IPrivacyPool {
  using ProofLib for ProofLib.WithdrawProof;

  /// @inheritdoc IPrivacyPool
  uint256 public constant MIN_DEPOSIT = 0.0001 ether;
  /// @inheritdoc IPrivacyPool
  uint256 public constant MAX_RELAY_FEE_BPS = 5000;

  /// @notice EIP-712's domain type, and the domain's name and version
  bytes32 internal constant DOMAIN_TYPEHASH =
    keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
  bytes32 internal constant NAME_HASH = keccak256('Blindfill');
  bytes32 internal constant VERSION_HASH = keccak256('1');
  /// @notice The type W signs to take a proof as a withdraw: the note's nullifier and the proof's context
  bytes32 internal constant WITHDRAW_TYPEHASH = keccak256('Withdraw(uint256 nullifier,uint256 context)');
  /// @notice Half the secp256k1 group order: a signature's s is at most this (EIP-2), so it has one form
  uint256 internal constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

  /**
   * @notice Initializes the contract state addresses
   * @param _withdrawalVerifier Address of the Groth16 verifier for withdrawal proofs
   * @param _asset Address of the pool asset
   */
  constructor(
    address _withdrawalVerifier,
    address _asset
  ) State(_asset, _withdrawalVerifier) {}

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

    // A precommitment is a field element: X + p would hash as X, a second note with X's nullifier
    if (_precommitmentHash >= Constants.SNARK_SCALAR_FIELD) revert InvalidPrecommitment();
    // Check the precommitment has not been used, then mark it
    if (usedPrecommitments[_precommitmentHash]) revert PrecommitmentAlreadyUsed();
    usedPrecommitments[_precommitmentHash] = true;

    // Compute label
    uint256 _label = uint256(keccak256(abi.encodePacked(SCOPE, ++nonce))) % Constants.SNARK_SCALAR_FIELD;
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
    uint256 _fee,
    bytes memory _signature
  ) external nonReentrant {
    RelayData memory _data = _relayData(_withdrawal.data);
    bytes32 _digest = _typedDigest(
      keccak256(abi.encode(WITHDRAW_TYPEHASH, _proof.existingNullifierHash(), _proof.context()))
    );
    uint256 _withdrawn = _release(_withdrawal, _proof, _fee, _data, _digest, _signature);

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

  /*///////////////////////////////////////////////////////////////
                             SPEND CHECKS
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice The request a withdrawal's data holds: exactly abi.encode(RelayData), so one proof serves withdraw and buy
   *         alike, and a request made with more bytes is never read as one (abi.decode accepts trailing bytes)
   * @param _encoded The withdrawal's data
   * @return _data The request
   */
  function _relayData(bytes memory _encoded) internal pure returns (RelayData memory _data) {
    if (_encoded.length != 192) revert InvalidRelayData();
    _data = abi.decode(_encoded, (RelayData));
  }

  /**
   * @notice The checks of a relayed release, withdraw's and buy's alike, then the spend: both payees, the fee against
   *         the request's cap, W's signature of this release, every spend check and the backstop. The caller pays.
   * @param _withdrawal The withdrawal the proof's context binds
   * @param _proof The withdraw proof
   * @param _fee The fee the submitter picks
   * @param _data The request, _relayData(_withdrawal.data)
   * @param _digest The EIP-712 digest of the release W picked (a Withdraw or a Buy), with this proof's nullifier and
   *        context
   * @param _signature W's signature of `_digest`
   * @return _withdrawn The proof's withdrawnValue; the fee is at most half of it
   */
  function _release(
    Withdrawal memory _withdrawal,
    ProofLib.WithdrawProof memory _proof,
    uint256 _fee,
    RelayData memory _data,
    bytes32 _digest,
    bytes memory _signature
  ) internal returns (uint256 _withdrawn) {
    // The two payees: never the zero address or the pool
    if (_data.recipient == address(0) || _data.recipient == address(this)) revert InvalidRecipient();
    if (_data.feeRecipient == address(0) || _data.feeRecipient == address(this)) revert InvalidRecipient();
    // The fee: at most the cap the context binds
    if (_fee > _data.feeCap) revert FeeOverCap();
    // W picked this release, of this proof, on this pool and chain: nobody else can take W's proof another way
    if (_signer(_digest, _signature) != _data.recipient) revert InvalidSignature();

    _withdrawn = _spendChecked(_withdrawal, _proof, _data.deadlineMs);

    // The backstop: at most MAX_RELAY_FEE_BPS of the withdrawn value, whatever cap a proof binds
    if (_fee > _withdrawn * MAX_RELAY_FEE_BPS / 10_000) revert RelayFeeGreaterThanMax();
  }

  /**
   * @notice The EIP-712 digest of `_struct` under this pool's domain, on this chain (read at each call)
   * @param _struct The typed struct's hash
   * @return The digest
   */
  function _typedDigest(bytes32 _struct) internal view returns (bytes32) {
    bytes32 _domain = keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    return keccak256(abi.encodePacked(hex'1901', _domain, _struct));
  }

  /**
   * @notice The address that signed `_digest`: r, s, v, with s in the lower half; 0 for no signer
   * @param _digest The signed digest
   * @param _signature r, s, v (65 bytes)
   * @return The signer
   */
  function _signer(bytes32 _digest, bytes memory _signature) internal pure returns (address) {
    if (_signature.length != 65) revert InvalidSignature();
    bytes32 _r;
    bytes32 _s;
    uint8 _v;
    assembly ("memory-safe") {
      _r := mload(add(_signature, 0x20))
      _s := mload(add(_signature, 0x40))
      _v := byte(0, mload(add(_signature, 0x60)))
    }
    if (uint256(_s) > HALF_N) revert InvalidSignature();
    return ecrecover(_digest, _v, _r, _s);
  }

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
