// SPDX-License-Identifier: Apache-2.0
//! `storage_prepay(precommitment)` (vault.md 2.5.1, Dev 3): a deposit's storage, paid ahead under its precommitment.
//!
//! A token transfer brings no NEAR (the token's `ft_on_transfer` call attaches none), so whoever carries a deposit,
//! usually the relayer, pays its storage first. The NEAR stays with the vault: there is no reclaim, so nobody can pull
//! a prepay out from under a deposit in flight, and the deposit (2.5.1 rows 6-7) deletes the record and checks that its
//! amount covers the bytes the deposit really wrote. Anyone may prepay or add to a record.
//!
//! The vault's first prepay also writes the contract's state record from `Default` (200 B at this layout, measured in
//! tests/s02.rs), once ever; the deploy recipe's extra 0.01 N pays it (2.8), not the prepay.
//!
//! A NEAR addition: Privacy Pools v1.3.0 has no storage deposit (EVM has none; vault.md 2.7 Dev 3).

use crate::constants::DEPOSIT_STORAGE_BYTES;
use crate::events::Event;
use crate::{field, Bytes32, Vault, VaultExt};
use near_sdk::{env, near};

/// The precommitment argument: one canonical decimal (2.5.2 row 1, `InvalidNumber`), below p (`FieldOverflow`), so a
/// prepay and its deposit key one record.
fn precommitment_arg(s: &str) -> Bytes32 {
    let n = field::parse_decimal(s)
        .unwrap_or_else(|| env::panic_str("InvalidNumber: the precommitment is not a canonical decimal"));
    if field::ge(&n, &field::P) {
        env::panic_str("FieldOverflow: the precommitment is not below p");
    }
    field::to_be(&n)
}

#[near]
impl Vault {
    /// Adds the attached NEAR to `prepaid[precommitment]`. Refused: a precommitment that is not a canonical decimal
    /// below p, one a deposit already used (`PrecommitmentAlreadyUsed`), and a new record with less than
    /// `DEPOSIT_STORAGE_BYTES` × `storage_byte_cost()` attached (`InsufficientStorageDeposit`). Any amount adds to an
    /// existing record. Event `storage_prepaid {precommitment, payer, amount}`, `amount` being this call's attachment.
    #[payable]
    pub fn storage_prepay(&mut self, precommitment: String) {
        let p = precommitment_arg(&precommitment);
        if self.precommitments.contains_key(&p) {
            env::panic_str("PrecommitmentAlreadyUsed");
        }
        let attached = env::attached_deposit().as_yoctonear();
        let total = match self.prepaid.get(&p) {
            Some(held) => held + attached,
            None => {
                let min = DEPOSIT_STORAGE_BYTES as u128 * env::storage_byte_cost().as_yoctonear();
                if attached < min {
                    env::panic_str("InsufficientStorageDeposit: a new prepay takes at least DEPOSIT_STORAGE_BYTES");
                }
                attached
            }
        };
        self.prepaid.insert(&p, &total);
        Event::StoragePrepaid { precommitment: &p, payer: &env::predecessor_account_id(), amount: attached }.emit();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    const P_DEC: &str = "21888242871839275222246405745257275088548364400416034343698204186575808495617";
    const P_MINUS_1: &str = "21888242871839275222246405745257275088548364400416034343698204186575808495616";
    const BYTE: u128 = 10_000_000_000_000_000_000;
    const MIN: u128 = DEPOSIT_STORAGE_BYTES as u128 * BYTE;

    fn as_payer(payer: &str, attached: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("vault.testnet".parse().unwrap())
            .predecessor_account_id(payer.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(attached))
            .build());
    }

    fn be(dec: &str) -> Bytes32 {
        field::to_be(&field::from_decimal(dec).unwrap())
    }

    #[test]
    fn a_new_record_takes_756_bytes_and_records_the_attachment() {
        let mut v = Vault::default();
        as_payer("relayer.testnet", MIN);
        v.storage_prepay("12345".into());
        assert_eq!(v.prepaid.get(&be("12345")), Some(MIN));
        assert_eq!(
            get_logs(),
            vec![format!(
                r#"EVENT_JSON:{{"standard":"blindfill-vault","version":"1.0.0","event":"storage_prepaid","data":[{{"precommitment":"12345","payer":"relayer.testnet","amount":"{MIN}"}}]}}"#
            )]
        );
    }

    #[test]
    #[should_panic(expected = "InsufficientStorageDeposit")]
    fn a_new_record_one_yocto_short_is_refused() {
        let mut v = Vault::default();
        as_payer("relayer.testnet", MIN - 1);
        v.storage_prepay("12345".into());
    }

    #[test]
    fn a_top_up_adds_any_amount_from_anyone() {
        let mut v = Vault::default();
        as_payer("relayer.testnet", MIN);
        v.storage_prepay("7".into());
        // 756 B to 904 B: the 148 B a deposit writes more when a tree grows a level (vault.md 2.3)
        as_payer("stranger.testnet", 148 * BYTE);
        v.storage_prepay("7".into());
        assert_eq!(v.prepaid.get(&be("7")), Some(904 * BYTE));
        // the event names this call's attachment, never the record's running total
        assert_eq!(logged_amount(), (148 * BYTE).to_string());
        as_payer("stranger.testnet", 1);
        v.storage_prepay("7".into());
        assert_eq!(v.prepaid.get(&be("7")), Some(904 * BYTE + 1));
        assert_eq!(logged_amount(), "1");
    }

    /// The `amount` of the one `storage_prepaid` line the last call logged.
    fn logged_amount() -> String {
        let logs = get_logs();
        assert_eq!(logs.len(), 1, "{logs:?}");
        let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&logs[0]["EVENT_JSON:".len()..]).unwrap();
        assert_eq!(v["event"], "storage_prepaid");
        v["data"][0]["amount"].as_str().unwrap().to_string()
    }

    #[test]
    fn p_minus_one_is_a_precommitment() {
        let mut v = Vault::default();
        as_payer("relayer.testnet", MIN);
        v.storage_prepay(P_MINUS_1.into());
        assert_eq!(v.prepaid.get(&be(P_MINUS_1)), Some(MIN));
    }

    #[test]
    #[should_panic(expected = "FieldOverflow")]
    fn p_itself_is_refused() {
        let mut v = Vault::default();
        as_payer("relayer.testnet", MIN);
        v.storage_prepay(P_DEC.into());
    }

    #[test]
    #[should_panic(expected = "FieldOverflow")]
    fn the_largest_256_bit_number_is_refused() {
        let mut v = Vault::default();
        as_payer("relayer.testnet", MIN);
        v.storage_prepay("115792089237316195423570985008687907853269984665640564039457584007913129639935".into());
    }

    #[test]
    fn a_non_canonical_decimal_is_refused() {
        for bad in ["", "00", "007", "-1", "+1", "0x1", "1 ", "1e3"] {
            let r = std::panic::catch_unwind(|| {
                let mut v = Vault::default();
                as_payer("relayer.testnet", MIN);
                v.storage_prepay(bad.into());
            });
            let msg = r.err().and_then(|e| e.downcast::<String>().ok()).map(|s| *s).unwrap_or_default();
            assert!(msg.contains("InvalidNumber"), "{bad:?}: {msg:?}");
        }
    }

    #[test]
    #[should_panic(expected = "PrecommitmentAlreadyUsed")]
    fn a_used_precommitment_is_refused_even_with_a_record_left() {
        let mut v = Vault::default();
        as_payer("relayer.testnet", MIN);
        v.storage_prepay("9".into());
        // a deposit used P (2.5.1 row 11 writes `precommitments`); a later prepay on P can never land
        v.precommitments.insert(&be("9"), &0);
        as_payer("relayer.testnet", MIN);
        v.storage_prepay("9".into());
    }
}
