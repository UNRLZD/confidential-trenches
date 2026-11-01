// SPDX-License-Identifier: Apache-2.0
//! VT-S20 (vault.md 5, V:1147; the 2.8 recipe), in near-sandbox 2.13.4 at protocol 86. Runs only with
//! `--features sandbox`, through tests/harness/run.sh (`contracts/vault/tests/harness/run.sh --test s20`); a plain
//! `cargo test` builds this file empty.
//!
//! 1. `an_oversized_build_rolls_the_whole_batch_back` (red half): the recipe batch [CreateAccount, Transfer,
//!    DeployContract, FunctionCall(config)] with a wasm one of whose function bodies is over `max_function_body_size`
//!    (196,608 B, `parameters.snap` l.233). The deploy stores the code without compiling it (2.8), so the batch fails
//!    at the FunctionCall (`FunctionBodyTooLarge`), the whole receipt rolls back, no vault account is left, and the
//!    parent's balance differs only by the gas burnt. The wasm is made here, one `config` export whose body is
//!    200,000 B of `nop`: the same failure the first oversized build met, without building that build again.
//! 2. `the_deploy_script_refuses_this_build_before_any_send`: contracts/vault/scripts/deploy.mjs, run against this
//!    sandbox with the sandbox's own genesis key (the root account's, written to a temp file outside the repo), builds
//!    the vault twice from clean (the mainnet build), finds both builds equal and refuses before any send, naming
//!    `withdrawWithoutPayout`: this source exports withdraw while the payout path (on_payout) has not landed, a build
//!    that would spend a note it cannot pay out. No vault account is made, no record is written, and the parent's
//!    nonce and balance are unchanged. The script lands a vault once the payout path does.
//! 3. `the_release_build_lands_by_the_recipe_keyless` (green half): the same release build (`VAULT_WASM`) by the 2.8
//!    recipe from the harness (`Harness::deploy_vault`), then registered on the token. The transaction holds exactly
//!    the four recipe actions and no AddKey; `config()` answers; `view_access_key_list` reads `keys: []` at optimistic
//!    and at final; the code hash is the wasm's; every function body is at most 196,608 B; the vault is registered on the
//!    token; the wasm's size and sha256 are printed (2.11's code row). Then the vault's first state-writing call (a
//!    904 B `storage_prepay`) writes the contract's state record (2.3, 200 B), and the vault's free NEAR (amount less
//!    storage) is still at least 0; then the first deposit lands on that prepay (a user's own `ft_transfer_call` of
//!    1 USDC with the kit's message), and the free NEAR read after it is still at least 0.
#![cfg(feature = "sandbox")]

mod harness;

use harness::{Harness, R, TOKEN, YOCTO_PER_BYTE};
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::operations::Function;
use near_workspaces::types::{Gas, NearToken};
use std::path::PathBuf;
use std::process::Command;

/// nearcore `max_function_body_size` at protocol 86 (`parameters.snap` l.233).
pub const MAX_FUNCTION_BODY: usize = 196_608;
/// 2.3: the deposit's bytes when no tree grows a level, and the `prepaid` record it frees.
const PREPAID_RECORD_BYTES: u128 = 89;
/// `MIN_DEPOSIT`, 1 USDC (2.2).
const AMOUNT: u128 = 1_000_000;
/// The kit's prepay whenever a tree may grow (2.10 (h)).
const KIT_PREPAY_BYTES: u128 = 904;

/// The sizes of every function body in a wasm module's code section (section 10).
pub fn function_bodies(wasm: &[u8]) -> Vec<usize> {
    fn leb(b: &[u8], p: &mut usize) -> usize {
        let (mut r, mut s) = (0usize, 0);
        loop {
            let x = b[*p];
            *p += 1;
            r |= ((x & 0x7f) as usize) << s;
            s += 7;
            if x & 0x80 == 0 {
                return r;
            }
        }
    }
    assert_eq!(&wasm[..4], b"\0asm", "not a wasm module");
    let mut p = 8;
    while p < wasm.len() {
        let id = wasm[p];
        p += 1;
        let size = leb(wasm, &mut p);
        let end = p + size;
        if id == 10 {
            let mut bodies = vec![];
            for _ in 0..leb(wasm, &mut p) {
                let n = leb(wasm, &mut p);
                bodies.push(n);
                p += n;
            }
            return bodies;
        }
        p = end;
    }
    vec![]
}

/// A wasm module with one exported function `config` whose body is `body` bytes long: 0 locals, `nop`s, `end`.
pub fn oversized_wasm(body: usize) -> Vec<u8> {
    fn leb(mut n: usize, out: &mut Vec<u8>) {
        loop {
            let b = (n & 0x7f) as u8;
            n >>= 7;
            if n == 0 {
                out.push(b);
                return;
            }
            out.push(b | 0x80);
        }
    }
    fn section(id: u8, payload: Vec<u8>, out: &mut Vec<u8>) {
        out.push(id);
        leb(payload.len(), out);
        out.extend(payload);
    }
    let mut w = b"\0asm\x01\0\0\0".to_vec();
    section(1, vec![1, 0x60, 0, 0], &mut w); // one type: () -> ()
    section(3, vec![1, 0], &mut w); // one function of type 0
    let mut export = vec![1, 6];
    export.extend(b"config");
    export.extend([0, 0]); // a function, index 0
    section(7, export, &mut w);
    let mut b = vec![0]; // no locals
    b.extend(std::iter::repeat(0x01).take(body - 2)); // nop
    b.push(0x0b); // end
    let mut code = vec![1];
    leb(b.len(), &mut code);
    code.extend(b);
    section(10, code, &mut w);
    w
}

/// The sum of `tokens_burnt` over the transaction's own outcome and every receipt's, read at FINAL.
pub async fn tokens_burnt(h: &Harness, tx_hash: &str, signer: &str) -> R<u128> {
    let v = h.rpc("EXPERIMENTAL_tx_status", json!({"tx_hash": tx_hash, "sender_account_id": signer, "wait_until": "FINAL"})).await?;
    let r = &v["result"];
    let mut sum: u128 = r["transaction_outcome"]["outcome"]["tokens_burnt"].as_str().ok_or_else(|| format!("tx {tx_hash}: {v}"))?.parse()?;
    for ro in r["receipts_outcome"].as_array().ok_or_else(|| format!("tx {tx_hash}: {v}"))? {
        sum += ro["outcome"]["tokens_burnt"].as_str().ok_or("no tokens_burnt")?.parse::<u128>()?;
    }
    Ok(sum)
}

/// The kinds of the transaction's own actions, read at FINAL (a function call by `FunctionCall:<method>`).
pub async fn tx_actions(h: &Harness, tx_hash: &str, signer: &str) -> R<(Vec<String>, Value)> {
    let v = h.rpc("EXPERIMENTAL_tx_status", json!({"tx_hash": tx_hash, "sender_account_id": signer, "wait_until": "FINAL"})).await?;
    let r = v["result"].clone();
    let kinds = r["transaction"]["actions"]
        .as_array()
        .ok_or_else(|| format!("tx {tx_hash}: {v}"))?
        .iter()
        .map(|a| match a {
            Value::String(s) => s.clone(),
            Value::Object(o) if o.contains_key("FunctionCall") => format!("FunctionCall:{}", a["FunctionCall"]["method_name"].as_str().unwrap_or("")),
            Value::Object(o) => o.keys().next().cloned().unwrap_or_default(),
            _ => a.to_string(),
        })
        .collect();
    Ok((kinds, r))
}

/// What deploy.mjs printed and wrote for one run.
pub struct ScriptRun {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub record: Option<Value>,
    /// The wasm the script deployed: the one it built, or `VAULT_WASM`.
    pub wasm: Vec<u8>,
}

/// Runs contracts/vault/scripts/deploy.mjs against this sandbox: `--network sandbox --rpc <sandbox> --parent <root>
/// --key-file <the root's genesis key, in a temp file outside the repo> --out <temp file>`, and `--build-dir <temp dir>`
/// when `build` (the script builds twice), else `--wasm <VAULT_WASM>`. The temp files are removed afterwards.
pub async fn run_deploy_script(h: &Harness, build: bool) -> R<ScriptRun> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scripts/deploy.mjs");
    let wasm = std::env::var("VAULT_WASM").map_err(|_| "VAULT_WASM is not set: run through tests/harness/run.sh")?;
    let dir = std::env::temp_dir().join(format!("vts-deploy-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()));
    std::fs::create_dir_all(&dir)?;
    let key = dir.join("sandbox-genesis-key.json");
    let sk = h.root.secret_key();
    std::fs::write(&key, json!({"account_id": h.root.id(), "public_key": sk.public_key().to_string(), "private_key": sk.to_string()}).to_string())?;
    let out = dir.join("record.json");
    let rpc = h.worker.rpc_addr();
    let (k, o) = (key.to_string_lossy().to_string(), out.to_string_lossy().to_string());
    let built = dir.join("build");
    let b = built.to_string_lossy().to_string();
    let mut args = vec!["--network", "sandbox", "--rpc", rpc.as_str(), "--parent", h.root.id().as_str(), "--key-file", k.as_str(), "--out", o.as_str()];
    args.extend(if build { ["--build-dir", b.as_str()] } else { ["--wasm", wasm.as_str()] });
    let res = Command::new("node").arg(&script).args(&args).output()?;
    let run = ScriptRun {
        wasm: std::fs::read(if build { built.join("blindfill_vault.wasm") } else { PathBuf::from(&wasm) }).unwrap_or_default(),
        code: res.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&res.stdout).to_string(),
        stderr: String::from_utf8_lossy(&res.stderr).to_string(),
        record: std::fs::read_to_string(&out).ok().and_then(|s| serde_json::from_str(&s).ok()),
    };
    std::fs::remove_dir_all(&dir)?;
    println!("deploy.mjs exit {}\n--- stdout\n{}--- stderr\n{}", run.code, run.stdout, run.stderr);
    Ok(run)
}

#[tokio::test]
async fn an_oversized_build_rolls_the_whole_batch_back() -> R<()> {
    let h = Harness::start().await?;
    let wasm = oversized_wasm(200_000);
    let bodies = function_bodies(&wasm);
    assert_eq!(bodies, vec![200_000], "the planted wasm's body");
    assert!(bodies[0] > MAX_FUNCTION_BODY);
    let before = h.near_balance(h.root.id()).await?;
    let transfer = (wasm.len() as u128 + 100) * YOCTO_PER_BYTE + NearToken::from_millinear(10).as_yoctonear();
    let result = h
        .root
        .batch(&h.vault)
        .create_account()
        .transfer(NearToken::from_yoctonear(transfer))
        .deploy(&wasm)
        .call(Function::new("config").args(vec![]).gas(Gas::from_tgas(100)).deposit(NearToken::from_yoctonear(0)))
        .transact()
        .await?;
    let tx_hash = result.outcome().transaction_hash.to_string();
    let failure = format!("{:?}", result.clone().into_result().err());
    println!("oversized recipe {tx_hash}: {failure}");
    assert!(failure.contains("FunctionBodyTooLarge"), "the batch did not fail at the FunctionCall with FunctionBodyTooLarge: {failure}");
    let (kinds, _) = tx_actions(&h, &tx_hash, h.root.id().as_str()).await?;
    assert_eq!(kinds, ["CreateAccount", "Transfer", "DeployContract", "FunctionCall:config"]);

    let gone = h.rpc("query", json!({"request_type": "view_account", "finality": "final", "account_id": h.vault})).await?;
    println!("view_account {} after the rollback: {gone}", h.vault);
    assert!(gone.to_string().contains("UNKNOWN_ACCOUNT") || gone.to_string().contains("does not exist"), "a vault account is left: {gone}");
    let after = h.near_balance(h.root.id()).await?;
    let burnt = tokens_burnt(&h, &tx_hash, h.root.id().as_str()).await?;
    println!("parent balance before {before}, after {after}, differs by {}; tokens burnt {burnt}", before - after);
    assert_eq!(before - after, burnt, "the parent's balance differs by more than the burnt gas");
    Ok(())
}

#[tokio::test]
async fn the_deploy_script_refuses_this_build_before_any_send() -> R<()> {
    let h = Harness::start().await?;
    let pk = h.root.secret_key().public_key().to_string();
    let nonce = |v: Value| v["result"]["nonce"].as_u64().ok_or_else(|| format!("view_access_key: {v}"));
    let key_query = json!({"request_type": "view_access_key", "finality": "optimistic", "account_id": h.root.id(), "public_key": pk});
    let (nonce0, balance0) = (nonce(h.rpc("query", key_query.clone()).await?)?, h.near_balance(h.root.id()).await?);
    let run = run_deploy_script(&h, true).await?;
    assert_eq!(run.code, 1, "deploy.mjs did not refuse: {}", run.stderr);
    assert!(run.stdout.contains("reproducible: both builds sha256 "), "deploy.mjs did not build twice to one sha256");
    assert!(
        run.stderr.contains("refused before any send: withdrawWithoutPayout (vault.md 2.8, 2.5.7): withdraw"),
        "deploy.mjs did not refuse naming withdrawWithoutPayout: {}",
        run.stderr
    );
    assert!(run.record.is_none(), "deploy.mjs wrote a record");
    assert!(!run.stdout.contains("sending ["), "deploy.mjs sent the recipe");
    let gone = h.rpc("query", json!({"request_type": "view_account", "finality": "final", "account_id": h.vault})).await?;
    println!("view_account {} after the refusal: {gone}", h.vault);
    assert!(gone.to_string().contains("UNKNOWN_ACCOUNT") || gone.to_string().contains("does not exist"), "a vault account exists: {gone}");
    let (nonce1, balance1) = (nonce(h.rpc("query", key_query).await?)?, h.near_balance(h.root.id()).await?);
    println!("parent nonce {nonce0} -> {nonce1}, balance {balance0} -> {balance1}");
    assert_eq!((nonce1, balance1), (nonce0, balance0), "the parent's nonce or balance changed: something was sent");
    Ok(())
}

#[tokio::test]
async fn the_release_build_lands_by_the_recipe_keyless() -> R<()> {
    let h = Harness::start().await?;
    h.deploy_mock_token().await?;
    let deployed = h.deploy_vault().await?;
    let _ = h.storage_deposit(&h.root, &h.vault).await?;
    let wasm = h.vault_wasm.clone();

    // the transaction: exactly the four recipe actions, no AddKey
    let tx = deployed.tx_hash.clone();
    let (kinds, r) = tx_actions(&h, &tx, h.root.id().as_str()).await?;
    println!("recipe tx {tx}: {kinds:?}");
    assert_eq!(kinds, ["CreateAccount", "Transfer", "DeployContract", "FunctionCall:config"]);
    assert!(r["status"]["SuccessValue"].is_string(), "the recipe did not land: {}", r["status"]);
    for ro in r["receipts_outcome"].as_array().unwrap() {
        assert!(ro["outcome"]["status"].get("Failure").is_none(), "a failed receipt: {ro}");
    }
    let transfer = (wasm.len() as u128 + 100) * YOCTO_PER_BYTE + NearToken::from_millinear(10).as_yoctonear();
    assert_eq!(r["transaction"]["actions"][1]["Transfer"]["deposit"], json!(transfer.to_string()), "Transfer is not code storage + 0.01 N");
    let sha: String = near_sdk::env::sha256(&wasm).iter().map(|b| format!("{b:02x}")).collect();

    // config() answers; keys [] at optimistic and at final; the code is the wasm's
    let cfg = h.view(&h.vault, "config", json!({})).await?;
    println!("config(): {cfg}");
    assert_eq!(cfg["asset"], TOKEN);
    h.wait_final(&h.vault).await?;
    for fin in ["optimistic", "final"] {
        let keys = h.access_keys(&h.vault, fin).await?;
        println!("view_access_key_list {} at {fin}: {keys:?}", h.vault);
        assert!(keys.is_empty(), "the vault has an access key at {fin}: {keys:?}");
    }
    let acct = h.account_view(&h.vault, "final").await?;
    assert_eq!(acct["code_hash"], json!(harness::code_hash(&wasm)));

    // every function body under the limit; size and sha256 recorded
    let bodies = function_bodies(&wasm);
    let max = *bodies.iter().max().unwrap();
    println!("vault wasm {} B, sha256 {sha}, {} functions, largest body {max} B (limit {MAX_FUNCTION_BODY})", wasm.len(), bodies.len());
    assert!(max <= MAX_FUNCTION_BODY, "a function body of {max} B");

    // registered on the token
    let reg = h.view(&h.token, "storage_balance_of", json!({"account_id": h.vault})).await?;
    println!("storage_balance_of(vault): {reg}");
    assert!(!reg.is_null(), "the vault is not registered on the token");

    // the first state-writing call writes the state record; the vault's free NEAR stays at least 0
    let (amount0, usage0) = (h.near_balance(&h.vault).await?, acct["storage_usage"].as_u64().unwrap() as u128);
    let stranger = h.account("stranger", 10).await?;
    let p = "12345678901234567890";
    let _ = h
        .call(&stranger, &h.vault, "storage_prepay", json!({"precommitment": p}), NearToken::from_yoctonear(KIT_PREPAY_BYTES * YOCTO_PER_BYTE), Gas::from_tgas(30))
        .await?;
    let a = h.account_view(&h.vault, "final").await?;
    let (amount1, usage1) = (a["amount"].as_str().unwrap().parse::<u128>()?, a["storage_usage"].as_u64().unwrap() as u128);
    let free = amount1 as i128 - (usage1 * YOCTO_PER_BYTE) as i128;
    println!(
        "vault before the first prepay: amount {amount0}, storage {usage0} B; after: amount {amount1}, storage {usage1} B (+{} B: 89 B prepaid record + the state record); free {free} yocto",
        usage1 - usage0
    );
    assert!(usage1 - usage0 > PREPAID_RECORD_BYTES, "the first prepay wrote no state record");
    assert!(free >= 0, "the vault's free NEAR is below 0 after its first state write");

    // the first deposit: U's own ft_transfer_call with the kit's message on the prepaid precommitment
    let u = h.account("u", 10).await?;
    h.mint(u.id(), AMOUNT).await?;
    let msg = format!(r#"{{"precommitment":"{p}","depositor":"{}"}}"#, u.id());
    let o = h
        .call(&u, &h.token, "ft_transfer_call", json!({"receiver_id": h.vault, "amount": AMOUNT.to_string(), "msg": msg}), NearToken::from_yoctonear(1), Gas::from_tgas(180))
        .await?;
    let on = o.calls_exactly(&h.vault, "ft_on_transfer", 1)?;
    println!("first deposit {}: {}", o.tx_hash, on[0].line());
    assert_eq!(h.token_balance(&h.vault).await?, AMOUNT, "the first deposit did not land in the vault");
    let a = h.account_view(&h.vault, "final").await?;
    let (amount2, usage2) = (a["amount"].as_str().unwrap().parse::<u128>()?, a["storage_usage"].as_u64().unwrap() as u128);
    let free2 = amount2 as i128 - (usage2 * YOCTO_PER_BYTE) as i128;
    println!("vault after the first deposit: amount {amount2}, storage {usage2} B ({:+} B); free {free2} yocto", usage2 as i128 - usage1 as i128);
    assert!(free2 >= 0, "the vault's free NEAR is below 0 after the first deposit");
    println!("\ngas table\n{}", h.gas_table());
    Ok(())
}
