// SPDX-License-Identifier: Apache-2.0
//! VT-S01 (vault.md 5, V:1128; 2.8), in near-sandbox 2.13.4 at protocol 86, on the real USDC wasm. Runs only with
//! `--features sandbox`, through tests/harness/run.sh (`contracts/vault/tests/harness/run.sh --test s01`); a plain
//! `cargo test` builds this file empty.
//!
//! `nobody_holds_a_key_to_the_vault`: contracts/vault/scripts/deploy.mjs deploys the release build (`VAULT_WASM`) by
//! the 2.8 recipe and registers it on the real USDC at TOKEN, signed with the sandbox's own genesis key (the root
//! account's, written to a temp file outside the repo). Then:
//! - `view_access_key_list` reads `keys: []` on two reads (optimistic and final; the sandbox has one RPC);
//! - `storage_balance_of(vault)` on USDC is set;
//! - AddKey, DeleteAccount and DeployContract on the vault, each sent by the parent and by a stranger, are each
//!   refused with `ActorNoPermission` (NC `actions.rs` l.776-813), and afterwards the keys are still `[]`, the code
//!   hash and the balance unchanged;
//! - the wasm's imports hold none of 2.8's banned actions, its promise imports are exactly the seven of 2.8, its
//!   function exports equal 2.5.7's list, and its outgoing method names are `storage_deposit`, `ft_transfer` and
//!   `on_payout`: each is in its bytes, and none of the token's other mutating methods is.
#![cfg(feature = "sandbox")]

mod harness;

use harness::{Harness, R};
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, KeyType, SecretKey};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::process::Command;

/// vault.md 2.8: imports that let the code act on its own account (NC near-vm-runner imports.rs l.198-283); a name
/// ending in `*` is a prefix.
const BANNED: [&str; 12] = [
    "promise_batch_action_create_account",
    "promise_batch_action_deploy_contract",
    "promise_batch_action_deploy_global_contract*",
    "promise_batch_action_use_global_contract*",
    "promise_batch_action_state_init*",
    "promise_batch_action_stake",
    "promise_batch_action_add_key_with_full_access",
    "promise_batch_action_add_key_with_function_call",
    "promise_batch_action_delete_key",
    "promise_batch_action_delete_account",
    "promise_batch_action_add_gas_key_*",
    "promise_batch_action_transfer_to_gas_key",
];
/// vault.md 2.8: its promise imports are exactly these.
const PROMISES: [&str; 7] = [
    "promise_batch_create",
    "promise_batch_then",
    "promise_and",
    "promise_batch_action_function_call_weight",
    "promise_batch_action_transfer",
    "promise_results_count",
    "promise_result",
];
/// vault.md 2.5.7: the function exports, the methods and 2.5.6's views, and near-sdk's contract_source_metadata.
const EXPORTS: [&str; 17] = [
    "storage_prepay",
    "ft_on_transfer",
    "withdraw",
    "ragequit",
    "on_payout",
    "settle",
    "config",
    "state_tree",
    "label_tree",
    "leaves",
    "labels",
    "deposits",
    "spends",
    "is_known_state_root",
    "is_known_label_root",
    "totals",
    "contract_source_metadata",
];
/// The vault's outgoing calls (2.5): to the token and to itself.
const OUTGOING: [&str; 3] = ["storage_deposit", "ft_transfer", "on_payout"];
/// NEP-141 and NEP-145 mutating methods the vault never calls (2.5.7: it never unregisters or withdraws storage).
const NEVER_CALLED: [&str; 4] = ["ft_transfer_call", "storage_unregister", "storage_withdraw", "near_withdraw"];

/// A wasm module's (imports as (module, name, kind), exports as (name, kind)), from sections 2 and 7.
fn wasm_lists(w: &[u8]) -> (Vec<(String, String, u8)>, Vec<(String, u8)>) {
    fn leb(b: &[u8], p: &mut usize) -> u64 {
        let (mut r, mut s) = (0u64, 0);
        loop {
            let x = b[*p];
            *p += 1;
            r |= ((x & 0x7f) as u64) << s;
            s += 7;
            if x & 0x80 == 0 {
                return r;
            }
        }
    }
    fn name(b: &[u8], p: &mut usize) -> String {
        let n = leb(b, p) as usize;
        let s = String::from_utf8_lossy(&b[*p..*p + n]).to_string();
        *p += n;
        s
    }
    fn limits(b: &[u8], p: &mut usize) {
        let f = b[*p];
        *p += 1;
        leb(b, p);
        if f & 1 == 1 {
            leb(b, p);
        }
    }
    assert_eq!(&w[..4], b"\0asm", "not a wasm module");
    let (mut imports, mut exports, mut p) = (vec![], vec![], 8);
    while p < w.len() {
        let id = w[p];
        p += 1;
        let size = leb(w, &mut p) as usize;
        let end = p + size;
        if id == 2 {
            for _ in 0..leb(w, &mut p) {
                let (m, n) = (name(w, &mut p), name(w, &mut p));
                let kind = w[p];
                p += 1;
                match kind {
                    0 => {
                        leb(w, &mut p);
                    }
                    1 => {
                        p += 1;
                        limits(w, &mut p);
                    }
                    2 => limits(w, &mut p),
                    3 => p += 2,
                    _ => panic!("import kind {kind}"),
                }
                imports.push((m, n, kind));
            }
        } else if id == 7 {
            for _ in 0..leb(w, &mut p) {
                let n = name(w, &mut p);
                let kind = w[p];
                p += 1;
                leb(w, &mut p);
                exports.push((n, kind));
            }
        }
        p = end;
    }
    (imports, exports)
}

fn has(hay: &[u8], needle: &str) -> bool {
    hay.windows(needle.len()).any(|w| w == needle.as_bytes())
}

/// Runs contracts/vault/scripts/deploy.mjs against this sandbox with the root's genesis key in a temp file outside the
/// repo (removed afterwards); its exit code, stdout, stderr and record.
async fn run_deploy_script(h: &Harness) -> R<(i32, String, String, Option<Value>)> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scripts/deploy.mjs");
    let wasm = std::env::var("VAULT_WASM").map_err(|_| "VAULT_WASM is not set: run through tests/harness/run.sh")?;
    let dir = std::env::temp_dir().join(format!("vts-deploy-s01-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()));
    std::fs::create_dir_all(&dir)?;
    let (key, out) = (dir.join("sandbox-genesis-key.json"), dir.join("record.json"));
    let sk = h.root.secret_key();
    std::fs::write(&key, json!({"account_id": h.root.id(), "public_key": sk.public_key().to_string(), "private_key": sk.to_string()}).to_string())?;
    let rpc = h.worker.rpc_addr();
    let res = Command::new("node")
        .arg(&script)
        .args(["--network", "sandbox", "--rpc", &rpc, "--parent", h.root.id().as_str(), "--wasm", &wasm])
        .arg("--key-file")
        .arg(&key)
        .arg("--out")
        .arg(&out)
        .output()?;
    let record = std::fs::read_to_string(&out).ok().and_then(|s| serde_json::from_str(&s).ok());
    std::fs::remove_dir_all(&dir)?;
    let (so, se) = (String::from_utf8_lossy(&res.stdout).to_string(), String::from_utf8_lossy(&res.stderr).to_string());
    println!("deploy.mjs exit {:?}\n--- stdout\n{so}--- stderr\n{se}", res.status.code());
    Ok((res.status.code().unwrap_or(-1), so, se, record))
}

/// The transaction was refused with `ActorNoPermission`.
fn refused(what: &str, r: &ExecutionFinalResult) {
    let e = format!("{:?}", r.clone().into_result().err());
    println!("{what}: {}", if e.len() > 300 { &e[..300] } else { &e });
    assert!(e.contains("ActorNoPermission"), "{what} was not refused with ActorNoPermission: {e}");
}

/// `view_access_key_list` of the vault is `[]` on two reads, at optimistic and at final.
async fn keys_are_empty(h: &Harness) -> R<()> {
    for fin in ["optimistic", "final"] {
        let keys = h.access_keys(&h.vault, fin).await?;
        println!("view_access_key_list {} at {fin}: {keys:?}", h.vault);
        if !keys.is_empty() {
            return Err(format!("the vault has an access key at {fin}: {keys:?}").into());
        }
    }
    Ok(())
}

#[tokio::test]
async fn nobody_holds_a_key_to_the_vault() -> R<()> {
    let mut h = Harness::start().await?;
    h.deploy_usdc().await?;
    let (code, _, stderr, rec) = run_deploy_script(&h).await?;
    assert_eq!(code, 0, "deploy.mjs failed: {stderr}");
    assert_eq!(rec.expect("no record")["account_id"], json!(h.vault.as_str()));
    h.wait_final(&h.vault).await?;

    keys_are_empty(&h).await?;
    let reg = h.view(&h.token, "storage_balance_of", json!({"account_id": h.vault})).await?;
    println!("USDC storage_balance_of(vault): {reg}");
    assert!(!reg.is_null(), "the vault is not registered on USDC");
    let before = h.account_view(&h.vault, "final").await?;

    // every key or code action on the vault, by the parent and by a stranger: refused
    let stranger = h.account("stranger", 20).await?;
    let mock = std::fs::read(std::env::var("MOCK_TOKEN_WASM")?)?;
    for (who, by) in [("parent", &h.root), ("stranger", &stranger)] {
        let pk = SecretKey::from_random(KeyType::ED25519).public_key();
        refused(&format!("AddKey(full access) by the {who}"), &by.batch(&h.vault).add_key(pk.clone(), AccessKey::full_access()).transact().await?);
        refused(
            &format!("AddKey(function call) by the {who}"),
            &by.batch(&h.vault).add_key(pk, AccessKey::function_call_access(&h.vault, &["withdraw"], None)).transact().await?,
        );
        refused(&format!("DeleteAccount by the {who}"), &by.batch(&h.vault).delete_account(by.id()).transact().await?);
        refused(&format!("DeployContract by the {who}"), &by.batch(&h.vault).deploy(&mock).transact().await?);
    }
    keys_are_empty(&h).await?;
    let after = h.account_view(&h.vault, "final").await?;
    assert_eq!(after["code_hash"], before["code_hash"], "the vault's code changed");
    assert_eq!(after["amount"], before["amount"], "the vault's balance changed");

    // the wasm: imports, exports, outgoing method names
    let wasm = std::fs::read(std::env::var("VAULT_WASM")?)?;
    let (imports, exports) = wasm_lists(&wasm);
    let funcs: Vec<&str> = imports.iter().filter(|i| i.2 == 0).map(|i| i.1.as_str()).collect();
    let banned: Vec<&&str> =
        funcs.iter().filter(|n| BANNED.iter().any(|b| b.strip_suffix('*').map_or(**n == *b, |pre| n.starts_with(pre)))).collect();
    println!("imports ({}): {funcs:?}", funcs.len());
    assert!(banned.is_empty(), "banned imports: {banned:?}");
    let promises: BTreeSet<&str> = funcs.iter().copied().filter(|n| n.starts_with("promise_")).collect();
    assert_eq!(promises, PROMISES.into_iter().collect::<BTreeSet<_>>(), "the promise imports are not 2.8's seven");
    let exported: BTreeSet<&str> = exports.iter().filter(|e| e.1 == 0).map(|e| e.0.as_str()).collect();
    println!("function exports ({}): {exported:?}", exported.len());
    assert_eq!(exported, EXPORTS.into_iter().collect::<BTreeSet<_>>(), "the exports are not 2.5.7's list");
    for m in OUTGOING {
        assert!(has(&wasm, m), "the wasm does not name {m}");
    }
    let never: Vec<&str> = NEVER_CALLED.into_iter().filter(|m| has(&wasm, m)).collect();
    assert!(never.is_empty(), "the wasm names a method it must never call: {never:?}");
    println!("\ngas table\n{}", h.gas_table());
    Ok(())
}
