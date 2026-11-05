// SPDX-License-Identifier: Apache-2.0
// Removes each of the pool's checks, one at a time, in a copy of contracts/pool-evm, and runs the test named for it:
// each named test passes on the pool as it is and fails on every mutant. Exits 1 when a named test passes on its
// mutant, fails on the pool as it is, or a mutant's text is not found exactly once. Needs forge and cast (Foundry).
// forge runs through test/fork-rpc.mjs, so the fork tests replay their recorded RPC answers.
//   node contracts/pool-evm/test/mutants.mjs
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PP = "src/PrivacyPool.sol";
const ST = "src/State.sol";
const SIMPLE = "src/PrivacyPoolSimple.sol";
const VERIFIER = "src/verifiers/WithdrawalVerifier.sol";
const ADAPTER = "src/adapters/UniswapV3Adapter.sol";
const V4 = "src/adapters/UniswapV4Adapter.sol";
const SELL = "src/SellDelegate.sol";
// lib/forge-std's submodule commit (v1.9.7), fetched into the copy when the checkout has no submodule files
const FORGE_STD = "77041d2ce690e692d6e03cc812b57d1ddaa4d505";

// [file, text, replacement, the test that must fail]; "layout" runs test/layout.test.mjs in place of a forge test
export const MUTANTS = [
  [PP, "if (_proof.context() != uint256(keccak256(abi.encode(_withdrawal, SCOPE))) % Constants.SNARK_SCALAR_FIELD) {", "if (false) {", "test_anotherRecipientIsRefused"],
  [PP, "if (_proof.context() != uint256(keccak256(abi.encode(_withdrawal, SCOPE))) % Constants.SNARK_SCALAR_FIELD) {", "if (false) {", "test_contextPlusOneFails"],
  [PP, "if (_withdrawal.processooor != address(this)) revert InvalidProcessooor();", "", "test_anotherProcessooorIsRefused"],
  [PP, "if (block.timestamp * 1000 > _deadlineMs) revert DeadlineExpired();", "", "test_aPastDeadlineIsRefused"],
  [PP, "if (_proof.stateTreeDepth() > MAX_TREE_DEPTH || _proof.ASPTreeDepth() > MAX_TREE_DEPTH) revert InvalidTreeDepth();", "", "test_aDepthOver32IsRefused"],
  [PP, "if (!_isKnownRoot(_proof.stateRoot())) revert UnknownStateRoot();", "", "test_anUnknownStateRootIsRefused"],
  [PP, "if (!_isKnownLabelRoot(_proof.ASPRoot())) revert UnknownLabelRoot();", "", "test_anUnknownLabelRootIsRefused"],
  [PP, "if (_withdrawn == 0) revert InvalidWithdrawalAmount();", "", "test_aZeroWithdrawalIsRefused"],
  [PP, "if (!WITHDRAWAL_VERIFIER.verifyProof(_proof.pA, _proof.pB, _proof.pC, _proof.pubSignals)) revert InvalidProof();", "", "test_aChangedProofPointIsRefused"],
  [PP, "_spend(_proof.existingNullifierHash());", "", "test_aSpentNullifierIsRefused"],
  [PP, "_insert(_proof.newCommitmentHash());", "", "test_depositThenRelayedWithdraw"],
  [PP, "if (_data.recipient == address(0) || _data.recipient == address(this)) revert InvalidRecipient();", "", "test_aZeroOrPoolPayeeIsRefused"],
  [PP, "if (_data.feeRecipient == address(0) || _data.feeRecipient == address(this)) revert InvalidRecipient();", "", "test_aZeroOrPoolPayeeIsRefused"],
  [PP, "if (_fee > _data.feeCap) revert FeeOverCap();", "", "test_aFeeOverTheCapIsRefused"],
  [PP, "if (_fee > _withdrawn * MAX_RELAY_FEE_BPS / 10_000) revert RelayFeeGreaterThanMax();", "", "test_aFeeOverTheBackstopIsRefused"],
  [PP, "_push(_data.recipient, _withdrawn - _fee);", "_push(_data.recipient, _withdrawn);", "test_depositThenRelayedWithdraw"],
  [PP, ") external nonReentrant {\n    RelayData", ") external {\n    RelayData", "test_aPayeeCannotReenterWithdraw"],
  [PP, ") external payable nonReentrant returns", ") external payable returns", "test_aPayeeCannotReenterDeposit"],
  [PP, "if (_value < MIN_DEPOSIT) revert MinimumDepositAmount();", "", "test_depositRefusesBelowMinimum"],
  [PP, "if (_value >= type(uint128).max) revert InvalidDepositValue();", "", "test_depositRefuses2To128"],
  [PP, "if (usedPrecommitments[_precommitmentHash]) revert PrecommitmentAlreadyUsed();", "", "test_depositRefusesAUsedPrecommitment"],
  [PP, "    _insertLabel(_label);", "", "test_depositFillsBothTrees"],
  [ST, "if (nullifierHashes[_nullifierHash]) revert NullifierAlreadySpent();", "", "test_aSpentNullifierIsRefused"],
  [ST, "if (_merkleTree.depth > MAX_TREE_DEPTH) revert MaxTreeDepthReached();", "", "test_aStateTreePast32IsRefused"],
  [ST, "if (_labelTree.depth > MAX_TREE_DEPTH) revert MaxTreeDepthReached();", "", "test_aLabelTreePast32IsRefused"],
  [ST, "return stateRootTimes[_root] != 0;", "return _root == _merkleTree._root();", "test_anOldRootIsAccepted"],
  [ST, "return stateRootTimes[_root] != 0;", "return _root == _merkleTree._root();", "test_aRootFrom100LeavesBackStillVerifies"],
  [ST, "stateRootTimes[_updatedRoot] = block.timestamp;", "stateRootTimes[_updatedRoot] = 1;", "test_eachRootKeepsItsBlockTime"],
  [ST, "labelRootTimes[_updatedRoot] = block.timestamp;", "labelRootTimes[_updatedRoot] = 1;", "test_eachRootKeepsItsBlockTime"],
  [ST, "return labelRootTimes[_root] != 0;", "return _root == _labelTree._root();", "test_anOldRootIsAccepted"],
  [ST, "if (_entered) revert Reentrancy();", "", "test_aPayeeCannotReenterWithdraw"],
  [SIMPLE, "if (msg.value != _amount) revert InsufficientValue();", "", "test_depositRefusesAValueOtherThanSent"],
  [SIMPLE, "if (!_success) revert FailedToSendNativeAsset();", "", "test_aPayeeThatRefusesEtherRevertsTheWithdrawal"],
  [VERIFIER, "checkField(calldataload(add(_pubSignals, 32)))", "", "test_aSignalAtOrAbovePIsRefused"],
  [PP, "if (_precommitmentHash >= Constants.SNARK_SCALAR_FIELD) revert InvalidPrecommitment();", "", "test_aPrecommitmentAtOrAbovePIsRefused"],
  [ST, "if (PoseidonT3.DEPLOYED.codehash != PoseidonT3.CODEHASH) revert UnexpectedCode(PoseidonT3.DEPLOYED);", "", "test_aChainWithoutPoseidonT3IsRefused"],
  [ST, "if (PoseidonT4.DEPLOYED.codehash != PoseidonT4.CODEHASH) revert UnexpectedCode(PoseidonT4.DEPLOYED);", "", "test_aChainWithoutPoseidonT4IsRefused"],
  [ST, "if (_withdrawalVerifier.codehash != WITHDRAWAL_VERIFIER_CODEHASH) revert UnexpectedCode(_withdrawalVerifier);", "", "test_anotherVerifierIsRefused"],
  [ST, "abi.encodePacked(address(this), block.chainid, _asset)", "abi.encodePacked(address(this), uint256(31337), _asset)", "test_scopeBindsTheChainId"],
  [PP, "if (!_isKnownLabelRoot(_proof.ASPRoot())) revert", "if (!_isKnownLabelRoot(_proof.ASPRoot()) && !_isKnownRoot(_proof.ASPRoot())) revert", "test_aStateRootIsNotALabelRoot"],
  [ST, "return stateRootTimes[_root] != 0;", "return stateRootTimes[_root] != 0 || labelRootTimes[_root] != 0;", "test_aLabelRootIsNotAStateRoot"],
  [PP, "_proof.stateTreeDepth() > MAX_TREE_DEPTH ||", "_proof.stateTreeDepth() >= MAX_TREE_DEPTH ||", "test_aDepthOf32PassesTheDepthCheck"],
  [PP, "_proof.ASPTreeDepth() > MAX_TREE_DEPTH)", "_proof.ASPTreeDepth() >= MAX_TREE_DEPTH)", "test_aDepthOf32PassesTheDepthCheck"],
  [PP, "if (_fee != 0) _push(_data.feeRecipient, _fee);", "_push(_data.feeRecipient, _fee);", "test_aHostileFeeRecipientIsBypassedWithFeeZero"],
  [ST, "    _;\n    _entered = false;", "    _;", "test_twoCallsInOneTransactionBothLand"],
  [ST, "if (_merkleTree.depth > MAX_TREE_DEPTH)", "if (_merkleTree.depth >= MAX_TREE_DEPTH)", "test_anInsertThatTakesTheStateTreeTo32Lands"],
  [ST, "if (_labelTree.depth > MAX_TREE_DEPTH)", "if (_labelTree.depth >= MAX_TREE_DEPTH)", "test_anInsertThatTakesTheLabelTreeTo32Lands"],
  [VERIFIER, "checkField(calldataload(add(_pubSignals, 0)))", "", "test_aSignalAtOrAbovePIsRefused"],
  // an added admin path: a selector, a DELEGATECALL, a storage slot
  [PP, "  /// @inheritdoc IPrivacyPool\n  function deposit(", "  function owner() external pure returns (address) {\n    return address(0);\n  }\n\n  /// @inheritdoc IPrivacyPool\n  function deposit(", "test_theDispatcherHasExactlyTheListedSelectors"],
  [PP, "  /// @inheritdoc IPrivacyPool\n  function deposit(", "  function depositors(uint256) external pure returns (address) {\n    return address(0);\n  }\n\n  /// @inheritdoc IPrivacyPool\n  function deposit(", "test_ragequitIsAbsent"],
  ["src/poseidon/PoseidonT3.sol", "function hash(uint256[2] memory _inputs) internal pure returns (uint256) {", "function hash(uint256[2] memory _inputs) public pure returns (uint256) {", "test_noDelegatecallCallcodeSelfdestructOrCreate"],
  [ST, "  /// @inheritdoc IState\n  uint256 public nonce;", "  /// @inheritdoc IState\n  uint256 public nonce;\n  address internal admin;", "layout"],
  // the buy (card pool-evm-buy): the request's length, W's signature and each field it binds, what W gets
  [PP, "if (_encoded.length != 192) revert InvalidRelayData();", "", "test_trailingRelayDataIsRefused"],
  [PP, "if (_signature.length != 65) revert InvalidSignature();", "", "test_aSignatureWithATrailingByteIsRefused"],
  [PP, "if (uint256(_s) > HALF_N) revert InvalidSignature();", "", "test_aHighSSignatureIsRefused"],
  // W signs every release: the check, then each field of each signed type and of the domain
  [PP, "if (_signer(_digest, _signature) != _data.recipient) revert InvalidSignature();", "", "test_aWrongSignerIsRefused"],
  [PP, "if (_signer(_digest, _signature) != _data.recipient) revert InvalidSignature();", "", "test_aBuysSignatureIsRefusedAsAWithdraw"],
  [PP, "if (_signer(_digest, _signature) != _data.recipient) revert InvalidSignature();", "", "test_aWithdrawWithNoOrAWrongSignatureIsRefused"],
  [PP, "if (_signer(_digest, _signature) != _data.recipient) revert InvalidSignature();", "", "test_aSignatureForAnotherProofOfTheNoteIsRefused"],
  [SIMPLE, "          _buy.adapter,\n", "          address(0),\n", "test_aChangedBuyIsRefused"],
  [SIMPLE, "keccak256(_buy.data),", "bytes32(0),", "test_aChangedBuyIsRefused"],
  [SIMPLE, "          _buy.minOut,\n", "          uint256(0),\n", "test_aChangedBuyIsRefused"],
  [SIMPLE, "          _buy.token,\n", "          address(0),\n", "test_aChangedBuyIsRefused"],
  [SIMPLE, "          _proof.existingNullifierHash(),\n", "          uint256(0),\n", "test_aSignatureForAnotherNoteIsRefused"],
  [SIMPLE, "          _proof.context(),\n", "          uint256(0),\n", "test_aSignatureForAnotherProofOfTheNoteIsRefused"],
  [SIMPLE, "          _proof.withdrawnValue()\n", "          uint256(0)\n", "test_aSignatureForASmallerChunkOfTheNoteIsRefused"],
  [SIMPLE, "uint256 nullifier,uint256 context,uint256 value)'", "uint256 nullifier,uint256 context)'", "test_buyLandsAndWHoldsMinOut"],
  [PP, "abi.encode(WITHDRAW_TYPEHASH, _proof.existingNullifierHash(), _proof.context(), _proof.withdrawnValue())", "abi.encode(WITHDRAW_TYPEHASH, uint256(0), _proof.context(), _proof.withdrawnValue())", "test_aWithdrawsSignatureIsRefusedAsABuy"],
  [PP, "abi.encode(WITHDRAW_TYPEHASH, _proof.existingNullifierHash(), _proof.context(), _proof.withdrawnValue())", "abi.encode(WITHDRAW_TYPEHASH, _proof.existingNullifierHash(), uint256(0), _proof.withdrawnValue())", "test_aSignatureForAnotherProofOfTheNoteIsRefused"],
  [PP, "abi.encode(WITHDRAW_TYPEHASH, _proof.existingNullifierHash(), _proof.context(), _proof.withdrawnValue())", "abi.encode(WITHDRAW_TYPEHASH, _proof.existingNullifierHash(), _proof.context(), uint256(0))", "test_aSignatureForASmallerChunkOfTheNoteIsRefused"],
  [PP, "keccak256('Withdraw(uint256 nullifier,uint256 context,uint256 value)')", "keccak256('Withdraw(uint256 nullifier,uint256 context)')", "test_oneProofServesWithdrawOrBuy"],
  [PP, "VERSION_HASH, block.chainid, address(this))", "VERSION_HASH, uint256(31337), address(this))", "test_anotherChainsSignatureIsRefused"],
  [PP, "VERSION_HASH, block.chainid, address(this))", "VERSION_HASH, block.chainid, address(uint160(0xb1f1f001)))", "test_anotherPoolsSignatureIsRefused"],
  [PP, "NAME_HASH = keccak256('Blindfill');", "NAME_HASH = keccak256('Blindfill pool');", "test_buyLandsAndWHoldsMinOut"],
  [PP, "abi.encodePacked(hex'1901', _domain, _struct)", "abi.encodePacked(_domain, _struct)", "test_oneProofServesWithdrawOrBuy"],
  [SIMPLE, "if (_buy.minOut == 0) revert InvalidMinOut();", "", "test_aZeroMinOutIsRefused"],
  [SIMPLE, "if (_out < _buy.minOut) revert MinOutNotMet();", "", "test_minOutNotMetIsRefused"],
  [SIMPLE, "if (_out < _buy.minOut) revert MinOutNotMet();", "", "test_anAdapterThatSendsElsewhereIsRefused"],
  [SIMPLE, "if (_out < _buy.minOut) revert MinOutNotMet();", "", "test_aRouteToAnotherTokenFails"],
  [SIMPLE, "uint256 _before = IERC20Balance(_buy.token).balanceOf(_data.recipient);", "uint256 _before = 0;", "test_tokensWAlreadyHoldsDoNotCount"],
  [SIMPLE, "{value: _withdrawn - _fee}", "{value: _withdrawn}", "test_buyLandsAndWHoldsMinOut"],
  [SIMPLE, "    if (_fee != 0) _push(_data.feeRecipient, _fee);\n", "", "test_buyLandsAndWHoldsMinOut"],
  [SIMPLE, "if (_fee != 0) _push(_data.feeRecipient, _fee);", "_push(_data.feeRecipient, _fee);", "test_aBuyWithFeeZeroSendsTheWholeChunk"],
  [SIMPLE, "(_buy.token, _data.recipient, _buy.minOut, _buy.data)", "(_buy.token, _data.recipient, 0, _buy.data)", "test_buyLandsAndWHoldsMinOut"],
  [SIMPLE, "(_buy.token, _data.recipient, _buy.minOut, _buy.data)", "(_buy.token, msg.sender, _buy.minOut, _buy.data)", "test_buyLandsAndWHoldsMinOut"],
  [SIMPLE, "bytes memory _signature\n  ) external nonReentrant {", "bytes memory _signature\n  ) external {", "test_anAdapterCannotReenter"],
  [PP, "_withdrawn = _spendChecked(_withdrawal, _proof, _data.deadlineMs);", "_withdrawn = _proof.withdrawnValue();", "test_aReplayedSignatureIsRefused"],
  [ADAPTER, "recipient: recipient,", "recipient: msg.sender,", "test_aBuyLandsAndWHoldsAtLeastMinOut"],
  [ADAPTER, "amountIn: msg.value,", "amountIn: msg.value / 2,", "test_aBuyLandsAndWHoldsAtLeastMinOut"],
  [ADAPTER, "amountOutMinimum: minOut", "amountOutMinimum: 0", "test_aMinOutOverTheQuoteFails"],
  // a partial fill: the router's ETH, each middle token's balance at the router, and the hop count that finds them
  [ADAPTER, "if (address(ROUTER).balance != _eth) revert PartialFill();", "", "test_aPartialFillRevertsTheBuy"],
  [ADAPTER, "!= _mid[_i]) {", "!= _mid[_i] && false) {", "test_aPartialSecondHopRevertsTheBuy"],
  [ADAPTER, "uint256 _hops = (data.length - 20) / 23;", "uint256 _hops = (data.length - 20) / 24;", "test_aPartialSecondHopRevertsTheBuy"],
  // the Uniswap v4 adapter (card evm-adapters): only the PoolManager calls back, every hop takes its whole amount, a
  // hop gives something and the route at least minOut, a route is not empty and starts from ETH or WETH, what it binds
  [V4, "if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();", "", "test_v4OnlyThePoolManagerCallsBack"],
  [V4, "if (_paid != -int256(_amount)) revert PartialFill();", "", "test_v4APartialFillRevertsTheBuy"],
  [V4, "if (_paid != -int256(_amount)) revert PartialFill();", "", "test_v4APartialSecondHopRevertsTheBuy"],
  [V4, "if (_got <= 0) revert TooLittleReceived();", "", "test_v4AHookThatTakesMoreThanTheOutputFails"],
  [V4, "if (_amount < _minOut) revert TooLittleReceived();", "", "test_v4AMinOutOverTheQuoteFails"],
  [V4, "if (_amount < _minOut) revert TooLittleReceived();", "", "test_v4AHookThatTakesMoreThanTheQuoteFails"],
  [V4, "if (_path.length == 0) revert InvalidRoute();", "", "test_v4AnEmptyRouteIsRefused"],
  [V4, "if (_currencyIn != address(0) && _currencyIn != address(WETH)) revert InvalidRoute();", "", "test_v4ARouteFromAnotherCurrencyIsRefused"],
  [V4, "POOL_MANAGER.take(_currency, _recipient, _amount);", "POOL_MANAGER.take(_currency, msg.sender, _amount);", "test_v4OneHopLands"],
  [V4, "amountSpecified: -int256(_amount),", "amountSpecified: -int256(_amount / 2),", "test_v4TwoHopLands"],
  [V4, "WETH.deposit{value: _in}();", "", "test_v4FromWethLands"],
  // the review's mutants (b61f0f5): EIP-712 strings and encoding, signature parsing, the request's length, what
  // W gets, the fee cap, v, and the fee recipient's reentry
  [PP, "keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')", "keccak256('EIP712Domain(string name,uint256 chainId,address verifyingContract)')", "test_buyLandsAndWHoldsMinOut"],
  [PP, "VERSION_HASH = keccak256('1');", "VERSION_HASH = keccak256('2');", "test_aWithdrawsSignatureIsRefusedAsABuy"],
  [SIMPLE, "'Buy(address adapter,bytes data,uint256 minOut,address token,uint256 nullifier,uint256 context,uint256 value)'", "'Buy(address token,bytes data,uint256 minOut,address adapter,uint256 nullifier,uint256 context,uint256 value)'", "test_buyLandsAndWHoldsMinOut"],
  [SIMPLE, "keccak256(_buy.data),", "keccak256(abi.encode(_buy.data)),", "test_buyLandsAndWHoldsMinOut"],
  [PP, "abi.encode(WITHDRAW_TYPEHASH, _proof.existingNullifierHash(), _proof.context(), _proof.withdrawnValue())", "abi.encode(WITHDRAW_TYPEHASH, _proof.newCommitmentHash(), _proof.context(), _proof.withdrawnValue())", "test_aWithdrawsSignatureIsRefusedAsABuy"],
  [PP, "_v := byte(0, mload(add(_signature, 0x60)))", "_v := 27", "test_signaturesWithVOf27And28BothLand"],
  [PP, "_r := mload(add(_signature, 0x20))\n      _s := mload(add(_signature, 0x40))", "_s := mload(add(_signature, 0x20))\n      _r := mload(add(_signature, 0x40))", "test_buyLandsAndWHoldsMinOut"],
  [SIMPLE, "_release(_withdrawal, _proof, _fee, _data, _buyDigest(_buy, _proof), _signature)", "_release(_withdrawal, _proof, _fee, _data, _typedDigest(keccak256(abi.encode(WITHDRAW_TYPEHASH, _proof.existingNullifierHash(), _proof.context(), _proof.withdrawnValue()))), _signature)", "test_aWithdrawsSignatureIsRefusedAsABuy"],
  [PP, "if (_encoded.length != 192) revert InvalidRelayData();", "if (_encoded.length < 192) revert InvalidRelayData();", "test_trailingRelayDataIsRefused"],
  [SIMPLE, "if (_out < _buy.minOut) revert MinOutNotMet();", "if (_out + 1 < _buy.minOut) revert MinOutNotMet();", "test_minOutNotMetIsRefused"],
  [SIMPLE, "{value: _withdrawn - _fee}", "{value: _withdrawn - _fee - 1}", "test_buyLandsAndWHoldsMinOut"],
  [SIMPLE, "if (_buy.minOut == 0) revert InvalidMinOut();", "if (_buy.minOut == 0 && _fee != 0) revert InvalidMinOut();", "test_aZeroMinOutIsRefused"],
  [PP, "if (_fee > _data.feeCap) revert FeeOverCap();", "if (_fee >= _data.feeCap) revert FeeOverCap();", "test_buyLandsAndWHoldsMinOut"],
  [PP, "return ecrecover(_digest, _v, _r, _s);", "return ecrecover(_digest, _v < 27 ? _v + 27 : _v, _r, _s);", "test_R_vOtherThan27Or28IsRefused"],
  [SIMPLE, "bytes memory _signature\n  ) external nonReentrant {", "bytes memory _signature\n  ) external {", "test_R_feeRecipientCannotReenterBuy"],
  // the sell delegate (card pool-evm-sell): each check of a sell, W's signature and each field it binds, the nonce at
  // its ERC-7201 slot, the approval, the unwrap, minOut, the fee and the deposit
  [SELL, "if (_guard()) revert Reentrancy();", "", "test_aTargetCannotReenter"],
  [SELL, "    _setGuard(true);\n", "", "test_aTargetCannotReenter"],
  [SELL, "    _setGuard(false);\n", "", "test_twoSellsInOneTransactionBothLand"],
  // the review of c2a8da2 (test/HostileSell.t.sol): the guard back at transient slot 0, and the cap paid in
  // place of the fee the sender named
  [SELL, "SELL_GUARD = 0x440bd9ccab75449a1500e3c92e1ea82c77befa0047a75538597e7e92c1806400;", "SELL_GUARD = 0x0000000000000000000000000000000000000000000000000000000000000000;", "test_R_aModuleGuardAtSlot0DoesNotCollide"],
  [SELL, "msg.sender.call{value: _fee}('')", "msg.sender.call{value: _sell.feeCap}('')", "test_R_theSenderGetsTheFeeItNamesNotTheCap"],
  [SELL, "if (block.timestamp > _sell.deadline) revert DeadlineExpired();", "", "test_anExpiredDeadlineIsRefused"],
  [SELL, "if (block.timestamp > _sell.deadline)", "if (block.timestamp >= _sell.deadline)", "test_anExpiredDeadlineIsRefused"],
  [SELL, "if (_fee > _sell.feeCap) revert FeeOverCap();", "", "test_aSellFeeOverTheCapIsRefused"],
  [SELL, "if (_fee > _sell.feeCap)", "if (_fee >= _sell.feeCap)", "test_aSellFeeOverTheCapIsRefused"],
  [SELL, "if (_sell.minOut == 0) revert InvalidMinOut();", "", "test_aSellZeroMinOutIsRefused"],
  [SELL, "if (_signer(_sellDigest(_sell), _signature) != address(this)) revert InvalidSignature();", "", "test_aSellWrongSignerIsRefused"],
  [SELL, "if (_signer(_sellDigest(_sell), _signature) != address(this)) revert InvalidSignature();", "", "test_changedCalldataIsRefused"],
  [SELL, "if (_signer(_sellDigest(_sell), _signature) != address(this)) revert InvalidSignature();", "", "test_aThirdPartyCallingTheDelegateMovesNothing"],
  [SELL, "if (_sell.nonce != $.nonce) revert InvalidNonce();", "", "test_aReplayedNonceIsRefused"],
  [SELL, "if (_sell.nonce != $.nonce) revert InvalidNonce();", "", "test_noncesRunInTurn"],
  [SELL, "    $.nonce = _sell.nonce + 1;\n", "", "test_aReplayedNonceIsRefused"],
  [SELL, "$.nonce = _sell.nonce + 1;", "$.nonce = _sell.nonce + 2;", "test_noncesRunInTurn"],
  [SELL, "SELL_STORAGE = 0xd19ce3d034be62269d1d8903d496806b7944251c1f2a9fe8014ceeba63edbd00;", "SELL_STORAGE = 0xd19ce3d034be62269d1d8903d496806b7944251c1f2a9fe8014ceeba63edbd01;", "test_aSellLandsAndTheLeafHoldsTheProceedsLessTheFee"],
  [SELL, "_approve(_sell.token, _sell.target, _sell.amount);", "_approve(_sell.token, _sell.target, type(uint256).max);", "test_aSellLandsAndTheLeafHoldsTheProceedsLessTheFee"],
  [SELL, "if (IERC20Sell(_sell.token).allowance(address(this), _sell.target) != 0) revert LeftoverApproval();", "", "test_aLeftoverApprovalIsRefused"],
  [SELL, "if (IERC20Sell(_sell.token).allowance(address(this), _sell.target) != 0) revert LeftoverApproval();", "", "test_aForkLeftoverApprovalFails"],
  [SELL, "if (!_ok || (_ret.length != 0 && !abi.decode(_ret, (bool)))) revert ApproveFailed();", "", "test_aTokenThatRefusesTheApprovalIsRefused"],
  [SELL, "(_ret.length != 0 && !abi.decode(_ret, (bool)))) revert ApproveFailed();", "!abi.decode(_ret, (bool))) revert ApproveFailed();", "test_aTokenWhoseApproveReturnsNothingSells"],
  [SELL, "      if (!_ok) {\n        assembly", "      if (false) {\n        assembly", "test_aTargetsRevertIsPassedOn"],
  [SELL, "uint256 _eth = address(this).balance;", "uint256 _eth = 0;", "test_whatWAlreadyHoldsDoesNotCount"],
  [SELL, "uint256 _weth = _viaWeth ? WETH.balanceOf(address(this)) : 0;", "uint256 _weth = 0;", "test_whatWAlreadyHoldsDoesNotCount"],
  // review 2, R-3: WETH is read only for a route that can pay in it
  [SELL, "bool _viaWeth = _paysInWeth(_sell);", "bool _viaWeth = true;", "test_v4SellToTheNativeAssetTrustsNoWeth"],
  [SELL, "bool _viaWeth = _paysInWeth(_sell);", "bool _viaWeth = false;", "test_v4SellToWethLands"],
  [SELL, "if (_wethGained != 0) WETH.withdraw(_wethGained);", "", "test_aSellLandsAndTheLeafHoldsTheProceedsLessTheFee"],
  [SELL, "  receive() external payable {}\n", "", "test_aSellPaidInEtherLands"],
  // card evm-selldelegate-exact-debit: W's balance of the token falls by exactly the amount, on v3 and v4
  [SELL, "if (_held - IERC20Sell(_sell.token).balanceOf(address(this)) != _sell.amount) revert DebitNotExact();", "", "test_anExtraDebitOnlyInTransferFromIsRefused"],
  [SELL, "if (_held - IERC20Sell(_sell.token).balanceOf(address(this)) != _sell.amount) revert DebitNotExact();", "", "test_anExtraDebitOnlyTowardThePoolIsRefused"],
  [SELL, "if (_held - IERC20Sell(_sell.token).balanceOf(address(this)) != _sell.amount) revert DebitNotExact();", "", "test_v4AnExtraDebitOnlyInsideTheUnlockIsRefused"],
  [SELL, "if (_held - IERC20Sell(_sell.token).balanceOf(address(this)) != _sell.amount) revert DebitNotExact();", "", "test_v4AnExtraDebitOnlyTowardThePoolIsRefused"],
  [SELL, "!= _sell.amount) revert DebitNotExact();", "> _sell.amount) revert DebitNotExact();", "test_R_aTargetGivingTokenBackIsRefused"],
  [SELL, "uint256 _held = IERC20Sell(_sell.token).balanceOf(address(this));", "uint256 _held = IERC20Sell(_sell.token).balanceOf(address(this)) + 1;", "test_aSellLandsAndTheLeafHoldsTheProceedsLessTheFee"],
  [SELL, "uint256 _held = IERC20Sell(_sell.token).balanceOf(address(this));", "uint256 _held = IERC20Sell(_sell.token).balanceOf(address(this)) + 1;", "test_v4SellToTheNativeAssetLands"],
  [SELL, "if (_gained < _sell.minOut) revert MinOutNotMet();", "", "test_aShortOutputIsRefused"],
  [SELL, "if (_gained < _sell.minOut) revert MinOutNotMet();", "", "test_aShortOutputInEtherIsRefused"],
  [SELL, "if (_gained < _sell.minOut) revert MinOutNotMet();", "", "test_aForkShortOutputFails"],
  [SELL, "if (_gained < _sell.minOut)", "if (_gained + 1 < _sell.minOut)", "test_aShortOutputIsRefused"],
  [SELL, "if (!_sent) revert FailedToSendNativeAsset();", "", "test_aSenderThatRefusesEtherRevertsTheSell"],
  [SELL, "    if (_fee != 0) {\n", "    if (true) {\n", "test_aSenderThatRefusesEtherRevertsTheSell"],
  [SELL, "msg.sender.call{value: _fee}('')", "block.coinbase.call{value: _fee}('')", "test_aSellLandsAndTheLeafHoldsTheProceedsLessTheFee"],
  [SELL, "deposit{value: _gained - _fee}(_gained - _fee, _sell.precommitment)", "deposit{value: _gained}(_gained, _sell.precommitment)", "test_aSellLandsAndTheLeafHoldsTheProceedsLessTheFee"],
  [SELL, "(_gained - _fee, _sell.precommitment)", "(_gained - _fee, uint256(1))", "test_aSellLandsAndTheLeafHoldsTheProceedsLessTheFee"],
  [SELL, "if (_signature.length != 65) revert InvalidSignature();", "", "test_aSellSignatureWithATrailingByteIsRefused"],
  [SELL, "if (uint256(_s) > HALF_N) revert InvalidSignature();", "", "test_aSellHighSSignatureIsRefused"],
  [SELL, "uint8 _v = uint8(_signature[64]);", "uint8 _v = 27;", "test_sellSignaturesWithVOf27And28BothLand"],
  [SELL, "bytes32 _r = bytes32(_signature[0:32]);\n    bytes32 _s = bytes32(_signature[32:64]);", "bytes32 _s = bytes32(_signature[0:32]);\n    bytes32 _r = bytes32(_signature[32:64]);", "test_aSellLandsAndTheLeafHoldsTheProceedsLessTheFee"],
  [SELL, "return ecrecover(_digest, _v, _r, _s);", "return ecrecover(_digest, _v < 27 ? _v + 27 : _v, _r, _s);", "test_aVOtherThan27Or28IsRefused"],
  [SELL, "VERSION_HASH, block.chainid, address(this))", "VERSION_HASH, uint256(8453), address(this))", "test_anotherChainsSellSignatureIsRefused"],
  [SELL, "VERSION_HASH, block.chainid, address(this))", "VERSION_HASH, block.chainid, address(0))", "test_aSellLandsAndTheLeafHoldsTheProceedsLessTheFee"],
  [SELL, "NAME_HASH = keccak256('Blindfill');", "NAME_HASH = keccak256('Blindfill sell');", "test_aSellLandsAndTheLeafHoldsTheProceedsLessTheFee"],
  [SELL, "VERSION_HASH = keccak256('1');", "VERSION_HASH = keccak256('2');", "test_aSellLandsAndTheLeafHoldsTheProceedsLessTheFee"],
  [SELL, "keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')", "keccak256('EIP712Domain(string name,uint256 chainId,address verifyingContract)')", "test_aSellLandsAndTheLeafHoldsTheProceedsLessTheFee"],
  [SELL, "'Sell(address token,uint256 amount,", "'Sell(uint256 amount,address token,", "test_aSellLandsAndTheLeafHoldsTheProceedsLessTheFee"],
  [SELL, "abi.encodePacked(hex'1901', _domain, _struct)", "abi.encodePacked(_domain, _struct)", "test_aSellLandsAndTheLeafHoldsTheProceedsLessTheFee"],
  [SELL, "        _sell.token,\n", "        address(0),\n", "test_eachChangedFieldIsRefused"],
  [SELL, "        _sell.amount,\n", "        uint256(0),\n", "test_eachChangedFieldIsRefused"],
  [SELL, "        _sell.target,\n", "        address(0),\n", "test_eachChangedFieldIsRefused"],
  [SELL, "        keccak256(_sell.data),\n", "        bytes32(0),\n", "test_changedCalldataIsRefused"],
  [SELL, "        _sell.minOut,\n", "        uint256(0),\n", "test_eachChangedFieldIsRefused"],
  [SELL, "        _sell.pool,\n", "        address(0),\n", "test_eachChangedFieldIsRefused"],
  [SELL, "        _sell.precommitment,\n", "        uint256(0),\n", "test_eachChangedFieldIsRefused"],
  [SELL, "        _sell.feeCap,\n", "        uint256(0),\n", "test_eachChangedFieldIsRefused"],
  [SELL, "        _sell.deadline,\n", "        uint256(0),\n", "test_eachChangedFieldIsRefused"],
  [SELL, "        _sell.nonce\n      )", "        uint256(0)\n      )", "test_eachChangedFieldIsRefused"],
  // the sell through the v4 PoolManager (card evm-sell-v4): test/SellV4.t.sol and test/SellV4Fork.t.sol
  [SELL, "if (_sell.target == address(POOL_MANAGER)) {", "if (false) {", "test_v4SellToTheNativeAssetLands"],
  [SELL, "if (_sell.target == address(POOL_MANAGER)) {", "if (false) {", "test_aV4OnlyTokenSellsBackIntoThePool"],
  [SELL, "if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();", "", "test_v4ACallbackNotFromThePoolManagerIsRefused"],
  [SELL, "if (_v4() != keccak256(_raw)) revert NotInSell();", "", "test_v4ACallbackOutsideASellIsRefused"],
  [SELL, "if (_v4() != keccak256(_raw)) revert NotInSell();", "", "test_v4AnUnlockByWAfterASellIsRefused"],
  [SELL, "      _setV4(keccak256(_payload));\n", "", "test_v4SellToTheNativeAssetLands"],
  [SELL, "if (_v4() != keccak256(_raw)) revert NotInSell();", "if (_v4() == bytes32(0)) revert NotInSell();", "test_aCallbackWithAnotherPayloadIsRefused"],
  [SELL, "    _setV4(bytes32(0));\n", "", "test_aSecondCallbackInOneUnlockIsRefused"],
  [SELL, "if (_out != address(0) && _out != address(WETH)) revert InvalidRoute();", "if (_out != address(0)) revert InvalidRoute();", "test_twoHopsEndingInWethLand"],
  [SELL, "if (_paid != -int256(_got)) revert PartialFill();", "", "test_anInputTakingHookOnAThinPoolIsRefused"],
  [SELL, "if (_path.length == 0) revert InvalidRoute();", "", "test_v4AnEmptySellRouteIsRefused"],
  [SELL, "if (_out != address(0) && _out != address(WETH)) revert InvalidRoute();", "", "test_v4ARouteEndingInATokenIsRefused"],
  [SELL, "if (_paid != -int256(_got)) revert PartialFill();", "", "test_v4APartialFillIsRefused"],
  [SELL, "if (_gave <= 0) revert MinOutNotMet();", "", "test_v4AHookTakingTheWholeOutputIsRefused"],
  [SELL, "amountSpecified: -int256(_got),", "amountSpecified: -int256(_got / 2),", "test_v4TwoHopSellLands"],
  [SELL, "_transfer(_token, address(POOL_MANAGER), _amount);", "_transfer(_token, address(POOL_MANAGER), _amount - 1);", "test_v4SellToTheNativeAssetLands"],
  [SELL, "if (!_ok || (_ret.length != 0 && !abi.decode(_ret, (bool)))) revert TransferFailed();", "", "test_v4ATokenThatRefusesTheTransferIsRefused"],
  [SELL, "POOL_MANAGER.take(_currency, address(this), _got);", "POOL_MANAGER.take(_currency, msg.sender, _got);", "test_v4SellToTheNativeAssetLands"],
  [SELL, "POOL_MANAGER.take(_currency, address(this), _got);", "POOL_MANAGER.take(_currency, address(this), _got - 1);", "test_v4SellToWethLands"],
  [SELL, "if (_gained < _sell.minOut) revert MinOutNotMet();", "", "test_v4ProceedsUnderMinOutAreRefused"],
  [SELL, "if (_gained < _sell.minOut) revert MinOutNotMet();", "", "test_aV4ForkShortOutputFails"],
];

// keccak256 of the withdrawal verifier's deployed code as `dir` builds it
function verifierHash(dir) {
  const code = execFileSync("forge", ["inspect", "WithdrawalVerifier", "deployedBytecode"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  return execFileSync("cast", ["keccak", code.trim()], { encoding: "utf8", stdio: "pipe" }).trim();
}

// "pass", "fail" or "error (...)" of one named test; throws unless forge ran exactly that one test (forge matches --mt against
// `name()`, and a pattern that matches nothing exits 0)
function run(dir, test) {
  if (test === "layout") {
    try {
      execFileSync("node", ["--test", "test/layout.test.mjs"], { cwd: dir, stdio: "pipe" });
      return "pass";
    } catch {
      return "fail";
    }
  }
  let out;
  try {
    out = execFileSync("node", ["test/fork-rpc.mjs", "--", "forge", "test", "--no-storage-caching", "--mt", `^${test}\\(`], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  // a read the fork replay has no answer for makes a fork test fail for the wrong reason: an error, never a kill.
  // forge 1.8.6's two probes (anvil_nodeInfo, eth_getAccountInfo) are answered by its own fallback and do not count
  const misses = [...new Set((out.match(/fork-rpc: not recorded[^\n]*/g) ?? []).filter((m) => !/anvil_nodeInfo|eth_getAccountInfo/.test(m)))];
  if (misses.length > 0) return `error (the replay has no answer: ${misses.join("; ").slice(0, 300)})`;
  // PASS or FAIL of each test of that name (two contracts may share it, each failing for its own reason)
  const ran = (out.match(new RegExp(`^\\[(PASS|FAIL).*\\] ${test}\\(`, "gm")) ?? []).map((r) => r.slice(1, 5));
  // forge prints a failing test twice, in the run and in the summary
  if (ran.length >= 1 && ran.every((r) => r === ran[0])) return ran[0] === "PASS" ? "pass" : "fail";
  throw new Error(`forge ran ${ran.length} tests named ${test}:\n${out.slice(-2000)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = mkdtempSync(path.join(tmpdir(), "pool-evm-mutants-"));
  let bad = 0;
  try {
    cpSync(ROOT, dir, { recursive: true, filter: (f) => !/[/\\](out|cache)$/.test(f) });
    const std = path.join(dir, "lib/forge-std");
    if (!existsSync(path.join(std, "src/Test.sol"))) {
      rmSync(std, { recursive: true, force: true });
      const git = (...a) => execFileSync("git", a, { cwd: std, stdio: "pipe" });
      execFileSync("git", ["init", "-q", std]);
      git("fetch", "-q", "--depth", "1", "https://github.com/foundry-rs/forge-std.git", FORGE_STD);
      git("checkout", "-q", FORGE_STD);
    }
    for (const t of new Set(MUTANTS.map((m) => m[3]))) {
      const r = run(dir, t);
      if (r !== "pass") {
        console.log(`FAIL ${t} is ${r} on the pool as it is`);
        bad++;
      }
    }
    if (bad > 0) throw new Error(`${bad} named test(s) fail on the pool as it is: no mutant is run`);
    MUTANTS.forEach(([file, find, repl, t], i) => {
      const f = path.join(dir, file);
      const src = readFileSync(f, "utf8");
      if (src.split(find).length !== 2) {
        console.log(`FAIL mutant ${i + 1}: its text is not in ${file} exactly once`);
        bad++;
        return;
      }
      writeFileSync(f, src.replace(find, repl));
      // the pool refuses any verifier but the one it was built with: a verifier mutant is deployed with its own hash
      const st = path.join(dir, ST);
      const stSrc = readFileSync(st, "utf8");
      if (file === VERIFIER) writeFileSync(st, stSrc.replace(/(WITHDRAWAL_VERIFIER_CODEHASH = )0x[0-9a-f]{64}/, `$1${verifierHash(dir)}`));
      const r = run(dir, t);
      if (file === VERIFIER) writeFileSync(st, stSrc);
      writeFileSync(f, src);
      // each mutant runs alone: every file is back as it is in the pool before the next
      for (const x of new Set(MUTANTS.map((m) => m[0]))) {
        if (readFileSync(path.join(dir, x), "utf8") !== readFileSync(path.join(ROOT, x), "utf8")) throw new Error(`mutant ${i + 1} left ${x} changed`);
      }
      console.log(`${r === "fail" ? "ok  " : "FAIL"} mutant ${i + 1} ${file}: ${find.trim().split("\n")[0].slice(0, 70)} -> ${t} ${r === "fail" ? "fails" : r === "pass" ? "PASSES" : r}`);
      if (r !== "fail") bad++;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(bad === 0 ? `every one of ${MUTANTS.length} mutants fails its named test` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
