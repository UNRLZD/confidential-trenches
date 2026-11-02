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

// Blindfill: ported from Privacy Pools v1.3.0 (commit c312dcd, packages/contracts/src/contracts/State.sol),
// Copyright 2025 0XBOW LTD, Apache-2.0. Changes, each listed in contracts/pool-evm/NOTICE:
// - no ENTRYPOINT and no onlyEntrypoint: nothing outside the pool has power over it;
// - no `dead`: nothing can stop deposits;
// - `usedPrecommitments` moved in from Entrypoint.sol:55 with the deposit;
// - a second LeanIMT, the label tree, which the pool fills itself (the association set);
// - every root of both trees kept in a set (no 64-slot ring), so a proof made against an older root still lands;
// - a reentrancy guard in transient storage, in place of the Entrypoint's nonReentrant.

import {Constants} from './lib/Constants.sol';
import {InternalLeanIMT, LeanIMTData} from 'lean-imt/InternalLeanIMT.sol';

import {IState} from 'interfaces/IState.sol';
import {IVerifier} from 'interfaces/IVerifier.sol';

/**
 * @title State
 * @notice Base contract for the managing the state of a Privacy Pool
 */
abstract contract State is IState {
  using InternalLeanIMT for LeanIMTData;

  /// @inheritdoc IState
  uint32 public constant MAX_TREE_DEPTH = 32;

  /// @inheritdoc IState
  address public immutable ASSET;
  /// @inheritdoc IState
  uint256 public immutable SCOPE;
  /// @inheritdoc IState
  IVerifier public immutable WITHDRAWAL_VERIFIER;
  /// @inheritdoc IState
  IVerifier public immutable RAGEQUIT_VERIFIER;

  /// @inheritdoc IState
  uint256 public nonce;

  /// @inheritdoc IState
  mapping(uint256 _root => bool _known) public knownStateRoots;
  /// @inheritdoc IState
  mapping(uint256 _root => bool _known) public knownLabelRoots;

  // @notice The state merkle tree containing all commitments
  LeanIMTData internal _merkleTree;
  // @notice The label tree containing every deposit's label: the association set, filled by the pool itself
  LeanIMTData internal _labelTree;

  /// @inheritdoc IState
  mapping(uint256 _nullifierHash => bool _spent) public nullifierHashes;
  /// @inheritdoc IState
  mapping(uint256 _label => address _depositooor) public depositors;
  /// @inheritdoc IState
  mapping(uint256 _precommitment => bool _used) public usedPrecommitments;

  // @notice Set while a pool method runs
  bool private transient _entered;

  /**
   * @notice Refuses a call into the pool while a pool method runs
   */
  modifier nonReentrant() {
    if (_entered) revert Reentrancy();
    _entered = true;
    _;
    _entered = false;
  }

  /**
   * @notice Initialize the state addresses
   */
  constructor(address _asset, address _withdrawalVerifier, address _ragequitVerifier) {
    // Sanitize initial addresses
    if (_asset == address(0)) revert ZeroAddress();
    if (_ragequitVerifier == address(0)) revert ZeroAddress();
    if (_withdrawalVerifier == address(0)) revert ZeroAddress();

    // Store asset address
    ASSET = _asset;
    // Compute SCOPE
    SCOPE = uint256(keccak256(abi.encodePacked(address(this), block.chainid, _asset))) % Constants.SNARK_SCALAR_FIELD;

    WITHDRAWAL_VERIFIER = IVerifier(_withdrawalVerifier);
    RAGEQUIT_VERIFIER = IVerifier(_ragequitVerifier);
  }

  /*///////////////////////////////////////////////////////////////
                              VIEWS
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IState
  function currentRoot() external view returns (uint256 _root) {
    _root = _merkleTree._root();
  }

  /// @inheritdoc IState
  function currentTreeDepth() external view returns (uint256 _depth) {
    _depth = _merkleTree.depth;
  }

  /// @inheritdoc IState
  function currentTreeSize() external view returns (uint256 _size) {
    _size = _merkleTree.size;
  }

  /// @inheritdoc IState
  function currentLabelRoot() external view returns (uint256 _root) {
    _root = _labelTree._root();
  }

  /// @inheritdoc IState
  function currentLabelTreeDepth() external view returns (uint256 _depth) {
    _depth = _labelTree.depth;
  }

  /// @inheritdoc IState
  function currentLabelTreeSize() external view returns (uint256 _size) {
    _size = _labelTree.size;
  }

  /*///////////////////////////////////////////////////////////////
                        INTERNAL METHODS
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Spends a nullifier hash
   * @param _nullifierHash The nullifier hash to spend
   */
  function _spend(uint256 _nullifierHash) internal {
    // Check if the nullifier is already spent
    if (nullifierHashes[_nullifierHash]) revert NullifierAlreadySpent();

    // Mark as spent
    nullifierHashes[_nullifierHash] = true;
  }

  /**
   * @notice Insert a leaf into the state
   * @param _leaf The leaf to insert
   * @return _updatedRoot The new root after inserting the leaf
   */
  function _insert(uint256 _leaf) internal returns (uint256 _updatedRoot) {
    // Insert leaf in the tree
    _updatedRoot = _merkleTree._insert(_leaf);

    if (_merkleTree.depth > MAX_TREE_DEPTH) revert MaxTreeDepthReached();

    // Keep the root, with every root before it
    knownStateRoots[_updatedRoot] = true;

    emit LeafInserted(_merkleTree.size, _leaf, _updatedRoot);
  }

  /**
   * @notice Insert a deposit's label into the label tree
   * @param _label The label to insert
   * @return _updatedRoot The label tree's new root
   */
  function _insertLabel(uint256 _label) internal returns (uint256 _updatedRoot) {
    _updatedRoot = _labelTree._insert(_label);

    if (_labelTree.depth > MAX_TREE_DEPTH) revert MaxTreeDepthReached();

    // Keep the root, with every root before it
    knownLabelRoots[_updatedRoot] = true;

    emit LabelInserted(_labelTree.size, _label, _updatedRoot);
  }

  /**
   * @notice Returns whether the root is one the state tree has had; never 0, which LeanIMT never makes a root
   * @param _root The root to check
   * @return Returns true if the state tree has had this root, false otherwise
   */
  function _isKnownRoot(uint256 _root) internal view returns (bool) {
    return knownStateRoots[_root];
  }

  /**
   * @notice Returns whether the root is one the label tree has had
   * @param _root The root to check
   * @return Returns true if the label tree has had this root, false otherwise
   */
  function _isKnownLabelRoot(uint256 _root) internal view returns (bool) {
    return knownLabelRoots[_root];
  }

  /**
   * @notice Returns whether a leaf is in the state
   * @param _leaf The leaf to check
   * @return Returns true if the leaf exists in the tree, false otherwise
   */
  function _isInState(uint256 _leaf) internal view returns (bool) {
    return _merkleTree._has(_leaf);
  }
}
