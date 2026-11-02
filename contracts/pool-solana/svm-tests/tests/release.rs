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

/// The 16 bytes deposit writes into its precommitment mark `["pre", precommitment]`: value u64 LE, then the deposit's
/// nonce u64 LE (the one its label hashes).
fn mark_data(env: &Env, pre: &[u8; 32]) -> Vec<u8> {
    let a = env.svm.get_account(&pda(&[b"pre", pre], &env.program)).expect("the precommitment mark");
    assert_eq!(a.owner, env.program, "the mark is the pool's");
    assert_eq!(a.lamports, env.svm.minimum_balance_for_rent_exemption(16), "the mark holds rent for 16 bytes");
    a.data
}

/// The 8 bytes a release writes into its spent mark `["spent", nullifierHash]`: withdrawnValue u64 LE (M355 (3)).
fn spent_data(env: &Env, nullifier: &[u8; 32]) -> Vec<u8> {
    let a = env.svm.get_account(&pda(&[b"spent", nullifier], &env.program)).expect("the spent mark");
    assert_eq!(a.owner, env.program, "the spent mark is the pool's");
    assert_eq!(a.lamports, env.svm.minimum_balance_for_rent_exemption(8), "the spent mark holds rent for 8 bytes");
    a.data
}

/// What a restore rebuilds from a spent mark alone: the release's withdrawnValue, the one the proof bound; and the
/// mark's bytes are the fixture spend's `spent_mark`.
fn assert_spent(env: &Env, r: &Rel, s: &Value) {
    let m = spent_data(env, &r.nullifier);
    assert_eq!(m.len(), 8, "the spent mark is 8 bytes");
    assert_eq!(u64::from_le_bytes(m[..].try_into().unwrap()), r.withdrawn, "withdrawnValue rebuilt from the spent mark");
    assert_eq!(hex(&m), s["spent_mark"].as_str().expect("the fixture's spent mark"), "the fixture's spent mark");
}

/// Leaf `index` of `tree`, read from its page.
fn leaf_at(env: &Env, tree: u8, index: u64) -> [u8; 32] {
    let a = env.svm.get_account(&page(env, tree, index)).expect("page");
    let at = 16 + (index % 1024) as usize * ENTRY;
    a.data[at..at + 32].try_into().unwrap()
}

/// `x mod p` for a 32-byte big-endian x (x < 2^256 < 6p).
fn mod_p(mut x: [u8; 32]) -> [u8; 32] {
    let p = h32(P_HEX);
    while x >= p {
        let mut borrow = 0i16;
        for i in (0..32).rev() {
            let d = x[i] as i16 - p[i] as i16 - borrow;
            borrow = (d < 0) as i16;
            x[i] = (d + 256 * borrow) as u8;
        }
    }
    x
}

/// What a restore rebuilds from a mark alone: `label = keccak256(scope ‖ nonce_be32) mod p` and `commitment =
/// Poseidon(value, label, precommitment)` (src/context.rs, src/deposit.rs).
fn rebuilt_from_mark(env: &Env, mark: &[u8], pre: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    use light_poseidon::{Poseidon, PoseidonBytesHasher};
    use sha3::{Digest as _, Keccak256};
    let (value, nonce) = (u64::from_le_bytes(mark[0..8].try_into().unwrap()), u64::from_le_bytes(mark[8..16].try_into().unwrap()));
    let mut n = [0u8; 32];
    n[24..].copy_from_slice(&nonce.to_be_bytes());
    let label = mod_p(Keccak256::new().chain_update(h32(env.f["scope"].as_str().unwrap())).chain_update(n).finalize().into());
    let mut v = [0u8; 32];
    v[24..].copy_from_slice(&value.to_be_bytes());
    let commitment = Poseidon::<ark_bn254::Fr>::new_circom(3).unwrap().hash_bytes_be(&[&v, &label, pre]).unwrap();
    (label, commitment)
}

/// Deposit `nonce`'s mark holds `value` and `nonce` exactly, and the label and commitment rebuilt from it are the
/// leaves at `label_index` and `state_index`.
fn assert_mark(env: &Env, value: u64, pre: &[u8; 32], nonce: u64, state_index: u64, label_index: u64) {
    let m = mark_data(env, pre);
    let mut want = value.to_le_bytes().to_vec();
    want.extend_from_slice(&nonce.to_le_bytes());
    assert_eq!(hex(&m), hex(&want), "deposit {nonce}: the mark is value ‖ nonce");
    let (label, commitment) = rebuilt_from_mark(env, &m, pre);
    assert_eq!(hex(&label), hex(&leaf_at(env, 1, label_index)), "deposit {nonce}: the label from the mark is the label leaf");
    assert_eq!(hex(&commitment), hex(&leaf_at(env, 0, state_index)), "deposit {nonce}: the commitment from the mark is the state leaf");
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
    rel_of(env, &spend_fx(env, name))
}

/// The fixture's spend `name`.
fn spend_fx(env: &Env, name: &str) -> Value {
    env.f["spends"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap().clone()
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

// M355 (3): the spent mark holds withdrawnValue, for tag 2 and tag 3 (the page boundary's two releases are checked in
// inserts_cross_the_page_boundary_in_both_trees).
#[test]
fn each_release_records_its_withdrawn_value_in_its_spent_mark() {
    let mut env = with_deposits();
    let r = rel(&env, "release");
    let meta = release(&mut env, &r).expect("release");
    println!("CU release {}", meta.compute_units_consumed);
    println!("RENT spent mark {}", lamports(&env, &pda(&[b"spent", &r.nullifier], &env.program)));
    assert_spent(&env, &r, &spend_fx(&env, "release"));
    // a second release in the same pool, another amount
    let r2 = rel(&env, "old_root");
    release(&mut env, &r2).expect("old_root");
    assert_spent(&env, &r2, &spend_fx(&env, "old_root"));
    assert_spent(&env, &r, &spend_fx(&env, "release"));
    // tag 3, the proof raw and compressed
    for compressed in [false, true] {
        let (mut env, tip_to, to) = with_buy_env();
        let mut b = buy_of(&env, tip_to, to);
        b.compressed = compressed;
        let meta = send_buy(&mut env, &b).expect("tag 3 lands");
        println!("CU tag3 transfer {} {}", if compressed { "compressed" } else { "raw" }, meta.compute_units_consumed);
        assert_spent(&env, &b.r, &spend_fx(&env, "release"));
    }
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
    // topped up to 16 bytes' rent and filled like any mark (mark_data checks the rent)
    assert_mark(&env, 1_000_000, &pre, 7, 7, 6);
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
    let d0 = lamports(&env, &env.depositor.pubkey());
    let meta = deposit(&mut env, 1_000_000, &pre, 6, 6).expect("a fresh precommitment lands");
    println!("CU deposit {}", meta.compute_units_consumed);
    println!("RENT deposit: mark {}, all rent {}", lamports(&env, &pda(&[b"pre", &pre], &env.program)), d0 - lamports(&env, &env.depositor.pubkey()) - 1_000_000 - 5_000);
}

/// M353: each deposit records value and nonce in its precommitment mark, so a restore from the 12 words rebuilds every
/// note from one read of all marks; the fixture's `mark` is the program's.
#[test]
fn each_deposit_records_its_value_and_nonce_in_its_mark() {
    let mut env = with_deposits();
    let deps = env.f["deposits"].as_array().unwrap().clone();
    for (i, d) in deps.iter().enumerate() {
        let (value, pre) = (d["value"].as_str().unwrap().parse::<u64>().unwrap(), h32(d["precommitment"].as_str().unwrap()));
        assert_mark(&env, value, &pre, i as u64 + 1, i as u64, i as u64);
        assert_eq!(hex(&mark_data(&env, &pre)), d["mark"].as_str().expect("the fixture's mark"), "deposit {i}: the fixture's mark");
    }
    // a deposit after a release: its state leaf is one past its label leaf, its nonce the next
    let r = rel(&env, "release");
    release(&mut env, &r).expect("release");
    let pre = h32(&format!("{:064x}", 77));
    let d0 = lamports(&env, &env.depositor.pubkey());
    let meta = deposit(&mut env, 3_000_000, &pre, 7, 6).expect("a deposit after a release");
    let mark_rent = lamports(&env, &pda(&[b"pre", &pre], &env.program));
    println!("CU deposit {}", meta.compute_units_consumed);
    println!("RENT deposit: precommitment mark {mark_rent}, depositor paid {} beyond the value and the fee", d0 - lamports(&env, &env.depositor.pubkey()) - 3_000_000 - 5_000);
    assert_mark(&env, 3_000_000, &pre, 7, 7, 6);
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
    assert_spent(&env, &r, &b["spends"][0]);
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
    // M353: every deposit's mark, across both pages of both trees (the 1,025th deposit's state leaf is 1,025, after
    // the release's change at 1,024)
    for (i, d) in deps.iter().enumerate() {
        let (v, pre) = dep(d);
        let i = i as u64;
        assert_mark(&env, v, &pre, i + 1, if i < 1024 { i } else { 1025 }, i);
        assert_eq!(hex(&mark_data(&env, &pre)), d["mark"].as_str().expect("the fixture's mark"), "deposit {i}: the fixture's mark");
    }

    // a release against roots on page 1 of both trees
    let r2 = rel_of(&env, &b["spends"][1]);
    assert_eq!((r2.state_root_index, r2.label_root_index), (1025, 1024));
    let mut x = r2.clone();
    x.state_root_page = Some(page(&env, 0, 0));
    assert_eq!(release(&mut env, &x).err(), Some(UNKNOWN_STATE_ROOT), "index 1,025 named on page 0");
    let w0 = lamports(&env, &env.w.pubkey());
    release(&mut env, &r2).expect("a release against page-1 roots lands");
    assert_eq!(lamports(&env, &env.w.pubkey()), w0 + r2.withdrawn - FEE);
    assert_spent(&env, &r2, &b["spends"][1]);
    assert_spent(&env, &r, &b["spends"][0]);
    assert_eq!(state_size(&env), 1027);
}

// Ported from the independent review of c53a7f9: three checks that had no test failing without them.

/// The pool account's size (src/state.rs POOL_LEN): header 49 bytes, then two trees of size, depth and 33 side nodes.
const POOL_LEN: usize = 49 + 2 * (8 + 1 + 33 * 32);

fn pool_u128(env: &Env, off: usize) -> u128 {
    let a = env.svm.get_account(&env.pool).unwrap();
    u128::from_le_bytes(a.data[off..off + 16].try_into().unwrap())
}

/// The change note's page when it is not a page's first entry: the label tree's page, or the state tree's next page,
/// in its place is refused, and the label page is untouched (else a relayer could write the change note into the
/// other tree's history).
#[test]
fn a_wrong_change_page_is_refused() {
    let mut env = with_deposits();
    let r = rel(&env, "release");
    let label0 = env.svm.get_account(&page(&env, 1, 0)).unwrap().data;
    let fp = env.fee_payer.insecure_clone();
    let w = env.w.insecure_clone();
    let payer = fp.pubkey();
    let mut ix = release_ix(&env, &r);
    ix.accounts[6] = AccountMeta::new(page(&env, 1, 0), false);
    assert_eq!(send(&mut env, &[compute_limit(400_000), ix], &payer, &[&fp, &w]).err(), Some(WRONG_ACCOUNT));
    assert_eq!(env.svm.get_account(&page(&env, 1, 0)).unwrap().data, label0, "the label page is untouched");
    let mut ix = release_ix(&env, &r);
    ix.accounts[6] = AccountMeta::new(page(&env, 0, 1024), false);
    assert_eq!(send(&mut env, &[compute_limit(400_000), ix], &payer, &[&fp, &w]).err(), Some(WRONG_ACCOUNT));
    release(&mut env, &r).expect("the right page lands");
}

/// Anyone can fund an address before the program makes its account there, with at least the rent-exempt minimum of
/// 0 bytes. The pool's address and each tree's first page funded so: init and the first deposit land, each account
/// topped up to exactly its own size's minimum.
#[test]
fn a_funded_pool_or_page_address_blocks_nothing() {
    let f = fx();
    let program = key_of(&f["program"]);
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(program, so_path()).unwrap();
    let min0 = svm.minimum_balance_for_rent_exemption(0);
    let pool = key_of(&f["pool"]);
    let p0 = pda(&[b"page", &[0], &0u32.to_le_bytes()], &program);
    let p1 = pda(&[b"page", &[1], &0u32.to_le_bytes()], &program);
    for a in [pool, p0, p1] {
        svm.airdrop(&a, min0).unwrap();
    }
    let depositor = Keypair::new();
    svm.airdrop(&depositor.pubkey(), 10_000_000_000).unwrap();
    let (w, w2, fee_payer) = (test_key("W"), test_key("W2"), test_key("FEE_PAYER"));
    let mut env = Env { svm, program, pool, depositor, w, w2, fee_payer, f };
    let init = Instruction {
        program_id: program,
        accounts: vec![AccountMeta::new(pool, false), AccountMeta::new(env.depositor.pubkey(), true), AccountMeta::new_readonly(SYSTEM, false)],
        data: vec![0],
    };
    let d = env.depositor.insecure_clone();
    send(&mut env, &[init], &d.pubkey(), &[&d]).expect("init on a funded address");
    assert_eq!(lamports(&env, &pool), env.svm.minimum_balance_for_rent_exemption(POOL_LEN));
    let pre = h32(&format!("{:064x}", 4244));
    deposit(&mut env, 1_000_000, &pre, 0, 0).expect("the first deposit on funded page addresses");
    for a in [p0, p1] {
        let acc = env.svm.get_account(&a).unwrap();
        assert_eq!((acc.owner, acc.data.len(), acc.lamports), (program, 16 + ENTRY, env.svm.minimum_balance_for_rent_exemption(16 + ENTRY)));
    }
}

/// Row 13's books: `spent` grows by withdrawnValue, and the pool holds exactly its rent plus what the notes hold.
#[test]
fn a_release_counts_what_it_spends() {
    let mut env = with_deposits();
    let deposited: u128 =
        env.f["deposits"].as_array().unwrap().iter().map(|d| d["value"].as_str().unwrap().parse::<u128>().unwrap()).sum();
    assert_eq!((pool_u128(&env, 17), pool_u128(&env, 33)), (deposited, 0));
    let r = rel(&env, "release");
    release(&mut env, &r).expect("release");
    assert_eq!((pool_u128(&env, 17), pool_u128(&env, 33)), (deposited, r.withdrawn as u128));
    let rent = env.svm.minimum_balance_for_rent_exemption(POOL_LEN) as u128;
    assert_eq!(lamports(&env, &env.pool) as u128, rent + deposited - r.withdrawn as u128);
}

// ------------------------------------------------------------------------------------------------------------ tag 3
// Release-and-buy (src/buy.rs; layout TAG3.md). These run tag 3 with a system transfer from W, the hostile venue
// (svm-tests/evil-venue, EVIL_SO or ../out/evil_venue.so) or, in venue_*, copies of mainnet's pump and PumpSwap.

const NOT_ENOUGH_ACCOUNTS: u32 = u32::MAX - 1;
const INVALID_INSTRUCTION_DATA: u32 = 1;
const TIP_OVER_CAP: u32 = 27;
const INNER_INVOKES_POOL: u32 = 28;
const INNER_NAMES_POOL_ACCOUNT: u32 = 29;
const INNER_SIGNER_NOT_W: u32 = 30;
const TIP: u64 = 10_000;

/// A tag 3 release: `rel` plus the flags, the tip (to `tip_to` when above 0) and the inner instructions.
#[derive(Clone)]
struct Buy {
    r: Rel,
    compressed: bool,
    flags: u8,
    tip: u64,
    tip_to: Pubkey,
    inner: Vec<Instruction>,
    /// bytes appended after the last inner instruction
    trailing: Vec<u8>,
    /// the inner count byte, when not inner.len()
    count: Option<u8>,
}

fn compress(p: &[u8]) -> Vec<u8> {
    use solana_bn254::compression::prelude::{alt_bn128_g1_compress_be, alt_bn128_g2_compress_be};
    let mut c = alt_bn128_g1_compress_be(p[0..64].try_into().unwrap()).unwrap().to_vec();
    c.extend_from_slice(&alt_bn128_g2_compress_be(p[64..192].try_into().unwrap()).unwrap());
    c.extend_from_slice(&alt_bn128_g1_compress_be(p[192..256].try_into().unwrap()).unwrap());
    c
}

/// The tag 3 instruction, as the kit's `buildSolanaPoolBuyTag3` lays it out: tag 2's 8 accounts, the tip account when
/// the tip is above 0, then each inner account and program once, with the union of the flags asked.
fn buy_ix(env: &Env, b: &Buy) -> Instruction {
    let two = release_ix(env, &b.r);
    let mut outer = two.accounts.clone();
    if b.tip > 0 {
        outer.push(AccountMeta::new(b.tip_to, false));
    }
    let mut index_of = |m: AccountMeta| -> u8 {
        match outer.iter().position(|o| o.pubkey == m.pubkey) {
            Some(i) => {
                outer[i].is_signer |= m.is_signer;
                outer[i].is_writable |= m.is_writable;
                i as u8
            }
            None => {
                outer.push(m);
                (outer.len() - 1) as u8
            }
        }
    };
    let mut data = vec![3u8, if b.compressed { 1 } else { b.flags }];
    data.extend_from_slice(&if b.compressed { compress(&b.r.proof) } else { b.r.proof.clone() });
    data.extend_from_slice(&two.data[1 + 256..]);
    data.extend_from_slice(&b.tip.to_le_bytes());
    data.push(b.count.unwrap_or(b.inner.len() as u8));
    for x in &b.inner {
        let p = index_of(AccountMeta::new_readonly(x.program_id, false));
        let idx: Vec<u8> = x.accounts.iter().map(|a| index_of(a.clone())).collect();
        data.push(p);
        data.push(idx.len() as u8);
        data.extend_from_slice(&idx);
        data.extend_from_slice(&(x.data.len() as u16).to_le_bytes());
        data.extend_from_slice(&x.data);
    }
    data.extend_from_slice(&b.trailing);
    Instruction { program_id: env.program, accounts: outer, data }
}

fn transfer_ix(from: &Pubkey, to: &Pubkey, lamports: u64) -> Instruction {
    let mut data = 2u32.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction { program_id: SYSTEM, accounts: vec![AccountMeta::new(*from, true), AccountMeta::new(*to, false)], data }
}

fn evil_so() -> String {
    std::env::var("EVIL_SO").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../out/evil_venue.so").into())
}

/// The hostile venue's id.
fn evil() -> Pubkey {
    Pubkey::new_from_array(Sha256::digest(b"pool-sol-buy-sell/evil-venue").into())
}

/// `with_deposits()` plus a funded tip account (as Jito's are), a funded receiver for W's transfer and the hostile
/// venue.
fn with_buy_env() -> (Env, Pubkey, Pubkey) {
    let mut env = with_deposits();
    let (tip_to, to) = (Keypair::new().pubkey(), Keypair::new().pubkey());
    env.svm.airdrop(&tip_to, 1_000_000_000).unwrap();
    env.svm.airdrop(&to, 1_000_000_000).unwrap();
    env.svm.add_program_from_file(evil(), evil_so()).expect("the hostile venue .so (cargo-build-sbf in svm-tests/evil-venue, or EVIL_SO)");
    (env, tip_to, to)
}

/// The fixture's release as tag 3: a tip of TIP, then W sends 1,000,000 lamports to `to`.
fn buy_of(env: &Env, tip_to: Pubkey, to: Pubkey) -> Buy {
    Buy {
        r: rel(env, "release"),
        compressed: false,
        flags: 0,
        tip: TIP,
        tip_to,
        inner: vec![transfer_ix(&env.w.pubkey(), &to, 1_000_000)],
        trailing: vec![],
        count: None,
    }
}

/// Sends tag 3 signed by the fee payer (payer) and W; Err(code), NOT_ENOUGH_ACCOUNTS, or u32::MAX for another error.
fn send_buy(env: &mut Env, b: &Buy) -> Result<TransactionMetadata, u32> {
    send_buy_raw(env, b).map_err(|s| match s.find("Custom(") {
        Some(at) => s[at + 7..].split(')').next().unwrap().parse().unwrap(),
        None if s.contains("NotEnoughAccountKeys") => NOT_ENOUGH_ACCOUNTS,
        None => u32::MAX,
    })
}

/// As `send_buy`, the error as the runtime words it.
fn send_buy_raw(env: &mut Env, b: &Buy) -> Result<TransactionMetadata, String> {
    let ixs = [compute_limit(400_000), buy_ix(env, b)];
    let (fp, w) = (env.fee_payer.insecure_clone(), env.w.insecure_clone());
    env.svm.expire_blockhash();
    let tx = Transaction::new(&[&fp, &w], Message::new(&ixs, Some(&fp.pubkey())), env.svm.latest_blockhash());
    env.svm.send_transaction(tx).map_err(|e: FailedTransactionMetadata| {
        if std::env::var("POOL_LOGS").is_ok() {
            eprintln!("{:?}\n{:#?}", e.err, e.meta.logs);
        }
        format!("{:?} {:?}", e.err, e.meta.logs)
    })
}

#[test]
fn release_and_buy_pays_w_the_fee_payer_and_the_tip_then_runs_ws_instruction() {
    for compressed in [false, true] {
        let (mut env, tip_to, to) = with_buy_env();
        let mut b = buy_of(&env, tip_to, to);
        b.compressed = compressed;
        let (pool0, f0, t0, to0) = (lamports(&env, &env.pool), lamports(&env, &env.fee_payer.pubkey()), lamports(&env, &tip_to), lamports(&env, &to));
        let meta = send_buy(&mut env, &b).expect("tag 3 lands");
        let kind = if compressed { "compressed" } else { "raw" };
        println!("CU tag3 transfer {kind} {}", meta.compute_units_consumed);
        println!("BYTES tag3 transfer {kind} {}", tx_bytes(&[compute_limit(400_000), buy_ix(&env, &b)], &env.fee_payer.pubkey(), 2));
        assert_eq!(lamports(&env, &env.pool), pool0 - b.r.withdrawn, "the pool pays withdrawnValue");
        assert_eq!(lamports(&env, &tip_to), t0 + TIP, "the tip account gets the tip");
        assert_eq!(lamports(&env, &to), to0 + 1_000_000, "W's own instruction ran with W's signature");
        assert_eq!(lamports(&env, &env.w.pubkey()), b.r.withdrawn - FEE - TIP - 1_000_000, "W keeps the rest");
        let mark_rent = lamports(&env, &pda(&[b"spent", &b.r.nullifier], &env.program));
        let entry_rent = env.svm.minimum_balance_for_rent_exemption(16 + 7 * ENTRY) - env.svm.minimum_balance_for_rent_exemption(16 + 6 * ENTRY);
        assert_eq!(lamports(&env, &env.fee_payer.pubkey()), f0 + FEE - mark_rent - entry_rent - 10_000, "the fee payer's balance");
        assert_eq!(state_size(&env), 7, "the change note is in");
        assert_eq!(pool_u128(&env, 33), b.r.withdrawn as u128, "spent");
        // tag 3 is the same spend as tag 2: the note is now spent for both
        assert_eq!(send_buy(&mut env, &b).err(), Some(NULLIFIER_ALREADY_SPENT));
        let r = rel(&env, "release");
        assert_eq!(release(&mut env, &r).err(), Some(NULLIFIER_ALREADY_SPENT));
    }
}

#[test]
fn tag3_runs_every_tag2_check() {
    let (mut env, tip_to, to) = with_buy_env();
    let b = buy_of(&env, tip_to, to);
    let mut x = b.clone();
    x.r.withdrawn += 1;
    assert_eq!(send_buy(&mut env, &x).err(), Some(INVALID_PROOF), "a changed public signal");
    let mut x = b.clone();
    x.r.tip_cap += 1;
    assert_eq!(send_buy(&mut env, &x).err(), Some(INVALID_PROOF), "another tip cap than the proof's");
    let mut x = b.clone();
    x.r.relay_fee = x.r.relay_fee_cap + 1;
    assert_eq!(send_buy(&mut env, &x).err(), Some(RELAY_FEE_OVER_CAP));
    let mut x = b.clone();
    x.compressed = true;
    x.r.withdrawn += 1;
    assert_eq!(send_buy(&mut env, &x).err(), Some(INVALID_PROOF), "a changed public signal, compressed proof");
    // tag 2 first, then the same note by tag 3
    let r = rel(&env, "release");
    release(&mut env, &r).expect("tag 2");
    assert_eq!(send_buy(&mut env, &b).err(), Some(NULLIFIER_ALREADY_SPENT));
}

#[test]
fn a_tip_over_the_tip_cap_is_refused() {
    let (mut env, tip_to, to) = with_buy_env();
    let mut b = buy_of(&env, tip_to, to);
    b.tip = b.r.tip_cap + 1;
    assert_eq!(send_buy(&mut env, &b).err(), Some(TIP_OVER_CAP));
    b.tip = b.r.tip_cap;
    send_buy(&mut env, &b).expect("a tip at the cap lands");
    assert_eq!(lamports(&env, &tip_to), 1_000_000_000 + b.r.tip_cap);
}

#[test]
fn a_fee_and_tip_over_the_chunk_is_refused() {
    let (mut env, tip_to, to) = with_buy_env();
    let mut b = buy_of(&env, tip_to, to);
    // within the fee cap, the backstop (half) and the tip cap, but together over withdrawnValue; refused at row 8,
    // before the proof (which is for another withdrawnValue)
    b.r.withdrawn = 1_000_000;
    b.r.relay_fee = 500_000;
    b.tip = 600_000;
    assert_eq!(send_buy(&mut env, &b).err(), Some(INVALID_WITHDRAWAL_AMOUNT));
    b.tip = 500_000;
    assert_eq!(send_buy(&mut env, &b).err(), Some(INVALID_PROOF), "at exactly withdrawnValue it reaches the proof");
}

#[test]
fn a_tip_with_no_tip_account_is_refused() {
    let (mut env, tip_to, to) = with_buy_env();
    let mut b = buy_of(&env, tip_to, to);
    b.inner = vec![];
    b.count = Some(0);
    b.tip = TIP;
    // no tip account and no inner account: only tag 2's eight
    let mut ix = buy_ix(&env, &b);
    ix.accounts.truncate(8);
    let (fp, w) = (env.fee_payer.insecure_clone(), env.w.insecure_clone());
    let tx = Transaction::new(&[&fp, &w], Message::new(&[compute_limit(400_000), ix], Some(&fp.pubkey())), env.svm.latest_blockhash());
    let e = format!("{:?}", env.svm.send_transaction(tx).err().unwrap().err);
    assert!(e.contains("NotEnoughAccountKeys"), "{e}");
}

#[test]
fn the_pool_never_calls_itself() {
    let (mut env, tip_to, to) = with_buy_env();
    let mut b = buy_of(&env, tip_to, to);
    b.inner.push(Instruction { program_id: env.program, accounts: vec![], data: vec![0] });
    assert_eq!(send_buy(&mut env, &b).err(), Some(INNER_INVOKES_POOL));
}

#[test]
fn a_venue_that_reenters_the_pool_is_refused_by_the_runtime() {
    let (mut env, tip_to, to) = with_buy_env();
    let mut b = buy_of(&env, tip_to, to);
    // the hostile venue calls the pool's deposit with W as the depositor
    let pre = [7u8; 32];
    let dep = deposit_ix(&env, 1_000_000, &pre, 7, 6);
    let mut accounts = vec![AccountMeta::new_readonly(env.program, false)];
    accounts.extend(dep.accounts.iter().cloned().map(|mut a| {
        if a.pubkey == env.depositor.pubkey() {
            a.pubkey = env.w.pubkey();
        }
        a
    }));
    // the pool and the pages are refused by name first: the venue gets only W, the precommitment mark and system
    let named: Vec<AccountMeta> = accounts.iter().filter(|a| a.pubkey != env.pool && env.svm.get_account(&a.pubkey).map(|x| x.owner != env.program).unwrap_or(true)).cloned().collect();
    let mut data = vec![0u8];
    data.extend_from_slice(&dep.data);
    b.inner = vec![Instruction { program_id: evil(), accounts: named, data }];
    let e = send_buy_raw(&mut env, &b).err().expect("refused");
    assert!(e.contains("ReentrancyNotAllowed"), "{e}");
    // and naming the pool for it is refused by the pool itself
    b.inner = vec![Instruction { program_id: evil(), accounts, data: vec![0] }];
    assert_eq!(send_buy(&mut env, &b).err(), Some(INNER_NAMES_POOL_ACCOUNT));
}

#[test]
fn an_inner_instruction_naming_a_pool_account_is_refused() {
    let (mut env, tip_to, to) = with_buy_env();
    let b = buy_of(&env, tip_to, to);
    let two = release_ix(&env, &b.r);
    // the hostile venue taking 1 lamport from each of the pool, the spent mark and the three pages
    for i in [0usize, 3, 4, 5, 6] {
        let mut x = b.clone();
        x.inner = vec![Instruction { program_id: evil(), accounts: vec![AccountMeta::new(two.accounts[i].pubkey, false), AccountMeta::new(to, false)], data: vec![1] }];
        assert_eq!(send_buy(&mut env, &x).err(), Some(INNER_NAMES_POOL_ACCOUNT), "account {i}");
    }
    // the tip to the pool
    let mut x = b.clone();
    x.tip_to = env.pool;
    assert_eq!(send_buy(&mut env, &x).err(), Some(INNER_NAMES_POOL_ACCOUNT), "the tip to the pool");
    // an account the pool owns that this release does not name: another note's spent mark
    let mut first = b.clone();
    first.r = rel(&env, "old_root");
    first.inner = vec![Instruction { program_id: evil(), accounts: vec![], data: vec![2] }];
    send_buy(&mut env, &first).expect("another release lands");
    let other_mark = pda(&[b"spent", &first.r.nullifier], &env.program);
    let mut x = b.clone();
    x.inner = vec![Instruction { program_id: evil(), accounts: vec![AccountMeta::new(other_mark, false), AccountMeta::new(to, false)], data: vec![1] }];
    assert_eq!(send_buy(&mut env, &x).err(), Some(INNER_NAMES_POOL_ACCOUNT), "another spent mark");
    send_buy(&mut env, &b).expect("the release itself lands");
}

#[test]
fn an_inner_signer_other_than_w_is_refused() {
    let (mut env, tip_to, to) = with_buy_env();
    let mut b = buy_of(&env, tip_to, to);
    // the fee payer's signature to a callee: a transfer from the relayer
    b.inner = vec![transfer_ix(&env.fee_payer.pubkey(), &to, 1)];
    assert_eq!(send_buy(&mut env, &b).err(), Some(INNER_SIGNER_NOT_W));
}

#[test]
fn a_failing_inner_instruction_undoes_the_release() {
    let (mut env, tip_to, to) = with_buy_env();
    let mut b = buy_of(&env, tip_to, to);
    let pool0 = lamports(&env, &env.pool);
    b.inner = vec![transfer_ix(&env.w.pubkey(), &to, b.r.withdrawn)]; // more than W gets
    assert!(send_buy(&mut env, &b).is_err());
    assert_eq!(lamports(&env, &env.pool), pool0, "the pool keeps its lamports");
    assert!(env.svm.get_account(&pda(&[b"spent", &b.r.nullifier], &env.program)).map(|a| a.lamports == 0).unwrap_or(true), "no spent mark");
    let b = buy_of(&env, tip_to, to);
    send_buy(&mut env, &b).expect("the same note then lands");
}

#[test]
fn tag3_data_refusals() {
    let (mut env, tip_to, to) = with_buy_env();
    let b = buy_of(&env, tip_to, to);
    let mut x = b.clone();
    x.flags = 2;
    assert_eq!(send_buy(&mut env, &x).err(), Some(INVALID_INSTRUCTION_DATA), "an unknown flag");
    let mut x = b.clone();
    x.inner = vec![];
    assert_eq!(send_buy(&mut env, &x).err(), Some(INVALID_INSTRUCTION_DATA), "no inner instruction");
    let mut x = b.clone();
    x.inner = vec![Instruction { program_id: evil(), accounts: vec![], data: vec![2] }; 9];
    assert_eq!(send_buy(&mut env, &x).err(), Some(INVALID_INSTRUCTION_DATA), "nine");
    let mut x = b.clone();
    x.trailing = vec![0];
    assert_eq!(send_buy(&mut env, &x).err(), Some(INVALID_INSTRUCTION_DATA), "a byte after the last");
    let mut x = b.clone();
    x.count = Some(2); // says two, holds one: the second's program index reads past the data
    assert_eq!(send_buy(&mut env, &x).err(), Some(INVALID_INSTRUCTION_DATA), "short");
    // an index past the accounts: the transfer's `to` pointed one past the last
    let mut ix = buy_ix(&env, &b);
    let n = ix.accounts.len() as u8;
    let last = ix.data.len() - 12 - 2; // the transfer: ... n=2 ‖ from ‖ to ‖ len u16 ‖ 12 data bytes
    ix.data[last - 1] = n;
    let (fp, w) = (env.fee_payer.insecure_clone(), env.w.insecure_clone());
    env.svm.expire_blockhash();
    let tx = Transaction::new(&[&fp, &w], Message::new(&[compute_limit(400_000), ix], Some(&fp.pubkey())), env.svm.latest_blockhash());
    let e = format!("{:?}", env.svm.send_transaction(tx).err().unwrap().err);
    assert!(e.contains("Custom(1)"), "an index past the accounts: {e}");
    let mut x = b.clone();
    x.inner = vec![Instruction { program_id: evil(), accounts: vec![], data: vec![2] }; 8];
    send_buy(&mut env, &x).expect("eight inner instructions land");
}

// ---------------------------------------------------------------------------------------- tag 3 on mainnet copies
// ../fixtures/venues/{pump,pumpswap}.json: a pump.fun curve and a PumpSwap pool read on two RPCs, with the steps W
// runs (the kit's solanaPoolBuySteps) and a sell; their programs' code is in ../fixtures/venues/programs/, fetched by
// `node fixtures/venues/dump.mjs --programs-only` (sha256-checked against the JSON; not committed: closed-source code).


fn b64(s: &str) -> Vec<u8> {
    let val = |c: u8| -> u32 {
        match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a' + 26) as u32,
            b'0'..=b'9' => (c - b'0' + 52) as u32,
            b'+' => 62,
            b'/' => 63,
            _ => panic!("base64"),
        }
    };
    let s = s.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for ch in s.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in ch.iter().enumerate() {
            n |= val(c) << (18 - 6 * i);
        }
        out.extend_from_slice(&n.to_be_bytes()[1..ch.len()]);
    }
    out
}

fn addr(v: &Value) -> Pubkey {
    v.as_str().unwrap().parse().unwrap()
}

fn steps(v: &Value) -> Vec<Instruction> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| Instruction {
            program_id: addr(&s["program"]),
            accounts: s["accounts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| AccountMeta { pubkey: addr(&a["address"]), is_signer: a["signer"].as_bool().unwrap(), is_writable: a["writable"].as_bool().unwrap() })
                .collect(),
            data: unhex(s["data"].as_str().unwrap()),
        })
        .collect()
}

/// The venue's JSON, its accounts and programs set in `env`, and the clock at its read.
fn load_venue(env: &mut Env, name: &str) -> Value {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/venues/");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(format!("{dir}{name}.json")).unwrap()).unwrap();
    assert_eq!(addr(&v["wallet"]), env.w.pubkey(), "the venue's W is the pool fixture's");
    for a in v["accounts"].as_array().unwrap() {
        let data = b64(a["data"].as_str().unwrap());
        env.svm
            .set_account(
                addr(&a["address"]),
                solana_account::Account { lamports: a["lamports"].as_str().unwrap().parse().unwrap(), data, owner: addr(&a["owner"]), executable: false, rent_epoch: 0 },
            )
            .unwrap();
    }
    for p in v["programs"].as_array().unwrap() {
        let file = format!("{dir}{}", p["file"].as_str().unwrap());
        let elf = std::fs::read(&file).unwrap_or_else(|_| panic!("{file}: run `node fixtures/venues/dump.mjs --programs-only` in contracts/pool-solana"));
        let sha: [u8; 32] = Sha256::digest(&elf).into();
        assert_eq!(hex(&sha), p["sha256"].as_str().unwrap(), "{file} is the code the JSON was read with");
        env.svm.add_program(addr(&p["address"]), &elf).unwrap();
    }
    set_time(env, v["unix_timestamp"].as_str().unwrap().parse().unwrap());
    v
}

fn token_amount(env: &Env, ata: &Pubkey) -> u64 {
    env.svm.get_account(ata).map(|a| u64::from_le_bytes(a.data[64..72].try_into().unwrap())).unwrap_or(0)
}

/// Bytes of the signed v0 transaction (2 signatures) with one lookup table holding every key of `ixs` but `stat`
/// (the per-token and per-spend accounts, which no table can hold at the tap) and the signers.
fn v0_bytes(ixs: &[Instruction], payer: &Pubkey, stat: &[Pubkey]) -> usize {
    use solana_message::v0;
    let mut table: Vec<Pubkey> = vec![];
    for ix in ixs.iter().skip(2) {
        for k in std::iter::once(ix.program_id).chain(ix.accounts.iter().filter(|a| !a.is_signer).map(|a| a.pubkey)) {
            if !stat.contains(&k) && !table.contains(&k) && k != ixs[2].program_id {
                table.push(k);
            }
        }
    }
    let lut = solana_message::AddressLookupTableAccount { key: Pubkey::new_from_array([9; 32]), addresses: table };
    let m = v0::Message::try_compile(payer, ixs, &[lut], solana_message::Hash::default()).unwrap();
    let cu = |n: usize| if n < 128 { 1 } else { 2 };
    let mut n = 1 + 64 * 2 + 1 + 3 + cu(m.account_keys.len()) + 32 * m.account_keys.len() + 32 + cu(m.instructions.len());
    for i in &m.instructions {
        n += 1 + cu(i.accounts.len()) + i.accounts.len() + cu(i.data.len()) + i.data.len();
    }
    n += cu(m.address_table_lookups.len());
    for l in &m.address_table_lookups {
        n += 32 + cu(l.writable_indexes.len()) + l.writable_indexes.len() + cu(l.readonly_indexes.len()) + l.readonly_indexes.len();
    }
    n
}

/// Tag 3 on `name`'s venue: W's chunk pays for the buy, W ends holding at least min_out of the token. Returns W's token
/// account for the sell.
fn release_and_buy_on(env: &mut Env, name: &str, compressed: bool, ata_at: usize, stat_at: &[usize]) -> (Value, Pubkey) {
    let v = load_venue(env, name);
    let inner = steps(&v["buy"]);
    let buy = inner.iter().find(|s| v["programs"].as_array().unwrap().iter().any(|p| addr(&p["address"]) == s.program_id)).unwrap().clone();
    let ata = buy.accounts[ata_at].pubkey;
    let tip_to = Keypair::new().pubkey();
    env.svm.airdrop(&tip_to, 1_000_000_000).unwrap();
    let b = Buy { r: rel(env, "release"), compressed, flags: 0, tip: TIP, tip_to, inner, trailing: vec![], count: None };
    let pool0 = lamports(env, &env.pool);
    let meta = send_buy(env, &b).unwrap_or_else(|e| panic!("{name}: release-and-buy lands (error {e}; POOL_LOGS=1 for the logs)"));
    let got = token_amount(env, &ata);
    let min_out: u64 = v["min_out"].as_str().unwrap().parse().unwrap();
    assert!(got >= min_out && got > 0, "{name}: W holds {got}, min out {min_out}");
    assert_eq!(lamports(env, &env.pool), pool0 - b.r.withdrawn, "{name}: the pool paid withdrawnValue only");
    assert_eq!(lamports(env, &tip_to), 1_000_000_000 + TIP);
    let kind = if compressed { "compressed" } else { "raw" };
    let pool_cu: Vec<&String> = meta.logs.iter().filter(|l| l.starts_with(&format!("Program {} consumed", env.program))).collect();
    println!("CU tag3 {name} {kind} total {} ({pool_cu:?})", meta.compute_units_consumed);
    let ix = buy_ix(env, &b);
    let mut stat: Vec<Pubkey> = stat_at.iter().map(|&i| buy.accounts[i].pubkey).collect();
    stat.push(pda(&[b"spent", &b.r.nullifier], &env.program));
    let ixs = [compute_limit(400_000), Instruction { program_id: "ComputeBudget111111111111111111111111111111".parse().unwrap(), accounts: vec![], data: [vec![3u8], 100_000u64.to_le_bytes().to_vec()].concat() }, ix];
    println!("BYTES tag3 {name} {kind} v0 {} (W holds {got}, min out {min_out})", v0_bytes(&ixs, &env.fee_payer.pubkey(), &stat));
    (v, ata)
}

/// pump buy's per-token and per-spend accounts: mint, curve, its token account, W's, W, creator vault, W's volume
/// accumulator, bonding-curve-v2.
const PUMP_STATIC: [usize; 8] = [2, 3, 4, 5, 6, 9, 13, 16];
/// PumpSwap buy's: pool, W, mint, W's two token accounts, the two vaults, the creator vault's wSOL account and
/// authority, W's volume accumulator, pool-v2.
const PUMPSWAP_STATIC: [usize; 11] = [0, 1, 3, 5, 6, 7, 8, 17, 18, 20, 23];

#[test]
fn venue_pump_release_and_buy_then_sell_and_deposit() {
    for compressed in [false, true] {
        let mut env = with_deposits();
        let (v, ata) = release_and_buy_on(&mut env, "pump", compressed, 5, &PUMP_STATIC);
        if compressed {
            continue;
        }
        // the sell: W sells on pump, then deposits a rung of the proceeds into the pool (tag 1, W the depositor), one
        // transaction W signs and pays
        let held = token_amount(&env, &ata);
        let size0 = state_size(&env);
        let (pool0, deposited0) = (lamports(&env, &env.pool), pool_u128(&env, 17));
        let pre = [0x0e; 32]; // below p
        let mut dep = deposit_ix(&env, 1_000_000, &pre, size0, 6);
        dep.accounts[1] = AccountMeta::new(env.w.pubkey(), true);
        let mut ixs = vec![compute_limit(400_000)];
        ixs.extend(steps(&v["sell"]));
        ixs.push(dep);
        let w = env.w.insecure_clone();
        let meta = send(&mut env, &ixs, &w.pubkey(), &[&w]).expect("the sell and its deposit land");
        println!("CU sell pump + deposit {}", meta.compute_units_consumed);
        println!("BYTES sell pump + deposit legacy {}", tx_bytes(&ixs, &w.pubkey(), 1));
        let sold: u64 = v["min_out"].as_str().unwrap().parse().unwrap();
        assert_eq!(token_amount(&env, &ata), held - sold, "W sold min_out");
        assert_eq!(state_size(&env), size0 + 1, "the state tree gained the deposit");
        assert_eq!(pool_u128(&env, 17), deposited0 + 1_000_000);
        assert_eq!(lamports(&env, &env.pool), pool0 + 1_000_000);
    }
}

#[test]
fn venue_pumpswap_release_and_buy() {
    for compressed in [false, true] {
        let mut env = with_deposits();
        release_and_buy_on(&mut env, "pumpswap", compressed, 5, &PUMPSWAP_STATIC);
    }
}

// ------------------------------------------------------------------------------------- tag 3: the review's cases
// From the independent review of f1081f7: a pool account named twice, a tip to an account the pool owns, a
// compressed point off its curve, tag 3 with no tip, and what a venue or a copied precommitment can and cannot do.

/// Tag 2's field bytes after the proof (src/release.rs FIELDS_LEN).
const FIELDS_LEN: usize = 130;

/// buy_ix with no inner instruction, then `extra` accounts appended, then raw inner instructions
/// (program index, account indexes, data).
fn buy_ix_raw(env: &Env, b: &Buy, extra: &[AccountMeta], inner: &[(u8, Vec<u8>, Vec<u8>)]) -> Instruction {
    let mut ix = buy_ix(env, &Buy { inner: vec![], count: Some(0), trailing: vec![], ..b.clone() });
    ix.accounts.extend_from_slice(extra);
    let tip_at = 2 + if b.compressed { 128 } else { 256 } + FIELDS_LEN;
    ix.data.truncate(tip_at + 8);
    ix.data.push(inner.len() as u8);
    for (p, idx, d) in inner {
        ix.data.push(*p);
        ix.data.push(idx.len() as u8);
        ix.data.extend_from_slice(idx);
        ix.data.extend_from_slice(&(d.len() as u16).to_le_bytes());
        ix.data.extend_from_slice(d);
    }
    ix
}

fn send_ix(env: &mut Env, ix: Instruction) -> Result<TransactionMetadata, String> {
    let (fp, w) = (env.fee_payer.insecure_clone(), env.w.insecure_clone());
    env.svm.expire_blockhash();
    let tx = Transaction::new(&[&fp, &w], Message::new(&[compute_limit(400_000), ix], Some(&fp.pubkey())), env.svm.latest_blockhash());
    env.svm.send_transaction(tx).map_err(|e: FailedTransactionMetadata| format!("{:?} {:?}", e.err, e.meta.logs))
}

fn code_of(e: &str) -> Option<u32> {
    e.find("Custom(").map(|at| e[at + 7..].split(')').next().unwrap().parse().unwrap())
}

/// a pool account named at a second index of this instruction (the same key twice) is refused by key, not by index.
#[test]
fn a_pool_account_named_again_at_another_index_is_refused() {
    let (mut env, tip_to, to) = with_buy_env();
    let b = buy_of(&env, tip_to, to);
    let two = release_ix(&env, &b.r);
    for i in [0usize, 3, 4, 5, 6] {
        // 0-7 tag 2, 8 the tip account, 9 the hostile venue, 10 `to`, 11 account i again
        let extra = [AccountMeta::new_readonly(evil(), false), AccountMeta::new(to, false), AccountMeta::new(two.accounts[i].pubkey, false)];
        let ix = buy_ix_raw(&env, &b, &extra, &[(9, vec![11, 10], vec![1])]);
        let e = send_ix(&mut env, ix).err().expect("refused");
        assert_eq!(code_of(&e), Some(INNER_NAMES_POOL_ACCOUNT), "account {i} at index 11: {e}");
    }
    send_buy(&mut env, &b).expect("the release itself lands");
}

/// even handed a pool account, a venue cannot move its lamports (the runtime's owner rule, under the pool's check).
#[test]
fn a_venue_given_a_pool_account_moves_nothing() {
    let (mut env, tip_to, to) = with_buy_env();
    let b = buy_of(&env, tip_to, to);
    let two = release_ix(&env, &b.r);
    for i in [0usize, 3, 6] {
        let pool0 = lamports(&env, &env.pool);
        let to0 = lamports(&env, &to);
        let mut x = b.clone();
        x.inner = vec![Instruction { program_id: evil(), accounts: vec![AccountMeta::new(two.accounts[i].pubkey, false), AccountMeta::new(to, false)], data: vec![1] }];
        let e = send_buy_raw(&mut env, &x).err().expect("refused");
        println!("REFUSED venue given account {i}: {}", e.split(" [").next().unwrap());
        assert_eq!((lamports(&env, &env.pool), lamports(&env, &to)), (pool0, to0), "account {i}");
    }
}

/// a tip to an account the pool owns but this release does not name (another note's spent mark, a deposit's
/// precommitment mark) is refused.
#[test]
fn a_tip_to_an_account_the_pool_owns_is_refused() {
    let (mut env, tip_to, to) = with_buy_env();
    let mut first = buy_of(&env, tip_to, to);
    first.r = rel(&env, "old_root");
    send_buy(&mut env, &first).expect("another release lands");
    let other_mark = pda(&[b"spent", &first.r.nullifier], &env.program);
    let pre0 = h32(env.f["deposits"][0]["precommitment"].as_str().unwrap());
    let pre_mark = pda(&[b"pre", &pre0], &env.program);
    for (what, k) in [("another spent mark", other_mark), ("a precommitment mark", pre_mark)] {
        let mut b = buy_of(&env, tip_to, to);
        b.tip_to = k;
        assert_eq!(send_buy(&mut env, &b).err(), Some(INNER_NAMES_POOL_ACCOUNT), "{what}");
    }
}

/// a tip to W or to the fee payer (the same key at index 8) pays each exactly.
#[test]
fn a_tip_to_w_or_the_fee_payer_pays_each_exactly() {
    for who in ["W", "fee payer"] {
        let (mut env, _tip_to, to) = with_buy_env();
        let mut b = buy_of(&env, Pubkey::new_from_array([0; 32]), to);
        b.tip_to = if who == "W" { env.w.pubkey() } else { env.fee_payer.pubkey() };
        let (pool0, f0) = (lamports(&env, &env.pool), lamports(&env, &env.fee_payer.pubkey()));
        send_buy(&mut env, &b).unwrap_or_else(|e| panic!("{who}: {e}"));
        let mark_rent = lamports(&env, &pda(&[b"spent", &b.r.nullifier], &env.program));
        let entry_rent = env.svm.minimum_balance_for_rent_exemption(16 + 7 * ENTRY) - env.svm.minimum_balance_for_rent_exemption(16 + 6 * ENTRY);
        let (w_tip, f_tip) = if who == "W" { (TIP, 0) } else { (0, TIP) };
        assert_eq!(lamports(&env, &env.pool), pool0 - b.r.withdrawn, "{who}: pool");
        assert_eq!(lamports(&env, &env.w.pubkey()), b.r.withdrawn - FEE - TIP + w_tip - 1_000_000, "{who}: W");
        assert_eq!(lamports(&env, &env.fee_payer.pubkey()), f0 + FEE + f_tip - mark_rent - entry_rent - 10_000, "{who}: fee payer");
    }
}

/// a tip that leaves a fresh tip account under rent fails the whole transaction; the pool keeps its lamports.
#[test]
fn a_tip_leaving_its_account_under_rent_fails_the_whole_transaction() {
    let (mut env, _tip_to, to) = with_buy_env();
    let b = buy_of(&env, Keypair::new().pubkey(), to);
    let pool0 = lamports(&env, &env.pool);
    let e = send_buy_raw(&mut env, &b).err().expect("refused");
    println!("REFUSED tip under rent: {}", e.split(" [").next().unwrap());
    assert!(e.contains("InsufficientFundsForRent"), "{e}");
    assert_eq!(lamports(&env, &env.pool), pool0);
    assert!(env.svm.get_account(&pda(&[b"spent", &b.r.nullifier], &env.program)).map(|a| a.lamports == 0).unwrap_or(true));
}

/// the fee payer named in an inner instruction never signs for it, and nothing moves.
#[test]
fn the_fee_payer_never_signs_for_an_inner_instruction() {
    let (mut env, tip_to, to) = with_buy_env();
    let mut b = buy_of(&env, tip_to, to);
    let to0 = lamports(&env, &to);
    b.inner = vec![transfer_ix(&env.fee_payer.pubkey(), &to, 1)];
    let e = send_buy_raw(&mut env, &b).err().expect("refused");
    println!("REFUSED fee payer in an inner transfer: {}", e.split(" [").next().unwrap());
    assert_eq!(lamports(&env, &to), to0);
    // the same through the hostile venue re-invoking the system program with the accounts it was given
    let mut data = vec![0u8];
    let mut t = 2u32.to_le_bytes().to_vec();
    t.extend_from_slice(&1u64.to_le_bytes());
    data.extend_from_slice(&t);
    b.inner = vec![Instruction {
        program_id: evil(),
        accounts: vec![AccountMeta::new_readonly(SYSTEM, false), AccountMeta::new(env.fee_payer.pubkey(), false), AccountMeta::new(to, false)],
        data,
    }];
    let e = send_buy_raw(&mut env, &b).err().expect("refused");
    println!("REFUSED fee payer via the venue: {}", e.split(" [").next().unwrap());
    assert_eq!(lamports(&env, &to), to0);
}

/// compressed points not on their curve, or x not below q, are refused with InvalidProofEncoding; a G2 point on
/// its curve but outside the subgroup is refused by the pairing (InvalidProof).
#[test]
fn a_compressed_point_off_its_curve_is_refused() {
    use solana_bn254::compression::prelude::{alt_bn128_g1_decompress_be, alt_bn128_g2_decompress_be};
    let (mut env, tip_to, to) = with_buy_env();
    let mut b = buy_of(&env, tip_to, to);
    b.compressed = true;
    let g1_off = (2u8..=255).map(|v| { let mut x = [0u8; 32]; x[31] = v; x }).find(|x| alt_bn128_g1_decompress_be(&x[..]).is_err()).unwrap();
    let q: [u8; 32] = h32("30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47");
    assert!(alt_bn128_g1_decompress_be(&q[..]).is_err(), "x = q is not canonical");
    let mut both_flags = [0u8; 32];
    both_flags[0] = 0xc0;
    both_flags[31] = 1;
    let g2_off = (1u8..=255).map(|v| { let mut x = [0u8; 64]; x[63] = v; x }).find(|x| alt_bn128_g2_decompress_be(&x[..]).is_err()).unwrap();
    let g2_on = (1u8..=255).map(|v| { let mut x = [0u8; 64]; x[63] = v; x }).find(|x| alt_bn128_g2_decompress_be(&x[..]).is_ok()).unwrap();
    // compressed proof at data[2..130]: A [2..34], B [34..98], C [98..130]
    let cases: Vec<(&str, usize, Vec<u8>, u32)> = vec![
        ("A off its curve", 2, g1_off.to_vec(), 3),
        ("A with x = q", 2, q.to_vec(), 3),
        ("A with both flag bits", 2, both_flags.to_vec(), 3),
        ("C off its curve", 98, g1_off.to_vec(), 3),
        ("B off its curve", 34, g2_off.to_vec(), 3),
        ("B on its curve, outside the subgroup", 34, g2_on.to_vec(), 15),
    ];
    for (what, at, bytes, want) in cases {
        let mut ix = buy_ix(&env, &b);
        ix.data[at..at + bytes.len()].copy_from_slice(&bytes);
        let e = send_ix(&mut env, ix).err().expect("refused");
        println!("REFUSED compressed {what}: {}", e.split(" [").next().unwrap());
        if want == 15 {
            assert!(matches!(code_of(&e), Some(3) | Some(15)), "{what}: {}", e.split(" [").next().unwrap());
        } else {
            assert_eq!(code_of(&e), Some(want), "{what}: {}", e.split(" [").next().unwrap());
        }
    }
    send_buy(&mut env, &b).expect("the real compressed proof lands");
}

/// Tag 3 with no tip: no tip account, the first inner account at index 8 (pump: the ATA program).
#[test]
fn release_and_buy_with_no_tip_lands() {
    let mut env = with_deposits();
    let v = load_venue(&mut env, "pump");
    let b = Buy { r: rel(&env, "release"), compressed: false, flags: 0, tip: 0, tip_to: Pubkey::new_from_array([0; 32]), inner: steps(&v["buy"]), trailing: vec![], count: None };
    let pool0 = lamports(&env, &env.pool);
    send_buy(&mut env, &b).unwrap_or_else(|e| panic!("tag 3 with no tip: {e}"));
    assert_eq!(lamports(&env, &env.pool), pool0 - b.r.withdrawn);
}

/// a third party that deposits first with W's precommitment fails W's sell-and-deposit whole: W keeps its tokens.
#[test]
fn a_copied_precommitment_fails_the_whole_sell() {
    let mut env = with_deposits();
    let (v, ata) = release_and_buy_on(&mut env, "pump", false, 5, &PUMP_STATIC);
    let held = token_amount(&env, &ata);
    let pre = [0x0e; 32];
    // the third party's deposit, first
    let s0 = state_size(&env);
    deposit(&mut env, 1_000_000, &pre, s0, 6).expect("the copy lands");
    let mut dep = deposit_ix(&env, 1_000_000, &pre, state_size(&env), 7);
    dep.accounts[1] = AccountMeta::new(env.w.pubkey(), true);
    let mut ixs = vec![compute_limit(400_000)];
    ixs.extend(steps(&v["sell"]));
    ixs.push(dep);
    let w = env.w.insecure_clone();
    assert_eq!(send(&mut env, &ixs, &w.pubkey(), &[&w]).err(), Some(PRECOMMITMENT_ALREADY_USED));
    assert_eq!(token_amount(&env, &ata), held, "W keeps its tokens");
}
