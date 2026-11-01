// SPDX-License-Identifier: Apache-2.0
//! A test-only contract with the vault's deposit surface, for the deposit relayer's near-sandbox proof
//! (tests/relayer_send.rs). It stands in for the vault's deposit rows (vault.md 2.5.1 rows 3-12) until card
//! vault-deposit-insert lands; the same cases then run on the real vault. It is never the vault: no note, no Poseidon,
//! no withdrawal; only what the relayer's send reads and what decides whether a deposit lands.
//!
//! - `new(token)`: the one token whose `ft_on_transfer` it takes (the real vault compiles `TOKEN` in).
//! - `storage_prepay(precommitment)` as contracts/vault/src/prepay.rs: a canonical decimal below p (`InvalidNumber`,
//!   `FieldOverflow`), refused on a used P (`PrecommitmentAlreadyUsed`), a new record needs 756 B × the byte cost
//!   (`InsufficientStorageDeposit`), any amount tops a record up. `prepaid` keys and values are laid out as the vault's
//!   (prefix byte 12, P as 32 bytes big-endian, the amount as a little-endian u128), so a raw-state read of either
//!   contract reads the same record. No event.
//! - `ft_on_transfer(sender_id, amount, msg)`: from the token only (`NotTheToken`); `msg` exactly
//!   `{"precommitment","depositor"}`, at most 1,024 B, with depositor = sender_id; amount at least 1 USDC; refused (a
//!   panic, so the token gives the amount back) when P is used or `prepaid[P]` is below the deposit's bytes: 904 B ×
//!   the byte cost when the state tree's size is 0 or a power of two (a new level, vault.md 2.3), else 756 B. On
//!   success it removes `prepaid[P]`, records the deposit, grows both trees by one and returns "0".
//! - Views: `deposits(from, limit)`, `state_tree()`, `label_tree()` in the vault's shapes (label and roots "0").
use near_sdk::collections::{LookupMap, LookupSet, Vector};
use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::{env, near, AccountId, PanicOnDefault};

/// 2.3: what a deposit writes with no tree growing a level; the minimum new prepay.
const DEPOSIT_STORAGE_BYTES: u128 = 756;
/// 2.3: what a deposit writes when a tree grows a level.
const DEPOSIT_GROW_BYTES: u128 = 904;
const MIN_DEPOSIT: u128 = 1_000_000;
const MESSAGE_MAX_BYTES: usize = 1_024;
const PAGE_MAX: u64 = 1_000;
/// The BN254 scalar field's p, big-endian.
const P_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d, 0x28, 0x33, 0xe8, 0x48,
    0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];
/// The vault's `Key::Prepaid` byte (src/lib.rs `Key`, the 13th variant).
const PREPAID_PREFIX: u8 = 12;

#[near(serializers = [borsh])]
pub struct Deposit {
    precommitment: String,
    value: u128,
    leaf_index: u64,
    depositor: AccountId,
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
pub struct TreeView {
    pub size: u64,
    pub depth: u8,
    pub root: String,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct Message {
    precommitment: String,
    depositor: AccountId,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct TestVault {
    token: AccountId,
    prepaid: LookupMap<[u8; 32], u128>,
    used: LookupSet<[u8; 32]>,
    deposits: Vector<Deposit>,
    size: u64,
}

/// P as 32 bytes big-endian: one canonical decimal below p, else a panic named as the vault names it.
fn be32(s: &str) -> [u8; 32] {
    let canonical = !s.is_empty() && s.len() <= 78 && s.bytes().all(|b| b.is_ascii_digit()) && !(s.len() > 1 && s.starts_with('0'));
    if !canonical {
        env::panic_str("InvalidNumber: the precommitment is not a canonical decimal");
    }
    let mut n = [0u8; 32];
    for d in s.bytes() {
        let mut carry = (d - b'0') as u32;
        for i in (0..32).rev() {
            let v = n[i] as u32 * 10 + carry;
            n[i] = (v & 0xff) as u8;
            carry = v >> 8;
        }
        if carry != 0 {
            env::panic_str("FieldOverflow: the precommitment is not below p");
        }
    }
    if n >= P_BE {
        env::panic_str("FieldOverflow: the precommitment is not below p");
    }
    n
}

fn depth(size: u64) -> u8 {
    if size <= 1 {
        0
    } else {
        (64 - (size - 1).leading_zeros()) as u8
    }
}

#[near]
impl TestVault {
    #[init]
    pub fn new(token: AccountId) -> Self {
        Self { token, prepaid: LookupMap::new(vec![PREPAID_PREFIX]), used: LookupSet::new(b"u".to_vec()), deposits: Vector::new(b"d".to_vec()), size: 0 }
    }

    #[payable]
    pub fn storage_prepay(&mut self, precommitment: String) {
        let p = be32(&precommitment);
        if self.used.contains(&p) {
            env::panic_str("PrecommitmentAlreadyUsed");
        }
        let attached = env::attached_deposit().as_yoctonear();
        let total = match self.prepaid.get(&p) {
            Some(held) => held + attached,
            None => {
                if attached < DEPOSIT_STORAGE_BYTES * env::storage_byte_cost().as_yoctonear() {
                    env::panic_str("InsufficientStorageDeposit: a new prepay takes at least DEPOSIT_STORAGE_BYTES");
                }
                attached
            }
        };
        self.prepaid.insert(&p, &total);
    }

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        if env::predecessor_account_id() != self.token {
            env::panic_str("NotTheToken: only the vault's token calls ft_on_transfer");
        }
        if msg.len() > MESSAGE_MAX_BYTES {
            env::panic_str("MessageTooLong");
        }
        if !msg.trim_start_matches([' ', '\t', '\n', '\r']).starts_with('{') {
            env::panic_str("InvalidMessage: not a JSON object");
        }
        let m: Message = near_sdk::serde_json::from_str(&msg).unwrap_or_else(|e| env::panic_str(&format!("InvalidMessage: {e}")));
        if m.depositor != sender_id {
            env::panic_str("InvalidMessage: the depositor is not the sender");
        }
        let p = be32(&m.precommitment);
        if self.used.contains(&p) {
            env::panic_str("PrecommitmentAlreadyUsed");
        }
        if amount.0 < MIN_DEPOSIT {
            env::panic_str("MinimumDepositAmount: the amount is below MIN_DEPOSIT");
        }
        let bytes = if self.size == 0 || self.size.is_power_of_two() { DEPOSIT_GROW_BYTES } else { DEPOSIT_STORAGE_BYTES };
        let prepaid = self.prepaid.get(&p).unwrap_or_else(|| env::panic_str("NoPrepay: no storage_prepay for this precommitment"));
        if prepaid < bytes * env::storage_byte_cost().as_yoctonear() {
            env::panic_str(&format!("InsufficientPrepay: {bytes} B wanted"));
        }
        self.prepaid.remove(&p);
        self.used.insert(&p);
        self.deposits.push(&Deposit { precommitment: m.precommitment, value: amount.0, leaf_index: self.size, depositor: m.depositor });
        self.size += 1;
        U128(0)
    }

    pub fn deposits(&self, from: u64, limit: u64) -> Vec<DepositView> {
        let end = from.saturating_add(limit.min(PAGE_MAX)).min(self.deposits.len());
        (from..end)
            .map(|i| {
                let d = self.deposits.get(i).expect("deposits holds every index below its length");
                DepositView { index: i, precommitment: d.precommitment, label: "0".into(), value: U128(d.value), leaf_index: d.leaf_index, depositor: d.depositor }
            })
            .collect()
    }

    pub fn state_tree(&self) -> TreeView {
        TreeView { size: self.size, depth: depth(self.size), root: "0".into() }
    }

    pub fn label_tree(&self) -> TreeView {
        self.state_tree()
    }
}
