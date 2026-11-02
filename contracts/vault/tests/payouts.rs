// SPDX-License-Identifier: Apache-2.0
//! `withdraw`'s payouts (vault.md 2.5.2 rows 13-15 and the gas pre-check) and `on_payout` (2.5.4) in near-sandbox
//! 2.13.4, each test on the mock token and on the real USDC wasm at TOKEN. Runs only with `--features sandbox`, through
//! tests/harness/run.sh (`contracts/vault/tests/harness/run.sh --test payouts`); a plain `cargo test` builds this file
//! empty.
//!
//! Every test starts from real deposits: the fixture's six notes (tests/fixtures/withdraw-spends.json), each a
//! `storage_prepay` on its precommitment then the depositor's own `ft_transfer_call` with the kit's message, so the
//! vault's `ft_on_transfer` makes the same leaves and labels the fixture's proofs were made against, and the vault
//! holds the 31,000,000 the notes are worth.
//!
//! 1. `one_part_fails_*`: same_call (2,000,000 with a 500,000 fee) with the recipient registered on the token and the
//!    fee recipient not, then (on a fresh vault) the reverse. The unregistered part fails on the token and nothing of
//!    it moves; the other part is delivered; `on_payout` leaves the spend `refund_pending` with `refund_value` equal
//!    to the failed part exactly, `totals.returned` the same, and logs `payout {delivered, returned}`.
//! 2. `vt_s04_*` (V:1138): relayed with a fee to an account the token has never seen, with its `register_deposit`:
//!    one Tgas under the gas bound (Σ static 70 + 100 Tgas) is refused (`InsufficientGas`), and row 14 one yocto short
//!    is refused (`InsufficientStorageDeposit`), each with no state byte, no storage use and no log changed and the
//!    nullifier unspent; then exactly the bound and exactly row 14's requirement land: the account is registered and
//!    paid 6,900,000, the relayer 100,000, the spend `paid` with REFUND_RESERVE_BYTES' worth in its reserve. Then a
//!    self withdrawal (fee 0, the recipient signs) lands at its own bound (145 Tgas) and requirement. Then `on_payout`
//!    called by anyone but the vault is refused.
//! 3. `a_registration_below_the_minimum_returns_part_0_*`: short_registration (4,000,000, no fee) attaches a
//!    `register_deposit` of 1 yocto, below the token's 0.00125 NEAR: part 0's storage_deposit fails, so its
//!    ft_transfer in the same receipt moves nothing; the spend reads `refund_pending` with the whole to_recipient,
//!    the token stays in the vault, and the NEAR the part carried (register_deposit + the transfer's 1 yocto) comes
//!    back to the vault as the refund receipt.
//!
//! Each prints its gas table: `vault::withdraw` (the vault's own work, the promises included, depth 3) and
//! `vault::on_payout`.
#![cfg(feature = "sandbox")]

mod harness;

use harness::{Harness, Outcome, Receipt, TokenKind, R, YOCTO_PER_BYTE};
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;

const SPENDS: &str = include_str!("fixtures/withdraw-spends.json");
/// The kit's prepay whenever a tree may grow (2.10 (h)).
const PREPAY_BYTES: u128 = 904;
/// 2.3: a spend's bytes with a 64-byte payer and recipient, when the state tree grows no level.
const SPEND_BYTES: u128 = 710;
const REFUND_RESERVE_BYTES: u128 = blindfill_vault::constants::REFUND_RESERVE_BYTES as u128;
/// USDC's and the mock's registration.
const REGISTER: u128 = 1_250_000_000_000_000_000_000;

fn fixture() -> Value {
    serde_json::from_str(SPENDS).unwrap()
}

/// The fixture's spend `name` as `withdraw`'s arguments.
fn args(name: &str) -> Value {
    let f = fixture();
    let s = f["spends"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap().clone();
    json!({"withdrawal": s["withdrawal"], "proof": s["proof"], "public_signals": s["public_signals"]})
}

fn nullifier(name: &str) -> String {
    args(name)["public_signals"][1].as_str().unwrap().to_string()
}

/// Row 14's requirement for a spend whose payer and recipient ids have these lengths, when no tree grows a level.
fn row14_need(payer: &str, recipient: &str, register_deposit: u128, transfers: u128) -> u128 {
    let bytes = SPEND_BYTES - (64 - payer.len() as u128) - (64 - recipient.len() as u128);
    (bytes + REFUND_RESERVE_BYTES) * YOCTO_PER_BYTE + register_deposit + transfers
}

/// A vault on `kind`'s token holding the fixture's six notes, deposited through `ft_on_transfer`; the relayer and
/// alice (the fixture's recipient) exist and are not registered on the token.
async fn deposited(kind: TokenKind) -> R<(Harness, Account, Account)> {
    let h = Harness::with_vault_and(kind).await?;
    let f = fixture();
    let u = h.account("u", 50).await?;
    let relayer = h.account("relayer", 50).await?;
    let alice = h.account("alice", 50).await?;
    assert_eq!((relayer.id().as_str(), alice.id().as_str()), ("relayer.test.near", "alice.test.near"), "the fixture's accounts");
    let total: u128 = f["deposited"].as_str().unwrap().parse()?;
    h.mint(u.id(), total).await?;
    let prepay = NearToken::from_yoctonear(PREPAY_BYTES * YOCTO_PER_BYTE);
    for (p, value) in f["precommitments"].as_array().unwrap().iter().zip(f["values"].as_array().unwrap()) {
        let p = p.as_str().unwrap();
        let _ = h.call(&relayer, &h.vault, "storage_prepay", json!({"precommitment": p}), prepay, Gas::from_tgas(30)).await?;
        let msg = format!(r#"{{"precommitment":"{p}","depositor":"{}"}}"#, u.id());
        let o = h
            .call(&u, &h.token, "ft_transfer_call", json!({"receiver_id": h.vault, "amount": value, "msg": msg}), NearToken::from_yoctonear(1), Gas::from_tgas(180))
            .await?;
        let _ = o.calls_exactly(&h.vault, "ft_on_transfer", 1)?;
    }
    assert_eq!(h.view(&h.vault, "leaves", json!({"from": 0, "limit": 10})).await?, f["leaves"], "the deposits' leaves are the fixture's");
    assert_eq!(h.view(&h.vault, "labels", json!({"from": 0, "limit": 10})).await?, f["labels"], "the deposits' labels are the fixture's");
    assert_eq!(h.view(&h.vault, "totals", json!({})).await?["deposited"], f["deposited"]);
    assert_eq!(h.token_balance(&h.vault).await?, total);
    println!("{kind:?}: six deposits through ft_on_transfer, {total} held");
    Ok((h, relayer, alice))
}

async fn spend_rows(h: &Harness) -> R<Vec<Value>> {
    Ok(h.view(&h.vault, "spends", json!({"from": 0, "limit": 100})).await?.as_array().ok_or("spends: not a list")?.clone())
}

async fn spend_row(h: &Harness, name: &str) -> R<Value> {
    let n = nullifier(name);
    Ok(spend_rows(h).await?.into_iter().find(|r| r["nullifier_hash"] == n).ok_or_else(|| format!("no spend of {name}"))?)
}

/// The vault's whole raw state at final, in key order.
async fn vault_state(h: &Harness) -> R<Vec<(String, String)>> {
    let v = h.rpc("query", json!({"request_type": "view_state", "finality": "final", "account_id": h.vault, "prefix_base64": ""})).await?;
    let values = v["result"]["values"].as_array().ok_or_else(|| format!("view_state: {v}"))?;
    let mut kv: Vec<(String, String)> = values
        .iter()
        .map(|e| (e["key"].as_str().unwrap_or_default().to_string(), e["value"].as_str().unwrap_or_default().to_string()))
        .collect();
    kv.sort();
    Ok(kv)
}

async fn withdraw(h: &Harness, by: &Account, a: Value, yocto: u128, tgas: u64) -> R<Outcome> {
    h.call_outcome(by, &h.vault, "withdraw", a, NearToken::from_yoctonear(yocto), Gas::from_tgas(tgas)).await
}

/// The call is refused with `want` in its withdraw receipt, which logged nothing, and no state byte, no storage use
/// and no token balance changed.
async fn refused(h: &Harness, by: &Account, a: Value, yocto: u128, tgas: u64, want: &str) -> R<()> {
    let state = vault_state(h).await?;
    let used = h.account_view(&h.vault, "final").await?["storage_usage"].clone();
    let held = h.token_balance(&h.vault).await?;
    let o = withdraw(h, by, a, yocto, tgas).await?;
    let r = o.calls_exactly(&h.vault, "withdraw", 1)?[0];
    let f = r.failure().ok_or_else(|| format!("landed, want {want}"))?;
    assert!(f.contains(want), "want {want}, got {f}");
    assert!(r.logs.is_empty(), "{want}: a refused call logged {:?}", r.logs);
    assert!(o.calls_exactly(&h.vault, "on_payout", 0).is_ok() && !o.receipts.iter().any(|x| x.methods.contains(&"ft_transfer".to_string())), "{want}: a payout was made");
    h.wait_final(&h.vault).await?;
    assert_eq!(vault_state(h).await?, state, "{want}: a state byte changed");
    assert_eq!(h.account_view(&h.vault, "final").await?["storage_usage"], used, "{want}: the storage use changed");
    assert_eq!(h.token_balance(&h.vault).await?, held, "{want}: the vault's token balance changed");
    println!("refused ({want}): {}", r.line());
    Ok(())
}

/// A receipt's last function call's arguments, as text.
fn args_text(r: &Receipt) -> String {
    let b: near_sdk::json_types::Base64VecU8 = serde_json::from_value(json!(r.args.last().unwrap())).unwrap();
    String::from_utf8(b.0).unwrap()
}

/// The event names a receipt logged, in order.
fn events(r: &Receipt) -> Vec<String> {
    r.logs.iter().map(|l| l.split(r#""event":""#).nth(1).and_then(|e| e.split('"').next()).unwrap_or("").to_string()).collect()
}

/// The withdrawal landed: its withdraw receipt logged exactly its three events, each payout part's receipt ran as
/// `want` says (recipient part, fee part), and on_payout ran once and logged `payout {delivered, returned}`.
fn landed(h: &Harness, o: &Outcome, name: &str, parts: &[(&str, bool)], delivered: u128, returned: u128) -> R<()> {
    let w = o.calls_exactly(&h.vault, "withdraw", 1)?[0];
    assert!(w.ok(), "{name}: {}", w.line());
    assert_eq!(events(w), ["leaf_inserted", "withdrawn", "withdrawal_relayed"], "{name}: {:?}", w.logs);
    let transfers: Vec<&Receipt> = o.receipts.iter().filter(|r| r.executor == h.token.as_str() && r.methods.last().map(String::as_str) == Some("ft_transfer")).collect();
    assert_eq!(transfers.len(), parts.len(), "{name}: payout parts {:#?}", transfers.iter().map(|r| r.line()).collect::<Vec<_>>());
    for (who, ok) in parts {
        let r = transfers.iter().find(|r| args_text(r).contains(&format!(r#""receiver_id":"{who}""#)));
        let r = r.ok_or_else(|| format!("{name}: no part to {who}"))?;
        assert_eq!(r.ok(), *ok, "{name}: the part to {who}: {}", r.line());
        println!("{name}: part to {who}: {}", r.line());
    }
    let cb = o.calls_exactly(&h.vault, "on_payout", 1)?[0];
    assert!(cb.ok(), "{name}: {}", cb.line());
    assert_eq!(cb.logs.len(), 1, "{name}: {:?}", cb.logs);
    let n = nullifier(name);
    assert!(
        cb.logs[0].ends_with(&format!(r#""event":"payout","data":[{{"nullifier_hash":"{n}","delivered":"{delivered}","returned":"{returned}"}}]}}"#)),
        "{name}: {}",
        cb.logs[0]
    );
    println!("{name}: {}\n{name}: {}", w.line(), cb.line());
    Ok(())
}

#[derive(Clone, Copy, Debug)]
enum Failing {
    Fee,
    Recipient,
}

async fn one_part_fails(kind: TokenKind, failing: Failing) -> R<()> {
    let (h, relayer, alice) = deposited(kind).await?;
    let (paid, unpaid) = match failing {
        Failing::Fee => (&alice, &relayer),
        Failing::Recipient => (&relayer, &alice),
    };
    let _ = h.storage_deposit(&h.root, paid.id()).await?;
    assert!(h.view(&h.token, "storage_balance_of", json!({"account_id": unpaid.id()})).await?.is_null());
    let (to_recipient, fee) = (1_500_000u128, 500_000u128);
    let (delivered, returned) = match failing {
        Failing::Fee => (to_recipient, fee),
        Failing::Recipient => (fee, to_recipient),
    };
    let o = withdraw(&h, &relayer, args("same_call"), 1_000_000_000_000_000_000_000_000, 300).await?;
    landed(&h, &o, "same_call", &[("alice.test.near", matches!(failing, Failing::Fee)), ("relayer.test.near", matches!(failing, Failing::Recipient))], delivered, returned)?;
    h.wait_final(&h.vault).await?;
    // exactly the delivered part moved; the failed part is still the vault's
    assert_eq!(h.token_balance(paid.id()).await?, delivered, "{failing:?}: the delivered part");
    assert_eq!(h.token_balance(unpaid.id()).await?, 0, "{failing:?}: the failed part moved");
    assert_eq!(h.token_balance(&h.vault).await?, 31_000_000 - delivered);
    let r = spend_row(&h, "same_call").await?;
    assert_eq!((r["status"].as_str(), r["refund_value"].clone()), (Some("refund_pending"), json!(returned.to_string())), "{r}");
    let t = h.view(&h.vault, "totals", json!({})).await?;
    assert_eq!((t["spent"].clone(), t["returned"].clone()), (json!("2000000"), json!(returned.to_string())), "{t}");
    println!("{kind:?}, {failing:?} failed: delivered {delivered}, refund_pending {returned}\n{}", h.gas_table());
    Ok(())
}

#[tokio::test]
async fn one_part_fails_mock_fee() -> R<()> {
    one_part_fails(TokenKind::Mock, Failing::Fee).await
}

#[tokio::test]
async fn one_part_fails_mock_recipient() -> R<()> {
    one_part_fails(TokenKind::Mock, Failing::Recipient).await
}

#[tokio::test]
async fn one_part_fails_usdc_fee() -> R<()> {
    one_part_fails(TokenKind::Usdc, Failing::Fee).await
}

#[tokio::test]
async fn one_part_fails_usdc_recipient() -> R<()> {
    one_part_fails(TokenKind::Usdc, Failing::Recipient).await
}

async fn vt_s04(kind: TokenKind) -> R<()> {
    let (h, relayer, alice) = deposited(kind).await?;
    for a in [&relayer, &alice] {
        let _ = h.storage_deposit(&h.root, a.id()).await?;
    }
    let newcomer = h.account("newcomer", 5).await?;
    assert!(h.view(&h.token, "storage_balance_of", json!({"account_id": newcomer.id()})).await?.is_null(), "the newcomer is registered");

    // relayed, with a fee and a registration: the bound is 15 + 10 + 15 + 30 + 100 Tgas
    let a = args("new_account");
    let bound = 170;
    let need = row14_need(relayer.id().as_str(), newcomer.id().as_str(), REGISTER, 2);
    refused(&h, &relayer, a.clone(), need, bound - 1, "InsufficientGas").await?;
    refused(&h, &relayer, a.clone(), need - 1, bound, "InsufficientStorageDeposit").await?;
    assert!(spend_rows(&h).await?.is_empty(), "a refused call spent the nullifier");
    let o = withdraw(&h, &relayer, a, need, bound).await?;
    landed(&h, &o, "new_account", &[("newcomer.test.near", true), ("relayer.test.near", true)], 7_000_000, 0)?;
    let part0 = o.receipts.iter().find(|r| r.methods == ["storage_deposit", "ft_transfer"]).ok_or("no [storage_deposit, ft_transfer] part")?;
    assert!(part0.ok(), "{}", part0.line());
    h.wait_final(&h.vault).await?;
    assert!(!h.view(&h.token, "storage_balance_of", json!({"account_id": newcomer.id()})).await?.is_null(), "the registration did not happen");
    assert_eq!(h.token_balance(newcomer.id()).await?, 6_900_000);
    assert_eq!(h.token_balance(relayer.id()).await?, 100_000);
    let r = spend_row(&h, "new_account").await?;
    assert_eq!((r["status"].as_str(), r["refund_value"].as_str()), (Some("paid"), Some("0")), "{r}");
    assert_eq!(r["reserve"], json!((REFUND_RESERVE_BYTES * YOCTO_PER_BYTE).to_string()), "row 14 keeps the reserve's worth");
    println!("relayed with a registration: landed at {bound} Tgas and exactly {need} yocto");

    // self, fee 0: alice signs her own withdrawal; the bound is 15 + 30 + 100 Tgas
    let bound = 145;
    let need = row14_need(alice.id().as_str(), alice.id().as_str(), 0, 1);
    refused(&h, &alice, args("same_nullifier_a"), need, bound - 1, "InsufficientGas").await?;
    let o = withdraw(&h, &alice, args("same_nullifier_a"), need, bound).await?;
    landed(&h, &o, "same_nullifier_a", &[("alice.test.near", true)], 1_000_000, 0)?;
    h.wait_final(&h.vault).await?;
    assert_eq!(h.token_balance(alice.id()).await?, 1_000_000);
    let r = spend_row(&h, "same_nullifier_a").await?;
    assert_eq!((r["status"].as_str(), r["payer"].as_str()), (Some("paid"), Some("alice.test.near")), "{r}");
    assert_eq!(h.token_balance(&h.vault).await?, 31_000_000 - 7_000_000 - 1_000_000);
    let t = h.view(&h.vault, "totals", json!({})).await?;
    assert_eq!((t["spent"].clone(), t["returned"].clone()), (json!("8000000"), json!("0")), "{t}");

    // on_payout is the vault's own callback: anyone else is refused, and nothing changes
    let state = vault_state(&h).await?;
    let o = h
        .call_outcome(&alice, &h.vault, "on_payout", json!({"spend_index": 0, "to_recipient": "6900000", "fee": "100000"}), NearToken::from_yoctonear(0), Gas::from_tgas(30))
        .await?;
    let f = o.calls_exactly(&h.vault, "on_payout", 1)?[0].failure().ok_or("a stranger's on_payout landed")?.to_string();
    assert!(f.contains("private"), "{f}");
    h.wait_final(&h.vault).await?;
    assert_eq!(vault_state(&h).await?, state, "a stranger's on_payout changed state");
    println!("{kind:?}: VT-S04 holds\n{}", h.gas_table());
    Ok(())
}

/// The NEAR the runtime's refund receipts (predecessor `system`) gave `to` in transaction `tx`.
async fn refunded_to(h: &Harness, tx: &str, signer: &str, to: &str) -> R<u128> {
    let v = h.rpc("EXPERIMENTAL_tx_status", json!({"tx_hash": tx, "sender_account_id": signer, "wait_until": "FINAL"})).await?;
    let mut sum = 0u128;
    for rc in v["result"]["receipts"].as_array().ok_or_else(|| format!("tx {tx}: {v}"))? {
        if rc["predecessor_id"] != "system" || rc["receiver_id"] != to {
            continue;
        }
        for a in rc["receipt"]["Action"]["actions"].as_array().into_iter().flatten() {
            if let Some(d) = a["Transfer"]["deposit"].as_str() {
                sum += d.parse::<u128>()?;
            }
        }
    }
    Ok(sum)
}

async fn a_registration_below_the_minimum_returns_part_0(kind: TokenKind) -> R<()> {
    let (h, relayer, _alice) = deposited(kind).await?;
    let fresh = h.account("fresh", 5).await?;
    let need = row14_need(relayer.id().as_str(), fresh.id().as_str(), 1, 1);
    // no fee, a registration: 15 + 10 + 30 + 100 Tgas
    let o = withdraw(&h, &relayer, args("short_registration"), need, 155).await?;
    landed(&h, &o, "short_registration", &[("fresh.test.near", false)], 0, 4_000_000)?;
    let part0 = o.receipts.iter().find(|r| r.methods == ["storage_deposit", "ft_transfer"]).ok_or("no [storage_deposit, ft_transfer] part")?;
    let f = part0.failure().ok_or("part 0 landed")?;
    println!("part 0 failed at its storage_deposit: {f}");
    assert!(f.contains(r#""index":0"#), "part 0 did not fail at its first action, storage_deposit: {f}");
    h.wait_final(&h.vault).await?;
    assert!(h.view(&h.token, "storage_balance_of", json!({"account_id": fresh.id()})).await?.is_null(), "fresh got registered");
    assert_eq!(h.token_balance(fresh.id()).await?, 0);
    assert_eq!(h.token_balance(&h.vault).await?, 31_000_000, "the token left the vault");
    let r = spend_row(&h, "short_registration").await?;
    assert_eq!((r["status"].as_str(), r["refund_value"].as_str()), (Some("refund_pending"), Some("4000000")), "{r}");
    assert_eq!(h.view(&h.vault, "totals", json!({})).await?["returned"], "4000000");
    let back = refunded_to(&h, &o.tx_hash, relayer.id().as_str(), h.vault.as_str()).await?;
    println!("{kind:?}: refund receipts to the vault: {back} yocto (register_deposit 1 + 1 yocto)\n{}", h.gas_table());
    assert_eq!(back, 2, "the vault did not get back register_deposit + the transfer's yocto");
    Ok(())
}

#[tokio::test]
async fn a_registration_below_the_minimum_returns_part_0_mock() -> R<()> {
    a_registration_below_the_minimum_returns_part_0(TokenKind::Mock).await
}

#[tokio::test]
async fn a_registration_below_the_minimum_returns_part_0_usdc() -> R<()> {
    a_registration_below_the_minimum_returns_part_0(TokenKind::Usdc).await
}

#[tokio::test]
async fn vt_s04_mock() -> R<()> {
    vt_s04(TokenKind::Mock).await
}

#[tokio::test]
async fn vt_s04_usdc() -> R<()> {
    vt_s04(TokenKind::Usdc).await
}
