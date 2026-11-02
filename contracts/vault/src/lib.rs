// SPDX-License-Identifier: Apache-2.0
//! The Blindfill vault, skeleton (vault.md V1.1, first part): constants, state layout, `scope`, the 2.5.6 views and
//! the read-only `config()`.
//!
//! No access key, no owner, no upgrade path, no pause, no setter, and no `new` or init method: the state starts from
//! its `Default` the first time a method writes (vault.md 2.5.7). The deploy batch's one call is `config()`, which only
//! reads (vault.md 2.8).
//!
//! State layout ported from Privacy Pools v1.3.0 `packages/contracts/src/contracts/State.sol` (nonce, the state tree,
//! nullifierHashes, depositors) and `Entrypoint.sol` (usedPrecommitments), Copyright 2025 0XBOW LTD, Apache-2.0, and
//! zk-kit's LeanIMT (`InternalLeanIMT.sol`, MIT). Deviations (vault.md 2.7): no Entrypoint or admin, no ASP postman
//! (the vault fills its own label tree), NEAR storage, and the relayer fee as an absolute amount.

pub mod constants;
pub mod context;
pub mod deposit;
pub mod events;
pub mod field;
pub mod payout;
pub mod poseidon;
pub mod prepay;
pub mod promise;
pub mod ragequit;
pub mod settle;
pub mod tree;
pub mod verifier;
pub mod verifier_keys;
pub mod withdraw;

use constants::*;
use near_sdk::collections::{LookupMap, Vector};
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, BorshStorageKey};
pub use tree::Tree;

/// A field element as 32 big-endian bytes.
pub type Bytes32 = [u8; 32];

/// One-byte collection prefixes (vault.md 2.3 counts a 1-byte prefix per record key).
#[near]
#[derive(BorshStorageKey)]
enum Key {
    StateSideNodes,
    StateLeafAt,
    StateLeafIndex,
    LabelSideNodes,
    LabelAt,
    StateRoots,
    LabelRoots,
    Spent,
    Spends,
    Precommitments,
    Deposits,
    LabelIndex,
    Prepaid,
}

/// A spend's state (vault.md 2.5.2 row 11, 2.5.4, 2.5.5).
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    InFlight,
    RefundPending,
    Paid,
    Settled,
}

/// `deposits`: deposit index -> the deposit (PP `depositors` plus the `Deposited` event's fields).
#[near]
#[derive(Clone)]
pub struct Deposit {
    pub precommitment: Bytes32,
    pub label: Bytes32,
    pub value: u128,
    pub leaf_index: u64,
    pub depositor: AccountId,
}

/// `spends`: spend index -> the spend, every field present from the start so later changes overwrite the same size.
#[near]
#[derive(Clone)]
pub struct Spend {
    pub nullifier_hash: Bytes32,
    pub withdrawn: u128,
    pub new_leaf_index: u64,
    pub refund_precommitment: Bytes32,
    pub refund_value: u128,
    pub refund_label: Bytes32,
    pub refund_leaf_index: u64,
    pub status: Status,
    pub payer: AccountId,
    pub reserve: u128,
    pub recipient: AccountId,
    pub fee: u128,
    pub context: Bytes32,
}

/// `totals`: what Verify compares with the token balance.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct Totals {
    pub deposited: U128,
    pub spent: U128,
    pub returned: U128,
}

/// The vault's state (vault.md 2.3). A fixed size: every collection writes its records at once.
#[near(contract_state)]
pub struct Vault {
    nonce: u64,
    state_tree: Tree,
    /// leaf -> index, for the state tree only (a label hashes a fresh nonce and cannot repeat)
    state_leaf_index: LookupMap<Bytes32, u64>,
    label_tree: Tree,
    spent: LookupMap<Bytes32, u64>,
    /// append-only: a push writes the row and its count together (key: prefix, then the index as 8 LE bytes)
    spends: Vector<Spend>,
    precommitments: LookupMap<Bytes32, u64>,
    /// append-only, as `spends`
    deposits: Vector<Deposit>,
    label_index: LookupMap<Bytes32, u64>,
    prepaid: LookupMap<Bytes32, u128>,
    totals: Totals,
}

impl Default for Vault {
    fn default() -> Self {
        Self {
            nonce: 0,
            state_tree: Tree::new(Key::StateSideNodes, Key::StateLeafAt, Key::StateRoots),
            state_leaf_index: LookupMap::new(Key::StateLeafIndex),
            label_tree: Tree::new(Key::LabelSideNodes, Key::LabelAt, Key::LabelRoots),
            spent: LookupMap::new(Key::Spent),
            spends: Vector::new(Key::Spends),
            precommitments: LookupMap::new(Key::Precommitments),
            deposits: Vector::new(Key::Deposits),
            label_index: LookupMap::new(Key::LabelIndex),
            prepaid: LookupMap::new(Key::Prepaid),
            totals: Totals::default(),
        }
    }
}

/// `scope = keccak256(borsh((SCOPE_TAG, vault, token))) mod p` (vault.md 2.2), in `context`.
pub use context::scope_for;

/// This vault's scope, computed in each call that needs it (no init stores it).
pub fn scope() -> field::U256 {
    scope_for(env::current_account_id().as_str(), TOKEN)
}

fn dec(b: &Bytes32) -> String {
    field::to_decimal(&field::from_be(b))
}

/// A root argument: a canonical decimal field element, or a panic naming the argument.
fn root_arg(root: &str) -> Bytes32 {
    match field::from_decimal(root) {
        Some(n) => field::to_be(&n),
        None => env::panic_str("InvalidRoot: want a canonical decimal below p"),
    }
}

/// The rows `from..from+limit` of a list of `len`, `limit` capped at PAGE_MAX.
fn page(from: u64, limit: u64, len: u64) -> core::ops::Range<u64> {
    let start = from.min(len);
    start..start.saturating_add(limit.min(PAGE_MAX)).min(len)
}

#[near(serializers = [json])]
pub struct Config {
    pub version: String,
    /// TOKEN, the one token this vault pools (PP's `ASSET`, the kit's `asset`)
    pub asset: AccountId,
    /// decimal
    pub scope: String,
    pub max_tree_depth: u8,
    pub min_deposit: U128,
    pub max_relay_fee_bps: u16,
    pub page_max: u64,
    pub intents: AccountId,
    pub gas_ft_transfer_tgas: u64,
    pub gas_storage_deposit_tgas: u64,
    pub gas_on_payout_tgas: u64,
    pub deposit_storage_bytes: u64,
    pub refund_reserve_bytes: u64,
}

#[near(serializers = [json])]
pub struct TreeView {
    pub size: u64,
    pub depth: u8,
    /// decimal
    pub root: String,
}

#[near(serializers = [json])]
pub struct DepositView {
    pub index: u64,
    pub precommitment: String,
    pub label: String,
    pub value: U128,
    pub leaf_index: u64,
    pub depositor: AccountId,
}

#[near(serializers = [json])]
pub struct SpendView {
    pub index: u64,
    pub nullifier_hash: String,
    pub withdrawn: U128,
    pub new_leaf_index: u64,
    pub refund_precommitment: String,
    pub refund_value: U128,
    pub refund_label: String,
    pub refund_leaf_index: u64,
    pub status: Status,
    pub payer: AccountId,
    pub reserve: U128,
    pub recipient: AccountId,
    pub fee: U128,
    pub context: String,
}

fn tree_view(t: &Tree) -> TreeView {
    TreeView { size: t.size, depth: t.depth, root: dec(&t.root()) }
}

fn tree_page(t: &Tree, from: u64, limit: u64) -> Vec<String> {
    page(from, limit, t.size).map(|i| dec(&t.leaf_at(i).expect("leaf_at holds every index below size"))).collect()
}

/// The views of vault.md 2.5.6 and `config()`. None looks up one secret-derived value (a precommitment, a nullifier
/// hash or a prepaid record): every list is paged whole and matched on the device. Roots are public.
#[near]
impl Vault {
    /// The token (`asset`), the scope, every constant and the build's version.
    pub fn config(&self) -> Config {
        Config {
            version: format!("blindfill-vault {} {}", env!("CARGO_PKG_VERSION"), NETWORK),
            asset: TOKEN.parse().unwrap(),
            scope: field::to_decimal(&scope()),
            max_tree_depth: MAX_TREE_DEPTH,
            min_deposit: U128(MIN_DEPOSIT),
            max_relay_fee_bps: MAX_RELAY_FEE_BPS,
            page_max: PAGE_MAX,
            intents: INTENTS.parse().unwrap(),
            gas_ft_transfer_tgas: GAS_FT_TRANSFER_TGAS,
            gas_storage_deposit_tgas: GAS_STORAGE_DEPOSIT_TGAS,
            gas_on_payout_tgas: GAS_ON_PAYOUT_TGAS,
            deposit_storage_bytes: DEPOSIT_STORAGE_BYTES,
            refund_reserve_bytes: REFUND_RESERVE_BYTES,
        }
    }

    pub fn state_tree(&self) -> TreeView {
        tree_view(&self.state_tree)
    }

    pub fn label_tree(&self) -> TreeView {
        tree_view(&self.label_tree)
    }

    /// State-tree leaves `from..from+limit` (limit capped at PAGE_MAX), as decimals.
    pub fn leaves(&self, from: u64, limit: u64) -> Vec<String> {
        tree_page(&self.state_tree, from, limit)
    }

    /// Label-tree labels `from..from+limit` (limit capped at PAGE_MAX), as decimals.
    pub fn labels(&self, from: u64, limit: u64) -> Vec<String> {
        tree_page(&self.label_tree, from, limit)
    }

    pub fn deposits(&self, from: u64, limit: u64) -> Vec<DepositView> {
        page(from, limit, self.deposits.len())
            .map(|i| {
                let d = self.deposits.get(i).expect("deposits holds every index below its length");
                DepositView {
                    index: i,
                    precommitment: dec(&d.precommitment),
                    label: dec(&d.label),
                    value: U128(d.value),
                    leaf_index: d.leaf_index,
                    depositor: d.depositor,
                }
            })
            .collect()
    }

    /// Every spend with its request data and its refund note's fields.
    pub fn spends(&self, from: u64, limit: u64) -> Vec<SpendView> {
        page(from, limit, self.spends.len())
            .map(|i| {
                let s = self.spends.get(i).expect("spends holds every index below its length");
                SpendView {
                    index: i,
                    nullifier_hash: dec(&s.nullifier_hash),
                    withdrawn: U128(s.withdrawn),
                    new_leaf_index: s.new_leaf_index,
                    refund_precommitment: dec(&s.refund_precommitment),
                    refund_value: U128(s.refund_value),
                    refund_label: dec(&s.refund_label),
                    refund_leaf_index: s.refund_leaf_index,
                    status: s.status,
                    payer: s.payer,
                    reserve: U128(s.reserve),
                    recipient: s.recipient,
                    fee: U128(s.fee),
                    context: dec(&s.context),
                }
            })
            .collect()
    }

    /// Any root the state tree has ever had (vault.md 2.4).
    pub fn is_known_state_root(&self, root: String) -> bool {
        self.state_tree.is_known_root(&root_arg(&root))
    }

    /// Any root the label tree has ever had (vault.md 2.4).
    pub fn is_known_label_root(&self, root: String) -> bool {
        self.label_tree.is_known_root(&root_arg(&root))
    }

    pub fn totals(&self) -> Totals {
        self.totals
    }
}

#[cfg(test)]
mod tests;
