// SPDX-License-Identifier: Apache-2.0
//! Card exit-ids-out (SB-04's WM-10 rows; vault paper 2.12 step 5 and "Nothing into the vault"): the exit tool's moves
//! out of the one-time ids and arming accounts, in near-sandbox 2.13.4 on the real USDC wasm at TOKEN and intents.near at
//! DF (both pinned in tests/fixtures/real-wasm.json). Runs only with `--features sandbox`, through tests/harness/run.sh
//! (`contracts/vault/tests/harness/run.sh --test exit_out`); a plain `cargo test` builds this file empty.
//!
//! The tool runs through its CLI (`node packages/exit/test/out-cli.ts`, one process per run): exitRecipient,
//! exitHoldings, the wallet's read per leg, exitBuildMove, and the signed bytes sent by send_tx (or, with send false,
//! handed back for the test to send later). Its two RPCs are named as the mainnet release pair and both read this
//! sandbox. The accounts are the published all-zero vector's (packages/wallet/test/vectors/a8.json). Every outcome is
//! read on chain through the harness's RPC, never taken from the CLI's answer alone. X is the typed NEAR account.
//! - a. USDC in U on the token reaches X by U's own plain ft_transfer (X's registration in the same transaction), one
//!   base unit kept: ft_balance_of(U) is 1 and X has the rest. U's NEAR comes from a plain Transfer from X. The tool
//!   refuses the release vault and intents.near as the typed account (e), and no built call names either.
//! - b. The same move, signed before USDC halts and sent while halted, fails whole: exitHoldings reads U halted (never
//!   0), and after the unhalt U holds all its USDC and X is still unregistered.
//! - c. Money under V inside intents.near reaches X by V's own ft_withdraw, X registered first by V's own register leg.
//!   An ft_withdraw signed before the halt and sent while halted is refunded in full to V by intents.near
//!   (mt_balance_of(V) unchanged, X gets nothing); after the unhalt the same leg lands, V keeping one base unit.
//! - d. A, with no relayer: its USDC on the token reaches X by A's own ft_transfer, all of it, A's own NEAR paying the
//!   gas; signed before the halt and sent while halted it fails whole; what A holds inside intents.near goes by A's own
//!   ft_withdraw, all of it.
//!
//! Every transaction's gas is printed (Tgas burnt per receipt), and each case ends with the gas table. Every check is
//! named `<case>.<what>`; `VT_EXIT_OUT_PLANT=<name>` plants a wrong expectation in that one numeric check (one base unit
//! less: `a.u.kept` then expects U to keep 0), so the run must fail at it.
#![cfg(feature = "sandbox")]

mod harness;

use harness::{Harness, Outcome, INTENTS, ONE_YOCTO, R, TGAS, USDC_HALTED};
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// What U and A hold on the token, and V and A inside intents.near, in USDC base units.
const ON_TOKEN: u128 = 2_500_000;
const INSIDE: u128 = 3_000_000;
/// The release's vault on mainnet (packages/exit/src/rpc.ts EXIT_NETWORKS.mainnet.vault).
const RELEASE_VAULT: &str = "vault.confidential.unrlzd.near";
/// The NEAR each moving account gets for its gas (and the registration's 0.00125 N).
const GAS_NEAR_MILLI: u128 = 200;

/// `<case>.<what>`: got must equal want; the planted check expects one less.
fn check(name: &str, got: u128, want: u128) -> R<()> {
    let planted = std::env::var("VT_EXIT_OUT_PLANT").ok().as_deref() == Some(name);
    let want = if planted { want.wrapping_sub(1) } else { want };
    println!("{name}: {got} (want {want}{})", if planted { ", planted" } else { "" });
    if got != want {
        return Err(format!("{name}: {got}, want {want}{}", if planted { " (planted)" } else { "" }).into());
    }
    Ok(())
}

fn ensure(name: &str, ok: bool, detail: impl std::fmt::Display) -> R<()> {
    println!("{name}: {}", if ok { "ok" } else { "FAILED" });
    if !ok {
        return Err(format!("{name}: {detail}").into());
    }
    Ok(())
}

/// `node packages/exit/test/out-cli.ts` with `input` on stdin; its one stdout line as JSON.
async fn exit_cli(input: Value) -> R<Value> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/exit/test/out-cli.ts");
    if !script.is_file() {
        return Err(format!("{}: not found (the exit tool's CLI)", script.display()).into());
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

/// The sandbox with the real USDC and intents.near (intents.near registered on the token) and X, the typed account.
async fn world() -> R<(Harness, Account)> {
    let mut h = Harness::start().await?;
    h.deploy_usdc().await?;
    let _admin = h.deploy_intents().await?;
    let intents: AccountId = INTENTS.parse()?;
    let _ = h.storage_deposit(&h.root, &intents).await?;
    let x = h.account("x", 50).await?;
    Ok((h, x))
}

fn rpc_of(h: &Harness) -> String {
    h.worker.rpc_addr()
}

/// The CLI run for `accounts` with `legs`, to `to`.
async fn run(h: &Harness, accounts: &Value, to: &str, legs: Value, send: bool) -> R<Value> {
    let mut input = json!({"rpc": rpc_of(h), "accounts": accounts, "to": to, "legs": legs});
    if !send {
        input["send"] = json!(false);
    }
    let out = exit_cli(input).await?;
    if out["recipient"]["ok"] != json!(true) {
        return Err(format!("exitRecipient refused {to}: {out}").into());
    }
    Ok(out)
}

/// The account ids of `accounts` (the CLI with no `to`: nothing read).
async fn ids(accounts: &Value) -> R<Vec<AccountId>> {
    let out = exit_cli(json!({"accounts": accounts})).await?;
    out["ids"].as_array().ok_or_else(|| format!("no ids: {out}"))?.iter().map(|v| Ok(v.as_str().ok_or("id")?.parse()?)).collect()
}

/// A plain Transfer of GAS_NEAR_MILLI from `from` to `to` (creating the implicit account `to`), read at final.
async fn fund(h: &Harness, from: &Account, to: &AccountId, what: &str) -> R<()> {
    let r = from.transfer_near(to, NearToken::from_millinear(GAS_NEAR_MILLI)).await?;
    let hash = r.outcome().transaction_hash.to_string();
    let o = h.tx_outcome(from.id(), &hash).await?;
    o.expect_all_ok(what)?;
    print_tx(what, &o);
    h.wait_final(to).await
}

/// `amount` of USDC put under `owner` inside intents.near: minted to a funder that sends it in by ft_transfer_call
/// with `owner` as the msg (intents.near's deposit to another account).
async fn put_inside(h: &Harness, owner: &AccountId, amount: u128) -> R<()> {
    let f = h.account(&format!("funder{}", &owner.as_str()[..6]), 10).await?;
    h.mint(f.id(), amount).await?;
    let intents: AccountId = INTENTS.parse()?;
    let args = json!({"receiver_id": intents, "amount": amount.to_string(), "msg": owner});
    let _ = h.call(&f, &h.token, "ft_transfer_call", args, ONE_YOCTO, Gas::from_tgas(100)).await?;
    Ok(())
}

/// The gas of one transaction: every receipt, and the receipts' sum.
fn print_tx(what: &str, o: &Outcome) {
    let total: u64 = o.receipts.iter().map(|r| r.gas_burnt).sum();
    println!("  {what}: tx {} ({}), receipts {:.3} Tgas burnt", o.tx_hash, if o.all_ok() { "ok" } else { "FAILED" }, total as f64 / TGAS);
    for r in &o.receipts {
        println!("    {}", r.line());
    }
}

/// Each built move of a CLI run read back on chain by its signer: its outcome, printed.
async fn landed(h: &Harness, out: &Value, ids: &[AccountId], what: &str) -> R<Vec<Outcome>> {
    let mut v = vec![];
    for b in out["built"].as_array().ok_or_else(|| format!("no built: {out}"))? {
        let k = b["account"].as_u64().ok_or("account")? as usize;
        let hash = b["hash"].as_str().ok_or("hash")?;
        let o = h.tx_outcome(&ids[k], hash).await?;
        print_tx(&format!("{what} {} leg {}", &ids[k].as_str()[..8], b["leg"]), &o);
        v.push(o);
    }
    Ok(v)
}

/// The built moves' calls never name the vault or intents.near as an account (e), and each goes to the leg's receiver.
fn no_vault_receiver(out: &Value, case: &str) -> R<()> {
    for b in out["built"].as_array().ok_or("built")? {
        let leg = b["leg"].as_str().unwrap_or_default();
        let want = if leg == "intents" { INTENTS } else { harness::TOKEN };
        ensure(&format!("{case}.{leg}.receiver"), b["receiver"] == json!(want), format!("receiver {}, want {want}", b["receiver"]))?;
        for c in b["calls"].as_array().ok_or("calls")? {
            for f in ["receiver_id", "account_id"] {
                let a = c["args"][f].as_str().unwrap_or_default();
                ensure(&format!("{case}.{leg}.{}.{f}", c["method"].as_str().unwrap_or_default()), a != RELEASE_VAULT && a != INTENTS, format!("{c} names {a}"))?;
            }
        }
    }
    Ok(())
}

async fn usdc(h: &Harness, id: &AccountId) -> R<u128> {
    h.token_balance(id).await
}

async fn registered(h: &Harness, id: &AccountId) -> R<bool> {
    Ok(!h.view(&h.token, "storage_balance_of", json!({"account_id": id})).await?.is_null())
}

fn holding<'a>(out: &'a Value, k: usize) -> &'a Value {
    &out["holdings"][k]
}

/// The one built move of a run with send false: its hash and signed bytes, sent now by send_tx, read back on chain.
async fn send_later(h: &Harness, signed_out: &Value, signer: &AccountId, what: &str) -> R<Outcome> {
    let b = &signed_out["built"][0];
    let signed = b["signed"].as_str().ok_or_else(|| format!("no signed bytes: {signed_out}"))?;
    let sent = h.rpc("send_tx", json!({"signed_tx_base64": signed, "wait_until": "FINAL"})).await?;
    if sent.get("error").is_some() {
        return Err(format!("send_tx {what}: {sent}").into());
    }
    let o = h.tx_outcome(signer, b["hash"].as_str().ok_or("hash")?).await?;
    print_tx(what, &o);
    Ok(o)
}

fn amount(out: &Value, n: usize) -> R<u128> {
    Ok(out["built"][n]["amount"].as_str().ok_or_else(|| format!("built[{n}].amount: {out}"))?.parse()?)
}

#[tokio::test]
async fn a_u_token_to_x_one_unit_kept() -> R<()> {
    let (h, x) = world().await?;
    let accts = json!([{"kind": "U", "s": "0", "i": 0}]);
    let u = ids(&accts).await?;
    println!("a. U {} (the a8 vector's U_{{0,0}}), X {}", u[0], x.id());
    fund(&h, &x, &u[0], "a. U's gas: a plain Transfer from X").await?;
    h.mint(&u[0], ON_TOKEN).await?;

    // e: the typed account is never the release vault or intents.near
    for (to, code) in [(RELEASE_VAULT, "vault"), (INTENTS, "intents")] {
        let out = exit_cli(json!({"rpc": rpc_of(&h), "accounts": accts, "to": to, "legs": [["token"]]})).await?;
        ensure(&format!("e.refused.{code}"), out["recipient"] == json!({"ok": false, "code": code}) && out.get("built").is_none(), &out)?;
    }

    let out = run(&h, &accts, x.id().as_str(), json!([["token"]]), true).await?;
    check("a.holdings.token", holding(&out, 0)["token"]["amount"].as_str().unwrap_or_default().parse()?, ON_TOKEN)?;
    ensure("a.holdings.state", holding(&out, 0)["token"]["state"] == json!("held"), &out)?;
    check("a.holdings.intents", holding(&out, 0)["intents"].as_str().unwrap_or_default().parse()?, 0)?;
    let methods: Vec<&str> = out["built"][0]["calls"].as_array().ok_or("calls")?.iter().filter_map(|c| c["method"].as_str()).collect();
    ensure("a.calls", methods == ["storage_deposit", "ft_transfer"], format!("{methods:?}"))?;
    no_vault_receiver(&out, "e.a")?;
    let o = landed(&h, &out, &u, "a. U's move").await?;
    o[0].expect_all_ok("a. U's move")?;
    ensure("a.signer", o[0].receipts.first().map(|r| r.predecessor.as_str()) == Some(u[0].as_str()), "U signed it")?;
    check("a.built.amount", amount(&out, 0)?, ON_TOKEN - 1)?;
    check("a.u.kept", usdc(&h, &u[0]).await?, 1)?;
    check("a.x.got", usdc(&h, x.id()).await?, ON_TOKEN - 1)?;
    ensure("a.x.registered", registered(&h, x.id()).await?, "X has no storage on the token")?;
    println!("{}", h.gas_table());
    Ok(())
}

#[tokio::test]
async fn b_u_halted_fails_whole() -> R<()> {
    let (h, x) = world().await?;
    let accts = json!([{"kind": "U", "s": "0", "i": 1}]);
    let u = ids(&accts).await?;
    println!("b. U {} (the a8 vector's U_{{0,1}}), X {}", u[0], x.id());
    fund(&h, &x, &u[0], "b. U's gas: a plain Transfer from X").await?;
    h.mint(&u[0], ON_TOKEN).await?;

    // signed by the device before the halt, not sent
    let signed = run(&h, &accts, x.id().as_str(), json!([["token"]]), false).await?;
    check("b.built.amount", amount(&signed, 0)?, ON_TOKEN - 1)?;
    let _ = h.usdc_halt(true).await?;

    // while halted: U reads halted on both RPCs, never a zero
    let read = run(&h, &accts, x.id().as_str(), json!([[]]), true).await?;
    ensure("b.holdings.halted", holding(&read, 0)["token"] == json!({"state": "halted"}), &read)?;

    // sent while halted: the one receipt (storage_deposit + ft_transfer) fails whole
    let o = send_later(&h, &signed, &u[0], "b. U's move sent while halted").await?;
    ensure("b.failed", !o.all_ok(), "the move landed while USDC was halted")?;
    let f = o.calls_exactly(&h.token, "ft_transfer", 1)?[0];
    ensure("b.halt", f.failure().is_some_and(|e| e.contains(USDC_HALTED)), f.line())?;

    let _ = h.usdc_halt(false).await?;
    check("b.u.all", usdc(&h, &u[0]).await?, ON_TOKEN)?;
    check("b.x.none", usdc(&h, x.id()).await?, 0)?;
    ensure("b.x.unregistered", !registered(&h, x.id()).await?, "the registration rode in the failed receipt and stayed")?;
    println!("{}", h.gas_table());
    Ok(())
}

#[tokio::test]
async fn c_v_inside_intents_to_x() -> R<()> {
    let (h, x) = world().await?;
    let accts = json!([{"kind": "V", "l": "7", "j": 1}]);
    let v = ids(&accts).await?;
    println!("c. V {} (refundId(seed, 7, 1)), X {}", v[0], x.id());
    fund(&h, &x, &v[0], "c. V's gas: a plain Transfer from X").await?;
    put_inside(&h, &v[0], INSIDE).await?;
    check("c.v.inside", h.intents_held(&v[0]).await?, INSIDE)?;

    // X registered first, by V's own register leg
    let reg = run(&h, &accts, x.id().as_str(), json!([["register"]]), true).await?;
    check("c.holdings.intents", holding(&reg, 0)["intents"].as_str().unwrap_or_default().parse()?, INSIDE)?;
    no_vault_receiver(&reg, "e.c")?;
    landed(&h, &reg, &v, "c. V's register").await?[0].expect_all_ok("c. V's register")?;
    ensure("c.x.registered", registered(&h, x.id()).await?, "X has no storage on the token")?;

    // V's ft_withdraw signed before the halt, sent while halted: intents.near refunds it in full to V
    let signed = run(&h, &accts, x.id().as_str(), json!([["intents"]]), false).await?;
    check("c.built.amount", amount(&signed, 0)?, INSIDE - 1)?;
    no_vault_receiver(&signed, "e.c")?;
    let _ = h.usdc_halt(true).await?;
    let read = run(&h, &accts, x.id().as_str(), json!([[]]), true).await?;
    ensure("c.holdings.halted", holding(&read, 0)["token"] == json!({"state": "halted"}), &read)?;
    check("c.holdings.halted.intents", holding(&read, 0)["intents"].as_str().unwrap_or_default().parse()?, INSIDE)?;
    let o = send_later(&h, &signed, &v[0], "c. V's ft_withdraw sent while halted").await?;
    let intents: AccountId = INTENTS.parse()?;
    let _ = o.calls_exactly(&intents, "ft_withdraw", 1)?;
    let t = o.calls_exactly(&h.token, "ft_transfer", 1)?[0];
    ensure("c.halt", t.failure().is_some_and(|e| e.contains(USDC_HALTED)), t.line())?;
    let _ = o.calls_exactly(&intents, "ft_resolve_withdraw", 1)?;
    check("c.v.refunded", h.intents_held(&v[0]).await?, INSIDE)?;
    let _ = h.usdc_halt(false).await?;
    check("c.x.none", usdc(&h, x.id()).await?, 0)?;

    // after the unhalt the same leg lands: X gets all but one base unit
    let out = run(&h, &accts, x.id().as_str(), json!([["intents"]]), true).await?;
    landed(&h, &out, &v, "c. V's ft_withdraw").await?[0].expect_all_ok("c. V's ft_withdraw")?;
    check("c.v.kept", h.intents_held(&v[0]).await?, 1)?;
    check("c.x.got", usdc(&h, x.id()).await?, INSIDE - 1)?;
    println!("{}", h.gas_table());
    Ok(())
}

#[tokio::test]
async fn d_a_no_relayer_moves_all() -> R<()> {
    let (h, x) = world().await?;
    let accts = json!([{"kind": "A", "l": "7", "j": 2}]);
    let a = ids(&accts).await?;
    println!("d. A {} (armAccount(seed, 7, 2)), X {}", a[0], x.id());
    // A's own NEAR (it held NEAR as an arming account): from root, not from X
    fund(&h, &h.root, &a[0], "d. A's own NEAR").await?;
    h.mint(&a[0], ON_TOKEN).await?;
    put_inside(&h, &a[0], INSIDE).await?;

    // signed before the halt, sent while halted: fails whole
    let signed = run(&h, &accts, x.id().as_str(), json!([["token"]]), false).await?;
    check("d.built.amount.halted", amount(&signed, 0)?, ON_TOKEN)?;
    let _ = h.usdc_halt(true).await?;
    let read = run(&h, &accts, x.id().as_str(), json!([[]]), true).await?;
    ensure("d.holdings.halted", holding(&read, 0)["token"] == json!({"state": "halted"}), &read)?;
    let o = send_later(&h, &signed, &a[0], "d. A's move sent while halted").await?;
    ensure("d.failed", !o.all_ok(), "the move landed while USDC was halted")?;
    let f = o.calls_exactly(&h.token, "ft_transfer", 1)?[0];
    ensure("d.halt", f.failure().is_some_and(|e| e.contains(USDC_HALTED)), f.line())?;
    let _ = h.usdc_halt(false).await?;
    check("d.a.all", usdc(&h, &a[0]).await?, ON_TOKEN)?;
    ensure("d.x.unregistered", !registered(&h, x.id()).await?, "the registration stayed from a failed receipt")?;

    // no relayer: A's own transactions, A's NEAR paying; all of it moves
    let near_before = h.near_balance(&a[0]).await?;
    let out = run(&h, &accts, x.id().as_str(), json!([["token", "intents"]]), true).await?;
    no_vault_receiver(&out, "e.d")?;
    let o = landed(&h, &out, &a, "d. A's move").await?;
    for (n, oc) in o.iter().enumerate() {
        oc.expect_all_ok(&format!("d. A's move {n}"))?;
        ensure(&format!("d.signer.{n}"), oc.receipts.first().map(|r| r.predecessor.as_str()) == Some(a[0].as_str()), "A signed it")?;
    }
    check("d.built.token", amount(&out, 0)?, ON_TOKEN)?;
    check("d.built.intents", amount(&out, 1)?, INSIDE)?;
    check("d.a.token", usdc(&h, &a[0]).await?, 0)?;
    check("d.a.inside", h.intents_held(&a[0]).await?, 0)?;
    check("d.x.got", usdc(&h, x.id()).await?, ON_TOKEN + INSIDE)?;
    let near_after = h.near_balance(&a[0]).await?;
    ensure("d.a.paid", near_after < near_before, format!("A's NEAR {near_before} -> {near_after}"))?;
    println!("d. A's NEAR paid: {} yocto (gas and X's registration)", near_before - near_after);
    println!("{}", h.gas_table());
    Ok(())
}
