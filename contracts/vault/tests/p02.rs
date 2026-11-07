// SPDX-License-Identifier: Apache-2.0
//! VT-P02 (vault.md 5, l.1139 at research main): random sequences of prepay, deposit, withdraw, ragequit, settle and
//! hostile calls on the vault's state code, with a mock token that fails a part of a payout at random; I1 to I6
//! (vault.md 3, l.1101-1105) hold after every step.
//!
//! The vault runs here as its own Rust code in near-sdk's mocked chain (no wasm, no sandbox): each call gets a fresh
//! mocked context on the storage the last call left, and a refused call is rolled back as NEAR rolls back a failed
//! receipt (the contract struct and every record restored), after the harness has read what the refusal did. A call
//! that lands has its struct written and read back through Borsh, as the chain stores the state record.
//!
//! - The notes are tests/fixtures/withdraw-spends.json's six (made by make-withdraw-spends.mjs: the kit's input builder
//!   and snarkjs, real Groth16 proofs), so every withdrawal that lands passes the vault's real proof check. Their proofs
//!   name the state and label roots of the first 6 deposits (old_root: the first 4), so a withdrawal lands only once the
//!   vault's trees really had that root: the six deposits first, in order, before any other leaf. The generator puts
//!   them early most of the time; a case where another leaf comes first is a case of withdrawals against roots the
//!   vault never had, which I4 requires it to refuse.
//! - The ragequits are tests/fixtures/ragequit-spends.json's commitment proofs (make-ragequit-spends.mjs, real Groth16
//!   proofs) of the same six notes, deposit 6 named to q.test.near as that file names it: note 3 by u and note 6 by q
//!   land once their deposits are in the tree under their own labels; note 2's (withdrawn) shares a nullifier with
//!   same_nullifier_a and _b, note 3's with one_block_a and _b, note 6's with short_registration, so a nullifier is
//!   spent by either exit and the other is refused, in both orders; one_block_a_change proves one_block_a's change note
//!   (6,000,000 on note 3's label), which lands by u once that withdrawal's change leaf is in the tree (row 4 takes any
//!   leaf of the label, not only its deposit's); change and unlanded prove notes that are never leaves here, zero a 0
//!   note, and refund_note a label no deposit has. A ragequit has no root check (2.5.3); its payout and settle are a
//!   withdrawal's, to and from the depositor; some land with exactly their gas bound attached.
//! - The mock token (`Token`) keeps every account's balance. `ft_transfer_call` moves the amount into the vault before
//!   `ft_on_transfer` and gives it back when the call refuses. A payout receipt runs its parts in order
//!   (`storage_deposit`, then `ft_transfer` to the recipient, then to the fee recipient); at random the token fails one
//!   of them, the fee's half the time when there is one, else any part (and a registration below the token's
//!   0.00125 NEAR always fails); a failed part fails the receipt, which moves nothing (one receipt: all or none), and
//!   the callback is told Failed.
//! - Payouts stay in flight across steps: a `Resolve` step runs one pending payout receipt and its `on_payout`, so
//!   several can be in flight while deposits, other withdrawals and settles run.
//! - Hostile steps: withdrawals against an unknown root, against the same notes' roots on another vault (another
//!   scope), to another recipient than the proof's, of another amount, of more than the notes hold, with too little gas
//!   or too little NEAR, and the same nullifier again; ragequits by a stranger or the other depositor, of a refund note,
//!   on a settled spend's refund label put in the label signal, on changed signals, of a note not in the tree, of a 0
//!   note, with a 0 refund precommitment, too little gas or too little NEAR, and the same nullifier again (after a
//!   ragequit or a withdrawal); deposits from a
//!   caller that is not the token, under MIN_DEPOSIT, on a used precommitment, without a prepay, or on a 756 B prepay
//!   while a tree grows a level; prepays on 0, on p, on a used precommitment, or short; settles of an unknown, in-flight
//!   or settled spend; a second callback, a callback with two results, a callback on no spend; plain transfers of the
//!   token into the vault (M8's stray money).
//! - The model predicts every call's outcome (the exact refusal, in the vault's order of checks) and keeps each spend's
//!   status, the totals, and every leaf and label in order; after every step the invariants run on the vault's own views
//!   and the token's balances, then the model's leaves, labels, totals, counts and each spend record's payer,
//!   recipient, fee, context and change leaf index are compared exactly. The harness counts the bytes each landed call
//!   writes from its records (`usage_delta`, never the vault's own `env::storage_usage()`): an exit's reserve is exactly
//!   the attachment less those bytes, its registration and its yocto, and settle pays the payer exactly the reserve
//!   less the bytes it wrote. Each exit's callback must depend on its payout receipt.
//!
//! Each named branch is counted (`Branch`); the long run fails when any of `BRANCHES` counts 0, so a run that never
//! drew a failing part of a payout cannot pass for a refund test. The long run (24 cases) is `#[ignore]`d, as
//! tests/tree_prop.rs's is: CI's vault-sandbox job runs it (tests/harness/run.sh passes `--include-ignored`) on every
//! pull request that touches the vault; a plain `cargo test` runs its first 2 cases as a smoke run, and the mutant tests.
//!   cargo +1.96.0 test --locked --manifest-path contracts/vault/Cargo.toml --test p02 -- --ignored The seed and the case count are fixed (`SEED`, `CASES`); a failure names
//! the seed, the case and the step, and `P02_SEED`, `P02_CASES` and `P02_MUTANT` replay or plant.
//!
//! The mutants are the harness's only, never the vault's code: `misread` tells `on_payout` Successful when the token
//! failed (a vault that reads a failed payout as delivered), `drop-spent` deletes the `spent` record each withdrawal
//! writes (a vault that forgets a nullifier), `token-never-fails` keeps the token from ever failing a part. The tests
//! below show each one fails the run, with the invariant it breaks. Bugs in the vault's own code are planted in a copy
//! of contracts/vault, never here (card vault-property-p02's run: settle's record rewrite dropped, the change leaf
//! taken from the nullifier hash, settle's `nonce += 1` dropped; each fails this test).
//!
//! Not here: `#[private]` and `#[payable]` are checked by the wasm export near-sdk generates, which this harness does
//! not run (VT-S04 and VT-S17 call `on_payout` from a stranger in near-sandbox).

use blindfill_vault::constants::{MIN_DEPOSIT, TOKEN};
use blindfill_vault::context::label_of;
use blindfill_vault::poseidon::PoseidonT4;
use blindfill_vault::ragequit::{SIGNAL_COMMITMENT, SIGNAL_LABEL, SIGNAL_NULLIFIER_HASH, SIGNAL_VALUE};
use blindfill_vault::verifier::Proof;
use blindfill_vault::withdraw::Withdrawal;
use blindfill_vault::{field, scope_for, Bytes32, SpendView, Status, Vault};
use near_sdk::json_types::U128;
use near_sdk::mock::{MockAction, Receipt};
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{env, AccountId, Gas, NearToken, PromiseResult};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::panic::{catch_unwind, AssertUnwindSafe};

const FIXTURE: &str = include_str!("fixtures/withdraw-spends.json");
const RQ_FIXTURE: &str = include_str!("fixtures/ragequit-spends.json");
/// The fixed run: `P02_SEED` and `P02_CASES` replace them.
const SEED: u64 = 0x5602_0000_0000_0001;
/// The long run's cases (`#[ignore]`d; tests/harness/run.sh runs it) and the smoke run's (every plain `cargo test`).
const CASES: u64 = 24;
const SMOKE_CASES: u64 = 2;
const STEPS: u64 = 48;
/// The chance the token fails a payout receipt at one of its parts, in percent.
const FAIL_PCT: u64 = 45;

const PAYER: &str = "relayer.test.near";
const DEPOSITOR: &str = "u.test.near";
const MALLORY: &str = "mallory.test.near";
const SETTLER: &str = "anyone.test.near";
const BYTE: u128 = 10_000_000_000_000_000_000;
const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// The kit's prepay whenever a tree may grow (vault.md 2.10 (h)).
const PREPAY: u128 = 904 * BYTE;
/// USDC's and the mock's registration (0.00125 NEAR).
const REGISTER_MIN: u128 = 1_250_000_000_000_000_000_000;
const P_DEC: &str = "21888242871839275222246405745257275088548364400416034343698204186575808495617";

// ---------------------------------------------------------------------------------------------------------------------
// The fixture

struct Spend {
    name: String,
    withdrawal: Withdrawal,
    proof: Proof,
    signals: [String; 8],
    /// the deposits whose trees its roots are: 4 for old_root, else 6 (make-withdraw-spends.mjs `spend(..., size)`)
    size: usize,
    withdrawn: u128,
    fee: u128,
    register: u128,
}

/// One of ragequit-spends.json's commitment proofs: `[commitment, nullifierHash, value, label]`.
struct Ragequit {
    name: String,
    proof: Proof,
    signals: [String; 4],
    register: String,
    refund_precommitment: String,
    /// the account that file has sign it
    depositor: String,
}

struct Fixture {
    vault: String,
    precommitments: Vec<String>,
    /// the depositor each of the six deposits names (ragequit-spends.json's: u.test.near, q.test.near for the sixth)
    depositors: Vec<String>,
    ragequits: Vec<Ragequit>,
    values: Vec<u128>,
    spends: Vec<Spend>,
    /// (size, state root, label root) for each size a proof names
    roots: Vec<(usize, String, String)>,
    /// the six deposits' commitments and labels, as the kit computed them
    leaves: Vec<String>,
    labels: Vec<String>,
    /// the newest state and label roots of the same notes on another vault (another scope)
    other_vault: (String, String),
}

fn fixture() -> Fixture {
    let f: Value = serde_json::from_str(FIXTURE).unwrap();
    let strs = |k: &str| -> Vec<String> { f[k].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect() };
    let spends: Vec<Spend> = f["spends"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let withdrawal: Withdrawal = serde_json::from_value(s["withdrawal"].clone()).unwrap();
            let signals: [String; 8] = serde_json::from_value(s["public_signals"].clone()).unwrap();
            let name = s["name"].as_str().unwrap().to_string();
            Spend {
                size: if name == "old_root" { 4 } else { 6 },
                withdrawn: signals[2].parse().unwrap(),
                fee: withdrawal.relay_fee.parse().unwrap(),
                register: withdrawal.register_deposit.parse().unwrap(),
                proof: serde_json::from_value(s["proof"].clone()).unwrap(),
                name,
                withdrawal,
                signals,
            }
        })
        .collect();
    let mut roots: Vec<(usize, String, String)> = Vec::new();
    for s in &spends {
        let r = (s.size, s.signals[3].clone(), s.signals[5].clone());
        match roots.iter().find(|x| x.0 == r.0) {
            // every proof of one size names the same two roots
            Some(x) => assert_eq!(x, &r, "{}: the roots of size {}", s.name, s.size),
            None => roots.push(r),
        }
    }
    assert_eq!(roots.len(), 2, "the fixture's proofs name the trees of 4 and of 6 deposits");
    // the ragequits' file: the same vault and the same six deposits, each with its depositor
    let r: Value = serde_json::from_str(RQ_FIXTURE).unwrap();
    assert_eq!(r["vault"], f["vault"], "ragequit-spends.json is on withdraw-spends.json's vault");
    let deposits = r["deposits"].as_array().unwrap();
    assert_eq!(deposits.len(), 6);
    for (i, d) in deposits.iter().enumerate() {
        for (k, list) in [("commitment", "leaves"), ("label", "labels"), ("precommitment", "precommitments"), ("value", "values")] {
            assert_eq!(d[k], f[list][i], "ragequit-spends.json deposit {i}'s {k}");
        }
    }
    let depositors: Vec<String> = deposits.iter().map(|d| d["depositor"].as_str().unwrap().to_string()).collect();
    // deposit_bytes counts every deposit at DEPOSITOR's length
    assert!(depositors.iter().all(|d| d.len() == DEPOSITOR.len()), "{depositors:?}");
    let ragequits = r["ragequits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| Ragequit {
            name: x["name"].as_str().unwrap().to_string(),
            proof: serde_json::from_value(x["proof"].clone()).unwrap(),
            signals: serde_json::from_value(x["public_signals"].clone()).unwrap(),
            register: x["register_deposit"].as_str().unwrap().to_string(),
            refund_precommitment: x["refund_precommitment"].as_str().unwrap().to_string(),
            depositor: x["depositor"].as_str().unwrap().to_string(),
        })
        .collect();
    Fixture {
        vault: f["vault"].as_str().unwrap().to_string(),
        precommitments: strs("precommitments"),
        depositors,
        ragequits,
        values: strs("values").iter().map(|v| v.parse().unwrap()).collect(),
        spends,
        roots,
        leaves: strs("leaves"),
        labels: strs("labels"),
        other_vault: (
            f["other_vault"]["state_root"].as_str().unwrap().to_string(),
            f["other_vault"]["label_root"].as_str().unwrap().to_string(),
        ),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The random source and the mutants

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn pct(&mut self, p: u64) -> bool {
        self.below(100) < p
    }
    /// A random field element below p, never 0, as a decimal.
    fn field(&mut self) -> String {
        let v = [self.next() & ((1 << 61) - 1), self.next(), self.next(), self.next() | 1];
        field::to_decimal(&v)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mutant {
    None,
    /// `on_payout` is told Successful when the token failed the receipt
    Misread,
    /// the `spent` record a withdrawal writes is deleted
    DropSpent,
    /// the token never fails a part
    TokenNeverFails,
}

impl Mutant {
    fn from_env() -> Self {
        match std::env::var("P02_MUTANT").as_deref() {
            Err(_) | Ok("") | Ok("none") => Mutant::None,
            Ok("misread") => Mutant::Misread,
            Ok("drop-spent") => Mutant::DropSpent,
            Ok("token-never-fails") => Mutant::TokenNeverFails,
            Ok(m) => panic!("P02_MUTANT: {m}? want misread, drop-spent or token-never-fails"),
        }
    }
}

fn env_u64(name: &str, default: u64) -> u64 {
    match std::env::var(name) {
        Ok(v) if v.starts_with("0x") => u64::from_str_radix(&v[2..], 16).unwrap(),
        Ok(v) => v.parse().unwrap(),
        Err(_) => default,
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The branches the run must hit

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Branch {
    PayoutDelivered,
    PayoutStorageDepositFailed,
    PayoutRecipientFailed,
    PayoutFeeFailed,
    SettleRefundNote,
    SettlePaid,
    DepositLanded,
    DepositRefused,
    /// a 756 B prepay on a deposit that grows a tree a level (src/deposit.rs row 7)
    DepositShortPrepay,
    WithdrawLanded,
    WithdrawUnknownRoot,
    WithdrawDoubleSpend,
    WithdrawContextMismatch,
    /// another amount than the proof's, within what the notes hold: the proof check refuses it
    WithdrawOtherAmount,
    /// an amount over what the notes hold: row 9 refuses it before the proof
    WithdrawOverHeld,
    WithdrawShortGas,
    WithdrawShortStorage,
    /// the change leaf already in the tree: reached only when the drop-spent mutant lets a spend repeat, so not gated
    WithdrawLeafExists,
    PrepayLanded,
    PrepayRefused,
    SettleInFlight,
    SettleAlreadySettled,
    /// a nullifier hash no spend has, or one that is not a canonical decimal
    SettleUnknown,
    CallbackSecond,
    CallbackTwoResults,
    CallbackUnknown,
    Stray,
    /// the same notes' roots on another vault (another scope)
    WithdrawWrongScope,
    /// a withdrawal on a nullifier a ragequit spent
    WithdrawAfterRagequit,
    RagequitLanded,
    /// a ragequit signed by an account no deposit names (row 2)
    RagequitStranger,
    /// a ragequit signed by a depositor, not the one its label's deposit names (row 2)
    RagequitOtherDepositor,
    /// a ragequit on a refund note's label, which no deposit has (row 2): the fixture's refund_note when nonce 7 is a
    /// refund note, or the settled-refund-label draw
    RagequitRefundNoteLabel,
    /// a ragequit on a label no deposit or refund note has yet (row 2)
    RagequitNotLanded,
    /// the hostile draw that puts a settled spend's refund label in a ragequit's label signal: row 2 refuses it before
    /// the proof is checked (a refund note has no depositor, src/settle.rs writes no `label_index` row)
    RagequitSettledRefundLabel,
    /// a ragequit of a change note (one_block_a's) landed: row 4 takes any leaf of the label, not only its deposit's
    RagequitChangeNote,
    /// a ragequit landed with exactly its gas bound attached (145 Tgas, 155 with a registration)
    RagequitAtGasBound,
    /// the same nullifier again after a ragequit
    RagequitReplayed,
    /// a ragequit on a nullifier a withdrawal spent
    RagequitAfterWithdraw,
    RagequitInvalidProof,
    RagequitNotInTree,
    RagequitZeroValue,
    RagequitZeroRefundPrecommitment,
    RagequitShortGas,
    RagequitShortStorage,
    /// a ragequit's payout delivered to its depositor
    RagequitPaid,
    /// a ragequit's failed payout settled into a refund note
    SettleRagequitRefund,
}

/// The branches every run must hit at least once.
const BRANCHES: [Branch; 46] = [
    Branch::PayoutDelivered,
    Branch::PayoutStorageDepositFailed,
    Branch::PayoutRecipientFailed,
    Branch::PayoutFeeFailed,
    Branch::SettleRefundNote,
    Branch::SettlePaid,
    Branch::DepositLanded,
    Branch::DepositRefused,
    Branch::DepositShortPrepay,
    Branch::WithdrawLanded,
    Branch::WithdrawUnknownRoot,
    Branch::WithdrawDoubleSpend,
    Branch::WithdrawContextMismatch,
    Branch::WithdrawOtherAmount,
    Branch::WithdrawOverHeld,
    Branch::WithdrawShortGas,
    Branch::WithdrawShortStorage,
    Branch::PrepayLanded,
    Branch::PrepayRefused,
    Branch::SettleInFlight,
    Branch::SettleAlreadySettled,
    Branch::SettleUnknown,
    Branch::CallbackSecond,
    Branch::CallbackTwoResults,
    Branch::CallbackUnknown,
    Branch::Stray,
    Branch::WithdrawWrongScope,
    Branch::WithdrawAfterRagequit,
    Branch::RagequitLanded,
    Branch::RagequitStranger,
    Branch::RagequitOtherDepositor,
    Branch::RagequitRefundNoteLabel,
    Branch::RagequitNotLanded,
    Branch::RagequitSettledRefundLabel,
    Branch::RagequitChangeNote,
    Branch::RagequitAtGasBound,
    Branch::RagequitReplayed,
    Branch::RagequitAfterWithdraw,
    Branch::RagequitInvalidProof,
    Branch::RagequitNotInTree,
    Branch::RagequitZeroValue,
    Branch::RagequitZeroRefundPrecommitment,
    Branch::RagequitShortGas,
    Branch::RagequitShortStorage,
    Branch::RagequitPaid,
    Branch::SettleRagequitRefund,
];

// ---------------------------------------------------------------------------------------------------------------------
// The mock token

/// One payout part as the vault's receipt carries it.
#[derive(Clone, Debug)]
enum Part {
    /// `storage_deposit(recipient)` with `yocto`
    Register { yocto: u128 },
    /// `ft_transfer(recipient, withdrawn - fee)`
    Recipient { to: String, amount: u128 },
    /// `ft_transfer(fee_recipient, fee)`
    Fee { to: String, amount: u128 },
}

/// A payout receipt the vault made and the token has not run yet.
#[derive(Clone, Debug)]
struct Pending {
    spend_index: u64,
    parts: Vec<Part>,
    /// the callback receipt's own `to_recipient` and `fee`
    to_recipient: u128,
    fee: u128,
}

/// A spend the vault wrote, as the model knows it: a withdrawal's request as its proof binds it, or a ragequit's (the
/// depositor pays, is paid, and no fee).
#[derive(Clone, Debug)]
struct Exit {
    ragequit: bool,
    name: String,
    nullifier_hash: String,
    withdrawn: u128,
    fee: u128,
    register: u128,
    recipient: String,
    fee_recipient: String,
    refund_precommitment: String,
    payer: String,
    /// a withdrawal's context (its proof's signal 7), a ragequit's "0"
    context: String,
    /// a withdrawal's change leaf's index in the state tree, a ragequit's 0 (it inserts none)
    new_leaf_index: u64,
}

#[derive(Default)]
struct Token {
    balances: BTreeMap<String, u128>,
    /// every transfer out of the vault: (spend index, to, amount)
    outflows: Vec<(u64, String, u128)>,
}

impl Token {
    fn balance(&self, a: &str) -> u128 {
        self.balances.get(a).copied().unwrap_or(0)
    }
    fn add(&mut self, a: &str, n: u128) {
        *self.balances.entry(a.to_string()).or_default() += n;
    }
    fn sub(&mut self, a: &str, n: u128) {
        let b = self.balances.get_mut(a).expect("the token moves only what an account holds");
        *b = b.checked_sub(n).expect("the token moves only what an account holds");
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The harness: the vault, its storage, the token and the model

/// A leaf of the state tree as the model knows it: fixture deposit k's commitment, or any other leaf.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Leaf {
    Fixture(usize),
    Other,
}

/// What one call did.
struct Outcome<R> {
    result: Result<R, String>,
    logs: Vec<String>,
    receipts: Vec<Receipt>,
    /// a refused call changed the struct or a record before it refused (then rolled back)
    wrote: bool,
    /// the bytes a landed call added, counted from its records (`usage_delta`); 0 for a refusal
    usage: i128,
}

struct Harness {
    fx: Fixture,
    vault: Vault,
    storage: HashMap<Vec<u8>, Vec<u8>>,
    token: Token,
    mutant: Mutant,
    rng: Rng,
    branches: BTreeMap<Branch, u64>,
    // the model
    nonce: u64,
    leaves: Vec<Leaf>,
    /// the length of the run of fixture deposits 0, 1, 2, ... that opens the state tree
    fixture_prefix: usize,
    next_fixture: usize,
    prepaid: HashMap<String, u128>,
    /// ordered, so a draw from it is the same on every run
    used: BTreeSet<String>,
    /// prepaid precommitments of deposits that are not the fixture's
    others: Vec<String>,
    change_leaves: HashSet<String>,
    /// nullifier hash -> the spend that landed on it
    landed: HashMap<String, u64>,
    /// spends the vault has written
    spend_count: u64,
    /// spend index -> the exit it is (two fixture spends can share a nullifier, so never looked up by it)
    exits: Vec<Exit>,
    /// nonce -> the depositor the deposit of that label named (a refund note's label has none)
    label_depositor: HashMap<u64, String>,
    pending: Vec<Pending>,
    stray: u128,
    deposited: u128,
    spent: u128,
    returned: u128,
    /// roots no tree ever had, drawn for hostile withdrawals and each step
    false_roots: Vec<String>,
    /// spend index -> its status as the model expects it
    status: Vec<Status>,
    /// the state tree's leaves and the label tree's labels as the model expects them, in order
    exp_leaves: Vec<String>,
    /// nullifier hashes whose `spent` record the drop-spent mutant deleted
    forgotten: HashSet<String>,
    /// the labels of the refund notes settle wrote, in order (label_of(scope, the nonce it took))
    refund_labels: Vec<String>,
}

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn be(dec: &str) -> Bytes32 {
    field::to_be(&field::from_decimal(dec).unwrap())
}

fn dec(b: &Bytes32) -> String {
    field::to_decimal(&field::from_be(b))
}

fn amount_be(amount: u128) -> Bytes32 {
    let mut b = [0u8; 32];
    b[16..].copy_from_slice(&amount.to_be_bytes());
    b
}

fn deposit_msg(p: &str, depositor: &str) -> String {
    format!(r#"{{"precommitment":"{p}","depositor":"{depositor}"}}"#)
}

/// A panic's text; the vault's own message when it is the mocked host's `GuestPanic { panic_msg: "..." }`.
fn panic_text(e: Box<dyn std::any::Any + Send>) -> String {
    let s = match e.downcast::<String>() {
        Ok(s) => *s,
        Err(e) => e.downcast::<&str>().map(|s| s.to_string()).unwrap_or_default(),
    };
    match s.split_once("panic_msg: \"") {
        Some((_, rest)) => rest.rsplit_once("\" })").map_or(rest, |r| r.0).to_string(),
        None => s,
    }
}

/// The bytes the records `after` hold over `before`, as NEAR counts an account's storage (near-parameters'
/// `num_extra_bytes_record`, 40): a new record is its key, its value and 40 B, a rewritten one the change in its value's
/// length, a removed one all of it less. The harness's own count, never the vault's `env::storage_usage()`.
fn usage_delta(before: &HashMap<Vec<u8>, Vec<u8>>, after: &HashMap<Vec<u8>, Vec<u8>>) -> i128 {
    let size = |k: &[u8], v: &[u8]| (k.len() + v.len() + 40) as i128;
    let added: i128 = after
        .iter()
        .map(|(k, v)| match before.get(k) {
            Some(old) => v.len() as i128 - old.len() as i128,
            None => size(k, v),
        })
        .sum();
    let removed: i128 = before.iter().filter(|(k, _)| !after.contains_key(*k)).map(|(k, v)| size(k, v)).sum();
    added - removed
}

impl Harness {
    fn new(seed: u64, mutant: Mutant) -> Self {
        Harness {
            fx: fixture(),
            vault: Vault::default(),
            storage: HashMap::new(),
            token: Token::default(),
            mutant,
            rng: Rng(seed),
            branches: BTreeMap::new(),
            nonce: 0,
            leaves: Vec::new(),
            fixture_prefix: 0,
            next_fixture: 0,
            prepaid: HashMap::new(),
            used: BTreeSet::new(),
            others: Vec::new(),
            change_leaves: HashSet::new(),
            landed: HashMap::new(),
            spend_count: 0,
            exits: Vec::new(),
            label_depositor: HashMap::new(),
            pending: Vec::new(),
            stray: 0,
            deposited: 0,
            spent: 0,
            returned: 0,
            false_roots: Vec::new(),
            status: Vec::new(),
            exp_leaves: Vec::new(),
            forgotten: HashSet::new(),
            refund_labels: Vec::new(),
        }
    }

    fn hit(&mut self, b: Branch) {
        *self.branches.entry(b).or_default() += 1;
    }

    fn install(&self, by: &str, attached: u128, gas: Gas, results: Vec<PromiseResult>) {
        env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
            VMContextBuilder::new()
                .current_account_id(id(&self.fx.vault))
                .predecessor_account_id(id(by))
                .attached_deposit(NearToken::from_yoctonear(attached))
                .prepaid_gas(gas)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            results,
            self.storage.clone(),
            Default::default(),
            None,
        ));
    }

    /// One call on the vault in a fresh mocked context on the current records. A refusal is rolled back, as NEAR
    /// drops a failed receipt's writes, after reading whether it wrote anything first.
    fn call<R>(&mut self, by: &str, attached: u128, gas: Gas, results: Vec<PromiseResult>, f: impl FnOnce(&mut Vault) -> R) -> Outcome<R> {
        self.install(by, attached, gas, results);
        let before = near_sdk::borsh::to_vec(&self.vault).unwrap();
        let result = catch_unwind(AssertUnwindSafe(|| f(&mut self.vault))).map_err(panic_text);
        let logs = get_logs();
        let receipts = get_created_receipts();
        let after = near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
        let mut wrote = false;
        let mut usage = 0;
        match result {
            Ok(_) => {
                usage = usage_delta(&self.storage, &after);
                self.storage = after;
                // the chain writes the contract's state record after the call and reads it back on the next one
                self.vault = near_sdk::borsh::from_slice(&near_sdk::borsh::to_vec(&self.vault).unwrap()).unwrap();
            }
            Err(_) => {
                wrote = near_sdk::borsh::to_vec(&self.vault).unwrap() != before || after != self.storage;
                self.vault = near_sdk::borsh::from_slice(&before).unwrap();
            }
        }
        Outcome { result, logs, receipts, wrote, usage }
    }

    /// L3 (src/payout.rs row 14): a landed exit's reserve is exactly the attachment less the bytes it wrote (counted
    /// from its records, never from the vault's own `env::storage_usage()`), its registration and 1 yocto per
    /// `ft_transfer`.
    fn check_reserve(&self, index: u64, attached: u128, usage: i128, register: u128, fee: u128) {
        let bytes = u128::try_from(usage).expect("an exit only adds records");
        let yocto = if fee > 0 { 2 } else { 1 };
        let want = attached - bytes * BYTE - register - yocto;
        let got = self.view(|v| v.spends(index, 1))[0].reserve.0;
        assert!(
            got == want,
            "storage (row 14): spend {index}'s reserve is {got}, want {want}: {attached} attached less {bytes} B written, {register} registration and {yocto} yocto"
        );
    }

    /// A read of the vault's views on the current records.
    fn view<R>(&self, f: impl FnOnce(&Vault) -> R) -> R {
        self.install(SETTLER, 0, Gas::from_tgas(300), vec![]);
        f(&self.vault)
    }

    fn state_had(&self, size: usize) -> bool {
        self.fixture_prefix >= size
    }

    fn insert_leaf(&mut self, leaf: Leaf, value: String) {
        if leaf == Leaf::Fixture(self.fixture_prefix) && self.leaves.len() == self.fixture_prefix {
            self.fixture_prefix += 1;
        }
        self.leaves.push(leaf);
        self.exp_leaves.push(value);
    }

    /// The label of the `nonce`th deposit or refund note.
    fn label(&self, nonce: u64) -> Bytes32 {
        field::to_be(&label_of(&scope_for(&self.fx.vault, TOKEN), nonce))
    }

    /// A note's commitment, Poseidon(value, label, precommitment).
    fn commitment(value: u128, label: &Bytes32, precommitment: &str) -> String {
        dec(&PoseidonT4::new().hash(&amount_be(value), label, &be(precommitment)))
    }

    fn held(&self) -> u128 {
        self.deposited - (self.spent - self.returned)
    }

    // ---- the steps ----

    fn step(&mut self) -> String {
        let fixture_left = self.next_fixture < self.fx.values.len();
        let fresh = self.rng.field();
        self.false_roots.push(fresh);
        let r = self.rng.below(100);
        match r {
            0..=39 if fixture_left => self.fixture_deposit_step(),
            70..=77 if fixture_left && self.rng.pct(75) => self.fixture_deposit_step(),
            0..=33 => self.withdraw_step(),
            34..=45 => self.ragequit_step(),
            46..=60 => self.resolve_step(),
            61..=69 => self.settle_step(),
            70..=77 => self.other_deposit_step(),
            78..=83 => self.hostile_deposit_step(),
            84..=89 => self.hostile_prepay_step(),
            90..=95 => self.hostile_callback_step(),
            _ => self.stray_step(),
        }
    }

    /// The next fixture deposit: its prepay (unless the draw skips it, then the deposit is refused NoPrepay), then the
    /// depositor's `ft_transfer_call`.
    fn fixture_deposit_step(&mut self) -> String {
        let k = self.next_fixture;
        let p = self.fx.precommitments[k].clone();
        if !self.prepaid.contains_key(&p) && self.rng.pct(85) {
            self.prepay(&p, PREPAY, Ok(()));
        }
        let (value, depositor) = (self.fx.values[k], self.fx.depositors[k].clone());
        let landed = self.deposit_as(TOKEN, &depositor, &p, value);
        if landed {
            self.next_fixture += 1;
        }
        format!("fixture deposit {k} ({})", if landed { "landed" } else { "refused" })
    }

    fn other_deposit_step(&mut self) -> String {
        if self.others.is_empty() || self.rng.pct(40) {
            let p = self.rng.field();
            let attached = PREPAY + self.rng.below(1_000) as u128;
            self.prepay(&p, attached, Ok(()));
            self.others.push(p);
            return "prepay of another deposit".into();
        }
        let i = self.rng.below(self.others.len() as u64) as usize;
        let p = self.others.swap_remove(i);
        let value = MIN_DEPOSIT + self.rng.below(20_000_000) as u128;
        let landed = self.deposit(TOKEN, &p, value);
        format!("another deposit of {value} ({})", if landed { "landed" } else { "refused" })
    }

    fn hostile_deposit_step(&mut self) -> String {
        if self.deposit_bytes() > 756 && self.rng.pct(50) {
            let p = self.rng.field();
            self.prepay(&p, 756 * BYTE, Ok(()));
            let landed = self.deposit(TOKEN, &p, MIN_DEPOSIT);
            assert!(!landed, "a deposit of {} B landed on a 756 B prepay", self.deposit_bytes());
            return "hostile deposit on a 756 B prepay while a tree grows a level".into();
        }
        let (what, by, p, value) = match self.rng.below(4) {
            0 => ("from a caller that is not the token", MALLORY, self.rng.field(), MIN_DEPOSIT),
            1 => {
                let p = self.rng.field();
                self.prepay(&p, PREPAY, Ok(()));
                ("under MIN_DEPOSIT", TOKEN, p, MIN_DEPOSIT - 1)
            }
            2 => match self.used.iter().next().cloned() {
                Some(p) => ("on a used precommitment", TOKEN, p, MIN_DEPOSIT),
                None => ("without a prepay", TOKEN, self.rng.field(), MIN_DEPOSIT),
            },
            _ => ("without a prepay", TOKEN, self.rng.field(), MIN_DEPOSIT),
        };
        let landed = self.deposit(by, &p, value);
        assert!(!landed, "a hostile deposit ({what}) landed");
        format!("hostile deposit {what}")
    }

    fn hostile_prepay_step(&mut self) -> String {
        let (what, p, attached, want): (&str, String, u128, &str) = match self.rng.below(4) {
            0 => ("on 0", "0".into(), PREPAY, "InvalidPrecommitment"),
            1 => ("on p", P_DEC.into(), PREPAY, "FieldOverflow"),
            2 => match self.used.iter().next().cloned() {
                Some(p) => ("on a used precommitment", p, PREPAY, "PrecommitmentAlreadyUsed"),
                None => ("short", self.rng.field(), 756 * BYTE - 1, "InsufficientStorageDeposit"),
            },
            _ => ("short", self.rng.field(), 756 * BYTE - 1, "InsufficientStorageDeposit"),
        };
        self.prepay(&p, attached, Err(want));
        format!("hostile prepay {what}")
    }

    /// `storage_prepay(p)` with `attached`, which must end as `want`.
    fn prepay(&mut self, p: &str, attached: u128, want: Result<(), &str>) {
        let pc = p.to_string();
        let o = self.call(PAYER, attached, Gas::from_tgas(30), vec![], |v| v.storage_prepay(pc));
        let o = self.refusal_moves_nothing(o, "storage_prepay");
        match (&o.result, want) {
            (Ok(()), Ok(())) => {
                *self.prepaid.entry(p.to_string()).or_default() += attached;
                self.hit(Branch::PrepayLanded);
            }
            (Err(e), Err(w)) if e.contains(w) => self.hit(Branch::PrepayRefused),
            (got, want) => panic!("storage_prepay: got {got:?}, want {want:?}"),
        }
        assert!(o.receipts.is_empty(), "I3: storage_prepay made a receipt");
    }

    fn deposit(&mut self, by: &str, p: &str, value: u128) -> bool {
        self.deposit_as(by, DEPOSITOR, p, value)
    }

    /// The token's `ft_transfer_call(vault, value, msg)` by the depositor, or a direct call by `by` when it is not the
    /// token, with `msg` naming `depositor`. Returns whether the deposit landed; checks the model's prediction.
    fn deposit_as(&mut self, by: &str, depositor: &str, p: &str, value: u128) -> bool {
        let want: Result<(), &str> = if by != TOKEN {
            Err("NotTheToken")
        } else if self.used.contains(p) {
            Err("PrecommitmentAlreadyUsed")
        } else if value < MIN_DEPOSIT {
            Err("MinimumDepositAmount")
        } else if !self.prepaid.contains_key(p) {
            Err("NoPrepay")
        } else if self.prepaid[p] < self.deposit_bytes() * BYTE {
            Err("InsufficientStorageDeposit")
        } else {
            Ok(())
        };
        let from_token = by == TOKEN;
        if from_token {
            // the token moves the depositor's amount into the vault before it calls the receiver
            self.token.add(&self.fx.vault.clone(), value);
        }
        let msg = deposit_msg(p, depositor);
        let o = self.call(by, 0, Gas::from_tgas(100), vec![], |v| v.ft_on_transfer(id(DEPOSITOR), U128(value), msg));
        let o = self.refusal_moves_nothing(o, "ft_on_transfer");
        assert!(o.receipts.is_empty(), "I3: ft_on_transfer made a receipt");
        match (&o.result, want) {
            (Ok(U128(0)), Ok(())) => {
                self.prepaid.remove(p);
                self.used.insert(p.to_string());
                self.nonce += 1;
                self.label_depositor.insert(self.nonce, depositor.to_string());
                let k = self.fx.precommitments.iter().position(|x| x == p);
                // fixture deposit k's commitment is the fixture's leaf only under its own label, nonce k + 1
                let leaf = match k {
                    Some(k) if self.nonce == k as u64 + 1 && self.fx.values[k] == value => Leaf::Fixture(k),
                    _ => Leaf::Other,
                };
                // the kit's commitment for a fixture deposit under its own label, else Poseidon(value, label, p)
                let value_leaf = match leaf {
                    Leaf::Fixture(k) => self.fx.leaves[k].clone(),
                    Leaf::Other => Self::commitment(value, &self.label(self.nonce), p),
                };
                self.insert_leaf(leaf, value_leaf);
                self.deposited += value;
                self.hit(Branch::DepositLanded);
                true
            }
            (Err(e), Err(w)) if e.contains(w) => {
                if from_token {
                    // the token's resolve gives the whole amount back
                    self.token.sub(&self.fx.vault.clone(), value);
                }
                self.hit(if w == "InsufficientStorageDeposit" { Branch::DepositShortPrepay } else { Branch::DepositRefused });
                false
            }
            (got, want) => panic!("ft_on_transfer on {p} of {value} by {by}: got {got:?}, want {want:?}"),
        }
    }

    /// The bytes the next deposit writes with this depositor (vault.md 2.3: 756 B at a 64-byte depositor, so 53 fewer
    /// for `u.test.near`), and 74 more for each tree whose insert writes a new side node: the first insert, and each
    /// insert into a tree whose size is a power of two (src/tree.rs `insert`, the depth's growth).
    fn deposit_bytes(&self) -> u128 {
        let grows = |size: u64| size == 0 || size.is_power_of_two();
        756 - (64 - DEPOSITOR.len() as u128) + 74 * (grows(self.leaves.len() as u64) as u128 + grows(self.nonce) as u128)
    }

    /// I5 at the call: a refused call logged nothing and made no receipt, and wrote nothing before it refused, except
    /// the one refusal that comes after the writes (`InsufficientStorageDeposit`, which NEAR rolls back whole).
    fn refusal_moves_nothing<R>(&self, o: Outcome<R>, what: &str) -> Outcome<R> {
        if let Err(e) = &o.result {
            assert!(o.logs.is_empty(), "I5: {what} refused ({e}) and logged {:?}", o.logs);
            assert!(o.receipts.is_empty(), "I5: {what} refused ({e}) and made a receipt");
            if !e.contains("InsufficientStorageDeposit") {
                assert!(!o.wrote, "I5: {what} refused ({e}) after a write");
            }
        }
        o
    }

    fn withdraw_step(&mut self) -> String {
        let i = self.rng.below(self.fx.spends.len() as u64) as usize;
        let s = &self.fx.spends[i];
        let (mut w, proof, mut signals) = (s.withdrawal.clone(), s.proof.clone(), s.signals.clone());
        let bound = 100 + 15 + 30 + if s.register > 0 { 10 } else { 0 } + if s.fee > 0 { 15 } else { 0 };
        let (mut gas, mut attached) = (Gas::from_tgas(300), ONE_NEAR);
        let name = s.name.clone();
        // the vault's order: row 3, the gas pre-check, rows 5, 6 and 9 (for `amount`), the proof, row 11, row 12, row 14
        let roots_ok = |h: &Harness, s: &Spend, amount: u128| -> Result<(), &'static str> {
            if !h.state_had(s.size) {
                Err("UnknownStateRoot")
            } else if (h.nonce as usize) < s.size {
                Err("UnknownLabelRoot")
            } else if amount > h.held() {
                Err("InvalidPoolState")
            } else {
                Ok(())
            }
        };
        let after_proof = |h: &Harness, s: &Spend| -> Result<(), &'static str> {
            if h.landed.contains_key(&s.signals[1]) {
                Err("NullifierAlreadySpent")
            } else if h.change_leaves.contains(&s.signals[0]) {
                Err("LeafAlreadyExists")
            } else {
                Ok(())
            }
        };
        let (what, want, branch): (&str, Result<(), &str>, Option<Branch>) = match self.rng.below(12) {
            0 => {
                let r = self.rng.field();
                self.false_roots.push(r.clone());
                signals[3] = r;
                ("against a root the vault never had", Err("UnknownStateRoot"), Some(Branch::WithdrawUnknownRoot))
            }
            1 => {
                w.recipient = id(MALLORY);
                ("to another recipient than the proof's", Err("ContextMismatch"), Some(Branch::WithdrawContextMismatch))
            }
            2 => {
                signals[2] = (s.withdrawn + 1).to_string();
                ("of another amount than the proof's", roots_ok(self, s, s.withdrawn + 1).and(Err("InvalidProof")), None)
            }
            3 => {
                // row 9 (vault.md 2.5.2): over what the notes hold, refused before the proof is checked; no fixture proof
                // spends more than the notes hold, so only a changed amount reaches it (withdraw.rs's unit tests and
                // tests/withdraw_spend.rs pin it with "31000001")
                let over = self.held() + 1;
                signals[2] = over.to_string();
                ("of more than the notes hold", roots_ok(self, s, over).and(Err("InvalidProof")), None)
            }
            4 => {
                gas = Gas::from_tgas(bound - 1);
                ("one Tgas under the bound", Err("InsufficientGas"), Some(Branch::WithdrawShortGas))
            }
            5 => {
                attached = 0;
                let want = roots_ok(self, s, s.withdrawn).and_then(|_| after_proof(self, s)).and(Err("InsufficientStorageDeposit"));
                ("with no NEAR for its storage", want, None)
            }
            6 => {
                // the same notes' roots on another vault: both, or the label root alone under the real state root
                let (other_state, other_label) = self.fx.other_vault.clone();
                let both = self.rng.pct(50);
                if both {
                    signals[3] = other_state;
                }
                signals[5] = other_label;
                let want = if both || !self.state_had(s.size) { "UnknownStateRoot" } else { "UnknownLabelRoot" };
                ("against another vault's roots", Err(want), Some(Branch::WithdrawWrongScope))
            }
            _ => ("as proved", roots_ok(self, s, s.withdrawn).and_then(|_| after_proof(self, s)), None),
        };
        let o = self.call(PAYER, attached, gas, vec![], |v| v.withdraw(w, proof, signals));
        let o = self.refusal_moves_nothing(o, "withdraw");
        match (&o.result, want) {
            (Ok(()), Ok(())) => {}
            (Err(e), Err(want)) if e.contains(want) => {
                let by_ragequit = self.landed.get(&self.fx.spends[i].signals[1]).is_some_and(|j| self.exits[*j as usize].ragequit);
                let b = branch.unwrap_or_else(|| match want {
                    "UnknownStateRoot" | "UnknownLabelRoot" => Branch::WithdrawUnknownRoot,
                    "NullifierAlreadySpent" if by_ragequit => Branch::WithdrawAfterRagequit,
                    "NullifierAlreadySpent" => Branch::WithdrawDoubleSpend,
                    "InsufficientStorageDeposit" => Branch::WithdrawShortStorage,
                    "InvalidPoolState" => Branch::WithdrawOverHeld,
                    "InvalidProof" => Branch::WithdrawOtherAmount,
                    "LeafAlreadyExists" => Branch::WithdrawLeafExists,
                    other => panic!("withdraw {name} {what}: no branch for {other}"),
                });
                self.hit(b);
                return format!("withdraw {name} {what}: refused ({})", e.split(':').next().unwrap_or(""));
            }
            (got, want) => panic!("withdraw {name} {what}: got {got:?}, want {want:?}"),
        }
        // landed: I4 at the call, then its payout receipt as the token will run it (I3)
        let s = &self.fx.spends[i];
        assert!(self.state_had(s.size) && self.nonce as usize >= s.size, "I4: withdraw {name} landed on a root its trees never had");
        let exit = Exit {
            ragequit: false,
            name: name.clone(),
            nullifier_hash: s.signals[1].clone(),
            withdrawn: s.withdrawn,
            fee: s.fee,
            register: s.register,
            recipient: s.withdrawal.recipient.to_string(),
            fee_recipient: s.withdrawal.fee_recipient.to_string(),
            refund_precommitment: s.withdrawal.refund_precommitment.clone(),
            payer: PAYER.into(),
            context: s.signals[7].clone(),
            new_leaf_index: self.leaves.len() as u64,
        };
        let (register, fee) = (s.register, s.fee);
        let change = s.signals[0].clone();
        self.change_leaves.insert(change.clone());
        self.insert_leaf(Leaf::Other, change);
        let index = self.land(exit, &o.receipts);
        self.check_reserve(index, attached, o.usage, register, fee);
        self.hit(Branch::WithdrawLanded);
        format!("withdraw {name} {what}: landed as spend {index}")
    }

    /// A spend the vault wrote: the model's record of it, its payout receipt as the token will run it (I3), and the
    /// drop-spent mutant's deletion of its `spent` record.
    fn land(&mut self, exit: Exit, receipts: &[Receipt]) -> u64 {
        let index = self.spend_count;
        self.spend_count += 1;
        let pending = payout_of(receipts, &self.fx.vault, index, &exit);
        let nh = exit.nullifier_hash.clone();
        self.landed.insert(nh.clone(), index);
        self.spent += exit.withdrawn;
        self.exits.push(exit);
        self.status.push(Status::InFlight);
        self.pending.push(pending);
        if self.mutant == Mutant::DropSpent {
            let key: Vec<u8> = self
                .storage
                .keys()
                .find(|k| k.len() == 33 && k[1..] == be(&nh))
                .cloned()
                .expect("the spent record of the nullifier");
            self.storage.remove(&key);
            // the model forgets it too, as the planted vault does: its replay is predicted to land
            self.landed.remove(&nh);
            self.forgotten.insert(nh);
        }
        index
    }

    /// One of the fixture's ragequits, as signed or made hostile, predicted in the vault's order of checks (2.5.3): row 1
    /// (the refund precommitment, then the value), the gas pre-check, row 2 (the label's deposit names the caller), the
    /// proof, row 4 (the commitment a leaf), row 5 (the nullifier unspent), row 6 (storage, the last refusal).
    fn ragequit_step(&mut self) -> String {
        self.ragequit(None)
    }

    /// `ragequit_step`, or, with `on_label`, the hostile draw on that refund note's label (settle_step makes one after
    /// each refund note it writes: a draw of 1 in 14 among the few ragequits that came after a refund note never drew
    /// it on the fixed seed).
    fn ragequit(&mut self, on_label: Option<String>) -> String {
        // while one_block_a's change note is a leaf and its nullifier unspent, half the ragequits take its ragequit as
        // signed, so a run lands a change note's ragequit (an even draw of 1 in 8 after that withdrawal rarely did)
        let change = self.fx.ragequits.iter().position(|r| r.name == "one_block_a_change").expect("ragequit-spends.json's one_block_a_change");
        let ready = {
            let s = &self.fx.ragequits[change].signals;
            self.exp_leaves.contains(&s[SIGNAL_COMMITMENT]) && !self.landed.contains_key(&s[SIGNAL_NULLIFIER_HASH])
        };
        let targeted = on_label.is_none() && ready && self.rng.pct(50);
        let r = &self.fx.ragequits[if targeted { change } else { self.rng.below(self.fx.ragequits.len() as u64) as usize }];
        let (name, proof, mut signals, mut refund_pc) = (r.name.clone(), r.proof.clone(), r.signals.clone(), r.refund_precommitment.clone());
        let mut register: u128 = r.register.parse().unwrap();
        let mut by = r.depositor.clone();
        let (mut gas, mut attached) = (Gas::from_tgas(300), ONE_NEAR);
        let mut changed = false;
        let mut refund_label = false;
        let draw = match (&on_label, targeted) {
            (Some(_), _) => 8,
            (None, true) => 13,
            (None, false) => self.rng.below(14),
        };
        let what = match draw {
            0 => {
                by = MALLORY.into();
                "by a stranger"
            }
            1 => {
                by = if by == DEPOSITOR { self.fx.depositors[5].clone() } else { DEPOSITOR.into() };
                "by the other depositor"
            }
            2 => {
                let v: u128 = signals[SIGNAL_VALUE].parse().unwrap();
                signals[SIGNAL_VALUE] = (v + 1).to_string();
                changed = true;
                "of another value than the proof's"
            }
            3 => {
                signals[SIGNAL_NULLIFIER_HASH] = self.rng.field();
                changed = true;
                "on another nullifier hash than the proof's"
            }
            4 => {
                gas = Gas::from_tgas(ragequit_bound(register) - 1);
                "one Tgas under the bound"
            }
            5 => {
                attached = 0;
                "with no NEAR for its storage"
            }
            6 => {
                refund_pc = "0".into();
                "with a 0 refund precommitment"
            }
            7 => {
                // the caller's registration (no proof binds it); under the token's minimum its payout always fails
                register = if self.rng.pct(50) { REGISTER_MIN } else { REGISTER_MIN - 1 };
                "with a registration"
            }
            8 if on_label.is_some() || !self.refund_labels.is_empty() => {
                // a settled spend's refund label in the label signal: a refund note has no depositor, so row 2 refuses
                // it before the proof is checked
                signals[SIGNAL_LABEL] = match &on_label {
                    Some(l) => l.clone(),
                    None => self.refund_labels[self.rng.below(self.refund_labels.len() as u64) as usize].clone(),
                };
                changed = true;
                refund_label = true;
                "on a settled refund note's label"
            }
            9 | 10 => {
                gas = Gas::from_tgas(ragequit_bound(register));
                "at its gas bound"
            }
            _ => "as signed",
        };
        let value: u128 = signals[SIGNAL_VALUE].parse().unwrap();
        let (commitment, nh, label) = (signals[SIGNAL_COMMITMENT].clone(), signals[SIGNAL_NULLIFIER_HASH].clone(), signals[SIGNAL_LABEL].clone());
        // the nonce whose label this is, of any deposit or refund note so far (refund_note's is this vault's nonce 7,
        // which a plain deposit can take); a refund note's has no depositor
        let nonce = (1..=self.nonce).find(|n| dec(&self.label(*n)) == label);
        let named = nonce.and_then(|n| self.label_depositor.get(&n));
        let (want, branch): (Result<(), &str>, Branch) = if refund_pc == "0" {
            (Err("InvalidRefundPrecommitment"), Branch::RagequitZeroRefundPrecommitment)
        } else if value == 0 {
            (Err("InvalidWithdrawalAmount"), Branch::RagequitZeroValue)
        } else if gas < Gas::from_tgas(ragequit_bound(register)) {
            (Err("InsufficientGas"), Branch::RagequitShortGas)
        } else if named != Some(&by) {
            let b = match (nonce, named) {
                (None, _) => Branch::RagequitNotLanded,
                (Some(_), None) => Branch::RagequitRefundNoteLabel,
                _ if by == MALLORY => Branch::RagequitStranger,
                _ => Branch::RagequitOtherDepositor,
            };
            (Err("OnlyOriginalDepositor"), b)
        } else if changed {
            (Err("InvalidProof"), Branch::RagequitInvalidProof)
        } else if !self.exp_leaves.contains(&commitment) {
            (Err("InvalidCommitment"), Branch::RagequitNotInTree)
        } else if let Some(i) = self.landed.get(&nh) {
            (Err("NullifierAlreadySpent"), if self.exits[*i as usize].ragequit { Branch::RagequitReplayed } else { Branch::RagequitAfterWithdraw })
        } else if attached == 0 {
            (Err("InsufficientStorageDeposit"), Branch::RagequitShortStorage)
        } else {
            (Ok(()), Branch::RagequitLanded)
        };
        let (s2, rp, reg) = (signals.clone(), refund_pc.clone(), register.to_string());
        let o = self.call(&by, attached, gas, vec![], |v| v.ragequit(proof, s2, reg, rp));
        let o = self.refusal_moves_nothing(o, "ragequit");
        match (&o.result, want) {
            (Ok(()), Ok(())) => {}
            (Err(e), Err(w)) if e.contains(w) => {
                self.hit(branch);
                if refund_label && branch == Branch::RagequitRefundNoteLabel {
                    self.hit(Branch::RagequitSettledRefundLabel);
                }
                return format!("ragequit {name} {what} by {by}: refused ({w})");
            }
            (got, want) => panic!("ragequit {name} {what} by {by}: got {got:?}, want {want:?}"),
        }
        let exit = Exit {
            ragequit: true,
            name: format!("ragequit {name}"),
            nullifier_hash: nh,
            withdrawn: value,
            fee: 0,
            register,
            recipient: by.clone(),
            fee_recipient: by.clone(),
            refund_precommitment: refund_pc,
            payer: by.clone(),
            context: "0".into(),
            new_leaf_index: 0,
        };
        let index = self.land(exit, &o.receipts);
        self.check_reserve(index, attached, o.usage, register, 0);
        self.hit(Branch::RagequitLanded);
        if gas == Gas::from_tgas(ragequit_bound(register)) {
            self.hit(Branch::RagequitAtGasBound);
        }
        // a leaf of the label that is not its deposit's: a change note
        if !self.fx.leaves.contains(&commitment) {
            self.hit(Branch::RagequitChangeNote);
        }
        format!("ragequit {name} {what} by {by}: landed as spend {index}")
    }

    /// The token runs one pending payout receipt, part by part, then the vault's `on_payout` with the callback
    /// receipt's own arguments.
    fn resolve_step(&mut self) -> String {
        if self.pending.is_empty() {
            return self.withdraw_step();
        }
        let i = self.rng.below(self.pending.len() as u64) as usize;
        let p = self.pending.swap_remove(i);
        let vault = self.fx.vault.clone();
        let mut failed: Option<Branch> = None;
        // the part the token fails, when it fails one: the fee's transfer half the time when the receipt has one (only
        // two of the fixture's spends carry a fee, so an even draw left that branch at 0 on some seeds), else any part
        let fee_at = p.parts.iter().position(|x| matches!(x, Part::Fee { .. }));
        let fail_at = (self.mutant != Mutant::TokenNeverFails && self.rng.pct(FAIL_PCT)).then(|| match fee_at {
            Some(f) if self.rng.pct(50) => f,
            _ => self.rng.below(p.parts.len() as u64) as usize,
        });
        for (j, part) in p.parts.iter().enumerate() {
            let random = fail_at == Some(j);
            failed = match part {
                Part::Register { yocto } if random || *yocto < REGISTER_MIN => Some(Branch::PayoutStorageDepositFailed),
                Part::Recipient { .. } if random => Some(Branch::PayoutRecipientFailed),
                Part::Fee { .. } if random => Some(Branch::PayoutFeeFailed),
                _ => continue,
            };
            break;
        }
        if failed.is_none() {
            for part in &p.parts {
                if let Part::Recipient { to, amount } | Part::Fee { to, amount } = part {
                    self.token.sub(&vault, *amount);
                    self.token.add(to, *amount);
                    self.token.outflows.push((p.spend_index, to.clone(), *amount));
                }
            }
        }
        let told_ok = failed.is_none() || self.mutant == Mutant::Misread;
        let result = if told_ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed };
        let (index, to_recipient, fee) = (p.spend_index, p.to_recipient, p.fee);
        let o = self.call(&vault, 0, Gas::from_tgas(30), vec![result], |v| v.on_payout(index, U128(to_recipient), U128(fee)));
        if let Err(e) = &o.result {
            panic!("on_payout of spend {index}: {e}");
        }
        assert!(o.receipts.is_empty(), "I3: on_payout made a receipt");
        let (withdrawn, ragequit) = (self.exits[index as usize].withdrawn, self.exits[index as usize].ragequit);
        if failed.is_some() {
            self.returned += withdrawn;
        }
        self.status[index as usize] = if failed.is_some() { Status::RefundPending } else { Status::Paid };
        self.hit(failed.unwrap_or(Branch::PayoutDelivered));
        if ragequit && failed.is_none() {
            self.hit(Branch::RagequitPaid);
        }
        format!("payout of spend {index}: {:?}", failed.unwrap_or(Branch::PayoutDelivered))
    }

    /// `settle` of a spend the model picks, predicted from the model's own status of it (never from the vault's).
    fn settle_step(&mut self) -> String {
        let pick = (self.spend_count > 0 && !self.rng.pct(15)).then(|| self.rng.below(self.spend_count) as usize);
        let (nh, want): (String, Result<bool, &str>) = match pick {
            None if self.rng.pct(50) => (self.rng.field(), Err("UnknownSpend")),
            None => (format!("0{}", self.rng.below(1_000) + 1), Err("InvalidNumber")),
            Some(i) => {
                let nh = self.exits[i].nullifier_hash.clone();
                let want = if self.forgotten.contains(&nh) {
                    Err("UnknownSpend")
                } else {
                    match self.status[i] {
                        Status::InFlight => Err("SpendInFlight"),
                        Status::Settled => Err("AlreadySettled"),
                        Status::Paid => Ok(false),
                        Status::RefundPending => Ok(true),
                    }
                };
                (nh, want)
            }
        };
        let reserve_before = pick.map(|i| self.view(|v| v.spends(i as u64, 1))[0].reserve.0);
        let arg = nh.clone();
        let o = self.call(SETTLER, 0, Gas::from_tgas(100), vec![], |v| v.settle(arg));
        let o = self.refusal_moves_nothing(o, "settle");
        match (&o.result, want) {
            (Ok(()), Ok(refund)) => {
                let i = pick.unwrap();
                // settle sends NEAR only, never the token (I3); the caller attached nothing, so the payer (a ragequit's
                // depositor) gets exactly the reserve's rest, the reserve less the bytes settle wrote (counted from its
                // records), and the reserve is left at 0 (M7)
                let payer = self.exits[i].payer.clone();
                let mut sent = 0u128;
                for r in &o.receipts {
                    assert!(r.receiver_id.as_str() == payer, "settle (M7): a Transfer to {}, not the payer {payer}", r.receiver_id);
                    for a in &r.actions {
                        match a {
                            MockAction::Transfer { deposit, .. } => sent += deposit.as_yoctonear(),
                            other => panic!("I3: settle made {other:?}"),
                        }
                    }
                }
                let reserve_before = reserve_before.unwrap();
                let bytes = u128::try_from(o.usage).expect("settle only adds records");
                let rest = reserve_before.checked_sub(bytes * BYTE).expect("the reserve covers settle's bytes");
                assert!(
                    sent == rest,
                    "settle (M7): sent {sent} yocto to the payer {payer}, want the reserve's rest {rest} ({reserve_before} less {bytes} B written)"
                );
                let after = self.view(|v| v.spends(i as u64, 1))[0].reserve.0;
                assert!(after == 0, "settle (M7): the spend's reserve is {after} after its settle, want 0");
                self.status[i] = Status::Settled;
                if refund {
                    let s = &self.exits[i];
                    let (value, refund_pc, ragequit) = (s.withdrawn, s.refund_precommitment.clone(), s.ragequit);
                    self.nonce += 1;
                    let leaf = Self::commitment(value, &self.label(self.nonce), &refund_pc);
                    self.insert_leaf(Leaf::Other, leaf);
                    let refund_label = dec(&self.label(self.nonce));
                    self.refund_labels.push(refund_label.clone());
                    self.hit(Branch::SettleRefundNote);
                    if ragequit {
                        self.hit(Branch::SettleRagequitRefund);
                    }
                    // then a hostile ragequit on the new note's label (its own call, checked as any other)
                    let then = self.ragequit(Some(refund_label));
                    format!("settle of spend {i}'s refund of {value}: a refund note; then {then}")
                } else {
                    self.hit(Branch::SettlePaid);
                    format!("settle of the paid spend {i}")
                }
            }
            (Err(e), Err(w)) if e.contains(w) => {
                self.hit(match w {
                    "SpendInFlight" => Branch::SettleInFlight,
                    "AlreadySettled" => Branch::SettleAlreadySettled,
                    _ => Branch::SettleUnknown,
                });
                format!("hostile settle: {w}")
            }
            (got, want) => panic!("settle {nh}: got {got:?}, want {want:?}"),
        }
    }

    fn hostile_callback_step(&mut self) -> String {
        let vault = self.fx.vault.clone();
        let len = self.spend_count;
        let resolved: Vec<u64> = (0..len).filter(|i| self.status[*i as usize] != Status::InFlight).collect();
        let (what, index, results, want, branch) = match self.rng.below(3) {
            0 if !resolved.is_empty() => {
                let i = resolved[self.rng.below(resolved.len() as u64) as usize];
                ("a second callback", i, vec![PromiseResult::Failed], "SpendNotInFlight", Branch::CallbackSecond)
            }
            1 => (
                "two results",
                self.rng.below(len + 1),
                vec![PromiseResult::Failed, PromiseResult::Failed],
                "PayoutResults",
                Branch::CallbackTwoResults,
            ),
            _ => ("no such spend", len + self.rng.below(5), vec![PromiseResult::Failed], "UnknownSpend", Branch::CallbackUnknown),
        };
        let o = self.call(&vault, 0, Gas::from_tgas(30), results, |v| v.on_payout(index, U128(0), U128(0)));
        let o = self.refusal_moves_nothing(o, "on_payout");
        match &o.result {
            Err(e) if e.contains(want) => self.hit(branch),
            got => panic!("on_payout, {what}: got {got:?}, want {want}"),
        }
        format!("hostile callback: {what}")
    }

    fn stray_step(&mut self) -> String {
        let n = 1 + self.rng.below(5_000_000) as u128;
        let vault = self.fx.vault.clone();
        self.token.add(&vault, n);
        self.stray += n;
        self.hit(Branch::Stray);
        format!("a plain transfer of {n} into the vault")
    }

    // ---- the invariants (vault.md 3, l.1101-1105), each on the vault's own views and the token's balances ----

    /// I1: `ft_balance_of(vault) ≥ deposited − spent + returned`, equal when no payout is in flight and no stray money
    /// arrived; here exactly: the balance is the notes' value plus what is in flight plus the stray money.
    fn check_i1(&self, spends: &[SpendView]) -> Result<(), String> {
        let t = self.view(|v| v.totals());
        let (d, s, r) = (t.deposited.0, t.spent.0, t.returned.0);
        let notes = s.checked_sub(r).and_then(|out| d.checked_sub(out)).ok_or(format!("I1: totals {d} - ({s} - {r}) is negative"))?;
        let in_flight: u128 = spends.iter().filter(|x| x.status == Status::InFlight).map(|x| x.withdrawn.0).sum();
        let balance = self.token.balance(&self.fx.vault);
        if balance < notes {
            return Err(format!("I1: the vault holds {balance}, under the notes' {notes}"));
        }
        if balance != notes + in_flight + self.stray {
            return Err(format!(
                "I1: the vault holds {balance}, want the notes' {notes} + {in_flight} in flight + {} stray",
                self.stray
            ));
        }
        Ok(())
    }

    /// I2: a nullifier is spent at most once.
    fn check_i2(&self, spends: &[SpendView]) -> Result<(), String> {
        let mut seen = HashSet::new();
        for s in spends {
            if !seen.insert(&s.nullifier_hash) {
                return Err(format!("I2: nullifier hash {} spent twice", s.nullifier_hash));
            }
        }
        Ok(())
    }

    /// I3: the token leaves the vault only to an account a proof names: each transfer out is a paid spend's
    /// `(recipient, withdrawn - fee)` or `(fee_recipient, fee)` of the request its proof binds, and an account no proof
    /// names holds nothing.
    fn check_i3(&self, spends: &[SpendView]) -> Result<(), String> {
        for (index, to, amount) in &self.token.outflows {
            let row = spends.get(*index as usize).ok_or(format!("I3: a transfer for spend {index}, which does not exist"))?;
            if *index >= self.spend_count {
                return Err(format!("I3: a transfer for spend {index}, which the model has not"));
            }
            let s = &self.exits[*index as usize];
            if s.nullifier_hash != row.nullifier_hash {
                return Err(format!("I3: spend {index} is no proof's"));
            }
            let ok = (*to == s.recipient && *amount == s.withdrawn - s.fee) || (s.fee > 0 && *to == s.fee_recipient && *amount == s.fee);
            if !ok {
                return Err(format!("I3: {amount} to {to} for spend {index}, which its proof does not name"));
            }
        }
        if self.token.balance(MALLORY) != 0 {
            return Err(format!("I3: {MALLORY}, whom no proof names, holds {}", self.token.balance(MALLORY)));
        }
        Ok(())
    }

    /// I4: every accepted root was really a root of that tree: each root a proof names is known exactly when the
    /// model's tree had it, and no root drawn at random is known.
    fn check_i4(&self) -> Result<(), String> {
        for (size, state, label) in &self.fx.roots {
            let (k_state, k_label) = self.view(|v| (v.is_known_state_root(state.clone()), v.is_known_label_root(label.clone())));
            if k_state != self.state_had(*size) {
                return Err(format!("I4: the state root of {size} deposits known {k_state}, had {}", self.state_had(*size)));
            }
            if k_label != (self.nonce as usize >= *size) {
                return Err(format!("I4: the label root of {size} labels known {k_label}, with {} labels", self.nonce));
            }
        }
        // a root of one tree is never taken for the other's
        for (size, state, label) in &self.fx.roots {
            let (state_as_label, label_as_state) =
                self.view(|v| (v.is_known_label_root(state.clone()), v.is_known_state_root(label.clone())));
            if state_as_label || label_as_state {
                return Err(format!("I4: a root of {size} taken for the other tree's (state as label {state_as_label}, label as state {label_as_state})"));
            }
        }
        // the same notes' roots on another vault (another scope), and every random root, in neither tree
        let (other_state, other_label) = &self.fx.other_vault;
        for r in [other_state, other_label].into_iter().chain(&self.false_roots) {
            let (as_state, as_label) = self.view(|v| (v.is_known_state_root(r.clone()), v.is_known_label_root(r.clone())));
            if as_state || as_label {
                return Err(format!("I4: the root {r}, which neither tree had, is known (state {as_state}, label {as_label})"));
            }
        }
        Ok(())
    }

    /// I6: every unit a payout does not deliver becomes exactly one refund note, on the precommitment the proof bound:
    /// for each spend, delivered + refund_value = withdrawn; a refund is the spend's whole amount (one receipt, all or
    /// none), on the proof's refund precommitment; a settled refund is one leaf, Poseidon(value, label, precommitment),
    /// whose label is in the label tree; and the refunds add up to `totals.returned`.
    fn check_i6(&self, spends: &[SpendView]) -> Result<(), String> {
        let t = self.view(|v| v.totals());
        let (leaves, labels) = self.view(|v| (v.leaves(0, 1_000), v.labels(0, 1_000)));
        let mut refunds = 0u128;
        for (i, row) in spends.iter().enumerate() {
            if i as u64 >= self.spend_count {
                return Err(format!("I6: spend {i}, which the model has not"));
            }
            let s = &self.exits[i];
            if s.nullifier_hash != row.nullifier_hash {
                return Err(format!("I6: spend {i} is no proof's"));
            }
            // every row's status is the one its payout and its settle gave it: a settle that does not mark the spend
            // settled would make its refund note again
            if row.status != self.status[i] {
                return Err(format!("I6: spend {i} is {:?}, want {:?}", row.status, self.status[i]));
            }
            let delivered: u128 = self.token.outflows.iter().filter(|o| o.0 == i as u64).map(|o| o.2).sum();
            let refund = row.refund_value.0;
            refunds += refund;
            match row.status {
                Status::InFlight if delivered + refund != 0 => return Err(format!("I6: spend {i} in flight with {delivered} delivered, {refund} refunded")),
                Status::InFlight => continue,
                _ if delivered + refund != row.withdrawn.0 => {
                    return Err(format!("I6: spend {i}: {delivered} delivered + {refund} refunded, of {}", row.withdrawn.0))
                }
                Status::Paid if refund != 0 => return Err(format!("I6: spend {i} paid with a refund of {refund}")),
                Status::RefundPending if refund == 0 => return Err(format!("I6: spend {i} refund pending with nothing")),
                _ => {}
            }
            if refund == 0 {
                continue;
            }
            if row.refund_precommitment != s.refund_precommitment {
                return Err(format!("I6: spend {i}'s refund is not on the precommitment its proof bound"));
            }
            if row.status == Status::Settled {
                let leaf = dec(&PoseidonT4::new().hash(&amount_be(refund), &be(&row.refund_label), &be(&row.refund_precommitment)));
                let n = leaves.iter().filter(|l| **l == leaf).count();
                if n != 1 || leaves.get(row.refund_leaf_index as usize) != Some(&leaf) {
                    return Err(format!("I6: spend {i}'s refund note is {n} leaves, at {} not {leaf}", row.refund_leaf_index));
                }
                if !labels.contains(&row.refund_label) {
                    return Err(format!("I6: spend {i}'s refund label is not in the label tree"));
                }
            }
        }
        if refunds != t.returned.0 {
            return Err(format!("I6: the refunds add up to {refunds}, totals.returned is {}", t.returned.0));
        }
        Ok(())
    }

    /// The model's own counts against the vault's (after the invariants, so a broken invariant is named first).
    fn check_model(&self, spends: &[SpendView]) -> Result<(), String> {
        let t = self.view(|v| v.totals());
        let want = (self.deposited, self.spent, self.returned);
        if (t.deposited.0, t.spent.0, t.returned.0) != want {
            return Err(format!("model: totals {t:?}, want {want:?}"));
        }
        let (size, labels) = self.view(|v| (v.state_tree().size, v.label_tree().size));
        if (size, labels) != (self.leaves.len() as u64, self.nonce) {
            return Err(format!("model: trees of {size} leaves and {labels} labels, want {} and {}", self.leaves.len(), self.nonce));
        }
        if spends.len() as u64 != self.spend_count {
            return Err(format!("model: {} spends, want {}", spends.len(), self.spend_count));
        }
        // each record is its exit's: who paid, who is paid, the fee, the context (a withdrawal's proof's, a ragequit's
        // 0, which restore reads as a ragequit) and the change leaf's index (a ragequit's 0: it inserts none)
        for (row, e) in spends.iter().zip(&self.exits) {
            let got = (row.payer.as_str(), row.recipient.as_str(), row.fee.0, row.context.as_str(), row.new_leaf_index);
            if got != (e.payer.as_str(), e.recipient.as_str(), e.fee, e.context.as_str(), e.new_leaf_index) {
                return Err(format!("model: spend {} is {got:?}, want {}'s", row.index, e.name));
            }
        }
        // every leaf and label, in order: a deposit's Poseidon(value, label, precommitment) (the kit's for the
        // fixture's six), a change leaf as its proof's newCommitmentHash, a refund note's Poseidon(value, label,
        // refund precommitment); the labels label_of(scope, 1..=nonce), the first six the kit's
        let (leaves, labels) = self.view(|v| (v.leaves(0, 1_000), v.labels(0, 1_000)));
        if let Some(i) = (0..leaves.len().max(self.exp_leaves.len())).find(|i| leaves.get(*i) != self.exp_leaves.get(*i)) {
            return Err(format!("model: state leaf {i} is {:?}, want {:?}", leaves.get(i), self.exp_leaves.get(i)));
        }
        let want: Vec<String> = (1..=self.nonce).map(|n| dec(&self.label(n))).collect();
        if let Some(i) = (0..labels.len().max(want.len())).find(|i| labels.get(*i) != want.get(*i)) {
            return Err(format!("model: label {i} is {:?}, want {:?}", labels.get(i), want.get(i)));
        }
        if let Some(i) = (0..want.len().min(self.fx.labels.len())).find(|i| want[*i] != self.fx.labels[*i]) {
            return Err(format!("model: label {i} is not the kit's"));
        }
        Ok(())
    }

    fn check_all(&self) -> Result<(), String> {
        let spends = self.view(|v| v.spends(0, 1_000));
        self.check_i1(&spends)?;
        self.check_i2(&spends)?;
        self.check_i3(&spends)?;
        self.check_i4()?;
        self.check_i6(&spends)?;
        self.check_model(&spends)
    }
}

/// A ragequit's gas bound (2.5.3 row 1, 2.5.2's pre-check with no fee part): ft_transfer 15 + on_payout 30 + 100 Tgas,
/// and storage_deposit 10 with a registration.
fn ragequit_bound(register: u128) -> u64 {
    100 + 15 + 30 + if register > 0 { 10 } else { 0 }
}

/// The payout receipt `withdraw` or `ragequit` made for spend `index`, the exit `s`, checked part by part against the
/// request its proof binds, or a ragequit's depositor and note (I3): `[storage_deposit(recipient) with
/// register_deposit when > 0, ft_transfer(recipient, withdrawn - fee), ft_transfer(fee_recipient, fee) when fee > 0]` to
/// the token, then `on_payout(index)` on the vault.
fn payout_of(receipts: &[Receipt], vault: &str, index: u64, s: &Exit) -> Pending {
    assert_eq!(receipts.len(), 2, "I3: an exit makes the payout receipt and its callback");
    assert_eq!(receipts[0].receiver_id.as_str(), TOKEN, "I3: the payout goes to the token");
    assert_eq!(receipts[1].receiver_id.as_str(), vault, "the callback goes to the vault");
    // the callback depends on the payout receipt (promise_batch_then), so it runs after it and reads its result; a
    // callback made apart from it would run with no result to read
    assert!(receipts[0].receipt_indices.is_empty(), "the payout receipt waits on nothing: {:?}", receipts[0].receipt_indices);
    assert_eq!(receipts[1].receipt_indices, vec![0], "the callback of {} depends on the payout receipt", s.name);
    let mut want: Vec<(String, String, u128)> = Vec::new();
    if s.register > 0 {
        want.push(("storage_deposit".into(), format!(r#"{{"account_id":"{}","registration_only":true}}"#, s.recipient), s.register));
    }
    want.push(("ft_transfer".into(), format!(r#"{{"receiver_id":"{}","amount":"{}"}}"#, s.recipient, s.withdrawn - s.fee), 1));
    if s.fee > 0 {
        want.push(("ft_transfer".into(), format!(r#"{{"receiver_id":"{}","amount":"{}"}}"#, s.fee_recipient, s.fee), 1));
    }
    let got: Vec<(String, String, u128)> = receipts[0]
        .actions
        .iter()
        .map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } => (
                String::from_utf8(method_name.clone()).unwrap(),
                String::from_utf8(args.clone()).unwrap(),
                attached_deposit.as_yoctonear(),
            ),
            other => panic!("I3: the payout receipt holds {other:?}"),
        })
        .collect();
    assert_eq!(got, want, "I3: the payout of {} is not the request its proof binds", s.name);
    let (to_recipient, fee): (u128, u128) = match &receipts[1].actions[..] {
        [MockAction::FunctionCallWeight { method_name, args, .. }] => {
            assert_eq!(method_name, b"on_payout");
            let a: Value = serde_json::from_slice(args).unwrap();
            assert_eq!(a["spend_index"], index, "the callback names the spend");
            (a["to_recipient"].as_str().unwrap().parse().unwrap(), a["fee"].as_str().unwrap().parse().unwrap())
        }
        other => panic!("the callback receipt holds {other:?}"),
    };
    assert_eq!((to_recipient, fee), (s.withdrawn - s.fee, s.fee), "the callback's own arguments for {}", s.name);
    let mut out = Vec::new();
    if s.register > 0 {
        out.push(Part::Register { yocto: s.register });
    }
    out.push(Part::Recipient { to: s.recipient.clone(), amount: s.withdrawn - s.fee });
    if s.fee > 0 {
        out.push(Part::Fee { to: s.fee_recipient.clone(), amount: s.fee });
    }
    Pending { spend_index: index, parts: out, to_recipient, fee }
}

/// The run: `cases` fresh vaults of `STEPS` random steps each, every invariant checked after every step. Returns the
/// branch counts; panics with the seed, the case and the step on the first broken invariant or wrong prediction, and,
/// when `gate`, when a branch of `BRANCHES` was never hit.
fn run(seed: u64, cases: u64, mutant: Mutant, gate: bool) -> BTreeMap<Branch, u64> {
    let mut total: BTreeMap<Branch, u64> = BRANCHES.iter().map(|b| (*b, 0)).collect();
    // the scope the fixture's proofs and labels were made with
    let fx = fixture();
    assert_eq!(dec(&field::to_be(&label_of(&scope_for(&fx.vault, TOKEN), 1))), serde_json::from_str::<Value>(FIXTURE).unwrap()["labels"][0]);
    for case in 0..cases {
        let case_seed = Rng(seed ^ case.wrapping_mul(0x9e3779b97f4a7c15)).next();
        let mut h = Harness::new(case_seed, mutant);
        let mut log: Vec<String> = Vec::new();
        for step in 0..STEPS {
            let r = catch_unwind(AssertUnwindSafe(|| {
                let what = h.step();
                h.check_all().map(|_| what)
            }));
            let fail = match r {
                Ok(Ok(what)) => {
                    log.push(what);
                    continue;
                }
                Ok(Err(e)) => e,
                Err(e) => panic_text(e),
            };
            let tail = log.iter().rev().take(8).rev().cloned().collect::<Vec<_>>().join("\n  ");
            panic!(
                "VT-P02 FAILED: seed {seed:#x}, case {case} (case seed {case_seed:#x}), step {step}, mutant {mutant:?}: {fail}\n  the steps before:\n  {tail}\n  replay: P02_SEED={seed:#x} P02_CASES={}",
                case + 1
            );
        }
        for (b, n) in h.branches {
            *total.entry(b).or_default() += n;
        }
    }
    let never: Vec<String> = BRANCHES.iter().filter(|b| total[b] == 0).map(|b| format!("{b:?}")).collect();
    let counts = total.iter().map(|(b, n)| format!("{b:?} {n}")).collect::<Vec<_>>().join(", ");
    println!("VT-P02 seed {seed:#x}, {cases} cases x {STEPS} steps, mutant {mutant:?}: {counts}");
    assert!(!gate || never.is_empty(), "VT-P02 FAILED: seed {seed:#x}, {cases} cases: the run never drew {}; counts: {counts}", never.join(", "));
    total
}

/// The long run: 24 cases of 48 steps with the branch gate (402 s on the box on 2026-11-07 with card vault-final-sha's
/// draws, debug build; 424 s at card vault-property-p02-exits). A plain `cargo test` skips it; CI's
/// vault-sandbox job runs it in shard 1 (scripts/ci/vault-sandbox.mjs; tests/harness/run.sh passes
/// `--include-ignored`) on every pull request that touches the vault.
#[test]
#[ignore = "the long run (24 x 48, 402 s on the box): cargo test --test p02 -- --ignored; run.sh runs it"]
fn vt_p02_i1_to_i6_hold_after_every_step() {
    let counts = run(env_u64("P02_SEED", SEED), env_u64("P02_CASES", CASES), Mutant::from_env(), true);
    for b in [Branch::PayoutStorageDepositFailed, Branch::PayoutRecipientFailed, Branch::PayoutFeeFailed, Branch::SettleRefundNote] {
        assert!(counts[&b] > 0, "{b:?}");
    }
}

/// The smoke run on every plain `cargo test`: the long run's first cases, every invariant after every step, no gate
/// (too few cases to draw every branch).
#[test]
fn vt_p02_smoke_i1_to_i6_hold_on_the_first_cases() {
    run(SEED, SMOKE_CASES, Mutant::None, false);
}

fn red(mutant: Mutant, cases: u64, gate: bool) -> String {
    match catch_unwind(|| run(SEED, cases, mutant, gate)) {
        Ok(_) => panic!("the run passed with the {mutant:?} mutant planted"),
        Err(e) => panic_text(e),
    }
}

#[test]
fn vt_p02_a_failed_payout_read_as_delivered_breaks_i1() {
    let e = red(Mutant::Misread, CASES, true);
    assert!(e.contains("I1:"), "{e}");
}

#[test]
fn vt_p02_a_forgotten_nullifier_breaks_i2() {
    let e = red(Mutant::DropSpent, CASES, true);
    assert!(e.contains("I2:"), "{e}");
}

#[test]
fn vt_p02_a_token_that_never_fails_fails_the_branch_count() {
    // two cases: a token that never fails leaves both branches at 0 however many cases run
    let e = red(Mutant::TokenNeverFails, 2, true);
    assert!(e.contains("never drew") && e.contains("PayoutRecipientFailed") && e.contains("PayoutFeeFailed"), "{e}");
}
