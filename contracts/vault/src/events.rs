// SPDX-License-Identifier: Apache-2.0
//! The vault's events (vault.md 7.1, frozen Nov 1 06:00Z with the kit's `packages/kit/src/vault/shapes.ts`).
//!
//! NEP-297: one log line `EVENT_JSON:{"standard":"blindfill-vault","version":"1.0.0","event":<name>,"data":[{..}]}`.
//! `data` is an array of objects (the NEP-141 and NEP-171 form), each object's fields in the kit's `VAULT_EVENTS` order.
//! Field elements and amounts are decimal strings, indexes JSON numbers (0-based), account ids strings.
//!
//! Ported from Privacy Pools v1.3.0's events, Copyright 2025 0XBOW LTD, Apache-2.0: `LeafInserted`
//! (`State.sol:151`; here `index` is the 0-based position, where PP's is the size after the insert), `Deposited`
//! (`PrivacyPool.sol:106`), `Withdrawn` (`PrivacyPool.sol:126-128`), `WithdrawalRelayed` (`Entrypoint.sol:175`) and
//! `Ragequit` (`PrivacyPool.sol:149`). `storage_prepaid`, `payout` and `refund_inserted` are the vault's own (vault.md
//! 2.5.1, 2.5.4, 2.5.5; Dev 3 and Dev 9).

use crate::{field, Bytes32};
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{env, serde_json, AccountId};

pub const STANDARD: &str = "blindfill-vault";
pub const VERSION: &str = "1.0.0";

/// Which tree a `leaf_inserted` names.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
pub enum TreeName {
    State,
    Label,
}

/// A field element as its canonical decimal.
fn dec(b: &Bytes32) -> String {
    field::to_decimal(&field::from_be(b))
}

/// Every event the vault emits. The fields of each are written in this order, which is the kit's.
#[derive(Clone, Debug)]
pub enum Event<'a> {
    LeafInserted {
        tree: TreeName,
        index: u64,
        leaf: &'a Bytes32,
        root: &'a Bytes32,
    },
    Deposited {
        depositor: &'a AccountId,
        commitment: &'a Bytes32,
        label: &'a Bytes32,
        value: u128,
        precommitment: &'a Bytes32,
    },
    StoragePrepaid {
        precommitment: &'a Bytes32,
        payer: &'a AccountId,
        amount: u128,
    },
    Withdrawn {
        processor: &'a AccountId,
        value: u128,
        spent_nullifier: &'a Bytes32,
        new_commitment: &'a Bytes32,
    },
    WithdrawalRelayed {
        relayer: &'a AccountId,
        recipient: &'a AccountId,
        amount: u128,
        fee: u128,
        refund_precommitment: &'a Bytes32,
    },
    Ragequit {
        ragequitter: &'a AccountId,
        commitment: &'a Bytes32,
        label: &'a Bytes32,
        value: u128,
    },
    Payout {
        nullifier_hash: &'a Bytes32,
        delivered: u128,
        returned: u128,
    },
    RefundInserted {
        nullifier_hash: &'a Bytes32,
        commitment: &'a Bytes32,
        label: &'a Bytes32,
        value: u128,
    },
}

// The `data` objects. serde_json writes a struct's fields in declaration order.

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct LeafInserted {
    tree: TreeName,
    index: u64,
    leaf: String,
    root: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Deposited<'a> {
    depositor: &'a AccountId,
    commitment: String,
    label: String,
    value: U128,
    precommitment: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct StoragePrepaid<'a> {
    precommitment: String,
    payer: &'a AccountId,
    amount: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Withdrawn<'a> {
    processor: &'a AccountId,
    value: U128,
    spent_nullifier: String,
    new_commitment: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct WithdrawalRelayed<'a> {
    relayer: &'a AccountId,
    recipient: &'a AccountId,
    amount: U128,
    fee: U128,
    refund_precommitment: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Ragequit<'a> {
    ragequitter: &'a AccountId,
    commitment: String,
    label: String,
    value: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Payout {
    nullifier_hash: String,
    delivered: U128,
    returned: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct RefundInserted {
    nullifier_hash: String,
    commitment: String,
    label: String,
    value: U128,
}

fn one<T: Serialize>(name: &'static str, data: T) -> (&'static str, String) {
    (name, serde_json::to_string(&[data]).unwrap_or_else(|_| env::abort()))
}

impl Event<'_> {
    /// The event's name and its `data` array as JSON.
    fn parts(&self) -> (&'static str, String) {
        match *self {
            Event::LeafInserted { tree, index, leaf, root } => {
                one("leaf_inserted", LeafInserted { tree, index, leaf: dec(leaf), root: dec(root) })
            }
            Event::Deposited { depositor, commitment, label, value, precommitment } => one(
                "deposited",
                Deposited {
                    depositor,
                    commitment: dec(commitment),
                    label: dec(label),
                    value: U128(value),
                    precommitment: dec(precommitment),
                },
            ),
            Event::StoragePrepaid { precommitment, payer, amount } => one(
                "storage_prepaid",
                StoragePrepaid { precommitment: dec(precommitment), payer, amount: U128(amount) },
            ),
            Event::Withdrawn { processor, value, spent_nullifier, new_commitment } => one(
                "withdrawn",
                Withdrawn {
                    processor,
                    value: U128(value),
                    spent_nullifier: dec(spent_nullifier),
                    new_commitment: dec(new_commitment),
                },
            ),
            Event::WithdrawalRelayed { relayer, recipient, amount, fee, refund_precommitment } => one(
                "withdrawal_relayed",
                WithdrawalRelayed {
                    relayer,
                    recipient,
                    amount: U128(amount),
                    fee: U128(fee),
                    refund_precommitment: dec(refund_precommitment),
                },
            ),
            Event::Ragequit { ragequitter, commitment, label, value } => one(
                "ragequit",
                Ragequit { ragequitter, commitment: dec(commitment), label: dec(label), value: U128(value) },
            ),
            Event::Payout { nullifier_hash, delivered, returned } => one(
                "payout",
                Payout { nullifier_hash: dec(nullifier_hash), delivered: U128(delivered), returned: U128(returned) },
            ),
            Event::RefundInserted { nullifier_hash, commitment, label, value } => one(
                "refund_inserted",
                RefundInserted {
                    nullifier_hash: dec(nullifier_hash),
                    commitment: dec(commitment),
                    label: dec(label),
                    value: U128(value),
                },
            ),
        }
    }

    /// The whole log line. The name is one of the eight fixed names above, so it needs no escaping.
    pub fn line(&self) -> String {
        let (name, data) = self.parts();
        format!(r#"EVENT_JSON:{{"standard":"{STANDARD}","version":"{VERSION}","event":"{name}","data":{data}}}"#)
    }

    /// Writes the line to the receipt's logs.
    pub fn emit(&self) {
        env::log_str(&self.line());
    }
}
