// SPDX-License-Identifier: Apache-2.0
//! VT-S04 (vault.md 5, V:1140; V:402-406; 7.2 V2), in near-sandbox 2.13.4 on the mock token and on the real USDC wasm
//! at TOKEN. Runs only with `--features sandbox`, through tests/harness/run.sh
//! (`contracts/vault/tests/harness/run.sh --test s04`); a plain `cargo test` builds this file empty.
//!
//! Three withdrawals of tests/fixtures/withdraw-spends.json, each on a vault holding the fixture's six notes
//! (deposited through `ft_on_transfer`, as tests/payouts.rs does):
//! - `relayed`: same_call, sent by the relayer, 2,000,000 with a 500,000 fee, to alice (registered on the token);
//! - `self`: same_nullifier_a, sent by alice herself, 1,000,000 with fee 0, to alice;
//! - `register`: new_account, sent by the relayer, 7,000,000 with a 100,000 fee, to newcomer, who has no storage on the
//!   token, with `register_deposit` = the token's 0.00125 NEAR.
//!
//! The gas each call needs is measured here, never written down: on a scout vault the call is sent at 10, 20, 30 ...
//! Tgas until it lands at C; on the main vault it is sent again from C - 10 upward, one Tgas at a time, until it lands
//! at G. So the main vault itself refused the call at G - 1 Tgas and took it at exactly G, and G must be 2.5.2's bound
//! (V:408): the payouts' statics read from `config()` + 100 Tgas, while the landed call burns less than G in all. Every
//! send under G must be refused by that pre-check (`InsufficientGas`), before any write. Before the scan, the call at
//! C with row 14's requirement less one yocto is refused as `InsufficientStorageDeposit`, the one refusal that comes
//! after the spend's writes (the tree, the nullifier, the spend record, `totals`), so a rollback is proven on it.
//! Every refused send on the main vault must log nothing and leave the vault as it was: the spends (the nullifier set) and this nullifier unspent, both trees'
//! root and size, `totals`, the vault's storage use and every raw state byte, the token balances of the vault, the
//! recipient, the fee recipient and the sender, the recipient's token registration, the NEAR of the recipient and the
//! fee recipient (when not the sender), the sender's NEAR less exactly the transaction's burnt tokens, and the vault's
//! NEAR at most the withdraw receipt's burnt tokens higher (its share of the gas, never the attachment: the attachment,
//! row 14's requirement, is several times what the refused receipt burns).
//!
//! At G the call lands whole (every receipt succeeds): the recipient gets withdrawn - fee, the fee recipient the fee,
//! the vault gives withdrawn, all to the base unit; the spend reads `paid` with its withdrawn, fee and recipient;
//! its `reserve` is exactly REFUND_RESERVE_BYTES' worth (the attachment is exactly row 14's requirement);
//! `totals.spent` rises by withdrawn; the state tree takes one leaf; for `register` the recipient's
//! `storage_balance_of` goes from none to `register_deposit`. Then the same call again, at G, is refused as
//! `NullifierAlreadySpent` with the vault as it was.
//!
//! Every check is named `<case>.<step>.<what>` and printed with its numbers. `VT_S04_PLANT=<name>` plants a wrong
//! expectation in that one check (a number one higher, a text with one more character), so the run must fail at it.
#![cfg(feature = "sandbox")]

mod harness;

use harness::{Harness, Outcome, TokenKind, R, YOCTO_PER_BYTE};
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId};
use std::fmt::Debug;

const SPENDS: &str = include_str!("fixtures/withdraw-spends.json");
/// The kit's prepay whenever a tree may grow (2.10 (h)).
const PREPAY_BYTES: u128 = 904;
/// 2.3: a spend's bytes with a 64-byte payer and recipient (710, + 81 for its refund precommitment's
/// `precommitments` row), when the state tree grows no level; + 74 when it does.
const SPEND_BYTES: u128 = 791;
const LEVEL_BYTES: u128 = 74;
const REFUND_RESERVE_BYTES: u128 = blindfill_vault::constants::REFUND_RESERVE_BYTES as u128;
/// USDC's and the mock's registration.
const REGISTER: u128 = 1_250_000_000_000_000_000_000;
/// The coarse step of the scout's scan, and where the scan stops.
const COARSE_TGAS: u64 = 10;
/// 2.5.2's pre-check keeps 100 Tgas for the vault's own work on top of the statics it hands on (V:408).
const OWN_WORK_TGAS: u128 = 100;
const MAX_TGAS: u64 = 300;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Sender {
    Relayer,
    Alice,
}

struct Case {
    key: &'static str,
    spend: &'static str,
    sender: Sender,
    recipient: &'static str,
    withdrawn: u128,
    fee: u128,
    register: u128,
}

const FEE_RECIPIENT: &str = "relayer.test.near";

const CASES: [Case; 3] = [
    Case { key: "relayed", spend: "same_call", sender: Sender::Relayer, recipient: "alice.test.near", withdrawn: 2_000_000, fee: 500_000, register: 0 },
    Case { key: "self", spend: "same_nullifier_a", sender: Sender::Alice, recipient: "alice.test.near", withdrawn: 1_000_000, fee: 0, register: 0 },
    Case { key: "register", spend: "new_account", sender: Sender::Relayer, recipient: "newcomer.test.near", withdrawn: 7_000_000, fee: 100_000, register: REGISTER },
];

fn fixture() -> Value {
    serde_json::from_str(SPENDS).unwrap()
}

/// The fixture's spend `name` as `withdraw`'s arguments.
fn args(name: &str) -> Value {
    let f = fixture();
    let s = f["spends"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap().clone();
    json!({"withdrawal": s["withdrawal"], "proof": s["proof"], "public_signals": s["public_signals"]})
}

fn plant() -> Option<String> {
    std::env::var("VT_S04_PLANT").ok().filter(|p| !p.is_empty())
}

fn planted(name: &str) -> bool {
    plant().as_deref() == Some(name)
}

/// A number check: `got == want`, printed; a planted check wants one more.
fn num(name: &str, got: u128, want: u128) {
    let want = if planted(name) { want + 1 } else { want };
    println!("check {name}: got {got}, want {want}");
    assert_eq!(got, want, "{name}");
}

/// A value check (text, a list, a whole state): `got == want`; a planted check wants a value one character longer.
fn same<T: Debug>(name: &str, got: &T, want: &T) {
    let g = format!("{got:?}");
    let mut w = format!("{want:?}");
    if planted(name) {
        w.push('!');
    }
    println!("check {name}: {} B, {}", g.len(), if g == w { "equal" } else { "DIFFERENT" });
    assert_eq!(g, w, "{name}");
}

struct World {
    kind: TokenKind,
    h: Harness,
    relayer: Account,
    alice: Account,
    _newcomer: Account,
}

impl World {
    fn sender(&self, c: &Case) -> &Account {
        match c.sender {
            Sender::Relayer => &self.relayer,
            Sender::Alice => &self.alice,
        }
    }
    fn id(&self, name: &str) -> AccountId {
        name.parse().unwrap()
    }
}

/// A vault on `kind`'s token holding the fixture's six notes, deposited through `ft_on_transfer`; the relayer and
/// alice registered on the token, newcomer an account the token has never seen.
async fn world(kind: TokenKind) -> R<World> {
    let h = Harness::with_vault_and(kind).await?;
    let f = fixture();
    let u = h.account("u", 50).await?;
    let relayer = h.account("relayer", 50).await?;
    let alice = h.account("alice", 50).await?;
    let newcomer = h.account("newcomer", 5).await?;
    assert_eq!(
        (relayer.id().as_str(), alice.id().as_str(), newcomer.id().as_str()),
        (FEE_RECIPIENT, "alice.test.near", "newcomer.test.near"),
        "the fixture's accounts"
    );
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
    assert_eq!(h.token_balance(&h.vault).await?, total);
    for a in [&relayer, &alice] {
        let _ = h.storage_deposit(&h.root, a.id()).await?;
    }
    assert!(h.view(&h.token, "storage_balance_of", json!({"account_id": newcomer.id()})).await?.is_null(), "newcomer is registered");
    Ok(World { kind, h, relayer, alice, _newcomer: newcomer })
}

/// The fixture's spend is the case: recipient, fee recipient, fee, registration and withdrawn value.
fn check_case(c: &Case) {
    let a = args(c.spend);
    let w = &a["withdrawal"];
    assert_eq!(w["recipient"], c.recipient, "{}", c.key);
    assert_eq!(w["fee_recipient"], FEE_RECIPIENT, "{}", c.key);
    assert_eq!(w["relay_fee"], c.fee.to_string(), "{}", c.key);
    assert_eq!(w["register_deposit"], c.register.to_string(), "{}", c.key);
    assert_eq!(a["public_signals"][2], c.withdrawn.to_string(), "{}: withdrawnValue", c.key);
}

/// Row 14's requirement: the bytes the spend writes (a level more when the state tree grows) + the reserve, the
/// registration and a yocto per `ft_transfer`.
async fn row14(w: &World, c: &Case) -> R<u128> {
    let size = w.h.view(&w.h.vault, "state_tree", json!({})).await?["size"].as_u64().ok_or("state_tree size")?;
    let payer = w.sender(c).id().as_str().len() as u128;
    let mut bytes = SPEND_BYTES - (64 - payer) - (64 - c.recipient.len() as u128);
    if size.is_power_of_two() {
        bytes += LEVEL_BYTES;
    }
    let transfers = if c.fee > 0 { 2 } else { 1 };
    Ok((bytes + REFUND_RESERVE_BYTES) * YOCTO_PER_BYTE + c.register + transfers)
}

async fn send(w: &World, c: &Case, tgas: u64) -> R<(Outcome, u128)> {
    let need = row14(w, c).await?;
    let o = w.h.call_outcome(w.sender(c), &w.h.vault, "withdraw", args(c.spend), NearToken::from_yoctonear(need), Gas::from_tgas(tgas)).await?;
    Ok((o, need))
}

/// Whether the call's withdraw receipt succeeded; when it did, every receipt must have.
fn landed(w: &World, c: &Case, o: &Outcome) -> R<bool> {
    let r = o.calls_exactly(&w.h.vault, "withdraw", 1)?[0];
    if r.ok() {
        o.expect_all_ok(c.key)?;
        let _ = o.calls_exactly(&w.h.vault, "on_payout", 1)?;
        return Ok(true);
    }
    // failed whole: no payout part and no callback left the vault
    let _ = o.calls_exactly(&w.h.vault, "on_payout", 0)?;
    assert!(!o.receipts.iter().any(|x| x.executor == w.h.token.as_str()), "{}: a refused call reached the token", c.key);
    Ok(false)
}

/// Everything a withdrawal can move or write.
#[derive(Debug, Clone)]
struct Snap {
    spends: Vec<Value>,
    spent: bool,
    state_tree: Value,
    label_tree: Value,
    totals: Value,
    storage_usage: u128,
    raw: Vec<(String, String)>,
    vault: u128,
    recipient: u128,
    fee_recipient: u128,
    sender: u128,
    registration: u128,
    near_vault: u128,
    near_recipient: u128,
    near_fee_recipient: u128,
    near_sender: u128,
}

async fn snap(w: &World, c: &Case) -> R<Snap> {
    let h = &w.h;
    h.wait_final(&h.vault).await?;
    let spends = h.view(&h.vault, "spends", json!({"from": 0, "limit": 100})).await?.as_array().ok_or("spends: not a list")?.clone();
    let n = args(c.spend)["public_signals"][1].clone();
    let raw = {
        let v = h.rpc("query", json!({"request_type": "view_state", "finality": "final", "account_id": h.vault, "prefix_base64": ""})).await?;
        let values = v["result"]["values"].as_array().ok_or_else(|| format!("view_state: {v}"))?;
        let mut kv: Vec<(String, String)> =
            values.iter().map(|e| (e["key"].as_str().unwrap_or_default().to_string(), e["value"].as_str().unwrap_or_default().to_string())).collect();
        kv.sort();
        kv
    };
    let reg = h.view(&h.token, "storage_balance_of", json!({"account_id": c.recipient})).await?;
    let registration = if reg.is_null() { 0 } else { reg["total"].as_str().ok_or("storage_balance_of total")?.parse()? };
    let (recipient, fee_recipient, sender) = (w.id(c.recipient), w.id(FEE_RECIPIENT), w.sender(c).id().clone());
    Ok(Snap {
        spent: spends.iter().any(|s| s["nullifier_hash"] == n),
        spends,
        state_tree: h.view(&h.vault, "state_tree", json!({})).await?,
        label_tree: h.view(&h.vault, "label_tree", json!({})).await?,
        totals: h.view(&h.vault, "totals", json!({})).await?,
        storage_usage: h.account_view(&h.vault, "final").await?["storage_usage"].as_u64().ok_or("storage_usage")? as u128,
        raw,
        vault: h.token_balance(&h.vault).await?,
        recipient: h.token_balance(&recipient).await?,
        fee_recipient: h.token_balance(&fee_recipient).await?,
        sender: h.token_balance(&sender).await?,
        registration,
        near_vault: h.near_balance(&h.vault).await?,
        near_recipient: h.near_balance(&recipient).await?,
        near_fee_recipient: h.near_balance(&fee_recipient).await?,
        near_sender: h.near_balance(&sender).await?,
    })
}

/// The tokens a transaction burnt in all (its own conversion and every receipt), and those of its vault receipts.
async fn burnt(h: &Harness, o: &Outcome, sender: &AccountId) -> R<(u128, u128)> {
    let v = h.rpc("EXPERIMENTAL_tx_status", json!({"tx_hash": o.tx_hash, "sender_account_id": sender, "wait_until": "FINAL"})).await?;
    let r = &v["result"];
    let t = |x: &Value| -> R<u128> { Ok(x["outcome"]["tokens_burnt"].as_str().ok_or_else(|| format!("no tokens_burnt in {x}"))?.parse()?) };
    let mut all = t(&r["transaction_outcome"])?;
    let mut vault = 0;
    for ro in r["receipts_outcome"].as_array().ok_or("no receipts_outcome")? {
        let b = t(ro)?;
        all += b;
        if ro["outcome"]["executor_id"] == h.vault.as_str() {
            vault += b;
        }
    }
    Ok((all, vault))
}

/// The call failed whole with `want` in its withdraw receipt, which logged nothing: everything in `before` reads the
/// same after, but the sender's NEAR (less exactly the burnt tokens) and the vault's NEAR (its gas share, at most what
/// its receipt burnt).
async fn unchanged(w: &World, c: &Case, step: &str, before: &Snap, o: &Outcome, want: &str) -> R<()> {
    let k = |what: &str| format!("{}.{step}.{what}", c.key);
    let r = o.calls_exactly(&w.h.vault, "withdraw", 1)?[0];
    let f = r.failure().ok_or_else(|| format!("{}: the withdraw receipt landed", k("error")))?;
    let want = if planted(&k("error")) { format!("{want}!") } else { want.to_string() };
    println!("check {}: want {want}, got {}", k("error"), f.chars().take(160).collect::<String>());
    assert!(f.contains(&want), "{}: want {want}, got {f}", k("error"));
    num(&k("logs"), r.logs.len() as u128, 0);
    let after = snap(w, c).await?;
    same(&k("spends"), &after.spends, &before.spends);
    num(&k("spent"), after.spent as u128, before.spent as u128);
    same(&k("state_tree"), &after.state_tree, &before.state_tree);
    same(&k("label_tree"), &after.label_tree, &before.label_tree);
    same(&k("totals"), &after.totals, &before.totals);
    num(&k("storage_usage"), after.storage_usage, before.storage_usage);
    same(&k("raw_state"), &after.raw, &before.raw);
    num(&k("vault"), after.vault, before.vault);
    num(&k("recipient"), after.recipient, before.recipient);
    num(&k("fee_recipient"), after.fee_recipient, before.fee_recipient);
    num(&k("sender"), after.sender, before.sender);
    num(&k("registration"), after.registration, before.registration);
    let sender = w.sender(c).id().clone();
    if sender.as_str() != c.recipient {
        num(&k("near_recipient"), after.near_recipient, before.near_recipient);
    }
    if sender.as_str() != FEE_RECIPIENT {
        num(&k("near_fee_recipient"), after.near_fee_recipient, before.near_fee_recipient);
    }
    let (all, vault_burnt) = burnt(&w.h, o, &sender).await?;
    num(&k("near_sender_paid"), before.near_sender - after.near_sender, all);
    let gain = after.near_vault.checked_sub(before.near_vault).ok_or_else(|| format!("{}: the vault's NEAR fell", k("near_vault")))?;
    // its gas share only: a planted check allows one yocto less than it gained
    let bound = if planted(&k("near_vault")) { gain.saturating_sub(1) } else { vault_burnt };
    println!("check {}: the vault's NEAR +{gain} yocto, at most {bound} (its receipts burnt {vault_burnt})", k("near_vault"));
    assert!(gain <= bound, "{}: the vault kept {gain} yocto, more than its receipt burnt ({vault_burnt})", k("near_vault"));
    Ok(())
}

/// The scout: the call at 10, 20, 30 ... Tgas until it lands; returns where it landed.
async fn scout(w: &World, c: &Case) -> R<u64> {
    let mut t = COARSE_TGAS;
    while t <= MAX_TGAS {
        let (o, _) = send(w, c, t).await?;
        if landed(w, c, &o)? {
            println!("{:?} {}: scout: lands at {t} Tgas, refused at {} Tgas", w.kind, c.key, t - COARSE_TGAS);
            return Ok(t);
        }
        t += COARSE_TGAS;
    }
    Err(format!("{}: no landing up to {MAX_TGAS} Tgas", c.key).into())
}

/// The main vault: from C - 10 Tgas upward one Tgas at a time, each refusal checked as failing whole, to the first
/// landing at G; then the exact amounts, the registration, and the replay refused.
async fn measured(w: &World, c: &Case, coarse: u64) -> R<u64> {
    let h = &w.h;
    // row 14 one yocto short, at gas the scout saw land: refused after the spend's writes, and rolled back whole
    let before = snap(w, c).await?;
    let need = row14(w, c).await?;
    let o = h.call_outcome(w.sender(c), &h.vault, "withdraw", args(c.spend), NearToken::from_yoctonear(need - 1), Gas::from_tgas(coarse)).await?;
    assert!(!landed(w, c, &o)?, "{}: landed one yocto under row 14", c.key);
    println!("{:?} {}: one yocto under row 14 at {coarse} Tgas: withdraw burnt {:.3} Tgas", w.kind, c.key, o.calls_exactly(&h.vault, "withdraw", 1)?[0].gas_burnt as f64 / 1e12);
    unchanged(w, c, "storage_short", &before, &o, "InsufficientStorageDeposit").await?;

    let mut t = coarse.saturating_sub(COARSE_TGAS).max(1);
    let mut refused_below = None;
    let g = loop {
        if t > coarse {
            return Err(format!("{}: the main vault refused up to the scout's {coarse} Tgas", c.key).into());
        }
        let before = snap(w, c).await?;
        let (o, _) = send(w, c, t).await?;
        if landed(w, c, &o)? {
            assert_eq!(refused_below, Some(t - 1), "{}: landed at {t} Tgas with no refusal at {} Tgas on this vault", c.key, t - 1);
            break (t, before, o);
        }
        println!("{:?} {}: refused at {t} Tgas", w.kind, c.key);
        unchanged(w, c, &format!("short{t}"), &before, &o, "InsufficientGas").await?;
        refused_below = Some(t);
        t += 1;
    };
    let (g, before, o) = g;
    // the measured need is 2.5.2's bound: the statics config() names for this call's payouts + 100 Tgas (V:408)
    assert_eq!(refused_below, Some(g - 1));
    let cfg = h.view(&h.vault, "config", json!({})).await?;
    let st = |name: &str| -> u128 { cfg[name].as_u64().unwrap_or_else(|| panic!("config() has no {name}: {cfg}")) as u128 };
    let bound = st("gas_ft_transfer_tgas")
        + st("gas_on_payout_tgas")
        + if c.register > 0 { st("gas_storage_deposit_tgas") } else { 0 }
        + if c.fee > 0 { st("gas_ft_transfer_tgas") } else { 0 }
        + OWN_WORK_TGAS;
    num(&format!("{}.gas", c.key), g as u128, bound);
    // and the call's real use is under it: every receipt's gas burnt, summed
    let used: u128 = o.receipts.iter().map(|r| r.gas_burnt as u128).sum();
    let cap = if planted(&format!("{}.burnt", c.key)) { used } else { g as u128 * 1_000_000_000_000 };
    println!("check {}.burnt: the call burnt {used} gas in all, under {cap}", c.key);
    assert!(used < cap, "{}.burnt: {used} gas burnt, not under {cap}", c.key);
    let wr = o.calls_exactly(&h.vault, "withdraw", 1)?[0];
    let cb = o.calls_exactly(&h.vault, "on_payout", 1)?[0];
    println!("{:?} {}: measured: refused at {} Tgas, lands at exactly {g} Tgas; withdraw burnt {:.3} Tgas, on_payout {:.3} Tgas", w.kind, c.key, g - 1, wr.gas_burnt as f64 / 1e12, cb.gas_burnt as f64 / 1e12);
    for r in &o.receipts {
        println!("{:?} {}: {}", w.kind, c.key, r.line());
    }

    // exact amounts, to the base unit
    let after = snap(w, c).await?;
    let k = |what: &str| format!("{}.landed.{what}", c.key);
    let to_recipient = c.withdrawn - c.fee;
    let sender = w.sender(c).id().as_str().to_string();
    let gets = |who: &str| -> u128 { (if who == c.recipient { to_recipient } else { 0 }) + (if who == FEE_RECIPIENT { c.fee } else { 0 }) };
    num(&k("vault"), after.vault, before.vault - c.withdrawn);
    num(&k("recipient"), after.recipient, before.recipient + to_recipient);
    num(&k("fee_recipient"), after.fee_recipient, before.fee_recipient + c.fee);
    num(&k("sender"), after.sender, before.sender + gets(&sender));
    num(&k("registration_before"), before.registration, if c.register > 0 { 0 } else { REGISTER });
    num(&k("registration"), after.registration, if c.register > 0 { c.register } else { REGISTER });
    num(&k("spent"), after.spent as u128, 1);
    num(&k("spends"), after.spends.len() as u128, before.spends.len() as u128 + 1);
    let n = args(c.spend)["public_signals"][1].clone();
    let row = after.spends.iter().find(|s| s["nullifier_hash"] == n).unwrap();
    same(&k("status"), &row["status"], &json!("paid"));
    same(&k("reserve"), &row["reserve"], &json!((REFUND_RESERVE_BYTES * YOCTO_PER_BYTE).to_string()));
    same(&k("row"), &(row["withdrawn"].clone(), row["fee"].clone(), row["recipient"].clone(), row["refund_value"].clone()), &(json!(c.withdrawn.to_string()), json!(c.fee.to_string()), json!(c.recipient), json!("0")));
    let spent = |s: &Snap| -> u128 { s.totals["spent"].as_str().unwrap().parse().unwrap() };
    num(&k("totals_spent"), spent(&after), spent(&before) + c.withdrawn);
    num(&k("state_size"), after.state_tree["size"].as_u64().unwrap() as u128, before.state_tree["size"].as_u64().unwrap() as u128 + 1);
    println!(
        "{:?} {}: amounts: vault {} -> {}, recipient {} {} -> {}, fee recipient {FEE_RECIPIENT} {} -> {}, sender {sender} {} -> {}, registration {} -> {}",
        w.kind,
        c.key, before.vault, after.vault, c.recipient, before.recipient, after.recipient, before.fee_recipient, after.fee_recipient, before.sender, after.sender, before.registration, after.registration
    );

    // the same call again, with enough gas: refused, the vault as it was
    let before = after;
    let (o, _) = send(w, c, g).await?;
    assert!(!landed(w, c, &o)?, "{}: the replay landed", c.key);
    unchanged(w, c, "replay", &before, &o, "NullifierAlreadySpent").await?;
    Ok(g)
}

async fn vt_s04(kind: TokenKind) -> R<()> {
    for c in &CASES {
        check_case(c);
    }
    let (scout_w, main_w) = tokio::join!(world(kind), world(kind));
    let (scout_w, main_w) = (scout_w?, main_w?);
    let mut table = vec![];
    for c in &CASES {
        let coarse = scout(&scout_w, c).await?;
        let g = measured(&main_w, c, coarse).await?;
        table.push((c.key, g));
    }
    for (key, g) in &table {
        println!("{kind:?}: {key}: refused at {} Tgas, lands at {g} Tgas", g - 1);
    }
    println!("{kind:?}: VT-S04 holds\n{}", main_w.h.gas_table());
    if let Some(p) = plant() {
        return Err(format!("VT_S04_PLANT={p} names no check that ran").into());
    }
    scout_w.h.i1().await?;
    main_w.h.i1().await?;
    Ok(())
}

#[tokio::test]
async fn vt_s04_mock() -> R<()> {
    vt_s04(TokenKind::Mock).await
}

#[tokio::test]
async fn vt_s04_usdc() -> R<()> {
    vt_s04(TokenKind::Usdc).await
}
