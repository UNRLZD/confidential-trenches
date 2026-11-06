// SPDX-License-Identifier: Apache-2.0
//! VT-S19 (vault.md 5, V:1158; wallet V4): the spend view, in near-sandbox 2.13.4 on the mock token and on the real
//! USDC wasm at TOKEN. Runs only with `--features sandbox`, through tests/harness/run.sh
//! (`contracts/vault/tests/harness/run.sh --test s19`); a plain `cargo test` builds this file empty.
//!
//! From the six deposits of tests/fixtures/withdraw-spends.json made through `ft_on_transfer` (notes 1-5 naming u as
//! depositor, note 6 naming q), and the proofs of tests/fixtures/s19-spends.json (make-s19-spends.mjs):
//! 1. Two arms of one note (note 2), as two devices or two attempts make them: arm_alice to alice (3,000,000, fee
//!    100,000, relayed by relayer) and arm_bob to bob (5,000,000, fee 200,000, relayed by relayer2), sent at once.
//!    Exactly one lands and pays its recipient and fee recipient; the other is refused with `NullifierAlreadySpent`,
//!    logs nothing and pays no one. The landed row matches exactly one of the device's two requests on every field
//!    the request fixes (nullifier hash, recipient, withdrawn, fee, `context`, refund precommitment), its change leaf
//!    is that arm's commitment, and the other request's `context` is in no row.
//! 2. bounce: note 1 to carol, not registered on the token: the payout bounces whole (`refund_pending` 2,000,000).
//! 3. u ragequits note 3: its row's recipient and payer are u, its `context` 0 (restore reads a spend with `context`
//!    0 as a ragequit).
//! 4. other: note 4 to bob (the state tree grows a level); then a stranger settles bounce into its refund note (leaf
//!    9, label 6), and the payer gets the reserve's rest.
//! 5. `spends` read from 0 with `config().page_max` (= PAGE_MAX) and with a limit over it, and from the middle: every
//!    row's fourteen fields are exactly the ones the steps above fix, and walks of every page size from 0, 1 and 2
//!    return each row once, in order, with no skip and no repeat; a page past the end is empty.
//!
//! The plants, each of which must fail this test: `VT_S19_PLANT=over` reads every page one row past where the walk
//! asked (a view that pages one row over); `VT_S19_PLANT=repeat` steps each walk one row short (a page that repeats a
//! row); `VT_S19_PLANT=arm` sends `other` (a different note) as the second arm, so a second arm lands.
//!
//! Prints every landed call's receipts with their gas, and the gas table.
#![cfg(feature = "sandbox")]

mod harness;

use harness::{Harness, Outcome, Receipt, TokenKind, R, YOCTO_PER_BYTE};
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;

const FIXTURE: &str = include_str!("fixtures/s19-spends.json");
/// The kit's prepay whenever a tree may grow (2.10 (h)).
const PREPAY_BYTES: u128 = 904;
/// 2.3: a spend's bytes with a 64-byte payer and recipient, when the state tree grows no level.
const SPEND_BYTES: u128 = 710;
/// 2.3: a ragequit's bytes (spent 81 + spends 394) with a 64-byte depositor.
const RAGEQUIT_BYTES: u128 = 475;
/// What a tree that grows a level adds to an insert (2.3).
const LEVEL_BYTES: u128 = 74;
const REFUND_RESERVE_BYTES: u128 = blindfill_vault::constants::REFUND_RESERVE_BYTES as u128;
const PAGE_MAX: u64 = blindfill_vault::constants::PAGE_MAX;
/// What each call attaches above its requirement, distinct per row, so each row's `reserve` names its own call.
const SURPLUS: [u128; 4] = [1_000_000_000_001, 2_000_000_000_002, 3_000_000_000_003, 4_000_000_000_004];

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).unwrap()
}

fn plant(name: &str) -> bool {
    let on = std::env::var("VT_S19_PLANT").as_deref() == Ok(name);
    if on {
        println!("planted: {name}");
    }
    on
}

fn find(list: &str, name: &str) -> Value {
    fixture()[list].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap().clone()
}

fn withdraw_args(s: &Value) -> Value {
    json!({"withdrawal": s["withdrawal"], "proof": s["proof"], "public_signals": s["public_signals"]})
}

fn txt(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn u(v: &Value) -> u128 {
    txt(v).parse().unwrap()
}

/// 2.5.2 row 14's requirement for a withdraw of `sp` by `payer`: bytes (a tree that grows a level adds LEVEL_BYTES),
/// the reserve, `register_deposit` and a yocto per transfer (two when the fee is above 0).
fn withdraw_need(payer: &str, sp: &Value, grows: bool) -> u128 {
    let w = &sp["withdrawal"];
    let bytes = SPEND_BYTES - (64 - payer.len() as u128) - (64 - txt(&w["recipient"]).len() as u128) + if grows { LEVEL_BYTES } else { 0 };
    let transfers = if u(&w["relay_fee"]) > 0 { 2 } else { 1 };
    (bytes + REFUND_RESERVE_BYTES) * YOCTO_PER_BYTE + u(&w["register_deposit"]) + transfers
}

/// 2.5.3 row 6's requirement for a ragequit by `depositor`: bytes, reserve, 1 yocto.
fn ragequit_need(depositor: &str) -> u128 {
    (RAGEQUIT_BYTES - 2 * (64 - depositor.len() as u128) + REFUND_RESERVE_BYTES) * YOCTO_PER_BYTE + 1
}

fn reserve(i: usize) -> String {
    (REFUND_RESERVE_BYTES * YOCTO_PER_BYTE + SURPLUS[i]).to_string()
}

fn events(r: &Receipt) -> Vec<String> {
    r.logs.iter().map(|l| l.split(r#""event":""#).nth(1).and_then(|e| e.split('"').next()).unwrap_or("").to_string()).collect()
}

fn data(line: &str) -> Value {
    let v: Value = serde_json::from_str(line.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    v["data"][0].clone()
}

struct World {
    h: Harness,
    u: Account,
    relayer: Account,
    relayer2: Account,
    alice: Account,
    bob: Account,
    carol: Account,
    stranger: Account,
}

/// The vault holding the six deposits through `ft_on_transfer`, each naming the fixture's depositor; the relayers,
/// alice and bob registered on the token, carol not.
async fn deposited(kind: TokenKind) -> R<World> {
    let h = Harness::with_vault_and(kind).await?;
    let f = fixture();
    let (u, q) = (h.account("u", 50).await?, h.account("q", 50).await?);
    let (relayer, relayer2) = (h.account("relayer", 50).await?, h.account("relayer2", 50).await?);
    let (alice, bob, carol) = (h.account("alice", 50).await?, h.account("bob", 50).await?, h.account("carol", 50).await?);
    let stranger = h.account("stranger", 50).await?;
    let ids = [u.id().as_str(), q.id().as_str(), relayer.id().as_str(), relayer2.id().as_str(), alice.id().as_str(), bob.id().as_str(), carol.id().as_str()];
    assert_eq!(ids, ["u.test.near", "q.test.near", "relayer.test.near", "relayer2.test.near", "alice.test.near", "bob.test.near", "carol.test.near"], "the fixture's accounts");
    let total: u128 = txt(&f["deposited"]).parse()?;
    h.mint(u.id(), total).await?;
    let prepay = NearToken::from_yoctonear(PREPAY_BYTES * YOCTO_PER_BYTE);
    for d in f["deposits"].as_array().unwrap() {
        let p = txt(&d["precommitment"]);
        let _ = h.call(&relayer, &h.vault, "storage_prepay", json!({"precommitment": p}), prepay, Gas::from_tgas(30)).await?;
        let msg = format!(r#"{{"precommitment":"{p}","depositor":"{}"}}"#, txt(&d["depositor"]));
        let o = h
            .call(&u, &h.token, "ft_transfer_call", json!({"receiver_id": h.vault, "amount": d["value"], "msg": msg}), NearToken::from_yoctonear(1), Gas::from_tgas(180))
            .await?;
        let _ = o.calls_exactly(&h.vault, "ft_on_transfer", 1)?;
    }
    let commitments: Vec<Value> = f["deposits"].as_array().unwrap().iter().map(|d| d["commitment"].clone()).collect();
    assert_eq!(h.view(&h.vault, "leaves", json!({"from": 0, "limit": 10})).await?, json!(commitments), "the deposits' leaves are the fixture's");
    for a in [&relayer, &relayer2, &alice, &bob] {
        let _ = h.storage_deposit(&h.root, a.id()).await?;
    }
    assert!(h.view(&h.token, "storage_balance_of", json!({"account_id": carol.id()})).await?.is_null(), "carol is registered");
    assert_eq!(h.token_balance(&h.vault).await?, total);
    Ok(World { h, u, relayer, relayer2, alice, bob, carol, stranger })
}

async fn spends(h: &Harness, from: u64, limit: u64) -> R<Vec<Value>> {
    Ok(h.view(&h.vault, "spends", json!({"from": from, "limit": limit})).await?.as_array().ok_or("spends: not a list")?.clone())
}

/// The withdraw landed and its callback ran, logging `payout {delivered, returned}`. Prints every receipt's gas.
fn paid_out(h: &Harness, o: &Outcome, name: &str, delivered: u128, returned: u128) -> R<()> {
    let w = o.calls_exactly(&h.vault, "withdraw", 1)?[0];
    assert!(w.ok(), "{name}: {}", w.line());
    assert_eq!(events(w), ["leaf_inserted", "withdrawn", "withdrawal_relayed"], "{name}: {:?}", w.logs);
    let cb = o.calls_exactly(&h.vault, "on_payout", 1)?[0];
    assert!(cb.ok(), "{name}: {}", cb.line());
    let d = data(&cb.logs[0]);
    assert_eq!((d["delivered"].clone(), d["returned"].clone()), (json!(delivered.to_string()), json!(returned.to_string())), "{name}: {}", cb.logs[0]);
    for x in &o.receipts {
        println!("{name}: {} (gas burnt {:.3} Tgas)", x.line(), x.gas_burnt as f64 / 1e12);
    }
    Ok(())
}

/// The device's match (wallet V4): the requests whose every field the row records is the row's. A device that made
/// both arms finds its landed attempt this way, by the `context` it recorded for each.
fn matches(row: &Value, requests: &[Value]) -> Vec<usize> {
    (0..requests.len())
        .filter(|&i| {
            let (r, w) = (&requests[i], &requests[i]["withdrawal"]);
            row["nullifier_hash"] == r["public_signals"][1]
                && row["context"] == r["public_signals"][7]
                && row["withdrawn"] == r["public_signals"][2]
                && row["recipient"] == w["recipient"]
                && row["fee"] == w["relay_fee"]
                && row["refund_precommitment"] == w["refund_precommitment"]
        })
        .collect()
}

/// A walk of `spends` from `from`, `size` rows a page, until a page comes back empty (at most len + 2 pages).
async fn walk(h: &Harness, from: u64, size: u64, len: usize) -> R<Vec<Value>> {
    let (mut at, mut out) = (from, vec![]);
    for _ in 0..len + 2 {
        let read = if plant("over") { at + 1 } else { at };
        let page = spends(h, read, size).await?;
        if page.is_empty() {
            return Ok(out);
        }
        assert!(page.len() as u64 <= size, "a page of {} rows for a limit of {size}", page.len());
        let step = if plant("repeat") { (page.len() as u64 - 1).max(1) } else { page.len() as u64 };
        out.extend(page);
        at += step;
    }
    Err(format!("the walk from {from} by {size} did not end in {} pages", len + 2).into())
}

async fn vt_s19(kind: TokenKind) -> R<()> {
    let w = deposited(kind).await?;
    let (h, f) = (&w.h, fixture());
    let arms: Vec<Value> = f["arms"].as_array().unwrap().clone();
    let (bounce, other, rq) = (find("withdrawals", "bounce"), find("withdrawals", "other"), f["ragequit"].clone());
    assert_eq!(arms[0]["public_signals"][1], arms[1]["public_signals"][1], "the two arms spend one note");
    assert_ne!(arms[0]["public_signals"][7], arms[1]["public_signals"][7], "the two arms' contexts");

    // 1. the two arms, sent at once from two relayers
    let second = if plant("arm") { other.clone() } else { arms[1].clone() };
    let need = [withdraw_need("relayer.test.near", &arms[0], false), withdraw_need("relayer2.test.near", &second, false)];
    let (oa, ob) = tokio::join!(
        h.call_outcome(&w.relayer, &h.vault, "withdraw", withdraw_args(&arms[0]), NearToken::from_yoctonear(need[0] + SURPLUS[0]), Gas::from_tgas(300)),
        h.call_outcome(&w.relayer2, &h.vault, "withdraw", withdraw_args(&second), NearToken::from_yoctonear(need[1] + SURPLUS[0]), Gas::from_tgas(300)),
    );
    let outcomes = [oa?, ob?];
    let landed: Vec<usize> = (0..2).filter(|&i| outcomes[i].calls_exactly(&h.vault, "withdraw", 1).map(|r| r[0].ok()).unwrap_or(false)).collect();
    assert_eq!(landed.len(), 1, "exactly one arm lands: {:?}", outcomes.iter().map(|o| o.receipts.iter().map(Receipt::line).collect::<Vec<_>>()).collect::<Vec<_>>());
    let (win, lose) = (landed[0], 1 - landed[0]);
    let (warm, wpayer) = (&arms[win], if win == 0 { &w.relayer } else { &w.relayer2 });
    let (withdrawn, fee) = (u(&warm["public_signals"][2]), u(&warm["withdrawal"]["relay_fee"]));
    println!("arm {} landed, arm {} refused", txt(&warm["name"]), txt(&arms[lose]["name"]));
    paid_out(h, &outcomes[win], txt(&warm["name"]), withdrawn, 0)?;
    let r = outcomes[lose].calls_exactly(&h.vault, "withdraw", 1)?[0];
    let failure = r.failure().ok_or("the second arm landed")?;
    assert!(failure.contains("NullifierAlreadySpent"), "the second arm: want NullifierAlreadySpent, got {failure}");
    assert!(r.logs.is_empty(), "the refused arm logged {:?}", r.logs);
    assert!(
        outcomes[lose].calls_exactly(&h.vault, "on_payout", 0).is_ok() && !outcomes[lose].receipts.iter().any(|x| x.methods.contains(&"ft_transfer".to_string())),
        "the refused arm paid out"
    );
    println!("refused (NullifierAlreadySpent): {}", r.line());
    let (to, fee_to) = ([&w.alice, &w.bob], [&w.relayer, &w.relayer2]);
    assert_eq!(h.token_balance(to[win].id()).await?, withdrawn - fee, "the landed arm's recipient");
    assert_eq!(h.token_balance(fee_to[win].id()).await?, fee, "the landed arm's fee recipient");
    assert_eq!((h.token_balance(to[lose].id()).await?, h.token_balance(fee_to[lose].id()).await?), (0, 0), "the refused arm paid");
    let rows = spends(h, 0, PAGE_MAX).await?;
    assert_eq!(rows.len(), 1, "one note, one row: {rows:?}");
    assert_eq!(matches(&rows[0], &arms), vec![win], "the landed row matches exactly the landed arm's request: {}", rows[0]);
    assert_eq!(h.view(&h.vault, "leaves", json!({"from": 6, "limit": 10})).await?, json!([warm["public_signals"][0]]), "the change leaf is the landed arm's");

    // 2. bounce: carol is not registered, so the payout comes back whole
    let o = h
        .call_outcome(&w.relayer, &h.vault, "withdraw", withdraw_args(&bounce), NearToken::from_yoctonear(withdraw_need("relayer.test.near", &bounce, false) + SURPLUS[1]), Gas::from_tgas(300))
        .await?;
    paid_out(h, &o, "bounce", 0, 2_000_000)?;
    assert_eq!(h.token_balance(w.carol.id()).await?, 0, "carol was paid");
    assert_eq!(h.token_balance(w.relayer.id()).await?, if win == 0 { fee } else { 0 }, "the relayer kept a fee for a bounced payout");

    // 3. u ragequits note 3
    let a = json!({"proof": rq["proof"], "public_signals": rq["public_signals"], "register_deposit": rq["register_deposit"], "refund_precommitment": rq["refund_precommitment"]});
    let o = h.call_outcome(&w.u, &h.vault, "ragequit", a, NearToken::from_yoctonear(ragequit_need("u.test.near") + SURPLUS[2]), Gas::from_tgas(300)).await?;
    let r = o.calls_exactly(&h.vault, "ragequit", 1)?[0];
    assert!(r.ok(), "ragequit: {}", r.line());
    assert_eq!(events(r), ["ragequit"], "{:?}", r.logs);
    o.expect_all_ok("ragequit")?;
    for x in &o.receipts {
        println!("ragequit: {} (gas burnt {:.3} Tgas)", x.line(), x.gas_burnt as f64 / 1e12);
    }
    assert_eq!(h.token_balance(w.u.id()).await?, 10_000_000, "the depositor was not paid note 3");

    // 4. other (its change leaf is the 9th, so the state tree grows a level), then a stranger settles bounce
    let o = h
        .call_outcome(&w.relayer, &h.vault, "withdraw", withdraw_args(&other), NearToken::from_yoctonear(withdraw_need("relayer.test.near", &other, true) + SURPLUS[3]), Gas::from_tgas(300))
        .await?;
    paid_out(h, &o, "other", 3_000_000, 0)?;
    let payer0 = h.near_balance(w.relayer.id()).await?;
    let o = h.call_outcome(&w.stranger, &h.vault, "settle", json!({"nullifier_hash": bounce["public_signals"][1]}), NearToken::from_yoctonear(0), Gas::from_tgas(150)).await?;
    o.expect_all_ok("settle bounce")?;
    let st = o.calls_exactly(&h.vault, "settle", 1)?[0];
    assert_eq!(events(st), ["leaf_inserted", "leaf_inserted", "refund_inserted"], "{:?}", st.logs);
    println!("settle bounce: {} (gas burnt {:.3} Tgas)", st.line(), st.gas_burnt as f64 / 1e12);
    assert_eq!(h.near_balance(w.relayer.id()).await? - payer0, SURPLUS[1], "the reserve's rest to the payer");
    assert_eq!(h.view(&h.vault, "leaves", json!({"from": 9, "limit": 10})).await?, json!([f["refund"]["commitment"]]), "the refund note's leaf");
    assert_eq!(h.view(&h.vault, "labels", json!({"from": 6, "limit": 10})).await?, json!([f["refund"]["label"]]), "the refund note's label");

    // 5. every row's fields, exactly
    let rq_by = w.u.id().as_str();
    let want = vec![
        json!({"index": 0, "nullifier_hash": warm["public_signals"][1], "withdrawn": warm["public_signals"][2], "new_leaf_index": 6,
            "refund_precommitment": warm["withdrawal"]["refund_precommitment"], "refund_value": "0", "refund_label": "0", "refund_leaf_index": 0,
            "status": "paid", "payer": wpayer.id(), "reserve": reserve(0), "recipient": warm["withdrawal"]["recipient"], "fee": warm["withdrawal"]["relay_fee"],
            "context": warm["public_signals"][7]}),
        json!({"index": 1, "nullifier_hash": bounce["public_signals"][1], "withdrawn": "2000000", "new_leaf_index": 7,
            "refund_precommitment": bounce["withdrawal"]["refund_precommitment"], "refund_value": "2000000", "refund_label": f["refund"]["label"], "refund_leaf_index": 9,
            "status": "settled", "payer": "relayer.test.near", "reserve": "0", "recipient": "carol.test.near", "fee": "50000",
            "context": bounce["public_signals"][7]}),
        json!({"index": 2, "nullifier_hash": rq["public_signals"][1], "withdrawn": "10000000", "new_leaf_index": 0,
            "refund_precommitment": rq["refund_precommitment"], "refund_value": "0", "refund_label": "0", "refund_leaf_index": 0,
            "status": "paid", "payer": rq_by, "reserve": reserve(2), "recipient": rq_by, "fee": "0", "context": "0"}),
        json!({"index": 3, "nullifier_hash": other["public_signals"][1], "withdrawn": "3000000", "new_leaf_index": 8,
            "refund_precommitment": other["withdrawal"]["refund_precommitment"], "refund_value": "0", "refund_label": "0", "refund_leaf_index": 0,
            "status": "paid", "payer": "relayer.test.near", "reserve": reserve(3), "recipient": "bob.test.near", "fee": "0",
            "context": other["public_signals"][7]}),
    ];
    assert_eq!(f["refund"]["refund_precommitment"], bounce["withdrawal"]["refund_precommitment"], "the refund note is bounce's");
    let config = h.view(&h.vault, "config", json!({})).await?;
    assert_eq!(config["page_max"].as_u64(), Some(PAGE_MAX), "{config}");
    let all = spends(h, 0, PAGE_MAX).await?;
    for (got, want) in all.iter().zip(&want) {
        assert_eq!(got, want, "row {}", want["index"]);
    }
    assert_eq!(all, want, "spends(0, PAGE_MAX)");
    assert_eq!(matches(&all[0], &arms), vec![win], "the landed row matches exactly one request");
    for (i, row) in all.iter().enumerate() {
        assert!(!(i > 0 && row["nullifier_hash"] == arms[lose]["public_signals"][1]), "a second row of the arms' note: {row}");
        assert_ne!(row["context"], arms[lose]["public_signals"][7], "the refused arm's context is in row {i}");
    }
    assert_eq!(spends(h, 0, u64::MAX).await?, want, "a limit over PAGE_MAX");
    assert_eq!(spends(h, 1, PAGE_MAX).await?, want[1..], "from the middle");
    assert_eq!(spends(h, 2, 1).await?, want[2..3], "one row from the middle");
    assert_eq!(spends(h, 1, 2).await?, want[1..3], "two rows from the middle");
    for from in [4, 5, u64::MAX] {
        assert!(spends(h, from, PAGE_MAX).await?.is_empty(), "a page from {from}, past the end");
    }
    assert!(spends(h, 0, 0).await?.is_empty(), "a limit of 0");
    for from in 0..3u64 {
        for size in 1..=4u64 {
            let got = walk(h, from, size, want.len()).await?;
            let idx: Vec<u64> = got.iter().map(|r| r["index"].as_u64().unwrap()).collect();
            assert_eq!(idx, (from..want.len() as u64).collect::<Vec<_>>(), "the walk from {from} by {size}: a skip or a repeat");
            assert_eq!(got, want[from as usize..], "the walk from {from} by {size}");
        }
    }

    let t = h.view(&h.vault, "totals", json!({})).await?;
    let spent = withdrawn + 2_000_000 + 10_000_000 + 3_000_000;
    assert_eq!(t, json!({"deposited": "31000000", "spent": spent.to_string(), "returned": "2000000"}), "{t}");
    assert_eq!(h.token_balance(&h.vault).await?, 31_000_000 - withdrawn - 10_000_000 - 3_000_000);
    assert_eq!(h.token_balance(w.bob.id()).await?, 3_000_000 + if win == 1 { withdrawn - fee } else { 0 }, "bob");
    println!("{kind:?}: VT-S19 holds\n{}", h.gas_table());
    h.i1().await?;
    Ok(())
}

#[tokio::test]
async fn vt_s19_mock() -> R<()> {
    vt_s19(TokenKind::Mock).await
}

#[tokio::test]
async fn vt_s19_usdc() -> R<()> {
    vt_s19(TokenKind::Usdc).await
}
