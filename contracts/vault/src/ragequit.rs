// SPDX-License-Identifier: Apache-2.0
//! `ragequit(proof, public_signals, register_deposit, refund_precommitment)` (vault.md 2.5.3), `#[payable]`: the
//! public exit for a depositor. It pays a whole note back to the account its deposit named, and only when that account
//! signs the call. Every refusal panics before any byte is written.
//!
//! - Row 1, the parse: exactly the four arguments (`#[deny_unknown_arguments]`); the 8 proof coordinates canonical
//!   decimals below q (`InvalidNumber`, `InvalidProofEncoding`); the 4 public signals `[commitment, nullifierHash,
//!   value, label]` canonical decimals below p (`InvalidNumber`, `FieldOverflow`); `refund_precommitment` a canonical
//!   decimal in 1..p-1 (`InvalidNumber`, `FieldOverflow`, `InvalidRefundPrecommitment`); `register_deposit` a canonical
//!   decimal below 2^128 (`InvalidNumber`, `AmountOverflow`), as src/withdraw.rs reads each. Then `value`: not 0
//!   (`InvalidWithdrawalAmount`, the review follow-up: a 0 note would spend its nullifier and pay nothing) and below
//!   2^128 (`AmountOverflow`). Then the gas pre-check of 2.5.2 (`InsufficientGas`), with no fee part.
//! - Row 2: the deposit with this `label` (`label_index`) names the caller as its depositor (`OnlyOriginalDepositor`).
//!   A refund note's label has no `label_index` row (src/settle.rs writes none), so a refund note never passes; a
//!   change note keeps its deposit's label, so its depositor may ragequit it.
//! - Row 3: Groth16 verify with the commitment key (`verifier_keys::COMMITMENT`, `InvalidProof`).
//! - Row 4: `commitment` is a leaf of the state tree (`InvalidCommitment`): any note of that label, change notes
//!   included.
//! - Row 5: `nullifierHash` unspent (`NullifierAlreadySpent`), then spent, with its `spends` record: `withdrawn` =
//!   value, `status = in_flight`, `payer` and `recipient` the caller (the depositor), `fee` 0, `context` 0 and
//!   `new_leaf_index` 0 (a ragequit inserts no change; restore reads a spend with context 0 as a ragequit, vault.md
//!   VT-S19), the caller's `refund_precommitment` (the device names Poseidon(refundMaster, l, j), wallet.md 2.3
//!   Secrets); `totals.spent += value`.
//! - Row 6: storage as 2.5.2 row 14 (`InsufficientStorageDeposit`, the last refusal; the reserve kept in the record),
//!   then `value` paid to the depositor in 2.5.2 row 15's one payout receipt (with `register_deposit`, no fee's
//!   transfer) and `on_payout(spend_index, value, 0)`, which turns a bounced payout into a refund note's amount (2.5.4).
//!
//! Event, after the promises: `ragequit {ragequitter, commitment, label, value}`. Like PP it has no root or label-tree
//! check.
//!
//! Ported from Privacy Pools v1.3.0 `packages/contracts/src/contracts/PrivacyPool.sol:131-149` (`ragequit`:
//! `OnlyOriginalDepositor`, the proof, `InvalidCommitment`, the spend, the push and `Ragequit`), Copyright 2025 0XBOW
//! LTD, Apache-2.0. Deviations (vault.md 2.7): the canonical parse (Dev 6), NEAR storage paid by the caller (Dev 3),
//! the payout as a promise whose bounce becomes a refund note (Dev 4, Dev 9), and a 0 value refused.

use crate::events::Event;
use crate::field::{self, U256};
use crate::verifier::{self, Proof};
use crate::verifier_keys::COMMITMENT;
use crate::withdraw::{amount, number, signal};
use crate::{payout, promise, Spend, Status, Vault, VaultExt};
use near_sdk::json_types::U128;
use near_sdk::{env, near};

// The commitment circuit's public signals, in snarkjs order (2.5.3; `commitment.sym:1-4`, PP `ProofLib.sol:119-124`).
pub const SIGNAL_COMMITMENT: usize = 0;
pub const SIGNAL_NULLIFIER_HASH: usize = 1;
pub const SIGNAL_VALUE: usize = 2;
pub const SIGNAL_LABEL: usize = 3;

/// `value` as a u128, refusing 0 and anything from 2^128.
fn value_of(v: &U256) -> u128 {
    if *v == [0; 4] {
        env::panic_str("InvalidWithdrawalAmount: value is 0");
    }
    if v[0] != 0 || v[1] != 0 {
        env::panic_str("AmountOverflow: value is not below 2^128");
    }
    ((v[2] as u128) << 64) | v[3] as u128
}

#[near]
impl Vault {
    /// 2.5.3 rows 1-6: the depositor takes a whole note back. See the module's notes for each refusal.
    #[payable]
    #[deny_unknown_arguments]
    pub fn ragequit(&mut self, proof: Proof, public_signals: [String; 4], register_deposit: String, refund_precommitment: String) {
        let usage0 = env::storage_usage();
        // row 1
        let encoded = proof.encode();
        let signals = public_signals.each_ref().map(|s| signal(s));
        let refund = number(&refund_precommitment, "refund_precommitment");
        if field::ge(&refund, &field::P) {
            env::panic_str("FieldOverflow: refund_precommitment is not below p");
        }
        if refund == [0; 4] {
            env::panic_str("InvalidRefundPrecommitment: refund_precommitment is 0");
        }
        let register_deposit = amount(&register_deposit, "register_deposit");
        let value = value_of(&signals[SIGNAL_VALUE]);
        payout::check_gas(env::prepaid_gas(), register_deposit, 0);
        // row 2
        let label = field::to_be(&signals[SIGNAL_LABEL]);
        let depositor = env::predecessor_account_id();
        let named = self.label_index.get(&label).and_then(|i| self.deposits.get(i)).map(|d| d.depositor);
        if named.as_ref() != Some(&depositor) {
            env::panic_str("OnlyOriginalDepositor: the caller is not the depositor of this label");
        }
        // row 3
        if !verifier::verify(&COMMITMENT, &encoded, &signals) {
            env::panic_str("InvalidProof");
        }
        // row 4
        let commitment = field::to_be(&signals[SIGNAL_COMMITMENT]);
        if !self.state_leaf_index.contains_key(&commitment) {
            env::panic_str("InvalidCommitment: the commitment is not a leaf of the state tree");
        }
        // row 5
        let nullifier_hash = field::to_be(&signals[SIGNAL_NULLIFIER_HASH]);
        if self.spent.contains_key(&nullifier_hash) {
            env::panic_str("NullifierAlreadySpent");
        }
        let spent = self.totals.spent.0.checked_add(value).unwrap_or_else(|| env::panic_str("InvalidPoolState"));
        let index = self.spends.len();
        self.spent.insert(&nullifier_hash, &index);
        self.spends.push(&Spend {
            nullifier_hash,
            withdrawn: value,
            new_leaf_index: 0,
            refund_precommitment: field::to_be(&refund),
            refund_value: 0,
            refund_label: [0; 32],
            refund_leaf_index: 0,
            status: Status::InFlight,
            payer: depositor.clone(),
            reserve: 0,
            recipient: depositor.clone(),
            fee: 0,
            context: [0; 32],
        });
        self.totals.spent = U128(spent);
        // row 6: storage (the last refusal), then the payout and its callback
        self.charge_storage(index, usage0, register_deposit, 0);
        promise::pay_then_on_payout(index, &depositor, value, register_deposit, &depositor, 0);
        Event::Ragequit { ragequitter: &depositor, commitment: &commitment, label: &label, value }.emit();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::poseidon::PoseidonT3;
    use crate::Deposit;
    use near_sdk::mock::MockAction;
    use near_sdk::serde_json::{self, Value};
    use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
    use near_sdk::{AccountId, Gas, NearToken};
    use std::collections::{BTreeMap, HashMap};
    use std::panic::{catch_unwind, AssertUnwindSafe};

    const FIXTURE: &str = include_str!("../tests/fixtures/ragequit-spends.json");
    const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
    const PRICE: u128 = 10_000_000_000_000_000_000;

    fn f() -> Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    fn id(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn be(dec: &str) -> crate::Bytes32 {
        field::to_be(&field::from_decimal(dec).unwrap())
    }

    /// A fresh mocked call at the fixture's vault by `caller` with `attached` and `gas`, on `storage`.
    fn call_on(storage: HashMap<Vec<u8>, Vec<u8>>, caller: &str, attached: u128, gas: Gas) {
        env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
            VMContextBuilder::new()
                .current_account_id(id(f()["vault"].as_str().unwrap()))
                .predecessor_account_id(id(caller))
                .attached_deposit(NearToken::from_yoctonear(attached))
                .prepaid_gas(gas)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            vec![],
            storage,
            Default::default(),
            None,
        ));
    }

    fn call(caller: &str, attached: u128) {
        call_on(near_sdk::mock::with_mocked_blockchain(|b| b.take_storage()), caller, attached, Gas::from_tgas(300));
    }

    fn raw(caller: &str) -> BTreeMap<Vec<u8>, Vec<u8>> {
        let s = near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
        let copy = s.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        call_on(s, caller, ONE_NEAR, Gas::from_tgas(300));
        copy
    }

    /// The fixture's state before any ragequit: the six deposits (depositors from the fixture) and the change leaves
    /// the fixture's withdrawals made, in its order; the refund note, when `refund`, as settle writes it (its label in
    /// the label tree only).
    fn vault(refund: bool) -> Vault {
        vault_of(true, refund)
    }

    /// `vault`, with the change leaves only when `changes` (without them, the state change_w and zero_w are proved on).
    fn vault_of(changes: bool, refund: bool) -> Vault {
        call_on(Default::default(), "u.test.near", 0, Gas::from_tgas(300));
        let x = f();
        let mut v = Vault::default();
        let mut h = PoseidonT3::new();
        let deps = x["deposits"].as_array().unwrap();
        for (i, d) in deps.iter().enumerate() {
            let (c, l) = (be(d["commitment"].as_str().unwrap()), be(d["label"].as_str().unwrap()));
            let s = v.insert_commitment(&mut h, &c);
            let _ = v.insert_label(&mut h, &l);
            v.deposits.push(&Deposit {
                precommitment: be(d["precommitment"].as_str().unwrap()),
                label: l,
                value: d["value"].as_str().unwrap().parse().unwrap(),
                leaf_index: s.index,
                depositor: id(d["depositor"].as_str().unwrap()),
            });
            v.label_index.insert(&l, &(i as u64));
        }
        for c in x["changes"].as_array().unwrap().iter().filter(|_| changes) {
            let _ = v.insert_commitment(&mut h, &be(c.as_str().unwrap()));
        }
        if refund {
            let r = &x["refund"];
            let _ = v.insert_commitment(&mut h, &be(r["commitment"].as_str().unwrap()));
            let _ = v.insert_label(&mut h, &be(r["label"].as_str().unwrap()));
        }
        v.nonce = 6;
        v.totals.deposited = U128(x["deposited"].as_str().unwrap().parse().unwrap());
        call("u.test.near", 0);
        v
    }

    /// The fixture's ragequit `name`: (proof, public signals, register_deposit, refund_precommitment, its signer).
    fn rq(name: &str) -> (Proof, [String; 4], String, String, String) {
        let x = f();
        let r = x["ragequits"].as_array().unwrap().iter().find(|r| r["name"] == name).unwrap().clone();
        (
            serde_json::from_value(r["proof"].clone()).unwrap(),
            serde_json::from_value(r["public_signals"].clone()).unwrap(),
            r["register_deposit"].as_str().unwrap().to_string(),
            r["refund_precommitment"].as_str().unwrap().to_string(),
            r["depositor"].as_str().unwrap().to_string(),
        )
    }

    /// The fixture's withdrawal `name`: (withdrawal, proof, public signals).
    fn wd(name: &str) -> (crate::withdraw::Withdrawal, Proof, [String; 8]) {
        let x = f();
        let s = x["withdrawals"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap().clone();
        (
            serde_json::from_value(s["withdrawal"].clone()).unwrap(),
            serde_json::from_value(s["proof"].clone()).unwrap(),
            serde_json::from_value(s["public_signals"].clone()).unwrap(),
        )
    }

    fn ragequit_as(v: &mut Vault, by: &str, attached: u128, a: (Proof, [String; 4], String, String, String)) -> Result<(), String> {
        call(by, attached);
        catch_unwind(AssertUnwindSafe(|| v.ragequit(a.0, a.1, a.2, a.3))).map_err(|e| e.downcast::<String>().map(|s| *s).unwrap_or_default())
    }

    /// Refused with `want`: nothing written, logged or sent.
    fn refused(v: &mut Vault, by: &str, attached: u128, gas: Gas, a: (Proof, [String; 4], String, String, String), want: &str) {
        refused_call(v, by, attached, gas, want, |v| v.ragequit(a.0, a.1, a.2, a.3));
    }

    /// `call` on `v` by `by` is refused with `want`: nothing written, logged or sent.
    fn refused_call(v: &mut Vault, by: &str, attached: u128, gas: Gas, want: &str, call: impl FnOnce(&mut Vault)) {
        call_on(near_sdk::mock::with_mocked_blockchain(|b| b.take_storage()), by, attached, gas);
        let struct_before = near_sdk::borsh::to_vec(&*v).unwrap();
        let s = near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
        let raw_before: BTreeMap<_, _> = s.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        call_on(s, by, attached, gas);
        let e = match catch_unwind(AssertUnwindSafe(|| call(v))) {
            Ok(()) => panic!("passed, want {want}"),
            Err(e) => e.downcast::<String>().map(|s| *s).unwrap_or_default(),
        };
        assert!(e.contains(want), "want {want}, got {e:?}");
        assert_eq!(get_logs(), Vec::<String>::new(), "{want}: logged");
        assert!(get_created_receipts().is_empty(), "{want}: a payout was made");
        assert_eq!(near_sdk::borsh::to_vec(&*v).unwrap(), struct_before, "{want}: a struct byte changed");
        assert!(raw(by) == raw_before, "{want}: a raw record changed");
    }

    /// 2.3's ragequit bytes, spent 81 + spends 394 at a 64-byte id, for a depositor id `by` (payer and recipient both).
    fn bytes(by: &str) -> u128 {
        475 - 2 * (64 - by.len() as u128)
    }

    #[test]
    fn the_depositor_ragequits_a_deposit_and_its_record_is_a_ragequits() {
        let mut v = vault(false);
        let a = rq("deposit");
        let (sig, by) = (a.1.clone(), a.4.clone());
        ragequit_as(&mut v, &by, ONE_NEAR, a.clone()).unwrap();
        let value: u128 = sig[SIGNAL_VALUE].parse().unwrap();
        let s = v.spends.get(0).unwrap();
        assert_eq!(v.spent.get(&be(&sig[SIGNAL_NULLIFIER_HASH])), Some(0));
        assert_eq!((s.withdrawn, s.status, s.fee, s.context, s.new_leaf_index), (value, Status::InFlight, 0, [0; 32], 0));
        assert_eq!((s.payer.as_str(), s.recipient.as_str()), (by.as_str(), by.as_str()));
        assert_eq!(s.refund_precommitment, be(&a.3));
        assert_eq!(v.totals.spent.0, value);
        // row 14's rule: the attachment less the bytes and the yocto (register_deposit 0) is the reserve
        let reserve = s.reserve;
        assert_eq!(ONE_NEAR - reserve - 1, bytes(&by) * PRICE, "a ragequit writes spent 81 + spends 394, less what a short depositor id saves");
        // the payout: the depositor's part, then on_payout(index, value, 0)
        let r = get_created_receipts();
        assert_eq!(r.len(), 2, "{r:?}");
        let args = |r: &near_sdk::mock::Receipt| match r.actions.as_slice() {
            [MockAction::FunctionCallWeight { method_name, args, .. }] => {
                (String::from_utf8(method_name.clone()).unwrap(), String::from_utf8(args.clone()).unwrap())
            }
            other => panic!("{other:?}"),
        };
        assert_eq!(args(&r[0]), ("ft_transfer".into(), format!(r#"{{"receiver_id":"{by}","amount":"{value}"}}"#)));
        assert_eq!(args(&r[1]), ("on_payout".into(), format!(r#"{{"spend_index":0,"to_recipient":"{value}","fee":"0"}}"#)));
        assert_eq!(
            get_logs(),
            vec![format!(
                r#"EVENT_JSON:{{"standard":"blindfill-vault","version":"1.0.0","event":"ragequit","data":[{{"ragequitter":"{by}","commitment":"{}","label":"{}","value":"{value}"}}]}}"#,
                sig[0], sig[3]
            )]
        );
        // the kit's spends row: context 0, the depositor as recipient
        let row = serde_json::to_value(&v.spends(0, 1)[0]).unwrap();
        assert_eq!((row["context"].as_str(), row["recipient"].as_str(), row["fee"].as_str()), (Some("0"), Some(by.as_str()), Some("0")));
    }

    #[test]
    fn a_change_note_of_the_deposit_passes() {
        let mut v = vault(false);
        let a = rq("change");
        let by = a.4.clone();
        ragequit_as(&mut v, &by, ONE_NEAR, a).unwrap();
        assert_eq!(v.spends.get(0).unwrap().status, Status::InFlight);
    }

    #[test]
    fn a_stranger_is_refused() {
        let mut v = vault(false);
        for by in ["stranger.test.near", "q.test.near", "vault.test.near"] {
            refused(&mut v, by, ONE_NEAR, Gas::from_tgas(300), rq("deposit"), "OnlyOriginalDepositor");
        }
    }

    #[test]
    fn a_spent_note_is_refused() {
        let mut v = vault(false);
        let a = rq("deposit");
        let by = a.4.clone();
        ragequit_as(&mut v, &by, ONE_NEAR, a.clone()).unwrap();
        refused(&mut v, &by, ONE_NEAR, Gas::from_tgas(300), a, "NullifierAlreadySpent");
    }

    #[test]
    fn a_note_a_withdraw_spent_is_refused() {
        // note 2: change_w spends it through withdraw (and writes its change leaf), then u sends its commitment proof
        let mut v = vault_of(false, false);
        let (w, p, s) = wd("change_w");
        call("relayer.test.near", ONE_NEAR);
        v.withdraw(w, p, s.clone());
        assert_ne!(v.spends.get(0).unwrap().context, [0; 32], "change_w's row is a withdraw's, not a ragequit's");
        let a = rq("withdrawn");
        assert_eq!(a.1[SIGNAL_NULLIFIER_HASH], s[1], "the ragequit names change_w's nullifier");
        let by = a.4.clone();
        refused(&mut v, &by, ONE_NEAR, Gas::from_tgas(300), a, "NullifierAlreadySpent");
        assert_eq!(v.spends.len(), 1);
    }

    #[test]
    fn a_note_a_ragequit_spent_cannot_be_withdrawn() {
        // note 3: u ragequits it, then a relayer sends after_rq, a valid withdraw proof of the same note on known roots
        let mut v = vault(false);
        let a = rq("deposit");
        let by = a.4.clone();
        ragequit_as(&mut v, &by, ONE_NEAR, a.clone()).unwrap();
        let (w, p, s) = wd("after_rq");
        assert_eq!(s[1], a.1[SIGNAL_NULLIFIER_HASH], "after_rq names the ragequit's nullifier");
        refused_call(&mut v, "relayer.test.near", ONE_NEAR, Gas::from_tgas(300), "NullifierAlreadySpent", |v| v.withdraw(w, p, s));
        assert_eq!(v.spends.len(), 1);
    }

    #[test]
    fn a_refund_note_is_refused_since_its_label_names_no_deposit() {
        let mut v = vault(true);
        let a = rq("refund_note");
        for by in [a.4.clone(), "u.test.near".into(), "q.test.near".into()] {
            refused(&mut v, &by, ONE_NEAR, Gas::from_tgas(300), a.clone(), "OnlyOriginalDepositor");
        }
    }

    #[test]
    fn a_zero_value_note_is_refused_before_anything_is_spent() {
        // a real proof of a real leaf (the change of a whole withdrawal), by its depositor
        let mut v = vault(false);
        let a = rq("zero");
        assert_eq!(a.1[SIGNAL_VALUE], "0");
        let by = a.4.clone();
        refused(&mut v, &by, ONE_NEAR, Gas::from_tgas(300), a, "InvalidWithdrawalAmount: value is 0");
    }

    #[test]
    fn a_proof_on_changed_signals_is_refused() {
        let mut v = vault(false);
        let (p, s, r, rp, by) = rq("deposit");
        // another value (the label and depositor still pass row 2)
        let mut s2 = s.clone();
        s2[SIGNAL_VALUE] = (s[SIGNAL_VALUE].parse::<u128>().unwrap() + 1).to_string();
        refused(&mut v, &by, ONE_NEAR, Gas::from_tgas(300), (p.clone(), s2, r.clone(), rp.clone(), by.clone()), "InvalidProof");
        // another nullifier hash
        let mut s3 = s.clone();
        s3[SIGNAL_NULLIFIER_HASH] = "7".into();
        refused(&mut v, &by, ONE_NEAR, Gas::from_tgas(300), (p, s3, r, rp, by.clone()), "InvalidProof");
    }

    #[test]
    fn a_commitment_not_in_the_tree_is_refused_after_the_proof() {
        // a real proof of a note on a deposit's label that was never inserted
        let mut v = vault(false);
        let a = rq("unlanded");
        let by = a.4.clone();
        refused(&mut v, &by, ONE_NEAR, Gas::from_tgas(300), a, "InvalidCommitment");
    }

    #[test]
    fn row_1_refuses_each_bad_number_before_anything_else() {
        let mut v = vault(false);
        let p_dec = field::to_decimal(&field::P);
        let a = rq("deposit");
        let by = a.4.clone();
        let with = |f: &dyn Fn(&mut (Proof, [String; 4], String, String, String))| {
            let mut x = a.clone();
            f(&mut x);
            x
        };
        let cases: Vec<((Proof, [String; 4], String, String, String), &str)> = vec![
            (with(&|x| x.3 = "0".into()), "InvalidRefundPrecommitment"),
            (with(&|x| x.3 = p_dec.clone()), "FieldOverflow"),
            (with(&|x| x.3 = format!("0{}", x.3)), "InvalidNumber"),
            (with(&|x| x.2 = "01".into()), "InvalidNumber"),
            (with(&|x| x.2 = "340282366920938463463374607431768211456".into()), "AmountOverflow"),
            (with(&|x| x.1[SIGNAL_LABEL] = p_dec.clone()), "FieldOverflow"),
            (with(&|x| x.1[SIGNAL_VALUE] = "340282366920938463463374607431768211456".into()), "AmountOverflow"),
            (with(&|x| x.1[SIGNAL_VALUE] = "0".into()), "InvalidWithdrawalAmount"),
            (with(&|x| x.0.a[0] = field::to_decimal(&verifier::Q)), "InvalidProofEncoding"),
            // the parse comes before row 2: a stranger's bad number names the number
        ];
        for (c, want) in cases {
            refused(&mut v, &by, ONE_NEAR, Gas::from_tgas(300), c.clone(), want);
            refused(&mut v, "stranger.test.near", ONE_NEAR, Gas::from_tgas(300), c, want);
        }
    }

    #[test]
    fn the_gas_pre_check_comes_before_row_2_and_the_storage_rule_is_withdraws() {
        let mut v = vault(false);
        let a = rq("deposit");
        let by = a.4.clone();
        // 15 + 30 + 100 Tgas without a registration
        refused(&mut v, &by, ONE_NEAR, Gas::from_tgas(144), a.clone(), "InsufficientGas");
        refused(&mut v, "stranger.test.near", ONE_NEAR, Gas::from_tgas(144), a.clone(), "InsufficientGas");
        // exactly (the bytes + 389) B + 1 yocto lands; one yocto less is refused with nothing logged or sent
        let need = (bytes(&by) + 389) * PRICE + 1;
        let e = ragequit_as(&mut v, &by, need - 1, a.clone()).unwrap_err();
        assert!(e.contains("InsufficientStorageDeposit"), "{e}");
        assert_eq!(get_logs(), Vec::<String>::new());
        assert!(get_created_receipts().is_empty());
        let mut v = vault(false);
        ragequit_as(&mut v, &by, need, a).unwrap();
        assert_eq!(v.spends.get(0).unwrap().reserve, 389 * PRICE);
    }

    #[test]
    fn a_registration_rides_with_the_payout() {
        // register_deposit is the caller's (no proof binds it): the depositor's part registers first
        let mut v = vault(false);
        let mut a = rq("deposit");
        a.2 = "1250000000000000000000".into();
        let by = a.4.clone();
        ragequit_as(&mut v, &by, ONE_NEAR, a).unwrap();
        let r = get_created_receipts();
        let methods: Vec<(String, u128)> = r[0]
            .actions
            .iter()
            .map(|x| match x {
                MockAction::FunctionCallWeight { method_name, attached_deposit, .. } => {
                    (String::from_utf8(method_name.clone()).unwrap(), attached_deposit.as_yoctonear())
                }
                o => panic!("{o:?}"),
            })
            .collect();
        assert_eq!(methods, vec![("storage_deposit".into(), 1_250_000_000_000_000_000_000), ("ft_transfer".into(), 1)]);
        // the reserve is what is left after the bytes, the registration and the yocto
        assert_eq!(v.spends.get(0).unwrap().reserve, ONE_NEAR - bytes(&by) * PRICE - 1_250_000_000_000_000_000_000 - 1);
    }
}
