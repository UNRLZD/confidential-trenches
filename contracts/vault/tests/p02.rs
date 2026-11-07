// SPDX-License-Identifier: Apache-2.0
//! VT-P02 (vault.md 5, l.1139 at research main): random sequences of prepay, deposit, withdraw, settle and hostile calls
//! on the vault's state code, with a mock token that fails each part of a payout at random; I1 to I6 (vault.md 3,
//! l.1101-1105) hold after every step.
//!
//! The vault runs here as its own Rust code in near-sdk's mocked chain (no wasm, no sandbox): each call gets a fresh
//! mocked context on the storage the last call left, and a refused call is rolled back as NEAR rolls back a failed
//! receipt (the contract struct and every record restored), after the harness has read what the refusal did.
//!
//! - The notes are tests/fixtures/withdraw-spends.json's six (made by make-withdraw-spends.mjs: the kit's input builder
//!   and snarkjs, real Groth16 proofs), so every withdrawal that lands passes the vault's real proof check. Their proofs
//!   name the state and label roots of the first 6 deposits (old_root: the first 4), so a withdrawal lands only once the
//!   vault's trees really had that root: the six deposits first, in order, before any other leaf. The generator puts
//!   them early most of the time; a case where another leaf comes first is a case of withdrawals against roots the
//!   vault never had, which I4 requires it to refuse.
//! - The mock token (`Token`) keeps every account's balance. `ft_transfer_call` moves the amount into the vault before
//!   `ft_on_transfer` and gives it back when the call refuses. A payout receipt runs its parts in order
//!   (`storage_deposit`, then `ft_transfer` to the recipient, then to the fee recipient); at random the token fails one
//!   of them, each part as likely as any other (and a registration below the token's 0.00125 NEAR always fails); a
//!   failed part fails the receipt, which moves nothing (one receipt: all or none), and the callback is told Failed.
//! - Payouts stay in flight across steps: a `Resolve` step runs one pending payout receipt and its `on_payout`, so
//!   several can be in flight while deposits, other withdrawals and settles run.
//! - Hostile steps: withdrawals against an unknown root, to another recipient than the proof's, of another amount, with
//!   too little gas or too little NEAR, and the same nullifier again; deposits from a caller that is not the token, under
//!   MIN_DEPOSIT, on a used precommitment or without a prepay; prepays on 0, on p, on a used precommitment, or short;
//!   settles of an unknown, in-flight or settled spend; a second callback, a callback with two results, a callback on
//!   no spend; plain transfers of the token into the vault (M8's stray money).
//!
//! Each named branch is counted (`Branch`); the run fails when any count is 0, so a run that never drew a failing part
//! of a payout cannot pass for a refund test. The seed and the case count are fixed (`SEED`, `CASES`); a failure names
//! the seed, the case and the step, and `P02_SEED`, `P02_CASES` and `P02_MUTANT` replay or plant.
//!
//! The mutants are the harness's only, never the vault's code: `misread` tells `on_payout` Successful when the token
//! failed (a vault that reads a failed payout as delivered), `drop-spent` deletes the `spent` record each withdrawal
//! writes (a vault that forgets a nullifier), `token-never-fails` keeps the token from ever failing a part. The tests
//! below show each one fails the run, with the invariant it breaks.
//!
//! Not here: `#[private]` and `#[payable]` are checked by the wasm export near-sdk generates, which this harness does
//! not run (VT-S04 and VT-S17 call `on_payout` from a stranger in near-sandbox); ragequit's proofs are not in this
//! fixture (VT-S09 and VT-S19 hold it).

use blindfill_vault::constants::{MIN_DEPOSIT, TOKEN};
use blindfill_vault::context::label_of;
use blindfill_vault::poseidon::PoseidonT4;
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
/// The fixed run: `P02_SEED` and `P02_CASES` replace them.
const SEED: u64 = 0x5602_0000_0000_0001;
const CASES: u64 = 24;
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

struct Fixture {
    vault: String,
    precommitments: Vec<String>,
    values: Vec<u128>,
    spends: Vec<Spend>,
    /// (size, state root, label root) for each size a proof names
    roots: Vec<(usize, String, String)>,
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
    Fixture {
        vault: f["vault"].as_str().unwrap().to_string(),
        precommitments: strs("precommitments"),
        values: strs("values").iter().map(|v| v.parse().unwrap()).collect(),
        spends,
        roots,
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
    WithdrawLanded,
    WithdrawUnknownRoot,
    WithdrawDoubleSpend,
    WithdrawContextMismatch,
    WithdrawOtherAmount,
    WithdrawShortGas,
    WithdrawShortStorage,
    PrepayLanded,
    PrepayRefused,
    SettleRefused,
    CallbackRefused,
    Stray,
}

const BRANCHES: [Branch; 20] = [
    Branch::PayoutDelivered,
    Branch::PayoutStorageDepositFailed,
    Branch::PayoutRecipientFailed,
    Branch::PayoutFeeFailed,
    Branch::SettleRefundNote,
    Branch::SettlePaid,
    Branch::DepositLanded,
    Branch::DepositRefused,
    Branch::WithdrawLanded,
    Branch::WithdrawUnknownRoot,
    Branch::WithdrawDoubleSpend,
    Branch::WithdrawContextMismatch,
    Branch::WithdrawOtherAmount,
    Branch::WithdrawShortGas,
    Branch::WithdrawShortStorage,
    Branch::PrepayLanded,
    Branch::PrepayRefused,
    Branch::SettleRefused,
    Branch::CallbackRefused,
    Branch::Stray,
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
    /// nullifier hash -> the fixture spend that landed on it
    landed: HashMap<String, usize>,
    /// spends the vault has written
    spend_count: u64,
    /// spend index -> the fixture spend it is (two fixture spends can share a nullifier, so never looked up by it)
    spend_fixture: Vec<usize>,
    pending: Vec<Pending>,
    stray: u128,
    deposited: u128,
    spent: u128,
    returned: u128,
    /// roots no tree ever had, drawn for hostile withdrawals
    false_roots: Vec<String>,
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

fn deposit_msg(p: &str) -> String {
    format!(r#"{{"precommitment":"{p}","depositor":"{DEPOSITOR}"}}"#)
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
            spend_fixture: Vec::new(),
            pending: Vec::new(),
            stray: 0,
            deposited: 0,
            spent: 0,
            returned: 0,
            false_roots: Vec::new(),
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
        match result {
            Ok(_) => self.storage = after,
            Err(_) => {
                wrote = near_sdk::borsh::to_vec(&self.vault).unwrap() != before || after != self.storage;
                self.vault = near_sdk::borsh::from_slice(&before).unwrap();
            }
        }
        Outcome { result, logs, receipts, wrote }
    }

    /// A read of the vault's views on the current records.
    fn view<R>(&self, f: impl FnOnce(&Vault) -> R) -> R {
        self.install(SETTLER, 0, Gas::from_tgas(300), vec![]);
        f(&self.vault)
    }

    fn state_had(&self, size: usize) -> bool {
        self.fixture_prefix >= size
    }

    fn insert_leaf(&mut self, leaf: Leaf) {
        if leaf == Leaf::Fixture(self.fixture_prefix) && self.leaves.len() == self.fixture_prefix {
            self.fixture_prefix += 1;
        }
        self.leaves.push(leaf);
    }

    fn held(&self) -> u128 {
        self.deposited - (self.spent - self.returned)
    }

    // ---- the steps ----

    fn step(&mut self) -> String {
        let fixture_left = self.next_fixture < self.fx.values.len();
        let r = self.rng.below(100);
        match r {
            0..=39 if fixture_left => self.fixture_deposit_step(),
            70..=77 if fixture_left && self.rng.pct(75) => self.fixture_deposit_step(),
            0..=45 => self.withdraw_step(),
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
        let value = self.fx.values[k];
        let landed = self.deposit(TOKEN, &p, value);
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

    /// The token's `ft_transfer_call(vault, value, msg)` by the depositor, or a direct call by `by` when it is not the
    /// token. Returns whether the deposit landed; checks the model's prediction.
    fn deposit(&mut self, by: &str, p: &str, value: u128) -> bool {
        let want: Result<(), &str> = if by != TOKEN {
            Err("NotTheToken")
        } else if self.used.contains(p) {
            Err("PrecommitmentAlreadyUsed")
        } else if value < MIN_DEPOSIT {
            Err("MinimumDepositAmount")
        } else if !self.prepaid.contains_key(p) {
            Err("NoPrepay")
        } else {
            Ok(())
        };
        let from_token = by == TOKEN;
        if from_token {
            // the token moves the depositor's amount into the vault before it calls the receiver
            self.token.add(&self.fx.vault.clone(), value);
        }
        let msg = deposit_msg(p);
        let o = self.call(by, 0, Gas::from_tgas(100), vec![], |v| v.ft_on_transfer(id(DEPOSITOR), U128(value), msg));
        let o = self.refusal_moves_nothing(o, "ft_on_transfer");
        assert!(o.receipts.is_empty(), "I3: ft_on_transfer made a receipt");
        match (&o.result, want) {
            (Ok(U128(0)), Ok(())) => {
                self.prepaid.remove(p);
                self.used.insert(p.to_string());
                self.nonce += 1;
                let k = self.fx.precommitments.iter().position(|x| x == p);
                // fixture deposit k's commitment is the fixture's leaf only under its own label, nonce k + 1
                let leaf = match k {
                    Some(k) if self.nonce == k as u64 + 1 && self.fx.values[k] == value => Leaf::Fixture(k),
                    _ => Leaf::Other,
                };
                self.insert_leaf(leaf);
                self.deposited += value;
                self.hit(Branch::DepositLanded);
                true
            }
            (Err(e), Err(w)) if e.contains(w) => {
                if from_token {
                    // the token's resolve gives the whole amount back
                    self.token.sub(&self.fx.vault.clone(), value);
                }
                self.hit(Branch::DepositRefused);
                false
            }
            (got, want) => panic!("ft_on_transfer on {p} of {value} by {by}: got {got:?}, want {want:?}"),
        }
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
        let bound = 100
            + 15
            + 30
            + if s.register > 0 { 10 } else { 0 }
            + if s.fee > 0 { 15 } else { 0 };
        let (mut gas, mut attached) = (Gas::from_tgas(300), ONE_NEAR);
        let name = s.name.clone();
        // the vault's order: row 3, the gas pre-check, rows 5, 6, 9, the proof, row 11, row 12, row 14
        let roots_ok = |h: &Harness, s: &Spend| -> Result<(), &'static str> {
            if !h.state_had(s.size) {
                Err("UnknownStateRoot")
            } else if (h.nonce as usize) < s.size {
                Err("UnknownLabelRoot")
            } else if s.withdrawn > h.held() {
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
        let mutation = self.rng.below(10);
        let (what, want, branch): (&str, Result<(), &str>, Option<Branch>) = match mutation {
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
                ("of another amount than the proof's", Err(""), Some(Branch::WithdrawOtherAmount))
            }
            3 => {
                gas = Gas::from_tgas(bound - 1);
                ("one Tgas under the bound", Err("InsufficientGas"), Some(Branch::WithdrawShortGas))
            }
            4 => {
                attached = 0;
                let want = roots_ok(self, s).and_then(|_| after_proof(self, s)).and(Err("InsufficientStorageDeposit"));
                ("with no NEAR for its storage", want, None)
            }
            _ => ("as proved", roots_ok(self, s).and_then(|_| after_proof(self, s)), None),
        };
        let o = self.call(PAYER, attached, gas, vec![], |v| v.withdraw(w, proof, signals));
        let o = self.refusal_moves_nothing(o, "withdraw");
        match (&o.result, want) {
            (Ok(()), Ok(())) => {}
            (Err(e), Err(want)) if e.contains(want) => {
                let b = branch.unwrap_or(match want {
                    "UnknownStateRoot" | "UnknownLabelRoot" => Branch::WithdrawUnknownRoot,
                    "NullifierAlreadySpent" => Branch::WithdrawDoubleSpend,
                    "InsufficientStorageDeposit" => Branch::WithdrawShortStorage,
                    _ => Branch::WithdrawOtherAmount,
                });
                self.hit(b);
                return format!("withdraw {name} {what}: refused ({})", e.split(':').next().unwrap_or(""));
            }
            (got, want) => panic!("withdraw {name} {what}: got {got:?}, want {want:?}"),
        }
        // landed: I4 at the call, then its payout receipt as the token will run it (I3)
        let s = &self.fx.spends[i];
        assert!(self.state_had(s.size) && self.nonce as usize >= s.size, "I4: withdraw {name} landed on a root its trees never had");
        let index = self.spend_count;
        self.spend_count += 1;
        let pending = payout_of(&o.receipts, &self.fx.vault, index, s);
        let (nh, change, withdrawn) = (s.signals[1].clone(), s.signals[0].clone(), s.withdrawn);
        self.landed.insert(nh.clone(), i);
        self.spend_fixture.push(i);
        self.change_leaves.insert(change);
        self.insert_leaf(Leaf::Other);
        self.spent += withdrawn;
        self.pending.push(pending);
        self.hit(Branch::WithdrawLanded);
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
        }
        format!("withdraw {name} {what}: landed as spend {index}")
    }

    /// The token runs one pending payout receipt, part by part, then the vault's `on_payout`.
    fn resolve_step(&mut self) -> String {
        if self.pending.is_empty() {
            return self.withdraw_step();
        }
        let i = self.rng.below(self.pending.len() as u64) as usize;
        let p = self.pending.swap_remove(i);
        let vault = self.fx.vault.clone();
        let mut failed: Option<Branch> = None;
        // the part the token fails, when it fails one: each part of the receipt as likely as any other
        let fail_at = (self.mutant != Mutant::TokenNeverFails && self.rng.pct(FAIL_PCT)).then(|| self.rng.below(p.parts.len() as u64) as usize);
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
        let index = p.spend_index;
        let o = self.call(&vault, 0, Gas::from_tgas(30), vec![result], |v| v.on_payout(index, U128(0), U128(0)));
        if let Err(e) = &o.result {
            panic!("on_payout of spend {index}: {e}");
        }
        assert!(o.receipts.is_empty(), "I3: on_payout made a receipt");
        let withdrawn = self.fx.spends[self.spend_of(index)].withdrawn;
        if failed.is_some() {
            self.returned += withdrawn;
        }
        self.hit(failed.unwrap_or(Branch::PayoutDelivered));
        format!("payout of spend {index}: {:?}", failed.unwrap_or(Branch::PayoutDelivered))
    }

    /// The fixture spend that landed as spend `index`.
    fn spend_of(&self, index: u64) -> usize {
        self.spend_fixture[index as usize]
    }

    fn settle_step(&mut self) -> String {
        let spends = self.view(|v| v.spends(0, 1_000));
        let (nh, want): (String, Result<Option<(u128, String)>, &str>) = if spends.is_empty() || self.rng.pct(15) {
            match self.rng.below(2) {
                0 => (self.rng.field(), Err("UnknownSpend")),
                _ => (format!("0{}", self.rng.below(1_000) + 1), Err("InvalidNumber")),
            }
        } else {
            let s = &spends[self.rng.below(spends.len() as u64) as usize];
            let want = match s.status {
                Status::InFlight => Err("SpendInFlight"),
                Status::Settled => Err("AlreadySettled"),
                Status::Paid => Ok(None),
                Status::RefundPending => Ok(Some((s.refund_value.0, s.refund_precommitment.clone()))),
            };
            (s.nullifier_hash.clone(), want)
        };
        let arg = nh.clone();
        let o = self.call(SETTLER, 0, Gas::from_tgas(100), vec![], |v| v.settle(arg));
        let o = self.refusal_moves_nothing(o, "settle");
        // settle sends NEAR only, never the token (I3)
        for r in &o.receipts {
            assert!(r.receiver_id.as_str() != TOKEN, "I3: settle made a receipt to the token");
            assert!(r.actions.iter().all(|a| matches!(a, MockAction::Transfer { .. })), "I3: settle made a call");
        }
        match (&o.result, want) {
            (Ok(()), Ok(None)) => {
                self.hit(Branch::SettlePaid);
                format!("settle of a paid spend {}", &nh[..8])
            }
            (Ok(()), Ok(Some((value, _)))) => {
                self.nonce += 1;
                self.insert_leaf(Leaf::Other);
                self.hit(Branch::SettleRefundNote);
                format!("settle of a refund of {value}: a refund note")
            }
            (Err(e), Err(w)) if e.contains(w) => {
                self.hit(Branch::SettleRefused);
                format!("hostile settle: {w}")
            }
            (got, want) => panic!("settle {nh}: got {got:?}, want {want:?}"),
        }
    }

    fn hostile_callback_step(&mut self) -> String {
        let vault = self.fx.vault.clone();
        let len = self.view(|v| v.spends(0, 1_000)).len() as u64;
        let resolved: Vec<u64> = (0..len).filter(|i| !self.pending.iter().any(|p| p.spend_index == *i)).collect();
        let (what, index, results, want) = match self.rng.below(3) {
            0 if !resolved.is_empty() => {
                let i = resolved[self.rng.below(resolved.len() as u64) as usize];
                ("a second callback", i, vec![PromiseResult::Failed], "SpendNotInFlight")
            }
            1 => ("two results", self.rng.below(len + 1), vec![PromiseResult::Failed, PromiseResult::Failed], "PayoutResults"),
            _ => ("no such spend", len + self.rng.below(5), vec![PromiseResult::Failed], "UnknownSpend"),
        };
        let o = self.call(&vault, 0, Gas::from_tgas(30), results, |v| v.on_payout(index, U128(0), U128(0)));
        let o = self.refusal_moves_nothing(o, "on_payout");
        match &o.result {
            Err(e) if e.contains(want) => self.hit(Branch::CallbackRefused),
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
            let s = &self.fx.spends[self.spend_of(*index)];
            if s.signals[1] != row.nullifier_hash {
                return Err(format!("I3: spend {index} is no proof's"));
            }
            let w = &s.withdrawal;
            let ok = (to == w.recipient.as_str() && *amount == s.withdrawn - s.fee) || (to == w.fee_recipient.as_str() && *amount == s.fee);
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
        for r in &self.false_roots {
            if self.view(|v| v.is_known_state_root(r.clone())) {
                return Err(format!("I4: the random root {r} is known"));
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
            let s = &self.fx.spends[self.spend_of(i as u64)];
            if s.signals[1] != row.nullifier_hash {
                return Err(format!("I6: spend {i} is no proof's"));
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
            if row.refund_precommitment != s.withdrawal.refund_precommitment {
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

/// The payout receipt `withdraw` made for spend `index` of fixture spend `s`, checked part by part against the request
/// its proof binds (I3): `[storage_deposit(recipient) with register_deposit when > 0, ft_transfer(recipient,
/// withdrawn - fee), ft_transfer(fee_recipient, fee) when fee > 0]` to the token, then `on_payout(index)` on the vault.
fn payout_of(receipts: &[Receipt], vault: &str, index: u64, s: &Spend) -> Pending {
    assert_eq!(receipts.len(), 2, "I3: a withdrawal makes the payout receipt and its callback");
    assert_eq!(receipts[0].receiver_id.as_str(), TOKEN, "I3: the payout goes to the token");
    assert_eq!(receipts[1].receiver_id.as_str(), vault, "the callback goes to the vault");
    let w = &s.withdrawal;
    let mut want: Vec<(String, String, u128)> = Vec::new();
    if s.register > 0 {
        want.push(("storage_deposit".into(), format!(r#"{{"account_id":"{}","registration_only":true}}"#, w.recipient), s.register));
    }
    want.push(("ft_transfer".into(), format!(r#"{{"receiver_id":"{}","amount":"{}"}}"#, w.recipient, s.withdrawn - s.fee), 1));
    if s.fee > 0 {
        want.push(("ft_transfer".into(), format!(r#"{{"receiver_id":"{}","amount":"{}"}}"#, w.fee_recipient, s.fee), 1));
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
    match &receipts[1].actions[..] {
        [MockAction::FunctionCallWeight { method_name, args, .. }] => {
            assert_eq!(method_name, b"on_payout");
            let a: Value = serde_json::from_slice(args).unwrap();
            assert_eq!(a["spend_index"], index, "the callback names the spend");
        }
        other => panic!("the callback receipt holds {other:?}"),
    }
    let mut out = Vec::new();
    if s.register > 0 {
        out.push(Part::Register { yocto: s.register });
    }
    out.push(Part::Recipient { to: w.recipient.to_string(), amount: s.withdrawn - s.fee });
    if s.fee > 0 {
        out.push(Part::Fee { to: w.fee_recipient.to_string(), amount: s.fee });
    }
    Pending { spend_index: index, parts: out }
}

/// The run: `cases` fresh vaults of `STEPS` random steps each, every invariant checked after every step. Returns the
/// branch counts; panics with the seed, the case and the step on the first broken invariant or wrong prediction, and
/// when a branch was never hit.
fn run(seed: u64, cases: u64, mutant: Mutant) -> BTreeMap<Branch, u64> {
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
            *total.get_mut(&b).unwrap() += n;
        }
    }
    let never: Vec<String> = total.iter().filter(|(_, n)| **n == 0).map(|(b, _)| format!("{b:?}")).collect();
    let counts = total.iter().map(|(b, n)| format!("{b:?} {n}")).collect::<Vec<_>>().join(", ");
    println!("VT-P02 seed {seed:#x}, {cases} cases x {STEPS} steps, mutant {mutant:?}: {counts}");
    assert!(never.is_empty(), "VT-P02 FAILED: seed {seed:#x}, {cases} cases: the run never drew {}; counts: {counts}", never.join(", "));
    total
}

#[test]
fn vt_p02_i1_to_i6_hold_after_every_step() {
    let counts = run(env_u64("P02_SEED", SEED), env_u64("P02_CASES", CASES), Mutant::from_env());
    for b in [Branch::PayoutStorageDepositFailed, Branch::PayoutRecipientFailed, Branch::PayoutFeeFailed, Branch::SettleRefundNote] {
        assert!(counts[&b] > 0, "{b:?}");
    }
}

fn red(mutant: Mutant, cases: u64) -> String {
    match catch_unwind(|| run(SEED, cases, mutant)) {
        Ok(_) => panic!("the run passed with the {mutant:?} mutant planted"),
        Err(e) => panic_text(e),
    }
}

#[test]
fn vt_p02_a_failed_payout_read_as_delivered_breaks_i1() {
    let e = red(Mutant::Misread, CASES);
    assert!(e.contains("I1:"), "{e}");
}

#[test]
fn vt_p02_a_forgotten_nullifier_breaks_i2() {
    let e = red(Mutant::DropSpent, CASES);
    assert!(e.contains("I2:"), "{e}");
}

#[test]
fn vt_p02_a_token_that_never_fails_fails_the_branch_count() {
    let e = red(Mutant::TokenNeverFails, 8);
    assert!(e.contains("never drew") && e.contains("PayoutRecipientFailed") && e.contains("PayoutFeeFailed"), "{e}");
}
