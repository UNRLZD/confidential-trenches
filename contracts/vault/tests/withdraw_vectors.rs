// SPDX-License-Identifier: Apache-2.0
//! The withdrawal refusals the vault and the kit share (card vault-withdraw-context): `withdrawal_refusals` in
//! packages/kit/test/vectors/vault-v1.json, which packages/kit/test/vault-shapes.test.mjs also reads (the kit's
//! `vaultWithdrawalProblems` names each one). Here `withdraw`'s first argument, `withdraw::Withdrawal`, must refuse each
//! vector's JSON when the call is read, and take it once the vector's key is gone.

use blindfill_vault::withdraw::Withdrawal;
use near_sdk::serde_json::{self, Value};

const VECTORS: &str = include_str!("../../../packages/kit/test/vectors/vault-v1.json");

#[test]
fn every_shared_withdrawal_refusal_is_refused_when_the_call_is_read() {
    let v: Value = serde_json::from_str(VECTORS).expect("vault-v1.json is JSON");
    let rows = v["withdrawal_refusals"].as_array().expect("withdrawal_refusals: an array");
    assert_eq!(rows.len(), 1);
    for r in rows {
        let st = |k: &str| r[k].as_str().unwrap_or_else(|| panic!("{k}: a string in {r}"));
        let (name, json) = (st("name"), st("json"));
        let e = serde_json::from_str::<Withdrawal>(json).expect_err(name).to_string();
        assert!(e.contains(st("vault")), "{name}: want {:?}, got {e:?}", st("vault"));
        let mut w: Value = serde_json::from_str(json).expect(name);
        assert!(w.as_object_mut().expect(name).remove(st("key")).is_some(), "{name}: the key is in the vector");
        serde_json::from_value::<Withdrawal>(w).unwrap_or_else(|e| panic!("{name}: without the key: {e}"));
    }
}
