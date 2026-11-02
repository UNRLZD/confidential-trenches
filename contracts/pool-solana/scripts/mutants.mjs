// SPDX-License-Identifier: Apache-2.0
// Removes each of the pool's checks in turn and shows that a named LiteSVM test fails without it and passes with it.
// For each mutant: the source line is replaced (it must occur exactly once), cargo-build-sbf builds that program into
// out/mutant/, the source is restored, and the named test runs against the mutant (must FAIL) and against the real
// program in out/ (must PASS). Exit 0 only when every mutant is caught.
//   cd contracts/pool-solana && cargo-build-sbf --sbf-out-dir out && node scripts/mutants.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const SO = "blindfill_pool_solana.so";

// [name, file, the check as written, the check removed, the test that must fail]
export const MUTANTS = [
  ["deadline", "src/release.rs", "if now_ms > r.deadline_ms {", "if false {", "a_past_deadline_is_refused"],
  ["W signs", "src/release.rs", "if !recipient.is_signer {", "if false {", "w_not_a_signer_is_refused"],
  ["fee payer signs", "src/release.rs", "if !fee_payer.is_signer {", "if false {", "a_fee_payer_not_signing_or_another_fee_payer_is_refused"],
  ["W or fee payer not the pool", "src/release.rs", "if recipient.key == pool_acc.key || fee_payer.key == pool_acc.key {", "if false {", "a_different_w_is_refused"],
  ["context binds W", "src/release.rs", "recipient: recipient.key.to_bytes(),", "recipient: [0; 32],", "deposit_then_release_pays_w_and_the_fee_payer"],
  ["fee cap", "src/release.rs", "if r.relay_fee > r.relay_fee_cap {", "if false {", "a_fee_over_the_cap_is_refused"],
  ["tree depths", "src/release.rs", "if r.state_depth > MAX_TREE_DEPTH || r.label_depth > MAX_TREE_DEPTH {", "if false {", "a_changed_public_signal_is_refused"],
  ["what the notes hold", "src/release.rs", "if r.withdrawn as u128 > held {", "if false {", "a_release_over_what_the_notes_hold_is_refused"],
  ["Groth16 verify", "src/release.rs", "verify_withdraw(&r.proof, &signals)?;", "let _ = (&r.proof, &signals);", "a_changed_public_signal_is_refused"],
  ["spent mark", "src/release.rs", "state::put_mark(program_id, fee_payer, spent_mark, system, SPENT_SEED, &r.nullifier_hash, PoolError::NullifierAlreadySpent)?;", "let _ = (spent_mark, SPENT_SEED);", "the_same_note_twice_is_refused"],
  ["signals below p (both layers)", "src/release.rs", "if !field::is_field(&r.new_commitment) || !field::is_field(&r.nullifier_hash) {", "if false {", "a_signal_at_or_over_p_is_refused", ["src/verifier.rs", "        if !field::is_field(s) {", "        if false {"]],
  ["coordinates below q", "src/verifier.rs", "if !field::is_coord(c) {", "if false {", "a_signal_at_or_over_p_is_refused"],
  ["page owner", "src/state.rs", "    if page.owner != program_id {\n        return None;", "    if false {\n        return None;", "a_forged_page_is_refused"],
  ["root index in the tree", "src/state.rs", "if page_entries(program_id, page, tree, page_no)? <= slot {", "if false {", "an_unknown_root_is_refused"],
  ["mark address", "src/state.rs", "    if addr != *mark.key {\n        return Err(PoolError::WrongAccount.into());", "    if false {\n        return Err(PoolError::WrongAccount.into());", "a_wrong_spent_mark_is_refused"],
  ["minimum deposit", "src/deposit.rs", "if value < MIN_DEPOSIT {", "if false {", "deposit_refusals"],
  ["precommitment unused", "src/deposit.rs", "state::put_mark(program_id, depositor, pre_mark, system, PRE_SEED, &precommitment, PoolError::PrecommitmentAlreadyUsed)?;", "let _ = (pre_mark, PRE_SEED);", "deposit_refusals"],
  ["withdrawn not 0", "src/release.rs", "if r.withdrawn == 0 {", "if false {", "a_zero_withdrawal_and_a_fee_over_the_backstop_are_refused"],
  ["fee backstop", "src/release.rs", "if !fee_within_backstop(r.relay_fee, r.withdrawn) {", "if false {", "a_zero_withdrawal_and_a_fee_over_the_backstop_are_refused"],
  ["a new page at its address", "src/state.rs", "        if addr != *page.key {\n            return Err(PoolError::WrongAccount.into());", "        if false {\n            return Err(PoolError::WrongAccount.into());", "inserts_cross_the_page_boundary_in_both_trees"],
  ["entry time", "src/state.rs", "    d[at + 64..at + 72].copy_from_slice(&now.to_le_bytes());", "    let _ = now;", "each_page_entry_holds_the_clock_at_its_insert"],
  ["init once", "src/state.rs", "    if target.owner == program_id {\n        return Err(exists.into());", "    if false {\n        return Err(exists.into());", "init_twice_is_refused"],
];

function test(name, so) {
  const r = spawnSync("cargo", ["+1.97.1", "test", "--quiet", "--manifest-path", "svm-tests/Cargo.toml", "--", "--exact", name], {
    cwd: here,
    env: { ...process.env, POOL_SO: so },
    encoding: "utf8",
  });
  return r.status === 0;
}

function swap(edits) {
  const saved = [];
  for (const [file, from, to] of edits) {
    const p = join(here, file);
    const src = readFileSync(p, "utf8");
    if (src.split(from).length !== 2) throw new Error(`${file}: the check must occur exactly once: ${from}`);
    saved.push([p, src]);
    writeFileSync(p, src.replace(from, to));
  }
  return () => saved.forEach(([p, src]) => writeFileSync(p, src));
}

let caught = 0;
for (const [name, file, from, to, testName, extra] of MUTANTS) {
  const restore = swap([[file, from, to], ...(extra ? [extra] : [])]);
  try {
    execFileSync("cargo-build-sbf", ["--sbf-out-dir", "out/mutant"], { cwd: here, stdio: "ignore" });
  } finally {
    restore();
  }
  const red = !test(testName, join(here, "out/mutant", SO));
  const green = test(testName, join(here, "out", SO));
  if (red && green) caught++;
  console.log(`${red && green ? "CAUGHT" : "MISSED"} ${name}: ${testName} ${red ? "fails" : "PASSES"} without it, ${green ? "passes" : "FAILS"} with it`);
}
console.log(`${caught}/${MUTANTS.length} mutants caught`);
process.exit(caught === MUTANTS.length ? 0 : 1);
