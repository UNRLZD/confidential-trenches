// SPDX-License-Identifier: Apache-2.0
//! `ft_on_transfer(sender_id, amount, msg)` (vault.md 2.5.1), the message part: rows 1 and 2 of the deposit table.
//!
//! - Row 1: only the pinned token (`TOKEN`) may call it. The method is public; only the token as caller shows that a
//!   transfer happened (Dev 4, in place of PP's `safeTransferFrom` in `Entrypoint.sol:123`).
//! - Row 2: `msg` is at most 1,024 bytes and is exactly `{"precommitment":"<decimal>","depositor":"<account>"}`, both
//!   fields required, no third field, no field twice; `precommitment` is one canonical decimal (2.5.2 row 1:
//!   `InvalidNumber`) below p (`FieldOverflow`) and not 0 (`InvalidPrecommitment`: no (nullifier, secret) hashes to 0,
//!   so a note on 0 could never be spent, as `refund_precommitment` 0 is refused in withdraw and ragequit);
//!   `depositor` is a valid NEAR account id and not this vault. PP takes
//!   the value as a typed `uint256` (`Entrypoint.sol:117`); its `ZeroAddress` check (`Entrypoint.sol:348`) becomes the
//!   account-id type.
//!
//! The kit builds this message with `vaultDepositMessage` (packages/kit/src/vault/shapes.ts, kit-v1.2): those two
//! fields in that order, a canonical decimal below p and a lowercase 64-hex depositor that is the moving account, never
//! the vault. Every message it builds passes here; the vault reads the fields in any order and takes any valid account
//! id as `depositor` (2.5.1: intents.near can be the sender, with the depositor a different account).
//!
//! A refusal is a panic (2.5.1, the table's header: "fails = panic, so the token refunds the whole amount"): the call
//! writes nothing, and the token's `ft_resolve_transfer` reads the failed promise as nothing used and gives the sender
//! the whole amount back (NCS4 `core_impl.rs` l.178-235).
//!
//! Rows 3 to 12, the deposit itself (`Vault::deposit`), ported from Privacy Pools v1.3.0's deposit at the lines vault.md
//! 2.5.1's table cites (`Entrypoint.sol:324-329`, `PrivacyPool.sol:90-106`), Copyright 2025 0XBOW LTD, Apache-2.0:
//! - Row 3: the precommitment unused (`PrecommitmentAlreadyUsed`, `Entrypoint.sol:324`).
//! - Row 4: `amount >= MIN_DEPOSIT` (`MinimumDepositAmount`, `Entrypoint.sol:329`, a constant here).
//! - Row 5: `amount < u128::MAX` (`InvalidDepositValue`, `PrivacyPool.sol:90`).
//! - Row 6: a `prepaid[precommitment]` record (`NoPrepay`), deleted; its whole amount stays with the vault (Dev 3).
//! - Row 8: `nonce += 1`, `label = keccak256(scope_be32 ‖ nonce_be32) mod p` (`PrivacyPool.sol:93`; src/context.rs).
//! - Row 9: `commitment = Poseidon(amount, label, precommitment)` (`PrivacyPool.sol:98`).
//! - Row 10: the commitment into the state tree and the label into the label tree, which approves it (src/tree.rs;
//!   Dev 2: the vault fills its own label tree, no ASP postman).
//! - Row 11: `deposits`, `precommitments`, `label_index` and `totals.deposited`; the two new roots are row 10's.
//! - Row 7, checked last: the prepaid amount covers every byte the deposit wrote, at `env::storage_byte_cost()`, else
//!   `InsufficientStorageDeposit`. The usage is read after row 6 deletes the record, so the end less that start is
//!   the paper's "usage at the end − usage at the start + 89" (the freed record is 1 + 32 + 16 + 40 = 89 B).
//! - Row 12: `ft_on_transfer` returns `"0"`, all used.
//!
//! Events, in PP's order (`State.sol:151` then `PrivacyPool.sol:106`): `leaf_inserted` state, `leaf_inserted` label,
//! `deposited`, all three logged after row 7 passes, so a refused deposit logs none (NEAR keeps a failed receipt's
//! logs). `ft_on_transfer` makes no promise.

use crate::constants::{MIN_DEPOSIT, TOKEN};
use crate::context::label_of;
use crate::events::Event;
use crate::poseidon::{PoseidonT3, PoseidonT4};
use crate::{field, scope, Bytes32, Deposit, Vault, VaultExt};
use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::{env, near, AccountId};

/// Row 2's bound on `msg`, in bytes.
pub const DEPOSIT_MESSAGE_MAX_BYTES: usize = 1_024;

/// The message as JSON gives it: both fields required, any other field refused, a field twice refused.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct Message {
    precommitment: String,
    depositor: AccountId,
}

/// A deposit message that passed row 2.
#[derive(Debug, PartialEq, Eq)]
pub struct DepositMessage {
    pub precommitment: Bytes32,
    pub depositor: AccountId,
}

/// Row 2 on `msg` for the vault `vault`, or the refusal's text (its first word names the check).
pub fn deposit_message(msg: &str, vault: &AccountId) -> Result<DepositMessage, String> {
    if msg.len() > DEPOSIT_MESSAGE_MAX_BYTES {
        return Err(format!("MessageTooLong: the deposit message is {} bytes, over 1,024", msg.len()));
    }
    // serde's derived struct also reads a JSON array (`["1","u.near"]`); only an object is the message. A JSON value's
    // first character past JSON whitespace names its type, so this refuses every array, string, number and literal.
    if !msg.trim_start_matches([' ', '\t', '\n', '\r']).starts_with('{') {
        return Err("InvalidMessage: want exactly {precommitment, depositor}: not a JSON object".into());
    }
    let m: Message = near_sdk::serde_json::from_str(msg)
        .map_err(|e| format!("InvalidMessage: want exactly {{precommitment, depositor}}: {e}"))?;
    let n = field::parse_decimal(&m.precommitment)
        .ok_or("InvalidNumber: the precommitment is not a canonical decimal")?;
    if field::ge(&n, &field::P) {
        return Err("FieldOverflow: the precommitment is not below p".into());
    }
    if n == [0; 4] {
        return Err("InvalidPrecommitment: the precommitment is 0".into());
    }
    if m.depositor == *vault {
        return Err("DepositorIsTheVault".into());
    }
    Ok(DepositMessage { precommitment: field::to_be(&n), depositor: m.depositor })
}

/// An amount as a field element's 32 big-endian bytes (a u128 is always below p).
fn amount_be(amount: u128) -> Bytes32 {
    let mut b = [0u8; 32];
    b[16..].copy_from_slice(&amount.to_be_bytes());
    b
}

impl Vault {
    /// Rows 3 to 11 and row 7 for a message that passed row 2 and `amount` of the token: the commitment and its label
    /// inserted, the records and totals written, the events logged. Returns the deposit's index. Panics (so the token
    /// refunds all) on any refusal, with nothing written.
    pub(crate) fn deposit(&mut self, m: &DepositMessage, amount: u128) -> u64 {
        // row 3
        if self.precommitments.contains_key(&m.precommitment) {
            env::panic_str("PrecommitmentAlreadyUsed");
        }
        // row 4
        if amount < MIN_DEPOSIT {
            env::panic_str("MinimumDepositAmount: the amount is below MIN_DEPOSIT");
        }
        // row 5
        if amount == u128::MAX {
            env::panic_str("InvalidDepositValue: the amount is u128::MAX");
        }
        // row 6: the record goes; its whole amount stays with the vault
        let prepaid = self
            .prepaid
            .remove(&m.precommitment)
            .unwrap_or_else(|| env::panic_str("NoPrepay: no storage_prepay for this precommitment"));
        let start = env::storage_usage();
        // row 8
        self.nonce += 1;
        let label = field::to_be(&label_of(&scope(), self.nonce));
        // row 9
        let commitment = PoseidonT4::new().hash(&amount_be(amount), &label, &m.precommitment);
        // row 10: the commitment first, then its label (PP's order of the two inserts' events)
        let mut h = PoseidonT3::new();
        let state = self.insert_commitment(&mut h, &commitment);
        let labelled = self.insert_label(&mut h, &label);
        // row 11
        let index = self.deposits.len();
        self.deposits.push(&Deposit {
            precommitment: m.precommitment,
            label,
            value: amount,
            leaf_index: state.index,
            depositor: m.depositor.clone(),
        });
        self.precommitments.insert(&m.precommitment, &index);
        self.label_index.insert(&label, &index);
        let deposited = self.totals.deposited.0.checked_add(amount);
        self.totals.deposited = U128(deposited.unwrap_or_else(|| env::panic_str("TotalsOverflow: deposited")));
        // row 7: every byte written since the record went, paid by the record
        let wrote = env::storage_usage().saturating_sub(start);
        if prepaid < wrote as u128 * env::storage_byte_cost().as_yoctonear() {
            env::panic_str(&format!(
                "InsufficientStorageDeposit: the deposit wrote {wrote} B; the prepay covers {} B",
                prepaid / env::storage_byte_cost().as_yoctonear()
            ));
        }
        // every check passed: the events
        state.event().emit();
        labelled.event().emit();
        Event::Deposited {
            depositor: &m.depositor,
            commitment: &commitment,
            label: &label,
            value: amount,
            precommitment: &m.precommitment,
        }
        .emit();
        index
    }
}

#[near]
impl Vault {
    /// NEP-141's receiver call, made by the token during `ft_transfer_call(vault, amount, msg)`. Refused (a panic, so
    /// the token gives the sender the whole amount back): any caller but `TOKEN` (`NotTheToken`); a message that fails
    /// row 2 (`MessageTooLong`, `InvalidMessage`, `InvalidNumber`, `FieldOverflow`, `InvalidPrecommitment`,
    /// `DepositorIsTheVault`); and rows
    /// 3-7 (`PrecommitmentAlreadyUsed`, `MinimumDepositAmount`, `InvalidDepositValue`, `NoPrepay`,
    /// `InsufficientStorageDeposit`) and the tree's own checks (src/tree.rs). Otherwise the deposit lands and the
    /// whole amount is used: returns `"0"`.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let _ = sender_id;
        if env::predecessor_account_id().as_str() != TOKEN {
            env::panic_str("NotTheToken: only the vault's token calls ft_on_transfer");
        }
        let m = deposit_message(&msg, &env::current_account_id()).unwrap_or_else(|e| env::panic_str(&e));
        self.deposit(&m, amount.0);
        U128(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const VAULT: &str = "vault.near";
    const HEX64: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const P_DEC: &str = "21888242871839275222246405745257275088548364400416034343698204186575808495617";
    const P_MINUS_1: &str = "21888242871839275222246405745257275088548364400416034343698204186575808495616";
    /// `vaultDepositMessage(p - 1n, "a".repeat(64))` at kit-v1.2, its bytes as Node 24 printed them.
    const KIT_MSG: &str = r#"{"precommitment":"21888242871839275222246405745257275088548364400416034343698204186575808495616","depositor":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#;
    /// `vaultDepositMessage(0n, "0123456789abcdef".repeat(4))`: refused (R-01).
    const KIT_MSG_ZERO: &str = r#"{"precommitment":"0","depositor":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}"#;

    fn vault() -> AccountId {
        VAULT.parse().unwrap()
    }

    fn be(dec: &str) -> Bytes32 {
        field::to_be(&field::from_decimal(dec).unwrap())
    }

    /// The refusal's text for `msg`, which must be refused.
    fn refusal(msg: &str) -> String {
        match deposit_message(msg, &vault()) {
            Ok(m) => panic!("{msg:?} passed row 2: {m:?}"),
            Err(e) => e,
        }
    }

    fn as_caller(caller: &str) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(caller.parse().unwrap())
            .build());
    }

    /// `ft_on_transfer` as `caller` on a fresh vault with no prepay, its panic text or its return.
    fn on_transfer(caller: &str, msg: &str) -> Result<u128, String> {
        let msg = msg.to_string();
        let caller = caller.to_string();
        std::panic::catch_unwind(move || {
            as_caller(&caller);
            Vault::default().ft_on_transfer("u.near".parse().unwrap(), U128(1_000_000), msg).0
        })
        .map_err(|e| e.downcast::<String>().map(|s| *s).unwrap_or_default())
    }

    #[test]
    fn the_kits_messages_pass() {
        let m = deposit_message(KIT_MSG, &vault()).unwrap();
        assert_eq!(m, DepositMessage { precommitment: be(P_MINUS_1), depositor: HEX64.parse().unwrap() });
    }

    /// R-01 (review vault-review-opus-contract): no (nullifier, secret) hashes to 0, so a note on precommitment 0 could
    /// never be spent and its tokens would be locked for good. Row 2 refuses it, so the token refunds the whole amount.
    #[test]
    fn precommitment_zero_is_refused() {
        assert!(refusal(KIT_MSG_ZERO).starts_with("InvalidPrecommitment"), "{}", refusal(KIT_MSG_ZERO));
        // and from the token, a panic (the token's resolve refunds all), before any prepay is looked up
        let e = on_transfer(crate::constants::TOKEN, KIT_MSG_ZERO).unwrap_err();
        assert!(e.contains("InvalidPrecommitment"), "{e}");
        // 1 is still a precommitment
        let m = deposit_message(&KIT_MSG_ZERO.replace(r#""0""#, r#""1""#), &vault()).unwrap();
        assert_eq!(m.precommitment, be("1"));
    }

    #[test]
    fn json_whitespace_around_the_object_passes() {
        assert!(deposit_message(&format!(" \t\r\n{KIT_MSG}\n"), &vault()).is_ok());
    }

    #[test]
    fn the_fields_in_either_order_and_a_named_depositor_pass() {
        let m = deposit_message(r#"{"depositor":"intents.near","precommitment":"7"}"#, &vault()).unwrap();
        assert_eq!(m, DepositMessage { precommitment: be("7"), depositor: "intents.near".parse().unwrap() });
    }

    #[test]
    fn exactly_1024_bytes_pass_and_1025_are_refused() {
        let at = format!("{KIT_MSG}{}", " ".repeat(1_024 - KIT_MSG.len()));
        assert_eq!(at.len(), 1_024);
        assert!(deposit_message(&at, &vault()).is_ok());
        let over = format!("{at} ");
        assert!(refusal(&over).starts_with("MessageTooLong"), "{}", refusal(&over));
    }

    #[test]
    fn every_bad_message_is_refused_by_name() {
        let cases = [
            ("not json", "InvalidMessage"),
            ("", "InvalidMessage"),
            ("[]", "not a JSON object"),
            (&format!(r#"["1","{HEX64}"]"#), "not a JSON object"),
            (&format!(r#" \n["1","{HEX64}"]"#), "not a JSON object"),
            ("\"x\"", "not a JSON object"),
            ("null", "InvalidMessage"),
            (r#"{"precommitment":"1"}"#, "missing field `depositor`"),
            (&format!(r#"{{"depositor":"{HEX64}"}}"#), "missing field `precommitment`"),
            (&format!(r#"{{"precommitment":"1","depositor":"{HEX64}","x":1}}"#), "unknown field `x`"),
            (&format!(r#"{{"precommitment":"1","precommitment":"2","depositor":"{HEX64}"}}"#), "duplicate field `precommitment`"),
            (&format!(r#"{{"precommitment":"1","depositor":"{HEX64}"}} x"#), "trailing characters"),
            (&format!(r#"{{"precommitment":1,"depositor":"{HEX64}"}}"#), "invalid type"),
            (&format!(r#"{{"precommitment":null,"depositor":"{HEX64}"}}"#), "invalid type"),
            (r#"{"precommitment":"1","depositor":null}"#, "InvalidMessage"),
            (r#"{"precommitment":"1","depositor":"Not An Account"}"#, "InvalidMessage"),
            (r#"{"precommitment":"1","depositor":""}"#, "InvalidMessage"),
            (&format!(r#"{{"precommitment":"01","depositor":"{HEX64}"}}"#), "InvalidNumber"),
            (&format!(r#"{{"precommitment":"","depositor":"{HEX64}"}}"#), "InvalidNumber"),
            (&format!(r#"{{"precommitment":"-1","depositor":"{HEX64}"}}"#), "InvalidNumber"),
            (&format!(r#"{{"precommitment":"0x1","depositor":"{HEX64}"}}"#), "InvalidNumber"),
            (&format!(r#"{{"precommitment":" 1","depositor":"{HEX64}"}}"#), "InvalidNumber"),
            (&format!(r#"{{"precommitment":"+1","depositor":"{HEX64}"}}"#), "InvalidNumber"),
            (&format!(r#"{{"precommitment":"00","depositor":"{HEX64}"}}"#), "InvalidNumber"),
            (&format!(r#"{{"precommitment":"1e3","depositor":"{HEX64}"}}"#), "InvalidNumber"),
            (&format!(r#"{{"precommitment":"1 ","depositor":"{HEX64}"}}"#), "InvalidNumber"),
            (&format!(r#"{{"precommitment":"{P_DEC}","depositor":"{HEX64}"}}"#), "FieldOverflow"),
            (
                &format!(r#"{{"precommitment":"{}","depositor":"{HEX64}"}}"#, "115792089237316195423570985008687907853269984665640564039457584007913129639935"),
                "FieldOverflow",
            ),
            (r#"{"precommitment":"1","depositor":"vault.near"}"#, "DepositorIsTheVault"),
        ];
        for (msg, want) in cases {
            let e = refusal(msg);
            assert!(e.contains(want), "{msg:?}: want {want:?}, got {e:?}");
        }
    }

    #[test]
    fn only_the_token_calls_it() {
        // the token's call passes rows 1-2 and stops at row 6: no prepay
        assert!(on_transfer(TOKEN, KIT_MSG).unwrap_err().contains("NoPrepay"));
        for caller in ["u.near", "intents.near", VAULT, "other-token.near"] {
            let e = on_transfer(caller, KIT_MSG).unwrap_err();
            assert!(e.contains("NotTheToken"), "{caller}: {e:?}");
        }
    }

    #[test]
    fn the_token_check_comes_before_the_message() {
        let e = on_transfer("u.near", "not json").unwrap_err();
        assert!(e.contains("NotTheToken"), "{e:?}");
    }

    #[test]
    fn a_bad_message_from_the_token_panics() {
        for (msg, want) in [
            ("not json", "InvalidMessage"),
            (r#"{"precommitment":"1","depositor":"vault.near"}"#, "DepositorIsTheVault"),
        ] {
            let e = on_transfer(TOKEN, msg).unwrap_err();
            assert!(e.contains(want), "{msg:?}: {e:?}");
        }
    }

    // ---- rows 3-12: the deposit ----

    const BYTE: u128 = 10_000_000_000_000_000_000;
    const AMOUNT: u128 = 1_000_000;

    fn msg(p: &str) -> String {
        format!(r#"{{"precommitment":"{p}","depositor":"{HEX64}"}}"#)
    }

    /// A call by `caller` with `attached` yocto; the storage written so far stays.
    fn call_by(caller: &str, attached: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(caller.parse().unwrap())
            .attached_deposit(near_sdk::NearToken::from_yoctonear(attached))
            .build());
    }

    fn prepay(v: &mut Vault, p: &str, yocto: u128) {
        call_by("relayer.near", yocto);
        v.storage_prepay(p.into());
    }

    /// The token's `ft_on_transfer` of `amount` on `p`: (its return, the bytes the call added to the usage), or the
    /// panic's text.
    fn deposit(v: &mut Vault, p: &str, amount: u128) -> Result<(u128, i64), String> {
        call_by(TOKEN, 0);
        let m = msg(p);
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let before = env::storage_usage();
            let r = v.ft_on_transfer(HEX64.parse().unwrap(), U128(amount), m).0;
            (r, env::storage_usage() as i64 - before as i64)
        }))
        .map_err(|e| e.downcast::<String>().map(|s| *s).unwrap_or_default())
    }

    /// The label of the `nonce`th deposit into the vault `VAULT`.
    fn label(nonce: u64) -> Bytes32 {
        field::to_be(&label_of(&crate::context::scope_for(VAULT, TOKEN), nonce))
    }

    fn dec(b: &Bytes32) -> String {
        field::to_decimal(&field::from_be(b))
    }

    /// The gross bytes the `n`th deposit (1-based) writes with a 64-byte depositor: 756, and 74 more per tree whose
    /// insert writes a new side node (the first insert, and each time the size passes a power of two).
    fn gross(n: u64) -> u128 {
        let grows = n == 1 || (n - 1).is_power_of_two();
        if grows { 904 } else { 756 }
    }

    #[test]
    fn a_prepaid_deposit_lands_returns_0_and_writes_every_record() {
        let mut v = Vault::default();
        let p = "12345";
        prepay(&mut v, p, 904 * BYTE);
        assert_eq!(deposit(&mut v, p, AMOUNT).unwrap().0, 0, "all used");
        let l = label(1);
        let c = PoseidonT4::new().hash(&amount_be(AMOUNT), &l, &be(p));
        // row 10: one leaf in each tree; a one-leaf LeanIMT's root is the leaf
        assert_eq!((v.state_tree.size, v.state_tree.leaf_at(0), v.state_tree.root()), (1, Some(c), c));
        assert_eq!((v.label_tree.size, v.label_tree.leaf_at(0), v.label_tree.root()), (1, Some(l), l));
        assert!(v.is_known_state_root(dec(&c)) && v.is_known_label_root(dec(&l)));
        assert_eq!(v.state_leaf_index.get(&c), Some(0));
        // row 11
        assert_eq!(v.nonce, 1);
        assert_eq!(v.precommitments.get(&be(p)), Some(0));
        assert_eq!(v.label_index.get(&l), Some(0));
        assert_eq!(v.prepaid.get(&be(p)), None, "row 6 deletes the record");
        assert_eq!(v.totals(), crate::Totals { deposited: U128(AMOUNT), spent: U128(0), returned: U128(0) });
        // the row the kit's vaultSync parses: these bytes, in this field order
        assert_eq!(
            near_sdk::serde_json::to_string(&v.deposits(0, 10)).unwrap(),
            format!(
                r#"[{{"index":0,"precommitment":"12345","label":"{}","value":"1000000","leaf_index":0,"depositor":"{HEX64}"}}]"#,
                dec(&l)
            )
        );
        // events, in PP's order
        let head = r#"EVENT_JSON:{"standard":"blindfill-vault","version":"1.0.0","event":"#;
        assert_eq!(
            near_sdk::test_utils::get_logs(),
            vec![
                format!(r#"{head}"leaf_inserted","data":[{{"tree":"state","index":0,"leaf":"{0}","root":"{0}"}}]}}"#, dec(&c)),
                format!(r#"{head}"leaf_inserted","data":[{{"tree":"label","index":0,"leaf":"{0}","root":"{0}"}}]}}"#, dec(&l)),
                format!(
                    r#"{head}"deposited","data":[{{"depositor":"{HEX64}","commitment":"{}","label":"{}","value":"1000000","precommitment":"12345"}}]}}"#,
                    dec(&c),
                    dec(&l)
                ),
            ]
        );
    }

    #[test]
    fn nine_deposits_write_their_gross_bytes_and_index_in_order() {
        let mut v = Vault::default();
        for n in 1..=9u64 {
            let p = (1000 + n).to_string();
            prepay(&mut v, &p, gross(n) * BYTE);
            let (r, added) = deposit(&mut v, &p, AMOUNT + n as u128).unwrap();
            assert_eq!(r, 0);
            // the call frees the 89 B prepay record and writes its gross bytes
            assert_eq!(added, gross(n) as i64 - 89, "deposit {n}");
            let d = &v.deposits(n - 1, 1)[0];
            assert_eq!((d.index, d.leaf_index, d.value.0, d.label.clone()), (n - 1, n - 1, AMOUNT + n as u128, dec(&label(n))));
        }
        assert_eq!((v.state_tree.size, v.state_tree.depth, v.label_tree.size, v.label_tree.depth), (9, 4, 9, 4));
        assert_eq!(v.totals().deposited.0, 9 * AMOUNT + 45);
    }

    #[test]
    fn row_7_a_first_deposit_one_yocto_short_of_904_bytes_is_refused() {
        let mut v = Vault::default();
        prepay(&mut v, "5", 904 * BYTE - 1);
        let e = deposit(&mut v, "5", AMOUNT).unwrap_err();
        assert!(e.contains("InsufficientStorageDeposit: the deposit wrote 904 B; the prepay covers 903 B"), "{e}");
    }

    #[test]
    fn row_7_a_756_byte_prepay_on_a_deposit_that_grows_the_trees_is_refused() {
        // the second deposit grows both trees by one level: 904 B
        let mut v = Vault::default();
        prepay(&mut v, "6", 904 * BYTE);
        deposit(&mut v, "6", AMOUNT).unwrap();
        prepay(&mut v, "7", 756 * BYTE);
        let e = deposit(&mut v, "7", AMOUNT).unwrap_err();
        assert!(e.contains("InsufficientStorageDeposit: the deposit wrote 904 B; the prepay covers 756 B"), "{e}");
        // a refused deposit logs no event (the sandbox reads the failed receipt's logs: tests/s02.rs)
        assert_eq!(near_sdk::test_utils::get_logs(), Vec::<String>::new());
    }

    #[test]
    fn row_7_a_148_byte_top_up_makes_it_enough() {
        let mut v = Vault::default();
        prepay(&mut v, "6", 904 * BYTE);
        deposit(&mut v, "6", AMOUNT).unwrap();
        prepay(&mut v, "7", 756 * BYTE);
        prepay(&mut v, "7", 148 * BYTE);
        assert_eq!(deposit(&mut v, "7", AMOUNT).unwrap(), (0, 904 - 89));
    }

    #[test]
    fn row_6_no_prepay_is_refused() {
        let mut v = Vault::default();
        prepay(&mut v, "8", 904 * BYTE);
        let e = deposit(&mut v, "9", AMOUNT).unwrap_err();
        assert!(e.contains("NoPrepay"), "{e}");
    }

    #[test]
    fn row_3_a_used_precommitment_is_refused() {
        let mut v = Vault::default();
        prepay(&mut v, "8", 904 * BYTE);
        deposit(&mut v, "8", AMOUNT).unwrap();
        // storage_prepay refuses a used precommitment; a record left from before the deposit is the only way in
        v.prepaid.insert(&be("8"), &(904 * BYTE));
        let e = deposit(&mut v, "8", AMOUNT).unwrap_err();
        assert!(e.contains("PrecommitmentAlreadyUsed"), "{e}");
    }

    /// Row 4 or 5 refuses `amount` with `want`, on a fresh vault in a thread of its own (the mocked storage is the
    /// thread's, kept across `testing_env!`, so a new `Vault::default()` in the same thread would see the last one's
    /// records).
    fn amount_refused(amount: u128, want: &'static str) {
        std::thread::spawn(move || {
            let mut v = Vault::default();
            prepay(&mut v, "3", 904 * BYTE);
            let e = deposit(&mut v, "3", amount).unwrap_err();
            assert!(e.contains(want), "{amount}: {e}");
        })
        .join()
        .unwrap();
    }

    #[test]
    fn rows_4_and_5_the_amount_bounds() {
        amount_refused(0, "MinimumDepositAmount");
        amount_refused(MIN_DEPOSIT - 1, "MinimumDepositAmount");
        amount_refused(u128::MAX, "InvalidDepositValue");
        for amount in [MIN_DEPOSIT, u128::MAX - 1] {
            std::thread::spawn(move || {
                let mut v = Vault::default();
                prepay(&mut v, "3", 904 * BYTE);
                assert_eq!(deposit(&mut v, "3", amount).unwrap().0, 0, "{amount}");
                assert_eq!(v.totals().deposited.0, amount);
            })
            .join()
            .unwrap();
        }
    }

    #[test]
    fn totals_deposited_never_wraps() {
        let mut v = Vault::default();
        prepay(&mut v, "1", 904 * BYTE);
        deposit(&mut v, "1", u128::MAX - 1).unwrap();
        prepay(&mut v, "2", 904 * BYTE);
        let e = deposit(&mut v, "2", 2 * MIN_DEPOSIT).unwrap_err();
        assert!(e.contains("TotalsOverflow"), "{e}");
    }

    #[test]
    fn the_depositor_is_the_messages_never_the_sender() {
        // intents.near sends the tokens and names another account (vault.md 2.5.1: any sender, the message's depositor)
        let other = "b".repeat(64);
        let mut v = Vault::default();
        prepay(&mut v, "21", 904 * BYTE);
        call_by(TOKEN, 0);
        let m = format!(r#"{{"precommitment":"21","depositor":"{other}"}}"#);
        assert_eq!(v.ft_on_transfer("intents.near".parse().unwrap(), U128(AMOUNT), m).0, 0);
        assert_eq!(v.deposits(0, 1)[0].depositor.as_str(), other);
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs[2].contains(&format!(r#""event":"deposited","data":[{{"depositor":"{other}""#)), "{logs:?}");
    }

    /// `noteCommitment(value, label, precommitment)` of packages/wallet/src/notes/secrets.ts at main daea6a5, printed
    /// by Node 24: what the device stores and proves against.
    const WALLET_COMMITMENTS: [(u128, &str, &str, &str); 2] = [
        (
            1_000_000,
            "3167541333153488070700576821596484314779793765261295951884779512873829920360",
            "12345",
            "18397814550587314788443050054570897998434978325342162224857524021341931129750",
        ),
        (
            (1 << 100) + 1_234_567_890_123,
            "21888242871839275222246405745257275088548364400416034343698204186575808495616",
            "7",
            "14144701124191034731627316939866497813649296286387451964003985403915721908665",
        ),
    ];

    #[test]
    fn the_commitment_is_the_wallets_note_commitment() {
        for (value, l, p, want) in WALLET_COMMITMENTS {
            assert_eq!(dec(&PoseidonT4::new().hash(&amount_be(value), &be(l), &be(p))), want, "{value}");
        }
        // and a real deposit: 1 USDC on 12345 at vault.near, whose first label is the first vector's
        let mut v = Vault::default();
        prepay(&mut v, "12345", 904 * BYTE);
        deposit(&mut v, "12345", 1_000_000).unwrap();
        assert_eq!(dec(&label(1)), WALLET_COMMITMENTS[0].1);
        assert_eq!(v.leaves(0, 1), vec![WALLET_COMMITMENTS[0].3.to_string()]);
    }

    #[test]
    fn leaf_index_is_the_state_trees() {
        // a state leaf with no label (a change note's) first: the deposit's leaf is the state tree's second, its label
        // the label tree's first
        let mut v = Vault::default();
        prepay(&mut v, "31", 904 * BYTE);
        let _ = v.insert_commitment(&mut PoseidonT3::new(), &be("99"));
        deposit(&mut v, "31", AMOUNT).unwrap();
        let d = &v.deposits(0, 1)[0];
        assert_eq!((d.index, d.leaf_index), (0, 1));
        assert_eq!((v.state_tree.size, v.label_tree.size), (2, 1));
        let c = PoseidonT4::new().hash(&amount_be(AMOUNT), &label(1), &be("31"));
        assert_eq!((v.state_tree.leaf_at(0), v.state_tree.leaf_at(1)), (Some(be("99")), Some(c)));
        assert_eq!(v.state_leaf_index.get(&c), Some(1));
    }
}
