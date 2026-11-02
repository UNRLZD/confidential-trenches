// SPDX-License-Identifier: Apache-2.0
// Removes each of the pool's checks, one at a time, in a copy of contracts/pool-evm, and runs the test named for it:
// each named test passes on the pool as it is and fails on every mutant. Exits 1 when a named test passes on its
// mutant, fails on the pool as it is, or a mutant's text is not found exactly once. Needs forge (Foundry).
//   node contracts/pool-evm/test/mutants.mjs
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PP = "src/PrivacyPool.sol";
const ST = "src/State.sol";
const SIMPLE = "src/PrivacyPoolSimple.sol";

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
  [PP, "function ragequit(ProofLib.RagequitProof memory _proof) external nonReentrant {", "function ragequit(ProofLib.RagequitProof memory _proof) external {", "test_aRagequitterCannotReenter"],
  [PP, "if (_value < MIN_DEPOSIT) revert MinimumDepositAmount();", "", "test_depositRefusesBelowMinimum"],
  [PP, "if (_value >= type(uint128).max) revert InvalidDepositValue();", "", "test_depositRefuses2To128"],
  [PP, "if (usedPrecommitments[_precommitmentHash]) revert PrecommitmentAlreadyUsed();", "", "test_depositRefusesAUsedPrecommitment"],
  [PP, "    _insertLabel(_label);", "", "test_depositFillsBothTrees"],
  [PP, "if (depositors[_label] != msg.sender) revert OnlyOriginalDepositor();", "", "test_onlyTheDepositorRagequits"],
  [PP, "if (!RAGEQUIT_VERIFIER.verifyProof(_proof.pA, _proof.pB, _proof.pC, _proof.pubSignals)) revert InvalidProof();", "", "test_aRagequitWithAnotherValueIsRefused"],
  [PP, "if (!_isInState(_proof.commitmentHash())) revert InvalidCommitment();", "", "test_aRagequitOfANoteNeverDepositedIsRefused"],
  [PP, "_spend(_proof.nullifierHash());", "", "test_theDepositorRagequits"],
  [ST, "if (nullifierHashes[_nullifierHash]) revert NullifierAlreadySpent();", "", "test_aSpentNullifierIsRefused"],
  [ST, "if (_merkleTree.depth > MAX_TREE_DEPTH) revert MaxTreeDepthReached();", "", "test_aStateTreePast32IsRefused"],
  [ST, "if (_labelTree.depth > MAX_TREE_DEPTH) revert MaxTreeDepthReached();", "", "test_aLabelTreePast32IsRefused"],
  [ST, "return knownStateRoots[_root];", "return _root == _merkleTree._root();", "test_anOldRootIsAccepted"],
  [ST, "return knownLabelRoots[_root];", "return _root == _labelTree._root();", "test_anOldRootIsAccepted"],
  [ST, "if (_entered) revert Reentrancy();", "", "test_aPayeeCannotReenterWithdraw"],
  [SIMPLE, "if (msg.value != _amount) revert InsufficientValue();", "", "test_depositRefusesAValueOtherThanSent"],
  [SIMPLE, "if (!_success) revert FailedToSendNativeAsset();", "", "test_aPayeeThatRefusesEtherRevertsTheWithdrawal"],
  ["src/verifiers/WithdrawalVerifier.sol", "checkField(calldataload(add(_pubSignals, 32)))", "", "test_aSignalAtOrAbovePIsRefused"],
  // an added admin path: a selector, a DELEGATECALL, a storage slot
  [PP, "  /// @inheritdoc IPrivacyPool\n  function deposit(", "  function owner() external pure returns (address) {\n    return address(0);\n  }\n\n  /// @inheritdoc IPrivacyPool\n  function deposit(", "test_theDispatcherHasExactlyTheListedSelectors"],
  ["src/poseidon/PoseidonT3.sol", "function hash(uint256[2] memory _inputs) internal pure returns (uint256) {", "function hash(uint256[2] memory _inputs) public pure returns (uint256) {", "test_noDelegatecallCallcodeSelfdestructOrCreate"],
  [ST, "  /// @inheritdoc IState\n  uint256 public nonce;", "  /// @inheritdoc IState\n  uint256 public nonce;\n  address internal admin;", "layout"],
];

function run(dir, test) {
  try {
    if (test === "layout") execFileSync("node", ["--test", "test/layout.test.mjs"], { cwd: dir, stdio: "pipe" });
    else execFileSync("forge", ["test", "--mt", `^${test}$`], { cwd: dir, stdio: "pipe" });
    return "pass";
  } catch {
    return "fail";
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = mkdtempSync(path.join(tmpdir(), "pool-evm-mutants-"));
  let bad = 0;
  try {
    cpSync(ROOT, dir, { recursive: true, filter: (f) => !/[/\\](out|cache)$/.test(f) });
    for (const t of new Set(MUTANTS.map((m) => m[3]))) {
      if (run(dir, t) !== "pass") {
        console.log(`FAIL ${t} fails on the pool as it is`);
        bad++;
      }
    }
    MUTANTS.forEach(([file, find, repl, t], i) => {
      const f = path.join(dir, file);
      const src = readFileSync(f, "utf8");
      if (src.split(find).length !== 2) {
        console.log(`FAIL mutant ${i + 1}: its text is not in ${file} exactly once`);
        bad++;
        return;
      }
      writeFileSync(f, src.replace(find, repl));
      const r = run(dir, t);
      writeFileSync(f, src);
      console.log(`${r === "fail" ? "ok  " : "FAIL"} mutant ${i + 1} ${file}: ${find.trim().split("\n")[0].slice(0, 70)} -> ${t} ${r === "fail" ? "fails" : "PASSES"}`);
      if (r !== "fail") bad++;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(bad === 0 ? `every one of ${MUTANTS.length} mutants fails its named test` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
