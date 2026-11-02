// SPDX-License-Identifier: Apache-2.0
//! The pool program in LiteSVM (litesvm 0.17, agave 4.3's runtime): six deposits, then releases with real withdraw
//! proofs made for the pool's context (../fixtures/release-spends.json, made by ../fixtures/make-release-spends.mjs),
//! and 1,025 deposits with two releases that carry both trees across a page boundary (../fixtures/boundary-spends.json,
//! made by ../fixtures/make-boundary-spends.mjs). Each refusal is checked by its error code. The program is the one
//! cargo-build-sbf built: POOL_SO, else ../target/deploy/blindfill_pool_solana.so.
//!
//! Prints `CU release <n>` and `BYTES release <n>` for the release transaction (a legacy message with a compute-limit
//! instruction, no lookup table).

use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use serde_json::Value;
use sha2::{Digest, Sha256};
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_address::Address as Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

const FIXTURE: &str = include_str!("../../fixtures/release-spends.json");
const BOUNDARY: &str = include_str!("../../fixtures/boundary-spends.json");
const SYSTEM: Pubkey = Pubkey::new_from_array([0; 32]);
/// A page entry: leaf (32) ‖ root (32) ‖ the Clock's unix_timestamp at the insert (i64 LE).
const ENTRY: usize = 72;
const P_HEX: &str = "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";

// the program's error codes (src/error.rs)
const FIELD_OVERFLOW: u32 = 2;
const DEADLINE_EXPIRED: u32 = 4;
const INVALID_RECIPIENT: u32 = 5;
const RECIPIENT_NOT_SIGNER: u32 = 6;
const FEE_PAYER_NOT_SIGNER: u32 = 7;
const INVALID_TREE_DEPTH: u32 = 8;
const UNKNOWN_STATE_ROOT: u32 = 9;
const UNKNOWN_LABEL_ROOT: u32 = 10;
const INVALID_WITHDRAWAL_AMOUNT: u32 = 11;
const RELAY_FEE_OVER_CAP: u32 = 12;
const RELAY_FEE_GREATER_THAN_MAX: u32 = 13;
const INVALID_POOL_STATE: u32 = 14;
const INVALID_PROOF: u32 = 15;
const NULLIFIER_ALREADY_SPENT: u32 = 16;
const MINIMUM_DEPOSIT_AMOUNT: u32 = 19;
const INVALID_PRECOMMITMENT: u32 = 20;
const PRECOMMITMENT_ALREADY_USED: u32 = 21;
const WRONG_ACCOUNT: u32 = 22;
const ALREADY_INITIALIZED: u32 = 23;

fn fx() -> Value {
    serde_json::from_str(FIXTURE).unwrap()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn h32(s: &str) -> [u8; 32] {
    unhex(s).try_into().unwrap()
}

fn key_of(v: &Value) -> Pubkey {
    Pubkey::new_from_array(h32(v.as_str().unwrap()))
}

/// The test key `name`: the ed25519 key of the seed sha256("pool-sol-core/test-key/<name>"), as the fixture's.
fn test_key(name: &str) -> Keypair {
    let seed: [u8; 32] = Sha256::digest(format!("pool-sol-core/test-key/{name}").as_bytes()).into();
    Keypair::new_from_array(seed)
}

struct Env {
    svm: LiteSVM,
    program: Pubkey,
    pool: Pubkey,
    depositor: Keypair,
    w: Keypair,
    w2: Keypair,
    fee_payer: Keypair,
    f: Value,
}

fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

fn page(env: &Env, tree: u8, index: u64) -> Pubkey {
    pda(&[b"page", &[tree], &((index / 1024) as u32).to_le_bytes()], &env.program)
}

fn compute_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction { program_id: "ComputeBudget111111111111111111111111111111".parse().unwrap(), accounts: vec![], data }
}

/// Sends `ixs` paid by `payer`, signed by `signers`; Ok(meta) or Err(the custom code, or u32::MAX for another error).
fn send(env: &mut Env, ixs: &[Instruction], payer: &Pubkey, signers: &[&Keypair]) -> Result<TransactionMetadata, u32> {
    env.svm.expire_blockhash();
    let msg = Message::new(ixs, Some(payer));
    let tx = Transaction::new(signers, msg, env.svm.latest_blockhash());
    env.svm.send_transaction(tx).map_err(|e: FailedTransactionMetadata| {
        let s = format!("{:?}", e.err);
        if std::env::var("POOL_LOGS").is_ok() {
            eprintln!("{s}\n{:#?}", e.meta.logs);
        }
        match s.find("Custom(") {
            Some(at) => s[at + 7..].split(')').next().unwrap().parse().unwrap(),
            None => {
                eprintln!("not a custom error: {s}\n{:#?}", e.meta.logs);
                u32::MAX
            }
        }
    })
}

/// Bytes of a signed legacy transaction: the signature count, the signatures, the message.
fn tx_bytes(ixs: &[Instruction], payer: &Pubkey, signers: usize) -> usize {
    1 + 64 * signers + Message::new(ixs, Some(payer)).serialize().len()
}

fn so_path() -> String {
    std::env::var("POOL_SO").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../target/deploy/blindfill_pool_solana.so").into())
}

/// A fresh LiteSVM with the program at the fixture's id and the pool made.
fn fresh() -> Env {
    let f = fx();
    let program = key_of(&f["program"]);
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(program, so_path()).expect("the program .so (cargo-build-sbf, or POOL_SO)");
    let (w, w2, fee_payer) = (test_key("W"), test_key("W2"), test_key("FEE_PAYER"));
    assert_eq!(w.pubkey(), key_of(&f["w"]), "W is the fixture's");
    assert_eq!(w2.pubkey(), key_of(&f["w2"]));
    assert_eq!(fee_payer.pubkey(), key_of(&f["fee_payer"]));
    let pool = key_of(&f["pool"]);
    assert_eq!(Pubkey::find_program_address(&[b"pool"], &program), (pool, f["pool_bump"].as_u64().unwrap() as u8));
    let depositor = Keypair::new();
    svm.airdrop(&depositor.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&fee_payer.pubkey(), 1_000_000_000).unwrap();
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = 1_800_000_000;
    svm.set_sysvar(&clock);
    let mut env = Env { svm, program, pool, depositor, w, w2, fee_payer, f };
    let init = Instruction {
        program_id: program,
        accounts: vec![AccountMeta::new(pool, false), AccountMeta::new(env.depositor.pubkey(), true), AccountMeta::new_readonly(SYSTEM, false)],
        data: vec![0],
    };
    let payer = env.depositor.pubkey();
    let d = env.depositor.insecure_clone();
    send(&mut env, &[init], &payer, &[&d]).expect("init");
    env
}

fn deposit_ix(env: &Env, value: u64, precommitment: &[u8; 32], state_size: u64, label_size: u64) -> Instruction {
    let mut data = vec![1u8];
    data.extend_from_slice(&value.to_le_bytes());
    data.extend_from_slice(precommitment);
    Instruction {
        program_id: env.program,
        accounts: vec![
            AccountMeta::new(env.pool, false),
            AccountMeta::new(env.depositor.pubkey(), true),
            AccountMeta::new(page(env, 0, state_size), false),
            AccountMeta::new(page(env, 1, label_size), false),
            AccountMeta::new(pda(&[b"pre", precommitment], &env.program), false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data,
    }
}

fn deposit(env: &mut Env, value: u64, precommitment: &[u8; 32], state_size: u64, label_size: u64) -> Result<TransactionMetadata, u32> {
    let ix = deposit_ix(env, value, precommitment, state_size, label_size);
    let payer = env.depositor.pubkey();
    let d = env.depositor.insecure_clone();
    send(env, &[ix], &payer, &[&d])
}

/// The root at `index` of `tree`, read from its page.
fn root_at(env: &Env, tree: u8, index: u64) -> [u8; 32] {
    let a = env.svm.get_account(&page(env, tree, index)).expect("page");
    let at = 16 + (index % 1024) as usize * ENTRY + 32;
    a.data[at..at + 32].try_into().unwrap()
}

/// The time stored with entry `index` of `tree`.
fn time_at(env: &Env, tree: u8, index: u64) -> i64 {
    let a = env.svm.get_account(&page(env, tree, index)).expect("page");
    let at = 16 + (index % 1024) as usize * ENTRY + 64;
    i64::from_le_bytes(a.data[at..at + 8].try_into().unwrap())
}

/// The Clock's unix_timestamp at deposit `i` in `with_deposits`: a different second for each.
fn deposit_time(i: u64) -> i64 {
    1_800_000_000 + 13 * i as i64
}

/// `fresh()` with the fixture's six deposits; each root is checked against the fixture's off-chain trees.
fn with_deposits() -> Env {
    let mut env = fresh();
    let deps = env.f["deposits"].as_array().unwrap().clone();
    for (i, d) in deps.iter().enumerate() {
        let value: u64 = d["value"].as_str().unwrap().parse().unwrap();
        set_time(&mut env, deposit_time(i as u64));
        deposit(&mut env, value, &h32(d["precommitment"].as_str().unwrap()), i as u64, i as u64).expect("deposit");
        let i = i as u64;
        assert_eq!((time_at(&env, 0, i), time_at(&env, 1, i)), (deposit_time(i), deposit_time(i)), "the time of entry {i}");
        assert_eq!(hex(&root_at(&env, 0, i)), env.f["state_roots"][i as usize].as_str().unwrap(), "state root after deposit {i}");
        assert_eq!(hex(&root_at(&env, 1, i)), env.f["label_roots"][i as usize].as_str().unwrap(), "label root after deposit {i}");
        let pa = env.svm.get_account(&page(&env, 0, i)).unwrap();
        let at = 16 + i as usize * ENTRY;
        assert_eq!(hex(&pa.data[at..at + 32]), d["commitment"].as_str().unwrap(), "commitment {i}");
    }
    env
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// A release as the instruction carries it, editable by each test.
#[derive(Clone)]
struct Rel {
    proof: Vec<u8>,
    new_commitment: [u8; 32],
    nullifier: [u8; 32],
    withdrawn: u64,
    state_root_index: u32,
    state_depth: u8,
    label_root_index: u32,
    label_depth: u8,
    relay_fee: u64,
    relay_fee_cap: u64,
    tip_cap: u64,
    deadline_ms: u64,
    salt: [u8; 16],
    // accounts
    recipient: Pubkey,
    recipient_signs: bool,
    fee_payer: Pubkey,
    fee_payer_signs: bool,
    state_root_page: Option<Pubkey>,
}

const FEE: u64 = 2_000_000;

fn rel(env: &Env, name: &str) -> Rel {
    let s = env.f["spends"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap().clone();
    rel_of(env, &s)
}

/// A release of the spend `s` (a fixture's `spends` entry), to W, paid by the fee payer.
fn rel_of(env: &Env, s: &Value) -> Rel {
    let n = |k: &str| s[k].as_u64().unwrap();
    Rel {
        proof: unhex(s["proof"].as_str().unwrap()),
        new_commitment: h32(s["new_commitment"].as_str().unwrap()),
        nullifier: h32(s["nullifier_hash"].as_str().unwrap()),
        withdrawn: s["withdrawn"].as_str().unwrap().parse().unwrap(),
        state_root_index: n("state_root_index") as u32,
        state_depth: n("state_depth") as u8,
        label_root_index: n("label_root_index") as u32,
        label_depth: n("label_depth") as u8,
        relay_fee: FEE,
        relay_fee_cap: env.f["relay_fee_cap"].as_str().unwrap().parse().unwrap(),
        tip_cap: env.f["tip_cap"].as_str().unwrap().parse().unwrap(),
        deadline_ms: env.f["deadline_ms"].as_str().unwrap().parse().unwrap(),
        salt: unhex(s["salt"].as_str().unwrap()).try_into().unwrap(),
        recipient: env.w.pubkey(),
        recipient_signs: true,
        fee_payer: env.fee_payer.pubkey(),
        fee_payer_signs: true,
        state_root_page: None,
    }
}

fn state_size(env: &Env) -> u64 {
    // the pool account: size of the state tree at offset 49
    let a = env.svm.get_account(&env.pool).unwrap();
    u64::from_le_bytes(a.data[49..57].try_into().unwrap())
}

fn release_ix(env: &Env, r: &Rel) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&r.proof);
    data.extend_from_slice(&r.new_commitment);
    data.extend_from_slice(&r.nullifier);
    data.extend_from_slice(&r.withdrawn.to_le_bytes());
    data.extend_from_slice(&r.state_root_index.to_le_bytes());
    data.push(r.state_depth);
    data.extend_from_slice(&r.label_root_index.to_le_bytes());
    data.push(r.label_depth);
    data.extend_from_slice(&r.relay_fee.to_le_bytes());
    data.extend_from_slice(&r.relay_fee_cap.to_le_bytes());
    data.extend_from_slice(&r.tip_cap.to_le_bytes());
    data.extend_from_slice(&r.deadline_ms.to_le_bytes());
    data.extend_from_slice(&r.salt);
    assert_eq!(data.len(), 387);
    let meta = |k: Pubkey, signs: bool| if signs { AccountMeta::new(k, true) } else { AccountMeta::new(k, false) };
    Instruction {
        program_id: env.program,
        accounts: vec![
            AccountMeta::new(env.pool, false),
            meta(r.recipient, r.recipient_signs),
            meta(r.fee_payer, r.fee_payer_signs),
            AccountMeta::new(pda(&[b"spent", &r.nullifier], &env.program), false),
            AccountMeta::new_readonly(r.state_root_page.unwrap_or_else(|| page(env, 0, r.state_root_index as u64)), false),
            AccountMeta::new_readonly(page(env, 1, r.label_root_index as u64), false),
            AccountMeta::new(page(env, 0, state_size(env)), false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data,
    }
}

/// Sends a release paid by the fee payer (or by a third account when the fee payer does not sign), signed by W, W2 or
/// no recipient as `r` says.
fn release_with(env: &mut Env, r: &Rel, signer: Option<&Keypair>) -> Result<TransactionMetadata, u32> {
    let ixs = [compute_limit(400_000), release_ix(env, r)];
    let fp = env.fee_payer.insecure_clone();
    let mut signers: Vec<Keypair> = vec![];
    let payer = if r.fee_payer_signs {
        signers.push(fp);
        env.fee_payer.pubkey()
    } else {
        let other = Keypair::new();
        env.svm.airdrop(&other.pubkey(), 1_000_000_000).unwrap();
        let k = other.pubkey();
        signers.push(other);
        k
    };
    if let Some(s) = signer {
        signers.push(s.insecure_clone());
    }
    let refs: Vec<&Keypair> = signers.iter().collect();
    send(env, &ixs, &payer, &refs)
}

fn release(env: &mut Env, r: &Rel) -> Result<TransactionMetadata, u32> {
    let w = env.w.insecure_clone();
    release_with(env, r, if r.recipient_signs { Some(&w) } else { None })
}

fn lamports(env: &Env, k: &Pubkey) -> u64 {
    env.svm.get_account(k).map(|a| a.lamports).unwrap_or(0)
}

#[test]
fn deposit_then_release_pays_w_and_the_fee_payer() {
    let mut env = with_deposits();
    let r = rel(&env, "release");
    let (pool0, w0, f0) = (lamports(&env, &env.pool), lamports(&env, &env.w.pubkey()), lamports(&env, &env.fee_payer.pubkey()));
    assert_eq!(w0, 0, "W is a fresh wallet");
    let meta = release(&mut env, &r).expect("the release lands");
    println!("CU release {}", meta.compute_units_consumed);
    println!("BYTES release {}", tx_bytes(&[compute_limit(400_000), release_ix(&env, &r)], &env.fee_payer.pubkey(), 2));
    assert_eq!(lamports(&env, &env.pool), pool0 - r.withdrawn, "the pool pays withdrawnValue");
    assert_eq!(lamports(&env, &env.w.pubkey()), r.withdrawn - FEE, "W gets withdrawnValue - fee");
    let spent_mark = pda(&[b"spent", &r.nullifier], &env.program);
    let mark_rent = lamports(&env, &spent_mark);
    assert!(mark_rent > 0 && env.svm.get_account(&spent_mark).unwrap().owner == env.program, "the spent mark exists");
    let f1 = lamports(&env, &env.fee_payer.pubkey());
    // the fee payer: + fee, - the spent mark's rent, - the page entry's rent, - the transaction fee (2 signatures)
    let entry_rent = env.svm.minimum_balance_for_rent_exemption(16 + 7 * ENTRY) - env.svm.minimum_balance_for_rent_exemption(16 + 6 * ENTRY);
    assert_eq!(f1, f0 + FEE - mark_rent - entry_rent - 10_000, "the fee payer's balance");
    println!("RENT spent mark {mark_rent} page entry {entry_rent}");
    assert_eq!(hex(&root_at(&env, 0, 6)).len(), 64);
    let pa = env.svm.get_account(&page(&env, 0, 6)).unwrap();
    assert_eq!(&pa.data[16 + 6 * ENTRY..16 + 6 * ENTRY + 32], &r.new_commitment, "the change note is leaf 6");
    assert_eq!(state_size(&env), 7);
}

#[test]
fn the_same_note_twice_is_refused() {
    let mut env = with_deposits();
    let r = rel(&env, "release");
    release(&mut env, &r).expect("the first release lands");
    // the same proof again, in a new transaction
    assert_eq!(release(&mut env, &r).err(), Some(NULLIFIER_ALREADY_SPENT));
    // another proof of the same note (same nullifier hash, another amount)
    let r2 = rel(&env, "same_nullifier");
    assert_eq!(r2.nullifier, r.nullifier);
    assert_eq!(release(&mut env, &r2).err(), Some(NULLIFIER_ALREADY_SPENT));
}

#[test]
fn an_old_root_is_accepted() {
    let mut env = with_deposits();
    { let r0 = rel(&env, "release"); release(&mut env, &r0) }.expect("release");
    // made against the roots of the first 4 deposits; the pool has had 6 deposits and a change note since
    let r = rel(&env, "old_root");
    assert_eq!((r.state_root_index, r.label_root_index), (3, 3));
    release(&mut env, &r).expect("a proof against an older root lands");
}

#[test]
fn an_unknown_root_is_refused() {
    let mut env = with_deposits();
    // a proof made against another pool's trees: whatever index it names, the root there is this pool's
    let r = rel(&env, "other_pool");
    assert_eq!(release(&mut env, &r).err(), Some(INVALID_PROOF));
    // an index past either tree has no root
    let mut x = rel(&env, "release");
    x.state_root_index = 6;
    assert_eq!(release(&mut env, &x).err(), Some(UNKNOWN_STATE_ROOT));
    let mut x = rel(&env, "release");
    x.label_root_index = 6;
    assert_eq!(release(&mut env, &x).err(), Some(UNKNOWN_LABEL_ROOT));
    // a page that is not the index's: the label tree's page in the state tree's place
    let mut x = rel(&env, "release");
    x.state_root_page = Some(page(&env, 1, 0));
    assert_eq!(release(&mut env, &x).err(), Some(UNKNOWN_STATE_ROOT));
    // and the real release still lands
    { let r0 = rel(&env, "release"); release(&mut env, &r0) }.expect("release");
}

#[test]
fn w_not_a_signer_is_refused() {
    let mut env = with_deposits();
    let mut r = rel(&env, "release");
    r.recipient_signs = false;
    assert_eq!(release(&mut env, &r).err(), Some(RECIPIENT_NOT_SIGNER));
}

#[test]
fn a_different_w_is_refused() {
    let mut env = with_deposits();
    let mut r = rel(&env, "release");
    r.recipient = env.w2.pubkey();
    let w2 = env.w2.insecure_clone();
    assert_eq!(release_with(&mut env, &r, Some(&w2)).err(), Some(INVALID_PROOF));
    // the pool as the recipient
    let mut r = rel(&env, "release");
    r.recipient = env.pool;
    r.recipient_signs = false;
    assert_eq!(release(&mut env, &r).err(), Some(INVALID_RECIPIENT));
}

#[test]
fn a_fee_payer_not_signing_or_another_fee_payer_is_refused() {
    let mut env = with_deposits();
    let mut r = rel(&env, "release");
    r.fee_payer_signs = false;
    assert_eq!(release(&mut env, &r).err(), Some(FEE_PAYER_NOT_SIGNER));
    // another fee payer, signing: the context names the fixture's
    let mut r = rel(&env, "release");
    let other = Keypair::new();
    env.svm.airdrop(&other.pubkey(), 1_000_000_000).unwrap();
    r.fee_payer = other.pubkey();
    let ixs = [compute_limit(400_000), release_ix(&env, &r)];
    let w = env.w.insecure_clone();
    assert_eq!(send(&mut env, &ixs, &other.pubkey(), &[&other, &w]).err(), Some(INVALID_PROOF));
}

#[test]
fn a_fee_over_the_cap_is_refused() {
    let mut env = with_deposits();
    let mut r = rel(&env, "release");
    r.relay_fee = r.relay_fee_cap + 1;
    assert_eq!(release(&mut env, &r).err(), Some(RELAY_FEE_OVER_CAP));
    // a higher cap than the proof's: the context changes
    let mut r = rel(&env, "release");
    r.relay_fee_cap += 1;
    r.relay_fee = r.relay_fee_cap;
    assert_eq!(release(&mut env, &r).err(), Some(INVALID_PROOF));
    // the cap itself passes
    let mut r = rel(&env, "release");
    r.relay_fee = r.relay_fee_cap;
    release(&mut env, &r).expect("a fee at the cap lands");
}

fn set_time(env: &mut Env, t: i64) {
    let mut clock: Clock = env.svm.get_sysvar();
    clock.unix_timestamp = t;
    env.svm.set_sysvar(&clock);
}

#[test]
fn a_past_deadline_is_refused() {
    let mut env = with_deposits();
    let r = rel(&env, "release");
    // one second past deadline_ms (the clock counts seconds; the program compares unix_timestamp * 1000)
    set_time(&mut env, (r.deadline_ms / 1000) as i64 + 1);
    assert_eq!(release(&mut env, &r).err(), Some(DEADLINE_EXPIRED));
    // another deadline than the proof's: the context changes
    set_time(&mut env, (r.deadline_ms / 1000) as i64);
    let mut x = r.clone();
    x.deadline_ms += 10;
    assert_eq!(release(&mut env, &x).err(), Some(INVALID_PROOF));
    release(&mut env, &r).expect("at the deadline it lands");
}

#[test]
fn a_signal_at_or_over_p_is_refused() {
    let mut env = with_deposits();
    let mut r = rel(&env, "release");
    r.new_commitment = h32(P_HEX);
    assert_eq!(release(&mut env, &r).err(), Some(FIELD_OVERFLOW));
    let mut r = rel(&env, "release");
    r.nullifier = [0xff; 32];
    assert_eq!(release(&mut env, &r).err(), Some(FIELD_OVERFLOW));
    // a proof coordinate at or over q
    let mut r = rel(&env, "release");
    r.proof[0..32].copy_from_slice(&[0xff; 32]);
    assert_eq!(release(&mut env, &r).err(), Some(3));
}

#[test]
fn a_changed_public_signal_is_refused() {
    let mut env = with_deposits();
    let base = rel(&env, "release");
    let mut cases: Vec<(&str, Rel)> = vec![];
    let mut x = base.clone();
    x.withdrawn += 1;
    cases.push(("withdrawnValue", x));
    let mut x = base.clone();
    x.new_commitment[31] ^= 1;
    cases.push(("newCommitmentHash", x));
    let mut x = base.clone();
    x.nullifier[31] ^= 1;
    cases.push(("existingNullifierHash", x));
    let mut x = base.clone();
    x.state_depth += 1;
    cases.push(("stateTreeDepth", x));
    let mut x = base.clone();
    x.label_depth -= 1;
    cases.push(("ASPTreeDepth", x));
    let mut x = base.clone();
    x.state_root_index = 4;
    cases.push(("stateRoot (another index)", x));
    let mut x = base.clone();
    x.label_root_index = 4;
    cases.push(("ASPRoot (another index)", x));
    let mut x = base.clone();
    x.tip_cap += 1;
    cases.push(("context: tip cap", x));
    let mut x = base.clone();
    x.salt[0] ^= 1;
    cases.push(("context: salt", x));
    for (what, x) in cases {
        assert_eq!(release(&mut env, &x).err(), Some(INVALID_PROOF), "{what}");
    }
    let mut x = base.clone();
    x.state_depth = 33;
    assert_eq!(release(&mut env, &x).err(), Some(INVALID_TREE_DEPTH));
    release(&mut env, &base).expect("the unchanged release lands");
}

#[test]
fn a_release_over_what_the_notes_hold_is_refused() {
    let mut env = with_deposits();
    // plant spent = deposited in the pool account (offsets 17 and 33): the notes hold nothing
    let mut a = env.svm.get_account(&env.pool).unwrap();
    let deposited: [u8; 16] = a.data[17..33].try_into().unwrap();
    a.data[33..49].copy_from_slice(&deposited);
    env.svm.set_account(env.pool, a).unwrap();
    assert_eq!({ let r0 = rel(&env, "release"); release(&mut env, &r0) }.err(), Some(INVALID_POOL_STATE));
}

#[test]
fn a_funded_mark_address_blocks_nothing() {
    let mut env = with_deposits();
    let r = rel(&env, "release");
    // anyone can send lamports to the spent mark's address before the release
    let mark = pda(&[b"spent", &r.nullifier], &env.program);
    let min = env.svm.minimum_balance_for_rent_exemption(0);
    env.svm.airdrop(&mark, min).unwrap();
    release(&mut env, &r).expect("the release lands");
    assert_eq!(env.svm.get_account(&mark).unwrap().owner, env.program);
    // and a precommitment's mark address before the deposit
    let pre = h32(&format!("{:064x}", 77));
    env.svm.airdrop(&pda(&[b"pre", &pre], &env.program), min + 5).unwrap();
    deposit(&mut env, 1_000_000, &pre, 7, 6).expect("the deposit lands");
}

#[test]
fn deposit_refusals() {
    let mut env = with_deposits();
    let pre = h32(&format!("{:064x}", 99));
    assert_eq!(deposit(&mut env, 999_999, &pre, 6, 6).err(), Some(MINIMUM_DEPOSIT_AMOUNT));
    assert_eq!(deposit(&mut env, 1_000_000, &[0; 32], 6, 6).err(), Some(INVALID_PRECOMMITMENT));
    assert_eq!(deposit(&mut env, 1_000_000, &h32(P_HEX), 6, 6).err(), Some(FIELD_OVERFLOW));
    let used = h32(env.f["deposits"][0]["precommitment"].as_str().unwrap());
    assert_eq!(deposit(&mut env, 1_000_000, &used, 6, 6).err(), Some(PRECOMMITMENT_ALREADY_USED));
    deposit(&mut env, 1_000_000, &pre, 6, 6).expect("a fresh precommitment lands");
}

#[test]
fn init_twice_is_refused() {
    let mut env = fresh();
    let init = Instruction {
        program_id: env.program,
        accounts: vec![AccountMeta::new(env.pool, false), AccountMeta::new(env.depositor.pubkey(), true), AccountMeta::new_readonly(SYSTEM, false)],
        data: vec![0],
    };
    let payer = env.depositor.pubkey();
    let d = env.depositor.insecure_clone();
    assert_eq!(send(&mut env, &[init], &payer, &[&d]).err(), Some(ALREADY_INITIALIZED));
}

fn dec(s: &str) -> [u8; 32] {
    let mut n = [0u8; 32];
    for c in s.bytes() {
        let mut carry = (c - b'0') as u32;
        for byte in n.iter_mut().rev() {
            let v = (*byte as u32) * 10 + carry;
            *byte = v as u8;
            carry = v >> 8;
        }
    }
    n
}

/// A page account the program did not make, with the header of page 0 and the other pool's roots at entry 5: the
/// owner check refuses it, so the other pool's proof cannot name its roots through it.
#[test]
fn a_forged_page_is_refused() {
    let mut env = with_deposits();
    let r = rel(&env, "other_pool");
    let s = env.f["spends"].as_array().unwrap().iter().find(|s| s["name"] == "other_pool").unwrap().clone();
    let forge = |tree: u8, root: [u8; 32]| {
        let mut data = vec![0u8; 16 + 6 * ENTRY];
        data[0..8].copy_from_slice(b"bfpage01");
        data[8] = tree;
        data[16 + 5 * ENTRY..16 + 5 * ENTRY + 32].copy_from_slice(&[1; 32]);
        data[16 + 5 * ENTRY + 32..16 + 5 * ENTRY + 64].copy_from_slice(&root);
        solana_account::Account { lamports: 10_000_000, data, owner: SYSTEM, executable: false, rent_epoch: 0 }
    };
    let (fs, fl) = (Keypair::new().pubkey(), Keypair::new().pubkey());
    env.svm.set_account(fs, forge(0, dec(s["public_signals"][3].as_str().unwrap()))).unwrap();
    env.svm.set_account(fl, forge(1, dec(s["public_signals"][5].as_str().unwrap()))).unwrap();
    let mut ix = release_ix(&env, &r);
    ix.accounts[4] = AccountMeta::new_readonly(fs, false);
    ix.accounts[5] = AccountMeta::new_readonly(fl, false);
    let fp = env.fee_payer.insecure_clone();
    let w = env.w.insecure_clone();
    let payer = fp.pubkey();
    assert_eq!(send(&mut env, &[compute_limit(400_000), ix], &payer, &[&fp, &w]).err(), Some(UNKNOWN_STATE_ROOT));
}

/// A spent mark at another address than `["spent", nullifierHash]` with the canonical bump is refused, so one note
/// has one mark.
#[test]
fn a_wrong_spent_mark_is_refused() {
    let mut env = with_deposits();
    let r = rel(&env, "release");
    let mut ix = release_ix(&env, &r);
    ix.accounts[3] = AccountMeta::new(Keypair::new().pubkey(), false);
    let fp = env.fee_payer.insecure_clone();
    let w = env.w.insecure_clone();
    let payer = fp.pubkey();
    assert_eq!(send(&mut env, &[compute_limit(400_000), ix], &payer, &[&fp, &w]).err(), Some(22));
}

/// Each page entry holds the Clock's unix_timestamp at its insert, in both trees, for deposits and for a release's
/// change note; an entry's time never changes after.
#[test]
fn each_page_entry_holds_the_clock_at_its_insert() {
    let mut env = with_deposits(); // checks each deposit's time in both trees
    let at = 1_800_000_500;
    set_time(&mut env, at);
    { let r = rel(&env, "release"); release(&mut env, &r) }.expect("release");
    assert_eq!(time_at(&env, 0, 6), at, "the change note's entry");
    for i in 0..6 {
        assert_eq!((time_at(&env, 0, i), time_at(&env, 1, i)), (deposit_time(i), deposit_time(i)), "entry {i} kept its time");
    }
}

/// Row 7 and the backstop of row 8, both before the proof is checked: withdrawnValue 0, and a fee within the cap but
/// over half of withdrawnValue.
#[test]
fn a_zero_withdrawal_and_a_fee_over_the_backstop_are_refused() {
    let mut env = with_deposits();
    let mut z = rel(&env, "release");
    z.withdrawn = 0;
    z.relay_fee = 0;
    assert_eq!(release(&mut env, &z).err(), Some(INVALID_WITHDRAWAL_AMOUNT));
    let mut b = rel(&env, "release");
    b.withdrawn = 3_000_000;
    b.relay_fee = 1_500_001; // at most the cap (2,500,000), one over half of 3,000,000
    assert!(b.relay_fee <= b.relay_fee_cap);
    assert_eq!(release(&mut env, &b).err(), Some(RELAY_FEE_GREATER_THAN_MAX));
    // exactly half passes the backstop and goes on to the proof, which binds another amount
    b.relay_fee = 1_500_000;
    assert_eq!(release(&mut env, &b).err(), Some(INVALID_PROOF));
    { let r = rel(&env, "release"); release(&mut env, &r) }.expect("the real release still lands");
}

/// Both trees cross from page 0 to page 1 (1,024 entries a page): the state tree by a release's change note, the
/// label tree by a deposit; then a release proves against roots read from page 1 of each. Proofs and roots from
/// ../fixtures/boundary-spends.json.
#[test]
fn inserts_cross_the_page_boundary_in_both_trees() {
    let mut env = fresh();
    let b: Value = serde_json::from_str(BOUNDARY).unwrap();
    let deps = b["deposits"].as_array().unwrap().clone();
    assert_eq!(deps.len(), 1025);
    let dep = |d: &Value| (d["value"].as_str().unwrap().parse::<u64>().unwrap(), h32(d["precommitment"].as_str().unwrap()));
    for (i, d) in deps[..1024].iter().enumerate() {
        let (v, pre) = dep(d);
        deposit(&mut env, v, &pre, i as u64, i as u64).expect("deposit");
    }
    assert_eq!(hex(&root_at(&env, 0, 1023)), b["state_roots"]["1023"].as_str().unwrap());
    assert_eq!(hex(&root_at(&env, 1, 1023)), b["label_roots"]["1023"].as_str().unwrap());
    let full = 16 + 1024 * ENTRY;
    assert_eq!(env.svm.get_account(&page(&env, 0, 0)).unwrap().data.len(), full, "state page 0 is full");
    assert_eq!(env.svm.get_account(&page(&env, 1, 0)).unwrap().data.len(), full, "label page 0 is full");
    assert!(env.svm.get_account(&page(&env, 0, 1024)).is_none());

    // the state tree's insert at 1,024, by a release: neither page 0 nor any other address than page 1's is its page
    let r = rel_of(&env, &b["spends"][0]);
    assert_eq!((r.state_root_index, r.label_root_index), (1023, 1023));
    let (fp, w) = (env.fee_payer.insecure_clone(), env.w.insecure_clone());
    let payer = fp.pubkey();
    for wrong in [page(&env, 0, 0), Keypair::new().pubkey()] {
        let mut ix = release_ix(&env, &r);
        ix.accounts[6] = AccountMeta::new(wrong, false);
        assert_eq!(send(&mut env, &[compute_limit(400_000), ix], &payer, &[&fp, &w]).err(), Some(WRONG_ACCOUNT));
    }
    let meta = release(&mut env, &r).expect("the release whose change opens state page 1 lands");
    println!("CU release opening a page {}", meta.compute_units_consumed);
    let p1 = env.svm.get_account(&page(&env, 0, 1024)).unwrap();
    assert_eq!(p1.owner, env.program);
    assert_eq!(p1.data.len(), 16 + ENTRY);
    assert_eq!(&p1.data[0..8], b"bfpage01");
    assert_eq!((p1.data[8], &p1.data[9..13]), (0, &1u32.to_le_bytes()[..]), "state page 1's header");
    assert_eq!(&p1.data[16..48], &r.new_commitment, "the change note is leaf 1,024");
    assert_eq!(hex(&root_at(&env, 0, 1024)), b["state_roots"]["1024"].as_str().unwrap());
    assert_eq!(env.svm.get_account(&page(&env, 0, 0)).unwrap().data.len(), full, "page 0 did not grow");

    // the label tree's insert at 1,024, by a deposit: page 0 is not its page
    let (v, pre) = dep(&deps[1024]);
    assert_eq!(deposit(&mut env, v, &pre, 1025, 0).err(), Some(WRONG_ACCOUNT));
    deposit(&mut env, v, &pre, 1025, 1024).expect("the deposit that opens label page 1 lands");
    assert_eq!(env.svm.get_account(&page(&env, 1, 1024)).unwrap().data.len(), 16 + ENTRY);
    assert_eq!(env.svm.get_account(&page(&env, 0, 1025)).unwrap().data.len(), 16 + 2 * ENTRY);
    assert_eq!(hex(&root_at(&env, 0, 1025)), b["state_roots"]["1025"].as_str().unwrap());
    assert_eq!(hex(&root_at(&env, 1, 1024)), b["label_roots"]["1024"].as_str().unwrap());

    // a release against roots on page 1 of both trees
    let r2 = rel_of(&env, &b["spends"][1]);
    assert_eq!((r2.state_root_index, r2.label_root_index), (1025, 1024));
    let mut x = r2.clone();
    x.state_root_page = Some(page(&env, 0, 0));
    assert_eq!(release(&mut env, &x).err(), Some(UNKNOWN_STATE_ROOT), "index 1,025 named on page 0");
    let w0 = lamports(&env, &env.w.pubkey());
    release(&mut env, &r2).expect("a release against page-1 roots lands");
    assert_eq!(lamports(&env, &env.w.pubkey()), w0 + r2.withdrawn - FEE);
    assert_eq!(state_size(&env), 1027);
}
