// SPDX-License-Identifier: Apache-2.0
//! VT-S17 (vault.md 5, V:1144; 2.5.4, "What is left"), in near-sandbox 2.13.4 on the mock token and on the real USDC
//! wasm at TOKEN. Runs only with `--features sandbox`, through tests/harness/run.sh
//! (`contracts/vault/tests/harness/run.sh --test s17`); a plain `cargo test` builds this file empty.
//!
//! The test build: the vault's own code with the Cargo feature `test-on-payout-out-of-gas`, whose `on_payout` does all
//! its work (the record rewritten, `totals` raised, the `payout` event logged), then logs `OUT_OF_GAS_BUILD_MARK`
//! (src/payout.rs) and burns gas until it runs out: the gas runs out last, as it would for a callback whose static a
//! NEAR re-pricing outgrew. run.sh builds it beside the release build and names it in `VAULT_OOG_WASM`.
//!
//! From the six deposits of tests/fixtures/withdraw-spends.json and two proofs of tests/fixtures/settle-spends.json,
//! two payouts that fail, relayed: `fee_bounces` (the fee recipient not registered on the token) and
//! `recipient_bounces` (the recipient not registered). Each runs twice per token, in a fresh sandbox each time:
//! 1. the release build (`VAULT_WASM`): each callback lands `refund_pending`; its gas burnt is the measured burn, and
//!    the static `GAS_ON_PAYOUT_TGAS` must be at least six times the largest burn. Both numbers are printed.
//! 2. the test build: each callback fails with "Exceeded the prepaid gas", its logs exactly the `payout` event and the
//!    mark (NEAR keeps a failed receipt's logs). NEAR drops the writes it made, so the state is the residual 2.5.4
//!    names: the spend stays `in_flight` with `refund_value` 0 and no refund leaf, `totals.returned` stays 0, the
//!    bounced parts sit in the vault's token balance with no note, `settle` is refused with `SpendInFlight` and changes
//!    nothing, and a stranger cannot run `on_payout` (`#[private]`), so nothing moves the record on. The logged event
//!    misleads no one: every reader takes the spend's status from the `spends` view, never from an event
//!    (packages/kit/src/vault/shapes.ts l.357-358: events count only from successful receipts;
//!    packages/wallet/src/notes/restore.ts l.309; apps/helper/src/withdraw/send.ts l.407).
//! 3. the top-up 2.5.4 names (a storage re-pricing is met by anyone's plain Transfer to the vault): a stranger's
//!    Transfer raises the vault's NEAR by exactly its amount, with the state, the storage use and `keys: []` unchanged.
//!
//! And the refusal: contracts/vault/scripts/deploy.mjs `deployProblems` (the same rules every deploy and the vault's
//! live check apply) refuses the real test build (`testBuild`) and passes the release build.
#![cfg(feature = "sandbox")]

mod harness;

use harness::{wasm_from_env, Harness, Outcome, Receipt, TokenKind, R, TGAS, YOCTO_PER_BYTE};
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use std::path::PathBuf;
use std::process::Command;

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
/// The production static of the callback (src/constants.rs).
const STATIC_TGAS: u64 = blindfill_vault::constants::GAS_ON_PAYOUT_TGAS;
/// VT-S17's bound: the static is at least this many times the measured burn (vault.md 5).
const MARGIN: u64 = 6;
/// The test build's mark; scripts/live-checks/vault-skeleton.mjs TEST_BUILD_MARK is the same text (its test reads
/// src/payout.rs).
const MARK: &str = "blindfill-vault test build: on_payout runs out of gas";
/// nearcore's text for a function call that ran out of its gas.
const OUT_OF_GAS: &str = "Exceeded the prepaid gas";
/// (name, the part that bounces in units, the part delivered) of each payout, in the order they run.
const PAYOUTS: [(&str, u128, u128); 2] = [("fee_bounces", 100_000, 6_900_000), ("recipient_bounces", 1_500_000, 500_000)];

#[derive(Clone, Copy, Debug, PartialEq)]
enum Build {
    Release,
    OutOfGas,
}

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

/// The `payout` event line the callback of `name` logs (src/events.rs, the kit's frozen shape).
fn payout_event(name: &str, delivered: u128, returned: u128) -> String {
    format!(
        r#"EVENT_JSON:{{"standard":"blindfill-vault","version":"1.0.0","event":"payout","data":[{{"nullifier_hash":"{}","delivered":"{delivered}","returned":"{returned}"}}]}}"#,
        nullifier(name)
    )
}

/// Row 14's requirement for a spend whose payer and recipient ids have these lengths, when no tree grows a level.
fn row14_need(payer: &str, recipient: &str, register_deposit: u128, transfers: u128) -> u128 {
    let bytes = SPEND_BYTES - (64 - payer.len() as u128) - (64 - recipient.len() as u128);
    (bytes + REFUND_RESERVE_BYTES) * YOCTO_PER_BYTE + register_deposit + transfers
}

/// A fresh sandbox with `build` deployed by the 2.8 recipe, `kind`'s token at TOKEN with the vault registered, and the
/// six notes deposited through `ft_on_transfer` (as tests/settle.rs does); the relayer and alice exist and are not
/// registered on the token.
async fn deposited(kind: TokenKind, build: Build) -> R<(Harness, Account, Account)> {
    let mut h = Harness::start().await?;
    if build == Build::OutOfGas {
        h.vault_wasm = wasm_from_env("VAULT_OOG_WASM")?;
    }
    let _ = h.deploy_vault().await?;
    match kind {
        TokenKind::Mock => h.deploy_mock_token().await?,
        TokenKind::Usdc => h.deploy_usdc().await?,
    }
    let _ = h.storage_deposit(&h.root, &h.vault).await?;
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

/// The vault's state, storage use and token balance: what a refused call must leave as it was.
async fn snapshot(h: &Harness) -> R<(Vec<(String, String)>, Value, u128)> {
    h.wait_final(&h.vault).await?;
    let used = h.account_view(&h.vault, "final").await?["storage_usage"].clone();
    Ok((vault_state(h).await?, used, h.token_balance(&h.vault).await?))
}

/// Both payouts, relayed by `relayer`: fee_bounces to a registered newcomer with `register_deposit` > 0 and the fee
/// recipient (the relayer) not registered; then, the relayer registered, recipient_bounces to alice, not registered.
/// Returns each withdrawal's outcome.
async fn pay_both(h: &Harness, relayer: &Account, alice: &Account) -> R<Vec<Outcome>> {
    let newcomer = h.account("newcomer", 5).await?;
    let _ = h.storage_deposit(&h.root, newcomer.id()).await?;
    let need = row14_need(relayer.id().as_str(), newcomer.id().as_str(), REGISTER, 2);
    let fb = h.call_outcome(relayer, &h.vault, "withdraw", args("fee_bounces"), NearToken::from_yoctonear(need), Gas::from_tgas(300)).await?;
    assert_eq!((h.token_balance(newcomer.id()).await?, h.token_balance(relayer.id()).await?), (6_900_000, 0), "fee_bounces' parts");
    let _ = h.storage_deposit(&h.root, relayer.id()).await?;
    let need = row14_need(relayer.id().as_str(), alice.id().as_str(), 0, 2);
    let rb = h.call_outcome(relayer, &h.vault, "withdraw", args("recipient_bounces"), NearToken::from_yoctonear(need), Gas::from_tgas(300)).await?;
    assert_eq!((h.token_balance(alice.id()).await?, h.token_balance(relayer.id()).await?), (0, 500_000), "recipient_bounces' parts");
    Ok(vec![fb, rb])
}

/// The withdrawal's own receipt landed; its one `on_payout` receipt, as it ran.
fn callback<'a>(h: &Harness, o: &'a Outcome, name: &str) -> R<&'a Receipt> {
    let w = o.calls_exactly(&h.vault, "withdraw", 1)?[0];
    assert!(w.ok(), "{name}: the withdrawal itself failed: {}", w.line());
    let cb = o.calls_exactly(&h.vault, "on_payout", 1)?[0];
    println!("{name}: {}\n{name}: {}", w.line(), cb.line());
    Ok(cb)
}

/// The release build: each callback lands `refund_pending` with the bounced part; returns the largest gas burnt.
async fn release(kind: TokenKind) -> R<u64> {
    let (h, relayer, alice) = deposited(kind, Build::Release).await?;
    let outcomes = pay_both(&h, &relayer, &alice).await?;
    let mut burns = vec![];
    for ((name, bounced, _), o) in PAYOUTS.iter().zip(&outcomes) {
        let cb = callback(&h, o, name)?;
        assert!(cb.ok(), "{name}: the release build's callback failed: {}", cb.line());
        assert!(!cb.logs.iter().any(|l| l.contains(MARK)), "{name}: the release build logged the test mark");
        let r = spend_row(&h, name).await?;
        assert_eq!((r["status"].as_str(), r["refund_value"].as_str()), (Some("refund_pending"), Some(bounced.to_string().as_str())), "{name}: {r}");
        burns.push(cb.gas_burnt);
    }
    assert_eq!(h.view(&h.vault, "totals", json!({})).await?, json!({"deposited": "31000000", "spent": "9000000", "returned": "1600000"}));
    h.i1().await?;
    let max = *burns.iter().max().unwrap();
    println!("{kind:?} release build: on_payout burnt {} Tgas (fee_bounces, recipient_bounces)", burns.iter().map(|b| format!("{:.3}", *b as f64 / TGAS)).collect::<Vec<_>>().join(", "));
    Ok(max)
}

/// The test build: each callback runs out of gas, and the state is the residual 2.5.4 names.
async fn out_of_gas(kind: TokenKind) -> R<()> {
    let (h, relayer, alice) = deposited(kind, Build::OutOfGas).await?;
    let stranger = h.account("stranger", 50).await?;
    let outcomes = pay_both(&h, &relayer, &alice).await?;
    let fixture = json_of(DEPOSITS);
    for ((name, bounced, delivered), o) in PAYOUTS.iter().zip(&outcomes) {
        let cb = callback(&h, o, name)?;
        let f = cb.failure().ok_or_else(|| format!("{name}: the test build's callback did not fail: {}", cb.line()))?;
        assert!(f.contains(OUT_OF_GAS), "{name}: the callback failed, but not out of gas: {f}");
        // the callback did all its work (its event is logged) before the gas ran out: what follows proves NEAR dropped it
        assert_eq!(cb.logs, [payout_event(name, *delivered, *bounced), MARK.to_string()], "{name}: the failed callback's logs");
        println!("{kind:?} test build: {name}'s on_payout burnt {:.3} Tgas and ran out of gas after logging {:?}", cb.gas_burnt as f64 / TGAS, cb.logs);
    }
    // the state left, read after every receipt is final: NEAR runs no failed callback again
    h.wait_final(&h.vault).await?;
    for (name, _, _) in PAYOUTS {
        let r = spend_row(&h, name).await?;
        assert_eq!(
            (r["status"].as_str(), r["refund_value"].as_str(), r["refund_leaf_index"].as_u64(), r["reserve"].as_str()),
            (Some("in_flight"), Some("0"), Some(0), Some((REFUND_RESERVE_BYTES * YOCTO_PER_BYTE).to_string().as_str())),
            "{name}: {r}"
        );
        println!("{kind:?} test build: {name}'s spend row {r}");
    }
    let totals = h.view(&h.vault, "totals", json!({})).await?;
    assert_eq!(totals, json!({"deposited": "31000000", "spent": "9000000", "returned": "0"}), "{totals}");
    // no note: the state tree holds the six deposits and the two change leaves only, the label tree the six labels
    let st = h.view(&h.vault, "state_tree", json!({})).await?;
    assert_eq!(st["size"].as_u64(), Some(8), "{st}");
    let lt = h.view(&h.vault, "label_tree", json!({})).await?;
    assert_eq!(lt["size"].as_u64(), Some(6), "{lt}");
    assert_eq!(h.view(&h.vault, "leaves", json!({"from": 0, "limit": 6})).await?, fixture["leaves"], "the deposits' leaves moved");
    // the bounced parts are in the vault with no note: its balance is what the notes hold plus 1,600,000
    let held = h.token_balance(&h.vault).await?;
    assert_eq!(held, 31_000_000 - 6_900_000 - 500_000);
    println!("{kind:?} test build: the vault holds {held}, the notes {}, stranded with no note {}", 31_000_000 - 9_000_000, held - 22_000_000);

    // settle is refused with SpendInFlight, with the attachment a growing tree would need, and changes nothing
    let attach = (REFUND_RESERVE_BYTES + LEVEL_BYTES) * YOCTO_PER_BYTE;
    for (name, _, _) in PAYOUTS {
        let before = snapshot(&h).await?;
        let o = h.call_outcome(&stranger, &h.vault, "settle", json!({"nullifier_hash": nullifier(name)}), NearToken::from_yoctonear(attach), Gas::from_tgas(100)).await?;
        let r = o.calls_exactly(&h.vault, "settle", 1)?[0];
        let f = r.failure().ok_or_else(|| format!("{name}: settled an in_flight spend: {}", r.line()))?;
        assert!(f.contains("SpendInFlight"), "{name}: want SpendInFlight, got {f}");
        assert!(r.logs.is_empty(), "{name}: a refused settle logged {:?}", r.logs);
        assert_eq!(snapshot(&h).await?, before, "{name}: the refused settle changed the vault");
        println!("{kind:?} test build: settle {name} refused: {}", r.line());
    }
    // no one else can run the callback: on_payout is #[private]
    let (name, bounced, delivered) = PAYOUTS[1];
    let o = h
        .call_outcome(&stranger, &h.vault, "on_payout", json!({"spend_index": 1, "to_recipient": bounced.to_string(), "fee": delivered.to_string()}), NearToken::from_yoctonear(0), Gas::from_tgas(100))
        .await?;
    let r = o.calls_exactly(&h.vault, "on_payout", 1)?[0];
    let f = r.failure().ok_or_else(|| format!("a stranger ran on_payout: {}", r.line()))?;
    assert!(f.contains("is private"), "{name}: a stranger's on_payout: {f}");

    // the top-up: anyone's plain Transfer raises the vault's NEAR by exactly its amount and changes nothing else
    let top_up = NearToken::from_millinear(250);
    let (before, near0, keys0) = (snapshot(&h).await?, h.near_balance(&h.vault).await?, h.access_keys(&h.vault, "final").await?);
    assert!(keys0.is_empty(), "the vault has keys: {keys0:?}");
    let t = stranger.transfer_near(&h.vault, top_up).await?;
    assert!(t.is_success(), "the top-up failed: {t:?}");
    let tx = t.outcome().transaction_hash.to_string();
    let v = h.rpc("EXPERIMENTAL_tx_status", json!({"tx_hash": tx, "sender_account_id": stranger.id(), "wait_until": "FINAL"})).await?;
    assert!(v["result"]["final_execution_status"] == "FINAL", "the top-up is not final: {v}");
    let near1 = h.near_balance(&h.vault).await?;
    assert_eq!(near1 - near0, top_up.as_yoctonear(), "the vault's NEAR did not rise by exactly the top-up");
    assert_eq!(snapshot(&h).await?, before, "the top-up changed the vault's state, storage use or token balance");
    assert_eq!(h.access_keys(&h.vault, "final").await?, Vec::<Value>::new(), "the vault has keys after the top-up");
    println!(
        "{kind:?} test build: top-up: a stranger's Transfer of {} yocto raised the vault's NEAR from {near0} to {near1}, exactly; state, storage use and keys [] unchanged",
        top_up.as_yoctonear()
    );
    println!("{kind:?} test build: VT-S17 holds\n{}", h.gas_table());
    h.i1().await?;
    Ok(())
}

async fn vt_s17(kind: TokenKind) -> R<()> {
    let burn = release(kind).await?;
    let static_gas = Gas::from_tgas(STATIC_TGAS).as_gas();
    // NEAR hands the callback a share of the unused gas by weight (src/promise.rs WEIGHT), so it ran with more than its
    // static; the static alone is the floor it is guaranteed, the worst case, and the bound is checked on it
    println!(
        "{kind:?} VT-S17: on_payout static {STATIC_TGAS} Tgas (the guaranteed floor, the worst case: the callback also gets a share of the unused gas by weight), measured burn {:.3} Tgas (the larger of the two refund_pending callbacks), static / burn = {:.2}, bound {MARGIN} checked on the static floor",
        burn as f64 / TGAS,
        static_gas as f64 / burn as f64
    );
    assert!(static_gas >= MARGIN * burn, "the static {STATIC_TGAS} Tgas is under {MARGIN} x the burn {:.3} Tgas", burn as f64 / TGAS);
    out_of_gas(kind).await
}

#[tokio::test]
async fn vt_s17_mock() -> R<()> {
    vt_s17(TokenKind::Mock).await
}

#[tokio::test]
async fn vt_s17_usdc() -> R<()> {
    vt_s17(TokenKind::Usdc).await
}

/// deploy.mjs `deployProblems(wasm, "sandbox")` on the wasm `var` names, as node prints it. deploy.mjs is only
/// imported, never run: its entry guard runs main() when `process.argv[1]` is its own path, and `node -e <code> <args>`
/// makes the first arg `process.argv[1]`, so both paths go in the environment and node gets no argument.
fn deploy_problems(var: &str) -> R<Vec<String>> {
    let file = std::env::var(var).map_err(|_| format!("{var} is not set: run the sandbox tests through tests/harness/run.sh"))?;
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scripts/deploy.mjs");
    let code = r#"const { pathToFileURL } = await import("node:url");
const { readFileSync } = await import("node:fs");
const { deployProblems } = await import(pathToFileURL(process.env.S17_DEPLOY_SCRIPT).href);
console.log(JSON.stringify(deployProblems(readFileSync(process.env.S17_WASM), "sandbox")));"#;
    let out = Command::new("node").args(["--input-type=module", "-e", code]).env("S17_DEPLOY_SCRIPT", &script).env("S17_WASM", &file).output()?;
    if !out.status.success() {
        return Err(format!("node: {}", String::from_utf8_lossy(&out.stderr)).into());
    }
    let p: Vec<String> = serde_json::from_slice(&out.stdout)?;
    println!("deployProblems({var} = {file}): {p:?}");
    Ok(p)
}

#[test]
fn vt_s17_the_deploy_refuses_the_out_of_gas_build_and_passes_the_release_build() -> R<()> {
    let oog = deploy_problems("VAULT_OOG_WASM")?;
    assert_eq!(oog.len(), 1, "{oog:?}");
    assert!(oog[0].starts_with("testBuild ") && oog[0].ends_with(MARK), "{oog:?}");
    assert_eq!(deploy_problems("VAULT_WASM")?, Vec::<String>::new());
    Ok(())
}
