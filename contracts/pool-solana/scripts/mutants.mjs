// SPDX-License-Identifier: Apache-2.0
// Removes each of the pool's checks in turn and shows that a named LiteSVM test fails without it and passes with it.
// For each mutant: the source line is replaced (it must occur exactly once), cargo-build-sbf builds that program into
// out/mutant/, the source is restored, and the named test runs against the mutant (must FAIL) and against the real
// program in out/ (must PASS). Exit 0 only when every mutant is caught.
//   cd contracts/pool-solana && cargo-build-sbf --sbf-out-dir out && (cd svm-tests/evil-venue && cargo-build-sbf --sbf-out-dir ../../out) \
//     && node scripts/mutants.mjs
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
  ["change page is the tree's current page", "src/state.rs", "if page_entries(program_id, page, tree, page_no) != Some(slot) {", "if false {", "a_wrong_change_page_is_refused"],
  ["funded address topped up", "src/state.rs", "        if rent > have {\n            transfer(payer, target, system, rent - have)?;", "        if false {\n            transfer(payer, target, system, rent - have)?;", "a_funded_pool_or_page_address_blocks_nothing"],
  ["spent counted", "src/release.rs", "pool.spent = pool.spent.checked_add(r.withdrawn as u128).ok_or(PoolError::Overflow)?;", "let _ = PoolError::Overflow;", "a_release_counts_what_it_spends"],
  ["init once", "src/state.rs", "    if target.owner == program_id {\n        return Err(exists.into());", "    if false {\n        return Err(exists.into());", "init_twice_is_refused"],
  // tag 3 (src/buy.rs, and its tip in src/release.rs's shared settle)
  ["tip cap", "src/release.rs", "if tip > r.tip_cap {", "if false {", "a_tip_over_the_tip_cap_is_refused"],
  ["fee and tip within the chunk", "src/release.rs", "let to_recipient = r.withdrawn.checked_sub(r.relay_fee).and_then(|v| v.checked_sub(tip)).ok_or(PoolError::InvalidWithdrawalAmount)?;", "let to_recipient = r.withdrawn.wrapping_sub(r.relay_fee).wrapping_sub(tip);", "a_fee_and_tip_over_the_chunk_is_refused"],
  ["tip paid", "src/release.rs", "**t.try_borrow_mut_lamports()? = t.lamports().checked_add(tip).ok_or(PoolError::Overflow)?;", "let _ = (t, PoolError::Overflow);", "release_and_buy_pays_w_the_fee_payer_and_the_tip_then_runs_ws_instruction"],
  ["flags", "src/buy.rs", "if flags & !FLAG_COMPRESSED != 0 {", "if false {", "tag3_data_refusals"],
  ["inner count", "src/buy.rs", "if count == 0 || count > MAX_INNER {", "if false {", "tag3_data_refusals"],
  ["inner index in the accounts", "src/buy.rs", "if *program as usize >= n_accounts || accounts.iter().any(|&i| i as usize >= n_accounts) {", "if false {", "tag3_data_refusals"],
  ["data ends exactly", "src/buy.rs", "    if !d.is_empty() {", "    if false {", "tag3_data_refusals"],
  ["pool never calls itself", "src/buy.rs", "if accounts[x.program].key == program_id {", "if false {", "the_pool_never_calls_itself"],
  ["inner names no pool account", "src/buy.rs", "if is_pool_account(program_id, accounts, a) {", "if false {", "an_inner_instruction_naming_a_pool_account_is_refused"],
  ["tip account not a pool account", "src/buy.rs", "if is_pool_account(program_id, accounts, t) {", "if false {", "an_inner_instruction_naming_a_pool_account_is_refused"],
  ["pool account: owned by the pool", "src/buy.rs", "a.owner == program_id || [0, 3, 4, 5, 6]", "false || [0, 3, 4, 5, 6]", "an_inner_instruction_naming_a_pool_account_is_refused"],
  ["pool account: the release's own", "src/buy.rs", "[0, 3, 4, 5, 6].iter().any(|&i| accounts[i].key == a.key)", "[0usize; 0].iter().any(|&i| accounts[i].key == a.key)", "an_inner_instruction_naming_a_pool_account_is_refused"],
  ["inner signer only W", "src/buy.rs", "if a.is_signer && a.key != recipient.key {", "if false {", "an_inner_signer_other_than_w_is_refused"],
  // from the independent review of f1081f7
  ["inner pool accounts by key, not index", "src/buy.rs", "            if is_pool_account(program_id, accounts, a) {", "            if a.owner == program_id || [0u8, 3, 4, 5, 6].contains(&i) {", "a_pool_account_named_again_at_another_index_is_refused"],
  ["tip account: anything the pool owns", "src/buy.rs", "        if is_pool_account(program_id, accounts, t) {", "        if [0usize, 3, 4, 5, 6].iter().any(|&i| accounts[i].key == t.key) {", "a_tip_to_an_account_the_pool_owns_is_refused"],
  ["compressed A decoded or refused", "src/buy.rs", "    let a = alt_bn128_g1_decompress_be(c[0..32].try_into().unwrap()).map_err(bad)?;", "    let a = alt_bn128_g1_decompress_be(c[0..32].try_into().unwrap()).unwrap_or([0u8; 64]);", "a_compressed_point_off_its_curve_is_refused"],
  ["tip account only when the tip is above 0", "src/buy.rs", "    let tip_to = if tip > 0 {", "    let tip_to = if true {", "release_and_buy_with_no_tip_lands"],
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
