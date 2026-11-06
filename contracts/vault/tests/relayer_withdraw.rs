// SPDX-License-Identifier: Apache-2.0
//! The withdrawal relayer's send (apps/helper/src/withdraw/send.ts; markets paper H3.1, H3.4 checks 7-10, the send
//! record, the settle) against the real vault and the mock token in near-sandbox 2.13.4. Runs only with
//! `--features sandbox`, through tests/harness/run.sh (`contracts/vault/tests/harness/run.sh --test relayer_withdraw`);
//! a plain `cargo test` never builds it.
//!
//! The world is settle.rs's: the six notes of tests/fixtures/withdraw-spends.json deposited through `ft_on_transfer`,
//! the relayer `relayer.test.near` (the proofs' fee_recipient) with a full-access key, alice. The proofs are that
//! fixture's real withdraw proofs. The relayer is driven only through its CLI, `node apps/helper/test/withdraw-send/carry.ts`,
//! one new process per run (a restart on the same stores); check 10's watch is the CLI's stand-in and fee_min is 0
//! (the sandbox has no price pool). Every outcome is read on chain through the harness's RPC, never taken from the
//! CLI's answer alone.
//!
//! 1. Check 7: short_registration (fresh.test.near, unregistered, register_deposit 1) and same_call (alice, not yet
//!    registered, register_deposit 0): 400 register_deposit_wrong each; the relayer's key nonce unmoved.
//! 2. alice registered. Check 10: the watch halted: 503 token_halted; nonce unmoved, no record.
//! 3. Check 7b (card vault-review-fixes-1, review F-1): the relayer's fee account not registered on the token, then
//!    registered (by alice) but blocklisted: same_call is 503 relayer_low each time, its log line naming the fee
//!    account, nonce unmoved, no record. Then ready: same_call carried, 200 {tx_hash, submitted}; the outcome rounds
//!    read it from blocks as succeeded; one payout receipt pays alice the withdrawal less the fee and the relayer the
//!    fee; settled with refund_value 0.
//! 4. A restart: same_call again: 400 spent, nothing signed.
//! 5. same_nullifier_a and same_nullifier_b (one nullifier, two proofs) at once: one 200, the other 400 in_flight; one
//!    spend on chain; paid, settled with 0 attached, the reserve back to the relayer.
//! 6. new_account (newcomer.test.near, unregistered, register_deposit the token's minimum): 200, paid, settled; the
//!    relayer holds the 100,000 fee.
//! 7. A payout that fails on chain (the review's coverage of refund_pending): the mock token fails every ft_transfer
//!    to alice, so one_block_a's one payout receipt fails whole (review A-01): refund_pending with refund_value the
//!    whole withdrawal (4,000,000), alice paid nothing, and the relayer's settle attaches 148 B x 1e19 (the refund
//!    note's tree may grow) and settles it, writing the refund note.
//! Prints each relayer transaction's receipts and the relayer's NEAR before and after.
#![cfg(feature = "sandbox")]

mod harness;

use harness::{Harness, TokenKind, R, YOCTO_PER_BYTE};
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const DEPOSITS: &str = include_str!("fixtures/withdraw-spends.json");
const PREPAY_BYTES: u128 = 904;

fn json_of(s: &str) -> Value {
    serde_json::from_str(s).unwrap()
}

fn spend(name: &str) -> Value {
    let f = json_of(DEPOSITS);
    f["spends"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap().clone()
}

/// The /v1/withdraw body for the fixture's spend `name`: a plain send to a named account (fund_recipient false), or,
/// for `fund:<name>`, with fund_recipient true as the kit sends it for an A.
fn request(name: &str, token: &str) -> Value {
    let (fund, name) = match name.strip_prefix("fund:") {
        Some(n) => (true, n),
        None => (false, name),
    };
    let s = spend(name);
    json!({"withdrawal": s["withdrawal"], "proof": s["proof"], "public_signals": s["public_signals"], "fund_recipient": fund, "token": token})
}

fn nullifier(name: &str) -> String {
    spend(name)["public_signals"][1].as_str().unwrap().to_string()
}

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// `node <CLI>` with `input` on stdin; its one stdout line as JSON.
async fn node(input: Value) -> R<Value> {
    let script = repo().join("apps/helper/test/withdraw-send/carry.ts");
    if !script.is_file() {
        return Err(format!("{}: not found (the relayer's CLI)", script.display()).into());
    }
    let out = tokio::task::spawn_blocking(move || -> Result<std::process::Output, String> {
        let mut child = Command::new("node")
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("node {}: {e}", script.display()))?;
        child.stdin.take().ok_or("no stdin")?.write_all(input.to_string().as_bytes()).map_err(|e| e.to_string())?;
        child.wait_with_output().map_err(|e| e.to_string())
    })
    .await??;
    let (stdout, stderr) = (String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if !out.status.success() {
        return Err(format!("node exited {:?}; stderr: {stderr}", out.status.code()).into());
    }
    let lines: Vec<&str> = stdout.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.len() != 1 {
        return Err(format!("node printed {} lines, want one: {stdout}; stderr: {stderr}", lines.len()).into());
    }
    Ok(serde_json::from_str(lines[0])?)
}

struct World {
    h: Harness,
    relayer: Account,
    alice: Account,
    dir: PathBuf,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl World {
    /// settle.rs's world: the six notes deposited by u, the relayer and alice not registered on the token.
    async fn new() -> R<Self> {
        let h = Harness::with_vault_and(TokenKind::Mock).await?;
        let f = json_of(DEPOSITS);
        let u = h.account("u", 50).await?;
        let relayer = h.account("relayer", 50).await?;
        let alice = h.account("alice", 50).await?;
        assert_eq!((relayer.id().as_str(), alice.id().as_str(), h.vault.as_str()), ("relayer.test.near", "alice.test.near", "vault.test.near"), "the fixture's accounts");
        let total: u128 = f["deposited"].as_str().unwrap().parse()?;
        h.mint(u.id(), total).await?;
        let prepay = NearToken::from_yoctonear(PREPAY_BYTES * YOCTO_PER_BYTE);
        for (p, value) in f["precommitments"].as_array().unwrap().iter().zip(f["values"].as_array().unwrap()) {
            let p = p.as_str().unwrap();
            let _ = h.call(&u, &h.vault, "storage_prepay", json!({"precommitment": p}), prepay, Gas::from_tgas(30)).await?;
            let msg = format!(r#"{{"precommitment":"{p}","depositor":"{}"}}"#, u.id());
            let o = h
                .call(&u, &h.token, "ft_transfer_call", json!({"receiver_id": h.vault, "amount": value, "msg": msg}), NearToken::from_yoctonear(1), Gas::from_tgas(180))
                .await?;
            let _ = o.calls_exactly(&h.vault, "ft_on_transfer", 1)?;
        }
        assert_eq!(h.view(&h.vault, "leaves", json!({"from": 0, "limit": 10})).await?, f["leaves"], "the deposits' leaves are the fixture's");
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos();
        let dir = std::env::temp_dir().join(format!("relayer-withdraw-{}-{t}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        Ok(Self { h, relayer, alice, dir })
    }

    /// One CLI run (a restart): `requests` at once, then up to `rounds` outcome rounds a second apart.
    async fn carry(&self, status: &[&str], requests: &[&str], rounds: u32) -> R<Value> {
        let rpc = self.h.worker.rpc_addr();
        let reqs: Vec<Value> = requests.iter().map(|n| request(n, self.h.token.as_str())).collect();
        let v = node(json!({
            "rpc": [rpc, rpc], "vault": self.h.vault, "token": self.h.token, "scope": json_of(DEPOSITS)["scope"],
            "relayer": {"account_id": self.relayer.id(), "secret_key": self.relayer.secret_key().to_string()},
            "store": self.dir.join("send"), "nonces": self.dir.join("nonces"),
            "status": status, "requests": reqs, "rounds": rounds, "roundMs": 1000,
        }))
        .await?;
        println!("carry {requests:?}: {}", v["answers"]);
        Ok(v)
    }

    async fn key_nonce(&self) -> R<u64> {
        let pk = self.relayer.secret_key().public_key().to_string();
        let v = self.h.rpc("query", json!({"request_type": "view_access_key", "finality": "final", "account_id": self.relayer.id(), "public_key": pk})).await?;
        v["result"]["nonce"].as_u64().ok_or_else(|| format!("view_access_key: {v}").into())
    }

    async fn spend_row(&self, name: &str) -> R<Value> {
        let n = nullifier(name);
        let rows = self.h.view(&self.h.vault, "spends", json!({"from": 0, "limit": 100})).await?;
        Ok(rows.as_array().ok_or("spends: not a list")?.iter().find(|r| r["nullifier_hash"] == n).ok_or_else(|| format!("no spend of {name}"))?.clone())
    }

    async fn spends(&self) -> R<usize> {
        Ok(self.h.view(&self.h.vault, "spends", json!({"from": 0, "limit": 100})).await?.as_array().ok_or("spends")?.len())
    }

    /// A relayer transaction read at FINAL: every receipt that ran on the vault with `method`, and whether each succeeded.
    async fn vault_receipts(&self, tx: &str, method: &str) -> R<Vec<bool>> {
        let v = self.h.rpc("EXPERIMENTAL_tx_status", json!({"tx_hash": tx, "sender_account_id": self.relayer.id(), "wait_until": "FINAL"})).await?;
        let mut out = vec![];
        let outcomes = v["result"]["receipts_outcome"].as_array().ok_or_else(|| format!("tx {tx}: {v}"))?;
        let receipts = v["result"]["receipts"].as_array().ok_or_else(|| format!("tx {tx}: {v}"))?;
        for rc in receipts {
            if rc["receiver_id"] != self.h.vault.as_str() {
                continue;
            }
            let calls = rc["receipt"]["Action"]["actions"].as_array().into_iter().flatten().filter(|a| a["FunctionCall"]["method_name"] == method).count();
            if calls == 0 {
                continue;
            }
            let o = outcomes.iter().find(|o| o["id"] == rc["receipt_id"]).ok_or("no outcome for a receipt")?;
            let st = &o["outcome"]["status"];
            out.push(st.get("SuccessValue").is_some() || st.get("SuccessReceiptId").is_some());
            println!("  {tx} {method} on the vault: {} ({} gas)", st, o["outcome"]["gas_burnt"]);
        }
        Ok(out)
    }
}

fn code(v: &Value, i: usize) -> (u64, String) {
    let a = &v["answers"][i];
    (a["status"].as_u64().unwrap_or(0), a["body"]["error"]["code"].as_str().unwrap_or("ok").to_string())
}

fn row<'a>(v: &'a Value, name: &str) -> &'a Value {
    &v["rows"][nullifier(name)]
}

#[tokio::test]
async fn relayer_withdraw_checks_send_and_settle() -> R<()> {
    let w = World::new().await?;
    let near0 = w.h.near_balance(w.relayer.id()).await?;
    let n0 = w.key_nonce().await?;

    // 1. check 7
    let v = w.carry(&["ok"], &["short_registration", "same_call"], 0).await?;
    assert_eq!(code(&v, 0), (400, "register_deposit_wrong".into()), "fresh.test.near unregistered, register_deposit 1");
    assert_eq!(code(&v, 1), (400, "register_deposit_wrong".into()), "alice unregistered, register_deposit 0");
    assert_eq!(w.key_nonce().await?, n0, "check 7 refusals sign nothing");

    // 2. check 10
    let _ = w.h.storage_deposit(&w.alice, w.alice.id()).await?;
    let v = w.carry(&["halted"], &["same_call"], 0).await?;
    assert_eq!(code(&v, 0), (503, "token_halted".into()));
    assert!(row(&v, "same_call").is_null(), "no record for a halted request");
    assert_eq!(w.key_nonce().await?, n0, "a halted request signs nothing");

    // 2b. fund_recipient true to a named account (not an implicit A with its own id key): recipient_refused, nothing signed
    let v = w.carry(&["ok"], &["fund:same_call"], 0).await?;
    assert_eq!(code(&v, 0), (400, "recipient_refused".into()), "{}", v["answers"]);
    assert_eq!(w.key_nonce().await?, n0, "a refused fund_recipient request signs nothing");

    // 3. check 7b (card vault-review-fixes-1, review F-1): the fee is paid in the recipient's own payout receipt, so a
    // fee account the token refuses would fail the whole payout. The relayer reads its fee account first and signs
    // nothing while it is unregistered or blocklisted: 503 relayer_low, its log naming the fee account.
    let fee_hold = |v: &Value, why: &str| -> R<()> {
        assert_eq!(code(v, 0), (503, "relayer_low".into()), "{why}: {}", v["answers"]);
        assert!(row(v, "same_call").is_null(), "{why}: no record for a held request");
        let logs = v["logs"].as_array().ok_or("no logs")?;
        assert!(logs.iter().any(|l| l.as_str().is_some_and(|l| l.starts_with("withdraw 503 relayer_low: relayer fee account not ready (relayer.test.near") && l.ends_with(why))), "{why}: {logs:?}");
        Ok(())
    };
    let v = w.carry(&["ok"], &["same_call"], 0).await?;
    fee_hold(&v, "registered false, blocklisted false)")?;
    assert_eq!(w.key_nonce().await?, n0, "an unregistered fee account signs nothing");
    // registered by alice, so the relayer's key signs nothing in this step and its nonce stays the helper's own
    let _ = w.h.storage_deposit(&w.alice, w.relayer.id()).await?;
    w.h.mock_fail("is_blocklisted", Some(w.relayer.id()), true).await?;
    assert_eq!(w.h.view(&w.h.token, "is_blocklisted", json!({"account_id": w.relayer.id()})).await?, json!(true));
    let v = w.carry(&["ok"], &["same_call"], 0).await?;
    fee_hold(&v, "registered true, blocklisted true)")?;
    assert_eq!(w.key_nonce().await?, n0, "a blocklisted fee account signs nothing");
    w.h.mock_fail("is_blocklisted", Some(w.relayer.id()), false).await?;

    // 3b. the fee account ready: same_call carried and paid in one receipt, alice the withdrawal less the fee
    let (alice0, fee0) = (w.h.token_balance(w.alice.id()).await?, w.h.token_balance(w.relayer.id()).await?);
    let v = w.carry(&["ok"], &["same_call"], 60).await?;
    assert_eq!(code(&v, 0), (200, "ok".into()), "{}", v["answers"]);
    assert_eq!(v["answers"][0]["body"]["state"], "submitted");
    let tx = v["answers"][0]["body"]["tx_hash"].as_str().ok_or("no tx_hash")?.to_string();
    let r = row(&v, "same_call");
    assert_eq!(r["outcome"], "succeeded", "{r}");
    assert_eq!(r["tx_hash"], tx.as_str());
    assert_eq!(r["settle"]["done"], true, "{r}");
    assert_eq!(w.vault_receipts(&tx, "withdraw").await?, vec![true], "the withdraw ran on the vault");
    let settle_tx = r["settle"]["tx"]["tx_hash"].as_str().ok_or("no settle tx")?.to_string();
    assert_eq!(w.vault_receipts(&settle_tx, "settle").await?, vec![true], "the settle ran on the vault");
    let s = w.spend_row("same_call").await?;
    assert_eq!((s["status"].as_str(), s["payer"].as_str(), s["recipient"].as_str()), (Some("settled"), Some("relayer.test.near"), Some("alice.test.near")), "{s}");
    assert_eq!(s["refund_value"], "0", "paid whole: {s}");
    let (withdrawn, fee): (u128, u128) = (s["withdrawn"].as_str().ok_or("withdrawn")?.parse()?, s["fee"].as_str().ok_or("fee")?.parse()?);
    assert!(fee > 0, "same_call is relayed with a fee: {s}");
    assert_eq!(w.h.token_balance(w.alice.id()).await? - alice0, withdrawn - fee, "alice holds the withdrawal less the fee");
    assert_eq!(w.h.token_balance(w.relayer.id()).await? - fee0, fee, "the relayer holds the fee");

    // 4. a restart: the same note again
    let n1 = w.key_nonce().await?;
    let v = w.carry(&["ok"], &["same_call"], 0).await?;
    assert_eq!(code(&v, 0), (400, "spent".into()));
    assert_eq!(w.key_nonce().await?, n1, "spent signs nothing");

    // 5. one nullifier, two proofs at once: one send (the relayer registered at step 3)
    let spends0 = w.spends().await?;
    let v = w.carry(&["ok"], &["same_nullifier_a", "same_nullifier_b"], 60).await?;
    let mut codes = vec![code(&v, 0).1, code(&v, 1).1];
    codes.sort();
    assert_eq!(codes, vec!["in_flight".to_string(), "ok".to_string()], "{}", v["answers"]);
    assert_eq!(w.spends().await?, spends0 + 1, "one spend on chain");
    let s = w.spend_row("same_nullifier_a").await?;
    assert_eq!(s["status"], "settled", "{s}");
    assert_eq!(row(&v, "same_nullifier_a")["settle"]["done"], true);

    // 6. a new recipient: register_deposit the token's minimum
    let fee0 = w.h.token_balance(w.relayer.id()).await?;
    let v = w.carry(&["ok"], &["new_account"], 60).await?;
    assert_eq!(code(&v, 0), (200, "ok".into()), "{}", v["answers"]);
    let s = w.spend_row("new_account").await?;
    assert_eq!((s["status"].as_str(), s["recipient"].as_str(), s["fee"].as_str()), (Some("settled"), Some("newcomer.test.near"), Some("100000")), "{s}");
    assert_eq!(w.h.token_balance(w.relayer.id()).await? - fee0, 100_000, "the relayer holds the fee");

    // 7. a payout that fails on chain: refund_pending, the whole withdrawal in the refund note, settled with the refund
    // note's attachment
    w.h.mock_fail("ft_transfer", Some(w.alice.id()), true).await?;
    let alice0 = w.h.token_balance(w.alice.id()).await?;
    let v = w.carry(&["ok"], &["one_block_a"], 60).await?;
    assert_eq!(code(&v, 0), (200, "ok".into()), "{}", v["answers"]);
    let tx = v["answers"][0]["body"]["tx_hash"].as_str().ok_or("no tx_hash")?.to_string();
    assert_eq!(w.vault_receipts(&tx, "withdraw").await?, vec![true], "the withdraw ran on the vault");
    let r = row(&v, "one_block_a");
    assert_eq!((r["outcome"].as_str(), r["settle"]["done"].as_bool()), (Some("succeeded"), Some(true)), "{r}");
    let settle_tx = r["settle"]["tx"]["tx_hash"].as_str().ok_or("no settle tx")?.to_string();
    assert_eq!(w.vault_receipts(&settle_tx, "settle").await?, vec![true], "the settle ran on the vault");
    let st = w.h.rpc("tx", json!({"tx_hash": settle_tx, "sender_account_id": w.relayer.id(), "wait_until": "FINAL"})).await?;
    let action = &st["result"]["transaction"]["actions"][0]["FunctionCall"];
    assert_eq!((action["method_name"].as_str(), action["deposit"].as_str()), (Some("settle"), Some("1480000000000000000000")), "the settle attaches 148 B x 1e19: {st}");
    let s = w.spend_row("one_block_a").await?;
    assert_eq!((s["status"].as_str(), s["recipient"].as_str()), (Some("settled"), Some("alice.test.near")), "{s}");
    assert_eq!(s["refund_value"], s["withdrawn"], "the whole withdrawal came back into the refund note: {s}");
    assert_eq!(s["withdrawn"], "4000000", "{s}");
    assert_eq!(w.h.token_balance(w.alice.id()).await? - alice0, 0, "alice was paid by a payout that failed");
    w.h.mock_fail("ft_transfer", Some(w.alice.id()), false).await?;

    let near1 = w.h.near_balance(w.relayer.id()).await?;
    println!("relayer NEAR: {near0} before, {near1} after ({} spent on four withdrawals and four settles)", near0 - near1);
    w.h.i1().await?;
    Ok(())
}
