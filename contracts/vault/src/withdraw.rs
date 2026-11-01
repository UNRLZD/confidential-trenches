// SPDX-License-Identifier: Apache-2.0
//! `withdraw(withdrawal, proof, public_signals)` (vault.md 2.5.2), its parse and check part: rows 1 to 3, in that
//! order, every one before any proof is verified, anything is spent or any byte is written.
//!
//! - Row 1, the parse. The call's JSON is read strictly: `withdrawal` has exactly the seven fields of 7.1, no other
//!   and none twice; `proof` is `verifier::Proof`; `public_signals` exactly 8 strings. Then every number, each to its
//!   one value: the 8 proof coordinates canonical decimals below q (`InvalidNumber`, `InvalidProofEncoding`), the 8
//!   public signals canonical decimals below p (`InvalidNumber`, `FieldOverflow`), `refund_precommitment` a canonical
//!   decimal in 1..p-1 (`InvalidNumber`, `FieldOverflow`, `InvalidRefundPrecommitment` for 0), `register_deposit` and
//!   `relay_fee` canonical decimals below 2^128 (`InvalidNumber`, `AmountOverflow`), `salt` exactly 32 lowercase hex
//!   characters (`context::salt_from_hex`, else `InvalidSalt`), and `deadline_ms` a JSON integer 0..2^64-1 (serde's
//!   u64: a string, a fraction, an exponent, a sign or 2^64 is refused when the call's JSON is read). So each value the
//!   context hashes has one JSON spelling, as the kit writes it (`packages/kit/src/vault/shapes.ts`, `vaultDecimal`,
//!   `salt`, `vaultContextInput`).
//! - Row 2: `env::block_timestamp_ms() <= deadline_ms` (`DeadlineExpired`), then `recipient` and `fee_recipient` are
//!   neither this vault nor `INTENTS` (`InvalidRecipient`). The clock is the block the withdraw receipt runs in:
//!   nearcore's block timestamp in ns, divided by 1,000,000 and rounded down (near-sdk 5.29.1 `env.rs` l.390-392).
//! - Row 3: `context == keccak256(borsh(ContextFields) ‖ scope_be32) mod p`, with `processor` this vault and `scope`
//!   this vault's (`ContextMismatch`). The fields are hashed as parsed, in 7.1's order (`context::ContextFields`).
//!
//! Rows 4 to 15 (depths, roots, the amount checks, the proof, the nullifier, the change leaf, storage and payouts) are
//! card vault-withdraw-verify's and the cards after it. Until they land, a request that passes rows 1-3 is refused with
//! `WithdrawIncomplete`: the call panics, so nothing is written and the attached NEAR goes back to the signer.
//!
//! Ported from Privacy Pools v1.3.0 `packages/contracts/src/contracts/PrivacyPool.sol:44-48` (`withdraw`'s
//! `validWithdrawal`: the processooor and the context) and `Entrypoint.sol:133-141` (`relay`), Copyright 2025 0XBOW
//! LTD, Apache-2.0. Deviations (vault.md 2.7): Dev 5 (the request in Borsh, the processor this vault), Dev 6 (the
//! canonical parse), Dev 10 (the deadline).

use crate::constants::INTENTS;
use crate::context::{context_of, salt_from_hex, ContextFields};
use crate::field::{self, U256};
use crate::verifier::{EncodedProof, Proof};
use crate::{Vault, VaultExt};
use near_sdk::{env, near, AccountId};

/// The index of `context` in the withdraw circuit's public signals (snarkjs order, 2.5.2).
pub const SIGNAL_CONTEXT: usize = 7;

/// `withdraw`'s first argument as the call's JSON carries it (7.1, frozen with the kit's `VaultWithdrawal`).
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Withdrawal {
    pub recipient: AccountId,
    /// NEAR in yocto for the recipient's token registration, a canonical decimal below 2^128
    pub register_deposit: String,
    pub fee_recipient: AccountId,
    /// the fee in the token's base units, a canonical decimal below 2^128
    pub relay_fee: String,
    /// a canonical decimal in 1..p-1
    pub refund_precommitment: String,
    /// in the vault's block time, ms
    pub deadline_ms: u64,
    /// 16 bytes as exactly 32 lowercase hex characters
    pub salt: String,
}

/// A request that passed rows 1-3: the context's fields as hashed, the proof in the host functions' bytes and the 8
/// public signals as numbers.
pub struct Checked {
    pub fields: ContextFields,
    pub proof: EncodedProof,
    pub signals: [U256; 8],
}

/// A canonical decimal's number, or `InvalidNumber` naming `what`.
fn number(s: &str, what: &str) -> U256 {
    field::parse_decimal(s).unwrap_or_else(|| env::panic_str(&format!("InvalidNumber: {what} is not a canonical decimal")))
}

/// A public signal: a canonical decimal below p.
fn signal(s: &str) -> U256 {
    let n = number(s, "a public signal");
    if field::ge(&n, &field::P) {
        env::panic_str("FieldOverflow: a public signal is not below p");
    }
    n
}

/// An amount: a canonical decimal below 2^128.
fn amount(s: &str, what: &str) -> u128 {
    let n = number(s, what);
    if n[0] != 0 || n[1] != 0 {
        env::panic_str(&format!("AmountOverflow: {what} is not below 2^128"));
    }
    ((n[2] as u128) << 64) | n[3] as u128
}

/// Rows 1-3 of 2.5.2 for this vault (`processor`, `scope`) at block time `now_ms`; any failure panics.
pub fn check_request(
    w: &Withdrawal,
    proof: &Proof,
    public_signals: &[String; 8],
    processor: &AccountId,
    scope: &U256,
    now_ms: u64,
) -> Checked {
    // row 1: every number to its one value, the proof first
    let proof = proof.encode();
    let signals = public_signals.each_ref().map(|s| signal(s));
    let refund = number(&w.refund_precommitment, "refund_precommitment");
    if field::ge(&refund, &field::P) {
        env::panic_str("FieldOverflow: refund_precommitment is not below p");
    }
    if refund == [0; 4] {
        env::panic_str("InvalidRefundPrecommitment: refund_precommitment is 0");
    }
    let register_deposit = amount(&w.register_deposit, "register_deposit");
    let relay_fee = amount(&w.relay_fee, "relay_fee");
    let salt = salt_from_hex(&w.salt).unwrap_or_else(|| env::panic_str("InvalidSalt: want exactly 32 lowercase hex characters"));

    // row 2: the deadline, then the two payees
    if now_ms > w.deadline_ms {
        env::panic_str(&format!("DeadlineExpired: block time {now_ms} ms is past deadline_ms {}", w.deadline_ms));
    }
    for (what, id) in [("recipient", &w.recipient), ("fee_recipient", &w.fee_recipient)] {
        if id == processor || id.as_str() == INTENTS {
            env::panic_str(&format!("InvalidRecipient: {what} is the vault or {INTENTS}"));
        }
    }

    // row 3: the context, recomputed in 7.1's order
    let fields = ContextFields {
        processor: processor.clone(),
        recipient: w.recipient.clone(),
        register_deposit,
        fee_recipient: w.fee_recipient.clone(),
        relay_fee,
        refund_precommitment: field::to_be(&refund),
        deadline_ms: w.deadline_ms,
        salt,
    };
    if context_of(&fields, scope) != signals[SIGNAL_CONTEXT] {
        env::panic_str("ContextMismatch: the proof's context is not this request's");
    }
    Checked { fields, proof, signals }
}

#[near]
impl Vault {
    /// Rows 1-3 of 2.5.2 on the request, at this block's time; a request that passes them is refused with
    /// `WithdrawIncomplete` until rows 4-15 land (card vault-withdraw-verify), so nothing is spent or written.
    #[payable]
    pub fn withdraw(&mut self, withdrawal: Withdrawal, proof: Proof, public_signals: [String; 8]) {
        let _checked = check_request(
            &withdrawal,
            &proof,
            &public_signals,
            &env::current_account_id(),
            &crate::scope(),
            env::block_timestamp_ms(),
        );
        env::panic_str("WithdrawIncomplete: the request passed rows 1-3; rows 4-15 are not built, so nothing is spent");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::{self, json, Value};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    /// VT-U02's one vector file, made by the kit's shapes.ts.
    const VECTORS: &str = include_str!("../../../packages/kit/test/vectors/vault-v1.json");
    const VAULT: &str = "vault.confidential.unrlzd.near";
    const P_DEC: &str = "21888242871839275222246405745257275088548364400416034343698204186575808495617";
    const Q_DEC: &str = "21888242871839275222246405745257275088696311157297823662689037894645226208583";
    const DEADLINE: u64 = 1_793_750_400_000;

    fn id(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn env_at(vault: &str, block_ns: u64) {
        testing_env!(VMContextBuilder::new().current_account_id(id(vault)).block_timestamp(block_ns).build());
    }

    /// A proof whose coordinates parse (row 1); rows 1-3 never verify it.
    fn proof() -> Proof {
        Proof { a: ["1".into(), "2".into()], b: [["3".into(), "4".into()], ["5".into(), "6".into()]], c: ["7".into(), "8".into()] }
    }

    fn base() -> Withdrawal {
        Withdrawal {
            recipient: id("98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de"),
            register_deposit: "1250000000000000000000".into(),
            fee_recipient: id("relayer.confidential.unrlzd.near"),
            relay_fee: "30000".into(),
            refund_precommitment: "123456789012345678901234567890".into(),
            deadline_ms: DEADLINE,
            salt: "0123456789abcdef0123456789abcdef".into(),
        }
    }

    /// The context `w` hashes to for `processor` and `scope`, as a decimal (the vault's own code, after row 1's parse).
    fn context(w: &Withdrawal, processor: &str, scope: &U256) -> String {
        env_at(VAULT, 0);
        let fields = ContextFields {
            processor: id(processor),
            recipient: w.recipient.clone(),
            register_deposit: w.register_deposit.parse().unwrap(),
            fee_recipient: w.fee_recipient.clone(),
            relay_fee: w.relay_fee.parse().unwrap(),
            refund_precommitment: field::to_be(&field::from_decimal(&w.refund_precommitment).unwrap()),
            deadline_ms: w.deadline_ms,
            salt: salt_from_hex(&w.salt).unwrap(),
        };
        field::to_decimal(&context_of(&fields, scope))
    }

    fn signals(ctx: &str) -> [String; 8] {
        ["1", "2", "3", "4", "5", "6", "7", ctx].map(String::from)
    }

    fn scope() -> U256 {
        env_at(VAULT, 0);
        crate::scope_for(VAULT, crate::constants::TOKEN)
    }

    /// `check_request` at `VAULT` and `now_ms`: Ok, or the panic's text (near-sdk's mock wraps the message as
    /// `HostError(GuestPanic { panic_msg: "<message>" })`).
    fn check(w: &Withdrawal, p: &Proof, s: &[String; 8], now_ms: u64) -> Result<ContextFields, String> {
        let (w, p, s, sc) = (w.clone(), p.clone(), s.clone(), scope());
        std::panic::catch_unwind(move || {
            env_at(VAULT, 0);
            check_request(&w, &p, &s, &id(VAULT), &sc, now_ms).fields
        })
        .map_err(|e| e.downcast::<String>().map(|s| *s).unwrap_or_default())
    }

    fn refused(w: &Withdrawal, p: &Proof, s: &[String; 8], now_ms: u64, want: &str) {
        match check(w, p, s, now_ms) {
            Ok(f) => panic!("passed, want {want}: {f:?}"),
            Err(e) => assert!(e.contains(want), "want {want}, got {e:?}"),
        }
    }

    /// The `withdraw` method itself at `VAULT` with the block's timestamp `block_ns`: its panic's text.
    fn withdraw_at(w: &Withdrawal, s: &[String; 8], block_ns: u64) -> String {
        let (w, s) = (w.clone(), s.clone());
        std::panic::catch_unwind(move || {
            env_at(VAULT, block_ns);
            Vault::default().withdraw(w, proof(), s);
        })
        .map_err(|e| e.downcast::<String>().map(|s| *s).unwrap_or_default())
        .expect_err("withdraw never returns until rows 4-15 land")
    }

    #[test]
    fn the_unchanged_request_passes_rows_1_to_3() {
        let w = base();
        let ctx = context(&w, VAULT, &scope());
        let f = check(&w, &proof(), &signals(&ctx), DEADLINE).unwrap();
        assert_eq!(f.processor.as_str(), VAULT);
        assert_eq!(f.register_deposit, 1_250_000_000_000_000_000_000);
        assert_eq!(f.relay_fee, 30_000);
        assert_eq!(f.salt[..2], [0x01, 0x23]);
    }

    // VT-S07 (V:1134), one test per field: the proof carries the context of `base()`; the request then changes one field.

    fn changed(f: impl FnOnce(&mut Withdrawal)) {
        let w = base();
        let s = signals(&context(&w, VAULT, &scope()));
        let mut c = w.clone();
        f(&mut c);
        assert_ne!(c, w);
        refused(&c, &proof(), &s, 0, "ContextMismatch");
    }

    #[test]
    fn vt_s07_recipient_changed_is_refused() {
        changed(|w| w.recipient = id("thief.near"));
    }
    #[test]
    fn vt_s07_register_deposit_changed_is_refused() {
        changed(|w| w.register_deposit = "0".into());
    }
    #[test]
    fn vt_s07_fee_recipient_changed_is_refused() {
        changed(|w| w.fee_recipient = id("other-relayer.near"));
    }
    #[test]
    fn vt_s07_relay_fee_changed_is_refused() {
        changed(|w| w.relay_fee = "30001".into());
    }
    #[test]
    fn vt_s07_refund_precommitment_changed_is_refused() {
        changed(|w| w.refund_precommitment = "123456789012345678901234567891".into());
    }
    #[test]
    fn vt_s07_deadline_changed_is_refused() {
        changed(|w| w.deadline_ms += 60_000);
    }
    #[test]
    fn vt_s07_salt_changed_is_refused() {
        changed(|w| w.salt = "0123456789abcdef0123456789abcdee".into());
    }
    #[test]
    fn vt_s07_processor_changed_is_refused() {
        // a proof made for another vault on the same token: its context names that vault
        let w = base();
        let s = signals(&context(&w, "other-vault.near", &scope()));
        refused(&w, &proof(), &s, 0, "ContextMismatch");
    }
    #[test]
    fn vt_s07_scope_changed_is_refused() {
        let w = base();
        env_at(VAULT, 0);
        let other = crate::scope_for(VAULT, "other-token.near");
        refused(&w, &proof(), &signals(&context(&w, VAULT, &other)), 0, "ContextMismatch");
    }

    // VT-S18 (V:1145) at the exact boundary, through the method and near-sdk's own block_timestamp_ms.

    #[test]
    fn vt_s18_at_the_deadline_passes_and_one_ms_after_is_refused() {
        let w = base();
        let s = signals(&context(&w, VAULT, &scope()));
        let ms = 1_000_000u64;
        for (block_ns, want) in [
            (0, "WithdrawIncomplete"),
            ((DEADLINE - 1) * ms, "WithdrawIncomplete"),
            (DEADLINE * ms, "WithdrawIncomplete"),
            // the same ms, its last ns: block_timestamp_ms rounds down
            (DEADLINE * ms + 999_999, "WithdrawIncomplete"),
            ((DEADLINE + 1) * ms, "DeadlineExpired"),
            (u64::MAX, "DeadlineExpired"),
        ] {
            let e = withdraw_at(&w, &s, block_ns);
            assert!(e.contains(want), "block {block_ns} ns: want {want}, got {e:?}");
        }
        let e = withdraw_at(&w, &s, (DEADLINE + 1) * ms);
        let want = format!("DeadlineExpired: block time {} ms is past deadline_ms {DEADLINE}", DEADLINE + 1);
        assert!(e.contains(&format!("\"{want}\"")), "{e:?}");
    }

    #[test]
    fn deadline_u64_max_never_expires_and_0_expires_after_the_first_ms() {
        let mut w = base();
        w.deadline_ms = u64::MAX;
        let s = signals(&context(&w, VAULT, &scope()));
        assert!(withdraw_at(&w, &s, u64::MAX).contains("WithdrawIncomplete"));
        w.deadline_ms = 0;
        let s = signals(&context(&w, VAULT, &scope()));
        assert!(withdraw_at(&w, &s, 999_999).contains("WithdrawIncomplete"));
        assert!(withdraw_at(&w, &s, 1_000_000).contains("DeadlineExpired"));
    }

    // The card's refusals (the vault-scope-label-context review): refund_precommitment 0 or >= p, a salt that
    // salt_from_hex refuses, the deadline's form; and every other number's form.

    #[test]
    fn refund_precommitment_0_p_and_above_are_refused() {
        let s = signals("1");
        for (v, want) in [
            ("0", "InvalidRefundPrecommitment"),
            (P_DEC, "FieldOverflow"),
            ("21888242871839275222246405745257275088548364400416034343698204186575808495618", "FieldOverflow"),
            ("115792089237316195423570985008687907853269984665640564039457584007913129639935", "FieldOverflow"),
            ("115792089237316195423570985008687907853269984665640564039457584007913129639936", "InvalidNumber"),
            ("00", "InvalidNumber"),
            ("07", "InvalidNumber"),
            ("+7", "InvalidNumber"),
            ("-7", "InvalidNumber"),
            ("0x7", "InvalidNumber"),
            ("", "InvalidNumber"),
            (" 7", "InvalidNumber"),
        ] {
            let w = Withdrawal { refund_precommitment: v.into(), ..base() };
            refused(&w, &proof(), &s, 0, want);
        }
        // 1 and p - 1 pass row 1 (and then fail only row 3 here)
        for v in ["1", "21888242871839275222246405745257275088548364400416034343698204186575808495616"] {
            refused(&Withdrawal { refund_precommitment: v.into(), ..base() }, &proof(), &s, 0, "ContextMismatch");
        }
    }

    #[test]
    fn a_salt_salt_from_hex_refuses_is_refused() {
        let s = signals("1");
        for salt in [
            "",
            "0123456789abcdef0123456789abcde",
            "0123456789abcdef0123456789abcdef0",
            "0123456789ABCDEF0123456789ABCDEF",
            "0x23456789abcdef0123456789abcdef",
            "0x0123456789abcdef0123456789abcdef",
            "0123456789abcdef0123456789abcdeg",
            " 123456789abcdef0123456789abcdef",
        ] {
            refused(&Withdrawal { salt: salt.into(), ..base() }, &proof(), &s, 0, "InvalidSalt");
        }
    }

    #[test]
    fn register_deposit_and_relay_fee_take_one_spelling_below_2_128() {
        let s = signals("1");
        let max = u128::MAX.to_string();
        let over = "340282366920938463463374607431768211456"; // 2^128
        for (v, want) in [(over, "AmountOverflow"), ("01", "InvalidNumber"), ("+1", "InvalidNumber"), ("1.0", "InvalidNumber"), ("", "InvalidNumber")] {
            refused(&Withdrawal { register_deposit: v.into(), ..base() }, &proof(), &s, 0, want);
            refused(&Withdrawal { relay_fee: v.into(), ..base() }, &proof(), &s, 0, want);
        }
        for v in ["0", max.as_str()] {
            refused(&Withdrawal { register_deposit: v.into(), relay_fee: v.into(), ..base() }, &proof(), &s, 0, "ContextMismatch");
        }
    }

    #[test]
    fn public_signals_and_proof_coordinates_are_parsed_first() {
        let w = base();
        let ok = signals(&context(&w, VAULT, &scope()));
        for (i, v, want) in [(0, P_DEC, "FieldOverflow"), (3, "01", "InvalidNumber"), (7, "", "InvalidNumber")] {
            let mut s = ok.clone();
            s[i] = v.into();
            // the deadline has passed too: row 1 comes first
            refused(&w, &proof(), &s, u64::MAX, want);
        }
        let mut p = proof();
        p.b[1][0] = Q_DEC.into();
        let late = Withdrawal { refund_precommitment: "0".into(), ..w.clone() };
        refused(&late, &p, &ok, u64::MAX, "InvalidProofEncoding");
        p.b[1][0] = "05".into();
        refused(&late, &p, &ok, u64::MAX, "InvalidNumber");
    }

    #[test]
    fn row_2_comes_before_row_3_and_names_each_payee() {
        let w = base();
        // a late request with a wrong context: refused for the deadline
        refused(&w, &proof(), &signals("1"), DEADLINE + 1, "DeadlineExpired");
        for (f, want) in [
            (Withdrawal { recipient: id(VAULT), ..base() }, "InvalidRecipient: recipient"),
            (Withdrawal { recipient: id(INTENTS), ..base() }, "InvalidRecipient: recipient"),
            (Withdrawal { fee_recipient: id(VAULT), ..base() }, "InvalidRecipient: fee_recipient"),
            (Withdrawal { fee_recipient: id(INTENTS), ..base() }, "InvalidRecipient: fee_recipient"),
        ] {
            // with the context the payee change would carry, so only row 2 can refuse it
            let s = signals(&context(&f, VAULT, &scope()));
            refused(&f, &proof(), &s, 0, want);
        }
    }

    // The call's JSON: the kit's form passes; every other form of a field is refused when the arguments are read.

    fn kit_json(w: &Withdrawal) -> Value {
        json!({
            "recipient": w.recipient, "register_deposit": w.register_deposit, "fee_recipient": w.fee_recipient,
            "relay_fee": w.relay_fee, "refund_precommitment": w.refund_precommitment, "deadline_ms": w.deadline_ms,
            "salt": w.salt,
        })
    }

    #[test]
    fn the_kits_json_reads_back_to_the_same_request() {
        let w = base();
        assert_eq!(serde_json::from_value::<Withdrawal>(kit_json(&w)).unwrap(), w);
    }

    #[test]
    fn the_deadlines_form_is_one_json_integer() {
        let text = |d: &str| {
            format!(
                r#"{{"recipient":"a.near","register_deposit":"0","fee_recipient":"b.near","relay_fee":"0","refund_precommitment":"7","deadline_ms":{d},"salt":"00000000000000000000000000000000"}}"#
            )
        };
        for ok in ["0", "1793750400000", "9007199254740991", "18446744073709551615"] {
            let w: Withdrawal = serde_json::from_str(&text(ok)).unwrap_or_else(|e| panic!("{ok}: {e}"));
            assert_eq!(w.deadline_ms.to_string(), ok);
        }
        for bad in [
            "\"1793750400000\"",
            "1793750400000.0",
            "1.7937504e12",
            "1e3",
            "-1",
            "-0",
            "01",
            "18446744073709551616",
            "null",
            "true",
            "[1]",
        ] {
            assert!(serde_json::from_str::<Withdrawal>(&text(bad)).is_err(), "deadline_ms {bad} was read");
        }
    }

    #[test]
    fn a_missing_extra_or_repeated_field_and_a_bad_account_are_refused() {
        let good = kit_json(&base());
        let obj = good.as_object().unwrap();
        for k in obj.keys() {
            let mut m = obj.clone();
            m.remove(k);
            assert!(serde_json::from_value::<Withdrawal>(Value::Object(m)).is_err(), "without {k}");
        }
        let mut m = obj.clone();
        m.insert("processor".into(), json!("other-vault.near"));
        assert!(serde_json::from_value::<Withdrawal>(Value::Object(m)).is_err(), "a field 7.1 does not name");
        let text = good.to_string();
        let twice = text.replacen(r#""salt":"#, r#""salt":"ffffffffffffffffffffffffffffffff","salt":"#, 1);
        assert_ne!(twice, text);
        assert!(serde_json::from_str::<Withdrawal>(&twice).is_err(), "salt twice");
        for (k, v) in [("recipient", "Bob.near"), ("fee_recipient", "a"), ("recipient", "")] {
            let mut m = obj.clone();
            m.insert(k.into(), json!(v));
            assert!(serde_json::from_value::<Withdrawal>(Value::Object(m)).is_err(), "{k} {v:?}");
        }
        let mut m = obj.clone();
        m.insert("relay_fee".into(), json!(30000));
        assert!(serde_json::from_value::<Withdrawal>(Value::Object(m)).is_err(), "relay_fee as a JSON number");
        let s: Result<[String; 8], _> = serde_json::from_value(json!(["1", "2", "3", "4", "5", "6", "7"]));
        assert!(s.is_err(), "7 public signals");
        let s: Result<[String; 8], _> = serde_json::from_value(json!(["1", "2", "3", "4", "5", "6", "7", "8", "9"]));
        assert!(s.is_err(), "9 public signals");
    }

    // The kit and the vault on VT-U02's 32 context vectors: each vector's request, in the kit's JSON form where the
    // kit can send it (deadline_ms a safe integer) and as a JSON integer otherwise, passes rows 1-3 with that vector's
    // context and processor and scope, and the fields the vault hashes are the vector's; one more is refused. Two
    // vectors pay the vault itself (recipient or fee_recipient = processor): row 2 refuses them, as the kit does.

    #[test]
    fn every_kit_context_vector_passes_rows_1_to_3_and_a_changed_context_is_refused() {
        env_at(VAULT, 0);
        let v: Value = serde_json::from_str(VECTORS).unwrap();
        let rows = v["context"].as_array().unwrap();
        assert_eq!(rows.len(), 32);
        let mut payee_is_the_vault = vec![];
        for t in rows {
            let name = t["name"].as_str().unwrap();
            let i = &t["input"];
            let st = |k: &str| i[k].as_str().unwrap().to_string();
            let deadline: u64 = st("deadline_ms").parse().unwrap();
            let text = format!(
                r#"{{"recipient":"{}","register_deposit":"{}","fee_recipient":"{}","relay_fee":"{}","refund_precommitment":"{}","deadline_ms":{deadline},"salt":"{}"}}"#,
                st("recipient"),
                st("register_deposit"),
                st("fee_recipient"),
                st("relay_fee"),
                st("refund_precommitment"),
                st("salt")
            );
            let w: Withdrawal = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
            let processor = id(&st("processor"));
            let scope = field::from_decimal(t["scope"].as_str().unwrap()).unwrap();
            let ctx = t["context"].as_str().unwrap();
            if [&w.recipient, &w.fee_recipient].iter().any(|a| **a == processor || a.as_str() == INTENTS) {
                // an encoding vector whose payee is the vault itself: row 2 refuses it before row 3, as the kit's
                // vaultWithdrawalProblems does ("recipient: the vault")
                let (w2, p2) = (w.clone(), processor.clone());
                let e = std::panic::catch_unwind(move || {
                    env_at(p2.as_str(), 0);
                    check_request(&w2, &proof(), &signals(ctx), &p2, &scope, 0);
                })
                .expect_err(name);
                assert!(e.downcast::<String>().unwrap().contains("InvalidRecipient"), "{name}");
                payee_is_the_vault.push(name.to_string());
                continue;
            }
            let (w2, p2) = (w.clone(), processor.clone());
            let fields = std::panic::catch_unwind(move || {
                env_at(p2.as_str(), 0);
                check_request(&w2, &proof(), &signals(ctx), &p2, &scope, 0).fields
            })
            .unwrap_or_else(|e| panic!("{name}: {:?}", e.downcast::<String>()));
            let hex: String = crate::context::context_preimage(&fields, &scope).iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(hex, t["preimage_hex"].as_str().unwrap(), "{name}");
            let one_more = field::to_decimal(&field::reduce({
                let mut n = field::from_decimal(ctx).unwrap();
                n[3] = n[3].wrapping_add(1);
                n
            }));
            let e = std::panic::catch_unwind(move || {
                env_at(processor.as_str(), 0);
                check_request(&w, &proof(), &signals(&one_more), &processor, &scope, 0);
            })
            .expect_err(name);
            assert!(e.downcast::<String>().unwrap().contains("ContextMismatch"), "{name}");
        }
        assert_eq!(payee_is_the_vault, ["every field at its maximum", "every field at its minimum"]);
    }
}
