// SPDX-License-Identifier: Apache-2.0
//! `withdraw(withdrawal, proof, public_signals)` (vault.md 2.5.2), rows 1 to 12 in that order: the parse, the request,
//! the state checks, the proof, the nullifier and the change leaf. Every refusal panics before any byte is written.
//!
//! - Row 1, the parse. The call's JSON is read strictly: the call has exactly the three arguments, no other
//!   (`#[deny_unknown_arguments]`); `withdrawal` has exactly the seven fields of 7.1, no other and none twice; `proof`
//!   is `verifier::Proof`; `public_signals` exactly 8 strings. Then every number, each to its
//!   one value: the 8 proof coordinates canonical decimals below q (`InvalidNumber`, `InvalidProofEncoding`), the 8
//!   public signals canonical decimals below p (`InvalidNumber`, `FieldOverflow`), `refund_precommitment` a canonical
//!   decimal in 1..p-1 (`InvalidNumber`, `FieldOverflow`, `InvalidRefundPrecommitment` for 0), `register_deposit` and
//!   `relay_fee` canonical decimals below 2^128 (`InvalidNumber`, `AmountOverflow`), `salt` exactly 32 lowercase hex
//!   characters (`context::salt_from_hex`, else `InvalidSalt`), and `deadline_ms` a JSON integer 0..2^64-1 (serde's
//!   u64: a string, a fraction, an exponent, a sign or 2^64 is refused when the call's JSON is read). So each field
//!   reads as one value, and the context binds that value (a JSON escape such as `\u0030` is another spelling of the
//!   same string, and reads as the same value). The kit reads the same forms (`packages/kit/src/vault/shapes.ts`,
//!   `vaultDecimal`, `salt`, `vaultContextInput`).
//! - Row 2: `env::block_timestamp_ms() <= deadline_ms` (`DeadlineExpired`), then `recipient` and `fee_recipient` are
//!   neither this vault nor `INTENTS` (`InvalidRecipient`). The clock is the block the withdraw receipt runs in:
//!   nearcore's block timestamp in ns, divided by 1,000,000 and rounded down (near-sdk 5.29.1 `env.rs` l.390-392).
//! - Row 3: `context == keccak256(borsh(ContextFields) ‖ scope_be32) mod p`, with `processor` this vault and `scope`
//!   this vault's (`ContextMismatch`). The fields are hashed as parsed, in 7.1's order (`context::ContextFields`).
//! - Row 4: `stateTreeDepth` and `ASPTreeDepth` at most 32 (`InvalidTreeDepth`).
//! - Row 5: `stateRoot` is a root the state tree has had, never 0 (`UnknownStateRoot`). Row 6: `ASPRoot` is a root the
//!   label tree has had, never 0 (`UnknownLabelRoot`). Every root is kept (vault.md 2.4, Dev 2), so a proof made
//!   against an older root still lands, and a root of another vault, which hashes another scope's labels, is unknown.
//! - Row 7: `withdrawnValue != 0` (`InvalidWithdrawalAmount`). Row 8: it is below 2^128 (`AmountOverflow`), then the
//!   backstop `relay_fee * 10,000 <= withdrawnValue * MAX_RELAY_FEE_BPS`, both products exact (`RelayFeeGreaterThanMax`).
//!   Row 9: `withdrawnValue <= deposited - spent + returned`, the value the notes hold (`InvalidPoolState`).
//! - Row 10: Groth16 verify with the withdraw key, the 8 signals in snarkjs order (`verifier::verify_withdraw`,
//!   `InvalidProof`).
//! - Row 11: `existingNullifierHash` not in `spent` (`NullifierAlreadySpent`); a spend is keyed on it, never on the
//!   proof's bytes, which anyone can re-randomise. Row 12: `newCommitmentHash` into the state tree with LeanIMT's
//!   checks (`LeafAlreadyExists`, `LeafCannotBeZero`, `MaxTreeDepthReached`), even when the change is 0. Every refusal
//!   of rows 1-12 comes before the first write; then the change leaf, the `spent` row, the `spends` record (status
//!   `in_flight`, `payer` the predecessor, the request's recipient, `relay_fee` as `fee`, its `refund_precommitment`
//!   and `context`, refund fields 0) and `totals.spent += withdrawnValue` are written, and `withdrawn` is logged.
//!
//! Rows 13-15 (the fee split, the storage charge and the payouts with `on_payout`) are card vault-withdraw-payouts'.
//! Until they land, `withdraw` returns after row 12: the note is spent and its change note is in the tree, nothing is
//! paid, `reserve` is 0, the attached NEAR stays with the vault and the bytes written are paid from the vault's own NEAR
//! (row 14 charges the caller). This build is for tests only; the vault is first deployed with the payouts (vault.md
//! V1.4, V1.6).
//!
//! Ported from Privacy Pools v1.3.0 `packages/contracts/src/contracts/PrivacyPool.sol:44-59` and `:115-128`
//! (`withdraw`'s `validWithdrawal`: the processooor, the context, the depths and both roots; the proof, the nullifier
//! and the change insert), `State.sol:123-129` (`_spend`) and `Entrypoint.sol:133-157` (`relay`: the amount and the
//! fee cap), Copyright 2025 0XBOW LTD, Apache-2.0. Deviations (vault.md 2.7): Dev 2 (every root of both trees, the
//! label tree the vault's own), Dev 5 (the request in Borsh, the processor this vault), Dev 6 (the canonical parse),
//! Dev 8 (the fee an absolute amount under a backstop), Dev 10 (the deadline).

use crate::constants::{INTENTS, MAX_RELAY_FEE_BPS, MAX_TREE_DEPTH};
use crate::context::{context_of, salt_from_hex, ContextFields};
use crate::events::Event;
use crate::field::{self, U256};
use crate::poseidon::PoseidonT3;
use crate::verifier::{self, EncodedProof, Proof};
use crate::{Spend, Status, Vault, VaultExt};
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId};

// The withdraw circuit's public signals, in snarkjs order (2.5.2; `withdraw.sym:1-8`, PP `ProofLib.sol:20-29`).
pub const SIGNAL_NEW_COMMITMENT: usize = 0;
pub const SIGNAL_NULLIFIER_HASH: usize = 1;
pub const SIGNAL_WITHDRAWN: usize = 2;
pub const SIGNAL_STATE_ROOT: usize = 3;
pub const SIGNAL_STATE_DEPTH: usize = 4;
pub const SIGNAL_ASP_ROOT: usize = 5;
pub const SIGNAL_ASP_DEPTH: usize = 6;
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

/// `a * b` exactly, as (high, low) u128 halves, for `b` below 2^64.
fn mul_wide(a: u128, b: u64) -> (u128, u128) {
    let (hi, lo) = (a >> 64, a & u64::MAX as u128);
    let (h, l) = (hi * b as u128, lo * b as u128);
    // a * b = h * 2^64 + l, with h and l each below 2^128
    let low = (h << 64).wrapping_add(l);
    let carry = (low < l) as u128;
    ((h >> 64) + carry, low)
}

/// Row 8's backstop: `relay_fee * 10,000 <= withdrawn * MAX_RELAY_FEE_BPS`, both products exact.
pub fn fee_within_backstop(relay_fee: u128, withdrawn: u128) -> bool {
    mul_wide(relay_fee, 10_000) <= mul_wide(withdrawn, MAX_RELAY_FEE_BPS as u64)
}

/// A small signal (a depth): its value when it is at most `max`.
fn at_most(n: &U256, max: u8) -> bool {
    n[0] == 0 && n[1] == 0 && n[2] == 0 && n[3] <= max as u64
}

impl Vault {
    /// Rows 4-9 of 2.5.2 on a request that passed rows 1-3; any failure panics. Returns `withdrawnValue`.
    pub fn check_spend(&self, signals: &[U256; 8], relay_fee: u128) -> u128 {
        // row 4
        if !at_most(&signals[SIGNAL_STATE_DEPTH], MAX_TREE_DEPTH) || !at_most(&signals[SIGNAL_ASP_DEPTH], MAX_TREE_DEPTH) {
            env::panic_str("InvalidTreeDepth: a tree depth is over 32");
        }
        // rows 5 and 6: is_known_root refuses 0
        if !self.state_tree.is_known_root(&field::to_be(&signals[SIGNAL_STATE_ROOT])) {
            env::panic_str("UnknownStateRoot: the state root is not one this vault's state tree has had");
        }
        if !self.label_tree.is_known_root(&field::to_be(&signals[SIGNAL_ASP_ROOT])) {
            env::panic_str("UnknownLabelRoot: the ASP root is not one this vault's label tree has had");
        }
        // row 7
        let w = &signals[SIGNAL_WITHDRAWN];
        if *w == [0; 4] {
            env::panic_str("InvalidWithdrawalAmount: withdrawnValue is 0");
        }
        // row 8
        if w[0] != 0 || w[1] != 0 {
            env::panic_str("AmountOverflow: withdrawnValue is not below 2^128");
        }
        let withdrawn = ((w[2] as u128) << 64) | w[3] as u128;
        if !fee_within_backstop(relay_fee, withdrawn) {
            env::panic_str("RelayFeeGreaterThanMax: relay_fee is over the backstop");
        }
        // row 9
        let t = &self.totals;
        let held = t.deposited.0.checked_add(t.returned.0).and_then(|x| x.checked_sub(t.spent.0));
        if held.is_none_or(|held| withdrawn > held) {
            env::panic_str("InvalidPoolState: withdrawnValue is over the value the vault's notes hold");
        }
        withdrawn
    }

    /// Rows 11 and 12 on a request that passed rows 1-10: refuses a spent nullifier and a change leaf LeanIMT refuses,
    /// then writes the change leaf, the `spent` row, the `spends` record and `totals.spent`. Returns the spend index.
    fn spend(&mut self, c: &Checked, withdrawn: u128, payer: AccountId) -> u64 {
        let nullifier_hash = field::to_be(&c.signals[SIGNAL_NULLIFIER_HASH]);
        let new_commitment = field::to_be(&c.signals[SIGNAL_NEW_COMMITMENT]);
        // row 11, its check
        if self.spent.contains_key(&nullifier_hash) {
            env::panic_str("NullifierAlreadySpent");
        }
        // row 12: insert_commitment refuses before it writes
        let (new_leaf_index, _) = self.insert_commitment(&mut PoseidonT3::new(), &new_commitment);
        // row 11, its writes: nothing below refuses
        let index = self.spends.len();
        self.spent.insert(&nullifier_hash, &index);
        self.spends.push(&Spend {
            nullifier_hash,
            withdrawn,
            new_leaf_index,
            refund_precommitment: c.fields.refund_precommitment,
            refund_value: 0,
            refund_label: [0; 32],
            refund_leaf_index: 0,
            status: Status::InFlight,
            payer,
            reserve: 0,
            recipient: c.fields.recipient.clone(),
            fee: c.fields.relay_fee,
            context: field::to_be(&c.signals[SIGNAL_CONTEXT]),
        });
        // row 9 bounds withdrawn by deposited + returned - spent, so this sum cannot overflow
        self.totals.spent = U128(self.totals.spent.0 + withdrawn);
        Event::Withdrawn {
            processor: &c.fields.processor,
            value: withdrawn,
            spent_nullifier: &nullifier_hash,
            new_commitment: &new_commitment,
        }
        .emit();
        index
    }
}

#[near]
impl Vault {
    /// Rows 1-12 of 2.5.2, in order, at this block's time: every refusal panics before any write. A request that
    /// passes them spends its note and inserts its change note; rows 13-15 (the payouts) are not built yet, so nothing
    /// is paid.
    #[payable]
    #[deny_unknown_arguments]
    pub fn withdraw(&mut self, withdrawal: Withdrawal, proof: Proof, public_signals: [String; 8]) {
        let c = check_request(
            &withdrawal,
            &proof,
            &public_signals,
            &env::current_account_id(),
            &crate::scope(),
            env::block_timestamp_ms(),
        );
        let withdrawn = self.check_spend(&c.signals, c.fields.relay_fee);
        // row 10
        if !verifier::verify_withdraw(&c.proof, &c.signals) {
            env::panic_str("InvalidProof");
        }
        self.spend(&c, withdrawn, env::predecessor_account_id());
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

    /// The `withdraw` method itself on an empty vault at `VAULT` with the block's timestamp `block_ns`: its panic's text.
    /// A request that passes rows 1-3 here stops at row 5 (`UnknownStateRoot`): no tree has a root yet.
    fn withdraw_at(w: &Withdrawal, s: &[String; 8], block_ns: u64) -> String {
        let (w, s) = (w.clone(), s.clone());
        std::panic::catch_unwind(move || {
            env_at(VAULT, block_ns);
            Vault::default().withdraw(w, proof(), s);
        })
        .map_err(|e| e.downcast::<String>().map(|s| *s).unwrap_or_default())
        .expect_err("an empty vault knows no root")
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
            (0, "UnknownStateRoot"),
            ((DEADLINE - 1) * ms, "UnknownStateRoot"),
            (DEADLINE * ms, "UnknownStateRoot"),
            // the same ms, its last ns: block_timestamp_ms rounds down
            (DEADLINE * ms + 999_999, "UnknownStateRoot"),
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
        assert!(withdraw_at(&w, &s, u64::MAX).contains("UnknownStateRoot"));
        w.deadline_ms = 0;
        let s = signals(&context(&w, VAULT, &scope()));
        assert!(withdraw_at(&w, &s, 999_999).contains("UnknownStateRoot"));
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
        // limb 1 set (2^128), limb 0 set alone (2^192 + 5), every limb set (2^256 - 1)
        let limb0 = "6277101735386680763835789423207666416102355444464034512901";
        let all = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
        for (v, want) in [(over, "AmountOverflow"), (limb0, "AmountOverflow"), (all, "AmountOverflow"), ("01", "InvalidNumber"), ("+1", "InvalidNumber"), ("1.0", "InvalidNumber"), ("", "InvalidNumber")] {
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

/// Rows 4-12 with real proofs (tests/fixtures/withdraw-spends.json, made by the kit's input builder and snarkjs), on a
/// vault at vault.test.near whose trees hold the fixture's six deposits, inserted by the vault's own tree code. Unit
/// tests run in near-sdk's mocked blockchain, whose alt_bn128 calls are nearcore's own code. VT-S05 and VT-S06 run
/// again in near-sandbox in tests/withdraw_spend.rs.
#[cfg(test)]
mod spend_tests {
    use super::*;
    use crate::verifier::Q;
    use near_sdk::serde_json::{self, Value};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, Gas};
    use std::panic::{catch_unwind, AssertUnwindSafe};

    const SPENDS: &str = include_str!("../tests/fixtures/withdraw-spends.json");
    const RELAYER: &str = "relayer.test.near";

    fn fixture() -> Value {
        serde_json::from_str(SPENDS).unwrap()
    }

    fn call() {
        testing_env!(VMContextBuilder::new()
            .current_account_id(fixture()["vault"].as_str().unwrap().parse().unwrap())
            .predecessor_account_id(RELAYER.parse().unwrap())
            .block_timestamp(1_800_000_000_000_000_000)
            .prepaid_gas(Gas::from_tgas(300))
            .build());
    }

    fn be(dec: &str) -> crate::Bytes32 {
        field::to_be(&field::from_decimal(dec).unwrap())
    }

    /// The fixture's vault: its six deposits in both trees and `deposited` their sum (the deposit path is card
    /// vault-deposit-insert's; this is the state it leaves).
    fn vault() -> Vault {
        call();
        // a fresh chain: no record of an earlier vault in this test
        near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
        let f = fixture();
        let mut v = Vault::default();
        let mut h = PoseidonT3::new();
        for (leaf, label) in f["leaves"].as_array().unwrap().iter().zip(f["labels"].as_array().unwrap()) {
            v.insert_commitment(&mut h, &be(leaf.as_str().unwrap()));
            v.insert_label(&mut h, &be(label.as_str().unwrap()));
        }
        v.totals.deposited = U128(f["deposited"].as_str().unwrap().parse().unwrap());
        v
    }

    /// The fixture's spend `name`: (withdrawal, proof, public signals).
    fn spend(name: &str) -> (Withdrawal, Proof, [String; 8]) {
        let f = fixture();
        let s = f["spends"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap();
        (
            serde_json::from_value(s["withdrawal"].clone()).unwrap(),
            serde_json::from_value(s["proof"].clone()).unwrap(),
            serde_json::from_value(s["public_signals"].clone()).unwrap(),
        )
    }

    /// One `withdraw` call in a fresh mocked call that keeps the storage: Ok, or the panic's text.
    fn withdraw(v: &mut Vault, (w, p, s): (Withdrawal, Proof, [String; 8])) -> Result<(), String> {
        call();
        catch_unwind(AssertUnwindSafe(|| v.withdraw(w, p, s))).map_err(|e| e.downcast::<String>().map(|s| *s).unwrap_or_default())
    }

    /// Everything a call could write: the struct's bytes and the storage it uses.
    fn written(v: &Vault) -> (Vec<u8>, u64) {
        (near_sdk::borsh::to_vec(v).unwrap(), env::storage_usage())
    }

    /// `c` is refused with `want`, and nothing is written: the mocked chain keeps a panicking call's writes, so a
    /// write before the refusal would show here.
    fn refused(v: &mut Vault, (w, p, s): (Withdrawal, Proof, [String; 8]), want: &str) {
        call();
        let before = written(v);
        match catch_unwind(AssertUnwindSafe(|| v.withdraw(w, p, s))) {
            Ok(()) => panic!("passed, want {want}"),
            Err(e) => {
                let e = e.downcast::<String>().map(|s| *s).unwrap_or_default();
                assert!(e.contains(want), "want {want}, got {e:?}")
            }
        }
        assert_eq!(written(v), before, "{want}: a byte was written");
    }

    fn with_signal(mut c: (Withdrawal, Proof, [String; 8]), i: usize, x: &str) -> (Withdrawal, Proof, [String; 8]) {
        c.2[i] = x.into();
        c
    }

    #[test]
    fn a_real_spend_lands_and_writes_its_record_as_the_kit_reads_it() {
        let mut v = vault();
        let (w, p, s) = spend("same_call");
        withdraw(&mut v, (w.clone(), p, s.clone())).unwrap();
        // row 11: spent, its spends record, totals
        assert_eq!(v.spent.get(&be(&s[SIGNAL_NULLIFIER_HASH])), Some(0));
        let rows = v.spends(0, 10);
        assert_eq!(rows.len(), 1);
        let r = serde_json::to_value(&rows[0]).unwrap();
        // SpendView's fields in the order the kit's sync.ts (SPEND_FIELDS) reads them (near-sdk's serde_json keeps order)
        let keys: Vec<&str> = r.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        let want = [
            "index", "nullifier_hash", "withdrawn", "new_leaf_index", "refund_precommitment", "refund_value", "refund_label",
            "refund_leaf_index", "status", "payer", "reserve", "recipient", "fee", "context",
        ];
        assert_eq!(keys, want, "SpendView's field order");
        assert_eq!(r["index"], 0);
        assert_eq!(r["nullifier_hash"], s[SIGNAL_NULLIFIER_HASH]);
        assert_eq!(r["withdrawn"], "2000000");
        assert_eq!(r["new_leaf_index"], 6);
        assert_eq!(r["refund_precommitment"], w.refund_precommitment);
        assert_eq!((r["refund_value"].as_str(), r["refund_label"].as_str(), r["refund_leaf_index"].as_u64()), (Some("0"), Some("0"), Some(0)));
        assert_eq!(r["status"], "in_flight");
        assert_eq!(r["payer"], RELAYER);
        assert_eq!(r["reserve"], "0");
        assert_eq!(r["recipient"], w.recipient.as_str());
        assert_eq!(r["fee"], w.relay_fee);
        assert_eq!(r["context"], s[SIGNAL_CONTEXT]);
        assert_eq!(v.totals.spent.0, 2_000_000);
        // row 12: the change leaf (value 0 here: the whole note) at index 6, its root known
        assert_eq!(v.state_tree.size, 7);
        assert_eq!(v.state_tree.leaf_at(6), Some(be(&s[SIGNAL_NEW_COMMITMENT])));
        assert!(v.state_tree.is_known_root(&v.state_tree.root()));
        // the proof's own root stays known
        assert!(v.state_tree.is_known_root(&be(&s[SIGNAL_STATE_ROOT])));
        assert_eq!(v.label_tree.size, 6, "a change note makes no label");
    }

    // VT-S05 (V:1132) in the mocked chain; tests/withdraw_spend.rs runs it in near-sandbox.

    #[test]
    fn vt_s05_the_same_call_twice_spends_once() {
        let mut v = vault();
        withdraw(&mut v, spend("same_call")).unwrap();
        // row 11 comes before row 12: the change leaf is in the tree too, yet the refusal names the nullifier
        refused(&mut v, spend("same_call"), "NullifierAlreadySpent");
        assert_eq!((v.spends.len(), v.totals.spent.0, v.state_tree.size), (1, 2_000_000, 7));
    }

    #[test]
    fn vt_s05_a_second_proof_of_one_nullifier_is_refused() {
        let mut v = vault();
        let (a, b) = (spend("same_nullifier_a"), spend("same_nullifier_b"));
        assert_eq!(a.2[SIGNAL_NULLIFIER_HASH], b.2[SIGNAL_NULLIFIER_HASH]);
        assert_ne!(a.2[SIGNAL_NEW_COMMITMENT], b.2[SIGNAL_NEW_COMMITMENT]);
        withdraw(&mut v, a).unwrap();
        refused(&mut v, b, "NullifierAlreadySpent");
        assert_eq!(v.totals.spent.0, 1_000_000);
    }

    #[test]
    fn vt_s05_a_rerandomised_proof_is_the_same_nullifier() {
        // (-A, -B, C) verifies for the same signals (tests/groth16.rs); it must not spend twice
        let mut v = vault();
        let (w, p, s) = spend("one_block_a");
        withdraw(&mut v, (w.clone(), p.clone(), s.clone())).unwrap();
        let neg = |y: &str| field::to_decimal(&field::sub(&Q, &field::from_decimal(y).unwrap()));
        let r = Proof {
            a: [p.a[0].clone(), neg(&p.a[1])],
            b: [p.b[0].clone(), [neg(&p.b[1][0]), neg(&p.b[1][1])]],
            c: p.c.clone(),
        };
        call();
        assert!(verifier::verify_withdraw(&r.encode(), &s.each_ref().map(|x| field::from_decimal(x).unwrap())), "-A, -B verifies");
        refused(&mut v, (w, r, s), "NullifierAlreadySpent");
    }

    #[test]
    fn an_older_root_is_accepted() {
        let mut v = vault();
        withdraw(&mut v, spend("old_root")).unwrap();
        assert_eq!(v.totals.spent.0, 3_000_000);
    }

    // VT-S06 (V:1133): unknown, 0 and another vault's roots, for each tree.

    #[test]
    fn vt_s06_unknown_zero_and_other_vault_roots_are_refused() {
        let mut v = vault();
        let f = fixture();
        let other = &f["other_vault"];
        for (i, want) in [(SIGNAL_STATE_ROOT, "UnknownStateRoot"), (SIGNAL_ASP_ROOT, "UnknownLabelRoot")] {
            let theirs = other[if i == SIGNAL_STATE_ROOT { "state_root" } else { "label_root" }].as_str().unwrap();
            for root in ["4", "0", theirs] {
                refused(&mut v, with_signal(spend("same_call"), i, root), want);
            }
        }
        // the state tree's root is not a label root, nor the reverse
        call();
        let state_root = field::to_decimal(&field::from_be(&v.state_tree.root()));
        let label_root = field::to_decimal(&field::from_be(&v.label_tree.root()));
        refused(&mut v, with_signal(spend("same_call"), SIGNAL_ASP_ROOT, &state_root), "UnknownLabelRoot");
        refused(&mut v, with_signal(spend("same_call"), SIGNAL_STATE_ROOT, &label_root), "UnknownStateRoot");
        // and the unchanged request still lands
        withdraw(&mut v, spend("same_call")).unwrap();
    }

    // Each row's refusal, and each row before the next: the call breaks two rows and the earlier one names it.

    #[test]
    fn row_4_depths_over_32_are_refused_before_the_roots() {
        let mut v = vault();
        for i in [SIGNAL_STATE_DEPTH, SIGNAL_ASP_DEPTH] {
            refused(&mut v, with_signal(with_signal(spend("same_call"), i, "33"), SIGNAL_STATE_ROOT, "4"), "InvalidTreeDepth");
            refused(&mut v, with_signal(spend("same_call"), i, "18446744073709551648"), "InvalidTreeDepth");
        }
        // depth 32 passes row 4 (and the proof then refuses it: the depth is a public signal)
        refused(&mut v, with_signal(spend("same_call"), SIGNAL_STATE_DEPTH, "32"), "InvalidProof");
    }

    #[test]
    fn row_5_before_6_and_6_before_7() {
        let mut v = vault();
        refused(&mut v, with_signal(with_signal(spend("same_call"), SIGNAL_STATE_ROOT, "4"), SIGNAL_ASP_ROOT, "4"), "UnknownStateRoot");
        refused(&mut v, with_signal(with_signal(spend("same_call"), SIGNAL_ASP_ROOT, "4"), SIGNAL_WITHDRAWN, "0"), "UnknownLabelRoot");
    }

    #[test]
    fn rows_7_8_and_9_refuse_the_amount_before_the_proof() {
        let mut v = vault();
        // same_call carries relay_fee 500,000
        refused(&mut v, with_signal(spend("same_call"), SIGNAL_WITHDRAWN, "0"), "InvalidWithdrawalAmount");
        refused(&mut v, with_signal(spend("same_call"), SIGNAL_WITHDRAWN, "340282366920938463463374607431768211456"), "AmountOverflow");
        // the backstop: 500,000 x 10,000 <= w x 5,000 needs w >= 1,000,000
        refused(&mut v, with_signal(spend("same_call"), SIGNAL_WITHDRAWN, "999999"), "RelayFeeGreaterThanMax");
        refused(&mut v, with_signal(spend("same_call"), SIGNAL_WITHDRAWN, "1000000"), "InvalidProof");
        // row 9: the six notes hold 31,000,000
        refused(&mut v, with_signal(spend("same_call"), SIGNAL_WITHDRAWN, "31000001"), "InvalidPoolState");
        refused(&mut v, with_signal(spend("same_call"), SIGNAL_WITHDRAWN, "31000000"), "InvalidProof");
    }

    #[test]
    fn row_9_counts_what_was_spent_and_returned() {
        let mut v = vault();
        v.totals.deposited = U128(2_000_000);
        withdraw(&mut v, spend("old_root")).map(|_| ()).expect_err("3,000,000 over 2,000,000 held");
        v.totals.returned = U128(1_000_000);
        withdraw(&mut v, spend("old_root")).unwrap();
        // now deposited + returned - spent = 0
        refused(&mut v, spend("same_call"), "InvalidPoolState");
        // a broken total (spent over deposited + returned) refuses, never wraps
        v.totals.spent = U128(u128::MAX);
        refused(&mut v, spend("same_call"), "InvalidPoolState");
    }

    #[test]
    fn row_10_refuses_a_proof_that_does_not_verify_before_the_nullifier() {
        let mut v = vault();
        withdraw(&mut v, spend("same_call")).unwrap();
        // another spend's proof under same_call's (spent) signals: the proof refuses first
        let (w, _, s) = spend("same_call");
        refused(&mut v, (w, spend("one_block_a").1, s), "InvalidProof");
        // every signal the proof binds: a changed change leaf or nullifier hash does not verify
        let mut v = vault();
        refused(&mut v, with_signal(spend("one_block_a"), SIGNAL_NEW_COMMITMENT, "12345"), "InvalidProof");
        refused(&mut v, with_signal(spend("one_block_a"), SIGNAL_NULLIFIER_HASH, "12345"), "InvalidProof");
        // the older root of old_root is known, but one_block_a was proven against the newest
        let old = spend("old_root").2[SIGNAL_STATE_ROOT].clone();
        refused(&mut v, with_signal(spend("one_block_a"), SIGNAL_STATE_ROOT, &old), "InvalidProof");
    }

    #[test]
    fn row_12_refuses_a_change_leaf_already_in_the_tree_before_any_write() {
        let mut v = vault();
        let c = spend("same_nullifier_a");
        call();
        v.insert_commitment(&mut PoseidonT3::new(), &be(&c.2[SIGNAL_NEW_COMMITMENT]));
        refused(&mut v, c, "LeafAlreadyExists");
        assert_eq!((v.spends.len(), v.totals.spent.0), (0, 0));
        assert!(!v.spent.contains_key(&be(&spend("same_nullifier_a").2[SIGNAL_NULLIFIER_HASH])));
    }

    #[test]
    fn the_backstop_is_exact_at_both_ends() {
        assert!(fee_within_backstop(0, 1));
        assert!(fee_within_backstop(1, 2));
        assert!(!fee_within_backstop(1, 1));
        let m = u128::MAX;
        assert!(fee_within_backstop(m / 2, m));
        assert!(!fee_within_backstop(m / 2 + 1, m));
        assert!(fee_within_backstop((m - 1) / 2, m - 1));
        assert!(!fee_within_backstop(m, m));
        // mul_wide against a plain 256-bit product
        for (a, b) in [(m, 10_000u64), (m, 5_000), (1u128 << 64, u64::MAX), (m, u64::MAX), (12345, 0)] {
            let (hi, lo) = mul_wide(a, b);
            let (ah, al) = (a >> 64, a & u64::MAX as u128);
            let want_lo = a.wrapping_mul(b as u128);
            assert_eq!(lo, want_lo, "{a} x {b}");
            let carry_part = ((al * b as u128) >> 64) + ah * b as u128;
            assert_eq!(hi, carry_part >> 64, "{a} x {b}");
        }
    }
}
