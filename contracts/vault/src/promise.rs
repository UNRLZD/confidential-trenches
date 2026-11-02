// SPDX-License-Identifier: Apache-2.0
//! The vault's only way to act outside its own state (vault.md 2.5, 2.5.2 row 15, 2.5.3 row 6, 2.5.4, 2.5.5 step 3).
//!
//! Every promise is made here with near-sdk's low-level `env::promise_batch_create`, `promise_batch_then`,
//! `promise_and`, `promise_batch_action_function_call_weight` and `promise_batch_action_transfer`, and results are read
//! with `env::promise_results_count` and `env::promise_result_checked`. Never the `Promise` type or `#[ext_contract]`:
//! their shared `PromiseAction::add` links every action host function, key and deploy actions included (vault.md 2.5),
//! which the import check of 2.8 refuses.
//!
//! The only methods sent: `storage_deposit` and `ft_transfer` to TOKEN, and `on_payout` to the vault itself. Never
//! `ft_transfer_call` (a payout with a message has no clean failed-or-moved answer, vault.md 2.5), never `approve` and
//! never `storage_unregister` (vault.md 2.5.7, 2.8).
//!
//! Ported from Privacy Pools v1.3.0's `_push` (`PrivacyPoolComplex.sol:64-67`) and the fee split's two transfers
//! (`Entrypoint.sol:167-169`), Copyright 2025 0XBOW LTD, Apache-2.0, as NEAR promises (Dev 4).

use crate::constants::{GAS_FT_TRANSFER_TGAS, GAS_ON_PAYOUT_TGAS, GAS_STORAGE_DEPOSIT_TGAS, TOKEN};
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{env, serde_json, AccountId, Gas, GasWeight, NearToken, PromiseError, PromiseIndex};

/// Unused gas is shared among the calls by weight 1 (vault.md 2.5.2 row 15).
const WEIGHT: GasWeight = GasWeight(1);
/// NEP-141's `ft_transfer` requires exactly 1 yocto (NCS4 `core_impl.rs` l.121-122).
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(GAS_FT_TRANSFER_TGAS);
pub const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(GAS_STORAGE_DEPOSIT_TGAS);
pub const GAS_ON_PAYOUT: Gas = Gas::from_tgas(GAS_ON_PAYOUT_TGAS);

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct StorageDeposit<'a> {
    account_id: &'a AccountId,
    registration_only: bool,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct FtTransfer<'a> {
    receiver_id: &'a AccountId,
    amount: U128,
}

/// `on_payout`'s arguments, the kit's `VaultOnPayoutArgs`.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct OnPayout {
    spend_index: u64,
    to_recipient: U128,
    fee: U128,
}

fn json<T: Serialize>(args: &T) -> Vec<u8> {
    serde_json::to_vec(args).unwrap_or_else(|_| env::abort())
}

fn token() -> AccountId {
    TOKEN.parse().unwrap_or_else(|_| env::abort())
}

/// One payout part: a receipt to TOKEN holding `[storage_deposit(account, registration_only) with register_deposit
/// when it is > 0, ft_transfer(account, amount) with 1 yocto]`. A receipt's actions fail together, so the part either
/// moves the whole amount or nothing (vault.md 2.5.4).
fn part(account: &AccountId, amount: u128, register_deposit: u128) -> PromiseIndex {
    let p = env::promise_batch_create(&token());
    if register_deposit > 0 {
        let args = json(&StorageDeposit { account_id: account, registration_only: true });
        env::promise_batch_action_function_call_weight(
            p,
            "storage_deposit",
            &args,
            NearToken::from_yoctonear(register_deposit),
            GAS_STORAGE_DEPOSIT,
            WEIGHT,
        );
    }
    let args = json(&FtTransfer { receiver_id: account, amount: U128(amount) });
    env::promise_batch_action_function_call_weight(p, "ft_transfer", &args, ONE_YOCTO, GAS_FT_TRANSFER, WEIGHT);
    p
}

/// The payouts of a spend (vault.md 2.5.2 row 15; ragequit's with `fee = 0`, 2.5.3 row 6): part 0 pays `to_recipient`
/// to `recipient`, with `register_deposit` for its registration; part 1, only when `fee > 0`, pays `fee` to
/// `fee_recipient`; `promise_and` of the parts, then `on_payout(spend_index, to_recipient, fee)` on the vault. Every
/// state write comes before this call (vault.md 2.5).
pub fn pay_then_on_payout(
    spend_index: u64,
    recipient: &AccountId,
    to_recipient: u128,
    register_deposit: u128,
    fee_recipient: &AccountId,
    fee: u128,
) -> PromiseIndex {
    let p0 = part(recipient, to_recipient, register_deposit);
    let after = if fee > 0 { env::promise_and(&[p0, part(fee_recipient, fee, 0)]) } else { p0 };
    let cb = env::promise_batch_then(after, &env::current_account_id());
    let args = json(&OnPayout { spend_index, to_recipient: U128(to_recipient), fee: U128(fee) });
    env::promise_batch_action_function_call_weight(
        cb,
        "on_payout",
        &args,
        NearToken::from_yoctonear(0),
        GAS_ON_PAYOUT,
        WEIGHT,
    );
    cb
}

/// `on_payout`'s results (vault.md 2.5.4): whether the recipient part and the fee part delivered. The count must be 1
/// when `fee == 0` and 2 otherwise, else it panics before anything is written. Each part is read only as Successful
/// or Failed: its content is never read (`max_len` 0), so a result too long to read counts as Successful. With no fee
/// part, the second is `true` (nothing to return).
pub fn payout_results(fee: u128) -> (bool, bool) {
    read_parts(env::promise_results_count(), fee, part_ran)
}

/// Whether result `i` is Successful, its content never read: each outcome by name, and any other panics (fails
/// closed: a result the vault cannot name is never counted as paid, nor as returned).
fn part_ran(i: u64) -> bool {
    match env::promise_result_checked(i, 0) {
        // Successful with an empty result (a plain ft_transfer returns nothing)
        Ok(_) => true,
        // Successful with a result longer than max_len 0: its content is never read
        Err(PromiseError::TooLong(_)) => true,
        Err(PromiseError::Failed) => false,
        // PromiseError is #[non_exhaustive]: a variant a later near-sdk adds
        Err(_) => env::panic_str("PayoutResults: a result that is neither Successful nor Failed"),
    }
}

/// `payout_results` with the host reads passed in, so the rule is tested apart from the mocked host.
fn read_parts(count: u64, fee: u128, ran: impl Fn(u64) -> bool) -> (bool, bool) {
    let want = if fee > 0 { 2 } else { 1 };
    if count != want {
        env::panic_str("PayoutResults: want 1 result without a fee, 2 with one");
    }
    (ran(0), fee == 0 || ran(1))
}

/// A plain NEAR Transfer (vault.md 2.5.5 step 3: the reserve's rest to the payer, the caller's unused attachment back
/// to the caller). Nothing is made for 0.
pub fn transfer_near(to: &AccountId, yocto: u128) {
    if yocto > 0 {
        let p = env::promise_batch_create(to);
        env::promise_batch_action_transfer(p, NearToken::from_yoctonear(yocto));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult};

    const VAULT: &str = "vault.confidential.unrlzd.near";

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn at_vault() {
        testing_env!(VMContextBuilder::new().current_account_id(acct(VAULT)).build());
    }

    #[allow(deprecated)]
    fn with_result(result: PromiseResult) {
        let ctx = VMContextBuilder::new().current_account_id(acct(VAULT)).predecessor_account_id(acct(VAULT)).build();
        near_sdk::test_utils::testing_env_with_promise_results(ctx, result);
    }

    /// (method, args as text, deposit in yocto, static gas in Tgas, weight) of a function call action
    fn call(a: &MockAction) -> (String, String, u128, u64, u64) {
        match a {
            MockAction::FunctionCallWeight { method_name, args, attached_deposit, prepaid_gas, gas_weight, .. } => (
                String::from_utf8(method_name.clone()).unwrap(),
                String::from_utf8(args.clone()).unwrap(),
                attached_deposit.as_yoctonear(),
                prepaid_gas.as_tgas(),
                gas_weight.0,
            ),
            other => panic!("not a function call: {other:?}"),
        }
    }

    fn c(m: &str, args: &str, deposit: u128, tgas: u64) -> (String, String, u128, u64, u64) {
        (m.to_string(), args.to_string(), deposit, tgas, 1)
    }

    #[test]
    fn relayed_withdrawal_with_registration_and_fee() {
        at_vault();
        let (bob, relayer) = (acct("bob.near"), acct("relayer.confidential.unrlzd.near"));
        pay_then_on_payout(7, &bob, 970_000, 1_250_000_000_000_000_000_000, &relayer, 30_000);
        let r = get_created_receipts();
        assert_eq!(r.len(), 3, "{r:?}");
        // part 0: the recipient, registration then transfer, in one receipt
        assert_eq!(r[0].receiver_id.as_str(), TOKEN);
        assert!(r[0].receipt_indices.is_empty());
        let a0: Vec<_> = r[0].actions.iter().map(call).collect();
        assert_eq!(
            a0,
            vec![
                c(
                    "storage_deposit",
                    r#"{"account_id":"bob.near","registration_only":true}"#,
                    1_250_000_000_000_000_000_000,
                    10
                ),
                c("ft_transfer", r#"{"receiver_id":"bob.near","amount":"970000"}"#, 1, 15),
            ]
        );
        // part 1: the fee
        assert_eq!(r[1].receiver_id.as_str(), TOKEN);
        assert!(r[1].receipt_indices.is_empty());
        let a1: Vec<_> = r[1].actions.iter().map(call).collect();
        assert_eq!(
            a1,
            vec![c("ft_transfer", r#"{"receiver_id":"relayer.confidential.unrlzd.near","amount":"30000"}"#, 1, 15)]
        );
        // the callback on the vault, after both parts, in the order [part 0, part 1]. The mock numbers a receipt by its
        // place in its action log (near-vm-runner 0.37.4 mock_external.rs l.241): part 0 is entry 0, its two calls
        // entries 1-2, part 1 entry 3.
        assert_eq!(r[2].receiver_id.as_str(), VAULT);
        assert_eq!(r[2].receipt_indices, vec![0, 3]);
        let a2: Vec<_> = r[2].actions.iter().map(call).collect();
        assert_eq!(a2, vec![c("on_payout", r#"{"spend_index":7,"to_recipient":"970000","fee":"30000"}"#, 0, 30)]);
    }

    #[test]
    fn no_fee_and_no_registration_is_one_transfer_then_the_callback() {
        at_vault();
        let bob = acct("bob.near");
        pay_then_on_payout(0, &bob, u128::MAX - 1, 0, &bob, 0);
        let r = get_created_receipts();
        assert_eq!(r.len(), 2, "{r:?}");
        assert_eq!(r[0].receiver_id.as_str(), TOKEN);
        let a0: Vec<_> = r[0].actions.iter().map(call).collect();
        assert_eq!(
            a0,
            vec![c(
                "ft_transfer",
                r#"{"receiver_id":"bob.near","amount":"340282366920938463463374607431768211454"}"#,
                1,
                15
            )]
        );
        assert_eq!(r[1].receiver_id.as_str(), VAULT);
        assert_eq!(r[1].receipt_indices, vec![0]);
        let a1: Vec<_> = r[1].actions.iter().map(call).collect();
        assert_eq!(
            a1,
            vec![c(
                "on_payout",
                r#"{"spend_index":0,"to_recipient":"340282366920938463463374607431768211454","fee":"0"}"#,
                0,
                30
            )]
        );
    }

    #[test]
    fn the_only_methods_sent_are_storage_deposit_ft_transfer_and_on_payout() {
        at_vault();
        let (a, b) = (acct("a.near"), acct("b.near"));
        pay_then_on_payout(1, &a, 1, 1, &b, 1);
        transfer_near(&a, 1);
        let mut methods: Vec<String> = Vec::new();
        for r in get_created_receipts() {
            for x in &r.actions {
                match x {
                    MockAction::FunctionCallWeight { method_name, .. } => {
                        methods.push(String::from_utf8(method_name.clone()).unwrap())
                    }
                    MockAction::Transfer { .. } => methods.push("<transfer>".into()),
                    other => panic!("an action the vault never makes: {other:?}"),
                }
            }
        }
        assert_eq!(methods, ["storage_deposit", "ft_transfer", "ft_transfer", "on_payout", "<transfer>"]);
    }

    #[test]
    fn transfer_near_is_one_plain_transfer_and_nothing_for_zero() {
        at_vault();
        let payer = acct("relayer.confidential.unrlzd.near");
        transfer_near(&payer, 0);
        assert!(get_created_receipts().is_empty());
        transfer_near(&payer, 3_890_000_000_000_000_000_000);
        let r = get_created_receipts();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].receiver_id, payer);
        assert!(
            matches!(r[0].actions.as_slice(), [MockAction::Transfer { deposit, .. }] if deposit.as_yoctonear() == 3_890_000_000_000_000_000_000)
        );
    }

    // The host read with one result here, the two-part rule through read_parts; src/payout.rs's tests run on_payout
    // on two mocked results (testing_env! with near_sdk::RuntimeFeesConfig::test()).

    #[test]
    fn payout_results_reads_one_result_as_success_or_failure_only() {
        with_result(PromiseResult::Successful(b"\"x\"".to_vec()));
        assert_eq!(payout_results(0), (true, true));
        with_result(PromiseResult::Failed);
        assert_eq!(payout_results(0), (false, true));
        // a long result is not read, and counts as Successful
        with_result(PromiseResult::Successful(vec![b'7'; 100_000]));
        assert_eq!(payout_results(0), (true, true));
        with_result(PromiseResult::Successful(Vec::new()));
        assert_eq!(payout_results(0), (true, true));
    }

    #[test]
    #[should_panic(expected = "PayoutResults")]
    fn one_result_with_a_fee_panics() {
        with_result(PromiseResult::Successful(Vec::new()));
        payout_results(1);
    }

    #[test]
    fn two_parts_are_read_in_order_recipient_then_fee() {
        let from = |r: [bool; 2]| move |i: u64| r[i as usize];
        at_vault();
        assert_eq!(read_parts(2, 5, from([true, true])), (true, true));
        assert_eq!(read_parts(2, 5, from([false, true])), (false, true));
        assert_eq!(read_parts(2, 5, from([true, false])), (true, false));
        assert_eq!(read_parts(2, 5, from([false, false])), (false, false));
        // without a fee the second result is never read
        assert_eq!(read_parts(1, 0, |i| if i == 0 { true } else { panic!("read result {i}") }), (true, true));
    }

    #[test]
    #[should_panic(expected = "PayoutResults")]
    fn two_results_without_a_fee_panic() {
        at_vault();
        read_parts(2, 0, |_| true);
    }

    #[test]
    #[should_panic(expected = "PayoutResults")]
    fn no_result_panics() {
        at_vault();
        read_parts(0, 0, |_| true);
    }
}
