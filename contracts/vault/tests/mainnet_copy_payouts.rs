// SPDX-License-Identifier: Apache-2.0
//! Card near-cash-pays-any-amount: the two payouts the device's NEAR buy and Cash withdraw rely on, run on a copy of
//! the MAINNET vault in near-sandbox 2.13.4. Runs only with `--features sandbox`, through tests/harness/run.sh
//! (`contracts/vault/tests/harness/run.sh --test mainnet_copy_payouts`); a plain `cargo test` never builds it.
//!
//! The copy (tests/fixtures/mainnet-vault-copy.json, made by make-mainnet-vault-copy.mjs): vault.confidential.unrlzd.near's
//! deployed code and every state record, read at one final mainnet block on two RPCs that agreed byte for byte. Both are
//! put at the same account id by one sandbox state patch, with mainnet's balance and storage usage and no access key;
//! the code is refused unless it is deployments/mainnet-v1.json's release, and the copy's views (totals, both trees,
//! every leaf, label, deposit and spend) must answer in the sandbox as they answered on mainnet. The token is the pinned
//! real USDC wasm (tests/fixtures/real-wasm.json) at mainnet USDC's own id, which the copied code names, and the vault
//! holds on it what mainnet USDC said it held at the same block (I1 then holds against the copied totals).
//!
//! Three test notes (tests/fixtures/mainnet-copy-spends.json, make-mainnet-copy-spends.mjs; test secrets, never money)
//! are deposited as a user deposits: storage_prepay, then USDC's ft_transfer_call with the deposit message. The sandbox's
//! leaves() and labels() must then be the fixture's trees: the copied mainnet trees grown by those three, which every
//! proof is made against. Every withdrawal goes through the relayer's real send CLI (apps/helper/test/withdraw-send/
//! carry.ts, as tests/relayer_withdraw.rs drives it), relay_fee F = 0.15 USDC, fund_recipient false and register_deposit
//! the token's minimum; every outcome is read on chain through the harness's RPC.
//!
//! A. The NEAR buy's payout: notes 1 and 2, neither enough alone, two withdrawals at once into the same fresh implicit
//!    W (64 hex, never created). Read: both spends rows settled to W with fee F; W's ft_balance_of is the sum of the two
//!    parts; the fee account gained 2F; W was registered once and the other payout's registration came back to the
//!    vault (a token -> vault Transfer of the minimum), the vault's NEAR change printed; one part whole (its change
//!    leaf commits 0) and one part with change above two fees (its change leaf commits that change).
//! B. The Cash withdraw: note 3 whole to the named, registered cash.test.near: its balance up by exactly the part, the
//!    spends row settled, its registration refunded to the vault.
//! C. Refused: note 1's proof again. The helper answers 400 spent and signs nothing; the same proof sent straight to
//!    the vault fails with NullifierAlreadySpent, and no balance, total, spend or leaf moves.
//! Ends with I1 and the gas table (Tgas per receipt, every withdraw, on_payout and settle among them).
#![cfg(feature = "sandbox")]

mod harness;

use harness::{commitment_on, Harness, R, TOKEN_STORAGE, YOCTO_PER_BYTE};
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::types::{AccountDetailsPatch, Gas, NearToken};
use near_workspaces::{Account, AccountId};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const COPY: &str = include_str!("fixtures/mainnet-vault-copy.json");
const SPENDS: &str = include_str!("fixtures/mainnet-copy-spends.json");
const RELEASE: &str = include_str!("../deployments/mainnet-v1.json");
const PREPAY_BYTES: u128 = 904;

fn json_of(s: &str) -> Value {
    serde_json::from_str(s).unwrap()
}

fn u(v: &Value) -> u128 {
    v.as_str().unwrap_or_else(|| panic!("not a decimal string: {v}")).parse().unwrap_or_else(|_| panic!("not a decimal: {v}"))
}

fn b64(s: &Value) -> R<Vec<u8>> {
    Ok(serde_json::from_value::<Base64VecU8>(s.clone())?.0)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn spend(name: &str) -> Value {
    json_of(SPENDS)["spends"].as_array().unwrap().iter().find(|s| s["name"] == name).cloned().unwrap_or_else(|| panic!("no spend {name}"))
}

fn nullifier(name: &str) -> String {
    spend(name)["public_signals"][1].as_str().unwrap().to_string()
}

/// `withdraw`'s three arguments for the fixture's spend `name`.
fn withdraw_args(name: &str) -> Value {
    let s = spend(name);
    json!({"withdrawal": s["withdrawal"], "proof": s["proof"], "public_signals": s["public_signals"]})
}

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// `node apps/helper/test/withdraw-send/carry.ts` with `input` on stdin; its one stdout line as JSON.
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
    depositor: Account,
    relayer: Account,
    cash: Account,
    dir: PathBuf,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The copied vault's whole storage at final, as (key, value) pairs sorted by key.
async fn storage_final(h: &Harness, id: &AccountId) -> R<Vec<(Vec<u8>, Vec<u8>)>> {
    let v = h.rpc("query", json!({"request_type": "view_state", "finality": "final", "account_id": id, "prefix_base64": ""})).await?;
    let values = v["result"]["values"].as_array().ok_or_else(|| format!("view_state {id} at final: {v}"))?;
    let mut out = values.iter().map(|e| Ok((b64(&e["key"])?, b64(&e["value"])?))).collect::<R<Vec<_>>>()?;
    out.sort();
    Ok(out)
}

/// Whether `id` exists at final.
async fn exists(h: &Harness, id: &str) -> R<bool> {
    let v = h.rpc("query", json!({"request_type": "view_account", "finality": "final", "account_id": id})).await?;
    Ok(v["result"]["code_hash"].is_string())
}

/// The mainnet vault's code and every state record at its own id, by one state patch read back at final.
async fn patch_mainnet_vault(h: &Harness) -> R<AccountId> {
    let (copy, release) = (json_of(COPY), json_of(RELEASE));
    let id: AccountId = copy["account_id"].as_str().ok_or("account_id")?.parse()?;
    assert_eq!(id.as_str(), release["account_id"], "the copy is the release's vault");
    let wasm = b64(&copy["code"]["base64"])?;
    let sha = hex(&near_sdk::env::sha256(&wasm));
    let code_hash = harness::code_hash(&wasm);
    assert_eq!((wasm.len() as u64, sha.as_str(), code_hash.as_str()), (release["wasm_bytes"].as_u64().unwrap(), release["wasm_sha256"].as_str().unwrap(), release["code_hash"].as_str().unwrap()), "the copied code is the mainnet release");
    assert_eq!((copy["code"]["sha256"].as_str(), copy["account"]["code_hash"].as_str()), (Some(sha.as_str()), Some(code_hash.as_str())));
    assert_eq!(copy["access_keys"], json!([]), "the mainnet vault has no access key");
    let mut records: Vec<(Vec<u8>, Vec<u8>)> =
        copy["state"].as_array().ok_or("state")?.iter().map(|p| Ok((b64(&p[0])?, b64(&p[1])?))).collect::<R<_>>()?;
    records.sort();
    let (amount, usage) = (u(&copy["account"]["amount"]), copy["account"]["storage_usage"].as_u64().ok_or("storage_usage")?);
    println!(
        "copy: {id} at mainnet block {} {}: code {} B sha256 {sha} (code hash {code_hash}, release {}), {} state records, {amount} yocto, storage {usage} B",
        copy["block"]["height"], copy["block"]["hash"].as_str().unwrap(), wasm.len(), release["source_commit"].as_str().unwrap(), records.len()
    );
    let send = async || -> R<()> {
        let account = AccountDetailsPatch::default().balance(NearToken::from_yoctonear(amount)).storage_usage(usage);
        h.worker.patch(&id).account(account).code(&wasm).states(records.iter().map(|(k, v)| (k.as_slice(), v.as_slice()))).transact().await?;
        Ok(())
    };
    let landed = async || -> R<bool> {
        let a = h.rpc("query", json!({"request_type": "view_account", "finality": "final", "account_id": id})).await?["result"].clone();
        if a["code_hash"] != json!(code_hash) || a["amount"] != json!(amount.to_string()) || a["storage_usage"] != json!(usage) {
            return Ok(false);
        }
        Ok(storage_final(h, &id).await? == records)
    };
    h.patch_landed(&format!("the mainnet vault's copy at {id}"), send, landed).await?;
    assert_eq!(h.access_keys(&id, "final").await?, Vec::<Value>::new(), "the copy has no access key");
    println!("copy patched: code hash {code_hash}, all {} records read back byte for byte at final, access keys []", records.len());
    Ok(id)
}

impl World {
    async fn new() -> R<Self> {
        let (copy, f) = (json_of(COPY), json_of(SPENDS));
        let mut h = Harness::start().await?;
        h.deploy_usdc().await?;
        h.vault = patch_mainnet_vault(&h).await?;
        let page = json!({"from": 0, "limit": 1000});
        // the copy answers as mainnet did at the copy's block
        for (view, args) in [("totals", json!({})), ("state_tree", json!({})), ("label_tree", json!({})), ("leaves", page.clone()), ("labels", page.clone()), ("deposits", page.clone()), ("spends", page.clone())] {
            assert_eq!(h.view(&h.vault, view, args).await?, copy["views"][view], "{view}() in the sandbox vs mainnet");
        }
        println!("copy views: totals {}, state tree {}, label tree {}, {} spends: each equal to mainnet's", copy["views"]["totals"], copy["views"]["state_tree"], copy["views"]["label_tree"], copy["views"]["spends"].as_array().unwrap().len());
        // USDC: the vault registered and holding what mainnet USDC said it held at the same block
        let _ = h.storage_deposit(&h.root, &h.vault).await?;
        let held = u(&copy["usdc"]["ft_balance_of_vault"]);
        h.mint(&h.vault.clone(), held).await?;
        assert_eq!(h.token_balance(&h.vault).await?, held, "the vault's USDC is mainnet's");
        assert_eq!(h.view(&h.token, "storage_balance_of", json!({"account_id": h.vault})).await?, copy["usdc"]["storage_balance_of_vault"]);
        println!("USDC at {}: the vault holds {held} (mainnet's at block {})", h.token, copy["block"]["height"]);
        h.i1().await?;

        let depositor = h.account("u", 50).await?;
        let relayer = h.account("relayer", 50).await?;
        let cash = h.account("cash", 10).await?;
        assert_eq!((depositor.id().as_str(), relayer.id().as_str(), cash.id().as_str()), (f["depositor"].as_str().unwrap(), f["relayer"].as_str().unwrap(), f["cash"].as_str().unwrap()), "the fixture's accounts");
        // registered by root, so the relayer's key signs only what the helper sends
        for a in [relayer.id(), cash.id()] {
            let _ = h.storage_deposit(&h.root, a).await?;
        }
        let values = f["values"].as_array().unwrap();
        h.mint(depositor.id(), values.iter().map(u).sum()).await?;
        // three deposits as a user deposits
        let prepay = NearToken::from_yoctonear(PREPAY_BYTES * YOCTO_PER_BYTE);
        for (p, value) in f["precommitments"].as_array().unwrap().iter().zip(values) {
            let p = p.as_str().unwrap();
            let _ = h.call(&depositor, &h.vault, "storage_prepay", json!({"precommitment": p}), prepay, Gas::from_tgas(30)).await?;
            let msg = format!(r#"{{"precommitment":"{p}","depositor":"{}"}}"#, depositor.id());
            let o = h
                .call(&depositor, &h.token, "ft_transfer_call", json!({"receiver_id": h.vault, "amount": value, "msg": msg}), NearToken::from_yoctonear(1), Gas::from_tgas(180))
                .await?;
            let _ = o.calls_exactly(&h.vault, "ft_on_transfer", 1)?;
        }
        assert_eq!(h.view(&h.vault, "leaves", page.clone()).await?, f["leaves"], "the copied leaves grown by the three deposits");
        assert_eq!(h.view(&h.vault, "labels", page.clone()).await?, f["labels"], "the copied labels grown by the three deposits");
        assert_eq!(h.view(&h.vault, "state_tree", json!({})).await?["root"], f["state_root"], "the root every proof is made against");
        println!(
            "deposits: 3 notes ({}) on the copy, nonce {} -> {}; the state tree {} leaves, root {} (the proofs' root)",
            values.iter().map(|v| v.as_str().unwrap()).collect::<Vec<_>>().join(", "),
            f["nonce"].as_str().unwrap(),
            f["nonce"].as_str().unwrap().parse::<u64>()? + 3,
            f["leaves"].as_array().unwrap().len(),
            f["state_root"].as_str().unwrap()
        );
        h.i1().await?;
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos();
        let dir = std::env::temp_dir().join(format!("mainnet-copy-payouts-{}-{t}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        Ok(Self { h, depositor, relayer, cash, dir })
    }

    /// One relayer CLI run (a restart on the same stores): `requests` at once, then up to `rounds` outcome rounds.
    async fn carry(&self, requests: &[&str], rounds: u32) -> R<Value> {
        let rpc = self.h.worker.rpc_addr();
        let reqs: Vec<Value> = requests
            .iter()
            .map(|n| {
                let mut r = withdraw_args(n);
                r["fund_recipient"] = json!(false);
                r["token"] = json!(self.h.token);
                r
            })
            .collect();
        let v = node(json!({
            "rpc": [rpc, rpc], "vault": self.h.vault, "token": self.h.token, "scope": json_of(SPENDS)["scope"],
            "relayer": {"account_id": self.relayer.id(), "secret_key": self.relayer.secret_key().to_string()},
            "store": self.dir.join("send"), "nonces": self.dir.join("nonces"),
            "status": ["ok"], "requests": reqs, "rounds": rounds, "roundMs": 1000,
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

    async fn spends(&self) -> R<Vec<Value>> {
        Ok(self.h.view(&self.h.vault, "spends", json!({"from": 0, "limit": 1000})).await?.as_array().ok_or("spends")?.clone())
    }

    async fn spend_row(&self, name: &str) -> R<Value> {
        let n = nullifier(name);
        Ok(self.spends().await?.into_iter().find(|r| r["nullifier_hash"] == n).ok_or_else(|| format!("no spend of {name}"))?)
    }

    async fn tok(&self, id: &str) -> R<u128> {
        self.h.token_balance(&id.parse()?).await
    }

    /// A carried spend `name` (answer `i` of `v`): 200, the record succeeded and settled, the withdraw and its settle
    /// read at final with every receipt ok (their gas into the table); the withdraw transaction's raw status.
    async fn landed(&self, v: &Value, i: usize, name: &str) -> R<Value> {
        let a = &v["answers"][i];
        assert_eq!((a["status"].as_u64(), a["body"]["state"].as_str()), (Some(200), Some("submitted")), "{name}: {a}");
        let tx = a["body"]["tx_hash"].as_str().ok_or("no tx_hash")?;
        let row = &v["rows"][nullifier(name)];
        assert_eq!((row["outcome"].as_str(), row["tx_hash"].as_str(), row["settle"]["done"].as_bool()), (Some("succeeded"), Some(tx), Some(true)), "{name}: {row}");
        let o = self.h.tx_outcome(self.relayer.id(), tx).await?;
        o.expect_all_ok(&format!("{name}'s withdraw"))?;
        let _ = o.calls_exactly(&self.h.vault, "withdraw", 1)?;
        let _ = o.calls_exactly(&self.h.vault, "on_payout", 1)?;
        let settle_tx = row["settle"]["tx"]["tx_hash"].as_str().ok_or("no settle tx")?;
        let s = self.h.tx_outcome(self.relayer.id(), settle_tx).await?;
        s.expect_all_ok(&format!("{name}'s settle"))?;
        let _ = s.calls_exactly(&self.h.vault, "settle", 1)?;
        println!("{name}: withdraw tx {tx}, settle tx {settle_tx}");
        for r in o.receipts.iter().chain(&s.receipts) {
            println!("  {}", r.line());
        }
        Ok(self.h.rpc("EXPERIMENTAL_tx_status", json!({"tx_hash": tx, "sender_account_id": self.relayer.id(), "wait_until": "FINAL"})).await?["result"].clone())
    }

    /// The spends row of `name`: settled, paid whole (refund 0), to `to`, fee F, payer the relayer, its withdrawn the
    /// proof's; and its change leaf in the state tree is the proof's new commitment, Poseidon(change, label, precommitment)
    /// with the fixture's change value.
    async fn settled_to(&self, name: &str, to: &str) -> R<Value> {
        let (s, f, sp) = (self.spend_row(name).await?, json_of(SPENDS), spend(name));
        assert_eq!(
            (s["status"].as_str(), s["recipient"].as_str(), s["payer"].as_str(), s["fee"].as_str(), s["withdrawn"].as_str(), s["refund_value"].as_str()),
            (Some("settled"), Some(to), Some(self.relayer.id().as_str()), f["fee"].as_str(), sp["withdrawn"].as_str(), Some("0")),
            "{name}: {s}"
        );
        let idx = s["new_leaf_index"].as_u64().ok_or("new_leaf_index")?;
        let leaf = self.h.view(&self.h.vault, "leaves", json!({"from": idx, "limit": 1})).await?[0].clone();
        let change = commitment_on(sp["change_value"].as_str().unwrap(), sp["change_label"].as_str().unwrap(), sp["change_precommitment"].as_str().unwrap());
        assert_eq!((leaf.as_str(), sp["public_signals"][0].as_str()), (Some(change.as_str()), Some(change.as_str())), "{name}: the change leaf commits change {}", sp["change_value"]);
        println!("{name}: spends row {} settled to {to}, withdrawn {}, fee {}, refund 0; change leaf {idx} commits change value {}", s["index"], s["withdrawn"].as_str().unwrap(), s["fee"].as_str().unwrap(), sp["change_value"].as_str().unwrap());
        Ok(s)
    }
}

/// The token -> vault Transfers in a transaction's raw status: the token sending a registration deposit back.
fn token_refunds(tx: &Value, token: &str, vault: &str) -> Vec<u128> {
    tx["receipts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["predecessor_id"] == token && r["receiver_id"] == vault)
        .flat_map(|r| r["receipt"]["Action"]["actions"].as_array().cloned().unwrap_or_default())
        .filter_map(|a| a["Transfer"]["deposit"].as_str().and_then(|d| d.parse().ok()))
        .collect()
}

#[tokio::test]
async fn mainnet_copy_pays_a_buy_from_two_notes_and_a_cash_withdraw() -> R<()> {
    let w = World::new().await?;
    let (h, f) = (&w.h, json_of(SPENDS));
    let (vault, token) = (h.vault.to_string(), h.token.to_string());
    let (fee, min, buy) = (u(&f["fee"]), TOKEN_STORAGE.as_yoctonear(), u(&f["buy"]));
    let wid = f["w"].as_str().unwrap().to_string();
    let relayer = w.relayer.id().to_string();
    assert_eq!(u(&f["register_deposit"]), min);

    // A. the NEAR buy: two notes, two withdrawals at once, one fresh W
    let (a, b) = (spend("buy_whole"), spend("buy_change"));
    for s in [&a, &b] {
        assert!(u(&f["values"][s["note"].as_u64().unwrap() as usize]) - fee < buy, "a note alone pays the buy");
    }
    assert!(!exists(h, &wid).await?, "W exists before its payouts");
    let (w0, fee0, held0, near0) = (w.tok(&wid).await?, w.tok(&relayer).await?, w.tok(&vault).await?, h.near_balance(&h.vault).await?);
    assert_eq!(w0, 0);
    let v = w.carry(&["buy_whole", "buy_change"], 90).await?;
    let txa = w.landed(&v, 0, "buy_whole").await?;
    let txb = w.landed(&v, 1, "buy_change").await?;
    let (sa, sb) = (w.settled_to("buy_whole", &wid).await?, w.settled_to("buy_change", &wid).await?);
    let (pa, pb) = (u(&a["to_recipient"]), u(&b["to_recipient"]));
    let (w1, fee1, held1, near1) = (w.tok(&wid).await?, w.tok(&relayer).await?, w.tok(&vault).await?, h.near_balance(&h.vault).await?);
    assert_eq!(w1, pa + pb, "W holds the sum of the two parts");
    assert_eq!(w1, buy, "the two parts pay the buy");
    assert_eq!(fee1 - fee0, 2 * fee, "the fee account gained 2F");
    assert_eq!(held0 - held1, u(&sa["withdrawn"]) + u(&sb["withdrawn"]), "the vault paid out both withdrawals");
    assert_eq!(a["change_value"], "0", "one part planned whole");
    assert!(u(&b["change_value"]) > 2 * fee, "one part with change above two fees");
    let reg = h.view(&h.token, "storage_balance_of", json!({"account_id": wid})).await?;
    assert_eq!(reg["total"].as_str(), Some(min.to_string().as_str()), "W registered once: {reg}");
    let (ra, rb) = (token_refunds(&txa, &token, &vault), token_refunds(&txb, &token, &vault));
    let mut refunds = [ra.clone(), rb.clone()].concat();
    refunds.sort();
    assert_eq!(refunds, vec![min], "exactly one payout's registration came back to the vault (buy_whole {ra:?}, buy_change {rb:?})");
    assert!(!exists(h, &wid).await?, "W was created by its payouts");
    println!(
        "A. W {wid}: ft_balance_of {w1} = {pa} + {pb} (buy {buy}); fee account +{} (2F); vault USDC -{}; W storage {}; second registration refunded to the vault: {} yocto (buy_whole {ra:?}, buy_change {rb:?}); vault NEAR {near0} -> {near1} ({}{} yocto over both withdrawals and settles); W still not an account",
        fee1 - fee0, held0 - held1, reg["total"].as_str().unwrap(), min,
        if near1 >= near0 { "+" } else { "-" }, near1.abs_diff(near0)
    );

    // B. the Cash withdraw: a whole note to a named, registered account
    let c = spend("cash_whole");
    let cash = w.cash.id().to_string();
    let (c0, fee0, near0) = (w.tok(&cash).await?, w.tok(&relayer).await?, h.near_balance(&h.vault).await?);
    let v = w.carry(&["cash_whole"], 90).await?;
    let txc = w.landed(&v, 0, "cash_whole").await?;
    let sc = w.settled_to("cash_whole", &cash).await?;
    let (c1, fee1, near1) = (w.tok(&cash).await?, w.tok(&relayer).await?, h.near_balance(&h.vault).await?);
    assert_eq!(c1 - c0, u(&c["to_recipient"]), "cash.test.near up by exactly the part");
    assert_eq!(u(&sc["withdrawn"]), u(&f["values"][2]), "the whole note");
    assert_eq!(fee1 - fee0, fee, "the fee account gained F");
    assert_eq!(token_refunds(&txc, &token, &vault), vec![min], "cash.test.near's registration came back to the vault");
    println!("B. {cash}: {c0} -> {c1} (+{}, note 3 of {} whole less F); fee account +{fee}; registration refunded {min}; vault NEAR {near0} -> {near1}", c1 - c0, sc["withdrawn"].as_str().unwrap());

    // C. the same note's proof again: refused, nothing moves
    let n0 = w.key_nonce().await?;
    let snap = async || -> R<(u128, u128, u128, u128, Value, usize, Value)> {
        Ok((w.tok(&wid).await?, w.tok(&relayer).await?, w.tok(&vault).await?, w.tok(&cash).await?, h.view(&h.vault, "totals", json!({})).await?, w.spends().await?.len(), h.view(&h.vault, "state_tree", json!({})).await?))
    };
    let s0 = snap().await?;
    let v = w.carry(&["buy_whole"], 0).await?;
    let ans = &v["answers"][0];
    assert_eq!((ans["status"].as_u64(), ans["body"]["error"]["code"].as_str()), (Some(400), Some("spent")), "{ans}");
    assert_eq!(w.key_nonce().await?, n0, "the helper signs nothing for a spent note");
    let o = h.call_outcome(&w.depositor, &h.vault, "withdraw", withdraw_args("buy_whole"), NearToken::from_millinear(100), Gas::from_tgas(300)).await?;
    assert!(!o.all_ok(), "the same proof landed twice");
    let why = o.failure().map(str::to_string).or_else(|| o.failures().first().map(|r| r.line())).unwrap_or_default();
    assert!(why.contains("NullifierAlreadySpent"), "want NullifierAlreadySpent: {why}");
    let s1 = snap().await?;
    assert!(s0 == s1, "a refused spend moved something: {s0:?} -> {s1:?}");
    println!("C. buy_whole again: the helper 400 spent (relayer nonce {n0} unmoved); straight to the vault: {}; W, fee account, vault and cash USDC, totals, {} spends and the state tree unchanged", why.chars().take(160).collect::<String>(), s1.5);

    h.i1().await?;
    println!("{}", h.gas_table());
    Ok(())
}
