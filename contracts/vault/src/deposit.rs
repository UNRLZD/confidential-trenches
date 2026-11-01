// SPDX-License-Identifier: Apache-2.0
//! `ft_on_transfer(sender_id, amount, msg)` (vault.md 2.5.1), the message part: rows 1 and 2 of the deposit table.
//!
//! - Row 1: only the pinned token (`TOKEN`) may call it. The method is public; only the token as caller shows that a
//!   transfer happened (Dev 4, in place of PP's `safeTransferFrom` in `Entrypoint.sol:123`).
//! - Row 2: `msg` is at most 1,024 bytes and is exactly `{"precommitment":"<decimal>","depositor":"<account>"}`, both
//!   fields required, no third field, no field twice; `precommitment` is one canonical decimal (2.5.2 row 1:
//!   `InvalidNumber`) below p (`FieldOverflow`); `depositor` is a valid NEAR account id and not this vault. PP takes
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
//! Rows 3 to 12 (the precommitment unused, the amount bounds, the prepay, the label, the commitment and its insert) are
//! card vault-deposit-insert's. Until they land, a message that passes rows 1 and 2 is answered with the whole amount
//! as unused, so the token gives it back and the vault never keeps USDC without a note.

use crate::constants::TOKEN;
use crate::{field, Bytes32, Vault, VaultExt};
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
    if m.depositor == *vault {
        return Err("DepositorIsTheVault".into());
    }
    Ok(DepositMessage { precommitment: field::to_be(&n), depositor: m.depositor })
}

#[near]
impl Vault {
    /// NEP-141's receiver call, made by the token during `ft_transfer_call(vault, amount, msg)`. Refused (a panic, so
    /// the token gives the sender the whole amount back): any caller but `TOKEN` (`NotTheToken`), and a message that
    /// fails row 2 (`MessageTooLong`, `InvalidMessage`, `InvalidNumber`, `FieldOverflow`, `DepositorIsTheVault`).
    /// Returns the amount unused: all of it until rows 3-12 land.
    pub fn ft_on_transfer(&self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let _ = sender_id;
        if env::predecessor_account_id().as_str() != TOKEN {
            env::panic_str("NotTheToken: only the vault's token calls ft_on_transfer");
        }
        if let Err(e) = deposit_message(&msg, &env::current_account_id()) {
            env::panic_str(&e);
        }
        amount
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
    /// `vaultDepositMessage(0n, "0123456789abcdef".repeat(4))`.
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

    /// `ft_on_transfer` as `caller`, its panic text or its return.
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
        let m = deposit_message(KIT_MSG_ZERO, &vault()).unwrap();
        assert_eq!(m.precommitment, [0u8; 32]);
        assert_eq!(m.depositor.as_str(), "0123456789abcdef".repeat(4));
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
        assert_eq!(on_transfer(TOKEN, KIT_MSG), Ok(1_000_000));
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
}
