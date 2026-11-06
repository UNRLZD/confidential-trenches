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
//! And card vault-refund-precommit-reserve's pin, `vt_s09_twins` (from the same six deposits): the vault holds a
//! precommitment twice by design (deposit.rs:109-110 refuses a repeated P among deposits only; ragequit and settle
//! write no precommitments), and no twin can be ragequit by anyone:
//! a. rows 2 and 3 only: a stranger deposits on u's refund precommitment R (here before any spend names it; VT-S07
//!    in withdraw_spend.rs holds the pending-spend case): it lands. u's ragequit of that note fails row 2 on the
//!    stranger's label (`OnlyOriginalDepositor`); the stranger's fails row 3 (`InvalidProof`: the proof needs R's
//!    nullifier and secret, which only u holds).
//! b. q ragequits note 6 naming u's pending deposit precommitment P, and its payout bounces: the settle adds a gift
//!    leaf on P; u's deposit on P still lands, both leaves hash from P, and the gift's ragequit is refused for u
//!    and q (its label names no deposit).
//! A vault that refused a deposit on a precommitment a spend names, let a ragequit pass on a label its caller did not
//! deposit, or wrote precommitments in ragequit or settle fails here.
//!
//! Prints every receipt of the landed ragequits with its gas, and the gas table.
#![cfg(feature = "sandbox")]

mod harness;

use harness::{commitment_on, Harness, Outcome, Receipt, TokenKind, R, YOCTO_PER_BYTE};
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
    h.i1().await?;
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

/// `by` prepays `p` and deposits `value` on it, naming itself as depositor; the deposit lands. Returns its deposits
/// row.
async fn deposit_on(h: &Harness, by: &Account, p: &str, value: u128) -> R<Value> {
    let prepay = NearToken::from_yoctonear(PREPAY_BYTES * YOCTO_PER_BYTE);
    let _ = h.call(by, &h.vault, "storage_prepay", json!({"precommitment": p}), prepay, Gas::from_tgas(30)).await?;
    h.mint(by.id(), value).await?;
    let msg = format!(r#"{{"precommitment":"{p}","depositor":"{}"}}"#, by.id());
    let o = h
        .call_outcome(by, &h.token, "ft_transfer_call", json!({"receiver_id": h.vault, "amount": value.to_string(), "msg": msg}), NearToken::from_yoctonear(1), Gas::from_tgas(180))
        .await?;
    let r = o.calls_exactly(&h.vault, "ft_on_transfer", 1)?[0];
    assert!(r.ok(), "the deposit on {p} by {}: {}", by.id(), r.line());
    let rows = h.view(&h.vault, "deposits", json!({"from": 0, "limit": 100})).await?;
    Ok(rows.as_array().ok_or("deposits: not a list")?.iter().rev().find(|d| d["precommitment"] == p).ok_or("no deposits row on p")?.clone())
}

async fn leaf_at(h: &Harness, i: u64) -> R<String> {
    Ok(h.view(&h.vault, "leaves", json!({"from": i, "limit": 1})).await?[0].as_str().ok_or("no leaf")?.to_string())
}

/// `name`'s ragequit arguments with the signals of another note: commitment, value and label.
fn rq_as(name: &str, commitment: &str, value: &str, label: &str) -> Value {
    let mut a = rq_args(name);
    a["public_signals"][0] = json!(commitment);
    a["public_signals"][2] = json!(value);
    a["public_signals"][3] = json!(label);
    a
}

async fn vt_s09_twins(kind: TokenKind) -> R<()> {
    let w = deposited(kind).await?;
    let h = &w.h;

    // a. rows 2 and 3: the stranger's deposit on u's refund precommitment R (no spend names R yet; VT-S07 holds the
    // pending-spend case) lands, and nobody can ragequit it
    let r_u = rq_args("deposit")["refund_precommitment"].as_str().ok_or("refund_precommitment")?.to_string();
    let theirs = deposit_on(h, &w.stranger, &r_u, 1_000_000).await?;
    let (label_s, at_s) = (theirs["label"].as_str().ok_or("label")?.to_string(), theirs["leaf_index"].as_u64().ok_or("leaf_index")?);
    let twin = commitment_on("1000000", &label_s, &r_u);
    assert_eq!(leaf_at(h, at_s).await?, twin, "the stranger's note does not hash from R");
    println!("a: the stranger's deposit on u's refund precommitment landed at leaf {at_s}");
    refused(h, &w.u, rq_as("deposit", &twin, "1000000", &label_s), "OnlyOriginalDepositor").await?;
    refused(h, &w.stranger, rq_as("deposit", &twin, "1000000", &label_s), "InvalidProof").await?;

    // b. q's ragequit names u's pending deposit precommitment P; it bounces and settles into a gift leaf on P
    let p = "123456789";
    let prepay = NearToken::from_yoctonear(PREPAY_BYTES * YOCTO_PER_BYTE);
    let _ = h.call(&w.u, &h.vault, "storage_prepay", json!({"precommitment": p}), prepay, Gas::from_tgas(30)).await?;
    let mut a = rq_args("unregistered");
    a["refund_precommitment"] = json!(p);
    let o = ragequit(h, &w.q, a, ONE_NEAR).await?;
    landed(h, &o, "unregistered", &w.q, false)?;
    let n = rq_nullifier("unregistered");
    let o = h.call_outcome(&w.stranger, &h.vault, "settle", json!({"nullifier_hash": n}), NearToken::from_yoctonear(0), Gas::from_tgas(100)).await?;
    o.expect_all_ok("settle q's ragequit")?;
    let r = spend_row(h, &n).await?;
    assert_eq!((r["status"].as_str(), r["refund_precommitment"].as_str(), r["refund_value"].as_str()), (Some("settled"), Some(p), Some("4000000")), "{r}");
    let (gift_label, gift_at) = (r["refund_label"].as_str().ok_or("refund_label")?.to_string(), r["refund_leaf_index"].as_u64().ok_or("refund_leaf_index")?);
    let gift = commitment_on("4000000", &gift_label, p);
    assert_eq!(leaf_at(h, gift_at).await?, gift, "the gift leaf does not hash from P");
    // u's deposit on P still lands, at its own leaf
    let ours = deposit_on(h, &w.u, p, 1_000_000).await?;
    let at_u = ours["leaf_index"].as_u64().ok_or("leaf_index")?;
    assert_ne!(at_u, gift_at);
    assert_eq!(leaf_at(h, at_u).await?, commitment_on("1000000", ours["label"].as_str().ok_or("label")?, p), "u's leaf does not hash from P");
    println!("b: q's ragequit on P settled into a gift leaf {gift_at}; u's deposit on P landed at leaf {at_u}");
    for by in [&w.u, &w.q] {
        refused(h, by, rq_as("unregistered", &gift, "4000000", &gift_label), "OnlyOriginalDepositor").await?;
    }
    println!("{kind:?}: no twin can be ragequit by anyone");
    h.i1().await?;
    Ok(())
}

#[tokio::test]
async fn vt_s09_twins_mock() -> R<()> {
    vt_s09_twins(TokenKind::Mock).await
}

#[tokio::test]
async fn vt_s09_twins_usdc() -> R<()> {
    vt_s09_twins(TokenKind::Usdc).await
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
