// SPDX-License-Identifier: Apache-2.0
//! The harness's probe contract: the receipt shapes the vault makes, on demand, so the harness's own tests
//! (tests/smoke.rs, `harness_*`) prove each of its checks fails where it must (review of 1 Nov at 65f3bb7, probes
//! P1-P4). Test-only: deployed only into a local near-sandbox, every method open to every caller.
//!
//! - `probe_chain`: `probe_first` then `probe_cb` on this account, returned as the call's result or detached. Detached
//!   is the vault's withdraw, ragequit and settle shape (vault.md 2.8: the payout chain is never returned), so a
//!   callback panic there never reaches the transaction's final status.
//! - `probe_part`: one receipt to `token` holding [storage_deposit, ft_transfer], the vault's payout part 0 shape.
//! - `probe_verify_withdraw`: the vault's own src/verifier.rs (with src/field.rs and src/verifier_keys.rs, included by
//!   path, so the bytes are the vault's) on a withdraw proof, logging the gas of each step (tests/groth16.rs).

#[allow(dead_code)]
#[path = "../../../../src/field.rs"]
mod field;
#[allow(dead_code)]
#[path = "../../../../src/verifier.rs"]
mod verifier;
#[allow(dead_code)]
#[path = "../../../../src/verifier_keys.rs"]
mod verifier_keys;

use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, to_vec, Value};
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise, PromiseOrValue};

#[near(contract_state)]
#[derive(Default)]
pub struct Probe {}

fn args(v: Value) -> Vec<u8> {
    to_vec(&v).unwrap_or_else(|_| env::panic_str("ProbeArgs"))
}

#[near]
impl Probe {
    /// `probe_first(first_fails)` then `probe_cb(boom)` on this account; the chain is the call's result when
    /// `returned`, else detached and the call returns 7.
    pub fn probe_chain(&mut self, first_fails: bool, boom: bool, returned: bool) -> PromiseOrValue<U128> {
        let me = env::current_account_id();
        let zero = NearToken::from_yoctonear(0);
        let p = Promise::new(me.clone())
            .function_call("probe_first", args(json!({"fail": first_fails})), zero, Gas::from_tgas(5))
            .then(Promise::new(me).function_call("probe_cb", args(json!({"boom": boom})), zero, Gas::from_tgas(5)));
        if returned {
            p.into()
        } else {
            p.detach();
            PromiseOrValue::Value(U128(7))
        }
    }

    pub fn probe_first(&mut self, fail: bool) {
        if fail {
            env::panic_str("ProbeFirstFail");
        }
    }

    pub fn probe_cb(&mut self, boom: bool) -> U128 {
        if boom {
            env::panic_str("ProbeCallbackPanic");
        }
        U128(9)
    }

    /// The vault's Groth16 verify of a withdraw proof, as the withdraw will run it: parse the 8 signals (row 1), encode
    /// the proof, verify (row 10). Logs `parse+encode` and `verify` gas (`env::used_gas()` deltas).
    pub fn probe_verify_withdraw(&self, proof: verifier::Proof, public_signals: Vec<String>) -> bool {
        let g0 = env::used_gas().as_gas();
        let s: Vec<field::U256> = public_signals
            .iter()
            .map(|x| {
                let n = field::parse_decimal(x)
                    .unwrap_or_else(|| env::panic_str("InvalidNumber: a public signal is not a canonical decimal"));
                if field::ge(&n, &field::P) {
                    env::panic_str("FieldOverflow: a public signal is not below p");
                }
                n
            })
            .collect();
        let s: [field::U256; 8] = s.try_into().unwrap_or_else(|_| env::panic_str("want 8 public signals"));
        let e = proof.encode();
        let g1 = env::used_gas().as_gas();
        let ok = verifier::verify_withdraw(&e, &s);
        let g2 = env::used_gas().as_gas();
        env::log_str(&format!("parse+encode {} gas, verify {} gas", g1 - g0, g2 - g1));
        ok
    }

    /// One receipt to `token`: [storage_deposit(account) with `register_deposit`, ft_transfer(account, amount) with 1
    /// yocto], paid from this account's own token balance.
    pub fn probe_part(&mut self, token: AccountId, account: AccountId, amount: U128, register_deposit: U128) {
        Promise::new(token)
            .function_call(
                "storage_deposit",
                args(json!({"account_id": account, "registration_only": true})),
                NearToken::from_yoctonear(register_deposit.0),
                Gas::from_tgas(10),
            )
            .function_call(
                "ft_transfer",
                args(json!({"receiver_id": account, "amount": amount})),
                NearToken::from_yoctonear(1),
                Gas::from_tgas(15),
            )
            .detach();
    }
}
