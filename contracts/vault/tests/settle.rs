// SPDX-License-Identifier: Apache-2.0
//! VT-S08 (vault.md 5, V:1142): `settle` (2.5.5) in near-sandbox 2.13.4, on the mock token and on the real USDC wasm at
//! TOKEN. Runs only with `--features sandbox`, through tests/harness/run.sh
//! (`contracts/vault/tests/harness/run.sh --test settle`); a plain `cargo test` builds this file empty.
//!
//! From the six deposits of tests/fixtures/withdraw-spends.json, made through `ft_on_transfer`, and the proofs of
//! tests/fixtures/settle-spends.json, whose refund precommitments are notes the test can spend:
//! 1. fee_bounces: relayed, to a recipient already registered with a `register_deposit` > 0, the fee recipient not
//!    registered: the fee's transfer fails the one payout receipt, so nothing moves (review A-01), the registration
//!    NEAR and the yocto come back into the vault as the runtime's refund, and the whole withdrawal is refund_pending
//!    (7,000,000). The relayer attaches exactly row 14's requirement, so the reserve is 389 B' worth.
//! 2. recipient_bounces: relayed, to an unregistered recipient with `register_deposit` 0: the recipient's transfer
//!    fails the payout receipt (refund_pending 2,000,000, no fee kept). The relayer attaches row 14's requirement and
//!    SURPLUS.
//! 3. A stranger settles fee_bounces. Its refund note is the state tree's 9th leaf, so the tree grows a level and
//!    settle writes 389 + 74 B: one yocto short of the shortfall is refused with no state byte, no storage use, no
//!    log and no NEAR moved; then the shortfall and EXTRA lands, the refund note is exactly 7,000,000 on its precommitment
//!    with the label of nonce 7, the stranger gets EXTRA back, the payer nothing. A second settle is refused. Then
//!    recipient_bounces: a note of exactly 2,000,000, and the payer's balance rises by exactly SURPLUS. `totals`, so
//!    row 9's held value, never moves in a settle.
//! 4. The device spends fee_bounces' refund note (a proof against both trees as step 3 left them): the recipient is
//!    paid 7,000,000. Settling that paid spend returns its whole reserve to the payer, read on the payer's balance.
//! 5. An unknown nullifier is refused. (`in_flight` cannot be held in the sandbox, since the callback runs in the
//!    next blocks: the lib tests in src/settle.rs refuse it, and VT-S17 records a failed callback's state.)
//!
//! Prints the gas of each settle (the vault's receipt, with the trees' depths) and the gas table.
#![cfg(feature = "sandbox")]

mod harness;

use harness::{Harness, Outcome, Receipt, TokenKind, R, YOCTO_PER_BYTE};
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;

const DEPOSITS: &str = include_str!("fixtures/withdraw-spends.json");
const SPENDS: &str = include_str!("fixtures/settle-spends.json");
/// The kit's prepay whenever a tree may grow (2.10 (h)).
const PREPAY_BYTES: u128 = 904;
/// 2.3: a spend's bytes with a 64-byte payer and recipient, when the state tree grows no level.
const SPEND_BYTES: u128 = 710;
const REFUND_RESERVE_BYTES: u128 = blindfill_vault::constants::REFUND_RESERVE_BYTES as u128;
/// What a tree that grows a level adds to an insert (2.3).
const LEVEL_BYTES: u128 = 74;
/// USDC's and the mock's registration.
const REGISTER: u128 = 1_250_000_000_000_000_000_000;
/// What the relayer attaches to recipient_bounces above row 14's requirement.
const SURPLUS: u128 = 1_234_567_890_123;
/// What the stranger attaches to the first settle above its shortfall.
const EXTRA: u128 = 987_654_321;

fn json_of(s: &str) -> Value {
    serde_json::from_str(s).unwrap()
}

/// The settle fixture's spend `name` as `withdraw`'s arguments.
fn args(name: &str) -> Value {
    let f = json_of(SPENDS);
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

/// A vault on `kind`'s token holding the six notes, deposited through `ft_on_transfer` (as tests/payouts.rs does);
/// the relayer and alice exist and are not registered on the token.
async fn deposited(kind: TokenKind) -> R<(Harness, Account, Account)> {
    let h = Harness::with_vault_and(kind).await?;
    let f = json_of(DEPOSITS);
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
    assert_eq!(h.token_balance(&h.vault).await?, total);
    Ok((h, relayer, alice))
}

async fn spend_row(h: &Harness, name: &str) -> R<Value> {
    let n = nullifier(name);
    let rows = h.view(&h.vault, "spends", json!({"from": 0, "limit": 100})).await?;
    Ok(rows.as_array().ok_or("spends: not a list")?.iter().find(|r| r["nullifier_hash"] == n).ok_or_else(|| format!("no spend of {name}"))?.clone())
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

async fn storage_usage(h: &Harness) -> R<u128> {
    Ok(h.account_view(&h.vault, "final").await?["storage_usage"].as_u64().ok_or("no storage_usage")? as u128)
}

/// The event names a receipt logged, in order.
fn events(r: &Receipt) -> Vec<String> {
    r.logs.iter().map(|l| l.split(r#""event":""#).nth(1).and_then(|e| e.split('"').next()).unwrap_or("").to_string()).collect()
}

/// A log line's one `data` object.
fn data(line: &str) -> Value {
    let v: Value = serde_json::from_str(line.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    v["data"][0].clone()
}

/// The NEAR that `from`'s Transfer actions gave `to` in transaction `tx`.
async fn transferred(h: &Harness, tx: &str, signer: &str, from: &str, to: &str) -> R<u128> {
    let v = h.rpc("EXPERIMENTAL_tx_status", json!({"tx_hash": tx, "sender_account_id": signer, "wait_until": "FINAL"})).await?;
    let mut sum = 0u128;
    for rc in v["result"]["receipts"].as_array().ok_or_else(|| format!("tx {tx}: {v}"))? {
        if rc["predecessor_id"] != from || rc["receiver_id"] != to {
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

async fn withdraw(h: &Harness, by: &Account, name: &str, yocto: u128) -> R<Outcome> {
    h.call_outcome(by, &h.vault, "withdraw", args(name), NearToken::from_yoctonear(yocto), Gas::from_tgas(300)).await
}

/// The withdrawal landed and its callback ran, logging `payout {delivered, returned}`.
fn paid_out(h: &Harness, o: &Outcome, name: &str, delivered: u128, returned: u128) -> R<()> {
    let w = o.calls_exactly(&h.vault, "withdraw", 1)?[0];
    assert!(w.ok(), "{name}: {}", w.line());
    let cb = o.calls_exactly(&h.vault, "on_payout", 1)?[0];
    assert!(cb.ok(), "{name}: {}", cb.line());
    let d = data(&cb.logs[0]);
    assert_eq!((d["delivered"].clone(), d["returned"].clone()), (json!(delivered.to_string()), json!(returned.to_string())), "{name}: {}", cb.logs[0]);
    println!("{name}: {}\n{name}: {}", w.line(), cb.line());
    Ok(())
}

async fn settle(h: &Harness, by: &Account, nullifier_hash: &str, yocto: u128) -> R<Outcome> {
    h.call_outcome(by, &h.vault, "settle", json!({"nullifier_hash": nullifier_hash}), NearToken::from_yoctonear(yocto), Gas::from_tgas(100)).await
}

/// The settle is refused with `want`, logging nothing, and no state byte, no storage use, no NEAR of the payer
/// (relayer) and no token balance of the vault changed; the caller's attachment comes back as the runtime's refund.
async fn refused(h: &Harness, by: &Account, payer: &Account, nullifier_hash: &str, yocto: u128, want: &str) -> R<()> {
    let (state, used, held, payer_near) = (vault_state(h).await?, storage_usage(h).await?, h.token_balance(&h.vault).await?, h.near_balance(payer.id()).await?);
    let o = settle(h, by, nullifier_hash, yocto).await?;
    let r = o.calls_exactly(&h.vault, "settle", 1)?[0];
    let f = r.failure().ok_or_else(|| format!("settled, want {want}"))?;
    assert!(f.contains(want), "want {want}, got {f}");
    assert!(r.logs.is_empty(), "{want}: a refused settle logged {:?}", r.logs);
    assert_eq!(transferred(h, &o.tx_hash, by.id().as_str(), h.vault.as_str(), payer.id().as_str()).await?, 0, "{want}: NEAR went to the payer");
    h.wait_final(&h.vault).await?;
    assert_eq!(vault_state(h).await?, state, "{want}: a state byte changed");
    assert_eq!(storage_usage(h).await?, used, "{want}: the storage use changed");
    assert_eq!(h.token_balance(&h.vault).await?, held, "{want}: the vault's token balance changed");
    assert_eq!(h.near_balance(payer.id()).await?, payer_near, "{want}: the payer's NEAR changed");
    println!("refused ({want}): {}", r.line());
    Ok(())
}

/// A settle that wrote a refund note: its receipt logged exactly leaf_inserted state, leaf_inserted label and
/// refund_inserted, each naming the note `refunds[i]` of the fixture at the expected indexes.
fn wrote_note(h: &Harness, o: &Outcome, i: usize, state_index: u64, label_index: u64) -> R<&'static str> {
    let f = json_of(SPENDS);
    let note = &f["refunds"][i];
    let r = o.calls_exactly(&h.vault, "settle", 1)?[0];
    assert!(r.ok(), "{}", r.line());
    assert_eq!(events(r), ["leaf_inserted", "leaf_inserted", "refund_inserted"], "{:?}", r.logs);
    let (s, l, n) = (data(&r.logs[0]), data(&r.logs[1]), data(&r.logs[2]));
    assert_eq!((s["tree"].as_str(), s["index"].as_u64(), &s["leaf"]), (Some("state"), Some(state_index), &note["commitment"]), "{}", r.logs[0]);
    assert_eq!((l["tree"].as_str(), l["index"].as_u64(), &l["leaf"]), (Some("label"), Some(label_index), &note["label"]), "{}", r.logs[1]);
    let name = if i == 0 { "fee_bounces" } else { "recipient_bounces" };
    assert_eq!(
        n,
        json!({"nullifier_hash": nullifier(name), "commitment": note["commitment"], "label": note["label"], "value": note["value"]}),
        "{}",
        r.logs[2]
    );
    println!("settle {name}: {} (gas burnt {:.3} Tgas)", r.line(), r.gas_burnt as f64 / 1e12);
    Ok(name)
}

async fn vt_s08(kind: TokenKind) -> R<()> {
    let (h, relayer, alice) = deposited(kind).await?;
    let f = json_of(SPENDS);
    let newcomer = h.account("newcomer", 5).await?;
    let stranger = h.account("stranger", 50).await?;
    let _ = h.storage_deposit(&h.root, newcomer.id()).await?;

    // 1. a registered recipient with register_deposit > 0, the fee recipient not registered
    let need_fb = row14_need(relayer.id().as_str(), newcomer.id().as_str(), REGISTER, 2);
    let o = withdraw(&h, &relayer, "fee_bounces", need_fb).await?;
    paid_out(&h, &o, "fee_bounces", 0, 7_000_000)?;
    // the failed payout receipt's attachment (register_deposit and the two transfers' yocto) comes back as the runtime's refund
    assert_eq!(transferred(&h, &o.tx_hash, relayer.id().as_str(), "system", h.vault.as_str()).await?, REGISTER + 2, "the registration NEAR did not come back into the vault");
    assert_eq!((h.token_balance(newcomer.id()).await?, h.token_balance(relayer.id()).await?), (0, 0), "a payout that failed moved tokens");

    // 2. an unregistered recipient with register_deposit 0
    let _ = h.storage_deposit(&h.root, relayer.id()).await?;
    let need_rb = row14_need(relayer.id().as_str(), alice.id().as_str(), 0, 2);
    let o = withdraw(&h, &relayer, "recipient_bounces", need_rb + SURPLUS).await?;
    paid_out(&h, &o, "recipient_bounces", 0, 2_000_000)?;
    assert_eq!((h.token_balance(alice.id()).await?, h.token_balance(relayer.id()).await?), (0, 0), "the relayer kept a fee for a payout that failed");
    let reserve = REFUND_RESERVE_BYTES * YOCTO_PER_BYTE;
    for (name, refund, want) in [("fee_bounces", "7000000", reserve), ("recipient_bounces", "2000000", reserve + SURPLUS)] {
        let r = spend_row(&h, name).await?;
        assert_eq!((r["status"].as_str(), r["refund_value"].as_str(), r["reserve"].clone()), (Some("refund_pending"), Some(refund), json!(want.to_string())), "{r}");
    }
    let totals = h.view(&h.vault, "totals", json!({})).await?;
    assert_eq!(totals, json!({"deposited": "31000000", "spent": "9000000", "returned": "9000000"}));

    // 3. a stranger settles fee_bounces: the 9th state leaf grows the tree a level, so the reserve is short 74 B
    let st = h.view(&h.vault, "state_tree", json!({})).await?;
    assert_eq!((st["size"].as_u64(), st["depth"].as_u64()), (Some(8), Some(3)), "{st}");
    let short = LEVEL_BYTES * YOCTO_PER_BYTE;
    let n_fb = nullifier("fee_bounces");
    refused(&h, &stranger, &relayer, &n_fb, short - 1, "InsufficientStorageDeposit").await?;
    let (used, payer0) = (storage_usage(&h).await?, h.near_balance(relayer.id()).await?);
    let o = settle(&h, &stranger, &n_fb, short + EXTRA).await?;
    let _ = wrote_note(&h, &o, 0, 8, 6)?;
    o.expect_all_ok("settle fee_bounces")?;
    assert_eq!(storage_usage(&h).await? - used, REFUND_RESERVE_BYTES + LEVEL_BYTES, "settle's bytes when the state tree grows a level");
    assert_eq!(transferred(&h, &o.tx_hash, stranger.id().as_str(), h.vault.as_str(), stranger.id().as_str()).await?, EXTRA, "the unused attachment");
    assert_eq!(h.near_balance(relayer.id()).await?, payer0, "the reserve was all used: nothing to the payer");
    let r = spend_row(&h, "fee_bounces").await?;
    assert_eq!(
        (r["status"].as_str(), r["reserve"].as_str(), r["refund_value"].as_str(), &r["refund_label"], r["refund_leaf_index"].as_u64()),
        (Some("settled"), Some("0"), Some("7000000"), &f["refunds"][0]["label"], Some(8)),
        "{r}"
    );
    assert_eq!(h.view(&h.vault, "totals", json!({})).await?, totals, "settle moved totals (row 9)");
    // a second settle, with or without NEAR, is refused
    refused(&h, &stranger, &relayer, &n_fb, 0, "AlreadySettled").await?;
    refused(&h, &stranger, &relayer, &n_fb, short + EXTRA, "AlreadySettled").await?;

    // recipient_bounces: 389 B from a reserve with SURPLUS over them; the payer gets exactly SURPLUS
    let payer0 = h.near_balance(relayer.id()).await?;
    let used = storage_usage(&h).await?;
    let o = settle(&h, &stranger, &nullifier("recipient_bounces"), 0).await?;
    let _ = wrote_note(&h, &o, 1, 9, 7)?;
    o.expect_all_ok("settle recipient_bounces")?;
    assert_eq!(storage_usage(&h).await? - used, REFUND_RESERVE_BYTES, "settle's bytes when no tree grows");
    assert_eq!(h.near_balance(relayer.id()).await? - payer0, SURPLUS, "the reserve's rest to the payer");
    assert_eq!(h.view(&h.vault, "totals", json!({})).await?, totals, "settle moved totals (row 9)");
    assert_eq!(h.view(&h.vault, "leaves", json!({"from": 0, "limit": 20})).await?, f["leaves"], "the state tree is not the fixture's");
    assert_eq!(h.view(&h.vault, "labels", json!({"from": 0, "limit": 20})).await?, f["labels"], "the label tree is not the fixture's");
    assert_eq!(h.token_balance(&h.vault).await?, 31_000_000, "settle moved tokens");

    // 4. the device spends fee_bounces' refund note, relayed with no fee
    let _ = h.storage_deposit(&h.root, alice.id()).await?;
    let need_rn = row14_need(relayer.id().as_str(), alice.id().as_str(), 0, 1);
    let o = withdraw(&h, &relayer, "refund_note", need_rn).await?;
    paid_out(&h, &o, "refund_note", 7_000_000, 0)?;
    assert_eq!(h.token_balance(alice.id()).await?, 7_000_000, "the refund note did not pay");
    let t = h.view(&h.vault, "totals", json!({})).await?;
    assert_eq!(t, json!({"deposited": "31000000", "spent": "16000000", "returned": "9000000"}), "{t}");
    // its spend was paid: settle sends the whole reserve to the payer and writes no note
    let payer0 = h.near_balance(relayer.id()).await?;
    let used = storage_usage(&h).await?;
    let o = settle(&h, &stranger, &nullifier("refund_note"), 0).await?;
    o.expect_all_ok("settle refund_note")?;
    let r = o.calls_exactly(&h.vault, "settle", 1)?[0];
    assert!(r.logs.is_empty(), "a paid settle logged {:?}", r.logs);
    println!("settle refund_note (paid): {} (gas burnt {:.3} Tgas)", r.line(), r.gas_burnt as f64 / 1e12);
    assert_eq!(h.near_balance(relayer.id()).await? - payer0, reserve, "the whole reserve to the payer");
    assert_eq!(storage_usage(&h).await?, used, "a paid settle wrote bytes");
    assert_eq!(spend_row(&h, "refund_note").await?["status"], "settled");

    // 5. an unknown nullifier
    refused(&h, &stranger, &relayer, "12345", 0, "UnknownSpend").await?;
    println!("{kind:?}: VT-S08 holds\n{}", h.gas_table());
    h.i1().await?;
    Ok(())
}

#[tokio::test]
async fn vt_s08_mock() -> R<()> {
    vt_s08(TokenKind::Mock).await
}

#[tokio::test]
async fn vt_s08_usdc() -> R<()> {
    vt_s08(TokenKind::Usdc).await
}
