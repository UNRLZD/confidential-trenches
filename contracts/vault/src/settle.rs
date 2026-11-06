// SPDX-License-Identifier: Apache-2.0
//! `settle(nullifier_hash)` (vault.md 2.5.5), by anyone, `#[payable]`: a spend whose payout callback has run becomes
//! `settled`, and a `refund_pending` one first becomes a refund note.
//!
//! - The argument: one canonical decimal (`InvalidNumber`) below p (`FieldOverflow`), read as 2.5.2 row 1 reads every
//!   number; then the spend it names, through `spent` (`UnknownSpend`).
//! - Step 1: the spend's status is `refund_pending` or `paid`; `in_flight` (its callback has not run, or failed:
//!   2.5.4, VT-S17) is refused (`SpendInFlight`), and so is `settled` (`AlreadySettled`), so one spend makes at most
//!   one note.
//! - Step 2, when `refund_pending`: `nonce += 1`, `label = keccak256(scope_be32 ‖ nonce_be32) mod p`, `commitment =
//!   Poseidon(refund_value, label, refund_precommitment)` (a precommitment the withdraw or ragequit reserved in
//!   `precommitments`, so no deposit shares it), the commitment into the state tree and the label into the
//!   label tree with the checks of 2.5.1 row 10, and `refund_label`, `refund_leaf_index` written in the record. The
//!   label gets no `label_index` row: a refund note has no depositor, so ragequit (2.5.3 row 2) never passes on it.
//!   `totals` is not touched: `on_payout` already counted the refund in `returned`, which 2.5.2 row 9 holds as the
//!   notes' value from that moment, so adding it again would count it twice.
//! - Step 3: the bytes the call wrote (`env::storage_usage()` at the end less at the start) × `env::storage_byte_cost()`
//!   are taken from the record's `reserve`; a shortfall (a tree grew a level; a price rise is not seen, near-sdk's byte
//!   cost being constant: R-02/A-03) is taken from the attachment, else `InsufficientStorageDeposit`, the last refusal,
//!   which rolls every write back. The record becomes `settled` with `reserve = 0` (a same-size overwrite); the rest of
//!   the reserve goes to `payer` and the unused attachment back to the caller, each a plain Transfer (none for 0).
//!
//! Events, only after the last refusal and the Transfers (NEAR keeps a failed receipt's logs): for a refund note
//! `leaf_inserted` state, `leaf_inserted` label, `refund_inserted`, in a deposit's order; a `paid` spend logs none.
//! `settle` returns no promise.
//!
//! Ported from Privacy Pools v1.3.0's deposit, applied to a note the vault writes itself (vault.md 2.5.5: the label
//! `PrivacyPool.sol:93`, the commitment `:98`, the insert `State.sol:136-152`), Copyright 2025 0XBOW LTD, Apache-2.0.
//! Deviations (vault.md 2.7): refund notes and `settle` (Dev 9), NEAR storage paid from the withdrawal's reserve
//! (Dev 3).

use crate::context::label_of;
use crate::events::Event;
use crate::poseidon::{PoseidonT3, PoseidonT4};
use crate::{field, promise, scope, Bytes32, Status, Vault, VaultExt};
use near_sdk::{env, near};

/// An amount as a field element's 32 big-endian bytes (a u128 is always below p), as src/deposit.rs writes it.
fn amount_be(amount: u128) -> Bytes32 {
    let mut b = [0u8; 32];
    b[16..].copy_from_slice(&amount.to_be_bytes());
    b
}

/// Step 3's split: `(to the payer, back to the caller)` when the call wrote `cost` yocto of storage, or None when the
/// reserve and the attachment together are short. The reserve pays first; the attachment pays only its shortfall.
pub fn split_reserve(reserve: u128, attached: u128, cost: u128) -> Option<(u128, u128)> {
    match reserve.checked_sub(cost) {
        Some(rest) => Some((rest, attached)),
        None => attached.checked_sub(cost - reserve).map(|back| (0, back)),
    }
}

#[near]
impl Vault {
    /// 2.5.5: the spend `nullifier_hash` names, once its callback has run, becomes `settled`; a refund-pending one
    /// first becomes a refund note of exactly `refund_value` on its `refund_precommitment`. Refused: `InvalidNumber`,
    /// `FieldOverflow`, `UnknownSpend`, `SpendInFlight`, `AlreadySettled`, the trees' own checks, and
    /// `InsufficientStorageDeposit` (the reserve and the attachment short of the bytes written).
    #[payable]
    #[deny_unknown_arguments]
    pub fn settle(&mut self, nullifier_hash: String) {
        let n = field::parse_decimal(&nullifier_hash)
            .unwrap_or_else(|| env::panic_str("InvalidNumber: nullifier_hash is not a canonical decimal"));
        if field::ge(&n, &field::P) {
            env::panic_str("FieldOverflow: nullifier_hash is not below p");
        }
        let index = self
            .spent
            .get(&field::to_be(&n))
            .unwrap_or_else(|| env::panic_str("UnknownSpend: no spend of this nullifier hash"));
        let mut s = self.spends.get(index).unwrap_or_else(|| env::abort());
        // step 1
        match s.status {
            Status::InFlight => env::panic_str("SpendInFlight: its payout's callback has not run"),
            Status::Settled => env::panic_str("AlreadySettled"),
            Status::RefundPending | Status::Paid => {}
        }
        let usage0 = env::storage_usage();
        // step 2
        let note = if s.status == Status::RefundPending {
            self.nonce += 1;
            let label = field::to_be(&label_of(&scope(), self.nonce));
            let commitment = PoseidonT4::new().hash(&amount_be(s.refund_value), &label, &s.refund_precommitment);
            // the commitment first, then its label, as a deposit inserts them (src/deposit.rs row 10)
            let mut h = PoseidonT3::new();
            let state = self.insert_commitment(&mut h, &commitment);
            let labelled = self.insert_label(&mut h, &label);
            s.refund_label = label;
            s.refund_leaf_index = state.index;
            Some((state, labelled, commitment, label))
        } else {
            None
        };
        // step 3
        let reserve = s.reserve;
        s.status = Status::Settled;
        s.reserve = 0;
        self.spends.replace(index, &s);
        let bytes = env::storage_usage().saturating_sub(usage0);
        let (to_payer, to_caller) = u128::from(bytes)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .and_then(|cost| split_reserve(reserve, env::attached_deposit().as_yoctonear(), cost))
            .unwrap_or_else(|| {
                env::panic_str(&format!(
                    "InsufficientStorageDeposit: settle wrote {bytes} B; attach what the spend's reserve does not cover"
                ))
            });
        promise::transfer_near(&s.payer, to_payer);
        promise::transfer_near(&env::predecessor_account_id(), to_caller);
        // every check has passed and the Transfers are made: the events
        if let Some((state, labelled, commitment, label)) = note {
            state.event().emit();
            labelled.event().emit();
            Event::RefundInserted {
                nullifier_hash: &s.nullifier_hash,
                commitment: &commitment,
                label: &label,
                value: s.refund_value,
            }
            .emit();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{REFUND_RESERVE_BYTES, TOKEN};
    use crate::{Spend, Totals};
    use near_sdk::json_types::U128;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
    use near_sdk::{AccountId, NearToken};
    use std::collections::{BTreeMap, HashMap};
    use std::panic::{catch_unwind, AssertUnwindSafe};

    const VAULT: &str = "vault.test.near";
    const PAYER: &str = "relayer.test.near";
    const STRANGER: &str = "stranger.test.near";
    const PRICE: u128 = 10_000_000_000_000_000_000;
    /// A withdrawal's reserve: REFUND_RESERVE_BYTES' worth and a surplus the payer attached.
    const SURPLUS: u128 = 12_345;
    const RESERVE: u128 = REFUND_RESERVE_BYTES as u128 * PRICE + SURPLUS;
    const DEPOSITED: u128 = 31_000_000;

    fn id(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    /// A fresh mocked call at the vault by `caller` attaching `attached`, on `storage`.
    fn call_on(storage: HashMap<Vec<u8>, Vec<u8>>, caller: &str, attached: u128) {
        env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
            VMContextBuilder::new()
                .current_account_id(id(VAULT))
                .predecessor_account_id(id(caller))
                .attached_deposit(NearToken::from_yoctonear(attached))
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            vec![],
            storage,
            Default::default(),
            None,
        ));
    }

    /// A fresh mocked call that keeps every record written so far.
    fn call(caller: &str, attached: u128) {
        call_on(near_sdk::mock::with_mocked_blockchain(|b| b.take_storage()), caller, attached);
    }

    /// Every raw record the mocked chain holds, in key order; then a fresh call on the same records.
    fn raw(caller: &str, attached: u128) -> BTreeMap<Vec<u8>, Vec<u8>> {
        let s = near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
        let copy = s.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        call_on(s, caller, attached);
        copy
    }

    /// Spend `i`'s nullifier hash (below p: its first byte is under 0x30).
    fn nh(i: usize) -> Bytes32 {
        [i as u8 + 1; 32]
    }

    fn dec(b: &Bytes32) -> String {
        field::to_decimal(&field::from_be(b))
    }

    /// A vault on fresh storage whose state tree holds `leaves` leaves and whose label tree holds `labels` labels (from
    /// `labels` deposits, so `nonce = labels`), with one spend per `(status, refund_value)`, each paid for by PAYER
    /// with RESERVE in its reserve; the totals as on_payout leaves them (returned = the refund-pending values).
    fn vault(leaves: u64, labels: u64, spends: &[(Status, u128)]) -> Vault {
        call_on(Default::default(), PAYER, 0);
        let mut v = Vault::default();
        let mut h = PoseidonT3::new();
        for i in 0..leaves {
            let _ = v.insert_commitment(&mut h, &amount_be(1_000 + i as u128));
        }
        for i in 0..labels {
            let _ = v.insert_label(&mut h, &amount_be(2_000 + i as u128));
        }
        v.nonce = labels;
        let (mut spent, mut returned) = (0, 0);
        for (i, &(status, refund_value)) in spends.iter().enumerate() {
            let withdrawn = 2_000_000;
            v.spends.push(&Spend {
                nullifier_hash: nh(i),
                withdrawn,
                new_leaf_index: i as u64,
                refund_precommitment: [9; 32],
                refund_value,
                refund_label: [0; 32],
                refund_leaf_index: 0,
                status,
                payer: id(PAYER),
                reserve: RESERVE,
                recipient: id("alice.test.near"),
                fee: 500_000,
                context: [5; 32],
            });
            v.spent.insert(&nh(i), &(i as u64));
            spent += withdrawn;
            if status == Status::RefundPending {
                returned += refund_value;
            }
        }
        v.totals = Totals { deposited: U128(DEPOSITED), spent: U128(spent), returned: U128(returned) };
        // a clean slate of logs and receipts for the call under test
        call(STRANGER, 0);
        v
    }

    /// `settle(nullifier_hash)` by `caller` attaching `attached`, in a fresh mocked call on the same records: the bytes
    /// it added to the storage use, or its panic's text.
    fn settle(v: &mut Vault, caller: &str, attached: u128, nullifier_hash: String) -> Result<u64, String> {
        call(caller, attached);
        let before = env::storage_usage();
        catch_unwind(AssertUnwindSafe(|| v.settle(nullifier_hash)))
            .map(|()| env::storage_usage() - before)
            .map_err(|e| e.downcast::<String>().map(|s| *s).unwrap_or_default())
    }

    /// The Transfers the call made, as (receiver, yocto); any other action fails the test.
    fn transfers() -> Vec<(String, u128)> {
        get_created_receipts()
            .iter()
            .map(|r| match r.actions.as_slice() {
                [MockAction::Transfer { deposit, .. }] => (r.receiver_id.to_string(), deposit.as_yoctonear()),
                other => panic!("settle made {other:?}"),
            })
            .collect()
    }

    /// The call is refused with `want`, and nothing is written, logged or sent: the mocked chain keeps a panicking
    /// call's writes and logs, so a write before the refusal would show in the struct or a raw record.
    fn refused(v: &mut Vault, attached: u128, nullifier_hash: String, want: &str) {
        call(STRANGER, attached);
        let (struct_before, raw_before) = (near_sdk::borsh::to_vec(&*v).unwrap(), raw(STRANGER, attached));
        let e = match catch_unwind(AssertUnwindSafe(|| v.settle(nullifier_hash))) {
            Ok(()) => panic!("settled, want {want}"),
            Err(e) => e.downcast::<String>().map(|s| *s).unwrap_or_default(),
        };
        assert!(e.contains(want), "want {want}, got {e:?}");
        assert_eq!(get_logs(), Vec::<String>::new(), "{want}: a refused call logged");
        assert!(get_created_receipts().is_empty(), "{want}: a refused call sent NEAR");
        assert_eq!(near_sdk::borsh::to_vec(&*v).unwrap(), struct_before, "{want}: a struct byte changed");
        assert!(raw(STRANGER, 0) == raw_before, "{want}: a raw record changed");
    }

    fn label(nonce: u64) -> Bytes32 {
        field::to_be(&label_of(&crate::context::scope_for(VAULT, TOKEN), nonce))
    }

    fn event(name: &str, data: String) -> String {
        format!(r#"EVENT_JSON:{{"standard":"blindfill-vault","version":"1.0.0","event":"{name}","data":[{data}]}}"#)
    }

    #[test]
    fn split_reserve_takes_the_reserve_first_then_the_attachment() {
        // the reserve covers it: the rest to the payer, the whole attachment back
        assert_eq!(split_reserve(RESERVE, 7, 389 * PRICE), Some((SURPLUS, 7)));
        assert_eq!(split_reserve(389 * PRICE, 0, 389 * PRICE), Some((0, 0)));
        assert_eq!(split_reserve(RESERVE, 0, 0), Some((RESERVE, 0)));
        // short: the attachment pays exactly the shortfall
        let cost = 463 * PRICE;
        let short = cost - RESERVE;
        assert_eq!(split_reserve(RESERVE, short, cost), Some((0, 0)));
        assert_eq!(split_reserve(RESERVE, short + 7, cost), Some((0, 7)));
        assert_eq!(split_reserve(RESERVE, short - 1, cost), None);
        assert_eq!(split_reserve(0, 0, 1), None);
        // nothing wraps
        assert_eq!(split_reserve(u128::MAX, u128::MAX, u128::MAX), Some((0, u128::MAX)));
        assert_eq!(split_reserve(0, u128::MAX, u128::MAX), Some((0, 0)));
        assert_eq!(split_reserve(1, u128::MAX - 1, u128::MAX), Some((0, 0)));
        assert_eq!(split_reserve(0, u128::MAX - 1, u128::MAX), None);
    }

    /// VT-S08 in the mocked chain (tests/settle.rs runs it in near-sandbox): a refund-pending spend on trees that grow
    /// no level becomes a note of exactly its refund_value, writes exactly REFUND_RESERVE_BYTES, sends the payer the
    /// reserve less those bytes, sends the stranger's attachment back, logs its three events, and leaves totals (and
    /// so row 9's held value) unchanged.
    #[test]
    fn a_refund_pending_spend_becomes_its_refund_note() {
        let refund = 1_500_000;
        let mut v = vault(7, 6, &[(Status::RefundPending, refund)]);
        let (totals, held0) = (v.totals, held(&v));
        let wrote = settle(&mut v, STRANGER, 7, dec(&nh(0))).unwrap();
        assert_eq!(wrote, REFUND_RESERVE_BYTES, "the bytes a refund note writes (2.3)");
        let l = label(7);
        let c = PoseidonT4::new().hash(&amount_be(refund), &l, &[9; 32]);
        // step 2: one leaf in each tree, both roots known, the record names them
        assert_eq!((v.nonce, v.state_tree.size, v.label_tree.size), (7, 8, 7));
        assert_eq!((v.state_tree.leaf_at(7), v.label_tree.leaf_at(6)), (Some(c), Some(l)));
        assert_eq!(v.state_leaf_index.get(&c), Some(7));
        assert!(v.state_tree.is_known_root(&v.state_tree.root()) && v.label_tree.is_known_root(&v.label_tree.root()));
        assert_eq!(v.label_index.get(&l), None, "a refund note has no depositor");
        let s = v.spends.get(0).unwrap();
        assert_eq!((s.status, s.reserve, s.refund_value, s.refund_label, s.refund_leaf_index), (Status::Settled, 0, refund, l, 7));
        // step 3: the reserve's rest to the payer, the attachment back
        assert_eq!(transfers(), vec![(PAYER.to_string(), SURPLUS), (STRANGER.to_string(), 7)]);
        // on_payout counted the refund; settle adds nothing
        assert_eq!((v.totals, held(&v)), (totals, held0));
        let (cd, ld, sr, lr) = (dec(&c), dec(&l), dec(&v.state_tree.root()), dec(&v.label_tree.root()));
        assert_eq!(
            get_logs(),
            vec![
                event("leaf_inserted", format!(r#"{{"tree":"state","index":7,"leaf":"{cd}","root":"{sr}"}}"#)),
                event("leaf_inserted", format!(r#"{{"tree":"label","index":6,"leaf":"{ld}","root":"{lr}"}}"#)),
                event(
                    "refund_inserted",
                    format!(r#"{{"nullifier_hash":"{}","commitment":"{cd}","label":"{ld}","value":"1500000"}}"#, dec(&nh(0)))
                ),
            ]
        );
    }

    #[test]
    fn a_paid_spend_is_settled_with_its_whole_reserve_to_the_payer_and_no_note() {
        let mut v = vault(7, 6, &[(Status::Paid, 0)]);
        let totals = v.totals;
        assert_eq!(settle(&mut v, STRANGER, 5, dec(&nh(0))).unwrap(), 0, "a paid settle writes no byte");
        assert_eq!((v.nonce, v.state_tree.size, v.label_tree.size), (6, 7, 6));
        let s = v.spends.get(0).unwrap();
        assert_eq!((s.status, s.reserve, s.refund_label, s.refund_leaf_index), (Status::Settled, 0, [0; 32], 0));
        assert_eq!(transfers(), vec![(PAYER.to_string(), RESERVE), (STRANGER.to_string(), 5)]);
        assert_eq!(v.totals, totals);
        assert_eq!(get_logs(), Vec::<String>::new());
    }

    #[test]
    fn the_payer_settling_its_own_spend_with_nothing_attached_gets_the_rest() {
        let mut v = vault(7, 6, &[(Status::RefundPending, 1)]);
        settle(&mut v, PAYER, 0, dec(&nh(0))).unwrap();
        assert_eq!(transfers(), vec![(PAYER.to_string(), SURPLUS)]);
    }

    /// Step 3 when the state tree grows a level (its 9th leaf: 389 + 74 B): the reserve pays first and the attachment
    /// exactly the shortfall; one yocto short is refused with nothing logged or sent (the mocked chain keeps a
    /// panicking call's writes, so "nothing written" is read on chain in tests/settle.rs).
    #[test]
    fn a_tree_that_grows_takes_the_shortfall_from_the_attachment() {
        let wrote = REFUND_RESERVE_BYTES as u128 + 74;
        let short = wrote * PRICE - RESERVE;
        let mut v = vault(8, 6, &[(Status::RefundPending, 100_000)]);
        let e = settle(&mut v, STRANGER, short - 1, dec(&nh(0))).unwrap_err();
        assert!(e.contains(&format!("InsufficientStorageDeposit: settle wrote {wrote} B")), "{e}");
        assert_eq!(get_logs(), Vec::<String>::new(), "logged before the last refusal");
        assert!(get_created_receipts().is_empty(), "sent NEAR before the last refusal");

        let mut v = vault(8, 6, &[(Status::RefundPending, 100_000)]);
        assert_eq!(settle(&mut v, STRANGER, short + 3, dec(&nh(0))).unwrap() as u128, wrote);
        assert_eq!(transfers(), vec![(STRANGER.to_string(), 3)], "nothing left for the payer, the rest back");
        assert_eq!((v.state_tree.depth, v.spends.get(0).unwrap().status), (4, Status::Settled));

        let mut v = vault(8, 6, &[(Status::RefundPending, 100_000)]);
        settle(&mut v, STRANGER, short, dec(&nh(0))).unwrap();
        assert_eq!(transfers(), Vec::<(String, u128)>::new(), "exactly the shortfall: nothing to send");
    }

    #[test]
    fn an_in_flight_spend_is_refused() {
        let mut v = vault(7, 6, &[(Status::InFlight, 0)]);
        refused(&mut v, 1, dec(&nh(0)), "SpendInFlight");
    }

    #[test]
    fn a_second_settle_is_refused() {
        for (status, refund) in [(Status::RefundPending, 1_500_000), (Status::Paid, 0)] {
            let mut v = vault(7, 6, &[(status, refund)]);
            settle(&mut v, STRANGER, 0, dec(&nh(0))).unwrap();
            refused(&mut v, 0, dec(&nh(0)), "AlreadySettled");
            refused(&mut v, 10 * PRICE, dec(&nh(0)), "AlreadySettled");
            assert_eq!(v.state_tree.size, if status == Status::Paid { 7 } else { 8 }, "one note at most");
        }
    }

    #[test]
    fn an_unknown_nullifier_is_refused() {
        let mut v = vault(7, 6, &[(Status::RefundPending, 1_500_000)]);
        refused(&mut v, 0, dec(&nh(1)), "UnknownSpend");
        refused(&mut v, 0, "0".into(), "UnknownSpend");
        // another spend's fields are no key: the refund precommitment and the context
        refused(&mut v, 0, dec(&[9; 32]), "UnknownSpend");
        refused(&mut v, 0, dec(&[5; 32]), "UnknownSpend");
    }

    #[test]
    fn a_nullifier_hash_takes_one_spelling_below_p() {
        let mut v = vault(7, 6, &[(Status::RefundPending, 1_500_000)]);
        let good = dec(&nh(0));
        for bad in [format!("0{good}"), format!("+{good}"), format!("{good} "), String::new(), "0x1".into(), "1e3".into()] {
            refused(&mut v, 0, bad, "InvalidNumber");
        }
        // p plus the spend's own value is the same field element written another way
        let p_plus = field::to_decimal(&{
            let (mut r, mut carry) = ([0u64; 4], 0u128);
            let (a, b) = (field::P, field::from_be(&nh(0)));
            for i in (0..4).rev() {
                let s = a[i] as u128 + b[i] as u128 + carry;
                r[i] = s as u64;
                carry = s >> 64;
            }
            r
        });
        refused(&mut v, 0, p_plus, "FieldOverflow");
        refused(&mut v, 0, field::to_decimal(&field::P), "FieldOverflow");
        settle(&mut v, STRANGER, 0, good).unwrap();
    }

    #[test]
    fn two_refund_notes_take_two_nonces_and_their_own_values() {
        let mut v = vault(7, 6, &[(Status::RefundPending, 100_000), (Status::Paid, 0), (Status::RefundPending, 1_500_000)]);
        settle(&mut v, STRANGER, 0, dec(&nh(2))).unwrap();
        settle(&mut v, STRANGER, 0, dec(&nh(1))).unwrap();
        settle(&mut v, STRANGER, 100 * PRICE, dec(&nh(0))).unwrap();
        let (a, c) = (v.spends.get(0).unwrap(), v.spends.get(2).unwrap());
        assert_eq!((c.refund_label, c.refund_leaf_index, a.refund_label, a.refund_leaf_index), (label(7), 7, label(8), 8));
        assert_eq!(v.state_tree.leaf_at(7), Some(PoseidonT4::new().hash(&amount_be(1_500_000), &label(7), &[9; 32])));
        assert_eq!(v.state_tree.leaf_at(8), Some(PoseidonT4::new().hash(&amount_be(100_000), &label(8), &[9; 32])));
        assert_eq!(v.nonce, 8);
    }

    /// Row 9's held value, `deposited - (spent - returned)` (src/withdraw.rs `check_spend`).
    fn held(v: &Vault) -> u128 {
        v.totals.deposited.0 - (v.totals.spent.0 - v.totals.returned.0)
    }
}
