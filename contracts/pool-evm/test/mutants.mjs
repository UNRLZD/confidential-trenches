// SPDX-License-Identifier: Apache-2.0
// Removes each of the pool's checks, one at a time, in a copy of contracts/pool-evm, and runs the test named for it:
// each named test passes on the pool as it is and fails on every mutant. Exits 1 when a named test passes on its
// mutant, fails on the pool as it is, or a mutant's text is not found exactly once. Needs forge (Foundry).
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
  ["src/verifiers/WithdrawalVerifier.sol", "checkField(calldataload(add(_pubSignals, 32)))", "", "test_aSignalAtOrAbovePIsRefused"],
  // an added admin path: a selector, a DELEGATECALL, a storage slot
  [PP, "  /// @inheritdoc IPrivacyPool\n  function deposit(", "  function owner() external pure returns (address) {\n    return address(0);\n  }\n\n  /// @inheritdoc IPrivacyPool\n  function deposit(", "test_theDispatcherHasExactlyTheListedSelectors"],
  [PP, "  /// @inheritdoc IPrivacyPool\n  function deposit(", "  function depositors(uint256) external pure returns (address) {\n    return address(0);\n  }\n\n  /// @inheritdoc IPrivacyPool\n  function deposit(", "test_ragequitIsAbsent"],
  ["src/poseidon/PoseidonT3.sol", "function hash(uint256[2] memory _inputs) internal pure returns (uint256) {", "function hash(uint256[2] memory _inputs) public pure returns (uint256) {", "test_noDelegatecallCallcodeSelfdestructOrCreate"],
  [ST, "  /// @inheritdoc IState\n  uint256 public nonce;", "  /// @inheritdoc IState\n  uint256 public nonce;\n  address internal admin;", "layout"],
];

// "pass" or "fail" of one named test; throws unless forge ran exactly that one test (forge matches --mt against
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
    out = execFileSync("forge", ["test", "--mt", `^${test}\\(`], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const ran = out.match(new RegExp(`^\\[(PASS|FAIL).*\\] ${test}\\(`, "gm")) ?? [];
  // forge prints a failing test twice, in the run and in the summary
  if (ran.length >= 1 && ran.every((r) => r === ran[0])) return ran[0].startsWith("[PASS") ? "pass" : "fail";
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
      if (run(dir, t) !== "pass") {
        console.log(`FAIL ${t} fails on the pool as it is`);
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
