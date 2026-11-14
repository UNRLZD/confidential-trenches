// SPDX-License-Identifier: Apache-2.0
//! Card exit-with-only-the-words (Blindfill v2 lite paper §5; vault paper 2.12): the exit command brings a note home
//! with only the 12 words, in near-sandbox 2.13.4 with the mainnet build of the vault at the release's own id
//! (vault.confidential.unrlzd.near, put there by a state patch with its code and no key: the sandbox's registrar cannot
//! create a .near name) on the mock token at TOKEN, with intents.near on its pinned wasm. Runs only with `--features sandbox`, through tests/harness/run.sh
//! (`contracts/vault/tests/harness/run.sh --test exit_words`); a plain `cargo test` builds this file empty.
//!
//! A depositor deposits one note of the published all-zero vector's words (packages/wallet/test/vectors/a8.json) by
//! the vault's own path: `storage_prepay` on the note's precommitment, then `ft_transfer_call` with the kit's message.
//! Then the command runs (`node packages/exit/test/exit-cli.ts <sandbox rpc>`: src/cli.ts runCli and the NEAR chain
//! src/near-out.ts, its two RPCs named as the mainnet release pair, both reading this sandbox), given on stdin the typed
//! account X and the words, as a user types them. It scans, finds the note, and says the one-use account A to fund and
//! the amount; this test sends exactly that amount to A from another account (A is never funded before it asks). Then
//! the command proves on the setup files (fetched and checked against the kit's pins), sends A's withdraw, settles,
//! and deletes A to X. Read on chain after, never from the command's word: X holds the note's whole value on the token,
//! the vault holds none, the spend reads settled with reserve 0, and A no longer exists.
//! `VT_EXIT_WORDS_PLANT=x` expects one base unit more at X, so the run must fail there.
#![cfg(feature = "sandbox")]

mod harness;

use harness::{Harness, R, YOCTO_PER_BYTE};
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::types::{AccountDetailsPatch, Gas, NearToken};
use near_workspaces::AccountId;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

const RELEASE_VAULT: &str = "vault.confidential.unrlzd.near";
const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
/// The kit's prepay whenever a tree may grow (2.10 (h)).
const PREPAY_BYTES: u128 = 904;
const VALUE: u128 = 3_000_000;

fn script() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/exit/test/exit-cli.ts")
}

/// `node exit-cli.ts <args>`: its one stdout line as JSON.
fn helper(args: &[&str]) -> R<Value> {
    let out = Command::new("node").arg(script()).args(args).output()?;
    if !out.status.success() {
        return Err(format!("exit-cli {args:?}: {}", String::from_utf8_lossy(&out.stderr)).into());
    }
    Ok(serde_json::from_str(String::from_utf8_lossy(&out.stdout).trim())?)
}

/// "0.0123" NEAR as yocto.
fn yocto(near: &str) -> R<u128> {
    let (whole, frac) = near.split_once('.').unwrap_or((near, ""));
    if frac.len() > 24 {
        return Err(format!("{near}: more than 24 decimals").into());
    }
    Ok(whole.parse::<u128>()? * 10u128.pow(24) + format!("{frac:0<24}").parse::<u128>()?)
}

#[tokio::test]
async fn the_words_alone_bring_the_note_home() -> R<()> {
    let mut h = Harness::start().await?;
    // the vault's code at the release's id, no key, no init (its scope is computed from its own id in every call)
    h.vault = RELEASE_VAULT.parse()?;
    let usage = h.vault_wasm.len() as u64 + 100;
    let balance = NearToken::from_near(10);
    let send = async || -> R<()> {
        h.worker.patch(&h.vault).account(AccountDetailsPatch::default().balance(balance).storage_usage(usage)).code(&h.vault_wasm).transact().await?;
        Ok(())
    };
    let landed = async || -> R<bool> { Ok(h.access_keys(&h.vault, "final").await.map(|k| k.is_empty()).unwrap_or(false) && h.view(&h.vault, "config", json!({})).await.is_ok()) };
    h.patch_landed("the vault at the release's id", send, landed).await?;
    assert!(h.access_keys(&h.vault, "final").await?.is_empty(), "the vault has no key");
    h.deploy_mock_token().await?;
    // intents.near (the pinned wasm), as on mainnet: A's close reads that nothing of any kind sits under A there
    let _ = h.deploy_intents().await?;
    let _ = h.storage_deposit(&h.root, &h.vault).await?;
    let ids = helper(&["--ids"])?;
    assert_eq!((ids["vault"].as_str(), ids["token"].as_str()), (Some(RELEASE_VAULT), Some(h.token.as_str())), "the release's vault and token");

    // one note of the words, deposited by the vault's own path
    let config = h.view(&h.vault, "config", json!({})).await?;
    let scope = config["scope"].as_str().ok_or("config: no scope")?.to_string();
    let p = helper(&["--precommitment", &scope])?["precommitment"].as_str().ok_or("no precommitment")?.to_string();
    let u = h.account("u", 50).await?;
    h.mint(u.id(), VALUE).await?;
    let prepay = NearToken::from_yoctonear(PREPAY_BYTES * YOCTO_PER_BYTE);
    let _ = h.call(&u, &h.vault, "storage_prepay", json!({"precommitment": p}), prepay, Gas::from_tgas(30)).await?;
    let msg = format!(r#"{{"precommitment":"{p}","depositor":"{}"}}"#, u.id());
    let o = h.call(&u, &h.token, "ft_transfer_call", json!({"receiver_id": h.vault, "amount": VALUE.to_string(), "msg": msg}), NearToken::from_yoctonear(1), Gas::from_tgas(180)).await?;
    let _ = o.calls_exactly(&h.vault, "ft_on_transfer", 1)?;
    assert_eq!(h.token_balance(&h.vault).await?, VALUE);
    let x = h.account("x", 1).await?;
    let funder = h.account("funder", 50).await?;
    h.wait_final(x.id()).await?;
    println!("deposited {VALUE} on the words' note (scope {scope}); X = {}", x.id());

    // the command: the typed account and the words on stdin, as a user types them
    let rpc = h.worker.rpc_addr();
    let mut child = Command::new("node").arg(script()).arg(&rpc).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn()?;
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
    let mut a: Option<AccountId> = None;
    let mut said = Vec::new();
    let started = std::time::Instant::now();
    loop {
        match rx.recv_timeout(std::time::Duration::from_secs(1)) {
            Ok(line) => {
                println!("exit: {line}");
                // "near: Send <amount> NEAR to <A> to pay the fees (...)": A funded with exactly that, from another account
                if let Some(rest) = line.strip_prefix("near: Send ") {
                    let mut w = rest.split(' ');
                    let (amount, unit, _to, id) = (w.next().ok_or("amount")?, w.next().ok_or("unit")?, w.next(), w.next().ok_or("A")?);
                    assert_eq!(unit, "NEAR");
                    let id: AccountId = id.parse()?;
                    assert!(a.is_none(), "one A for one note");
                    let r = funder.transfer_near(&id, NearToken::from_yoctonear(yocto(amount)?)).await?;
                    assert!(r.is_success(), "the transfer to A");
                    a = Some(id);
                }
                said.push(line);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(_) if started.elapsed().as_secs() > 900 => return Err("the command ran over 15 min".into()),
            Err(_) => {}
        }
    }
    let status = child.wait()?;
    assert_eq!(status.code(), Some(0), "the command's exit code; it said: {said:#?}");
    let a = a.ok_or("the command never asked for A's fees")?;

    // read on chain, never from the command's word
    let want_x = if std::env::var("VT_EXIT_WORDS_PLANT").ok().as_deref() == Some("x") { VALUE + 1 } else { VALUE };
    let got_x = h.token_balance(x.id()).await?;
    println!("x.usdc: {got_x} (want {want_x})");
    assert_eq!(got_x, want_x, "X holds the note's whole value");
    assert_eq!(h.token_balance(&h.vault).await?, 0, "the vault holds none of it");
    let spends = h.view(&h.vault, "spends", json!({"from": 0, "limit": 10})).await?;
    let rows = spends.as_array().ok_or("spends: not a list")?;
    assert_eq!(rows.len(), 1, "one spend: {spends}");
    assert_eq!(rows[0]["status"], json!("settled"), "the spend: {}", rows[0]);
    assert_eq!(rows[0]["reserve"], json!("0"), "the spend's reserve: {}", rows[0]);
    assert!(h.account_view(&a, "final").await.is_err(), "A {a} is deleted");
    assert!(said.iter().any(|l| l == &format!("near: done: sent {VALUE}, left 0") || l.starts_with(&format!("near: done: sent {VALUE}, left 0,"))), "the command's own line: {said:#?}");
    println!("the words alone: {VALUE} at X, the vault at 0, the spend settled, A deleted");
    Ok(())
}
