// SPDX-License-Identifier: Apache-2.0
//! Card exit-every-note-kind-on-a-mainnet-copy: with no server of ours, the exit command finds each kind of note the
//! wallet makes from the 12 words alone and withdraws it, on a copy of the mainnet vault (its deployed code and every
//! state record, tests/fixtures/mainnet-vault-copy.json, at the release's id) beside the real USDC wasm at mainnet
//! USDC's id, in near-sandbox. Never a test network.
//!
//! The kinds are the ones the exit tool's scan takes (packages/exit/src/scan.ts runs the wallet's restoreNotes,
//! packages/wallet/src/notes/restore.ts l.407-483, unchanged), each seeded by the vault's own paths on the published
//! all-zero words' secrets (packages/exit/test/every-kind-cli.ts):
//! 1. a pending refund: deposit note (scope, 0) withdrawn whole to an account the token has never seen, with a
//!    register_deposit of 1 yocto, below USDC's storage minimum, so the payout bounces and the spend stays
//!    refund_pending (as payouts.rs a_registration_below_the_minimum does); the exit tool settles it by A and withdraws
//!    the refund note the settle writes;
//! 2. a move note V(l, 0), 3. a return note R(sol, l, 0) and 4. A(l, 0)'s second arrival (the arming account's deposit
//!    back), each deposited on its precommitment after that spend (l, 0), as the arm's legs bring money back;
//! 5. a second arrival U(scope, 0) n = 0 on the deposit's own id.
//! Each kind carries its own value, so every one is named on chain: the typed account X holds their sum, and each
//! value is a settled spend to X. A kind the scan drops (contracts/vault/tests/harness/run.sh --test exit_every_kind on
//! restore.ts with that kind's line removed) leaves its value in the vault and fails here.
//!
//! Runs only under the sandbox feature (`contracts/vault/tests/harness/run.sh --test exit_every_kind`).
#![cfg(feature = "sandbox")]

mod harness;

use harness::{Harness, R, YOCTO_PER_BYTE};
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::types::{AccountDetailsPatch, Gas, NearToken};
use near_workspaces::{Account, AccountId};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

const COPY: &str = include_str!("fixtures/mainnet-vault-copy.json");
const RELEASE: &str = include_str!("../deployments/mainnet-v1.json");
const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
/// The kit's prepay whenever a tree may grow (2.10 (h)).
const PREPAY_BYTES: u128 = 904;
/// Each kind's value, all different, so each one is read on chain by its value alone.
const REFUND: u128 = 5_000_000;
const MOVE: u128 = 1_100_000;
const RETURN: u128 = 1_200_000;
const SECOND_U: u128 = 1_300_000;
const SECOND_A: u128 = 1_400_000;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// `node <script> <args>`: its one stdout line as JSON.
fn node(script: &str, args: &[&str]) -> R<Value> {
    let out = Command::new("node").arg(repo().join(script)).args(args).output()?;
    if !out.status.success() {
        return Err(format!("{script} {args:?}: {}", String::from_utf8_lossy(&out.stderr)).into());
    }
    Ok(serde_json::from_str(String::from_utf8_lossy(&out.stdout).trim())?)
}

fn kinds(args: &[&str]) -> R<Value> {
    node("packages/exit/test/every-kind-cli.ts", args)
}

fn s(v: &Value, k: &str) -> R<String> {
    Ok(v[k].as_str().ok_or_else(|| format!("no {k} in {v}"))?.to_string())
}

fn u(v: &Value) -> u128 {
    v.as_str().and_then(|x| x.parse().ok()).unwrap_or_else(|| panic!("not a u128 string: {v}"))
}

fn b64(s: &Value) -> R<Vec<u8>> {
    Ok(serde_json::from_value::<Base64VecU8>(s.clone())?.0)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// "0.0123" NEAR as yocto.
fn yocto(near: &str) -> R<u128> {
    let (whole, frac) = near.split_once('.').unwrap_or((near, ""));
    if frac.len() > 24 {
        return Err(format!("{near}: more than 24 decimals").into());
    }
    Ok(whole.parse::<u128>()? * 10u128.pow(24) + format!("{frac:0<24}").parse::<u128>()?)
}

async fn storage_final(h: &Harness, id: &AccountId) -> R<Vec<(Vec<u8>, Vec<u8>)>> {
    let v = h.rpc("query", json!({"request_type": "view_state", "finality": "final", "account_id": id, "prefix_base64": ""})).await?;
    let values = v["result"]["values"].as_array().ok_or_else(|| format!("view_state {id} at final: {v}"))?;
    let mut out = values.iter().map(|e| Ok((b64(&e["key"])?, b64(&e["value"])?))).collect::<R<Vec<_>>>()?;
    out.sort();
    Ok(out)
}

/// The mainnet vault's code and every state record at its own id, by one state patch read back at final (as
/// mainnet_copy_payouts.rs patches it).
async fn patch_mainnet_vault(h: &Harness) -> R<AccountId> {
    let (copy, release): (Value, Value) = (serde_json::from_str(COPY)?, serde_json::from_str(RELEASE)?);
    let id: AccountId = copy["account_id"].as_str().ok_or("account_id")?.parse()?;
    assert_eq!(id.as_str(), release["account_id"], "the copy is the release's vault");
    let wasm = b64(&copy["code"]["base64"])?;
    let sha = hex(&near_sdk::env::sha256(&wasm));
    let code_hash = harness::code_hash(&wasm);
    assert_eq!((sha.as_str(), code_hash.as_str()), (release["wasm_sha256"].as_str().unwrap(), release["code_hash"].as_str().unwrap()), "the copied code is the mainnet release");
    assert_eq!(copy["access_keys"], json!([]), "the mainnet vault has no access key");
    let mut records: Vec<(Vec<u8>, Vec<u8>)> = copy["state"].as_array().ok_or("state")?.iter().map(|p| Ok((b64(&p[0])?, b64(&p[1])?))).collect::<R<_>>()?;
    records.sort();
    let (amount, usage) = (u(&copy["account"]["amount"]), copy["account"]["storage_usage"].as_u64().ok_or("storage_usage")?);
    let send = async || -> R<()> {
        let account = AccountDetailsPatch::default().balance(NearToken::from_yoctonear(amount)).storage_usage(usage);
        h.worker.patch(&id).account(account).code(&wasm).states(records.iter().map(|(k, v)| (k.as_slice(), v.as_slice()))).transact().await?;
        Ok(())
    };
    let landed = async || -> R<bool> {
        let a = h.rpc("query", json!({"request_type": "view_account", "finality": "final", "account_id": id})).await?["result"].clone();
        if a["code_hash"] != json!(code_hash) || a["storage_usage"] != json!(usage) {
            return Ok(false);
        }
        Ok(storage_final(h, &id).await? == records)
    };
    h.patch_landed(&format!("the mainnet vault's copy at {id}"), send, landed).await?;
    assert!(h.access_keys(&id, "final").await?.is_empty(), "the copy has no access key");
    println!("copy: {id} at mainnet block {}, code hash {code_hash}, {} records read back at final, access keys []", copy["block"]["height"], records.len());
    Ok(id)
}

/// A deposit as a user makes one: the prepay, then the token's transfer to the vault on `p`.
async fn deposit(h: &Harness, by: &Account, p: &str, value: u128) -> R<()> {
    let prepay = NearToken::from_yoctonear(PREPAY_BYTES * YOCTO_PER_BYTE);
    let _ = h.call(by, &h.vault, "storage_prepay", json!({"precommitment": p}), prepay, Gas::from_tgas(30)).await?;
    let msg = format!(r#"{{"precommitment":"{p}","depositor":"{}"}}"#, by.id());
    let o = h.call(by, &h.token, "ft_transfer_call", json!({"receiver_id": h.vault, "amount": value.to_string(), "msg": msg}), NearToken::from_yoctonear(1), Gas::from_tgas(180)).await?;
    let _ = o.calls_exactly(&h.vault, "ft_on_transfer", 1)?;
    Ok(())
}

async fn spends(h: &Harness) -> R<Vec<Value>> {
    Ok(h.view(&h.vault, "spends", json!({"from": 0, "limit": 1000})).await?.as_array().ok_or("spends")?.clone())
}

#[tokio::test]
async fn the_words_alone_bring_every_kind_home() -> R<()> {
    let copy: Value = serde_json::from_str(COPY)?;
    let mut h = Harness::start().await?;
    h.deploy_usdc().await?;
    h.vault = patch_mainnet_vault(&h).await?;
    let page = json!({"from": 0, "limit": 1000});
    for (view, args) in [("totals", json!({})), ("state_tree", json!({})), ("label_tree", json!({})), ("leaves", page.clone()), ("labels", page.clone()), ("deposits", page.clone()), ("spends", page.clone())] {
        assert_eq!(h.view(&h.vault, view, args).await?, copy["views"][view], "{view}() in the sandbox vs mainnet");
    }
    let _ = h.storage_deposit(&h.root, &h.vault).await?;
    let held = u(&copy["usdc"]["ft_balance_of_vault"]);
    h.mint(&h.vault.clone(), held).await?;
    assert_eq!(h.token_balance(&h.vault).await?, held, "the vault's USDC is mainnet's");
    // intents.near (the pinned wasm), as on mainnet: A's close reads that nothing of any kind sits under A there
    let _ = h.deploy_intents().await?;
    h.i1().await?;
    let ids = node("packages/exit/test/exit-cli.ts", &["--ids"])?;
    assert_eq!((ids["vault"].as_str(), ids["token"].as_str()), (Some(h.vault.as_str()), Some(h.token.as_str())), "the release's vault and token");
    println!("the mainnet vault's copy answers as mainnet; USDC {} holds {held} for it", h.token);

    // the seed: every kind, by the vault's own paths
    let rpc = h.worker.rpc_addr();
    let scope = s(&h.view(&h.vault, "config", json!({})).await?, "scope")?;
    let d = kinds(&["--deposit", &scope])?;
    let user = h.account("u", 50).await?;
    h.mint(user.id(), REFUND + MOVE + RETURN + SECOND_U + SECOND_A).await?;
    deposit(&h, &user, &s(&d, "deposit")?, REFUND).await?;
    deposit(&h, &user, &s(&d, "second_u")?, SECOND_U).await?;
    // 1. the bounced payout: refund_pending, the words' spend (l, 0)
    let relayer = h.account("relayer", 50).await?;
    let bounce = h.account("bounce", 1).await?;
    let b = kinds(&["--bounce", &rpc, bounce.id().as_str()])?;
    let label = s(&b, "label")?;
    assert_eq!(u(&b["value"]), REFUND, "the bounce withdraws deposit note (scope, 0) whole");
    let attach: u128 = s(&b, "attach")?.parse()?;
    let o = h.call_outcome(&relayer, &h.vault, "withdraw", b["args"].clone(), NearToken::from_yoctonear(attach), Gas::from_tgas(155)).await?;
    let _ = o.calls_exactly(&h.vault, "withdraw", 1)?;
    let _ = o.calls_exactly(&h.vault, "on_payout", 1)?;
    let row = spends(&h).await?.into_iter().last().ok_or("no spend")?;
    assert_eq!((row["status"].as_str(), row["recipient"].as_str(), u(&row["refund_value"])), (Some("refund_pending"), Some(bounce.id().as_str()), REFUND), "the bounced spend: {row}");
    assert_eq!(h.token_balance(bounce.id()).await?, 0, "the bounced payout reached no one");
    // 2-4. what the arm of spend (l, 0) brings back
    let a = kinds(&["--arm", &label])?;
    deposit(&h, &user, &s(&a, "move")?, MOVE).await?;
    deposit(&h, &user, &s(&a, "return")?, RETURN).await?;
    deposit(&h, &user, &s(&a, "second_a")?, SECOND_A).await?;
    let ours = REFUND + MOVE + RETURN + SECOND_U + SECOND_A;
    assert_eq!(h.token_balance(&h.vault).await?, held + ours, "the vault holds mainnet's USDC and the five kinds");
    h.i1().await?;
    let x = h.account("x", 1).await?;
    let funder = h.account("funder", 50).await?;
    h.wait_final(x.id()).await?;
    println!("seeded on label {label}: refund_pending {REFUND}, move {MOVE}, return {RETURN} (sol), U second {SECOND_U}, A second {SECOND_A}; X = {}", x.id());

    // the command, on the sandbox's RPCs only: the typed account and the words on stdin, as a user types them
    let g = h.rpc("EXPERIMENTAL_genesis_config", json!({})).await?;
    let height = async || -> R<u64> { h.rpc("block", json!({"finality": "final"})).await?["result"]["header"]["height"].as_u64().ok_or_else(|| "block: no height".into()) };
    let h0 = height().await?;
    println!("sandbox: transaction_validity_period {} blocks, final height {h0}", g["result"]["transaction_validity_period"]);
    let mut child = Command::new("node").arg(repo().join("packages/exit/test/exit-cli.ts")).arg(&rpc).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn()?;
    child.stdin.take().ok_or("no stdin")?.write_all(format!("{}\n{WORDS}\n", x.id()).as_bytes())?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let stderr = child.stderr.take().ok_or("no stderr")?;
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let mut arms: Vec<AccountId> = Vec::new();
    let mut said = Vec::new();
    let started = std::time::Instant::now();
    loop {
        match rx.recv_timeout(std::time::Duration::from_secs(1)) {
            Ok(line) => {
                println!("exit: {line}");
                // "near: Send <amount> NEAR to <A> to pay the fees (...)": that A funded with exactly that, from another account
                if let Some(rest) = line.strip_prefix("near: Send ") {
                    let mut w = rest.split(' ');
                    let (amount, unit, _to, id) = (w.next().ok_or("amount")?, w.next().ok_or("unit")?, w.next(), w.next().ok_or("A")?);
                    assert_eq!(unit, "NEAR");
                    let id: AccountId = id.parse()?;
                    let r = funder.transfer_near(&id, NearToken::from_yoctonear(yocto(amount)?)).await?;
                    assert!(r.is_success(), "the transfer to A {id}");
                    if !arms.contains(&id) {
                        arms.push(id);
                    }
                }
                said.push(line);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(_) if started.elapsed().as_secs() > 1800 => return Err("the command ran over 30 min".into()),
            Err(_) => {}
        }
    }
    let status = child.wait()?;
    println!("the command ran {} s over {} blocks, exit code {:?}", started.elapsed().as_secs(), height().await? - h0, status.code());
    // every tx the command named ("<step> tx <hash> from <signer>"), as the chain holds it
    for l in &said {
        let Some(rest) = l.strip_prefix("near: ") else { continue };
        let w: Vec<&str> = rest.split(' ').collect();
        if w.len() == 5 && w[1] == "tx" && w[3] == "from" {
            let t = h.rpc("tx", json!({"tx_hash": w[2], "sender_account_id": w[4], "wait_until": "NONE"})).await?;
            let r = &t["result"];
            let fails: Vec<String> = std::iter::once(&r["status"]).chain(r["receipts_outcome"].as_array().into_iter().flatten().map(|o| &o["outcome"]["status"])).filter(|x| x.get("Failure").is_some()).map(|x| x.to_string().chars().take(300).collect()).collect();
            println!("chain: {} {}: {} {}", w[0], w[2], r["final_execution_status"].as_str().unwrap_or("no result"), if r.is_null() { t["error"].to_string().chars().take(300).collect::<String>() } else { format!("{fails:?}") });
        }
    }

    // read on chain, never from the command's word: each kind's value a settled spend to X
    let rows = spends(&h).await?;
    let to_x: Vec<&Value> = rows.iter().filter(|r| r["recipient"].as_str() == Some(x.id().as_str())).collect();
    let mut missing = Vec::new();
    for (kind, value) in [("pending refund", REFUND), ("move note", MOVE), ("return note", RETURN), ("U second arrival", SECOND_U), ("A second arrival", SECOND_A)] {
        let paid = to_x.iter().find(|r| u(&r["withdrawn"]) == value);
        match paid {
            Some(r) => {
                assert_eq!((r["status"].as_str(), u(&r["refund_value"]), u(&r["fee"])), (Some("settled"), 0, 0), "{kind}: {r}");
                println!("{kind}: {value} withdrawn to X, spends row {} settled", r["index"]);
            }
            None => missing.push(format!("{kind} ({value})")),
        }
    }
    let got_x = h.token_balance(x.id()).await?;
    let left = h.token_balance(&h.vault).await?;
    println!("x.usdc: {got_x} (want {ours}); the vault: {left} (mainnet's {held})");
    assert!(missing.is_empty(), "never withdrawn to X: {missing:?}; the command said: {said:#?}");
    assert_eq!(got_x, ours, "X holds every kind's value");
    assert_eq!(left, held, "the vault holds mainnet's USDC and none of ours");
    assert_eq!(status.code(), Some(0), "the command's exit code; it said: {said:#?}");
    assert!(said.iter().any(|l| l.starts_with(&format!("near: done: sent {ours}, left 0"))), "the command's own line: {said:#?}");
    let bounced = rows.iter().find(|r| r["recipient"].as_str() == Some(bounce.id().as_str())).ok_or("no bounced spend")?;
    assert_eq!((bounced["status"].as_str(), bounced["reserve"].as_str(), u(&bounced["refund_value"])), (Some("settled"), Some("0"), REFUND), "the bounced spend, settled into its refund note: {bounced}");
    for a in &arms {
        assert!(h.account_view(a, "final").await.is_err(), "A {a} is deleted");
    }
    for r in rows.iter().filter(|r| r["payer"].as_str() != Some(relayer.id().as_str()) && !copy["views"]["spends"].as_array().unwrap().contains(r)) {
        assert_eq!((r["status"].as_str(), r["reserve"].as_str()), (Some("settled"), Some("0")), "an exit spend: {r}");
    }
    h.i1().await?;
    println!("the words alone: all five kinds at X ({ours}), the vault back at mainnet's {held}, {} A accounts deleted", arms.len());
    Ok(())
}
