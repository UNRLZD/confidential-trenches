// SPDX-License-Identifier: Apache-2.0
//! The deposit relayer's send (apps/helper/src/bind/send.ts, vault.md 2.10 (e)-(i), R1-R7) against the vault and the
//! token in near-sandbox 2.13.4. Runs only with `--features sandbox`, through tests/harness/run.sh
//! (`contracts/vault/tests/harness/run.sh --test relayer_send`); a plain `cargo test` never builds it.
//!
//! The vault here is the real one (`Harness::with_vault_and`, the 2.8 recipe): `storage_prepay` (src/prepay.rs) and
//! `ft_on_transfer` landing each deposit as a leaf in both trees (vault.md 2.5.1 rows 3-12), 904 B when a tree grows a
//! level and 756 B otherwise.
//!
//! The relayer is driven only through its CLI, `node apps/helper/test/bind-send/carry.ts`, one new process per request
//! batch, so every run after the first is a restart that reads the same store directory. U's call is signed by
//! `node apps/helper/test/bind-send/sign.ts` as U's device signs it (2.10 (b)): U's key nonce + 1 and the final height +
//! 100. Every outcome is read on chain through the harness's RPC, never taken from the CLI's answer alone.
//!
//! World per run: the vault and `kind`'s token (`Harness::with_vault_and`), seed deposits by a seeder account
//! first (so the vault's first deposit is never the relayer's), U = a 64-hex implicit account holding the token
//! (`keyed_account`, `mint`), and the relayer = a sandbox account with NEAR and a full-access key handed to the CLI.
//!
//! - a. `happy_{mock,usdc}`: 200 {tx_hash}; P in the `deposits` pages with depositor U and the amount; U's balance down
//!   by the amount; one prepay of 756 B (tree size 3) and, for a second U, of 904 B (tree size 4, a power of two); the
//!   prepay's vault receipt in a block strictly before the send's `Delegate` receipt on U.
//! - b. `resend_{mock,usdc}`: the same signed call again (a new process): 200 with the same tx_hash, the relayer's key
//!   nonce and balance unmoved, nothing new on chain.
//! - c. `twin_{mock,usdc}`: two identical requests in one run: one 200 {tx_hash}, the other 400 in_flight or 200 with
//!   the same tx_hash; exactly one send on chain (relayer nonce + 2: the prepay and the send); failed 0.
//! - d. `halted_{mock,usdc}`: the watch answers halted (and, on USDC, USDC is halted on chain): 503 token_halted,
//!   nothing spent, no record.
//! - e. `three_failed_sends_{mock,usdc}`: the token refuses U's call (the mock's `ft_transfer_call` fails for the
//!   vault as receiver; USDC's blocklister blocklists U, so its `ft_transfer_call` fails with "is blocklisted"); three
//!   sends on one P, each re-signed; each retry first topped up to 904 B in all, never above; then struck, and a fourth
//!   request is 403 sender_struck with no relayer transaction.
//! - f. `paused_send_does_not_count_usdc`: USDC halted between the checks and the send: the send fails with
//!   "FiatToken: paused", and USDC read at the failure's block was paused, so it does not count (failed 0, not struck); unhalted, a
//!   re-signed call on the same P lands. The halt is the pausers' multisig whose execute is sent the moment P's prepaid
//!   record appears: USDC refuses its views too while halted (`USDC_HALTED`), so a halt before the run would stop the
//!   checks' balance read, never the send.
//! - g. `bad_nonce_{mock,usdc}`: a call signed at U's key nonce, not above: 400 bad_nonce, nothing spent.
//! - h. `overtaken_mock`: the prepay is signed and stored but its broadcast reaches no node (carry.ts `unsent`): 400
//!   in_flight, nothing on chain. Another transaction of the relayer's key takes its nonce. The next run (a restart)
//!   reads the key's changes at that block on the real node (`EXPERIMENTAL_changes`, single_access_key_changes), which
//!   name the other transaction, not the prepay: the stored prepay is dropped by (a2), never on chain, and a fresh
//!   prepay and the send land (200).
//! - i. `create_after_delivery_usdc` (SB-05's creation case, wallet.md step 6): U a fresh 64-hex id with no account,
//!   its USDC registered and paid while it does not exist; `node apps/helper/test/bind-send/create.ts` answers
//!   no_delivery, then under_min below MIN_DEPOSIT, with no relayer transaction; at HELD, three concurrent asks make one
//!   plain Transfer of 182 B x 1e19 and U holds only its own key; the relayer's balance before and after it (V SB run
//!   (5)); a restart answers exists; then U's call, signed by U's key, lands its note.
//!
//! Each prints its gas table (the harness's, for the seeds; each relayer transaction's receipts) and the relayer's
//! balance before and after: per (U, P) it falls by at most 0.010501 N (vault.md 2.10, a struck U's maximum) plus the
//! gas of a deposit that landed.
#![cfg(feature = "sandbox")]

mod harness;

use harness::{Harness, TokenKind, R, ONE_YOCTO, YOCTO_PER_BYTE};
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::str::FromStr;

/// What each U and the seeder hold, and what each deposit moves (2 USDC; MIN_DEPOSIT is 1).
const HELD: u128 = 10_000_000;
const AMOUNT: u128 = 2_000_000;
/// The gas U signs (2.10 (b)).
const U_GAS: &str = "180000000000000";
/// R4's margin K the relayer runs with, and the window U signs with.
const MARGIN_K: &str = "20";
const WINDOW: u64 = 100;
/// 2.3: a deposit with no tree growing a level, and with one (the 148 B of a new level in both trees).
const B756: u64 = 756;
const B904: u64 = 904;
/// vault.md 2.10 (V:735): a struck U's most when its sends fail at the token or the vault's first check, as every
/// case here does: 0.00904 + 3 x 0.0003 + 2 x 0.0002805 = 0.010501 N. The relayer's floor holds the larger row-7
/// maximum, 0.0302526 N (send.ts PER_P_WORST_YOCTO), for sends that burn more before they fail.
const STRUCK_MAX: u128 = 10_501_000_000_000_000_000_000;
/// What each seed deposit prepays: more than any deposit writes, the seeder's own NEAR.
const SEED_PREPAY_BYTES: u128 = 2_000;
/// `Key::Prepaid`'s Borsh byte (src/lib.rs `Key`, the 13th variant), as tests/prepay.rs reads it.
const PREPAID_PREFIX: u8 = 12;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn cli(name: &str) -> R<PathBuf> {
    let p = repo().join("apps/helper/test/bind-send").join(name);
    if !p.is_file() {
        return Err(format!("{}: not found (the relayer's CLI)", p.display()).into());
    }
    Ok(p)
}

/// `node <script>` with `input` on stdin; its one stdout line as JSON. A non-zero exit is an error with its stderr.
async fn node(script: PathBuf, input: Value) -> R<Value> {
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

fn s(v: &Value) -> R<String> {
    v.as_str().map(str::to_string).ok_or_else(|| format!("not a string: {v}").into())
}

fn yocto(v: &Value) -> R<u128> {
    Ok(s(v)?.parse()?)
}

fn near(y: u128) -> String {
    format!("{:.7} N", y as f64 / 1e24)
}

struct World {
    h: Harness,
    kind: TokenKind,
    relayer: Account,
    store: PathBuf,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.store);
    }
}

/// U: a 64-hex implicit id with one full-access test key (a state patch), registered on the token and holding HELD.
struct U {
    acct: Account,
    id: String,
}

impl World {
    /// The vault, `kind`'s token, the relayer, and `seeds` deposits by a seeder before anything of the relayer's.
    async fn new(kind: TokenKind, seeds: u32, case: &str) -> R<Self> {
        cli("carry.ts")?;
        cli("sign.ts")?;
        let h = Harness::with_vault_and(kind).await?;
        let relayer = h.account("relayer", 20).await?;
        let seeder = h.account("seeder", 20).await?;
        h.mint(seeder.id(), HELD * seeds.max(1) as u128).await?;
        for i in 0..seeds {
            let p = format!("{}", 9_000_000 + i);
            let prepay = NearToken::from_yoctonear(SEED_PREPAY_BYTES * YOCTO_PER_BYTE);
            let _ = h.call(&seeder, &h.vault, "storage_prepay", json!({"precommitment": p}), prepay, Gas::from_tgas(30)).await?;
            let msg = json!({"precommitment": p, "depositor": seeder.id()}).to_string();
            let args = json!({"receiver_id": h.vault, "amount": AMOUNT.to_string(), "msg": msg});
            let _ = h.call(&seeder, &h.token, "ft_transfer_call", args, ONE_YOCTO, Gas::from_tgas(180)).await?;
        }
        let w = Self { h, kind, relayer, store: store_dir(case)? };
        let (n, size) = (w.deposits().await?.len() as u32, w.tree_size().await?);
        if n != seeds || size != seeds as u64 {
            return Err(format!("{seeds} seed deposits: the deposits pages hold {n}, the state tree {size} (the vault does not insert deposits)").into());
        }
        println!("[{case} {kind:?}] {seeds} seed deposits landed; state tree size {size}");
        Ok(w)
    }

    /// A new U named by `tag`, holding HELD on the token.
    async fn u(&self, tag: &str) -> R<U> {
        let id = hex(&near_sdk::env::sha256(format!("relayer_send {tag}").as_bytes()));
        let acct = self.h.keyed_account(&id.parse()?, 5).await?;
        self.h.mint(acct.id(), HELD).await?;
        Ok(U { acct, id })
    }

    async fn final_height(&self) -> R<u64> {
        let b = self.h.rpc("block", json!({"finality": "final"})).await?;
        b["result"]["header"]["height"].as_u64().ok_or_else(|| format!("block final: {b}").into())
    }

    async fn key_nonce(&self, a: &Account) -> R<u64> {
        let pk = a.secret_key().public_key().to_string();
        let v = self
            .h
            .rpc("query", json!({"request_type": "view_access_key", "finality": "final", "account_id": a.id(), "public_key": pk}))
            .await?;
        v["result"]["nonce"].as_u64().ok_or_else(|| format!("view_access_key {}: {v}", a.id()).into())
    }

    /// U's call signed by sign.ts at `nonce` (None: U's key nonce + 1) and the final height + WINDOW.
    async fn sign(&self, u: &U, p: &str, nonce: Option<u64>) -> R<String> {
        let nonce = match nonce {
            Some(n) => n,
            None => self.key_nonce(&u.acct).await? + 1,
        };
        let input = json!({
            "secret_key": u.acct.secret_key().to_string(), "sender": u.id, "token": self.h.token, "vault": self.h.vault,
            "amount": AMOUNT.to_string(), "precommitment": p, "nonce": nonce.to_string(),
            "max_block_height": (self.final_height().await? + WINDOW).to_string(), "gas": U_GAS,
        });
        s(&node(cli("sign.ts")?, input).await?["signed_delegate"])
    }

    /// One carry.ts process: `requests` sent concurrently, the token watch answering `status` in order.
    async fn carry(&self, status: &[&str], requests: &[&str]) -> R<Value> {
        self.carry_with(status, requests, json!({})).await
    }

    /// carry with `extra` added to carry.ts's input (`unsent`, `waitMs`).
    async fn carry_with(&self, status: &[&str], requests: &[&str], extra: Value) -> R<Value> {
        let rpc = self.h.worker.rpc_addr();
        let mut input = json!({
            "rpc": [rpc, rpc], "vault": self.h.vault, "token": self.h.token,
            "relayer": {"account_id": self.relayer.id(), "secret_key": self.relayer.secret_key().to_string()},
            "store": self.store, "marginK": MARGIN_K, "status": status,
            "requests": requests.iter().map(|r| json!({"signed_delegate": r})).collect::<Vec<_>>(),
        });
        for (k, v) in extra.as_object().ok_or("carry: extra is not an object")? {
            input[k] = v.clone();
        }
        let out = node(cli("carry.ts")?, input).await?;
        println!("carry {status:?} x{}: answers {} record {}", requests.len(), out["answers"], out["record"]);
        if out["answers"].as_array().map(Vec::len) != Some(requests.len()) {
            return Err(format!("carry.ts: {} answers for {} requests: {out}", out["answers"], requests.len()).into());
        }
        Ok(out)
    }

    async fn deposits(&self) -> R<Vec<Value>> {
        let v = self.h.view(&self.h.vault, "deposits", json!({"from": 0, "limit": 1000})).await?;
        Ok(v.as_array().ok_or_else(|| format!("deposits: {v}"))?.clone())
    }

    async fn tree_size(&self) -> R<u64> {
        let v = self.h.view(&self.h.vault, "state_tree", json!({})).await?;
        v["size"].as_u64().ok_or_else(|| format!("state_tree: {v}").into())
    }

    /// The `deposits` rows holding P.
    async fn rows_for(&self, p: &str) -> R<Vec<Value>> {
        Ok(self.deposits().await?.into_iter().filter(|d| d["precommitment"] == p).collect())
    }

    async fn relayer_nonce(&self) -> R<u64> {
        self.key_nonce(&self.relayer).await
    }

    async fn relayer_balance(&self) -> R<u128> {
        self.h.near_balance(self.relayer.id()).await
    }

    /// The relayer's transaction `hash` at FINAL.
    async fn tx(&self, hash: &str) -> R<Value> {
        let v = self
            .h
            .rpc("EXPERIMENTAL_tx_status", json!({"tx_hash": hash, "sender_account_id": self.relayer.id(), "wait_until": "FINAL"}))
            .await?;
        if v["result"]["final_execution_status"] != "FINAL" {
            return Err(format!("EXPERIMENTAL_tx_status {hash}: {v}").into());
        }
        Ok(v["result"].clone())
    }

    async fn block_height(&self, block_hash: &Value) -> R<u64> {
        let b = self.h.rpc("block", json!({"block_id": block_hash})).await?;
        b["result"]["header"]["height"].as_u64().ok_or_else(|| format!("block {block_hash}: {b}").into())
    }

    /// prepaid[P] read from the vault's raw state at `finality`, as tests/prepay.rs reads it.
    async fn prepaid(&self, p: &str, finality: &str) -> R<Option<u128>> {
        let mut key = vec![PREPAID_PREFIX];
        key.extend(blindfill_vault::field::to_be(&blindfill_vault::field::from_decimal(p).ok_or("P: not a field element")?));
        let prefix = serde_json::to_value(Base64VecU8::from(key.clone()))?;
        let v = self
            .h
            .rpc("query", json!({"request_type": "view_state", "finality": finality, "account_id": self.h.vault, "prefix_base64": prefix}))
            .await?;
        for kv in v["result"]["values"].as_array().ok_or_else(|| format!("view_state: {v}"))? {
            let k: Base64VecU8 = serde_json::from_value(kv["key"].clone())?;
            if k.0 == key {
                let val: Base64VecU8 = serde_json::from_value(kv["value"].clone())?;
                let b: [u8; 16] = val.0.as_slice().try_into().map_err(|_| "prepaid value not 16 B")?;
                return Ok(Some(u128::from_le_bytes(b)));
            }
        }
        Ok(None)
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn store_dir(case: &str) -> R<PathBuf> {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos();
    let d = std::env::temp_dir().join(format!("relayer-send-{case}-{}-{t}", std::process::id()));
    std::fs::create_dir_all(&d)?;
    Ok(d)
}

/// A read relayer transaction: its receipts, what it burnt and attached, and the first action's kind.
struct Tx {
    hash: String,
    v: Value,
}

impl Tx {
    fn ok(&self) -> bool {
        harness::status_is_ok(&self.v["status"])
            && self.v["receipts_outcome"].as_array().is_some_and(|r| r.iter().all(|o| harness::status_is_ok(&o["outcome"]["status"])))
    }
    fn burnt(&self) -> R<u128> {
        let mut t = yocto(&self.v["transaction_outcome"]["outcome"]["tokens_burnt"])?;
        for o in self.v["receipts_outcome"].as_array().into_iter().flatten() {
            t += yocto(&o["outcome"]["tokens_burnt"])?;
        }
        Ok(t)
    }
    fn action(&self) -> &Value {
        &self.v["transaction"]["actions"][0]
    }
    /// The receipt outcomes executed on `executor`.
    fn on<'a>(&'a self, executor: &str) -> Vec<&'a Value> {
        self.v["receipts_outcome"].as_array().into_iter().flatten().filter(|o| o["outcome"]["executor_id"] == executor).collect()
    }
    fn failures(&self) -> Vec<String> {
        self.v["receipts_outcome"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|o| !harness::status_is_ok(&o["outcome"]["status"]))
            .map(|o| format!("{}: {}", o["outcome"]["executor_id"], o["outcome"]["status"]))
            .collect()
    }
    fn table(&self, what: &str) -> String {
        let mut out = format!("  {what} tx {} ({}):\n", self.hash, if self.ok() { "ok" } else { "FAILED" });
        for o in self.v["receipts_outcome"].as_array().into_iter().flatten() {
            let oc = &o["outcome"];
            let st = if harness::status_is_ok(&oc["status"]) { "ok".to_string() } else { oc["status"].to_string() };
            out += &format!(
                "    {:<66} {:>9.3} Tgas  {}\n",
                s(&oc["executor_id"]).unwrap_or_default(),
                oc["gas_burnt"].as_u64().unwrap_or(0) as f64 / 1e12,
                st
            );
        }
        out
    }
}

/// What a run of the relayer spent, read on chain from its own transactions.
struct Spend {
    storage: u128,
    burnt: u128,
    landed_gas: u128,
    table: String,
}

/// Reads every transaction `hashes` names (the relayer's prepays then sends) and checks each one's shape.
async fn spend(w: &World, prepays: &[String], sends: &[String], u: &str, p: &str) -> R<Spend> {
    let mut sp = Spend { storage: 0, burnt: 0, landed_gas: 0, table: String::new() };
    for h in prepays {
        let t = Tx { hash: h.clone(), v: w.tx(h).await? };
        assert_eq!(t.v["transaction"]["signer_id"], w.relayer.id().as_str(), "prepay {h}: not the relayer's");
        assert_eq!(t.v["transaction"]["receiver_id"], w.h.vault.as_str(), "prepay {h}: not to the vault");
        let fc = &t.action()["FunctionCall"];
        assert_eq!(fc["method_name"], "storage_prepay", "prepay {h}: {}", t.action());
        let args: Base64VecU8 = serde_json::from_value(fc["args"].clone())?;
        assert_eq!(serde_json::from_slice::<Value>(&args.0)?, json!({"precommitment": p}), "prepay {h}: another P");
        assert!(t.ok(), "prepay {h} failed: {:?}", t.failures());
        sp.storage += yocto(&fc["deposit"])?;
        sp.burnt += t.burnt()?;
        sp.table += &t.table("storage_prepay");
    }
    for h in sends {
        let t = Tx { hash: h.clone(), v: w.tx(h).await? };
        assert_eq!(t.v["transaction"]["signer_id"], w.relayer.id().as_str(), "send {h}: not the relayer's");
        assert_eq!(t.v["transaction"]["receiver_id"], u, "send {h}: not to U");
        assert!(t.action().get("Delegate").is_some(), "send {h}: not a Delegate action: {}", t.action());
        sp.burnt += t.burnt()?;
        if t.ok() {
            sp.landed_gas += t.burnt()?;
        }
        sp.table += &t.table("send (Delegate)");
    }
    Ok(sp)
}

fn answer(out: &Value, i: usize) -> (u64, &Value) {
    (out["answers"][i]["status"].as_u64().unwrap_or(0), &out["answers"][i]["body"])
}

fn code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or("")
}

fn hashes(list: &Value) -> Vec<String> {
    list.as_array().into_iter().flatten().filter_map(|x| x["tx_hash"].as_str().map(str::to_string)).collect()
}

fn report(w: &World, case: &str, before: u128, after: u128, sp: &Spend) {
    let cost = before.saturating_sub(after);
    println!(
        "[{case} {:?}] relayer {} -> {}: spent {} = storage {} + gas burnt {} + other {} (bound {} + landed gas {})\n{}\nharness gas table (seeds and setup)\n{}",
        w.kind,
        near(before),
        near(after),
        near(cost),
        near(sp.storage),
        near(sp.burnt),
        near(cost.saturating_sub(sp.storage + sp.burnt)),
        near(STRUCK_MAX),
        near(sp.landed_gas),
        sp.table,
        w.h.gas_table()
    );
}

// ---- a. the happy path ----

/// One U's deposit carried end to end; returns (U, P, signed call, tx_hash).
async fn happy_one(w: &World, tag: &str, p: &str, want_bytes: u64) -> R<(U, String, String)> {
    let u = w.u(tag).await?;
    let size0 = w.tree_size().await?;
    let sd = w.sign(&u, p, None).await?;
    let (rb0, rn0, ub0, vb0) = (w.relayer_balance().await?, w.relayer_nonce().await?, w.h.token_balance(u.acct.id()).await?, w.h.token_balance(&w.h.vault).await?);
    let out = w.carry(&["ok"], &[&sd]).await?;
    let (st, body) = answer(&out, 0);
    assert_eq!(st, 200, "{tag}: answer {}", out["answers"][0]);
    let send = s(&body["tx_hash"])?;
    let rec = &out["record"];
    assert_eq!(rec["u"], u.id.as_str());
    assert_eq!(rec["p"], p);
    assert_eq!(rec["failed"], 0);
    assert_eq!(rec["struck"], false);
    assert_eq!(rec["prepaid_bytes"], want_bytes, "{tag}: tree size {size0} before; want a {want_bytes} B prepay");
    let prepays = hashes(&rec["prepays"]);
    assert_eq!(prepays.len(), 1, "{tag}: prepays {}", rec["prepays"]);
    assert_eq!(rec["prepays"][0]["bytes"], want_bytes);
    assert_eq!(hashes(&rec["sends"]), vec![send.clone()], "{tag}: sends {}", rec["sends"]);

    // on chain
    let rows = w.rows_for(p).await?;
    assert_eq!(rows.len(), 1, "{tag}: P in the deposits pages {} times", rows.len());
    assert_eq!(rows[0]["depositor"], u.id.as_str());
    assert_eq!(rows[0]["value"], AMOUNT.to_string());
    assert_eq!(w.h.token_balance(u.acct.id()).await?, ub0 - AMOUNT, "{tag}: U's balance did not fall by the amount");
    assert_eq!(w.h.token_balance(&w.h.vault).await?, vb0 + AMOUNT, "{tag}: the vault's balance did not rise by the amount");
    assert_eq!(w.tree_size().await?, size0 + 1);
    assert_eq!(w.relayer_nonce().await?, rn0 + 2, "{tag}: the relayer sent other than one prepay and one send");
    let sp = spend(w, &prepays, &[send.clone()], &u.id, p).await?;
    assert_eq!(sp.storage, want_bytes as u128 * YOCTO_PER_BYTE, "{tag}: the prepay's attachment");
    assert!(sp.landed_gas > 0, "{tag}: the send did not succeed in every receipt");

    // the prepay's vault receipt runs in a block strictly before the Delegate receipt on U
    let pt = w.tx(&prepays[0]).await?;
    let st_ = w.tx(&send).await?;
    let pv = Tx { hash: prepays[0].clone(), v: pt };
    let sv = Tx { hash: send.clone(), v: st_ };
    let prepay_rc = pv.on(w.h.vault.as_str());
    let delegate_rc = sv.on(&u.id);
    assert!(!prepay_rc.is_empty() && !delegate_rc.is_empty(), "{tag}: no vault receipt in the prepay or no receipt on U in the send");
    let ph = w.block_height(&prepay_rc[0]["block_hash"]).await?;
    let dh = w.block_height(&delegate_rc[0]["block_hash"]).await?;
    println!("[{tag}] prepay's vault receipt at block {ph}, the Delegate receipt on U at block {dh}");
    assert!(ph < dh, "{tag}: the prepay ran at {ph}, not before the Delegate at {dh}");

    let rb1 = w.relayer_balance().await?;
    report(w, tag, rb0, rb1, &sp);
    assert!(rb0 - rb1 <= STRUCK_MAX + sp.landed_gas, "{tag}: the relayer spent {} on one (U, P)", near(rb0 - rb1));
    Ok((u, sd, send))
}

async fn happy(kind: TokenKind) -> R<()> {
    let w = World::new(kind, 3, "a").await?;
    happy_one(&w, "a1", "424242001", B756).await?;
    happy_one(&w, "a2", "424242002", B904).await?;
    w.h.i1().await?;
    Ok(())
}

#[tokio::test]
async fn happy_mock() -> R<()> {
    happy(TokenKind::Mock).await
}

#[tokio::test]
async fn happy_usdc() -> R<()> {
    happy(TokenKind::Usdc).await
}

// ---- b. the same call again ----

async fn resend(kind: TokenKind) -> R<()> {
    let w = World::new(kind, 3, "b").await?;
    let p = "424242011";
    let (u, sd, send) = happy_one(&w, "b1", p, B756).await?;
    let (rb0, rn0, ub0, n0) = (w.relayer_balance().await?, w.relayer_nonce().await?, w.h.token_balance(u.acct.id()).await?, w.deposits().await?.len());
    let out = w.carry(&["ok"], &[&sd]).await?;
    let (st, body) = answer(&out, 0);
    assert_eq!(st, 200, "resend: {}", out["answers"][0]);
    assert_eq!(body["tx_hash"], send.as_str(), "resend: another tx_hash");
    assert_eq!(w.relayer_nonce().await?, rn0, "resend: the relayer sent a transaction");
    assert_eq!(w.relayer_balance().await?, rb0, "resend: the relayer spent NEAR");
    assert_eq!(w.h.token_balance(u.acct.id()).await?, ub0);
    assert_eq!(w.deposits().await?.len(), n0, "resend: a new deposit");
    assert_eq!(w.rows_for(p).await?.len(), 1);
    println!("[b {kind:?}] the same call again: 200, tx {send}, relayer nonce {rn0} unmoved, nothing new on chain");
    w.h.i1().await?;
    Ok(())
}

#[tokio::test]
async fn resend_mock() -> R<()> {
    resend(TokenKind::Mock).await
}

#[tokio::test]
async fn resend_usdc() -> R<()> {
    resend(TokenKind::Usdc).await
}

// ---- c. two identical requests in one run (R3-3) ----

async fn twin(kind: TokenKind) -> R<()> {
    let w = World::new(kind, 3, "c").await?;
    let p = "424242021";
    let u = w.u("c1").await?;
    let sd = w.sign(&u, p, None).await?;
    let (rb0, rn0, ub0) = (w.relayer_balance().await?, w.relayer_nonce().await?, w.h.token_balance(u.acct.id()).await?);
    let out = w.carry(&["ok"], &[&sd, &sd]).await?;
    let (a, b) = (answer(&out, 0), answer(&out, 1));
    let sent: Vec<&(u64, &Value)> = [&a, &b].into_iter().filter(|(st, body)| *st == 200 && body["tx_hash"].is_string()).collect();
    assert!(!sent.is_empty(), "twin: no 200 {{tx_hash}}: {}", out["answers"]);
    let send = s(&sent[0].1["tx_hash"])?;
    for (st, body) in [&a, &b] {
        let same = *st == 200 && body["tx_hash"] == send.as_str();
        // in_flight is not in the kit's HELPER_CODE_STATUS, so it answers 400 (the device reads it by that status)
        let busy = *st == 400 && code(body) == "in_flight";
        assert!(same || busy, "twin: an answer neither 200 with {send} nor 400 in_flight: {st} {body}");
    }
    let rec = &out["record"];
    // the chain first, then the record
    let rows = w.rows_for(p).await?;
    println!("[c {kind:?}] on chain: P's rows {rows:?}; U's balance {} (was {ub0}); relayer nonce +{}", w.h.token_balance(u.acct.id()).await?, w.relayer_nonce().await? - rn0);
    assert_eq!(w.relayer_nonce().await?, rn0 + 2, "twin: not exactly one prepay and one send");
    assert_eq!(rows.len(), 1, "twin: P not in the pages once");
    assert_eq!(w.h.token_balance(u.acct.id()).await?, ub0 - AMOUNT);
    assert_eq!(hashes(&rec["sends"]), vec![send.clone()], "twin: sends {}", rec["sends"]);
    assert_eq!(rec["failed"], 0, "twin: a send that landed counted as failed: record {rec}");
    assert_eq!(rec["landed"], true, "twin: record {rec}");
    let sp = spend(&w, &hashes(&rec["prepays"]), &[send], &u.id, p).await?;
    let rb1 = w.relayer_balance().await?;
    report(&w, "c", rb0, rb1, &sp);
    assert!(rb0 - rb1 <= STRUCK_MAX + sp.landed_gas);
    w.h.i1().await?;
    Ok(())
}

#[tokio::test]
async fn twin_mock() -> R<()> {
    twin(TokenKind::Mock).await
}

#[tokio::test]
async fn twin_usdc() -> R<()> {
    twin(TokenKind::Usdc).await
}

// ---- d. the token halted ----

async fn halted(kind: TokenKind) -> R<()> {
    // refused before anything is spent: no deposit lands, so no seed is needed
    let w = World::new(kind, 0, "d").await?;
    let u = w.u("d1").await?;
    let sd = w.sign(&u, "424242031", None).await?;
    if kind == TokenKind::Usdc {
        let _ = w.h.usdc_halt(true).await?;
    }
    let (rb0, rn0) = (w.relayer_balance().await?, w.relayer_nonce().await?);
    let run = w.carry(&["halted"], &[&sd]).await;
    if kind == TokenKind::Usdc {
        let _ = w.h.usdc_halt(false).await?; // USDC's views answer again
    }
    let ub = w.h.token_balance(u.acct.id()).await?;
    let out = run?;
    let (st, body) = answer(&out, 0);
    assert_eq!((st, code(body)), (503, "token_halted"), "halted: {}", out["answers"][0]);
    assert_eq!(w.relayer_nonce().await?, rn0, "halted: the relayer sent a transaction");
    assert_eq!(w.relayer_balance().await?, rb0, "halted: the relayer spent NEAR");
    assert_eq!(ub, HELD, "halted: U's balance moved");
    assert!(out["record"].is_null(), "halted: a record {}", out["record"]);
    println!("[d {kind:?}] halted: 503 token_halted, relayer nonce {rn0} and balance {} unmoved, no record", near(rb0));
    w.h.i1().await?;
    Ok(())
}

#[tokio::test]
async fn halted_mock() -> R<()> {
    halted(TokenKind::Mock).await
}

#[tokio::test]
async fn halted_usdc() -> R<()> {
    halted(TokenKind::Usdc).await
}

// ---- e. three failed sends, then struck ----

/// Makes the token refuse U's `ft_transfer_call` (or stop refusing it): the mock fails it for the vault as receiver;
/// USDC's blocklister blocklists U. Answers the text the refusal carries.
async fn refuse(w: &World, u: &AccountId, on: bool) -> R<&'static str> {
    if w.h.usdc.is_none() {
        w.h.mock_fail("ft_transfer_call", Some(&w.h.vault), on).await?;
        return Ok("MockTokenFail");
    }
    let roles = w.h.usdc_roles()?;
    let method = if on { "blocklist" } else { "unblocklist" };
    let _ = w.h.call(&roles.blocklister, &w.h.token, method, json!({"account_id": u}), NearToken::from_yoctonear(0), Gas::from_tgas(30)).await?;
    let listed = w.h.view(&w.h.token, "is_blocklisted", json!({"account_id": u})).await?;
    assert_eq!(listed, json!(on), "{method} {u}: is_blocklisted {listed}");
    Ok("is blocklisted")
}

async fn three_failed_sends(kind: TokenKind) -> R<()> {
    let w = World::new(kind, 3, "e").await?;
    let p = "424242041";
    let u = w.u("e1").await?;
    let refusal = refuse(&w, u.acct.id(), true).await?;
    let rb0 = w.relayer_balance().await?;
    let (mut prepays, mut sends): (Vec<String>, Vec<String>) = (vec![], vec![]);
    let mut earlier = 0u64;
    for i in 1..=3u64 {
        let rn0 = w.relayer_nonce().await?;
        let un0 = w.key_nonce(&u.acct).await?;
        let sd = w.sign(&u, p, None).await?;
        let out = w.carry(&["ok"], &[&sd]).await?;
        let rec = &out["record"];
        assert_eq!(rec["failed"], i, "send {i}: record {rec}");
        assert_eq!(rec["struck"], i == 3, "send {i}: struck {}", rec["struck"]);
        let ps = hashes(&rec["prepays"]);
        let ss = hashes(&rec["sends"]);
        assert_eq!(ss.len() as u64, i, "send {i}: sends {}", rec["sends"]);
        let new_prepays = &ps[prepays.len()..];
        let new_send = ss[i as usize - 1].clone();
        assert_eq!(rec["sends"][i as usize - 1]["counted"], true, "send {i}: not counted");
        let total = rec["prepaid_bytes"].as_u64().ok_or("prepaid_bytes")?;
        match i {
            1 => {
                assert_eq!(total, B756, "send 1: tree size 3 wants 756 B");
                assert_eq!(new_prepays.len(), 1);
            }
            2 => {
                assert_eq!(total, B904, "the first retry: not topped up to 904 B");
                assert_eq!(new_prepays.len(), 1, "the first retry: no top-up");
                assert_eq!(rec["prepays"][1]["bytes"], B904 - earlier, "the top-up is not 904 B less what was prepaid");
            }
            _ => {
                assert_eq!(total, B904, "the second retry: prepaid {total} B, not 904");
                assert!(new_prepays.is_empty(), "the second retry: a prepay above 904 B in all");
            }
        }
        earlier = total;
        // on chain: the send went out, U's call failed at the token, nothing landed
        let t = Tx { hash: new_send.clone(), v: w.tx(&new_send).await? };
        assert!(t.failures().iter().any(|f| f.contains(refusal)), "send {i}: not refused by the token ({refusal}): {:?}", t.failures());
        assert_eq!(w.rows_for(p).await?.len(), 0, "send {i}: P landed");
        assert_eq!(w.h.token_balance(u.acct.id()).await?, HELD, "send {i}: U's balance moved");
        assert_eq!(w.key_nonce(&u.acct).await?, un0 + 1, "send {i}: U's key nonce did not move to the signed one");
        assert_eq!(w.relayer_nonce().await?, rn0 + new_prepays.len() as u64 + 1, "send {i}: other relayer transactions");
        prepays.extend(new_prepays.iter().cloned());
        sends.push(new_send);
    }
    // a fourth request for a struck U: 403, nothing sent
    let rn0 = w.relayer_nonce().await?;
    let sd = w.sign(&u, p, None).await?;
    let out = w.carry(&["ok"], &[&sd]).await?;
    let (st, body) = answer(&out, 0);
    assert_eq!((st, code(body)), (403, "sender_struck"), "struck: {}", out["answers"][0]);
    assert_eq!(w.relayer_nonce().await?, rn0, "struck: the relayer sent a transaction");
    let prepaid = w.prepaid(p, "final").await?;
    assert_eq!(prepaid, Some(B904 as u128 * YOCTO_PER_BYTE), "prepaid[P] on chain");
    let sp = spend(&w, &prepays, &sends, &u.id, p).await?;
    let rb1 = w.relayer_balance().await?;
    report(&w, "e", rb0, rb1, &sp);
    assert_eq!(sp.landed_gas, 0);
    assert!(rb0 - rb1 <= STRUCK_MAX, "struck U: the relayer spent {}, over {}", near(rb0 - rb1), near(STRUCK_MAX));
    let _ = refuse(&w, u.acct.id(), false).await?;
    w.h.i1().await?;
    Ok(())
}

#[tokio::test]
async fn three_failed_sends_mock() -> R<()> {
    three_failed_sends(TokenKind::Mock).await
}

#[tokio::test]
async fn three_failed_sends_usdc() -> R<()> {
    three_failed_sends(TokenKind::Usdc).await
}

// ---- f. a send failed by USDC's halt does not count (USDC) ----

/// The watch's answers in the order send.ts asks: before checks 1-7, at check 9, before the prepay and before the send.
/// Open throughout: whether the failed send counts is not the watch's answer now but USDC read at the failure's block
/// (carry.ts `pausedAt`, vault.md 2.10 (f)).
const PAUSED_RUN_WATCH: [&str; 4] = ["ok", "ok", "ok", "ok"];

/// The pausers' `Pause` request created and approved by both, not executed: its id.
async fn stage_pause(h: &Harness) -> R<Value> {
    let roles = h.usdc_roles()?;
    let (zero, gas) = (NearToken::from_yoctonear(0), Gas::from_tgas(100));
    let rid = h.view(&h.token, "get_next_multisig_request_id", json!({})).await?;
    let _ = h.call(&roles.pausers[0], &h.token, "create_multisig_request", json!({"action": "Pause"}), zero, gas).await?;
    for a in &roles.pausers {
        let _ = h.call(a, &h.token, "approve_multisig_request", json!({"request_id": rid}), zero, gas).await?;
    }
    Ok(rid)
}

#[tokio::test]
async fn paused_send_does_not_count_usdc() -> R<()> {
    let w = World::new(TokenKind::Usdc, 3, "f").await?;
    let p = "424242051";
    let u = w.u("f1").await?;
    let rid = stage_pause(&w.h).await?;
    let sd = w.sign(&u, p, None).await?;
    let rb0 = w.relayer_balance().await?;

    // carry runs; the moment P's prepaid record shows (the checks passed, the send not yet out) the halt executes
    let rpc = w.h.worker.rpc_addr();
    let input = json!({
        "rpc": [rpc, rpc], "vault": w.h.vault, "token": w.h.token,
        "relayer": {"account_id": w.relayer.id(), "secret_key": w.relayer.secret_key().to_string()},
        "store": w.store, "marginK": MARGIN_K, "status": PAUSED_RUN_WATCH, "requests": [{"signed_delegate": sd}],
    });
    let run = tokio::spawn(node(cli("carry.ts")?, input));
    let mut seen = false;
    for _ in 0..600 {
        if w.prepaid(p, "optimistic").await?.is_some() {
            seen = true;
            break;
        }
        if run.is_finished() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    let roles = w.h.usdc_roles()?;
    let pause = w
        .h
        .call(&roles.pausers[1], &w.h.token, "execute_multisig_request", json!({"request_id": rid}), NearToken::from_yoctonear(0), Gas::from_tgas(100))
        .await?;
    assert!(pause.receipts.iter().flat_map(|r| &r.logs).any(|l| l.contains("\"event\":\"paused\"")), "the Pause logged no paused event");
    let out = run.await??;
    println!("carry {PAUSED_RUN_WATCH:?} (USDC halted after the prepay): answers {} record {}", out["answers"], out["record"]);
    let _ = w.h.usdc_halt(false).await?;
    assert!(seen, "P's prepaid record never appeared while carry.ts ran: {}", out["answers"]);
    let rec = &out["record"];
    let sends = hashes(&rec["sends"]);
    assert_eq!(sends.len(), 1, "paused: sends {}", rec["sends"]);
    let t = Tx { hash: sends[0].clone(), v: w.tx(&sends[0]).await? };
    assert!(t.failures().iter().any(|f| f.contains(harness::USDC_HALTED)), "paused: the send did not fail with {}: {:?}", harness::USDC_HALTED, t.failures());
    assert_eq!(rec["failed"], 0, "paused: the halted send counted");
    assert_eq!(rec["struck"], false);
    assert_eq!(rec["sends"][0]["counted"], false);
    assert_eq!(w.rows_for(p).await?.len(), 0);
    assert_eq!(w.h.token_balance(u.acct.id()).await?, HELD, "paused: U's balance moved");
    let first = rec["prepaid_bytes"].as_u64().ok_or("prepaid_bytes")?;
    assert_eq!(first, B756);

    // unhalted: a call re-signed at U's key nonce + 1 lands on the same P, topped up to 904 B first (R5)
    let sd2 = w.sign(&u, p, None).await?;
    let out = w.carry(&["ok"], &[&sd2]).await?;
    let (st, body) = answer(&out, 0);
    assert_eq!(st, 200, "after the unhalt: {}", out["answers"][0]);
    let send2 = s(&body["tx_hash"])?;
    let rec = &out["record"];
    assert_eq!(rec["failed"], 0);
    assert_eq!(rec["prepaid_bytes"], B904, "the retry was not topped up to 904 B");
    let rows = w.rows_for(p).await?;
    assert_eq!(rows.len(), 1, "after the unhalt: P not in the pages");
    assert_eq!(rows[0]["depositor"], u.id.as_str());
    assert_eq!(w.h.token_balance(u.acct.id()).await?, HELD - AMOUNT);
    let prepays = hashes(&rec["prepays"]);
    assert_eq!(prepays.len(), 2, "after the unhalt: prepays {}", rec["prepays"]);
    assert_eq!(rec["prepays"][1]["bytes"], B904 - B756, "the top-up is not 148 B");
    let sp = spend(&w, &prepays, &[sends[0].clone(), send2], &u.id, p).await?;
    let rb1 = w.relayer_balance().await?;
    report(&w, "f", rb0, rb1, &sp);
    assert!(rb0 - rb1 <= STRUCK_MAX + sp.landed_gas + t.burnt()?, "paused: the relayer spent {}", near(rb0 - rb1));
    w.h.i1().await?;
    Ok(())
}

// ---- g. a nonce not above U's key nonce ----

async fn bad_nonce(kind: TokenKind) -> R<()> {
    // refused before anything is spent: no deposit lands, so no seed is needed
    let w = World::new(kind, 0, "g").await?;
    let u = w.u("g1").await?;
    let n = w.key_nonce(&u.acct).await?;
    let sd = w.sign(&u, "424242061", Some(n)).await?;
    let (rb0, rn0) = (w.relayer_balance().await?, w.relayer_nonce().await?);
    let out = w.carry(&["ok"], &[&sd]).await?;
    let (st, body) = answer(&out, 0);
    assert_eq!((st, code(body)), (400, "bad_nonce"), "bad nonce: {}", out["answers"][0]);
    assert_eq!(w.relayer_nonce().await?, rn0, "bad nonce: the relayer sent a transaction");
    assert_eq!(w.relayer_balance().await?, rb0, "bad nonce: the relayer spent NEAR");
    assert!(out["record"].is_null(), "bad nonce: a record {}", out["record"]);
    println!("[g {kind:?}] a call at U's key nonce {n}: 400 bad_nonce, relayer nonce {rn0} unmoved");
    w.h.i1().await?;
    Ok(())
}

#[tokio::test]
async fn bad_nonce_mock() -> R<()> {
    bad_nonce(TokenKind::Mock).await
}

#[tokio::test]
async fn bad_nonce_usdc() -> R<()> {
    bad_nonce(TokenKind::Usdc).await
}

// ---- h. a stored prepay whose nonce another transaction of the relayer's key took: (a2) on real nearcore ----

async fn overtaken(kind: TokenKind) -> R<()> {
    let w = World::new(kind, 3, "h").await?;
    let p = "424242071";
    let u = w.u("h1").await?;
    let sd = w.sign(&u, p, None).await?;
    let rn0 = w.relayer_nonce().await?;

    // 1. the prepay signed and stored; its broadcast reaches no node
    let out = w.carry_with(&["ok"], &[&sd], json!({"unsent": true, "waitMs": 3000})).await?;
    let (st, body) = answer(&out, 0);
    assert_eq!((st, code(body)), (400, "in_flight"), "overtaken: the unsent prepay's call: {}", out["answers"][0]);
    let lost = hashes(&out["record"]["prepays"]);
    assert_eq!(lost.len(), 1, "overtaken: prepays {}", out["record"]["prepays"]);
    assert!(out["record"]["prepays"][0]["ok"].is_null(), "overtaken: the stored prepay is not open: {}", out["record"]);
    let n: u64 = s(&out["record"]["prepays"][0]["nonce"])?.parse()?;
    assert_eq!(w.relayer_nonce().await?, rn0, "overtaken: something of the relayer's landed");

    // 2. another transaction of the relayer's key takes that nonce
    let moved = w.relayer.transfer_near(u.acct.id(), NearToken::from_yoctonear(1)).await?;
    assert!(moved.is_success(), "overtaken: the other transaction failed: {moved:?}");
    let other = moved.outcome().transaction_hash.to_string();
    let ot = w.tx(&other).await?; // at FINAL, so the key's final nonce below holds it
    let rn1 = w.relayer_nonce().await?;
    assert!(rn1 >= n, "overtaken: the relayer key's nonce {rn1} is below the stored prepay's {n}");
    // the key's changes at the block that applied it, as the relayer reads them: the real node's shape
    let d = w.block_height(&ot["transaction_outcome"]["block_hash"]).await?;
    let pk = w.relayer.secret_key().public_key().to_string();
    let ch = w
        .h
        .rpc("EXPERIMENTAL_changes", json!({"changes_type": "single_access_key_changes", "keys": [{"account_id": w.relayer.id(), "public_key": pk}], "block_id": d}))
        .await?;
    println!("[h {kind:?}] the stored prepay {} at nonce {n}; the other transaction {other} applied at {d}; changes there: {}", lost[0], ch["result"]);
    let changes = ch["result"]["changes"].as_array().ok_or_else(|| format!("EXPERIMENTAL_changes at {d}: {ch}"))?;
    assert!(
        changes.iter().any(|c| c["cause"]["type"] == "transaction_processing" && c["cause"]["tx_hash"] == other.as_str() && c["type"] == "access_key_update"),
        "overtaken: the changes at {d} do not name the other transaction: {ch}"
    );
    assert!(changes.iter().all(|c| c["cause"]["tx_hash"] != lost[0].as_str()), "overtaken: the changes at {d} name the stored prepay: {ch}");

    // 3. the next run (a restart): the stored prepay dropped by (a2), a fresh prepay and the send land
    let out = w.carry(&["ok"], &[&sd]).await?;
    let (st, body) = answer(&out, 0);
    assert_eq!(st, 200, "overtaken: the next call: {}", out["answers"][0]);
    let send = s(&body["tx_hash"])?;
    let rec = &out["record"];
    let prepays = hashes(&rec["prepays"]);
    assert!(!prepays.contains(&lost[0]), "overtaken: the overtaken prepay is still in the record: {}", rec["prepays"]);
    assert_eq!(prepays.len(), 1, "overtaken: prepays {}", rec["prepays"]);
    assert_eq!(rec["prepaid_bytes"], B756, "overtaken: record {rec}");
    assert_eq!(hashes(&rec["sends"]), vec![send.clone()], "overtaken: sends {}", rec["sends"]);
    assert_eq!(rec["landed"], true, "overtaken: record {rec}");

    // on chain: the stored prepay never landed; one fresh prepay, one send, P once
    let v = w.h.rpc("tx", json!({"tx_hash": lost[0], "sender_account_id": w.relayer.id(), "wait_until": "NONE"})).await?;
    assert_eq!(v["error"]["cause"]["name"], "UNKNOWN_TRANSACTION", "overtaken: the stored prepay is known on chain: {v}");
    assert_eq!(w.relayer_nonce().await?, rn1 + 2, "overtaken: not exactly one fresh prepay and one send after the other transaction");
    assert_eq!(w.rows_for(p).await?.len(), 1, "overtaken: P not in the pages once");
    assert_eq!(w.prepaid(p, "final").await?, None, "overtaken: P's prepaid record not used by its deposit");
    println!("[h {kind:?}] (a2): the stored prepay dropped, never on chain; fresh prepay {} and send {send} landed", prepays[0]);
    w.h.i1().await?;
    Ok(())
}

#[tokio::test]
async fn overtaken_mock() -> R<()> {
    overtaken(TokenKind::Mock).await
}

// ---- i. SB-05's creation case: the relayer's Transfer creates U after the delivery, never before ----

/// apps/helper/src/bind/create.ts CREATE_YOCTO: an implicit id's record and one key, 182 B x 1e19.
const CREATE_YOCTO: u128 = 182 * YOCTO_PER_BYTE;

/// One create.ts process: createOnDelivery for each of `ids` at once, on the relayer's store.
async fn create_run(w: &World, ids: &[&str]) -> R<Value> {
    let rpc = w.h.worker.rpc_addr();
    let input = json!({
        "rpc": [rpc, rpc], "vault": w.h.vault, "token": w.h.token,
        "relayer": {"account_id": w.relayer.id(), "secret_key": w.relayer.secret_key().to_string()},
        "store": w.store, "ids": ids,
    });
    let out = node(cli("create.ts")?, input).await?;
    println!("create x{}: answers {} records {}", ids.len(), out["answers"], out["records"]);
    Ok(out)
}

/// The id's account at final: None when it does not exist.
async fn account_of(w: &World, id: &str) -> R<Option<Value>> {
    let v = w.h.rpc("query", json!({"request_type": "view_account", "finality": "final", "account_id": id})).await?;
    if v["result"]["code_hash"].is_string() {
        return Ok(Some(v["result"].clone()));
    }
    if v["error"]["cause"]["name"] != "UNKNOWN_ACCOUNT" {
        return Err(format!("view_account {id}: {v}").into());
    }
    Ok(None)
}

/// i. U a fresh 64-hex id with no account. Its token arrives before it exists: registered by storage_deposit and paid
/// (the stand-in for 1Click's delivery, D51, D52), each read recorded. Nothing is created with no delivery or one under
/// MIN_DEPOSIT; at MIN_DEPOSIT and above, three concurrent asks make one Transfer of CREATE_YOCTO, U then holds only
/// its own key, and the relayer's balance change is the creation's cost (V SB run (5)). A restart asks again: nothing
/// new. Then U's own call, signed by U's key as the device signs it, is carried and lands its note.
async fn create_after_delivery(kind: TokenKind) -> R<()> {
    let tag = "i";
    cli("create.ts")?;
    let w = World::new(kind, 3, tag).await?;
    let sk = SecretKey::from_random(KeyType::ED25519);
    let pk = near_crypto::SecretKey::from_str(&sk.to_string()).map_err(|e| format!("key: {e}"))?.public_key();
    let id = hex(pk.key_data());
    let uid: AccountId = id.parse()?;
    let rn0 = w.relayer_nonce().await?;

    // no delivery: not created
    let out = create_run(&w, &[&id]).await?;
    assert_eq!(out["answers"][0]["code"], "no_delivery", "{tag}: {out}");
    assert!(account_of(&w, &id).await?.is_none(), "{tag}: U exists before any delivery");

    // under MIN_DEPOSIT (registered on the token while U does not exist): not created
    w.h.mint(&uid, 999_999).await?;
    let reg = w.h.view(&w.h.token, "storage_balance_of", json!({"account_id": id})).await?;
    println!("[{tag} {kind:?}] before U exists: storage_balance_of(U) {reg}, ft_balance_of(U) {}", w.h.token_balance(&uid).await?);
    assert!(!reg.is_null(), "{tag}: U not registered on the token");
    let out = create_run(&w, &[&id]).await?;
    assert_eq!(out["answers"][0]["code"], "under_min", "{tag}: {out}");
    assert!(account_of(&w, &id).await?.is_none(), "{tag}: U created under MIN_DEPOSIT");
    assert_eq!(w.relayer_nonce().await?, rn0, "{tag}: the relayer sent a transaction before the delivery");

    // the delivery reaches MIN_DEPOSIT and above: one Transfer under three concurrent asks
    w.h.mint(&uid, HELD - 999_999).await?;
    let rb0 = w.relayer_balance().await?;
    let out = create_run(&w, &[&id, &id, &id]).await?;
    let hash = s(&out["answers"][0]["tx_hash"])?;
    for i in 0..3 {
        assert_eq!(out["answers"][i]["code"], "created", "{tag}: ask {i}: {out}");
        assert_eq!(out["answers"][i]["tx_hash"], hash.as_str(), "{tag}: ask {i}: another tx");
    }
    assert_eq!(w.relayer_nonce().await?, rn0 + 1, "{tag}: not exactly one relayer transaction");
    let v = w.tx(&hash).await?;
    let rb1 = w.relayer_balance().await?;
    let t = &v["transaction"];
    assert_eq!(t["receiver_id"], id.as_str(), "{tag}: tx {v}");
    assert_eq!(t["actions"], json!([{"Transfer": {"deposit": CREATE_YOCTO.to_string()}}]), "{tag}: not one plain Transfer: {v}");
    let a = account_of(&w, &id).await?.ok_or("U not created")?;
    let keys = w.h.access_keys(&uid, "final").await?;
    assert_eq!(keys.len(), 1, "{tag}: U's keys {keys:?}");
    assert_eq!(keys[0]["public_key"], pk.to_string(), "{tag}: U's key is not its own");
    assert_eq!(keys[0]["access_key"]["permission"], "FullAccess", "{tag}: {keys:?}");
    let burnt: u128 = s(&v["transaction_outcome"]["outcome"]["tokens_burnt"])?.parse::<u128>()?
        + v["receipts_outcome"].as_array().ok_or("no receipts")?.iter().map(|r| r["outcome"]["tokens_burnt"].as_str().unwrap_or("0").parse::<u128>().unwrap_or(0)).sum::<u128>();
    println!(
        "[{tag} {kind:?}] V SB run (5): the relayer's balance {rb0} -> {rb1}, down {} ({} yocto) for creating U: the Transfer's {} (back at U's clean-up) and {} burnt; U's amount {}, storage_usage {}",
        near(rb0 - rb1), rb0 - rb1, near(CREATE_YOCTO), near(rb0 - rb1 - CREATE_YOCTO), a["amount"], a["storage_usage"]
    );
    println!("[{tag} {kind:?}] the Transfer's receipts burnt {} by their outcomes", near(burnt));
    assert_eq!(a["amount"], CREATE_YOCTO.to_string(), "{tag}: U's NEAR");

    // a restart asks again: U exists, nothing new
    let out = create_run(&w, &[&id]).await?;
    assert_eq!(out["answers"][0]["code"], "exists", "{tag}: {out}");
    assert_eq!(w.relayer_nonce().await?, rn0 + 1, "{tag}: a second transaction");

    // U's own call lands its note
    let u = U { acct: Account::from_secret_key(uid, sk, &w.h.worker), id: id.clone() };
    let p = "424242091";
    let sd = w.sign(&u, p, None).await?;
    let out = w.carry(&["ok"], &[&sd]).await?;
    let (st, body) = answer(&out, 0);
    assert_eq!(st, 200, "{tag}: U's call: {}", out["answers"][0]);
    let rows = w.rows_for(p).await?;
    assert_eq!(rows.len(), 1, "{tag}: P not in the pages once");
    assert_eq!(rows[0]["depositor"], id.as_str(), "{tag}: {rows:?}");
    println!("[{tag} {kind:?}] U created by {hash}, then U's call {} landed P {p} as a note", body["tx_hash"]);
    w.h.i1().await?;
    Ok(())
}

#[tokio::test]
async fn create_after_delivery_usdc() -> R<()> {
    create_after_delivery(TokenKind::Usdc).await
}
