// SPDX-License-Identifier: Apache-2.0
//! `withdraw`'s payout part (vault.md 2.5.2 rows 13-15 and the gas pre-check) and `on_payout` (2.5.4).
//!
//! - The gas pre-check: `prepaid_gas() >= Σ static + 100 Tgas`, else `InsufficientGas`. Σ static is what the payouts
//!   hand on: `GAS_FT_TRANSFER` and `GAS_ON_PAYOUT`, plus `GAS_STORAGE_DEPOSIT` when `register_deposit > 0` and a
//!   second `GAS_FT_TRANSFER` when `fee > 0` (45, 55, 60 or 70 Tgas). Too little gas could never strand a spend (a
//!   promise that cannot reserve its static fails the whole receipt, the spend with it, 2.5.2); the check gives that
//!   case its own error before the proof is verified. 100 Tgas covers the vault's own work at depth 32 (83.823 Tgas
//!   burnt plus 2.554 Tgas of execution fees it prepays, 2.11).
//! - Row 13: `fee = relay_fee`, `to_recipient = withdrawn - fee`, exact (row 8 holds `fee <= withdrawn / 2` and row 7
//!   `withdrawn >= 1`, so `to_recipient >= 1`; a split that broke this would panic, never pay).
//! - Row 14: at the end of the call, the attachment must cover (the bytes the call wrote, `env::storage_usage()` at the
//!   end less at the start, + `REFUND_RESERVE_BYTES`) × `env::storage_byte_cost()` + `register_deposit` + 1 yocto per
//!   `ft_transfer`, else `InsufficientStorageDeposit` and the whole call rolls back. Everything above the bytes,
//!   `register_deposit` and the yocto stays in the spend record's `reserve`, a same-size overwrite (no new byte).
//! - Row 15: `promise::pay_then_on_payout`.
//! - `on_payout(spend_index, to_recipient, fee)`, `#[private]`: the result count must be 1 when `fee == 0` and 2
//!   otherwise, else it panics before any read of state or any write. Each part is read by name as Successful (its
//!   content never read: an empty result, or one too long to read at `max_len` 0) or Failed; anything else panics
//!   (`promise::payout_results`). The returned sum `r` (the failed parts' amounts) sets the record to `refund_pending`
//!   with `refund_value = r`, or `paid` when `r = 0`; `totals.returned += r`; event `payout`.
//!
//! No event or log comes before the last refusal of a call (NEAR keeps a failed receipt's logs): `withdraw` logs
//! `leaf_inserted`, `withdrawn` and `withdrawal_relayed` only after row 14 and the promises of row 15.
//!
//! Ported from Privacy Pools v1.3.0's fee split (`Entrypoint.sol:159-169`, two transfers, `WithdrawalRelayed` at
//! :175) and `_push` (`PrivacyPoolComplex.sol:64-67`), Copyright 2025 0XBOW LTD, Apache-2.0. Deviations (vault.md
//! 2.7): an absolute fee (Dev 8), NEAR storage paid by the caller (Dev 3), and payouts as promises whose failed parts
//! become refund-pending amounts (Dev 4, Dev 9).

use crate::constants::{GAS_FT_TRANSFER_TGAS, GAS_ON_PAYOUT_TGAS, GAS_STORAGE_DEPOSIT_TGAS, REFUND_RESERVE_BYTES};
use crate::events::Event;
use crate::promise;
use crate::{Status, Vault, VaultExt};
use near_sdk::json_types::U128;
use near_sdk::{env, near, Gas};

/// The gas the pre-check keeps for the vault's own work, on top of the statics it hands on (2.5.2).
pub const GAS_OWN_WORK_TGAS: u64 = 100;

/// Σ static: the gas a withdrawal's payouts hand on (2.5.2 row 15).
pub fn statics_tgas(register_deposit: u128, fee: u128) -> u64 {
    let mut t = GAS_FT_TRANSFER_TGAS + GAS_ON_PAYOUT_TGAS;
    if register_deposit > 0 {
        t += GAS_STORAGE_DEPOSIT_TGAS;
    }
    if fee > 0 {
        t += GAS_FT_TRANSFER_TGAS;
    }
    t
}

/// The gas pre-check: `prepaid >= Σ static + 100 Tgas`, else `InsufficientGas`.
pub fn check_gas(prepaid: Gas, register_deposit: u128, fee: u128) {
    if prepaid < Gas::from_tgas(statics_tgas(register_deposit, fee) + GAS_OWN_WORK_TGAS) {
        env::panic_str("InsufficientGas: attach at least the payouts' static gas + 100 Tgas");
    }
}

/// Row 13: `to_recipient = withdrawn - fee`, at least 1.
pub fn split(withdrawn: u128, fee: u128) -> u128 {
    match withdrawn.checked_sub(fee) {
        Some(r) if r > 0 => r,
        _ => env::panic_str("RelayFeeGreaterThanMax"),
    }
}

/// 1 yocto per `ft_transfer`: one for the recipient, one more for the fee part.
pub fn transfers(fee: u128) -> u128 {
    if fee > 0 {
        2
    } else {
        1
    }
}

/// Row 14: what the record keeps in `reserve` (the attachment less bytes × price, `register_deposit` and the yocto),
/// or None when the attachment is under (bytes + `REFUND_RESERVE_BYTES`) × price + `register_deposit` + the yocto,
/// or a sum overflows.
pub fn reserve_after(attached: u128, bytes: u64, byte_cost: u128, register_deposit: u128, yocto: u128) -> Option<u128> {
    let charged = u128::from(bytes).checked_mul(byte_cost)?;
    let need = u128::from(REFUND_RESERVE_BYTES)
        .checked_mul(byte_cost)?
        .checked_add(charged)?
        .checked_add(register_deposit)?
        .checked_add(yocto)?;
    if attached < need {
        return None;
    }
    Some(attached - charged - register_deposit - yocto)
}

/// 2.5.4: (delivered, returned) of a payout from whether each part ran.
pub fn outcome(to_recipient: u128, fee: u128, recipient_ran: bool, fee_ran: bool) -> (u128, u128) {
    let (mut delivered, mut returned) = (0u128, 0u128);
    for (amount, ran) in [(to_recipient, recipient_ran), (fee, fee_ran)] {
        let into = if ran { &mut delivered } else { &mut returned };
        *into = into.checked_add(amount).unwrap_or_else(|| env::panic_str("InvalidPoolState"));
    }
    (delivered, returned)
}

impl Vault {
    /// Row 14, the last row that can refuse a withdrawal: the attachment against the bytes written since `usage0`,
    /// the reserve kept in the spend record by a same-size overwrite.
    pub(crate) fn charge_storage(&mut self, index: u64, usage0: u64, register_deposit: u128, fee: u128) {
        // a withdrawal only adds records; were usage ever lower, nothing is charged for it
        let bytes = env::storage_usage().saturating_sub(usage0);
        let reserve = reserve_after(
            env::attached_deposit().as_yoctonear(),
            bytes,
            env::storage_byte_cost().as_yoctonear(),
            register_deposit,
            transfers(fee),
        )
        .unwrap_or_else(|| {
            env::panic_str(
                "InsufficientStorageDeposit: attach (bytes written + REFUND_RESERVE_BYTES) x storage_byte_cost + register_deposit + 1 yocto per ft_transfer",
            )
        });
        let mut s = self.spends.get(index).unwrap_or_else(|| env::abort());
        s.reserve = reserve;
        self.spends.replace(index, &s);
    }
}

#[near]
impl Vault {
    /// 2.5.4: what each payout part delivered. The vault's own promise is its only caller (`#[private]`).
    #[private]
    pub fn on_payout(&mut self, spend_index: u64, to_recipient: U128, fee: U128) {
        // the count, then each result by name: any panic here comes before any read of state or write
        let (recipient_ran, fee_ran) = promise::payout_results(fee.0);
        let (delivered, returned) = outcome(to_recipient.0, fee.0, recipient_ran, fee_ran);
        let mut s = self.spends.get(spend_index).unwrap_or_else(|| env::panic_str("UnknownSpend"));
        if s.status != Status::InFlight {
            env::panic_str("SpendNotInFlight");
        }
        let total = self.totals.returned.0.checked_add(returned).unwrap_or_else(|| env::panic_str("InvalidPoolState"));
        s.status = if returned > 0 { Status::RefundPending } else { Status::Paid };
        s.refund_value = returned;
        self.spends.replace(spend_index, &s);
        self.totals.returned = U128(total);
        Event::Payout { nullifier_hash: &s.nullifier_hash, delivered, returned }.emit();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Spend;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::{AccountId, PromiseResult};
    use std::collections::BTreeMap;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    const VAULT: &str = "vault.test.near";
    const NULLIFIER: [u8; 32] = [7; 32];
    const PRICE: u128 = 10_000_000_000_000_000_000;

    fn id(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    /// A callback on the vault, from the vault, with `results`, on the storage the last call left.
    fn callback(results: Vec<PromiseResult>, from: &str) {
        near_sdk::testing_env!(
            VMContextBuilder::new().current_account_id(id(VAULT)).predecessor_account_id(id(from)).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            results
        );
    }

    /// A vault with one in-flight spend of `withdrawn` paying `fee`, on fresh storage.
    fn in_flight(withdrawn: u128, fee: u128) -> Vault {
        near_sdk::testing_env!(
            VMContextBuilder::new().current_account_id(id(VAULT)).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![]
        );
        near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
        let mut v = Vault::default();
        v.spends.push(&Spend {
            nullifier_hash: NULLIFIER,
            withdrawn,
            new_leaf_index: 6,
            refund_precommitment: [9; 32],
            refund_value: 0,
            refund_label: [0; 32],
            refund_leaf_index: 0,
            status: Status::InFlight,
            payer: id("relayer.test.near"),
            reserve: 3_890_000_000_000_000_000_000,
            recipient: id("alice.test.near"),
            fee,
            context: [5; 32],
        });
        v.totals.deposited = U128(31_000_000);
        v.totals.spent = U128(withdrawn);
        v
    }

    /// Every raw record the mocked chain holds; then a callback from the vault with `results` on the same records.
    fn raw_then(results: Vec<PromiseResult>) -> BTreeMap<Vec<u8>, Vec<u8>> {
        let s = near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
        let copy = s.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
            VMContextBuilder::new().current_account_id(id(VAULT)).predecessor_account_id(id(VAULT)).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            results,
            s,
            Default::default(),
            None,
        ));
        copy
    }

    /// `on_payout` with `results`: Ok, or its panic's text.
    fn on_payout(v: &mut Vault, results: Vec<PromiseResult>, to_recipient: u128, fee: u128) -> Result<(), String> {
        callback(results, VAULT);
        catch_unwind(AssertUnwindSafe(|| v.on_payout(0, U128(to_recipient), U128(fee))))
            .map_err(|e| e.downcast::<String>().map(|s| *s).unwrap_or_default())
    }

    fn payout_log(delivered: u128, returned: u128) -> String {
        let n = crate::field::to_decimal(&crate::field::from_be(&NULLIFIER));
        format!(
            r#"EVENT_JSON:{{"standard":"blindfill-vault","version":"1.0.0","event":"payout","data":[{{"nullifier_hash":"{n}","delivered":"{delivered}","returned":"{returned}"}}]}}"#
        )
    }

    fn ok(bytes: &[u8]) -> PromiseResult {
        PromiseResult::Successful(bytes.to_vec())
    }

    /// One case of VT-U06: the record, totals and log after the callback.
    fn lands(results: Vec<PromiseResult>, withdrawn: u128, fee: u128, want_returned: u128) {
        let mut v = in_flight(withdrawn, fee);
        let to_recipient = withdrawn - fee;
        on_payout(&mut v, results, to_recipient, fee).unwrap();
        let s = v.spends.get(0).unwrap();
        let want_status = if want_returned > 0 { Status::RefundPending } else { Status::Paid };
        assert_eq!((s.status, s.refund_value), (want_status, want_returned));
        assert_eq!(v.totals.returned.0, want_returned);
        assert_eq!(get_logs(), vec![payout_log(withdrawn - want_returned, want_returned)]);
        // nothing else in the record moved
        assert_eq!((s.withdrawn, s.fee, s.reserve, s.refund_leaf_index), (withdrawn, fee, 3_890_000_000_000_000_000_000, 0));
    }

    // VT-U06 (vault.md 5, V:1132): one part and two parts, each Successful or Failed; a long Successful result; a wrong
    // count.

    #[test]
    fn vt_u06_one_part_successful_or_failed() {
        lands(vec![ok(b"")], 1_000_000, 0, 0);
        lands(vec![PromiseResult::Failed], 1_000_000, 0, 1_000_000);
    }

    #[test]
    fn vt_u06_two_parts_return_exactly_the_failed_parts() {
        // withdrawn 2,000,000 with a fee of 500,000: to_recipient 1,500,000
        lands(vec![ok(b""), ok(b"")], 2_000_000, 500_000, 0);
        lands(vec![ok(b""), PromiseResult::Failed], 2_000_000, 500_000, 500_000);
        lands(vec![PromiseResult::Failed, ok(b"")], 2_000_000, 500_000, 1_500_000);
        lands(vec![PromiseResult::Failed, PromiseResult::Failed], 2_000_000, 500_000, 2_000_000);
    }

    #[test]
    fn vt_u06_a_successful_result_longer_than_64_bytes_counts_as_delivered() {
        lands(vec![ok(&[b'7'; 65])], 1_000_000, 0, 0);
        lands(vec![ok(&[b'7'; 100_000]), PromiseResult::Failed], 2_000_000, 500_000, 500_000);
        lands(vec![PromiseResult::Failed, ok(&[b'"'; 4096])], 2_000_000, 500_000, 1_500_000);
    }

    #[test]
    fn vt_u06_a_wrong_count_panics_with_nothing_written() {
        for (results, fee) in [
            (vec![], 0),
            (vec![ok(b""), ok(b"")], 0),
            (vec![], 500_000),
            (vec![ok(b"")], 500_000),
            (vec![PromiseResult::Failed], 500_000),
            (vec![ok(b""), ok(b""), ok(b"")], 500_000),
        ] {
            let n = results.len();
            let withdrawn = 2_000_000;
            let mut v = in_flight(withdrawn, fee);
            let (before, struct_before) = (raw_then(results), near_sdk::borsh::to_vec(&v).unwrap());
            let e = catch_unwind(AssertUnwindSafe(|| v.on_payout(0, U128(withdrawn - fee), U128(fee))))
                .map_err(|e| e.downcast::<String>().map(|s| *s).unwrap_or_default())
                .unwrap_err();
            assert!(e.contains("PayoutResults"), "{n} results with fee {fee}: {e}");
            assert_eq!(get_logs(), Vec::<String>::new(), "{n} results with fee {fee}: logged");
            assert!(raw_then(vec![]) == before, "{n} results with fee {fee}: a record changed");
            assert_eq!(near_sdk::borsh::to_vec(&v).unwrap(), struct_before, "{n} results with fee {fee}: the struct changed");
        }
    }

    /// `#[private]` is checked by the exported wrapper, which a unit test does not run: tests/payouts.rs calls it as a
    /// stranger in the sandbox. Here: a second callback on one spend is refused and changes nothing.
    #[test]
    fn a_second_callback_on_one_spend_is_refused() {
        let mut v = in_flight(1_000_000, 0);
        on_payout(&mut v, vec![PromiseResult::Failed], 1_000_000, 0).unwrap();
        let e = on_payout(&mut v, vec![ok(b"")], 1_000_000, 0).unwrap_err();
        assert!(e.contains("SpendNotInFlight"), "{e}");
        assert_eq!(get_logs(), Vec::<String>::new());
        assert_eq!((v.totals.returned.0, v.spends.get(0).unwrap().status), (1_000_000, Status::RefundPending));
    }

    #[test]
    fn the_callback_writes_no_new_byte() {
        let mut v = in_flight(2_000_000, 500_000);
        callback(vec![], VAULT);
        let before = env::storage_usage();
        on_payout(&mut v, vec![PromiseResult::Failed, ok(b"")], 1_500_000, 500_000).unwrap();
        assert_eq!(env::storage_usage(), before);
    }

    // The gas pre-check and rows 13-14 as functions; withdraw.rs's spend tests run them inside withdraw.

    #[test]
    fn the_gas_bound_is_the_statics_plus_100_tgas() {
        assert_eq!(statics_tgas(0, 0), 45);
        assert_eq!(statics_tgas(1, 0), 55);
        assert_eq!(statics_tgas(0, 1), 60);
        assert_eq!(statics_tgas(1, 1), 70);
        for (reg, fee) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
            let bound = Gas::from_tgas(statics_tgas(reg, fee) + 100);
            check_gas(bound, reg, fee);
            let short = Gas::from_gas(bound.as_gas() - Gas::from_tgas(1).as_gas());
            let e = catch_unwind(|| check_gas(short, reg, fee)).unwrap_err();
            assert!(e.downcast::<String>().unwrap().contains("InsufficientGas"), "{reg} {fee}");
            let e = catch_unwind(|| check_gas(Gas::from_gas(bound.as_gas() - 1), reg, fee)).unwrap_err();
            assert!(e.downcast::<String>().unwrap().contains("InsufficientGas"), "{reg} {fee} one gas under");
        }
    }

    #[test]
    fn row_13_splits_exactly() {
        assert_eq!(split(2_000_000, 500_000), 1_500_000);
        assert_eq!(split(1, 0), 1);
        assert_eq!(split(u128::MAX, u128::MAX / 2), u128::MAX - u128::MAX / 2);
        for (w, f) in [(1, 1), (5, 6), (0, 0)] {
            assert!(catch_unwind(|| split(w, f)).is_err(), "{w} {f}");
        }
    }

    #[test]
    fn row_14_needs_the_reserve_bytes_the_registration_and_a_yocto_per_transfer() {
        let reg = 1_250_000_000_000_000_000_000;
        for (reg, fee) in [(0, 0), (reg, 0), (0, 1), (reg, 1)] {
            let yocto = transfers(fee);
            let need = (614 + 389) * PRICE + reg + yocto;
            assert_eq!(reserve_after(need, 614, PRICE, reg, yocto), Some(389 * PRICE), "exactly the requirement");
            assert_eq!(reserve_after(need - 1, 614, PRICE, reg, yocto), None, "one yocto short");
            assert_eq!(reserve_after(need + 5, 614, PRICE, reg, yocto), Some(389 * PRICE + 5), "the rest is kept");
        }
        assert_eq!(transfers(0), 1);
        assert_eq!(transfers(1), 2);
        // no sum wraps
        assert_eq!(reserve_after(u128::MAX, u64::MAX, u128::MAX, 0, 1), None);
        assert_eq!(reserve_after(u128::MAX, 0, PRICE, u128::MAX, 1), None);
    }

    #[test]
    fn outcome_sums_the_parts() {
        assert_eq!(outcome(1_500_000, 500_000, true, true), (2_000_000, 0));
        assert_eq!(outcome(1_500_000, 500_000, true, false), (1_500_000, 500_000));
        assert_eq!(outcome(1_500_000, 500_000, false, true), (500_000, 1_500_000));
        assert_eq!(outcome(1_500_000, 500_000, false, false), (0, 2_000_000));
        assert_eq!(outcome(7, 0, false, true), (0, 7));
    }
}
