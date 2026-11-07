// SPDX-License-Identifier: Apache-2.0
//! VT-S16 (vault.md 5, V:1155): the real USDC wasm at TOKEN, halted, blocking the vault or changed by a test account
//! in its role, at each point of a deposit or a payout, in near-sandbox 2.13.4. Every note and total stays right on a
//! vault that can never be upgraded. Runs only with `--features sandbox`, through tests/harness/run.sh
//! (`contracts/vault/tests/harness/run.sh --test s16`); a plain `cargo test` builds this file empty.
//!
//! (a), (c), (d) share one run, from the six deposits of tests/fixtures/withdraw-spends.json (all by u) made through
//! `ft_on_transfer`, with every payee registered on the token so that only the token's own switch can bounce a payout:
//! fee_bounces (note 5, 7,000,000, relay_fee 100,000, to newcomer with `register_deposit` > 0) and recipient_bounces
//! (note 1, 2,000,000, relay_fee 500,000, to alice) of tests/fixtures/settle-spends.json, and u's ragequit of note 3
//! (10,000,000) of tests/fixtures/ragequit-spends.json, all sent while the switch is on. Each lands, its payout receipt
//! fails at the token, and `on_payout` records the whole payout as `refund_pending` (7,000,000, 2,000,000 and
//! 10,000,000; totals 31,000,000 / 19,000,000 / 19,000,000); no USDC leaves the vault. A stranger settles all three
//! while the switch is still on: the refund notes are the fixture's (leaves 8 and 9, labels 6 and 7) and the
//! ragequit's (leaf 10, label 8, Poseidon(10,000,000, label, its refund precommitment)). Then the switch goes off: the
//! vault still holds exactly 31,000,000 (I1 equal), and the device spends fee_bounces' refund note to alice (7,000,000).
//! - (a) `vt_s16_a_halt_before_payouts`: USDC's pausers halt it (`Pause` by their multisig); each payout fails with
//!   "FiatToken: paused". Off: `Unpause`.
//! - (c) `vt_s16_c_vault_blocked`: USDC's blocklister blocklists the vault; each payout fails with "is blocklisted".
//!   While blocked, u's own deposit call on a prepaid P fails whole at the token: u keeps its USDC, no receipt reaches
//!   the vault, P stays unused. Off: `unblocklist`; then the same deposit lands on the same P.
//! - (d) `vt_s16_d_token_code_changed`: the token account's key holder deploys other code over USDC (the harness's
//!   mock token wasm, which cannot read USDC's state), and the token's code hash reads as the mock's, not the pin.
//!   Each payout receipt fails at its first action that reads state (`storage_deposit` for fee_bounces, `ft_transfer`
//!   for the others) with the new code's "Cannot deserialize the contract state.", pinned here. Off: the key holder
//!   deploys the pinned USDC again, its state untouched; the same refund note withdraws. A token that never comes back
//!   strands the notes in the vault, the residual M9 names; nothing on the vault's side is lost or changed meanwhile.
//!   VT-S16 (d)'s named result, the relayer's code-hash watch holding every call once the hash is not the pin (7.3), is
//!   the helper's: apps/helper/src/token-status/status.test.ts l.91-104 (a changed hash is shown as read and held),
//!   apps/helper/src/bind/send.test.ts l.483-488 (a deposit call held as `token_halted` on a code hash not the pin,
//!   nothing sent) and apps/helper/src/withdraw/send.test.ts l.659 (check 10: a withdrawal held while the watch reads
//!   the token halted). This test shows the on-chain hash those watches read moving off the pin.
//! - (b) `vt_s16_b_halt_between_move_and_resolve`: a halting account acting inside the receipt chain. USDC's second
//!   pauser holds USDC and sends one transaction to the token holding [ft_transfer_call(vault), execute_multisig_request
//!   (Pause)], so the halt lands after the move and before the token's resolve. First on a deposit the vault accepts:
//!   the note lands, the resolve fails on "FiatToken: paused" with nothing to give back, and nothing is lost. Then a
//!   stranger sends the vault 1 N (as every prepaid deposit leaves NEAR with the vault, deposit.rs row 6, so a vault
//!   that skipped row 6 could pay for the record and land the deposit), and on a deposit the vault refuses (no prepay,
//!   as a relayer broken into can force): `ft_on_transfer` refuses with `NoPrepay`, the resolve fails on "FiatToken: paused", and the amount stays
//!   in the vault with no note: the loss the M1 row names, read exactly (the vault's USDC is the sum of its totals
//!   plus that amount; no record, no totals moved, the supply unchanged). Then the same P, prepaid, lands after the
//!   unhalt: P stayed unused and every later note is right.
//!
//! (e), U's call halted before the token call and the same P after the unhalt, is tests/relayer_send.rs's halted_*
//! cases and RESULT §3.1.
//!
//! Prints every payout and settle receipt with its gas, and the gas table.
#![cfg(feature = "sandbox")]

mod harness;

use harness::{code_hash, commitment_on, pinned_wasm, wasm_from_env, Harness, Outcome, Receipt, TokenKind, R, USDC_HALTED, YOCTO_PER_BYTE};
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::operations::Function;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::Account;

const DEPOSITS: &str = include_str!("fixtures/withdraw-spends.json");
const SPENDS: &str = include_str!("fixtures/settle-spends.json");
const RAGEQUITS: &str = include_str!("fixtures/ragequit-spends.json");
/// The kit's prepay whenever a tree may grow (2.10 (h)).
const PREPAY_BYTES: u128 = 904;
/// 2.3: a spend's bytes with a 64-byte payer and recipient, when the state tree grows no level.
const SPEND_BYTES: u128 = 710;
/// 2.3: a ragequit's bytes (spent 81 + spends 394) with a 64-byte depositor.
const RAGEQUIT_BYTES: u128 = 475;
const REFUND_RESERVE_BYTES: u128 = blindfill_vault::constants::REFUND_RESERVE_BYTES as u128;
/// USDC's registration.
const REGISTER: u128 = 1_250_000_000_000_000_000_000;
/// What a stranger attaches to each settle: more than any shortfall here (a level is 74 B); the rest comes back.
const SETTLE_ATTACH: u128 = 10_000_000_000_000_000_000_000;
/// USDC's message for a blocklisted account ("FiatToken: <account> is blocklisted").
const BLOCKED: &str = "is blocklisted";
/// near-sdk's panic when code reads a state it cannot decode: the mock token's on USDC's state, in (d).
const NEW_CODE: &str = "Cannot deserialize the contract state.";
/// The whole six deposits.
const TOTAL: u128 = 31_000_000;
/// One deposit in (b) and (c).
const AMOUNT: u128 = 2_000_000;

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

/// The ragequit fixture's `deposit` (u's note 3, 10,000,000) as `ragequit`'s arguments.
fn rq() -> Value {
    let f = json_of(RAGEQUITS);
    let r = f["ragequits"].as_array().unwrap().iter().find(|s| s["name"] == "deposit").unwrap().clone();
    json!({"proof": r["proof"], "public_signals": r["public_signals"], "register_deposit": r["register_deposit"], "refund_precommitment": r["refund_precommitment"]})
}

/// Row 14's requirement for a spend whose payer and recipient ids have these lengths, when no tree grows a level.
fn row14_need(payer: &str, recipient: &str, register_deposit: u128, transfers: u128) -> u128 {
    let bytes = SPEND_BYTES - (64 - payer.len() as u128) - (64 - recipient.len() as u128);
    (bytes + REFUND_RESERVE_BYTES) * YOCTO_PER_BYTE + register_deposit + transfers
}

/// 2.5.3 row 6's requirement for a depositor id of this length: bytes, reserve, 1 yocto.
fn rq_need(depositor: &str) -> u128 {
    (RAGEQUIT_BYTES - 2 * (64 - depositor.len() as u128) + REFUND_RESERVE_BYTES) * YOCTO_PER_BYTE + 1
}

fn deposit_msg(p: &str, depositor: &str) -> String {
    format!(r#"{{"precommitment":"{p}","depositor":"{depositor}"}}"#)
}

/// A log line's one `data` object.
fn data(line: &str) -> Value {
    let v: Value = serde_json::from_str(line.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    v["data"][0].clone()
}

/// The event names a receipt logged, in order.
fn events(r: &Receipt) -> Vec<String> {
    r.logs.iter().map(|l| l.split(r#""event":""#).nth(1).and_then(|e| e.split('"').next()).unwrap_or("").to_string()).collect()
}

struct World {
    h: Harness,
    u: Account,
    relayer: Account,
    alice: Account,
    newcomer: Account,
    stranger: Account,
}

/// The real USDC with the vault holding the six notes, deposited by u through `ft_on_transfer`; newcomer, relayer and
/// alice registered on the token, so a payout to them fails only at the token's own switch.
async fn deposited() -> R<World> {
    let h = Harness::with_vault_and(TokenKind::Usdc).await?;
    let f = json_of(DEPOSITS);
    let u = h.account("u", 50).await?;
    let relayer = h.account("relayer", 50).await?;
    let alice = h.account("alice", 50).await?;
    let newcomer = h.account("newcomer", 5).await?;
    let stranger = h.account("stranger", 50).await?;
    assert_eq!((relayer.id().as_str(), alice.id().as_str(), newcomer.id().as_str()), ("relayer.test.near", "alice.test.near", "newcomer.test.near"), "the fixture's accounts");
    assert_eq!(f["deposited"].as_str(), Some("31000000"));
    h.mint(u.id(), TOTAL).await?;
    let prepay = NearToken::from_yoctonear(PREPAY_BYTES * YOCTO_PER_BYTE);
    for (p, value) in f["precommitments"].as_array().unwrap().iter().zip(f["values"].as_array().unwrap()) {
        let p = p.as_str().unwrap();
        let _ = h.call(&relayer, &h.vault, "storage_prepay", json!({"precommitment": p}), prepay, Gas::from_tgas(30)).await?;
        let a = json!({"receiver_id": h.vault, "amount": value, "msg": deposit_msg(p, u.id().as_str())});
        let o = h.call(&u, &h.token, "ft_transfer_call", a, NearToken::from_yoctonear(1), Gas::from_tgas(180)).await?;
        let _ = o.calls_exactly(&h.vault, "ft_on_transfer", 1)?;
    }
    assert_eq!(h.view(&h.vault, "leaves", json!({"from": 0, "limit": 10})).await?, f["leaves"], "the deposits' leaves are the fixture's");
    assert_eq!(h.view(&h.vault, "labels", json!({"from": 0, "limit": 10})).await?, f["labels"], "the deposits' labels are the fixture's");
    for a in [&newcomer, &relayer, &alice] {
        let _ = h.storage_deposit(&h.root, a.id()).await?;
    }
    assert_eq!(h.token_balance(&h.vault).await?, TOTAL);
    Ok(World { h, u, relayer, alice, newcomer, stranger })
}

/// The token's own switch in each case.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Switch {
    /// (a) USDC halted by its pausers.
    Halt,
    /// (c) the vault blocklisted by USDC's blocklister.
    BlockVault,
    /// (d) other code deployed over USDC by the token account's key holder.
    NewCode,
}

impl Switch {
    /// The text a payout part fails with.
    fn refusal(self) -> &'static str {
        match self {
            Switch::Halt => USDC_HALTED,
            Switch::BlockVault => BLOCKED,
            Switch::NewCode => NEW_CODE,
        }
    }
}

/// A full-access key on the token account, put there by a state patch (the harness's USDC account was made the same
/// way, its key dropped): the test then holds what USDC's issuer holds, the key that deploys new code.
async fn token_key_holder(h: &Harness) -> R<Account> {
    let sk = SecretKey::from_random(KeyType::ED25519);
    let send = async || -> R<()> {
        h.worker.patch(&h.token).access_key(sk.public_key(), AccessKey::full_access()).transact().await?;
        Ok(())
    };
    let landed = async || -> R<bool> {
        let q = json!({"request_type": "view_access_key", "finality": "final", "account_id": h.token, "public_key": sk.public_key().to_string()});
        Ok(h.rpc("query", q).await?["result"]["permission"] == json!("FullAccess"))
    };
    h.patch_landed("a key on the token account", send, landed).await?;
    Ok(Account::from_secret_key(h.token.clone(), sk, &h.worker))
}

/// The key holder's DeployContract of `wasm` on the token account, its code hash read back.
async fn deploy_on_token(h: &Harness, holder: &Account, wasm: &[u8]) -> R<()> {
    let r = holder.batch(&h.token).deploy(wasm).transact().await?;
    if !r.is_success() {
        return Err(format!("the key holder's deploy on the token failed: {r:?}").into());
    }
    let want = code_hash(wasm);
    for _ in 0..50 {
        if h.account_view(&h.token, "final").await?["code_hash"] == json!(want) {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    Err(format!("the token's code hash is not {want} at final").into())
}

async fn blocklist(h: &Harness, on: bool) -> R<()> {
    let roles = h.usdc_roles()?;
    let method = if on { "blocklist" } else { "unblocklist" };
    let _ = h.call(&roles.blocklister, &h.token, method, json!({"account_id": h.vault}), NearToken::from_yoctonear(0), Gas::from_tgas(30)).await?;
    assert_eq!(h.view(&h.token, "is_blocklisted", json!({"account_id": h.vault})).await?, json!(on), "{method} the vault");
    Ok(())
}

/// Turns the switch on (`on`) or off. For new code, `holder` deploys the mock token wasm, then the pinned USDC again.
async fn switch(h: &Harness, s: Switch, holder: Option<&Account>, on: bool) -> R<()> {
    match s {
        Switch::Halt => {
            let _ = h.usdc_halt(on).await?;
        }
        Switch::BlockVault => blocklist(h, on).await?,
        Switch::NewCode => {
            let holder = holder.ok_or("new code needs the token's key holder")?;
            if on {
                let mock = wasm_from_env("MOCK_TOKEN_WASM")?;
                deploy_on_token(h, holder, &mock).await?;
                let got = h.account_view(&h.token, "final").await?["code_hash"].clone();
                assert_ne!(got, json!(harness::pin("usdc")?.code_hash), "the token's code hash still reads as the USDC pin");
                println!("NewCode: the token's code hash reads {got} (the mock token's), not the USDC pin");
            } else {
                deploy_on_token(h, holder, &pinned_wasm("usdc")?).await?;
                h.expect_code(&h.token, "usdc").await?;
            }
        }
    }
    println!("{s:?}: switch {}", if on { "on" } else { "off" });
    Ok(())
}

/// The payout part: the one token receipt from the vault holding `ft_transfer`.
fn part<'a>(h: &Harness, o: &'a Outcome) -> R<&'a Receipt> {
    let parts: Vec<&Receipt> = o
        .receipts
        .iter()
        .filter(|r| r.executor == h.token.as_str() && r.predecessor == h.vault.as_str() && r.methods.iter().any(|m| m == "ft_transfer"))
        .collect();
    match parts[..] {
        [p] => Ok(p),
        _ => Err(format!("{} payout parts, want 1: {:#?}", parts.len(), o.receipts.iter().map(Receipt::line).collect::<Vec<_>>()).into()),
    }
}

/// The call (withdraw or ragequit) landed, its payout part failed at the token (with the switch's text), and
/// `on_payout` logged `payout {delivered 0, returned <whole>}`.
fn bounced(h: &Harness, o: &Outcome, s: Switch, method: &str, name: &str, whole: u128) -> R<()> {
    let w = o.calls_exactly(&h.vault, method, 1)?[0];
    assert!(w.ok(), "{name}: {}", w.line());
    let p = part(h, o)?;
    let f = p.failure().ok_or_else(|| format!("{name}: the payout part ran with the switch on: {}", p.line()))?;
    let want = s.refusal();
    assert!(f.contains(want), "{name}: the payout part failed with {f}, want {want:?}");
    let cb = o.calls_exactly(&h.vault, "on_payout", 1)?[0];
    assert!(cb.ok(), "{name}: {}", cb.line());
    let d = data(&cb.logs[0]);
    assert_eq!((d["delivered"].clone(), d["returned"].clone()), (json!("0"), json!(whole.to_string())), "{name}: {}", cb.logs[0]);
    for x in &o.receipts {
        println!("{s:?} {name}: {} (gas burnt {:.3} Tgas)", x.line(), x.gas_burnt as f64 / 1e12);
    }
    Ok(())
}

async fn spend_row(h: &Harness, n: &str) -> R<Value> {
    let rows = h.view(&h.vault, "spends", json!({"from": 0, "limit": 100})).await?;
    Ok(rows.as_array().ok_or("spends: not a list")?.iter().find(|r| r["nullifier_hash"] == n).ok_or_else(|| format!("no spend of {n}"))?.clone())
}

async fn totals(h: &Harness) -> R<Value> {
    h.view(&h.vault, "totals", json!({})).await
}

/// A stranger's settle of `n`: it landed and its receipt logged exactly leaf_inserted state at `state_index`,
/// leaf_inserted label at `label_index` and refund_inserted of `value`; returns the refund_inserted data.
async fn settled(w: &World, s: Switch, n: &str, value: u128, state_index: u64, label_index: u64) -> R<Value> {
    let h = &w.h;
    let o = h.call_outcome(&w.stranger, &h.vault, "settle", json!({"nullifier_hash": n}), NearToken::from_yoctonear(SETTLE_ATTACH), Gas::from_tgas(100)).await?;
    o.expect_all_ok("settle")?;
    let r = o.calls_exactly(&h.vault, "settle", 1)?[0];
    assert_eq!(events(r), ["leaf_inserted", "leaf_inserted", "refund_inserted"], "{:?}", r.logs);
    let (st, lb, note) = (data(&r.logs[0]), data(&r.logs[1]), data(&r.logs[2]));
    assert_eq!((st["tree"].as_str(), st["index"].as_u64()), (Some("state"), Some(state_index)), "{}", r.logs[0]);
    assert_eq!((lb["tree"].as_str(), lb["index"].as_u64()), (Some("label"), Some(label_index)), "{}", r.logs[1]);
    assert_eq!((&note["nullifier_hash"], &note["value"]), (&json!(n), &json!(value.to_string())), "{}", r.logs[2]);
    assert_eq!((&st["leaf"], &lb["leaf"]), (&note["commitment"], &note["label"]), "the inserted leaves are the note's");
    println!("{s:?} settle: {} (gas burnt {:.3} Tgas)", r.line(), r.gas_burnt as f64 / 1e12);
    Ok(note)
}

/// (a), (c), (d): every payout sent with the switch on bounces whole into `refund_pending`, settles into refund notes
/// with the switch still on, and once it is off the vault holds every unit and a refund note withdraws.
async fn payouts_under(s: Switch) -> R<()> {
    let w = deposited().await?;
    let h = &w.h;
    let f = json_of(SPENDS);
    let holder = if s == Switch::NewCode { Some(token_key_holder(h).await?) } else { None };
    let t0 = totals(h).await?;
    assert_eq!(t0, json!({"deposited": "31000000", "spent": "0", "returned": "0"}));
    switch(h, s, holder.as_ref(), true).await?;

    // the two withdrawals and the ragequit, each with exactly its requirement
    let need_fb = row14_need(w.relayer.id().as_str(), w.newcomer.id().as_str(), REGISTER, 2);
    let o = h.call_outcome(&w.relayer, &h.vault, "withdraw", args("fee_bounces"), NearToken::from_yoctonear(need_fb), Gas::from_tgas(300)).await?;
    bounced(h, &o, s, "withdraw", "fee_bounces", 7_000_000)?;
    let need_rb = row14_need(w.relayer.id().as_str(), w.alice.id().as_str(), 0, 2);
    let o = h.call_outcome(&w.relayer, &h.vault, "withdraw", args("recipient_bounces"), NearToken::from_yoctonear(need_rb), Gas::from_tgas(300)).await?;
    bounced(h, &o, s, "withdraw", "recipient_bounces", 2_000_000)?;
    let o = h.call_outcome(&w.u, &h.vault, "ragequit", rq(), NearToken::from_yoctonear(rq_need(w.u.id().as_str())), Gas::from_tgas(300)).await?;
    bounced(h, &o, s, "ragequit", "ragequit", 10_000_000)?;
    let n_rq = rq()["public_signals"][1].as_str().unwrap().to_string();
    for (n, refund) in [(nullifier("fee_bounces"), "7000000"), (nullifier("recipient_bounces"), "2000000"), (n_rq.clone(), "10000000")] {
        let r = spend_row(h, &n).await?;
        assert_eq!((r["status"].as_str(), r["refund_value"].as_str()), (Some("refund_pending"), Some(refund)), "{r}");
    }
    let t1 = json!({"deposited": "31000000", "spent": "19000000", "returned": "19000000"});
    assert_eq!(totals(h).await?, t1, "every payout came back whole");

    // settle all three with the switch still on: settle never calls the token
    let fb = settled(&w, s, &nullifier("fee_bounces"), 7_000_000, 8, 6).await?;
    let rb = settled(&w, s, &nullifier("recipient_bounces"), 2_000_000, 9, 7).await?;
    for (note, want) in [(&fb, &f["refunds"][0]), (&rb, &f["refunds"][1])] {
        assert_eq!((&note["commitment"], &note["label"]), (&want["commitment"], &want["label"]), "a refund note is not the fixture's");
    }
    assert_eq!(h.view(&h.vault, "leaves", json!({"from": 0, "limit": 20})).await?, f["leaves"], "the state tree is not the fixture's");
    assert_eq!(h.view(&h.vault, "labels", json!({"from": 0, "limit": 20})).await?, f["labels"], "the label tree is not the fixture's");
    let rqn = settled(&w, s, &n_rq, 10_000_000, 10, 8).await?;
    let label = rqn["label"].as_str().unwrap();
    let want = commitment_on("10000000", label, rq()["refund_precommitment"].as_str().unwrap());
    assert_eq!(rqn["commitment"], json!(want), "the ragequit's refund note is not Poseidon(value, label, its refund precommitment)");
    for n in [nullifier("fee_bounces"), nullifier("recipient_bounces"), n_rq.clone()] {
        assert_eq!(spend_row(h, &n).await?["status"], "settled");
    }
    assert_eq!(totals(h).await?, t1, "settle moved totals");

    // (c): a deposit call to the blocked vault fails whole at the token, P stays unused
    let p_c = "3333333333";
    if s == Switch::BlockVault {
        h.mint(w.u.id(), AMOUNT).await?;
        let prepay = NearToken::from_yoctonear(PREPAY_BYTES * YOCTO_PER_BYTE);
        let _ = h.call(&w.relayer, &h.vault, "storage_prepay", json!({"precommitment": p_c}), prepay, Gas::from_tgas(30)).await?;
        let a = json!({"receiver_id": h.vault, "amount": AMOUNT.to_string(), "msg": deposit_msg(p_c, w.u.id().as_str())});
        let o = h.call_outcome(&w.u, &h.token, "ft_transfer_call", a, NearToken::from_yoctonear(1), Gas::from_tgas(180)).await?;
        let f = o.failure().ok_or("a deposit call to the blocked vault succeeded")?;
        assert!(f.contains(BLOCKED), "want {BLOCKED:?}, got {f}");
        let _ = o.calls_exactly(&h.vault, "ft_on_transfer", 0)?;
        assert_eq!((h.token_balance(w.u.id()).await?, h.token_balance(&h.vault).await?), (AMOUNT, TOTAL), "a deposit call to the blocked vault moved USDC");
        assert_eq!(h.view(&h.vault, "deposits", json!({"from": 0, "limit": 100})).await?.as_array().map(Vec::len), Some(6), "a record for the blocked deposit");
        println!("BlockVault: u's deposit call fails whole at the token: {}", o.receipts.iter().map(Receipt::line).collect::<Vec<_>>().join(" | "));
    }

    switch(h, s, holder.as_ref(), false).await?;
    // nothing left the vault and nothing reached a payee while the switch was on
    assert_eq!(h.token_balance(&h.vault).await?, TOTAL, "USDC left the vault");
    for a in [&w.newcomer, &w.relayer, &w.alice] {
        assert_eq!(h.token_balance(a.id()).await?, 0, "{} was paid while the switch was on", a.id());
    }
    h.i1().await?;

    // the device spends fee_bounces' refund note, relayed with no fee
    let need_rn = row14_need(w.relayer.id().as_str(), w.alice.id().as_str(), 0, 1);
    let o = h.call_outcome(&w.relayer, &h.vault, "withdraw", args("refund_note"), NearToken::from_yoctonear(need_rn), Gas::from_tgas(300)).await?;
    o.expect_all_ok("the refund note's withdrawal")?;
    let cb = o.calls_exactly(&h.vault, "on_payout", 1)?[0];
    assert_eq!((data(&cb.logs[0])["delivered"].clone(), data(&cb.logs[0])["returned"].clone()), (json!("7000000"), json!("0")), "{}", cb.logs[0]);
    assert_eq!(h.token_balance(w.alice.id()).await?, 7_000_000, "the refund note did not pay");
    assert_eq!(totals(h).await?, json!({"deposited": "31000000", "spent": "26000000", "returned": "19000000"}));
    assert_eq!(h.token_balance(&h.vault).await?, TOTAL - 7_000_000);
    h.i1().await?;

    // (c): the same deposit, on the same P, lands once the vault is unblocked
    if s == Switch::BlockVault {
        let a = json!({"receiver_id": h.vault, "amount": AMOUNT.to_string(), "msg": deposit_msg(p_c, w.u.id().as_str())});
        let o = h.call(&w.u, &h.token, "ft_transfer_call", a, NearToken::from_yoctonear(1), Gas::from_tgas(180)).await?;
        let _ = o.calls_exactly(&h.vault, "ft_on_transfer", 1)?;
        let d = h.view(&h.vault, "deposits", json!({"from": 6, "limit": 10})).await?;
        assert_eq!((d[0]["precommitment"].as_str(), d[0]["value"].as_str()), (Some(p_c), Some("2000000")), "{d}");
        assert_eq!(totals(h).await?["deposited"], json!((TOTAL + AMOUNT).to_string()));
        h.i1().await?;
        println!("BlockVault: unblocked, the same deposit lands on the same P");
    }
    println!("{s:?}: VT-S16 holds\n{}", h.gas_table());
    Ok(())
}

#[tokio::test]
async fn vt_s16_a_halt_before_payouts() -> R<()> {
    payouts_under(Switch::Halt).await
}

#[tokio::test]
async fn vt_s16_c_vault_blocked() -> R<()> {
    payouts_under(Switch::BlockVault).await
}

#[tokio::test]
async fn vt_s16_d_token_code_changed() -> R<()> {
    payouts_under(Switch::NewCode).await
}

/// One receipt of a transaction the test signed itself with near-workspaces' batch, read at FINAL.
struct Rc {
    predecessor: String,
    executor: String,
    methods: Vec<String>,
    status: Value,
    logs: Vec<String>,
    gas_burnt: u64,
}

impl Rc {
    fn failure(&self) -> Option<String> {
        self.status.get("Failure").map(Value::to_string)
    }
    fn line(&self) -> String {
        format!("{} -> {} {:?}: {:.3} Tgas, {}", self.predecessor, self.executor, self.methods, self.gas_burnt as f64 / 1e12, self.status)
    }
}

async fn receipts(h: &Harness, signer: &str, tx_hash: &str) -> R<Vec<Rc>> {
    let v = h.rpc("EXPERIMENTAL_tx_status", json!({"tx_hash": tx_hash, "sender_account_id": signer, "wait_until": "FINAL"})).await?;
    let r = &v["result"];
    if r["final_execution_status"] != "FINAL" {
        return Err(format!("tx {tx_hash} at FINAL: {v}").into());
    }
    let methods = |actions: &Value| -> Vec<String> {
        actions.as_array().into_iter().flatten().filter_map(|a| a["FunctionCall"]["method_name"].as_str().map(str::to_string)).collect()
    };
    let mut origin = std::collections::BTreeMap::new();
    if let Some(first) = r["transaction_outcome"]["outcome"]["receipt_ids"][0].as_str() {
        origin.insert(first.to_string(), (r["transaction"]["signer_id"].as_str().unwrap_or_default().to_string(), methods(&r["transaction"]["actions"])));
    }
    for rc in r["receipts"].as_array().into_iter().flatten() {
        let id = rc["receipt_id"].as_str().unwrap_or_default().to_string();
        origin.insert(id, (rc["predecessor_id"].as_str().unwrap_or_default().to_string(), methods(&rc["receipt"]["Action"]["actions"])));
    }
    let mut out = vec![];
    for ro in r["receipts_outcome"].as_array().into_iter().flatten() {
        let (predecessor, methods) = origin.get(ro["id"].as_str().unwrap_or_default()).cloned().unwrap_or_default();
        let o = &ro["outcome"];
        out.push(Rc {
            predecessor,
            executor: o["executor_id"].as_str().unwrap_or_default().to_string(),
            methods,
            status: o["status"].clone(),
            logs: o["logs"].as_array().into_iter().flatten().filter_map(|l| l.as_str().map(str::to_string)).collect(),
            gas_burnt: o["gas_burnt"].as_u64().unwrap_or_default(),
        });
    }
    Ok(out)
}

/// The receipts on `executor` holding a call to `method`: exactly one.
fn one<'a>(rs: &'a [Rc], executor: &str, method: &str) -> R<&'a Rc> {
    let found: Vec<&Rc> = rs.iter().filter(|r| r.executor == executor && r.methods.iter().any(|m| m == method)).collect();
    match found[..] {
        [r] => Ok(r),
        _ => Err(format!("{executor}::{method}: {} receipts, want 1: {:#?}", found.len(), rs.iter().map(Rc::line).collect::<Vec<_>>()).into()),
    }
}

/// USDC's second pauser, holding USDC, sends one transaction to the token: [ft_transfer_call(vault, AMOUNT, a deposit
/// on `p` naming itself), execute_multisig_request(a `Pause` both pausers approved)]. The move runs, then the halt, in
/// one receipt; `ft_on_transfer` and the token's resolve run after it, on a halted token. Returns every receipt.
async fn halt_inside_deposit(h: &Harness, p: &str) -> R<Vec<Rc>> {
    let roles = h.usdc_roles()?;
    let (zero, gas) = (NearToken::from_yoctonear(0), Gas::from_tgas(100));
    let rid = h.view(&h.token, "get_next_multisig_request_id", json!({})).await?;
    let _ = h.call(&roles.pausers[0], &h.token, "create_multisig_request", json!({"action": "Pause"}), zero, gas).await?;
    for a in &roles.pausers {
        let _ = h.call(a, &h.token, "approve_multisig_request", json!({"request_id": rid}), zero, gas).await?;
    }
    let pauser = &roles.pausers[1];
    let a = json!({"receiver_id": h.vault, "amount": AMOUNT.to_string(), "msg": deposit_msg(p, pauser.id().as_str())});
    let result = pauser
        .batch(&h.token)
        .call(Function::new("ft_transfer_call").args_json(a).deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(180)))
        .call(Function::new("execute_multisig_request").args_json(json!({"request_id": rid})).deposit(zero).gas(gas))
        .transact()
        .await?;
    let rs = receipts(h, pauser.id().as_str(), &result.outcome().transaction_hash.to_string()).await?;
    for r in &rs {
        println!("halt inside the deposit on {p}: {}", r.line());
    }
    let first = rs.first().ok_or("no receipts")?;
    assert_eq!((first.executor.as_str(), first.methods.clone()), (h.token.as_str(), vec!["ft_transfer_call".to_string(), "execute_multisig_request".to_string()]));
    assert!(first.failure().is_none(), "the move and the halt did not land: {}", first.line());
    assert!(first.logs.iter().any(|l| l.contains("x-fiat-token") && l.contains(r#""event":"paused""#)), "no paused event: {:?}", first.logs);
    Ok(rs)
}

/// The vault's USDC less the sum its totals hold: what sits in the vault with no note.
async fn unnoted(h: &Harness) -> R<i128> {
    let t = totals(h).await?;
    let n = |k: &str| -> i128 { t[k].as_str().unwrap().parse().unwrap() };
    Ok(h.token_balance(&h.vault).await? as i128 - (n("deposited") - n("spent") + n("returned")))
}

async fn supply(h: &Harness) -> R<u128> {
    Ok(h.view(&h.token, "ft_total_supply", json!({})).await?.as_str().ok_or("ft_total_supply: not a string")?.parse()?)
}

#[tokio::test]
async fn vt_s16_b_halt_between_move_and_resolve() -> R<()> {
    let h = Harness::with_vault_and(TokenKind::Usdc).await?;
    let relayer = h.account("relayer", 50).await?;
    let pauser = h.usdc_roles()?.pausers[1].clone();
    let held = 3 * AMOUNT;
    h.mint(pauser.id(), held).await?;
    let total = supply(&h).await?;
    let prepay = NearToken::from_yoctonear(PREPAY_BYTES * YOCTO_PER_BYTE);

    // 1. a deposit the vault accepts: the note lands, the halt costs nothing
    let p1 = "1111111111";
    let _ = h.call(&relayer, &h.vault, "storage_prepay", json!({"precommitment": p1}), prepay, Gas::from_tgas(30)).await?;
    let rs = halt_inside_deposit(&h, p1).await?;
    let on = one(&rs, h.vault.as_str(), "ft_on_transfer")?;
    assert!(on.failure().is_none(), "the vault refused the prepaid deposit: {}", on.line());
    let resolve = one(&rs, h.token.as_str(), "ft_resolve_transfer")?;
    let f = resolve.failure().ok_or_else(|| format!("the halted token's resolve ran: {}", resolve.line()))?;
    assert!(f.contains(USDC_HALTED), "want {USDC_HALTED:?}, got {f}");
    println!("1. accepted, then halted: the resolve fails with nothing to give back: {}", resolve.line());
    let _ = h.usdc_halt(false).await?;
    let d = deposits(&h).await?;
    assert_eq!((d.len(), d[0]["precommitment"].as_str(), d[0]["value"].as_str(), d[0]["depositor"].as_str()), (1, Some(p1), Some("2000000"), Some(pauser.id().as_str())), "{d:?}");
    assert_eq!(totals(&h).await?, json!({"deposited": "2000000", "spent": "0", "returned": "0"}));
    assert_eq!((h.token_balance(pauser.id()).await?, h.token_balance(&h.vault).await?), (held - AMOUNT, AMOUNT));
    h.i1().await?;

    // 2. a deposit the vault refuses (no prepay): the resolve's refund stops on the halt, the amount stays with no note
    let p2 = "2222222222";
    // NEAR on the vault, as prepaid deposits leave it: a vault that skipped row 6 could then pay for the record
    let stranger = h.account("stranger", 10).await?;
    let sent = stranger.transfer_near(&h.vault, NearToken::from_near(1)).await?;
    if !sent.is_success() {
        return Err(format!("the stranger's 1 N to the vault: {sent:?}").into());
    }
    let (state0, usage0) = (vault_state(&h).await?, h.account_view(&h.vault, "final").await?["storage_usage"].clone());
    let rs = halt_inside_deposit(&h, p2).await?;
    let on = one(&rs, h.vault.as_str(), "ft_on_transfer")?;
    let f = on.failure().ok_or_else(|| format!("the vault accepted a deposit with no prepay: {}", on.line()))?;
    assert!(f.contains("NoPrepay"), "want NoPrepay, got {f}");
    let resolve = one(&rs, h.token.as_str(), "ft_resolve_transfer")?;
    let f = resolve.failure().ok_or_else(|| format!("the halted token's resolve refunded: {}", resolve.line()))?;
    assert!(f.contains(USDC_HALTED), "want {USDC_HALTED:?}, got {f}");
    let _ = h.usdc_halt(false).await?;
    h.wait_final(&h.vault).await?;
    assert_eq!(vault_state(&h).await?, state0, "the refused deposit wrote a state byte");
    assert_eq!(h.account_view(&h.vault, "final").await?["storage_usage"], usage0);
    assert_eq!(deposits(&h).await?.len(), 1, "a record for the refused deposit");
    assert_eq!(totals(&h).await?, json!({"deposited": "2000000", "spent": "0", "returned": "0"}), "the refused deposit moved totals");
    assert_eq!((h.token_balance(pauser.id()).await?, h.token_balance(&h.vault).await?), (held - 2 * AMOUNT, 2 * AMOUNT), "the loss is not the amount");
    assert_eq!(unnoted(&h).await?, AMOUNT as i128, "the vault's USDC less its totals is not the lost amount");
    assert_eq!(supply(&h).await?, total, "the supply moved");
    println!("2. refused, then halted: {AMOUNT} sits in the vault with no note (M1's named loss); totals and records unchanged");

    // 3. the same P, prepaid, lands after the unhalt: P stayed unused, and the loss stays exactly the amount
    let _ = h.call(&relayer, &h.vault, "storage_prepay", json!({"precommitment": p2}), prepay, Gas::from_tgas(30)).await?;
    let a = json!({"receiver_id": h.vault, "amount": AMOUNT.to_string(), "msg": deposit_msg(p2, pauser.id().as_str())});
    let o = h.call(&pauser, &h.token, "ft_transfer_call", a, NearToken::from_yoctonear(1), Gas::from_tgas(180)).await?;
    let _ = o.calls_exactly(&h.vault, "ft_on_transfer", 1)?;
    let d = deposits(&h).await?;
    assert_eq!((d.len(), d[1]["precommitment"].as_str(), d[1]["value"].as_str()), (2, Some(p2), Some("2000000")), "{d:?}");
    assert_eq!(totals(&h).await?, json!({"deposited": "4000000", "spent": "0", "returned": "0"}));
    assert_eq!((h.token_balance(pauser.id()).await?, h.token_balance(&h.vault).await?), (0, 3 * AMOUNT));
    assert_eq!(unnoted(&h).await?, AMOUNT as i128);
    println!("3. the same P lands after the unhalt; the vault holds {} with {AMOUNT} unnoted\n{}", 3 * AMOUNT, h.gas_table());
    Ok(())
}

/// Every deposit record, from 0.
async fn deposits(h: &Harness) -> R<Vec<Value>> {
    Ok(h.view(&h.vault, "deposits", json!({"from": 0, "limit": 100})).await?.as_array().cloned().unwrap_or_default())
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
