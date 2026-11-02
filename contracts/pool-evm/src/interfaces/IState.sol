// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

// Blindfill: ported from Privacy Pools v1.3.0 (commit c312dcd, packages/contracts/src/interfaces/IState.sol),
// Copyright 2025 0XBOW LTD, Apache-2.0. Changes (contracts/pool-evm/NOTICE): no ENTRYPOINT, dead, roots ring,
// ROOT_HISTORY_SIZE or currentRootIndex; the root sets, the label tree's views, usedPrecommitments, LabelInserted and
// Reentrancy added; the unused OnlyEntrypoint, PoolIsDead and NotYetRagequitteable removed.

import {IVerifier} from 'interfaces/IVerifier.sol';

/**
 * @title IState
 * @notice Interface for the State contract
 */
interface IState {
  /*///////////////////////////////////////////////////////////////
                              EVENTS
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Emitted when inserting a leaf into the Merkle Tree
   * @param _index The index of the leaf in the tree
   * @param _leaf The leaf value
   * @param _root The updated root
   */
  event LeafInserted(uint256 _index, uint256 _leaf, uint256 _root);

  /**
   * @notice Emitted when inserting a deposit's label into the label tree
   * @param _index The label tree's size after the insert
   * @param _label The label
   * @param _root The label tree's updated root
   */
  event LabelInserted(uint256 _index, uint256 _label, uint256 _root);

  /*///////////////////////////////////////////////////////////////
                              ERRORS
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Thrown when trying to spend a nullifier that has already been spent
   */
  error NullifierAlreadySpent();

  /**
   * @notice Thrown when the max tree depth is reached and no more commitments can be inserted
   */
  error MaxTreeDepthReached();

  /**
   * @notice Thrown when trying to set a state variable as address zero
   */
  error ZeroAddress();

  /**
   * @notice Thrown when a call enters the pool while a pool method runs
   */
  error Reentrancy();

  /*///////////////////////////////////////////////////////////////
                              VIEWS
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Returns the pool unique identifier
   * @return _scope The scope id
   */
  function SCOPE() external view returns (uint256 _scope);

  /**
   * @notice Returns the pool asset
   * @return _asset The asset address
   */
  function ASSET() external view returns (address _asset);

  /**
   * @notice Returns the maximum depth of the state tree
   * @return _maxDepth The max depth
   */
  function MAX_TREE_DEPTH() external view returns (uint32 _maxDepth);

  /**
   * @notice Returns the configured Withdrawal Verifier contract
   * @return _verifier The Groth16 Withdrawal Verifier
   */
  function WITHDRAWAL_VERIFIER() external view returns (IVerifier _verifier);

  /**
   * @notice Returns the configured Ragequit Verifier contract
   * @return _verifier The Groth16 Ragequit Verifier
   */
  function RAGEQUIT_VERIFIER() external view returns (IVerifier _verifier);

  /**
   * @notice Returns the current root of the state tree
   * @return _root The current root
   */
  function currentRoot() external view returns (uint256 _root);

  /**
   * @notice Returns the current state tree depth
   * @return _depth The current state tree depth
   */
  function currentTreeDepth() external view returns (uint256 _depth);

  /**
   * @notice Returns the current state tree size
   * @return _size The current state tree size
   */
  function currentTreeSize() external view returns (uint256 _size);

  /**
   * @notice Returns the current root of the label tree
   * @return _root The current root
   */
  function currentLabelRoot() external view returns (uint256 _root);

  /**
   * @notice Returns the current label tree depth
   * @return _depth The current label tree depth
   */
  function currentLabelTreeDepth() external view returns (uint256 _depth);

  /**
   * @notice Returns the current label tree size
   * @return _size The current label tree size
   */
  function currentLabelTreeSize() external view returns (uint256 _size);

  /**
   * @notice Returns the current label nonce
   * @return _nonce The current nonce
   */
  function nonce() external view returns (uint256 _nonce);

  /**
   * @notice Returns whether the state tree has ever had this root
   * @param _root The root
   * @return _known True if the state tree has had it
   */
  function knownStateRoots(uint256 _root) external view returns (bool _known);

  /**
   * @notice Returns whether the label tree has ever had this root
   * @param _root The root
   * @return _known True if the label tree has had it
   */
  function knownLabelRoots(uint256 _root) external view returns (bool _known);

  /**
   * @notice Returns the spending status of a nullifier hash
   * @param _nullifierHash The nullifier hash
   * @return _spent The boolean indicating if it is spent
   */
  function nullifierHashes(uint256 _nullifierHash) external view returns (bool _spent);

  /**
   * @notice Returns the original depositor that generated a label
   * @param _label The label
   * @return _depositor The original depositor
   */
  function depositors(uint256 _label) external view returns (address _depositor);

  /**
   * @notice Returns whether a precommitment has been used by a deposit
   * @param _precommitment The precommitment
   * @return _used True if a deposit used it
   */
  function usedPrecommitments(uint256 _precommitment) external view returns (bool _used);
}
