// SPDX-License-Identifier: Apache-2.0
//! VT-S09 (vault.md 5, V:1143): `ragequit` (2.5.3) in near-sandbox 2.13.4, on the mock token and on the real USDC wasm
//! at TOKEN; and the unknown-argument refusal of `ragequit` and `settle`. Runs only with `--features sandbox`, through
//! tests/harness/run.sh (`contracts/vault/tests/harness/run.sh --test ragequit`); a plain `cargo test` builds this
//! file empty.
//!
//! From tests/fixtures/ragequit-spends.json: the six deposits of withdraw-spends.json made through `ft_on_transfer`,
//! notes 1-5 naming u as depositor and note 6 naming q, then:
//! 1. two withdrawals to alice make a change note of 4,000,000 (of note 2) and one of 0 (of note 1);
//! 2. a stranger's ragequit of note 3 is refused (`OnlyOriginalDepositor`) with nothing changed; u's lands and pays u
//!    exactly 10,000,000, its spends row reads recipient u, fee 0, context 0, `paid`; again is refused
//!    (`NullifierAlreadySpent`);
//! 3. u ragequits the 4,000,000 change note; the 0 change note is refused (`InvalidWithdrawalAmount`) with nothing
//!    spent;
//! 4. q, not registered on the token, ragequits note 6 with `register_deposit` 0: the payout bounces and the spend is
//!    `refund_pending` 4,000,000; a stranger settles it into a refund note; the refund note's ragequit is refused for q
//!    and u (`OnlyOriginalDepositor`: its label names no deposit); the private withdraw spends it to alice;
//! 5. a note on a deposit's label that was never inserted is refused (`InvalidCommitment`).
//!
//! Prints every receipt of the landed ragequits with its gas, and the gas table.
#![cfg(feature = "sandbox")]

mod harness;

use harness::{Harness, Outcome, Receipt, TokenKind, R, YOCTO_PER_BYTE};
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;

const FIXTURE: &str = include_str!("fixtures/ragequit-spends.json");
const PREPAY_BYTES: u128 = 904;
/// 2.3: a ragequit's bytes (spent 81 + spends 394) with a 64-byte depositor.
const RAGEQUIT_BYTES: u128 = 475;
const REFUND_RESERVE_BYTES: u128 = blindfill_vault::constants::REFUND_RESERVE_BYTES as u128;
const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).unwrap()
}

fn find(list: &str, name: &str) -> Value {
    fixture()[list].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap().clone()
}

fn rq_args(name: &str) -> Value {
    let r = find("ragequits", name);
    json!({"proof": r["proof"], "public_signals": r["public_signals"], "register_deposit": r["register_deposit"], "refund_precommitment": r["refund_precommitment"]})
}

fn rq_nullifier(name: &str) -> String {
    find("ragequits", name)["public_signals"][1].as_str().unwrap().to_string()
}

/// Exactly 2.5.3 row 6's requirement (2.5.2 row 14) for a depositor id of this length: bytes, reserve, 1 yocto.
fn need(depositor: &str) -> u128 {
    (RAGEQUIT_BYTES - 2 * (64 - depositor.len() as u128) + REFUND_RESERVE_BYTES) * YOCTO_PER_BYTE + 1
}

struct World {
    h: Harness,
    u: Account,
    q: Account,
    alice: Account,
    relayer: Account,
    stranger: Account,
}

/// The vault holding the six deposits through `ft_on_transfer`, each naming the fixture's depositor; alice registered.
async fn deposited(kind: TokenKind) -> R<World> {
    let h = Harness::with_vault_and(kind).await?;
    let f = fixture();
    let (u, q) = (h.account("u", 50).await?, h.account("q", 50).await?);
    let (alice, relayer, stranger) = (h.account("alice", 50).await?, h.account("relayer", 50).await?, h.account("stranger", 50).await?);
    let total: u128 = f["deposited"].as_str().unwrap().parse()?;
    h.mint(u.id(), total).await?;
    let prepay = NearToken::from_yoctonear(PREPAY_BYTES * YOCTO_PER_BYTE);
    for d in f["deposits"].as_array().unwrap() {
        let p = d["precommitment"].as_str().unwrap();
        let _ = h.call(&relayer, &h.vault, "storage_prepay", json!({"precommitment": p}), prepay, Gas::from_tgas(30)).await?;
        let msg = format!(r#"{{"precommitment":"{p}","depositor":"{}"}}"#, d["depositor"].as_str().unwrap());
        let o = h
            .call(&u, &h.token, "ft_transfer_call", json!({"receiver_id": h.vault, "amount": d["value"], "msg": msg}), NearToken::from_yoctonear(1), Gas::from_tgas(180))
            .await?;
        let _ = o.calls_exactly(&h.vault, "ft_on_transfer", 1)?;
    }
    let commitments: Vec<Value> = f["deposits"].as_array().unwrap().iter().map(|d| d["commitment"].clone()).collect();
    assert_eq!(h.view(&h.vault, "leaves", json!({"from": 0, "limit": 10})).await?, json!(commitments), "the deposits' leaves are the fixture's");
    let rows = h.view(&h.vault, "deposits", json!({"from": 0, "limit": 10})).await?;
    for (r, d) in rows.as_array().unwrap().iter().zip(f["deposits"].as_array().unwrap()) {
        assert_eq!(r["depositor"], d["depositor"], "{r}");
    }
    assert!(h.view(&h.token, "storage_balance_of", json!({"account_id": q.id()})).await?.is_null(), "q is registered");
    let _ = h.storage_deposit(&h.root, alice.id()).await?;
    Ok(World { h, u, q, alice, relayer, stranger })
}

async fn spend_rows(h: &Harness) -> R<Vec<Value>> {
    Ok(h.view(&h.vault, "spends", json!({"from": 0, "limit": 100})).await?.as_array().ok_or("spends: not a list")?.clone())
}

async fn spend_row(h: &Harness, nullifier_hash: &str) -> R<Value> {
    Ok(spend_rows(h).await?.into_iter().find(|r| r["nullifier_hash"] == nullifier_hash).ok_or("no such spend")?)
}

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

fn events(r: &Receipt) -> Vec<String> {
    r.logs.iter().map(|l| l.split(r#""event":""#).nth(1).and_then(|e| e.split('"').next()).unwrap_or("").to_string()).collect()
}

fn data(line: &str) -> Value {
    let v: Value = serde_json::from_str(line.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    v["data"][0].clone()
}

async fn ragequit(h: &Harness, by: &Account, a: Value, yocto: u128) -> R<Outcome> {
    h.call_outcome(by, &h.vault, "ragequit", a, NearToken::from_yoctonear(yocto), Gas::from_tgas(300)).await
}

/// Refused with `want` in the ragequit receipt, which logged nothing; no payout, and no state byte, storage use or
/// token balance of the vault changed.
async fn refused(h: &Harness, by: &Account, a: Value, want: &str) -> R<()> {
    refused_call(h, by, "ragequit", a, want).await
}

/// `refused`, for a call of `method` (ragequit or withdraw) with 1 NEAR and 300 Tgas.
async fn refused_call(h: &Harness, by: &Account, method: &str, a: Value, want: &str) -> R<()> {
    let (state, held) = (vault_state(h).await?, h.token_balance(&h.vault).await?);
    let used = h.account_view(&h.vault, "final").await?["storage_usage"].clone();
    let o = h.call_outcome(by, &h.vault, method, a, NearToken::from_yoctonear(ONE_NEAR), Gas::from_tgas(300)).await?;
    let r = o.calls_exactly(&h.vault, method, 1)?[0];
    let f = r.failure().ok_or_else(|| format!("landed, want {want}"))?;
    assert!(f.contains(want), "want {want}, got {f}");
    assert!(r.logs.is_empty(), "{want}: logged {:?}", r.logs);
    assert!(o.calls_exactly(&h.vault, "on_payout", 0).is_ok() && !o.receipts.iter().any(|x| x.methods.contains(&"ft_transfer".to_string())), "{want}: a payout");
    h.wait_final(&h.vault).await?;
    assert_eq!(vault_state(h).await?, state, "{want}: a state byte changed");
    assert_eq!(h.account_view(&h.vault, "final").await?["storage_usage"], used, "{want}: the storage use changed");
    assert_eq!(h.token_balance(&h.vault).await?, held, "{want}: the vault's token balance changed");
    println!("refused ({want}) for {}: {}", by.id(), r.line());
    Ok(())
}

/// The ragequit landed: its receipt logged exactly `ragequit {by, commitment, label, value}`, its payout part ran as
/// `delivered` says and on_payout logged `payout`. Prints every receipt with its gas.
fn landed(h: &Harness, o: &Outcome, name: &str, by: &Account, delivered: bool) -> R<()> {
    let sig = find("ragequits", name)["public_signals"].clone();
    let r = o.calls_exactly(&h.vault, "ragequit", 1)?[0];
    assert!(r.ok(), "{name}: {}", r.line());
    assert_eq!(events(r), ["ragequit"], "{name}: {:?}", r.logs);
    assert_eq!(data(&r.logs[0]), json!({"ragequitter": by.id(), "commitment": sig[0], "label": sig[3], "value": sig[2]}), "{name}");
    let part = o.receipts.iter().find(|x| x.methods.last().map(String::as_str) == Some("ft_transfer")).ok_or("no payout part")?;
    assert_eq!(part.ok(), delivered, "{name}: {}", part.line());
    let cb = o.calls_exactly(&h.vault, "on_payout", 1)?[0];
    assert!(cb.ok(), "{name}: {}", cb.line());
    let (d, back) = if delivered { (sig[2].clone(), json!("0")) } else { (json!("0"), sig[2].clone()) };
    let p = data(&cb.logs[0]);
    assert_eq!((p["delivered"].clone(), p["returned"].clone()), (d, back), "{name}: {}", cb.logs[0]);
    for x in &o.receipts {
        println!("{name}: {} (gas burnt {:.3} Tgas)", x.line(), x.gas_burnt as f64 / 1e12);
    }
    Ok(())
}

async fn vt_s09(kind: TokenKind) -> R<()> {
    let w = deposited(kind).await?;
    let (h, f) = (&w.h, fixture());

    // 1. the change notes: 4,000,000 of note 2 and 0 of note 1
    for name in ["change_w", "zero_w"] {
        let s = find("withdrawals", name);
        let a = json!({"withdrawal": s["withdrawal"], "proof": s["proof"], "public_signals": s["public_signals"]});
        let o = h.call_outcome(&w.relayer, &h.vault, "withdraw", a, NearToken::from_yoctonear(ONE_NEAR), Gas::from_tgas(300)).await?;
        o.expect_all_ok(name)?;
    }
    let mut want_leaves: Vec<Value> = f["deposits"].as_array().unwrap().iter().map(|d| d["commitment"].clone()).collect();
    want_leaves.extend(f["changes"].as_array().unwrap().iter().cloned());
    assert_eq!(h.view(&h.vault, "leaves", json!({"from": 0, "limit": 20})).await?, json!(want_leaves));
    assert_eq!(h.token_balance(w.alice.id()).await?, 3_000_000);

    // note 2, which change_w spent through withdraw: its commitment proof by its depositor
    assert_eq!(rq_nullifier("withdrawn"), find("withdrawals", "change_w")["public_signals"][1], "withdrawn names change_w's nullifier");
    refused(h, &w.u, rq_args("withdrawn"), "NullifierAlreadySpent").await?;

    // 2. note 3 (10,000,000): a stranger, the depositor (exactly row 6's requirement), the depositor again
    refused(h, &w.stranger, rq_args("deposit"), "OnlyOriginalDepositor").await?;
    refused(h, &w.q, rq_args("deposit"), "OnlyOriginalDepositor").await?;
    let before = h.token_balance(w.u.id()).await?;
    let o = ragequit(h, &w.u, rq_args("deposit"), need(w.u.id().as_str())).await?;
    landed(h, &o, "deposit", &w.u, true)?;
    assert_eq!(h.token_balance(w.u.id()).await? - before, 10_000_000, "the depositor was not paid the note");
    let r = spend_row(h, &rq_nullifier("deposit")).await?;
    assert_eq!(
        (r["status"].as_str(), r["context"].as_str(), r["recipient"].as_str(), r["payer"].as_str(), r["fee"].as_str(), r["withdrawn"].as_str()),
        (Some("paid"), Some("0"), Some(w.u.id().as_str()), Some(w.u.id().as_str()), Some("0"), Some("10000000")),
        "{r}"
    );
    assert_eq!(r["reserve"], json!((REFUND_RESERVE_BYTES * YOCTO_PER_BYTE).to_string()));
    assert_eq!(r["refund_precommitment"], find("ragequits", "deposit")["refund_precommitment"]);
    refused(h, &w.u, rq_args("deposit"), "NullifierAlreadySpent").await?;
    // a valid withdraw proof of note 3 on known roots, after the ragequit spent it
    let s = find("withdrawals", "after_rq");
    assert_eq!(s["public_signals"][1].as_str(), Some(rq_nullifier("deposit").as_str()), "after_rq names the ragequit's nullifier");
    let a = json!({"withdrawal": s["withdrawal"], "proof": s["proof"], "public_signals": s["public_signals"]});
    refused_call(h, &w.relayer, "withdraw", a, "NullifierAlreadySpent").await?;

    // 3. the change notes
    let o = ragequit(h, &w.u, rq_args("change"), ONE_NEAR).await?;
    landed(h, &o, "change", &w.u, true)?;
    assert_eq!(h.token_balance(w.u.id()).await? - before, 14_000_000);
    let spends = spend_rows(h).await?.len();
    refused(h, &w.u, rq_args("zero"), "InvalidWithdrawalAmount: value is 0").await?;
    assert_eq!(spend_rows(h).await?.len(), spends, "a 0 ragequit spent");

    // 4. an unregistered depositor: the payout bounces into a refund note
    let o = ragequit(h, &w.q, rq_args("unregistered"), ONE_NEAR).await?;
    landed(h, &o, "unregistered", &w.q, false)?;
    let n = rq_nullifier("unregistered");
    let r = spend_row(h, &n).await?;
    assert_eq!((r["status"].as_str(), r["refund_value"].as_str(), r["context"].as_str()), (Some("refund_pending"), Some("4000000"), Some("0")), "{r}");
    assert_eq!(h.token_balance(w.q.id()).await?, 0);
    let o = h.call_outcome(&w.stranger, &h.vault, "settle", json!({"nullifier_hash": n}), NearToken::from_yoctonear(0), Gas::from_tgas(100)).await?;
    o.expect_all_ok("settle the unregistered ragequit")?;
    let r = spend_row(h, &n).await?;
    assert_eq!((r["status"].as_str(), &r["refund_label"], r["refund_leaf_index"].as_u64()), (Some("settled"), &f["refund"]["label"], Some(8)), "{r}");
    assert_eq!(h.view(&h.vault, "leaves", json!({"from": 0, "limit": 20})).await?, f["leaves"]);
    assert_eq!(h.view(&h.vault, "labels", json!({"from": 0, "limit": 20})).await?, f["labels"]);
    for by in [&w.q, &w.u] {
        refused(h, by, rq_args("refund_note"), "OnlyOriginalDepositor").await?;
    }
    let s = find("withdrawals", "refund_w");
    let a = json!({"withdrawal": s["withdrawal"], "proof": s["proof"], "public_signals": s["public_signals"]});
    let o = h.call_outcome(&w.relayer, &h.vault, "withdraw", a, NearToken::from_yoctonear(ONE_NEAR), Gas::from_tgas(300)).await?;
    o.expect_all_ok("the private withdraw of the refund note")?;
    assert_eq!(h.token_balance(w.alice.id()).await?, 7_000_000, "the refund note did not withdraw");

    // 5. a note that was never inserted
    refused(h, &w.u, rq_args("unlanded"), "InvalidCommitment").await?;

    let t = h.view(&h.vault, "totals", json!({})).await?;
    assert_eq!(t, json!({"deposited": "31000000", "spent": "25000000", "returned": "4000000"}), "{t}");
    assert_eq!(h.token_balance(&h.vault).await?, 31_000_000 - 3_000_000 - 14_000_000 - 4_000_000);
    println!("{kind:?}: VT-S09 holds\n{}", h.gas_table());
    Ok(())
}

#[tokio::test]
async fn vt_s09_mock() -> R<()> {
    vt_s09(TokenKind::Mock).await
}

#[tokio::test]
async fn vt_s09_usdc() -> R<()> {
    vt_s09(TokenKind::Usdc).await
}

/// `ragequit` and `settle` take exactly their arguments: one more top-level key is refused when near-sdk reads the
/// input (`#[deny_unknown_arguments]`), before any row runs; the same call without it reaches the rows.
#[tokio::test]
async fn an_extra_argument_is_refused_at_parse() -> R<()> {
    let h = Harness::with_vault_and_mock_token().await?;
    let u = h.account("u", 50).await?;
    let before = vault_state(&h).await?;
    let rq = rq_args("deposit");
    let st = json!({"nullifier_hash": rq_nullifier("deposit")});
    for (method, plain, row) in [("ragequit", rq.clone(), "OnlyOriginalDepositor"), ("settle", st.clone(), "UnknownSpend")] {
        let mut extra = plain.clone();
        extra["extra"] = json!(1);
        for (args, want) in [(extra, "Failed to deserialize input from JSON"), (plain, row)] {
            let o = h.call_outcome(&u, &h.vault, method, args, NearToken::from_yoctonear(ONE_NEAR), Gas::from_tgas(300)).await?;
            let r = o.calls_exactly(&h.vault, method, 1)?[0];
            let f = r.failure().ok_or_else(|| format!("{method} landed"))?;
            assert!(f.contains(want), "{method}: want {want}, got {f}");
            println!("{method}: refused ({want}), {:.3} Tgas", r.gas_burnt as f64 / 1e12);
        }
    }
    h.wait_final(&h.vault).await?;
    assert_eq!(vault_state(&h).await?, before, "a state byte changed");
    Ok(())
}
